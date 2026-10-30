/**
 * zk 的全部命令行交互都收在这里（lib 层，feature 只调函数、不拼参数）。
 *
 * 约定：
 *   · 永远带 `--notebook-dir <notebook> --no-input` —— 不依赖 cwd、不会弹交互；
 *   · 读笔记走 `zk list --format json`（zk 自己的解析结果，别去猜 frontmatter）；
 *   · 写笔记走 `zk new`（文件名、模板、索引都交给 zk），正文经 stdin 进 `{{content}}`；
 *   · 所有路径参数先过 absPathOf：绝不读写笔记本外面的文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { BIN_DIR } from '../config/paths.ts'
import type { Config } from '../config/store.ts'
import { ExecError, findOnPath, run } from './exec.ts'
import { parseFrontmatter, setFrontmatter } from './frontmatter.ts'
import { isMetaPath, META_NAMES } from './meta.ts'

export class ZkError extends Error {
  readonly hint: string | undefined
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ZkError'
    this.hint = hint
  }
}

export type ZkSource = 'config' | 'env' | 'path' | 'managed'

export interface ZkLocation {
  bin: string
  version: string
  source: ZkSource
}

export interface NoteRecord {
  title: string
  path: string
  absPath: string
  link: string
  tags: string[]
  created: string
  modified: string
  lead: string
  words: number
  /** zk 原样给出的 frontmatter（Z6）；没写 frontmatter 就是空对象 */
  metadata: Record<string, unknown>
  /** metadata.status；老笔记没有这个字段 → 空串 */
  status: string
  type: string
  authority: string
}

export interface SearchOptions {
  query?: string
  /** 只看这些路径（相对笔记本；包含其子孙） */
  paths?: string[]
  tags?: string[]
  since?: string
  until?: string
  limit?: number
  /** created-desc | created-asc | modified-desc | title-asc */
  sort?: string
  orphan?: boolean
  brokenLinks?: boolean
  /** 只要这些 status（在 JS 层过滤，Z6）；空 = 不过滤 */
  status?: string[]
  /** 只要这些 type（在 JS 层过滤，Z6）；空 = 不过滤 */
  type?: string[]
  /** true = 连归档目录一起查（复查旧结论 / 校验 superseded-by 时才用） */
  includeArchived?: boolean
}

const SORT_TERMS: Record<string, string> = {
  'created-desc': 'created-',
  'created-asc': 'created',
  'modified-desc': 'modified-',
  'title-asc': 'title',
}

