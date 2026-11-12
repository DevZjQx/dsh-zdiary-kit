/**
 * zk 的全部命令行交互都收在这里（lib 层，feature 只调函数、不拼参数）。
 *
 * 约定：
 *   · 永远带 `--notebook-dir <notebook> --no-input` —— 不依赖 cwd、不会弹交互；
 *   · 读笔记走 `zk list --format json`（zk 自己的解析结果，别去猜 frontmatter）；
 *   · 写笔记走 `zk new`（文件名、模板、索引都交给 zk），正文经 stdin 进 `{{content}}`；
 *   · 所有路径参数先过 absPathOf：绝不读写笔记本外面的文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BIN_DIR } from '../config/paths.js';
import { ExecError, findOnPath, run } from './exec.js';
import { readJson, writeJson } from './json-file.js';
import { withFileLockSync } from './lock.js';
import { parseFrontmatter, setFrontmatter } from './frontmatter.js';
import { isMetaPath, META_NAMES } from './meta.js';
import { similarCandidates } from './similar.js';
import { linkContextOf } from './edge-context.js';
import { fenceMask } from './fence.js';
import { emptyTemplateSlots } from './sections.js';
import { normalizeTitle, noteKey } from './wikilink.js';
export class ZkError extends Error {
    hint;
    /**
     * 机器可判的类别（'not-found' / 'outside' / 'bad-path' …）。
     * 调用方要分状态码就读它，别去匹配中文文案 —— 文案一改，匹配就静默失效。
     */
    code;
    constructor(message, hint, code) {
        super(message);
        this.name = 'ZkError';
        this.hint = hint;
        this.code = code;
    }
}
const SORT_TERMS = {
    'created-desc': 'created-',
    'created-asc': 'created',
    'modified-desc': 'modified-',
    'title-asc': 'title',
};
/** ISO 时间 → 本地日期 YYYY-MM-DD（zk 给的是 UTC，别拿它当日历） */
export function localDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}
/** 废弃原因最多这么长：frontmatter 是给人看的审计线，不是自由文本容器 */
const MAX_SUPERSEDE_REASON = 200;
/** 一句话、单行；换行会弄坏 frontmatter，超长机械截断（不判断内容） */
function normalizeReason(input) {
    const one = String(input ?? '').replace(/\s+/g, ' ').trim();
    if (!one)
        return null;
    return one.length > MAX_SUPERSEDE_REASON ? one.slice(0, MAX_SUPERSEDE_REASON - 1) + '…' : one;
}
export function managedBin() {
    return path.join(BIN_DIR, process.platform === 'win32' ? 'zk.exe' : 'zk');
}
export function hasNotebook(cfg) {
    try {
        return fs.existsSync(path.join(cfg.notebook, '.zk', 'config.toml'));
    }
    catch {
        return false;
    }
}
/** `zk --version` → "0.15.7"；跑不起来 / 输出不对 → null */
export async function versionOf(bin) {
    try {
        const r = await run(bin, ['--version'], { timeoutMs: 10_000 });
        const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
        return m ? m[1] : null;
    }
    catch {
        return null;
    }
}
const located = new Map();
/** 找 zk：显式路径 → $ZK_BIN → PATH → 插件托管目录（都不跑 --version 之外的探测） */
export function resolveZk(cfg) {
    const key = [cfg.zkPath, process.env.ZK_BIN ?? '', managedBin()].join('|');
    const hit = located.get(key);
    if (hit)
        return hit;
    // 只缓存成功结果：装完 zk / 改完路径后，下一次调用必须立刻看得见（缓存 null 会让用户重启才生效）
    const probe = (async () => {
        const candidates = [];
        if (cfg.zkPath)
            candidates.push({ bin: cfg.zkPath, source: 'config' });
        if (process.env.ZK_BIN)
            candidates.push({ bin: process.env.ZK_BIN, source: 'env' });
        const onPath = findOnPath('zk');
        if (onPath)
            candidates.push({ bin: onPath, source: 'path' });
        const managed = managedBin();
        if (fs.existsSync(managed))
            candidates.push({ bin: managed, source: 'managed' });
        for (const c of candidates) {
            const version = await versionOf(c.bin);
            if (version)
                return { bin: c.bin, version, source: c.source };
        }
        return null;
    })();
    located.set(key, probe);
    probe.then((loc) => { if (!loc)
        located.delete(key); }, () => { located.delete(key); });
    return probe;
}
export async function requireZk(cfg) {
    const loc = await resolveZk(cfg);
    if (!loc) {
        throw new ZkError('找不到 zk 可执行文件', 'DSH 设置 → 知识库（zk）→「安装内置 zk」；或自己装一个（brew install zk / go install github.com/zk-org/zk@latest），再或者把路径填进设置页的「zk 路径」');
    }
    return loc;
}
function baseArgs(cfg) {
    return ['--notebook-dir', cfg.notebook, '--no-input'];
}
/** stderr 里的一行 warning（`zk: warning: ...`），exit 0 时也会出现 */
const WARNING_LINE = /^zk: warning: /;
/**
 * 索引策略。测试会改 `waitMs` / `lockWaitMs` / `autoBuildMaxNotes` 把等待压到毫秒级；
 * 生产路径一律用默认值（不要从配置里读 —— 这几个数是按 §0.5.1 的实测定的）。
 */
export const indexPolicy = {
    /** 建索引预算：10k / 3 链约 13 min（6.6 s + 26 ms × 链接数），留一倍余量 */
    buildTimeoutMs: 30 * 60_000,
    /** 冷建时最多阻塞工具调用多久；等不到就让调用先失败，后台继续建 */
    waitMs: 15_000,
    /**
     * 别的进程持锁时，读路径最多等多久（显式重建传 `waitMs`）。
     * 不能用 15 s：10k 库建库要几分钟，这期间的每次读都会白卡一轮。
     */
    lockWaitMs: 2_000,
    /** 这个规模以内让命令自己建：200 篇约 1 s，塞进长超时也不会卡住调用 */
    autoBuildMaxNotes: 200,
    /** 建索引连续失败时，这段时间内直接报错、不重启进程（避免 fork 风暴） */
    failureCooldownMs: 60_000,
};
const builds = new Map();
const buildFailures = new Map();
function indexPaths(cfg) {
    const db = path.join(cfg.notebook, '.zk', 'notebook.db');
    return { db, journal: db + '-journal', wal: db + '-wal' };
}
/** 只看磁盘、不打子进程：ready / missing / interrupted（半库） */
export function indexStateOf(cfg) {
    const { db, journal, wal } = indexPaths(cfg);
    if (!fs.existsSync(db))
        return 'missing';
    if (fs.existsSync(journal) || fs.existsSync(wal))
        return 'interrupted';
    return 'ready';
}
function indexStatePaths(cfg) {
    const base = path.join(cfg.notebook, '.zk');
    return { file: path.join(base, 'dsh-index-state.json'), lock: path.join(base, 'dsh-index-state.lock') };
}
function readIndexState(cfg) {
    const raw = readJson(indexStatePaths(cfg).file, {});
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    return { generation: num(raw?.generation), indexedGeneration: num(raw?.indexedGeneration) };
}
/** 读-改-写走同一把跨进程锁，否则与 markIndexed 并发时会丢掉一次写（dirty 被误清） */
function withIndexState(cfg, fn) {
    const { file, lock } = indexStatePaths(cfg);
    return withFileLockSync(lock, () => {
        const [next, value] = fn(readIndexState(cfg));
        writeJson(file, next);
        return value;
    });
}
/** 写盘之后标脏：绝不能因为标脏失败，让已经落盘的写入看起来失败了 */
export function markIndexDirty(cfg) {
    try {
        withIndexState(cfg, (s) => [{ ...s, generation: s.generation + 1 }, undefined]);
    }
    catch {
        const { file } = indexStatePaths(cfg);
        const s = readIndexState(cfg);
        try {
            writeJson(file, { ...s, generation: s.generation + 1 });
        }
        catch { /* 连状态文件都写不了就认了 */ }
    }
}
/** 建库成功：只清掉「这次建库开始前」的那些写入 */
function markIndexed(cfg, generation) {
    try {
        withIndexState(cfg, (s) => [
            { ...s, indexedGeneration: Math.max(s.indexedGeneration, generation) },
            undefined,
        ]);
    }
    catch { /* 清不掉就留着 dirty，下一次读者再补一次，不影响正确性 */ }
}
/** 给测试 / doctor 看当前差值；不暴露写接口 */
export function indexDirtyState(cfg) {
    return readIndexState(cfg);
}
/**
 * 「索引可能落后」的粗判（doctor / zk_lint 只提示，不自动重建）。
 *
 * 两条线索：
 *   1. 我们自己写盘留下的 dirty（generation > indexedGeneration）—— 准确；
 *   2. 外部在插件之外动文件：只看顶层条目的 mtime（10⁴ 篇不付 10⁴ 次 stat）。
 *      目录 mtime 只在**新增 / 删除 / 改名**时变；改已有文件的正文不会变 ——
 *      所以正文的外部修改**一定漏报**，不是「可能漏报」。注释与文案都不要把这点说小。
 */
export function indexLagHint(cfg) {
    if (!hasNotebook(cfg))
        return null;
    const { db } = indexPaths(cfg);
    let dbMtime;
    try {
        dbMtime = fs.statSync(db).mtimeMs;
    }
    catch {
        return '索引数据库不存在，下次检索会重建';
    }
    const s = readIndexState(cfg);
    if (s.generation > s.indexedGeneration) {
        return `还有 ${s.generation - s.indexedGeneration} 次写入没进索引（下次检索会自动补）`;
    }
    const metas = META_NAMES;
    let newest = 0;
    try {
        for (const entry of fs.readdirSync(cfg.notebook, { withFileTypes: true })) {
            if (entry.name === '.zk' || metas.includes(entry.name))
                continue;
            try {
                newest = Math.max(newest, fs.statSync(path.join(cfg.notebook, entry.name)).mtimeMs);
            }
            catch { /* 读不到就跳过 */ }
        }
    }
    catch {
        return null;
    }
    // 留 1 s 余量：同一秒里建完索引又写文件，不算「落后」
    return newest > dbMtime + 1000
        ? '笔记本顶层有新增 / 删除 / 改名，或索引落后于库（外部直接改正文不会被发现）；到设置页点「重建索引」'
        : null;
}
/** 估算篇数：只为了报「首次要扫 N 篇」，不追求精确，封顶 2 万（大库不必数完） */
function approxNoteCount(cfg, cap = 20_000) {
    let count = 0;
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (count >= cap)
                return;
            if (entry.name.startsWith('.'))
                continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory())
                walk(abs);
            else if (entry.isFile() && entry.name.endsWith('.md'))
                count += 1;
        }
    };
    walk(cfg.notebook);
    return count;
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        const onAbort = () => { cleanup(); reject(new Error('aborted')); };
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function indexFailureText(err) {
    if (err instanceof ExecError) {
        if (err.killed)
            return `超时（${Math.round(indexPolicy.buildTimeoutMs / 60_000)} 分钟内没建完）`;
        const lines = err.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' / ');
        return (lines || err.message).slice(0, 300);
    }
    return String(err).slice(0, 300);
}
const INDEX_HINT = '到设置页点「重建索引」，或在这个笔记本里跑 zk index 看完整输出';
/** 锁文件刚建好、token 还没写完的宽限期：这段窗口里读不出 JSON 不能当 stale */
const LOCK_WRITE_GRACE_MS = 5_000;
function buildLockPath(cfg) {
    return path.join(cfg.notebook, '.zk', 'dsh-index.lock');
}
/**
 * 跨进程 single-flight（R6）：O_EXCL 建锁，持锁者跑完整条 `zk index`。
 * 进程内已有 builds Map；这一把锁管的是「插件进程 A 与 CLI 进程 B 同时看到 dirty」。
 * 残留锁按「pid 还活着吗 / 是否超过建库预算」判 stale，不让崩过的进程永久堵住索引。
 */
function tryAcquireIndexLock(cfg) {
    const file = buildLockPath(cfg);
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    catch (err) {
        return { kind: 'failed', reason: errnoText(err) };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let fd;
        try {
            fd = fs.openSync(file, 'wx');
        }
        catch (err) {
            const code = err.code;
            // 只有 EEXIST 才是「别人持锁」；EACCES / EROFS / ENOSPC 是建不出来
            if (code !== 'EEXIST')
                return { kind: 'failed', reason: errnoText(err) };
            if (!indexLockStale(file))
                return { kind: 'held' };
            try {
                fs.rmSync(file, { force: true });
            }
            catch { /* 别人也在清：下一轮再说 */ }
            continue;
        }
        try {
            fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }));
        }
        catch (err) {
            // 半成品锁文件必须自己收掉：留着会让别人白等一个宽限期
            try {
                fs.rmSync(file, { force: true });
            }
            catch { /* 删不掉就靠宽限期 */ }
            return { kind: 'failed', reason: errnoText(err) };
        }
        finally {
            try {
                fs.closeSync(fd);
            }
            catch { /* 已经关了 */ }
        }
        return { kind: 'acquired', lock: { token } };
    }
    return { kind: 'held' };
}
function errnoText(err) {
    const code = err?.code;
    return code || (err instanceof Error ? err.message : String(err));
}
function indexLockStale(file) {
    let st;
    try {
        st = fs.statSync(file);
    }
    catch {
        return true;
    } // 锁没了：让下一轮重试
    const age = Date.now() - st.mtimeMs;
    if (age > indexPolicy.buildTimeoutMs)
        return true;
    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        // 刚 openSync 还没写入 token（或写到一半）：给几秒宽限。
        // 这里若一律当 stale，会把别人刚建好的锁删掉，两个进程同时跑 zk index —— 正是这把锁要防的。
        return age > LOCK_WRITE_GRACE_MS;
    }
    if (typeof data.pid === 'number') {
        try {
            process.kill(data.pid, 0);
        }
        catch {
            return true;
        }
    }
    return false;
}
function releaseIndexLock(cfg, lock) {
    const file = buildLockPath(cfg);
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.token === lock.token)
            fs.rmSync(file, { force: true });
    }
    catch { /* 已经被别人清掉了 */ }
}
/**
 * 启动一次索引：进程内 single-flight 靠 builds Map，跨进程靠调用方先抢到的锁。
 * 不传 lock 的只有两种：M5.0a 的冷建路径（db 本来就不完整，与 flush 互斥）、
 * 以及锁建不出来时的降级（退回 R6 之前的行为，不让显式重建失败）。
 * 成功时按「建库前拍下的 generation」清 dirty：建库期间的写入会留下差值，不会被误清。
 */
