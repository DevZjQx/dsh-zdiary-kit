/**
 * 笔记本自举：目录 → zk init → 模板 → group 配置 → 建索引。
 *
 * 幂等：每一步都是「缺了才补」，第二次调用什么都不改。
 * 不覆盖用户已有配置：只在缺少 `[group."<name>"]` 时追加，其它内容一字不动。
 *
 * 两种结构（Config.structure）：
 *   · flat（默认，0.1.0 行为逐字节一致）：notes/ + 日记 + 一个 daily group；
 *   · layered：raw / notes/{sources,concepts,entities,patterns} / archive + 三套模板（daily / source / entry）+ 五个 group。
 * 切到 layered **只建目录与模板，不搬已有笔记**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZkError, zk } from './zk.js';
import { AGENTS_TEMPLATE, AGENTS_TEMPLATE_FLAT, WORKFLOW_TEMPLATE } from './agents-template.js';
import { PERSONA_TEMPLATE, POLICY_TEMPLATE } from './persona-template.js';
import { effectivePaths, isPluginOwned, normGroupPath, parseGroupBlocks, sameGroupPath, samePaths } from './notebook-config.js';
export { AGENTS_TEMPLATE, AGENTS_TEMPLATE_FLAT, WORKFLOW_TEMPLATE } from './agents-template.js';
export const DAILY_TEMPLATE = `# {{format-date now "%Y-%m-%d"}}

{{content}}
`;
/** layered 的日记模板：多三节，`{{content}}` 必须在，否则 stdin 的正文被丢（Z9） */
export const DAILY_TEMPLATE_LAYERED = `# {{format-date now "%Y-%m-%d"}}

## Events

{{content}}

## Observations

## Loose ends
`;
/** 原始材料：保留 Key claims / Quotes，跟概念笔记分开模板 */
export const SOURCE_TEMPLATE = `---
type: {{extra.type}}
title: {{title}}
date: {{format-date now "%Y-%m-%d"}}
status: active
authority: {{extra.authority}}
tags: []
---

# {{title}}

## Summary

## Key claims

## Quotes

{{content}}

## Links
`;
/** concept / entity / pattern 共用（type 由 group extra 注入） */
export const ENTRY_TEMPLATE = `---
type: {{extra.type}}
title: {{title}}
date: {{format-date now "%Y-%m-%d"}}
status: active
authority: {{extra.authority}}
tags: []
---

# {{title}}

## Summary

## Content

{{content}}

## Links
`;
function groupSection(spec) {
    const dots = `group."${spec.name}"`;
    const paths = spec.paths.map((p) => JSON.stringify(p)).join(', ');
    let out = `\n# ${spec.comment}\n[${dots}]\npaths = [${paths}]\n\n[${dots}.note]\n`;
    if (spec.filename)
        out += `filename = '${spec.filename}'\n`;
    out += `template = "${spec.template}"\n`;
    if (spec.extra) {
        out += `\n[${dots}.extra]\n`;
        for (const [key, value] of Object.entries(spec.extra))
            out += `${key} = "${value}"\n`;
    }
    return out;
}
function dailyGroup(cfg) {
    return {
        name: cfg.dailyGroup,
        paths: [cfg.dailyDir],
        template: 'daily.md',
        filename: '{{format-date now "%Y-%m-%d"}}',
        comment: 'dsh-zdiary-kit：日记笔记组（一天一篇，文件名就是日期）',
    };
}
/** layered 的四种笔记类型（顺序与目录 / group 一致） */
export const NOTE_KINDS = ['source', 'concept', 'entity', 'pattern'];
/** type → 目录名的复数（entity 不规则，不能直接加 s） */
const PLURAL_DIR = {
    source: 'sources',
    concept: 'concepts',
    entity: 'entities',
    pattern: 'patterns',
};
/** type 对应的笔记目录（相对笔记本）；不认识的 type 返回 null */
export function noteKindDir(notesDir, kind) {
    return Object.hasOwn(PLURAL_DIR, kind) ? `${notesDir}/${PLURAL_DIR[kind]}` : null;
}
/** 目录比较前的归一化：去掉开头的 ./、结尾的 /、重复的 /，反斜杠当分隔符 */
function normDir(rel) {
    const clean = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
    return clean === '.' ? '' : clean;
}
/**
 * 新建笔记的落点目录。flat 就是 notesDir；layered 必须落在某个 group 的 paths 里
 * （group 下的子目录也算，zk 按路径前缀归组）。
 * 不给 dir 就按 type 落位（source → notes/sources）；连 type 都没有、或者显式给的 dir
 * 不在任何 group 里，都直接报错 —— notes/ 根不属于任何 group，zk 会退回内置模板：
 * 没有 frontmatter、文件名是随机 {{id}}。
 */
