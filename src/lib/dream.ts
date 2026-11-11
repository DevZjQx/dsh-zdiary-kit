/**
 * 做梦（M3）：只给材料，不写任何文件（计划 §3 D5 / D7）。
 *
 * 晋升 MEMORY.md、写 DREAMS.md 都是 agent 的语义活；这里只做三件机械事：
 *   · 最近 N 天新增的笔记（按机械规则挡掉不可晋升的，附原因；日记不算候选，它的未完成项单独一栏）；
 *   · daily 里 `## Loose ends` 小节还没划掉的项；
 *   · 被引用最多的笔记（一次 `zk graph` 数入链）。
 * 「rejected」是机械规则，不是相关性判断：authority=informal 与无标签两条，别再加。
 *
 * 晋升是一道**门**，门得知道门里已经有什么（P0-2）：读 MEMORY.md 判「这条已经晋升过」，
 * 已经进去的移出候选、单列一栏 —— 否则同一批笔记每周原样重复，仪式几次之后就没人再看了。
 * 窗口默认也不再固定 7 天，而是跟着 DREAMS.md 的「上次做梦」走：漏做一周不会把笔记永久甩出窗口。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import type { Completeness, NoteRecord } from './zk.ts'
import { GRAPH_BUDGET_NOTES, graphEdges, localDate, scanNotes } from './zk.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { withoutFences } from './fence.ts'
// memory.ts 也 import 本模块（DREAM_INTERVAL_DAYS / daysSinceDream）：这里是运行期才取用，
// 循环引用在 ESM 下安全 —— 不要在模块顶层调用 memoryUsage。
import { memoryUsage } from './memory.ts'
import type { MemoryUsage } from './memory.ts'
import { daysSinceDate, entryDate, isRetiredEntry, splitMemoryEntries, stripRetiredEntries } from './memory-format.ts'
import { isDayString } from './dates.ts'
import { normalizeTitle, noteKey, resolveWikiTarget, WIKI_LINK, wikiIndex } from './wikilink.ts'
import { AUDIT_RATE, hasRecallSignal, lastRecallOf, readRecallSignal, RECALL_PROTECT_DAYS } from './recall-signal.ts'
import type { RecallSignal } from './recall-signal.ts'

/** 每栏最多回多少条（计划 §4 M3 的 50 条上限） */
export const MAX_ITEMS = 50
/** topCited 只取前几名：给 agent 一个「本周被反复引用」的提示，不是排行榜 */
export const TOP_CITED = 10
/** 窗口之外、还没晋升的笔记最多回多少条：漏做一周不该让它们永久掉队 */
export const MAX_BACKLOG = 10
/** 标题包含匹配的最短长度：短标题（「RAG」「额度」）容易在任意句子里撞上 */
export const MIN_TITLE_MATCH = 6

/** `## Loose ends` / `## 未完成` / `## 待办` 都算（大小写不敏感，单复数都认） */
const LOOSE_HEADING = /^##\s+(loose ends?|未完成|待办(?:事项)?)\s*$/i

/** 周节奏：AGENTS.md 的「每周」就按这个天数算。没有定时器，只在记忆注入里提醒到期 */
export const DREAM_INTERVAL_DAYS = 7

/** DREAMS.md 的标记行：`上次做梦：2026-10-22`（列表符号 / 引用符 / 加粗都能容忍） */
const DREAM_STAMP = /^\s*(?:[-*+>]\s*)?(?:\*\*)?上次做梦(?:\*\*)?\s*[：:]\s*(\d{4})-(\d{2})-(\d{2})\s*$/

/**
 * 读 DREAMS.md 正文里的「上次做梦」日期（YYYY-MM-DD）。
 * 只认整齐的一行：这段值是**人/agent 写的**，被夹在句子里时宁可当没有，也不猜。
 */
export function lastDreamDate(body: string): string | null {
  for (const line of String(body ?? '').split('\n')) {
    const m = DREAM_STAMP.exec(line)
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
  }
  return null
}