function startIndexBuild(cfg, loc, signal, lock) {
    const key = cfg.notebook;
    const startedAt = Date.now();
    const generation = readIndexState(cfg).generation;
    const promise = run(loc.bin, [...baseArgs(cfg), 'index', '--quiet'], {
        signal,
        timeoutMs: indexPolicy.buildTimeoutMs,
    }).then(() => {
        buildFailures.delete(key);
        markIndexed(cfg, generation);
    }, (err) => {
        const message = indexFailureText(err);
        buildFailures.set(key, { at: Date.now(), message });
        throw new ZkError(`建索引失败：${message}`, INDEX_HINT, 'index-failed');
    }).finally(() => {
        if (lock)
            releaseIndexLock(cfg, lock);
        builds.delete(key);
    });
    const build = { promise, startedAt };
    builds.set(key, build);
    // 后台任务常常没有 await 的人：别让 rejection 变成 unhandledRejection
    promise.catch(() => { });
    return build;
}
const STALE_INDEX_WARNING = '索引刷新还没完成，这次读的是「完整但可能过期」的索引（新写入稍后可见）；不要手动再跑 zk index';
/** 同一条告警按「笔记本 + generation」去重：10k 库上每次读都刷一行只会把日志淹掉 */
const staleWarned = new Map();
function warnStaleOnce(cfg, warning) {
    const generation = readIndexState(cfg).generation;
    if (staleWarned.get(cfg.notebook) === generation)
        return;
    staleWarned.set(cfg.notebook, generation);
    console.warn(`[zdiary] ${warning}`);
}
function indexIsDirty(cfg) {
    const s = readIndexState(cfg);
    return s.generation > s.indexedGeneration;
}
/** 等一次建库落地；不抛错、不吞掉后台任务（超时只是让调用方 stale 回退） */
async function waitForBuild(build, signal) {
    let settled = null;
    void build.promise.then(() => { settled = 'ok'; }, () => { settled = 'error'; });
    const deadline = Date.now() + indexPolicy.waitMs;
    while (settled === null && Date.now() < deadline) {
        try {
            await sleep(150, signal);
        }
        catch {
            return 'timeout';
        }
    }
    return settled ?? 'timeout';
}
/**
 * 别的进程持锁时：等它放开，不并发起第二个 zk index。
 * 读路径只等 `indexPolicy.lockWaitMs`（2 s）：10k 库建库要几分钟，等满 15 s 只会让每次读都卡住。
 */
async function waitForIndexLockRelease(cfg, signal, budgetMs = indexPolicy.lockWaitMs) {
    const file = buildLockPath(cfg);
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (!fs.existsSync(file))
            return true;
        try {
            await sleep(150, signal);
        }
        catch {
            return false;
        }
    }
    return false;
}
/**
 * 读之前补一次增量索引（R6 的「写后可读」）。返回一条告警，或 null。
 *
 * 优先级（§9.3 第 4 步 / §10.3 第 2 条）：db 不完整（missing / interrupted）时**一律不在这里建**，
 * 交给紧随其后的 `ensureIndexReady` —— 它决定「小库自己补完 / 大库后台建并报 index-building」。
 * 所以 stale 回退只可能落在「完整但过期的 db」上，绝不会退回读半库，
 * 也就不会把 M5.0a 修掉的「读 → 杀 → 半库 → 再读」循环放回来。
 *
 * 挂在 zk() 这个唯一读入口上，searchNotesDetailed / lint / dream 以及 findNote / stats / 反查
 * 都自动覆盖；不脏时只是一次 stat + 一次读状态文件。
 */
export async function flushIndexIfDirty(cfg, signal) {
    if (!hasNotebook(cfg))
        return null;
    if (indexStateOf(cfg) !== 'ready')
        return null;
    if (!indexIsDirty(cfg))
        return null;
    const key = cfg.notebook;
    let build = builds.get(key);
    if (!build) {
        // 先解析二进制、再抢锁：反过来的话 requireZk 抛错会把锁文件留到 30 分钟后才被判 stale
        const loc = await requireZk(cfg);
        for (let attempt = 0; attempt < 2 && !build; attempt += 1) {
            const acquired = tryAcquireIndexLock(cfg);
            if (acquired.kind === 'failed') {
                return `索引锁建不出来（${acquired.reason}）：这次读的是完整但可能过期的索引；检查 .zk 目录的权限与磁盘，再到设置页点「重建索引」`;
            }
            if (acquired.kind === 'held') {
                // 另一个进程正在建：只等一小会儿；等不到就带着完整但过期的 db 继续（dirty 保留）
                const released = await waitForIndexLockRelease(cfg, signal);
                if (!indexIsDirty(cfg))
                    return null;
                if (!released)
                    break;
                continue;
            }
            build = startIndexBuild(cfg, loc, signal, acquired.lock);
        }
        if (!build)
            return STALE_INDEX_WARNING;
    }
    const settled = await waitForBuild(build, signal);
    if (settled === 'error')
        return '刷新索引失败：这次读的是完整但可能过期的索引（dirty 已保留，下次会重试）';
    if (settled === 'timeout')
        return STALE_INDEX_WARNING;
    return null;
}
/** 有 journal 但 db 还在长 → 是别的 zk 进程在写，不要去抢 */
async function indexBeingWritten(cfg) {
    const { db } = indexPaths(cfg);
    const stamp = () => {
        try {
            const s = fs.statSync(db);
            return s.size + ':' + s.mtimeMs;
        }
        catch {
            return '';
        }
    };
    const before = stamp();
    await sleep(250);
    return before !== stamp();
}
function indexBuildingError(cfg, state, elapsedMs) {
    const waited = Math.max(1, Math.round(elapsedMs / 1000));
    const head = state === 'missing'
        ? `索引还没建好（首次要扫 ${approxNoteCount(cfg)} 篇，已等 ${waited} 秒）`
        : `索引不完整（上次建索引被中断），正在后台重建（已等 ${waited} 秒）`;
    return new ZkError(head, '后台正在建立，过一会儿再调用一次；大库首次可能要几分钟 —— 不要同时再跑 zk index', 'index-building');
}
async function waitForIndex(cfg, build, state, signal) {
    const deadline = Date.now() + indexPolicy.waitMs;
    let settled = null;
    let failure = null;
    void build.promise.then(() => { settled = 'ok'; }, (err) => { settled = 'error'; failure = err; });
    while (settled === null && Date.now() < deadline)
        await sleep(150, signal);
    if (settled === 'error')
        throw failure;
    if (settled === 'ok' && indexStateOf(cfg) === 'ready')
        return;
    throw indexBuildingError(cfg, state, Date.now() - build.startedAt);
}
/**
 * 跑命令前确认索引可用；返回这条命令该用的超时。
 * 读命令绝不在「索引还没建完」时被 60 s 杀掉 —— 那正是半库循环的起点。
 */
async function ensureIndexReady(cfg, loc, signal) {
    if (!hasNotebook(cfg))
        return 60_000;
    const state = indexStateOf(cfg);
    if (state === 'ready')
        return 60_000;
    const running = builds.get(cfg.notebook);
    if (running) {
        await waitForIndex(cfg, running, state, signal);
        return 60_000;
    }
    const failed = buildFailures.get(cfg.notebook);
    if (failed && Date.now() - failed.at < indexPolicy.failureCooldownMs) {
        throw new ZkError(`建索引失败：${failed.message}`, INDEX_HINT, 'index-failed');
    }
    if (state === 'interrupted' && await indexBeingWritten(cfg)) {
        throw new ZkError('索引正在被另一个 zk 进程建立（.zk/notebook.db-journal 还在变）', '等它完成再调用；不要并发跑 zk index', 'index-building');
    }
    if (approxNoteCount(cfg) <= indexPolicy.autoBuildMaxNotes) {
        // 小库让这条命令自己建：多起一个 zk index 反而更慢
        return indexPolicy.buildTimeoutMs;
    }
    await waitForIndex(cfg, startIndexBuild(cfg, loc), state, signal);
    return 60_000;
}
/**
 * 跑一条 zk 命令，返回 stdout；非零退出 → ZkError（带 zk 自己最后几行 stderr）。
 *
 * `opts.warnings` 收 exit 0 时的 stderr warning：zk 解析不了 frontmatter 只在这里吭一声，
 * 不收的话那篇笔记就从索引里静默消失（能搜不到、也不进任何一个巡检桶）。
 *
 * `init` / `index` 不走索引守卫：前者还没有笔记本，后者本来就是显式重建（调用方自带超时）。
 * 别名（runAlias）也不走 —— 那是用户自己的命令，不知道它会不会碰索引。
 */
export async function zk(cfg, args, opts = {}) {
    const loc = await requireZk(cfg);
    const explicitBuild = args[0] === 'init' || args[0] === 'index';
    // 先补「写后可读」，再让 ensureIndexReady 判 db 是否完整：flush 只在完整 db 上跑，
    // 万一它超时留下 journal，紧随其后的守卫会拦下这次读（见 flushIndexIfDirty 的优先级说明）。
    if (!explicitBuild) {
        const warning = await flushIndexIfDirty(cfg, opts.signal);
        if (warning)
            warnStaleOnce(cfg, warning);
    }
    const timeoutMs = explicitBuild
        ? (opts.timeoutMs ?? 60_000)
        : (opts.timeoutMs ?? await ensureIndexReady(cfg, loc, opts.signal));
    try {
        const r = await run(loc.bin, [...baseArgs(cfg), ...args], {
            input: opts.input,
            signal: opts.signal,
            timeoutMs,
        });
        if (opts.warnings) {
            for (const line of r.stderr.split('\n')) {
                const trimmed = line.trim();
                if (WARNING_LINE.test(trimmed))
                    opts.warnings.push(trimmed);
            }
        }
        return r.stdout;
    }
    catch (err) {
        if (err instanceof ExecError) {
            if (err.killed && timeoutMs > 60_000) {
                throw new ZkError('建索引超时（这条命令在等索引建完时被中断）', '索引可能还没建完；稍后再试，或到设置页点「重建索引」', 'index-failed');
            }
            throw new ZkError(err.message, undefined, 'zk-failed');
        }
        throw err;
    }
}
/**
 * 执行 `zk <别名> [argv...]`。
 *
 * 为什么不自己 `$SHELL -c`：别名里可以有 `$@`、管道、`$SHELL` 语法，这些语义只有 zk
 * 自己完整；插件把 argv 当数组交给 zk，由 zk 负责引用，模型给的参数不会拼进 shell。
 *
 * 两个环境细节：
 *   · `ZK_NOTEBOOK_DIR`：别名里通常写 `zk list …`，内层 zk 靠它找到同一本笔记本；
 *   · `PATH`：内层 `zk` 必须能解析 —— 用户可能把 zk 放在托管目录 / 自定义路径，不一定在 PATH 里。
 *
 * 不传 `--no-input`：它会出现在别名的 `$@` 里（`zk ls --no-input` 能接受，任意命令不一定）。
 * 交互式别名（`edit` 之类）本来就不适合工具调用，靠超时兜底。
 */
export async function runAlias(cfg, name, argv = [], opts = {}) {
    const loc = await requireZk(cfg);
    const env = { ...process.env, ZK_NOTEBOOK_DIR: cfg.notebook };
    // 保证别名里的 `zk ...` 用的就是这次解析到的二进制（PATH 里可能先撞上另一个版本）
    const resolved = path.isAbsolute(loc.bin) ? loc.bin : findOnPath(loc.bin);
    let parts = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    if (resolved) {
        const binDir = path.dirname(resolved);
        parts = [binDir, ...parts.filter((dir) => dir !== binDir)];
    }
    env.PATH = parts.join(path.delimiter);
    try {
        const r = await run(loc.bin, [name, ...argv], {
            cwd: opts.cwd ?? cfg.notebook,
            env,
            signal: opts.signal,
            timeoutMs: opts.timeoutMs ?? 60_000,
        });
        return { alias: name, stdout: r.stdout, stderr: r.stderr };
    }
    catch (err) {
        if (err instanceof ExecError) {
            throw new ZkError(`别名「${name}」执行失败：${err.stderr.trim() || err.message}`, '检查 .zk/config.toml 的 [alias] 命令；交互式命令（如 edit）不适合工具调用', 'zk-failed');
        }
        throw err;
    }
}
/** `zk: warning: error parsing note content <absPath>: <reason>` */
const PARSE_WARNING = /^zk: warning: error parsing note content (.+?): (.+)$/;
/**
 * 从收集到的 warning 里挑出 frontmatter 解析失败的笔记。
 *
 * 归档 / raw / inbox / meta 文件即使写坏也不影响检索口径（它们本来就不进索引查询），
 * 报出来只会把真问题淹掉 —— 所以按 `excludedNames` 同一套口径过滤。
 */
export function parseErrorWarnings(cfg, warnings) {
    const excluded = excludedNames(cfg);
    const seen = new Set();
    const out = [];
    for (const line of warnings) {
        const m = line.match(PARSE_WARNING);
        if (!m)
            continue;
        const abs = path.resolve(cfg.notebook, m[1]);
        if (excluded.some((p) => abs === p || abs.startsWith(p + path.sep)))
            continue;
        const rel = path.relative(cfg.notebook, abs).split(path.sep).join('/');
        if (seen.has(rel))
            continue;
        seen.add(rel);
        out.push({ path: rel, reason: m[2].trim() });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}
/** 压空白、去 zk 的 <zk:match> 高亮、截到 240 字 */
function clipSnippet(value) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== 'string')
        return '';
    return first.replace(/<\/?zk:match>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}
/**
 * R2：命中片段。
 *
 * zk 0.15.7 的 snippets[0] 实测**就是首段**（长笔记里与 lead 完全相同），
 * 深处命中时它并不定位命中句。所以先看片段里有没有查询词，没有就从
 * rawContent 里取「最早命中 ± 窗口」；两者都没有才退回 snippets[0]。
 * 精简字段格式（LEAN）没有 rawContent，调用方只传 snippets[0]。
 */
