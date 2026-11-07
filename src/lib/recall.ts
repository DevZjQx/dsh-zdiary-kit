/**
 * R4 召回装配层（docs/plan.md §7 R4 / §10.4 第 5 项）。
 *
 * 检索（R1–R3）之后按词数预算把命中笔记拼成一段可直接读的上下文：
 * 只做机械装配，不读全文、不做语义判断 / LLM rerank、不跨回合 dedup、不新增 zk 进程。
 * 预算放不下就整条丢弃（不切半句），检索侧的三态一并透出，免得「装配过的」被当成「全部命中」。
 */
import type { Config } from '../config/store.ts'
import { countWords } from './memory.ts'
import { searchNotesDetailed } from './zk.ts'
import type { Completeness, NoteRecord, SearchOptions } from './zk.ts'

export interface RecallOptions extends SearchOptions {
  /** 词数预算（countWords 口径：CJK 2 字 1 词）；缺省 500，夹紧到 1–5000 */
  budget?: number
}

export type RecallReason = 'included' | 'duplicate' | 'empty' | 'over-budget'

export interface RecallNote {
  title: string
  path: string
  absPath: string
  included: boolean
  reason: RecallReason
}

export interface RecallResult {
  text: string
  used: number
  budget: number
  /** 沿用检索侧三态：装配只覆盖本次检索到的候选，不代表库里没有别的 */
  completeness: Completeness
  hasMore: boolean
  notes: RecallNote[]
}

export const DEFAULT_RECALL_BUDGET = 500
export const MAX_RECALL_BUDGET = 5_000
export const DEFAULT_RECALL_LIMIT = 30
export const MAX_RECALL_LIMIT = 200

/** 分组键：type 优先，其次首个标签，都没有归「未分类」。分组只决定装配的轮转顺序，组内保持检索顺序 */
function groupOf(n: NoteRecord): string {
  if (n.type) return n.type
  if (n.tags.length) return '#' + n.tags[0]
  return '未分类'
}

/** 各轮转一次地取：预算不会被排在最前的那一类全吃掉 */
function roundRobin(notes: NoteRecord[]): NoteRecord[] {
  const groups = new Map<string, NoteRecord[]>()
  for (const n of notes) {
    const key = groupOf(n)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(n)
  }
  const queues = [...groups.values()]
  const out: NoteRecord[] = []
  for (let round = 0; out.length < notes.length; round += 1) {
    let added = false
    for (const q of queues) {
      if (q[round]) { out.push(q[round]); added = true }
    }
    if (!added) break
  }
  return out
}

/** 与 feature.ts 的 detailOf 同口径：snippet 比 lead 多带命中上下文时优先用它 */
function detailOf(n: NoteRecord): string {
  return n.snippet && n.snippet !== n.lead ? n.snippet : (n.lead ?? '')
}

function entryText(n: NoteRecord, index: number): string {
  const badges = [n.type, ...n.tags.map((t) => '#' + t)].filter(Boolean)
  const meta = [n.absPath || n.path, `全文 ${n.words} 词`, ...badges].filter(Boolean).join(' · ')
  const detail = detailOf(n)
  return `## ${index + 1}. ${n.title || n.path}\n${meta}${detail ? '\n\n' + detail : ''}`
}

/**
 * 一次检索 + 内存装配。候选数由 opts.limit 决定（缺省 30），不再为装配多起一个 zk 进程；
 * 每条附 absPath，需要全文时仍由宿主原生 read 取。
 */
export async function assembleRecall(cfg: Config, opts: RecallOptions = {}, signal?: AbortSignal): Promise<RecallResult> {
  const budget = Math.min(MAX_RECALL_BUDGET, Math.max(1, Math.trunc(Number(opts.budget) || DEFAULT_RECALL_BUDGET)))
  const limit = Math.min(MAX_RECALL_LIMIT, Math.max(1, Math.trunc(Number(opts.limit) || DEFAULT_RECALL_LIMIT)))
  const result = await searchNotesDetailed(cfg, {
    ...opts,
    limit,
    sort: opts.sort ?? (opts.query ? 'relevance' : 'created-desc'),
  }, signal)

  const items: RecallNote[] = []
  const seen = new Set<string>()
  let text = ''
  let used = 0
  let index = 0
  for (const n of roundRobin(result.notes)) {
    const note: RecallNote = {
      title: n.title, path: n.path, absPath: n.absPath, included: false, reason: 'over-budget',
    }
    if (seen.has(n.path)) {
      note.reason = 'duplicate'
      items.push(note)
      continue
    }
    seen.add(n.path)
    const detail = detailOf(n)
    if (!n.title && !detail) {
      note.reason = 'empty'
      items.push(note)
      continue
    }
    const entry = entryText(n, index)
    // 整条试算：分隔符也计入预算，且 countWords 的 CJK 边界让逐条累加不准，直接算整段最稳
    const candidate = text ? text + '\n\n' + entry : entry
    const words = countWords(candidate)
    if (words > budget) {
      note.reason = 'over-budget'
      items.push(note)
      continue
    }
    text = candidate
    used = words
    note.included = true
    note.reason = 'included'
    index += 1
    items.push(note)
  }

  return {
    text, used, budget,
    completeness: result.completeness,
    hasMore: result.hasMore,
    notes: items,
  }
}
