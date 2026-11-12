/**
 * 「空模板小节」的唯一判定：模板里装正文 / 论断 / 摘录的二级小节空着，
 * 而同一篇里另有自己起的、有内容的二级小节 —— 内容在，只是被写到了别处，模板槽只剩一个标题。
 *
 * 根因是模板的 `{{content}}` 位置：`ENTRY_TEMPLATE` 是 `## Summary` → `## Content` → `{{content}}`，
 * `SOURCE_TEMPLATE` 是 `## Summary` → `## Key claims` → `## Quotes` → `{{content}}`。
 * 正文第一行就是 `## 一句话` / `## 问题：…` 时，前面那些槽必然空着 —— 这不是内容缺失，
 * 是排版噪声（`zk_new` 的返回值与 `zk_lint` 都只提示，不改正文）。
 *
 * 为什么只认这三个槽：
 *   · `## Summary` 本来就选填（`zk_new` 给了 summary 才填），空着不是问题；
 *   · `## Links` 大多数笔记没有出链，空着是常态；
 *   · 其余标题（`## 一句话` / `## 问题：…`）是正文自己的结构，空不空由作者决定。
 *
 * 只看「槽空着」不够：`## Content` 空 + 整篇没有正文（新建的空笔记）不算错位。
 * 所以再加一条：必须存在另一个有内容的二级小节，才说明内容在、只是没放进槽里。
 *
 * 判空口径与 zk 的标题一致：ATX、收尾井号是装饰；frontmatter 与围栏代码里的 `##`
 * 既不算标题也不算正文（否则代码块里的示例会被当内容，或者被当小节）。
 */
import { fenceMask } from './fence.js';
/** 模板里装正文 / 论断 / 摘录的二级小节（英文模板标题，小写比较） */
export const TEMPLATE_CONTENT_SLOTS = ['content', 'key claims', 'quotes'];
/** 空着也不代表错位的二级小节：Summary 选填，Links 常年为空 */
const NEUTRAL_SECTIONS = ['summary', '摘要', 'links', '链接'];
function normalizeHeading(title) {
    return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
/** frontmatter 与围栏代码换成空行，行号保持不变 */
function maskLines(input) {
    const masked = input.slice();
    if ((masked[0] ?? '').trim() === '---') {
        for (let i = 1; i < masked.length; i++) {
            const text = (masked[i] ?? '').trim();
            if (text === '---' || text === '...') {
                for (let j = 0; j <= i; j++)
                    masked[j] = '';
                break;
            }
        }
    }
    const fenced = fenceMask(masked);
    for (let i = 0; i < masked.length; i++)
        if (fenced[i])
            masked[i] = '';
    return masked;
}
function headingsOf(masked) {
    const heads = [];
    for (let i = 0; i < masked.length; i++) {
        const m = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(masked[i] ?? '');
        if (!m)
            continue;
        const title = (m[2] ?? '').replace(/[ \t]+#+$/, '').trim();
        if (!title)
            continue;
        heads.push({ line: i + 1, level: (m[1] ?? '').length, title });
    }
    return heads;
}
/**
 * 找出空着的内容槽；没有（或没有「正文写到了别处」这个前提）就给空数组。
 * 纯函数、只读文本：`zk_new` 建完收尾与 `zk_lint` 巡检共用同一份判定。
 */
export function emptyTemplateSlots(content) {
    const lines = String(content ?? '').split('\n');
    const masked = maskLines(lines);
    const heads = headingsOf(masked);
    const slots = new Set(TEMPLATE_CONTENT_SLOTS);
    const neutral = new Set(NEUTRAL_SECTIONS);
    /** 这一节到下一个同级 / 更高级标题之间（1 起、含上界） */
    const sectionEnd = (k) => {
        for (let i = k + 1; i < heads.length; i++) {
            if (heads[i].level <= heads[k].level)
                return heads[i].line - 1;
        }
        return lines.length;
    };
    const isEmptySection = (k) => {
        const end = sectionEnd(k);
        for (let ln = heads[k].line + 1; ln <= end; ln++) {
            // 判空用原文、不用 masked：只含一个代码块的小节也算「有内容」（标题才必须从 masked 取）
            if ((lines[ln - 1] ?? '').trim() !== '')
                return false;
        }
        return true;
    };
    const adHoc = heads.some((h, k) => h.level === 2
        && !slots.has(normalizeHeading(h.title))
        && !neutral.has(normalizeHeading(h.title))
        && !isEmptySection(k));
    if (!adHoc)
        return [];
    return heads
        .filter((h, k) => h.level === 2 && slots.has(normalizeHeading(h.title)) && isEmptySection(k))
        .map((h) => ({ heading: h.title, line: h.line }));
}
