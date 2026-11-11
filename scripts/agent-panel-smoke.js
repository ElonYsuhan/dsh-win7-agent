'use strict'

// AgentPanel 组件入口、CORS、面板票据与宿主存储契约的 Node 定向检查。
// 不启动模型、不执行工具；浏览器挂载与 IndexedDB 恢复由 agent-panel-browser-smoke 覆盖。

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { createService } = require('../service')
const { HostConnector } = require('../src/main/host-connector/client')
const { hash } = require('../src/main/service/repository')
const VERSION = require('../src/panel/manifest.json').version

function request(options) {
  return new Promise((resolve, reject) => {    const payload = options.body === undefined ? '' : JSON.stringify(options.body)
    const headers = Object.assign({}, options.headers || {})
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
    const req = http.request({ hostname: '127.0.0.1', port: options.port, path: options.path, method: options.method || 'GET', headers }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, body: text && /^application\/json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function main() {
  require('./build-agent-panel').run(true)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-panel-test-'))
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-panel-host-'))
  const userToken = 'u'.repeat(32), hostToken = 'h'.repeat(32)
  const panelOrigin = 'http://127.0.0.1:18888'
  let service, connector
  const config = {
    publicOrigin: 'http://127.0.0.1:0',
    host: '127.0.0.1',
    port: 0,
    panelOrigins: [panelOrigin, 'http://127.0.0.1:5191', 'http://localhost:5191', 'http://127.0.0.1:5180', 'http://localhost:5180'],
    allowPanelSettings: true,
    users: [{ id: 'user', tokenHash: hash(userToken), hosts: ['host'] }],
    hosts: [{ id: 'host', tokenHash: hash(hostToken), users: ['user'], tools: {} }]
  }
  try {
    service = await createService({ home, config })
    const port = service.server.address().port
    config.publicOrigin = 'http://127.0.0.1:' + port
    const panelPath = '/panel/' + VERSION + '/agent-panel.js'

    const served = await request({ port, path: panelPath, headers: { origin: panelOrigin } })
    assert.equal(served.status, 200)
    assert.equal(served.headers['access-control-allow-origin'], panelOrigin)
    assert(/immutable/.test(served.headers['cache-control']))
    const manifest = await request({ port, path: '/panel/' + VERSION + '/manifest.json', headers: { origin: panelOrigin } })
    assert.equal(manifest.status, 200)
    const entry = manifest.body.files.find(file => file.path === 'agent-panel.js')
    assert.equal(crypto.createHash('sha256').update(served.text).digest('hex'), entry.sha256)
    assert.deepStrictEqual(manifest.body.dependencies, [])
    assert.match(served.headers['content-type'], /javascript/)
    assert.match(manifest.headers['content-type'], /json/)
    const storage = await request({ port, path: '/panel/' + VERSION + '/host-storage.js', headers: { origin: panelOrigin } })
    assert.equal(storage.status, 200)
    assert.match(storage.headers['content-type'], /javascript/)
    assert.equal(crypto.createHash('sha256').update(storage.text).digest('hex'), manifest.body.files.find(file => file.path === 'host-storage.js').sha256)
    const missing = await request({ port, path: '/panel/' + VERSION + '/missing.js' })
    assert.equal(missing.status, 404)
    assert(!/^text\/html/.test(missing.headers['content-type'] || ''), 'missing asset must not return HTML')
    assert(!served.text.includes('indexedDB'), '组件不得自行创建浏览器数据库')
    assert(!served.text.includes('iframe'), '组件不得使用 iframe')

    for (const origin of ['http://127.0.0.1:5191', 'http://localhost:5191', 'http://127.0.0.1:5180', 'http://localhost:5180']) {
      const response = await request({ port, path: panelPath, headers: { origin } })
      assert.equal(response.status, 200)
      assert.equal(response.headers['access-control-allow-origin'], origin)
    }
    assert.equal((await request({ port, path: panelPath, headers: { origin: 'http://127.0.0.1:19999' } })).status, 403)
    const preflight = await request({ port, path: '/api/v1/sessions/00000000-0000-4000-8000-000000000000/events', method: 'OPTIONS', headers: { origin: panelOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], panelOrigin)
    assert(/authorization/.test(preflight.headers['access-control-allow-headers']))
    assert(/PUT/.test(preflight.headers['access-control-allow-methods']))
    assert.equal((await request({ port, path: '/api/v1/sessions/00000000-0000-4000-8000-000000000000/events', method: 'OPTIONS', headers: { origin: 'http://evil.example' } })).status, 403)

    connector = new HostConnector({ url: config.publicOrigin, token: hostToken, home: hostHome, allowLoopbackHttp: true, getContext: async () => ({}), tools: [] })
    await connector.start()
    const created = await request({ port, path: '/api/v1/sessions', method: 'POST', headers: { authorization: 'Bearer ' + userToken }, body: { hostId: 'host', requestId: 'panel_test_1' } })
    assert.equal(created.status, 201)
    const sessionId = created.body.sessionId
    const route = '/api/v1/sessions/' + sessionId

    const denied = await request({ port, path: route + '/panel-token', method: 'POST', headers: { origin: 'http://evil.example' }, body: { credential: created.body.launchCredential } })
    assert.equal(denied.status, 403)
    const token = await request({ port, path: route + '/panel-token', method: 'POST', headers: { origin: panelOrigin }, body: { credential: created.body.launchCredential } })
    assert.equal(token.status, 200)
    assert(token.body.token && token.body.expiresAt > Date.now())
    const replay = await request({ port, path: route + '/panel-token', method: 'POST', headers: { origin: panelOrigin }, body: { credential: created.body.launchCredential } })
    assert.equal(replay.status, 401, '面板票据必须单次使用')

    const bearer = { authorization: 'Bearer ' + token.body.token, origin: panelOrigin }
    const snapshot = await request({ port, path: route, headers: bearer })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.body.sessionId, sessionId)
    assert.equal(snapshot.body.userId, 'user')
    assert.equal(snapshot.headers['access-control-allow-origin'], panelOrigin)
    assert(!Object.prototype.hasOwnProperty.call(snapshot.body, 'messages'))

    const crossOriginWrite = await request({ port, path: route + '/cancel', method: 'POST', headers: { authorization: 'Bearer ' + token.body.token, origin: 'http://evil.example' }, body: {} })
    assert.equal(crossOriginWrite.status, 403, '面板令牌的写请求必须来自已登记 Origin')
    assert.equal((await request({ port, path: route + '/cancel', method: 'POST', headers: bearer, body: {} })).status, 200)

    // 模型设置：面板令牌可读可写，但永不回显密钥，且写操作受 Origin 限制。
    const modelView = await request({ port, path: '/api/v1/settings/models', headers: bearer })
    assert.equal(modelView.status, 200)
    assert(Array.isArray(modelView.body.models) && modelView.body.models.length >= 1)
    assert(modelView.body.models.every(model => !Object.prototype.hasOwnProperty.call(model, 'apiKey')))
    const modelId = modelView.body.models[0].id
    const savedModels = await request({ port, path: '/api/v1/settings/models', method: 'PUT', headers: bearer, body: { models: modelView.body.models.map(model => ({ id: model.id, name: '本机模型', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen-test', apiKey: 'secret-test-key' })), currentModelId: modelId, maxIterations: 42 } })
    assert.equal(savedModels.status, 200)
    assert.equal(savedModels.body.maxIterations, 42)
    assert.equal(savedModels.body.models[0].name, '本机模型')
    assert.equal(savedModels.body.models[0].model, 'qwen-test')
    assert.equal(savedModels.body.models[0].hasApiKey, true)
    assert(!JSON.stringify(savedModels.body).includes('secret-test-key'), '模型接口不得回显密钥')
    assert.equal((await request({ port, path: '/api/v1/settings/models', method: 'PUT', headers: { authorization: 'Bearer ' + token.body.token, origin: 'http://evil.example' }, body: { maxIterations: 5 } })).status, 403)
    assert.equal((await request({ port, path: '/api/v1/settings/models', method: 'PUT', headers: bearer, body: { maxIterations: 0 } })).status, 400)

    const minted = await request({ port, path: route + '/tickets', method: 'POST', headers: { authorization: 'Bearer ' + userToken }, body: {} })
    assert.equal(minted.status, 200)
    assert(minted.body.credential)
    assert.equal((await request({ port, path: route + '/tickets', method: 'POST', headers: { authorization: 'Bearer ' + token.body.token }, body: {} })).status, 401, '面板令牌不能自行续发票据')

    const hostOptions = await request({ port, path: '/api/v1/hosts/self/results', method: 'POST', headers: { authorization: 'Bearer ' + hostToken }, body: { protocolVersion: 1, method: 'heartbeat' } })
    assert.equal(hostOptions.status, 200)

    const oldToken = token.body.token
    await service.close()
    config.port = port
    service = await createService({ home, config })
    for (let attempt = 0; attempt < 100 && !service.plugins.requireService('hostConnector').online('host'); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    const expired = await request({ port, path: route, headers: { authorization: 'Bearer ' + oldToken, origin: panelOrigin } })
    assert.equal(expired.status, 401, '服务重启后面板令牌必须失效')
    const fresh = await request({ port, path: route + '/panel-token', method: 'POST', headers: { origin: panelOrigin }, body: { credential: minted.body.credential } })
    assert.equal(fresh.status, 200)
    assert((await request({ port, path: route, headers: { authorization: 'Bearer ' + fresh.body.token, origin: panelOrigin } })).status, 200)

    console.log('AgentPanel 入口、CORS、票据与令牌检查通过（测试 Host）')
  } finally {
    if (connector) await connector.close()
    if (service) await service.close()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(hostHome, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
