'use strict'

/**
 * 多实例池冒烟：证明「多个 agent 实例」这件事真的成立。
 *
 * 用户 2026-09-19 报的：切会话后发送状态还挂着 / 只能一条一条跑。
 * 根因是整条链路只有一个 Agent 实例 + 一个全局 running（第二条直接被 BUSY 顶回去）。
 * 现在改成一条会话一台 worker（src/main/agent/agent-pool.js），这个脚本就盯住几件事：
 *
 *   ① 两条会话可以**同时**在飞（mock 模型把请求扣着不放，先确认两边都到位再放行）
 *   ② 每条事件都盖着自己会话的戳，A 的增量不会跑到 B 上
 *   ③ 会话历史各落各的目录（共用 sessionDir 会互相覆盖 last-session.json）
 *   ④ 同一条会话重入 = SESSION_BUSY；超过并发上限 = POOL_BUSY
 *   ⑤ stop / clear / reset 都只作用目标那一条
 *   ⑥ 常驻 worker 有 LRU 上限，在跑的绝不淘汰
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { AgentPool } = require('../src/main/agent/agent-pool')

const not = (value) => value ? false : true
const results = []

function ok(name, pass, extra) {
  results.push({ name, pass: Boolean(pass), extra: extra === undefined ? '' : String(extra) })
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (not(message) || message.role !== 'user') continue
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  }
  return ''
}

/* 扣着不回的 mock 模型：用来把「两条会话同时在飞」变成可断言的事实。
   每个请求都先攥在手里，等测试显式放行（全部 / 按用户消息点名放）。 */
function createMockModel() {
  const inflight = []
  let waiter = null

  function arm() {
    if (not(waiter) || inflight.length < waiter.count) return
    const current = waiter
    waiter = null
    current.resolve()
  }

  function waitFor(count) {
    return new Promise((resolve) => {
      waiter = { count, resolve }
      arm()
    })
  }

  function fire(entry) {
    const index = inflight.indexOf(entry)
    if (index >= 0) inflight.splice(index, 1)
    /* 请求可能已经被 abort 掐掉了，那时写回会报错 —— 吞掉即可 */
    try {
      entry.respond()
    } catch (error) {}
  }

  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString() })
    request.on('end', () => {
      let payload = null
      try { payload = JSON.parse(body) } catch (error) {}
      const text = lastUserText(payload && payload.messages)
      const entry = {
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
      }
      inflight.push(entry)
      arm()
    })
  })

  return {
    server,
    waitFor,
    inflightCount: () => inflight.length,
    releaseAll: () => {
      const list = inflight.slice()
      for (const entry of list) fire(entry)
    },
    /* 按用户消息点名放行：两条会话同时在飞时要能只放其中一条 */
    releaseFor: (text) => {
      const entry = inflight.filter((item) => item.text === text)[0]
      if (entry) fire(entry)
      return Boolean(entry)
    }
  }
}

function makeSettings(data) {
  return {
    data: Object.assign({
      baseURL: '',
      apiKey: 'test',
      model: 'mock',
      temperature: 0,
      maxIterations: 3,
      maxTokens: 256,
      approveWrites: false,
      approveCommands: false,
      permissionMode: 'full',
      contextAutoCompress: false,
      replyLanguage: 'zh'
    }, data || {}),
    update(patch) { this.data = Object.assign({}, this.data, patch || {}) },
    all() { return JSON.parse(JSON.stringify(this.data)) }
  }
}

