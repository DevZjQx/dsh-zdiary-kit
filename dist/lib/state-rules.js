/**
 * `.state/rules` 的规则 DSL（包 1：严格）。
 *
 * 规则是**数据**，不是代码：一行一条 `变量 = 表达式`，自上而下求值，只能引用前面已定义的变量。
 * 宿主只提供白名单函数，不做 eval —— 人在文件里写公式，模型无权改规则（D7）。
 *
 * 为什么严格：
 *   · 拼错变量名必须报错，不能静默当字符串 —— 否则一条 `energi = ...` 会让整段场景消失，
 *     而人只会以为「状态没生效」；
 *   · 任何解析 / 类型 / 求值错误 = **整份规则拒绝**，回退内置默认并告警；
 *     半套规则比没有规则更难排查。
 *
 * 两套语法别混：事件日志里参数值可以是裸词（`at place=书房`），规则里字符串**必须加引号**
 * （`if(energy < 20, "力竭", "正常")`）——裸的中文在表达式里会被当成未定义变量。
 *
 * 版本号：`version` 是**规则内容**版本（只用于审计），与日志首行的 `# zdiary-state v1` 无关。
 */
export class RulesCompileError extends Error {
    errors;
    constructor(errors) {
        super(errors[0] ? formatRuleError(errors[0]) : '规则不合法');
        this.name = 'RulesCompileError';
        this.errors = errors;
    }
}
export function formatRuleError(error) {
    return `规则第 ${error.line} 行第 ${error.col} 列：${error.message}`;
}
const VAR_RE = /^[a-z][a-z0-9_]{0,15}$/;
const EVENT_RE = /^[a-z][a-z0-9_]{0,31}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,15}$/;
const RESERVED = new Set(['version', 'sceneWindowDays', 'staleHours']);
function lex(src, line) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        const col = i + 1;
        if (ch === '"') {
            let j = i + 1;
            let buf = '';
            let closed = false;
            while (j < src.length) {
                const c = src[j];
                if (c === '\\') {
                    const next = src[j + 1];
                    if (next !== '"' && next !== '\\')
                        throw new RulesCompileError([{ message: '字符串里的转义只认 \\" 和 \\\\', line, col: j + 1 }]);
                    buf += next;
                    j += 2;
                    continue;
                }
                if (c === '"') {
                    j++;
                    closed = true;
                    break;
                }
                buf += c;
                j++;
            }
            if (!closed)
                throw new RulesCompileError([{ message: '字符串没有闭合', line, col }]);
            toks.push({ t: 'str', v: buf, col });
            i = j;
            continue;
        }
        if (/[0-9]/.test(ch)) {
            let j = i;
            while (j < src.length && /[0-9]/.test(src[j]))
                j++;
            if (src[j] === '.') {
                j++;
                if (!/[0-9]/.test(src[j] ?? ''))
                    throw new RulesCompileError([{ message: '小数点后面缺数字', line, col }]);
                while (j < src.length && /[0-9]/.test(src[j]))
                    j++;
            }
            toks.push({ t: 'num', v: src.slice(i, j), col });
            i = j;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            let j = i;
            while (j < src.length && /[A-Za-z0-9_]/.test(src[j]))
                j++;
            toks.push({ t: 'id', v: src.slice(i, j), col });
            i = j;
            continue;
        }
        const two = src.slice(i, i + 2);
        if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
            toks.push({ t: 'op', v: two, col });
            i += 2;
            continue;
        }
        if ('+-*/'.includes(ch)) {
            toks.push({ t: 'op', v: ch, col });
            i++;
            continue;
        }
        if (ch === '<' || ch === '>') {
            toks.push({ t: 'op', v: ch, col });
            i++;
            continue;
        }
        if (ch === '(' || ch === ')' || ch === ',') {
            toks.push({ t: ch, v: ch, col });
            i++;
            continue;
        }
        throw new RulesCompileError([{ message: `不认识的字符：${ch}`, line, col }]);
    }
    return toks;
}
class Parser {
    index = 0;
    toks;
    line;
    constructor(toks, line) {
        this.toks = toks;
        this.line = line;
    }
    peek() { return this.toks[this.index]; }
    next() { return this.toks[this.index++]; }
    expect(type, value) {
        const tok = this.next();
        if (!tok || tok.t !== type || (value !== undefined && tok.v !== value)) {
            throw new RulesCompileError([{ message: `这里应该是 ${value ?? type}`, line: this.line, col: tok?.col ?? this.toks.length }]);
        }
        return tok;
    }
    parseAll() {
        const node = this.parseExpr();
        const rest = this.peek();
        if (rest)
            throw new RulesCompileError([{ message: `多余的字符：${rest.v}`, line: this.line, col: rest.col }]);
        return node;
    }
    parseExpr() {
        const left = this.parseAdd();
        const tok = this.peek();
        if (tok && tok.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(tok.v)) {
            this.next();
            const right = this.parseAdd();
            const after = this.peek();
            if (after && after.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(after.v)) {
                throw new RulesCompileError([{ message: '比较不能连写，拆成两个变量', line: this.line, col: after.col }]);
            }
            return { k: 'bin', op: tok.v, left, right, pos: { line: this.line, col: tok.col } };
        }
        return left;
    }
    parseAdd() {
        let node = this.parseMul();
        for (;;) {
            const tok = this.peek();
            if (!tok || tok.t !== 'op' || (tok.v !== '+' && tok.v !== '-'))
                return node;
            this.next();
            node = { k: 'bin', op: tok.v, left: node, right: this.parseMul(), pos: { line: this.line, col: tok.col } };
        }
    }
    parseMul() {
        let node = this.parseUnary();
        for (;;) {
            const tok = this.peek();
            if (!tok || tok.t !== 'op' || (tok.v !== '*' && tok.v !== '/'))
                return node;
            this.next();
            node = { k: 'bin', op: tok.v, left: node, right: this.parseUnary(), pos: { line: this.line, col: tok.col } };
        }
    }
    parseUnary() {
        const tok = this.peek();
        if (tok && tok.t === 'op' && tok.v === '-') {
            this.next();
            return { k: 'un', op: '-', expr: this.parseUnary(), pos: { line: this.line, col: tok.col } };
        }
        return this.parsePrimary();
    }
    parsePrimary() {
        const tok = this.next();
        if (!tok)
            throw new RulesCompileError([{ message: '表达式不完整', line: this.line, col: this.toks.length }]);
        if (tok.t === 'num')
            return { k: 'num', v: Number(tok.v) };
        if (tok.t === 'str')
            return { k: 'str', v: tok.v };
        if (tok.t === '(') {
            const inner = this.parseExpr();
            this.expect(')');
            return inner;
        }
        if (tok.t === 'id') {
            if (tok.v === 'null')
                return { k: 'null' };
            if (this.peek()?.t === '(') {
                this.next();
                const args = [];
                if (this.peek()?.t !== ')') {
                    for (;;) {
                        args.push(this.parseExpr());
                        if (this.peek()?.t === ',') {
                            this.next();
                            continue;
                        }
                        break;
                    }
                }
                this.expect(')');
                return { k: 'call', name: tok.v, args, pos: { line: this.line, col: tok.col } };
            }
            return { k: 'var', name: tok.v, pos: { line: this.line, col: tok.col } };
        }
        throw new RulesCompileError([{ message: `这里不该出现 ${tok.v}`, line: this.line, col: tok.col }]);
    }
}
/** 在顶层找赋值用的单个 `=`：引号里的不算，`==` `!=` `<=` `>=` 也不算 */
function splitAssignment(text, line) {
    let inString = false;
    let escape = false;
    let at = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch !== '=')
            continue;
        const prev = text[i - 1] ?? '';
        const next = text[i + 1] ?? '';
        if (next === '=' || prev === '=' || '<>!'.includes(prev))
            continue;
        if (at >= 0)
            throw new RulesCompileError([{ message: '一行里只能有一个赋值 =', line, col: i + 1 }]);
        at = i;
    }
    if (at < 0)
        throw new RulesCompileError([{ message: '缺赋值 =（形如 energy = clamp(...)）', line, col: 1 }]);
    return { left: text.slice(0, at).trim(), right: text.slice(at + 1).trim() };
}
const FUNCTION_ARITY = {
    clamp: [3, 3],
    min: [2, Number.POSITIVE_INFINITY],
    max: [2, Number.POSITIVE_INFINITY],
    abs: [1, 1],
    if: [3, 3],
    hoursSince: [1, 1],
    count: [1, 2],
    last: [2, 2],
    num: [1, 1],
    coalesce: [1, Number.POSITIVE_INFINITY],
    isNull: [1, 1],
};
/** 只读事件 / 参数的函数：第一个参数按裸词读，不当变量解析 */
const EVENT_ARG_FUNCS = new Set(['hoursSince', 'count', 'last']);
function checkEventName(node, line, what) {
    if (node.k !== 'var')
        throw new RulesCompileError([{ message: `${what}必须是裸事件名`, line, col: ('pos' in node ? node.pos.col : 1) }]);
    if (!EVENT_RE.test(node.name))
        throw new RulesCompileError([{ message: `事件名不合法：${node.name}`, line, col: node.pos.col }]);
}
function checkParamKey(node, line) {
    if (node.k !== 'var')
        throw new RulesCompileError([{ message: 'last 的第二个参数必须是裸参数名', line, col: ('pos' in node ? node.pos.col : 1) }]);
    if (!KEY_RE.test(node.name))
        throw new RulesCompileError([{ message: `参数名不合法：${node.name}`, line, col: node.pos.col }]);
}
function infer(node, env, line) {
    switch (node.k) {
        case 'num': return 'number';
        case 'str': return 'string';
        case 'null': return 'null';
        case 'un': {
            const t = infer(node.expr, env, line);
            if (t !== 'number')
                throw new RulesCompileError([{ message: `一元 - 只能用在数字上（这里是 ${t}）`, line, col: node.pos.col }]);
            return 'number';
        }
        case 'bin': {
            const left = infer(node.left, env, line);
            const right = infer(node.right, env, line);
            const comparison = ['<', '<=', '>', '>=', '==', '!='].includes(node.op);
            for (const t of [left, right]) {
                if (t !== 'number') {
                    throw new RulesCompileError([{
                            message: `${node.op} 只比较数字（这里是 ${t}）${t === 'string' ? '：字符串要加引号但不参与运算' : ''}`,
                            line,
                            col: node.pos.col,
                        }]);
                }
            }
            return comparison ? 'boolean' : 'number';
        }
        case 'var': {
            if (node.name === 'sceneWindowDays' || node.name === 'staleHours')
                return 'number';
            const t = env.get(node.name);
            if (!t)
                throw new RulesCompileError([{ message: `未定义变量：${node.name}`, line, col: node.pos.col }]);
            return t;
        }
        case 'call': {
            const arity = FUNCTION_ARITY[node.name];
            if (!arity)
                throw new RulesCompileError([{ message: `不认识的函数：${node.name}`, line, col: node.pos.col }]);
            const [min, max] = arity;
            if (node.args.length < min || node.args.length > max) {
                throw new RulesCompileError([{
                        message: `${node.name} 需要 ${min === max ? min : `${min}–${max}`} 个参数，给了 ${node.args.length}`,
                        line,
                        col: node.pos.col,
                    }]);
            }
            if (EVENT_ARG_FUNCS.has(node.name)) {
                checkEventName(node.args[0], line, `${node.name} 的第一个参数`);
                if (node.name === 'last')
                    checkParamKey(node.args[1], line);
                if (node.name === 'count' && node.args.length > 1) {
                    const days = node.args[1];
                    const t = infer(days, env, line);
                    if (t !== 'number')
                        throw new RulesCompileError([{ message: `count 的天数必须是数字（这里是 ${t}）`, line, col: node.pos.col }]);
                    if (days.k === 'num' && (!Number.isInteger(days.v) || days.v <= 0)) {
                        throw new RulesCompileError([{ message: 'count 的天数必须是正整数', line, col: node.pos.col }]);
                    }
                }
                return node.name === 'last' ? 'string' : 'number';
            }
            if (node.name === 'isNull') {
                infer(node.args[0], env, line);
                return 'boolean';
            }
            if (node.name === 'num') {
                const t = infer(node.args[0], env, line);
                if (t !== 'number' && t !== 'string' && t !== 'null') {
                    throw new RulesCompileError([{ message: `num 只接受字符串 / 数字 / null（这里是 ${t}）`, line, col: node.pos.col }]);
                }
                return 'number';
            }
            if (node.name === 'if') {
                const cond = infer(node.args[0], env, line);
                if (cond !== 'boolean')
                    throw new RulesCompileError([{ message: `if 的第一个参数必须是比较 / isNull（这里是 ${cond}）`, line, col: node.pos.col }]);
                return unify(infer(node.args[1], env, line), infer(node.args[2], env, line), line, node.pos);
            }
            if (node.name === 'coalesce') {
                let type = 'null';
                for (const arg of node.args)
                    type = unify(type, infer(arg, env, line), line, node.pos);
                return type;
            }
            for (const arg of node.args) {
                const t = infer(arg, env, line);
                if (t !== 'number')
                    throw new RulesCompileError([{ message: `${node.name} 只收数字（这里是 ${t}）`, line, col: node.pos.col }]);
            }
            if (node.name === 'clamp') {
                const [x, lo, hi] = node.args;
                if (lo.k === 'num' && hi.k === 'num' && lo.v > hi.v) {
                    throw new RulesCompileError([{ message: `clamp 的下限 ${lo.v} 大于上限 ${hi.v}`, line, col: node.pos.col }]);
                }
                void x;
            }
            return 'number';
        }
    }
}
function unify(a, b, line, pos) {
    if (a === 'null')
        return b;
    if (b === 'null')
        return a;
    if (a !== b)
        throw new RulesCompileError([{ message: `两边类型不一致：${a} 与 ${b}`, line, col: pos.col }]);
    return a;
}
function evalNode(node, env, ctx, line) {
    switch (node.k) {
        case 'num': return node.v;
        case 'str': return node.v;
        case 'null': return null;
        case 'un': {
            const value = evalNode(node.expr, env, ctx, line);
            if (typeof value !== 'number')
                throw runtime(line, node.pos.col, '一元 - 只能用在数字上');
            return -value;
        }
        case 'bin': {
            const left = evalNode(node.left, env, ctx, line);
            const right = evalNode(node.right, env, ctx, line);
            if (typeof left !== 'number' || typeof right !== 'number') {
                throw runtime(line, node.pos.col, `${node.op} 只比较数字；null 先用 isNull / coalesce 处理`);
            }
            switch (node.op) {
                case '+': return left + right;
                case '-': return left - right;
                case '*': return left * right;
                case '/':
                    if (right === 0)
                        throw runtime(line, node.pos.col, '除以零');
                    return left / right;
                case '<': return left < right ? 1 : 0;
                case '<=': return left <= right ? 1 : 0;
                case '>': return left > right ? 1 : 0;
                case '>=': return left >= right ? 1 : 0;
                case '==': return left === right ? 1 : 0;
                case '!=': return left !== right ? 1 : 0;
                default: throw runtime(line, node.pos.col, `不认识的运算符 ${node.op}`);
            }
        }
        case 'var': {
            if (node.name === 'sceneWindowDays')
                return ctx.sceneWindowDays;
            if (node.name === 'staleHours')
                return ctx.staleHours;
            if (!env.has(node.name))
                throw runtime(line, node.pos.col, `未定义变量：${node.name}`);
            return env.get(node.name);
        }
        case 'call': return evalCall(node, env, ctx, line);
    }
}
/** 布尔在内部用 1 / 0 表示（RuleValue 只有三种值，布尔不能落进变量） */
const asBool = (value, line, col) => {
    if (typeof value !== 'number')
        throw runtime(line, col, '条件必须是布尔值');
    return value !== 0;
};
function evalCall(node, env, ctx, line) {
    if (node.name === 'if') {
        const cond = evalNode(node.args[0], env, ctx, line);
        return asBool(cond, line, node.pos.col)
            ? evalNode(node.args[1], env, ctx, line)
            : evalNode(node.args[2], env, ctx, line);
    }
    if (node.name === 'isNull')
        return evalNode(node.args[0], env, ctx, line) === null ? 1 : 0;
    if (node.name === 'coalesce') {
        for (const arg of node.args) {
            const value = evalNode(arg, env, ctx, line);
            if (value !== null)
                return value;
        }
        return null;
    }
    if (node.name === 'hoursSince') {
        const name = node.args[0].name;
        const last = ctx.lastSeen.get(name);
        if (!last)
            return null;
        return (ctx.now - last.atMs) / 3600_000;
    }
    if (node.name === 'count') {
        const name = node.args[0].name;
        const days = node.args.length > 1 ? evalNode(node.args[1], env, ctx, line) : ctx.sceneWindowDays;
        if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0)
            throw runtime(line, node.pos.col, 'count 的天数必须是正整数');
        if (days > ctx.sceneWindowDays)
            throw runtime(line, node.pos.col, `count 的天数不能超过窗口 ${ctx.sceneWindowDays} 天`);
        const cutoff = ctx.now - days * 24 * 3600_000;
        return ctx.events.filter((e) => e.name === name && e.atMs >= cutoff).length;
    }
    if (node.name === 'last') {
        const name = node.args[0].name;
        const key = node.args[1].name;
        const last = ctx.lastSeen.get(name);
        return last && key in last.params ? last.params[key] : null;
    }
    if (node.name === 'num') {
        const value = evalNode(node.args[0], env, ctx, line);
        if (value === null)
            return null;
        if (typeof value === 'number')
            return value;
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : null;
    }
    const values = node.args.map((arg) => evalNode(arg, env, ctx, line));
    const nums = values.map((value) => {
        if (typeof value !== 'number')
            throw runtime(line, node.pos.col, `${node.name} 只收数字`);
        return value;
    });
    if (node.name === 'clamp') {
        const [x, lo, hi] = nums;
        if (lo > hi)
            throw runtime(line, node.pos.col, 'clamp 的下限大于上限');
        return Math.min(hi, Math.max(lo, x));
    }
    if (node.name === 'min')
        return Math.min(...nums);
    if (node.name === 'max')
        return Math.max(...nums);
    if (node.name === 'abs')
        return Math.abs(nums[0]);
    throw runtime(line, node.pos.col, `不认识的函数 ${node.name}`);
}
function runtime(line, col, message) {
    const err = new Error(formatRuleError({ message, line, col }));
    err.name = 'RulesRuntimeError';
    return err;
}
/**
 * 编译规则文本。空文本 / 只有注释 = 没有规则（调用方走内置默认），返回 null。
 * 任何错误都抛 RulesCompileError（带行号列号），调用方整份回退。
 */
