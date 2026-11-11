'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { StringDecoder } = require('string_decoder')
const { assertArguments } = require('../contracts')
const contract = require('../contracts/host-integration')
const { hash } = require('../service/repository')

class HostConnector {
  constructor(options) {
    this.options = options || {}
    this.url = new URL(this.options.url)
    if (this.url.username || this.url.password || this.url.search || this.url.hash || (this.url.pathname !== '/' && this.url.pathname !== '')) throw Error('HOST_SERVICE_URL_INVALID')
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)
    if (this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && local && this.options.allowLoopbackHttp === true)) throw Error('HOST_HTTPS_REQUIRED')
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(this.options.token || '')) throw Error('HOST_TOKEN_INVALID')
    this.tools = this.options.tools || []
    contract.tools(this.tools)
    if (this.tools.some(tool => typeof tool.execute !== 'function')) throw Error('HOST_EXECUTOR_REQUIRED')
    if (typeof this.options.getContext !== 'function' || !this.options.home) throw Error('HOST_CONFIGURATION_INVALID')
    this.pending = new Set()
    this.controllers = new Map()
    this.outbox = new Map()
    this.sending = new Map()
    this.closed = false
  }
  save() {
    const file = path.join(this.options.home, 'host-calls.json')
    let fd
    try {
      fd = fs.openSync(file + '.tmp', 'w', 0o600)
      fs.writeFileSync(fd, JSON.stringify(this.ledger)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(file + '.tmp', file)
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  open() {
    fs.mkdirSync(this.options.home, { recursive: true })
    this.lockPath = path.join(this.options.home, 'host-owner.json')
    try { this.lock = fs.openSync(this.lockPath, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'))
      if (!require('../persistence/process-owner').alive(owner)) {
        fs.unlinkSync(this.lockPath); this.lock = fs.openSync(this.lockPath, 'wx', 0o600)
      }
      if (this.lock === undefined) throw Error('HOST_HOME_IN_USE')
    }
    fs.writeFileSync(this.lock, JSON.stringify(require('../persistence/process-owner').record()))
    const file = path.join(this.options.home, 'host-calls.json')
    this.ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, calls: {} }
    if (!this.ledger || this.ledger.version !== 1 || !this.ledger.calls || typeof this.ledger.calls !== 'object') throw Error('HOST_LEDGER_INVALID')
    if (Object.values(this.ledger.calls).some(entry => Object.prototype.hasOwnProperty.call(entry, 'result'))) throw Error('HOST_LEGACY_LEDGER_MIGRATION_REQUIRED')
    for (const entry of Object.values(this.ledger.calls)) {
      if (entry.status === 'running') { entry.status = 'uncertain'; entry.delivered = false }
      if (entry.delivered === undefined) entry.delivered = false
    }
    this.save()
  }
  request(method, route, body, streaming) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const transport = this.url.protocol === 'https:' ? https : http
      const headers = { authorization: 'Bearer ' + this.options.token, accept: streaming ? 'text/event-stream' : 'application/json' }
      if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length }
      const req = transport.request(new URL(route, this.url), { method, headers, ca: this.options.ca }, res => {
        if (res.statusCode !== 200) { res.resume(); const error = Error('HOST_HTTP_' + res.statusCode); error.status = res.statusCode; reject(error); return }
        if (streaming) { req.setTimeout(0); resolve(res); return }
        let size = 0, parts = []
        res.on('data', chunk => { size += chunk.length; if (size > 131072) req.destroy(Error('HOST_RESPONSE_TOO_LARGE')); else parts.push(chunk) })
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch (error) { reject(error) } })
        res.on('error', reject)
      })
      req.setTimeout(15000, () => req.destroy(Error('HOST_REQUEST_TIMEOUT')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
  async start() {
    try {
      this.open()
      await this.connect()
    } catch (error) { await this.close(); throw error }
  }
  async connect() {
    if (this.closed) return
    const registered = await this.request('POST', '/api/v1/hosts/register', { protocolVersion: 1, tools: contract.tools(this.tools) })
    if (this.closed) return
    if (!registered || typeof registered.hostId !== 'string' || !registered.hostId) throw Error('HOST_REGISTRATION_INVALID')
    if (this.ledger.hostId && this.ledger.hostId !== registered.hostId) throw Error('HOST_ID_CHANGED')
    this.hostId = registered.hostId
    this.ledger.hostId = this.hostId
    this.save()
    const stream = await this.request('GET', '/api/v1/hosts/self/stream', undefined, true)
    if (this.closed) { stream.destroy(); return }
    this.stream = stream
    this.heartbeat = setInterval(() => {
      this.request('POST', '/api/v1/hosts/self/results', { protocolVersion: 1, method: 'heartbeat' }).catch(() => stream.destroy())
    }, 15000)
    stream.setTimeout(45000, () => stream.destroy(Error('HOST_HEARTBEAT_TIMEOUT')))
    const decoder = new StringDecoder('utf8')
    let text = ''
    stream.on('data', chunk => {
      text = (text + decoder.write(chunk)).replace(/\r\n/g, '\n')
      if (Buffer.byteLength(text) > 1048576) { stream.destroy(Error('HOST_STREAM_TOO_LARGE')); return }
      let index
      while ((index = text.indexOf('\n\n')) !== -1) {
        const frame = text.slice(0, index); text = text.slice(index + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        try {
          const command = JSON.parse(data)
          if (this.pending.size >= 32) { stream.destroy(Error('HOST_BUSY')); return }
          const pending = this.handle(command).catch(() => {}).finally(() => this.pending.delete(pending))
          this.pending.add(pending)
        } catch (_) { stream.destroy(Error('HOST_PROTOCOL_INVALID')); return }
      }
    })
    let ended = false
    const reconnect = () => {
      if (ended || this.closed) return
      ended = true
      clearInterval(this.heartbeat)
      this.heartbeat = null
      this.stream = null
      const reconnectLater = error => {
        if (this.closed || (error && (error.status === 401 || error.status === 403 || error.message === 'HOST_ID_CHANGED'))) return
        this.retry = setTimeout(() => this.connect().catch(reconnectLater), 5000 + crypto.randomInt(1000))
      }
      this.retry = setTimeout(() => this.connect().catch(reconnectLater), 1000 + crypto.randomInt(1000))
    }
    stream.on('end', reconnect); stream.on('close', reconnect); stream.on('error', reconnect)
    for (const [id, entry] of Object.entries(this.ledger.calls)) {
      if (!entry.delivered && entry.status !== 'running') this.sendResult(id).catch(() => { if (!this.closed) stream.destroy() })
    }
  }
  async sendResult(id) {
    if (this.sending.has(id)) return this.sending.get(id)
    const entry = this.ledger.calls[id]
    if (!entry || entry.status === 'running') return
    const response = this.outbox.get(id) || { protocolVersion: 1, id, status: entry.status, ...(entry.resultHash ? { resultHash: entry.resultHash } : {}) }
    // An old success without a retained result or digest cannot be reconciled as success.
    if (response.status === 'succeeded' && !('result' in response) && !response.resultHash) response.status = 'uncertain'
    const sending = (async () => {
      await this.request('POST', '/api/v1/hosts/self/results', response)
      entry.delivered = true
      this.save()
      this.outbox.delete(id)
    })()
    this.sending.set(id, sending)
    try { await sending } finally { this.sending.delete(id) }
  }
  async handle(command) {
    if (command && command.protocolVersion === 1 && command.method === 'event') {
      if (typeof this.options.onEvent === 'function') await this.options.onEvent(command.event)
      return
    }
    if (!command || command.protocolVersion !== 1 || !/^[0-9a-f-]{36}$/.test(command.id || '')) throw Error('HOST_COMMAND_INVALID')
    const response = { protocolVersion: 1, id: command.id }
    let sideEffectStarted = false
    try {
      if (command.method === 'context.get') {
        response.result = await this.options.getContext({ sessionId: command.sessionId, userId: command.userId })
        response.status = 'succeeded'
      } else if (command.method === 'tools.call') {
        if (typeof command.deadline === 'number' && command.deadline <= Date.now()) throw Error('HOST_CALL_EXPIRED')
        const tool = this.tools.find(entry => entry.name === command.tool)
        if (!tool) throw Error('HOST_TOOL_UNKNOWN')
        assertArguments(tool.parameters, command.args || {})
        const digest = hash({ sessionId: command.sessionId, userId: command.userId, tool: command.tool, args: command.args })
        const previous = this.ledger.calls[command.id]
        if (previous && previous.digest !== digest) throw Error('HOST_CALL_CONFLICT')
        if (previous) {
          response.status = previous.status === 'running' ? 'uncertain' : previous.status
          if (previous.resultHash) response.resultHash = previous.resultHash
          if (response.status === 'succeeded' && !response.resultHash) response.status = 'uncertain'
        } else {
          this.ledger.calls[command.id] = { digest, status: 'running' }; this.save()
          const controller = new AbortController()
          this.controllers.set(command.id, controller)
          try {
            sideEffectStarted = true
            const result = await tool.execute(command.args || {}, { sessionId: command.sessionId, userId: command.userId, signal: controller.signal, idempotencyKey: command.id })
            if (Buffer.byteLength(JSON.stringify(result === undefined ? null : result)) > 120000) throw Error('HOST_RESULT_TOO_LARGE')
            response.status = 'succeeded'; response.result = result === undefined ? null : result
          } catch (_) { response.status = 'uncertain' }
          finally { this.controllers.delete(command.id) }
          const entry = { digest, status: response.status, delivered: false }
          if (response.status === 'succeeded') entry.resultHash = hash(response.result)
          this.ledger.calls[command.id] = entry
          this.save()
          this.outbox.set(command.id, response)
          try { await this.sendResult(command.id) } catch (error) { if (this.stream) this.stream.destroy(); throw error }
          return
        }
      } else throw Error('HOST_METHOD_UNKNOWN')
    } catch (error) { if (sideEffectStarted) throw error; response.status = 'failed' }
    await this.request('POST', '/api/v1/hosts/self/results', response)
  }
  async close() {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.stream) this.stream.destroy()
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled(Array.from(this.pending))
    await Promise.allSettled(Array.from(this.sending.values()))
    if (this.lock !== undefined) { fs.closeSync(this.lock); this.lock = undefined; fs.unlinkSync(this.lockPath) }
  }
}
module.exports = { HostConnector }
