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

/** zk 自带的布尔过滤器（比在 JS 里重算更贴近 zk 的定义） */
export type FlagFilter = '--orphan' | '--tagless' | '--missing-backlink' | '--broken-links'

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
export async function graphEdges(cfg: Config, signal?: AbortSignal): Promise<GraphEdge[]> {
  const args = ['graph', '--quiet', '--format', 'json', '--limit', '10000']
  for (const name of excludedNames(cfg)) args.push('-x', name)
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
  /** frontmatter 的 type（走 `--extra type=`，模板里是 `{{extra.type}}`） */
  type?: string
  /** frontmatter 的 authority（走 `--extra authority=`） */
  authority?: string
}

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
): Promise<{ path: string; absPath: string; title: string }> {
  const title = input.title.trim()
  if (!title) throw new ZkError('标题不能为空')

  // flat 用的是 zk 默认的随机 {{id}} 文件名，按文件名查重永远不会命中；标题重复必须在建之前查。
  // layered 的 group 用 {{slug title}}，同一目录同名会被 zk 自己拒绝；不同目录允许同名（lint 会提示）。
  // 只查可见笔记（allNotes 已排除 raw/inbox/archive/meta）：归档里的旧结论可以复用标题。
  if (cfg.structure !== 'layered' && hasNotebook(cfg)) {
    const key = normalizeTitle(title)
    const existing = (await allNotes(cfg, {}, signal)).find((n) => normalizeTitle(n.title) === key)
    if (existing) {
      throw new ZkError(
        `同名笔记已存在：${existing.path}`,
        '换一个标题，或直接用 zk_read / zk_append 改那一篇；归档里的旧结论不参与查重，可以复用标题',
      )
    }
  }

  const dir = (input.dir ?? cfg.notesDir).replace(/^\/+/, '') || '.'
  // zk 解析相对目录用的是 cwd，不是笔记本 → 一律给绝对路径；
  // 先过 absPathOf：别在 zk 拒绝之前就把 `../..` 目录 mkdir 出去。
  const dirAbs = absPathOf(cfg, dir)
  assertWritablePath(cfg, dirAbs)
  fs.mkdirSync(dirAbs, { recursive: true })
  const before = new Set(fs.readdirSync(dirAbs))
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
  return { path: relPathOf(cfg, abs), absPath: abs, title }
}

export interface ArchivedTitleHit {
  path: string
  title: string
  /** supersede 时写下的原因；老笔记没写过就是空串 */
  reason: string
}

/**
 * 归档里同名的旧结论 —— 机械查重，不判断「是不是同一个错误」。
 *
 * zk_new 的标题查重只看活笔记，旧结论被 supersede 后标题就空出来了。允许复用，
 * 但要把 supersede-reason 一起带出来：重新提出同样的错误结论，通常从复用这个标题开始。
 * 查不到 / zk 跑不起来都返回空数组：这是提醒，不是写入前的硬门槛。
 */
export async function archivedSameTitle(
  cfg: Config,
  title: string,
  signal?: AbortSignal,
): Promise<ArchivedTitleHit[]> {
  const key = normalizeTitle(title)
  if (!key || !hasNotebook(cfg)) return []
  let notes: NoteRecord[]
  try { notes = await allNotes(cfg, { includeArchived: true }, signal) } catch { return [] }
  return notes
    .filter((n) => n.path === cfg.archiveDir || n.path.startsWith(`${cfg.archiveDir}/`))
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

/** 往一篇笔记末尾追加（自动补空行；可选先写一个二级标题） */
export function appendToNote(
  cfg: Config,
  p: string,
  text: string,
  opts: { heading?: string } = {},
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
  const sep = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  // 标题只占一行：换行会把后面的正文顶出小节
  const heading = opts.heading ? `## ${opts.heading.replace(/\s+/g, ' ').trim()}\n\n` : ''
  fs.appendFileSync(abs, `${sep}${heading}${body}\n`, 'utf8')
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

/** 往日记里追加一段（`## HH:MM` 小节） */
export function appendDaily(
  cfg: Config,
  p: string,
  entry: string,
  now: Date = new Date(),
): AppendResult {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return appendToNote(cfg, p, entry, { heading: `${hh}:${mm}` })
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
  /** archive/ 下的笔记文件数（磁盘为准：supersede 会把文件搬进去） */
  archived: number
  /** frontmatter status: superseded 的笔记数（含已归档的，以及手工标了但没搬的） */
  superseded: number
}

/** archive/ 下的全部 .md（磁盘扫描：归档区被排除在索引查询之外，只能直接看文件） */
function archivedFiles(cfg: Config): string[] {
  const root = path.resolve(cfg.notebook, cfg.archiveDir)
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch { return }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(abs)
    }
  }
  walk(root)
  return out
}

export async function notebookStats(cfg: Config, signal?: AbortSignal): Promise<NotebookStats> {
  const exclude = excludedNames(cfg).flatMap((name) => ['-x', name])
  const count = async (args: string[]): Promise<number> => {
    const out = await zk(cfg, ['list', '--quiet', '--no-pager', '--format', '{{path}}', ...exclude, ...args], { signal })
    return out.split('\n').filter((l) => l.trim()).length
  }
  const [notes, brokenLinks, orphans, live] = await Promise.all([
    count([]),
    count(['--broken-links']),
    count(['--orphan']),
    // 非归档区里被手工标成 superseded 的笔记（正常流程会搬进 archive，这里兜手滑）
    allNotes(cfg, {}, signal).catch(() => [] as NoteRecord[]),
  ])
  const archived = archivedFiles(cfg)
  const superseded = archived.filter((abs) => {
    try { return parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.status === 'superseded' }
    catch { return false }
  }).length + live.filter((n) => n.status === 'superseded').length
  // 标签数也从可见笔记汇总：zk tag list 没有 -x，直接用它会把 raw/inbox/archive/meta 的标签也算进来。
  const tags = new Set(live.flatMap((n) => n.tags)).size
  return { notes, tags, brokenLinks, orphans, archived: archived.length, superseded }
}

export async function indexNotebook(cfg: Config, signal?: AbortSignal): Promise<void> {
  await zk(cfg, ['index', '--quiet'], { signal, timeoutMs: 120_000 })
}

/** 指向某篇笔记的所有来源笔记（相对路径）—— 一次 `zk graph`，不按笔记逐个跑 */
async function inboundSources(cfg: Config, rel: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = []
  for (const edge of await graphEdges(cfg, signal)) {
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

/** 把标签拼成 zk 认的 hashtags 行 */
export function withTags(content: string, tags: string[]): string {
  const body = String(content ?? '').replace(/\s+$/, '')
  if (!tags.length) return body
  const line = tags.map((t) => `#${t}`).join(' ')
  return body ? `${body}\n\n${line}` : line
}
