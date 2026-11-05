/** 起子进程（zk / tar），带超时、abort、stdin 输入；错误统一成 ZkExecError。 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 成本表用的进程内计数（scripts/bench.ts）：起了几次子进程、子进程回了多少字节。
 * 生产路径只多两次整数加法，没有其它影响；bench 在每次用例前清零。
 */
export const execStats = { calls: 0, bytes: 0 }

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export class ExecError extends Error {
  readonly code: number | null
  readonly stderr: string
  /** 被我们自己的超时 / abort 杀掉（不是子进程自己退出）—— 建索引超时要靠它区分 */
  readonly killed: boolean
  constructor(message: string, code: number | null, stderr: string, killed = false) {
    super(message)
    this.name = 'ExecError'
    this.code = code
    this.stderr = stderr
    this.killed = killed
  }
}

export interface ExecOptions {
  cwd?: string
  input?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  maxBuffer?: number
}

/** 跑一个可执行文件，返回 { code, stdout, stderr }；ENOENT / 超时会 throw */
export function run(exe: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        signal: opts.signal,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '')
        const errText = String(stderr ?? '')
        execStats.calls += 1
        execStats.bytes += Buffer.byteLength(out) + Buffer.byteLength(errText)
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null
          const hint = code === null ? String((err as Error).message ?? err) : ''
          const killed = (err as { killed?: boolean }).killed === true
          reject(new ExecError(hint || (errText.trim() || `exit ${code}`), code, errText, killed))
          return
        }
        resolve({ code: 0, stdout: out, stderr: errText })
      },
    )
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => { /* zk 提前退出时 EPIPE 不该炸宿主 */ })
      child.stdin?.end(opts.input)
    } else {
      child.stdin?.end()
    }
  })
}

/** PATH 里找可执行文件（Windows 认 PATHEXT） */
export function findOnPath(name: string): string | null {
  const raw = process.env.PATH ?? ''
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        const st = fs.statSync(candidate)
        if (st.isFile()) return candidate
      } catch { /* 下一个 */ }
    }
  }
  return null
}
