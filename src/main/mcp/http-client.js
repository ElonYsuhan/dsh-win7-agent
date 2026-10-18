'use strict'

const http = require('http')
const https = require('https')
const { StringDecoder } = require('string_decoder')
const contract = require('../contracts/mcp')
const { requestHeaders } = require('./environment')
const { listTools } = require('./discovery')
const LIMIT = 16 * 1024 * 1024

function parseSse(text, requestId) {
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data) continue
    const message = JSON.parse(data)
    if (message && message.id === requestId && !message.method) return message
  }
  return null
}

class HttpClient {
  constructor(config, options) {
    this.config = config; this.options = options || {}; this.sessionId = ''
    this.initialized = false; this.serverInfo = null; this.capabilities = null
    this.nextId = 1; this.closed = false; this.error = ''; this.active = new Set()
    this.protocolVersion = contract.HTTP_PROTOCOL_VERSION; this.startPromise = null
  }
  status() { return this.closed ? 'disconnected' : this.error ? 'error' : this.initialized ? 'connected' : 'connecting' }
  buildHeaders(hasBody) {
    const headers = requestHeaders(this.config)
    // Transport-owned fields cannot be overridden using different header casing.
    for (const key of Object.keys(headers)) if (['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'content-length'].includes(key.toLowerCase())) delete headers[key]
    if (hasBody) headers['content-type'] = 'application/json'
    headers.accept = 'application/json, text/event-stream'
    headers['MCP-Protocol-Version'] = this.protocolVersion
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    return headers
  }
  post(message, signal) {
    if (this.closed) return Promise.reject(new Error('MCP_CLIENT_CLOSED'))
    if (signal && signal.aborted) return Promise.reject(new Error('ABORTED'))
    const body = JSON.stringify(message), target = new URL(this.config.url)
    const transport = target.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      let settled = false, request, response, timer
      const finish = (error, value) => {
        if (settled) return
        settled = true; clearTimeout(timer); this.active.delete(cancel)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (response) response.destroy()
        if (request) request.destroy()
        if (error) { if (error.message !== 'ABORTED' && error.message !== 'MCP_CLIENT_CLOSED') this.error = error.message; reject(error) }
        else { this.error = ''; resolve(value) }
      }
      const cancel = () => finish(new Error('MCP_CLIENT_CLOSED'))
      const notifyCancel = reason => {
        if (message.id !== undefined && message.method !== 'initialize' && !this.closed) this.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id, reason } }).catch(() => {})
      }
      const onAbort = () => { notifyCancel('cancelled'); finish(new Error('ABORTED')) }
      this.active.add(cancel)
      timer = setTimeout(() => { notifyCancel('timeout'); finish(new Error('MCP_TIMEOUT')) }, this.config.timeoutMs)
      try {
        request = transport.request({ protocol: target.protocol, hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search,
          method: 'POST', headers: Object.assign(this.buildHeaders(true), { 'content-length': Buffer.byteLength(body) }) }, res => {
          response = res
          let bytes = 0, buffer = ''; const decoder = new StringDecoder('utf8')
          const isSse = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'text/event-stream'
          const success = res.statusCode >= 200 && res.statusCode < 300
          const acceptMessage = parsed => {
            if (!parsed || parsed.jsonrpc !== '2.0') throw new Error('MCP_INVALID_RESPONSE')
            if (parsed.method && parsed.id !== undefined) {
              const reply = parsed.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Unsupported client method' } }
              this.post(Object.assign({ jsonrpc: '2.0', id: parsed.id }, reply)).catch(() => {})
              return
            }
            if (parsed.method) return // no optional notification capabilities are advertised
            finish(null, contract.assertResponse(parsed, message.id))
          }
          res.on('error', finish)
          res.on('aborted', () => finish(new Error('MCP_RESPONSE_ABORTED')))
          if (success && message.method === 'initialize' && res.headers['mcp-session-id']) {
            const session = String(res.headers['mcp-session-id'])
            if (!/^[\x21-\x7e]+$/.test(session)) { finish(new Error('MCP_INVALID_SESSION_ID')); return }
            this.sessionId = session
          }
          if (success && message.method && message.id !== undefined && !isSse && !/^application\/json(?:;|$)/i.test(String(res.headers['content-type'] || ''))) { finish(new Error('MCP_INVALID_CONTENT_TYPE')); return }
          res.on('data', chunk => {
            if (settled) return
            bytes += chunk.length
            if (bytes > LIMIT) { finish(new Error('MCP_RESPONSE_TOO_LARGE')); return }
            buffer += decoder.write(chunk)
            if (success && isSse && message.id !== undefined) {
              let match
              while (!settled && (match = /\r?\n\r?\n/.exec(buffer))) {
                const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length)
                const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
                if (data) { try { acceptMessage(JSON.parse(data)) } catch (error) { finish(error) } }
              }
            }
          })
          res.on('end', () => {
            if (settled) return
            buffer += decoder.end()
            if (!success) { const error = new Error('MCP_HTTP_' + res.statusCode); error.statusCode = res.statusCode; finish(error); return }
            if (message.id === undefined || !message.method) { finish(null, null); return }
            if (isSse) { finish(new Error('MCP_EMPTY_RESPONSE')); return }
            try { acceptMessage(JSON.parse(buffer)) } catch (error) { finish(error) }
          })
        })
        request.on('error', finish)
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        request.end(body)
      } catch (error) { finish(error) }
    })
  }
  start() {
    if (this.closed) return Promise.reject(new Error('MCP_CLIENT_CLOSED'))
    if (this.initialized) return Promise.resolve(this)
    if (this.startPromise) return this.startPromise
    this.startPromise = this.initialize().finally(() => { this.startPromise = null })
    return this.startPromise
  }
  async initialize() {
    const result = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: {
      protocolVersion: contract.HTTP_PROTOCOL_VERSION, capabilities: {}, clientInfo: contract.clientInfo() } })
    contract.assertInitialize(result, ['2025-03-26', '2025-06-18'])
    this.protocolVersion = result.protocolVersion; this.serverInfo = result.serverInfo; this.capabilities = result.capabilities || {}
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.initialized = true; this.error = ''; return this
  }
  async request(method, params, signal) {
    try { return await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params: params || {} }, signal) }
    catch (error) {
      if (error.statusCode === 404 && this.sessionId && !this.closed) {
        this.sessionId = ''; this.initialized = false
        // Recover only the session. Never replay an uncertain tools/call side effect.
        try { await this.start() } catch (recoveryError) { this.error = recoveryError.message }
      }
      throw error
    }
  }
  listTools() { return listTools(this) }
  callTool(name, args, options) { return this.request('tools/call', { name, arguments: args || {} }, options && options.signal) }
  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true; this.initialized = false
    for (const cancel of Array.from(this.active)) cancel()
    this.closePromise = this.finishClose(); return this.closePromise
  }
  async finishClose() {
    if (!this.sessionId) return
    const target = new URL(this.config.url), transport = target.protocol === 'https:' ? https : http
    await new Promise(resolve => {
      let request, timer
      const done = () => { clearTimeout(timer); if (request) request.destroy(); resolve() }
      timer = setTimeout(done, 1500)
      try {
        request = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
          path: target.pathname + target.search, method: 'DELETE', headers: this.buildHeaders(false) }, res => { res.resume(); res.once('end', done); res.once('error', done) })
        request.once('error', done); request.end()
      } catch (error) { done() }
    })
    this.sessionId = ''
  }
}
module.exports = { HttpClient, parseSse }
