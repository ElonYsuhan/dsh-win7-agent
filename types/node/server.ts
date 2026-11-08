import type { ChatMessage, EventEnvelope, RuntimeSettings } from '../core/contracts'
import type { UiActionRequest, UiCapabilities, UiChangeRequest, UiReadRequest } from '../browser/bridge'
export interface HealthResponse {
  readonly ok: boolean
  readonly version: string
  readonly uiBuild: string
  readonly agentHome?: string
  readonly pid?: number
  readonly port?: number
}
export interface ChatRequest {
  readonly text: string
  readonly history?: readonly ChatMessage[]
  readonly images?: readonly unknown[]
  readonly memory?: unknown
  readonly sessionId?: string
  readonly uiCapabilities?: UiCapabilities | null
}
export interface ActionResult<T = unknown> {
  readonly ok?: boolean
  readonly error?: string
  readonly value?: T
}
export interface GenerativeUiRoute {
  readonly read: (request: UiReadRequest) => Promise<ActionResult>
  readonly change: (request: UiChangeRequest) => Promise<ActionResult>
  readonly action: (request: UiActionRequest, capabilities?: UiCapabilities | null) => Promise<ActionResult>
}
export interface EventSink {
  write(event: EventEnvelope | Readonly<Record<string, unknown>>): void
  close(): void
}
export interface ServerRuntime {
  readonly settings: RuntimeSettings
  readonly version: string
  readonly agentHome: string
  readonly emit: (sessionId: string, event: Readonly<Record<string, unknown>>) => void
}
