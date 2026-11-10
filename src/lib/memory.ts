/**
 * 记忆注入（M1）：读 vault 根目录的 AGENTS.md / USER.md / MEMORY.md，
 * 按 `memoryBudgetWords` 截断，渲染成一段可注入系统提示的文本。
 * 另读 DREAMS.md 的「上次做梦」一行（不进正文、不计预算），给周节奏一句机械提醒。
 * 人格层（PERSONA.md）单独一段注入、永远在记忆段之前、不参与截断，
 * 超上限只告警；缺文件 = 未启用，0.9 的老库逐字节不变。
 *
 * 硬约定：
 *   · 预算按**总载荷**算，不是只卡 MEMORY.md；
 *   · 切分按三级降级：`##` 小节 → 顶层列表项 → 空行段落。只有 `##` 一级时，
 *     `# 记忆` + 要点列表（最常见的写法）一个小节都切不出来，预算会整个失效 —— 见 P0-1；
 *   · 截断顺序纯机械：先丢 MEMORY 里**日期最旧**的一条（都没有日期才退回尾部整条），
 *     再丢 USER 的尾部整段，最后各自只留首段；AGENTS.md 是硬规则，永不截断（单独超预算时只告警）；
 *   · 退役条目（`- [superseded …]`）磁盘保留、注入省略 —— 它们按约定退役，不该继续占预算；
 *   · 丢掉的段落留一份**目录**（段落标题，计入预算），agent 用原生 read 取回正文 ——
 *     选哪段是 agent 按当前任务判断，插件只搬运目录，不猜相关性；
 *   · 中文按「1 词 / 2 字」计 —— 空白切分在中文上严重低估，预算会变成装饰。
 *
 * 另有一条可观测性约定（D6 的补完）：截断不只回显「截了多少」，还要能解释「谁吃掉的」——
 * 否则用户只看到 MEMORY 常年不生效，排查会跑去怀疑注入没挂载（见 notice 里的 AGENTS 归因）。
 *
 * 读文件失败一律当作「没有这份文件」：老 vault 没有这些文件也能照常工作。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config/store.ts'
import { DREAM_INTERVAL_DAYS, daysSinceDream, lastDreamDate } from './dream.ts'
import { fenceMask } from './fence.ts'
import { fileStamp } from './file-stamp.ts'
import { entryDate, isRetiredEntry, memoryFormatDebt, splitMemoryEntries, stripRetiredEntries } from './memory-format.ts'
import type { MemoryFormatDebt } from './memory-format.ts'
import { templateVersionOf } from './agents-template.ts'
import { PERSONA_META_FILES, MEMORY_META_FILES } from './meta.ts'
import type { MetaName } from './meta.ts'

/** vault 根目录下、按优先级排列的三份 meta 文件（定义在 lib/meta.ts，这里只挂个本地名） */
export const META_FILES = MEMORY_META_FILES
export type { MetaName }

export interface MemoryFileInfo {
  name: MetaName
  present: boolean
  /** 实际进入载荷的词数（截断后） */
  words: number
  /** 磁盘原词数（含退役条目）—— 展示「原 X」时先减 retiredWords，才只反映截断 */
  originalWords: number
  /** 退役条目占掉的词数（磁盘保留、注入省略；只有 MEMORY.md 可能 > 0） */
  retiredWords: number
}

/** 人格文件（PERSONA.md）的一份 */
export interface PersonaFileInfo {
  name: (typeof PERSONA_META_FILES)[number]
  present: boolean
  words: number
}

/** 人格段：永远注入、不参与 MEMORY 截断；超上限只告警 */
export interface PersonaSegment {
  present: boolean
  /** 人格正文词数（含 `## PERSONA.md` 标题，不含告警行）—— 上限判断用这个 */
  contentWords: number
  /** 人格段在载荷里的总词数（contentWords + 告警行） */
  words: number
  /** 告警行占的词数（0 = 没超人格上限） */
  noticeWords: number
  budget: number
  overBudget: boolean
  /** contentWords - budget（0 = 没超）；各处显示统一用它，别拿 words 做减法 */
  overWords: number
  files: PersonaFileInfo[]
}

