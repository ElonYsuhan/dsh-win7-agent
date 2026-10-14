'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { pickNativeFolder } = require('./native-folder')
const { AgentPool } = require('../src/main/agent/agent-pool')
const { SettingsStore } = require('./settings-store')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { AssetStore } = require('../src/main/agent/asset-store')
const { fetchModelList } = require('../src/main/agent/model-list')
const { handleFileApi } = require('./file-api')
const { handleTerminalApi, teardownAll } = require('./terminal-api')
const { UiStore } = require('./ui-store')

const not = (value) => value ? false : true
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT) || 8080
// 身份标识：桌面版 Shell 靠它区分"本机的 agent 服务"与"别的程序占了端口"
const SERVICE_ID = 'dsh-agent-service'
const MAX_PORT_ATTEMPTS = Number(process.env.PORT_MAX_ATTEMPTS) || 20
let SERVICE_VERSION = '0.0.0'
try {
  SERVICE_VERSION = require('../package.json').version || SERVICE_VERSION
} catch (error) {}
// 实际监听端口：PORT 被占用时会自动向后顺延，这里保存最终生效值
let currentPort = PORT
const AGENT_HOME = process.env.AGENT_HOME || path.resolve(process.cwd(), 'data')
const RENDERER_DIR = path.resolve(__dirname, '..', 'src', 'renderer')
const UI_BUILD = require('../src/main/agent/ui-build').uiBuild(RENDERER_DIR)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const settingsStore = new SettingsStore(AGENT_HOME)
const assetStore = new AssetStore(path.join(AGENT_HOME, 'assets'))
settingsStore.sessionRoot = path.join(AGENT_HOME, 'sessions')
/* 渲染层会话/偏好的落盘（ui-store.json）。这是「会话记录跟端口解耦」的那半边：
   localStorage 按 origin 隔离，端口一换就是新空间；服务端这份跟端口无关，
   渲染层加载时以它优先（见 src/renderer/app.js 的 loadSessionStore）。 */
const uiStore = new UiStore(AGENT_HOME)
const sseClients = new Set()
const pendingApprovals = new Map()
const pluginHost = new PluginHost({
  workspaceRoot: settingsStore.data.workspacePath,
  settings: settingsStore
})
pluginHost.loadBuiltins()
pluginHost.loadFromDirectory(path.join(AGENT_HOME, 'plugins'))
/* 一条会话一台 worker（见 src/main/agent/agent-pool.js）。
   以前这里是单个 agent 实例 + 全局 running，第二个会话发消息就被 BUSY 顶回去。 */
const pool = new AgentPool({
  settings: settingsStore,
  emit: (event) => broadcast(event),
  approve: (approvalRequest, sessionId) => requestApproval(approvalRequest, sessionId),
  sessionRoot: path.join(AGENT_HOME, 'sessions'),
  pluginHost,
  assetStore
})

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk.toString('utf8')
      if (body.length > 1024 * 1024) {
        request.destroy()
        reject(new Error('BODY_TOO_LARGE'))
      }
    })
    request.on('end', () => {
      if (body === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error('BAD_JSON'))
      }
    })
    request.on('error', reject)
  })
}

/* 带 limit 的 readBody：ui-store 的 PUT 会带整份会话记录（思考过程 HTML 是大头，
   可到几 MB），卡 1MB 的 readBody 会把它劈成 413。其余小请求照旧走 readBody。 */
function readBodyLimit(request, limit) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk.toString('utf8')
      if (body.length > limit) {
        request.destroy()
        reject(new Error('BODY_TOO_LARGE'))
      }
    })
    request.on('end', () => {
      if (body === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error('BAD_JSON'))
      }
    })
    request.on('error', reject)
  })
}

function isLoopbackAddress(address) {
  const value = String(address || '')
  if (value === '127.0.0.1' || value === '::1') return true
  if (value.startsWith('127.')) return true
  if (value.startsWith('::ffff:127.')) return true
  return false
}

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try { await pool.dispose() } catch (error) {}
  try { pluginHost.dispose() } catch (error) {}
  try { teardownAll() } catch (error) {}
  try { clearPendingApprovals() } catch (error) {}
  try { await uiStore.flush() } catch (error) {}
  try {
    for (const client of sseClients) {
      try { client.end() } catch (error) {}
    }
    sseClients.clear()
  } catch (error) {}
  const done = () => process.exit(0)
  try {
    if (server) {
      server.close(done)
      setTimeout(done, 1500)
      return
    }
  } catch (error) {}
  done()
}

function broadcast(event) {
  const payload = 'data: ' + JSON.stringify(event) + '\n\n'
  for (const client of sseClients) {
    client.write(payload)
  }
}

