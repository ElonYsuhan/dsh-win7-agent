export type MemoryScope = 'user' | 'project' | 'session'
export type MemoryKind = 'fact' | 'preference' | 'profile' | 'experience' | 'inference'
export type MemoryStatus = 'active' | 'disabled' | 'superseded' | 'deleted'
export interface MemorySource { readonly type: string; readonly ref: string; readonly quote?: string }
export interface MemoryItem {
  readonly id: string
  readonly scope: MemoryScope
  readonly scopeId: string
  readonly kind: MemoryKind
  readonly key: string
  readonly content: string
  readonly confidence: number
  readonly status: MemoryStatus
  readonly source: MemorySource
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
  readonly expiresAt: number | null
}
export interface MemoryCandidate {
  readonly id: string
  readonly scope: MemoryScope
  readonly scopeId: string
  readonly kind: MemoryKind
  readonly key: string
  readonly content: string
  readonly confidence: number
  readonly source: MemorySource
  readonly reason: string
  readonly createdAt: number
}
export interface MemoryQuery {
  readonly query?: string
  readonly scope?: MemoryScope
  readonly scopeId?: string
  readonly sessionId?: string
  readonly status?: MemoryStatus
  readonly limit?: number
  readonly offset?: number
  readonly all?: boolean
}
export interface MemoryInput {
  readonly scope: MemoryScope
  readonly scopeId?: string
  readonly kind: MemoryKind
  readonly key?: string
  readonly content: string
  readonly confidence?: number
  readonly sourceType?: string
  readonly sourceRef?: string
  readonly quote?: string
  readonly expiresAt?: number | null
}
export interface MemorySearchResult { readonly items: readonly MemoryItem[]; readonly query: string; readonly total: number }
export interface MemoryFeedback { readonly sessionId: string; readonly task: string; readonly outcome: string; readonly capabilities: readonly string[]; readonly detail?: string; readonly workspaceRoot?: string }
export interface MemoryServiceView {
  remember(input: MemoryInput): Promise<MemoryItem>
  search(query: MemoryQuery): Promise<MemorySearchResult>
  list(query: MemoryQuery): Promise<MemorySearchResult>
  context(query: MemoryQuery): Promise<string>
  update(input: Readonly<Record<string, unknown>>): Promise<MemoryItem>
  forget(id: string): Promise<{ ok: boolean }>
  candidates(query: MemoryQuery): Promise<{ items: readonly MemoryCandidate[] }>
  confirm(input: { readonly id: string }): Promise<MemoryItem>
  reject(input: { readonly id: string; readonly reason?: string }): Promise<{ ok: boolean }>
  feedback(event: MemoryFeedback): Promise<{ ok: boolean; id: string }>
}
