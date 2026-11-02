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
const session = await import('../src/config/session.ts')
const zk = await import('../src/lib/zk.ts')
const memory = await import('../src/lib/memory.ts')
const memoryFormat = await import('../src/lib/memory-format.ts')
const notebookLib = await import('../src/lib/notebook.ts')
const notebookConfig = await import('../src/lib/notebook-config.ts')
const lintLib = await import('../src/lib/lint.ts')
const dreamLib = await import('../src/lib/dream.ts')
const toolsFeature = await import('../src/features/zk-tools/feature.ts')
const settingsFeature = await import('../src/features/settings/feature.ts')
const workspaceLib = await import('../src/lib/workspace.ts')
const toolLib = await import('../src/lib/tool.ts')
const fm = await import('../src/lib/frontmatter.ts')
const installLib = await import('../src/lib/install.ts')
const readonlyFeature = await import('../src/features/readonly/feature.ts')
const readonlyHtml = await import('../src/features/readonly/html.ts')

store.writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
const cfg = store.config()

const personaTpl = await import('../src/lib/persona-template.ts')
const metaLib = await import('../src/lib/meta.ts')

const available = (await zk.versionOf(zkBin)) !== null
const it = available ? test : test.skip

// 跳过 ≠ 通过：直接 `bun test` 又没 zk 时，必须留下一条红的，否则「全绿」是假的。
if (!available) {
  test('zk 不可用（集成测试已全部跳过）', () => {
    throw new Error(`找不到 zk：${zkBin}。给 ZK_BIN=/path/to/zk，或用 bun run test（按插件顺序解析）`)
  })
}

