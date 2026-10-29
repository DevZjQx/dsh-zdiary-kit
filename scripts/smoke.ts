#!/usr/bin/env bun
/**
 * 冒烟测试：用假的宿主上下文加载**构建产物**，真跑工具 + 真发 HTTP 请求。
 *
 * 这不是单元测试（见 test/），而是「装进 DSH 之前最后一道门」：
 *   · dist 里的插件能被 apply；
 *   · 12 个工具能注册、能执行、能渲染；
 *   · 6 条设置路由能工作（走真实的 http 请求，信任栅栏用假的 connection 顶替）。
 *
 *   ZK_BIN=/path/to/zk bun run smoke
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const zkBin = process.env.ZK_BIN || 'zk'
if (!fs.existsSync(zkBin) && !process.env.PATH?.split(path.delimiter).some((d) => fs.existsSync(path.join(d, zkBin)))) {
  console.error('✗ 找不到 zk（给 ZK_BIN 或把 zk 放进 PATH）')
  process.exit(1)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-smoke-'))
process.env.DSH_HOME = home
const notebook = path.join(home, 'notebook')

const { writeConfig } = await import('../dist/config/store.js')
writeConfig({ notebooks: { default: { path: notebook, structure: 'flat' } }, zkPath: zkBin })
fs.mkdirSync(notebook, { recursive: true })
fs.writeFileSync(path.join(notebook, 'AGENTS.md'), '# 约定\n\n先查重再写。\n')

const plugin = (await import('../dist/app/plugin.js')).default

type Tool = {
  name: string
  execute: (a: unknown, e: unknown) => Promise<unknown>
  output: { schema: unknown; render: (a: unknown, v: unknown) => Array<{ type: string; text: string }> }
}
const tools: Tool[] = []
const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => unknown>()
const promptSections: Array<{ name: string; order: number; text: string | (() => string) }> = []

const ctx = {
  get(name: string) {
    if (name === 'tools') return { register: (d: Tool) => { tools.push(d); return () => {} } }
    if (name === 'systemPrompt') {
      return { section: (s: typeof promptSections[number]) => { promptSections.push(s); return () => {} } }
    }
    if (name === 'webServer') {
      return {
        register: (spec: { path: string; handler: (req: http.IncomingMessage, res: http.ServerResponse) => unknown }) => {
          routes.set(spec.path, spec.handler)
          return () => { routes.delete(spec.path) }
        },
      }
    }
    if (name === 'connection') return { isTrusted: () => true, requestRejection: () => undefined }
    return undefined
  },
  effect(fn: () => unknown) { fn() },
}

plugin.apply(ctx as never)

// 记忆注入：注册到 systemPrompt，且真读到了笔记本根目录的 AGENTS.md
const memorySection = promptSections.find((s) => s.name === 'zdiary:memory')
if (!memorySection) throw new Error('zdiary:memory 没有注册到 systemPrompt')
const injected = typeof memorySection.text === 'function' ? memorySection.text() : memorySection.text
if (!injected.includes('先查重再写')) throw new Error('注入内容没有读到 AGENTS.md')
console.log(`记忆注入：${memorySection.name} · order ${memorySection.order} · ${injected.length} 字符`)

// ── 输出 schema 必须落在 DSH 支持的子集里（超集会在 register 时直接 TypeError）──
const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
function checkSchema(node: unknown, at: string): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${at} 不是 schema 对象`)
  const n = node as Record<string, unknown>
  for (const key of Object.keys(n)) if (!ALLOWED.has(key)) throw new Error(`${at} 用了不支持的 keyword：${key}`)
  if (Array.isArray(n.type)) throw new Error(`${at}.type 不能是数组`)
  if (n.type === 'object') {
    if (typeof n.additionalProperties !== 'boolean') throw new Error(`${at} 是 object 但没声明 additionalProperties`)
    const props = (n.properties ?? {}) as Record<string, unknown>
    for (const key of (n.required as string[] | undefined) ?? []) {
      if (!(key in props)) throw new Error(`${at}.required 里的 ${key} 不在 properties 里`)
    }
    for (const [key, sub] of Object.entries(props)) checkSchema(sub, `${at}.properties.${key}`)
  }
  if (n.type === 'array') checkSchema(n.items, `${at}.items`)
}
for (const tool of tools) checkSchema(tool.output.schema, `${tool.name}.output.schema`)

console.log('工具：' + tools.map((t) => t.name).join(', '))
console.log('路由：' + [...routes.keys()].join(', '))
if (tools.length !== 12) throw new Error('工具数量不对：' + tools.length)
if (routes.size !== 6) throw new Error('路由数量不对：' + routes.size)

const call = async (name: string, args: unknown) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error('没有工具 ' + name)
  const value = await tool.execute(args, { signal: AbortSignal.timeout(30_000) })
  const blocks = tool.output.render(args, value)
  console.log(`\n[${name}] → ${blocks.map((b) => b.text).join('\n').slice(0, 300)}`)
  return value as Record<string, unknown>
}

const created = await call('zk_new', { title: '冒烟测试笔记', body: '这是冒烟测试写进去的正文。', tags: ['smoke'] })
if (!fs.existsSync(path.join(notebook, String(created.path)))) throw new Error('笔记没落盘：' + created.path)
await call('zk_search', { query: '冒烟', limit: 5 })
await call('zk_read', { path: created.path })
await call('zk_daily', { entry: '冒烟测试：日记也通了。' })
await call('zk_new', { title: '被链接的笔记', body: '目标。' })
await call('zk_link', { from: created.path, to: '被链接的笔记' })
await call('zk_append', { path: created.path, text: '追加一段。', heading: '补充' })
const queried = await call('zk_query', { tags: ['smoke'], status: 'active' })
if (Number(queried.count) < 1) throw new Error('zk_query 没查到刚写的笔记')
const preview = await call('zk_supersede', { path: created.path })
if (preview.dryRun !== true || preview.performed !== false) throw new Error('zk_supersede 默认不是预演')
const linted = await call('zk_lint', {})
if (typeof (linted.orphans as Record<string, unknown>).total !== 'number') throw new Error('zk_lint 输出不对')
const dreamed = await call('zk_dream', { days: 7 })
if (!Array.isArray(dreamed.newNotes)) throw new Error('zk_dream 输出不对')
await call('zk_stats', {})

// ── 真发 HTTP：设置页依赖的 6 条路由 ──────────────────────────────────────
const server = http.createServer((req, res) => {
  const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  if (!handler) { res.statusCode = 404; res.end('no route'); return }
  Promise.resolve(handler(req, res)).catch((err) => { res.statusCode = 500; res.end(String(err)) })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}/dsh-zdiary-kit/api`

const getJson = async (p: string) => {
  const res = await fetch(base + p)
  const body = await res.json() as Record<string, unknown>
  if (!res.ok || body.ok === false) throw new Error(`GET ${p} 失败：${JSON.stringify(body)}`)
  return body
}
const postJson = async (p: string, payload: unknown = {}) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const body = await res.json() as Record<string, unknown>
  if (!res.ok || body.ok === false) throw new Error(`POST ${p} 失败：${JSON.stringify(body)}`)
  return body
}

const settings = await getJson('/settings')
if (!settings.config || (settings.zk as { found: boolean }).found !== true) throw new Error('settings 快照不对')
const structure0 = settings.structure as { mode: string; ready: boolean; missing: string[] }
if (structure0.mode !== 'flat' || !structure0.ready) throw new Error('settings 快照里的结构状态不对：' + JSON.stringify(structure0))
const memory0 = settings.memory as { budget: number; words: number }
if (memory0.budget !== 300 || memory0.words <= 0) throw new Error('settings 快照里的记忆预算不对：' + JSON.stringify(memory0))
console.log('\n[GET /settings] zk =', JSON.stringify(settings.zk), '笔记数 =', JSON.stringify(settings.counts), '结构 =', structure0.mode, '记忆 =', memory0.words + '/' + memory0.budget)

const status = await getJson('/status')
console.log('[GET /status] notebook.exists =', (status.notebook as { exists: boolean }).exists)

const init = await postJson('/init')
console.log('[POST /init] 幂等 =', JSON.stringify(init.result))

const indexed = await postJson('/index')
console.log('[POST /index] 计数 =', JSON.stringify(indexed.counts))

// ── 多笔记本：notebooks + active 是真相，notebook / structure 是派生的 ──────────
const alt = path.join(home, 'alt')
const two = await postJson('/settings', { config: { notebooks: { default: notebook, alt }, active: 'alt' } })
if ((two.config as { active: string }).active !== 'alt') throw new Error('切换笔记本没落盘')
if ((two.notebook as { path: string }).path !== alt) throw new Error('快照没跟着 active 换：' + JSON.stringify(two.notebook))
// 切换即就绪：切过去的瞬间目标笔记本就该建好（ensureNotebook 幂等，不用再点初始化）
if ((two.notebook as { exists: boolean }).exists !== true) throw new Error('切换后没有自动建好目标笔记本')
// 设置页整份发回来时 notebook / structure 是上一次的旧值：它们是纯派生键，谁也盖不过 notebooks
const kept = await postJson('/settings', { config: { notebooks: { default: notebook, alt: alt + '2' }, notebook, active: 'alt' } })
if ((kept.notebook as { path: string }).path !== alt + '2') throw new Error('派生的 notebook 覆盖了 notebooks')
// 结构跟着笔记本走：active 的条目是什么结构，config.structure 就是什么
const perNb = await postJson('/settings', { config: { notebooks: { default: { path: notebook, structure: 'flat' }, alt: { path: alt + '2', structure: 'layered' } }, active: 'alt' } })
if ((perNb.config as { structure: string }).structure !== 'layered') throw new Error('结构没跟着 active 条目走：' + JSON.stringify(perNb.config))
console.log('[POST /settings] 多笔记本 → active =', (two.config as { active: string }).active, '· 切换后快照 =', (two.notebook as { path: string }).path, '· 切换即就绪 ✓ · 每笔记本结构 ✓')
// 切回默认笔记本：后面的 layered 补建仍在原来那个库上
await postJson('/settings', { config: { notebooks: { default: notebook }, active: 'default' } })

// 切到 layered：保存立刻生效（快照已变），但目录不会自己长出来 —— 必须显式补建
const switched = await postJson('/settings', { config: { structure: 'layered' } })
if ((switched.config as { structure: string }).structure !== 'layered') throw new Error('结构模式没落盘')
const pending = switched.structure as { mode: string; ready: boolean; missing: string[] }
if (pending.ready || pending.missing.length === 0) throw new Error('只保存配置不该自动建目录：' + JSON.stringify(pending))
console.log('[POST /settings] 切 layered → 待补建', pending.missing.join('、'))

const filled = await postJson('/init')
const filledResult = filled.result as { dirsCreated: string[]; agentsWritten: boolean }
if (!filledResult.dirsCreated.includes('raw')) throw new Error('补建没有建 raw/：' + JSON.stringify(filledResult))
// 这个 vault 开头就自己写了 AGENTS.md：补建必须保留它（既不覆盖，也不重复写模板）
if (fs.readFileSync(path.join(notebook, 'AGENTS.md'), 'utf8') !== '# 约定\n\n先查重再写。\n') {
  throw new Error('补建覆盖了用户自己的 AGENTS.md')
}
if (filledResult.agentsWritten) throw new Error('AGENTS.md 已存在却又写了一遍模板')
if (!fs.existsSync(path.join(notebook, String(created.path)))) throw new Error('补建把已有笔记搬走了：' + created.path)
const after = await getJson('/settings')
const structure1 = after.structure as { mode: string; ready: boolean; agents: { present: boolean } }
if (!structure1.ready || !structure1.agents.present) throw new Error('补建后结构不一致：' + JSON.stringify(structure1))
console.log('[POST /init] layered 补建 =', JSON.stringify(filledResult.dirsCreated))

// 跨站写请求必须被拒（信任栅栏 + Origin 核对）
const csrf = await fetch(base + '/init', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  body: '{}',
})
if (csrf.status !== 403) throw new Error('跨站 POST /init 没被拒绝：HTTP ' + csrf.status)
console.log('[POST /init] 跨站来源 = 403 ✓')

const selftest = await getJson('/selftest')
for (const item of selftest.items as Array<{ ok: boolean; name: string; detail: string }>) {
  console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}：${item.detail}`)
}
if (selftest.ok !== true) throw new Error('自检没全过')

server.close()
console.log('\n✓ 冒烟通过（工作目录 ' + home + '）')