export interface MemoryPayload {
  /** 可直接注入的完整文本；人格 + 记忆都不存在时是空串 */
  text: string
  words: number
  budget: number
  /** words / budget（两位小数；> 1 = 超预算，通常是 AGENTS.md 自己就超了） */
  ratio: number
  /** 被截掉的正文词数（不含目录；0 = 完整注入） */
  truncatedWords: number
  /** 退役条目的词数（磁盘保留、注入省略；不算截断） */
  retiredWords: number
  /** 退役条目的条数（与 `zk_lint.memoryLinks.retired` 同一口径） */
  retiredEntries: number
  /** 截断目录占用的词数（0 = 没有目录） */
  tocWords: number
  /** 记忆的格式债（与注入提示、`zk_lint` 同一个 `memoryFormatDebt`）：退役条目不算 */
  formatDebt: MemoryFormatDebt
  /** AGENTS.md 的模板版本；0 = 没有标记，或根本没有 AGENTS.md（记忆页用 `files[].present` 区分）。只读首行标记，不跑 lint */
  templateVersion: number
  files: MemoryFileInfo[]
  persona: PersonaSegment
  /** 模型真正收到的总量（countWords(text)，含框 / 做梦提醒 / notice / 人格告警） */
  totalWords: number
  /** totalWords - 人格正文 - 记忆内容：框、做梦提醒、notice 与人格告警的开销 */
  overheadWords: number
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g

/** 给 doctor / 设置页共用：`AGENTS 193 · USER 30 · MEMORY 22（原 82）（退役 10）`。
 *  「原 X」只反映截断（已扣退役）；退役是磁盘保留、注入省略，单列一个括号 —— 两者不再混成一个数。 */
export function formatFileShares(files: MemoryFileInfo[], tocWords = 0): string {
  const parts = files
    .filter((f) => f.present || f.retiredWords > 0)
    .map((f) => {
      const label = f.name.replace(/\.md$/i, '')
      const kept = Math.max(0, f.originalWords - f.retiredWords)
      const truncated = kept > f.words ? `（原 ${kept}）` : ''
      const retired = f.retiredWords > 0 ? `（退役 ${f.retiredWords}）` : ''
      return `${label} ${f.words}${truncated}${retired}`
    })
  if (tocWords > 0) parts.push(`目录 ${tocWords}`)
  return parts.join(' · ')
}

/** 词数：CJK 按 2 字 1 词，其余按空白切分 */
export function countWords(text: string): number {
  if (!text) return 0
  const cjk = (text.match(CJK) ?? []).length
  const latin = text.replace(CJK, ' ').split(/\s+/).filter(Boolean).length
  return Math.ceil(cjk / 2) + latin
}

interface DroppedSection {
  name: MetaName
  title: string
  /** 原文件里的字符偏移（`pristine.indexOf(...)`）：按日期丢条目后要按原顺序重建目录 */
  order?: number
}

/** 目录最多列几段：再多就只给「还有 N 段」，免得目录自己把预算吃掉 */
const TOC_MAX = 5
/** 目录里单条标题最多多长（条目可能是一整句结论） */
const TOC_TITLE_MAX = 40
/** 到预算的这个比例就回显用量：等到截断才说，已经是最坏的时刻 */
const MEMORY_NEAR_RATIO = 0.8

type SplitMode = 'sections' | 'items' | 'paragraphs'

interface Split {
  head: string
  sections: string[]
  mode: SplitMode
}

/** 二级小节（原有切分口径） */
const SECTION = /^##\s+/
/** 顶层列表项；缩进的子项算续行，不另起一条 */
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/

function finishSplit(head: string[], sections: string[][], mode: SplitMode): Split {
  return {
    head: head.join('\n').trim(),
    sections: sections.map((s) => s.join('\n').trim()).filter(Boolean),
    mode,
  }
}

/** 顶层列表项切分：缩进续行归上一条，围栏里的 `- ` 不算（与 1b / 单节降级共用） */
function splitItems(lines: string[]): { head: string[]; items: string[][] } {
  const head: string[] = []
  const items: string[][] = []
  let current: string[] | null = null
  const fenced = fenceMask(lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!fenced[i] && LIST_ITEM.test(line)) {
      if (current) items.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    } else {
      head.push(line)
    }
  }
  if (current) items.push(current)
  return { head, items }
}

/**
 * 单节再切一层（P0-2）：小节标题并进 head（永不丢），正文按顶层列表项切；
 * 不足两条就保持原样 —— 只有一条时没有可丢的粒度，交给「预算不足」照旧点名。
 * 初次切分与「丢到只剩一节」都走这一个函数，保证两条路径同形。
 */
function degradeSingleSection(split: Split): Split | null {
  if (split.mode !== 'sections' || split.sections.length !== 1) return null
  const [title, ...rest] = split.sections[0].split('\n')
  const inner = splitItems(rest)
  if (inner.items.length < 2) return null
  const head = [split.head, title, inner.head.join('\n').trim()].filter(Boolean).join('\n\n')
  return finishSplit([head], inner.items, 'items')
}

/**
 * 三级降级切分（P0-1）：`##` 小节 → 顶层列表项 → 空行段落。
 * 只按 `##` 切时，「`# 记忆` + 要点列表」这种形状切不出任何小节，丢弃循环一次都不进，
 * 预算于是完全不生效（真机 880 / 449 / 895 词都是这个形状）。降级只影响超预算的库：
 * 预算内不调用这个函数的结果做任何改写。
 *
 * 三级都跳过围栏里的行 —— 代码块里的 `- ` 或空行不该被当成可丢弃的条目。
 */
