'use strict'

const NL = String.fromCharCode(10)
const not = (value) => value ? false : true

const operations = {
  async summarizeBatch(previousText, batch, signal, summaryMaxTokens) {
    const transcript = this.contextService.serializeMessages(batch, { maxChars: 12000, perMessageChars: 2000 })
    const system = [
      'You compress older agent conversation into durable memory.',
      'Keep user goals, completed work, key files and paths, commands and important results, unresolved issues, constraints and preferences.',
      'Do not invent facts. Reply with the updated memory only, in the same language as the conversation.'
    ].join(' ')
    const user = (previousText ? 'Existing memory:' + NL + previousText + NL + NL : '') +
      'Conversation to compress:' + NL + transcript + NL + NL +
      'Return the updated memory, under 800 words.'
    const result = await this.service('llm').request({
      settings: this.settings.data,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      tools: [],
      signal,
      maxTokens: summaryMaxTokens,
      onDelta: () => undefined
    })
    return String(result && result.content ? result.content : '').trim()
  }
,
  mergeMemory(previous, summary) {
    const next = String(summary || '').trim()
    if (not(previous)) return next
    if (not(next)) return String(previous)
    const merged = String(previous) + NL + NL + next
    if (merged.length <= 12000) return merged
    return merged.slice(merged.length - 12000)
  }
,
  async runCompaction(from, boundary, options) {
    const slice = this.messages.slice(from, boundary)
    if (slice.length === 0) return false
    const signal = options && options.signal
    const budget = this.contextService.resolveBudget(this.settings.data)
    this.emit({ type: 'context:compress:start', count: slice.length })
    this.emit({ type: 'status', text: 'compressing context (' + slice.length + ' messages)' })
    let memoryText = this.memory && this.memory.text ? String(this.memory.text) : ''
    const batches = this.contextService.batchMessages(slice, 12000)
    for (const batch of batches) {
      if (signal && signal.aborted) return false
      let summary = ''
      try {
        summary = await this.summarizeBatch(memoryText, batch, signal, budget.summaryMaxTokens)
      } catch (error) {
        summary = ''
      }
      if (summary) memoryText = this.mergeMemory(memoryText, summary)
      else memoryText = this.contextService.buildLocalMemory(memoryText, batch)
    }
    if (signal && signal.aborted) return false
    const previousCount = this.memory && Number(this.memory.compressedCount) ? Number(this.memory.compressedCount) : 0
    this.setMemory({
      text: memoryText,
      through: boundary,
      updatedAt: new Date().toISOString(),
      compressedCount: previousCount + slice.length
    })
    this.saveSession()
    this.emit({ type: 'context:compressed', memory: this.memory, compressedCount: slice.length })
    this.emit({ type: 'status', text: 'context compressed (' + slice.length + ' messages)' })
    return true
  }
,
  async compact(options) {
    if (this.settings.data.contextAutoCompress === false) return false
    const signal = options && options.signal
    if (signal && signal.aborted) return false
    const budget = this.contextService.resolveBudget(this.settings.data)
    const rawFrom = this.memory && Number.isFinite(Number(this.memory.through)) ? Number(this.memory.through) : 1
    const from = Math.max(1, Math.min(this.messages.length, rawFrom))
    let keep = budget.keepRecentMessages
    if (options && options.aggressive) keep = Math.max(1, Math.floor(keep / 2))
    if (options && options.hard) keep = 1
    let boundary = this.contextService.findCompactionBoundary(this.messages, { keepRecentMessages: keep })
    if (boundary <= from) {
      boundary = this.contextService.findCompactionBoundary(this.messages, { keepRecentMessages: 1 })
      if (boundary <= from) return false
    }
    return this.runCompaction(from, boundary, options)
  }
,
  async ensureContextBudget(systemContent, signal) {
    if (this.settings.data.contextAutoCompress === false) return false
    const budget = this.contextService.resolveBudget(this.settings.data)
    if (budget.contextWindow <= 0) return false
    const promptTokens = this.contextService.estimateMessagesTokens(this.buildContextView(systemContent))
    const limit = Math.max(1, budget.contextWindow - budget.maxTokens)
    if (promptTokens <= limit * budget.threshold) return false
    return this.compact({ force: true, aggressive: promptTokens > limit, signal, systemContent })
  }

}
module.exports = { operations }
