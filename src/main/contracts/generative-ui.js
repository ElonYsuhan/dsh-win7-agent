'use strict'

// Declarative, provider- and renderer-independent UI data. This module never
// evaluates expressions, HTML, scripts, URLs, or tool names.
const VERSION = 2
const VERSIONS = Object.freeze([1, 2])
const LEGACY_COMPONENTS = Object.freeze(['column', 'row', 'form', 'input', 'checkbox', 'text', 'slider', 'chart', 'button'])
const COMPONENTS = Object.freeze([...LEGACY_COMPONENTS, 'table', 'filter', 'progress', 'flow', 'map', 'visual'])
const STATUSES = Object.freeze(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'])
const MAX_SURFACE_CHARS = 48000
const MAX_COMPONENTS = 64
const MAX_SURFACES_PER_CONVERSATION = 128
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

function fail(message) { throw new Error('GENERATIVE_UI_INVALID: ' + message) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) }
function keys(value, allowed, required, label) {
  if (!object(value)) fail(label + ' must be an object')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(label + '.' + key + ' is not allowed')
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(label + '.' + key + ' is required')
}
function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || RESERVED.has(value)) fail(label + ' is not a valid identifier')
}
function text(value, max, label, empty) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(label + ' is invalid')
}
function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) fail(label + ' is not a bounded number')
}
function primitive(value, label) {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') return text(value, 2000, label, true)
  return number(value, label)
}
function array(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(label + ' length is invalid')
}
function assertJson(value, label) {
  const stack = [{ value, depth: 0 }], visited = new Set()
  let count = 0
  while (stack.length) {
    const item = stack.pop(), current = item.value
    if (++count > 8192 || item.depth > 32) fail(label + ' nesting or item limit')
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number' && Number.isFinite(current)) continue
    if (!current || typeof current !== 'object' || (!Array.isArray(current) && !object(current)) || visited.has(current)) fail(label + ' must contain plain JSON')
    visited.add(current)
    for (const key of Object.keys(current)) {
      if (RESERVED.has(key)) fail(label + ' contains a reserved key')
      stack.push({ value: current[key], depth: item.depth + 1 })
    }
  }
}
function size(value, label) {
  assertJson(value, label)
  let serialized
  try { serialized = JSON.stringify(value) } catch (_) { fail(label + ' is not JSON serializable') }
  if (typeof serialized !== 'string' || serialized.length > MAX_SURFACE_CHARS) fail(label + ' exceeds the size limit')
}
function uniqueIds(list, label) {
  const ids = new Set()
  for (const item of list) {
    if (!object(item)) fail(label + ' entry must be an object')
    identifier(item.id, label + '.id')
    if (ids.has(item.id)) fail(label + ' contains duplicate id')
    ids.add(item.id)
  }
}
function assertSurface(surface) {
  size(surface, 'surface')
  return assertSurfaceShape(surface)
}
function assertSurfaceShape(surface) {
  keys(surface, ['version', 'id', 'revision', 'title', 'root', 'state', 'components', 'actions'], ['version', 'id', 'revision', 'title', 'root', 'state', 'components', 'actions'], 'surface')
  if (!VERSIONS.includes(surface.version)) fail('unsupported surface version')
  identifier(surface.id, 'surface.id')
  if (!Number.isSafeInteger(surface.revision) || surface.revision < 1 || surface.revision > 10000) fail('surface.revision is invalid')
  text(surface.title, 200, 'surface.title', false)
  identifier(surface.root, 'surface.root')
  if (!object(surface.state) || Object.keys(surface.state).length > 32) fail('surface.state is invalid')
  for (const [key, value] of Object.entries(surface.state)) { identifier(key, 'state key'); primitive(value, 'state.' + key) }
  array(surface.components, 1, MAX_COMPONENTS, 'surface.components')
  array(surface.actions, 0, 16, 'surface.actions')
  uniqueIds(surface.components, 'components')
  uniqueIds(surface.actions, 'actions')
  const components = new Map(surface.components.map(component => [component.id, component]))
  const actions = new Map(surface.actions.map(action => [action.id, action]))
  const hasState = key => Object.prototype.hasOwnProperty.call(surface.state, key)
  function selection(key, items, label) {
    identifier(key, label + '.selectionKey')
    if (!hasState(key) || typeof surface.state[key] !== 'string' || surface.state[key] !== '' && !items.some(item => item.id === surface.state[key])) fail(label + ' selection is invalid')
  }
  for (const action of surface.actions) {
    keys(action, ['id', 'type', 'message', 'stateKeys'], ['id', 'type', 'message', 'stateKeys'], 'action')
    if (action.type !== 'ask_agent') fail('unsupported action type')
    text(action.message, 1000, 'action.message', false)
    array(action.stateKeys, 0, 32, 'action.stateKeys')
    if (new Set(action.stateKeys).size !== action.stateKeys.length) fail('duplicate action state key')
    for (const key of action.stateKeys) { identifier(key, 'action state key'); if (!hasState(key)) fail('action refers to missing state') }
  }
  for (const component of surface.components) {
    if (surface.version === 1 && !LEGACY_COMPONENTS.includes(component.type)) fail('component requires surface version 2')
    switch (component.type) {
      case 'column': case 'row': case 'form':
        if (component.type === 'form') {
          keys(component, ['id', 'type', 'label', 'children'], ['id', 'type', 'label', 'children'], 'form')
          text(component.label, 160, 'form.label', false)
        } else keys(component, ['id', 'type', 'children'], ['id', 'type', 'children'], 'container')
        array(component.children, 1, MAX_COMPONENTS, 'container.children')
        if (new Set(component.children).size !== component.children.length) fail('duplicate child')
        for (const id of component.children) { identifier(id, 'child'); if (!components.has(id)) fail('missing child') }
        break
      case 'text':
        keys(component, ['id', 'type', 'text'], ['id', 'type', 'text'], 'text')
        text(component.text, 4000, 'text.text', true)
        break
      case 'slider': {
        keys(component, ['id', 'type', 'label', 'stateKey', 'min', 'max', 'step'], ['id', 'type', 'label', 'stateKey', 'min', 'max', 'step'], 'slider')
        text(component.label, 160, 'slider.label', false)
        identifier(component.stateKey, 'slider.stateKey')
        if (!hasState(component.stateKey)) fail('slider state is missing')
        for (const key of ['min', 'max', 'step']) number(component[key], 'slider.' + key)
        const value = surface.state[component.stateKey]
        number(value, 'slider value')
        if (component.min >= component.max || component.step <= 0 || component.step > component.max - component.min || value < component.min || value > component.max) fail('slider range is invalid')
        if ((component.max - component.min) / component.step > 10000) fail('slider has too many steps')
        const position = (value - component.min) / component.step
        if (!Number.isFinite(position) || Math.abs(position - Math.round(position)) > 1e-7) fail('slider value is not aligned to step')
        break
      }
      case 'input': {
        keys(component, ['id', 'type', 'label', 'stateKey', 'maxLength'], ['id', 'type', 'label', 'stateKey', 'maxLength'], 'input')
        text(component.label, 160, 'input.label', false)
        identifier(component.stateKey, 'input.stateKey')
        if (!hasState(component.stateKey)) fail('input state is missing')
        if (!Number.isSafeInteger(component.maxLength) || component.maxLength < 1 || component.maxLength > 2000) fail('input maxLength is invalid')
        const value = surface.state[component.stateKey]
        if (typeof value !== 'string' || value.length > component.maxLength || /[\r\n]/.test(value)) fail('input value is invalid')
        break
      }
      case 'checkbox':
        keys(component, ['id', 'type', 'label', 'stateKey'], ['id', 'type', 'label', 'stateKey'], 'checkbox')
        text(component.label, 160, 'checkbox.label', false)
        identifier(component.stateKey, 'checkbox.stateKey')
        if (!hasState(component.stateKey) || typeof surface.state[component.stateKey] !== 'boolean') fail('checkbox state is invalid')
        break
      case 'chart': {
        keys(component, ['id', 'type', 'chartType', 'title', 'labels', 'series', 'multiplierKey'], ['id', 'type', 'chartType', 'title', 'labels', 'series'], 'chart')
        if (!['line', 'bar'].includes(component.chartType)) fail('unsupported chart type')
        text(component.title, 160, 'chart.title', false)
        array(component.labels, 1, 120, 'chart.labels')
        component.labels.forEach(label => text(label, 120, 'chart label', true))
        array(component.series, 1, 8, 'chart.series')
        uniqueIds(component.series, 'chart.series')
        for (const series of component.series) {
          keys(series, ['id', 'name', 'values'], ['id', 'name', 'values'], 'series')
          text(series.name, 120, 'series.name', false)
          if (!Array.isArray(series.values) || series.values.length !== component.labels.length) fail('chart series length mismatch')
          series.values.forEach(value => number(value, 'series value'))
        }
        if (component.multiplierKey !== undefined) {
          identifier(component.multiplierKey, 'chart.multiplierKey')
          if (!hasState(component.multiplierKey)) fail('chart multiplier state is missing')
          number(surface.state[component.multiplierKey], 'chart multiplier')
        }
        break
      }
      case 'filter': {
        keys(component, ['id', 'type', 'label', 'stateKey', 'options'], ['id', 'type', 'label', 'stateKey', 'options'], 'filter')
        text(component.label, 160, 'filter.label', false)
        identifier(component.stateKey, 'filter.stateKey')
        array(component.options, 1, 64, 'filter.options')
        const values = new Set()
        for (const option of component.options) {
          keys(option, ['value', 'label'], ['value', 'label'], 'filter option')
          text(option.value, 120, 'filter value', true); text(option.label, 160, 'filter label', false)
          if (values.has(option.value)) fail('duplicate filter value')
          values.add(option.value)
        }
        if (!hasState(component.stateKey) || !values.has(surface.state[component.stateKey])) fail('filter selection is invalid')
        break
      }
      case 'table': {
        keys(component, ['id', 'type', 'title', 'columns', 'rows', 'selectionKey', 'filterKey', 'filterColumn'], ['id', 'type', 'title', 'columns', 'rows'], 'table')
        text(component.title, 160, 'table.title', false)
        array(component.columns, 1, 12, 'table.columns'); uniqueIds(component.columns, 'table.columns')
        for (const column of component.columns) { keys(column, ['id', 'label'], ['id', 'label'], 'table column'); text(column.label, 120, 'column label', false) }
        array(component.rows, 0, 120, 'table.rows'); uniqueIds(component.rows, 'table.rows')
        for (const row of component.rows) {
          keys(row, ['id', 'cells'], ['id', 'cells'], 'table row')
          if (!Array.isArray(row.cells) || row.cells.length !== component.columns.length) fail('table cell count')
          row.cells.forEach(value => primitive(value, 'table cell'))
        }
        if (component.selectionKey !== undefined) selection(component.selectionKey, component.rows, 'table')
        if (component.filterKey !== undefined || component.filterColumn !== undefined) {
          identifier(component.filterKey, 'table.filterKey'); identifier(component.filterColumn, 'table.filterColumn')
          if (!hasState(component.filterKey) || typeof surface.state[component.filterKey] !== 'string' || !component.columns.some(column => column.id === component.filterColumn)) fail('table filter binding')
        }
        break
      }
      case 'progress': {
        keys(component, ['id', 'type', 'label', 'valueKey', 'max', 'status'], ['id', 'type', 'label', 'valueKey', 'max', 'status'], 'progress')
        text(component.label, 160, 'progress.label', false); identifier(component.valueKey, 'progress.valueKey')
        number(component.max, 'progress.max')
        const value = surface.state[component.valueKey]
        if (!hasState(component.valueKey) || typeof value !== 'number' || value < 0 || value > component.max || component.max <= 0 || !STATUSES.includes(component.status)) fail('progress value or status')
        break
      }
      case 'flow': {
        keys(component, ['id', 'type', 'title', 'nodes', 'edges', 'selectionKey'], ['id', 'type', 'title', 'nodes', 'edges', 'selectionKey'], 'flow')
        text(component.title, 160, 'flow.title', false)
        array(component.nodes, 1, 32, 'flow.nodes'); uniqueIds(component.nodes, 'flow.nodes')
        for (const node of component.nodes) {
          keys(node, ['id', 'label', 'status'], ['id', 'label', 'status'], 'flow node')
          text(node.label, 160, 'node label', false)
          if (!STATUSES.includes(node.status)) fail('node status')
        }
        array(component.edges, 0, 64, 'flow.edges')
        const edges = new Set(), nodes = new Set(component.nodes.map(node => node.id))
        for (const edge of component.edges) {
          keys(edge, ['from', 'to', 'label'], ['from', 'to'], 'flow edge')
          identifier(edge.from, 'edge.from'); identifier(edge.to, 'edge.to')
          if (edge.label !== undefined) text(edge.label, 120, 'edge label', true)
          const key = edge.from + ':' + edge.to
          if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to || edges.has(key)) fail('flow edge references')
          edges.add(key)
        }
        selection(component.selectionKey, component.nodes, 'flow')
        break
      }
      case 'map': {
        keys(component, ['id', 'type', 'title', 'points', 'selectionKey'], ['id', 'type', 'title', 'points', 'selectionKey'], 'map')
        text(component.title, 160, 'map.title', false)
        array(component.points, 1, 120, 'map.points'); uniqueIds(component.points, 'map.points')
        for (const point of component.points) {
          keys(point, ['id', 'label', 'longitude', 'latitude'], ['id', 'label', 'longitude', 'latitude'], 'map point')
          text(point.label, 160, 'point label', false)
          number(point.longitude, 'longitude'); number(point.latitude, 'latitude')
          if (Math.abs(point.longitude) > 180 || Math.abs(point.latitude) > 90) fail('map coordinate range')
        }
        selection(component.selectionKey, component.points, 'map')
        break
      }
      case 'visual': {
        keys(component, ['id', 'type', 'title', 'html', 'height'], ['id', 'type', 'title', 'html'], 'visual')
        text(component.title, 160, 'visual.title', false)
        text(component.html, 30000, 'visual.html', false)
        if (component.height !== undefined && (!Number.isSafeInteger(component.height) || component.height < 200 || component.height > 800)) fail('visual height is invalid')
        break
      }
      case 'button':
        keys(component, ['id', 'type', 'label', 'actionId'], ['id', 'type', 'label', 'actionId'], 'button')
        text(component.label, 160, 'button.label', false)
        identifier(component.actionId, 'button.actionId')
        if (!actions.has(component.actionId)) fail('button action is missing')
        break
      default: fail('unsupported component type')
    }
  }
  if (!components.has(surface.root)) fail('root is missing')
  const visited = new Set(), active = new Set()
  function visit(id, depth) {
    if (depth > 8) fail('component tree is too deep')
    if (active.has(id)) fail('component cycle')
    if (visited.has(id)) fail('component must have only one parent')
    visited.add(id); active.add(id)
    const component = components.get(id)
    for (const child of component.children || []) visit(child, depth + 1)
    active.delete(id)
  }
  visit(surface.root, 1)
  if (visited.size !== components.size) fail('unreachable component')
  return surface
}

