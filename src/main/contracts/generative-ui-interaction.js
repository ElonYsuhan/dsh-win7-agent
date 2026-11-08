'use strict'

const UI = require('./generative-ui')
const VERSION = 1
const MAX_RECEIPTS = 1024
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const STATUSES = Object.freeze(['accepted', 'running', 'completed', 'cancelled', 'failed', 'interrupted', 'blocked', 'exhausted', 'timed_out'])
function fail(reason) { throw new Error('GENERATIVE_UI_INTERACTION_INVALID: ' + reason) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) }
function keys(value, names) {
  if (!object(value) || Object.keys(value).length !== names.length || names.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail('fields')
}
function id(value, request) { if (typeof value !== 'string' || !(request ? REQUEST_ID : ID).test(value) || RESERVED.has(value)) fail('identifier') }
function counter(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) fail('state version') }
function assertSession(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(value) || RESERVED.has(value)) fail('session') }
function assertRequest(request, operation) {
  if (operation === 'read') { keys(request, ['version', 'sessionId'].concat(request && request.surfaceId !== undefined ? ['surfaceId'] : [])); if (request.version !== VERSION) fail('version'); assertSession(request.sessionId); if (request.surfaceId !== undefined) id(request.surfaceId); return request }
  const names = ['version', 'sessionId', 'surfaceId', 'revision', 'expectedStateVersion', 'requestId', 'componentId']
  keys(request, names.concat(operation === 'change' ? ['value'] : ['actionId']))
  if (request.version !== VERSION || !['change', 'action'].includes(operation)) fail('version or operation')
  assertSession(request.sessionId); id(request.surfaceId); id(request.componentId); id(request.requestId, true)
  if (!Number.isSafeInteger(request.revision) || request.revision < 1 || request.revision > 10000) fail('revision')
  counter(request.expectedStateVersion)
  if (operation === 'action') id(request.actionId)
  else if (!(typeof request.value === 'boolean' || typeof request.value === 'number' && Number.isFinite(request.value) && Math.abs(request.value) <= 1e12 || typeof request.value === 'string' && request.value.length <= 2000)) fail('value')
  return request
}
function changeState(surface, state, componentId, value) {
  const component = surface.components.find(item => item.id === componentId)
  if (!component || !['slider', 'input', 'checkbox', 'filter', 'table', 'flow', 'map'].includes(component.type)) fail('editable component')
  const key = ['table', 'flow', 'map'].includes(component.type) ? component.selectionKey : component.stateKey
  if (!key) fail('component has no selection binding')
  const type = { slider: 'number', input: 'string', checkbox: 'boolean', filter: 'string', table: 'string', flow: 'string', map: 'string' }[component.type]
  if (typeof value !== type) fail('value type')
  const next = { ...state, [key]: value }
  UI.assertSurfaceState(surface, next)
  return next
}
function assertAggregate(value) {
  keys(value, ['version', 'sessionId', 'surfaces', 'receipts'])
  if (value.version !== VERSION) fail('aggregate version')
  if (value.sessionId !== '') assertSession(value.sessionId)
  if (!object(value.surfaces) || Object.keys(value.surfaces).length > UI.MAX_SURFACES_PER_CONVERSATION) fail('surfaces')
  for (const [key, entry] of Object.entries(value.surfaces)) {
    id(key); keys(entry, ['surface', 'stateVersion', 'state', 'lastChange'])
    UI.assertSurface(entry.surface); UI.assertSurfaceState(entry.surface, entry.state); counter(entry.stateVersion)
    if (entry.surface.id !== key) fail('surface identity')
    if (entry.lastChange !== null) {
      assertRequest(entry.lastChange, 'change')
      if (entry.lastChange.surfaceId !== key || entry.lastChange.revision !== entry.surface.revision || entry.lastChange.sessionId !== value.sessionId || entry.lastChange.expectedStateVersion + 1 !== entry.stateVersion) fail('last change')
      changeState(entry.surface, entry.state, entry.lastChange.componentId, entry.lastChange.value)
      const component = entry.surface.components.find(item => item.id === entry.lastChange.componentId)
      if (!Object.is(entry.state[component.selectionKey || component.stateKey], entry.lastChange.value)) fail('last change value')
    }
  }
  if (!object(value.receipts) || Object.keys(value.receipts).length > MAX_RECEIPTS) fail('receipts')
  for (const [key, receipt] of Object.entries(value.receipts)) {
    id(key, true); keys(receipt, ['request', 'message', 'values', 'status', 'turnId', 'reason', 'sequence'])
    assertRequest(receipt.request, 'action')
    if (receipt.request.requestId !== key || receipt.request.sessionId !== value.sessionId || !STATUSES.includes(receipt.status)) fail('receipt identity')
    if (typeof receipt.message !== 'string' || !receipt.message.trim() || receipt.message.length > 1000 || !object(receipt.values) || Object.keys(receipt.values).length > 32) fail('receipt data')
    for (const [name, item] of Object.entries(receipt.values)) {
      id(name)
      if (!(item === null || typeof item === 'boolean' || typeof item === 'string' && item.length <= 2000 || typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e12)) fail('receipt value')
    }
    if (typeof receipt.turnId !== 'string' || receipt.turnId.length > 256 || typeof receipt.reason !== 'string' || receipt.reason.length > 2000 || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) fail('receipt status')
    if (receipt.status === 'accepted' && receipt.turnId !== '' || receipt.status === 'running' && !receipt.turnId) fail('receipt turn')
  }
  return value
}
function own(values, key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined }
function empty() { return { version: VERSION, sessionId: '', surfaces: {}, receipts: {} } }
function entry(surface) { return { surface, stateVersion: 0, state: { ...surface.state }, lastChange: null } }
function hasUnsupported(messages, surfaceId) {
  return messages.some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(part => part && part.type === 'ui' && part.surface.id === surfaceId && !UI.VERSIONS.includes(part.surface.version)))
}
function activeEntry(state, surfaceId) {
  if (hasUnsupported(state.messages, surfaceId)) throw new Error('STATE_UI_VERSION_UNSUPPORTED')
  const value = state.ui && own(state.ui.surfaces, surfaceId)
  const published = UI.latest(state.messages, surfaceId)
  if (!value || !published || JSON.stringify(published) !== JSON.stringify(value.surface)) throw new Error('STATE_UI_NOT_AUTHORITATIVE')
  return value
}
function sameRequest(a, b) { return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.is(a[key], b[key])) }
function snapshot(state, sessionId) {
  const surfaces = {}, receipts = []
  for (const [key, value] of Object.entries(state.ui.surfaces)) {
    try { activeEntry(state, key) } catch (_) { continue }
    surfaces[key] = { revision: value.surface.revision, stateVersion: value.stateVersion, state: value.state }
  }
  for (const [requestId, receipt] of Object.entries(state.ui.receipts)) receipts.push({ requestId, surfaceId: receipt.request.surfaceId, revision: receipt.request.revision, actionId: receipt.request.actionId, status: receipt.status, reason: receipt.reason, sequence: receipt.sequence })
  return { version: VERSION, sessionId, sequence: state.sequence, running: state.execution.status === 'running', surfaces, receipts, definitions: {} }
}
function assertSnapshot(value) {
  keys(value, ['version', 'sessionId', 'sequence', 'running', 'surfaces', 'receipts', 'definitions'])
  if (value.version !== VERSION || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.running !== 'boolean') fail('snapshot version or sequence')
  assertSession(value.sessionId)
  if (!object(value.surfaces) || Object.keys(value.surfaces).length > UI.MAX_SURFACES_PER_CONVERSATION || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) fail('snapshot bounds')
  for (const [key, entry] of Object.entries(value.surfaces)) {
    id(key); keys(entry, ['revision', 'stateVersion', 'state']); counter(entry.stateVersion)
    if (!Number.isInteger(entry.revision) || entry.revision < 1 || entry.revision > 10000 || !object(entry.state) || Object.keys(entry.state).length > 32) fail('snapshot state')
    for (const [name, item] of Object.entries(entry.state)) {
      id(name)
      if (!(item === null || typeof item === 'boolean' || typeof item === 'string' && item.length <= 2000 || typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e12)) fail('snapshot value')
    }
  }
  if (!object(value.definitions) || Object.keys(value.definitions).length > UI.MAX_SURFACES_PER_CONVERSATION) fail('snapshot definitions')
  for (const [key, surface] of Object.entries(value.definitions)) {
    id(key); UI.assertSurface(surface)
    if (surface.id !== key || !own(value.surfaces, key) || own(value.surfaces, key).revision !== surface.revision) fail('snapshot definition identity')
  }
  const ids = new Set()
  for (const receipt of value.receipts) {
    keys(receipt, ['requestId', 'surfaceId', 'revision', 'actionId', 'status', 'reason', 'sequence'])
    id(receipt.requestId, true); id(receipt.surfaceId); id(receipt.actionId)
    if (ids.has(receipt.requestId) || !STATUSES.includes(receipt.status) || typeof receipt.reason !== 'string' || receipt.reason.length > 2000 || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || receipt.sequence > value.sequence || !Number.isInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > 10000) fail('snapshot receipt')
    ids.add(receipt.requestId)
  }
  return value
}
module.exports = { VERSION, MAX_RECEIPTS, STATUSES, assertSnapshot, assertRequest, assertAggregate, changeState, own, empty, entry, hasUnsupported, activeEntry, sameRequest, snapshot }