export function compileRules(source) {
    const lines = String(source ?? '').split('\n');
    const assignments = [];
    let version = null;
    let sawAnything = false;
    for (const [index, raw] of lines.entries()) {
        const lineNo = index + 1;
        const text = raw.replace(/\r$/, '').trim();
        if (!text || text.startsWith('#'))
            continue;
        sawAnything = true;
        const { left, right } = splitAssignment(text, lineNo);
        if (version === null) {
            if (left !== 'version') {
                throw new RulesCompileError([{ message: '第一条非注释行必须是 version = <整数>', line: lineNo, col: 1 }]);
            }
            if (!/^\d+$/.test(right))
                throw new RulesCompileError([{ message: 'version 必须是正整数', line: lineNo, col: 1 }]);
            version = Number(right);
            continue;
        }
        if (!VAR_RE.test(left))
            throw new RulesCompileError([{ message: `变量名不合法：${left}`, line: lineNo, col: 1 }]);
        if (RESERVED.has(left))
            throw new RulesCompileError([{ message: `${left} 是保留名，不能当变量`, line: lineNo, col: 1 }]);
        if (assignments.some((a) => a.name === left))
            throw new RulesCompileError([{ message: `变量重复定义：${left}`, line: lineNo, col: 1 }]);
        if (!right)
            throw new RulesCompileError([{ message: `${left} 没有表达式`, line: lineNo, col: 1 }]);
        const node = new Parser(lex(right, lineNo), lineNo).parseAll();
        assignments.push({ name: left, expr: node, pos: { line: lineNo, col: 1 } });
    }
    if (!sawAnything)
        return null;
    if (version === null)
        throw new RulesCompileError([{ message: '缺 version = <整数>', line: 1, col: 1 }]);
    // 静态类型：自上而下，只能引用前面已定义的变量（没有前向引用，也就没有环）
    const env = new Map();
    for (const assignment of assignments) {
        const type = infer(assignment.expr, env, assignment.pos.line);
        if (type === 'boolean') {
            throw new RulesCompileError([{ message: `${assignment.name} 是布尔值，不能存进变量（用 1 / 0 或字符串）`, line: assignment.pos.line, col: 1 }]);
        }
        env.set(assignment.name, type);
    }
    return {
        version,
        vars: assignments.map((a) => a.name),
        evaluate(ctx) {
            const values = new Map();
            for (const assignment of assignments) {
                values.set(assignment.name, evalNode(assignment.expr, values, ctx, assignment.pos.line));
            }
            return Object.fromEntries(values);
        },
    };
}
/**
 * 内置默认规则（版本 3）。
 *
 * 曲线是**单调下降**的：醒得越久越累，不存在「熬夜回血」。恢复只能靠一条新的 `woke`，
 * 起点由 `woke hours=` 决定（睡 7 小时 = 70 分）；没有 `woke` 记录时 `energy` 是 null
 * ——「没记录」不等于「刚睡醒」。
 *
 * `satiety` 是饱腹度不是饥饿值：100 = 刚吃完，30 = 很久没吃。
 */
