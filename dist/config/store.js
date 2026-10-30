/**
 * 配置：默认值 + 白名单 + 归一化（宿主、设置页、CLI 三处共用这一份）。
 *
 * 只有一个配置文件：~/.dsh/zdiary/zdiary.config.json。
 * 设置页通过 keys 白名单合并 —— 加字段只改这里，不存在第二处。
 *
 * 多笔记本：`notebooks` 是「名字 → {path, structure}」，`active` 是当前那个的名字。
 * 路径与结构都是**笔记本自己的属性**，跟着条目落盘；派生值只有两个，都不落盘、都不可写：
 *   · `notebook` = notebooks[active].path 解析后的绝对路径；
 *   · `structure` = notebooks[active].structure（当前笔记本的结构模式）。
 * 磁盘上笔记本只有一个真相，就是 notebooks + active —— 没有第二个能盖过它的键。
 * 老配置只有 `notebook`（或 structure 是全局键）：读进来一次性迁进 `notebooks.default`，
 * 之后就不再有双向合并 —— notebooks 存在时，散落的 `notebook` 顶层键只当没看见。
 */
import { CFG_FILE, defaultNotebook, expandHome, processWorkspace, resolveInWorkspace } from './paths.js';
import { fileStamp } from '../lib/file-stamp.js';
import { readJson, writeJson } from '../lib/json-file.js';
/** 默认笔记本的名字（老配置迁移过来的那个也叫这个） */
export const DEFAULT_NOTEBOOK_NAME = 'default';
/** 笔记本名：只接受文件名友好的字符，1-32 个 */
const NOTEBOOK_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** 上限 50 个：再多就是填错了，别让配置无限长 */
const MAX_NOTEBOOKS = 50;
/** 落盘与 patch 里的派生键：notebook 纯派生、structure 有专门语义、notebooks 整体替换 —— 都不走通用合并 */
const DERIVED_KEYS = new Set(['notebook', 'structure', 'notebooks']);
/** 名字合法吗（add / use 前先问，别让非法键进 JSON） */
export function isNotebookName(name) {
    return NOTEBOOK_NAME_RE.test(String(name ?? '').trim());
}
export const DEFAULTS = {
    // 两个派生值：normalizeConfig 算出来，这里只是占位（不参与落盘，也不单独使用）
    notebook: '',
    notebooks: { [DEFAULT_NOTEBOOK_NAME]: { path: '', structure: 'flat' } },
    active: DEFAULT_NOTEBOOK_NAME,
    structure: 'flat',
    notesDir: 'notes',
    dailyDir: 'journal',
    dailyGroup: 'daily',
    defaultTags: [],
    maxReadChars: 20_000,
    memoryBudgetWords: 500,
    archiveDir: 'archive',
    zkVersion: '0.15.7',
    zkPath: '',
};
export const CONFIG_KEYS = Object.keys(DEFAULTS);
const clamp = (n, min, max, fallback) => Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
/** 子目录只接受相对路径（防止 `/` 或 `../` 把笔记写到笔记本外面） */
function relativeDir(raw, fallback) {
    const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!s)
        return fallback;
    const parts = s.split('/').filter((p) => p && p !== '.' && p !== '..');
    return parts.length ? parts.join('/') : fallback;
}
function tags(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/);
    const out = [];
    for (const item of list) {
        const t = String(item ?? '').trim().replace(/^#+/, '');
        if (!t || /[\s#]/.test(t))
            continue;
        if (!out.includes(t))
            out.push(t);
        if (out.length >= 20)
            break;
    }
    return out;
}
/** 结构值：只认 flat / layered，其它一律退回 fallback（structure=xyz → flat，回显里会点名） */
function structureOf(raw, fallback) {
    return raw === 'layered' ? 'layered' : raw === 'flat' ? 'flat' : fallback;
}
/** 一条笔记本记录：新写法 {path, structure}，老写法裸路径字符串也认（structure 继承 fallback） */
function entryOf(value, fallback) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const v = value;
        return { path: String(v.path ?? '').trim(), structure: structureOf(v.structure, fallback) };
    }
    return { path: String(value ?? '').trim(), structure: fallback };
}
/**
 * 名字 → 记录；非法名字与非法值直接丢掉（不 throw）。
 * 条目没写 structure 时沿用同名旧记录的，再退 base —— 整体替换时不悄悄改别人的结构。
 */
