'use strict'

/**
 * 服务端并发端到端冒烟：把真的 `server/index.js` 拉起来，用 HTTP 打它。
 *
 * concurrency-smoke 验的是池子本身；这个脚本验的是**接线**：
 *   /api/chat 带 sessionId → 两条会话真的同时跑、SSE 事件各盖各的戳、
 *   同会话重入 409 SESSION_BUSY、池满 503 POOL_BUSY、/api/state 报 runningSessions。
 *
 * 全程用临时 AGENT_HOME + 随机端口，绝不碰用户常驻的 8080 实例和数据目录。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const not = (value) => value ? false : true
const ROOT = path.resolve(__dirname, '..')
const results = []

function ok(name, pass, extra) {
  results.push({ name, pass: Boolean(pass), extra: extra === undefined ? '' : String(extra) })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/* 扣着不回的 mock 模型：两条会话同时在飞时才放行 */
function createMockModel() {
  const inflight = []
  let waiter = null
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString() })
    request.on('end', () => {
      let payload = null
      try { payload = JSON.parse(body) } catch (error) {}
      const messages = (payload && payload.messages) || []
      let text = ''
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index] && messages[index].role === 'user') {
          text = String(messages[index].content || '')
          break
        }
      }
      inflight.push({
        text,
        respond: () => {
          if (response.destroyed || response.writableEnded) return
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('data: ' + JSON.stringify({
            choices: [{ delta: { content: 'reply:' + text }, finish_reason: 'stop' }]
          }) + '\n\n')
          response.write('data: [DONE]\n\n')
          response.end()
        }
      })
      if (waiter && inflight.length >= waiter.count) {
        const current = waiter
        waiter = null
        current.resolve()
      }
    })
  })
  return {
    server,
    waitFor(count) {
      return new Promise((resolve) => {
        waiter = { count, resolve }
      })
    },
    inflightCount: () => inflight.length,
    releaseAll() {
      const list = inflight.splice(0, inflight.length)
      for (const entry of list) { try { entry.respond() } catch (error) {} }
    }
  }
}

function httpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, Object.assign({ method: 'GET' }, options || {}), (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk.toString() })
      response.on('end', () => {
        let data = null
        try { data = body ? JSON.parse(body) : null } catch (error) { data = body }
        resolve({ status: response.statusCode, body: data })
      })
    })
    request.on('error', reject)
    if (options && options.body) request.write(options.body)
    request.end()
  })
}

/* 注意：判据可能是 async（要发一次 HTTP）。必须 await 结果 ——
   否则返回的 Promise 恒为 truthy，waitFor 会立刻「成功」，等于没等。 */
function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000)
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let value = false
      try { value = await condition() } catch (error) { value = false }
      if (value) return resolve(true)
      if (Date.now() > deadline) return reject(new Error('timeout'))
      setTimeout(tick, 40)
    }
    tick()
  })
}

