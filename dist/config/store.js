/**
 * 配置：默认值 + 白名单 + 归一化（宿主、设置页、CLI 三处共用这一份）。
 *
 * 只有一个配置文件：~/.dsh/zdiary/zdiary.config.json。
 * 设置页通过 keys 白名单合并 —— 加字段只改这里，不存在第二处。
 *
 * 多笔记本：`notebooks` 是「名字 → 路径」，`active` 是当前那个的名字；
 * `notebook` 是**派生的**（= notebooks[active] 解析后的绝对路径），只在内存里，不落盘 ——
 * 磁盘上笔记本只有一个真相，就是 notebooks + active。
 * 老配置只有 `notebook`：读进来自动当成 `notebooks.default` 的路径（迁移见 normalizeConfig）。
 */
import { CFG_FILE, DEFAULT_NOTEBOOK, expandHome, resolveInWorkspace } from './paths.js';
import { readJson, writeJson } from '../lib/json-file.js';
/** 默认笔记本的名字（老配置迁移过来的那个也叫这个） */
export const DEFAULT_NOTEBOOK_NAME = 'default';
/** 笔记本名：只接受文件名友好的字符，1-32 个 */
const NOTEBOOK_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** 上限 50 个：再多就是填错了，别让配置无限长 */
const MAX_NOTEBOOKS = 50;
/** 名字合法吗（add / use 前先问，别让非法键进 JSON） */
export function isNotebookName(name) {
    return NOTEBOOK_NAME_RE.test(String(name ?? '').trim());
}
export const DEFAULTS = {
    notebook: DEFAULT_NOTEBOOK,
    notebooks: { [DEFAULT_NOTEBOOK_NAME]: '' },
    active: DEFAULT_NOTEBOOK_NAME,
    notesDir: 'notes',
    dailyDir: 'journal',
    dailyGroup: 'daily',
    defaultTags: [],
    maxReadChars: 20_000,
    memoryBudgetWords: 300,
    structure: 'flat',
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
/** 名字 → 路径；非法名字与非法值直接丢掉（不 throw） */
function notebookMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return out;
    for (const [key, value] of Object.entries(raw)) {
        const name = String(key ?? '').trim();
        if (!NOTEBOOK_NAME_RE.test(name))
            continue;
        out[name] = String(value ?? '').trim();
        if (Object.keys(out).length >= MAX_NOTEBOOKS)
            break;
    }
    return out;
}
/** 笔记本路径：空 = 工作区里的默认位置；相对路径按工作区解析（不是进程 cwd） */
function notebookPath(raw) {
    const s = String(raw ?? '').trim();
    return s ? resolveInWorkspace(expandHome(s)) : DEFAULT_NOTEBOOK;
}
/** 任意输入 → 合法 Config（永不 throw：设置页传垃圾也只落一个安全值） */
export function normalizeConfig(raw) {
    const src = (raw && typeof raw === 'object' ? raw : {});
    const notebooksRaw = notebookMap(src.notebooks);
    const legacy = String(src.notebook ?? '').trim();
    // 老配置（只有 notebook）→ 那就是 default 的路径；全新配置 → default 留空，走「工作区内」的默认
    const map = Object.keys(notebooksRaw).length > 0
        ? notebooksRaw
        : { [DEFAULT_NOTEBOOK_NAME]: legacy };
    const activeRaw = String(src.active ?? '').trim();
    const active = activeRaw && NOTEBOOK_NAME_RE.test(activeRaw) && activeRaw in map
        ? activeRaw
        : DEFAULT_NOTEBOOK_NAME in map ? DEFAULT_NOTEBOOK_NAME : (Object.keys(map)[0] ?? DEFAULT_NOTEBOOK_NAME);
    // `notebook` 是老式单笔记本字段：给了就以它为准，改的是**当前**笔记本的路径
    const notebookRaw = String(src.notebook ?? '').trim();
    const notebooks = notebookRaw && notebookPath(notebookRaw) !== notebookPath(map[active])
        ? { ...map, [active]: notebookRaw }
        : map;
    const notebook = notebookPath(notebooks[active] ?? '');
    const version = String(src.zkVersion ?? '').trim().replace(/^v/i, '');
    const zkPathRaw = String(src.zkPath ?? '').trim();
    return {
        notebook,
        notebooks,
        active,
        notesDir: relativeDir(src.notesDir, DEFAULTS.notesDir),
        dailyDir: relativeDir(src.dailyDir, DEFAULTS.dailyDir),
        dailyGroup: /^[A-Za-z0-9_-]{1,32}$/.test(String(src.dailyGroup ?? '')) ? String(src.dailyGroup) : DEFAULTS.dailyGroup,
        defaultTags: tags(src.defaultTags),
        maxReadChars: clamp(Number(src.maxReadChars), 1000, 200_000, DEFAULTS.maxReadChars),
        memoryBudgetWords: clamp(Number(src.memoryBudgetWords), 50, 2000, DEFAULTS.memoryBudgetWords),
        structure: src.structure === 'layered' ? 'layered' : 'flat',
        archiveDir: relativeDir(src.archiveDir, DEFAULTS.archiveDir),
        zkVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : DEFAULTS.zkVersion,
        zkPath: zkPathRaw ? resolveInWorkspace(expandHome(zkPathRaw)) : '',
    };
}
/** 落盘用：去掉派生的 notebook（磁盘上只有 notebooks + active 这一个真相） */
function toDisk(cfg) {
    const out = { ...cfg };
    delete out.notebook;
    return out;
}
/** 读配置（每次现读：设置页保存后工具下一句就看到新值，没有缓存要失效） */
export function config() {
    const raw = readJson(CFG_FILE, {});
    const next = normalizeConfig(raw);
    // 0.1.x 的配置没有 structure / archiveDir，0.2.x 的没有 notebooks / active：显式落盘默认值。
    // 这样以后翻默认值时，老 vault 的配置里已经有确定值，不会被顺手改掉（计划 §8）。
    if (Object.keys(raw).length > 0 && (!('structure' in raw) || !('notebooks' in raw))) {
        try {
            writeJson(CFG_FILE, toDisk(next));
        }
        catch { /* 只读环境：下次再补 */ }
    }
    return next;
}
/**
 * 切到某个笔记本（只看不改：不动磁盘、不改配置）。
 * 名字不在 notebooks 里就按空路径算（= 工作区默认位置），调用方自己先校验。
 */
