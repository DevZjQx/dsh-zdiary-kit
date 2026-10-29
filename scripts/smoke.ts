#!/usr/bin/env bun
/**
 * 冒烟测试：用假的宿主上下文加载**构建产物**，真跑工具 + 真发 HTTP 请求。
 *
 * 这不是单元测试（见 test/），而是「装进 DSH 之前最后一道门」：
 *   · dist 里的插件能被 apply；
 *   · 8 个工具能注册、能执行、能渲染；
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
writeConfig({ notebook, zkPath: zkBin })
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
if (tools.length !== 10) throw new Error('工具数量不对：' + tools.length)
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
const postJson = async (p: string) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const body = await res.json() as Record<string, unknown>
  if (!res.ok || body.ok === false) throw new Error(`POST ${p} 失败：${JSON.stringify(body)}`)
  return body
}

const settings = await getJson('/settings')
if (!settings.config || (settings.zk as { found: boolean }).found !== true) throw new Error('settings 快照不对')
console.log('\n[GET /settings] zk =', JSON.stringify(settings.zk), '笔记数 =', JSON.stringify(settings.counts))

const status = await getJson('/status')
console.log('[GET /status] notebook.exists =', (status.notebook as { exists: boolean }).exists)

const init = await postJson('/init')
console.log('[POST /init] 幂等 =', JSON.stringify(init.result))

const indexed = await postJson('/index')
console.log('[POST /index] 计数 =', JSON.stringify(indexed.counts))

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
