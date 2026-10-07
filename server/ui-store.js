'use strict'

/*
 * 渲染层会话/偏好 storage 的服务端落盘（「会话记录跟端口解耦」）。
 *
 * 背景（2026-09-20 用户问出来的）：会话列表此前只存在渲染层 localStorage，
 * 而 localStorage 按 origin（协议+主机+端口）隔离 —— 8080 被别的程序占、
 * 服务跳到 8081 时，服务端数据全在但会话列表「看起来空了」。
 * 现在渲染层把这份 store 双写到服务端（GET/PUT /api/ui-store，落本文件），
 * 加载时服务端优先、localStorage 兜底 —— 换端口/换浏览器都拿得到同一份。
 *
 * 为什么不用 settings.json：这份 store 随消息气泡/思考过程 HTML 增长，
 * 体量可达几 MB，跟 settings 的小 JSON 不是一个量级，读写节奏也不同
 * （settings 低频全量、store 高频防抖合并），分开两个文件互不拖累。
 *
 * 写入策略：异步 + in-flight 合并（写入中来了新数据就记 pending，写完补一轮），
 * 不会阻塞事件循环，也不会并发写文件。文件本体原子 temp+rename；
 * Windows 上目标被占（EBUSY/EPERM/EACCES）降级直写 —— 与 file-api 的 writeWorkspaceFile
 * 同一套兜底。两个服务进程同时写（旧端口的浏览器页 + 新端口的桌面壳）理论上有竞态，
 * 原子写保证文件不损坏，最后写赢 —— 桌面壳有单实例锁，这条路径很窄。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

/** store 体量上限（思考过程 HTML 是大头）。超了直接拒写，别把磁盘塞爆。 */
const MAX_STORE_BYTES = 32 * 1024 * 1024

const not = (value) => value ? false : true

function defaultStore() {
  return { sessions: {}, currentSessionId: '', prefs: {}, updatedAt: 0 }
}

function normalizeStore(raw) {
  const base = defaultStore()
  if (not(raw) || typeof raw !== 'object' || Array.isArray(raw)) return base
  const sessions = {}
  const rawSessions = raw.sessions
  if (rawSessions && typeof rawSessions === 'object' && not(Array.isArray(rawSessions))) {
    for (const key of Object.keys(rawSessions)) {
      if (Array.isArray(rawSessions[key])) sessions[String(key)] = rawSessions[key]
    }
  }
  return {
    sessions,
    currentSessionId: typeof raw.currentSessionId === 'string' ? raw.currentSessionId.slice(0, 128) : '',
    /* prefs 里的键值由渲染层定义（sectionCollapsed/sidebarCollapsed/messageWidth/sentHistory），
       这里只挡「不是对象」—— 内容宽容，别因为一个小字段把整份 store 丢了 */
    prefs: (raw.prefs && typeof raw.prefs === 'object' && not(Array.isArray(raw.prefs))) ? raw.prefs : {},
    updatedAt: Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0
  }
}

/** 「空 store」判定：迁移用 —— 服务端是空的才值得把 localStorage 的旧数据迁上去 */
function isEmptyStore(store) {
  if (not(store) || typeof store !== 'object') return true
  const sessions = store.sessions || {}
  for (const key of Object.keys(sessions)) {
    if (Array.isArray(sessions[key]) && sessions[key].length > 0) return false
  }
  return not(store.currentSessionId)
}

class UiStore {
  constructor(agentHome) {
    this.home = String(agentHome || '')
    this.file = path.join(this.home, 'ui-store.json')
    this.data = defaultStore()
    this.writing = false
    this.pending = null
    this.lastError = ''
    this.loadSync()
  }

  /** 启动时同步读一次（构造器里调）。文件坏了不炸服务：回落空 store，原文件留着不覆盖
      （否则一次坏读就把用户所有会话洗掉 —— 坏文件留给用户/排查，重写成空是最后手段）。 */
  loadSync() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.data = normalizeStore(JSON.parse(raw))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.lastError = error.message
        console.error('[ui-store] load failed, keep empty in memory (file untouched):', error.message)
      }
      this.data = defaultStore()
    }
    return this.snapshot()
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data))
  }

  /** 合并保存（异步）。返回保存后的快照。 */
  async save(next) {
    const candidate = normalizeStore(Object.assign({}, this.data, next || {}))
    candidate.updatedAt = Date.now()
    const payloadBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
    if (payloadBytes > MAX_STORE_BYTES) throw new Error('STORE_TOO_LARGE: ' + payloadBytes)
    this.data = candidate
    if (this.writing) {
      this.pending = this.data
      return this.snapshot()
    }
    this.writing = true
    try {
      await this.write(this.data)
      /* 写盘期间又来了新数据：补一轮，保证磁盘最终是最新那份 */
      while (this.pending) {
        const upcoming = this.pending
        this.pending = null
        await this.write(upcoming)
      }
    } finally {
      this.writing = false
    }
    this.lastError = ''
    return this.snapshot()
  }

  /** 等所有在途/待补的写盘排空（save 返回 ≠ 已落盘：in-flight 合并下只保证「最终会落」）。
      测试和「退出前确认写完」用；渲染层的常规推送是 fire-and-forget，不用等。 */
  async flush() {
    let guard = 0
    while ((this.writing || this.pending) && guard < 600) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      guard += 1
    }
  }

  async write(data) {
    const payload = Buffer.from(JSON.stringify(data), 'utf8')
    if (payload.length > MAX_STORE_BYTES) throw new Error('STORE_TOO_LARGE: ' + payload.length)
    fs.mkdirSync(this.home, { recursive: true })
    const temp = path.join(this.home, '.ui-store.json.dsh-tmp-' + process.pid + '-' + Date.now())
    try {
      await fsp.writeFile(temp, payload)
      await fsp.rename(temp, this.file)
    } catch (error) {
      try { await fsp.unlink(temp) } catch (cleanup) {}
      if (error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES')) {
        await fsp.writeFile(this.file, payload)
      } else {
        throw error
      }
    }
  }
}

module.exports = { UiStore, normalizeStore, isEmptyStore, MAX_STORE_BYTES, defaultStore }
