/**
 * read-only（宿主半边）—— 给人看的只读视图 / RSS / JSON 接口。
 *
 * 设计边界（和设置页的写 API 完全分开）：
 *   · 只挂 4 条 GET 路由，全部在 /dsh-zdiary-kit 下，和 DSH 同端口，不自己 listen；
 *   · 方法门：GET / HEAD 以外一律 405，默认拒绝 —— 不是「没写 POST 就算只读」；
 *   · 副作用门：只调 hasNotebook / allNotes / searchNotes / readNote / graphEdges，
 *     **不调 ensureNotebook**（那会建库）、不跑 init / index / install；
 *   · 面门：不读 /api/settings 的 snapshot，不返回 zkPath / 配置文件路径 / absPath；
 *   · 地址门：只认回环（Host + 对端地址），DSH 绑到 0.0.0.0 时视图也不会跟着上网。
 *
 * 这里是「读」，写入仍然只走 agent 的 zk_* 工具与 CLI —— 锁、stamp、冲突处理都在那边。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopback, json, ROUTE_BASE } from '../../lib/http.ts'
import { config } from '../../config/store.ts'
import type { Config } from '../../config/store.ts'
import { absPathOf, allNotes, graphEdges, hasNotebook, isUnderDir, localDate, readNote, searchNotes, ZkError } from '../../lib/zk.ts'
import type { NoteDoc, NoteRecord } from '../../lib/zk.ts'
import { isMetaPath } from '../../lib/meta.ts'
import { buildMemoryPayload, formatFileShares } from '../../lib/memory.ts'
import { RETIRED_ENTRY_RE } from '../../lib/memory-format.ts'
import { parseFrontmatter } from '../../lib/frontmatter.ts'
import { stripContractMarker } from '../../lib/persona-template.ts'
import { esc, layout, renderMarkdown } from './html.ts'
import type { RouteHandler } from '../../lib/dsh.ts'

const BASE = ROUTE_BASE
const VIEW = `${BASE}/view`
const FEED = `${BASE}/feed.xml`
const API_NOTES = `${BASE}/api/notes`
const API_NOTE = `${BASE}/api/note`

/** 一次索引最多载入多少篇（超出只在页脚说明，不静默装作全量） */
const INDEX_LIMIT = 2000
/** 页面 / API 单篇正文上限：日记再长也不该把浏览器拖死 */
const MAX_CONTENT = 200_000
/** 磁盘文件上限：超过就不读（readNote 会把整篇读进内存） */
const MAX_FILE = 2 * 1024 * 1024
/**
 * 只读视图只认 zk 索引得到的扩展名（md / markdown）。
 * 别照抄 zk.ts 的 NOTE_EXT：那里带 org / txt 是为了剥双链的扩展名，
 * 而 zk 默认不索引 org / txt —— 放进来只会得到「能直连、永远搜不到、还被 markdown 渲染坏」的页面。
 */
const NOTE_EXT = /\.(?:md|markdown)$/i

export interface ReadOnlyDeps {
  route: (pathname: string, handler: RouteHandler) => void
}

/** 站内链接：查询串路由（宿主的 register 只支持 exact，拼不出 /note/:id） */
function viewHref(params: Record<string, string>): string {
  return `${VIEW}?${new URLSearchParams(params).toString()}`
}
function noteHref(rel: string): string {
  return viewHref({ p: 'note', path: rel })
}

function byModified(a: NoteRecord, b: NoteRecord): number {
  return String(b.modified || b.created).localeCompare(String(a.modified || a.created))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 对外文案：只回插件自己写的校验文案；zk 进程 / 文件系统的原文写日志，不写进页面。
 * zk 的 stderr 与 spawn 报错常带绝对路径（笔记本、zk 二进制），页面和 JSON 都不该带出去。
 */
function publicMessage(err: unknown): string {
  if (err instanceof ZkError && err.code !== 'zk-failed') return err.message
  try { console.warn('[zdiary] 只读视图：' + messageOf(err)) } catch { /* ignore */ }
  return '读取失败（详细原因见 DSH 日志）'
}

/**
 * 请求自己的 origin。DSH 的 TLS 由 webServer 直接终结（node:https），
 * 所以 `socket.encrypted` 就是真实协议 —— 别把 RSS 的链接写死成 http。
 */
function requestOrigin(req: IncomingMessage): string {
  const secure = (req.socket as unknown as { encrypted?: boolean } | undefined)?.encrypted === true
  return `${secure ? 'https' : 'http'}://${String(req.headers.host ?? '127.0.0.1')}`
}

/**
 * 解析请求 URL。Host 是客户端可控的：畸形值（例如 `127.0.0.1:80,evil`）会让 new URL 抛错，
 * 在路由外抛出去只会落到兜底的 500 JSON —— 在这里统一收成 400。
 */
function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(String(req.url ?? '/'), `http://${String(req.headers.host ?? '127.0.0.1')}`)
  } catch {
    return null
  }
}

