/**
 * 场景投影：把事件日志 + 规则算成一行「此刻」文本，按 `sceneBudgetWords` 裁。
 *
 * 设计要点（D7）：
 *   · 场景**不进** memory payload：独立投影、独立缓存、独立预算；合并总量只在
 *     `zk_context` / `doctor` / 记忆页 / 设置页算（combinedWords），超了只对人告警；
 *   · 规则算得出但展示层只认固定几个变量（energy / mood / satiety / location / goal），
 *     其余变量不注入 —— 别把规则文件当 prompt 模板；
 *   · **没有 logs = 不注入**；只有窗口外事件时仍注入长尾（`hoursSince` 走 tombstone）；
 *   · 规则编译 / 求值失败 → 整份回退内置默认并记 `rulesError`；连默认都失败才返回空串。
 *     状态层坏掉不能把整个系统提示拖下水，也不能让场景无声消失。
 */
import fs from 'node:fs';
import { fileStamp } from './file-stamp.js';
import { countWords } from './memory.js';
import { eventsPathOf, humanAge, readStateLog, rulesPathOf } from './state-log.js';
import { DEFAULT_RULES, RulesCompileError, compileDefaultRules, compileRules } from './state-rules.js';
/** 读 `.state/rules`；缺文件 = 内置默认，解析失败 = 回退默认。两者都不抛。 */
export function loadRules(cfg) {
    const file = rulesPathOf(cfg);
    let source = '';
    try {
        source = fs.readFileSync(file, 'utf8');
    }
    catch {
        const defaults = compileDefaultRules();
        return { rules: defaults, source: 'default', label: 'default' };
    }
    try {
        const compiled = compileRules(source);
        if (!compiled) {
            const defaults = compileDefaultRules();
            return { rules: defaults, source: 'default', label: 'default' };
        }
        return { rules: compiled, source: 'file', label: `v${compiled.version}` };
    }
    catch (err) {
        const message = err instanceof RulesCompileError
            ? err.errors.map((e) => `第 ${e.line} 行第 ${e.col} 列：${e.message}`).join('；')
            : err instanceof Error ? err.message : String(err);
        return { rules: compileDefaultRules(), source: 'fallback', label: 'default(fallback)', error: message };
    }
}
const SCENE_PREFIX = '当下：';
const SEP = ' · ';
/** 时间点 → 人话（脚注用；只接受毫秒） */
function ago(now, atMs) {
    return humanAge((now - atMs) / 3600_000);
}
function presenceOf(log, now, staleHours) {
    const left = log.lastSeen.get('user_left');
    const returned = log.lastSeen.get('user_returned');
    // ① 两个事件都没有 → 未知：不能因为「没记录」就默认在场，否则只记 ate 的日志永远显示在场
    if (!left && !returned)
        return { presence: 'unknown', note: '' };
    const latest = left && returned ? (left.atMs >= returned.atMs ? left : returned) : (left ?? returned);
    const latestWasLeft = !returned || (!!left && left.atMs >= returned.atMs);
    // ② 最新一条太旧 → 未知（而不是把 40 天前的「离开」当成仍不在）
    if (now - latest.atMs > staleHours * 3600_000) {
        return { presence: 'unknown', note: `用户状态未知（最后${latestWasLeft ? '离开' : '回来'} · ${ago(now, latest.atMs)}）` };
    }
    // ③ 有 left 无 returned（或 left 更晚）→ 不在
    if (left && (!returned || left.atMs > returned.atMs)) {
        return { presence: 'absent', note: `用户不在（离开 · ${ago(now, left.atMs)}）` };
    }
    // ④ 否则在场
    return { presence: 'present', note: returned ? `用户在场（回来 · ${ago(now, returned.atMs)}）` : '' };
}
/** 规则给 null 时补「最后 X · N 天前」：值来自 last-seen，但**由投影层**给，渲染层不回读日志 */
function lastNote(log, now, event, key, label) {
    const last = log.lastSeen.get(event);
    if (!last || !(key in last.params))
        return `${label}未知`;
    const value = String(last.params[key] ?? '').trim();
    if (!value)
        return `${label}未知`;
    return `${label}未知（最后 ${value} · ${ago(now, last.atMs)}）`;
}
const numText = (value) => (typeof value === 'number' ? String(Math.round(value)) : null);
const strText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
/** 纯投影：不读配置、不读文件，只吃 logs + rules + now */
export function projectScene(log, rules, now, opts) {
    const empty = {
        present: false, presence: 'unknown', events: log.events.length, words: 0, text: '',
        values: {}, dropped: [], emptyReason: 'no-log',
    };
    // lastSeen 为空 = 这一刻之前没有任何事件（重放到第一条事件之前也走这里），不是「规则没算出值」
    if (!log.exists || log.total === 0 || log.lastSeen.size === 0)
        return empty;
    const ctx = {
        now,
        lastSeen: log.lastSeen,
        events: log.events,
        sceneWindowDays: opts.sceneWindowDays,
        staleHours: opts.staleHours,
    };
    const values = rules.evaluate(ctx);
    const presence = presenceOf(log, now, opts.staleHours);
    // 展示顺序 = 裁剪优先级（后面的先被丢）：energy / mood 先留，地点 / 目标后留
    const parts = [];
    const energy = numText(values.energy ?? null);
    if (energy)
        parts.push(`energy ${energy}`);
    const mood = strText(values.mood ?? null);
    if (mood)
        parts.push(`mood ${mood}`);
    const satiety = numText(values.satiety ?? null);
    if (satiety)
        parts.push(`satiety ${satiety}`);
    if (presence.note && presence.presence !== 'present')
        parts.push(presence.note);
    const woke = log.lastSeen.get('woke');
    if (woke && (now - woke.atMs) / 3600_000 > opts.staleHours)
        parts.push(`最近醒来 ${ago(now, woke.atMs)}`);
    const location = strText(values.location ?? null);
    if (location)
        parts.push(`地点 ${location}`);
    else if (log.lastSeen.has('at'))
        parts.push(lastNote(log, now, 'at', 'place', '地点'));
    const goal = strText(values.goal ?? null);
    if (goal)
        parts.push(`目标 ${goal}`);
    else if (log.lastSeen.has('set_goal'))
        parts.push(lastNote(log, now, 'set_goal', 'text', '目标'));
    if (presence.presence === 'present' && presence.note)
        parts.push(presence.note);
    // 预算：从尾部丢，直到放得下；一个都放不下就返回空串（不注入半行）
    const dropped = [];
    let keep = parts.slice();
    const textOf = (list) => list.length ? SCENE_PREFIX + list.join(SEP) : '';
    while (keep.length > 0 && countWords(textOf(keep)) > opts.budgetWords)
        dropped.unshift(keep.pop());
    const text = textOf(keep);
    return {
        present: text.length > 0,
        presence: presence.presence,
        events: log.events.length,
        words: countWords(text),
        text,
        values,
        dropped,
        emptyReason: text.length > 0 ? '' : parts.length > 0 ? 'budget' : 'rules',
    };
}
/** 缓存：日志 / 规则文件变了才重算；没有变化时连续 step 只付一次读盘 */
const SCENE_CACHE_MAX = 8;
const cache = new Map();
function cacheKey(cfg, now) {
    const minute = Math.floor(now / 60_000);
    return [
        cfg.notebook,
        fileStamp(eventsPathOf(cfg)),
        fileStamp(rulesPathOf(cfg)),
        cfg.sceneBudgetWords,
        cfg.sceneWindowDays,
        cfg.staleHours,
        minute,
    ].join('|');
}
/**
 * 读盘 + 投影 + 缓存。异常一律返回空场景（不抛）：状态层是可选的，
 * 坏掉时整个系统提示必须照常装配。
 *
 * 求值期错误（除零 / count 越界 / null 进算术）按 D7 整份回退内置默认，
 * 而不是让场景整段消失 —— 「规则算错了」和「没有日志」不是一回事。
 */
