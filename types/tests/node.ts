import type { ChatRequest, GenerativeUiRoute, HealthResponse, ServerRuntime } from '../node/server'
import type { ServiceHealth, ShellConfig, ShellBridge, WindowState } from '../node/shell'
const health: HealthResponse = { ok: true, version: '0.4.4', uiBuild: 'abc' }
const chat: ChatRequest = { text: 'hello', sessionId: 'session_a', uiCapabilities: { versions: [1, 2], components: ['chart'] } }
const route = {} as GenerativeUiRoute
const runtime = {} as ServerRuntime
const service: ServiceHealth = { ok: true, port: 8080 }
const config: ShellConfig = { mode: 'local', theme: 'dark' }
const bridge = {} as ShellBridge
const state: WindowState = { maximized: false, fullScreen: false, focused: true }
void health; void chat; void route; void runtime; void service; void config; void bridge; void state
// @ts-expect-error theme is a closed union
const badTheme: ShellConfig = { mode: 'local', theme: 'system' }
// @ts-expect-error chat text is required
const badChat: ChatRequest = { sessionId: 'a' }
void badTheme; void badChat
