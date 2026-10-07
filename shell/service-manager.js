'use strict'

/**
 * 本地 agent 服务的端口协商与生命周期管理。
 *
 * 不依赖 Electron，只用 Node 内置模块，方便单独跑冒烟测试。
 * 运行时上限 Node 16.17.1：不使用 fetch / structuredClone / AbortSignal 超时等新 API。
 *
 * 端口策略（桌面版双击启动时）：
 *   1. 端口空闲            -> 用它启动服务
 *   2. 端口上是我们自己的服务 -> 复用，不重复启动（用户手动常驻的服务不受影响）
 *   3. 端口被别的程序占用  -> 顺延到下一个候选端口
 *   4. 候选端口全被占       -> 返回 null，由上层显示明确错误
 */

const http = require('http')
const net = require('net')
const { spawn } = require('child_process')

const SERVICE_ID = 'dsh-agent-service'
const DEFAULT_BASE_PORT = 8080
const DEFAULT_MAX_PORT = 8099
const DEFAULT_PROBE_TIMEOUT = 400
const DEFAULT_READY_TIMEOUT = 20000
const READY_INTERVAL = 250
const HEALTH_PATH = '/api/health'
// 服务启动成功时在 stdout 打印的握手行，用于拿到端口顺延后的真实端口
const LISTEN_PATTERN = /\[agent-service\] listening on https?:\/\/[^\s:]+:(\d+)/

const not = (value) => value ? false : true

function toPort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 0
  return port
}

/** 端口上是否有进程在监听（TCP 层面，不关心对方是不是 HTTP）。 */
function isPortListening(port, timeout) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch (error) {}
      resolve(value)
    }
    const socket = net.connect({ host: '127.0.0.1', port: toPort(port) })
    socket.setTimeout(timeout || DEFAULT_PROBE_TIMEOUT)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 向端口上的服务要一次 /api/health，成功则返回解析后的对象，否则返回 null。 */
function fetchHealth(port, timeout) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request = null
    try {
      request = http.request({
        host: '127.0.0.1',
        port: toPort(port),
        path: HEALTH_PATH,
        method: 'GET',
        timeout: timeout || DEFAULT_PROBE_TIMEOUT,
        headers: { accept: 'application/json' }
      }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          if (body.length < 8192) body += chunk
        })
        response.on('end', () => {
          if (response.statusCode !== 200) return finish(null)
          try {
            const parsed = JSON.parse(body)
            if (!parsed || typeof parsed !== 'object') return finish(null)
            finish(parsed)
          } catch (error) {
            finish(null)
          }
        })
        response.on('error', () => finish(null))
      })
    } catch (error) {
      finish(null)
      return
    }
    request.on('timeout', () => {
      try { request.destroy() } catch (error) {}
      finish(null)
    })
    request.on('error', () => finish(null))
    request.end()
  })
}

/**
 * 判断端口状态。
 * @returns {Promise<'free'|'ours'|'other'>}
 */
async function probePort(port, options) {
  const settings = options || {}
  if (not(toPort(port))) return 'free'
  const listening = await isPortListening(port, settings.probeTimeout)
  if (!listening) return 'free'
  const health = await fetchHealth(port, settings.probeTimeout)
  if (health && health.app === SERVICE_ID) return 'ours'
  return 'other'
}

/**
 * 生成候选端口列表：优先用户上次用过的端口，然后从 basePort 递增到 maxPort。
 */
function buildCandidates(preferred, options) {
  const settings = options || {}
  const basePort = toPort(settings.basePort) || DEFAULT_BASE_PORT
  const maxPort = toPort(settings.maxPort) || DEFAULT_MAX_PORT
  const list = []
  const push = (value) => {
    const port = toPort(value)
    if (not(port)) return
    if (list.indexOf(port) === -1) list.push(port)
  }
  push(preferred)
  // 默认端口永远进候选，即使 base/max 配置写反也不会得到空列表
  push(basePort)
  for (let port = basePort + 1; port <= maxPort; port += 1) push(port)
  return list
}

/**
 * 按优先级挑一个可用端口。
 * @returns {Promise<{port:number, reuse:boolean}|null>} reuse=true 表示复用已有服务
 */
async function pickPort(preferred, options) {
  const settings = options || {}
  const candidates = settings.candidates || buildCandidates(preferred, settings)
  const results = []
  for (const port of candidates) {
    const kind = await probePort(port, settings)
    results.push({ port, kind })
    if (kind === 'ours') return { port, reuse: true, kind, probes: results }
    if (kind === 'free') return { port, reuse: false, kind, probes: results }
    // other -> 被别的程序占用，试下一个
  }
  return null
}

/**
 * 拉起本地服务进程。
 * 关键点：用 Shell 自己的 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 当 Node 用，
 * 所以整个包只需要一份运行时，不需要第二个可执行文件。
 */
