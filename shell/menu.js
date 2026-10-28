'use strict'

const COMMANDS = ['new-session', 'add-project', 'settings', 'sidebar', 'panel', 'markdown', 'close-file']

function hideApplicationMenu(Menu) {
  // 保留旧调用入口名称，实际安装有用的应用菜单。
  const { app, BrowserWindow, dialog, shell, clipboard } = require('electron')
  const focused = () => BrowserWindow.getFocusedWindow()
  const send = (id) => {
    const win = focused()
    if (!win || !win.__menuReady || !COMMANDS.includes(id)) return
    const state = win.__menuState || {}
    if (id === 'close-file' && !state.file || id === 'markdown' && !state.markdown) return
    win.webContents.send('app:command', id)
  }
  const page = (label, id, accelerator) => ({ label, id, accelerator, enabled: false, ...(['sidebar', 'panel', 'markdown'].includes(id) ? { type: 'checkbox', checked: false } : {}), click: () => send(id) })
  const about = () => dialog.showMessageBox({ type: 'info', title: '关于 Agent', message: 'Agent ' + app.getVersion(), detail: 'Electron ' + process.versions.electron + '\nNode ' + process.versions.node + '\nChromium ' + process.versions.chrome })
  const help = (shortcuts) => dialog.showMessageBox({ type: 'info', title: shortcuts ? '快捷键' : '使用说明', message: shortcuts ? '常用快捷键' : 'Agent 使用说明', detail: shortcuts ? 'Cmd/Ctrl+N：新建会话\nCmd/Ctrl+,：设置\nCmd/Ctrl+B：显示/隐藏侧栏\nCmd/Ctrl+C / V：复制 / 粘贴\nEnter：发送消息\nShift+Enter：换行' : '添加项目文件夹后，在项目中创建会话即可处理工作区文件。普通会话可直接聊天。\n文件编辑自动保存；关闭前请留意保存状态。\n设置中可配置模型、权限、主题和品牌显示。' })
  const mac = process.platform === 'darwin'
  const template = []
  if (mac) template.push({ label: 'Agent', submenu: [{ label: '关于 Agent', click: about }, { type: 'separator' }, page('设置…', 'settings', 'CmdOrCtrl+,'), { type: 'separator' }, { role: 'hide', label: '隐藏 Agent' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出 Agent' }] })
  template.push({ label: '文件', submenu: [page('新建会话', 'new-session', 'CmdOrCtrl+N'), page('添加项目…', 'add-project'), page('关闭当前文件', 'close-file', 'CmdOrCtrl+Shift+W'), ...(!mac ? [page('设置…', 'settings', 'CmdOrCtrl+,')] : []), { type: 'separator' }, { role: 'close', label: '关闭窗口' }, ...(!mac ? [{ role: 'quit', label: '退出' }] : [])] })
  template.push({ label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' }, { role: 'selectAll', label: '全选' }] })
  template.push({ label: '视图', submenu: [page('显示/隐藏侧栏', 'sidebar', 'CmdOrCtrl+B'), page('显示/隐藏文件面板', 'panel'), page('Markdown 侧边预览', 'markdown'), { type: 'separator' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '实际大小' }, { role: 'togglefullscreen', label: '全屏' }] })
  template.push({ label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, (mac ? { role: 'zoom', label: '缩放/还原' } : { label: '最大化/还原', click: () => { const win = focused(); if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize() } } }), ...(mac ? [{ type: 'separator' }, { role: 'front', label: '全部置于前面' }] : [])] })
  template.push({ label: '帮助', submenu: [{ label: '使用说明', click: () => help(false) }, { label: '快捷键', click: () => help(true) }, { label: '打开日志目录', click: async () => { const error = await shell.openPath(app.getPath('logs')); if (error) dialog.showErrorBox('无法打开日志目录', error) } }, { label: '复制诊断信息', click: () => clipboard.writeText(JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch, runtime: process.versions }, null, 2)) }, ...(!mac ? [{ label: '关于 Agent', click: about }] : [])] })
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}

// 原生 role 统一处理编辑快捷键，避免与 before-input-event 重复执行。
function editingCommand() { return '' }

function configureWindowMenu(win) {
  const { app, Menu, ipcMain, dialog, shell, clipboard } = require('electron')
  const menu = Menu.getApplicationMenu()
  const update = () => {
    if (!menu) return
    for (const id of COMMANDS) {
      const item = menu.getMenuItemById(id)
      if (item) {
        const state = win.__menuState || {}
        if (id === 'sidebar') item.checked = state.sidebar === true
        if (id === 'panel') item.checked = state.panel === true
        if (id === 'markdown') item.checked = state.preview === true
        item.enabled = win.isFocused() && win.__menuReady === true && (id !== 'close-file' || state.file === true) && (id !== 'markdown' || state.markdown === true)
      }
    }
  }
  const ready = (event) => {
    if (event.sender !== win.webContents) return
    win.__menuReady = true
    if (win.isFocused()) update()
  }
  /* 菜单由渲染层自绘（src/renderer/app-menu.js 的 .app-menu）。
     原生 menu.popup() 的两列浮层是 Chromium 自己的实现：左列与右面板顶边差 17px、
     字号 16px、配色也不跟主题走，CSS 完全够不着 —— 所以只留「开菜单」这一个通知，
     命令再从 app:menu-invoke 回来，白名单与状态门控和原生菜单完全一致。 */
  const popup = (event) => {
    if (event.sender !== win.webContents) return
    update()
    win.webContents.send('app:menu-open')
  }
  const editors = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', 'paste-style': 'pasteAndMatchStyle', 'select-all': 'selectAll' }
  const about = () => dialog.showMessageBox({ type: 'info', title: '关于 Agent', message: 'Agent ' + app.getVersion(), detail: 'Electron ' + process.versions.electron + '\nNode ' + process.versions.node + '\nChromium ' + process.versions.chrome })
  /* 文案与 hideApplicationMenu 里的 help() 保持一致：原生菜单栏（Alt）仍会用到那一份。 */
  const usage = (shortcuts) => dialog.showMessageBox({ type: 'info', title: shortcuts ? '快捷键' : '使用说明', message: shortcuts ? '常用快捷键' : 'Agent 使用说明', detail: shortcuts ? 'Cmd/Ctrl+N：新建会话\nCmd/Ctrl+,：设置\nCmd/Ctrl+B：显示/隐藏侧栏\nCmd/Ctrl+C / V：复制 / 粘贴\nEnter：发送消息\nShift+Enter：换行' : '添加项目文件夹后，在项目中创建会话即可处理工作区文件。普通会话可直接聊天。\n文件编辑自动保存；关闭前请留意保存状态。\n设置中可配置模型、权限、主题和品牌显示。' })
  const invoke = (event, id) => {
    if (event.sender !== win.webContents || typeof id !== 'string') return
    const wc = win.webContents
    if (COMMANDS.includes(id)) {
      if (!win.__menuReady) return
      const state = win.__menuState || {}
      if ((id === 'close-file' && !state.file) || (id === 'markdown' && !state.markdown)) return
      wc.send('app:command', id)
      return
    }
    if (editors[id]) return wc[editors[id]]()
    if (id === 'zoom-in') return wc.setZoomLevel(wc.getZoomLevel() + 0.5)
    if (id === 'zoom-out') return wc.setZoomLevel(wc.getZoomLevel() - 0.5)
    if (id === 'zoom-reset') return wc.setZoomLevel(0)
    if (id === 'fullscreen') return win.setFullScreen(!win.isFullScreen())
    if (id === 'minimize') return win.minimize()
    if (id === 'toggle-maximize') return win.isMaximized() ? win.unmaximize() : win.maximize()
    if (id === 'close-window') return win.close()
    if (id === 'quit') return app.quit()
    if (id === 'usage') return usage(false)
    if (id === 'shortcuts') return usage(true)
    if (id === 'about') return about()
    if (id === 'open-logs') return shell.openPath(app.getPath('logs')).then((error) => { if (error) dialog.showErrorBox('无法打开日志目录', error) })
    if (id === 'copy-diagnostics') return clipboard.writeText(JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch, runtime: process.versions }, null, 2))
  }
  const stateChanged = (event, value) => {
    if (event.sender !== win.webContents || !value || typeof value !== 'object') return
    win.__menuState = { file: value.file === true, markdown: value.markdown === true, sidebar: value.sidebar === true, panel: value.panel === true, preview: value.preview === true }
    if (win.isFocused()) update()
  }
  ipcMain.on('app:menu-state', stateChanged)
  ipcMain.on('app:menu-ready', ready)
  ipcMain.on('app:menu-popup', popup)
  ipcMain.on('app:menu-invoke', invoke)
  win.on('focus', update)
  win.webContents.on('did-start-loading', () => { win.__menuReady = false; if (win.isFocused()) update() })
  win.on('closed', () => {
    ipcMain.removeListener('app:menu-state', stateChanged)
    ipcMain.removeListener('app:menu-ready', ready)
    ipcMain.removeListener('app:menu-popup', popup)
    ipcMain.removeListener('app:menu-invoke', invoke)
  })
  if (process.platform !== 'darwin') {
    /* 菜单栏永久隐藏，也不让 Alt 把它翻出来 —— 那份原生菜单和自绘的 .app-menu 是两套外观，
       露出来只会让人以为菜单坏了。快捷键仍由 Menu.setApplicationMenu 注册的加速键负责。 */
    win.setAutoHideMenuBar(false)
    win.setMenuBarVisibility(false)
  }
}

module.exports = { hideApplicationMenu, configureWindowMenu, editingCommand }
