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
  const { Menu, ipcMain } = require('electron')
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
  const popup = (event) => {
    if (event.sender === win.webContents && menu) { update(); menu.popup({ window: win }) }
  }
  const stateChanged = (event, value) => {
    if (event.sender !== win.webContents || !value || typeof value !== 'object') return
    win.__menuState = { file: value.file === true, markdown: value.markdown === true, sidebar: value.sidebar === true, panel: value.panel === true, preview: value.preview === true }
    if (win.isFocused()) update()
  }
  ipcMain.on('app:menu-state', stateChanged)
  ipcMain.on('app:menu-ready', ready)
  ipcMain.on('app:menu-popup', popup)
  win.on('focus', update)
  win.webContents.on('did-start-loading', () => { win.__menuReady = false; if (win.isFocused()) update() })
  win.on('closed', () => {
    ipcMain.removeListener('app:menu-state', stateChanged)
    ipcMain.removeListener('app:menu-ready', ready)
    ipcMain.removeListener('app:menu-popup', popup)
  })
  if (process.platform !== 'darwin') {
    win.setMenuBarVisibility(false)
    win.setAutoHideMenuBar(true)
  }
}

module.exports = { hideApplicationMenu, configureWindowMenu, editingCommand }
