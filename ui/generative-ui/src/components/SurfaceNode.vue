<script setup lang="ts">
import { computed, inject } from 'vue'
import { RENDERER_REGISTRY } from '../renderer-registry-key'
import type { PreparedNode } from '../types'
import type { ActionIntent } from '../interaction-controller'
import type { ChartTheme } from '../chart-options'

const props = defineProps<{ node: PreparedNode; theme: ChartTheme }>()
const emit = defineEmits<{ sliderChange: [id: string, value: number]; fieldChange: [id: string, value: string | boolean]; action: [intent: ActionIntent] }>()
// The embedding app supplies a sealed, trusted component registry. Model data
// cannot add or replace implementations or name paths to load.
const registry = inject(RENDERER_REGISTRY)
if (!registry) throw new Error('GENERATIVE_UI_REGISTRY_INVALID: missing renderer registry')
const renderer = computed(() => registry.resolve(props.node.type))
function forward(id: string, value: number): void { emit('sliderChange', id, value) }
function forwardField(id: string, value: string | boolean): void { emit('fieldChange', id, value) }
function forwardAction(intent: ActionIntent): void { emit('action', intent) }
</script>

<template>
  <component :is="renderer" :node="node" :theme="theme" @slider-change="forward" @field-change="forwardField" @action="forwardAction" />
</template>
