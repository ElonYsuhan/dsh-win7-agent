'use strict'

const http = require('http')

const not = (value) => value ? false : true

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const request = http.request({
      host: '127.0.0.1',
      port: 8080,
      path,
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (response) => {
      let text = ''
      response.on('data', (chunk) => { text += chunk.toString() })
      response.on('end', () => resolve({ status: response.statusCode, text }))
    })
    request.on('error', reject)
    if (data) request.write(data)
    request.end()
  })
}

async function main() {
  const timer = setTimeout(() => {
    console.error('TIMEOUT waiting for finished event')
    process.exit(2)
  }, 15000)
  let buffer = ''
  const events = []
  let markReady
  const ready = new Promise((resolve) => { markReady = resolve })
  const done = new Promise((resolve) => {
    const stream = http.get('http://127.0.0.1:8080/api/events', (response) => {
      markReady()
      response.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop()
        for (const line of lines) {
          if (not(line.startsWith('data:'))) continue
          const event = JSON.parse(line.slice(5).trim())
          events.push(event)
          if (event.type === 'finished') {
            stream.destroy()
            resolve()
          }
        }
      })
    })
    stream.on('error', resolve)
  })
  await ready
  await request('POST', '/api/chat', { text: 'hello' })
  await done
  clearTimeout(timer)
  for (const event of events) {
    console.log(event.type, event.name || event.text || '')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
