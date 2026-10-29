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
import { spawnSync } from 'node:child_process'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-test-'))
process.env.DSH_HOME = home
// 默认笔记本跟着工作区走（不是 DSH_HOME），测试里钉死，别让 cwd 决定结果
process.env.DSH_WORKSPACE = home

const zkBin = process.env.ZK_BIN ?? 'zk'
const notebook = path.join(home, 'notebook')

const store = await import('../src/config/store.ts')
const zk = await import('../src/lib/zk.ts')
const memory = await import('../src/lib/memory.ts')
const notebookLib = await import('../src/lib/notebook.ts')
const lintLib = await import('../src/lib/lint.ts')
const dreamLib = await import('../src/lib/dream.ts')
const toolsFeature = await import('../src/features/zk-tools/feature.ts')
const workspaceLib = await import('../src/lib/workspace.ts')
const toolLib = await import('../src/lib/tool.ts')
const fm = await import('../src/lib/frontmatter.ts')

store.writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
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

  test('笔记本默认落在工作区里；相对路径按工作区解析', () => {
    expect(store.normalizeConfig({}).notebook).toBe(path.join(home, 'zdiary'))
    expect(store.normalizeConfig({ notebook: 'zdiary' }).notebook).toBe(path.join(home, 'zdiary'))
    expect(store.normalizeConfig({ notebook: './vault' }).notebook).toBe(path.join(home, 'vault'))
  })

  test('写入只认白名单键', () => {
    const c = store.writeConfig({ notebook, nonsense: 'x' } as never)
    expect((c as unknown as Record<string, unknown>).nonsense).toBeUndefined()
  })

  test('老配置只有 notebook：读进来就是 notebooks.default', () => {
    const c = store.normalizeConfig({ notebook: '/legacy/vault' })
    expect(c.notebooks).toEqual({ default: { path: '/legacy/vault', structure: 'flat' } })
    expect(c.active).toBe('default')
    expect(c.notebook).toBe('/legacy/vault')
  })

  test('notebooks 存在时顶层 notebook 被无视：迁移是单向的，不再互相覆盖', () => {
    const c = store.normalizeConfig({ notebooks: { default: { path: '/new/vault' } }, notebook: '/old/vault' })
    expect(c.notebooks.default.path).toBe('/new/vault')
    expect(c.notebook).toBe('/new/vault')
  })

  test('老配置的全局 structure 是条目缺省；条目自己的优先', () => {
    const inherited = store.normalizeConfig({ notebooks: { a: '/a', b: { path: '/b' } }, structure: 'layered' })
    expect(inherited.notebooks.a.structure).toBe('layered')
    expect(inherited.notebooks.b.structure).toBe('layered')
    const own = store.normalizeConfig({ notebooks: { a: '/a', b: { path: '/b', structure: 'flat' } }, structure: 'layered' })
    expect(own.notebooks.a.structure).toBe('layered')
    expect(own.notebooks.b.structure).toBe('flat')
  })

  test('结构跟着笔记本走：派生 structure 看 active，切到谁就是谁的', () => {
    const c = store.normalizeConfig({ notebooks: { a: { path: '/a', structure: 'flat' }, b: { path: '/b', structure: 'layered' } }, active: 'b' })
    expect(c.structure).toBe('layered')
    const back = store.selectNotebook(c, 'a')
    expect(back.structure).toBe('flat')
    expect(back.notebook).toBe('/a')
  })

  test('多笔记本：active 决定 notebook，路径各自解析', () => {
    const c = store.normalizeConfig({ notebooks: { default: '~/a', work: 'b' }, active: 'work' })
    expect(c.active).toBe('work')
    expect(c.notebook).toBe(path.join(home, 'b'))
    expect(store.normalizeConfig({ notebooks: { default: '~/a', work: 'b' } }).notebook).toBe(path.join(os.homedir(), 'a'))
    // 空表 / 非法名字 / 未知 active：都不炸，退回一个能用的笔记本
    expect(store.normalizeConfig({ notebooks: {} }).notebooks).toEqual({ default: { path: '', structure: 'flat' } })
    const junk = store.normalizeConfig({ notebooks: { 'bad name': '/x', ok: '/y' }, active: 'nope' })
    expect(Object.keys(junk.notebooks)).toEqual(['ok'])
    expect(junk.active).toBe('ok')
  })

  test('selectNotebook：只换 notebook / active，别人的路径不动', () => {
    const c = store.normalizeConfig({ notebooks: { default: '/a', work: '/w' }, active: 'default' })
    const work = store.selectNotebook(c, 'work')
    expect(work.notebook).toBe('/w')
    expect(work.active).toBe('work')
    expect(work.notebooks).toEqual({ default: { path: '/a', structure: 'flat' }, work: { path: '/w', structure: 'flat' } })
    expect(store.selectNotebook(c, 'default').notebook).toBe('/a')
  })

  test('writeConfig：notebooks 整体替换、active 切换、派生键谁也盖不过 map', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    try {
      store.writeConfig({ notebooks: { default: { path: '/a', structure: 'flat' }, work: { path: '/w', structure: 'layered' } }, active: 'work' })
      expect(store.config().active).toBe('work')
      expect(store.config().notebook).toBe('/w')
      expect(store.config().structure).toBe('layered')

      // 单写 notebook 是纯派生键：直接忽略（改路径用 notebooks）
      store.writeConfig({ notebook: '/w2' })
      expect(store.config().notebooks.work.path).toBe('/w')
      expect(store.config().notebook).toBe('/w')

      // 单写 structure = 只改当前笔记本的结构
      store.writeConfig({ structure: 'flat' })
      expect(store.config().notebooks.work.structure).toBe('flat')
      expect(store.config().notebooks.default.structure).toBe('flat')

      // 设置页整份发回来：notebooks 是真相，派生的 notebook / structure 是旧值，不能让它们捣乱
      store.writeConfig({ notebooks: { default: { path: '/a' }, work: { path: '/w3', structure: 'layered' } }, notebook: '/w2', structure: 'flat', active: 'work' })
      expect(store.config().notebooks.work.path).toBe('/w3')
      expect(store.config().notebooks.work.structure).toBe('layered')
      expect(store.config().notebook).toBe('/w3')

      // 条目没写 structure：沿用同名旧条目的，不悄悄改别人的
      store.writeConfig({ notebooks: { default: '/a', work: '/w4' } })
      expect(store.config().notebooks.work.structure).toBe('layered')
      expect(store.config().notebooks.default.structure).toBe('flat')

      // 派生值不落盘：磁盘上只有 notebooks + active
      const onDisk = JSON.parse(fs.readFileSync(paths.CFG_FILE, 'utf8')) as Record<string, unknown>
      expect('notebook' in onDisk).toBe(false)
      expect('structure' in onDisk).toBe(false)
      expect(onDisk.notebooks).toEqual({ default: { path: '/a', structure: 'flat' }, work: { path: '/w4', structure: 'layered' } })
      expect(onDisk.active).toBe('work')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
  })

  test('老配置缺 notebooks：读一次就把 notebooks / active 写回', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    try {
      fs.writeFileSync(paths.CFG_FILE, JSON.stringify({ notebook: '/legacy', structure: 'flat' }))
      expect(store.config().notebooks).toEqual({ default: { path: '/legacy', structure: 'flat' } })
      const onDisk = JSON.parse(fs.readFileSync(paths.CFG_FILE, 'utf8')) as Record<string, unknown>
      expect(onDisk.notebooks).toEqual({ default: { path: '/legacy', structure: 'flat' } })
      expect(onDisk.active).toBe('default')
      // 迁移后顶层不再留旧键 —— 结构已经搬进条目
      expect('notebook' in onDisk).toBe(false)
      expect('structure' in onDisk).toBe(false)
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
  })

  test('老配置缺 structure：读一次就把默认值显式写回', async () => {
    const paths = await import('../src/config/paths.ts')
    fs.writeFileSync(paths.CFG_FILE, JSON.stringify({ notebook, zkPath: zkBin, defaultTags: ['default'] }))
    const c = store.config()
    expect(c.structure).toBe('flat')
    expect(c.archiveDir).toBe('archive')
    const onDisk = JSON.parse(fs.readFileSync(paths.CFG_FILE, 'utf8')) as Record<string, unknown>
    // 结构落在条目里；其余默认值照旧显式落盘（以后翻默认值不牵连老 vault）
    expect(onDisk.notebooks).toEqual({ default: { path: notebook, structure: 'flat' } })
    expect('structure' in onDisk).toBe(false)
    expect(onDisk.memoryBudgetWords).toBe(300)
  })
})