function splitSections(body: string): Split {
  const lines = String(body ?? '').split('\n')
  const fenced = fenceMask(lines)

  // 1a) `##` 小节
  const head: string[] = []
  const sections: string[][] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!fenced[i] && SECTION.test(line)) sections.push([line])
    else if (sections.length > 0) sections[sections.length - 1].push(line)
    else head.push(line)
  }
  if (sections.length > 0) {
    const split = finishSplit(head, sections, 'sections')
    // 只有一节时再降一层（P0-2）：`## 结论` + 一串 `- 结论` 是最常见的形状，
    // 不降级的话丢弃循环一次都不进，整篇绕过预算。
    return split.sections.length === 1 ? degradeSingleSection(split) ?? split : split
  }

  // 1b) 顶层列表项：`# 标题` + 若干 `- 结论` 是 MEMORY.md 最常见的形状。
  // 至少两条才走这一级：只有一条时它更像散文里的一个符号，交给段落切分更不容易整篇卡死。
  const flat = splitItems(lines)
  if (flat.items.length >= 2) return finishSplit(flat.head, flat.items, 'items')

  // 1c) 空行段落：整篇散文也能按段丢。首段作为 head（通常是标题 / 开场），永远保留。
  const paragraphs: string[][] = []
  let para: string[] | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!fenced[i] && !line.trim()) {
      if (para) paragraphs.push(para)
      para = null
      continue
    }
    if (!para) para = [line]
    else para.push(line)
  }
  if (para) paragraphs.push(para)
  const [first, ...rest] = paragraphs
  return finishSplit(first ?? [], rest, 'paragraphs')
}

function joinSections(split: Split): string {
  return [split.head, ...split.sections].filter(Boolean).join('\n\n')
}

/** 只留首段（preamble + 第一个切出来的段）。
 *  单节形状下 splitSections 已经降级成条目，「首段」就是标题 + 第一条 ——
 *  否则这个兜底对单节文件仍等于整篇，等于没裁。 */
function firstSection(body: string): string {
  const split = splitSections(body)
  return joinSections({ head: split.head, sections: split.sections.slice(0, 1), mode: split.mode })
}

/**
 * 下一个该丢的条目：能解析出日期时选**最旧**的一条（同日期按位置靠后的先丢）；
 * 一条日期都解析不出来返回 null —— 调用方退回尾部丢，老库行为不变（D2.6）。
 *
 * 为什么按日期而不是位置：条目约定是「新结论写顶部」，但没人能保证每次都守；
 * 按位置丢会把最新结论先删掉，而那正好是最该留的。
 */
function oldestIndex(split: Split): number | null {
  let best: { index: number; date: string } | null = null
  for (const [index, section] of split.sections.entries()) {
    const date = entryDate(section)
    if (!date) continue
    if (!best || date < best.date || (date === best.date && index > best.index)) {
      best = { index, date }
    }
  }
  return best?.index ?? null
}

function sectionTitle(section: string, mode: SplitMode): string {
  const first = section.split('\n', 1)[0] ?? ''
  const raw = mode === 'sections'
    ? first.replace(/^##\s+/, '')
    : mode === 'items'
      ? first.replace(LIST_ITEM, '')
      : first
  const one = raw.replace(/\s+/g, ' ').trim()
  if (!one) return '（无标题）'
  return one.length > TOC_TITLE_MAX ? one.slice(0, TOC_TITLE_MAX) + '…' : one
}

/**
 * 被截掉段落的目录：代替「按位置丢尾段」的不可见性。
 * 只列标题、不搬运正文，也不列词数 —— 目录自己占预算，紧凑比「信息全」更重要；
 * 选哪段读是 agent 按当前任务判断，插件不猜相关性。
 */
function renderToc(dropped: DroppedSection[], limit: number): string {
  const byFile = new Map<MetaName, string[]>()
  for (const item of dropped.slice(0, limit)) {
    const titles = byFile.get(item.name) ?? []
    titles.push(`§${item.title}`)
    byFile.set(item.name, titles)
  }
  const lines = ['## 未注入的段落（用 read 取回）']
  for (const [name, titles] of byFile) lines.push(`- ${name}：${titles.join('、')}`)
  if (dropped.length > limit) lines.push(`（另有 ${dropped.length - limit} 段）`)
  // 标题也来自文件内容：不转义的话，一个恶意 `## </system-reminder>` 就能提前闭合注入框
  return escapeFrame(lines.join('\n'))
}

/** 目录最多占预算的这个比例：宁可少列几段，也别让索引把正文挤没 */
function tocCapOf(budget: number): number {
  return Math.min(40, Math.max(0, Math.floor(budget * 0.2)))
}

/**
 * 目录按「能放下多少列多少」生成；一段都放不下时返回空串，
 * 由 notice 里的「用 read 读 …」兜底，不让内容彻底静默。
 */
function tocText(dropped: DroppedSection[], cap = Number.POSITIVE_INFINITY): string {
  if (!dropped.length || cap <= 0) return ''
  for (let n = Math.min(TOC_MAX, dropped.length); n >= 1; n--) {
    const text = renderToc(dropped, n)
    if (countWords(text) <= cap) return text
  }
  return ''
}

function readMeta(cfg: Config): Array<{ name: MetaName; body: string }> {
  const out: Array<{ name: MetaName; body: string }> = []
  for (const name of META_FILES) {
    let body = ''
    try {
      body = fs.readFileSync(path.join(cfg.notebook, name), 'utf8').trim()
    } catch { /* 缺文件 = 空 */ }
    out.push({ name, body })
  }
  return out
}

/** 读人格层（PERSONA.md）；缺文件 = 空 = 未启用，不报错 */
function readPersonas(cfg: Config): Array<{ name: (typeof PERSONA_META_FILES)[number]; body: string }> {
  return PERSONA_META_FILES.map((name) => {
    let body = ''
    try {
      body = fs.readFileSync(path.join(cfg.notebook, name), 'utf8').trim()
    } catch { /* 缺文件 = 空 */ }
    return { name, body }
  })
}

function escapeFrame(text: string): string {
  // 文件内容不许提前闭合我们自己的 <system-reminder> 框
  return text.replaceAll('</system-reminder>', '<\\/system-reminder>')
}

/** 载荷框：定义成常量，最终拼装与各处词数统计才能共用同一份文字（否则数出来的词对不上） */
const FRAME_HEAD = '<system-reminder>\n' +
  '以下内容由 zdiary 从知识库根目录读出，是长期约定与记忆；工作约定放在 AGENTS.md，不要写进 MEMORY.md。\n\n'
const FRAME_TAIL = '\n</system-reminder>'

function frameText(body: string): string {
  return FRAME_HEAD + body + FRAME_TAIL
}

/**
 * 「上次做梦」提醒：DREAMS.md 不在注入清单里，但它头部那一行决定周节奏。
 * 只做日期算术（机械活）；整理本身仍然由 agent 按 AGENTS.md 执行 —— 插件没有定时器。
 * 冷启动：没有 DREAMS.md 就说「从未整理过」，否则这套节奏对从没跑过 zk_dream 的库永远不生效。
 * 是否提醒由调用方按「有没有 AGENTS.md」决定：没采用这套工作约定的库不该每步被催。
 */
function dreamNote(cfg: Config): string {
  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'DREAMS.md'), 'utf8') } catch { body = '' }
  if (!body.trim()) return '做梦：从未整理过 —— 先跑一次 zk_dream，再把「上次做梦：YYYY-MM-DD」写进 DREAMS.md'
  const last = lastDreamDate(body)
  if (!last) return '做梦：DREAMS.md 里没有「上次做梦：YYYY-MM-DD」，无法判断该不该整理'
  const days = daysSinceDream(last)
  if (days === null) return '做梦：DREAMS.md 的「上次做梦」不是有效日期'
  const gap = Math.max(0, days)
  const ago = gap === 0 ? '今天' : `${gap} 天前`
  if (gap < DREAM_INTERVAL_DAYS) return `做梦：上次 ${last}（${ago}），未到 ${DREAM_INTERVAL_DAYS} 天`
  return `做梦：上次 ${last}（${ago}），已到 ${DREAM_INTERVAL_DAYS} 天 —— zk_lint → zk_dream → 写 DREAMS.md 并更新这一行`
}

