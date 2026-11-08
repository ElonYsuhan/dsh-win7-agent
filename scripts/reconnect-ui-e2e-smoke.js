'use strict'
// Real Chromium + Agent service + Cordis + isolated model/workspace, no external requests.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { BrowserDriver } = require('../src/main/agent/browser-driver')
const ROOT = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(test, label) {
  for (let i = 0; i < 200; i++) { if (await test()) return; await pause(50) }
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
function delta(value, reason) { return 'data: ' + JSON.stringify({ choices: [{ delta: value, finish_reason: reason || null }] }) + '\n\n' }
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reconnect-ui-'))
  const home = path.join(temp, 'home'), workspace = path.join(temp, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const requests = []
  let pendingResponse = null
  const model = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(raw))
      const n = requests.length
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const tool = { index: 0, id: n === 1 ? 'saved-file' : 'abandoned-file', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'reconnect-ui.txt', content: n === 1 ? '仅写入一次' : '不应执行' }) } }
      if (n === 1) response.end(delta({ tool_calls: [tool] }, 'tool_calls') + 'data: [DONE]\n\n')
      else if (n === 2) response.end(delta({ content: '失败尝试的半截正文', tool_calls: [tool] }))
      else if (n === 3) pendingResponse = response
      else response.end(delta({ content: 'unexpected retry' }, 'stop') + 'data: [DONE]\n\n')
    })
  })
  const driver = new BrowserDriver()
  let child, port
  let logs = ''
  try {
    await listen(model)
    const probe = http.createServer(); await listen(probe); port = probe.address().port; await close(probe)
    child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
      cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PORT_MAX_ATTEMPTS: '1', AGENT_HOME: home, WORKSPACE_PATH: workspace }, stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', chunk => { logs += chunk })
    child.stderr.on('data', chunk => { logs += chunk })
    await wait(async () => { try { return (await call(port, 'GET', '/api/health')).status === 200 } catch (error) { return false } }, 'isolated service')
    const configured = await call(port, 'POST', '/api/settings', {
      workspacePath: workspace, permissionMode: 'workspace', contextAutoCompress: false,
      models: [{ id: 'mock', name: '本地模拟', baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', model: 'mock', apiKey: 'synthetic-key' }], currentModelId: 'mock'
    })
    assert.strictEqual(configured.status, 200)
    const electron = path.join(ROOT, 'node_modules/electron/dist', fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim())
    await driver.launch('http://127.0.0.1:' + port + '/', { electronPath: electron, width: 1200, height: 820, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    await wait(() => driver.evaluate('typeof state!=="undefined" && state.settings && window.agentUI && document.getElementById("serviceConnection").textContent==="服务已连接"'), 'real UI')
    const id = await driver.evaluate(`(async()=>{
      const s=createSession('', '自动重连验收', 'recent');
      await selectSession(s.id); await syncRunningState();
      window.__reconnectEvents=[]; window.dsh.onEvent(event=>window.__reconnectEvents.push(event));
      setInputContent('测试从已完成的步骤继续'); sendMessage().then(()=>{window.__reconnectDone=true});
      return s.id
    })()`, { awaitPromise: true })
    await wait(() => pendingResponse !== null, 'reconnected request')
    const during = await driver.evaluate(`({
      running: currentRunning(), stop: !document.getElementById('stop').classList.contains('hidden'),
      status: document.getElementById('statusLine').textContent,
      steps: document.querySelector('.process-timeline') && document.querySelector('.process-timeline').textContent,
      activeTitle: document.querySelector('.tl-step.tl-running .tl-title') && document.querySelector('.tl-step.tl-running .tl-title').textContent,
      draftCount: document.querySelectorAll('.bubble.assistant').length,
      retries: window.__reconnectEvents.filter(e=>e.type==='assistant:retry').length
    })`)
    assert(during.running && during.stop)
    assert(during.status.includes('正在重新连接模型服务'), during.status)
    assert(during.steps.includes('reconnect-ui.txt') && during.steps.includes('自动重连'), during.steps)
    assert(during.activeTitle.includes('自动重连模型'), during.activeTitle)
    assert.strictEqual(during.draftCount, 0, 'discard the incomplete assistant draft')
    assert.strictEqual(during.retries, 1)
    const screenshotDir = process.env.AGENT_RECONNECT_SCREENSHOT_DIR
    if (screenshotDir) {
      const screenshot = path.join(screenshotDir, 'reconnecting.png')
      fs.writeFileSync(screenshot, Buffer.from(await driver.screenshot(), 'base64'), { flag: 'wx' })
      await driver.evaluate('applyTheme("light"); true')
      const light = path.join(screenshotDir, 'reconnecting-light.png')
      fs.writeFileSync(light, Buffer.from(await driver.screenshot(), 'base64'), { flag: 'wx' })
      await driver.evaluate('applyTheme("dark"); true')
      console.log('Screenshots: ' + screenshot + ', ' + light)
    }
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'reconnect-ui.txt'), 'utf8'), '仅写入一次')
    pendingResponse.end(delta({ content: '已从已完成的步骤继续。' }, 'stop') + 'data: [DONE]\n\n')
    await wait(() => driver.evaluate('window.__reconnectDone===true'), 'completed conversation')
    const after = await driver.evaluate(`({
      running:currentRunning(),
      response:Array.from(document.querySelectorAll('.bubble.assistant')).map(e=>e.textContent).join('|'),
      starts:window.__reconnectEvents.filter(e=>e.type==='tool:start'&&e.name==='write_file').length,
      retryCompleted:!!document.querySelector('.tl-step[data-model-retry="true"].tl-ok'),
      finished:window.__reconnectEvents.find(e=>e.type==='finished')
    })`)
    assert(!after.running)
    assert(after.response.includes('已从已完成的步骤继续。') && !after.response.includes('失败尝试的半截正文'))
    assert.strictEqual(after.starts, 1)
    assert(after.retryCompleted, 'the reconnect step must be marked complete')
    assert.strictEqual(after.finished.execution.status, 'completed')
    assert.strictEqual(requests.length, 3)
    assert.strictEqual(requests[2].messages.filter(m => m.role === 'tool' && m.tool_call_id === 'saved-file').length, 1)
    assert(!JSON.stringify(requests[2].messages).includes('abandoned-file'))
    console.log('PASS real Chromium: reconnect notice, preserved tool step, isolated partial text and resumed answer')
  } catch (error) {
    console.error(logs.slice(-2500))
    throw error
  } finally {
    if (pendingResponse && !pendingResponse.writableEnded) pendingResponse.destroy()
    await driver.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await wait(() => child.exitCode !== null || child.signalCode !== null, 'isolated service shutdown').catch(() => child.kill('SIGKILL'))
    }
    await close(model)
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
