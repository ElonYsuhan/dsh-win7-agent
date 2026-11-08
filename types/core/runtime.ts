import type { AgentView, RuntimeSettings, ToolDefinition, ToolEntry, ToolOutcome } from './contracts'
import type { FlowService } from './flow'
import type { SessionState, StateReducerService } from './state'
import type { MemoryServiceView } from './memory'
import type { CapabilityServiceView } from './capability'
import type { AdaptiveServiceView } from './adaptive'
export interface CordisDisposable { (): void | Promise<void> }
export interface CordisContext {
  provide(name: string, service: unknown): CordisDisposable
  effect(callback: () => void | (() => void | Promise<void>)): CordisDisposable
  get(name: string): unknown
  plugin(plugin: RuntimePlugin, config?: unknown): unknown
  on(event: string, listener: (...args: readonly unknown[]) => void): CordisDisposable
  emit(event: string, payload: unknown): void
  logger: { warn(error: unknown): void; info(message: string): void; error(error: unknown): void }
}
export interface RuntimePlugin {
  readonly name: string
  readonly inject?: readonly string[]
  readonly apply: (context: CordisContext) => void | Promise<void>
}
export interface ToolRegistryService {
  register(tool: ToolDefinition): CordisDisposable
  execute(name: string, args: Readonly<Record<string, unknown>>, context: unknown): Promise<string>
  definitions(context?: unknown): readonly { readonly type: 'function'; readonly function: Readonly<Record<string, unknown>> }[]
  get(name: string): ToolEntry | undefined
  list(): readonly ToolEntry[]
}
export interface PromptService {
  add(factory: (context: Readonly<Record<string, unknown>>) => string): CordisDisposable
  build(base: string, context: Readonly<Record<string, unknown>>): Promise<string>
}
export interface SessionService {
  save(agent: AgentView): unknown
  load(agent: AgentView): SessionState
  append?(agent: AgentView, event: unknown): unknown
}
export interface GenerativeUiService {
  read(pool: unknown, request: unknown): unknown
  change(pool: unknown, request: unknown): unknown
  dispatch(pool: unknown, request: unknown, capabilities?: unknown): unknown
}
export interface ModelService {
  request(input: Readonly<Record<string, unknown>>): Promise<unknown>
}
export interface RuntimeServices {
  readonly contracts: Readonly<Record<string, (...args: readonly unknown[]) => unknown>>
  readonly flow: FlowService
  readonly state: StateReducerService
  readonly tools: ToolRegistryService
  readonly prompts: PromptService
  readonly sessions: SessionService
  readonly generativeUi: GenerativeUiService
  readonly memoryStore: MemoryServiceView
  readonly capabilities: CapabilityServiceView
  readonly adaptive: AdaptiveServiceView
  readonly llm: ModelService
  readonly agentLoop: { run(agent: AgentView, ...args: readonly unknown[]): Promise<unknown> }
  readonly settings: RuntimeSettings
  readonly [name: string]: unknown
}
export interface PluginHostView {
  ready(signal?: AbortSignal): Promise<unknown>
  get(name: string): unknown
  requireService(name: string): unknown
  getTool(name: string): ToolEntry | undefined
  getToolDefinitions(agent?: AgentView): readonly unknown[]
}
export type ToolExecutionResult = ToolOutcome | string
