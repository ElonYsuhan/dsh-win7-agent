'use strict'

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, systemPreferences, nativeTheme } = require('electron')
const serviceManager = require('./service-manager')
const installer = require('./installer')
const { hideApplicationMenu, configureWindowMenu } = require('./menu')
const { windowChromeOptions, controlsSide, windowState, applyWindowAction, attachWindowChrome, normalizeTheme, windowBackground, applyWindowTheme } = require('./window-chrome')

const not = (value) => value ? false : true
const DEFAULT_BASE_PORT = 8080
const APP_NAME = 'Agent'
const APP_TITLE = 'Agent'
/** 上一版用过的名字。只用来把老数据目录迁过来，等没人装旧版了可以删。 */
const LEGACY_APP_NAME = 'DSH-Agent'

/**
 * 应用名必须钉死。
 *
 * 打包后的 macOS 包里主二进制仍叫 Electron（Info.plist 决定），
 * Electron 因此判不出自己是打包应用，app.getName() 会跟着启动方式飘。
 * 而它以 appData/<name> 决定 userData —— 也就是 config.json、install.json、
 * agent-home 的落点。名字一飘，用户下次双击就找不到自己的会话了。
 */
app.setName(APP_NAME)

/**
 * 改名带来的数据目录迁移。
 *
 * app.setName() 同时决定 userData 落点：改叫 Agent 之后路径从
 * .../DSH-Agent 变成 .../Agent，而 config.json / install.json /
 * agent-home（会话、工作区）全在那个目录里。不迁的话，用户看到的就是
 * 「更新完东西全没了」。
 *
 * 用 rename 而不是 copy：同一个父目录内只是元数据操作，几十毫秒的事，
 * 不必在可能很大的 agent-home 上来回复制。
 * 旧版本还在运行时目录会被占用，rename 失败 —— 那就干脆不迁，
 * 新目录会自然建出来，用户重新配一次即可，比搬一半留下坏数据强。
 */
function migrateLegacyUserData() {
  try {
    const appData = app.getPath('appData')
    const next = path.join(appData, APP_NAME)
    const legacy = path.join(appData, LEGACY_APP_NAME)
    if (not(fs.existsSync(legacy))) return
    // 新目录已存在：说明要么迁过了，要么用户已经用过新版，绝不能覆盖
    if (fs.existsSync(next)) return
    fs.renameSync(legacy, next)
  } catch (error) {}
}

migrateLegacyUserData()

let mainWindow = null
let settingsWindow = null
let config = { mode: 'local', serviceUrl: '', lastPort: 0, theme: 'dark' }
// 本次由 Shell 拉起的服务进程；复用别人已启动的服务时为 null
let serviceState = null
// 实际连上的服务地址（本地模式是自动协商出来的，远程模式是用户填的）
let resolvedServiceUrl = ''
let startupState = { phase: 'idle', port: 0, detail: '', probes: [] }
let shuttingDown = false
// 双击新版时发现旧版本 -> 待用户确认的接管信息；null 表示没有待处理更新
let updateDecision = null
let updateState = { phase: 'idle', detail: '' }

/* ---------------------------------------------------------------- config */

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function readConfig() {
  let parsed = {}
  let exists = false
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    parsed = JSON.parse(raw)
    exists = true
  } catch (error) {
    parsed = {}
  }
  const legacyUrl = typeof parsed.serviceUrl === 'string' ? parsed.serviceUrl.trim() : ''
  let mode = parsed.mode === 'remote' || parsed.mode === 'local' ? parsed.mode : ''
  // 兼容旧版 config：老配置只有 serviceUrl，说明用户在用远程服务
  if (not(mode)) mode = exists && legacyUrl ? 'remote' : 'local'
  config = {
    mode,
    serviceUrl: legacyUrl,
    lastPort: Number(parsed.lastPort) || 0,
    theme: normalizeTheme(parsed.theme)
  }
  return config
}

