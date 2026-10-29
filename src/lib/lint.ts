/**
 * 巡检（M3）：只报告，不改任何笔记（计划 §3 D5）。
 *
 * 一次 `zk list` 拿全量，再用 zk 原生的三个过滤器（孤儿 / 断链 / 缺反链）各跑一次进程；
 * 「陈旧」与「重名」在 JS 里算。200 条笔记上 4 次进程就够 —— 不允许按笔记逐条跑 zk。
 *
 * 「陈旧」为什么自己算：zk 的 `stale` 不是内置过滤器，`zk list stale` 只在你自己的
 * `[filter]` 里定义过才存在（Z3 只说了位置参数语法，没说它是内置的）。所以阈值由插件定。
 *
 * 孤儿与无标签**不含日记**：日记按天写，天然没有入链、也没有标签，
 * 全报出来只会把真正的问题（断链、缺反链）淹掉。断链与缺反链仍包含日记 —— 那里出错是真问题。
 */
import path from 'node:path'
import type { Config } from '../config/store.ts'
import type { NoteRecord } from './zk.ts'
import { allNotes, localDate, MAX_SCAN, notesWithFlag } from './zk.ts'

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

export interface LintOptions {
  /** 多少天没修改算陈旧（默认 90） */
  staleDays?: number
  /** 测试用；默认 now */
  now?: Date
}

export interface LintResult {
  notebook: string
  /** 参与巡检的笔记数（已排除 raw / inbox / archive / meta 文件） */
  notes: number
  /** true = 触到扫描上限，结果不完整（别当成「只有这些问题」） */
  truncated: boolean
  staleDays: number
  orphans: LintBucket
  brokenLinks: LintBucket
  stale: LintStaleBucket
  tagless: LintBucket
  missingBacklink: LintBucket
  duplicateTitles: LintDuplicateBucket
}

/** 标题归一化只压空白与大小写，不改字（中文不受影响，也不会把「A B」和「AB」当成同一个） */
export function normalizeTitle(title: string): string {
  return String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

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
  const notes = await allNotes(cfg, {}, signal)
  const orphanAbs = await notesWithFlag(cfg, '--orphan', signal)
  const brokenAbs = await notesWithFlag(cfg, '--broken-links', signal)
  const missingAbs = await notesWithFlag(cfg, '--missing-backlink', signal)
  const taglessAbs = await notesWithFlag(cfg, '--tagless', signal)

  const dailyAbs = path.resolve(cfg.notebook, cfg.dailyDir)
  const isDaily = (abs: string): boolean =>
    path.resolve(abs) === dailyAbs || path.resolve(abs).startsWith(dailyAbs + path.sep)

  const byAbs = new Map(notes.map((n) => [path.resolve(n.absPath || n.path), n]))
  const bucket = (absPaths: string[], max = MAX_ITEMS): LintBucket => {
    const items = absPaths
      .map((abs) => byAbs.get(path.resolve(abs)))
      .filter((n): n is NoteRecord => Boolean(n))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, max)
      .map((n) => ({ title: n.title, path: n.path }))
    return { total: absPaths.length, items }
  }

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

  return {
    notebook: cfg.notebook,
    notes: notes.length,
    truncated: notes.length >= MAX_SCAN,
    staleDays,
    orphans: bucket(orphanAbs.filter((abs) => !isDaily(abs))),
    brokenLinks: bucket(brokenAbs),
    stale,
    tagless: bucket(taglessAbs.filter((abs) => !isDaily(abs))),
    missingBacklink: bucket(missingAbs),
    duplicateTitles: duplicateTitles(notes),
  }
}