/**
 * 距上次做梦几天。按**本地日历天**算（不是毫秒差 / 86400000 再取整 ——
 * 夏时制会给出 6.958 天，floor 成 6，于是「满 7 天」永远差一天）。
 */
export function daysSinceDream(last: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(last ?? '').trim())
  if (!m) return null
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(at.getTime())) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((today.getTime() - at.getTime()) / 86_400_000)
}

export interface DreamOptions {
  /** 窗口天数；省略时 = 距 DREAMS.md「上次做梦」的日历天数（没有则 7 天） */
  days?: number
  /** 测试用；默认 now */
  now?: Date
  /** 覆盖配置里的 `graphBudgetNotes`（默认 2000）；只给测试用，压到 0 就能跑大库那条路 */
  graphBudget?: number
}

export interface DreamCandidate {
  title: string
  path: string
  type: string
  authority: string
  tags: string[]
  created: string
  /** 正文首段摘要（不是 zk 的 lead —— 那个只是标题行）—— 不用先读全文就有材料 */
  lead: string
  /** 入链数（被多少篇笔记链接） */
  cited: number
  /** 入链来源（最多 5 条）：这些笔记为什么引它，读它们比读候选本身更能还原上下文 */
  citedBy: string[]
  /** true = MEMORY.md 里已经有它（链接命中或标题包含），不会再进 newNotes */
  promoted: boolean
  /** 怎么判出来的：link = MEMORY 里的 `[[链接]]`；title = 条目里写了标题；'' = 没晋升 */
  promotedBy: 'link' | 'title' | ''
  /** 被多少篇日记提到过（P2-12：入链衡量作者中心性，日记才接近「被用到」） */
  dailyMentions: number
  /** 这些日记覆盖了几个不同日期（跨天复现比连着引用几次更强） */
  daysMentioned: number
  /** 最近一次被日记提到的日期（YYYY-MM-DD）；没有就是空串 */
  lastMentioned: string
}

export interface DreamRejection {
  title: string
  path: string
  reason: string
}

export interface DreamLooseEnds {
  path: string
  /** 日记日期（YYYY-MM-DD） */
  date: string
  items: string[]
}

export interface DreamCited {
  title: string
  path: string
  cited: number
  dailyMentions: number
  daysMentioned: number
  lastMentioned: string
  /** 15.2：仅在召回信号生效时出现 —— 被召回过几天 / 被几种检索命中 */
  recallDays?: number
  recallKinds?: number
}

/** 超过多少天没复核算「可考虑退役」（只做机械年龄判断） */
export const STALE_DAYS = 90
/** 退役候选最多回几条：给材料，不是给清理清单 */
export const MAX_RETIRE = 10

export interface DreamRetireCandidate {
  /** 条目首行摘要（最多 100 字） */
  entry: string
  /** YYYY-MM-DD；没有可解析的日期时为空串 */
  date: string
  /** 距今天数；无日期为 -1（不猜日期，排序时排最后） */
  age: number
  /** 来源断了优先报：那比「旧」更值得看一眼 */
  reason: 'stale' | 'source-missing' | 'source-superseded'
}

