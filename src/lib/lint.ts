/**
 * 巡检（M3）：只报告，不改任何笔记（计划 §3 D5）。
 *
 * 一次 `zk list` 拿全量，再用 zk 原生的两个过滤器（孤儿 / 断链）各跑一次进程，外加一次 `zk graph` 拿全库的边；
 * 「陈旧」「重名」「单向链接」在 JS 里算。200 条笔记上 5 次进程就够 —— 不允许按笔记逐条跑 zk。
 *
 * 「陈旧」为什么自己算：zk 的 `stale` 不是内置过滤器，`zk list stale` 只在你自己的
 * `[filter]` 里定义过才存在（Z3 只说了位置参数语法，没说它是内置的）。所以阈值由插件定。
 *
 * 孤儿与无标签**不含日记**：日记按天写，天然没有入链、也没有标签，
 * 全报出来只会把真正的问题（断链、单向链接）淹掉。断链仍包含日记 —— 那里出错是真问题。
 *
 * 「单向链接」为什么自己算：zk 的 `--missing-backlink` 是「至少有一条单向链接」（S 链 X、X 不回链），
 * 而日记天然是一串出边 —— 日记提过的每篇笔记都会常年挂在桶里。那不是「笔记没接上」，是正常的引用方向。
 * 所以改成在 `zk graph` 的边上算，只报**非日记来源**的单向链接。
 *
 * 解析失败单列一桶：frontmatter 写坏（典型是 `tags: [#你好世界]`，`#` 不是 tag 前缀）时
 * zk 只在 stderr 吭一声就跳过那篇，它于是从索引里消失 —— 搜不到，也不进上面任何一个桶。
 * 不单独报出来，用户只会看到「邻居突然孤儿、突然断链」，永远查不到根因。
 *
 * 记忆层（MEMORY.md / USER.md）的 `[[来源]]` 单列一项：它们不进索引，supersede 也不会重写，
 * 旧结论搬进 archive/ 之后链接会静默停在旧路径 —— 断链、孤儿、单向链接都统计不到。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import type { GraphEdge, NoteRecord } from './zk.ts'
import { allNotes, graphEdges, localDate, MAX_SCAN, notesWithFlag, parseErrorWarnings } from './zk.ts'
import { normalizeTitle, resolveWikiTarget, WIKI_LINK, wikiIndex } from './wikilink.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { daysSinceDate, entryDate, isRetiredEntry, splitMemoryEntries } from './memory-format.ts'
import type { FrontmatterFields } from './frontmatter.ts'
import { AGENTS_TEMPLATE, AGENTS_TEMPLATE_FLAT, TEMPLATE_VERSION } from './agents-template.ts'
import { PERSONA_TEMPLATE_VERSION, POLICY_TEMPLATE_VERSION } from './persona-template.ts'

/** 每类最多回多少条（计划 §4 M3）；总数另给 */
export const MAX_ITEMS = 50

export interface LintEntry {
  title: string
  path: string
}

export interface LintStaleEntry extends LintEntry {
  /** 最后一次修改的日期（YYYY-MM-DD） */
  modified: string
}

export interface LintParseEntry {
  path: string
  reason: string
}

export interface LintParseBucket {
  total: number
  items: LintParseEntry[]
}

export interface LintBucket {
  total: number
  items: LintEntry[]
}

export interface LintStaleBucket {
  total: number
  items: LintStaleEntry[]
}

export interface LintDuplicateBucket {
  total: number
  items: Array<{ title: string; paths: string[] }>
}

/** 疑似重复（改一两个字）：与全等重名分开报，避免确定的问题和猜测混在一起 */
export interface LintSimilarGroup {
  titles: string[]
  paths: string[]
  /**
   * 字符二元组 Jaccard（0–1）；「短串被长串包含」命中时按下限 0.6 记 ——
   * 否则 0.5 的分数会让「已经报了」看起来自相矛盾。
   */
  score: number
}

export interface LintSimilarBucket {
  total: number
  /** true = 候选太多只看了一部分 / 笔记扫描触顶：只漏报，不误报 */
  truncated: boolean
  items: LintSimilarGroup[]
}

export interface LintOneWayEntry extends LintEntry {
  /** 没有回链的来源（笔记本相对路径）；一个目标可以有多条。linksOnly 时只含 Links 小节来源 */
  from: string[]
  /** 来源把链接写在哪：links = `## Links` / `## 链接` 小节，body = 正文引用，mixed = 两者都有；linksOnly 时恒为 links */
  where: 'links' | 'body' | 'mixed'
}

export interface LintOneWayBucket {
  /** 缺回链的**目标笔记数**（不是边数） */
  total: number
  /** 单向边数：一个目标可能被多条边指向 */
  edges: number
  /** 正文引用的单向边数；linksOnly 时这些边只计数、不列出 */
  bodyOnly: number
  /** true = 只列 Links 小节的单向边（正文引用只进 bodyOnly） */
  linksOnly: boolean
  /**
   * true = `zk graph` 的笔记载入触到上限（`--limit` 数的是笔记），边集可能不完整。
   * 与 `truncated`（笔记扫描）不同：那边少一篇只会漏报，这边**缺一条回链边就会把双向误判成单向**。
   */
  edgesTruncated: boolean
  items: LintOneWayEntry[]
}

