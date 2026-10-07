'use strict'

const not = (value) => value ? false : true
const CJK_RE = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF\uAC00-\uD7AF]/
const IMAGE_TOKENS = 1000
const DEFAULT_SUMMARY_CHARS = 12000
const DEFAULT_PER_MESSAGE_CHARS = 2400

function estimateTextTokens(text) {
  const value = String(text == null ? '' : text)
  if (value.length === 0) return 0
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const ch of value) {
    if (CJK_RE.test(ch)) cjk += 1
    else if (ch.charCodeAt(0) < 128) ascii += 1
    else other += 1
  }
  return Math.ceil(cjk + ascii / 4 + other / 2)
}

function estimateContentTokens(content) {
  if (content == null) return 0
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (not(part) || typeof part !== 'object') {
        total += estimateTextTokens(String(part))
        continue
      }
      if (part.type === 'text' || part.type === 'input_text') total += estimateTextTokens(part.text)
      else if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') total += IMAGE_TOKENS
      else total += estimateTextTokens(JSON.stringify(part))
    }
    return total
  }
  return estimateTextTokens(JSON.stringify(content))
}

function estimateMessageTokens(message) {
  if (not(message) || typeof message !== 'object') return 0
  let total = 4 + estimateContentTokens(message.content)
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = call && call.function ? call.function : {}
      total += 8 + estimateTextTokens(fn.name) + estimateTextTokens(fn.arguments)
    }
  }
  return total
}

function estimateMessagesTokens(messages) {
  let total = 3
  for (const message of (Array.isArray(messages) ? messages : [])) total += estimateMessageTokens(message)
  return total
}

function resolveBudget(settings) {
  const data = settings || {}
  return {
    contextWindow: Math.max(0, Number(data.contextWindowTokens) || 0),
    maxTokens: Math.max(0, Number(data.maxTokens) || 0),
    threshold: Math.min(0.98, Math.max(0.3, Number(data.contextCompressThreshold) || 0.8)),
    keepRecentMessages: Math.max(2, Math.min(500, Number(data.keepRecentMessages) || 50)),
    summaryMaxTokens: Math.max(128, Math.min(8192, Number(data.summaryMaxTokens) || 1024))
  }
}

function clip(text, max) {
  const value = String(text == null ? '' : text)
  const limit = Math.max(0, Number(max) || 0)
  if (limit === 0 || value.length <= limit) return value
  return value.slice(0, limit) + String.fromCharCode(10) + String.fromCharCode(0x5df2,0x622a,0x65ad)
}

function contentToText(content, imagePlaceholder) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (not(part)) continue
      if (part.type === 'text' || part.type === 'input_text') parts.push(part.text || '')
      else if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') parts.push(imagePlaceholder || '[' + String.fromCharCode(0x56fe,0x7247) + ']')
      else parts.push(JSON.stringify(part))
    }
    return parts.join('\n')
  }
  return JSON.stringify(content)
}

function groupMessages(messages) {
  const groups = []
  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message && message.role === 'tool' && groups.length > 0) {
      groups[groups.length - 1].end = index + 1
      continue
    }
    groups.push({ start: index, end: index + 1 })
  }
  return groups
}

function findCompactionBoundary(messages, options) {
  const list = Array.isArray(messages) ? messages : []
  const groups = groupMessages(list)
  if (groups.length === 0) return list.length
  const wanted = Math.max(1, Math.min(groups.length, Number(options && options.keepRecentMessages) || 1))
  let keep = wanted
  const budget = Math.max(0, Number(options && options.keepTokens) || 0)
  if (budget > 0) {
    while (keep > 1 && estimateMessagesTokens(list.slice(groups[groups.length - keep].start)) > budget) {
      keep -= 1
    }
  }
  return groups[groups.length - keep].start
}

function serializeMessages(messages, options) {
  const maxChars = Math.max(1000, Number(options && options.maxChars) || DEFAULT_SUMMARY_CHARS)
  const perMessage = Math.max(200, Number(options && options.perMessageChars) || DEFAULT_PER_MESSAGE_CHARS)
  const blocks = []
  for (const message of (Array.isArray(messages) ? messages : [])) {
    if (not(message)) continue
    const role = message.role || 'unknown'
    const pieces = [contentToText(message.content, '[\u56fe\u7247]')]
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call && call.function ? call.function : {}
        pieces.push('\u8c03\u7528\u5de5\u5177 ' + (fn.name || '?') + ' \u53c2\u6570 ' + clip(fn.arguments || '{}', 600))
      }
    }
    let text = pieces.join(String.fromCharCode(10))
    if (role === 'tool') text = '\u5de5\u5177\u7ed3\u679c ' + text
    blocks.push('[' + role + '] ' + clip(text, perMessage))
  }
  const joined = blocks.join(String.fromCharCode(10))
  if (joined.length <= maxChars) return joined
  return joined.slice(0, maxChars) + String.fromCharCode(10) + '[history truncated]'
}

