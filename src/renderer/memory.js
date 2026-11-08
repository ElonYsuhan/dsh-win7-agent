'use strict'

;(function () {
  const labels = { fact: '事实', preference: '偏好', profile: '资料', experience: '经验', inference: '推断' }
  const scopes = { user: '全局', project: '项目', session: '会话' }
  let query = '', status = 'active', loading = null
  const $ = id => document.getElementById(id)
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node }
  const api = (action, data) => window.dsh.memoryRequest(action, data || {})
  function notice(text) { const node = $('memoryNotice'); if (node) node.textContent = text || '' }
  function itemRow(item, candidate) {
    const row = el('div', null, 'memory-item')
    const head = el('div', null, 'memory-item-head')
    head.append(el('strong', item.content))
    const meta = el('span', null, 'muted')
    meta.textContent = [labels[item.kind] || item.kind, scopes[item.scope] || item.scope, item.confidence != null ? Math.round(item.confidence * 100) + '%' : '', item.status || ''].filter(Boolean).join(' · ')
    head.append(meta)
    const actions = el('div', null, 'memory-actions')
    if (candidate) {
      const confirm = el('button', '确认')
      confirm.type = 'button'; confirm.addEventListener('click', async () => {
        confirm.disabled = true
        try { await api('confirm', { id: item.id }); notice('已确认并保存'); await refresh() } catch (error) { await window.appDialogs.alert(error.message) } finally { confirm.disabled = false }
      })
      const reject = el('button', '忽略')
      reject.type = 'button'; reject.addEventListener('click', async () => {
        reject.disabled = true
        try { await api('reject', { id: item.id, reason: 'user rejected' }); notice('已忽略候选'); await refresh() } catch (error) { await window.appDialogs.alert(error.message) } finally { reject.disabled = false }
      })
      actions.append(confirm, reject)
      if (item.reason) row.append(el('p', item.reason, 'muted'))
    } else {
      const edit = el('button', '编辑')
      edit.type = 'button'; edit.addEventListener('click', async () => {
        const value = await window.appDialogs.prompt('修改记忆', item.content)
        if (value === null || !value.trim()) return
        try { await api('update', { id: item.id, content: value.trim() }); notice('记忆已更新'); await refresh() } catch (error) { await window.appDialogs.alert(error.message) }
      })
      const remove = el('button', '删除')
      remove.type = 'button'; remove.addEventListener('click', async () => {
        if (!await window.appDialogs.confirm('删除这条记忆？删除后会同步清理检索索引，历史修订仍保留用于审计。')) return
        try { await api('forget', { id: item.id }); notice('记忆已删除'); await refresh() } catch (error) { await window.appDialogs.alert(error.message) }
      })
      actions.append(edit, remove)
    }
    row.append(head, actions)
    return row
  }
  function empty(text) { return el('p', text, 'muted') }
  async function refresh() {
    if (!window.dsh || typeof window.dsh.memoryRequest !== 'function') { notice('当前宿主不支持长期记忆'); return }
    if (loading) return loading
    loading = (async () => {
      try {
        const [list, candidates, preferences] = await Promise.all([
          api('list', { query, status, limit: 100 }),
          api('candidates', { limit: 100 }),
          api('preferences')
        ])
        const listHost = $('memoryList'), candidateHost = $('memoryCandidates')
        if (listHost) { listHost.textContent = ''; if (!list.items.length) listHost.append(empty(query ? '没有匹配的记忆。' : '还没有保存的长期记忆。')); for (const item of list.items) listHost.append(itemRow(item, false)) }
        if (candidateHost) { candidateHost.textContent = ''; if (!candidates.items.length) candidateHost.append(empty('没有待确认候选。')); for (const item of candidates.items) candidateHost.append(itemRow(item, true)) }
        if ($('memoryAuto')) $('memoryAuto').checked = preferences.autoMemory !== false
        notice('')
      } catch (error) { notice(error.message || String(error)) } finally { loading = null }
    })()
    return loading
  }
  function wire() {
    const search = $('memorySearch'), statusSelect = $('memoryStatus'), refreshButton = $('memoryRefresh'), auto = $('memoryAuto')
    if (search) { let timer = null; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim(); refresh() }, 250) }) }
    if (statusSelect) statusSelect.addEventListener('change', () => { status = statusSelect.value; refresh() })
    if (refreshButton) refreshButton.addEventListener('click', refresh)
    if (auto) auto.addEventListener('change', async () => {
      try { await api('preference', { key: 'autoMemory', value: auto.checked }); notice(auto.checked ? '已启用自动提取' : '已暂停自动提取') } catch (error) { await window.appDialogs.alert(error.message); auto.checked = !auto.checked }
    })
    for (const tab of document.querySelectorAll('[data-settings-tab="memory"]')) tab.addEventListener('click', refresh)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true }); else wire()
  window.memoryUI = { refresh }
})()
