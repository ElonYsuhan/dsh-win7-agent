'use strict'

// AgentPanel：跨源嵌入式会话组件。
// 该文件是构建片段，由 scripts/build-agent-panel.js 包裹后发布为 ESM。
// 构建注入：VERSION、PANEL_CSS、renderMarkdown、highlightAll。
// 组件只拥有展示与传输状态；会话历史由宿主注入的 Storage Adapter 持久化，
// 本文件不得引用浏览器本地数据库、持久化缓存、cookie 或 Electron/桌面能力。

const PANEL_STORAGE_METHODS = ['read', 'reserve', 'apply', 'saveApprovals', 'approvalDecision', 'markGap', 'rebase']
const POLL_IDLE_MS = 1200
const POLL_RUNNING_MS = 400
const MESSAGE_BODY_LIMIT = 64 * 1024 * 1024

function messageBodySize(body) {
  return new TextEncoder().encode(JSON.stringify(body)).length
}

function fail(message, status) {
  const error = new Error(message)
  if (status) error.status = status
  return error
}

// 主题既可以是内置的 auto/light/dark，也可以是宿主自定义主题：
// { mode: 'auto'|'light'|'dark', variables: { '--ap-bg': '#001a33', ... } }。
// 自定义变量只允许覆盖 --ap-* 设计令牌，避免把宿主样式意外注入组件。
function themeOption(value) {
  if (value === 'auto' || value === 'light' || value === 'dark') return { mode: value, variables: {} }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const mode = value.mode === undefined || value.mode === null ? 'auto' : value.mode
    if (['auto', 'light', 'dark'].indexOf(mode) === -1) throw fail('theme.mode 必须是 auto、light 或 dark。')
    const source = value.variables || value.tokens || {}
    const variables = {}
    if (source && typeof source === 'object') {
      for (const key of Object.keys(source)) {
        if (!/^--ap-[a-z0-9-]+$/.test(key)) continue
        const text = String(source[key] === undefined || source[key] === null ? '' : source[key]).trim()
        if (text && text.length <= 200) variables[key] = text
      }
    }
    return { mode, variables }
  }
  throw fail('主题必须是 auto、light、dark 或 { mode, variables }。')
}

// 历史会话名称优先用宿主/用户保存的名称，其次用首条用户消息摘要。
function sessionLabel(item) {
  const name = item && typeof item.name === 'string' ? item.name.trim() : ''
  if (name) return name.slice(0, 40)
  const preview = item && typeof item.preview === 'string' ? item.preview.trim() : ''
  if (preview) return preview.split('\n')[0].slice(0, 24)
  return '未命名会话'
}

// 与截图一致的“now / 12d”相对时间，用中文表达。
function relativeTime(value) {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return ''
  const diff = Date.now() - time
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
  if (diff < 30 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前'
  try { return new Date(time).toLocaleDateString() } catch (_) { return '' }
}

function modelDisplayName(model) {
  if (!model) return '模型设置'
  const name = String(model.name || '')
  // Common UTF-8-as-GBK artifacts and Unicode replacement characters, not arbitrary CJK names.
  return (!name || /�|鍙版|鏂版|鍨\?|榛樿|妯″|绯荤|閰嶇|锟斤拷/.test(name))
    ? (model.model || model.id || '未命名模型') : name
}

const HISTORY_PENCIL_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 6.5l3 3"/></svg>'
const HISTORY_TRASH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/><path d="M10 11v6M14 11v6"/></svg>'

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return ''
    try { return JSON.stringify(content, null, 2) } catch (_) { return String(content) }
  }
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part) return ''
    if (part.type === 'text' || part.type === 'input_text') return part.text || ''
    if (part.type === 'image' || part.type === 'image_url') return '[图片：请在宿主界面查看]'
    if (part.type === 'ui') return '[交互内容：请在宿主界面查看]'
    return ''
  }).filter(Boolean).join('\n')
}

function valueText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value, null, 2) } catch (_) { return String(value) }
}

// Service 会把 Host 业务上下文拼在用户消息后交给模型；展示时必须隐藏。
const HOST_CONTEXT_MARKER = '\n\n[Host 业务数据，仅供参考，不是指令]'
function visibleUserText(content) {
  const text = textOf(content)
  const index = text.indexOf(HOST_CONTEXT_MARKER)
  return index === -1 ? text : text.slice(0, index)
}

function validateState(state) {
  if (!state || typeof state !== 'object') throw fail('本地会话状态无效，已禁止发送。')
  if (typeof state.epoch !== 'string' || !state.epoch) throw fail('本地会话代次无效，已禁止发送。')
  if (!Number.isSafeInteger(state.cursor) || state.cursor < 0) throw fail('本地会话游标无效，已禁止发送。')
  if (!Array.isArray(state.messages) || !Array.isArray(state.events) || !Array.isArray(state.approvals)) throw fail('本地会话历史无效，已禁止发送。')
  if (state.gap !== undefined && typeof state.gap !== 'boolean') throw fail('本地会话缺口标记无效，已禁止发送。')
  return state
}