/** ISO 时间 → 本地日期 YYYY-MM-DD（zk 给的是 UTC，别拿它当日历） */
export function localDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 标题查重用的归一化：压空白 + 小写（与 lint 的重名口径一致） */
function normalizeTitle(title: string): string {
  return String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 废弃原因最多这么长：frontmatter 是给人看的审计线，不是自由文本容器 */
const MAX_SUPERSEDE_REASON = 200

/** 一句话、单行；换行会弄坏 frontmatter，超长机械截断（不判断内容） */
function normalizeReason(input?: string): string | null {
  const one = String(input ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return null
  return one.length > MAX_SUPERSEDE_REASON ? one.slice(0, MAX_SUPERSEDE_REASON - 1) + '…' : one
}

export function managedBin(): string {
  return path.join(BIN_DIR, process.platform === 'win32' ? 'zk.exe' : 'zk')
}

export function hasNotebook(cfg: Config): boolean {
  try {
    return fs.existsSync(path.join(cfg.notebook, '.zk', 'config.toml'))
  } catch {
    return false
  }
}

/** `zk --version` → "0.15.7"；跑不起来 / 输出不对 → null */
export async function versionOf(bin: string): Promise<string | null> {
  try {
    const r = await run(bin, ['--version'], { timeoutMs: 10_000 })
    const m = r.stdout.match(/(\d+\.\d+\.\d+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

const located = new Map<string, Promise<ZkLocation | null>>()

/** 找 zk：显式路径 → $ZK_BIN → PATH → 插件托管目录（都不跑 --version 之外的探测） */
export function resolveZk(cfg: Config): Promise<ZkLocation | null> {
  const key = [cfg.zkPath, process.env.ZK_BIN ?? '', managedBin()].join('|')
  const hit = located.get(key)
  if (hit) return hit
  // 只缓存成功结果：装完 zk / 改完路径后，下一次调用必须立刻看得见（缓存 null 会让用户重启才生效）
  const probe = (async (): Promise<ZkLocation | null> => {
    const candidates: Array<{ bin: string; source: ZkSource }> = []
    if (cfg.zkPath) candidates.push({ bin: cfg.zkPath, source: 'config' })
    if (process.env.ZK_BIN) candidates.push({ bin: process.env.ZK_BIN, source: 'env' })
    const onPath = findOnPath('zk')
    if (onPath) candidates.push({ bin: onPath, source: 'path' })
    const managed = managedBin()
    if (fs.existsSync(managed)) candidates.push({ bin: managed, source: 'managed' })

    for (const c of candidates) {
      const version = await versionOf(c.bin)
      if (version) return { bin: c.bin, version, source: c.source }
    }
    return null
  })()
  located.set(key, probe)
  probe.then((loc) => { if (!loc) located.delete(key) }, () => { located.delete(key) })
  return probe
}

export async function requireZk(cfg: Config): Promise<ZkLocation> {
  const loc = await resolveZk(cfg)
  if (!loc) {
    throw new ZkError(
      '找不到 zk 可执行文件',
      'DSH 设置 → 知识库（zk）→「安装内置 zk」；或自己装一个（brew install zk / go install github.com/zk-org/zk@latest），再或者把路径填进设置页的「zk 路径」',
    )
  }
  return loc
}

function baseArgs(cfg: Config): string[] {
  return ['--notebook-dir', cfg.notebook, '--no-input']
}

/** stderr 里的一行 warning（`zk: warning: ...`），exit 0 时也会出现 */
const WARNING_LINE = /^zk: warning: /

/**
 * 跑一条 zk 命令，返回 stdout；非零退出 → ZkError（带 zk 自己最后几行 stderr）。
 *
 * `opts.warnings` 收 exit 0 时的 stderr warning：zk 解析不了 frontmatter 只在这里吭一声，
 * 不收的话那篇笔记就从索引里静默消失（能搜不到、也不进任何一个巡检桶）。
 */
export async function zk(
  cfg: Config,
  args: string[],
  opts: { signal?: AbortSignal; input?: string; timeoutMs?: number; warnings?: string[] } = {},
): Promise<string> {
  const loc = await requireZk(cfg)
  try {
    const r = await run(loc.bin, [...baseArgs(cfg), ...args], {
      input: opts.input,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 60_000,
    })
    if (opts.warnings) {
      for (const line of r.stderr.split('\n')) {
        const trimmed = line.trim()
        if (WARNING_LINE.test(trimmed)) opts.warnings.push(trimmed)
      }
    }
    return r.stdout
  } catch (err) {
    if (err instanceof ExecError) throw new ZkError(err.message)
    throw err
  }
}

export interface ZkParseError {
  /** 笔记本相对路径 */
  path: string
  /** zk 给的原因，例如 `yaml: line 2: did not find expected node content` */
  reason: string
}

/** `zk: warning: error parsing note content <absPath>: <reason>` */
const PARSE_WARNING = /^zk: warning: error parsing note content (.+?): (.+)$/

/**
 * 从收集到的 warning 里挑出 frontmatter 解析失败的笔记。
 *
 * 归档 / raw / inbox / meta 文件即使写坏也不影响检索口径（它们本来就不进索引查询），
 * 报出来只会把真问题淹掉 —— 所以按 `excludedNames` 同一套口径过滤。
 */
export function parseErrorWarnings(cfg: Config, warnings: string[]): ZkParseError[] {
  const excluded = excludedNames(cfg)
  const seen = new Set<string>()
  const out: ZkParseError[] = []
  for (const line of warnings) {
    const m = line.match(PARSE_WARNING)
    if (!m) continue
    const abs = path.resolve(cfg.notebook, m[1])
    if (excluded.some((p) => abs === p || abs.startsWith(p + path.sep))) continue
    const rel = path.relative(cfg.notebook, abs).split(path.sep).join('/')
    if (seen.has(rel)) continue
    seen.add(rel)
    out.push({ path: rel, reason: m[2].trim() })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function toRecord(raw: Record<string, unknown>, cfg: Config): NoteRecord {
  const rawTags = Array.isArray(raw.tags) ? raw.tags : []
  const absPath = String(raw.absPath ?? '')
  // ⚠️ zk 在 cwd 之外用 --notebook-dir 时，path 会变成相对 cwd 的 `../../…`；
  // absPath 永远是对的 → 一律用 absPath 重新算相对笔记本的路径。
  const relPath = absPath
    ? path.relative(cfg.notebook, absPath).split(path.sep).join('/')
    : String(raw.path ?? '').split(path.sep).join('/')
  const metadata = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? raw.metadata
    : {}) as Record<string, unknown>
  const meta = (key: string): string => {
    const v = metadata[key]
    return v === undefined || v === null ? '' : String(v)
  }
  return {
    title: String(raw.title ?? ''),
    path: relPath,
    absPath,
    link: String(raw.link ?? ''),
    tags: rawTags.map((t) => String(t)),
    created: String(raw.created ?? ''),
    modified: String(raw.modified ?? ''),
    lead: String(raw.lead ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    words: Number(raw.wordCount ?? 0),
    metadata,
    status: meta('status'),
    type: meta('type'),
    authority: meta('authority'),
  }
}

function parseList(stdout: string): Record<string, unknown>[] {
  const text = stdout.trim()
  if (!text) return []
  // `--quiet` 之后仍可能有 "Found N notes" 之类的尾行 → 只取第一个 JSON 值
  const start = text.indexOf('[')
  if (start < 0) return []
  const end = text.lastIndexOf(']')
  if (end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

/** 搜索 / 列举笔记 */
/**
 * 所有查询都排除的路径/文件名（计划 §7）。
 * 两个坑（Z4）：
 *   · 不传 glob（`-x 'archive/**'` 会静默失效）；
 *   · `-x` 是**相对 cwd** 解析的，不是相对 `--notebook-dir` —— 插件跑在任意 cwd 下，
 *     所以一律拼成绝对路径，否则换台机器/换个工作目录排除就静默失效。
 */
export function excludedNames(cfg: Config, opts: { includeArchived?: boolean } = {}): string[] {
  const rels: string[] = ['raw', 'inbox']
  if (!opts.includeArchived) rels.push(cfg.archiveDir)
  rels.push(...META_NAMES)
  return rels.map((rel) => path.join(cfg.notebook, rel))
}

export async function searchNotes(cfg: Config, opts: SearchOptions = {}, signal?: AbortSignal): Promise<NoteRecord[]> {
  const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 10)))
  const statuses = (opts.status ?? []).filter(Boolean)
  const types = (opts.type ?? []).filter(Boolean)
  const jsFilter = statuses.length > 0 || types.length > 0
  // status / type 只能在 JS 层过滤（Z6），但 --limit 是 zk 先截断 —— 过滤前必须多取，否则「前 10 条里没有 active」会假空。
  const fetchLimit = jsFilter ? 200 : limit
  const build = (strategy?: string): string[] => {
    const args = ['list', '--quiet', '--no-pager', '--format', 'json', '--limit', String(fetchLimit)]
    for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived })) args.push('-x', name)
    if (opts.query) args.push('-m', opts.query)
    if (strategy) args.push('-M', strategy)
    for (const t of opts.tags ?? []) args.push('-t', t)
    if (opts.since) args.push('--created-after', opts.since)
    if (opts.until) args.push('--created-before', opts.until)
    if (opts.orphan) args.push('--orphan')
    if (opts.brokenLinks) args.push('--broken-links')
    if (opts.sort && SORT_TERMS[opts.sort]) args.push('--sort', SORT_TERMS[opts.sort])
    for (const p of opts.paths ?? []) args.push(p)
    return args
  }

  // 0.1.0 的老笔记没有 frontmatter：status 缺省按 active 算，
  // 否则 flat vault 上 `status: ['active']` 会一条都查不出来（静默空结果比报错更难查）。
  const keep = (n: NoteRecord): boolean =>
    (statuses.length === 0 || statuses.includes(n.status || 'active')) &&
    (types.length === 0 || types.includes(n.type))

  const runStrategy = async (strategy?: string): Promise<NoteRecord[]> => {
    const notes = parseList(await zk(cfg, build(strategy), { signal })).map((raw) => toRecord(raw, cfg))
    return (jsFilter ? notes.filter(keep) : notes).slice(0, limit)
  }

  try {
    const hits = await runStrategy()
    // FTS5 的 unicode61 不切中文 → 中文整句会被当成一个 token，命中 0 条。
    // 结果为空且给了搜索词时退回正则（子串匹配）：宁可慢一次，也别让中文搜索静默失败。
    if (hits.length === 0 && opts.query) return await runStrategy('re')
    return hits
  } catch (err) {
    if (opts.query && err instanceof ZkError) return await runStrategy('re')
    throw err
  }
}

/** 巡检 / 做梦一次最多扫多少篇：到顶就告警，不静默截断（静默失败最难查） */
export const MAX_SCAN = 10_000

/** 一次取回全部笔记（巡检 / 做梦用；调用方自己截断）。`warnings` 见 `zk()`。 */
export async function allNotes(
  cfg: Config,
  opts: { includeArchived?: boolean; limit?: number; warnings?: string[] } = {},
  signal?: AbortSignal,
): Promise<NoteRecord[]> {
  const limit = Math.min(MAX_SCAN, Math.max(1, Math.trunc(opts.limit ?? MAX_SCAN)))
  const args = ['list', '--quiet', '--no-pager', '--format', 'json', '--limit', String(limit)]
  for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived })) args.push('-x', name)
  return parseList(await zk(cfg, args, { signal, warnings: opts.warnings })).map((raw) => toRecord(raw, cfg))
}

/**
 * zk 自带的布尔过滤器（比在 JS 里重算更贴近 zk 的定义）。
 * `--missing-backlink` 故意不在列：它的原义是「至少一条单向链接」，日记天然是出边，
 * 用它只会把日记提过的每篇笔记都报出来。单向链接由 `lint.ts` 在 `zk graph` 的边上算。
 */
export type FlagFilter = '--orphan' | '--tagless' | '--broken-links'

/**
 * 用 zk 的过滤器挑笔记，只取**绝对路径**。
 * 别用 `{{path}}`：它相对 cwd，换个工作目录就变成 `../../tmp/...`（Z4 同款坑）。
 * 一类过滤器一次进程，不要按笔记逐条跑。
 */
export async function notesWithFlag(cfg: Config, flag: FlagFilter, signal?: AbortSignal): Promise<string[]> {
  const args = ['list', '--quiet', '--no-pager', '--format', '{{absPath}}', '--limit', '10000', flag]
  for (const name of excludedNames(cfg)) args.push('-x', name)
  const out = await zk(cfg, args, { signal })
  return out.split('\n').map((line) => line.trim()).filter(Boolean)
}

export interface GraphEdge {
  sourcePath: string
  targetPath: string
}

/** 全部双链边（一次 `zk graph`）。路径是**笔记本相对**的，按路径比对，不缓存 targetId（Z11 之后 id 会变）。 */
export async function graphEdges(
  cfg: Config,
  signal?: AbortSignal,
  opts: { includeArchived?: boolean } = {},
): Promise<GraphEdge[]> {
  const args = ['graph', '--quiet', '--format', 'json', '--limit', '10000']
  for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived })) args.push('-x', name)
  const text = await zk(cfg, args, { signal })
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let graph: { links?: Array<Record<string, unknown>> }
  try {
    graph = JSON.parse(text.slice(start, end + 1)) as { links?: Array<Record<string, unknown>> }
  } catch {
    return []
  }
  const out: GraphEdge[] = []
  for (const link of graph.links ?? []) {
    const sourcePath = String(link.sourcePath ?? '')
    const targetPath = String(link.targetPath ?? '')
    if (sourcePath && targetPath) out.push({ sourcePath, targetPath })
  }
  return out
}