/** 所有只读响应共用的安全头：无脚本、不可被框、无 referer、不缓存 */
function secure(res: ServerResponse): void {
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('cross-origin-resource-policy', 'same-origin')
  res.setHeader('cache-control', 'no-store')
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.end(body)
}

/**
 * 公共门：先上安全头，再判地址 / 方法。
 * 所有路由共用它 —— 只读保证只有这一处，不靠「每个 handler 都记得写」。
 * 地址判定用 lib/http 的 isLoopback（Host + 对端都要回环），不在这里另写一份。
 */
function guard(req: IncomingMessage, res: ServerResponse, mode: 'html' | 'json' | 'xml'): boolean {
  secure(res)
  if (!isLoopback(req)) {
    const msg = '只读视图只在回环地址（127.0.0.1 / localhost）上开放'
    if (mode === 'json') json(res, 403, { ok: false, error: msg })
    else if (mode === 'xml') sendText(res, 403, msg)
    else sendHtml(res, 403, layout({ title: '禁止访问', notebook: '只读视图', body: `<h1>禁止访问</h1><p class="error">${esc(msg)}</p>` }))
    return false
  }
  const method = String(req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD')
    const msg = '只读视图不支持写请求（只接受 GET / HEAD）'
    if (mode === 'json') json(res, 405, { ok: false, error: msg })
    else if (mode === 'xml') sendText(res, 405, msg)
    else sendHtml(res, 405, layout({ title: '只读', notebook: '只读视图', body: `<h1>只读</h1><p class="error">${esc(msg)}</p>` }))
    return false
  }
  return true
}

interface State {
  cfg: Config
  ready: boolean
  /** 不可用时给人看的一句话（不带绝对路径） */
  reason: string
}

/** 只判断「有没有初始化过」，绝不顺手建库 */
function state(): State {
  const cfg = config()
  if (!hasNotebook(cfg)) {
    return { cfg, ready: false, reason: '笔记本还没初始化（缺 .zk/config.toml）：到设置页点「初始化 / 补建」，或让 agent 先写一篇。' }
  }
  return { cfg, ready: true, reason: '' }
}

function shell(cfg: Config, title: string, body: string, note?: string): string {
  return layout({ title, notebook: cfg.active || 'zdiary', body, note })
}

function noticePage(res: ServerResponse, cfg: Config, title: string, message: string, status = 200): void {
  sendHtml(res, status, shell(cfg, title, `<h1>${esc(title)}</h1><p class="notice">${esc(message)}</p><p><a href="${VIEW}">返回首页</a></p>`))
}

function errorPage(res: ServerResponse, cfg: Config, status: number, title: string, message: string): void {
  sendHtml(res, status, shell(cfg, title, `<h1>${esc(title)}</h1><p class="error">${esc(message)}</p><p><a href="${VIEW}">返回首页</a></p>`))
}