function buildSnippet(raw, terms) {
    const first = clipSnippet(raw.snippets);
    if (terms.length === 0 || terms.some((t) => t && first.includes(t)))
        return first;
    const content = String(raw.rawContent ?? raw.body ?? '');
    let at = -1;
    for (const t of terms) {
        const i = content.indexOf(t);
        if (i >= 0 && (at < 0 || i < at))
            at = i;
    }
    if (at < 0)
        return first;
    return content.slice(Math.max(0, at - 80), Math.max(0, at - 80) + 240)
        .replace(/<\/?zk:match>/g, '').replace(/\s+/g, ' ').trim();
}
function toRecord(raw, cfg, terms = []) {
    const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
    const absPath = String(raw.absPath ?? '');
    // ⚠️ zk 在 cwd 之外用 --notebook-dir 时，path 会变成相对 cwd 的 `../../…`；
    // absPath 永远是对的 → 一律用 absPath 重新算相对笔记本的路径。
    const relPath = absPath
        ? path.relative(cfg.notebook, absPath).split(path.sep).join('/')
        : String(raw.path ?? '').split(path.sep).join('/');
    const metadata = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? raw.metadata
        : {});
    const meta = (key) => {
        const v = metadata[key];
        return v === undefined || v === null ? '' : String(v);
    };
    return {
        title: String(raw.title ?? ''),
        path: relPath,
        absPath,
        link: String(raw.link ?? ''),
        tags: rawTags.map((t) => String(t)),
        created: String(raw.created ?? ''),
        modified: String(raw.modified ?? ''),
        lead: String(raw.lead ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        snippet: buildSnippet(raw, terms),
        summary: '',
        words: Number(raw.wordCount ?? 0),
        metadata,
        id: meta('id'),
        status: meta('status'),
        type: meta('type'),
        authority: meta('authority'),
    };
}
function parseList(stdout) {
    const text = stdout.trim();
    if (!text)
        return [];
    // `--quiet` 之后仍可能有 "Found N notes" 之类的尾行 → 只取第一个 JSON 值
    const start = text.indexOf('[');
    if (start < 0)
        return [];
    const end = text.lastIndexOf(']');
    if (end <= start)
        return [];
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
/** 搜索 / 列举笔记 */
/**
 * 所有查询都排除的路径/文件名（计划 §7）。
 * 两个坑（Z4）：
 *   · 不传 glob（`-x 'archive/**'` 会静默失效）；
 *   · `-x` 是**相对 cwd** 解析的，不是相对 `--notebook-dir` —— 插件跑在任意 cwd 下，
 *     所以一律拼成绝对路径，否则换台机器/换个工作目录排除就静默失效。
 */
export function excludedNames(cfg, opts = {}) {
    const rels = ['raw', 'inbox'];
    if (!opts.includeArchived)
        rels.push(cfg.archiveDir);
    rels.push(...META_NAMES);
    return rels.map((rel) => path.join(cfg.notebook, rel));
}
/** 相对路径是否落在某个目录下（含目录本身）—— 用于把 dailyDir 映射成 type=daily */
export function isUnderDir(rel, dir) {
    const d = String(dir ?? '').replace(/\/+$/, '');
    return !!d && (rel === d || rel.startsWith(d + '/'));
}
/** FTS5 的 unicode61 只按「连续字母/数字」切词：中文整句是一个 token，子串查询会漏 */
const CJK_TEXT = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
/** 正文 hashtag 的唯一口径：`noteFromDisk` 的解析与 `taglessCjkWarning` 的判断共用一份 */
const HASHTAG_SRC = '(?:^|\\s)#([\\p{L}\\p{N}_-]+)';
const HASHTAG = new RegExp(HASHTAG_SRC, 'u');
/** 查询里有没有 CJK：有就值得多跑一次正则（中文召回不完整是已知失败模式） */
export function hasCjk(text) {
    return CJK_TEXT.test(String(text ?? ''));
}
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (s) => s.replace(REGEX_META, '\\$&');
/**
 * R3：把 CJK 多词查询切成词。按空白 / 标点切、去重、保留 ≥2 字、最多 4 个；
 * 少于 2 个词、纯 ASCII 或超过 4 个词都返回 []，交给现有「整串正则」两遍策略。
 */
export function splitCjkQuery(query) {
    const q = String(query ?? '').trim();
    if (!hasCjk(q))
        return [];
    const words = [...new Set(q.split(/[\s\p{P}\p{S}]+/u).filter((w) => [...w].length >= 2))];
    return words.length >= 2 && words.length <= 4 ? words : [];
}
/** 多词正则：转义后做 alternation，仍然一次进程召回（不做逐词 N 次进程） */
export function cjkAlternation(words) {
    return `(?:${words.map(escapeRegex).join('|')})`;
}
/** 命中覆盖了几个查询词（字面子串） */
function coverageOf(text, words) {
    let n = 0;
    for (const w of words)
        if (text.includes(w))
            n += 1;
    return n;
}
/**
 * 全量遍历用的字段格式（plan §0.5.1）：10k 实测 JSON 17.2 MB，
 * 这些字段只要约 2 MB，且省掉 body / rawContent / snippets。
 *
 * 分隔符用控制字符：标题 / 标签 / lead 里几乎不会出现；lead 放最后，
 * 解析时把剩余段重新拼回去，避免正文里的分隔符把记录切断。
 */
const LEAN_FIELD = '\u001f';
const LEAN_RECORD = '\u001e';
const LEAN_TAG = '\u001c';
const LEAN_FIELDS = [
    '{{absPath}}',
    '{{title}}',
    '{{wordCount}}',
    '{{created}}',
    '{{modified}}',
    `{{join tags "${LEAN_TAG}"}}`,
    '{{metadata.status}}',
    '{{metadata.type}}',
    '{{metadata.authority}}',
    '{{metadata.date}}',
    '{{metadata.supersede-reason}}',
    '{{metadata.id}}',
];
const LEAN_TEMPLATE = [...LEAN_FIELDS, '{{lead}}'].join(LEAN_FIELD);
/**
 * 带 query 的结构化检索额外取 snippets[0]（R2）。只在有 query 时用：
 * 无 query 的 `zk_query` 会扫全库，加这一列等于给 10k 全量遍历多背一段正文。
 * lead 仍放最后，解析时把剩余段拼回去。
 */
const SEARCH_LEAN_TEMPLATE = [...LEAN_FIELDS, '{{snippets}}', '{{lead}}'].join(LEAN_FIELD);
/** zk 模板给的是 `2026-01-02 03:04:05 +0000 UTC`，转成 Date 能吃的 ISO（zk 存的是 UTC） */
function leanIso(value) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(value).trim());
    return m ? `${m[1]}T${m[2]}Z` : String(value).trim();
}
/**
 * 解析 LEAN_TEMPLATE / SEARCH_LEAN_TEMPLATE 的输出。字段顺序与模板一一对应；
 * 不足定长字段数说明 zk 行为变了，记 malformed（调用方报 unknown，而不是把空数组当「没有笔记」）。
 */
function parseLeanList(stdout, cfg, withSnippet = false) {
    const text = String(stdout ?? '');
    if (!text.trim())
        return { notes: [], malformed: false };
    const notes = [];
    let malformed = false;
    // 12 个定长字段（含 id）+（可选）snippet + lead；lead 放最后，多余的段拼回去
    const leadAt = withSnippet ? 13 : 12;
    for (const chunk of text.split(LEAN_RECORD)) {
        const record = chunk.replace(/^[\r\n]+|[\r\n]+$/g, '');
        if (!record.trim())
            continue;
        const parts = record.split(LEAN_FIELD);
        if (parts.length < leadAt) {
            malformed = true;
            continue;
        }
        const [absPath, title, words, created, modified, tags, status, type, authority, date, reason, id] = parts;
        const snippet = withSnippet ? clipSnippet(parts[12]) : '';
        const lead = parts.slice(leadAt).join(LEAN_FIELD).replace(/\s+/g, ' ').trim().slice(0, 200);
        const abs = absPath ?? '';
        if (!abs) {
            malformed = true;
            continue;
        }
        const rel = path.relative(cfg.notebook, abs).split(path.sep).join('/');
        const metadata = {};
        if (status)
            metadata.status = status;
        if (type)
            metadata.type = type;
        if (authority)
            metadata.authority = authority;
        if (date)
            metadata.date = date;
        if (reason)
            metadata['supersede-reason'] = reason;
        if (id)
            metadata.id = id;
        notes.push({
            title: String(title ?? ''),
            path: rel,
            absPath: abs,
            link: `[[${rel.replace(/\.[^./]+$/, '')}]]`,
            tags: String(tags ?? '').split(LEAN_TAG).map((t) => t.trim()).filter(Boolean),
            created: leanIso(created ?? ''),
            modified: leanIso(modified ?? ''),
            lead,
            snippet,
            summary: '',
            words: Number(words ?? 0),
            metadata,
            id: String(id ?? ''),
            status: String(status ?? ''),
            type: String(type ?? ''),
            authority: String(authority ?? ''),
        });
    }
    return { notes, malformed };
}
/**
 * 检索 + 用了哪种匹配策略。
 *
 * 中文只在 0 命中时兜底是不够的：FTS 命中 1–2 条时模型会以为「库里只有这些」，
 * 然后建重复笔记。所以**含 CJK 的查询两遍都跑**（FTS + `-M re`），按路径去重合并；
 * 纯 ASCII 查询保持单进程，不付这份开销。
 */
export async function searchNotesDetailed(cfg, opts = {}, signal) {
    const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 10)));
    const statuses = (opts.status ?? []).filter(Boolean);
    const types = (opts.type ?? []).filter(Boolean);
    const jsFilter = statuses.length > 0 || types.length > 0;
    // 有 JS 过滤时不能只取前 200 条：10k 库里前 200 条可能只有 3 条 active，
    // 而全库有 50 条 —— 那是静默漏结果，不是截断。zk 没有 offset，无法真分页；
    // 改用只取必要字段的一次全量扫描（10k ≈ 2 MB / 2.6 s，JSON 是 17.2 MB），
    // 取到 MAX_SCAN + 1 条，超过 MAX_SCAN 才能确定「触顶」而不是刚好 10 000 条。
    const scanLimit = MAX_SCAN;
    // R3：CJK 多词切词。整串查询仍走现有两遍策略；多词时正则这一路换成转义后的
    // alternation（一次进程召回），再按 rawContent 的覆盖度排序（R3 第 2 条）。
    const cjkWords = splitCjkQuery(opts.query ?? '');
    const queryTerms = cjkWords.length > 0
        ? cjkWords
        : (String(opts.query ?? '').trim() ? [String(opts.query ?? '').trim()] : []);
    const regexQuery = cjkWords.length > 0 ? cjkAlternation(cjkWords) : opts.query;
    const build = (strategy, format, fetchLimit) => {
        const args = ['list', '--quiet', '--no-pager', '--format', format, '--limit', String(fetchLimit)];
        if (format === LEAN_TEMPLATE || format === SEARCH_LEAN_TEMPLATE)
            args.push('-d', LEAN_RECORD);
        for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived }))
            args.push('-x', name);
        if (opts.query)
            args.push('-m', strategy === 're' ? String(regexQuery) : opts.query);
        if (strategy)
            args.push('-M', strategy);
        for (const t of opts.tags ?? [])
            args.push('-t', t);
        if (opts.since)
            args.push('--created-after', opts.since);
        if (opts.until)
            args.push('--created-before', opts.until);
        if (opts.orphan)
            args.push('--orphan');
        if (opts.brokenLinks)
            args.push('--broken-links');
        // R1：有 query 且未显式给 sort（或显式 relevance）时不要传 --sort，
        // 否则 zk 的 created- 会覆盖 FTS 的相关性顺序；无 query 的 relevance 回退 created-desc。
        const sortTerm = opts.sort === 'relevance'
            ? (opts.query ? undefined : SORT_TERMS['created-desc'])
            : (opts.sort ? SORT_TERMS[opts.sort] : undefined);
        if (sortTerm)
            args.push('--sort', sortTerm);
        for (const p of opts.paths ?? [])
            args.push(p);
        return args;
    };
    // 0.1.0 的老笔记没有 frontmatter：status 缺省按 active 算，
    // 否则 flat vault 上 `status: ['active']` 会一条都查不出来（静默空结果比报错更难查）。
    // daily 模板没有 frontmatter：`type: daily` 按 dailyDir 路径兜底，
    // 否则工具枚举里给得出这个值、查询却永远命中 0 条。
    const keep = (n) => (statuses.length === 0 || statuses.includes(n.status || 'active')) &&
        (types.length === 0 || types.includes(n.type) || (types.includes('daily') && isUnderDir(n.path, cfg.dailyDir)));
    /** 无 JS 过滤：limit + 1 就够判断 hasMore，继续走 JSON（小、字段全） */
    const plainStrategy = async (strategy) => {
        const raws = parseList(await zk(cfg, build(strategy, 'json', limit + 1), { signal }));
        const notes = raws.map((raw) => toRecord(raw, cfg, queryTerms));
        const coverage = new Map();
        if (cjkWords.length > 0) {
            for (let i = 0; i < raws.length; i += 1) {
                coverage.set(notes[i].path, coverageOf(`${String(raws[i].title ?? '')} ${String(raws[i].rawContent ?? '')}`, cjkWords));
            }
        }
        return { notes, examined: notes.length, coverage };
    };
    /** 有 JS 过滤：扫到 MAX_SCAN + 1，过滤后再按 limit 截断；字段格式见 LEAN_TEMPLATE */
    const filteredStrategy = async (strategy) => {
        // 有 query 才多取 snippets[0]（R2）：无 query 时这一列会给全库扫描多背一段正文。
        const format = opts.query ? SEARCH_LEAN_TEMPLATE : LEAN_TEMPLATE;
        const parsed = parseLeanList(await zk(cfg, build(strategy, format, scanLimit + 1), { signal }), cfg, !!opts.query);
        const notes = parsed.notes.filter(keep);
        const coverage = new Map();
        if (cjkWords.length > 0) {
            // LEAN 没有 rawContent：只能用标题 / lead / snippet 算覆盖度（best effort）。
            for (const n of notes)
                coverage.set(n.path, coverageOf(`${n.title} ${n.lead} ${n.snippet}`, cjkWords));
        }
        return {
            notes,
            examined: parsed.notes.length,
            capped: parsed.notes.length > scanLimit,
            malformed: parsed.malformed,
            coverage,
        };
    };
    /** 合并两路的覆盖度，按 coverage 降序 → 原顺序（FTS 在前）→ created-desc 排序 */
    const rank = (notes, ...maps) => {
        if (cjkWords.length === 0)
            return notes;
        const coverage = new Map();
        for (const m of maps) {
            for (const [p, c] of m ?? [])
                coverage.set(p, Math.max(coverage.get(p) ?? 0, c));
        }
        const order = new Map(notes.map((n, i) => [n.path, i]));
        return [...notes].sort((a, b) => (coverage.get(b.path) ?? 0) - (coverage.get(a.path) ?? 0)
            || (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)
            || String(b.created).localeCompare(String(a.created)));
    };
    const finish = (notes, examined, extra = {}) => {
        const more = notes.length > limit || extra.capped === true;
        const completeness = more
            ? 'partial'
            : extra.malformed || extra.strategyFailed ? 'unknown' : 'complete';
        // R2：只有 complete 时 notes.length 才是精确总数；partial / unknown 不给 total。
        const total = completeness === 'complete' ? { total: notes.length } : {};
        // 15.6：只对可见命中读盘补 summary（O(limit) 本地 IO，零子进程）；scanNotes 全库路径不经过这里
        return { notes: attachSummaries(cfg, notes.slice(0, limit)), hasMore: more, completeness, scanned: examined, ...total, matchStrategy: 'fts' };
    };
    /**
     * mixed 的判据必须看「截断后的可见结果」：FTS 已占满 limit 时，正则补的那条
     * 即使存在也会被 slice 掉，不能还报 mixed（否则界面谎称补上了全文索引漏掉的）。
     */
    const strategyOf = (base, merged) => {
        const top = new Set(base.slice(0, limit).map((n) => n.path));
        const visibleExtra = merged.slice(0, limit).some((n) => !top.has(n.path));
        return visibleExtra ? (base.length ? 'mixed' : 'regex') : base.length ? 'fts' : 'regex';
    };
    if (!jsFilter) {
        try {
            const hits = await plainStrategy();
            // 没有查询词 / 纯 ASCII：维持单进程
            if (!opts.query || !hasCjk(opts.query)) {
                if (hits.examined === 0 && opts.query) {
                    const retry = await plainStrategy('re');
                    return { ...finish(retry.notes, retry.examined), matchStrategy: 'regex' };
                }
                return finish(hits.notes, hits.examined);
            }
            // 含中文：FTS 与正则各跑一次，合并去重（FTS 的排序在前，正则补漏在后）。
            // 正则这一路单独兜住：FTS 已经有结果时，子串匹配出错不该把整次检索拖成失败。
            let regex = null;
            let strategyFailed = false;
            try {
                regex = await plainStrategy('re');
            }
            catch (err) {
                if (!(err instanceof ZkError))
                    throw err;
                strategyFailed = true;
            }
            const seen = new Set(hits.notes.map((n) => n.path));
            const merged = [...hits.notes];
            for (const n of regex?.notes ?? []) {
                if (seen.has(n.path))
                    continue;
                seen.add(n.path);
                merged.push(n);
            }
            const ranked = rank(merged, hits.coverage, regex?.coverage);
            return {
                ...finish(ranked, hits.examined + (regex?.examined ?? 0), { strategyFailed }),
                matchStrategy: strategyOf(hits.notes, ranked),
            };
        }
        catch (err) {
            if (opts.query && err instanceof ZkError) {
                const retry = await plainStrategy('re');
                return { ...finish(rank(retry.notes, retry.coverage), retry.examined), matchStrategy: 'regex' };
            }
            throw err;
        }
    }
    // ── 有 status / type 过滤：取足再过滤 ─────────────────────────────
    try {
        const hits = await filteredStrategy();
        if (!opts.query || !hasCjk(opts.query)) {
            if (hits.examined === 0 && opts.query) {
                const retry = await filteredStrategy('re');
                return { ...finish(retry.notes, retry.examined, retry), matchStrategy: 'regex' };
            }
            return finish(hits.notes, hits.examined, hits);
        }
        let regex = null;
        let strategyFailed = false;
        try {
            regex = await filteredStrategy('re');
        }
        catch (err) {
            if (!(err instanceof ZkError))
                throw err;
            strategyFailed = true;
        }
        const seen = new Set(hits.notes.map((n) => n.path));
        const merged = [...hits.notes];
        for (const n of regex?.notes ?? []) {
            if (seen.has(n.path))
                continue;
            seen.add(n.path);
            merged.push(n);
        }
        const ranked = rank(merged, hits.coverage, regex?.coverage);
        return {
            ...finish(ranked, hits.examined + (regex?.examined ?? 0), {
                capped: hits.capped || regex?.capped === true,
                malformed: hits.malformed || regex?.malformed === true,
                strategyFailed,
            }),
            matchStrategy: strategyOf(hits.notes, ranked),
        };
    }
    catch (err) {
        if (opts.query && err instanceof ZkError) {
            const retry = await filteredStrategy('re');
            return { ...finish(rank(retry.notes, retry.coverage), retry.examined, retry), matchStrategy: 'regex' };
        }
        throw err;
    }
}
/** 只要结果、不要策略的旧入口（绝大多数调用方） */
export async function searchNotes(cfg, opts = {}, signal) {
    return (await searchNotesDetailed(cfg, opts, signal)).notes;
}
/** 巡检 / 做梦一次最多扫多少篇：到顶就告警，不静默截断（静默失败最难查） */
export const MAX_SCAN = 10_000;
/**
 * 一次取回全部笔记（巡检 / 做梦 / 首页用），并明确「有没有扫全」。
 *
 * 取 `limit + 1` 条：刚好等于 limit 时不能判断是不是触顶，多取一条才分得出
 * 「库里正好 10 000 篇」和「还有第 10 001 篇」。字段用 LEAN_TEMPLATE：
 * 10k 实测 JSON 17.2 MB / 2.3 s，精简格式约 2 MB / 2.6 s，少 8 倍字节。
 * `warnings` 见 `zk()`。
 */
