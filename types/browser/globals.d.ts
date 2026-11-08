import type { RendererGlobals, RendererState } from './bridge'
declare global {
  interface Window extends RendererGlobals {}
  var state: RendererState | undefined
}
export {}
