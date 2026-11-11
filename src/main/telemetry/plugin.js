'use strict'

/**
 * Runtime Telemetry 插件（第二阶段）—— 采集层，不含 UI
 *
 * 挂载形态：native Cordis 插件（cordis: true 走 mount 路径），
 * 因为需要 ctx.events.register 注册 waterfall listener。
 *
 * 零侵入策略（实测验证，见 .build-tools/probe-waterfall-return.js）：
 *   - llm:request  waterfall：包装 payload.onDelta 观测首个增量，
 *     await next() 拿到 requestChat 的真实返回值/异常。
 *     payload 与 model.js 闭包里的 request 是同一对象，包装后
 *     requestChat 收到的就是包装后的 onDelta —— 流式行为原样透传。
 *   - tools:execute waterfall：只读 payload.context（含 toolCallId / agent），
 *     不修改 args，await next() 拿真实结果与耗时。
 *   - state:committed parallel：复用 agent.record() 已有的广播，
 *     取 turnId / 终态，无需新增事件。
 *
 * 隐私：本插件不持有 messages / args / 工具返回内容，只测长度与耗时。
 *
 * 每次 apply 创建独立的 collector/repository，多个 PluginHost 互不污染
 * （测试里每个场景 new 一个 host，共享单例会串数据）。
 */

const { MetricsCollector } = require('./collector')
const { SessionMetricsRepository } = require('./repository')
const { measureContext } = require('./context-stats')
const {
  TELEMETRY_EVENTS, DATA_CLASS, REQUEST_STATUS, TOOL_STATUS, emptyUsage
} = require('./schema')

const not = (value) => value ? false : true

function nowMs() { return Date.now() }

/** 从 error 提炼一个不含敏感信息的分类标签（不保存原始 message 全文） */
function errorKindOf(error) {
  const message = String((error && error.message) || error || '')
  if (/ABORTED|abort/i.test(message)) return 'cancelled'
  if (/TIMEOUT|timed out/i.test(message)) return 'timeout'
  const http = message.match(/LLM_HTTP_(\d+)/)
  if (http) return 'http-' + http[1]
  if (/STREAM_INCOMPLETE/i.test(message)) return 'stream-incomplete'
  if (/CONTEXT_LENGTH|context length/i.test(message)) return 'context-length'
  if (/TASK_BUDGET|OUTPUT_LIMIT/i.test(message)) return 'budget'
  return 'error'
}

function createTelemetry(options) {
  const opts = options || {}
  const clock = opts.clock || nowMs
  const collector = opts.collector || new MetricsCollector({ clock: clock, maxSessions: opts.maxSessions })
  const repository = opts.repository || new SessionMetricsRepository({ collector: collector, clock: clock })
  return { collector: collector, repository: repository }
}

/**
 * 构造一个可被 PluginHost.mount 的 native cordis 插件。
 * 每次调用返回独立实例（独立 collector），供 apply 时创建。
 */