export async function scanNotes(cfg, opts = {}, signal) {
    const limit = Math.min(MAX_SCAN, Math.max(1, Math.trunc(opts.limit ?? MAX_SCAN)));
    const args = ['list', '--quiet', '--no-pager', '--format', LEAN_TEMPLATE, '-d', LEAN_RECORD, '--limit', String(limit + 1)];
    for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived }))
        args.push('-x', name);
    const parsed = parseLeanList(await zk(cfg, args, { signal, warnings: opts.warnings }), cfg);
    const capped = parsed.notes.length > limit;
    const notes = capped ? parsed.notes.slice(0, limit) : parsed.notes;
    // 与 searchNotesDetailed 的 finish 同口径：partial（触顶）优先于 unknown（解析失败），
    // 两种情况同时成立时先说「还有更多」，再说「解析可能不全」。
    const completeness = capped ? 'partial' : parsed.malformed ? 'unknown' : 'complete';
    return { notes, completeness, scanned: notes.length, limit };
}
/** 旧入口：只要笔记。需要三态（lint / dream / 首页）用 `scanNotes`。 */
export async function allNotes(cfg, opts = {}, signal) {
    return (await scanNotes(cfg, opts, signal)).notes;
}
/**
 * 用 zk 的过滤器挑笔记，只取**绝对路径**。
 * 别用 `{{path}}`：它相对 cwd，换个工作目录就变成 `../../tmp/...`（Z4 同款坑）。
 * 一类过滤器一次进程，不要按笔记逐条跑；取 MAX_SCAN + 1 条才能区分「正好 10 000」与「还有更多」。
 */
export async function scanNotesWithFlag(cfg, flag, signal) {
    const args = ['list', '--quiet', '--no-pager', '--format', '{{absPath}}', '--limit', String(MAX_SCAN + 1), flag];
    for (const name of excludedNames(cfg))
        args.push('-x', name);
    const out = await zk(cfg, args, { signal });
    const all = out.split('\n').map((line) => line.trim()).filter(Boolean);
    const capped = all.length > MAX_SCAN;
    const paths = capped ? all.slice(0, MAX_SCAN) : all;
    return { paths, completeness: capped ? 'partial' : 'complete', scanned: paths.length };
}
/** 旧入口：只要路径（调用方不需要三态时用） */
export async function notesWithFlag(cfg, flag, signal) {
    return (await scanNotesWithFlag(cfg, flag, signal)).paths;
}
/**
 * `zk graph` 的 `--limit` 上限。注意它限的是**笔记载入数**（`zk graph --help`：`Limit the number of notes found`），
 * 不是边数 —— 实测 1 个来源 + 6 个目标、`--limit 3` 只回 2 条边。边集不完整的后果是**误报**，见 `graphEdges`。
 */
export const MAX_GRAPH_NOTES = 10_000;
/**
 * 全部双链边（一次 `zk graph`）。路径是**笔记本相对**的，按路径比对，不缓存 targetId（Z11 之后 id 会变）。
 *
 * `truncated` 必须往上报：`--limit` 到顶时 zk 不报错，少掉的那条边如果正好是回链，
 * S→X 就会被算成单向 —— 这是整个巡检里唯一能产生**误报**的截断（笔记扫描到顶只会漏报）。
 *
 * 判定以 JSON 里的 `notes` 数组长度为准（就是实际载入的笔记数，`--limit 3` → 3）。只数边里出现过的
 * 笔记会漏：链接稀疏时两端的笔记可能一篇都没载入，一条边都不返回，`nodes.size` 恒为 0（`--limit 3` 实测
 * 0 条边）。`notes` 缺失（老版本 zk）时才退回按边里的笔记数判断。
 */
export async function graphEdges(cfg, signal, opts = {}) {
    const limit = Math.min(MAX_GRAPH_NOTES, Math.max(1, Math.trunc(opts.limit ?? MAX_GRAPH_NOTES)));
    const args = ['graph', '--quiet', '--format', 'json', '--limit', String(limit)];
    for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived }))
        args.push('-x', name);
    const text = await zk(cfg, args, { signal });
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
        return { edges: [], truncated: false, completeness: 'unknown' };
    let graph;
    try {
        graph = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return { edges: [], truncated: false, completeness: 'unknown' };
    }
    const out = [];
    const nodes = new Set();
    for (const link of graph.links ?? []) {
        const sourcePath = String(link.sourcePath ?? '');
        const targetPath = String(link.targetPath ?? '');
        const snippetStart = Number(link.snippetStart);
        if (!sourcePath || !targetPath)
            continue;
        out.push({ sourcePath, targetPath, snippetStart: Number.isFinite(snippetStart) ? snippetStart : -1 });
        nodes.add(sourcePath);
        nodes.add(targetPath);
    }
    // notes 是实际载入的笔记数；两个条件取或，宁可多报一次也别静默漏掉告警
    const loaded = Array.isArray(graph.notes) ? graph.notes.length : 0;
    const truncated = loaded >= limit || nodes.size >= limit;
    // 没有 notes 数组（老 zk）时，nodes 没到上限也不能断言完整
    const completeness = truncated ? 'partial' : Array.isArray(graph.notes) ? 'complete' : 'unknown';
    return { edges: out, truncated, completeness };
}
/**
 * 全图预算的默认值（篇数）：真正生效的是配置 `graphBudgetNotes`（默认取它）。
 *
 * 实测（§0.5.1）：1k / 0 链 0.45 s，10k / 1 链 26–31 s / 17 MB；成本随链接数线性涨
 * （6.6 s + 26 ms × 链接数），真实库 2–5 链/篇时 10k 会超过 60 s 超时。
 * 超过这个数就不要再调 `graphEdges`：改按篇反查（`backlinksOf` / `outlinksOf`），
 * 读不到就显式报 partial，别拿「返回了结果」冒充完整。
 */
export const GRAPH_BUDGET_NOTES = 2_000;
/** 按篇反查的默认上限：够显示用；改写链接的调用方自己传更大的限制 */
export const MAX_LINK_NOTES = 200;
/**
 * 按篇反查双链：一次 `zk list --link-to` / `--linked-by`，不建全图（plan §0.5.1 结论 3）。
 *
 * ⚠️ 只认**绝对路径**。zk 0.15.7 实测：给相对路径、标题或不存在的路径时，过滤条件会被
 * 当成没写，返回**全库** —— 宁可先挡掉，也不要把「全库」当入链。
 */
async function linkedNotes(cfg, flag, rel, opts = {}, signal) {
    const root = path.resolve(cfg.notebook);
    const abs = path.resolve(cfg.notebook, rel);
    if (abs !== root && !abs.startsWith(root + path.sep))
        return { notes: [], truncated: false, completeness: 'complete' };
    if (!fs.existsSync(abs))
        return { notes: [], truncated: false, completeness: 'complete' };
    const limit = Math.min(MAX_SCAN, Math.max(1, Math.trunc(opts.limit ?? MAX_LINK_NOTES)));
    const args = ['list', '--quiet', '--no-pager', '--format', 'json', '--limit', String(limit + 1), flag, abs];
    for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived }))
        args.push('-x', name);
    const raws = parseList(await zk(cfg, args, { signal }));
    const notes = raws.map((raw) => toRecord(raw, cfg));
    const truncated = notes.length > limit;
    const result = { notes: notes.slice(0, limit), truncated, completeness: truncated ? 'partial' : 'complete' };
    if (opts.keepContent) {
        const contents = new Map();
        for (let i = 0; i < notes.length; i += 1) {
            contents.set(notes[i].path, String(raws[i]?.rawContent ?? raws[i]?.body ?? ''));
        }
        result.contents = contents;
    }
    return result;
}
/** 谁链到这篇（入链 / 反链）。路径是笔记本相对的；目标不存在时返回空，不返回全库 */
export async function backlinksOf(cfg, rel, opts = {}, signal) {
    const found = await linkedNotes(cfg, '--link-to', rel, opts, signal);
    return { ...found, notes: found.notes.filter((n) => n.path !== rel) };
}
/** 这篇链到了谁（出链）。同上：目标不存在时返回空 */
export async function outlinksOf(cfg, rel, opts = {}, signal) {
    const found = await linkedNotes(cfg, '--linked-by', rel, opts, signal);
    return { ...found, notes: found.notes.filter((n) => n.path !== rel) };
}
/** `[[目标|别名]]` / `[[目标#小节]]` / `./notes/x.md` → `notes/x` 形态的裸目标 */
function walkSeedTarget(raw) {
    let target = String(raw ?? '').trim();
    const wrapped = /^\[\[([^\]]*)\]\]$/.exec(target);
    if (wrapped)
        target = String(wrapped[1] ?? '');
    return target.split('|')[0].split('#')[0].trim().replace(/\\/g, '/').replace(/^\.\//, '');
}
/** 看起来是路径（含目录分隔符或 .md 后缀）—— 路径种子不查索引，直接看磁盘 */
function looksLikePath(target) {
    return target.includes('/') || /\.(md|markdown)$/i.test(target);
}
function seedAt(cfg, rel, opts = {}) {
    const root = path.resolve(cfg.notebook);
    const abs = path.resolve(cfg.notebook, rel);
    if (abs !== root && !abs.startsWith(root + path.sep))
        return null;
    // 种子也是「进入网络的入口」：meta / raw / inbox 不是可导航的笔记，归档要先显式允许。
    // 与邻居侧的 `excludedNames` 同口径 —— 不能只有邻居过滤、种子随便进（plan §14.5）。
    const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isMetaPath(norm))
        return null;
    if (norm === 'raw' || norm.startsWith('raw/') || norm === 'inbox' || norm.startsWith('inbox/'))
        return null;
    if (!opts.includeArchived && inArchive(cfg, norm))
        return null;
    try {
        if (!fs.statSync(abs).isFile())
            return null;
    }
    catch {
        return null;
    }
    let title = '';
    try {
        title = String(parseFrontmatter(fs.readFileSync(abs, 'utf8')).fields.title ?? '');
    }
    catch { /* 标题只作回显 */ }
    return { title: title || path.basename(rel, path.extname(rel)), path: rel, absPath: abs };
}
/**
 * 种子解析：路径 / `[[路径]]` 只看磁盘（0 个子进程）；标题 / `[[id]]` 走一次 `zk list -M exact`（1 个子进程）。
 *
 * 为什么不用「全库扫描 + resolveWikiTarget」：10k 上那是一整趟 `zk list`（约 2.6 s / 2 MB），
 * 会把单种子 1 跳从 2 个进程抬到 3 个，与 R8 的成本口径（§11.3）不符。
 * `-M exact` 实测能命中 frontmatter 的 id 与标题，但它是「逐词精确」而不是「整串相等」
 * （`记忆预算` 会同时命中 `记忆预算的另一篇`），所以拿到候选后还要在 JS 里比对一次
 * id / 标题 / 文件名，对不上就当没找到 —— 不拿第一个命中冒充种子。
 */
async function resolveWalkSeed(cfg, raw, opts = {}, signal) {
    const target = walkSeedTarget(raw);
    if (!target)
        return null;
    if (looksLikePath(target)) {
        const candidates = /\.(md|markdown)$/i.test(target) ? [target] : [target, `${target}.md`];
        for (const candidate of candidates) {
            const hit = seedAt(cfg, candidate, opts);
            if (hit)
                return hit;
        }
        return null;
    }
    const args = [
        'list', '--quiet', '--no-pager', '--format', LEAN_TEMPLATE, '-d', LEAN_RECORD,
        '--limit', '5', '-M', 'exact', '-m', target,
    ];
    // 与邻居的排除口径一致：include_archived 时种子也可以是一篇归档笔记
    for (const name of excludedNames(cfg, { includeArchived: opts.includeArchived }))
        args.push('-x', name);
    const notes = parseLeanList(await zk(cfg, args, { signal }), cfg).notes;
    const wanted = normalizeTitle(target);
    const hit = notes.find((n) => n.id && n.id === target)
        ?? notes.find((n) => normalizeTitle(n.title) === wanted)
        ?? notes.find((n) => normalizeTitle(path.basename(n.path, path.extname(n.path))) === wanted);
    return hit ? { title: hit.title || path.basename(hit.path, path.extname(hit.path)), path: hit.path, absPath: hit.absPath } : null;
}
/**
 * R8：从一篇种子出发走一跳（按篇反查，不建全图）。
 *
 * 成本：路径种子 = `both` 2 个子进程（backlinksOf + outlinksOf，10k 实测见 docs/bench-baseline.md）；
 * 标题 / id 种子再加一次 `-M exact` 解析（共 3 个）。`limit` 硬钳 `MAX_LINK_NOTES` = 200，
 * 不用 `MAX_SCAN` —— 后者配合 `--format json` 会吐 17 MB，等于把全图成本放回来。
 * 默认排除 archive / raw / meta（与 `excludedNames` 同口径）：邻居与**种子**两侧都过滤，
 * 不能只过滤一侧（plan §14.5）。
 *
 * 每条邻居多带 `section` / `linkLine`（那条边所在的小节与那一行）：
 * 入链用邻居 JSON 里已经在传输的 `rawContent`，出链读一次种子文件 —— 两边都是 **0 个额外子进程**。
 * 没有这两个字段，`lead` 对同一篇种子的所有出链是同一段文字，等于只给了 8 个标题（plan §14.1）。
 */
