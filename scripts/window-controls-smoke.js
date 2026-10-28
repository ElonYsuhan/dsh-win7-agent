#!/usr/bin/env node
'use strict'

/* Platform window actions, Linux button placement and both sandbox preloads.
   All OS branches use injected inputs; no user preferences are modified. */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const chrome = require('../shell/window-chrome')
const ROOT = path.resolve(__dirname, '..')
let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('PASS  ' + name)
}

for (const platform of ['darwin', 'win32']) {
  check(platform + ': native button side is deterministic', () => assert.strictEqual(chrome.detectControlsSide(platform), platform === 'darwin' ? 'left' : 'right'))
}
for (const [layout, expected] of [["'close,minimize,maximize:'", 'left'], ["':minimize,maximize,close'", 'right'], ['menu:minimize,maximize,close', 'right'], ['invalid', 'right']]) {
  check('Linux GNOME layout ' + layout + ' -> ' + expected, () => {
    const seen = []
    const side = chrome.detectControlsSide('linux', { env: {}, execFileSync: (...args) => { seen.push(args); return layout } })
    assert.strictEqual(side, expected)
    assert.strictEqual(seen[0][0], 'gsettings')
    assert.deepStrictEqual(seen[0][1], ['get', 'org.gnome.desktop.wm.preferences', 'button-layout'])
    assert(seen[0][2].timeout <= 1000)
  })
}
for (const [left, right, expected] of [['MSX', '', 'left'], ['', 'MSX', 'right']]) {
  check('Linux KDE decoration -> ' + expected, () => {
    const files = []
    const side = chrome.detectControlsSide('linux', {
      env: { XDG_CURRENT_DESKTOP: 'KDE', XDG_CONFIG_HOME: '/__fixture__' },
      readFileSync: (file) => { files.push(file); return '[Other]\nButtonsOnLeft=X\n[org.kde.kdecoration2]\nButtonsOnLeft=' + left + '\nButtonsOnRight=' + right + '\n[OtherSection]\nButtonsOnRight=X' },
      execFileSync: () => { throw new Error('must not query GNOME after a valid KDE preference') }
    })
    assert.strictEqual(side, expected)
    assert.deepStrictEqual(files, [require('path').join('/__fixture__','kwinrc')])
  })
}
check('Linux missing/failed preference tools safely defaults to right', () => {
  assert.strictEqual(chrome.detectControlsSide('linux', { env: { XDG_CURRENT_DESKTOP: 'KDE' }, readFileSync() { throw new Error('missing') }, execFileSync() { throw new Error('missing') } }), 'right')
})

function fakeWindow() {
  const win = new EventEmitter()
  win.webContents = new EventEmitter()
  win.webContents.isDestroyed = () => false
  const sent = []
  win.webContents.send = (...args) => sent.push(args)
  let maximized = false
  let destroyed = false
  const calls = []
  const backgrounds = []
  Object.assign(win, {
    isDestroyed: () => destroyed, isMaximized: () => maximized,
    isFullScreen: () => false, isFocused: () => true,
    maximize: () => { calls.push('maximize'); maximized = true },
    unmaximize: () => { calls.push('unmaximize'); maximized = false },
    minimize: () => calls.push('minimize'), close: () => { calls.push('close'); destroyed = true },
    setBackgroundColor: (color) => backgrounds.push(color)
  })
  return { win, sent, calls, backgrounds }
}

