'use strict'

/**
 * Telemetry 只读查询门面（第三阶段 UI 专用）
 *
 * 硬约束：本模块**只暴露只读方法**。Collector 的写方法
 * （record / drop / dispose / recordRetryDecision / emit）在这里不出现，
 * 渲染层拿不到，也就无法反向影响采集与执行链路。
 *
 * 隐私裁剪也放在这一层：面板/状态栏需要的字段由主进程白名单挑出，
 * UI 拿不到原始事件、消息正文、工具参数与地址。
 */

const not = (value) => value ? false : true

/** 渲染层允许请求的动作，白名单外一律拒绝 */
const READONLY_ACTIONS = Object.freeze(['get', 'list', 'snapshot', 'panel'])

/** 工具明细里允许透出的字段（不含 args / 内容 / 路径） */
const TOOL_VIEW_FIELDS = ['toolName', 'status', 'durationMs', 'resultBytes', 'errorKind']

function numOrNull(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {() => object|null} getTelemetry 返回 telemetry 服务（可能尚未就绪）
 */
function createTelemetryQuery(getTelemetry) {
  function read(action, data) {
    if (READONLY_ACTIONS.indexOf(action) < 0) {
      throw new Error('TELEMETRY_ACTION_NOT_ALLOWED: ' + String(action))
    }
    const telemetry = getTelemetry()
    if (not(telemetry)) return { available: false, reason: 'telemetry plugin not loaded' }
    const repository = telemetry.repository
    const sessionId = String((data && data.sessionId) || '')

    if (action === 'get') {
      if (not(sessionId)) return { available: true, metrics: null }
      return { available: true, metrics: repository.get(sessionId) }
    }
    if (action === 'list') return { available: true, sessions: repository.list() }
    if (action === 'snapshot') return { available: true, snapshot: telemetry.collector.snapshot() }
    /* panel：浮动详情面板的四区域视图，主进程裁剪好再给 UI */
    if (action === 'panel') {
      if (not(sessionId)) return { available: true, panel: null }
      const metrics = repository.get(sessionId)
      if (not(metrics)) return { available: true, panel: null }
      return { available: true, panel: buildPanel(metrics) }
    }
    return { available: false, reason: 'unhandled read action' }
  }

  return { read: read, actions: READONLY_ACTIONS }
}

/** 把 provider usage 收成展示字段；无真实数据一律 null（UI 显示 —）
 *  兼容两种口径名：会话级用 dataClass，turn/请求级用 source（collector 原字段）。 */
function usageClass(usage) {
  if (not(usage)) return 'unknown'
  return usage.dataClass || usage.source || 'unknown'
}

function usageView(usage) {
  if (usageClass(usage) !== 'provider') {
    return {
      dataClass: usageClass(usage),
      promptTokens: null, completionTokens: null, totalTokens: null,
      cacheReadTokens: null, cacheHitRate: null
    }
  }
  return {
    dataClass: 'provider',
    promptTokens: numOrNull(usage.promptTokens),
    completionTokens: numOrNull(usage.completionTokens),
    totalTokens: numOrNull(usage.totalTokens),
    cacheReadTokens: numOrNull(usage.cacheReadTokens),
    cacheHitRate: numOrNull(usage.cacheHitRate)
  }
}

/**
 * 状态栏摘要：只带当前会话的"本轮 + 会话累计"关键字段，控制推送体积。
 * 约定：计数类 0 是真实值；计量类未知时为 null。
 */
function summarize(metrics) {
  if (not(metrics)) return null
  const turns = Array.isArray(metrics.turns) ? metrics.turns : []
  const current = turns.length > 0 ? turns[turns.length - 1] : null
  const context = metrics.context || {}
  return {
    sessionId: metrics.sessionId,
    running: Boolean(metrics.running),
    lifecycle: metrics.lifecycle || null,
    status: current ? current.status : null,
    turnCount: metrics.turnCount || 0,
    steps: metrics.steps || 0,
    /* 本轮 token（provider 真实口径；本轮无 usage → null，显示 —） */
    turnUsage: usageView(current ? current.usage : null),
    /* 会话累计 token */
    sessionUsage: usageView(metrics.usage),
    /* TPS：本轮优先，本轮没有就退回会话口径 */
    tps: current && current.tps !== undefined && current.tps !== null
      ? current.tps
      : (metrics.tps === undefined ? null : metrics.tps),
    tpsDataClass: (current && current.tpsDataClass) || (metrics.tps === null || metrics.tps === undefined ? 'unknown' : 'provider'),
    /* Context：估算口径，UI 必须标"估算" */
    contextTokens: context.totalTokens === undefined ? null : numOrNull(context.totalTokens),
    contextMethod: context.method || 'estimated',
    modelRequests: metrics.modelRequests || 0,
    modelFailed: metrics.modelFailed || 0,
    modelCancelled: metrics.modelCancelled || 0,
    toolCalls: metrics.toolCalls || 0,
    toolFailed: metrics.toolFailed || 0,
    retries: metrics.retries || 0,
    modelDurationMs: metrics.modelDurationMs || 0,
    toolDurationMs: metrics.toolDurationMs || 0
  }
}

/** 浮动面板四区域：模型调用 / 性能指标 / 上下文分析 / 工具执行 */
function buildPanel(metrics) {
  const turns = Array.isArray(metrics.turns) ? metrics.turns : []
  const current = turns.length > 0 ? turns[turns.length - 1] : null
  const context = metrics.context || {}
  /* 本轮工具明细（跨本轮所有 turn 的 tools 合并展示） */
  const tools = current && Array.isArray(current.tools) ? current.tools : []
  let resultBytesTotal = 0
  let resultBytesKnown = false
  const items = tools.map((tool) => {
    const view = {}
    for (const field of TOOL_VIEW_FIELDS) view[field] = tool[field] === undefined ? null : tool[field]
    if (Number.isFinite(Number(tool.resultBytes))) { resultBytesTotal += Number(tool.resultBytes); resultBytesKnown = true }
    return view
  })
  /* 本轮请求明细（重试/多 step 都看得见） */
  const requests = current && Array.isArray(current.requests) ? current.requests.map((r) => ({
    requestId: r.requestId,
    step: numOrNull(r.step),
    attempt: numOrNull(r.attempt),
    status: r.status,
    model: r.model || null,
    ttftMs: numOrNull(r.ttftMs),
    durationMs: numOrNull(r.durationMs),
    tps: numOrNull(r.tps),
    tpsDataClass: r.tpsDataClass || 'unknown',
    totalTokens: r.usage && r.usage.source === 'provider' ? numOrNull(r.usage.totalTokens) : null,
    errorKind: r.errorKind || null,
    retryDecision: r.retryDecision || null,
    toolCallCount: r.toolCallCount || 0
  })) : []

  return {
    sessionId: metrics.sessionId,
    running: Boolean(metrics.running),
    lifecycle: metrics.lifecycle || null,
    turnStatus: current ? current.status : null,
    turnReason: current ? String(current.reason || '') : '',
    model: {
      scope: 'currentTurn',
      requests: current ? (current.modelRequests || 0) : 0,
      completed: current ? (current.modelCompleted || 0) : 0,
      failed: current ? (current.modelFailed || 0) : 0,
      cancelled: current ? (current.modelCancelled || 0) : 0,
      retries: current ? (current.retries || 0) : 0,
      durationMs: current ? numOrNull(current.modelDurationMs) : null,
      ttftMs: current ? numOrNull(current.ttftMs) : null,
      usage: usageView(current ? current.usage : null),
      usageCoverage: current && current.usageCoverage ? current.usageCoverage : { providerRequests: 0, totalRequests: 0 },
      /* 明细单独叫 items：与上面的 requests（计数）区分，避免同名互相覆盖 */
      items: requests
    },
    perf: {
      tps: current && numOrNull(current.tps) !== null ? current.tps : numOrNull(metrics.tps),
      tpsDataClass: (current && current.tpsDataClass) || (numOrNull(metrics.tps) === null ? 'unknown' : 'provider'),
      turnDurationMs: current && current.startedAt ? ((current.endedAt || Date.now()) - current.startedAt) : null,
      modelDurationMs: numOrNull(metrics.modelDurationMs),
      toolDurationMs: numOrNull(metrics.toolDurationMs),
      turnCount: metrics.turnCount || 0,
      steps: metrics.steps || 0,
      requestCount: metrics.modelRequests || 0,
      retries: metrics.retries || 0
    },
    context: {
      method: context.method || 'estimated',
      totalTokens: numOrNull(context.totalTokens),
      systemTokens: numOrNull(context.systemTokens),
      toolDefinitionTokens: numOrNull(context.toolDefinitionTokens),
      conversationTokens: numOrNull(context.conversationTokens),
      memoryTokens: numOrNull(context.memoryTokens),
      imageTokens: numOrNull(context.imageTokens),
      messageCount: context.messageCount || 0,
      toolCount: context.toolCount || 0,
      notes: context.notes || ''
    },
    tools: {
      scope: 'currentTurn',
      calls: current ? (current.toolCalls || 0) : 0,
      completed: current ? (current.toolCompleted || 0) : 0,
      failed: current ? (current.toolFailed || 0) : 0,
      cancelled: current ? (current.toolCancelled || 0) : 0,
      durationMs: current ? numOrNull(current.toolDurationMs) : null,
      resultBytesTotal: resultBytesKnown ? resultBytesTotal : null,
      cacheHitRate: metrics.usage && metrics.usage.dataClass === 'provider' ? numOrNull(metrics.usage.cacheHitRate) : null,
      items: items
    }
  }
}

/**
 * 节流推送器：事件密集时按固定间隔合并成一次推送。
 * 只推**运行中**的会话（空闲会话由 UI 按需拉，不占推送带宽）。
 */
function createThrottledPush(options) {
  const opts = options || {}
  const getTelemetry = opts.getTelemetry
  const push = opts.push /* (payload) => void */
  const intervalMs = Math.max(50, Number(opts.intervalMs) || 300)
  let timer = null
  let stopped = false

  /* 上一轮在跑的会话：用于"终态补推"。
     只推 running 会话会让 run 结束后的最终值（provider usage 常在收尾才到）
     永远推不到 UI，指标条会停在流式期间的 —。因此：
       当前 running 的会话 → 每次都推
       刚由 running 转空闲的会话 → 补推一次终态
       一直空闲的会话 → 不推（省带宽，UI 按需拉） */
  let lastRunning = new Set()

  function flush() {
    timer = null
    if (stopped) return
    const telemetry = getTelemetry()
    if (not(telemetry)) return
    const sessions = []
    const nowRunning = new Set()
    for (const sessionId of telemetry.collector.sessions.keys()) {
      const metrics = telemetry.collector.sessionMetrics(sessionId)
      if (not(metrics)) continue
      if (metrics.running) nowRunning.add(sessionId)
      else if (!lastRunning.has(sessionId)) continue
      const summary = summarize(metrics)
      if (summary) sessions.push(summary)
    }
    lastRunning = nowRunning
    if (sessions.length === 0) return
    try { push({ type: 'telemetry:update', sessions: sessions, at: Date.now() }) }
    catch (error) { /* 推送失败绝不能影响采集与执行 */ }
  }

  function schedule() {
    if (stopped || timer) return
    timer = setTimeout(flush, intervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return { schedule: schedule, stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null } } }
}

module.exports = { createTelemetryQuery, createThrottledPush, summarize, buildPanel, READONLY_ACTIONS }
