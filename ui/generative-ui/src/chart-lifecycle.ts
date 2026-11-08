// Framework-neutral lifecycle for one trusted chart instance. The production
// adapter must use the real ECharts API, requestAnimationFrame and
// ResizeObserver, and must dispose this controller when its Vue node unmounts.
export interface ChartInstance {
  setOption(option: Readonly<Record<string, unknown>>, replace: boolean): void
  resize(): void
  dispose(): void
}
export interface ChartHostSize { readonly connected: boolean; readonly width: number; readonly height: number }
export interface ChartEnvironment {
  measure(): ChartHostSize
  create(): ChartInstance
  requestFrame(callback: () => void): number
  cancelFrame(handle: number): void
  onError(error: unknown): void
}
export interface ChartController {
  update(option: Readonly<Record<string, unknown>>): void
  notifyLayout(): void
  dispose(): void
}

export function createChartController(environment: ChartEnvironment): ChartController {
  let instance: ChartInstance | null = null
  let frame: number | null = null
  let option: Readonly<Record<string, unknown>> | null = null
  let dirty = false, needsResize = false, disposed = false, failed = false

  function report(error: unknown): void {
    failed = true
    const old = instance
    instance = null
    if (old) { try { old.dispose() } catch (_) {} }
    try { environment.onError(error) } catch (_) {}
  }
  function flush(): void {
    frame = null
    if (disposed || failed) return
    try {
      const size = environment.measure()
      // A Vue node can be mounted into a DocumentFragment or hidden panel.
      // Never initialize ECharts until it is connected and has a real box.
      if (!size.connected || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return
      if (!instance) {
        const created = environment.create()
        // Teardown may happen reentrantly during initialization.
        if (disposed || failed) { try { created.dispose() } catch (_) {}; return }
        instance = created; needsResize = true
      }
      if (dirty && option) {
        const current = option
        dirty = false
        instance.setOption(current, true)
      }
      if (disposed || failed || !instance) return
      if (needsResize) { needsResize = false; instance.resize() }
    } catch (error) { report(error) }
  }
  function schedule(): void {
    if (disposed || failed || frame !== null) return
    // requestFrame is asynchronous, like browser requestAnimationFrame.
    try { frame = environment.requestFrame(flush) } catch (error) { report(error) }
  }
  return Object.freeze({
    update(next: Readonly<Record<string, unknown>>): void {
      if (disposed || failed) return
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('GENERATIVE_UI_CHART_INVALID: option')
      option = next; dirty = true; schedule()
    },
    notifyLayout(): void {
      if (disposed || failed) return
      needsResize = true; schedule()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      let cancelError: unknown = null
      if (frame !== null) {
        try { environment.cancelFrame(frame) } catch (error) { cancelError = error }
        frame = null
      }
      const old = instance
      instance = null; option = null
      if (old) { try { old.dispose() } catch (error) { try { environment.onError(error) } catch (_) {} } }
      if (cancelError) { try { environment.onError(cancelError) } catch (_) {} }
    }
  })
}