function writeConfig(next) {
  config = Object.assign({}, config, next)
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
  } catch (error) {}
  return config
}

function normalizeServiceUrl(value) {
  const raw = String(value || '').trim()
  if (raw === '') return ''
  const parsed = new URL(raw)
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString()
  throw new Error('Only http:// and https:// service URLs are supported') // win7-exempt (validation message only)
}

/* ------------------------------------------------------------- app paths */

/**
 * 服务入口脚本。
 * 打包后：<resources>/app/service/index.js；开发时：项目根的 server/index.js。
 */
function serviceScriptPath() {
  const appPath = app.getAppPath()
  const candidates = [
    path.join(appPath, 'service', 'index.js'),
    path.join(appPath, '..', 'server', 'index.js'),
    path.join(__dirname, '..', 'server', 'index.js')
  ]
  for (const item of candidates) {
    try {
      if (fs.existsSync(item)) return item
    } catch (error) {}
  }
  return candidates[0]
}

/** 本地服务的数据目录：会话、设置、工作区都在这里。 */
function agentHomePath() {
  return path.join(app.getPath('userData'), 'agent-home')
}

/* -------------------------------------------------------------- updates */

function appVersion() {
  try {
    return app.getVersion()
  } catch (error) {
    return '0.0.0'
  }
}

/** 当前这份程序所在的包目录（macOS 是 .app 本身）。 */
function programDir() {
  return installer.packageDirOf(process.execPath, process.platform)
}

/**
 * 当前跑的是不是「解压出来的桌面包」。
 *
 * 刻意不用 app.isPackaged：那个值取决于 Electron 怎么判断启动方式，
 * 而这里真正关心的只有一件事 —— 程序目录里有没有 resources/app 这套结构。
 * 顺带也就排除了开发态（那时 programDir 指向 node_modules 里的 Electron）。
 */
function isDesktopPackage() {
  const dir = programDir()
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(dir, 'Contents', 'Resources', 'app'))
  }
  return fs.existsSync(path.join(dir, 'resources', 'app'))
}

function setUpdateState(patch) {
  updateState = Object.assign({}, updateState, patch)
  if (mainWindow && not(mainWindow.isDestroyed())) {
    try { mainWindow.webContents.send('shell:update-state', updateState) } catch (error) {}
  }
  return updateState
}

/** 把自己登记成「当前生效的那一份」。 */
function registerSelf() {
  if (not(isDesktopPackage())) return
  installer.writeManifest(app.getPath('userData'), {
    path: programDir(),
    version: appVersion(),
    pid: process.pid
  })
}

/**
 * 启动前判定：这次点的是不是「另一份、更新的包」？
 *
 * 依据是 userData 里的 install.json —— 它与程序目录无关，
 * 所以用户把包解压到哪，读到的都是同一份登记。
 * 开发态（未打包）直接跳过，免得跑 npm start 把登记搅乱。
 */
function resolveUpdate() {
  if (not(isDesktopPackage())) return { action: 'boot' }
  const userDataDir = app.getPath('userData')
  const myDir = programDir()

  // 上次更新没删干净的旧目录，顺手清掉
  try { installer.cleanupTrash(myDir) } catch (error) {}

  const current = installer.readManifest(userDataDir)
  if (not(current) || not(current.path) || installer.samePath(current.path, myDir, process.platform)) {
    registerSelf()
    return { action: 'boot' }
  }
  if (not(fs.existsSync(current.path))) {
    // 旧目录已被用户删掉，直接以当前这份为准
    registerSelf()
    return { action: 'boot' }
  }

  updateDecision = {
    oldPath: current.path,
    oldVersion: current.version || '',
    oldPid: current.pid || 0,
    oldRunning: installer.isAlive(current.pid),
    newPath: myDir,
    newVersion: appVersion(),
    userData: userDataDir
  }
  return { action: 'ask' }
}