function batchMessages(messages, maxChars) {
  const limit = Math.max(1000, Number(maxChars) || DEFAULT_SUMMARY_CHARS)
  const batches = []
  let current = []
  let size = 0
  for (const message of (Array.isArray(messages) ? messages : [])) {
    const cost = JSON.stringify(message).length
    if (current.length > 0 && size + cost > limit) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(message)
    size += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

function buildLocalMemory(previousText, messages) {
  const parts = []
  if (previousText) parts.push('Previous memory:\n' + clip(previousText, 2000))
  const userLines = []
  const assistantLines = []
  const tools = new Set()
  const refs = new Set()
  for (const message of (Array.isArray(messages) ? messages : [])) {
    if (not(message)) continue
    if (message.role === 'user') {
      const text = contentToText(message.content, '[\u56fe\u7247]').trim()
      if (text) userLines.push(clip(text, 200))
    }
    if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
      assistantLines.push(clip(message.content.trim(), 300))
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call && call.function ? call.function : {}
        if (fn.name) tools.add(fn.name)
        const parsed = safeParse(fn.arguments)
        if (parsed && typeof parsed === 'object') {
          for (const key of ['path', 'file', 'target', 'pattern', 'command']) {
            if (typeof parsed[key] === 'string') refs.add(key + '=' + clip(parsed[key], 120))
          }
        }
      }
    }
  }
  parts.push('User requests:\n' + userLines.slice(-10).join(String.fromCharCode(10)))
  parts.push('Recent conclusions:\n' + assistantLines.slice(-5).join(String.fromCharCode(10)))
  if (tools.size > 0) parts.push('Tools used: ' + Array.from(tools).join(', '))
  if (refs.size > 0) parts.push('Files and commands:\n' + Array.from(refs).slice(-20).join(String.fromCharCode(10)))
  parts.push('[local rule-based compression, may be incomplete]')
  return parts.join(String.fromCharCode(10) + String.fromCharCode(10))
}

function buildContextView(systemContent, messages, memory) {
  const list = Array.isArray(messages) ? messages : []
  const rawThrough = memory && Number.isFinite(Number(memory.through)) ? Number(memory.through) : 1
  const through = Math.max(1, Math.min(list.length, rawThrough))
  const marker = String.fromCharCode(10) + String.fromCharCode(10) + '[Compressed conversation memory]' + String.fromCharCode(10)
  const memoryBlock = memory && memory.text ? marker + memory.text : ''
  const view = [{ role: 'system', content: String(systemContent || '') + memoryBlock }]
  for (const message of list.slice(through)) view.push(message)
  return view
}

async function resolveMessage(message, options) {
  const limit = Math.max(2000, Number(options && options.limit) || 60000)
  const next = Object.assign({}, message)
  if (message.content === null || message.content === undefined) next.content = ''
  if (Array.isArray(message.content)) {
    const parts = []
    for (const part of message.content) {
      if (not(part) || typeof part !== 'object') {
        parts.push(part)
        continue
      }
      if (part.type === 'image' || part.type === 'input_image') {
        let url = ''
        try {
          if (typeof options.resolveImage === 'function') url = await options.resolveImage(part)
        } catch (error) {
          url = ''
        }
        if (url) parts.push({ type: 'image_url', image_url: { url } })
        else parts.push({ type: 'text', text: '[image omitted]' })
        continue
      }
      if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string' && part.text.length > limit) {
        parts.push(Object.assign({}, part, { text: clip(part.text, limit) }))
        continue
      }
      parts.push(part)
    }
    next.content = parts
    return next
  }
  if (typeof message.content === 'string' && message.content.length > limit) {
    next.content = clip(message.content, limit)
  }
  return next
}

async function buildPayloadMessages(options) {
  const view = buildContextView(options && options.systemContent, options && options.messages, options && options.memory)
  const limit = Math.max(2000, Number(options && options.toolResultChars) || 60000)
  const resolveImage = options && options.resolveImage
  const result = []
  for (const message of view) result.push(await resolveMessage(message, { resolveImage, limit }))
  return result
}

function isContextLengthError(error) {
  const text = String((error && error.message) || error || '')
  return /(maximum context length|context length|context_length|too many tokens|reduce the length|maximum context|context window|context overflow)/i.test(text)
}

module.exports = {
  estimateTextTokens,
  estimateContentTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  resolveBudget,
  contentToText,
  groupMessages,
  findCompactionBoundary,
  serializeMessages,
  batchMessages,
  buildLocalMemory,
  buildContextView,
  buildPayloadMessages,
  isContextLengthError
}
