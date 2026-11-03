/**
 * 从笔记本的 `.zk/config.toml` 读 `[alias]` 自定义命令。
 *
 * 为什么自己解析而不是 `zk config --list aliases`：工具在插件加载时**同步**注册，
 * 不能为了拿几个名字先起子进程；而且第一次装 zk 之前配置文件就已经可能在。
 * 这里只取「名字 / 命令 / 说明」，真正执行交给 `zk <别名>` —— `$@`、管道、`$SHELL -c`
 * 的语义全由 zk 负责，插件不拼 shell。
 *
 * 只认 `[alias]` 这张表：`[alias.foo]` / `[[alias]]` 不是命令定义；注释掉的别名
 * 与真正的注释一样不产生工具。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import { notebookInfos } from '../config/store.ts'

export interface AliasDefinition {
  /** zk 别名（调用方式 `zk <name>`） */
  name: string
  /** 原始命令字符串（只用于工具说明，不执行） */
  command: string
  /** 紧邻上方的注释，或行尾注释；没有就是空串 */
  description: string
}

/**
 * 工具名后缀：DSH / DeepSeek 的 function-name 契约是 `[A-Za-z0-9_-]`（总长 64），
 * 所以 `zk_` 前缀之后最多 61 个字符；带空格 / 引号 / 点号的别名装不进工具名。
 * 首字符不许是 `-`：`zk -h` 会被当成 flag，执行的根本不是别名。
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/

/** TOML 基础字符串的转义；解析不了就原样留下，工具说明不需要精确到字节 */
function unescapeBasic(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_match, seq: string) => {
    switch (seq[0]) {
      case 'b': return '\b'
      case 't': return '\t'
      case 'n': return '\n'
      case 'f': return '\f'
      case 'r': return '\r'
      case '"': return '"'
      case '\\': return '\\'
      case 'u':
      case 'U': {
        const code = Number.parseInt(seq.slice(1), 16)
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      default: return seq
    }
  })
}

interface ParsedValue {
  value: string
  /** 闭合引号之后的剩余文本（用来找行尾注释） */
  after: string
  /** 值结束后的下一行下标（多行字符串会跨行） */
  next: number
}

/** 解析 `=` 右边的字符串；不是字符串（数字 / 数组 / 内联表）返回 null */
function parseValue(rest: string, lines: string[], index: number): ParsedValue | null {
  const text = rest.trimStart()
  if (text.startsWith('"""') || text.startsWith("'''")) {
    const delim = text.slice(0, 3)
    let body = text.slice(3)
    let line = index
    for (;;) {
      const end = body.indexOf(delim)
      if (end >= 0) {
        const raw = body.slice(0, end).replace(/^\n/, '')
        return {
          value: delim === '"""' ? unescapeBasic(raw) : raw,
          after: body.slice(end + 3),
          next: line + 1,
        }
      }
      line += 1
      if (line >= lines.length) return null
      body += '\n' + lines[line]
    }
  }
  if (text.startsWith('"')) {
    let out = ''
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '\\') {
        const m = /^(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/.exec(text.slice(i + 1))
        if (!m) return null
        out += unescapeBasic('\\' + m[1])
        i += m[1].length
        continue
      }
      if (ch === '"') return { value: out, after: text.slice(i + 1), next: index + 1 }
      out += ch
    }
    return null
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1)
    if (end < 0) return null
    return { value: text.slice(1, end), after: text.slice(end + 1), next: index + 1 }
  }
  return null
}

/** 键：裸键 / 双引号 / 单引号；认不出的返回 null */
function keyOf(raw: string): string | null {
  const text = raw.trim()
  if (text.startsWith('"')) {
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === '\\') { i += 1; continue }
      if (text[i] !== '"') continue
      return i === text.length - 1 ? unescapeBasic(text.slice(1, i)) : null
    }
    return null
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1)
    return end === text.length - 1 ? text.slice(1, end) : null
  }
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : null
}

/** 表头名：`[alias]` → `alias`；`[[alias]]` / `[alias.note]` 不是命令表 */
function tableOf(line: string): string | null {
  if (/^\s*\[\[/.test(line)) return null
  const m = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
  if (!m) return null
  let name = m[1].trim()
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1)
  }
  return name
}

/** 解析 TOML 文本里的 `[alias]`；纯函数，测试直接喂字符串 */
export function parseAliases(text: string): AliasDefinition[] {
  const lines = String(text ?? '').split(/\r?\n/)
  const out: AliasDefinition[] = []
  const seen = new Set<string>()
  let inAlias = false
  let comments: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) { comments = []; continue }
    if (trimmed.startsWith('#')) {
      const body = trimmed.replace(/^#+\s?/, '').trimEnd()
      // 注释掉的别名不进入说明（`#lucky = "…"` 不是 lucky 的描述）
      if (/^(?:[A-Za-z0-9_-]+|".*"|'.*')\s*=/.test(body)) { comments = []; continue }
      if (body) comments.push(body)
      continue
    }
    // `[[alias]]` 是表数组，不是命令表：结束 [alias] 段，别把里面的键当成别名
    if (/^\s*\[\[/.test(line)) { inAlias = false; comments = []; continue }
    const table = tableOf(line)
    if (table !== null) {
      inAlias = table === 'alias'
      comments = []
      continue
    }
    if (!inAlias) { comments = []; continue }

    const m = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(line)
    const name = m ? keyOf(m[1]) : null
    const parsed = name ? parseValue(m![2], lines, i) : null
    if (!name || !parsed || !SAFE_NAME.test(name) || seen.has(name)) {
      comments = []
      continue
    }
    const inline = /^\s*#\s?(.*)$/.exec(parsed.after)
    const description = comments.join(' ').trim() || (inline ? inline[1].trim() : '')
    out.push({
      name,
      command: parsed.value.replace(/\s+/g, ' ').trim(),
      description: description.replace(/\s+/g, ' ').trim().slice(0, 240),
    })
    seen.add(name)
    comments = []
    i = parsed.next - 1
  }
  return out
}

/** 读一本笔记本的别名；没有 / 读不了都当空列表（插件不该因为一条坏配置起不来） */
export function aliasesIn(notebook: string): AliasDefinition[] {
  try {
    const file = path.join(notebook, '.zk', 'config.toml')
    return parseAliases(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/** 当前笔记本的别名（执行前核对用：别名工具是全局注册的，会话可能已经切库） */
export function readAliases(cfg: Config): AliasDefinition[] {
  return aliasesIn(cfg.notebook)
}

/**
 * 所有已配置笔记本里出现过的别名（同名只留第一本）。
 * 工具列表是全局的、会话切库又是运行时的，所以只能取并集；执行时再按当前笔记本核对。
 */
export function configuredAliases(cfg: Config, workspace: string): AliasDefinition[] {
  const seen = new Set<string>()
  const out: AliasDefinition[] = []
  for (const info of notebookInfos(cfg, workspace)) {
    for (const alias of aliasesIn(info.path)) {
      if (seen.has(alias.name)) continue
      seen.add(alias.name)
      out.push(alias)
    }
  }
  return out
}
