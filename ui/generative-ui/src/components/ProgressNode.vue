<script setup lang="ts">
import { computed } from 'vue'
import type { PreparedProgress } from '../types'
const props = defineProps<{ node: PreparedProgress }>()
const labels = { pending: '待开始', running: '进行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' }
const percent = computed(() => Math.round(props.node.value / props.node.max * 100))
</script>

<template>
  <section class="gui-progress" :aria-label="node.label">
    <div class="gui-progress-heading"><span>{{ node.label }}</span><span>{{ labels[node.status] }}</span></div>
    <progress :value="node.value" :max="node.max" :aria-label="node.label + '：' + labels[node.status]" />
    <p>{{ node.value }} / {{ node.max }}（{{ percent }}%）</p>
    <small>此进度由 Agent 提供，不代表系统任务的实际执行状态。</small>
  </section>
</template>

<style scoped>
.gui-progress { display: flex; flex-direction: column; min-width: 0; gap: 6px; color: var(--text); }
.gui-progress-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; overflow-wrap: anywhere; }
.gui-progress-heading > :first-child { font-weight: 600; }
.gui-progress progress { width: 100%; height: 16px; accent-color: var(--text); }
.gui-progress p { margin: 0; font-variant-numeric: tabular-nums; }
.gui-progress small { color: var(--muted); overflow-wrap: anywhere; }
</style>
