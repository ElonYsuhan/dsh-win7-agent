'use strict'

// Launch the compiled Mac application with isolated data and an obsolete service.
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const net = require('net')
const assert = require('assert')
const { spawn } = require('child_process')
const { MiniWebSocket, CdpSession, httpGetJson } = require('../src/main/agent/cdp-client')
const { uiBuild } = require('../src/main/agent/ui-build')
const ROOT = path.resolve(__dirname, '..')
const version = require('../package.json').version
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const s = net.createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  return port
}
async function run() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-package-ui-')))
  const bundle = path.resolve(process.argv[2] || path.join(ROOT, 'release/desktop/Agent-mac-arm64-' + version + '/Agent.app'))
  const debug = await freePort()
  const stale = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, app: 'dsh-agent-service', version: '0.1.0', pid: process.pid }))
  })
  await new Promise((resolve) => stale.listen(0, '127.0.0.1', resolve))
  const stalePort = stale.address().port
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'local', lastPort: stalePort, theme: 'dark' }))
  const log = fs.openSync(path.join(dir, 'app.log'), 'w')
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const flags = process.env.SMOKE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []
  const child = spawn(path.join(bundle, 'Contents/MacOS/Electron'), flags.concat(['--user-data-dir=' + dir, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debug]), { env, stdio: ['ignore', log, log] })
  let ws
  try {
    let target
    for (let i = 0; i < 120; i += 1) {
      try { target = (await httpGetJson('127.0.0.1', debug, '/json/list', 1000)).find((t) => t.type === 'page' && /^http:/.test(t.url)) } catch (error) {}
      if (target) break
      if (child.exitCode !== null) throw new Error('Package exited: ' + fs.readFileSync(path.join(dir, 'app.log'), 'utf8').slice(-2000))
      await delay(250)
    }
    assert(target, 'compiled app must reach service renderer')
    const url = new URL(target.url)
    assert.notStrictEqual(Number(url.port), stalePort, 'must skip obsolete service')
    const health = await httpGetJson('127.0.0.1', Number(url.port), '/api/health')
    assert.strictEqual(health.version, version)
    assert.strictEqual(health.uiBuild, uiBuild(path.join(bundle, 'Contents/Resources/app/src/renderer')))
    assert.strictEqual(health.agentHome, path.join(dir, 'agent-home'))
    ws = new MiniWebSocket()
    const socket = new URL(target.webSocketDebuggerUrl)
    await ws.connect(socket.hostname, Number(socket.port), socket.pathname)
    const cdp = new CdpSession(ws)
    async function evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    await delay(1500)
    const results = []
    for (const theme of ['dark', 'light']) {
      await evaluate('document.documentElement.setAttribute("data-theme",' + JSON.stringify(theme) + ')')
      await delay(200)
      const style = await evaluate(`(() => { const t=document.querySelector('#titlebarDrag'), b=document.querySelector('#newSession'); return { theme:document.documentElement.dataset.theme, bg:getComputedStyle(document.body).backgroundColor, button:getComputedStyle(b).backgroundColor, gradient:getComputedStyle(b).backgroundImage, titlebarHeight:t.getBoundingClientRect().height, independent:t.parentElement===document.body }; })()`)
      assert.strictEqual(style.bg, theme === 'dark' ? 'rgb(33, 33, 33)' : 'rgb(255, 255, 255)')
      assert.strictEqual(style.gradient, 'none')
      assert.strictEqual(style.titlebarHeight, 48)
      assert(style.independent)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(path.join(ROOT, 'release/validation'), { recursive: true })
      fs.writeFileSync(path.join(ROOT, 'release/validation/packaged-' + theme + '.png'), Buffer.from(shot.data, 'base64'))
      results.push(style)
    }
    fs.writeFileSync(path.join(ROOT, 'release/validation/packaged-ui.json'), JSON.stringify({ version, skippedObsoleteService: true, results }, null, 2))
    console.log('PASS compiled Mac app: isolated data, obsolete service skipped, current build, independent titlebar, flat dark/white themes')
  } finally {
    if (ws && ws.socket) ws.socket.destroy()
    child.kill('SIGTERM')
    await delay(1000)
    stale.close()
    fs.closeSync(log)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
