'use strict'

/**
 * Runtime Telemetry —— 统一事件与指标 Schema（第二阶段）
 *
 * 设计原则（对应需求硬约束）：
 *   1. **不虚构事件**：每个 telemetry 事件都锚定一个真实执行位置，
 *      下表 SOURCE 逐条写明来源文件与真实调用点，可核对。
 *   2. **不另建 Agent Loop / 事件总线 / 模型调用入口**：全部复用现有
 *      Cordis `ctx.events`（PluginHost.events 同源）与 `agent.record()`
 *      已有的 `state:committed` 广播。
 *   3. **真实 vs 估算严格分离**：来自供应商 usage 的是 provider；
 *      本地 token 估算一律 method='estimated'，绝不混入真实统计。
 *   4. **隐私红线**：不保存完整 prompt、模型密钥、工具敏感参数、
 *      完整工具返回内容。只保存字节数 / token 数 / 耗时 / 名称 / 结果状态。
 */

/* ── 事件名：与真实来源的对应关系（不虚构） ───────────────────────── */
const TELEMETRY_EVENTS = Object.freeze({
  SESSION_CREATED: 'telemetry.session.created',
  SESSION_ACTIVATED: 'telemetry.session.activated',
  SESSION_RESTORED: 'telemetry.session.restored',
  CONTEXT_ASSEMBLED: 'telemetry.context.assembled',
  MODEL_REQUEST_STARTED: 'telemetry.model.request.started',
  MODEL_FIRST_DELTA: 'telemetry.model.first-delta',
  MODEL_REQUEST_COMPLETED: 'telemetry.model.request.completed',
  MODEL_REQUEST_FAILED: 'telemetry.model.request.failed',
  TOOL_EXECUTION_STARTED: 'telemetry.tool.execution.started',
  TOOL_EXECUTION_COMPLETED: 'telemetry.tool.execution.completed',
  TOOL_EXECUTION_FAILED: 'telemetry.tool.execution.failed',
  TURN_SETTLED: 'telemetry.turn.settled'
})

/**
 * 每个事件的真实锚点。审查时按此核对，任何一条找不到真实位置即为虚构。
 * 说明：
 *   - session.*     : src/main/agent/agent-pool.js acquire()。新建 worker 时
 *                    无历史会话文件 → created；有文件且首次装载 → restored；
 *                    复用已存在 worker → activated。这是唯一需要新增埋点的一层，
 *                    因为池子本身不发事件（需求第 2 条明确点名 AgentPool）。
 *   - context.*     : src/main/runtime/run-turn.js:122 buildRequestMessages()
 *                    的返回值，经 llm:request waterfall payload.messages 观测。
 *                    零侵入：payload 已含完整 messages/tools。
 *   - model.request.*: run-turn.js:130 EVENTS.REQUEST → state:committed；
 *                    真实请求边界由 llm:request waterfall 入口/出口给出。
 *   - model.first-delta: run-turn.js:137 onDelta 回调，由 waterfall listener
 *                    包装 payload.onDelta 观测首个 content/thinking 增量。
 *   - model.request.completed/failed: waterfall `await next()` 的返回/抛出，
 *                    即 model.js:8 requestChat 的真实结果。
 *   - tool.execution.*: run-turn.js:269 plugins.executeTool → plugin-host.js:235
 *                    `tools:execute` waterfall。payload.context.toolCallId 即
 *                    run-turn.js:275 传入的 call.id，真实关联无需改 tool:before。
 *   - turn.settled  : run-turn.js:337 finally 块 + TERMINAL_EVENTS。
 */