async function main() {
  const mock = createMockModel()
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.server.address().port

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-server-conc-'))
  const workspace = path.join(home, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    baseURL: 'http://127.0.0.1:' + mockPort + '/v1',
    apiKey: 'test',
    model: 'mock',
    temperature: 0,
    maxIterations: 2,
    permissionMode: 'full',
    workspacePath: workspace,
    contextAutoCompress: false,
    maxConcurrentRuns: 2
  }, null, 2), 'utf8')

  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      AGENT_HOME: home,
      PORT: String(port),
      HOST: '127.0.0.1',
      PORT_MAX_ATTEMPTS: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let serviceLog = ''
  child.stdout.on('data', (chunk) => { serviceLog += chunk.toString() })
  child.stderr.on('data', (chunk) => { serviceLog += chunk.toString() })

  const base = 'http://127.0.0.1:' + port
  const sse = { events: [] }
  let sseRequest = null

  const cleanup = () => {
    try { if (sseRequest) sseRequest.destroy() } catch (error) {}
    try { child.kill('SIGKILL') } catch (error) {}
    try { mock.server.close() } catch (error) {}
    try { fs.rmSync(home, { recursive: true, force: true }) } catch (error) {}
  }

  try {
    /* 等健康检查过（端口就绪） */
    let healthy = false
    for (let attempt = 0; attempt < 60 && not(healthy); attempt += 1) {
      try {
        const ping = await httpRequest(base + '/api/health')
        healthy = ping.status === 200
      } catch (error) {
        healthy = false
      }
      if (not(healthy)) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    ok('服务端起来了（/api/health 200）', healthy, serviceLog.split('\n')[0] || '')
    if (not(healthy)) throw new Error('service did not start: ' + serviceLog)

    /* 挂一条 SSE 收集事件 */
    const sseClient = http.request(base + '/api/events', (response) => {
      response.setEncoding('utf8')
      let buffer = ''
      response.on('data', (chunk) => {
        buffer += chunk
        const parts = buffer.split('\n\n')
        buffer = parts.pop()
        for (const part of parts) {
          const line = part.split('\n').filter((item) => item.indexOf('data: ') === 0)[0]
          if (not(line)) continue
          try { sse.events.push(JSON.parse(line.slice(6))) } catch (error) {}
        }
      })
    })
    sseClient.end()
    sseRequest = sseClient
    await waitFor(() => sse.events.some((event) => event.type === 'status' && event.text === 'connected'), 4000)

    /* ① 两条会话一起打 */
    const post = (payload) => httpRequest(base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const first = await post({ sessionId: 'sess_a', text: 'hello-a', history: [] })
    const second = await post({ sessionId: 'sess_b', text: 'hello-b', history: [] })
    ok('两条会话都受理（202）',
      first.status === 202 && second.status === 202,
      first.status + '/' + second.status)

    await mock.waitFor(2)
    ok('两条会话的模型请求同时在飞', mock.inflightCount() === 2, String(mock.inflightCount()))
    const stateMid = await httpRequest(base + '/api/state')
    const runningMid = (stateMid.body && stateMid.body.runningSessions) || []
    ok('/api/state 报出两条在跑的会话',
      runningMid.length === 2 && runningMid.indexOf('sess_a') !== -1 && runningMid.indexOf('sess_b') !== -1,
      runningMid.join(','))
    ok('/api/state 带上并发上限', stateMid.body && stateMid.body.maxConcurrentRuns === 2,
      String(stateMid.body && stateMid.body.maxConcurrentRuns))

    /* ② 同会话重入 / 池满 */
    const again = await post({ sessionId: 'sess_a', text: 'again', history: [] })
    ok('同一条会话重入 → 409 SESSION_BUSY',
      again.status === 409 && again.body && again.body.error === 'SESSION_BUSY',
      again.status + ' ' + JSON.stringify(again.body))
    const third = await post({ sessionId: 'sess_c', text: 'third', history: [] })
    ok('并发上限 2 时第三条 → 503 POOL_BUSY',
      third.status === 503 && third.body && third.body.error === 'POOL_BUSY',
      third.status + ' ' + JSON.stringify(third.body))

    /* ③ 放行，等两条收尾 */
    mock.releaseAll()
    await waitFor(() => {
      const done = sse.events.filter((event) => event.type === 'finished')
      return done.length >= 2
    }, 10000)
    const finished = sse.events.filter((event) => event.type === 'finished')
    ok('两条会话各自收到 finished（各带自己的 sessionId）',
      finished.length === 2
        && finished.some((event) => event.sessionId === 'sess_a')
        && finished.some((event) => event.sessionId === 'sess_b'),
      finished.map((event) => event.sessionId).join(','))

    const tagged = sse.events.filter((event) => event.type !== 'status' || event.sessionId)
    const untagged = tagged.filter((event) => not(event.sessionId))
    ok('会话级事件都盖了 sessionId（没有裸事件）',
      untagged.length === 0, untagged.map((event) => event.type).join(','))

    const finishedA = finished.filter((event) => event.sessionId === 'sess_a')[0] || { messages: [] }
    const finishedB = finished.filter((event) => event.sessionId === 'sess_b')[0] || { messages: [] }
    const textA = JSON.stringify(finishedA.messages || [])
    const textB = JSON.stringify(finishedB.messages || [])
    ok('两条会话的历史没串（A 里没有 B 的内容）',
      textA.indexOf('hello-a') !== -1 && textA.indexOf('hello-b') === -1
        && textB.indexOf('hello-b') !== -1 && textB.indexOf('hello-a') === -1,
      'A=' + textA.length + ' B=' + textB.length)

    /* ④ 会话历史各落各的子目录 */
    const dirA = path.join(home, 'sessions', 'sess_a', 'last-session.json')
    const dirB = path.join(home, 'sessions', 'sess_b', 'last-session.json')
    ok('两条会话的历史各落各的目录（不互相覆盖）',
      fs.existsSync(dirA) && fs.existsSync(dirB),
      fs.existsSync(dirA) + '/' + fs.existsSync(dirB))

    const stateEnd = await httpRequest(base + '/api/state')
    ok('跑完之后账本清空', (stateEnd.body && stateEnd.body.runningSessions || []).length === 0,
      JSON.stringify(stateEnd.body && stateEnd.body.runningSessions))

    /* ⑤ 只停一条：两条同时在跑，stop(sess_a) 后 b 还在 */
    const hold1 = await post({ sessionId: 'sess_a', text: 'stop-me', history: [] })
    const hold2 = await post({ sessionId: 'sess_b', text: 'keep-me', history: [] })
    ok('重新起两条会话（202）', hold1.status === 202 && hold2.status === 202,
      hold1.status + '/' + hold2.status)
    await mock.waitFor(2)
    await httpRequest(base + '/api/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess_a' })
    })
    await waitFor(async () => {
      const snapshot = await httpRequest(base + '/api/state')
      return (snapshot.body.runningSessions || []).indexOf('sess_a') === -1
    }, 6000).catch(() => false)
    const afterStop = await httpRequest(base + '/api/state')
    const stillRunning = (afterStop.body && afterStop.body.runningSessions) || []
    ok('/api/stop 带 sessionId 只停那一条（sess_b 还在跑）',
      stillRunning.indexOf('sess_a') === -1 && stillRunning.indexOf('sess_b') !== -1,
      stillRunning.join(','))
    mock.releaseAll()
    await waitFor(async () => {
      const snapshot = await httpRequest(base + '/api/state')
      return (snapshot.body.runningSessions || []).length === 0
    }, 8000).catch(() => false)
    const drained = await httpRequest(base + '/api/state')
    ok('两条都收尾后账本彻底清空',
      (drained.body && drained.body.runningSessions || []).length === 0,
      JSON.stringify(drained.body && drained.body.runningSessions))

    /* ⑥ 不带 sessionId 的老客户端仍然能跑（退化路径） */
    const legacy = await post({ text: 'legacy-client', history: [] })
    ok('不带 sessionId 的老客户端也受理（202）', legacy.status === 202, String(legacy.status))
    await mock.waitFor(1)
    mock.releaseAll()
    await waitFor(async () => {
      const snapshot = await httpRequest(base + '/api/state')
      return (snapshot.body.runningSessions || []).length === 0
    }, 8000).catch(() => false)
    ok('老客户端跑在 default 那台 worker 上',
      fs.existsSync(path.join(home, 'sessions', 'default', 'last-session.json')),
      'sessions/default')

    /* ⑦ ui-store HTTP 路由（会话记录跟端口解耦的那半边，见 server/ui-store.js）：
       PUT 落盘 ui-store.json、GET 读回一致、坏 JSON 400。 */
    const uiPut = await httpRequest(base + '/api/ui-store', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessions: { __recent__: [{ id: 'u1', scope: 'recent', title: 'ui-store 会话', messages: [] }] },
        currentSessionId: 'u1',
        prefs: { sidebarCollapsed: true }
      })
    })
    ok('PUT /api/ui-store 受理（200 ok）', uiPut.status === 200 && uiPut.body && uiPut.body.ok === true,
      JSON.stringify(uiPut.body))
    const uiGet = await httpRequest(base + '/api/ui-store')
    ok('GET /api/ui-store 读回与写入一致（跟端口无关的那份落了盘）',
      uiGet.status === 200 && uiGet.body.store.sessions.__recent__.length === 1
        && uiGet.body.store.currentSessionId === 'u1'
        && uiGet.body.store.prefs.sidebarCollapsed === true,
      JSON.stringify(uiGet.body.store).slice(0, 100))
    const uiBeacon = await httpRequest(base + '/api/ui-store', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        sessions: { __recent__: [{ id: 'beacon', scope: 'recent', title: '关窗补写', messages: [] }] },
        currentSessionId: 'beacon',
        prefs: {}
      })
    })
    ok('POST /api/ui-store 接受 sendBeacon 关窗补写',
      uiBeacon.status === 200 && uiBeacon.body && uiBeacon.body.ok === true,
      uiBeacon.status + '/' + JSON.stringify(uiBeacon.body))
    ok('ui-store.json 真落在 AGENT_HOME',
      fs.existsSync(path.join(home, 'ui-store.json')))
    const uiBad = await httpRequest(base + '/api/ui-store', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{broken'
    })
    ok('坏 JSON 被 400 挡住（原 store 不动）',
      uiBad.status === 400 && uiBad.body.error === 'BAD_JSON',
      uiBad.status + '/' + JSON.stringify(uiBad.body))
  } finally {
    cleanup()
  }

  let failed = 0
  for (const item of results) {
    if (not(item.pass)) failed += 1
    console.log((item.pass ? 'PASS  ' : 'FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''))
  }
  console.log('')
  console.log('server concurrency smoke: ' + (results.length - failed) + '/' + results.length + ' checks passed, node ' + process.version)
  if (failed > 0) {
    console.error('server concurrency smoke: ' + failed + ' check(s) FAILED')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
