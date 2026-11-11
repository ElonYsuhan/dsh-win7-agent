'use strict'

// Deliberately independent of web-bridge / Electron preload. Only one session's
// explicitly scoped HTTP endpoints are reachable through this capability.
;(function () {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(location.pathname)
  const sessionId = match ? decodeURIComponent(match[1]) : ''
  const base = '/api/v1/sessions/' + encodeURIComponent(sessionId)
  let credential = new URLSearchParams(location.hash.slice(1)).get('launch')
  // Clear before the first request, including invalid/expired credentials.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)

  async function request(path, body, signal) {
    if (!sessionId) throw new Error('会话地址无效')
    const options = { credentials: 'same-origin', cache: 'no-store', signal }
    if (body !== undefined) {
      options.method = 'POST'
      options.headers = { 'Content-Type': 'application/json' }
      options.body = JSON.stringify(body)
    }
    const response = await fetch(base + path, options)
    if (!response.ok) {
      const error = new Error(response.status === 401 ? '会话授权已失效，请从桌面重新打开链接。' : '请求失败（HTTP ' + response.status + '）')
      error.status = response.status
      throw error
    }
    return response.status === 204 ? null : response.json()
  }

  async function launch() {
    if (!credential) return
    const value = credential
    credential = null
    await request('/launch', { credential: value })
  }

  function requestId() {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
  }

  window.agentSessionBridge = Object.freeze({
    sessionId, launch, requestId,
    snapshot: signal => request('', undefined, signal),
    events: (after, epoch, signal) => request('/events?after=' + encodeURIComponent(after) + '&epoch=' + encodeURIComponent(epoch), undefined, signal),
    acknowledge: (epoch, cursor) => request('/events/ack', { epoch, cursor }),
    send: pending => request('/messages', { text: pending.text, requestId: pending.requestId, history: pending.history, memory: pending.memory }),
    cancel: () => request('/cancel', {}),
    approvals: signal => request('/approvals', undefined, signal),
    approve: (id, approved) => request('/approvals/' + encodeURIComponent(id), { approved })
  })
})()