export async function walkFrom(cfg, opts, signal) {
    const direction = opts.direction ?? 'both';
    const limit = Math.min(MAX_LINK_NOTES, Math.max(1, Math.trunc(opts.limit ?? 10)));
    const seed = await resolveWalkSeed(cfg, opts.seed, { includeArchived: opts.includeArchived }, signal);
    if (!seed)
        return { seed: null, notes: [], truncated: false, completeness: 'complete' };
    const directions = direction === 'both' ? ['in', 'out'] : [direction];
    const notes = [];
    const seen = new Set();
    let truncated = false;
    // 出链的「那一行」写在种子里；入链的写在邻居里（JSON 里已经带了 rawContent）
    let seedContent = '';
    if (direction !== 'in') {
        try {
            seedContent = fs.readFileSync(seed.absPath, 'utf8');
        }
        catch {
            seedContent = '';
        }
    }
    for (const relation of directions) {
        const found = relation === 'in'
            ? await backlinksOf(cfg, seed.path, { limit, includeArchived: opts.includeArchived, keepContent: true }, signal)
            : await outlinksOf(cfg, seed.path, { limit, includeArchived: opts.includeArchived }, signal);
        if (found.truncated)
            truncated = true;
        for (const note of found.notes) {
            // 按身份键去重：互链的笔记两个方向都会出现，只报一次（先 in 后 out）
            const key = noteKey(note);
            if (seen.has(key))
                continue;
            seen.add(key);
            const ctx = relation === 'out'
                ? linkContextOf(seedContent, note, seed.path)
                : linkContextOf(found.contents?.get(note.path) ?? '', seed, note.path);
            notes.push({
                title: note.title, path: note.path, absPath: note.absPath, relation, lead: note.lead,
                ...(ctx ? { section: ctx.section, linkLine: ctx.line } : {}),
            });
        }
    }
    return { seed, notes, truncated, completeness: truncated ? 'partial' : 'complete' };
}
/**
 * `zk-kit query` 会被**丢掉**的参数：它们要么绕开「统一排除」，要么弄坏 JSON 解析。
 * 长名与短名都列出来（`--exclude` / `-x` 是同一个东西的两个写法）。
 */
const LIST_FLAGS_DROPPED = new Set([
    'notebook-dir', 'working-dir', 'format', 'exclude', 'no-input', 'no-pager', 'quiet', 'json', 'help',
    'f', 'x', 'W', 'P', 'q', 'h',
]);
const LIST_FLAGS_WITH_VALUE = new Set(['notebook-dir', 'working-dir', 'format', 'exclude', 'f', 'x', 'W']);
/** 过滤透传参数：把会破坏不变量的 flag 连同它的值一起丢掉，其余原样保留 */
export function sanitizeListArgs(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = String(argv[i] ?? '');
        if (!arg || arg === '--')
            continue;
        if (arg.startsWith('--')) {
            const name = arg.slice(2).split('=')[0];
            if (LIST_FLAGS_DROPPED.has(name)) {
                if (!arg.includes('=') && LIST_FLAGS_WITH_VALUE.has(name))
                    i++;
                continue;
            }
            out.push(arg);
            continue;
        }
        // 负数是参数值（如 --created-after 之后），不是短 flag
        if (arg.length > 1 && arg[0] === '-' && !/^-\d/.test(arg)) {
            const name = arg[1];
            if (LIST_FLAGS_DROPPED.has(name)) {
                if (arg.length === 2 && LIST_FLAGS_WITH_VALUE.has(name))
                    i++;
                continue;
            }
        }
        out.push(arg);
    }
    return out;
}
/**
 * `zk list` 的透传入口（人终端用）。排除项与 format 在这里注入，不交给调用方。
 *
 * 0 命中且给了 `-m` 时退回正则（`-M re`）：FTS5 不切中文，不兜底的话
 * `query -m 中文短语` 会静默返回空（Z12，和 searchNotes 同一个坑）。
 * 用户自己写了 `-M` 就尊重用户的选择，不覆盖。
 */
export async function queryNotes(cfg, argv, signal) {
    const passthrough = sanitizeListArgs(argv);
    const base = ['list', '--quiet', '--no-pager', '--format', 'json'];
    for (const name of excludedNames(cfg))
        base.push('-x', name);
    const runOnce = async (extra) => parseList(await zk(cfg, [...base, ...passthrough, ...extra], { signal })).map((raw) => toRecord(raw, cfg));
    const hasMatch = passthrough.some((a) => a === '-m' || a === '--match' || a.startsWith('--match=') || a.startsWith('-m='));
    const hasStrategy = passthrough.some((a) => a === '-M' || a === '--match-strategy' || a.startsWith('--match-strategy=') || a.startsWith('-M='));
    const hits = await runOnce([]);
    if (hits.length === 0 && hasMatch && !hasStrategy)
        return await runOnce(['-M', 're']);
    return hits;
}
/** 路径 → 绝对路径；出笔记本直接拒绝 */
export function absPathOf(cfg, p) {
    const raw = String(p ?? '').trim();
    if (!raw)
        throw new ZkError('路径不能为空', undefined, 'bad-path');
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cfg.notebook, raw);
    const nb = path.resolve(cfg.notebook);
    if (abs !== nb && !abs.startsWith(nb + path.sep)) {
        throw new ZkError(`路径不在笔记本里：${p}`, '只允许读写 ' + nb + ' 下面的文件', 'outside');
    }
    // .zk/ 是 zk 自己的索引与配置：读没意义，写会直接把笔记本搞坏
    const rel = path.relative(nb, abs);
    if (rel === '.zk' || rel.startsWith('.zk' + path.sep) || rel.startsWith('.zk/')) {
        throw new ZkError(`不能直接读写 zk 的内部文件：${p}`, '.zk/ 交给 zk 自己管理', 'outside');
    }
    return abs;
}
export function relPathOf(cfg, abs) {
    return path.relative(cfg.notebook, abs).split(path.sep).join('/');
}
/**
 * raw/ 是只读的原始材料，inbox/ 是被放弃的「待归类区」（P2-8）。
 * 两者都在 excludedNames 里，写进去不会报错、但会被排除出索引 —— 结果是
 * 「写了、没报错、但搜不到」，比直接失败更难查。所以在写入口就拦住。
 * 读不受影响：raw 里的材料照常 read；盘上已有的 inbox/ 原样保留。
 */
function assertWritablePath(cfg, abs) {
    const rel = relPathOf(cfg, abs);
    if (rel === 'raw' || rel.startsWith('raw/')) {
        throw new ZkError(`raw/ 是只读的原始材料，不能写：${rel}`, '结论写到 notes/，观察写进 daily；原始材料只在原位读，不改不搬');
    }
    if (rel === 'inbox' || rel.startsWith('inbox/')) {
        throw new ZkError(`inbox/ 是已停用的待归类区，写进去会被排除出索引：${rel}`, '直接写到目标目录（layered 下是 notes/sources 等 group）；盘上已有的 inbox/ 只读保留');
    }
}
/**
 * archive/ 只放 `supersede` 搬进去的旧结论（计划 §2 D6）：新建写进去不会报错，
 * 但 archive 在 excludedNames 里 —— 笔记会从检索、统计、反链里全部消失。
 * 只有 supersede 能往 archive 里搬：`zk_rename` 改名进 archive 是另一条既有守卫
 * （见 renameNote），这里只拦「新建」。
 */
export function assertNotArchiveCreate(cfg, rel) {
    const clean = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const target = clean(rel);
    const archive = clean(cfg.archiveDir);
    if (!archive)
        return;
    if (target === archive || target.startsWith(archive + '/')) {
        throw new ZkError(`${archive}/ 只放 supersede 搬进去的废弃笔记，不能新建：${target || archive}`, `新笔记请写 ${cfg.notesDir}/ 或 ${cfg.dailyDir}/；要归档旧结论用 zk_supersede`);
    }
}
/**
 * 根目录 meta 文件是人的工作面：新建 / 链接 / 废弃都会绕过 zk_append 的守卫，
 * 让「谁改的记忆」失去审计线，甚至能把 MEMORY.md 搬进 archive/。
 * 子目录里的同名文件仍是普通笔记，不受影响。
 */
