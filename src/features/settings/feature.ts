/**
 * settings（宿主半边）—— 本 feature 的公共入口
 *
 * 只做四件事：
 *   1. 配置读写：GET/POST /dsh-zdiary-kit/api/settings（白名单 + 归一化在 config/store）
 *   2. 状态：GET /status（zk 在哪、笔记本在不在、笔记/标签/断链数）
 *   3. 动作：POST /init（建库）、/index（重建索引）、/install（装内置 zk）
 *   4. 自检：GET /selftest —— 每一项都真跑一次，不做「看起来对」的检查
 *
 * 浏览器半边在 ./client.ts，由包导出 ./client 加载；两半靠同一份 API 契约对齐。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import { json, readBody } from '../../lib/http.ts'
import { CFG_FILE, processWorkspace } from '../../config/paths.ts'
import { config, writeConfig } from '../../config/store.ts'
import type { Config } from '../../config/store.ts'
import { ensureNotebook, structureStatus } from '../../lib/notebook.ts'
import type { StructureStatus } from '../../lib/notebook.ts'
import { buildMemoryPayload, formatFileShares } from '../../lib/memory.ts'
import type { MemoryPayload } from '../../lib/memory.ts'
import { installZk } from '../../lib/install.ts'
import { hasNotebook, indexNotebook, notebookStats, resolveZk } from '../../lib/zk.ts'
import type { ZkLocation } from '../../lib/zk.ts'
import type { RouteHandler } from '../../lib/dsh.ts'

const P = '/dsh-zdiary-kit/api'

export interface SettingsDeps {
  route: (pathname: string, handler: RouteHandler) => void
  isTrusted: (req: IncomingMessage) => boolean
}

interface ZkStatus {
  found: boolean
  version?: string
  path?: string
  source?: ZkLocation['source']
  hint?: string
}

async function zkStatus(cfg: Config): Promise<ZkStatus> {
  const loc = await resolveZk(cfg)
  if (!loc) {
    return {
      found: false,
      hint: '点「安装内置 zk」（首次约 10 MB），或自己装一个后填「zk 路径」',
    }
  }
  return { found: true, version: loc.version, path: loc.bin, source: loc.source }
}

/** 笔记本快照：缺东西时不报错，只如实说缺什么 */
async function snapshot(cfg: Config) {
  const zk = await zkStatus(cfg)
  const exists = hasNotebook(cfg)
  let counts: { notes: number; tags: number; brokenLinks: number; orphans: number; archived: number; superseded: number } | null = null
  let countsError: string | null = null
  if (exists && zk.found) {
    try {
      counts = await notebookStats(cfg)
    } catch (err) {
      countsError = err instanceof Error ? err.message : String(err)
    }
  }
  // 结构一致性只做检查：以配置为准，磁盘不一致就如实说缺哪个目录（不自动建、不自动删）
  const structure: StructureStatus = structureStatus(cfg)
  let memory: Pick<MemoryPayload, 'words' | 'budget' | 'truncatedWords' | 'files'> | null = null
  try {
    const payload = buildMemoryPayload(cfg)
    memory = { words: payload.words, budget: payload.budget, truncatedWords: payload.truncatedWords, files: payload.files }
  } catch { memory = null }
  return {
    zk,
    // 本页解析空 / 相对路径用的是插件进程工作区；agent 工具按各自会话工作区，可能不是同一个目录
    workspace: processWorkspace(),
    notebook: { path: cfg.notebook, exists },
    structure,
    memory,
    dailyTemplate: fs.existsSync(path.join(cfg.notebook, '.zk', 'templates', 'daily.md')),
    counts,
    countsError,
  }
}

