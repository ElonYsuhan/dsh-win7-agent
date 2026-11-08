import type { PreparedMap } from './types'
import type { ChartTheme } from './chart-options'

type Cesium = Pick<typeof import('@cesium/engine'), 'Cartesian3' | 'CesiumWidget' | 'Color' | 'ColorGeometryInstanceAttribute' | 'Credit' | 'CreditDisplay' | 'Ellipsoid' | 'EllipsoidGeometry' | 'EllipsoidOutlineGeometry' | 'GeometryInstance' | 'PerInstanceColorAppearance' | 'PointPrimitiveCollection' | 'Primitive' | 'ScreenSpaceEventType'> & { readonly version: string }
type Widget = InstanceType<Cesium['CesiumWidget']>
type Points = InstanceType<Cesium['PointPrimitiveCollection']>
export type MapBackend = 'loading' | 'cesium' | 'coordinates'
export interface MapController { update(node: PreparedMap, theme: ChartTheme): void; notifyLayout(): void; dispose(): void }
declare global { interface Window { AgentUICesium?: Cesium } }
let loading: Promise<Cesium> | null = null

function loadCesium(): Promise<Cesium> {
  if (window.AgentUICesium?.version === '1.104.0') return Promise.resolve(window.AgentUICesium)
  if (!loading) {
    loading = new Promise<Cesium>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'vendor/generative-ui/agent-ui-cesium.js'
      script.onload = () => {
        script.onload = null; script.onerror = null
        if (window.AgentUICesium?.version === '1.104.0') resolve(window.AgentUICesium)
        else { script.remove(); reject(new Error('GENERATIVE_UI_MAP_VERSION')) }
      }
      script.onerror = () => { script.onload = null; script.onerror = null; script.remove(); reject(new Error('GENERATIVE_UI_MAP_RESOURCE')) }
      document.head.appendChild(script)
    }).catch(error => { loading = null; throw error })
  }
  return loading
}