// A local presentation state is not a new published surface. Validate the
// original surface and bound state separately, then re-use the exact same
// component/reference rules. This lets a valid slider move even when a surface
// near 48,000 JSON characters grows by a few digits in its local state.
function assertSurfaceState(surface, state) {
  assertSurface(surface)
  size(state, 'state')
  if (!object(state)) fail('state is invalid')
  const expected = Object.keys(surface.state)
  if (Object.keys(state).length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(state, key))) fail('state keys differ from surface')
  assertSurfaceShape({ ...surface, state })
  return state
}

// An unsupported future block is preserved as opaque data, never executed. This
// lets old histories remain readable without accepting future component types.
function assertBlock(block) {
  keys(block, ['type', 'toolCallId', 'surface'], ['type', 'toolCallId', 'surface'], 'block')
  if (block.type !== 'ui' || typeof block.toolCallId !== 'string' || !block.toolCallId || block.toolCallId.length > 256) fail('invalid UI block')
  if (!object(block.surface) || !Number.isSafeInteger(block.surface.version) || block.surface.version < 1) fail('invalid surface version')
  if (VERSIONS.includes(block.surface.version)) assertSurface(block.surface)
  else size(block.surface, 'surface')
  return block
}

function latest(messages, id) {
  let found = null
  for (const message of messages || []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part && part.type === 'ui' && part.surface && part.surface.id === id) found = part.surface
    }
  }
  return found
}
function countSurfaces(messages) {
  const ids = new Set()
  for (const message of messages || []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) if (part && part.type === 'ui' && part.surface && typeof part.surface.id === 'string') ids.add(part.surface.id)
  }
  return ids.size
}
function summary(surface) {
  return surface && VERSIONS.includes(surface.version)
    ? '[交互界面 ' + surface.id + '，版本 ' + surface.revision + '：' + surface.title + ']'
    : '[不支持的交互界面版本]'
}
function capabilities() { return { versions: VERSIONS.slice(), components: COMPONENTS.slice() } }
function negotiate(value) {
  if (value === undefined || value === null) return null
  keys(value, ['versions', 'components'], ['versions', 'components'], 'capabilities')
  array(value.versions, 1, 8, 'capability versions'); array(value.components, 0, 64, 'capability components')
  if (new Set(value.versions).size !== value.versions.length || value.versions.some(item => !Number.isInteger(item) || item < 1 || item > 100)) fail('capability versions')
  if (new Set(value.components).size !== value.components.length || value.components.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(item))) fail('capability components')
  const versions = VERSIONS.filter(version => value.versions.includes(version))
  const components = COMPONENTS.filter(kind => value.components.includes(kind))
  return versions.length ? { versions, components } : null
}
function assertRenderable(surface, renderer) {
  assertSurface(surface)
  const agreed = negotiate(renderer)
  if (!agreed || !agreed.versions.includes(surface.version) || surface.components.some(component => !agreed.components.includes(component.type))) fail('renderer capability mismatch')
  return surface
}
module.exports = { VERSION, VERSIONS, COMPONENTS, LEGACY_COMPONENTS, STATUSES, capabilities, negotiate, assertRenderable, MAX_SURFACE_CHARS, MAX_SURFACES_PER_CONVERSATION, assertSurface, assertSurfaceState, assertBlock, latest, countSurfaces, summary }