export function buildScene(cfg, opts = {}) {
    const now = opts.now ?? Date.now();
    const key = cacheKey(cfg, now);
    const hit = cache.get(key);
    if (hit)
        return hit;
    const empty = {
        present: false, presence: 'unknown', events: 0, rulesVersion: 'default', words: 0, text: '',
        values: {}, dropped: [], emptyReason: 'no-log',
    };
    let result = empty;
    try {
        const log = readStateLog(cfg, { windowDays: cfg.sceneWindowDays, now });
        if (log.readError) {
            // 文件在、但读不出来：这不是「未启用」，空场景必须带上原因
            result = { ...empty, rulesError: log.readError, emptyReason: 'error' };
        }
        else if (!log.exists || log.total === 0) {
            result = empty;
        }
        else {
            const optsFor = { staleHours: cfg.staleHours, sceneWindowDays: cfg.sceneWindowDays, budgetWords: cfg.sceneBudgetWords };
            const loaded = loadRules(cfg);
            try {
                const projected = projectScene(log, loaded.rules, now, optsFor);
                result = { ...projected, rulesVersion: loaded.label, ...(loaded.error ? { rulesError: loaded.error } : {}) };
            }
            catch (err) {
                // 求值失败：整份规则拒绝，换内置默认重算（编译失败已在 loadRules 里回退过）
                const message = err instanceof Error ? err.message : String(err);
                const projected = projectScene(log, compileDefaultRules(), now, optsFor);
                result = { ...projected, rulesVersion: 'default(fallback)', rulesError: message };
            }
        }
    }
    catch (err) {
        result = {
            ...empty,
            rulesVersion: 'default(fallback)',
            rulesError: err instanceof Error ? err.message : String(err),
            emptyReason: 'error',
        };
    }
    if (cache.size >= SCENE_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined)
            cache.delete(oldest);
    }
    cache.set(key, result);
    return result;
}
/** 合并总账：记忆载荷（含框与提示）+ 场景行。别把它叫「总 prompt」——宿主自己的系统提示不在里面。 */
export function combinedWords(memoryTotalWords, scene) {
    return memoryTotalWords + scene.words;
}
/**
 * 合并预算的超限提示；没超返回空串。
 *
 * 只给人看（zk_context 的回复文本 / doctor / 记忆页 / 设置页），**不写进系统提示**：
 * 那句话每轮都要花词，而模型并不需要这个数字 —— 预算诊断是人的工作面（D4）。
 */
export function combinedBudgetNote(memoryTotalWords, scene, budget) {
    const total = combinedWords(memoryTotalWords, scene);
    if (!(budget > 0) || total <= budget)
        return '';
    return `合并预算 ${budget} 词：记忆载荷 ${memoryTotalWords} + 场景 ${scene.words} = ${total}，超出 ${total - budget}`;
}
/** 只读规则文本的原始内容（人用 CLI / 记忆页展示；模型侧不给入口） */
export function readRulesText(cfg) {
    try {
        return fs.readFileSync(rulesPathOf(cfg), 'utf8');
    }
    catch {
        return '';
    }
}
/** 内置默认规则的原文（缺失时展示「将用这套」） */
export const DEFAULT_RULES_TEXT = DEFAULT_RULES;