const EVENT_SOURCES = Object.freeze({
  [TELEMETRY_EVENTS.SESSION_CREATED]: 'agent-pool.js:acquire(new worker, no persisted session)',
  [TELEMETRY_EVENTS.SESSION_ACTIVATED]: 'agent-pool.js:acquire(reuse existing worker)',
  [TELEMETRY_EVENTS.SESSION_RESTORED]: 'agent-pool.js:acquire(new worker + sessions.load() 有历史',
  [TELEMETRY_EVENTS.CONTEXT_ASSEMBLED]: 'run-turn.js:122 buildRequestMessages() via llm:request payload',
  [TELEMETRY_EVENTS.MODEL_REQUEST_STARTED]: 'run-turn.js:130 EVENTS.REQUEST + llm:request 入口',
  [TELEMETRY_EVENTS.MODEL_FIRST_DELTA]: 'run-turn.js:137 onDelta 首个增量（包装观测）',
  [TELEMETRY_EVENTS.MODEL_REQUEST_COMPLETED]: 'model.js:8 requestChat resolve（waterfall next 返回）',
  [TELEMETRY_EVENTS.MODEL_REQUEST_FAILED]: 'model.js:8 requestChat reject（waterfall next 抛出）',
  [TELEMETRY_EVENTS.TOOL_EXECUTION_STARTED]: 'plugin-host.js:235 tools:execute 入口',
  [TELEMETRY_EVENTS.TOOL_EXECUTION_COMPLETED]: 'plugin-host.js:235 tools:execute 正常返回',
  [TELEMETRY_EVENTS.TOOL_EXECUTION_FAILED]: 'plugin-host.js:235 tools:execute 抛出',
  [TELEMETRY_EVENTS.TURN_SETTLED]: 'run-turn.js:337 finally + TERMINAL_EVENTS'
})

/* ── 数据可信度标记 ─────────────────────────────────────────────── */
/** provider = 供应商 usage 直给；estimated = 本地估算；unknown = 拿不到 */
const DATA_CLASS = Object.freeze({ PROVIDER: 'provider', ESTIMATED: 'estimated', UNKNOWN: 'unknown' })

/** 请求状态机：pending → streaming → completed|failed|cancelled */
const REQUEST_STATUS = Object.freeze({
  PENDING: 'pending', STREAMING: 'streaming',
  COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled'
})

const TOOL_STATUS = Object.freeze({
  RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled'
})

/* ── 上下文占用分布的固定分桶 ───────────────────────────────────── */
/**
 * 上下文分布只能估算（供应商不回各部分占用），因此整体 method='estimated'。
 * 分桶口径：
 *   systemTokens     —— role='system' 的消息（含插件拼接的系统提示）
 *   toolDefinitionTokens —— tools 数组 JSON 序列化后的估算 token
 *   conversationTokens —— user/assistant/tool 消息（不含 system）
 *   memoryTokens     —— 长期记忆注入（若作为独立 system 段则并入 system，
 *                      这里只在能被单独识别时计数，识别不了就 0 并在 notes 说明）
 *   imageTokens      —— 图片段按 base64 长度折算的估算（不保存图片数据）
 */
const CONTEXT_BUCKETS = Object.freeze([
  'systemTokens', 'toolDefinitionTokens', 'conversationTokens', 'memoryTokens', 'imageTokens'
])

/* ── Schema 版本与结构契约 ─────────────────────────────────────── */
const TELEMETRY_SCHEMA_VERSION = 1

/** 空 usage：全 null，供"拿不到就是 unknown"使用 */
function emptyUsage() {
  return {
    source: DATA_CLASS.UNKNOWN,
    promptTokens: null, uncachedPromptTokens: null, completionTokens: null, totalTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, cacheMissTokens: null,
    reasoningTokens: null, cacheHitRate: null,
    promptSemantics: 'unknown', derivedFields: [], unknownFields: [], raw: null
  }
}

/** 空上下文分布：全 null（未采集 ≠ 0） */
function emptyContext() {
  const out = { method: DATA_CLASS.UNKNOWN, totalTokens: null, messageCount: 0, toolCount: 0 }
  for (const bucket of CONTEXT_BUCKETS) out[bucket] = null
  return out
}

/**
 * 校验一个 telemetry 事件是否合法。
 * 目的：防止把未定义的字段（例如误塞完整 prompt）写进采集器。
 * 白名单式——只允许下列字段，出现未知字段直接拒绝，是隐私红线的执行手段。
 */
