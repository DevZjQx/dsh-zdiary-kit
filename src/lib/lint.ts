/**
 * 巡检（M3）：只报告，不改任何笔记（计划 §3 D5）。
 *
 * 一次 `zk list` 拿全量，再用 zk 原生的几个过滤器（孤儿 / 断链 / 无标签 / 缺回链）各跑一次进程；
 * 「陈旧」「重名」在 JS 里算，单向链接小库用一次 `zk graph` 的边、大库按篇反查（见 `oneWayByQueries`）。
 * 200 条笔记上 5 次进程就够 —— 大库那条路也按「问题数」而不是「篇数」计费。
 *
 * 「陈旧」为什么自己算：zk 的 `stale` 不是内置过滤器，`zk list stale` 只在你自己的
 * `[filter]` 里定义过才存在（Z3 只说了位置参数语法，没说它是内置的）。所以阈值由插件定。
 *
 * 孤儿与无标签**不含日记**：日记按天写，天然没有入链、也没有标签，
 * 全报出来只会把真正的问题（断链、单向链接）淹掉。断链仍包含日记 —— 那里出错是真问题。
 *
 * 「单向链接」为什么自己算：zk 的 `--missing-backlink` 是「至少有一条单向链接」（S 链 X、X 不回链），
 * 而日记天然是一串出边 —— 日记提过的每篇笔记都会常年挂在桶里。那不是「笔记没接上」，是正常的引用方向。
 * 所以在边上自己算，只报**非日记来源**的单向链接。
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
import type { Completeness, GraphEdge, NoteRecord } from './zk.ts'
import {
  backlinksOf, GRAPH_BUDGET_NOTES, graphEdges, indexLagHint, localDate, MAX_SCAN, scanNotes, scanNotesWithFlag,
  outlinksOf, parseErrorWarnings,
} from './zk.ts'
import { normalizeTitle, resolveWikiTarget, WIKI_LINK, wikiIndex } from './wikilink.ts'
import { fenceMask } from './fence.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { daysSinceDate, entryDate, isRetiredEntry, memoryFormatDebt, splitMemoryEntries } from './memory-format.ts'
import type { FrontmatterFields } from './frontmatter.ts'
import { AGENTS_TEMPLATE, AGENTS_TEMPLATE_FLAT, TEMPLATE_SENTINELS, TEMPLATE_VERSION, templateVersionOf } from './agents-template.ts'
import { PERSONA_TEMPLATE_SENTINELS, PERSONA_TEMPLATE_VERSION } from './persona-template.ts'
import type { TimelineIssue, TimelineIssueKind } from './timeline.ts'
import { timelineCounts, timelineIssues } from './timeline.ts'
import { isDayString } from './dates.ts'
import { similarKeyOf, similarScore } from './similar.ts'

/** 每类最多回多少条（计划 §4 M3）；总数另给 */
export const MAX_ITEMS = 50

/**
 * 大库按篇反查的上限（plan §9.3）：目标数 50、子进程 60，取先到者（每个目标要 2 个进程，
 * 实际约 30 个目标；10k 库上每个约 0.45 s）。超了就报 `edgesTruncated`，不静默少报。
 */
const MAX_ONE_WAY_TARGETS = 50
const MAX_ONE_WAY_QUERIES = 60

