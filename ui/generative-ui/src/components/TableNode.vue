<script setup lang="ts">
import { computed } from 'vue'
import type { PreparedTable, StateValue } from '../types'
const props = defineProps<{ node: PreparedTable }>()
const emit = defineEmits<{ fieldChange: [id: string, value: string] }>()
const selectedVisible = computed(() => props.node.rows.some(row => row.id === props.node.selected))
function display(value: StateValue): string { return value === null ? '—' : typeof value === 'boolean' ? value ? '是' : '否' : String(value) }
function select(id: string): void { if (props.node.selectable) emit('fieldChange', props.node.id, id) }
function rowLabel(row: PreparedTable['rows'][number]): string { return display(row.cells[0]) || row.id }
</script>

<template>
  <section class="gui-table" :aria-label="node.title">
    <div class="gui-data-scroll" tabindex="0" role="region" :aria-label="node.title + '，可横向滚动'">
      <table>
        <caption>{{ node.title }}</caption>
        <thead><tr><th v-if="node.selectable" scope="col">选择</th><th v-for="column in node.columns" :key="column.id" scope="col">{{ column.label }}</th></tr></thead>
        <tbody>
          <tr v-for="row in node.rows" :key="row.id" :class="{ 'gui-row-selected': node.selected === row.id }">
            <td v-if="node.selectable" class="gui-row-control"><button type="button" :aria-label="'选择行：' + rowLabel(row)" :aria-pressed="node.selected === row.id" @click="select(row.id)">{{ node.selected === row.id ? '已选' : '选择' }}</button></td>
            <th scope="row">{{ display(row.cells[0]) }}</th><td v-for="(value, index) in row.cells.slice(1)" :key="index">{{ display(value) }}</td>
          </tr>
          <tr v-if="!node.rows.length"><td :colspan="node.columns.length + (node.selectable ? 1 : 0)"><span role="status">没有符合筛选条件的数据。</span></td></tr>
        </tbody>
      </table>
    </div>
    <p v-if="node.selectable" class="gui-table-selection" role="status"><span>{{ node.selected ? '已选行：' + node.selected + (selectedVisible ? '' : '（当前筛选结果中不可见）') : '尚未选择行。' }}</span><button v-if="node.selected" type="button" @click="select('')">清除行选择</button></p>
  </section>
</template>

<style scoped>
.gui-table { width: 100%; max-width: 100%; min-width: 0; color: var(--text); }
.gui-data-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; }
.gui-table table { width: 100%; border-collapse: collapse; text-align: left; font-variant-numeric: tabular-nums; }
.gui-table caption { padding: 10px; text-align: left; font-weight: 600; overflow-wrap: anywhere; }
.gui-table th, .gui-table td { min-width: 64px; max-width: 300px; padding: 8px 10px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; vertical-align: top; }
.gui-table thead th { background: var(--panel); font-weight: 600; }
.gui-table tbody th { font-weight: 400; }
.gui-row-selected { outline: 2px solid var(--focus); outline-offset: -2px; }
.gui-row-control { width: 64px; }
.gui-table-selection { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 0; color: var(--muted); overflow-wrap: anywhere; }
.gui-table button { min-height: 36px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; cursor: pointer; }
.gui-table button[aria-pressed="true"] { border-color: var(--focus); font-weight: 600; }
.gui-table button:focus-visible, .gui-data-scroll:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