/** 接管：关掉旧实例 -> 清空旧目录 -> 把当前这份搬过去 -> 从旧位置重启。 */
async function runUpdate() {
  const info = updateDecision
  if (not(info)) return { ok: false, error: 'NO_DECISION' }

  setUpdateState({ phase: 'closing', detail: '' })
  if (installer.isAlive(info.oldPid)) {
    installer.killTree(info.oldPid, process.platform)
    await installer.waitGone(info.oldPid, 10000)
  }

  setUpdateState({ phase: 'copying', detail: '' })
  const replaced = await installer.replacePackage({
    srcDir: info.newPath,
    dstDir: info.oldPath,
    platform: process.platform,
    retries: 16,
    retryDelay: 500,
    onLockedAttempt: async (attempt) => {
      // 进程退出后文件句柄释放有延迟，中途补刀，别白等满 16 轮
      if (attempt === 2 || attempt === 6) installer.killTree(info.oldPid, process.platform)
      setUpdateState({ phase: 'copying', detail: '目标目录被占用，正在等待释放（第 ' + attempt + ' 次）…' })
    }
  })

  if (not(replaced.ok)) {
    setUpdateState({ phase: 'failed', detail: replaced.error, message: replaced.detail || '' })
    return { ok: false, error: replaced.error, detail: replaced.detail || '' }
  }

  setUpdateState({
    phase: 'cleaning',
    detail: replaced.leftover ? '旧目录暂时删不掉，已改名放在旁边，下次启动会自动清理。' : ''
  })
  installer.cleanupTrash(info.oldPath)
  installer.writeManifest(info.userData, { path: info.oldPath, version: info.newVersion, pid: 0 })

  setUpdateState({ phase: 'relaunching', detail: '' })
  await installer.sleep(400)
  const started = installer.relaunch(info.oldPath, {
    platform: process.platform,
    args: relaunchArgs()
  })
  if (not(started.ok)) {
    setUpdateState({ phase: 'failed', detail: started.error, message: started.binary || '' })
    return { ok: false, error: started.error }
  }
  setUpdateState({ phase: 'done', detail: '新版本已启动。' })
  setTimeout(() => app.exit(0), 700)
  return { ok: true, pid: started.pid }
}

/** 「用当前这份」：登记改到当前目录后正常启动。 */
async function useCurrent() {
  registerSelf()
  updateDecision = null
  return startAfterUpdateDecision()
}

/**
 * 重启新版本时要带过去的启动参数。
 * 丢掉参数会让新进程换一个数据目录（例如用户用 --user-data-dir 启动的场景），
 * 表现就是"更新完会话全没了"。我们自己的标记和 macOS 的 -psn 不进新进程。
 */
function relaunchArgs() {
  const out = []
  for (const item of process.argv.slice(1)) {
    if (item === '--dsh-auto-update') continue
    if (item.indexOf('-psn_') === 0) continue
    out.push(item)
  }
  return out
}

async function startAfterUpdateDecision() {
  loadLocal(mainWindow, 'loading.html')
  if (not(singleInstance())) return { ok: false, error: 'ANOTHER_INSTANCE' }
  await boot()
  return { ok: true }
}

/* --------------------------------------------------------- service boot */

function setStartupState(patch) {
  startupState = Object.assign({}, startupState, patch)
  if (mainWindow && not(mainWindow.isDestroyed())) {
    try { mainWindow.webContents.send('shell:startup-state', startupState) } catch (error) {}
  }
  return startupState
}

