'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { Agent } = require('../src/main/agent/agent')
const { AssetStore } = require('../src/main/agent/asset-store')
const compressor = require('../src/main/agent/context-compressor')

const not = (value) => value ? false : true
const NL = String.fromCharCode(10)

function assert(condition, message) {
  if (not(condition)) throw new Error(message)
}

function isSummarizerRequest(payload) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
  return messages.some((message) => typeof message.content === 'string' && message.content.indexOf('compress older agent conversation') >= 0)
}

async function unitTests() {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(5000) },
    { role: 'user', content: 'next' }
  ]
  const groups = compressor.groupMessages(messages)
  assert(groups.length === 3, 'expected 3 message groups')
  const boundary = compressor.findCompactionBoundary(messages, { keepRecentMessages: 2 })
  assert(boundary === 2, 'boundary must not split tool pair, got ' + boundary)
  const view = compressor.buildContextView('sys', messages, { text: 'memory-abc', through: 4 })
  assert(view[0].content.indexOf('memory-abc') >= 0, 'memory must be in system prompt')
  assert(view.length === 2, 'expected compressed slice after through')
  assert(compressor.isContextLengthError(new Error('This model maximum context length is 1048576 tokens')), 'detect context error')
  console.log('unit tests ok')
}

async function assetTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-asset-'))
  const store = new AssetStore(path.join(root, 'assets'))
  const dataUrl = 'data:image/png;base64,' + Buffer.from('hello-asset').toString('base64')
  const sessionDir = path.join(root, 'sessions', 's1')
  const meta = store.saveDataUrl(dataUrl, { name: 'probe.png', sessionDir })
  assert(meta.id && meta.id.length === 64, 'asset id must be sha256')
  assert(store.readDataUrl(meta.id) === dataUrl, 'asset read must round-trip')
  assert(meta.sessionPath && fs.existsSync(meta.sessionPath), 'asset must be mirrored into session files')
  assert(meta.sessionPath.indexOf(path.join('sessions', 's1', 'files')) !== -1, 'session asset path must stay outside workspace')
  fs.rmSync(root, { recursive: true, force: true })
  console.log('asset tests ok')
}

async function integrationTest() {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch (error) { parsed = null }
      requests.push(parsed)
      const normalCalls = requests.filter((item) => item && Array.isArray(item.messages) && not(isSummarizerRequest(item)))
      if (isSummarizerRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'SUMMARY-MEMORY' } }] }) + NL + NL)
        response.write('data: [DONE]' + NL + NL)
        response.end()
        return
      }
      if (normalCalls.length === 1) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'This model maximum context length is 1048576 tokens' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' } }] }) + NL + NL)
      response.write('data: [DONE]' + NL + NL)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-'))
  const assetStore = new AssetStore(path.join(root, 'assets'))
  const settings = {
    data: {
      baseURL: 'http://127.0.0.1:' + port + '/v1',
      apiKey: 'test',
      model: 'mock',
      temperature: 0,
      maxIterations: 3,
      maxTokens: 2048,
      contextAutoCompress: true,
      contextWindowTokens: 0,
      contextCompressThreshold: 0.8,
      keepRecentMessages: 2,
      summaryMaxTokens: 256,
      approveWrites: false,
      approveCommands: false
    },
    update: () => undefined
  }
  const events = []
  const agent = new Agent(settings, (event) => events.push(event), async () => true, path.join(root, 'sessions'), undefined, assetStore)
  agent.workspaceRoot = root
  const history = [
    { role: 'system', content: 'old system' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'another old question' },
    { role: 'assistant', content: 'another old answer' }
  ]
  await agent.run('current question', history, undefined, undefined)
  server.close()
  const normalRequests = requests.filter((item) => item && Array.isArray(item.messages) && not(isSummarizerRequest(item)))
  assert(normalRequests.length >= 2, 'expected a retry after context length error')
  const retry = normalRequests[normalRequests.length - 1]
  assert(String(retry.messages[0].content).indexOf('SUMMARY-MEMORY') >= 0, 'retry payload must contain compressed memory')
  assert(Number(retry.max_tokens) === 2048, 'max_tokens must be sent to the model')
  const finished = events.filter((event) => event.type === 'finished').pop()
  assert(finished && finished.memory && finished.memory.text === 'SUMMARY-MEMORY', 'finished event must carry memory')
  assert(agent.memory === null && agent.messages.length === 0, 'idle agent must release conversation memory')
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'sessions', 'last-session.json'), 'utf8'))
  assert(saved.memory && saved.memory.text === 'SUMMARY-MEMORY', 'memory must be persisted in session file')
  assert(events.some((event) => event.type === 'context:compressed'), 'context:compressed event must be emitted')
  fs.rmSync(root, { recursive: true, force: true })
  console.log('integration tests ok')
}

async function main() {
  await unitTests()
  await assetTests()
  await integrationTest()
  console.log('context compression smoke passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
