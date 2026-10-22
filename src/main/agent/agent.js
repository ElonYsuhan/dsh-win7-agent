'use strict'

const { PluginHost } = require('../plugins/plugin-host')
const { initial, release } = require('../state/session-state')
const { EVENTS, VERSION } = require('../contracts')

const not = (value) => value ? false : true

class Agent {
  constructor(settings, emit, approve, sessionDir, pluginHost, assetStore) {
    this.settings = settings
    this.emit = emit
    this.approve = approve
    this.sessionDir = sessionDir
    this.state = initial()
    this.workspaceRoot = settings.workspacePath || ''
    this.abortController = null
    this.disposed = false
    this.assetStore = assetStore || null
    this.ownsPlugins = not(pluginHost)
    this.plugins = pluginHost || new PluginHost({
      workspaceRoot: this.workspaceRoot,
      settings: this.settings
    })
    if (not(pluginHost)) this.plugins.loadBuiltins()
  }

  service(name) {
    // The active loop's injected view remains valid until its turn drains.
    return this.executionContext ? this.executionContext[name] : this.plugins.requireService(name)
  }

  get messages() { return this.state.messages }
  get memory() { return this.state.memory }
  get running() { return this.state.execution.status === 'running' }
  set running(value) {
    if (!value && this.running) this.record(EVENTS.CANCEL, { reason: 'reset' })
  }

  record(type, data) {
    const event = { version: VERSION, sequence: this.state.sequence + 1, at: new Date().toISOString(), type,
      data: JSON.parse(JSON.stringify(data || {})) }
    const next = this.service('state').reduce(this.state, event)
    // Commit the durable fact before exposing the resulting in-memory state.
    this.service('sessions').append(this, event)
    this.state = next
    this.plugins.context.parallel('state:committed', { sessionId: this.sessionId || '', event, execution: next.execution })
      .catch((error) => this.plugins.context.logger.warn(error))
    return event
  }

  appendMessage(message) { this.record(EVENTS.MESSAGE, { message }) }
  replaceHistory(messages) { this.record(EVENTS.HISTORY, { messages }) }
  setMemory(memory) { this.record(EVENTS.MEMORY, { memory }) }
  releaseConversation() { this.state = this.service('state').release(this.state) }

  get contextService() { return this.service('context') }
  get skills() { return this.service('skills') }

  setWorkspace(workspacePath) {
    this.workspaceRoot = workspacePath
    if (this.plugins) this.plugins.workspaceRoot = workspacePath
    this.settings.update({ workspacePath })
  }

  getWorkspace() {
    return this.workspaceRoot
  }

  abort() {
    if (this.abortController) this.abortController.abort()
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.abort()
    if (this.runPending) {
      try { await this.runPending } catch (error) {}
    }
    if (this._browserDriver) {
      try { await this._browserDriver.close() } catch (error) {}
      this._browserDriver = null
    }
    if (this._processManager) {
      try { await this._processManager.dispose() } catch (error) {}
      this._processManager = null
    }
    const agents = this.plugins.get('agents')
    if (agents && typeof agents.release === 'function') agents.release(this)
    if (this.ownsPlugins && this.plugins) {
      try { await this.plugins.dispose() } catch (error) {}
    }
    this.state = release(this.state)
  }

  systemPrompt() { return this.service('flow').systemPrompt(this.settings.data, this.workspaceRoot) }

  adoptMemory(memory) {
    if (not(memory) || typeof memory !== 'object' || not(memory.text)) {
      this.setMemory(null)
      return
    }
    const raw = Number(memory.through)
    const through = Number.isFinite(raw) ? raw : 1
    const max = Math.max(1, this.messages.length)
    this.setMemory({
      text: String(memory.text),
      through: Math.max(1, Math.min(max, through)),
      updatedAt: memory.updatedAt ? String(memory.updatedAt) : '',
      compressedCount: Number(memory.compressedCount) || 0
    })
  }

  async buildImageParts(images) {
    const list = Array.isArray(images) ? images : []
    const parts = []
    for (const image of list) {
      if (not(image)) continue
      if (typeof image === 'object' && image.assetId && this.assetStore) {
        parts.push({ type: 'image', assetId: String(image.assetId), mime: image.mime || '', name: image.name || '' })
        continue
      }
      const dataUrl = typeof image === 'string' ? image : (image && (image.dataUrl || image.url))
      if (not(dataUrl)) continue
      if (this.assetStore && String(dataUrl).indexOf('data:') === 0) {
        try {
          const meta = this.assetStore.saveDataUrl(dataUrl, { name: image && image.name, sessionDir: this.sessionDir })
          parts.push({ type: 'image', assetId: meta.id, mime: meta.mime, name: meta.name })
          continue
        } catch (error) {
          this.emit({ type: 'status', text: 'asset save failed: ' + error.message })
        }
      }
      parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
    return parts
  }

  async resolveImage(part) {
    if (not(this.assetStore) || not(part) || not(part.assetId)) return ''
    return this.assetStore.readDataUrl(part.assetId)
  }

  buildContextView(systemContent) {
    return this.contextService.buildContextView(systemContent, this.messages, this.memory)
  }

  buildRequestMessages(systemContent) {
    return this.contextService.buildPayloadMessages({
      systemContent,
      messages: this.messages,
      memory: this.memory,
      resolveImage: (part) => this.resolveImage(part),
      toolResultChars: 60000
    })
  }

  saveSession() {
    try {
      this.service('sessions').save(this)
    } catch (error) {
      this.emit({ type: 'status', text: 'session save failed: ' + error.message })
    }
  }

  async summarizeBatch(...args) { return this.service('memory').summarizeBatch(this, ...args) }
  mergeMemory(...args) { return this.service('memory').mergeMemory(this, ...args) }
  async runCompaction(...args) { return this.service('memory').runCompaction(this, ...args) }
  async compact(...args) { return this.service('memory').compact(this, ...args) }
  async ensureContextBudget(...args) { return this.service('memory').ensureContextBudget(this, ...args) }

  clear() {
    this.replaceHistory([])
    this.setMemory(null)
    this.saveSession()
  }

  /* 清洗客户端传来的历史：丢弃无主的 tool 结果、给悬空的 tool_calls 补占位结果，
     否则严格模型服务会拒收（400: role 'tool' must follow a 'tool_calls' message） */
  sanitizeHistory(messages) { return this.service('contracts').sanitizeHistory(messages) }

  async run(userText, history, images, memory) {
    if (this.disposed) throw new Error('AGENT_DISPOSED: this worker is no longer available')
    if (this.runPending) throw new Error('BUSY: the agent is already running')
    const pending = this.plugins.ready().then(() => {
      if (this.disposed) throw new Error('AGENT_DISPOSED: this worker is no longer available')
      return this.plugins.requireService('agentLoop').run(this, userText, history, images, memory)
    })
    this.runPending = pending
    try { return await pending } finally { this.runPending = null }
  }

}

module.exports = { Agent }
