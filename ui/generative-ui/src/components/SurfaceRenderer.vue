<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { NConfigProvider, darkTheme } from 'naive-ui'
import { createSurfaceView, prepareTree, replaceSurfaceView, restoreSurfaceState, updateField, updateSlider } from '../surface-view'
import { createInteractionController } from '../interaction-controller'
import type { ActionIntent, ChangeIntent, InteractionHost, InteractionPresentation } from '../interaction-controller'
import type { SurfaceView } from '../types'
import type { ChartTheme } from '../chart-options'
import SurfaceNode from './SurfaceNode.vue'

// One instance represents one surface in one session. Its caller must use a
// session/surface-specific key and pass immutable authoritative revisions.
const props = defineProps<{ sessionId: string; surface: unknown; theme: ChartTheme; interactionHost?: InteractionHost; snapshot?: unknown }>()
const emit = defineEmits<{ change: [intent: ChangeIntent]; action: [intent: ActionIntent]; reload: [] }>()
const view = shallowRef<SurfaceView | null>(null)
const message = shallowRef('')
const interaction = shallowRef<InteractionPresentation>()
let controller: ReturnType<typeof createInteractionController> | null = null
const owner = props.sessionId
let blocked = false
watch(() => [props.sessionId, props.surface] as const, ([sessionId, surface]) => {
  if (owner !== sessionId) { view.value = null; blocked = true; message.value = '此界面不属于当前会话。'; return }
  // Once unknown/invalid data for this instance is observed, do not restore a
  // possibly stale old revision; a new keyed instance must be mounted instead.
  if (blocked) return
  try {
    view.value = view.value ? replaceSurfaceView(view.value, sessionId, surface) : createSurfaceView(sessionId, surface)
    message.value = ''
  } catch (_) {
    view.value = null; blocked = true; message.value = '此界面暂不可用或版本不受支持。'
  }
}, { immediate: true, flush: 'sync' })
watch([() => props.interactionHost, () => view.value?.surface], ([host, surface]) => {
  if (controller) controller.dispose()
  controller = null; interaction.value = undefined
  if (host && surface && !blocked) controller = createInteractionController(owner, surface, host, value => { interaction.value = value })
}, { immediate: true, flush: 'sync' })
watch(() => props.snapshot, snapshot => {
  if (!controller || !snapshot || blocked) return
  try { controller.receive(snapshot) }
  catch (_) { view.value = null; blocked = true; message.value = '交互记录不符合界面约束。' }
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { if (controller) controller.dispose() })
watch(interaction, value => {
  if (!value || !view.value || blocked || value.revision !== view.value.surface.revision) return
  try { view.value = restoreSurfaceState(view.value, value.state) }
  catch (_) { view.value = null; blocked = true; message.value = '交互记录不符合界面约束。' }
}, { immediate: true, flush: 'sync' })
const tree = computed(() => view.value ? prepareTree(view.value, interaction.value ? { enabled: interaction.value.canAct, reason: interaction.value.note } : undefined) : null)
function action(intent: ActionIntent): void { if (!blocked && interaction.value?.canAct) { if (controller) void controller.submit(intent); else emit('action', intent) } }
function reload(): void { if (controller) void controller.reload(); else emit('reload') }
function sliderChange(id: string, value: number): void {
  if (!view.value || view.value.sessionId !== props.sessionId || blocked) return
  try { view.value = updateSlider(view.value, id, value); message.value = ''; if (controller) controller.change({ componentId: id, value }); else emit('change', { componentId: id, value }) }
  catch (_) { message.value = '该数值不符合界面的约束。' }
}
function fieldChange(id: string, value: string | boolean): void {
  if (!view.value || view.value.sessionId !== props.sessionId || blocked) return
  try { view.value = updateField(view.value, id, value); message.value = ''; if (controller) controller.change({ componentId: id, value }); else emit('change', { componentId: id, value }) }
  catch (_) { message.value = '该输入不符合界面的约束。' }
}
</script>

<template>
  <NConfigProvider :theme="theme === 'dark' ? darkTheme : null">
    <section v-if="view && tree" class="gui-surface" :aria-label="view.surface.title">
      <h3 class="gui-title">{{ view.surface.title }}</h3>
      <SurfaceNode :node="tree" :theme="theme" @slider-change="sliderChange" @field-change="fieldChange" @action="action" />
      <p v-if="interaction" class="gui-message" role="status">{{ interaction.note }} <button type="button" class="gui-reload" @click="reload">重新读取</button></p>
      <p v-if="message" class="gui-message" role="status">{{ message }}</p>
    </section>
    <p v-else class="gui-message" role="status">{{ message || '界面暂不可用。' }}</p>
  </NConfigProvider>
</template>

<style scoped>
.gui-surface { min-width: 0; max-width: 100%; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); color: var(--text); }
.gui-title { margin: 0 0 14px; font-size: 1em; font-weight: 600; overflow-wrap: anywhere; }
.gui-reload { color: var(--text); background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; cursor: pointer; }
.gui-message { margin: 8px 0 0; color: var(--muted); }
</style>
