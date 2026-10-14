'use strict'

/* 终端会话管理（三期）—— HTTP（web-bridge / 打包壳的渲染层）与 IPC（dev 应用）共用一套。
 *
 * 为什么不用 node-pty：禁原生模块（Win7 硬约束），Win7 也没有 ConPTY。
 * 所以是「管道终端」：spawn 系统 shell、stdio 走管道。日常 cd / ls / cat / git 都能用；
 * 全屏交互程序（vim、top）跑不了 —— 这是平台能力边界，不是 bug。
 *
 * 编码约定：子进程输出按「原始字节」缓冲与转发，UTF-8 / GBK 由渲染层 decodeBytes 解
 * （和文件预览同一条规矩 —— Windows 上 cmd.exe 默认 GBK，服务端不解码）。
 * 渲染层发的输入是 UTF-8 文本，写进 stdin 前 Windows 补 \r\n、其余补 \n。
 *
 * 会话生命周期：服务端常驻（关面板 / 关浏览器不杀），这样「关掉面板再打开历史还在」；
 * 一个服务同时只保留一个会话，start 会顶掉旧的。服务退出时 teardownAll 收尸。
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 输出环形缓冲上限：256KB，防长输出把内存吃爆 */
const BUFFER_MAX_BYTES = 256 * 1024
/** 单次写入上限（渲染层来的命令行） */
const WRITE_MAX_CHARS = 64 * 1024
const TERMINAL_READY_MARKER = '__DSH_CMD_READY__'
const MAX_SESSIONS = 8
const DEAD_SESSION_TTL_MS = 5 * 60 * 1000

const sessions = new Map()
let nextSessionId = 0

const not = (value) => value ? false : true

function pickShell() {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || '/bin/bash'
}

/** GUI 应用（Electron）的 PATH 不含 shell 配置文件里的路径 —— 用户实测
 *  `zsh: command not found: node`（nvm/homebrew 装的工具全瞎）。
 *  又不能 spawn -i（交互 shell 在管道下行为怪），所以把常见 bin 目录补进 PATH。 */
function extraPaths() {
  const home = os.homedir()
  const list = ['/usr/local/bin', '/usr/local/sbin', '/opt/homebrew/bin', home + '/.local/bin', home + '/bin']
  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node')
    const versions = fs.readdirSync(nvmDir)
      .filter((name) => name.charAt(0) === 'v')
      .sort((a, b) => parseFloat(a.slice(1)) - parseFloat(b.slice(1)))
    const latest = versions[versions.length - 1]
    if (latest) list.push(path.join(nvmDir, latest, 'bin'))
  } catch (error) { /* 没有 nvm 就算了 */ }
  return list
}

function childEnv() {
  if (process.platform === 'win32') return process.env
  return Object.assign({}, process.env, {
    PATH: extraPaths().concat(process.env.PATH ? [process.env.PATH] : []).join(':')
  })
}

function pickCwd(cwd) {
  const target = cwd ? path.resolve(String(cwd)) : ''
  try {
    if (target && require('fs').statSync(target).isDirectory()) return target
  } catch (error) {}
  return os.homedir()
}

/** 追加进环形缓冲：超上限从队首丢 */
function pushBuffer(session, chunk) {
  session.buffer.push(chunk)
  session.bufferBytes += chunk.length
  while (session.bufferBytes > BUFFER_MAX_BYTES && session.buffer.length > 1) {
    const dropped = session.buffer.shift()
    session.bufferBytes -= dropped.length
  }
}

/** 广播给所有订阅者（SSE 客户端 / IPC 转发器）：payload = { data: base64 } */
function broadcast(session, payload) {
  for (const client of session.clients.slice()) {
    try { client(payload) } catch (error) {}
  }
}

function onData(session, chunk) {
  if (not(chunk) || !chunk.length) return
  pushBuffer(session, chunk)
  broadcast(session, { data: chunk.toString('base64') })
}

