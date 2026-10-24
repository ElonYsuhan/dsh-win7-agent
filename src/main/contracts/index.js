'use strict'

// Protocol vocabulary is independent of Cordis, IO and concrete implementations.
const VERSION = 1
const EVENTS = Object.freeze({
  HISTORY: 'history.replaced', MESSAGE: 'message.appended', MEMORY: 'memory.updated',
  START: 'turn.started', STEP: 'step.started', REQUEST: 'request.started', REQUEST_FAILED: 'request.failed', TOOLS_DISABLED: 'model.tools_disabled',
  TOOL_START: 'tool.started', TOOL_END: 'tool.settled',
  COMPLETE: 'turn.completed', CANCEL: 'turn.cancelled', FAIL: 'turn.failed',
  EXHAUST: 'turn.exhausted', BLOCK: 'turn.blocked', INTERRUPT: 'turn.interrupted', TIMEOUT: 'turn.timed_out'
})
const TERMINAL_EVENTS = Object.freeze([EVENTS.COMPLETE, EVENTS.CANCEL, EVENTS.FAIL, EVENTS.EXHAUST, EVENTS.BLOCK, EVENTS.INTERRUPT, EVENTS.TIMEOUT])
const SERVICES = Object.freeze({
  licensing: ['status', 'request', 'activate', 'startTrial', 'assert'],
  contracts: ['assertEvent', 'assertModelResult', 'assertTool', 'assertArguments', 'assertDecision', 'assertLimits', 'assertService', 'sanitizeHistory'],
  flow: ['limits', 'retry', 'next', 'normalizeCalls', 'outcome', 'systemPrompt'],
  state: ['initial', 'reduce', 'restore', 'release'],
  sessions: ['save', 'load', 'append'], llm: ['request'], agentLoop: ['run'],
  tools: ['register', 'execute', 'definitions', 'get', 'list'], prompts: ['add', 'build'],
  skillLibrary: ['list', 'read', 'search', 'prompt'],
  tasks: ['attach', 'list', 'preview', 'save', 'remove', 'run', 'stop', 'conversation', 'close'],
  mcp: ['ready', 'reload', 'status', 'test'],
  skills: ['transformContent'], memory: ['compact', 'ensureContextBudget', 'summarizeBatch', 'mergeMemory', 'runCompaction'],
  context: ['buildContextView', 'buildPayloadMessages', 'resolveBudget', 'isContextLengthError', 'serializeMessages', 'batchMessages', 'buildLocalMemory', 'findCompactionBoundary', 'estimateMessagesTokens']
})
function fail(message) { throw new Error('CONTRACT_INVALID: ' + message) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function assertMessage(message) {
  if (!object(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) fail('message.role')
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) fail('message.content')
  if (message.role === 'tool' && typeof message.tool_call_id !== 'string') fail('message.tool_call_id')
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) fail('message.tool_calls')
  return message
}
function assertEvent(event) {
  if (!object(event) || event.version !== VERSION || !Object.values(EVENTS).includes(event.type)) fail('event type/version')
  if (!Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) fail('event sequence/time')
  if (!object(event.data)) fail('event.data')
  const data = event.data
  if (event.type === EVENTS.HISTORY) {
    if (!Array.isArray(data.messages)) fail('history.messages')
    data.messages.forEach(assertMessage)
  }
  if (event.type === EVENTS.MESSAGE) assertMessage(data.message)
  if (event.type === EVENTS.MEMORY && data.memory !== null && (!object(data.memory) || typeof data.memory.text !== 'string')) fail('memory')
  if (event.type === EVENTS.START && (typeof data.id !== 'string' || !data.id || !Number.isInteger(data.maxSteps) || data.maxSteps < 1)) fail('turn.started')
  if ([EVENTS.TOOL_START, EVENTS.TOOL_END].includes(event.type) && (typeof data.id !== 'string' || typeof data.name !== 'string')) fail('tool identity')
  if (event.type === EVENTS.REQUEST_FAILED && (typeof data.reason !== 'string' || !['stop', 'compact', 'without-tools'].includes(data.decision))) fail('request.failed')
  if (event.type === EVENTS.TOOL_END && !['success', 'denied', 'disabled', 'error', 'cancelled'].includes(data.outcome)) fail('tool outcome')
  if (event.type === EVENTS.MESSAGE && data.message.role === 'assistant' && Array.isArray(data.message.tool_calls)) {
    const ids = new Set()
    for (const call of data.message.tool_calls) {
      if (!call || typeof call.id !== 'string' || ids.has(call.id)) fail('assistant tool call identity')
      ids.add(call.id)
    }
  }
  return event
}
function assertModelResult(result) {
  const ids = new Set()
  if (!object(result)) fail('model result')
  if (result.content !== undefined && result.content !== null && typeof result.content !== 'string') fail('model content')
  if (result.toolCalls !== undefined) {
    if (!Array.isArray(result.toolCalls)) fail('model toolCalls')
    for (const call of result.toolCalls) {
      if (!object(call)) fail('model tool call')
      if (call.id && ids.has(call.id)) fail('duplicate model tool call id')
      if (call.id) ids.add(call.id)
      if (!object(call) || !object(call.function) || typeof call.function.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') fail('model tool call')
    }
  }
  return result
}
function assertTool(tool) {
  if (!object(tool) || typeof tool.name !== 'string' || !tool.name || typeof tool.execute !== 'function') fail('tool definition')
  if (tool.permission !== undefined && !['read', 'write', 'edit', 'command'].includes(tool.permission)) fail('tool.permission')
  if (tool.parameters !== undefined && !object(tool.parameters)) fail('tool.parameters')
  return tool
}
// Runtime checks for the JSON Schema subset used by local tools. This does not
// attempt remote $ref resolution or claim to implement the entire specification.
function assertArguments(schema, value, location, depth) {
  location = location || 'arguments'
  depth = depth || 0
  if (depth > 64) fail(location + ' nesting limit')
  if (!schema || typeof schema !== 'object') return value
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type])
  const matches = (type) => type === 'null' ? value === null : type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type
  if (types.length && !types.some(matches)) fail(location + ' expected ' + types.join('|'))
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) fail(location + ' enum')
  if (object(value)) {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(location + '.' + key + ' required')
    for (const key of Object.keys(value)) {
      const child = schema.properties && schema.properties[key]
      if (child) assertArguments(child, value[key], location + '.' + key, depth + 1)
      else if (schema.additionalProperties === false) fail(location + '.' + key + ' unexpected')
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => assertArguments(schema.items, item, location + '[' + index + ']', depth + 1))
  return value
}
const EVENT_MODES = Object.freeze({ 'llm:request': 'waterfall', 'tools:execute': 'waterfall', 'state:committed': 'parallel' })
function assertDecision(value, allowed) {
  if (!allowed.includes(value)) fail('flow decision ' + value)
  return value
}
function assertLimits(limits) {
  if (!object(limits)) fail('flow limits')
  for (const [name, min, max] of [['maxSteps', 1, 500], ['maxAttempts', 1, 64], ['maxDenied', 1, 64], ['turnTimeoutMs', 0, 86400000]]) {
    if (!Number.isInteger(limits[name]) || limits[name] < min || limits[name] > max) fail('flow limits.' + name)
  }
  return limits
}
function assertService(name, service) {
  if (name === 'contracts' && service && service.VERSION !== VERSION) fail('contracts.VERSION')
  if (!service) fail('missing service ' + name)
  for (const method of SERVICES[name] || []) if (typeof service[method] !== 'function') fail(name + '.' + method)
  return service
}
const { sanitizeHistory } = require('./history')
module.exports = { sanitizeHistory, EVENT_MODES, assertDecision, assertLimits, VERSION, EVENTS, TERMINAL_EVENTS, SERVICES, assertMessage, assertEvent, assertModelResult, assertTool, assertArguments, assertService }