export const DEFAULT_RULES = `version = 3
awake = coalesce(hoursSince(woke), 0)
sleep_h = coalesce(num(last(woke, hours)), 7)
energy = if(isNull(hoursSince(woke)), null, clamp(70 + 4 * (sleep_h - 7) - 5 * awake, 20, 100))
mood = if(isNull(energy), null, if(energy < 20, "力竭", if(energy < 45, "疲惫", "正常")))
ate_all = coalesce(hoursSince(ate), 0)
satiety = if(isNull(hoursSince(ate)), 50, clamp(100 - 4 * ate_all, 30, 100))
at_h = coalesce(hoursSince(at), 0)
location = if(isNull(hoursSince(at)), null, if(at_h > staleHours, null, last(at, place)))
goal_h = coalesce(hoursSince(set_goal), 0)
goal = if(isNull(hoursSince(set_goal)), null, if(goal_h > staleHours, null, last(set_goal, text)))
`;
/** 内置默认规则编译一次就够；失败说明代码写错了，调用方按 fallback 处理 */
let defaultCompiled;
export function compileDefaultRules() {
    if (defaultCompiled === undefined)
        defaultCompiled = compileRules(DEFAULT_RULES);
    if (!defaultCompiled)
        throw new Error('内置默认规则为空');
    return defaultCompiled;
}
