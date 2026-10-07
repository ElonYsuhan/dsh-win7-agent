'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { Agent } = require('../src/main/agent/agent')

const not = (value) => value ? false : true

async function main() {
  const seen = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString() })
    request.on('end', () => {
      const payload = JSON.parse(body || '{}')
      seen.push(payload.messages || [])
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n')
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-iso-'))
  const settings = {
    data: {
      baseURL: 'http://127.0.0.1:' + server.address().port + '/v1',
      apiKey: 'x',
      model: 'mock',
      temperature: 0,
      maxIterations: 3,
      approveWrites: false,
      approveCommands: false
    },
    update: () => undefined,
    workspacePath: root
  }
  const agent = new Agent(settings, () => undefined, async () => true, path.join(root, 'sessions'))
  agent.workspaceRoot = root
  await agent.run('first message', [])
  await agent.run('second message', [])
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
  const second = seen[1] || []
  const leaked = second.some((message) => message.role === 'user' && message.content === 'first message')
  console.log('requests', seen.length)
  console.log('second includes first:', leaked)
  if (leaked) throw new Error('session context leaked')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
