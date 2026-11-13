'use strict'
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http'), { spawn } = require('child_process')
const { BrowserDriver } = require('../src/main/agent/browser-driver')
const root = path.resolve(__dirname, '..')
const electron = path.join(root, 'node_modules/electron/dist/electron.exe')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const get = (url, headers) => new Promise((resolve, reject) => { const req = http.get(url, { headers: headers || {} }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers })) }); req.on('error', reject) })
async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) }) }
async function main() {
  const port = await freePort(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-service-button-'))
  const child = spawn(electron, [path.join(root, 'server/index.js')], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', PORT: String(port), AGENT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c)
  const driver = new BrowserDriver({})
  try {
    let ready = false
    for (let i = 0; i < 100; i++) { try { ready = (await get('http://127.0.0.1:' + port + '/api/health')).status === 200; if (ready) break } catch (_) {} await sleep(200) }
    assert(ready, 'desktop service not ready: ' + log)
    const desktop = process.env.AGENT_TEST_DESKTOP || electron
    await driver.launch('http://127.0.0.1:' + port + '/', { electronPath: desktop, width: 1100, height: 800, disableGpu: true })
    for (let i = 0; i < 100; i++) { if (await driver.evaluate('typeof openSettings === "function" && !!window.dsh && typeof window.dsh.serviceRequest === "function"')) break; await sleep(200) }
    await driver.evaluate('openSettings(); true')
    await sleep(2000)
    await driver.evaluate('document.getElementById("agentServiceToggle").click(); true')
    let state
    for (let i = 0; i < 100; i++) { state = await driver.evaluate('({text:document.getElementById("agentServiceState").textContent,address:document.getElementById("agentServiceAddress").textContent,button:document.getElementById("agentServiceToggle").textContent})'); if (state.button === '停止' || state.text.includes('：')) break; await sleep(200) }
    assert.strictEqual(state.button, '停止', JSON.stringify(state) + '\n' + log)
    const address = state.address.replace('服务地址：', '')
    assert(/^127\.0\.0\.1:\d+$/.test(address), address)
    const panel = await get('http://' + address + '/panel/1.0.21/manifest.json')
    assert.strictEqual(panel.status, 200)
    await driver.evaluate('document.getElementById("copyAgentServiceAddress").click(); true')
    let copyText = ''
    for (let i = 0; i < 20; i++) { copyText = await driver.evaluate('document.getElementById("copyAgentServiceAddress").textContent'); if (copyText === '已复制') break; await sleep(100) }
    assert.strictEqual(copyText, '已复制', 'copy button did not confirm success')
    /* 任何前端来源都应能跨源加载 AgentPanel（不再需要在设置里登记来源）。 */
    const origin = 'http://127.0.0.1:5173'
    const script = await get('http://' + address + '/panel/1.0.21/agent-panel.js', { origin })
    assert.strictEqual(script.status, 200, 'any origin must load the panel')
    assert.strictEqual(script.headers['access-control-allow-origin'], origin)
    await driver.evaluate('document.getElementById("agentServiceToggle").click(); true')
    for (let i = 0; i < 50; i++) { state = await driver.evaluate('({text:document.getElementById("agentServiceState").textContent,button:document.getElementById("agentServiceToggle").textContent,hidden:document.getElementById("agentServiceAddressRow").hidden})'); if (state.button === '启动') break; await sleep(200) }
    assert.strictEqual(state.button, '启动'); assert(state.hidden)
    console.log('PASS: Electron Node ' + process.versions.node + ', UI start → AgentPanel 1.0.21 HTTP 200 → 任意来源可跨域加载 → stop; ' + address)
  } finally { await driver.close().catch(() => {}); child.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
