'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/* 标记桌面窗口并把原生窗口操作放在独立顶栏内。两个 preload 保持一致；
   sandbox preload 只能 require Electron，不能 require 自定义 Node 模块。 */
function markShellWindow() {
  const root = document.documentElement
  if (!root || !root.classList) return
  root.classList.add('shell-window')
  root.classList.add(process.platform === 'darwin' ? 'shell-mac' : (process.platform === 'win32' ? 'shell-win' : 'shell-linux'))
  if (process.platform !== 'darwin') {
    const arg = (process.argv || []).find((item) => item.indexOf('--dsh-controls-side=') === 0) || ''
    root.classList.add(arg.slice('--dsh-controls-side='.length) === 'left' ? 'window-controls-left' : 'window-controls-right')
  }
}

function setupWindowControls() {
  const root = document.documentElement
  const bar = document.getElementById('titlebarDrag')
  if (!root || !bar) return
  bar.removeAttribute('aria-hidden')
  let maximizeButton = null
  if (process.platform !== 'darwin') {
    const group = document.createElement('div')
    group.className = 'window-controls'
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', '窗口控制')
    const controls = [
      { action: 'minimize', label: '最小化窗口', icon: 'minimize' },
      { action: 'toggle-maximize', label: '最大化窗口', icon: 'maximize' },
      { action: 'close', label: '关闭窗口', icon: 'close' }
    ]
    for (const control of controls) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'window-control window-control-' + control.icon
      button.setAttribute('data-window-action', control.action)
      button.setAttribute('aria-label', control.label)
      button.title = control.label
      const icon = document.createElement('span')
      icon.className = 'window-control-icon window-control-icon-' + control.icon
      icon.setAttribute('aria-hidden', 'true')
      button.appendChild(icon)
      button.addEventListener('click', () => {
        ipcRenderer.invoke('window:action', control.action).catch(() => {})
      })
      group.appendChild(button)
      if (control.action === 'toggle-maximize') maximizeButton = button
    }
    bar.appendChild(group)
  }
  const update = (value) => {
    if (!value) return
    if (process.platform !== 'darwin') {
      root.classList.toggle('window-controls-left', value.controlsSide === 'left')
      root.classList.toggle('window-controls-right', value.controlsSide !== 'left')
    }
    root.classList.toggle('window-maximized', value.maximized === true)
    root.classList.toggle('window-fullscreen', value.fullScreen === true)
    root.classList.toggle('window-unfocused', value.focused === false)
    if (maximizeButton) {
      const label = value.maximized ? '还原窗口' : '最大化窗口'
      maximizeButton.title = label
      maximizeButton.setAttribute('aria-label', label)
      maximizeButton.firstChild.className = 'window-control-icon window-control-icon-' + (value.maximized ? 'restore' : 'maximize')
    }
  }
  ipcRenderer.on('window:state', (_event, value) => update(value))
  ipcRenderer.invoke('window:state').then(update).catch(() => {})
}

function wireTitlebarDoubleClick() {
  document.addEventListener('dblclick', (event) => {
    const target = event.target
    if (!target || typeof target.closest !== 'function') return
    if (!target.closest('#titlebarDrag')) return
    if (target.closest('button, a, input, select, textarea')) return
    ipcRenderer.send('shell:titlebar-dblclick')
  })
}

/* 主界面的主题由 agent settings 决定；这里只把选择同步给宿主及辅助页。
   启动参数用于首次绘制，异步宿主读取不覆盖主界面的 applyTheme。 */
function wireWindowTheme() {
  const root = document.documentElement
  if (!root) return
  const isTheme = (value) => value === 'light' || value === 'dark'
  const arg = (process.argv || []).find((item) => item.indexOf('--dsh-theme=') === 0) || ''
  const initialTheme = arg.slice('--dsh-theme='.length)
  let theme = isTheme(initialTheme) ? initialTheme : 'dark'
  let revision = 0
  const ownsTheme = Boolean(document.getElementById('app'))
  const currentTheme = root.getAttribute('data-theme')
  if (!isTheme(currentTheme)) root.setAttribute('data-theme', theme)

  const receive = (value) => {
    if (!isTheme(value)) return
    revision += 1
    theme = value
    if (!ownsTheme) root.setAttribute('data-theme', value)
  }
  ipcRenderer.on('window:theme', (_event, value) => receive(value))
  const readRevision = revision
  ipcRenderer.invoke('window:theme').then((value) => {
    /* 用户已切换或收到广播时，忽略较早的 getter 结果。 */
    if (revision === readRevision) receive(value)
  }).catch(() => {})

  if (!ownsTheme) return
  const publish = () => {
    const value = root.getAttribute('data-theme')
    if (!isTheme(value) || value === theme) return
    revision += 1
    theme = value
    ipcRenderer.send('window:theme', value)
  }
  const observer = new MutationObserver(publish)
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  /* getState 很快返回时，主题可能已在 DOMContentLoaded 前应用。 */
  if (isTheme(currentTheme)) publish()
  window.addEventListener('beforeunload', () => observer.disconnect(), { once: true })
}