export function newNoteDir(cfg, input = {}) {
    const given = input.dir ? normDir(input.dir) : '';
    if (cfg.structure !== 'layered')
        return given || normDir(cfg.notesDir);
    const groups = expectedGroups(cfg).flatMap((group) => group.paths.map(normDir));
    const hint = `可选目录：${groups.join(' / ')}（group 下的子目录也行）；` +
        `落在 ${cfg.notesDir}/ 根不会套模板，没有 frontmatter，文件名是随机 id`;
    const dir = given || (input.type ? noteKindDir(cfg.notesDir, input.type) : null);
    if (!dir) {
        throw new ZkError('layered 笔记本新建笔记要给 dir（notes/sources 等），或者给 type 让目录跟着类型走', hint);
    }
    if (!groups.some((base) => dir === base || dir.startsWith(`${base}/`))) {
        throw new ZkError(`${dir}/ 不在任何 group 里：layered 下笔记必须落在 group 里才套模板`, hint);
    }
    return dir;
}
function layeredGroups(cfg) {
    const base = cfg.notesDir;
    const named = (kind, template, authority) => ({
        name: kind,
        paths: [`${base}/${PLURAL_DIR[kind]}`],
        template,
        filename: '{{slug title}}',
        extra: { type: kind, authority },
        comment: `dsh-zdiary-kit：${kind} 笔记组`,
    });
    return [
        dailyGroup(cfg),
        named('source', 'source.md', 'official'),
        named('concept', 'entry.md', 'expert'),
        named('entity', 'entry.md', 'official'),
        named('pattern', 'entry.md', 'expert'),
    ];
}
/** 当前结构期望的 group（flat 一个，layered 五个）；顺序与目录一致 */
export function expectedGroups(cfg) {
    return cfg.structure === 'layered' ? layeredGroups(cfg) : [dailyGroup(cfg)];
}
/** 当前结构需要的目录（相对笔记本；flat 只有笔记与日记两个） */
export function structureDirs(cfg) {
    const rels = [cfg.notesDir, cfg.dailyDir];
    if (cfg.structure === 'layered') {
        rels.push('raw', ...Object.values(PLURAL_DIR).map((dir) => `${cfg.notesDir}/${dir}`), cfg.archiveDir);
    }
    return [...new Set(rels)];
}
/** 同一批 group 两两查「同一条路径」：每对只报一次 */
function overlapsOf(entries) {
    const out = [];
    for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        if (!a)
            continue;
        for (let j = i + 1; j < entries.length; j++) {
            const b = entries[j];
            if (!b)
                continue;
            const shared = (a.paths ?? []).find((x) => (b.paths ?? []).some((y) => sameGroupPath(x, y)));
            if (shared !== undefined)
                out.push({ a: a.name, b: b.name, path: normGroupPath(shared) });
        }
    }
    return out;
}
function groupStatuses(groups, blocks) {
    return groups.map((group) => {
        const block = blocks?.get(group.name) ?? null;
        // 缺 paths 的 group 按同名目录占着（zk 语义）：冲突判断必须算上，否则会追加同路径组
        const actualPaths = block ? effectivePaths(block) : null;
        const actualTemplate = block?.template ?? null;
        const conflict = block ? undefined : [...(blocks?.values() ?? [])].find((candidate) => effectivePaths(candidate)?.some((actual) => group.paths.some((expected) => sameGroupPath(actual, expected))))?.name;
        return {
            name: group.name,
            expectedPaths: group.paths,
            actualPaths,
            pathsOk: !!block && !block.duplicate && samePaths(actualPaths, group.paths),
            present: !!block,
            expectedTemplate: group.template,
            actualTemplate,
            templateOk: !!block && !block.duplicate && actualTemplate === group.template,
            duplicate: !!block?.duplicate,
            owned: !!block && isPluginOwned(block),
            ...(conflict ? { conflict } : {}),
        };
    });
}
/**
 * 重叠说明（给人看的一行）；level = config 是配置本身冲突、file 是 config.toml 里已经撞了。
 * 同一对只报一次：两边都说一遍只会让设置页的告警更长。
 * 父子目录不算冲突（zk 按最具体的路径归组），所以措辞只说「同一条路径」。
 */
