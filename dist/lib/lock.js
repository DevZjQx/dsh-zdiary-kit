/**
 * 跨进程文件锁：O_EXCL 建锁文件，临界区就几毫秒（读-合并-写配置）。
 *
 * 为什么同步：writeConfig 是同步 API（CLI / 设置页 / 测试共用），改异步会一路传染。
 * 临界区不 await、不回调宿主，阻塞时间 = 一次读盘 + 一次写盘；拿不到锁时最多等 3 秒。
 *
 * 崩溃留下的锁按 mtime 判 stale（默认 15 秒）—— 临界区远小于这个值，
 * 正常持锁者不会被动清理；被清理后两个写者仍靠 O_EXCL 决出唯一赢家。
 */
import fs from 'node:fs';
import path from 'node:path';
/** 同步睡一会儿：Atomics.wait 不烧 CPU；个别运行时不让主线程 wait 就退回自旋 */
function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    catch {
        const end = Date.now() + ms;
        while (Date.now() < end) { /* spin */ }
    }
}
function isStale(file, staleMs) {
    try {
        return Date.now() - fs.statSync(file).mtimeMs > staleMs;
    }
    catch {
        // 刚被别人释放：当作不 stale，下一轮重试 EEXIST / 成功
        return false;
    }
}
/** 在锁文件上跑 fn；拿不到锁就抛（调用方决定怎么报给用户） */
export function withFileLockSync(file, fn, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 3000;
    const staleMs = opts.staleMs ?? 15_000;
    const pollMs = opts.pollMs ?? 20;
    const started = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let fd = null;
    while (fd === null) {
        try {
            fd = fs.openSync(file, 'wx');
            try {
                fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
            }
            catch (err) {
                fs.closeSync(fd);
                fs.rmSync(file, { force: true });
                throw err;
            }
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            if (isStale(file, staleMs)) {
                try {
                    fs.rmSync(file, { force: true });
                }
                catch { /* 别人也在清：下一轮再说 */ }
                continue;
            }
            if (Date.now() - started > timeoutMs) {
                throw new Error(`等锁超时：另一个进程正在写（${file}）；稍后重试`);
            }
            sleepSync(pollMs);
        }
    }
    try {
        return fn();
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch { /* 已经关了 */ }
        try {
            fs.rmSync(file, { force: true });
        }
        catch { /* 被 stale 清理抢走了 */ }
    }
}
