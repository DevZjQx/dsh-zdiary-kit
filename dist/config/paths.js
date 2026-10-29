/**
 * 路径常量（唯一真相）。
 *
 * 分两处落盘，理由不同：
 *   · **配置 / 内置 zk / 缓存**在 ~/.dsh/zdiary —— 跟会话无关，换项目也复用；
 *   · **笔记本**默认在工作区内的 <workspace>/zdiary —— 会话文件策略（workspace-write）只放行工作区内的
 *     读/写，笔记本放外面的话 agent 连 Read/Edit 那些 .md 都要开 danger-full-access；放里面
 *     就只要 workspace-write，人和别的工具也看得见。
 * 插件自己在宿主进程里跑，用 node:fs / 子进程，不受这层策略约束 —— 但没必要让用户为了读日记去放宽权限。
 */
import os from 'node:os';
import path from 'node:path';
export const HOME = os.homedir();
/** DSH 自己的 home（尊重 $DSH_HOME，和宿主一致） */
export const DSH_HOME = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(HOME, '.dsh');
/** 插件工作目录（配置 / zk 二进制 / 缓存） */
export const WORK_DIR = path.join(DSH_HOME, 'zdiary');
export const CFG_FILE = path.join(WORK_DIR, 'zdiary.config.json');
/** 插件托管的 zk 二进制（resolveZk 找不到系统 zk 时用这里） */
export const BIN_DIR = path.join(WORK_DIR, 'bin');
export const CACHE_DIR = path.join(WORK_DIR, 'cache');
/**
 * 会话工作区根：$DSH_WORKSPACE → 进程 cwd。
 * 不直接用 cwd 的地方在于——插件可能在任意 cwd 下被加载，显式环境变量能钉死。
 */
export const WORKSPACE = process.env.DSH_WORKSPACE
    ? path.resolve(process.env.DSH_WORKSPACE)
    : process.cwd();
/** 默认笔记本位置：工作区内（可写根里），不是 ~/.dsh */
export const DEFAULT_NOTEBOOK = path.join(WORKSPACE, 'zdiary');
/** `~` 展开；空值原样返回 */
export function expandHome(p) {
    const s = String(p ?? '').trim();
    if (!s)
        return '';
    if (s === '~')
        return HOME;
    if (s.startsWith('~/') || s.startsWith('~\\'))
        return path.join(HOME, s.slice(2));
    return s;
}
/** 相对路径按工作区解析（不是按进程 cwd —— 两者可能不是一回事） */
export function resolveInWorkspace(p) {
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(WORKSPACE, p);
}