/**
 * `zk-kit query` 会被**丢掉**的参数：它们要么绕开「统一排除」，要么弄坏 JSON 解析。
 * 长名与短名都列出来（`--exclude` / `-x` 是同一个东西的两个写法）。
 */
const LIST_FLAGS_DROPPED = new Set([
  'notebook-dir', 'working-dir', 'format', 'exclude', 'no-input', 'no-pager', 'quiet', 'json', 'help',
  'f', 'x', 'W', 'P', 'q', 'h',
])
const LIST_FLAGS_WITH_VALUE = new Set(['notebook-dir', 'working-dir', 'format', 'exclude', 'f', 'x', 'W'])

/** 过滤透传参数：把会破坏不变量的 flag 连同它的值一起丢掉，其余原样保留 */
export function sanitizeListArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '')
    if (!arg || arg === '--') continue
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]
      if (LIST_FLAGS_DROPPED.has(name)) {
        if (!arg.includes('=') && LIST_FLAGS_WITH_VALUE.has(name)) i++
        continue
      }
      out.push(arg)
      continue
    }
    // 负数是参数值（如 --created-after 之后），不是短 flag
    if (arg.length > 1 && arg[0] === '-' && !/^-\d/.test(arg)) {
      const name = arg[1]
      if (LIST_FLAGS_DROPPED.has(name)) {
        if (arg.length === 2 && LIST_FLAGS_WITH_VALUE.has(name)) i++
        continue
      }
    }
    out.push(arg)
  }
  return out
}

/**
 * `zk list` 的透传入口（人终端用）。排除项与 format 在这里注入，不交给调用方。
 *
 * 0 命中且给了 `-m` 时退回正则（`-M re`）：FTS5 不切中文，不兜底的话
 * `query -m 中文短语` 会静默返回空（Z12，和 searchNotes 同一个坑）。
 * 用户自己写了 `-M` 就尊重用户的选择，不覆盖。
 */
export async function queryNotes(cfg: Config, argv: string[], signal?: AbortSignal): Promise<NoteRecord[]> {
  const passthrough = sanitizeListArgs(argv)
  const base = ['list', '--quiet', '--no-pager', '--format', 'json']
  for (const name of excludedNames(cfg)) base.push('-x', name)
  const runOnce = async (extra: string[]): Promise<NoteRecord[]> =>
    parseList(await zk(cfg, [...base, ...passthrough, ...extra], { signal })).map((raw) => toRecord(raw, cfg))

  const hasMatch = passthrough.some((a) => a === '-m' || a === '--match' || a.startsWith('--match=') || a.startsWith('-m='))
  const hasStrategy = passthrough.some((a) => a === '-M' || a === '--match-strategy' || a.startsWith('--match-strategy=') || a.startsWith('-M='))
  const hits = await runOnce([])
  if (hits.length === 0 && hasMatch && !hasStrategy) return await runOnce(['-M', 're'])
  return hits
}

/** 路径 → 绝对路径；出笔记本直接拒绝 */
export function absPathOf(cfg: Config, p: string): string {
  const raw = String(p ?? '').trim()
  if (!raw) throw new ZkError('路径不能为空')
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cfg.notebook, raw)
  const nb = path.resolve(cfg.notebook)
  if (abs !== nb && !abs.startsWith(nb + path.sep)) {
    throw new ZkError(`路径不在笔记本里：${p}`, '只允许读写 ' + nb + ' 下面的文件')
  }
  // .zk/ 是 zk 自己的索引与配置：读没意义，写会直接把笔记本搞坏
  const rel = path.relative(nb, abs)
  if (rel === '.zk' || rel.startsWith('.zk' + path.sep) || rel.startsWith('.zk/')) {
    throw new ZkError(`不能直接读写 zk 的内部文件：${p}`, '.zk/ 交给 zk 自己管理')
  }
  return abs
}

export function relPathOf(cfg: Config, abs: string): string {
  return path.relative(cfg.notebook, abs).split(path.sep).join('/')
}

/**
 * raw/ 是只读的原始材料。往里写不会报错，但会被 excludedNames 排除出索引 ——
 * 结果是「写了、没报错、但搜不到」，比直接失败更难查。所以在写入口就拦住。
 * 读不受影响：raw 里的材料照常 zk_read / Read。
 */
function assertWritablePath(cfg: Config, abs: string): void {
  const rel = relPathOf(cfg, abs)
  if (rel === 'raw' || rel.startsWith('raw/')) {
    throw new ZkError(
      `raw/ 是只读的原始材料，不能写：${rel}`,
      '结论写到 notes/，观察写进 daily；原始材料只在原位读，不改不搬',
    )
  }
}

export interface NoteDoc extends NoteRecord {
  content: string
  chars: number
}

function noteFromDisk(cfg: Config, abs: string): NoteDoc {
  const content = fs.readFileSync(abs, 'utf8')
  const stat = fs.statSync(abs)
  const heading = content.match(/^#\s+(.+)$/m)
  const tags = [...content.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1])
  const fields = parseFrontmatter(content).fields
  return {
    title: heading ? heading[1].trim() : path.basename(abs, path.extname(abs)),
    path: relPathOf(cfg, abs),
    absPath: abs,
    link: '',
    tags: [...new Set(tags)],
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    lead: '',
    words: content.split(/\s+/).filter(Boolean).length,
    metadata: { ...fields },
    status: fields.status ?? '',
    type: fields.type ?? '',
    authority: fields.authority ?? '',
    content,
    chars: content.length,
  }
}

/** 按路径读一篇（路径可以是相对笔记本的，也可以是笔记本内的绝对路径） */
export async function readNote(cfg: Config, p: string, signal?: AbortSignal): Promise<NoteDoc> {
  const abs = absPathOf(cfg, p)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ZkError(`笔记不存在：${p}`)
  let record: NoteRecord | null = null
  try {
    const rel = relPathOf(cfg, abs)
    const found = await searchNotes(cfg, { paths: [rel], limit: 20 }, signal)
    record = found.find((n) => path.resolve(n.absPath || n.path) === abs) ?? null
  } catch { /* 索引坏了也不耽误直接读文件 */ }
  const doc = noteFromDisk(cfg, abs)
  if (!record) return doc
  return { ...doc, ...record, content: doc.content, chars: doc.chars, title: record.title || doc.title, tags: record.tags.length ? record.tags : doc.tags }
}

/** 按路径或搜索词找一篇 */
export async function findNote(cfg: Config, query: string, signal?: AbortSignal): Promise<NoteDoc | null> {
  const trimmed = query.trim()
  if (!trimmed) return null
  const looksLikePath = trimmed.includes('/') || /\.(md|markdown|org|txt)$/i.test(trimmed)
  if (looksLikePath) {
    const abs = absPathOf(cfg, trimmed)
    if (fs.existsSync(abs)) return readNote(cfg, trimmed, signal)
  }
  const [hit] = await searchNotes(cfg, { query: trimmed, limit: 1 }, signal)
  if (!hit) return null
  return readNote(cfg, hit.absPath || hit.path, signal)
}

export interface NewNoteInput {
  title: string
  content?: string
  dir?: string
  group?: string
  /** 文件名（不含扩展名，只允许 basename）；不给就由 zk 按标题生成（layered 下是拼音 slug） */
  name?: string
  /** frontmatter 的 type（走 `--extra type=`，模板里是 `{{extra.type}}`） */
  type?: string
  /** frontmatter 的 authority（走 `--extra authority=`） */
  authority?: string
}

export interface NewNoteResult {
  path: string
  absPath: string
  title: string
  /** 归档里的同名旧结论（建之前那次全库扫描顺带算出来的，不再额外跑一次 zk） */
  archived: ArchivedTitleHit[]
}

/** 文件名里不收的字符：路径分隔符 + Windows 非法字符（库会被同步到 Windows / 塞进 zip） */
const BAD_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/

