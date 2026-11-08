import type { ChartData } from './types'

// The palette is an application-owned choice, not part of model input. Both
// modes were checked against the app's light and dark chart surfaces. Some
// colors need non-color encoding / a data table to meet contrast requirements.
const LIGHT = Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'])
const DARK = Object.freeze(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'])
const SYMBOLS = Object.freeze(['circle', 'rect', 'triangle', 'diamond', 'roundRect', 'pin', 'arrow', 'emptyCircle'])
const STROKES = Object.freeze(['solid', 'dashed', 'dotted', 'solid', 'dashed', 'dotted', 'solid', 'dashed'])

export type ChartTheme = 'light' | 'dark'
export interface SeriesColor { readonly id: string; readonly slot: number }
export interface ChartPlan {
  readonly colors: readonly SeriesColor[]
  // Only code in this module creates this option. Agent-provided options,
  // formatters, URLs, markup, functions and callbacks are never accepted.
  readonly option: Readonly<Record<string, unknown>>
}

// Keep the color of every surviving series when series are reordered, added or
// removed. A detached series may relinquish its slot; at most eight are visible.
// The caller owns this presentation-only memory for the lifetime of one chart.
function assignColors(data: ChartData, previous: readonly SeriesColor[]): readonly SeriesColor[] {
  if (!Array.isArray(previous) || previous.length > 8) throw new Error('GENERATIVE_UI_CHART_INVALID: color assignments')
  const oldIds = new Set<string>(), oldSlots = new Set<number>()
  for (const entry of previous) {
    if (!entry || typeof entry.id !== 'string' || oldIds.has(entry.id) || !Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot > 7 || oldSlots.has(entry.slot)) throw new Error('GENERATIVE_UI_CHART_INVALID: color assignment')
    oldIds.add(entry.id); oldSlots.add(entry.slot)
  }
  const currentIds = new Set(data.series.map(item => item.id))
  if (currentIds.size !== data.series.length || currentIds.size < 1 || currentIds.size > 8) throw new Error('GENERATIVE_UI_CHART_INVALID: series')
  const retained = previous.filter(entry => currentIds.has(entry.id))
  const occupied = new Set(retained.map(entry => entry.slot))
  const result: SeriesColor[] = retained.map(entry => ({ id: entry.id, slot: entry.slot }))
  for (const series of data.series) {
    if (result.some(entry => entry.id === series.id)) continue
    let slot = 0
    while (occupied.has(slot)) slot += 1
    if (slot > 7) throw new Error('GENERATIVE_UI_CHART_INVALID: no color slot')
    occupied.add(slot)
    result.push({ id: series.id, slot })
  }
  // Remember absent series while their slots remain free, so toggling a
  // series off and on keeps its identity. An occupied slot may be reclaimed
  // only when a new visible series requires it; visible survivors never move.
  for (const entry of previous) {
    if (!currentIds.has(entry.id) && !occupied.has(entry.slot)) {
      result.push({ id: entry.id, slot: entry.slot }); occupied.add(entry.slot)
    }
  }
  return Object.freeze(result.map(entry => Object.freeze(entry)))
}

// data must be the output of deriveChart()/prepareTree(), which use the P0
// validator. This creates a whitelisted option for ECharts canvas rendering;
// it never merges a model-supplied object into the option.
export function makeChartPlan(data: ChartData, theme: ChartTheme, previous: readonly SeriesColor[] = [], texture = false): ChartPlan {
  if (theme !== 'light' && theme !== 'dark') throw new Error('GENERATIVE_UI_CHART_INVALID: theme')
  if (typeof texture !== 'boolean') throw new Error('GENERATIVE_UI_CHART_INVALID: texture')
  const bindings = assignColors(data, previous)
  const palette = theme === 'dark' ? DARK : LIGHT
  const text = theme === 'dark' ? '#eeeeee' : '#252525'
  const muted = theme === 'dark' ? '#aaaaaa' : '#666666'
  const grid = theme === 'dark' ? '#4c4c4c' : '#dddddd'
  const multi = data.series.length > 1
  const series = data.series.map(item => {
    const binding = bindings.find(entry => entry.id === item.id)
    if (!binding) throw new Error('GENERATIVE_UI_CHART_INVALID: missing color')
    const slot = binding.slot, color = palette[slot]
    // IDs disambiguate identical labels without treating text as markup.
    const name = multi ? item.name + ' (' + item.id + ')' : item.name
    const common = { id: item.id, name, type: data.chartType, itemStyle: { color }, emphasis: { focus: 'series' } }
    if (data.chartType === 'line') return {
      ...common,
      data: item.values.slice(),
      symbol: SYMBOLS[slot], symbolSize: 8, showSymbol: true,
      lineStyle: { width: 2, type: STROKES[slot], color },
      endLabel: { show: data.series.length <= 4, formatter: '{a}', color: text },
      labelLayout: { moveOverlap: 'shiftY' }
    }
    if (data.chartType !== 'bar') throw new Error('GENERATIVE_UI_CHART_INVALID: chart type')
    return {
      ...common,
      barMaxWidth: 32,
      // ECharts skips both the marker *and its label* for symbol: 'none'.
      // Use a transparent one-pixel marker so the last point's label renders.
      // The trusted renderer registers MarkPointComponent for this feature.
      markPoint: { silent: true, symbol: 'circle', symbolSize: 1, itemStyle: { color: 'transparent' }, label: { show: data.series.length <= 4, position: 'right', distance: 20, formatter: '{a}', color: text }, data: [{ coord: [data.labels.length - 1, item.values[item.values.length - 1]] }] },
      // Round the outer end, not the zero baseline, including negative bars.
      data: item.values.map(value => ({ value, itemStyle: { borderRadius: value < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } }))
    }
  })
  const option = {
    animation: false,
    // richText stays on the canvas; the model's labels never become tooltip
    // HTML. No model-supplied formatter, link or executable code is used.
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, textStyle: { color: text } },
    aria: { enabled: true, decal: { show: texture } },
    legend: { show: multi, selectedMode: false, textStyle: { color: text }, type: 'scroll' },
    grid: { left: 16, right: 20, top: multi ? 46 : 18, bottom: 20, containLabel: true },
    xAxis: { type: 'category', data: data.labels.slice(), axisLabel: { color: muted, hideOverlap: true }, axisLine: { lineStyle: { color: grid } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } } },
    series
  }
  return Object.freeze({ colors: bindings, option })
}
