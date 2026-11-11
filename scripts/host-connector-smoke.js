'use strict'
const assert = require('assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { HostConnector } = require('../src/main/host-connector/client')

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-test-'))
  const results = []
  let stream, registrations = 0, failResult = false
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + 'x'.repeat(32)) { res.writeHead(401).end(); return }
    if (req.url === '/api/v1/hosts/self/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); stream = res; return
    }
    let text = ''
    req.on('data', c => { text += c })
    req.on('end', () => {
      const data = JSON.parse(text)
      if (req.url === '/api/v1/hosts/register') { registrations++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ hostId: 'sample' })) }
      else if (failResult) { failResult = false; res.writeHead(503).end() }
      else { results.push(data); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let count = 0
  const connector = new HostConnector({ url: 'http://127.0.0.1:' + server.address().port, token: 'x'.repeat(32), home, allowLoopbackHttp: true,
    getContext: async () => ({ current: 'example' }), tools: [{ name: 'write', permission: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { count++; return 'done' } }] })
  try {
    await connector.start()
    const id = crypto.randomUUID()
    const command = { protocolVersion: 1, id, method: 'tools.call', sessionId: 'session', userId: 'user', tool: 'write', args: {} }
    await connector.handle(command)
    await connector.handle(command)
    assert.equal(count, 1)
    assert.equal(results.length, 2)
    assert.equal(results[0].result, 'done')
    assert.equal(results[1].resultHash, require('../src/main/service/repository').hash('done'))
    assert(!fs.readFileSync(path.join(home, 'host-calls.json'), 'utf8').includes('done'))
    stream.destroy()
    for (let i = 0; i < 200 && registrations < 2; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert(registrations >= 2, 'stream reconnect must register tools again')
    const lostId = crypto.randomUUID()
    failResult = true
    await assert.rejects(connector.handle({ ...command, id: lostId }), /HOST_HTTP_503/)
    assert.equal(count, 2)
    await connector.close()
    const interruptedId = crypto.randomUUID()
    const ledgerPath = path.join(home, 'host-calls.json')
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    ledger.calls[interruptedId] = { digest: 'old', status: 'running' }
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
    const restarted = new HostConnector({ ...connector.options })
    await restarted.start()
    for (let i = 0; i < 100 && (!results.some(row => row.id === lostId) || !results.some(row => row.id === interruptedId)); i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(results.find(row => row.id === interruptedId).status, 'uncertain')
    const recovered = results.find(row => row.id === lostId)
    assert(recovered && recovered.status === 'succeeded' && recovered.resultHash)
    assert(!Object.prototype.hasOwnProperty.call(recovered, 'result'))
    await restarted.handle(command)
    assert.equal(count, 2)
    assert(registrations >= 2)
    await restarted.close()
    console.log('host integration protocol test passed (simulated Host/service only)')
  } finally {
    await connector.close()
    if (stream) stream.destroy()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
