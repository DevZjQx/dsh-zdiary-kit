/**
 * DSH 宿主契约（纯类型，编译后被完全擦除）—— 插件只知道这么多。
 *
 * 自己写一份的理由和 dsh-bili-lite 一样：DSH 的类型包不随插件分发。
 * 工具走「裸 JSON Schema 注册」（ctx.tools.register），所以运行时零依赖。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface WebServerLike {
  register(spec: { kind: 'exact'; path: string; handler: RouteHandler }): () => void
}

export interface ContentBlockLike {
  type: 'text'
  text: string
}

export interface ToolRunContextLike {
  /** 调用方取消信号：长任务必须转发 */
  signal?: AbortSignal
}

/** 裸工具定义（ToolDefinition 的最小可用子集；output 是必填） */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => ContentBlockLike[]
  }
  execute: (args: unknown, exec: ToolRunContextLike) => Promise<unknown>
}

export interface ToolsLike {
  register(definition: ToolDefinitionLike): () => void
}

export interface ConnectionLike {
  isTrusted?(req: IncomingMessage): boolean
  /** undefined / null / false = 放行；否则是拒绝码 */
  requestRejection?(req: IncomingMessage): unknown
}

export interface SystemPromptSectionLike {
  name: string
  order: number
  /** 函数形式每个 step 重新求值（宿主在每次 assemble 时调用） */
  text: string | (() => string)
}

/** 系统提示注册表（dsh-system-prompt 提供；headless 宿主可能没有） */
export interface SystemPromptLike {
  section(spec: SystemPromptSectionLike): () => void
}

export interface PluginContext {
  get<T = unknown>(name: string): T | undefined
  /** cordis 延迟注入：service 就绪后回调；宿主没有该 service 时永不回调 */
  inject?(deps: string[], callback: (ctx: PluginContext) => void): unknown
  tools?: ToolsLike
  webServer?: WebServerLike
  connection?: ConnectionLike
  systemPrompt?: SystemPromptLike
  effect(fn: () => undefined | (() => void)): void
}
