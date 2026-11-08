<script setup lang="ts">
import { nextTick } from 'vue'
import type { PreparedCheckbox } from '../types'
const props = defineProps<{ node: PreparedCheckbox }>()
const emit = defineEmits<{ fieldChange: [id: string, value: string | boolean] }>()
function update(event: Event): void {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  emit('fieldChange', props.node.id, input.checked)
  void nextTick(() => { if (input.isConnected) input.checked = props.node.value })
}
</script>

<template>
  <label class="gui-checkbox"><input type="checkbox" :checked="node.value" @change="update"><span>{{ node.label }}</span></label>
</template>

<style scoped>
.gui-checkbox { display: inline-flex; align-items: baseline; min-width: 0; gap: 8px; color: var(--text); }
.gui-checkbox input { flex: none; accent-color: var(--focus); }
.gui-checkbox span { overflow-wrap: anywhere; }
.gui-checkbox input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