export function groupOverlapNotes(st) {
    const out = [];
    const seen = new Set();
    const key = (o) => [o.a, o.b].sort().join('|');
    for (const o of st.expectedOverlaps) {
        seen.add(key(o));
        out.push({
            level: 'config',
            text: `group "${o.a}" 与 "${o.b}" 都用 ${o.path} —— 改 dailyDir / notesDir，或换结构（groups --fix 不会写）`,
        });
    }
    for (const o of st.actualOverlaps) {
        if (seen.has(key(o)))
            continue;
        out.push({
            level: 'file',
            text: `group "${o.a}" 与 "${o.b}" 的 paths 都是 ${o.path} —— 手动检查 .zk/config.toml`,
        });
    }
    return out;
}
function groupWarningsOf(groups, st) {
    const out = [];
    for (const group of groups) {
        if (!group.present) {
            out.push(group.conflict
                ? `缺 group "${group.name}"：路径 ${group.expectedPaths.join('、')} 已被 group "${group.conflict}" 占用 —— 跑 zk-kit groups --fix`
                : `缺 group "${group.name}"（期望 ${group.expectedPaths.join('、')}）—— 跑 zk-kit groups --fix`);
        }
        else if (group.duplicate) {
            out.push(`group "${group.name}" 重复出现，解析不了 —— 手动检查 .zk/config.toml`);
        }
        else if (!group.pathsOk) {
            out.push(`group "${group.name}" ${pathsDiff(group.expectedPaths, group.actualPaths)}`);
        }
    }
    for (const note of groupOverlapNotes(st))
        out.push(note.text);
    return out;
}
/** 期望 / 实际 paths 的差异尾巴；actual 为 null = 解析不了（多行数组 / 未加引号的项），--fix 也不猜 */
function pathsDiff(expected, actual) {
    return `期望 ${expected.join('、')}，实际 ${actual?.join('、') ?? '解析不了'}` +
        (actual === null ? '（可能是多行数组）—— 手动编辑 .zk/config.toml' : ' —— 跑 zk-kit groups --fix');
}
/** 结构一致性检查：只报告，不建目录、不改配置（设置页据此显示告警） */
export function structureStatus(cfg) {
    const dirs = structureDirs(cfg);
    const missing = dirs.filter((rel) => !fs.existsSync(path.join(cfg.notebook, rel)));
    const agentsPath = path.join(cfg.notebook, 'AGENTS.md');
    const required = cfg.structure === 'layered';
    // 只看「会改变新建笔记落点」的目录：分层笔记目录与 raw/inbox。
    // archive 对两种结构都合法，不参与漂移判断。
    const drift = cfg.structure === 'flat'
        ? ['raw', 'inbox', ...Object.values(PLURAL_DIR).map((dir) => `${cfg.notesDir}/${dir}`)]
        : [];
    const extra = [...new Set(drift)]
        .map(normDir)
        .filter((rel) => !dirs.map(normDir).includes(rel))
        .filter((rel) => fs.existsSync(path.join(cfg.notebook, rel)))
        .sort();
    let blocks = null;
    try {
        blocks = parseGroupBlocks(fs.readFileSync(path.join(cfg.notebook, '.zk', 'config.toml'), 'utf8'));
    }
    catch {
        blocks = null;
    }
    const expected = expectedGroups(cfg);
    const groups = groupStatuses(expected, blocks);
    const expectedOverlaps = overlapsOf(expected);
    // 重复出现的组解析不出 paths，不参与「文件里已经撞了」的判断；缺 paths 的按同名目录算（zk 语义）
    const actualOverlaps = blocks
        ? overlapsOf([...blocks.values()].filter((block) => !block.duplicate)
            .map((block) => ({ name: block.name, paths: effectivePaths(block) })))
        : [];
    return {
        mode: cfg.structure,
        dirs,
        missing,
        extra,
        ready: missing.length === 0,
        agents: { path: agentsPath, required, present: fs.existsSync(agentsPath) },
        groups,
        expectedOverlaps,
        actualOverlaps,
        groupsOk: !!blocks && groups.every((group) => group.present && group.pathsOk) &&
            expectedOverlaps.length === 0 && actualOverlaps.length === 0,
        groupWarnings: blocks ? groupWarningsOf(groups, { expectedOverlaps, actualOverlaps }) : [],
    };
}
/** 建目录，返回真正新建的那些（相对笔记本） */
function ensureDirs(cfg, rels) {
    const created = [];
    for (const rel of rels) {
        const abs = path.join(cfg.notebook, rel);
        if (!fs.existsSync(abs))
            created.push(rel);
        fs.mkdirSync(abs, { recursive: true });
    }
    return created;
}
/** 写模板，返回真正写入的那些；已存在的一律不覆盖（用户可能改过） */
function ensureTemplates(cfg, files) {
    const written = [];
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(cfg.notebook, '.zk', 'templates', name);
        if (fs.existsSync(file))
            continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        written.push(name);
    }
    return written;
}
/**
 * 写根目录 AGENTS.md（缺了才写，已存在一律不覆盖 —— 模板允许用户改）。
 * layered 用完整版；flat 用精简版（不出现 raw / inbox / archive / WORKFLOW 这些 flat 没有的路径）。
 * 返回 true = 本次真的写了。
 */
