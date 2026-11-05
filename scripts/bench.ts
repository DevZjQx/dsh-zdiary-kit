#!/usr/bin/env bun
/**
 * 成本表（plan §0.5 第 2 条）：每个工具一行 —— 子进程数 / zk 回传字节 / 峰值 RSS / p50 / p95 / 超时 / 超限行为。
 *
 * 为什么单独一支：夹具生成是毫秒级，成本表才是分钟级，而且 10k 的 graph / index 一行就要几十秒到几分钟。
 * 这两件事都不能进 `bun run test`（测试要快到每次提交都跑得起），也不进 `bun run check` / CI。
 * 需要时显式跑：`bun run bench`。
 *
 *   bun run bench                                  # 1k 夹具，3 轮
 *   bun run bench --notes 10000 --iterations 1     # 10k（graph 一行约 30 s/轮）
 *   bun run bench --cases search.cjk,list.2k       # 只跑几条
 *   bun run bench --out .tmp/bench.json            # 落盘，便于跨版本比
 *
 * 计数口径：
 *   · 子进程 / 字节：src/lib/exec.ts 的 execStats（只数本进程起的子进程，不含 bench 自己）
 *   · 峰值 RSS：Linux 下每 40 ms 采样 /proc 里 comm=zk 的进程；其它平台记 n/a
 *   · p50 / p95：按轮统计；iterations 越大越稳，但 10k 上代价线性增长
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { execStats } from '../src/lib/exec.ts'
import { allNotes, backlinksOf, graphEdges, notebookStats, searchNotesDetailed, zk, resolveZk } from '../src/lib/zk.ts'
import { buildMemoryPayload } from '../src/lib/memory.ts'
import { lintNotebook } from '../src/lib/lint.ts'
import { dreamNotebook } from '../src/lib/dream.ts'
import type { Config } from '../src/config/store.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Options {
  fixture: string
  notes: number
  linksPerNote: number
  iterations: number
  only: string[]
  json: boolean
  out: string
}

function usage(): string {
  return [
    '用法：bun scripts/bench.ts [--fixture DIR] [--notes N] [--links-per-note X] [--iterations N] [--cases a,b] [--json] [--out FILE]',
    '',
    '  --fixture DIR        用哪个夹具（默认 .tmp/fixture/<notes>-<links>，不存在就先生成）',
    '  --notes N            夹具篇数（默认 1000）',
    '  --links-per-note X   夹具链接密度（默认 1）',
    '  --iterations N       每条用例跑几轮（默认 3；10k 上建议 1）',
    '  --cases a,b          只跑指定用例（见 --list）',
    '  --list               列出全部用例',
    '  --json               只输出 JSON',
    '  --out FILE           把 JSON 结果写到文件',
  ].join('\n')
}

function parseArgs(argv: string[]): Options {
  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new Error('不是合法数字：' + v)
    return n
  }
  const o: Options = { fixture: '', notes: 1000, linksPerNote: 1, iterations: 3, only: [], json: false, out: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const take = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(arg + ' 需要一个值')
      return v
    }
    if (arg === '--fixture') o.fixture = take()
    else if (arg === '--notes') o.notes = Math.trunc(num(take(), 1000))
    else if (arg === '--links-per-note') o.linksPerNote = num(take(), 1)
    else if (arg === '--iterations') o.iterations = Math.max(1, Math.trunc(num(take(), 3)))
    else if (arg === '--cases') o.only = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--json') o.json = true
    else if (arg === '--out') o.out = take()
    else if (arg === '--list') { console.log(CASES.map((c) => c.id.padEnd(19) + c.what).join('\n')); process.exit(0) }
    else if (arg === '-h' || arg === '--help') { console.log(usage()); process.exit(0) }
    else throw new Error('不认识的参数：' + arg + '\n\n' + usage())
  }
  if (!o.fixture) {
    const tag = (n: number): string => (n >= 1000 ? n / 1000 + 'k' : String(n))
    o.fixture = path.join(ROOT, '.tmp/fixture', tag(o.notes) + '-' + o.linksPerNote)
  }
  o.fixture = path.resolve(o.fixture)
  return o
}

function makeConfig(dir: string): Config {
  return {
    notebook: dir,
    notebooks: { default: { path: dir, structure: 'layered' } },
    active: 'default',
    structure: 'layered',
    notesDir: 'notes',
    dailyDir: 'journal',
    dailyGroup: 'daily',
    defaultTags: [],
    maxReadChars: 20_000,
    aliasTools: false,
    memoryBudgetWords: 500,
    personaBudgetWords: 240,
    graphBudgetNotes: 2_000,
    archiveDir: 'archive',
    zkVersion: '0.15.7',
    zkPath: process.env.ZK_BIN ?? '',
  }
}

/** 一条用例 = 一次工具调用。truncated 由该工具自己的口径给：列表看条数，图看它自己的标志 */
interface Case {
  id: string
  tool: string
  what: string
  timeoutMs: number
  iterations?: number
  run: (ctx: Ctx) => CaseOutcome | Promise<CaseOutcome>
}

