'use strict'

const { MAX_TOOLS_PER_SERVER, toolName, toolSchema } = require('../contracts/mcp')

// Bounded discovery: never silently expose a partial or cyclic server catalogue.
async function listTools(client) {
  if (!client.capabilities || !client.capabilities.tools) return []
  const tools = [], cursors = new Set(), names = new Set(), exposed = new Set()
  let cursor
  for (let page = 0; page < MAX_TOOLS_PER_SERVER; page++) {
    const result = await client.request('tools/list', cursor === undefined ? {} : { cursor })
    if (!result || !Array.isArray(result.tools)) throw new Error('MCP_INVALID_TOOL_LIST')
    for (const tool of result.tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || !tool.inputSchema || tool.inputSchema.type !== 'object') throw new Error('MCP_INVALID_TOOL_DEFINITION')
      const name = toolName(client.config ? client.config.id : 'server', tool.name)
      if (exposed.has(name)) throw new Error('MCP_TOOL_NAME_COLLISION')
      toolSchema(tool.inputSchema)
      exposed.add(name); names.add(tool.name); tools.push(tool)
      if (tools.length > MAX_TOOLS_PER_SERVER) throw new Error('MCP_TOOL_LIMIT_EXCEEDED')
    }
    if (result.nextCursor === undefined) return tools
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error('MCP_INVALID_TOOL_CURSOR')
    cursors.add(result.nextCursor); cursor = result.nextCursor
  }
  throw new Error('MCP_TOOL_PAGE_LIMIT_EXCEEDED')
}
module.exports = { listTools }