function createTelemetryPlugin() {
  return {
    name: 'core/runtime-telemetry',
    cordis: true,
    inject: ['contracts'],
    apply(ctx) {
      /* 每个 PluginHost 在 apply 时创建独立 runtime，多 host 互不污染 */
      const runtime = createTelemetry()
      const collector = runtime.collector
      const repository = runtime.repository

      /** 安全发事件：采集异常绝不能冒泡到真实执行路径 */
      function safe(event) {
        try { collector.record(event) } catch (error) { /* swallow by design */ }
      }

      /* ── 模型层：llm:request waterfall ─────────────────────── */
      function observeModelRequest(payload, next) {
        const meta = payload && payload.telemetry
        /* 没有 telemetry 标识 = 不是从 run-turn 正常入口进来的请求，
           不猜会话归属（避免并发串线），原样放行。 */
        if (not(meta) || not(meta.sessionId) || not(meta.requestId)) return next()

        const at = nowMs()
        const sessionId = String(meta.sessionId)
        const turnId = meta.turnId ? String(meta.turnId) : null
        const requestId = String(meta.requestId)

        safe({
          type: TELEMETRY_EVENTS.CONTEXT_ASSEMBLED,
          sessionId: sessionId, turnId: turnId, requestId: requestId, at: at,
          context: measureContext(payload.messages, payload.tools)
        })
        safe({
          type: TELEMETRY_EVENTS.MODEL_REQUEST_STARTED,
          sessionId: sessionId, turnId: turnId, requestId: requestId, at: at,
          step: meta.step === undefined ? null : meta.step,
          attempt: meta.attempt === undefined ? null : meta.attempt,
          model: meta.model || null,
          toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0
        })

        /* 包装 onDelta：只观测首个增量，原样转发，不吞、不改、不延迟。 */
        const original = typeof payload.onDelta === 'function' ? payload.onDelta : null
        let firstSeen = false
        if (original) {
          payload.onDelta = function wrappedOnDelta(delta) {
            if (!firstSeen && delta && (delta.type === 'content' || delta.type === 'thinking')) {
              firstSeen = true
              const deltaAt = nowMs()
              safe({
                type: TELEMETRY_EVENTS.MODEL_FIRST_DELTA,
                sessionId: sessionId, turnId: turnId, requestId: requestId, at: deltaAt,
                deltaType: delta.type, ttftMs: deltaAt - at
              })
            }
            return original(delta)
          }
        }

        return Promise.resolve(next()).then((result) => {
          const doneAt = nowMs()
          safe({
            type: TELEMETRY_EVENTS.MODEL_REQUEST_COMPLETED,
            sessionId: sessionId, turnId: turnId, requestId: requestId, at: doneAt,
            durationMs: doneAt - at,
            usage: (result && result.usage) || emptyUsage(),
            toolCallCount: (result && Array.isArray(result.toolCalls)) ? result.toolCalls.length : 0
          })
          return result
        }, (error) => {
          const failAt = nowMs()
          safe({
            type: TELEMETRY_EVENTS.MODEL_REQUEST_FAILED,
            sessionId: sessionId, turnId: turnId, requestId: requestId, at: failAt,
            durationMs: failAt - at,
            errorKind: errorKindOf(error),
            retryDecision: null
          })
          throw error
        })
      }

      /* ── 工具层：tools:execute waterfall（完全零侵入，只读 context） ── */
      function observeToolExecution(payload, next) {
        const context = payload && payload.context
        const agent = context && context.agent
        const sessionId = agent && agent.sessionId ? String(agent.sessionId) : null
        const toolCallId = context && context.toolCallId ? String(context.toolCallId) : null
        /* 缺任一关联标识就不猜，原样放行 */
        if (not(sessionId) || not(toolCallId)) return next()

        const turnId = agent.state && agent.state.execution ? String(agent.state.execution.id || '') : ''
        const at = nowMs()
        const toolName = String((payload && payload.name) || 'unknown')
        /* 从 collector 游标取当前 request，实现 request↔tool 关联 */
        const cursor = collector.cursor(sessionId)

        safe({
          type: TELEMETRY_EVENTS.TOOL_EXECUTION_STARTED,
          sessionId: sessionId, turnId: turnId || cursor.turnId, requestId: cursor.requestId,
          toolCallId: toolCallId, at: at, toolName: toolName
        })

        return Promise.resolve(next()).then((result) => {
          const doneAt = nowMs()
          safe({
            type: TELEMETRY_EVENTS.TOOL_EXECUTION_COMPLETED,
            sessionId: sessionId, turnId: turnId || cursor.turnId, requestId: cursor.requestId,
            toolCallId: toolCallId, at: doneAt, toolName: toolName,
            durationMs: doneAt - at,
            /* 只记字节数，不记内容 */
            resultBytes: typeof result === 'string' ? result.length : (result === undefined ? 0 : String(result).length)
          })
          return result
        }, (error) => {
          const failAt = nowMs()
          safe({
            type: TELEMETRY_EVENTS.TOOL_EXECUTION_FAILED,
            sessionId: sessionId, turnId: turnId || cursor.turnId, requestId: cursor.requestId,
            toolCallId: toolCallId, at: failAt, toolName: toolName,
            durationMs: failAt - at, errorKind: errorKindOf(error)
          })
          throw error
        })
      }

      /* ── turn 终态：复用 state:committed（agent.record 已广播） ─ */
      const TERMINAL_MAP = {
        'turn.completed': 'completed', 'turn.cancelled': 'cancelled', 'turn.failed': 'failed',
        'turn.exhausted': 'exhausted', 'turn.blocked': 'blocked',
        'turn.interrupted': 'interrupted', 'turn.timed_out': 'timed_out'
      }

      function observeCommitted(payload) {
        if (not(payload) || not(payload.event)) return
        const event = payload.event
        const sessionId = payload.sessionId ? String(payload.sessionId) : null
        if (not(sessionId)) return
        const execution = payload.execution || {}
        const turnId = execution.id ? String(execution.id) : null

        const status = TERMINAL_MAP[event.type]
        if (not(status) || not(turnId)) return
        safe({
          type: TELEMETRY_EVENTS.TURN_SETTLED,
          sessionId: sessionId, turnId: turnId, at: nowMs(),
          status: status, reason: String((event.data && event.data.reason) || '')
        })
        /* 会话结束即归档，Collector 释放后仍可回看 */
        try { repository.archive(sessionId) } catch (error) { /* ignore */ }
      }

      /* waterfall listener：注册即生效，fiber dispose 时由 Cordis 自动注销 */
      ctx.events.register('telemetry/model', 'llm:request', observeModelRequest, { prepend: true })
      ctx.events.register('telemetry/tool', 'tools:execute', observeToolExecution, { prepend: true })
      ctx.events.register('telemetry/state', 'state:committed', observeCommitted, {})

      ctx.effect(() => () => {
        /* 卸载时释放采集数据（需求：插件卸载后监听和数据正确清理） */
        collector.dispose()
        repository.clear()
      })

      ctx.provide('telemetry', {
        collector: collector,
        repository: repository,
        record: safe,
        get: (sessionId) => repository.get(sessionId),
        snapshot: () => collector.snapshot(),
        events: TELEMETRY_EVENTS,
        dataClass: DATA_CLASS
      })
    }
  }
}

module.exports = { createTelemetryPlugin, createTelemetry, errorKindOf }
