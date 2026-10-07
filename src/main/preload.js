'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * macOS 隐藏原生标题栏后，红黄绿按钮悬浮在页面左上角，
 * 渲染层按 .shell-mac 让出顶部空间并自建拖拽区（见 src/renderer/style.css）。
 * 与 shell/preload.js 同款，改一处记得改另一处。
 */
function markShellWindow() {
  const root = document.documentElement
  if (!root || !root.classList) return
  root.classList.add('shell-window')
  if (process.platform === 'darwin') root.classList.add('shell-mac')
}

/**
 * macOS：双击顶栏缩放 / 最小化窗口 —— 原生标题栏被藏掉了，这个手势也跟着没了，
 * 得自己接回去（Electron 明确不做默认实现）。只在 mac 上接：Windows / Linux 的
 * 原生标题栏还在，双击由系统处理，别抢。与 shell/preload.js 同款，改一处记得改另一处。
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

contextBridge.exposeInMainWorld('dsh', {
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
