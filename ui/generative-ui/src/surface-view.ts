import { assertSurface, assertSurfaceState } from '../../../src/main/contracts/generative-ui.js'
import type { ChartComponent, ChartData, ChartSeries, Component, PreparedNode, Surface, SurfaceState, SurfaceView } from './types'

// This is a pure, in-memory view model. It never persists changes, executes
// actions, calls a tool, constructs HTML, or sends data to a model.
function fail(reason: string): never { throw new Error('GENERATIVE_UI_VIEW_INVALID: ' + reason) }
export function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 1024) fail('invalid session')
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}
function copySurface(input: unknown): Surface {
  // Check before cloning so unsupported values or prototypes cannot be hidden
  // by JSON serialization. The P0 validator is the only schema authority.
  assertSurface(input)
  return freezeJson(JSON.parse(JSON.stringify(input)) as Surface)
}
function copyState(state: SurfaceState): SurfaceState {
  return Object.freeze({ ...state })
}
function checked(view: SurfaceView): void {
  if (!view || typeof view !== 'object') fail('view is required')
  assertSessionId(view.sessionId)
  // Revalidate the original published surface and the current local state with
  // the P0 rules. Shared slider bindings must satisfy every slider's range/step.
  assertSurfaceState(view.surface, view.state)
}
function findComponent(view: SurfaceView, id: string): Component {
  if (typeof id !== 'string') fail('component id is invalid')
  const component = view.surface.components.find(item => item.id === id)
  if (!component) fail('component is missing')
  return component
}

export function createSurfaceView(sessionId: string, input: unknown): SurfaceView {
  assertSessionId(sessionId)
  const surface = copySurface(input)
  return Object.freeze({ sessionId, surface, state: copyState(surface.state) })
}

// A replacement must be checked in the originating session and for the same
// surface. Duplicate/older notifications cannot roll back a newer view. A new
// revision intentionally starts from its published defaults; merge/recovery of
// user changes belongs to the later persisted-interaction design.
export function replaceSurfaceView(view: SurfaceView, sessionId: string, input: unknown): SurfaceView {
  checked(view)
  assertSessionId(sessionId)
  if (view.sessionId !== sessionId) fail('session mismatch')
  const replacement = createSurfaceView(sessionId, input)
  if (replacement.surface.id !== view.surface.id) fail('surface mismatch')
  if (replacement.surface.revision <= view.surface.revision) return view
  return replacement
}

// A slider can change only its own bound key; there is no generic script,
// expression evaluator, action execution, or arbitrary tool dispatch here.
export function updateSlider(view: SurfaceView, componentId: string, value: unknown): SurfaceView {
  checked(view)
  const component = findComponent(view, componentId)
  if (component.type !== 'slider') fail('component is not a slider')
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('slider value is not finite')
  const state = { ...view.state, [component.stateKey]: value }
  assertSurfaceState(view.surface, state)
  if (Object.is(view.state[component.stateKey], value)) return view
  return Object.freeze({ sessionId: view.sessionId, surface: view.surface, state: copyState(state) })
}

// A form field changes only its own bound key, in local presentation state.
// Revalidate the whole binding graph so shared keys satisfy every field.
export function updateField(view: SurfaceView, componentId: string, value: unknown): SurfaceView {
  checked(view)
  const component = findComponent(view, componentId)
  if (!['input', 'checkbox', 'filter', 'table', 'flow', 'map'].includes(component.type)) fail('component is not a form field')
  if (typeof value !== 'string' && typeof value !== 'boolean') fail('field value has an invalid type')
  if (component.type === 'input' && typeof value !== 'string') fail('input value is not text')
  if (component.type === 'checkbox' && typeof value !== 'boolean') fail('checkbox value is not boolean')
  let key: string
  if (component.type === 'input' || component.type === 'checkbox' || component.type === 'filter') key = component.stateKey
  else if ((component.type === 'table' && component.selectionKey) || component.type === 'flow' || component.type === 'map') key = component.selectionKey!
  else return fail('component has no editable selection')
  const state = { ...view.state, [key]: value }
  assertSurfaceState(view.surface, state)
  if (Object.is(view.state[key], value)) return view
  return Object.freeze({ sessionId: view.sessionId, surface: view.surface, state: copyState(state) })
}

