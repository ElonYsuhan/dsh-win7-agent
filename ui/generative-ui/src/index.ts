import { createApp, defineComponent, h, shallowRef } from 'vue'
import type { Component } from 'vue'
import { assertComponentRegistry } from './component-registry'
import type { ComponentRegistry } from './component-registry'
import { RENDERER_REGISTRY } from './renderer-registry-key'
import { createRendererRegistryBuilder, DEFAULT_RENDERER_REGISTRY } from './renderer-registry'
import UIMessageRenderer from './components/UIMessageRenderer.vue'
import SurfaceRenderer from './components/SurfaceRenderer.vue'
import { buildVisualDocument } from './visual-document'
import { projectMessages } from './message-projection'
import type { InteractionHost } from './interaction-controller'
import { assertSessionId } from './surface-view'
import type { ProjectedMessage } from './message-projection'
import type { ChartTheme } from './chart-options'

export { capabilities } from '../../../src/main/contracts/generative-ui.js'
export { projectMessages, createRendererRegistryBuilder, buildVisualDocument }
export type { InteractionHost } from './interaction-controller'
export interface SurfaceProps { readonly sessionId: string; readonly surface: unknown; readonly theme: ChartTheme; readonly interactionHost?: InteractionHost; readonly snapshot?: unknown }
export interface MessageProps { readonly sessionId: string; readonly message: ProjectedMessage; readonly theme: ChartTheme; readonly interactionHost?: InteractionHost; readonly snapshot?: unknown }
export interface MountedRenderer<T> { update(next: T): void; dispose(): void }

function checkHost(host: Element): void {
  if (!host || host.nodeType !== 1) throw new Error('GENERATIVE_UI_MOUNT_INVALID: host')
}
function checkTheme(theme: ChartTheme): void {
  if (theme !== 'light' && theme !== 'dark') throw new Error('GENERATIVE_UI_MOUNT_INVALID: theme')
}

// The host must be an empty, dedicated node owned by the surrounding chat.
// Calls are made by trusted application code, never directly by model data.
export function mountSurface(host: Element, initial: SurfaceProps, registry: ComponentRegistry<Component> = DEFAULT_RENDERER_REGISTRY): MountedRenderer<SurfaceProps> {
  checkHost(host); assertSessionId(initial.sessionId); checkTheme(initial.theme); assertComponentRegistry(registry)
  const owner = initial.sessionId, props = shallowRef<SurfaceProps>(initial)
  const root = defineComponent({ setup: () => () => h(SurfaceRenderer, props.value) })
  const app = createApp(root)
  app.provide(RENDERER_REGISTRY, registry)
  app.mount(host)
  let disposed = false
  return Object.freeze({
    update(next: SurfaceProps): void {
      if (disposed) return
      assertSessionId(next.sessionId); checkTheme(next.theme)
      if (next.sessionId !== owner) throw new Error('GENERATIVE_UI_MOUNT_INVALID: session mismatch')
      props.value = next
    },
    dispose(): void { if (!disposed) { disposed = true; app.unmount() } }
  })
}

// This form is useful to embedded clients; the current chat may instead mount
// individual surface blocks while retaining its existing Markdown renderer.
export function mountMessage(host: Element, initial: MessageProps, registry: ComponentRegistry<Component> = DEFAULT_RENDERER_REGISTRY): MountedRenderer<MessageProps> {
  checkHost(host); assertSessionId(initial.sessionId); checkTheme(initial.theme); assertComponentRegistry(registry)
  if (!initial.message || initial.message.sessionId !== initial.sessionId) throw new Error('GENERATIVE_UI_MOUNT_INVALID: message session')
  const owner = initial.sessionId, props = shallowRef<MessageProps>(initial)
  const root = defineComponent({ setup: () => () => h(UIMessageRenderer, props.value) })
  const app = createApp(root)
  app.provide(RENDERER_REGISTRY, registry)
  app.mount(host)
  let disposed = false
  return Object.freeze({
    update(next: MessageProps): void {
      if (disposed) return
      assertSessionId(next.sessionId); checkTheme(next.theme)
      if (next.sessionId !== owner || !next.message || next.message.sessionId !== owner) throw new Error('GENERATIVE_UI_MOUNT_INVALID: message session')
      props.value = next
    },
    dispose(): void { if (!disposed) { disposed = true; app.unmount() } }
  })
}