/** 缓存里只放最近几个库：同一进程可能开着多个工作区（各自一个笔记本） */
const PAYLOAD_CACHE_MAX = 8
const payloadCache = new Map<string, MemoryPayload>()

/** DREAMS.md 不进正文，但「上次做梦 N 天前」也算载荷的一部分 —— 它变了同样要重算 */
const STAMPED_FILES = [...PERSONA_META_FILES, ...META_FILES, 'DREAMS.md'] as const

function payloadKeyOf(cfg: Config): string {
  const stamps = STAMPED_FILES.map((name) => `${name}=${fileStamp(path.join(cfg.notebook, name))}`).join('|')
  // 做梦提醒按本地日历天变化（「3 天前」→「4 天前」）：文件没动也得跟着日期失效
  const now = new Date()
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  // 影响这个载荷的预算都要进键：改配置不重新写入任何文件，漏一个就会拿到旧预算的载荷。
  return `${cfg.notebook}|${cfg.memoryBudgetWords}|${cfg.personaBudgetWords}|${day}|${stamps}`
}

/**
 * 生成注入载荷。纯读文件，不调 zk、不建目录：笔记本不存在时返回空载荷。
 *
 * 宿主把它挂在系统提示的 text 函数上 —— **每个 step 都会重新求值**。所以这里带一层
 * 按文件指纹失效的缓存：文件没变（最常见的连续 step）就整个载荷复用，不再重复读盘
 * 与重算词数；改动 MEMORY.md 后下一次求值立刻看得见新内容。
 *
 * @param cfg - 当前配置（只用到 notebook 与 memoryBudgetWords）
 * @returns 载荷；`text === ''` 表示没有可注入的内容
 */
export function buildMemoryPayload(cfg: Config): MemoryPayload {
  const key = payloadKeyOf(cfg)
  const hit = payloadCache.get(key)
  if (hit) return hit
  const value = computePayload(cfg)
  if (payloadCache.size >= PAYLOAD_CACHE_MAX) {
    const oldest = payloadCache.keys().next().value
    if (oldest !== undefined) payloadCache.delete(oldest)
  }
  payloadCache.set(key, value)
  return value
}

