'use strict'

const { VERSION, EVENTS, TERMINAL_EVENTS, assertEvent, assertMessage } = require('../contracts')
const generativeUI = require('../contracts/generative-ui')
const interaction = require('../contracts/generative-ui-interaction')
const STATUS = Object.freeze({
  [EVENTS.COMPLETE]: 'completed', [EVENTS.CANCEL]: 'cancelled', [EVENTS.FAIL]: 'failed',
  [EVENTS.EXHAUST]: 'exhausted', [EVENTS.BLOCK]: 'blocked', [EVENTS.INTERRUPT]: 'interrupted', [EVENTS.TIMEOUT]: 'timed_out'
})
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}
function copy(value) { return JSON.parse(JSON.stringify(value)) }
function seal(state) { return freeze(state) }
function initial() {
  return seal({ stateVersion: VERSION, sequence: 0, messages: [], memory: null, ui: interaction.empty(),
    execution: { status: 'idle', phase: 'idle', id: '', step: 0, attempt: 0, activeTool: null, reason: '', maxSteps: 0, deniedCount: 0, toolsEnabled: true, lastError: '' } })
}
function reduce(state, event) {
  assertEvent(event)
  if (event.sequence !== state.sequence + 1) throw new Error('STATE_SEQUENCE_GAP: ' + event.sequence)
  const next = { ...state, sequence: event.sequence, execution: { ...state.execution } }
  const data = event.data
  const execution = next.execution
  const running = state.execution.status === 'running'
  if ([EVENTS.STEP, EVENTS.REQUEST, EVENTS.REQUEST_FAILED, EVENTS.TOOLS_DISABLED, EVENTS.TOOL_START, EVENTS.TOOL_END, EVENTS.UI_SURFACE].includes(event.type) || TERMINAL_EVENTS.includes(event.type)) {
    if (!running) throw new Error('STATE_INVALID_TRANSITION: ' + state.execution.status + ' -> ' + event.type)
  }
  switch (event.type) {
    case EVENTS.HISTORY:
      next.messages = copy(data.messages)
      if (!data.messages.length) next.ui = { ...state.ui, surfaces: {} }
      break
    case EVENTS.MESSAGE:
      next.messages = state.messages.concat([copy(data.message)])
      if (data.message.role === 'assistant') execution.lastError = ''
      break
    case EVENTS.UI_SURFACE: {
      const active = execution.activeTool
      if (!active || active.id !== data.toolCallId || !['render_ui', 'update_ui'].includes(active.name) || (active.name === 'update_ui' && data.operation !== 'update')) throw new Error('STATE_UI_TOOL_MISMATCH')
      const previous = interaction.own(state.ui.surfaces, data.surface.id) ? interaction.own(state.ui.surfaces, data.surface.id).surface : generativeUI.latest(state.messages, data.surface.id)
      if (interaction.hasUnsupported(state.messages, data.surface.id) || previous && !generativeUI.VERSIONS.includes(previous.version)) throw new Error('STATE_UI_VERSION_UNSUPPORTED')
      if ((previous ? previous.revision : 0) !== data.expectedRevision) throw new Error('STATE_UI_REVISION_CONFLICT')
      if ((!interaction.own(state.ui.surfaces, data.surface.id) && Object.keys(state.ui.surfaces).length >= generativeUI.MAX_SURFACES_PER_CONVERSATION) || data.operation === 'create' && generativeUI.countSurfaces(state.messages) >= generativeUI.MAX_SURFACES_PER_CONVERSATION) throw new Error('STATE_UI_SURFACE_LIMIT')
      let target = -1
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        const message = state.messages[i]
        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.some(call => call.id === active.id && call.function && call.function.name === active.name)) { target = i; break }
      }
      if (target < 0) throw new Error('STATE_UI_MISSING_TOOL_CALL')
      const message = state.messages[target]
      const content = Array.isArray(message.content) ? message.content.slice() : (message.content ? [{ type: 'text', text: message.content }] : [])
      if (content.some(part => part && part.type === 'ui' && part.toolCallId === active.id)) throw new Error('STATE_UI_ALREADY_PUBLISHED')
      content.push({ type: 'ui', toolCallId: active.id, surface: copy(data.surface) })
      next.messages = state.messages.map((item, index) => index === target ? { ...item, content } : item)
      next.ui = { ...state.ui, surfaces: { ...state.ui.surfaces, [data.surface.id]: interaction.entry(copy(data.surface)) } }
      break
    }
    case EVENTS.UI_CHANGE: case EVENTS.UI_ACTION: {
      if (state.ui.sessionId && state.ui.sessionId !== data.sessionId) throw new Error('STATE_UI_SESSION_MISMATCH')
      const entry = interaction.activeEntry(state, data.surfaceId)
      if (entry.surface.revision !== data.revision) throw new Error('STATE_UI_REVISION_CONFLICT')
      if (event.type === EVENTS.UI_CHANGE && entry.lastChange && interaction.sameRequest(entry.lastChange, data)) throw new Error('STATE_UI_DUPLICATE_CHANGE')
      if (event.type === EVENTS.UI_ACTION && interaction.own(state.ui.receipts, data.requestId)) throw new Error('STATE_UI_DUPLICATE_ACTION')
      if (entry.stateVersion !== data.expectedStateVersion) throw new Error('STATE_UI_STATE_CONFLICT')
      next.ui = { ...state.ui, sessionId: data.sessionId }
      if (event.type === EVENTS.UI_CHANGE) {
        if (entry.stateVersion >= 1000000) throw new Error('STATE_UI_CHANGE_LIMIT')
        const values = interaction.changeState(entry.surface, entry.state, data.componentId, data.value)
        next.ui.surfaces = { ...state.ui.surfaces, [data.surfaceId]: { ...entry, state: values, stateVersion: entry.stateVersion + 1, lastChange: copy(data) } }
      } else {
        if (running) throw new Error('STATE_TURN_BUSY')
        if (Object.keys(state.ui.receipts).length >= interaction.MAX_RECEIPTS) throw new Error('STATE_UI_ACTION_LIMIT')
        const button = entry.surface.components.find(item => item.id === data.componentId)
        if (!button || button.type !== 'button' || button.actionId !== data.actionId) throw new Error('STATE_UI_ACTION_MISMATCH')
        const action = entry.surface.actions.find(item => item.id === data.actionId)
        const values = Object.fromEntries(action.stateKeys.map(key => [key, entry.state[key]]))
        const receipt = { request: copy(data), message: action.message, values, status: 'accepted', turnId: '', reason: '', sequence: event.sequence }
        next.ui.receipts = { ...state.ui.receipts, [data.requestId]: receipt }
      }
      break
    }
    case EVENTS.UI_ACTION_ABANDON: {
      const receipt = interaction.own(state.ui.receipts, data.requestId)
      if (!receipt || receipt.status !== 'accepted' || running) throw new Error('STATE_UI_ACTION_NOT_PENDING')
      next.ui = { ...state.ui, receipts: { ...state.ui.receipts, [data.requestId]: { ...receipt, status: 'interrupted', reason: data.reason } } }
      break
    }
    case EVENTS.MEMORY: next.memory = copy(data.memory); break
    case EVENTS.START:
      if (running) throw new Error('STATE_TURN_BUSY')
      if (data.uiActionId !== undefined) {
        const receipt = interaction.own(state.ui.receipts, data.uiActionId)
        if (!receipt || receipt.status !== 'accepted') throw new Error('STATE_UI_ACTION_NOT_PENDING')
        next.ui = { ...state.ui, receipts: { ...state.ui.receipts, [data.uiActionId]: { ...receipt, status: 'running', turnId: data.id } } }
      }
      next.execution = { ...(data.uiActionId ? { uiActionId: data.uiActionId } : {}), status: 'running', phase: 'preparing', id: data.id, startedAt: event.at, maxSteps: data.maxSteps, step: 0, attempt: 0, activeTool: null, reason: '', deniedCount: 0, toolsEnabled: true, lastError: '' }
      break
    case EVENTS.STEP:
      if (execution.activeTool || execution.step >= execution.maxSteps) throw new Error('STATE_STEP_LIMIT')
      execution.step += 1; execution.attempt = 0; execution.phase = 'model'; break
    case EVENTS.REQUEST:
      if (execution.step === 0 || execution.activeTool) throw new Error('STATE_REQUEST_WITHOUT_STEP')
      execution.attempt += 1; execution.phase = 'model'; break
    case EVENTS.REQUEST_FAILED:
      if (execution.attempt === 0) throw new Error('STATE_FAILURE_WITHOUT_REQUEST')
      execution.lastError = data.reason; break
    case EVENTS.TOOLS_DISABLED:
      execution.toolsEnabled = false; break
    case EVENTS.TOOL_START:
      if (execution.activeTool || execution.step === 0 || execution.attempt === 0) throw new Error('STATE_TOOL_BUSY')
      execution.activeTool = { id: data.id, name: data.name }; execution.phase = 'tool'; break
    case EVENTS.TOOL_END:
      if (!execution.activeTool || execution.activeTool.id !== data.id || execution.activeTool.name !== data.name) throw new Error('STATE_TOOL_RESULT_MISMATCH')
      execution.activeTool = null; execution.phase = 'continuing'
      execution.deniedCount = data.outcome === 'denied' ? execution.deniedCount + 1 : 0
      break
    default:
      execution.status = STATUS[event.type]; execution.phase = 'settled'; execution.activeTool = null
      execution.reason = String(data.reason || ''); execution.endedAt = event.at
      if (execution.uiActionId) {
        const receipt = interaction.own(state.ui.receipts, execution.uiActionId)
        if (!receipt || receipt.status !== 'running' || receipt.turnId !== execution.id) throw new Error('STATE_UI_ACTION_TURN_MISMATCH')
        next.ui = { ...state.ui, receipts: { ...state.ui.receipts, [execution.uiActionId]: { ...receipt, status: execution.status, reason: execution.reason.slice(0, 2000) } } }
      }
  }
  return seal(next)
}
function restore(snapshot) {
  const base = initial()
  const state = { ...base, execution: { ...base.execution } }
  if (!snapshot) return seal(state)
  if (snapshot.version !== undefined && ![1, 2].includes(snapshot.version)) throw new Error('SESSION_VERSION_UNSUPPORTED')
  if (snapshot.stateVersion !== undefined && snapshot.stateVersion !== VERSION) throw new Error('STATE_VERSION_UNSUPPORTED')
  if (!Array.isArray(snapshot.messages)) throw new Error('STATE_MESSAGES_INVALID')
  snapshot.messages.forEach(assertMessage)
  if (snapshot.memory !== null && snapshot.memory !== undefined && typeof snapshot.memory.text !== 'string') throw new Error('STATE_MEMORY_INVALID')
  state.messages = copy(snapshot.messages)
  state.memory = copy(snapshot.memory || null)
  if (snapshot.execution) {
    if (!['idle', 'running', ...Object.values(STATUS)].includes(snapshot.execution.status)) throw new Error('STATE_STATUS_INVALID')
    const saved = snapshot.execution
    if (!Number.isInteger(saved.step) || saved.step < 0 || !Number.isInteger(saved.attempt) || saved.attempt < 0 || !Number.isInteger(saved.maxSteps) || saved.maxSteps < saved.step) throw new Error('STATE_PROGRESS_INVALID')
    if (!['idle', 'preparing', 'model', 'tool', 'continuing', 'settled'].includes(saved.phase)) throw new Error('STATE_PHASE_INVALID')
    if (saved.deniedCount !== undefined && (!Number.isInteger(saved.deniedCount) || saved.deniedCount < 0)) throw new Error('STATE_DENIAL_COUNT_INVALID')
    if (saved.toolsEnabled !== undefined && typeof saved.toolsEnabled !== 'boolean') throw new Error('STATE_TOOLS_FLAG_INVALID')
    if (saved.activeTool !== null && (!saved.activeTool || typeof saved.activeTool.id !== 'string' || typeof saved.activeTool.name !== 'string')) throw new Error('STATE_ACTIVE_TOOL_INVALID')
    state.execution = { ...state.execution, ...copy(saved) }
  }
  if (snapshot.ui !== undefined) state.ui = copy(interaction.assertAggregate(snapshot.ui))
  else {
    const surfaces = {}
    for (const message of state.messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const part of message.content) if (part && part.type === 'ui' && generativeUI.VERSIONS.includes(part.surface.version)) surfaces[part.surface.id] = interaction.entry(copy(part.surface))
    }
    state.ui = { ...interaction.empty(), surfaces }
    interaction.assertAggregate(state.ui)
  }
  if (state.execution.uiActionId) {
    const receipt = interaction.own(state.ui.receipts, state.execution.uiActionId)
    if (!receipt || receipt.turnId !== state.execution.id || receipt.status !== state.execution.status) throw new Error('STATE_UI_ACTION_TURN_MISMATCH')
  }
  for (const [requestId, receipt] of Object.entries(state.ui.receipts)) {
    if (receipt.status === 'running' && (state.execution.status !== 'running' || state.execution.uiActionId !== requestId || state.execution.id !== receipt.turnId)) throw new Error('STATE_UI_ACTION_TURN_MISMATCH')
  }
  if (snapshot.sequence !== undefined) {
    if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Error('STATE_SEQUENCE_INVALID')
    state.sequence = snapshot.sequence
  }
  return seal(state)
}
function release(state) {
  const execution = { ...state.execution }
  delete execution.uiActionId
  return seal({ ...state, execution, messages: [], memory: null, ui: interaction.empty() })
}
module.exports = { initial, reduce, restore, release, STATUS }
