<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { buildVisualDocument } from '../visual-document'
import type { PreparedVisual } from '../types'
const props = defineProps<{ node: PreparedVisual }>()
const source = ref(''), loaded = ref(false)
let objectUrl = ''
function release(): void { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = '' } }
function build(): void {
  release(); loaded.value = false
  try {
    objectUrl = URL.createObjectURL(new Blob([buildVisualDocument(props.node.html)], { type: 'text/html' }))
    source.value = objectUrl
  } catch (_) { source.value = '' }
}
watch(() => [props.node.html, props.node.title], build, { immediate: true })
onBeforeUnmount(release)
</script>

<template>
  <figure class="gui-visual">
    <figcaption>{{ node.title }}</figcaption>
    <iframe v-if="source" class="gui-visual-frame" :src="source" :title="node.title" sandbox referrerpolicy="no-referrer" :data-loaded="loaded" :style="{ height: node.height + 'px' }" @load="loaded = true" />
    <p v-else class="gui-visual-note" role="status">静态页面生成失败。</p>
    <p class="gui-visual-note">静态沙箱内容：不执行脚本、不访问网络或外部链接。</p>
  </figure>
</template>

<style scoped>
.gui-visual { width: 100%; min-width: 0; margin: 0; color: var(--text); }
.gui-visual figcaption { margin-bottom: 8px; font-weight: 600; overflow-wrap: anywhere; }
.gui-visual-frame { display: block; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
.gui-visual-note { margin: 8px 0 0; color: var(--muted); font-size: .9em; overflow-wrap: anywhere; }
</style>