// This is chart *data*, not an ECharts option or markup. Text is still
// untrusted. A renderer must escape it and avoid HTML-capable tooltip paths.
function chartData(view: SurfaceView, component: ChartComponent): ChartData {
  const multiplier = component.multiplierKey === undefined ? 1 : view.state[component.multiplierKey]
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) fail('chart multiplier is not finite')
  const labels = component.labels.slice()
  const series: ChartSeries[] = component.series.map(item => ({
    id: item.id,
    name: item.name,
    values: item.values.map(value => {
      const result = value * multiplier
      if (!Number.isFinite(result)) fail('chart result is not finite')
      return result
    })
  }))
  const rows = labels.map((label, index) => ({ label, values: series.map(item => item.values[index]) }))
  return freezeJson({ id: component.id, title: component.title, chartType: component.chartType, labels, series, rows })
}

export function restoreSurfaceState(view: SurfaceView, state: SurfaceState): SurfaceView {
  checked(view)
  assertSurfaceState(view.surface, state)
  return Object.freeze({ sessionId: view.sessionId, surface: view.surface, state: copyState(state) })
}

export function deriveChart(view: SurfaceView, componentId: string): ChartData {
  checked(view)
  const component = findComponent(view, componentId)
  if (component.type !== 'chart') fail('component is not a chart')
  return chartData(view, component)
}

// Translate the bounded, validated component graph into a display-only tree.
// UI frameworks bind these values to built-in components, never to HTML or
// arbitrary attributes. Text remains untrusted and must be escaped at display.
export function prepareTree(view: SurfaceView, actions = { enabled: false, reason: '交互回传尚未启用' }): PreparedNode {
  checked(view)
  const components = new Map(view.surface.components.map(component => [component.id, component]))
  function prepare(id: string): PreparedNode {
    const component = components.get(id)
    if (!component) return fail('component is missing')
    switch (component.type) {
      case 'column': case 'row':
        return { id: component.id, type: component.type, children: component.children.map(prepare) }
      case 'form':
        return { id: component.id, type: 'form', label: component.label, children: component.children.map(prepare) }
      case 'input': {
        const value = view.state[component.stateKey]
        if (typeof value !== 'string') return fail('input value is not text')
        return { id: component.id, type: 'input', label: component.label, value, maxLength: component.maxLength }
      }
      case 'checkbox': {
        const value = view.state[component.stateKey]
        if (typeof value !== 'boolean') return fail('checkbox value is not boolean')
        return { id: component.id, type: 'checkbox', label: component.label, value }
      }
      case 'text':
        return { id: component.id, type: 'text', text: component.text }
      case 'slider': {
        const value = view.state[component.stateKey]
        if (typeof value !== 'number') return fail('slider value is not numeric')
        return { id: component.id, type: 'slider', label: component.label, value, min: component.min, max: component.max, step: component.step }
      }
      case 'chart':
        return { id: component.id, type: 'chart', data: chartData(view, component) }
      case 'filter':
        return { id: component.id, type: 'filter', label: component.label, value: String(view.state[component.stateKey]), options: component.options }
      case 'table': {
        const index = component.columns.findIndex(column => column.id === component.filterColumn)
        const filter = component.filterKey === undefined ? '' : String(view.state[component.filterKey]).toLowerCase()
        const rows = filter ? component.rows.filter(row => String(row.cells[index] ?? '').toLowerCase().includes(filter)) : component.rows
        return { id: component.id, type: 'table', title: component.title, columns: component.columns, rows, selected: component.selectionKey === undefined ? '' : String(view.state[component.selectionKey]), selectable: component.selectionKey !== undefined }
      }
      case 'progress':
        return { id: component.id, type: 'progress', label: component.label, value: Number(view.state[component.valueKey]), max: component.max, status: component.status }
      case 'flow':
        return { id: component.id, type: 'flow', title: component.title, nodes: component.nodes, edges: component.edges, selected: String(view.state[component.selectionKey]) }
      case 'map':
        return { id: component.id, type: 'map', title: component.title, points: component.points, selected: String(view.state[component.selectionKey]) }
      case 'visual':
        return { id: component.id, type: 'visual', title: component.title, html: component.html, height: component.height === undefined ? 360 : component.height }
      case 'button':
        return { id: component.id, type: 'button', label: component.label, actionId: component.actionId, disabled: !actions.enabled, disabledReason: actions.enabled ? '' : actions.reason }
      default: {
        const exhaustive: never = component
        return fail('unsupported component ' + String(exhaustive))
      }
    }
  }
  return freezeJson(prepare(view.surface.root))
}
