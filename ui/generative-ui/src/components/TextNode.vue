<script setup lang="ts">
import type { PreparedText } from '../types'
defineProps<{ node: PreparedText }>()
</script>

<template>
  <p class="gui-text">{{ node.text }}</p>
</template>

<style scoped>
.gui-text { margin: 0; color: var(--text); overflow-wrap: anywhere; white-space: pre-wrap; }
</style>
