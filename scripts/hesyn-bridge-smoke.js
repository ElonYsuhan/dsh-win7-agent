'use strict'
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto')
const { createService } = require('../service')
const { startHesynBridge } = require('../src/main/host-connector/hesyn-local')
const { hash } = require('../src/main/service/repository')
function post(port, route, value, origin) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value)
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
    req.on('error', reject); req.end(body)
  })
}
function stream(port, clientId, origin) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/stream?clientId=' + clientId, headers: { origin } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Error('STREAM_' + res.statusCode)); return }
      let buffer = '', waiter = null
      const frames = []
      const flush = () => {
        let index
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2)
          if (!/^event: tool-call$/m.test(frame)) continue
          const data = /^data: (.+)$/m.exec(frame)
          if (!data) continue
          frames.push(JSON.parse(data[1]))
          if (waiter) { const resolveFrame = waiter; waiter = null; resolveFrame(frames.shift()) }
        }
      }
      res.setEncoding('utf8')
      res.on('data', chunk => { buffer += chunk; flush() })
      res.once('data', () => resolve({ req, res, nextFrame: () => frames.length ? Promise.resolve(frames.shift()) : new Promise(done => { waiter = done }) }))
    })
    req.on('error', reject)
  })
}
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hesyn-service-smoke-')), hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hesyn-host-smoke-'))
  const hostToken = 'h'.repeat(32), userToken = 'u'.repeat(32), origin = 'http://127.0.0.1:5197'
  let service, bridge
  try {
    service = await createService({ home, config: { publicOrigin: 'http://127.0.0.1:18390', host: '127.0.0.1', port: 0, users: [{ id: 'user', tokenHash: hash(userToken), hosts: ['host'] }], hosts: [{ id: 'host', tokenHash: hash(hostToken), users: ['user'], tools: { get_context: 'read', list_equipment: 'read', get_selected_entity: 'read', entity_list: 'read', resource_search: 'read', entity_create: 'write', entity_update: 'write', entity_delete: 'write', hesyn_capabilities: 'read', hesyn_call: 'command' } }] } })
    bridge = await startHesynBridge({ serviceOrigin: 'http://127.0.0.1:' + service.server.address().port, origin, hostId: 'host', hostToken, userToken, home: hostHome, port: 0 })
    const port = bridge.server.address().port, clientId = crypto.randomUUID(), other = crypto.randomUUID()
    const context = { active: true, clientId, ready: true, sceneId: 'scene-1', sceneEpoch: 3, equipment: [{ id: 'e1' }], selectedEntity: { id: 'e1' } }
    assert.equal((await post(port, '/context', context, 'http://evil.example')).status, 403)
    await assert.rejects(stream(port, clientId, 'http://evil.example'), /STREAM_403/)
    let live = await stream(port, clientId, origin)
    assert.equal((await post(port, '/context', context, origin)).status, 200)
    assert.equal((await post(port, '/context', { ...context, clientId: other }, origin)).status, 409)
    assert.equal((await post(port, '/ticket', { clientId: other, sessionId: '' }, origin)).status, 409)
    const ticket = await post(port, '/ticket', { clientId, sessionId: '' }, origin)
    assert.equal(ticket.status, 200)
    assert.equal(JSON.parse(fs.readFileSync(path.join(hostHome, 'session-scenes.json'), 'utf8'))[ticket.body.sessionId], 'scene-1')
    assert.equal((await post(port, '/ticket', { clientId, sessionId: crypto.randomUUID(), projectId: 'scene-1' }, origin)).status, 409)
    const host = service.plugins.requireService('hostConnector'), call = { sessionId: ticket.body.sessionId, userId: 'user' }
    const actual = await host.request('host', { method: 'context.get', ...call })
    assert.equal(actual.sceneId, 'scene-1'); assert.equal(actual.selectedEntity.id, 'e1'); assert.equal(actual.clientId, undefined)
    const list = await host.request('host', { method: 'tools.call', ...call, tool: 'list_equipment', args: {} })
    assert.deepStrictEqual(list, [{ id: 'e1' }])
    // Same browser owner, different project: old credentials cannot operate on the new scene.
    assert.equal((await post(port, '/context', { ...context, sceneId: 'scene-other' }, origin)).status, 200)
    await assert.rejects(host.request('host', { method: 'context.get', ...call }), /HOST_CALL_FAILED/)
    assert.equal((await post(port, '/ticket', { clientId, sessionId: ticket.body.sessionId, projectId: 'scene-other' }, origin)).status, 409)
    assert.equal((await post(port, '/ticket', { clientId, sessionId: '', projectId: 'scene-1' }, origin)).status, 409)
    assert.equal((await post(port, '/context', context, origin)).status, 200)
    assert.equal((await post(port, '/ticket', { clientId, sessionId: ticket.body.sessionId, projectId: 'scene-1' }, origin)).status, 200)
    assert.equal((await host.request('host', { method: 'context.get', ...call })).sceneId, 'scene-1')
    // 能力发现与能力调用经由 SSE 下发到浏览器，结果由 /tool-result 回传。
    const capsPromise = host.request('host', { method: 'tools.call', ...call, tool: 'hesyn_capabilities', args: {} })
    const capsFrame = await live.nextFrame()
    assert.equal(capsFrame.payload.kind, 'capabilities')
    assert.equal(capsFrame.sceneEpoch, 3)
    assert.equal((await post(port, '/tool-result', { clientId: other, callId: capsFrame.callId, ok: true }, origin)).status, 409)
    assert.equal((await post(port, '/tool-result', { clientId, callId: capsFrame.callId, ok: true, result: { capabilities: [{ id: 'entity.create' }] } }, origin)).status, 200)
    assert.deepStrictEqual(await capsPromise, { capabilities: [{ id: 'entity.create' }] })
    assert.equal((await post(port, '/tool-result', { clientId, callId: capsFrame.callId, ok: true }, origin)).status, 404)
    const writePromise = host.request('host', { method: 'tools.call', ...call, tool: 'hesyn_call', args: { capabilityId: 'entity.create', input: { name: '指挥所-01' }, operationId: 'op-1', confirmed: true } })
    const writeOutcome = writePromise.then(value => ({ value }), error => ({ error }))
    const writeFrame = await live.nextFrame()
    assert.equal(writeFrame.payload.kind, 'call')
    assert.equal(writeFrame.payload.capabilityId, 'entity.create')
    assert.deepStrictEqual(writeFrame.payload.input, { name: '指挥所-01' })
    assert.equal(writeFrame.payload.operationId, 'op-1')
    assert.equal(writeFrame.payload.confirmed, true)
    await post(port, '/tool-result', { clientId, callId: writeFrame.callId, ok: false, error: 'REVISION_CONFLICT' }, origin)
    assert.match((await writeOutcome).error.message, /HOST_RESULT_UNCERTAIN|HOST_CALL_FAILED|REVISION_CONFLICT/)
    // 语义化工具 entity_create 直接出现在会话工具表中，执行仍走能力注册表。
    const createPromise = host.request('host', { method: 'tools.call', ...call, tool: 'entity_create', args: { resourceId: 'res-1', point: { lon: 116.3, lat: 39.9 } } })
    const createOutcome = createPromise.then(value => ({ value }), error => ({ error }))
    const createFrame = await live.nextFrame()
    assert.equal(createFrame.payload.kind, 'call')
    assert.equal(createFrame.payload.capabilityId, 'entity.create')
    assert(createFrame.payload.operationId)
    await post(port, '/tool-result', { clientId, callId: createFrame.callId, ok: true, result: { status: 'success', committed: true, entityId: 'e9', entityRevision: 1 } }, origin)
    assert.deepStrictEqual(await createOutcome, { value: { status: 'success', committed: true, entityId: 'e9', entityRevision: 1 } })
    assert.equal((await post(port, '/context', { ...context, selectedEntity: { id: 'e2' } }, origin)).status, 200)
    assert.equal((await host.request('host', { method: 'context.get', ...call })).selectedEntity.id, 'e2')
    const events = service.repo.eventBuffers.get(call.sessionId)
    assert(events && JSON.stringify(events).includes('host:context_changed'))
    await assert.rejects(host.request('host', { method: 'context.get', sessionId: crypto.randomUUID(), userId: 'user' }), /HOST_CALL_FAILED/)
    await post(port, '/context', { clientId: other, active: false }, origin)
    assert.equal((await host.request('host', { method: 'context.get', ...call })).sceneId, 'scene-1')
    // 浏览器断开时，尚未回传的能力调用立即失败，避免 Agent 挂到超时。
    const orphanPromise = host.request('host', { method: 'tools.call', ...call, tool: 'hesyn_call', args: { capabilityId: 'entity.create', input: {} } })
    const orphanOutcome = orphanPromise.then(value => ({ value }), error => ({ error }))
    const orphanFrame = await live.nextFrame()
    assert.equal(orphanFrame.payload.kind, 'call')
    live.req.destroy(); live.res.destroy()
    const orphan = await orphanOutcome
    assert.match(orphan.error.message, /HESYN_DISCONNECTED|HOST_RESULT_UNCERTAIN|HOST_CALL_FAILED/)
    await post(port, '/context', { clientId, active: false }, origin)
    await assert.rejects(host.request('host', { method: 'context.get', ...call }), /HOST_CALL_FAILED/)
    live = await stream(port, other, origin)
    assert.equal((await post(port, '/context', { ...context, clientId: other, sceneId: 'scene-2' }, origin)).status, 200)
    await assert.rejects(host.request('host', { method: 'context.get', ...call }), /HOST_CALL_FAILED/)
    await assert.rejects(host.request('host', { method: 'tools.call', ...call, tool: 'create_equipment', args: {} }), /HOST_CALL_FAILED/)
    live.req.destroy(); live.res.destroy()
    await bridge.close()
    bridge = await startHesynBridge({ serviceOrigin: 'http://127.0.0.1:' + service.server.address().port, origin, hostId: 'host', hostToken, userToken, home: hostHome, port: 0 })
    const restartedPort = bridge.server.address().port
    live = await stream(restartedPort, clientId, origin)
    await post(restartedPort, '/context', { ...context, sceneId: 'scene-2' }, origin)
    assert.equal((await post(restartedPort, '/ticket', { clientId, sessionId: ticket.body.sessionId, projectId: 'scene-2' }, origin)).status, 409)
    await post(restartedPort, '/context', context, origin)
    assert.equal((await post(restartedPort, '/ticket', { clientId, sessionId: ticket.body.sessionId, projectId: 'scene-1' }, origin)).status, 200)
    live.req.destroy(); live.res.destroy()
    console.log('HESYN bridge: origin, persistent project binding, single owner, read tools, capability round-trip, disconnect cleanup passed')
  } finally {
    if (bridge) await bridge.close()
    if (service) await service.close()
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostHome, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
