'use strict'

const fs = require('fs')
const path = require('path')
const url = require('url')
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, systemPreferences, nativeTheme } = require('electron')
const { hideApplicationMenu, configureWindowMenu } = require('../../shell/menu')
const { windowChromeOptions, controlsSide, windowState, applyWindowAction, attachWindowChrome, normalizeTheme, windowBackground, applyWindowTheme } = require('../../shell/window-chrome')
const { Settings } = require('./agent/settings')
const { AgentPool } = require('./agent/agent-pool')
const { fetchModelList } = require('./agent/model-list')
const { AssetStore } = require('./agent/asset-store')
const { PluginHost } = require('./plugins/plugin-host')
const { UiStore } = require('../../server/ui-store')

const not = (value) => value ? false : true
let mainWindow = null
let settings = null
let pool = null
let assetStore = null
let uiStore = null
let pluginHost = null

function sendEvent(event) {
  if (not(mainWindow) || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('agent:event', event)
}

/* 双击独立顶栏：macOS 尊重系统偏好，Windows/Linux 切换最大化。 */
function titlebarDoubleClickAction(preferences) {
  if (process.platform !== 'darwin') return 'maximize'
  let value = 'Maximize'
  try {
    const prefs = preferences || systemPreferences
    value = prefs.getUserDefault('AppleActionOnDoubleClick', 'string') || 'Maximize'
  } catch (error) {
    value = 'Maximize' // 取不到偏好（受限环境）就按 macOS 默认值来
  }
  if (value === 'Minimize') return 'minimize'
  if (value === 'Maximize') return 'maximize'
  return 'none'
}

/** 把动作落到窗口上。单独拆出来是为了能在真机冒烟里直接调用。 */
function applyTitlebarDoubleClick(win, action) {
  if (!win || win.isDestroyed()) return 'none'
  if (action === 'minimize') {
    win.minimize()
    return 'minimize'
  }
  if (action !== 'maximize') return 'none'
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  return 'maximize'
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: 'Agent',
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),
    backgroundColor: windowBackground(settings.data.theme),
    ...windowChromeOptions(),
    webPreferences: {
      additionalArguments: ['--dsh-controls-side=' + controlsSide(), '--dsh-theme=' + normalizeTheme(settings.data.theme)],
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  configureWindowMenu(mainWindow, { onQuit: () => app.quit(), onHide: () => app.hide() })
  attachWindowChrome(mainWindow)
  mainWindow.loadURL(url.pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).toString())

  /* 外链（http/https）交给系统默认浏览器，其余一律拒绝开新窗口 */
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(String(target || ''))) {
      shell.openExternal(target).catch(() => {})
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, target) => {
    const current = mainWindow.webContents.getURL()
    if (target !== current) {
      event.preventDefault()
      if (/^https?:\/\//i.test(String(target || ''))) {
        shell.openExternal(target).catch(() => {})
      }
    }
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function createAgent() {
  const userData = app.getPath('userData')
  settings = new Settings(userData)
  settings.sessionRoot = path.join(userData, 'sessions')
  assetStore = new AssetStore(path.join(userData, 'assets'))
  /* 渲染层会话/偏好的落盘（ui-store.json）。这是开发态（electron .）那条 IPC 链路的
     存储点；打包壳走的是 service 子进程的 HTTP /api/ui-store（server/ui-store.js），
     两边落盘行为一致，只是目录不同：这边 userData/，那边 userData/agent-home/。 */
  uiStore = new UiStore(userData)
  pluginHost = new PluginHost({
    workspaceRoot: settings.data.workspacePath || '',
    settings
  })
  pluginHost.loadBuiltins()
  pluginHost.loadFromDirectory(path.join(userData, 'plugins'))
  await pluginHost.ready()
  await pluginHost.configure()
  await pluginHost.get('extensions').attach(pluginHost)
  try { await pluginHost.get('mcp').ready() } catch (error) { console.error('[mcp] startup failed:', error.message) }
  /* 一条会话一台 worker（与 server/index.js 同一套池，见 src/main/agent/agent-pool.js） */
  pool = new AgentPool({
    settings,
    emit: sendEvent,
    approve: async (request) => {
      const response = await dialog.showMessageBox(mainWindow, {
        type: request.kind === 'command' ? 'warning' : 'question',
        title: request.title,
        message: request.title,
        detail: request.detail,
        buttons: ['Approve', 'Deny'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      return response.response === 0
    },
    sessionRoot: path.join(userData, 'sessions'),
    pluginHost,
    assetStore
  })
  pluginHost.get('workflowAgent').attach(pool)
  pluginHost.get('tasks').attach({ pool, home: userData, emit: sendEvent })
}

app.whenReady().then(async () => {
  hideApplicationMenu(Menu)
  await createAgent()
  applyWindowTheme([], settings.data.theme, nativeTheme)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  console.error('[agent] runtime boot failed:', error)
  dialog.showErrorBox('Agent startup failed', String(error.message || error))
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* 退出前收掉终端的子 shell，别留孤儿进程 */
let runtimeQuitReady = false
app.on('before-quit', (event) => {
  if (runtimeQuitReady) return
  event.preventDefault()
  if (runtimeShutdown) return
  runtimeShutdown = (async () => {
    try { if (pluginHost && pluginHost.get('tasks')) await pluginHost.get('tasks').close() } catch (error) { console.error(error) }
    try { if (pool) await pool.dispose() } catch (error) { console.error(error) }
    try { if (pluginHost) await pluginHost.dispose() } catch (error) { console.error(error) }
    try { if (terminalApiModule) terminalApiModule.teardownAll() } catch (error) { console.error(error) }
    runtimeQuitReady = true
    app.quit()
  })()
})
let runtimeShutdown = null

/* 双击顶栏 —— 原生标题栏没了，这个手势得自己接（见 titlebarDoubleClickAction） */
ipcMain.on('shell:titlebar-dblclick', (event) => {
  applyTitlebarDoubleClick(BrowserWindow.fromWebContents(event.sender), titlebarDoubleClickAction())
})

ipcMain.handle('window:theme', () => normalizeTheme(settings && settings.data.theme))
ipcMain.on('window:theme', (event, value) => {
  if (!mainWindow || mainWindow.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== mainWindow) return
  if (value !== 'light' && value !== 'dark') return
  applyWindowTheme([mainWindow], value, nativeTheme)
})

ipcMain.handle('window:state', (event) => windowState(BrowserWindow.fromWebContents(event.sender)))
ipcMain.handle('window:action', (event, action) => applyWindowAction(BrowserWindow.fromWebContents(event.sender), action))

ipcMain.handle('app:get-state', () => stateValue())

ipcMain.handle('settings:save', async (_event, patch) => {
  const next = settings.update(patch || {})
  await pluginHost.configure()
  if (patch && (Object.prototype.hasOwnProperty.call(patch, 'mcpServers') || Object.prototype.hasOwnProperty.call(patch, 'disabledBuiltinMcp'))) {
    try { await pluginHost.get('mcp').reload() } catch (error) { console.error('[mcp] reload failed:', error.message) }
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'theme')) applyWindowTheme([mainWindow], next.theme, nativeTheme)
  if (next.workspacePath) pool.setWorkspace(next.workspacePath)
  return next
})

async function forceResetAgent(sessionId) {
  await pool.reset(sessionId)
}

function stateValue() {
  return {
    settings: settings.all(),
    workspacePath: pool.getWorkspace(),
    running: pool.runningCount() > 0,
    runningSessions: pool.runningSessions(),
    maxConcurrentRuns: pool.maxConcurrentRuns,
    plugins: pool.listPlugins(),
    tools: pool.listTools(),
    executions: pool.executionStates(),
    skills: pluginHost.requireService('skillLibrary').list(),
    mcp: pluginHost.get('mcp') ? pluginHost.get('mcp').status() : { servers: [], connected: 0, tools: 0 },
    runtime: pluginHost.runtimeInfo()
  }
}

function applyWorkspace(chosen) {
  const resolved = path.resolve(chosen)
  settings.update({ workspacePath: resolved })
  pool.setWorkspace(resolved)
  pool.clear()
  sendEvent({ type: 'workspace', path: resolved })
  return stateValue()
}

ipcMain.handle('workspace:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '\u9009\u62e9\u672c\u5730\u5de5\u4f5c\u533a',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return stateValue()
  return applyWorkspace(result.filePaths[0])
})

ipcMain.handle('workspace:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '\u9009\u62e9\u6587\u4ef6\u5939',
    buttonLabel: '\u9009\u62e9',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return ''
  return result.filePaths[0]
})

ipcMain.handle('workspace:create', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '\u65b0\u5efa\u5de5\u4f5c\u533a',
    buttonLabel: '\u521b\u5efa\u5e76\u9009\u62e9',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return stateValue()
  return applyWorkspace(result.filePaths[0])
})

ipcMain.handle('workspace:set', (_event, target) => {
  const resolved = path.resolve(String(target || ''))
  if (not(fs.existsSync(resolved)) || not(fs.statSync(resolved).isDirectory())) {
    throw new Error('WORKSPACE_NOT_FOUND: ' + resolved)
  }
  return applyWorkspace(resolved)
})

ipcMain.handle('workspace:clear', () => {
  settings.update({ workspacePath: '' })
  pool.setWorkspace('')
  pool.clear()
  sendEvent({ type: 'workspace', path: '' })
  return ''
})

ipcMain.handle('chat:send', async (_event, payload) => {
  const text = typeof payload === 'string' ? payload : String(payload && payload.text ? payload.text : '')
  const sessionId = typeof payload === 'string' ? '' : String((payload && payload.sessionId) || '')
  const history = payload && Array.isArray(payload.history) ? payload.history : undefined
  const images = payload && Array.isArray(payload.images) ? payload.images : undefined
  const memory = payload && payload.memory ? payload.memory : undefined
  await pool.run(sessionId, text, history, images, memory)
  return true
})

ipcMain.handle('chat:stop', (_event, sessionId) => {
  pool.abort(sessionId)
  return true
})

ipcMain.handle('chat:reset', async (_event, sessionId) => {
  await forceResetAgent(sessionId)
  return true
})

ipcMain.handle('chat:clear', (_event, sessionId) => {
  pool.clear(sessionId)
  return true
})

ipcMain.handle('asset:save', (_event, payload) => {
  if (not(assetStore) || not(payload) || not(payload.dataUrl)) throw new Error('ASSET_REQUIRED')
  const sessionDir = payload.sessionId ? pool.sessionDir(payload.sessionId) : ''
  return assetStore.saveDataUrl(payload.dataUrl, {
    name: payload.name,
    mime: payload.mime,
    sessionDir
  })
})

ipcMain.handle('asset:read', (_event, id) => {
  if (not(assetStore)) throw new Error('ASSET_STORE_MISSING')
  return { id: String(id || ''), dataUrl: assetStore.readDataUrl(id) }
})

ipcMain.handle('models:list', async (_event, payload) => {
  const models = await fetchModelList(payload && payload.baseURL, payload && payload.apiKey)
  return { models }
})

/* ---------------- 右侧文件面板（开发态 npm start 走这条 IPC；
     打包后的桌面壳走 server/file-api.js 的 HTTP 端点，两边共用同一套安全规则） ----------------
   为什么延迟 require：打包后的 app 里 server/ 被平铺成了 service/，这个文件本身不会
   被加载，但万一有人把它拷过去跑，顶层 require 会当场炸；延迟到用时再报错更安全。 */
let fileApiModule = null
function fileApi() {
  if (not(fileApiModule)) fileApiModule = require('../../server/file-api')
  return fileApiModule
}

ipcMain.handle('fs:roots', () => {
  const api = fileApi()
  const data = settings.data || {}
  const projects = Array.isArray(data.projects) ? data.projects : []
  const current = projects.filter((item) => item && item.id === data.currentProjectId)[0]
  return {
    projectId: (current && current.id) || '',
    projectName: (current && current.name) || '',
    roots: api.workspaceRoots(settings)
  }
})

ipcMain.handle('fs:tree', async (_event, payload) => {
  const api = fileApi()
  return api.describeTree(settings, payload && payload.path, payload && payload.depth)
})

ipcMain.handle('fs:file', async (_event, target) => {
  const api = fileApi()
  return api.describeFile(settings, target)
})

/* IPC 这条没有 <img src> 能直接用的地址，所以把字节包成 data URL 交回去 */
const FS_PREVIEW_MAX_BYTES = 32 * 1024 * 1024

ipcMain.handle('fs:preview-url', async (_event, target) => {
  const api = fileApi()
  const file = await api.readWorkspaceFile(settings, target, FS_PREVIEW_MAX_BYTES)
  return 'data:' + api.mimeOf(file.absolute) + ';base64,' + file.buffer.toString('base64')
})

/**
 * 文本预览。主进程是 Electron 自带的 Node，也是 small-icu，
 * 解不了 GBK —— 开发态只保证 UTF-8（真机上跑的是服务端那条路，由渲染层用
 * TextDecoder 解 GBK，见 src/renderer/panel.js 的 decodeBytes）。
 */
ipcMain.handle('fs:text', async (_event, target) => {
  const api = fileApi()
  const file = await api.readWorkspaceFile(settings, target, 32 * 1024 * 1024)
  return file.buffer.toString('utf8')
})

/**
 * 写回文件（右侧面板的编辑保存）。data 走 base64 —— 渲染层那边编码已经定好了
 * （GBK / UTF-16 / BOM 都在 panel.js 处理），主进程只管把字节落盘，
 * 与 server/file-api.js 的 HTTP 那条路完全同一套规则。
 */
ipcMain.handle('fs:write', async (_event, payload) => {
  const api = fileApi()
  const data = String((payload && payload.data) || '')
  const info = await api.writeWorkspaceFile(settings, payload && payload.path, Buffer.from(data, 'base64'),
    { expectedMtime: payload && payload.expectedMtime })
  return { ok: true, path: info.path, size: info.size, mtime: info.mtime }
})

/* ---------------- 渲染层会话/偏好 storage（ui-store.json）----------------
   与 server/index.js 的 HTTP /api/ui-store 完全同一套语义（server/ui-store.js）。
   开发态（electron .）走这两条 IPC；打包壳的 window.dsh 由 web-bridge（HTTP）注入，
   不经过这里 —— 两边落盘行为一致，别只改一头。 */
ipcMain.handle('ui-store:get', () => ({ ok: true, store: uiStore.snapshot() }))
ipcMain.handle('ui-store:put', async (_event, store) => {
  const saved = await uiStore.save(store)
  return { ok: true, updatedAt: saved.updatedAt }
})

/* ---------------- 终端（三期）：与 server/index.js 的 HTTP 端点共用 server/terminal-api.js，
   两条入口的会话管理 / 缓冲 / 回显行为完全一致 ---------------- */
let terminalApiModule = null
function terminalApi() {
  if (not(terminalApiModule)) terminalApiModule = require('../../server/terminal-api')
  return terminalApiModule
}

/** 每个 webContents 一条订阅；页面刷新 / 窗口销毁时自动解绑，别攒一堆死监听 */
const terminalSubscriptions = new Map()

ipcMain.handle('term:state', (_event, sid) => terminalApi().state(sid))

ipcMain.handle('term:start', (_event, cwd) => terminalApi().start(cwd))

ipcMain.handle('term:write', (_event, payload) => {
  const api = terminalApi()
  return api.write(payload && payload.sid, payload && payload.text)
})

ipcMain.handle('term:kill', (_event, sid) => terminalApi().kill(sid))

ipcMain.on('term:subscribe', (event, sid) => {
  const key = event.sender.id
  let subs = terminalSubscriptions.get(key)
  if (not(subs)) {
    subs = new Map()
    terminalSubscriptions.set(key, subs)
    event.sender.once('destroyed', () => {
      const all = terminalSubscriptions.get(key)
      if (not(all)) return
      for (const off of all.values()) { try { off() } catch (error) {} }
      terminalSubscriptions.delete(key)
    })
  }
  const previous = subs.get(sid)
  if (previous) previous()
  const unsubscribe = terminalApi().subscribe(sid, (payload) => {
    try {
      if (not(event.sender.isDestroyed())) event.sender.send('term:data', payload)
    } catch (error) {}
  })
  subs.set(sid, unsubscribe)
})

ipcMain.on('term:unsubscribe', (event, sid) => {
  const key = event.sender.id
  const subs = terminalSubscriptions.get(key)
  if (not(subs)) return
  if (sid) {
    const off = subs.get(sid)
    if (off) { off(); subs.delete(sid) }
    if (subs.size === 0) terminalSubscriptions.delete(key)
    return
  }
  for (const off of subs.values()) { try { off() } catch (error) {} }
  terminalSubscriptions.delete(key)
})

ipcMain.handle('shell:open-path', async (_event, target) => {
  const pathToOpen = target && path.isAbsolute(target) ? target : pool.getWorkspace()
  if (not(pathToOpen)) return 'NO_PATH'
  return shell.openPath(pathToOpen)
})

/* 只放行 http/https，禁止 file: / 自定义协议被渲染层当成外链打开 */
ipcMain.handle('shell:open-external', async (_event, target) => {
  const link = String(target || '')
  if (not(/^https?:\/\//i.test(link))) return 'BLOCKED'
  await shell.openExternal(link)
  return 'OK'
})

ipcMain.handle('workflows:request',async(_event,action,data)=>{const service=pluginHost.get('workflows');service.attach(sendEvent);if(action==='list')return service.list();if(!['save','remove','run','detail','stop','submit','context','template','pause','resume','retry'].includes(action))throw Error('WORKFLOW_ACTION_INVALID');return service[action](data||{})})

ipcMain.handle('knowledge:request', async (_event, action, data) => {
  const knowledge = pluginHost.get('knowledge')
  const raw = data || {}
  if (typeof sendEvent === 'function') knowledge.attach(sendEvent)
  if (action === 'list') return { ...await knowledge.list(), currentScope: pool.getWorkspace(), projects: settings.data.projects || [] }
  if (action === 'create') return knowledge.create({ name: raw.name, scope: '' })
  if (action === 'rename') return knowledge.rename(raw)
  if (action === 'remove-base') return knowledge.removeBase(raw)
  if (action === 'bind') return knowledge.bind(raw.scopes !== undefined ? { id: raw.id, scopes: raw.scopes } : { id: raw.id, scope: raw.enabled ? pool.getWorkspace() : '' })
  if (action === 'bind-session' || action === 'delete-session') { if(pool.isRunning(raw.sessionId))throw Error('SESSION_BUSY');return action === 'bind-session' ? knowledge.bindSession(raw) : knowledge.deleteSession(raw) }
  if (action === 'session-tree') return knowledge.sessionTree(raw)
  if (action === 'session-preview') return knowledge.sessionPreview(raw)
  if (action === 'tree') return knowledge.tree(raw)
  if (action === 'project-preview') return knowledge.projectPreview(raw)
  if (action === 'preview') return knowledge.preview(raw)
  if (action === 'import') return knowledge.importBuffer(raw, Buffer.from(raw.bytes))
  if (action === 'delete') return knowledge.remove(raw)
  if (action === 'cancel') return knowledge.cancel(raw)
  if (action === 'search') return raw.baseId ? knowledge.searchBase(raw) : knowledge.search(raw, pool.getWorkspace())
  if (action === 'source') { const linked=raw.sessionId?await knowledge.sessionContext(raw.sessionId):null;return raw.baseId ? knowledge.sourceBase(raw) : knowledge.sourceSession(raw,linked?linked.workspaceRoot:pool.getWorkspace()) }
  throw new Error('KNOWLEDGE_ACTION_INVALID')
})

ipcMain.handle('extensions:request',async(_event,action,data)=>{const service=pluginHost.get('extensions');if(action==='list')return service.list();if(!['inspect','discard','install','enable','remove'].includes(action))throw Error('EXTENSION_ACTION_INVALID');return service[action](data||{})})

ipcMain.handle('mcp:request', async (_event, action, data) => {
  const mcp = pluginHost.get('mcp')
  if (mcp === undefined || mcp === null) throw new Error('MCP_UNAVAILABLE')
  if (action === 'list') return mcp.status()
  if (action === 'reload') { await mcp.reload(); return mcp.status() }
  if (action === 'test') return mcp.test(data)
  throw new Error('MCP_ACTION_INVALID')
})

ipcMain.handle('tasks:request', async (_event, action, data) => {
  const tasks = pluginHost.get('tasks')
  if (action === 'list') return tasks.list()
  if (action === 'save') return { task: tasks.save(data) }
  if (action === 'bind-session' || action === 'delete-session') { if(pool.isRunning(raw.sessionId))throw Error('SESSION_BUSY');return action === 'bind-session' ? knowledge.bindSession(raw) : knowledge.deleteSession(raw) }
  if (action === 'session-tree') return knowledge.sessionTree(raw)
  if (action === 'session-preview') return knowledge.sessionPreview(raw)
  if (action === 'tree') return knowledge.tree(raw)
  if (action === 'project-preview') return knowledge.projectPreview(raw)
  if (action === 'preview') return { nextAt: tasks.preview(data.rule) }
  if (action === 'delete') { tasks.remove(data.id); return {ok:true} }
  if (action === 'run') return {run:tasks.run(data.id)}
  if (action === 'stop') { tasks.stop(data.id); return {ok:true} }
  if (action === 'conversation') return tasks.conversation(data.runId)
  throw new Error('TASK_ACTION_INVALID')
})
