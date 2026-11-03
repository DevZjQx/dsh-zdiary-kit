/**
 * 运行状态日志：一行一条事件，追加写；状态是日志的投影（见 docs/plan-persona-contract.md D7）。
 *
 * 为什么是事件不是快照：
 *   · 模型擅长记「发生了什么」，不擅长算「所以数值是几」——数值一律由投影算，跨轮不漂移；
 *   · 同一份日志换一套规则可以重新解释过去（人用 `zk-kit state show --at`），历史一条不丢；
 *   · 惰性衰减：不跑定时器，读的时候用 `now - 事件时间` 现算。
 *
 * 格式（固定行式，不是自由文本）：
 *
 *   # zdiary-state v1
 *   2026-11-04T07:10:00+08:00 woke hours=7.5
 *   2026-11-04T07:20:00+08:00 set_goal text="写完 D7"
 *
 * 首行是**日志格式**版本（与 `.state/rules` 的 `version` 无关，互不校验）。
 * 时间戳必须带 `Z` 或 `±HH:MM`：没有时区的行按坏行处理——同一个库可能被带到别的时区，
 * 本地时间会被静默解释错。事件名 / 参数名只认小写，便于规则里当裸词读。
 *
 * 只碰 `<notebook>/.state/`：不进 zk 索引 / FTS / 标签 / 双链 / RSS（见 lib/zk.ts 的 excludedNames）。
 * 读不存在的文件 = 没有日志，不报错；坏行跳过并计数，不让整段投影失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from './lock.js';
export const STATE_DIR = '.state';
export const EVENTS_FILE = 'events.log';
export const RULES_FILE = 'rules';
export const STATE_HEADER = '# zdiary-state v1';
/** 单行上限：超了就是拼错了，不是正常事件 */
export const MAX_LINE_BYTES = 512;
/** 一条事件最多几个参数 */
export const MAX_PARAMS = 8;
/** 回填时间最多允许多晚（容忍时钟漂移） */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,15}$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export class StateError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.name = 'StateError';
        this.hint = hint;
    }
}
export const stateDirOf = (cfg) => path.join(cfg.notebook, STATE_DIR);
export const eventsPathOf = (cfg) => path.join(stateDirOf(cfg), EVENTS_FILE);
export const rulesPathOf = (cfg) => path.join(stateDirOf(cfg), RULES_FILE);
/** 控制字符会破坏「一行一条事件」的格式，写入口一律拒绝 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
function assertSingleLine(value, what) {
    if (CONTROL_RE.test(value))
        throw new StateError(`${what}里不能有换行 / 控制字符`, '一条事件必须是一行；确实要分行就记两条');
    return value;
}
/** 值里有没有需要加引号的东西：空白、等号、引号、反斜杠、空串 */
function needsQuote(value) {
    return value === '' || /[\s="\\]/.test(value);
}
/** 参数值写成一行内的字面量：能裸就裸（数字 / 无空格词），否则加引号 */
export function formatValue(value) {
    if (!needsQuote(value))
        return value;
    return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
/**
 * 插件自己写的表头。压实会把它重写成规范形式；人写的 `# ...` 一行都不丢 ——
 * 所以这里必须匹配整行，不能写成 `\b` 前缀，否则「# zdiary-state 的坑：…」会被当成表头删掉。
 */
const STATE_HEADER_RE = /^#\s*zdiary-state\s+v\d+$/;
/** 一条事件 → 行文本（不含换行）；调用方负责先校验 */
export function formatEvent(at, name, params = {}) {
    const parts = [at, name];
    for (const [key, value] of Object.entries(params))
        parts.push(`${key}=${formatValue(value)}`);
    return parts.join(' ');
}
/** 解析右侧参数串；返回 null = 语法问题 */
function parseParams(rest) {
    const params = {};
    let i = 0;
    let count = 0;
    while (i < rest.length) {
        while (i < rest.length && /\s/.test(rest[i]))
            i++;
        if (i >= rest.length)
            break;
        const keyStart = i;
        while (i < rest.length && /[a-z0-9_]/.test(rest[i]))
            i++;
        const key = rest.slice(keyStart, i);
        if (!PARAM_KEY_RE.test(key))
            return { params, error: `参数名不合法：${key || '（空）'}` };
        if (i >= rest.length || rest[i] !== '=')
            return { params, error: `参数 ${key} 后面缺 =` };
        i++;
        let value;
        if (rest[i] === '"') {
            i++;
            let buf = '';
            let closed = false;
            while (i < rest.length) {
                const ch = rest[i];
                if (ch === '\\') {
                    const next = rest[i + 1];
                    if (next !== '"' && next !== '\\')
                        return { params, error: `字符串里的转义只认 \\" 和 \\\\：${key}` };
                    buf += next;
                    i += 2;
                    continue;
                }
                if (ch === '"') {
                    i++;
                    closed = true;
                    break;
                }
                buf += ch;
                i++;
            }
            if (!closed)
                return { params, error: `字符串没有闭合：${key}` };
            value = buf;
        }
        else {
            const start = i;
            while (i < rest.length && !/\s/.test(rest[i]))
                i++;
            value = rest.slice(start, i);
            if (!value)
                return { params, error: `参数 ${key} 没有值` };
            // 裸值不许再带引号：`key="a"` 走上面那条，粘在一起说明写法错了
            if (/["=]/.test(value))
                return { params, error: `参数 ${key} 的裸值里有引号或等号` };
        }
        if (key in params)
            return { params, error: `参数重复：${key}` };
        params[key] = value;
        count++;
        if (count > MAX_PARAMS)
            return { params, error: `参数超过 ${MAX_PARAMS} 个` };
    }
    return { params };
}
/** 一行 → 事件；不认识的行返回 reason（调用方决定跳过还是报错） */
export function parseEventLine(raw) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim())
        return { ok: false, reason: '空行' };
    if (line.startsWith('#'))
        return { ok: false, reason: '注释' };
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)
        return { ok: false, reason: `超过 ${MAX_LINE_BYTES} 字节` };
    const firstSpace = line.indexOf(' ');
    if (firstSpace < 0)
        return { ok: false, reason: '缺事件名' };
    const at = line.slice(0, firstSpace);
    if (!STAMP_RE.test(at))
        return { ok: false, reason: '时间戳必须带时区（Z 或 ±HH:MM）' };
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs))
        return { ok: false, reason: `时间戳解析不了：${at}` };
    const rest = line.slice(firstSpace + 1);
    const nameMatch = /^([a-z][a-z0-9_]{0,31})(?:\s+(.*))?$/.exec(rest);
    if (!nameMatch)
        return { ok: false, reason: '事件名不合法（小写字母开头，[a-z0-9_]，≤32）' };
    const name = nameMatch[1];
    const tail = nameMatch[2] ?? '';
    const parsed = parseParams(tail);
    if (parsed.error)
        return { ok: false, reason: parsed.error };
    return { ok: true, event: { at, atMs, name, params: parsed.params } };
}
/** 校验一条要写入的事件；不合法就抛（写入口比读取口更严：坏事件不该落盘） */
function validateInput(input, now) {
    const name = String(input.name ?? '').trim();
    if (!EVENT_NAME_RE.test(name))
        throw new StateError(`事件名不合法：${name || '（空）'}`, '小写字母开头，只含 [a-z0-9_]，最长 32');
    const params = input.params ?? {};
    const clean = {};
    let count = 0;
    for (const [key, value] of Object.entries(params)) {
        if (!PARAM_KEY_RE.test(key))
            throw new StateError(`参数名不合法：${key}`, '小写字母开头，只含 [a-z0-9_]，最长 16');
        if (key in clean)
            throw new StateError(`参数重复：${key}`);
        clean[key] = assertSingleLine(String(value ?? ''), `参数 ${key} 的值`);
        count++;
        if (count > MAX_PARAMS)
            throw new StateError(`参数最多 ${MAX_PARAMS} 个`);
    }
    const at = String(input.at ?? '').trim() || new Date(now).toISOString();
    if (!STAMP_RE.test(at))
        throw new StateError(`时间戳不合法：${at}`, '必须带时区，例如 2026-11-04T07:10:00+08:00');
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs))
        throw new StateError(`时间戳解析不了：${at}`);
    if (atMs > now + FUTURE_TOLERANCE_MS)
        throw new StateError('不能写未来的时间（最多容忍 5 分钟时钟漂移）');
    const line = formatEvent(at, name, clean);
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)
        throw new StateError(`一行最多 ${MAX_LINE_BYTES} 字节，现在 ${Buffer.byteLength(line, 'utf8')}`, '拆成两条事件，或缩短字符串参数');
    return { at, atMs, name, params: clean };
}
/**
 * 只校验、不写盘。给「先校验再建库」的调用方用：一次写错的事件不该在磁盘上留下副作用。
 * 抛出的错误与 `appendEvent` 完全同源（同一份 validateInput），不会有两套口径。
 */
