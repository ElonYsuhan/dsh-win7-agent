export type CapabilityType = 'tool' | 'skill' | 'workflow' | 'mcp' | 'mcp-tool' | 'plugin' | 'agent'
export interface Capability {
  readonly id: string
  readonly type: CapabilityType
  readonly name: string
  readonly description: string
  readonly source: string
  readonly status: string
  readonly permission?: string
  readonly revision?: number
  readonly version?: string
  readonly parent?: string
  readonly keywords?: readonly string[]
  readonly score?: number
}
export interface CapabilityServiceView {
  list(): readonly Capability[]
  search(intent: string, options?: { readonly types?: readonly CapabilityType[]; readonly limit?: number }): readonly Capability[]
  inspect(id: string): Capability | null
  summary(): { readonly total: number; readonly counts: Readonly<Record<string, number>> }
}
