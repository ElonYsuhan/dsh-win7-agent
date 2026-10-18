'use strict'

// Pure MCP exposure policy. Transport, process and network side effects stay in
// the mcp adapter and runtime plugin.
const contract = require('../contracts/mcp')

function enabled(server) {
  return Boolean(server) && server.enabled !== false
}

function exposedTools(server, tools) {
  if (enabled(server) === false) return []
  const seen = new Set()
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool === null || typeof tool !== 'object') continue
    const rawName = String(tool.name || '').trim()
    if (rawName === '' || seen.has(rawName)) continue
    seen.add(rawName)
    out.push({
      rawName,
      name: contract.toolName(server.id, rawName),
      description: String(tool.description || '').slice(0, 8192),
      parameters: contract.toolSchema(tool.inputSchema || tool.parameters)
    })
    if (out.length >= contract.MAX_TOOLS_PER_SERVER) break
  }
  return out
}

function statusLabel(status) {
  if (status === 'connected') return '\u5df2\u8fde\u63a5'
  if (status === 'connecting') return '\u8fde\u63a5\u4e2d'
  if (status === 'error') return '\u8fde\u63a5\u5931\u8d25'
  if (status === 'disabled') return '\u5df2\u505c\u7528'
  return '\u672a\u8fde\u63a5'
}

module.exports = { enabled, exposedTools, statusLabel }