contextBridge.exposeInMainWorld('desktopWindow', {
  menuState: (value) => ipcRenderer.send('app:menu-state', value),
  onCommand: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, id) => {
      if (['new-session', 'add-project', 'settings', 'sidebar', 'panel', 'markdown', 'close-file'].includes(id)) callback(id)
    }
    ipcRenderer.on('app:command', handler)
    ipcRenderer.send('app:menu-ready')
    return () => ipcRenderer.removeListener('app:command', handler)
  },
  platform: process.platform,
  getState: () => ipcRenderer.invoke('window:state'),
  action: (value) => ipcRenderer.invoke('window:action', value),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, value) => callback(value)
    ipcRenderer.on('window:state', handler)
    return () => ipcRenderer.removeListener('window:state', handler)
  }
})

try {
  const start = () => {
    markShellWindow()
    wireWindowTheme()
    setupWindowControls()
    wireTitlebarDoubleClick()
    if (process.platform !== 'darwin') {
      const bar = document.getElementById('titlebarDrag')
      if (bar) {
        const button = document.createElement('button')
        button.className = 'app-menu-button'
        button.textContent = '☰'
        button.title = '应用菜单'
        button.setAttribute('aria-label', '应用菜单')
        button.setAttribute('aria-haspopup', 'menu')
        button.addEventListener('click', () => ipcRenderer.send('app:menu-popup'))
        bar.appendChild(button)
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
} catch (error) {
  console.error('[window-chrome]', error)
}

contextBridge.exposeInMainWorld('dsh', {
  taskRequest: (action, data) => ipcRenderer.invoke('tasks:request', action, data),
  workflowRequest: (action,data) => ipcRenderer.invoke('workflows:request',action,data),
  knowledgeRequest: (action, data) => ipcRenderer.invoke('knowledge:request', action, data),
  knowledgeUpload: async (raw, bytes) => { if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('KNOWLEDGE_FILE_LIMIT'); return ipcRenderer.invoke('knowledge:request', 'import', { ...raw, bytes }) },
  mcpRequest: (action, data) => ipcRenderer.invoke('mcp:request', action, data),
  isDesktop: true,
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  createWorkspace: () => ipcRenderer.invoke('workspace:create'),
  pickFolder: () => ipcRenderer.invoke('workspace:pick-folder'),
  setWorkspace: (target) => ipcRenderer.invoke('workspace:set', target),
  clearWorkspace: () => ipcRenderer.invoke('workspace:clear'),
  /* sessionId 一路带到后端（多实例池：一条会话一台 worker，见 agent-pool.js）。
     stop / reset / clear 都按会话生效，不带就退化成全局。 */
  send: (text, history, images, memory, sessionId) => ipcRenderer.invoke('chat:send', { text, history, images, memory, sessionId }),
  stop: (sessionId) => ipcRenderer.invoke('chat:stop', sessionId),
  resetChat: (sessionId) => ipcRenderer.invoke('chat:reset', sessionId),
  clearChat: (sessionId) => ipcRenderer.invoke('chat:clear', sessionId),
  saveAsset: (payload) => ipcRenderer.invoke('asset:save', payload),
  readAsset: (id) => ipcRenderer.invoke('asset:read', id),
  listModels: (payload) => ipcRenderer.invoke('models:list', payload),
  /* ---- 右侧文件面板（与 src/renderer/web-bridge.js 同一套接口，两个入口必须一致）----
     fsRawUrl 只在服务端那条路上有值；这里返回空串，面板就会自动改走 fsPreviewUrl /
     fsText —— 原因是「渲染层能直接塞进 <img>/<iframe> 的相对地址」只有 HTTP 才有。 */
  fsRoots: () => ipcRenderer.invoke('fs:roots'),
  fsTree: (target, depth) => ipcRenderer.invoke('fs:tree', { path: target, depth }),
  fsFile: (target) => ipcRenderer.invoke('fs:file', target),
  fsRawUrl: () => '',
  fsPreviewUrl: (target) => ipcRenderer.invoke('fs:preview-url', target),
  fsText: (target) => ipcRenderer.invoke('fs:text', target),
  /* 编辑保存：data 是 base64 字符串（渲染层定的编码），expectedMtime 冲突时主进程会抛
     MTIME_CONFLICT —— 渲染层据此提示「文件被外部改过」。与 web-bridge.js 签名一致。 */
  fsWrite: (target, data, expectedMtime) => ipcRenderer.invoke('fs:write', { path: target, data, expectedMtime }),
  /* 渲染层会话/偏好 storage（ui-store.json，见 server/ui-store.js）。
     与 web-bridge.js 的 HTTP 版签名一致：get 返回 { ok, store }，put 整份合并写。 */
  uiStoreGet: () => ipcRenderer.invoke('ui-store:get'),
  uiStorePut: (store) => ipcRenderer.invoke('ui-store:put', store),
  /* ---- 终端（三期，与 web-bridge.js 同一套接口）----
     termSubscribe 返回解绑函数；payload = { data|replay: base64, closed?: true } */
  termState: (sid) => ipcRenderer.invoke('term:state', sid),
  termStart: (cwd) => ipcRenderer.invoke('term:start', cwd),
  termWrite: (sid, text) => ipcRenderer.invoke('term:write', { sid, text }),
  termKill: (sid) => ipcRenderer.invoke('term:kill', sid),
  termSubscribe: (sid, callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('term:data', listener)
    ipcRenderer.send('term:subscribe', sid)
    return () => {
      ipcRenderer.removeListener('term:data', listener)
      ipcRenderer.send('term:unsubscribe', sid)
    }
  },
  openPath: (target) => ipcRenderer.invoke('shell:open-path', target),
  openExternal: (target) => ipcRenderer.invoke('shell:open-external', target),
  approve: () => Promise.resolve(false),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  }
})
