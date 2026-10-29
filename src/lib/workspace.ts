/**
 * 会话工作区：这次工具调用到底该看哪个目录。
 *
 * DSH 的会话在创建时带一个验证过的绝对 cwd（SessionHeader.cwd），工具上下文里的
 * agent.id 就是 session id —— 所以「同一个宿主进程、多个工作区」也能各看各的。
 * 拿不到会话（设置页 / CLI / 宿主没给 agent）时，调用方退回进程工作区。
 */
import path from 'node:path'
import type { ToolRunContextLike } from './dsh.ts'

/** 宿主会话服务的最小面（ctx.sessions: SessionStore，缺了也不影响工具） */
export interface SessionsLike {
  get(id: string): { readonly header?: { readonly cwd?: string } } | undefined
}

/** 取这次调用的会话工作区；没有会话 / 没有 cwd / 宿主报错 → undefined */
export function sessionWorkspace(
  exec: ToolRunContextLike | undefined,
  sessions: SessionsLike | undefined,
): string | undefined {
  const id = exec?.agent?.id
  if (!id || !sessions) return undefined
  try {
    const cwd = sessions.get(id)?.header?.cwd
    return typeof cwd === 'string' && cwd ? path.resolve(cwd) : undefined
  } catch {
    return undefined
  }
}
