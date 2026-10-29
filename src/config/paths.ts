/**
 * 路径常量（唯一真相）—— 插件所有落盘都在这一个目录下。
 *
 * 为什么集中在 ~/.dsh/zdiary：
 *   · 会话工作区（workspace-write 的可写根）之外只读不写，权限不用开完全访问；
 *   · config / bin / cache / notebook 都在一处，卸载 = 删一个目录。
 */
import os from 'node:os'
import path from 'node:path'

export const HOME = os.homedir()

/** DSH 自己的 home（尊重 $DSH_HOME，和宿主一致） */
export const DSH_HOME = process.env.DSH_HOME
  ? path.resolve(process.env.DSH_HOME)
  : path.join(HOME, '.dsh')

/** 插件工作目录 */
export const WORK_DIR = path.join(DSH_HOME, 'zdiary')
export const CFG_FILE = path.join(WORK_DIR, 'zdiary.config.json')
/** 插件托管的 zk 二进制（resolveZk 找不到系统 zk 时用这里） */
export const BIN_DIR = path.join(WORK_DIR, 'bin')
export const CACHE_DIR = path.join(WORK_DIR, 'cache')
/** 默认笔记本位置（用户可以把 notebook 指到任何已有 zk 笔记本） */
export const DEFAULT_NOTEBOOK = path.join(WORK_DIR, 'notebook')

/** `~` 展开；空值原样返回 */
export function expandHome(p: string): string {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return HOME
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(HOME, s.slice(2))
  return s
}
