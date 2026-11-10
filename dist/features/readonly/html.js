/**
 * 只读视图的渲染层：转义 + 极简 markdown + 页面骨架。
 *
 * 零依赖、无 JS、服务端拼字符串 —— Web 1.0 的意思是「浏览器只负责显示」：
 * 没有 hydrate、没有 fetch、没有前端构建产物，lynx / curl / 打印都一样能看。
 *
 * 【安全约定】笔记正文是任意文本（里面写 <script> 很正常），所以：
 *   · 所有动态内容一律走 esc()，不解析原始 HTML；
 *   · markdown 只认下面这一小撮语法，链接只放行 http(s) / mailto / 站内相对路径；
 *   · 代码块先 stash 成占位符，避免里面的 ** / [ ] 被当成强调或链接。
 */
import { ROUTE_BASE } from '../../lib/http.js';
import { fenceMarker } from '../../lib/fence.js';
const ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};
/** HTML 文本 / 属性统一转义（属性用双引号，所以引号也必须转） */
export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}
/** 站内链接统一前缀（和 feature.ts 同源：lib/http 的 ROUTE_BASE） */
const BASE = ROUTE_BASE;
const CSS = [
    'body{margin:0 auto;max-width:860px;padding:18px 16px 40px;background:#fff;color:#111;',
    'font:16px/1.6 Georgia,"Times New Roman","Songti SC",serif}',
    'a{color:#0000cc}a:visited{color:#551a8b}a:hover{background:#ffffcc}',
    'header.site{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
    'header.site .brand{font-size:20px;font-weight:bold;text-decoration:none}',
    'nav{margin:6px 0 0;font-size:14px}nav a{margin-right:12px}',
    'hr{border:0;border-top:1px solid #bbb;margin:14px 0}',
    'h1{font-size:1.6em;line-height:1.25;margin:.5em 0 .3em}',
    'h2{font-size:1.2em;margin:1.4em 0 .5em;border-bottom:1px solid #ddd;padding-bottom:2px}',
    'h3,h4,h5,h6{font-size:1.05em;margin:1.1em 0 .4em}',
    'p{white-space:pre-line;margin:.55em 0}',
    'ul,ol{margin:.4em 0 .8em;padding-left:1.6em}li{margin:.15em 0}',
    'blockquote{margin:.6em 0;padding:.2em 0 .2em 12px;border-left:3px solid #ccc;color:#333}',
    'pre{background:#f6f6f6;border:1px solid #ddd;padding:8px 10px;overflow:auto;font-size:13px;line-height:1.45}',
    'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}',
    'p code,li code{background:#f3f3f3;padding:0 3px}',
    'table{border-collapse:collapse;width:100%;margin:.5em 0}',
    'th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #e5e5e5;vertical-align:top}',
    'th{font-weight:bold;border-bottom:1px solid #bbb}',
    '.meta{color:#555;font-size:13px}.meta a{color:#0000cc}',
    '.notice{border:1px solid #d9a300;background:#fffbe6;padding:8px 10px;margin:12px 0;font-size:14px}',
    '.notice details{margin-top:6px}.notice summary{cursor:pointer}',
    '.error{border:1px solid #c00;background:#fff2f2;padding:8px 10px;margin:12px 0;font-size:14px}',
    '.tags a{margin-right:10px;white-space:nowrap}.tags .count{color:#777;font-size:12px}',
    'form.search{margin:12px 0}form.search input{font:inherit;padding:3px 6px;width:min(100%,360px);border:1px solid #999}',
    'form.search button{font:inherit;padding:3px 10px;margin-left:4px}',
    '.wikilink{color:#777;border-bottom:1px dotted #999}',
    'footer{margin-top:26px;color:#666;font-size:12px}',
    '.crumb{font-size:13px;color:#666}',
    '@media print{body{max-width:none;font-size:12pt}nav,form.search,footer{display:none}a{color:#000;text-decoration:none}}',
].join('');
/** 页面骨架：导航、主体、页脚。所有插值都已转义或由本模块生成。 */
export function layout({ title, notebook, body, note }) {
    const generated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    return [
        '<!doctype html>',
        '<html lang="zh-CN"><head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta name="robots" content="noindex,nofollow">',
        `<title>${esc(title)} · ${esc(notebook)}</title>`,
        `<style>${CSS}</style>`,
        '</head><body>',
        '<header class="site">',
        `<a class="brand" href="${BASE}/view">${esc(notebook)}</a>`,
        '<span class="meta">只读知识库</span>',
        '</header>',
        '<nav>',
        `<a href="${BASE}/view">首页</a>`,
        `<a href="${BASE}/view?p=memory">记忆</a>`,
        `<a href="${BASE}/view?p=tags">标签</a>`,
        `<a href="${BASE}/feed.xml">RSS</a>`,
        '</nav>',
        '<hr>',
        body,
        '<hr>',
        '<footer>',
        `只读视图 · 无写接口 · 数据来自插件进程工作区 · 生成于 ${esc(generated)}`,
        note ? `<br>${esc(note)}` : '',
        '</footer>',
        '</body></html>',
    ].join('');
}
/** frontmatter 是给 zk 的元数据，页面上由标题 / 日期行展示，正文里剥掉 */
function stripFrontmatter(text) {
    return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
/**
 * 只放行 http(s) / mailto / 站内相对路径；javascript:、data: 一律当成纯文本。
 * `//host` 与 `\\host` / `\/host` 是协议相对链接（浏览器会把反斜杠规范成斜杠），
 * 点下去就离开本地视图了，同样不算站内，直接拒绝。
 */
function safeHref(href) {
    const value = href.trim();
    if (!value)
        return false;
    if (/^[\\/]{2}/.test(value))
        return false;
    if (/^(?:javascript|data|vbscript):/i.test(value))
        return false;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    if (!scheme)
        return true;
    return /^(?:https?|mailto)$/i.test(scheme[1]);
}
/** 行内语法：代码 → 双链 → markdown 链接 → 粗体 → 斜体（全部在已转义文本上做） */
function inline(text, opts) {
    const stash = [];
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let out = esc(text);
    out = out.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${code}</code>`));
    out = out.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner) => {
        const bar = inner.indexOf('|');
        const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
        const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || target;
        if (!target)
            return keep(label);
        const href = opts.linkFor?.(target) ?? null;
        return keep(href
            ? `<a href="${esc(href)}">${label}</a>`
            : `<span class="wikilink">${label}</span>`);
    });
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
        if (!safeHref(href))
            return keep(label);
        // href 来自已经转义过的文本，直接用；再 esc 一次会把 &amp; 变成 &amp;amp;
        return keep(`<a href="${href}" rel="noopener noreferrer">${label}</a>`);
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)] ?? '');
}
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
/** 独占一行的 HTML 注释：不渲染。模板首行就是 `<!-- zdiary-template: vN -->`（lint 的版本标记），
 * 转义后当段落显示等于把内部约定摆到页面最上面 */
const HTML_COMMENT = /^\s*<!--[\s\S]*?-->\s*$/;
/**
 * 极简 markdown：标题 / 段落 / 列表 / 引用 / 分隔线 / 围栏代码。
 * 不支持的语法（表格、图片、脚注……）原样当段落显示 —— 宁可朴素，不要为了渲染引一个库。
 */
export function renderMarkdown(source, opts = {}) {
    const text = stripFrontmatter(String(source ?? '')).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const out = [];
    const para = [];
    let i = 0;
    let skippedH1 = false;
    const flush = () => {
        if (!para.length)
            return;
        out.push(`<p>${para.map((line) => inline(line, opts)).join('\n')}</p>`);
        para.length = 0;
    };
    while (i < lines.length) {
        const line = lines[i] ?? '';
        const open = fenceMarker(line);
        if (open) {
            flush();
            i += 1;
            const code = [];
            while (i < lines.length) {
                const close = fenceMarker(lines[i] ?? '');
                // 闭合必须同字符、长度 ≥ 开启行且不带语言标记：块里的 ```js 只是代码
                if (close && close.char === open.char && close.len >= open.len && !close.info)
                    break;
                code.push(lines[i++] ?? '');
            }
            i += 1;
            out.push(`<pre><code${open.info ? ` class="language-${esc(open.info)}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
            continue;
        }
        // 整行跳过：不显示，也不 flush —— 它是不可见的元信息，不该把段落或列表从中间切开
        if (HTML_COMMENT.test(line)) {
            i += 1;
            continue;
        }
        if (!line.trim()) {
            flush();
            i += 1;
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            flush();
            const level = heading[1]?.length ?? 1;
            if (level === 1 && opts.skipFirstH1 && !skippedH1) {
                skippedH1 = true;
                i += 1;
                continue;
            }
            // 第一个标题不是 H1 时，后面的 H1 是正文小节，不能再当页面标题跳掉
            skippedH1 = true;
            out.push(`<h${level}>${inline(heading[2] ?? '', opts)}</h${level}>`);
            i += 1;
            continue;
        }
        if (HR.test(line)) {
            flush();
            out.push('<hr>');
            i += 1;
            continue;
        }
        const quote = QUOTE.exec(line);
        if (quote) {
            flush();
            const body = [];
            while (i < lines.length) {
                const q = QUOTE.exec(lines[i] ?? '');
                if (!q)
                    break;
                body.push(inline(q[1] ?? '', opts));
                i += 1;
            }
            out.push(`<blockquote>${body.join('<br>')}</blockquote>`);
            continue;
        }
        const ul = UL.exec(line);
        if (ul) {
            flush();
            const items = [];
            while (i < lines.length) {
                const m = UL.exec(lines[i] ?? '');
                if (!m)
                    break;
                items.push(`<li>${inline(m[1] ?? '', opts)}</li>`);
                i += 1;
            }
            out.push(`<ul>${items.join('')}</ul>`);
            continue;
        }
        const ol = OL.exec(line);
        if (ol) {
            flush();
            const items = [];
            while (i < lines.length) {
                const m = OL.exec(lines[i] ?? '');
                if (!m)
                    break;
                items.push(`<li>${inline(m[1] ?? '', opts)}</li>`);
                i += 1;
            }
            out.push(`<ol>${items.join('')}</ol>`);
            continue;
        }
        para.push(line);
        i += 1;
    }
    flush();
    return out.join('\n');
}
