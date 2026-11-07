/**
 * 死胡同探针：检索命中一篇活笔记时，顺手看归档里有没有**同一条结论**的废弃版本，带出废弃原因。
 *
 * 为什么需要（plan §14.3）：`supersede` 的旧结论被 `excludedNames` 排除出检索，
 * 只有 `zk_new` 写同名时才提示一次。于是 agent 在读 / 想的阶段看不到「这条路试过、为什么废」，
 * 只能重新踩一遍 —— 而按 HackerNoon 那条分工，死胡同复现正是最该省掉的工。
 * 这不是「不查全」的谦逊，是主动隐藏反例。
 *
 * 成本口径：**零子进程、零 zk 调用**。只读 `archive/` 下的文件（归档只放 supersede 搬进去的旧结论），
 * 按标题相似度（`lib/similar.ts` 的同一份口径）与本次命中对照。扫描量有硬顶，触顶显式报。
 *
 * 边界：不判断「是不是同一个错误」（那是 agent 的活），只做机械标题比对；
 * 不改默认结果集、不改 `completeness` 口径 —— 它是一条提示，不是第二份结果列表。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { similarKeyOf, similarScore } from './similar.ts'
import type { SimilarKey } from './similar.ts'

/** 一次最多回几条：这是提醒，不是结果列表 */
export const MAX_COUNTER_ENTRIES = 3
/** 归档最多扫多少篇（触顶置 truncated，不静默少看） */
export const MAX_ARCHIVE_SCAN = 2_000
/** 最多拿多少条本次命中当对照（结果列表可以很长，探针只取前 N 条：这是提示，不是全量比对） */
export const MAX_COUNTER_PROBES = 50

export interface CounterEntry {
  /** 挂在本次哪篇命中下面（相对路径）：0 命中时为空串 */
  matched: string
  title: string
  /** 归档里的相对路径 */
  path: string
  absPath: string
  /** supersede 时写下的原因；老笔记没写过就是空串 */
  reason: string
  /** `superseded-by` 指向的新结论（`[[…]]` 形式；没写就是空串） */
  supersededBy: string
  /** 标题相似度（两位小数） */
  score: number
}

export interface CounterEntries {
  entries: CounterEntry[]
  /** 实际读过的归档笔记数 */
  scanned: number
  /** true = 归档超过 MAX_ARCHIVE_SCAN，只看了前 N 篇（没看全 ≠ 没有） */
  truncated: boolean
}

/**
 * 人话版（工具 render 与 `zk-kit search` 共用一份措辞，免得两处写法分叉）。
 * `zeroHit` = 本次一条活笔记都没命中：要说清「没有」不等于「从来没有」。
 */
export function describeCounterEntries(
  counters: { entries: CounterEntry[]; truncated: boolean },
  opts: { zeroHit?: boolean } = {},
): string {
  const tail = counters.truncated ? '\n（归档超过扫描上限：只看了一部分，没看全 ≠ 没有）' : ''
  if (!counters.entries.length) return tail.trim() ? tail : ''
  const head = opts.zeroHit
    ? '⚠️ 没有活笔记命中，但归档里有同名旧结论（先看废弃原因，别重新提出来）：'
    : '⚠️ 归档里有同名旧结论（先看废弃原因，别重新提出来）：'
  const lines = counters.entries.map((e) => {
    const why = e.reason ? `废弃原因：${e.reason}` : '没有记录废弃原因'
    const by = e.supersededBy ? ` · 已被 ${e.supersededBy} 取代` : ''
    return `· ${e.title}（${e.path}，相似度 ${e.score}）—— ${why}${by}\n  全文：${e.absPath}`
  })
  return head + '\n' + lines.join('\n') + tail
}

interface ArchivedNote {
  title: string
  path: string
  absPath: string
  reason: string
  supersededBy: string
  key: SimilarKey
}

/** 递归列出归档里的 markdown（不用 readdirSync 的 recursive，老 Node 上没有） */
function listArchived(root: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let items: fs.Dirent[] = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const item of items) {
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) { stack.push(abs); continue }
      if (!item.isFile() || !/\.md$/i.test(item.name)) continue
      if (files.length >= limit) return { files, truncated: true }
      files.push(abs)
    }
  }
  return { files, truncated: false }
}

function readArchived(cfg: Config, abs: string): ArchivedNote | null {
  let fields: Record<string, string> = {}
  try { fields = parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields } catch { return null }
  const rel = path.relative(cfg.notebook, abs).split(path.sep).join('/')
  const title = String(fields.title ?? '').trim() || path.basename(rel, path.extname(rel))
  const key = similarKeyOf(title)
  if (!key) return null
  return {
    title,
    path: rel,
    absPath: abs,
    reason: String(fields['supersede-reason'] ?? '').trim(),
    supersededBy: String(fields['superseded-by'] ?? '').trim(),
    key,
  }
}

/**
 * 归档里与本次检索「同一条结论」的废弃版本。
 *
 * 对照对象：
 *   · 有命中 → 逐条比较命中笔记的标题（「这条结论以前被废过吗」）；
 *   · 0 命中且给了 query → 把查询词当标题比（「库里没有」不等于「从来没出现过」）。
 * 0 命中时不比较查询词以外的东西：查询词做标题比对噪声大，所以只在这一种情况下开。
 */
export function archivedCounterparts(
  cfg: Config,
  notes: Array<{ title: string; path: string }>,
  opts: { query?: string } = {},
): CounterEntries {
  const empty: CounterEntries = { entries: [], scanned: 0, truncated: false }
  const root = path.join(cfg.notebook, cfg.archiveDir)
  if (!fs.existsSync(root)) return empty

  // 对照项：命中笔记的标题；0 命中时退回查询词
  const probes: Array<{ matched: string; key: SimilarKey }> = []
  if (notes.length === 0) {
    const query = String(opts.query ?? '').trim()
    const key = query ? similarKeyOf(query) : null
    if (key) probes.push({ matched: '', key })
  } else {
    for (const note of notes.slice(0, MAX_COUNTER_PROBES)) {
      const key = similarKeyOf(note.title || '')
      if (key) probes.push({ matched: note.path, key })
    }
  }
  if (!probes.length) return empty

  const { files, truncated } = listArchived(root, MAX_ARCHIVE_SCAN)
  const archived: ArchivedNote[] = []
  for (const abs of files) {
    if (abs === root) continue
    const note = readArchived(cfg, abs)
    if (note) archived.push(note)
  }

  const picked: CounterEntry[] = []
  const seen = new Set<string>()
  for (const probe of probes) {
    for (const note of archived) {
      if (seen.has(note.path)) continue
      const score = similarScore(probe.key, note.key)
      if (score === null) continue
      seen.add(note.path)
      picked.push({
        matched: probe.matched,
        title: note.title,
        path: note.path,
        absPath: note.absPath,
        reason: note.reason,
        supersededBy: note.supersededBy,
        score,
      })
    }
  }
  picked.sort((a, b) => b.score - a.score)
  return {
    entries: picked.slice(0, MAX_COUNTER_ENTRIES),
    scanned: files.length,
    truncated,
  }
}
