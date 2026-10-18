'use strict'

const contract = require('../../contracts/mcp')
const policy = require('../../flow/mcp-policy')
const { McpManager } = require('../../mcp/manager')
const { createDocumentHost } = require('../../mcp/documents/host')

module.exports = {
  name: 'core/mcp',
  inject: ['agentConfig', 'tools', 'prompts', 'contracts'],
  apply(ctx) {
    const manager = new McpManager()
    const documents = createDocumentHost()
    const unregister = []
    let chain = Promise.resolve()
    let closed = false
    let lastError = ''

    function settingsData() {
      const settings = ctx.agentConfig.settings
      if (not(settings)) return {}
      if (typeof settings.all === 'function') return settings.all()
      return settings.data || {}
    }

    function status() {
      const value = manager.status()
      const enabled = !(settingsData().disabledBuiltinMcp || []).includes('documents')
      const builtin = documents.status(enabled)
      value.servers.unshift(builtin)
      value.tools += builtin.tools.length
      value.available = value.connected + (enabled ? 1 : 0)
      value.error = lastError
      value.protocolVersion = contract.PROTOCOL_VERSION
      value.httpProtocolVersion = contract.HTTP_PROTOCOL_VERSION
      value.supportedProtocolVersions = contract.SUPPORTED_PROTOCOL_VERSIONS.slice()
      return value
    }

    async function unregisterTools() {
      const pending = unregister.splice(0, unregister.length)
      for (const off of pending) {
        try { await off() } catch (error) {}
      }
    }

    async function sync() {
      if (closed) return status()
      await unregisterTools()
      lastError = ''
      const servers = contract.normalizeServers(settingsData().mcpServers)
      await manager.start(servers)
      if (closed) return status()
      if (!(settingsData().disabledBuiltinMcp || []).includes('documents')) {
        for (const tool of documents.definitions) {
          unregister.push(ctx.tools.register({
            name: contract.toolName('documents', tool.name), plugin: 'core/mcp',
            permission: tool.permission, description: '[内置文档 MCP / Document Tools] ' + tool.description,
            parameters: tool.inputSchema,
            execute: async (args, toolCtx) => {
              try { return await documents.execute(tool, args, toolCtx) }
              catch (error) { if (toolCtx.signal.aborted) throw new Error('ABORTED'); return 'ERROR: ' + error.message }
            }
          }))
        }
      }
      for (const server of manager.status().servers) {
        if (server.status !== 'connected') continue
        for (const tool of policy.exposedTools(server.config, server.tools)) {
          const off = ctx.tools.register({
            name: tool.name,
            plugin: 'core/mcp',
            permission: server.permission,
            description: '[MCP:' + server.name + '] ' + (tool.description || tool.rawName),
            parameters: tool.parameters,
            execute: async (args, toolCtx) => {
              try {
                return await manager.call(server.id, tool.rawName, args, { signal: toolCtx && toolCtx.signal })
              } catch (error) {
                if (String(error && error.message) === 'ABORTED') throw error
                return 'ERROR: ' + String((error && error.message) || error)
              }
            }
          })
          unregister.push(off)
        }
      }
      return status()
    }


    function schedule() {
      chain = chain.then(() => sync()).catch((error) => {
        lastError = String((error && error.message) || error).slice(0, 2000)
        return status()
      })
      return chain
    }

    const service = {
      ready: () => chain,
      reload: () => schedule(),
      status: () => status(),
      test: (raw) => manager.probe(raw)
    }

    ctx.effect(() => ctx.prompts.add(() => 'Built-in mcp__documents tools read/create/edit DOCX and XLSX offline. Always use the current workspace; read before editing and pass its revision; edits save a NEW output file. Explain unsupported complex formatting. Do not claim formulas were recalculated. MCP tools, when configured, are exposed with the prefix mcp__<server>__<tool>. Use an MCP tool only when its description matches the task, and treat its result as external tool output. Never claim an MCP call succeeded unless the tool output says so.'))
    ctx.contracts.assertService('mcp', service)
    ctx.provide('mcp', service)
    ctx.effect(() => () => {
      closed = true
      return unregisterTools().then(() => Promise.all([manager.stop(), documents.close()]))
    })
    schedule()
  }
}

const not = (value) => value ? false : true