function spawnService(options) {
  const settings = options || {}
  const env = Object.assign({}, process.env, {
    PORT: String(toPort(settings.port) || DEFAULT_BASE_PORT),
    HOST: settings.host || '127.0.0.1',
    ELECTRON_RUN_AS_NODE: '1'
  })
  if (settings.agentHome) env.AGENT_HOME = settings.agentHome

  const child = spawn(settings.execPath, [settings.scriptPath], {
    env,
    cwd: settings.cwd || undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows 下避免弹出控制台黑窗
    windowsHide: true,
    detached: false
  })

  const state = {
    child,
    port: toPort(settings.port) || DEFAULT_BASE_PORT,
    announcedPort: 0,
    exited: false,
    exitCode: null,
    exitSignal: null,
    stderrTail: '',
    stdoutTail: ''
  }

  if (child.stdout) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      state.stdoutTail = (state.stdoutTail + chunk).slice(-4000)
      const match = LISTEN_PATTERN.exec(chunk)
      if (match) state.announcedPort = toPort(match[1])
    })
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      state.stderrTail = (state.stderrTail + chunk).slice(-4000)
    })
  }
  child.on('error', (error) => {
    state.exited = true
    state.spawnError = error && error.message ? error.message : String(error)
  })
  child.on('exit', (code, signal) => {
    state.exited = true
    state.exitCode = code
    state.exitSignal = signal
  })

  return state
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询 /api/health 直到服务就绪。
 * @returns {Promise<{ok:boolean, port:number, reason?:string, detail?:string}>}
 */
async function waitReady(port, options) {
  const settings = options || {}
  const timeout = settings.readyTimeout || DEFAULT_READY_TIMEOUT
  const deadline = Date.now() + timeout
  let target = toPort(port) || DEFAULT_BASE_PORT

  while (Date.now() < deadline) {
    // 端口顺延：以服务自报的端口为准
    const state = settings.state
    if (state && toPort(state.announcedPort) && state.announcedPort !== target) {
      target = state.announcedPort
    }
    const health = await fetchHealth(target, settings.probeTimeout)
    if (health && health.app === SERVICE_ID) {
      return { ok: true, port: target, health }
    }
    if (state && state.exited) {
      return {
        ok: false,
        port: target,
        reason: 'service-exited',
        detail: state.spawnError || state.stderrTail || ('exit code ' + state.exitCode)
      }
    }
    await delay(READY_INTERVAL)
  }
  return {
    ok: false,
    port: target,
    reason: 'timeout',
    detail: (settings.state && settings.state.stderrTail) || ''
  }
}

/**
 * 关闭由本次启动的服务：先请求优雅退出，超时再强杀。
 * 复用别人启动的服务时不要调用这个函数。
 */
async function stopService(state, options) {
  const settings = options || {}
  if (not(state)) return { ok: true, stopped: false }
  const child = state.child
  if (not(child) || state.exited) return { ok: true, stopped: false }

  const port = toPort(state.announcedPort) || toPort(state.port)
  let graceful = false
  if (toPort(port)) {
    graceful = await requestShutdown(port, settings.probeTimeout)
  }
  const graceMs = settings.graceMs || 2000
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (state.exited) return { ok: true, stopped: true, graceful }
    await delay(100)
  }
  try {
    child.kill()
  } catch (error) {}
  await delay(300)
  return { ok: true, stopped: true, graceful, killed: true }
}

/** 请求服务优雅退出（仅本机回环可调用）。 */
function requestShutdown(port, timeout) {
  return new Promise((resolve) => {
    let request = null
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      request = http.request({
        host: '127.0.0.1',
        port: toPort(port),
        path: '/api/shutdown',
        method: 'POST',
        timeout: timeout || DEFAULT_PROBE_TIMEOUT,
        headers: { 'content-length': 0 }
      }, (response) => {
        response.resume()
        response.on('end', () => finish(response.statusCode === 200))
        response.on('error', () => finish(false))
      })
    } catch (error) {
      finish(false)
      return
    }
    request.on('timeout', () => {
      try { request.destroy() } catch (error) {}
      finish(false)
    })
    request.on('error', () => finish(false))
    request.end()
  })
}

/** 兜底：按端口杀掉监听进程（Windows 用 taskkill，类 Unix 用 lsof + kill）。 */
function killByPort(port) {
  return new Promise((resolve) => {
    const target = toPort(port)
    if (not(target)) return resolve(false)
    const { execFile } = require('child_process')
    if (process.platform === 'win32') {
      // shell:true 让 Windows 走 cmd.exe
      execFile('cmd', ['/c', 'netstat -ano | findstr :' + target], { shell: true, timeout: 5000 }, (error, stdout) => {
        if (error || not(stdout)) return resolve(false)
        const pids = []
        String(stdout).split('\n').forEach((line) => {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (/^\d+$/.test(pid) && pids.indexOf(pid) === -1) pids.push(pid)
        })
        if (pids.length === 0) return resolve(false)
        execFile('taskkill', ['/F', '/PID', pids[0]], { shell: true, timeout: 5000 }, () => resolve(true))
      })
      return
    }
    execFile('lsof', ['-ti', 'tcp:' + target, '-sTCP:LISTEN'], { timeout: 5000 }, (error, stdout) => {
      if (error || not(stdout)) return resolve(false)
      const pid = String(stdout).trim().split('\n')[0].trim()
      if (not(/^\d+$/.test(pid))) return resolve(false)
      execFile('kill', ['-9', pid], { timeout: 5000 }, () => resolve(true))
    })
  })
}

module.exports = {
  SERVICE_ID,
  DEFAULT_BASE_PORT,
  DEFAULT_MAX_PORT,
  healthUrl: (port) => 'http://127.0.0.1:' + (toPort(port) || DEFAULT_BASE_PORT) + HEALTH_PATH,
  isPortListening,
  fetchHealth,
  probePort,
  buildCandidates,
  pickPort,
  spawnService,
  waitReady,
  stopService,
  requestShutdown,
  killByPort,
  toPort
}
