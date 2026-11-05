/**
 * 标题相似度（唯一一份）：周审 lint 与 zk_new 的写路径提示共用。
 *
 * 为什么单独一个文件：lint.ts 已经 import zk.ts，zk.ts 反向 import lint.ts 会成环；
 * 相似判定抽到无依赖的小模块，两边都往下 import。
 *
 * 纯机械：NFKC → 小写 → 去标点 / 空白，按字符二元组算 Jaccard ≥ 0.6；
 * 短串（≥ 6 字）被长串包含也算命中。不做语义判断、不调模型、不建索引。
 */
import path from 'node:path';
import { normalizeTitle } from './wikilink.js';
/** 字符二元组 Jaccard 下限 */
const SIMILAR_RATIO = 0.6;
/** 短串被长串包含时，短串至少要这么长（码点数） */
const SIMILAR_SHORT = 6;
/** 标题短于这个码点数不参与比较：二元组太少（RAG / RAG 2 会算出 0.67），噪声大于信号 */
const SIMILAR_MIN = 4;
/** 比较用的标题：NFKC → 小写 → 去标点 / 空白。中文不改字，只抹掉排版差异 */
function similarKey(title) {
    return String(title ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
/** 字符二元组；单字标题退化成单字本身（否则集合为空，永远算不出相似） */
function bigrams(key) {
    const chars = [...key];
    const out = new Set();
    for (let i = 0; i < chars.length - 1; i++)
        out.add(chars[i] + chars[i + 1]);
    if (out.size === 0 && chars.length > 0)
        out.add(chars[0]);
    return out;
}
/** Jaccard 相似度（0–1） */
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const gram of a)
        if (b.has(gram))
            shared += 1;
    return shared / (a.size + b.size - shared);
}
/**
 * 可比较的标题；空标题与纯数字（日期 / 编号）返回 null。
 * 纯数字标题的相似度只反映「数字挨着」，不反映重复结论 —— 一年日记会吐出上千组误报。
 */
export function similarKeyOf(title) {
    const key = similarKey(title);
    if (!key || /^\d+$/.test(key))
        return null;
    // size 按码点算（[...key].length），不混用 .length：后者数 UTF-16 单元，
    // 标题带 emoji / 扩展区汉字时会比码点多一倍，「谁是短串」会判错。
    return { key, grams: bigrams(key), size: [...key].length };
}
/**
 * 两个标题的相似度（两位小数）；不相似返回 null。
 * 「短串被长串包含」命中时按下限 0.6 记 —— 否则 0.5 的分数会让「已经报了」看起来自相矛盾。
 */
export function similarScore(a, b) {
    if (a.size < SIMILAR_MIN || b.size < SIMILAR_MIN)
        return null;
    const score = jaccard(a.grams, b.grams);
    if (score >= SIMILAR_RATIO)
        return Math.round(score * 100) / 100;
    const [short, long, shortSize] = a.size <= b.size ? [a.key, b.key, a.size] : [b.key, a.key, b.size];
    if (shortSize >= SIMILAR_SHORT && long.includes(short))
        return SIMILAR_RATIO;
    return null;
}
/**
 * 写路径查重（P2）：同一目录里与 title 相似的已有标题，最多 max 条，分数降序。
 *
 * 只提示、不阻断：误报会挡住正常写作，是否合并仍是人的判断。
 * 归一化后全等的交给 duplicateTitles / createNote 的硬查重，这里不重复报。
 * 归档由调用方先滤掉 —— 这里不认识 Config，也不该自己判断哪些路径算归档。
 */
export function similarCandidates(notes, title, dir, max = 3) {
    const target = similarKeyOf(title);
    if (!target)
        return [];
    const exact = normalizeTitle(title);
    const dirKey = dir.replace(/\/+$/, '');
    const out = [];
    for (const note of notes) {
        if (!note.path || path.posix.dirname(note.path) !== dirKey)
            continue;
        // 无标题的笔记用文件名 —— 与 `similarTitles` 的 `title || basename` 同口径，
        // 否则写路径与周审的候选集不一样（分数一致也没用）。
        const otherTitle = note.title || path.basename(note.path, path.extname(note.path));
        if (!otherTitle)
            continue;
        if (normalizeTitle(otherTitle) === exact)
            continue;
        const other = similarKeyOf(otherTitle);
        if (!other)
            continue;
        const score = similarScore(target, other);
        if (score === null)
            continue;
        out.push({ title: otherTitle, path: note.path, score });
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, max);
}
