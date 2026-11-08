import type { ChatMessage, EventEnvelope, ModelResult, ToolCall, ToolDefinition } from '../core/contracts'
import type { FlowService } from '../core/flow'
import type { SessionState, StateReducerService } from '../core/state'
import type { CordisContext, RuntimePlugin, RuntimeServices, ToolRegistryService } from '../core/runtime'

const call: ToolCall = { id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }
const message: ChatMessage = { role: 'assistant', content: 'ok', tool_calls: [call] }
const event: EventEnvelope<{ message: ChatMessage }> = {
  version: 1, sequence: 1, at: '2026-11-08T00:00:00.000Z', type: 'message.appended', data: { message }
}
const result: ModelResult = { content: 'ok', toolCalls: [call] }
const tool: ToolDefinition = {
  name: 'demo', permission: 'read', parameters: { type: 'object' },
  execute: async (_args, context) => context.signal?.aborted ? 'ABORTED' : 'ok'
}
const state: SessionState = {
  stateVersion: 1, sequence: 1, messages: [message], memory: null,
  ui: { version: 1, sessionId: '', surfaces: {}, receipts: {} },
  execution: { status: 'running', phase: 'model', id: 'turn', step: 1, attempt: 1, activeTool: null, reason: '', maxSteps: 3, deniedCount: 0, toolsEnabled: true, lastError: '' }
}
const reducer: StateReducerService = {
  initial: () => state,
  reduce: value => value,
  restore: () => state,
  release: value => value,
  STATUS: { 'turn.completed': 'completed', 'turn.cancelled': 'cancelled', 'turn.failed': 'failed', 'turn.exhausted': 'exhausted', 'turn.blocked': 'blocked', 'turn.interrupted': 'interrupted', 'turn.timed_out': 'timed_out' }
}
const flow = {} as FlowService
const tools = {} as ToolRegistryService
const services = { flow, state: reducer, tools } as unknown as RuntimeServices
const context = {} as CordisContext
const plugin: RuntimePlugin = { name: 'demo', inject: ['tools'], apply: ctx => { ctx.provide('demo', {}) } }
void event; void result; void state; void services; void context; void plugin; void message; void tool

// @ts-expect-error message roles are a closed union
const badRole: ChatMessage = { role: 'developer', content: 'x' }
// @ts-expect-error tool permission is bounded
const badPermission: ToolDefinition = { name: 'x', permission: 'root', execute: () => 'x' }
// @ts-expect-error event type must be a known contract event
const badEvent: EventEnvelope = { version: 1, sequence: 1, at: 'now', type: 'turn.unknown', data: {} }
// @ts-expect-error execution status is bounded
const badStatus: SessionState = { ...state, execution: { ...state.execution, status: 'thinking' } }
void badRole; void badPermission; void badEvent; void badStatus
