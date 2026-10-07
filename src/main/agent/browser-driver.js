'use strict'

/**
 * BrowserDriver：把本产品自带的 Electron（Chromium 108，Win7 能跑的上限）
 * 当成被测浏览器来驱动 —— 目标 Web/Cesium 系统不必改任何代码。
 *
 * 启动方式：spawn 一个新的 Electron 进程，挂 --remote-debugging-port，
 * 从 stderr 解析「DevTools listening on ws://127.0.0.1:PORT/...」拿到调试端口，
 * GET /json/list 找到 page 目标，再走 CdpSession 驱动。
 *
 * 硬约束对照：
 *   - 零依赖零下载（cdp-client.js 是纯 JS）；
 *   - --user-data-dir 指到临时目录 —— 绝不碰用户正在跑的 Agent 实例
 *     （不然单实例锁会把人家窗口顶掉）；
 *   - spawn 前必须删掉 ELECTRON_RUN_AS_NODE，否则起的是 Node 不是浏览器。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { MiniWebSocket, CdpSession, httpGetJson } = require('./cdp-client')

const not = (value) => value ? false : true
const MAX_CAPTURE = 200 /* console/network 采集上限，防长跑膨胀 */
const MAX_TEXT = 64 * 1024
const MAX_DOM = 128 * 1024

/* Input.dispatchKeyEvent 的常用键 → windowsVirtualKeyCode 映射 */
const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}

function pushCapped(list, item) {
  list.push(item)
  if (list.length > MAX_CAPTURE) list.shift()
}

/* 服务进程退出时兜底回收自己起过的浏览器 —— 模型忘了调 browser_close 也不能留下孤儿窗口。
   （会话结束走 agent.dispose() → driver.close()，这条路是正常回收；这里只管「进程没了」那种。） */
const liveDrivers = new Set()

function reapBrowsers() {
  for (const driver of liveDrivers) {
    const child = driver.child
    if (child && child.exitCode === null) {
      try { child.kill('SIGKILL') } catch (error) { /* 收摊不计较 */ }
    }
    /* close() 里的临时 profile 清理是 setTimeout 起的，强杀这条路不会跑到 —— 自己删掉。
       exit 处理器里只能同步操作，fs.rmSync 正好合适。 */
    if (driver.userDataDir) {
      try { fs.rmSync(driver.userDataDir, { recursive: true, force: true }) } catch (error) { /* 收摊不计较 */ }
    }
  }
  liveDrivers.clear()
}

process.on('exit', reapBrowsers)

class BrowserDriver {
  constructor(options) {
    this.options = options || {}
    this.child = null
    this.port = 0
    this.cdp = null
    this.launched = false
    this.closedByUs = false
    this.consoleErrors = [] /* {type:'console'|'exception'|'log', text, ts} */
    this.networkErrors = [] /* {kind:'status'|'failed', url, status?, errorText?, ts} */
    this.requestCount = 0
    this.onExited = null /* 进程意外退出时通知宿主 */
    this.ws = null
  }

  get isOpen() {
    return this.launched && this.child && this.child.exitCode === null
  }

  /* ---- 启动 ---- */
  async launch(targetUrl, launchOptions) {
    if (this.isOpen) {
      await this.open(targetUrl || 'about:blank')
      return { reused: true, port: this.port }
    }
    const options = launchOptions || {}
    const electronPath = options.electronPath || process.execPath /* 服务进程 execPath = Electron 本体 */
    const userDataType = 'dsh-browser-test-' + Date.now() + '-' + process.pid
    this.userDataDir = options.userDataDir || path.join(os.tmpdir(), userDataType)
    const args = [
      '--remote-debugging-port=0', /* 0 = 系统挑空闲端口，从 stderr 读真实值 */
      '--user-data-dir=' + this.userDataDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=' + (options.width || 1280) + ',' + (options.height || 800)
    ]
    if (options.noSandbox) args.push('--no-sandbox')
    if (options.disableGpu) args.push('--disable-gpu')
    const env = Object.assign({}, process.env)
    delete env.ELECTRON_RUN_AS_NODE /* 关键：删掉才起 Chromium */
    this.child = spawn(electronPath, args.concat([targetUrl || 'about:blank']), {
      env: env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false
    })
    const exitHandler = () => {
      this.launched = false
      liveDrivers.delete(this)
      if (this.onExited) this.onExited()
    }
    liveDrivers.add(this)
    this.child.on('exit', exitHandler)
    this.child.on('error', exitHandler)
    this.port = await this.readDebugPort(this.child.stderr, options.debugTimeoutMs || 20000)
    this.cdp = await this.attach(this.port, targetUrl || 'about:blank')
    this.wireCapture()
    this.launched = true
    return { reused: false, port: this.port }
  }

