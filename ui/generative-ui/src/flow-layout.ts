import * as autoLayout from '../../../src/renderer/workflow-auto-layout.js'
import * as linkRouting from '../../../src/renderer/workflow-link-routing.js'
import type { PreparedFlow } from './types'

type Point = [number, number]
interface Rectangle { readonly id: string; readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
interface Planned { readonly positions: Map<string, Point> }
interface Planner { plan(input: { nodes: readonly { id: string; width: number; height: number }[]; edges: PreparedFlow['edges']; direction: string; viewport: { width: number; height: number } }): Planned }
interface RoutedEdge { readonly id: string; readonly source: string; readonly target: string; readonly start: Point; readonly end: Point; readonly startDirection: string; readonly endDirection: string }
interface Router { create(rectangles: readonly Rectangle[]): { routeAll(edges: readonly RoutedEdge[]): Map<string, Point[] | null> }; commands(points: readonly Point[], rectangles: readonly Rectangle[], radius: number): unknown; svgPath(commands: unknown): string }
export interface FlowNodeLayout { readonly id: string; readonly label: string; readonly status: PreparedFlow['nodes'][number]['status']; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface FlowEdgeLayout { readonly key: string; readonly from: string; readonly to: string; readonly label: string; readonly path: string; readonly arrow: string; readonly routed: boolean }
export interface FlowLayout { readonly width: number; readonly height: number; readonly nodes: readonly FlowNodeLayout[]; readonly edges: readonly FlowEdgeLayout[] }
const planner = autoLayout as unknown as Planner
const routing = linkRouting as unknown as Router

export function layoutFlow(flow: PreparedFlow): FlowLayout {
  const nodeWidth = 176, nodeHeight = 72, margin = 24
  const planned = planner.plan({ nodes: flow.nodes.map(node => ({ id: node.id, width: nodeWidth, height: nodeHeight })), edges: flow.edges, direction: 'fit', viewport: { width: 720, height: 440 } })
  const rectangles: Rectangle[] = flow.nodes.map(node => {
    const position = planned.positions.get(node.id)!
    return { id: node.id, left: position[0], top: position[1], right: position[0] + nodeWidth, bottom: position[1] + nodeHeight }
  })
  const byId = new Map(rectangles.map(rectangle => [rectangle.id, rectangle]))
  const routes: RoutedEdge[] = flow.edges.map((edge, index) => {
    const source = byId.get(edge.from)!, target = byId.get(edge.to)!
    const sx = (source.left + source.right) / 2, sy = (source.top + source.bottom) / 2
    const tx = (target.left + target.right) / 2, ty = (target.top + target.bottom) / 2
    const horizontal = Math.abs(tx - sx) / nodeWidth >= Math.abs(ty - sy) / nodeHeight
    return {
      id: String(index), source: edge.from, target: edge.to,
      start: horizontal ? [tx >= sx ? source.right : source.left, sy] : [sx, ty >= sy ? source.bottom : source.top],
      end: horizontal ? [tx >= sx ? target.left : target.right, ty] : [tx, ty >= sy ? target.top : target.bottom],
      startDirection: horizontal ? tx >= sx ? 'right' : 'left' : ty >= sy ? 'down' : 'up',
      endDirection: horizontal ? tx >= sx ? 'left' : 'right' : ty >= sy ? 'up' : 'down'
    }
  })
  const paths = routing.create(rectangles).routeAll(routes)
  const allPoints = Array.from(paths.values()).flatMap(points => points || [])
  const left = Math.min(0, ...rectangles.map(rectangle => rectangle.left), ...allPoints.map(point => point[0])) - margin
  const top = Math.min(0, ...rectangles.map(rectangle => rectangle.top), ...allPoints.map(point => point[1])) - margin
  const right = Math.max(...rectangles.map(rectangle => rectangle.right), ...allPoints.map(point => point[0])) + margin
  const bottom = Math.max(...rectangles.map(rectangle => rectangle.bottom), ...allPoints.map(point => point[1])) + margin
  const shifted = rectangles.map(rectangle => ({ id: rectangle.id, left: rectangle.left - left, right: rectangle.right - left, top: rectangle.top - top, bottom: rectangle.bottom - top }))
  const edges = flow.edges.map((edge, index) => {
    const points = paths.get(String(index)), moved = points?.map(point => [point[0] - left, point[1] - top] as Point)
    let arrow = ''
    if (moved && moved.length >= 2) {
      const a = moved[moved.length - 2], b = moved[moved.length - 1], length = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (length > 0) {
        const dx = (b[0] - a[0]) / length, dy = (b[1] - a[1]) / length
        arrow = 'M ' + b.join(' ') + ' L ' + [b[0] - dx * 8 - dy * 4, b[1] - dy * 8 + dx * 4].join(' ') + ' L ' + [b[0] - dx * 8 + dy * 4, b[1] - dy * 8 - dx * 4].join(' ') + ' Z'
      }
    }
    return { key: String(index), from: edge.from, to: edge.to, label: edge.label || '', path: moved ? routing.svgPath(routing.commands(moved, shifted, 6)) : '', arrow, routed: !!moved }
  })
  return {
    width: Math.max(280, right - left), height: Math.max(120, bottom - top),
    nodes: flow.nodes.map(node => { const position = planned.positions.get(node.id)!; return { ...node, x: position[0] - left, y: position[1] - top, width: nodeWidth, height: nodeHeight } }),
    edges
  }
}