function notebookEntries(raw, prev, base) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return out;
    for (const [key, value] of Object.entries(raw)) {
        const name = String(key ?? '').trim();
        if (!NOTEBOOK_NAME_RE.test(name))
            continue;
        out[name] = entryOf(value, prev[name]?.structure ?? base);
        if (Object.keys(out).length >= MAX_NOTEBOOKS)
            break;
    }
    return out;
}
/** 笔记本路径：空 = 工作区里的默认位置；相对路径按工作区解析（不是进程 cwd） */
function notebookPath(raw, workspace) {
    const s = String(raw ?? '').trim();
    return s ? resolveInWorkspace(expandHome(s), workspace) : defaultNotebook(workspace);
}
/**
 * 任意输入 → 合法 Config（永不 throw：设置页传垃圾也只落一个安全值）。
 *
 * workspace 决定「空路径 / 相对路径」落在哪：工具调用传会话 cwd，其余场景默认进程工作区。
 * 显式写死的绝对路径不受它影响 —— 显式配置优先。
 */
export function normalizeConfig(raw, workspace = processWorkspace()) {
    const src = (raw && typeof raw === 'object' ? raw : {});
    // 老配置里的全局 structure：只当「条目缺省」的 fallback 用；条目自己的 structure 优先
    const base = structureOf(src.structure, 'flat');
    let notebooks = notebookEntries(src.notebooks, {}, base);
    // 老配置只有 notebook：读进来就是 notebooks.default 的路径（一次性迁移）。
    // notebooks 已存在时顶层 notebook 是历史残留 —— 一个字都不听它（磁盘上笔记本只有一个真相）。
    if (Object.keys(notebooks).length === 0) {
        notebooks = { [DEFAULT_NOTEBOOK_NAME]: entryOf(String(src.notebook ?? ''), base) };
    }
    const activeRaw = String(src.active ?? '').trim();
    const active = activeRaw && NOTEBOOK_NAME_RE.test(activeRaw) && activeRaw in notebooks
        ? activeRaw
        : DEFAULT_NOTEBOOK_NAME in notebooks ? DEFAULT_NOTEBOOK_NAME : (Object.keys(notebooks)[0] ?? DEFAULT_NOTEBOOK_NAME);
    const entry = notebooks[active] ?? { path: '', structure: 'flat' };
    return {
        notebook: notebookPath(entry.path, workspace),
        notebooks,
        active,
        structure: entry.structure,
        notesDir: relativeDir(src.notesDir, DEFAULTS.notesDir),
        dailyDir: relativeDir(src.dailyDir, DEFAULTS.dailyDir),
        dailyGroup: /^[A-Za-z0-9_-]{1,32}$/.test(String(src.dailyGroup ?? '')) ? String(src.dailyGroup) : DEFAULTS.dailyGroup,
        defaultTags: tags(src.defaultTags),
        maxReadChars: clamp(Number(src.maxReadChars), 1000, 200_000, DEFAULTS.maxReadChars),
        memoryBudgetWords: clamp(Number(src.memoryBudgetWords), 50, 2000, DEFAULTS.memoryBudgetWords),
        archiveDir: relativeDir(src.archiveDir, DEFAULTS.archiveDir),
        zkVersion: /^\d+\.\d+\.\d+$/.test(String(src.zkVersion ?? '').trim().replace(/^v/i, ''))
            ? String(src.zkVersion).trim().replace(/^v/i, '')
            : DEFAULTS.zkVersion,
        // zk 可执行文件是整台机器共享的，不跟着会话工作区漂 —— 相对路径按进程工作区解析
        zkPath: String(src.zkPath ?? '').trim()
            ? resolveInWorkspace(expandHome(String(src.zkPath).trim()), processWorkspace())
            : '',
    };
}
/** 落盘用：去掉派生的 notebook / structure（磁盘上只有 notebooks + active 这一个真相） */
function toDisk(cfg) {
    const out = { ...cfg };
    delete out.notebook;
    delete out.structure;
    return out;
}
/**
 * 配置读缓存：宿主每个 step 都会求值一次记忆注入，没有这层就是每步 readFileSync + JSON.parse。
 * 失效靠文件指纹（mtime/size/ino），不是超时 —— 手改配置、设置页保存、写回迁移都能立刻生效。
 * 带上 workspace：同一份配置在不同工作区解析出的笔记本绝对路径不同。
 */
