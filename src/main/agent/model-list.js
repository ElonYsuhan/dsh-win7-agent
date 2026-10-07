'use strict'

const http = require('http')
const https = require('https')

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
    const transport = parsed.protocol === 'https:' ? https : http
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
    const request = transport.request(options, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk.toString('utf8') })
      response.on('end', () => {
        if (response.statusCode >= 400) {
          reject(new Error('MODEL_LIST_HTTP_' + response.statusCode))
          return
        }
        try {
          const value = JSON.parse(body)
          const raw = Array.isArray(value.data) ? value.data : (Array.isArray(value.models) ? value.models : [])
          resolve(raw.map((item) => typeof item === 'string' ? item : String((item && (item.id || item.name)) || '')).filter(Boolean))
        } catch (error) {
          reject(new Error('MODEL_LIST_BAD_JSON'))
        }
      })
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('MODEL_LIST_TIMEOUT')))
    request.end()
  })
}

module.exports = { fetchModelList, normalizeBaseURL }