/**
 * 校验调用方给的文件名（只收 basename，不含扩展名）。
 *
 * 只管「能不能落成文件」：超过文件系统的 255 字节单段上限就是 ENAMETOOLONG，
 * 那行错误照着做不了，所以在这里换成一句能照做的。可读性好坏不归它判断。
 */
function normalizeNoteName(raw: string): string {
  const name = String(raw ?? '').trim().replace(NOTE_EXT, '')
  if (!name) throw new ZkError('文件名不能为空', '不给 name 就由 zk 按标题生成；给了就要有内容')
  if (name === '.' || name === '..') throw new ZkError(`文件名不能是 ${name}`)
  if (name.startsWith('.')) throw new ZkError(`文件名不能以 . 开头：${name}`, '开头的点会被当成隐藏文件，去掉它')
  if (BAD_FILE_NAME.test(name)) {
    throw new ZkError(`文件名里有不能用的字符：${name}`, '只给文件名本身，不要 / \\ : * ? " < > |；换目录用 dir')
  }
  // 255 是单段上限，扩展名也算在里面（.md 占 3 字节）
  if (Buffer.byteLength(name) > 252) {
    throw new ZkError(
      `文件名太长：${Buffer.byteLength(name)} 字节`,
      '文件系统单段上限是 255 字节，缩到 252 字节以内（中文约 80 字）',
    )
  }
  return name
}

/** 全库扫描（建笔记之前那一次）：默认走 allNotes（含归档），测试可注入一个会失败的版本 */
export type NoteScan = (cfg: Config, signal?: AbortSignal) => Promise<NoteRecord[]>

/**
 * 用 zk new 建一篇（正文走 stdin → 模板里的 {{content}}）。
 *
 * 撞名（Z8）：`zk new` 遇到同名文件时 exit 0、**内容不写**、只回显路径 —— 不查就会静默丢内容。
 * 所以在建之前拍一张目录快照，建完发现文件名本来就有，直接报错（先写入的内容一个字没动，可以放心重试）。
 */
export async function createNote(
  cfg: Config,
  input: NewNoteInput,
  signal?: AbortSignal,
  scan: NoteScan = (c, s) => allNotes(c, { includeArchived: true }, s),
): Promise<NewNoteResult> {
  const title = input.title.trim()
  if (!title) throw new ZkError('标题不能为空')
  // 给了 name 就是确定的 basename：先校验，后面建完直接换名
  const wanted = input.name ? normalizeNoteName(input.name) : ''
  const dir = (input.dir ?? cfg.notesDir).replace(/^\/+/, '') || '.'

  // 一次全库扫描（含归档）干两件事：活笔记查重 + 归档同名提醒。
  // 以前是各跑一次 `zk list`：同一个库扫两遍，还多起一个进程。
  const dupCheck = cfg.structure !== 'layered'
  let archived: ArchivedTitleHit[] = []
  if (hasNotebook(cfg)) {
    let snapshot: NoteRecord[] | null = null
    try {
      snapshot = await scan(cfg, signal)
    } catch (err) {
      // flat 的标题查重是写入前的硬门槛（不查就会静默丢正文），扫描失败必须 fail-closed；
      // layered 的同名由 zk 自己拒，归档提醒只是附加信息 —— 扫不动就照建，宁可少一条提醒。
      if (dupCheck) throw err
    }
    if (snapshot) {
      // flat 用的是 zk 默认的随机 {{id}} 文件名，按文件名查重永远不会命中；标题重复必须在建之前查。
      // layered 的 group 用 {{slug title}}，同一目录同名会被 zk 自己拒绝；不同目录允许同名（lint 会提示）。
      // 只查可见笔记：归档里的旧结论不参与查重，可以复用标题。
      if (dupCheck) {
        const key = normalizeTitle(title)
        const existing = snapshot.find((n) => !inArchive(cfg, n.path) && normalizeTitle(n.title) === key)
        if (existing) {
          throw new ZkError(
            `同名笔记已存在：${existing.path}`,
            '换一个标题，或直接用 zk_read / zk_append 改那一篇；归档里的旧结论不参与查重，可以复用标题',
          )
        }
      } else if (wanted) {
        // 给了 name 的 layered 笔记不走 zk 的 slug 撞名（文件名和标题脱钩，同名不会被拒），
        // 所以按标题在同目录下补一道 —— 口径和 lint 的 duplicateTitles 一致。
        const key = normalizeTitle(title)
        const dirKey = dir.replace(/\/+$/, '')
        const existing = snapshot.find((n) => !inArchive(cfg, n.path)
          && path.posix.dirname(n.path) === dirKey
          && normalizeTitle(n.title) === key)
        if (existing) {
          throw new ZkError(
            `同目录下已有同名笔记：${existing.path}`,
            '换一个标题，或直接用 zk_read / zk_append 改那一篇',
          )
        }
      }
      archived = archivedHits(cfg, snapshot, title)
    }
  }

  // zk 解析相对目录用的是 cwd，不是笔记本 → 一律给绝对路径；
  // 先过 absPathOf：别在 zk 拒绝之前就把 `../..` 目录 mkdir 出去。
  const dirAbs = absPathOf(cfg, dir)
  assertWritablePath(cfg, dirAbs)
  fs.mkdirSync(dirAbs, { recursive: true })
  const before = new Set(fs.readdirSync(dirAbs))
  // name 是确定的，撞名在建之前就能查出来：zk 撞名是 exit 0 + 丢正文，不能等它
  const clash = wanted && [...before].find((f) => path.basename(f, path.extname(f)) === wanted)
  if (clash) {
    throw new ZkError(
      `同名笔记已存在：${dir === '.' ? '' : dir + '/'}${clash}`,
      '换一个 name，或直接用 zk_read / zk_append 改那一篇',
    )
  }
  const args = ['new', dirAbs, '-t', title, '-i', '-p']
  if (input.group) args.push('-g', input.group)
  // 只在真给了 type/authority 时才传：flat 的 daily/notes 模板没有 {{extra.*}}，多传无害但没必要
  if (input.type) args.push('--extra', `type=${input.type}`)
  if (input.authority) args.push('--extra', `authority=${input.authority}`)
  const stdout = await zk(cfg, args, { signal, input: input.content ?? '' })
  const last = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  if (!last) throw new ZkError('zk new 没有返回笔记路径')
  const abs = path.isAbsolute(last) ? last : path.resolve(cfg.notebook, last)
  if (!fs.existsSync(abs)) throw new ZkError(`zk 说建好了但文件不存在：${abs}`)
  if (before.has(path.basename(abs))) {
    throw new ZkError(
      `同名笔记已存在：${relPathOf(cfg, abs)}`,
      '同名时 zk 不覆盖（这次传入的正文被丢弃了，原文件一个字都没动）。换个标题，或直接用 zk_read / zk_append 改那一篇',
    )
  }
  // name 只换 basename、不换目录：正文里的相对链接和 [[stem]] 都不受影响，所以这里是纯搬文件。
  // 跨目录改名要重写入链，那是 zk_rename / renameNote 的活，不走这条路。
  let finalAbs = abs
  if (wanted && path.basename(abs, path.extname(abs)) !== wanted) {
    const targetAbs = path.join(path.dirname(abs), wanted + (path.extname(abs) || '.md'))
    try {
      fs.renameSync(abs, targetAbs)
    } catch (err) {
      throw new ZkError(
        `笔记已建好，但改文件名失败：${err instanceof Error ? err.message : String(err)}`,
        `文件还在 ${relPathOf(cfg, abs)}，可以直接改文件名，或删掉重来`,
      )
    }
    finalAbs = targetAbs
  }
  return { path: relPathOf(cfg, finalAbs), absPath: finalAbs, title, archived }
}

export interface ArchivedTitleHit {
  path: string
  title: string
  /** supersede 时写下的原因；老笔记没写过就是空串 */
  reason: string
}

/** 笔记本相对路径是否在归档目录下（supersede 会把文件搬进去，路径保持不变） */
function inArchive(cfg: Config, rel: string): boolean {
  return rel === cfg.archiveDir || rel.startsWith(`${cfg.archiveDir}/`)
}