let configCache = null;
/**
 * 读配置（每次现读，除非文件没变：设置页保存后工具下一句就看到新值）。
 * workspace 只在解析「空 / 相对」笔记本路径时用到：工具传会话 cwd，其余场景用进程工作区。
 */
export function config(workspace = processWorkspace()) {
    const stamp = fileStamp(CFG_FILE);
    if (configCache && configCache.stamp === stamp && configCache.workspace === workspace) {
        return configCache.value;
    }
    const raw = readJson(CFG_FILE, {});
    const next = normalizeConfig(raw, workspace);
    // 一次性迁移：老形状（没有 notebooks / 顶层还留着 notebook 或 structure / 条目还是裸字符串）
    // 读进来就写回新形状。这样以后翻默认值时，老 vault 的配置里已经有确定值（计划 §8）。
    const legacy = !('notebooks' in raw)
        || ('structure' in raw)
        || ('notebook' in raw)
        || Object.values((raw.notebooks ?? {})).some((v) => typeof v === 'string');
    let writable = true;
    if (Object.keys(raw).length > 0 && legacy) {
        try {
            writeJson(CFG_FILE, toDisk(next));
        }
        catch {
            writable = false; /* 只读环境：下次再补 */
        }
    }
    // 写回失败就不缓存：下次还得再试一次迁移（改了权限要能自愈）
    configCache = writable ? { stamp: fileStamp(CFG_FILE), workspace, value: next } : null;
    return next;
}
/**
 * 切到某个笔记本（只看不改：不动磁盘、不改配置）。
 * 名字不在 notebooks 里就按空路径算（= 工作区默认位置），调用方自己先校验。
 */
export function selectNotebook(cfg, name, workspace = processWorkspace()) {
    const notebooks = { ...cfg.notebooks };
    if (!(name in notebooks))
        notebooks[name] = { path: '', structure: cfg.structure };
    return normalizeConfig({ ...toDisk(cfg), notebooks, active: name }, workspace);
}
/**
 * 合并写入（只写白名单键），返回归一化后的完整配置。
 *
 * 三个派生键各有专门语义，不走通用合并：
 *   · `notebooks`：**整体替换**（删掉某个笔记本就是传回不含它的完整 map）。
 *     同时给了别的派生键也以它为准 —— 设置页整份发回来时那些是上一次的旧值。
 *   · `structure`：只在没给 notebooks 时生效，改的是**当前笔记本**的结构。
 *   · `notebook`：纯派生，patch 里出现直接忽略（改路径用 notebooks；CLI 会拦下并提示）。
 */
export function writeConfig(patch, workspace = processWorkspace()) {
    const current = config(workspace);
    const merged = { ...toDisk(current) };
    for (const [k, v] of Object.entries(patch)) {
        if (DERIVED_KEYS.has(k))
            continue;
        if (CONFIG_KEYS.includes(k))
            merged[k] = v;
    }
    // 不是对象就当没给（垃圾输入不许把整个笔记本表清空）
    const hasNotebooks = !!patch.notebooks && typeof patch.notebooks === 'object' && !Array.isArray(patch.notebooks);
    const activeRaw = String(merged.active ?? current.active ?? '').trim();
    const active = NOTEBOOK_NAME_RE.test(activeRaw) ? activeRaw : current.active;
    const notebooks = hasNotebooks
        ? notebookEntries(patch.notebooks, current.notebooks, 'flat')
        : { ...current.notebooks };
    if (!hasNotebooks && 'structure' in patch) {
        const entry = notebooks[active] ?? { path: '', structure: 'flat' };
        notebooks[active] = { ...entry, structure: structureOf(patch.structure, 'flat') };
    }
    const next = normalizeConfig({ ...merged, notebooks, active }, workspace);
    writeJson(CFG_FILE, toDisk(next));
    configCache = null;
    return next;
}