/** 真正的计算（无缓存）。词数只算一次：截断只改`original`副本，原文词数始终来自这里。 */
function computePayload(cfg: Config): MemoryPayload {
  const budget = cfg.memoryBudgetWords
  const files = readMeta(cfg)
  // 磁盘原文：files[].originalWords 与记忆页的对齐点，退役条目也算在里面
  const diskWords = new Map(files.map((f) => [f.name, countWords(f.body)]))
  const original = new Map(files.map((f) => [f.name, f.body]))
  // 退役条目：磁盘保留、注入省略（D3）。先去掉，后面的截断只面对活条目。
  const omitted = stripRetiredEntries(original.get('MEMORY.md') ?? '')
  if (omitted.count > 0) original.set('MEMORY.md', omitted.body)
  // 去掉退役行之后的内容词数：用来算「截断了多少」，不把省略算成截断
  const contentWords = new Map(files.map((f) => [f.name, countWords(original.get(f.name) ?? '')]))
  // 截断会改写这份计数；contentWords 保留原值，给 truncatedWords 与 files 用
  const words = new Map(contentWords)
  const total = (): number => [...words.values()].reduce((a, b) => a + b, 0)
  // 截断前的 MEMORY 正文（退役条目已剔除）：格式债要在丢之前数
  const memorySource = original.get('MEMORY.md') ?? ''
  // 格式债（P1）：日期 / 来源缺口的条数。只报告、不补 —— 但得摆到注入里，
  // 否则「按日期淘汰」对没日期的老库永远空转，而 lint 一周才跑一次。
  const debt = memoryFormatDebt(memorySource)
  // 模板版本与记忆页共用这一份（只读首行 marker，不跑 lint）：0 = 没有标记或没有 AGENTS.md
  const agentsBody = original.get('AGENTS.md') ?? ''
  const templateVersion = agentsBody.trim() ? templateVersionOf(agentsBody) : 0
  /** 格式债的一句；没有缺口返回空串。skipUndated 用于避开「只能按位置丢」已经报过的同一个数 */
  const debtNote = (skipUndated: boolean): string => {
    const parts: string[] = []
    if (!skipUndated && debt.undated > 0) parts.push(`${debt.undated} 条没日期`)
    if (debt.unlinked > 0) parts.push(`${debt.unlinked} 条没来源`)
    return parts.length > 0 ? `MEMORY ${parts.join(' · ')}` : ''
  }

  // ── 机械截断：MEMORY 最旧条目 → USER 尾段 → 各留首段 ──────────────
  // 丢掉的段落留一份目录（段落标题），让 agent 能按当前任务用 read 取回。
  // 目录自己也要占预算，所以每丢一段都把它算进去；目录有上限，循环一定收敛。
  const dropped: DroppedSection[] = []
  const tocCap = tocCapOf(budget)
  let fellBack = false
  for (const name of ['MEMORY.md', 'USER.md'] as const) {
    if (total() + countWords(tocText(dropped, tocCap)) <= budget) break
    // 丢弃前的原文：目录要用「在原文件里排第几」排序，而丢弃顺序会随最旧日期乱跳；
    // 更要命的是「多节 → 降成条目」会把两套坐标系（小节序号 / 条目序号）混进同一个 order，
    // 目录顺序于是乱掉。直接用它在原文里的字符偏移，小节和条目共用一套坐标。
    const pristine = original.get(name) ?? ''
    let split = splitSections(pristine)
    const mine: DroppedSection[] = []
    const over = (): boolean => total() + countWords(tocText([...dropped, ...mine], tocCap)) > budget
    // 每轮重判形态：多节先丢整节；只剩一节且还能降级时冻结标题、按条目继续丢。
    // 否则「多节丢到只剩一节」也会停在那里，剩下那一节自己超预算时同样丢不动。
    while (over()) {
      if (split.sections.length <= 1) {
        const deeper = degradeSingleSection(split)
        if (!deeper) break
        split = deeper
        continue
      }
      // MEMORY 按「最旧日期」丢；解析不出日期（或这是 USER）就退回尾部，行为与 0.8.3 一致
      let index = split.sections.length - 1
      if (name === 'MEMORY.md') {
        const oldest = oldestIndex(split)
        if (oldest === null) fellBack = true
        else index = oldest
      }
      const section = split.sections.splice(index, 1)[0] as string
      // 相同文本（两条一模一样的条目）会拿到同一个偏移：并列时保持丢弃顺序，足够好
      const at = pristine.indexOf(section)
      mine.push({ name, title: sectionTitle(section, split.mode), order: at < 0 ? Number.MAX_SAFE_INTEGER : at })
      const body = joinSections(split)
      original.set(name, body)
      words.set(name, countWords(body))
    }
    // 按原文件位置重建目录，而不是按丢弃顺序 —— 目录要能对上文件
    mine.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    dropped.push(...mine)
  }
  if (total() + countWords(tocText(dropped, tocCap)) > budget) {
    for (const name of ['USER.md', 'MEMORY.md'] as const) {
      const body = firstSection(original.get(name) ?? '')
      original.set(name, body)
      words.set(name, countWords(body))
    }
  }

  // 目录本身也放不下时宁可不给：否则「截断」会变成另一处超预算的来源
  const tocDraft = tocText(dropped, tocCap)
  const toc = dropped.length > 0 && total() + countWords(tocDraft) <= budget ? tocDraft : ''
  const present = files.filter((f) => (original.get(f.name) ?? '').length > 0)
  const bodies = present.map((f) => `## ${f.name}\n\n${escapeFrame(original.get(f.name) ?? '')}`)
  const keptWords = total()
  // 退役条目不算截断：它按约定退役，不是被预算挤掉的
  const omittedNote = omitted.count > 0 ? `已省略 ${omitted.count} 条退役条目（见 MEMORY.md）` : ''
  // 这条提示本身也要吃饭（D3.2）：不把它算进 words，报出来的用量就会少一截
  let finalWords = keptWords + countWords(toc) + countWords(omittedNote)
  const contentSum = files.reduce((sum, f) => sum + (contentWords.get(f.name) ?? 0), 0)
  // 报「正文被截掉多少」，不是净减少：目录也会占词，混在一起会让人以为没丢多少
  const truncatedWords = Math.max(0, contentSum - keptWords)
  // 退役条目的词数：磁盘保留、注入省略（D3）—— 与截断分开报，「原 X」从此只反映截断
  const retiredWords = Math.max(0, (diskWords.get('MEMORY.md') ?? 0) - (contentWords.get('MEMORY.md') ?? 0))

  let memoryInner = ''
  if (bodies.length > 0) {
    const notes: string[] = []
    // 截断时也带上格式债（P1）：先量词数，放不下就整条不加 —— 提示自己也要吃饭。
    // 已经要说「只能按位置丢」时跳过没日期那半句，避免同一个数报两遍。
    if (truncatedWords > 0) {
      const suffix = debtNote(fellBack && debt.undated > 0)
      const append = suffix && finalWords + countWords(` · ${suffix}`) <= budget ? ` · ${suffix}` : ''
      notes.push(`已截断 ${truncatedWords} 词${append}`)
    }
    if (omittedNote) notes.push(omittedNote)
    // 一条日期都没有只能按位置丢：说出来，别让人以为是按日期挑的（D2.5）
    // 数字取内存里那份格式债，不在这里另数一遍（退役条目算不算会两边不一致）
    if (fellBack && truncatedWords > 0) {
      if (debt.undated > 0) notes.push(`MEMORY 有 ${debt.undated} 条没日期，只能按位置丢`)
    }
    // 目录放不下时至少留一句指路；否则被丢掉的段落对模型完全不可见
    if (!toc && dropped.length > 0) {
      const names = [...new Set(dropped.map((d) => d.name))]
      notes.push(`其余 ${dropped.length} 段用 read 读 ${names.map((n) => path.join(cfg.notebook, n)).join(' / ')}`)
    }
    // 归因：AGENTS 不参与截断，占掉大半预算时得点名 —— 否则「记忆为什么总是不生效」无从查起。
    // 只在「确实截断了、且总载荷没超」时说：总载荷都超了的话，下面的「预算不足」已经点了 AGENTS 的名。
    const agentsWords = words.get('AGENTS.md') ?? 0
    if (truncatedWords > 0 && finalWords <= budget && agentsWords * 2 > budget) {
      notes.push(`AGENTS.md 占 ${agentsWords}/${budget} 词且不参与截断，留给 USER / MEMORY 的只有 ${Math.max(0, budget - agentsWords)} 词`)
    }
    if (finalWords > budget) {
      // 超预算时点名「谁已经没法再丢」：只说「AGENTS 不截断」会把 MEMORY 的条目形状问题藏在后面
      const stuck: string[] = []
      if (agentsWords > 0) stuck.push(`AGENTS.md 为硬规则不截断（${agentsWords} 词）`)
      for (const name of ['MEMORY.md', 'USER.md'] as const) {
        const left = words.get(name) ?? 0
        if (left <= 0) continue
        const what = splitSections(original.get(name) ?? '').mode
        stuck.push(`${name} ${left} 词（已无更多可丢的${what === 'items' ? '条目' : what === 'paragraphs' ? '段落' : '小节'}）`)
      }
      notes.push(`预算不足：内容 ${finalWords} 词，超出 ${budget} 词；${stuck.join('、')}`)
    }
    // 接近上限就回显用量：增长是连续的，等到第一次截断才说，正好是最坏的时刻。
    // 这一行算进 finalWords（否则「280/300」是假的）；放不下就整条不加 —— 宁可不说，
    // 也不让提醒本身把预算吃满。与「已截断 / 预算不足」互斥。
    if (notes.length === 0 && budget > 0 && finalWords >= budget * MEMORY_NEAR_RATIO) {
      // 两遍：先量这一行本身占多少词，再把它算进 finalWords 后重报数字 ——
      // 否则会说着「280/300」却实际注入 285 词（提示自己也要吃饭）
      const cost = countWords(`记忆已用 ${finalWords}/${budget} 词（100%）`)
      if (finalWords + cost <= budget) {
        finalWords += cost
        // 格式债跟在用量后面（P1）：整条量过再说，放不下就一句都不加，
        // 不能出现「MEMORY 9 条没日期」却丢了「3 条没来源」这种半句。
        const suffix = debtNote(false)
        const debtCost = suffix ? countWords(` · ${suffix}`) : 0
        if (suffix && finalWords + debtCost <= budget) {
          finalWords += debtCost
          notes.push(`记忆已用 ${finalWords}/${budget} 词（${Math.round((finalWords / budget) * 100)}%） · ${suffix}`)
        } else {
          notes.push(`记忆已用 ${finalWords}/${budget} 词（${Math.round((finalWords / budget) * 100)}%）`)
        }
      }
    }
    const notice = notes.length > 0 ? `\n\n（注入预算 ${budget} 词：${notes.join('；')}）` : ''
    // 只有用了这套约定的库（根目录有 AGENTS.md）才提醒周节奏
    const dream = files.some((f) => f.name === 'AGENTS.md' && f.body.length > 0) ? dreamNote(cfg) : ''
    memoryInner =
      bodies.join('\n\n') +
      (toc ? `\n\n${toc}` : '') +
      (dream ? `\n\n（${dream}）` : '') +
      notice
  }

  // ── 人格段（角色）：永远注入、在记忆段之前、不参与截断 ────
  // 超预算只告警不静默丢。
  // 没有人格文件 = 未启用：不多一个词。
  const personaBudget = cfg.personaBudgetWords
  const personas = readPersonas(cfg)
  const personaBodies = personas.filter((f) => f.body.length > 0)
  const personaBodyText = personaBodies.map((f) => `## ${f.name}\n\n${escapeFrame(f.body)}`).join('\n\n')
  // 预算只算正文（含文件标题），不能把告警行算进去 —— 否则「已用 / 超出」会随告警自己的长度变
  const personaContentWords = countWords(personaBodyText)
  const personaOver = personaBodies.length > 0 && personaContentWords > personaBudget
  const personaNotes: string[] = []
  if (personaOver) {
    personaNotes.push(`人格上限 ${personaBudget} 词：已用 ${personaContentWords}，超出 ${personaContentWords - personaBudget} 词（人格不截断）`)
  }
  const personaText = personaBodyText + (personaNotes.length > 0 ? `\n\n（${personaNotes.join('；')}）` : '')
  const personaWords = countWords(personaText)

  let text = ''
  if (memoryInner || personaText) {
    text = frameText((personaText ? personaText + '\n\n' : '') + memoryInner)
  }

  // 模型真正收到的总量与开销：口径与 memoryUsage / D9 的载荷预览同源
  const totalWords = countWords(text)

  return {
    text,
    words: finalWords,
    budget,
    ratio: budget > 0 ? Math.round((finalWords / budget) * 100) / 100 : 0,
    truncatedWords,
    retiredWords,
    retiredEntries: omitted.count,
    tocWords: countWords(toc),
    formatDebt: debt,
    templateVersion,
    files: files.map((f) => ({
      name: f.name,
      present: f.body.length > 0,
      words: words.get(f.name) ?? 0,
      // files[].body 始终是原文件内容（截断只改 original 副本）；退役条目也算在原文里
      originalWords: diskWords.get(f.name) ?? 0,
      retiredWords: f.name === 'MEMORY.md' ? retiredWords : 0,
    })),
    persona: {
      present: personaBodies.length > 0,
      contentWords: personaContentWords,
      words: personaWords,
      noticeWords: Math.max(0, personaWords - personaContentWords),
      budget: personaBudget,
      overBudget: personaOver,
      overWords: Math.max(0, personaContentWords - personaBudget),
      files: personas.map((f) => ({ name: f.name, present: f.body.length > 0, words: countWords(f.body) })),
    },
    totalWords,
    overheadWords: Math.max(0, totalWords - personaContentWords - finalWords),
  }
}

