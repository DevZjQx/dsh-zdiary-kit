#!/usr/bin/env bun
/**
 * 规模夹具：生成 1k / 10k 的笔记库，给成本表与三态回归提供**可重复**的基线（plan §0.5）。
 *
 * 为什么链接密度是参数：2026-11-05 实测建索引成本 ≈ 6.6 s + 26 ms × 链接数，与篇数弱相关
 * （同 10k 篇：0 链 6.6 s、10.4k 链 275 s）。只按篇数生成的夹具会把最贵的两条路径
 * （链接解析、全图）测成很便宜，结论就会反过来。
 *
 *   bun scripts/fixture.ts                                   # 1k 篇，1 链/篇 → .tmp/fixture/1k-1
 *   bun scripts/fixture.ts --notes 10000 --links-per-note 3   # 稠密档
 *   bun scripts/fixture.ts --notes 10000 --links-per-note 0.2 --out /data/fx/10k-sparse
 *
 * 产出目录自带 .zk/config.toml：`cd <out> && zk index` 就能用，不需要先 zk init。
 * 重新生成要 `--force`，且只删带 .fixture.json 标记的目录 —— 防手滑把真笔记本当夹具清掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Options {
  notes: number
  linksPerNote: number
  seed: number
  out: string
  force: boolean
  json: boolean
}

function usage(): string {
  return [
    '用法：bun scripts/fixture.ts [--notes N] [--links-per-note X] [--seed N] [--out DIR] [--force] [--json]',
    '',
    '  --notes N            总篇数（默认 1000，最小 50）',
    '  --links-per-note X   平均每条笔记的 wiki 链接数（默认 1；0 = 无链，3 = 稠密）',
    '  --seed N             随机种子（默认 42）',
    '  --out DIR            产出目录（默认 .tmp/fixture/<notes>-<links>）',
    '  --force              覆盖已有夹具（只删带 .fixture.json 标记的目录）',
    '  --json               只输出 JSON 摘要',
  ].join('\n')
}

function parseArgs(argv: string[]): Options {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) throw new Error('不是合法数字：' + raw)
    return n
  }
  const opts: Options = { notes: 1000, linksPerNote: 1, seed: 42, out: '', force: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const take = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(arg + ' 需要一个值')
      return v
    }
    if (arg === '--notes') opts.notes = Math.trunc(num(take(), 1000))
    else if (arg === '--links-per-note') opts.linksPerNote = num(take(), 1)
    else if (arg === '--seed') opts.seed = Math.trunc(num(take(), 42))
    else if (arg === '--out') opts.out = take()
    else if (arg === '--force') opts.force = true
    else if (arg === '--json') opts.json = true
    else if (arg === '-h' || arg === '--help') { console.log(usage()); process.exit(0) }
    else throw new Error('不认识的参数：' + arg + '\n\n' + usage())
  }
  if (opts.notes < 50) throw new Error('--notes 至少 50：再小比例就失真了')
  if (opts.linksPerNote > 10) throw new Error('--links-per-note 上限 10：再高不是真实库的形状')
  if (!opts.out) {
    const tag = (n: number): string => (n >= 1000 ? n / 1000 + 'k' : String(n))
    opts.out = path.join(ROOT, '.tmp/fixture', tag(opts.notes) + '-' + opts.linksPerNote)
  }
  opts.out = path.resolve(opts.out)
  return opts
}

/** 固定种子的 mulberry32：内容、标题、链接分布全部由它决定，换机器也不变 */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOPICS = ['检索', '记忆', '索引', '写路径', '日程', '双链', '标签', '归档', '周审', '注入',
  '预算', '冲突', '摘要', '同步', '模板', '链接', '搜索', '排序', '导入', '导出']
const QUALIFIERS = ['方法', '记录', '笔记', '拆解', '观察', '边界', '取舍', '回放']
const WORDS = ['瓶颈', '信号', '采样', '耦合', '退化', '灰度', '基线', '回滚', '阈值', '召回',
  '精度', '延迟', '吞吐', '一致', '幂等', '冗余']