function assertNotMeta(cfg, abs, action) {
    const rel = relPathOf(cfg, abs);
    if (!isMetaPath(rel))
        return;
    throw new ZkError(`${rel} 是 meta 文件，不能${action}`, `${META_NAMES.join(' / ')} 由人和 agent 直接编辑；子目录里的同名文件是普通笔记`);
}
function noteFromDisk(cfg, abs) {
    const content = fs.readFileSync(abs, 'utf8');
    const stat = fs.statSync(abs);
    const heading = content.match(/^#\s+(.+)$/m);
    const tags = [...content.matchAll(new RegExp(HASHTAG_SRC, 'gu'))].map((m) => m[1]);
    const fields = parseFrontmatter(content).fields;
    return {
        title: heading ? heading[1].trim() : path.basename(abs, path.extname(abs)),
        path: relPathOf(cfg, abs),
        absPath: abs,
        link: '',
        tags: [...new Set(tags)],
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        lead: '',
        snippet: '',
        summary: summarizeContent(content),
        words: content.split(/\s+/).filter(Boolean).length,
        metadata: { ...fields },
        id: fields.id ?? '',
        status: fields.status ?? '',
        type: fields.type ?? '',
        authority: fields.authority ?? '',
        content,
        chars: content.length,
    };
}
/** 按路径读一篇（路径可以是相对笔记本的，也可以是笔记本内的绝对路径） */
export async function readNote(cfg, p, signal) {
    const abs = absPathOf(cfg, p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        throw new ZkError(`笔记不存在：${p}`, undefined, 'not-found');
    let record = null;
    try {
        const rel = relPathOf(cfg, abs);
        const found = await searchNotes(cfg, { paths: [rel], limit: 20 }, signal);
        record = found.find((n) => path.resolve(n.absPath || n.path) === abs) ?? null;
    }
    catch { /* 索引坏了也不耽误直接读文件 */ }
    const doc = noteFromDisk(cfg, abs);
    if (!record)
        return doc;
    return { ...doc, ...record, content: doc.content, chars: doc.chars, title: record.title || doc.title, tags: record.tags.length ? record.tags : doc.tags };
}
/** 按路径或搜索词找一篇 */
export async function findNote(cfg, query, signal) {
    const trimmed = query.trim();
    if (!trimmed)
        return null;
    const looksLikePath = trimmed.includes('/') || /\.(md|markdown|org|txt)$/i.test(trimmed);
    if (looksLikePath) {
        const abs = absPathOf(cfg, trimmed);
        if (fs.existsSync(abs))
            return readNote(cfg, trimmed, signal);
    }
    const [hit] = await searchNotes(cfg, { query: trimmed, limit: 1 }, signal);
    if (!hit)
        return null;
    return readNote(cfg, hit.absPath || hit.path, signal);
}
/** 文件名里不收的字符：路径分隔符 + Windows 非法字符（库会被同步到 Windows / 塞进 zip） */
const BAD_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
/**
 * 校验调用方给的文件名（只收 basename，不含扩展名）。
 *
 * 只管「能不能落成文件」：超过文件系统的 255 字节单段上限就是 ENAMETOOLONG，
 * 那行错误照着做不了，所以在这里换成一句能照做的。可读性好坏不归它判断。
 */
function normalizeNoteName(raw) {
    const name = String(raw ?? '').trim().replace(NOTE_EXT, '');
    if (!name)
        throw new ZkError('文件名不能为空', '不给 name 就由 zk 按标题生成；给了就要有内容');
    if (name === '.' || name === '..')
        throw new ZkError(`文件名不能是 ${name}`);
    if (name.startsWith('.'))
        throw new ZkError(`文件名不能以 . 开头：${name}`, '开头的点会被当成隐藏文件，去掉它');
    if (BAD_FILE_NAME.test(name)) {
        throw new ZkError(`文件名里有不能用的字符：${name}`, '只给文件名本身，不要 / \\ : * ? " < > |；换目录用 dir');
    }
    // 255 是单段上限，扩展名也算在里面（.md 占 3 字节）
    if (Buffer.byteLength(name) > 252) {
        throw new ZkError(`文件名太长：${Buffer.byteLength(name)} 字节`, '文件系统单段上限是 255 字节，缩到 252 字节以内（中文约 80 字）');
    }
    return name;
}
/**
 * 稳定 ID（§9.2）：10 位十六进制短随机串（40 bit，10⁴ 篇库的碰撞概率可忽略）。
 * 纯小写 hex，不会与路径 / `.md` 后缀 / 中文标题撞形，`[[id]]` 才认得出来。
 */
export function newNoteId() {
    return randomBytes(5).toString('hex');
}
/**
 * 用 zk new 建一篇（正文走 stdin → 模板里的 {{content}}）。
 *
 * 撞名（Z8）：`zk new` 遇到同名文件时 exit 0、**内容不写**、只回显路径 —— 不查就会静默丢内容。
 * 所以在建之前拍一张目录快照，建完发现文件名本来就有，直接报错（先写入的内容一个字没动，可以放心重试）。
 */
export async function createNote(cfg, input, signal, scan = (c, s) => allNotes(c, { includeArchived: true }, s)) {
    const title = input.title.trim();
    if (!title)
        throw new ZkError('标题不能为空');
    // 给了 name 就是确定的 basename：先校验，后面建完直接换名
    const wanted = input.name ? normalizeNoteName(input.name) : '';
    const dir = (input.dir ?? cfg.notesDir).replace(/^\/+/, '') || '.';
    // 一次全库扫描（含归档）干两件事：活笔记查重 + 归档同名提醒。
    // 以前是各跑一次 `zk list`：同一个库扫两遍，还多起一个进程。
    const dupCheck = cfg.structure !== 'layered';
    let archived = [];
    let similar = [];
    let snapshot = null;
    if (hasNotebook(cfg)) {
        try {
            snapshot = await scan(cfg, signal);
        }
        catch (err) {
            // flat 的标题查重是写入前的硬门槛（不查就会静默丢正文），扫描失败必须 fail-closed；
            // layered 的同名由 zk 自己拒，归档提醒只是附加信息 —— 扫不动就照建，宁可少一条提醒。
            if (dupCheck)
                throw err;
        }
        if (snapshot) {
            // flat 用的是 zk 默认的随机 {{id}} 文件名，按文件名查重永远不会命中；标题重复必须在建之前查。
            // layered 的 group 用 {{slug title}}，同一目录同名会被 zk 自己拒绝；不同目录允许同名（lint 会提示）。
            // 只查可见笔记：归档里的旧结论不参与查重，可以复用标题。
            if (dupCheck) {
                const key = normalizeTitle(title);
                const existing = snapshot.find((n) => !inArchive(cfg, n.path) && normalizeTitle(n.title) === key);
                if (existing) {
                    throw new ZkError(`同名笔记已存在：${existing.path}`, '换一个标题，或直接用 read / edit 改那一篇；归档里的旧结论不参与查重，可以复用标题');
                }
            }
            else if (wanted) {
                // 给了 name 的 layered 笔记不走 zk 的 slug 撞名（文件名和标题脱钩，同名不会被拒），
                // 所以按标题在同目录下补一道 —— 口径和 lint 的 duplicateTitles 一致。
                const key = normalizeTitle(title);
                const dirKey = dir.replace(/\/+$/, '');
                const existing = snapshot.find((n) => !inArchive(cfg, n.path)
                    && path.posix.dirname(n.path) === dirKey
                    && normalizeTitle(n.title) === key);
                if (existing) {
                    throw new ZkError(`同目录下已有同名笔记：${existing.path}`, '换一个标题，或直接用 read / edit 改那一篇');
                }
            }
            archived = archivedHits(cfg, snapshot, title);
        }
    }
    // zk 解析相对目录用的是 cwd，不是笔记本 → 一律给绝对路径；
    // 先过 absPathOf：别在 zk 拒绝之前就把 `../..` 目录 mkdir 出去。
    const dirAbs = absPathOf(cfg, dir);
    assertNotArchiveCreate(cfg, relPathOf(cfg, dirAbs));
    assertWritablePath(cfg, dirAbs);
    // name 是确定的：先按默认扩展名预判，别等 zk 建出根目录 meta 文件
    if (wanted)
        assertNotMeta(cfg, path.join(dirAbs, `${wanted}.md`), '新建');
    fs.mkdirSync(dirAbs, { recursive: true });
    const before = new Set(fs.readdirSync(dirAbs));
    // name 是确定的，撞名在建之前就能查出来：zk 撞名是 exit 0 + 丢正文，不能等它
    const clash = wanted && [...before].find((f) => path.basename(f, path.extname(f)) === wanted);
    if (clash) {
        throw new ZkError(`同名笔记已存在：${dir === '.' ? '' : dir + '/'}${clash}`, '换一个 name，或直接用 read / edit 改那一篇');
    }
    const args = ['new', dirAbs, '-t', title, '-i', '-p'];
    if (input.group)
        args.push('-g', input.group);
    // 只在真给了 type/authority 时才传：flat 的 daily/notes 模板没有 {{extra.*}}，多传无害但没必要
    if (input.type)
        args.push('--extra', `type=${input.type}`);
    if (input.authority)
        args.push('--extra', `authority=${input.authority}`);
    const stdout = await zk(cfg, args, { signal, input: input.content ?? '' });
    const last = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    if (!last)
        throw new ZkError('zk new 没有返回笔记路径');
    const abs = path.isAbsolute(last) ? last : path.resolve(cfg.notebook, last);
    if (!fs.existsSync(abs))
        throw new ZkError(`zk 说建好了但文件不存在：${abs}`);
    // 扩展名被用户改成 .markdown 等时，预判可能漏掉；这里再兜一次（只删本次新建的文件）
    const createdRel = relPathOf(cfg, abs);
    // 相似标题（P2）：按**实际落下的目录**比同目录标题（layered 不给 dir 时由 type / group 决定）。
    // 只提示、不阻断 —— 精确同名在上面已经报错；口径与 zk_lint 的 similarTitles 同一份实现。
    if (snapshot) {
        similar = similarCandidates(snapshot.filter((n) => !inArchive(cfg, n.path)), title, path.posix.dirname(createdRel));
    }
    if (isMetaPath(createdRel)) {
        if (!before.has(path.basename(abs))) {
            try {
                fs.rmSync(abs, { force: true });
            }
            catch { /* 删不掉也拦下 */ }
        }
        throw new ZkError(`${createdRel} 是 meta 文件，不能新建`, `${META_NAMES.join(' / ')} 由人和 agent 直接编辑；子目录里的同名文件是普通笔记`);
    }
    if (before.has(path.basename(abs))) {
        throw new ZkError(`同名笔记已存在：${relPathOf(cfg, abs)}`, '同名时 zk 不覆盖（这次传入的正文被丢弃了，原文件一个字都没动）。换个标题，或直接用 read / edit 改那一篇');
    }
    // name 只换 basename、不换目录：正文里的相对链接和 [[stem]] 都不受影响，所以这里是纯搬文件。
    // 跨目录改名要重写入链，那是 zk_rename / renameNote 的活，不走这条路。
    let finalAbs = abs;
    if (wanted && path.basename(abs, path.extname(abs)) !== wanted) {
        const targetAbs = path.join(path.dirname(abs), wanted + (path.extname(abs) || '.md'));
        try {
            fs.renameSync(abs, targetAbs);
        }
        catch (err) {
            throw new ZkError(`笔记已建好，但改文件名失败：${err instanceof Error ? err.message : String(err)}`, `文件还在 ${relPathOf(cfg, abs)}，可以直接改文件名，或删掉重来`);
        }
        finalAbs = targetAbs;
        // 索引里还是 zk 生成的那个文件名：不刷新的话，紧接着的 search / stats 会读到旧路径
        await refreshIndexQuietly(cfg, signal);
    }
    // 摘要只能建完之后补：模板里 `## Summary` 天生是空的，`{{content}}` 又落在它下面 —— body 写不进这一节
    let summaryApplied = false;
    let summaryWarning;
    if (input.summary?.trim()) {
        try {
            const text = fs.readFileSync(finalAbs, 'utf8');
            const filled = fillSummary(text, input.summary);
            summaryApplied = filled.applied;
            if (filled.text !== text) {
                fs.writeFileSync(finalAbs, filled.text, 'utf8');
                markIndexDirty(cfg); // zk new 索引的是回填前的文件；摘要要等下一次 index 才搜得到
            }
            if (!filled.applied) {
                summaryWarning = 'summary 没写进去：正文里已经有一节 Summary（没覆盖它），要改就直接编辑那一节';
            }
        }
        catch (err) {
            // 笔记已经建好：收尾失败只降级成告警，别让人以为这次写入整个失败了
            summaryWarning = `summary 没写进去：${err instanceof Error ? err.message : String(err)}（文件已建好，可以直接编辑那一节）`;
        }
    }
    // 稳定 ID（§9.2）：只给 zk_new 新建的笔记写 id，老笔记 / 日记不回填。
    // 建完才写：zk new -i 索引的是模板产物，改了文件就得标脏，让下一次读补索引（R6）。
    // 收尾失败一律吞掉（同 markIndexDirty）：笔记已经建好，不能让一次 id 写入看起来像整次创建失败。
    try {
        const text = fs.readFileSync(finalAbs, 'utf8');
        if (!parseFrontmatter(text).fields.id) {
            fs.writeFileSync(finalAbs, setFrontmatter(text, { id: newNoteId() }), 'utf8');
            markIndexDirty(cfg);
        }
    }
    catch { /* 收尾失败：文件已落盘，不回滚、不误导 */ }
    // 模板内容槽空着（正文自己起了 `##`）：这是 `{{content}}` 落在 `## Content` 下面的必然形状。
    // 只报告、不改正文 —— 与 fillSummary 的「只填不删」同一原则；判定在 lib/sections.ts，lint 共用。
    let emptyTemplateSections = [];
    try {
        emptyTemplateSections = emptyTemplateSlots(fs.readFileSync(finalAbs, 'utf8')).map((slot) => slot.heading);
    }
    catch { /* 收尾失败：文件已落盘，不回滚 */ }
    return {
        path: relPathOf(cfg, finalAbs),
        absPath: finalAbs,
        title,
        archived,
        similar,
        summaryApplied,
        summaryWarning,
        emptyTemplateSections,
    };
}
/** 笔记本相对路径是否在归档目录下（supersede 会把文件搬进去，路径保持不变） */
function inArchive(cfg, rel) {
    return rel === cfg.archiveDir || rel.startsWith(`${cfg.archiveDir}/`);
}
/**
 * 归档里同名的旧结论 —— 机械查重，不判断「是不是同一个错误」。
 *
 * zk_new 的标题查重只看活笔记，旧结论被 supersede 后标题就空出来了。允许复用，
 * 但要把 supersede-reason 一起带出来：重新提出同样的错误结论，通常从复用这个标题开始。
 * 输入是 createNote 建之前那一次全库快照：纯内存计算，不再单独跑一次 zk。
 */
function archivedHits(cfg, notes, title) {
    const key = normalizeTitle(title);
    if (!key)
        return [];
    return notes
        .filter((n) => inArchive(cfg, n.path))
        .filter((n) => normalizeTitle(n.title) === key)
        .map((n) => ({
        path: n.path,
        title: n.title,
        reason: String(n.metadata['supersede-reason'] ?? '').trim(),
    }));
}
/**
 * `## 名称` 小节的正文范围（行号，右开）：从标题下一行到下一个一/二级标题之前。
 * 没有这一节返回 null —— 调用方退回「追加到文件末尾」。
 */
function sectionRange(content, name) {
    const lines = content.split('\n');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const heading = new RegExp(`^##\\s+${escaped}\\s*$`, 'i');
    const start = lines.findIndex((line) => heading.test(line));
    if (start < 0)
        return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^#{1,2}\s+\S/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return { start: start + 1, end };
}
/** 行内 ATX 标题：`## 名称`（收尾井号算装饰，不进食标题） */
function atxHeading(line) {
    const m = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
    if (!m)
        return null;
    const title = m[2].replace(/[ \t]+#+$/, '').trim();
    return title ? { level: m[1].length, title } : null;
}
/** `## Summary` / `## 摘要` 都算摘要节：写入（fillSummary）与读回（summarizeContent）共用同一口径 */
function isSummaryTitle(title) {
    return /^(summary|摘要)$/i.test(title.trim());
}
/**
 * 15.6：从正文取一句话摘要，只读不改。
 * frontmatter 的 `summary` 标量优先；否则读 `## Summary` 一节，取到下一个同级 / 更高级标题之前，
 * 首段压空白、截到 240 字。没有这一节 / 读不到就返回空串（老笔记不假装有摘要）。
 */
export function summarizeContent(content) {
    const fromMeta = String(parseFrontmatter(content).fields.summary ?? '').replace(/\s+/g, ' ').trim();
    if (fromMeta)
        return fromMeta.slice(0, 240);
    const lines = String(content ?? '').split('\n');
    const fenced = fenceMask(lines);
    const heads = lines.map((line, i) => (fenced[i] ? null : atxHeading(line)));
    const target = heads.findIndex((h) => h !== null && isSummaryTitle(h.title));
    if (target < 0)
        return '';
    const head = heads[target];
    let end = lines.length;
    for (let i = target + 1; i < lines.length; i += 1) {
        const next = heads[i];
        if (next && next.level <= head.level) {
            end = i;
            break;
        }
    }
    return lines.slice(target + 1, end).join('\n').replace(/\s+/g, ' ').trim().slice(0, 240);
}
/**
 * 15.6：给一批**已可见**的命中补 `summary`。逐条 `readFileSync` 是本地文件 IO、不是子进程，
 * 不改 LEAN 模板、不落索引、不给全库扫描用 —— 只挂在检索结果的出口（O(limit)）。
 * 已有非空 summary 的行直接跳过，避免只读视图对同一批结果重复读盘。
 */
export function attachSummaries(cfg, notes) {
    return notes.map((n) => {
        if (n.summary)
            return n;
        const abs = n.absPath || (n.path ? path.resolve(cfg.notebook, n.path) : '');
        if (!abs)
            return n;
        try {
            return { ...n, summary: summarizeContent(fs.readFileSync(abs, 'utf8')) };
        }
        catch {
            return n;
        }
    });
}
/**
 * 把一句话摘要填进 `## Summary`。
 *
 * 模板里这一节天生是空的，之前没有任何写入路径能填它 —— `{{content}}` 落在 `## Content` 下面，
 * 摘要只能靠人事后手写。这里补上落点，三种情况：
 *   · 有空着的 `## Summary`（模板）→ 填进去；
 *   · 没有这一节（flat 的笔记只有 `# 标题`）→ 在一级标题下面补一节；
 *   · 已经有内容（正文自己写了 Summary）→ 一个字不动，返回 applied=false 让调用方去提醒。
 *
 * 只填不删：正文里多写了一节 `## Content` 属于排版噪音，交给调用方去提醒，不在这里静默改正文。
 */
export function fillSummary(content, summary) {
    // 摘要是一段话：换行会在小节里长出第二段，压成一行
    const body = String(summary ?? '').replace(/\s+/g, ' ').trim();
    if (!body)
        return { text: content, applied: false };
    const lines = String(content ?? '').split('\n');
    const fenced = fenceMask(lines);
    const heads = lines.map((line, i) => (fenced[i] ? null : atxHeading(line)));
    const target = heads.findIndex((h) => h !== null && isSummaryTitle(h.title));
    if (target >= 0) {
        const head = heads[target];
        let end = lines.length;
        for (let i = target + 1; i < lines.length; i += 1) {
            const next = heads[i];
            if (next && next.level <= head.level) {
                end = i;
                break;
            }
        }
        if (lines.slice(target + 1, end).some((line) => line.trim() !== ''))
            return { text: content, applied: false };
        // 正文自己又写了一份 Summary（模板那一节只是空壳）：那一节已经有主，不覆盖、也不在旁边再长一节
        const writtenByContent = heads.some((h, k) => k >= end && h !== null && h.level === head.level && isSummaryTitle(h.title));
        if (writtenByContent)
            return { text: content, applied: false };
        const out = [...lines.slice(0, target + 1), '', body, '', ...lines.slice(end)];
        return { text: endDoc(out), applied: true };
    }
    // flat / 自定义模板：一级标题下面补一节；没有一级标题就不猜位置
    const h1 = heads.findIndex((h) => h !== null && h.level === 1);
    if (h1 < 0)
        return { text: content, applied: false };
    const rest = lines.slice(h1 + 1);
    while (rest.length && rest[0].trim() === '')
        rest.shift();
    return { text: endDoc([...lines.slice(0, h1 + 1), '', '## Summary', '', body, '', ...rest]), applied: true };
}
/** 结尾只留一个换行（拼完可能多出空行，文件末尾的连续空白没有意义） */
function endDoc(lines) {
    return lines.join('\n').replace(/\n+$/, '\n');
}
/**
 * 往一篇笔记追加（自动补空行；可选先写一个二级标题）。
 *
 * `section` 给了且笔记里有这一节时，追加到该节末尾，标题降为三级 —— 日记模板的
 * `## Events` 是正文位置，同级的 `## HH:MM` 会把条目顶成兄弟小节，反而落到
 * `## Loose ends` 之后。没有这一节（flat 日记 / 用户自定义日记）就仍旧追加到末尾。
 */
export function appendToNote(cfg, p, text, opts = {}) {
    const abs = absPathOf(cfg, p);
    if (!fs.existsSync(abs))
        throw new ZkError(`笔记不存在：${p}`);
    assertWritablePath(cfg, abs);
    // meta 文件是人的工作面：追加会把它变成流水账，也让「记忆被谁改的」失去审计线索
    if (isMetaPath(relPathOf(cfg, abs))) {
        throw new ZkError(`${relPathOf(cfg, abs)} 是 meta 文件，不能用 zk_append 追加`, `${META_NAMES.join(' / ')} 请直接编辑（整篇重写，git diff 可审）`);
    }
    const body = String(text ?? '').trim();
    if (!body)
        throw new ZkError('追加内容不能为空');
    const current = fs.readFileSync(abs, 'utf8');
    // 标题只占一行：换行会把后面的正文顶出小节
    const title = opts.heading ? opts.heading.replace(/\s+/g, ' ').trim() : '';
    const range = opts.section ? sectionRange(current, opts.section) : null;
    if (range) {
        const lines = current.split('\n');
        const parts = [
            lines.slice(0, range.start).join('\n'),
            lines.slice(range.start, range.end).join('\n'),
            `${title ? `### ${title}\n\n` : ''}${body}`,
            lines.slice(range.end).join('\n'),
        ].map((part) => part.trim()).filter(Boolean);
        fs.writeFileSync(abs, `${parts.join('\n\n')}\n`, 'utf8');
    }
    else {
        const sep = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
        const heading = title ? `## ${title}\n\n` : '';
        fs.appendFileSync(abs, `${sep}${heading}${body}\n`, 'utf8');
    }
    const bytes = fs.statSync(abs).size;
    markIndexDirty(cfg);
    return { path: relPathOf(cfg, abs), appendedChars: body.length, bytes };
}
/**
 * 确保「今天的日记」存在，返回它的路径。
 * created 用目录快照判断（zk 的日期模板不让我们预先算文件名，但可以对比前后）。
 */
export async function ensureDailyNote(cfg, opts = {}, signal) {
    const dirAbs = path.resolve(cfg.notebook, cfg.dailyDir);
    fs.mkdirSync(dirAbs, { recursive: true });
    const before = new Set(fs.readdirSync(dirAbs));
    const args = ['new', dirAbs, '-p'];
    if (cfg.dailyGroup)
        args.push('-g', cfg.dailyGroup);
    if (opts.date)
        args.push('--date', opts.date);
    const stdout = await zk(cfg, args, { signal });
    const last = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    if (!last)
        throw new ZkError('zk new 没有返回日记路径');
    const abs = path.isAbsolute(last) ? last : path.resolve(cfg.notebook, last);
    const created = !before.has(path.basename(abs));
    return { path: relPathOf(cfg, abs), absPath: abs, created };
}
/**
 * 往日记里追加一段（layered 模板写进 `## Events` 的 `### HH:MM`，
 * flat 模板仍是文件末尾的 `## HH:MM`）
 */
export function appendDaily(cfg, p, entry, now = new Date()) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return appendToNote(cfg, p, entry, { heading: `${hh}:${mm}`, section: 'Events' });
}
const NOTE_EXT = /\.(md|markdown|org|txt)$/i;
/** 相对笔记本、去掉扩展名的路径 —— 也就是 zk 双链里写的那一段（Z11） */
export function linkStemOf(cfg, abs) {
    return relPathOf(cfg, abs).replace(NOTE_EXT, '');
}
/** 在 from 里加一条指向 to 的 wiki 双链（重复就跳过） */
export async function linkNotes(cfg, fromPath, target, signal) {
    const fromAbs = absPathOf(cfg, fromPath);
    if (!fs.existsSync(fromAbs))
        throw new ZkError(`笔记不存在：${fromPath}`);
    assertWritablePath(cfg, fromAbs);
    assertNotMeta(cfg, fromAbs, '作为链接来源');
    const targetDoc = await findNote(cfg, target, signal);
    if (!targetDoc) {
        // 目标必须存在：写一条指向空气的 `[[…]]` 只会变成断链，还不如当场报错并给出最像的几篇
        let hints = [];
        try {
            hints = (await searchNotes(cfg, { query: target, limit: 3 }, signal)).map((n) => `${n.title}（${n.path}）`);
        }
        catch { /* 索引不可用就只报错 */ }
        throw new ZkError(`找不到要链接的笔记：${target}`, hints.length ? `是不是想链：${hints.join('、')}` : '先用 zk_search 查一下标题，或用 zk_new 把它建出来');
    }
    const targetAbs = absPathOf(cfg, targetDoc.absPath || targetDoc.path);
    assertNotMeta(cfg, targetAbs, '作为链接目标');
    if (targetAbs === fromAbs)
        throw new ZkError('不能链接自己', '换一个目标笔记');
    const stem = linkStemOf(cfg, targetAbs);
    const link = `[[${stem}]]`;
    const source = fs.readFileSync(fromAbs, 'utf8');
    if (source.includes(link)) {
        return { from: relPathOf(cfg, fromAbs), to: relPathOf(cfg, targetAbs), link, added: false };
    }
    const sep = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    // 小节标题统一用 `## Links`；旧笔记里已有的 `## 链接` 照用，不追加第二个小节
    const heading = /^##\s+(?:Links|链接)\s*$/m.test(source) ? '' : '## Links\n\n';
    fs.appendFileSync(fromAbs, `${sep}${heading}- ${link}\n`, 'utf8');
    markIndexDirty(cfg);
    return { from: relPathOf(cfg, fromAbs), to: relPathOf(cfg, targetAbs), link, added: true };
}
export async function notebookStats(cfg, signal) {
    const exclude = excludedNames(cfg).flatMap((name) => ['-x', name]);
    const count = async (args) => {
        const out = await zk(cfg, ['list', '--quiet', '--no-pager', '--format', '{{path}}', ...exclude, ...args], { signal });
        return out.split('\n').filter((l) => l.trim()).length;
    };
    // 一次全库（含归档）拿全：笔记数 / 标签 / 归档数 / superseded 都从这份算。
    // 以前是「多跑一次 list 数笔记 + 递归扫 archive 再逐篇读全文看 status」——
    // 归档一大，光数个数就要把整片归档读一遍磁盘。
    //
    // 三次查询必须串行：索引脏时每个 zk 进程都会自己去重扫（.zk/notebook.db），
    // 并发的进程会互相看到对方写到一半的结果，同一次统计里「归档」和「活跃」就对不上。
    const brokenLinks = await count(['--broken-links']);
    const orphans = await count(['--orphan']);
    const scan = await scanNotes(cfg, { includeArchived: true }, signal);
    const all = scan.notes;
    const live = all.filter((n) => !inArchive(cfg, n.path));
    // 标签数只从可见笔记汇总：zk tag list 没有 -x，直接用它会把 raw/inbox/archive/meta 的标签也算进来。
    return {
        notes: live.length,
        tags: new Set(live.flatMap((n) => n.tags)).size,
        brokenLinks,
        orphans,
        archived: all.length - live.length,
        // 含已归档的，以及手工标了但没搬进 archive 的（正常流程会搬，这里兜手滑）
        superseded: all.filter((n) => n.status === 'superseded').length,
        ...distributionOf(live),
        completeness: scan.completeness,
        scanLimit: scan.limit,
    };
}
/**
 * 目录 / 标签分布（P2-11）：静态 INDEX.md 会过期，实时分布不需要第二份真相。
 * 数据来自已经载入的 live，不新增 zk 进程。
 */
function distributionOf(live) {
    const dirs = new Map();
    const tags = new Map();
    for (const note of live) {
        const top = note.path.includes('/') ? note.path.slice(0, note.path.indexOf('/')) : '.';
        dirs.set(top, (dirs.get(top) ?? 0) + 1);
        for (const tag of note.tags)
            tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    const byDir = [...dirs]
        .map(([dir, count]) => ({ dir, count }))
        .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
    const byTag = [...tags]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, 10);
    return { byDir, byTag };
}
/**
 * 显式重建（设置页「重建索引」/ `zk-kit index`）：走建库预算（30 min），不再 120 s 杀掉。
 * 进程内已有后台建库时直接等它；跨进程先抢 `dsh-index.lock`，抢不到就不起第二个 zk 进程
 * （并发两个只会撞 SQLite 写锁）。`lockWaitMs` 只给显式重建用：写路径（refreshIndexQuietly）
 * 不应该把自己卡在别人的建库上。
 * 锁建不出来（权限 / 磁盘）时退回旧行为直接建：显式重建不能因为拿不到锁而失败。
 */
export async function indexNotebook(cfg, signal, opts = {}) {
    const running = builds.get(cfg.notebook);
    if (running) {
        await running.promise;
        return;
    }
    const loc = await requireZk(cfg);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const acquired = tryAcquireIndexLock(cfg);
        if (acquired.kind === 'failed') {
            await startIndexBuild(cfg, loc, signal).promise;
            return;
        }
        if (acquired.kind === 'acquired') {
            await startIndexBuild(cfg, loc, signal, acquired.lock).promise;
            return;
        }
        // 别的进程在建：等它放开，不并发起第二个 zk index
        const released = await waitForIndexLockRelease(cfg, signal, opts.lockWaitMs ?? indexPolicy.lockWaitMs);
        if (released)
            return;
    }
    throw new ZkError('另一个进程正在建索引，这次不另起一个 zk index', `已等了 ${Math.round((opts.lockWaitMs ?? indexPolicy.lockWaitMs) / 1000)} 秒；过一会儿再试，或等它建完（索引状态可在设置页看）`, 'index-building');
}
/**
 * 我们自己动过文件（改名 / 搬归档）之后补一次增量索引。
 *
 * 不补的话索引就是脏的：脏索引下每个 zk 进程都会自己去重扫，并起来就互相打架
 * （zk_stats 会在自己的三次查询之间看到不一致的归档数）。索引只是缓存，
 * 刷新失败不该把「已经落盘的改名」变成一句报错，所以这里吞掉异常。
 */
async function refreshIndexQuietly(cfg, signal) {
    // 先标脏再补：补失败（zk 不在 / 撞锁）时标记还在，下一次读者会重试，而不是永久留一份旧索引
    markIndexDirty(cfg);
    try {
        await indexNotebook(cfg, signal);
    }
    catch { /* 下一个读者会自己重扫，最坏只是那一次读到旧路径 */ }
}
/**
 * 指向某篇笔记的所有来源笔记（相对路径）—— 按篇反查（`--link-to`），不建全图。
 *
 * 只关心一篇笔记的入链时，全图要 26–31 s（10k），反查 0.4 s；rename / supersede
 * 是写路径，更不该为了一次改名付全库的代价。
 * 上限按 `MAX_SCAN`：入链超过 1 万条的笔记不存在，真触顶说明索引坏了。
 */
async function inboundSources(cfg, rel, signal, opts = {}) {
    const found = await backlinksOf(cfg, rel, { includeArchived: opts.includeArchived, limit: MAX_SCAN }, signal);
    return found.notes.map((n) => n.path);
}
/**
 * 废弃一篇笔记：标 status → 重写入链 → 搬进 archive/（保留原相对路径）。
 *
 * 为什么必须重写入链（Z11）：双链是路径式的，文件一 move 全部入链即断。
 * 顺序：先改入链（指向将来的归档路径）→ 再改自己的 frontmatter → 最后 rename；
 * 正常路径下可重放：第二次调用看到 status 已是 superseded 就直接返回。
 * 例外：frontmatter 已写、rename 失败时，重试会直接返回，需要人工把文件搬进 archive/。
 * 索引不用手动重建（Z11：zk 下次运行时自己追平），但调用方不要在同一次里依赖旧 targetId。
 */
export async function supersedeNote(cfg, opts, signal) {
    const dryRun = opts.dryRun !== false;
    const reason = normalizeReason(opts.reason);
    const abs = absPathOf(cfg, opts.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        throw new ZkError(`笔记不存在：${opts.path}`);
    assertWritablePath(cfg, abs);
    const rel = relPathOf(cfg, abs);
    assertNotMeta(cfg, abs, '废弃');
    const content = fs.readFileSync(abs, 'utf8');
    const fields = parseFrontmatter(content).fields;
    const inArchive = rel === cfg.archiveDir || rel.startsWith(`${cfg.archiveDir}/`);
    if (fields.status === 'superseded') {
        return {
            dryRun,
            performed: false,
            alreadySuperseded: true,
            path: rel,
            archivePath: inArchive ? rel : `${cfg.archiveDir}/${rel}`,
            supersededBy: fields['superseded-by'] ?? null,
            reason: fields['supersede-reason'] ?? null,
            rewrittenLinks: [],
            missingLinks: [],
        };
    }
    if (inArchive) {
        throw new ZkError(`这篇已经在归档目录里，但 status 不是 superseded：${rel}`, '归档区里只放废弃笔记；先确认它的 status，别在这里反复挪');
    }
    // ── 替代者：必须存在、必须还活着 ──────────────────────────────────
    let byStem = null;
    const by = opts.by?.trim();
    if (by) {
        const target = await findNote(cfg, by, signal);
        if (!target)
            throw new ZkError(`找不到替代笔记：${by}`, '先把它建出来，再把 by 指向它');
        const targetAbs = absPathOf(cfg, target.absPath || target.path);
        assertNotMeta(cfg, targetAbs, '作为替代笔记');
        if (targetAbs === abs)
            throw new ZkError('替代笔记不能是它自己');
        if (target.path === cfg.archiveDir || target.path.startsWith(`${cfg.archiveDir}/`)) {
            throw new ZkError(`替代笔记自己就在归档里：${target.path}`, '用一篇还活着的笔记当接班人');
        }
        const targetStatus = parseFrontmatter(fs.readFileSync(targetAbs, 'utf8')).fields.status;
        if (targetStatus === 'superseded') {
            throw new ZkError(`替代笔记自己也是 superseded：${target.path}`, '先把那条链理顺，别把废弃指向废弃');
        }
        byStem = linkStemOf(cfg, targetAbs);
    }
    const archivePath = `${cfg.archiveDir}/${rel}`;
    const archiveAbs = path.join(cfg.notebook, archivePath);
    if (fs.existsSync(archiveAbs)) {
        throw new ZkError(`归档位置已被占用：${archivePath}`, '先处理掉那个文件，否则 rename 会把它覆盖');
    }
    // ── 入链：只改能精确匹配 `[[旧路径]]` 的那些 ──────────────────────
    const oldStem = linkStemOf(cfg, abs);
    const newStem = archivePath.replace(NOTE_EXT, '');
    const rewrittenLinks = [];
    const missingLinks = [];
    for (const source of await inboundSources(cfg, rel, signal)) {
        const sourceAbs = path.join(cfg.notebook, source);
        let text;
        try {
            text = fs.readFileSync(sourceAbs, 'utf8');
        }
        catch {
            continue;
        }
        const replaced = text.split(`[[${oldStem}]]`).length - 1;
        if (replaced === 0) {
            missingLinks.push(source);
            continue;
        }
        rewrittenLinks.push({ path: source, replaced });
        if (!dryRun)
            fs.writeFileSync(sourceAbs, text.split(`[[${oldStem}]]`).join(`[[${newStem}]]`), 'utf8');
    }
    if (!dryRun) {
        const patch = {
            status: 'superseded',
            'superseded-by': byStem ? `[[${byStem}]]` : undefined,
        };
        // JSON.stringify = 合法的 YAML 双引号标量：原因里带冒号也不会把 frontmatter 写坏
        if (reason)
            patch['supersede-reason'] = JSON.stringify(reason);
        fs.writeFileSync(abs, setFrontmatter(content, patch), 'utf8');
        fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
        fs.renameSync(abs, archiveAbs);
        // 搬完索引就脏了：马上 zk_stats 会把这篇既不算归档也不算活跃（见 refreshIndexQuietly）
        await refreshIndexQuietly(cfg, signal);
    }
    return {
        dryRun,
        performed: !dryRun,
        alreadySuperseded: false,
        path: rel,
        archivePath,
        supersededBy: byStem ? `[[${byStem}]]` : null,
        reason,
        rewrittenLinks,
        missingLinks,
    };
}
/** wiki 链接：[[目标|别名]] / [[目标#小节]]（不含换行与嵌套方括号） */
const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/g;
/** Markdown 行内链接 / 图片：[文字](目标 "标题")，目标可带尖括号 */
const MD_LINK = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)([^)\n]*\))/g;
/** 候选路径在笔记本里存在、且是文件 → 返回绝对路径（wiki 链接常省略扩展名） */
function existingFile(cfg, base) {
    const nb = path.resolve(cfg.notebook);
    for (const abs of [base, base + '.md', base + '.markdown']) {
        if (abs !== nb && !abs.startsWith(nb + path.sep))
            continue;
        try {
            if (fs.existsSync(abs) && fs.statSync(abs).isFile())
                return abs;
        }
        catch { /* 读不到的当没命中 */ }
    }
    return null;
}
/**
 * 解析 wiki 链接目标。zk 的路径是**笔记本根相对**（不是相对链接所在目录，实测 ../ 不建边），
 * 另外允许只写文件名（全局按文件名匹配）。认 URL / 纯锚点 / 不存在的目标为 null。
 */
