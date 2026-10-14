'use strict'

/* 在本机真实 Electron 22 中检查无菜单时的输入编辑。
   不写系统剪贴板，不使用真实用户设置，也不调用模型服务。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

async function run() {
  const { app, BrowserWindow, Menu } = require('electron')
  const { hideApplicationMenu, configureWindowMenu } = require('../shell/menu')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-runtime-'))
  app.setPath('userData', temporary)
  app.disableHardwareAcceleration()
  await app.whenReady()
  const previousMenu = Menu.buildFromTemplate([
    { label: 'Agent', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }] },
    { label: 'Service', submenu: [{ label: 'Settings' }] },
    { label: 'View', submenu: [{ role: 'reload' }] }
  ])
  Menu.setApplicationMenu(previousMenu)
  hideApplicationMenu(Menu)
  app.on('window-all-closed', () => {})
  let win
  let passed = 0
  function check(name, condition) {
    assert(condition, name)
    passed++
    console.log('PASS  ' + name)
  }
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    win = new BrowserWindow({ width: 650, height: 300, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
    configureWindowMenu(win)
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<input id="field" value="original"><div id="editable" contenteditable="true">composer</div>'))
    win.focus()
    const currentMenu = Menu.getApplicationMenu()
    check('old Agent/Edit/Service/View menu is replaced', currentMenu !== previousMenu)
    check('application menu has no visible items (' + process.platform + ')', process.platform === 'darwin'
      ? currentMenu && currentMenu.items.length === 0
      : currentMenu === null)
    if (process.platform !== 'darwin') check('window menu is invisible', !win.isMenuBarVisible())
    const contents = win.webContents
    function press(key, shift) {
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      if (shift) modifiers.push('shift')
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    }
    for (const id of ['field', 'editable']) {
      await contents.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').focus()')
      press('A')
      await delay(60)
      const selected = await contents.executeJavaScript(id === 'field'
        ? 'document.getElementById("field").selectionEnd - document.getElementById("field").selectionStart'
        : 'window.getSelection().toString().length')
      check(id + ': select all works without Edit menu', selected === 8)
      await contents.insertText('replacement')
      await delay(60)
      const expression = id === 'field' ? 'document.getElementById("field").value' : 'document.getElementById("editable").innerText'
      check(id + ': typing replaces selected content', await contents.executeJavaScript(expression) === 'replacement')
      press('Z')
      await delay(60)
      check(id + ': undo works without Edit menu', await contents.executeJavaScript(expression) === (id === 'field' ? 'original' : 'composer'))
      press('Z', true)
      await delay(60)
      check(id + ': redo works without Edit menu', await contents.executeJavaScript(expression) === 'replacement')
    }
    console.log('shell menu runtime smoke: ' + passed + '/' + passed + ' checks passed; Electron ' + process.versions.electron + ', Node ' + process.version + ', ' + process.platform)
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  app.exit(0)
}

if (process.versions.electron && process.type === 'browser') {
  run().catch((error) => {
    console.error(error.stack || error)
    require('electron').app.exit(1)
  })
} else {
  const { spawnSync } = require('child_process')
  const binary = require('electron')
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const args = [__filename]
  if (process.env.SMOKE_NO_SANDBOX === '1') args.push('--no-sandbox')
  const result = spawnSync(binary, args, { env, stdio: 'inherit', timeout: 45000 })
  if (result.error) console.error(result.error.message)
  process.exit(result.status === 0 ? 0 : 1)
}
