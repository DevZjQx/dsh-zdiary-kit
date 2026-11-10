/**
 * Markdown 围栏代码块的唯一口径：渲染、时间轴、记忆切分、双链上下文、链接重写都从这里取。
 *
 * 之前每个模块各写一份 `^\s*``` `，认不认 `~~~`、几个反引号、闭合要不要同字符全不一样，
 * 于是同一份笔记在只读视图里被解析成链接、在记忆里被当成可丢弃条目。口径（CommonMark + zk.ts 原有实现）：
 *   · 行首 0–3 个空格 + ≥3 个同字符的 ` 或 ~ 才是围栏标记行，多余的前导空白不算；
 *   · 闭合行必须与开启行同字符、长度 ≥ 开启行，且不带 info（语言标记）；
 *   · 围栏标记行与块内每一行都算「围栏内」—— 所有调用方都按这个口径跳过。
 */

export interface FenceMarker {
  char: '`' | '~'
  /** 围栏字符个数（≥3） */
  len: number
  /** 标记行里围栏之后的文字；开启行是语言标记，闭合行必须为空 */
  info: string
}

/** 一行是不是围栏标记行；不是返回 null */
export function fenceMarker(line: string): FenceMarker | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(String(line ?? ''))
  if (!m) return null
  const run = m[1] ?? ''
  return { char: run[0] === '~' ? '~' : '`', len: run.length, info: (m[2] ?? '').trim() }
}

/**
 * 每行是否属于围栏代码块（含开启 / 闭合标记行本身）。
 * 闭合行必须同字符、长度 ≥ 开启行且无 info：块内出现的 ```js 只是代码，不是闭合。
 */
export function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = []
  let open: FenceMarker | null = null
  for (const line of lines) {
    const m = fenceMarker(line)
    if (open) {
      mask.push(true)
      if (m && m.char === open.char && m.len >= open.len && !m.info) open = null
    } else {
      mask.push(Boolean(m))
      if (m) open = m
    }
  }
  return mask
}

/** 去掉围栏里的行，其余原样拼回（用于只扫「真正文」的正则匹配） */
export function withoutFences(text: string): string {
  const lines = String(text ?? '').split('\n')
  const mask = fenceMask(lines)
  return lines.filter((_, i) => !mask[i]).join('\n')
}