describe('工作区解析', () => {
  test('默认笔记本按传入的工作区走；显式路径不受影响', () => {
    const a = store.normalizeConfig({ notebooks: { default: '' }, active: 'default' }, '/tmp/ws-a')
    expect(a.notebook).toBe('/tmp/ws-a/zdiary')
    // 同一份配置，换工作区就是换笔记本（不重启、不落盘）
    const b = store.normalizeConfig({ notebooks: { default: '' }, active: 'default' }, '/tmp/ws-b')
    expect(b.notebook).toBe('/tmp/ws-b/zdiary')
    // 显式绝对路径优先：工作区怎么变都不动
    const fixed = store.normalizeConfig({ notebooks: { default: '/fixed/vault' }, active: 'default' }, '/tmp/ws-b')
    expect(fixed.notebook).toBe('/fixed/vault')
    // 显式相对路径：按传入的工作区解析
    const rel = store.normalizeConfig({ notebooks: { default: 'kb' }, active: 'default' }, '/tmp/ws-b')
    expect(rel.notebook).toBe('/tmp/ws-b/kb')
  })

  test('会话 cwd：exec.agent.id → sessions.get(id).header.cwd', () => {
    const sessions = {
      get: (id: string) => (id === 's1' ? { header: { cwd: '/work/project-a' } } : undefined),
    }
    expect(workspaceLib.sessionWorkspace({ agent: { id: 's1' } }, sessions)).toBe('/work/project-a')
    expect(workspaceLib.sessionWorkspace({ agent: { id: 's2' } }, sessions)).toBeUndefined()
    expect(workspaceLib.sessionWorkspace({}, sessions)).toBeUndefined()
    expect(workspaceLib.sessionWorkspace({ agent: { id: 's1' } }, undefined)).toBeUndefined()
    // 宿主会话服务抛错 / 会话没有 cwd：都退回 undefined（调用方用进程工作区）
    expect(workspaceLib.sessionWorkspace({ agent: { id: 's1' } }, { get: () => { throw new Error('boom') } })).toBeUndefined()
    expect(workspaceLib.sessionWorkspace({ agent: { id: 's1' } }, { get: () => ({ header: {} }) })).toBeUndefined()
  })

  test('工具按这次调用的工作区取笔记本（zk_context 不读进程工作区）', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-ws-'))
    try {
      fs.mkdirSync(path.join(ws, 'zdiary'), { recursive: true })
      fs.writeFileSync(path.join(ws, 'zdiary', 'AGENTS.md'), '# 约定\n\n测试工作区的约定。\n')
      store.writeConfig({ notebooks: { default: '' }, active: 'default' })
      const defs = toolsFeature.buildTools((exec) =>
        exec?.agent?.id === 'sess-1' ? ws : '/nonexistent-ws')
      const tool = defs.find((d) => d.name === 'zk_context')
      expect(tool).toBeDefined()
      const value = await tool!.execute({}, { signal: AbortSignal.timeout(5_000), agent: { id: 'sess-1' } }) as { text: string }
      expect(value.text).toContain('测试工作区的约定')
    } finally {
      store.writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
      fs.rmSync(ws, { recursive: true, force: true })
    }
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

  test('截断归因：AGENTS 吃掉大半预算时点名，预算宽裕时一个字都不加', () => {
    const memoryBody = ['## 一', 'x '.repeat(40), '## 二', 'y '.repeat(40), '## 三', 'z '.repeat(40)].join('\n')
    const tight = build({ 'AGENTS.md': 'rule '.repeat(120), 'MEMORY.md': memoryBody }, 200)
    expect(tight.truncatedWords).toBeGreaterThan(0)
    expect(tight.words).toBeLessThanOrEqual(200)
    expect(tight.text).toContain('AGENTS.md 占 120/200 词')
    expect(tight.text).toContain('留给 USER / MEMORY 的只有 80 词')

    // 没截断 = 不加：别让正常的载荷每步都多这几句
    const roomy = build({ 'AGENTS.md': 'rule '.repeat(10), 'MEMORY.md': '## 一\nx x' }, 200)
    expect(roomy.truncatedWords).toBe(0)
    expect(roomy.text).not.toContain('AGENTS.md 占')

    // AGENTS 自己就超预算：走「预算不足」那条，不重复点名
    const over = build({ 'AGENTS.md': 'rule '.repeat(220), 'MEMORY.md': '## 一\nx x' }, 200)
    expect(over.text).toContain('AGENTS.md 为硬规则')
    expect(over.text).not.toContain('且不参与截断')
  })

  test('AGENTS.md 是硬规则：单独超预算也不截断，只告警', () => {
    const rules = 'rule '.repeat(80) + 'LAST-RULE'
    const p = build({ 'AGENTS.md': rules, 'MEMORY.md': '## 记忆\n' + 'x '.repeat(20) }, 50)
    expect(p.text).toContain('LAST-RULE')
    expect(p.text).toContain('AGENTS.md 为硬规则')
    expect(p.words).toBeGreaterThan(50)
  })

  test('做梦提醒：只认 AGENTS.md；没有它一个字都不加', () => {
    const p = build({ 'USER.md': '中文回答。' })
    expect(p.text).not.toContain('做梦')
  })

  test('做梦提醒：有 AGENTS.md 但没做过梦 → 提示先跑一次', () => {
    const p = build({ 'AGENTS.md': 'rule' })
    expect(p.text).toContain('从未整理过')
    expect(p.text).toContain('zk_dream')
  })

  test('做梦提醒：未到期只报日期，到期才给动作', () => {
    const day = (offset: number) => {
      const d = new Date()
      d.setDate(d.getDate() + offset)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const fresh = build({ 'AGENTS.md': 'rule', 'DREAMS.md': `# 梦\n\n上次做梦：${day(-2)}\n` })
    expect(fresh.text).toContain('未到 7 天')
    expect(fresh.text).not.toContain('zk_dream')

    const stale = build({ 'AGENTS.md': 'rule', 'DREAMS.md': `# 梦\n\n上次做梦：${day(-9)}\n` })
    expect(stale.text).toContain('（9 天前）')
    expect(stale.text).toContain('zk_dream')
  })

  test('做梦提醒：DREAMS.md 没标记就不猜，只说明无法判断', () => {
    const p = build({ 'AGENTS.md': 'rule', 'DREAMS.md': '# 梦\n\n只有报告，没有日期行\n' })
    expect(p.text).toContain('没有「上次做梦')
    expect(p.text).not.toContain('zk_dream')
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

  test('注入按会话工作区取记忆（装配上下文带 agent）；裸调用退回进程工作区', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-inject-'))
    // 空路径才按工作区解析：把 default 重置成空，结束后还原
    store.writeConfig({ notebooks: { default: '' }, active: 'default' })
    try {
      fs.mkdirSync(path.join(ws, 'zdiary'), { recursive: true })
      fs.writeFileSync(path.join(ws, 'zdiary', 'AGENTS.md'), '# 约定\n\n会话工作区的注入记忆。\n')
      const plugin = (await import('../src/app/plugin.ts')).default
      const sections: Array<{ name: string; text: string | ((ctx?: { agent?: { id?: string } }) => string) }> = []
      const fake = {
        get: (name: string) => {
          if (name === 'systemPrompt') return { section: (s: typeof sections[number]) => { sections.push(s); return () => undefined } }
          if (name === 'sessions') return { get: (id: string) => (id === 'sess-ws' ? { header: { cwd: ws } } : undefined) }
          return undefined
        },
        effect: (fn: () => undefined | (() => void)) => { fn() },
      }
      plugin.apply(fake as never)
      const text = sections[0].text as (ctx?: { agent?: { id?: string } }) => string
      // 和 zk_* 工具同一口径：agent.id → sessions.get(id).header.cwd
      expect(text({ agent: { id: 'sess-ws' } })).toContain('会话工作区的注入记忆')
      expect(text({ agent: { id: 'nope' } })).not.toContain('会话工作区的注入记忆')
      // 裸装配（不带 agent）容忍字段缺席，退回进程工作区
      expect(typeof text()).toBe('string')
    } finally {
      store.writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
      fs.rmSync(ws, { recursive: true, force: true })
    }
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
    // group 的 paths 必须跟实际建的目录逐字对上（entity → entities，不是 entitys）
    for (const dir of ['sources', 'concepts', 'entities', 'patterns']) expect(toml).toContain(`paths = ["notes/${dir}"]`)
    expect(toml).not.toContain('notes/entitys')
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
      content: '这条正文必须落进 {{content}} 的位置。 #visible',
    })
    const raw = fs.readFileSync(created.absPath, 'utf8')
    expect(raw).toContain('type: concept')
    expect(raw).toContain('title: 分层概念笔记')
    expect(raw).toMatch(/date: \d{4}-\d{2}-\d{2}/)
    expect(raw).toContain('这条正文必须落进')
  })

  it('meta 文件与 raw/inbox/archive 不进入检索与统计', async () => {
    fs.writeFileSync(path.join(layeredDir, 'AGENTS.md'), '# 约定\n\nUNIQUE-META-TOKEN #metaonly\n')
    fs.writeFileSync(path.join(layeredDir, 'raw', 'clip.md'), '# 素材\n\nUNIQUE-RAW-TOKEN #rawtag\n')
    fs.writeFileSync(path.join(layeredDir, 'archive', 'old.md'), '# 旧结论\n\n#archivetag\n')
    await zk.indexNotebook(layered)
    const meta = await zk.searchNotes(layered, { query: 'UNIQUE-META-TOKEN' })
    const raw = await zk.searchNotes(layered, { query: 'UNIQUE-RAW-TOKEN' })
    expect(meta.length).toBe(0)
    expect(raw.length).toBe(0)
    const stats = await zk.notebookStats(layered)
    expect(stats.notes).toBe(1) // 只有 notes/concepts 里那篇
    expect(stats.tags).toBe(1) // raw / meta / archive 的标签不参与统计
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

  it('flat 模式同名标题也直接报错（不依赖随机文件名撞名）', async () => {
    const first = await zk.createNote(cfg, { title: 'flat 同名标题', content: '第一次的正文' })
    await expect(zk.createNote(cfg, { title: 'flat 同名标题', content: '第二次的正文' })).rejects.toThrow(/同名笔记已存在/)
    expect(fs.readFileSync(first.absPath, 'utf8')).toContain('第一次的正文')
    expect(fs.readFileSync(first.absPath, 'utf8')).not.toContain('第二次的正文')
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

describe('M3: 巡检与做梦', () => {
  const dir = path.join(home, 'nb-m3')
  const m3 = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
  const note = (title: string, dirName: string, body: string) =>
    zk.createNote(m3, { title, dir: dirName, content: body })

  it('lint：断链 / 孤儿 / 无标签 / 缺反链 / 陈旧 / 重名各自命中', async () => {
    await notebookLib.ensureNotebook(m3)
    const orphan = await note('孤岛概念', 'notes/concepts', '没人链我，我也没标签。')
    const cited = await note('被引用概念', 'notes/concepts', '有入链的正文 #cited')
    const source = await note('引用来源', 'notes/sources', '来源正文 #src')
    await zk.linkNotes(m3, source.path, cited.path)
    const broken = await note('断链概念', 'notes/concepts', '见 [[notes/nope]] #broken')
    const dupA = await note('同名标题', 'notes/concepts', '甲 #dup')
    const dupB = await note('同名标题', 'notes/patterns', '乙 #dup')
    const stale = await note('陈旧概念', 'notes/concepts', '很久没动 #stale')
    const old = new Date(Date.now() - 120 * 86_400_000)
    fs.utimesSync(stale.absPath, old, old)
    const daily = await zk.ensureDailyNote(m3)
    await zk.indexNotebook(m3)

    const lint = await lintLib.lintNotebook(m3, { staleDays: 90 })
    expect(lint.notes).toBe(8)
    expect(lint.truncated).toBe(false)
    expect(lint.orphans.items.map((i) => i.path)).toContain(orphan.path)
    expect(lint.brokenLinks.items.map((i) => i.path)).toEqual([broken.path])
    expect(lint.tagless.items.map((i) => i.path)).toContain(orphan.path)
    expect(lint.missingBacklink.items.map((i) => i.path)).toContain(cited.path)
    expect(lint.stale.items.map((i) => i.path)).toEqual([stale.path])
    expect(lint.stale.items[0].modified).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(lint.duplicateTitles.total).toBe(1)
    expect(lint.duplicateTitles.items[0].paths.sort()).toEqual([dupA.path, dupB.path].sort())
    // total 是命中数，items 只截前 50 —— 这里两类都要自洽
    // 日记天然无入链、无标签：不进这两类，否则真问题会被淹掉（断链仍照报）
    expect(lint.orphans.items.map((i) => i.path)).not.toContain(daily.path)
    expect(lint.tagless.items.map((i) => i.path)).not.toContain(daily.path)
    expect(lint.orphans.total).toBeGreaterThanOrEqual(lint.orphans.items.length)
    expect(lint.brokenLinks.total).toBe(1)
  })

  it('lint / dream 只读：一个字节都不改', async () => {
    const snapshot = (): Map<string, string> => {
      const out = new Map<string, string>()
      const walk = (d: string): void => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const abs = path.join(d, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === '.zk') continue
            walk(abs)
            continue
          }
          out.set(abs, fs.readFileSync(abs, 'utf8') + '|' + fs.statSync(abs).mtimeMs)
        }
      }
      walk(dir)
      return out
    }
    const before = snapshot()
    await lintLib.lintNotebook(m3)
    await dreamLib.dreamNotebook(m3)
    const after = snapshot()
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [abs, fingerprint] of before) expect(after.get(abs)).toBe(fingerprint)
  })

  it('dream：候选 / 机械拒绝 / daily 未完成 / 被引用排行', async () => {
    const candidate = await note('可晋升概念', 'notes/concepts', '有标签的正文 #keep')
    const tagless = await note('无标签笔记', 'notes/concepts', '正文一句标签都没有')
    const informal = await zk.createNote(m3, {
      title: '口头传闻',
      dir: 'notes/concepts',
      content: '听说的 #rumor',
      authority: 'informal',
    })
    const daily = await zk.ensureDailyNote(m3)
    fs.writeFileSync(
      daily.absPath,
      '# 今天\n\n## Events\n\n- 开会\n\n## Loose ends\n\n- [ ] 补实验数据\n- [x] 已完成的事\n- 回邮件\n',
      'utf8',
    )

    const dream = await dreamLib.dreamNotebook(m3, { days: 7 })
    const candidates = dream.newNotes.map((n) => n.path)
    expect(candidates).toContain(candidate.path)
    expect(dream.rejected.map((r) => r.path)).toContain(informal.path)
    expect(dream.rejected.find((r) => r.path === informal.path)?.reason).toMatch(/informal/)
    expect(dream.rejected.map((r) => r.path)).toContain(tagless.path)
    expect(dream.rejected.find((r) => r.path === tagless.path)?.reason).toMatch(/无标签/)
    expect(dream.counts.window).toBeGreaterThan(0)
    expect(dream.truncated).toBe(false)
    expect(dream.topCited.length).toBeGreaterThan(0)
    expect(dream.topCited[0].cited).toBeGreaterThanOrEqual(1)

    const loose = dream.dailyLooseEnds.find((d) => d.path === daily.path)
    expect(loose?.items).toEqual(['补实验数据', '回邮件'])

    // 窗口：把所有笔记都甩到 30 天前之后，窗口应当为空
    const later = await dreamLib.dreamNotebook(m3, { days: 1, now: new Date(Date.now() + 30 * 86_400_000) })
    expect(later.counts.window).toBe(0)
    expect(later.newNotes).toEqual([])
    expect(later.dailyLooseEnds).toEqual([])
  })

  test('looseEndsOf：认 Loose ends / 未完成 / 待办，跳过 [x]', () => {
    const src = '# 日记\n\n## Events\n\n- 开会\n\n## Loose ends\n\n- [ ] 补数据\n- [x] 做完了\n- 回邮件\n\n## 其他\n\n不该收\n'
    expect(dreamLib.looseEndsOf(src)).toEqual(['补数据', '回邮件'])
    expect(dreamLib.looseEndsOf('## 未完成\n\n1. 甲\n')).toEqual(['1. 甲'])
    expect(dreamLib.looseEndsOf('# 没有小节\n正文')).toEqual([])
  })

  test('lastDreamDate：只认整齐的一行；daysSinceDream 按日历天算', () => {
    expect(dreamLib.lastDreamDate('# 梦\n\n上次做梦：2026-10-22\n')).toBe('2026-10-22')
    expect(dreamLib.lastDreamDate('- **上次做梦**：2026-10-22')).toBe('2026-10-22')
    expect(dreamLib.lastDreamDate('上次做梦是在 2026-10-22 那天')).toBeNull()
    expect(dreamLib.lastDreamDate('# 梦\n\n没有标记\n')).toBeNull()

    const lateNight = new Date(2026, 9, 29, 23, 30)
    expect(dreamLib.daysSinceDream('2026-10-22', lateNight)).toBe(7)
    expect(dreamLib.daysSinceDream('2026-10-29', lateNight)).toBe(0)
    expect(dreamLib.daysSinceDream('2026-1-1', lateNight)).toBeNull()
  })

  test('透传参数：会破坏不变量的 flag 被丢掉，查询条件保留', () => {
    const args = zk.sanitizeListArgs([
      '--notebook-dir', '/x', '-x', 'raw', '--exclude=/y', '-f', 'json',
      '--limit', '5', '-m', '词', '-t', 'a', '-W', '/z', '-q', '--json', '--', 'pos',
    ])
    expect(args).toEqual(['--limit', '5', '-m', '词', '-t', 'a', 'pos'])
  })

  it('zk-kit query：用户传 -x 也绕不过统一排除', async () => {
    fs.writeFileSync(path.join(dir, 'raw', 'secret.md'), '# 素材\n\nQUERY-RAW-TOKEN\n')
    await zk.indexNotebook(m3)
    expect((await zk.queryNotes(m3, ['-x', 'notes', '-m', 'QUERY-RAW-TOKEN'])).length).toBe(0)
    const one = await zk.queryNotes(m3, ['-t', 'keep', '--limit', '1', '-s', 'title'])
    expect(one.length).toBe(1)
    expect(one[0].tags).toContain('keep')
  })

  it('query 透传：中文 0 命中退回 -M re（Z12）', async () => {
    const hits = await zk.queryNotes(m3, ['-m', '被引用'])
    expect(hits.map((n) => n.title)).toContain('被引用概念')
  })

  it('200 条笔记上 lint 在 3 秒内返回', async () => {
    const big = path.join(home, 'nb-200')
    const cfg200 = store.normalizeConfig({ notebook: big, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(cfg200)
    const concepts = path.join(big, 'notes', 'concepts')
    for (let i = 0; i < 200; i++) {
      const link = i > 0 ? '[[notes/concepts/n' + (i - 1) + ']]' : ''
      fs.writeFileSync(
        path.join(concepts, 'n' + i + '.md'),
        '---\ntype: concept\ntitle: 批量 ' + i + '\nstatus: active\ntags: []\n---\n\n# 批量 ' + i + '\n\n正文 ' + i + ' #t' + (i % 10) + ' ' + link + '\n',
        'utf8',
      )
    }
    await zk.indexNotebook(cfg200)
    const started = Date.now()
    const result = await lintLib.lintNotebook(cfg200)
    const elapsed = Date.now() - started
    expect(result.notes).toBe(200)
    expect(elapsed).toBeLessThan(3000)
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
  it('12 个工具，参数校验拒绝坏输入', () => {
    const defs = toolsFeature.buildTools()
    expect(defs.map((d) => d.name)).toEqual([
      'zk_search', 'zk_query', 'zk_read', 'zk_new', 'zk_daily', 'zk_append', 'zk_link', 'zk_supersede',
      'zk_context', 'zk_lint', 'zk_dream', 'zk_stats',
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
    const lint = await call('zk_lint', {})
    expect(Number(lint.notes)).toBeGreaterThan(3)
    expect(typeof (lint.orphans as Record<string, unknown>).total).toBe('number')
    const dream = await call('zk_dream', { days: 7 })
    expect(Array.isArray(dream.newNotes)).toBe(true)
    expect(Array.isArray(dream.rejected)).toBe(true)
    const stats = await call('zk_stats', {})
    expect(Number(stats.notes)).toBeGreaterThan(3)
  })

  it('zk_query 单独传 include_archived 也能查回 superseded 归档', async () => {
    const defs = toolsFeature.buildTools()
    const registry = new Map(defs.map((d) => [d.name, d]))
    const call = async (name: string, args: unknown) => {
      const d = registry.get(name)
      if (!d) throw new Error('missing ' + name)
      return await d.execute(args, { signal: AbortSignal.timeout(30_000) }) as Record<string, unknown>
    }

    const old = await call('zk_new', { title: '归档查询旧结论', body: '旧正文' })
    const next = await call('zk_new', { title: '归档查询新结论', body: '新正文' })
    await call('zk_supersede', { path: old.path, by: next.path, dry_run: false })

    const found = await call('zk_query', { include_archived: true, limit: 50 })
    const paths = (found.notes as Array<{ path: string }>).map((n) => n.path)
    expect(paths).toContain(`archive/${String(old.path)}`)
    expect(paths).toContain(String(next.path))
  })

  it('zk_read 截断会明确告诉模型', async () => {
    const defs = toolsFeature.buildTools()
    const read = defs.find((d) => d.name === 'zk_read')!
    const long = await read.execute({ query: '卡片盒', maxChars: 1000 }, { signal: AbortSignal.timeout(30_000) }) as Record<string, unknown>
    expect(typeof long.content).toBe('string')
    expect(read.output.render({}, long)[0].text).toContain('笔记')
  })
})

describe('M4: 结构设置与记忆预算', () => {
  const m4dir = path.join(home, 'nb-m4')
  const m4 = store.normalizeConfig({ notebook: m4dir, zkPath: zkBin, structure: 'layered' })
  const agentsFile = path.join(m4dir, 'AGENTS.md')

  it('layered 初始化写 AGENTS.md：含三件事，已有内容绝不覆盖', async () => {
    const first = await notebookLib.ensureNotebook(m4)
    expect(first.agentsWritten).toBe(true)
    const body = fs.readFileSync(agentsFile, 'utf8')
    // 三件必须写清的事（计划 §4 M4）
    expect(body).toContain('tags')
    expect(body).toMatch(/中文.*tags|tags.*中文/)
    expect(body).toContain('不会')
    expect(body).toContain('MEMORY.md')

    fs.writeFileSync(agentsFile, '# 我自己写的\n\n不覆盖我。\n')
    const again = await notebookLib.ensureNotebook(m4)
    expect(again.agentsWritten).toBe(false)
    expect(fs.readFileSync(agentsFile, 'utf8')).toBe('# 我自己写的\n\n不覆盖我。\n')
  })

  it('structureStatus 只报告：缺目录 / 缺 AGENTS.md 时 ready=false，不自己补', () => {
    fs.rmSync(path.join(m4dir, 'raw'), { recursive: true, force: true })
    fs.rmSync(agentsFile, { force: true })
    const st = notebookLib.structureStatus(m4)
    expect(st.mode).toBe('layered')
    expect(st.ready).toBe(false)
    expect(st.missing).toEqual(['raw'])
    expect(st.agents.required).toBe(true)
    expect(st.agents.present).toBe(false)
    // 只报告 = 检查本身不建目录
    expect(fs.existsSync(path.join(m4dir, 'raw'))).toBe(false)

    // flat 不要求 AGENTS.md
    const flat = notebookLib.structureStatus(store.normalizeConfig({ notebook: m4dir, structure: 'flat' }))
    expect(flat.mode).toBe('flat')
    expect(flat.agents.required).toBe(false)
  })

  it('按配置补建：缺什么补什么，补完 ready', async () => {
    const r = await notebookLib.ensureNotebook(m4)
    expect(r.dirsCreated).toEqual(['raw'])
    expect(r.agentsWritten).toBe(true)
    const st = notebookLib.structureStatus(m4)
    expect(st.ready).toBe(true)
    expect(st.agents.present).toBe(true)
  })

  it('设置写入后立刻生效：structure / memoryBudgetWords / archiveDir', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    try {
      store.writeConfig({ structure: 'layered', memoryBudgetWords: 180, archiveDir: 'attic' })
      const next = store.config()
      expect(next.structure).toBe('layered')
      expect(next.memoryBudgetWords).toBe(180)
      expect(next.archiveDir).toBe('attic')
      // 预算真的进注入：180 词上限
      expect(memory.buildMemoryPayload(next).budget).toBe(180)
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
  })

  it('zk_append 拒写 meta 文件', async () => {
    fs.writeFileSync(path.join(m4dir, 'MEMORY.md'), '# 记忆\n\n一条。\n')
    expect(() => zk.appendToNote(m4, 'AGENTS.md', '追加')).toThrow(/meta/)
    expect(() => zk.appendToNote(m4, 'MEMORY.md', '追加')).toThrow(/meta/)
    expect(() => zk.appendToNote(m4, 'DREAMS.md', '追加')).toThrow(/笔记不存在|meta/)
    const created = await zk.createNote(m4, { title: '可追加的普通笔记', dir: 'notes/concepts', content: '正文' })
    expect(zk.appendToNote(m4, created.path, '追加一段').appendedChars).toBe(4)
    // 子目录里的同名文件是普通笔记，不算 meta
    const nested = await zk.createNote(m4, { title: 'notes 下的 AGENTS', dir: 'notes/concepts', content: '正文' })
    expect(() => zk.appendToNote(m4, nested.path, '可以')).not.toThrow()
  })

  it('zk_stats 报 archived / superseded', async () => {
    const target = await zk.createNote(m4, { title: '会被废弃的结论', dir: 'notes/concepts', content: '旧结论' })
    const r = await zk.supersedeNote(m4, { path: target.path, dryRun: false })
    expect(r.performed).toBe(true)
    const stats = await zk.notebookStats(m4)
    expect(stats.archived).toBe(1)
    expect(stats.superseded).toBe(1)
    const defs = toolsFeature.buildTools()
    const statTool = defs.find((d) => d.name === 'zk_stats')!
    const line = statTool.output.render({}, { ...stats, notebook: m4dir })[0].text
    expect(line).toContain('归档 1')
    expect(line).toContain('superseded 1')
  })
})

describe('cli: zk-kit config', () => {
  const cli = path.resolve(import.meta.dir, '..', 'src', 'cli.ts')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', timeout: 30_000 })

  it('config get 读一个键；未知键报错并列出合法键', async () => {
    const paths = await import('../src/config/paths.ts')
    const got = run('config', 'get', 'structure')
    expect(got.status).toBe(0)
    expect((got.stdout ?? '').trim()).toBe(store.config().structure)
    expect(paths.CFG_FILE.length).toBeGreaterThan(0)

    const bad = run('config', 'get', 'nonsense')
    expect(bad.status).not.toBe(0)
    expect(bad.stderr ?? '').toContain('没有配置项 nonsense')
    expect(bad.stderr ?? '').toContain('structure')
  })

  it('config set 只落盘：切到 layered 不建任何目录', async () => {
    const paths = await import('../src/config/paths.ts')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-cli-'))
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    try {
      store.writeConfig({ notebooks: { default: { path: dir, structure: 'flat' } }, zkPath: zkBin, structure: 'flat' })
      const r = run('config', 'set', 'structure=layered')
      expect(r.status).toBe(0)
      expect((r.stdout ?? '').trim()).toBe('structure = layered')
      expect(store.config().structure).toBe('layered')
      // 无缝切换的前提：改配置不碰磁盘，目录要等 zk-kit init
      expect(fs.existsSync(path.join(dir, 'raw'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'notes'))).toBe(false)
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('归一化改了值要回显：structure=xyz 落盘成 flat 并告警', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    try {
      const r = run('config', 'set', 'structure=xyz')
      expect(r.status).toBe(0)
      expect(r.stderr ?? '').toContain('归一化')
      expect(r.stderr ?? '').toContain('"xyz" → 实际 "flat"')
      expect(store.config().structure).toBe('flat')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
  })

  it('config set notebook / notebooks 被拦下并指路（派生键不接受单键赋值）', async () => {
    const nb = run('config', 'set', 'notebook=/x')
    expect(nb.status).not.toBe(0)
    expect(nb.stderr ?? '').toContain('派生值')
    expect(nb.stderr ?? '').toContain('zk-kit notebooks')
    const nbs = run('config', 'set', 'notebooks=x')
    expect(nbs.status).not.toBe(0)
    expect(nbs.stderr ?? '').toContain('整体映射')
  })
})

describe('cli: zk-kit notebooks', () => {
  const cli = path.resolve(import.meta.dir, '..', 'src', 'cli.ts')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', timeout: 30_000 })

  test('add → use → list → remove，全程不炸且状态对得上（use 自动建好）', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const work = path.join(home, 'nb-work')
    try {
      const added = run('notebooks', 'add', 'work', work)
      expect(added.status).toBe(0)
      expect((added.stdout ?? '')).toContain(work)
      // add 不切换：当前还是 default；结构跟当前笔记本一致
      expect(store.config().active).toBe('default')
      expect(store.config().notebooks.work).toEqual({ path: work, structure: 'flat' })

      // 切换即就绪：use 顺手把目标笔记本建好，不用再跑 init
      const used = run('notebooks', 'use', 'work')
      expect(used.status).toBe(0)
      expect((used.stdout ?? '')).toContain('当前笔记本 → work')
      expect((used.stdout ?? '')).toContain('已自动建好')
      expect(store.config().notebook).toBe(work)
      expect(fs.existsSync(path.join(work, '.zk', 'config.toml'))).toBe(true)

      const listed = run('notebooks')
      expect(listed.status).toBe(0)
      expect(listed.stdout ?? '').toContain('* work')
      expect(listed.stdout ?? '').toContain('default')
      expect(listed.stdout ?? '').toContain('[flat]')

      const removed = run('notebooks', 'remove', 'work')
      expect(removed.status).toBe(0)
      expect(removed.stdout ?? '').toContain('磁盘目录与笔记保留')
      // 删掉的是当前那个 → 自动切回剩下的（剩下的本来就就绪，不再建一遍）
      expect(store.config().active).toBe('default')
      expect(store.config().notebooks).toEqual({ default: { path: notebook, structure: 'flat' } })
      // 只删配置：磁盘上的目录与笔记一个字不动
      expect(fs.existsSync(path.join(work, '.zk', 'config.toml'))).toBe(true)
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  test('结构跟着笔记本走：use 切到谁，config structure 就是谁的', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const work = path.join(home, 'nb-work-structure')
    try {
      run('notebooks', 'add', 'work', work)
      run('notebooks', 'use', 'work')
      const set = run('config', 'set', 'structure=layered')
      expect(set.status).toBe(0)
      expect(store.config().structure).toBe('layered')
      expect(store.config().notebooks.work.structure).toBe('layered')
      // 切回去：default 还是 flat，work 的 layered 不受影响
      run('notebooks', 'use', 'default')
      expect(store.config().structure).toBe('flat')
      expect(store.config().notebooks.work.structure).toBe('layered')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  test('坏输入：非法名字 / 不存在 / 删最后一个', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    try {
      const bad = run('notebooks', 'add', 'bad!', '/x')
      expect(bad.status).not.toBe(0)
      expect(bad.stderr ?? '').toContain('名字不合法')

      const missing = run('notebooks', 'use', 'nope')
      expect(missing.status).not.toBe(0)
      expect(missing.stderr ?? '').toContain('没有这个笔记本')

      const last = run('notebooks', 'remove', 'default')
      expect(last.status).not.toBe(0)
      expect(last.stderr ?? '').toContain('至少要留一个笔记本')
      expect(store.config().notebooks).toEqual({ default: { path: notebook, structure: 'flat' } })
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
  })
})