function tagCounts(notes: NoteRecord[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const note of notes) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function tagLinks(tags: string[]): string {
  return tags.map((tag) => `<a href="${esc(viewHref({ p: 'tag', tag }))}">#${esc(tag)}</a>`).join(' ')
}

function noteTable(notes: NoteRecord[]): string {
  if (!notes.length) return '<p class="meta">没有笔记。</p>'
  const rows = notes.map((note) => {
    const date = localDate(note.modified || note.created) || '—'
    return `<tr><td class="meta">${esc(date)}</td><td><a href="${esc(noteHref(note.path))}">${esc(note.title || note.path)}</a></td><td class="meta">${tagLinks(note.tags)}</td></tr>`
  }).join('')
  return `<table><tr><th>日期</th><th>标题</th><th>标签</th></tr>${rows}</table>`
}

function searchForm(value = ''): string {
  return `<form class="search" method="get" action="${VIEW}"><input type="search" name="q" value="${esc(value)}" placeholder="搜索标题、正文…" aria-label="搜索"><button type="submit">搜索</button></form>`
}

async function loadAll(cfg: Config): Promise<NoteRecord[]> {
  return allNotes(cfg, { limit: INDEX_LIMIT })
}

/** 搜索 / 标签走 zk；`q` 与 `tag` 同时给就是两个条件一起收（zk 按 AND 处理，不静默忽略其中一个） */
async function pickNotes(cfg: Config, opts: { q?: string; tag?: string; limit: number }): Promise<NoteRecord[]> {
  if (opts.q || opts.tag) {
    return searchNotes(cfg, { query: opts.q, tags: opts.tag ? [opts.tag] : [], limit: opts.limit, sort: 'modified-desc' })
  }
  return (await loadAll(cfg)).sort(byModified).slice(0, opts.limit)
}

// ── 页面 ──────────────────────────────────────────────────────────────

async function handleHome(res: ServerResponse, cfg: Config): Promise<void> {
  const all = await loadAll(cfg)
  const recent = [...all].sort(byModified).slice(0, 30)
  const journal = all.filter((note) => isUnderDir(note.path, cfg.dailyDir) || note.type === 'daily').sort(byModified).slice(0, 10)
  const tags = tagCounts(all)
  const body = [
    `<h1>${esc(cfg.active || 'zdiary')}</h1>`,
    searchForm(),
    `<p class="meta">${all.length} 篇笔记 · ${tags.length} 个标签 · 只读</p>`,
    '<h2>最近更新</h2>',
    noteTable(recent),
    '<h2>日记</h2>',
    noteTable(journal),
    '<h2>标签</h2>',
    tags.length
      ? `<p class="tags">${tags.slice(0, 80).map(([tag, count]) => `<a href="${esc(viewHref({ p: 'tag', tag }))}">#${esc(tag)}</a><span class="count">${count}</span>`).join(' · ')}</p>`
      : '<p class="meta">还没有标签。</p>',
  ].join('\n')
  const note = all.length >= INDEX_LIMIT ? `只载入了最近 ${INDEX_LIMIT} 篇；更早的请用搜索。` : undefined
  sendHtml(res, 200, shell(cfg, '首页', body, note))
}

async function handleSearch(res: ServerResponse, cfg: Config, q: string): Promise<void> {
  const notes = await searchNotes(cfg, { query: q, limit: 100, sort: 'modified-desc' })
  const body = [
    `<p class="crumb"><a href="${VIEW}">首页</a> / 搜索</p>`,
    `<h1>搜索：${esc(q)}</h1>`,
    searchForm(q),
    `<p class="meta">${notes.length} 条结果（最多 100 条）</p>`,
    noteTable(notes),
  ].join('\n')
  sendHtml(res, 200, shell(cfg, `搜索 ${q}`, body))
}

/** MEMORY.md 渲染：退役条目整条（含缩进续行）加删除线与徽标，其余照常渲染 */
function renderMemoryBody(body: string, linkFor: (target: string) => string | null): string {
  const lines = String(body).split('\n')
  const out: string[] = []
  let plain: string[] = []
  const flush = (): void => {
    if (plain.length > 0) {
      out.push(renderMarkdown(plain.join('\n'), { linkFor, skipFirstH1: true }))
      plain = []
    }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (RETIRED_ENTRY_RE.test(line)) {
      flush()
      const retired: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (RETIRED_ENTRY_RE.test(l) || (retired.length > 0 && /^\s+\S/.test(l))) {
          retired.push(l)
          i += 1
          continue
        }
        break
      }
      out.push(
        `<div class="retired"><s>${retired.map((l) => esc(l)).join('<br>')}</s>` +
        '<span class="badge">retired</span></div>',
      )
      continue
    }
    plain.push(line)
    i += 1
  }
  flush()
  return out.join('\n')
}

/**
 * 记忆页（P1-5 → D9）：人的周审入口 —— 契约 / 用户 / 记忆 / 周审四段 + 载荷预览。
 * 不走 `loadNote`：根目录 meta 被 `loadAll` 排除、也被 `loadNote` 明确拒绝；
 * 这里按常量直接读盘，再复用渲染层的转义与双链白名单。
 * 载荷预览只转义展示（与 zk_context 同源），不提供编辑 —— 写仍然只走 zk_* / 编辑器。
 */