/** 复位已有会话（顶掉旧的）：先杀进程再清订阅 */
function killSession(session) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer)
    session.cleanupTimer = null
  }
  if (session.alive) {
    session.alive = false
    const pid = session.proc ? session.proc.pid : 0
    try {
      if (process.platform === "win32" && pid) {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true })
      } else if (pid) {
        try { process.kill(-pid, "SIGTERM") } catch (error) { try { session.proc.kill("SIGTERM") } catch (inner) {} }
      }
    } catch (error) {}
  }
  for (const client of session.clients.slice()) {
    try { client({ closed: true }) } catch (error) {}
  }
  session.clients.length = 0
  if (session.id) sessions.delete(session.id)
}

function scheduleDeadCleanup(session) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
  session.cleanupTimer = setTimeout(() => killSession(session), DEAD_SESSION_TTL_MS)
  if (session.cleanupTimer.unref) session.cleanupTimer.unref()
}

function makeRoom() {
  if (sessions.size < MAX_SESSIONS) return
  const dead = Array.from(sessions.values())
    .filter((session) => not(session.alive))
    .sort((left, right) => left.createdAt - right.createdAt)
  for (const session of dead) {
    killSession(session)
    if (sessions.size < MAX_SESSIONS) return
  }
  throw new Error('TERMINAL_LIMIT: close an existing terminal before opening another')
}

function start(cwd) {
  makeRoom()
  const where = pickCwd(cwd)
  const id = 't' + Date.now().toString(36) + '-' + (++nextSessionId).toString(36)
  /* Windows：cmd /Q 关掉它自己的命令回显（回显在渲染层 xterm 做了，避免双显） */
  const proc = spawn(pickShell(), process.platform === 'win32' ? ['/Q'] : [], {
    cwd: where,
    env: childEnv(),
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const session = {
    id: id,
    cwd: where,
    proc: proc,
    buffer: [],
    bufferBytes: 0,
    clients: [],
    alive: true,
    createdAt: Date.now(),
    cleanupTimer: null
  }
  sessions.set(id, session)

  proc.stdout.on('data', (chunk) => onData(session, chunk))
  proc.stderr.on('data', (chunk) => onData(session, chunk))
  proc.on('error', (error) => {
    onData(session, Buffer.from('\r\n[终端启动失败: ' + error.message + ']\r\n'))
    session.alive = false
    scheduleDeadCleanup(session)
  })
  proc.on('exit', (code) => {
    if (not(session.alive)) return
    session.alive = false
    onData(session, Buffer.from('\r\n[进程已退出 code=' + code + ']\r\n'))
    broadcast(session, { closed: true })
    scheduleDeadCleanup(session)
  })
  return { sid: id, cwd: where, shell: path.basename(pickShell()) }
}

function currentSession() {
  for (const session of sessions.values()) return session
  return null
}

function findSession(sid) {
  if (not(sid)) return currentSession()
  return sessions.get(String(sid)) || null
}

/** 渲染层发来一行命令：先回显进缓冲（重放时看得到敲过什么），再写 stdin */
function write(sid, text) {
  const session = findSession(sid)
  if (not(session) || not(session.alive)) return { ok: false, error: "NO_SESSION" }
  const line = String(text === undefined || text === null ? "" : text)
  if (line.length > WRITE_MAX_CHARS) return { ok: false, error: "INPUT_TOO_LONG" }
  pushBuffer(session, Buffer.from(line + String.fromCharCode(10), "utf8"))
  const isWin = process.platform === "win32"
  const lineEnd = isWin ? String.fromCharCode(13) + String.fromCharCode(10) : String.fromCharCode(10)
  const sentinel = isWin ? ("echo " + TERMINAL_READY_MARKER) : ("printf " + String.fromCharCode(39) + "%s" + String.fromCharCode(92) + "n" + String.fromCharCode(39) + " " + String.fromCharCode(39) + TERMINAL_READY_MARKER + String.fromCharCode(39))
  try {
    session.proc.stdin.write(line + lineEnd + sentinel + lineEnd)
  } catch (error) {
    return { ok: false, error: "WRITE_FAILED: " + error.message }
  }
  return { ok: true }
}

function kill(sid) {
  const session = findSession(sid)
  if (not(session)) return { ok: true }
  killSession(session)
  return { ok: true }
}

/** 查子进程的真实 cwd：用户在管道 shell 里 cd，外面收不到通知，
 *  只能主动查 —— mac 用 lsof（慢但可用），linux 读 /proc，win 查不动就维持原值。 */
function realCwd(session) {
  if (not(session) || not(session.alive) || not(session.proc || session.pid)) return null
  const pid = session.proc ? session.proc.pid : session.pid
  if (not(pid)) return null
  try {
    if (process.platform === 'linux') {
      const target = fs.readlinkSync(path.join('/proc', String(pid), 'cwd'))
      return target || null
    }
    if (process.platform === 'darwin') {
      const out = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1500 })
      if (not(out) || not(out.stdout)) return null
      const lines = String(out.stdout).split('\n')
      for (const line of lines) {
        if (line.charAt(0) === 'n' && line.length > 1) return line.slice(1)
      }
    }
  } catch (error) { /* 查不到就算了，维持旧值 */ }
  return null
}

