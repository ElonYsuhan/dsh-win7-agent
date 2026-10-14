#!/usr/bin/env node
'use strict'

/* 无原生菜单 + 编辑/窗口快捷键回归。普通 Node 可模拟三个平台，
   Windows/Linux 的 Ctrl+C 必须继续送给终端，不能被编辑快捷键吞掉。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const { hideApplicationMenu, configureWindowMenu } = require('../shell/menu')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('PASS  ' + name)
}

function fixture(platform) {
  const calls = []
  const webContents = new EventEmitter()
  for (const command of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']) {
    webContents[command] = () => calls.push(command)
  }
  const win = {
    webContents,
    setMenu: (value) => calls.push(['menu', value]),
    setMenuBarVisibility: (value) => calls.push(['visible', value]),
    close: () => calls.push('close'),
    minimize: () => calls.push('minimize')
  }
  configureWindowMenu(win, {
    onSettings: () => calls.push('settings'),
    onQuit: () => calls.push('quit'),
    onHide: () => calls.push('hide')
  }, platform)
  function press(key, patch) {
    let prevented = 0
    const input = Object.assign({ type: 'keyDown', key, meta: platform === 'darwin', control: platform !== 'darwin' }, patch)
    webContents.emit('before-input-event', { preventDefault: () => { prevented++ } }, input)
    return prevented
  }
  return { calls, press }
}

for (const platform of ['darwin', 'win32', 'linux']) {
  check(platform + ': application menu is removed', () => {
    const calls = []
    const empty = { items: [] }
    hideApplicationMenu({
      buildFromTemplate: (template) => { assert.deepStrictEqual(template, []); return empty },
      setApplicationMenu: (value) => calls.push(value)
    }, platform)
    assert.deepStrictEqual(calls, [platform === 'darwin' ? empty : null])
  })
  const f = fixture(platform)
  check(platform + ': window menu is removed where supported', () => {
    assert.deepStrictEqual(f.calls, platform === 'darwin' ? [] : [['menu', null], ['visible', false]])
    f.calls.length = 0
  })
  check(platform + ': service settings stay reachable with primary+comma', () => {
    assert.strictEqual(f.press(','), 1)
    assert.deepStrictEqual(f.calls.splice(0), ['settings'])
  })
  check(platform + ': keyup, IME and unrelated keys pass through', () => {
    assert.strictEqual(f.press(',', { type: 'keyUp' }), 0)
    assert.strictEqual(f.press(',', { isComposing: true }), 0)
    assert.strictEqual(f.press(',', { meta: false, control: false }), 0)
    assert.strictEqual(f.press('Enter'), 0)
    assert.strictEqual(f.press('Alt', { alt: true }), 0)
    assert.deepStrictEqual(f.calls, [])
  })
  if (platform !== 'darwin') {
    check(platform + ': Ctrl editing, terminal interrupt and word-delete stay native', () => {
      for (const key of ['c', 'v', 'x', 'a', 'z', 'y', 'w']) assert.strictEqual(f.press(key), 0)
      assert.strictEqual(f.press('v', { shift: true }), 0)
      assert.deepStrictEqual(f.calls, [])
    })
  }
}

const f = fixture('darwin')
for (const [key, patch, command] of [
  ['c', {}, 'copy'], ['C', {}, 'copy'], ['x', {}, 'cut'], ['v', {}, 'paste'],
  ['a', {}, 'selectAll'], ['z', {}, 'undo'], ['z', { shift: true }, 'redo'],
  ['v', { shift: true }, 'pasteAndMatchStyle'], ['v', { shift: true, alt: true }, 'pasteAndMatchStyle'],
  ['q', {}, 'quit'], ['w', {}, 'close'], ['m', {}, 'minimize'], ['h', {}, 'hide']
]) {
  check('darwin: ' + command + ' works without a menu', () => {
    assert.strictEqual(f.press(key, patch), 1)
    assert.deepStrictEqual(f.calls.splice(0), [command])
  })
}
check('darwin: Ctrl+C, Option combinations and IME do not trigger editing', () => {
  assert.strictEqual(f.press('c', { meta: false, control: true }), 0)
  assert.strictEqual(f.press('c', { alt: true }), 0)
  assert.strictEqual(f.press('c', { shift: true }), 0)
  assert.strictEqual(f.press('v', { isComposing: true }), 0)
  assert.deepStrictEqual(f.calls, [])
})
check('darwin: key repeat cannot repeatedly quit or open settings', () => {
  assert.strictEqual(f.press('q', { isAutoRepeat: true }), 1)
  assert.strictEqual(f.press(',', { isAutoRepeat: true }), 1)
  assert.deepStrictEqual(f.calls, [])
})

for (const entry of ['shell/main.js', 'src/main/main.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8')
  check(entry + ': startup removes default application menu before creating windows', () => {
    const startup = source.slice(source.indexOf('app.whenReady().then'))
    assert(startup.indexOf('hideApplicationMenu(Menu)') >= 0)
    assert(startup.indexOf('hideApplicationMenu(Menu)') < startup.search(/create(?:Main)?Window\(\)/))
    assert(!/buildFromTemplate|menuTemplate\(/.test(source))
  })
  check(entry + ': every application window has shortcut/menu setup', () => {
    assert.strictEqual((source.match(/new BrowserWindow\(/g) || []).length,
      (source.match(/configureWindowMenu\(/g) || []).length)
  })
}

check('shell preload forwards openPath and openExternal to native IPC', () => {
  const calls = []
  let api
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'shell/preload.js'), 'utf8'), {
    process: { platform: 'linux' },
    window: { addEventListener() {} },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value } },
      ipcRenderer: { invoke: (...args) => { calls.push(args) }, on() {}, removeListener() {} }
    })
  })
  api.openPath('/tmp/中文 工作区')
  api.openExternal('https://example.com')
  assert.deepStrictEqual(calls.map((args) => Array.from(args)), [
    ['shell:open-path', '/tmp/中文 工作区'], ['shell:open-external', 'https://example.com']
  ])
})

check('shell IPC opens local paths and rejects empty or non-string input', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shell/main.js'), 'utf8')
  const start = source.indexOf("ipcMain.handle('shell:open-path'")
  const end = source.indexOf("ipcMain.handle('shell:open-external'", start)
  let handler
  const calls = []
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn } },
    shell: { openPath: (target) => { calls.push(target); return '' } },
    path
  })
  assert.strictEqual(handler({}, '/tmp/中文 工作区'), '')
  assert.deepStrictEqual(calls, ['/tmp/中文 工作区'])
  assert(handler({}, '') !== '')
  assert(handler({}, '  ') !== '')
  assert(handler({}, null) !== '')
  assert(handler({}, { path: '/tmp' }) !== '')
  assert.strictEqual(calls.length, 1)
})

console.log('shell menu smoke: ' + passed + '/' + passed + ' checks passed, node ' + process.version)
