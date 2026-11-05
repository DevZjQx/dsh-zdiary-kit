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

interface NotebookEntry { path: string; structure: string }
interface ZkConfig {
  /** 当前笔记本解析后的绝对路径（派生值，不落盘、不可写） */
  notebook: string
  /** 名字 → {path, structure}；路径与结构都是每个笔记本自己的 */
  notebooks: Record<string, NotebookEntry>
  active: string
  notesDir: string
  dailyDir: string
  dailyGroup: string
  defaultTags: string[]
  maxReadChars: number
  /** 是否把 .zk/config.toml 的 [alias] 注册成 zk_<名> 工具（默认 false） */
  aliasTools: boolean
  memoryBudgetWords: number
  personaBudgetWords: number
  /** 全图统计上限（篇）：0 = 永不建全图 */
  graphBudgetNotes: number
  /** 当前笔记本的结构（= notebooks[active].structure；派生视图，落在条目里） */
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
  /** 盘上存在、但不属于当前结构的目录（flat 库里的分层目录） */
  extra: string[]
  ready: boolean
  agents: { path: string; required: boolean; present: boolean }
  /** 期望 group 与 .zk/config.toml 的对照（旧后端没有这几个字段） */
  groupsOk?: boolean
  groups?: Array<{ name: string; expectedPaths: string[]; actualPaths: string[] | null; pathsOk: boolean; present: boolean }>
  /** 给人看的差异说明（含 group 路径重叠） */
  groupWarnings?: string[]
}
interface Memory {
  words: number
  budget: number
  /** 模型真正收到的记忆载荷（含框 / 提示 / 人格）；合计数要用它，不是 words */
  totalWords: number
  truncatedWords: number
  /** 截断目录占的词数（0 = 没有目录） */
  tocWords: number
  files: Array<{ name: string; present: boolean; words: number }>
}
interface Snapshot {
  ok?: boolean
  error?: string
  warn?: string | null
  config: ZkConfig
  configPath?: string
  /** 配置文件的指纹：保存时带回，别处改过就 409（乐观并发） */
  stamp?: string
  /** 本页解析空 / 相对路径时用的工作区（插件进程的；agent 工具按各自会话工作区） */
  workspace?: string
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
  /** 控件形态：默认单行文本；bool = 复选框（值为布尔，不走字符串） */
  type?: 'text' | 'bool'
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
      '.zdk-check{display:flex;align-items:center;gap:8px;height:28px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.zdk-check input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
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
      { group: '目录与 group', key: 'notesDir', label: '笔记子目录', hint: '普通笔记放哪（相对笔记本），默认 notes —— 所有笔记本共用' },
      { group: '目录与 group', key: 'dailyDir', label: '日记子目录', hint: '日记放哪（相对笔记本），默认 journal；文件名由日期模板生成 —— 所有笔记本共用' },
      { group: '目录与 group', key: 'dailyGroup', label: '日记 group 名', hint: 'zk 配置里的 [group."…"]，默认 daily —— 初始化时会自动补上；所有笔记本共用' },
      { group: '目录与 group', key: 'archiveDir', label: '归档目录', hint: 'supersede 之后笔记搬到这里（保留原相对路径，不删除），默认 archive；所有笔记本共用。旧归档目录非空时拒绝改动 —— 插件不会自动迁移文件' },
      { group: '记忆', key: 'memoryBudgetWords', label: '注入预算（词）', hint: 'AGENTS.md + USER.md + MEMORY.md 的合计上限，默认 500（中文按 2 字 1 词）。超了先丢 MEMORY 里日期最旧的条目（一条日期都没有才退回从尾部丢），并回显截断了多少' },
      { group: '记忆', key: 'personaBudgetWords', label: '人格上限（词）', hint: 'PERSONA.md 的上限，默认 240（50-800）。人格永远注入、不参与截断；超了只告警' },
      { group: '写入', key: 'defaultTagsText', label: '默认标签', hint: '新笔记自动追加的标签，逗号分隔，不带 #（可空）' },
      { group: '写入', key: 'maxReadChars', label: '单次读取上限（字符）', hint: '默认 20000；zk-kit read 与别名工具的输出超了会截断并明确告知模型' },
      { group: '工具', key: 'graphBudgetNotes', label: '全图统计上限（篇）', hint: '库超过这个篇数时不再建全图统计入链：zk_dream 跳过入链统计（graphSkipped），zk_lint 的单向链接改按篇反查。默认 2000（0-10000，0 = 永不建全图）；上限 = 单次扫描上限，再高等于总是建全图。全图在 10k 上要 26–31 秒，调高前先确认等得起' },
      { group: '工具', key: 'aliasTools', label: '把 [alias] 注册成工具', hint: '默认关闭。打开后，加载插件时把各笔记本 .zk/config.toml 的 [alias] 里未注释的别名注册成 zk_<名>，模型可以像调内置工具一样调它们。\n别名是 $SHELL -c 执行的任意命令 —— 打开等于把这些命令交给 agent，只在你信得过 config.toml 内容时开。\n交互式命令（edit / 带 --interactive）会卡到超时，不适合当工具。改完要重载插件（或重启 DSH）才会出现在工具列表里', type: 'bool' },
      { group: 'zk', key: 'zkPath', label: 'zk 路径（可空）', hint: '空 = 自动找：配置 → $ZK_BIN → PATH → 插件内置（~/.dsh/zdiary/bin）' },
      { group: 'zk', key: 'zkVersion', label: '内置 zk 版本', hint: '「安装内置 zk」下载的版本，默认 0.15.7；改完点安装即升级' },
    ]

    const SOURCE: Record<string, string> = { config: '设置里的路径', env: '$ZK_BIN', path: 'PATH', managed: '插件内置' }

    // 分组标题直接标出作用范围：只有「笔记本」这一组跟着当前笔记本走，其余都是全局的。
    const GROUP_LABELS: Record<string, string> = {
      '目录与 group': '目录与 group · 全局（所有笔记本共用）',
      '记忆': '记忆 · 全局（所有笔记本共用）',
      '写入': '写入 · 全局（所有笔记本共用）',
      '工具': '工具 · 全局（所有笔记本共用）',
      'zk': 'zk · 全局（整台机器共用）',
    }

    function Section() {
      const [cfg, setCfg] = useState<ZkConfig | null>(null)
      const [tagsText, setTagsText] = useState('')
      const [saved, setSaved] = useState('')
      const [snap, setSnap] = useState<Snapshot | null>(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [okMsg, setOkMsg] = useState('')
      const [out, setOut] = useState('')
      const [nbName, setNbName] = useState('')
      const [nbPath, setNbPath] = useState('')
      const [stamp, setStamp] = useState('')

      const applySnap = useCallback((d: Snapshot) => {
        setSnap(d)
        if (typeof d.stamp === 'string' && d.stamp) setStamp(d.stamp)
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
        // flat → layered 是单向的结构变化：明确说「只建目录不搬文件」，别让人以为笔记会被整理。
        // 结构是每个笔记本自己的，逐条对比基线；新加的笔记本没有旧笔记可搬，不打扰。
        let switching = false
        try {
          const prev = JSON.parse(saved) as ZkConfig
          switching = Object.keys(cfg.notebooks || {}).some((n) =>
            prev.notebooks?.[n]?.structure === 'flat' && cfg.notebooks?.[n]?.structure === 'layered')
        } catch { /* 基线坏了就当没切 */ }
        if (switching && !window.confirm(
          '切到 layered 只会新建目录与模板：\n' +
          '  raw/ · notes/{sources,concepts,entities,patterns}/ · archive/\n' +
          '  daily.md / source.md / entry.md 三套模板 · 根目录 AGENTS.md / WORKFLOW.md\n\n' +
          '**不会**移动、改写或删除任何已有笔记。\n\n' +
          '保存后点底部的「补建 … 的目录」才会真正建出来。继续？',
        )) return
        setBusy('save'); setErr(''); setOkMsg('')
        try {
          const body = {
            config: {
              ...cfg,
              defaultTags: tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            },
            stamp,
          }
          const r = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const d = await r.json() as Snapshot
          // 409：别的会话 / CLI 在页面打开期间改过配置。别拿旧表单覆盖（那会把 active 改回去）：
          // 直接把最新配置铺回来，让人确认后再保存一次。
          if (r.status === 409) {
            applySnap(d)
            setErr(d.error || '配置已被其他会话修改，已刷新为最新值 —— 请确认后重新保存')
            return
          }
          if (!d.ok) throw new Error(d.error || '保存失败')
          applySnap(d)
          setOkMsg('✓ 已保存' + (d.warn ? '\n⚠️ ' + d.warn : ''))
        } catch (e) { setErr(String((e as Error).message || e)) }
        finally { setBusy('') }
      }, [cfg, tagsText, saved, stamp, applySnap])

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
              workflowWritten?: boolean
            } | undefined
            const r = res || {}
            const parts = [r.initialized ? '已初始化' : '笔记本已存在']
            if (r.dirsCreated && r.dirsCreated.length) parts.push(`新建目录 ${r.dirsCreated.length} 个`)
            if (r.templatesWritten && r.templatesWritten.length) parts.push('写入模板 ' + r.templatesWritten.join(' / '))
            if (r.agentsWritten) parts.push('写入 AGENTS.md')
            if (r.workflowWritten) parts.push('写入 WORKFLOW.md')
            if (r.configPatched && !(r.templatesWritten && r.templatesWritten.length) && !(r.dirsCreated && r.dirsCreated.length)) parts.push('补齐 group')
            setOkMsg('✓ ' + parts.join(' · ') + (d.warn ? '\n⚠️ ' + d.warn : ''))
          }
          if (name === 'index') setOkMsg('✓ 索引已重建')
          if (name === 'agents') setOkMsg(d.result?.written === true ? '✓ 已写入 AGENTS.md 模板' : '✓ AGENTS.md 已存在，没有覆盖')
          if (name === 'persona') {
            const res = d.result as { personaWritten?: boolean } | undefined
            const r = res || {}
            setOkMsg('✓ ' + (r.personaWritten ? '写入 PERSONA.md' : 'PERSONA.md 已存在，没有覆盖') + (d.warn ? '\n⚠️ ' + d.warn : ''))
          }
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

      const nbMap = (cfg && cfg.notebooks) || {}
      const nbNames = Object.keys(nbMap)
      const entryOf = (name: string): NotebookEntry => nbMap[name] || { path: '', structure: 'flat' }
      const patchEntry = (name: string, patch: Partial<NotebookEntry>) =>
        setCfg((s) => (s ? { ...s, notebooks: { ...(s.notebooks || {}), [name]: { ...entryOf(name), ...patch } } } : s))
      const setNotebookPath = (name: string, value: string) => patchEntry(name, { path: value })
      const setNotebookStructure = (name: string, value: string) => patchEntry(name, { structure: value })
      // 删掉的是当前那个就把 active 挪到剩下的第一个 —— 否则归一化会自己挑，界面和落盘就不一致了
      const removeNotebook = (name: string) => {
        if (!window.confirm(
          `从配置里移除笔记本「${name}」？\n\n` +
          '只删这条配置：磁盘上的目录和笔记一个字都不会动，之后还能用「新增」加回来。\n' +
          '要点「保存」才会真正落盘；不保存就刷新会原样恢复。继续？',
        )) return
        const rest = { ...nbMap }
        delete rest[name]
        const first = Object.keys(rest)[0] || 'default'
        setCfg((s) => (s ? { ...s, notebooks: rest, active: s.active === name ? first : s.active } : s))
      }
      const addNotebook = () => {
        const name = String(nbName || '').trim()
        if (!name) return
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { setErr('笔记本名字只接受字母、数字、_ 与 -（1-32 字符）'); return }
        if (nbMap[name] !== undefined) { setErr('已经有同名笔记本：' + name); return }
        setErr('')
        // 新笔记本结构跟当前那个一致（以前结构是全局的，这就是它的迁移语义）
        setCfg((s) => (s ? {
          ...s,
          notebooks: {
            ...(s.notebooks || {}),
            [name]: { path: String(nbPath || '').trim(), structure: s.notebooks?.[s.active]?.structure || 'flat' },
          },
        } : s))
        setNbName('')
        setNbPath('')
      }

      if (!cfg) {
        // 读取失败也要有出路：以前这里只有一行红字，整个 section 没有一个可点项
        const failure = err
          ? h('div', null,
            h('div', { className: 'zdk-err' }, err),
            h('div', { className: 'zdk-actions' },
              h('button', { className: 'zdk-btn zdk-btn2', onClick: load, disabled: !!busy }, '重试')))
          : null
        return h('div', { className: 'zdk' },
          h('h3', { className: 'zdk-title' }, '知识库（zk）'),
          busy ? h('div', { className: 'zdk-hint' }, '读取中…') : failure)
      }

      const dirty = saved !== JSON.stringify({ ...cfg, defaultTags: tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })
      const input = { className: 'zdk-input', autoComplete: 'off', spellCheck: false }
      const up = (key: string, value: unknown) => setCfg((s) => (s ? { ...s, [key]: value } as ZkConfig : s))
      const groups = [...new Set(FIELDS.map((f) => f.group))]

      /** 一个字段 → 控件（枚举值在笔记本行的结构下拉里，不走字段清单） */
      const control = (f: Field) => {
        // 布尔字段保持真正的 true / false 进状态：拼成 "false" 字符串会被归一化当成没启用，
        // 界面上勾了却存不进（值和显示对不上）
        if (f.type === 'bool') {
          const on = (cfg as unknown as Record<string, unknown>)[f.key] === true
          return h('label', { className: 'zdk-check' },
            h('input', {
              type: 'checkbox',
              checked: on,
              onChange: (e: { target: { checked: boolean } }) => up(f.key, e.target.checked === true),
            }),
            h('span', null, on ? '已开启' : '已关闭'))
        }
        const value = f.key === 'defaultTagsText'
          ? tagsText
          : String((cfg as unknown as Record<string, unknown>)[f.key] ?? '')
        const onChange = (e: { target: { value: string } }) =>
          f.key === 'defaultTagsText' ? setTagsText(e.target.value) : up(f.key, e.target.value)
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
          (memory.truncatedWords > 0 ? ` · 已截断 ${memory.truncatedWords} 词` : '') +
          (structure && !structure.agents.present ? ' · ⚠️ 缺 AGENTS.md：约定与周提醒未启用' : '')
      // 结构以配置为准：磁盘不一致只告警，不自动建、不自动删
      const structureWarn = !structure || !snap?.notebook.exists ? '' : !structure.ready
        ? `结构是 ${structure.mode}，但缺目录：${structure.missing.join('、')}`
        : structure.agents.required && !structure.agents.present
          ? '结构是 layered，但根目录缺 AGENTS.md（agent 的工作约定与注入内容）'
          : structure.mode === 'flat' && structure.extra.length
            ? `盘上有分层目录（${structure.extra.join('、')}），但配置是 flat —— 新建笔记会落在 notes/ 根，不套模板`
            : ''
      // group 与配置不一致不会自己好：改目录 / 改 dailyGroup 后要显式跑 groups --fix
      const groupBroken = (structure?.groups || []).filter((g) => !g.present || !g.pathsOk)
      // 多行数组 / 重复组等解析失败不是 --fix 能修的；缺 group（present=false）仍可补建
      const groupNeedsManual = groupBroken.some((g) => g.present && g.actualPaths === null)
      // 也可能只是路径互相重叠（配置本身冲突）：那时没有「坏掉的组」，只有一条说明
      const groupWarnText = snap?.notebook.exists && structure?.groupsOk === false
        ? groupBroken.length
          ? `配置与 .zk/config.toml 的 group 不一致（${groupBroken.map((g) => g.name).join('、')}）`
          : (structure.groupWarnings?.[0] ?? 'group 路径互相重叠')
        : ''
      const configWarn = [structureWarn, groupWarnText].filter(Boolean).join('；')
      // 底部只留一个按钮：没建过就叫「初始化」，缺东西就叫「补建」，都带上当前笔记本名。
      // 用已保存的 active 而不是 cfg.active —— 按钮执行的是服务端已落盘的那份配置。
      const savedActive = snap?.config?.active || cfg.active
      const needsBuild = !!snap?.notebook.exists && !!structure &&
        (!structure.ready || (structure.agents.required && !structure.agents.present))
      const initLabel = !snap?.notebook.exists
        ? `初始化笔记本 ${savedActive}`
        : needsBuild
          ? `补建 ${savedActive} 的目录`
          : `初始化 / 补建 ${savedActive}`
      // 人格按钮不按 notebook.exists 隐藏：人格文件不依赖 .zk，
      // 这样自检里的「点「写入人格模板」」任何状态下都有对应的可点项。
      return h('div', { className: 'zdk' },
        h('h3', { className: 'zdk-title' }, '知识库（zk）'),
        h('p', { className: 'zdk-intro' },
          '把你的 zk 笔记本接进 DSH：agent 用 zk_* 工具搜索、读写笔记与日记，双链交给 zk 索引。' +
          '没装 zk 就让插件装一个 —— 第一次调用工具时会自动建好笔记本，不需要先来这里点任何按钮。'),
        statusLine ? h('div', { className: 'zdk-hint' }, '📚 ' + statusLine) : null,
        memoryLine ? h('div', { className: 'zdk-hint' }, '🧠 ' + memoryLine) : null,
        configWarn
          ? h('div', { className: 'zdk-err' },
            '⚠️ ' + configWarn +
            (groupBroken.length
              ? groupNeedsManual
                ? ' —— 有 paths 解析不了，请手动编辑 .zk/config.toml'
                : ' —— 跑 zk-kit groups --fix'
              : groupWarnText ? '' : ' —— 点底部「' + initLabel + '」'))
          : null,

        h('div', null,
          h('div', { className: 'zdk-group' }, '笔记本 · 每个笔记本自己的路径与结构'),
          h('div', { className: 'zdk-row' },
            h('div', null,
              h('div', { className: 'zdk-label' }, '当前笔记本'),
              h('div', { className: 'zdk-hint' },
                '这里是**新会话的默认值**：每个会话第一次用 zk_* 时会把当时的值固定下来，之后各走各的。' +
                '改这里不会带着已经跑着的会话走 —— 要让某个会话跟过去，在那个会话里说「切到 X 库」（zk_use）。\n' +
                '路径与结构是每个笔记本自己的；笔记/日记子目录、归档目录、注入预算是全局的。\n' +
                '切换保存后会自动建好目标笔记本（幂等，不动已有笔记）。\n' +
                '空 / 相对路径按「会话工作区」解析：agent 在哪个会话调用，就落在那个工作区。' +
                (snap?.workspace ? '\n本页工作区（插件进程）：' + snap.workspace : '') +
                (snap?.notebook?.path ? '\n解析后：' + snap.notebook.path : ''))),
            h('select', {
              ...input,
              value: cfg.active || 'default',
              onChange: (e: { target: { value: string } }) => setCfg((s) => (s ? { ...s, active: e.target.value } : s)),
            },
              ...nbNames.map((name) => h('option', { key: name, value: name }, name)))),
          ...nbNames.map((name, i) =>
            h('div', { className: 'zdk-row', key: 'nb-' + name },
              h('div', null,
                h('div', { className: 'zdk-label' }, name === cfg.active ? name + '（当前）' : name),
                h('div', { className: 'zdk-hint' },
                  (i === 0 ? 'zk 笔记本的根目录（含 .zk/）。空 = <工作区>/zdiary；相对路径按工作区解析；也可以指向任何已有 zk 笔记本。\n' : '') +
                  '结构跟着这个笔记本走：flat = notes/ + 日记；layered = 分层目录 + 三套模板。切到 layered 只建目录，不搬笔记')),
              h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                h('input', {
                  ...input,
                  value: entryOf(name).path || '',
                  placeholder: '空 = <工作区>/zdiary',
                  onChange: (e: { target: { value: string } }) => setNotebookPath(name, e.target.value),
                }),
                h('select', {
                  ...input,
                  style: { minWidth: '0', width: '110px' },
                  value: entryOf(name).structure || 'flat',
                  onChange: (e: { target: { value: string } }) => setNotebookStructure(name, e.target.value),
                },
                  h('option', { value: 'flat' }, 'flat'),
                  h('option', { value: 'layered' }, 'layered')),
                h('button', { className: 'zdk-btn zdk-btn2', onClick: () => removeNotebook(name), disabled: nbNames.length <= 1 || !!busy }, '删除')))),
          h('div', { className: 'zdk-row' },
            h('div', null,
              h('div', { className: 'zdk-label' }, '新增笔记本'),
              h('div', { className: 'zdk-hint' }, '名字只接受字母、数字、_ 与 -（1-32 字符）；路径空着就是 <工作区>/zdiary，结构跟当前笔记本一致。改完点「保存」')),
            h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              h('input', { ...input, style: { minWidth: '0', width: '110px' }, placeholder: '名字', value: nbName, onChange: (e: { target: { value: string } }) => setNbName(e.target.value) }),
              h('input', { ...input, style: { minWidth: '0', width: '190px' }, placeholder: '路径', value: nbPath, onChange: (e: { target: { value: string } }) => setNbPath(e.target.value) }),
              h('button', { className: 'zdk-btn zdk-btn2', onClick: addNotebook, disabled: !nbName.trim() || !!busy }, '新增')))),

        ...groups.map((g) => h('div', { key: g },
          h('div', { className: 'zdk-group' }, GROUP_LABELS[g] || g),
          h('div', null, FIELDS.filter((f) => f.group === g).map((f) =>
            h('div', { className: 'zdk-row', key: f.key },
              h('div', null,
                h('div', { className: 'zdk-label' }, f.label),
                h('div', { className: 'zdk-hint' }, f.hint)),
              control(f)))))),

        h('div', { className: 'zdk-actions' },
          h('button', { className: 'zdk-btn', onClick: save, disabled: !!busy }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('init', 'init'), disabled: !!busy }, busy === 'init' ? '处理中…' : initLabel),
          structure && snap?.notebook.exists && !structure.agents.present
            ? h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('agents', 'agents'), disabled: !!busy }, busy === 'agents' ? '写入中…' : '写入 AGENTS.md 模板')
            : null,
          h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('persona', 'persona'), disabled: !!busy }, busy === 'persona' ? '写入中…' : '写入人格模板'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('index', 'index'), disabled: !!busy }, busy === 'index' ? '索引进…' : '重建索引'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: () => action('install', 'install'), disabled: !!busy }, busy === 'install' ? '下载中…' : '安装内置 zk'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: selftest, disabled: !!busy }, busy === 'selftest' ? '自检中…' : '自检'),
          h('a', { className: 'zdk-btn zdk-btn2', href: '/dsh-zdiary-kit/view', target: '_blank', rel: 'noopener noreferrer', style: { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' } }, '只读视图'),
          h('button', { className: 'zdk-btn zdk-btn2', onClick: load, disabled: !!busy }, '刷新'),
          dirty ? h('span', { style: { marginLeft: '10px', color: '#ffb020', fontSize: '13px', alignSelf: 'center' } }, '● 有改动还没保存') : null),

        okMsg ? h('div', { className: 'zdk-ok' }, okMsg) : null,
        err ? h('div', { className: 'zdk-err' }, err) : null,
        out ? h('div', { className: 'zdk-out' }, out) : null,
        snap?.countsError ? h('div', { className: 'zdk-err' }, '计数失败：' + snap.countsError) : null,
        h('div', { className: 'zdk-hint' },
          `配置：${snap?.configPath || '~/.dsh/zdiary/zdiary.config.json'}\n` +
          '工具的用法：zk_search 查 → 原生 read 读 → zk_new 新建 → zk_daily 写日记 → zk_link 连双链；zk_stats 看规模。'))
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
