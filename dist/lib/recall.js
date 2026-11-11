import { countWords } from './memory.js';
import { entryPointsOf } from './entry-points.js';
import { archivedCounterparts } from './archive-probe.js';
import { bumpUsage } from './usage.js';
import { bumpRecall } from './recall-signal.js';
import { searchNotesDetailed } from './zk.js';
export const DEFAULT_RECALL_BUDGET = 500;
export const MAX_RECALL_BUDGET = 5_000;
export const DEFAULT_RECALL_LIMIT = 30;
export const MAX_RECALL_LIMIT = 200;
/** 分组键：type 优先，其次首个标签，都没有归「未分类」。分组只决定装配的轮转顺序，组内保持检索顺序 */
function groupOf(n) {
    if (n.type)
        return n.type;
    if (n.tags.length)
        return '#' + n.tags[0];
    return '未分类';
}
/** 各轮转一次地取：预算不会被排在最前的那一类全吃掉 */
function roundRobin(notes) {
    const groups = new Map();
    for (const n of notes) {
        const key = groupOf(n);
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(n);
    }
    const queues = [...groups.values()];
    const out = [];
    for (let round = 0; out.length < notes.length; round += 1) {
        let added = false;
        for (const q of queues) {
            if (q[round]) {
                out.push(q[round]);
                added = true;
            }
        }
        if (!added)
            break;
    }
    return out;
}
/** 与 feature.ts 的 detailOf 同口径：15.6 先用 summary，空串再退回 snippet / lead（lead 实测就是 H1） */
function detailOf(n) {
    return n.summary || (n.snippet && n.snippet !== n.lead ? n.snippet : (n.lead ?? ''));
}
function entryText(n, index) {
    const badges = [n.type, ...n.tags.map((t) => '#' + t)].filter(Boolean);
    const meta = [n.absPath || n.path, `全文 ${n.words} 词`, ...badges].filter(Boolean).join(' · ');
    const detail = detailOf(n);
    return `## ${index + 1}. ${n.title || n.path}\n${meta}${detail ? '\n\n' + detail : ''}`;
}
/**
 * 一次检索 + 内存装配。候选数由 opts.limit 决定（缺省 30），不再为装配多起一个 zk 进程；
 * 每条附 absPath，需要全文时仍由宿主原生 read 取。
 */
export async function assembleRecall(cfg, opts = {}, signal) {
    const budget = Math.min(MAX_RECALL_BUDGET, Math.max(1, Math.trunc(Number(opts.budget) || DEFAULT_RECALL_BUDGET)));
    const limit = Math.min(MAX_RECALL_LIMIT, Math.max(1, Math.trunc(Number(opts.limit) || DEFAULT_RECALL_LIMIT)));
    const result = await searchNotesDetailed(cfg, {
        ...opts,
        limit,
        sort: opts.sort ?? (opts.query ? 'relevance' : 'created-desc'),
    }, signal);
    const items = [];
    const seen = new Set();
    // R9：入口卡排在装配正文之前。`via: 'query'` 的条目指向的笔记可以不在本次结果里 ——
    // 这是卢曼的索引方向（关键词 → 卡号），`via: 'result'` 那些已经在这段正文里，不重复占预算。
    const entryPoints = entryPointsOf(cfg, result.notes, { query: opts.query });
    let entryPointsInText = false;
    const entryLines = entryPoints.points.filter((p) => p.via === 'query')
        .map((p) => `· ${p.entry} → ${p.resolved ? p.absPath : `[[${p.title}]]（用 zk_walk 走进去）`}`);
    let text = '';
    if (entryLines.length) {
        const block = `入口（MEMORY 命中）：\n${entryLines.join('\n')}`;
        if (countWords(block) <= budget) {
            text = block;
            entryPointsInText = true;
        }
    }
    let used = text ? countWords(text) : 0;
    let index = 0;
    for (const n of roundRobin(result.notes)) {
        const note = {
            title: n.title, path: n.path, absPath: n.absPath, summary: n.summary, included: false, reason: 'over-budget',
        };
        if (seen.has(n.path)) {
            note.reason = 'duplicate';
            items.push(note);
            continue;
        }
        seen.add(n.path);
        const detail = detailOf(n);
        if (!n.title && !detail) {
            note.reason = 'empty';
            items.push(note);
            continue;
        }
        const entry = entryText(n, index);
        // 整条试算：分隔符也计入预算，且 countWords 的 CJK 边界让逐条累加不准，直接算整段最稳
        const candidate = text ? text + '\n\n' + entry : entry;
        const words = countWords(candidate);
        if (words > budget) {
            note.reason = 'over-budget';
            items.push(note);
            continue;
        }
        text = candidate;
        used = words;
        note.included = true;
        note.reason = 'included';
        index += 1;
        items.push(note);
    }
    const counters = opts.includeArchived
        ? { entries: [], scanned: 0, truncated: false }
        : archivedCounterparts(cfg, result.notes, { query: opts.query });
    bumpUsage(cfg, [
        'recall',
        ...(entryPoints.points.length ? ['entryPoints'] : []),
        ...(counters.entries.length ? ['counterEntries'] : []),
    ]);
    bumpRecall(cfg, result.notes.map((n) => ({ path: n.path, title: n.title })), 'recall');
    return {
        text, used, budget,
        completeness: result.completeness,
        hasMore: result.hasMore,
        notes: items,
        entryPoints: entryPoints.points,
        entryPointsTruncated: entryPoints.truncated,
        entryPointsInText,
        counterEntries: counters.entries,
        counterEntriesTruncated: counters.truncated,
    };
}
