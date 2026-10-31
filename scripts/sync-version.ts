#!/usr/bin/env bun
/**
 * 版本号同步：`npm version` 改完 package.json，README 标题里的版本跟上。
 *
 * 为什么需要：README 第一行是手写的「# dsh-zdiary-kit <版本>」，npm version 不会碰它。
 * 0.6.1 就漏过一次 —— npm 包页面上展示的 README 至今还写着 0.6.0。
 * 挂在 npm 的 version 生命周期上，改完顺带 git add，跟版本提交进同一个 commit。
 *
 *   bun scripts/sync-version.ts     # 单独跑（package.json 的 version 脚本自动调）
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
const file = path.join(root, 'README.md')
const before = readFileSync(file, 'utf8')

const title = /^# dsh-zdiary-kit \d+\.\d+\.\d+[^\n]*$/m
if (!title.test(before)) {
  console.error('✗ README 第一行找不到「# dsh-zdiary-kit <x.y.z>」标题，版本号无从同步')
  process.exit(1)
}

const after = before.replace(title, `# dsh-zdiary-kit ${version}`)
if (after === before) {
  console.log(`· README 标题已是 ${version}`)
  process.exit(0)
}

writeFileSync(file, after)
console.log(`✓ README 标题 → ${version}`)

// 不在 git 工作区（解压目录 / 发布包）就别折腾暂存区
const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' })
if (inside.status !== 0 || inside.stdout.trim() !== 'true') process.exit(0)

const add = spawnSync('git', ['add', 'README.md'], { cwd: root, encoding: 'utf8' })
if (add.status !== 0) {
  console.error('✗ git add README.md 失败：' + String(add.stderr ?? '').trim())
  process.exit(1)
}
