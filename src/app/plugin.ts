/**
 * dsh-zdiary-kit —— 宿主侧插件（应用层：唯一的组合点）
 *
 * 只做装配，不放业务：
 *   · 注册 zk_* 工具（features/zk-tools）—— 工具自己每次读配置、自己 ensureNotebook；
 *   · 注册设置/状态/安装路由（features/settings）—— 只在宿主有 webServer 时挂；
 *   · 信任栅栏：回环直通 + connection.requestRejection（fail-closed）—— 设置页的公共门；
 *     只读视图走自己的回环门（Host + 对端），因为它要能被没有 cookie 的 curl / RSS 直接读。
 *     Web 端口在回环地址上，但浏览器里任何页面都能向回环发请求；没有这层栅栏，
 *     一个恶意网页就能改你的笔记本路径、让插件下载并执行二进制。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackHost, json } from '../lib/http.ts'
import { CFG_FILE, processWorkspace } from '../config/paths.ts'
import { config } from '../config/store.ts'
import { configFor } from '../config/session.ts'
import { registerZkTools } from '../features/zk-tools/feature.ts'
import { registerReadOnly } from '../features/readonly/feature.ts'
import { registerSettings } from '../features/settings/feature.ts'
import { buildMemoryPayload } from '../lib/memory.ts'
import { structureStatus } from '../lib/notebook.ts'
import { sessionWorkspace } from '../lib/workspace.ts'
import type { SessionsLike } from '../lib/workspace.ts'
import type { AssemblyContextLike, ConnectionLike, PluginContext, RouteHandler, SystemPromptLike, ToolsLike, ToolRunContextLike, WebServerLike } from '../lib/dsh.ts'

/** 系统提示里的段位：5000 是 TOOLS_SDK，9000 是交付物引用 —— 记忆落在两者之间的空档 */
const NOTEBOOK_SECTION_ORDER = 5190
const MEMORY_SECTION_ORDER = 5200

