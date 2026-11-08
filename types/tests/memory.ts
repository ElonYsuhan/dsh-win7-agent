import type { MemoryCandidate, MemoryInput, MemoryItem, MemoryServiceView } from '../core/memory'
import type { Capability, CapabilityServiceView } from '../core/capability'
import type { AdaptivePlan, AdaptiveServiceView, TaskAnalysis } from '../core/adaptive'
const input: MemoryInput = { scope: 'project', scopeId: '/work', kind: 'preference', content: '先给结论' }
const item = {} as MemoryItem
const candidate = {} as MemoryCandidate
const memory = {} as MemoryServiceView
const capability: Capability = { id: 'tool:read_file', type: 'tool', name: 'read_file', description: 'read', source: 'builtin', status: 'active' }
const capabilities = {} as CapabilityServiceView
const analysis: TaskAnalysis = { task: '修复代码', intent: 'fix', domain: 'software', complexity: 2, keywords: ['修复'] }
const plan: AdaptivePlan = { analysis, memories: [], capabilities: [capability], steps: [], gaps: [], requiresConfirmation: false }
const adaptive = {} as AdaptiveServiceView
void input; void item; void candidate; void memory; void capabilities; void plan; void adaptive
// @ts-expect-error memory scope is a closed union
const badScope: MemoryInput = { scope: 'global', kind: 'fact', content: 'x' }
// @ts-expect-error plan step types come from the capability union
const badStep: AdaptivePlan = { ...plan, steps: [{ order: 1, type: 'shell', id: 'x', name: 'x', reason: 'x' }] }
void badScope; void badStep
