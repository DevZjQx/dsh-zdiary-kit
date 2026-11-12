/**
 * zk 工具（feature 的公共入口）：16 个内置工具 + `[alias]` 别名工具，全部经 lib/zk.ts。
 *
 * 设计要点：
 *   · 除 zk_context（只读 meta 文件，不依赖 zk）外，每个工具进来先 ensureNotebook —— 第一次调用就自动建好笔记本，用户不用先点设置页；
 *   · 参数在 execute 里手动校验（DSH 对裸注册的工具不做输入校验）；
 *   · output.schema 只用 DSH 支持的子集（type/properties/required/items/enum + 注释）；
 *   · render 是纯函数：模型看到人话，程序拿到结构化值；
 *   · 别名工具在注册时按 `.zk/config.toml` 的 `[alias]` 追加，执行交给 `zk <别名>`（插件不拼 shell）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, notebookInfos, selectNotebook } from '../../config/store.js';
import { configFor, pinSession, sessionNotebook, sessionState } from '../../config/session.js';
import { defaultNotebook, expandHome, processWorkspace, resolveInWorkspace } from '../../config/paths.js';
import { S, validateArgs } from '../../lib/tool.js';
import { ensureNotebook, newNoteDir } from '../../lib/notebook.js';
import { searchNotes, searchNotesDetailed, createNote, appendToNote, ensureDailyNote, appendDaily, linkNotes, withTags, taglessCjkWarning, notebookStats, supersedeNote, renameNote, hasNotebook, isUnderDir, localDate as dateOnly, runAlias, hasCjk, walkFrom, scanNotes, ZkError, } from '../../lib/zk.js';
import { configuredAliases, readAliases } from '../../lib/alias.js';
import { buildMemoryPayload, memoryCapacity, META_FILES } from '../../lib/memory.js';
import { assembleRecall } from '../../lib/recall.js';
import { entryPointLines, entryPointsOf } from '../../lib/entry-points.js';
import { archivedCounterparts, describeCounterEntries } from '../../lib/archive-probe.js';
import { bumpUsage, readUsage } from '../../lib/usage.js';
import { bumpRecall } from '../../lib/recall-signal.js';
import { wikiIndex } from '../../lib/wikilink.js';
import { writeMemory } from '../../lib/memory-write.js';
import { META_NAMES } from '../../lib/meta.js';
import { formatLintExtras, formatMemoryLinks, lintNotebook } from '../../lib/lint.js';
import { dreamNotebook, STALE_DAYS } from '../../lib/dream.js';
const text = (value) => [{ type: 'text', text: value }];
/** render 的 args 是 unknown：只取 query 判断要不要给中文 0 命中提示（R7） */
const queryOf = (args) => {
    if (!args || typeof args !== 'object')
        return '';
    return String(args.query ?? '');
};
/** R7：中文 0 命中的「为什么空」提示；ASCII / 无 query 不加 */
const zeroHitHint = (args, extra) => hasCjk(queryOf(args)) ? `；中文全文不切词：换更短的词，${extra}` : '';
const objSchema = (properties, required) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
});
/** lint 输出的三个共用形状（每类最多 50 条 + 总数） */
const LINT_ENTRY = objSchema({ title: { type: 'string' }, path: { type: 'string' } }, ['title', 'path']);
/** R9：MEMORY.md 的活条目 → 入口（`via: query` 的来源可以不在本次结果里） */
const ENTRY_POINT = objSchema({
    entry: { type: 'string' },
    title: { type: 'string' },
    path: { type: 'string' },
    absPath: { type: 'string' },
    via: { type: 'string', enum: ['query', 'result'] },
    /** false = 标题 / id 写法且不在本批结果里：只有入口名，落地交给 zk_walk */
    resolved: { type: 'boolean' },
}, ['entry', 'title', 'via', 'resolved']);
/** 死胡同探针：归档里同名的废弃结论（不是第二份结果列表） */
const COUNTER_ENTRY = objSchema({
    matched: { type: 'string' },
    title: { type: 'string' },
    path: { type: 'string' },
    absPath: { type: 'string' },
    reason: { type: 'string' },
    supersededBy: { type: 'string' },
    score: { type: 'number' },
}, ['matched', 'title', 'path', 'absPath', 'reason', 'supersededBy', 'score']);
const LINT_BUCKET = objSchema({ total: { type: 'number' }, items: { type: 'array', items: LINT_ENTRY } }, ['total', 'items']);
const LINT_ONE_WAY_ITEM = objSchema({
    title: { type: 'string' },
    path: { type: 'string' },
    from: { type: 'array', items: { type: 'string' } },
    where: { type: 'string', enum: ['links', 'body', 'mixed'] },
}, ['title', 'path', 'from', 'where']);
const LINT_ONE_WAY = objSchema({
    total: { type: 'number' },
    edges: { type: 'number' },
    bodyOnly: { type: 'number' },
    linksOnly: { type: 'boolean' },
    edgesTruncated: { type: 'boolean' },
    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
    items: { type: 'array', items: LINT_ONE_WAY_ITEM },
}, ['total', 'edges', 'bodyOnly', 'linksOnly', 'edgesTruncated', 'completeness', 'items']);
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
/** 疑似重复标题（P2-10）：只差一两个字 */
const LINT_SIMILAR = objSchema({
    total: { type: 'number' },
    truncated: { type: 'boolean' },
    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
    droppedGroups: { type: 'number' },
    items: {
        type: 'array',
        items: objSchema({
            titles: { type: 'array', items: { type: 'string' } },
            paths: { type: 'array', items: { type: 'string' } },
            score: { type: 'number' },
        }, ['titles', 'paths', 'score']),
    },
}, ['total', 'truncated', 'completeness', 'droppedGroups', 'items']);
/** 记忆层体检：MEMORY.md / USER.md 里的来源链是否还指向活笔记 */
const LINT_MEMORY = objSchema({
    files: { type: 'number' },
    links: { type: 'number' },
    total: { type: 'number' },
    unlinked: { type: 'number' },
    undated: { type: 'number' },
    retired: { type: 'number' },
    retiredBroken: { type: 'number' },
    stale: objSchema({
        total: { type: 'number' },
        staleDays: { type: 'number' },
        items: {
            type: 'array',
            items: objSchema({
                entry: { type: 'string' },
                date: { type: 'string' },
                age: { type: 'number' },
            }, ['entry', 'date', 'age']),
        },
    }, ['total', 'staleDays', 'items']),
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
}, ['files', 'links', 'total', 'unlinked', 'undated', 'retired', 'retiredBroken', 'stale', 'items']);
/** 日记时间轴：最近 90 天的空块 / 倒序 / 格式 / 位置（只报告） */
const LINT_TIMELINE = objSchema({
    scanned: { type: 'number' },
    skipped: { type: 'number' },
    notes: { type: 'number' },
    total: { type: 'number' },
    counts: objSchema({
        empty: { type: 'number' },
        order: { type: 'number' },
        format: { type: 'number' },
        placement: { type: 'number' },
    }, ['empty', 'order', 'format', 'placement']),
    items: {
        type: 'array',
        items: objSchema({
            path: { type: 'string' },
            issues: {
                type: 'array',
                items: objSchema({
                    line: { type: 'number' },
                    kind: { type: 'string', enum: ['empty', 'order', 'format', 'placement'] },
                    title: { type: 'string' },
                    detail: { type: 'string' },
                }, ['line', 'kind', 'title', 'detail']),
            },
        }, ['path', 'issues']),
    },
}, ['scanned', 'skipped', 'notes', 'total', 'counts', 'items']);
/** 空模板小节：内容槽空着、正文写在了别的 `##` 小节里（只报告） */
const LINT_EMPTY_SECTIONS = objSchema({
    scanned: { type: 'number' },
    skipped: { type: 'number' },
    notes: { type: 'number' },
    total: { type: 'number' },
    truncated: { type: 'boolean' },
    items: {
        type: 'array',
        items: objSchema({
            path: { type: 'string' },
            title: { type: 'string' },
            empty: {
                type: 'array',
                items: objSchema({
                    heading: { type: 'string' },
                    line: { type: 'number' },
                }, ['heading', 'line']),
            },
        }, ['path', 'title', 'empty']),
    },
}, ['scanned', 'skipped', 'notes', 'total', 'truncated', 'items']);
/** frontmatter 缺字段（P2-13） */
const LINT_INCOMPLETE = objSchema({
    total: { type: 'number' },
    truncated: { type: 'boolean' },
    byField: objSchema({
        type: { type: 'number' },
        status: { type: 'number' },
        authority: { type: 'number' },
    }, ['type', 'status', 'authority']),
    items: {
        type: 'array',
        items: objSchema({
            path: { type: 'string' },
            missing: { type: 'array', items: { type: 'string' } },
        }, ['path', 'missing']),
    },
}, ['total', 'truncated', 'byField', 'items']);
/** 标签卫生（P2-14） */
const LINT_TAGS = objSchema({
    total: { type: 'number' },
    reported: { type: 'boolean' },
    caseVariants: objSchema({
        total: { type: 'number' },
        items: {
            type: 'array',
            items: objSchema({
                variants: { type: 'array', items: { type: 'string' } },
                total: { type: 'number' },
            }, ['variants', 'total']),
        },
    }, ['total', 'items']),
    singletons: objSchema({
        total: { type: 'number' },
        items: { type: 'array', items: { type: 'string' } },
    }, ['total', 'items']),
}, ['total', 'reported', 'caseVariants', 'singletons']);
/** 模板版本（P2-15） */
const LINT_TEMPLATE = objSchema({
    present: { type: 'boolean' },
    version: { type: 'number' },
    current: { type: 'number' },
    stale: { type: 'boolean' },
    mismatch: { type: 'boolean' },
    mismatchDetail: { type: 'string' },
    currentText: { type: 'string' },
}, ['present', 'version', 'current', 'stale']);
/** 人格体检：缺失 / 旧版 / 比插件新 / 标记与内容不符 / 未填占位符（只报告，不覆盖） */
const LINT_PERSONA = objSchema({
    total: { type: 'number' },
    items: {
        type: 'array',
        items: objSchema({
            file: { type: 'string', enum: ['PERSONA.md'] },
            kind: { type: 'string', enum: ['missing', 'old', 'newer', 'mismatch', 'placeholder'] },
            detail: { type: 'string' },
        }, ['file', 'kind', 'detail']),
    },
}, ['total', 'items']);
/** 晋升候选的共用形状：newNotes / alreadyPromoted / backlog 三栏一致 */
const DREAM_CANDIDATE = objSchema({
    title: { type: 'string' },
    path: { type: 'string' },
    type: { type: 'string' },
    authority: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    created: { type: 'string' },
    lead: { type: 'string' },
    cited: { type: 'number' },
    citedBy: { type: 'array', items: { type: 'string' } },
    promoted: { type: 'boolean' },
    promotedBy: { type: 'string', enum: ['link', 'title', ''] },
    dailyMentions: { type: 'number' },
    daysMentioned: { type: 'number' },
    lastMentioned: { type: 'string' },
}, ['title', 'path', 'type', 'authority', 'tags', 'created', 'lead', 'cited', 'citedBy', 'promoted', 'promotedBy', 'dailyMentions', 'daysMentioned', 'lastMentioned']);
/** frontmatter 解析失败：这些笔记不在索引里，所以单列一桶（path 相对笔记本，不带 title） */
const LINT_PARSE = objSchema({
    total: { type: 'number' },
    items: {
        type: 'array',
        items: objSchema({ path: { type: 'string' }, reason: { type: 'string' } }, ['path', 'reason']),
    },
}, ['total', 'items']);
function fail(err) {
    // ZkError 是「人话 + 下一步」：hint 必须一起交给模型，否则它只知道写错了、不知道怎么写
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
/** 15.6：先用 summary（## Summary 首段），空串再按 R2 口径退回 snippet / lead */
function detailOf(n) {
    return n.summary || (n.snippet && n.snippet !== n.lead ? n.snippet : (n.lead ?? ''));
}
/** 死胡同提醒（措辞与 `zk-kit search` 共用一份）；没有就一个字都不加 */
function counterBlockOf(entries, truncated, zeroHit) {
    const body = describeCounterEntries({ entries: entries ?? [], truncated: truncated === true }, { zeroHit });
    return body ? '\n\n' + body : '';
}
function noteLine(n, index) {
    const head = `${index + 1}. ${n.title || n.path}`;
    const meta = [n.absPath || n.path, dateOnly(n.created)].filter(Boolean).join(' · ');
    const detail = detailOf(n);
    const lead = detail ? `\n   ${detail}` : '';
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
/** `[alias]` 自定义命令 → `zk_<名>` 工具：执行完全交给 zk，插件只负责把 argv 传进去 */
function aliasTool(alias, workspaceOf) {
    const command = alias.command.length > 200 ? alias.command.slice(0, 200) + '…' : alias.command;
    const detail = alias.description
        ? `${alias.description.replace(/[。.!！]\s*$/, '')}${command ? `（命令：${command}）` : ''}`
        : (command ? `运行命令 ${command}` : '运行 config.toml 里定义的命令');
    return def({
        name: `zk_${alias.name}`,
        description: `笔记本 .zk/config.toml 的 [alias] 里定义的自定义命令「${alias.name}」：${detail}。` +
            '调用等于 `zk <别名> [args]`：args 按顺序追加到别名命令里的 $@；输出按原样返回，不做 JSON 解析。' +
            '它是人写的 shell 命令，不受内置 zk_* 的路径 / meta 守卫约束（args 也可能改变它操作的库）。',
        parameters: {
            type: 'object',
            properties: {
                args: S.arr('额外参数，按顺序追加到 zk <别名> 之后（对应别名命令里的 $@）', S.str('参数值')),
            },
            additionalProperties: false,
        },
        output: {
            schema: objSchema({
                alias: { type: 'string' },
                output: { type: 'string' },
                stderr: { type: 'string' },
                chars: { type: 'number' },
                truncated: { type: 'boolean' },
            }, ['alias', 'output', 'stderr', 'chars', 'truncated']),
        },
        async run(args, env) {
            const cfg = configFor(env.workspace, env.sessionId);
            // 工具列表只在下一次加载时重建，执行权不能跟着等到重载才收：开关关掉就立刻拒绝。
            if (!cfg.aliasTools) {
                throw new ZkError(`别名工具已停用：aliasTools=false（zk_${alias.name} 不再执行）`, '设置页「工具」组重新打开，或 zk-kit config set aliasTools=true；重载插件后工具列表也会同步');
            }
            await ensureNotebook(cfg, env.signal);
            // 工具是全局注册的，会话可以随时 zk_use 切库：执行前按**当前笔记本**核对一次
            if (!readAliases(cfg).some((item) => item.name === alias.name)) {
                throw new ZkError(`当前笔记本没有别名「${alias.name}」：${cfg.notebook}`, `在 ${path.join(cfg.notebook, '.zk', 'config.toml')} 的 [alias] 里定义它，或用 zk_use 切到定义了它的笔记本`);
            }
            const argv = Array.isArray(args.args) ? args.args.map(String) : [];
            const r = await runAlias(cfg, alias.name, argv, { cwd: env.workspace, signal: env.signal });
            const limit = Math.min(200_000, Math.max(1000, Math.trunc(cfg.maxReadChars)));
            const truncated = r.stdout.length > limit;
            const stderr = r.stderr.trim();
            return {
                alias: alias.name,
                output: truncated ? r.stdout.slice(0, limit) : r.stdout,
                stderr: stderr.length > 2_000 ? stderr.slice(0, 2_000) + '…' : stderr,
                chars: r.stdout.length,
                truncated,
            };
        },
        render(_args, value) {
            const v = value;
            if (!v.output.trim() && !v.stderr)
                return text(`别名 ${v.alias}：没有输出`);
            const parts = [];
            if (v.output.trim())
                parts.push(v.output.trimEnd());
            if (v.truncated)
                parts.push(`…（已截断：原输出 ${v.chars} 字，可在 config.toml 里改用更短的 --format）`);
            if (v.stderr)
                parts.push('⚠️ ' + v.stderr);
            return text(parts.join('\n'));
        },
    }, workspaceOf);
}
export function buildTools(workspaceOf = () => processWorkspace()) {
    const t = (spec) => def(spec, workspaceOf);
    const builtins = [
        t({
            name: 'zk_search',
            description: '在 zk 知识库里搜索笔记（全文 / 标签 / 日期 / 断链 / 孤立笔记），返回标题、相对路径、绝对路径、标签、创建日、摘要与命中片段。' +
                '找到后用原生 read 读全文：notes[].absPath 可以直接传给 read。写笔记前先用它查重。' +
                '中文会自动并用子串，多词按覆盖度合并（FTS 不切中文）：matchStrategy 说明这次用了 fts / regex / mixed，mixed 表示补到了全文索引漏掉的笔记。' +
                '有 query 时默认按 FTS 相关性排序，显式给 sort 才改顺序。' +
                '结果还带 entryPoints（MEMORY 的活条目：via=query 表示这条结论跟查询有关，来源可以不在本次结果里）' +
                '与 counterEntries（归档里同名旧结论 + 废弃原因，先看它别把废掉的结论重新提出来）。',
            parameters: {
                type: 'object',
                properties: {
                    query: S.str('全文检索词（FTS，支持 "短语" 与 AND / OR；中文会自动并用子串，多词按覆盖度合并）'),
                    tags: S.arr('按标签过滤（AND：必须同时带这些标签）', S.str('标签名，不带 #')),
                    since: S.str('只看这个日期之后创建的笔记，自然语言或 ISO 日期，如 2026-01-01 / "last week"'),
                    until: S.str('只看这个日期之前创建的笔记'),
                    orphan: S.bool('只看没有任何反链的孤立笔记'),
                    brokenLinks: S.bool('只看含有断链的笔记'),
                    limit: S.num('最多返回几条（1-200，默认 10）'),
                    sort: S.enum('排序方式；有 query 默认 relevance（按 FTS 相关性），无 query 回退 created-desc', ['relevance', 'created-desc', 'created-asc', 'modified-desc', 'title-asc']),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    count: { type: 'number' },
                    matchStrategy: { type: 'string', enum: ['fts', 'regex', 'mixed'] },
                    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
                    hasMore: { type: 'boolean' },
                    scanned: { type: 'number' },
                    /** R2：只在能精确判定时给（completeness === complete） */
                    total: { type: 'number' },
                    notes: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            absPath: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                            created: { type: 'string' },
                            lead: { type: 'string' },
                            words: { type: 'number' },
                            /** 15.6：`## Summary` 首段 / frontmatter summary；老笔记为空串 */
                            summary: { type: 'string' },
                            /** 命中片段，没有时整个键不出现（避免 undefined 让宿主判 invalid output） */
                            snippet: { type: 'string' },
                        }, ['title', 'path', 'absPath', 'tags', 'created', 'lead']),
                    },
                    /** R9：只在有命中且 MEMORY 里有对应活条目时出现 */
                    entryPoints: { type: 'array', items: ENTRY_POINT },
                    /** 入口超过上限时出现（true），不静默少列 */
                    entryPointsTruncated: { type: 'boolean' },
                    /** 死胡同探针：归档里同名的废弃结论（零子进程；只提示，不改结果集） */
                    counterEntries: { type: 'array', items: COUNTER_ENTRY },
                    counterEntriesTruncated: { type: 'boolean' },
                }, ['notebook', 'count', 'matchStrategy', 'completeness', 'hasMore', 'scanned', 'notes']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg);
                const query = args.query ? String(args.query) : undefined;
                const result = await searchNotesDetailed(cfg, {
                    query,
                    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
                    since: args.since ? String(args.since) : undefined,
                    until: args.until ? String(args.until) : undefined,
                    orphan: args.orphan === true,
                    brokenLinks: args.brokenLinks === true,
                    limit: args.limit === undefined ? 10 : Number(args.limit),
                    // R1：有 query 且没显式给 sort → relevance（不传 --sort，保住 FTS 相关性顺序）
                    sort: args.sort ? String(args.sort) : (args.query ? 'relevance' : 'created-desc'),
                });
                // R9：查询命中的 MEMORY 条目 → 入口（来源可以不在本批结果里）；先只读，不新增 zk 进程
                const { points: entryPoints, truncated: entryPointsTruncated } = entryPointsOf(cfg, result.notes, { query });
                const counters = archivedCounterparts(cfg, result.notes, { query });
                bumpUsage(cfg, [
                    'search',
                    ...(entryPoints.length ? ['entryPoints'] : []),
                    ...(counters.entries.length ? ['counterEntries'] : []),
                ]);
                // 15.2：只记 path / 日期 / 检索种类，不记查询词；默认关时零写入
                bumpRecall(cfg, result.notes.map((n) => ({ path: n.path, title: n.title })), 'search');
                return {
                    notebook: cfg.notebook,
                    count: result.notes.length,
                    matchStrategy: result.matchStrategy,
                    completeness: result.completeness,
                    hasMore: result.hasMore,
                    scanned: result.scanned,
                    ...(result.total === undefined ? {} : { total: result.total }),
                    notes: result.notes.map((n) => ({
                        title: n.title, path: n.path, absPath: n.absPath, tags: n.tags,
                        created: dateOnly(n.created), lead: n.lead, words: n.words, summary: n.summary,
                        ...(n.snippet ? { snippet: n.snippet } : {}),
                    })),
                    ...(entryPoints.length ? { entryPoints } : {}),
                    ...(entryPointsTruncated ? { entryPointsTruncated } : {}),
                    ...(counters.entries.length ? { counterEntries: counters.entries } : {}),
                    ...(counters.truncated ? { counterEntriesTruncated: true } : {}),
                };
            },
            render(args, value) {
                const v = value;
                const counters = counterBlockOf(v.counterEntries, v.counterEntriesTruncated, v.count === 0);
                if (!v.count) {
                    return text(`没有匹配的笔记（笔记本 ${v.notebook}）` +
                        zeroHitHint(args, '或按 tags 查') +
                        (v.completeness === 'unknown' ? '；但这次检索结果无法完整解析，不能当作「库里没有」' : '') + entryPointLines(v.entryPoints, { truncated: v.entryPointsTruncated }) + counters);
                }
                const how = v.matchStrategy === 'mixed'
                    ? '（中文：全文 + 子串合并，已补上全文索引漏掉的）'
                    : v.matchStrategy === 'regex' ? '（全文无结果，已退回子串匹配）' : '';
                const tail = v.completeness === 'unknown'
                    ? '\n⚠️ 无法确认结果是否完整（解析失败 / 补充检索失败），先别把它当成全部命中'
                    : v.hasMore ? `\n⚠️ 还有更多匹配没返回（已检查 ${v.scanned} 条候选）；要更全就提高 limit 或加过滤条件` : '';
                return text(`${v.count} 条（笔记本 ${v.notebook}）${how}\n` + v.notes.map(noteLine).join('\n') +
                    entryPointLines(v.entryPoints, { truncated: v.entryPointsTruncated }) + tail + counters);
            },
        }),
        t({
            name: 'zk_query',
            description: '结构化检索记忆：按 type（daily/source/concept/entity/pattern）、status（active/superseded）、标签、目录、日期、断链、孤立过滤。' +
                '默认只看 active 且不含归档；传 include_archived: true 会连归档一起查，此时未显式给 status 就不再默认过滤 active。' +
                '中文会自动并用子串，多词按覆盖度合并；有 query 时默认按 FTS 相关性排序。' +
                '这是查「记忆里有什么」的主入口。entryPoints / counterEntries 与 zk_search 同口径。',
            parameters: {
                type: 'object',
                properties: {
                    query: S.str('全文检索词（中文会自动并用子串，多词按覆盖度合并）'),
                    tags: S.arr('按标签过滤（AND）', S.str('标签名，不带 #')),
                    dirs: S.arr('只看这些目录（相对笔记本，如 notes/concepts）', S.str('相对目录')),
                    type: S.enum('只要这个类型的笔记', ['daily', 'source', 'concept', 'entity', 'pattern']),
                    status: S.enum('只要这个状态（默认 active）', ['active', 'superseded']),
                    since: S.str('只看这个日期之后创建的'),
                    until: S.str('只看这个日期之前创建的'),
                    orphan: S.bool('只看没有反链的孤立笔记'),
                    brokenLinks: S.bool('只看含断链的笔记'),
                    include_archived: S.bool('连 archive/ 里的废弃笔记一起查（默认 false）'),
                    sort: S.enum('排序方式；有 query 默认 relevance（按 FTS 相关性），无 query 回退 created-desc', ['relevance', 'created-desc', 'created-asc', 'modified-desc', 'title-asc']),
                    limit: S.num('最多返回几条（1-200，默认 10）'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    count: { type: 'number' },
                    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
                    hasMore: { type: 'boolean' },
                    scanned: { type: 'number' },
                    /** R2：只在能精确判定时给（completeness === complete） */
                    total: { type: 'number' },
                    notes: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            absPath: { type: 'string' },
                            type: { type: 'string' },
                            status: { type: 'string' },
                            authority: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                            created: { type: 'string' },
                            lead: { type: 'string' },
                            words: { type: 'number' },
                            /** 15.6：`## Summary` 首段 / frontmatter summary；老笔记为空串 */
                            summary: { type: 'string' },
                            snippet: { type: 'string' },
                            archived: { type: 'boolean' },
                        }, ['title', 'path', 'absPath', 'type', 'status', 'authority', 'tags', 'created', 'lead', 'archived']),
                    },
                    /** R9：只在有命中且 MEMORY 里有对应活条目时出现 */
                    entryPoints: { type: 'array', items: ENTRY_POINT },
                    /** 入口超过上限时出现（true），不静默少列 */
                    entryPointsTruncated: { type: 'boolean' },
                    /** 死胡同探针：归档里同名的废弃结论（include_archived 时不重复报） */
                    counterEntries: { type: 'array', items: COUNTER_ENTRY },
                    counterEntriesTruncated: { type: 'boolean' },
                }, ['notebook', 'count', 'completeness', 'hasMore', 'scanned', 'notes']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const includeArchived = args.include_archived === true;
                const query = args.query ? String(args.query) : undefined;
                const result = await searchNotesDetailed(cfg, {
                    query,
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
                    // R1：有 query 且没显式给 sort → relevance
                    sort: args.sort ? String(args.sort) : (args.query ? 'relevance' : 'created-desc'),
                }, env.signal);
                const notes = result.notes;
                // R9：与 zk_search 共用同一份计算（查询命中的来源可以不在本批结果里；零子进程）
                const { points: entryPoints, truncated: entryPointsTruncated } = entryPointsOf(cfg, notes, { query });
                const counters = includeArchived
                    ? { entries: [], scanned: 0, truncated: false }
                    : archivedCounterparts(cfg, notes, { query });
                bumpUsage(cfg, [
                    'query',
                    ...(entryPoints.length ? ['entryPoints'] : []),
                    ...(counters.entries.length ? ['counterEntries'] : []),
                ]);
                bumpRecall(cfg, notes.map((n) => ({ path: n.path, title: n.title })), 'query');
                return {
                    notebook: cfg.notebook,
                    count: notes.length,
                    completeness: result.completeness,
                    hasMore: result.hasMore,
                    scanned: result.scanned,
                    ...(result.total === undefined ? {} : { total: result.total }),
                    notes: notes.map((n) => ({
                        title: n.title,
                        path: n.path,
                        absPath: n.absPath,
                        // daily 模板没有 frontmatter：按 dailyDir 回显，和 type=daily 的过滤口径一致
                        type: n.type || (isUnderDir(n.path, cfg.dailyDir) ? 'daily' : ''),
                        status: n.status || 'active',
                        authority: n.authority,
                        tags: n.tags,
                        created: dateOnly(n.created),
                        lead: n.lead,
                        words: n.words,
                        summary: n.summary,
                        ...(n.snippet ? { snippet: n.snippet } : {}),
                        archived: n.path.startsWith(cfg.archiveDir + '/'),
                    })),
                    ...(entryPoints.length ? { entryPoints } : {}),
                    ...(entryPointsTruncated ? { entryPointsTruncated } : {}),
                    ...(counters.entries.length ? { counterEntries: counters.entries } : {}),
                    ...(counters.truncated ? { counterEntriesTruncated: true } : {}),
                };
            },
            render(args, value) {
                const v = value;
                const counters = counterBlockOf(v.counterEntries, v.counterEntriesTruncated, v.count === 0);
                if (!v.count) {
                    return text(`没有匹配的笔记（笔记本 ${v.notebook}）` +
                        zeroHitHint(args, '或给 tags 参数按标签查') +
                        (v.completeness === 'unknown' ? '；但这次检索结果无法完整解析，不能当作「记忆里没有」' : '') + entryPointLines(v.entryPoints, { truncated: v.entryPointsTruncated }) + counters);
                }
                const tail = v.completeness === 'unknown'
                    ? '\n⚠️ 无法确认结果是否完整（解析失败 / 补充检索失败），先别把它当成全部命中'
                    : v.hasMore ? `\n⚠️ 还有更多匹配没返回（已检查 ${v.scanned} 条候选）；要更全就提高 limit 或缩小过滤范围` : '';
                const lines = v.notes.map((n, i) => {
                    const badges = [String(n.type || '—'), String(n.status || 'no-status'), n.archived ? '已归档' : ''].filter(Boolean);
                    const detail = detailOf({ summary: String(n.summary ?? ''), lead: String(n.lead ?? ''), snippet: String(n.snippet ?? '') });
                    return `${i + 1}. ${String(n.title)}  [${badges.join(' · ')}]\n   ${String(n.absPath || n.path)} · ${String(n.created)}${detail ? '\n   ' + detail : ''}`;
                });
                return text(`${v.count} 条（笔记本 ${v.notebook}）\n` + lines.join('\n') +
                    entryPointLines(v.entryPoints, { truncated: v.entryPointsTruncated }) + tail + counters);
            },
        }),
        t({
            name: 'zk_recall',
            description: '召回装配：先按 query / 过滤条件检索（与 zk_search 同一套 R1–R3），再按词数预算把命中笔记拼成一段可直接读的上下文。' +
                '每条带标题、路径、absPath 与全文词数，放不下就整条丢弃、不切半句；需要全文仍用原生 read 读 absPath。' +
                'budget 按 countWords 口径（中文 2 字 1 词），used 一定不超过 budget。' +
                '不做语义判断 / 重排 / 跨回合去重；completeness 沿用检索三态，装配过的 ≠ 全部命中。',
            parameters: {
                type: 'object',
                properties: {
                    query: S.str('全文检索词（中文自动并用子串、多词按覆盖度合并；不给则按过滤条件列最近的笔记）'),
                    tags: S.arr('按标签过滤（AND）', S.str('标签名，不带 #')),
                    since: S.str('只看这个日期之后创建的笔记'),
                    until: S.str('只看这个日期之前创建的笔记'),
                    orphan: S.bool('只看没有反链的孤立笔记'),
                    brokenLinks: S.bool('只看含断链的笔记'),
                    include_archived: S.bool('连 archive/ 里的废弃笔记一起查（默认 false）'),
                    type: S.enum('只要这个类型的笔记', ['daily', 'source', 'concept', 'entity', 'pattern']),
                    status: S.enum('只要这个状态（默认 active）', ['active', 'superseded']),
                    limit: S.num('候选检索条数（1-200，默认 30；装配只在这些候选里挑）'),
                    sort: S.enum('排序方式；有 query 默认 relevance（按 FTS 相关性），无 query 回退 created-desc', ['relevance', 'created-desc', 'created-asc', 'modified-desc', 'title-asc']),
                    budget: S.num('装配词数预算（默认 500，范围 1-5000；中文 2 字 1 词）'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    text: { type: 'string' },
                    used: { type: 'number' },
                    budget: { type: 'number' },
                    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
                    hasMore: { type: 'boolean' },
                    notes: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            absPath: { type: 'string' },
                            /** 15.6：`## Summary` 首段 / frontmatter summary；老笔记为空串 */
                            summary: { type: 'string' },
                            included: { type: 'boolean' },
                            reason: { type: 'string', enum: ['included', 'duplicate', 'empty', 'over-budget'] },
                        }, ['title', 'path', 'absPath', 'included', 'reason']),
                    },
                    /** R9：与 zk_search / zk_query 共用同一份计算（没有就是空数组，不另算） */
                    entryPoints: { type: 'array', items: ENTRY_POINT },
                    /** 入口超过上限（true），不静默少列 */
                    entryPointsTruncated: { type: 'boolean' },
                    /** true = via=query 的入口已写进 text（占同一份预算）；false 时正文里没有它们 */
                    entryPointsInText: { type: 'boolean' },
                    /** 死胡同探针：归档里同名的废弃结论 */
                    counterEntries: { type: 'array', items: COUNTER_ENTRY },
                    counterEntriesTruncated: { type: 'boolean' },
                }, ['notebook', 'text', 'used', 'budget', 'completeness', 'hasMore', 'notes',
                    'entryPoints', 'entryPointsTruncated', 'counterEntries', 'counterEntriesTruncated']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const includeArchived = args.include_archived === true;
                const r = await assembleRecall(cfg, {
                    query: args.query ? String(args.query) : undefined,
                    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
                    since: args.since ? String(args.since) : undefined,
                    until: args.until ? String(args.until) : undefined,
                    orphan: args.orphan === true,
                    brokenLinks: args.brokenLinks === true,
                    includeArchived,
                    type: args.type ? [String(args.type)] : undefined,
                    // 与 zk_query 同口径：默认只给活着的，显式 include_archived 时不再默认卡 active
                    status: args.status ? [String(args.status)] : includeArchived ? undefined : ['active'],
                    limit: args.limit === undefined ? undefined : Number(args.limit),
                    sort: args.sort ? String(args.sort) : undefined,
                    budget: args.budget === undefined ? undefined : Number(args.budget),
                }, env.signal);
                return { notebook: cfg.notebook, ...r };
            },
            render(args, value) {
                const v = value;
                const kept = v.notes.filter((n) => n.included).length;
                const dropped = v.notes.length - kept;
                const counters = counterBlockOf(v.counterEntries, v.counterEntriesTruncated, v.notes.length === 0);
                if (!v.notes.length) {
                    return text(`没有匹配的笔记（笔记本 ${v.notebook}）` +
                        zeroHitHint(args, '或按 tags 查') +
                        (v.completeness === 'unknown' ? '；但这次检索结果无法完整解析，不能当作「库里没有」' : '') + entryPointLines(v.entryPoints, { truncated: v.entryPointsTruncated }) + counters);
                }
                const lines = [`召回装配：${v.used}/${v.budget} 词 · 收录 ${kept}/${v.notes.length} 篇（笔记本 ${v.notebook}）`];
                if (v.text)
                    lines.push('', v.text);
                if (dropped)
                    lines.push(`（${dropped} 篇没放进去：整条丢弃，没有切半句；原因见 notes[].reason）`);
                // `via: 'query'` 的入口已经写进 text（排在装配正文之前）；只有预算放不下时才会在这里补回。
                // 状态取自 assembleRecall 的 `entryPointsInText`，不从 text 里嗅字符串 —— 笔记正文也可能含那串字。
                const points = entryPointLines(v.entryPoints, {
                    truncated: v.entryPointsTruncated,
                    skipQuery: v.entryPointsInText,
                });
                if (points)
                    lines.push(points.trimStart());
                const tail = v.completeness === 'unknown'
                    ? '⚠️ 无法确认结果是否完整（解析失败 / 补充检索失败），先别把它当成全部命中'
                    : v.hasMore ? '⚠️ 还有更多匹配没返回；要提高 limit 或缩小过滤范围' : '';
                if (tail)
                    lines.push(tail);
                if (counters)
                    lines.push(counters.trimStart());
                return text(lines.join('\n'));
            },
        }),
        t({
            name: 'zk_walk',
            description: '从一篇笔记出发走一跳邻居（只读）：direction=both 同时看反链与出链，in=谁链到它，out=它链到谁。' +
                '种子写相对笔记本的路径、绝对路径，或精确标题 / 稳定 id（[[标题]] / [[id]] 也认）；不精确命中就返回空，不会退回全库。' +
                '按篇反查、不建全图，成本与库规模基本无关；limit 硬顶 200，触顶 completeness=partial（邻居没列全，不代表没有）。' +
                '每条邻居带 section / linkLine：那条边所在的小节与那一行 —— 没有它，同一篇种子的出链只有一串标题。' +
                '只回标题 / 路径 / absPath / 摘要 / 那一行，全文仍用原生 read 读 absPath；不改标题、不自动 link、不写任何文件。',
            parameters: {
                type: 'object',
                properties: {
                    path: S.str('种子笔记：相对笔记本的路径、绝对路径，或精确标题 / 稳定 id（也认 [[标题]] / [[id]]）'),
                    direction: S.enum('走哪个方向：both 反链 + 出链，in 只看谁链到它，out 只看它链到谁（默认 both）', ['both', 'in', 'out']),
                    limit: S.num('每个方向最多几条（1-200，默认 10）'),
                    include_archived: S.bool('连 archive/ 里的废弃笔记一起看（默认 false）'),
                },
                required: ['path'],
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    /** 种子解析失败时整个键不出现（null 过不了 object 校验，不拿空对象冒充） */
                    seed: objSchema({ title: { type: 'string' }, path: { type: 'string' }, absPath: { type: 'string' } }, ['title', 'path', 'absPath']),
                    direction: { type: 'string', enum: ['both', 'in', 'out'] },
                    count: { type: 'number' },
                    truncated: { type: 'boolean' },
                    /** 只有 complete / partial：按篇反查没有产生 unknown 的路径 */
                    completeness: { type: 'string', enum: ['complete', 'partial'] },
                    notes: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            absPath: { type: 'string' },
                            relation: { type: 'string', enum: ['in', 'out'] },
                            lead: { type: 'string' },
                            /** 这条边所在的 `##` / `###` 小节；找不到时键不出现（plan §14.1） */
                            section: { type: 'string' },
                            /** 这条边的那一行（压空白、截 160 码点）：没有它，同一篇种子的出链长得一模一样 */
                            linkLine: { type: 'string' },
                        }, ['title', 'path', 'absPath', 'relation', 'lead']),
                    },
                }, ['notebook', 'direction', 'count', 'truncated', 'completeness', 'notes']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const seed = args.path === undefined || args.path === null ? '' : String(args.path);
                if (!seed.trim())
                    throw new ZkError('种子不能为空', '给 path：相对笔记本的路径，或精确标题 / id');
                const direction = (args.direction === undefined ? 'both' : String(args.direction));
                const r = await walkFrom(cfg, {
                    seed,
                    direction,
                    limit: args.limit === undefined ? 10 : Number(args.limit),
                    includeArchived: args.include_archived === true,
                }, env.signal);
                bumpUsage(cfg, ['walk']);
                return {
                    notebook: cfg.notebook,
                    ...(r.seed ? { seed: r.seed } : {}),
                    direction,
                    count: r.notes.length,
                    truncated: r.truncated,
                    completeness: r.completeness,
                    notes: r.notes,
                };
            },
            render(args, value) {
                const v = value;
                if (!v.seed) {
                    return text(`没找到种子笔记：${String(args.path ?? '')}\n` +
                        '要写相对 / 绝对路径，或精确标题 / 稳定 id；不精确匹配时不猜（不会退回全库）');
                }
                const label = v.seed.title && v.seed.title !== v.seed.path ? `${v.seed.title} · ${v.seed.path}` : v.seed.path;
                if (!v.count) {
                    return text(`「${label}」没有 ${v.direction === 'both' ? '入链或出链' : v.direction === 'in' ? '入链' : '出链'}邻居（笔记本 ${v.notebook}）`);
                }
                const lines = v.notes.map((n, i) => {
                    const arrow = n.relation === 'in' ? '← 链向本篇' : '→ 本篇链到';
                    const detail = detailOf({ lead: n.lead });
                    // 先给「为什么这条边存在」，再给摘要：同一篇种子的出链摘要往往逐字相同
                    const why = n.linkLine || n.section
                        ? `\n   ${n.section ? `〔${n.section}〕` : '〔无小节〕'} ${n.linkLine ?? ''}`.trimEnd()
                        : '';
                    return `${i + 1}. ${arrow}  ${n.title || n.path}${why}\n   ${n.absPath || n.path}${detail ? '\n   ' + detail : ''}`;
                });
                const tail = v.truncated
                    ? '\n⚠️ 邻居没列全（触到 limit）；这不代表只有这些，要提高 limit 再走一次'
                    : '';
                return text(`${v.count} 篇 1 跳邻居（种子 ${label} · 笔记本 ${v.notebook}）\n` + lines.join('\n') + tail);
            },
        }),
        t({
            name: 'zk_new',
            description: '新建一篇笔记（zk 负责生成文件名、套用模板、写入索引）。适合记下一个概念、决定、来源或想法；' +
                '写前先 zk_search 查重。标题重复会直接报错（flat 按标题查重，layered 同目录同名 slug 也会被 zk 拒绝）。' +
                'layered 的文件名默认来自标题（{{slug title}}）：中文标题会生成很长的拼音文件名。' +
                'layered 不给 dir 就按 type 落到 notes/sources 之类；两者都没有、或给的 dir 不在任何 group 里都会报错，' +
                '不会默默建到 notes/ 根（那里不套模板，没有 frontmatter，文件名是随机 id）。' +
                '要短文件名就传 name（8–14 字中文短语 / 英文小写短横线名）：只换文件名，标题和正文一个字不动。' +
                '归档里有同名旧结论不会拦，但会放进 archived（带 supersede-reason）：先读它，别把同一个错误结论重新提出来。' +
                'type / authority 只有 layered 模板会写进 frontmatter。tags 会写成 #hashtag；links 里的目标会被追加成 wiki 双链。' +
                '中文笔记如果没有任何标签（入参 / 默认值 / 正文 hashtag 都没有），会在 tagWarning 里提示 —— 只提示，不阻断。' +
                '同目录里有「改一两个字」的相似标题时会放进 similar（带分数）：只提示，不阻断，也不自动建链接。' +
                '正文以 ## 开头时，模板的 ## Content 会变成空壳（内容落在它后面）：返回值 emptyTemplateSections 会点名，' +
                '只提示、不改正文 —— 把正文并进那一节，或删掉那行空标题。' +
                '根目录 meta 文件（AGENTS / USER / MEMORY 等）与 raw/ 、inbox/ 不能写：前者会被当成人写的工作面，后两者会被排除出索引。',
            parameters: {
                type: 'object',
                properties: {
                    title: S.str('笔记标题（会成为一级标题）'),
                    name: S.str('文件名（不含扩展名，也不要带目录）；不给就由 zk 按标题生成。中文标题建议给一个短名，否则是长拼音'),
                    body: S.str('正文 Markdown（可空）。会插在模板的 {{content}} 位置（layered 下在 ## Content 之下、## Links 之前）：不要自己再写 ## Content / ## Summary 这类模板小节，会多出重复标题'),
                    summary: S.str('一句话摘要（填进模板的 ## Summary；正文里已经写了这一节就不动）'),
                    tags: S.arr('标签（不写 #）。与设置里的默认标签合并；正文里已经写过的标签不会再追加一行', S.str('标签名')),
                    dir: S.str('放到哪个子目录（相对笔记本）。flat 默认 notesDir；layered 必须落在某个 group（notes/sources 等，子目录也行），不给就按 type 落位；两者都没有、或不在 group 里都会报错'),
                    type: S.enum('笔记类型（写进 frontmatter；layered 结构下决定模板的分节，不给 dir 时也决定目录）', ['source', 'concept', 'entity', 'pattern']),
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
                    absPath: { type: 'string' },
                    title: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    links: { type: 'array', items: { type: 'string' } },
                    summaryApplied: { type: 'boolean' },
                    summaryWarning: { type: 'string' },
                    emptyTemplateSections: { type: 'array', items: { type: 'string' } },
                    tagWarning: { type: 'string' },
                    archived: {
                        type: 'array',
                        items: objSchema({
                            path: { type: 'string' },
                            title: { type: 'string' },
                            reason: { type: 'string' },
                        }, ['path', 'title', 'reason']),
                    },
                    similar: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            score: { type: 'number' },
                        }, ['title', 'path', 'score']),
                    },
                    warnings: { type: 'array', items: { type: 'string' } },
                }, ['notebook', 'path', 'absPath', 'title', 'tags', 'links', 'summaryApplied', 'archived', 'warnings']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const tags = [...new Set([...(cfg.defaultTags ?? []), ...(Array.isArray(args.tags) ? args.tags.map(String) : [])])];
                const type = args.type ? String(args.type) : undefined;
                const title = String(args.title);
                const body = args.body ? String(args.body) : '';
                const content = withTags(body, tags);
                const created = await createNote(cfg, {
                    title,
                    name: args.name ? String(args.name) : undefined,
                    summary: args.summary ? String(args.summary) : undefined,
                    content,
                    dir: newNoteDir(cfg, { dir: args.dir ? String(args.dir) : undefined, type }),
                    group: args.group ? String(args.group) : undefined,
                    type,
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
                // 中文没标签：写路径是唯一便宜的修复点（P2-9）。只提示，不阻断。
                const tagWarning = taglessCjkWarning(title, content, tags);
                // 归档同名只是提醒：zk_new 的查重本来就不含 archive，允许复用标题 —— 但要把废弃原因一起交出来
                // （createNote 建之前那次全库扫描已经算好了，这里不再单独跑一次 zk）
                const archived = created.archived;
                // 没有告警就不要写 summaryWarning: undefined —— 宿主按无损 JSON 快照校验输出，
                // 值为 undefined 的字段会让整次调用报 INVALID_TOOL_OUTPUT（文件其实已经建好）。
                return {
                    notebook: cfg.notebook, path: created.path, absPath: created.absPath, title: created.title, tags, links,
                    summaryApplied: created.summaryApplied, archived, warnings,
                    ...(created.similar.length ? { similar: created.similar } : {}),
                    ...(created.summaryWarning ? { summaryWarning: created.summaryWarning } : {}),
                    ...(created.emptyTemplateSections.length ? { emptyTemplateSections: created.emptyTemplateSections } : {}),
                    ...(tagWarning ? { tagWarning } : {}),
                };
            },
            render(_args, value) {
                const v = value;
                const lines = [`已记下「${v.title}」→ ${v.absPath || v.path}`];
                if (v.tags.length)
                    lines.push('标签：' + v.tags.map((t) => '#' + t).join(' '));
                if (v.links.length)
                    lines.push('双链：' + v.links.join(' '));
                if (v.summaryWarning)
                    lines.push('⚠️ ' + v.summaryWarning);
                if (v.emptyTemplateSections?.length) {
                    lines.push('⚠️ 模板小节空着：' + v.emptyTemplateSections.join('、') +
                        ' —— 正文以 ## 开头，内容落在了它后面；把正文并进那一节，或删掉那行空标题（zk_lint 的「空模板小节」会复查）');
                }
                if (v.tagWarning)
                    lines.push('⚠️ ' + v.tagWarning);
                if (v.similar?.length) {
                    lines.push('⚠️ 疑似已有：' + v.similar.map((s) => `${s.title}（${s.path}，${s.score.toFixed(2)}）`).join('、') +
                        ' —— 先 read 确认是不是同一条；要合并就 zk_supersede，不要直接再写一遍');
                }
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
                    absPath: { type: 'string' },
                    created: { type: 'boolean' },
                    appended: { type: 'boolean' },
                }, ['notebook', 'path', 'absPath', 'created', 'appended']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const daily = await ensureDailyNote(cfg, { date: args.date ? String(args.date) : undefined }, env.signal);
                const appended = Boolean(args.entry && String(args.entry).trim());
                if (appended)
                    appendDaily(cfg, daily.path, String(args.entry), new Date());
                return { notebook: cfg.notebook, path: daily.path, absPath: daily.absPath, created: daily.created, appended };
            },
            render(_args, value) {
                const v = value;
                const state = v.created ? '新建' : '已有';
                return text(`日记 ${state} → ${v.absPath || v.path}${v.appended ? '（已追加一段）' : ''}\n笔记本：${v.notebook}`);
            },
        }),
        t({
            name: 'zk_append',
            description: '往一篇已有笔记末尾追加内容（自动补空行，可选先起一个二级标题）。适合补充证据、跟进结论、在会议记录里续写；' +
                `整篇重写请用原生 write / edit，别用这个工具。根目录的 ${META_NAMES.join(' / ')} 是 meta 文件，会被拒绝。`,
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
                '目标可以给相对路径，也可以给标题；根目录 meta 文件不作为来源或目标。',
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
                'reason 会写进归档 frontmatter 的 supersede-reason：下次有人建同名笔记时会被带出来，防止同一个错误结论被重新提出。' +
                '根目录 meta 文件不能废弃（否则会把 MEMORY.md 之类搬进 archive/）。',
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
            description: '读知识库根目录的长期约定与记忆（AGENTS.md / USER.md / MEMORY.md），按注入预算截断后返回；' +
                '角色人格（PERSONA.md）单独成段、在记忆段之前、不参与截断。' +
                '同时列出已配置的笔记本（名字 / 路径 / 结构 / 当前）。' +
                '改 MEMORY.md 之前用它看余量：headroom / wouldTruncate / dropCandidates 说明「再加一条会丢谁」，' +
                '给 proposed_entry 或 extra_words 就能预估；同日条目按位置决胜（sameDateCount）。' +
                '宿主支持注入时这些内容每轮已自动进入系统提示；宿主不支持、或想核对「被截断了多少」时用它。',
            parameters: {
                type: 'object',
                properties: {
                    proposed_entry: S.str('打算写进 MEMORY.md 的新条目；按它估算会不会触发截断并预告会丢谁'),
                    extra_words: S.num('新条目词数；给了就不按 proposed_entry 重算，直接按这个数估'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    text: { type: 'string' },
                    words: { type: 'number' },
                    budget: { type: 'number' },
                    ratio: { type: 'number' },
                    truncatedWords: { type: 'number' },
                    retiredWords: { type: 'number' },
                    tocWords: { type: 'number' },
                    totalWords: { type: 'number' },
                    overheadWords: { type: 'number' },
                    // G1 / G4：写 MEMORY 前的容量（纯增量字段，旧客户端只是多看到几列）
                    retiredEntries: { type: 'number' },
                    headroom: { type: 'number' },
                    extraWords: { type: 'number' },
                    wouldTruncate: { type: 'boolean' },
                    sameDateCount: { type: 'number' },
                    format: { type: 'array', items: { type: 'string' } },
                    suggestion: { type: 'string' },
                    dropCandidates: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            date: { type: 'string' },
                            words: { type: 'number' },
                            reason: { type: 'string', enum: ['oldest', 'same-date', 'undated'] },
                        }, ['title', 'date', 'words', 'reason']),
                    },
                    // 格式债 / 模板版本：只读元数据，比 memoryUsage 的投影早一步就能拿到
                    formatDebt: objSchema({
                        total: { type: 'number' },
                        undated: { type: 'number' },
                        unlinked: { type: 'number' },
                    }, ['total', 'undated', 'unlinked']),
                    templateVersion: { type: 'number' },
                    persona: objSchema({
                        present: { type: 'boolean' },
                        contentWords: { type: 'number' },
                        words: { type: 'number' },
                        noticeWords: { type: 'number' },
                        budget: { type: 'number' },
                        overBudget: { type: 'boolean' },
                        overWords: { type: 'number' },
                        files: {
                            type: 'array',
                            items: objSchema({
                                name: { type: 'string' },
                                present: { type: 'boolean' },
                                words: { type: 'number' },
                            }, ['name', 'present', 'words']),
                        },
                    }, ['present', 'contentWords', 'words', 'noticeWords', 'budget', 'overBudget', 'overWords', 'files']),
                    notebook: { type: 'string' },
                    defaultNotebook: { type: 'string' },
                    pinned: { type: 'string' },
                    notebooks: {
                        type: 'array',
                        items: objSchema({
                            name: { type: 'string' },
                            path: { type: 'string' },
                            structure: { type: 'string' },
                            active: { type: 'boolean' },
                        }, ['name', 'path', 'structure', 'active']),
                    },
                    files: {
                        type: 'array',
                        items: objSchema({
                            name: { type: 'string' },
                            present: { type: 'boolean' },
                            words: { type: 'number' },
                            originalWords: { type: 'number' },
                            retiredWords: { type: 'number' },
                        }, ['name', 'present', 'words', 'originalWords', 'retiredWords']),
                    },
                }, ['text', 'words', 'budget', 'ratio', 'truncatedWords', 'retiredWords', 'tocWords', 'totalWords', 'overheadWords',
                    'retiredEntries', 'headroom', 'extraWords', 'wouldTruncate', 'sameDateCount', 'format', 'suggestion', 'dropCandidates',
                    'formatDebt', 'templateVersion', 'persona', 'notebook', 'defaultNotebook', 'pinned', 'notebooks', 'files']),
            },
            async run(args, env) {
                // 不 ensureNotebook：读记忆不该依赖 zk，笔记本不存在时就是空载荷
                const cfg = configFor(env.workspace, env.sessionId);
                const state = sessionState(env.workspace, env.sessionId);
                const payload = buildMemoryPayload(cfg);
                return {
                    ...payload,
                    ...memoryCapacity(cfg, {
                        proposedEntry: args.proposed_entry ? String(args.proposed_entry) : undefined,
                        extraWords: args.extra_words === undefined ? undefined : Number(args.extra_words),
                    }),
                    notebook: state.active,
                    defaultNotebook: state.defaultName,
                    pinned: state.diverged ? state.pinned : '',
                    notebooks: notebookInfos(cfg, env.workspace),
                };
            },
            render(_args, value) {
                const v = value;
                // 别的会话切过全局默认、而本会话还钉在原库时，先把这件事说破
                const drift = v.pinned && v.pinned !== v.defaultNotebook
                    ? `本会话固定在「${v.pinned}」；全局默认已改为「${v.defaultNotebook}」—— 要跟随用 zk_use ${v.defaultNotebook}\n\n`
                    : '';
                const list = v.notebooks ?? [];
                const current = list.find((n) => n.active);
                const others = list.filter((n) => !n.active);
                const head = current
                    ? `笔记本「${current.name}」（${current.structure}）→ ${current.path}` +
                        (others.length ? `\n另有：${others.map((n) => `${n.name}（${n.structure}）`).join('、')} —— zk_use 切换本会话` : '')
                    : `笔记本「${v.notebook}」`;
                // G1 / G4：写 MEMORY 前的余量、是否触发截断、同日决胜与「下一条会丢谁」
                const capacity = `\n\n容量：余 ${v.headroom} 词（记忆内容 ${v.words}/${v.budget}，总载荷 ${v.totalWords}）` +
                    (v.extraWords > 0 ? ` · 拟新增 ${v.extraWords} 词${v.wouldTruncate ? '（会触发截断）' : ''}` : '') +
                    (v.sameDateCount > 1 ? ` · ${v.sameDateCount} 条同日，按位置决胜` : '') +
                    `\n${v.suggestion}` +
                    (v.dropCandidates.length
                        ? '\n下一条会丢的 MEMORY 条目（预告，磁盘不动）：\n' +
                            v.dropCandidates.map((c, i) => `${i + 1}. ${c.title}（${c.words} 词 · ${c.reason}${c.date ? ' · ' + c.date : ''}）`).join('\n')
                        : '');
                if (!v.text) {
                    return text(drift + head + capacity +
                        `\n\n知识库根目录没有 ${META_FILES.join(' / ')}（或都是空的），也没有 PERSONA.md 人格文件。`);
                }
                const persona = v.persona?.present
                    ? `\n\n人格：正文（含标题）${v.persona.contentWords}/${v.persona.budget} 词` +
                        `（${v.persona.files.filter((f) => f.present).map((f) => `${f.name} ${f.words} 词`).join(' · ')}）` +
                        (v.persona.overBudget ? `，超 ${v.persona.overWords} 词（人格不截断）` : '')
                    : '\n\n人格：未启用（根目录没有 PERSONA.md）';
                const totals = `\n\n用量：记忆载荷 ${v.totalWords} 词（预算 ${v.budget}）`;
                return text(drift + head + persona + totals + capacity + (v.text ? '\n\n' + v.text : ''));
            },
        }),
        t({
            name: 'zk_memory_write',
            description: '写记忆的第一个工具：往 MEMORY.md / USER.md 末尾追加一条结论。默认 dry_run: true，只预演、不动盘；' +
                '确认后传 dry_run: false 才真写（可把预演返回的 stamp 放进 expect_stamp，挡住「预演之后有人改过」）。' +
                '调用方给完整条目正文，插件只做机械门：必须是一条带 YYYY-MM-DD 与 [[来源]] 的顶层列表项、来源要解析到活笔记、' +
                '新增不能让注入载荷超预算（超了给结构化错误 + dropCandidates，绝不静默截断）。' +
                'action: retire 追加 `- [superseded …]` 标记（退役条目不进注入，不做容量门）。' +
                '不替换、不合并、不自动补日期 / 来源、不提议退役哪条 —— 语义判断全归调用方；' +
                '每次真实写入把 pre-image 摘要与一行 diff 追加到 DREAMS.md 供周审复核。' +
                '想改已有条目仍用原生 edit；本工具只往末尾追加。',
            parameters: {
                type: 'object',
                properties: {
                    target: S.enum('写哪份：MEMORY 或 USER（根目录 MEMORY.md / USER.md）', ['MEMORY', 'USER']),
                    action: S.enum('add（默认）= 追加一条现行结论；retire = 追加一条退役标记', ['add', 'retire']),
                    entry: S.str('完整条目正文，例：`- **结论。** 2026-11-12（来源：[[笔记标题]]）`；插件不改一个字'),
                    dry_run: S.bool('true（默认）= 只预演、不改盘；false = 真的写'),
                    expect_stamp: S.str('可选：预演返回的 stamp，带回来挡并发改动'),
                },
                required: ['entry'],
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    accepted: { type: 'boolean' },
                    rejection: { type: 'string' },
                    detail: { type: 'string' },
                    target: { type: 'string' },
                    action: { type: 'string', enum: ['add', 'retire'] },
                    dryRun: { type: 'boolean' },
                    performed: { type: 'boolean' },
                    source: { type: 'string' },
                    sourceTarget: { type: 'string' },
                    stamp: { type: 'string' },
                    words: { type: 'number' },
                    budget: { type: 'number' },
                    headroom: { type: 'number' },
                    extraWords: { type: 'number' },
                    wouldTruncate: { type: 'boolean' },
                    needToFree: { type: 'number' },
                    dropCandidates: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            date: { type: 'string' },
                            words: { type: 'number' },
                            reason: { type: 'string', enum: ['oldest', 'same-date', 'undated'] },
                        }, ['title', 'date', 'words', 'reason']),
                    },
                    beforeWords: { type: 'number' },
                    afterWords: { type: 'number' },
                    diff: { type: 'string' },
                    indexComplete: { type: 'boolean' },
                }, ['notebook', 'accepted', 'rejection', 'detail', 'target', 'action', 'dryRun', 'performed',
                    'source', 'sourceTarget', 'stamp', 'words', 'budget', 'headroom', 'extraWords', 'wouldTruncate',
                    'needToFree', 'dropCandidates', 'beforeWords', 'afterWords', 'diff', 'indexComplete']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                // 不 ensureNotebook：预演不该顺手建库。索引只为核实 [[来源]]，扫不全就只放路径式来源过。
                let index = { byTitle: new Map(), byId: new Map() };
                let indexComplete = false;
                if (hasNotebook(cfg)) {
                    try {
                        const scan = await scanNotes(cfg, {}, env.signal);
                        index = wikiIndex(scan.notes);
                        indexComplete = scan.completeness === 'complete';
                    }
                    catch { /* 索引不可用时退化为「只有路径式来源能过」，不装作全库可解析 */ }
                }
                const r = writeMemory(cfg, {
                    target: (args.target ? String(args.target) : 'MEMORY'),
                    action: (args.action ? String(args.action) : 'add'),
                    entry: String(args.entry ?? ''),
                    dryRun: args.dry_run !== false,
                    expectStamp: args.expect_stamp ? String(args.expect_stamp) : undefined,
                    index,
                    indexComplete,
                });
                return { notebook: cfg.notebook, ...r };
            },
            render(_args, value) {
                const v = value;
                const lines = [];
                if (!v.accepted) {
                    lines.push(`已拒绝（${v.rejection}）：${v.detail}`);
                    if (v.rejection === 'over-budget') {
                        lines.push(`当前记忆 ${v.words}/${v.budget} 词，余 ${v.headroom} 词；拟新增 ${v.extraWords} 词，需先腾出 ${v.needToFree} 词。`);
                        if (v.dropCandidates.length) {
                            lines.push('会让位的条目（插件不替你退役）：');
                            for (const c of v.dropCandidates)
                                lines.push(`  · ${c.title}（${c.words} 词 · ${c.reason}${c.date ? ' · ' + c.date : ''}）`);
                        }
                    }
                    return text(lines.join('\n'));
                }
                if (v.dryRun) {
                    lines.push(`预演通过（没有动任何文件）：将往 ${v.target} 追加一条。`);
                    lines.push(v.diff);
                }
                else {
                    lines.push(`已写入 ${v.target}：${v.diff}`);
                    lines.push('pre-image 摘要与这行 diff 已追加到 DREAMS.md，供周审复核。');
                }
                lines.push(`来源：[[${v.sourceTarget}]] → ${v.source || '（未解析）'}`);
                lines.push(`容量：记忆 ${v.words}/${v.budget} 词，余 ${v.headroom} 词` +
                    (v.action === 'add' ? ` · 本次新增 ${v.extraWords} 词` : ' · 退役标记不占注入预算') +
                    ` · 文件词数 ${v.beforeWords} → ${v.afterWords}`);
                if (!v.indexComplete)
                    lines.push('⚠️ 活笔记索引没扫全，本次只核实了路径式来源。');
                if (v.dryRun)
                    lines.push(`确认后传 dry_run: false 执行；建议带上 expect_stamp: "${v.stamp}"。`);
                return text(lines.join('\n'));
            },
        }),
        t({
            name: 'zk_lint',
            description: '给知识库做体检：断链 / 孤儿 / 无标签 / 单向链接 / 陈旧（N 天没改）/ 重名标题，每类最多 50 条并给总数。' +
                'frontmatter 解析失败的笔记单列一类：它们进不了索引，别的项统计不到，先修它们再看其余。' +
                'memoryLinks 查 MEMORY.md / USER.md 里的 [[来源链接]] 是否还指向活笔记（已废弃 / 不存在）—— ' +
                'supersede 不会重写 meta 文件里的链接，这类漂移 broken-links 看不见；另数没附链接（unlinked）、' +
                '没写日期（undated）、已退役（retired）、退役后新结论失效（retiredBroken）与超过 90 天没复核（stale）的条目。' +
                'incomplete 是 frontmatter 缺 type / status / authority 的笔记：缺失被索引落成空串，机械门会静默失效。' +
                'tags 查标签卫生（大小写变体 / 单例，标签总数 ≥ 30 才报）；template 说根目录 AGENTS.md 是不是当前版本。' +
                'similarTitles 是「改一两个字」的疑似重复（同目录、二元组相似度 ≥ 0.6）：与全等重名分开，只报告。' +
                'missingId 是缺稳定 id 的非日记笔记数：zk_new 新建的笔记自动写 id，老笔记只提示、不回填。' +
                'timeline 是日记时间轴：最近 90 天的空块 / 倒序 / 格式（11:5x）/ 位置（layered 用 ##、或在 ## Events 外）问题，只报告不改文件。' +
                'total / counts 按全量算，items 里每篇最多 50 条明细，整个桶最多 50 篇；skipped 是过大或读不到而没检查的篇数。' +
                'indexHint=true 表示笔记（不含日记）已到 150 篇而根目录还没有 INDEX.md（只是提示，不生成静态索引）。' +
                '孤儿与无标签不含日记（按天写的日记天然如此，报出来只会淹没真问题）。' +
                'oneWayLinks.items 是缺回链的目标 X（不是来源），from 是没被 X 回链的来源 S；' +
                'edges 是全部单向边数（items 截到 50 条时仍计全量），bodyOnly 是正文引用（不在 ## Links / ## 链接 小节）的单向边数。' +
                'links_only=true 时只列 Links 小节的单向链接，正文引用只进 bodyOnly，适合把桶当可修清单。' +
                'S 或 X 是日记的边不算 —— 日记天然是出边，回链它没有意义。' +
                '笔记数触到扫描上限只会漏报；但 oneWayLinks.edgesTruncated=true 表示边集可能不完整（小库建图触顶，' +
                '或大库按篇反查触到 50 目标 / 60 子进程的上限）—— 缺掉的回链边会把双向误判成单向，' +
                '这是唯一可能误报的截断，看到它先缩小排查范围再重跑。' +
                '只读：不改任何笔记。拿到清单后自己判断先修哪个，再用 zk_link / zk_append / zk_supersede 动手。',
            parameters: {
                type: 'object',
                properties: {
                    stale_days: S.num('多少天没修改算陈旧（1-3650，默认 90）'),
                    links_only: S.bool('只报 Links 小节的单向链接；正文引用只计数（默认 false）'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    notes: { type: 'number' },
                    missingId: { type: 'number' },
                    truncated: { type: 'boolean' },
                    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
                    scanLimit: { type: 'number' },
                    staleDays: { type: 'number' },
                    parseErrors: LINT_PARSE,
                    orphans: LINT_BUCKET,
                    brokenLinks: LINT_BUCKET,
                    stale: LINT_STALE,
                    tagless: LINT_BUCKET,
                    oneWayLinks: LINT_ONE_WAY,
                    duplicateTitles: LINT_DUPLICATE,
                    similarTitles: LINT_SIMILAR,
                    memoryLinks: LINT_MEMORY,
                    incomplete: LINT_INCOMPLETE,
                    tags: LINT_TAGS,
                    template: LINT_TEMPLATE,
                    persona: LINT_PERSONA,
                    timeline: LINT_TIMELINE,
                    emptySections: LINT_EMPTY_SECTIONS,
                    indexHint: { type: 'boolean' },
                    indexLag: { type: 'string' },
                }, ['notebook', 'notes', 'missingId', 'truncated', 'completeness', 'scanLimit', 'staleDays', 'parseErrors', 'orphans', 'brokenLinks', 'stale', 'tagless', 'oneWayLinks', 'duplicateTitles', 'similarTitles', 'memoryLinks', 'incomplete', 'tags', 'template', 'persona', 'timeline', 'emptySections', 'indexHint', 'indexLag']),
            },
            async run(args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                return lintNotebook(cfg, {
                    staleDays: args.stale_days === undefined ? undefined : Number(args.stale_days),
                    linksOnly: args.links_only === true,
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
                const oneWay = v.oneWayLinks;
                const oneWayLabel = oneWay.linksOnly ? '单向链接（Links）' : '单向链接';
                const bodyNote = oneWay.bodyOnly > 0
                    ? (oneWay.linksOnly ? '（另有正文引用 ' + oneWay.bodyOnly + ' 条未计）' : '（正文引用 ' + oneWay.bodyOnly + ' 条）')
                    : '';
                if (oneWay.total === 0)
                    lines.push('✓ ' + oneWayLabel + '：0' + bodyNote);
                else {
                    const items = oneWay.items.slice(0, 5).map((i) => i.path + ' ← ' + i.from.join('、'));
                    lines.push('✗ ' + oneWayLabel + '：' + oneWay.total + ' 篇 / ' + oneWay.edges + ' 条单向边' +
                        bodyNote +
                        ' — ' + items.join('；') + (oneWay.total > items.length ? ' …' : ''));
                }
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
                lines.push(...formatLintExtras(v));
                if (v.similarTitles.completeness === 'partial') {
                    lines.push('⚠️ 疑似重复只比较了部分笔记：可能漏报' +
                        (v.similarTitles.droppedGroups > 0 ? '（' + v.similarTitles.droppedGroups + ' 组超过 300 篇，只比较了前 300 篇）' : '') +
                        (v.completeness === 'partial' ? '（笔记扫描触顶）' : ''));
                }
                if (v.completeness === 'partial') {
                    lines.push('⚠️ 笔记数触到扫描上限（' + v.scanLimit + ' 篇）：结果不完整（只会漏报，不会误报），先归档旧笔记再跑一次');
                }
                else if (v.completeness === 'unknown') {
                    lines.push('⚠️ 扫描结果无法完整解析：下面的数字不能当成全部（可能少报）');
                }
                if (oneWay.completeness === 'partial')
                    lines.push('⚠️ 建图笔记载入触到上限：单向链接可能误报（回链边未加载），先归档旧笔记再跑一次');
                else if (oneWay.completeness === 'unknown')
                    lines.push('⚠️ 无法确认单向链接的边集是否完整（旧版 zk 未给出载入篇数）：可能误报');
                if (v.indexLag)
                    lines.push('⚠️ 索引可能落后：' + v.indexLag);
                lines.push('（只报告，没有改动任何文件）');
                return text(lines.join('\n'));
            },
        }),
        t({
            name: 'zk_dream',
            description: '整理晋升材料：最近 N 天新增的笔记（机械筛掉 authority=informal 与无标签的，其余作为候选）、' +
                'daily 里没划掉的 Loose ends、被引用最多的笔记。候选带正文摘要（lead）与入链来源（citedBy），方便重放上下文。' +
                'topCited 先按「被日记提到几天」排（使用信号），入链数只作并列次序；没有日记时退化为原排序。' +
                '会读 MEMORY.md：已经晋升过的（`[[链接]]` 命中或条目里写了标题）移出候选、进 alreadyPromoted —— 不会每周原样重复。' +
                '退役行里的旧标题不再算已晋升，但 `→ [[新结论]]` 仍算。' +
                'backlog 是窗口外仍未晋升的笔记（按被引数），漏做一次不会永久掉队。' +
                '库超过全图统计上限时不再建全图统计入链（默认 2000 篇，设置页可调；graphBudget 给出生效值）：' +
                'graphSkipped=true，cited / citedBy / topCited 为空 —— 那是「没算」，不是「没人引」。' +
                'missingId 是缺稳定 id 的非日记笔记数（只提示、不回填）；MEMORY 里可以用 [[<id>]] 当来源，改名后仍指向同一篇。' +
                'memory 给记忆余量（内容词 + 提示 = 总词，余量按总词算，可以为负）；retireCandidates 给「可考虑退役」的条目' +
                '（来源归档 / 不存在、超过 ' + STALE_DAYS + ' 天未复核；显式写 archive/ 的有意引用不算）。' +
                'days 省略时窗口 = 距 DREAMS.md「上次做梦」的天数（没有则 7 天）。' +
                '只返回材料：写 MEMORY.md / DREAMS.md 由你按 AGENTS.md 决定，这个工具不写任何文件。',
            parameters: {
                type: 'object',
                properties: {
                    days: S.num('看最近多少天（1-365）；省略时 = 距 DREAMS.md「上次做梦」的天数，没有这行才退回 7'),
                },
                additionalProperties: false,
            },
            output: {
                schema: objSchema({
                    notebook: { type: 'string' },
                    windowDays: { type: 'number' },
                    since: { type: 'string' },
                    truncated: { type: 'boolean' },
                    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
                    scanLimit: { type: 'number' },
                    graphSkipped: { type: 'boolean' },
                    graphBudget: { type: 'number' },
                    missingId: { type: 'number' },
                    memory: objSchema({
                        words: { type: 'number' },
                        personaWords: { type: 'number' },
                        totalWords: { type: 'number' },
                        budget: { type: 'number' },
                        headroom: { type: 'number' },
                        /** G1：与 zk_lint.memoryLinks 同一口径的格式债 / 退役计数 */
                        undated: { type: 'number' },
                        unlinked: { type: 'number' },
                        retired: { type: 'number' },
                        files: {
                            type: 'array',
                            items: objSchema({
                                name: { type: 'string' },
                                present: { type: 'boolean' },
                                words: { type: 'number' },
                                originalWords: { type: 'number' },
                                retiredWords: { type: 'number' },
                            }, ['name', 'present', 'words', 'originalWords', 'retiredWords']),
                        },
                    }, ['words', 'personaWords', 'totalWords', 'budget', 'headroom', 'undated', 'unlinked', 'retired', 'files']),
                    counts: objSchema({
                        window: { type: 'number' },
                        daily: { type: 'number' },
                        candidates: { type: 'number' },
                        rejected: { type: 'number' },
                        looseEnds: { type: 'number' },
                        promoted: { type: 'number' },
                        backlog: { type: 'number' },
                    }, ['window', 'daily', 'candidates', 'rejected', 'looseEnds', 'promoted', 'backlog']),
                    newNotes: { type: 'array', items: DREAM_CANDIDATE },
                    alreadyPromoted: { type: 'array', items: DREAM_CANDIDATE },
                    backlog: { type: 'array', items: DREAM_CANDIDATE },
                    rejected: {
                        type: 'array',
                        items: objSchema({ title: { type: 'string' }, path: { type: 'string' }, reason: { type: 'string' } }, ['title', 'path', 'reason']),
                    },
                    topCited: {
                        type: 'array',
                        items: objSchema({
                            title: { type: 'string' },
                            path: { type: 'string' },
                            cited: { type: 'number' },
                            dailyMentions: { type: 'number' },
                            daysMentioned: { type: 'number' },
                            lastMentioned: { type: 'string' },
                            /** 15.2：仅在召回信号生效时出现（可选，默认关时输出逐字节不变） */
                            recallDays: { type: 'number' },
                            recallKinds: { type: 'number' },
                        }, ['title', 'path', 'cited', 'dailyMentions', 'daysMentioned', 'lastMentioned']),
                    },
                    dailyLooseEnds: {
                        type: 'array',
                        items: objSchema({
                            path: { type: 'string' },
                            date: { type: 'string' },
                            items: { type: 'array', items: { type: 'string' } },
                        }, ['path', 'date', 'items']),
                    },
                    retireCandidates: {
                        type: 'array',
                        items: objSchema({
                            entry: { type: 'string' },
                            date: { type: 'string' },
                            age: { type: 'number' },
                            reason: { type: 'string', enum: ['stale', 'source-missing', 'source-superseded'] },
                        }, ['entry', 'date', 'age', 'reason']),
                    },
                    /** 15.2：仅在召回信号生效时出现；固定比例、与分数无关的窗口外抽样 */
                    auditSamples: { type: 'array', items: DREAM_CANDIDATE },
                }, ['notebook', 'windowDays', 'since', 'truncated', 'completeness', 'scanLimit', 'graphSkipped', 'graphBudget', 'missingId', 'memory', 'counts', 'newNotes', 'alreadyPromoted', 'backlog', 'rejected', 'topCited', 'dailyLooseEnds', 'retireCandidates']),
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
                        ' · 未完成 ' + v.counts.looseEnds + ' · 已晋升 ' + v.counts.promoted + ' · 积压 ' + v.counts.backlog,
                ];
                // 余量按记忆侧总词算（框 + 提示 + notice 都算）：只报内容词等于说「还有 15 词」，而提示早把它吃完了。
                // 人格单独注入，先从 totalWords 里扣掉 —— 它不占记忆预算，也不该被叫成「提示」。
                const memoryTotal = v.memory.totalWords - v.memory.personaWords;
                const promptWords = Math.max(0, memoryTotal - v.memory.words);
                lines.push('记忆：内容 ' + v.memory.words + '/' + v.memory.budget + ' 词 + 提示 ' + promptWords +
                    ' = ' + memoryTotal + ' 词（余 ' + v.memory.headroom + '）' +
                    (v.memory.personaWords > 0 ? ' · 人格 ' + v.memory.personaWords + ' 词（单独注入，不计入记忆预算）' : ''));
                if (v.missingId > 0)
                    lines.push('· 稳定 ID：' + v.missingId + ' 篇没有 id — 新笔记自动写入，老笔记只提示、不回填（§9.2）');
                if (v.retireCandidates.length) {
                    lines.push('可考虑退役：');
                    for (const c of v.retireCandidates.slice(0, 10)) {
                        const when = c.date ? c.date + '（' + c.age + ' 天）' : '无日期';
                        const why = c.reason === 'stale'
                            ? '超过 ' + STALE_DAYS + ' 天未复核'
                            : c.reason === 'source-superseded' ? '来源已归档' : '来源不存在';
                        lines.push('  · ' + c.entry + ' — ' + when + ' · ' + why);
                    }
                }
                if (v.newNotes.length) {
                    lines.push('晋升候选：');
                    for (const [i, n] of v.newNotes.slice(0, 10).entries()) {
                        const badges = [n.type || '—', n.authority || '—'].join(' · ');
                        const lead = n.lead ? '\n     ' + n.lead : '';
                        const citedBy = n.citedBy.length ? '\n     被引：' + n.citedBy.join('、') : '';
                        const used = n.daysMentioned > 0 ? ' · 日记 ' + n.daysMentioned + ' 天' : '';
                        lines.push('  ' + (i + 1) + '. ' + (n.title || n.path) + '  [' + badges + ']  ' + n.path +
                            (n.tags.length ? ' · ' + n.tags.map((t) => '#' + t).join(' ') : '') +
                            ' · 被引 ' + n.cited + used + lead + citedBy);
                    }
                    if (v.newNotes.length > 10)
                        lines.push('  …还有 ' + (v.newNotes.length - 10) + ' 篇');
                }
                if (v.alreadyPromoted.length) {
                    lines.push('已在 MEMORY（不再重复提）：');
                    for (const n of v.alreadyPromoted.slice(0, 10)) {
                        lines.push('  · ' + (n.title || n.path) + '（' + n.path + '）· ' + (n.promotedBy === 'link' ? '按链接命中' : '标题出现在条目里'));
                    }
                    if (v.alreadyPromoted.length > 10)
                        lines.push('  …还有 ' + (v.alreadyPromoted.length - 10) + ' 篇');
                }
                if (v.backlog.length) {
                    lines.push('窗口外仍未晋升（按被引数）：');
                    for (const n of v.backlog.slice(0, 10))
                        lines.push('  · ' + (n.title || n.path) + '（' + n.path + '）· 被引 ' + n.cited);
                    if (v.counts.backlog > v.backlog.length)
                        lines.push('  …还有 ' + (v.counts.backlog - v.backlog.length) + ' 篇');
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
                    for (const [i, c] of v.topCited.slice(0, 5).entries()) {
                        lines.push('  ' + (i + 1) + '. ' + (c.title || c.path) + '（' + c.path + '）· 被引 ' + c.cited + ' 次' +
                            (c.daysMentioned > 0 ? ' · 日记 ' + c.daysMentioned + ' 天（最近 ' + c.lastMentioned + '）' : ''));
                    }
                }
                if (v.auditSamples?.length) {
                    lines.push('审计抽样（与分数无关，固定比例）：');
                    for (const n of v.auditSamples.slice(0, 10))
                        lines.push('  · ' + (n.title || n.path) + '（' + n.path + '）');
                }
                if (!v.newNotes.length && !v.dailyLooseEnds.length && !v.topCited.length && !v.auditSamples?.length)
                    lines.push('这个窗口里没有新材料。');
                if (v.completeness === 'partial')
                    lines.push('⚠️ 笔记数触到扫描上限（' + v.scanLimit + ' 篇）：窗口与排名都不完整');
                else if (v.completeness === 'unknown')
                    lines.push('⚠️ 扫描结果无法完整解析：窗口与排名可能不完整');
                if (v.graphSkipped) {
                    lines.push('⚠️ 库超过全图统计上限（' + v.graphBudget + ' 篇），这次没统计入链：被引数与 topCited 是空的，不代表没人引用；可在设置页调整「全图统计上限（篇）」（graphBudgetNotes）');
                }
                lines.push('（只报告：MEMORY.md / DREAMS.md 由你按 AGENTS.md 写）');
                return text(lines.join('\n'));
            },
        }),
        t({
            name: 'zk_stats',
            description: '看一眼知识库现状：笔记数、标签数、断链数、孤立笔记数、已归档（superseded）数，以及顶层目录 / 前 10 个标签的分布（byDir / byTag）。' +
                '适合开始工作前了解上下文规模；笔记多了以后用它判断该先看哪里（不是排行榜）。',
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
                    byDir: {
                        type: 'array',
                        items: objSchema({ dir: { type: 'string' }, count: { type: 'number' } }, ['dir', 'count']),
                    },
                    byTag: {
                        type: 'array',
                        items: objSchema({ tag: { type: 'string' }, count: { type: 'number' } }, ['tag', 'count']),
                    },
                    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
                    scanLimit: { type: 'number' },
                    /** 本地聚合计数（plan §14.4）：只看「入口 / 一跳」这条路有没有被用上，不记查询词 */
                    usage: objSchema({
                        since: { type: 'string' },
                        search: { type: 'number' },
                        query: { type: 'number' },
                        recall: { type: 'number' },
                        walk: { type: 'number' },
                        entryPoints: { type: 'number' },
                        counterEntries: { type: 'number' },
                    }, ['since', 'search', 'query', 'recall', 'walk', 'entryPoints', 'counterEntries']),
                }, ['notebook', 'defaultNotebook', 'pinned', 'notes', 'tags', 'brokenLinks', 'orphans', 'archived', 'superseded', 'byDir', 'byTag', 'completeness', 'scanLimit', 'usage']),
            },
            async run(_args, env) {
                const cfg = configFor(env.workspace, env.sessionId);
                await ensureNotebook(cfg, env.signal);
                const stats = await notebookStats(cfg, env.signal);
                const state = sessionState(env.workspace, env.sessionId);
                const usage = readUsage(cfg);
                const count = (key) => usage.counts[key] ?? 0;
                return {
                    notebook: cfg.notebook,
                    defaultNotebook: state.defaultName,
                    pinned: state.diverged ? state.pinned : '',
                    ...stats,
                    usage: {
                        since: usage.since,
                        search: count('search'),
                        query: count('query'),
                        recall: count('recall'),
                        walk: count('walk'),
                        entryPoints: count('entryPoints'),
                        counterEntries: count('counterEntries'),
                    },
                };
            },
            render(_args, value) {
                const v = value;
                const drift = v.pinned && v.pinned !== v.defaultNotebook
                    ? `\n本会话固定在「${v.pinned}」；全局默认是「${v.defaultNotebook}」（要跟随用 zk_use ${v.defaultNotebook}）`
                    : '';
                const dirs = v.byDir.length
                    ? '\n目录：' + v.byDir.map((d) => `${d.dir === '.' ? '（根目录）' : d.dir} ${d.count}`).join(' · ')
                    : '';
                const tags = v.byTag.length
                    ? '\n标签：' + v.byTag.map((t) => `#${t.tag} ${t.count}`).join(' · ')
                    : '';
                const atLeast = v.completeness === 'complete' ? '' : '≥';
                const partial = v.completeness === 'partial'
                    ? `\n⚠️ 只扫描了前 ${v.scanLimit} 篇：上面的数字是下限`
                    : v.completeness === 'unknown' ? '\n⚠️ 扫描结果无法完整解析：上面的数字可能偏少' : '';
                const usage = v.usage && (v.usage.walk || v.usage.entryPoints || v.usage.counterEntries || v.usage.recall)
                    ? `\n入口 / 一跳：walk ${v.usage.walk} 次 · 召回 ${v.usage.recall} 次 · 入口回显 ${v.usage.entryPoints} 次 · 死胡同提醒 ${v.usage.counterEntries} 次` +
                        (v.usage.since ? `（自 ${v.usage.since.slice(0, 10)}）` : '')
                    : '\n入口 / 一跳：还没有计数（zk_walk / zk_recall / 入口与死胡同提醒都没被用过）';
                return text(`笔记本 ${v.notebook}${drift}\n` +
                    `笔记 ${atLeast}${v.notes} 篇 · 标签 ${atLeast}${v.tags} 个 · 断链 ${v.brokenLinks} 篇 · 孤立 ${v.orphans} 篇 · 归档 ${atLeast}${v.archived} 篇（superseded ${atLeast}${v.superseded}）` +
                    dirs + tags + partial + usage);
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
    // 别名工具跟着笔记本里的 [alias] 走：没有定义别名时这里就是空数组，内置工具数量不变。
    // 默认不注册（aliasTools=false）：别名是 `$SHELL -c` 的任意命令，注册成工具等于把它交到模型手里，
    // 得由人显式打开；关着时连 config.toml 都不读。
    // 配置读不了 / 宿主工作区取不到都不能拖垮内置工具：别名只是附加能力。
    let aliases = [];
    try {
        const workspace = workspaceOf(undefined);
        const cfg = config(workspace);
        const taken = new Set(builtins.map((tool) => tool.name));
        if (cfg.aliasTools) {
            aliases = configuredAliases(cfg, workspace)
                .filter((alias) => !taken.has(`zk_${alias.name}`)) // 别名 search → zk_search 会和内置工具撞名
                .map((alias) => aliasTool(alias, workspaceOf));
        }
    }
    catch { /* 内置工具照常注册 */ }
    return [...builtins, ...aliases];
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