async function handleMemory(res: ServerResponse, cfg: Config): Promise<void> {
  let all: NoteRecord[] = []
  try { all = await loadAll(cfg) } catch { /* 索引挂了也能读记忆，双链退化成纯文字 */ }
  const linkFor = linkResolver(all)

  const read = (name: string): string => {
    try { return fs.readFileSync(path.join(cfg.notebook, name), 'utf8') } catch { return '' }
  }
  const fileArticle = (name: string, note?: string): string => {
    const body = read(name)
    return (note ? `<p class="meta">${note}</p>` : '') + (body.trim()
      ? `<article>${renderMarkdown(body, { linkFor, skipFirstH1: true })}</article>`
      : '<p class="meta">还没写。</p>')
  }

  const payload = buildMemoryPayload(cfg)
  const shares = formatFileShares(payload.files, payload.tocWords)
  const usage =
    `记忆 ${payload.words}/${payload.budget} 词（${shares || '三份都空'}）` +
    (payload.truncatedWords > 0 ? ` · 已截断 ${payload.truncatedWords} 词` : '') +
    (payload.retiredWords > 0 ? ` · 退役省略 ${payload.retiredWords} 词` : '')

  // 契约段：超预算只告警
  const c = payload.contract
  const contractSummary = c.present
    ? c.files.filter((f) => f.present).map((f) => `${f.name} ${f.words} 词`).join(' · ') +
      ` · 正文（含标题）${c.contentWords}/${c.budget} 词` +
      (c.overBudget ? ` · ⚠️ 超 ${c.overWords} 词（契约不截断，请缩减或调 contractBudgetWords）` : '')
    : '未启用：根目录没有 PERSONA.md —— 初始化带 --with-contract 或在设置页写入模板；缺文件不算错。'
  const contractSections = (['PERSONA.md'] as const).map((name) => {
    // 版本标记与 frontmatter 是机器元数据：页面像笔记页一样剥掉，改成一行可读的字段
    const body = stripContractMarker(read(name))
    const fields = parseFrontmatter(body).fields
    const meta = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join(' · ')
    return [
      `<h3>${esc(name)}</h3>`,
      meta ? `<p class="meta">${esc(meta)}</p>` : '',
      body.trim()
        ? `<article>${renderMarkdown(body, { linkFor, skipFirstH1: true })}</article>`
        : '<p class="meta">还没写。</p>',
    ].filter(Boolean).join('\n')
  })

  // 记忆段：退役行删除线 + 徽标（不再看起来像活条目）
  const memoryBody = read('MEMORY.md')
  const memorySection = memoryBody.trim()
    ? `<article>${renderMemoryBody(memoryBody, linkFor)}</article>`
    : '<p class="meta">还没写。</p>'

  const dreamBody = read('DREAMS.md')
  const counts =
    `契约正文 ${c.contentWords} 词 · 记忆 ${payload.words} 词 · 记忆载荷 ${payload.totalWords} 词（含框与提示 ${payload.overheadWords}）`

  const body = [
    `<p class="crumb"><a href="${VIEW}">首页</a> / 记忆</p>`,
    '<h1>记忆</h1>',
    `<p class="meta">${esc(usage)}</p>`,
    '<p class="meta">根目录 meta 由人和 agent 直接编辑，不进检索；这里只读，不提供编辑。</p>',
    `<h2>契约</h2>`,
    `<p class="meta">${esc(contractSummary)}</p>`,
    ...contractSections,
    '<h2>用户</h2>',
    fileArticle('USER.md', '用户偏好；可以跨库共享。'),
    '<h2>工作约定</h2>',
    fileArticle('AGENTS.md', '硬规则，永不截断；属于记忆预算。'),
    '<h2>记忆</h2>',
    `<p class="meta">${esc(payload.files.filter((f) => f.name === 'MEMORY.md').map((f) => (f.retiredWords > 0 ? `退役 ${f.retiredWords} 词只留在磁盘，不注入` : '')).filter(Boolean).join(' · '))}</p>`,
    memorySection,
    '<h2>周审</h2>',
    '<p class="meta">只有「上次做梦：YYYY-MM-DD」一行参与每周提醒，不注入正文；其余是周审记录。</p>',
    dreamBody.trim()
      ? `<article>${renderMarkdown(dreamBody, { linkFor, skipFirstH1: true })}</article>`
      : '<p class="meta">还没写。</p>',
    '<h2>载荷预览</h2>',
    `<p class="meta">这一轮模型实际收到的文本（转义展示、只读、与 zk_context 同源）：${esc(counts)}</p>`,
    '<h3>记忆段</h3>',
    payload.text
      ? `<details><summary>展开</summary><pre>${esc(payload.text)}</pre></details>`
      : '<p class="meta">空：没有可注入的内容。</p>',
  ].join('\n')
  sendHtml(res, 200, shell(cfg, '记忆', body))
}