export interface LintMemoryLink {
  /** 哪个 meta 文件里的链接（MEMORY.md / USER.md） */
  source: string
  /** 链接所在条目的首行（压空白后最多 100 字，方便定位） */
  entry: string
  /** `[[...]]` 里的目标 */
  link: string
  /** missing = 文件不存在；superseded = 已归档 / 已标废弃 */
  reason: 'missing' | 'superseded'
  /** 命中路径（superseded 时指向归档位置；missing 时为空串） */
  path: string
}

export interface LintMemoryStale {
  /** 条目首行（压空白后最多 100 字） */
  entry: string
  /** 条目里的日期（YYYY-MM-DD） */
  date: string
  age: number
}

export interface LintMemoryBucket {
  /** 实际读到的记忆文件数（0 = 还没启用记忆层，不报这一项） */
  files: number
  /** 扫到的 `[[链接]]` 总数 */
  links: number
  /** 失效链接数 */
  total: number
  /** 没有任何 `[[链接]]` 的列表条目数（无法核对） */
  unlinked: number
  /** MEMORY.md 里首行没有 `YYYY-MM-DD` 的条目数（P1-3；退役行不计） */
  undated: number
  /** 以 `- [superseded …]` 开头的退役条目数（只报告；注入从 0.9 起省略它们） */
  retired: number
  /** 退役行里的 `→ [[新结论]]` 解析不到活笔记的条数 */
  retiredBroken: number
  /** 有日期但超过阈值没复核的条目（D5.1）：只报告，不判断还有没有用 */
  stale: { total: number; staleDays: number; items: LintMemoryStale[] }
  items: LintMemoryLink[]
}

export interface LintIncompleteEntry {
  path: string
  /** 缺的字段名（type / status / authority） */
  missing: string[]
}

export interface LintIncompleteBucket {
  total: number
  /** true = 笔记扫描触到上限，这一桶只覆盖了载入的那些 */
  truncated: boolean
  /** 按缺哪个字段分别计数（一条可以同时缺多个） */
  byField: { type: number; status: number; authority: number }
  items: LintIncompleteEntry[]
}

export interface LintTagGroup {
  /** 忽略大小写后同形的标签（按出现次数降序） */
  variants: string[]
  total: number
}

export interface LintTagBucket {
  /** 不同标签的总数 */
  total: number
  /** false = 标签少于阈值，不做卫生检查（小库的噪音没有价值） */
  reported: boolean
  caseVariants: { total: number; items: LintTagGroup[] }
  singletons: { total: number; items: string[] }
}

export interface LintTemplateBucket {
  /** 根目录是否有 AGENTS.md */
  present: boolean
  /** 0 = 没有版本标记（旧模板 / 手写） */
  version: number
  current: number
  /** true = 有 AGENTS.md，但版本不是当前模板 */
  stale: boolean
  /**
   * `version < current`（旧版 / 无标记）时给出当前结构对应的模板全文。
   *
   * 为什么塞进结果：插件装进 DSH 后，docs 在 profile 的 node_modules 里，agent 的 Read 未必够得着
   * （工作区外的读会被策略拦掉），而旧通知里的相对路径会逼它先搜几次。模板全文跟着工具结果走，
   * 模型一次就能拿到要合并的内容，不依赖任何文件路径。
   *
   * `version > current` 时不给：那说明用户升过更新的插件（或手写了更高标记），这时插件才是旧的那个，
   * 把当前版本的模板递过去等于让 agent 把规则改回去。
   */
  currentText?: string
}

/** 契约体检（M1：missing / old / placeholder；policy 表结构等 M3 的 policy.ts） */
export interface LintContractIssue {
  file: 'PERSONA.md' | 'POLICY.md'
  kind: 'missing' | 'old' | 'placeholder'
  /** 人读说明（old 带当前 / 盘上版本；placeholder 带占位符清单） */
  detail: string
}

export interface LintContractBucket {
  total: number
  items: LintContractIssue[]
}

export interface LintOptions {
  /** 多少天没修改算陈旧（默认 90） */
  staleDays?: number
  /** 只报 Links 小节的单向链接；正文引用只计数（默认 false = 全报） */
  linksOnly?: boolean
  /** 测试用；默认 now */
  now?: Date
}

export interface LintResult {
  notebook: string
  /** 参与巡检的笔记数（已排除 raw / inbox / archive / meta 文件） */
  notes: number
  /**
   * true = 笔记扫描触到上限，结果不完整：只会漏报，不会误报（别当成「只有这些问题」）。
   * 边截断是另一回事，见 `oneWayLinks.edgesTruncated`。
   */
  truncated: boolean
  staleDays: number
  /** zk 解析不了 frontmatter 的笔记：它们不在索引里，下面各桶都统计不到 */
  parseErrors: LintParseBucket
  orphans: LintBucket
  brokenLinks: LintBucket
  stale: LintStaleBucket
  tagless: LintBucket
  /** S 链 X、X 不回链，且 S 不是日记（日记天然是出边，不算没接上）；items 是 X，from 是 S */
  oneWayLinks: LintOneWayBucket
  duplicateTitles: LintDuplicateBucket
  /** 标题只差一两个字（疑似同一结论写了两遍）：只报告，合并由人裁决 */
  similarTitles: LintSimilarBucket
  /** 记忆层体检：MEMORY.md / USER.md 里的 `[[来源]]` 是否还指向活笔记 */
  memoryLinks: LintMemoryBucket
  /** frontmatter 缺 type / status / authority 的笔记（只报告，不替人补） */
  incomplete: LintIncompleteBucket
  /** 标签卫生：大小写变体与单例（总数 ≥ 30 才报） */
  tags: LintTagBucket
  /** 根目录 AGENTS.md 是不是当前版本的模板（只报告，不覆盖） */
  template: LintTemplateBucket
  /** 契约层体检：PERSONA.md / POLICY.md 缺失 / 旧版 / 未填占位符（只报告） */
  contract: LintContractBucket
  /**
   * 非日记笔记已到 150 篇、根目录却没有 INDEX.md（P2-11）：只是提示，不生成静态索引。
   * 实时分布看 zk_stats（byDir / byTag），静态索引会过期、还要决定谁负责更新。
   * 日记不计入：它按天自动增长，一年就能把任何库顶到 150 篇，可知识量并没有涨。
   */
  indexHint: boolean
}

