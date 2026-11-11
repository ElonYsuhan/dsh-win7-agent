'use strict'

// One record per authenticated service identity. Read/modify/write operations use
// a single IndexedDB transaction, which serializes writers across browser tabs.
;(function () {
  function open(identity) {
    if (!window.indexedDB) return Promise.reject(new Error('浏览器无法使用 IndexedDB，已禁止发送。'))
    const key = JSON.stringify([identity.userId, identity.hostId, identity.sessionId])
    let currentEpoch = identity.epoch
    return new Promise((resolve, reject) => {
      let request
      try { request = indexedDB.open('agent-service-sessions', 1) } catch (_) { reject(new Error('无法打开本地会话存储，已禁止发送。')); return }
      request.onupgradeneeded = () => request.result.createObjectStore('sessions')
      request.onerror = () => reject(new Error('无法打开本地会话存储，已禁止发送。'))
      request.onblocked = () => reject(new Error('本地会话存储被其他页面阻塞，请关闭其他页面。'))
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        function transaction(update) {
          return new Promise((done, fail) => {
            let tx, result, reason
            try {
              tx = db.transaction('sessions', 'readwrite')
              const store = tx.objectStore('sessions')
              const get = store.get(key)
              get.onsuccess = () => {
                try {
                  const state = get.result || { epoch: identity.epoch, cursor: 0, messages: [], memory: null, pending: null, events: [], approvals: [], gap: false }
                  result = update(state)
                  store.put(state, key)
                } catch (error) { reason = error; tx.abort() }
              }
              get.onerror = () => { reason = new Error('读取本地会话失败，已禁止发送。') }
              tx.oncomplete = () => done(result)
              tx.onabort = tx.onerror = () => fail(reason || new Error('本地会话事务失败，已禁止发送。'))
            } catch (_) { fail(new Error('本地会话存储不可用，已禁止发送。')) }
          })
        }
        resolve({
          read: () => transaction(state => state),
          reserve: (text, id, expected) => transaction(state => {
            if (state.cursor !== expected) throw new Error('其他页面已更新会话，请重新发送。')
            if (state.gap || state.epoch !== currentEpoch) throw new Error('事件历史存在缺口或服务代次已变化，无法安全发送。')
            if (state.pending) {
              if (state.pending.text !== text) throw new Error('上一条消息的结果尚未确认，只能重试原消息。')
              return state.pending
            }
            state.pending = { text, requestId: id, history: state.messages.filter(item => item.role !== 'system'), memory: state.memory, after: state.cursor }
            return state.pending
          }),
          saveApprovals: approvals => transaction(state => { state.approvals = approvals; return state }),
          approvalDecision: (id, approved, status) => transaction(state => {
            if (!state.approvalHistory) state.approvalHistory = []
            state.approvalHistory.push({ id, approved, status, at: Date.now() })
          }),
          markGap: () => transaction(state => { state.gap = true; return state }),
          rebase: (epoch, force) => transaction(state => {
            if (state.gap) throw new Error('服务重启时仍有未确认操作，请先核对结果。')
            if (state.pending && !force) throw new Error('服务重启时仍有未确认操作，请先核对结果。')
            if (force) state.pending = null
            state.epoch = epoch
            state.cursor = 0
            currentEpoch = epoch
            return state
          }),
          apply: (expected, epoch, entries) => transaction(state => {
            if (state.gap || state.epoch !== epoch) throw new Error('事件历史存在缺口或服务代次已变化，无法安全恢复。')
            if (state.cursor !== expected) throw new Error('其他页面已更新会话，请重试同步。')
            for (const entry of entries) {
              if (!entry || entry.sequence !== state.cursor + 1 || !entry.event || typeof entry.event.type !== 'string') throw new Error('事件序列不连续，无法安全恢复。')
              const event = entry.event
              if (event.type === 'finished') {
                if (!Array.isArray(event.messages) || !Object.prototype.hasOwnProperty.call(event, 'memory')) throw new Error('完成事件缺少完整本地历史或记忆，无法安全恢复。')
                if (event.messages.some(item => !item || typeof item.role !== 'string' || item.role === 'system')) throw new Error('完成事件包含无效历史，无法安全恢复。')
                if (state.pending && event.requestId !== state.pending.requestId) throw new Error('完成事件与待确认请求不匹配，无法安全恢复。')
                state.messages = event.messages
                state.memory = event.memory
                if (state.pending) state.pending = null
              }
              state.events.push(entry)
              state.cursor = entry.sequence
            }
            return state
          })
        })
      }
    })
  }
  window.agentSessionDB = Object.freeze({ open })
})()