/* 审批请求也带 sessionId：弹窗答复要回到发起它的那台 worker。
   没有这个戳，两条会话同时要授权时就分不清是谁在等。 */
function requestApproval(approvalRequest, sessionId) {
  const id = crypto.randomUUID()
  const owner = sessionId ? String(sessionId) : ''
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id)
        broadcast({ type: 'approval', id, expired: true, request: approvalRequest, sessionId: owner || undefined })
        resolve(false)
      }
    }, 300000)
    pendingApprovals.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, approvalRequest, sessionId: owner })
    broadcast({ type: 'approval', id, request: approvalRequest, sessionId: owner || undefined })
  })
}

/* 急停复位：abort 全部 + 把 running 复位，并把每条在跑的会话都结算一条 finished
   （渲染层靠它把「发送中」收回去）。 */
async function forceResetAgent() {
  await pool.reset()
  clearPendingApprovals()
}

function clearPendingApprovals() {
  for (const id of Array.from(pendingApprovals.keys())) {
    const pending = pendingApprovals.get(id)
    pendingApprovals.delete(id)
    try { pending.resolve(false) } catch (error) {}
  }
}

function stateValue() {
  return {
    settings: settingsStore.all(),
    workspacePath: pool.getWorkspace(),
    running: pool.runningCount() > 0,
    runningSessions: pool.runningSessions(),
    maxConcurrentRuns: pool.maxConcurrentRuns,
    plugins: pluginHost.listPlugins(),
    tools: pluginHost.listTools()
  }
}

function safeStaticPath(pathname) {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch (error) {
    return null
  }
  const target = path.resolve(RENDERER_DIR, '.' + decoded)
  if (target !== RENDERER_DIR && not(target.startsWith(RENDERER_DIR + path.sep))) return null
  return target
}

