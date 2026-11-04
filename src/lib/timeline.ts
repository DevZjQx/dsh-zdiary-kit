/**
 * 日记时间轴校验（v3.1 M0）：只报告，不改文件（计划 §2 D1 / D2 / D5）。
 *
 * 为什么单独一层：日记的 `## HH:MM` / `### HH:MM` 是人的工作面，空块、倒序、层级混用
 * 都不会让 zk 报错，也不会影响检索 —— 只会让时间轴慢慢读不出顺序。自动重排会改正文顺序，
 * diff 不可审，所以这里只产出问题清单，修不修由人或 agent 决定。
 *
 * 两种结构分开判：
 *   · layered（有 `## Events`，大小写不敏感）：时间条目必须是 `### HH:MM`，且落在 Events 与下一个 `##` 之间；
 *   · flat（没有 `## Events`）：时间条目必须是 `## HH:MM`，按文件顺序追加。
 * 统一要求 `## Events` 会让所有 flat 日记一次性全红，所以用第一个 `## Events` 决定结构。
 * 大小写不敏感是为了跟 `appendDaily` 对齐：`sectionRange` 用 `/^##\s+Events\s*$/i` 找小节，
 * 这里若区分大小写，`## EVENTS` 会被判成 flat、然后 `### HH:MM` 全报位置错。
 */
export type TimelineIssueKind = 'empty' | 'order' | 'format' | 'placement'

export interface TimelineIssue {
  /** 文件原文行号（从 1 开始；frontmatter / 围栏代码同样占行） */
  line: number
  kind: TimelineIssueKind
  /** 原始标题文本（不带 #） */
  title: string
  /** 人读原因 */
  detail: string
}

export type TimelineStructure = 'auto' | 'layered' | 'flat'

/** 合法时间标题：00:00–23:59，可跟全角 / 半角括号标题 */
const TIME_TITLE = /^(?:[01]\d|2[0-3]):[0-5]\d(?:\s*[（(].*[）)])?$/
/** 看起来像时间（用于抓 11:5x / 9:5 / 24:00 / 12:60 / 12:45 标题）：格式错也要报 */
const TIME_LIKE = /^\d{1,2}:\d{1,2}/
/** ATX 标题；不认 Setext（日记不用那种写法，认了反而把分隔线当标题） */
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/
/** ATX 收尾井号是装饰（`### 12:00 ##` 的标题仍是 `12:00`），与 zk 的 atxHeading 同口径 */
const CLOSING_HASHES = /[ \t]+#+$/
const FENCE = /^\s{0,3}(?:```|~~~)/

/**
 * 按行遮掉 frontmatter 与围栏代码：内容换成空行，行号保持不变。
 * 不这样做，围栏里的示例 `## 12:00` 会被当成真的时间条目。
 */
function maskLines(body: string): string[] {
  const lines = String(body ?? '').split('\n')
  const masked = lines.slice()

  // frontmatter 只在文件最开头；找不到闭合行就整份不剥（和 zk 的容错口径一致）
  if ((lines[0] ?? '').trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === '---' || (lines[i] ?? '').trim() === '...') {
        for (let j = 0; j <= i; j++) masked[j] = ''
        break
      }
    }
  }

  let inFence = false
  for (let i = 0; i < masked.length; i++) {
    if (FENCE.test(masked[i] ?? '')) {
      masked[i] = ''
      inFence = !inFence
      continue
    }
    if (inFence) masked[i] = ''
  }
  return masked
}

interface ParsedHeading {
  index: number
  line: number
  level: number
  title: string
}

function parseHeadings(lines: string[]): ParsedHeading[] {
  const out: ParsedHeading[] = []
  for (let i = 0; i < lines.length; i++) {
    const hit = HEADING.exec(lines[i] ?? '')
    if (!hit) continue
    out.push({
      index: i,
      line: i + 1,
      level: (hit[1] ?? '').length,
      title: (hit[2] ?? '').replace(CLOSING_HASHES, '').trim(),
    })
  }
  return out
}

function minutesOf(title: string): number | null {
  const hit = /^(\d{2}):(\d{2})/.exec(title)
  if (!hit) return null
  return Number(hit[1]) * 60 + Number(hit[2])
}

/** 标题到下一个同级 / 更高级标题之间有没有非空行 */
function isEmptyBlock(lines: string[], headings: ParsedHeading[], at: number): boolean {
  const current = headings[at]
  if (!current) return false
  const next = headings[at + 1]
  const end = next && next.level <= current.level ? next.index : lines.length
  for (let i = current.index + 1; i < end; i++) {
    if ((lines[i] ?? '').trim() !== '') return false
  }
  return true
}