/** 单向链接的一行：目标 + 没回链的来源，`where` 是这条链接写在正文还是 Links 小节 */
interface OneWayRow {
  target: string
  from: Array<{ path: string; where: 'links' | 'body' }>
}

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
  /**
   * complete = 所有同目录对都算过；partial = 有组被 SIMILAR_GROUP_MAX 截断或扫描触顶；
   * unknown = 扫描结果无法解析（scanNotes 给的）
   */
  completeness: Completeness
  /** 因超过 SIMILAR_GROUP_MAX 而只比较了前 300 篇的组数（不是被丢的条目数） */
  droppedGroups: number
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
   * true = 单向链接的边集不完整：小库是 `zk graph` 触到 `--limit`，大库是按篇反查触到
   * 目标数 / 子进程预算。与 `truncated`（笔记扫描）不同：那边少一篇只会漏报，
   * 这边**缺一条回链边就会把双向误判成单向** —— 触顶必须显式报出来。
   */
  edgesTruncated: boolean
  /** 上面那条的三种写法：partial = 边集不完整；unknown = 老 zk 连是否触顶都判断不了 */
  completeness: Completeness
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
  /** 活条目里没有任何 `[[链接]]` 的条数（无法核对）；退役行不计，口径同 `memoryFormatDebt` */
  unlinked: number
  /** MEMORY.md 活条目里首行没有 `YYYY-MM-DD` 的条数（P1-3）；退役行不计，口径同 `memoryFormatDebt` */
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
  /** true = 有 AGENTS.md，但版本不是当前模板，或标记与正文不符 */
  stale: boolean
  /**
   * true = 标记写着当前版本，但正文仍含旧版内容（疑似只改了版本号）。
   * 此时 `stale` 也为 true，且给 `currentText`，让 agent 有东西可合并。
   */
  mismatch?: boolean
  /** `mismatch` 的人读原因（缺了什么 / 还留着什么） */
  mismatchDetail?: string
  /**
   * `version < current`（旧版 / 无标记）或 `mismatch` 时给出当前结构对应的模板全文。
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

/** 人格体检（M1：missing / old / newer / mismatch / placeholder） */
export interface LintPersonaIssue {
  file: 'PERSONA.md'
  kind: 'missing' | 'old' | 'newer' | 'mismatch' | 'placeholder'
  /** 人读说明（old / newer 带当前 / 盘上版本；mismatch 带不符原因；placeholder 带占位符清单） */
  detail: string
}

export interface LintPersonaBucket {
  total: number
  items: LintPersonaIssue[]
}

/** 时间轴问题：只报告，不自动修（计划 §2 D2） */
export interface LintTimelineEntry {
  /** 日记（笔记本相对路径） */
  path: string
  /** 这一篇的问题（每篇最多 50 条） */
  issues: TimelineIssue[]
}

export interface LintTimelineBucket {
  /** 窗口内实际读到并检查的日记篇数 */
  scanned: number
  /** 没检查到的篇数（过大 / 读不出来 / 日期取不到）：不静默，输出里点名 */
  skipped: number
  /** 有问题的日记篇数 */
  notes: number
  /** 问题总数：全量累计；items 的截断（前 50 篇、每篇前 50 条）不影响这里 */
  total: number
  /** 全量分类计数：四项相加恒等于 total（items 被截断时也不会对不上） */
  counts: Record<TimelineIssueKind, number>
  items: LintTimelineEntry[]
}

/** 时间轴只扫最近多少天（计划 §2 D4）：一年日记会报几百条旧问题，把今天的问题挤出 50 条上限 */
export const TIMELINE_WINDOW_DAYS = 90

/** 超过这个大小的日记不读（doctor / lint 不该把 2 GiB 的日志拉进内存）：跳过并计入 skipped */
export const TIMELINE_MAX_BYTES = 2 * 1024 * 1024

export interface LintOptions {
  /** 多少天没修改算陈旧（默认 90） */
  staleDays?: number
  /** 只报 Links 小节的单向链接；正文引用只计数（默认 false = 全报） */
  linksOnly?: boolean
  /**
   * 覆盖配置里的 `graphBudgetNotes`（默认 2000）。超过就改成按篇反查。
   * 只给测试用：把它压到 0 就能在小库上跑大库的那条路径。
   */
  graphBudget?: number
  /** 测试用；默认 now */
  now?: Date
}

