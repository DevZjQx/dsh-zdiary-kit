/**
 * 状态层单测：规则 DSL / 事件日志 / 投影。
 *
 * 这三块都是纯函数（不碰宿主、不跑 zk），所以不需要集成环境 —— 但 `bun run test` 会先找 zk，
 * 找不到就整批报红（见 scripts/test.ts）。这里只依赖临时目录。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../src/config/store.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-state-'))
process.env.DSH_HOME = root
process.env.DSH_WORKSPACE = root

const store = await import('../src/config/store.ts')
const log = await import('../src/lib/state-log.ts')
const rules = await import('../src/lib/state-rules.ts')
const scene = await import('../src/lib/scene.ts')

const notebook = path.join(root, 'notebook')
fs.mkdirSync(notebook, { recursive: true })
const cfg: Config = store.normalizeConfig({
  notebooks: { default: { path: notebook, structure: 'flat' } },
  sceneWindowDays: 30,
  staleHours: 72,
  sceneBudgetWords: 80,
}, root)
const NOW = Date.parse('2026-11-10T12:00:00Z')
const at = (days: number, hours = 0): string => new Date(NOW - days * 86_400_000 - hours * 3_600_000).toISOString()
const withNotebook = (name: string): Config =>
  store.normalizeConfig({ notebooks: { default: { path: path.join(root, name), structure: 'flat' } } }, root)

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('规则 DSL', () => {
  test('默认规则能编译，且 curve 单调下降；超过 staleHours 归 null', () => {
    const compiled = rules.compileDefaultRules()
    expect(compiled.version).toBe(4)
    expect(compiled.vars).toContain('energy')
    const run = (hours: number) => compiled.evaluate({
      now: NOW,
      lastSeen: new Map([['woke', { atMs: NOW - hours * 3_600_000, params: { hours: '7' } }]]),
      events: [],
      sceneWindowDays: 30,
      staleHours: 72,
    })
    expect(run(0).energy).toBe(70)
    expect(run(10).energy).toBe(20)
    expect(run(16).energy).toBe(0)
    expect(run(24).energy).toBe(0)
    // 超过 72 小时不看旧 woke：null 交给渲染层说「未知」，不拿旧值当现在
    expect(run(73).energy).toBeNull()
    expect(run(40 * 24).energy).toBeNull()
  })

  test('睡 9 小时起点更高；地板 0 让「力竭」够得着', () => {
    const compiled = rules.compileDefaultRules()
    const run = (hours: number, sleep: string) => compiled.evaluate({
      now: NOW,
      lastSeen: new Map([['woke', { atMs: NOW - hours * 3_600_000, params: { hours: sleep } }]]),
      events: [],
      sceneWindowDays: 30,
      staleHours: 72,
    })
    expect(run(0, '9').energy).toBe(78)
    expect(run(10, '7').mood).toBe('疲惫')
    // 16 小时没睡：70 - 80 → 地板 0，mood 的「力竭」分支可达
    expect(run(16, '7').energy).toBe(0)
    expect(run(16, '7').mood).toBe('力竭')
  })

  test('satiety 是饱腹度；没记录 / 太旧都是 null', () => {
    const compiled = rules.compileDefaultRules()
    const evaluate = (ateHours: number | null) => compiled.evaluate({
      now: NOW,
      lastSeen: new Map(ateHours === null ? [] : [['ate', { atMs: NOW - ateHours * 3_600_000, params: {} }]]),
      events: [],
      sceneWindowDays: 30,
      staleHours: 72,
    })
    expect(evaluate(1).satiety).toBe(96) // 刚吃完 = 高饱腹
    expect(evaluate(5).satiety).toBe(80)
    expect(evaluate(null).satiety).toBeNull() // 没记录 ≠ 半饱
    expect(evaluate(40 * 24).satiety).toBeNull() // 过期不拿旧值
  })

  test('赋值与 == 能正确切分；单个 = 只认第一个', () => {
    const compiled = rules.compileRules('version = 1\nate = 0\nenergy = if(ate == 0, 70, 1)\n')
    expect(compiled).not.toBeNull()
    const values = compiled!.evaluate({ now: NOW, lastSeen: new Map(), events: [], sceneWindowDays: 30, staleHours: 72 })
    expect(values.energy).toBe(70)
    expect(() => rules.compileRules('version = 1\na = 1 = 2\n')).toThrow()
  })

  test('未定义变量 / 裸中文 / 字符串进算术 = 整份拒绝', () => {
    expect(() => rules.compileRules('version = 1\nenergy = enery + 1\n')).toThrow()
    expect(() => rules.compileRules('version = 1\nmood = 力竭\n')).toThrow()
    expect(() => rules.compileRules('version = 1\nx = "a" + 1\n')).toThrow()
    expect(() => rules.compileRules('version = 1\nx = 1\ny = x > 0\n')).toThrow() // 布尔不能存进变量
  })

  test('clamp 下限大于上限 = 加载失败；count 越界 = 求值失败', () => {
    expect(() => rules.compileRules('version = 1\nx = clamp(1, 10, 0)\n')).toThrow()
    const compiled = rules.compileRules('version = 1\nn = count(ate, 90)\n')!
    expect(() => compiled.evaluate({ now: NOW, lastSeen: new Map(), events: [], sceneWindowDays: 30, staleHours: 72 })).toThrow()
  })

  test('缺 version / 变量重复 = 加载失败；空文本 = 没有规则', () => {
    expect(() => rules.compileRules('x = 1\n')).toThrow()
    expect(() => rules.compileRules('version = 1\nx = 1\nx = 2\n')).toThrow()
    expect(rules.compileRules('# 只有注释\n\n')).toBeNull()
  })

  test('last 缺 key 返回 null（不往前找）', () => {
    const compiled = rules.compileRules('version = 1\np = last(at, place)\n')!
    const values = compiled.evaluate({
      now: NOW,
      lastSeen: new Map([['at', { atMs: NOW, params: { other: 'x' } }]]),
      events: [],
      sceneWindowDays: 30,
      staleHours: 72,
    })
    expect(values.p).toBeNull()
  })
})

describe('事件日志', () => {
  test('append 写表头，参数带引号/裸词都能读回', () => {
    const c = withNotebook('log-1')
    log.appendEvent(c, { name: 'woke', params: { hours: '7.5' }, at: at(1) }, NOW)
    log.appendEvent(c, { name: 'set_goal', params: { text: '写完 D7' }, at: at(0, 1) }, NOW)
    const text = fs.readFileSync(log.eventsPathOf(c), 'utf8')
    expect(text.split('\n')[0]).toBe('# zdiary-state v1')
    const read = log.readStateLog(c, { now: NOW })
    expect(read.total).toBe(2)
    expect(read.lastSeen.get('set_goal')?.params.text).toBe('写完 D7')
  })

  test('坏行跳过并计数，不让整段投影失败', () => {
    const c = withNotebook('log-2')
    fs.mkdirSync(log.stateDirOf(c), { recursive: true })
    fs.writeFileSync(log.eventsPathOf(c), [
      '# zdiary-state v1',
      '2026-11-01T09:00:00Z ate amount=1',
      '2026-11-01 09:00:00 ate',
      '2026-11-01T09:00:00Z ate amount=',
      '2026-11-01T09:00:00Z 吃',
    ].join('\n') + '\n')
    const read = log.readStateLog(c, { now: NOW })
    expect(read.total).toBe(1)
    expect(read.badLines.length).toBe(3)
  })

  test('未来时间拒绝；没有时区拒绝；换行 / 控制字符拒绝；超过 512 字节拒绝', () => {
    const c = withNotebook('log-3')
    expect(() => log.appendEvent(c, { name: 'ate', at: new Date(NOW + 10 * 60_000).toISOString() }, NOW)).toThrow()
    expect(() => log.appendEvent(c, { name: 'ate', at: '2026-11-10 12:00:00' }, NOW)).toThrow()
    // 换行会把一条事件拆成两行坏行：写入口直接拒，不让它落盘
    expect(() => log.appendEvent(c, { name: 'set_goal', params: { text: '第一行\n第二行' } }, NOW)).toThrow()
    expect(() => log.appendEvent(c, { name: 'set_goal', params: { text: '回车\r' } }, NOW)).toThrow()
    expect(() => log.appendEvent(c, { name: 'ate', params: { note: 'x'.repeat(600) } }, NOW)).toThrow()
    expect(fs.existsSync(log.eventsPathOf(c))).toBe(false)
  })

  test('重放：now 之后的事件不参与 events / lastSeen / 投影', () => {
    const c = withNotebook('log-6')
    log.appendEvent(c, { name: 'woke', params: { hours: '7' }, at: at(1) }, NOW)
    log.appendEvent(c, { name: 'user_left', at: at(1, 0.5) }, NOW)
    const before = log.readStateLog(c, { windowDays: 30, now: NOW - 2 * 86_400_000 })
    expect(before.total).toBe(2) // 文件本身没变
    expect(before.events.length).toBe(0)
    expect(before.lastSeen.size).toBe(0)
    const projected = scene.buildScene(c, { now: NOW - 2 * 86_400_000 })
    expect(projected.present).toBe(false)
    expect(projected.emptyReason).toBe('no-log')
    // 正常时点看得到，且没有负的小时数
    const today = scene.buildScene(c, { now: NOW })
    expect(today.present).toBe(true)
    expect(today.values.awake).toBeGreaterThan(0)
  })

  test('prune 保留窗口内事件 + 每个事件名的 tombstone；hoursSince 仍是真实小时数', () => {
    const c = withNotebook('log-4')
    log.appendEvent(c, { name: 'woke', params: { hours: '7' }, at: at(100) }, NOW)
    log.appendEvent(c, { name: 'woke', params: {}, at: at(90) }, NOW)
    log.appendEvent(c, { name: 'ate', params: {}, at: at(1) }, NOW)
    const before = log.readStateLog(c, { windowDays: 30, now: NOW })
    expect(before.total).toBe(3)
    expect(before.events.length).toBe(1)
    const result = log.pruneStateLog(c, { days: 30, windowDays: 30, now: NOW })
    expect(result.dropped).toBe(1) // 两条窗口外 woke 只留最后一条
    expect(result.kept).toBe(2)
    const after = log.readStateLog(c, { windowDays: 30, now: NOW })
    expect(after.total).toBe(2)
    expect(after.events.length).toBe(1)
    const woke = after.lastSeen.get('woke')!
    expect(Math.round((NOW - woke.atMs) / 3_600_000)).toBe(90 * 24)
  })

  test('prune 保留人的注释行（跟着后面那条事件），坏行计进 dropped', () => {
    const c = withNotebook('log-7')
    fs.mkdirSync(log.stateDirOf(c), { recursive: true })
    fs.writeFileSync(log.eventsPathOf(c), [
      '# zdiary-state v1',
      '# 2026-10 那周在搬家',
      `${at(120)} woke hours=7`,
      '# zdiary-state 的坑：换行会把一条事件拆成两行',
      `${at(100)} woke hours=6`,
      `${at(1)} ate`,
      '2026-11-10T09:00:00Z ate amount=',
      '# 文件末尾的备注',
    ].join('\n') + '\n')
    const result = log.pruneStateLog(c, { days: 30, windowDays: 30, now: NOW })
    expect(result.dropped).toBe(2) // 1 条窗口外（同名只留最新一条）+ 1 条坏行
    expect(result.kept).toBe(2)
    const lines = fs.readFileSync(log.eventsPathOf(c), 'utf8').trimEnd().split('\n')
    expect(lines[0]).toBe('# zdiary-state v1') // 表头永远只有规范的那一行
    // 被压实掉的事件带的注释顺延到下一条保留的事件，不跟着静默消失
    expect(lines[1]).toBe('# 2026-10 那周在搬家')
    expect(lines[2]).toBe('# zdiary-state 的坑：换行会把一条事件拆成两行')
    expect(lines[3]).toContain('woke hours=6')
    expect(lines[4]).toContain(' ate')
    expect(lines[5]).toBe('# 文件末尾的备注') // 末尾挂不上事件的注释也不行丢
  })

  test('prune 截止天数小于窗口默认拒绝，force 才放行', () => {
    const c = withNotebook('log-5')
    expect(() => log.pruneStateLog(c, { days: 7, windowDays: 30, now: NOW })).toThrow()
    expect(() => log.pruneStateLog(c, { days: 7, windowDays: 30, force: true, now: NOW })).not.toThrow()
  })
})

describe('场景投影', () => {
  test('空日志 / 零条有效事件 = 不注入', () => {
    const c = withNotebook('scene-1')
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(false)
    expect(projected.text).toBe('')
    expect(projected.words).toBe(0)
    expect(projected.emptyReason).toBe('no-log')
  })

  test('只有窗口外事件时仍注入长尾（不是「不注入」）', () => {
    const c = withNotebook('scene-2')
    log.appendEvent(c, { name: 'woke', params: { hours: '7' }, at: at(40) }, NOW)
    log.appendEvent(c, { name: 'at', params: { place: '书房' }, at: at(40) }, NOW)
    log.appendEvent(c, { name: 'user_left', params: {}, at: at(40) }, NOW)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(true)
    expect(projected.events).toBe(0)
    // 过期值不装：energy / 地点都是「未知」，长尾靠「最后 X · N 天前」
    expect(projected.text).not.toContain('energy')
    expect(projected.text).toContain('最近醒来 40 天前')
    expect(projected.text).toContain('地点未知')
    expect(projected.text).toContain('书房')
    expect(projected.text).toContain('用户状态未知')
    expect(projected.presence).toBe('unknown')
  })

  test('只记身体事件时在场是「未知」，不是「在场」', () => {
    const c = withNotebook('scene-3')
    log.appendEvent(c, { name: 'ate', params: {}, at: at(0, 1) }, NOW)
    expect(scene.buildScene(c, { now: NOW }).presence).toBe('unknown')
    log.appendEvent(c, { name: 'user_left', params: {}, at: at(0, 1) }, NOW)
    expect(scene.buildScene(c, { now: NOW }).presence).toBe('absent')
  })

  test('规则编译失败整份回退默认，且带上第一条错误', () => {
    const c = withNotebook('scene-4')
    fs.mkdirSync(log.stateDirOf(c), { recursive: true })
    fs.writeFileSync(log.rulesPathOf(c), 'version = 1\nenergy = clamp(1, 10, 0)\n')
    log.appendEvent(c, { name: 'ate', params: {}, at: at(0, 1) }, NOW)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.rulesVersion).toBe('default(fallback)')
    expect(projected.rulesError).toContain('clamp')
    expect(projected.present).toBe(true)
  })

  test('规则求值失败也回退默认，而不是让场景消失', () => {
    const c = withNotebook('scene-6')
    fs.mkdirSync(log.stateDirOf(c), { recursive: true })
    fs.writeFileSync(log.rulesPathOf(c), 'version = 1\nenergy = 1 / 0\n')
    log.appendEvent(c, { name: 'ate', params: {}, at: at(0, 1) }, NOW)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(true) // 默认规则算得出 satiety
    expect(projected.text).toContain('satiety')
    expect(projected.rulesVersion).toBe('default(fallback)')
    expect(projected.rulesError).toContain('除以零')
  })

  test('预算裁剪：先丢地点 / 目标，留 energy / mood', () => {
    const c = withNotebook('scene-5')
    log.appendEvent(c, { name: 'woke', params: { hours: '7' }, at: at(0, 1) }, NOW)
    log.appendEvent(c, { name: 'ate', params: {}, at: at(0, 2) }, NOW)
    log.appendEvent(c, { name: 'at', params: { place: '书房' }, at: at(0, 3) }, NOW)
    log.appendEvent(c, { name: 'set_goal', params: { text: '写完 D7' }, at: at(0, 4) }, NOW)
    const logData = log.readStateLog(c, { windowDays: 30, now: NOW })
    const compiled = rules.compileDefaultRules()
    const full = scene.projectScene(logData, compiled, NOW, { staleHours: 72, sceneWindowDays: 30, budgetWords: 200 })
    const tight = scene.projectScene(logData, compiled, NOW, { staleHours: 72, sceneWindowDays: 30, budgetWords: 8 })
    expect(full.text).toContain('地点')
    expect(tight.words).toBeLessThanOrEqual(8)
    expect(tight.text).toContain('energy')
    expect(tight.dropped.length).toBeGreaterThan(0)
    // 优先级：地点 / 目标先丢，energy / mood 留到最后
    expect(tight.dropped.join(' ')).toContain('地点')
  })

  test('emptyReason：有事件但预算一句都放不下 → budget', () => {
    const c = store.normalizeConfig({
      notebooks: { default: { path: path.join(root, 'scene-7'), structure: 'flat' } },
      sceneBudgetWords: 20,
    }, root)
    fs.mkdirSync(log.stateDirOf(c), { recursive: true })
    // 31 个词的 mood：比 20 词的场景预算长，整行都放不下（不是没值，是放不下）
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
    fs.writeFileSync(log.rulesPathOf(c), `version = 1\nmood = "${long}"\n`)
    log.appendEvent(c, { name: 'ate', params: {}, at: at(0, 1) }, NOW)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(false)
    expect(projected.emptyReason).toBe('budget')
    expect(projected.dropped).toHaveLength(1)
    expect(projected.words).toBe(0)
  })

  test('emptyReason：有事件但规则算不出可展示的值 → rules', () => {
    const c = withNotebook('scene-8')
    // 100 天前的 ate：satiety 过期，又没有 woke / 地点 / 目标 / 在场事件 → 一个能展示的值都没有
    log.appendEvent(c, { name: 'ate', params: {}, at: at(100) }, NOW)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(false)
    expect(projected.emptyReason).toBe('rules')
  })

  test('emptyReason：日志读不出来 → error，而不是「未启用」', () => {
    const c = withNotebook('scene-9')
    const file = log.eventsPathOf(c)
    // 把 events.log 变成目录：指纹算得出，readFileSync 报 EISDIR —— 文件“在”，只是读不了
    fs.mkdirSync(file, { recursive: true })
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(false)
    expect(projected.emptyReason).toBe('error')
    expect(projected.rulesError).toMatch(/EISDIR|directory|目录/i)
    // 真没启用时仍然是 no-log —— 两种原因不能混为一谈
    fs.rmSync(file, { recursive: true, force: true })
    expect(scene.buildScene(c, { now: NOW }).emptyReason).toBe('no-log')
  })

  test('combinedWords / combinedBudgetNote 口径一致', () => {
    const fake = {
      present: true, presence: 'unknown' as const, events: 1, rulesVersion: 'default', words: 12,
      text: 'x', values: {}, dropped: [], emptyReason: '' as const,
    }
    expect(scene.combinedWords(100, fake)).toBe(112)
    expect(scene.combinedBudgetNote(100, fake, 900)).toBe('')
    expect(scene.combinedBudgetNote(890, fake, 900)).toContain('超出 2')
  })
})
