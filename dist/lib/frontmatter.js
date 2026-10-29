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
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        return v.slice(1, -1);
    }
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