export function checkAppendInput(input, now = Date.now()) {
    validateInput(input, now);
}
/**
 * 追加一条事件。
 *
 * 并发：整段持 `.state/.lock`，再用 `a`（O_APPEND）写一行 —— 两个进程同时进来不会互相覆盖，
 * 也不会像「读全文 → 改 → 写回」那样丢事件。文件不存在时先写表头。
 */
export function appendEvent(cfg, input, now = Date.now()) {
    const checked = validateInput(input, now);
    const file = eventsPathOf(cfg);
    const dir = stateDirOf(cfg);
    fs.mkdirSync(dir, { recursive: true });
    withFileLockSync(path.join(dir, '.lock'), () => {
        if (!fs.existsSync(file))
            fs.writeFileSync(file, STATE_HEADER + '\n', 'utf8');
        fs.appendFileSync(file, formatEvent(checked.at, checked.name, checked.params) + '\n', 'utf8');
    });
    return { at: checked.at, name: checked.name, params: checked.params, line: formatEvent(checked.at, checked.name, checked.params) };
}
/** 读到的事件按时间排序；同一毫秒按文件顺序（后写的算更新） */
function sortEvents(events) {
    return events.slice().sort((a, b) => a.atMs - b.atMs);
}
/**
 * 读日志。
 *
 * 三个口径：
 *   · `events` 只含窗口内（`count` / 最近几条用）；
 *   · `lastSeen` 是**每个事件名的最后一条**，含窗口外 —— 只读窗口的话，
 *     40 天前的 `woke` 会让 `hoursSince` 变成 null，「从不自愈」直接坏掉；
 *   · 两者都以 `now` 为上界：`now` 是「看哪一刻」的参数（`state show --at` 重放），
 *     之后才发生的事件不能算进来 —— 否则小时数是负的，衰减会倒着走。
 * `total` / `lines` / `badLines` 始终描述文件本身，不随时点变化。
 */
