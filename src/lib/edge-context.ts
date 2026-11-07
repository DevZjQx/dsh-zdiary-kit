/**
 * 一条双链「为什么存在」：链接所在的那一行 + 它所属的 `##` / `###` 小节。
 *
 * 为什么需要（plan §14.1）：`zk_walk` 原来只回邻居的标题 + `lead`，而 `lead` 是邻居首段 ——
 * 同一篇种子的所有出链拿到的是**逐字相同**的第一句，八条边长得一模一样。
 * 卢曼的 Sammelverweise 之所以是枢纽，不是因为一张卡写了 25 个编号，而是因为它写了
 * 「关于 X 见这几处」。没有这一行，1 跳退化成「8 个标题」，和全库无引导随机只差一个过滤条件。
 *
 * 成本：`linkedNotes` 走的是 `zk list --format json`，`rawContent` **已经在传输字节里**
 * （plan §11.2 R8 第 2 条已经记过这笔账），这里只是把被丢掉的那一段用起来 ——
 * 纯内存 / 一次本地读，**不新增 zk 进程**。
 *
 * 口径：只认 wiki 双链与 Markdown 行内链接；找不到就不给这一栏（不猜、不拿「提到了标题」冒充链接）。
 */
import path from 'node:path'
import { normalizeTitle } from './wikilink.ts'

/** 一行的回显上限（码点）：超了截断并留省略号，不把整段正文塞进工具输出 */
const MAX_LINE = 160

const WIKI = /\[\[([^[\]\n]+)\]\]/g
/** Markdown 行内链接 / 图片：[文字](目标 "标题")，目标可带尖括号 */
const MD = /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)[^)\n]*\)/g
const HEADING = /^(#{2,3})\s+(.+?)\s*#*\s*$/

export interface LinkContext {
  /** 最近的上层小节标题（`##` / `###`，已去掉井号）；没有就是空串 */
  section: string
  /** 链接所在行（压空白、截到 MAX_LINE） */
  line: string
}

export interface LinkTarget {
  id?: string
  title: string
  path: string
}

/** `[[x|别名#节]]` 取 `x`；`<a%20b.md>` 去尖括号 */
function destOf(rawLink: string): string {
  return String(rawLink ?? '').split('|')[0]!.split('#')[0]!.trim().replace(/^<|>$/g, '')
}

/** 链接目标是否指向这篇笔记：稳定 id / 标题 / 相对路径 / 文件名 stem 四种写法 */
function pointsAt(dest: string, target: LinkTarget, sourcePath: string): boolean {
  const raw = destOf(dest).replace(/\\/g, '/').replace(/^\.\//, '')
  if (!raw) return false
  if (target.id && raw === target.id) return true
  // Markdown 链接可能是相对当前文件的位置：按源文件所在目录解析，避免 ../ 形态漏认
  const joined = raw.startsWith('/') ? raw.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), raw))
  const noExt = joined.replace(/\.(md|markdown)$/i, '')
  const wantPath = normalizeTitle(target.path.replace(/\.(md|markdown)$/i, ''))
  const wantTitle = normalizeTitle(target.title)
  const wantStem = normalizeTitle(path.posix.basename(target.path, path.posix.extname(target.path)))
  const got = normalizeTitle(noExt)
  if (got === wantPath || got === wantTitle) return true
  return normalizeTitle(path.posix.basename(noExt)) === wantStem
}

/** 压空白 + 截断；截断用可见的省略号，不静默少字 */
function clip(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > MAX_LINE ? chars.slice(0, MAX_LINE).join('') + '…' : flat
}

/**
 * 在 `markdown` 里找到「指向 target」的那一行。`sourcePath` 是 `markdown` 所属笔记的相对路径
 * （用来解析 Markdown 链接的相对目标）。
 *
 * 找不到返回 null —— 链接可能写成纯文本、也可能被重写过，这两种情况都不该编一行出来。
 */
export function linkContextOf(markdown: string, target: LinkTarget, sourcePath: string): LinkContext | null {
  const content = String(markdown ?? '')
  if (!content.trim()) return null
  let section = ''
  let fence = false
  for (const line of content.split('\n')) {
    // 代码块里的 `[[...]]` 是例子，不是链接
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue }
    if (fence) continue
    const heading = line.match(HEADING)
    if (heading) { section = heading[2]!.trim(); continue }
    let hit = false
    for (const m of line.matchAll(WIKI)) {
      if (pointsAt(m[1] ?? '', target, sourcePath)) { hit = true; break }
    }
    if (!hit) {
      for (const m of line.matchAll(MD)) {
        if (pointsAt(m[1] ?? '', target, sourcePath)) { hit = true; break }
      }
    }
    if (hit) return { section, line: clip(line) }
  }
  return null
}