export interface MemoryUsage {
  /** 记忆内容词数（含「记忆已用」提示行，不含框 / 做梦提醒 / notice / 人格）—— 与 `payload.words` 同源 */
  words: number
  /** 人格段总词数（含告警行；0 = 未启用）—— 单独注入，不计入记忆预算 */
  personaWords: number
  /** 模型真正收到的总量：人格、框、做梦提醒、截断 notice 都在里面 */
  totalWords: number
  budget: number
  /** budget - (totalWords - personaWords)，**可以为负**：记忆内容没超、加上提示超了 */
  headroom: number
  /** 格式债：与 `zk_lint.memoryLinks` 的 undated / unlinked 同一份 `memoryFormatDebt` */
  undated: number
  unlinked: number
  /** 退役条目数（与 `zk_lint.memoryLinks.retired` 同一口径） */
  retired: number
  files: MemoryFileInfo[]
}

/**
 * 记忆用量（D4）。只是 `buildMemoryPayload` 的投影 —— 不重读、不重算，
 * 否则就是第三个计数口径，doctor / 设置页 / dream 三处迟早对不上。
 */
export function memoryUsage(cfg: Config): MemoryUsage {
  const payload = buildMemoryPayload(cfg)
  return {
    words: payload.words,
    personaWords: payload.persona.words,
    totalWords: payload.totalWords,
    budget: payload.budget,
    // 人格是独立层：整段（含它的告警）都不该占记忆预算，否则 dream 会误报「余量」
    headroom: payload.budget - (payload.totalWords - payload.persona.words),
    undated: payload.formatDebt.undated,
    unlinked: payload.formatDebt.unlinked,
    retired: payload.retiredEntries,
    files: payload.files,
  }
}

