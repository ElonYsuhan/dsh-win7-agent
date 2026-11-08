// Build-only facade. These are the complete offline browser runtime exports
// needed by our compiled renderer; no agent-generated code is imported here.
import * as Vue from 'vue'
import { NButton, NConfigProvider, darkTheme } from 'naive-ui'
import * as EChartsCore from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, MarkPointComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

export const vue = Vue
export const naive = { NButton, NConfigProvider, darkTheme }
export const echartsCore = EChartsCore
export const echartsCharts = { BarChart, LineChart }
export const echartsComponents = { AriaComponent, GridComponent, LegendComponent, MarkPointComponent, TooltipComponent }
export const echartsRenderers = { CanvasRenderer }
