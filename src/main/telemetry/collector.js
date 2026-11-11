'use strict'

/**
 * Runtime Telemetry —— Metrics Collector（第二阶段）
 *
 * 职责：消费 telemetry 事件，按 sessionId 隔离累计，产出实时快照与会话汇总。
 *
 * 关联模型（复用 Runtime 已有真实 ID，不另造）：
 *   sessionId  ← AgentPool 的 worker key（agent-pool.js:135 worker.sessionId）
 *   turnId     ← execution.id（run-turn.js:77 EVENTS.START data.id）
 *   requestId  ← execution.id + ':' + step + ':' + attempt（run-turn.js:131）
 *   toolCallId ← call.id（run-turn.js:259，经 tools:execute payload.context.toolCallId 传入）
 *
 * 一条 turn 下挂多个 request（重试 / 多 step），一个 request 后挂多个顺序工具。
 *
 * 真实 vs 估算：
 *   - usage 来自供应商 → dataClass='provider'，参与 TPS/命中率等真实计算
 *   - usage 拿不到     → 相关指标 null，unknownFields 记录，绝不猜
 *   - 上下文分布       → 本地估算，dataClass='estimated'，与 provider 分区存放
 */

const {
  TELEMETRY_EVENTS, DATA_CLASS, REQUEST_STATUS, TOOL_STATUS,
  emptyUsage, emptyContext, validateTelemetryEvent
} = require('./schema')

const not = (value) => value ? false : true

function nowMs() { return Date.now() }

function newRequest(record) {
  return {
    requestId: record.requestId,
    turnId: record.turnId,
    step: record.step === undefined ? null : record.step,
    attempt: record.attempt === undefined ? null : record.attempt,
    model: record.model || null,
    toolCount: record.toolCount || 0,
    status: REQUEST_STATUS.PENDING,
    startedAt: record.at,
    firstDeltaAt: null,
    completedAt: null,
    ttftMs: null,
    durationMs: null,
    usage: emptyUsage(),
    toolCallCount: 0,
    toolCallIds: [],
    errorKind: null,
    retryDecision: null
  }
}

function newTurn(record) {
  return {
    turnId: record.turnId,
    sessionId: record.sessionId,
    status: 'running',
    startedAt: record.at,
    endedAt: null,
    reason: '',
    requestIds: [],
    requests: new Map(),
    toolCallIds: []
  }
}

function newSession(sessionId) {
  return {
    sessionId: sessionId,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    /* 会话生命周期：created / restored / activated */
    lifecycle: null,
    restoredMessages: 0,
    restoredSequence: 0,
    turnIds: [],
    turns: new Map(),
    /* 实时累计（增量维护，不做全量重算，保证 O(1) 更新） */
    totals: {
      turns: 0,
      steps: 0,
      modelRequests: 0,
      modelCompleted: 0,
      modelFailed: 0,
      modelCancelled: 0,
      modelDurationMs: 0,
      toolCalls: 0,
      toolCompleted: 0,
      toolFailed: 0,
      toolCancelled: 0,
      toolDurationMs: 0,
      retries: 0,
      /* provider 口径 token（真实） */
      promptTokens: 0,
      uncachedPromptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      /* 有真实 usage 的请求数——用于判断"这批 token 有多可信" */
      providerUsageRequests: 0,
      unknownUsageRequests: 0
    },
    /* 最近一次上下文快照（估算口径，独立存放不混入 provider） */
    lastContext: emptyContext()
  }
}

class MetricsCollector {
  constructor(options) {
    const opts = options || {}
    this.clock = opts.clock || nowMs
    this.maxSessions = Math.max(1, Number(opts.maxSessions) || 64)
    this.sessions = new Map()
    this.listeners = new Set()
    this.disposed = false
    /* 每会话"当前 turn / 当前 request"游标：工具事件本身不带 turnId，
       靠最近一次 model.request.started 的游标关联（真实执行顺序保证）。 */
    this.cursors = new Map()
  }

