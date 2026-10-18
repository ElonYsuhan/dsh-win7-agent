'use strict'

/* 空安装首次聊天的真实 Chromium 回归。
   仅访问本机 HTTP 模型替身和隔离服务；所有数据与浏览器配置均写到临时目录。
   运行：SMOKE_NO_SANDBOX=1 node scripts/first-chat-e2e-smoke.js */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { BrowserDriver } = require('../src/main/agent/browser-driver')

const ROOT = path.resolve(__dirname, '..')
const FIRST_TEXT = '第一次打开，没有新建会话，直接聊天'
const FIRST_REPLY = '首轮本地测试回复'
const SECOND_TEXT = '第二句话继续刚才的上下文'
const SECOND_REPLY = '第二轮本地测试回复'
const LARGE_CANCEL_TEXT = '取消进行中的测试请求' + 'x'.repeat(1100000) + '中文边界验证'.repeat(3000)
let passed = 0

function ok(name, condition, detail) {
  assert(condition, name + (detail ? ': ' + detail : ''))
  passed += 1
  console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : ''))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, label, timeoutMs) {
  const end = Date.now() + (timeoutMs || 10000)
  let lastError = null
  while (Date.now() < end) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { lastError = error }
    await sleep(100)
  }
  throw new Error('等待超时：' + label + (lastError ? ' (' + lastError.message + ')' : ''))
}

function request(method, target, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload))
    const url = new URL(target)
    assert(url.hostname === '127.0.0.1', '测试请求只能访问本机回环地址')
    const req = http.request(url, {
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk.toString('utf8') })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null }) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP_TIMEOUT')))
    if (data) req.write(data)
    req.end()
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

