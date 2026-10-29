/**
 * 集成测试：真的起 zk 进程、真的读写文件。
 *
 *   ZK_BIN=/path/to/zk bun test
 *
 * 没装 zk 时自动跳过（配置归一化不依赖 zk，照常跑）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-test-'))
process.env.DSH_HOME = home

const zkBin = process.env.ZK_BIN ?? 'zk'
const notebook = path.join(home, 'notebook')

const store = await import('../src/config/store.ts')
const zk = await import('../src/lib/zk.ts')
const memory = await import('../src/lib/memory.ts')
const notebookLib = await import('../src/lib/notebook.ts')
const toolsFeature = await import('../src/features/zk-tools/feature.ts')
const toolLib = await import('../src/lib/tool.ts')
const fm = await import('../src/lib/frontmatter.ts')

store.writeConfig({ notebook, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
const cfg = store.config()

const available = (await zk.versionOf(zkBin)) !== null
const it = available ? test : test.skip

// 跳过 ≠ 通过：直接 `bun test` 又没 zk 时，必须留下一条红的，否则「全绿」是假的。
if (!available) {
  test('zk 不可用（集成测试已全部跳过）', () => {
    throw new Error(`找不到 zk：${zkBin}。给 ZK_BIN=/path/to/zk，或用 bun run test（按插件顺序解析）`)
  })
}

afterAll(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 临时目录，删不掉也无所谓 */ }
})

describe('config', () => {
  test('归一化：子目录不许跑出笔记本、数值夹紧、标签去重', () => {
    const c = store.normalizeConfig({
      notebook: '~/notes',
      notesDir: '../../etc',
      dailyDir: '/absolute/journal',
      dailyGroup: 'bad name!',
      defaultTags: '#work, work, 读书',
      maxReadChars: 999_999,
      zkVersion: 'v1.2.3',
      zkPath: '',
    })
    expect(c.notesDir).toBe('etc')
    expect(c.dailyDir).toBe('absolute/journal')
    expect(c.dailyGroup).toBe('daily')
    expect(c.defaultTags).toEqual(['work', '读书'])
    expect(c.maxReadChars).toBe(200_000)
    expect(c.zkVersion).toBe('1.2.3')
    expect(c.notebook).toBe(path.join(os.homedir(), 'notes'))
  })

  test('写入只认白名单键', () => {
    const c = store.writeConfig({ notebook, nonsense: 'x' } as never)
    expect((c as unknown as Record<string, unknown>).nonsense).toBeUndefined()
  })

  test('老配置缺 structure：读一次就把默认值显式写回', async () => {
    const paths = await import('../src/config/paths.ts')
    fs.writeFileSync(paths.CFG_FILE, JSON.stringify({ notebook, zkPath: zkBin, defaultTags: ['default'] }))
    const c = store.config()
    expect(c.structure).toBe('flat')
    expect(c.archiveDir).toBe('archive')
    const onDisk = JSON.parse(fs.readFileSync(paths.CFG_FILE, 'utf8')) as Record<string, unknown>
    expect(onDisk.structure).toBe('flat')
    expect(onDisk.memoryBudgetWords).toBe(300)
  })
})

