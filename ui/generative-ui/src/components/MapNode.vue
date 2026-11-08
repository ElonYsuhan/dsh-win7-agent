<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { createMapController } from '../map-runtime'
import type { MapBackend, MapController } from '../map-runtime'
import type { PreparedMap } from '../types'
import type { ChartTheme } from '../chart-options'
const props = defineProps<{ node: PreparedMap; theme: ChartTheme }>()
const emit = defineEmits<{ fieldChange: [id: string, value: string] }>()
const host = shallowRef<HTMLDivElement | null>(null)
const backend = shallowRef<MapBackend>('loading')
let controller: MapController | null = null
const note = computed(() => backend.value === 'cesium' ? '离线地球：仅标记，无影像/地形。可拖动、缩放，点击标记或下方列表选择地点。' : backend.value === 'coordinates' ? '三维地图不可用，已降级为经纬度示意图（非底图）；地点选择仍可使用。' : '正在加载本地地图组件…')
function select(id: string): void { emit('fieldChange', props.node.id, id) }
watch([() => props.node, () => props.theme], () => controller?.update(props.node, props.theme), { flush: 'post' })
onMounted(() => {
  if (!host.value) { backend.value = 'coordinates'; return }
  controller = createMapController(host.value, select, value => { backend.value = value })
  controller.update(props.node, props.theme)
})
onBeforeUnmount(() => { controller?.dispose(); controller = null })
</script>

<template>
  <figure class="gui-map" :data-backend="backend" :data-map-backend="backend">
    <figcaption>{{ node.title }}</figcaption>
    <div v-show="backend !== 'coordinates'" ref="host" class="gui-map-globe" role="img" :aria-label="node.title + '，地点可在下方列表选择'" />
    <svg v-if="backend === 'coordinates'" class="gui-map-coordinates" viewBox="0 0 720 360" role="img" :aria-label="node.title + ' 经纬度示意图'">
      <path d="M0 90H720M0 180H720M0 270H720M180 0V360M360 0V360M540 0V360" class="gui-map-grid" />
      <g v-for="point in node.points" :key="point.id" :transform="'translate(' + (point.longitude + 180) * 2 + ',' + (90 - point.latitude) * 2 + ')'">
        <circle :r="point.id === node.selected ? 7 : 4" :class="['gui-map-marker', { selected: point.id === node.selected }]" />
        <title>{{ point.label }}：{{ point.longitude }}，{{ point.latitude }}</title>
      </g>
    </svg>
    <p class="gui-map-note" role="status">{{ note }}</p>
    <div class="gui-map-locations" :aria-label="node.title + ' 地点'">
      <button v-for="point in node.points" :key="point.id" type="button" class="gui-map-location" :aria-pressed="node.selected === point.id" @click="select(point.id)">
        <span>{{ node.selected === point.id ? '已选：' : '' }}{{ point.label }}</span><small>{{ point.longitude }}°，{{ point.latitude }}°</small>
      </button>
    </div>
  </figure>
</template>

<style scoped>
.gui-map { margin: 0; min-width: 0; width: 100%; color: var(--text); }
.gui-map figcaption { margin-bottom: 8px; font-weight: 600; overflow-wrap: anywhere; }
.gui-map-globe { position: relative; width: 100%; height: 320px; overflow: hidden; border-radius: 8px; background: var(--panel); }
.gui-map-globe :deep(.cesium-widget) { position: relative; width: 100%; height: 100%; overflow: hidden; }
.gui-map-globe :deep(canvas) { width: 100%; height: 100%; touch-action: none; }
.gui-map-globe :deep(.cesium-widget-credits) { position: absolute; bottom: 0; left: 0; padding: 4px 6px; color: var(--text); background: var(--panel); font-size: 10px; }
.gui-map-globe :deep(.cesium-credit-text) { color: var(--text); }
.gui-map-coordinates { display: block; width: 100%; height: auto; border: 1px solid var(--border); background: var(--panel); }
.gui-map-grid { stroke: var(--border); fill: none; }
.gui-map-marker { fill: var(--text); stroke: var(--panel); stroke-width: 2; }
.gui-map-marker.selected { fill: var(--focus); stroke: var(--text); }
.gui-map-note { margin: 8px 0; color: var(--muted); font-size: .9em; overflow-wrap: anywhere; }
.gui-map-locations { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr)); gap: 8px; max-height: 240px; overflow-y: auto; }
.gui-map-location { display: flex; flex-direction: column; gap: 3px; min-height: 44px; padding: 8px 10px; text-align: left; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; overflow-wrap: anywhere; font: inherit; }
.gui-map-location small { color: var(--muted); font-variant-numeric: tabular-nums; }
.gui-map-location[aria-pressed="true"] { border-color: var(--focus); }
.gui-map-location:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
@media (max-width: 480px) { .gui-map-globe { height: 260px; } }
@media print { .gui-map-globe { display: none; } .gui-map-locations { max-height: none; overflow: visible; } }
</style>
