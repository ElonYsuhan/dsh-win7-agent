'use strict'

// 真实 Chromium（Electron 22.3.27 / Chromium 108）验证 AgentPanel：
// 跨源加载、挂载、发送、流式回复、工具与审批、卸载/重新挂载、页面刷新、
// Service 重启后重新注入票据、销毁，以及宿主 Origin 下的 IndexedDB 恢复。
// 同时用自签名证书验证 HTTPS 入口；自签名仅用于本机测试，不代表生产证书。
// 使用测试 Host 与确定性模型替身，不是 HESYN 或授权模型验收。

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { spawnSync } = require('child_process')
const { createService } = require('../service')
const { HostConnector } = require('../src/main/host-connector/client')
const { BrowserDriver } = require('../src/main/agent/browser-driver')
const { hash } = require('../src/main/service/repository')
const VERSION = require('../src/panel/manifest.json').version

const ROOT = path.resolve(__dirname, '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, label, attempts) {
  for (let index = 0; index < (attempts || 200); index++) {
    try { const value = await check(); if (value) return value } catch (_) {}
    await sleep(100)
  }
  throw Error('Timeout: ' + label)
}
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))) }
function close(server) { return new Promise(resolve => server.close(resolve)) }
function electronBinary() {
  const configured = process.env.AGENT_NODE16_EXECUTABLE || process.env.AGENT_ELECTRON
  if (configured && fs.existsSync(configured)) return configured
  for (const base of [path.join(ROOT, 'node_modules/electron'), path.resolve(ROOT, '../../../node_modules/electron')]) {
    const info = path.join(base, 'path.txt')
    if (fs.existsSync(info)) return path.join(base, 'dist', fs.readFileSync(info, 'utf8').trim())
  }
  throw Error('未找到 Electron 22 运行时；请设置 AGENT_NODE16_EXECUTABLE 或准备 node_modules。')
}
async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await close(server)
  return port
}

function hostPage(serviceOrigin, panelVersion) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' ${serviceOrigin}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${serviceOrigin}">
<title>Host 工作台</title></head><body>
<div id="host"></div>
<script type="module" src="/host.js"></script></body></html>`
}

function hostScript(serviceOrigin, panelVersion) {
  const base = serviceOrigin + '/panel/' + panelVersion
  return `import AgentPanel from ${JSON.stringify(base + '/agent-panel.js')}