for (const [theme, normalized, background] of [['light', 'light', '#ffffff'], ['dark', 'dark', '#212121'], ['blue', 'dark', '#212121'], [null, 'dark', '#212121']]) {
  check('window theme ' + String(theme) + ' normalizes to ' + normalized, () => {
    assert.strictEqual(chrome.normalizeTheme(theme), normalized)
    assert.strictEqual(chrome.windowBackground(theme), background)
    const live = fakeWindow()
    const destroyed = fakeWindow()
    destroyed.win.close()
    const nativeTheme = { themeSource: 'system' }
    chrome.applyWindowTheme([live.win, destroyed.win], theme, nativeTheme)
    assert.strictEqual(nativeTheme.themeSource, normalized)
    assert.deepStrictEqual(live.backgrounds, [background])
    assert.deepStrictEqual(live.sent, [['window:theme', normalized]])
    assert.deepStrictEqual(destroyed.backgrounds, [])
    assert.deepStrictEqual(destroyed.sent, [])
  })
}
for (const platform of ['darwin', 'win32', 'linux']) {
  const f = fakeWindow()
  check(platform + ': state carries button ownership and OS', () => {
    const state = chrome.windowState(f.win, platform)
    assert.strictEqual(state.platform, platform)
    assert.strictEqual(state.nativeControls, platform === 'darwin')
    assert.strictEqual(state.maximized, false)
    assert.strictEqual(state.fullScreen, false)
  })
  check(platform + ': maximize/restore/minimize act on the supplied window', () => {
    for (const action of ['toggle-maximize', 'toggle-maximize', 'minimize']) assert.strictEqual(chrome.applyWindowAction(f.win, action), true)
    assert.deepStrictEqual(f.calls.splice(0), ['maximize', 'unmaximize', 'minimize'])
  })
  check(platform + ': unknown actions do not change the window', () => {
    for (const action of ['quit', '', null, {}]) assert.strictEqual(chrome.applyWindowAction(f.win, action), false)
    assert.deepStrictEqual(f.calls, [])
  })
  chrome.attachWindowChrome(f.win, platform)
  check(platform + ': native changes publish window state', () => {
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) f.win.emit(event)
    f.win.webContents.emit('did-finish-load')
    assert.strictEqual(f.sent.length, 7)
    assert(f.sent.every((entry) => entry[0] === 'window:state' && entry[1].platform === platform))
  })
  check(platform + ': close and destroyed-window guards work', () => {
    assert.strictEqual(chrome.applyWindowAction(f.win, 'close'), true)
    assert.deepStrictEqual(f.calls, ['close'])
    assert.strictEqual(chrome.applyWindowAction(f.win, 'minimize'), false)
    assert.strictEqual(chrome.windowState(f.win, platform), null)
    f.win.emit('focus')
    assert.strictEqual(f.sent.length, 7)
  })
}

function functionFrom(source, name, env) {
  source = source.replace(/\r\n/g, '\n')
  const start = source.indexOf('function ' + name)
  const end = source.indexOf('\n}\n', start) + 2
  return vm.runInNewContext('(' + source.slice(start, end) + ')', env)
}
for (const file of ['shell/main.js', 'src/main/main.js']) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
  for (const [value, expected] of [['Maximize', 'maximize'], ['Minimize', 'minimize'], ['None', 'none'], [undefined, 'maximize'], ['unsupported', 'none']]) {
    check(file + ': mac double click respects ' + String(value), () => {
      let key
      const fn = functionFrom(source, 'titlebarDoubleClickAction', { process: { platform: 'darwin' }, systemPreferences: { getUserDefault: (k) => { key = k; return value } } })
      assert.strictEqual(fn(), expected)
      assert.strictEqual(key, 'AppleActionOnDoubleClick')
    })
  }
  for (const platform of ['win32', 'linux']) {
    check(file + ': ' + platform + ' double click maximizes', () => assert.strictEqual(functionFrom(source, 'titlebarDoubleClickAction', { process: { platform } })(), 'maximize'))
  }
}

