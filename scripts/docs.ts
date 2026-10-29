#!/usr/bin/env bun
/**
 * 文档冒烟：README 与 docs/features/*.md 里「整块都是 zk-kit 命令」的代码块，
 * 逐条在**临时 vault** 上真跑一遍。
 *
 * 只认两类块：块内每一行（除空行与 # 注释）都以 `zk-kit` 开头。
 * 其它 bash 块（装插件、rm -rf、curl）不在此列 —— 别把「危险命令」写进可跑清单。
 *
 *   ZK_BIN=/path/to/zk bun run docs
 *
 * 为什么要这层：文档里的命令不会随代码一起被类型检查，拼错子命令 / 漏了必填参数 /
 * 引用了不存在的路径，只能靠真跑发现。计划 §4 M4 的验收线就是这一条。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const zkBin = process.env.ZK_BIN || 'zk'

const hasZk = fs.existsSync(zkBin) || (process.env.PATH ?? '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, zkBin)))
if (!hasZk) {
  console.error('✗ 找不到 zk（给 ZK_BIN 或把 zk 放进 PATH）')
  process.exit(1)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zdiary-docs-'))
process.env.DSH_HOME = home
const notebook = path.join(home, 'notebook')

// 配置读写在 src 里（同一份 TS）；被跑的命令走 dist，两边指向同一个 CFG_FILE
const { writeConfig } = await import('../src/config/store.ts')
// 用 layered：init 会连带建目录、三套模板、五个 group 与 AGENTS.md —— 文档命令的覆盖面最大
writeConfig({ notebook, zkPath: zkBin, structure: 'layered' })

const cli = path.join(root, 'dist/cli.js')
const docsRoot = path.join(root, 'docs', 'features')
const files = [
  path.join(root, 'README.md'),
  ...fs.readdirSync(docsRoot).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(docsRoot, f)),
]

const FENCE = /```([^\n]*)\n([\s\S]*?)```/g

interface Cmd {
  file: string
  line: string
}

const commands: Cmd[] = []
for (const file of files) {
  const rel = path.relative(root, file)
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(FENCE)) {
    const lines = (match[2] ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    if (!lines.length) continue
    const allCli = lines.every((l) => l === 'zk-kit' || l.startsWith('zk-kit '))
    if (!allCli) continue
    for (const line of lines) commands.push({ file: rel, line })
  }
}

if (!commands.length) {
  console.error('✗ 一个 zk-kit 代码块都没找到 —— 文档结构变了，检查 FENCE 规则')
  process.exit(1)
}

console.log('文档命令：' + commands.length + ' 条（来自 ' + new Set(commands.map((c) => c.file)).size + ' 个文件）')

let failed = 0
for (const item of commands) {
  // 用 shell 跑：文档里本来就有引号与中文空格，自己拆词只会拆错
  const shellCmd = item.line.replace(/^zk-kit\b/, '"' + process.execPath + '" "' + cli + '"')
  const r = spawnSync(shellCmd, {
    shell: true,
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
  if (r.status !== 0) {
    failed += 1
    console.error('✗ ' + item.file + ' → ' + item.line + '\n  ' + out.split('\n').join('\n  '))
  } else {
    console.log('✓ ' + item.file + ' → ' + item.line)
  }
}

fs.rmSync(home, { recursive: true, force: true })
if (failed) {
  console.error('\n✗ ' + failed + '/' + commands.length + ' 条文档命令跑不通')
  process.exit(1)
}
console.log('\n✓ 文档命令全部跑通（' + commands.length + ' 条，临时 vault 已删）')
