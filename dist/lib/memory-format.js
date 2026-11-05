/**
 * 记忆条目的格式口径（唯一一份）：memory / dream / lint 都从这里取，
 * 免得「什么算退役」「哪一天算日期」三处各写一遍、下次改措辞只改到一半。
 *
 * 只做机械解析，不做语义判断：
 *   · 条目 = 顶层列表项 + 它的缩进续行（与 MEMORY.md 的书写约定一致）；
 *   · 退役 = 首行 `- [superseded …]`（大小写不敏感）；
 *   · 日期 = 首行里的 `YYYY-MM-DD`，且必须是真实存在的日期（`2026-99-99` 不算）。
 */
/** 顶层列表项；缩进的子项算续行，不另起一条 */
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/;
/** 退役条目：`- [superseded 2026-01-01] 旧结论 → [[新结论]]`。必须带 `i`，与 lint 同口径 */
const RETIRED = /^\s*(?:[-*+]|\d+[.)])\s+\[superseded\b/i;
/** 行级口径（记忆页徽标用）；与 RETIRED 同一份 */
export const RETIRED_ENTRY_RE = RETIRED;
/** 只认能机械解析的日期：`YYYY-MM-DD` 且真校验（不是正则通过就算） */
const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
function validDate(y, m, d) {
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    const at = new Date(year, month - 1, day);
    return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day;
}
function firstLine(entry) {
    return entry.split('\n', 1)[0] ?? '';
}
/** 列表条目（含缩进续行）。没有列表项的散文不算条目 —— 那是截断按段落处理的事 */
export function splitMemoryEntries(body) {
    const out = [];
    let current = null;
    const flush = () => {
        if (current)
            out.push(current.join('\n'));
        current = null;
    };
    for (const line of String(body ?? '').split('\n')) {
        if (LIST_ITEM.test(line)) {
            flush();
            current = [line];
        }
        else if (current && /^\s+\S/.test(line)) {
            current.push(line);
        }
        else {
            flush();
        }
    }
    flush();
    return out;
}
/** true = 条目首行是 `[superseded …]`（大小写不敏感，必须带 i） */
export function isRetiredEntry(entry) {
    return RETIRED.test(firstLine(entry));
}
/** 条目首行里的日期；没有或不合法返回 null（`2026-99-99` 不猜成 12 月） */
export function entryDate(entry) {
    const m = DATE.exec(firstLine(entry));
    if (!m)
        return null;
    return validDate(m[1], m[2], m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/**
 * 条目里的双链来源；只看写没写，链接是否真存在是 lint 的事。
 * 目标是「非空白」：`[[   ]]` 不算来源（lint 的 `WIKI_LINK` 也把空目标当没链接），
 * `[[目标|别名]]` / `[[目标#小节]]` 算。
 */
const LINK = /\[\[[^\]\n]*\S[^\]\n]*\]\]/;
/**
 * 数一遍格式债：只机械计数，不猜日期、不补来源 —— 两者仍由人和 agent 写。
 * 注入与记忆页只负责把缺口摆出来，否则「按日期淘汰」对没日期的老库永远空转。
 * 退役条目不算：它们按约定退役，不该因为格式被继续提醒。
 */
export function memoryFormatDebt(body) {
    const entries = splitMemoryEntries(body).filter((entry) => !isRetiredEntry(entry));
    let undated = 0;
    let unlinked = 0;
    for (const entry of entries) {
        if (!entryDate(entry))
            undated += 1;
        if (!LINK.test(entry))
            unlinked += 1;
    }
    return { total: entries.length, undated, unlinked };
}
/**
 * 去掉退役条目（整条，不留半行），返回正文与删掉的条数。
 * 磁盘上的文件不动 —— 省略只发生在注入路径上；记忆页 / git 仍看得到它们。
 */
export function stripRetiredEntries(body) {
    const out = [];
    let count = 0;
    let skipping = false;
    for (const line of String(body ?? '').split('\n')) {
        if (LIST_ITEM.test(line)) {
            skipping = RETIRED.test(line);
            if (skipping) {
                count += 1;
                continue;
            }
            out.push(line);
            continue;
        }
        if (skipping) {
            // 续行与紧随的空行跟着整条一起走：删条不留空洞
            if (!line.trim() || /^\s+\S/.test(line))
                continue;
            skipping = false;
        }
        out.push(line);
    }
    return { body: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), count };
}
/**
 * 距某天几个本地日历天（不是毫秒差 / 86400000 再取整 —— 夏时制会算出 6.958 天）。
 * 日期不合法返回 null；未来日期返回负数（调用方自己决定怎么报）。
 */
export function daysSinceDate(date, now = new Date()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
    if (!m || !validDate(m[1], m[2], m[3]))
        return null;
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today.getTime() - at.getTime()) / 86_400_000);
}
