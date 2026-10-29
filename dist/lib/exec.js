/** 起子进程（zk / tar），带超时、abort、stdin 输入；错误统一成 ZkExecError。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export class ExecError extends Error {
    code;
    stderr;
    constructor(message, code, stderr) {
        super(message);
        this.name = 'ExecError';
        this.code = code;
        this.stderr = stderr;
    }
}
/** 跑一个可执行文件，返回 { code, stdout, stderr }；ENOENT / 超时会 throw */
export function run(exe, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(exe, args, {
            cwd: opts.cwd,
            env: opts.env,
            signal: opts.signal,
            timeout: opts.timeoutMs ?? 60_000,
            maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
            encoding: 'utf8',
            windowsHide: true,
        }, (err, stdout, stderr) => {
            const out = String(stdout ?? '');
            const errText = String(stderr ?? '');
            if (err) {
                const code = typeof err.code === 'number' ? err.code : null;
                const hint = code === null ? String(err.message ?? err) : '';
                reject(new ExecError(hint || (errText.trim() || `exit ${code}`), code, errText));
                return;
            }
            resolve({ code: 0, stdout: out, stderr: errText });
        });
        if (opts.input !== undefined) {
            child.stdin?.on('error', () => { });
            child.stdin?.end(opts.input);
        }
        else {
            child.stdin?.end();
        }
    });
}
/** PATH 里找可执行文件（Windows 认 PATHEXT） */
export function findOnPath(name) {
    const raw = process.env.PATH ?? '';
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const dir of raw.split(path.delimiter)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext);
            try {
                const st = fs.statSync(candidate);
                if (st.isFile())
                    return candidate;
            }
            catch { /* 下一个 */ }
        }
    }
    return null;
}
