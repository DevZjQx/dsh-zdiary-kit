/**
 * 巡检（M3）：只报告，不改任何笔记（计划 §3 D5）。
 *
 * 一次 `zk list` 拿全量，再用 zk 原生的两个过滤器（孤儿 / 断链）各跑一次进程，外加一次 `zk graph` 拿全库的边；
 * 「陈旧」「重名」「单向链接」在 JS 里算。200 条笔记上 5 次进程就够 —— 不允许按笔记逐条跑 zk。
 *
 * 「陈旧」为什么自己算：zk 的 `stale` 不是内置过滤器，`zk list stale` 只在你自己的
 * `[filter]` 里定义过才存在（Z3 只说了位置参数语法，没说它是内置的）。所以阈值由插件定。
 *
 * 孤儿与无标签**不含日记**：日记按天写，天然没有入链、也没有标签，
 * 全报出来只会把真正的问题（断链、单向链接）淹掉。断链仍包含日记 —— 那里出错是真问题。
 *
 * 「单向链接」为什么自己算：zk 的 `--missing-backlink` 是「至少有一条单向链接」（S 链 X、X 不回链），
 * 而日记天然是一串出边 —— 日记提过的每篇笔记都会常年挂在桶里。那不是「笔记没接上」，是正常的引用方向。
 * 所以改成在 `zk graph` 的边上算，只报**非日记来源**的单向链接。
 *
 * 解析失败单列一桶：frontmatter 写坏（典型是 `tags: [#你好世界]`，`#` 不是 tag 前缀）时
 * zk 只在 stderr 吭一声就跳过那篇，它于是从索引里消失 —— 搜不到，也不进上面任何一个桶。
 * 不单独报出来，用户只会看到「邻居突然孤儿、突然断链」，永远查不到根因。
 *
 * 记忆层（MEMORY.md / USER.md）的 `[[来源]]` 单列一项：它们不进索引，supersede 也不会重写，
 * 旧结论搬进 archive/ 之后链接会静默停在旧路径 —— 断链、孤儿、单向链接都统计不到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { allNotes, graphEdges, localDate, MAX_SCAN, notesWithFlag, parseErrorWarnings } from './zk.js';
import { parseFrontmatter } from './frontmatter.js';
/** 每类最多回多少条（计划 §4 M3）；总数另给 */
export const MAX_ITEMS = 50;
/** 标题归一化只压空白与大小写，不改字（中文不受影响，也不会把「A B」和「AB」当成同一个） */
export function normalizeTitle(title) {
    return String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** 同一标题出现在多篇里（slug 命名下不同目录可以同名，检索时容易挑错） */
export function duplicateTitles(notes, max = MAX_ITEMS) {
    const groups = new Map();
    for (const note of notes) {
        const key = normalizeTitle(note.title || path.basename(note.path, path.extname(note.path)));
        if (!key)
            continue;
        const hit = groups.get(key);
        if (hit)
            hit.paths.push(note.path);
        else
            groups.set(key, { title: note.title || key, paths: [note.path] });
    }
    const dup = [...groups.values()].filter((g) => g.paths.length > 1);
    dup.sort((a, b) => b.paths.length - a.paths.length || a.title.localeCompare(b.title));
    return { total: dup.length, items: dup.slice(0, max) };
}
/** 注入的三份 meta 里只有 MEMORY / USER 会写来源链接；AGENTS 是规则，不查 */
const MEMORY_LINK_FILES = ['MEMORY.md', 'USER.md'];
/** `[[路径]]` / `[[路径|别名]]` / `[[路径#小节]]` 都认，取路径部分 */
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
/** 按列表条目切分（含缩进续行）：只有条目才谈得上「没附来源」 */
function listEntries(body) {
    const out = [];
    let current = null;
    const flush = () => {
        if (current)
            out.push(current.join('\n'));
        current = null;
    };
    for (const line of String(body ?? '').split('\n')) {
        if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
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
function collapse(text, max = 100) {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max) + '…' : one;
}
function insideNotebook(cfg, abs) {
    const root = path.resolve(cfg.notebook);
    const p = path.resolve(abs);
    return p === root || p.startsWith(root + path.sep);
}
function statusOf(abs) {
    try {
        return parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.status ?? '';
    }
    catch {
        return '';
    }
}
function relOf(cfg, abs) {
    return path.relative(cfg.notebook, abs).split(path.sep).join('/');
}
/**
 * 记忆层体检：MEMORY.md / USER.md 里的 `[[来源]]` 是否还指向活笔记。
 *
 * 为什么必须有这一项：supersede 只重写 `zk graph` 里的入链，而 meta 文件被 `excludedNames`
 * 排除在图外 —— MEMORY.md 里的链接不会跟着搬，broken-links 也看不见它。记忆说 X、库里 X 已废弃，
 * 这是记忆层与事实层脱节最典型的一种。
 *
 * 纯机械解析：路径优先（原路径 → 加 .md → archive/ 下同名），退而按标题/文件名匹配**活笔记**；
 * 归档标题不反查 —— 归档默认不进检索，这里再造一套索引就成了第二真相。「语义重复」也不查。
 */
export function memoryLinkIssues(cfg, notes, max = MAX_ITEMS) {
    const titles = new Set();
    for (const n of notes) {
        titles.add(normalizeTitle(n.title));
        titles.add(normalizeTitle(path.basename(n.path, path.extname(n.path))));
    }
    const items = [];
    const seen = new Set();
    let files = 0;
    let links = 0;
    let unlinked = 0;
    /** null = 活着 / 没问题；否则给出失效原因与命中路径 */
    const resolve = (target) => {
        const rel = target.replace(/\\/g, '/').replace(/^\.\//, '').trim();
        if (!rel)
            return null;
        const candidates = /\.md$/i.test(rel) ? [rel] : [rel, `${rel}.md`];
        for (const candidate of candidates) {
            const abs = path.resolve(cfg.notebook, candidate);
            if (!insideNotebook(cfg, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile())
                continue;
            const hit = relOf(cfg, abs);
            // 显式写 archive/ 路径 = 有意引用旧结论（supersede 就是这样重写入链的），不算漂移
            if (hit === cfg.archiveDir || hit.startsWith(`${cfg.archiveDir}/`))
                return null;
            return statusOf(abs) === 'superseded'
                ? { reason: 'superseded', path: hit }
                : null;
        }
        // 链接还停在废弃前的路径：文件已经搬进 archive/ —— 这正是要抓的漂移
        if (!rel.startsWith(`${cfg.archiveDir}/`)) {
            for (const candidate of candidates) {
                const abs = path.resolve(cfg.notebook, cfg.archiveDir, candidate);
                if (!insideNotebook(cfg, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile())
                    continue;
                return { reason: 'superseded', path: relOf(cfg, abs) };
            }
        }
        // 标题式链接只在活笔记里找（zk 的 wiki 链接两种写法都认）
        if (titles.has(normalizeTitle(rel)))
            return null;
        return { reason: 'missing', path: '' };
    };
    for (const name of MEMORY_LINK_FILES) {
        let body = '';
        try {
            body = fs.readFileSync(path.join(cfg.notebook, name), 'utf8');
        }
        catch {
            continue;
        }
        files += 1;
        for (const line of body.split('\n')) {
            for (const match of line.matchAll(WIKI_LINK)) {
                links += 1;
                const target = String(match[1] ?? '').trim();
                const issue = resolve(target);
                if (!issue)
                    continue;
                const key = `${name}\u0000${target}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                items.push({ source: name, entry: collapse(line), link: target, reason: issue.reason, path: issue.path });
            }
        }
        // 只对 MEMORY.md 数「没附来源」：USER.md 是偏好清单，大多数条目本来就没有来源
        if (name === 'MEMORY.md') {
            unlinked += listEntries(body).filter((entry) => !entry.includes('[[')).length;
        }
    }
    return { files, links, total: items.length, unlinked, items: items.slice(0, max) };
}
/**
 * 一行「记忆链接」摘要：`zk-kit lint` 与 `zk_lint` 共用，免得两处各写一遍文案、
 * 下次改措辞只改到一半。返回 null = 这个库还没启用记忆层（files = 0），不占一行。
 */
export function formatMemoryLinks(bucket) {
    if (bucket.files === 0)
        return null;
    const parts = [];
    if (bucket.total > 0) {
        const sample = bucket.items.slice(0, 3).map((i) => {
            const why = i.reason === 'superseded' ? '已废弃' + (i.path ? ` → ${i.path}` : '') : '不存在';
            return `${i.source} [[${i.link}]]（${why}）`;
        }).join('、');
        parts.push(`${bucket.total} 条失效 — ${sample}${bucket.total > 3 ? ' …' : ''}`);
    }
    else {
        parts.push(bucket.links > 0 ? `${bucket.links} 条都可核对` : 'MEMORY.md / USER.md 里没有 [[来源链接]]');
    }
    if (bucket.unlinked > 0)
        parts.push(`${bucket.unlinked} 个条目没附来源链接`);
    return `${bucket.total === 0 ? '✓' : '✗'} 记忆链接：${parts.join('｜')}`;
}
export function oneWayLinks(edges, notes, skipSource) {
    const linked = new Set(edges.map((e) => e.sourcePath + '\u0000' + e.targetPath));
    const byPath = new Map(notes.map((n) => [n.path, n]));
    const out = new Map();
    for (const edge of edges) {
        if (edge.sourcePath === edge.targetPath)
            continue;
        if (skipSource(edge.sourcePath))
            continue;
        if (linked.has(edge.targetPath + '\u0000' + edge.sourcePath))
            continue;
        if (!byPath.has(edge.targetPath))
            continue;
        const sources = out.get(edge.targetPath) ?? new Map();
        const starts = sources.get(edge.sourcePath) ?? [];
        starts.push(edge.snippetStart);
        sources.set(edge.sourcePath, starts);
        out.set(edge.targetPath, sources);
    }
    return [...out].map(([target, sources]) => ({
        target,
        from: [...sources]
            .map(([source, snippetStarts]) => ({ path: source, snippetStarts }))
            .sort((a, b) => a.path.localeCompare(b.path)),
    }));
}
export async function lintNotebook(cfg, opts = {}, signal) {
    const staleDays = Math.min(3650, Math.max(1, Math.trunc(opts.staleDays ?? 90)));
    const now = opts.now ?? new Date();
    const cutoff = now.getTime() - staleDays * 86_400_000;
    // 顺序跑而不是并发：zk 每次都会顺手补索引（写 SQLite），并发进程容易撞锁；
    // 一次进程 ~50ms，5 次照样远低于「200 条 3 秒」的验收线。
    // warning 只从第一次 list 收：每篇坏笔记每次进程都会再报一遍，收五遍还得去重。
    const warnings = [];
    const dailyAbs = path.resolve(cfg.notebook, cfg.dailyDir);
    const isDaily = (abs) => path.resolve(abs) === dailyAbs || path.resolve(abs).startsWith(dailyAbs + path.sep);
    const notes = await allNotes(cfg, { warnings }, signal);
    const orphanAbs = await notesWithFlag(cfg, '--orphan', signal);
    const brokenAbs = await notesWithFlag(cfg, '--broken-links', signal);
    const taglessAbs = await notesWithFlag(cfg, '--tagless', signal);
    const edges = await graphEdges(cfg, signal);
    // 图里的路径是笔记本相对：先拼回绝对路径再判断是不是日记（isDaily 收的是绝对路径）
    const oneWay = oneWayLinks(edges, notes, (p) => isDaily(path.resolve(cfg.notebook, p)));
    const byAbs = new Map(notes.map((n) => [path.resolve(n.absPath || n.path), n]));
    const byPath = new Map(notes.map((n) => [n.path, n]));
    const bucket = (absPaths, max = MAX_ITEMS) => {
        const items = absPaths
            .map((abs) => byAbs.get(path.resolve(abs)))
            .filter((n) => Boolean(n))
            .sort((a, b) => a.path.localeCompare(b.path))
            .slice(0, max)
            .map((n) => ({ title: n.title, path: n.path }));
        return { total: absPaths.length, items };
    };
    // `zk graph` 的 snippetStart 是 UTF-8 字节偏移：Links 小节也按字节算，才能直接比较。
    // 只读有单向边的来源文件（当前库里个位数），不按笔记逐篇读。
    const sectionCache = new Map();
    const linksSection = (rel) => {
        if (sectionCache.has(rel))
            return sectionCache.get(rel) ?? null;
        let text = '';
        try {
            text = fs.readFileSync(path.resolve(cfg.notebook, rel), 'utf8');
        }
        catch {
            sectionCache.set(rel, null);
            return null;
        }
        const head = /^##[ \t]+(?:Links|链接)[ \t]*\r?$/m.exec(text);
        if (!head) {
            sectionCache.set(rel, null);
            return null;
        }
        const after = head.index + head[0].length;
        const next = /^#{1,2}[ \t]+\S/m.exec(text.slice(after));
        const endChar = next ? after + next.index : text.length;
        const section = {
            start: Buffer.byteLength(text.slice(0, head.index), 'utf8'),
            end: Buffer.byteLength(text.slice(0, endChar), 'utf8'),
        };
        sectionCache.set(rel, section);
        return section;
    };
    const whereOf = (rel, starts) => {
        const section = linksSection(rel);
        if (!section)
            return 'body';
        return starts.some((s) => s >= section.start && s < section.end) ? 'links' : 'body';
    };
    const oneWayItems = [];
    let oneWayEdges = 0;
    let bodyOnly = 0;
    for (const row of oneWay) {
        // 目标也不报日记：普通笔记链到日记（"今天做了 X"）同样是正常引用方向，
        // 要求日记回链每篇被提到的笔记，跟要求笔记回链日记是同一个问题。
        if (isDaily(path.resolve(cfg.notebook, row.target)))
            continue;
        const target = byPath.get(row.target);
        if (!target)
            continue;
        let links = 0;
        let body = 0;
        for (const source of row.from) {
            oneWayEdges += 1;
            if (whereOf(source.path, source.snippetStarts) === 'links')
                links += 1;
            else {
                body += 1;
                bodyOnly += 1;
            }
        }
        oneWayItems.push({
            title: target.title,
            path: target.path,
            from: row.from.map((s) => s.path),
            where: links === 0 ? 'body' : body === 0 ? 'links' : 'mixed',
        });
    }
    oneWayItems.sort((a, b) => a.path.localeCompare(b.path));
    const oneWayBucket = {
        total: oneWayItems.length,
        edges: oneWayEdges,
        bodyOnly,
        items: oneWayItems.slice(0, MAX_ITEMS),
    };
    const parseErrors = parseErrorWarnings(cfg, warnings);
    const staleNotes = notes
        .map((n) => ({ note: n, at: Date.parse(n.modified) }))
        .filter((x) => Number.isFinite(x.at) && x.at < cutoff)
        .sort((a, b) => a.at - b.at);
    const stale = {
        total: staleNotes.length,
        items: staleNotes.slice(0, MAX_ITEMS).map((x) => ({
            title: x.note.title,
            path: x.note.path,
            modified: localDate(x.note.modified),
        })),
    };
    return {
        notebook: cfg.notebook,
        notes: notes.length,
        truncated: notes.length >= MAX_SCAN,
        staleDays,
        parseErrors: { total: parseErrors.length, items: parseErrors.slice(0, MAX_ITEMS) },
        orphans: bucket(orphanAbs.filter((abs) => !isDaily(abs))),
        brokenLinks: bucket(brokenAbs),
        stale,
        tagless: bucket(taglessAbs.filter((abs) => !isDaily(abs))),
        oneWayLinks: oneWayBucket,
        duplicateTitles: duplicateTitles(notes),
        memoryLinks: memoryLinkIssues(cfg, notes),
    };
}
