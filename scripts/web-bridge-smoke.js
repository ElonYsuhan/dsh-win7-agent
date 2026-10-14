'use strict'

/* 真正执行 HTTP 桥接：首条发送必须等 SSE 建连；桌面壳操作必须交给 native IPC。
   全部用隔离的 VM 和 EventSource/fetch 替身，不启动服务，也不依赖本机桌面。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/web-bridge.js'), 'utf8')
let passed = 0

function ok(name, value) {
  assert(value, name)
  passed += 1
  console.log('PASS  ' + name)
}

function harness(nativeShell) {
  const requests = []
  const sources = []
  const opened = []
  const prompts = []
  const unload = []
  const controls = { autoFinish: true, chatError: '' }
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.listeners = {}
      sources.push(this)
    }

    addEventListener(type, listener) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(listener)
    }

    removeEventListener(type, listener) {
      this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== listener)
    }

    emit(type, value) {
      if (type === 'open') this.readyState = 1
      if (type === 'error') this.readyState = 0
      const event = type === 'message' ? { data: JSON.stringify(value) } : {}
      if (this['on' + type]) this['on' + type](event)
      for (const listener of (this.listeners[type] || []).slice()) listener(event)
    }

    close() { this.readyState = 2 }
  }
  const window = {
    shell: nativeShell || undefined,
    open: (target, disposition, features) => opened.push({ target, disposition, features }),
    prompt: (label, initial) => { prompts.push({ label, initial }); return '/chosen/browser' },
    addEventListener: (type, callback) => { if (type === 'beforeunload') unload.push(callback) }
  }
  const sandbox = {
    window, EventSource: FakeEventSource, setTimeout, clearTimeout, console,
    fetch: async (target, options) => {
      const body = options.body ? JSON.parse(options.body) : null
      requests.push({ target, method: options.method, body })
      if (target === '/api/chat' && !controls.chatError && controls.autoFinish) {
        sources[0].emit('message', { type: 'finished', sessionId: body.sessionId })
      }
      const data = target === '/api/state' ? { workspacePath: '/current/workspace' }
        : target === '/api/workspace' ? { workspacePath: body.path }
          : controls.chatError && target === '/api/chat' ? { error: controls.chatError } : { ok: true }
      return {
        ok: !(controls.chatError && target === '/api/chat'), status: 503,
        text: async () => JSON.stringify(data)
      }
    }
  }
  vm.runInNewContext(source, sandbox, { filename: 'web-bridge.js' })
  return { api: window.dsh, requests, sources, opened, prompts, controls, unload }
}

async function main() {
  const web = harness()
  const chatRequests = () => web.requests.filter((request) => request.target === '/api/chat')
  const first = web.api.send('first', [], [], undefined, 'session_first')
  await Promise.resolve()
  ok('首条发送在 SSE 建立前不提交聊天请求', web.sources.length === 1 && chatRequests().length === 0)
  web.sources[0].emit('open')
  ok('SSE 建立后快速完成的首条聊天可以收尾', await first === true && chatRequests().length === 1)
  ok('发送正文包含自动会话 id 和历史', chatRequests()[0].body.sessionId === 'session_first'
    && Array.isArray(chatRequests()[0].body.history))
  ok('建连监听器在成功后清理', web.sources[0].listeners.open.length === 0
    && web.sources[0].listeners.error.length === 0)

  web.controls.autoFinish = false
  let secondDone = false
  const a = web.api.send('a', [], [], undefined, 'session_a')
  const b = web.api.send('b', [], [], undefined, 'session_b').then((value) => { secondDone = true; return value })
  await Promise.resolve()
  web.sources[0].emit('message', { type: 'finished', sessionId: 'session_a' })
  await a
  ok('其他并行会话完成不会提前结束当前发送', secondDone === false)
  web.sources[0].emit('message', { type: 'finished', sessionId: 'session_b' })
  ok('当前会话自己的完成事件才结束发送', await b === true)

  web.sources[0].readyState = 0
  const beforeDisconnect = chatRequests().length
  const disconnected = web.api.send('offline', [], [], undefined, 'session_offline')
  web.sources[0].emit('error')
  await assert.rejects(disconnected, /AGENT_EVENT_DISCONNECTED/)
  ok('事件流建连失败时明确报错且不发送会丢收尾的聊天', chatRequests().length === beforeDisconnect)
  web.sources[0].emit('open')
  web.controls.chatError = 'POOL_BUSY'
  await assert.rejects(web.api.send('busy', [], [], undefined, 'session_busy'), /POOL_BUSY/)
  ok('HTTP 错误仍向调用方传播', true)
  await web.api.openExternal('https://example.org/chat')
  ok('普通网页的外部链接用浏览器新标签打开', web.opened.length === 1
    && web.opened[0].features === 'noopener' && web.api.isDesktop === false)
  await web.api.pickWorkspace()
  ok('普通网页通过输入服务器路径切换工作区', web.prompts.length === 1
    && web.requests.some((request) => request.target === '/api/workspace' && request.body.path === '/chosen/browser'))
  web.unload[0]()
  ok('页面关闭会关掉事件流', web.sources[0].readyState === 2)

  const nativeCalls = []
  const nativeState = { chosen: 'C:\\workspace', error: '' }
  const native = harness({
    pickFolder: async () => { nativeCalls.push('pickFolder'); return nativeState.chosen },
    openPath: async (target) => { nativeCalls.push(['openPath', target]); return nativeState.error },
    openExternal: async (target) => { nativeCalls.push(['openExternal', target]); return 'OK' }
  })
  await native.api.openPath('C:\\workspace')
  await native.api.openExternal('https://example.org/chat')
  ok('薄壳打开工作区和外部链接转交原生 IPC', native.api.isDesktop === true
    && nativeCalls[0][0] === 'openPath' && nativeCalls[1][0] === 'openExternal'
    && native.opened.length === 0)
  nativeState.error = 'native open failed'
  await assert.rejects(native.api.openPath('C:\\missing'), /native open failed/)
  ok('原生打开失败不会被当成成功吞掉', true)
  await native.api.pickWorkspace()
  await native.api.createWorkspace()
  ok('薄壳选择和新建工作区使用原生目录选择器', nativeCalls.filter((value) => value === 'pickFolder').length === 2
    && native.prompts.length === 0
    && native.requests.filter((request) => request.target === '/api/workspace').length === 2)
  nativeState.chosen = ''
  const beforeCancel = native.requests.filter((request) => request.target === '/api/workspace').length
  await native.api.pickWorkspace()
  ok('取消原生选目录不提交空工作区', native.requests.filter((request) => request.target === '/api/workspace').length === beforeCancel)
  console.log('web bridge smoke: ' + passed + '/' + passed + ' checks passed, node ' + process.version)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