export function writeAgentsTemplate(cfg) {
    const file = path.join(cfg.notebook, 'AGENTS.md');
    if (fs.existsSync(file))
        return false;
    fs.writeFileSync(file, cfg.structure === 'layered' ? AGENTS_TEMPLATE : AGENTS_TEMPLATE_FLAT, 'utf8');
    return true;
}
/**
 * 写根目录契约模板（PERSONA.md / POLICY.md；缺了才写，已存在绝不覆盖 —— 契约允许人改）。
 * 只走显式 opt-in（zk-kit init --with-contract / 设置页按钮）：默认升级不多一个文件。
 *
 * 先 mkdir 再写：设置页的按钮在笔记本还没初始化时也可点（「先定角色、再建库」是合法顺序）。
 * 这里只建目录与两份契约，不碰 .zk / 模板 / 笔记；之后 ensureNotebook 幂等接管同一目录。
 */
export function writeContractTemplates(cfg) {
    const persona = path.join(cfg.notebook, 'PERSONA.md');
    const policy = path.join(cfg.notebook, 'POLICY.md');
    const personaWritten = !fs.existsSync(persona);
    const policyWritten = !fs.existsSync(policy);
    if (personaWritten || policyWritten)
        fs.mkdirSync(cfg.notebook, { recursive: true });
    if (personaWritten)
        fs.writeFileSync(persona, PERSONA_TEMPLATE, 'utf8');
    if (policyWritten)
        fs.writeFileSync(policy, POLICY_TEMPLATE, 'utf8');
    return { personaWritten, policyWritten };
}
/** 建好（或补好）笔记本；返回每一步各自做了没有，设置页直接展示 */
export async function ensureNotebook(cfg, signal, opts = {}) {
    const layered = cfg.structure === 'layered';
    fs.mkdirSync(cfg.notebook, { recursive: true });
    const dirsCreated = ensureDirs(cfg, structureDirs(cfg));
    const configFile = path.join(cfg.notebook, '.zk', 'config.toml');
    let initialized = false;
    if (!fs.existsSync(configFile)) {
        await zk(cfg, ['init', cfg.notebook], { signal, timeoutMs: 120_000 });
        initialized = true;
    }
    const templatesWritten = layered
        ? ensureTemplates(cfg, {
            'daily.md': DAILY_TEMPLATE_LAYERED,
            'source.md': SOURCE_TEMPLATE,
            'entry.md': ENTRY_TEMPLATE,
        })
        : ensureTemplates(cfg, { 'daily.md': DAILY_TEMPLATE });
    // AGENTS.md 是工作契约（检索词归宿 / 中文打 tags / 不会被宿主自动加载）。
    // layered 自动写；flat 只有显式 withAgents 才写 —— 0.1.0 的 vault 升级过来必须一个文件都不多（M0）。
    // 不写的话，默认安装既没有约定、也没有周节奏提醒（P1-6），所以要有一个 opt-in 入口。
    const agentsWritten = layered || opts.withAgents === true ? writeAgentsTemplate(cfg) : false;
    // 契约层（角色 / 自主权）只走显式 opt-in：两种结构都不自动多两个文件（D10）。
    const contractWritten = opts.withContract === true
        ? writeContractTemplates(cfg)
        : { personaWritten: false, policyWritten: false };
    // WORKFLOW.md 是「动已有笔记」时才读的细则：不注入（省预算），但不进检索（是 meta）
    const workflowFile = path.join(cfg.notebook, 'WORKFLOW.md');
    let workflowWritten = false;
    if (layered && !fs.existsSync(workflowFile)) {
        fs.writeFileSync(workflowFile, WORKFLOW_TEMPLATE, 'utf8');
        workflowWritten = true;
    }
    const groups = expectedGroups(cfg);
    let configText = fs.readFileSync(configFile, 'utf8');
    const blocks = parseGroupBlocks(configText);
    const groupsAdded = [];
    const groupWarnings = [];
    for (const group of groups) {
        const block = blocks.get(group.name);
        if (block) {
            // 已有 group 一律不重写（用户可能改过 template / extra），只报告与配置的差异
            if (block.duplicate) {
                groupWarnings.push(`group "${group.name}" 重复出现，解析不了 —— 手动检查 .zk/config.toml`);
            }
            else if (!samePaths(effectivePaths(block), group.paths)) {
                groupWarnings.push(`group "${group.name}" ${pathsDiff(group.paths, effectivePaths(block))}`);
            }
            continue;
        }
        // 新 group 的路径已经被别的 group 占着（典型：只改 dailyGroup 不改 dailyDir；缺 paths 的按同名目录也算）：
        // 再追加就是两个 group 用同一条路径，zk 命中哪个模板就只剩实现细节了 —— 只报告，不写
        const owner = [...blocks.values()].find((candidate) => effectivePaths(candidate)?.some((actual) => group.paths.some((expected) => sameGroupPath(actual, expected))));
        if (owner) {
            groupWarnings.push(`group "${group.name}" 没追加：路径 ${group.paths.join('、')} 已被 group "${owner.name}" 占用` +
                '（跑 zk-kit groups --fix）');
            continue;
        }
        const prefix = configText.endsWith('\n') ? '' : '\n';
        configText += prefix + groupSection(group);
        fs.writeFileSync(configFile, configText, 'utf8');
        groupsAdded.push(group.name);
        blocks.set(group.name, {
            name: group.name,
            paths: group.paths.map(normGroupPath),
            pathsState: 'set',
            template: group.template,
            comment: `# ${group.comment}`,
            header: `[group."${group.name}"]`,
            duplicate: false,
        });
    }
    return {
        notebook: cfg.notebook,
        initialized,
        configPatched: groupsAdded.length > 0,
        templateWritten: templatesWritten.length > 0,
        dirsCreated,
        templatesWritten,
        groupsAdded,
        groupWarnings,
        agentsWritten,
        workflowWritten,
        personaWritten: contractWritten.personaWritten,
        policyWritten: contractWritten.policyWritten,
    };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 只改组头名字（连同 .note / .extra 子表；裸键 / 引号写法都认），其它行一字不动 */
function renameGroup(text, from, to) {
    const esc = escapeRe(from);
    const re = new RegExp(`(\\[group\\.)(?:"${esc}"|'${esc}'|${esc}(?=[.\\]]))`, 'g');
    return text.replace(re, `$1"${to}"`);
}
/** 只替换 base group 的 paths 行；多行数组 / 找不到都不猜（返回 null） */
function replacePaths(text, name, paths) {
    const lines = text.split('\n');
    const headerRe = /^\s*\[group\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.(note|extra))?\]\s*(?:#.*)?$/;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const m = headerRe.exec(lines[i]);
        if (!m || m[4])
            continue;
        if ((m[1] ?? m[2] ?? m[3]) === name) {
            start = i;
            break;
        }
    }
    if (start < 0)
        return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*\[/.test(lines[i])) {
            end = i;
            break;
        }
    }
    const value = `[${paths.map((p) => JSON.stringify(p)).join(', ')}]`;
    for (let i = start + 1; i < end; i++) {
        const m = /^(\s*paths\s*=\s*)(\[[^\]]*\])(\s*(?:#.*)?)$/.exec(lines[i]);
        if (m) {
            lines[i] = m[1] + value + m[3];
            return lines.join('\n');
        }
        if (/^\s*paths\s*=/.test(lines[i]))
            return null; // 多行数组：不在本轮猜着改
    }
    lines.splice(start + 1, 0, `paths = ${value}`);
    return lines.join('\n');
}
/**
 * 显式修复 group 配置（`zk-kit groups --fix`）：
 *   · 只改 dsh-zdiary-kit 自己写的 group（组头前有 `dsh-zdiary-kit` 注释）；
 *   · 只改 `paths` 行，或把同路径的旧组头改名（dailyGroup 变更）；
 *   · 写下去会让两个 group 用同一条路径时一律不写（父子目录不算）：
 *     期望路径自己就冲突时整轮不改，期望路径被别的 group 占着时只跳过那一个；
 *   · 用户自定义的 template / extra / 注释 / 顺序一律不动；
 *   · 写前备份 `.zk/config.toml.bak`，写临时文件后 rename。
 */
