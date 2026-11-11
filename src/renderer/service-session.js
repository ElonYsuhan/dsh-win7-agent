'use strict'

// 独立远程会话页：只负责宿主职责（一次性票据、Origin 内 IndexedDB、主题），
// 聊天界面全部来自固定版本 AgentPanel 组件。
import AgentPanel from '/panel/__PANEL_VERSION__/agent-panel.js'

;(function () {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(location.pathname)
  const sessionId = match ? decodeURIComponent(match[1]) : ''
  let credential = new URLSearchParams(location.hash.slice(1)).get('launch')
  // 在首次请求前清除票据，包括无效或过期票据。
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)

  const host = document.getElementById('panelHost')
  const pageError = document.getElementById('pageError')
  const themeButton = document.getElementById('themeToggle')
  const themeFile = 'agent-panel-theme'
  let panel = null
  let theme = 'auto'
  try { theme = localStorage.getItem(themeFile) || 'auto' } catch (_) {}

  function showPageError(message) {
    pageError.textContent = message
    pageError.hidden = false
  }
  function applyTheme() {
    themeButton.textContent = theme === 'light' ? '深色主题' : theme === 'dark' ? '跟随系统' : '浅色主题'
    themeButton.setAttribute('aria-label', '切换主题，当前：' + (theme === 'auto' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'))
    if (panel) panel.setTheme(theme)
  }
  themeButton.addEventListener('click', () => {
    theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto'
    try { localStorage.setItem(themeFile, theme) } catch (_) {}
    applyTheme()
  })

  ;(async () => {
    try {
      if (!sessionId) throw new Error('会话地址无效。')
      applyTheme()
      panel = await AgentPanel.mount(host, {
        endpoint: location.origin,
        sessionId,
        auth: {
          cookie: true,
          launch: async () => { const value = credential; credential = null; return value }
        },
        storage: { open: identity => window.agentSessionDB.open(identity) },
        theme,
        onEvent(event) {
          if (event.type === 'error' && event.status === 401) showPageError('会话授权已失效，请从桌面重新打开链接。')
          if (event.type === 'blocked') showPageError('本地历史存在缺口或未确认操作，已停止发送。请核对结果后重新打开链接。')
        }
      })
      window.agentPanel = panel
    } catch (error) {
      showPageError(error && error.message ? error.message : '页面初始化失败。')
    }
  })()
})()
