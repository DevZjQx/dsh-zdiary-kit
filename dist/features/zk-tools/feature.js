/**
 * zk 工具（feature 的公共入口）：14 个模型可调用的工具，全部经 lib/zk.ts。
 *
 * 设计要点：
 *   · 除 zk_context（只读 meta 文件，不依赖 zk）外，每个工具进来先 ensureNotebook —— 第一次调用就自动建好笔记本，用户不用先点设置页；
 *   · 参数在 execute 里手动校验（DSH 对裸注册的工具不做输入校验）；
 *   · output.schema 只用 DSH 支持的子集（type/properties/required/items/enum + 注释）；
 *   · render 是纯函数：模型看到人话，程序拿到结构化值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, selectNotebook } from '../../config/store.js';
import { configFor, pinSession, sessionNotebook, sessionState } from '../../config/session.js';
import { defaultNotebook, expandHome, processWorkspace, resolveInWorkspace } from '../../config/paths.js';
import { S, validateArgs } from '../../lib/tool.js';
import { ensureNotebook } from '../../lib/notebook.js';
import { searchNotes, createNote, readNote, findNote, appendToNote, ensureDailyNote, appendDaily, linkNotes, withTags, notebookStats, supersedeNote, renameNote, hasNotebook, localDate as dateOnly, ZkError, } from '../../lib/zk.js';
import { buildMemoryPayload, META_FILES } from '../../lib/memory.js';
import { META_NAMES } from '../../lib/meta.js';
import { formatMemoryLinks, lintNotebook } from '../../lib/lint.js';
import { dreamNotebook } from '../../lib/dream.js';
const text = (value) => [{ type: 'text', text: value }];
const objSchema = (properties, required) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
});
/** lint 输出的三个共用形状（每类最多 50 条 + 总数） */
const LINT_ENTRY = objSchema({ title: { type: 'string' }, path: { type: 'string' } }, ['title', 'path']);
const LINT_BUCKET = objSchema({ total: { type: 'number' }, items: { type: 'array', items: LINT_ENTRY } }, ['total', 'items']);
const LINT_STALE = objSchema({
    total: { type: 'number' },
    items: {
        type: 'array',
        items: objSchema({ title: { type: 'string' }, path: { type: 'string' }, modified: { type: 'string' } }, ['title', 'path', 'modified']),
    },
}, ['total', 'items']);
const LINT_DUPLICATE = objSchema({
    total: { type: 'number' },
    items: {
        type: 'array',
        items: objSchema({ title: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, ['title', 'paths']),
    },
}, ['total', 'items']);
/** 记忆层体检：MEMORY.md / USER.md 里的来源链是否还指向活笔记 */
const LINT_MEMORY = objSchema({
    files: { type: 'number' },
    links: { type: 'number' },
    total: { type: 'number' },
    unlinked: { type: 'number' },
    items: {
        type: 'array',
        items: objSchema({
            source: { type: 'string' },
            entry: { type: 'string' },
            link: { type: 'string' },
            reason: { type: 'string', enum: ['missing', 'superseded'] },
            path: { type: 'string' },
        }, ['source', 'entry', 'link', 'reason', 'path']),
    },
}, ['files', 'links', 'total', 'unlinked', 'items']);
/** frontmatter 解析失败：这些笔记不在索引里，所以单列一桶（path 相对笔记本，不带 title） */
const LINT_PARSE = objSchema({
    total: { type: 'number' },
    items: {
        type: 'array',
        items: objSchema({ path: { type: 'string' }, reason: { type: 'string' } }, ['path', 'reason']),
    },
}, ['total', 'items']);
function fail(err) {
    if (err instanceof ZkError) {
        throw new Error(err.hint ? `${err.message}（${err.hint}）` : err.message);
    }
    throw err instanceof Error ? err : new Error(String(err));
}
/** 别的笔记本里有同一条相对路径吗 —— 路径找不到时给一句「这篇在 X 库里」 */
function elsewhere(cfg, workspace, rel) {
    const clean = String(rel ?? '').trim().replace(/\\/g, '/');
    if (!clean || path.isAbsolute(clean))
        return [];
    const hits = [];
    for (const [name, entry] of Object.entries(cfg.notebooks)) {
        if (name === cfg.active)
            continue;
        const raw = String(entry.path ?? '').trim();
        const base = raw ? resolveInWorkspace(expandHome(raw), workspace) : defaultNotebook(workspace);
        const abs = path.resolve(base, clean);
        // 只认同一个库内的路径：rel 里带 ../ 时不许拿它去探库外
        if (abs !== base && !abs.startsWith(base + path.sep))
            continue;
        try {
            if (fs.existsSync(abs))
                hits.push(name);
        }
        catch { /* 路径不可读：当没有 */ }
    }
    return hits;
}
/** 路径找不到时补一句跨库线索；别的错误原样返回 */
function withElsewhere(err, cfg, workspace, rel) {
    if (!(err instanceof ZkError))
        return err;
    const hits = elsewhere(cfg, workspace, rel);
    if (!hits.length)
        return err;
    const extra = `同名笔记在笔记本「${hits.join('」「')}」里，当前会话用的是「${cfg.active}」`;
    return new ZkError(err.message, err.hint ? `${err.hint}；${extra}` : extra);
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
function def(spec, workspaceOf) {
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
                return await spec.run((args ?? {}), {
                    signal: exec?.signal,
                    workspace: workspaceOf(exec),
                    sessionId: exec?.agent?.id,
                });
            }
            catch (err) {
                return fail(err);
            }
        },
    };
}
export function buildTools(workspaceOf = () => processWorkspace()) {
    const t = (spec) => def(spec, workspaceOf);
    return [
        t({
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
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
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
        t({
            name: 'zk_query',
            description: '结构化检索记忆：按 type（daily/source/concept/entity/pattern）、status（active/superseded）、标签、目录、日期、断链、孤立过滤。' +
                '默认只看 active 且不含归档；传 include_archived: true 会连归档一起查，此时未显式给 status 就不再默认过滤 active。' +
                '这是查「记忆里有什么」的主入口。',
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
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const includeArchived = args.include_archived === true;
                const notes = await searchNotes(cfg, {
                    query: args.query ? String(args.query) : undefined,
                    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
                    paths: Array.isArray(args.dirs) ? args.dirs.map(String) : undefined,
                    type: args.type ? [String(args.type)] : undefined,
                    // 默认只给活着的；显式 include_archived 时连 superseded 一起看（不再默认卡 active）
                    status: args.status ? [String(args.status)] : includeArchived ? undefined : ['active'],
                    since: args.since ? String(args.since) : undefined,
                    until: args.until ? String(args.until) : undefined,
                    orphan: args.orphan === true,
                    brokenLinks: args.brokenLinks === true,
                    includeArchived,
                    limit: args.limit === undefined ? 10 : Number(args.limit),
                    sort: args.sort ? String(args.sort) : 'created-desc',
                }, env.signal);
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
        t({
            name: 'zk_read',
            description: '读一篇笔记的全文（或先按搜索词找到最相关的一篇再读）。路径是相对笔记本根目录的路径，如 notes/ab12.md。' +
                '也可以读根目录的 meta 文件（MEMORY.md / USER.md），注入时被截掉的段落用这个取回。' +
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
            async run(args, env) {
                const p = args.path ? String(args.path) : '';
                const q = args.query ? String(args.query) : '';
                if (!p && !q)
                    throw new ZkError('path 和 query 至少给一个');
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg);
                let doc;
                try {
                    doc = p ? await readNote(cfg, p, env.signal) : await findNote(cfg, q, env.signal);
                }
                catch (err) {
                    throw withElsewhere(err, cfg, env.workspace, p);
                }
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
        t({
            name: 'zk_new',
            description: '新建一篇笔记（zk 负责生成文件名、套用模板、写入索引）。适合记下一个概念、决定、来源或想法；' +
                '写前先 zk_search 查重。标题重复会直接报错（flat 按标题查重，layered 同目录同名 slug 也会被 zk 拒绝）。' +
                '归档里有同名旧结论不会拦，但会放进 archived（带 supersede-reason）：先读它，别把同一个错误结论重新提出来。' +
                'type / authority 只有 layered 模板会写进 frontmatter。tags 会写成 #hashtag；links 里的目标会被追加成 wiki 双链。',
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
                    archived: {
                        type: 'array',
                        items: objSchema({
                            path: { type: 'string' },
                            title: { type: 'string' },
                            reason: { type: 'string' },
                        }, ['path', 'title', 'reason']),
                    },
                    warnings: { type: 'array', items: { type: 'string' } },
                }, ['notebook', 'path', 'title', 'tags', 'links', 'archived', 'warnings']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const tags = [...new Set([...(cfg.defaultTags ?? []), ...(Array.isArray(args.tags) ? args.tags.map(String) : [])])];
                const created = await createNote(cfg, {
                    title: String(args.title),
                    content: withTags(args.body ? String(args.body) : '', tags),
                    dir: args.dir ? String(args.dir) : cfg.notesDir,
                    group: args.group ? String(args.group) : undefined,
                    type: args.type ? String(args.type) : undefined,
                    authority: args.authority ? String(args.authority) : undefined,
                }, env.signal);
                const links = [];
                const warnings = [];
                for (const target of Array.isArray(args.links) ? args.links.map(String) : []) {
                    try {
                        const r = await linkNotes(cfg, created.path, target, env.signal);
                        links.push(r.link);
                    }
                    catch (err) {
                        // 笔记已经建好了：链接失败只降级成告警，不把整次写入判失败
                        warnings.push(`${target}：${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                // 归档同名只是提醒：zk_new 的查重本来就不含 archive，允许复用标题 —— 但要把废弃原因一起交出来
                // （createNote 建之前那次全库扫描已经算好了，这里不再单独跑一次 zk）
                const archived = created.archived;
                return { notebook: cfg.notebook, path: created.path, title: created.title, tags, links, archived, warnings };
            },
            render(_args, value) {
                const v = value;
                const lines = [`已记下「${v.title}」→ ${v.path}`];
                if (v.tags.length)
                    lines.push('标签：' + v.tags.map((t) => '#' + t).join(' '));
                if (v.links.length)
                    lines.push('双链：' + v.links.join(' '));
                if (v.archived.length) {
                    lines.push('⚠️ 归档里有同名旧结论：' + v.archived.map((h) => h.path + (h.reason ? `（废弃原因：${h.reason}）` : '（没有记录废弃原因）')).join('；') +
                        ' —— 先读它，确认不是同一个结论再复用标题');
                }
                if (v.warnings.length)
                    lines.push('⚠️ 链接没建成：' + v.warnings.join('；'));
                lines.push('笔记本：' + v.notebook);
                return text(lines.join('\n'));
            },
        }),
        t({
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
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const daily = await ensureDailyNote(cfg, { date: args.date ? String(args.date) : undefined }, env.signal);
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
        t({
            name: 'zk_append',
            description: '往一篇已有笔记末尾追加内容（自动补空行，可选先起一个二级标题）。适合补充证据、跟进结论、在会议记录里续写；' +
                `整篇重写请用编辑器，别用这个工具。根目录的 ${META_NAMES.join(' / ')} 是 meta 文件，会被拒绝。`,
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
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg);
                let r;
                try {
                    r = appendToNote(cfg, String(args.path), String(args.text), {
                        heading: args.heading ? String(args.heading) : undefined,
                    });
                }
                catch (err) {
                    throw withElsewhere(err, cfg, env.workspace, String(args.path));
                }
                return { notebook: cfg.notebook, path: r.path, appendedChars: r.appendedChars, bytes: r.bytes };
            },
            render(_args, value) {
                const v = value;
                return text(`已追加 ${v.appendedChars} 字 → ${v.path}（现在 ${v.bytes} 字节）`);
            },
        }),
        t({
            name: 'zk_link',
            description: '在两篇笔记之间建立 wiki 双链：把 [[目标]] 追加到来源笔记末尾（已有「Links」或「链接」小节就不再重复起标题；不保证插进该小节内部），已存在不重复添加。' +
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
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const r = await linkNotes(cfg, String(args.from), String(args.to), env.signal);
                return { notebook: cfg.notebook, from: r.from, to: r.to, link: r.link, added: r.added };
            },
            render(_args, value) {
                const v = value;
                return text(`${v.from} → ${v.link} ${v.added ? '已添加' : '已存在，没有重复添加'}`);
            },
        }),
        t({
            name: 'zk_supersede',
            description: '废弃一篇笔记：frontmatter 标 superseded、写入替代它的笔记、把能精确匹配的 [[旧路径]] 入链改到归档路径、再把文件搬进 archive/（保留原相对路径；其它写法的入链列进 missingLinks）。' +
                '默认 dry_run: true，只返回受影响清单；确认后传 dry_run: false 才真改。结论变了（不是删掉，是过时）时用它。' +
                'reason 会写进归档 frontmatter 的 supersede-reason：下次有人建同名笔记时会被带出来，防止同一个错误结论被重新提出。',
            parameters: {
                type: 'object',
                properties: {
                    path: S.str('要废弃的笔记（相对路径）'),
                    by: S.str('替代它的笔记（相对路径或标题）；不给 = 只废弃、没有接班人'),
                    reason: S.str('为什么废弃（一句话、单行；写进归档 frontmatter，≤200 字）'),
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
                    reason: { type: 'string' },
                    dryRun: { type: 'boolean' },
                    performed: { type: 'boolean' },
                    alreadySuperseded: { type: 'boolean' },
                    rewrittenLinks: {
                        type: 'array',
                        items: objSchema({ path: { type: 'string' }, replaced: { type: 'number' } }, ['path', 'replaced']),
                    },
                    missingLinks: { type: 'array', items: { type: 'string' } },
                }, ['notebook', 'path', 'archivePath', 'supersededBy', 'reason', 'dryRun', 'performed', 'alreadySuperseded', 'rewrittenLinks', 'missingLinks']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const r = await supersedeNote(cfg, {
                    path: String(args.path),
                    by: args.by ? String(args.by) : undefined,
                    reason: args.reason ? String(args.reason) : undefined,
                    // 缺省是预演：一句「更新一下 wiki」不该让全库漂移（计划 D7）
                    dryRun: args.dry_run !== false,
                }, env.signal);
                return {
                    notebook: cfg.notebook,
                    path: r.path,
                    archivePath: r.archivePath,
                    supersededBy: r.supersededBy ?? '',
                    reason: r.reason ?? '',
                    dryRun: r.dryRun,
                    performed: r.performed,
                    alreadySuperseded: r.alreadySuperseded,
                    rewrittenLinks: r.rewrittenLinks,
                    missingLinks: r.missingLinks,
                };
            },
            render(_args, value) {
                const v = value;
                if (v.alreadySuperseded) {
                    return text(`「${v.path}」已经是 superseded，本次什么都没改。` +
                        (v.reason ? `\n废弃原因：${v.reason}` : ''));
                }
                const lines = [];
                if (v.dryRun) {
                    lines.push(`预演（没有动任何文件）：${v.path} → ${v.archivePath}`);
                }
                else {
                    lines.push(`已归档：${v.path} → ${v.archivePath}`);
                }
                if (v.supersededBy)
                    lines.push(`接班人：${v.supersededBy}`);
                if (v.reason)
                    lines.push(`${v.dryRun ? '将记录' : '已记录'}废弃原因：${v.reason}`);
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
        t({
            name: 'zk_rename',
            description: '给笔记改名 / 换目录，并修好改名带来的断链：入链（[[…]] 与 Markdown 链接，保留 #锚点 与 |别名）按实际解析结果改到新路径，' +
                '根目录 meta 文件与归档笔记里的 [[来源]] 一起改；被搬走那篇自己的相对链接也会按新位置重算。认不出的写法列进 missingLinks，不猜。' +
                '默认 dry_run: true，只返回受影响清单；确认后传 dry_run: false 才真改。改名后 zk_daily 的日记、archive/ 里的笔记、raw/ 与 meta 文件都不许动。',
            parameters: {
                type: 'object',
                properties: {
                    path: S.str('要改名的笔记（当前相对路径）'),
                    to: S.str('新路径：相对笔记本；只给文件名 = 留在原目录；以 / 结尾 = 放进那个目录并保留原文件名'),
                    dry_run: S.bool('true（默认）= 只出清单不改文件；false = 真的执行'),
                },
                required: ['path', 'to'],
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    path: { type: 'string' },
                    newPath: { type: 'string' },
                    dryRun: { type: 'boolean' },
                    performed: { type: 'boolean' },
                    rewrittenLinks: {
                        type: 'array',
                        items: objSchema({ path: { type: 'string' }, replaced: { type: 'number' } }, ['path', 'replaced']),
                    },
                    missingLinks: { type: 'array', items: { type: 'string' } },
                    selfRewritten: { type: 'number' },
                }, ['notebook', 'path', 'newPath', 'dryRun', 'performed', 'rewrittenLinks', 'missingLinks', 'selfRewritten']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const r = await renameNote(cfg, {
                    path: String(args.path),
                    to: String(args.to),
                    // 缺省是预演：改名会同时改别的笔记，不该一次说错就全库漂移
                    dryRun: args.dry_run !== false,
                }, env.signal);
                return {
                    notebook: cfg.notebook,
                    path: r.path,
                    newPath: r.newPath,
                    dryRun: r.dryRun,
                    performed: r.performed,
                    rewrittenLinks: r.rewrittenLinks,
                    missingLinks: r.missingLinks,
                    selfRewritten: r.selfRewritten,
                };
            },
            render(_args, value) {
                const v = value;
                const lines = [];
                lines.push(v.dryRun
                    ? `预演（没有动任何文件）：${v.path} → ${v.newPath}`
                    : `已改名：${v.path} → ${v.newPath}`);
                if (v.rewrittenLinks.length) {
                    lines.push(`${v.dryRun ? '将重写' : '已重写'} ${v.rewrittenLinks.length} 篇笔记的入链：`);
                    for (const item of v.rewrittenLinks)
                        lines.push(`  · ${item.path}（${item.replaced} 处）`);
                }
                else {
                    lines.push('没有需要重写的入链。');
                }
                if (v.selfRewritten > 0) {
                    lines.push(`它自己正文里的 ${v.selfRewritten} 条相对链接已按新位置重算。`);
                }
                if (v.missingLinks.length) {
                    lines.push('⚠️ 这些笔记有入链但没找到能改写的写法，需要人看一眼：' + v.missingLinks.join('、'));
                }
                if (v.dryRun)
                    lines.push('确认无误后传 dry_run: false 执行。');
                return text(lines.join('\n'));
            },
        }),
        t({
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
                    tocWords: { type: 'number' },
                    notebook: { type: 'string' },
                    defaultNotebook: { type: 'string' },
                    pinned: { type: 'string' },
                    files: {
                        type: 'array',
                        items: objSchema({
                            name: { type: 'string' },
                            present: { type: 'boolean' },
                            words: { type: 'number' },
                            originalWords: { type: 'number' },
                        }, ['name', 'present', 'words', 'originalWords']),
                    },
                }, ['text', 'words', 'budget', 'truncatedWords', 'tocWords', 'notebook', 'defaultNotebook', 'pinned', 'files']),
            },
            async run(_args, env) {
                // 不 ensureNotebook：读记忆不该依赖 zk，笔记本不存在时就是空载荷
                const state = sessionState(env.workspace, env.sessionId);
                return {
                    ...buildMemoryPayload(configFor(env.workspace, env.sessionId)),
                    notebook: state.active,
                    defaultNotebook: state.defaultName,
                    pinned: state.diverged ? state.pinned : '',
                };
            },
            render(_args, value) {
                const v = value;
                // 别的会话切过全局默认、而本会话还钉在原库时，先把这件事说破
                const drift = v.pinned && v.pinned !== v.defaultNotebook
                    ? `本会话固定在「${v.pinned}」；全局默认已改为「${v.defaultNotebook}」—— 要跟随用 zk_use ${v.defaultNotebook}\n\n`
                    : '';
                if (!v.text)
                    return text(drift + `知识库根目录没有 ${META_FILES.join(' / ')}（或都是空的）。`);
                return text(drift + v.text);
            },
        }),
        t({
            name: 'zk_lint',
            description: '给知识库做体检：断链 / 孤儿 / 无标签 / 单向链接 / 陈旧（N 天没改）/ 重名标题，每类最多 50 条并给总数。' +
                'frontmatter 解析失败的笔记单列一类：它们进不了索引，别的项统计不到，先修它们再看其余。' +
                'memoryLinks 查 MEMORY.md / USER.md 里的 [[来源链接]] 是否还指向活笔记（已废弃 / 不存在）—— ' +
                'supersede 不会重写 meta 文件里的链接，这类漂移 broken-links 看不见。' +
                '孤儿与无标签不含日记（按天写的日记天然如此，报出来只会淹没真问题）。' +
                'oneWayLinks = S 链 X 但 X 没回链 S，且 S 不是日记 —— 日记天然是出边，回链它没有意义。' +
                '只读：不改任何笔记。拿到清单后自己判断先修哪个，再用 zk_link / zk_append / zk_supersede 动手。',
            parameters: {
                type: 'object',
                properties: {
                    stale_days: S.num('多少天没修改算陈旧（1-3650，默认 90）'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    notes: { type: 'number' },
                    truncated: { type: 'boolean' },
                    staleDays: { type: 'number' },
                    parseErrors: LINT_PARSE,
                    orphans: LINT_BUCKET,
                    brokenLinks: LINT_BUCKET,
                    stale: LINT_STALE,
                    tagless: LINT_BUCKET,
                    oneWayLinks: LINT_BUCKET,
                    duplicateTitles: LINT_DUPLICATE,
                    memoryLinks: LINT_MEMORY,
                }, ['notebook', 'notes', 'truncated', 'staleDays', 'parseErrors', 'orphans', 'brokenLinks', 'stale', 'tagless', 'oneWayLinks', 'duplicateTitles', 'memoryLinks']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                return lintNotebook(cfg, {
                    staleDays: args.stale_days === undefined ? undefined : Number(args.stale_days),
                }, env.signal);
            },
            render(_args, value) {
                const v = value;
                const sample = (items) => {
                    const head = items.slice(0, 5).map((n) => n.path).join('、');
                    return items.length > 5 ? head + ' …' : head;
                };
                const line = (label, bucket) => bucket.total === 0 ? '✓ ' + label + '：0' : '✗ ' + label + '：' + bucket.total + ' 篇 — ' + sample(bucket.items);
                const lines = ['体检 ' + v.notebook + '：' + v.notes + ' 篇笔记（陈旧阈值 ' + v.staleDays + ' 天）'];
                lines.push(v.parseErrors.total === 0
                    ? '✓ 解析失败：0'
                    : '✗ 解析失败：' + v.parseErrors.total + ' 篇 — ' +
                        v.parseErrors.items.slice(0, 5).map((e) => e.path + '（' + e.reason + '）').join('、') +
                        (v.parseErrors.total > 5 ? ' …' : '') +
                        '｜这些笔记没进索引：搜不到，也不进别的项；修好 frontmatter 重跑一次');
                lines.push(line('断链', v.brokenLinks));
                lines.push(line('孤儿', v.orphans));
                lines.push(line('无标签', v.tagless));
                lines.push(line('单向链接', v.oneWayLinks));
                lines.push(v.stale.total === 0
                    ? '✓ 陈旧：0'
                    : '✗ 陈旧：' + v.stale.total + ' 篇 — ' +
                        v.stale.items.slice(0, 5).map((s) => s.path + '（' + s.modified + '）').join('、') +
                        (v.stale.total > 5 ? ' …' : ''));
                lines.push(v.duplicateTitles.total === 0
                    ? '✓ 重名标题：0'
                    : '✗ 重名标题：' + v.duplicateTitles.total + ' 组 — ' +
                        v.duplicateTitles.items.slice(0, 3).map((d) => '「' + d.title + '」→ ' + d.paths.join(' / ')).join('；'));
                const memLine = formatMemoryLinks(v.memoryLinks);
                if (memLine)
                    lines.push(memLine);
                if (v.truncated)
                    lines.push('⚠️ 笔记数触到扫描上限：结果不完整，先归档旧笔记再跑一次');
                lines.push('（只报告，没有改动任何文件）');
                return text(lines.join('\n'));
            },
        }),
        t({
            name: 'zk_dream',
            description: '整理晋升材料：最近 N 天新增的笔记（机械筛掉 authority=informal 与无标签的，其余作为候选）、' +
                'daily 里没划掉的 Loose ends、被引用最多的笔记。候选带正文摘要（lead）与入链来源（citedBy），方便重放上下文。' +
                '只返回材料：写 MEMORY.md / DREAMS.md 由你按 AGENTS.md 决定，这个工具不写任何文件。',
            parameters: {
                type: 'object',
                properties: {
                    days: S.num('看最近多少天（1-365，默认 7）'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    windowDays: { type: 'number' },
                    since: { type: 'string' },
                    truncated: { type: 'boolean' },
                    counts: objSchema({
                        window: { type: 'number' },
                        daily: { type: 'number' },
                        candidates: { type: 'number' },
                        rejected: { type: 'number' },
                        looseEnds: { type: 'number' },
                    }, ['window', 'daily', 'candidates', 'rejected', 'looseEnds']),
                    newNotes: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            type: { type: 'string' },
                            authority: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                            created: { type: 'string' },
                            lead: { type: 'string' },
                            cited: { type: 'number' },
                            citedBy: { type: 'array', items: { type: 'string' } },
                        }, ['title', 'path', 'type', 'authority', 'tags', 'created', 'lead', 'cited', 'citedBy']),
                    },
                    rejected: {
                        type: 'array',
                        items: objSchema({ title: { type: 'string' }, path: { type: 'string' }, reason: { type: 'string' } }, ['title', 'path', 'reason']),
                    },
                    topCited: {
                        type: 'array',
                        items: objSchema({ title: { type: 'string' }, path: { type: 'string' }, cited: { type: 'number' } }, ['title', 'path', 'cited']),
                    },
                    dailyLooseEnds: {
                        type: 'array',
                        items: objSchema({
                            path: { type: 'string' },
                            date: { type: 'string' },
                            items: { type: 'array', items: { type: 'string' } },
                        }, ['path', 'date', 'items']),
                    },
                }, ['notebook', 'windowDays', 'since', 'truncated', 'counts', 'newNotes', 'rejected', 'topCited', 'dailyLooseEnds']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                return dreamNotebook(cfg, { days: args.days === undefined ? undefined : Number(args.days) }, env.signal);
            },
            render(_args, value) {
                const v = value;
                const lines = [
                    '做梦：近 ' + v.windowDays + ' 天（自 ' + v.since + '）— 窗口 ' + v.counts.window +
                        ' 篇（日记 ' + v.counts.daily + '）· 候选 ' + v.counts.candidates + ' · 拒绝 ' + v.counts.rejected +
                        ' · 未完成 ' + v.counts.looseEnds,
                ];
                if (v.newNotes.length) {
                    lines.push('晋升候选：');
                    for (const [i, n] of v.newNotes.slice(0, 10).entries()) {
                        const badges = [n.type || '—', n.authority || '—'].join(' · ');
                        const lead = n.lead ? '\n     ' + n.lead : '';
                        const citedBy = n.citedBy.length ? '\n     被引：' + n.citedBy.join('、') : '';
                        lines.push('  ' + (i + 1) + '. ' + (n.title || n.path) + '  [' + badges + ']  ' + n.path +
                            (n.tags.length ? ' · ' + n.tags.map((t) => '#' + t).join(' ') : '') +
                            ' · 被引 ' + n.cited + lead + citedBy);
                    }
                    if (v.newNotes.length > 10)
                        lines.push('  …还有 ' + (v.newNotes.length - 10) + ' 篇');
                }
                if (v.rejected.length) {
                    lines.push('机械拒绝（不进候选）：');
                    for (const r of v.rejected.slice(0, 10))
                        lines.push('  · ' + (r.title || r.path) + '（' + r.path + '）：' + r.reason);
                    if (v.rejected.length > 10)
                        lines.push('  …还有 ' + (v.rejected.length - 10) + ' 篇');
                }
                if (v.dailyLooseEnds.length) {
                    lines.push('未完成（daily）：');
                    for (const d of v.dailyLooseEnds.slice(0, 10))
                        lines.push('  · ' + d.path + '：' + d.items.join('；'));
                }
                if (v.topCited.length) {
                    lines.push('被引用最多：');
                    for (const [i, c] of v.topCited.slice(0, 5).entries())
                        lines.push('  ' + (i + 1) + '. ' + (c.title || c.path) + '（' + c.path + '）· ' + c.cited + ' 次');
                }
                if (!v.newNotes.length && !v.dailyLooseEnds.length && !v.topCited.length)
                    lines.push('这个窗口里没有新材料。');
                if (v.truncated)
                    lines.push('⚠️ 笔记数触到扫描上限：窗口与排名都不完整');
                lines.push('（只报告：MEMORY.md / DREAMS.md 由你按 AGENTS.md 写）');
                return text(lines.join('\n'));
            },
        }),
        t({
            name: 'zk_stats',
            description: '看一眼知识库现状：笔记数、标签数、断链数、孤立笔记数、已归档（superseded）数。适合开始工作前了解上下文规模。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    defaultNotebook: { type: 'string' },
                    pinned: { type: 'string' },
                    notes: { type: 'number' },
                    tags: { type: 'number' },
                    brokenLinks: { type: 'number' },
                    orphans: { type: 'number' },
                    archived: { type: 'number' },
                    superseded: { type: 'number' },
                }, ['notebook', 'defaultNotebook', 'pinned', 'notes', 'tags', 'brokenLinks', 'orphans', 'archived', 'superseded']),
            },
            async run(_args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const stats = await notebookStats(cfg, env.signal);
                const state = sessionState(env.workspace, env.sessionId);
                return {
                    notebook: cfg.notebook,
                    defaultNotebook: state.defaultName,
                    pinned: state.diverged ? state.pinned : '',
                    ...stats,
                };
            },
            render(_args, value) {
                const v = value;
                const drift = v.pinned && v.pinned !== v.defaultNotebook
                    ? `\n本会话固定在「${v.pinned}」；全局默认是「${v.defaultNotebook}」（要跟随用 zk_use ${v.defaultNotebook}）`
                    : '';
                return text(`笔记本 ${v.notebook}${drift}\n` +
                    `笔记 ${v.notes} 篇 · 标签 ${v.tags} 个 · 断链 ${v.brokenLinks} 篇 · 孤立 ${v.orphans} 篇 · 归档 ${v.archived} 篇（superseded ${v.superseded}）`);
            },
        }),
        t({
            name: 'zk_use',
            description: '切换「本会话」使用的笔记本：只影响当前会话，不改全局默认，也不动别的会话。' +
                '设置页 / zk-kit notebooks use 改的是**新会话的默认值** —— 已经跑着的会话要跟过去，用这个工具。' +
                '不带参数时列出所有笔记本，并说明本会话固定在哪一本。',
            parameters: {
                type: 'object',
                properties: {
                    notebook: S.str('要切换到的笔记本名；省略 = 只看不改'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    changed: { type: 'boolean' },
                    notebook: { type: 'string' },
                    path: { type: 'string' },
                    pinned: { type: 'string' },
                    defaultNotebook: { type: 'string' },
                    notebooks: { type: 'array', items: { type: 'string' } },
                    initialized: { type: 'boolean' },
                    warn: { type: 'string' },
                }, ['changed', 'notebook', 'path', 'pinned', 'defaultNotebook', 'notebooks', 'initialized', 'warn']),
            },
            async run(args, env) {
                const current = configFor(env.workspace, env.sessionId);
                const defaultName = config(env.workspace).active;
                const names = Object.keys(current.notebooks);
                const wanted = String(args.notebook ?? '').trim();
                if (!wanted) {
                    return {
                        changed: false,
                        notebook: current.active,
                        path: current.notebook,
                        pinned: sessionNotebook(env.sessionId) ?? '',
                        defaultNotebook: defaultName,
                        notebooks: names,
                        initialized: false,
                        warn: '',
                    };
                }
                if (!env.sessionId) {
                    throw new ZkError('拿不到会话 id，无法只切本会话', '改全局默认用 zk-kit notebooks use <名>；它只影响之后新建的会话');
                }
                if (!(wanted in current.notebooks)) {
                    throw new ZkError(`没有这个笔记本：${wanted}`, `现有：${names.join('、')}；新目录先在设置页或 zk-kit notebooks add 里加进来`);
                }
                pinSession(env.sessionId, wanted, env.workspace);
                const target = selectNotebook(current, wanted, env.workspace);
                let initialized = false;
                let warn = '';
                // 和设置页切库一致：目标还不是 zk 笔记本就顺手建好；失败只告警，切换本身已生效
                if (!hasNotebook(target)) {
                    try {
                        await ensureNotebook(target, env.signal);
                        initialized = true;
                    }
                    catch (err) {
                        warn = '已切换，但自动初始化失败：' + (err instanceof Error ? err.message : String(err)) +
                            ' —— 在设置页点「初始化 / 补建」重试';
                    }
                }
                return {
                    changed: wanted !== current.active,
                    notebook: wanted,
                    path: target.notebook,
                    pinned: wanted,
                    defaultNotebook: defaultName,
                    notebooks: names,
                    initialized,
                    warn,
                };
            },
            render(_args, value) {
                const v = value;
                const lines = [];
                if (v.changed)
                    lines.push(`✓ 本会话已切到「${v.notebook}」${v.initialized ? '（已初始化）' : ''}`);
                else
                    lines.push(`本会话笔记本：${v.notebook}`);
                if (v.path)
                    lines.push('路径：' + v.path);
                lines.push('可用的：' + v.notebooks.join('、'));
                if (v.pinned && v.defaultNotebook && v.pinned !== v.defaultNotebook) {
                    lines.push(`全局默认是「${v.defaultNotebook}」；本会话固定在「${v.pinned}」`);
                }
                if (v.warn)
                    lines.push('⚠️ ' + v.warn);
                return text(lines.join('\n'));
            },
        }),
    ];
}
/** 注册全部工具，返回撤销函数（workspaceOf 由 app 注入：会话 cwd 优先） */
export function registerZkTools(tools, workspaceOf) {
    const disposers = buildTools(workspaceOf).map((definition) => tools.register(definition));
    return () => { for (const dispose of disposers) {
        try {
            dispose();
        }
        catch { /* 已卸载 */ }
    } };
}
