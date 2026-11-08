<script setup lang="ts">
import SurfaceNode from './SurfaceNode.vue'
import type { PreparedForm } from '../types'
import type { ActionIntent } from '../interaction-controller'
import type { ChartTheme } from '../chart-options'
defineProps<{ node: PreparedForm; theme: ChartTheme }>()
const emit = defineEmits<{ sliderChange: [id: string, value: number]; fieldChange: [id: string, value: string | boolean]; action: [intent: ActionIntent] }>()
function slider(id: string, value: number): void { emit('sliderChange', id, value) }
function field(id: string, value: string | boolean): void { emit('fieldChange', id, value) }
function forwardAction(intent: ActionIntent): void { emit('action', intent) }
</script>

<template>
  <!-- A fieldset groups inputs without a native submit or a network action. -->
  <fieldset class="gui-form">
    <legend>{{ node.label }}</legend>
    <div class="gui-form-fields">
      <SurfaceNode v-for="child in node.children" :key="child.id" :node="child" :theme="theme" @slider-change="slider" @field-change="field" @action="forwardAction" />
    </div>
  </fieldset>
</template>

<style scoped>
.gui-form { box-sizing: border-box; min-width: 0; max-width: 100%; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; color: var(--text); }
.gui-form legend { padding: 0 4px; overflow-wrap: anywhere; }
.gui-form-fields { display: flex; flex-direction: column; min-width: 0; gap: 12px; }
</style>
