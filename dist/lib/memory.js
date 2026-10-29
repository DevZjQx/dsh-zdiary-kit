/**
 * 记忆注入（M1）：读 vault 根目录的 AGENTS.md / USER.md / MEMORY.md，
 * 按 `memoryBudgetWords` 截断，渲染成一段可注入系统提示的文本。
 *
 * 三条硬约定（与 docs/plan-memory-layers.md §3 D6 一致）：
 *   · 预算按**总载荷**算，不是只卡 MEMORY.md；
 *   · 截断顺序纯机械：先丢 MEMORY 的尾部 `##` 整段，再丢 USER 的尾部整段，
 *     最后各自只留首段；AGENTS.md 是硬规则，永不截断（单独超预算时只告警）；
 *   · 中文按「1 词 / 2 字」计 —— 空白切分在中文上严重低估，300 词会变成装饰。
 *
 * 读文件失败一律当作「没有这份文件」：老 vault 没有这些文件也能照常工作。
 */
import fs from 'node:fs';
import path from 'node:path';
/** vault 根目录下、按优先级排列的三份 meta 文件 */
export const META_FILES = ['AGENTS.md', 'USER.md', 'MEMORY.md'];
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
/** 词数：CJK 按 2 字 1 词，其余按空白切分 */
export function countWords(text) {
    if (!text)
        return 0;
    const cjk = (text.match(CJK) ?? []).length;
    const latin = text.replace(CJK, ' ').split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjk / 2) + latin;
}
function splitSections(body) {
    const head = [];
    const sections = [];
    for (const line of body.split('\n')) {
        if (/^##\s+/.test(line))
            sections.push([line]);
        else if (sections.length > 0)
            sections[sections.length - 1].push(line);
        else
            head.push(line);
    }
    return {
        head: head.join('\n').trim(),
        sections: sections.map((s) => s.join('\n').trim()).filter(Boolean),
    };
}
function joinSections(split) {
    return [split.head, ...split.sections].filter(Boolean).join('\n\n');
}
/** 只留首段（preamble + 第一个 `##` 段） */
function firstSection(body) {
    const split = splitSections(body);
    return joinSections({ head: split.head, sections: split.sections.slice(0, 1) });
}
function readMeta(cfg) {
    const out = [];
    for (const name of META_FILES) {
        let body = '';
        try {
            body = fs.readFileSync(path.join(cfg.notebook, name), 'utf8').trim();
        }
        catch { /* 缺文件 = 空 */ }
        out.push({ name, body });
    }
    return out;
}
function escapeFrame(text) {
    // 文件内容不许提前闭合我们自己的 <system-reminder> 框
    return text.replaceAll('</system-reminder>', '<\\/system-reminder>');
}
/**
 * 生成注入载荷。纯读文件，不碰 zk、不建目录：笔记本不存在时返回空载荷。
 * @param cfg - 当前配置（只用到 notebook 与 memoryBudgetWords）
 * @returns 载荷；`text === ''` 表示没有可注入的内容
 */
export function buildMemoryPayload(cfg) {
    const budget = cfg.memoryBudgetWords;
    const files = readMeta(cfg);
    const original = new Map(files.map((f) => [f.name, f.body]));
    const words = new Map(files.map((f) => [f.name, countWords(f.body)]));
    const total = () => [...words.values()].reduce((a, b) => a + b, 0);
    // ── 机械截断：MEMORY 尾段 → USER 尾段 → 各留首段 ──────────────────
    for (const name of ['MEMORY.md', 'USER.md']) {
        if (total() <= budget)
            break;
        const split = splitSections(original.get(name) ?? '');
        while (total() > budget && split.sections.length > 1) {
            split.sections.pop();
            const body = joinSections(split);
            original.set(name, body);
            words.set(name, countWords(body));
        }
    }
    if (total() > budget) {
        for (const name of ['USER.md', 'MEMORY.md']) {
            const body = firstSection(original.get(name) ?? '');
            original.set(name, body);
            words.set(name, countWords(body));
        }
    }
    const present = files.filter((f) => (original.get(f.name) ?? '').length > 0);
    const bodies = present.map((f) => `## ${f.name}\n\n${escapeFrame(original.get(f.name) ?? '')}`);
    const finalWords = total();
    const originalWords = files.reduce((sum, f) => sum + countWords(f.body), 0);
    const truncatedWords = Math.max(0, originalWords - finalWords);
    let text = '';
    if (bodies.length > 0) {
        const notes = [];
        if (truncatedWords > 0)
            notes.push(`已截断 ${truncatedWords} 词`);
        if (finalWords > budget) {
            notes.push(`预算不足：内容 ${finalWords} 词，超出 ${budget} 词；AGENTS.md 为硬规则，不截断`);
        }
        const notice = notes.length > 0 ? `\n\n（注入预算 ${budget} 词：${notes.join('；')}）` : '';
        text =
            '<system-reminder>\n' +
                '以下内容由 zdiary 从知识库根目录读出，是长期约定与记忆；与系统、开发者或用户的直接指令冲突时，以更直接的那条为准。\n\n' +
                bodies.join('\n\n') +
                notice +
                '\n</system-reminder>';
    }
    return {
        text,
        words: finalWords,
        budget,
        truncatedWords,
        files: files.map((f) => ({ name: f.name, present: f.body.length > 0, words: words.get(f.name) ?? 0 })),
    };
}
