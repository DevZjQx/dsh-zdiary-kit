import { json } from '../lib/http.js';
import { CFG_FILE, processWorkspace } from '../config/paths.js';
import { config } from '../config/store.js';
import { registerZkTools } from '../features/zk-tools/feature.js';
import { registerSettings } from '../features/settings/feature.js';
import { buildMemoryPayload } from '../lib/memory.js';
import { sessionWorkspace } from '../lib/workspace.js';
/** 系统提示里的段位：5000 是 TOOLS_SDK，9000 是交付物引用 —— 记忆落在两者之间的空档 */
const MEMORY_SECTION_ORDER = 5200;
export default {
    name: 'dsh-zdiary-kit',
    inject: ['tools'],
    apply(ctx) {
        const disposers = [];
        /**
         * 读宿主服务（webServer / connection / systemPrompt 都不在 inject 里）。
         * 直接访问 ctx.webServer 这种未声明依赖的属性，cordis 的 reflect 代理会抛
         * 「cannot get property "x" without inject」；ctx.get() 不会抛，但也可能返回 undefined。
         * 两者都兜住：拿不到就是 undefined —— 插件照常跑工具，只是少一块功能。
         */
        function service(host, name) {
            try {
                const got = host.get(name);
                if (got !== undefined && got !== null)
                    return got;
            }
            catch { /* 宿主对 get 也挑剔 → 退回属性访问 */ }
            try {
                return host[name];
            }
            catch {
                return undefined;
            }
        }
        // ── 信任栅栏 ─────────────────────────────────────────────────────────
        function isLoopbackReq(req) {
            const host = String(req.headers?.host ?? '').toLowerCase();
            const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
            return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
        }
        function connection() {
            return service(ctx, 'connection');
        }
        function isTrustedReq(req) {
            if (isLoopbackReq(req))
                return true;
            try {
                const conn = connection();
                if (conn && typeof conn.isTrusted === 'function')
                    return conn.isTrusted(req) === true;
            }
            catch { /* 栅栏出错 → 不信任 */ }
            return false;
        }
        /**
         * 跨站写请求一律拒绝：Host 是 127.0.0.1 不代表请求来自本页 ——
         * 任何网页都能向回环地址发「简单请求」（不带 Origin 的少，但带了就必须核对）。
         * 浏览器对同源请求会自动带 Origin / Sec-Fetch-Site，这里只放行同源与回环来源。
         */
        function crossSiteWrite(req) {
            const method = String(req.method ?? 'GET').toUpperCase();
            if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
                return false;
            if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site')
                return true;
            const origin = req.headers.origin;
            if (!origin)
                return false;
            try {
                const o = new URL(String(origin));
                const host = String(req.headers.host ?? '');
                if (o.host === host)
                    return false;
                return !(o.hostname === '127.0.0.1' || o.hostname === 'localhost' || o.hostname === '[::1]' || o.hostname === '::1');
            }
            catch {
                return true;
            }
        }
        /** 栅栏不可用 → 拒绝（安全组件的默认值必须是「关」） */
        function rejected(req, res) {
            if (!isTrustedReq(req)) {
                json(res, 403, { ok: false, error: '不受信任的访问来源' });
                return true;
            }
            if (crossSiteWrite(req)) {
                json(res, 403, { ok: false, error: '拒绝跨站写请求' });
                return true;
            }
            try {
                const conn = connection();
                if (!conn || typeof conn.requestRejection !== 'function') {
                    json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' });
                    return true;
                }
                const code = conn.requestRejection(req);
                if (code === undefined || code === null || code === false)
                    return false;
                res.statusCode = typeof code === 'number' ? code : 403;
                res.end();
                return true;
            }
            catch {
                json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' });
                return true;
            }
        }
        // ── 工具 ────────────────────────────────────────────────────────────
        /**
         * 这次工具调用该用哪个工作区：会话 cwd 优先（exec.agent.id → sessions.get(id).header.cwd），
         * 拿不到会话就退回进程工作区。同一个宿主进程开多个工作区时，各自看各自的 <工作区>/zdiary。
         */
        const workspaceOf = (exec) => {
            const sessions = service(ctx, 'sessions');
            return sessionWorkspace(exec, sessions) ?? processWorkspace();
        };
        const tools = service(ctx, 'tools');
        if (tools && typeof tools.register === 'function') {
            try {
                disposers.push(registerZkTools(tools, workspaceOf));
            }
            catch (err) {
                try {
                    console.warn('[zdiary] 工具注册失败：' + (err instanceof Error ? err.message : String(err)));
                }
                catch { /* 无 console 也不该炸 */ }
            }
        }
        else {
            try {
                console.warn('[zdiary] 宿主没有 tools 服务：zk_* 工具不可用（设置页仍可用）');
            }
            catch { /* ignore */ }
        }
        // ── 记忆注入（M1）─────────────────────────────────────────────────
        // text 用函数：宿主每个 step 都重新求值 → 改完 MEMORY.md 立刻生效，也不写会话历史。
        // 装配上下文带 agent.id（= 会话 id，裸装配没有）→ 记忆跟着**这次会话的工作区**走，
        // 和 zk_* 工具看同一份；拿不到会话才退回进程工作区。
        // 宿主没有 systemPrompt（headless / 精简 profile）就安静跳过，工具侧仍有 zk_context。
        function memoryText(assemble) {
            try {
                const sessions = service(ctx, 'sessions');
                const workspace = sessionWorkspace(assemble, sessions) ?? processWorkspace();
                return buildMemoryPayload(config(workspace)).text;
            }
            catch {
                return '';
            }
        }
        function registerMemory(host) {
            const prompt = service(host, 'systemPrompt');
            if (!prompt || typeof prompt.section !== 'function')
                return;
            // interpolate: false —— 记忆是文件原文：笔记里写 `{{title}}` / `{{content}}` 很常见，
            // 按提示变量插值的话，未注册的名字会让整次装配抛错（整个 step 失败），
            // 叫 provider / model 的则会被静默改写成真实值。DSH 自己给所有「内容类」段也是这么关的。
            host.effect(() => prompt.section({ name: 'zdiary:memory', order: MEMORY_SECTION_ORDER, text: memoryText, interpolate: false }));
            try {
                console.log('[zdiary] 记忆注入已挂载：AGENTS.md / USER.md / MEMORY.md → 系统提示');
            }
            catch { /* ignore */ }
        }
        if (service(ctx, 'systemPrompt')) {
            try {
                registerMemory(ctx);
            }
            catch (err) {
                try {
                    console.warn('[zdiary] 记忆注入失败：' + (err instanceof Error ? err.message : String(err)));
                }
                catch { /* ignore */ }
            }
        }
        else if (typeof ctx.inject === 'function') {
            // service 还没就绪：等它出现再注册（宿主完全没这个 service 时永不回调）
            try {
                ctx.inject(['systemPrompt'], registerMemory);
            }
            catch { /* ignore */ }
        }
        // ── 设置页路由（没有 webServer 就不挂，headless profile 也照常跑工具）──
        function mountRoutes(host) {
            const webServer = service(host, 'webServer');
            if (!webServer || typeof webServer.register !== 'function') {
                try {
                    console.warn('[zdiary] 没有 webServer：跳过设置页路由（zk_* 工具不受影响）');
                }
                catch { /* ignore */ }
                return;
            }
            const route = (pathname, handler) => {
                disposers.push(webServer.register({
                    kind: 'exact',
                    path: pathname,
                    handler: async (req, res) => {
                        if (rejected(req, res))
                            return;
                        try {
                            await handler(req, res);
                        }
                        catch (err) {
                            try {
                                json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
                            }
                            catch { /* 响应可能已结束 */ }
                        }
                    },
                }));
            };
            try {
                registerSettings({ route, isTrusted: isTrustedReq });
                try {
                    console.log('[zdiary] 设置页路由已挂载：/dsh-zdiary-kit/api/*');
                }
                catch { /* ignore */ }
            }
            catch (err) {
                try {
                    console.warn('[zdiary] 设置路由注册失败：' + (err instanceof Error ? err.message : String(err)));
                }
                catch { /* ignore */ }
            }
        }
        // webServer 是后加载的服务：apply 跑的时候它可能还没上线，用 cordis 的子 fiber 等它
        if (service(ctx, 'webServer')) {
            mountRoutes(ctx);
        }
        else if (typeof ctx.inject === 'function') {
            try {
                ctx.inject(['webServer'], mountRoutes);
            }
            catch { /* ignore */ }
        }
        else {
            try {
                console.warn('[zdiary] 没有 webServer：跳过设置页路由（zk_* 工具不受影响）');
            }
            catch { /* ignore */ }
        }
        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose();
                }
                catch { /* 已卸载 */ }
            }
        });
        try {
            const cfg = config();
            console.log(`[zdiary] 已挂载：zk_* 工具 · 笔记本 ${cfg.notebook} · 配置 ${CFG_FILE}`);
        }
        catch { /* 日志失败不影响插件 */ }
    },
};
