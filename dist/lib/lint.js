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
import { normalizeTitle, resolveWikiTarget, WIKI_LINK, wikiIndex } from './wikilink.js';
import { parseFrontmatter } from './frontmatter.js';
import { TEMPLATE_VERSION } from './agents-template.js';
/** 每类最多回多少条（计划 §4 M3）；总数另给 */
export const MAX_ITEMS = 50;
/** 标题归一化与链接解析在 `lib/wikilink.ts`（dream 也用同一套）；这里保留导出，免得调用方跟着搬 */
export { normalizeTitle };
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
/** 记忆条目的观察日期（P1-3）：只认 YYYY-MM-DD 这种能机械解析的形状 */
const DATE_IN_LINE = /\b\d{4}-\d{2}-\d{2}\b/;
function collapse(text, max = 100) {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max) + '…' : one;
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
    const index = wikiIndex(notes);
    const items = [];
    const seen = new Set();
    let files = 0;
    let links = 0;
    let unlinked = 0;
    let undated = 0;
    let retired = 0;
    let retiredBroken = 0;
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
                // `[[   ]]` 这种空目标不是链接，也不该算「失效」：解析器对它返回 missing
                if (!target)
                    continue;
                const resolved = resolveWikiTarget(cfg, target, index);
                // 显式写 archive/ 路径的链接是有意引用旧结论（supersede 重写入链就是这个形状），不算漂移
                if (resolved.status === 'live' || resolved.explicit)
                    continue;
                const issue = { reason: resolved.status === 'archived' ? 'superseded' : 'missing', path: resolved.path };
                const key = `${name}\u0000${target}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                items.push({ source: name, entry: collapse(line), link: target, reason: issue.reason, path: issue.path });
            }
        }
        // 只对 MEMORY.md 数「没附来源 / 没日期 / 退役」：USER.md 是偏好清单，大多数条目本来就没有来源
        if (name === 'MEMORY.md') {
            for (const entry of listEntries(body)) {
                const first = entry.split('\n', 1)[0] ?? '';
                if (!entry.includes('[['))
                    unlinked += 1;
                // 退役行：磁盘保留、注入仍按原文（P1-3 A 案），只核对它指向的新结论是否还活着
                if (/^\s*(?:[-*+]|\d+[.)])\s+\[superseded\b/i.test(first)) {
                    retired += 1;
                    const next = /→\s*\[\[([^\]|#]+)/.exec(entry);
                    const resolved = next ? resolveWikiTarget(cfg, String(next[1] ?? '').trim(), index) : null;
                    if (!resolved || resolved.status !== 'live')
                        retiredBroken += 1;
                    continue;
                }
                if (!DATE_IN_LINE.test(first))
                    undated += 1;
            }
        }
    }
    return { files, links, total: items.length, unlinked, undated, retired, retiredBroken, items: items.slice(0, max) };
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
    if (bucket.undated > 0)
        parts.push(`${bucket.undated} 个条目没写日期（YYYY-MM-DD）`);
    if (bucket.retired > 0) {
        parts.push(bucket.retiredBroken > 0
            ? `${bucket.retired} 条已退役，其中 ${bucket.retiredBroken} 条的新结论不是活笔记`
            : `${bucket.retired} 条已退役`);
    }
    return `${bucket.total === 0 && bucket.retiredBroken === 0 ? '✓' : '✗'} 记忆链接：${parts.join('｜')}`;
}
/**
 * 三个后加的桶（缺字段 / 标签卫生 / 模板版本）的文案，同样只写一份：
 * `zk-kit lint` 与 `zk_lint` 各写一遍就会改到一半。返回空数组 = 这一库三项都没问题，不占行。
 */
export function formatLintExtras(r) {
    const lines = [];
    if (r.incomplete.total > 0) {
        lines.push(`✗ frontmatter 缺字段：${r.incomplete.total} 篇 — ` +
            r.incomplete.items.slice(0, 5).map((i) => `${i.path}（缺 ${i.missing.join('/')}）`).join('、') +
            (r.incomplete.total > 5 ? ' …' : '') +
            '｜缺失被索引落成空串，status / authority 的机械门对它们静默失效');
    }
    if (r.tags.reported) {
        const cv = r.tags.caseVariants;
        const sg = r.tags.singletons;
        lines.push(cv.total === 0
            ? `✓ 标签卫生：${r.tags.total} 个标签，没有大小写变体；单例 ${sg.total} 个` +
                (sg.items.length ? `（${sg.items.slice(0, 5).join('、')}）` : '')
            : `✗ 标签卫生：${cv.total} 组大小写变体 — ` +
                cv.items.slice(0, 3).map((g) => `${g.variants.join(' / ')}（${g.total}）`).join('；') +
                `；单例 ${sg.total} 个`);
    }
    if (r.template.stale) {
        lines.push(`⚠️ AGENTS.md 是${r.template.version === 0 ? '旧版 / 无版本标记' : `旧版模板 v${r.template.version}`}` +
            `（当前 v${r.template.current}）—— 只报告，不覆盖；要看新版可对比 docs/features/memory.md`);
    }
    return lines;
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
/** 模板承诺的四个字段里，这三个是机械规则的前提（title 由文件名兜底，不查） */
const REQUIRED_FIELDS = ['type', 'status', 'authority'];
/**
 * frontmatter 缺字段（P2-13）：`toRecord` 把缺失的 status / type / authority 一律落成空串，
 * 于是「没写 authority」=「authority 正常」—— dream 的 informal 门对它们静默失效。
 * 索引里区分不出「没写」与「空值」，只能逐篇读 frontmatter；代价是 O(n) 次读盘，
 * 护栏是只读 live 且非日记，扫描触到上限时置 truncated。
 *
 * 只在 layered 下检查：flat 的笔记本来就不写这三个字段（没有 group / 模板），
 * 对它报这一桶等于把整个库标红，那就不是「可发现的状态」而是噪音。
 */
export function incompleteFrontmatter(cfg, notes, skip, scanTruncated, max = 20) {
    const byField = { type: 0, status: 0, authority: 0 };
    const items = [];
    let total = 0;
    for (const note of notes) {
        if (skip(note.path))
            continue;
        let fields;
        try {
            fields = parseFrontmatter(fs.readFileSync(path.resolve(cfg.notebook, note.path), 'utf8')).fields;
        }
        catch {
            continue;
        }
        const missing = REQUIRED_FIELDS.filter((key) => !String(fields[key] ?? '').trim());
        if (!missing.length)
            continue;
        total += 1;
        for (const key of missing)
            byField[key] += 1;
        if (items.length < max)
            items.push({ path: note.path, missing });
    }
    return { total, truncated: scanTruncated, byField, items };
}
/** 小库不查标签卫生：20 个标签里出现几个单例是正常的，报出来只是噪音 */
const TAG_MIN = 30;
/**
 * 标签卫生（P2-14）：标签是中文召回的补丁，补丁自己的卫生没人看。
 * 大小写变体纯机械可判（`#Agent` / `#agent`），单例标签是「写了一次就再没出现」的那批。
 * 只报告，不合并 —— 在别的库里它们可能就是两个概念，裁决留给人。
 */
