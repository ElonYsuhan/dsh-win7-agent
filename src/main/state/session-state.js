'use strict'

const { VERSION, EVENTS, TERMINAL_EVENTS, assertEvent, assertMessage } = require('../contracts')
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
  return seal({ stateVersion: VERSION, sequence: 0, messages: [], memory: null,
    execution: { status: 'idle', phase: 'idle', id: '', step: 0, attempt: 0, activeTool: null, reason: '', maxSteps: 0, deniedCount: 0, toolsEnabled: true, lastError: '' } })
}
function reduce(state, event) {
  assertEvent(event)
  if (event.sequence !== state.sequence + 1) throw new Error('STATE_SEQUENCE_GAP: ' + event.sequence)
  const next = { ...state, sequence: event.sequence, execution: { ...state.execution } }
  const data = event.data
  const execution = next.execution
  const running = state.execution.status === 'running'
  if ([EVENTS.STEP, EVENTS.REQUEST, EVENTS.REQUEST_FAILED, EVENTS.TOOLS_DISABLED, EVENTS.TOOL_START, EVENTS.TOOL_END].includes(event.type) || TERMINAL_EVENTS.includes(event.type)) {
    if (!running) throw new Error('STATE_INVALID_TRANSITION: ' + state.execution.status + ' -> ' + event.type)
  }
  switch (event.type) {
    case EVENTS.HISTORY: next.messages = copy(data.messages); break
    case EVENTS.MESSAGE:
      next.messages = state.messages.concat([copy(data.message)])
      if (data.message.role === 'assistant') execution.lastError = ''
      break
    case EVENTS.MEMORY: next.memory = copy(data.memory); break
    case EVENTS.START:
      if (running) throw new Error('STATE_TURN_BUSY')
      next.execution = { status: 'running', phase: 'preparing', id: data.id, maxSteps: data.maxSteps, step: 0, attempt: 0, activeTool: null, reason: '', deniedCount: 0, toolsEnabled: true, lastError: '' }
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
  if (snapshot.sequence !== undefined) {
    if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Error('STATE_SEQUENCE_INVALID')
    state.sequence = snapshot.sequence
  }
  return seal(state)
}
function release(state) { return seal({ ...state, messages: [], memory: null }) }
module.exports = { initial, reduce, restore, release, STATUS }