export function readStateLog(cfg, opts = {}) {
    const now = opts.now ?? Date.now();
    const windowDays = Math.max(1, Math.trunc(opts.windowDays ?? 30));
    const file = eventsPathOf(cfg);
    let text = '';
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        // ENOENT = 真没启用；其余（EACCES / EISDIR / EIO）是文件坏了，不能当成「没有日志」
        const code = err.code;
        const readError = code === 'ENOENT' ? undefined : err instanceof Error ? err.message : String(err);
        return {
            exists: false, events: [], lastSeen: new Map(), total: 0, lines: 0, badLines: [], bytes: 0,
            ...(readError ? { readError } : {}),
        };
    }
    const rawLines = text.split('\n');
    const badLines = [];
    const all = [];
    for (const [index, raw] of rawLines.entries()) {
        if (!raw.trim() || raw.startsWith('#'))
            continue;
        const parsed = parseEventLine(raw);
        if (parsed.ok)
            all.push(parsed.event);
        else
            badLines.push({ line: index + 1, text: raw.slice(0, 200), reason: parsed.reason });
    }
    const sorted = sortEvents(all);
    const past = sorted.filter((e) => e.atMs <= now);
    const cutoff = now - windowDays * 24 * 3600_000;
    const events = past.filter((e) => e.atMs >= cutoff);
    const lastSeen = new Map();
    for (const event of past)
        lastSeen.set(event.name, event);
    return {
        exists: true,
        events,
        lastSeen,
        total: sorted.length,
        lines: rawLines.filter((line) => line.trim() !== '').length,
        badLines,
        bytes: Buffer.byteLength(text, 'utf8'),
    };
}
/**
 * 压实：保留表头 + 注释 + 窗口内全部事件 + 每个事件名**窗口外的最后一条**（tombstone）。
 *
 * tombstone 不是备份，是投影的输入：`hoursSince` 需要知道「发生过，但在很久以前」，
 * 否则窗口一过就等于「从未发生」，长尾叙事直接断掉。
 * 坏行丢掉并计入 `dropped`（它们对投影没有任何贡献）。
 *
 * 注释跟着它**后面那条事件**走：事件留下，注释就在原位留下；事件被压实掉，注释顺延到
 * 下一条保留的事件（没有就留在文件末尾）—— 压实的语义是「删旧事件」，不是「删人的批注」。
 * 只有插件自己写的表头（`# zdiary-state v<N>`）会被重写成一行。
 */