interface Ctx {
  cfg: Config
  sample: string
}

type CaseOutcome = { truncated?: boolean; count?: number } | void

const CASES: Case[] = [
  {
    id: 'search.cjk',
    tool: 'zk_search',
    what: '中文检索（插件双跑：FTS + -M re）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const r = await searchNotesDetailed(cfg, { query: '记忆', limit: 10 })
      return { count: r.notes.length, truncated: r.notes.length >= 10 }
    },
  },
  {
    id: 'search.cjk.single',
    tool: 'zk_search',
    what: '中文检索单进程（只用 FTS）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const out = await zk(cfg, ['list', '--quiet', '--no-pager', '--format', 'json', '--limit', '10', '--match', '记忆'])
      return { truncated: false, count: out.length }
    },
  },
  {
    id: 'search.ascii',
    tool: 'zk_search',
    what: '英文检索（单进程）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const r = await searchNotesDetailed(cfg, { query: 'index', limit: 10 })
      return { count: r.notes.length }
    },
  },
  {
    id: 'list.10k',
    tool: 'zk_search / 首页',
    what: '全量列笔记（--format json --limit 10000）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const notes = await allNotes(cfg, { limit: 10_000 })
      return { count: notes.length, truncated: notes.length >= 10_000 }
    },
  },
  {
    id: 'list.2k',
    tool: '首页 / 标签页',
    what: 'INDEX_LIMIT 现取值（--limit 2000）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const notes = await allNotes(cfg, { limit: 2000 })
      return { count: notes.length, truncated: notes.length >= 2000 }
    },
  },
  {
    id: 'list.200',
    tool: 'zk_search',
    what: '静默天花板（--limit 200）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const notes = await allNotes(cfg, { limit: 200 })
      return { count: notes.length, truncated: notes.length >= 200 }
    },
  },
  {
    id: 'graph.full',
    tool: 'bidi / zk_lint',
    what: '全图（--format json --limit 10000）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const g = await graphEdges(cfg, undefined, { limit: 10_000 })
      return { count: g.edges.length, truncated: g.truncated }
    },
  },
  {
    id: 'lint',
    tool: 'zk_lint',
    what: '整次巡检（含单向链接的边：小库全图 / 大库按篇反查）',
    timeoutMs: 180_000,
    run: async ({ cfg }) => {
      const r = await lintNotebook(cfg)
      return { count: r.notes, truncated: r.truncated || r.oneWayLinks.edgesTruncated }
    },
  },
  {
    id: 'dream',
    tool: 'zk_dream',
    what: '晋升材料（超过全图统计上限时跳过全图：graphSkipped）',
    timeoutMs: 180_000,
    run: async ({ cfg }) => {
      const r = await dreamNotebook(cfg)
      return { count: r.counts.window, truncated: r.truncated || r.graphSkipped }
    },
  },
  {
    id: 'backlinks',
    tool: 'bidi',
    what: '按篇反查（backlinksOf / --link-to，默认 200 条）',
    timeoutMs: 60_000,
    run: async ({ cfg, sample }) => {
      // 必须走生产入口：手写 --link-to + 相对路径时，路径按 **bench 的 cwd** 解析；
      // 不存在就会丢掉过滤条件返回全库（plan §0.5.1 的坑），测出来的不是反查。
      const r = await backlinksOf(cfg, sample)
      return { count: r.notes.length, truncated: r.truncated }
    },
  },
  {
    id: 'stats',
    tool: 'zk_stats',
    what: '统计（篇数 / 目录 / 标签）',
    timeoutMs: 60_000,
    run: async ({ cfg }) => {
      const s = await notebookStats(cfg)
      return { count: s.notes ?? 0 }
    },
  },
  {
    id: 'context',
    tool: 'zk_context',
    what: '记忆注入载荷（纯 JS，不起 zk）',
    timeoutMs: 0,
    iterations: 1,
    run: ({ cfg }) => {
      const p = buildMemoryPayload(cfg)
      return { count: p.words }
    },
  },
  {
    id: 'index.warm',
    tool: 'zk-kit index',
    what: '增量索引（无改动）',
    timeoutMs: 120_000,
    run: async ({ cfg }) => {
      await zk(cfg, ['index', '--quiet'], { timeoutMs: 120_000 })
    },
  },
]