  on(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event) {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { /* 监听器异常不得影响采集主流程 */ }
    }
  }

  /* ── 事件入口 ───────────────────────────────────────────────── */
  record(rawEvent) {
    if (this.disposed) return null
    let event
    try { event = validateTelemetryEvent(rawEvent) } catch (error) { return null }
    const session = this.ensure(event.sessionId)
    session.updatedAt = this.clock()

    switch (event.type) {
      case TELEMETRY_EVENTS.SESSION_CREATED:
        session.lifecycle = 'created'
        break
      case TELEMETRY_EVENTS.SESSION_ACTIVATED:
        session.lifecycle = 'activated'
        break
      case TELEMETRY_EVENTS.SESSION_RESTORED:
        session.lifecycle = 'restored'
        session.restoredMessages = Number(event.restoredMessages) || 0
        session.restoredSequence = Number(event.restoredSequence) || 0
        break
      case TELEMETRY_EVENTS.CONTEXT_ASSEMBLED:
        this.applyContext(session, event)
        break
      case TELEMETRY_EVENTS.MODEL_REQUEST_STARTED:
        this.applyModelStarted(session, event)
        break
      case TELEMETRY_EVENTS.MODEL_FIRST_DELTA:
        this.applyFirstDelta(session, event)
        break
      case TELEMETRY_EVENTS.MODEL_REQUEST_COMPLETED:
        this.applyModelCompleted(session, event)
        break
      case TELEMETRY_EVENTS.MODEL_REQUEST_FAILED:
        this.applyModelFailed(session, event)
        break
      case TELEMETRY_EVENTS.TOOL_EXECUTION_STARTED:
        this.applyToolStarted(session, event)
        break
      case TELEMETRY_EVENTS.TOOL_EXECUTION_COMPLETED:
        this.applyToolSettled(session, event, TOOL_STATUS.COMPLETED)
        break
      case TELEMETRY_EVENTS.TOOL_EXECUTION_FAILED:
        this.applyToolSettled(session, event, TOOL_STATUS.FAILED)
        break
      case TELEMETRY_EVENTS.TURN_SETTLED:
        this.applyTurnSettled(session, event)
        break
      default:
        return null
    }
    this.emit(event)
    return event
  }

  ensure(sessionId) {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    if (this.sessions.size >= this.maxSessions) this.evictOldest()
    const created = newSession(sessionId)
    this.sessions.set(sessionId, created)
    return created
  }

  cursor(sessionId) {
    if (!this.cursors.has(sessionId)) this.cursors.set(sessionId, { turnId: null, requestId: null })
    return this.cursors.get(sessionId)
  }

  evictOldest() {
    let oldestKey = null
    let oldest = Infinity
    for (const entry of this.sessions.entries()) {
      /* 正在跑的会话不淘汰 */
      if (this.isRunning(entry[0])) continue
      if (entry[1].updatedAt < oldest) { oldest = entry[1].updatedAt; oldestKey = entry[0] }
    }
    if (oldestKey !== null) this.drop(oldestKey)
  }

  isRunning(sessionId) {
    const session = this.sessions.get(sessionId)
    if (not(session)) return false
    for (const turnId of session.turnIds) {
      if (session.turns.get(turnId).status === 'running') return true
    }
    return false
  }

  /* ── 上下文分布（估算，独立分区） ───────────────────────────── */
  applyContext(session, event) {
    if (not(event.context)) return
    const context = event.context
    session.lastContext = {
      method: context.method || DATA_CLASS.ESTIMATED,
      totalTokens: context.totalTokens === null || context.totalTokens === undefined ? null : Number(context.totalTokens) || 0,
      messageCount: Number(context.messageCount) || 0,
      toolCount: Number(context.toolCount) || 0,
      systemTokens: numOrNull(context.systemTokens),
      toolDefinitionTokens: numOrNull(context.toolDefinitionTokens),
      conversationTokens: numOrNull(context.conversationTokens),
      memoryTokens: numOrNull(context.memoryTokens),
      imageTokens: numOrNull(context.imageTokens),
      capturedAt: event.at,
      requestId: event.requestId || null
    }
  }

  /* ── 模型请求 ───────────────────────────────────────────────── */
  applyModelStarted(session, event) {
    const turn = this.ensureTurn(session, event.turnId, event.at)
    if (turn.requests.has(event.requestId)) return
    const request = newRequest(event)
    turn.requests.set(event.requestId, request)
    turn.requestIds.push(event.requestId)
    turn.steps = Math.max(turn.steps || 0, Number(event.step) || 0)
    session.totals.modelRequests += 1
    session.totals.steps = Math.max(session.totals.steps, Number(event.step) || 0)
    /* attempt > 0 说明这是重试 */
    if (Number(event.attempt) > 0) session.totals.retries += 1
    const cursor = this.cursor(session.sessionId)
    cursor.turnId = event.turnId
    cursor.requestId = event.requestId
  }

  applyFirstDelta(session, event) {
    const request = this.findRequest(session, event.requestId)
    if (not(request) || request.firstDeltaAt !== null) return
    request.firstDeltaAt = event.at
    request.status = REQUEST_STATUS.STREAMING
    request.ttftMs = Number.isFinite(event.ttftMs) ? event.ttftMs : (event.at - request.startedAt)
  }

  applyModelCompleted(session, event) {
    const request = this.findRequest(session, event.requestId)
    if (not(request)) return
    request.status = REQUEST_STATUS.COMPLETED
    request.completedAt = event.at
    request.durationMs = Number.isFinite(event.durationMs) ? event.durationMs : (event.at - request.startedAt)
    if (not(request.ttftMs) && request.firstDeltaAt !== null) request.ttftMs = request.firstDeltaAt - request.startedAt
    if (event.usage && typeof event.usage === 'object') request.usage = event.usage
    request.toolCallCount = Number(event.toolCallCount) || 0
    session.totals.modelCompleted += 1
    this.accumulateUsage(session, request.usage)
  }

  applyModelFailed(session, event) {
    const request = this.findRequest(session, event.requestId)
    if (not(request)) return
    const cancelled = event.errorKind === 'cancelled' || event.errorKind === 'aborted'
    request.status = cancelled ? REQUEST_STATUS.CANCELLED : REQUEST_STATUS.FAILED
    request.completedAt = event.at
    request.durationMs = Number.isFinite(event.durationMs) ? event.durationMs : (event.at - request.startedAt)
    request.errorKind = event.errorKind || 'error'
    request.retryDecision = event.retryDecision || null
    if (cancelled) session.totals.modelCancelled += 1
    else session.totals.modelFailed += 1
    session.totals.modelDurationMs += request.durationMs
  }

  accumulateUsage(session, usage) {
    if (not(usage) || usage.source !== DATA_CLASS.PROVIDER) {
      session.totals.unknownUsageRequests += 1
      return
    }
    session.totals.providerUsageRequests += 1
    session.totals.promptTokens += usage.promptTokens || 0
    session.totals.uncachedPromptTokens += usage.uncachedPromptTokens || 0
    session.totals.completionTokens += usage.completionTokens || 0
    session.totals.totalTokens += usage.totalTokens || 0
    session.totals.cacheReadTokens += usage.cacheReadTokens || 0
    session.totals.cacheWriteTokens += usage.cacheWriteTokens || 0
    session.totals.reasoningTokens += usage.reasoningTokens || 0
  }

  /* ── 工具执行 ───────────────────────────────────────────────── */
  applyToolStarted(session, event) {
    const cursor = this.cursor(session.sessionId)
    const turnId = event.turnId || cursor.turnId
    if (not(turnId) || not(event.toolCallId)) return
    const turn = this.ensureTurn(session, turnId, event.at)
    if (turn.requests.has(event.toolCallId) || turn.toolCallIds.indexOf(event.toolCallId) >= 0) return
    const request = this.findRequest(session, cursor.requestId)
    const tool = {
      toolCallId: event.toolCallId,
      toolName: event.toolName || 'unknown',
      turnId: turnId,
      requestId: cursor.requestId || null,
      status: TOOL_STATUS.RUNNING,
      startedAt: event.at,
      endedAt: null,
      durationMs: null,
      resultBytes: null,
      errorKind: null
    }
    turn.tools = turn.tools || new Map()
    turn.tools.set(event.toolCallId, tool)
    turn.toolCallIds.push(event.toolCallId)
    if (request) {
      request.toolCallIds.push(event.toolCallId)
      request.toolCallCount = request.toolCallIds.length
    }
    session.totals.toolCalls += 1
  }

  applyToolSettled(session, event, status) {
    const turn = this.findTurn(session, event.turnId || this.cursor(session.sessionId).turnId)
    if (not(turn) || not(turn.tools) || not(event.toolCallId)) return
    const tool = turn.tools.get(event.toolCallId)
    if (not(tool) || tool.status !== TOOL_STATUS.RUNNING) return
    tool.status = status
    tool.endedAt = event.at
    tool.durationMs = Number.isFinite(event.durationMs) ? event.durationMs : (event.at - tool.startedAt)
    if (status === TOOL_STATUS.COMPLETED) {
      tool.resultBytes = Number.isFinite(event.resultBytes) ? event.resultBytes : null
      session.totals.toolCompleted += 1
    } else {
      tool.errorKind = event.errorKind || 'error'
      session.totals.toolFailed += 1
    }
    session.totals.toolDurationMs += tool.durationMs
  }

  /* ── turn 生命周期 ──────────────────────────────────────────── */
  ensureTurn(session, turnId, at) {
    if (not(turnId)) return null
    let turn = session.turns.get(turnId)
    if (not(turn)) {
      turn = newTurn({ turnId: turnId, sessionId: session.sessionId, at: at })
      session.turns.set(turnId, turn)
      session.turnIds.push(turnId)
      session.totals.turns += 1
    }
    return turn
  }

  applyTurnSettled(session, event) {
    const turn = this.findTurn(session, event.turnId)
    if (not(turn)) return
    turn.status = event.status || 'completed'
    turn.endedAt = event.at
    turn.reason = String(event.reason || '').slice(0, 500)
    /* 会话被取消/中断时，把仍在 running 的 request/tool 收敛成 cancelled，
       避免快照里出现"永远在跑"的僵尸记录。 */
    if (turn.status === 'cancelled' || turn.status === 'interrupted' || turn.status === 'timed_out') {
      for (const request of turn.requests.values()) {
        if (request.status === REQUEST_STATUS.PENDING || request.status === REQUEST_STATUS.STREAMING) {
          request.status = REQUEST_STATUS.CANCELLED
          request.completedAt = request.completedAt || event.at
          request.errorKind = 'cancelled'
          session.totals.modelCancelled += 1
        }
      }
      if (turn.tools) {
        for (const tool of turn.tools.values()) {
          if (tool.status === TOOL_STATUS.RUNNING) {
            tool.status = TOOL_STATUS.CANCELLED
            tool.endedAt = event.at
            tool.durationMs = event.at - tool.startedAt
            tool.errorKind = 'cancelled'
            session.totals.toolCancelled += 1
          }
        }
      }
    }
  }

  findTurn(session, turnId) {
    if (not(turnId)) return null
    return session.turns.get(turnId) || null
  }

  findRequest(session, requestId) {
    if (not(requestId)) return null
    const cursor = this.cursor(session.sessionId)
    if (cursor.turnId) {
      const turn = session.turns.get(cursor.turnId)
      if (turn && turn.requests.has(requestId)) return turn.requests.get(requestId)
    }
    for (let index = session.turnIds.length - 1; index >= 0; index -= 1) {
      const turn = session.turns.get(session.turnIds[index])
      if (turn && turn.requests.has(requestId)) return turn.requests.get(requestId)
    }
    return null
  }

  /**
   * 回填重试决策。
   * 真实顺序：requestChat 抛错 → waterfall listener 记 failed（此时还不知道会不会重试）
   * → run-turn.js 的 catch 里 flow.retry() 才算出决策。
   * 所以决策必须在之后回填，不能提前猜。
   */
  recordRetryDecision(sessionId, requestId, decision) {
    if (this.disposed || not(sessionId) || not(requestId)) return false
    const session = this.sessions.get(String(sessionId))
    if (not(session)) return false
    const request = this.findRequest(session, String(requestId))
    if (not(request) || request.status !== REQUEST_STATUS.FAILED) return false
    request.retryDecision = decision || null
    return true
  }

  /* ── 指标计算 ───────────────────────────────────────────────── */

  /**
   * TPS：真实输出 token / 首个输出到完成的秒数。
   * 严格要求 completionTokens 来自 provider——用估算 token 算 TPS 会虚高，
   * 因此无 provider usage 时返回 null（unknown），不返回估算值。
   */
  static computeTps(request) {
    if (not(request) || not(request.firstDeltaAt) || not(request.completedAt)) return null
    const windowMs = request.completedAt - request.firstDeltaAt
    if (windowMs <= 0) return null
    const completion = request.usage && request.usage.source === DATA_CLASS.PROVIDER
      ? request.usage.completionTokens
      : null
    if (completion === null || completion === undefined) return null
    return (completion / windowMs) * 1000
  }

  /** 单请求指标快照 */
  requestMetrics(request) {
    return {
      requestId: request.requestId,
      turnId: request.turnId,
      step: request.step,
      attempt: request.attempt,
      model: request.model,
      status: request.status,
      startedAt: request.startedAt,
      firstDeltaAt: request.firstDeltaAt,
      completedAt: request.completedAt,
      ttftMs: request.ttftMs,
      durationMs: request.durationMs,
      tps: MetricsCollector.computeTps(request),
      tpsDataClass: request.usage && request.usage.source === DATA_CLASS.PROVIDER
        ? DATA_CLASS.PROVIDER
        : DATA_CLASS.UNKNOWN,
      usage: request.usage,
      toolCallCount: request.toolCallCount,
      toolCallIds: request.toolCallIds.slice(),
      errorKind: request.errorKind,
      retryDecision: request.retryDecision
    }
  }

  /** 单 turn 指标快照 */
  turnMetrics(turn) {
    const requests = turn.requestIds.map((id) => turn.requests.get(id)).filter(Boolean)
    const tools = turn.tools ? Array.from(turn.tools.values()) : []
    const provider = requests.filter((r) => r.usage && r.usage.source === DATA_CLASS.PROVIDER)
    const modelDurationMs = requests.reduce((sum, r) => sum + (r.durationMs || 0), 0)
    const toolDurationMs = tools.reduce((sum, t) => sum + (t.durationMs || 0), 0)
    const completionTokens = provider.reduce((sum, r) => sum + (r.usage.completionTokens || 0), 0)
    const firstDelta = requests.reduce((min, r) => (r.firstDeltaAt === null ? min : (min === null ? r.firstDeltaAt : Math.min(min, r.firstDeltaAt))), null)
    const lastDone = requests.reduce((max, r) => (r.completedAt === null ? max : (max === null ? r.completedAt : Math.max(max, r.completedAt))), null)
    const windowMs = (firstDelta !== null && lastDone !== null) ? lastDone - firstDelta : 0
    return {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      status: turn.status,
      reason: turn.reason,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      steps: requests.reduce((max, r) => Math.max(max, r.step || 0), 0),
      modelRequests: requests.length,
      modelCompleted: requests.filter((r) => r.status === REQUEST_STATUS.COMPLETED).length,
      modelFailed: requests.filter((r) => r.status === REQUEST_STATUS.FAILED).length,
      modelCancelled: requests.filter((r) => r.status === REQUEST_STATUS.CANCELLED).length,
      retries: requests.filter((r) => (r.attempt || 0) > 0).length,
      modelDurationMs: modelDurationMs,
      toolCalls: tools.length,
      toolCompleted: tools.filter((t) => t.status === TOOL_STATUS.COMPLETED).length,
      toolFailed: tools.filter((t) => t.status === TOOL_STATUS.FAILED).length,
      toolCancelled: tools.filter((t) => t.status === TOOL_STATUS.CANCELLED).length,
      toolDurationMs: toolDurationMs,
      ttftMs: requests.reduce((min, r) => (r.ttftMs === null || r.ttftMs === undefined ? min : (min === null ? r.ttftMs : Math.min(min, r.ttftMs))), null),
      /* 整轮 TPS：provider 输出 token / 首 delta 到最后完成的窗口 */
      tps: (provider.length > 0 && windowMs > 0) ? (completionTokens / windowMs) * 1000 : null,
      tpsDataClass: provider.length > 0 ? DATA_CLASS.PROVIDER : DATA_CLASS.UNKNOWN,
      usage: aggregateProviderUsage(provider),
      usageCoverage: { providerRequests: provider.length, totalRequests: requests.length },
      requests: requests.map((r) => this.requestMetrics(r)),
      tools: tools.map((t) => Object.assign({}, t))
    }
  }

  /** 会话汇总（会话结束或按需查询） */
  sessionMetrics(sessionId) {
    const session = this.sessions.get(sessionId)
    if (not(session)) return null
    const turns = session.turnIds.map((id) => session.turns.get(id)).filter(Boolean)
    const totals = Object.assign({}, session.totals)
    const cacheHitRate = totals.promptTokens > 0 ? Math.min(1, totals.cacheReadTokens / totals.promptTokens) : null
    const totalWindowMs = turns.reduce((sum, t) => sum + ((t.endedAt || this.clock()) - t.startedAt), 0)
    return {
      schemaVersion: 1,
      sessionId: session.sessionId,
      lifecycle: session.lifecycle,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      restoredMessages: session.restoredMessages,
      restoredSequence: session.restoredSequence,
      running: this.isRunning(sessionId),
      turnCount: turns.length,
      steps: totals.steps,
      modelRequests: totals.modelRequests,
      modelCompleted: totals.modelCompleted,
      modelFailed: totals.modelFailed,
      modelCancelled: totals.modelCancelled,
      modelDurationMs: totals.modelDurationMs,
      toolCalls: totals.toolCalls,
      toolCompleted: totals.toolCompleted,
      toolFailed: totals.toolFailed,
      toolCancelled: totals.toolCancelled,
      toolDurationMs: totals.toolDurationMs,
      retries: totals.retries,
      usage: {
        dataClass: totals.providerUsageRequests > 0 ? DATA_CLASS.PROVIDER : DATA_CLASS.UNKNOWN,
        promptTokens: totals.providerUsageRequests > 0 ? totals.promptTokens : null,
        uncachedPromptTokens: totals.providerUsageRequests > 0 ? totals.uncachedPromptTokens : null,
        completionTokens: totals.providerUsageRequests > 0 ? totals.completionTokens : null,
        totalTokens: totals.providerUsageRequests > 0 ? totals.totalTokens : null,
        cacheReadTokens: totals.providerUsageRequests > 0 ? totals.cacheReadTokens : null,
        cacheWriteTokens: totals.providerUsageRequests > 0 ? totals.cacheWriteTokens : null,
        reasoningTokens: totals.providerUsageRequests > 0 ? totals.reasoningTokens : null,
        cacheHitRate: cacheHitRate,
        providerRequests: totals.providerUsageRequests,
        unknownRequests: totals.unknownUsageRequests
      },
      context: Object.assign({}, session.lastContext),
      /* 整会话 TPS：provider 输出 / 所有 turn 的首 delta→完成窗口之和 */
      tps: (totals.providerUsageRequests > 0 && totalWindowMs > 0)
        ? (totals.completionTokens / totalWindowMs) * 1000
        : null,
      turns: turns.map((t) => this.turnMetrics(t))
    }
  }

  snapshot() {
    const out = { schemaVersion: 1, sessionCount: this.sessions.size, sessions: {} }
    for (const key of this.sessions.keys()) out.sessions[key] = this.sessionMetrics(key)
    return out
  }

  /* ── 生命周期清理 ───────────────────────────────────────────── */
  drop(sessionId) {
    this.sessions.delete(sessionId)
    this.cursors.delete(sessionId)
    return true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.sessions.clear()
    this.cursors.clear()
  }
}

