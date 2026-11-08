import type { Capability } from './capability'
import type { MemoryItem, MemoryFeedback } from './memory'
export type AdaptiveDomain = 'report' | 'software' | 'data' | 'workflow' | 'communication' | 'general'
export type AdaptiveIntent = 'fix' | 'create' | 'analyze' | 'optimize' | 'setup' | 'answer'
export interface TaskAnalysis { readonly task: string; readonly intent: AdaptiveIntent; readonly domain: AdaptiveDomain; readonly complexity: number; readonly keywords: readonly string[] }
export interface PlanStep { readonly order: number; readonly type: Capability['type']; readonly id: string; readonly name: string; readonly reason: string; readonly status?: string }
export interface PlanGap { readonly kind: string; readonly reason: string; readonly suggestion?: string }
export interface AdaptivePlan { readonly analysis: TaskAnalysis; readonly memories: readonly Pick<MemoryItem, 'id' | 'kind' | 'content' | 'confidence'>[]; readonly capabilities: readonly Capability[]; readonly steps: readonly PlanStep[]; readonly gaps: readonly PlanGap[]; readonly requiresConfirmation: boolean }
export interface CapabilityDraft { readonly type: 'skill' | 'mcp' | 'plugin'; readonly name: string; readonly description: string }
export interface Recommendation { readonly id: string; readonly kind: string; readonly title: string; readonly reason: string; readonly action: string; readonly confidence: number; readonly draft?: CapabilityDraft }
export interface AdaptiveServiceView {
  analyze(task: Readonly<Record<string, unknown>>): TaskAnalysis
  plan(task: Readonly<Record<string, unknown>>): Promise<AdaptivePlan>
  recommend(task: Readonly<Record<string, unknown>>): Promise<{ analysis: TaskAnalysis; recommendations: readonly Recommendation[]; plan: readonly PlanStep[]; gaps: readonly PlanGap[] }>
  feedback(event: MemoryFeedback): Promise<{ ok: boolean; id: string }>
}
