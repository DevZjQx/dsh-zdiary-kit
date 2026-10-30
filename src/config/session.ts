/**
 * 会话级笔记本：一个 DSH 会话固定看一本。
 *
 * 为什么全局 active 不够：多个会话共用一份配置，A 里切库会让 B 的下一句工具调用
 * 和下一步记忆注入一起换库 —— 手里还攥着旧库路径的调用会写错地方，而且一句提示都没有。
 *
 * 语义：
 *   · `active` 是**默认值**：会话第一次调用时快照成自己的 pin；
 *   · 会话 pin 住之后，别处（设置页 / CLI / 别的会话）切库不再带动它；
 *   · 本会话换库只能显式来（zk_use），这样「这次切换影响谁」是可解释的；
 *   · pin 落在 sessions/<hash>.json：进程重启 / 会话 resume 还能接上，30 天没动的清掉；
 *   · pin 指向的笔记本被移除时静默回到默认值并重写 pin（跟删配置的语义一致）。
 *
 * 落盘是每会话一份小文件，不是一张大表 —— 多进程同时写也不会互相覆盖。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SESSION_DIR } from './paths.ts'
import { config, isNotebookName, selectNotebook } from './store.ts'
import type { Config } from './store.ts'
import { readJson, writeJson } from '../lib/json-file.ts'

interface SessionRecord {
  id: string
  notebook: string
  workspace?: string
  updatedAt: string
}

/** 进程内只缓存「pin 是什么」；文件才是真相，别的进程可能刚改过 */
const pins = new Map<string, string | null>()
let pruned = false

const PIN_TTL_MS = 30 * 24 * 60 * 60 * 1000

function fileOf(sessionId: string): string {
  const hash = crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 20)
  return path.join(SESSION_DIR, `${hash}.json`)
}

/** 清掉很久没动过的会话文件；一个进程只扫一次，失败不影响功能 */
function pruneOnce(): void {
  if (pruned) return
  pruned = true
  let names: string[]
  try { names = fs.readdirSync(SESSION_DIR) } catch { return }
  const now = Date.now()
  for (const name of names) {
    const file = path.join(SESSION_DIR, name)
    try {
      if (now - fs.statSync(file).mtimeMs > PIN_TTL_MS) fs.rmSync(file, { force: true })
    } catch { /* 并发删掉了 / 没权限：跳过 */ }
  }
}

/** 这个会话固定在哪本；没有 pin（新会话 / 老文件坏了）返回 null */
export function sessionNotebook(sessionId: string | undefined): string | null {
  if (!sessionId) return null
  const cached = pins.get(sessionId)
  if (cached !== undefined) return cached
  pruneOnce()
  const record = readJson<SessionRecord | null>(fileOf(sessionId), null)
  const name = record && typeof record.notebook === 'string' && isNotebookName(record.notebook)
    ? record.notebook
    : null
  pins.set(sessionId, name)
  return name
}

/** 把会话固定到某本（zk_use 与首次自动 pin 共用） */
export function pinSession(sessionId: string, name: string, workspace?: string): void {
  pins.set(sessionId, name)
  try {
    writeJson(fileOf(sessionId), {
      id: sessionId,
      notebook: name,
      ...(workspace ? { workspace } : {}),
      updatedAt: new Date().toISOString(),
    } satisfies SessionRecord)
  } catch { /* 只读环境：内存 pin 仍然有效，重启后退回默认值 */ }
}

/** 当前会话该用哪份配置：pin 优先，没有就快照默认值并落盘 */
export function configFor(workspace: string, sessionId?: string): Config {
  const base = config(workspace)
  if (!sessionId) return base
  const pinned = sessionNotebook(sessionId)
  if (!pinned) {
    pinSession(sessionId, base.active, workspace)
    return base
  }
  // pin 指向的笔记本被删了：回到默认值，别让整个会话卡在空配置上
  if (!(pinned in base.notebooks)) {
    pinSession(sessionId, base.active, workspace)
    return base
  }
  return pinned === base.active ? base : selectNotebook(base, pinned, workspace)
}

export interface SessionState {
  /** 本会话实际在用的笔记本名 */
  active: string
  /** 全局默认（配置文件里的 active） */
  defaultName: string
  /** 本会话 pin 的名字；没 pin 时是空串 */
  pinned: string
  /** pin 和默认值不一致 —— 说明别处切过库，而这个会话没跟 */
  diverged: boolean
}

/** 给 zk_context / zk_stats 回显用：让「本会话固定在 X」是能看见的，而不是靠猜 */
export function sessionState(workspace: string, sessionId?: string): SessionState {
  const cfg = configFor(workspace, sessionId)
  const defaultName = config(workspace).active
  const pinned = sessionNotebook(sessionId) ?? ''
  return {
    active: cfg.active,
    defaultName,
    pinned,
    diverged: !!pinned && pinned !== defaultName,
  }
}
