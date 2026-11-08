import type { ChatMessage, EventEnvelope, TerminalEventType } from './contracts'
export type ExecutionStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'exhausted' | 'blocked' | 'interrupted' | 'timed_out'
export type ExecutionPhase = 'idle' | 'preparing' | 'model' | 'tool' | 'continuing' | 'settled'
export interface ActiveTool { readonly id: string; readonly name: string }
export interface ExecutionState {
  readonly status: ExecutionStatus
  readonly phase: ExecutionPhase
  readonly id: string
  readonly step: number
  readonly attempt: number
  readonly activeTool: ActiveTool | null
  readonly reason: string
  readonly maxSteps: number
  readonly deniedCount: number
  readonly toolsEnabled: boolean
  readonly lastError: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly uiActionId?: string
}
export interface MemoryState { readonly text: string; readonly through: number }
export interface UiSurfaceEntry {
  readonly surface: unknown
  readonly stateVersion: number
  readonly state: Readonly<Record<string, string | number | boolean | null>>
  readonly lastChange: unknown
}
export interface UiReceipt {
  readonly request: unknown
  readonly message: string
  readonly values: Readonly<Record<string, string | number | boolean | null>>
  readonly status: 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'blocked' | 'exhausted' | 'timed_out'
  readonly turnId: string
  readonly reason: string
  readonly sequence: number
}
export interface UiAggregate {
  readonly version: 1
  readonly sessionId: string
  readonly surfaces: Readonly<Record<string, UiSurfaceEntry>>
  readonly receipts: Readonly<Record<string, UiReceipt>>
}
export interface SessionState {
  readonly stateVersion: 1
  readonly sequence: number
  readonly messages: readonly ChatMessage[]
  readonly memory: MemoryState | null
  readonly ui: UiAggregate
  readonly execution: ExecutionState
}
export interface SessionSnapshot extends Omit<Partial<SessionState>, 'execution'> {
  readonly version?: 1 | 2
  readonly messages?: readonly ChatMessage[]
  readonly execution?: Partial<ExecutionState>
  readonly ui?: UiAggregate
}
export interface StateReducerService {
  initial(): SessionState
  reduce(state: SessionState, event: EventEnvelope): SessionState
  restore(snapshot: SessionSnapshot | null | undefined): SessionState
  release(state: SessionState): SessionState
  readonly STATUS: Readonly<Record<TerminalEventType, ExecutionStatus>>
}