/** 宿主按无损 JSON 快照校验工具输出：undefined / 函数 / 非有限数都会让整次调用报 invalid output */
function lossyPaths(value: unknown, at = 'value'): string[] {
  if (value === undefined) return [at]
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return [at]
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return [at]
  if (Array.isArray(value)) return value.flatMap((item, i) => lossyPaths(item, `${at}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => lossyPaths(item, `${at}.${key}`))
  }
  return []
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

  test('writeConfig：stamp 不匹配就冲突，匹配才落盘', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const stamp = store.configStamp()
    try {
      expect(() => store.writeConfig({ notesDir: 'wrong' }, undefined, { expectStamp: 'stale' }))
        .toThrow(store.ConfigConflictError)
      expect(store.config().notesDir).not.toBe('wrong')

      const next = store.writeConfig({ notesDir: 'notes2' }, undefined, { expectStamp: stamp })
      expect(next.notesDir).toBe('notes2')
      expect(store.configStamp()).not.toBe(stamp)
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
    expect(onDisk.memoryBudgetWords).toBe(500)
  })
})

describe('会话固定笔记本', () => {
  test('切全局默认不带动已用过的会话；新会话跟默认；pin 落盘', async () => {
    const paths = await import('../src/config/paths.ts')
    const workDir = path.join(home, 'work-vault')
    const one = { default: { path: notebook, structure: 'flat' as const } }
    try {
      store.writeConfig({ notebooks: { ...one, work: { path: workDir, structure: 'flat' } }, active: 'default' })

      // 第一次调用：快照当时的默认值
      expect(session.configFor(home, 'sess-a').active).toBe('default')

      // 别处切库：已用的会话不动，新会话跟默认
      store.writeConfig({ active: 'work' })
      expect(session.configFor(home, 'sess-a').active).toBe('default')
      expect(session.configFor(home, 'sess-b').active).toBe('work')
      expect(store.config().active).toBe('work')

      // 每会话一份，互不覆盖；id 也落盘，方便排查
      const pins = fs.readdirSync(paths.SESSION_DIR)
        .map((f) => JSON.parse(fs.readFileSync(path.join(paths.SESSION_DIR, f), 'utf8')) as { id: string; notebook: string })
      expect(pins.find((p) => p.id === 'sess-a')?.notebook).toBe('default')
      expect(pins.find((p) => p.id === 'sess-b')?.notebook).toBe('work')

      // pin 指向的笔记本被删掉：回到默认值，不卡在空配置上
      store.writeConfig({ notebooks: one, active: 'default' })
      expect(session.configFor(home, 'sess-b').active).toBe('default')
    } finally {
      store.writeConfig({ notebooks: one, active: 'default' })
    }
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

  test('缓存层：同一份内容复用；文件 / 预算一变下一次立刻重算', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-cache-'))
    const cfg = store.normalizeConfig({ notebook: dir, memoryBudgetWords: 300 })
    try {
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# 记忆\n选了 SQLite。')
      const first = memory.buildMemoryPayload(cfg)
      expect(first.text).toContain('选了 SQLite。')
      // 宿主每个 step 都会求值：文件没动就不该再读盘、再算一遍
      expect(memory.buildMemoryPayload(cfg)).toBe(first)

      fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# 记忆\n改用 Postgres。')
      const fresh = memory.buildMemoryPayload(cfg)
      expect(fresh.text).toContain('改用 Postgres。')
      expect(fresh.text).not.toContain('选了 SQLite。')

      // 预算变了，截断结果就得重算
      expect(memory.buildMemoryPayload({ ...cfg, memoryBudgetWords: 50 })).not.toBe(fresh)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

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
    expect(p.tocWords).toBe(0)
    expect(p.text).not.toContain('未注入的段落')
    const mem = p.files.find((f) => f.name === 'MEMORY.md')
    expect(mem?.originalWords).toBe(mem?.words) // 没截断：原词数 = 保留词数
  })

  test('超预算：先丢 MEMORY 尾部整段，并回显截断词数', () => {
    const memoryBody = ['## 一', 'a '.repeat(30), '## 二', 'b '.repeat(30), '## 三', 'c '.repeat(30)].join('\n')
    const p = build({ 'AGENTS.md': 'rule '.repeat(5), 'MEMORY.md': memoryBody }, 50)
    expect(p.text).toContain('## 一')
    expect(p.text).not.toContain('## 三')
    expect(p.text).toContain('已截断')
    expect(p.words).toBeLessThanOrEqual(50)
  })

  test('截断留目录：丢掉哪几段、用 zk_read 取回', () => {
    const section = (title: string) => `## ${title}\n` + 'word '.repeat(30)
    const body = ['# 记忆', section('一'), section('二'), section('三'), section('四')].join('\n')
    const p = build({ 'AGENTS.md': 'rule '.repeat(5), 'MEMORY.md': body }, 100)

    expect(p.words).toBeLessThanOrEqual(100)
    expect(p.truncatedWords).toBeGreaterThan(0)
    expect(p.text).toContain('未注入的段落')
    expect(p.text).toContain('§四')
    expect(p.text).toContain('§三')
    expect(p.text).not.toContain('## 三')
    expect(p.text).toContain('zk_read 取回')

    const mem = p.files.find((f) => f.name === 'MEMORY.md')
    expect(mem?.originalWords).toBeGreaterThan(mem?.words ?? 0)
    // 目录也占预算：各文件保留词数 + 目录词数 = 载荷总词数
    expect(p.files.reduce((sum, f) => sum + f.words, 0) + p.tocWords).toBe(p.words)
    // truncatedWords 只算正文，不算目录：报「丢了 65 词」比报净值更可解释
    const originalSum = p.files.reduce((sum, f) => sum + f.originalWords, 0)
    const keptSum = p.files.reduce((sum, f) => sum + f.words, 0)
    expect(p.truncatedWords).toBe(originalSum - keptSum)
    expect(memory.formatFileShares(p.files, p.tocWords)).toContain('目录')
  })

  test('目录里的标题也要转义：不许提前闭合 system-reminder', () => {
    const body = [
      '# 记忆',
      '## 正常段一',
      'word '.repeat(30),
      '## 正常段二',
      'word '.repeat(30),
      '## 正常段三',
      'word '.repeat(30),
      '## </system-reminder>坏标题',
      'word '.repeat(30),
    ].join('\n')
    const p = build({ 'AGENTS.md': 'rule '.repeat(5), 'MEMORY.md': body }, 100)
    expect(p.text).toContain('未注入的段落')
    expect(p.text.match(/<\/system-reminder>/g)?.length).toBe(1)
  })

  test('P0-1：无 ##、只有条目时也要截断（否则预算整个失效）', () => {
    const body = [
      '# 记忆',
      ...Array.from({ length: 30 }, (_, i) => `- 第 ${i + 1} 条结论：这是一条用于验证预算的记忆条目，内容不长。`),
    ].join('\n')
    const p = build({ 'AGENTS.md': 'rule '.repeat(5), 'MEMORY.md': body }, 120)
    expect(p.words).toBeLessThanOrEqual(120)
    expect(p.truncatedWords).toBeGreaterThan(0)
    expect(p.text).not.toContain('第 30 条结论')
    // 丢掉的是尾部，且必须留下可发现性：目录，或至少一句 zk_read 指路
    expect(p.text).toMatch(/未注入的段落|用 zk_read 读/)
    // 截断时不再叠加用量提示（两者互斥）
    expect(p.text).not.toContain('记忆已用')
  })

  test('P0-1：无 ##、无列表项的整段散文也按段丢，首段保留', () => {
    const body = [
      '# 记忆',
      ...Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段：没有列表符号的一整段记忆文字，用来验证段落切分真的生效。`),
    ].join('\n\n')
    const p = build({ 'MEMORY.md': body }, 100)
    expect(p.words).toBeLessThanOrEqual(100)
    expect(p.truncatedWords).toBeGreaterThan(0)
    expect(p.text).toContain('第 1 段')
    expect(p.text).not.toContain('第 12 段')
  })

  test('P0-1：围栏里的 - 与空行不算可丢的条目 / 段落', () => {
    const body = [
      '# 记忆',
      '',
      '```',
      '- 代码里的条目',
      '## 也不是小节',
      '',
      'still code',
      '```',
      '',
      ...Array.from({ length: 6 }, (_, i) => `- 真条目${i + 1}：内容内容内容。`),
    ].join('\n')
    // 预算宽裕：一个字都不动
    const roomy = build({ 'MEMORY.md': body }, 500)
    expect(roomy.truncatedWords).toBe(0)
    expect(roomy.text).toContain('代码里的条目')
    // 紧预算：围栏整块在 head 里（永远保留），只丢真正的条目
    const tight = build({ 'MEMORY.md': body }, 50)
    expect(tight.text).toContain('代码里的条目')
    expect(tight.truncatedWords).toBeGreaterThan(0)
    expect(tight.text).not.toContain('真条目六')
  })

  test('P0-1：单条就超预算时不再切，点名「已无更多可丢」而不是只怪 AGENTS', () => {
    const p = build({ 'MEMORY.md': '# 记忆\n\n- 唯一一条：' + '很长 '.repeat(120) }, 50)
    expect(p.words).toBeGreaterThan(50)
    expect(p.text).toContain('预算不足')
    expect(p.text).toContain('MEMORY.md')
    expect(p.text).toMatch(/已无更多可丢的(条目|段落|小节)/)
  })

  test('P1-4：接近上限回显用量，且这一行算进预算', () => {
    const near = build({ 'MEMORY.md': '# 记忆\n' + 'w '.repeat(79) }, 100)
    expect(near.text).toContain('记忆已用')
    expect(near.words).toBeLessThanOrEqual(100)
    expect(near.ratio).toBeGreaterThanOrEqual(0.8)
    expect(near.ratio).toBeLessThanOrEqual(1)

    // 80% 以下不加：别把诊断信息变成每步的噪音
    const roomy = build({ 'MEMORY.md': '# 记忆\n' + 'w '.repeat(60) }, 100)
    expect(roomy.text).not.toContain('记忆已用')
    expect(roomy.ratio).toBeLessThan(0.8)
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
    const sections: Array<{ name: string; order: number; text: string | (() => string); interpolate?: boolean }> = []
    const withPrompt = {
      get: (name: string) => (name === 'systemPrompt'
        ? { section: (s: typeof sections[number]) => { sections.push(s); return () => undefined } }
        : undefined),
      effect: (fn: () => undefined | (() => void)) => { fn() },
    }
    plugin.apply(withPrompt as never)
    expect(sections.map((s) => s.name)).toEqual(['zdiary:notebook', 'zdiary:memory'])
    expect(sections[0].order).toBe(5190)
    expect(sections[1].order).toBe(5200)
    expect(typeof sections[0].text).toBe('function')
    expect(typeof sections[1].text).toBe('function')
    // 笔记本提示与记忆都是内容类：不插值，`{{…}}` 原样保留
    expect(sections[0].interpolate).toBe(false)
    expect(sections[1].interpolate).toBe(false)

    const bare = { get: () => undefined, effect: (fn: () => undefined | (() => void)) => { fn() } }
    expect(() => plugin.apply(bare as never)).not.toThrow()
  })

  test('笔记本提示：当前库带路径与结构，多库时列出其余库', async () => {
    const plugin = (await import('../src/app/plugin.ts')).default
    const work = path.join(home, 'work-notebook')
    const sections: Array<{ name: string; text: string | (() => string) }> = []
    const fake = {
      get: (name: string) => (name === 'systemPrompt'
        ? { section: (s: typeof sections[number]) => { sections.push(s); return () => undefined } }
        : undefined),
      effect: (fn: () => undefined | (() => void)) => { fn() },
    }
    store.writeConfig({
      notebooks: { default: { path: notebook, structure: 'flat' }, work: { path: work, structure: 'layered' } },
      active: 'default',
    })
    try {
      plugin.apply(fake as never)
      const section = sections.find((s) => s.name === 'zdiary:notebook')
      expect(section).toBeDefined()
      const line = (section!.text as () => string)()
      expect(line).toContain('当前笔记本「default」（flat）')
      expect(line).toContain(notebook)
      expect(line).toContain('另有：work')
      expect(line).toContain('zk_use')
    } finally {
      store.writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, active: 'default', zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
    }
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
      const memorySection = sections.find((s) => s.name === 'zdiary:memory')!
      const text = memorySection.text as (ctx?: { agent?: { id?: string } }) => string
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

describe('M1: 配置收敛（group）', () => {
  test('解析 group：双 / 单引号 / 裸键、缺 paths、重复、注释归属', () => {
    const text = [
      '# dsh-zdiary-kit：日记笔记组',
      '[group."daily"]',
      'paths = ["journal"]',
      '',
      '[group."daily".note]',
      'template = "daily.md"',
      '',
      '# 用户自己写的',
      "[group.'single']",
      "paths = ['a', 'b']",
      '',
      '[group."nopaths"]',
      '',
      '[group."dup"]',
      'paths = ["x"]',
      '',
      '[group."dup"]',
      'paths = ["y"]',
      '',
      // 裸键组头是合法 TOML（zk 自己的模板就这么写）：必须认，还认 .note 子表与行尾注释
      '[group.bare]',
      "paths = ['b', 'c']  # 行尾注释",
      '',
      '[group.bare2]',
      '[group.bare2.note]',
      'template = "daily.md"',
    ].join('\n')
    const blocks = notebookConfig.parseGroupBlocks(text)
    const daily = blocks.get('daily')!
    expect(daily.paths).toEqual(['journal'])
    expect(daily.pathsState).toBe('set')
    expect(daily.template).toBe('daily.md')
    expect(daily.comment).toContain('dsh-zdiary-kit')
    expect(notebookConfig.isPluginOwned(daily)).toBe(true)
    expect(blocks.get('single')!.paths).toEqual(['a', 'b'])
    expect(notebookConfig.isPluginOwned(blocks.get('single')!)).toBe(false)
    expect(blocks.get('nopaths')!.paths).toBeNull()
    // 缺 paths 不是「没有路径」：zk 按同名目录归组
    expect(blocks.get('nopaths')!.pathsState).toBe('absent')
    expect(notebookConfig.effectivePaths(blocks.get('nopaths')!)).toEqual(['nopaths'])
    expect(blocks.get('bare')!.paths).toEqual(['b', 'c'])
    expect(blocks.get('bare2')!.template).toBe('daily.md')
    expect(notebookConfig.effectivePaths(blocks.get('bare2')!)).toEqual(['bare2'])
    expect(blocks.get('dup')!.duplicate).toBe(true)
    expect(blocks.get('dup')!.paths).toBeNull()
    expect(notebookConfig.effectivePaths(blocks.get('dup')!)).toBeNull()
    expect(notebookConfig.samePaths(['./journal/'], ['journal'])).toBe(true)
    expect(notebookConfig.samePaths(['journal', 'extra'], ['journal'])).toBe(false)
    expect(notebookConfig.sameGroupPath('./notes/', 'notes')).toBe(true)
    // 父子目录是合法的（zk 按最具体的路径归组），不算冲突
    expect(notebookConfig.sameGroupPath('notes', 'notes/concepts')).toBe(false)
    expect(notebookConfig.sameGroupPath('notes', 'journal')).toBe(false)
  })

  it('改 dailyDir：groupsOk=false，init 不追加重复 group，--fix 只改 paths', async () => {
    const dir = path.join(home, 'nb-groups-daily')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)
    expect(notebookLib.structureStatus(base).groupsOk).toBe(true)

    const changed = { ...base, dailyDir: 'diary' }
    const before = notebookLib.structureStatus(changed)
    expect(before.groupsOk).toBe(false)
    expect(before.groups[0].expectedPaths).toEqual(['diary'])
    expect(before.groups[0].actualPaths).toEqual(['journal'])
    expect(before.groupWarnings.length).toBe(1)

    const again = await notebookLib.ensureNotebook(changed)
    expect(again.groupsAdded).toEqual([])
    expect(again.groupWarnings.length).toBe(1)
    const unchanged = fs.readFileSync(path.join(dir, '.zk', 'config.toml'), 'utf8')
    expect(unchanged.match(/^\[group\."daily"\]/gm)?.length).toBe(1)
    expect(unchanged).not.toContain('[group."diary"]')

    const fixed = notebookLib.fixGroupConfig(changed)
    expect(fixed.changed).toBe(true)
    expect(fixed.updates.some((u) => u.action === 'paths')).toBe(true)
    expect(fixed.backup).toBeTruthy()
    expect(fs.existsSync(fixed.backup!)).toBe(true)
    const toml = fs.readFileSync(path.join(dir, '.zk', 'config.toml'), 'utf8')
    expect(toml).toContain('paths = ["diary"]')
    expect(toml).not.toContain('paths = ["journal"]')
    expect(notebookLib.structureStatus(changed).groupsOk).toBe(true)
  })

  it('改 dailyGroup：不追加抢同一路径的 group；--fix 把旧组头改名（含 .note）', async () => {
    const dir = path.join(home, 'nb-groups-rename')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)

    const renamed = { ...base, dailyGroup: 'diary' }
    const before = fs.readFileSync(path.join(dir, '.zk', 'config.toml'), 'utf8')
    const result = await notebookLib.ensureNotebook(renamed)
    expect(result.groupsAdded).toEqual([])
    expect(result.groupWarnings.some((w) => w.includes('占用'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, '.zk', 'config.toml'), 'utf8')).toBe(before)

    const fixed = notebookLib.fixGroupConfig(renamed)
    expect(fixed.updates.some((u) => u.action === 'rename' && u.from === 'daily')).toBe(true)
    const toml = fs.readFileSync(path.join(dir, '.zk', 'config.toml'), 'utf8')
    expect(toml).toContain('[group."diary"]')
    expect(toml).toContain('[group."diary".note]')
    expect(toml).not.toContain('[group."daily"]')
    // 改名不动路径与模板
    expect(toml).toContain('paths = ["journal"]')
    expect(toml).toContain('template = "daily.md"')
    expect(notebookLib.structureStatus(renamed).groupsOk).toBe(true)
  })

  it('--fix 不覆盖自定义 template / extra', async () => {
    const dir = path.join(home, 'nb-groups-custom')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)
    const file = path.join(dir, '.zk', 'config.toml')
    const custom = fs.readFileSync(file, 'utf8')
      .replace('template = "daily.md"', 'template = "mine.md"') +
      '\n[group."daily".extra]\nowner = "me"\n'
    fs.writeFileSync(file, custom)

    const changed = { ...base, dailyDir: 'entries' }
    const fixed = notebookLib.fixGroupConfig(changed)
    expect(fixed.changed).toBe(true)
    const toml = fs.readFileSync(file, 'utf8')
    expect(toml).toContain('paths = ["entries"]')
    expect(toml).toContain('template = "mine.md"')
    expect(toml).toContain('owner = "me"')
  })

  it('archiveDir：旧目录非空拒绝改动；空目录 / 不存在允许', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const dir = path.join(home, 'nb-archive-guard')
    try {
      fs.mkdirSync(path.join(dir, 'archive'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'archive', 'old.md'), '# 废弃\n')
      store.writeConfig({ notebooks: { default: { path: dir, structure: 'flat' } }, active: 'default', archiveDir: 'archive' })

      expect(() => store.writeConfig({ archiveDir: 'attic' })).toThrow(store.ArchiveDirChangeError)
      expect(store.config().archiveDir).toBe('archive')

      // 空目录允许改
      fs.rmSync(path.join(dir, 'archive', 'old.md'))
      store.writeConfig({ archiveDir: 'attic' })
      expect(store.config().archiveDir).toBe('attic')

      // 旧目录不存在也允许改
      store.writeConfig({ archiveDir: 'gone' })
      expect(store.config().archiveDir).toBe('gone')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
  })

  it('archiveDir：非当前笔记本也受保护，读取失败不按空目录放行', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const active = path.join(home, 'nb-archive-active')
    const other = path.join(home, 'nb-archive-other')
    try {
      fs.mkdirSync(path.join(other, 'archive'), { recursive: true })
      fs.writeFileSync(path.join(other, 'archive', 'retired.md'), '# 废弃\n')
      store.writeConfig({
        notebooks: {
          default: { path: active, structure: 'flat' },
          other: { path: other, structure: 'flat' },
        },
        active: 'default',
        archiveDir: 'archive',
      })

      // archiveDir 是全局项：当前库为空，也不能漏掉另一本里的非空旧归档
      expect(() => store.writeConfig({ archiveDir: 'attic' })).toThrow(store.ArchiveDirChangeError)
      expect(store.config().archiveDir).toBe('archive')

      // ENOENT 之外的读取失败必须失败关闭，不能猜旧归档是空的
      fs.rmSync(path.join(other, 'archive'), { recursive: true, force: true })
      fs.writeFileSync(path.join(other, 'archive'), 'not a directory')
      expect(() => store.writeConfig({ archiveDir: 'attic' })).toThrow()
      expect(store.config().archiveDir).toBe('archive')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
  })

  it('dailyDir 撞上已有 group 的路径：groupsOk=false，--fix 一个都不写', async () => {
    const dir = path.join(home, 'nb-groups-samepath')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered', dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)
    const same = { ...base, dailyDir: 'notes/concepts' }

    const st = notebookLib.structureStatus(same)
    expect(st.groupsOk).toBe(false)
    expect(st.expectedOverlaps).toContainEqual({ a: 'daily', b: 'concept', path: 'notes/concepts' })
    expect(st.groupWarnings.some((w) => w.includes('都用 notes/concepts'))).toBe(true)
    expect(notebookLib.groupOverlapNotes(st)[0].level).toBe('config')

    // 写下去就是两个 group 用同一条路径：整轮不改，连备份都不留
    const before = fs.readFileSync(path.join(dir, '.zk', 'config.toml'), 'utf8')
    const fixed = notebookLib.fixGroupConfig(same)
    expect(fixed.changed).toBe(false)
    expect(fixed.backup).toBeNull()
    expect(fixed.updates.some((u) => u.action === 'skip' && (u.reason ?? '').includes('同一条路径'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, '.zk', 'config.toml'), 'utf8')).toBe(before)
  })

  it('config.toml 里已经同路径：报 actualOverlaps，--fix 把插件建的改回期望', async () => {
    const dir = path.join(home, 'nb-groups-actual')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(base)
    const file = path.join(dir, '.zk', 'config.toml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('paths = ["notes/concepts"]', 'paths = ["journal"]'))

    const st = notebookLib.structureStatus(base)
    expect(st.groupsOk).toBe(false)
    expect(st.actualOverlaps).toContainEqual({ a: 'daily', b: 'concept', path: 'journal' })
    expect(notebookLib.groupOverlapNotes(st)).toContainEqual({
      level: 'file',
      text: 'group "daily" 与 "concept" 的 paths 都是 journal —— 手动检查 .zk/config.toml',
    })

    expect(notebookLib.fixGroupConfig(base).changed).toBe(true)
    expect(notebookLib.structureStatus(base).groupsOk).toBe(true)
  })

  it('--fix 不把 paths 改到用户 group 占着的路径', async () => {
    const dir = path.join(home, 'nb-groups-rival')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)
    const file = path.join(dir, '.zk', 'config.toml')
    fs.appendFileSync(file, '\n# 用户自己的\n[group."mine"]\npaths = ["entries"]\n')

    const before = fs.readFileSync(file, 'utf8')
    const fixed = notebookLib.fixGroupConfig({ ...base, dailyDir: 'entries' })
    expect(fixed.changed).toBe(false)
    expect(fixed.updates.some((u) => u.action === 'skip' && (u.reason ?? '').includes('mine'))).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('父子目录不算冲突：dailyDir 落在 notes/ 下仍可 --fix（zk 按最具体的路径归组）', async () => {
    const dir = path.join(home, 'nb-groups-parent')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered', dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)
    const changed = { ...base, dailyDir: 'notes' }

    expect(notebookLib.structureStatus(changed).expectedOverlaps).toEqual([])
    expect(notebookLib.fixGroupConfig(changed).changed).toBe(true)
    const st = notebookLib.structureStatus(changed)
    expect(st.groups[0].actualPaths).toEqual(['notes'])
    expect(st.groupsOk).toBe(true)
  })

  it('未加引号的组头：识别、不追加重复组（曾把 config 写成重复表，zk 拒读），--fix 仍能改 paths / 组头', async () => {
    const dir = path.join(home, 'nb-groups-bare')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)
    const file = path.join(dir, '.zk', 'config.toml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replaceAll('[group."daily"]', '[group.daily]')
      .replaceAll('[group."daily".note]', '[group.daily.note]'))

    expect(notebookLib.structureStatus(base).groupsOk).toBe(true)
    const again = await notebookLib.ensureNotebook(base)
    expect(again.groupsAdded).toEqual([])
    expect(again.groupWarnings).toEqual([])
    const text = fs.readFileSync(file, 'utf8')
    // 回归：认不出裸键表头就会追加 [group."daily"] —— 同名 TOML 表定义两次，zk 拒读整个配置
    expect(text.match(/^\[group\.daily\]$/gm)?.length).toBe(1)
    expect(text).not.toContain('[group."daily"]')
    await zk.indexNotebook(base) // zk 真的读得懂这份配置

    const fixed = notebookLib.fixGroupConfig({ ...base, dailyDir: 'entries' })
    expect(fixed.changed).toBe(true)
    expect(fixed.updates.some((u) => u.action === 'paths')).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('paths = ["entries"]')

    const renamed = notebookLib.fixGroupConfig({ ...base, dailyDir: 'entries', dailyGroup: 'diary' })
    expect(renamed.updates.some((u) => u.action === 'rename' && u.from === 'daily')).toBe(true)
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain('[group."diary"]')
    expect(after).toContain('[group."diary".note]')
    expect(after).not.toContain('[group.daily]')
  })

  it('省略 paths 的 group 按同名目录占位：不追加同路径组（zk 语义）', async () => {
    const dir = path.join(home, 'nb-groups-implicit')
    const base = store.normalizeConfig({ notebook: dir, zkPath: zkBin, dailyDir: 'journal' })
    await notebookLib.ensureNotebook(base)
    const file = path.join(dir, '.zk', 'config.toml')
    // 用户自己写的组：没写 paths —— zk 把它当成 paths = ["journal"]（组名 = 目录）
    const text = fs.readFileSync(file, 'utf8')
      .replace(/# dsh-zdiary-kit：日记笔记组[\s\S]*?template = "daily\.md"\n/, '')
    fs.writeFileSync(file, text + '\n# 用户自己的\n[group."journal"]\n')

    const st = notebookLib.structureStatus(base)
    expect(st.groupsOk).toBe(false)
    expect(st.groups[0].conflict).toBe('journal')
    const res = await notebookLib.ensureNotebook(base)
    expect(res.groupsAdded).toEqual([])
    expect(res.groupWarnings.some((w) => w.includes('已被 group "journal" 占用'))).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('[group."daily"]')
    await zk.indexNotebook(base)
  })
})

describe('M2: 记忆生命周期', () => {
  const buildMem = (files: Record<string, string>, budget = 300) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-m2-'))
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
    try {
      const cfg = store.normalizeConfig({ notebook: dir, memoryBudgetWords: budget })
      return { cfg, payload: memory.buildMemoryPayload(cfg), dir }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('按最旧日期丢条目，目录按文件位置而不是丢弃顺序', () => {
    const entry = (label: string, date: string, word: string) =>
      `- ${label} 结论（${date}） ` + `${word} `.repeat(30)
    const body = [
      '# 记忆',
      '',
      entry('B', '2025-06-01', 'bword'),
      entry('A', '2025-01-01', 'aword'),
      entry('C', '2025-09-01', 'cword'),
      entry('D', '2026-01-01', 'dword'),
    ].join('\n')
    const { payload } = buildMem({ 'MEMORY.md': body }, 120)

    expect(payload.truncatedWords).toBeGreaterThan(0)
    // 丢的是最旧的两条（A / B），而不是文件末尾的两条（C / D 还在正文里）
    expect(payload.text).not.toContain('- A 结论')
    expect(payload.text).not.toContain('- B 结论')
    expect(payload.text).toContain('- C 结论')
    expect(payload.text).toContain('- D 结论')
    // 目录按原文件位置排：B（第一条）在 A 之前，尽管先被丢的是 A
    expect(payload.text).toContain('§B 结论')
    expect(payload.text).toContain('§A 结论')
    expect(payload.text.indexOf('§B 结论')).toBeLessThan(payload.text.indexOf('§A 结论'))
  })

  it('一条日期都没有时退回尾部丢，并在 notice 里说明', () => {
    const body = [
      '# 记忆',
      ...Array.from({ length: 8 }, (_, i) => `- 第 ${i + 1} 条：没有日期的结论，内容不长但足够占预算。`),
    ].join('\n')
    const { payload } = buildMem({ 'MEMORY.md': body }, 60)
    expect(payload.truncatedWords).toBeGreaterThan(0)
    expect(payload.text).not.toContain('第 8 条')
    expect(payload.text).toContain('只能按位置丢')
  })

  it('退役条目：注入省略（含缩进续行 / 子列表）、notice 计数、大小写都算', () => {
    const body = [
      '# 记忆',
      '',
      '- 活条目（2026-01-01）[[notes/keep.md]]',
      '- [Superseded 2026-02-01] 旧条目 → [[notes/new.md]]',
      '  - 旧条目的子列表，也不该留下',
      '  这一行是旧条目的续行，不该留下',
      '- 末尾的活条目（2026-03-01）',
      '',
    ].join('\n')
    const { payload } = buildMem({ 'MEMORY.md': body })
    // 缩进子列表属于上一条顶层条目，不能另起一条逃过退役省略
    expect(memoryFormat.splitMemoryEntries(body)).toHaveLength(3)
    expect(payload.text).toContain('活条目')
    expect(payload.text).toContain('末尾的活条目')
    expect(payload.text).not.toContain('旧条目')
    expect(payload.text).not.toContain('子列表')
    expect(payload.text).not.toContain('续行')
    expect(payload.text).toContain('已省略 1 条退役条目')
    // 退役不是截断：truncatedWords 不把省略算进去
    expect(payload.truncatedWords).toBe(0)
  })

  it('dream：退役行的链接仍算已晋升，旧标题不再算', async () => {
    const dir = path.join(home, 'nb-m2-dream')
    const cfg = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(cfg)
    const reused = await zk.createNote(cfg, { title: '重复标题的旧结论', dir: 'notes/concepts', content: '正文 #keep' })
    const successor = await zk.createNote(cfg, { title: '新结论替代旧结论', dir: 'notes/concepts', content: '正文 #keep' })
    fs.writeFileSync(path.join(dir, 'archive', '旧结论.md'), '# 旧\n')
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), [
      '# 记忆',
      `- [superseded 2026-02-01] 重复标题的旧结论 → [[${successor.path}]]`,
      '- 老结论（2025-01-01）[[notes/已经不存在.md]]',
      '- 显式引用归档（2026-10-25）[[archive/旧结论.md]]',
      '',
    ].join('\n'))

    const dream = await dreamLib.dreamNotebook(cfg, { days: 7 })
    // 链接匹配用原文：退役行里的 → [[新结论]] 是合法的已晋升指针
    expect(dream.alreadyPromoted.map((n) => n.path)).toContain(successor.path)
    expect(dream.alreadyPromoted.find((n) => n.path === successor.path)?.promotedBy).toBe('link')
    // 标题匹配用 strip 之后的正文：旧标题不再算已晋升，复用同名的笔记回到候选
    expect(dream.newNotes.map((n) => n.path)).toContain(reused.path)
    // 退役候选：来源不存在 + 超过 90 天未复核；退役行本身不进候选
    expect(dream.retireCandidates.map((c) => c.reason)).toContain('source-missing')
    expect(dream.retireCandidates.map((c) => c.entry).some((e) => e.includes('老结论'))).toBe(true)
    expect(dream.retireCandidates.map((c) => c.entry).some((e) => e.includes('重复标题的旧结论'))).toBe(false)
    // 显式写 archive/ 的链接是有意引用旧结论（与 lint 同口径）：不算来源断了，不进退役候选
    expect(dream.retireCandidates.map((c) => c.entry).some((e) => e.includes('显式引用归档'))).toBe(false)
    // 余量与注入同一口径
    expect(dream.memory.budget).toBe(cfg.memoryBudgetWords)
    expect(dream.memory.totalWords).toBeGreaterThanOrEqual(dream.memory.words)
  })

  it('memoryUsage：words 与 payload 一致，totalWords 含框，余量可以为负', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-m2-usage-'))
    try {
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# 记忆\n\n- 结论（2026-01-01）\n')
      const cfg = store.normalizeConfig({ notebook: dir, memoryBudgetWords: 300 })
      const payload = memory.buildMemoryPayload(cfg)
      const usage = memory.memoryUsage(cfg)
      expect(usage.words).toBe(payload.words)
      expect(usage.totalWords).toBe(memory.countWords(payload.text))
      expect(usage.totalWords).toBeGreaterThan(usage.words)
      expect(usage.headroom).toBe(300 - usage.totalWords)

      // AGENTS 硬规则不截断：内容没超、整段载荷超了，余量为负
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'rule '.repeat(400))
      const over = memory.memoryUsage(cfg)
      expect(over.headroom).toBeLessThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stale：89 / 90 天不报、91 天报；非法日期不算有日期', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-m2-stale-'))
    try {
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), [
        '# 记忆',
        '- 八十九天（2026-03-04）',
        '- 九十天（2026-03-03）',
        '- 九十一天（2026-03-02）',
        '- 坏日期（2026-99-99）',
        '',
      ].join('\n'))
      const cfg = store.normalizeConfig({ notebook: dir })
      const bucket = lintLib.memoryLinkIssues(cfg, [], { staleDays: 90, now: new Date(2026, 5, 1) })
      expect(bucket.stale.total).toBe(1)
      expect(bucket.stale.items[0]).toMatchObject({ date: '2026-03-02', age: 91 })
      expect(bucket.undated).toBe(1)
      expect(lintLib.formatMemoryLinks(bucket)).toContain('1 条超过 90 天未复核')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
    for (const dir of ['raw', 'notes/sources', 'notes/concepts', 'notes/entities', 'notes/patterns', 'archive']) {
      expect(fs.existsSync(path.join(layeredDir, dir))).toBe(true)
    }
    // inbox/ 是已停用的入口（P2-8）：新建库不再建它，盘上已有的老目录原样保留
    expect(fs.existsSync(path.join(layeredDir, 'inbox'))).toBe(false)
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

  it('name：文件名不再跟标题走，同目录的重复标题仍然拦下', async () => {
    const created = await zk.createNote(layered, {
      title: '给中文标题配短文件名',
      name: '短文件名',
      dir: 'notes/concepts',
      content: '正文',
    })
    expect(created.path).toBe('notes/concepts/短文件名.md')
    expect(fs.readFileSync(created.absPath, 'utf8')).toContain('title: 给中文标题配短文件名')

    // 文件名和标题脱钩后 zk 的 slug 撞名就失效了：同目录同名标题要在建之前拦住
    await expect(zk.createNote(layered, {
      title: '给中文标题配短文件名',
      name: '另一个短名',
      dir: 'notes/concepts',
    })).rejects.toThrow(/同目录下已有同名笔记/)
    expect(fs.existsSync(path.join(layeredDir, 'notes/concepts/另一个短名.md'))).toBe(false)
  })
})

