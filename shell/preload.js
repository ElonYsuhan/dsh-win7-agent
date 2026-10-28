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

function titlebarIcon(name) {
  const paths = {menu:'M4 6h16M4 12h16M4 18h16',minimize:'M5 12h14',maximize:'M5 5h14v14H5z',restore:'M8 8V4h12v12h-4M4 8h12v12H4z',close:'M5 5l14 14M19 5L5 19'}
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[name]+'"/></svg>'
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
      icon.innerHTML = titlebarIcon(control.icon)
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
      maximizeButton.firstChild.innerHTML = titlebarIcon(value.maximized ? 'restore' : 'maximize')
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
  /* 应用菜单改成渲染层自绘（原生 popup 的两列浮层 CSS 改不动），
     主进程只负责「开」和「执行」两件事，命令白名单仍在 shell/menu.js。 */
  menuInvoke: (id) => ipcRenderer.send('app:menu-invoke', id),
  onMenuOpen: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = () => callback()
    ipcRenderer.on('app:menu-open', handler)
    return () => ipcRenderer.removeListener('app:menu-open', handler)
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
    /* 只有主界面（index.html 带 #app）才注入 ☰：启动页没有 app-menu.js，
       放上去就是个点了没反应的按钮。 */
    if (process.platform !== 'darwin' && document.getElementById('app')) {
      const bar = document.getElementById('titlebarDrag')
      if (bar) {
        const button = document.createElement('button')
        button.className = 'app-menu-button'
        button.innerHTML = titlebarIcon('menu')
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

contextBridge.exposeInMainWorld('shell', {
  taskPreferences: (value) => ipcRenderer.invoke('shell:task-preferences', value === undefined ? null : value),
  getConfig: () => ipcRenderer.invoke('shell:get-config'),
  saveConfig: (value) => ipcRenderer.invoke('shell:save-config', value),
  retry: () => ipcRenderer.invoke('shell:retry'),
  getStartupState: () => ipcRenderer.invoke('shell:startup-state'),
  onStartupState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, value) => callback(value)
    ipcRenderer.on('shell:startup-state', handler)
    return () => ipcRenderer.removeListener('shell:startup-state', handler)
  },
  pickFolder: () => ipcRenderer.invoke('shell:pick-folder'),
  openSettings: () => ipcRenderer.invoke('shell:open-settings'),
  openPath: (target) => ipcRenderer.invoke('shell:open-path', target),
  openExternal: (target) => ipcRenderer.invoke('shell:open-external', target),
  close: () => ipcRenderer.invoke('shell:close'),
  getUpdateInfo: () => ipcRenderer.invoke('shell:get-update-info'),
  getUpdateState: () => ipcRenderer.invoke('shell:update-state'),
  runUpdate: () => ipcRenderer.invoke('shell:run-update'),
  useCurrent: () => ipcRenderer.invoke('shell:use-current'),
  cancelUpdate: () => ipcRenderer.invoke('shell:cancel-update'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, value) => callback(value)
    ipcRenderer.on('shell:update-state', handler)
    return () => ipcRenderer.removeListener('shell:update-state', handler)
  }
})

// Mouse side buttons must not navigate back into startup/update history.
// Sandbox preloads cannot import local modules; keep both entry points aligned.
for (const type of ['mousedown', 'mouseup', 'auxclick']) {
  window.addEventListener(type, (event) => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }, { capture: true, passive: false })
}
window.addEventListener('keydown', (event) => {
  if (['BrowserBack', 'BrowserForward', 'GoBack', 'GoForward'].includes(event.key)) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}, true)
