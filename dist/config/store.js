/**
 * 配置：默认值 + 白名单 + 归一化（宿主、设置页、CLI 三处共用这一份）。
 *
 * 只有一个配置文件：~/.dsh/zdiary/zdiary.config.json。
 * 设置页通过 keys 白名单合并 —— 加字段只改这里，不存在第二处。
 */
import path from 'node:path';
import { CFG_FILE, DEFAULT_NOTEBOOK, expandHome } from './paths.js';
import { readJson, writeJson } from '../lib/json-file.js';
export const DEFAULTS = {
    notebook: DEFAULT_NOTEBOOK,
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
/** 任意输入 → 合法 Config（永不 throw：设置页传垃圾也只落一个安全值） */
export function normalizeConfig(raw) {
    const src = (raw && typeof raw === 'object' ? raw : {});
    const notebookRaw = String(src.notebook ?? '').trim();
    const notebook = notebookRaw ? path.resolve(expandHome(notebookRaw)) : DEFAULTS.notebook;
    const version = String(src.zkVersion ?? '').trim().replace(/^v/i, '');
    const zkPathRaw = String(src.zkPath ?? '').trim();
    return {
        notebook,
        notesDir: relativeDir(src.notesDir, DEFAULTS.notesDir),
        dailyDir: relativeDir(src.dailyDir, DEFAULTS.dailyDir),
        dailyGroup: /^[A-Za-z0-9_-]{1,32}$/.test(String(src.dailyGroup ?? '')) ? String(src.dailyGroup) : DEFAULTS.dailyGroup,
        defaultTags: tags(src.defaultTags),
        maxReadChars: clamp(Number(src.maxReadChars), 1000, 200_000, DEFAULTS.maxReadChars),
        memoryBudgetWords: clamp(Number(src.memoryBudgetWords), 50, 2000, DEFAULTS.memoryBudgetWords),
        structure: src.structure === 'layered' ? 'layered' : 'flat',
        archiveDir: relativeDir(src.archiveDir, DEFAULTS.archiveDir),
        zkVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : DEFAULTS.zkVersion,
        zkPath: zkPathRaw ? path.resolve(expandHome(zkPathRaw)) : '',
    };
}
/** 读配置（每次现读：设置页保存后工具下一句就看到新值，没有缓存要失效） */
export function config() {
    const raw = readJson(CFG_FILE, {});
    const next = normalizeConfig(raw);
    // 0.1.x 的配置没有 structure / archiveDir：显式落盘默认值。
    // 这样 v0.3 翻默认结构时，老 vault 的配置里已经有确定值，不会被顺手改掉（计划 §8）。
    if (Object.keys(raw).length > 0 && !('structure' in raw)) {
        try {
            writeJson(CFG_FILE, next);
        }
        catch { /* 只读环境：下次再补 */ }
    }
    return next;
}
/** 合并写入（只写白名单键），返回归一化后的完整配置 */
export function writeConfig(patch) {
    const current = { ...config() };
    for (const [k, v] of Object.entries(patch)) {
        if (CONFIG_KEYS.includes(k))
            current[k] = v;
    }
    const next = normalizeConfig(current);
    writeJson(CFG_FILE, next);
    return next;
}
