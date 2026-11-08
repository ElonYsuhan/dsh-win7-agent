<script setup lang="ts">
import { nextTick } from 'vue'
import type { PreparedInput } from '../types'
const props = defineProps<{ node: PreparedInput }>()
const emit = defineEmits<{ fieldChange: [id: string, value: string | boolean] }>()
function update(event: Event): void {
  if (event.type === 'input' && (event as InputEvent).isComposing) return
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  emit('fieldChange', props.node.id, input.value)
  // Other fields can impose a smaller shared length limit. Do not reset an IME
  // while it is composing; restore a rejected value only after the commit.
  void nextTick(() => { if (input.isConnected && input.value !== props.node.value) input.value = props.node.value })
}
function keydown(event: KeyboardEvent): void {
  // The chat may itself sit inside a form. Enter must not submit it; preserve
  // IME confirmation, including Chromium's legacy keyCode during composition.
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) event.preventDefault()
}
</script>

<template>
  <label class="gui-input">
    <span>{{ node.label }}</span>
    <input type="text" :value="node.value" :maxlength="node.maxLength" autocomplete="off" @input="update" @compositionend="update" @keydown="keydown">
  </label>
</template>

<style scoped>
.gui-input { display: flex; flex-direction: column; min-width: 0; gap: 6px; color: var(--text); }
.gui-input input { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
.gui-input input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
