/**
 * 15.2 召回信号 sidecar：**可关的本地聚合计数**，不是查询日志。
 *
 * `zk_search` / `zk_query` / `zk_recall` 命中时按 path 记一笔「哪篇、哪天、被哪类检索命中」，
 * 给 MEMORY 的晋升（topCited）、退役保护（retireCandidates）、同日淘汰、周审审计流
 * 提供「其实被用过」的证据；否则没被召回过的笔记永远拿不到这类信号。
 *
 * 硬边界（§7.4 / §9.4 / §15.12）：
 *   · 不记查询词、不记正文、不上报；`title` 只是命中笔记的标题，用来关联 MEMORY 的标题式 `[[来源]]`；
 *   · 默认关（`cfg.recallSignal`），关掉时不读不写，输出与改动前逐字节一致；
 *   · 原子写（tmp + rename）+ 失败静默，计数不能把工具调用弄失败；
 *   · 插件不跑定时器，只在工具调用内触发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { WIKI_LINK } from './wikilink.js';
export const RECALL_SIGNAL_FILE = path.join('.zk', 'dsh-recall.json');
/** 每篇最多保留多少个不同召回日期，防止 sidecar 无限膨胀 */
export const MAX_RECALL_DAYS = 30;
/** 周审审计流的固定抽样比例（与分数无关、确定性） */
export const AUDIT_RATE = 0.1;
/** 最近这么多天内被召回过的 MEMORY 条目，不算退役候选 */
export const RECALL_PROTECT_DAYS = 30;
const empty = () => ({ version: 1, since: '', byPath: {} });
/** 「这份信号非空」按 signal 对象缓存：10k 篇时 for...in / Object.keys 每次都要 O(n) 枚举，
 *  而排序比较器一条路径就会调上百次。readRecallSignal 构建时算一次，之后全是 O(1)。 */
const activeCache = new WeakMap();
/** 开关关闭 / 没有笔记本 / 文件坏了：一律空信号，调用方行为与改动前完全一致 */
export function readRecallSignal(cfg) {
    if (cfg.recallSignal !== true || !cfg.notebook)
        return empty();
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(cfg.notebook, RECALL_SIGNAL_FILE), 'utf8'));
        const out = empty();
        if (typeof raw?.since === 'string')
            out.since = raw.since;
        let count = 0;
        if (raw && typeof raw.byPath === 'object' && raw.byPath) {
            for (const [p, value] of Object.entries(raw.byPath)) {
                const e = value;
                if (!e || typeof e !== 'object')
                    continue;
                count += 1;
                out.byPath[p] = {
                    count: Number.isFinite(Number(e.count)) ? Math.max(0, Math.trunc(Number(e.count))) : 0,
                    last: typeof e.last === 'string' ? e.last : '',
                    days: Array.isArray(e.days)
                        ? e.days.filter((d) => typeof d === 'string').slice(-MAX_RECALL_DAYS)
                        : [],
                    queryKinds: Array.isArray(e.queryKinds)
                        ? e.queryKinds.filter((k) => k === 'search' || k === 'query' || k === 'recall')
                        : [],
                    title: typeof e.title === 'string' ? e.title : '',
                };
            }
        }
        activeCache.set(out, count > 0);
        return out;
    }
    catch {
        return empty();
    }
}
/** 有实际召回记录才算「信号生效」；开关打开但空文件仍按老口径走。
 *  readRecallSignal 已按对象算好；未经它构造的手工对象（测试 / 外部）才 fallback 一次短路判断。 */
export function hasRecallSignal(signal) {
    const known = activeCache.get(signal);
    if (known !== undefined)
        return known;
    let active = false;
    for (const key in signal.byPath) {
        if (key) {
            active = true;
            break;
        }
    }
    activeCache.set(signal, active);
    return active;
}
/** 命中时记一笔：同一批里的同 path 只记一次；失败静默（计数器，不是账本） */
export function bumpRecall(cfg, hits, kind) {
    if (cfg.recallSignal !== true || !hits.length || !cfg.notebook)
        return;
    const file = path.join(cfg.notebook, RECALL_SIGNAL_FILE);
    const signal = readRecallSignal(cfg);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (!signal.since)
        signal.since = now.toISOString();
    const seen = new Set();
    for (const hit of hits) {
        if (!hit.path || seen.has(hit.path))
            continue;
        seen.add(hit.path);
        const prev = signal.byPath[hit.path] ?? { count: 0, last: '', days: [], queryKinds: [], title: hit.title ?? '' };
        signal.byPath[hit.path] = {
            count: prev.count + 1,
            last: today,
            days: prev.days.includes(today) ? prev.days : [...prev.days, today].slice(-MAX_RECALL_DAYS),
            queryKinds: prev.queryKinds.includes(kind) ? prev.queryKinds : [...prev.queryKinds, kind],
            title: hit.title || prev.title,
        };
    }
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(signal), 'utf8');
        fs.renameSync(tmp, file);
    }
    catch {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch { /* 连清理都失败就只能算了 */ }
    }
}
/**
 * 一次工具调用内复用同一份索引：`memoryCapacity` 的排序比较器会反复调 `lastRecallOf`，
 * 每次重建全量 lookup 会让 10k sidecar 退化到秒级。signal 只读不写（写只在 bumpRecall 的独立副本里），
 * 所以用 WeakMap 按对象缓存，readRecallSignal 每次返回新对象，不会跨调用拿到过期索引。
 */
const lookupCache = new WeakMap();
/** 同一次调用里排序比较器会把同一条目反复比较，结果按 (signal, entry) 缓存 */
const resultCache = new WeakMap();
function recallLookup(signal) {
    const cached = lookupCache.get(signal);
    if (cached)
        return cached;
    const lookup = new Map();
    for (const [p, e] of Object.entries(signal.byPath)) {
        const stem = p.replace(/\.[^./]+$/, '');
        for (const key of [p, stem, e.title]) {
            if (key && e.last > (lookup.get(key) ?? ''))
                lookup.set(key, e.last);
        }
    }
    lookupCache.set(signal, lookup);
    return lookup;
}
/**
 * MEMORY 条目 → 最近召回日期。sidecar 的 path / stem / title 都建成键，
 * 所以标题式 `[[标题]]` 与路径式 `[[notes/x]]` 都能关联上（纯 JS、不跑 zk）。
 * signal 只读、entry 是字符串，结果确定 —— 一次调用内按 entry 缓存，避免排序比较器重复解析。
 */
export function lastRecallOf(signal, entry) {
    if (!hasRecallSignal(signal))
        return '';
    let results = resultCache.get(signal);
    if (!results) {
        results = new Map();
        resultCache.set(signal, results);
    }
    const cached = results.get(entry);
    if (cached !== undefined)
        return cached;
    const lookup = recallLookup(signal);
    let best = '';
    for (const m of String(entry).matchAll(WIKI_LINK)) {
        const target = String(m[1] ?? '').trim();
        const hit = lookup.get(target) ?? lookup.get(target.replace(/\.[^./]+$/, ''));
        if (hit && hit > best)
            best = hit;
    }
    results.set(entry, best);
    return best;
}
