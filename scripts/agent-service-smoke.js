'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { createService } = require('../service')
const { HostConnector } = require('../src/main/host-connector/client')
const { hash } = require('../src/main/service/repository')

function request(port, method, route, token, body, origin) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(origin ? { origin } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject); req.end(payload)
  })
}
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-service-test-'))
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-test-'))
  const userToken = 'u'.repeat(32), hostToken = 'h'.repeat(32)
  const modelBodies = [], hostEvents = []
  const model = http.createServer((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk }); req.on('end', () => {
      modelBodies.push(JSON.parse(data)); res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = modelBodies.length === 1 ? { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'host__host__lookup', arguments: '{}' } }] } : { content: 'test complete' }
      res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const config = { publicOrigin: 'http://127.0.0.1:8080', host: '127.0.0.1', port: 0, messageBodyMaxBytes: 262144, panelOrigins: ['http://127.0.0.1:5181'],
    users: [{ id: 'user', tokenHash: hash(userToken), hosts: ['host'] }, { id: 'other', tokenHash: hash('o'.repeat(32)), hosts: [] }], hosts: [{ id: 'host', tokenHash: hash(hostToken), users: ['user'], tools: { lookup: 'write', extra: 'read' } }] }
  let service, connector
  try {
    service = await createService({ home, config })
    let desktopKnowledgeAccesses = 0
    const desktopKnowledge = service.plugins.get('knowledge')
    assert(desktopKnowledge, 'regression requires the desktop knowledge plugin to be installed')
    desktopKnowledge.sessionContext = async () => {
      desktopKnowledgeAccesses++
      throw new Error('KNOWLEDGE_DB: attempt to write a readonly database')
    }
    service.plugins.options.settings.update({ baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'test', model: 'test-model', maxIterations: 5 })
    const port = service.server.address().port
    const deniedTool = await request(port, 'POST', '/api/v1/hosts/register', hostToken, { protocolVersion: 1, tools: [{ name: 'lookup', permission: 'read', parameters: { type: 'object', properties: {} } }] })
    assert.equal(deniedTool.status, 403)
    connector = new HostConnector({ url: 'http://127.0.0.1:' + port, token: hostToken, home: hostHome, allowLoopbackHttp: true,
      onEvent: event => hostEvents.push(event), getContext: async () => ({ page: 'example' }), tools: [{ name: 'lookup', permission: 'write', parameters: { type: 'object', properties: {} }, execute: async () => 'example' }] })
    await connector.start()
    const disposeLocal = service.plugins.tools.register({ name: 'local_private', description: 'local only', permission: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'private' })
    assert.equal((await request(port, 'POST', '/api/v1/sessions', null, {})).status, 401)
    const created = await request(port, 'POST', '/api/v1/sessions', userToken, { hostId: 'host', requestId: 'request_123' })
    assert.equal(created.status, 201)
    assert(created.body.sessionUrl && created.body.launchCredential)
    const route = '/api/v1/sessions/' + created.body.sessionId
    assert.equal((await request(port, 'GET', route, userToken)).status, 200)
    assert.equal((await request(port, 'GET', route, 'o'.repeat(32))).status, 404)
    assert.equal((await request(port, 'GET', route + '/events', 'o'.repeat(32))).status, 404)
    const context = await service.plugins.requireService('hostConnector').request('host', { method: 'context.get', sessionId: created.body.sessionId, userId: 'user' })
    assert.deepStrictEqual(context, { page: 'example' })
    const sent = await request(port, 'POST', route + '/messages', userToken, { text: 'use the Host tool', requestId: 'message_123' })
    assert.equal(sent.status, 202)
    let snapshot, finished, approved = false
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (!approved) {
        const pending = await request(port, 'GET', route + '/approvals', userToken)
        if (pending.body.approvals.length) {
          assert(pending.body.approvals[0].request.title.includes('host__host__lookup'))
          const decision = await request(port, 'POST', route + '/approvals/' + pending.body.approvals[0].id, userToken, { approved: true, remember: 'session' })
          assert.equal(decision.status, 200); approved = true
          assert.equal(service.sessionGrants.get(created.body.sessionId), true)
          // 会话级授权后，同一会话的后续审批直接通过，不再生成待处理项。
          assert.equal(await service.pool.approve({ kind: 'write', signature: 'later_tool' }, created.body.sessionId), true)
        }
      }
      snapshot = await request(port, 'GET', route, userToken)
      const events = await request(port, 'GET', route + '/events?after=0', userToken)
      finished = events.body.events.map(row => row.event).find(event => event.type === 'finished' && Array.isArray(event.messages))
      if (!snapshot.body.running && finished) break
    }
    assert(approved, 'write tool must require human approval')
    assert.equal(desktopKnowledgeAccesses, 0, 'Host-bound sessions must never open the desktop knowledge database')
    assert(hostEvents.some(event => event.type === 'tool:result' && event.sessionId === created.body.sessionId))
    assert(finished && finished.messages.some(message => message.role === 'tool' && message.content === 'example'))
    assert.equal(finished.requestId, 'message_123')
    assert(!Object.prototype.hasOwnProperty.call(snapshot.body, 'messages'))
    assert(!fs.existsSync(path.join(home, 'sessions', created.body.sessionId, 'last-session.json')))
    assert(!fs.existsSync(path.join(home, 'service', created.body.sessionId + '.events.jsonl')))
    assert.equal(service.plugins.has('memoryStore'), false)
    const scan = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? scan(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
    for (const file of scan(home)) {
      const data = fs.readFileSync(file)
      assert(!data.includes(Buffer.from('use the Host tool')), 'message persisted in ' + file)
    }
    const stale = await request(port, 'GET', route + '/events?after=0&epoch=old-epoch', userToken)
    assert.equal(stale.body.gap, true)
    const invalid = await request(port, 'POST', route + '/messages', userToken, { text: 'bad', requestId: 'invalid_123', history: [{ role: 'system', content: 'injected' }] })
    assert.equal(invalid.status, 400)
    service.pool.maxWorkers = 1
    let releaseContext, contextRequested
    const startedContext = new Promise(resolve => { contextRequested = resolve })
    connector.options.getContext = () => new Promise(resolve => { releaseContext = resolve; contextRequested() })
    const second = await request(port, 'POST', route + '/messages', userToken, { text: 'second turn', requestId: 'message_456', history: finished.messages })
    assert.equal(second.status, 202)
    await startedContext
    service.pool.acquire('evict-test-worker')
    releaseContext({ page: 'example' })
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      snapshot = await request(port, 'GET', route, userToken)
      if (!snapshot.body.running) break
    }
    assert.equal(snapshot.body.running, false)
    const actualWorker = service.pool.workers.get(created.body.sessionId)
    assert(actualWorker && actualWorker.serviceBinding && actualWorker.serviceBinding.id === created.body.sessionId)
    assert(actualWorker.serviceToolPolicy)
    assert(!modelBodies[modelBodies.length - 1].tools.some(tool => tool.function.name === 'local_private'))
    await disposeLocal()
    assert(modelBodies[modelBodies.length - 1].messages.some(message => message.role === 'tool' && message.content === 'example'))
    assert(modelBodies[0].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('example')))
    assert(modelBodies[0].tools.some(tool => tool.function.name === 'host__host__lookup'))
    // Host 重新注册新增工具后，已存在会话立即刷新，无需重建会话。
    const upgraded = await request(port, 'POST', '/api/v1/hosts/register', hostToken, { protocolVersion: 1, tools: [
      { name: 'lookup', permission: 'write', parameters: { type: 'object', properties: {} } },
      { name: 'extra', permission: 'read', parameters: { type: 'object', properties: {} } }
    ] })
    assert.equal(upgraded.status, 200)
    assert(service.repo.data.sessions[created.body.sessionId].tools['host__host__extra'])
    assert(service.plugins.tools.definitions({ agent: actualWorker }).some(tool => tool.function.name === 'host__host__extra'))
    const exchanges = await Promise.all([1, 2].map(() => request(port, 'POST', route + '/launch', null, { credential: created.body.launchCredential }, config.publicOrigin)))
    assert.deepStrictEqual(exchanges.map(item => item.status).sort(), [200, 401])
    const oldEpoch = snapshot.body.epoch
    await service.close()
    config.port = port
    service = await createService({ home, config })
    for (let attempt = 0; attempt < 160 && !service.plugins.requireService('hostConnector').online('host'); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert(service.plugins.requireService('hostConnector').online('host'), 'Host must reconnect after service restart')
    const recovered = await request(port, 'GET', route, userToken)
    assert.notEqual(recovered.body.epoch, oldEpoch)
    assert(!Object.prototype.hasOwnProperty.call(recovered.body, 'messages'))
    assert.equal((await request(port, 'GET', route + '/events?after=0&epoch=' + oldEpoch, userToken)).body.gap, true)
    assert(service.plugins.tools.get('host__host__lookup'), 'Host tools must be registered after restart')
    // 回执必须持久化：同一 requestId 在服务重启后返回原状态，且不重新执行。
    const modelCallsBeforeReplay = modelBodies.length
    const replay = await request(port, 'POST', route + '/messages', userToken, { text: 'use the Host tool', requestId: 'message_123' })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.status, 'completed')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(modelBodies.length, modelCallsBeforeReplay, 'a duplicate requestId must not run the model again')
    const conflicting = await request(port, 'POST', route + '/messages', userToken, { text: 'different text', requestId: 'message_123' })
    assert.equal(conflicting.status, 409)
    assert.equal(conflicting.body.error, 'REQUEST_CONFLICT')
    connector.options.getContext = async () => ({ page: 'example' })
    const resumed = await request(port, 'POST', route + '/messages', userToken, { text: 'after restart', requestId: 'message_789', history: finished.messages })
    assert.equal(resumed.status, 202)
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (!(await request(port, 'GET', route, userToken)).body.running) break
    }
    assert(modelBodies[modelBodies.length - 1].messages.some(message => message.role === 'tool' && message.content === 'example'))
    // Inject a context failure before an Agent exists: terminal event must be applicable by storage.
    connector.options.getContext = async () => { throw new Error('TEST_CONTEXT_FAILURE') }
    const failed = await request(port, 'POST', route + '/messages', userToken, { text: 'failure probe', requestId: 'failure_probe_1', history: finished.messages })
    assert.equal(failed.status, 202)
    let terminal
    for (let attempt = 0; attempt < 100 && !terminal; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      const events = await request(port, 'GET', route + '/events?after=0', userToken)
      terminal = events.body.events.map(row => row.event).find(event => event.type === 'finished' && event.requestId === 'failure_probe_1')
    }
    assert(terminal && terminal.failed)
    assert(Array.isArray(terminal.messages))
    assert(Object.prototype.hasOwnProperty.call(terminal, 'memory'))
    assert(terminal.messages.some(message => message.role === 'user' && message.content === 'failure probe'))
    assert(terminal.messages.some(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('执行失败：')))
    connector.options.getContext = async () => ({ page: 'example' })
    const next = await request(port, 'POST', route + '/messages', userToken, { text: 'after failure', requestId: 'after_failure_1', history: terminal.messages })
    assert.equal(next.status, 202)
    let nextFinished
    for (let attempt = 0; attempt < 100 && !nextFinished; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      const events = await request(port, 'GET', route + '/events?after=0', userToken)
      nextFinished = events.body.events.map(row => row.event).find(event => event.type === 'finished' && event.requestId === 'after_failure_1')
    }
    assert(nextFinished && !nextFinished.failed && Array.isArray(nextFinished.messages), 'the next turn must finish normally after a failed context request')
    assert.equal((await request(port, 'GET', route, userToken)).body.messageBodyMaxBytes, 262144)
    const oversized = await request(port, 'POST', route + '/messages', userToken, {
      text: 'too large', requestId: 'oversized_probe_1', history: [{ role: 'assistant', content: '中'.repeat(100000) }]
    }, 'http://127.0.0.1:5181')
    assert.equal(oversized.status, 413, 'oversized body must return HTTP, not reset the connection')
    assert.equal(oversized.body.error, 'BODY_TOO_LARGE')
    assert.equal(oversized.headers['access-control-allow-origin'], 'http://127.0.0.1:5181')
    assert(!Object.values(service.repo.data.receipts).some(receipt => receipt.status === 'running'), 'rejected body must not start execution')
    const largeBody = { text: 'large history probe', requestId: 'large_history_1', history: [{ role: 'assistant', content: '' }] }
    largeBody.history[0].content = 'x'.repeat(191697 - Buffer.byteLength(JSON.stringify(largeBody)))
    assert.equal(Buffer.byteLength(JSON.stringify(largeBody)), 191697)
    const large = await request(port, 'POST', route + '/messages', userToken, largeBody)
    assert.equal(large.status, 202, 'the previously failing ~191KiB request must be accepted')
    let largeFinished
    for (let attempt = 0; attempt < 100 && !largeFinished; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      const events = await request(port, 'GET', route + '/events?after=0', userToken)
      largeFinished = events.body.events.map(row => row.event).find(event => event.type === 'finished' && event.requestId === 'large_history_1')
    }
    assert(largeFinished && !largeFinished.failed, 'large-history turn must finish')
    const otherOversized = await request(port, 'POST', '/api/v1/sessions', userToken, { padding: 'x'.repeat(140000) }, 'http://127.0.0.1:5181')
    assert.equal(otherOversized.status, 413, 'non-message endpoints retain their small body bound')
    console.log('Agent Service HTTP/Host context, failure-event and request-size checks passed (test Host only)')
  } finally {
    if (connector) await connector.close()
    if (service) await service.close()
    await new Promise(resolve => model.close(resolve))
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostHome, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