function resolveWikiTarget(cfg, target, stems) {
    const raw = target.trim();
    if (!raw || raw.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw))
        return null;
    const rel = raw.replace(/^\/+/, '');
    if (!rel)
        return null;
    const byRoot = existingFile(cfg, path.resolve(cfg.notebook, rel));
    if (byRoot)
        return { abs: byRoot, style: 'root' };
    if (rel.includes('/'))
        return null;
    const hits = stems.get(rel.replace(NOTE_EXT, '')) ?? [];
    // 同名多篇时 zk 自己也可能选错 —— 不猜，留给人看
    return hits.length === 1 ? { abs: hits[0], style: 'stem' } : null;
}
/** Markdown 链接只相对当前文件解析（实测根相对写法 zk 不建边） */
function resolveMarkdownTarget(cfg, sourceDir, target) {
    const raw = target.trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw))
        return null;
    return existingFile(cfg, path.resolve(sourceDir, raw));
}
/** 写出相对笔记本根的路径（wiki 链接用；不带前导 /，zk 不认） */
function rootLinkPath(cfg, targetAbs, keepExt) {
    const rel = relPathOf(cfg, targetAbs);
    return keepExt ? rel : rel.replace(NOTE_EXT, '');
}
/** 写出从 outDir 到 targetAbs 的相对路径（Markdown 链接用；转义交给调用方） */
function relativeLinkPath(outDir, targetAbs, keepExt) {
    let rel = path.relative(outDir, targetAbs).split(path.sep).join('/');
    if (!rel)
        rel = path.basename(targetAbs);
    return keepExt ? rel : rel.replace(NOTE_EXT, '');
}
/** 按计划重写一段 Markdown 里的链接；返回新文本与被改条数。围栏里的示例链接不动 */
function relinkText(cfg, text, plan) {
    let changed = 0;
    const lines = String(text).split('\n');
    const masked = fenceMask(lines);
    const wikiOf = (line) => line.replace(WIKI_LINK, (whole, inner) => {
        const bar = inner.indexOf('|');
        const head = bar >= 0 ? inner.slice(0, bar) : inner;
        const tail = bar >= 0 ? inner.slice(bar) : '';
        const hash = head.indexOf('#');
        const target = (hash >= 0 ? head.slice(0, hash) : head).trim();
        const anchor = hash >= 0 ? head.slice(hash) : '';
        if (!target)
            return whole;
        const resolved = resolveWikiTarget(cfg, target, plan.stems);
        if (!resolved)
            return whole;
        const next = plan.remap.get(resolved.abs);
        // 换目录不影响 wiki 链接（按根 / 文件名解析），只有指向自己时才需要改
        if (!next)
            return whole;
        const out = rootLinkPath(cfg, next, NOTE_EXT.test(target));
        const rebuilt = '[[' + out + anchor + tail + ']]';
        if (rebuilt === whole)
            return whole;
        changed++;
        return rebuilt;
    });
    const mdOf = (line) => line.replace(MD_LINK, (whole, prefix, dest, tail) => {
        const angled = dest.startsWith('<') && dest.endsWith('>');
        const raw = angled ? dest.slice(1, -1) : dest;
        if (!raw || raw.startsWith('#'))
            return whole;
        const hash = raw.indexOf('#');
        const pathPart = hash >= 0 ? raw.slice(0, hash) : raw;
        const frag = hash >= 0 ? raw.slice(hash) : '';
        if (!pathPart)
            return whole;
        const resolved = resolveMarkdownTarget(cfg, plan.sourceDir, pathPart);
        if (!resolved)
            return whole;
        const next = plan.remap.get(resolved) ?? (plan.rebaseMarkdown ? resolved : undefined);
        if (!next)
            return whole;
        const rel = relativeLinkPath(plan.outDir, next, NOTE_EXT.test(pathPart));
        // 空格 / 括号在 Markdown 目标里必须转义（统一用 %xx，不猜编辑器）
        const escaped = /[\s()%]/.test(rel) ? encodeURI(rel).replace(/\(/g, '%28').replace(/\)/g, '%29') : rel;
        const rebuilt = prefix + (angled ? '<' + escaped + '>' : escaped) + frag + tail;
        if (rebuilt === whole)
            return whole;
        changed++;
        return rebuilt;
    });
    return { text: lines.map((line, i) => (masked[i] ? line : mdOf(wikiOf(line)))).join('\n'), changed };
}
/** 新路径归一化：可只给文件名、可给目录（末尾 /），扩展名不变；跑出笔记本由 absPathOf 兜 */
function renameTargetRel(cfg, oldAbs, to) {
    const raw = String(to ?? '').trim();
    if (!raw)
        throw new ZkError('新路径不能为空', '给一个相对路径，例如 notes/新标题.md');
    const oldExt = path.extname(oldAbs);
    const oldBase = path.basename(oldAbs);
    let rel;
    if (path.isAbsolute(raw)) {
        rel = relPathOf(cfg, absPathOf(cfg, raw));
    }
    else {
        rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
    }
    // 目录形式：末尾 / ，或指向一个已存在的目录 → 保留原文件名
    const asDir = rel.endsWith('/');
    let target = asDir ? `${rel.replace(/\/+$/, '')}/${oldBase}` : rel;
    if (!asDir) {
        const probe = path.resolve(cfg.notebook, target);
        try {
            if (fs.existsSync(probe) && fs.statSync(probe).isDirectory())
                target = `${target}/${oldBase}`;
        }
        catch { /* 探测失败就按文件处理，后面 existsSync 会再拦 */ }
    }
    target = target.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    const ext = path.extname(target);
    if (!ext)
        target += oldExt;
    else if (ext.toLowerCase() !== oldExt.toLowerCase()) {
        throw new ZkError(`改名不能换格式：${ext} ≠ ${oldExt}`, '只改文件名或目录；换格式请新建一篇再 zk_supersede');
    }
    return target;
}
/**
 * 给一篇笔记改名 / 换目录，并把引用它的链接一起改到新路径。
 *
 * 顺序：先在内存里算好所有改写（解析用当前磁盘状态，旧文件还在）→ rename → 写回。
 * 入链先改、后搬文件会让「目标还不存在」的中间态出现在磁盘上；反过来则是「入链短暂失效」——
 * 两者都会在进程中途失败时留下半成品，区别只在于重跑时从哪一侧接上。这里选 rename 先行：
 * 文件搬到位之后，剩下的只是文本改写，重复调用不会再搬第二次。
 * 可重放：第二次调用原路径已经不存在，直接报「笔记不存在」。
 */