async function handleTags(res: ServerResponse, cfg: Config): Promise<void> {
  const notes = await loadAll(cfg)
  const tags = tagCounts(notes)
  const body = [
    `<p class="crumb"><a href="${VIEW}">首页</a> / 标签</p>`,
    '<h1>标签</h1>',
    `<p class="meta">${tags.length} 个标签 · ${notes.length} 篇笔记</p>`,
    tags.length
      ? `<p class="tags">${tags.map(([tag, count]) => `<a href="${esc(viewHref({ p: 'tag', tag }))}">#${esc(tag)}</a><span class="count">${count}</span>`).join(' · ')}</p>`
      : '<p class="meta">还没有标签。</p>',
  ].join('\n')
  sendHtml(res, 200, shell(cfg, '标签', body))
}

async function handleTag(res: ServerResponse, cfg: Config, tag: string): Promise<void> {
  if (!tag) {
    noticePage(res, cfg, '标签', '没给标签名：从首页或标签页点一个进来。', 400)
    return
  }
  const notes = await searchNotes(cfg, { tags: [tag], limit: 200, sort: 'modified-desc' })
  const body = [
    `<p class="crumb"><a href="${VIEW}">首页</a> / <a href="${esc(viewHref({ p: 'tags' }))}">标签</a></p>`,
    `<h1>#${esc(tag)}</h1>`,
    `<p class="meta">${notes.length} 篇（最多 200 篇）</p>`,
    noteTable(notes),
  ].join('\n')
  sendHtml(res, 200, shell(cfg, `#${tag}`, body))
}

interface LoadedNote {
  doc: NoteDoc
  rel: string
}

/** 读一篇：路径必须在笔记本内、不是 .zk / 根 meta、扩展名与大小都过关 */
async function loadNote(cfg: Config, input: string): Promise<LoadedNote> {
  const abs = absPathOf(cfg, input)
  const rel = path.relative(cfg.notebook, abs).split(path.sep).join('/')
  if (isMetaPath(rel)) throw new ZkError(`根目录的 meta 文件（${rel}）不在只读视图里显示`, undefined, 'meta')
  if (!NOTE_EXT.test(abs)) throw new ZkError('只读视图只显示 .md / .markdown', undefined, 'unsupported')
  const stat = fs.statSync(abs, { throwIfNoEntry: false })
  if (!stat || !stat.isFile()) throw new ZkError(`笔记不存在：${input}`, undefined, 'not-found')
  if (stat.size > MAX_FILE) {
    throw new ZkError(`文件太大（${Math.round(stat.size / 1024)} KiB），只读视图不加载超过 2 MiB 的文件`, undefined, 'too-large')
  }
  return { doc: await readNote(cfg, rel), rel }
}

