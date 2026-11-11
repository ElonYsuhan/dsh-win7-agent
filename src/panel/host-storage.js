'use strict'

// 参考宿主 Storage Adapter（ESM）。由宿主在自己的页面加载并注入 agent-panel；
// 组件本身不创建数据库。数据保存在**宿主页面 Origin** 的 IndexedDB 中，
// 按 Service 确认的 userId、hostId、sessionId 分区。
// 宿主可复制此实现并按自身数据库规范调整，但必须保持方法契约与事务提交语义。

function firstUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (const message of messages) {
    if (!message || message.role !== 'user') continue
    const content = message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(part => typeof part === 'string' ? part : (part && (part.text || '')) || '').join('')
        : ''
    const line = String(text || '').trim().split('\n')[0].slice(0, 40)
    if (line) return line
  }
  return ''
}

export function createHostStorage(options) {
  const settings = options || {}
  const databaseName = settings.databaseName || 'agent-panel-sessions'
  const factory = settings.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null)
  if (!factory) throw new Error('宿主浏览器无法使用 IndexedDB。')

  function openDatabase() {
    return new Promise((resolve, reject) => {
      let request
      try { request = factory.open(databaseName, 1) } catch (_) { reject(new Error('无法打开宿主会话存储。')); return }
      request.onupgradeneeded = () => request.result.createObjectStore('sessions')
      request.onerror = () => reject(new Error('无法打开宿主会话存储。'))
      request.onblocked = () => reject(new Error('宿主会话存储被其他页面阻塞。'))
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        resolve(db)
      }
    })
  }

  return {
    async open(identity) {
      if (!identity || typeof identity.sessionId !== 'string' || !identity.sessionId) throw new Error('会话身份无效，无法使用宿主存储。')
      if (typeof identity.userId !== 'string' || typeof identity.hostId !== 'string' || typeof identity.epoch !== 'string') throw new Error('会话身份无效，无法使用宿主存储。')
      const db = await openDatabase()
      const key = JSON.stringify([identity.userId, identity.hostId, identity.sessionId])
      const keyFor = sessionId => JSON.stringify([identity.userId, identity.hostId, sessionId])
      // 服务重启会更换事件代次；rebase 成功后同步本适配器的期望代次。
      let currentEpoch = identity.epoch

      function transaction(update, target) {
        return new Promise((resolve, reject) => {
          let tx, result, reason
          try {
            tx = db.transaction('sessions', 'readwrite')
            const store = tx.objectStore('sessions')
            const get = store.get(target || key)
            get.onsuccess = () => {
              try {
                const state = get.result || { epoch: identity.epoch, cursor: 0, messages: [], memory: null, pending: null, events: [], approvals: [], gap: false }
                result = update(state, Boolean(get.result))
                if (target && !get.result) throw new Error('会话不存在。')
                store.put(state, target || key)
              } catch (error) { reason = error; tx.abort() }
            }
            get.onerror = () => { reason = new Error('读取宿主会话失败。') }
            tx.oncomplete = () => resolve(result)
            tx.onabort = tx.onerror = () => reject(reason || new Error('宿主会话事务失败。'))
          } catch (_) { reject(new Error('宿主会话存储不可用。')) }
        })
      }

      return {
        read: () => transaction(state => state),
        reserve: (text, id, expected) => transaction(state => {
          if (state.cursor !== expected) throw new Error('其他页面已更新会话，请重新发送。')
          if (state.gap || state.epoch !== currentEpoch) throw new Error('事件历史存在缺口或服务代次已变化，无法安全发送。')
          if (state.pending) {
            if (state.pending.text !== text) throw new Error('上一条消息的结果尚未确认，只能重试原消息。')
            return state.pending
          }
          state.pending = { text, requestId: id, history: state.messages.filter(item => item.role !== 'system'), memory: state.memory, after: state.cursor }
          state.updatedAt = Date.now()
          return state.pending
        }),
        release: id => transaction(state => {
          if (state.pending && state.pending.requestId === id) state.pending = null
          return state
        }),
        saveApprovals: approvals => transaction(state => { state.approvals = approvals; return state }),
        approvalDecision: (id, approved, status) => transaction(state => {
          if (!state.approvalHistory) state.approvalHistory = []
          state.approvalHistory.push({ id, approved, status, at: Date.now() })
          return state
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
          state.updatedAt = Date.now()
          return state
        }),

        // 以下三个方法供组件的内置历史列表使用；宿主可自行实现自己的会话页，
        // 但保持同样的返回结构（sessionId/name/preview/updatedAt）即可复用组件。
        listSessions() {
          return new Promise((resolve, reject) => {
            let tx
            try { tx = db.transaction('sessions', 'readonly') } catch (_) { reject(new Error('读取宿主会话列表失败。')); return }
            const store = tx.objectStore('sessions')
            const keysRequest = store.getAllKeys()
            const valuesRequest = store.getAll()
            tx.oncomplete = () => {
              const keys = keysRequest.result || []
              const values = valuesRequest.result || []
              const items = []
              for (let index = 0; index < keys.length; index++) {
                let parts
                try { parts = JSON.parse(keys[index]) } catch (_) { continue }
                if (!Array.isArray(parts) || parts[0] !== identity.userId || parts[1] !== identity.hostId || typeof parts[2] !== 'string') continue
                const state = values[index] || {}
                const preview = firstUserText(state.messages)
                items.push({
                  sessionId: parts[2],
                  name: typeof state.name === 'string' ? state.name : '',
                  preview,
                  updatedAt: Number(state.updatedAt) || 0
                })
              }
              resolve(items)
            }
            tx.onerror = tx.onabort = () => reject(new Error('读取宿主会话列表失败。'))
          })
        },
        renameSession(sessionId, name) {
          if (typeof sessionId !== 'string' || !sessionId) return Promise.reject(new Error('会话标识无效。'))
          const value = String(name || '').trim().slice(0, 40)
          if (!value) return Promise.reject(new Error('会话名称不能为空。'))
          return transaction(state => {
            state.name = value
            state.updatedAt = Date.now()
            return value
          }, keyFor(sessionId))
        },
        deleteSession(sessionId) {
          if (typeof sessionId !== 'string' || !sessionId) return Promise.reject(new Error('会话标识无效。'))
          return new Promise((resolve, reject) => {
            let tx
            try { tx = db.transaction('sessions', 'readwrite') } catch (_) { reject(new Error('宿主会话存储不可用。')); return }
            tx.objectStore('sessions').delete(keyFor(sessionId))
            tx.oncomplete = () => resolve(true)
            tx.onerror = tx.onabort = () => reject(new Error('删除宿主会话失败。'))
          })
        }
      }
    }
  }
}