export interface DreamResult {
  notebook: string
  windowDays: number
  since: string
  /** true = 触到扫描上限，窗口与排名都不完整 */
  truncated: boolean
  /** 三态写法：complete / partial（扫描触顶）/ unknown（扫描结果无法解析） */
  completeness: Completeness
  /** 本次扫描上限（MAX_SCAN） */
  scanLimit: number
  /**
   * true = 库太大（> 生效的 `graphBudget`，默认 `graphBudgetNotes = 2000`），这次没有建全图统计入链。
   * `cited` / `citedBy` 全是 0、`topCited` 为空 —— 那是「没算」，不是「没人引」。
   * 全图 10k 要 26–31 s / 17 MB（plan §0.5.1），而 dream 给的是材料，不值得为一次汇总
   * 把工具拖过 60 s 超时；增量口径见 plan §7 G2。
   */
  graphSkipped: boolean
  /** 生效的全图统计上限（`graphBudgetNotes`，或调用方覆盖的值）：graphSkipped 是与它比出来的 */
  graphBudget: number
  /** 稳定 ID（§9.2）：缺 `id` 的非日记笔记数，只读计数，不回填 */
  missingId: number
  /** 记忆用量（与注入 / 设置页同一口径）：晋升前先知道还剩多少预算 */
  memory: MemoryUsage
  counts: {
    window: number
    daily: number
    candidates: number
    rejected: number
    looseEnds: number
    /** 窗口里已经晋升进 MEMORY.md 的篇数（移出候选、进 alreadyPromoted） */
    promoted: number
    /** 窗口之外、还没晋升、过机械门的篇数（这里只回前 MAX_BACKLOG 条） */
    backlog: number
  }
  newNotes: DreamCandidate[]
  /** 窗口内但已经在 MEMORY.md 里的：不直接丢，agent 需要知道「上周提过、这周还在」 */
  alreadyPromoted: DreamCandidate[]
  /** 窗口外仍未晋升的：漏做一次不会永久掉队 */
  backlog: DreamCandidate[]
  rejected: DreamRejection[]
  topCited: DreamCited[]
  dailyLooseEnds: DreamLooseEnds[]
  /** 机械规则筛出的「可考虑退役」条目（只给材料，不写 MEMORY.md） */
  retireCandidates: DreamRetireCandidate[]
  /** 15.2：仅在召回信号生效时出现 —— 固定比例、与分数无关的窗口外抽样，补门控正性 */
  auditSamples?: DreamCandidate[]
}

/**
 * 从日记正文里取 Loose ends 小节。
 * `- [x]` 是已完成，不收；`- [ ]` 与普通列表项都收（划掉的状态比格式重要）。
 */
export function looseEndsOf(content: string): string[] {
  const out: string[] = []
  let inside = false
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim()
    if (/^#{1,2}\s/.test(line)) {
      inside = LOOSE_HEADING.test(line)
      continue
    }
    if (!inside || !line) continue
    if (/^-\s*\[[xX]\]/.test(line)) continue
    const item = line.replace(/^[-*+]\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim()
    if (item) out.push(item)
  }
  return out
}

/**
 * 机械拒绝规则（只两条，别加语义判断）：
 *   · authority=informal —— 口头/未验证来源，进长期记忆会污染结论；
 *   · 无标签 —— 标签是唯一能确定性筛选的维度；没标签的笔记晋升后只能靠全文检索找回来
 *     （P2-7 起中文检索不再漏，但「按主题找」还是得靠标签）。
 */
export function rejectionReason(note: NoteRecord): string | null {
  if (note.authority === 'informal') return 'authority: informal（口头/未验证来源）'
  if (note.tags.length === 0) return '无标签（没有可筛选的标签，晋升后只能靠全文检索找回来）'
  return null
}

function isUnder(rel: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '')
  return rel === d || rel.startsWith(d + '/')
}

/**
 * 笔记的日历日期（计划 §2 D7 / Q6）。
 *
 * 日记补写时 `zk_daily --date` 只改文件名，zk 的 `created` 仍是今天 —— 按 created 筛窗口
 * 会把 10 月的日记算成本周新增。所以：日记看文件名，其他笔记看 frontmatter `date`，
 * 都没有才退回 created（老笔记行为不变）。
 */
export function noteDate(cfg: Config, note: NoteRecord): string {
  if (isUnder(note.path, cfg.dailyDir)) {
    const stem = path.basename(note.path, path.extname(note.path))
    if (isDayString(stem)) return stem
  } else {
    const raw = note.metadata?.date
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (isDayString(value)) return value
  }
  return localDate(note.created)
}

/** 日期字符串 → 本地零点毫秒；非法日期返回 NaN */
function dayMs(day: string): number {
  if (!isDayString(day)) return Number.NaN
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year as number, (month as number) - 1, date as number).getTime()
}

