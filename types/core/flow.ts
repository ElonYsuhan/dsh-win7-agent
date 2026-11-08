import type { RuntimeSettings, ToolCall, ToolOutcome } from './contracts'
export interface FlowLimits {
  readonly maxSteps: number
  readonly maxAttempts: number
  readonly reconnectDelaysMs: readonly number[]
  readonly maxDenied: number
  readonly turnTimeoutMs: number
}
export type RetryDecision = 'stop' | 'without-tools' | 'compact' | 'reconnect'
export type NextDecision = 'cancel' | 'blocked' | 'complete' | 'tools'
export interface RetryInput {
  readonly aborted: boolean
  readonly toolsEnabled: boolean
  readonly error?: unknown
  readonly contextLengthError?: boolean
  readonly attempt: number
  readonly code?: string
}
export interface NextInput {
  readonly aborted: boolean
  readonly deniedCount: number
  readonly maxDenied: number
  readonly calls: readonly unknown[]
}
export interface FlowService {
  limits(settings: RuntimeSettings): FlowLimits
  retry(input: RetryInput): RetryDecision
  next(input: NextInput): NextDecision
  normalizeCalls(raw: readonly Partial<ToolCall>[] | undefined, prefix: string): readonly ToolCall[]
  outcome(result: unknown, aborted: boolean): ToolOutcome
  systemPrompt(settings: RuntimeSettings, workspaceRoot?: string): string
}
