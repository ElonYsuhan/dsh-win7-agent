// Hand-maintained compile-time mirror of the public contract vocabulary.
// Runtime validators remain authoritative for untrusted/external input.
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type EventType =
  | 'history.replaced' | 'message.appended' | 'memory.updated'
  | 'turn.started' | 'step.started' | 'request.started' | 'request.failed'
  | 'model.tools_disabled' | 'tool.started' | 'tool.settled'
  | 'ui.surface.published' | 'ui.state.changed' | 'ui.action.accepted' | 'ui.action.interrupted'
  | 'turn.completed' | 'turn.cancelled' | 'turn.failed' | 'turn.exhausted'
  | 'turn.blocked' | 'turn.interrupted' | 'turn.timed_out'

export type TerminalEventType =
  | 'turn.completed' | 'turn.cancelled' | 'turn.failed' | 'turn.exhausted'
  | 'turn.blocked' | 'turn.interrupted' | 'turn.timed_out'

export interface EventEnvelope<T = unknown> {
  readonly version: 1
  readonly sequence: number
  readonly at: string
  readonly type: EventType
  readonly data: T
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'
export interface TextContentPart { readonly type: 'text'; readonly text: string }
export interface ImageContentPart { readonly type: 'image'; readonly assetId: string; readonly mime?: string; readonly name?: string }
export interface UiContentPart { readonly type: 'ui'; readonly toolCallId: string; readonly surface: unknown }
export type MessageContentPart = TextContentPart | ImageContentPart | UiContentPart
export interface ToolCall {
  readonly id: string
  readonly type?: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}
export interface ChatMessage {
  readonly role: MessageRole
  readonly content?: string | readonly MessageContentPart[] | null
  readonly tool_calls?: readonly ToolCall[]
  readonly tool_call_id?: string
}

export type ModelFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | string
export interface ModelUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
}
export interface ModelResult {
  readonly content?: string | null
  readonly reasoning?: string
  readonly toolCalls?: readonly ToolCall[]
  readonly usage?: ModelUsage
  readonly finishReason?: ModelFinishReason
}

export type ToolPermission = 'read' | 'write' | 'edit' | 'command'
export type ToolOutcome = 'success' | 'denied' | 'disabled' | 'error' | 'cancelled'
export interface ApprovalRequest {
  readonly tool: string
  readonly permission: ToolPermission
  readonly description: string
  readonly args?: Readonly<Record<string, unknown>>
}
export interface RuntimeSettings {
  readonly permissionMode?: 'readonly' | 'workspace' | 'full'
  readonly workspacePath?: string
  readonly maxIterations?: number
  readonly turnTimeoutMs?: number
  readonly maxTokens?: number
  readonly contextWindowTokens?: number
  readonly disabledPlugins?: readonly string[]
  readonly unattended?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}
export interface AgentView {
  readonly sessionId?: string
  readonly unattended?: boolean
  readonly rendererCapabilities?: { readonly versions: readonly number[]; readonly components: readonly string[] } | null
  readonly state?: unknown
  record(type: EventType, data: unknown): void
  emit(event: unknown): void
}
export interface ToolContext {
  readonly agent?: AgentView
  readonly settings?: RuntimeSettings
  readonly signal?: AbortSignal
  readonly toolCallId?: string
  readonly approve?: (request: ApprovalRequest) => boolean | Promise<boolean>
  readonly [key: string]: unknown
}
export interface ToolDefinition {
  readonly name: string
  readonly description?: string
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly permission?: ToolPermission
  readonly plugin?: string
  readonly available?: (context: ToolContext) => boolean
  readonly execute: (args: Readonly<Record<string, unknown>>, context: ToolContext) => unknown | Promise<unknown>
}
export interface ToolEntry extends ToolDefinition {
  readonly active: boolean
  readonly pending: ReadonlySet<Promise<unknown>>
  readonly controllers: ReadonlySet<AbortController>
}

export interface ServiceMethods {
  readonly licensing: readonly string[]
  readonly contracts: readonly string[]
  readonly flow: readonly string[]
  readonly state: readonly string[]
  readonly generativeUi: readonly string[]
  readonly sessions: readonly string[]
  readonly llm: readonly string[]
  readonly agentLoop: readonly string[]
  readonly tools: readonly string[]
  readonly prompts: readonly string[]
  readonly skillLibrary: readonly string[]
  readonly tasks: readonly string[]
  readonly mcp: readonly string[]
  readonly skills: readonly string[]
  readonly memory: readonly string[]
  readonly context: readonly string[]
}
export type ServiceName = keyof ServiceMethods
