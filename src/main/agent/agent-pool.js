'use strict'

const path = require('path')
const { Agent } = require('./agent')

const not = (value) => value ? false : true

/* 并发上限兜底值。settings.maxConcurrentRuns 没配 / 配坏了就用它。
   3 是保守数：每条会话都在打同一个模型服务，开再多只会互相抢配额。 */
const DEFAULT_MAX_CONCURRENT_RUNS = 8
const MAX_CONCURRENT_RUNS_LIMIT = 64
/* 常驻 worker 上限（LRU 淘汰）。一个 worker 就是一份 Agent：聊天记录常驻内存，
   会话开多了不回收会一直涨。历史在渲染层（localStorage）手里，淘汰是安全的 ——
   下一条消息会把整份 history 捎回来。 */
const DEFAULT_MAX_WORKERS = 12
const RESET_WAIT_MS = 5000

function waitFor(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    if (timer.unref) timer.unref()
    Promise.resolve(promise).then(() => finish(true), () => finish(true))
  })
}

/* 会话 id 直接当目录名不安全（可能是任意字符串 / 中文），转成安全片段。
   转过会有碰撞风险（中文全变下划线），所以只要发生了替换就补一段短哈希。 */
function safeSegment(value) {
  const text = String(value || '').trim()
  if (text === '') return ''
  const safe = text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
  if (safe === text) return safe
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 2147483647
  }
  return safe + '-' + hash.toString(36)
}

/* 空 id 归到 'default' —— 老客户端不带 sessionId 时退化成单实例行为（永远同一个 worker） */
function keyOf(sessionId) {
  const key = safeSegment(sessionId)
  return key === '' ? 'default' : key
}

/**
 * 多实例池：一条会话一个 worker Agent，互不阻塞。
 *
 * 以前整条链路只有一个 `agent` 实例 + 一个全局 `running` 标志，第二个会话想发消息
 * 就被 `BUSY` 顶回来（用户 2026-09-19：「那不行啊，我需要多个 agent 实例」）。
 * 这里把「谁在跑」拆成按会话记账：
 *
 *   1. 每个 sessionId 一台 worker，`sessionDir` 落在 sessions/<id>/ 子目录 ——
 *      共用一个目录的话两条会话的 last-session.json 会互相覆盖。
 *   2. worker 吐出的所有事件都盖上 `sessionId` 戳，渲染层靠它把增量路由回正确的会话。
 *   3. 审批请求同样带上 sessionId，弹窗答复才能回到正确的 worker。
 *   4. 只对「同一条会话重入」判 SESSION_BUSY；跨会话并发由 maxConcurrentRuns 兜底。
 *
 * 插件宿主（PluginHost）是**共享**的：它本身没有按 agent 的状态，工具定义 / 系统提示
 * 对所有 worker 一致，共享省掉每会话重新加载插件的开销。工作区是全局设置，
 * 切工作区时统一广播给所有 worker。
 */
class AgentPool {
  constructor(options) {
    const opts = options || {}
    this.settings = opts.settings || null
    this.emit = typeof opts.emit === 'function' ? opts.emit : () => undefined
    this.approve = typeof opts.approve === 'function' ? opts.approve : async () => false
    this.sessionRoot = opts.sessionRoot || ''
    this.pluginHost = opts.pluginHost || null
    this.assetStore = opts.assetStore || null
    this.maxWorkers = Math.max(1, Number(opts.maxWorkers) || DEFAULT_MAX_WORKERS)
    this.workers = new Map()
    this.running = new Map()
    this.lastUsed = new Map()
    this.disposals = new Set()
    this.clock = 0
  }

  get maxConcurrentRuns() {
    const raw = this.settings && this.settings.data ? Number(this.settings.data.maxConcurrentRuns) : 0
    if (not(Number.isFinite(raw)) || raw < 1) return DEFAULT_MAX_CONCURRENT_RUNS
    return Math.min(MAX_CONCURRENT_RUNS_LIMIT, Math.floor(raw))
  }

  workspacePath() {
    return (this.settings && this.settings.data && this.settings.data.workspacePath) || ''
  }

  getWorkspace() {
    return this.workspacePath()
  }

  /* 切换工作区：设置只写一次，然后统一广播给插件宿主和所有已存在的 worker */
  setWorkspace(workspacePath) {
    const raw = String(workspacePath || '')
    if (raw) this.settings.update({ workspacePath: raw })
    const resolved = this.workspacePath()
    if (this.pluginHost) this.pluginHost.workspaceRoot = resolved
    for (const worker of this.workers.values()) if (!worker.unattended && !worker.knowledgeBound) worker.workspaceRoot = resolved
    return resolved
  }

