'use strict'

// Read-only projection over the live Cordis services. No second registry of
// business state: every list() reads the services that actually run the work.
function text(value, max) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max) }
function words(value) {
  const normalized = text(value, 2000).toLowerCase()
  const tokens = normalized.match(/[a-z0-9_]+|[㐀-鿿]/g) || []
  const han = normalized.match(/[㐀-鿿]+/g) || []
  for (const part of han) for (let i = 0; i < part.length - 1; i++) tokens.push(part.slice(i, i + 2))
  return Array.from(new Set(tokens))
}
function hitScore(query, capability) {
  const queryWords = words(query)
  if (!queryWords.length) return 0
  const target = words([capability.name, capability.description, capability.type, capability.source, ...(capability.keywords || [])].join(' '))
  const set = new Set(target)
  let score = 0
  for (const word of queryWords) if (set.has(word)) score += word.length > 1 ? 3 : 1
  if (capability.name && query.toLowerCase().includes(String(capability.name).toLowerCase())) score += 10
  return score
}
class CapabilityRegistry {
  constructor(ctx) { this.ctx = ctx }
  safe(fn, fallback) { try { return fn() } catch (_) { return fallback } }
  list() {
    const result = []
    const seen = new Set()
    const add = capability => {
      if (!capability || !capability.id || seen.has(capability.id)) return
      seen.add(capability.id); result.push(capability)
    }
    for (const tool of this.safe(() => this.ctx.tools.list(), [])) {
      add({ id: 'tool:' + tool.name, type: 'tool', name: tool.name, description: text(tool.description, 1200), source: tool.plugin || 'builtin', permission: tool.permission || 'read', status: tool.active === false ? 'disabled' : 'active', keywords: [tool.plugin || ''] })
    }
    for (const skill of this.safe(() => this.ctx.skillLibrary.list(), [])) {
      add({ id: 'skill:' + skill.id, type: 'skill', name: skill.name || skill.id, description: text(skill.description, 1200), source: skill.packageId || 'builtin', status: skill.enabled ? 'active' : 'disabled', keywords: [skill.packageId || ''] })
    }
    const workflows = this.safe(() => this.ctx.workflows.list(), { workflows: [] })
    for (const wf of workflows.workflows || []) {
      add({ id: 'workflow:' + wf.id, type: 'workflow', name: wf.name, description: text(wf.description, 1600), source: 'workflow', status: wf.status || 'saved', revision: wf.revision, keywords: (wf.nodes || []).map(node => node.title || node.type).slice(0, 30) })
    }
    const mcp = this.safe(() => this.ctx.mcp.status(), { servers: [] })
    for (const server of mcp.servers || []) {
      add({ id: 'mcp:' + server.id, type: 'mcp', name: server.name || server.id, description: text((server.serverInfo && server.serverInfo.name) || server.transport, 1400), source: server.packageId || 'mcp', transport: server.transport, permission: server.permission, status: server.status, keywords: [server.transport || ''] })
      for (const tool of server.tools || []) add({ id: 'mcp-tool:' + server.id + ':' + tool.name, type: 'mcp-tool', name: tool.name, description: text(tool.description, 1200), source: server.name || server.id, permission: server.permission || 'read', status: server.status === 'connected' ? 'active' : server.status, parent: 'mcp:' + server.id, keywords: [server.name || '', server.id] })
    }
    const packages = this.safe(() => this.ctx.extensions.list(), { packages: [] })
    for (const pkg of packages.packages || []) {
      add({ id: 'package:' + pkg.id, type: pkg.type, name: pkg.name || pkg.id, description: text(pkg.description, 1200), source: pkg.publisher || 'extension', version: pkg.version, status: pkg.active ? 'active' : pkg.enabled ? 'enabled' : 'disabled', keywords: [pkg.publisher || ''] })
    }
    return result
  }
  search(intent, options) {
    const limit = Math.max(1, Math.min(50, Number(options && options.limit) || 12))
    const types = options && Array.isArray(options.types) ? options.types : null
    return this.list()
      .filter(item => !types || types.includes(item.type))
      .map(item => ({ ...item, score: hitScore(intent, item) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit)
  }
  inspect(id) {
    return this.list().find(item => item.id === id) || null
  }
  summary() {
    const list = this.list(), counts = {}
    for (const item of list) counts[item.type] = (counts[item.type] || 0) + 1
    return { total: list.length, counts }
  }
}
module.exports = { CapabilityRegistry, hitScore, words }
