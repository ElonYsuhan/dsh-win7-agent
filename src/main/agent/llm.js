'use strict'

const http = require('http')
const https = require('https')

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
  const transport = parsed.protocol === 'https:' ? https : http
  const payload = {
    model: settings.model,
    messages,
    temperature: Number(settings.temperature) || 0,
    stream: true
  }
  if (tools.length > 0) payload.tools = tools
  const requestedMaxTokens = Number(options.maxTokens) || Number(settings.maxTokens) || 0
  if (requestedMaxTokens > 0) payload.max_tokens = Math.floor(requestedMaxTokens)
  const body = JSON.stringify(payload)
  const timeoutMs = Math.max(5000, Math.min(3600000, Number(settings.requestTimeoutMs) || 1800000))
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    accept: 'text/event-stream, application/json'
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
    const finish = (error, value) => {
      if (settled) return
      settled = true
      request.destroy()
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => {
      request.destroy(new Error('ABORTED'))
    }
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers
    }, (response) => {
      if (response.statusCode >= 400) {
        let errorBody = ''
        /* 必须先 setEncoding：Node 默认给 Buffer，直接 toString('utf8') 会在
           多字节字符被 TCP 切断时解出 U+FFFD（中文回复变成一串黑菱形）。 */
        response.setEncoding('utf8')
        response.on('data', (chunk) => { if (acceptChunk(chunk)) errorBody += chunk.slice(0, Math.max(0,1200-errorBody.length)) })
        response.on('end', () => {
          finish(new Error('LLM_HTTP_' + response.statusCode + ': ' + errorBody.slice(0, 1200)))
        })
        return
      }
      const contentType = String(response.headers['content-type'] || '')
      const content = []
      const toolCalls = []
      let raw = ''
      let buffer = ''
    let responseRef = null
      let responseEnded = false
      const consumeLine = (line) => {
        if (settled) return
        const trimmed = line.trim()
        if (trimmed === '') return
        if (not(trimmed.startsWith('data:'))) return
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          finish(null, { content: content.join(''), toolCalls })
          if (responseRef && typeof responseRef.destroy === 'function') responseRef.destroy()
          return
        }
        const parsedLine = safeJsonParse(data)
        if (not(parsedLine)) return
        const choice = parsedLine.choices && parsedLine.choices[0]
        if (not(choice)) return
        const delta = choice.delta || {}
        if (delta.content) {
          content.push(delta.content)
          onDelta({ type: 'content', text: delta.content })
        }
        const reasoning = delta.reasoning_content || delta.reasoning
        if (reasoning) {
          onDelta({ type: 'thinking', text: reasoning })
        }
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls) {
            appendToolCall(toolCalls, toolDelta)
            onDelta({ type: 'tool_call_delta', delta: toolDelta })
          }
        }
        if (choice.finish_reason) {
          finish(null, { content: content.join(''), toolCalls })
          if (typeof response.destroy === 'function') response.destroy()
        }
      }
      if (contentType.includes('application/json')) {
        response.setEncoding('utf8')
        response.on('data', (chunk) => { if (acceptChunk(chunk)) raw += chunk })
        response.on('end', () => {
          if (settled) return
          responseEnded = true
          const parsedBody = safeJsonParse(raw)
          if (not(parsedBody)) return finish(new Error('LLM_BAD_JSON: ' + raw.slice(0, 800)))
          const message = parsedBody.choices && parsedBody.choices[0] && parsedBody.choices[0].message
          if (not(message)) return finish(new Error('LLM_BAD_RESPONSE: ' + raw.slice(0, 800)))
          if (message.content) onDelta({ type: 'content', text: message.content })
          const reasoning = message.reasoning_content || message.reasoning
          if (reasoning) onDelta({ type: 'thinking', text: reasoning })
          if (message.tool_calls) {
            for (const call of message.tool_calls) appendToolCall(toolCalls, call)
          }
          finish(null, { content: message.content || '', toolCalls })
        })
        return
      }
      /* setEncoding('utf8') 让 Node 用 StringDecoder 跨 chunk 拼接，半个汉字
         不会被解成 U+FFFD（用户 2026-10-17 报的「回复里出现黑菱形」）。 */
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        if (!acceptChunk(chunk)) return
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop()
        for (const line of lines) consumeLine(line)
      })
      response.on('end', () => {
        if (settled) return
        if (buffer.length) consumeLine(buffer)
        responseEnded = true
        finish(null, { content: content.join(''), toolCalls })
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
  const transport = parsed.protocol === 'https:' ? https : http
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
      const message = parsedLine.message || {}
      if (message.thinking) onDelta({ type: 'thinking', text: message.thinking })
      if (message.content) {
        content.push(message.content)
        onDelta({ type: 'content', text: message.content })
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const normalized = normalizeOllamaToolCalls(message.tool_calls)
        toolCalls.length = 0
        for (const call of normalized) toolCalls.push(call)
      }
      if (parsedLine.done === true) {
        finish(null, { content: content.join(''), toolCalls })
        if (responseRef && typeof responseRef.destroy === 'function') responseRef.destroy()
      }
    }
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers
    }, (response) => {
      responseRef = response
      response.setEncoding('utf8')
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
        finish(null, { content: content.join(''), toolCalls })
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

module.exports = { requestChat, buildChatUrl }