async function boot() {
  setStartupState({ phase: 'idle', port: 0, detail: '', probes: [] })

  if (config.mode === 'remote') {
    resolvedServiceUrl = config.serviceUrl
    if (not(resolvedServiceUrl)) {
      setStartupState({ phase: 'unconfigured' })
      loadLocal(mainWindow, 'settings.html')
      return
    }
    setStartupState({ phase: 'remote' })
    mainWindow.loadURL(resolvedServiceUrl)
    return
  }

  // 本地模式：先协商端口
  setStartupState({ phase: 'probing' })
  const picked = await serviceManager.pickPort(config.lastPort, {
    basePort: DEFAULT_BASE_PORT,
    maxPort: serviceManager.DEFAULT_MAX_PORT
  })
  if (not(picked)) {
    setStartupState({
      phase: 'failed',
      detail: 'NO_FREE_PORT',
      probes: []
    })
    return
  }
  setStartupState({ probes: picked.probes || [], port: picked.port })

  // 端口上已经是我们自己的服务 -> 直接复用，不重复启动
  if (picked.reuse) {
    finishBoot(picked.port, true)
    return
  }

  setStartupState({ phase: 'starting', port: picked.port })
  serviceState = serviceManager.spawnService({
    execPath: process.execPath,
    scriptPath: serviceScriptPath(),
    port: picked.port,
    agentHome: agentHomePath(),
    host: '127.0.0.1',
    cwd: app.getPath('userData')
  })

  const ready = await serviceManager.waitReady(picked.port, {
    state: serviceState,
    readyTimeout: 25000
  })
  if (not(ready.ok)) {
    setStartupState({
      phase: 'failed',
      port: ready.port || picked.port,
      detail: ready.reason || 'timeout',
      message: ready.detail || ''
    })
    return
  }
  finishBoot(ready.port, false)
}

function finishBoot(port, reused) {
  resolvedServiceUrl = 'http://127.0.0.1:' + port + '/'
  if (not(reused) || config.lastPort !== port) writeConfig({ lastPort: port })
  setStartupState({ phase: 'ready', port, reused: !!reused })
  if (mainWindow && not(mainWindow.isDestroyed())) {
    mainWindow.setTitle(APP_TITLE)
    mainWindow.loadURL(resolvedServiceUrl)
  }
}

async function teardownService() {
  if (not(serviceState)) return
  const state = serviceState
  serviceState = null
  try {
    await serviceManager.stopService(state, { graceMs: 2000 })
  } catch (error) {}
}

/**
 * 退出兜底。
 * 说明：正常关窗 / Cmd+Q / 菜单退出走 before-quit，能优雅收掉服务；
 * 但被 SIGTERM（Linux 关机、任务管理器结束进程）时 Electron 直接退出，
 * before-quit 不会触发，必须在这里补一条清理路径，否则会留下孤儿子进程，
 * 和下次启动的服务并发读写同一个数据目录。
 */
function installExitHooks() {
  const gracefulExit = () => {
    if (shuttingDown) return
    shuttingDown = true
    teardownService().then(() => app.exit(0)).catch(() => app.exit(0))
    setTimeout(() => app.exit(0), 2500)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try { process.on(signal, gracefulExit) } catch (error) {}
  }
  // 最后一道同步兜底：进程已经要走了，直接杀掉本次自己拉起的服务
  process.on('exit', () => {
    if (not(serviceState) || not(serviceState.child)) return
    try { serviceState.child.kill('SIGKILL') } catch (error) {}
  })
}

/* ------------------------------------------------------------- windows */

function isSameOrigin(target) {
  if (not(resolvedServiceUrl)) return false
  try {
    const left = new URL(resolvedServiceUrl)
    const right = new URL(target)
    return left.origin === right.origin
  } catch (error) {
    return false
  }
}

function loadLocal(window, file, query) {
  if (not(window) || window.isDestroyed()) return
  const target = path.join(__dirname, file)
  if (query) {
    window.loadFile(target, { query })
    return
  }
  window.loadFile(target)
}

/**
 * 窗口图标（任务栏 / 窗口左上角）。
 *
 * macOS 直接忽略这个参数 —— dock 图标来自 bundle 里的 icns，由打包脚本换。
 * Windows 认 .ico（多尺寸，系统自己挑），Linux 认 png。
 * 打包后资源在 resources/app/assets/icons/，开发态在仓库根 assets/icons/。
 */