/** 把 [[目标]] 解析成站内链接：路径 → 去扩展名路径 → 标题 → 文件名 */
function linkResolver(notes: NoteRecord[]): (target: string) => string | null {
  const byPath = new Map<string, NoteRecord>()
  const byTitle = new Map<string, NoteRecord>()
  const byBase = new Map<string, NoteRecord>()
  for (const note of notes) {
    if (!byPath.has(note.path)) byPath.set(note.path, note)
    const noExt = note.path.replace(NOTE_EXT, '')
    if (!byPath.has(noExt)) byPath.set(noExt, note)
    if (note.title && !byTitle.has(note.title)) byTitle.set(note.title, note)
    const base = path.basename(noExt)
    if (!byBase.has(base)) byBase.set(base, note)
  }
  return (input: string): string | null => {
    const target = input.trim().replace(/^<|>$/g, '').replace(/^\.\//, '').replace(/^\/+/, '').split('#')[0] ?? ''
    if (!target) return null
    const hit = byPath.get(target) ?? byTitle.get(target) ?? byBase.get(target)
    return hit ? noteHref(hit.path) : null
  }
}

async function handleNote(res: ServerResponse, cfg: Config, rel: string): Promise<void> {
  if (!rel) {
    noticePage(res, cfg, '笔记', '没给路径：从首页或搜索结果点一篇进来。', 400)
    return
  }
  let loaded: LoadedNote
  try {
    loaded = await loadNote(cfg, rel)
  } catch (err) {
    const missing = err instanceof ZkError && err.code === 'not-found'
    errorPage(res, cfg, missing ? 404 : 400, missing ? '没有这篇笔记' : '打不开这篇笔记', publicMessage(err))
    return
  }

  let all: NoteRecord[] = []
  try { all = await loadAll(cfg) } catch { /* 索引挂了也能显示正文，双链退化成纯文字 */ }
  const linkFor = linkResolver(all)

  let backlinks: NoteRecord[] = []
  try {
    const relPath = loaded.rel
    const byPath = new Map(all.map((note) => [note.path, note]))
    const seen = new Set<string>()
    for (const edge of (await graphEdges(cfg)).edges) {
      if (edge.targetPath !== relPath || edge.sourcePath === relPath) continue
      if (seen.has(edge.sourcePath)) continue
      seen.add(edge.sourcePath)
      const hit = byPath.get(edge.sourcePath)
      backlinks.push(hit ?? {
        title: path.basename(edge.sourcePath).replace(NOTE_EXT, ''),
        path: edge.sourcePath,
        absPath: '',
        link: '',
        tags: [],
        created: '',
        modified: '',
        lead: '',
        words: 0,
        metadata: {},
        status: '',
        type: '',
        authority: '',
      })
    }
    backlinks = backlinks.sort((a, b) => a.title.localeCompare(b.title))
  } catch { /* 图读不出来就不显示反链 */ }

  const content = loaded.doc.content.length > MAX_CONTENT
    ? loaded.doc.content.slice(0, MAX_CONTENT)
    : loaded.doc.content
  const truncated = content.length < loaded.doc.content.length

  const body = [
    `<p class="crumb"><a href="${VIEW}">首页</a> / ${esc(loaded.doc.type || '笔记')}</p>`,
    `<h1>${esc(loaded.doc.title || loaded.rel)}</h1>`,
    `<p class="meta">${esc(localDate(loaded.doc.created) || '—')} · ${loaded.doc.words} 词${loaded.doc.tags.length ? ' · ' + tagLinks(loaded.doc.tags) : ''}</p>`,
    truncated ? `<p class="notice">正文超过 ${MAX_CONTENT} 字符，这里只显示前 ${MAX_CONTENT} 字符。</p>` : '',
    `<article>${renderMarkdown(content, { linkFor, skipFirstH1: true })}</article>`,
    '<h2>反链</h2>',
    backlinks.length
      ? `<ul>${backlinks.slice(0, 100).map((note) => `<li><a href="${esc(noteHref(note.path))}">${esc(note.title || note.path)}</a></li>`).join('')}</ul>`
      : '<p class="meta">没有其它笔记链到这里。</p>',
  ].join('\n')

  sendHtml(res, 200, shell(cfg, loaded.doc.title || loaded.rel, body))
}

async function handleView(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res, 'html')) return
  const url = parseRequestUrl(req)
  if (!url) {
    sendHtml(res, 400, layout({ title: '请求不合法', notebook: '只读视图', body: '<h1>请求不合法</h1><p class="error">Host 头不是合法地址。</p>' }))
    return
  }
  const st = state()
  const p = url.searchParams.get('p') ?? ''
  const q = (url.searchParams.get('q') ?? '').trim()
  const tag = (url.searchParams.get('tag') ?? '').trim()

  if (!st.ready) {
    noticePage(res, st.cfg, '只读视图', st.reason)
    return
  }
  try {
    if (p === 'note') return await handleNote(res, st.cfg, (url.searchParams.get('path') ?? '').trim())
    if (p === 'memory') return await handleMemory(res, st.cfg)
    if (p === 'tags') return await handleTags(res, st.cfg)
    if (p === 'tag') return await handleTag(res, st.cfg, tag)
    if (q) return await handleSearch(res, st.cfg, q)
    return await handleHome(res, st.cfg)
  } catch (err) {
    errorPage(res, st.cfg, err instanceof ZkError ? 503 : 500, '读不出来', publicMessage(err))
  }
}