function aggregateProviderUsage(providerRequests) {
  if (not(providerRequests) || providerRequests.length === 0) return emptyUsage()
  const sum = (field) => providerRequests.reduce((total, r) => total + (r.usage[field] || 0), 0)
  const promptTokens = sum('promptTokens')
  const cacheReadTokens = sum('cacheReadTokens')
  const unknown = new Set()
  for (const r of providerRequests) for (const f of (r.usage.unknownFields || [])) unknown.add(f)
  return {
    source: DATA_CLASS.PROVIDER,
    promptTokens: promptTokens,
    uncachedPromptTokens: sum('uncachedPromptTokens'),
    completionTokens: sum('completionTokens'),
    totalTokens: sum('totalTokens'),
    cacheReadTokens: cacheReadTokens,
    cacheWriteTokens: sum('cacheWriteTokens'),
    cacheMissTokens: sum('cacheMissTokens'),
    reasoningTokens: sum('reasoningTokens'),
    cacheHitRate: promptTokens > 0 ? Math.min(1, cacheReadTokens / promptTokens) : null,
    promptSemantics: providerRequests[0].usage.promptSemantics || 'unknown',
    derivedFields: ['aggregated'],
    unknownFields: Array.from(unknown),
    requestCount: providerRequests.length
  }
}

function numOrNull(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

module.exports = { MetricsCollector }
