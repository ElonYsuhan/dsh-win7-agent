<script setup lang="ts">
import SurfaceRenderer from './SurfaceRenderer.vue'
import type { InteractionHost } from '../interaction-controller'
import type { ChartTheme } from '../chart-options'
import type { ProjectedMessage } from '../message-projection'

// Parts must come from the conversation-wide projectMessages() projection.
// The surrounding chat keeps ownership of its Markdown and legacy renderers.
defineProps<{ sessionId: string; message: ProjectedMessage; theme: ChartTheme; interactionHost?: InteractionHost; snapshot?: unknown }>()
</script>

<template>
  <template v-if="message.sessionId === sessionId">
    <template v-for="part in message.parts" :key="part.index">
      <slot v-if="part.kind === 'text'" name="text" :text="part.text"><span>{{ part.text }}</span></slot>
      <SurfaceRenderer v-else-if="part.kind === 'ui'" :key="sessionId + ':' + part.id" :session-id="sessionId" :surface="part.surface" :theme="theme" :interaction-host="interactionHost" :snapshot="snapshot" />
      <p v-else-if="part.kind === 'unavailable'" class="gui-unavailable" role="status">此界面暂不可用或版本不受支持。</p>
      <slot v-else-if="part.kind === 'other'" name="other" :value="part.value" />
    </template>
  </template>
  <p v-else class="gui-unavailable" role="status">此界面不属于当前会话。</p>
</template>

<style scoped>
.gui-unavailable { margin: 8px 0; color: var(--muted); }
</style>
