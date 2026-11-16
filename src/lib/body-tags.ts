/**
 * 正文里的「纯标签段」：整段只有 `#a #b`，一个字的正文都没有。
 *
 * 这是 frontmatter `tags` 的第二份真相 —— 模板带 `tags: []` 之后，`zk-new` 已经只写
 * frontmatter（见 `frontmatter.ts` 的 `placeTags`），但旧版本 / 手工写入的笔记还留着正文那行。
 * 两份同时存在时 zk 取并集：只改 frontmatter 不会让旧标签失效，删掉的标签还能被 `--tag` 命中，
 * 人读正文却对不上。所以 lint 要报、`zk-kit tidy` 要能收掉。
 *
 * 口径只写这一份：lint（只报告）与 tidy（默认预演、--fix 落盘）必须同一个判据，
 * 否则「体检说 3 篇」与「命令清 5 篇」会各说各话。
 */
import { fenceMask } from './fence.ts'
import { formatFlowList, parseFlowList, parseFrontmatter, setFrontmatter } from './frontmatter.ts'

/**
 * 整行只有 hashtag：`#a`、`#a #b`、`#中文-标签`。
 * 必须整行匹配 —— 正文句子里的 `#tag` 不是标签段，不能当可删目标。
 * 字符集与 zk 的 hashtag 解析一致（`\p{L}\p{N}_-`），别让「体检认得、zk 不认」。
 */
const TAG_LINE = /^[ \t]*#[\p{L}\p{N}_-]+(?:[ \t]+#[\p{L}\p{N}_-]+)*[ \t]*\r?$/u

const TAG_TOKEN = /#([\p{L}\p{N}_-]+)/gu

export interface TagParagraph {
  /** 起始行（0 基，含 frontmatter 之后的行号） */
  start: number
  /** 结束行（0 基，含） */
  end: number
  tags: string[]
}

export interface TagCleanup {
  /** 正文里的纯标签段（按行号升序） */
  paragraphs: TagParagraph[]
  /** 正文标签（去重、保序） */
  tags: string[]
  /** frontmatter 已有的标签 */
  frontmatterTags: string[]
  /** 正文写了、frontmatter 没有的标签：删段会丢标签，并集又会复活旧词 —— 只能人裁 */
  drift: string[]
  /** true = frontmatter 已覆盖全部正文标签，删段不改变有效标签 */
  removable: boolean
}

/**
 * 找正文里的纯标签段。
 *
 * 跳过三类位置：frontmatter、围栏代码块、以及正文第一行（无空格的 `#标题` 在 zk 眼里是
 * hashtag，但结构上它是 H1 —— 删掉等于删标题，宁可不碰）。
 * 连续多行标签算一段；空行分开的两行标签算两段（两段都删，空行一并收掉）。
 */
export function findTagParagraphs(content: string): TagParagraph[] {
  const text = String(content ?? '')
  const lines = text.split('\n')
  const body = parseFrontmatter(text).body
  const bodyStart = lines.length - body.split('\n').length
  const bodyLines = lines.slice(bodyStart)
  const mask = fenceMask(bodyLines)
  const out: TagParagraph[] = []
  let firstContent = true
  let current: TagParagraph | null = null
  const flush = (): void => {
    if (current) out.push(current)
    current = null
  }
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i] as string
    if (line.trim() === '') { flush(); continue }
    if (mask[i] || !TAG_LINE.test(line)) {
      flush()
      firstContent = false
      continue
    }
    // 正文的第一处内容不碰：`#标题`（无空格）与标签行同形，结构上却是标题
    if (firstContent) { firstContent = false; continue }
    const tags = [...line.matchAll(TAG_TOKEN)].map((m) => m[1] as string)
    if (!tags.length) { flush(); continue }
    const start = bodyStart + i
    if (current && current.end === start - 1) {
      current.end = start
      current.tags.push(...tags)
    } else {
      flush()
      current = { start, end: start, tags }
    }
  }
  flush()
  return out
}

/**
 * 这篇笔记的正文标签能不能收：只有 frontmatter 有可解析的 `tags` 格才判定。
 *
 * `null` 有三种情况，含义都是「别动」：没有 `tags` 格（flat / 自定义模板，正文标签是
 * zk 唯一的索引来源）、`tags` 值不是 flow 列表（块式列表猜错一次就是写坏 frontmatter）、
 * 正文没有纯标签段。
 */
export function tagCleanup(content: string): TagCleanup | null {
  const fields = parseFrontmatter(content).fields
  if (!('tags' in fields)) return null
  const frontmatterTags = parseFlowList(fields.tags ?? '')
  if (frontmatterTags === null) return null
  const paragraphs = findTagParagraphs(content)
  if (!paragraphs.length) return null
  const tags = [...new Set(paragraphs.flatMap((p) => p.tags))]
  const known = new Set(frontmatterTags)
  const drift = tags.filter((tag) => !known.has(tag))
  return { paragraphs, tags, frontmatterTags, drift, removable: drift.length === 0 }
}

/** 把标签并进 frontmatter 的 `tags` 格（保留已有顺序，新标签追加在后）；形状不认识时原样返回 */
export function mergeTagsIntoFrontmatter(content: string, tags: readonly string[]): string {
  const fields = parseFrontmatter(content).fields
  const existing = parseFlowList(fields.tags ?? '')
  if (existing === null) return content
  const merged = [...existing]
  for (const tag of tags) if (!merged.includes(tag)) merged.push(tag)
  return setFrontmatter(content, { tags: formatFlowList(merged) })
}

/**
 * 删掉指定的标签段，并收掉段后紧跟的空行（否则正文与 `## Links` 之间会留双空行）。
 * 只动这些行：其余行原样拼回，frontmatter 与围栏代码块不会被重排。
 */
export function stripTagParagraphs(content: string, paragraphs: readonly TagParagraph[]): string {
  if (!paragraphs.length) return content
  const lines = String(content ?? '').split('\n')
  const gone = new Uint8Array(lines.length)
  for (const p of paragraphs) {
    for (let i = p.start; i <= p.end; i++) if (i >= 0 && i < lines.length) gone[i] = 1
  }
  const keep: string[] = []
  let justRemoved = false
  for (let i = 0; i < lines.length; i++) {
    if (gone[i]) { justRemoved = true; continue }
    // 段后空行：删段时一并收掉，保留原来那一个分隔空行（段前那个）
    if (justRemoved && (lines[i] as string).trim() === '') continue
    justRemoved = false
    keep.push(lines[i] as string)
  }
  return keep.join('\n')
}
