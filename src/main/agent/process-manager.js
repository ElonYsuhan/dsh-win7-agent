'use strict'

/**
 * ProcessManager：长驻进程（dev server 之类）的生命周期管理 —— 自我验证闭环的
 * 「起得来、等得准、停得掉」那一半。
 *
 * 为什么需要它：run_command 是前台执行 + 超时（最长 10 分钟），起一个
 * `npm run dev` 之后就没法继续干活、改完也没法重启。这里改成后台 spawn +
 * 名字寻址（start/stop/list/logs），并把 stdout/stderr 收进环形缓冲供模型查阅。
 *
 * 安全边界：
 *   - cwd 必须落在工作区内（复用 path-guard）；
 *   - stop 只允许停自己启动的进程（按 name 查表，不认识的名字直接拒）；
 *   - 服务进程退出时尽力回收自己拉起的子进程（Windows 用 taskkill /T /F 杀树，
 *     POSIX 用进程组 -pid；Win7 没有 job object，只能尽力而为）。
 */

const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { assertInside, relativeDisplay } = require('./path-guard')

const not = (value) => value ? false : true
const MAX_PROCESSES = 8
const MAX_LOG_BYTES = 256 * 1024
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/

function sleep(ms) {
  /* 注意：这里**不能 unref**。杀完子进程后如果没有别的活跃句柄（真实场景就是这样：
     服务已死、只剩等待），unref 的定时器不会把事件循环撑住 → Node 直接以 0 退出，
     stop() 之后的代码永远不执行（冒烟实测：STEP4 不打印、exit=0）。 */
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class ProcessManager {
  constructor(options) {
    this.root = (options && options.workspaceRoot) || ''
    this.maxProcesses = MAX_PROCESSES
    this.procs = new Map() /* name → record {name,pid,child,command,cwd,startedAt,exitCode,endedAt,chunks,bytes,dropped} */
    this.exitHookInstalled = false
  }

  setWorkspace(root) {
    this.root = root || ''
  }

  installExitHook() {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    /* 服务进程退出时尽力回收：node 的 exit 里只能做同步操作 */
    process.on('exit', () => this.killAllSync())
  }

  record(name) {
    const entry = this.procs.get(name)
    if (not(entry)) {
      throw new Error('PROCESS_NOT_FOUND: no process named ' + name)
    }
    return entry
  }

  start(input) {
    const name = String((input && input.name) || '').trim()
    if (not(NAME_PATTERN.test(name))) {
      throw new Error('BAD_PROCESS_NAME: 仅允许字母数字点横线下划线，长度 1-32（收到 "' + name + '"）')
    }
    const existing = this.procs.get(name)
    if (existing && existing.exitCode === null) {
      throw new Error('PROCESS_EXISTS: ' + name + ' 还在跑（pid ' + existing.pid + '），先 stop_process 或换个名字')
    }
    const running = [...this.procs.values()].filter((item) => item.exitCode === null).length
    if (running >= this.maxProcesses) {
      throw new Error('PROCESS_LIMIT: 同时最多 ' + this.maxProcesses + ' 个后台进程')
    }
    const command = String((input && input.command) || '').trim()
    if (command.length === 0) {
      throw new Error('EMPTY_COMMAND')
    }
    const cwd = this.root ? assertInside(this.root, (input && input.cwd) || '.', 'cwd') : ((input && input.cwd) || process.cwd())
    const env = Object.assign({}, process.env, {
      /* 后台服务通常需要看到实时的输出，别让子进程缓冲 */
      NODE_ENV: (input && input.env && input.env.NODE_ENV) || process.env.NODE_ENV || 'development',
      FORCE_COLOR: '0',
      NO_COLOR: '1'
    })
    if (input && input.env && typeof input.env === 'object') Object.assign(env, input.env)
    const child = spawn(command, [], {
      cwd: cwd,
      shell: true,
      windowsHide: true,
      env: env,
      detached: process.platform !== 'win32' /* POSIX 下建进程组，便于整组回收 */
    })
    const entry = {
      name: name,
      pid: child.pid,
      child: child,
      command: command,
      cwd: this.root ? relativeDisplay(this.root, cwd) : cwd,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      endedAt: 0,
      chunks: [],
      bytes: 0,
      droppedBytes: 0,
      stoppedByUs: false
    }
    const append = (chunk) => {
      const text = chunk.toString()
      entry.chunks.push(text)
      entry.bytes += Buffer.byteLength(text)
      while (entry.bytes > MAX_LOG_BYTES && entry.chunks.length > 1) {
        const removed = entry.chunks.shift()
        entry.bytes -= Buffer.byteLength(removed)
        entry.droppedBytes += Buffer.byteLength(removed)
      }
    }
    /* 同 llm.js：必须先 setEncoding，否则子进程输出的中文被 chunk 切断时
       会解出 U+FFFD（命令结果里出现黑菱形）。 */
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => {
      append('[spawn error] ' + String(error && error.message))
      entry.exitCode = entry.exitCode === null ? -1 : entry.exitCode
      entry.endedAt = Date.now()
    })
    child.on('exit', (code, signal) => {
      entry.exitCode = code === null ? -1 : code
      entry.signal = signal || null
      entry.endedAt = Date.now()
      append('\n[process exited] code=' + entry.exitCode + (signal ? ' signal=' + signal : ''))
    })
    this.procs.set(name, entry)
    this.installExitHook()
    return {
      name: name,
      pid: entry.pid,
      command: command,
      cwd: entry.cwd,
      note: 'started in background — use wait_ready to wait for the port/url, process_logs to read output'
    }
  }

  killTree(pid, signal) {
    if (process.platform === 'win32') {
      /* Windows：taskkill /T 连子进程树一起；shell:true 起的 cmd.exe 会留孤儿 */
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      return result && result.status === 0
    }
    try {
      process.kill(-pid, signal || 'SIGTERM')
      return true
    } catch (error) {
      try {
        process.kill(pid, signal || 'SIGTERM')
        return true
      } catch (inner) {
        return false
      }
    }
  }

  async stop(name) {
    const entry = this.record(String(name || ''))
    if (entry.exitCode !== null) {
      return { name: entry.name, alreadyExited: true, exitCode: entry.exitCode }
    }
    entry.stoppedByUs = true
    this.killTree(entry.pid, 'SIGTERM')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && entry.exitCode === null) {
      await sleep(100)
    }
    if (entry.exitCode === null) {
      this.killTree(entry.pid, 'SIGKILL')
      const hard = Date.now() + 2000
      while (Date.now() < hard && entry.exitCode === null) {
        await sleep(100)
      }
    }
    return { name: entry.name, stopped: entry.exitCode !== null, exitCode: entry.exitCode }
  }

  async stopAll() {
    const names = [...this.procs.keys()]
    const results = []
    for (const name of names) {
      results.push(await this.stop(name).catch((error) => ({ name: name, error: String(error.message) })))
    }
    return results
  }

  /* exit 钩子里只能同步做 */
  killAllSync() {
    for (const entry of this.procs.values()) {
      if (entry.exitCode !== null) continue
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true })
        } else {
          process.kill(-entry.pid, 'SIGKILL')
        }
      } catch (error) { /* 尽力而为 */ }
    }
  }

  list() {
    return [...this.procs.values()].map((entry) => ({
      name: entry.name,
      pid: entry.pid,
      running: entry.exitCode === null,
      exitCode: entry.exitCode,
      command: entry.command,
      cwd: entry.cwd,
      uptimeMs: (entry.endedAt || Date.now()) - entry.startedAt
    }))
  }

  logs(name, options) {
    const entry = this.record(String(name || ''))
    const settings = options || {}
    let text = entry.chunks.join('')
    if (entry.droppedBytes > 0) {
      text = '[...' + entry.droppedBytes + ' bytes dropped from ring buffer...]\n' + text
    }
    if (settings.grep) {
      const lines = text.split(/\r?\n/).filter((line) => line.indexOf(String(settings.grep)) !== -1)
      text = lines.length ? lines.join('\n') : '(no line matched ' + settings.grep + ')'
    }
    if (settings.tail) {
      const lines = text.split(/\r?\n/)
      const count = Math.max(1, Math.min(2000, Number(settings.tail) || 50))
      text = lines.slice(-count).join('\n')
    }
    return {
      name: entry.name,
      running: entry.exitCode === null,
      exitCode: entry.exitCode,
      bytes: entry.bytes,
      text: text
    }
  }
}

