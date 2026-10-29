#!/usr/bin/env node
/**
 * 人也能用的命令行（和 agent 的 zk_* 工具走同一套 lib，不重复实现）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config, writeConfig, selectNotebook, isNotebookName, CONFIG_KEYS } from './config/store.ts'
import type { Config } from './config/store.ts'
import { CFG_FILE } from './config/paths.ts'
import { ensureNotebook, structureStatus } from './lib/notebook.ts'
import { buildMemoryPayload, formatFileShares } from './lib/memory.ts'
import { installZk } from './lib/install.ts'
import {
  resolveZk, searchNotes, queryNotes, createNote, readNote, findNote, appendToNote, ensureDailyNote,
  appendDaily, linkNotes, notebookStats, indexNotebook, withTags, hasNotebook, localDate, ZkError,
  allNotes, parseErrorWarnings, archivedSameTitle,
} from './lib/zk.ts'
import type { NoteRecord } from './lib/zk.ts'
import { formatMemoryLinks, lintNotebook } from './lib/lint.ts'
import type { LintResult } from './lib/lint.ts'
import { dreamNotebook } from './lib/dream.ts'
import type { DreamResult } from './lib/dream.ts'

const HELP = `zk-kit —— dsh-zdiary-kit 的命令行

  zk-kit doctor                       自检：zk / 笔记本 / 模板 / group / 索引
  zk-kit install [版本]                安装内置 zk（默认取配置里的版本）
  zk-kit init                         建好（或补齐）笔记本
  zk-kit new --title T [--body B] [--tags a,b] [--dir notes]
  zk-kit search [词] [--tags a,b] [--since 日期] [--limit 5] [--json]
  zk-kit read <路径> | --query 词 [--max-chars n] [--json]
  zk-kit daily [--entry 一段] [--date yesterday]
  zk-kit append <路径> --text 一段 [--heading 标题]
  zk-kit link <来源路径> <目标路径或标题>
  zk-kit lint [--stale-days 90]       体检：断链 / 孤儿 / 无标签 / 缺反链 / 陈旧 / 重名（只读）
  zk-kit dream [--days 7]             晋升材料：窗口新增 / daily 未完成 / 被引最多（只读）
  zk-kit query [-- <zk list 参数>]     透传 zk list（--notebook-dir / --format / -x 会被替换掉）
  zk-kit index                        重建索引
  zk-kit notebooks                    列出所有笔记本（* 是当前那个；[flat/layered] 是各自的结构）
  zk-kit notebooks add 名 路径         加一个笔记本（路径空 = <工作区>/zdiary；结构跟当前笔记本一致）
  zk-kit notebooks use 名              切换当前笔记本（自动建好目标笔记本，幂等）
  zk-kit notebooks remove 名           从配置移除一个笔记本（只删配置，磁盘目录与笔记保留；至少留一个；删的是当前那个就自动切到剩下的第一个）
  zk-kit config [get [键]]             看配置（不传键 = 全量；未知键报错）
  zk-kit config set 键=值 [键=值 …]     改配置（只落盘，不建目录；structure 改的是当前笔记本，切完跑 zk-kit init）

除 doctor / help 外，其余子命令加 --json 输出结构化结果。`

interface Parsed {
  pos: string[]
  flags: Record<string, string | boolean>
}

function parse(argv: string[]): Parsed {
  const out: Parsed = { pos: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { out.pos.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--')) { out.pos.push(a); continue }
    const eq = a.indexOf('=')
    if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++ } else { out.flags[key] = true }
  }
  return out
}

const str = (v: string | boolean | undefined): string => (v === true || v === undefined ? '' : String(v))
const list = (v: string | boolean | undefined): string[] =>
  str(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
const print = (value: unknown, asJson: boolean): void => {
  console.log(asJson || typeof value !== 'string' ? JSON.stringify(value, null, 2) : value)
}

/** 配置值给人看：数组摊平、笔记本表摊成 名=路径 [结构]，其它照原样（`print` 会把非字符串 JSON 化） */
const fmtValue = (v: unknown): string => {
  if (Array.isArray(v)) return v.length ? v.join(', ') : '[]'
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => {
        const entry = val as { path?: unknown; structure?: unknown } | null
        if (entry && typeof entry === 'object' && 'path' in entry) {
          return `${k}=${String(entry.path ?? '') || '(默认)'} [${String(entry.structure ?? '')}]`
        }
        return `${k}=${String(val ?? '') || '(默认)'}`
      })
      .join(', ')
  }
  return String(v)
}