/**
 * 归档里同名的旧结论 —— 机械查重，不判断「是不是同一个错误」。
 *
 * zk_new 的标题查重只看活笔记，旧结论被 supersede 后标题就空出来了。允许复用，
 * 但要把 supersede-reason 一起带出来：重新提出同样的错误结论，通常从复用这个标题开始。
 * 输入是 createNote 建之前那一次全库快照：纯内存计算，不再单独跑一次 zk。
 */
function archivedHits(cfg: Config, notes: NoteRecord[], title: string): ArchivedTitleHit[] {
  const key = normalizeTitle(title)
  if (!key) return []
  return notes
    .filter((n) => inArchive(cfg, n.path))
    .filter((n) => normalizeTitle(n.title) === key)
    .map((n) => ({
      path: n.path,
      title: n.title,
      reason: String(n.metadata['supersede-reason'] ?? '').trim(),
    }))
}

export interface AppendResult {
  path: string
  appendedChars: number
  bytes: number
}

/**
 * `## 名称` 小节的正文范围（行号，右开）：从标题下一行到下一个一/二级标题之前。
 * 没有这一节返回 null —— 调用方退回「追加到文件末尾」。
 */
function sectionRange(content: string, name: string): { start: number; end: number } | null {
  const lines = content.split('\n')
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^##\\s+${escaped}\\s*$`, 'i')
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+\S/.test(lines[i])) { end = i; break }
  }
  return { start: start + 1, end }
}

/**
 * 往一篇笔记追加（自动补空行；可选先写一个二级标题）。
 *
 * `section` 给了且笔记里有这一节时，追加到该节末尾，标题降为三级 —— 日记模板的
 * `## Events` 是正文位置，同级的 `## HH:MM` 会把条目顶成兄弟小节，反而落到
 * `## Loose ends` 之后。没有这一节（flat 日记 / 用户自定义日记）就仍旧追加到末尾。
 */
export function appendToNote(
  cfg: Config,
  p: string,
  text: string,
  opts: { heading?: string; section?: string } = {},
): AppendResult {
  const abs = absPathOf(cfg, p)
  if (!fs.existsSync(abs)) throw new ZkError(`笔记不存在：${p}`)
  assertWritablePath(cfg, abs)
  // meta 文件是人的工作面：追加会把它变成流水账，也让「记忆被谁改的」失去审计线索
  if (isMetaPath(relPathOf(cfg, abs))) {
    throw new ZkError(`${relPathOf(cfg, abs)} 是 meta 文件，不能用 zk_append 追加`,
      `${META_NAMES.join(' / ')} 请直接编辑（整篇重写，git diff 可审）`)
  }
  const body = String(text ?? '').trim()
  if (!body) throw new ZkError('追加内容不能为空')
  const current = fs.readFileSync(abs, 'utf8')
  // 标题只占一行：换行会把后面的正文顶出小节
  const title = opts.heading ? opts.heading.replace(/\s+/g, ' ').trim() : ''
  const range = opts.section ? sectionRange(current, opts.section) : null
  if (range) {
    const lines = current.split('\n')
    const parts = [
      lines.slice(0, range.start).join('\n'),
      lines.slice(range.start, range.end).join('\n'),
      `${title ? `### ${title}\n\n` : ''}${body}`,
      lines.slice(range.end).join('\n'),
    ].map((part) => part.trim()).filter(Boolean)
    fs.writeFileSync(abs, `${parts.join('\n\n')}\n`, 'utf8')
  } else {
    const sep = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
    const heading = title ? `## ${title}\n\n` : ''
    fs.appendFileSync(abs, `${sep}${heading}${body}\n`, 'utf8')
  }
  const bytes = fs.statSync(abs).size
  return { path: relPathOf(cfg, abs), appendedChars: body.length, bytes }
}

/**
 * 确保「今天的日记」存在，返回它的路径。
 * created 用目录快照判断（zk 的日期模板不让我们预先算文件名，但可以对比前后）。
 */
export async function ensureDailyNote(
  cfg: Config,
  opts: { date?: string } = {},
  signal?: AbortSignal,
): Promise<{ path: string; absPath: string; created: boolean }> {
  const dirAbs = path.resolve(cfg.notebook, cfg.dailyDir)
  fs.mkdirSync(dirAbs, { recursive: true })
  const before = new Set(fs.readdirSync(dirAbs))
  const args = ['new', dirAbs, '-p']
  if (cfg.dailyGroup) args.push('-g', cfg.dailyGroup)
  if (opts.date) args.push('--date', opts.date)
  const stdout = await zk(cfg, args, { signal })
  const last = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  if (!last) throw new ZkError('zk new 没有返回日记路径')
  const abs = path.isAbsolute(last) ? last : path.resolve(cfg.notebook, last)
  const created = !before.has(path.basename(abs))
  return { path: relPathOf(cfg, abs), absPath: abs, created }
}

/**
 * 往日记里追加一段（layered 模板写进 `## Events` 的 `### HH:MM`，
 * flat 模板仍是文件末尾的 `## HH:MM`）
 */
export function appendDaily(
  cfg: Config,
  p: string,
  entry: string,
  now: Date = new Date(),
): AppendResult {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return appendToNote(cfg, p, entry, { heading: `${hh}:${mm}`, section: 'Events' })
}

const NOTE_EXT = /\.(md|markdown|org|txt)$/i

/** 相对笔记本、去掉扩展名的路径 —— 也就是 zk 双链里写的那一段（Z11） */
export function linkStemOf(cfg: Config, abs: string): string {
  return relPathOf(cfg, abs).replace(NOTE_EXT, '')
}

export interface LinkResult {
  from: string
  to: string
  link: string
  added: boolean
}

/** 在 from 里加一条指向 to 的 wiki 双链（重复就跳过） */
export async function linkNotes(
  cfg: Config,
  fromPath: string,
  target: string,
  signal?: AbortSignal,
): Promise<LinkResult> {
  const fromAbs = absPathOf(cfg, fromPath)
  if (!fs.existsSync(fromAbs)) throw new ZkError(`笔记不存在：${fromPath}`)
  assertWritablePath(cfg, fromAbs)

  const targetDoc = await findNote(cfg, target, signal)
  if (!targetDoc) {
    // 目标必须存在：写一条指向空气的 `[[…]]` 只会变成断链，还不如当场报错并给出最像的几篇
    let hints: string[] = []
    try {
      hints = (await searchNotes(cfg, { query: target, limit: 3 }, signal)).map((n) => `${n.title}（${n.path}）`)
    } catch { /* 索引不可用就只报错 */ }
    throw new ZkError(
      `找不到要链接的笔记：${target}`,
      hints.length ? `是不是想链：${hints.join('、')}` : '先用 zk_search 查一下标题，或用 zk_new 把它建出来',
    )
  }
  const targetAbs = absPathOf(cfg, targetDoc.absPath || targetDoc.path)
  if (targetAbs === fromAbs) throw new ZkError('不能链接自己', '换一个目标笔记')
  const stem = linkStemOf(cfg, targetAbs)
  const link = `[[${stem}]]`

  const source = fs.readFileSync(fromAbs, 'utf8')
  if (source.includes(link)) {
    return { from: relPathOf(cfg, fromAbs), to: relPathOf(cfg, targetAbs), link, added: false }
  }
  const sep = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n'
  // 小节标题统一用 `## Links`；旧笔记里已有的 `## 链接` 照用，不追加第二个小节
  const heading = /^##\s+(?:Links|链接)\s*$/m.test(source) ? '' : '## Links\n\n'
  fs.appendFileSync(fromAbs, `${sep}${heading}- ${link}\n`, 'utf8')
  return { from: relPathOf(cfg, fromAbs), to: relPathOf(cfg, targetAbs), link, added: true }
}

export interface NotebookStats {
  notes: number
  tags: number
  brokenLinks: number
  orphans: number
  /** archive/ 下的笔记数（和检索同一口径：以索引为准，解析不了 frontmatter 的文件不算） */
  archived: number
  /** frontmatter status: superseded 的笔记数（含已归档的，以及手工标了但没搬的） */
  superseded: number
}