const ALLOWED_EVENT_FIELDS = Object.freeze({
  [TELEMETRY_EVENTS.SESSION_CREATED]: ['sessionId', 'at', 'workerCount'],
  [TELEMETRY_EVENTS.SESSION_ACTIVATED]: ['sessionId', 'at', 'workerCount'],
  [TELEMETRY_EVENTS.SESSION_RESTORED]: ['sessionId', 'at', 'restoredMessages', 'restoredSequence'],
  [TELEMETRY_EVENTS.CONTEXT_ASSEMBLED]: ['sessionId', 'turnId', 'requestId', 'at', 'context'],
  [TELEMETRY_EVENTS.MODEL_REQUEST_STARTED]: ['sessionId', 'turnId', 'requestId', 'at', 'step', 'attempt', 'model', 'toolCount'],
  [TELEMETRY_EVENTS.MODEL_FIRST_DELTA]: ['sessionId', 'turnId', 'requestId', 'at', 'deltaType', 'ttftMs'],
  [TELEMETRY_EVENTS.MODEL_REQUEST_COMPLETED]: ['sessionId', 'turnId', 'requestId', 'at', 'durationMs', 'ttftMs', 'usage', 'toolCallCount'],
  [TELEMETRY_EVENTS.MODEL_REQUEST_FAILED]: ['sessionId', 'turnId', 'requestId', 'at', 'durationMs', 'errorKind', 'retryDecision'],
  [TELEMETRY_EVENTS.TOOL_EXECUTION_STARTED]: ['sessionId', 'turnId', 'requestId', 'toolCallId', 'at', 'toolName'],
  [TELEMETRY_EVENTS.TOOL_EXECUTION_COMPLETED]: ['sessionId', 'turnId', 'requestId', 'toolCallId', 'at', 'toolName', 'durationMs', 'resultBytes'],
  [TELEMETRY_EVENTS.TOOL_EXECUTION_FAILED]: ['sessionId', 'turnId', 'requestId', 'toolCallId', 'at', 'toolName', 'durationMs', 'errorKind'],
  [TELEMETRY_EVENTS.TURN_SETTLED]: ['sessionId', 'turnId', 'at', 'status', 'reason']
})

/** 明确禁止出现在任何事件里的键（隐私红线的硬拦截） */
const FORBIDDEN_KEYS = Object.freeze([
  'prompt', 'messages', 'systemPrompt', 'apiKey', 'api_key', 'authorization',
  'toolResult', 'result', 'output', 'content', 'imageData', 'base64', 'token'
])

function validateTelemetryEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('TELEMETRY_EVENT_INVALID: not an object')
  if (typeof event.type !== 'string' || !ALLOWED_EVENT_FIELDS[event.type]) {
    throw new Error('TELEMETRY_EVENT_UNKNOWN_TYPE: ' + String(event.type))
  }
  const allowed = ALLOWED_EVENT_FIELDS[event.type]
  for (const key of Object.keys(event)) {
    /* type 是事件自身的判别字段，不属于业务字段白名单，跳过 */
    if (key === 'type') continue
    if (FORBIDDEN_KEYS.indexOf(key) >= 0) throw new Error('TELEMETRY_PRIVACY_FORBIDDEN_KEY: ' + key)
    if (allowed.indexOf(key) < 0) throw new Error('TELEMETRY_EVENT_UNEXPECTED_FIELD: ' + event.type + '.' + key)
  }
  if (typeof event.sessionId !== 'string' || !event.sessionId) throw new Error('TELEMETRY_EVENT_MISSING_SESSION: ' + event.type)
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) throw new Error('TELEMETRY_EVENT_BAD_AT: ' + event.type)
  return event
}

module.exports = {
  TELEMETRY_EVENTS, EVENT_SOURCES, DATA_CLASS, REQUEST_STATUS, TOOL_STATUS,
  CONTEXT_BUCKETS, TELEMETRY_SCHEMA_VERSION,
  emptyUsage, emptyContext, validateTelemetryEvent, ALLOWED_EVENT_FIELDS, FORBIDDEN_KEYS
}
