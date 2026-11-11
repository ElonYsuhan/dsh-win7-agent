'use strict'

const { request: networkRequest } = require('./network-proxy')

const not = (value) => value ? false : true

function buildChatUrl(baseURL) {
  const value = String(baseURL || '').trim().replace(/\/+$/, '')
  if (value.endsWith('/chat/completions')) return value
  if (value.endsWith('/v1')) return value + '/chat/completions'
  return value + '/v1/chat/completions'
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

function appendToolCall(all, delta) {
  const index = Number(delta.index)
  const key = Number.isFinite(index) ? index : all.length
  while (all.length <= key) {
    all.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
  }
  const target = all[key]
  if (delta.id) target.id = delta.id
  if (delta.type) target.type = delta.type
  const fn = delta.function || {}
  if (fn.name) target.function.name = fn.name
  if (fn.arguments) target.function.arguments += fn.arguments
}

/* 新代码块：usage 辅助函数 + 重写后的 requestChat。
   由 patch-llm.js 插入到 `function requestChat` 处，替换原实现。
   Ollama 分支与其余辅助函数不动。 */
/* ── Usage 采集与归一化 ─────────────────────────────────────────────
   供应商明确拒绝 stream_options 时记住该 baseURL，后续请求自动降级，
   避免每次都先吃一个 400。仅进程内缓存，不落盘。 */
const streamOptionsRejected = new Set()

function streamOptionsCacheKey(settings) {
  return String((settings && settings.baseURL) || '').trim().toLowerCase()
}

function isStreamOptionsRejection(error) {
  const message = String((error && error.message) || error || '')
  if (message.indexOf('LLM_HTTP_4') !== 0) return false
  return /stream_options|include_usage/i.test(message)
}

/* 真实供应商在 finish_reason 之后才发 usage 尾帧，因此不能在 finish_reason
   立刻收尾。宽限期兜底：万一供应商既不发 [DONE] 也不关连接，也不挂到总超时。 */
const USAGE_GRACE_MS = 1000

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function firstNumber(candidates) {
  for (const candidate of candidates) {
    const n = finiteNumber(candidate)
    if (n !== null) return n
  }
  return null
}

const USAGE_FIELDS = Object.freeze([
  'promptTokens', 'uncachedPromptTokens', 'completionTokens', 'totalTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'cacheMissTokens', 'reasoningTokens', 'cacheHitRate'
])

/**
 * 把各家供应商的 usage 归一化成统一形状。
 *
 * 契约（重要）：
 *   - 数值字段拿不到就是 `null`，代表 unknown。绝不填估算值冒充真实值。
 *   - `unknownFields` 列出该供应商没给的字段，UI 应显示「未知」而不是 0。
 *   - `derivedFields` 列出**由本函数派生**（供应商未直给）的字段。派生值不是
 *     供应商真实值，下游做计费/对账时必须区别对待。
 *   - `source`: 'provider' = 至少拿到一个真实 usage 数值；'none' = 全部 unknown。
 *   - `promptSemantics` 标明输入口径：
 *       'inclusive' — OpenAI 风格，prompt_tokens **已包含** cached_tokens
 *       'exclusive' — Anthropic 风格，input_tokens **不含**缓存，需相加
 *
 * 统计口径定义（本函数唯一权威口径）：
 *   promptTokens          = 本轮提交给模型的**总输入** token（cacheable），
 *                         含缓存读取与缓存写入两部分
 *   uncachedPromptTokens  = 其中**未走缓存**、按标准价计费的那部分输入
 *   cacheReadTokens       = 从缓存读取的输入（Anthropic 约 0.1x 计费）
 *   cacheWriteTokens      = 新写入缓存的输入（Anthropic 约 1.25x 计费）
 *   completionTokens      = 输出 token
 *   totalTokens           = promptTokens + completionTokens（供应商未给时派生）
 *   cacheHitRate          = cacheReadTokens / promptTokens
 *                         分母用**总输入**（含 cache_write）：新写入缓存的内容
 *                         同样占用本轮输入预算，计入分母才能反映"本轮输入实际
 *                         省下多少"。若只用 cache_read/(cache_read+uncached)，
 *                         大量首次写入时会虚高。
 *
 * 覆盖的字段变体：
 *   prompt_tokens / input_tokens / prompt_eval_count
 *   completion_tokens / output_tokens / eval_count
 *   total_tokens
 *   prompt_tokens_details.cached_tokens
 *   prompt_cache_hit_tokens / prompt_cache_miss_tokens / prompt_cache_write_tokens
 *   cache_read_input_tokens / cache_creation_input_tokens
 *   completion_tokens_details.reasoning_tokens / completion_thinking_tokens
 */
function normalizeUsage(raw) {
  const empty = {
    source: 'none',
    promptTokens: null, uncachedPromptTokens: null, completionTokens: null, totalTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, cacheMissTokens: null,
    reasoningTokens: null, cacheHitRate: null,
    promptSemantics: 'unknown', derivedFields: [], unknownFields: USAGE_FIELDS.slice(), raw: null
  }
  if (not(raw) || typeof raw !== 'object') return empty

  const promptDetails = (raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object') ? raw.prompt_tokens_details : {}
  const completionDetails = (raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object') ? raw.completion_tokens_details : {}

  /* Anthropic 风格判据：出现 cache_read_input_tokens / cache_creation_input_tokens。
     它的 input_tokens 只算未缓存部分，必须相加才是提交给模型的总输入。 */
  const exclusive = raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined

  const rawPrompt = firstNumber([raw.prompt_tokens, raw.input_tokens, raw.prompt_eval_count])
  const completionTokens = firstNumber([raw.completion_tokens, raw.output_tokens, raw.eval_count])
  const rawTotal = firstNumber([raw.total_tokens])

  const cacheReadTokens = firstNumber([promptDetails.cached_tokens, raw.prompt_cache_hit_tokens, raw.cache_read_input_tokens])
  const cacheWriteTokens = firstNumber([raw.prompt_cache_write_tokens, raw.cache_creation_input_tokens])
  const cacheMissTokens = firstNumber([raw.prompt_cache_miss_tokens])
  const reasoningTokens = firstNumber([completionDetails.reasoning_tokens, raw.completion_thinking_tokens])

  /* 派生字段登记：凡不是供应商直给、由本函数算出来的，都记在这里。 */
  const derived = []

  let promptTokens = rawPrompt
  let uncachedPromptTokens = null
  let promptSemantics = 'unknown'

  if (rawPrompt !== null) {
    if (exclusive) {
      /* exclusive：input_tokens 本身就是未缓存输入，总输入需把缓存读写加回来。 */
      promptSemantics = 'exclusive'
      uncachedPromptTokens = rawPrompt
      promptTokens = rawPrompt + (cacheReadTokens || 0) + (cacheWriteTokens || 0)
      /* 只有真的加了东西，promptTokens 才算派生；全为 0 时等于原值，不算。 */
      if ((cacheReadTokens || 0) !== 0 || (cacheWriteTokens || 0) !== 0) derived.push('promptTokens')
    } else {
      /* inclusive：prompt_tokens 已含 cached_tokens，未缓存部分要减出来。 */
      promptSemantics = 'inclusive'
      if (cacheReadTokens !== null) {
        uncachedPromptTokens = rawPrompt - cacheReadTokens
        derived.push('uncachedPromptTokens')
      }
    }
  }

  let totalTokens = rawTotal
  if (totalTokens === null && promptTokens !== null && completionTokens !== null) {
    totalTokens = promptTokens + completionTokens
    derived.push('totalTokens')
  }

  /* 命中率 = 缓存读取 / 总输入。总输入未知或为 0 → 命中率未知，不猜。 */
  const cacheHitRate = (cacheReadTokens !== null && promptTokens !== null && promptTokens > 0)
    ? Math.min(1, Math.max(0, cacheReadTokens / promptTokens))
    : null
  if (cacheHitRate !== null) derived.push('cacheHitRate')

  const values = {
    promptTokens: promptTokens,
    uncachedPromptTokens: uncachedPromptTokens,
    completionTokens: completionTokens,
    totalTokens: totalTokens,
    cacheReadTokens: cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens,
    cacheMissTokens: cacheMissTokens,
    reasoningTokens: reasoningTokens,
    cacheHitRate: cacheHitRate
  }
  const unknownFields = USAGE_FIELDS.filter((field) => values[field] === null)
  const gotAny = USAGE_FIELDS.some((field) => values[field] !== null)

  return {
    source: gotAny ? 'provider' : 'none',
    promptTokens: values.promptTokens,
    uncachedPromptTokens: values.uncachedPromptTokens,
    completionTokens: values.completionTokens,
    totalTokens: values.totalTokens,
    cacheReadTokens: values.cacheReadTokens,
    cacheWriteTokens: values.cacheWriteTokens,
    cacheMissTokens: values.cacheMissTokens,
    reasoningTokens: values.reasoningTokens,
    cacheHitRate: values.cacheHitRate,
    promptSemantics: promptSemantics,
    derivedFields: derived,
    unknownFields: unknownFields,
    raw: raw
  }
}

function requestChat(options) {
  const settings = options.settings
  if (not(settings.baseURL)) {
    throw new Error('MODEL_NOT_CONFIGURED: \u8bf7\u5148\u914d\u7f6e\u6a21\u578b\u670d\u52a1\u5730\u5740')
  }
  if (not(settings.model)) {
    throw new Error('MODEL_NOT_CONFIGURED: \u8bf7\u5148\u586b\u5199\u6a21\u578b\u540d')
  }
  if (isOllamaSettings(settings)) return requestOllamaChat(options)
  const messages = options.messages
  const tools = options.tools || []
  const signal = options.signal
  const onDelta = options.onDelta || (() => undefined)
  const url = buildChatUrl(settings.baseURL)
  const parsed = new URL(url)
  const requestedMaxTokens = Number(options.maxTokens) || Number(settings.maxTokens) || 0
  const timeoutMs = Math.max(5000, Math.min(3600000, Number(settings.requestTimeoutMs) || 1800000))
  const cacheKey = streamOptionsCacheKey(settings)
  /* 默认开启 usage 采集；settings.streamIncludeUsage === false 可显式关闭，
     已知拒绝 stream_options 的 baseURL 自动降级不带。 */
  const wantUsage = settings.streamIncludeUsage !== false && !streamOptionsRejected.has(cacheKey)

  function buildBody(withUsage) {
    const payload = {
      model: settings.model,
      messages,
      temperature: Number(settings.temperature) || 0,
      stream: true
    }
    if (tools.length > 0) payload.tools = tools
    if (requestedMaxTokens > 0) payload.max_tokens = Math.floor(requestedMaxTokens)
    if (withUsage) payload.stream_options = { include_usage: true }
    return JSON.stringify(payload)
  }

  function buildHeaders(body) {
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      accept: 'text/event-stream, application/json'
    }
    if (settings.apiKey) headers.authorization = 'Bearer ' + settings.apiKey
    return headers
  }

  function sendOnce(withUsage) {
    const body = buildBody(withUsage)
    const headers = buildHeaders(body)
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      let graceTimer = null
      let responseBytes = 0
      /* usage 常在 finish_reason 之后的独立尾帧里，先累积再收尾。 */
      let usageRaw = null
      let finishReason = ''
      let responseRef = null
      const content = []
      const toolCalls = []
      let raw = ''
      let buffer = ''
      const acceptChunk = (chunk) => {
        if (settled) return false
        responseBytes += Buffer.byteLength(chunk)
        if (responseBytes > 32 * 1024 * 1024) { finish(new Error('LLM_RESPONSE_TOO_LARGE: model response exceeds 32MB')); return false }
        return true
      }
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null }
        request.destroy()
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }
      const onAbort = () => {
        request.destroy(new Error('ABORTED'))
      }
      const emitDelta = (delta) => {
        try { onDelta(delta); return !settled } catch (error) { finish(error); return false }
      }
      const complete = () => {
        finish(null, { content: content.join(''), toolCalls: toolCalls, usage: normalizeUsage(usageRaw) })
        if (responseRef && typeof responseRef.destroy === 'function') responseRef.destroy()
      }
      /* finish_reason 已到：给 usage 尾帧留一个短宽限，等 [DONE]/end；
         宽限内没等到就用已收到的数据收尾，不阻塞到总超时。 */
      const armGrace = () => {
        if (graceTimer || settled) return
        graceTimer = setTimeout(() => { graceTimer = null; if (!settled) complete() }, USAGE_GRACE_MS)
      }
      const consumeLine = (line) => {
        if (settled) return
        const trimmed = line.trim()
        if (trimmed === '') return
        if (not(trimmed.startsWith('data:'))) return
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          complete()
          return
        }
        const parsedLine = safeJsonParse(data)
        if (not(parsedLine)) return
        /* ★ 必须在取 choice 之前读 usage：usage 尾帧的 choices 是空数组，
           原先的 `if (not(choice)) return` 会把整帧丢掉。 */
        if (parsedLine.usage && typeof parsedLine.usage === 'object') usageRaw = parsedLine.usage
        const choice = parsedLine.choices && parsedLine.choices[0]
        if (not(choice)) return
        const delta = choice.delta || {}
        if (delta.content) {
          content.push(delta.content)
          if (!emitDelta({ type: 'content', text: delta.content })) return
        }
        const reasoning = delta.reasoning_content || delta.reasoning
        if (reasoning) {
          if (!emitDelta({ type: 'thinking', text: reasoning })) return
        }
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls) {
            appendToolCall(toolCalls, toolDelta)
            if (!emitDelta({ type: 'tool_call_delta', delta: toolDelta })) return
          }
        }
        if (choice.finish_reason) {
          if (choice.finish_reason === 'length' && toolCalls.length > 0) finish(new Error('LLM_TOOL_CALL_INCOMPLETE: token limit interrupted a tool call'))
          else { finishReason = choice.finish_reason; armGrace() }
        }
      }
      const request = networkRequest(parsed, {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers
      }, (res) => {
        responseRef = res
        res.on('error', (error) => finish(error))
        res.on('aborted', () => finish(new Error('LLM_RESPONSE_ABORTED')))
        if (res.statusCode >= 400) {
          let errorBody = ''
          /* 必须先 setEncoding：Node 默认给 Buffer，直接 toString('utf8') 会在
             多字节字符被 TCP 切断时解出 U+FFFD（中文回复变成一串黑菱形）。 */
          res.setEncoding('utf8')
          res.on('data', (chunk) => { if (acceptChunk(chunk)) errorBody += chunk.slice(0, Math.max(0, 1200 - errorBody.length)) })
          res.on('end', () => {
            finish(new Error('LLM_HTTP_' + res.statusCode + ': ' + errorBody.slice(0, 1200)))
          })
          return
        }
        const contentType = String(res.headers['content-type'] || '')
        if (contentType.includes('application/json')) {
          res.setEncoding('utf8')
          res.on('data', (chunk) => { if (acceptChunk(chunk)) raw += chunk })
          res.on('end', () => {
            if (settled) return
            const parsedBody = safeJsonParse(raw)
            if (not(parsedBody)) return finish(new Error('LLM_BAD_JSON: ' + raw.slice(0, 800)))
            const choice = parsedBody.choices && parsedBody.choices[0]
            const message = choice && choice.message
            if (not(message)) return finish(new Error('LLM_BAD_RESPONSE: ' + raw.slice(0, 800)))
            if (choice.finish_reason === 'length' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return finish(new Error('LLM_TOOL_CALL_INCOMPLETE: token limit interrupted a tool call'))
            if (message.content && !emitDelta({ type: 'content', text: message.content })) return
            const reasoning = message.reasoning_content || message.reasoning
            if (reasoning && !emitDelta({ type: 'thinking', text: reasoning })) return
            if (message.tool_calls) {
              for (const call of message.tool_calls) appendToolCall(toolCalls, call)
            }
            /* 非流式响应同样带 usage */
            if (parsedBody.usage && typeof parsedBody.usage === 'object') usageRaw = parsedBody.usage
            finish(null, { content: message.content || '', toolCalls: toolCalls, usage: normalizeUsage(usageRaw) })
          })
          return
        }
        /* setEncoding('utf8') 让 Node 用 StringDecoder 跨 chunk 拼接，半个汉字
           不会被解成 U+FFFD（用户 2026-10-17 报的「回复里出现黑菱形」）。 */
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (!acceptChunk(chunk)) return
          buffer += chunk
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop()
          for (const line of lines) consumeLine(line)
        })
        res.on('end', () => {
          if (settled) return
          if (buffer.length) consumeLine(buffer)
          /* 供应商没发 [DONE] 但正常关流：拿到过 finish_reason 就算成功（含 usage），
             否则维持原有 LLM_STREAM_INCOMPLETE 行为。 */
          if (!settled) {
            if (finishReason) complete()
            else finish(new Error('LLM_STREAM_INCOMPLETE: stream ended before completion marker'))
          }
        })
      })
      request.on('error', (error) => finish(error))
      if (signal) {
        if (signal.aborted) {
          request.destroy(new Error('ABORTED'))
        } else {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }
      timer = setTimeout(() => {
        request.destroy(new Error('LLM_TIMEOUT: \u6a21\u578b\u8bf7\u6c42\u8d85\u65f6'))
      }, timeoutMs)
      request.write(body)
      request.end()
    })
  }

  if (!wantUsage) return sendOnce(false)
  /* 供应商因 stream_options 报 4xx：记住 baseURL 并降级重试一次（不带该参数）。
     只重试这一次，不形成循环。 */
  return sendOnce(true).catch((error) => {
    if (isStreamOptionsRejection(error)) {
      streamOptionsRejected.add(cacheKey)
      return sendOnce(false)
    }
    throw error
  })
}

