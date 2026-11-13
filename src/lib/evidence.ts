/**
 * 结论的可回对依据（只读、机械）：MEMORY 一条结论 → `[[来源]]` 笔记 → 笔记「出处 / 引文」小节里的原话与外部地址。
 *
 * 为什么单独一层：笔记是压缩后的判断，真值在笔记之外。插件不判断「结论对不对」，
 * 只把「拿什么回去对」摆到眼前 —— 没有可回对材料的结论显式记账，不静默（缺口要记账）。
 *
 * 全程纯解析：不写文件、不跑 zk、不进注入载荷、不计记忆预算。有界截断，避免一份长笔记
 * 把整个工具输出撑爆。小节边界按「任意 markdown 标题」，围栏代码块整块跳过（与 fence.ts 同一口径）。
 */
import { parseFrontmatter } from './frontmatter.ts'
import { fenceMask } from './fence.ts'
import { WIKI_LINK } from './wikilink.ts'

/** 单个来源最多几条原话 / 地址 / 下一跳链接 */
export const MAX_EVIDENCE_QUOTES = 3
export const MAX_EVIDENCE_URLS = 3
export const MAX_EVIDENCE_LINKS = 3
/** 单条结论最多读几篇来源笔记（第一跳 + 出处里再走一跳） */
export const MAX_EVIDENCE_SOURCES = 4
/** 单条结论最多追几条 `[[链接]]` */
export const MAX_EVIDENCE_TARGETS = 6
/** 一次做梦最多回几条结论（MEMORY.md 本身受预算约束，这里只兜底） */
export const MAX_EVIDENCE_ENTRIES = 20
/** 原话单行字数上限 */
const MAX_QUOTE_CHARS = 140

/**
 * 认哪些小节当「出处」：中文库的 `## 出处`、SOURCE_TEMPLATE 的 `## Quotes`、
 * 英文库的 `## References` / `## Sources` 都算。别名改这里一处，别在调用方各写一套。
 */
const EVIDENCE_HEADING = /^#{1,6}\s+(出处|来源原文|引文|原文|Quotes?|Sources?|References?|Evidence)\s*$/i
/** 任意标题都是小节边界；`#标签` 这种没有空格的行不算标题 */
const ANY_HEADING = /^#{1,6}\s+/
/** URL 到空白 / 引号 / 括号为止；左右括号与中文标点一并挡掉，别把「（日期）」吞进地址 */
const URL = /https?:\/\/[^\s<>"'`\(\)\]（）【】「」《》」，。；：！？、]+/g
const URL_TAIL = /[.,;:!?，。；：！？、）】》」]+$/
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/

export interface NoteEvidence {
  /** 出处小节里的原话行（去掉列表符号、压空白），最多 MAX_EVIDENCE_QUOTES 条 */
  quotes: string[]
  /** 出处小节里的 http(s) 地址，最多 MAX_EVIDENCE_URLS 条 */
  urls: string[]
  /** 出处小节里的 `[[链接]]` 目标原文，最多 MAX_EVIDENCE_LINKS 条 —— 再走一跳就到原始材料 */
  links: string[]
}

function pushUnique(out: string[], value: string, cap: number): void {
  const v = String(value ?? '').trim()
  if (!v || out.includes(v) || out.length >= cap) return
  out.push(v)
}

/**
 * 从一篇笔记里抽「出处 / 引文」小节的内容。
 *
 * 只读正文（frontmatter 与围栏代码块都不算）；多个同名小节合并，遇到下一个标题就结束。
 * 不判断这段是不是真的原话、也不判断它对不对 —— 那是人和 agent 的事。
 */
export function noteEvidenceOf(content: string): NoteEvidence {
  const body = parseFrontmatter(String(content ?? '')).body
  const lines = body.split('\n')
  const fenced = fenceMask(lines)
  const quotes: string[] = []
  const urls: string[] = []
  const links: string[] = []
  let inside = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (fenced[i]) continue
    if (ANY_HEADING.test(line)) {
      inside = EVIDENCE_HEADING.test(line)
      continue
    }
    if (!inside) continue
    const text = line.replace(LIST_MARK, '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    pushUnique(quotes, text.length > MAX_QUOTE_CHARS ? text.slice(0, MAX_QUOTE_CHARS) + '…' : text, MAX_EVIDENCE_QUOTES)
    for (const m of text.matchAll(URL)) {
      pushUnique(urls, String(m[0]).replace(URL_TAIL, ''), MAX_EVIDENCE_URLS)
    }
    for (const m of text.matchAll(WIKI_LINK)) pushUnique(links, String(m[1] ?? ''), MAX_EVIDENCE_LINKS)
  }
  return { quotes, urls, links }
}