  sessionDir(sessionId) {
    return path.join(this.sessionRoot, keyOf(sessionId))
  }

  /* 取（或建）某个会话的 worker。不启动任何执行，只是把实例准备好。 */
  acquire(sessionId) {
    const key = keyOf(sessionId)
    const existing = this.workers.get(key)
    if (existing) {
      this.touch(key)
      return existing
    }
    const self = this
    const factory = this.pluginHost && this.pluginHost.get('agents')
    const create = factory ? (...args) => factory.create(...args) : (...args) => new Agent(...args)
    const worker = create(
      this.settings,
      (event) => self.emit(self.tag(key, event)),
      (request) => self.approve(request, key),
      this.sessionDir(key),
      this.pluginHost,
      this.assetStore
    )
    /* 给 worker 打主人标记：插件事件里回传的 agent 也能认出属于哪条会话 */
    worker.sessionId = key
    worker.workspaceRoot = this.workspacePath()
    this.workers.set(key, worker)
    this.touch(key)
    this.evictIfNeeded(key)
    return worker
  }

  tag(sessionId, event) {
    if (not(event) || typeof event !== 'object') return event
    if (event.sessionId) return event
    return Object.assign({}, event, { sessionId: sessionId })
  }

  touch(key) {
    this.clock += 1
    this.lastUsed.set(key, this.clock)
  }

  /* 超出常驻上限就淘汰最久没用的（在跑的绝不淘汰）。
     历史以渲染层为准，淘汰只是把内存还回来。 */
  evictIfNeeded(keepKey) {
    if (this.workers.size <= this.maxWorkers) return
    const candidates = []
    for (const entry of this.workers.entries()) {
      if (entry[0] === keepKey) continue
      if (this.running.has(entry[0])) continue
      candidates.push(entry[0])
    }
    candidates.sort((left, right) => (this.lastUsed.get(left) || 0) - (this.lastUsed.get(right) || 0))
    let over = this.workers.size - this.maxWorkers
    for (const key of candidates) {
      if (over <= 0) break
      this.releaseWorker(key)
      over -= 1
    }
  }

  releaseWorker(key) {
    const worker = this.workers.get(key)
    this.workers.delete(key)
    this.lastUsed.delete(key)
    if (not(worker) || typeof worker.dispose !== 'function') return
    let pending = null
    try {
      pending = Promise.resolve(worker.dispose())
    } catch (error) {
      return
    }
    this.disposals.add(pending)
    pending.then(() => this.disposals.delete(pending), () => this.disposals.delete(pending))
  }

  isRunning(sessionId) {
    return this.running.has(keyOf(sessionId))
  }

  runningCount() {
    return this.running.size
  }

  runningSessions() {
    return Array.from(this.running.keys())
  }

  isFull() {
    return this.running.size >= this.maxConcurrentRuns
  }

  /* 执行一条会话。同会话重入 → SESSION_BUSY；池满 → POOL_BUSY。
     两个都是**调用方该看到的错误**，所以 Server 侧会先探一次（拿得到 HTTP 状态码），
     这里的判断是二道闸，防止两个请求同时挤进同一个入口。 */
  async run(sessionId, text, history, images, memory, unattended) {
    const key = keyOf(sessionId)
    if (this.running.has(key)) {
      throw new Error('SESSION_BUSY: this session is already running')
    }
    if (this.isFull()) {
      throw new Error('POOL_BUSY: ' + this.running.size + ' of ' + this.maxConcurrentRuns + ' sessions are running')
    }
    const worker = this.acquire(key)
    if (unattended) {
      worker.unattended = true
      const data = Object.freeze({ ...this.settings.data, ...unattended.settings, workspacePath: unattended.workspaceRoot })
      worker.settings = { data, all: () => data, update: () => { throw new Error('UNATTENDED_SETTINGS_IMMUTABLE') } }
      worker.workspaceRoot = unattended.workspaceRoot
      worker.approve = async () => false
    }
    let finishRun = null
    const ticket = {
      worker,
      done: new Promise((resolve) => { finishRun = resolve })
    }
    this.running.set(key, ticket)
    try {
      if (!unattended && this.pluginHost) { const knowledge=this.pluginHost.get('knowledge');if(knowledge){const context=await knowledge.sessionContext(key);worker.knowledgeBound=Boolean(context);if(context)worker.workspaceRoot=context.workspaceRoot} }
      if(not(worker.workspaceRoot))throw new Error('WORKSPACE_NOT_SET: choose a local workspace directory first')
      await worker.run(text, history, images, memory)
    } finally {
      if (this.running.get(key) === ticket) this.running.delete(key)
      finishRun()
    }
  }