/**
 * 机械摘要：frontmatter 之后、第一个正文段落，压空白后最多 200 字。
 * 为什么不用 NoteRecord.lead：zk 的 lead 是笔记首行（通常是标题行），当摘要没有信息量。
 * 读失败就退回 lead（哪怕是标题行），不让 dream 因为一篇坏文件整批失败。
 */
function excerptOf(cfg: Config, note: NoteRecord): string {
  let body = ''
  try {
    const abs = note.absPath || path.join(cfg.notebook, note.path)
    body = parseFrontmatter(fs.readFileSync(abs, 'utf8')).body
  } catch {
    return note.lead
  }
  const parts: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) {
      if (parts.length) break
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      if (parts.length) break
      continue
    }
    parts.push(line)
    if (parts.join(' ').length >= 200) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200) || note.lead
}

/**
 * 窗口默认跟着 DREAMS.md 走：距上次做梦多少天，窗口就是多少天。
 * 固定 7 天的话，漏做一周、或隔十天再整理，窗口外的笔记就再也不会出现在任何一栏 ——
 * 那不是「这次没选上」，是「永远消失」。没有 DREAMS.md / 日期不合法 → 退回 7 天（旧行为）。
 * 显式 `--days` 仍然优先：调用方说要看几天就看几天。
 */
function windowDaysOf(cfg: Config, now: Date, explicit?: number): number {
  const clamp = (n: number): number => Math.min(365, Math.max(1, Math.trunc(n)))
  if (explicit !== undefined) return clamp(explicit)
  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'DREAMS.md'), 'utf8') } catch { return DREAM_INTERVAL_DAYS }
  const last = lastDreamDate(body)
  const days = last ? daysSinceDream(last, now) : null
  return days === null ? DREAM_INTERVAL_DAYS : clamp(days)
}

/**
 * 已晋升集合：MEMORY.md 里的 `[[链接]]` + 纯文字条目里出现的标题。
 *
 * 为什么要有第二条：真机 MEMORY.md 7 条里 6 条是纯文字（没有链接），只按链接判会漏掉它们，
 * 而它们正是每周重复出现的候选来源。标题包含只做字符串比较、且要求标题 ≥ 6 字 ——
 * 短标题（「RAG」「额度」）在任意句子里都可能撞上，宁可重复报，不猜。
 *
 * 退役条目要分开处理（D3.3，顺序不能反）：
 *   · 链接匹配用**原文** —— 退役行里的 `→ [[新结论]]` 是合法的「已晋升」指针；
 *   · 标题匹配用**去掉退役行之后**的正文 —— 退役行里的旧结论不该再算已晋升，
 *     否则归档后复用同一标题的笔记会永远进不了候选。
 */
function promotionsOf(cfg: Config, notes: NoteRecord[]): Map<string, 'link' | 'title'> {
  const out = new Map<string, 'link' | 'title'>()
  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'MEMORY.md'), 'utf8') } catch { return out }
  if (!body.trim()) return out

  const index = wikiIndex(notes)
  const byPath = new Map(notes.map((n) => [n.path, n]))
  // 代码块里的 `[[…]]` 是示例，不算「已经晋升过」
  const clean = withoutFences(body)
  for (const match of clean.matchAll(WIKI_LINK)) {
    const hit = resolveWikiTarget(cfg, String(match[1] ?? '').trim(), index)
    // 解析结果是路径，按身份键记账（§9.2）：有 id 的笔记改名后仍是同一篇，不会重复晋升。
    const note = byPath.get(hit.path)
    if (hit.status === 'live' && note) out.set(noteKey(note), 'link')
  }

  const lines = withoutFences(stripRetiredEntries(body).body).split('\n').map((line) => normalizeTitle(line)).filter(Boolean)
  for (const note of notes) {
    const key = noteKey(note)
    if (out.has(key)) continue
    const title = normalizeTitle(note.title)
    if ([...title].length < MIN_TITLE_MATCH) continue
    if (lines.some((line) => line.includes(title))) out.set(key, 'title')
  }
  return out
}

