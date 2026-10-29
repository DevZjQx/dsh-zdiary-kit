/**
 * 笔记本根目录的 meta 文件：唯一定义处（计划 §7「工具层只放一个常量」）。
 *
 * 三份被注入（MEMORY_META_FILES，按注入顺序），五份一律不进检索与统计（META_NAMES）。
 * 为什么要拆：注入只读三份，排除要连 DREAMS.md / INDEX.md 一起排；
 * 两份清单共用一个真相，才不会出现「新加一份 meta 忘了排除」。
 */
/** 会被注入系统提示的三份，顺序即注入顺序 */
export const MEMORY_META_FILES = ['AGENTS.md', 'USER.md', 'MEMORY.md'];
/** 全部 meta 文件（不进检索 / 统计 / 追加写入） */
export const META_NAMES = ['AGENTS.md', 'MEMORY.md', 'USER.md', 'DREAMS.md', 'INDEX.md'];
/** 相对路径是不是根目录的 meta 文件（只认根目录；子目录里的同名文件是普通笔记） */
export function isMetaPath(rel) {
    const normalized = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    return META_NAMES.includes(normalized);
}
