'use strict'

const fs = require('fs')
const path = require('path')
const { requestChat } = require('./llm')
const { PluginHost } = require('../plugins/plugin-host')
const compressor = require('./context-compressor')
const { SkillHost, partitionRecovered } = require('./skills')
const capabilityNotice = require('./skills/capability-notice')

const not = (value) => value ? false : true

/* 插件中文名（能力缺失提示用） */
const PLUGIN_TITLES = {
  'builtin/fs-tools': '\u6587\u4ef6\u8bfb\u5199',
  'builtin/search-tools': '\u5185\u5bb9\u641c\u7d22',
  'builtin/shell-tools': '\u547d\u4ee4\u6267\u884c',
  'builtin/browser-tools': '\u6d4f\u89c8\u5668\u81ea\u52a8\u5316',
  'builtin/skill-tools': '\u5185\u7f6e\u6280\u80fd'
}
const NL = String.fromCharCode(10)
const MAX_TOOL_RESULT = 120000

function isToolsUnsupportedError(error) {
  const text = String((error && error.message) || error || '').toLowerCase()
  return text.indexOf('does not support tools') !== -1 || text.indexOf('does not support tool') !== -1
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

class Agent {
  constructor(settings, emit, approve, sessionDir, pluginHost, assetStore) {
    this.settings = settings
    this.emit = emit
    this.approve = approve
    this.sessionDir = sessionDir
    this.messages = []
    this.memory = null
    this.workspaceRoot = settings.workspacePath || ''
    this.abortController = null
    this.skills = new SkillHost().loadAll()
    this.running = false
    this.disposed = false
    this.assetStore = assetStore || null
    this.ownsPlugins = not(pluginHost)
    this.plugins = pluginHost || new PluginHost({
      workspaceRoot: this.workspaceRoot,
      settings: this.settings
    })
    if (not(pluginHost)) this.plugins.loadBuiltins()
  }

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
    if (this._browserDriver) {
      try { await this._browserDriver.close() } catch (error) {}
      this._browserDriver = null
    }
    if (this.ownsPlugins && this.plugins) {
      try { this.plugins.dispose() } catch (error) {}
    }
    this.messages = []
    this.memory = null
  }

  systemPrompt() {
    const workspace = this.workspaceRoot || '(not selected)'
    const replyLanguage = this.settings && this.settings.data && this.settings.data.replyLanguage === 'en' ? 'English' : 'Simplified Chinese'
    const disabledPlugins = this.settings && this.settings.data && Array.isArray(this.settings.data.disabledPlugins)
      ? this.settings.data.disabledPlugins
      : []
    const lines = [
      'You are a careful local software engineering agent running on Windows 7.',
      'You can read, search, create and edit files inside the selected workspace.',
      'You can run local commands after user approval.',
      'Always prefer tools over guessing file contents.',
      'Never claim a tool action succeeded unless the tool result says it succeeded.',
      'Keep changes minimal and explain what you changed.',
      'ALL user-facing replies MUST be written in ' + replyLanguage + ' — this includes headings, bullet lists, notes and explanations, not just prose. Never switch to another language in the middle of an answer, even when the surrounding code, tool output or conversation context is in English. Code, identifiers, commands and API names stay as-is. Only reply in another language if the user explicitly asks for it.',
      'Current permission mode: ' + (this.settings.data.permissionMode || 'workspace') + '.',
      'In readonly mode do not call write_file, edit_file or run_command.',
      'Workspace root: ' + workspace,
      'Paths passed to tools must be relative to the workspace root.'
    ]
    if (disabledPlugins.length > 0) {
      lines.push('Disabled plugins: ' + disabledPlugins.join(', ') + '. Their tools are NOT available in this session. Never work around them with other tools (for example do not use shell commands to read files when file tools are disabled). If the task needs them, reply with ONE short sentence stating which capability is missing and that it can be re-enabled in Settings. Do NOT print tool-call syntax, scripts, or long explanations.')
    }
    return lines.join(NL)
  }

  adoptMemory(memory) {
    if (not(memory) || typeof memory !== 'object' || not(memory.text)) {
      this.memory = null
      return
    }
    const raw = Number(memory.through)
    const through = Number.isFinite(raw) ? raw : 1
    const max = Math.max(1, this.messages.length)
    this.memory = {
      text: String(memory.text),
      through: Math.max(1, Math.min(max, through)),
      updatedAt: memory.updatedAt ? String(memory.updatedAt) : '',
      compressedCount: Number(memory.compressedCount) || 0
    }
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
    return compressor.buildContextView(systemContent, this.messages, this.memory)
  }

  buildRequestMessages(systemContent) {
    return compressor.buildPayloadMessages({
      systemContent,
      messages: this.messages,
      memory: this.memory,
      resolveImage: (part) => this.resolveImage(part),
      toolResultChars: 60000
    })
  }

  saveSession() {
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true })
      const file = path.join(this.sessionDir, 'last-session.json')
      const payload = { version: 2, messages: this.messages, memory: this.memory }
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) {
      this.emit({ type: 'status', text: 'session save failed: ' + error.message })
    }
  }

  async summarizeBatch(previousText, batch, signal, summaryMaxTokens) {
    const transcript = compressor.serializeMessages(batch, { maxChars: 12000, perMessageChars: 2000 })
    const system = [
      'You compress older agent conversation into durable memory.',
      'Keep user goals, completed work, key files and paths, commands and important results, unresolved issues, constraints and preferences.',
      'Do not invent facts. Reply with the updated memory only, in the same language as the conversation.'
    ].join(' ')
    const user = (previousText ? 'Existing memory:' + NL + previousText + NL + NL : '') +
      'Conversation to compress:' + NL + transcript + NL + NL +
      'Return the updated memory, under 800 words.'
    const result = await requestChat({
      settings: this.settings.data,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      tools: [],
      signal,
      maxTokens: summaryMaxTokens,
      onDelta: () => undefined
    })
    return String(result && result.content ? result.content : '').trim()
  }

  mergeMemory(previous, summary) {
    const next = String(summary || '').trim()
    if (not(previous)) return next
    if (not(next)) return String(previous)
    const merged = String(previous) + NL + NL + next
    if (merged.length <= 12000) return merged
    return merged.slice(merged.length - 12000)
  }

  async runCompaction(from, boundary, options) {
    const slice = this.messages.slice(from, boundary)
    if (slice.length === 0) return false
    const signal = options && options.signal
    const budget = compressor.resolveBudget(this.settings.data)
    this.emit({ type: 'context:compress:start', count: slice.length })
    this.emit({ type: 'status', text: 'compressing context (' + slice.length + ' messages)' })
    let memoryText = this.memory && this.memory.text ? String(this.memory.text) : ''
    const batches = compressor.batchMessages(slice, 12000)
    for (const batch of batches) {
      if (signal && signal.aborted) return false
      let summary = ''
      try {
        summary = await this.summarizeBatch(memoryText, batch, signal, budget.summaryMaxTokens)
      } catch (error) {
        summary = ''
      }
      if (summary) memoryText = this.mergeMemory(memoryText, summary)
      else memoryText = compressor.buildLocalMemory(memoryText, batch)
    }
    if (signal && signal.aborted) return false
    const previousCount = this.memory && Number(this.memory.compressedCount) ? Number(this.memory.compressedCount) : 0
    this.memory = {
      text: memoryText,
      through: boundary,
      updatedAt: new Date().toISOString(),
      compressedCount: previousCount + slice.length
    }
    this.saveSession()
    this.emit({ type: 'context:compressed', memory: this.memory, compressedCount: slice.length })
    this.emit({ type: 'status', text: 'context compressed (' + slice.length + ' messages)' })
    return true
  }

  async compact(options) {
    if (this.settings.data.contextAutoCompress === false) return false
    const signal = options && options.signal
    if (signal && signal.aborted) return false
    const budget = compressor.resolveBudget(this.settings.data)
    const rawFrom = this.memory && Number.isFinite(Number(this.memory.through)) ? Number(this.memory.through) : 1
    const from = Math.max(1, Math.min(this.messages.length, rawFrom))
    let keep = budget.keepRecentMessages
    if (options && options.aggressive) keep = Math.max(1, Math.floor(keep / 2))
    if (options && options.hard) keep = 1
    let boundary = compressor.findCompactionBoundary(this.messages, { keepRecentMessages: keep })
    if (boundary <= from) {
      boundary = compressor.findCompactionBoundary(this.messages, { keepRecentMessages: 1 })
      if (boundary <= from) return false
    }
    return this.runCompaction(from, boundary, options)
  }

  async ensureContextBudget(systemContent, signal) {
    if (this.settings.data.contextAutoCompress === false) return false
    const budget = compressor.resolveBudget(this.settings.data)
    if (budget.contextWindow <= 0) return false
    const promptTokens = compressor.estimateMessagesTokens(this.buildContextView(systemContent))
    const limit = Math.max(1, budget.contextWindow - budget.maxTokens)
    if (promptTokens <= limit * budget.threshold) return false
    return this.compact({ force: true, aggressive: promptTokens > limit, signal, systemContent })
  }

  clear() {
    this.messages = []
    this.memory = null
    this.saveSession()
  }

  /* 清洗客户端传来的历史：丢弃无主的 tool 结果、给悬空的 tool_calls 补占位结果，
     否则严格模型服务会拒收（400: role 'tool' must follow a 'tool_calls' message） */
  sanitizeHistory(messages) {
    const list = []
    for (const raw of Array.isArray(messages) ? messages : []) {
      if (not(raw) || not(raw.role)) continue
      if (raw.role === 'tool') {
        const prev = list[list.length - 1]
        const ids = (prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls))
          ? prev.tool_calls.map((call) => call.id)
          : []
        if (ids.indexOf(raw.tool_call_id) === -1) continue
        list.push(Object.assign({}, raw))
        continue
      }
      list.push(Object.assign({}, raw))
    }
    for (let index = 0; index < list.length; index += 1) {
      const message = list[index]
      if (message.role !== 'assistant' || not(Array.isArray(message.tool_calls))) continue
      const answered = {}
      let cursor = index + 1
      while (cursor < list.length && list[cursor].role === 'tool') {
        answered[list[cursor].tool_call_id] = true
        cursor += 1
      }
      const patches = []
      for (const call of message.tool_calls) {
        if (answered[call.id]) continue
        patches.push({ role: 'tool', tool_call_id: call.id, content: '(no result recorded)' })
        answered[call.id] = true
      }
      if (patches.length > 0) list.splice.apply(list, [cursor, 0].concat(patches))
    }
    return list
  }

  async run(userText, history, images, memory) {
    if (this.disposed) {
      throw new Error('AGENT_DISPOSED: this worker is no longer available')
    }
    if (not(this.workspaceRoot)) {
      throw new Error('WORKSPACE_NOT_SET: choose a local workspace directory first')
    }
    if (this.running) {
      throw new Error('BUSY: the agent is already running')
    }
    this.running = true
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    const maxIterations = Math.max(1, Math.min(500, Number(this.settings.data.maxIterations) || 100))
    try {
      if (Array.isArray(history)) {
        this.messages = this.sanitizeHistory(history)
      }
      this.adoptMemory(memory)
      const systemContent = await this.plugins.buildSystemPrompt(this.systemPrompt())
      if (this.messages.length === 0) {
        this.messages.push({ role: 'system', content: systemContent })
      } else {
        this.messages[0] = { role: 'system', content: systemContent }
      }
      const imageParts = await this.buildImageParts(images)
      const text = String(userText || '')
      /* 只发图片（用户报过报错）：不要塞 {"type":"text","text":""} 段，
         严格一点的模型服务会直接判 400；图片段本身就能单独作为 user content。 */
      const userContent = imageParts.length > 0
        ? (text === '' ? imageParts : [{ type: 'text', text }].concat(imageParts))
        : text
      this.messages.push({ role: 'user', content: userContent })
      this.emit({ type: 'user', text })
      this.plugins.events.emit('agent:beforeRun', { agent: this, userText: text })
      let toolsEnabled = true
      let deniedCount = 0
      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        if (signal.aborted) break
        this.emit({ type: 'status', text: 'thinking (' + (iteration + 1) + '/' + maxIterations + ')' })
        let result = null
        let lastError = null
        let streamedThinking = ''
        let streamedContent = ''
        let dsmlSuppressed = false
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await this.ensureContextBudget(systemContent, signal)
          if (signal.aborted) break
          const requestMessages = await this.buildRequestMessages(systemContent)
          try {
            result = await requestChat({
              settings: this.settings.data,
              messages: requestMessages,
              tools: toolsEnabled ? this.plugins.getToolDefinitions() : [],
              signal,
              onDelta: (delta) => {
                if (delta.type === 'content') {
                  streamedContent += delta.text
                  /* 流式阶段检测到 DSML 泄漏：停止转发正文增量，等完成后由 skill 清理接管 */
                  if (not(dsmlSuppressed) && capabilityNotice.hasLeakMarker(streamedContent)) {
                    dsmlSuppressed = true
                    this.emit({ type: 'status', text: 'malformed tool-call text detected; cleaning up' })
                  }
                  if (not(dsmlSuppressed)) this.emit({ type: 'assistant:delta', text: delta.text })
                }
                if (delta.type === 'thinking') {
                  streamedThinking += delta.text
                  this.emit({ type: 'assistant:thinking', text: delta.text })
                }
              }
            })
            lastError = null
            break
          } catch (error) {
            lastError = error
            if (isToolsUnsupportedError(error) && toolsEnabled) {
              toolsEnabled = false
              this.emit({ type: 'status', text: 'model does not support tools; continuing without tools' })
              continue
            }
            if (not(compressor.isContextLengthError(error)) || attempt >= 2 || signal.aborted) break
            const changed = await this.compact({ force: true, aggressive: attempt > 0, signal, systemContent })
            if (not(changed)) {
              const hardChanged = await this.compact({ force: true, aggressive: true, hard: true, signal, systemContent })
              if (not(hardChanged)) break
            }
          }
        }
        if (signal.aborted) break
        if (not(result)) throw (lastError || new Error('LLM_NO_RESULT'))
        const assistant = { role: 'assistant', content: result.content || null }
        const calls = []
        if (result.toolCalls && result.toolCalls.length > 0) {
          for (let index = 0; index < result.toolCalls.length; index += 1) {
            const call = result.toolCalls[index]
            const functionData = call.function || {}
            if (not(functionData.name)) continue
            calls.push({
              id: call.id || ('call_' + index + '_' + Date.now()),
              type: 'function',
              function: {
                name: functionData.name || '',
                arguments: functionData.arguments || '{}'
              }
            })
          }
        }
        /* 内置 skill：模型把工具调用当正文打印时抢救成真实调用，走统一闸口 */
        if (assistant.content && capabilityNotice.hasLeakMarker(assistant.content)) {
          const rescued = this.skills.transformContent(assistant.content)
          const partitioned = partitionRecovered(rescued.recoveredCalls, (name) => this.plugins.getTool(name), this.settings.data.disabledPlugins)
          const missingTitles = partitioned.missing.map((item) => PLUGIN_TITLES[item.plugin] || item.plugin)
          const enabledRecovered = partitioned.enabled
          if (missingTitles.length > 0 && enabledRecovered.length === 0) {
            /* 全部缺失：不进执行循环、不显示原始内容，直接一句话说明 */
            const shortText = '\u5f53\u524d\u4e0d\u5177\u5907\u300c' + missingTitles.join('\u3001') + '\u300d\u80fd\u529b\uff0c\u76f8\u5173\u63d2\u4ef6\u5df2\u505c\u7528\uff1b\u5982\u9700\u4f7f\u7528\u8bf7\u5728 \u8bbe\u7f6e \u2192 \u63d2\u4ef6 \u4e2d\u91cd\u65b0\u5f00\u542f\u3002'
            assistant.content = shortText
            this.emit({ type: 'capability:missing', plugin: missingTitles.join(','), text: shortText })
          } else {
            assistant.content = rescued.text === '' ? null : rescued.text
            for (const enabledCall of enabledRecovered) calls.push(enabledCall)
            if (calls.length > 0 && not(assistant.tool_calls)) assistant.tool_calls = calls.slice()
            if (enabledRecovered.length > 0) {
              this.emit({ type: 'status', text: 'recovered ' + enabledRecovered.length + ' tool call(s) from text' })
            }
            if (missingTitles.length > 0) {
              this.emit({ type: 'capability:missing', plugin: missingTitles.join(','), text: '\u90e8\u5206\u8c03\u7528\u5df2\u8df3\u8fc7\uff1a\u7f3a\u5c11\u300c' + missingTitles.join('\u3001') + '\u300d\u80fd\u529b\uff08\u63d2\u4ef6\u5df2\u505c\u7528\uff09' })
            }
          }
        }
        /* 关键：assistant 必须携带 tool_calls，否则下一轮请求里 role:'tool' 消息没有前置 tool_calls，模型服务返回 400 */
        if (calls.length > 0) assistant.tool_calls = calls.slice()
        this.messages.push(assistant)
        if (assistant.content) this.emit({ type: 'assistant:message', text: assistant.content })
        if (calls.length === 0) {
          const finalText = assistant.content || streamedThinking || ''
          if (not(assistant.content) && streamedThinking) {
            this.emit({ type: 'assistant:message', text: streamedThinking })
          }
          if (not(assistant.content) && not(streamedThinking)) {
            this.emit({ type: 'assistant:message', text: 'The model returned no final content. Check the tool results or try again.' })
          }
          this.saveSession()
          this.emit({ type: 'done', text: finalText })
          return
        }
        for (const call of calls) {
          if (signal.aborted) break
          const name = call.function.name
          const args = safeJsonParse(call.function.arguments)
          this.emit({ type: 'tool:start', name, args: args || {} })
          let toolResult = ''
          if (not(args)) {
            toolResult = 'ERROR: invalid JSON arguments for ' + name
          } else {
            try {
              this.plugins.events.emit('tool:before', { name, args, agent: this })
              toolResult = await this.plugins.executeTool(name, args, {
                workspaceRoot: this.workspaceRoot,
                settings: this.settings.data,
                signal,
                approve: this.approve,
                agent: this
              })
              this.plugins.events.emit('tool:after', { name, args, result: toolResult, agent: this })
            } catch (error) {
              toolResult = 'ERROR: ' + error.message
              this.plugins.events.emit('tool:error', { name, args, error, agent: this })
            }
          }
          const clipped = String(toolResult).slice(0, MAX_TOOL_RESULT)
          if (String(toolResult).indexOf('DISABLED:') === 0) {
            /* 能力缺失：弹窗提示用户（思考流同步留痕） */
            const pluginMatch = String(toolResult).match(/disabled plugin (\S+)/)
            const pluginName = pluginMatch ? pluginMatch[1] : ''
            const noticeText = '\u63d2\u4ef6\u300c' + (pluginName || 'unknown') + '\u300d\u5df2\u505c\u7528\uff0c\u5de5\u5177 ' + name + ' \u65e0\u6cd5\u6267\u884c\uff1b\u5982\u9700\u8be5\u80fd\u529b\u8bf7\u5230\u8bbe\u7f6e\u2192\u63d2\u4ef6\u91cd\u65b0\u5f00\u542f'
            this.emit({ type: 'capability:missing', plugin: pluginName, text: noticeText })
          }
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: clipped })
          this.emit({ type: 'tool:result', name, result: clipped })
          this.saveSession()
          if (String(clipped).indexOf('DENIED') === 0) deniedCount += 1
          else deniedCount = 0
        }
        if (deniedCount >= 3) {
          const text = 'Permission mode is read-only, so file writes and commands are blocked. Please switch the permission mode to Workspace edit or Full access and try again.'
          const finalMessage = { role: 'assistant', content: text }
          this.messages.push(finalMessage)
          this.emit({ type: 'assistant:message', text })
          this.saveSession()
          this.emit({ type: 'done', text })
          return
        }
      }
      if (signal.aborted) {
        this.emit({ type: 'status', text: 'stopped by user' })
      } else {
        this.emit({ type: 'status', text: 'reached max iterations' })
      }
    } catch (error) {
      if (error && error.message === 'ABORTED') {
        this.emit({ type: 'status', text: 'stopped by user' })
      } else {
        this.emit({ type: 'error', message: error && error.message ? error.message : String(error) })
      }
    } finally {
      this.running = false
      this.abortController = null
      this.plugins.events.emit('agent:afterRun', { agent: this })
      const completedMessages = this.messages
      const completedMemory = this.memory
      this.emit({ type: 'finished', messages: completedMessages, memory: completedMemory })
      /* 完整历史由渲染层持有，并会在下一次 run 重新传入。空闲 worker 只需要保留
         浏览器等会话资源；继续攥着几 MB 的消息数组会让 maxWorkers 倍增常驻内存。 */
      this.messages = []
      this.memory = null
    }
  }
}

module.exports = { Agent }
