'use strict'

/* 应用不显示原生菜单。macOS 的 Cmd 编辑快捷键原本由菜单 role 提供，
   移除菜单后直接调用相同的 webContents 编辑命令；Windows/Linux 保留
   Chromium 和终端自己的 Ctrl 按键处理（尤其 Ctrl+C 的中断行为）。 */
function hideApplicationMenu(Menu, platform) {
  // Electron 22 的 macOS 分支对 null 直接 return，必须用空实例替换原生菜单。
  const empty = (platform || process.platform) === 'darwin' ? Menu.buildFromTemplate([]) : null
  Menu.setApplicationMenu(empty)
}

function editingCommand(input, platform) {
  if (platform !== 'darwin' || !input || input.type !== 'keyDown' || input.isComposing) return ''
  if (!input.meta || input.control) return ''
  const key = String(input.key || '').toLowerCase()
  if (key === 'v' && input.shift) return 'pasteAndMatchStyle'
  if (input.alt) return ''
  if (key === 'z') return input.shift ? 'redo' : 'undo'
  if (input.shift) return ''
  return { x: 'cut', c: 'copy', v: 'paste', a: 'selectAll' }[key] || ''
}

function configureWindowMenu(win, handlers, platform) {
  const os = platform || process.platform
  const hooks = handlers || {}
  if (os !== 'darwin') {
    // 移除菜单对象，Alt 也不能把它重新展开。
    win.setMenu(null)
    win.setMenuBarVisibility(false)
  }
  win.webContents.on('before-input-event', (event, input) => {
    const command = editingCommand(input, os)
    if (command) {
      event.preventDefault()
      win.webContents[command]()
      return
    }
    if (!input || input.type !== 'keyDown' || input.isComposing || input.alt || input.shift) return
    const primary = os === 'darwin' ? input.meta && !input.control : input.control && !input.meta
    if (!primary) return
    const key = String(input.key || '').toLowerCase()
    let action = key === ',' ? hooks.onSettings : null
    if (os === 'darwin') {
      if (key === 'q') action = hooks.onQuit
      if (key === 'h') action = hooks.onHide
      if (key === 'w') action = () => win.close()
      if (key === 'm') action = () => win.minimize()
    }
    if (typeof action !== 'function') return
    event.preventDefault()
    if (!input.isAutoRepeat) action()
  })
}

module.exports = { hideApplicationMenu, configureWindowMenu, editingCommand }