export function tagHygiene(notes, max = 20) {
    const counts = new Map();
    for (const note of notes)
        for (const tag of note.tags)
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const tags = [...counts.keys()];
    if (tags.length < TAG_MIN) {
        return { total: tags.length, reported: false, caseVariants: { total: 0, items: [] }, singletons: { total: 0, items: [] } };
    }
    const groups = new Map();
    for (const tag of tags) {
        const key = tag.toLowerCase();
        const list = groups.get(key) ?? [];
        list.push(tag);
        groups.set(key, list);
    }
    const variants = [...groups.values()]
        .filter((group) => group.length > 1)
        .map((group) => {
        group.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
        return { variants: group, total: group.reduce((sum, tag) => sum + (counts.get(tag) ?? 0), 0) };
    })
        .sort((a, b) => b.total - a.total || a.variants[0].localeCompare(b.variants[0]));
    const singletons = tags.filter((tag) => counts.get(tag) === 1).sort((a, b) => a.localeCompare(b));
    return {
        total: tags.length,
        reported: true,
        caseVariants: { total: variants.length, items: variants.slice(0, max) },
        singletons: { total: singletons.length, items: singletons.slice(0, 10) },
    };
}
const TEMPLATE_MARK_RE = /<!--\s*zdiary-template:\s*v(\d+)\s*-->/;
/**
 * 模板版本（P2-15）：模板是行为契约，不是静态文档 —— 它每轮注入，写错一句就是每轮都在执行错规则。
 * 但模板允许用户改，不能自动覆盖；版本标记把「过期」变成可发现状态，只报告。
 */
