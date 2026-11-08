'use strict'

const { EVENTS } = require('../contracts')
const UI = require('../contracts/generative-ui-interaction')
const surfaces = require('../contracts/generative-ui')
const { actionPrompt } = require('../flow/generative-ui-policy')

function createGenerativeUiService(ctx) {
  const active = new Set()
  let disposing = false
  function acquire(pool, request, operation) {
    UI.assertRequest(request, operation)
    if (disposing || (pool.settings.data.disabledPlugins || []).includes('core/generative-ui')) throw new Error('GENERATIVE_UI_DISABLED')
    ctx.licensing.assert(operation === 'action' ? 'chat' : 'all')
    const worker = pool.acquire(request.sessionId)
    if (worker.sessionId !== request.sessionId || worker.unattended) throw new Error('STATE_UI_SESSION_MISMATCH')
    if (!pool.isRunning(request.sessionId)) {
      worker.state = ctx.sessions.load(worker)
      if (worker.running) worker.record(EVENTS.INTERRUPT, { reason: 'recovered unfinished turn; UI action is not replayed' })
      for (const [requestId, receipt] of Object.entries(worker.state.ui.receipts)) {
        if (receipt.status === 'accepted') worker.record(EVENTS.UI_ACTION_ABANDON, { requestId, reason: 'execution was not confirmed; manual submission is required' })
      }
    }
    return worker
  }
  function snapshot(worker) { return UI.snapshot(worker.state, worker.sessionId) }
  function notify(worker) {
    const value = snapshot(worker)
    try { worker.emit({ type: 'ui:interaction', snapshot: value }) } catch (_) {}
    return value
  }
  function settleUnstarted(pool, worker, requestId, reason) {
    if (pool.isRunning(worker.sessionId)) return
    const recovered = ctx.sessions.load(worker), receipt = UI.own(recovered.ui.receipts, requestId)
    if (!receipt || !['accepted', 'running'].includes(receipt.status)) return
    worker.state = recovered
    try {
      if (worker.running) worker.record(EVENTS.INTERRUPT, { reason: 'UI action execution interrupted' })
      const current = UI.own(worker.state.ui.receipts, requestId)
      if (current.status === 'accepted') worker.record(EVENTS.UI_ACTION_ABANDON, { requestId, reason })
      notify(worker)
    } finally { worker.releaseConversation() }
  }
  const service = {
    read(pool, request) {
      const worker = acquire(pool, request, 'read'), value = snapshot(worker)
      if (request.surfaceId && UI.own(value.surfaces, request.surfaceId)) value.definitions[request.surfaceId] = UI.own(worker.state.ui.surfaces, request.surfaceId).surface
      return value
    },
    change(pool, request) {
      const worker = acquire(pool, request, 'change')
      const previous = UI.own(worker.state.ui.surfaces, request.surfaceId)
      if (previous && previous.lastChange && UI.sameRequest(previous.lastChange, request)) return snapshot(worker)
      worker.record(EVENTS.UI_CHANGE, request)
      return notify(worker)
    },
    dispatch(pool, request, uiCapabilities) {
      surfaces.negotiate(uiCapabilities)
      const worker = acquire(pool, request, 'action')
      const existing = UI.own(worker.state.ui.receipts, request.requestId)
      if (existing) {
        if (!UI.sameRequest(existing.request, request)) throw new Error('STATE_UI_REQUEST_ID_REUSED')
        return { snapshot: snapshot(worker), receipt: existing, started: false }
      }
      if (pool.isRunning(request.sessionId)) throw new Error('SESSION_BUSY')
      if (pool.isFull()) throw new Error('POOL_BUSY')
      worker.record(EVENTS.UI_ACTION, request)
      const receipt = UI.own(worker.state.ui.receipts, request.requestId)
      const accepted = notify(worker)
      const ticket = { worker, controller: new AbortController(), done: null }
      ticket.done = pool.run(request.sessionId, actionPrompt(receipt), undefined, undefined, undefined, undefined, request.requestId, ticket.controller.signal, uiCapabilities).then(() => {
        settleUnstarted(pool, worker, request.requestId, 'execution did not start; automatic replay is forbidden')
      }, error => {
        settleUnstarted(pool, worker, request.requestId, 'unable to start action: ' + String(error.message).slice(0, 1800))
        worker.emit({ type: 'error', message: String(error.message || error) })
      }).catch(error => ctx.logger.warn(error)).finally(() => active.delete(ticket))
      active.add(ticket)
      return { snapshot: accepted, receipt, started: true }
    }
  }
  ctx.effect(() => async () => {
    disposing = true
    for (const ticket of active) { ticket.controller.abort(); ticket.worker.abort() }
    await Promise.all(Array.from(active, ticket => ticket.done))
  })
  return service
}
module.exports = { createGenerativeUiService }