const KEYS = CONFIG_KEYS as ReadonlyArray<keyof Config>
const isKey = (k: string): k is keyof Config => KEYS.includes(k as keyof Config)
const USAGE_CONFIG = `用法：zk-kit config [get [键]] | zk-kit config set 键=值 [键=值 …]（键：${KEYS.join(' / ')}）`
const USAGE_NOTEBOOKS = '用法：zk-kit notebooks [add 名 路径 | use 名 | remove 名]'

/** 列出笔记本：解析后的路径 + 各自的结构 + 是不是 zk 笔记本（换笔记本就是换 active，子目录那些是全局的） */
function notebookList(cfg: Config): string {
  const names = Object.keys(cfg.notebooks)
  const width = Math.max(7, ...names.map((n) => n.length))
  const lines = [`笔记本 ${names.length} 个（当前 ${cfg.active}）：`]
  for (const name of names) {
    const target = selectNotebook(cfg, name)
    const mark = name === cfg.active ? '*' : ' '
    lines.push(`${mark} ${name.padEnd(width)}  ${target.notebook} [${target.structure}]${hasNotebook(target) ? '' : '（不是 zk 笔记本 —— 跑 zk-kit init）'}`)
  }
  return lines.join('\n')
}

/**
 * 切换后自动建好目标笔记本（ensureNotebook 幂等，缺了才补）。
 * 失败只告警不改退出码 —— 切换本身已经落盘；返回值拼进人看的那行输出。
 */
async function autoInit(next: Config): Promise<string> {
  try {
    const r = await ensureNotebook(next)
    return r.initialized ? '（已自动建好）' : ''
  } catch (err) {
    console.error(`⚠️ 自动初始化失败：${err instanceof Error ? err.message : String(err)} —— 跑 zk-kit init 重试`)
    return ''
  }
}

/** 名字不存在时的报错：顺手把现有的列出来（打错名字不用再跑一次 list） */
function missingNotebook(name: string, cfg: Config): ZkError {
  return new ZkError(`没有这个笔记本：${name || '（空）'}（现有：${Object.keys(cfg.notebooks).join('、')}）`)
}

function noteList(notes: NoteRecord[]): string {
  if (!notes.length) return '没有匹配的笔记'
  const lines = [`${notes.length} 条：`]
  for (const [i, n] of notes.entries()) {
    const tags = n.tags.length ? ' · ' + n.tags.map((t) => '#' + t).join(' ') : ''
    lines.push(`${i + 1}. ${n.title || n.path}\n   ${n.path} · ${localDate(n.created)}${tags}${n.lead ? '\n   ' + n.lead : ''}`)
  }
  return lines.join('\n')
}

function lintReport(r: LintResult): string {
  const sample = (items: Array<{ path: string }>): string => {
    const head = items.slice(0, 5).map((n) => n.path).join('、')
    return items.length > 5 ? head + ' …' : head
  }
  const row = (label: string, total: number, items: Array<{ path: string }>): string =>
    total === 0 ? `✓ ${label}：0` : `✗ ${label}：${total} 篇 — ${sample(items)}`
  const lines = [`体检 ${r.notebook}：${r.notes} 篇笔记（陈旧阈值 ${r.staleDays} 天）`]
  lines.push(r.parseErrors.total === 0
    ? '✓ 解析失败：0'
    : `✗ 解析失败：${r.parseErrors.total} 篇 — ` +
      r.parseErrors.items.slice(0, 5).map((e) => `${e.path}（${e.reason}）`).join('、') +
      (r.parseErrors.total > 5 ? ' …' : '') +
      '｜这些笔记没进索引：搜不到，也不进别的项；修好 frontmatter 重跑一次')
  lines.push(row('断链', r.brokenLinks.total, r.brokenLinks.items))
  lines.push(row('孤儿', r.orphans.total, r.orphans.items))
  lines.push(row('无标签', r.tagless.total, r.tagless.items))
  lines.push(row('缺反链', r.missingBacklink.total, r.missingBacklink.items))
  lines.push(r.stale.total === 0
    ? '✓ 陈旧：0'
    : `✗ 陈旧：${r.stale.total} 篇 — ` + r.stale.items.slice(0, 5).map((s) => `${s.path}（${s.modified}）`).join('、'))
  lines.push(r.duplicateTitles.total === 0
    ? '✓ 重名标题：0'
    : `✗ 重名标题：${r.duplicateTitles.total} 组 — ` + r.duplicateTitles.items.slice(0, 3).map((d) => `「${d.title}」→ ${d.paths.join(' / ')}`).join('；'))
  const memLine = formatMemoryLinks(r.memoryLinks)
  if (memLine) lines.push(memLine)
  if (r.truncated) lines.push('⚠️ 笔记数触到扫描上限：结果不完整')
  lines.push('（只报告，没有改动任何文件）')
  return lines.join('\n')
}