export function createMapController(element: HTMLElement, select: (id: string) => void, report: (backend: MapBackend) => void): MapController {
  let widget: Widget | null = null, points: Points | null = null, api: Cesium | null = null
  let data: PreparedMap | null = null, theme: ChartTheme = 'light'
  let frame: number | null = null, disposed = false, failed = false, pending = false
  let removeError: (() => void) | null = null, canvas: HTMLCanvasElement | null = null
  let observer: ResizeObserver | null = null
  const root = element.ownerDocument.defaultView || window
  function cleanup(): void {
    removeError?.(); removeError = null
    if (canvas) canvas.removeEventListener('webglcontextlost', lost)
    canvas = null; points = null
    const old = widget; widget = null
    if (old && !old.isDestroyed()) { old.screenSpaceEventHandler.removeInputAction(api!.ScreenSpaceEventType.LEFT_CLICK); old.destroy() }
    element.replaceChildren()
  }
  function fail(): void {
    if (failed || disposed) return
    failed = true
    cleanup()
    if (frame !== null) { root.cancelAnimationFrame(frame); frame = null }
    report('coordinates')
  }
  function lost(event: Event): void { event.preventDefault(); fail() }
  function style(): void {
    if (!widget || !api) return
    widget.scene.backgroundColor = api.Color.fromCssColorString(theme === 'dark' ? '#20252d' : '#edf3fa')
  }
  function refresh(): void {
    if (!widget || !points || !api || !data) return
    points.removeAll()
    for (const item of data.points) {
      points.add({ id: item.id, position: api.Cartesian3.fromDegrees(item.longitude, item.latitude, 18000), pixelSize: item.id === data.selected ? 15 : 10,
        color: api.Color.fromCssColorString(item.id === data.selected ? '#b46b14' : '#296fa3'), outlineColor: api.Color.WHITE, outlineWidth: 2 })
    }
    style(); widget.resize(); widget.scene.requestRender()
  }
  function create(): void {
    if (!api || !data) return
    // Plain-text credit avoids the engine's default online link and logo asset.
    api.CreditDisplay.cesiumCredit = new api.Credit('CesiumJS 1.104.0 · Apache-2.0', true)
    const options = { globe: false as const, baseLayer: false as const, skyBox: false as const, skyAtmosphere: false as const,
      scene3DOnly: true, requestRenderMode: true, maximumRenderTimeChange: Infinity, showRenderLoopErrors: false,
      contextOptions: { requestWebgl1: true, webgl: { alpha: false, antialias: false, preserveDrawingBuffer: false } }, msaaSamples: 1 }
    widget = new api.CesiumWidget(element, options)
    const geometry = api.EllipsoidGeometry.createGeometry(new api.EllipsoidGeometry({ radii: api.Ellipsoid.WGS84.radii, stackPartitions: 24, slicePartitions: 48, vertexFormat: api.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }))
    const outline = api.EllipsoidOutlineGeometry.createGeometry(new api.EllipsoidOutlineGeometry({ radii: api.Cartesian3.multiplyByScalar(api.Ellipsoid.WGS84.radii, 1.002, new api.Cartesian3()), stackPartitions: 6, slicePartitions: 12, subdivisions: 96 }))
    if (!geometry || !outline) throw new Error('GENERATIVE_UI_MAP_GEOMETRY')
    for (const [shape, color] of [[geometry, '#416676'], [outline, '#9fb9c5']] as const) {
      widget.scene.primitives.add(new api.Primitive({ geometryInstances: new api.GeometryInstance({ geometry: shape, attributes: { color: api.ColorGeometryInstanceAttribute.fromColor(api.Color.fromCssColorString(color)) } }),
        appearance: new api.PerInstanceColorAppearance({ flat: true, translucent: false, closed: shape === geometry }), asynchronous: false }))
    }
    points = widget.scene.primitives.add(new api.PointPrimitiveCollection()) as Points
    const first = data.points[0]
    widget.resize()
    const fovy = (widget.camera.frustum as import('@cesium/engine').PerspectiveFrustum).fovy
    const radius = api.Ellipsoid.WGS84.maximumRadius
    const altitude = radius / Math.sin(fovy / 2) * 1.1 - radius
    widget.camera.setView({ destination: api.Cartesian3.fromDegrees(first ? first.longitude : 0, first ? first.latitude : 20, altitude) })
    widget.scene.screenSpaceCameraController.minimumZoomDistance = 500000
    widget.scene.screenSpaceCameraController.maximumZoomDistance = 100000000
    widget.screenSpaceEventHandler.setInputAction((movement: { position: import('@cesium/engine').Cartesian2 }) => {
      if (!widget || !data) return
      const result = widget.scene.pick(movement.position)
      if (result && typeof result.id === 'string' && data.points.some(item => item.id === result.id)) select(result.id)
    }, api.ScreenSpaceEventType.LEFT_CLICK)
    canvas = widget.canvas; canvas.addEventListener('webglcontextlost', lost)
    removeError = widget.scene.renderError.addEventListener(fail)
    refresh(); report('cesium')
  }
  function flush(): void {
    frame = null
    if (disposed || failed || !data || !element.isConnected || element.clientWidth <= 0 || element.clientHeight <= 0) return
    if (!api) {
      if (pending) return
      pending = true
      loadCesium().then(value => { if (!disposed && !failed) { api = value; schedule() } }, fail).finally(() => { pending = false })
      return
    }
    try { if (!widget) create(); else refresh() } catch (_) { fail() }
  }
  function schedule(): void { if (!disposed && !failed && frame === null) frame = root.requestAnimationFrame(flush) }
  if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(schedule); observer.observe(element) }
  else root.addEventListener('resize', schedule)
  report('loading')
  return Object.freeze({
    update(node: PreparedMap, nextTheme: ChartTheme): void { if (!disposed && !failed) { data = node; theme = nextTheme; schedule() } },
    notifyLayout: schedule,
    dispose(): void {
      if (disposed) return
      disposed = true
      if (frame !== null) { root.cancelAnimationFrame(frame); frame = null }
      observer?.disconnect(); observer = null; root.removeEventListener('resize', schedule)
      cleanup(); data = null
    }
  })
}
