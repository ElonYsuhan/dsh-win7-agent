'use strict'

const contract = require('../contracts/mcp')
const { StdioClient } = require('./stdio-client')
const { HttpClient } = require('./http-client')

const not = (value) => value ? false : true

class McpManager {
  constructor(options) {
    this.options = options || {}
    this.servers = new Map()
    this.probes = new Set()
    this.stopped = true
    this.generation = 0
  }

  createClient(config) {
    return config.transport === 'http'
      ? new HttpClient(config, this.options)
      : new StdioClient(config, this.options)
  }

  current(generation) {
    return !this.stopped && this.generation === generation
  }

  async connect(config, generation) {
    if (!this.current(generation)) return
    const entry = { config, client: null, status: config.enabled ? 'connecting' : 'disabled', error: '', tools: [] }
    this.servers.set(config.id, entry)
    if (!config.enabled) return
    const client = entry.client = this.createClient(config)
    try {
      await client.start()
      if (!this.current(generation)) { await client.close(); return }
      const tools = await client.listTools()
      if (!this.current(generation)) { await client.close(); return }
      entry.tools = tools.slice(0, contract.MAX_TOOLS_PER_SERVER)
      entry.status = 'connected'
    } catch (error) {
      entry.status = 'error'
      entry.error = String((error && error.message) || error).slice(0, 2000)
      try { await client.close() } catch (closeError) {}
    }
  }

  async start(configs) {
    const normalized = contract.normalizeServers(configs)
    const generation = ++this.generation
    this.stopped = true
    await this.closeClients()
    if (generation !== this.generation) return this.status()
    this.servers.clear()
    this.stopped = false
    await Promise.all(normalized.map(config => this.connect(config, generation)))
    return this.status()
  }

  // Reconcile package changes without interrupting unrelated MCP connections.
  async reconcile(configs) {
    const normalized = contract.normalizeServers(configs)
    const wanted = new Map(normalized.map(config => [config.id, config]))
    const generation = ++this.generation
    this.stopped = false
    for (const [id, entry] of this.servers) {
      if (!this.current(generation)) return this.status()
      if (wanted.has(id) && JSON.stringify(wanted.get(id)) === JSON.stringify(entry.config)) continue
      if (entry.client) await entry.client.close()
      if (!this.current(generation)) return this.status()
      this.servers.delete(id)
    }
    for (const config of normalized) {
      if (!this.current(generation)) break
      if (!this.servers.has(config.id)) await this.connect(config, generation)
    }
    return this.status()
  }

  async stop() {
    const generation = ++this.generation
    this.stopped = true
    await this.closeClients()
    if (generation === this.generation) this.servers.clear()
  }

  async closeClients() {
    const clients = Array.from(this.probes)
    for (const entry of this.servers.values()) if (entry.client) clients.push(entry.client)
    await Promise.all(clients.map((client) => Promise.resolve(client.close()).catch(() => undefined)))
  }

  status() {
    const servers = Array.from(this.servers.values()).map((entry) => ({
      id: entry.config.id,
      name: entry.config.name,
      enabled: entry.config.enabled,
      transport: entry.config.transport,
      permission: entry.config.permission,
      status: entry.client && entry.status === 'connected' ? entry.client.status() : entry.status,
      error: entry.error || (entry.client && (entry.client.error || entry.client.exitError)) || '',
      serverInfo: entry.client ? entry.client.serverInfo : null,
      tools: entry.tools.map((tool) => ({
        name: String(tool.name || ''),
        description: String(tool.description || '').slice(0, 2000),
        inputSchema: tool.inputSchema || tool.parameters || { type: 'object', properties: {} },
        exposedName: contract.toolName(entry.config.id, tool.name)
      })),
      config: entry.config
    }))
    return {
      servers,
      connected: servers.filter((server) => server.status === 'connected').length,
      tools: servers.reduce((sum, server) => sum + server.tools.length, 0)
    }
  }

  entry(serverId) {
    const entry = this.servers.get(String(serverId || ''))
    if (not(entry) || entry.status !== 'connected' || not(entry.client)) throw new Error('MCP_SERVER_UNAVAILABLE: ' + serverId)
    return entry
  }

  async call(serverId, toolName, args, options) {
    const entry = this.entry(serverId)
    const result = await entry.client.callTool(toolName, args || {}, options || {})
    return contract.formatToolResult(result)
  }

  async probe(raw) {
    const config = contract.normalizeServer(raw, 0)
    if (not(config)) throw new Error('MCP_CONFIG_INVALID')
    const client = this.createClient(config)
    this.probes.add(client)
    try {
      await client.start()
      const tools = await client.listTools()
      return {
        ok: true,
        serverInfo: client.serverInfo,
        capabilities: client.capabilities,
        tools: tools.map((tool) => ({
          name: String(tool.name || ''),
          description: String(tool.description || '').slice(0, 2000),
          exposedName: contract.toolName(config.id, tool.name)
        }))
      }
    } finally {
      this.probes.delete(client)
      try { await client.close() } catch (error) {}
    }
  }
}

module.exports = { McpManager }
