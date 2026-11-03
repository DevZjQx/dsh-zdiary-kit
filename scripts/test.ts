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
 */
// 带过滤参数（-t / 文件路径）时只跑会话指定的那份，别拿「0 tests」把整批判死
if (forward.length === 0) {
  const unit = spawn(process.execPath, ['test', 'test/state.test.ts'], { cwd: root, stdio: 'inherit' })
  const unitCode = await new Promise<number>((resolve) => unit.on('close', (c) => resolve(c ?? 1)))
  if (unitCode !== 0) process.exit(unitCode)
}

const loc = await resolveZk(config())
if (loc === null) {
  console.error('✗ 找不到 zk：集成测试会全部跳过，跳过不算通过。')
  console.error('  给 ZK_BIN=/path/to/zk，或在设置页点「安装内置 zk」。')
  process.exit(1)
}
console.log(`zk: ${loc.bin}（来源 ${loc.source}，v${loc.version}）`)

// 集成测试跑真 zk：建 150+ 篇笔记的用例在慢机器上会超过 bun 默认的 5s（实测偶发 flake），放宽到 15s
// 只跑集成文件：两个测试文件同时加载时，各自的顶层 `process.env.DSH_HOME` 会互相覆盖，
// 而 `src/config/paths.ts` 的 CFG_FILE 在第一次 import 时就定死了 —— 结果父进程写 A、子进程读 B。
const child = spawn(process.execPath, ['test', '--timeout=15000', 'test/zk.test.ts', ...forward], {
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
