#!/usr/bin/env bun
/**
 * dist 漂移闸：源码已经提交、dist 没跟上 —— 用户装到的就是旧代码。
 *
 * 为什么不在 build 之后无条件报「dist 有改动」：本地改源码时 dist 本来就是脏的（还没提交），
 * 那不是漂移。所以只在「dist 脏、src 干净」时报错，也就是「源码提交了，忘了把 dist 一起提交」。
 * CI 上刚 checkout 时 src 必然干净，build 一出差异就红 —— 正好是这条闸要抓的那一刻。
 *
 *   bun run check:dist     # 单独跑
 *   bun run check          # 串在 build 之后
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.error) return { ok: false, out: '', err: r.error.message }
  return { ok: r.status === 0, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

const inside = git(['rev-parse', '--is-inside-work-tree'])
if (!inside.ok || inside.out.trim() !== 'true') {
  console.log('· 不在 git 工作区里（发布包 / 解压目录），跳过 dist 漂移检查')
  process.exit(0)
}

function changes(p: string): string {
  const r = git(['status', '--porcelain', '--', p])
  if (!r.ok) {
    console.error('✗ git status 失败：' + r.err.trim())
    process.exit(1)
  }
  return r.out.trim()
}

const dist = changes('dist')
if (dist === '') {
  console.log('✓ dist 没有未提交改动')
  process.exit(0)
}

if (changes('src') !== '') {
  console.log('· src 还有未提交改动（在开发中），跳过 dist 漂移检查 —— 提交时记得把 dist 一起带上')
  process.exit(0)
}

console.error('✗ dist 与已提交的源码不一致 —— 装插件的人拿到的就是这份构建产物：')
console.error(dist)
console.error('  src 已提交、dist 没跟上：跑 bun run build 后把 dist 一起提交。')
process.exit(1)