export function fixGroupConfig(cfg) {
    const file = path.join(cfg.notebook, '.zk', 'config.toml');
    if (!fs.existsSync(file)) {
        throw new ZkError('还没有 .zk/config.toml —— 先跑 zk-kit init');
    }
    const original = fs.readFileSync(file, 'utf8');
    let text = original;
    const updates = [];
    const warnings = [];
    const groups = expectedGroups(cfg);
    const expectedNames = new Set(groups.map((group) => group.name));
    // 期望路径自己就撞了（典型：dailyDir 与某个 group 的路径一样）：一个都不写。
    // 写下去就是两个 group 用同一条路径，zk 命中哪个模板就只剩实现细节了 —— 这比「没改」更难查。
    const expectedOverlaps = overlapsOf(groups);
    if (expectedOverlaps.length > 0) {
        for (const note of groupOverlapNotes({ expectedOverlaps, actualOverlaps: [] }))
            warnings.push(note.text);
        const involved = new Set(expectedOverlaps.flatMap((overlap) => [overlap.a, overlap.b]));
        for (const group of groups) {
            if (!involved.has(group.name))
                continue;
            updates.push({
                name: group.name,
                action: 'skip',
                expectedPaths: group.paths,
                reason: '配置里有两个 group 要用同一条路径，先改 dailyDir / notesDir 或换结构',
            });
        }
        return { notebook: cfg.notebook, changed: false, backup: null, updates, warnings };
    }
    // 1. 缺失的 group：先认领同路径的旧 plugin group（改组头名），再看路径是否被占
    for (const group of groups) {
        const blocks = parseGroupBlocks(text);
        if (blocks.has(group.name))
            continue;
        const stale = [...blocks.values()].filter((block) => isPluginOwned(block) && !expectedNames.has(block.name));
        const same = stale.find((block) => samePaths(effectivePaths(block), group.paths));
        if (same) {
            text = renameGroup(text, same.name, group.name);
            updates.push({
                name: group.name,
                action: 'rename',
                from: same.name,
                expectedPaths: group.paths,
                actualPaths: effectivePaths(same),
            });
            continue;
        }
        // dailyGroup 改名 + dailyDir 同时改：认不出旧组，也不冒险追加第二个日记组
        const staleDaily = group.template === 'daily.md' ? stale.find((block) => block.template === 'daily.md') : undefined;
        if (staleDaily) {
            const reason = `旧日记 group "${staleDaily.name}" 的路径是 ${effectivePaths(staleDaily)?.join('、') ?? '解析不了'}，` +
                `与期望 ${group.paths.join('、')} 不一致 —— 先手动确认改名与路径`;
            warnings.push(reason);
            updates.push({ name: group.name, action: 'skip', expectedPaths: group.paths, reason });
            continue;
        }
        const owner = [...blocks.values()].find((block) => effectivePaths(block)?.some((actual) => group.paths.some((expected) => sameGroupPath(actual, expected))));
        if (owner) {
            const reason = `路径 ${group.paths.join('、')} 已被 group "${owner.name}" 占用 —— 先手动处理这个 group`;
            warnings.push(`group "${group.name}" 没追加：${reason}`);
            updates.push({ name: group.name, action: 'skip', expectedPaths: group.paths, reason });
            continue;
        }
        const prefix = text.endsWith('\n') ? '' : '\n';
        text += prefix + groupSection(group);
        updates.push({ name: group.name, action: 'append', expectedPaths: group.paths });
    }
    // 2. 已存在的 group：只改 plugin-owned 的 paths 行
    for (const group of groups) {
        const current = parseGroupBlocks(text);
        const block = current.get(group.name);
        if (!block)
            continue;
        if (block.duplicate) {
            const reason = `group "${group.name}" 重复出现，解析不了 —— 手动检查 .zk/config.toml`;
            warnings.push(reason);
            updates.push({ name: group.name, action: 'skip', expectedPaths: group.paths, reason });
            continue;
        }
        const actual = effectivePaths(block);
        if (samePaths(actual, group.paths))
            continue;
        if (!isPluginOwned(block)) {
            const reason = `不是插件建的 group，paths 未改（期望 ${group.paths.join('、')}，实际 ${actual?.join('、') ?? '解析不了'}）`;
            warnings.push(`group "${group.name}"：${reason}`);
            updates.push({ name: group.name, action: 'skip', expectedPaths: group.paths, actualPaths: actual, reason });
            continue;
        }
        // 期望路径被别的 group 占着：不替换 —— 之前只拦了「追加」，替换同样会造出两个 group 用同一条路径。
        // 期望内部的 group 会自己走到期望路径，不算占用；用户建的 / 上一版留下的 group 才拦。
        const rival = [...current.values()].find((candidate) => candidate.name !== group.name &&
            !(expectedNames.has(candidate.name) && isPluginOwned(candidate)) &&
            effectivePaths(candidate)?.some((p) => group.paths.some((expected) => sameGroupPath(p, expected))));
        if (rival) {
            const reason = `路径 ${group.paths.join('、')} 已被 group "${rival.name}" 占用（${effectivePaths(rival)?.join('、') ?? '解析不了'}），paths 未改 —— 先手动处理这个 group`;
            warnings.push(`group "${group.name}"：${reason}`);
            updates.push({ name: group.name, action: 'skip', expectedPaths: group.paths, actualPaths: actual, reason });
            continue;
        }
        const next = replacePaths(text, group.name, group.paths);
        if (next === null) {
            const reason = 'paths 行解析不了（可能是多行数组），未改 —— 手动编辑 .zk/config.toml';
            warnings.push(`group "${group.name}"：${reason}`);
            updates.push({ name: group.name, action: 'skip', expectedPaths: group.paths, actualPaths: actual, reason });
            continue;
        }
        text = next;
        updates.push({
            name: group.name,
            action: 'paths',
            expectedPaths: group.paths,
            actualPaths: actual,
        });
    }
    if (text === original)
        return { notebook: cfg.notebook, changed: false, backup: null, updates, warnings };
    const backup = `${file}.bak`;
    fs.copyFileSync(file, backup);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { notebook: cfg.notebook, changed: true, backup, updates, warnings };
}