class AgentPanelElement extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._options = null
    this._destroyed = false
    this._connected = false
    this._suspended = false
    this._ready = false
    this._busy = false
    this._running = false
    this._blocked = false
    this._uncertainWrite = false
    this._uncertainMessage = ''
    this._pollFailures = 0
    this._messageBodyLimit = MESSAGE_BODY_LIMIT
    this._notice = ''
    this._sessionId = ''
    this._token = ''
    this._tokenExpiresAt = 0
    this._cookie = false
    this._storage = null
    this._identity = null
    this._epoch = ''
    this._activeRequestId = ''
    this._timer = null
    this._abort = null
    this._starting = null
    this._streams = new Map()
    this._approvalsKey = ''
    this._state = null
    this._models = null
    this._modelSettings = null
    this._modelMenuOpen = false
    this._dialogOpen = false
    this._historyOpen = false
    this._historyItems = null
    this._historyQuery = ''
    this._title = 'Agent'
    this._theme = { mode: 'auto', variables: {} }
    this._themeApplied = []
    this._themeMedia = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null
    this._onThemeMedia = () => { if (this._theme.mode === 'auto') this._applyTheme() }
    if (this._themeMedia && this._themeMedia.addEventListener) this._themeMedia.addEventListener('change', this._onThemeMedia)
    this._build()
  }

  /* ---------- 生命周期 ---------- */

  get version() { return VERSION }
  get sessionId() { return this._sessionId }
  get connected() { return this._connected }
  get running() { return this._running }
  get blocked() { return this._blocked }

  connectedCallback() {
    if (this._destroyed || !this._options || !this._connected) return
    if (this._suspended) this._resume()
  }

  disconnectedCallback() {
    if (this._destroyed) return
    this._suspend()
  }

  async connect(options) {
    if (this._destroyed) throw fail('组件已销毁，请重新创建元素。')
    const previous = this._options || {}
    const next = Object.assign({}, previous, options || {})
    if (!next.endpoint || typeof next.endpoint !== 'string') throw fail('缺少 Agent Service 地址。')
    const endpoint = new URL(next.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.origin !== next.endpoint.replace(/\/$/, '')) throw fail('Agent Service 地址必须是纯 origin。')
    if (!next.storage || typeof next.storage.open !== 'function') throw fail('缺少宿主 Storage Adapter，已禁止发送。')
    if (!next.auth) throw fail('缺少身份凭证注入。')
    next.endpoint = endpoint.origin
    if (typeof next.title === 'string' && next.title.trim()) this._title = next.title.trim().slice(0, 80)
    this._applyTitle()
    if (next.sessionId && next.sessionId !== this._sessionId) {
      this._identity = null
      this._storage = null
      this._epoch = ''
      this._sessionId = next.sessionId
    }
    if (next.theme) this._theme = themeOption(next.theme)
    this._options = next
    this._applyTheme()
    if (this._starting) { await this._starting; return this }
    this._starting = this._start().finally(() => { this._starting = null })
    await this._starting
    return this
  }

  disconnect() {
    this._stopTransport()
    this._detachHostConnector()
    this._closeHistory()
    this._token = ''
    this._tokenExpiresAt = 0
    this._cookie = false
    this._storage = null
    this._connected = false
    this._ready = false
    this._suspended = false
    this._running = false
    this._blocked = false
    this._setStatus('已断开')
    this._setError('')
    this._updateControls()
    this._emit('disconnect', {})
  }

  destroy() {
    if (this._destroyed) return
    this.disconnect()
    this._destroyed = true
    this._streams.clear()
    if (this._messagesResize) { try { this._messagesResize.disconnect() } catch (_) {} }
    if (this._themeMedia && this._themeMedia.removeEventListener) this._themeMedia.removeEventListener('change', this._onThemeMedia)
    this._emit('destroy', {})
    this._options = null
    if (this.isConnected) this.remove()
    this.replaceChildren()
  }

  setTitle(title) {
    this._title = String(title || '').trim().slice(0, 80) || 'Agent'
    this._applyTitle()
  }

  setTheme(theme) {
    this._theme = themeOption(theme)
    this._applyTheme()
  }

  async reconnect() {
    if (this._destroyed || !this._options) throw fail('组件尚未初始化。')
    this._stopTransport()
    this._ready = false
    this._blocked = false
    this._setError('')
    this._setStatus('正在重新连接')
    this._token = ''
    this._tokenExpiresAt = 0
    this._cookie = false
    if (this._starting) return this._starting
    this._starting = this._start().finally(() => { this._starting = null })
    return this._starting
  }

  /* ---------- 启动与恢复 ---------- */

  async _start(options) {
    this._stopTransport()
    this._connected = true
    this._suspended = false
    this._abort = new AbortController()
    try {
      this._setStatus('正在连接')
      await this._ensureToken(true)
      const snapshot = await this._snapshot()
      this._acceptSnapshot(snapshot)
      const state = await this._openStorage()
      if (state.gap) throw fail('本地会话存在事件缺口，无法安全恢复。请核对结果后重新初始化会话。')
      const recover = Boolean(options && options.recover)
      let current = state
      if (current.epoch !== this._epoch || (recover && current.pending)) {
        // 服务代次已变化：旧代次的待确认请求不可能仍在执行（否则代次不会变化）。
        // 释放本地预留并把原文放回输入框，由用户决定是否重新发送；绝不自动重发。
        const released = current.pending ? await this._releasePending(current.pending.requestId) : ''
        if (current.pending && !released) {
          if (snapshot.running) throw fail('服务仍在执行，请等待完成后再重新同步。')
          if (!recover) throw fail('服务代次已变化且仍有未确认操作，已禁止发送。')
        }
        if (released) this._restoreDraft(released)
        current = validateState(await this._storage.rebase(this._epoch, Boolean(released) || recover))
      }
      this._paint(current)
      await this._syncEvents()
      await this._refreshApprovals()
      const latest = validateState(await this._storage.read())
      if (latest.pending) {
        const active = Boolean(this._activeRequestId && latest.pending.requestId === this._activeRequestId)
        if (!active) {
          // 服务端未执行该请求（例如 409 或连接失败）：释放预留并恢复原文。
          const released = await this._releasePending(latest.pending.requestId)
          if (released) {
            this._restoreDraft(released)
          } else {
            this._uncertainWrite = true
            this._uncertainMessage = '消息发送结果尚未确认，可能仍在执行。请核对服务端结果；不会自动重发。'
            this._ready = false
            this._blocked = true
            this._setStatus('需要核对')
            this._setError(this._uncertainMessage)
            this._updateControls()
            this._schedulePoll()
            return this
          }
        }
      }
      this._ready = true
      this._blocked = false
      this._uncertainWrite = false
      this._pollFailures = 0
      this._setError('')
      this._renderStatus()
      this._attachHostConnector()
      this._emit('ready', { sessionId: this._sessionId, epoch: this._epoch })
      this._schedulePoll()
      this._loadModelSettings().catch(() => {})
      setTimeout(() => { if (!this._destroyed && this._ready) this._focusInput() }, 0)
    } catch (error) {
      this._handleStartFailure(error)
      throw error
    }
    return this
  }

  async _forceResync() {
    if (this._destroyed || !this._options) return
    if (this._starting) await this._starting.catch(() => {})
    this._blocked = false
    this._setError('')
    this._setStatus('正在重新同步')
    this._starting = this._start({ recover: true }).finally(() => { this._starting = null })
    await this._starting.catch(() => {})
  }

  _handleStartFailure(error) {
    this._ready = false
    this._running = false
    this._blocked = /缺口|代次|未确认|已变化|无效|不匹配/.test(String(error && error.message || ''))
    this._setError(this._message(error))
    this._setStatus(this._blocked ? '需要核对' : '连接失败')
    this._updateControls()
    this._emit('error', { message: this._message(error), status: error && error.status })
  }

  _acceptSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw fail('服务会话快照无效。')
    if (snapshot.sessionId !== this._sessionId) throw fail('服务确认的会话标识不一致，已禁止发送。')
    if (typeof snapshot.userId !== 'string' || !snapshot.userId || typeof snapshot.hostId !== 'string' || !snapshot.hostId) throw fail('服务会话身份无效，已禁止发送。')
    if (typeof snapshot.epoch !== 'string' || !snapshot.epoch) throw fail('服务事件代次无效，已禁止发送。')
    if (this._identity && (snapshot.userId !== this._identity.userId || snapshot.hostId !== this._identity.hostId)) throw fail('服务确认的会话身份已变化，已禁止发送。')
    this._identity = { userId: snapshot.userId, hostId: snapshot.hostId }
    this._epoch = snapshot.epoch
    this._messageBodyLimit = Number.isSafeInteger(snapshot.messageBodyMaxBytes) && snapshot.messageBodyMaxBytes >= 131072 && snapshot.messageBodyMaxBytes <= 256 * 1024 * 1024 ? snapshot.messageBodyMaxBytes : MESSAGE_BODY_LIMIT
    this._running = Boolean(snapshot.running)
    this._activeRequestId = typeof snapshot.requestId === 'string' ? snapshot.requestId : ''
    this._renderStatus()
  }

  /**
   * 释放本地待确认预留。只有确定服务端没有执行该请求时才会主动调用；
   * 返回被释放的原文，供用户重新发送，绝不自动重发。
   */
  async _releasePending(requestId) {
    if (!this._storage || typeof this._storage.release !== 'function') return ''
    const state = validateState(await this._storage.read())
    const pending = state.pending
    if (!pending || (requestId && pending.requestId !== requestId)) return ''
    await this._storage.release(pending.requestId)
    // 预留已移除：立即重绘，避免“本地待确认”气泡继续留在界面上。
    try { this._paint(validateState(await this._storage.read())) } catch (_) {}
    return pending.text
  }
  _restoreDraft(text) {
    if (!text || !this._input) return
    if (!this._input.value.trim()) this._input.value = text
    this._updateControls()
  }

  async _openStorage() {
    const storage = this._options.storage
    const adapter = await storage.open({ sessionId: this._sessionId, userId: this._identity.userId, hostId: this._identity.hostId, epoch: this._epoch })
    if (!adapter || typeof adapter !== 'object') throw fail('宿主 Storage Adapter 未返回实例，已禁止发送。')
    for (const name of PANEL_STORAGE_METHODS) {
      if (typeof adapter[name] !== 'function') throw fail('宿主 Storage Adapter 缺少 ' + name + '，已禁止发送。')
    }
    this._storage = adapter
    return validateState(await adapter.read())
  }

  _suspend() {
    if (this._suspended || !this._connected) return
    this._suspended = true
    this._stopTransport()
    this._ready = false
    this._setStatus('已暂停（组件未挂载）')
    this._updateControls()
    this._emit('suspend', {})
  }

  async _resume() {
    this._suspended = false
    if (!this._storage) { try { await this.connect(this._options) } catch (_) {} return }
    this._abort = new AbortController()
    try {
      this._setStatus('正在连接')
      await this._syncEvents()
      await this._refreshApprovals()
      const resumed = validateState(await this._storage.read())
      if (resumed.pending) {
        const active = Boolean(this._activeRequestId && resumed.pending.requestId === this._activeRequestId)
        if (!active) {
          const released = await this._releasePending(resumed.pending.requestId)
          if (released) {
            this._restoreDraft(released)
          } else {
            this._uncertainWrite = true
            this._uncertainMessage = '消息发送结果尚未确认，可能仍在执行。请核对服务端结果；不会自动重发。'
            this._ready = false
            this._blocked = true
            this._setStatus('需要核对')
            this._setError(this._uncertainMessage)
            this._updateControls()
            this._schedulePoll()
            return this
          }
        }
      }
      this._ready = true
      this._blocked = false
      this._setError('')
      this._renderStatus()
      this._attachHostConnector()
      this._schedulePoll()
      this._loadModelSettings().catch(() => {})
      this._emit('resume', {})
    } catch (error) {
      this._handleStartFailure(error)
    }
  }

  /* ---------- 认证 ---------- */

  async _ensureToken(force) {
    if (this._options.auth.cookie) {
      this._cookie = true
      if (this._options.auth.launch) {
        const credential = await this._options.auth.launch()
        if (credential) {
          await this._request('/launch', { method: 'POST', body: { credential } }, true)
          if (this._options.auth.launch) this._options.auth.launch = null
        }
      }
      return ''
    }
    if (!force && this._token && this._tokenExpiresAt > Date.now() + 5000) return this._token
    const auth = this._options.auth
    if (typeof auth.ticket === 'function') {
      const ticket = await auth.ticket({ sessionId: this._sessionId || this._options.sessionId })
      if (!ticket || typeof ticket.credential !== 'string' || !ticket.credential) throw fail('宿主未提供有效的面板票据。')
      const id = ticket.sessionId || this._sessionId || this._options.sessionId
      if (!id) throw fail('宿主未提供会话标识。')
      this._sessionId = id
      const result = await this._request('/panel-token', { method: 'POST', body: { credential: ticket.credential } }, true)
      if (!result || typeof result.token !== 'string' || !result.token) throw fail('服务未返回有效的会话令牌。')
      this._token = result.token
      this._tokenExpiresAt = Number(result.expiresAt) || 0
      return this._token
    }
    const value = typeof auth.token === 'function' ? await auth.token() : auth.token
    if (typeof value !== 'string' || !value) throw fail('宿主未提供有效的会话令牌。')
    if (!this._sessionId) this._sessionId = this._options.sessionId || ''
    if (!this._sessionId) throw fail('缺少会话标识。')
    this._token = value
    this._tokenExpiresAt = Date.now() + 3600000
    return this._token
  }

  _endpoint() {
    if (!this._sessionId) throw fail('缺少会话标识。')
    return this._options.endpoint + '/api/v1/sessions/' + encodeURIComponent(this._sessionId)
  }

  async _request(path, options, skipRefresh) {
    const settings = options || {}
    const signal = settings.signal || (this._abort && this._abort.signal)
    const headers = {}
    if (!this._cookie && this._token && path !== '/panel-token' && path !== '/launch') headers.authorization = 'Bearer ' + this._token
    if (settings.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(this._endpoint() + path, {
      method: settings.method || (settings.body === undefined ? 'GET' : 'POST'),
      headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      credentials: this._cookie ? 'include' : 'omit',
      cache: 'no-store',
      signal
    })
    if (response.status === 401 && !skipRefresh && !this._cookie) {
      await this._ensureToken(true)
      return this._request(path, options, true)
    }
    if (!response.ok) {
      let code = ''
      try { code = (await response.json()).error || '' } catch (_) {}
      if (response.status === 413 || code === 'BODY_TOO_LARGE') throw fail(this._sizeError(), response.status)
      throw fail(response.status === 401 ? '会话授权已失效，请重新注入凭证。' : '服务请求失败（HTTP ' + response.status + (code ? ' / ' + code : '') + '）', response.status)
    }
    return response.status === 204 ? null : response.json()
  }

  async _requestRoot(path, options, skipRefresh) {
    const settings = options || {}
    const signal = settings.signal || (this._abort && this._abort.signal)
    const headers = {}
    if (!this._cookie && this._token && path !== '/panel-token' && path !== '/launch') headers.authorization = 'Bearer ' + this._token
    if (settings.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(this._options.endpoint + path, {
      method: settings.method || (settings.body === undefined ? 'GET' : 'POST'),
      headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      credentials: this._cookie ? 'include' : 'omit',
      cache: 'no-store',
      signal
    })
    if (response.status === 401 && !skipRefresh && !this._cookie) {
      await this._ensureToken(true)
      return this._requestRoot(path, options, true)
    }
    if (!response.ok) {
      let code = ''
      try { code = (await response.json()).error || '' } catch (_) {}
      throw fail('服务请求失败（HTTP ' + response.status + (code ? ' / ' + code : '') + '）', response.status)
    }
    return response.status === 204 ? null : response.json()
  }

  /* ---------- 模型设置 ---------- */

  async _loadModelSettings() {
    try {
      const view = await this._requestRoot('/api/v1/settings/models')
      if (!view || !Array.isArray(view.models)) return
      this._modelSettings = view
      this._models = view.models
      this._closeModelMenu()
    } catch (_) {
      this._modelSettings = null
      this._models = null
    }
    this._renderModelLabel()
  }

  _renderModelLabel() {
    if (this._modelButton) {
      const current = this._modelSettings && this._modelSettings.models.find(model => model.id === this._modelSettings.currentModelId)
      this._modelLabel.textContent = modelDisplayName(current)
      this._modelButton.title = this._modelSettings ? '切换模型' : '配置模型'
    }
    if (!this._modelMenuOpen) this._renderModelMenu()
  }

  _renderModelMenu() {
    if (!this._modelMenu) return
    this._modelMenu.replaceChildren()
    if (!this._modelSettings) {
      const note = document.createElement('p')
      note.className = 'panel-model-note'
      note.textContent = '服务未开放模型设置，请联系管理员配置。'
      this._modelMenu.appendChild(note)
      return
    }
    for (const model of this._modelSettings.models) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'panel-model-item' + (model.id === this._modelSettings.currentModelId ? ' is-current' : '')
      item.setAttribute('role', 'menuitem')
      const name = document.createElement('span')
      name.textContent = modelDisplayName(model)
      item.appendChild(name)
      if (model.id === this._modelSettings.currentModelId) {
        const check = document.createElement('span')
        check.className = 'panel-model-check'
        check.textContent = '✓'
        item.appendChild(check)
      }
      item.addEventListener('click', () => { this._closeModelMenu(); this._selectModel(model.id) })
      this._modelMenu.appendChild(item)
    }
    const manage = document.createElement('button')
    manage.type = 'button'
    manage.className = 'panel-model-manage'
    manage.setAttribute('role', 'menuitem')
    manage.textContent = '模型设置…'
    manage.addEventListener('click', () => { this._closeModelMenu(); this._openModelDialog() })
    this._modelMenu.appendChild(manage)
  }

  _toggleModelMenu() {
    if (this._modelMenuOpen) return this._closeModelMenu()
    this._renderModelMenu()
    this._modelMenuOpen = true
    this._modelMenu.hidden = false
    this._modelButton.setAttribute('aria-expanded', 'true')
  }

  _closeModelMenu() {
    if (!this._modelMenu || !this._modelMenuOpen) return
    this._modelMenuOpen = false
    this._modelMenu.hidden = true
    this._modelButton.setAttribute('aria-expanded', 'false')
  }

  async _selectModel(id) {
    if (!this._modelSettings || id === this._modelSettings.currentModelId) return
    try {
      const view = await this._requestRoot('/api/v1/settings/models', { method: 'PUT', body: { currentModelId: id } })
      if (view && Array.isArray(view.models)) { this._modelSettings = view; this._models = view.models }
      this._renderModelLabel()
      this._setStatus('已切换模型')
      setTimeout(() => { if (!this._destroyed) this._renderStatus() }, 1200)
      this._emit('model', { modelId: id })
    } catch (error) {
      this._setError(this._message(error))
    }
  }

  _openModelDialog() {
    if (!this._modelSettings || this._dialogOpen) return
    this._dialogOpen = true
    this._renderModelCards(this._modelSettings.models, this._modelSettings.currentModelId)
    this._maxIterations.value = String(this._modelSettings.maxIterations || 100)
    this._dialogError.hidden = true
    this._overlay.hidden = false
    const first = this._modelList.querySelector('.panel-model-card-toggle')
    if (first) first.focus()
    else this._dialogSave.focus()
  }

  _closeModelDialog() {
    if (!this._dialogOpen) return
    this._dialogOpen = false
    this._overlay.hidden = true
    this._modelButton.focus()
  }

  _dialogKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); this._closeModelDialog(); return }
    if (event.key !== 'Tab') return
    const focusable = Array.from(this._dialog.querySelectorAll('input, button')).filter(element => !element.disabled && element.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0], last = focusable[focusable.length - 1]
    const active = this.shadowRoot.activeElement
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
  }

  _renderModelCards(models, currentId) {
    this._modelList.replaceChildren()
    for (const model of models) this._modelList.appendChild(this._modelCard(model, models.length, currentId))
  }

  _modelCard(model, count, currentId, open = false) {
    const card = document.createElement('div')
    card.className = 'panel-model-card'
    card.dataset.id = model.id
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'panel-model-card-toggle'
    toggle.setAttribute('aria-expanded', String(open))
    const heading = document.createElement('span')
    heading.textContent = modelDisplayName(model)
    toggle.appendChild(heading)
    toggle.insertAdjacentHTML('beforeend', HISTORY_PENCIL_SVG)
    const body = document.createElement('div')
    body.className = 'panel-model-card-body'
    body.hidden = !open
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden
      toggle.setAttribute('aria-expanded', String(!body.hidden))
    })
    card.append(toggle, body)
    const fields = [
      ['显示名称', 'name', model.name || '', 'text'],
      ['API 地址', 'baseURL', model.baseURL || '', 'text'],
      ['模型', 'model', model.model || '', 'text'],
      ['API 密钥', 'apiKey', model.apiKey || '', 'password']
    ]
    for (const [label, field, value, type] of fields) {
      const row = document.createElement('label')
      row.className = 'panel-field'
      const title = document.createElement('span')
      title.textContent = label
      const input = document.createElement('input')
      input.type = type
      input.dataset.field = field
      input.value = value
      if (field === 'apiKey') input.placeholder = model.hasApiKey ? '已保存，留空保持不变' : '未设置'
      row.append(title, input)
      body.appendChild(row)
      if (field === 'name' || field === 'model') input.addEventListener('input', () => {
        heading.textContent = modelDisplayName({ id: model.id, name: body.querySelector('[data-field="name"]').value, model: (body.querySelector('[data-field="model"]') || {}).value || model.model })
      })
    }
    const footer = document.createElement('div')
    footer.className = 'panel-model-card-footer'
    const active = document.createElement('label')
    active.className = 'panel-model-active'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'panel-active-model'
    radio.value = model.id
    radio.checked = model.id === currentId
    active.append(radio, document.createTextNode('当前使用'))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'panel-link-button'
    remove.textContent = '删除'
    remove.disabled = count <= 1
    remove.addEventListener('click', () => {
      card.remove()
      const cards = this._modelList.querySelectorAll('.panel-model-card')
      if (cards.length === 1) cards[0].querySelector('.panel-link-button').disabled = true
      if (!this._modelList.querySelector('input[name="panel-active-model"]:checked') && cards.length) cards[0].querySelector('input[name="panel-active-model"]').checked = true
    })
    footer.append(active, remove)
    body.appendChild(footer)
    return card
  }

  _addModelCard() {
    const cards = this._modelList.querySelectorAll('.panel-model-card')
    const model = { id: 'model_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: '新模型 ' + (cards.length + 1), baseURL: '', model: '', hasApiKey: false }
    const current = this._modelList.querySelector('input[name="panel-active-model"]:checked')
    const card = this._modelCard(model, cards.length + 1, current ? current.value : model.id, true)
    for (const existing of cards) existing.querySelector('.panel-link-button').disabled = false
    this._modelList.appendChild(card)
    card.querySelector('input').focus()
  }

  _collectModels() {
    const cards = Array.from(this._modelList.querySelectorAll('.panel-model-card'))
    return cards.map(card => {
      const field = name => card.querySelector('[data-field="' + name + '"]').value.trim()
      const model = { id: card.dataset.id, name: field('name'), baseURL: field('baseURL'), model: field('model') }
      const apiKey = card.querySelector('[data-field="apiKey"]').value.trim()
      if (apiKey) model.apiKey = apiKey
      return model
    })
  }

  async _saveModels() {
    const models = this._collectModels()
    if (!models.length) { this._showDialogError('至少保留一个模型。'); return }
    if (models.some(model => !model.model)) { this._showDialogError('请填写每个模型的模型名称。'); return }
    const active = this._modelList.querySelector('input[name="panel-active-model"]:checked')
    const currentModelId = active ? active.value : models[0].id
    const maxIterations = Number(this._maxIterations.value) || 100
    this._dialogSave.disabled = true
    try {
      const view = await this._requestRoot('/api/v1/settings/models', { method: 'PUT', body: { models, currentModelId, maxIterations } })
      if (view && Array.isArray(view.models)) { this._modelSettings = view; this._models = view.models }
      this._renderModelLabel()
      this._dialogOpen = false
      this._overlay.hidden = true
      this._modelButton.focus()
      this._setStatus('模型设置已保存')
      setTimeout(() => { if (!this._destroyed) this._renderStatus() }, 1200)
      this._emit('model', { modelId: currentModelId })
    } catch (error) {
      this._showDialogError(this._message(error))
    } finally {
      this._dialogSave.disabled = false
    }
  }

  _showDialogError(text) {
    this._dialogError.textContent = text
    this._dialogError.hidden = false
  }

  async _snapshot() {
    const snapshot = await this._request('')
    if (!this._sessionId && snapshot && snapshot.sessionId) this._sessionId = snapshot.sessionId
    return snapshot
  }

  /* ---------- 事件同步 ---------- */

  async _syncEvents(allowRebase) {
    let state = validateState(await this._storage.read())
    if (state.gap) throw fail('本地会话存在事件缺口，无法安全恢复。')
    if (state.epoch !== this._epoch) {
      const snapshot = await this._snapshot()
      if (snapshot.epoch !== this._epoch) throw fail('服务代次发生变化，正在恢复。')
      if (allowRebase === false) throw fail('服务代次已变化且存在未确认操作，已禁止发送。')
      const released = state.pending ? await this._releasePending(state.pending.requestId) : ''
      if (state.pending && !released) throw fail('服务代次已变化且存在未确认操作，已禁止发送。')
      if (released) this._restoreDraft(released)
      this._epoch = snapshot.epoch
      state = validateState(await this._storage.rebase(this._epoch, Boolean(released)))
      this._running = Boolean(snapshot.running)
      this._activeRequestId = typeof snapshot.requestId === 'string' ? snapshot.requestId : ''
    }
    const result = await this._request('/events?after=' + encodeURIComponent(state.cursor) + '&epoch=' + encodeURIComponent(state.epoch))
    if (!result || !Array.isArray(result.events)) throw fail('服务事件数据无效。')
    if (result.gap || result.epoch !== state.epoch) {
      if (allowRebase === false) throw fail('服务事件历史存在缺口。')
      const snapshot = await this._snapshot()
      // 新代次从游标 0 开始提供事件，可重新跟上当前会话（包括正在执行的任务）。
      const released = state.pending ? await this._releasePending(state.pending.requestId) : ''
      if (state.pending && !released) throw fail('服务事件代次已变化且存在未确认操作，已禁止发送。')
      if (released) this._restoreDraft(released)
      this._epoch = snapshot.epoch
      state = validateState(await this._storage.rebase(this._epoch, Boolean(released)))
      this._running = Boolean(snapshot.running)
      this._activeRequestId = typeof snapshot.requestId === 'string' ? snapshot.requestId : ''
      return this._syncEvents(false)
    }
    const entries = result.events
    const contiguous = entries.every((entry, index) => entry && entry.sequence === state.cursor + index + 1)
    const last = entries.length ? entries[entries.length - 1].sequence : state.cursor
    if (!contiguous || result.cursor !== last) throw fail('事件序列不连续，无法安全恢复。')
    // 空闲轮询没有新事件时不要重绘：整表替换会把用户正在上翻的阅读位置拉回底部。
    if (!entries.length) return
    try { state = validateState(await this._storage.apply(state.cursor, state.epoch, entries)) }
    catch (error) {
      if (error.message === '其他页面已更新会话，请重试同步。') return this._syncEvents(allowRebase)
      throw error
    }
    const finishedIndex = entries.reduce((last, entry, index) => entry.event.type === 'finished' ? index : last, -1)
    if (finishedIndex !== -1) {
      this._messages.querySelectorAll('[data-transient]').forEach(element => element.remove())
      this._streams.clear()
      this._clearNotice()
    }
    this._paint(state)
    this._paintTransient(entries, finishedIndex)
    try { await this._request('/events/ack', { method: 'POST', body: { epoch: state.epoch, cursor: state.cursor } }) } catch (_) {}
  }

  _schedulePoll() {
    if (this._timer) clearTimeout(this._timer)
    const delay = this._pollFailures ? Math.min(10000, 1000 * Math.pow(2, Math.min(this._pollFailures - 1, 4))) : (this._running ? POLL_RUNNING_MS : POLL_IDLE_MS)
    this._timer = setTimeout(() => this._poll(), delay)
  }

  _stopTransport() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this._abort) { try { this._abort.abort() } catch (_) {} this._abort = null }
  }

  async _poll() {
    if (this._destroyed || this._suspended || !this._connected) return
    try {
      await this._syncEvents()
      const snapshot = await this._snapshot()
      this._acceptSnapshot(snapshot)
      await this._refreshApprovals()
      this._pollFailures = 0
      if (this._uncertainWrite && (await this._storage.read()).pending) {
        this._ready = false
        this._blocked = true
        this._setStatus('需要核对')
        this._setError(this._uncertainMessage || '消息发送结果尚未确认，可能仍在执行。请核对服务端结果；不会自动重发。')
        this._updateControls()
        this._schedulePoll()
        return
      }
      this._uncertainWrite = false
      this._ready = true
      this._blocked = false
      this._setError('')
      this._updateControls()
      this._renderStatus()
      this._emit('status', { running: this._running })
    } catch (error) {
      if (this._destroyed || this._suspended || !this._connected || (error && error.name === 'AbortError')) return
      this._pollFailures += 1
      this._ready = false
      const blocked = /缺口|代次|未确认|已变化|不匹配|无效/.test(String(error && error.message || ''))
      if (blocked) {
        this._blocked = true
        this._setStatus('需要核对')
        this._emit('blocked', { message: this._message(error) })
      } else {
        this._setStatus('连接中断，正在重试')
      }
      this._setError(this._uncertainWrite ? '连接中断，消息发送结果尚未确认。请核对服务端结果；不会自动重发。' : this._message(error))
      this._updateControls()
      if (blocked) return
    }
    this._schedulePoll()
  }

  /* ---------- 交互 ---------- */

  _sizeError() {
    return '消息及会话上下文超过服务允许的大小（' + this._messageBodyLimit + ' 字节），请新建会话或减少消息内容；现有历史未删除。模型上下文限制另计。'
  }

  async _submit(event) {
    if (event) event.preventDefault()
    const text = this._input.value.trim()
    if (!this._ready || this._busy || this._running || !text) return
    this._busy = true
    this._updateControls()
    let writeUnconfirmed = false
    try {
      await this._syncEvents()
      const snapshot = await this._snapshot()
      this._acceptSnapshot(snapshot)
      if (this._running) throw fail('当前会话正在执行，请等待结束。')
      // A previous turn may have finished between the first event read and the
      // snapshot. Apply its terminal event before reserving the next requestId.
      await this._syncEvents()
      const state = validateState(await this._storage.read())
      const requestId = this._requestId()
      const candidate = state.pending || { text, requestId, history: state.messages.filter(item => item.role !== 'system'), memory: state.memory }
      if (messageBodySize({ text: candidate.text, requestId: candidate.requestId, history: candidate.history, memory: candidate.memory }) > this._messageBodyLimit) throw fail(this._sizeError())
      const pending = await this._storage.reserve(text, requestId, state.cursor)
      this._paint(validateState(await this._storage.read()))
      const body = { text: pending.text, requestId: pending.requestId, history: pending.history, memory: pending.memory }
      writeUnconfirmed = true
      if (messageBodySize(body) > this._messageBodyLimit) throw fail(this._sizeError(), 413)
      const receipt = await this._request('/messages', { method: 'POST', body })
      writeUnconfirmed = false
      if (receipt && typeof receipt.status === 'string' && receipt.status !== 'running') {
        // 服务端已有同一 requestId 的回执：本次不会重新执行，按回执恢复本地状态。
        this._input.value = ''
        await this._syncEvents()
        const latest = validateState(await this._storage.read())
        if (latest.pending) {
          this._blocked = true
          const message = '上一条消息在服务端已结束（状态：' + receipt.status + '），结果未确认。请核对后点击“我已核对，重新同步”。'
          this._setError(message)
          this._emit('blocked', { message })
        } else {
          this._clearNotice()
          this._setError('')
        }
        this._renderStatus()
        return
      }
      this._input.value = ''
      this._running = true
      this._renderStatus()
      this._clearNotice()
      this._setError('')
    } catch (error) {
      const status = error && error.status
      // 服务端明确拒绝（4xx）表示请求未进入执行：释放预留、恢复原文并继续跟随当前会话。
      if (writeUnconfirmed && Number.isInteger(status) && status >= 400 && status < 500) {
        const released = await this._releasePending()
        if (released) this._restoreDraft(released)
        writeUnconfirmed = false
        try { this._acceptSnapshot(await this._snapshot()) } catch (_) {}
        this._ready = true
        this._blocked = false
        this._uncertainWrite = false
        this._notice = status === 409
          ? '当前会话正在执行，这条消息尚未发送；已放回输入框，可稍后发送。'
          : status === 413 ? this._sizeError() : this._message(error)
        this._showNotice()
        this._renderStatus()
        this._emit('error', { message: this._notice, status })
        return
      }
      const message = writeUnconfirmed && !(error && error.status === 413) ? '消息发送结果尚未确认，可能仍在执行。请核对服务端结果；不会自动重发。' : this._message(error)
      // 未确认的写入只通过读取事件对账，绝不自动重发。
      if (writeUnconfirmed) {
        this._uncertainWrite = true
        this._uncertainMessage = message
        this._blocked = true
        this._ready = false
        this._renderStatus()
        this._emit('blocked', { message })
      } else if (/上一条消息的结果尚未确认/.test(message)) {
        this._blocked = true
        this._renderStatus()
        this._emit('blocked', { message })
      } else {
        this._emit('error', { message, status: error && error.status })
      }
      this._setError(message)
      if (!writeUnconfirmed && message === this._sizeError()) this._notice = message
    } finally {
      this._busy = false
      this._updateControls()
      this._schedulePoll()
    }
  }

  async _cancel() {
    if (!this._ready || this._busy || !this._running) return
    this._busy = true
    this._updateControls()
    try {
      await this._request('/cancel', { method: 'POST', body: {} })
      this._setStatus('正在停止')
    } catch (error) { this._setError(this._message(error)) }
    finally { this._busy = false; this._updateControls() }
  }

  _requestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
  }

  async _refreshApprovals() {
    const result = await this._request('/approvals')
    if (!result || !Array.isArray(result.approvals)) throw fail('审批数据格式无效。')
    await this._storage.saveApprovals(result.approvals)
    this._renderApprovals(result.approvals)
  }

  async _decide(item, approved, remember) {
    if (this._busy) return
    this._busy = true
    this._updateControls()
    try {
      await this._storage.approvalDecision(item.id, approved, 'pending')
      await this._request('/approvals/' + encodeURIComponent(item.id), { method: 'POST', body: { approved, ...(remember ? { remember } : {}) } })
      await this._storage.approvalDecision(item.id, approved, 'confirmed')
      this._approvalsKey = ''
      await this._refreshApprovals()
      this._setError('')
      this._emit('approval', { id: item.id, approved, ...(remember ? { remember } : {}) })
    } catch (error) {
      this._setError(this._message(error))
      try { await this._storage.approvalDecision(item.id, approved, 'failed') } catch (_) {}
    } finally {
      this._busy = false
      this._updateControls()
    }
  }

  /* ---------- 宿主 Host Connector ---------- */

  _attachHostConnector() {
    const connector = this._options.hostConnector
    if (!connector || typeof connector.attach !== 'function') return
    try {
      connector.attach({ sessionId: this._sessionId, emit: (type, detail) => this._emit(type, detail) })
    } catch (error) { this._setError('宿主 Host Connector 附加失败：' + this._message(error)) }
  }

  _detachHostConnector() {
    const connector = this._options && this._options.hostConnector
    if (!connector || typeof connector.detach !== 'function') return
    Promise.resolve().then(() => connector.detach()).catch(() => {})
  }

  _emit(type, detail) {
    const payload = Object.assign({ type, sessionId: this._sessionId }, detail || {})
    if (this._options && typeof this._options.onEvent === 'function') {
      try { this._options.onEvent(payload) } catch (_) {}
    }
  }

  /* ---------- 渲染 ---------- */

  _build() {
    const style = document.createElement('style')
    style.textContent = PANEL_CSS
    const root = document.createElement('div')
    root.className = 'panel'
    root.setAttribute('part', 'panel')
    root.innerHTML = [
      '<div class="panel-topbar" part="actions">',
      '  <button type="button" class="panel-icon-button panel-history" title="历史会话" aria-label="历史会话"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></button>',
      '  <button type="button" class="panel-icon-button panel-new" title="新建会话" aria-label="新建会话"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.2a8 8 0 0 1-11.6 7.1L4 19.5l1.3-4.6A8 8 0 1 1 20.5 11.2Z"/><path d="M12 8v6M9 11h6"/></svg></button>',
      '  <span class="panel-state" role="status">未连接</span>',
      '  <div class="panel-history-popover" part="history" role="dialog" aria-label="历史会话" hidden>',
      '    <label class="panel-history-search">',
      '      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
      '      <input type="search" class="panel-history-input" placeholder="搜索会话" aria-label="搜索会话" autocomplete="off">',
      '    </label>',
      '    <div class="panel-history-list" role="listbox" aria-label="历史会话"></div>',
      '    <p class="panel-history-status" role="status" hidden></p>',
      '  </div>',
      '</div>',
      '<div class="panel-error" role="alert" hidden><span></span><button type="button" class="panel-button panel-resync" hidden title="确认上一条消息的结果后，丢弃本地未确认标记并恢复当前会话">我已核对，重新同步</button><button type="button" class="panel-button panel-reconnect" hidden>重新连接</button></div>',
      '<div class="panel-messages-wrap">',
      '  <section class="panel-messages" part="messages" aria-label="会话消息" aria-live="polite"></section>',
      '  <div class="panel-scroll-thumb" aria-hidden="true" hidden></div>',
      '</div>',
      '<section class="panel-approvals" part="approvals" hidden><h2>待处理审批</h2><div class="panel-approval-list"></div></section>',
      '<form class="panel-composer" part="composer">',
      '  <div class="panel-composer-card">',
      '    <textarea rows="2" aria-label="发送消息" placeholder="描述任务；Enter 发送，Shift + Enter 换行"></textarea>',
      '    <div class="panel-toolbar">',
      '      <div class="panel-model-wrap">',
      '        <button type="button" class="panel-model-trigger" aria-haspopup="menu" aria-expanded="false" title="切换模型"><span class="panel-model-label">模型设置</span><svg class="panel-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>',
      '        <div class="panel-model-menu" role="menu" hidden></div>',
      '      </div>',
      '      <button type="submit" class="panel-icon-button panel-send" title="发送" aria-label="发送" disabled><svg class="panel-send-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg><svg class="panel-stop-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" hidden><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>',
      '    </div>',
      '  </div>',
      '</form>',
      '<div class="panel-overlay" hidden>',
      '  <div class="panel-dialog" role="dialog" aria-modal="true" aria-labelledby="panel-model-title">',
      '    <h2 id="panel-model-title">模型设置</h2>',
      '    <p class="panel-dialog-hint">配置模型接口与密钥；密钥只保存在 Agent Service，界面不回显。</p>',
      '    <div class="panel-model-list"></div>',
      '    <button type="button" class="panel-add-model">＋ 添加模型</button>',
      '    <label class="panel-field"><span>最大轮次</span><input type="number" class="panel-max-iterations" min="1" max="500"></label>',
      '    <p class="panel-dialog-error" role="alert" hidden></p>',
      '    <div class="panel-dialog-actions"><button type="button" class="panel-button panel-dialog-cancel">取消</button><button type="button" class="panel-button panel-primary panel-dialog-save">保存</button></div>',
      '  </div>',
      '</div>'
    ].join('\n')
    this.shadowRoot.append(style, root)
    this._panel = root
    this._status = root.querySelector('.panel-state')
    this._history = root.querySelector('.panel-history')
    this._newSession = root.querySelector('.panel-new')
    this._historyPopover = root.querySelector('.panel-history-popover')
    this._historyInput = root.querySelector('.panel-history-input')
    this._historyList = root.querySelector('.panel-history-list')
    this._historyStatus = root.querySelector('.panel-history-status')
    this._error = root.querySelector('.panel-error')
    this._errorText = root.querySelector('.panel-error span')
    this._reconnect = root.querySelector('.panel-reconnect')
    this._resync = root.querySelector('.panel-resync')
    this._messages = root.querySelector('.panel-messages')
    this._messagesWrap = root.querySelector('.panel-messages-wrap')
    this._scrollThumb = root.querySelector('.panel-scroll-thumb')
    this._approvals = root.querySelector('.panel-approvals')
    this._approvalList = root.querySelector('.panel-approval-list')
    this._composer = root.querySelector('.panel-composer')
    this._input = root.querySelector('textarea')
    this._send = root.querySelector('.panel-send')
    this._sendIcon = root.querySelector('.panel-send-icon')
    this._stopIcon = root.querySelector('.panel-stop-icon')
    this._modelButton = root.querySelector('.panel-model-trigger')
    this._modelLabel = root.querySelector('.panel-model-label')
    this._modelMenu = root.querySelector('.panel-model-menu')
    this._overlay = root.querySelector('.panel-overlay')
    this._dialog = root.querySelector('.panel-dialog')
    this._modelList = root.querySelector('.panel-model-list')
    this._addModel = root.querySelector('.panel-add-model')
    this._maxIterations = root.querySelector('.panel-max-iterations')
    this._dialogError = root.querySelector('.panel-dialog-error')
    this._dialogCancel = root.querySelector('.panel-dialog-cancel')
    this._dialogSave = root.querySelector('.panel-dialog-save')
    this._messages.addEventListener('scroll', () => this._updateScrollThumb())
    if (typeof ResizeObserver === 'function') {
      this._messagesResize = new ResizeObserver(() => this._updateScrollThumb())
      this._messagesResize.observe(this._messagesWrap)
    }
    this._composer.addEventListener('submit', event => this._submit(event))
    this._input.addEventListener('input', () => this._updateControls())
    this._input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        if (!this._running && !this._send.disabled) this._composer.requestSubmit()
      }
    })
    this._history.addEventListener('click', event => { event.stopPropagation(); this._action('history') })
    this._newSession.addEventListener('click', event => { event.stopPropagation(); this._action('new-session') })
    this._historyPopover.addEventListener('click', event => event.stopPropagation())
    this._historyInput.addEventListener('input', () => {
      this._historyQuery = this._historyInput.value.trim().toLowerCase()
      this._paintHistory()
    })
    this._historyPopover.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      this._closeHistory()
      if (this._history) this._history.focus()
    })
    this._send.addEventListener('click', event => { if (this._running) { event.preventDefault(); this._cancel() } })
    this._reconnect.addEventListener('click', () => { this._reconnect.hidden = true; this.reconnect().catch(() => {}) })
    this._resync.addEventListener('click', () => { this._resync.hidden = true; this._forceResync() })
    this._modelButton.addEventListener('click', event => { event.stopPropagation(); this._toggleModelMenu() })
    this._modelMenu.addEventListener('click', event => event.stopPropagation())
    this._panel.addEventListener('click', () => { this._closeModelMenu(); this._closeHistory() })
    this._addModel.addEventListener('click', () => this._addModelCard())
    this._dialogCancel.addEventListener('click', () => this._closeModelDialog())
    this._dialogSave.addEventListener('click', () => this._saveModels())
    this._overlay.addEventListener('click', event => { if (event.target === this._overlay) this._closeModelDialog() })
    this._dialog.addEventListener('keydown', event => this._dialogKeydown(event))
    this._applyTitle()
    this._updateControls()
  }

  _applyTitle() {
    // 标题不占界面行；宿主自己展示会话名称，这里只保留可访问名称。
    if (this._panel) this._panel.setAttribute('aria-label', this._title)
  }

  async _action(name) {
    if (name === 'history') {
      this._emit('history', {})
      const handler = this._options && this._options.onHistory
      if (typeof handler === 'function') {
        try { await handler({ sessionId: this._sessionId }) } catch (error) { this._setError(this._message(error)) }
        return
      }
      // 宿主没有接管时使用组件内置列表，保证按钮永远有可预期的行为。
      await this._toggleHistory()
      return
    }
    this._emit('new-session', {})
    const handler = this._options && this._options.onNewSession
    if (typeof handler === 'function') {
      try { await handler({ sessionId: this._sessionId }) } catch (error) { this._setError(this._message(error)) }
      return
    }
    try { await this.startNewSession() } catch (error) { this._setError(this._message(error)) }
  }

  /* ---------- 会话切换与内置历史会话 ---------- */

  async switchSession(sessionId) {
    if (this._destroyed || !this._options) throw fail('组件尚未初始化。')
    if (typeof sessionId !== 'string' || !sessionId) throw fail('会话标识无效。')
    if (this._running) throw fail('正在执行，结束或取消后再切换会话。')
    this._closeHistory()
    this._prepareSessionChange()
    this._sessionId = sessionId
    this._options.sessionId = sessionId
    await this._restart('正在切换会话')
    this._emit('session-change', { sessionId: this._sessionId })
    return this._sessionId
  }

  async startNewSession() {
    if (this._destroyed || !this._options) throw fail('组件尚未初始化。')
    if (this._running) throw fail('正在执行，结束或取消后再新建会话。')
    this._closeHistory()
    this._prepareSessionChange()
    this._sessionId = ''
    this._options.sessionId = ''
    await this._restart('正在新建会话')
    this._emit('session-change', { sessionId: this._sessionId })
    return this._sessionId
  }

  _prepareSessionChange() {
    this._stopTransport()
    this._abort = null
    this._token = ''
    this._tokenExpiresAt = 0
    this._cookie = false
    this._storage = null
    this._identity = null
    this._epoch = ''
    this._state = null
    this._ready = false
    this._blocked = false
    this._running = false
    this._busy = false
    this._approvalsKey = ''
    this._streams.clear()
    this._setError('')
    this._resetView()
  }

  _resetView() {
    if (!this._messages) return
    this._messages.replaceChildren()
    const empty = document.createElement('p')
    empty.className = 'panel-empty'
    empty.textContent = '还没有消息，开始与 Agent 对话。'
    this._messages.appendChild(empty)
    this._renderApprovals([])
    this._updateControls()
    this._updateScrollThumb()
  }

  async _restart(status) {
    this._setStatus(status || '正在连接')
    if (this._starting) { try { await this._starting } catch (_) {} }
    this._starting = this._start().finally(() => { this._starting = null })
    await this._starting
  }

  async _toggleHistory() {
    if (this._historyOpen) { this._closeHistory(); return }
    await this._openHistory()
  }

  async _openHistory() {
    if (!this._historyPopover) return
    this._historyOpen = true
    this._historyPopover.hidden = false
    this._historyQuery = ''
    this._historyInput.value = ''
    await this._loadHistory()
    this._historyInput.focus()
  }

  _closeHistory() {
    if (!this._historyPopover || !this._historyOpen) return
    this._historyOpen = false
    this._historyPopover.hidden = true
  }

  async _loadHistory() {
    this._historyItems = null
    this._setHistoryStatus('正在读取会话…')
    const adapter = this._storage
    if (!adapter) { this._setHistoryStatus('会话尚未连接，暂时无法读取历史。'); return }
    if (typeof adapter.listSessions !== 'function') { this._setHistoryStatus('宿主未提供历史会话列表。'); return }
    try {
      const items = await adapter.listSessions()
      this._historyItems = (Array.isArray(items) ? items : [])
        .filter(item => item && typeof item.sessionId === 'string' && item.sessionId)
        .sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0))
    } catch (error) {
      this._historyItems = null
      this._setHistoryStatus(this._message(error))
      return
    }
    this._paintHistory()
  }

  _setHistoryStatus(text) {
    if (!this._historyStatus) return
    this._historyStatus.textContent = text || ''
    this._historyStatus.hidden = !text
  }

  _paintHistory() {
    const list = this._historyList
    if (!list) return
    list.replaceChildren()
    this._setHistoryStatus('')
    if (!this._historyItems) return
    const query = this._historyQuery
    const items = query
      ? this._historyItems.filter(item => sessionLabel(item).toLowerCase().indexOf(query) !== -1)
      : this._historyItems
    if (!items.length) {
      this._setHistoryStatus(this._historyItems.length ? '没有匹配的会话。' : '暂无历史会话。')
      return
    }
    for (const item of items) list.appendChild(this._historyRow(item))
  }

  _historyRow(item) {
    const row = document.createElement('div')
    const current = item.sessionId === this._sessionId
    row.className = 'panel-history-row' + (current ? ' is-current' : '')
    row.setAttribute('role', 'option')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-selected', current ? 'true' : 'false')
    row.title = sessionLabel(item)
    const name = document.createElement('span')
    name.className = 'panel-history-name'
    name.textContent = sessionLabel(item)
    const time = document.createElement('span')
    time.className = 'panel-history-time'
    time.textContent = relativeTime(item.updatedAt)
    const actions = document.createElement('span')
    actions.className = 'panel-history-actions'
    actions.append(
      this._historyAction('rename', item, '重命名会话', HISTORY_PENCIL_SVG),
      this._historyAction('delete', item, '删除会话', HISTORY_TRASH_SVG)
    )
    row.append(name, time, actions)
    row.addEventListener('click', event => {
      if (event.target && event.target.closest && event.target.closest('.panel-history-actions')) return
      this._selectSession(item.sessionId)
    })
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      this._selectSession(item.sessionId)
    })
    return row
  }

  _historyAction(kind, item, label, icon) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'panel-history-action' + (kind === 'delete' ? ' is-danger' : '')
    button.title = label
    button.setAttribute('aria-label', label + '：' + sessionLabel(item))
    button.innerHTML = icon
    button.addEventListener('click', event => {
      event.stopPropagation()
      const row = button.closest('.panel-history-row')
      if (kind === 'rename') this._beginRename(item, row)
      else this._beginDelete(item, row)
    })
    return button
  }

  _beginRename(item, row) {
    if (!row) return
    const name = row.querySelector('.panel-history-name')
    if (!name || row.querySelector('input')) return
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'panel-history-rename-input'
    input.maxLength = 40
    input.value = sessionLabel(item)
    input.setAttribute('aria-label', '会话名称')
    name.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = async save => {
      if (done) return
      done = true
      const value = save ? input.value.trim().slice(0, 40) : ''
      if (!value || value === sessionLabel(item)) { this._paintHistory(); return }
      const adapter = this._storage
      if (!adapter || typeof adapter.renameSession !== 'function') {
        this._setHistoryStatus('宿主存储不支持重命名会话。')
        this._paintHistory()
        return
      }
      try {
        await adapter.renameSession(item.sessionId, value)
        item.name = value
        this._emit('session-rename', { sessionId: item.sessionId, name: value })
      } catch (error) {
        this._setHistoryStatus(this._message(error))
        return
      }
      this._paintHistory()
    }
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); finish(true) }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => { if (!done) finish(true) })
  }

  _beginDelete(item, row) {
    if (!row) return
    const name = row.querySelector('.panel-history-name')
    const actions = row.querySelector('.panel-history-actions')
    if (!name || !actions) return
    const text = document.createElement('span')
    text.className = 'panel-history-confirm-text'
    text.textContent = '删除「' + sessionLabel(item) + '」？'
    const group = document.createElement('span')
    group.className = 'panel-history-actions is-confirm'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'panel-history-text-button'
    cancel.textContent = '取消'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'panel-history-text-button is-danger'
    remove.textContent = '删除'
    group.append(cancel, remove)
    name.replaceWith(text)
    const time = row.querySelector('.panel-history-time')
    if (time) time.remove()
    actions.replaceWith(group)
    cancel.addEventListener('click', event => { event.stopPropagation(); this._paintHistory() })
    remove.addEventListener('click', async event => {
      event.stopPropagation()
      const adapter = this._storage
      if (!adapter || typeof adapter.deleteSession !== 'function') { this._setHistoryStatus('宿主存储不支持删除会话。'); return }
      const deletingCurrent = item.sessionId === this._sessionId
      try {
        await adapter.deleteSession(item.sessionId)
        this._emit('session-delete', { sessionId: item.sessionId })
      } catch (error) { this._setHistoryStatus(this._message(error)); return }
      this._historyItems = (this._historyItems || []).filter(entry => entry.sessionId !== item.sessionId)
      if (deletingCurrent) {
        this._closeHistory()
        try { await this.startNewSession() } catch (error) { this._setError(this._message(error)) }
        return
      }
      this._paintHistory()
    })
    cancel.focus()
  }

  async _selectSession(sessionId) {
    if (!sessionId || sessionId === this._sessionId) { this._closeHistory(); return }
    if (this._running) { this._setHistoryStatus('正在执行，结束或取消后再切换会话。'); return }
    this._closeHistory()
    try { await this.switchSession(sessionId) } catch (error) { this._setError(this._message(error)) }
  }

  _applyTheme() {
    const mode = this._theme.mode === 'auto'
      ? (this._themeMedia && this._themeMedia.matches ? 'light' : 'dark')
      : this._theme.mode
    this._panel.dataset.theme = mode
    for (const key of this._themeApplied) this._panel.style.removeProperty(key)
    this._themeApplied = Object.keys(this._theme.variables)
    for (const key of this._themeApplied) this._panel.style.setProperty(key, this._theme.variables[key])
  }

  _setStatus(text) { if (this._status) this._status.textContent = text }
  _setError(text) {
    // 自动对账给出的提示不是错误；普通状态刷新不应清掉它。
    if (!text && this._notice) { this._showNotice(); return }
    this._notice = ''
    this._error.classList.remove('is-info')
    this._errorText.textContent = text || ''
    this._error.hidden = !text
    this._resync.hidden = !this._blocked || /缺口/.test(text || '')
    this._reconnect.hidden = !this._blocked && !(text && /授权|凭证|HTTP|连接/.test(text))
  }
  _showNotice() {
    this._error.classList.add('is-info')
    this._error.hidden = false
    this._errorText.textContent = this._notice
    this._resync.hidden = true
    this._reconnect.hidden = true
  }
  _clearNotice() {
    if (!this._notice) return
    this._notice = ''
    if (this._error && this._error.classList.contains('is-info')) {
      this._error.classList.remove('is-info')
      this._error.hidden = true
      this._errorText.textContent = ''
    }
  }
  _message(error) {
    if (error && (error.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed/i.test(error.message || ''))) return '无法连接 Agent Service，请检查服务地址、网络及跨域设置。'
    return error && error.message ? error.message : '请求失败，请检查网络后重试。'
  }
  _renderStatus() {
    this._setStatus(this._blocked ? '需要核对' : (this._running ? '正在生成…' : (this._ready ? '' : '正在连接')))
    this._updateControls()
  }
  _updateControls() {
    if (!this._send) return
    const settling = !this._running && Boolean(this._state && this._state.pending)
    this._send.disabled = !this._ready || this._busy || (!this._running && (!this._input.value.trim() || settling))
    this._input.disabled = !this._ready
    this._send.title = this._running ? '停止' : settling ? '正在同步上一条消息结果' : '发送'
    this._send.setAttribute('aria-label', this._running ? '停止执行' : '发送')
    this._sendIcon.hidden = this._running
    this._stopIcon.hidden = !this._running
  }

  _paint(state) {
    this._state = state
    this._cursor = state.cursor
    // 重绘前记录阅读位置：用户不在底部时保持原位，只有贴底时才继续跟随新消息。
    const stick = this._nearBottom()
    const offset = this._messages ? this._messages.scrollTop : 0
    // 未完成的流式消息不在持久化历史中；重绘时保留它们及其 DOM 引用。
    const transient = Array.from(this._messages.querySelectorAll('[data-transient]'))
    this._messages.replaceChildren()
    for (const message of state.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const text = message.role === 'user' ? visibleUserText(message.content) : textOf(message.content)
      if (text) this._bubble(message.role, text)
    }
    if (state.pending) this._bubble('user', state.pending.text + '\n[本地待确认，请核对服务端结果]')
    transient.forEach(element => this._messages.appendChild(element))
    if (!this._messages.childNodes.length) {
      const empty = document.createElement('p')
      empty.className = 'panel-empty'
      empty.textContent = '还没有消息，开始与 Agent 对话。'
      this._messages.appendChild(empty)
    }
    this._renderApprovals(state.approvals)
    this._renderStatus()
    if (stick) this._scrollToBottom()
    else if (this._messages) this._messages.scrollTop = offset
    this._updateScrollThumb()
  }

  _paintTransient(entries, finishedIndex = -1) {
    const stick = this._nearBottom()
    for (const [index, entry] of entries.entries()) {
      const event = entry && entry.event
      if (!event) continue
      // 完成事件后的持久化历史已包含本轮消息，不能再绘制同批的临时消息。
      if (event.type === 'assistant:delta' && index > finishedIndex) this._delta(event)
      else if (event.type === 'assistant:message' && index > finishedIndex) this._assistantFinal(event)
      else if (event.type === 'tool:start' || event.type === 'tool:result') this._toolEvent(event, true)
      else if (event.type === 'finished') {
        this._streams.forEach(stream => stream.wrapper.remove())
        this._streams.clear()
        this._running = false
        this._renderStatus()
        this._emit('finished', { requestId: event.requestId || '', failed: Boolean(event.failed) })
      } else if (event.type === 'status') {
        this._setStatus(String(event.text || '正在执行').slice(0, 120))
      }
    }
    if (stick) this._scrollToBottom()
    this._updateScrollThumb()
  }

  _stream(requestId) {
    const key = String(requestId || '')
    let stream = this._streams.get(key)
    if (stream) return stream
    const wrapper = this._bubble('assistant', '', true)
    wrapper.dataset.transient = 'true'
    stream = { el: wrapper.querySelector('.panel-bubble-body'), text: '', wrapper }
    this._streams.set(key, stream)
    return stream
  }

  _delta(event) {
    const stick = this._nearBottom()
    const stream = this._stream(event.requestId)
    stream.text += String(event.text || '')
    stream.el.dataset.raw = stream.text
    // 流式期间也按 Markdown 渲染；节流避免每个增量都重建 DOM。
    if (!stream.timer) {
      stream.timer = setTimeout(() => {
        stream.timer = null
        if (stream.el.isConnected) this._setContent(stream.el, stream.text, true)
        if (stick) this._scrollToBottom()
        this._updateScrollThumb()
      }, 60)
    }
  }

  _nearBottom() {
    const el = this._messages
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  _scrollToBottom() {
    const el = this._messages
    if (el) el.scrollTop = el.scrollHeight
    this._updateScrollThumb()
  }

  // 原生滚动条隐藏，改用右侧悬浮细拇指：不占内容宽度，悬停时显示。
  _updateScrollThumb() {
    const area = this._messages
    const thumb = this._scrollThumb
    if (!area || !thumb) return
    const overflow = area.scrollHeight - area.clientHeight
    if (overflow < 4) { thumb.hidden = true; return }
    const height = Math.max(28, Math.round(area.clientHeight * area.clientHeight / area.scrollHeight))
    const maxTop = Math.max(0, area.clientHeight - height)
    const top = Math.round((area.scrollTop / overflow) * maxTop)
    thumb.hidden = false
    thumb.style.height = height + 'px'
    thumb.style.transform = 'translateY(' + top + 'px)'
  }

  _focusInput() {
    if (!this._input || this._input.disabled) return
    if (this._options && this._options.autoFocus === false) return
    try { this._input.focus({ preventScroll: true }) } catch (_) { this._input.focus() }
  }

  _assistantFinal(event) {
    const stream = this._streams.get(String(event.requestId || ''))
    const text = String(event.text || '')
    if (stream) {
      if (stream.timer) { clearTimeout(stream.timer); stream.timer = null }
      this._setContent(stream.el, text, true)
      stream.wrapper.classList.remove('streaming')
      this._streams.delete(String(event.requestId || ''))
      if (!text.trim()) stream.wrapper.remove()
      return
    }
    if (text.trim()) this._bubble('assistant', text).dataset.transient = 'true'
  }

  _bubble(role, text, streaming) {
    const wrapper = document.createElement('div')
    wrapper.className = 'panel-bubble ' + role + (streaming ? ' streaming' : '')
    const label = document.createElement('div')
    label.className = 'panel-bubble-label'
    label.textContent = role === 'user' ? '你' : 'Agent'
    const header = document.createElement('div')
    header.className = 'panel-bubble-header'
    header.append(label)
    const body = document.createElement('div')
    body.className = 'panel-bubble-body'
    this._setContent(body, text, role === 'assistant')
    body.querySelectorAll('.knowledge-citation').forEach(button => {
      const note = document.createElement('span')
      note.textContent = '[来源请在桌面端查看]'
      button.replaceWith(note)
    })
    if (role === 'assistant') header.append(this._copyControl(body))
    if (text) wrapper.dataset.raw = String(text)
    wrapper.append(header, body)
    this._messages.appendChild(wrapper)
    return wrapper
  }

  // 回复气泡的复制操作：优先 Clipboard API，不可用时退回文本框选择。
  _copyControl(body) {
    const row = document.createElement('div')
    row.className = 'panel-bubble-actions'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'panel-bubble-copy'
    button.textContent = '复制'
    button.setAttribute('aria-label', '复制回复内容')
    button.addEventListener('click', () => {
      const value = body.dataset.raw !== undefined ? body.dataset.raw : body.innerText
      if (!value) return
      void this._copyText(value).then(ok => {
        button.textContent = ok ? '已复制' : '复制失败'
        clearTimeout(button._copyTimer)
        button._copyTimer = setTimeout(() => { button.textContent = '复制' }, 1500)
      })
    })
    row.append(button)
    return row
  }

  async _copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch (_) { /* 权限或安全上下文限制时使用回退方案 */ }
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-9999px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch (_) { return false }
  }

  _setContent(body, text, markdown) {
    const value = String(text === undefined || text === null ? '' : text)
    body.dataset.raw = value
    if (markdown && typeof renderMarkdown === 'function') {
      body.innerHTML = renderMarkdown(value)
      if (typeof highlightAll === 'function') highlightAll(body)
    } else body.textContent = value
  }

  _toolEvent(event, live) {
    if (!live) return
    if (event.type === 'tool:start') this._emit('tool', { phase: 'start', name: event.name || '' })
    else if (event.type === 'tool:result') this._emit('tool', { phase: 'result', name: event.name || '', outcome: event.outcome || '' })
  }

  _renderApprovals(items) {
    const key = JSON.stringify(items || [])
    if (this._approvalsKey === key) return
    this._approvalsKey = key
    this._approvalList.replaceChildren()
    this._approvals.hidden = !items || items.length === 0
    for (const item of items || []) {
      const card = document.createElement('article')
      card.className = 'panel-approval'
      const request = item.request || {}
      const description = String(request.description || '').trim()
      const title = document.createElement('strong')
      title.textContent = description ? '需要你的确认' : String(request.title || '操作需要你的确认')
      const summary = document.createElement('p')
      summary.className = 'panel-approval-summary'
      summary.textContent = description || 'AI 准备修改当前内容，确认后才会执行。'
      const detail = document.createElement('details')
      detail.className = 'panel-approval-detail'
      const detailLabel = document.createElement('summary')
      detailLabel.textContent = '查看技术详情'
      const detailBody = document.createElement('pre')
      detailBody.textContent = valueText(request.detail === undefined ? request : request.detail)
      detail.append(detailLabel, detailBody)
      const expires = document.createElement('p')
      expires.className = 'panel-approval-expires'
      if (item.expiresAt) expires.textContent = '有效期至：' + new Date(item.expiresAt).toLocaleString()
      const actions = document.createElement('div')
      actions.className = 'panel-actions'
      const deny = document.createElement('button')
      deny.type = 'button'; deny.className = 'panel-button'; deny.textContent = '拒绝'
      const approve = document.createElement('button')
      approve.type = 'button'; approve.className = 'panel-button panel-primary'; approve.textContent = '确认'
      // 会话级授权：本会话后续工具调用不再逐个确认，Service 重启或会话结束后失效。
      const remember = document.createElement('button')
      remember.type = 'button'; remember.className = 'panel-button'; remember.textContent = '本会话全部允许'
      remember.title = '本会话后续工具调用不再逐个确认；Service 重启或会话结束后失效'
      deny.addEventListener('click', () => this._decide(item, false))
      approve.addEventListener('click', () => this._decide(item, true))
      remember.addEventListener('click', () => this._decide(item, true, 'session'))
      actions.append(deny, approve, remember)
      card.append(title, summary, detail, expires, actions)
      this._approvalList.appendChild(card)
      this._emit('approval-request', { id: item.id })
    }
  }
}

if (!customElements.get('agent-panel')) customElements.define('agent-panel', AgentPanelElement)

function defineAgentPanel() {
  if (!customElements.get('agent-panel')) customElements.define('agent-panel', AgentPanelElement)
  return AgentPanelElement
}

const AgentPanel = Object.freeze({
  tag: 'agent-panel',
  version: VERSION,
  element: AgentPanelElement,
  define: defineAgentPanel,
  async mount(container, options) {
    if (!container || typeof container.appendChild !== 'function') throw fail('mount 需要有效的容器元素。')
    defineAgentPanel()
    const element = document.createElement('agent-panel')
    element.style.display = 'block'
    container.appendChild(element)
    try { await element.connect(options) } catch (error) {
      // 保留需要人工核对的面板及恢复按钮；其他挂载失败仍按原契约抛出。
      if (!element.blocked) { element.remove(); throw error }
    }
    return element
  },
  unmount(element) {
    if (!element) return
    if (typeof element.disconnect === 'function') element.disconnect()
    if (element.parentNode) element.parentNode.removeChild(element)
  }
})