export interface LintResult {
  notebook: string
  /** 参与巡检的笔记数（已排除 raw / inbox / archive / meta 文件） */
  notes: number
  /** 稳定 ID（§9.2）：缺 `id` 的非日记笔记数，只读计数，不回填 */
  missingId: number
  /**
   * true = 笔记扫描触到上限，结果不完整：只会漏报，不会误报（别当成「只有这些问题」）。
   * 边截断是另一回事，见 `oneWayLinks.edgesTruncated`。
   */
  truncated: boolean
  /** 三态写法：complete / partial（扫描触顶）/ unknown（扫描结果无法解析） */
  completeness: Completeness
  /** 本次扫描上限（MAX_SCAN）；页面用它解释「为什么只统计了这么多」 */
  scanLimit: number
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
  /** 人格层体检：PERSONA.md 缺失 / 旧版 / 未填占位符（只报告） */
  persona: LintPersonaBucket
  /** 日记时间轴：最近 90 天的空块 / 倒序 / 格式 / 位置问题（只报告，页面警告不受此窗口限制） */
  timeline: LintTimelineBucket
  /**
   * 非日记笔记已到 150 篇、根目录却没有 INDEX.md（P2-11）：只是提示，不生成静态索引。
   * 实时分布看 zk_stats（byDir / byTag），静态索引会过期、还要决定谁负责更新。
   * 日记不计入：它按天自动增长，一年就能把任何库顶到 150 篇，可知识量并没有涨。
   */
  indexHint: boolean
  /**
   * 「索引可能落后」的提示（R6）：工具写入会在下一次检索前自动补索引，
   * 这里只报「补不上 / 外部编辑」两种残留情况；空串 = 没有提示。只读，不自动重建。
   */
  indexLag: string
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

/** 同目录最多两两比较多少篇：超过就截断并置 truncated，别让 1 万篇变成 O(n²) */
const SIMILAR_GROUP_MAX = 300

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
    // 空标题、纯数字（日期 / 编号）都在这里被挡掉，口径与 zk_new 的写路径提示同一份
    const target = similarKeyOf(title)
    if (!target) continue
    const dir = path.posix.dirname(note.path)
    const list = groups.get(dir) ?? []
    list.push({ title, path: note.path, exact: normalizeTitle(title), ...target })
    groups.set(dir, list)
  }

  let truncated = scanTruncated
  let droppedGroups = 0
  const found: LintSimilarGroup[] = []
  for (const group of groups.values()) {
    let list = group
    if (list.length > SIMILAR_GROUP_MAX) {
      truncated = true
      droppedGroups += 1
      list = list.slice(0, SIMILAR_GROUP_MAX)
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        // 归一化后完全一样：那是 duplicateTitles 的活（这里报会让同一件事出现两遍）
        if (a.exact === b.exact) continue
        // 相似判定只有 similar.ts 一份：短标题（< 4 码点）也由它挡掉
        const score = similarScore(a, b)
        if (score === null) continue
        found.push({
          titles: [a.title, b.title],
          paths: [a.path, b.path],
          score,
        })
      }
    }
  }
  found.sort((a, b) => b.score - a.score || a.paths[0].localeCompare(b.paths[0]))
  const completeness: Completeness = truncated ? 'partial' : 'complete'
  return { total: found.length, truncated, completeness, droppedGroups, items: found.slice(0, max) }
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

    const lines = body.split('\n')
    const fenced = fenceMask(lines)
    for (let i = 0; i < lines.length; i++) {
      // 代码块里的 `[[…]]` 是示例，不是来源链接
      if (fenced[i]) continue
      const line = lines[i] ?? ''
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
      // 日期 / 来源缺口取唯一口径 memoryFormatDebt（退役条目不算、`[[   ]]` 不算来源），
      // 注入提示与记忆页用的也是它 —— 同一个「N 条没来源」不许在三处给出三个数。
      const debt = memoryFormatDebt(body)
      undated = debt.undated
      unlinked = debt.unlinked
      for (const entry of splitMemoryEntries(body)) {
        const first = entry.split('\n', 1)[0] ?? ''
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
        if (!date) continue
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

const TIMELINE_KINDS: Array<[TimelineIssue['kind'], string]> = [
  ['empty', '空块'],
  ['order', '倒序'],
  ['format', '格式'],
  ['placement', '位置'],
]

/** 时间轴一行文案：zk_lint / zk-kit lint 共用；没有问题时返回空串，不占行 */
export function formatTimeline(bucket: LintTimelineBucket): string {
  if (bucket.total === 0) return ''
  // 分类计数用桶里全量的 counts，不从被截断的 items 重算：否则「12 处」和「空块 5 · 倒序 2」会对不上
  const parts = TIMELINE_KINDS.filter(([kind]) => bucket.counts[kind] > 0)
    .map(([kind, label]) => `${label} ${bucket.counts[kind]}`)
  const skipped = bucket.skipped > 0 ? `；跳过 ${bucket.skipped} 篇` : ''
  const sample = bucket.items.slice(0, 3).map((item) => {
    const first = item.issues[0] as TimelineIssue
    return `${item.path}（行 ${first.line}：${first.title} — ${first.detail}）`
  })
  return `✗ 时间轴：${bucket.total} 处（${bucket.notes} 篇；扫描 ${bucket.scanned} 篇${skipped}）｜${parts.join(' · ')}` +
    (sample.length > 0 ? ` — ${sample.join('；')}` : '')
}

/**
 * 三个后加的桶（缺字段 / 标签卫生 / 模板版本）的文案，同样只写一份：
 * `zk-kit lint` 与 `zk_lint` 各写一遍就会改到一半。返回空数组 = 这一库三项都没问题，不占行。
 */
export function formatLintExtras(
  r: Pick<LintResult, 'incomplete' | 'tags' | 'template' | 'persona' | 'similarTitles' | 'timeline' | 'indexHint' | 'missingId'>,
): string[] {
  const lines: string[] = []
  const timeline = formatTimeline(r.timeline)
  if (timeline) lines.push(timeline)
  if (r.missingId > 0) {
    lines.push(`· 稳定 ID：${r.missingId} 篇没有 id — 新建的笔记已自动写入，老笔记只提示、不回填（§9.2）`)
  }
  // 缺文件 = 人格未启用（默认状态）：不报错、不占行。
  // 有旧版 / 占位符 / 标记不符时才提醒 —— 否则每个老库每次 lint 都多一条永久 ⚠️，反而训练人忽略告警。
  const persona = r.persona.items
  const allMissing = persona.length > 0 && persona.every((i) => i.kind === 'missing')
  if (!allMissing && persona.length > 0) {
    // 不同方向给不同指令：旧版要合并内容，比插件新要升级插件，标记与内容不符要查哨兵。
    // 混成一句「旧版由人按需处理」会把「比插件新」也说成旧版，模型最省力的动作就是改数字。
    const groups: Array<{ label: string; hint: string; items: LintPersonaIssue[] }> = [
      {
        label: '旧版',
        items: persona.filter((i) => i.kind === 'old'),
        hint: '合并新版内容后再改首行标记；只改数字不算升级',
      },
      {
        label: '版本比插件新',
        items: persona.filter((i) => i.kind === 'newer'),
        hint: '插件才是旧的那个，别改文件里的版本号；升级插件后再看',
      },
      {
        label: '标记与内容不符',
        items: persona.filter((i) => i.kind === 'mismatch'),
        hint: '疑似只改了版本号；按新版模板合并内容，别只改数字',
      },
      {
        label: '',
        items: persona.filter((i) => i.kind === 'missing' || i.kind === 'placeholder'),
        hint: '只报告：缺文件 = 未启用，占位符由人填',
      },
    ]
    for (const group of groups) {
      if (group.items.length === 0) continue
      lines.push(
        `⚠️ 人格${group.label}：${group.items.map((i) => `${i.file} ${i.detail}`).join('；')}｜${group.hint}`,
      )
    }
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
    if (t.mismatch) {
      lines.push(
        `⚠️ AGENTS.md 标记是 v${t.version}，但正文与 v${t.version} 不符` +
        (t.mismatchDetail ? `（${t.mismatchDetail}）` : '') +
        '—— 疑似只改了版本号；标记是声明不是开关，按下面的新版模板合并后再改。',
      )
    } else if (t.version > t.current) {
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
          ? `新版模板全文如下：按需合并，别整篇覆盖你改过的规则；合并完内容再把首行标记更新为 v${t.current}（只改数字不算升级）。`
          : ''),
      )
    }
    if (t.currentText) {
      lines.push('--- 新版模板开始 ---')
      lines.push(t.currentText.trimEnd())
      lines.push('--- 新版模板结束 ---')
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

const PERSONA_MARK_RE = /<!--\s*zdiary-persona:\s*v(\d+)\s*-->/
const PLACEHOLDER_RE = /\{\{\s*[^}]+\s*\}\}/g

/**
 * 哨兵文本的人读形态：detail 会被塞进 lint / doctor / 设置页的**单行**警告，
 * 而哨兵自己可能带换行（靠行首锚定 frontmatter 字段的那类）——
 * 直接拼进去会把一条警告劈成两行，后面的「｜提示」也跟着掉到下一行。
 */
function showSentinel(text: string): string {
  return text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(' ')
}

/** 返回 null = 正文符合哨兵；否则是给人看的不符原因 */
function sentinelIssue(
  body: string,
  rule: { required?: readonly string[]; forbidden?: readonly string[] } | undefined,
): string | null {
  if (!rule) return null
  const quote = (texts: readonly string[]) => texts.map((text) => `「${showSentinel(text)}」`).join('、')
  // 两件事一起报：只报「缺了什么」会让「还留着旧句」被藏起来，人改完一处又撞一次
  const parts: string[] = []
  const missing = (rule.required ?? []).filter((text) => !body.includes(text))
  if (missing.length > 0) parts.push(`缺少当前版本才有的内容：${quote(missing)}`)
  const leftover = (rule.forbidden ?? []).filter((text) => body.includes(text))
  if (leftover.length > 0) parts.push(`仍含旧版已移除的内容：${quote(leftover)}`)
  return parts.length > 0 ? parts.join('；') : null
}

/**
 * 人格体检（M1）：缺文件 = 未启用（不算错，但要让 zk_lint 可见）；
 * 旧版 = 标记比当前模板旧；比插件新 = 插件才是旧的那个，别改文件去配；
 * 标记与内容不符 = 标记已是当前版本，正文还留着旧版内容（只改了首行数字）；
 * 占位符 = 模板里的 {{...}} 还没填（“未填”是机械可发现的“未启用一半”状态）。
 * 全部只报告，不覆盖 —— 人格允许人改。
 */
export function personaStatus(cfg: Config): LintPersonaBucket {
  const items: LintPersonaIssue[] = []
  const files = [
    { name: 'PERSONA.md', mark: PERSONA_MARK_RE, current: PERSONA_TEMPLATE_VERSION },
  ] as const
  for (const f of files) {
    let body = ''
    try { body = fs.readFileSync(path.join(cfg.notebook, f.name), 'utf8') } catch {
      items.push({ file: f.name, kind: 'missing', detail: '根目录没有这份文件（zk-kit init --with-persona 或设置页可写入模板）' })
      continue
    }
    const hit = f.mark.exec(body)
    const version = hit ? Number(hit[1]) : 0
    if (version > f.current) {
      items.push({
        file: f.name,
        kind: 'newer',
        detail: `版本标记比插件新（v${version} > 当前 v${f.current}）`,
      })
    } else if (version !== f.current) {
      items.push({
        file: f.name,
        kind: 'old',
        detail: version === 0
          ? `没有版本标记（当前 v${f.current}）`
          : `是旧版 v${version}（当前 v${f.current}）`,
      })
    } else {
      const mismatch = sentinelIssue(body, PERSONA_TEMPLATE_SENTINELS[f.name]?.[version])
      if (mismatch) {
        items.push({ file: f.name, kind: 'mismatch', detail: `标记是 v${version}，但正文${mismatch}` })
      }
    }
    const placeholders = [...new Set(body.match(PLACEHOLDER_RE) ?? [])]
    if (placeholders.length > 0) {
      items.push({ file: f.name, kind: 'placeholder', detail: `还有未填的占位符：${placeholders.join('、')}` })
    }
  }
  return { total: items.length, items }
}

/**
 * 模板版本（P2-15）：模板是行为约定，不是静态文档 —— 它每轮注入，写错一句就是每轮都在执行错规则。
 * 但模板允许用户改，不能自动覆盖；版本标记把「过期」变成可发现状态，只报告。
 *
 * 标记等于当前版本时再查正文哨兵：只把首行数字改成 vN、正文还是旧版，
 * 会让 lint 误以为已经合并完 —— 这种情况仍报，并给出当前模板全文。
 */
export function templateStatus(cfg: Config): LintTemplateBucket {
  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'AGENTS.md'), 'utf8') } catch {
    return { present: false, version: 0, current: TEMPLATE_VERSION, stale: false }
  }
  const version = templateVersionOf(body)
  const mismatchDetail = version === TEMPLATE_VERSION
    ? sentinelIssue(body, TEMPLATE_SENTINELS[TEMPLATE_VERSION])
    : null
  const stale = version !== TEMPLATE_VERSION || mismatchDetail !== null
  const base = { present: true, version, current: TEMPLATE_VERSION, stale }
  const currentText = cfg.structure === 'flat' ? AGENTS_TEMPLATE_FLAT : AGENTS_TEMPLATE
  // 不 stale 时不要留下 currentText: undefined —— 宿主按无损 JSON 校验，undefined 会让整次调用 invalid；
  // 版本比插件新时也不给：那是插件该升级，不是用户该回退
  if (mismatchDetail !== null) return { ...base, mismatch: true, mismatchDetail, currentText }
  return version < TEMPLATE_VERSION ? { ...base, currentText } : base
}