export function selectNotebook(cfg, name) {
    const notebooks = { ...cfg.notebooks };
    if (!(name in notebooks))
        notebooks[name] = '';
    return normalizeConfig({ ...toDisk(cfg), notebooks, active: name });
}
/** 合并写入（只写白名单键），返回归一化后的完整配置 */
export function writeConfig(patch) {
    const current = config();
    const merged = { ...toDisk(current) };
    for (const [k, v] of Object.entries(patch)) {
        if (CONFIG_KEYS.includes(k))
            merged[k] = v;
    }
    // notebooks 是**整体替换**：删掉某个笔记本就是传回不含它的完整 map（局部合并删不掉东西）
    const hasNotebooks = 'notebooks' in patch;
    const notebooks = hasNotebooks ? notebookMap(patch.notebooks) : { ...current.notebooks };
    const activeRaw = String(merged.active ?? current.active ?? '').trim();
    const active = NOTEBOOK_NAME_RE.test(activeRaw) ? activeRaw : current.active;
    // notebook 是派生的：只写它 = 改当前笔记本的路径（`config set notebook=…`、老客户端）。
    // 同时给了 notebooks 就以 notebooks 为准 —— 设置页整份发回来时那个 notebook 是上一次的旧值，听它的会把刚改的路径改回去。
    if ('notebook' in patch && !hasNotebooks)
        notebooks[active] = String(patch.notebook ?? '').trim();
    delete merged.notebook;
    const next = normalizeConfig({ ...merged, notebooks, active });
    writeJson(CFG_FILE, toDisk(next));
    return next;
}
