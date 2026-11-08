'use strict'

// Build-machine regression for the real chat renderer. A separate loopback
// proxy serves temporary compiled UI buffers; the real Agent service gets a
// disposable home/workspace. No user application or installer is touched.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { compileBrowserBundles, notices, assertNoDynamicExecution } = require('./build-generative-ui')
const root = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }) }
function close(server) { return new Promise(resolve => server.close(resolve)) }
function post(port, route, value) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(value))
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject); request.end(body)
  })
}
function delta(value, reason) { return 'data: ' + JSON.stringify({ choices: [{ delta: value, finish_reason: reason || null }] }) + '\n\n' }
function health(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)) })
    req.on('error', () => resolve(false)); req.setTimeout(1000, () => req.destroy())
  })
}
async function main() {
  const captures = process.argv[2] ? path.resolve(process.argv[2]) : ''
  assert(process.argv.length <= 3, 'usage: node scripts/generative-ui-chat-browser-smoke.js [empty-screenshot-directory]')
  if (captures) assert(fs.statSync(captures).isDirectory() && fs.readdirSync(captures).length === 0, 'screenshot directory must be empty')
  const bundles = await compileBrowserBundles()
  notices(bundles.used)
  const protect = require('./desktop/source-protection')
  bundles.app.js = Buffer.from(await protect.transform(bundles.app.js.toString('utf8'), 'browser', false))
  assertNoDynamicExecution(bundles.app.js, 'protected-agent-generative-ui.js')
  const adapter = Buffer.from(await protect.transform(fs.readFileSync(path.join(root, 'src/renderer/generative-ui-chat.js'), 'utf8'), 'browser', false))
  assertNoDynamicExecution(adapter, 'protected-generative-ui-chat.js')
  const resources = new Map([
    ['/vendor/generative-ui/agent-ui-vendor.js', ['text/javascript', bundles.vendor.js]],
    ['/vendor/generative-ui/agent-ui-cesium.js', ['text/javascript', bundles.cesium.js]],
    ['/generative-ui/agent-generative-ui.js', ['text/javascript', bundles.app.js]],
    ['/generative-ui/agent-generative-ui.css', ['text/css', bundles.app.css]],
    ['/generative-ui-chat.js', ['text/javascript', adapter]]
  ])
  for (const asset of bundles.assets || []) resources.set('/vendor/generative-ui/' + asset.path, ['application/json', asset.data])
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gui-chat-'))
  const home = path.join(temporary, 'home'), workspace = path.join(temporary, 'workspace')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(home, 'generative-ui-test-only'), 'isolated test\n')
  const requests = []
  let pendingModelResponse = null
  function testSurface(revision) {
    const business = JSON.parse(fs.readFileSync(path.join(root, 'examples/generative-ui/business.surface.json'), 'utf8'))
    return { version: 2, id: 'actual', revision, title: revision === 1 ? '真实工具图表' : '回传后的图表', root: 'layout', state: { ...business.state, factor: revision === 1 ? 1 : 2, note: '初始', archived: false }, components: [
      { id: 'layout', type: 'column', children: ['chart', 'slider', 'form', 'region', 'records', 'progress', 'sketch', 'process', 'places', 'analyze'] },
      { id: 'chart', type: 'chart', chartType: 'line', title: '收入', labels: ['一月', '二月'], series: [{ id: 'income', name: '收入', values: [2, 4] }], multiplierKey: 'factor' },
      { id: 'slider', type: 'slider', label: '真实工具倍数', stateKey: 'factor', min: 0, max: 5, step: 0.5 },
      { id: 'form', type: 'form', label: '分析条件', children: ['note', 'archived'] },
      { id: 'note', type: 'input', label: '备注', stateKey: 'note', maxLength: 20 },
      { id: 'archived', type: 'checkbox', label: '包含归档', stateKey: 'archived' },
      ...business.components.filter(component => !['layout', 'send'].includes(component.id)),
      { id: 'analyze', type: 'button', label: '分析当前参数', actionId: 'analyze' }
    ], actions: [{ id: 'analyze', type: 'ask_agent', message: '根据当前参数更新图表', stateKeys: ['factor', 'note', 'region', 'row', 'node', 'point'] }] }
  }
  const model = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(raw))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (requests.length === 1) {
        const surface = testSurface(1)
        const call = { index: 0, id: 'real-ui-tool', type: 'function', function: { name: 'render_ui', arguments: JSON.stringify({ operation: 'create', expectedRevision: 0, surface }) } }
        response.end(delta({ tool_calls: [call] }, 'tool_calls') + 'data: [DONE]\n\n')
      } else if (requests.length === 3) {
        const call = { index: 0, id: 'real-update-tool', type: 'function', function: { name: 'update_ui', arguments: JSON.stringify({ expectedRevision: 1, surface: testSurface(2) }) } }
        response.end(delta({ tool_calls: [call] }, 'tool_calls') + 'data: [DONE]\n\n')
      } else if ([2, 4, 5].includes(requests.length)) {
        pendingModelResponse = response
        response.write(': waiting for test\n\n')
      } else response.end(delta({ content: 'unexpected request' }, 'stop') + 'data: [DONE]\n\n')
    })
  })
  await listen(model)
  const probe = http.createServer(); await listen(probe); const servicePort = probe.address().port; await close(probe)
  const service = spawn(process.execPath, [path.join(root, 'scripts/test-support/generative-ui-server.js'), home], {
    cwd: root, env: { ...process.env, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', HOST: '127.0.0.1', PORT: String(servicePort), PORT_MAX_ATTEMPTS: '1', AGENT_HOME: home, WORKSPACE_PATH: workspace }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let logs = ''
  service.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000) })
  service.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000) })
  const sockets = new Set()
  const proxy = http.createServer((request, response) => {
    const parsed = new URL(request.url, 'http://127.0.0.1')
    if (parsed.pathname === '/__test/model' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ count: requests.length, pending: Boolean(pendingModelResponse), prompts: requests.map(item => item.messages.filter(message => message.role === 'user').pop().content), internalUi: requests.some(item => JSON.stringify(item).includes('\"type\":\"ui\"')) })); return
    }
    if (parsed.pathname === '/__test/committed' && request.method === 'GET') {
      const session = parsed.searchParams.get('session') || ''
      const snapshot = /^session_[a-z0-9]+$/.test(session) ? path.join(home, 'sessions', session, 'last-session.json') : ''
      let committed = false
      try {
        const saved = JSON.parse(fs.readFileSync(snapshot, 'utf8'))
        committed = saved.messages.some(message => Array.isArray(message.content) && message.content.some(part => part && part.type === 'ui' && part.surface.id === 'actual'))
      } catch (_) {}
      response.writeHead(committed && pendingModelResponse ? 200 : 409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ committed, pending: !!pendingModelResponse })); return
    }
    if (parsed.pathname === '/__test/release' && request.method === 'POST') {
      if (!pendingModelResponse || ![2, 4].includes(requests.length) || JSON.stringify(requests[requests.length - 1]).includes('\"type\":\"ui\"')) { response.writeHead(409); response.end(); return }
      pendingModelResponse.end(delta({ content: '工具结果已记录。' }, 'stop') + 'data: [DONE]\n\n')
      pendingModelResponse = null
      response.writeHead(200); response.end(); return
    }
    const resource = resources.get(request.url)
    if (resource && request.method === 'GET') {
      response.writeHead(200, { 'content-type': resource[0] + '; charset=utf-8', 'cache-control': 'no-store' })
      response.end(resource[1]); return
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: servicePort, method: request.method, path: request.url, headers: request.headers }, reply => {
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  try {
    let ready = false
    for (let i = 0; i < 100; i += 1) { if (await health(servicePort)) { ready = true; break }; await pause(100) }
    assert(ready, 'isolated Agent service failed to start: ' + logs)
    assert.strictEqual(await post(servicePort, '/api/settings', { workspacePath: workspace, permissionMode: 'workspace', contextAutoCompress: false,
      models: [{ id: 'test-model', name: '隔离模型', baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', model: 'synthetic', apiKey: 'test-only' }], currentModelId: 'test-model' }), 200)
    await listen(proxy)
    const url = 'http://127.0.0.1:' + proxy.address().port + '/'
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((resolve, reject) => {
      const childArgs = [path.join(root, 'scripts/test-support/generative-ui-chat-electron.js'), url]
      if (captures) childArgs.push(captures)
      const child = spawn(require('electron'), childArgs, { env, stdio: 'inherit' })
      const timer = setTimeout(() => { child.kill(); reject(new Error('GENERATIVE_UI_CHAT_ELECTRON_TIMEOUT')) }, 120000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', (status, signal) => { clearTimeout(timer); resolve(status === null ? 'signal ' + signal : status) })
    })
    assert.strictEqual(code, 0, 'isolated real-chat regression failed')
  } finally {
    for (const socket of sockets) socket.destroy()
    if (proxy.listening) await close(proxy)
    if (pendingModelResponse && !pendingModelResponse.writableEnded) pendingModelResponse.destroy()
    await close(model)
    if (service.exitCode === null && service.signalCode === null) {
      service.kill('SIGTERM')
      for (let i = 0; i < 50 && service.exitCode === null && service.signalCode === null; i += 1) await pause(50)
      if (service.exitCode === null && service.signalCode === null) service.kill('SIGKILL')
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