export async function renameNote(cfg, opts, signal) {
    const dryRun = opts.dryRun !== false;
    const oldAbs = absPathOf(cfg, opts.path);
    if (!fs.existsSync(oldAbs) || !fs.statSync(oldAbs).isFile())
        throw new ZkError(`笔记不存在：${opts.path}`);
    const oldRel = relPathOf(cfg, oldAbs);
    if (isMetaPath(oldRel)) {
        throw new ZkError(`${oldRel} 是 meta 文件，不能改名`, `${META_NAMES.join(' / ')} 的名字是约定（注入、排除都按它认），要改内容请直接编辑`);
    }
    assertWritablePath(cfg, oldAbs);
    if (oldRel === cfg.archiveDir || oldRel.startsWith(`${cfg.archiveDir}/`)) {
        throw new ZkError(`归档里的笔记不能改名：${oldRel}`, `${cfg.archiveDir}/ 下的路径是 supersede 重写入链的目标，搬动它会让历史链接再断一次`);
    }
    const oldBase = path.basename(oldAbs, path.extname(oldAbs));
    if (path.dirname(oldRel) === cfg.dailyDir && /^\d{4}-\d{2}-\d{2}$/.test(oldBase)) {
        throw new ZkError(`日记按日期命名，不能改名：${oldRel}`, '改名后 zk_daily 会为同一天另建一篇；整理内容用 zk_append，废弃结论用 zk_supersede');
    }
    const newRel = renameTargetRel(cfg, oldAbs, opts.to);
    const newAbs = absPathOf(cfg, newRel);
    if (newAbs === oldAbs)
        throw new ZkError('新旧路径一样', '给一个不同的文件名或目录');
    if (isMetaPath(newRel)) {
        throw new ZkError(`不能把笔记改名成 meta 文件：${newRel}`, `${META_NAMES.join(' / ')} 是根目录约定文件，请直接编辑它们`);
    }
    assertWritablePath(cfg, newAbs);
    if (newRel === cfg.archiveDir || newRel.startsWith(`${cfg.archiveDir}/`)) {
        throw new ZkError(`不能把笔记改名进归档目录：${newRel}`, '归档只由 zk_supersede 写入；要废弃那篇笔记请用它');
    }
    if (fs.existsSync(newAbs)) {
        throw new ZkError(`目标路径已被占用：${newRel}`, '改名不覆盖任何文件；先处理掉那个文件，或换一个名字');
    }
    // ── 入链：zk graph（活笔记）+ 根目录 meta 文件（不在图里）────────────
    const stems = new Map();
    try {
        for (const note of await allNotes(cfg, { includeArchived: true }, signal)) {
            const key = path.basename(note.path).replace(NOTE_EXT, '');
            const list = stems.get(key) ?? [];
            list.push(note.absPath || path.join(cfg.notebook, note.path));
            stems.set(key, list);
        }
    }
    catch { /* 索引读不到时退化成只认根路径：少改几个，绝不多改 */ }
    // 归档里的笔记也会链向活笔记：改名不带上它们，会让历史入链静默断掉（lint 看不见归档）
    const graphSources = new Set(await inboundSources(cfg, oldRel, signal, { includeArchived: true }));
    const sources = new Set(graphSources);
    for (const name of META_NAMES) {
        try {
            if (fs.existsSync(path.join(cfg.notebook, name)))
                sources.add(name);
        }
        catch { /* 单个文件读不到不影响其它 */ }
    }
    const rewrittenLinks = [];
    const missingLinks = [];
    const pending = [];
    const remap = new Map([[oldAbs, newAbs]]);
    for (const source of sources) {
        const sourceAbs = path.join(cfg.notebook, source);
        let text;
        try {
            text = fs.readFileSync(sourceAbs, 'utf8');
        }
        catch {
            if (graphSources.has(source))
                missingLinks.push(source);
            continue;
        }
        const out = relinkText(cfg, text, {
            sourceDir: path.dirname(sourceAbs),
            outDir: path.dirname(sourceAbs),
            remap,
            rebaseMarkdown: false,
            stems,
        });
        if (out.changed === 0) {
            // 图说它链过来了，正文里却找不到能识别的写法：可能写在代码块/奇怪语法里，交给人看
            if (graphSources.has(source))
                missingLinks.push(source);
            continue;
        }
        rewrittenLinks.push({ path: source, replaced: out.changed });
        if (!dryRun)
            pending.push({ abs: sourceAbs, text: out.text });
    }
    // ── 它自己的相对链接：换目录后同样的写法会指向别处 ──────────────────
    const selfRaw = fs.readFileSync(oldAbs, 'utf8');
    const self = relinkText(cfg, selfRaw, {
        sourceDir: path.dirname(oldAbs),
        outDir: path.dirname(newAbs),
        remap,
        rebaseMarkdown: true,
        stems,
    });
    if (!dryRun) {
        fs.mkdirSync(path.dirname(newAbs), { recursive: true });
        fs.renameSync(oldAbs, newAbs);
        if (self.changed > 0)
            fs.writeFileSync(newAbs, self.text, 'utf8');
        for (const item of pending)
            fs.writeFileSync(item.abs, item.text, 'utf8');
        // 路径全变了：索引不刷新的话，紧接着的检索还会按旧路径 / 旧入链回答
        await refreshIndexQuietly(cfg, signal);
    }
    return {
        dryRun,
        performed: !dryRun,
        path: oldRel,
        newPath: newRel,
        rewrittenLinks,
        missingLinks,
        selfRewritten: self.changed,
    };
}
/** 正文里是否已有这个 #tag（前后不能紧贴标签字符：#素材库 不算 #素材） */
function hasHashtag(body, tag) {
    if (!tag)
        return false;
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_-])#${escaped}(?![\\p{L}\\p{N}_-])`, 'u').test(body);
}
export function withTags(content, tags) {
    const body = String(content ?? '').replace(/\s+$/, '');
    if (!tags.length)
        return body;
    // 正文里已经写过的标签跳过：以前正文写了 #tag、入参又给 tags，末尾会多出一行一模一样的
    const missing = tags.filter((tag) => !hasHashtag(body, tag));
    if (!missing.length)
        return body;
    const line = missing.map((t) => `#${t}`).join(' ');
    return body ? `${body}\n\n${line}` : line;
}
/**
 * 中文笔记没打标签的提示（P2-9）：写路径是唯一便宜的修复点。
 *
 * 为什么是「没标签」而不是「搜不到」：P2-7 之后中文查询已经会并上子串匹配，正文照样找得回来；
 * 真正的代价在下一道门 —— `zk_dream` 的机械门按「无标签」把笔记拒出晋升候选，
 * `zk_stats` 的 byTag 分布里也没有它。标签仍是唯一能确定性筛选的维度。
 *
 * 只提示、不阻断 —— 索引页、临时对照本来就不需要标签；`defaultTags` 非空时也不会走到这里。
 * 判据用最终标签（入参 + 默认值为空）且正文没有 hashtag，避免误报。
 */
export function taglessCjkWarning(title, content, tags) {
    if (tags.length > 0)
        return null;
    if (HASHTAG.test(String(content ?? '')))
        return null;
    if (!CJK_TEXT.test(String(title ?? '')) && !CJK_TEXT.test(String(content ?? '')))
        return null;
    return '中文笔记没有 tags：zk_dream 的「无标签」门会把它拒出晋升候选，byTag 分布里也看不到它；补 tags 或设默认标签';
}
