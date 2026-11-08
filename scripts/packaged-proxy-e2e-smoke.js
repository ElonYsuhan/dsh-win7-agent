'use strict'
// 实际保护包服务 + Cordis + 隔离授权/工作区 + 本地模拟 HTTP 代理。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const assert = require('assert')
const { spawn } = require('child_process')
const bundle = path.resolve(process.argv[2] || 'release/.desktop-build/mac-arm64/delivery/Agent.app')
const executable = path.join(bundle, 'Contents/MacOS/Electron')
const app = path.join(bundle, 'Contents/Resources/app')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, label) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await wait(50) }
  throw new Error('Timeout: ' + label)
}
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)) }
function close(server) { return new Promise(resolve => server.close(resolve)) }
function call(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body)
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }) } catch (error) { reject(error) } })
    })
    req.on('error', reject); if (data) req.write(data); req.end()
  })
}
async function main() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-package-proxy-')))
  const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace)
  const requests = []
  const proxy = http.createServer((req, res) => {
    const record = { path: req.url, authorization: req.headers.authorization, body: '' }
    requests.push(record)
    req.setEncoding('utf8'); req.on('data', chunk => { record.body += chunk })
    req.on('end', () => {
      if (req.url === 'http://model.test/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'proxy-mock' }] }))
      } else if (req.url === 'http://model.test/v1/chat/completions') {
        const attempt = requests.filter(item => item.path === req.url).length
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const tool = { index: 0, id: attempt === 1 ? 'completed-write' : 'truncated-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'reconnect-check.txt', content: attempt === 1 ? 'completed once' : 'must never execute' }) } }
        if (attempt === 1) res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [tool] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n')
        else if (attempt === 2) res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '丢弃的半截回复', tool_calls: [tool] } }] }) + '\n\n')
        else res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '打包代理重连验证成功' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
      } else { res.writeHead(404); res.end() }
    })
  })
  let child, eventsRequest
  try {
    await listen(proxy)
    const probe = http.createServer(); await listen(probe); const port = probe.address().port; await close(probe)
    const env = Object.assign({}, process.env)
    for (const name of ['AGENT_HTTP_PROXY','AGENT_HTTPS_PROXY','AGENT_PROXY','HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy','MODEL_API_KEY','MODEL_BASE_URL','MODEL_NAME']) delete env[name]
    Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', AGENT_HOME: home, HOST: '127.0.0.1', PORT: String(port), AGENT_MODEL_PROXY: 'http://127.0.0.1:' + proxy.address().port })
    child = spawn(executable, [path.join(app, 'service/index.js')], { env, stdio: 'ignore' })
    await until(async () => {
      if (child.exitCode !== null) throw new Error('Packaged service exited')
      try { return (await call(port, 'GET', '/api/health')).status === 200 } catch (error) { return false }
    }, 'packaged service')
    const license = await call(port, 'POST', '/api/licensing/trial', {})
    assert.strictEqual(license.status, 200); assert.strictEqual(license.body.allowed, true)
    const configured = await call(port, 'POST', '/api/settings', {
      models: [{ id: 'mock', name: '模拟模型', baseURL: 'http://model.test/v1', apiKey: 'synthetic-key', model: 'proxy-mock', protocol: 'openai-completions', modelList: ['proxy-mock'] }],
      currentModelId: 'mock', workspacePath: workspace, projects: [], currentProjectId: ''
    })
    assert.strictEqual(configured.status, 200)
    const state = await call(port, 'GET', '/api/state')
    assert.strictEqual(state.body.runtime.engine, 'cordis')
    const catalog = await call(port, 'POST', '/api/models', { baseURL: 'http://model.test/v1', apiKey: 'synthetic-key' })
    assert.strictEqual(catalog.status, 200); assert.deepStrictEqual(catalog.body.models, ['proxy-mock'])
    const events = []
    await new Promise((resolve, reject) => {
      eventsRequest = http.get({ hostname: '127.0.0.1', port, path: '/api/events' }, response => {
        let buffer = ''; response.setEncoding('utf8'); response.on('data', chunk => {
          buffer += chunk; const chunks = buffer.split('\n\n'); buffer = chunks.pop()
          for (const item of chunks) for (const line of item.split('\n')) if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))) } catch (error) {} }
        }); resolve()
      }); eventsRequest.on('error', reject)
    })
    await until(() => events.some(event => event.type === 'status' && event.text === 'connected'), 'event stream')
    const started = await call(port, 'POST', '/api/chat', { sessionId: 'proxy-e2e', text: '隔离测试', history: [] })
    assert.strictEqual(started.status, 202)
    await until(() => events.some(event => event.type === 'finished' && event.sessionId === 'proxy-e2e') || events.some(event => event.type === 'error' && event.sessionId === 'proxy-e2e'), 'Cordis conversation')
    const failed = events.find(event => event.type === 'error' && event.sessionId === 'proxy-e2e')
    if (failed) throw new Error('Packaged conversation failed: ' + failed.message)
    const finished = events.find(event => event.type === 'finished' && event.sessionId === 'proxy-e2e')
    assert(JSON.stringify(finished.messages).includes('打包代理重连验证成功'))
    assert(!JSON.stringify(finished.messages).includes('丢弃的半截回复'))
    assert.strictEqual(finished.execution.status, 'completed')
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'reconnect-check.txt'), 'utf8'), 'completed once')
    assert.strictEqual(events.filter(event => event.sessionId === 'proxy-e2e' && event.type === 'tool:start' && event.name === 'write_file').length, 1)
    assert.strictEqual(events.filter(event => event.sessionId === 'proxy-e2e' && event.type === 'assistant:retry').length, 1)
    assert(requests.some(item => item.path === 'http://model.test/v1/models'))
    const chats = requests.filter(item => item.path === 'http://model.test/v1/chat/completions')
    assert.strictEqual(chats.length, 3)
    const resent = JSON.parse(chats[2].body).messages
    assert.strictEqual(resent.filter(message => message.role === 'tool' && message.tool_call_id === 'completed-write').length, 1)
    assert(!JSON.stringify(resent).includes('truncated-write'))
    assert(requests.every(item => item.authorization === 'Bearer synthetic-key'))
    console.log('PASS protected packaged service: Cordis, proxy, tool results and automatic reconnect without replay')
  } finally {
    if (eventsRequest) eventsRequest.destroy()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await wait(20)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await close(proxy)
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
