'use strict'

// Pure MCP configuration and protocol vocabulary. No filesystem, process, HTTP
// or Cordis imports belong in this layer.
const PROTOCOL_VERSION = '2024-11-05'
const HTTP_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18'])
const CLIENT_NAME = 'agent-local'
const CLIENT_VERSION = '0.4.3'
const TRANSPORTS = Object.freeze(['stdio', 'http'])
const PERMISSIONS = Object.freeze(['read', 'write', 'edit', 'command'])
const MAX_SERVERS = 32
const MAX_TOOLS_PER_SERVER = 256
const MAX_NAME_LENGTH = 64
const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 300000

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringMap(value, limit) {
  const out = {}
  if (!object(value)) return out
  let count = 0
  for (const key of Object.keys(value)) {
    if (count >= (limit || 64)) break
    const name = String(key || '').trim()
    if (!name || name.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(name)) continue
    out[name] = String(value[key] === undefined || value[key] === null ? '' : value[key]).slice(0, 8192)
    count += 1
  }
  return out
}

function safeId(value, fallback) {
  const raw = String(value || '').trim().toLowerCase()
  const cleaned = raw.replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  const base = cleaned.slice(0, 32) || ('mcp_' + (fallback + 1))
  return base
}

function hash(value) {
  let result = 2166136261
  const text = String(value || '')
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function normalizeServer(raw, index) {
  if (!object(raw)) return null
  const position = Number(index) || 0
  const name = String(raw.name || raw.id || ('MCP ' + (position + 1))).trim().slice(0, 80) || ('MCP ' + (position + 1))
  const id = safeId(raw.id || name, position)
  const transport = raw.transport === 'http' ? 'http' : 'stdio'
  const permission = PERMISSIONS.indexOf(String(raw.permission || '')) >= 0 ? String(raw.permission) : 'write'
  const timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(Number(raw.timeoutMs) || DEFAULT_TIMEOUT_MS)))
  const server = {
    id,
    name,
    enabled: raw.enabled !== false,
    transport,
    permission,
    timeoutMs,
    command: '',
    args: [],
    env: {},
    envPass: [],
    cwd: '',
    url: '',
    headers: {},
    headerEnv: {},
    bearerTokenEnv: ''
  }
  if (transport === 'stdio') {
    server.command = String(raw.command || '').trim().slice(0, 1024)
    server.args = Array.isArray(raw.args) ? raw.args.slice(0, 64).map((item) => String(item).slice(0, 2048)) : []
    server.env = stringMap(raw.env)
    server.envPass = Array.isArray(raw.envPass) ? Array.from(new Set(raw.envPass.map(String).map(name => name.trim()).filter(Boolean))).slice(0, 64) : []
    if (server.envPass.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('MCP_ENV_NAME_INVALID')
    server.cwd = String(raw.cwd || '').trim().slice(0, 2048)
    if (raw.bundledNode === true) server.bundledNode = true
    if (!server.command) return null
    return server
  }
  server.url = String(raw.url || '').trim().slice(0, 4096)
  server.headers = stringMap(raw.headers)
  server.headerEnv = stringMap(raw.headerEnv)
  server.bearerTokenEnv = String(raw.bearerTokenEnv || '').trim().slice(0, 256)
  for (const name of Object.values(server.headerEnv).concat(server.bearerTokenEnv).filter(Boolean)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('MCP_ENV_NAME_INVALID')
  try {
    const parsed = new URL(server.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  } catch (error) {
    return null
  }
  return server
}

function normalizeServers(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const ids = new Set(['documents'])
  for (let index = 0; index < list.length && out.length < MAX_SERVERS; index += 1) {
    const server = normalizeServer(list[index], index)
    if (!server) continue
    let id = server.id
    let suffix = 2
    while (ids.has(id)) { id = server.id + '_' + suffix; suffix += 1 }
    server.id = id
    ids.add(id)
    out.push(server)
  }
  return out
}

function schema(value, depth) {
  const level = Number(depth) || 0
  if (!object(value) || level > 12) return { type: 'object', properties: {} }
  const out = {}
  if (Array.isArray(value.type)) {
    const types = value.type.filter((item) => typeof item === 'string').slice(0, 8)
    if (types.length) out.type = types
  } else if (typeof value.type === 'string') {
    out.type = value.type
  } else {
    out.type = 'object'
  }
  if (typeof value.description === 'string') out.description = value.description.slice(0, 4096)
  if (value.enum !== undefined) {
    try { out.enum = JSON.parse(JSON.stringify(value.enum)).slice(0, 256) } catch (error) {}
  }
  if (object(value.properties)) {
    out.properties = {}
    for (const key of Object.keys(value.properties).slice(0, 256)) out.properties[key] = schema(value.properties[key], level + 1)
  }
  if (Array.isArray(value.required)) out.required = value.required.filter((item) => typeof item === 'string').slice(0, 256)
  if (value.items !== undefined) out.items = schema(value.items, level + 1)
  if (value.additionalProperties === false || value.additionalProperties === true) out.additionalProperties = value.additionalProperties
  return out
}

function toolSchema(inputSchema) {
  if (!object(inputSchema) || inputSchema.type !== 'object') throw new Error('MCP_INVALID_TOOL_SCHEMA')
  // Preserve JSON Schema ($defs/$ref, unions, bounds, defaults). The remote server
  // remains responsible for full validation; local tool validation is a subset.
  const text = JSON.stringify(inputSchema)
  if (text.length > 256 * 1024) throw new Error('MCP_TOOL_SCHEMA_TOO_LARGE')
  return JSON.parse(text)
}

function toolName(serverId, rawName) {
  const server = safeId(serverId, 0)
  const tool = String(rawName || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  let name = 'mcp__' + server + '__' + (tool || 'tool')
  if (name.length > MAX_NAME_LENGTH) {
    const suffix = '_' + hash(server + ':' + rawName).slice(0, 8)
    name = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix
  }
  return name
}

function formatToolResult(result) {
  if (!object(result)) return String(result === undefined ? '' : result)
  const parts = []
  const content = Array.isArray(result.content) ? result.content : []
  for (const item of content.slice(0, 128)) {
    if (!object(item)) continue
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'image') parts.push('[MCP image' + (item.mimeType ? ': ' + item.mimeType : '') + ']')
    else if (item.type === 'resource') {
      const resource = item.resource && typeof item.resource === 'object' ? item.resource : {}
      if (typeof resource.text === 'string') parts.push(resource.text)
      else parts.push('[MCP resource' + (resource.uri ? ': ' + resource.uri : '') + ']')
    } else if (typeof item.text === 'string') parts.push(item.text)
  }
  if (object(result.structuredContent)) {
    try { parts.push(JSON.stringify(result.structuredContent)) } catch (error) {}
  }
  const text = parts.join('\n').slice(0, 256 * 1024)
  if (result.isError === true) return 'ERROR: ' + (text || 'MCP tool returned isError=true')
  return text || '(MCP tool returned no text content)'
}

function clientInfo() {
  return { name: CLIENT_NAME, version: CLIENT_VERSION }
}

function assertInitialize(result, versions) {
  if (!object(result) || !versions.includes(result.protocolVersion)) throw new Error('MCP_PROTOCOL_VERSION_UNSUPPORTED')
  if (!object(result.capabilities) || !object(result.serverInfo) || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') throw new Error('MCP_INVALID_INITIALIZE_RESULT')
  return result
}

function assertResponse(message, expectedId) {
  if (!object(message) || message.jsonrpc !== '2.0') throw new Error('MCP_INVALID_RESPONSE')
  if (expectedId !== undefined && message.id !== expectedId) throw new Error('MCP_RESPONSE_ID_MISMATCH')
  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error')
  if (hasResult === hasError || message.id === undefined || message.id === null) throw new Error('MCP_INVALID_RESPONSE')
  if (hasError) {
    if (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string') throw new Error('MCP_INVALID_RESPONSE')
    const error = new Error('MCP_RPC_ERROR: ' + String(message.error.message || message.error.code || 'unknown'))
    error.code = message.error.code
    throw error
  }
  return message.result
}

module.exports = {
  PROTOCOL_VERSION,
  HTTP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  CLIENT_NAME,
  CLIENT_VERSION,
  TRANSPORTS,
  PERMISSIONS,
  MAX_SERVERS,
  MAX_TOOLS_PER_SERVER,
  DEFAULT_TIMEOUT_MS,
  clientInfo,
  normalizeServer,
  normalizeServers,
  toolSchema,
  toolName,
  formatToolResult,
  assertResponse,
  assertInitialize,
  hash
}
