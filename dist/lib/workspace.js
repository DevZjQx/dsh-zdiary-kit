/**
 * 会话工作区：这次调用（工具执行 / 提示词装配）到底该看哪个目录。
 *
 * DSH 的会话在创建时带一个验证过的绝对 cwd（SessionHeader.cwd），工具上下文与
 * system-prompt 的装配上下文都带 agent.id（= session id）—— 所以「同一个宿主进程、
 * 多个工作区」也能各看各的，注入和工具看同一份记忆。
 * 拿不到会话（设置页 / CLI / 裸装配没带 agent）时，调用方退回进程工作区。
 */
import path from 'node:path';
/** 取这次调用的会话工作区；没有会话 / 没有 cwd / 宿主报错 → undefined */
export function sessionWorkspace(exec, sessions) {
    const id = exec?.agent?.id;
    if (!id || !sessions)
        return undefined;
    try {
        const cwd = sessions.get(id)?.header?.cwd;
        return typeof cwd === 'string' && cwd ? path.resolve(cwd) : undefined;
    }
    catch {
        return undefined;
    }
}