/** Linux 下采样 comm=zk 的峰值 RSS；其它平台返回 null */
function startRssSampler(): { stop: () => number | null } {
  if (process.platform !== 'linux') return { stop: () => null }
  let peak = 0
  let seen = false
  const tick = (): void => {
    let pids: string[]
    try { pids = fs.readdirSync('/proc') } catch { return }
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue
      let comm = ''
      try { comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim() } catch { continue }
      if (comm !== 'zk') continue
      try {
        const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'))
        if (m) {
          const kb = Number(m[1])
          if (kb > peak) peak = kb
          seen = true
        }
      } catch { /* 进程退出了 */ }
    }
  }
  tick()
  const timer = setInterval(tick, 40)
  return { stop: () => { clearInterval(timer); tick(); return seen ? peak : null } }
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

/** 终端宽度：中文按 2 列算，否则表格会错位 */
function width(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u1100-\uFFDC\u3000-\u9FFF]/.test(ch) ? 2 : 1
  return w
}
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - width(s)))
const cut = (s: string, n: number): string => (width(s) <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…')
/** 毫秒超过 1 s 就换单位：10k 的 graph 是五位数毫秒，挤在一列里读不出来 */
const fmtMs = (ms: number): string => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms')

function ensureFixture(opts: Options): void {
  const cfgFile = path.join(opts.fixture, '.zk/config.toml')
  if (!fs.existsSync(cfgFile)) {
    if (opts.json) process.stderr.write('· 生成夹具 ' + opts.fixture + '\n')
    else console.log('· 生成夹具 ' + opts.fixture)
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/fixture.ts'),
      '--notes', String(opts.notes), '--links-per-note', String(opts.linksPerNote),
      '--out', opts.fixture], { cwd: ROOT, encoding: 'utf8' })
    if (r.status !== 0) throw new Error('夹具生成失败：' + (r.stderr || r.stdout))
  }
}

function pickSample(dir: string): string {
  const candidates = ['notes/concepts', 'notes', 'journal', '.']
  for (const rel of candidates) {
    const abs = path.join(dir, rel)
    if (!fs.existsSync(abs)) continue
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.endsWith('.md')) return path.posix.join(rel === '.' ? '' : rel, name)
    }
  }
  return ''
}

interface RowResult {
  id: string
  tool: string
  what: string
  calls: number
  bytes: number
  p50Ms: number
  p95Ms: number
  peakRssKb: number | null
  timeoutMs: number
  truncated: boolean | null
  count: number | null
  error?: string
}

