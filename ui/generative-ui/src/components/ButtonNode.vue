<script setup lang="ts">
import { NButton } from 'naive-ui'
import type { ActionIntent } from '../interaction-controller'
import type { PreparedButton } from '../types'
defineProps<{ node: PreparedButton }>()
const emit = defineEmits<{ action: [intent: ActionIntent] }>()
</script>

<template>
  <div class="gui-action">
    <NButton class="gui-action-button" :disabled="node.disabled" :title="node.disabledReason" @click="emit('action', { componentId: node.id, actionId: node.actionId })">{{ node.label }}</NButton>
    <p v-if="node.disabledReason" class="gui-action-note">{{ node.disabledReason }}</p>
  </div>
</template>

<style scoped>
.gui-action { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.gui-action-button, .gui-action-button :deep(.n-button__content) { color: var(--text) !important; }
.gui-action-button:disabled, .gui-action-button:disabled :deep(.n-button__content) { opacity: 1 !important; color: var(--muted) !important; }
.gui-action-note { margin: 0; color: var(--muted); font-size: 0.85em; }
</style>
