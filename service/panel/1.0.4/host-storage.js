'use strict'

// 参考宿主 Storage Adapter（ESM）。由宿主在自己的页面加载并注入 agent-panel；
// 组件本身不创建数据库。数据保存在**宿主页面 Origin** 的 IndexedDB 中，
// 按 Service 确认的 userId、hostId、sessionId 分区。
// 宿主可复制此实现并按自身数据库规范调整，但必须保持方法契约与事务提交语义。

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
      // 服务重启会更换事件代次；rebase 成功后同步本适配器的期望代次。
      let currentEpoch = identity.epoch

      function transaction(update) {
        return new Promise((resolve, reject) => {
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
          return state.pending
        }),
        saveApprovals: approvals => transaction(state => { state.approvals = approvals; return state }),
        approvalDecision: (id, approved, status) => transaction(state => {
          if (!state.approvalHistory) state.approvalHistory = []
          state.approvalHistory.push({ id, approved, status, at: Date.now() })
          return state
        }),
        markGap: () => transaction(state => { state.gap = true; return state }),
        rebase: epoch => transaction(state => {
          if (state.pending || state.gap) throw new Error('服务重启时仍有未确认操作，请先核对结果。')
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
      }
    }
  }
}
