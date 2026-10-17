'use strict'

// Repair legacy/client transcripts into complete contiguous tool exchanges.
function sanitizeHistory(messages) {
  const list = []
  let pending = new Set()
  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!raw || !['system', 'user', 'assistant', 'tool'].includes(raw.role)) continue
    if (raw.role === 'tool') {
      if (!pending.has(raw.tool_call_id)) continue
      pending.delete(raw.tool_call_id)
      list.push({ ...raw })
      continue
    }
    // Fill any unfinished batch BEFORE admitting the following user/assistant.
    for (const id of pending) list.push({ role: 'tool', tool_call_id: id, content: '(no result recorded)' })
    pending = new Set()
    const message = { ...raw }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.filter((call) => {
        if (!call || typeof call.id !== 'string' || pending.has(call.id) || !call.function || typeof call.function.name !== 'string') return false
        pending.add(call.id)
        return true
      })
    }
    list.push(message)
  }
  for (const id of pending) list.push({ role: 'tool', tool_call_id: id, content: '(no result recorded)' })
  return list
}
module.exports = { sanitizeHistory }
