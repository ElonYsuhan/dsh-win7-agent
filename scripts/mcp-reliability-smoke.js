'use strict'
const assert = require('assert')
const http = require('http')
const { HttpClient, parseSse } = require('../src/main/mcp/http-client')
const { listTools } = require('../src/main/mcp/discovery')
const contract = require('../src/main/contracts/mcp')

module.exports = async function reliability() {
  assert.throws(() => contract.assertResponse({ jsonrpc: '2.0', id: 1 }), /INVALID_RESPONSE/)
  assert.throws(() => contract.assertResponse({ jsonrpc: '2.0', id: 2, result: {} }, 1), /ID_MISMATCH/)
  assert.throws(() => contract.assertResponse({ jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'x' } }), /INVALID_RESPONSE/)
  assert.strictEqual(parseSse('data: {"jsonrpc":"2.0","id":2,"result":{}}\n\n', 1), null)
  const schema = { type: 'object', properties: { value: { $ref: '#/$defs/value' } }, $defs: { value: { oneOf: [{ type: 'string' }, { type: 'number', minimum: 1 }] } } }
  assert.deepStrictEqual(contract.toolSchema(schema), schema)
  const tool = name => ({ name, inputSchema: { type: 'object', properties: {} } })
  const pages = []
  const catalogue = await listTools({ capabilities: { tools: {} }, request: async (method, params) => {
    pages.push(params); return params.cursor ? { tools: [tool('second')] } : { tools: [tool('first')], nextCursor: 'page2' }
  } })
  assert.strictEqual(catalogue.length, 2); assert.strictEqual(pages[1].cursor, 'page2')
  await assert.rejects(listTools({ capabilities: { tools: {} }, request: async () => ({ tools: [], nextCursor: 'loop' }) }), /CURSOR/)
  await assert.rejects(listTools({ capabilities: { tools: {} }, request: async () => ({ tools: [tool('a.b'), tool('a_b')] }) }), /COLLISION/)
  assert.deepStrictEqual(await listTools({ capabilities: {}, request: () => { throw Error('must not call') } }), [])
  let mode = '', initializations = 0, calls = 0, deleted = 0, cancels = 0
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      if (req.method === 'DELETE') { deleted++; res.end(); return }
      const m = JSON.parse(body), reply = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: value })) }
      if (m.method === 'initialize') {
        initializations++; assert(!req.headers['mcp-session-id']); res.setHeader('mcp-session-id', 'session-' + initializations)
        reply({ protocolVersion: mode === 'version' ? '2099-01-01' : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fault-server', version: '1' } }); return
      }
      if (m.method === 'notifications/cancelled') cancels++
      if (m.id === undefined) { res.writeHead(202); res.end(); return }
      assert.strictEqual(req.headers['mcp-protocol-version'], '2025-06-18')
      if (m.method === 'tools/call') calls++
      if (mode === 'expired') { mode = ''; res.writeHead(404); res.end(); return }
      if (mode === 'wrong-id') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id + 100, result: {} })); return }
      if (mode === 'truncated') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 1000 }); res.write('{'); setTimeout(() => res.destroy(), 10); return }
      if (mode === 'hang' || mode === 'heartbeat') {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n')
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 30); res.on('close', () => clearInterval(timer)); return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: '+JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })+'\n\n')
      const bytes = Buffer.from('data: '+JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '中文结果' }] } })+'\n\n')
      const split = bytes.indexOf(Buffer.from('中')) + 1
      res.write(bytes.subarray(0, split)); setTimeout(() => res.write(bytes.subarray(split)), 10) // intentionally keep stream open
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = { url: 'http://127.0.0.1:'+server.address().port+'/mcp', timeoutMs: 250, headers: { ACCEPT: 'bad', 'MCP-Protocol-Version': 'bad' } }
  let client
  try {
    client = new HttpClient(config); await client.start()
    assert.strictEqual((await client.callTool('x', {})).content[0].text, '中文结果')
    mode = 'wrong-id'; await assert.rejects(client.callTool('x', {}), /ID_MISMATCH/)
    mode = 'truncated'; await assert.rejects(client.callTool('x', {}), /ABORTED|ECONNRESET/)
    mode = 'heartbeat'; const at = Date.now(); await assert.rejects(client.callTool('x', {}), /TIMEOUT/); assert(Date.now() - at < 1000)
    mode = 'hang'; const controller = new AbortController(), pending = client.callTool('x', {}, { signal: controller.signal }); setTimeout(() => controller.abort(), 20)
    await assert.rejects(pending, /ABORTED/); await new Promise(resolve => setTimeout(resolve, 30)); assert(cancels >= 1)
    mode = 'expired'; const before = calls; await assert.rejects(client.callTool('x', {}), /HTTP_404/); assert.strictEqual(calls, before + 1); assert.strictEqual(initializations, 2)
    mode = 'hang'; const inFlight = client.callTool('x', {}); const rejection = assert.rejects(inFlight, /CLOSED/); await client.close(); await rejection
    assert.strictEqual(client.active.size, 0); assert(deleted); await assert.rejects(client.callTool('x', {}), /CLOSED/)
    mode = 'version'; const bad = new HttpClient(config); try { await assert.rejects(bad.start(), /VERSION_UNSUPPORTED/) } finally { await bad.close() }
  } finally {
    if (client) await client.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
  console.log('MCP reliability: pagination, negotiation, response IDs, streaming UTF-8, deadlines, cancellation, session recovery without replay, teardown passed')
}
