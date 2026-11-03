/**
 * 笔记本根目录的 meta 文件：唯一定义处（计划 §7「工具层只放一个常量」）。
 *
 * 三份被注入记忆段（MEMORY_META_FILES，按注入顺序），角色契约（CONTRACT_META_FILES）单独注入、
 * 永远在记忆段之前；七份一律不进检索与统计（META_NAMES）。
 * 为什么要拆：注入清单与排除清单共用一份真相，才不会出现「新加一份 meta 忘了排除」。
 *
 * 契约文件（PERSONA.md）与 MEMORY 同级：根目录 meta，人类所有；
 * 工具不能写、不能搬（zk 层的 isMetaPath 守卫自动覆盖）。缺文件 = 未启用，不报错。
 * 迁移说明：根目录曾有同名普通笔记的库，需要改名或移入子目录。
 */

/** 会被注入系统提示的三份，顺序即注入顺序 */
export const MEMORY_META_FILES = ['AGENTS.md', 'USER.md', 'MEMORY.md'] as const
export type MetaName = typeof MEMORY_META_FILES[number]

/** 契约层（角色契约），人类所有，缺文件 = 未启用 */
export const CONTRACT_META_FILES = ['PERSONA.md'] as const

/** 全部 meta 文件（不进检索 / 统计 / 追加写入） */
export const META_NAMES = ['AGENTS.md', 'MEMORY.md', 'USER.md', 'DREAMS.md', 'INDEX.md', 'WORKFLOW.md', 'PERSONA.md'] as const

/** 相对路径是不是根目录的 meta 文件（只认根目录；子目录里的同名文件是普通笔记） */
export function isMetaPath(rel: string): boolean {
  const normalized = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  return (META_NAMES as ReadonlyArray<string>).includes(normalized)
}