function fakeElement(tag) {
  const classes = new Set()
  const attributes = {}
  const listeners = {}
  const element = {
    tagName: tag.toUpperCase(), children: [], attributes, listeners,
    classList: { add: (...names) => names.forEach((name) => classes.add(name)), toggle: (name, value) => value ? classes.add(name) : classes.delete(name), contains: (name) => classes.has(name) },
    setAttribute: (key, value) => {
      const changed = attributes[key] !== String(value)
      attributes[key] = String(value)
      if (changed) for (const observer of (element.observers || [])) Promise.resolve().then(() => { if (!observer.disconnected) observer.callback() })
    },
    getAttribute: (key) => attributes[key] === undefined ? null : attributes[key],
    removeAttribute: (key) => { delete attributes[key] },
    appendChild: (child) => { element.children.push(child); element.firstChild = element.children[0] },
    addEventListener: (type, callback) => { listeners[type] = callback }
  }
  return element
}
async function preloadFixture(file, platform, side, options) {
  const opts = options || {}
  const root = fakeElement('html')
  if (opts.currentTheme) root.setAttribute('data-theme', opts.currentTheme)
  const bar = fakeElement('header')
  const app = opts.mainPage ? fakeElement('div') : null
  const docListeners = {}
  const windowListeners = {}
  const apis = {}
  const ipc = new EventEmitter()
  const calls = []
  const initial = { platform, controlsSide: side, nativeControls: platform === 'darwin', maximized: false, fullScreen: false, focused: true }
  let resolveTheme
  const pendingTheme = opts.delayedGetter ? new Promise((resolve) => { resolveTheme = resolve }) : null
  ipc.invoke = (name, ...args) => {
    calls.push([name, ...args])
    if (name === 'window:theme') return pendingTheme || Promise.resolve(opts.hostTheme || 'dark')
    return Promise.resolve(name === 'window:state' ? initial : true)
  }
  ipc.send = (...args) => calls.push(args)
  class FixtureMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false }
    observe(element) { if (!element.observers) element.observers = []; element.observers.push(this) }
    disconnect() { this.disconnected = true }
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    process: { platform, argv: ['--dsh-controls-side=' + side, '--dsh-theme=' + (opts.initialTheme || 'dark')] }, console,
    window: { addEventListener: (type, cb) => { windowListeners[type] = cb } }, MutationObserver: FixtureMutationObserver,
    document: { documentElement: root, readyState: 'complete', getElementById: (id) => id === 'titlebarDrag' ? bar : (id === 'app' ? app : null), createElement: fakeElement, addEventListener: (type, cb) => { docListeners[type] = cb } },
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, api) => { apis[name] = api } } })
  })
  await Promise.resolve()
  return { root, bar, apis, ipc, calls, docListeners, windowListeners, initial, resolveTheme }
}

