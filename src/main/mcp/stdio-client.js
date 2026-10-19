'use strict'

const { spawn } = require('child_process')
const { StringDecoder } = require('string_decoder')
const contract = require('../contracts/mcp')
const { listTools } = require('./discovery')
const { childEnvironment } = require('./environment')

function not(value) { return value ? false : true }

class StdioClient {
  constructor(config, options) {
    this.config = config
    this.options = options || {}
    this.child = null
    this.rl = null
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    this.initialized = false
    this.serverInfo = null
    this.capabilities = null
    this.stderr = ''
    this.exitError = ''
    this.exitPromise = null
  }

  status() {
    return this.exitError ? 'error' : (this.initialized ? 'connected' : (this.child ? 'connecting' : 'disconnected'))
  }

  async start() {
    if (this.child) return this
    const env = childEnvironment(this.config)
    const options = {
      cwd: this.config.cwd || undefined,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      /* Win7 上的 npm/npx 通常以 .cmd 暴露；Node 16 不能直接 spawn .cmd。
         这里只启动用户显式配置的 MCP 命令，和 run_command 一样属于可信本地配置。 */
      shell: process.platform === 'win32' && this.options.shell !== false && this.config.bundledNode !== true
    }
    this.child = spawn(this.config.command, this.config.args || [], options)
    this.exitPromise = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        if (this.closed === false) this.exitError = 'MCP process exited: ' + (code === null ? String(signal) : String(code))
        this.rejectPending(new Error(this.exitError || 'MCP_PROCESS_EXITED'))
        resolve()
      })
    })
    this.child.once('error', (error) => {
      this.exitError = 'MCP process failed: ' + error.message
      this.rejectPending(new Error(this.exitError))
    })
    this.child.stdin.on('error', (error) => { this.exitError = 'MCP_STDIN_ERROR: ' + error.message; this.rejectPending(new Error(this.exitError)) })
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8192)
    })
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk)
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) { this.exitError = 'MCP_RESPONSE_TOO_LARGE'; this.rejectPending(new Error(this.exitError)); this.close(); return }
        this.handleLine(line)
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { this.exitError = 'MCP_RESPONSE_TOO_LARGE'; this.rejectPending(new Error(this.exitError)); this.close() }
    })
    try {
      const result = await this.request('initialize', {
        protocolVersion: contract.PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: contract.clientInfo()
      })
      contract.assertInitialize(result, contract.SUPPORTED_PROTOCOL_VERSIONS)
      this.serverInfo = result && result.serverInfo ? result.serverInfo : null
      this.capabilities = result && result.capabilities ? result.capabilities : {}
      await this.notify('notifications/initialized', {})
      this.initialized = true
      return this
    } catch (error) {
      await this.close()
      throw error
    }
  }

  request(method, params, timeoutMs, signal) {
    if (this.closed || not(this.child)) return Promise.reject(new Error('MCP_CLIENT_CLOSED'))
    if (this.exitError) return Promise.reject(new Error(this.exitError))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(id)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }
      const onAbort = () => {
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } })
        finish(new Error('ABORTED'))
      }
      const timer = setTimeout(() => { if (method !== 'initialize') this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }); finish(new Error('MCP_TIMEOUT: ' + method)) }, Math.max(1000, Number(timeoutMs) || this.config.timeoutMs))
      this.pending.set(id, { finish })
      if (signal) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.send({ jsonrpc: '2.0', id, method, params: params || {} })
    })
  }

  notify(method, params) {
    if (this.closed || not(this.child)) return Promise.reject(new Error('MCP_CLIENT_CLOSED'))
    if (this.exitError) return Promise.reject(new Error(this.exitError))
    this.send({ jsonrpc: '2.0', method, params: params || {} })
    return Promise.resolve()
  }

  send(message) {
    if (not(this.child) || not(this.child.stdin) || this.child.stdin.destroyed) return
    try { this.child.stdin.write(JSON.stringify(message) + '\n') } catch (error) {}
  }

  handleLine(line) {
    const text = String(line || '').trim()
    if (text === '') return
    let message
    try { message = JSON.parse(text) } catch (error) { return }
    if (not(message) || typeof message !== 'object') return
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (not(pending)) return
      try { pending.finish(null, contract.assertResponse(message)) } catch (error) { pending.finish(error) }
      return
    }
    if (message.jsonrpc === '2.0' && message.method === 'ping' && message.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: message.id, result: {} }); return
    }
    if (message.method && message.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported by client: ' + message.method } })
    }
  }

  rejectPending(error) {
    for (const pending of Array.from(this.pending.values())) pending.finish(error)
    this.pending.clear()
  }

  async listTools() {
    return listTools(this)
  }

  async callTool(name, args, options) {
    const opts = options || {}
    return this.request('tools/call', { name, arguments: args || {} }, this.config.timeoutMs, opts.signal)
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.initialized = false
    this.rejectPending(new Error('MCP_CLIENT_CLOSED'))
    this.closePromise = this.finishClose()
    return this.closePromise
  }

  async finishClose() {
    if (this.rl) { try { this.rl.close() } catch (error) {} this.rl = null }
    const child = this.child
    if (!child) return
    const wait = async (ms) => {
      let timer
      try { await Promise.race([this.exitPromise, new Promise(resolve => { timer = setTimeout(resolve, ms) })]) }
      finally { clearTimeout(timer) }
    }
    try { child.stdin.end() } catch (error) {}
    await wait(500)
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill() } catch (error) {}
      await wait(500)
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch (error) {}
      await this.exitPromise
    }
    this.child = null
  }
}

module.exports = { StdioClient }
