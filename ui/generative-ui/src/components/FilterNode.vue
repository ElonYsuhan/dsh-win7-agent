<script setup lang="ts">
import { nextTick } from 'vue'
import type { PreparedFilter } from '../types'
const props = defineProps<{ node: PreparedFilter }>()
const emit = defineEmits<{ fieldChange: [id: string, value: string] }>()
function update(event: Event): void {
  const select = event.currentTarget
  if (!(select instanceof HTMLSelectElement) || !props.node.options.some(option => option.value === select.value)) return
  emit('fieldChange', props.node.id, select.value)
  void nextTick(() => { if (select.isConnected && select.value !== props.node.value) select.value = props.node.value })
}
</script>

<template>
  <label class="gui-filter">
    <span>{{ node.label }}</span>
    <select :value="node.value" @change="update">
      <option v-for="option in node.options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
  </label>
</template>

<style scoped>
.gui-filter { display: flex; flex-direction: column; min-width: 0; gap: 6px; color: var(--text); }
.gui-filter select { box-sizing: border-box; max-width: 100%; min-width: 0; min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
.gui-filter select:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.gui-filter span, .gui-filter option { overflow-wrap: anywhere; }
</style>
