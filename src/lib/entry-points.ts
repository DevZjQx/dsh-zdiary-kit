/**
 * R9：让 `MEMORY.md` 当检索入口（plan §11.2 / §14.2）。
 *
 * 口径：MEMORY 里每条活条目已经是「概念 → 入口」的卡片，条目里的 `[[来源]]` 就是入口。
 *
 * 两个方向，缺一不可：
 *   · `via: 'result'` —— 条目指向的那篇**本次命中了**：把「已晋升的结论」贴回结果（3.9.0 的语义）；
 *   · `via: 'query'`  —— **条目本身命中检索词**：来源不必在结果集里。这才是卢曼的索引方向
 *     （关键词 → 卡号 → 那张卡可以不含这个词）。原来的实现用 `byPath` 卡死，只做成了注解。
 *
 * 三条边界（与 §11.2 / §11.4 一致）：
 *   · 只做字符串解析，不做语义判断（哪条更相关是 agent 的活）；
 *   · 零子进程：`via: 'result'` 只用传进来的结果笔记建索引；`via: 'query'` 只在条目命中查询时
 *     多读一次那篇来源文件的 frontmatter（≤ MAX_ENTRY_POINTS 次本地读），**不扫全库、不调 zk**；
 *   · 解析失败 / 没有 MEMORY.md 一律降级为「不带这一栏」，不让检索整体失败，也不谎称 complete。
 *
 * 解析复用 lint / dream / memory 的同一份口径：`splitMemoryEntries` / `isRetiredEntry` / `WIKI_LINK` /
 * `resolveWikiTarget` —— 退役行不计（D3），显式写 `archive/` 的链接是「有意引用旧结论」，不算活入口。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import type { NoteRecord } from './zk.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { isMetaPath } from './meta.ts'
import { isRetiredEntry, splitMemoryEntries } from './memory-format.ts'
import { normalizeTitle, resolveWikiTarget, WIKI_LINK, wikiIndex } from './wikilink.ts'

/** 一次最多回显几条入口：结论清单是给人看的，不是第二份结果列表 */
export const MAX_ENTRY_POINTS = 5

/** MEMORY.md 里的一条活条目：首行（回显用）+ 它引用的全部目标 */
export interface MemoryEntry {
  /** 条目首行（压空白）；回显时原样给 agent，不截断成半句 */
  entry: string
  targets: string[]
}

/** 命中的入口：MEMORY 条目 + 它指向的那篇笔记 */
export interface EntryPoint {
  entry: string
  /** 落地后的标题；没落地时就是 MEMORY 里写的目标（`[[…]]` 里那一串） */
  title: string
  /** 笔记本相对路径；没落地时是空串（不编一个出来） */
  path: string
  /** 没落地时是空串 */
  absPath: string
  /**
   * `query` = 条目本身命中检索词（来源可以在结果集之外）；
   * `result` = 条目指向本次命中的笔记（结果集的注解）。
   */
  via: 'query' | 'result'
  /**
   * false = 条目是标题 / id 写法，而且那篇不在本批结果里：只给得出「入口名」。
   * 落地要一次 zk 查询（约 0.5 s / 10k），所以这里不代劳 —— 交给 agent 用 zk_walk / zk_search 跟进去。
   * 路径式 `[[notes/x]]` 是本地读盘，永远是 true。
   */
  resolved: boolean
}

export interface EntryPointsResult {
  points: EntryPoint[]
  /** true = 命中超过 MAX_ENTRY_POINTS，只回了前几条（§0.5 第 3 条：上限不许静默） */
  truncated: boolean
}

export interface EntryPointsOptions {
  /** 检索词：条目本身命中查询时，来源不必在结果集里也能当入口（plan §14.2） */
  query?: string
}

/** 中日韩文字：整串很难在条目里原样出现，补二元组让「同一术语」能对上 */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/**
 * 检索词 → 比对项。ASCII 按空格分词（≥2 码点），CJK 长串补二元组。
 * 只用于「这条结论跟你的查询是不是同一个话题」的机械判断，不参与排序、不影响结果集。
 */
export function queryTerms(query?: string): string[] {
  const q = normalizeTitle(String(query ?? ''))
  if (!q) return []
  const terms = new Set<string>()
  for (const word of q.split(/\s+/)) if ([...word].length >= 2) terms.add(word)
  for (const run of q.match(CJK_RUN) ?? []) {
    const chars = [...run]
    if (chars.length < 3) continue
    for (let i = 0; i + 1 < chars.length; i += 1) terms.add(chars[i]! + chars[i + 1]!)
  }
  return [...terms]
}

function matchesQuery(text: string, terms: string[]): boolean {
  if (!terms.length) return false
  const hay = normalizeTitle(text)
  return terms.some((term) => hay.includes(term))
}

