'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * macOS 去白条方案的前半截（后半截在 CSS 里）。
 *
 * 主进程用 titleBarStyle:'hidden' 藏掉了系统标题栏 —— 那条白条压在深色界面顶上
 * 像贴了张纸条。代价是红黄绿按钮改成悬浮在页面左上角，渲染层必须自己让出顶部
 * 空间、并补一块拖拽区（原生那一条没了，窗口还得能拖）。样式表按 .shell-mac 生效。
 *
 * 放在 preload 而不是渲染层脚本里，是因为壳里每个窗口都挂着它：主窗口（实际加载的
 * 是服务托管的 web UI）、设置窗口、启动页/离线页/更新页。一处打标记全覆盖。
 * 普通浏览器里没有 preload，标记不会出现，样式完全不受影响。
 */
function markShellWindow() {
  const root = document.documentElement
  if (!root || !root.classList) return
  root.classList.add('shell-window')
  if (process.platform === 'darwin') root.classList.add('shell-mac')
}

/**
 * macOS：双击顶栏缩放 / 最小化窗口 —— 原生标题栏被藏掉了，这个手势也跟着没了，
 * 得自己接回去（Electron 明确不做默认实现，见主进程 titlebarDoubleClickAction 的注释）。
 *
 * 用事件委托而不是直接绑元素：主窗口加载的是服务托管的 web UI，DOM 是页面脚本建的，
 * preload 跑的时候那些节点还不一定在。只在 mac 上接 —— Windows / Linux 的原生标题栏
 * 还在，双击由系统处理，别抢。
 */
function wireTitlebarDoubleClick() {
  if (process.platform !== 'darwin') return
  document.addEventListener('dblclick', (event) => {
    const target = event.target
    if (!target || typeof target.closest !== 'function') return
    // 只有拖拽区（顶栏那条带子 / 品牌行）认双击；里面的按钮之类照旧点它们自己
    if (!target.closest('#titlebarDrag, .brand')) return
    if (target.closest('button, a, input, select, textarea')) return
    ipcRenderer.send('shell:titlebar-dblclick')
  })
}

try {
  const start = () => {
    markShellWindow()
    wireTitlebarDoubleClick()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
} catch (error) {
  // 打标记失败不影响页面本身
}

contextBridge.exposeInMainWorld('shell', {
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
