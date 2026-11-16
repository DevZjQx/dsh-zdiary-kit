/**
 * `zk-kit tidy`：收掉旧笔记正文里与 frontmatter `tags` 重复的标签段。
 *
 * 为什么要有这一步：写路径从 v3.x 起只写 frontmatter（`placeTags`），新笔记不再产生第二份；
 * 但**已存在的笔记**没有修复入口 —— 只清一本库治不了别的库。lint 负责让债可见，
 * 这里负责把它收掉，两边共用 `body-tags.ts` 的同一份判据。
 *
 * 三条边界，都是为了「不改结论、不丢标签」：
 *   · 只删**整段只有 hashtag** 的段落；句子里的 `#tag` 不是目标；
 *   · 只删 frontmatter 已覆盖的（子集判据）—— 正文有、frontmatter 没有的标签是漂移，
 *     删了会丢标签、并集会复活旧词，交人裁；
 *   · 没有 `tags` 格（flat / 自定义模板）的笔记一个字不碰：正文标签是 zk 唯一的索引来源。
 * 默认预演，`--fix` 才落盘；跳过 raw / archive / journal 与根目录 meta。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import { markIndexDirty, scanNotes } from './zk.ts'
import { isMetaPath } from './meta.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { stripTagParagraphs, tagCleanup } from './body-tags.ts'
import { isUnderDir } from './zk.ts'

/** 与巡检同一个读盘上限：命令不该把一个大文件拉进内存 */
const TIDY_MAX_BYTES = 1024 * 1024

export interface TidyTagNote {
  path: string
  title: string
  /** 可删的纯标签段数 */
  paragraphs: number
  /** 这些段里的标签（去重、保序） */
  tags: string[]
}

export interface TidyTagDrift {
  path: string
  title: string
  /** 正文写了、frontmatter 没有的标签 */
  tags: string[]
}

export interface TidyTagsResult {
  /** true = 只报了计划，没有改文件 */
  dryRun: boolean
  /** 这次扫过并读过盘的笔记数 */
  scanned: number
  /** true = 笔记数触到扫描上限，结果不完整（只会漏收，不会误收） */
  truncated: boolean
  /** 没读的篇数（文件过大 / 读不出来）：不静默，输出里点名 */
  skipped: number
  /** 可收的篇数 */
  notes: number
  /** 可收的标签段总数 */
  paragraphs: number
  /** 实际写盘的篇数（dryRun 时恒为 0） */
  changed: number
  items: TidyTagNote[]
  /** 人裁：正文标签不在 frontmatter（不自动改） */
  drift: TidyTagDrift[]
}

/**
 * 扫全库并按判据收标签段。幂等：清过的笔记下一次不再出现。
 *
 * 扫的是 zk 索引里的活笔记（`scanNotes` 已排除 raw / archive / meta），再按 dailyDir 跳过日记：
 * 日记模板没有 `tags` 格，正文 hashtag 在日记里是自由写法，不是要收的债。
 */
export async function tidyTags(
  cfg: Config,
  opts: { dryRun?: boolean } = {},
  signal?: AbortSignal,
): Promise<TidyTagsResult> {
  const dryRun = opts.dryRun !== false
  const scan = await scanNotes(cfg, {}, signal)
  const notes = scan.notes
  const items: TidyTagNote[] = []
  const drift: TidyTagDrift[] = []
  let scanned = 0
  let skipped = 0
  let paragraphs = 0
  let changed = 0
  for (const note of notes) {
    if (isMetaPath(note.path) || isUnderDir(note.path, cfg.dailyDir)) continue
    const abs = note.absPath ? path.resolve(note.absPath) : path.resolve(cfg.notebook, note.path)
    let content = ''
    try {
      if (fs.statSync(abs).size > TIDY_MAX_BYTES) { skipped += 1; continue }
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    scanned += 1
    const cleanup = tagCleanup(content)
    if (!cleanup) continue
    if (!cleanup.removable) {
      // 漂移只报：删段会丢标签，并集会把旧词复活 —— 两个动作都需要人裁
      drift.push({ path: note.path, title: note.title, tags: cleanup.drift })
      continue
    }
    items.push({
      path: note.path,
      title: note.title,
      paragraphs: cleanup.paragraphs.length,
      tags: cleanup.tags,
    })
    paragraphs += cleanup.paragraphs.length
    if (dryRun) continue
    const next = stripTagParagraphs(content, cleanup.paragraphs)
    // 兜底：删完标签段必须还在 frontmatter 里；形状一变就放弃这一篇，别写坏文件
    if (next === content || !('tags' in parseFrontmatter(next).fields)) continue
    try {
      fs.writeFileSync(abs, next, 'utf8')
      markIndexDirty(cfg)
      changed += 1
    } catch {
      // 单篇写失败不该让整次清理看起来失败：计划里已经列出它，下一轮还会进来
      skipped += 1
    }
  }
  return {
    dryRun,
    scanned,
    truncated: scan.completeness !== 'complete',
    skipped,
    notes: items.length,
    paragraphs,
    changed,
    items,
    drift,
  }
}
