import type { AgentPoolView, AgentRunInput, AgentWorkerView, BrowserLaunchOptions, LlmServiceView, PluginHostView } from '../node/agent'
const input: AgentRunInput = { text: 'hello', sessionId: 'session_a' } as AgentRunInput & { sessionId: string }
const pool = {} as AgentPoolView
const worker = {} as AgentWorkerView
const host = {} as PluginHostView
const llm = {} as LlmServiceView
const launch: BrowserLaunchOptions = { width: 320, height: 200, hidden: true }
void input; void pool; void worker; void host; void llm; void launch
// @ts-expect-error run text is required
void pool.run('session_a')
// @ts-expect-error hidden is boolean
const badLaunch: BrowserLaunchOptions = { hidden: 'yes' }
void badLaunch
