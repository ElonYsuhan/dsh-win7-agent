<script setup lang="ts">
import SurfaceNode from './SurfaceNode.vue'
import type { PreparedContainer } from '../types'
import type { ActionIntent } from '../interaction-controller'
import type { ChartTheme } from '../chart-options'
defineProps<{ node: PreparedContainer; theme: ChartTheme }>()
const emit = defineEmits<{ sliderChange: [id: string, value: number]; fieldChange: [id: string, value: string | boolean]; action: [intent: ActionIntent] }>()
function forward(id: string, value: number): void { emit('sliderChange', id, value) }
function forwardField(id: string, value: string | boolean): void { emit('fieldChange', id, value) }
function forwardAction(intent: ActionIntent): void { emit('action', intent) }
</script>

<template>
  <div :class="['gui-container', node.type === 'row' ? 'gui-row' : 'gui-column']">
    <SurfaceNode v-for="child in node.children" :key="child.id" :node="child" :theme="theme" @slider-change="forward" @field-change="forwardField" @action="forwardAction" />
  </div>
</template>

<style scoped>
.gui-container { display: flex; min-width: 0; gap: 12px; }
.gui-column { flex-direction: column; }
.gui-row { flex-flow: row wrap; align-items: flex-start; }
.gui-row > * { min-width: 0; }
</style>