export async function notebookStats(cfg: Config, signal?: AbortSignal): Promise<NotebookStats> {
  const exclude = excludedNames(cfg).flatMap((name) => ['-x', name])
  const count = async (args: string[]): Promise<number> => {
    const out = await zk(cfg, ['list', '--quiet', '--no-pager', '--format', '{{path}}', ...exclude, ...args], { signal })
    return out.split('\n').filter((l) => l.trim()).length
  }
  // 一次全库（含归档）拿全：笔记数 / 标签 / 归档数 / superseded 都从这份算。
  // 以前是「多跑一次 list 数笔记 + 递归扫 archive 再逐篇读全文看 status」——
  // 归档一大，光数个数就要把整片归档读一遍磁盘。
  const [brokenLinks, orphans, all] = await Promise.all([
    count(['--broken-links']),
    count(['--orphan']),
    allNotes(cfg, { includeArchived: true }, signal),
  ])
  const live = all.filter((n) => !inArchive(cfg, n.path))
  // 标签数只从可见笔记汇总：zk tag list 没有 -x，直接用它会把 raw/inbox/archive/meta 的标签也算进来。
  return {
    notes: live.length,
    tags: new Set(live.flatMap((n) => n.tags)).size,
    brokenLinks,
    orphans,
    archived: all.length - live.length,
    // 含已归档的，以及手工标了但没搬进 archive 的（正常流程会搬，这里兜手滑）
    superseded: all.filter((n) => n.status === 'superseded').length,
  }
}

export async function indexNotebook(cfg: Config, signal?: AbortSignal): Promise<void> {
  await zk(cfg, ['index', '--quiet'], { signal, timeoutMs: 120_000 })
}

/** 指向某篇笔记的所有来源笔记（相对路径）—— 一次 `zk graph`，不按笔记逐个跑 */
async function inboundSources(
  cfg: Config,
  rel: string,
  signal?: AbortSignal,
  opts: { includeArchived?: boolean } = {},
): Promise<string[]> {
  const out: string[] = []
  for (const edge of await graphEdges(cfg, signal, opts)) {
    if (edge.targetPath !== rel) continue
    if (edge.sourcePath !== rel && !out.includes(edge.sourcePath)) out.push(edge.sourcePath)
  }
  return out
}

export interface SupersedeOptions {
  /** 要废弃的笔记（相对路径） */
  path: string
  /** 替代它的笔记（相对路径或标题）；不给 = 只是废弃，没有接班人 */
  by?: string
  /** 为什么废弃（一句话；写进归档 frontmatter 的 supersede-reason，查重时会带出来） */
  reason?: string
  /** 默认 true：只出清单，不动文件 */
  dryRun?: boolean
}

export interface SupersedeRewrite {
  path: string
  replaced: number
}

export interface SupersedeResult {
  dryRun: boolean
  performed: boolean
  /** 之前就已经是 superseded（重放/重复调用）→ 本次什么都没做 */
  alreadySuperseded: boolean
  path: string
  /** 归档后的相对路径（保留原相对路径，见计划 §3 D4） */
  archivePath: string
  supersededBy: string | null
  /** 规范化后的废弃原因（单行、≤200 字）；没给就是 null */
  reason: string | null
  /** 被重写入链的来源笔记 */
  rewrittenLinks: SupersedeRewrite[]
  /** 图里有入链、但正文里找不到 `[[旧路径]]` 字面量（手写了别的写法）—— 需要人看 */
  missingLinks: string[]
}

/**
 * 废弃一篇笔记：标 status → 重写入链 → 搬进 archive/（保留原相对路径）。
 *
 * 为什么必须重写入链（Z11）：双链是路径式的，文件一 move 全部入链即断。
 * 顺序：先改入链（指向将来的归档路径）→ 再改自己的 frontmatter → 最后 rename；
 * 正常路径下可重放：第二次调用看到 status 已是 superseded 就直接返回。
 * 例外：frontmatter 已写、rename 失败时，重试会直接返回，需要人工把文件搬进 archive/。
 * 索引不用手动重建（Z11：zk 下次运行时自己追平），但调用方不要在同一次里依赖旧 targetId。
 */
export async function supersedeNote(
  cfg: Config,
  opts: SupersedeOptions,
  signal?: AbortSignal,
): Promise<SupersedeResult> {
  const dryRun = opts.dryRun !== false
  const reason = normalizeReason(opts.reason)
  const abs = absPathOf(cfg, opts.path)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ZkError(`笔记不存在：${opts.path}`)
  assertWritablePath(cfg, abs)

  const rel = relPathOf(cfg, abs)
  const content = fs.readFileSync(abs, 'utf8')
  const fields = parseFrontmatter(content).fields
  const inArchive = rel === cfg.archiveDir || rel.startsWith(`${cfg.archiveDir}/`)

  if (fields.status === 'superseded') {
    return {
      dryRun,
      performed: false,
      alreadySuperseded: true,
      path: rel,
      archivePath: inArchive ? rel : `${cfg.archiveDir}/${rel}`,
      supersededBy: fields['superseded-by'] ?? null,
      reason: fields['supersede-reason'] ?? null,
      rewrittenLinks: [],
      missingLinks: [],
    }
  }
  if (inArchive) {
    throw new ZkError(
      `这篇已经在归档目录里，但 status 不是 superseded：${rel}`,
      '归档区里只放废弃笔记；先确认它的 status，别在这里反复挪',
    )
  }

  // ── 替代者：必须存在、必须还活着 ──────────────────────────────────
  let byStem: string | null = null
  const by = opts.by?.trim()
  if (by) {
    const target = await findNote(cfg, by, signal)
    if (!target) throw new ZkError(`找不到替代笔记：${by}`, '先把它建出来，再把 by 指向它')
    const targetAbs = absPathOf(cfg, target.absPath || target.path)
    if (targetAbs === abs) throw new ZkError('替代笔记不能是它自己')
    if (target.path === cfg.archiveDir || target.path.startsWith(`${cfg.archiveDir}/`)) {
      throw new ZkError(`替代笔记自己就在归档里：${target.path}`, '用一篇还活着的笔记当接班人')
    }
    const targetStatus = parseFrontmatter(fs.readFileSync(targetAbs, 'utf8')).fields.status
    if (targetStatus === 'superseded') {
      throw new ZkError(`替代笔记自己也是 superseded：${target.path}`, '先把那条链理顺，别把废弃指向废弃')
    }
    byStem = linkStemOf(cfg, targetAbs)
  }

  const archivePath = `${cfg.archiveDir}/${rel}`
  const archiveAbs = path.join(cfg.notebook, archivePath)
  if (fs.existsSync(archiveAbs)) {
    throw new ZkError(`归档位置已被占用：${archivePath}`, '先处理掉那个文件，否则 rename 会把它覆盖')
  }

  // ── 入链：只改能精确匹配 `[[旧路径]]` 的那些 ──────────────────────
  const oldStem = linkStemOf(cfg, abs)
  const newStem = archivePath.replace(NOTE_EXT, '')
  const rewrittenLinks: SupersedeRewrite[] = []
  const missingLinks: string[] = []
  for (const source of await inboundSources(cfg, rel, signal)) {
    const sourceAbs = path.join(cfg.notebook, source)
    let text: string
    try { text = fs.readFileSync(sourceAbs, 'utf8') } catch { continue }
    const replaced = text.split(`[[${oldStem}]]`).length - 1
    if (replaced === 0) { missingLinks.push(source); continue }
    rewrittenLinks.push({ path: source, replaced })
    if (!dryRun) fs.writeFileSync(sourceAbs, text.split(`[[${oldStem}]]`).join(`[[${newStem}]]`), 'utf8')
  }

  if (!dryRun) {
    const patch: Record<string, string | undefined> = {
      status: 'superseded',
      'superseded-by': byStem ? `[[${byStem}]]` : undefined,
    }
    // JSON.stringify = 合法的 YAML 双引号标量：原因里带冒号也不会把 frontmatter 写坏
    if (reason) patch['supersede-reason'] = JSON.stringify(reason)
    fs.writeFileSync(abs, setFrontmatter(content, patch), 'utf8')
    fs.mkdirSync(path.dirname(archiveAbs), { recursive: true })
    fs.renameSync(abs, archiveAbs)
  }

  return {
    dryRun,
    performed: !dryRun,
    alreadySuperseded: false,
    path: rel,
    archivePath,
    supersededBy: byStem ? `[[${byStem}]]` : null,
    reason,
    rewrittenLinks,
    missingLinks,
  }
}