/**
 * 退役候选（D4.3）：只做机械规则，不判断「这条还有没有用」。
 *   · 有日期且超过 STALE_DAYS → stale；
 *   · 条目里的 `[[来源]]` 指向归档 / 不存在 → source-superseded / source-missing；
 *   · 显式写 `archive/` 的链接是有意引用旧结论（与 lint 同口径），不算来源断了；
 *   · 无日期、无链接的不算候选（它们已经由 lint 的 undated / unlinked 报告）。
 */
function retireCandidatesOf(cfg: Config, notes: NoteRecord[], now: Date, signal: RecallSignal): DreamRetireCandidate[] {
  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'MEMORY.md'), 'utf8') } catch { return [] }
  const index = wikiIndex(notes)
  const out: DreamRetireCandidate[] = []
  const seen = new Set<string>()

  for (const entry of splitMemoryEntries(body)) {
    if (isRetiredEntry(entry)) continue
    // 15.2：近期被召回过的条目不算退役候选 —— 门控要看得见「其实一直被用到」
    const last = lastRecallOf(signal, entry)
    if (last && (daysSinceDate(last, now) ?? Infinity) <= RECALL_PROTECT_DAYS) continue
    const date = entryDate(entry) ?? ''
    const age = date ? (daysSinceDate(date, now) ?? -1) : -1

    let reason: DreamRetireCandidate['reason'] | null = null
    for (const match of withoutFences(entry).matchAll(WIKI_LINK)) {
      const target = String(match[1] ?? '').trim()
      if (!target) continue
      const hit = resolveWikiTarget(cfg, target, index)
      // 显式写 archive/ 的链接是有意引用（supersede 就是这样重写入链的）：与 lint 一个口径，不算来源断了
      if (hit.status === 'live' || hit.explicit) continue
      reason = hit.status === 'archived' ? 'source-superseded' : 'source-missing'
      break
    }
    if (!reason && age > STALE_DAYS) reason = 'stale'
    if (!reason) continue

    const summary = (entry.split('\n', 1)[0] ?? '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    const one = summary.length > 100 ? summary.slice(0, 100) + '…' : summary
    if (!one || seen.has(one)) continue
    seen.add(one)
    out.push({ entry: one, date, age, reason })
  }

  // 越旧越靠前；无日期（-1）的排在最后（不假装它们更旧）
  out.sort((a, b) => b.age - a.age || a.entry.localeCompare(b.entry))
  return out.slice(0, MAX_RETIRE)
}