export default {
  name: 'dsh-zdiary-kit',
  inject: ['tools'],
  apply(ctx: PluginContext): void {
    const disposers: Array<() => void> = []

    /**
     * 读宿主服务（webServer / connection / systemPrompt 都不在 inject 里）。
     * 直接访问 ctx.webServer 这种未声明依赖的属性，cordis 的 reflect 代理会抛
     * 「cannot get property "x" without inject」；ctx.get() 不会抛，但也可能返回 undefined。
     * 两者都兜住：拿不到就是 undefined —— 插件照常跑工具，只是少一块功能。
     */
    function service<T>(host: PluginContext, name: string): T | undefined {
      try {
        const got = host.get<T>(name)
        if (got !== undefined && got !== null) return got
      } catch { /* 宿主对 get 也挑剔 → 退回属性访问 */ }
      try {
        return (host as unknown as Record<string, unknown>)[name] as T | undefined
      } catch {
        return undefined
      }
    }

    // ── 信任栅栏 ─────────────────────────────────────────────────────────
    function connection(): ConnectionLike | undefined {
      return service<ConnectionLike>(ctx, 'connection')
    }
    function isTrustedReq(req: IncomingMessage): boolean {
      // 只看 Host：设置页沿用「本机地址 = 可信」的旧口径；其余交给 Connection 的公开栅栏
      if (isLoopbackHost(req)) return true
      const conn = connection()
      if (!conn || typeof conn.requestRejection !== 'function') return false
      // requestRejection = Host/Origin 栅栏 + 浏览器会话认证（DSH 的公开口径，别用私有 isTrusted）
      try { return conn.requestRejection(req) === undefined } catch { return false }
    }
    /**
     * 跨站写请求一律拒绝：Host 是 127.0.0.1 不代表请求来自本页 ——
     * 任何网页都能向回环地址发「简单请求」（不带 Origin 的少，但带了就必须核对）。
     * 浏览器对同源请求会自动带 Origin / Sec-Fetch-Site，这里只放行同源与回环来源。
     */
    function crossSiteWrite(req: IncomingMessage): boolean {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
      if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return true
      const origin = req.headers.origin
      if (!origin) return false
      try {
        const o = new URL(String(origin))
        const host = String(req.headers.host ?? '')
        if (o.host === host) return false
        return !(o.hostname === '127.0.0.1' || o.hostname === 'localhost' || o.hostname === '[::1]' || o.hostname === '::1')
      } catch {
        return true
      }
    }

    /**
     * 栅栏不可用 → 拒绝（安全组件的默认值必须是「关」）。
     * Host/Origin 与浏览器会话都交给 Connection 的公开 requestRejection ——
     * 不再自己先判一遍 Host：两处口径分叉时，先判的那处会静默赢。
     */
    function rejected(req: IncomingMessage, res: ServerResponse): boolean {
      if (crossSiteWrite(req)) { json(res, 403, { ok: false, error: '拒绝跨站写请求' }); return true }
      try {
        const conn = connection()
        if (!conn || typeof conn.requestRejection !== 'function') {
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true
      }
    }

    // ── 工具 ────────────────────────────────────────────────────────────
    /**
     * 这次工具调用该用哪个工作区：会话 cwd 优先（exec.agent.id → sessions.get(id).header.cwd），
     * 拿不到会话就退回进程工作区。同一个宿主进程开多个工作区时，各自看各自的 <工作区>/zdiary。
     */
    const workspaceOf = (exec: ToolRunContextLike | undefined): string => {
      const sessions = service<SessionsLike>(ctx, 'sessions')
      return sessionWorkspace(exec, sessions) ?? processWorkspace()
    }
    const tools = service<ToolsLike>(ctx, 'tools')
    if (tools && typeof tools.register === 'function') {
      try {
        disposers.push(registerZkTools(tools, workspaceOf))
      } catch (err) {
        try { console.warn('[zdiary] 工具注册失败：' + (err instanceof Error ? err.message : String(err))) } catch { /* 无 console 也不该炸 */ }
      }
    } else {
      try { console.warn('[zdiary] 宿主没有 tools 服务：zk_* 工具不可用（设置页仍可用）') } catch { /* ignore */ }
    }

    // ── 记忆注入（M1）─────────────────────────────────────────────────
    // text 用函数：宿主每个 step 都重新求值 → 改完 MEMORY.md 立刻生效，也不写会话历史。
    // 装配上下文带 agent.id（= 会话 id，裸装配没有）→ 记忆跟着**这次会话的工作区与笔记本**走，
    // 和 zk_* 工具看同一份；拿不到会话才退回进程工作区 + 全局默认笔记本。
    // 宿主没有 systemPrompt（headless / 精简 profile）就安静跳过，工具侧仍有 zk_context。
    function memoryText(assemble?: AssemblyContextLike): string {
      try {
        const sessions = service<SessionsLike>(ctx, 'sessions')
        const workspace = sessionWorkspace(assemble, sessions) ?? processWorkspace()
        return buildMemoryPayload(configFor(workspace, assemble?.agent?.id)).text
      } catch {
        return ''
      }
    }
    /**
     * 笔记本一行：模型不用先调工具就知道「当前在哪本、还有哪些能切」。
     * 单独一段、不计入记忆预算 —— 塞进 memory payload 会参与截断，还会挤占 500 词额度。
     */
    function notebookText(assemble?: AssemblyContextLike): string {
      try {
        const sessions = service<SessionsLike>(ctx, 'sessions')
        const workspace = sessionWorkspace(assemble, sessions) ?? processWorkspace()
        const cfg = configFor(workspace, assemble?.agent?.id)
        const others = Object.keys(cfg.notebooks).filter((name) => name !== cfg.active)
        const extra = others.length ? `；另有：${others.join('、')}（zk_use 切换本会话）` : ''
        // 配置 flat、盘上却是分层目录：新建笔记会静默落到 notes/ 根（无模板、随机文件名）。
        // 把这一句写进每轮注入，agent 写之前就能看见（P1-7；只报告，不改结构）。
        const st = structureStatus(cfg)
        const drift = st.mode === 'flat' && st.extra.length
          ? `；⚠️ 盘上有分层目录（${st.extra.join('、')}），新建笔记会落在 ${cfg.notesDir}/ 根，不套模板`
          : ''
        return `知识库：当前笔记本「${cfg.active}」（${cfg.structure}）→ ${cfg.notebook}${extra}${drift}`
      } catch {
        return ''
      }
    }
    function registerPromptSections(host: PluginContext): void {
      const prompt = service<SystemPromptLike>(host, 'systemPrompt')
      if (!prompt || typeof prompt.section !== 'function') return
      // interpolate: false —— 记忆是文件原文：笔记里写 `{{title}}` / `{{content}}` 很常见，
      // 按提示变量插值的话，未注册的名字会让整次装配抛错（整个 step 失败），
      // 叫 provider / model 的则会被静默改写成真实值。DSH 自己给所有「内容类」段也是这么关的。
      host.effect(() => prompt.section({ name: 'zdiary:notebook', order: NOTEBOOK_SECTION_ORDER, text: notebookText, interpolate: false }))
      host.effect(() => prompt.section({ name: 'zdiary:memory', order: MEMORY_SECTION_ORDER, text: memoryText, interpolate: false }))
      try { console.log('[zdiary] 提示注入已挂载：笔记本 + AGENTS.md / USER.md / MEMORY.md → 系统提示') } catch { /* ignore */ }
    }
    if (service<SystemPromptLike>(ctx, 'systemPrompt')) {
      try {
        registerPromptSections(ctx)
      } catch (err) {
        try { console.warn('[zdiary] 记忆注入失败：' + (err instanceof Error ? err.message : String(err))) } catch { /* ignore */ }
      }
    } else if (typeof ctx.inject === 'function') {
      // service 还没就绪：等它出现再注册（宿主完全没这个 service 时永不回调）
      try { ctx.inject(['systemPrompt'], registerPromptSections) } catch { /* ignore */ }
    }

    // ── 设置页路由（没有 webServer 就不挂，headless profile 也照常跑工具）──
    function mountRoutes(host: PluginContext): void {
      const webServer = service<WebServerLike>(host, 'webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        try { console.warn('[zdiary] 没有 webServer：跳过设置页路由（zk_* 工具不受影响）') } catch { /* ignore */ }
        return
      }
      /**
       * 注册一条 exact 路由。gate=true 时先过信任栅栏（Host/Origin + Connection 的
       * 浏览器会话认证）；gate=false 只给「公开只读」用，安全边界由路由自己兜。
       */
      const mount = (pathname: string, handler: RouteHandler, gate: boolean): void => {
        disposers.push(webServer.register({
          kind: 'exact',
          path: pathname,
          handler: async (req, res) => {
            if (gate && rejected(req, res)) return
            try {
              await handler(req, res)
            } catch (err) {
              try { json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) }) } catch { /* 响应可能已结束 */ }
            }
          },
        }))
      }
      const route = (pathname: string, handler: RouteHandler): void => mount(pathname, handler, true)
      /**
       * 公开只读路由：不套 DSH 的浏览器会话栅栏。
       * Connection.requestRejection 除了 Host/Origin 还会校验浏览器 cookie，
       * 而只读视图要能被 curl / RSS 阅读器直接读（它们没有 DSH 的 cookie）。
       * 这一面由 features/readonly 自己的 guard 兜：Host 与对端地址都必须是回环。
       * 别拿它挂有副作用或返回敏感配置的路由 —— 那类路由必须走 route()。
       */
      const routePublic = (pathname: string, handler: RouteHandler): void => mount(pathname, handler, false)
      try {
        registerSettings({ route, isTrusted: isTrustedReq })
        try { console.log('[zdiary] 设置页路由已挂载：/dsh-zdiary-kit/api/*') } catch { /* ignore */ }
      } catch (err) {
        try { console.warn('[zdiary] 设置路由注册失败：' + (err instanceof Error ? err.message : String(err))) } catch { /* ignore */ }
      }
      // 只读视图：自己的方法门 / 回环门，不共享设置页的写路由；注册失败不影响工具与设置页
      try {
        registerReadOnly({ route: routePublic })
        try { console.log('[zdiary] 只读视图已挂载：/dsh-zdiary-kit/view · /feed.xml · /api/notes · /api/note') } catch { /* ignore */ }
      } catch (err) {
        try { console.warn('[zdiary] 只读视图注册失败：' + (err instanceof Error ? err.message : String(err))) } catch { /* ignore */ }
      }
    }
    // webServer 是后加载的服务：apply 跑的时候它可能还没上线，用 cordis 的子 fiber 等它
    if (service<WebServerLike>(ctx, 'webServer')) {
      mountRoutes(ctx)
    } else if (typeof ctx.inject === 'function') {
      try { ctx.inject(['webServer'], mountRoutes) } catch { /* ignore */ }
    } else {
      try { console.warn('[zdiary] 没有 webServer：跳过设置页路由（zk_* 工具不受影响）') } catch { /* ignore */ }
    }

    ctx.effect(() => () => {
      for (const dispose of disposers) { try { dispose() } catch { /* 已卸载 */ } }
    })

    try {
      const cfg = config()
      console.log(`[zdiary] 已挂载：zk_* 工具 · 笔记本 ${cfg.notebook} · 配置 ${CFG_FILE}`)
    } catch { /* 日志失败不影响插件 */ }
  },
}