export function registerSettings({ route, isTrusted }: SettingsDeps): void {
  const requireTrusted = (req: IncomingMessage, res: import('node:http').ServerResponse): boolean => {
    if (isTrusted(req)) return true
    json(res, 403, { ok: false, error: '不受信任的访问来源' })
    return false
  }

  // ── 配置读写（GET 与 POST 合在一个 handler：宿主可能「首个匹配即终止」）──
  route(`${P}/settings`, async (req, res) => {
    if (req.method === 'GET') {
      const cfg = config()
      json(res, 200, { ok: true, config: cfg, configPath: CFG_FILE, ...(await snapshot(cfg)) })
      return
    }
    if (!requireTrusted(req, res)) return
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return }
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
    } catch {
      json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const incoming = body.config && typeof body.config === 'object' ? body.config as Record<string, unknown> : body
    const before = config()
    const next = writeConfig(incoming)
    const warn: string[] = []
    // 切换即就绪：active 变了就顺手建好目标笔记本（ensureNotebook 幂等）；
    // 失败只进 warn —— 保存本身已生效。改路径不算切换，不在这里建目录（防手滑）。
    let initFailed = false
    if (next.active !== before.active) {
      try {
        await ensureNotebook(next)
      } catch (err) {
        initFailed = true
        warn.push('已切换笔记本，但自动初始化失败：' + (err instanceof Error ? err.message : String(err)) + ' —— 点「初始化 / 补建」重试')
      }
    }
    if (next.zkPath && !fs.existsSync(next.zkPath)) warn.push('zk 路径不存在：' + next.zkPath)
    const exists = hasNotebook(next)
    if (!exists && !initFailed) warn.push('这个目录还不是 zk 笔记本 —— 点「初始化 / 补建」创建')
    const st = structureStatus(next)
    if (exists && st.missing.length) {
      warn.push(`结构是 ${st.mode}，但还缺目录：${st.missing.join('、')} —— 点「初始化 / 补建」`)
    }
    if (exists && st.agents.required && !st.agents.present) {
      warn.push('layered 结构缺 AGENTS.md —— 点「初始化 / 补建」写入模板')
    }
    json(res, 200, { ok: true, config: next, configPath: CFG_FILE, warn: warn.length ? warn.join('；') : null, ...(await snapshot(next)) })
  })

  // ── 状态 ──
  route(`${P}/status`, async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return }
    const cfg = config()
    json(res, 200, { ok: true, config: cfg, ...(await snapshot(cfg)) })
  })

  // ── 初始化 / 补建（幂等，同一个 POST /init）──
  route(`${P}/init`, async (req, res) => {
    if (!requireTrusted(req, res)) return
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return }
    const cfg = config()
    try {
      const result = await ensureNotebook(cfg)
      json(res, 200, { ok: true, result, ...(await snapshot(cfg)) })
    } catch (err) {
      json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── 重建索引 ──
  route(`${P}/index`, async (req, res) => {
    if (!requireTrusted(req, res)) return
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return }
    const cfg = config()
    try {
      await indexNotebook(cfg)
      json(res, 200, { ok: true, ...(await snapshot(cfg)) })
    } catch (err) {
      json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── 安装内置 zk（官方 release → 插件 bin 目录 → 真跑一次）──
  route(`${P}/install`, async (req, res) => {
    if (!requireTrusted(req, res)) return
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return }
    const cfg = config()
    let version = cfg.zkVersion
    try {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
      if (body.version) version = String(body.version).replace(/^v/i, '')
    } catch { /* 版本用配置里的 */ }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      json(res, 400, { ok: false, error: '版本号不合法：' + version })
      return
    }
    try {
      const result = await installZk(version)
      json(res, 200, { ok: true, result, detail: `已安装 zk ${result.version} → ${result.path}`, ...(await snapshot(cfg)) })
    } catch (err) {
      json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── 自检：每一项都真跑 ──
  route(`${P}/selftest`, async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return }
    const cfg = config()
    const items: Array<{ name: string; ok: boolean; detail: string }> = []

    const zk = await zkStatus(cfg)
    items.push({
      name: 'zk 可执行文件',
      ok: zk.found,
      detail: zk.found ? `${zk.version}（${zk.source}）${zk.path}` : (zk.hint ?? '没找到'),
    })

    const exists = hasNotebook(cfg)
    items.push({
      name: '笔记本',
      ok: exists,
      detail: exists ? cfg.notebook : `没有 .zk/config.toml —— 点「初始化 / 补建」（${cfg.notebook}）`,
    })

    const templateFile = path.join(cfg.notebook, '.zk', 'templates', 'daily.md')
    items.push({
      name: '日记模板',
      ok: fs.existsSync(templateFile),
      detail: fs.existsSync(templateFile) ? templateFile : '缺 .zk/templates/daily.md，点「初始化 / 补建」补上',
    })

    let groupOk = false
    try {
      const toml = fs.readFileSync(path.join(cfg.notebook, '.zk', 'config.toml'), 'utf8')
      groupOk = new RegExp(`^\\[group\\."?${cfg.dailyGroup}"?\\]`, 'm').test(toml)
    } catch { groupOk = false }
    items.push({
      name: `日记 group（${cfg.dailyGroup}）`,
      ok: groupOk,
      detail: groupOk ? `group."${cfg.dailyGroup}" → ${cfg.dailyDir}/` : '配置里没有这个 group，点「初始化 / 补建」补上',
    })

    const st = structureStatus(cfg)
    items.push({
      name: `结构（${st.mode}）`,
      ok: !exists || (st.ready && (!st.agents.required || st.agents.present)),
      detail: !exists
        ? '笔记本还没建，先初始化'
        : st.ready
          ? st.agents.required
            ? (st.agents.present ? `${st.dirs.length} 个目录齐全 · AGENTS.md 就绪` : '目录齐全，缺 AGENTS.md —— 点「初始化 / 补建」')
            : `${st.dirs.length} 个目录齐全`
          : `缺目录：${st.missing.join('、')} —— 点「初始化 / 补建」`,
    })

    try {
      const payload = buildMemoryPayload(cfg)
      const present = payload.files.filter((f) => f.present)
      items.push({
        name: '长期记忆',
        // 三份都空不算错：flat 老 vault 本来就可能没启用记忆；只有超预算才是 ✗
        ok: payload.words <= payload.budget,
        detail: present.length === 0
          ? '未启用：根目录没有 AGENTS.md / USER.md / MEMORY.md（layered 初始化会写一份 AGENTS.md 模板）'
          : `${payload.words}/${payload.budget} 词 · ${formatFileShares(payload.files, payload.tocWords)}` +
            (payload.truncatedWords > 0 ? `，已截断 ${payload.truncatedWords} 词` : ''),
      })
    } catch (err) {
      items.push({ name: '长期记忆', ok: false, detail: err instanceof Error ? err.message : String(err) })
    }

    if (zk.found && exists) {
      try {
        const stats = await notebookStats(cfg)
        items.push({
          name: '索引',
          ok: true,
          detail: `${stats.notes} 篇笔记 / ${stats.tags} 个标签 / 归档 ${stats.archived}（superseded ${stats.superseded}）`,
        })
      } catch (err) {
        items.push({ name: '索引', ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    } else {
      items.push({ name: '索引', ok: false, detail: 'zk 或笔记本缺失，索引无从谈起' })
    }

    json(res, 200, { ok: items.every((i) => i.ok), items })
  })
}