function serveStatic(request, response, pathname) {
  const target = safeStaticPath(pathname === '/' ? '/index.html' : pathname)
  if (not(target)) {
    json(response, 403, { error: 'FORBIDDEN' })
    return
  }
  fs.readFile(target, (error, buffer) => {
    if (error) {
      json(response, 404, { error: 'NOT_FOUND' })
      return
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    response.end(buffer)
  })
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    json(response, 200, {
      ok: true,
      app: SERVICE_ID,
      version: SERVICE_VERSION,
      uiBuild: UI_BUILD,
      agentHome: path.resolve(AGENT_HOME),
      pid: process.pid,
      port: currentPort,
      workspacePath: pool.getWorkspace()
    })
    return true
  }
  if (url.pathname === '/api/shutdown' && request.method === 'POST') {
    // 只接受本机回环调用：局域网其他机器不允许关掉服务
    if (not(isLoopbackAddress(request.socket && request.socket.remoteAddress))) {
      json(response, 403, { error: 'FORBIDDEN' })
      return true
    }
    json(response, 200, { ok: true })
    setTimeout(() => shutdown(), 80)
    return true
  }
  if (url.pathname === '/api/state' && request.method === 'GET') {
    json(response, 200, stateValue())
    return true
  }
  /* 渲染层会话/偏好 storage（见 server/ui-store.js 顶部说明）。
     GET = 整份读；PUT = 合并写（渲染层已做 in-flight 合并，这里照单全收）。
     只认本机回环：这份 store 等于用户的全部聊天记录，不该被局域网另一台机器读写。 */
  if (url.pathname === '/api/ui-store' && request.method === 'GET') {
    if (not(isLoopbackAddress(request.socket && request.socket.remoteAddress))) {
      json(response, 403, { error: 'FORBIDDEN' })
      return true
    }
    json(response, 200, { ok: true, store: uiStore.snapshot() })
    return true
  }
  if (url.pathname === '/api/ui-store' && (request.method === 'PUT' || request.method === 'POST')) {
    if (not(isLoopbackAddress(request.socket && request.socket.remoteAddress))) {
      json(response, 403, { error: 'FORBIDDEN' })
      return true
    }
    try {
      const body = await readBodyLimit(request, 40 * 1024 * 1024)
      const saved = await uiStore.save(body)
      json(response, 200, { ok: true, updatedAt: saved.updatedAt })
    } catch (error) {
      const message = String((error && error.message) || error)
      if (message === 'BODY_TOO_LARGE' || message.indexOf('STORE_TOO_LARGE') === 0) {
        json(response, 413, { error: 'STORE_TOO_LARGE' })
      } else if (message === 'BAD_JSON') {
        json(response, 400, { error: 'BAD_JSON' })
      } else {
        json(response, 500, { error: 'STORE_WRITE_FAILED: ' + message })
      }
    }
    return true
  }
  if (url.pathname === '/api/events' && request.method === 'GET') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(': connected\n\n')
    sseClients.add(response)
    broadcast({ type: 'status', text: 'connected' })
    request.on('close', () => sseClients.delete(response))
    return true
  }
  if (url.pathname === '/api/settings' && request.method === 'POST') {
    const body = await readBody(request)
    const next = settingsStore.update(body)
    if (next.workspacePath) {
      pool.setWorkspace(next.workspacePath)
    }
    json(response, 200, next)
    return true
  }
  if (url.pathname === '/api/fs/pick-native' && request.method === 'POST') {
    const selected = await pickNativeFolder()
    json(response, 200, selected)
    return true
  }
  /* 文件预览（右侧面板）：列树 / 元信息 / 原始字节。只读，且只认「关联的工作区目录」。
     放在 /api/fs/list 前面，但两者路径不冲突，顺序无所谓 —— 单独一个模块是为了别把这里撑爆。 */
  if (await handleFileApi(url, request, response, { json, settingsStore })) return true
  /* 终端（三期）：spawn + 管道 + SSE，见 terminal-api.js。关面板不杀会话，历史保在这边。 */
  if (await handleTerminalApi({ url, request, response, json, readBody })) return true
  if (url.pathname === '/api/fs/list' && request.method === 'GET') {
    const requested = url.searchParams.get('path') || os.homedir()
    const target = path.resolve(requested)
    try {
      const entries = await fs.promises.readdir(target, { withFileTypes: true })
      const dirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name))
      json(response, 200, {
        path: target,
        parent: path.dirname(target) === target ? null : path.dirname(target),
        dirs
      })
    } catch (error) {
      json(response, 400, { error: 'DIR_LIST_FAILED: ' + error.message })
    }
    return true
  }
  if (url.pathname === '/api/fs/mkdir' && request.method === 'POST') {
    const body = await readBody(request)
    const parent = path.resolve(String(body.path || os.homedir()))
    const name = String(body.name || '').trim()
    if (name === '') {
      json(response, 400, { error: 'FOLDER_NAME_REQUIRED' })
      return true
    }
    const target = path.resolve(parent, name)
    if (path.dirname(target) !== parent) {
      json(response, 400, { error: 'INVALID_FOLDER_NAME' })
      return true
    }
    try {
      await fs.promises.mkdir(target, { recursive: true })
      json(response, 200, { path: target })
    } catch (error) {
      json(response, 400, { error: 'MKDIR_FAILED: ' + error.message })
    }
    return true
  }
  if (url.pathname === '/api/workspace' && request.method === 'POST') {
    const body = await readBody(request)
    const workspacePath = String(body.path || '').trim()
    if (workspacePath === '') {
      json(response, 400, { error: 'WORKSPACE_REQUIRED' })
      return true
    }
    settingsStore.update({ workspacePath })
    pool.setWorkspace(workspacePath)
    pool.clear()
    broadcast({ type: 'workspace', path: workspacePath })
    json(response, 200, stateValue())
    return true
  }
  if (url.pathname === '/api/models' && request.method === 'POST') {
    const body = await readBody(request)
    try {
      const models = await fetchModelList(body.baseURL, body.apiKey)
      json(response, 200, { models })
    } catch (error) {
      json(response, 400, { error: 'MODEL_LIST_FAILED: ' + error.message })
    }
    return true
  }
  if (url.pathname === '/api/assets' && request.method === 'POST') {
    const body = await readBody(request)
    try {
      const sessionDir = body.sessionId ? pool.sessionDir(body.sessionId) : ''
      json(response, 200, assetStore.saveDataUrl(body.dataUrl, {
        name: body.name,
        mime: body.mime,
        sessionDir
      }))
    } catch (error) {
      json(response, 400, { error: 'ASSET_SAVE_FAILED: ' + error.message })
    }
    return true
  }
  if (url.pathname.indexOf('/api/assets/') === 0 && request.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/assets/'.length))
    try {
      const asset = assetStore.get(id)
      response.writeHead(200, { 'content-type': asset.mime, 'content-length': asset.buffer.length, 'cache-control': 'no-store' })
      response.end(asset.buffer)
    } catch (error) {
      json(response, 404, { error: 'ASSET_NOT_FOUND' })
    }
    return true
  }
  if (url.pathname === '/api/chat' && request.method === 'POST') {
    const body = await readBody(request)
    /* sessionId = 这条消息属于哪条会话（渲染层每条会话有自己的 id）。
       没带就退化成 'default' 那台 worker —— 老客户端行为不变。 */
    const sessionId = String(body.sessionId || '')
    const text = String(body.text || '')
    const history = Array.isArray(body.history) ? body.history : undefined
    const images = Array.isArray(body.images) ? body.images : []
    const memory = body.memory && typeof body.memory === 'object' ? body.memory : undefined
    /* 只发图片不写字是合法输入（用户报过 400）：没有文字、也没有图片才算空。 */
    if (text.trim() === '' && images.length === 0) {
      json(response, 400, { error: 'TEXT_REQUIRED' })
      return true
    }
    /* 并发：同一条会话重入 = 409（它在跑，这条得排队等它）；
       整个池满了 = 503（可调大设置里的并发上限）。
       以前是一刀切 409 BUSY —— 单实例时代只有「忙」这一种状态。 */
    if (pool.isRunning(sessionId)) {
      json(response, 409, { error: 'SESSION_BUSY' })
      return true
    }
    if (pool.isFull()) {
      json(response, 503, { error: 'POOL_BUSY', maxConcurrentRuns: pool.maxConcurrentRuns })
      return true
    }
    pool.run(sessionId, text, history, images.length > 0 ? images : undefined, memory)
      .catch((error) => broadcast(pool.tag(sessionId, { type: 'error', message: error.message })))
    json(response, 202, { ok: true, sessionId: sessionId })
    return true
  }
  if (url.pathname === '/api/stop' && request.method === 'POST') {
    const body = await readBody(request)
    /* 带 sessionId = 只停这条会话；不带 = 全停（老客户端 / 全局急停） */
    pool.abort(body && body.sessionId)
    json(response, 200, { ok: true })
    return true
  }
  if (url.pathname === '/api/reset' && request.method === 'POST') {
    const body = await readBody(request)
    /* 带 sessionId 只复位那一条会话；不带就是全局急停（老客户端行为） */
    await pool.reset(body && body.sessionId)
    clearPendingApprovals()
    json(response, 200, { ok: true })
    return true
  }
  if (url.pathname === '/api/clear' && request.method === 'POST') {
    const body = await readBody(request)
    pool.clear(body && body.sessionId)
    json(response, 200, { ok: true })
    return true
  }
  if (url.pathname === '/api/approve' && request.method === 'POST') {
    const body = await readBody(request)
    const pending = pendingApprovals.get(String(body.id || ''))
    if (not(pending)) {
      json(response, 404, { error: 'APPROVAL_NOT_FOUND' })
      return true
    }
    pendingApprovals.delete(String(body.id || ''))
    pending.resolve(body.approved === true)
    json(response, 200, { ok: true })
    return true
  }
  return false
}