function windowIconPath() {
  const file = process.platform === 'win32' ? 'aw.ico' : (process.platform === 'linux' ? 'al.png' : '')
  if (not(file)) return undefined
  const candidates = [
    path.join(app.getAppPath(), 'assets', 'icons', file),
    path.join(__dirname, '..', 'assets', 'icons', file)
  ]
  for (const item of candidates) {
    try {
      if (fs.existsSync(item)) return item
    } catch (error) {}
  }
  return undefined
}

function attachSecurity(window) {
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) { // win7-exempt (protocol check only, loads nothing)
      shell.openExternal(target)
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('file://')) return
    if (isSameOrigin(target)) return
    event.preventDefault()
    if (target.startsWith('http://') || target.startsWith('https://')) { // win7-exempt (protocol check only, loads nothing)
      shell.openExternal(target)
    }
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: APP_TITLE,
    icon: windowIconPath(),
    backgroundColor: windowBackground(config.theme),
    ...windowChromeOptions(),
    webPreferences: {
      additionalArguments: ['--dsh-controls-side=' + controlsSide(), '--dsh-theme=' + config.theme],
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  configureWindowMenu(mainWindow, { onSettings: createSettingsWindow, onQuit: () => app.quit(), onHide: () => app.hide() })
  attachWindowChrome(mainWindow)
  attachSecurity(mainWindow)
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return
    // 本地服务模式下加载失败，说明服务掉线了；远程模式说明地址不通
    if (not(resolvedServiceUrl)) return
    loadLocal(mainWindow, 'offline.html')
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 先显示启动页，服务就绪后再切到服务地址
  loadLocal(mainWindow, 'loading.html')
}

function createSettingsWindow() {
  if (settingsWindow && not(settingsWindow.isDestroyed())) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 620,
    height: 520,
    resizable: true,
    title: 'Service Settings',
    icon: windowIconPath(),
    backgroundColor: windowBackground(config.theme),
    ...windowChromeOptions(),
    webPreferences: {
      additionalArguments: ['--dsh-controls-side=' + controlsSide(), '--dsh-theme=' + config.theme],
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  configureWindowMenu(settingsWindow, { onSettings: createSettingsWindow, onQuit: () => app.quit(), onHide: () => app.hide() })
  attachWindowChrome(settingsWindow)
  attachSecurity(settingsWindow)
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'), { query: { standalone: '1' } })
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

async function restart() {
  await teardownService()
  resolvedServiceUrl = ''
  if (mainWindow && not(mainWindow.isDestroyed())) loadLocal(mainWindow, 'loading.html')
  await boot()
}

/* ---------------------------------------------------------------- startup */

function singleInstance() {
  const gotLock = app.requestSingleInstanceLock()
  if (not(gotLock)) {
    app.quit()
    return false
  }
  app.on('second-instance', () => {
    if (not(mainWindow) || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  return true
}

installExitHooks()

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  app.quit()
})

app.on('before-quit', (event) => {
  if (shuttingDown || not(serviceState)) return
  shuttingDown = true
  event.preventDefault()
  teardownService().then(() => app.quit()).catch(() => app.quit())
})

app.whenReady().then(async () => {
  readConfig()
  applyWindowTheme([], config.theme, nativeTheme)
  hideApplicationMenu(Menu)
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
      /* macOS 红叉关窗后点图标再开：服务多半早就就绪了。createMainWindow 只会挂
         loading.html，而 boot() 已经跑完、再没人把它切到服务页 —— 窗口就永远停在
         「已就绪」的启动页上（2026-09-19 用户截图骂的）。就绪就直接进界面；
         还没就绪的话 loading.html 会自己拉 startupState、boot 完成路径也会推给它。 */
      if (resolvedServiceUrl && mainWindow && not(mainWindow.isDestroyed())) {
        mainWindow.loadURL(resolvedServiceUrl)
      }
    }
  })

  // 更新判定必须排在单实例锁前面：旧版本正在跑的时候，锁在它手上，
  // 先抢锁会让新版直接退出，用户就永远看不到替换提示。
  const decision = resolveUpdate()
  if (decision.action === 'ask') {
    setUpdateState({ phase: 'idle', detail: '' })
    loadLocal(mainWindow, 'update.html')
    // 静默更新：带 --dsh-auto-update 启动时不等确认，直接替换。
    // 给「做快捷方式、以后双击就是更新」的用法留的口子，也让端到端测试能无人值守。
    if (process.argv.indexOf('--dsh-auto-update') >= 0) {
      setTimeout(() => { runUpdate() }, 400)
    }
    return
  }
  if (not(singleInstance())) return
  await boot()
})