describe('memory', () => {
  const build = (files: Record<string, string>, budget = 300) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-memory-'))
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
    try {
      return memory.buildMemoryPayload(store.normalizeConfig({ notebook: dir, memoryBudgetWords: budget }))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test('词数：中文按 2 字 1 词，空白切分只算拉丁', () => {
    expect(memory.countWords('中文标题测试')).toBe(3)
    expect(memory.countWords('hello world')).toBe(2)
    expect(memory.countWords('中文 hello')).toBe(2)
    expect(memory.countWords('')).toBe(0)
  })

  test('三份文件都不存在 → 空载荷，不抛错', () => {
    const p = build({})
    expect(p.text).toBe('')
    expect(p.words).toBe(0)
    expect(p.truncatedWords).toBe(0)
    expect(p.files.every((f) => !f.present)).toBe(true)
  })

  test('预算内：三份都进载荷，顺序 AGENTS → USER → MEMORY', () => {
    const p = build({ 'AGENTS.md': '# 规则\n先查重再写。', 'USER.md': '# 偏好\n中文回答。', 'MEMORY.md': '# 记忆\n选了 SQLite。' })
    expect(p.truncatedWords).toBe(0)
    expect(p.text).toContain('## AGENTS.md')
    expect(p.text.indexOf('## AGENTS.md')).toBeLessThan(p.text.indexOf('## USER.md'))
    expect(p.text.indexOf('## USER.md')).toBeLessThan(p.text.indexOf('## MEMORY.md'))
    expect(p.text.startsWith('<system-reminder>')).toBe(true)
  })

  test('超预算：先丢 MEMORY 尾部整段，并回显截断词数', () => {
    const memoryBody = ['## 一', 'a '.repeat(30), '## 二', 'b '.repeat(30), '## 三', 'c '.repeat(30)].join('\n')
    const p = build({ 'AGENTS.md': 'rule '.repeat(5), 'MEMORY.md': memoryBody }, 50)
    expect(p.text).toContain('## 一')
    expect(p.text).not.toContain('## 三')
    expect(p.text).toContain('已截断')
    expect(p.words).toBeLessThanOrEqual(50)
  })

  test('AGENTS.md 是硬规则：单独超预算也不截断，只告警', () => {
    const rules = 'rule '.repeat(80) + 'LAST-RULE'
    const p = build({ 'AGENTS.md': rules, 'MEMORY.md': '## 记忆\n' + 'x '.repeat(20) }, 50)
    expect(p.text).toContain('LAST-RULE')
    expect(p.text).toContain('AGENTS.md 为硬规则')
    expect(p.words).toBeGreaterThan(50)
  })

  test('有 systemPrompt 时注册 zdiary:memory；没有时安静跳过', async () => {
    const plugin = (await import('../src/app/plugin.ts')).default
    const sections: Array<{ name: string; order: number; text: string | (() => string) }> = []
    const withPrompt = {
      get: (name: string) => (name === 'systemPrompt'
        ? { section: (s: typeof sections[number]) => { sections.push(s); return () => undefined } }
        : undefined),
      effect: (fn: () => undefined | (() => void)) => { fn() },
    }
    plugin.apply(withPrompt as never)
    expect(sections.map((s) => s.name)).toEqual(['zdiary:memory'])
    expect(sections[0].order).toBe(5200)
    expect(typeof sections[0].text).toBe('function')

    const bare = { get: () => undefined, effect: (fn: () => undefined | (() => void)) => { fn() } }
    expect(() => plugin.apply(bare as never)).not.toThrow()
  })
})

describe('notebook bootstrap', () => {
  it('建库：目录 / config.toml / 日记 group / 日记模板，第二次全为 false', async () => {
    const first = await notebookLib.ensureNotebook(cfg)
    expect(first.initialized).toBe(true)
    expect(first.configPatched).toBe(true)
    expect(first.templateWritten).toBe(true)
    expect(fs.existsSync(path.join(notebook, '.zk', 'config.toml'))).toBe(true)
    const toml = fs.readFileSync(path.join(notebook, '.zk', 'config.toml'), 'utf8')
    expect(toml).toContain('[group."daily"]')
    expect(toml).toContain('template = "daily.md"')
    expect(fs.readFileSync(path.join(notebook, '.zk', 'templates', 'daily.md'), 'utf8')).toContain('{{content}}')

    const again = await notebookLib.ensureNotebook(cfg)
    expect(again.initialized).toBe(false)
    expect(again.configPatched).toBe(false)
    expect(again.templateWritten).toBe(false)
    expect(again.dirsCreated).toEqual([])
    expect(again.templatesWritten).toEqual([])
    expect(again.groupsAdded).toEqual([])
  })

  it('不覆盖已有配置：自己有的 group 不再追加', async () => {
    const custom = store.normalizeConfig({ notebook: path.join(home, 'nb2'), zkPath: zkBin, dailyGroup: 'mine', dailyDir: 'diary' })
    await notebookLib.ensureNotebook(custom)
    const file = path.join(custom.notebook, '.zk', 'config.toml')
    const before = fs.readFileSync(file, 'utf8')
    const result = await notebookLib.ensureNotebook(custom)
    expect(result.configPatched).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('structure: layered', () => {
  const layeredDir = path.join(home, 'nb-layered')
  const layered = store.normalizeConfig({ notebook: layeredDir, zkPath: zkBin, structure: 'layered' })

  it('一次建好目录 / 三套模板 / 五个 group，第二次零改动', async () => {
    const first = await notebookLib.ensureNotebook(layered)
    expect(first.initialized).toBe(true)
    expect(first.groupsAdded).toEqual(['daily', 'source', 'concept', 'entity', 'pattern'])
    expect(first.templatesWritten.sort()).toEqual(['daily.md', 'entry.md', 'source.md'])
    for (const dir of ['raw', 'inbox', 'notes/sources', 'notes/concepts', 'notes/entities', 'notes/patterns', 'archive']) {
      expect(fs.existsSync(path.join(layeredDir, dir))).toBe(true)
    }
    const toml = fs.readFileSync(path.join(layeredDir, '.zk', 'config.toml'), 'utf8')
    for (const group of ['daily', 'source', 'concept', 'entity', 'pattern']) expect(toml).toContain(`[group."${group}"]`)
    expect(toml).toContain('filename = \'{{slug title}}\'')
    expect(toml).toContain('type = "concept"')

    const again = await notebookLib.ensureNotebook(layered)
    expect(again.dirsCreated).toEqual([])
    expect(again.templatesWritten).toEqual([])
    expect(again.groupsAdded).toEqual([])
  })

  it('模板都含 {{content}}，用模板建的笔记有 type/title/date 且正文在', async () => {
    for (const name of ['daily.md', 'source.md', 'entry.md']) {
      const body = fs.readFileSync(path.join(layeredDir, '.zk', 'templates', name), 'utf8')
      expect(body).toContain('{{content}}')
    }
    const created = await zk.createNote(layered, {
      title: '分层概念笔记',
      dir: 'notes/concepts',
      content: '这条正文必须落进 {{content}} 的位置。',
    })
    const raw = fs.readFileSync(created.absPath, 'utf8')
    expect(raw).toContain('type: concept')
    expect(raw).toContain('title: 分层概念笔记')
    expect(raw).toMatch(/date: \d{4}-\d{2}-\d{2}/)
    expect(raw).toContain('这条正文必须落进')
  })

  it('meta 文件与 raw/inbox/archive 不进入检索与统计', async () => {
    fs.writeFileSync(path.join(layeredDir, 'AGENTS.md'), '# 约定\n\nUNIQUE-META-TOKEN\n')
    fs.writeFileSync(path.join(layeredDir, 'raw', 'clip.md'), '# 素材\n\nUNIQUE-RAW-TOKEN\n')
    await zk.indexNotebook(layered)
    const meta = await zk.searchNotes(layered, { query: 'UNIQUE-META-TOKEN' })
    const raw = await zk.searchNotes(layered, { query: 'UNIQUE-RAW-TOKEN' })
    expect(meta.length).toBe(0)
    expect(raw.length).toBe(0)
    const stats = await zk.notebookStats(layered)
    expect(stats.notes).toBe(1) // 只有 notes/concepts 里那篇
    const all = await zk.searchNotes(layered, { limit: 50 })
    expect(all.some((n) => n.path.startsWith('.zk/'))).toBe(false)
  })
})

describe('notes', () => {
  it('创建 → 搜索 → 读取', async () => {
    const created = await zk.createNote(cfg, {
      title: '卡片盒笔记法',
      content: zk.withTags('把想法写成原子笔记，再用双链连起来。', ['zettelkasten', 'method']),
    })
    expect(created.path.startsWith('notes/')).toBe(true)
    const disk = fs.readFileSync(created.absPath, 'utf8')
    expect(disk).toContain('# 卡片盒笔记法')
    expect(disk).toContain('#zettelkasten')

    const hits = await zk.searchNotes(cfg, { query: '原子笔记', limit: 5 })
    expect(hits.map((n) => n.path)).toContain(created.path)
    expect(hits[0].tags).toContain('zettelkasten')

    const doc = await zk.readNote(cfg, created.path)
    expect(doc.title).toBe('卡片盒笔记法')
    expect(doc.content).toContain('双链')
    expect(doc.chars).toBeGreaterThan(10)
  })

  it('标签过滤与日期过滤', async () => {
    const byTag = await zk.searchNotes(cfg, { tags: ['zettelkasten'] })
    expect(byTag.length).toBe(1)
    const recent = await zk.searchNotes(cfg, { since: '2000-01-01' })
    expect(recent.length).toBeGreaterThan(0)
    const none = await zk.searchNotes(cfg, { query: '绝对不可能出现的词xyzzy' })
    expect(none.length).toBe(0)
  })

  it('追加与双链（幂等）', async () => {
    const a = await zk.createNote(cfg, { title: '来源 A', content: 'A 的内容' })
    const b = await zk.createNote(cfg, { title: '目标 B', content: 'B 的内容' })

    const appended = zk.appendToNote(cfg, a.path, '补一条证据', { heading: '补充' })
    expect(appended.path).toBe(a.path)
    expect(fs.readFileSync(a.absPath, 'utf8')).toContain('## 补充\n\n补一条证据')

    const linked = await zk.linkNotes(cfg, a.path, '目标 B')
    expect(linked.added).toBe(true)
    expect(linked.link).toBe('[[notes/' + b.path.split('/')[1].replace(/\.md$/, '') + ']]')
    expect(fs.readFileSync(a.absPath, 'utf8')).toContain('## Links')

    const again = await zk.linkNotes(cfg, a.path, b.path)
    expect(again.added).toBe(false)
    expect(fs.readFileSync(a.absPath, 'utf8').match(/\[\[notes\//g)?.length).toBe(1)
  })

  it('双链小节沿用旧标题「## 链接」', async () => {
    const a = await zk.createNote(cfg, { title: '旧格式 A', content: '内容' })
    const b = await zk.createNote(cfg, { title: '旧格式 B', content: '内容' })
    fs.appendFileSync(a.absPath, '\n## 链接\n', 'utf8')
    await zk.linkNotes(cfg, a.path, b.path)
    const text = fs.readFileSync(a.absPath, 'utf8')
    expect(text).not.toContain('## Links')
    expect(text.match(/^## /gm)?.length).toBe(1)
    expect(text).toContain('[[notes/')
  })

  it('拒绝笔记本外面的路径', async () => {
    expect(() => zk.absPathOf(cfg, '../../etc/passwd')).toThrow(/不在笔记本里/)
  })

  it('统计', async () => {
    const stats = await zk.notebookStats(cfg)
    expect(stats.notes).toBeGreaterThanOrEqual(3)
    expect(stats.tags).toBeGreaterThanOrEqual(1)
    expect(stats.brokenLinks).toBe(0)
  })
})

describe('frontmatter', () => {
  test('只改指定标量，其余行原样保留', () => {
    const src = '---\ntype: concept\ntitle: 带: 冒号 的标题\ntags: []\nstatus: active\n---\n\n# 标题\n\n正文\n'
    const out = fm.setFrontmatter(src, { status: 'superseded' })
    expect(out).toContain('title: 带: 冒号 的标题')
    expect(out).toContain('tags: []')
    expect(out).toContain('status: superseded')
    expect(out.match(/^status:/gm)?.length).toBe(1)
    // 就地替换：字段仍在原来的行号上（顺序不动 → diff 只有那一行）
    expect(out.split('\n')[4]).toBe('status: superseded')
    expect(out.endsWith('# 标题\n\n正文\n')).toBe(true)
  })

  test('缺字段就追加；没有 frontmatter 就建一块（正文保持原样）', () => {
    const out = fm.setFrontmatter('# 无头笔记\n', { status: 'superseded', 'superseded-by': '[[notes/b]]' })
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('superseded-by: [[notes/b]]')
    expect(out.endsWith('\n\n# 无头笔记\n')).toBe(true)
    expect(fm.parseFrontmatter(out).fields.status).toBe('superseded')
  })

  test('值为 undefined = 删掉该字段', () => {
    const out = fm.setFrontmatter('---\nstatus: superseded\nsuperseded-by: [[x]]\n---\n正文', { 'superseded-by': undefined })
    expect(out).not.toContain('superseded-by')
    expect(out).toContain('status: superseded')
  })

  test('没有 frontmatter 时 parse 返回原文，不吞行', () => {
    const p = fm.parseFrontmatter('# 标题\n\nstatus: 不是 frontmatter\n')
    expect(p.fields).toEqual({})
    expect(p.body).toBe('# 标题\n\nstatus: 不是 frontmatter\n')
  })
})

describe('M2: 结构化检索与废弃', () => {
  const dir = path.join(home, 'nb-m2')
  const m2 = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
  const note = (title: string, dirName: string, body: string) => zk.createNote(m2, { title, dir: dirName, content: body })

  it('撞名：第二次明确报错，第一篇内容一字不改', async () => {
    await notebookLib.ensureNotebook(m2)
    const first = await note('命名冲突', 'notes/concepts', '第一次的正文')
    await expect(note('命名冲突', 'notes/concepts', '第二次的正文')).rejects.toThrow(/同名笔记已存在/)
    const text = fs.readFileSync(first.absPath, 'utf8')
    expect(text).toContain('第一次的正文')
    expect(text).not.toContain('第二次的正文')
  })

  it('zk_search 的 type / status 过滤在 JS 层生效（Z6）', async () => {
    const concept = await note('过滤概念', 'notes/concepts', '概念正文')
    const source = await note('过滤来源', 'notes/sources', '来源正文')
    const onlyConcept = await zk.searchNotes(m2, { type: ['concept'], limit: 50 })
    expect(onlyConcept.map((n) => n.path)).toContain(concept.path)
    expect(onlyConcept.every((n) => n.type === 'concept')).toBe(true)
    expect(onlyConcept.map((n) => n.path)).not.toContain(source.path)
    expect(onlyConcept[0].status).toBe('active')
    expect(onlyConcept[0].metadata.type).toBe('concept')
    const active = await zk.searchNotes(m2, { status: ['active'], limit: 50 })
    expect(active.length).toBeGreaterThan(0)
    const superseded = await zk.searchNotes(m2, { status: ['superseded'], limit: 50 })
    expect(superseded.length).toBe(0)
  })

  it('supersede 预演不改任何文件；执行后归档、重写入链、断链不增加', async () => {
    const oldNote = await note('旧结论', 'notes/concepts', '这是要被推翻的结论。')
    const newNote = await note('新结论', 'notes/concepts', '这是替代它的结论。')
    const source = await note('引用旧结论的来源', 'notes/sources', '来源正文')
    await zk.linkNotes(m2, source.path, oldNote.path)
    await zk.linkNotes(m2, newNote.path, oldNote.path)

    const brokenBefore = (await zk.searchNotes(m2, { brokenLinks: true, limit: 50 })).length
    expect(fs.readFileSync(source.absPath, 'utf8')).toContain('[[notes/concepts/')

    // ── 预演 ──
    const dry = await zk.supersedeNote(m2, { path: oldNote.path, by: newNote.path })
    expect(dry.dryRun).toBe(true)
    expect(dry.performed).toBe(false)
    expect(dry.archivePath).toBe(`archive/${oldNote.path}`)
    expect(dry.rewrittenLinks.map((r) => r.path).sort()).toEqual([newNote.path, source.path].sort())
    expect(fs.existsSync(oldNote.absPath)).toBe(true)
    expect(fs.readFileSync(oldNote.absPath, 'utf8')).toContain('status: active')
    expect(fs.readFileSync(source.absPath, 'utf8')).toContain('[[notes/concepts/')

    // ── 执行 ──
    const done = await zk.supersedeNote(m2, { path: oldNote.path, by: newNote.path, dryRun: false })
    expect(done.performed).toBe(true)
    expect(fs.existsSync(oldNote.absPath)).toBe(false)
    const archivedAbs = path.join(dir, done.archivePath)
    expect(done.archivePath.startsWith('archive/notes/concepts/')).toBe(true)
    const archived = fs.readFileSync(archivedAbs, 'utf8')
    expect(archived).toContain('status: superseded')
    expect(archived).toContain('superseded-by: [[')
    expect(archived).toContain('这是要被推翻的结论。')
    expect(fs.readFileSync(newNote.absPath, 'utf8')).toContain('[[archive/notes/concepts/')
    expect(fs.readFileSync(source.absPath, 'utf8')).toContain('[[archive/notes/concepts/')

    // 断链数量不增加（入链在同一次调用里被重写）
    expect((await zk.searchNotes(m2, { brokenLinks: true, limit: 50 })).length).toBe(brokenBefore)

    // 默认查询看不到；include_archived 能看到
    const active = await zk.searchNotes(m2, { status: ['active'], limit: 50 })
    expect(active.map((n) => n.path)).not.toContain(oldNote.path)
    const withArchive = await zk.searchNotes(m2, { status: ['superseded'], includeArchived: true, limit: 50 })
    expect(withArchive.map((n) => n.path)).toContain(done.archivePath)

    // 重放幂等
    const replay = await zk.supersedeNote(m2, { path: done.archivePath, by: newNote.path, dryRun: false })
    expect(replay.alreadySuperseded).toBe(true)
    expect(replay.performed).toBe(false)
  })

  it('supersede 拒绝：替代者不存在 / 自己也是废弃的 / 目标不存在', async () => {
    const a = await note('待废弃甲', 'notes/concepts', '甲')
    const b = await note('待废弃乙', 'notes/concepts', '乙')
    await expect(zk.supersedeNote(m2, { path: a.path, by: '根本没有这篇' })).rejects.toThrow(/找不到替代笔记/)
    await expect(zk.supersedeNote(m2, { path: 'notes/concepts/不存在.md' })).rejects.toThrow(/笔记不存在/)
    await zk.supersedeNote(m2, { path: b.path, dryRun: false })
    await expect(zk.supersedeNote(m2, { path: a.path, by: `archive/${b.path}` })).rejects.toThrow(/归档/)
  })

  it('meta 文件与 raw/inbox 不进检索；归档默认不进、include_archived 才进', async () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '## 记忆\n\nM2-META-TOKEN\n')
    fs.writeFileSync(path.join(dir, 'raw', 'clip.md'), '# 素材\n\nM2-RAW-TOKEN\n')
    await zk.indexNotebook(m2)
    expect((await zk.searchNotes(m2, { query: 'M2-META-TOKEN' })).length).toBe(0)
    expect((await zk.searchNotes(m2, { query: 'M2-RAW-TOKEN' })).length).toBe(0)
    const archivedVisible = await zk.searchNotes(m2, { includeArchived: true, limit: 50 })
    expect(archivedVisible.some((n) => n.path.startsWith('archive/'))).toBe(true)
    const archivedHidden = await zk.searchNotes(m2, { limit: 50 })
    expect(archivedHidden.some((n) => n.path.startsWith('archive/'))).toBe(false)
  })
})

describe('daily', () => {
  it('ensureDailyNote 幂等 + 追加带时间的小节', async () => {
    const first = await zk.ensureDailyNote(cfg)
    expect(first.created).toBe(true)
    expect(first.path.startsWith('journal/')).toBe(true)
    expect(first.path).toMatch(/\d{4}-\d{2}-\d{2}\.md$/)

    const second = await zk.ensureDailyNote(cfg)
    expect(second.created).toBe(false)
    expect(second.path).toBe(first.path)

    const r = zk.appendDaily(cfg, first.path, '今天把 zk 接进了 DSH。', new Date(2026, 9, 29, 10, 32))
    expect(r.path).toBe(first.path)
    const content = fs.readFileSync(first.absPath, 'utf8')
    expect(content).toContain('## 10:32')
    expect(content).toContain('今天把 zk 接进了 DSH。')
  })

  it('指定日期', async () => {
    const other = await zk.ensureDailyNote(cfg, { date: '2026-01-02' })
    expect(other.path).toBe('journal/2026-01-02.md')
  })
})

describe('tools', () => {
  it('10 个工具，参数校验拒绝坏输入', () => {
    const defs = toolsFeature.buildTools()
    expect(defs.map((d) => d.name)).toEqual([
      'zk_search', 'zk_query', 'zk_read', 'zk_new', 'zk_daily', 'zk_append', 'zk_link', 'zk_supersede', 'zk_context', 'zk_stats',
    ])
    const zkNew = defs.find((d) => d.name === 'zk_new')!
    expect(toolLib.validateArgs(zkNew.parameters, { body: 'x' }).some((i) => i.includes('title'))).toBe(true)
    expect(toolLib.validateArgs(defs[0].parameters, { limit: 'many' }).length).toBe(1)
    const query = defs.find((d) => d.name === 'zk_query')!
    expect(toolLib.validateArgs(query.parameters, { type: 'nonsense' }).length).toBe(1)
    const supersede = defs.find((d) => d.name === 'zk_supersede')!
    expect(toolLib.validateArgs(supersede.parameters, { by: 'x' }).some((i) => i.includes('path'))).toBe(true)
  })

  it('注册后能真的执行（zk_new → zk_search → zk_read → zk_stats）', async () => {
    const defs = toolsFeature.buildTools()
    const registry = new Map(defs.map((d) => [d.name, d]))
    const call = async (name: string, args: unknown) => {
      const d = registry.get(name)
      if (!d) throw new Error('missing ' + name)
      const value = await d.execute(args, { signal: AbortSignal.timeout(30_000) })
      const blocks = d.output.render(args, value)
      expect(blocks[0].type).toBe('text')
      expect(blocks[0].text.length).toBeGreaterThan(0)
      return value as Record<string, unknown>
    }

    const created = await call('zk_new', { title: '工具层笔记', body: '通过工具注册创建的。', tags: ['tool'] })
    expect(String(created.path)).toContain('notes/')
    expect((created.tags as string[])).toContain('default')

    const found = await call('zk_search', { query: '工具层', tags: ['tool'] })
    expect(found.count).toBe(1)

    const read = await call('zk_read', { path: created.path })
    expect(read.truncated).toBe(false)
    expect(String(read.content)).toContain('通过工具注册创建的')

    await call('zk_append', { path: created.path, text: '又来一条', heading: '后续' })
    await call('zk_daily', { entry: '工具层日记' })
    await call('zk_link', { from: created.path, to: '目标 B' })
    const queried = await call('zk_query', { tags: ['tool'], status: 'active' })
    expect(Number(queried.count)).toBe(1)
    const preview = await call('zk_supersede', { path: String(created.path) })
    expect(preview.dryRun).toBe(true)
    expect(preview.performed).toBe(false)
    const ctxPayload = await call('zk_context', {})
    expect(typeof ctxPayload.text).toBe('string')
    const stats = await call('zk_stats', {})
    expect(Number(stats.notes)).toBeGreaterThan(3)
  })

  it('zk_read 截断会明确告诉模型', async () => {
    const defs = toolsFeature.buildTools()
    const read = defs.find((d) => d.name === 'zk_read')!
    const long = await read.execute({ query: '卡片盒', maxChars: 1000 }, { signal: AbortSignal.timeout(30_000) }) as Record<string, unknown>
    expect(typeof long.content).toBe('string')
    expect(read.output.render({}, long)[0].text).toContain('笔记')
  })
})
