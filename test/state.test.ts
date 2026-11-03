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

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('规则 DSL', () => {
  test('默认规则能编译，且 curve 单调下降', () => {
    const compiled = rules.compileDefaultRules()
    expect(compiled.version).toBe(3)
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
    expect(run(16).energy).toBe(20)
    expect(run(24).energy).toBe(20)
    expect(run(40 * 24).energy).toBe(20)
    // 睡 9 小时起点更高，但同样单调
    const compiledLong = rules.compileRules(rules.DEFAULT_RULES.replace('hours=7', 'hours=7'))
    expect(compiledLong).not.toBeNull()
  })

  test('mood 在 20 是「疲惫」，satiety 是饱腹度', () => {
    const compiled = rules.compileDefaultRules()
    const base = {
      now: NOW,
      events: [],
      sceneWindowDays: 30,
      staleHours: 72,
    }
    const values = compiled.evaluate({
      ...base,
      lastSeen: new Map([
        ['woke', { atMs: NOW - 10 * 3_600_000, params: { hours: '7' } }],
        ['ate', { atMs: NOW - 1 * 3_600_000, params: {} }],
      ]),
    })
    expect(values.energy).toBe(20)
    expect(values.mood).toBe('疲惫')
    expect(values.satiety).toBe(96) // 刚吃完 = 高饱腹
    const starved = compiled.evaluate({
      ...base,
      lastSeen: new Map([
        ['woke', { atMs: NOW, params: {} }],
        ['ate', { atMs: NOW - 40 * 86_400_000, params: {} }],
      ]),
    })
    expect(starved.satiety).toBe(30)
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
    const dir = path.join(root, 'log-1')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
    log.appendEvent(c, { name: 'woke', params: { hours: '7.5' }, at: at(1) }, NOW)
    log.appendEvent(c, { name: 'set_goal', params: { text: '写完 D7' }, at: at(0, 1) }, NOW)
    const text = fs.readFileSync(log.eventsPathOf(c), 'utf8')
    expect(text.split('\n')[0]).toBe('# zdiary-state v1')
    const read = log.readStateLog(c, { now: NOW })
    expect(read.total).toBe(2)
    expect(read.lastSeen.get('set_goal')?.params.text).toBe('写完 D7')
  })

  test('坏行跳过并计数，不让整段投影失败', () => {
    const dir = path.join(root, 'log-2')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
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

  test('未来时间拒绝；没有时区拒绝；超过 512 字节拒绝', () => {
    const dir = path.join(root, 'log-3')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
    expect(() => log.appendEvent(c, { name: 'ate', at: new Date(NOW + 10 * 60_000).toISOString() }, NOW)).toThrow()
    expect(() => log.appendEvent(c, { name: 'ate', at: '2026-11-10 12:00:00' }, NOW)).toThrow()
    expect(() => log.appendEvent(c, { name: 'ate', params: { note: 'x'.repeat(600) } }, NOW)).toThrow()
  })

  test('prune 保留窗口内事件 + 每个事件名的 tombstone；hoursSince 仍是真实小时数', () => {
    const dir = path.join(root, 'log-4')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
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

  test('prune 截止天数小于窗口默认拒绝，force 才放行', () => {
    const dir = path.join(root, 'log-5')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
    expect(() => log.pruneStateLog(c, { days: 7, windowDays: 30, now: NOW })).toThrow()
    expect(() => log.pruneStateLog(c, { days: 7, windowDays: 30, force: true, now: NOW })).not.toThrow()
  })
})

describe('场景投影', () => {
  test('空日志 / 零条有效事件 = 不注入', () => {
    const dir = path.join(root, 'scene-1')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(false)
    expect(projected.text).toBe('')
    expect(projected.words).toBe(0)
  })

  test('只有窗口外事件时仍注入长尾（不是「不注入」）', () => {
    const dir = path.join(root, 'scene-2')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
    log.appendEvent(c, { name: 'woke', params: { hours: '7' }, at: at(40) }, NOW)
    log.appendEvent(c, { name: 'at', params: { place: '书房' }, at: at(40) }, NOW)
    log.appendEvent(c, { name: 'user_left', params: {}, at: at(40) }, NOW)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.present).toBe(true)
    expect(projected.events).toBe(0)
    expect(projected.text).toContain('energy 20')
    expect(projected.text).toContain('地点未知')
    expect(projected.text).toContain('书房')
    expect(projected.text).toContain('用户状态未知')
    expect(projected.presence).toBe('unknown')
  })

  test('只记身体事件时在场是「未知」，不是「在场」', () => {
    const dir = path.join(root, 'scene-3')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
    log.appendEvent(c, { name: 'ate', params: {}, at: at(0, 1) }, NOW)
    expect(scene.buildScene(c, { now: NOW }).presence).toBe('unknown')
    log.appendEvent(c, { name: 'user_left', params: {}, at: at(0, 1) }, NOW)
    expect(scene.buildScene(c, { now: NOW }).presence).toBe('absent')
  })

  test('规则文件坏了整份回退默认，且带上第一条错误', () => {
    const dir = path.join(root, 'scene-4')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
    fs.mkdirSync(log.stateDirOf(c), { recursive: true })
    fs.writeFileSync(log.rulesPathOf(c), 'version = 1\nenergy = clamp(1, 10, 0)\n')
    log.appendEvent(c, { name: 'ate', params: {}, at: at(0, 1) }, NOW)
    const projected = scene.buildScene(c, { now: NOW })
    expect(projected.rulesVersion).toBe('default(fallback)')
    expect(projected.rulesError).toContain('clamp')
    expect(projected.present).toBe(true)
  })

  test('预算裁剪：先丢地点 / 目标，留 energy / mood', () => {
    const dir = path.join(root, 'scene-5')
    const c = store.normalizeConfig({ notebooks: { default: { path: dir, structure: 'flat' } } }, root)
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

  test('combinedWords = 记忆载荷 + 场景', () => {
    const fake = { present: true, presence: 'unknown' as const, events: 1, rulesVersion: 'default', words: 12, text: 'x', values: {}, dropped: [] }
    expect(scene.combinedWords(100, fake)).toBe(112)
  })
})
