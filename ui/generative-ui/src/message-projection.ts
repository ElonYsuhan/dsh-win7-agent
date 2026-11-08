import { assertBlock, VERSIONS } from '../../../src/main/contracts/generative-ui.js'
import { assertSessionId } from './surface-view'

// A projection is re-derived from the conversation facts; it is not another
// session store. Text and unknown legacy blocks remain in their original order.
export type ProjectedPart =
  | { readonly kind: 'text'; readonly index: number; readonly text: string }
  | { readonly kind: 'ui'; readonly index: number; readonly id: string; readonly toolCallId: string; readonly surface: unknown }
  | { readonly kind: 'unavailable'; readonly index: number }
  | { readonly kind: 'superseded'; readonly index: number }
  | { readonly kind: 'other'; readonly index: number; readonly value: unknown }
export interface ProjectedMessage { readonly sessionId: string; readonly parts: readonly ProjectedPart[] }
interface Position { readonly message: number; readonly part: number }
interface Latest { readonly at: Position; readonly kind: 'known' | 'opaque'; readonly revision?: number }
interface Message { readonly role?: unknown; readonly content?: unknown }

function blockId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const block = value as { surface?: unknown }
  if (!block.surface || typeof block.surface !== 'object' || Array.isArray(block.surface)) return null
  const id = (block.surface as { id?: unknown }).id
  // Future payloads are opaque. Only use a bounded string for correlation,
  // never as HTML, a path, an action, or a component to execute.
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null
}
function same(at: Position, message: number, part: number): boolean { return at.message === message && at.part === part }

export function projectMessages(sessionId: string, input: readonly Message[]): readonly ProjectedMessage[] {
  assertSessionId(sessionId)
  if (!Array.isArray(input)) throw new Error('GENERATIVE_UI_MESSAGE_INVALID: messages')
  const latest = new Map<string, Latest>()
  for (let messageIndex = 0; messageIndex < input.length; messageIndex += 1) {
    const message = input[messageIndex]
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
      const block = message.content[partIndex]
      if (!block || typeof block !== 'object' || block.type !== 'ui') continue
      const id = blockId(block)
      let supported = false
      try { assertBlock(block); supported = VERSIONS.includes(block.surface.version) } catch (_) {}
      if (!id) continue
      const previous = latest.get(id)
      const at = { message: messageIndex, part: partIndex }
      // An opaque or invalid newer block is a fail-closed barrier. Once one is
      // observed, old code cannot interpret or restore a v1 replacement.
      if (!supported) { latest.set(id, { at, kind: 'opaque' }); continue }
      if (previous && previous.kind === 'opaque') continue
      const revision = block.surface.revision as number
      if (!previous || revision > (previous.revision || 0)) latest.set(id, { at, kind: 'known', revision })
    }
  }
  return input.map((message, messageIndex) => {
    const content = message && message.content
    if (typeof content === 'string') return { sessionId, parts: [{ kind: 'text', index: 0, text: content }] }
    if (!Array.isArray(content)) return { sessionId, parts: [] }
    const parts: ProjectedPart[] = content.map((part, index) => {
      if (message.role === 'assistant' && part && typeof part === 'object' && part.type === 'ui') {
        const id = blockId(part), last = id ? latest.get(id) : undefined
        if (last && !same(last.at, messageIndex, index)) return { kind: 'superseded', index }
        try {
          assertBlock(part)
          if (VERSIONS.includes(part.surface.version) && id && last?.kind === 'known') return { kind: 'ui', index, id, toolCallId: part.toolCallId, surface: part.surface }
        } catch (_) {}
        return { kind: 'unavailable', index }
      }
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') return { kind: 'text', index, text: part.text }
      return { kind: 'other', index, value: part }
    })
    return { sessionId, parts }
  })
}
