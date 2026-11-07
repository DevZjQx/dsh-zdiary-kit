/**
 * 本地聚合计数（**不是** usage 日志）：只数「哪个工具被调了几次」，不记查询词、不记路径、不上报。
 *
 * 为什么需要（plan §14.4）：到 3.9.0 为止，入口 / 一跳的验收全是机械口径
 * （子进程数、传输字节、schema、与 `graph` 对账），没有一条问「这条路有没有被真的用上」。
 * 于是「补入口 + 遍历」只能靠论证说它对。这里给出唯一可观测的代理：
 * `zk_stats` 里的 `usage`，发布后过一段时间看 `walk` / `entryPoints` / `counterEntries` 有没有涨。
 *
 * 口径：
 *   · 只加不减，`since` 是第一次计数的时间；没有文件就是全 0。
 *   · 写入失败一律吞掉 —— 计数不能把工具调用弄失败，也不能让工具输出看起来成功/失败。
 *   · 原子写（tmp + rename），并发调用最多丢一两次计数（计数器，不是账本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'

/** 落在 `.zk/` 里：与 `dsh-index-state.json` 同级，不进 zk 索引 */
export const USAGE_FILE = path.join('.zk', 'dsh-usage.json')

/** 计数的键（只增不改名，否则历史数据对不上） */
export type UsageKey =
  | 'search' | 'query' | 'recall' | 'walk'
  | 'entryPoints' | 'counterEntries'

export interface Usage {
  /** 第一次计数的时间（ISO）；空串 = 还没有任何计数 */
  since: string
  counts: Record<string, number>
}

export function readUsage(cfg: Config): Usage {
  const file = path.join(cfg.notebook, USAGE_FILE)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { since?: unknown; counts?: unknown }
    const counts: Record<string, number> = {}
    if (raw && typeof raw.counts === 'object' && raw.counts) {
      for (const [key, value] of Object.entries(raw.counts as Record<string, unknown>)) {
        const n = Number(value)
        if (Number.isFinite(n) && n >= 0) counts[key] = Math.trunc(n)
      }
    }
    return { since: typeof raw?.since === 'string' ? raw.since : '', counts }
  } catch {
    return { since: '', counts: {} }
  }
}

/**
 * 给若干键各 +1。`keys` 为空直接返回（不白读文件）。
 * 失败静默：笔记本只读 / 磁盘满 / 有人同时在写 —— 都不该影响这次工具调用。
 */
export function bumpUsage(cfg: Config, keys: UsageKey[]): void {
  if (!keys.length || !cfg.notebook) return
  const file = path.join(cfg.notebook, USAGE_FILE)
  const usage = readUsage(cfg)
  const since = usage.since || new Date().toISOString()
  for (const key of keys) usage.counts[key] = (usage.counts[key] ?? 0) + 1
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, since, counts: usage.counts }), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 连清理都失败就只能算了 */ }
  }
}
