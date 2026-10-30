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
  /** 发起这次调用的 Agent（宿主只保证 id = 会话 id；用它反查会话工作区） */
  agent?: { id?: string }
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

/**
 * system-prompt 的装配上下文（AssembleContext 的最小可用子集）。
 * 真身还有 scope / signal；dsh-agent 用声明合并追加了 agent ——
 * 裸装配（预览之类）不带这些字段，提供方必须容忍缺席。
 */
export interface AssemblyContextLike {
  agent?: { id?: string }
}

export interface SystemPromptSectionLike {
  name: string
  order: number
  /** 静态文本，或每步装配时用当时的上下文求值的函数（ctx 可能整个缺席） */
  text: string | ((ctx?: AssemblyContextLike) => string)
  /** 是否把 `{{name}}` 当提示变量插值（默认 true）。记忆是文件原文，必须关掉 */
  interpolate?: boolean
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
