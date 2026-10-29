/**
 * 做梦（M3）：只给材料，不写任何文件（计划 §3 D5 / D7）。
 *
 * 晋升 MEMORY.md、写 DREAMS.md 都是 agent 的语义活；这里只做三件机械事：
 *   · 最近 N 天新增的笔记（按机械规则挡掉不可晋升的，附原因；日记不算候选，它的未完成项单独一栏）；
 *   · daily 里 `## Loose ends` 小节还没划掉的项；
 *   · 被引用最多的笔记（一次 `zk graph` 数入链）。
 * 「rejected」是机械规则，不是相关性判断：authority=informal 与无标签两条，别再加。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import type { NoteRecord } from './zk.ts'
import { allNotes, graphEdges, localDate, MAX_SCAN } from './zk.ts'

/** 每栏最多回多少条（计划 §4 M3 的 50 条上限） */
export const MAX_ITEMS = 50
/** topCited 只取前几名：给 agent 一个「本周被反复引用」的提示，不是排行榜 */
export const TOP_CITED = 10

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
  /** 窗口天数（默认 7） */
  days?: number
  /** 测试用；默认 now */
  now?: Date
}

export interface DreamCandidate {
  title: string
  path: string
  type: string
  authority: string
  tags: string[]
  created: string
  /** 入链数（被多少篇笔记链接） */
  cited: number
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
}

export interface DreamResult {
  notebook: string
  windowDays: number
  since: string
  /** true = 触到扫描上限，窗口与排名都不完整 */
  truncated: boolean
  counts: { window: number; daily: number; candidates: number; rejected: number; looseEnds: number }
  newNotes: DreamCandidate[]
  rejected: DreamRejection[]
  topCited: DreamCited[]
  dailyLooseEnds: DreamLooseEnds[]
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
 *   · 无标签 —— Z12 下中文正文召回不完整，没标签的笔记晋升后照样搜不到。
 */
export function rejectionReason(note: NoteRecord): string | null {
  if (note.authority === 'informal') return 'authority: informal（口头/未验证来源）'
  if (note.tags.length === 0) return '无标签（中文正文召回不完整，晋升后也搜不到）'
  return null
}

function isUnder(rel: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '')
  return rel === d || rel.startsWith(d + '/')
}

export async function dreamNotebook(
  cfg: Config,
  opts: DreamOptions = {},
  signal?: AbortSignal,
): Promise<DreamResult> {
  const windowDays = Math.min(365, Math.max(1, Math.trunc(opts.days ?? 7)))
  const now = opts.now ?? new Date()
  const sinceMs = now.getTime() - windowDays * 86_400_000

  // 顺序跑：两个 zk 进程同时补索引会撞 SQLite 写锁（lint 里同样处理）
  const notes = await allNotes(cfg, {}, signal)
  const edges = await graphEdges(cfg, signal)

  const inbound = new Map<string, number>()
  for (const edge of edges) {
    if (edge.sourcePath === edge.targetPath) continue
    inbound.set(edge.targetPath, (inbound.get(edge.targetPath) ?? 0) + 1)
  }
  const citedOf = (n: NoteRecord): number => inbound.get(n.path) ?? 0

  const windowNotes = notes
    .filter((n) => {
      const at = Date.parse(n.created)
      return Number.isFinite(at) && at >= sinceMs
    })
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))

  const newNotes: DreamCandidate[] = []
  const rejected: DreamRejection[] = []
  for (const note of windowNotes) {
    // 日记不是晋升候选：它的「未完成项」走 dailyLooseEnds，报成「无标签」只会制造噪音
    if (isUnder(note.path, cfg.dailyDir)) continue
    const reason = rejectionReason(note)
    if (reason) {
      rejected.push({ title: note.title, path: note.path, reason })
      continue
    }
    newNotes.push({
      title: note.title,
      path: note.path,
      type: note.type,
      authority: note.authority,
      tags: note.tags,
      created: localDate(note.created),
      cited: citedOf(note),
    })
  }

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
      dailyLooseEnds.push({ path: note.path, date: localDate(note.created), items })
    }
  }

  const topCited: DreamCited[] = notes
    .map((n) => ({ title: n.title, path: n.path, cited: citedOf(n) }))
    .filter((x) => x.cited > 0)
    .sort((a, b) => b.cited - a.cited || a.title.localeCompare(b.title))
    .slice(0, TOP_CITED)

  return {
    notebook: cfg.notebook,
    windowDays,
    since: localDate(new Date(sinceMs).toISOString()),
    truncated: notes.length >= MAX_SCAN,
    counts: {
      window: windowNotes.length,
      daily: windowNotes.filter((n) => isUnder(n.path, cfg.dailyDir)).length,
      candidates: newNotes.length,
      rejected: rejected.length,
      looseEnds: looseEndCount,
    },
    newNotes: newNotes.slice(0, MAX_ITEMS),
    rejected: rejected.slice(0, MAX_ITEMS),
    topCited,
    dailyLooseEnds,
  }
}
