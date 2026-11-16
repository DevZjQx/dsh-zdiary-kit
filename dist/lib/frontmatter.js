/**
 * 极简 frontmatter 编辑器：只认 `key: value` 标量行。
 *
 * 为什么自己写而不引 YAML 库：
 *   · 只需要改 `status` / `superseded-by` 这类标量，别的行（`tags: []`、`title: 带: 冒号`）必须原样保留；
 *   · 反序列化再序列化会把用户的注释、引号风格、字段顺序全部重排，一次 supersede 就变成全文件 diff。
 * 所以这里只做「按行替换 / 追加」，没见过的语法一律不碰。
 */
const DELIM = /^---[ \t]*$/;
const KEY_LINE = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/;
/** 解析头部 frontmatter；没有就是空对象（body 为原文） */
export function parseFrontmatter(content) {
    const text = String(content ?? '');
    const lines = text.split('\n');
    if (!DELIM.test(lines[0] ?? ''))
        return { fields: {}, body: text };
    const end = lines.findIndex((line, i) => i > 0 && DELIM.test(line));
    if (end < 0)
        return { fields: {}, body: text };
    const fields = {};
    for (const line of lines.slice(1, end)) {
        const m = line.match(KEY_LINE);
        if (m)
            fields[m[1]] = stripQuotes(m[2]);
    }
    return { fields, body: lines.slice(end + 1).join('\n') };
}
function stripQuotes(raw) {
    const v = raw.trim();
    // 双引号走 JSON：这样 \" 与 \n 这类转义读回来才是原字符，而不是带反斜杠的字面量
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        try {
            return String(JSON.parse(v));
        }
        catch {
            return v.slice(1, -1);
        }
    }
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
        return v.slice(1, -1);
    return v;
}
/**
 * 设置若干标量字段：已有的同名行就地替换，缺的追加在结尾分隔符之前；
 * 值为 `undefined` 表示「删掉这个字段」。没有 frontmatter 就以最小块新建。
 */
export function setFrontmatter(content, patch) {
    const text = String(content ?? '');
    const lines = text.split('\n');
    const has = DELIM.test(lines[0] ?? '');
    const end = has ? lines.findIndex((line, i) => i > 0 && DELIM.test(line)) : -1;
    const wellFormed = has && end > 0;
    const head = [];
    const replaced = new Set();
    for (const line of wellFormed ? lines.slice(1, end) : []) {
        const m = line.match(KEY_LINE);
        if (m && m[1] in patch) {
            // 就地替换：字段顺序不动，一次 supersede 的 diff 才只有那一行
            replaced.add(m[1]);
            const value = patch[m[1]];
            if (value !== undefined)
                head.push(`${m[1]}: ${value}`);
            continue;
        }
        head.push(line);
    }
    for (const [key, value] of Object.entries(patch)) {
        if (!replaced.has(key) && value !== undefined)
            head.push(`${key}: ${value}`);
    }
    const body = wellFormed ? lines.slice(end + 1).join('\n') : text;
    const block = ['---', ...head, '---'].join('\n');
    return wellFormed ? `${block}\n${body}` : `${block}\n\n${body}`;
}
/**
 * 解析 / 生成 YAML flow 列表（只用于 `tags`）：`[]`、`[a, b]`、`["a, b", c]`。
 *
 * 为什么只认 flow 形式：模板里写的就是 `tags: []`，工具只需在那一格上做并集；
 * 块式列表（`tags:` 换行 + `- a`）有缩进与续行两种写法，猜错一次就是整份 frontmatter 被改坏 ——
 * 遇到不认识的形状返回 null，调用方退回正文 hashtag 行，一个字都不碰。
 */
export function parseFlowList(raw) {
    const text = String(raw ?? '').trim();
    if (!text.startsWith('[') || !text.endsWith(']'))
        return null;
    const inner = text.slice(1, -1).trim();
    if (!inner)
        return [];
    const parts = [];
    let current = '';
    let quote = '';
    for (const ch of inner) {
        if (quote) {
            current += ch;
            if (ch === quote)
                quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ',') {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current.trim());
    return parts.filter(Boolean).map(stripQuotes);
}
/** YAML 里裸写会被当成布尔 / 空值的词 */
const YAML_RESERVED = /^(?:true|false|null|yes|no|on|off|~)$/i;
/** 标签写成 flow 列表项：能不加引号就不加（与手写风格一致），带空格 / 标点的加双引号 */
function formatListItem(value) {
    const plain = /^[\p{L}\p{N}_][\p{L}\p{N}_.#+-]*$/u.test(value) && !YAML_RESERVED.test(value);
    return plain ? value : JSON.stringify(value);
}
/** `[a, b]`：值里没有引号需求时与手写风格一致 */
export function formatFlowList(values) {
    return `[${values.map(formatListItem).join(', ')}]`;
}
/**
 * 标签落点（一份真相）：模板有 frontmatter `tags` 格就并进那一格，并撤掉建笔记时追加的正文 hashtag 行；
 * 没有这一格（flat 的模板 / 自定义模板）或形状不认识时，保留正文行 —— 那是 zk 唯一能索引到的地方。
 *
 * `appendedLine` 是建笔记时**我们自己**追加的那一行（`#a #b`），不是用户写的：
 * 只撤这一行，正文里原有的标签行一个字都不动。
 */
export function placeTags(content, tags, appendedLine) {
    if (!tags.length)
        return content;
    const parsed = parseFrontmatter(content);
    if (!('tags' in parsed.fields))
        return content;
    const existing = parseFlowList(parsed.fields.tags ?? '');
    if (existing === null)
        return content;
    const merged = [...existing];
    for (const tag of tags)
        if (!merged.includes(tag))
            merged.push(tag);
    let text = content;
    if (appendedLine) {
        const escaped = appendedLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 追加时用一个空行隔开：连那个空行一起收掉，正文与后面的小节之间不留空洞
        text = text.replace(new RegExp(`\\n\\n${escaped}(?=\\n|$)`), '');
    }
    return setFrontmatter(text, { tags: formatFlowList(merged) });
}