/** 标题归一化与链接解析在 `lib/wikilink.ts`（dream 也用同一套）；这里保留导出，免得调用方跟着搬 */
export { normalizeTitle }

/** 同一标题出现在多篇里（slug 命名下不同目录可以同名，检索时容易挑错） */
export function duplicateTitles(notes: NoteRecord[], max = MAX_ITEMS): LintDuplicateBucket {
  const groups = new Map<string, { title: string; paths: string[] }>()
  for (const note of notes) {
    const key = normalizeTitle(note.title || path.basename(note.path, path.extname(note.path)))
    if (!key) continue
    const hit = groups.get(key)
    if (hit) hit.paths.push(note.path)
    else groups.set(key, { title: note.title || key, paths: [note.path] })
  }
  const dup = [...groups.values()].filter((g) => g.paths.length > 1)
  dup.sort((a, b) => b.paths.length - a.paths.length || a.title.localeCompare(b.title))
  return { total: dup.length, items: dup.slice(0, max) }
}

/** 相似标题的判定：字符二元组 Jaccard 下限；短串被长串包含时另算（短串至少 6 字） */
const SIMILAR_RATIO = 0.6
const SIMILAR_SHORT = 6
/** 同目录最多两两比较多少篇：超过就截断并置 truncated，别让 1 万篇变成 O(n²) */
const SIMILAR_GROUP_MAX = 300

