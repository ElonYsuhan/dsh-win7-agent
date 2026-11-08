// Compile-time representation of the v1 protocol. Runtime validation always
// goes through src/main/contracts/generative-ui.js, the authoritative schema.
export type StateValue = string | number | boolean | null
export type SurfaceState = Readonly<Record<string, StateValue>>

interface ComponentBase { readonly id: string }
export interface ContainerComponent extends ComponentBase {
  readonly type: 'column' | 'row'
  readonly children: readonly string[]
}
export interface FormComponent extends ComponentBase {
  readonly type: 'form'
  readonly label: string
  readonly children: readonly string[]
}
export interface TextInputComponent extends ComponentBase {
  readonly type: 'input'
  readonly label: string
  readonly stateKey: string
  readonly maxLength: number
}
export interface CheckboxComponent extends ComponentBase {
  readonly type: 'checkbox'
  readonly label: string
  readonly stateKey: string
}
export interface TextComponent extends ComponentBase {
  readonly type: 'text'
  readonly text: string
}
export interface SliderComponent extends ComponentBase {
  readonly type: 'slider'
  readonly label: string
  readonly stateKey: string
  readonly min: number
  readonly max: number
  readonly step: number
}
export interface ChartSeries {
  readonly id: string
  readonly name: string
  readonly values: readonly number[]
}
export interface ChartComponent extends ComponentBase {
  readonly type: 'chart'
  readonly chartType: 'line' | 'bar'
  readonly title: string
  readonly labels: readonly string[]
  readonly series: readonly ChartSeries[]
  readonly multiplierKey?: string
}
export interface ButtonComponent extends ComponentBase {
  readonly type: 'button'
  readonly label: string
  readonly actionId: string
}
export type ProgressStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export interface FilterOption { readonly value: string; readonly label: string }
export interface FilterComponent extends ComponentBase {
  readonly type: 'filter'; readonly label: string; readonly stateKey: string; readonly options: readonly FilterOption[]
}
export interface TableColumn { readonly id: string; readonly label: string }
export interface TableRow { readonly id: string; readonly cells: readonly StateValue[] }
export interface TableComponent extends ComponentBase {
  readonly type: 'table'; readonly title: string; readonly columns: readonly TableColumn[]; readonly rows: readonly TableRow[]
  readonly selectionKey?: string; readonly filterKey?: string; readonly filterColumn?: string
}
export interface ProgressComponent extends ComponentBase {
  readonly type: 'progress'; readonly label: string; readonly valueKey: string; readonly max: number; readonly status: ProgressStatus
}
export interface FlowNode { readonly id: string; readonly label: string; readonly status: ProgressStatus }
export interface FlowEdge { readonly from: string; readonly to: string; readonly label?: string }
export interface FlowComponent extends ComponentBase {
  readonly type: 'flow'; readonly title: string; readonly nodes: readonly FlowNode[]; readonly edges: readonly FlowEdge[]; readonly selectionKey: string
}
export interface MapPoint { readonly id: string; readonly label: string; readonly longitude: number; readonly latitude: number }
export interface MapComponent extends ComponentBase {
  readonly type: 'map'; readonly title: string; readonly points: readonly MapPoint[]; readonly selectionKey: string
}
export interface VisualComponent extends ComponentBase {
  readonly type: 'visual'; readonly title: string; readonly html: string; readonly height?: number
}
export type Component = ContainerComponent | FormComponent | TextInputComponent | CheckboxComponent | TextComponent | SliderComponent | ChartComponent | ButtonComponent | FilterComponent | TableComponent | ProgressComponent | FlowComponent | MapComponent | VisualComponent
export type ComponentKind = Component['type']
export interface AskAgentAction {
  readonly id: string
  readonly type: 'ask_agent'
  readonly message: string
  readonly stateKeys: readonly string[]
}
export interface Surface {
  readonly version: 1 | 2
  readonly id: string
  readonly revision: number
  readonly title: string
  readonly root: string
  readonly state: SurfaceState
  readonly components: readonly Component[]
  readonly actions: readonly AskAgentAction[]
}
export interface SurfaceView {
  readonly sessionId: string
  readonly surface: Surface
  // Local presentation state only, not a persisted fact or authorization.
  readonly state: SurfaceState
}
export interface ChartTableRow {
  readonly label: string
  readonly values: readonly number[]
}
export interface ChartData {
  readonly id: string
  readonly title: string
  readonly chartType: 'line' | 'bar'
  readonly labels: readonly string[]
  readonly series: readonly ChartSeries[]
  readonly rows: readonly ChartTableRow[]
}

// This tree contains only data understood by trusted renderers. It is not a
// virtual DOM and never contains HTML, arbitrary attributes, or callbacks.
export interface PreparedContainer {
  readonly id: string
  readonly type: 'column' | 'row'
  readonly children: readonly PreparedNode[]
}
export interface PreparedForm {
  readonly id: string
  readonly type: 'form'
  readonly label: string
  readonly children: readonly PreparedNode[]
}
export interface PreparedInput {
  readonly id: string
  readonly type: 'input'
  readonly label: string
  readonly value: string
  readonly maxLength: number
}
export interface PreparedCheckbox {
  readonly id: string
  readonly type: 'checkbox'
  readonly label: string
  readonly value: boolean
}
export interface PreparedText { readonly id: string; readonly type: 'text'; readonly text: string }
export interface PreparedSlider {
  readonly id: string
  readonly type: 'slider'
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
}
export interface PreparedChart { readonly id: string; readonly type: 'chart'; readonly data: ChartData }
export interface PreparedButton {
  readonly id: string
  readonly type: 'button'
  readonly label: string
  readonly actionId: string
  readonly disabled: boolean
  readonly disabledReason: string
}
export interface PreparedFilter {
  readonly id: string; readonly type: 'filter'; readonly label: string; readonly value: string; readonly options: readonly FilterOption[]
}
export interface PreparedTable {
  readonly id: string; readonly type: 'table'; readonly title: string; readonly columns: readonly TableColumn[]; readonly rows: readonly TableRow[]; readonly selected: string; readonly selectable: boolean
}
export interface PreparedProgress {
  readonly id: string; readonly type: 'progress'; readonly label: string; readonly value: number; readonly max: number; readonly status: ProgressStatus
}
export interface PreparedFlow {
  readonly id: string; readonly type: 'flow'; readonly title: string; readonly nodes: readonly FlowNode[]; readonly edges: readonly FlowEdge[]; readonly selected: string
}
export interface PreparedMap {
  readonly id: string; readonly type: 'map'; readonly title: string; readonly points: readonly MapPoint[]; readonly selected: string
}
export interface PreparedVisual {
  readonly id: string; readonly type: 'visual'; readonly title: string; readonly html: string; readonly height: number
}
export type PreparedNode = PreparedContainer | PreparedForm | PreparedInput | PreparedCheckbox | PreparedText | PreparedSlider | PreparedChart | PreparedButton | PreparedFilter | PreparedTable | PreparedProgress | PreparedFlow | PreparedMap | PreparedVisual
