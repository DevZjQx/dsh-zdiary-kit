/**
 * dsh-zdiary-kit —— 客户端半边：DSH「设置 → 知识库（zk）」section
 *
 * 数据流：section ⇄ /dsh-zdiary-kit/api/*（同源 fetch）⇄ ~/.dsh/zdiary/zdiary.config.json
 * 两半读同一份配置（config/store 是唯一真相）。
 *
 * 【结构例外】本文件必须单文件零 import：DSH web 的 __ModuleLoader__ 直接把它当普通脚本
 * 加载，只提供 require("react")。所以类型也是自带的，feature.ts 也不 import 它 ——
 * 两侧靠 API 路径与配置键对齐。
 *
 * 【禁止顶层声明】DSH 把多个插件的 client.js **拼进同一个 combo 脚本**（/plugins/??a/client.js,b/client.js）
 * 再当普通脚本执行，顶层 const/let/function 落在同一个全局词法作用域里。以前这里写
 * `const loader = window.__ModuleLoader__`，和同样写法的插件撞名，整个 combo 报
 * "Identifier 'loader' has already been declared"，本插件直接不激活。所以顶层只能是
 * 表达式语句（和官方 banner 一致：window.__ModuleLoader__.load({...})），要局部变量就包 IIFE。
 */

type CreateElement = (tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
interface ReactLike {
  createElement: CreateElement
  useState: <T>(init: T) => [T, (next: T | ((prev: T) => T)) => void]
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]) => T
  useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void
}
interface ModuleLoader {
  load(spec: { id: string; factory: (require: (name: string) => ReactLike) => unknown }): void
}

interface ZkConfig {
  notebook: string
  notesDir: string
  dailyDir: string
  dailyGroup: string
  defaultTags: string[]
  maxReadChars: number
  memoryBudgetWords: number
  structure: string
  archiveDir: string
  zkVersion: string
  zkPath: string
}
interface ZkStatus { found: boolean; version?: string; path?: string; source?: string; hint?: string }
interface Counts { notes: number; tags: number; brokenLinks: number; orphans: number; archived: number; superseded: number }
interface Structure {
  mode: string
  dirs: string[]
  missing: string[]
  ready: boolean
  agents: { path: string; required: boolean; present: boolean }
}
interface Memory {
  words: number
  budget: number
  truncatedWords: number
  files: Array<{ name: string; present: boolean; words: number }>
}
interface Snapshot {
  ok?: boolean
  error?: string
  warn?: string | null
  config: ZkConfig
  configPath?: string
  zk: ZkStatus
  notebook: { path: string; exists: boolean }
  structure?: Structure
  memory?: Memory | null
  counts: Counts | null
  countsError: string | null
  dailyTemplate?: boolean
}
interface SelftestItem { name: string; ok: boolean; detail: string }
interface SelftestResp { ok: boolean; items?: SelftestItem[]; error?: string }

interface Field {
  group: string
  key: keyof ZkConfig | 'defaultTagsText'
  label: string
  hint: string
  /** select 只在结构模式上用（枚举值必须来自这里，不能让人手打） */
  kind?: 'text' | 'select'
  options?: Array<{ value: string; label: string }>
}