function dreamReport(r: DreamResult): string {
  const lines = [
    `做梦：近 ${r.windowDays} 天（自 ${r.since}）— 窗口 ${r.counts.window} 篇（日记 ${r.counts.daily}）· 候选 ${r.counts.candidates} · 拒绝 ${r.counts.rejected} · 未完成 ${r.counts.looseEnds}`,
  ]
  if (r.newNotes.length) {
    lines.push('晋升候选：')
    for (const [i, n] of r.newNotes.slice(0, 10).entries()) {
      const tags = n.tags.length ? ' · ' + n.tags.map((t) => '#' + t).join(' ') : ''
      const lead = n.lead ? `\n     ${n.lead}` : ''
      const citedBy = n.citedBy.length ? `\n     被引：${n.citedBy.join('、')}` : ''
      lines.push(`  ${i + 1}. ${n.title || n.path}  [${n.type || '—'} · ${n.authority || '—'}]  ${n.path}${tags} · 被引 ${n.cited}${lead}${citedBy}`)
    }
    if (r.newNotes.length > 10) lines.push(`  …还有 ${r.newNotes.length - 10} 篇`)
  }
  if (r.rejected.length) {
    lines.push('机械拒绝（不进候选）：')
    for (const x of r.rejected.slice(0, 10)) lines.push(`  · ${x.title || x.path}（${x.path}）：${x.reason}`)
    if (r.rejected.length > 10) lines.push(`  …还有 ${r.rejected.length - 10} 篇`)
  }
  if (r.dailyLooseEnds.length) {
    lines.push('未完成（daily）：')
    for (const d of r.dailyLooseEnds.slice(0, 10)) lines.push(`  · ${d.path}：${d.items.join('；')}`)
  }
  if (r.topCited.length) {
    lines.push('被引用最多：')
    for (const [i, c] of r.topCited.slice(0, 5).entries()) lines.push(`  ${i + 1}. ${c.title || c.path}（${c.path}）· ${c.cited} 次`)
  }
  if (!r.newNotes.length && !r.dailyLooseEnds.length && !r.topCited.length) lines.push('这个窗口里没有新材料。')
  if (r.truncated) lines.push('⚠️ 笔记数触到扫描上限：窗口与排名都不完整')
  lines.push('（只报告：MEMORY.md / DREAMS.md 由你按 AGENTS.md 写）')
  return lines.join('\n')
}