async function freePort() {
  const probe = http.createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function allSessions(store) {
  const sessions = []
  for (const key of Object.keys(store || {})) {
    if (Array.isArray(store[key])) sessions.push.apply(sessions, store[key])
  }
  return sessions
}

function hasMessage(messages, role, content) {
  return Array.isArray(messages) && messages.some((message) => message.role === role && message.content === content)
}

function chatMessages(messages) {
  return (messages || []).filter((message) => message.role === 'user' || message.role === 'assistant')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-first-chat-e2e-'))
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const driver = new BrowserDriver({})
  const modelRequests = []
  const replies = []
  let service = null
  let browserChild = null
  let logs = ''
  const model = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404)
        res.end('unexpected mock endpoint')
        return
      }
      try {
        modelRequests.push(JSON.parse(body))
        replies.push((text) => {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '检查过程：' + text }, finish_reason: null }] }) + '\n\n')
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) + '\n\n')
          res.end('data: [DONE]\n\n')
        })
      } catch (error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: { message: error.message } }))
      }
    })
  })
  try {
    const modelPort = await listen(model)
    const port = await freePort()
    const base = 'http://127.0.0.1:' + port
    service = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        HOST: '127.0.0.1', PORT: String(port), PORT_MAX_ATTEMPTS: '1', AGENT_HOME: home,
        WORKSPACE_PATH: workspace, MODEL_BASE_URL: 'http://127.0.0.1:' + modelPort + '/v1',
        MODEL_API_KEY: 'local-mock', MODEL_NAME: 'first-chat-mock'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    service.stdout.on('data', (chunk) => { logs += chunk.toString() })
    service.stderr.on('data', (chunk) => { logs += chunk.toString() })
    await waitFor(async () => (await request('GET', base + '/api/health')).status === 200, '隔离服务启动', 15000)
    ok('本机服务使用隔离临时数据目录', fs.existsSync(path.join(home, 'settings.json')))
    const configured = await request('POST', base + '/api/settings', {
      models: [{ id: 'mock', name: '本机测试模型', baseURL: 'http://127.0.0.1:' + modelPort + '/v1',
        apiKey: 'local-mock', model: 'first-chat-mock', protocol: 'openai-completions', modelList: ['first-chat-mock'] }],
      currentModelId: 'mock', workspacePath: workspace, projects: [], currentProjectId: '',
      maxIterations: 2, maxTokens: 128, requestTimeoutMs: 15000, contextAutoCompress: false
    })
    ok('模型指向本机替身，初始没有项目', configured.status === 200 && configured.data.projects.length === 0
      && configured.data.currentProjectId === '')
    const initialStore = await request('GET', base + '/api/ui-store')
    ok('初始没有任何会话记录', allSessions(initialStore.data.store.sessions).length === 0)

    const binary = fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
    const launched = await driver.launch(base + '/', {
      electronPath: path.join(ROOT, 'node_modules/electron/dist', binary),
      userDataDir: path.join(root, 'browser'), width: 1100, height: 800,
      noSandbox: process.env.SMOKE_NO_SANDBOX === '1'
    })
    browserChild = driver.child
    ok('真实 Chromium 已启动并连接 CDP', driver.isOpen && launched.port > 0)
    await waitFor(() => driver.evaluate('typeof state !== "undefined" && state.settings && document.getElementById("composerModelLabel").textContent === "first-chat-mock"'), '界面加载')
    const initialPage = await driver.evaluate('({id:state.currentSessionId, count:getAllSessions().length, projects:state.settings.projects.length})')
    ok('真实页面首次进入时没有项目或当前会话', initialPage.id === '' && initialPage.count === 0 && initialPage.projects === 0)

    await driver.input('#input', FIRST_TEXT)
    await driver.click('#send')
    await waitFor(() => modelRequests.length === 1, '首轮本机模型请求')
    const running = await driver.evaluate('({id:state.currentSessionId, running:currentRunning(), sendHidden:document.getElementById("send").classList.contains("hidden"), stopHidden:document.getElementById("stop").classList.contains("hidden")})')
    const sessionId = running.id
    ok('没有点新建会话，真实点击发送自动创建会话 id', typeof sessionId === 'string' && sessionId.indexOf('session_') === 0, sessionId)
    ok('首条任务运行时显示停止按钮并按会话记录运行态', running.running && running.sendHidden && !running.stopHidden)
    replies[0](FIRST_REPLY)
    await waitFor(() => driver.evaluate('Boolean(currentSession() && currentSession().messages.some(function(m){return m.role === "assistant" && m.content === ' + JSON.stringify(FIRST_REPLY) + '}) && !currentRunning())'), '首轮 finished 收尾')
    const first = await driver.evaluate('JSON.parse(localStorage.getItem("dsh-sessions-v1")).__recent__[0]')
    ok('首次聊天进入最近列表并保存用户与助手消息', first.id === sessionId && first.scope === 'recent'
      && first.projectId === '' && hasMessage(first.messages, 'user', FIRST_TEXT) && hasMessage(first.messages, 'assistant', FIRST_REPLY))
    ok('finished 解除运行态并恢复发送按钮', await driver.evaluate('!currentRunning() && !document.getElementById("send").classList.contains("hidden") && document.getElementById("stop").classList.contains("hidden")'))
    ok('首轮回复真正渲染到页面', await driver.evaluate('document.getElementById("messagesInner").textContent.indexOf(' + JSON.stringify(FIRST_REPLY) + ') !== -1'))
    const backendIdle = await request('GET', base + '/api/state')
    ok('后端运行会话账本也已清空', backendIdle.data.running === false && backendIdle.data.runningSessions.length === 0)

    await driver.input('#input', SECOND_TEXT)
    await driver.click('#send')
    await waitFor(() => modelRequests.length === 2, '第二轮本机模型请求')
    const secondHistory = modelRequests[1].messages
    ok('第二轮模型请求包含完整第一轮上下文', hasMessage(secondHistory, 'user', FIRST_TEXT)
      && hasMessage(secondHistory, 'assistant', FIRST_REPLY) && hasMessage(secondHistory, 'user', SECOND_TEXT))
    ok('第二轮复用首轮自动会话 id', await driver.evaluate('state.currentSessionId') === sessionId)
    replies[1](SECOND_REPLY)
    await waitFor(() => driver.evaluate('Boolean(currentSession() && currentSession().messages.some(function(m){return m.role === "assistant" && m.content === ' + JSON.stringify(SECOND_REPLY) + '}) && !currentRunning())'), '第二轮 finished 收尾')
    const saved = await waitFor(async () => {
      const result = await request('GET', base + '/api/ui-store')
      const store = result.data.store
      const session = allSessions(store.sessions).find((item) => item.id === sessionId)
      return store.currentSessionId === sessionId && session && hasMessage(session.messages, 'assistant', SECOND_REPLY) ? store : null
    }, '服务端 ui-store 保存两轮聊天')
    const savedSession = allSessions(saved.sessions).find((item) => item.id === sessionId)
    ok('服务端 ui-store 保存自动会话 id 与两轮聊天', saved.currentSessionId === sessionId && chatMessages(savedSession.messages).length === 4
      && allSessions(saved.sessions).length === 1)
    const disk = JSON.parse(fs.readFileSync(path.join(home, 'ui-store.json'), 'utf8'))
    ok('隔离目录内 ui-store.json 也已落盘', disk.currentSessionId === sessionId
      && hasMessage(allSessions(disk.sessions)[0].messages, 'assistant', SECOND_REPLY))

    await driver.open(base + '/')
    await waitFor(() => driver.evaluate('typeof state !== "undefined" && state.currentSessionId === ' + JSON.stringify(sessionId)
      + ' && currentSession() && currentSession().messages.filter(function(m){return m.role === "user" || m.role === "assistant"}).length === 4'), '刷新恢复当前会话')
    const restored = await driver.evaluate('({id:state.currentSessionId, count:getAllSessions().length, localId:localStorage.getItem("dsh-current-session"), messages:currentSession().messages, text:document.getElementById("messagesInner").textContent})')
    ok('刷新后恢复同一个自动会话且没有重复新建', restored.id === sessionId && restored.localId === sessionId && restored.count === 1)
    ok('刷新后两轮用户与助手消息仍显示完整', chatMessages(restored.messages).length === 4
      && [FIRST_TEXT, FIRST_REPLY, SECOND_TEXT, SECOND_REPLY].every((text) => restored.text.indexOf(text) !== -1))
    const finalStore = await request('GET', base + '/api/ui-store')
    ok('刷新初始化保持服务端历史和当前会话 id', finalStore.data.store.currentSessionId === sessionId
      && allSessions(finalStore.data.store.sessions).length === 1
      && chatMessages(allSessions(finalStore.data.store.sessions)[0].messages).length === 4)
    const traceOrder = await driver.evaluate('Array.from(document.querySelectorAll("#messagesInner > *")).map(function(node){return node.textContent})')
    const firstTrace = traceOrder.findIndex((text) => text.indexOf('检查过程：' + FIRST_REPLY) !== -1)
    const firstAnswer = traceOrder.findIndex((text) => text.indexOf(FIRST_REPLY) !== -1 && text.indexOf('检查过程：') === -1)
    const secondTrace = traceOrder.findIndex((text) => text.indexOf('检查过程：' + SECOND_REPLY) !== -1)
    ok('刷新后两轮真实流式思考在各自回复之前，第二轮仍位于第一轮回复之后',
      firstTrace !== -1 && firstAnswer > firstTrace && secondTrace > firstAnswer, JSON.stringify(traceOrder))
    await driver.close()
    service.kill('SIGTERM')
    await waitFor(() => service.exitCode !== null || service.signalCode !== null, '旧服务完整退出')
    service = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
      cwd: ROOT, env: Object.assign({}, process.env, {
        HOST: '127.0.0.1', PORT: String(port), PORT_MAX_ATTEMPTS: '1', AGENT_HOME: home, WORKSPACE_PATH: workspace
      }), stdio: ['ignore', 'pipe', 'pipe']
    })
    service.stdout.on('data', (chunk) => { logs += chunk.toString() })
    service.stderr.on('data', (chunk) => { logs += chunk.toString() })
    await waitFor(async () => (await request('GET', base + '/api/health')).status === 200, '磁盘恢复后的新服务启动')
    await driver.launch(base + '/', { electronPath: path.join(ROOT, 'node_modules/electron/dist', binary),
      noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    browserChild = driver.child
    await waitFor(() => driver.evaluate('typeof currentSession === "function" && currentSession() && currentSession().processTimeline && currentSession().processTimeline.length === 2'), '全新浏览器进程从服务端恢复过程')
    const reopened = await driver.evaluate('document.getElementById("messagesInner").textContent')
    ok('浏览器和服务进程全部关闭后重开，无本地缓存仍从磁盘恢复两轮思考',
      reopened.indexOf('检查过程：' + FIRST_REPLY) !== -1 && reopened.indexOf('检查过程：' + SECOND_REPLY) !== -1)
    ok('测试只调用了两次本机模型替身', modelRequests.length === 2)
    await driver.input('#input', LARGE_CANCEL_TEXT)
    await driver.click('#send')
    await waitFor(() => modelRequests.length === 3, '超过旧 1MB 限额的请求正确到达模型并挂起')
    ok('大于 1MB 的聊天载荷正确送达后端，界面原文完整保留', await driver.evaluate('currentSession().messages.some(m => m.content === ' + JSON.stringify(LARGE_CANCEL_TEXT) + ')'))
    ok('模型请求继续遵循既有单条消息长度限额', modelRequests[2].messages.some(m => typeof m.content === 'string' && m.content.startsWith('取消进行中的测试请求') && m.content.length >= 60000))
    await waitFor(() => driver.evaluate('currentRunning() && document.querySelectorAll(".thinking-active").length > 0'), '真实界面出现思考动画')
    await driver.click('#stop')
    await waitFor(() => driver.evaluate('!currentRunning() && document.querySelectorAll(".thinking-active").length === 0 && state.waitingTimer === null'), '停止后思考动画和等待定时器清零')
    const stopped = await waitFor(async () => {
      const response = await request('GET', base + '/api/state')
      return response.data.running === false ? response.data : null
    }, '后端模型请求取消并退出执行')
    const stoppedSnapshot = JSON.parse(fs.readFileSync(path.join(home, 'sessions', sessionId, 'last-session.json'), 'utf8'))
    ok('大载荷含中文的原文完整落盘，没有网络分块解码损坏', stoppedSnapshot.messages.some(m => m.content === LARGE_CANCEL_TEXT))
    ok('真实挂起请求停止后，后端已结束，发送按钮和思考动画保持一致', stopped.runningSessions.length === 0
      && await driver.evaluate('!document.getElementById("send").classList.contains("hidden") && document.querySelectorAll(".thinking-active").length === 0'))

  } catch (error) {
    console.error('FAIL  ' + (error.stack || error))
    if (driver.isOpen) {
      try { console.error('page diagnostics: ' + JSON.stringify(driver.snapshot())) } catch (ignored) {}
    }
    console.error('isolated service log: ' + logs.slice(-2000))
    process.exitCode = 1
  } finally {
    try { await driver.close() } catch (error) {}
    if (browserChild && browserChild.exitCode === null) {
      await waitFor(() => browserChild.exitCode !== null || browserChild.signalCode !== null, '测试浏览器关闭', 6000).catch(() => {
        browserChild.kill('SIGKILL')
      })
    }
    if (service && service.exitCode === null) {
      service.kill('SIGTERM')
      await waitFor(() => service.exitCode !== null || service.signalCode !== null, '隔离服务关闭', 6000).catch(() => service.kill('SIGKILL'))
    }
    for (const reply of replies) {
      try { reply('cleanup') } catch (error) {}
    }
    await new Promise((resolve) => model.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log('first chat e2e: ' + passed + ' checks passed' + (process.exitCode ? ', FAILED' : '') + ', node ' + process.version)
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