import { createHostStorage } from ${JSON.stringify(base + '/host-storage.js')}
const state = { panel: null, sessionId: localStorage.getItem('panel-session') || '', attached: 0, detached: 0, events: [] }
const storage = createHostStorage({ databaseName: 'agent-panel-e2e' })
async function ticket(request) {
  // 组件内置历史/新建会传入目标会话；未传时沿用当前会话（空字符串表示新建）。
  const requested = request && typeof request.sessionId === 'string' ? request.sessionId : state.sessionId
  const response = await fetch('/ticket?sessionId=' + encodeURIComponent(requested)) // win7-exempt: 模板将注入 Chromium 页面执行，非 Node 侧代码
  if (!response.ok) throw new Error('ticket failed: ' + response.status)
  const value = await response.json()
  state.sessionId = value.sessionId
  localStorage.setItem('panel-session', value.sessionId)
  return { sessionId: value.sessionId, credential: value.credential }
}
const options = {
  endpoint: ${JSON.stringify(serviceOrigin)},
  sessionId: state.sessionId || undefined,
  auth: { ticket },
  storage,
  theme: 'dark',
  hostConnector: { attach() { state.attached += 1 }, detach() { state.detached += 1 } },
  onNewSession() { state.newSession = (state.newSession || 0) + 1 },
  onHistory() { state.history = (state.history || 0) + 1 },
  onEvent(event) { state.events.push(event.type) }
}
window.__panelState = state
window.__options = options
window.__mount = async () => {
  if (state.panel) return true
  state.panel = await AgentPanel.mount(document.getElementById('host'), options)
  window.__panel = state.panel
  return true
}
window.__unmount = () => { if (state.panel) { AgentPanel.unmount(state.panel); state.panel = null } }
window.__destroy = () => { if (state.panel) { state.panel.destroy(); state.panel = null } }
window.__ready = () => Boolean(window.__panel && window.__panel.connected && window.__panel.shadowRoot)`
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-panel-browser-'))
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-panel-browser-host-'))
  const userToken = 'u'.repeat(32), hostToken = 'h'.repeat(32)
  const modelBodies = []
  const model = http.createServer((req, res) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      modelBodies.push(JSON.parse(data))
      const hasTool = modelBodies[modelBodies.length - 1].messages.some(message => message.role === 'tool')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!hasTool) {
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'host__host__lookup', arguments: '{}' } }] } }] }) + '\n\ndata: [DONE]\n\n')
        return
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '测试 ' } }] }) + '\n\n')
      setTimeout(() => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Host 已返回结果。' } }] }) + '\n\ndata: [DONE]\n\n'); res.end() }, 1500)
    })
  })
  const modelPort = await listen(model)

  let service, connector, hostServer, browser, standaloneBrowser, secureBrowser, tlsHostServer, service2
  let secureHome
  try {
    const servicePort = await freePort()
    const serviceOrigin = 'http://127.0.0.1:' + servicePort
    hostServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/ticket') {
        const sessionId = url.searchParams.get('sessionId') || ''
        try {
          let result
          if (sessionId) {
            result = await postJson(serviceOrigin + '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/tickets', userToken, {})
          } else {
            result = await postJson(serviceOrigin + '/api/v1/sessions', userToken, { hostId: 'host', requestId: 'browser_panel_' + Date.now() })
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ sessionId: result.sessionId || sessionId, credential: result.credential || result.launchCredential }))
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
        }
        return
      }
      if (url.pathname === '/host.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(hostScript(serviceOrigin, VERSION))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(hostPage(serviceOrigin, VERSION))
    })
    const hostPort = await freePort()
    await new Promise(resolve => hostServer.listen(hostPort, '127.0.0.1', resolve))

    const config = {
      publicOrigin: serviceOrigin,
      host: '127.0.0.1',
      port: servicePort,
      panelOrigins: ['http://127.0.0.1:' + hostPort],
      allowPanelSettings: true,
      users: [{ id: 'user', tokenHash: hash(userToken), hosts: ['host'] }],
      hosts: [{ id: 'host', tokenHash: hash(hostToken), users: ['user'], tools: { lookup: 'write' } }]
    }
    service = await createService({ home, config })
    // The embedded Service must work even when the desktop knowledge DB is unwritable.
    service.plugins.get('knowledge').sessionContext = async () => { throw new Error('KNOWLEDGE_DB: attempt to write a readonly database') }
    service.plugins.options.settings.update({ baseURL: 'http://127.0.0.1:' + modelPort + '/v1', apiKey: 'test', model: 'test-model', maxIterations: 5 })

    connector = new HostConnector({ url: serviceOrigin, token: hostToken, home: hostHome, allowLoopbackHttp: true, getContext: async () => ({ page: '测试页面' }), tools: [{ name: 'lookup', permission: 'write', parameters: { type: 'object', properties: {} }, execute: async () => '测试工具结果' }] })
    await connector.start()

    const binary = electronBinary()
    browser = new BrowserDriver()
    await browser.launch('http://127.0.0.1:' + hostPort + '/', { electronPath: binary, width: 1200, height: 900, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    try { await wait(() => browser.evaluate('typeof window.__mount === "function"'), 'host module loaded') }
    catch (error) { console.error('console:', browser.consoleErrors, 'network:', browser.networkErrors, 'url:', await browser.url()); throw error }
    await browser.evaluate('window.__mount()', { awaitPromise: true })
    await wait(() => browser.evaluate('window.__panel && window.__panel.connected && !window.__panel.running'), 'panel connected')
    assert.equal(await browser.evaluate('document.querySelector("agent-panel") !== null'), true)
    assert.equal(await browser.evaluate('document.querySelector("agent-panel").shadowRoot.querySelector(".panel-empty").textContent.includes("还没有消息")'), true)
    assert.equal(await browser.evaluate('window.__panelState.attached >= 1'), true, 'Host Connector attach hook must run')

    // 顶部两行已移除；左上角“历史会话/新建会话”图标按钮交给宿主处理。
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-header, .panel-notice').length === 0`), true, 'header and notice rows must be removed')
    assert.equal(await browser.evaluate(`Boolean(window.__panel.shadowRoot.querySelector('.panel-history svg') && window.__panel.shadowRoot.querySelector('.panel-new svg'))`), true, 'history and new-session icon buttons must exist')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-history').click(); true`)
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-new').click(); true`)
    assert.equal(await browser.evaluate(`window.__panelState.history === 1 && window.__panelState.newSession === 1`), true, 'host action callbacks must run')
    assert.equal(await browser.evaluate(`window.__panelState.events.indexOf('history') !== -1 && window.__panelState.events.indexOf('new-session') !== -1`), true, 'action events must be emitted')

    // 模型设置：下拉显示服务端当前模型，设置弹窗可打开并取消。
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-model-label').textContent === '默认模型'`), 'model label')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-model-trigger').click(); true`)
    await wait(() => browser.evaluate(`!window.__panel.shadowRoot.querySelector('.panel-model-menu').hidden`), 'model menu')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-model-manage').click(); true`)
    await wait(() => browser.evaluate(`!window.__panel.shadowRoot.querySelector('.panel-overlay').hidden`), 'model dialog')
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-model-card').length >= 1`), true)
    assert.equal(await browser.evaluate(`!window.__panel.shadowRoot.querySelector('.panel-overlay').querySelector('input[type=password]').value.includes('secret')`), true)
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-dialog-cancel').click(); true`)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-overlay').hidden`), 'model dialog closed')
    assert.equal(await browser.evaluate('document.activeElement === document.querySelector("agent-panel")'), true, '关闭设置后焦点应回到组件')

    // Real 401 responses must refresh the ticket and send the new bearer on both request paths.
    assert.equal(await browser.evaluate(`(async () => {
      const panel = window.__panel
      panel._token = 'invalid-token'
      const snapshot = await panel._request('')
      panel._token = 'invalid-token'
      const settings = await panel._requestRoot('/api/v1/settings/models')
      return snapshot.sessionId === panel.sessionId && Array.isArray(settings.models)
    })()`, { awaitPromise: true }), true, '401 retry must include refreshed authorization')

    // A transient polling transport failure is explained and recovers without a reload.
    await browser.evaluate(`(() => {
      window.__realFetch = window.fetch
      let failed = false
      window.fetch = function(url, options) {
        if (!failed && String(url).includes('/events?')) { failed = true; return Promise.reject(new TypeError('Failed to fetch')) }
        return window.__realFetch.apply(this, arguments)
      }
    })()`)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-error').textContent.includes('无法连接 Agent Service')`), 'poll failure explained')
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-error').hidden && !window.__panel.shadowRoot.querySelector('textarea').disabled`), 'poll retry recovered')
    await browser.evaluate('window.fetch = window.__realFetch; true')

    // 发送消息、观察流式回复与审批。
    await browser.evaluate(`(() => {
      const root = window.__panel.shadowRoot
      const area = root.querySelector('textarea')
      area.value = '请调用测试工具'
      area.dispatchEvent(new Event('input'))
      root.querySelector('.panel-send').click()
      return true
    })()`)
    const approval = await wait(() => browser.evaluate(`(() => {
      const root = window.__panel && window.__panel.shadowRoot
      const button = root && Array.from(root.querySelectorAll('.panel-approval .panel-primary'))[0]
      return button ? true : false
    })()`), 'approval card')
    assert(approval)
    assert.equal(await browser.evaluate(`(() => {
      const root = window.__panel.shadowRoot
      const button = root.querySelector('.panel-send')
      return root.querySelectorAll('.panel-toolbar > button.panel-icon-button').length === 1 &&
        button.getAttribute('aria-label') === '停止执行' && !button.disabled &&
        !root.querySelector('.panel-stop-icon').hidden && root.querySelector('.panel-send-icon').hidden &&
        root.querySelector('.panel-state').textContent.includes('正在生成') &&
        getComputedStyle(root.querySelector('.panel-state')).width !== '1px'
    })()`), true, 'running state must be visible and the composer action must switch to stop')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-approval .panel-primary').click(); true`)
    let streamed = false
    for (let index = 0; index < 80; index++) {
      if (await browser.evaluate(`Boolean(window.__panel.shadowRoot.querySelector('.panel-bubble.assistant.streaming'))`)) { streamed = true; break }
      await sleep(100)
    }
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-messages').textContent.includes('测试 Host 已返回结果。')`), 'assistant reply')
    assert(streamed, 'streaming assistant bubble must appear before completion')
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-tool, .panel-activity, .panel-tool-history').length === 0`), true, 'tool calls and tool results must not render in the panel')
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-messages').textContent.includes('测试工具结果')`), false, 'tool output must stay out of the chat stream')
    assert.equal(await browser.evaluate(`document.querySelector('agent-panel').shadowRoot.querySelectorAll('.panel-bubble.user').length === 1`), true)

    // 空闲轮询不得重绘消息区：用户上翻阅读时不能被拉回底部。
    const probe = await browser.evaluate(`(() => {
      const host = document.querySelector('agent-panel')
      host.style.height = '640px'
      const area = window.__panel.shadowRoot.querySelector('.panel-messages')
      for (let index = 0; index < 30; index++) {
        const line = document.createElement('p')
        line.className = 'scroll-probe'
        line.style.height = '48px'
        line.textContent = '阅读位置探针 ' + index
        area.appendChild(line)
      }
      area.scrollTop = 0
      area.dispatchEvent(new Event('scroll'))
      return { scrollable: area.scrollHeight > area.clientHeight, top: area.scrollTop, width: area.clientWidth, thumbOpacity: getComputedStyle(window.__panel.shadowRoot.querySelector('.panel-scroll-thumb')).opacity }
    })()`)
    assert(probe.scrollable, 'probe content must overflow the message area')
    await sleep(2800)
    const afterPoll = await browser.evaluate(`(() => {
      const area = window.__panel.shadowRoot.querySelector('.panel-messages')
      return { probes: area.querySelectorAll('.scroll-probe').length, top: area.scrollTop, width: area.clientWidth, thumb: window.__panel.shadowRoot.querySelector('.panel-scroll-thumb').hidden }
    })()`)
    assert.equal(afterPoll.probes, 30, 'idle polling must not repaint the message list')
    assert.equal(afterPoll.top, probe.top, 'idle polling must not move the reading position')
    assert.equal(afterPoll.width, probe.width, 'custom overlay scrollbar must not shrink the content width')
    assert.equal(afterPoll.thumb, false, 'floating scroll thumb must appear once content overflows')
    assert.equal(probe.thumbOpacity, '0', 'floating scroll thumb must stay hidden until hover')

    // 自定义主题：颜色令牌生效，切回内置主题时清除，切换前不得残留。
    const customTheme = await browser.evaluate(`(() => {
      const panel = window.__panel
      panel.setTheme({ mode: 'dark', variables: { '--ap-bg': '#061a2b', 'not-a-token': 'red' } })
      const area = panel.shadowRoot.querySelector('.panel')
      return {
        background: getComputedStyle(area).backgroundColor,
        ghost: area.style.getPropertyValue('not-a-token'),
        mode: area.dataset.theme
      }
    })()`)
    assert.equal(customTheme.background, 'rgb(6, 26, 43)', 'custom theme variables must apply')
    assert.equal(customTheme.ghost, '', 'only --ap-* tokens may be applied')
    assert.equal(customTheme.mode, 'dark')
    const clearedTheme = await browser.evaluate(`(() => {
      window.__panel.setTheme('light')
      const area = window.__panel.shadowRoot.querySelector('.panel')
      return { custom: area.style.getPropertyValue('--ap-bg'), background: getComputedStyle(area).backgroundColor, mode: area.dataset.theme }
    })()`)
    assert.equal(clearedTheme.custom, '', 'switching themes must clear previous custom variables')
    assert.equal(clearedTheme.background, 'rgb(250, 250, 250)', 'built-in light theme must take over')
    assert.equal(clearedTheme.mode, 'light')
    await browser.evaluate('window.__unmount(); true')
    await sleep(200)
    assert.equal(await browser.evaluate('document.querySelector("agent-panel") === null'), true)
    assert.equal(await browser.evaluate('window.__panelState.detached >= 1'), true, 'Host Connector detach hook must run')
    await browser.evaluate('window.__mount()', { awaitPromise: true })
    await wait(() => browser.evaluate('window.__panel && window.__panel.connected && !window.__panel.running'), 'panel remounted')
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-messages').textContent.includes('测试 Host 已返回结果。')`), 'history after remount')
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-bubble.user').length === 1`), true, 'remount must not duplicate messages')

    // 页面刷新：仍从宿主 Origin 的 IndexedDB 恢复。
    await browser.evaluate('location.reload(); true')
    await wait(() => browser.evaluate('typeof window.__mount === "function"'), 'page reloaded')
    await browser.evaluate('window.__mount()', { awaitPromise: true })
    await wait(() => browser.evaluate('window.__panel && window.__panel.connected'), 'panel after reload')
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-messages').textContent.includes('测试 Host 已返回结果。')`), 'history after reload')
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-bubble.user').length === 1`), true, 'reload must not duplicate messages')

    // Service 重启：旧面板令牌失效，宿主重新注入票据，历史保留并继续对话。
    const oldEpoch = await browser.evaluate('window.__panel.shadowRoot ? window.__panelState.sessionId : ""')
    await service.close()
    config.port = servicePort
    service = await createService({ home, config })
    service.plugins.options.settings.update({ baseURL: 'http://127.0.0.1:' + modelPort + '/v1', apiKey: 'test', model: 'test-model', maxIterations: 5 })
    await wait(() => service.plugins.requireService('hostConnector').online('host'), 'Host reconnect', 400)
    await wait(() => browser.evaluate('window.__panel && window.__panel.connected && !window.__panel.blocked'), 'panel after service restart', 400)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-messages').textContent.includes('测试 Host 已返回结果。')`), 'history after service restart')
    await wait(() => browser.evaluate(`!window.__panel.running && !window.__panel.shadowRoot.querySelector('textarea').disabled`), 'panel ready after service restart', 400)
    await browser.evaluate(`(() => {
      const root = window.__panel.shadowRoot
      const area = root.querySelector('textarea')
      area.value = '重启后继续'
      area.dispatchEvent(new Event('input'))
      return !root.querySelector('.panel-send').disabled
    })()`)
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-send').click(); true`)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-messages').textContent.includes('重启后继续')`), 'message after restart')
    await wait(() => browser.evaluate(`!window.__panel.running && window.__panel.shadowRoot.querySelector('.panel-messages').textContent.split('测试 Host 已返回结果。').length >= 3`), 'reply after restart', 400)
    assert(oldEpoch, 'session id must be available')

    // 保留未确认消息并重启后重新挂载：面板必须显示核对入口，绝不自动发送。
    await browser.evaluate(`(async () => {
      const panel = window.__panel
      const state = await panel._storage.read()
      await panel._storage.reserve('未确认测试消息', 'pending-test-1', state.cursor)
      window.__unmount()
    })()`, { awaitPromise: true })
    await service.close()
    config.port = servicePort
    service = await createService({ home, config })
    service.plugins.options.settings.update({ baseURL: 'http://127.0.0.1:' + modelPort + '/v1', apiKey: 'test', model: 'test-model', maxIterations: 5 })
    await wait(() => service.plugins.requireService('hostConnector').online('host'), 'Host reconnect after pending restart', 400)
    await browser.evaluate('window.__mount()', { awaitPromise: true })
    assert.equal(await browser.evaluate(`window.__panel.blocked && !window.__panel.shadowRoot.querySelector('.panel-resync').hidden`), true)
    assert.equal(await browser.evaluate(`(async () => Boolean((await window.__panel._storage.read()).pending))()` , { awaitPromise: true }), true)
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-resync').click(); true`)
    await wait(() => browser.evaluate('window.__panel && !window.__panel.blocked && !window.__panel.shadowRoot.querySelector("textarea").disabled'), 'manual recovery', 400)

    // Inject an actual Host context failure through the real panel transport and IndexedDB adapter.
    connector.options.getContext = async () => { throw new Error('TEST_CONTEXT_FAILURE') }
    await browser.evaluate(`(() => {
      const root = window.__panel.shadowRoot
      const area = root.querySelector('textarea')
      area.value = '失败事件回归测试'
      area.dispatchEvent(new Event('input'))
      root.querySelector('.panel-send').click()
    })()`)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-messages').textContent.includes('执行失败：') && !window.__panel.running`), 'failed turn applied', 400)
    assert.equal(await browser.evaluate(`(async () => {
      const state = await window.__panel._storage.read()
      return !state.pending && !window.__panel.blocked && window.__panel.shadowRoot.querySelector('.panel-error').hidden
    })()`, { awaitPromise: true }), true, 'failed event must settle pending without a storage-format error')
    connector.options.getContext = async () => ({ page: '测试页面' })

    // Stop is the same composer action, not a second visible control.
    await browser.evaluate(`(() => {
      const root = window.__panel.shadowRoot
      root.querySelector('textarea').value = '停止测试'
      root.querySelector('textarea').dispatchEvent(new Event('input'))
      root.querySelector('.panel-send').click()
    })()`)
    await wait(() => browser.evaluate(`window.__panel.running && Boolean(window.__panel.shadowRoot.querySelector('.panel-approval .panel-primary'))`), 'stop test running')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-send').click(); true`)
    await wait(() => browser.evaluate(`!window.__panel.running && window.__panel.shadowRoot.querySelector('.panel-send').getAttribute('aria-label') === '发送'`), 'stop returns to send', 400)

    // The server-advertised byte limit is checked before reserving a message.
    assert.equal(await browser.evaluate(`(async () => {
      const panel = window.__panel
      const snapshot = panel._snapshot.bind(panel)
      panel._snapshot = async () => Object.assign(await snapshot(), { messageBodyMaxBytes: 131072 })
      const before = await panel._storage.read()
      panel._input.value = '中'.repeat(50000)
      panel._input.dispatchEvent(new Event('input'))
      await panel._submit()
      const after = await panel._storage.read()
      const ok = !before.pending && !after.pending && before.cursor === after.cursor && panel._errorText.textContent.includes('131072')
      panel._snapshot = snapshot
      panel._input.value = ''
      panel._clearNotice()
      panel._setError('')
      return ok
    })()`, { awaitPromise: true }), true, 'oversize UTF-8 body must fail before reserve without deleting history')

    // A lost write response must never cause an automatic replay, even after polling recovers.
    await browser.evaluate(`(() => {
      window.__writeAttempts = 0
      window.fetch = function(url, options) {
        if (String(url).endsWith('/messages') && options && options.method === 'POST') {
          window.__writeAttempts++
          return Promise.reject(new TypeError('Failed to fetch'))
        }
        return window.__realFetch.apply(this, arguments)
      }
      const root = window.__panel.shadowRoot
      root.querySelector('textarea').value = '不确定写入'
      root.querySelector('textarea').dispatchEvent(new Event('input'))
      root.querySelector('.panel-send').click()
    })()`)
    await wait(() => browser.evaluate(`window.__panel.blocked && window.__panel.shadowRoot.querySelector('.panel-error').textContent.includes('不会自动重发')`), 'uncertain write warning')
    await sleep(2500)
    assert.equal(await browser.evaluate(`window.__writeAttempts`), 1, 'uncertain writes must not be replayed by polling')
    assert.equal(await browser.evaluate(`window.__panel.blocked && !window.__panel.shadowRoot.querySelector('.panel-resync').hidden`), true)
    await browser.evaluate(`window.fetch = window.__realFetch; window.__panel.shadowRoot.querySelector('.panel-resync').click(); true`)
    await wait(() => browser.evaluate(`!window.__panel.blocked && !window.__panel.shadowRoot.querySelector('textarea').disabled`), 'manual uncertain write recovery')

    // 销毁。
    await browser.evaluate('window.__destroy(); true')
    assert.equal(await browser.evaluate('document.querySelector("agent-panel") === null'), true)
    console.log('PASS 跨源加载、挂载、流式、审批、卸载/重载、刷新、Service 重启与销毁（测试 Host）')

    // 宿主不接管历史/新建时，组件内置历史列表必须可点击：搜索、重命名、删除、新建。
    await browser.evaluate('window.__options.onHistory = null; window.__options.onNewSession = null; true')
    await browser.evaluate('window.__mount()', { awaitPromise: true })
    await wait(() => browser.evaluate('window.__panel && window.__panel.connected && !window.__panel.running'), 'builtin remount')
    const beforeBuiltin = await browser.evaluate('window.__panel.sessionId')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-history').click(); true`)
    await wait(() => browser.evaluate(`!window.__panel.shadowRoot.querySelector('.panel-history-popover').hidden && window.__panel.shadowRoot.querySelectorAll('.panel-history-row').length > 0`), 'builtin history rows')
    await browser.evaluate(`(() => {
      const input = window.__panel.shadowRoot.querySelector('.panel-history-input')
      input.value = '不存在的关键词'
      input.dispatchEvent(new Event('input'))
      return true
    })()`)
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-history-row').length`), 0, 'history search must filter rows')
    assert.equal(await browser.evaluate(`!window.__panel.shadowRoot.querySelector('.panel-history-status').hidden`), true, 'empty search must explain why nothing matches')
    await browser.evaluate(`(() => {
      const input = window.__panel.shadowRoot.querySelector('.panel-history-input')
      input.value = ''
      input.dispatchEvent(new Event('input'))
      return true
    })()`)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-history-row').length > 0`), 'history rows restored')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-history-row .panel-history-action').click(); true`)
    await wait(() => browser.evaluate(`Boolean(window.__panel.shadowRoot.querySelector('.panel-history-rename-input'))`), 'rename input')
    await browser.evaluate(`(() => {
      const input = window.__panel.shadowRoot.querySelector('.panel-history-rename-input')
      input.value = '改名会话'
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-history-name') && window.__panel.shadowRoot.querySelector('.panel-history-name').textContent === '改名会话'`), 'renamed row')
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-history-row.is-current').length`), 1, 'current session must be marked')
    // 删除当前会话：存储条目移除并自动新建一个空会话。
    await browser.evaluate(`(() => {
      const row = window.__panel.shadowRoot.querySelector('.panel-history-row.is-current')
      row.querySelectorAll('.panel-history-action')[1].click()
      return true
    })()`)
    await wait(() => browser.evaluate(`Boolean(window.__panel.shadowRoot.querySelector('.panel-history-confirm-text'))`), 'delete confirm')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-history-actions.is-confirm .is-danger').click(); true`)
    await wait(() => browser.evaluate(`window.__panel.sessionId && window.__panel.sessionId !== ${JSON.stringify(beforeBuiltin)} && window.__panel.connected && !window.__panel.running`), 'new session after delete')
    assert.equal(await browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-bubble').length`), 0, 'new session must start empty')
    await browser.evaluate(`window.__panel.shadowRoot.querySelector('.panel-history').click(); true`)
    await wait(() => browser.evaluate(`window.__panel.shadowRoot.querySelectorAll('.panel-history-row').length > 0`), 'history rows after delete')
    assert.equal(await browser.evaluate(`Array.from(window.__panel.shadowRoot.querySelectorAll('.panel-history-name')).some(name => name.textContent === '改名会话')`), false, 'deleted session must leave the list')
    assert.equal(await browser.evaluate(`window.__panelState.events.indexOf('session-change') !== -1 && window.__panelState.events.indexOf('session-delete') !== -1`), true, 'session events must be emitted')
    await browser.evaluate('window.__destroy(); true')
    console.log('PASS 内置历史会话（搜索、重命名、删除、新建）')

    // 独立远程会话页也必须由同一组件渲染（cookie 授权模式）。
    const standalone = await postJson(serviceOrigin + '/api/v1/sessions', userToken, { hostId: 'host', requestId: 'standalone_panel_' + Date.now() })
    standaloneBrowser = new BrowserDriver()
    await standaloneBrowser.launch(standalone.sessionUrl + '#launch=' + standalone.launchCredential, { electronPath: binary, width: 1000, height: 800, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    try { await wait(() => standaloneBrowser.evaluate('window.agentPanel && window.agentPanel.connected'), 'standalone page panel', 400) }
    catch (error) {
      console.error('standalone:', await standaloneBrowser.evaluate('({error: document.getElementById("pageError") && document.getElementById("pageError").textContent, hidden: document.getElementById("pageError") && document.getElementById("pageError").hidden, panel: Boolean(window.agentPanel), text: document.querySelector("agent-panel") && document.querySelector("agent-panel").shadowRoot.querySelector(".panel-state").textContent})'), standaloneBrowser.consoleErrors, standaloneBrowser.networkErrors)
      throw error
    }
    assert.equal(await standaloneBrowser.evaluate('location.hash === ""'), true, '页面必须清除 URL 中的票据')
    assert.equal(await standaloneBrowser.evaluate('document.getElementById("pageError").hidden'), true)
    assert.equal(await standaloneBrowser.evaluate('document.querySelector("agent-panel") === window.agentPanel'), true)
    await wait(() => standaloneBrowser.evaluate(`window.agentPanel.shadowRoot.querySelector('.panel-model-label').textContent === '默认模型'`), 'standalone model label')
    console.log('PASS 独立远程会话页复用 AgentPanel（cookie 授权模式）')

    // HTTPS：自签名证书仅用于本机验证真实 TLS 路径，不是生产证书。
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-panel-tls-'))
    const keyFile = path.join(certDir, 'key.pem'), certFile = path.join(certDir, 'cert.pem')
    const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
    if (openssl.status !== 0) throw Error('无法生成测试证书：' + openssl.stderr)
    secureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-panel-tls-home-'))
    const securePort = await freePort(), secureHostPort = await freePort()
    const secureConfig = {
      publicOrigin: 'https://127.0.0.1:' + securePort,
      host: '127.0.0.1',
      port: securePort,
      panelOrigins: ['https://127.0.0.1:' + secureHostPort],
      tls: { key: keyFile, cert: certFile },
      users: [{ id: 'user', tokenHash: hash(userToken), hosts: ['tls-host'] }],
      hosts: [{ id: 'tls-host', tokenHash: hash(hostToken), users: ['user'], tools: {} }]
    }
    service2 = await createService({ home: secureHome, config: secureConfig })
    tlsHostServer = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        res.end(`import AgentPanel from 'https://127.0.0.1:${securePort}/panel/${VERSION}/agent-panel.js'; window.__loaded = AgentPanel.version`)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://127.0.0.1:${securePort}"></head><body><script type="module" src="/app.js"></script></body></html>`)
    })
    await new Promise(resolve => tlsHostServer.listen(secureHostPort, '127.0.0.1', resolve))
    secureBrowser = new BrowserDriver()
    await secureBrowser.launch('https://127.0.0.1:' + secureHostPort + '/', { electronPath: binary, ignoreCertificateErrors: true, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    await wait(() => secureBrowser.evaluate('window.__loaded === ' + JSON.stringify(VERSION)), 'HTTPS panel module')
    const secureManifest = await new Promise((resolve, reject) => {
      https.get({ hostname: '127.0.0.1', port: securePort, path: '/panel/' + VERSION + '/manifest.json', rejectUnauthorized: false }, response => { let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => resolve({ status: response.statusCode, text })) }).on('error', reject)
    })
    assert.equal(secureManifest.status, 200)
    assert.equal(JSON.parse(secureManifest.text).version, VERSION)
    console.log('PASS HTTPS 固定版本入口（自签名本机证书）')
  } finally {
    for (const item of [browser, standaloneBrowser, secureBrowser]) { try { if (item) await item.close() } catch (_) {} }
    try { if (connector) await connector.close() } catch (_) {}
    try { if (service) await service.close() } catch (_) {}
    try { if (service2) await service2.close() } catch (_) {}
    for (const server of [hostServer, tlsHostServer]) { try { if (server) await close(server) } catch (_) {} }
    await close(model)
    for (const dir of [home, hostHome, secureHome]) { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {} }
  }
}

function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = http.request(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        if (response.statusCode >= 400) reject(Error('HTTP ' + response.statusCode + ' ' + text))
        else resolve(JSON.parse(text))
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

async function panelLogicSmoke() {
  const calls = []
  const context = {
    VERSION, HTMLElement: class {}, customElements: { get: () => true }, TextEncoder, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push(options.headers.authorization)
      return calls.length === 1 ? { status: 401, ok: false } : { status: 200, ok: true, json: async () => ({ ok: true }) }
    }
  }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/panel/agent-panel.js'), 'utf8') + '\nglobalThis.Panel = AgentPanelElement', context)
  for (const method of ['_request', '_requestRoot']) {
    calls.length = 0
    const panel = Object.create(context.Panel.prototype)
    Object.assign(panel, { _options: { endpoint: 'http://example.test' }, _sessionId: 's', _token: 'old', _cookie: false, _ensureToken: async () => { panel._token = 'new' } })
    assert((await panel[method]('/test')).ok)
    assert.deepStrictEqual(calls, ['Bearer old', 'Bearer new'])
  }
  const panel = Object.create(context.Panel.prototype)
  let label = ''
  const button = { setAttribute: (name, value) => { label = value } }
  Object.assign(panel, { _send: button, _sendIcon: {}, _stopIcon: {}, _input: { value: 'draft' }, _ready: true, _busy: false, _running: true })
  panel._updateControls()
  assert.equal(label, '停止执行')
  assert.equal(button.disabled, false)
  assert.equal(panel._sendIcon.hidden, true)
  panel._running = false
  panel._updateControls()
  assert.equal(label, '发送')
  assert.equal(panel._stopIcon.hidden, true)
  const state = { epoch: 'e', cursor: 0, messages: [], events: [], approvals: [] }
  let reserved = 0, writes = 0, errorText = ''
  Object.assign(panel, {
    _input: { value: '中'.repeat(50000) }, _messageBodyLimit: 131072, _busy: false, _ready: true, _running: false,
    _storage: { read: async () => state, reserve: async () => { reserved++; return { text: 'x', requestId: 'id', history: [] } } },
    _syncEvents: async () => {}, _snapshot: async () => ({}), _acceptSnapshot: () => {}, _requestId: () => 'id',
    _setError: text => { errorText = text }, _emit: () => {}, _schedulePoll: () => {}, _paint: () => {}, _renderStatus: () => {}
  })
  await panel._submit()
  assert.equal(reserved, 0, 'oversize UTF-8 body must be rejected before reserve')
  assert(errorText.includes('131072'))
  panel._input.value = 'x'
  panel._request = async () => { writes++; throw new TypeError('Failed to fetch') }
  await panel._submit()
  assert.equal(writes, 1)
  assert.equal(panel._blocked, true)
  assert.equal(panel._uncertainWrite, true)
  assert(errorText.includes('不会自动重发'))
  console.log('PASS panel 401 bearer refresh, composer states, size preflight and uncertain write (Node VM)')
}

if (process.argv.includes('--logic')) panelLogicSmoke().catch(error => { console.error(error); process.exitCode = 1 })
else main().catch(error => { console.error(error); process.exitCode = 1 })
