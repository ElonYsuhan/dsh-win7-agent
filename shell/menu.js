'use strict'

/**
 * 应用菜单模板。
 *
 * 为什么单独拆一个文件：Electron 的剪贴板与撤销快捷键是由**菜单 role** 提供的，
 * 不是 Chromium 自带的。只要调用 Menu.setApplicationMenu() 换掉默认菜单，
 * 默认菜单里那套 Edit 就没了 —— 全应用的 Cmd/Ctrl + C / V / X / A 立刻失效。
 * 「Electron 里输入框粘贴不了内容」就是这么来的。
 *
 * 这块纯数据 + 回调不依赖 Electron，拆出来就能在普通 Node 下断言，
 * 见 scripts/shell-menu-smoke.js。
 */

/** 换掉默认菜单后必须自己补回来的 role。缺一个就少一个快捷键。 */
const EDIT_ROLES = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'pasteAndMatchStyle',
  'delete',
  'selectAll'
]

function editSubmenu() {
  return [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'pasteAndMatchStyle' },
    { role: 'delete' },
    { type: 'separator' },
    { role: 'selectAll' }
  ]
}

/**
 * 生成菜单模板。
 * @param {object} [handlers] 回调：onSettings / onReload / onRestart / onOpenBrowser
 * @param {string} [platform] 目标平台，默认 process.platform（测试时用来模拟）
 */
function menuTemplate(handlers, platform) {
  const hooks = handlers || {}
  const os = platform || process.platform
  const template = []

  // macOS：第一项固定占据「应用菜单」位置，label 由系统替换成应用名。
  // 用 role 声明才有 About / 服务 / 隐藏 / 退出 这些标准项。
  if (os === 'darwin') template.push({ role: 'appMenu' })

  template.push({
    label: 'Edit',
    submenu: editSubmenu()
  })

  template.push({
    label: 'Service',
    submenu: [
      { label: 'Settings', click: () => hooks.onSettings && hooks.onSettings() },
      { label: 'Reload', click: () => hooks.onReload && hooks.onReload() },
      { label: 'Restart local service', click: () => hooks.onRestart && hooks.onRestart() },
      { label: 'Open in browser', click: () => hooks.onOpenBrowser && hooks.onOpenBrowser() },
      { type: 'separator' },
      { role: 'quit' }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' }
    ]
  })

  return template
}

module.exports = { menuTemplate, EDIT_ROLES }