export async function dreamNotebook(
  cfg: Config,
  opts: DreamOptions = {},
  signal?: AbortSignal,
): Promise<DreamResult> {
  const now = opts.now ?? new Date()
  // 15.2：默认关 / sidecar 为空时 signalActive=false，下面所有信号相关分支都不生效，输出逐字节不变
  const recallSignal = readRecallSignal(cfg)
  const signalActive = hasRecallSignal(recallSignal)
  const windowDays = windowDaysOf(cfg, now, opts.days)
  const sinceMs = now.getTime() - windowDays * 86_400_000

  // 顺序跑：两个 zk 进程同时补索引会撞 SQLite 写锁（lint 里同样处理）
  const scan = await scanNotes(cfg, {}, signal)
  const notes = scan.notes
  // 全图在 10k 上 26–31 s / 17 MB（plan §0.5.1）：超过预算就不建，并显式告诉调用方。
  // 预算来自配置（设置页可调）；opts.graphBudget 只给测试覆盖。
  const graphBudget = Math.max(0, Math.trunc(opts.graphBudget ?? cfg.graphBudgetNotes ?? GRAPH_BUDGET_NOTES))
  const graphReady = notes.length <= graphBudget
  const edges = graphReady ? (await graphEdges(cfg, signal)).edges : []

  // 入链来源按目标分组：既算「被引几次」，也给 dream 一份上下文（谁在引它）
  const inbound = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.sourcePath === edge.targetPath) continue
    const sources = inbound.get(edge.targetPath) ?? []
    if (!sources.includes(edge.sourcePath)) sources.push(edge.sourcePath)
    inbound.set(edge.targetPath, sources)
  }
  const citedOf = (n: NoteRecord): number => inbound.get(n.path)?.length ?? 0

  // 使用信号（P2-12）：日记是本插件里唯一「按时间记录真实工作」的层，正好当召回日志用。
  // 零新增状态：来源路径与日期都在已载入的 notes / edges 里。
  const byPath = new Map(notes.map((n) => [n.path, n]))
  const usageCache = new Map<string, Pick<DreamCandidate, 'dailyMentions' | 'daysMentioned' | 'lastMentioned'>>()
  const usageOf = (rel: string): Pick<DreamCandidate, 'dailyMentions' | 'daysMentioned' | 'lastMentioned'> => {
    const cached = usageCache.get(rel)
    if (cached) return cached
    const sources = (inbound.get(rel) ?? []).filter((p) => isUnder(p, cfg.dailyDir))
    const dates = new Set<string>()
    for (const source of sources) {
      // 日记的文件名就是日期（zk 的 created 是文件创建时间，补写旧日记时会全是今天）；
      // 文件名不是日期形状（自定义模板）才退回 created。
      const stem = path.basename(source, path.extname(source))
      const day = /^\d{4}-\d{2}-\d{2}$/.test(stem) ? stem : localDate(byPath.get(source)?.created ?? '')
      if (day) dates.add(day)
    }
    const sorted = [...dates].sort()
    const value = {
      dailyMentions: sources.length,
      daysMentioned: dates.size,
      lastMentioned: sorted.length ? sorted[sorted.length - 1] : '',
    }
    usageCache.set(rel, value)
    return value
  }

  const candidateOf = (note: NoteRecord, promotedBy: 'link' | 'title' | ''): DreamCandidate => ({
    title: note.title,
    path: note.path,
    type: note.type,
    authority: note.authority,
    tags: note.tags,
    created: noteDate(cfg, note),
    lead: excerptOf(cfg, note),
    cited: citedOf(note),
    citedBy: (inbound.get(note.path) ?? []).slice(0, 5),
    promoted: promotedBy !== '',
    promotedBy,
    ...usageOf(note.path),
  })

  const promoted = promotionsOf(cfg, notes)

  const windowNotes = notes
    .filter((n) => {
      const at = dayMs(noteDate(cfg, n))
      return Number.isFinite(at) && at >= sinceMs
    })
    .sort((a, b) => noteDate(cfg, b).localeCompare(noteDate(cfg, a)))

  const newNotes: DreamCandidate[] = []
  const alreadyPromoted: DreamCandidate[] = []
  const rejected: DreamRejection[] = []
  for (const note of windowNotes) {
    // 日记不是晋升候选：它的「未完成项」走 dailyLooseEnds，报成「无标签」只会制造噪音
    if (isUnder(note.path, cfg.dailyDir)) continue
    // 已经进 MEMORY 的先说：否则每周原样重复，仪式几次之后就没人看了
    const by = promoted.get(noteKey(note))
    if (by) {
      alreadyPromoted.push(candidateOf(note, by))
      continue
    }
    const reason = rejectionReason(note)
    if (reason) {
      rejected.push({ title: note.title, path: note.path, reason })
      continue
    }
    newNotes.push(candidateOf(note, ''))
  }

  // 窗口外仍未晋升、且过机械门的：按被引数排，别让「漏做一次」变成永久掉队
  const backlogNotes = notes
    .filter((n) => {
      if (isUnder(n.path, cfg.dailyDir)) return false
      const at = dayMs(noteDate(cfg, n))
      if (Number.isFinite(at) && at >= sinceMs) return false
      if (promoted.has(noteKey(n))) return false
      return rejectionReason(n) === null
    })
    .sort((a, b) => citedOf(b) - citedOf(a) || a.title.localeCompare(b.title))

  const dailyLooseEnds: DreamLooseEnds[] = []
  let looseEndCount = 0
  for (const note of windowNotes) {
    if (!isUnder(note.path, cfg.dailyDir)) continue
    let body = ''
    try { body = fs.readFileSync(path.resolve(note.absPath || path.join(cfg.notebook, note.path)), 'utf8') } catch { continue }
    const items = looseEndsOf(body)
    if (!items.length) continue
    looseEndCount += items.length
    if (dailyLooseEnds.length < MAX_ITEMS) {
      dailyLooseEnds.push({ path: note.path, date: noteDate(cfg, note), items })
    }
  }

  // 排序说明（P2-12）：先看「被日记提过几天」—— 跨天复现比同一天多次更强；同一天多篇日记
  // 再按 dailyMentions 排，入链数只是最后的次序。没有日记的库两项都是 0，
  // 排序自动退回原来的 cited 降序（行为兼容）。
  // 15.2：信号生效时先按「召回跨天数 → 查询多样性」；全 0 时下面的次序与原排序完全一致。
  const topCited: DreamCited[] = notes
    .map((n) => {
      const r = recallSignal.byPath[n.path]
      return {
        title: n.title, path: n.path, cited: citedOf(n), ...usageOf(n.path),
        ...(r ? { recallDays: r.days.length, recallKinds: r.queryKinds.length } : {}),
      }
    })
    .filter((x) => x.cited > 0)
    .sort((a, b) =>
      (signalActive ? (b.recallDays ?? 0) - (a.recallDays ?? 0) || (b.recallKinds ?? 0) - (a.recallKinds ?? 0) : 0) ||
      b.daysMentioned - a.daysMentioned ||
      b.dailyMentions - a.dailyMentions ||
      b.cited - a.cited ||
      a.title.localeCompare(b.title),
    )
    .slice(0, TOP_CITED)

  // 15.2 审计流：固定比例、与分数无关、确定性（不看 cited / 日期，只按 path 字母序等距取样）。
  // 仅信号生效时出现，且从窗口外积压里抽 —— 没被召回过的笔记否则永远拿不到「其实有用」的证据。
  const auditSamples: DreamCandidate[] = []
  if (signalActive) {
    const pool = [...backlogNotes].sort((a, b) => a.path.localeCompare(b.path))
    const step = Math.max(1, Math.round(1 / AUDIT_RATE))
    for (let i = 0; i < pool.length; i += step) auditSamples.push(candidateOf(pool[i]!, ''))
  }

  return {
    notebook: cfg.notebook,
    windowDays,
    since: localDate(new Date(sinceMs).toISOString()),
    truncated: scan.completeness !== 'complete',
    completeness: scan.completeness,
    scanLimit: scan.limit,
    graphSkipped: !graphReady,
    graphBudget,
    // 只读计数：老笔记 / 日记没有 id 属预期，日记按日期命名、路径天然稳定，不计入
    missingId: notes.filter((n) => !n.id && !isUnder(n.path, cfg.dailyDir)).length,
    counts: {
      window: windowNotes.length,
      daily: windowNotes.filter((n) => isUnder(n.path, cfg.dailyDir)).length,
      candidates: newNotes.length,
      rejected: rejected.length,
      looseEnds: looseEndCount,
      promoted: alreadyPromoted.length,
      backlog: backlogNotes.length,
    },
    newNotes: newNotes.slice(0, MAX_ITEMS),
    alreadyPromoted: alreadyPromoted.slice(0, MAX_ITEMS),
    backlog: backlogNotes.slice(0, MAX_BACKLOG).map((n) => candidateOf(n, '')),
    rejected: rejected.slice(0, MAX_ITEMS),
    topCited,
    dailyLooseEnds,
    memory: memoryUsage(cfg),
    retireCandidates: retireCandidatesOf(cfg, notes, now, recallSignal),
    ...(signalActive ? { auditSamples } : {}),
  }
}