describe('建完收尾：摘要', () => {
  const collideDir = path.join(home, 'nb-collide')
  const collide = store.normalizeConfig({ notebook: collideDir, zkPath: zkBin, structure: 'layered' })
  const flatDir = path.join(home, 'nb-summary-flat')
  const flat = store.normalizeConfig({ notebook: flatDir, zkPath: zkBin })

  it('正文自带 ## Content：原样留着，建完不做静默折叠', async () => {
    await notebookLib.ensureNotebook(collide)
    const created = await zk.createNote(collide, {
      title: '正文带小节',
      dir: 'notes/concepts',
      content: '## Content\n\n正文一句',
    })
    const raw = fs.readFileSync(created.absPath, 'utf8')
    // 模板空壳 + 正文那一节都在：重复标题靠 body 的入参说明预防，不靠事后删正文
    expect(raw.match(/^## Content$/gm)?.length).toBe(2)
    expect(raw).toContain('正文一句')
  })

  it('summary 填进模板里空着的 ## Summary', async () => {
    await notebookLib.ensureNotebook(collide)
    const created = await zk.createNote(collide, {
      title: '带摘要',
      dir: 'notes/concepts',
      summary: '一句话摘要',
      content: '正文一句',
    })
    expect(created.summaryApplied).toBe(true)
    expect(created.summaryWarning).toBeUndefined()
    const raw = fs.readFileSync(created.absPath, 'utf8')
    expect(raw.match(/^## Summary$/gm)?.length).toBe(1)
    expect(raw).toContain('## Summary\n\n一句话摘要\n\n## Content')
    expect(raw).toContain('## Content\n\n正文一句')
  })

  it('flat：没有这一小节就在一级标题下面补一节', async () => {
    await notebookLib.ensureNotebook(flat)
    const created = await zk.createNote(flat, { title: '扁平带摘要', summary: '扁平摘要', content: '正文' })
    expect(created.summaryApplied).toBe(true)
    const raw = fs.readFileSync(created.absPath, 'utf8')
    expect(raw.startsWith('# 扁平带摘要\n\n## Summary\n\n扁平摘要\n\n正文')).toBe(true)
  })

  it('summary 是空白：当作没给，不写也不告警', async () => {
    const created = await zk.createNote(collide, {
      title: '空白摘要',
      dir: 'notes/concepts',
      summary: '   ',
      content: '正文',
    })
    expect(created.summaryApplied).toBe(false)
    expect(created.summaryWarning).toBeUndefined()
    const raw = fs.readFileSync(created.absPath, 'utf8')
    expect(raw).toContain('## Summary\n\n## Content')
  })

  it('正文自己写了 Summary：不覆盖，返回 summaryApplied=false 并给出原因', async () => {
    const created = await zk.createNote(collide, {
      title: '正文自带摘要',
      dir: 'notes/concepts',
      summary: '参数里的摘要',
      content: '## Summary\n\n正文里的摘要',
    })
    expect(created.summaryApplied).toBe(false)
    expect(created.summaryWarning).toContain('summary 没写进去')
    const raw = fs.readFileSync(created.absPath, 'utf8')
    // 模板那段空壳也留着（只填不删），所以这里是两节 —— 这正是要告警的原因
    expect(raw.match(/^## Summary$/gm)?.length).toBe(2)
    expect(raw).toContain('正文里的摘要')
    expect(raw).not.toContain('参数里的摘要')
  })
})

describe('notes', () => {
  it('withTags：正文里已经写过的标签不再重复追加', () => {
    expect(zk.withTags('正文\n\n#素材 #来源', ['素材', '来源'])).toBe('正文\n\n#素材 #来源')
    expect(zk.withTags('正文 #素材', ['素材', '来源'])).toBe('正文 #素材\n\n#来源')
    // 边界：#素材库 不是 #素材
    expect(zk.withTags('正文 #素材库', ['素材'])).toBe('正文 #素材库\n\n#素材')
  })

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

  it('name 指定文件名：标题 / 正文不动，只换路径；扩展名不重复', async () => {
    const created = await zk.createNote(cfg, { title: '命名参数', name: '短名.md', content: '正文还在' })
    expect(path.basename(created.path)).toBe('短名.md')
    const disk = fs.readFileSync(created.absPath, 'utf8')
    expect(disk).toContain('# 命名参数')
    expect(disk).toContain('正文还在')
    expect((await zk.readNote(cfg, created.path)).title).toBe('命名参数')
  })

  it('name 撞名 / 非法字符：建之前就报错，目录里不多出文件', async () => {
    const dirAbs = path.dirname((await zk.createNote(cfg, { title: '占位标题', name: '占位文件' })).absPath)
    const before = fs.readdirSync(dirAbs).length
    await expect(zk.createNote(cfg, { title: '另一个标题', name: '占位文件' })).rejects.toThrow(/同名笔记已存在/)
    await expect(zk.createNote(cfg, { title: '越界标题', name: 'notes/越界' })).rejects.toThrow(/不能用的字符/)
    await expect(zk.createNote(cfg, { title: '空名标题', name: '  ' })).rejects.toThrow(/不能为空/)
    expect(fs.readdirSync(dirAbs).length).toBe(before)
  })

  it('扫描失败时：layered 照建（fail-open），flat 仍然拦下（fail-closed）', async () => {
    // 造一个「全库扫描一定失败」的版本：不伪装 zk 二进制，两个平台都能跑
    const boom: zk.NoteScan = async () => { throw new zk.ZkError('boom: 全库扫描挂了') }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-scan-'))
    const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-scan-flat-'))
    try {
      // layered：同名由 zk 自己拒，归档提醒只是附加信息 —— 扫不动也要照建，宁可少一条提醒
      const layered = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
      await notebookLib.ensureNotebook(layered)
      const built = await zk.createNote(layered, { title: '扫描挂掉也照建', dir: 'notes/concepts', content: '正文' }, undefined, boom)
      expect(fs.existsSync(built.absPath)).toBe(true)
      expect(built.archived).toEqual([])

      // flat：标题查重是写入前的硬门槛（不查会静默丢正文）—— 扫不了就不建
      const flat = store.normalizeConfig({ notebook: flatDir, zkPath: zkBin })
      await notebookLib.ensureNotebook(flat)
      await expect(zk.createNote(flat, { title: 'flat 扫不了就不建', content: '正文' }, undefined, boom)).rejects.toThrow(/boom/)
      expect(fs.readdirSync(path.join(flatDir, flat.notesDir))).toHaveLength(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(flatDir, { recursive: true, force: true })
    }
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
    const reason = '实测新值覆盖旧值'
    const dry = await zk.supersedeNote(m2, { path: oldNote.path, by: newNote.path, reason })
    expect(dry.dryRun).toBe(true)
    expect(dry.performed).toBe(false)
    expect(dry.archivePath).toBe(`archive/${oldNote.path}`)
    expect(dry.rewrittenLinks.map((r) => r.path).sort()).toEqual([newNote.path, source.path].sort())
    expect(fs.existsSync(oldNote.absPath)).toBe(true)
    expect(fs.readFileSync(oldNote.absPath, 'utf8')).toContain('status: active')
    expect(fs.readFileSync(oldNote.absPath, 'utf8')).not.toContain('supersede-reason')
    expect(dry.reason).toBe(reason)
    expect(fs.readFileSync(source.absPath, 'utf8')).toContain('[[notes/concepts/')

    // ── 执行 ──
    const done = await zk.supersedeNote(m2, { path: oldNote.path, by: newNote.path, reason, dryRun: false })
    expect(done.performed).toBe(true)
    expect(fs.existsSync(oldNote.absPath)).toBe(false)
    const archivedAbs = path.join(dir, done.archivePath)
    expect(done.archivePath.startsWith('archive/notes/concepts/')).toBe(true)
    const archived = fs.readFileSync(archivedAbs, 'utf8')
    expect(archived).toContain('status: superseded')
    expect(archived).toContain('superseded-by: [[')
    expect(done.reason).toBe(reason)
    expect(archived).toContain(`supersede-reason: "${reason}"`)
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
    expect(replay.reason).toBe(reason)
  })

  it('supersede-reason：单行、带冒号/引号也能安全落盘并读回', async () => {
    await notebookLib.ensureNotebook(m2)
    const a = await note('待废冒号甲', 'notes/concepts', '甲')
    const b = await note('替代冒号甲', 'notes/concepts', '乙')
    const reason = '旧值：\n已被 "新数据" 推翻'
    const r = await zk.supersedeNote(m2, { path: a.path, by: b.path, reason, dryRun: false })
    expect(r.reason).toBe('旧值： 已被 "新数据" 推翻')

    const text = fs.readFileSync(path.join(dir, r.archivePath), 'utf8')
    expect(text).toContain('supersede-reason: "旧值： 已被 \\"新数据\\" 推翻"')
    // 双引号标量走 JSON：读回来是原字符，不是带反斜杠的字面量
    expect(fm.parseFrontmatter(text).fields['supersede-reason']).toBe('旧值： 已被 "新数据" 推翻')

    const again = await zk.supersedeNote(m2, { path: r.archivePath, dryRun: false })
    expect(again.alreadySuperseded).toBe(true)
    expect(again.reason).toBe('旧值： 已被 "新数据" 推翻')
  })

  it('归档同名：能带出废弃原因（供 zk_new 提醒）', async () => {
    await notebookLib.ensureNotebook(m2)
    const oldNote = await note('同名旧结论甲', 'notes/concepts', '旧')
    const newNote = await note('同名新结论甲', 'notes/concepts', '新')
    await zk.supersedeNote(m2, { path: oldNote.path, by: newNote.path, reason: '数据源错了', dryRun: false })

    // 复用标题建新笔记：同一次全库扫描里就把归档那份的废弃原因带出来（不额外跑一次 zk）
    const reused = await zk.createNote(m2, { title: '同名旧结论甲', dir: 'notes/concepts', content: '又提一遍' })
    expect(reused.archived).toHaveLength(1)
    expect(reused.archived[0].path).toBe(`archive/${oldNote.path}`)
    expect(reused.archived[0].reason).toBe('数据源错了')
    expect((await zk.createNote(m2, { title: '没有这个标题', dir: 'notes/concepts', content: 'x' })).archived).toEqual([])
  })

  it('supersede 拒绝：替代者不存在 / 自己也是废弃的 / 目标不存在', async () => {
    const a = await note('待废弃甲', 'notes/concepts', '甲')
    const b = await note('待废弃乙', 'notes/concepts', '乙')
    await expect(zk.supersedeNote(m2, { path: a.path, by: '根本没有这篇' })).rejects.toThrow(/找不到替代笔记/)
    await expect(zk.supersedeNote(m2, { path: 'notes/concepts/不存在.md' })).rejects.toThrow(/笔记不存在/)
    await zk.supersedeNote(m2, { path: b.path, dryRun: false })
    await expect(zk.supersedeNote(m2, { path: a.path, by: `archive/${b.path}` })).rejects.toThrow(/归档/)
  })

  it('meta 文件不允许被 zk_supersede / zk_new / zk_link 触碰', async () => {
    await notebookLib.ensureNotebook(m2)
    const memoryPath = path.join(dir, 'MEMORY.md')
    fs.writeFileSync(memoryPath, '# 记忆\n\nMETA-GUARD\n')

    await expect(zk.supersedeNote(m2, { path: 'MEMORY.md', dryRun: false })).rejects.toThrow(/meta/)
    expect(fs.existsSync(memoryPath)).toBe(true)
    expect(fs.readFileSync(memoryPath, 'utf8')).toContain('META-GUARD')

    await expect(zk.createNote(m2, { title: '注入内容', name: 'MEMORY', dir: '.', content: 'x' })).rejects.toThrow(/meta/)
    expect(fs.readFileSync(memoryPath, 'utf8')).toContain('META-GUARD')

    const linked = await note('链接 meta 的笔记', 'notes/concepts', '正文')
    await expect(zk.linkNotes(m2, linked.path, 'MEMORY.md')).rejects.toThrow(/meta/)
    await expect(zk.linkNotes(m2, 'MEMORY.md', linked.path)).rejects.toThrow(/meta/)
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

describe('M7: 改名不断链', () => {
  const dir = path.join(home, 'nb-m7')
  const m7 = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
  const note = (title: string, dirName: string, body: string) => zk.createNote(m7, { title, dir: dirName, content: body })

  it('预演不改文件；执行后搬走文件，并把入链 / 别名 / 锚点 / Markdown 链接 / meta 一起改到位', async () => {
    await notebookLib.ensureNotebook(m7)
    const target = await note('改名目标', 'notes/concepts', '被引用的正文')
    const neighbor = await note('改名目标的邻居', 'notes/concepts', '邻居正文')
    const stem = path.basename(target.path, '.md')
    const neighborStem = path.basename(neighbor.path, '.md')

    // 它自己的链接：wiki 按文件名解析（换目录不受影响），Markdown 才是相对路径
    await zk.appendToNote(m7, target.path, `见 [[${neighborStem}]] 和 [邻居](../concepts/${neighborStem}.md)`)

    // 三种入链写法：根相对、带别名、带锚点；外加一条 Markdown 链接
    const rootSource = await note('根相对来源', 'notes/sources', `正文 [[${target.path.replace(/\.md$/, '')}]]`)
    const siblingSource = await note('同目录来源', 'notes/concepts', `正文 [[${stem}]]`)
    fs.appendFileSync(rootSource.absPath, `\n[[${target.path.replace(/\.md$/, '')}|别名]] [[${target.path.replace(/\.md$/, '')}#小节]]\n\n[x](../concepts/${stem}.md)\n`)
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), `## 记忆\n\n- 结论见 [[${target.path.replace(/\.md$/, '')}]]\n`)
    // 归档里的笔记也链向活笔记：不在 lint / 默认图里，但同样会断
    const oldSource = await note('归档里的来源', 'notes/concepts', `旧来源 [[${target.path.replace(/\.md$/, '')}]]`)
    await zk.supersedeNote(m7, { path: oldSource.path, dryRun: false })
    const archivedSourcePath = `archive/${oldSource.path}`

    const brokenBefore = (await zk.searchNotes(m7, { brokenLinks: true, limit: 50 })).length
    const newRel = 'notes/patterns/deep/改名之后.md'

    // ── 预演 ──
    const dry = await zk.renameNote(m7, { path: target.path, to: newRel })
    expect(dry.dryRun).toBe(true)
    expect(dry.performed).toBe(false)
    expect(dry.newPath).toBe(newRel)
    expect(dry.rewrittenLinks.map((r) => r.path).sort()).toEqual([rootSource.path, siblingSource.path, 'MEMORY.md', archivedSourcePath].sort())
    expect(dry.missingLinks).toEqual([])
    expect(dry.selfRewritten).toBe(1)
    expect(fs.existsSync(target.absPath)).toBe(true)
    expect(fs.existsSync(path.join(dir, newRel))).toBe(false)
    expect(fs.readFileSync(rootSource.absPath, 'utf8')).toContain(stem)

    // ── 执行 ──
    const done = await zk.renameNote(m7, { path: target.path, to: newRel, dryRun: false })
    expect(done.performed).toBe(true)
    expect(fs.existsSync(target.absPath)).toBe(false)
    expect(fs.readFileSync(path.join(dir, newRel), 'utf8')).toContain('被引用的正文')
    const newStem = newRel.replace(/\.md$/, '')

    const rootText = fs.readFileSync(rootSource.absPath, 'utf8')
    expect(rootText).toContain(`[[${newStem}]]`)
    expect(rootText).toContain(`[[${newStem}|别名]]`)
    expect(rootText).toContain(`[[${newStem}#小节]]`)
    expect(rootText).toContain('[x](../patterns/deep/改名之后.md)')
    expect(rootText).not.toContain(stem)

    // 只写文件名的 [[…]] 入链（zk 按全局文件名解析）：改名后要改成能解析的根路径写法
    expect(fs.readFileSync(siblingSource.absPath, 'utf8')).toContain('[[notes/patterns/deep/改名之后]]')
    // meta 文件不在 zk graph 里，也要跟着改
    expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toContain(`[[${newStem}]]`)
    expect(fs.readFileSync(path.join(dir, archivedSourcePath), 'utf8')).toContain(`[[${newStem}]]`)
    // 它自己正文：wiki 链接不动（按文件名解析），Markdown 相对链接按新目录重算
    const selfText = fs.readFileSync(path.join(dir, newRel), 'utf8')
    expect(selfText).toContain(`[[${neighborStem}]]`)
    expect(selfText).toContain(`[邻居](../../concepts/${neighborStem}.md)`)

    // 断链数不增加，新路径能被检索到
    expect((await zk.searchNotes(m7, { brokenLinks: true, limit: 50 })).length).toBe(brokenBefore)
    expect((await zk.searchNotes(m7, { paths: ['notes/patterns'], limit: 10 })).map((n) => n.path)).toContain(newRel)

    // 重放：原路径已经不存在
    await expect(zk.renameNote(m7, { path: target.path, to: 'notes/patterns/再来一次.md' })).rejects.toThrow(/笔记不存在/)
  })

  it('拒绝：目标占位 / 换成 meta / 日记 / raw / 归档 / 换格式', async () => {
    await notebookLib.ensureNotebook(m7)
    const a = await note('拒绝改名甲', 'notes/concepts', '甲')
    const b = await note('拒绝改名乙', 'notes/concepts', '乙')
    await expect(zk.renameNote(m7, { path: a.path, to: b.path })).rejects.toThrow(/占用/)
    await expect(zk.renameNote(m7, { path: a.path, to: 'MEMORY.md' })).rejects.toThrow(/meta/)
    await expect(zk.renameNote(m7, { path: a.path, to: 'notes/concepts/换成.txt' })).rejects.toThrow(/格式/)

    const daily = await zk.ensureDailyNote(m7)
    await expect(zk.renameNote(m7, { path: daily.path, to: 'journal/改名日记.md' })).rejects.toThrow(/日记/)

    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'raw', '素材.md'), '# 素材\n\n原文\n')
    await expect(zk.renameNote(m7, { path: 'raw/素材.md', to: 'notes/素材.md' })).rejects.toThrow(/只读/)

    const archived = await note('归档里的旧结论', 'notes/concepts', '旧')
    await zk.supersedeNote(m7, { path: archived.path, dryRun: false })
    await expect(zk.renameNote(m7, { path: `archive/${archived.path}`, to: 'notes/挪回来.md' })).rejects.toThrow(/归档/)
    // meta 文件本身也不许改名
    await expect(zk.renameNote(m7, { path: 'MEMORY.md', to: 'MEMO.md' })).rejects.toThrow(/meta/)
  })
})

describe('M3: 巡检与做梦', () => {
  const dir = path.join(home, 'nb-m3')
  const m3 = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
  const note = (title: string, dirName: string, body: string) =>
    zk.createNote(m3, { title, dir: dirName, content: body })

  it('lint：断链 / 孤儿 / 无标签 / 单向链接 / 陈旧 / 重名各自命中', async () => {
    await notebookLib.ensureNotebook(m3)
    const orphan = await note('孤岛概念', 'notes/concepts', '没人链我，我也没标签。')
    const cited = await note('被引用概念', 'notes/concepts', '有入链的正文 #cited')
    const source = await note('引用来源', 'notes/sources', '来源正文 #src')
    await zk.linkNotes(m3, source.path, cited.path)
    const broken = await note('断链概念', 'notes/concepts', '见 [[notes/nope]] #broken')
    const dupA = await note('同名标题', 'notes/concepts', '甲 #dup')
    const dupB = await note('同名标题', 'notes/patterns', '乙 #dup')
    const stale = await note('陈旧概念', 'notes/concepts', '很久没动 #stale')
    const dailyCited = await note('日记提过概念', 'notes/concepts', '只在日记里出现 #cited')
    const old = new Date(Date.now() - 120 * 86_400_000)
    fs.utimesSync(stale.absPath, old, old)
    const daily = await zk.ensureDailyNote(m3)
    // 日记 → 笔记是正常引用方向：被日记提过、但没回链日记，不该算「没接上」
    await zk.linkNotes(m3, daily.path, dailyCited.path)
    // 反过来（笔记 → 日记）也一样：日记不该被要求回链每篇被提到的笔记
    await zk.linkNotes(m3, cited.path, daily.path)
    await zk.indexNotebook(m3)

    const lint = await lintLib.lintNotebook(m3, { staleDays: 90 })
    expect(lint.notes).toBe(9)
    expect(lint.truncated).toBe(false)
    expect(lint.orphans.items.map((i) => i.path)).toContain(orphan.path)
    expect(lint.brokenLinks.items.map((i) => i.path)).toEqual([broken.path])
    expect(lint.tagless.items.map((i) => i.path)).toContain(orphan.path)
    // 笔记 → 笔记的单向链接照报；日记来源的不报（否则日记提过的每篇都常年挂在这里）
    expect(lint.oneWayLinks.items.map((i) => i.path)).toContain(cited.path)
    expect(lint.oneWayLinks.items.map((i) => i.path)).not.toContain(dailyCited.path)
    expect(lint.oneWayLinks.items.map((i) => i.path)).not.toContain(daily.path)
    // items 是目标 X，from 才是没回链的来源 S；zk_link 写进 ## Links，算 links 不算正文
    expect(lint.oneWayLinks.total).toBe(1)
    expect(lint.oneWayLinks.edges).toBe(1)
    expect(lint.oneWayLinks.bodyOnly).toBe(0)
    expect(lint.oneWayLinks.linksOnly).toBe(false)
    expect(lint.oneWayLinks.edgesTruncated).toBe(false)
    const citedItem = lint.oneWayLinks.items.find((i) => i.path === cited.path)
    expect(citedItem?.from).toEqual([source.path])
    expect(citedItem?.where).toBe('links')
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
    // 没启用记忆层的库：不报这一项（files = 0），别给老 vault 添噪音
    expect(lint.memoryLinks).toEqual({
      files: 0, links: 0, total: 0, unlinked: 0, undated: 0, retired: 0, retiredBroken: 0,
      stale: { total: 0, staleDays: 90, items: [] }, items: [],
    })
  })

  it('lint：单向链接带 from，并区分正文与 Links 小节', async () => {
    const oneWayDir = path.join(home, 'nb-oneway')
    const cfgOneWay = store.normalizeConfig({ notebook: oneWayDir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(cfgOneWay)
    const note2 = (title: string, dirName: string, body: string) =>
      zk.createNote(cfgOneWay, { title, dir: dirName, content: body })
    const stem = (p: string): string => path.basename(p, '.md')

    const bodyTarget = await note2('正文目标', 'notes/concepts', '被正文引用。')
    const linksTarget = await note2('链接目标', 'notes/concepts', '被 Links 引用。')
    const afterTarget = await note2('小节后的目标', 'notes/concepts', '被小节后的正文引用。')
    const bodySource = await note2('正文来源', 'notes/sources',
      `第一段中文，先垫一点字节。\n\n见 [[${stem(bodyTarget.path)}]]。`)
    const linksSource = await note2('链接来源', 'notes/sources',
      `## 链接\n\n- [[${stem(linksTarget.path)}]]\n\n## 其他\n\n再看 [[${stem(afterTarget.path)}]]。`)
    await zk.indexNotebook(cfgOneWay)

    const lint = await lintLib.lintNotebook(cfgOneWay)
    const byTarget = new Map(lint.oneWayLinks.items.map((i) => [i.path, i]))
    expect(byTarget.get(bodyTarget.path)?.where).toBe('body')
    expect(byTarget.get(bodyTarget.path)?.from).toEqual([bodySource.path])
    expect(byTarget.get(linksTarget.path)?.where).toBe('links')
    expect(byTarget.get(linksTarget.path)?.from).toEqual([linksSource.path])
    // 小节结束后的正文不算 Links
    expect(byTarget.get(afterTarget.path)?.where).toBe('body')
    expect(lint.oneWayLinks.total).toBe(3)
    expect(lint.oneWayLinks.edges).toBe(3)
    expect(lint.oneWayLinks.bodyOnly).toBe(2)
  })

  it('graphEdges：边数触到 --limit 时置 truncated（缺回链边会误报单向）', async () => {
    const trDir = path.join(home, 'nb-edges-trunc')
    const cfgTr = store.normalizeConfig({ notebook: trDir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(cfgTr)
    const a = await zk.createNote(cfgTr, { title: '边甲', dir: 'notes/concepts', content: '甲。' })
    const b = await zk.createNote(cfgTr, { title: '边乙', dir: 'notes/concepts', content: '乙。' })
    const c = await zk.createNote(cfgTr, { title: '边丙', dir: 'notes/sources', content: '丙。' })
    await zk.linkNotes(cfgTr, c.path, a.path)
    await zk.linkNotes(cfgTr, c.path, b.path)
    await zk.indexNotebook(cfgTr)

    const full = await zk.graphEdges(cfgTr)
    expect(full.edges.length).toBe(2)
    expect(full.truncated).toBe(false)
    // --limit 数的是笔记（1 来源 + 2 目标 = 3），不是边；limit=2 时只载入 2 篇、丢一条边
    const cut = await zk.graphEdges(cfgTr, undefined, { limit: 2 })
    expect(cut.edges.length).toBe(1)
    expect(cut.truncated).toBe(true)

    // 链接稀疏时不能靠「边里出现过的笔记数」：两端的笔记可能一篇都没载入 → 0 条边、0 个节点
    const sparseDir = path.join(home, 'nb-edges-sparse')
    const cfgSparse = store.normalizeConfig({ notebook: sparseDir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(cfgSparse)
    for (let i = 0; i < 5; i++)
      await zk.createNote(cfgSparse, { title: `孤篇${i}`, dir: 'notes/x', content: `没有链接 ${i}` })
    await zk.indexNotebook(cfgSparse)
    const sparseCut = await zk.graphEdges(cfgSparse, undefined, { limit: 3 })
    expect(sparseCut.edges.length).toBe(0)
    expect(sparseCut.truncated).toBe(true)
  })

  it('lint：links_only 只列 Links 小节，正文引用只计数', async () => {
    const linksOnlyDir = path.join(home, 'nb-links-only')
    const cfgLinksOnly = store.normalizeConfig({ notebook: linksOnlyDir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(cfgLinksOnly)
    const note3 = (title: string, dirName: string, body: string) =>
      zk.createNote(cfgLinksOnly, { title, dir: dirName, content: body })
    const stem = (p: string): string => path.basename(p, '.md')

    const bodyOnlyTarget = await note3('正文目标', 'notes/concepts', '正文。')
    const linksTarget = await note3('链接目标', 'notes/concepts', '链接。')
    const mixedTarget = await note3('混合目标', 'notes/concepts', '混合。')
    const bodySource = await note3('正文来源', 'notes/sources',
      `见 [[${stem(bodyOnlyTarget.path)}]] 和 [[${stem(mixedTarget.path)}]]。`)
    const linksSource = await note3('链接来源', 'notes/sources',
      `## Links\n\n- [[${stem(linksTarget.path)}]]\n- [[${stem(mixedTarget.path)}]]\n`)
    await zk.indexNotebook(cfgLinksOnly)

    const all = await lintLib.lintNotebook(cfgLinksOnly)
    expect(all.oneWayLinks.linksOnly).toBe(false)
    expect(all.oneWayLinks.total).toBe(3)
    expect(all.oneWayLinks.edges).toBe(4)
    expect(all.oneWayLinks.bodyOnly).toBe(2)
    expect(all.oneWayLinks.items.find((i) => i.path === bodyOnlyTarget.path)?.from).toEqual([bodySource.path])

    const only = await lintLib.lintNotebook(cfgLinksOnly, { linksOnly: true })
    expect(only.oneWayLinks.linksOnly).toBe(true)
    expect(only.oneWayLinks.total).toBe(2)
    expect(only.oneWayLinks.edges).toBe(2)
    expect(only.oneWayLinks.bodyOnly).toBe(2)
    const items = new Map(only.oneWayLinks.items.map((i) => [i.path, i]))
    expect(items.get(linksTarget.path)?.from).toEqual([linksSource.path])
    expect(items.get(mixedTarget.path)?.from).toEqual([linksSource.path])
    expect(items.get(mixedTarget.path)?.where).toBe('links')
    expect(items.has(bodyOnlyTarget.path)).toBe(false)
  })

  it('lint：frontmatter 写坏的那篇单列一类（zk 只写 stderr，它不在索引里）', async () => {
    const badDir = path.join(home, 'nb-broken')
    const bad = store.normalizeConfig({ notebook: badDir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(bad)
    fs.mkdirSync(path.join(badDir, 'notes', 'concepts'), { recursive: true })
    // YAML 里 # 不是 tag 前缀：未加引号时整块 frontmatter 解析失败，那篇被 zk 跳过
    fs.writeFileSync(path.join(badDir, 'notes', 'concepts', 'bad-tags.md'), '---\ntitle: 坏标签\ntags: [#你好世界]\n---\n正文 #你好世界\n')
    // 归档里的坏文件不进索引查询，报出来只会淹掉真问题
    fs.mkdirSync(path.join(badDir, 'archive'), { recursive: true })
    fs.writeFileSync(path.join(badDir, 'archive', 'old.md'), '---\ntitle: 旧\ntags: [#旧]\n---\n旧\n')

    const lint = await lintLib.lintNotebook(bad)
    expect(lint.notes).toBe(0) // 索引里一篇都没有：写坏的那篇被 zk 跳过了
    expect(lint.parseErrors.total).toBe(1)
    expect(lint.parseErrors.items[0].path).toBe('notes/concepts/bad-tags.md')
    expect(lint.parseErrors.items[0].reason).toContain('yaml')
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
    await notebookLib.ensureNotebook(m3)
    const candidate = await note('可晋升概念', 'notes/concepts', '有标签的正文 #keep')
    const source = await note('候选入链来源', 'notes/sources', '来源正文 #src')
    await zk.linkNotes(m3, source.path, candidate.path)
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
    const hit = dream.newNotes.find((n) => n.path === candidate.path)
    expect(hit?.lead).toContain('有标签的正文')
    expect(hit?.cited).toBe(1)
    expect(hit?.citedBy).toContain(source.path)
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

describe('M3.1: dream 读 MEMORY（已晋升 / 窗口 / 积压）', () => {
  const dir = path.join(home, 'nb-dream-promoted')
  const cfgP = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
  const note = (title: string, dirName: string, body: string) =>
    zk.createNote(cfgP, { title, dir: dirName, content: body })

  it('已晋升的不再进候选（链接 / 标题两条路径），窗口跟着 DREAMS.md', async () => {
    await notebookLib.ensureNotebook(cfgP)
    const byLink = await note('已链接的结论条目', 'notes/concepts', '正文 #keep')
    const byTitle = await note('记忆瓶颈在写入路径', 'notes/concepts', '正文 #keep')
    const shortTitle = await note('RAG', 'notes/concepts', '正文 #keep')
    const oldish = await note('漏做一次的概念', 'notes/concepts', '正文 #keep')

    fs.writeFileSync(path.join(dir, 'MEMORY.md'), [
      '# 记忆',
      '',
      `- 结论一：见 [[${byLink.path}]]`,
      '- 记忆瓶颈在写入路径 —— 这条只有文字，没有链接。',
      '- RAG 也是纯文字。',
      '',
    ].join('\n'))

    // 没有 DREAMS.md：窗口仍是 7 天（旧行为），但已经知道 MEMORY 里有什么
    const first = await dreamLib.dreamNotebook(cfgP)
    expect(first.windowDays).toBe(7)
    expect(first.counts.promoted).toBe(2)
    expect(first.alreadyPromoted.map((n) => n.path)).toEqual(expect.arrayContaining([byLink.path, byTitle.path]))
    expect(first.alreadyPromoted.find((n) => n.path === byLink.path)?.promotedBy).toBe('link')
    expect(first.alreadyPromoted.find((n) => n.path === byTitle.path)?.promotedBy).toBe('title')
    expect(first.alreadyPromoted.every((n) => n.promoted)).toBe(true)
    // 已晋升的从候选里移出；短标题（< 6 字）不做包含匹配，仍在候选里
    expect(first.newNotes.map((n) => n.path)).not.toContain(byLink.path)
    expect(first.newNotes.map((n) => n.path)).not.toContain(byTitle.path)
    expect(first.newNotes.map((n) => n.path)).toContain(shortTitle.path)

    // DREAMS.md 写 10 天前：默认窗口 = 10 天
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    const stamp = `${tenDaysAgo.getFullYear()}-${String(tenDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(tenDaysAgo.getDate()).padStart(2, '0')}`
    fs.writeFileSync(path.join(dir, 'DREAMS.md'), `# 梦\n\n上次做梦：${stamp}\n`)
    const tens = await dreamLib.dreamNotebook(cfgP)
    expect(tens.windowDays).toBe(10)
    // 显式 --days 仍然优先
    expect((await dreamLib.dreamNotebook(cfgP, { days: 3 })).windowDays).toBe(3)

    // 窗口外仍未晋升的进 backlog：漏做一次不会永久掉队
    const later = await dreamLib.dreamNotebook(cfgP, { days: 10, now: new Date(Date.now() + 40 * 86_400_000) })
    expect(later.counts.window).toBe(0)
    expect(later.counts.backlog).toBeGreaterThan(0)
    expect(later.backlog.map((n) => n.path)).toContain(oldish.path)
    expect(later.backlog.map((n) => n.path)).not.toContain(byLink.path)
  })
})

describe('记忆层体检', () => {
  const dir = path.join(home, 'nb-memlint')
  const memCfg = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
  const note = (title: string, dirName: string, body: string) =>
    zk.createNote(memCfg, { title, dir: dirName, content: body })

  it('MEMORY 链接：旧路径搬进 archive 报 superseded，显式 archive 引用不算', async () => {
    await notebookLib.ensureNotebook(memCfg)
    const live = await note('活着的结论', 'notes/concepts', '活 #ok')
    const old = await note('已废弃的结论', 'notes/concepts', '旧 #old')
    const next = await note('替代结论', 'notes/concepts', '新 #new')
    const done = await zk.supersedeNote(memCfg, { path: old.path, by: next.path, dryRun: false })

    fs.writeFileSync(path.join(dir, 'MEMORY.md'), [
      '# 记忆',
      '',
      `- 活：[[${live.path}]]`,
      `- 按标题：[[${live.title}]]`,
      `- 漂移：[[${old.path}]]`,
      `- 有意引用：[[${done.archivePath}]]`,
      '- 不存在的：[[notes/concepts/根本没有]]',
      '- 没附来源的一条',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(dir, 'USER.md'), '# 偏好\n\n- 说话短一点 [[notes/concepts/也没有]]\n- 别啰嗦\n')

    const lint = await lintLib.lintNotebook(memCfg)
    expect(lint.memoryLinks.files).toBe(2)
    expect(lint.memoryLinks.links).toBe(6)
    expect(lint.memoryLinks.total).toBe(3) // 旧路径漂移 + MEMORY 的不存在 + USER 的不存在
    expect(lint.memoryLinks.items.map((i) => i.link)).toContain(old.path)
    expect(lint.memoryLinks.items.map((i) => i.link)).toContain('notes/concepts/根本没有')
    expect(lint.memoryLinks.items.map((i) => i.link)).toContain('notes/concepts/也没有')
    expect(lint.memoryLinks.items.find((i) => i.link === old.path)?.reason).toBe('superseded')
    expect(lint.memoryLinks.items.find((i) => i.link === old.path)?.path).toBe(done.archivePath)
    expect(lint.memoryLinks.items.some((i) => i.link === live.path)).toBe(false)
    expect(lint.memoryLinks.items.some((i) => i.link === done.archivePath)).toBe(false)
    // 只数 MEMORY 里那条「没附来源」的列表项；USER 的偏好条目不计
    expect(lint.memoryLinks.unlinked).toBe(1)
  })

  it('空链接 [[   ]] 不算失效：解析器对空目标返回 missing，lint 不该照单全收', async () => {
    await notebookLib.ensureNotebook(memCfg)
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), [
      '# 记忆',
      '',
      '- 空目标：[[   ]]',
      '- 真的不存在：[[notes/concepts/也没有]]',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(dir, 'USER.md'), '# 偏好\n\n- 说话短一点\n')

    const lint = await lintLib.lintNotebook(memCfg)
    expect(lint.memoryLinks.items.some((i) => i.link === '')).toBe(false)
    expect(lint.memoryLinks.items.map((i) => i.link)).toEqual(['notes/concepts/也没有'])
    expect(lint.memoryLinks.total).toBe(1)
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

  it('layered 日记：记录写进 Events、Loose ends 保持原样', async () => {
    const layered = store.normalizeConfig({
      notebook: path.join(home, 'nb-daily-layered'),
      zkPath: zkBin,
      structure: 'layered',
    })
    await notebookLib.ensureNotebook(layered)
    const daily = await zk.ensureDailyNote(layered)
    fs.writeFileSync(daily.absPath, [
      '# 2026-10-31',
      '',
      '## Events',
      '',
      '### 08:00',
      '',
      '- 晨会',
      '',
      '## Observations',
      '',
      '## Loose ends',
      '',
      '- [ ] 补实验数据',
      '- 回邮件',
      '',
    ].join('\n'), 'utf8')

    zk.appendDaily(layered, daily.path, '摄入：读了一篇关于分层记忆的笔记。', new Date(2026, 9, 31, 9, 15))
    const content = fs.readFileSync(daily.absPath, 'utf8')
    // 条目在 Events 里、标题降一级，否则同级 `##` 会把 Events 截断
    expect(content).toContain('### 09:15')
    expect(content).not.toMatch(/^## 09:15$/m)
    const events = content.indexOf('## Events')
    const entry = content.indexOf('摄入：读了一篇')
    const observations = content.indexOf('## Observations')
    const loose = content.indexOf('## Loose ends')
    expect(events).toBeLessThan(entry)
    expect(entry).toBeLessThan(observations)
    expect(observations).toBeLessThan(loose)
    // 原有条目和 loose ends 都不被挪动
    expect(content).toContain('### 08:00')
    expect(content).toContain('- [ ] 补实验数据')
    expect(content).toContain('- 回邮件')
  })

  it('指定日期', async () => {
    const other = await zk.ensureDailyNote(cfg, { date: '2026-01-02' })
    expect(other.path).toBe('journal/2026-01-02.md')
  })

  it('type: daily 按 dailyDir 命中日记（不依赖 frontmatter）', async () => {
    const d = await zk.ensureDailyNote(cfg)
    const hits = await zk.searchNotes(cfg, { type: ['daily'], limit: 50 })
    expect(hits.map((n) => n.path)).toContain(d.path)
    expect(hits.every((n) => n.path.startsWith('journal/'))).toBe(true)
  })
})

describe('tools', () => {
  it('14 个工具，参数校验拒绝坏输入', () => {
    const defs = toolsFeature.buildTools()
    expect(defs.map((d) => d.name)).toEqual([
      'zk_search', 'zk_query', 'zk_read', 'zk_new', 'zk_daily', 'zk_append', 'zk_link',       'zk_supersede',
      'zk_rename',
      'zk_context', 'zk_lint', 'zk_dream', 'zk_stats', 'zk_use',
    ])
    const zkNew = defs.find((d) => d.name === 'zk_new')!
    expect(toolLib.validateArgs(zkNew.parameters, { body: 'x' }).some((i) => i.includes('title'))).toBe(true)
    expect(toolLib.validateArgs(defs[0].parameters, { limit: 'many' }).length).toBe(1)
    const query = defs.find((d) => d.name === 'zk_query')!
    expect(toolLib.validateArgs(query.parameters, { type: 'nonsense' }).length).toBe(1)
    const supersede = defs.find((d) => d.name === 'zk_supersede')!
    expect(toolLib.validateArgs(supersede.parameters, { by: 'x' }).some((i) => i.includes('path'))).toBe(true)
  })

  it('zk_dream 的 days 文案与行为一致：不传就按 DREAMS.md 算窗口，别写「默认 7」', () => {
    const dream = toolsFeature.buildTools().find((d) => d.name === 'zk_dream')!
    const props = dream.parameters.properties as Record<string, { description?: string }>
    expect(props.days?.description ?? '').toContain('DREAMS.md')
    expect(props.days?.description ?? '').not.toContain('默认 7')
    expect(dream.description).toContain('DREAMS.md')
  })

  it('zk_new：layered 不给 dir 就按 type 落位；不在 group 里的落点一律拒绝', async () => {
    const layeredDir = path.join(home, 'newdir-layered')
    store.writeConfig({
      notebooks: { default: { path: notebook, structure: 'flat' }, work: { path: layeredDir, structure: 'layered' } },
      active: 'work',
      notesDir: 'notes',
      dailyDir: 'journal',
      defaultTags: ['default'],
    })
    try {
      const newTool = toolsFeature.buildTools(() => layeredDir).find((d) => d.name === 'zk_new')!
      const made = await newTool.execute(
        { title: '按类型落位', type: 'source', body: '正文' },
        { signal: AbortSignal.timeout(30_000) },
      ) as Record<string, unknown>
      expect(String(made.path).startsWith('notes/sources/')).toBe(true)
      const raw = fs.readFileSync(path.join(layeredDir, String(made.path)), 'utf8')
      expect(raw).toContain('type: source')
      expect(raw).toContain('## Key claims')
      // 没有 dir 也没有 type：notes/ 根不属于任何 group，直接拒绝而不是静默建出无模板笔记
      await expect(newTool.execute(
        { title: '没有落点', body: '正文' },
        { signal: AbortSignal.timeout(30_000) },
      )).rejects.toThrow(/要给 dir/)
      // 显式给了 dir 也要在 group 里：agent 最容易顺手写 dir: 'notes'，放过去就又是无模板笔记
      await expect(newTool.execute(
        { title: '显式根目录', dir: 'notes', body: '正文' },
        { signal: AbortSignal.timeout(30_000) },
      )).rejects.toThrow(/不在任何 group/)
      await expect(newTool.execute(
        { title: '写错的目录', dir: 'notes/concept', type: 'concept', body: '正文' },
        { signal: AbortSignal.timeout(30_000) },
      )).rejects.toThrow(/不在任何 group/)
      // group 下的子目录照常放行（zk 按路径前缀归组）
      const nested = await newTool.execute(
        { title: '子目录落位', dir: 'notes/concepts/papers/', body: '正文' },
        { signal: AbortSignal.timeout(30_000) },
      ) as Record<string, unknown>
      expect(String(nested.path).startsWith('notes/concepts/papers/')).toBe(true)
      expect(fs.readFileSync(path.join(layeredDir, String(nested.path)), 'utf8')).toContain('## Summary')
    } finally {
      store.writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, active: 'default', zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
    }
  })

  it('zk_new 的输出能无损 JSON（没有 undefined 字段）', async () => {
    const newTool = toolsFeature.buildTools().find((d) => d.name === 'zk_new')!
    const plain = await newTool.execute(
      { title: '输出无告警', body: '正文' },
      { signal: AbortSignal.timeout(30_000) },
    ) as Record<string, unknown>
    // 没给 summary 就没有告警：这个键不能以 undefined 出现在输出里
    expect(Object.hasOwn(plain, 'summaryWarning')).toBe(false)
    expect(lossyPaths(plain)).toEqual([])

    const warned = await newTool.execute(
      { title: '输出有告警', summary: '参数摘要', body: '## Summary\n\n正文摘要' },
      { signal: AbortSignal.timeout(30_000) },
    ) as Record<string, unknown>
    expect(typeof warned.summaryWarning).toBe('string')
    expect(lossyPaths(warned)).toEqual([])
  })

  it('zk_use：不带参数只列；没有会话 id 时拒绝切换', async () => {
    const defs = toolsFeature.buildTools()
    const use = defs.find((d) => d.name === 'zk_use')!
    const listed = await use.execute({}, { signal: AbortSignal.timeout(10_000) }) as Record<string, unknown>
    expect(listed.changed).toBe(false)
    expect(String(listed.notebook)).toBe(store.config().active)
    expect(Array.isArray(listed.notebooks)).toBe(true)
    // 裸调用没有 agent.id：切不了会话，但要说清楚该用什么替代，而不是静默失败
    await expect(use.execute({ notebook: 'default' }, { signal: AbortSignal.timeout(10_000) }))
      .rejects.toThrow(/会话 id/)
    await expect(use.execute({ notebook: '没有这本' }, { signal: AbortSignal.timeout(10_000), agent: { id: 'sess-use' } }))
      .rejects.toThrow(/没有这个笔记本/)
  })

  it('zk_context：列出已配置笔记本（名字 / 路径 / 结构 / 当前）', async () => {
    const work = path.join(home, 'ctx-work')
    store.writeConfig({
      notebooks: { default: { path: notebook, structure: 'flat' }, work: { path: work, structure: 'layered' } },
      active: 'default',
    })
    try {
      const defs = toolsFeature.buildTools()
      const ctxTool = defs.find((d) => d.name === 'zk_context')!
      const value = await ctxTool.execute({}, { signal: AbortSignal.timeout(10_000) }) as {
        notebook: string
        notebooks: Array<{ name: string; path: string; structure: string; active: boolean }>
      }
      expect(value.notebook).toBe('default')
      expect(value.notebooks).toEqual([
        { name: 'default', path: notebook, structure: 'flat', active: true },
        { name: 'work', path: work, structure: 'layered', active: false },
      ])
      const blocks = ctxTool.output.render({}, value)
      expect(blocks[0].text).toContain(`笔记本「default」（flat）→ ${notebook}`)
      expect(blocks[0].text).toContain('另有：work（layered）')
    } finally {
      store.writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, active: 'default', zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: ['default'] })
    }
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

  it('zk_new：summary 落进 ## Summary；正文自己写了就告警不覆盖', async () => {
    const newTool = toolsFeature.buildTools().find((d) => d.name === 'zk_new')!
    const made = await newTool.execute(
      { title: '工具摘要', summary: '工具写的摘要', body: '正文' },
      { signal: AbortSignal.timeout(30_000) },
    ) as Record<string, unknown>
    expect(made.summaryApplied).toBe(true)
    const raw = fs.readFileSync(path.join(String(made.notebook), String(made.path)), 'utf8')
    expect(raw).toContain('## Summary\n\n工具写的摘要')

    const kept = await newTool.execute(
      { title: '工具摘要冲突', summary: '参数摘要', body: '## Summary\n\n正文摘要' },
      { signal: AbortSignal.timeout(30_000) },
    ) as Record<string, unknown>
    expect(kept.summaryApplied).toBe(false)
    expect(newTool.output.render({ summary: '参数摘要' }, kept)[0].text).toContain('summary 没写进去')
  })

  it('zk_new：归档同名会提醒并带出原因，但不拦', async () => {
    const defs = toolsFeature.buildTools()
    const registry = new Map(defs.map((d) => [d.name, d]))
    const call = async (name: string, args: unknown) => {
      const d = registry.get(name)
      if (!d) throw new Error('missing ' + name)
      return await d.execute(args, { signal: AbortSignal.timeout(30_000) }) as Record<string, unknown>
    }

    const old = await call('zk_new', { title: '工具归档同名旧' })
    const next = await call('zk_new', { title: '工具归档同名新' })
    const sup = await call('zk_supersede', { path: old.path, by: next.path, reason: '旧口径作废', dry_run: false })
    expect(sup.reason).toBe('旧口径作废')
    expect(registry.get('zk_supersede')!.output.render({}, sup)[0].text).toContain('已记录废弃原因：旧口径作废')

    const again = await call('zk_new', { title: '工具归档同名旧' })
    const archived = again.archived as Array<{ path: string; reason: string }>
    expect(archived).toHaveLength(1)
    expect(archived[0].reason).toBe('旧口径作废')
    expect(registry.get('zk_new')!.output.render({}, again)[0].text).toContain('归档里有同名旧结论')
  })
  it('zk_read 能读根目录 MEMORY.md（注入目录的回读路径真的可用）', async () => {
    fs.writeFileSync(path.join(notebook, 'MEMORY.md'), '# 记忆\n\nMEMORY-READ-TOKEN\n')
    const defs = toolsFeature.buildTools()
    const read = defs.find((d) => d.name === 'zk_read')!
    const value = await read.execute({ path: 'MEMORY.md' }, { signal: AbortSignal.timeout(30_000) }) as Record<string, unknown>
    expect(String(value.content)).toContain('MEMORY-READ-TOKEN')
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
    expect(body).toContain('WORKFLOW.md')
    // 截断从底部往前丢：模板必须说清新条目写在哪，否则 agent 继续往下追加，最新的结论先没
    expect(body).toContain('新条目写顶部')

    fs.writeFileSync(agentsFile, '# 我自己写的\n\n不覆盖我。\n')
    const again = await notebookLib.ensureNotebook(m4)
    expect(again.agentsWritten).toBe(false)
    expect(fs.readFileSync(agentsFile, 'utf8')).toBe('# 我自己写的\n\n不覆盖我。\n')
  })

  it('AGENTS 模板守预算：≤ 190 词（它不参与截断，多 10 词 MEMORY 就少 10 词）', () => {
    expect(memory.countWords(notebookLib.AGENTS_TEMPLATE)).toBeLessThanOrEqual(190)
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

  it('layered 初始化写 WORKFLOW.md：改前清单与三分类，已有内容不覆盖', async () => {
    const wf = path.join(m4dir, 'WORKFLOW.md')
    fs.rmSync(wf, { force: true })
    const first = await notebookLib.ensureNotebook(m4)
    expect(first.workflowWritten).toBe(true)
    const body = fs.readFileSync(wf, 'utf8')
    expect(body).toContain('temporal update')
    expect(body).toContain('context variant')
    expect(body).toContain('contradiction')
    expect(body).toContain('动笔前必须出清单')
    // 不注入省预算，但要和 meta 同口径排除出检索，也不能被 zk_append 当流水账追加
    expect(zk.excludedNames(m4)).toContain(wf)
    expect(() => zk.appendToNote(m4, 'WORKFLOW.md', '追加')).toThrow(/meta/)

    fs.writeFileSync(wf, '# 我自己的流程\n')
    const again = await notebookLib.ensureNotebook(m4)
    expect(again.workflowWritten).toBe(false)
    expect(fs.readFileSync(wf, 'utf8')).toBe('# 我自己的流程\n')
  })

  it('raw/ 只读：zk_new / zk_append / zk_link / zk_supersede 都拒绝', async () => {
    const rawDir = path.join(m4dir, 'raw')
    fs.mkdirSync(rawDir, { recursive: true })
    await expect(zk.createNote(m4, { title: '不该写进 raw', dir: 'raw', content: 'x' })).rejects.toThrow(/raw/)
    expect(fs.readdirSync(rawDir)).toEqual([])

    const paper = path.join(rawDir, 'paper.md')
    fs.writeFileSync(paper, '# 原文\n\n一段原文。\n')
    expect(() => zk.appendToNote(m4, 'raw/paper.md', '追加')).toThrow(/raw/)

    const note = await zk.createNote(m4, { title: '要链原文的笔记', dir: 'notes/concepts', content: '正文' })
    await expect(zk.linkNotes(m4, 'raw/paper.md', note.path)).rejects.toThrow(/raw/)
    await expect(zk.supersedeNote(m4, { path: 'raw/paper.md', dryRun: false })).rejects.toThrow(/raw/)
    // 一个字都没动
    expect(fs.readFileSync(paper, 'utf8')).toBe('# 原文\n\n一段原文。\n')
  })

  it('设置写入后立刻生效：structure / memoryBudgetWords', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    try {
      store.writeConfig({ structure: 'layered', memoryBudgetWords: 180 })
      const next = store.config()
      expect(next.structure).toBe('layered')
      expect(next.memoryBudgetWords).toBe(180)
      // archiveDir 的非空变更另有专门用例（M1：旧归档目录里有文件就拒绝改）
      expect(next.archiveDir).toBe('archive')
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

  it('supersede 之后索引当场刷新：并发的 zk_stats 读到同一份结果', async () => {
    // 索引脏的时候，多个 zk 进程会各扫各的：同一次统计里「归档」和「活跃」对不上。
    // supersede 自己补索引之后，并发的两次统计必须完全一致。
    const dir = path.join(home, 'nb-stats-race')
    const c = store.normalizeConfig({ notebook: dir, zkPath: zkBin, structure: 'layered' })
    await notebookLib.ensureNotebook(c)
    const target = await zk.createNote(c, { title: '并发统计的结论', dir: 'notes/concepts', content: '旧结论' })
    await zk.supersedeNote(c, { path: target.path, dryRun: false })

    const [a, b] = await Promise.all([zk.notebookStats(c), zk.notebookStats(c)])
    expect(a.archived).toBe(1)
    expect(b.archived).toBe(1)
    expect(a.notes).toBe(b.notes)
    expect(a.superseded).toBe(1)

    // 搬走之后旧路径不该再被索引出来（哪怕只有一瞬间的「既不算归档也不算活跃」）
    const all = await zk.allNotes(c, { includeArchived: true })
    expect(all.some((n) => n.path === target.path)).toBe(false)
    expect(all.some((n) => n.path.startsWith(`${c.archiveDir}/`))).toBe(true)
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

  it('install 拒绝非法版本号：不会拼出奇怪的 URL / 缓存路径', () => {
    const bad = run('install', '../evil')
    expect(bad.status).not.toBe(0)
    expect(bad.stderr ?? '').toContain('版本号不合法')
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

describe('cli: zk-kit new', () => {
  const cli = path.resolve(import.meta.dir, '..', 'src', 'cli.ts')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', timeout: 30_000 })

  it('layered 下按 --type 落位；dir 和 type 都没有、或 dir 不在 group 里就报错', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const dir = path.join(home, 'cli-layered')
    try {
      store.writeConfig({
        notebooks: { default: { path: dir, structure: 'layered' } },
        active: 'default',
        notesDir: 'notes',
        dailyDir: 'journal',
        defaultTags: [],
      })
      expect(run('init').status).toBe(0)
      const made = run('new', '--title', 'CLI 类型落位', '--type', 'source', '--body', '正文')
      expect(made.status).toBe(0)
      expect(made.stdout ?? '').toContain('notes/sources/')

      const bad = run('new', '--title', 'CLI 没有落点')
      expect(bad.status).not.toBe(0)
      expect(bad.stderr ?? '').toContain('要给 dir')

      const offGroup = run('new', '--title', 'CLI 显式根目录', '--dir', 'notes', '--body', '正文')
      expect(offGroup.status).not.toBe(0)
      expect(offGroup.stderr ?? '').toContain('不在任何 group')
      // 被拒的调用不留文件：notes/ 根上一个 .md 都不该有
      expect(fs.readdirSync(path.join(dir, 'notes')).filter((f) => f.endsWith('.md'))).toEqual([])

      const wrong = run('new', '--title', 'CLI 类型写错', '--type', 'nonsense')
      expect(wrong.status).not.toBe(0)
      expect(wrong.stderr ?? '').toContain('--type 只能是')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
    }
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
      expect((used.stdout ?? '')).toContain('默认笔记本 → work')
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

describe('install source', () => {
  // 装完要说清「刚才信任了谁」：换了镜像时不写出来，用户不知道二进制从哪来
  test('默认从 github.com 下，换了镜像就点名', () => {
    expect(installLib.sourceLabel(null)).toBe('github.com')
    expect(installLib.sourceLabel('https://ghproxy.example.com/https://github.com')).toContain('自定义镜像')
  })
})

interface FakeRes {
  statusCode: number
  headers: Record<string, string | number>
  body: string
  setHeader(name: string, value: string | number): void
  end(chunk?: unknown): void
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
  }
}

function makeReq(url: string, opts: { method?: string; host?: string; remote?: string } = {}): Record<string, unknown> {
  return {
    method: opts.method ?? 'GET',
    url,
    headers: { host: opts.host ?? '127.0.0.1:1234' },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
  }
}

describe('设置页', () => {
  test('group paths 解析失败时提示手动编辑，可修复时才建议 --fix', async () => {
    const globals = globalThis as Record<string, unknown>
    const previous = { window: globals.window, document: globals.document }
    const states: unknown[] = []
    let stateIndex = 0
    let Section: (() => unknown) | undefined
    const react = {
      createElement: (tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props, children }),
      useState: (init: unknown) => [states[stateIndex++] ?? init, () => {}],
      useCallback: (fn: unknown) => fn,
      useEffect: () => {},
    }
    globals.window = {
      __ModuleLoader__: {
        load(spec: { factory: (require: (name: string) => unknown) => { Section: () => unknown } }) {
          const exported = spec.factory((name) => {
            if (name === 'react') return react
            throw new Error(` unexpected require: ${name}`)
          })
          Section = exported.Section
        },
      },
    }
    globals.document = {
      getElementById: () => null,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    }

    try {
      await import('../src/features/settings/client.ts')
      expect(Section).toBeTruthy()
      const cfg = store.config()
      const render = (actualPaths: string[] | null): string => {
        const snap = {
          ok: true,
          config: cfg,
          zk: { found: true, version: '0.15.7', source: 'managed' },
          notebook: { path: cfg.notebook, exists: true },
          structure: {
            mode: 'flat', dirs: [], missing: [], extra: [], ready: true,
            agents: { path: '', required: false, present: true },
            groupsOk: false,
            groups: [{ name: 'daily', expectedPaths: ['journal'], actualPaths, pathsOk: false, present: true }],
            groupWarnings: ['group "daily" paths 解析不了'],
          },
          memory: null,
          counts: null,
          countsError: null,
        }
        states.splice(0, states.length, cfg, '', JSON.stringify(cfg), snap, '', '', '', '', '', '', '')
        stateIndex = 0
        return JSON.stringify(Section!())
      }

      const manual = render(null)
      expect(manual).toContain('手动编辑 .zk/config.toml')
      expect(manual).not.toContain('跑 zk-kit groups --fix')
      expect(render(['old'])).toContain('跑 zk-kit groups --fix')
    } finally {
      globals.window = previous.window
      globals.document = previous.document
    }
  })

  test('自检：其他 group 损坏或共用路径都不能整体通过', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const nb = path.join(home, 'settings-selftest-notebook')
    const routes = new Map<string, (req: never, res: never) => unknown>()
    settingsFeature.registerSettings({ route: (p, h) => routes.set(p, h), isTrusted: () => true })
    const call = async (): Promise<{ ok: boolean; items: Array<{ name: string; ok: boolean; detail: string }> }> => {
      const res = makeRes()
      await routes.get('/dsh-zdiary-kit/api/selftest')!(makeReq('/dsh-zdiary-kit/api/selftest') as never, res as never)
      return JSON.parse(res.body)
    }
    const groupItem = (result: { items: Array<{ name: string; ok: boolean }> }) =>
      result.items.find((item) => item.name.startsWith('日记 group'))!

    try {
      store.writeConfig({ notebooks: { default: { path: nb, structure: 'layered' } }, active: 'default', zkPath: zkBin })
      await notebookLib.ensureNotebook(store.config())
      expect((await call()).ok).toBe(true)

      const file = path.join(nb, '.zk', 'config.toml')
      const original = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, original.replace('paths = ["notes/concepts"]', 'paths = ["notes/wrong"]'))
      const broken = await call()
      expect(groupItem(broken).ok).toBe(false)
      expect(broken.ok).toBe(false)

      fs.writeFileSync(file, original.replace('paths = ["notes/concepts"]', 'paths = ["journal"]'))
      const overlap = await call()
      expect(groupItem(overlap).ok).toBe(false)
      expect(overlap.ok).toBe(false)
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(nb, { recursive: true, force: true })
    }
  })
})

describe('只读视图', () => {
  test('渲染层：文本转义、代码块里的标记不生效、危险链接不放行', () => {
    expect(readonlyHtml.esc('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;')
    const out = readonlyHtml.renderMarkdown('**粗体** 与 `**不是粗体**`\n\n<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))')
    expect(out).toContain('<strong>粗体</strong>')
    expect(out).toContain('<code>**不是粗体**</code>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('javascript:alert(1)')
    expect(out).toContain('坏链接')
    const link = readonlyHtml.renderMarkdown('[查询](https://example.test/?a=1&b=2)')
    expect(link).toContain('href="https://example.test/?a=1&amp;b=2"')
    expect(link).not.toContain('&amp;amp;')
    // 协议相对链接（//host、\\host）不是站内，不能渲染成 <a>
    expect(readonlyHtml.renderMarkdown('[外站](//evil.example/x)')).not.toContain('<a')
    expect(readonlyHtml.renderMarkdown('[外站](\\\\evil.example/x)')).not.toContain('<a')
    expect(readonlyHtml.renderMarkdown('## 小节\n\n# 正文 H1', { skipFirstH1: true })).toContain('<h1>正文 H1</h1>')
  })

  test('路由：GET 可看、写方法 405、非回环 403、JSON 不吐路径', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const nb = path.join(home, 'readonly-notebook')
    const routes = new Map<string, (req: never, res: never) => unknown>()
    readonlyFeature.registerReadOnly({ route: (p, h) => routes.set(p, h) })
    const call = async (pathname: string, req: Record<string, unknown>): Promise<FakeRes> => {
      const handler = routes.get(pathname)
      expect(handler).toBeTruthy()
      const res = makeRes()
      await handler!(req as never, res as never)
      return res
    }

    try {
      store.writeConfig({ notebooks: { default: { path: nb, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: [] })
      await notebookLib.ensureNotebook(store.config())
      const first = await zk.createNote(store.config(), { title: '只读样例一', content: '正文 <script>alert(1)</script> 与 **粗体**' })
      await zk.createNote(store.config(), { title: '只读样例二', content: '第二篇' })

      const view = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view'))
      expect(view.statusCode).toBe(200)
      expect(String(view.headers['content-type'])).toContain('text/html')
      expect(String(view.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
      expect(view.body).toContain('只读样例一')
      expect(view.body).not.toContain('<script>')

      const page = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=note&path=' + encodeURIComponent(first.path)))
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(page.body).toContain('<strong>粗体</strong>')

      const api = await call('/dsh-zdiary-kit/api/notes', makeReq('/dsh-zdiary-kit/api/notes?limit=5'))
      expect(api.statusCode).toBe(200)
      const payload = JSON.parse(api.body) as { ok: boolean; notes: Array<Record<string, unknown>> }
      expect(payload.ok).toBe(true)
      expect(payload.notes.length).toBeGreaterThanOrEqual(2)
      expect(payload.notes[0]?.absPath).toBeUndefined()
      expect(JSON.stringify(payload)).not.toContain(nb)

      const one = await call('/dsh-zdiary-kit/api/note', makeReq('/dsh-zdiary-kit/api/note?path=' + encodeURIComponent(first.path)))
      expect(one.statusCode).toBe(200)
      expect(JSON.parse(one.body).note.content).toContain('<script>alert(1)</script>')

      const traversal = await call('/dsh-zdiary-kit/api/note', makeReq('/dsh-zdiary-kit/api/note?path=' + encodeURIComponent('../../etc/passwd')))
      expect(traversal.statusCode).toBe(400)

      const internal = await call('/dsh-zdiary-kit/api/note', makeReq('/dsh-zdiary-kit/api/note?path=' + encodeURIComponent('.zk/config.toml')))
      expect(internal.statusCode).toBe(400)

      const post = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view', { method: 'POST' }))
      expect(post.statusCode).toBe(405)
      expect(String(post.headers.allow)).toContain('GET')

      const remote = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view', { host: 'evil.example:1234' }))
      expect(remote.statusCode).toBe(403)

      // Host 看起来是回环、但对端是远程：这才是 isLoopback 比设置页更严的那条主张
      const remotePeer = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view', { host: '127.0.0.1:1234', remote: '192.168.1.9' }))
      expect(remotePeer.statusCode).toBe(403)

      // 畸形 Host 不能让 new URL 在路由外抛错（那会变成兜底的 500 JSON）
      const badHost = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view', { host: '127.0.0.1:80,evil.example' }))
      expect(badHost.statusCode).toBe(400)

      const feed = await call('/dsh-zdiary-kit/feed.xml', makeReq('/dsh-zdiary-kit/feed.xml'))
      expect(feed.statusCode).toBe(200)
      expect(String(feed.headers['content-type'])).toContain('rss+xml')
      expect(feed.body).toContain('<rss version="2.0">')
      expect(feed.body).toContain('只读样例一')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(nb, { recursive: true, force: true })
    }
  })

  test('详情页反链 / 标签 / 搜索 / HEAD；没初始化时 503 而不是空 200', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const nb = path.join(home, 'readonly-notebook-2')
    const routes = new Map<string, (req: never, res: never) => unknown>()
    readonlyFeature.registerReadOnly({ route: (p, h) => routes.set(p, h) })
    const call = async (pathname: string, req: Record<string, unknown>): Promise<FakeRes> => {
      const handler = routes.get(pathname)
      expect(handler).toBeTruthy()
      const res = makeRes()
      await handler!(req as never, res as never)
      return res
    }

    try {
      store.writeConfig({ notebooks: { default: { path: nb, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: [] })
      await notebookLib.ensureNotebook(store.config())
      // 直接落盘 + index：这样 [[双链]] 和行内 #标签 都进了 zk 的索引（不走 zk new 的模板）
      fs.mkdirSync(path.join(nb, 'notes'), { recursive: true })
      fs.writeFileSync(path.join(nb, 'notes/target.md'), '# 反链目标\n\n被指向的一篇 #样板\n')
      fs.writeFileSync(path.join(nb, 'notes/source.md'), '# 反链来源\n\n指向 [[notes/target]]\n')
      fs.writeFileSync(path.join(nb, 'notes/material.txt'), '纯文本材料\n')
      await zk.indexNotebook(store.config())

      const target = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=note&path=notes%2Ftarget.md'))
      expect(target.statusCode).toBe(200)
      expect(target.body).toContain('<h2>反链</h2>')
      expect(target.body).toContain('反链来源')

      const source = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=note&path=notes%2Fsource.md'))
      expect(source.statusCode).toBe(200)
      expect(source.body).toContain('notes%2Ftarget.md')

      // txt / org 不在只读视图里：zk 不索引它们，放进来就是「能直连、搜不到」的假入口
      const txt = await call('/dsh-zdiary-kit/api/note', makeReq('/dsh-zdiary-kit/api/note?path=notes%2Fmaterial.txt'))
      expect(txt.statusCode).toBe(400)
      expect(JSON.parse(txt.body).error).toContain('.md')

      const tags = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=tags'))
      expect(tags.statusCode).toBe(200)
      expect(tags.body).toContain('样板')

      const tag = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=tag&tag=' + encodeURIComponent('样板')))
      expect(tag.statusCode).toBe(200)
      expect(tag.body).toContain('反链目标')

      const search = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?q=' + encodeURIComponent('反链目标')))
      expect(search.statusCode).toBe(200)
      expect(search.body).toContain('反链目标')

      const head = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view', { method: 'HEAD' }))
      expect(head.statusCode).toBe(200)
      expect(String(head.headers['content-security-policy'])).toContain("frame-ancestors 'none'")

      // 换到没初始化过的目录：页面给提示，机器接口给 503（不是 200 的空列表 / 空频道）
      store.writeConfig({ notebooks: { default: { path: path.join(home, 'readonly-empty'), structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: [] })
      const coldView = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view'))
      expect(coldView.statusCode).toBe(200)
      expect(coldView.body).toContain('笔记本还没初始化')
      const coldApi = await call('/dsh-zdiary-kit/api/notes', makeReq('/dsh-zdiary-kit/api/notes'))
      expect(coldApi.statusCode).toBe(503)
      expect(JSON.parse(coldApi.body).ok).toBe(false)
      const coldFeed = await call('/dsh-zdiary-kit/feed.xml', makeReq('/dsh-zdiary-kit/feed.xml'))
      expect(coldFeed.statusCode).toBe(503)
      expect(coldFeed.body).not.toContain('<rss')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(nb, { recursive: true, force: true })
      fs.rmSync(path.join(home, 'readonly-empty'), { recursive: true, force: true })
    }
  })
})

describe('0.8.x：记忆与笔记本加固（P1-3 / P1-5 / P1-6 / P1-7 / P2-13–P2-15）', () => {
  const fresh = (name: string, structure: 'flat' | 'layered' = 'flat') =>
    store.normalizeConfig({ notebook: path.join(home, name), zkPath: zkBin, structure })

  it('P1-3：MEMORY 条目的日期 / 退役 / 退役后失效都各自计数', async () => {
    const cfg = fresh('nb-p13')
    await notebookLib.ensureNotebook(cfg)
    const live = await zk.createNote(cfg, { title: '活结论', content: '正文 #x' })
    await zk.indexNotebook(cfg)
    fs.writeFileSync(path.join(cfg.notebook, 'MEMORY.md'), [
      '# 记忆',
      '',
      `- 活结论（2026-01-01）[[${live.path}]]`,
      '- 没日期也没来源的条目',
      '- [superseded 2026-02-01] 旧结论 → [[notes/已经不存在.md]]',
      '',
    ].join('\n'))

    const lint = await lintLib.lintNotebook(cfg)
    expect(lint.memoryLinks.files).toBe(1)
    expect(lint.memoryLinks.undated).toBe(1)
    expect(lint.memoryLinks.unlinked).toBe(1)
    expect(lint.memoryLinks.retired).toBe(1)
    expect(lint.memoryLinks.retiredBroken).toBe(1)
    // 退役行指向的目标也会在「失效链接」里报一次：两句话意思不同，不合并
    expect(lint.memoryLinks.total).toBe(1)
    expect(lintLib.formatMemoryLinks(lint.memoryLinks)).toContain('1 条已退役，其中 1 条的新结论不是活笔记')
  })

  it('P1-3 / P2-15：模板带版本标记，并写清日期与退役格式', () => {
    for (const body of [notebookLib.AGENTS_TEMPLATE, notebookLib.AGENTS_TEMPLATE_FLAT]) {
      expect(body.startsWith('<!-- zdiary-template: v')).toBe(true)
      expect(body).toContain('YYYY-MM-DD')
      expect(body).toContain('[superseded')
    }
    expect(notebookLib.WORKFLOW_TEMPLATE.startsWith('<!-- zdiary-template: v')).toBe(true)
  })

  it('P1-6：flat 默认不写 AGENTS；显式 withAgents 写精简版且不覆盖', async () => {
    const cfg = fresh('nb-p16')
    const first = await notebookLib.ensureNotebook(cfg)
    expect(first.agentsWritten).toBe(false)
    expect(fs.existsSync(path.join(cfg.notebook, 'AGENTS.md'))).toBe(false)

    const written = await notebookLib.ensureNotebook(cfg, undefined, { withAgents: true })
    expect(written.agentsWritten).toBe(true)
    const body = fs.readFileSync(path.join(cfg.notebook, 'AGENTS.md'), 'utf8')
    expect(body).toContain('<!-- zdiary-template')
    // flat 模板不许出现分层结构的路径与 WORKFLOW.md
    expect(body).not.toContain('notes/sources')
    expect(body).not.toContain('WORKFLOW.md')
    expect(memory.countWords(notebookLib.AGENTS_TEMPLATE_FLAT)).toBeLessThanOrEqual(90)

    fs.writeFileSync(path.join(cfg.notebook, 'AGENTS.md'), '# 我自己写的\n')
    const again = await notebookLib.ensureNotebook(cfg, undefined, { withAgents: true })
    expect(again.agentsWritten).toBe(false)
    expect(fs.readFileSync(path.join(cfg.notebook, 'AGENTS.md'), 'utf8')).toBe('# 我自己写的\n')
  })

  it('P1-7：flat 有分层目录时报 extra；archive 不算漂移；layered 不报', async () => {
    const dir = path.join(home, 'nb-p17')
    fs.mkdirSync(path.join(dir, 'notes/concepts'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true })
    const flat = store.normalizeConfig({ notebook: dir, structure: 'flat' })
    const st = notebookLib.structureStatus(flat)
    expect(st.ready).toBe(true)
    expect(st.extra).toEqual(['notes/concepts'])
    expect(st.extra).not.toContain('archive')

    // 只有 archive 的 flat 库（跑过一次 supersede）：不是漂移，不能误报
    const onlyArchive = path.join(home, 'nb-p17-archive')
    fs.mkdirSync(path.join(onlyArchive, 'archive'), { recursive: true })
    fs.mkdirSync(path.join(onlyArchive, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(onlyArchive, 'journal'), { recursive: true })
    expect(notebookLib.structureStatus(store.normalizeConfig({ notebook: onlyArchive, structure: 'flat' })).extra).toEqual([])

    // layered 的分层目录本来就在配置里，不算多余
    expect(notebookLib.structureStatus(store.normalizeConfig({ notebook: dir, structure: 'layered' })).extra).toEqual([])
  })

  it('P2-13：frontmatter 缺 type / status / authority 单列一桶，日记跳过；flat 不查', async () => {
    const cfg = fresh('nb-p213', 'layered')
    await notebookLib.ensureNotebook(cfg)
    fs.writeFileSync(path.join(cfg.notebook, 'notes/concepts/partial.md'), '---\ntype: concept\ntitle: 部分\n---\n\n正文 #x\n')
    fs.writeFileSync(path.join(cfg.notebook, 'notes/concepts/full.md'), '---\ntype: concept\ntitle: 完整\nstatus: active\nauthority: expert\n---\n\n正文 #y\n')
    await zk.ensureDailyNote(cfg)
    await zk.indexNotebook(cfg)

    const lint = await lintLib.lintNotebook(cfg)
    expect(lint.incomplete.total).toBe(1)
    expect(lint.incomplete.truncated).toBe(false)
    expect(lint.incomplete.items[0]?.path).toBe('notes/concepts/partial.md')
    expect(lint.incomplete.items[0]?.missing.sort()).toEqual(['authority', 'status'])
    expect(lint.incomplete.byField).toEqual({ type: 0, status: 1, authority: 1 })

    // flat 的笔记本来就不写这三个字段：整库标红没有信息量
    const flat = fresh('nb-p213-flat')
    await notebookLib.ensureNotebook(flat)
    await zk.createNote(flat, { title: 'flat 笔记', content: '正文 #z' })
    await zk.indexNotebook(flat)
    expect((await lintLib.lintNotebook(flat)).incomplete.total).toBe(0)
  })

  test('P2-14：大小写变体与单例；标签不足 30 个不报', () => {
    const rec = (tags: string[]) => ({ tags } as unknown as Parameters<typeof lintLib.tagHygiene>[0][number])
    const few = lintLib.tagHygiene([rec(['Agent']), rec(['agent'])])
    expect(few.reported).toBe(false)

    const many = [
      rec(['Agent']), rec(['Agent']), rec(['Agent']), rec(['agent']), rec(['agent']),
      ...Array.from({ length: 28 }, (_v, i) => rec([`tag-${i}`])),
    ]
    const tags = lintLib.tagHygiene(many)
    expect(tags.reported).toBe(true)
    expect(tags.total).toBe(30)
    expect(tags.caseVariants.total).toBe(1)
    expect(tags.caseVariants.items[0]?.variants).toEqual(['Agent', 'agent'])
    expect(tags.caseVariants.items[0]?.total).toBe(5)
    expect(tags.singletons.total).toBe(28)
  })

  it('P2-15：无标记 / 旧版本都算旧模板，当前版本不算；旧模板结果直接带新版全文', async () => {
    const cfg = fresh('nb-p215', 'layered')
    await notebookLib.ensureNotebook(cfg)
    // layered 初始化会写 AGENTS.md；先删掉，验证「没有文件」不是旧模板
    fs.rmSync(path.join(cfg.notebook, 'AGENTS.md'))
    expect(lintLib.templateStatus(cfg)).toEqual({ present: false, version: 0, current: 3, stale: false })

    fs.writeFileSync(path.join(cfg.notebook, 'AGENTS.md'), '# 手写规则\n')
    const old = lintLib.templateStatus(cfg)
    expect(old.present).toBe(true)
    expect(old.version).toBe(0)
    expect(old.stale).toBe(true)
    // 插件装进 DSH 后 docs 在包内、agent 读不到：新版全文必须跟着结果走，不能只给相对路径
    expect(old.currentText).toBe(notebookLib.AGENTS_TEMPLATE)
    const extras = lintLib.formatLintExtras({ ...(await lintLib.lintNotebook(cfg)) }).join('\n')
    expect(extras).toContain('新版模板全文')
    expect(extras).toContain('<!-- zdiary-template: v3 -->')
    expect(extras).not.toContain('docs/features/memory.md')

    fs.writeFileSync(path.join(cfg.notebook, 'AGENTS.md'), '<!-- zdiary-template: v99 -->\n\n# 未来版本\n')
    // 插件比库旧：仍然报（不然升过插件又降级的人永远看不见），但不能把当前版本的模板递过去
    // —— agent 会照着合并、把标记改成 v3，等于把规则回退
    const future = lintLib.templateStatus(cfg)
    expect(future.stale).toBe(true)
    expect(future.currentText).toBeUndefined()
    const futureExtras = lintLib.formatLintExtras({ ...(await lintLib.lintNotebook(cfg)) }).join('\n')
    expect(futureExtras).toContain('模板版本比插件新')
    expect(futureExtras).not.toContain('新版模板全文')
    expect(futureExtras).not.toContain('--- 新版模板开始 ---')

    fs.writeFileSync(path.join(cfg.notebook, 'AGENTS.md'), notebookLib.AGENTS_TEMPLATE)
    const now = lintLib.templateStatus(cfg)
    expect(now.version).toBe(now.current)
    expect(now.stale).toBe(false)
    expect(now.currentText).toBeUndefined()

    // flat 库拿 flat 模板：不能把 raw/ archive/ WORKFLOW.md 这些它没有的路径塞回去
    const flat = fresh('nb-p215-flat')
    await notebookLib.ensureNotebook(flat)
    fs.writeFileSync(path.join(flat.notebook, 'AGENTS.md'), '# 手写规则\n')
    const flatOld = lintLib.templateStatus(flat)
    expect(flatOld.currentText).toBe(notebookLib.AGENTS_TEMPLATE_FLAT)
    expect(flatOld.currentText).not.toContain('raw/')
  })

  it('P1-5：只读视图记忆页显示四份文件与预算；meta 仍不能按路径打开', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const nb = path.join(home, 'readonly-memory')
    const routes = new Map<string, (req: never, res: never) => unknown>()
    readonlyFeature.registerReadOnly({ route: (p, h) => routes.set(p, h) })
    const call = async (pathname: string, req: Record<string, unknown>): Promise<FakeRes> => {
      const handler = routes.get(pathname)
      expect(handler).toBeTruthy()
      const res = makeRes()
      await handler!(req as never, res as never)
      return res
    }

    try {
      store.writeConfig({ notebooks: { default: { path: nb, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: [] })
      await notebookLib.ensureNotebook(store.config())
      await zk.createNote(store.config(), { title: '记忆双链目标', content: '目标' })
      fs.writeFileSync(path.join(nb, 'MEMORY.md'), '# 记忆\n\n- 双链 [[记忆双链目标]]\n\n<script>alert(1)</script>\n')
      // 模板首行是 `<!-- zdiary-template: vN -->`：记忆页要按注释处理，不能当正文显示出来
      fs.writeFileSync(path.join(nb, 'AGENTS.md'), notebookLib.AGENTS_TEMPLATE)

      const page = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=memory'))
      expect(page.statusCode).toBe(200)
      // D9：记忆页分契约 / 用户 / 工作约定 / 记忆 / 周审 / 场景 + 载荷预览，不再只有四份文件名
      for (const name of ['契约', '用户', '工作约定', '记忆', '周审', '场景', '载荷预览']) expect(page.body).toContain(name)
      expect(page.body).toContain('PERSONA.md')
      expect(page.body).toContain('POLICY.md')
      expect(page.body).toContain('记忆双链目标</a>')
      expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(page.body).not.toContain('<script>')
      expect(page.body).toContain('还没写')
      expect(page.body).toContain('词（AGENTS')
      // 版本标记整行不渲染；模板正文照常显示（H1 由 skipFirstH1 让位给页面标题之外的小节）
      expect(page.body).toContain('zk_supersede')
      // 载荷预览里会原样出现（转义后）；页面正文不能把它当正文渲染成裸标记
      expect(page.body).not.toContain('<!-- zdiary-template')

      const meta = await call('/dsh-zdiary-kit/api/note', makeReq('/dsh-zdiary-kit/api/note?path=MEMORY.md'))
      expect(meta.statusCode).toBe(400)
      const metaPage = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=note&path=MEMORY.md'))
      expect(metaPage.statusCode).toBe(400)
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(nb, { recursive: true, force: true })
    }
  })

  it('P1-6：zk-kit init --with-agents 写模板，第二次不覆盖', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const dir = path.join(home, 'cli-with-agents')
    const cli = path.resolve(import.meta.dir, '..', 'src', 'cli.ts')
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', timeout: 30_000 })
    try {
      store.writeConfig({ notebooks: { default: { path: dir, structure: 'flat' } }, active: 'default', notesDir: 'notes', dailyDir: 'journal', defaultTags: [] })
      expect(run('init').status).toBe(0)
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false)

      const first = run('init', '--with-agents')
      expect(first.status).toBe(0)
      expect(first.stdout ?? '').toContain('AGENTS.md：已写入')
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(true)

      const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), body + '\n我加的一行\n')
      const second = run('init', '--with-agents')
      expect(second.stdout ?? '').toContain('AGENTS.md：已存在')
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('我加的一行')
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('0.8.2：检索 / inbox / 标签提示 / 相似标题 / 分布 / 使用信号（P2-7 – P2-12）', () => {
  const fresh = (name: string, structure: 'flat' | 'layered' = 'flat') =>
    store.normalizeConfig({ notebook: path.join(home, name), zkPath: zkBin, structure })

  it('P2-7：中文查询 FTS + 子串合并；纯 ASCII 仍是单策略', async () => {
    const cfg = fresh('nb-p27')
    await notebookLib.ensureNotebook(cfg)
    // 只有第一篇的「记忆系统」是独立词元（FTS 命中）；另两篇是更长的连续词元（FTS 漏）
    const exact = await zk.createNote(cfg, { title: '系统甲', content: '记忆系统 #m' })
    const longer1 = await zk.createNote(cfg, { title: '系统乙', content: '记忆系统很好 #m' })
    const longer2 = await zk.createNote(cfg, { title: '系统丙', content: '记忆系统实践 #m' })
    await zk.indexNotebook(cfg)

    const r = await zk.searchNotesDetailed(cfg, { query: '记忆系统', limit: 10 })
    expect(r.notes.map((n) => n.path).sort()).toEqual([exact.path, longer1.path, longer2.path].sort())
    expect(r.matchStrategy).toBe('mixed')

    // FTS 已占满 limit：正则补的那条会被 slice 掉，不能还报 mixed（否则界面谎称「补上了」）
    const full = await zk.searchNotesDetailed(cfg, { query: '记忆系统', limit: 1 })
    expect(full.notes.map((n) => n.path)).toEqual([exact.path])
    expect(full.matchStrategy).toBe('fts')

    const ascii = await zk.searchNotesDetailed(cfg, { query: 'xyzzynotfound', limit: 10 })
    expect(ascii.notes).toEqual([])
    expect(ascii.matchStrategy).toBe('regex')
  })

  it('P2-8：inbox 不再建、不接受写入；盘上已有的仍不进检索', async () => {
    const flat = fresh('nb-p28-flat')
    await notebookLib.ensureNotebook(flat)
    fs.mkdirSync(path.join(flat.notebook, 'inbox'), { recursive: true })
    await expect(zk.createNote(flat, { title: '不该进收件箱', dir: 'inbox', content: 'x' }))
      .rejects.toThrow(/inbox/)
    expect(fs.readdirSync(path.join(flat.notebook, 'inbox'))).toEqual([])

    const layered = fresh('nb-p28-layered', 'layered')
    await notebookLib.ensureNotebook(layered)
    expect(fs.existsSync(path.join(layered.notebook, 'inbox'))).toBe(false)
    // 老库盘上留着的 inbox/：不删，但仍是隔离区
    fs.mkdirSync(path.join(layered.notebook, 'inbox'), { recursive: true })
    fs.writeFileSync(path.join(layered.notebook, 'inbox', 'frag.md'), '# 碎片\n\nINBOX-TOKEN #x\n')
    await zk.indexNotebook(layered)
    expect((await zk.searchNotes(layered, { query: 'INBOX-TOKEN' })).length).toBe(0)
  })

  test('P2-9：中文没标签才提示，标签 / 正文 hashtag / 英文都不提示', () => {
    expect(zk.taglessCjkWarning('中文标题', '正文', [])).toContain('tags')
    expect(zk.taglessCjkWarning('中文标题', '正文', ['已有'])).toBeNull()
    expect(zk.taglessCjkWarning('中文标题', '正文 #已有', [])).toBeNull()
    expect(zk.taglessCjkWarning('English title', 'english body', [])).toBeNull()
  })

  it('P2-10：相似标题单独报；全等归 duplicateTitles；短标题不报', async () => {
    const cfg = fresh('nb-p210', 'layered')
    await notebookLib.ensureNotebook(cfg)
    const a = await zk.createNote(cfg, { title: '记忆系统的瓶颈在写路径', dir: 'notes/concepts', content: '正文 #x' })
    const b = await zk.createNote(cfg, { title: '记忆系统的瓶颈是写路径', dir: 'notes/concepts', content: '正文 #x' })
    await zk.createNote(cfg, { title: 'RAG', dir: 'notes/concepts', content: '正文 #x' })
    await zk.createNote(cfg, { title: 'RAG 2', dir: 'notes/concepts', content: '正文 #x' })
    await zk.indexNotebook(cfg)

    const lint = await lintLib.lintNotebook(cfg)
    expect(lint.duplicateTitles.total).toBe(0)
    expect(lint.similarTitles.total).toBe(1)
    expect(lint.similarTitles.items[0].paths.sort()).toEqual([a.path, b.path].sort())
    expect(lint.similarTitles.items[0].score).toBeGreaterThanOrEqual(0.6)
    expect(lintLib.formatLintExtras(lint).join('\n')).toContain('疑似重复标题')

    // 日记标题就是日期（0.86 的相似度）：不排除的话一年日记能吐出上千组误报
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) await zk.ensureDailyNote(cfg, { date: day })
    // 非日记目录里的纯数字标题（按日期 / 编号命名）同样不算疑似重复
    await zk.createNote(cfg, { title: '2026-10-01', dir: 'notes/concepts', content: '正文 #x' })
    await zk.createNote(cfg, { title: '2026-10-02', dir: 'notes/concepts', content: '正文 #x' })
    await zk.indexNotebook(cfg)

    const withDailies = await lintLib.lintNotebook(cfg)
    expect(withDailies.similarTitles.total).toBe(1)
    expect(withDailies.similarTitles.items[0].paths.sort()).toEqual([a.path, b.path].sort())
  })

  it('P2-11：stats 给目录 / 标签分布；非日记 150 篇且没有 INDEX.md 才提示', async () => {
    const cfg = fresh('nb-p211', 'flat')
    await notebookLib.ensureNotebook(cfg)
    await zk.createNote(cfg, { title: '甲', content: '正文 #one #two' })
    await zk.createNote(cfg, { title: '乙', content: '正文 #one' })
    await zk.ensureDailyNote(cfg)
    await zk.indexNotebook(cfg)

    const stats = await zk.notebookStats(cfg)
    expect(stats.byDir).toEqual([
      { dir: 'notes', count: 2 },
      { dir: 'journal', count: 1 },
    ])
    expect(stats.byTag[0]).toEqual({ tag: 'one', count: 2 })
    expect(stats.byTag.map((t) => t.tag)).toContain('two')

    const big = fresh('nb-p211-big')
    await notebookLib.ensureNotebook(big)
    const notesDir = path.join(big.notebook, big.notesDir)
    for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(notesDir, `bulk-${i}.md`), `# 批量 ${i}\n\n#t${i % 5}\n`)
    await zk.indexNotebook(big)
    expect((await lintLib.lintNotebook(big)).indexHint).toBe(true)
    fs.writeFileSync(path.join(big.notebook, 'INDEX.md'), '# 索引\n')
    expect((await lintLib.lintNotebook(big)).indexHint).toBe(false)

    // 日记按天自动增长：160 篇日记 + 2 篇真笔记不该冒出「该建总索引」
    const dailyHeavy = fresh('nb-p211-daily')
    await notebookLib.ensureNotebook(dailyHeavy)
    const journalDir = path.join(dailyHeavy.notebook, dailyHeavy.dailyDir)
    fs.mkdirSync(journalDir, { recursive: true })
    const day0 = Date.parse('2026-01-01')
    for (let i = 0; i < 160; i++) {
      const day = new Date(day0 + i * 86_400_000).toISOString().slice(0, 10)
      fs.writeFileSync(path.join(journalDir, `${day}.md`), `# ${day}\n\n内容 #d\n`)
    }
    await zk.createNote(dailyHeavy, { title: '真笔记甲', content: '正文 #x' })
    await zk.createNote(dailyHeavy, { title: '真笔记乙', content: '正文 #x' })
    await zk.indexNotebook(dailyHeavy)
    const dailyHeavyLint = await lintLib.lintNotebook(dailyHeavy)
    expect(dailyHeavyLint.notes).toBe(162)
    expect(dailyHeavyLint.indexHint).toBe(false)
  })

  it('P2-12：topCited 先按日记提及天数排，入链数只作次序', async () => {
    const cfg = fresh('nb-p212', 'layered')
    await notebookLib.ensureNotebook(cfg)
    const conceptCited = await zk.createNote(cfg, { title: '被概念反复引用', dir: 'notes/concepts', content: '正文 #x' })
    const dailyUsed = await zk.createNote(cfg, { title: '日记里反复用到', dir: 'notes/concepts', content: '正文 #x' })
    for (let i = 0; i < 3; i++) {
      const source = await zk.createNote(cfg, { title: `概念来源 ${i}`, dir: 'notes/sources', content: '正文 #x' })
      await zk.linkNotes(cfg, source.path, conceptCited.path)
    }
    for (const day of ['2026-10-01', '2026-10-05', '2026-10-09', '2026-10-20']) {
      const daily = await zk.ensureDailyNote(cfg, { date: day })
      await zk.linkNotes(cfg, daily.path, dailyUsed.path)
    }
    await zk.indexNotebook(cfg)

    const dream = await dreamLib.dreamNotebook(cfg, { days: 365 })
    const top = dream.topCited.map((x) => x.path)
    expect(top.indexOf(dailyUsed.path)).toBeLessThan(top.indexOf(conceptCited.path))
    const used = dream.topCited.find((x) => x.path === dailyUsed.path)
    expect(used?.cited).toBe(4)
    expect(used?.dailyMentions).toBe(4)
    expect(used?.daysMentioned).toBe(4)
    expect(used?.lastMentioned).toBe('2026-10-20')
    const concept = dream.topCited.find((x) => x.path === conceptCited.path)
    expect(concept?.dailyMentions).toBe(0)
    // 候选上也带同样的字段（视图一致）
    expect(dream.newNotes.find((n) => n.path === dailyUsed.path)?.daysMentioned).toBe(4)
  })
})

describe('0.10：角色契约与自主权（M1，契约壳与可观测）', () => {
  const fresh = (name: string, structure: 'flat' | 'layered' = 'flat') =>
    store.normalizeConfig({ notebook: path.join(home, name), zkPath: zkBin, structure })

  test('契约读取：无文件 = 未启用、payload 与 0.9 一致；有文件时契约段在最前', () => {
    const cfg = fresh('nb-m1-contract')
    fs.mkdirSync(cfg.notebook, { recursive: true })
    fs.writeFileSync(path.join(cfg.notebook, 'AGENTS.md'), '# 规则\n')
    fs.writeFileSync(path.join(cfg.notebook, 'MEMORY.md'), '# 记忆\n\n- 一条结论\n')
    const plain = memory.buildMemoryPayload(cfg)
    expect(plain.contract.present).toBe(false)
    expect(plain.contract.words).toBe(0)
    expect(plain.text).not.toContain('PERSONA.md')
    expect(plain.text).not.toContain('POLICY.md')
    expect(plain.totalWords).toBe(memory.countWords(plain.text))
    expect(plain.overheadWords).toBe(plain.totalWords - plain.words - plain.contract.words - plain.scene.words)

    fs.writeFileSync(path.join(cfg.notebook, 'PERSONA.md'), '<!-- zdiary-persona: v1 -->\n\n# 角色\n\n- name: 小z\n- role: 助手\n- updated: 2026-11-02\n')
    fs.writeFileSync(path.join(cfg.notebook, 'POLICY.md'), '<!-- zdiary-policy: v1 -->\n\n# 自主权\n\n| action | level |\n|---|---|\n| publish | ask |\n')
    const withContract = memory.buildMemoryPayload(cfg)
    expect(withContract.contract.present).toBe(true)
    expect(withContract.contract.files.filter((f) => f.present).length).toBe(2)
    const personaAt = withContract.text.indexOf('## PERSONA.md')
    const policyAt = withContract.text.indexOf('## POLICY.md')
    const agentsAt = withContract.text.indexOf('## AGENTS.md')
    expect(personaAt).toBeGreaterThan(-1)
    expect(personaAt).toBeLessThan(policyAt)
    expect(policyAt).toBeLessThan(agentsAt)
    // 契约不参与记忆预算：记忆段的 words 与无契约时一致
    expect(withContract.words).toBe(plain.words)
  })

  test('契约预算：超了只告警不截断；总 prompt 超限点名', () => {
    const cfg = fresh('nb-m1-budget')
    fs.mkdirSync(cfg.notebook, { recursive: true })
    const longPersona = '<!-- zdiary-persona: v1 -->\n\n# 角色契约\n\n- name: 小z\n\n' +
      Array.from({ length: 40 }, (_, i) => `- 一条非常长的角色设定条目编号${i}\n`).join('')
    fs.writeFileSync(path.join(cfg.notebook, 'PERSONA.md'), longPersona)
    fs.writeFileSync(path.join(cfg.notebook, 'AGENTS.md'), '# 规则\n')
    const c = store.normalizeConfig({ notebook: cfg.notebook, zkPath: zkBin, contractBudgetWords: 50 })
    const p = memory.buildMemoryPayload(c)
    expect(p.contract.present).toBe(true)
    expect(p.contract.overBudget).toBe(true)
    expect(p.text).toContain('契约不截断')
    // 文件没被截：契约词数还是全文（trim 后）
    expect(p.contract.files[0]?.words).toBe(memory.countWords(longPersona.trim()))
    expect(memory.countWords(p.text)).toBe(p.totalWords)

    const c2 = store.normalizeConfig({ notebook: cfg.notebook, zkPath: zkBin, contractBudgetWords: 800, totalPromptBudgetWords: 200 })
    const p2 = memory.buildMemoryPayload(c2)
    expect(p2.text).toContain('总 prompt 预算')
  })

  test('退役/截断分解：formatFileShares 不再把退役写成「原 X」', () => {
    const cfg = fresh('nb-m1-retired')
    fs.mkdirSync(cfg.notebook, { recursive: true })
    fs.writeFileSync(path.join(cfg.notebook, 'MEMORY.md'), [
      '# 记忆',
      '',
      '- 活条目一',
      '- [superseded 2026-01-01] 旧结论 → [[notes/x.md]]',
    ].join('\n'))
    const p = memory.buildMemoryPayload(cfg)
    expect(p.retiredWords).toBeGreaterThan(0)
    expect(p.truncatedWords).toBe(0)
    const share = memory.formatFileShares(p.files, p.tocWords)
    expect(share).toContain('退役')
    // 「原 X」只反映截断：没截断时不该有
    expect(share).not.toContain('（原')
    expect(p.files.find((f) => f.name === 'MEMORY.md')?.retiredWords).toBeGreaterThan(0)
  })

  test('写入守卫：PERSONA.md / POLICY.md 进 META_NAMES，zk_append 拒绝', () => {
    const cfg = fresh('nb-m1-guard')
    fs.mkdirSync(cfg.notebook, { recursive: true })
    expect(metaLib.META_NAMES).toContain('PERSONA.md')
    expect(metaLib.META_NAMES).toContain('POLICY.md')
    expect(metaLib.isMetaPath('PERSONA.md')).toBe(true)
    expect(metaLib.isMetaPath('notes/PERSONA.md')).toBe(false)
    fs.writeFileSync(path.join(cfg.notebook, 'PERSONA.md'), '# 人写的角色\n')
    expect(() => zk.appendToNote(cfg, 'PERSONA.md', 'agent 想追加')).toThrow(/meta 文件/)
    expect(fs.readFileSync(path.join(cfg.notebook, 'PERSONA.md'), 'utf8')).toBe('# 人写的角色\n')
  })

  test('lint：contract 桶报 missing / placeholder；旧版标记报 old', () => {
    const cfg = fresh('nb-m1-lint')
    fs.mkdirSync(cfg.notebook, { recursive: true })
    const missing = lintLib.contractStatus(cfg)
    expect(missing.total).toBe(2)
    expect(missing.items.map((i) => i.kind).sort()).toEqual(['missing', 'missing'])

    fs.writeFileSync(path.join(cfg.notebook, 'PERSONA.md'), personaTpl.PERSONA_TEMPLATE)
    fs.writeFileSync(path.join(cfg.notebook, 'POLICY.md'), '<!-- zdiary-policy: v0 -->\n\n# 旧契约\n')
    const st = lintLib.contractStatus(cfg)
    expect(st.items.map((i) => `${i.file}:${i.kind}`).sort()).toEqual([
      'PERSONA.md:placeholder',
      'POLICY.md:old',
    ])
    const empty = lintLib.formatLintExtras({
      incomplete: { total: 0, truncated: false, byField: { type: 0, status: 0, authority: 0 }, items: [] },
      tags: { total: 0, reported: false, caseVariants: { total: 0, items: [] }, singletons: { total: 0, items: [] } },
      template: { present: false, version: 0, current: 3, stale: false },
      contract: { total: 0, items: [] },
      similarTitles: { total: 0, truncated: false, items: [] },
      indexHint: false,
    })
    expect(empty).toEqual([])
    expect(lintLib.formatLintExtras({
      incomplete: { total: 0, truncated: false, byField: { type: 0, status: 0, authority: 0 }, items: [] },
      tags: { total: 0, reported: false, caseVariants: { total: 0, items: [] }, singletons: { total: 0, items: [] } },
      template: { present: false, version: 0, current: 3, stale: false },
      contract: st,
      similarTitles: { total: 0, truncated: false, items: [] },
      indexHint: false,
    }).some((line) => line.includes('契约'))).toBe(true)
  })

  test('config：契约 / 场景 / 总 prompt 预算默认值与夹紧', () => {
    const d = store.normalizeConfig({})
    expect(d.contractBudgetWords).toBe(240)
    expect(d.sceneBudgetWords).toBe(80)
    expect(d.totalPromptBudgetWords).toBe(900)
    const c = store.normalizeConfig({ contractBudgetWords: 99_999, sceneBudgetWords: 1, totalPromptBudgetWords: 10 })
    expect(c.contractBudgetWords).toBe(800)
    expect(c.sceneBudgetWords).toBe(20)
    expect(c.totalPromptBudgetWords).toBe(200)
  })

  it('ensureNotebook withContract：opt-in 写入一次，第二次不覆盖；flat 默认不写', async () => {
    const cfg = fresh('nb-m1-with-contract')
    const first = await notebookLib.ensureNotebook(cfg)
    expect(first.personaWritten).toBe(false)
    expect(first.policyWritten).toBe(false)
    expect(fs.existsSync(path.join(cfg.notebook, 'PERSONA.md'))).toBe(false)

    const withC = await notebookLib.ensureNotebook(cfg, undefined, { withContract: true })
    expect(withC.personaWritten).toBe(true)
    expect(withC.policyWritten).toBe(true)
    expect(fs.readFileSync(path.join(cfg.notebook, 'PERSONA.md'), 'utf8')).toContain('<!-- zdiary-persona: v1 -->')
    expect(fs.readFileSync(path.join(cfg.notebook, 'POLICY.md'), 'utf8')).toContain('<!-- zdiary-policy: v1 -->')
    expect(fs.readFileSync(path.join(cfg.notebook, 'POLICY.md'), 'utf8')).toContain('publish')

    fs.writeFileSync(path.join(cfg.notebook, 'PERSONA.md'), '# 我自己写的\n')
    const again = await notebookLib.ensureNotebook(cfg, undefined, { withContract: true })
    expect(again.personaWritten).toBe(false)
    expect(fs.readFileSync(path.join(cfg.notebook, 'PERSONA.md'), 'utf8')).toBe('# 我自己写的\n')
  })

  it('记忆页：退役行有徽标与删除线；PERSONA/POLICY 不能按路径打开；载荷预览同源', async () => {
    const paths = await import('../src/config/paths.ts')
    const before = fs.readFileSync(paths.CFG_FILE, 'utf8')
    const nb = path.join(home, 'readonly-m1')
    const routes = new Map<string, (req: never, res: never) => unknown>()
    readonlyFeature.registerReadOnly({ route: (p, h) => routes.set(p, h) })
    const call = async (pathname: string, req: Record<string, unknown>): Promise<FakeRes> => {
      const handler = routes.get(pathname)
      expect(handler).toBeTruthy()
      const res = makeRes()
      await handler!(req as never, res as never)
      return res
    }

    try {
      store.writeConfig({ notebooks: { default: { path: nb, structure: 'flat' } }, zkPath: zkBin, notesDir: 'notes', dailyDir: 'journal', defaultTags: [] })
      await notebookLib.ensureNotebook(store.config())
      fs.writeFileSync(path.join(nb, 'MEMORY.md'), [
        '# 记忆',
        '',
        '- 活条目',
        '- [superseded 2026-01-01] 旧结论 → [[notes/x.md]]',
      ].join('\n'))
      fs.writeFileSync(path.join(nb, 'PERSONA.md'), '# 人写的角色\n')

      const page = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=memory'))
      expect(page.statusCode).toBe(200)
      // 退役行：删除线 + 徽标，且不再和活条目一样渲染
      expect(page.body).toContain('class="retired"')
      expect(page.body).toContain('>retired</span>')
      expect(page.body).toContain('<s>')
      // 载荷预览与 payload 同源（转义后的 <system-reminder>）
      expect(page.body).toContain('载荷预览')
      expect(page.body).toContain('&lt;system-reminder&gt;')

      const persona = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=note&path=PERSONA.md'))
      expect(persona.statusCode).toBe(400)
      const policy = await call('/dsh-zdiary-kit/view', makeReq('/dsh-zdiary-kit/view?p=note&path=POLICY.md'))
      expect(policy.statusCode).toBe(400)
    } finally {
      fs.writeFileSync(paths.CFG_FILE, before)
      fs.rmSync(nb, { recursive: true, force: true })
    }
  })
})
