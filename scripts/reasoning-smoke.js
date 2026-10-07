'use strict'

const http = require('http')
const { requestChat } = require('../src/main/agent/llm')

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'step one' } }] }) + '\n\n')
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }) + '\n\n')
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const deltas = []
  const result = await requestChat({
    settings: {
      baseURL: 'http://127.0.0.1:' + port + '/v1',
      apiKey: 'x',
      model: 'mock',
      temperature: 0,
      requestTimeoutMs: 5000
    },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: (delta) => deltas.push(delta)
  })
  server.close()
  console.log('deltas', JSON.stringify(deltas))
  console.log('content', result.content)
  if (not(deltas.some((delta) => delta.type === 'thinking' && delta.text === 'step one'))) throw new Error('thinking delta missing')
  if (result.content !== 'answer') throw new Error('content mismatch')
}

const not = (value) => value ? false : true

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
