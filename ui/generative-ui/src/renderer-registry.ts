import type { Component } from 'vue'
import { createComponentRegistryBuilder } from './component-registry'
import type { ComponentRegistryBuilder } from './component-registry'
import ContainerNode from './components/ContainerNode.vue'
import FormNode from './components/FormNode.vue'
import InputNode from './components/InputNode.vue'
import CheckboxNode from './components/CheckboxNode.vue'
import TextNode from './components/TextNode.vue'
import SliderNode from './components/SliderNode.vue'
import ChartNode from './components/ChartNode.vue'
import ButtonNode from './components/ButtonNode.vue'
import TableNode from './components/TableNode.vue'
import FilterNode from './components/FilterNode.vue'
import ProgressNode from './components/ProgressNode.vue'
import FlowNode from './components/FlowNode.vue'
import MapNode from './components/MapNode.vue'
import VisualNode from './components/VisualNode.vue'

// Trusted embedding code can replace a registered renderer before build().
// New component names still require a protocol and validator change; registering
// a renderer never grants permission to perform actions or load model code.
export function createRendererRegistryBuilder(): ComponentRegistryBuilder<Component> {
  const builder = createComponentRegistryBuilder<Component>()
  builder.register('column', ContainerNode); builder.register('row', ContainerNode)
  builder.register('form', FormNode); builder.register('input', InputNode)
  builder.register('checkbox', CheckboxNode); builder.register('text', TextNode)
  builder.register('slider', SliderNode); builder.register('chart', ChartNode)
  builder.register('button', ButtonNode)
  builder.register('table', TableNode); builder.register('filter', FilterNode)
  builder.register('progress', ProgressNode); builder.register('flow', FlowNode); builder.register('map', MapNode)
  builder.register('visual', VisualNode)
  return builder
}
export const DEFAULT_RENDERER_REGISTRY = createRendererRegistryBuilder().build()
