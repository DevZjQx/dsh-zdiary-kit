/**
 * `[[链接]]` 的解析口径（lint 与 dream 共用）。
 *
 * 为什么要抽出来：`zk_lint` 查「MEMORY 里的来源链接还指向活笔记吗」，`zk_dream` 查
 * 「这条候选是不是已经晋升进 MEMORY 了」—— 两处都要回答同一个问题（这个 `[[目标]]` 现在对应哪篇笔记），
 * 各写一份的话，解析顺序迟早分叉，于是同一份 MEMORY 在两个工具里给出不同答案。
 *
 * 顺序固定（与 lint 原来的口径一致）：原路径 → 加 `.md` → `archive/` 下同名 → 活笔记标题 / 文件名。
 * 归档标题**不**反查：归档默认不进检索，再造一套索引就成了第二真相。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
/** `[[路径]]` / `[[路径|别名]]` / `[[路径#小节]]` 都认，取路径部分 */
export const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
/** 标题归一化：压空白 + 小写，不改字（中文不受影响，也不会把「A B」和「AB」当成同一个） */
export function normalizeTitle(title) {
    return String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function wikiIndex(notes) {
    const byTitle = new Map();
    for (const note of notes) {
        for (const key of [normalizeTitle(note.title), normalizeTitle(path.basename(note.path, path.extname(note.path)))]) {
            if (key && !byTitle.has(key))
                byTitle.set(key, note.path);
        }
    }
    return { byTitle };
}
function insideNotebook(cfg, abs) {
    const root = path.resolve(cfg.notebook);
    const p = path.resolve(abs);
    return p === root || p.startsWith(root + path.sep);
}
function statusOf(abs) {
    try {
        return parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.status ?? '';
    }
    catch {
        return '';
    }
}
function relOf(cfg, abs) {
    return path.relative(cfg.notebook, abs).split(path.sep).join('/');
}
/** 把一个 `[[目标]]` 落到具体文件上：活笔记 / 已归档 / 不存在 */
export function resolveWikiTarget(cfg, target, index) {
    const rel = String(target ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!rel)
        return { status: 'missing', path: '', explicit: false };
    const candidates = /\.md$/i.test(rel) ? [rel] : [rel, `${rel}.md`];
    for (const candidate of candidates) {
        const abs = path.resolve(cfg.notebook, candidate);
        if (!insideNotebook(cfg, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile())
            continue;
        const hit = relOf(cfg, abs);
        // 显式写 archive/ 路径 = 有意引用旧结论（supersede 就是这样重写入链的），不算漂移
        if (hit === cfg.archiveDir || hit.startsWith(`${cfg.archiveDir}/`)) {
            return { status: 'archived', path: hit, explicit: true };
        }
        return { status: statusOf(abs) === 'superseded' ? 'archived' : 'live', path: hit, explicit: false };
    }
    // 链接还停在废弃前的路径：文件已经搬进 archive/ —— 这正是要抓的漂移
    if (!rel.startsWith(`${cfg.archiveDir}/`)) {
        for (const candidate of candidates) {
            const abs = path.resolve(cfg.notebook, cfg.archiveDir, candidate);
            if (!insideNotebook(cfg, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile())
                continue;
            return { status: 'archived', path: relOf(cfg, abs), explicit: false };
        }
    }
    // 标题式链接只在活笔记里找
    const byTitle = index.byTitle.get(normalizeTitle(rel));
    if (byTitle)
        return { status: 'live', path: byTitle, explicit: false };
    return { status: 'missing', path: '', explicit: false };
}
