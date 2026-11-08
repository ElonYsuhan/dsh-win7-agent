<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart, BarChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, MarkPointComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { makeChartPlan } from '../chart-options'
import type { ChartTheme, SeriesColor } from '../chart-options'
import { createChartController } from '../chart-lifecycle'
import type { ChartController } from '../chart-lifecycle'
import type { PreparedChart } from '../types'

const props = defineProps<{ node: PreparedChart; theme: ChartTheme }>()
const host = shallowRef<HTMLDivElement | null>(null)
const message = shallowRef('')
let controller: ChartController | null = null
let observer: ResizeObserver | null = null
let forcedColors: MediaQueryList | null = null
let colors: readonly SeriesColor[] = []
let fallbackResize: (() => void) | null = null

function refresh(): void {
  if (!controller) return
  try {
    const plan = makeChartPlan(props.node.data, props.theme, colors, !!forcedColors?.matches)
    colors = plan.colors
    controller.update(plan.option)
  } catch (_) {
    controller.dispose(); controller = null
    message.value = '图表暂不可用，请查看数据表。'
  }
}
function forcedColorsChanged(): void { refresh() }
watch(() => [props.node.data, props.theme] as const, refresh, { flush: 'post' })

onMounted(() => {
  const element = host.value
  if (!element) { message.value = '图表暂不可用，请查看数据表。'; return }
  try {
    echarts.use([LineChart, BarChart, AriaComponent, GridComponent, LegendComponent, MarkPointComponent, TooltipComponent, CanvasRenderer])
    controller = createChartController({
      measure: () => ({ connected: element.isConnected, width: element.clientWidth, height: element.clientHeight }),
      create: () => {
        const chart = echarts.init(element, undefined, { renderer: 'canvas' })
        return {
          setOption: (option, replace) => chart.setOption(option as Parameters<typeof chart.setOption>[0], replace),
          resize: () => chart.resize(),
          dispose: () => chart.dispose()
        }
      },
      requestFrame: callback => window.requestAnimationFrame(callback),
      cancelFrame: handle => window.cancelAnimationFrame(handle),
      onError: () => { message.value = '图表暂不可用，请查看数据表。' }
    })
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => controller?.notifyLayout())
      observer.observe(element)
    } else {
      fallbackResize = () => controller?.notifyLayout()
      window.addEventListener('resize', fallbackResize)
    }
    if (typeof window.matchMedia === 'function') {
      forcedColors = window.matchMedia('(forced-colors: active)')
      forcedColors.addEventListener('change', forcedColorsChanged)
    }
    refresh()
    controller?.notifyLayout()
  } catch (_) {
    controller?.dispose(); controller = null
    message.value = '图表暂不可用，请查看数据表。'
  }
})
onBeforeUnmount(() => {
  observer?.disconnect(); observer = null
  if (fallbackResize) window.removeEventListener('resize', fallbackResize)
  forcedColors?.removeEventListener('change', forcedColorsChanged)
  controller?.dispose(); controller = null
})
</script>

<template>
  <figure class="gui-chart">
    <figcaption>{{ node.data.title }}</figcaption>
    <div ref="host" class="gui-plot" role="img" :aria-label="node.data.title" />
    <p v-if="message" class="gui-chart-message" role="status">{{ message }}</p>
    <details class="gui-chart-table">
      <summary>查看数据表</summary>
      <div class="gui-table-scroll">
        <table>
          <caption>{{ node.data.title }} 数据表</caption>
          <thead><tr><th scope="col">分类</th><th v-for="series in node.data.series" :key="series.id" scope="col">{{ series.name }} <small v-if="node.data.series.length > 1">({{ series.id }})</small></th></tr></thead>
          <tbody><tr v-for="(row, rowIndex) in node.data.rows" :key="rowIndex"><th scope="row">{{ row.label }}</th><td v-for="(value, index) in row.values" :key="index">{{ value }}</td></tr></tbody>
        </table>
      </div>
    </details>
  </figure>
</template>

<style scoped>
.gui-chart { margin: 0; min-width: 0; width: 100%; color: var(--text); }
.gui-chart figcaption { font-weight: 600; overflow-wrap: anywhere; }
.gui-plot { width: 100%; min-width: 0; height: 280px; }
.gui-chart-message { color: var(--muted); }
.gui-chart-table summary { color: var(--muted); cursor: pointer; }
.gui-chart-table summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.gui-table-scroll { max-width: 100%; overflow-x: auto; }
.gui-chart table { border-collapse: collapse; width: 100%; margin-top: 8px; font-variant-numeric: tabular-nums; }
.gui-chart caption { text-align: left; padding: 4px 0; }
.gui-chart th, .gui-chart td { text-align: left; border-bottom: 1px solid var(--border); padding: 6px 8px; }
.gui-chart small { color: var(--muted); }
@media print { .gui-plot { display: none; } .gui-chart-table { display: block; } }
</style>