let server = null
let listenAttempts = 0

function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      if (await handleApi(request, response, url)) return
      if (url.pathname.startsWith('/api/')) {
        json(response, 404, { error: 'API_NOT_FOUND' })
        return
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        serveStatic(request, response, url.pathname)
        return
      }
      json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    } catch (error) {
      json(response, 500, { error: error.message })
    }
  })
}

function announce() {
  // 桌面版 Shell 解析下面这一行获取真实端口；端口顺延后依然准确
  console.log('[agent-service] listening on http://' + HOST + ':' + currentPort)
  console.log('[agent-service] service-id ' + SERVICE_ID + ' version ' + SERVICE_VERSION)
  console.log('[agent-service] workspace: ' + pool.getWorkspace())
  console.log('[agent-service] model: ' + settingsStore.data.model + ' @ ' + settingsStore.data.baseURL)
  console.log('[agent-service] max concurrent sessions: ' + pool.maxConcurrentRuns)
}

function startListen(port) {
  currentPort = port
  server = createServer()
  server.on('listening', () => {
    const address = server.address()
    if (address && typeof address === 'object') currentPort = address.port
    announce()
  })
  server.on('error', (error) => {
    // 端口被占：自动向后顺延，最多 MAX_PORT_ATTEMPTS 次
    if (error && error.code === 'EADDRINUSE' && listenAttempts < MAX_PORT_ATTEMPTS) {
      listenAttempts += 1
      const next = currentPort + 1
      console.error('[agent-service] port ' + currentPort + ' in use, retrying ' + next)
      const dying = server
      setTimeout(() => {
        // 先摘掉旧实例的监听，避免它的 error 事件再次触发重试
        try { dying.removeAllListeners('error') } catch (e) {}
        try { dying.close() } catch (e) {}
        startListen(next)
      }, 150)
      return
    }
    console.error('[agent-service] fatal: ' + (error && error.message ? error.message : String(error)))
    process.exit(2)
  })
  server.listen(port, HOST)
}

startListen(PORT)