// ── G1 / G4：写 MEMORY 之前的容量与「下一条会丢谁」──

/** 下一个会被预算挤掉的 MEMORY 条目；纯预告，磁盘不动 */
export interface MemoryDropCandidate {
  /** 条目首行摘要（与截断目录同口径，最多 40 字） */
  title: string
  /** 能解析出的日期；没有是空串 */
  date: string
  words: number
  /** 为什么轮到它：最旧 / 同日按位置 / 没日期只能按位置 */
  reason: 'oldest' | 'same-date' | 'undated'
}

export interface MemoryCapacity {
  /** payload.words：记忆内容词数 */
  words: number
  /** payload.totalWords：模型真正收到的总载荷 */
  totalWords: number
  budget: number
  /** 与 memoryUsage 同口径：budget - (totalWords - personaWords)，可为负 */
  headroom: number
  /** proposed_entry / extra_words 折算出的新增词数 */
  extraWords: number
  /** 再加这些词会不会触发截断（headroom 已为负时任何新增都会） */
  wouldTruncate: boolean
  dropCandidates: MemoryDropCandidate[]
  /** 格式债标签：undated / unlinked / retired，只列非零的 */
  format: string[]
  /** 与最旧日期相同的活条目数（G4：同日时实际由位置决胜） */
  sameDateCount: number
  suggestion: string
}