/* ------------------------------------------------------------------ ipc */

/* 双击顶栏 —— 原生标题栏没了，这个手势得自己接（见 titlebarDoubleClickAction） */
ipcMain.on('shell:titlebar-dblclick', (event) => {
  applyTitlebarDoubleClick(BrowserWindow.fromWebContents(event.sender), titlebarDoubleClickAction())
})

ipcMain.handle('window:theme', () => config.theme)
ipcMain.on('window:theme', (event, value) => {
  if (!mainWindow || mainWindow.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== mainWindow) return
  if (value !== 'light' && value !== 'dark') return
  if (config.theme !== value) writeConfig({ theme: value })
  applyWindowTheme([mainWindow, settingsWindow], value, nativeTheme)
})

ipcMain.handle('window:state', (event) => windowState(BrowserWindow.fromWebContents(event.sender)))
ipcMain.handle('window:action', (event, action) => applyWindowAction(BrowserWindow.fromWebContents(event.sender), action))

ipcMain.handle('shell:get-config', () => ({
  mode: config.mode,
  serviceUrl: config.serviceUrl,
  lastPort: config.lastPort,
  resolvedServiceUrl,
  agentHome: agentHomePath(),
  version: appVersion(),
  programPath: isDesktopPackage() ? programDir() : app.getAppPath(),
  startupState
}))

ipcMain.handle('shell:save-config', async (_event, value) => {
  const payload = value && typeof value === 'object' ? value : { serviceUrl: value }
  const mode = payload.mode === 'remote' ? 'remote' : 'local'
  const nextUrl = normalizeServiceUrl(payload.serviceUrl)
  if (mode === 'remote' && not(nextUrl)) {
    throw new Error('Remote mode needs a service URL')
  }
  writeConfig({ mode, serviceUrl: nextUrl })
  await teardownService()
  resolvedServiceUrl = ''
  if (mainWindow && not(mainWindow.isDestroyed())) loadLocal(mainWindow, 'loading.html')
  await boot()
  if (settingsWindow && not(settingsWindow.isDestroyed())) settingsWindow.close()
  return { mode, serviceUrl: nextUrl }
})

ipcMain.handle('shell:retry', async () => {
  await restart()
  return { ok: true, startupState }
})

ipcMain.handle('shell:startup-state', () => startupState)

ipcMain.handle('shell:get-update-info', () => updateDecision)

ipcMain.handle('shell:update-state', () => updateState)

ipcMain.handle('shell:run-update', () => runUpdate())

ipcMain.handle('shell:use-current', () => useCurrent())

ipcMain.handle('shell:cancel-update', () => {
  app.exit(0)
  return { ok: true }
})

ipcMain.handle('shell:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '\u9009\u62e9\u6587\u4ef6\u5939',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return ''
  return result.filePaths[0]
})

ipcMain.handle('shell:open-settings', () => {
  createSettingsWindow()
  return { ok: true }
})
ipcMain.handle('shell:open-path', (_event, target) => {
  if (typeof target !== 'string' || !target.trim()) return 'A local path is required'
  return shell.openPath(path.resolve(target))
})
ipcMain.handle('shell:open-external', (_event, target) => {
  if (typeof target === 'string' && (target.startsWith('http://') || target.startsWith('https://'))) { // win7-exempt (protocol check only, loads nothing)
    return shell.openExternal(target)
  }
  return null
})
ipcMain.handle('shell:close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window) window.close()
  return { ok: true }
})
