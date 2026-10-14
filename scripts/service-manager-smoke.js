'use strict'

/**
 * 端口协商与本地服务生命周期冒烟测试。
 *
 * 必须在 Node 16.17.1 下跑（Electron 22 内嵌运行时）：
 *   /tmp/node-v16.17.1-darwin-arm64/bin/node scripts/service-manager-smoke.js
 *
 * 覆盖：
 *   A 端口状态判定（空闲 / 我方服务 / 别的 HTTP 服务 / 非 HTTP TCP 服务）
 *   B 端口选择（顺延、复用、全占）
 *   C 候选端口列表构造
 *   D 真起 server/index.js：health 身份标识、端口被占自动顺延、优雅关闭
 */

const assert = require('assert')
const http = require('http')
const net = require('net')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const sm = require('../shell/service-manager')

let passCount = 0
let failCount = 0

function check(name, ok, extra) {
  if (ok) {
    passCount += 1
    console.log('PASS  ' + name + (extra === undefined ? '' : '  [' + extra + ']'))
  } else {
    failCount += 1
    console.log('FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']'))
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 起一个 HTTP 假服务；isOurs=true 时返回我方身份标识。端口用 0 让系统分配，避免撞上用户的服务。 */
function startFakeHttp(isOurs) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url && request.url.indexOf('/api/health') === 0) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(isOurs
          ? { ok: true, app: sm.SERVICE_ID, pid: process.pid }
          : { hello: 'world' }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 起一个监听端口但不讲 HTTP 的 TCP 服务。 */
function startFakeTcp() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on('error', () => {}))
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      server.close(() => finish(true))
    } catch (error) {
      finish(false)
    }
    // 兜底：keep-alive 连接可能让 close 回调迟迟不来，别把测试挂死
    setTimeout(() => finish(false), 1200)
  })
}

function postShutdown(port) {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 2000 }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('timeout', () => { try { request.destroy() } catch (error) {} ; resolve(0) })
    request.on('error', () => resolve(0))
    request.end()
  })
}

async function groupA() {
  const free = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
  check('A1 空闲端口 isPortListening=false', (await sm.isPortListening(free, 400)) === false)
  check('A2 空闲端口 probePort=free', (await sm.probePort(free, { probeTimeout: 400 })) === 'free')

  const ours = await startFakeHttp(true)
  check('A3 我方服务 probePort=ours', (await sm.probePort(ours.port, { probeTimeout: 400 })) === 'ours')

  const other = await startFakeHttp(false)
  check('A4 别的 HTTP 服务 probePort=other', (await sm.probePort(other.port, { probeTimeout: 400 })) === 'other')

  const tcp = await startFakeTcp()
  check('A5 非 HTTP TCP 服务 probePort=other', (await sm.probePort(tcp.port, { probeTimeout: 400 })) === 'other')

  const health = await sm.fetchHealth(ours.port, 400)
  check('A6 fetchHealth 解析出身份标识', !!health && health.app === sm.SERVICE_ID, health && health.app)

  await closeServer(ours.server)
  await closeServer(other.server)
  await closeServer(tcp.server)
}

async function groupB() {
  // B1 首个候选被别的程序占 -> 顺延到下一个空闲端口
  const blocker = await startFakeHttp(false)
  const freeOne = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
  const picked = await sm.pickPort(0, { candidates: [blocker.port, freeOne], probeTimeout: 400 })
  check('B1 被占则顺延到下一个空闲端口', !!picked && picked.port === freeOne && picked.reuse === false,
    picked ? (picked.port + ' reuse=' + picked.reuse) : 'null')

  // B2 首选端口上是我方服务 -> 复用，不重启
  const ours = await startFakeHttp(true)
  const reused = await sm.pickPort(0, { candidates: [ours.port, freeOne], probeTimeout: 400 })
  check('B2 我方服务则复用不重启', !!reused && reused.port === ours.port && reused.reuse === true,
    reused ? (reused.port + ' reuse=' + reused.reuse) : 'null')

  // B3 候选全被别的程序占 -> null（上层显示明确错误）
  const used = await startFakeHttp(false)
  const none = await sm.pickPort(0, { candidates: [blocker.port, used.port], probeTimeout: 400 })
  check('B3 候选全被占返回 null', none === null)

  // B4 优先使用用户上次的端口
  const picked2 = await sm.pickPort(freeOne, { candidates: [freeOne, blocker.port], probeTimeout: 400 })
  check('B4 优先复用上次端口', !!picked2 && picked2.port === freeOne)

  await closeServer(blocker.server)
  await closeServer(ours.server)
  await closeServer(used.server)
}

function groupC() {
  const list = sm.buildCandidates(8085, { basePort: 8080, maxPort: 8084 })
  // 8085 不在 8080..8084 区间内，应被优先保留在最前
  check('C1 首选端口排在最前', list[0] === 8085, JSON.stringify(list))
  const list2 = sm.buildCandidates(8082, { basePort: 8080, maxPort: 8084 })
  check('C2 首选端口与区间去重', JSON.stringify(list2) === JSON.stringify([8082, 8080, 8081, 8083, 8084]),
    JSON.stringify(list2))
  const list3 = sm.buildCandidates(null, { basePort: 8080, maxPort: 8000 })
  check('C3 非法区间不产生垃圾候选', list3.length === 1 && list3[0] === 8080, JSON.stringify(list3))
}

