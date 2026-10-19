'use strict'

// Default agent loop. The Cordis core/agent-loop plugin owns its lifetime.
const { partitionRecovered } = require('../agent/skills')
const { EVENTS } = require('../contracts')
const capabilityNotice = require('../agent/skills/capability-notice')
const not = (value) => value ? false : true
const MAX_TOOL_RESULT = 120000
const PLUGIN_TITLES = {
  'builtin/fs-tools': '\u6587\u4ef6\u8bfb\u5199',
  'builtin/search-tools': '\u5185\u5bb9\u641c\u7d22',
  'builtin/shell-tools': '\u547d\u4ee4\u6267\u884c',
  'builtin/browser-tools': '\u6d4f\u89c8\u5668\u81ea\u52a8\u5316',
  'builtin/skill-tools': '\u5185\u7f6e\u6280\u80fd'
}

function safeJsonParse(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch (error) {
    return null
  }
}

async function run(userText, history, images, memory) {
  if (this.disposed) {
    throw new Error('AGENT_DISPOSED: this worker is no longer available')
  }
  if (not(this.workspaceRoot)) {
    throw new Error('WORKSPACE_NOT_SET: choose a local workspace directory first')
  }
  this.abortController = new AbortController()
  const signal = this.abortController.signal
  const flow = this.service('flow')
  const contracts = this.service('contracts')
  let limits
  let maxIterations
  let started = false
  let timedOut = false
  let flowCancelled = false
  let deadline = null
  const unattended = this.settings.data.unattended
  let remainingTokens = unattended ? unattended.tokenBudget : 0
  let taskToolCalls = 0
  let taskRequests = 0
  let taskOutputBytes = 0
  try {
    limits = contracts.assertLimits(flow.limits(this.settings.data))
    maxIterations = limits.maxSteps
    this.state = this.service('sessions').load(this)
    if (this.running) this.record(EVENTS.INTERRUPT, { reason: 'recovered unfinished turn' })
    if (Array.isArray(history)) this.replaceHistory(this.sanitizeHistory(history))
    if (memory !== undefined || Array.isArray(history)) this.adoptMemory(memory)
    this.record(EVENTS.START, { id: 'turn_' + Date.now().toString(36) + '_' + (this.state.sequence + 1), maxSteps: maxIterations })
    started = true
    if (limits.turnTimeoutMs > 0) deadline = setTimeout(() => { timedOut = true; this.abort() }, limits.turnTimeoutMs)
    const systemContent = await this.plugins.buildSystemPrompt(this.systemPrompt(), signal, this.executionContext, this)
    const preparedHistory = this.messages.slice()
    if (preparedHistory[0] && preparedHistory[0].role === 'system') preparedHistory[0] = { role: 'system', content: systemContent }
    else preparedHistory.unshift({ role: 'system', content: systemContent })
    this.replaceHistory(this.sanitizeHistory(preparedHistory))
    const imageParts = await this.buildImageParts(images)
    const text = String(userText || '')
    /* 只发图片（用户报过报错）：不要塞 {"type":"text","text":""} 段，
       严格一点的模型服务会直接判 400；图片段本身就能单独作为 user content。 */
    const userContent = imageParts.length > 0
      ? (text === '' ? imageParts : [{ type: 'text', text }].concat(imageParts))
      : text
    this.appendMessage({ role: 'user', content: userContent })
    this.emit({ type: 'user', text })
    this.plugins.events.emit('agent:beforeRun', { agent: this, userText: text })
    while (this.state.execution.step < maxIterations) {
      const iteration = this.state.execution.step
      if (signal.aborted) break
      this.record(EVENTS.STEP, {})
      this.emit({ type: 'status', text: 'thinking (' + (iteration + 1) + '/' + maxIterations + ')' })
      let result = null
      let lastError = null
      let streamedThinking = ''
      let streamedContent = ''
      let dsmlSuppressed = false
      while (this.state.execution.attempt < limits.maxAttempts) {
        const attempt = this.state.execution.attempt
        if (!unattended) await this.ensureContextBudget(systemContent, signal)
        if (signal.aborted) break
        const requestMessages = await this.buildRequestMessages(systemContent)
        const requestTools = this.state.execution.toolsEnabled ? this.plugins.getToolDefinitions().filter(t => !unattended || unattended.tools.includes(t.function.name)) : []
        if (unattended) {
          const reserved = Buffer.byteLength(JSON.stringify(requestMessages), 'utf8') + Buffer.byteLength(JSON.stringify(requestTools), 'utf8') + Number(this.settings.data.maxTokens) + 1024
          if (++taskRequests > unattended.maxRequests || reserved > remainingTokens) throw new Error('TASK_BUDGET_EXCEEDED: request/token budget')
          remainingTokens -= reserved
        }
        try {
          this.record(EVENTS.REQUEST, {})
          result = await this.service('llm').request({
            settings: this.settings.data,
            messages: requestMessages,
            tools: requestTools,
            signal,
            onDelta: (delta) => {
              if (unattended) {
                taskOutputBytes += Buffer.byteLength(JSON.stringify(delta), 'utf8')
                if (taskOutputBytes > unattended.outputBytes) throw new Error('TASK_OUTPUT_LIMIT')
              }
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
          if (unattended && Buffer.byteLength(JSON.stringify(result), 'utf8') > unattended.outputBytes) throw new Error('TASK_OUTPUT_LIMIT')
          contracts.assertModelResult(result)
          lastError = null
          break
        } catch (error) {
          result = null
          lastError = error
          const retry = unattended ? 'stop' : contracts.assertDecision(flow.retry({ error: error.message, toolsEnabled: this.state.execution.toolsEnabled, attempt, aborted: signal.aborted, contextLengthError: this.contextService.isContextLengthError(error) }), ['stop', 'without-tools', 'compact'])
          this.record(EVENTS.REQUEST_FAILED, { reason: String(error.message || error), decision: retry })
          if (retry === 'without-tools') {
            this.record(EVENTS.TOOLS_DISABLED, {})
            this.emit({ type: 'status', text: 'model does not support tools; continuing without tools' })
            continue
          }
          if (retry !== 'compact') break
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
      const calls = flow.normalizeCalls(result.toolCalls, this.state.execution.id + '_' + iteration)
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
      this.appendMessage(assistant)
      if (assistant.content) this.emit({ type: 'assistant:message', text: assistant.content })
      const action = contracts.assertDecision(flow.next({ phase: 'assistant', execution: this.state.execution, calls, deniedCount: this.state.execution.deniedCount, maxDenied: limits.maxDenied, aborted: signal.aborted }), ['cancel', 'complete', 'tools', 'blocked'])
      if (action === 'cancel') { flowCancelled = true; break }
      if (action === 'blocked') {
        this.record(EVENTS.BLOCK, { reason: 'flow policy blocked execution' })
        this.emit({ type: 'done', text: assistant.content || '' })
        return
      }
      if (action === 'complete') {
        const finalText = assistant.content || streamedThinking || ''
        if (not(assistant.content) && streamedThinking) {
          this.emit({ type: 'assistant:message', text: streamedThinking })
        }
        if (not(assistant.content) && not(streamedThinking)) {
          this.emit({ type: 'assistant:message', text: 'The model returned no final content. Check the tool results or try again.' })
        }
        this.record(EVENTS.COMPLETE, {})
        this.saveSession()
        this.emit({ type: 'done', text: finalText })
        return
      }
      for (const call of calls) {
        if (signal.aborted) break
        const name = call.function.name
        const args = safeJsonParse(call.function.arguments)
        this.record(EVENTS.TOOL_START, { id: call.id, name })
        this.emit({ type: 'tool:start', id: call.id, name, args: args || {} })
        let toolResult = ''
        if (unattended && unattended.maxToolCalls && ++taskToolCalls > unattended.maxToolCalls) {
          toolResult = 'DENIED: unattended tool call limit reached'
        } else if (not(args)) {
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
        this.appendMessage({ role: 'tool', tool_call_id: call.id, content: clipped })
        const outcome = flow.outcome(clipped, signal.aborted)
        this.record(EVENTS.TOOL_END, { id: call.id, name, outcome })
        this.emit({ type: 'tool:result', id: call.id, name, outcome, result: clipped })
        this.saveSession()
        if (unattended && ['denied', 'disabled'].includes(outcome)) {
          for (const skipped of calls.slice(calls.indexOf(call) + 1)) this.appendMessage({ role: 'tool', tool_call_id: skipped.id, content: 'DENIED: unattended batch halted after blocked operation' })
          break
        }
      }
      const afterTools = contracts.assertDecision(flow.next({ phase: 'tools', execution: this.state.execution, calls, deniedCount: this.state.execution.deniedCount, maxDenied: limits.maxDenied, aborted: signal.aborted }), ['cancel', 'complete', 'tools', 'blocked'])
      if (afterTools === 'cancel') { flowCancelled = true; break }
      if (afterTools === 'complete') {
        this.record(EVENTS.COMPLETE, {})
        this.emit({ type: 'done', text: assistant.content || '' })
        return
      }
      if (afterTools === 'blocked') {
        const text = unattended ? '无人值守任务遇到未授权操作，已拒绝并停止，请查看被拦截的操作。' : 'Permission mode is read-only, so file writes and commands are blocked. Please switch the permission mode to Workspace edit or Full access and try again.'
        const finalMessage = { role: 'assistant', content: text }
        this.appendMessage(finalMessage)
        this.record(EVENTS.BLOCK, { reason: 'repeated permission denial' })
        this.emit({ type: 'assistant:message', text })
        this.saveSession()
        this.emit({ type: 'done', text })
        return
      }
    }
    if (signal.aborted || flowCancelled) {
      this.record(timedOut ? EVENTS.TIMEOUT : EVENTS.CANCEL, { reason: timedOut ? 'turn deadline reached' : (flowCancelled ? 'flow policy cancelled execution' : 'aborted') })
      this.emit({ type: 'status', text: timedOut ? 'turn deadline reached' : (flowCancelled ? 'stopped by flow policy' : 'stopped by user') })
    } else {
      this.record(EVENTS.EXHAUST, { reason: 'step limit reached' })
      this.emit({ type: 'status', text: 'reached max iterations' })
    }
  } catch (error) {
    if (this.running) {
      try { this.record(timedOut ? EVENTS.TIMEOUT : (signal.aborted || (error && error.message === 'ABORTED') ? EVENTS.CANCEL : EVENTS.FAIL), { reason: String(error.message || error) }) } catch (persistenceError) {
        this.emit({ type: 'error', message: persistenceError.message })
      }
    }
    if (signal.aborted || (error && error.message === 'ABORTED')) {
      this.emit({ type: 'status', text: timedOut ? 'turn deadline reached' : (flowCancelled ? 'stopped by flow policy' : 'stopped by user') })
    } else {
      this.emit({ type: 'error', message: error && error.message ? error.message : String(error) })
    }
  } finally {
    if (deadline) clearTimeout(deadline)
    if (started) this.saveSession()
    this.abortController = null
    this.plugins.events.emit('agent:afterRun', { agent: this })
    const completedMessages = this.messages
    const completedMemory = this.memory
    this.emit(started
      ? { type: 'finished', messages: completedMessages, memory: completedMemory, execution: this.state.execution }
      : { type: 'finished' })
    /* 完整历史由渲染层持有，并会在下一次 run 重新传入。空闲 worker 只需要保留
       浏览器等会话资源；继续攥着几 MB 的消息数组会让 maxWorkers 倍增常驻内存。 */
    this.releaseConversation()
  }
}

module.exports = { run }