/**
 * 最近 `TIMELINE_WINDOW_DAYS` 天的日记时间轴（计划 §2 D4）。
 *
 * 自己走 dailyDir 而不是复用 `allNotes`：doctor 也会调它，而 doctor 在没有 zk 时
 * 也要能给出这一行。按文件名 `YYYY-MM-DD` 判日期；不是这个形状（自定义模板）
 * 才退回文件创建时间 —— 与 dream 的 noteDate 口径一致。
 */
export function timelineStatus(
  cfg: Config,
  now: Date = new Date(),
  max = MAX_ITEMS,
): LintTimelineBucket {
  const root = path.resolve(cfg.notebook, cfg.dailyDir)
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(abs)
        continue
      }
      if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(abs)
    }
  }
  walk(root)

  const nowMs = now.getTime()
  const cutoff = nowMs - TIMELINE_WINDOW_DAYS * 86_400_000
  let scanned = 0
  let skipped = 0
  let total = 0
  const counts: Record<TimelineIssueKind, number> = { empty: 0, order: 0, format: 0, placement: 0 }
  const items: LintTimelineEntry[] = []

  for (const abs of files.sort()) {
    const rel = path.relative(cfg.notebook, abs).split(path.sep).join('/')
    const stem = path.basename(rel, path.extname(rel))
    let day = ''
    if (isDayString(stem)) {
      day = stem
    } else {
      try { day = localDate(fs.statSync(abs).birthtime.toISOString()) } catch { skipped += 1; continue }
    }
    if (!isDayString(day)) continue
    const [year, month, date] = day.split('-').map(Number)
    const at = new Date(year as number, (month as number) - 1, date as number).getTime()
    if (!(at >= cutoff)) continue
    let body = ''
    try {
      if (fs.statSync(abs).size > TIMELINE_MAX_BYTES) { skipped += 1; continue }
      body = fs.readFileSync(abs, 'utf8')
    } catch { skipped += 1; continue }
    scanned += 1
    // 计数取全量、items 里每篇只留前 MAX_ITEMS 条：分类相加必须等于 total，
    // 否则「60 处」配上只数了前 50 篇明细的拆分会自相矛盾。
    const issues = timelineIssues(body, 'auto', Number.MAX_SAFE_INTEGER)
    if (issues.length === 0) continue
    total += issues.length
    const own = timelineCounts(issues)
    for (const kind of Object.keys(counts) as TimelineIssueKind[]) counts[kind] += own[kind]
    items.push({ path: rel, issues: issues.slice(0, MAX_ITEMS) })
  }

  return { scanned, skipped, notes: items.length, total, counts, items: items.slice(0, max) }
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

  const scan = await scanNotes(cfg, { warnings }, signal)
  const notes = scan.notes
  const orphanScan = await scanNotesWithFlag(cfg, '--orphan', signal)
  const brokenScan = await scanNotesWithFlag(cfg, '--broken-links', signal)
  const taglessScan = await scanNotesWithFlag(cfg, '--tagless', signal)
  const orphanAbs = orphanScan.paths
  const brokenAbs = brokenScan.paths
  const taglessAbs = taglessScan.paths
  // 任一过滤器触顶都意味着对应桶少了；三态取最坏值（partial > unknown > complete）
  const worst = (values: Completeness[]): Completeness =>
    values.includes('partial') ? 'partial' : values.includes('unknown') ? 'unknown' : 'complete'
  const completeness = worst([scan.completeness, orphanScan.completeness, brokenScan.completeness, taglessScan.completeness])
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

  // ── 单向链接：小库一次全图；大库按篇反查（plan §0.5.1 结论 3）─────────────
  // 全图在 10k / 1 链要 26–31 s / 17 MB，2–5 链会直接超过 60 s 超时；
  // 单篇反链已经走 `backlinksOf`，巡检在超过预算时也走同一条路。
  const sourceTextCache = new Map<string, string>()
  const sourceText = (rel: string): string => {
    const cached = sourceTextCache.get(rel)
    if (cached !== undefined) return cached
    let text = ''
    try { text = fs.readFileSync(path.resolve(cfg.notebook, rel), 'utf8') } catch { text = '' }
    sourceTextCache.set(rel, text)
    return text
  }

  /** 按篇反查没有 snippetStart：自己扫源文件，判断链接写在 Links 小节还是正文 */
  const linkWhereOf = (sourceRel: string, targetRel: string): 'links' | 'body' => {
    const text = sourceText(sourceRel)
    if (!text) return 'body'
    const keys = new Set(
      [targetRel, targetRel.replace(/\.md$/i, ''), path.basename(targetRel, path.extname(targetRel)), byPath.get(targetRel)?.title ?? '']
        .map((k) => normalizeTitle(k))
        .filter(Boolean),
    )
    const head = /^##[ \t]+(?:Links|链接)[ \t]*\r?$/m.exec(text)
    let start = -1
    let end = -1
    if (head) {
      start = head.index + head[0].length
      const next = /^#{1,2}[ \t]+\S/m.exec(text.slice(start))
      end = next ? start + next.index : text.length
    }
    for (const m of text.matchAll(WIKI_LINK)) {
      if (!keys.has(normalizeTitle(String(m[1] ?? '')))) continue
      const at = m.index ?? 0
      if (start >= 0 && at >= start && at < end) return 'links'
    }
    return 'body'
  }

  /**
   * 大库的单向链接：zk 先给「缺回链的目标」（一次 `--missing-backlink`），
   * 再对每个目标 `--link-to` 取来源、对每个来源 `--linked-by` 判回链（缓存）。
   * 成本随问题数增长，而不是随库大小增长；触到上限就报 partial，不静默少报。
   */
  const oneWayByQueries = async (): Promise<{ rows: OneWayRow[]; truncated: boolean }> => {
    let left = MAX_ONE_WAY_QUERIES
    const spend = (): boolean => (left > 0 ? ((left -= 1), true) : false)

    const missing = await scanNotesWithFlag(cfg, '--missing-backlink', signal)
    let truncated = missing.completeness !== 'complete'
    const targets = missing.paths
      .map((abs) => path.relative(cfg.notebook, abs).split(path.sep).join('/'))
      .filter((rel) => byPath.has(rel) && !isDaily(path.resolve(cfg.notebook, rel)))
      .sort((a, b) => a.localeCompare(b))
    const capped = targets.slice(0, MAX_ONE_WAY_TARGETS)
    if (targets.length > capped.length) truncated = true

    const rows: OneWayRow[] = []
    for (const target of capped) {
      if (!spend()) { truncated = true; break }
      const back = await backlinksOf(cfg, target, { limit: MAX_SCAN }, signal)
      if (back.truncated) truncated = true
      if (!back.notes.length) continue
      if (!spend()) { truncated = true; break }
      // 回链方向是 T → S：取目标自己的出链，看它有没有连回来源
      const linked = await outlinksOf(cfg, target, { limit: MAX_SCAN }, signal)
      if (linked.truncated) truncated = true
      const outs = new Set(linked.notes.map((n) => n.path))
      const from: OneWayRow['from'] = []
      for (const note of back.notes) {
        if (note.path === target || isDaily(path.resolve(cfg.notebook, note.path))) continue
        if (outs.has(note.path)) continue
        from.push({ path: note.path, where: linkWhereOf(note.path, target) })
      }
      if (from.length) rows.push({ target, from: from.sort((a, b) => a.path.localeCompare(b.path)) })
    }
    return { rows, truncated }
  }

  // 预算来自配置（设置页可调）；opts.graphBudget 只给测试覆盖
  const graphBudget = Math.max(0, Math.trunc(opts.graphBudget ?? cfg.graphBudgetNotes ?? GRAPH_BUDGET_NOTES))
  const oneWayRows: OneWayRow[] = []
  let oneWayTruncated = false
  let oneWayCompleteness: Completeness = 'complete'
  if (notes.length <= graphBudget) {
    const graph = await graphEdges(cfg, signal)
    oneWayTruncated = graph.truncated
    oneWayCompleteness = graph.completeness
    // 图里的路径是笔记本相对：先拼回绝对路径再判断是不是日记（isDaily 收的是绝对路径）
    for (const row of oneWayLinks(graph.edges, notes, (p) => isDaily(path.resolve(cfg.notebook, p)))) {
      oneWayRows.push({
        target: row.target,
        from: row.from.map((s) => ({ path: s.path, where: whereOf(s.path, s.snippetStarts) })),
      })
    }
  } else {
    const scanned = await oneWayByQueries()
    oneWayRows.push(...scanned.rows)
    oneWayTruncated = scanned.truncated
    oneWayCompleteness = scanned.truncated ? 'partial' : 'complete'
  }

  const linksOnly = opts.linksOnly === true
  const oneWayItems: LintOneWayEntry[] = []
  let oneWayEdges = 0
  let bodyOnly = 0
  for (const row of oneWayRows) {
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
      if (source.where === 'links') links.push(source.path)
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
    edgesTruncated: oneWayTruncated,
    completeness: oneWayCompleteness,
    items: oneWayItems.slice(0, MAX_ITEMS),
  }

  const parseErrors = parseErrorWarnings(cfg, warnings)
  const scanTruncated = completeness !== 'complete'

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
    // 只读计数：日记按日期命名、路径天然稳定，不计入；老笔记缺 id 属预期，不回填
    missingId: nonDaily.filter((n) => !n.id).length,
    truncated: scanTruncated,
    completeness,
    scanLimit: scan.limit,
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
    persona: personaStatus(cfg),
    timeline: timelineStatus(cfg, now),
    // 150 篇（不含日记）是检索开始变糊的拐点：提示一下，不生成静态索引（会过期，还要决定谁更新）
    indexHint: nonDaily.length >= 150 && !fs.existsSync(path.join(cfg.notebook, 'INDEX.md')),
    // 放在最后算：前面的读命令已经把 pending 的 dirty 补掉了，剩下的是「补不上 / 外部编辑」
    indexLag: indexLagHint(cfg) ?? '',
  }
}
