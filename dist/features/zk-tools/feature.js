import { config } from '../../config/store.js';
import { S, validateArgs } from '../../lib/tool.js';
import { ensureNotebook } from '../../lib/notebook.js';
import { searchNotes, createNote, readNote, findNote, appendToNote, ensureDailyNote, appendDaily, linkNotes, withTags, notebookStats, supersedeNote, localDate as dateOnly, ZkError, } from '../../lib/zk.js';
import { buildMemoryPayload, META_FILES } from '../../lib/memory.js';
const text = (value) => [{ type: 'text', text: value }];
const objSchema = (properties, required) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
});
function fail(err) {
    if (err instanceof ZkError) {
        throw new Error(err.hint ? `${err.message}（${err.hint}）` : err.message);
    }
    throw err instanceof Error ? err : new Error(String(err));
}
function tagSuffix(record) {
    return record.tags.length ? ' · ' + record.tags.map((t) => '#' + t).join(' ') : '';
}
function noteLine(n, index) {
    const head = `${index + 1}. ${n.title || n.path}`;
    const meta = [n.path, dateOnly(n.created)].filter(Boolean).join(' · ');
    const lead = n.lead ? `\n   ${n.lead}` : '';
    return `${head}\n   ${meta}${tagSuffix(n)}${lead}`;
}
function def(spec) {
    return {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: spec.output.schema, render: (args, value) => spec.render(args, value) },
        async execute(args, exec) {
            const issues = validateArgs(spec.parameters, args);
            if (issues.length)
                throw new Error(`参数不合法：${issues.join('；')}`);
            try {
                return await spec.run((args ?? {}), exec?.signal);
            }
            catch (err) {
                return fail(err);
            }
        },
    };
}
export function buildTools() {
    return [
        def({
            name: 'zk_search',
            description: '在 zk 知识库里搜索笔记（全文 / 标签 / 日期 / 断链 / 孤立笔记），返回标题、相对路径、标签、创建日与摘要。' +
                '找到后用 zk_read 读全文。写笔记前先用它查重。',
            parameters: {
                type: 'object',
                properties: {
                    query: S.str('全文检索词（FTS，支持 "短语" 与 AND / OR）'),
                    tags: S.arr('按标签过滤（AND：必须同时带这些标签）', S.str('标签名，不带 #')),
                    since: S.str('只看这个日期之后创建的笔记，自然语言或 ISO 日期，如 2026-01-01 / "last week"'),
                    until: S.str('只看这个日期之前创建的笔记'),
                    orphan: S.bool('只看没有任何反链的孤立笔记'),
                    brokenLinks: S.bool('只看含有断链的笔记'),
                    limit: S.num('最多返回几条（1-50，默认 10）'),
                    sort: S.enum('排序方式', ['created-desc', 'created-asc', 'modified-desc', 'title-asc']),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    count: { type: 'number' },
                    notes: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                            created: { type: 'string' },
                            lead: { type: 'string' },
                        }, ['title', 'path', 'tags', 'created', 'lead']),
                    },
                }, ['notebook', 'count', 'notes']),
            },
            async run(args) {
                const cfg = config();
                await ensureNotebook(cfg);
                const notes = await searchNotes(cfg, {
                    query: args.query ? String(args.query) : undefined,
                    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
                    since: args.since ? String(args.since) : undefined,
                    until: args.until ? String(args.until) : undefined,
                    orphan: args.orphan === true,
                    brokenLinks: args.brokenLinks === true,
                    limit: args.limit === undefined ? 10 : Number(args.limit),
                    sort: args.sort ? String(args.sort) : 'created-desc',
                });
                return {
                    notebook: cfg.notebook,
                    count: notes.length,
                    notes: notes.map((n) => ({ title: n.title, path: n.path, tags: n.tags, created: dateOnly(n.created), lead: n.lead })),
                };
            },
            render(_args, value) {
                const v = value;
                if (!v.count)
                    return text(`没有匹配的笔记（笔记本 ${v.notebook}）`);
                return text(`${v.count} 条（笔记本 ${v.notebook}）\n` + v.notes.map(noteLine).join('\n'));
            },
        }),
        def({
            name: 'zk_query',
            description: '结构化检索记忆：按 type（daily/source/concept/entity/pattern）、status（active/superseded）、标签、目录、日期、断链、孤立过滤。' +
                '默认只看 active 且不含归档。要复查旧结论时传 include_archived: true。这是查「记忆里有什么」的主入口。',
            parameters: {
                type: 'object',
                properties: {
                    query: S.str('全文检索词（中文召回不完整，尽量配合 tags 使用）'),
                    tags: S.arr('按标签过滤（AND）', S.str('标签名，不带 #')),
                    dirs: S.arr('只看这些目录（相对笔记本，如 notes/concepts）', S.str('相对目录')),
                    type: S.enum('只要这个类型的笔记', ['daily', 'source', 'concept', 'entity', 'pattern']),
                    status: S.enum('只要这个状态（默认 active）', ['active', 'superseded']),
                    since: S.str('只看这个日期之后创建的'),
                    until: S.str('只看这个日期之前创建的'),
                    orphan: S.bool('只看没有反链的孤立笔记'),
                    brokenLinks: S.bool('只看含断链的笔记'),
                    include_archived: S.bool('连 archive/ 里的废弃笔记一起查（默认 false）'),
                    sort: S.enum('排序方式', ['created-desc', 'created-asc', 'modified-desc', 'title-asc']),
                    limit: S.num('最多返回几条（1-50，默认 10）'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    count: { type: 'number' },
                    notes: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            type: { type: 'string' },
                            status: { type: 'string' },
                            authority: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                            created: { type: 'string' },
                            lead: { type: 'string' },
                            archived: { type: 'boolean' },
                        }, ['title', 'path', 'type', 'status', 'authority', 'tags', 'created', 'lead', 'archived']),
                    },
                }, ['notebook', 'count', 'notes']),
            },
            async run(args, signal) {
                const cfg = config();
                await ensureNotebook(cfg, signal);
                const notes = await searchNotes(cfg, {
                    query: args.query ? String(args.query) : undefined,
                    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
                    paths: Array.isArray(args.dirs) ? args.dirs.map(String) : undefined,
                    type: args.type ? [String(args.type)] : undefined,
                    // 默认只给活着的：归档区外的 superseded 是手写 frontmatter 的残留，不该混进结果
                    status: [args.status ? String(args.status) : 'active'],
                    since: args.since ? String(args.since) : undefined,
                    until: args.until ? String(args.until) : undefined,
                    orphan: args.orphan === true,
                    brokenLinks: args.brokenLinks === true,
                    includeArchived: args.include_archived === true,
                    limit: args.limit === undefined ? 10 : Number(args.limit),
                    sort: args.sort ? String(args.sort) : 'created-desc',
                }, signal);
                return {
                    notebook: cfg.notebook,
                    count: notes.length,
                    notes: notes.map((n) => ({
                        title: n.title,
                        path: n.path,
                        type: n.type,
                        status: n.status || 'active',
                        authority: n.authority,
                        tags: n.tags,
                        created: dateOnly(n.created),
                        lead: n.lead,
                        archived: n.path.startsWith(cfg.archiveDir + '/'),
                    })),
                };
            },
            render(_args, value) {
                const v = value;
                if (!v.count)
                    return text(`没有匹配的笔记（笔记本 ${v.notebook}）`);
                const lines = v.notes.map((n, i) => {
                    const badges = [String(n.type || '—'), String(n.status || 'no-status'), n.archived ? '已归档' : ''].filter(Boolean);
                    return `${i + 1}. ${String(n.title)}  [${badges.join(' · ')}]\n   ${String(n.path)} · ${String(n.created)}${String(n.lead) ? '\n   ' + String(n.lead) : ''}`;
                });
                return text(`${v.count} 条（笔记本 ${v.notebook}）\n` + lines.join('\n'));
            },
        }),
        def({
            name: 'zk_read',
            description: '读一篇笔记的全文（或先按搜索词找到最相关的一篇再读）。路径是相对笔记本根目录的路径，如 notes/ab12.md。' +
                '长笔记会被截断并明确标注。',
            parameters: {
                type: 'object',
                properties: {
                    path: S.str('笔记的相对路径；与 query 二选一'),
                    query: S.str('搜索词：取最相关的一篇读；与 path 二选一'),
                    maxChars: S.num('最多返回多少字符（默认取设置里的值）'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    path: { type: 'string' },
                    title: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    created: { type: 'string' },
                    modified: { type: 'string' },
                    chars: { type: 'number' },
                    truncated: { type: 'boolean' },
                    content: { type: 'string' },
                }, ['notebook', 'path', 'title', 'tags', 'created', 'modified', 'chars', 'truncated', 'content']),
            },
            async run(args, signal) {
                const p = args.path ? String(args.path) : '';
                const q = args.query ? String(args.query) : '';
                if (!p && !q)
                    throw new ZkError('path 和 query 至少给一个');
                const cfg = config();
                await ensureNotebook(cfg);
                const doc = p ? await readNote(cfg, p, signal) : await findNote(cfg, q, signal);
                if (!doc)
                    throw new ZkError(`没找到匹配的笔记：${q}`, '换一个搜索词，或用 zk_search 先看看有哪些笔记');
                const limit = Math.min(200_000, Math.max(1000, Math.trunc(Number(args.maxChars ?? cfg.maxReadChars))));
                const truncated = doc.content.length > limit;
                return {
                    notebook: cfg.notebook,
                    path: doc.path,
                    title: doc.title,
                    tags: doc.tags,
                    created: dateOnly(doc.created),
                    modified: dateOnly(doc.modified),
                    chars: doc.content.length,
                    truncated,
                    content: truncated ? doc.content.slice(0, limit) : doc.content,
                };
            },
            render(_args, value) {
                const v = value;
                // 正文本身就带一级标题（zk 模板），别再重复一次；这一行只放元信息
                const head = [v.path, v.created].filter(Boolean).join(' · ');
                const cut = v.truncated ? `\n\n…（已截断：共 ${v.chars} 字，传 maxChars 可读更多）` : '';
                return text(`${head}${tagSuffix(v)}\n\n${v.content}${cut}`);
            },
        }),
        def({
            name: 'zk_new',
            description: '新建一篇笔记（zk 负责生成文件名、套用模板、写入索引）。适合记下一个概念、决定、来源或想法；' +
                '写前先 zk_search 查重。标题撞名会直接报错（不会被覆盖，也不会静默丢正文）。' +
                'tags 会写成 #hashtag；links 里的目标会被追加成 wiki 双链。',
            parameters: {
                type: 'object',
                properties: {
                    title: S.str('笔记标题（会成为一级标题）'),
                    body: S.str('正文 Markdown（可空）'),
                    tags: S.arr('标签（不写 #）。与设置里的默认标签合并', S.str('标签名')),
                    dir: S.str('放到哪个子目录（相对笔记本），默认用设置里的 notesDir'),
                    type: S.enum('笔记类型（写进 frontmatter；layered 结构下决定模板的分节）', ['source', 'concept', 'entity', 'pattern']),
                    authority: S.enum('可信度（写进 frontmatter，给未来的自己判断该不该引用）', ['official', 'expert', 'informal']),
                    group: S.str('zk 的 group 名（一般不用给：目录会自动匹配 group）'),
                    links: S.arr('要链接到的笔记（相对路径或标题）', S.str('目标笔记')),
                },
                required: ['title'],
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    path: { type: 'string' },
                    title: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    links: { type: 'array', items: { type: 'string' } },
                    warnings: { type: 'array', items: { type: 'string' } },
                }, ['notebook', 'path', 'title', 'tags', 'links', 'warnings']),
            },
            async run(args, signal) {
                const cfg = config();
                await ensureNotebook(cfg, signal);
                const tags = [...new Set([...(cfg.defaultTags ?? []), ...(Array.isArray(args.tags) ? args.tags.map(String) : [])])];
                const created = await createNote(cfg, {
                    title: String(args.title),
                    content: withTags(args.body ? String(args.body) : '', tags),
                    dir: args.dir ? String(args.dir) : cfg.notesDir,
                    group: args.group ? String(args.group) : undefined,
                    type: args.type ? String(args.type) : undefined,
                    authority: args.authority ? String(args.authority) : undefined,
                }, signal);
                const links = [];
                const warnings = [];
                for (const target of Array.isArray(args.links) ? args.links.map(String) : []) {
                    try {
                        const r = await linkNotes(cfg, created.path, target, signal);
                        links.push(r.link);
                    }
                    catch (err) {
                        // 笔记已经建好了：链接失败只降级成告警，不把整次写入判失败
                        warnings.push(`${target}：${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                return { notebook: cfg.notebook, path: created.path, title: created.title, tags, links, warnings };
            },
            render(_args, value) {
                const v = value;
                const lines = [`已记下「${v.title}」→ ${v.path}`];
                if (v.tags.length)
                    lines.push('标签：' + v.tags.map((t) => '#' + t).join(' '));
                if (v.links.length)
                    lines.push('双链：' + v.links.join(' '));
                if (v.warnings.length)
                    lines.push('⚠️ 链接没建成：' + v.warnings.join('；'));
                lines.push('笔记本：' + v.notebook);
                return text(lines.join('\n'));
            },
        }),
        def({
            name: 'zk_daily',
            description: '打开（不存在就创建）某一天的日记，并可追加一条带时间的记录。日记放在设置里的 dailyDir，文件名就是日期。' +
                '不给 date 就是今天。',
            parameters: {
                type: 'object',
                properties: {
                    entry: S.str('要追加的一段记录（Markdown）；不给就只返回日记路径'),
                    date: S.str('哪天：自然语言或日期（today / yesterday / 2026-01-01），默认今天'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    path: { type: 'string' },
                    created: { type: 'boolean' },
                    appended: { type: 'boolean' },
                }, ['notebook', 'path', 'created', 'appended']),
            },
            async run(args, signal) {
                const cfg = config();
                await ensureNotebook(cfg, signal);
                const daily = await ensureDailyNote(cfg, { date: args.date ? String(args.date) : undefined }, signal);
                const appended = Boolean(args.entry && String(args.entry).trim());
                if (appended)
                    appendDaily(cfg, daily.path, String(args.entry), new Date());
                return { notebook: cfg.notebook, path: daily.path, created: daily.created, appended };
            },
            render(_args, value) {
                const v = value;
                const state = v.created ? '新建' : '已有';
                return text(`日记 ${state} → ${v.path}${v.appended ? '（已追加一段）' : ''}\n笔记本：${v.notebook}`);
            },
        }),
        def({
            name: 'zk_append',
            description: '往一篇已有笔记末尾追加内容（自动补空行，可选先起一个二级标题）。适合补充证据、跟进结论、在会议记录里续写；' +
                '整篇重写请用编辑器，别用这个工具。',
            parameters: {
                type: 'object',
                properties: {
                    path: S.str('笔记的相对路径'),
                    text: S.str('要追加的 Markdown 内容'),
                    heading: S.str('可选：先写一个二级标题（如「后续」「2026-10-29 补充」）'),
                },
                required: ['path', 'text'],
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    path: { type: 'string' },
                    appendedChars: { type: 'number' },
                    bytes: { type: 'number' },
                }, ['notebook', 'path', 'appendedChars', 'bytes']),
            },
            async run(args) {
                const cfg = config();
                await ensureNotebook(cfg);
                const r = appendToNote(cfg, String(args.path), String(args.text), {
                    heading: args.heading ? String(args.heading) : undefined,
                });
                return { notebook: cfg.notebook, path: r.path, appendedChars: r.appendedChars, bytes: r.bytes };
            },
            render(_args, value) {
                const v = value;
                return text(`已追加 ${v.appendedChars} 字 → ${v.path}（现在 ${v.bytes} 字节）`);
            },
        }),
        def({
            name: 'zk_link',
            description: '在两篇笔记之间建立 wiki 双链：把 [[目标]] 追加到来源笔记的「Links」小节（已有「Links」或「链接」小节就写进去，不重复添加）。' +
                '目标可以给相对路径，也可以给标题。',
            parameters: {
                type: 'object',
                properties: {
                    from: S.str('来源笔记的相对路径'),
                    to: S.str('目标笔记：相对路径或标题'),
                },
                required: ['from', 'to'],
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                    link: { type: 'string' },
                    added: { type: 'boolean' },
                }, ['notebook', 'from', 'to', 'link', 'added']),
            },
            async run(args, signal) {
                const cfg = config();
                await ensureNotebook(cfg, signal);
                const r = await linkNotes(cfg, String(args.from), String(args.to), signal);
                return { notebook: cfg.notebook, from: r.from, to: r.to, link: r.link, added: r.added };
            },
            render(_args, value) {
                const v = value;
                return text(`${v.from} → ${v.link} ${v.added ? '已添加' : '已存在，没有重复添加'}`);
            },
        }),
        def({
            name: 'zk_supersede',
            description: '废弃一篇笔记：frontmatter 标 superseded、写入替代它的笔记、把指向它的双链改到归档路径、再把文件搬进 archive/（保留原相对路径）。' +
                '默认 dry_run: true，只返回受影响清单；确认后传 dry_run: false 才真改。结论变了（不是删掉，是过时）时用它。',
            parameters: {
                type: 'object',
                properties: {
                    path: S.str('要废弃的笔记（相对路径）'),
                    by: S.str('替代它的笔记（相对路径或标题）；不给 = 只废弃、没有接班人'),
                    dry_run: S.bool('true（默认）= 只出清单不改文件；false = 真的执行'),
                },
                required: ['path'],
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    path: { type: 'string' },
                    archivePath: { type: 'string' },
                    supersededBy: { type: 'string' },
                    dryRun: { type: 'boolean' },
                    performed: { type: 'boolean' },
                    alreadySuperseded: { type: 'boolean' },
                    rewrittenLinks: {
                        type: 'array',
                        items: objSchema({ path: { type: 'string' }, replaced: { type: 'number' } }, ['path', 'replaced']),
                    },
                    missingLinks: { type: 'array', items: { type: 'string' } },
                }, ['notebook', 'path', 'archivePath', 'supersededBy', 'dryRun', 'performed', 'alreadySuperseded', 'rewrittenLinks', 'missingLinks']),
            },
            async run(args, signal) {
                const cfg = config();
                await ensureNotebook(cfg, signal);
                const r = await supersedeNote(cfg, {
                    path: String(args.path),
                    by: args.by ? String(args.by) : undefined,
                    // 缺省是预演：一句「更新一下 wiki」不该让全库漂移（计划 D7）
                    dryRun: args.dry_run !== false,
                }, signal);
                return {
                    notebook: cfg.notebook,
                    path: r.path,
                    archivePath: r.archivePath,
                    supersededBy: r.supersededBy ?? '',
                    dryRun: r.dryRun,
                    performed: r.performed,
                    alreadySuperseded: r.alreadySuperseded,
                    rewrittenLinks: r.rewrittenLinks,
                    missingLinks: r.missingLinks,
                };
            },
            render(_args, value) {
                const v = value;
                if (v.alreadySuperseded)
                    return text(`「${v.path}」已经是 superseded，本次什么都没改。`);
                const lines = [];
                if (v.dryRun) {
                    lines.push(`预演（没有动任何文件）：${v.path} → ${v.archivePath}`);
                }
                else {
                    lines.push(`已归档：${v.path} → ${v.archivePath}`);
                }
                if (v.supersededBy)
                    lines.push(`接班人：${v.supersededBy}`);
                if (v.rewrittenLinks.length) {
                    lines.push(`${v.dryRun ? '将重写' : '已重写'} ${v.rewrittenLinks.length} 篇笔记的入链：`);
                    for (const item of v.rewrittenLinks)
                        lines.push(`  · ${item.path}（${item.replaced} 处）`);
                }
                else {
                    lines.push('没有需要重写的入链。');
                }
                if (v.missingLinks.length) {
                    lines.push('⚠️ 这些笔记有入链但写法不是 [[旧路径]]，没有自动改，需要人看一眼：' + v.missingLinks.join('、'));
                }
                if (v.dryRun)
                    lines.push('确认无误后传 dry_run: false 执行。');
                return text(lines.join('\n'));
            },
        }),
        def({
            name: 'zk_context',
            description: '读知识库根目录的长期约定与记忆（AGENTS.md / USER.md / MEMORY.md），按注入预算截断后返回。' +
                '宿主支持注入时这些内容每轮已自动进入系统提示；宿主不支持、或想核对「被截断了多少」时用它。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: {
                schema: objSchema({
                    text: { type: 'string' },
                    words: { type: 'number' },
                    budget: { type: 'number' },
                    truncatedWords: { type: 'number' },
                    files: {
                        type: 'array',
                        items: objSchema({
                            name: { type: 'string' },
                            present: { type: 'boolean' },
                            words: { type: 'number' },
                        }, ['name', 'present', 'words']),
                    },
                }, ['text', 'words', 'budget', 'truncatedWords', 'files']),
            },
            async run() {
                // 不 ensureNotebook：读记忆不该依赖 zk，笔记本不存在时就是空载荷
                return buildMemoryPayload(config());
            },
            render(_args, value) {
                const v = value;
                if (!v.text)
                    return text(`知识库根目录没有 ${META_FILES.join(' / ')}（或都是空的）。`);
                return text(v.text);
            },
        }),
        def({
            name: 'zk_stats',
            description: '看一眼知识库现状：笔记数、标签数、断链数、孤立笔记数。适合开始工作前了解上下文规模。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    notes: { type: 'number' },
                    tags: { type: 'number' },
                    brokenLinks: { type: 'number' },
                    orphans: { type: 'number' },
                }, ['notebook', 'notes', 'tags', 'brokenLinks', 'orphans']),
            },
            async run(_args, signal) {
                const cfg = config();
                await ensureNotebook(cfg, signal);
                const stats = await notebookStats(cfg, signal);
                return { notebook: cfg.notebook, ...stats };
            },
            render(_args, value) {
                const v = value;
                return text(`笔记本 ${v.notebook}\n` +
                    `笔记 ${v.notes} 篇 · 标签 ${v.tags} 个 · 断链 ${v.brokenLinks} 篇 · 孤立 ${v.orphans} 篇`);
            },
        }),
    ];
}
/** 注册全部工具，返回撤销函数 */
export function registerZkTools(tools) {
    const disposers = buildTools().map((definition) => tools.register(definition));
    return () => { for (const dispose of disposers) {
        try {
            dispose();
        }
        catch { /* 已卸载 */ }
    } };
}