/**
 * 等服务就绪：url 走 HTTP（拿到任意响应即算起来，状态码一并带回 —— 区分
 * 「服务没起来」和「服务起来了但接口报错」），port 走 TCP 连通。
 */
async function waitReady(input) {
  const target = input || {}
  const timeoutMs = Math.max(500, Math.min(300000, Number(target.timeoutMs) || 30000))
  const interval = Math.max(100, Math.min(5000, Number(target.intervalMs) || 500))
  const deadline = Date.now() + timeoutMs
  const url = target.url ? String(target.url) : ''
  const port = Number(target.port) || 0
  const host = String(target.host || '127.0.0.1')
  if (not(url) && not(port)) {
    throw new Error('WAIT_READY_NO_TARGET: 传 url 或 port')
  }
  let lastError = ''
  let lastStatus = 0
  const startedAt = Date.now()
  while (Date.now() < deadline) {
    if (url) {
      const outcome = await httpProbe(url, Math.min(4000, Math.max(500, deadline - Date.now()))).catch((error) => ({ error: String(error.message) }))
      if (outcome && outcome.status) {
        return { ready: true, status: outcome.status, elapsedMs: Date.now() - startedAt, url: url }
      }
      lastError = (outcome && outcome.error) || lastError
      lastStatus = (outcome && outcome.status) || 0
    } else {
      const ok = await tcpProbe(host, port, Math.min(3000, Math.max(300, deadline - Date.now())))
      if (ok) {
        return { ready: true, port: port, elapsedMs: Date.now() - startedAt }
      }
      lastError = 'connect failed'
    }
    await sleep(interval)
  }
  return {
    ready: false,
    status: lastStatus,
    elapsedMs: Date.now() - startedAt,
    target: url || (host + ':' + port),
    lastError: lastError,
    note: 'still not ready after ' + timeoutMs + 'ms — check process_logs for startup errors'
  }
}

function httpProbe(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed = null
    try {
      parsed = new URL(url)
    } catch (error) {
      reject(new Error('BAD_URL: ' + url))
      return
    }
    const mod = parsed.protocol === 'https:' ? https : http
    const request = mod.get({
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      timeout: timeoutMs
    }, (response) => {
      response.resume()
      resolve({ status: response.statusCode })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('probe timeout')))
    request.on('error', reject)
  })
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host, port: port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch (error) { /* 已关 */ }
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

module.exports = {
  ProcessManager,
  waitReady,
  MAX_PROCESSES,
  MAX_LOG_BYTES,
  httpProbe,
  tcpProbe
}