// ── JSON / RSS ────────────────────────────────────────────────────────

function publicNote(note: NoteRecord): Record<string, unknown> {
  return {
    title: note.title,
    path: note.path,
    tags: note.tags,
    created: localDate(note.created),
    modified: localDate(note.modified),
    type: note.type,
    status: note.status,
    lead: note.lead,
    words: note.words,
  }
}

function limitOf(url: URL): number {
  const raw = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  if (!Number.isFinite(raw)) return 50
  return Math.min(200, Math.max(1, raw))
}

async function handleApiNotes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res, 'json')) return
  const url = parseRequestUrl(req)
  if (!url) { json(res, 400, { ok: false, error: 'Host 头不是合法地址' }); return }
  const st = state()
  if (!st.ready) { json(res, 503, { ok: false, error: st.reason }); return }
  const q = (url.searchParams.get('q') ?? '').trim()
  const tag = (url.searchParams.get('tag') ?? '').trim()
  try {
    const notes = await pickNotes(st.cfg, { q, tag, limit: limitOf(url) })
    json(res, 200, { ok: true, count: notes.length, notes: notes.map(publicNote) })
  } catch (err) {
    json(res, 503, { ok: false, error: publicMessage(err) })
  }
}

async function handleApiNote(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res, 'json')) return
  const url = parseRequestUrl(req)
  if (!url) { json(res, 400, { ok: false, error: 'Host 头不是合法地址' }); return }
  const st = state()
  if (!st.ready) { json(res, 503, { ok: false, error: st.reason }); return }
  const rel = (url.searchParams.get('path') ?? '').trim()
  if (!rel) { json(res, 400, { ok: false, error: '缺少 path 参数（相对笔记本的笔记路径）' }); return }
  try {
    const { doc, rel: normalized } = await loadNote(st.cfg, rel)
    const content = doc.content.length > MAX_CONTENT ? doc.content.slice(0, MAX_CONTENT) : doc.content
    json(res, 200, {
      ok: true,
      note: {
        ...publicNote(doc),
        path: normalized,
        content,
        chars: doc.content.length,
        truncated: content.length < doc.content.length,
      },
    })
  } catch (err) {
    const missing = err instanceof ZkError && err.code === 'not-found'
    json(res, missing ? 404 : 400, { ok: false, error: publicMessage(err) })
  }
}

function rssDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toUTCString()
}

/**
 * RSS：只在真读到索引时才给 200。
 * 没初始化 / zk 挂了就回 503 + 原因 —— 一个 200 的空频道会被阅读器当成功缓存住，
 * 用户看到的是「今天没有新笔记」，而不是「插件坏了」。
 */
async function handleFeed(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res, 'xml')) return
  const st = state()
  if (!st.ready) { sendText(res, 503, st.reason); return }
  let notes: NoteRecord[]
  try {
    notes = (await loadAll(st.cfg)).sort(byModified).slice(0, 30)
  } catch (err) {
    sendText(res, 503, publicMessage(err))
    return
  }
  const origin = requestOrigin(req)
  const items = notes.map((note) => [
    '<item>',
    `<title>${esc(note.title || note.path)}</title>`,
    `<link>${esc(origin + noteHref(note.path))}</link>`,
    `<guid isPermaLink="false">${esc(note.path)}</guid>`,
    `<pubDate>${esc(rssDate(note.modified || note.created))}</pubDate>`,
    `<description>${esc(note.lead)}</description>`,
    '</item>',
  ].join('')).join('')
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${esc((st.cfg.active || 'zdiary') + ' · 只读笔记')}</title>`,
    `<link>${esc(origin + VIEW)}</link>`,
    '<description>只读笔记流（最近 30 篇）</description>',
    '<language>zh-CN</language>',
    items,
    '</channel></rss>',
  ].join('')
  sendText(res, 200, xml, 'application/rss+xml; charset=utf-8')
}

// ── 挂载 ──────────────────────────────────────────────────────────────

export function registerReadOnly({ route }: ReadOnlyDeps): void {
  // handler 自己 guard / 解析 URL：畸形 Host 在 guard 里或 parseRequestUrl 里就被收住，
  // 不会在路由外抛错落到兜底的 500 JSON
  route(VIEW, handleView)
  route(FEED, handleFeed)
  route(API_NOTES, handleApiNotes)
  route(API_NOTE, handleApiNote)
}
