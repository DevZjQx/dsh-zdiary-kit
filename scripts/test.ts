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

const loc = await resolveZk(config())
if (loc === null) {
  console.error('✗ 找不到 zk：集成测试会全部跳过，跳过不算通过。')
  console.error('  给 ZK_BIN=/path/to/zk，或在设置页点「安装内置 zk」。')
  process.exit(1)
}
console.log(`zk: ${loc.bin}（来源 ${loc.source}，v${loc.version}）`)

const child = spawn(process.execPath, ['test', ...forward], {
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
