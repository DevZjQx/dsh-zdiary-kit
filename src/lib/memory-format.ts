/**
 * 记忆条目的格式口径（唯一一份）：memory / dream / lint 都从这里取，
 * 免得「什么算退役」「哪一天算日期」三处各写一遍、下次改措辞只改到一半。
 *
 * 只做机械解析，不做语义判断：
 *   · 条目 = 顶层列表项 + 它的缩进续行（与 MEMORY.md 的书写约定一致）；
 *   · 退役 = 首行 `- [superseded …]`（大小写不敏感）；
 *   · 日期 = 首行里的 `YYYY-MM-DD`，且必须是真实存在的日期（`2026-99-99` 不算）。
 */

/** 顶层列表项；缩进的子项算续行，不另起一条 */
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/
/** 退役条目：`- [superseded 2026-01-01] 旧结论 → [[新结论]]`。必须带 `i`，与 lint 同口径 */
const RETIRED = /^\s*(?:[-*+]|\d+[.)])\s+\[superseded\b/i
/** 只认能机械解析的日期：`YYYY-MM-DD` 且真校验（不是正则通过就算） */
const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/

function validDate(y: string, m: string, d: string): boolean {
  const year = Number(y)
  const month = Number(m)
  const day = Number(d)
  const at = new Date(year, month - 1, day)
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day
}

function firstLine(entry: string): string {
  return entry.split('\n', 1)[0] ?? ''
}

/** 列表条目（含缩进续行）。没有列表项的散文不算条目 —— 那是截断按段落处理的事 */
export function splitMemoryEntries(body: string): string[] {
  const out: string[] = []
  let current: string[] | null = null
  const flush = (): void => {
    if (current) out.push(current.join('\n'))
    current = null
  }
  for (const line of String(body ?? '').split('\n')) {
    if (LIST_ITEM.test(line)) {
      flush()
      current = [line]
    } else if (current && /^\s+\S/.test(line)) {
      current.push(line)
    } else {
      flush()
    }
  }
  flush()
  return out
}

/** true = 条目首行是 `[superseded …]`（大小写不敏感，必须带 i） */
export function isRetiredEntry(entry: string): boolean {
  return RETIRED.test(firstLine(entry))
}

/** 条目首行里的日期；没有或不合法返回 null（`2026-99-99` 不猜成 12 月） */
export function entryDate(entry: string): string | null {
  const m = DATE.exec(firstLine(entry))
  if (!m) return null
  return validDate(m[1], m[2], m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * 去掉退役条目（整条，不留半行），返回正文与删掉的条数。
 * 磁盘上的文件不动 —— 省略只发生在注入路径上；记忆页 / git 仍看得到它们。
 */
export function stripRetiredEntries(body: string): { body: string; count: number } {
  const out: string[] = []
  let count = 0
  let skipping = false
  for (const line of String(body ?? '').split('\n')) {
    if (LIST_ITEM.test(line)) {
      skipping = RETIRED.test(line)
      if (skipping) {
        count += 1
        continue
      }
      out.push(line)
      continue
    }
    if (skipping) {
      // 续行与紧随的空行跟着整条一起走：删条不留空洞
      if (!line.trim() || /^\s+\S/.test(line)) continue
      skipping = false
    }
    out.push(line)
  }
  return { body: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), count }
}

/**
 * 距某天几个本地日历天（不是毫秒差 / 86400000 再取整 —— 夏时制会算出 6.958 天）。
 * 日期不合法返回 null；未来日期返回负数（调用方自己决定怎么报）。
 */
export function daysSinceDate(date: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim())
  if (!m || !validDate(m[1], m[2], m[3])) return null
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((today.getTime() - at.getTime()) / 86_400_000)
}
