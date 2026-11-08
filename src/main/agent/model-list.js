'use strict'

const { request: networkRequest } = require('./network-proxy')

const not = (value) => value ? false : true

function normalizeBaseURL(baseURL) {
  let target = String(baseURL || '').trim()
  while (target.endsWith('/')) target = target.slice(0, -1)
  if (target.endsWith('/chat/completions')) target = target.slice(0, -'/chat/completions'.length)
  if (not(target.endsWith('/v1'))) target += '/v1'
  return target
}

function fetchModelList(baseURL, apiKey) {
  return new Promise((resolve, reject) => {
    const target = normalizeBaseURL(baseURL) + '/models'
    if (String(baseURL || '').trim() === '') {
      reject(new Error('MODEL_NOT_CONFIGURED'))
      return
    }
    let parsed = null
    try {
      parsed = new URL(target)
    } catch (error) {
      reject(new Error('MODEL_LIST_BAD_URL'))
      return
    }
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { accept: 'application/json' },
      timeout: 15000
    }
    if (apiKey) options.headers.authorization = 'Bearer ' + apiKey
    let settled = false
    let timer = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const request = networkRequest(parsed, options, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 8 * 1024 * 1024) request.destroy(new Error('MODEL_LIST_TOO_LARGE'))
      })
      response.on('error', finish)
      response.on('aborted', () => finish(new Error('MODEL_LIST_RESPONSE_ABORTED')))
      response.on('end', () => {
        if (response.statusCode >= 400) return finish(new Error('MODEL_LIST_HTTP_' + response.statusCode))
        try {
          const value = JSON.parse(body)
          const raw = Array.isArray(value.data) ? value.data : (Array.isArray(value.models) ? value.models : [])
          finish(null, raw.map((item) => typeof item === 'string' ? item : String((item && (item.id || item.name)) || '')).filter(Boolean))
        } catch (error) { finish(new Error('MODEL_LIST_BAD_JSON')) }
      })
    })
    request.on('error', finish)
    // 覆盖 DNS、CONNECT 和 TLS 建立阶段，而不仅是已连接 socket 的空闲时间。
    timer = setTimeout(() => request.destroy(new Error('MODEL_LIST_TIMEOUT')), 15000)
    request.end()
  })
}

module.exports = { fetchModelList, normalizeBaseURL }