/** 比较用的标题：NFKC → 小写 → 去标点 / 空白。中文不改字，只抹掉排版差异 */
function similarKey(title: string): string {
  return String(title ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigrams(key: string): Set<string> {
  const chars = [...key]
  const out = new Set<string>()
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
  if (out.size === 0 && chars.length > 0) out.add(chars[0])
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * 疑似重复标题（P2-10）：精确查重只能挡住手滑 —— 中文改两个字就绕过去了。
 *
 * 纯机械：NFKC + 去标点后按字符二元组算 Jaccard ≥ 0.6，或短串（≥ 6 字）被长串包含。
 * 只在**同目录**内比较（不同目录的同名本来允许）；全等标题留给 duplicateTitles，这里不重复报。
 * 只报告：`zk_new` 不用它拦人，误报会挡住正常写作。
 *
 * 日记不进来（由调用方按 `isDaily` 过滤）：标题就是日期，`2026-10-01` 与 `2026-10-02`
 * 的二元组 Jaccard 是 0.86 —— 一年日记会吐出上千组「疑似重复」，真问题全被淹掉。
 * 纯数字标题（日期 / 编号）同样跳过：那是「按天 / 按号」的记录，不是同一个结论写了两遍。
 */
export function similarTitles(notes: NoteRecord[], scanTruncated: boolean, max = MAX_ITEMS): LintSimilarBucket {
  // size 一律按码点算（`[...key].length`），不混用 `.length`：后者数的是 UTF-16 单元，
  // 标题里带 emoji / 扩展区汉字时会比码点多一倍，「谁是短串」会判错。
  interface Item { title: string; path: string; key: string; exact: string; grams: Set<string>; size: number }
  const groups = new Map<string, Item[]>()
  for (const note of notes) {
    const title = note.title || path.basename(note.path, path.extname(note.path))
    const key = similarKey(title)
    if (!key) continue
    // 纯数字：日期 / 编号类标题，相似度只反映「数字挨着」，不反映重复结论
    if (/^\d+$/.test(key)) continue
    const dir = path.posix.dirname(note.path)
    const list = groups.get(dir) ?? []
    list.push({ title, path: note.path, key, exact: normalizeTitle(title), grams: bigrams(key), size: [...key].length })
    groups.set(dir, list)
  }

  let truncated = scanTruncated
  const found: LintSimilarGroup[] = []
  for (const group of groups.values()) {
    let list = group
    if (list.length > SIMILAR_GROUP_MAX) {
      truncated = true
      list = list.slice(0, SIMILAR_GROUP_MAX)
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        // 归一化后完全一样：那是 duplicateTitles 的活（这里报会让同一件事出现两遍）
        if (a.exact === b.exact) continue
        // 短标题的二元组太少（RAG / RAG 2 会算出 0.67），噪声大于信号
        if (a.size < 4 || b.size < 4) continue
        let score = jaccard(a.grams, b.grams)
        let hit = score >= SIMILAR_RATIO
        if (!hit) {
          const [short, long, shortSize] = a.size <= b.size ? [a.key, b.key, a.size] : [b.key, a.key, b.size]
          if (shortSize >= SIMILAR_SHORT && long.includes(short)) {
            hit = true
            score = SIMILAR_RATIO
          }
        }
        if (!hit) continue
        found.push({
          titles: [a.title, b.title],
          paths: [a.path, b.path],
          score: Math.round(score * 100) / 100,
        })
      }
    }
  }
  found.sort((a, b) => b.score - a.score || a.paths[0].localeCompare(b.paths[0]))
  return { total: found.length, truncated, items: found.slice(0, max) }
}

/** 注入的三份 meta 里只有 MEMORY / USER 会写来源链接；AGENTS 是规则，不查 */
const MEMORY_LINK_FILES = ['MEMORY.md', 'USER.md'] as const

/** 按列表条目切分（含缩进续行）：只有条目才谈得上「没附来源」 */
function collapse(text: string, max = 100): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

export interface MemoryIssueOptions {
  /** 失效链接最多回几条（默认 MAX_ITEMS） */
  max?: number
  /** 多少天没复核算陈旧（默认 90；与笔记陈旧同一套阈值） */
  staleDays?: number
  /** 测试用；默认 now */
  now?: Date
}

/**
 * 记忆层体检：MEMORY.md / USER.md 里的 `[[来源]]` 是否还指向活笔记。
 *
 * 为什么必须有这一项：supersede 只重写 `zk graph` 里的入链，而 meta 文件被 `excludedNames`
 * 排除在图外 —— MEMORY.md 里的链接不会跟着搬，broken-links 也看不见它。记忆说 X、库里 X 已废弃，
 * 这是记忆层与事实层脱节最典型的一种。
 *
 * 纯机械解析：路径优先（原路径 → 加 .md → archive/ 下同名），退而按标题/文件名匹配**活笔记**；
 * 归档标题不反查 —— 归档默认不进检索，这里再造一套索引就成了第二真相。「语义重复」也不查。
 */
export function memoryLinkIssues(cfg: Config, notes: NoteRecord[], opts: MemoryIssueOptions = {}): LintMemoryBucket {
  const max = opts.max ?? MAX_ITEMS
  const staleDays = Math.min(3650, Math.max(1, Math.trunc(opts.staleDays ?? 90)))
  const now = opts.now ?? new Date()
  const index = wikiIndex(notes)

  const items: LintMemoryLink[] = []
  const staleItems: LintMemoryStale[] = []
  const seen = new Set<string>()
  let files = 0
  let links = 0
  let unlinked = 0
  let undated = 0
  let retired = 0
  let retiredBroken = 0
  let staleTotal = 0

  for (const name of MEMORY_LINK_FILES) {
    let body = ''
    try { body = fs.readFileSync(path.join(cfg.notebook, name), 'utf8') } catch { continue }
    files += 1

    for (const line of body.split('\n')) {
      for (const match of line.matchAll(WIKI_LINK)) {
        links += 1
        const target = String(match[1] ?? '').trim()
        // `[[   ]]` 这种空目标不是链接，也不该算「失效」：解析器对它返回 missing
        if (!target) continue
        const resolved = resolveWikiTarget(cfg, target, index)
        // 显式写 archive/ 路径的链接是有意引用旧结论（supersede 重写入链就是这个形状），不算漂移
        if (resolved.status === 'live' || resolved.explicit) continue
        const issue = { reason: resolved.status === 'archived' ? 'superseded' : 'missing', path: resolved.path } as const
        const key = `${name}\u0000${target}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({ source: name, entry: collapse(line), link: target, reason: issue.reason, path: issue.path })
      }
    }

    // 只对 MEMORY.md 数「没附来源 / 没日期 / 退役 / 陈旧」：USER.md 是偏好清单，大多数条目本来就没有来源
    if (name === 'MEMORY.md') {
      for (const entry of splitMemoryEntries(body)) {
        const first = entry.split('\n', 1)[0] ?? ''
        if (!entry.includes('[[')) unlinked += 1
        // 退役行：磁盘保留、注入从 0.9 起省略（D3），只核对它指向的新结论是否还活着
        if (isRetiredEntry(entry)) {
          retired += 1
          const next = /→\s*\[\[([^\]|#]+)/.exec(entry)
          const resolved = next ? resolveWikiTarget(cfg, String(next[1] ?? '').trim(), index) : null
          if (!resolved || resolved.status !== 'live') retiredBroken += 1
          continue
        }
        // 日期要真校验：`2026-99-99` 既不算「有日期」，也不该在陈旧里报一次
        const date = entryDate(entry)
        if (!date) {
          undated += 1
          continue
        }
        const age = daysSinceDate(date, now)
        if (age !== null && age > staleDays) {
          staleTotal += 1
          if (staleItems.length < max) staleItems.push({ entry: collapse(first), date, age })
        }
      }
    }
  }

  return {
    files,
    links,
    total: items.length,
    unlinked,
    undated,
    retired,
    retiredBroken,
    stale: { total: staleTotal, staleDays, items: staleItems },
    items: items.slice(0, max),
  }
}

/**
 * 一行「记忆链接」摘要：`zk-kit lint` 与 `zk_lint` 共用，免得两处各写一遍文案、
 * 下次改措辞只改到一半。返回 null = 这个库还没启用记忆层（files = 0），不占一行。
 */
export function formatMemoryLinks(bucket: LintMemoryBucket): string | null {
  if (bucket.files === 0) return null
  const parts: string[] = []
  if (bucket.total > 0) {
    const sample = bucket.items.slice(0, 3).map((i) => {
      const why = i.reason === 'superseded' ? '已废弃' + (i.path ? ` → ${i.path}` : '') : '不存在'
      return `${i.source} [[${i.link}]]（${why}）`
    }).join('、')
    parts.push(`${bucket.total} 条失效 — ${sample}${bucket.total > 3 ? ' …' : ''}`)
  } else {
    parts.push(bucket.links > 0 ? `${bucket.links} 条都可核对` : 'MEMORY.md / USER.md 里没有 [[来源链接]]')
  }
  if (bucket.unlinked > 0) parts.push(`${bucket.unlinked} 个条目没附来源链接`)
  if (bucket.undated > 0) parts.push(`${bucket.undated} 个条目没写日期（YYYY-MM-DD）`)
  if (bucket.retired > 0) {
    parts.push(bucket.retiredBroken > 0
      ? `${bucket.retired} 条已退役，其中 ${bucket.retiredBroken} 条的新结论不是活笔记`
      : `${bucket.retired} 条已退役`)
  }
  if (bucket.stale.total > 0) parts.push(`${bucket.stale.total} 条超过 ${bucket.stale.staleDays} 天未复核`)
  return `${bucket.total === 0 && bucket.retiredBroken === 0 ? '✓' : '✗'} 记忆链接：${parts.join('｜')}`
}

/**
 * 三个后加的桶（缺字段 / 标签卫生 / 模板版本）的文案，同样只写一份：
 * `zk-kit lint` 与 `zk_lint` 各写一遍就会改到一半。返回空数组 = 这一库三项都没问题，不占行。
 */
export function formatLintExtras(
  r: Pick<LintResult, 'incomplete' | 'tags' | 'template' | 'contract' | 'similarTitles' | 'indexHint'>,
): string[] {
  const lines: string[] = []
  // 两份都没有 = 契约未启用（默认状态）：不报错、不占行。只启用一半（缺一份）或
  // 有旧版 / 占位符时才提醒 —— 否则每个老库每次 lint 都多一条永久 ⚠️，反而训练人忽略告警。
  const missing = r.contract.items.filter((i) => i.kind === 'missing')
  const bothMissing = missing.length > 1 && missing.length === r.contract.items.length
  if (!bothMissing && r.contract.items.length > 0) {
    lines.push(
      `⚠️ 契约：${r.contract.items.map((i) => `${i.file} ${i.detail}`).join('；')}` +
      '｜只报告：缺一份 = 尚未启用完整契约，占位符与旧版由人按需处理',
    )
  }
  if (r.incomplete.total > 0) {
    lines.push(
      `✗ frontmatter 缺字段：${r.incomplete.total} 篇 — ` +
      r.incomplete.items.slice(0, 5).map((i) => `${i.path}（缺 ${i.missing.join('/')}）`).join('、') +
      (r.incomplete.total > 5 ? ' …' : '') +
      '｜缺失被索引落成空串，status / authority 的机械门对它们静默失效',
    )
  }
  if (r.tags.reported) {
    const cv = r.tags.caseVariants
    const sg = r.tags.singletons
    lines.push(cv.total === 0
      ? `✓ 标签卫生：${r.tags.total} 个标签，没有大小写变体；单例 ${sg.total} 个` +
        (sg.items.length ? `（${sg.items.slice(0, 5).join('、')}）` : '')
      : `✗ 标签卫生：${cv.total} 组大小写变体 — ` +
        cv.items.slice(0, 3).map((g) => `${g.variants.join(' / ')}（${g.total}）`).join('；') +
        `；单例 ${sg.total} 个`)
  }
  if (r.template.stale) {
    const t = r.template
    if (t.version > t.current) {
      // 插件比库旧（用户降级过插件 / 手写了更高标记）：给旧模板等于让 agent 把规则改回去
      lines.push(
        `⚠️ AGENTS.md 的模板版本比插件新（v${t.version} > 当前 v${t.current}）—— ` +
        '插件是旧的那个，别改文件去配它；升级插件后再看。这里不给旧模板，免得把规则改回去。',
      )
    } else {
      lines.push(
        `⚠️ AGENTS.md 是${t.version === 0 ? '旧版 / 无版本标记' : `旧版模板 v${t.version}`}` +
        `（当前 v${t.current}）—— 只报告，不覆盖。` +
        (t.currentText
          ? `新版模板全文如下：按需合并，别整篇覆盖你改过的规则；合并后把首行标记更新为 v${t.current}。`
          : ''),
      )
      if (t.currentText) {
        lines.push('--- 新版模板开始 ---')
        lines.push(t.currentText.trimEnd())
        lines.push('--- 新版模板结束 ---')
      }
    }
  }
  if (r.similarTitles.total > 0) {
    const sample = r.similarTitles.items.slice(0, 3)
      .map((g) => `「${g.titles[0]}」/「${g.titles[1]}」（${g.score.toFixed(2)}）`)
      .join('；')
    lines.push(
      `⚠️ 疑似重复标题：${r.similarTitles.total} 组 — ${sample}` +
      (r.similarTitles.total > 3 ? ' …' : '') +
      '｜只报告，合并由人裁决',
    )
  }
  if (r.indexHint) {
    lines.push('· 笔记已到 150 篇（不含日记）：根目录还没有 INDEX.md —— 需要总索引时再建（zk_stats 有实时目录 / 标签分布）')
  }
  return lines
}

/**
 * 单向链接的目标：存在 S→X，但 X 没有回链 S（zk `--missing-backlink` 的原义）。
 * 不用 zk 的过滤器，因为它没法排除「来源是日记」的边 —— 日记按天写、天然是一串出边，
 * 要求每篇被提过的笔记回链日记只会让这个桶常年清零不了，跟「笔记没接上」是两回事。
 * 返回 X 和它的来源 S；指向索引外笔记的边直接丢掉（不做 cwd 兜底解析）。
 * 同一对 S→X 写多次只算一条边；snippetStart 留给调用方判断写在正文还是 Links 小节。
 */
export interface OneWayLink {
  /** 目标笔记（笔记本相对路径） */
  target: string
  /** 没回链的来源；每个来源一条，snippetStarts 是它在源文件里的字节偏移 */
  from: Array<{ path: string; snippetStarts: number[] }>
}

export function oneWayLinks(
  edges: GraphEdge[],
  notes: NoteRecord[],
  skipSource: (path: string) => boolean,
): OneWayLink[] {
  const linked = new Set(edges.map((e) => e.sourcePath + '\u0000' + e.targetPath))
  const byPath = new Map(notes.map((n) => [n.path, n]))
  const out = new Map<string, Map<string, number[]>>()
  for (const edge of edges) {
    if (edge.sourcePath === edge.targetPath) continue
    if (skipSource(edge.sourcePath)) continue
    if (linked.has(edge.targetPath + '\u0000' + edge.sourcePath)) continue
    if (!byPath.has(edge.targetPath)) continue
    const sources = out.get(edge.targetPath) ?? new Map<string, number[]>()
    const starts = sources.get(edge.sourcePath) ?? []
    starts.push(edge.snippetStart)
    sources.set(edge.sourcePath, starts)
    out.set(edge.targetPath, sources)
  }
  return [...out].map(([target, sources]) => ({
    target,
    from: [...sources]
      .map(([source, snippetStarts]) => ({ path: source, snippetStarts }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  }))
}

/** 模板承诺的四个字段里，这三个是机械规则的前提（title 由文件名兜底，不查） */
const REQUIRED_FIELDS = ['type', 'status', 'authority'] as const

/**
 * frontmatter 缺字段（P2-13）：`toRecord` 把缺失的 status / type / authority 一律落成空串，
 * 于是「没写 authority」=「authority 正常」—— dream 的 informal 门对它们静默失效。
 * 索引里区分不出「没写」与「空值」，只能逐篇读 frontmatter；代价是 O(n) 次读盘，
 * 护栏是只读 live 且非日记，扫描触到上限时置 truncated。
 *
 * 只在 layered 下检查：flat 的笔记本来就不写这三个字段（没有 group / 模板），
 * 对它报这一桶等于把整个库标红，那就不是「可发现的状态」而是噪音。
 */
export function incompleteFrontmatter(
  cfg: Config,
  notes: NoteRecord[],
  skip: (rel: string) => boolean,
  scanTruncated: boolean,
  max = 20,
): LintIncompleteBucket {
  const byField = { type: 0, status: 0, authority: 0 }
  const items: LintIncompleteEntry[] = []
  let total = 0
  for (const note of notes) {
    if (skip(note.path)) continue
    let fields: FrontmatterFields
    try {
      fields = parseFrontmatter(fs.readFileSync(path.resolve(cfg.notebook, note.path), 'utf8')).fields
    } catch {
      continue
    }
    const missing = REQUIRED_FIELDS.filter((key) => !String(fields[key] ?? '').trim())
    if (!missing.length) continue
    total += 1
    for (const key of missing) byField[key] += 1
    if (items.length < max) items.push({ path: note.path, missing })
  }
  return { total, truncated: scanTruncated, byField, items }
}

/** 小库不查标签卫生：20 个标签里出现几个单例是正常的，报出来只是噪音 */
const TAG_MIN = 30

/**
 * 标签卫生（P2-14）：标签是中文召回的补丁，补丁自己的卫生没人看。
 * 大小写变体纯机械可判（`#Agent` / `#agent`），单例标签是「写了一次就再没出现」的那批。
 * 只报告，不合并 —— 在别的库里它们可能就是两个概念，裁决留给人。
 */
export function tagHygiene(notes: NoteRecord[], max = 20): LintTagBucket {
  const counts = new Map<string, number>()
  for (const note of notes) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const tags = [...counts.keys()]
  if (tags.length < TAG_MIN) {
    return { total: tags.length, reported: false, caseVariants: { total: 0, items: [] }, singletons: { total: 0, items: [] } }
  }
  const groups = new Map<string, string[]>()
  for (const tag of tags) {
    const key = tag.toLowerCase()
    const list = groups.get(key) ?? []
    list.push(tag)
    groups.set(key, list)
  }
  const variants = [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      group.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
      return { variants: group, total: group.reduce((sum, tag) => sum + (counts.get(tag) ?? 0), 0) }
    })
    .sort((a, b) => b.total - a.total || a.variants[0].localeCompare(b.variants[0]))
  const singletons = tags.filter((tag) => counts.get(tag) === 1).sort((a, b) => a.localeCompare(b))
  return {
    total: tags.length,
    reported: true,
    caseVariants: { total: variants.length, items: variants.slice(0, max) },
    singletons: { total: singletons.length, items: singletons.slice(0, 10) },
  }
}

const TEMPLATE_MARK_RE = /<!--\s*zdiary-template:\s*v(\d+)\s*-->/
const PERSONA_MARK_RE = /<!--\s*zdiary-persona:\s*v(\d+)\s*-->/
const POLICY_MARK_RE = /<!--\s*zdiary-policy:\s*v(\d+)\s*-->/
const PLACEHOLDER_RE = /\{\{\s*[^}]+\s*\}\}/g

/**
 * 契约体检（M1）：缺文件 = 未启用（不算错，但要让 zk_lint 可见）；
 * 旧版 = 版本标记比当前模板旧（只报告，不覆盖 —— 契约允许人改）；
 * 占位符 = 模板里的 {{...}} 还没填（“未填”是机械可发现的“未启用一半”状态）。
 */
export function contractStatus(cfg: Config): LintContractBucket {
  const items: LintContractIssue[] = []
  const files = [
    { name: 'PERSONA.md', mark: PERSONA_MARK_RE, current: PERSONA_TEMPLATE_VERSION },
    { name: 'POLICY.md', mark: POLICY_MARK_RE, current: POLICY_TEMPLATE_VERSION },
  ] as const
  for (const f of files) {
    let body = ''
    try { body = fs.readFileSync(path.join(cfg.notebook, f.name), 'utf8') } catch {
      items.push({ file: f.name, kind: 'missing', detail: '根目录没有这份文件（zk-kit init --with-contract 或设置页可写入模板）' })
      continue
    }
    const hit = f.mark.exec(body)
    const version = hit ? Number(hit[1]) : 0
    if (version !== f.current) {
      items.push({
        file: f.name,
        kind: 'old',
        detail: version === 0
          ? `没有版本标记（当前 v${f.current}）`
          : `是旧版 v${version}（当前 v${f.current}）`,
      })
    }
    const placeholders = [...new Set(body.match(PLACEHOLDER_RE) ?? [])]
    if (placeholders.length > 0) {
      items.push({ file: f.name, kind: 'placeholder', detail: `还有未填的占位符：${placeholders.join('、')}` })
    }
  }
  return { total: items.length, items }
}

/**
 * 模板版本（P2-15）：模板是行为契约，不是静态文档 —— 它每轮注入，写错一句就是每轮都在执行错规则。
 * 但模板允许用户改，不能自动覆盖；版本标记把「过期」变成可发现状态，只报告。
 */
export function templateStatus(cfg: Config): LintTemplateBucket {
  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'AGENTS.md'), 'utf8') } catch {
    return { present: false, version: 0, current: TEMPLATE_VERSION, stale: false }
  }
  const hit = TEMPLATE_MARK_RE.exec(body)
  const version = hit ? Number(hit[1]) : 0
  const stale = version !== TEMPLATE_VERSION
  const base = { present: true, version, current: TEMPLATE_VERSION, stale }
  // 不 stale 时不要留下 currentText: undefined —— 宿主按无损 JSON 校验，undefined 会让整次调用 invalid；
  // 版本比插件新时也不给：那是插件该升级，不是用户该回退
  return stale && version < TEMPLATE_VERSION
    ? { ...base, currentText: cfg.structure === 'flat' ? AGENTS_TEMPLATE_FLAT : AGENTS_TEMPLATE }
    : base
}

export async function lintNotebook(
  cfg: Config,
  opts: LintOptions = {},
  signal?: AbortSignal,
): Promise<LintResult> {
  const staleDays = Math.min(3650, Math.max(1, Math.trunc(opts.staleDays ?? 90)))
  const now = opts.now ?? new Date()
  const cutoff = now.getTime() - staleDays * 86_400_000

  // 顺序跑而不是并发：zk 每次都会顺手补索引（写 SQLite），并发进程容易撞锁；
  // 一次进程 ~50ms，5 次照样远低于「200 条 3 秒」的验收线。
  // warning 只从第一次 list 收：每篇坏笔记每次进程都会再报一遍，收五遍还得去重。
  const warnings: string[] = []
  const dailyAbs = path.resolve(cfg.notebook, cfg.dailyDir)
  const isDaily = (abs: string): boolean =>
    path.resolve(abs) === dailyAbs || path.resolve(abs).startsWith(dailyAbs + path.sep)

  const notes = await allNotes(cfg, { warnings }, signal)
  const orphanAbs = await notesWithFlag(cfg, '--orphan', signal)
  const brokenAbs = await notesWithFlag(cfg, '--broken-links', signal)
  const taglessAbs = await notesWithFlag(cfg, '--tagless', signal)
  const graph = await graphEdges(cfg, signal)
  const edges = graph.edges
  // 图里的路径是笔记本相对：先拼回绝对路径再判断是不是日记（isDaily 收的是绝对路径）
  const oneWay = oneWayLinks(edges, notes, (p) => isDaily(path.resolve(cfg.notebook, p)))

  // 别用 `path.resolve(n.absPath || n.path)`：absPath 缺失时相对路径会按进程 cwd 解析，键就错了。
  const byAbs = new Map(
    notes.map((n) => [n.absPath ? path.resolve(n.absPath) : path.resolve(cfg.notebook, n.path), n]),
  )
  const byPath = new Map(notes.map((n) => [n.path, n]))
  const bucket = (absPaths: string[], max = MAX_ITEMS): LintBucket => {
    const items = absPaths
      .map((abs) => byAbs.get(path.resolve(abs)))
      .filter((n): n is NoteRecord => Boolean(n))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, max)
      .map((n) => ({ title: n.title, path: n.path }))
    return { total: absPaths.length, items }
  }

  // `zk graph` 的 snippetStart 是 UTF-8 字节偏移：Links 小节也按字节算，才能直接比较。
  // 只读有单向边的来源文件（当前库里个位数），不按笔记逐篇读。
  const sectionCache = new Map<string, { start: number; end: number } | null>()
  const linksSection = (rel: string): { start: number; end: number } | null => {
    if (sectionCache.has(rel)) return sectionCache.get(rel) ?? null
    let text = ''
    try {
      text = fs.readFileSync(path.resolve(cfg.notebook, rel), 'utf8')
    } catch {
      sectionCache.set(rel, null)
      return null
    }
    const head = /^##[ \t]+(?:Links|链接)[ \t]*\r?$/m.exec(text)
    if (!head) {
      sectionCache.set(rel, null)
      return null
    }
    const after = head.index + head[0].length
    const next = /^#{1,2}[ \t]+\S/m.exec(text.slice(after))
    const endChar = next ? after + next.index : text.length
    const section = {
      start: Buffer.byteLength(text.slice(0, head.index), 'utf8'),
      end: Buffer.byteLength(text.slice(0, endChar), 'utf8'),
    }
    sectionCache.set(rel, section)
    return section
  }
  const whereOf = (rel: string, starts: number[]): 'links' | 'body' => {
    const section = linksSection(rel)
    if (!section) return 'body'
    return starts.some((s) => s >= section.start && s < section.end) ? 'links' : 'body'
  }

  const linksOnly = opts.linksOnly === true
  const oneWayItems: LintOneWayEntry[] = []
  let oneWayEdges = 0
  let bodyOnly = 0
  for (const row of oneWay) {
    // 目标也不报日记：普通笔记链到日记（"今天做了 X"）同样是正常引用方向，
    // 要求日记回链每篇被提到的笔记，跟要求笔记回链日记是同一个问题。
    if (isDaily(path.resolve(cfg.notebook, row.target))) continue
    const target = byPath.get(row.target)
    if (!target) continue
    const all: string[] = []
    const links: string[] = []
    const body: string[] = []
    for (const source of row.from) {
      all.push(source.path)
      if (whereOf(source.path, source.snippetStarts) === 'links') links.push(source.path)
      else body.push(source.path)
    }
    // bodyOnly 始终统计全部正文边：linksOnly 时它们被隐藏，但要让调用方知道有多少
    bodyOnly += body.length
    if (linksOnly && links.length === 0) continue
    if (linksOnly) {
      oneWayEdges += links.length
      oneWayItems.push({
        title: target.title,
        path: target.path,
        from: links,
        where: 'links',
      })
    } else {
      oneWayEdges += all.length
      oneWayItems.push({
        title: target.title,
        path: target.path,
        from: all,
        where: links.length === 0 ? 'body' : body.length === 0 ? 'links' : 'mixed',
      })
    }
  }
  oneWayItems.sort((a, b) => a.path.localeCompare(b.path))
  const oneWayBucket: LintOneWayBucket = {
    total: oneWayItems.length,
    edges: oneWayEdges,
    bodyOnly,
    linksOnly,
    edgesTruncated: graph.truncated,
    items: oneWayItems.slice(0, MAX_ITEMS),
  }

  const parseErrors = parseErrorWarnings(cfg, warnings)
  const scanTruncated = notes.length >= MAX_SCAN

  const staleNotes = notes
    .map((n) => ({ note: n, at: Date.parse(n.modified) }))
    .filter((x) => Number.isFinite(x.at) && x.at < cutoff)
    .sort((a, b) => a.at - b.at)
  const stale: LintStaleBucket = {
    total: staleNotes.length,
    items: staleNotes.slice(0, MAX_ITEMS).map((x) => ({
      title: x.note.title,
      path: x.note.path,
      modified: localDate(x.note.modified),
    })),
  }

  // 日记不参与下面两项：标题就是日期（相似度必然高），篇数又按天自动增长
  // （一年日记足以把任何库顶到 150 篇，可库里其实只有几十篇知识）。
  const nonDaily = notes.filter((n) => !isDaily(path.resolve(cfg.notebook, n.path)))

  return {
    notebook: cfg.notebook,
    notes: notes.length,
    truncated: scanTruncated,
    staleDays,
    parseErrors: { total: parseErrors.length, items: parseErrors.slice(0, MAX_ITEMS) },
    orphans: bucket(orphanAbs.filter((abs) => !isDaily(abs))),
    brokenLinks: bucket(brokenAbs),
    stale,
    tagless: bucket(taglessAbs.filter((abs) => !isDaily(abs))),
    oneWayLinks: oneWayBucket,
    duplicateTitles: duplicateTitles(notes),
    // 日记按天写，标题就是日期：同类比较只会产出一堆误报（见 similarTitles 的注释）
    similarTitles: similarTitles(nonDaily, scanTruncated),
    memoryLinks: memoryLinkIssues(cfg, notes, { staleDays, now }),
    incomplete: cfg.structure === 'layered'
      ? incompleteFrontmatter(cfg, notes, (rel) => isDaily(path.resolve(cfg.notebook, rel)), scanTruncated)
      : { total: 0, truncated: false, byField: { type: 0, status: 0, authority: 0 }, items: [] },
    tags: tagHygiene(notes),
    template: templateStatus(cfg),
    contract: contractStatus(cfg),
    // 150 篇（不含日记）是检索开始变糊的拐点：提示一下，不生成静态索引（会过期，还要决定谁更新）
    indexHint: nonDaily.length >= 150 && !fs.existsSync(path.join(cfg.notebook, 'INDEX.md')),
  }
}
