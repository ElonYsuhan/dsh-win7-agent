export interface UiCapabilities {
  readonly versions: readonly number[]
  readonly components: readonly string[]
}
export interface UiReadRequest {
  readonly version: 1
  readonly sessionId: string
  readonly surfaceId?: string
}
export interface UiChangeRequest {
  readonly version: 1
  readonly sessionId: string
  readonly surfaceId: string
  readonly revision: number
  readonly expectedStateVersion: number
  readonly requestId: string
  readonly componentId: string
  readonly value: string | number | boolean
}
export interface UiActionRequest {
  readonly version: 1
  readonly sessionId: string
  readonly surfaceId: string
  readonly revision: number
  readonly expectedStateVersion: number
  readonly requestId: string
  readonly componentId: string
  readonly actionId: string
}
export interface UiSnapshot {
  readonly version: 1
  readonly sessionId: string
  readonly sequence: number
  readonly surfaces: Readonly<Record<string, unknown>>
  readonly receipts: readonly unknown[]
}
export interface AppDialogs {
  confirm(message: string, options?: Readonly<Record<string, unknown>>): Promise<boolean>
  prompt(message: string, options?: Readonly<Record<string, unknown>>): Promise<string | null>
  alert(message: string, options?: Readonly<Record<string, unknown>>): Promise<void>
}
export interface FileEntry { readonly name: string; readonly path: string; readonly dir?: boolean }
export interface FileRoot { readonly name?: string; readonly path: string }
export interface FilePanel { openFile(path: string): void }
export interface ShellBridge { pickFolder?(): Promise<string>; close?(): Promise<unknown>; openPath?(path: string): Promise<string>; openExternal?(url: string): Promise<unknown> }
export interface RendererEvent { readonly type?: string; readonly sessionId?: string; readonly [key: string]: unknown }
export interface DshBridge {
  readonly isDesktop: boolean
  send(
    text: string,
    history?: readonly unknown[],
    images?: readonly unknown[],
    memory?: unknown,
    sessionId?: string,
    uiCapabilities?: UiCapabilities | null
  ): Promise<boolean>
  generativeUiRead(request: UiReadRequest): Promise<UiSnapshot>
  generativeUiChange(request: UiChangeRequest): Promise<UiSnapshot>
  generativeUiAction(request: UiActionRequest, capabilities?: UiCapabilities | null): Promise<UiSnapshot>
  stop(sessionId?: string): Promise<unknown>
  resetChat(sessionId?: string): Promise<unknown>
  clearChat(sessionId?: string): Promise<unknown>
  openPath(target: string): Promise<string>
  openExternal(target: string): Promise<unknown>
  fsRoots(): Promise<{ readonly roots: readonly FileRoot[] }>
  fsTree(target: string, depth?: number): Promise<{ readonly entries: readonly FileEntry[] }>
  onEvent(callback: (event: RendererEvent) => void): () => void
  readonly [key: string]: unknown
}
export interface RendererState {
  settings?: { readonly projects?: readonly { readonly id?: string; readonly folders?: readonly string[] }[]; readonly currentProjectId?: string }
}
export interface RendererGlobals {
  dsh: DshBridge
  appDialogs: AppDialogs
  isDesktop?: boolean
  shell?: ShellBridge
  filePanel?: FilePanel
  copyToClipboard?(text: string): Promise<boolean>
  agentUI?: unknown
  renderMarkdown?(input: string): string
  state?: RendererState
  createGenerativeUIChat?(options: Readonly<Record<string, unknown>>): unknown
}
