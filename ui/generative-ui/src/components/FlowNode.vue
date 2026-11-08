<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { layoutFlow } from '../flow-layout'
import type { PreparedFlow } from '../types'
const props = defineProps<{ node: PreparedFlow }>()
const emit = defineEmits<{ fieldChange: [id: string, value: string] }>()
const diagram = shallowRef(layoutFlow(props.node))
watch([() => props.node.nodes, () => props.node.edges], () => { diagram.value = layoutFlow(props.node) }, { flush: 'sync' })
const labels = { pending: '待开始', running: '进行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' }
const names = computed(() => new Map(props.node.nodes.map(node => [node.id, node.label])))
function short(label: string): string { const chars = Array.from(label); return chars.length > 11 ? chars.slice(0, 10).join('') + '…' : label }
function select(id: string): void { emit('fieldChange', props.node.id, id) }
</script>

<template>
  <figure class="gui-flow">
    <figcaption>{{ node.title }}</figcaption>
    <div class="gui-flow-scroll" tabindex="0" role="region" :aria-label="node.title + '，可滚动流程图'">
      <svg :width="diagram.width" :height="diagram.height" :viewBox="'0 0 ' + diagram.width + ' ' + diagram.height" role="img" :aria-label="node.title + '；节点与连线详情见下方列表'">
        <g aria-hidden="true" class="gui-flow-edges"><template v-for="edge in diagram.edges" :key="edge.key"><path v-if="edge.routed" :d="edge.path" /><path v-if="edge.routed" :d="edge.arrow" class="gui-flow-arrow" /></template></g>
        <g v-for="item in diagram.nodes" :key="item.id" :transform="'translate(' + item.x + ' ' + item.y + ')'" :class="['gui-flow-node', { 'gui-flow-selected': node.selected === item.id }]" aria-hidden="true" @click="select(item.id)">
          <title>{{ item.label }}：{{ labels[item.status] }}</title><rect :width="item.width" :height="item.height" rx="7" /><text x="12" y="28">{{ short(item.label) }}</text><text class="gui-flow-status" x="12" y="52">{{ labels[item.status] }}</text>
        </g>
      </svg>
    </div>
    <p class="gui-flow-hint">可点击图中节点，或使用下方按钮选择；状态由 Agent 提供，不会启动系统流程。</p>
    <ul class="gui-flow-nodes"><li v-for="item in node.nodes" :key="item.id"><button type="button" :aria-pressed="node.selected === item.id" @click="select(item.id)"><span>{{ item.label }}</span><small>{{ labels[item.status] }}</small></button></li></ul>
    <p class="gui-flow-selection" role="status"><span>{{ node.selected ? '已选节点：' + names.get(node.selected) : '尚未选择节点。' }}</span><button v-if="node.selected" type="button" @click="select('')">清除节点选择</button></p>
    <details v-if="diagram.edges.length" class="gui-flow-connections"><summary>查看连线详情</summary><ul><li v-for="edge in diagram.edges" :key="edge.key">{{ names.get(edge.from) }} → {{ names.get(edge.to) }}<span v-if="edge.label">：{{ edge.label }}</span><span v-if="!edge.routed">（图中线路空间不足，请以此记录为准）</span></li></ul></details>
  </figure>
</template>

<style scoped>
.gui-flow { width: 100%; max-width: 100%; min-width: 0; margin: 0; color: var(--text); }
.gui-flow figcaption { margin-bottom: 8px; font-weight: 600; overflow-wrap: anywhere; }
.gui-flow-scroll { max-width: 100%; max-height: 480px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.gui-flow svg { display: block; max-width: none; background: var(--panel); }
.gui-flow-edges path { fill: none; stroke: var(--muted); stroke-width: 1.5; }
.gui-flow-edges .gui-flow-arrow { fill: var(--muted); stroke: none; }
.gui-flow-node { cursor: pointer; }
.gui-flow-node rect { fill: var(--panel); stroke: var(--border); stroke-width: 1.5; }
.gui-flow-node text { fill: var(--text); font: 14px sans-serif; }
.gui-flow-node .gui-flow-status { fill: var(--muted); font-size: 12px; }
.gui-flow-selected rect { stroke: var(--focus); stroke-width: 3; }
.gui-flow-hint, .gui-flow-connections { color: var(--muted); overflow-wrap: anywhere; }
.gui-flow-hint { margin: 8px 0; font-size: 0.9em; }
.gui-flow-nodes { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.gui-flow-nodes li { min-width: 0; max-width: 100%; }
.gui-flow button { max-width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; cursor: pointer; overflow-wrap: anywhere; text-align: left; }
.gui-flow-nodes button { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.gui-flow-nodes small { color: var(--muted); }
.gui-flow button[aria-pressed="true"] { border-color: var(--focus); font-weight: 600; }
.gui-flow button:focus-visible, .gui-flow-scroll:focus-visible, .gui-flow-connections summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.gui-flow-selection { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; color: var(--muted); overflow-wrap: anywhere; }
.gui-flow-connections summary { cursor: pointer; }
.gui-flow-connections ul { padding-left: 22px; }
</style>