/** raw / inbox / 根目录 meta 都不是可导航的笔记：入口指过去也没用 */
function isNonNotePath(cfg: Config, rel: string): boolean {
  if (isMetaPath(rel)) return true
  return ['raw', 'inbox'].some((dir) => rel === dir || rel.startsWith(dir + '/'))
}

/** 结果集之外的目标：只读这一篇的 frontmatter（0 子进程），读不到就不算入口 */
function liveNoteAt(cfg: Config, rel: string): { title: string; absPath: string } | null {
  const root = path.resolve(cfg.notebook)
  const abs = path.resolve(cfg.notebook, rel)
  if (!abs.startsWith(root + path.sep)) return null
  try {
    const fields = parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields
    const title = String(fields.title ?? '').trim() || path.basename(rel, path.extname(rel))
    return { title, absPath: abs }
  } catch {
    return null
  }
}

/**
 * 读 MEMORY.md：只留带 `[[链接]]` 的活条目（纯文字条目没有可解析的入口）。
 * 文件不在 / 读不了 → 空数组（老库与 0.9 之前的库照常检索）。
 */
export function liveMemoryEntries(cfg: Config): MemoryEntry[] {
  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'MEMORY.md'), 'utf8') } catch { return [] }
  if (!body.trim()) return []
  const out: MemoryEntry[] = []
  for (const entry of splitMemoryEntries(body)) {
    if (isRetiredEntry(entry)) continue
    const targets = [...entry.matchAll(WIKI_LINK)]
      .map((match) => String(match[1] ?? '').trim())
      .filter(Boolean)
    if (targets.length === 0) continue
    out.push({ entry: (entry.split('\n', 1)[0] ?? '').replace(/\s+/g, ' ').trim(), targets })
  }
  return out
}

/**
 * 本次检索的入口。两条来源（先查询命中，再结果命中），按 MEMORY 文件顺序，最多 MAX_ENTRY_POINTS 条：
 *   1. 条目本身命中 `query` → 目标不必在结果集里（路径式 `[[来源路径]]` 直接读盘；标题式仍要结果集里有）；
 *   2. 条目指向本次命中的笔记 → 结果集的注解。
 * 一条条目只取第一个能落地的目标；退役行 / 归档目标不计。
 */
export function entryPointsOf(
  cfg: Config,
  notes: Array<Pick<NoteRecord, 'title' | 'path' | 'absPath' | 'id'>>,
  opts: EntryPointsOptions = {},
): EntryPointsResult {
  const entries = liveMemoryEntries(cfg)
  if (entries.length === 0) return { points: [], truncated: false }
  const index = wikiIndex(notes)
  const byPath = new Map(notes.map((note) => [note.path, note]))
  const terms = queryTerms(opts.query)
  const out: EntryPoint[] = []
  const seen = new Set<string>()
  let matched = 0

  const add = (point: EntryPoint): void => {
    matched += 1
    if (out.length >= MAX_ENTRY_POINTS) return
    out.push(point)
    seen.add(point.entry)
  }

  // 1）查询命中的条目：来源可以在结果集之外 —— 这才是「入口」，不是注解
  if (terms.length) {
    for (const entry of entries) {
      if (seen.has(entry.entry)) continue
      if (!matchesQuery(entry.entry, terms)) continue
      for (const target of entry.targets) {
        const hit = resolveWikiTarget(cfg, target, index)
        if (hit.status === 'archived') continue // 废弃结论归死胡同探针，不当活入口
        if (hit.status === 'live') {
          if (isNonNotePath(cfg, hit.path)) continue
          const known = byPath.get(hit.path)
          if (known) {
            add({ entry: entry.entry, title: known.title || hit.path, path: hit.path, absPath: known.absPath, via: 'query', resolved: true })
            break
          }
          const disk = liveNoteAt(cfg, hit.path)
          if (disk) {
            add({ entry: entry.entry, title: disk.title, path: hit.path, absPath: disk.absPath, via: 'query', resolved: true })
            break
          }
          continue
        }
        // 标题 / id 写法且不在本批结果里：只给入口名，不为了补一次路径再起一个 zk 进程。
        // 落地交给 `zk_walk <标题>` —— 卢曼的索引给的本来也是卡号，不是卡片。
        if (isNonNotePath(cfg, target)) continue
        add({ entry: entry.entry, title: target, path: '', absPath: '', via: 'query', resolved: false })
        break
      }
    }
  }

  // 2）指向本次命中的条目：结果集的注解（3.9.0 的语义，保持不变）
  for (const entry of entries) {
    if (seen.has(entry.entry)) continue
    for (const target of entry.targets) {
      const hit = resolveWikiTarget(cfg, target, index)
      if (hit.status !== 'live') continue
      const note = byPath.get(hit.path)
      if (!note) continue
      add({ entry: entry.entry, title: note.title || note.path, path: note.path, absPath: note.absPath, via: 'result', resolved: true })
      break
    }
  }

  return { points: out, truncated: matched > out.length }
}
