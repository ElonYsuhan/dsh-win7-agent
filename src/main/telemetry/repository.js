'use strict'

/**
 * Session Metrics Repository（第二阶段）
 *
 * 定位：Collector 的持久化/查询门面。Collector 是内存热路径，
 * Repository 负责按会话取用、导出、清理，以及"会话结束后仍可查"。
 *
 * 本阶段只做内存仓储（需求：不开发 UI、不改执行模型）。
 * 落盘留待后续阶段，接口已按可替换设计。
 */

const not = (value) => value ? false : true

class SessionMetricsRepository {
  constructor(options) {
    const opts = options || {}
    this.collector = opts.collector
    if (not(this.collector)) throw new TypeError('SessionMetricsRepository requires a collector')
    this.clock = opts.clock || (() => Date.now())
    /* 会话结束后的归档区：Collector 被 drop 后仍可查最近 N 条 */
    this.archiveLimit = Math.max(1, Number(opts.archiveLimit) || 32)
    this.archived = new Map()
    this.archivedOrder = []
  }

  /** 取某会话的实时指标（含正在累计的部分） */
  get(sessionId) {
    if (not(sessionId)) return null
    const live = this.collector.sessionMetrics(String(sessionId))
    if (live) return live
    return this.archived.get(String(sessionId)) || null
  }

  /** 会话是否已被本仓储知晓（含归档） */
  has(sessionId) {
    const key = String(sessionId || '')
    return this.collector.sessions.has(key) || this.archived.has(key)
  }

  /** 列出所有已知会话 id（实时 + 归档） */
  list() {
    const ids = new Set()
    for (const key of this.collector.sessions.keys()) ids.add(key)
    for (const key of this.archivedOrder) ids.add(key)
    return Array.from(ids)
  }

  /**
   * 归档一个已结束会话的汇总快照。
   * 由 turn.settled 之后调用，保证 Collector 释放后 UI 仍能回看。
   */
  archive(sessionId) {
    const key = String(sessionId || '')
    const metrics = this.collector.sessionMetrics(key)
    if (not(metrics)) return null
    /* 归档副本去掉逐请求明细的冗余，保留 turn 级汇总 + 请求摘要 */
    const snapshot = Object.assign({}, metrics, {
      archivedAt: this.clock(),
      turns: metrics.turns.map((turn) => Object.assign({}, turn, {
        requests: (turn.requests || []).map((r) => ({
          requestId: r.requestId, step: r.step, attempt: r.attempt, status: r.status,
          model: r.model, ttftMs: r.ttftMs, durationMs: r.durationMs, tps: r.tps,
          tpsDataClass: r.tpsDataClass,
          totalTokens: r.usage ? r.usage.totalTokens : null,
          cacheReadTokens: r.usage ? r.usage.cacheReadTokens : null,
          errorKind: r.errorKind, retryDecision: r.retryDecision,
          toolCallCount: r.toolCallCount
        }))
      }))
    })
    this.archived.set(key, snapshot)
    this.archivedOrder.push(key)
    while (this.archivedOrder.length > this.archiveLimit) {
      const oldest = this.archivedOrder.shift()
      if (oldest !== key) this.archived.delete(oldest)
    }
    return snapshot
  }

  /** 导出全部（供审查/落盘） */
  exportAll() {
    const out = { schemaVersion: 1, exportedAt: this.clock(), sessions: {} }
    for (const id of this.list()) {
      const metrics = this.get(id)
      if (metrics) out.sessions[id] = metrics
    }
    return out
  }

  /** 清理：会话关闭 / 插件卸载时调用 */
  remove(sessionId) {
    const key = String(sessionId || '')
    this.archived.delete(key)
    const index = this.archivedOrder.indexOf(key)
    if (index >= 0) this.archivedOrder.splice(index, 1)
    this.collector.drop(key)
    return true
  }

  clear() {
    this.archived.clear()
    this.archivedOrder.length = 0
  }
}

module.exports = { SessionMetricsRepository }
