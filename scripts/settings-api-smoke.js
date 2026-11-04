#!/usr/bin/env node
'use strict'
/* POST /api/settings 的行为与开销回归。
   2026-11-04：侧边栏点项目展开会走 saveSettings，实测一次 237ms —— 服务端无论改什么都
   await pluginHost.configure() 并 settle 整棵 fiber 树。改成只在插件字段变化时重配之后，
   这里守住三件事：普通保存不再付这笔钱、插件启停仍然生效、工作区/MCP 仍然切换。 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

let failed = 0
function ok(name, pass, extra) {
  if (!pass) failed += 1
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']'))
}

function request(port, method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8')
    const started = process.hrtime.bigint()
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Number(process.hrtime.bigint() - started) / 1e6 }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function main() {
  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-api-'))
  const otherWs = path.join(home, 'other-workspace')
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port), AGENT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  const get = async (urlPath) => JSON.parse((await request(port, 'GET', urlPath)).body)
  try {
    let up = false
    for (let i = 0; i < 80; i += 1) {
      try { const r = await request(port, 'GET', '/api/health'); if (r.status === 200) { up = true; break } } catch (error) { /* 还没起来 */ }
      await sleep(250)
    }
    if (!up) throw new Error('server 没起来：' + logs.slice(-400))

    const state0 = await get('/api/state')
    const counts = {}
    for (const tool of state0.tools) if (state0.plugins.includes(tool.plugin)) counts[tool.plugin] = (counts[tool.plugin] || 0) + 1
    const target = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]
    ok('有可停用的非核心插件用于本测', Boolean(target), String(target))

    /* 普通字段：不该再触发插件重配。10 次总耗时 800ms 是宽松上限（旧实现单次就 ~200ms）。 */
    const plain = []
    for (let i = 0; i < 10; i += 1) {
      const r = await request(port, 'POST', '/api/settings', { theme: i % 2 ? 'dark' : 'light' })
      plain.push(Math.round(r.ms))
    }
    const total = plain.reduce((a, b) => a + b, 0)
    ok('普通设置保存不再重配插件（10 次总耗时 < 800ms）', total < 800, plain.join(','))
    const state1 = await get('/api/state')
    const rec1 = (state1.runtime.plugins || []).find((item) => item.name === target)
    ok('普通保存不影响已启用插件的状态', Boolean(rec1) && rec1.state !== 'disabled', rec1 && rec1.state)

    /* 插件字段：仍然真的启停 */
    await request(port, 'POST', '/api/settings', { disabledPlugins: [target] })
    await sleep(400)
    const state2 = await get('/api/state')
    const rec2 = (state2.runtime.plugins || []).find((item) => item.name === target)
    ok('disabledPlugins 仍能停用插件', Boolean(rec2) && rec2.state === 'disabled', rec2 && rec2.state)

    await request(port, 'POST', '/api/settings', { disabledPlugins: [] })
    await sleep(600)
    const state3 = await get('/api/state')
    const rec3 = (state3.runtime.plugins || []).find((item) => item.name === target)
    ok('清空 disabledPlugins 后插件恢复启用', Boolean(rec3) && rec3.state !== 'disabled', rec3 && rec3.state)

    /* 工作区：pool 与磁盘都要跟上 */
    await request(port, 'POST', '/api/settings', { workspacePath: otherWs })
    await sleep(300)
    const state4 = await get('/api/state')
    ok('改 workspacePath 仍会切换 pool 工作区', path.resolve(state4.workspacePath) === path.resolve(otherWs), state4.workspacePath)
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))
    ok('workspacePath 已落盘', path.resolve(saved.workspacePath) === path.resolve(otherWs), saved.workspacePath)

    /* MCP：内置文档服务停用仍要重载 */
    await request(port, 'POST', '/api/settings', { disabledBuiltinMcp: ['documents'] })
    await sleep(600)
    const state5 = await get('/api/state')
    const documents = (state5.mcp.servers || []).find((item) => item.id === 'documents')
    ok('disabledBuiltinMcp 仍会重载 MCP', Boolean(documents) && documents.enabled === false, documents && documents.enabled)
  } finally {
    try { child.kill() } catch (error) { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }) } catch (error) { /* ignore */ }
  }
  console.log('')
  console.log(failed ? 'settings api smoke: ' + failed + ' failed' : 'settings api smoke: all passed, node ' + process.version)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