function isOllamaSettings(settings) {
  const base = String((settings && settings.baseURL) || '').toLowerCase()
  return base.indexOf('11434') !== -1 || base.indexOf('ollama') !== -1
}

function buildOllamaChatUrl(baseURL) {
  const parsed = new URL(buildChatUrl(baseURL))
  return parsed.origin + '/api/chat'
}

function toNativeMessages(messages) {
  const result = []
  for (const message of (Array.isArray(messages) ? messages : [])) {
    if (not(message) || not(message.role)) continue
    const next = { role: message.role }
    const images = []
    if (Array.isArray(message.content)) {
      const texts = []
      for (const part of message.content) {
        if (not(part)) continue
        if (part.type === 'text') texts.push(part.text || '')
        else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
          const url = String(part.image_url.url)
          const comma = url.indexOf(',')
          if (url.indexOf('base64') !== -1 && comma !== -1) images.push(url.slice(comma + 1))
        }
      }
      next.content = texts.join(String.fromCharCode(10))
    } else {
      next.content = message.content === null || message.content === undefined ? '' : String(message.content)
    }
    if (images.length > 0) next.images = images
    if (Array.isArray(message.tool_calls)) {
      next.tool_calls = message.tool_calls.map((call) => {
        const fn = (call && call.function) || {}
        let args = fn.arguments
        if (typeof args === 'string') { try { args = JSON.parse(args) } catch (error) { args = {} } }
        if (not(args) || typeof args !== 'object') args = {}
        return { function: { name: fn.name || '', arguments: args } }
      })
    }
    result.push(next)
  }
  return result
}

