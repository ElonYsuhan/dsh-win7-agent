import type { AgentView, ChatMessage, RuntimeSettings, ToolDefinition } from '../core/contracts'
import type { UiCapabilities } from '../browser/bridge'
export interface AgentRunInput {
  readonly text: string
  readonly history?: readonly ChatMessage[]
  readonly images?: readonly unknown[]
  readonly memory?: unknown
  readonly uiActionId?: string
  readonly signal?: AbortSignal
  readonly uiCapabilities?: UiCapabilities | null
}
export interface AgentWorkerView extends AgentView {
  readonly messages: readonly ChatMessage[]
  readonly memory: unknown
  readonly running: boolean
  readonly unattended?: boolean
  abort(): void
  clear(): void
  dispose(): Promise<void>
}
export interface AgentPoolView {
  run(sessionId: string, text: string, history?: readonly ChatMessage[], images?: readonly unknown[], memory?: unknown, unattended?: unknown, uiActionId?: string, signal?: AbortSignal, uiCapabilities?: UiCapabilities | null): Promise<void>
  runUnattended(sessionId: string, prompt: string, configuration?: Readonly<Record<string, unknown>>): Promise<unknown>
  abort(sessionId?: string): void
  acquire(sessionId: string): AgentWorkerView
  isRunning(sessionId: string): boolean
  isFull(): boolean
  runningSessions(): readonly string[]
  dispose(): Promise<void>
}
export interface PluginHostView {
  ready(signal?: AbortSignal): Promise<unknown>
  get(name: string): unknown
  requireService(name: string): unknown
  getTool(name: string): ToolDefinition | undefined
  getToolDefinitions(agent?: AgentView): readonly unknown[]
  dispose(): Promise<void>
}
export interface LlmRequest {
  readonly settings: RuntimeSettings
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
  readonly signal?: AbortSignal
  readonly onDelta?: (delta: Readonly<Record<string, unknown>>) => void
}
export interface LlmServiceView { request(input: LlmRequest): Promise<unknown> }
export interface BrowserLaunchOptions {
  readonly electronPath?: string
  readonly width?: number
  readonly height?: number
  readonly noSandbox?: boolean
  readonly disableGpu?: boolean
  readonly hidden?: boolean
  readonly userDataDir?: string
}