async function runPreloads() {
  for (const file of ['shell/preload.js', 'src/main/preload.js']) {
    const helper = await preloadFixture(file, 'darwin', 'left', { hostTheme: 'light', initialTheme: 'dark' })
    check(file + ': auxiliary page reads the saved host theme', () => assert.strictEqual(helper.root.getAttribute('data-theme'), 'light'))
    check(file + ': auxiliary pages follow valid broadcasts and ignore invalid themes', () => {
      helper.ipc.emit('window:theme', {}, 'dark')
      assert.strictEqual(helper.root.getAttribute('data-theme'), 'dark')
      helper.ipc.emit('window:theme', {}, 'cyan')
      assert.strictEqual(helper.root.getAttribute('data-theme'), 'dark')
      helper.ipc.emit('window:theme', {}, 'light')
      assert.strictEqual(helper.root.getAttribute('data-theme'), 'light')
      assert.strictEqual(helper.calls.filter((call) => call[0] === 'window:theme' && call.length > 1).length, 0)
    })
    const main = await preloadFixture(file, 'darwin', 'left', { mainPage: true, hostTheme: 'dark', initialTheme: 'dark', currentTheme: 'light' })
    check(file + ': main page keeps settings theme and publishes it to the host', () => {
      assert.strictEqual(main.root.getAttribute('data-theme'), 'light')
      assert(main.calls.some((call) => call[0] === 'window:theme' && call[1] === 'light'))
      main.ipc.emit('window:theme', {}, 'dark')
      assert.strictEqual(main.root.getAttribute('data-theme'), 'light')
    })
    main.root.setAttribute('data-theme', 'dark')
    await Promise.resolve()
    main.root.setAttribute('data-theme', 'light')
    await Promise.resolve()
    check(file + ': later settings changes publish without creating a broadcast loop', () => {
      const published = main.calls.filter((call) => call[0] === 'window:theme' && call.length > 1).map((call) => call[1])
      assert.deepStrictEqual(published, ['light', 'light'])
      assert.strictEqual(main.root.getAttribute('data-theme'), 'light')
      main.windowListeners.beforeunload()
      main.root.setAttribute('data-theme', 'dark')
    })
    await Promise.resolve()
    check(file + ': theme observer disconnects when the page unloads', () => assert.strictEqual(main.calls.filter((call) => call[0] === 'window:theme' && call.length > 1).length, 2))
    const race = await preloadFixture(file, 'darwin', 'left', { delayedGetter: true, initialTheme: 'light' })
    race.ipc.emit('window:theme', {}, 'light')
    race.resolveTheme('dark')
    await Promise.resolve()
    check(file + ': an older getter cannot overwrite a newer auxiliary-page broadcast', () => assert.strictEqual(race.root.getAttribute('data-theme'), 'light'))
    for (const [platform, side] of [['darwin', 'left'], ['win32', 'right'], ['linux', 'left'], ['linux', 'right']]) {
      const f = await preloadFixture(file, platform, side)
      const label = file + '/' + platform + '/' + side
      check(label + ': correct classes reserve the button side', () => {
        assert(f.root.classList.contains('shell-window'))
        assert(f.root.classList.contains(platform === 'darwin' ? 'shell-mac' : 'window-controls-' + side))
      })
      check(label + ': platform-appropriate controls are created', () => {
        assert.strictEqual(f.bar.children.length, platform === 'darwin' ? 0 : 2)
        if (platform === 'darwin') return
        const menu = f.bar.children[1]
        assert.strictEqual(menu.attributes['aria-label'], '应用菜单')
        menu.listeners.click()
        assert(f.calls.some(c => c[0] === 'app:menu-popup'))
        const group = f.bar.children[0]
        assert.strictEqual(group.attributes.role, 'group')
        assert.deepStrictEqual(group.children.map((button) => button.attributes['data-window-action']), ['minimize', 'toggle-maximize', 'close'])
        for (const button of group.children) {
          assert(button.attributes['aria-label'])
          assert.strictEqual(button.firstChild.attributes['aria-hidden'], 'true')
          button.listeners.click()
        }
        assert.deepStrictEqual(f.calls.filter((c) => c[0] === 'window:action').map((c) => c[1]), ['minimize', 'toggle-maximize', 'close'])
      })
      check(label + ': state changes update classes and restore icon', () => {
        f.ipc.emit('window:state', {}, Object.assign({}, f.initial, { maximized: true, focused: false, fullScreen: true }))
        for (const name of ['window-maximized', 'window-unfocused', 'window-fullscreen']) assert(f.root.classList.contains(name))
        if (platform !== 'darwin') {
          const button = f.bar.children[0].children[1]
          assert.strictEqual(button.attributes['aria-label'], '还原窗口')
          assert(button.firstChild.className.includes('icon-restore'))
        }
      })
      check(label + ': only titlebar background double clicks reach IPC', () => {
        const fire = (isBar, interactive) => f.docListeners.dblclick({ target: { closest: (selector) => selector === '#titlebarDrag' ? isBar : interactive } })
        fire(true, false)
        fire(true, true)
        fire(false, false)
        assert.strictEqual(f.calls.filter((c) => c[0] === 'shell:titlebar-dblclick').length, 1)
      })
      check(label + ': public event API unsubscribes cleanly', () => {
        let count = 0
        const off = f.apis.desktopWindow.onState(() => { count++ })
        f.ipc.emit('window:state', {}, f.initial)
        off()
        f.ipc.emit('window:state', {}, f.initial)
        assert.strictEqual(count, 1)
        assert.strictEqual(typeof f.apis.desktopWindow.onState(null), 'function')
        assert.strictEqual(typeof f.apis.desktopWindow.getState, 'function')
        assert.strictEqual(typeof f.apis.desktopWindow.action, 'function')
      })
    }
  }
  console.log('window controls smoke: ' + passed + '/' + passed + ' checks passed, node ' + process.version)
}
runPreloads().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