  async runUnattended(sessionId, prompt, configuration) {
    if (this.isRunning(sessionId)) throw new Error('SESSION_BUSY: task session is already running')
    let finished = null
    const worker = this.acquire(sessionId), emit = worker.emit
    worker.emit = (event) => { if (event.type === 'finished') finished = event; emit(event) }
    try { await this.run(sessionId, prompt, [], undefined, undefined, configuration); return finished }
    finally { worker.emit = emit; this.releaseWorker(keyOf(sessionId)) }
  }

  /* 不带 sessionId = 停全部（老客户端 / 全局急停） */
  abort(sessionId) {
    if (sessionId === undefined || sessionId === null || String(sessionId) === '') return this.abortAll()
    const worker = this.workers.get(keyOf(sessionId))
    if (worker) {
      try { worker.abort() } catch (error) {}
    }
    return true
  }

  abortAll() {
    for (const worker of this.workers.values()) {
      try { worker.abort() } catch (error) {}
    }
    return true
  }

  /* 急停复位：abort 之外还要把 running 复位。
     单实例版 forceResetAgent 就是这么干的 —— 光 abort 不够，
     万一某条会话卡在重试循环里没退出来，它的下一次 run 会先被自己的 BUSY 挡住。
     带 sessionId 就只复位那一条（停 A 不该把并行的 B 一起掀掉）。 */
  async reset(sessionId) {
    if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
      this.abortAll()
      const tickets = Array.from(this.running.values())
      await Promise.all(tickets.map((ticket) => waitFor(ticket.done, RESET_WAIT_MS)))
      for (const key of Array.from(this.workers.keys())) {
        this.releaseWorker(key)
      }
      this.running.clear()
      return true
    }
    const key = keyOf(sessionId)
    const ticket = this.running.get(key)
    const worker = this.workers.get(key)
    try { if (worker) worker.abort() } catch (error) {}
    if (ticket) await waitFor(ticket.done, RESET_WAIT_MS)
    if (this.running.get(key) === ticket) this.running.delete(key)
    this.releaseWorker(key)
    if (not(ticket)) this.emit(this.tag(key, { type: 'status', text: 'reset' }))
    return true
  }

  /* 结算一条会话：复位 running 并补一条 finished（渲染层靠它把「发送中」收回去）。
     没有 worker 时**只发 status** —— 千万别发带空 messages 的 finished，
     渲染层会拿它把这条会话的历史清空。 */
  settle(key) {
    const worker = this.workers.get(key)
    if (not(worker)) {
      this.emit(this.tag(key, { type: 'status', text: 'reset' }))
      return
    }
    worker.running = false
    worker.abortController = null
    this.emit(this.tag(key, { type: 'status', text: 'reset' }))
    this.emit(this.tag(key, { type: 'finished', messages: worker.messages, memory: worker.memory }))
  }

  clear(sessionId) {
    if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
      for (const worker of this.workers.values()) worker.clear()
      return true
    }
    const worker = this.workers.get(keyOf(sessionId))
    if (worker) worker.clear()
    return true
  }

  executionStates() {
    return Object.fromEntries(Array.from(this.workers, ([id, worker]) => [id, worker.state.execution]))
  }

  listPlugins() {
    return this.pluginHost ? this.pluginHost.listPlugins() : []
  }

  listTools() {
    return this.pluginHost ? this.pluginHost.listTools() : []
  }

  /* 宿主状态快照：running 保留成布尔（老调用方/冒烟脚本还认它），
     runningSessions 给渲染层做按会话判断。 */
  state() {
    return {
      running: this.running.size > 0,
      runningSessions: this.runningSessions(),
      maxConcurrentRuns: this.maxConcurrentRuns
    }
  }

  async dispose() {
    this.abortAll()
    const tickets = Array.from(this.running.values())
    await Promise.all(tickets.map((ticket) => waitFor(ticket.done, RESET_WAIT_MS)))
    this.running.clear()
    for (const key of Array.from(this.workers.keys())) this.releaseWorker(key)
    await Promise.all(Array.from(this.disposals))
  }
}

module.exports = { AgentPool, DEFAULT_MAX_CONCURRENT_RUNS }