async function doctor(): Promise<boolean> {
  const cfg = config()
  const zk = await resolveZk(cfg)
  const rows: string[] = []
  rows.push(`${zk ? '✓' : '✗'} zk：${zk ? `${zk.version}（${zk.source}）${zk.bin}` : '没找到 —— 跑 zk-kit install'}`)
  const exists = hasNotebook(cfg)
  rows.push(`${exists ? '✓' : '✗'} 笔记本：${cfg.notebook}${exists ? '' : '（不是 zk 笔记本 —— 跑 zk-kit init）'}`)
  const template = path.join(cfg.notebook, '.zk', 'templates', 'daily.md')
  rows.push(`${fs.existsSync(template) ? '✓' : '✗'} 日记模板：${template}`)
  let group = false
  try {
    group = new RegExp(`^\\[group\\."?${cfg.dailyGroup}"?\\]`, 'm').test(fs.readFileSync(path.join(cfg.notebook, '.zk', 'config.toml'), 'utf8'))
  } catch { group = false }
  rows.push(`${group ? '✓' : '✗'} 日记 group：${cfg.dailyGroup} → ${cfg.dailyDir}/`)

  const st = structureStatus(cfg)
  const structureOk = st.ready && (!st.agents.required || st.agents.present)
  rows.push(
    `${structureOk ? '✓' : '✗'} 结构：${st.mode} · ` +
    (st.ready ? `${st.dirs.length} 个目录齐全` : `缺 ${st.missing.join('、')}（跑 zk-kit init）`) +
    (st.agents.required ? (st.agents.present ? ' · AGENTS.md 就绪' : ' · 缺 AGENTS.md（跑 zk-kit init）') : ''),
  )

  const payload = buildMemoryPayload(cfg)
  const present = payload.files.filter((f) => f.present)
  rows.push(
    present.length === 0
      ? '✓ 记忆：暂未启用（根目录没有 AGENTS.md / USER.md / MEMORY.md）'
      : `${payload.words <= payload.budget ? '✓' : '✗'} 记忆：${payload.words}/${payload.budget} 词（${formatFileShares(payload.files, payload.tocWords)}）` +
        (payload.truncatedWords > 0 ? `，已截断 ${payload.truncatedWords} 词` : ''),
  )

  if (zk && exists) {
    try {
      const s = await notebookStats(cfg)
      rows.push(`✓ 索引：${s.notes} 篇笔记 / ${s.tags} 个标签 / 断链 ${s.brokenLinks} / 孤立 ${s.orphans}`)
      // frontmatter 写坏的笔记不在索引里：zk 只在 stderr 吭一声，不主动收就永远没人知道
      const warnings: string[] = []
      await allNotes(cfg, { warnings })
      const parseErrors = parseErrorWarnings(cfg, warnings)
      if (parseErrors.length > 0) {
        rows.push(
          `⚠️ 解析失败：${parseErrors.length} 篇 — ` +
          parseErrors.slice(0, 3).map((e) => `${e.path}（${e.reason}）`).join('、') +
          '（不在索引里：搜不到，也不进巡检的任何一项）',
        )
      }
    } catch (err) {
      rows.push('✗ 索引：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  console.log(rows.join('\n'))
  // ⚠️ 是内容问题（笔记写坏了），不是装坏了 —— 别让它把 doctor 的退出码翻掉
  return rows.every((r) => r.startsWith('✓') || r.startsWith('⚠️'))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0] ?? 'doctor'
  const raw = argv.slice(1)
  const { pos, flags } = parse(raw)
  const json = flags.json === true
  const cfg = config()

  switch (cmd) {
    case 'doctor':
    case 'status':
      if (!(await doctor())) process.exitCode = 1
      return

    case 'install': {
      const version = str(flags.version) || pos[0] || cfg.zkVersion
      const result = await installZk(version)
      print(json ? result : `已安装 zk ${result.version} → ${result.path}`, json)
      return
    }

    case 'init': {
      const r = await ensureNotebook(cfg)
      print(json ? r : `笔记本 ${r.notebook}（结构 ${cfg.structure}）\n` +
        `初始化：${r.initialized ? '是' : '已是笔记本'} · 目录：${r.dirsCreated.length ? '新建 ' + r.dirsCreated.join('、') : '已齐全'}\n` +
        `模板：${r.templatesWritten.length ? r.templatesWritten.join(' / ') : '已存在'} · group：${r.groupsAdded.length ? r.groupsAdded.join(' / ') : '已存在'} · AGENTS.md：${r.agentsWritten ? '已写入' : (cfg.structure === 'layered' ? '已存在' : 'flat 不写')} · WORKFLOW.md：${r.workflowWritten ? '已写入' : (cfg.structure === 'layered' ? '已存在' : 'flat 不写')}`, json)
      return
    }

    case 'new': {
      const title = str(flags.title) || pos[0] || ''
      if (!title) throw new ZkError('用法：zk-kit new --title 标题 [--body 正文] [--tags a,b]')
      const tags = [...new Set([...cfg.defaultTags, ...list(flags.tags)])]
      const created = await createNote(cfg, {
        title,
        content: withTags(str(flags.body), tags),
        dir: str(flags.dir) || cfg.notesDir,
      })
      const archived = await archivedSameTitle(cfg, created.title)
      print(json ? { ...created, tags, archived } : `已创建 ${created.path}${tags.length ? ' · ' + tags.map((t) => '#' + t).join(' ') : ''}`, json)
      for (const hit of archived) {
        console.error(`⚠️ 归档里有同名旧结论：${hit.path}${hit.reason ? `（废弃原因：${hit.reason}）` : '（没有记录废弃原因）'} —— 先读它，确认不是同一个结论再复用标题`)
      }
      return
    }

    case 'search': {
      const notes = await searchNotes(cfg, {
        query: pos[0] || str(flags.query) || undefined,
        tags: list(flags.tags),
        since: str(flags.since) || undefined,
        limit: Number(str(flags.limit)) || 10,
        sort: str(flags.sort) || 'created-desc',
      })
      print(json ? notes : noteList(notes), json)
      return
    }

    case 'read': {
      const target = str(flags.query) ? '' : (pos[0] ?? '')
      if (!target && !flags.query) throw new ZkError('用法：zk-kit read <路径> 或 zk-kit read --query 搜索词')
      const doc = target ? await readNote(cfg, target) : await findNote(cfg, str(flags.query))
      if (!doc) throw new ZkError('没找到这篇笔记')
      const limit = Number(str(flags.maxChars)) || cfg.maxReadChars
      const content = doc.content.length > limit ? doc.content.slice(0, limit) + '\n\n…（已截断）' : doc.content
      print(json ? { ...doc, content } : `# ${doc.title}\n${doc.path}\n\n${content}`, json)
      return
    }

    case 'daily': {
      const daily = await ensureDailyNote(cfg, { date: str(flags.date) || undefined })
      if (str(flags.entry)) appendDaily(cfg, daily.path, str(flags.entry))
      print(json ? daily : `日记 ${daily.created ? '已新建' : '已存在'}：${daily.path}${str(flags.entry) ? '（已追加一段）' : ''}`, json)
      return
    }

    case 'append': {
      const p = pos[0]
      if (!p || !str(flags.text)) throw new ZkError('用法：zk-kit append <路径> --text 一段')
      const r = appendToNote(cfg, p, str(flags.text), { heading: str(flags.heading) || undefined })
      print(json ? r : `已追加 → ${r.path}（${r.bytes} 字节）`, json)
      return
    }

    case 'link': {
      const [from, to] = [pos[0], pos[1]]
      if (!from || !to) throw new ZkError('用法：zk-kit link <来源路径> <目标路径或标题>')
      const r = await linkNotes(cfg, from, to)
      print(json ? r : `${r.from} → ${r.link}${r.added ? '（已添加）' : '（已存在）'}`, json)
      return
    }

    case 'lint': {
      await ensureNotebook(cfg)
      const r = await lintNotebook(cfg, { staleDays: Number(str(flags['stale-days'])) || 90 })
      print(json ? r : lintReport(r), json)
      return
    }

    case 'dream': {
      await ensureNotebook(cfg)
      const r = await dreamNotebook(cfg, { days: Number(str(flags.days)) || 7 })
      print(json ? r : dreamReport(r), json)
      return
    }

    case 'query': {
      await ensureNotebook(cfg)
      // 透传不给 parse() 处理：-- 之后的参数要原样交给 zk
      const notes = await queryNotes(cfg, raw.filter((a) => a !== '--'))
      print(json ? notes : noteList(notes), json)
      return
    }

    case 'index': {
      await indexNotebook(cfg)
      print(json ? { ok: true } : '✓ 索引已重建', json)
      return
    }

    case 'notebooks': {
      const sub = pos[0] ?? 'list'
      if (sub === 'list') {
        const items = Object.keys(cfg.notebooks).map((name) => {
          const target = selectNotebook(cfg, name)
          return { name, path: target.notebook, structure: target.structure, initialized: hasNotebook(target) }
        })
        print(json ? { active: cfg.active, notebooks: items } : notebookList(cfg), json)
        return
      }
      if (sub === 'add') {
        const name = pos[1] ?? ''
        const p = pos.slice(2).join(' ')
        if (!isNotebookName(name)) {
          throw new ZkError(`笔记本名字不合法：${name || '（空）'}（只接受字母、数字、_ 与 -，1-32 字符）\n${USAGE_NOTEBOOKS}`)
        }
        // 新笔记本结构跟当前那个一致（以前结构是全局的，这就是它的迁移语义）
        const next = writeConfig({ notebooks: { ...cfg.notebooks, [name]: { path: p, structure: cfg.structure } } })
        const target = selectNotebook(next, name)
        if (!hasNotebook(target)) console.error(`⚠️ ${target.notebook} 还不是 zk 笔记本 —— 切过去（zk-kit notebooks use ${name}）会自动建好`)
        const tail = next.active === name ? '' : `（当前还是 ${next.active}）`
        print(json ? { name, notebook: target.notebook, structure: target.structure } : `已新增笔记本 ${name} → ${target.notebook}（结构 ${target.structure}）${tail}`, json)
        return
      }
      if (sub === 'use') {
        const name = pos[1] ?? ''
        if (!(name in cfg.notebooks)) throw missingNotebook(name, cfg)
        const next = writeConfig({ active: name })
        // 切换即就绪：ensureNotebook 幂等，缺了才补；失败只告警（配置已经落盘）
        const tail = await autoInit(next)
        print(json ? { active: next.active, notebook: next.notebook } : `当前笔记本 → ${next.active}（${next.notebook}）${tail}`, json)
        return
      }
      if (sub === 'remove') {
        const name = pos[1] ?? ''
        if (!(name in cfg.notebooks)) throw missingNotebook(name, cfg)
        const map = { ...cfg.notebooks }
        delete map[name]
        const rest = Object.keys(map)
        if (!rest.length) throw new ZkError('至少要留一个笔记本')
        const patch: Record<string, unknown> = { notebooks: map }
        const switched = cfg.active === name
        if (switched) patch.active = rest[0]
        const next = writeConfig(patch)
        const tail = switched ? await autoInit(next) : ''
        print(json ? { removed: name, active: next.active, diskKept: true } : `已从配置移除笔记本 ${name}（当前 ${next.active}）· 磁盘目录与笔记保留${tail}`, json)
        return
      }
      throw new ZkError(USAGE_NOTEBOOKS)
    }

    case 'config': {
      const sub = pos[0] ?? 'get'
      if (sub === 'get') {
        const key = pos[1] ?? ''
        if (!key) {
          const lines = KEYS.map((k) => `${k} = ${fmtValue(cfg[k])}`)
          lines.push('', `配置：${CFG_FILE}`)
          print(json ? cfg : lines.join('\n'), json)
          return
        }
        if (!isKey(key)) throw new ZkError(`没有配置项 ${key} —— ${USAGE_CONFIG}`)
        print(json ? { [key]: cfg[key] } : fmtValue(cfg[key]), json)
        return
      }
      if (sub === 'set') {
        const patch: Record<string, unknown> = {}
        for (const item of pos.slice(1)) {
          const at = item.indexOf('=')
          const key = at > 0 ? item.slice(0, at) : ''
          if (!key) throw new ZkError(USAGE_CONFIG)
          // 派生键有专门语义，单键赋值只会造出第二种真相 —— 直接拦下并指路
          if (key === 'notebook') {
            throw new ZkError('notebook 是派生值（= notebooks[active] 解析后），不落盘也不可写 —— 改路径：zk-kit notebooks add 名 路径；切换：zk-kit notebooks use 名')
          }
          if (key === 'notebooks') {
            throw new ZkError('notebooks 是整体映射，不接受单键赋值 —— 用 zk-kit notebooks add / use / remove 管理')
          }
          if (!isKey(key)) throw new ZkError(USAGE_CONFIG)
          patch[key] = item.slice(at + 1)
        }
        if (!Object.keys(patch).length) throw new ZkError(USAGE_CONFIG)
        const next = writeConfig(patch)
        const touched = Object.keys(patch).filter(isKey)
        console.log(touched.map((k) => `${k} = ${fmtValue(next[k])}`).join('\n'))
        // 归一化会把不合法值悄悄换成安全值（例：structure=xyz → flat），不回显就等于命令"成功了但没生效"
        const normalized = touched.filter((k) => fmtValue(next[k]) !== String(patch[k]).trim())
        if (normalized.length) {
          console.error('⚠️ 归一化：' + normalized.map((k) => `${k} 写入 "${String(patch[k])}" → 实际 "${fmtValue(next[k])}"`).join('；'))
        }
        // 与设置页同一套告警：只保存配置不自动建目录，切结构后要显式 init
        const warn: string[] = []
        if (next.zkPath && !fs.existsSync(next.zkPath)) warn.push('zk 路径不存在：' + next.zkPath)
        if (!hasNotebook(next)) {
          warn.push('这个目录还不是 zk 笔记本 —— 跑 zk-kit init')
        } else {
          const st = structureStatus(next)
          if (st.missing.length) warn.push(`结构是 ${st.mode}，但还缺目录：${st.missing.join('、')} —— 跑 zk-kit init`)
          if (st.agents.required && !st.agents.present) warn.push('layered 结构缺 AGENTS.md —— 跑 zk-kit init')
        }
        for (const line of warn) console.error('⚠️ ' + line)
        return
      }
      throw new ZkError(USAGE_CONFIG)
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return

    default:
      throw new ZkError(`不认识的命令：${cmd}（zk-kit help 看用法）`)
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof ZkError && err.hint ? `${err.message}\n提示：${err.hint}` : err instanceof Error ? err.message : String(err)
  console.error('✗ ' + msg)
  process.exitCode = 1
})