/**
 * 时间轴问题清单（最多 `max` 条）。
 *
 * 判据：合法时间标题才参与倒序 / 空块；格式错的标题只报 format，不参与排序，
 * 免得把「11:5x」既算格式错又算倒序。同一分钟相邻不报重复。
 */
export function timelineIssues(
  body: string,
  structure: TimelineStructure = 'auto',
  max = 50,
): TimelineIssue[] {
  const lines = maskLines(body)
  const headings = parseHeadings(lines)
  const issues: TimelineIssue[] = []

  // 与 appendDaily 的 sectionRange 同口径（大小写不敏感）：否则 `## EVENTS` 会被判成 flat
  const eventsAt = headings.findIndex((h) => h.level === 2 && h.title.toLowerCase() === 'events')
  const events = eventsAt >= 0 ? headings[eventsAt] : null
  const mode: 'layered' | 'flat' = structure === 'auto'
    ? (events ? 'layered' : 'flat')
    : structure

  let eventsEnd = lines.length
  if (mode === 'layered' && events) {
    for (let i = eventsAt + 1; i < headings.length; i++) {
      if ((headings[i]?.level ?? 7) <= 2) {
        eventsEnd = headings[i]?.index ?? lines.length
        break
      }
    }
  }

  interface TimeEntry {
    heading: ParsedHeading
    headingIndex: number
    /** 位置与层级都正确，才参与倒序 / 空块 */
    inPlace: boolean
    minutes: number | null
  }
  const entries: TimeEntry[] = []

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i] as ParsedHeading
    if (!TIME_LIKE.test(h.title)) continue
    const valid = TIME_TITLE.test(h.title)

    if (!valid) {
      issues.push({
        line: h.line,
        kind: 'format',
        title: h.title,
        detail: '格式：时间必须是两位 HH:MM（00:00–23:59）；要加说明就写在括号里',
      })
      continue
    }

    const inEvents = Boolean(events) && h.index > (events?.index ?? -1) && h.index < eventsEnd
    let inPlace = true
    if (mode === 'layered') {
      const levelOk = h.level === 3
      if (!levelOk || !inEvents) {
        inPlace = false
        const why = !levelOk && !inEvents
          ? '层级应为 ###，且不在 ## Events 下'
          : !levelOk
            ? `层级应为 ###（当前是 ${'#'.repeat(h.level)}）`
            : '不在 ## Events 下'
        issues.push({
          line: h.line,
          kind: 'placement',
          title: h.title,
          detail: `位置：${why}`,
        })
      }
    } else if (h.level !== 2) {
      inPlace = false
      issues.push({
        line: h.line,
        kind: 'placement',
        title: h.title,
        detail: `位置：层级应为 ##（当前是 ${'#'.repeat(h.level)}）`,
      })
    }

    if (inPlace) {
      entries.push({ heading: h, headingIndex: i, inPlace, minutes: minutesOf(h.title) })
    }
  }

  // 空块：只看位置正确的条目；下一个同级 / 更高级标题前没有非空行就是空
  for (const entry of entries) {
    if (!isEmptyBlock(lines, headings, entry.headingIndex)) continue
    issues.push({
      line: entry.heading.line,
      kind: 'empty',
      title: entry.heading.title,
      detail: '空块：时间标题下没有正文',
    })
  }

  // 倒序：只报 t < prev（同分钟允许），按文档顺序比较
  let prev: TimeEntry | null = null
  for (const entry of entries) {
    if (entry.minutes === null) continue
    if (prev && prev.minutes !== null && entry.minutes < prev.minutes) {
      issues.push({
        line: entry.heading.line,
        kind: 'order',
        title: entry.heading.title,
        detail: `倒序：${entry.heading.title} 排在 ${prev.heading.title} 之后`,
      })
    }
    prev = entry
  }

  issues.sort((a, b) => a.line - b.line)
  return issues.slice(0, max)
}

/** 四类计数；页面与 lint 的汇总共用一份口径 */
export function timelineCounts(issues: TimelineIssue[]): Record<TimelineIssueKind, number> {
  const counts: Record<TimelineIssueKind, number> = { empty: 0, order: 0, format: 0, placement: 0 }
  for (const issue of issues) counts[issue.kind] += 1
  return counts
}

const KIND_LABEL: Record<TimelineIssueKind, string> = {
  empty: '空块',
  order: '倒序',
  format: '格式',
  placement: '位置',
}

/** `时间轴：12 处（空块 5 · 倒序 2 · 格式 1 · 位置 4）`；没有问题时返回空串 */
export function timelineSummary(issues: TimelineIssue[], subject = '时间轴'): string {
  if (issues.length === 0) return ''
  const counts = timelineCounts(issues)
  const parts = (Object.keys(KIND_LABEL) as TimelineIssueKind[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${KIND_LABEL[kind]} ${counts[kind]}`)
  return `${subject}：${issues.length} 处（${parts.join(' · ')}）`
}
