/**
 * 状态事件词汇表：从当前 `.state/rules` 的 AST 里取事件名 / 参数名，注入系统提示。
 *
 * 为什么要运行时生成，而不是写死在 AGENTS.md：
 *   · 规则是人的工作面，自定义规则可以换事件名（`coffee` / `mood` / …）；
 *   · 写死一份默认词汇，规则一改就漂移，模型会继续 append 已被规则忽略的事件；
 *   · 自动改 AGENTS.md 会覆盖用户内容，也破坏「模板只提示、不覆盖」的约定。
 *
 * 词表口径（与「场景投影读什么」一致）：
 *   · 规则文件能编译 = 只列规则读取的事件：人换了一套词汇，就按那套；
 *   · 默认规则 / 回退默认 = 规则事件 + `slept`（内置词汇里规则不读、但工具说明允许记）；
 *   · 在场事件 `user_left` / `user_returned` 始终补上：投影层直接读，不写在规则里。
 *
 * **日志里的自定义事件故意不进词表**：这一行是系统提示段，append 不该让它每轮变 ——
 * 那会打断宿主的提示前缀缓存（场景走 `systemPrompt.context()` 就是为了避开这点）。
 * agent 自己起的事件名由场景行的「记录」尾巴负责露出（窗口内、最多 3 个，见 `scene.ts`）。
 * 词汇表只回答「哪些事件会参与投影」，不回答「你可能记过什么」。
 *
 * 只暴露**词汇**，不暴露公式：模型要做的仍然是 `zk_state append woke hours=7.5`，
 * 算 energy / mood 的表达式留在规则里，由投影层求值。
 *
 * 参数占位写成 `key=<值>` 而不是 `key=`：后者被模型照抄成空值时，
 * `woke hours=""` 会经 `num("")` 变成 0，energy 静默算错。
 *
 * 整行上限 MAX_CONTRACT_WORDS 词 / MAX_CONTRACT_CHARS 字符：这是唯一不进记忆预算的注入段，
 * 规则再长也不能无界；超了从尾部丢规则事件并注明「另有 N 个未列出」，在场事件永远保留。
 *
 * 没有 `.state/rules` 也没有 `.state/events.log` = 状态层未启用，返回 null（老库不多一个词）。
 * 规则编译失败时 loadRules 已回退默认，这里也跟着默认 —— 与场景投影保持同一份真相。
 */
import fs from 'node:fs'
import type { Config } from '../config/store.ts'
import { fileStamp } from './file-stamp.ts'
import { countWords } from './memory.ts'
import { BUILTIN_ONLY_EVENTS, loadRules, PRESENCE_LEFT_EVENT, PRESENCE_RETURNED_EVENT } from './scene.ts'
import { eventsPathOf, rulesPathOf } from './state-log.ts'
import type { RuleEvent } from './state-rules.ts'

export interface StateContract {
  /** 可直接注入系统提示的一行；超过词数 / 字符上限时尾部事件会被截断并注明 */
  text: string
  /** 完整词汇（text 可能因预算截断尾部）：规则事件 + 在场事件；默认规则还含 slept */
  events: RuleEvent[]
  /** `v3` / `default` / `default(fallback)`，与场景投影同口径 */
  rulesVersion: string
}

/** 在场判定用的事件不写在规则里（`scene.ts` 直接读），但模型同样需要知道 */
const PRESENCE_EVENTS: RuleEvent[] = [
  { name: PRESENCE_LEFT_EVENT, params: [] },
  { name: PRESENCE_RETURNED_EVENT, params: [] },
]

/** 词汇行硬上限：唯一不进记忆预算的注入段，不能跟着规则无界增长。词数会低估长参数名，再加字符上限 */
const MAX_CONTRACT_WORDS = 160
const MAX_CONTRACT_CHARS = 1200

const CONTRACT_CACHE_MAX = 8
const cache = new Map<string, StateContract | null>()

function cacheKey(cfg: Config): string {
  return [
    cfg.notebook,
    fileStamp(rulesPathOf(cfg)),
    // 词汇只看日志在不在，不看内容：append 一条不该触发规则重新编译
    exists(eventsPathOf(cfg)) ? 'state' : 'no-state',
  ].join('|')
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function mergeEvents(ruleEvents: RuleEvent[], extra: RuleEvent[]): RuleEvent[] {
  const out = ruleEvents.map((event) => ({ name: event.name, params: [...event.params] }))
  const seen = new Set(out.map((event) => event.name))
  for (const event of extra) {
    if (seen.has(event.name)) continue
    out.push({ name: event.name, params: [...event.params] })
    seen.add(event.name)
  }
  return out
}

function formatEvents(events: RuleEvent[]): string {
  return events
    .map((event) => {
      if (!event.params.length) return event.name
      return `${event.name} ${event.params.map((param) => `${param}=<值>`).join(' ')}`
    })
    .join(' / ')
}

function contractText(ruleEvents: RuleEvent[], alwaysEvents: RuleEvent[]): string {
  const render = (kept: RuleEvent[], dropped: number): string => {
    const more = dropped > 0 ? `；另有 ${dropped} 个未列出 —— 词表过长，建议精简 .state/rules` : ''
    return `状态事件：${formatEvents([...kept, ...alwaysEvents])}（用 zk_state append 记已发生的事，不写计划；不翻历史${more}）`
  }
  const fits = (kept: RuleEvent[], dropped: number): boolean => {
    const text = render(kept, dropped)
    return countWords(text) <= MAX_CONTRACT_WORDS && text.length <= MAX_CONTRACT_CHARS
  }
  const kept = ruleEvents.slice()
  let dropped = 0
  // 从尾部丢：默认规则里 energy / mood 依赖的 woke 在最前，先保它
  while (kept.length > 0 && !fits(kept, dropped)) {
    kept.pop()
    dropped++
  }
  return render(kept, dropped)
}

/**
 * 读盘 + 生成词汇；没有状态文件返回 null。异常一律按未启用处理：
 * 状态层是可选功能，不能把整个系统提示拖下水。
 */
export function buildStateContract(cfg: Config): StateContract | null {
  const key = cacheKey(cfg)
  if (cache.has(key)) return cache.get(key) as StateContract | null

  let result: StateContract | null = null
  try {
    if (exists(rulesPathOf(cfg)) || exists(eventsPathOf(cfg))) {
      const loaded = loadRules(cfg)
      // 文件规则 = 人换的那套词汇，只列规则读取的事件；默认 / 回退才补内置 slept
      const alwaysEvents = loaded.source === 'file'
        ? PRESENCE_EVENTS
        : [...BUILTIN_ONLY_EVENTS, ...PRESENCE_EVENTS]
      result = {
        text: contractText(loaded.rules.events, alwaysEvents),
        events: mergeEvents(loaded.rules.events, alwaysEvents),
        rulesVersion: loaded.label,
      }
    }
  } catch {
    result = null
  }

  if (cache.size >= CONTRACT_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, result)
  return result
}
