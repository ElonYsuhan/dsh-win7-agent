import type { Component, InjectionKey } from 'vue'
import type { ComponentRegistry } from './component-registry'

// Vue's per-app component context carries this UI registry only; runtime
// services, permissions and business state remain owned by Cordis.
export const RENDERER_REGISTRY: InjectionKey<ComponentRegistry<Component>> = Symbol('agent-ui-renderer-registry')