  /* stderr 里捞 DevTools 监听行 */
  readDebugPort(stderrStream, timeoutMs) {
    return new Promise((resolve, reject) => {
      let text = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('BROWSER_DEBUG_TIMEOUT: no DevTools line in ' + timeoutMs + 'ms. stderr head: ' + text.slice(0, 400)))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      const onData = (chunk) => {
        text += chunk.toString()
        const match = text.match(/DevTools listening on ws:\/\/[^\s]*?:(\d+)[^\s]*/)
        if (match && not(settled)) {
          settled = true
          clearTimeout(timer)
          stderrStream.removeListener('data', onData)
          resolve(Number(match[1]))
        }
      }
      stderrStream.on('data', onData)
    })
  }

  async attach(port, targetUrl) {
    /* 等目标页出现在 /json/list（Electron 起默认窗口需要一点时间） */
    let target = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && not(target)) {
      const list = await httpGetJson('127.0.0.1', port, '/json/list', 4000).catch(() => null)
      if (Array.isArray(list)) {
        target = list.find((item) => item.type === 'page') || null
      }
      if (not(target)) await sleep(250)
    }
    if (not(target)) {
      throw new Error('BROWSER_NO_PAGE_TARGET: /json/list had no page target')
    }
    const wsUrl = target.webSocketDebuggerUrl
    if (not(wsUrl)) {
      throw new Error('BROWSER_NO_WS_URL: page target has no webSocketDebuggerUrl')
    }
    const parsed = new URL(wsUrl)
    const websocket = new MiniWebSocket()
    await websocket.connect(parsed.hostname, Number(parsed.port), parsed.pathname + (parsed.search || ''), 10000)
    this.ws = websocket
    websocket.on('close', () => {
      this.launched = false
    })
    const session = new CdpSession(websocket)
    await session.send('Page.enable')
    await session.send('Runtime.enable')
    await session.send('Network.enable')
    await session.send('Log.enable').catch(() => undefined) /* 老内核个别版本没有 Log 域，可选 */
    return session
  }

  wireCapture() {
    const cdp = this.cdp
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'warning') {
        const text = (params.args || []).map((arg) => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type)).join(' ')
        if (params.type === 'error') {
          pushCapped(this.consoleErrors, { type: 'console', text: text.slice(0, 2000), ts: Date.now() })
        }
      }
    })
    cdp.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails || {}
      const text = detail.text + (detail.exception && detail.exception.description ? ' ' + detail.exception.description : '')
      pushCapped(this.consoleErrors, { type: 'exception', text: text.slice(0, 2000), ts: Date.now() })
    })
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {}
      if (entry.level === 'error') {
        pushCapped(this.consoleErrors, { type: 'log', text: String(entry.text || '').slice(0, 2000), ts: Date.now() })
      }
    })
    cdp.on('Network.requestWillBeSent', () => {
      this.requestCount += 1
    })
    cdp.on('Network.responseReceived', (params) => {
      const response = params.response || {}
      if (response.status >= 400) {
        pushCapped(this.networkErrors, {
          kind: 'status',
          url: String(response.url || '').slice(0, 500),
          status: response.status,
          ts: Date.now()
        })
      }
    })
    cdp.on('Network.loadingFailed', (params) => {
      /* canceled 多为主动取消/被前端拦截，不算错 */
      if (params.canceled) return
      pushCapped(this.networkErrors, {
        kind: 'failed',
        url: '',
        errorText: params.errorText || 'loading failed',
        type: params.type || '',
        ts: Date.now()
      })
    })
  }

  /* ---- 页面内执行 ---- */
  async evaluate(expression, options) {
    const settings = options || {}
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
      awaitPromise: settings.awaitPromise === true,
      userGesture: true,
      timeout: settings.timeoutMs || 15000
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      const text = detail.text + (detail.exception && detail.exception.description ? ': ' + detail.exception.description : '')
      throw new Error('EVAL_ERROR: ' + text.slice(0, 1000))
    }
    return result.result ? result.result.value : undefined
  }

  async url() {
    return this.evaluate('location.href')
  }

  async open(targetUrl) {
    if (not(this.isOpen)) {
      throw new Error('BROWSER_NOT_OPEN: call browser_launch first')
    }
    await this.cdp.send('Page.navigate', { url: String(targetUrl) })
    /* 等一次 loadEventFired（最多 30s），失败不阻塞 —— SPA 可能永不再触发 load */
    await new Promise((resolve) => {
      let timer = null
      const finish = () => {
        clearTimeout(timer)
        this.cdp.listeners['Page.loadEventFired'] = (this.cdp.listeners['Page.loadEventFired'] || []).filter((fn) => fn !== handler)
        resolve()
      }
      const handler = () => finish()
      timer = setTimeout(finish, 30000)
      if (timer.unref) timer.unref()
      this.cdp.on('Page.loadEventFired', handler)
    })
    return { navigated: true }
  }

  async centerOf(selector) {
    const box = await this.evaluate(
      '(function(sel){var el=document.querySelector(sel);if(!el)return null;el.scrollIntoView({block:"center",inline:"center"});' +
      'var r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})(' +
      JSON.stringify(String(selector)) + ')'
    )
    if (not(box)) {
      throw new Error('ELEMENT_NOT_FOUND: ' + selector)
    }
    return box
  }

  async click(selector) {
    const box = await this.centerOf(selector)
    const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
    await this.cdp.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base))
    await this.cdp.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base))
    return { clicked: true, selector: String(selector) }
  }

  async input(selector, text) {
    await this.click(selector)
    /* insertText 走真实输入管线，input/change 事件都会触发（Vue/React 都吃这套） */
    await this.cdp.send('Input.insertText', { text: String(text === undefined ? '' : text) })
    return { typed: String(text).length, selector: String(selector) }
  }

  async keypress(keyName) {
    const named = NAMED_KEYS[String(keyName).toLowerCase()]
    if (named) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, nativeVirtualKeyCode: named.vk })
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, nativeVirtualKeyCode: named.vk })
      return { key: named.key }
    }
    const single = String(keyName)
    if (single.length !== 1) {
      throw new Error('UNKNOWN_KEY: ' + keyName)
    }
    const vk = single.toUpperCase().charCodeAt(0)
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: single, code: 'Key' + single.toUpperCase(), windowsVirtualKeyCode: vk, text: single, unmodifiedText: single })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: single, code: 'Key' + single.toUpperCase(), windowsVirtualKeyCode: vk })
    return { key: single }
  }

  /* selector 可选；带 fn 就等到表达式为真，否则等到元素出现 */
  async wait(selector, timeoutMs) {
    const timeout = Math.max(500, Math.min(120000, Number(timeoutMs) || 10000))
    const deadline = Date.now() + timeout
    const probe = selector
      ? '(function(sel){return !!document.querySelector(sel)})(' + JSON.stringify(String(selector)) + ')'
      : String(selector)
    while (Date.now() < deadline) {
      const value = await this.evaluate(probe).catch(() => false)
      if (value) return { waited: true, selector: selector || '(expression)', timeoutMs: timeout - (deadline - Date.now()) }
      await sleep(200)
    }
    throw new Error('WAIT_TIMEOUT: ' + (selector || '(expression)') + ' not satisfied in ' + timeout + 'ms')
  }

  async getDom(selector, maxLength) {
    const html = await this.evaluate(
      '(function(sel){var el=document.querySelector(sel);return el?el.outerHTML:null})(' + JSON.stringify(String(selector)) + ')'
    )
    if (html === null || html === undefined) {
      throw new Error('ELEMENT_NOT_FOUND: ' + selector)
    }
    const limit = Math.max(200, Math.min(MAX_DOM, Number(maxLength) || MAX_DOM))
    return { html: String(html).slice(0, limit), truncated: String(html).length > limit }
  }

  async getText(selector, maxLength) {
    const text = await this.evaluate(
      '(function(sel){var el=sel?document.querySelector(sel):document.body;return el?el.textContent:null})(' + JSON.stringify(String(selector || '')) + ')'
    )
    if (text === null || text === undefined) {
      throw new Error('ELEMENT_NOT_FOUND: ' + selector)
    }
    const limit = Math.max(200, Math.min(MAX_TEXT, Number(maxLength) || MAX_TEXT))
    return { text: String(text).slice(0, limit), truncated: String(text).length > limit }
  }

  async screenshot() {
    if (not(this.isOpen)) {
      throw new Error('BROWSER_NOT_OPEN')
    }
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000)
    return result.data /* base64 png */
  }

  async close() {
    this.closedByUs = true
    liveDrivers.delete(this)
    if (this.ws) {
      try { this.ws.close() } catch (error) { /* 收摊不计较 */ }
      this.ws = null
    }
    this.cdp = null
    this.launched = false
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) {
      /* 先体面退（Electron 会清 user-data-dir 锁），卡住再强杀 */
      child.kill()
      const forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch (error) { /* 已退出 */ }
      }, 3000)
      if (forceTimer.unref) forceTimer.unref()
    }
    this.consoleErrors = []
    this.networkErrors = []
    this.requestCount = 0
    if (this.userDataDir) {
      const dir = this.userDataDir
      setTimeout(() => {
        fs.rm(dir, { recursive: true, force: true }, () => undefined)
      }, 5000).unref()
    }
    return { closed: true }
  }

  snapshot() {
    return {
      open: this.isOpen,
      port: this.port,
      requestCount: this.requestCount,
      consoleErrors: this.consoleErrors.slice(),
      networkErrors: this.networkErrors.slice()
    }
  }
}

module.exports = {
  BrowserDriver,
  NAMED_KEYS
}