export function pruneStateLog(cfg, opts) {
    const now = opts.now ?? Date.now();
    const windowDays = Math.max(1, Math.trunc(opts.windowDays ?? 30));
    const days = Math.trunc(opts.days);
    if (!Number.isFinite(days) || days <= 0)
        throw new StateError('prune 的截止天数必须是正整数');
    if (days < windowDays && !opts.force) {
        throw new StateError(`prune 截止 ${days} 天小于投影窗口 ${windowDays} 天`, '窗口内的事件会被删掉、投影当场变化；确实要这样加 --force');
    }
    const file = eventsPathOf(cfg);
    if (!fs.existsSync(file))
        return { dropped: 0, kept: 0, windowDays };
    const dir = stateDirOf(cfg);
    let result = { dropped: 0, kept: 0, windowDays };
    withFileLockSync(path.join(dir, '.lock'), () => {
        // 直接读原文，不走 readStateLog：后者以 now 为上界（重放语义），
        // 压实要的是「文件里现在有什么」，未来几分钟的事件也必须留下。
        const rawLines = fs.readFileSync(file, 'utf8').split('\n');
        // 注释挂到它后面那条事件上：这样「事件留下 ⇒ 注释原位留下」是天然成立的
        const blocks = [];
        let pending = [];
        let bad = 0;
        for (const raw of rawLines) {
            const line = raw.replace(/\r$/, '');
            if (!line.trim())
                continue;
            if (line.startsWith('#')) {
                // 旧表头不跟着搬：写回去的永远只有一行规范表头；人的注释（含以 zdiary-state 开头的）留着
                if (!STATE_HEADER_RE.test(line.trim()))
                    pending.push(line);
                continue;
            }
            const parsed = parseEventLine(line);
            if (!parsed.ok) {
                bad++;
                continue;
            }
            blocks.push({ comments: pending, event: parsed.event });
            pending = [];
        }
        // 文件末尾没有事件可挂的注释：原样留在末尾
        const trailing = pending;
        const cutoff = now - days * 24 * 3600_000;
        const keep = new Set();
        for (const block of blocks)
            if (block.event.atMs >= cutoff)
                keep.add(block.event);
        // 窗口外每个事件名各留最后一条（按时间倒序扫，先撞上的就是最新的）
        const seen = new Set();
        for (const event of sortEvents(blocks.filter((b) => b.event.atMs < cutoff).map((b) => b.event)).reverse()) {
            if (seen.has(event.name))
                continue;
            seen.add(event.name);
            keep.add(event);
        }
        // 被压实掉的事件先把它的注释攒着，等下一条留下的事件再把注释带上去（注释一行不丢）
        const keptBlocks = [];
        const carry = [];
        for (const block of blocks) {
            if (!keep.has(block.event)) {
                carry.push(...block.comments);
                continue;
            }
            keptBlocks.push({ comments: [...carry, ...block.comments], event: block.event });
            carry.length = 0;
        }
        carry.push(...trailing);
        // 按时间写回去：人用 state log 看原文时，顺序也要是时间顺序（同毫秒保持文件顺序）
        keptBlocks.sort((a, b) => a.event.atMs - b.event.atMs);
        const lines = [STATE_HEADER];
        for (const block of keptBlocks) {
            lines.push(...block.comments, formatEvent(block.event.at, block.event.name, block.event.params));
        }
        lines.push(...carry);
        const kept = keptBlocks.length;
        const dropped = blocks.length - kept + bad;
        const body = lines.join('\n') + '\n';
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, body, 'utf8');
        fs.renameSync(tmp, file);
        result = { dropped, kept, windowDays };
    });
    return result;
}
/** 一段时间 → 人话：48 小时内说小时，再长说天 */
export function humanAge(hours) {
    if (!Number.isFinite(hours))
        return '未知';
    if (hours < 1)
        return '刚刚';
    if (hours < 48)
        return `${Math.round(hours)} 小时前`;
    return `${Math.round(hours / 24)} 天前`;
}
