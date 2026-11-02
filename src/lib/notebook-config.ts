/**
 * `.zk/config.toml` 的 group 只读解析。
 *
 * 为什么自己解析而不是引入 TOML 依赖：
 *   · 我们只关心 `[group."name"]` 的 `paths` / `template` 与它前面的注释；
 *   · 写回只做「替换 plugin-owned group 的 paths 行 / 组头改名」，用正则逐行改比
 *     整份 TOML 序列化安全 —— 不会把用户的注释、顺序、自定义键重排掉。
 *
 * 约定：**解析不了就返回 null，绝不猜**。调用方把 null 当作「缺失 / 需要修」，
 * 而不是按半份结果去改文件。
 */

export interface GroupBlock {
  name: string
  /** 解析不出（缺 paths / 数组里有没加引号的项 / 重复 group）就是 null */
  paths: string[] | null
  /** `[group."name".note] template = "..."`；没有就是 null */
  template: string | null
  /** 组头前紧邻的注释行（原样，含 `#`）；没有就是 null */
  comment: string | null
  /** 组头原文（`--fix` 改名时用） */
  header: string
  /** 同一个名字出现多次：TOML 本身不合法，返回 null 而不挑一个 */
  duplicate: boolean
}

/** `[group."name"]` 或 `[group."name".note|extra]` 的组头 */
const GROUP_HEADER = /^\s*\[group\.(?:"([^"]+)"|'([^']+)')(?:\.(note|extra))?\]\s*$/

function arrayOf(raw: string): string[] | null {
  const text = raw.trim()
  if (!text.startsWith('[') || !text.endsWith(']')) return null
  const inner = text.slice(1, -1).trim()
  if (!inner) return []
  const items: string[] = []
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i++
    if (i >= inner.length) break
    const quote = inner[i]
    if (quote !== '"' && quote !== "'") return null
    i++
    const start = i
    while (i < inner.length && inner[i] !== quote) {
      // 双引号字符串里的转义只支持 \"；单引号是 TOML 字面量，没有转义
      if (quote === '"' && inner[i] === '\\') i++
      i++
    }
    if (i >= inner.length) return null
    items.push(inner.slice(start, i))
    i++
    while (i < inner.length && inner[i] !== ',') {
      if (!/\s/.test(inner[i])) return null
      i++
    }
  }
  return items
}

/** 值 → 单行原始值（去掉行尾注释；引号里的 # 不算注释） */
function valueOf(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#') return line.slice(0, i).trim()
  }
  return line.trim()
}

/** 解析整份 config.toml，返回 名字 → GroupBlock（同名重复时保留 duplicate 标记） */
export function parseGroupBlocks(text: string): Map<string, GroupBlock> {
  const blocks = new Map<string, GroupBlock>()
  const comments: string[] = []
  let current: GroupBlock | null = null
  let section: 'base' | 'note' | 'extra' | null = null

  for (const line of text.split(/\r?\n/)) {
    const header = GROUP_HEADER.exec(line)
    if (header) {
      const name = header[1] ?? header[2] ?? ''
      const sub = header[3] as 'note' | 'extra' | undefined
      if (!sub) {
        const existing = blocks.get(name)
        current = existing
          ? { ...existing, duplicate: true, paths: null, template: null }
          : { name, paths: null, template: null, comment: comments.length ? comments.join('\n') : null, header: line, duplicate: false }
        blocks.set(name, current)
        section = 'base'
      } else {
        // 子表必须跟在同名 base 后面；找不到就当没看见（TOML 本身也不合法）
        current = blocks.get(name) ?? null
        section = current ? sub : null
      }
      comments.length = 0
      continue
    }
    if (/^\s*\[/.test(line)) { // 其它 section：结束当前 group，但保留注释缓冲给下一段
      current = null
      section = null
      comments.length = 0
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      comments.push(trimmed)
      continue
    }
    if (!trimmed) { comments.length = 0; continue }
    if (!current || !section) { comments.length = 0; continue }
    // 重复 group：TOML 本身不合法，后续键一律不采信（保持 paths/template = null）
    if (current.duplicate) { comments.length = 0; continue }
    const eq = trimmed.indexOf('=')
    if (eq <= 0) { comments.length = 0; continue }
    const key = trimmed.slice(0, eq).trim()
    const value = valueOf(trimmed.slice(eq + 1))
    if (section === 'base' && key === 'paths') {
      current.paths = arrayOf(value)
    } else if (section === 'note' && key === 'template') {
      current.template = unquote(value)
    }
    comments.length = 0
  }
  return blocks
}

function unquote(value: string): string | null {
  if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return null
}

/** 组头是否是 dsh-zdiary-kit 自己写的（有它才允许 `--fix` 改） */
export function isPluginOwned(block: GroupBlock): boolean {
  return !!block.comment && block.comment.includes('dsh-zdiary-kit')
}

/** 路径归一化：`./notes/` 与 `notes` 是同一个目录 */
export function normGroupPath(rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '')
  return clean === '.' ? '' : clean
}

/**
 * 两条路径是不是同一个目录（`./notes/` 与 `notes` 算同一个）。
 *
 * 只认「完全一样」：父子目录是**合法**的 —— zk 0.15 按最具体的路径归组，
 * `notes` 与 `notes/concepts` 共存时，子目录里的笔记走后者（真机验证过）。
 * 只有两条路径一模一样时，zk 命中哪个 group 就只剩实现细节了（实测：先定义的那个赢）。
 */
export function sameGroupPath(a: string, b: string): boolean {
  return normGroupPath(a) === normGroupPath(b)
}

/** 两组 paths 是否一致（顺序无关；null 一律不一致） */
export function samePaths(actual: string[] | null, expected: string[]): boolean {
  if (!actual || actual.length !== expected.length) return false
  const a = actual.map(normGroupPath).sort()
  const b = expected.map(normGroupPath).sort()
  return a.every((p, i) => p === b[i])
}