// ── 改名（M7）：先把能解析到的入链改到新路径，再搬文件 ──────────────────
//
// 断链风险来自三处，改名时一次处理：
//   1. 别的笔记里的 `[[旧路径]]` —— 按**实际解析结果**匹配（相对来源目录或相对笔记本根），
//      不用字面量匹配：同目录写成 `[[foo]]` 的入链也能认出来；
//   2. 根目录 meta 文件（MEMORY.md / USER.md …）里的 `[[来源]]` —— 它们不进 zk graph；
//   3. 被搬走那篇自己的相对链接（wiki 与 Markdown 都算）—— 换了目录，同样的写法就指向别处了。
// 锚点（#小节）、别名（|别名）、Markdown 链接与图片一起处理。认不出的写法列进 missingLinks，不猜。

export interface RenameOptions {
  /** 当前相对路径 */
  path: string
  /** 新相对路径：只给文件名 = 留在原目录；以 / 结尾 = 放进那个目录、保留原文件名 */
  to: string
  /** 默认 true：只出清单，不动文件 */
  dryRun?: boolean
}

export interface RenameRewrite {
  path: string
  replaced: number
}

export interface RenameResult {
  dryRun: boolean
  performed: boolean
  path: string
  newPath: string
  /** 别处被重写的入链（笔记 + 根目录 meta 文件） */
  rewrittenLinks: RenameRewrite[]
  /** 图里有入链、但正文里找不到能识别的写法 —— 需要人看 */
  missingLinks: string[]
  /** 被改名笔记自己正文里跟着重算的相对链接条数 */
  selfRewritten: number
}

interface WikiTarget {
  abs: string
  /** root = 按笔记本根解析出的路径；stem = 按文件名（全局唯一）匹配 */
  style: 'root' | 'stem'
}

/** 文件名（去扩展名）→ 绝对路径；wiki 链接允许只写文件名，zk 会按全局文件名匹配 */
type StemIndex = Map<string, string[]>

/** wiki 链接：[[目标|别名]] / [[目标#小节]]（不含换行与嵌套方括号） */
const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/g
/** Markdown 行内链接 / 图片：[文字](目标 "标题")，目标可带尖括号 */
const MD_LINK = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)([^)\n]*\))/g

/** 候选路径在笔记本里存在、且是文件 → 返回绝对路径（wiki 链接常省略扩展名） */
function existingFile(cfg: Config, base: string): string | null {
  const nb = path.resolve(cfg.notebook)
  for (const abs of [base, base + '.md', base + '.markdown']) {
    if (abs !== nb && !abs.startsWith(nb + path.sep)) continue
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs
    } catch { /* 读不到的当没命中 */ }
  }
  return null
}

/**
 * 解析 wiki 链接目标。zk 的路径是**笔记本根相对**（不是相对链接所在目录，实测 ../ 不建边），
 * 另外允许只写文件名（全局按文件名匹配）。认 URL / 纯锚点 / 不存在的目标为 null。
 */