async function runCase(c: Case, ctx: Ctx, iterations: number): Promise<RowResult> {
  const runs: number[] = []
  let calls = 0
  let bytes = 0
  let peakRss: number | null = null
  let truncated: boolean | null = null
  let count: number | null = null
  let error: string | undefined

  for (let i = 0; i < iterations; i++) {
    execStats.calls = 0
    execStats.bytes = 0
    const rss = startRssSampler()
    const t0 = performance.now()
    try {
      const r = await c.run(ctx)
      const taken = rss.stop()
      if (taken !== null) peakRss = Math.max(peakRss ?? 0, taken)
      if (r) {
        if (r.truncated !== undefined) truncated = r.truncated
        if (r.count !== undefined) count = r.count
      }
    } catch (err) {
      rss.stop()
      error = err instanceof Error ? err.message : String(err)
      break
    }
    runs.push(performance.now() - t0)
    calls = Math.max(calls, execStats.calls)
    bytes = Math.max(bytes, execStats.bytes)
  }

  return {
    id: c.id, tool: c.tool, what: c.what,
    calls, bytes, peakRssKb: peakRss, timeoutMs: c.timeoutMs,
    p50Ms: Math.round(pct(runs, 0.5) * 10) / 10,
    p95Ms: Math.round(pct(runs, 0.95) * 10) / 10,
    truncated, count, error,
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  ensureFixture(opts)

  const cfg = makeConfig(opts.fixture)
  const loc = await resolveZk(cfg)
  if (!loc) throw new Error('找不到 zk：给 ZK_BIN，或先装内置 zk')

  // 索引缺失时先建（10k 上这一步可能几分钟）：否则第一条用例会把建库算进自己的耗时
  const db = path.join(opts.fixture, '.zk/notebook.db')
  let coldIndexMs: number | null = null
  if (!fs.existsSync(db)) {
    const t0 = performance.now()
    await zk(cfg, ['index', '--quiet'], { timeoutMs: 30 * 60_000 })
    coldIndexMs = Math.round(performance.now() - t0)
    if (!opts.json) console.log('· 冷建索引 ' + (coldIndexMs / 1000).toFixed(1) + ' s')
  }

  const ctx: Ctx = { cfg, sample: pickSample(opts.fixture) }
  const cases = opts.only.length > 0 ? CASES.filter((c) => opts.only.includes(c.id)) : CASES
  if (cases.length === 0) throw new Error('--cases 没有匹配：' + opts.only.join(','))
  const missing = opts.only.filter((id) => !CASES.some((c) => c.id === id))
  if (missing.length > 0) throw new Error('未知用例：' + missing.join('、') + '（--list 看全部）')

  const rows: RowResult[] = []
  for (const c of cases) {
    if (!opts.json) process.stderr.write('· ' + c.id + ' …\n')
    rows.push(await runCase(c, ctx, c.iterations ?? opts.iterations))
  }

  const summary = {
    fixture: opts.fixture,
    notes: opts.notes,
    linksPerNote: opts.linksPerNote,
    iterations: opts.iterations,
    zk: { bin: loc.bin, version: loc.version, source: loc.source },
    platform: process.platform + '/' + process.arch,
    coldIndexMs,
    rows,
  }
  const text = JSON.stringify(summary, null, 2) + '\n'
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), text)
  if (opts.json) { process.stdout.write(text); return }

  console.log('')
  console.log('夹具 ' + opts.fixture + '（' + opts.notes + ' 篇 / ' + opts.linksPerNote + ' 链/篇）· zk ' +
    loc.version + ' · ' + opts.iterations + ' 轮' + (coldIndexMs !== null ? ' · 冷建 ' + (coldIndexMs / 1000).toFixed(1) + ' s' : ''))
  const head = ['用例', '工具', '子进程', '字节', 'p50', 'p95', '峰值RSS', '超时', '超限']
  const widths = [19, 20, 8, 10, 10, 10, 9, 7, 8]
  console.log(head.map((h, i) => pad(h, widths[i]!)).join(''))
  console.log(widths.map((w) => '-'.repeat(w)).join(''))
  for (const r of rows) {
    const rss = r.peakRssKb === null ? 'n/a' : (r.peakRssKb / 1024).toFixed(0) + ' MB'
    const trunc = r.truncated === null ? '-' : r.truncated ? 'partial' : 'complete'
    const line = [
      pad(r.id, widths[0]!),
      pad(cut(r.tool, 17), widths[1]!),
      pad(String(r.calls), widths[2]!),
      pad(r.bytes >= 1024 * 1024 ? (r.bytes / 1048576).toFixed(1) + ' MB' : (r.bytes / 1024).toFixed(0) + ' KB', widths[3]!),
      pad(fmtMs(r.p50Ms), widths[4]!),
      pad(fmtMs(r.p95Ms), widths[5]!),
      pad(rss, widths[6]!),
      pad(r.timeoutMs ? r.timeoutMs / 1000 + ' s' : '-', widths[7]!),
      pad(trunc, widths[8]!),
    ].join('')
    console.log(line + (r.error ? '  ✗ ' + cut(r.error, 60) : ''))
  }
  console.log('')
  console.log('口径：子进程/字节来自 execStats（本进程），RSS 是 comm=zk 的采样峰值，p95 = 第 ⌈0.95n⌉ 轮。')
}

main().catch((err) => {
  console.error('✗ ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
