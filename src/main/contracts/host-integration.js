'use strict'

const VERSION = 1
const NAME = /^(?!.*__)[A-Za-z][A-Za-z0-9_-]{0,23}$/
function fail(message) { const error = new Error(message); error.status = 400; throw error }
function tools(value) {
  if (!Array.isArray(value) || value.length > 64) fail('HOST_TOOLS_INVALID')
  const names = new Set()
  return value.map(tool => {
    if (!tool || !NAME.test(tool.name) || names.has(tool.name) || !['read', 'write', 'command'].includes(tool.permission)) fail('HOST_TOOL_INVALID')
    names.add(tool.name)
    if (!tool.parameters || tool.parameters.type !== 'object' || JSON.stringify(tool.parameters).length > 16000) fail('HOST_SCHEMA_INVALID')
    return { name: tool.name, description: String(tool.description || '').slice(0, 2000), permission: tool.permission, parameters: tool.parameters }
  })
}
function message(value) {
  if (!value || typeof value.text !== 'string' || !value.text.trim() || !/^[A-Za-z0-9_-]{8,100}$/.test(value.requestId || '')) fail('MESSAGE_INVALID')
  // Serialized UTF-8 bytes are bounded at the HTTP boundary; do not reject an
  // otherwise valid long conversation because of a separate message-count cap.
  if (value.history !== undefined && (!Array.isArray(value.history) || value.history.some(item => !item || !['user', 'assistant', 'tool'].includes(item.role)))) fail('HISTORY_INVALID')
  return { text: value.text, requestId: value.requestId, history: value.history || [], memory: null }
}
module.exports = { VERSION, NAME, tools, message }