function normalizeOllamaToolCalls(raw) {
  const calls = []
  for (let index = 0; index < raw.length; index += 1) {
    const call = raw[index] || {}
    const fn = call.function || {}
    let args = fn.arguments
    if (args && typeof args === 'object') args = JSON.stringify(args)
    if (typeof args !== 'string') args = '{}'
    calls.push({ id: call.id || ('call_' + index + '_' + Date.now()), type: 'function', function: { name: fn.name || '', arguments: args } })
  }
  return calls
}

function requestOllamaChat(options) {
  const settings = options.settings
  const signal = options.signal
  const onDelta = options.onDelta || (() => undefined)
  const url = buildOllamaChatUrl(settings.baseURL)
  const parsed = new URL(url)
  const payload = {
    model: settings.model,
    messages: toNativeMessages(options.messages),
    stream: true,
    think: settings.thinking === true
  }
  if (Array.isArray(options.tools) && options.tools.length > 0) payload.tools = options.tools
  const body = JSON.stringify(payload)
  const timeoutMs = Math.max(5000, Math.min(3600000, Number(settings.requestTimeoutMs) || 1800000))
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    accept: 'application/x-ndjson, application/json'
  }
  if (settings.apiKey) headers.authorization = 'Bearer ' + settings.apiKey
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let responseBytes = 0
    const acceptChunk = (chunk) => {
      if (settled) return false
      responseBytes += Buffer.byteLength(chunk)
      if (responseBytes > 32 * 1024 * 1024) { finish(new Error('LLM_RESPONSE_TOO_LARGE: model response exceeds 32MB')); return false }
      return true
    }
    const content = []
    const toolCalls = []
    /* Ollama 的 token 统计在 done 帧：prompt_eval_count / eval_count */
    let usageRaw = null
    let buffer = ''
    const finish = (error, value) => {
      if (settled) return
      settled = true
      request.destroy()
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => { request.destroy(new Error('ABORTED')) }
    const emitDelta = (delta) => {
      try { onDelta(delta); return !settled } catch (error) { finish(error); return false }
    }
    let responseRef = null
    const consumeLine = (line) => {
      if (settled) return
      const text = String(line || '').trim()
      if (text === '') return
      const parsedLine = safeJsonParse(text)
      if (not(parsedLine)) return
      if (parsedLine.error) {
        finish(new Error('OLLAMA_ERROR: ' + JSON.stringify(parsedLine.error)))
        return
      }
      if (parsedLine.prompt_eval_count !== undefined || parsedLine.eval_count !== undefined) {
        usageRaw = {
          prompt_eval_count: parsedLine.prompt_eval_count,
          eval_count: parsedLine.eval_count
        }
      }
      const message = parsedLine.message || {}
      if (message.thinking && !emitDelta({ type: 'thinking', text: message.thinking })) return
      if (message.content) {
        content.push(message.content)
        if (!emitDelta({ type: 'content', text: message.content })) return
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const normalized = normalizeOllamaToolCalls(message.tool_calls)
        toolCalls.length = 0
        for (const call of normalized) toolCalls.push(call)
      }
      if (parsedLine.done === true) {
        if (parsedLine.done_reason === 'length' && toolCalls.length > 0) finish(new Error('LLM_TOOL_CALL_INCOMPLETE: token limit interrupted a tool call'))
        else finish(null, { content: content.join(''), toolCalls: toolCalls, usage: normalizeUsage(usageRaw) })
        if (responseRef && typeof responseRef.destroy === 'function') responseRef.destroy()
      }
    }
    const request = networkRequest(parsed, {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers
    }, (response) => {
      responseRef = response
      response.on('error', (error) => finish(error))
      response.on('aborted', () => finish(new Error('LLM_RESPONSE_ABORTED')))
      response.setEncoding('utf8')
      if (response.statusCode >= 400) {
        let errorBody = ''
        response.on('data', (chunk) => { if (acceptChunk(chunk)) errorBody += chunk.slice(0, Math.max(0, 1200 - errorBody.length)) })
        response.on('end', () => finish(new Error('LLM_HTTP_' + response.statusCode + ': ' + errorBody.slice(0, 1200))))
        return
      }
      response.on('data', (chunk) => {
        if (!acceptChunk(chunk)) return
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop()
        for (const line of lines) consumeLine(line)
      })
      response.on('end', () => {
        if (settled) return
        if (buffer.length > 0) consumeLine(buffer)
        if (!settled) finish(new Error('LLM_STREAM_INCOMPLETE: stream ended before completion marker'))
      })
    })
    request.on('error', (error) => finish(error))
    if (signal) {
      if (signal.aborted) request.destroy(new Error('ABORTED'))
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      request.destroy(new Error('LLM_TIMEOUT: model request timed out'))
    }, timeoutMs)
    request.write(body)
    request.end()
  })
}

module.exports = { requestChat, buildChatUrl, normalizeUsage, USAGE_FIELDS }