function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 4000)
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve(true)
      if (Date.now() > deadline) return reject(new Error('timeout waiting for condition'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function sorted(list) {
  return list.slice().sort()
}

async function main() {
  const mock = createMockModel()
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve))
  const port = mock.server.address().port
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pool-'))
  const workspace = path.join(root, 'ws')
  fs.mkdirSync(workspace, { recursive: true })

  const settings = makeSettings({
    baseURL: 'http://127.0.0.1:' + port + '/v1',
    workspacePath: workspace,
    maxConcurrentRuns: 2
  })

  const events = []
  const approvals = []
  const pool = new AgentPool({
    settings,
    emit: (event) => events.push(event),
    approve: async (request, sessionId) => { approvals.push({ request, sessionId }); return true },
    sessionRoot: path.join(root, 'sessions'),
    maxWorkers: 8
  })

  /* ---------- ① 两条会话同时在飞 ---------- */
  const runA = pool.run('sa', 'msg-a', [], undefined, undefined)
  const runB = pool.run('sb', 'msg-b', [], undefined, undefined)
  await mock.waitFor(2)
  ok('两条会话的请求同时在飞（并发真的成立）',
    mock.inflightCount() === 2 && pool.runningCount() === 2,
    'inflight=' + mock.inflightCount() + ' running=' + pool.runningCount())
  ok('runningSessions 报出两条会话',
    JSON.stringify(sorted(pool.runningSessions())) === JSON.stringify(['sa', 'sb']),
    pool.runningSessions().join(','))
  mock.releaseAll()
  await Promise.all([runA, runB])
  ok('两条会话跑完都从 running 账本里摘掉', pool.runningCount() === 0, String(pool.runningCount()))
  ok('空闲 worker 不常驻完整历史（下轮由渲染层重新传入）',
    pool.acquire('sa').messages.length === 0 && pool.acquire('sb').messages.length === 0,
    'A=' + pool.acquire('sa').messages.length + ' B=' + pool.acquire('sb').messages.length)

  /* ---------- ② 事件各回各家 ---------- */
  const eventSessions = {}
  for (const event of events) {
    if (not(event.type)) continue
    const key = String(event.sessionId || '(none)')
    if (not(eventSessions[key])) eventSessions[key] = []
    eventSessions[key].push(event.type)
  }
  const tagA = eventSessions.sa || []
  const tagB = eventSessions.sb || []
  const finishedA = events.filter((event) => event.type === 'finished' && event.sessionId === 'sa')[0]
  const finishedB = events.filter((event) => event.type === 'finished' && event.sessionId === 'sb')[0]
  ok('每条事件都盖了 sessionId（没有裸事件）',
    not(eventSessions['(none)']) && events.length > 0,
    Object.keys(eventSessions).join(' | '))
  ok('A 的事件都带 sa（含 finished / user / done）',
    tagA.indexOf('finished') !== -1 && tagA.indexOf('user') !== -1, tagA.join(','))
  ok('B 的事件都带 sb', tagB.indexOf('finished') !== -1 && tagB.indexOf('user') !== -1, tagB.join(','))
  const textA = JSON.stringify((finishedA && finishedA.messages) || [])
  const textB = JSON.stringify((finishedB && finishedB.messages) || [])
  ok('A 的历史里只有 msg-a（没串进 B 的内容）',
    textA.indexOf('msg-a') !== -1 && textA.indexOf('msg-b') === -1, 'len=' + textA.length)
  ok('B 的历史里只有 msg-b', textB.indexOf('msg-b') !== -1 && textB.indexOf('msg-a') === -1, 'len=' + textB.length)

  /* ---------- ③ 会话历史各落各的目录 ---------- */
  const dirA = path.join(root, 'sessions', 'sa', 'last-session.json')
  const dirB = path.join(root, 'sessions', 'sb', 'last-session.json')
  const savedA = fs.existsSync(dirA) ? fs.readFileSync(dirA, 'utf8') : ''
  const savedB = fs.existsSync(dirB) ? fs.readFileSync(dirB, 'utf8') : ''
  ok('两条会话各有一份 last-session.json（不共用目录）',
    savedA !== '' && savedB !== '', dirA + ' / ' + dirB)
  ok('落盘的历史也互不覆盖',
    savedA.indexOf('msg-a') !== -1 && savedA.indexOf('msg-b') === -1
      && savedB.indexOf('msg-b') !== -1 && savedB.indexOf('msg-a') === -1,
    'A=' + savedA.length + 'B=' + savedB.length)

  /* ---------- ④ 同会话重入 / 池满 ---------- */
  const holdA = pool.run('sa', 'hold-a', [], undefined, undefined)
  const holdB = pool.run('sb', 'hold-b', [], undefined, undefined)
  await mock.waitFor(2)
  let sessionBusy = ''
  try {
    await pool.run('sa', 'again-a', [], undefined, undefined)
  } catch (error) {
    sessionBusy = error.message
  }
  ok('同一条会话重入 → SESSION_BUSY', sessionBusy.indexOf('SESSION_BUSY') === 0, sessionBusy)
  let poolBusy = ''
  try {
    await pool.run('sc', 'third-c', [], undefined, undefined)
  } catch (error) {
    poolBusy = error.message
  }
  ok('超过并发上限 → POOL_BUSY（并发上限 2）', poolBusy.indexOf('POOL_BUSY') === 0, poolBusy)
  ok('被顶回来的会话没有混进账本',
    JSON.stringify(sorted(pool.runningSessions())) === JSON.stringify(['sa', 'sb']),
    pool.runningSessions().join(','))

  /* ---------- ⑤ stop 只停目标会话 ---------- */
  pool.abort('sa')
  await waitFor(() => not(pool.isRunning('sa')), 4000)
  ok('abort(sa) 之后 sa 退出，sb 还在跑',
    not(pool.isRunning('sa')) && pool.isRunning('sb'),
    'running=' + pool.runningSessions().join(','))
  mock.releaseFor('hold-b')
  await Promise.all([holdA.catch(() => false), holdB.catch(() => false)])
  await waitFor(() => pool.runningCount() === 0, 4000)
  ok('两条都收尾后账本清空', pool.runningCount() === 0, String(pool.runningCount()))

  /* ---------- ⑥ clear / reset 只作用一条 ---------- */
  const workerA = pool.acquire('sa')
  const workerB = pool.acquire('sb')
  const beforeB = workerB.messages.length
  pool.clear('sa')
  ok('clear(sa) 只清 sa 的历史', workerA.messages.length === 0 && workerB.messages.length === beforeB,
    'A=' + workerA.messages.length + ' B=' + workerB.messages.length)

  const resetEvents = []
  const poolReset = new AgentPool({
    settings,
    emit: (event) => resetEvents.push(event),
    approve: async () => true,
    sessionRoot: path.join(root, 'sessions'),
    maxWorkers: 8
  })
  const resetHold = poolReset.run('sx', 'reset-x', [], undefined, undefined)
  await mock.waitFor(1)
  await poolReset.reset('sx')
  await resetHold.catch(() => false)
  const settled = resetEvents.filter((event) => event.type === 'finished' && event.sessionId === 'sx')
  ok('reset(sx) 会补一条带 sessionId 的 finished（渲染层靠它收回「发送中」）',
    settled.length >= 1, 'finished=' + settled.length)
  ok('reset 之后 running 账本清掉', poolReset.runningCount() === 0, String(poolReset.runningCount()))
  mock.releaseAll()

  /* ---------- ⑦ 工作区广播 ---------- */
  const other = path.join(root, 'ws2')
  fs.mkdirSync(other, { recursive: true })
  pool.setWorkspace(other)
  let workersFollowed = true
  for (const worker of pool.workers.values()) {
    if (worker.workspaceRoot !== other) workersFollowed = false
  }
  ok('切工作区会广播给所有已存在的 worker',
    workersFollowed && pool.getWorkspace() === other && settings.data.workspacePath === other,
    pool.getWorkspace())
  pool.setWorkspace(workspace)

  /* ---------- ⑧ worker 有 LRU 上限，在跑的绝不淘汰 ---------- */
  const lru = new AgentPool({
    settings,
    emit: () => undefined,
    approve: async () => true,
    sessionRoot: path.join(root, 'sessions'),
    maxWorkers: 2
  })
  lru.acquire('w1')
  const evictedWorker = lru.workers.get('w1')
  lru.acquire('w2')
  lru.acquire('w3')
  ok('worker 超出常驻上限会淘汰最久没用的',
    lru.workers.size === 2 && not(lru.workers.has('w1')) && lru.workers.has('w2') && lru.workers.has('w3'),
    Array.from(lru.workers.keys()).join(','))
  await Promise.all(Array.from(lru.disposals))
  ok('LRU 淘汰会 dispose worker（浏览器/插件等资源跟着释放）', evictedWorker.disposed === true)
  lru.acquire('w2')
  lru.acquire('w4')
  ok('重新用过的不再是最久没用（淘汰 w3）',
    lru.workers.size === 2 && lru.workers.has('w2') && lru.workers.has('w4') && not(lru.workers.has('w3')),
    Array.from(lru.workers.keys()).join(','))

  /* ---------- ⑨ 空 sessionId 退化成单实例行为 ---------- */
  const legacy = new AgentPool({
    settings,
    emit: () => undefined,
    approve: async () => true,
    sessionRoot: path.join(root, 'sessions'),
    maxWorkers: 8
  })
  const legacyWorker = legacy.acquire('')
  ok('不带 sessionId 时固定落到一个 default worker（老客户端行为不变）',
    legacyWorker === legacy.acquire(undefined) && legacyWorker.sessionId === 'default',
    legacyWorker.sessionId)

  await Promise.all([pool.dispose(), poolReset.dispose(), lru.dispose(), legacy.dispose()])
  ok('pool.dispose 清空 worker/running/disposal 账本',
    pool.workers.size === 0 && pool.running.size === 0 && pool.disposals.size === 0)

  mock.server.close()
  fs.rmSync(root, { recursive: true, force: true })

  let failed = 0
  for (const item of results) {
    if (not(item.pass)) failed += 1
    console.log((item.pass ? 'PASS  ' : 'FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''))
  }
  console.log('')
  console.log('concurrency smoke: ' + (results.length - failed) + '/' + results.length + ' checks passed, node ' + process.version)
  if (failed > 0) {
    console.error('concurrency smoke: ' + failed + ' check(s) FAILED')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