async function groupD() {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-svc-smoke-'))
  const scriptPath = path.join(__dirname, '..', 'server', 'index.js')
  const spawned = []

  const launch = (port, extraEnv) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: Object.assign({}, process.env, {
        PORT: String(port),
        HOST: '127.0.0.1',
        AGENT_HOME: agentHome,
        /* 必须是 '1'。写成空串等于「没开 run-as-node」——Electron 会按 GUI 模式起进程，
           白白拉一个 GPU 子进程；在起不来沙箱的环境里那个 GPU 进程直接 FATAL
           （GPU process isn't usable. Goodbye.），把整个服务进程带走，
           于是 D5「端口被占顺延」会假红：第一个服务莫名死了，第二个当然抢得到同一个端口。
           生产代码 shell/service-manager.js 用的就是 '1'，这里必须和它对得上。 */
        ELECTRON_RUN_AS_NODE: '1'
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const state = { child, port, announcedPort: 0, exited: false, stdoutTail: '', stderrTail: '' }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      state.stdoutTail = (state.stdoutTail + chunk).slice(-4000)
      const match = /\[agent-service\] listening on https?:\/\/[^\s:]+:(\d+)/.exec(chunk)
      if (match) state.announcedPort = Number(match[1])
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { state.stderrTail = (state.stderrTail + chunk).slice(-4000) })
    child.on('exit', (code) => { state.exited = true; state.exitCode = code })
    spawned.push(state)
    return state
  }

  // D1 正常启动：health 带身份标识
  const freePort = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
  const first = launch(freePort)
  const ready = await sm.waitReady(freePort, { readyTimeout: 15000, probeTimeout: 500, state: first })
  check('D1 真实服务就绪', ready.ok === true, ready.reason || ('port ' + ready.port))
  if (ready.ok) {
    const health = await sm.fetchHealth(ready.port, 800)
    check('D2 health 带 app 身份标识', !!health && health.app === sm.SERVICE_ID, health && health.app)
    check('D3 health 带 pid 与 port', !!health && health.pid > 0 && health.port === ready.port,
      health ? ('pid=' + health.pid + ' port=' + health.port) : 'null')
    check('D4 探测判为 ours（可复用）', (await sm.probePort(ready.port, { probeTimeout: 500 })) === 'ours')
  } else {
    check('D2 health 带 app 身份标识', false, 'skipped: not ready')
    check('D3 health 带 pid 与 port', false, 'skipped: not ready')
    check('D4 探测判为 ours（可复用）', false, 'skipped: not ready')
  }

  // D5 端口被占时自动顺延（把已就绪服务的端口再交给一个新实例）
  if (ready.ok) {
    const second = launch(ready.port)
    const ready2 = await sm.waitReady(ready.port + 1, { readyTimeout: 15000, probeTimeout: 500, state: second })
    check('D5 端口被占自动顺延', ready2.ok === true && ready2.port > ready.port,
      'first=' + ready.port + ' second=' + ready2.port + ' reason=' + (ready2.reason || 'ok'))
  } else {
    check('D5 端口被占自动顺延', false, 'skipped: not ready')
  }

  // D6 优雅关闭仅允许回环
  if (ready.ok) {
    const status = await postShutdown(ready.port)
    check('D6 /api/shutdown 回环可用', status === 200, String(status))
    await delay(600)
    const alive = await sm.isPortListening(ready.port, 500)
    check('D7 shutdown 后端口已释放', alive === false)
  } else {
    check('D6 /api/shutdown 回环可用', false, 'skipped: not ready')
    check('D7 shutdown 后端口已释放', false, 'skipped: not ready')
  }

  // D8 stopService 能收掉还没优雅退出的实例
  const freePort3 = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
  const third = launch(freePort3)
  const ready3 = await sm.waitReady(freePort3, { readyTimeout: 15000, probeTimeout: 500, state: third })
  if (ready3.ok) {
    const stopped = await sm.stopService(third, { probeTimeout: 800, graceMs: 2500 })
    check('D8 stopService 收掉服务进程', stopped.stopped === true && third.exited === true,
      'graceful=' + stopped.graceful)
  } else {
    check('D8 stopService 收掉服务进程', false, 'skipped: not ready reason=' + ready3.reason)
  }

  for (const state of spawned) {
    if (state.exited) continue
    try { state.child.kill() } catch (error) {}
    await delay(150)
  }
  try {
    fs.rmSync(agentHome, { recursive: true, force: true })
  } catch (error) {}
}

async function main() {
  console.log('service-manager smoke, node ' + process.version)
  console.log('---')
  await groupA()
  await groupB()
  groupC()
  await groupD()
  console.log('---')
  console.log('service-manager smoke: ' + passCount + '/' + (passCount + failCount) + ' checks passed, node ' + process.version)
  if (failCount > 0) process.exit(1)
}

main().catch((error) => {
  console.error('smoke crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
