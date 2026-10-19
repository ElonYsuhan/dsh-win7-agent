'use strict'

;(function () {
  const not = (value) => value ? false : true

  if (not(window.dsh)) {
  const listeners = []
  let eventSource = null
  const SEND_TIMEOUT_MS = 3660000
  const EVENTS_CONNECT_TIMEOUT_MS = 10000
  const nativeShell = window.shell && typeof window.shell.pickFolder === 'function' ? window.shell : null

  function dispatch(event) {
    for (const listener of listeners.slice()) {
      try {
        listener(event)
      } catch (error) {
        console.error('[web-bridge] listener failed', error)
      }
    }
  }

  function ensureEvents() {
    if (eventSource) return
    eventSource = new EventSource('/api/events')
    eventSource.onopen = () => dispatch({ type: 'connection', connected: true })
    eventSource.onmessage = (message) => {
      try {
        dispatch(JSON.parse(message.data))
      } catch (error) {
        console.error('[web-bridge] bad event', error)
      }
    }
    eventSource.onerror = () => {
      dispatch({ type: 'connection', connected: false, message: '事件连接断开，正在自动重连' })
      dispatch({ type: 'status', text: 'event stream disconnected' })
    }
  }

  function waitForEvents() {
    ensureEvents()
    const source = eventSource
    if (source.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer)
        source.removeEventListener('open', onOpen)
        source.removeEventListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onOpen = () => finish()
      const onError = () => finish(new Error('AGENT_EVENT_DISCONNECTED'))
      const timer = setTimeout(() => finish(new Error('AGENT_EVENT_CONNECT_TIMEOUT')), EVENTS_CONNECT_TIMEOUT_MS)
      source.addEventListener('open', onOpen)
      source.addEventListener('error', onError)
    })
  }

  async function request(method, target, body) {
    const options = { method, headers: { 'content-type': 'application/json' } }
    if (body !== undefined) options.body = JSON.stringify(body)
    const response = await fetch(target, options)
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (response.ok) return data
    const message = data && data.error ? data.error : ('HTTP_' + response.status)
    throw new Error(message)
  }

  window.dsh = {
    isDesktop: not(nativeShell) ? false : true,
    getState: () => request('GET', '/api/state'),
    saveSettings: (patch) => request('POST', '/api/settings', patch),
    pickWorkspace: async () => {
      const current = await request('GET', '/api/state')
      const chosen = nativeShell ? await nativeShell.pickFolder() : await window.appDialogs.prompt('服务器工作区路径', current.workspacePath || '')
      if (not(chosen)) return current.workspacePath
      const state = await request('POST', '/api/workspace', { path: chosen })
      return state.workspacePath
    },
    setWorkspace: (target) => request('POST', '/api/workspace', { path: target }),
    pickFolder: () => nativeShell ? nativeShell.pickFolder() : Promise.reject(new Error('NO_NATIVE_PICKER')),
    listServerDir: (target) => request('GET', '/api/fs/list' + (target ? '?path=' + encodeURIComponent(target) : '')),
    pickNativeFolder: () => request('POST', '/api/fs/pick-native', {}),
    mkdirServerDir: (target, name) => request('POST', '/api/fs/mkdir', { path: target, name }),
    createWorkspace: async () => {
      const current = await request('GET', '/api/state')
      const chosen = nativeShell ? await nativeShell.pickFolder() : await window.appDialogs.prompt('新建工作区路径', current.workspacePath || '')
      if (not(chosen)) return current.workspacePath
      const state = await request('POST', '/api/workspace', { path: chosen })
      return state.workspacePath
    },
    clearWorkspace: async () => {
      const state = await request('POST', '/api/settings', { workspacePath: '' })
      return state.workspacePath
    },
    saveAsset: (payload) => request('POST', '/api/assets', payload),
    listModels: (payload) => request('POST', '/api/models', payload),
    /* ---- 右侧文件面板（见 server/file-api.js）----
       fsRawUrl 是给 <img> / <iframe> / fetch 直接用的**相对地址**，
       不是请求 API —— 面板靠它判断「后端在不在」，返回空串就说明要走 IPC。 */
    fsRoots: () => request('GET', '/api/fs/roots'),
    fsTree: (target, depth) => request('GET', '/api/fs/tree?depth=' + (Number(depth) || 1) +
      (target ? '&path=' + encodeURIComponent(target) : '')),
    fsFile: (target) => request('GET', '/api/fs/file?path=' + encodeURIComponent(target)),
    fsRawUrl: (target) => '/api/fs/raw?path=' + encodeURIComponent(target),
    fsPreviewUrl: (target) => Promise.resolve('/api/fs/raw?path=' + encodeURIComponent(target)),
    /* 编辑保存：data 是 base64（字节由渲染层的 encodeText 按原编码产出），
       expectedMtime 不匹配 → 409 MTIME_CONFLICT。与 preload.js 签名一致。 */
    fsWrite: (target, data, expectedMtime) => request('POST', '/api/fs/write', { path: target, data, expectedMtime }),
    /* 渲染层会话/偏好 storage（ui-store.json，见 server/ui-store.js）。
       localStorage 按 origin（协议+主机+端口）隔离，端口一换就是新空间 ——
       这份服务端存储跟端口无关，是「换端口记录还在」的那半边。
       与 src/main/preload.js 的 IPC 版签名一致。 */
    taskRequest: (action, data) => action === 'list' ? request('GET', '/api/tasks') : action === 'conversation' ? request('GET', '/api/tasks/conversation?runId='+encodeURIComponent(data.runId)) : request('POST', '/api/tasks'+(action==='save'?'':'/'+action),data),
    workflowRequest: (action,data) => action==='list'?request('GET','/api/workflows'):request('POST','/api/workflows/'+action,data||{}),
    knowledgeRequest: (action, data) => action === 'list' ? request('GET', '/api/knowledge') : request('POST', '/api/knowledge/' + action, data || {}),
    knowledgeUpload: async (raw, file) => { const query = new URLSearchParams(raw); const response = await fetch('/api/knowledge/import?' + query.toString(), { method: 'POST', body: file }); const value = await response.json(); if (!response.ok) throw new Error(value.error || 'KNOWLEDGE_IMPORT_FAILED'); return value },
    extensionRequest: (action, data) => action === 'list' ? request('GET', '/api/extensions') : request('POST', '/api/extensions/' + action, data || {}),
    mcpRequest: (action, data) => action === 'list' ? request('GET', '/api/mcp') : request('POST', '/api/mcp/' + action, data || {}),
    uiStoreGet: () => request('GET', '/api/ui-store'),
    uiStorePut: (store) => request('PUT', '/api/ui-store', store),
    /* ---- 终端（三期，与 src/main/preload.js 同一套接口）----
       订阅走独立 SSE：连上先补发服务端缓冲（replay），再实时块；
       EventSource 断线自动重连，重连 = 重新 replay，历史不丢。 */
    termState: (sid) => request('GET', '/api/terminal/state' + (sid ? '?sid=' + encodeURIComponent(sid) : '')),
    termStart: (cwd) => request('POST', '/api/terminal/start', { cwd }),
    termWrite: (sid, text) => request('POST', '/api/terminal/write', { sid, text }),
    termKill: (sid) => request('POST', '/api/terminal/kill', { sid }),
    termSubscribe: (sid, callback) => {
      const source = new EventSource('/api/terminal/events?sid=' + encodeURIComponent(sid || ''))
      source.addEventListener('terminal', (message) => {
        try { callback(JSON.parse(message.data)) } catch (error) {}
      })
      let closed = false
      return () => {
        if (closed) return
        closed = true
        source.close()
      }
    },
    readAsset: async (id) => {
      const response = await fetch('/api/assets/' + encodeURIComponent(id))
      if (not(response.ok)) throw new Error('ASSET_NOT_FOUND')
      const blob = await response.blob()
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      return { id, mime: blob.type, dataUrl }
    },
    /* sessionId = 这条消息属于哪条会话。后端是多实例池（一条会话一台 worker），
       所以 send 只认**这条会话**的收尾事件 —— 并发时别的会话的 finished
       不能把这次 send 结掉（否则第二条会话的 promise 会被提前 resolve）。 */
    send: (text, history, images, memory, sessionId) => {
      return new Promise((resolve, reject) => {
        let settled = false
        let timer = null
        const finish = (error, value) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          off()
          if (error) reject(error)
          else resolve(value)
        }
        const off = window.dsh.onEvent((event) => {
          if (sessionId && event.sessionId && String(event.sessionId) !== String(sessionId)) return
          if (event.type === 'finished') {
            finish(null, true)
          }
          if (event.type === 'error') {
            finish(null, false)
          }
        })
        timer = setTimeout(() => finish(new Error('AGENT_EVENT_TIMEOUT')), SEND_TIMEOUT_MS)
        /* 首条消息也要先等事件流连上。POST 比 SSE 建连快时，快速完成的
           finished 会在订阅前丢掉，界面会一直停在「思考中」。 */
        waitForEvents().then(() => {
          if (settled) return
          return request('POST', '/api/chat', { text, history, images, memory, sessionId })
        }).catch((error) => {
          finish(error)
        })
      })
    },
    stop: (sessionId) => request('POST', '/api/stop', { sessionId }),
    resetChat: (sessionId) => request('POST', '/api/reset', { sessionId }),
    clearChat: (sessionId) => request('POST', '/api/clear', { sessionId }),
    openPath: async (target) => {
      if (not(nativeShell) || typeof nativeShell.openPath !== 'function') throw new Error('NO_NATIVE_OPENER')
      const error = await nativeShell.openPath(target)
      if (error) throw new Error(String(error))
      return ''
    },
    /* 浏览器里直接开新标签；noopener 防止新页面拿到 window.opener */
    openExternal: (target) => {
      const link = String(target || '')
      if (nativeShell && typeof nativeShell.openExternal === 'function') return nativeShell.openExternal(link)
      if (/^https?:\/\//i.test(link)) window.open(link, '_blank', 'noopener')
      return Promise.resolve('OK')
    },
    approve: (id, approved) => request('POST', '/api/approve', { id, approved }),
    onEvent: (callback) => {
      ensureEvents()
      listeners.push(callback)
      return () => {
        const index = listeners.indexOf(callback)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  }
  window.addEventListener('beforeunload', () => {
    listeners.length = 0
    if (eventSource) eventSource.close()
    eventSource = null
  })
  }
})()