export function templateStatus(cfg) {
    let body = '';
    try {
        body = fs.readFileSync(path.join(cfg.notebook, 'AGENTS.md'), 'utf8');
    }
    catch {
        return { present: false, version: 0, current: TEMPLATE_VERSION, stale: false };
    }
    const hit = TEMPLATE_MARK_RE.exec(body);
    const version = hit ? Number(hit[1]) : 0;
    return { present: true, version, current: TEMPLATE_VERSION, stale: version !== TEMPLATE_VERSION };
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
    const graph = await graphEdges(cfg, signal);
    const edges = graph.edges;
    // 图里的路径是笔记本相对：先拼回绝对路径再判断是不是日记（isDaily 收的是绝对路径）
    const oneWay = oneWayLinks(edges, notes, (p) => isDaily(path.resolve(cfg.notebook, p)));
    // 别用 `path.resolve(n.absPath || n.path)`：absPath 缺失时相对路径会按进程 cwd 解析，键就错了。
    const byAbs = new Map(notes.map((n) => [n.absPath ? path.resolve(n.absPath) : path.resolve(cfg.notebook, n.path), n]));
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
    const linksOnly = opts.linksOnly === true;
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
        const all = [];
        const links = [];
        const body = [];
        for (const source of row.from) {
            all.push(source.path);
            if (whereOf(source.path, source.snippetStarts) === 'links')
                links.push(source.path);
            else
                body.push(source.path);
        }
        // bodyOnly 始终统计全部正文边：linksOnly 时它们被隐藏，但要让调用方知道有多少
        bodyOnly += body.length;
        if (linksOnly && links.length === 0)
            continue;
        if (linksOnly) {
            oneWayEdges += links.length;
            oneWayItems.push({
                title: target.title,
                path: target.path,
                from: links,
                where: 'links',
            });
        }
        else {
            oneWayEdges += all.length;
            oneWayItems.push({
                title: target.title,
                path: target.path,
                from: all,
                where: links.length === 0 ? 'body' : body.length === 0 ? 'links' : 'mixed',
            });
        }
    }
    oneWayItems.sort((a, b) => a.path.localeCompare(b.path));
    const oneWayBucket = {
        total: oneWayItems.length,
        edges: oneWayEdges,
        bodyOnly,
        linksOnly,
        edgesTruncated: graph.truncated,
        items: oneWayItems.slice(0, MAX_ITEMS),
    };
    const parseErrors = parseErrorWarnings(cfg, warnings);
    const scanTruncated = notes.length >= MAX_SCAN;
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
        truncated: scanTruncated,
        staleDays,
        parseErrors: { total: parseErrors.length, items: parseErrors.slice(0, MAX_ITEMS) },
        orphans: bucket(orphanAbs.filter((abs) => !isDaily(abs))),
        brokenLinks: bucket(brokenAbs),
        stale,
        tagless: bucket(taglessAbs.filter((abs) => !isDaily(abs))),
        oneWayLinks: oneWayBucket,
        duplicateTitles: duplicateTitles(notes),
        memoryLinks: memoryLinkIssues(cfg, notes),
        incomplete: cfg.structure === 'layered'
            ? incompleteFrontmatter(cfg, notes, (rel) => isDaily(path.resolve(cfg.notebook, rel)), scanTruncated)
            : { total: 0, truncated: false, byField: { type: 0, status: 0, authority: 0 }, items: [] },
        tags: tagHygiene(notes),
        template: templateStatus(cfg),
    };
}