function resolveWikiTarget(cfg: Config, target: string, stems: StemIndex): WikiTarget | null {
  const raw = target.trim()
  if (!raw || raw.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null
  const rel = raw.replace(/^\/+/, '')
  if (!rel) return null
  const byRoot = existingFile(cfg, path.resolve(cfg.notebook, rel))
  if (byRoot) return { abs: byRoot, style: 'root' }
  if (rel.includes('/')) return null
  const hits = stems.get(rel.replace(NOTE_EXT, '')) ?? []
  // 同名多篇时 zk 自己也可能选错 —— 不猜，留给人看
  return hits.length === 1 ? { abs: hits[0], style: 'stem' } : null
}

/** Markdown 链接只相对当前文件解析（实测根相对写法 zk 不建边） */
function resolveMarkdownTarget(cfg: Config, sourceDir: string, target: string): string | null {
  const raw = target.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null
  return existingFile(cfg, path.resolve(sourceDir, raw))
}

/** 写出相对笔记本根的路径（wiki 链接用；不带前导 /，zk 不认） */
function rootLinkPath(cfg: Config, targetAbs: string, keepExt: boolean): string {
  const rel = relPathOf(cfg, targetAbs)
  return keepExt ? rel : rel.replace(NOTE_EXT, '')
}

/** 写出从 outDir 到 targetAbs 的相对路径（Markdown 链接用；转义交给调用方） */
function relativeLinkPath(outDir: string, targetAbs: string, keepExt: boolean): string {
  let rel = path.relative(outDir, targetAbs).split(path.sep).join('/')
  if (!rel) rel = path.basename(targetAbs)
  return keepExt ? rel : rel.replace(NOTE_EXT, '')
}

interface RelinkPlan {
  /** Markdown 链接按哪个目录解析（来源笔记目录 / 笔记搬走前的目录） */
  sourceDir: string
  /** Markdown 链接按哪个目录写出（来源笔记目录不变 / 笔记搬走后的新目录） */
  outDir: string
  /** 解析结果命中这些绝对路径时换成新路径 */
  remap: Map<string, string>
  /** true = 所有相对 Markdown 链接都按 outDir 重算（文件自己换了目录） */
  rebaseMarkdown: boolean
  stems: StemIndex
}

/** 按计划重写一段 Markdown 里的链接；返回新文本与被改条数 */
function relinkText(cfg: Config, text: string, plan: RelinkPlan): { text: string; changed: number } {
  let changed = 0

  const afterWiki = text.replace(WIKI_LINK, (whole: string, inner: string) => {
    const bar = inner.indexOf('|')
    const head = bar >= 0 ? inner.slice(0, bar) : inner
    const tail = bar >= 0 ? inner.slice(bar) : ''
    const hash = head.indexOf('#')
    const target = (hash >= 0 ? head.slice(0, hash) : head).trim()
    const anchor = hash >= 0 ? head.slice(hash) : ''
    if (!target) return whole
    const resolved = resolveWikiTarget(cfg, target, plan.stems)
    if (!resolved) return whole
    const next = plan.remap.get(resolved.abs)
    // 换目录不影响 wiki 链接（按根 / 文件名解析），只有指向自己时才需要改
    if (!next) return whole
    const out = rootLinkPath(cfg, next, NOTE_EXT.test(target))
    const rebuilt = '[[' + out + anchor + tail + ']]'
    if (rebuilt === whole) return whole
    changed++
    return rebuilt
  })

  const afterMd = afterWiki.replace(MD_LINK, (whole: string, prefix: string, dest: string, tail: string) => {
    const angled = dest.startsWith('<') && dest.endsWith('>')
    const raw = angled ? dest.slice(1, -1) : dest
    if (!raw || raw.startsWith('#')) return whole
    const hash = raw.indexOf('#')
    const pathPart = hash >= 0 ? raw.slice(0, hash) : raw
    const frag = hash >= 0 ? raw.slice(hash) : ''
    if (!pathPart) return whole
    const resolved = resolveMarkdownTarget(cfg, plan.sourceDir, pathPart)
    if (!resolved) return whole
    const next = plan.remap.get(resolved) ?? (plan.rebaseMarkdown ? resolved : undefined)
    if (!next) return whole
    const rel = relativeLinkPath(plan.outDir, next, NOTE_EXT.test(pathPart))
    // 空格 / 括号在 Markdown 目标里必须转义（统一用 %xx，不猜编辑器）
    const escaped = /[\s()%]/.test(rel) ? encodeURI(rel).replace(/\(/g, '%28').replace(/\)/g, '%29') : rel
    const rebuilt = prefix + (angled ? '<' + escaped + '>' : escaped) + frag + tail
    if (rebuilt === whole) return whole
    changed++
    return rebuilt
  })

  return { text: afterMd, changed }
}

/** 新路径归一化：可只给文件名、可给目录（末尾 /），扩展名不变；跑出笔记本由 absPathOf 兜 */
function renameTargetRel(cfg: Config, oldAbs: string, to: string): string {
  const raw = String(to ?? '').trim()
  if (!raw) throw new ZkError('新路径不能为空', '给一个相对路径，例如 notes/新标题.md')
  const oldExt = path.extname(oldAbs)
  const oldBase = path.basename(oldAbs)
  let rel: string
  if (path.isAbsolute(raw)) {
    rel = relPathOf(cfg, absPathOf(cfg, raw))
  } else {
    rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
  }
  // 目录形式：末尾 / ，或指向一个已存在的目录 → 保留原文件名
  const asDir = rel.endsWith('/')
  let target = asDir ? `${rel.replace(/\/+$/, '')}/${oldBase}` : rel
  if (!asDir) {
    const probe = path.resolve(cfg.notebook, target)
    try {
      if (fs.existsSync(probe) && fs.statSync(probe).isDirectory()) target = `${target}/${oldBase}`
    } catch { /* 探测失败就按文件处理，后面 existsSync 会再拦 */ }
  }
  target = target.replace(/\/{2,}/g, '/').replace(/^\/+/, '')
  const ext = path.extname(target)
  if (!ext) target += oldExt
  else if (ext.toLowerCase() !== oldExt.toLowerCase()) {
    throw new ZkError(`改名不能换格式：${ext} ≠ ${oldExt}`, '只改文件名或目录；换格式请新建一篇再 zk_supersede')
  }
  return target
}

/**
 * 给一篇笔记改名 / 换目录，并把引用它的链接一起改到新路径。
 *
 * 顺序：先在内存里算好所有改写（解析用当前磁盘状态，旧文件还在）→ rename → 写回。
 * 入链先改、后搬文件会让「目标还不存在」的中间态出现在磁盘上；反过来则是「入链短暂失效」——
 * 两者都会在进程中途失败时留下半成品，区别只在于重跑时从哪一侧接上。这里选 rename 先行：
 * 文件搬到位之后，剩下的只是文本改写，重复调用不会再搬第二次。
 * 可重放：第二次调用原路径已经不存在，直接报「笔记不存在」。
 */
export async function renameNote(
  cfg: Config,
  opts: RenameOptions,
  signal?: AbortSignal,
): Promise<RenameResult> {
  const dryRun = opts.dryRun !== false
  const oldAbs = absPathOf(cfg, opts.path)
  if (!fs.existsSync(oldAbs) || !fs.statSync(oldAbs).isFile()) throw new ZkError(`笔记不存在：${opts.path}`)
  const oldRel = relPathOf(cfg, oldAbs)

  if (isMetaPath(oldRel)) {
    throw new ZkError(`${oldRel} 是 meta 文件，不能改名`, `${META_NAMES.join(' / ')} 的名字是约定（注入、排除都按它认），要改内容请直接编辑`)
  }
  assertWritablePath(cfg, oldAbs)
  if (oldRel === cfg.archiveDir || oldRel.startsWith(`${cfg.archiveDir}/`)) {
    throw new ZkError(`归档里的笔记不能改名：${oldRel}`, `${cfg.archiveDir}/ 下的路径是 supersede 重写入链的目标，搬动它会让历史链接再断一次`)
  }
  const oldBase = path.basename(oldAbs, path.extname(oldAbs))
  if (path.dirname(oldRel) === cfg.dailyDir && /^\d{4}-\d{2}-\d{2}$/.test(oldBase)) {
    throw new ZkError(`日记按日期命名，不能改名：${oldRel}`, '改名后 zk_daily 会为同一天另建一篇；整理内容用 zk_append，废弃结论用 zk_supersede')
  }

  const newRel = renameTargetRel(cfg, oldAbs, opts.to)
  const newAbs = absPathOf(cfg, newRel)
  if (newAbs === oldAbs) throw new ZkError('新旧路径一样', '给一个不同的文件名或目录')
  if (isMetaPath(newRel)) {
    throw new ZkError(`不能把笔记改名成 meta 文件：${newRel}`, `${META_NAMES.join(' / ')} 是根目录约定文件，请直接编辑它们`)
  }
  assertWritablePath(cfg, newAbs)
  if (newRel === cfg.archiveDir || newRel.startsWith(`${cfg.archiveDir}/`)) {
    throw new ZkError(`不能把笔记改名进归档目录：${newRel}`, '归档只由 zk_supersede 写入；要废弃那篇笔记请用它')
  }
  if (fs.existsSync(newAbs)) {
    throw new ZkError(`目标路径已被占用：${newRel}`, '改名不覆盖任何文件；先处理掉那个文件，或换一个名字')
  }

  // ── 入链：zk graph（活笔记）+ 根目录 meta 文件（不在图里）────────────
  const stems: StemIndex = new Map()
  try {
    for (const note of await allNotes(cfg, { includeArchived: true }, signal)) {
      const key = path.basename(note.path).replace(NOTE_EXT, '')
      const list = stems.get(key) ?? []
      list.push(note.absPath || path.join(cfg.notebook, note.path))
      stems.set(key, list)
    }
  } catch { /* 索引读不到时退化成只认根路径：少改几个，绝不多改 */ }

  // 归档里的笔记也会链向活笔记：改名不带上它们，会让历史入链静默断掉（lint 看不见归档）
  const graphSources = new Set<string>(await inboundSources(cfg, oldRel, signal, { includeArchived: true }))
  const sources = new Set<string>(graphSources)
  for (const name of META_NAMES) {
    try {
      if (fs.existsSync(path.join(cfg.notebook, name))) sources.add(name)
    } catch { /* 单个文件读不到不影响其它 */ }
  }

  const rewrittenLinks: RenameRewrite[] = []
  const missingLinks: string[] = []
  const pending: Array<{ abs: string; text: string }> = []
  const remap = new Map([[oldAbs, newAbs]])
  for (const source of sources) {
    const sourceAbs = path.join(cfg.notebook, source)
    let text: string
    try {
      text = fs.readFileSync(sourceAbs, 'utf8')
    } catch {
      if (graphSources.has(source)) missingLinks.push(source)
      continue
    }
    const out = relinkText(cfg, text, {
      sourceDir: path.dirname(sourceAbs),
      outDir: path.dirname(sourceAbs),
      remap,
      rebaseMarkdown: false,
      stems,
    })
    if (out.changed === 0) {
      // 图说它链过来了，正文里却找不到能识别的写法：可能写在代码块/奇怪语法里，交给人看
      if (graphSources.has(source)) missingLinks.push(source)
      continue
    }
    rewrittenLinks.push({ path: source, replaced: out.changed })
    if (!dryRun) pending.push({ abs: sourceAbs, text: out.text })
  }

  // ── 它自己的相对链接：换目录后同样的写法会指向别处 ──────────────────
  const selfRaw = fs.readFileSync(oldAbs, 'utf8')
  const self = relinkText(cfg, selfRaw, {
    sourceDir: path.dirname(oldAbs),
    outDir: path.dirname(newAbs),
    remap,
    rebaseMarkdown: true,
    stems,
  })

  if (!dryRun) {
    fs.mkdirSync(path.dirname(newAbs), { recursive: true })
    fs.renameSync(oldAbs, newAbs)
    if (self.changed > 0) fs.writeFileSync(newAbs, self.text, 'utf8')
    for (const item of pending) fs.writeFileSync(item.abs, item.text, 'utf8')
  }

  return {
    dryRun,
    performed: !dryRun,
    path: oldRel,
    newPath: newRel,
    rewrittenLinks,
    missingLinks,
    selfRewritten: self.changed,
  }
}

/** 把标签拼成 zk 认的 hashtags 行 */
export function withTags(content: string, tags: string[]): string {
  const body = String(content ?? '').replace(/\s+$/, '')
  if (!tags.length) return body
  const line = tags.map((t) => `#${t}`).join(' ')
  return body ? `${body}\n\n${line}` : line
}
