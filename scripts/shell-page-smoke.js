#!/usr/bin/env node
'use strict'

/**
 * shell/update.html 的真实渲染冒烟。
 *
 * 为什么不并进 npm run check：它必须由一个真的 Electron 运行时驱动（Chromium 108），
 * 而且要开一个（隐藏的）浏览器窗口，在 CI / 无显示环境下容易挂。
 * 单独跑：node scripts/shell-page-smoke.js
 *
 * 两种跑法：
 *  - 被 node 跑：先找一个 Electron 运行时，再把自己交给它重跑
 *  - 被 Electron 跑（process.versions.electron 存在）：开隐藏窗口，注入桩 preload，断言页面
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const not = (value) => value ? false : true

/* ------------------------------------------------------- 找 Electron 运行时 */

function electronBinaryIn(dir) {
  if (process.platform === 'darwin') {
    return path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  if (process.platform === 'win32') return path.join(dir, 'electron.exe')
  return path.join(dir, 'electron')
}

function findElectron() {
  const unpackedName = process.platform === 'win32'
    ? 'win32-x64'
    : (process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64')
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist'),
    path.join(ROOT, 'release', '.electron-dist', 'unpacked', unpackedName),
    path.join(ROOT, 'release', '.electron-dist', 'unpacked', 'darwin-x64')
  ]
  for (const dir of candidates) {
    const binary = electronBinaryIn(dir)
    try {
      if (fs.existsSync(binary)) return binary
    } catch (error) {}
  }
  return ''
}

/* ---------------------------------------------------------------- 场景数据 */

const SCENARIOS = [
  {
    name: '旧版本没在运行',
    info: {
      oldPath: '/opt/Agent.app',
      oldVersion: '0.1.0',
      oldPid: 0,
      oldRunning: false,
      newPath: '/Users/me/Downloads/Agent.app',
      newVersion: '0.2.0',
      userData: '/Users/me/Library/Application Support/Agent'
    },
    expectKeepVisible: true
  },
  {
    name: '旧版本正在运行',
    info: {
      oldPath: '/opt/Agent.app',
      oldVersion: '0.1.0',
      oldPid: 4242,
      oldRunning: true,
      newPath: '/Users/me/Downloads/Agent.app',
      newVersion: '0.2.0',
      userData: '/Users/me/Library/Application Support/Agent'
    },
    expectKeepVisible: false
  }
]

const STUB_PRELOAD = `'use strict'
const { contextBridge } = require('electron')
const info = __INFO__
const calls = []
let stateCallback = null
contextBridge.exposeInMainWorld('shell', {
  getUpdateInfo: async () => { calls.push('getUpdateInfo'); return info },
  getUpdateState: async () => { calls.push('getUpdateState'); return { phase: 'idle', detail: '' } },
  onUpdateState: (callback) => {
    calls.push('onUpdateState')
    stateCallback = typeof callback === 'function' ? callback : null
    return () => { stateCallback = null }
  },
  runUpdate: async () => { calls.push('runUpdate'); return { ok: true } },
  useCurrent: async () => { calls.push('useCurrent'); return { ok: true } },
  cancelUpdate: async () => { calls.push('cancelUpdate'); return { ok: true } }
})
contextBridge.exposeInMainWorld('__calls', () => calls.slice())
contextBridge.exposeInMainWorld('__emitState', (state) => { if (stateCallback) stateCallback(state) })
`

/* -------------------------------------------------------------- Electron 侧 */

async function runInElectron() {
  const { app, BrowserWindow } = require('electron')
  let passed = 0
  let failed = 0

  function check(name, condition, detail) {
    if (condition) {
      passed++
      console.log('PASS  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
      return
    }
    failed++
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shellpage-'))
  const pageErrors = []

  // 被 Electron 直接跑时，脚本顶层就执行了，这时 app 还没 ready，
  // 建 BrowserWindow 会抛 "Cannot create BrowserWindow before app is ready"。
  await app.whenReady()

  // 场景之间会销毁窗口；不拦住 Electron 的默认行为就会把整个进程退掉，
  // 下一个场景的 loadFile 直接 ERR_FAILED。
  app.on('window-all-closed', () => {})

  async function runScenario(scenario, index) {
    const preload = path.join(tmp, 'preload-' + index + '.js')
    fs.writeFileSync(preload, STUB_PRELOAD.replace('__INFO__', JSON.stringify(scenario.info)), 'utf8')

    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) pageErrors.push(scenario.name + ': ' + message)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      pageErrors.push(scenario.name + ': renderer gone ' + JSON.stringify(details))
    })

    await win.loadFile(path.join(ROOT, 'shell', 'update.html'))
    // 等 update.js 的 init() 把桩数据渲染完
    await new Promise((resolve) => setTimeout(resolve, 500))

    /* 顶栏拖拽带：壳层页面也得有 —— macOS 上原生标题栏没了，整条顶边都要能按住拖窗口。
       .shell-mac 类真实运行时由 preload 打在 <html> 上，这里手动加上模拟。 */
    const band = await win.webContents.executeJavaScript(`(function () {
      document.documentElement.classList.add('shell-mac')
      const el = document.getElementById('titlebarDrag')
      if (!el) return { missing: true }
      const rect = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const w = window.innerWidth
      const hit = document.elementFromPoint(Math.round(w / 2), 20)
      return {
        missing: false,
        display: cs.display,
        region: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
        h: Math.round(rect.height),
        y: Math.round(rect.top),
        x: Math.round(rect.left),
        w: Math.round(rect.width),
        innerWidth: w,
        hit: hit ? '#' + (hit.id || '') + '.' + String(hit.className || '').split(/\\s+/).join('.') : 'null',
        paddingTop: parseFloat(getComputedStyle(document.body).paddingTop)
      }
    })()`)
    check(scenario.name + '：有 #titlebarDrag 元素', !band.missing)
    if (!band.missing) {
      check(scenario.name + '：拖拽带在 .shell-mac 下显示', band.display === 'block', band.display)
      check(scenario.name + '：拖拽带可拖拽', band.region === 'drag', String(band.region))
      check(scenario.name + '：拖拽带 40px 贴顶横贯整宽',
        band.h === 40 && band.y === 0 && band.x === 0 && band.w === band.innerWidth,
        band.h + 'px y=' + band.y + ' w=' + band.w + '/' + band.innerWidth)
      check(scenario.name + '：顶部正中命中拖拽带', band.hit.indexOf('titlebar-drag') >= 0, band.hit)
      check(scenario.name + '：内容区让开了拖拽带', band.paddingTop >= band.h, band.paddingTop + ' >= ' + band.h)
    }

    const snapshot = await win.webContents.executeJavaScript(`(function () {
      const text = (id) => { const el = document.getElementById(id); return el ? el.textContent : null }
      const hidden = (id) => { const el = document.getElementById(id); return el ? el.classList.contains('hidden') : null }
      return {
        title: document.title,
        hint: text('hint'),
        oldLabel: text('oldLabel'),
        oldPath: text('oldPath'),
        newLabel: text('newLabel'),
        newPath: text('newPath'),
        note: text('note'),
        status: text('status'),
        stepsHidden: hidden('steps'),
        actionsHidden: hidden('actions'),
        keepHidden: hidden('keep'),
        updateDisabled: document.getElementById('update').disabled,
        stepCount: document.querySelectorAll('#steps .step').length,
        calls: window.__calls()
      }
    })()`)

    check(scenario.name + '：页面标题', snapshot.title === 'Agent', snapshot.title)
    check(scenario.name + '：读到了更新信息', snapshot.calls.indexOf('getUpdateInfo') >= 0)
    check(scenario.name + '：订阅了进度推送', snapshot.calls.indexOf('onUpdateState') >= 0)
    check(scenario.name + '：旧版本版本号已渲染', snapshot.oldLabel.indexOf('v0.1.0') >= 0, snapshot.oldLabel)
    check(scenario.name + '：旧版本路径已渲染', snapshot.oldPath === scenario.info.oldPath, snapshot.oldPath)
    check(scenario.name + '：当前版本号已渲染', snapshot.newLabel.indexOf('v0.2.0') >= 0, snapshot.newLabel)
    check(scenario.name + '：当前路径已渲染', snapshot.newPath === scenario.info.newPath, snapshot.newPath)
    check(scenario.name + '：进度条有 4 步', snapshot.stepCount === 4, snapshot.stepCount)
    check(scenario.name + '：初始不显示进度条', snapshot.stepsHidden === true)
    check(scenario.name + '：初始显示操作按钮', snapshot.actionsHidden === false)
    check(
      scenario.name + '：「用当前这份」按旧版本是否在跑来决定是否显示',
      snapshot.keepHidden === not(scenario.expectKeepVisible),
      'keepHidden=' + snapshot.keepHidden
    )
    if (scenario.info.oldRunning) {
      check(scenario.name + '：提示会先关掉旧版本', snapshot.note.indexOf('关掉') >= 0, snapshot.note.slice(0, 40))
      check(scenario.name + '：标注旧版本正在运行', snapshot.oldLabel.indexOf('正在运行') >= 0, snapshot.oldLabel)
    }
    check(scenario.name + '：初始没有报错信息', snapshot.status === '', snapshot.status)

    // 推进度：进度条应出现、所在步骤变 active、按钮组隐藏
    await win.webContents.executeJavaScript("window.__emitState({ phase: 'copying', detail: '' })")
    await new Promise((resolve) => setTimeout(resolve, 200))
    const during = await win.webContents.executeJavaScript(`(function () {
      const hidden = (id) => { const el = document.getElementById(id); return el ? el.classList.contains('hidden') : null }
      const nodes = document.querySelectorAll('#steps .step')
      let active = -1
      let done = 0
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].classList.contains('active')) active = i
        if (nodes[i].classList.contains('done')) done++
      }
      return { stepsHidden: hidden('steps'), actionsHidden: hidden('actions'), active, done, hint: document.getElementById('hint').textContent }
    })()`)
    check(scenario.name + '：进行中显示进度条', during.stepsHidden === false)
    check(scenario.name + '：进行中隐藏按钮', during.actionsHidden === true)
    check(scenario.name + '：第 2 步为当前步骤', during.active === 1, 'active=' + during.active)
    check(scenario.name + '：第 1 步标记完成', during.done === 1, 'done=' + during.done)
    check(scenario.name + '：文案切到替换中', during.hint.indexOf('替换') >= 0, during.hint)

    // 失败态：按钮回来、报错上屏
    await win.webContents.executeJavaScript("window.__emitState({ phase: 'failed', detail: 'DIR_LOCKED' })")
    await new Promise((resolve) => setTimeout(resolve, 200))
    const afterFail = await win.webContents.executeJavaScript(`(function () {
      const hidden = (id) => { const el = document.getElementById(id); return el ? el.classList.contains('hidden') : null }
      return {
        actionsHidden: hidden('actions'),
        stepsHidden: hidden('steps'),
        keepHidden: hidden('keep'),
        status: document.getElementById('status').textContent,
        failed: document.querySelectorAll('#steps .step.failed').length
      }
    })()`)
    check(scenario.name + '：失败后按钮恢复', afterFail.actionsHidden === false)
    check(scenario.name + '：失败后仍显示进度条', afterFail.stepsHidden === false)
    check(scenario.name + '：失败步骤标红', afterFail.failed === 1, afterFail.failed)
    check(scenario.name + '：失败给出人话提示', afterFail.status.indexOf('占用') >= 0, afterFail.status.slice(0, 30))

    // 点「立即更新」应调到 runUpdate 并锁住按钮
    await win.webContents.executeJavaScript("document.getElementById('update').click()")
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterClick = await win.webContents.executeJavaScript(`(function () {
      return { calls: window.__calls(), disabled: document.getElementById('update').disabled }
    })()`)
    check(scenario.name + '：点击后调用 runUpdate', afterClick.calls.indexOf('runUpdate') >= 0, afterClick.calls.join(','))
    check(scenario.name + '：点击后按钮被锁', afterClick.disabled === true)

    win.destroy()
  }

  try {
    for (let index = 0; index < SCENARIOS.length; index++) {
      await runScenario(SCENARIOS[index], index)
    }
    check('页面没有报错', pageErrors.length === 0, pageErrors.join(' | ') || 'clean')
  } catch (error) {
    failed++
    console.log('FAIL  冒烟执行异常: ' + (error && error.stack ? error.stack : error))
  }

  console.log('')
  console.log('shell page smoke: ' + passed + '/' + (passed + failed) + ' checks passed, electron ' +
    process.versions.electron + ' / chromium ' + process.versions.chrome)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (error) {}
  app.exit(failed > 0 ? 1 : 0)
}

/* ------------------------------------------------------------- Node 侧入口 */

function runAsNode() {
  const binary = findElectron()
  if (not(binary)) {
    console.log('shell page smoke: skipped - 找不到 Electron 运行时')
    console.log('  装一个：npm i -D electron@22.3.27，或先跑一次 npm run build:desktop:mac 留下 release/.electron-dist')
    process.exit(0)
  }
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  /* 受限环境（容器/工具沙箱）里 Chromium 的 seatbelt 初始化会失败
     （"sandbox initialization failed: Operation not permitted"），
     设 SMOKE_NO_SANDBOX=1 可关掉它继续跑；默认不放开关。 */
  const args = [__filename]
  if (env.SMOKE_NO_SANDBOX === '1') args.unshift('--no-sandbox')
  console.log('shell page smoke: 用 ' + binary)
  const result = spawnSync(binary, args, { stdio: 'inherit', env })
  process.exit(result.status === null ? 1 : result.status)
}

if (process.versions && process.versions.electron) {
  runInElectron()
} else {
  runAsNode()
}