export interface MemoryCapacityOptions {
  /** 打算写进 MEMORY.md 的新条目；按 countWords 折算词数 */
  proposedEntry?: string
  /** 直接给新增词数（给了就不按 proposedEntry 重算） */
  extraWords?: number
}

/**
 * 「改 MEMORY 之前」的容量快照：复用 `buildMemoryPayload` / `memoryUsage` 的投影，不新增计数口径；
 * 条目解析复用 `splitMemoryEntries` / `entryDate` / `isRetiredEntry`，与截断、`zk_lint` 同一份。
 * 纯读：不跑 zk、不写文件。同日 tie 只做可见化（G4），不改变 `oldestIndex` 的淘汰行为。
 */
export function memoryCapacity(cfg: Config, opts: MemoryCapacityOptions = {}): MemoryCapacity {
  const payload = buildMemoryPayload(cfg)
  const usage = memoryUsage(cfg)
  const extraWords = typeof opts.extraWords === 'number' && Number.isFinite(opts.extraWords)
    ? Math.max(0, Math.trunc(opts.extraWords))
    : countWords(String(opts.proposedEntry ?? ''))
  const wouldTruncate = extraWords > usage.headroom

  let body = ''
  try { body = fs.readFileSync(path.join(cfg.notebook, 'MEMORY.md'), 'utf8') } catch { /* 缺文件 = 空 */ }
  const debt = memoryFormatDebt(body)
  const retired = stripRetiredEntries(body).count
  // 退役条目注入时已省略，不会因预算被丢 —— 预告里不列它们
  const entries = splitMemoryEntries(body)
    .map((entry, index) => ({ entry, index, date: entryDate(entry) }))
    .filter((row) => !isRetiredEntry(row.entry))
  const withDate = entries.filter((row) => row.date !== null)
  const oldestDate = withDate.reduce((min, row) => (row.date! < min ? row.date! : min), '9999-99-99')
  const sameDateCount = withDate.filter((row) => row.date === oldestDate).length

  // 与 oldestIndex 同口径：有日期按最旧；同日期按位置靠后的先丢；没日期退回尾部（也是位置靠后先丢）
  const order = [...entries].sort((a, b) => {
    if (a.date && b.date) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      return b.index - a.index
    }
    if (a.date) return -1
    if (b.date) return 1
    return b.index - a.index
  })
  const dropCandidates: MemoryDropCandidate[] = order.slice(0, 5).map(({ entry, date }) => {
    const one = String(entry.split('\n', 1)[0] ?? '').replace(/\s+/g, ' ').trim()
    const title = one.length > TOC_TITLE_MAX ? one.slice(0, TOC_TITLE_MAX) + '…' : one
    return {
      title: title || '（无标题）',
      date: date ?? '',
      words: countWords(entry),
      reason: !date ? 'undated' : sameDateCount > 1 && date === oldestDate ? 'same-date' : 'oldest',
    }
  })

  const format: string[] = []
  if (debt.undated > 0) format.push('undated')
  if (debt.unlinked > 0) format.push('unlinked')
  if (retired > 0) format.push('retired')

  const parts: string[] = [extraWords > 0
    ? (wouldTruncate
      ? `再加 ${extraWords} 词会触发截断（余 ${usage.headroom} 词），先退役 / 精简 dropCandidates 里的条目`
      : `还能放 ${usage.headroom - extraWords} 词`)
    : (usage.headroom < 0 ? `已超预算 ${-usage.headroom} 词` : `余 ${usage.headroom} 词`)]
  // G4：同日不是「按日期挑的」，明说是位置决胜，不假装有使用频率
  if (sameDateCount > 1) parts.push(`${sameDateCount} 条同日，按位置决胜`)
  if (format.length) parts.push(`格式债：${format.join(' / ')}`)

  return {
    words: payload.words,
    totalWords: payload.totalWords,
    budget: payload.budget,
    headroom: usage.headroom,
    extraWords,
    wouldTruncate,
    dropCandidates,
    format,
    sameDateCount,
    suggestion: parts.join('；'),
  }
}