;(window as unknown as { __ModuleLoader__?: ModuleLoader }).__ModuleLoader__?.load({
  id: 'dsh-zdiary-kit',
  factory: (require) => {
    const module = { exports: {} as Record<string, unknown> }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/dsh-zdiary-kit/api'
    const CSS = [
      '.zdk{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
      '.zdk-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.zdk-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}',
      '.zdk-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px}',
      '.zdk-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.zdk-row:last-child{border-bottom:none}',
      '.zdk-row>div:first-child{flex:1;min-width:200px}',
      '.zdk-label{font-size:13px;line-height:19px}',
      '.zdk-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px;white-space:pre-line}',
      '.zdk-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:240px;outline:none}',
      '.zdk-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.zdk-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.zdk-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}',
      '.zdk-btn:disabled{opacity:.5;cursor:default}',
      '.zdk-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.zdk-out{white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:280px;overflow:auto;margin-top:10px}',
      '.zdk-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}',
      '.zdk-ok{color:var(--dsw-alias-state-success-primary,#3ec46d);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}',
    ].join('')
    ;(() => {
      const tag = 'zdiary/section.css'
      const old = document.getElementById(tag)
      if (old) old.remove()
      const style = document.createElement('style')
      style.id = tag
      style.textContent = CSS
      document.head.appendChild(style)
    })()

    const FIELDS: Field[] = [
      { group: '笔记本', key: 'notebook', label: '笔记本目录', hint: 'zk 笔记本的根目录（含 .zk/）。空着 = <工作区>/zdiary（放工作区内，agent 才能直接读写）；相对路径按工作区解析；也可以指向任何已有 zk 笔记本' },
      { group: '笔记本', key: 'notesDir', label: '笔记子目录', hint: '普通笔记放哪（相对笔记本），默认 notes' },
      { group: '笔记本', key: 'dailyDir', label: '日记子目录', hint: '日记放哪（相对笔记本），默认 journal；文件名由日期模板生成' },
      { group: '笔记本', key: 'dailyGroup', label: '日记 group 名', hint: 'zk 配置里的 [group."…"]，默认 daily —— 初始化时会自动补上' },
      { group: '笔记本', key: 'archiveDir', label: '归档目录', hint: 'supersede 之后笔记搬到这里（保留原相对路径，不删除），默认 archive；改动后点「按配置补建目录」' },
      {
        group: '结构与记忆',
        key: 'structure',
        label: '结构模式',
        hint: 'flat = 只有 notes/ 与日记（默认，与 0.1.0 一致）；layered = 加 raw/ inbox/ notes 分类目录/ archive/ 与三套模板。\n切换只建目录与模板，不搬已有笔记；保存后点「按配置补建目录」',
        kind: 'select',
        options: [
          { value: 'flat', label: 'flat（简单：notes/ + 日记）' },
          { value: 'layered', label: 'layered（分层：raw → notes/* → MEMORY.md）' },
        ],
      },
      { group: '结构与记忆', key: 'memoryBudgetWords', label: '注入预算（词）', hint: 'AGENTS.md + USER.md + MEMORY.md 的合计上限，默认 300（中文按 2 字 1 词）。超了先丢 MEMORY 尾部整段，并回显截断了多少' },
      { group: '写入', key: 'defaultTagsText', label: '默认标签', hint: '新笔记自动追加的标签，逗号分隔，不带 #（可空）' },
      { group: '写入', key: 'maxReadChars', label: 'zk_read 单次上限（字符）', hint: '默认 20000；超了会截断并明确告知模型' },
      { group: 'zk', key: 'zkPath', label: 'zk 路径（可空）', hint: '空 = 自动找：配置 → $ZK_BIN → PATH → 插件内置（~/.dsh/zdiary/bin）' },
      { group: 'zk', key: 'zkVersion', label: '内置 zk 版本', hint: '「安装内置 zk」下载的版本，默认 0.15.7；改完点安装即升级' },
    ]

    const SOURCE: Record<string, string> = { config: '设置里的路径', env: '$ZK_BIN', path: 'PATH', managed: '插件内置' }

    function Section() {
      const [cfg, setCfg] = useState<ZkConfig | null>(null)
      const [tagsText, setTagsText] = useState('')
      const [saved, setSaved] = useState('')
      const [snap, setSnap] = useState<Snapshot | null>(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [okMsg, setOkMsg] = useState('')
      const [out, setOut] = useState('')

      const applySnap = useCallback((d: Snapshot) => {
        setSnap(d)
        if (d.config) {
          setCfg(d.config)
          setTagsText((d.config.defaultTags || []).join(', '))
          setSaved(JSON.stringify({ ...d.config, defaultTags: d.config.defaultTags || [] }))
        }
      }, [])

      const load = useCallback(async () => {
        setBusy('load'); setErr(''); setOkMsg('')
        try {
          const r = await fetch(`${API}/settings`, { headers: { accept: 'application/json' } })
          const d = await r.json() as Snapshot
          if (!d.ok) throw new Error(d.error || '读取失败')
          applySnap(d)
        } catch (e) { setErr(String((e as Error).message || e)) }
        finally { setBusy('') }
      }, [applySnap])
      useEffect(() => { load() }, [load])

      const save = useCallback(async () => {
        if (!cfg) return
        // flat → layered 是单向的结构变化：明确说「只建目录不搬文件」，别让人以为笔记会被整理
        const switching = snap?.structure?.mode === 'flat' && cfg.structure === 'layered'
        if (switching && !window.confirm(
          '切到 layered 只会新建目录与模板：\n' +
          '  raw/ · inbox/ · notes/{sources,concepts,entities,patterns}/ · archive/\n' +
          '  daily.md / source.md / entry.md 三套模板 · 根目录 AGENTS.md\n\n' +
          '**不会**移动、改写或删除任何已有笔记。\n\n' +
          '保存后需要点「按配置补建目录」才会真正建出来。继续？',
        )) return
        setBusy('save'); setErr(''); setOkMsg('')
        try {
          const body = {
            config: {
              ...cfg,
              defaultTags: tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            },
          }
          const r = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const d = await r.json() as Snapshot
          if (!d.ok) throw new Error(d.error || '保存失败')
          applySnap(d)
          setOkMsg('✓ 已保存' + (d.warn ? '\n⚠️ ' + d.warn : ''))
        } catch (e) { setErr(String((e as Error).message || e)) }
        finally { setBusy('') }
      }, [cfg, tagsText, applySnap])

      const action = useCallback(async (name: string, path: string) => {
        setBusy(name); setErr(''); setOkMsg(''); setOut('')
        try {
          const r = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          const d = await r.json() as Snapshot & { detail?: string; result?: Record<string, unknown> }
          if (!d.ok) throw new Error(d.error || '操作失败')
          applySnap(d)
          if (name === 'install') setOkMsg('✓ ' + (d.detail || '已安装'))
          if (name === 'init') {
            const res = d.result as {
              initialized?: boolean
              configPatched?: boolean
              dirsCreated?: string[]
              templatesWritten?: string[]
              agentsWritten?: boolean
            } | undefined
            const r = res || {}
            const parts = [r.initialized ? '已初始化' : '笔记本已存在']
            if (r.dirsCreated && r.dirsCreated.length) parts.push(`新建目录 ${r.dirsCreated.length} 个`)
            if (r.templatesWritten && r.templatesWritten.length) parts.push('写入模板 ' + r.templatesWritten.join(' / '))
            if (r.agentsWritten) parts.push('写入 AGENTS.md')
            if (r.configPatched && !(r.templatesWritten && r.templatesWritten.length) && !(r.dirsCreated && r.dirsCreated.length)) parts.push('补齐 group')
            setOkMsg('✓ ' + parts.join(' · '))
          }
          if (name === 'index') setOkMsg('✓ 索引已重建')
        } catch (e) { setErr(String((e as Error).message || e)) }
        finally { setBusy('') }
      }, [applySnap])

      const selftest = useCallback(async () => {
        setBusy('selftest'); setErr(''); setOkMsg(''); setOut('')
        try {
          const d = await fetch(`${API}/selftest`).then((x) => x.json() as Promise<SelftestResp>)
          setOut((d.items || []).map((it) => `${it.ok ? '✓' : '✗'} ${it.name}：${it.detail}`).join('\n') + (d.ok ? '\n\n══ 全部通过 ✓' : '\n\n══ 有 ✗，照提示修'))
          if (!d.ok && d.error) setErr(d.error)
        } catch (e) { setErr(String((e as Error).message || e)) }
        finally { setBusy('') }
      }, [])

      if (!cfg) {
        return h('div', { className: 'zdk' },
          h('h3', { className: 'zdk-title' }, '知识库（zk）'),
          busy ? h('div', { className: 'zdk-hint' }, '读取中…') : err ? h('div', { className: 'zdk-err' }, err) : null)
      }

      const dirty = saved !== JSON.stringify({ ...cfg, defaultTags: tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })
      const input = { className: 'zdk-input', autoComplete: 'off', spellCheck: false }
      const up = (key: string, value: string) => setCfg((s) => (s ? { ...s, [key]: value } as ZkConfig : s))
      const groups = [...new Set(FIELDS.map((f) => f.group))]

      /** 一个字段 → 控件（结构模式是 select：枚举值不接受手打） */
      const control = (f: Field) => {
        const value = f.key === 'defaultTagsText'
          ? tagsText
          : String((cfg as unknown as Record<string, unknown>)[f.key] ?? '')
        const onChange = (e: { target: { value: string } }) =>
          f.key === 'defaultTagsText' ? setTagsText(e.target.value) : up(f.key, e.target.value)
        if (f.kind === 'select') {
          return h('select', { ...input, value, onChange },
            ...(f.options || []).map((o) => h('option', { key: o.value, value: o.value }, o.label)))
        }
        return h('input', { ...input, value, onChange })
      }

      const zk = snap?.zk
      const counts = snap?.counts
      const structure = snap?.structure
      const memory = snap?.memory
      const statusLine = !zk ? '' : !zk.found
        ? 'zk 还没装：' + (zk.hint || '')
        : `zk ${zk.version}（${SOURCE[zk.source || ''] || zk.source}）· 笔记本 ${snap?.notebook.exists ? '就绪' : '还没初始化'}` +
          (counts
            ? ` · ${counts.notes} 篇笔记 / ${counts.tags} 个标签 / 断链 ${counts.brokenLinks} / 归档 ${counts.archived}（superseded ${counts.superseded}）`
            : '')
      const memoryLine = !memory
        ? ''
        : `记忆 ${memory.words}/${memory.budget} 词（${memory.files.filter((f) => f.present).map((f) => f.name).join(' + ') || '三份都空'}）` +
          (memory.truncatedWords > 0 ? ` · 已截断 ${memory.truncatedWords} 词` : '')
      // 结构以配置为准：磁盘不一致只告警 + 给按钮，不自动建、不自动删
      const structureWarn = !structure || !snap?.notebook.exists ? '' : !structure.ready
        ? `结构是 ${structure.mode}，但缺目录：${structure.missing.join('、')}`
        : structure.agents.required && !structure.agents.present
          ? '结构是 layered，但根目录缺 AGENTS.md（agent 的工作约定与注入内容）'
          : ''

      return h('div', { className: 'zdk' },
        h('h3', { className: 'zdk-title' }, '知识库（zk）'),
        h('p', { className: 'zdk-intro' },
          '把你的 zk 笔记本接进 DSH：agent 用 zk_* 工具搜索、读写笔记与日记，双链交给 zk 索引。' +
          '没装 zk 就让插件装一个 —— 第一次调用工具时会自动建好笔记本，不需要先来这里点任何按钮。'),
        statusLine ? h('div', { className: 'zdk-hint' }, '📚 ' + statusLine) : null,
        memoryLine ? h('div', { className: 'zdk-hint' }, '🧠 ' + memoryLine) : null,
        structureWarn
          ? h('div', { className: 'zdk-err' },
            '⚠️ ' + structureWarn + ' ',
            h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('init', 'init'), disabled: !!busy },
              busy === 'init' ? '补建中…' : '按配置补建目录'))
          : null,

        ...groups.map((g) => h('div', { key: g },
          h('div', { className: 'zdk-group' }, g),
          h('div', null, FIELDS.filter((f) => f.group === g).map((f) =>
            h('div', { className: 'zdk-row', key: f.key },
              h('div', null,
                h('div', { className: 'zdk-label' }, f.label),
                h('div', { className: 'zdk-hint' }, f.hint)),
              control(f)))))),

        h('div', { className: 'zdk-actions' },
          h('button', { className: 'zdk-btn', onClick: save, disabled: !!busy }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('init', 'init'), disabled: !!busy }, busy === 'init' ? '初始化中…' : '初始化笔记本'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('index', 'index'), disabled: !!busy }, busy === 'index' ? '索引进…' : '重建索引'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('install', 'install'), disabled: !!busy }, busy === 'install' ? '下载中…' : '安装内置 zk'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: selftest, disabled: !!busy }, busy === 'selftest' ? '自检中…' : '自检'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: load, disabled: !!busy }, '刷新'),
          dirty ? h('span', { style: { marginLeft: '10px', color: '#ffb020', fontSize: '13px', alignSelf: 'center' } }, '● 有改动还没保存') : null),

        okMsg ? h('div', { className: 'zdk-ok' }, okMsg) : null,
        err ? h('div', { className: 'zdk-err' }, err) : null,
        out ? h('div', { className: 'zdk-out' }, out) : null,
        snap?.countsError ? h('div', { className: 'zdk-err' }, '计数失败：' + snap.countsError) : null,
        h('div', { className: 'zdk-hint' },
          `配置：${snap?.configPath || '~/.dsh/zdiary/zdiary.config.json'}\n` +
          '工具的用法：zk_search 查 → zk_read 读 → zk_new 新建 → zk_daily 写日记 → zk_link 连双链；zk_stats 看规模。'))
    }

    function apply(ctx: { effect: (fn: () => unknown, label?: string) => void; slots: { inject: (name: string, fn: () => unknown, label?: string) => unknown; register: (spec: Record<string, unknown>, component: unknown) => unknown } }): void {
      ctx.effect(
        () => ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'zdiary', order: 8, label: () => '知识库（zk）' },
            Section,
          ),
          'zdiary: settings section'),
        'zdiary: settings section',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.Section = Section
    return module.exports
  },
})