function listSessions() {
  return Array.from(sessions.values()).map((session) => ({ sid: session.id, cwd: session.cwd, alive: session.alive }))
}

function state(sid) {
  if (not(sid)) return { sessions: listSessions() }
  const session = findSession(sid)
  if (not(session)) return { sid: '', cwd: '', alive: false }
  const where = realCwd(session)
  if (where) session.cwd = where
  return { sid: session.id, cwd: session.cwd, alive: session.alive }
}

/** 订阅输出：立刻补发整个缓冲（replay），之后实时块。返回解绑函数。 */
function subscribe(sid, client) {
  const session = findSession(sid)
  if (not(session) || not(client)) return () => {}
  client({ replay: Buffer.concat(session.buffer).toString('base64') })
  if (not(session.alive)) client({ closed: true })
  session.clients.push(client)
  return () => {
    const at = session.clients.indexOf(client)
    if (at >= 0) session.clients.splice(at, 1)
  }
}

/** 服务退出时收尸：别让用户 shell 挂成孤儿 */
function teardownAll() {
  for (const session of sessions.values()) killSession(session)
  sessions.clear()
}

/* ------------------------------------------------- HTTP 路由（server/index.js 挂载） */

async function handleTerminalApi(context) {
  const url = context.url
  const request = context.request
  const response = context.response
  const json = context.json

  if (url.pathname === '/api/terminal/state' && request.method === 'GET') {
    json(response, 200, state(url.searchParams.get('sid')))
    return true
  }
  if (url.pathname === '/api/terminal/start' && request.method === 'POST') {
    const body = await context.readBody(request)
    const result = start(body && body.cwd)
    json(response, 200, result)
    return true
  }
  if (url.pathname === '/api/terminal/write' && request.method === 'POST') {
    const body = await context.readBody(request)
    json(response, 200, write(body && body.sid, body && body.text))
    return true
  }
  if (url.pathname === '/api/terminal/kill' && request.method === 'POST') {
    const body = await context.readBody(request)
    json(response, 200, kill(body && body.sid))
    return true
  }
  if (url.pathname === '/api/terminal/events' && request.method === 'GET') {
    const sid = url.searchParams.get('sid')
    const session = findSession(sid)
    if (not(session)) {
      json(response, 404, { error: 'NO_SESSION' })
      return true
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const client = (payload) => {
      response.write('event: terminal\ndata: ' + JSON.stringify(payload) + '\n\n')
    }
    subscribe(sid, client)
    request.on('close', () => {
      const at = session.clients.indexOf(client)
      if (at >= 0) session.clients.splice(at, 1)
    })
    return true
  }
  return false
}

module.exports = {
  handleTerminalApi,
  start,
  write,
  kill,
  state,
  subscribe,
  teardownAll
}
