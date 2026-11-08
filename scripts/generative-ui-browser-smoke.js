'use strict'

// Development-only browser regression. It serves in-memory Vite outputs solely
// to a temporary sandboxed Electron window on loopback. It does not write a
// release bundle, waive license checks, use the real app, or touch user data.
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { compileBrowserBundles, notices, assertNoDynamicExecution } = require('./build-generative-ui')
const root = path.resolve(__dirname, '..')
const fixture = fs.readFileSync(path.join(root, 'scripts/test-support/generative-ui-browser-fixture.js'))
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'self' blob:; frame-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'"><title>UI Regression</title><link rel="stylesheet" href="/fixture.css"><link rel="stylesheet" href="/agent-generative-ui.css"></head><body><main id="stage"></main><script src="/fixture.js"></script><script src="/agent-ui-vendor.js"></script><script src="/agent-generative-ui.js"></script></body></html>`
const css = `:root{--text:#252525;--muted:#666;--border:#d5d5d5;--focus:#2a78d6;--panel:#fff;background:#f5f5f5;color:var(--text);font-family:system-ui,sans-serif} :root[data-theme="dark"]{--text:#eee;--muted:#aaa;--border:#555;--focus:#84baff;--panel:#2b2b2b;background:#1d1d1d}body{margin:0;padding:24px}#stage{max-width:850px;margin:auto}.test-host{width:100%}`

async function main() {
  const args = process.argv.slice(2)
  const protectedMode = args.includes('--protected')
  const positional = args.filter(item => item !== '--protected')
  assert(positional.length <= 1 && positional.every(item => !item.startsWith('--')), 'usage: node scripts/generative-ui-browser-smoke.js [--protected] [empty-screenshot-directory]')
  const captures = positional[0] || ''
  if (captures) {
    const directory = path.resolve(captures)
    assert(fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length === 0, 'screenshot directory must already exist and be empty')
  }
  console.log('Compiling development-only browser buffers; release license checks remain mandatory.')
  const bundles = await compileBrowserBundles()
  if (protectedMode) {
    assert.strictEqual(require('terser/package.json').version, '5.31.0')
    assert.strictEqual(require('javascript-obfuscator/package.json').version, '4.1.1')
    const protect = require('./desktop/source-protection')
    bundles.app.js = Buffer.from(await protect.transform(bundles.app.js.toString('utf8'), 'browser', false))
    assertNoDynamicExecution(bundles.app.js, 'protected-agent-generative-ui.js')
    console.log('Testing the app-owned UI bundle after agent-source-v1 browser protection; vendor is not modified.')
  }
  try {
    notices(bundles.used)
    console.log('License check for rendered build modules: passed.')
  } catch (error) {
    if (!String(error.message).startsWith('GENERATIVE_UI_LICENSE_MISSING:')) throw error
    console.log('Release still blocked by license check: ' + error.message)
  }
  const files = new Map([
    ['/', ['text/html', Buffer.from(html)]],
    ['/fixture.css', ['text/css', Buffer.from(css)]],
    ['/fixture.js', ['application/javascript', fixture]],
    ['/business-surface.json', ['application/json', fs.readFileSync(path.join(root, 'examples/generative-ui/business.surface.json'))]],
    ['/vendor/generative-ui/agent-ui-cesium.js', ['application/javascript', bundles.cesium.js]],
    ['/agent-ui-vendor.js', ['application/javascript', bundles.vendor.js]],
    ['/agent-generative-ui.js', ['application/javascript', bundles.app.js]],
    ['/agent-generative-ui.css', ['text/css', bundles.app.css]]
  ])
  for (const asset of bundles.assets || []) files.set('/vendor/generative-ui/' + asset.path, ['application/json', asset.data])
  const missing = []
  const server = http.createServer((request, response) => {
    const item = files.get(request.url)
    if (!item || request.method !== 'GET') { missing.push(request.url); response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': item[0] + '; charset=utf-8', 'cache-control': 'no-store' })
    response.end(item[1])
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = 'http://127.0.0.1:' + server.address().port + '/'
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const childArgs = [path.join(root, 'scripts/test-support/generative-ui-electron-smoke.js'), url]
  if (captures) childArgs.push(path.resolve(captures))
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), childArgs, { env, stdio: 'inherit' })
      const timer = setTimeout(() => { child.kill(); reject(new Error('GENERATIVE_UI_ELECTRON_TIMEOUT')) }, 90000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', (status, signal) => { clearTimeout(timer); resolve(status === null ? 'signal ' + signal : status) })
    })
    assert.strictEqual(code, 0, 'isolated Electron browser regression failed')
    assert.deepStrictEqual(missing, [], 'offline resources must be complete: ' + JSON.stringify(missing))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