const ACTIONS = ['先把口径写死', '再按位置分桶', '先量后改', '不引入新依赖', '只警告不阻断',
  '改成显式失败', '保留旧字段', '让失败可见']
const CONNECTORS = ['的', '与', '或', '和']
const ASCII = ['index', 'budget', 'recall', 'graph', 'alias', 'lint', 'dream', 'memory']

const DATE_START = Date.UTC(2021, 0, 1)
const DAY = 86_400_000
const dayOf = (i: number): string => new Date(DATE_START + i * DAY).toISOString().slice(0, 10)

function slug(raw: string): string {
  return raw.replace(/[\\/:*?"<>|#\[\]]/g, '').replace(/\s+/g, '-').slice(0, 60)
}

function sentence(rnd: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(TOPICS[Math.floor(rnd() * TOPICS.length)]! + CONNECTORS[Math.floor(rnd() * CONNECTORS.length)]! +
      WORDS[Math.floor(rnd() * WORDS.length)]! + '，' + ACTIONS[Math.floor(rnd() * ACTIONS.length)]! + '。')
  }
  return out.join('')
}

function asciiLine(rnd: () => number): string {
  const pick = (): string => ASCII[Math.floor(rnd() * ASCII.length)]!
  return 'Run ' + pick() + ' then ' + pick() + ' on the ' + pick() + ' pass.'
}

function frontmatter(fields: Array<[string, string]>): string {
  return '---\n' + fields.map(([k, v]) => k + ': ' + v).join('\n') + '\n---\n\n'
}

interface Note {
  title: string
  rel: string
  body: string
}

function writeNote(out: string, note: Note): void {
  const abs = path.join(out, note.rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, note.body)
}

function zkConfig(): string {
  return `# 夹具自带的最小 zk 配置（plan §0.5）：wiki 链接 + 与插件默认布局一致的 group。
# 没有 template：夹具不走 zk new，模板缺失不影响 index / list / graph。
[note]
extension = "md"

[format.markdown]
link-format = "wiki"
hashtags = true

[group."daily"]
paths = ["journal"]

[group."daily".note]
filename = '{{format-date now "%Y-%m-%d"}}'

[group."source"]
paths = ["notes/sources"]

[group."concept"]
paths = ["notes/concepts"]

[group."entity"]
paths = ["notes/entities"]

[group."pattern"]
paths = ["notes/patterns"]
`
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const rnd = prng(opts.seed)

  // ── 安全地准备目录：默认清掉旧夹具，但只认自己的标记 ──
  const marker = path.join(opts.out, '.fixture.json')
  if (fs.existsSync(opts.out)) {
    const entries = fs.readdirSync(opts.out)
    if (entries.length > 0) {
      if (!opts.force) throw new Error('目录非空：' + opts.out + '\n  换个 --out，或加 --force 覆盖夹具')
      if (!fs.existsSync(marker)) throw new Error('拒绝覆盖：' + opts.out + ' 里没有 .fixture.json，不像是夹具目录')
      fs.rmSync(opts.out, { recursive: true, force: true })
    }
  }
  fs.mkdirSync(opts.out, { recursive: true })
  // 先落标记再写内容：中途失败（比如自检不过）也留下可被 --force 覆盖的痕迹，
  // 否则半成品目录既不完整、又删不掉。
  fs.writeFileSync(marker, JSON.stringify({ status: 'incomplete', seed: opts.seed, notes: opts.notes }, null, 2) + '\n')

  const started = Date.now()
  const counts = { atom: 0, source: 0, journal: 0, archive: 0, raw: 0 }
  const total = opts.notes
  // 小库上每档至少留 1 篇：raw=0 会让「raw 被排除」这类用例悄悄失去覆盖，而比例本身在 50 篇下已经失真了
  const nRaw = Math.max(1, Math.round(total * 0.02))
  const nJournal = Math.max(1, Math.round(total * 0.1))
  const nArchive = Math.max(1, Math.round(total * 0.08))
  const nSource = Math.max(1, Math.round(total * 0.15))
  const nAtom = Math.max(1, total - nRaw - nJournal - nArchive - nSource)

  // ── 1. 原子笔记：先全部生成标题与正文，再统一挂链接（链接只能指向已存在的标题） ──
  const atoms: Note[] = []
  const titles: string[] = []
  const dirs = ['notes/concepts', 'notes/entities', 'notes/patterns'] as const
  for (let i = 0; i < nAtom; i++) {
    const title = TOPICS[i % TOPICS.length]! + QUALIFIERS[(i * 7) % QUALIFIERS.length]! + ' ' + i
    const rel = dirs[i % dirs.length]! + '/' + slug(title) + '.md'
    const date = dayOf(i % 900)
    const body = [
      frontmatter([
        ['type', dirs[i % dirs.length]!.split('/')[1]!.replace(/s$/, '')],
        ['title', '"' + title + '"'],
        ['date', date],
        ['status', 'active'],
        ['authority', 'expert'],
        ['tags', '[\"' + TOPICS[(i * 3) % TOPICS.length] + '\", \"atom\"]'],
      ]),
      '# ' + title + '\n\n',
      sentence(rnd, 3 + Math.floor(rnd() * 10)),
      '\n\n',
      asciiLine(rnd),
      '\n',
    ].join('')
    titles.push(title)
    atoms.push({ title, rel, body })
    counts.atom++
  }

  const links: string[] = []
  const brokenLinks: string[] = []
  const totalLinks = Math.round(total * opts.linksPerNote)
  const perNote = new Map<number, string[]>()
  for (let k = 0; k < totalLinks; k++) {
    const idx = k % atoms.length
    const broken = k % 20 === 7 // 5% 断链：顺带养活 broken-links / 孤儿检测
    const target = broken
      ? '幽灵笔记 ' + k
      : titles[Math.floor(rnd() * Math.max(1, titles.length))]!
    const list = perNote.get(idx) ?? []
    list.push(target)
    perNote.set(idx, list)
    if (broken) brokenLinks.push(target)
    else links.push(target)
  }
  for (const [idx, targets] of perNote) {
    const note = atoms[idx]!
    note.body += '\n见 ' + targets.map((t) => '[[' + t + ']]').join('、') + '。\n'
  }
  for (const note of atoms) writeNote(opts.out, note)

  // ── 2. 来源（15%）：放在 notes/sources，frontmatter 带出处 ──
  for (let i = 0; i < nSource; i++) {
    const title = '来源 ' + TOPICS[i % TOPICS.length]! + ' ' + i
    const rel = 'notes/sources/' + slug(title) + '.md'
    writeNote(opts.out, {
      title,
      rel,
      body: frontmatter([
        ['type', 'source'],
        ['title', '"' + title + '"'],
        ['date', dayOf((i * 3) % 900)],
        ['status', 'active'],
        ['authority', 'official'],
        ['tags', '[\"source\"]'],
      ]) + '# ' + title + '\n\n出处：https://example.com/' + i + '\n\n' + sentence(rnd, 4 + Math.floor(rnd() * 8)) + '\n',
    })
    counts.source++
  }

  // ── 3. 日记（10%）：一天一篇，文件名就是日期（插件按 dailyDir 判 type=daily） ──
  for (let i = 0; i < nJournal; i++) {
    const date = dayOf(i)
    writeNote(opts.out, {
      title: date,
      rel: 'journal/' + date + '.md',
      body: '# ' + date + '\n\n## Events\n\n' + sentence(rnd, 3 + Math.floor(rnd() * 6)) +
        '\n\n## Observations\n\n' + sentence(rnd, 2 + Math.floor(rnd() * 4)) + '\n',
    })
    counts.journal++
  }

  // ── 4. 归档（8%）：同一套内容，落在 archive/ 下（默认被排除，用来测 includeArchived） ──
  for (let i = 0; i < nArchive; i++) {
    const title = '归档 ' + TOPICS[i % TOPICS.length]! + ' ' + i
    writeNote(opts.out, {
      title,
      rel: 'archive/notes/' + dayOf(i % 900).slice(0, 4) + '/' + slug(title) + '.md',
      body: frontmatter([
        ['type', 'concept'],
        ['title', '"' + title + '"'],
        ['date', dayOf(i % 900)],
        ['status', 'archived'],
        ['tags', '[\"archive\"]'],
      ]) + '# ' + title + '\n\n' + sentence(rnd, 3 + Math.floor(rnd() * 9)) + '\n',
    })
    counts.archive++
  }

  // ── 5. raw（2%）：无 frontmatter、不进主索引，模拟外部剪藏 ──
  for (let i = 0; i < nRaw; i++) {
    writeNote(opts.out, {
      title: 'raw-' + i,
      rel: 'raw/raw-' + i + '.md',
      body: sentence(rnd, 2 + Math.floor(rnd() * 5)) + '\n',
    })
    counts.raw++
  }

  // ── 6. 边界样本（不计入 --notes）：每条都对应计划里的一个已知坑 ──
  const longChars = 22_000
  let longBody = '# 长笔记边界样本\n\n'
  // 按长度堆，不按句数估：句子长度随抽词变化，估出来的会差一倍
  while (longBody.length < longChars) longBody += sentence(rnd, 5) + '\n\n'
  writeNote(opts.out, {
    title: '长笔记边界样本',
    rel: 'notes/concepts/long-note.md',
    body: frontmatter([['type', 'concept'], ['title', '"长笔记边界样本（≥20k 字）"'], ['date', '2024-06-01'],
      ['status', 'active'], ['tags', '[\"edge\", \"long\"]']]) + longBody + '\n',
  })

  // 无 frontmatter 的老笔记（0.1.0 之前的形状）：status 缺省要按 active 算
  for (let i = 1; i <= 3; i++) {
    writeNote(opts.out, {
      title: '老笔记 ' + i,
      rel: 'notes/legacy-' + i + '.md',
      body: '# 老笔记 ' + i + '\n\n' + sentence(rnd, 4) + '\n',
    })
  }

  // 重名标题（不同目录）+ 相似标题（Jaccard ≥ 0.6，短串包含），用来测写路径提醒与 lint
  const dupTitle = '重名标题'
  writeNote(opts.out, {
    title: dupTitle,
    rel: 'notes/concepts/dup-title-a.md',
    body: frontmatter([['type', 'concept'], ['title', '"' + dupTitle + '"'], ['date', '2024-06-02'],
      ['status', 'active']]) + '# ' + dupTitle + '\n\n' + sentence(rnd, 3) + '\n',
  })
  writeNote(opts.out, {
    title: dupTitle,
    rel: 'notes/entities/dup-title-b.md',
    body: frontmatter([['type', 'entity'], ['title', '"' + dupTitle + '"'], ['date', '2024-06-03'],
      ['status', 'active']]) + '# ' + dupTitle + '\n\n' + sentence(rnd, 3) + '\n',
  })
  const similarA = '记忆预算截断与写路径硬化'
  const similarB = '记忆预算截断与写路径校验'
  writeNote(opts.out, {
    title: similarA,
    rel: 'notes/concepts/similar-a.md',
    body: frontmatter([['type', 'concept'], ['title', '"' + similarA + '"'], ['date', '2024-06-04'],
      ['status', 'active']]) + '# ' + similarA + '\n\n' + sentence(rnd, 3) + '\n',
  })
  writeNote(opts.out, {
    title: similarB,
    rel: 'notes/concepts/similar-b.md',
    body: frontmatter([['type', 'concept'], ['title', '"' + similarB + '"'], ['date', '2024-06-05'],
      ['status', 'active']]) + '# ' + similarB + '\n\n' + sentence(rnd, 3) + '\n',
  })

  // ── 7. 记忆三件套：同日条目 + 一条无日期（M1 的「淘汰键坏了」要能复现） ──
  fs.writeFileSync(path.join(opts.out, 'MEMORY.md'), [
    '# MEMORY',
    '',
    '> 策展核心：这个笔记本此刻的现行结论。',
    '',
    '## 结论',
    '',
    '- **先量后改。** 2026-10-01（来源：[[记忆预算截断与写路径硬化]]）',
    '- **只警告不阻断。** 2026-10-01（来源：[[检索方法 0]]）',
    '- **失败要显式。** 2026-10-02（来源：[[索引记录 2]]）',
    '- **旧结论没有日期也没有来源。**',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(opts.out, 'AGENTS.md'), [
    '# AGENTS',
    '',
    '## 工作约定',
    '',
    '- 先 read 核对来源，再改。',
    '- 结论写日期。',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(opts.out, 'WORKFLOW.md'), [
    '# WORKFLOW',
    '',
    '## 记录',
    '',
    '- 写进 notes/，来源进 notes/sources/。',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(opts.out, 'DREAMS.md'), [
    '# DREAMS',
    '',
    '## 线索',
    '',
    '- 归档里还有没沉淀的东西。',
    '',
  ].join('\n'))

  fs.mkdirSync(path.join(opts.out, '.zk'), { recursive: true })
  fs.writeFileSync(path.join(opts.out, '.zk/config.toml'), zkConfig())

  // ── 8. 自检：夹具本身坏了，比没有夹具更糟 ──
  const longText = fs.readFileSync(path.join(opts.out, 'notes/concepts/long-note.md'), 'utf8')
  if (longText.length < 20_000) throw new Error('长笔记没有到 20k 字：' + longText.length)
  let files = 0
  let bytes = 0
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== '.zk') walk(p) }
      else { files++; bytes += fs.statSync(p).size }
    }
  }
  walk(opts.out)

  const summary = {
    out: opts.out,
    seed: opts.seed,
    notes: total,
    linksPerNote: opts.linksPerNote,
    counts,
    files,
    bytes,
    links: { valid: links.length, broken: brokenLinks.length },
    edge: {
      longNoteChars: longText.length,
      legacyNoFrontmatter: 3,
      duplicateTitles: 1,
      similarTitlePairs: 1,
      memorySameDayEntries: 2,
      memoryUndated: 1,
    },
    elapsedMs: Date.now() - started,
  }
  fs.writeFileSync(marker, JSON.stringify(summary, null, 2) + '\n')

  if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return }
  const kb = (bytes / 1024).toFixed(0)
  console.log('✓ 夹具已生成：' + summary.out)
  console.log('  篇数 ' + total + '（原子 ' + counts.atom + ' · 来源 ' + counts.source + ' · 日记 ' + counts.journal +
    ' · 归档 ' + counts.archive + ' · raw ' + counts.raw + '）')
  console.log('  链接 ' + links.length + '（断链 ' + brokenLinks.length + '，' + opts.linksPerNote + ' 链/篇）')
  console.log('  文件 ' + files + ' / ' + kb + ' KB，用时 ' + summary.elapsedMs + ' ms')
  console.log('  边界：长笔记 ' + longText.length + ' 字 · 无 frontmatter 3 · 重名 1 · 相似 1 · 同日 MEMORY 2 · 无日期 1')
  const shown = path.relative(process.cwd(), opts.out)
  console.log('  下一步：cd ' + (shown.startsWith('..') ? opts.out : shown) + ' && zk index')
}

try {
  main()
} catch (err) {
  console.error('✗ ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
}
