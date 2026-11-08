export type ThemeName = 'light' | 'dark'
export type ServiceMode = 'local' | 'remote'
export interface ServiceHealth { readonly ok: boolean; readonly port?: number; readonly kind?: string; readonly health?: string; readonly detail?: string; readonly reason?: string }
export interface ShellConfig { readonly mode: ServiceMode; readonly serviceUrl?: string; readonly lastPort?: number; readonly theme: ThemeName }
export interface WindowState { readonly maximized: boolean; readonly fullScreen: boolean; readonly focused: boolean }
export interface ServiceManagerState { readonly pid?: number; readonly port: number; readonly healthy: boolean; readonly child?: unknown }
export interface UpdateDecision { readonly action: 'none' | 'update' | 'skip'; readonly reason?: string }
export interface ShellBridge {
  pickFolder(): Promise<string>
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<unknown>
  close(): Promise<unknown>
}
