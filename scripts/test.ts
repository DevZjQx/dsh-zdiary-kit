#!/usr/bin/env bun
/**
 * 测试入口：先按插件自己的顺序找 zk，再跑 `bun test`，最后**要求零 skip**。
 *
 * 为什么需要这层包装：集成测试在找不到 zk 时会 `test.skip`，
 * `bun test` 于是显示「2 pass / 13 skip / 0 fail」—— 全绿但等于没跑，
 * 回归（尤其是 flat 模式逐字节一致）无法被证明。这里把「跳过」按失败处理。
 *
 *   bun run test          # 正常跑
 *   ZK_BIN=/path/to/zk bun run test
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config/store.ts'
import { resolveZk } from '../src/lib/zk.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const forward = process.argv.slice(2)

/**
 * 状态层的单测跟集成测试**分进程**跑。
 *
 * 原因：`src/config/paths.ts` 在模块加载时就把 `CFG_FILE` 定死了（DSH_HOME 之后改不改都不影响），
 * 而集成测试靠「每个用例前重写配置文件、spawn CLI 子进程」验证多进程行为 ——
 * 两个测试文件在同一进程里抢 DSH_HOME / 模块缓存时会互相污染（实测 config set 全部读到别人的库）。
 * 单测不依赖 zk，先单独跑一遍；失败就直接退出，不必等集成。
 *
 * 参数分两种：
 *   · 只给 -t / --test-name-pattern 等选项 → 单测 + 集成，选项原样传给集成那一轮；
 *   · 显式给了测试文件 → 只跑那几份 —— 再塞一份进来就是上面那个污染。
 * 目录直接拒：`bun test test/` 会把两份文件塞进同一个进程，正是这层要防的事。
 */
/** 必须在自己进程里跑的单测文件；新增单测就加到这里，别靠文件名猜 */
const UNIT_FILES = ['test/state.test.ts']

const NAME_ARG = /^(?:-t|--test-name-pattern)$/
const fileArgs: string[] = []
const restArgs: string[] = []
for (let i = 0; i < forward.length; i++) {
  const arg = forward[i] as string
  // -t 的值可能是任何字符串（甚至长得像路径）：不当文件看
  if (NAME_ARG.test(arg)) {
    restArgs.push(arg, ...(forward[i + 1] === undefined ? [] : [forward[i + 1] as string]))
    i++
    continue
  }
  if (arg.startsWith('-')) { restArgs.push(arg); continue }
  const abs = path.resolve(root, arg)
  let stat: fs.Stats | null = null
  try { stat = fs.statSync(abs) } catch { /* 不是路径：当模式串留给 bun */ }
  if (stat?.isDirectory()) {
    console.error(`✗ 不给目录：${arg} —— 单测与集成必须各自一个进程（见本文件顶部注释）`)
    process.exit(1)
  }
  if (stat?.isFile()) { fileArgs.push(path.relative(root, abs)); continue }
  restArgs.push(arg)
}
const unitTargets = fileArgs.filter((f) => UNIT_FILES.includes(f))
const integrationTargets = fileArgs.filter((f) => !UNIT_FILES.includes(f))
const needsUnit = fileArgs.length === 0 || unitTargets.length > 0
const needsIntegration = fileArgs.length === 0 || integrationTargets.length > 0

if (needsUnit) {
  const files = unitTargets.length > 0 ? unitTargets : UNIT_FILES
  const unit = spawn(process.execPath, ['test', ...files], { cwd: root, stdio: 'inherit' })
  const unitCode = await new Promise<number>((resolve) => unit.on('close', (c) => resolve(c ?? 1)))
  if (unitCode !== 0) process.exit(unitCode)
}
if (!needsIntegration) process.exit(0)

const loc = await resolveZk(config())
if (loc === null) {
  console.error('✗ 找不到 zk：集成测试会全部跳过，跳过不算通过。')
  console.error('  给 ZK_BIN=/path/to/zk，或在设置页点「安装内置 zk」。')
  process.exit(1)
}
console.log(`zk: ${loc.bin}（来源 ${loc.source}，v${loc.version}）`)

// 集成测试跑真 zk：建 150+ 篇笔记的用例在慢机器上会超过 bun 默认的 5s（实测偶发 flake），放宽到 15s。
// 显式给了文件就不补 zk.test.ts：两份一起加载时，各自的顶层 `process.env.DSH_HOME` 会互相覆盖，
// 而 `src/config/paths.ts` 的 CFG_FILE 在第一次 import 时就定死了 —— 结果父进程写 A、子进程读 B。
const files = integrationTargets.length > 0 ? integrationTargets : ['test/zk.test.ts']
const child = spawn(process.execPath, ['test', '--timeout=15000', ...files, ...restArgs], {
  cwd: root,
  env: { ...process.env, ZK_BIN: loc.bin },
  stdio: ['inherit', 'pipe', 'inherit'],
})

child.stdout.setEncoding('utf8')
let output = ''
child.stdout.on('data', (chunk: string) => {
  output += chunk
  process.stdout.write(chunk)
})

const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)))

// bun 在有 pipe 时通常不着色，但别赌
const plain = output.replace(/\x1b\[[0-9;]*m/g, '')
const skipped = Number(/(\d+)\s+skip/.exec(plain)?.[1] ?? 0)
if (code === 0 && skipped > 0) {
  console.error(`✗ 有 ${skipped} 条测试被跳过 —— 按失败处理（见 scripts/test.ts 顶部说明）`)
  process.exit(1)
}
process.exit(code)
