<script setup lang="ts">
import { nextTick } from 'vue'
import type { PreparedSlider } from '../types'
const props = defineProps<{ node: PreparedSlider }>()
const emit = defineEmits<{ sliderChange: [id: string, value: number] }>()
function update(event: Event): void {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const value = input.valueAsNumber
  if (Number.isFinite(value)) emit('sliderChange', props.node.id, value)
  // Shared bindings can be rejected by another slider's range/step rules.
  // Restore the authoritative local view after Vue has processed the event.
  void nextTick(() => { if (input.isConnected) input.value = String(props.node.value) })
}
</script>

<template>
  <div class="gui-slider">
    <div class="gui-slider-header"><span>{{ node.label }}</span><output>{{ node.value }}</output></div>
    <input type="range" :value="node.value" :min="node.min" :max="node.max" :step="node.step" :aria-label="node.label" @input="update">
  </div>
</template>

<style scoped>
.gui-slider { min-width: 0; padding: 4px 0; }
.gui-slider-header { display: flex; justify-content: space-between; gap: 16px; color: var(--text); }
.gui-slider-header output { color: var(--muted); font-variant-numeric: tabular-nums; }
.gui-slider input[type="range"] { width: 100%; margin: 8px 0; accent-color: var(--focus); cursor: pointer; }
.gui-slider input[type="range"]:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
</style>
