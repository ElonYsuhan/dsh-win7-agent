#!/usr/bin/env node
'use strict'

/* Runs the real renderer in Electron 22 / Chromium 108 with temporary user data,
   virtual files and representative saved chat. No model requests or user files.
   Computed styles, actual mouse hover and keyboard focus verify both themes.
   Screenshots and measurements are written to release/validation. */

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawnSync } = require('child_process')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'release', 'validation')

function electronBinary() {
  const binary = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : (process.platform === 'win32' ? 'electron.exe' : 'electron')
  for (const base of ['node_modules/electron/dist', 'release/.electron-dist/unpacked/darwin-arm64', 'release/.electron-dist/unpacked/darwin-x64', 'release/.electron-dist/unpacked/linux-x64']) {
    const target = path.join(ROOT, base, binary)
    if (fs.existsSync(target)) return target
  }
  throw new Error('Electron runtime not found')
}

function serveRenderer() {
  const renderer = path.join(ROOT, 'src', 'renderer')
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const file = path.join(renderer, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0])
    if (!file.startsWith(renderer + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    const ext = path.extname(file)
    const mime = ext === '.js' ? 'application/javascript' : (ext === '.css' ? 'text/css' : (ext === '.png' ? 'image/png' : 'text/html'))
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' })
    res.end(fs.readFileSync(file))
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sockets, port: server.address().port })))
}

/* Composite transparent child surfaces over their actual parents before checking
   contrast. This avoids falsely treating a transparent icon button as black. */
const STYLE_HELPERS = `
  const rgba = (text) => {
    const hex = String(text).match(/^#([a-f0-9]{6})$/i);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
    const m = String(text).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return [0, 0, 0, 0];
    const a = m[1].split(',').map(Number);
    return [a[0], a[1], a[2], a.length === 4 ? a[3] : 1];
  };
  const composite = (front, back) => {
    const alpha = front[3] + back[3] * (1 - front[3]);
    if (!alpha) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha).concat(alpha);
  };
  const bg = (el) => {
    const chain = [];
    for (let node = el; node; node = node.parentElement) chain.push(rgba(getComputedStyle(node).backgroundColor));
    return chain.reverse().reduce((back, front) => composite(front, back), [255, 255, 255, 1]);
  };
  const lum = (value) => {
    const channels = value.slice(0, 3).map((v) => { const s = v / 255; return s <= .04045 ? s / 12.92 : Math.pow((s + .055) / 1.055, 2.4); });
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  const visible = (el) => Boolean(el && el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
  const style = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el), background = bg(el), color = composite(rgba(s.color), background);
    const b = el.getBoundingClientRect();
    return { color, background, contrast: contrast(color, background), image: s.backgroundImage, shadow: s.boxShadow,
      opacity: s.opacity, outline: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), outlineColor: rgba(s.outlineColor),
      outlineContrast: contrast(rgba(s.outlineColor), bg(el.parentElement)),
      visible: visible(el), focused: el.matches(':focus-visible'), x: b.left + b.width / 2, y: b.top + b.height / 2 };
  };
`

function probe(selectors) {
  return `(() => { ${STYLE_HELPERS}
    const results = {};
    for (const selector of ${JSON.stringify(selectors)}) results[selector] = style(document.querySelector(selector));
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible).map((el) => ({ id: el.id, className: el.className, style: style(el) }));
    const highlights = Array.from(document.querySelectorAll('#panelPreview [class^="hl-"]')).map((el) => style(el));
    return { results, buttons, highlights, theme: document.documentElement.getAttribute('data-theme') };
  })()`
}

async function run() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const chrome = require('../shell/window-chrome')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-theme-smoke-'))
  app.setPath('userData', temporary)
  app.disableHardwareAcceleration()
  app.on('window-all-closed', () => {})
  await app.whenReady()
  fs.mkdirSync(OUT, { recursive: true })
  let passed = 0
  let failed = 0
  const checks = []
  const snapshots = []
  const check = (name, condition, detail) => {
    checks.push({ name, passed: Boolean(condition), detail })
    if (condition) passed++; else failed++
    console.log((condition ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
  }
  const neutral = (color) => Boolean(color && Math.max.apply(null, color.slice(0, 3)) - Math.min.apply(null, color.slice(0, 3)) < 3)
  const virtualRoot = path.join(temporary, 'theme-workspace')
  const code = '// A small local workspace example\nexport function greet(name) {\n  const message = "Hello, " + name;\n  return { message, ready: true };\n}\n\nconsole.log(greet("Agent"));\n'
  let settings = {
    theme: 'dark', currentProjectId: 'theme-demo', workspacePath: virtualRoot,
    projects: [{ id: 'theme-demo', name: '示例项目', folders: [virtualRoot] }],
    models: [{ id: 'demo', name: '示例模型', model: 'deepseek-flash', modelList: ['deepseek-flash', 'deepseek-chat'] }],
    currentModelId: 'demo', permissionMode: 'workspace', approvalAllow: []
  }
  const session = {
    id: 'theme-session', projectId: 'theme-demo', scope: 'project', workspacePath: virtualRoot,
    title: '整理项目并检查样式', updatedAt: '2026-10-14T00:00:00.000Z', createdAt: '2026-10-14T00:00:00.000Z',
    messages: [
      { role: 'user', content: '看一下这个项目，帮我整理入口文件。' },
      { role: 'assistant', content: '入口在 **src/main.js**，可以先从这里阅读。\n\n```js\nconst message = "Hello, Agent";\nconsole.log(message);\n```\n\n文件面板里可以查看代码，底部输入框可以继续提问。' },
      { role: 'tool', content: '读取 src/main.js：完成，共 8 行。' },
      { role: 'assistant', content: '已检查入口和目录结构。下一步可以逐个查看组件，或在终端里运行项目。' }
    ]
  }
  let hostTheme = 'dark'
  const publishedThemes = []
  ipcMain.handle('window:theme', () => hostTheme)
  ipcMain.on('window:theme', (_event, theme) => {
    if (theme !== 'light' && theme !== 'dark') return
    hostTheme = theme
    publishedThemes.push(theme)
    chrome.applyWindowTheme(BrowserWindow.getAllWindows(), theme, require('electron').nativeTheme)
  })
  ipcMain.handle('window:state', (event) => chrome.windowState(BrowserWindow.fromWebContents(event.sender), process.platform))
  ipcMain.handle('window:action', () => ({ ok: true }))
  ipcMain.on('shell:titlebar-dblclick', () => {})
  ipcMain.handle('app:get-state', () => ({ settings, workspacePath: virtualRoot, plugins: [], tools: [], running: false, runningSessions: [] }))
  ipcMain.handle('settings:save', (_event, patch) => { settings = Object.assign({}, settings, patch); return settings })
  ipcMain.handle('chat:reset', () => ({ ok: true }))
  ipcMain.handle('ui-store:get', () => ({ ok: true, store: { sessions: { 'theme-demo': [session], __recent__: [] }, currentSessionId: session.id, updatedAt: Date.now(), prefs: {} } }))
  ipcMain.handle('ui-store:put', () => ({ ok: true }))
  ipcMain.handle('fs:roots', () => ({ projectId: 'theme-demo', projectName: '示例项目', roots: [{ path: virtualRoot, name: '示例项目' }] }))
  ipcMain.handle('fs:tree', () => ({ entries: [
    { path: virtualRoot + '/main.js', name: 'main.js', dir: false, size: code.length, kind: 'code' },
    { path: virtualRoot + '/README.md', name: 'README.md', dir: false, size: 80, kind: 'text' }
  ], children: {}, truncated: false }))
  ipcMain.handle('fs:file', () => ({ kind: 'code', ext: '.js', isText: true, size: code.length, mtime: 1000 }))
  ipcMain.handle('fs:text', () => code)
  ipcMain.handle('term:state', (_event, sid) => ({ alive: true, sid, cwd: virtualRoot }))
  ipcMain.handle('term:start', () => ({ sid: 'theme-terminal', cwd: virtualRoot }))
  ipcMain.handle('term:write', () => ({ ok: true }))
  ipcMain.handle('term:kill', () => ({ ok: true }))
  ipcMain.on('term:subscribe', (event) => event.sender.send('term:data', { replay: Buffer.from('Workspace ready.\n__DSH_CMD_READY__\n').toString('base64') }))
  ipcMain.on('term:unsubscribe', () => {})
  ipcMain.handle('shell:get-config', () => ({ mode: 'local', serviceUrl: '', resolvedServiceUrl: 'http://127.0.0.1:8080', theme: hostTheme, agentHome: virtualRoot, programPath: '/Applications/Agent.app', version: '0.1.2' }))
  ipcMain.handle('shell:startup-state', () => ({ phase: 'starting', port: 8080, detail: '' }))
  ipcMain.handle('shell:get-update-info', () => ({ oldPath: '/Applications/Agent.app', oldVersion: '0.1.1', oldRunning: false, newPath: '/Downloads/Agent.app', newVersion: '0.1.2' }))
  ipcMain.handle('shell:update-state', () => ({ phase: 'idle', detail: '' }))
  const { server, sockets, port } = await serveRenderer()
  const win = new BrowserWindow({
    width: 1440, height: 960, show: false, ...chrome.windowChromeOptions(process.platform),
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  chrome.attachWindowChrome(win, process.platform)
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2 && message.indexOf('Electron Security Warning') === -1) errors.push(message) })
  win.webContents.on('render-process-gone', (_event, details) => errors.push('renderer gone ' + JSON.stringify(details)))
  const evaluate = (text) => win.webContents.executeJavaScript(text)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const capture = async (filename) => { await pause(100); fs.writeFileSync(path.join(OUT, filename + '.png'), (await win.webContents.capturePage()).toPNG()) }
  try {
    await win.loadURL('http://127.0.0.1:' + port + '/index.html')
    await pause(400)
    const logoName = process.platform === 'darwin' ? 'am.png' : (process.platform === 'win32' ? 'aw.png' : 'al.png')
    const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'icons', logoName)).toString('base64')
    await evaluate(`(() => { document.querySelector('.titlebar-brand img').src = ${JSON.stringify(logo)}; return true; })()`)
    await evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after { transition:none !important; animation:none !important; }'; document.head.appendChild(s); return true; })()`)
    check('saved fixture restores real user, assistant and tool messages', await evaluate(`document.querySelectorAll('.bubble.user').length === 1 && document.querySelectorAll('.bubble.assistant').length === 2 && Boolean(document.querySelector('.thinking-tool-result'))`))
    win.webContents.debugger.attach('1.3')
    for (const theme of ['dark', 'light']) {
      await evaluate(`(() => { closeSettings(); closeAllMenus(); closeComposerModelMenu(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); state.settings.theme = ${JSON.stringify(theme)}; applyTheme(${JSON.stringify(theme)}); document.getElementById('input').textContent = ''; return true; })()`)
      await pause(80)
      const selectors = ['body', '#titlebarDrag', '.sidebar', '.main', '.composer-card', '.bubble.user', '.chat-item.active', '#newSession', '#send', '#windowTitle', '.bubble.assistant .bubble-body', '.flat-name', '.section-title', '#statusLine', '.composer-model', '.pill-button']
      const main = await evaluate(probe(selectors))
      snapshots.push({ theme, phase: 'chat', snapshot: main })
      for (const selector of selectors.slice(0, 8)) {
        const s = main.results[selector]
        check(theme + ': ' + selector + ' is a neutral solid surface', Boolean(s && neutral(s.background) && s.image === 'none'), s && JSON.stringify(s.background))
      }
      const body = main.results.body.background
      check(theme + ': main background matches gray black / white theme', theme === 'dark' ? body[0] >= 15 && body[0] <= 60 : body[0] >= 248, JSON.stringify(body))
      const textSelectors = ['#windowTitle', '.bubble.assistant .bubble-body', '.flat-name', '.section-title', '#statusLine', '.composer-model', '.pill-button']
      check(theme + ': visible text has at least 4.5:1 contrast', textSelectors.every((selector) => main.results[selector] && main.results[selector].contrast >= 4.5), textSelectors.map((selector) => selector + '=' + main.results[selector].contrast.toFixed(2)).join(', '))
      check(theme + ': ordinary buttons have no gradients or shadows', main.buttons.every((b) => b.style.image === 'none' && b.style.shadow === 'none'), main.buttons.filter((b) => b.style.image !== 'none' || b.style.shadow !== 'none').map((b) => b.id || b.className).join(',') || 'none')
      const send = main.results['#send']
      check(theme + ': send button uses reversed black and white with a visible icon', neutral(send.background) && neutral(send.color) && send.contrast >= 4.5 && (theme === 'dark' ? send.background[0] > 220 && send.color[0] < 60 : send.background[0] < 60 && send.color[0] > 220), JSON.stringify(send))
      await capture('theme-' + theme)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: main.results['#newSession'].x, y: main.results['#newSession'].y })
      const hover = await evaluate(probe(['#newSession']))
      check(theme + ': real mouse hover stays neutral and flat', neutral(hover.results['#newSession'].background) && hover.results['#newSession'].image === 'none' && hover.results['#newSession'].shadow === 'none')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1430, y: 940 })
      await evaluate(`(() => { document.getElementById('sidebarToggle').focus(); return true; })()`)
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
      const focus = await evaluate(`(() => { ${STYLE_HELPERS} return { id: document.activeElement.id, s: style(document.activeElement) }; })()`)
      check(theme + ': actual Tab focus has a visible outline of at least 3:1 contrast', focus.s.focused && focus.s.outline !== 'none' && focus.s.outlineWidth >= 2 && focus.s.outlineContrast >= 3, JSON.stringify(focus))
      await evaluate(`(() => { const b = document.getElementById('send'); b.disabled = true; return true; })()`)
      const disabled = (await evaluate(probe(['#send']))).results['#send']
      check(theme + ': disabled send remains visible and distinct', disabled.visible && Number(disabled.opacity) >= .35 && JSON.stringify(disabled) !== JSON.stringify(send), JSON.stringify(disabled))
      await evaluate(`(() => { document.getElementById('send').disabled = false; document.getElementById('composerModelTrigger').click(); return true; })()`)
      const menu = await evaluate(probe(['#composerModelMenu', '#composerModelMenu .dropdown-item.active']))
      check(theme + ': model dropdown and selected item follow neutral theme', Object.keys(menu.results).every((key) => menu.results[key] && menu.results[key].visible && neutral(menu.results[key].background) && menu.results[key].image === 'none'))
      await capture('theme-' + theme + '-dropdown')
      await evaluate(`(() => { closeAllMenus(); closeComposerModelMenu(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); openSettings(); return true; })()`)
      const settingsProbe = await evaluate(probe(['.settings-card', '.settings-nav', '.settings-nav-item.active', '.settings-content', '.settings-row-desc', '#themeToggle', '#maxIterations']))
      snapshots.push({ theme, phase: 'settings', snapshot: settingsProbe })
      check(theme + ': settings surfaces and buttons follow neutral flat theme', Object.keys(settingsProbe.results).every((key) => settingsProbe.results[key] && neutral(settingsProbe.results[key].background) && settingsProbe.results[key].image === 'none') && settingsProbe.buttons.every((b) => b.style.shadow === 'none' && b.style.image === 'none'))
      check(theme + ': settings helper text remains readable', settingsProbe.results['.settings-row-desc'].contrast >= 4.5, settingsProbe.results['.settings-row-desc'].contrast.toFixed(2))
      await capture('theme-' + theme + '-settings')
      await evaluate(`(async () => { closeSettings(); window.filePanel.open(); await window.filePanel.refresh(); await window.filePanel.openFile(${JSON.stringify(virtualRoot + '/main.js')}, { kind: 'code' }); document.getElementById('panelTerminal').click(); const details = document.querySelector('.thinking-block'); if (details) details.open = true; return true; })()`)
      await pause(200)
      const panel = await evaluate(probe(['#filePanel', '.panel-head', '.panel-explorer', '.panel-tabs', '.panel-tab.active', '#panelPreview', '.tree-row', '.terminal-head', '.terminal-tab.on', '.terminal-dirs']))
      snapshots.push({ theme, phase: 'panel', snapshot: panel })
      check(theme + ': file panel, tabs, tree and terminal header follow neutral theme', Object.keys(panel.results).every((key) => panel.results[key] && neutral(panel.results[key].background) && panel.results[key].image === 'none'), Object.keys(panel.results).filter((key) => !panel.results[key] || !neutral(panel.results[key].background)).join(',') || 'all neutral')
      check(theme + ': code syntax keeps informative non-neutral colors', panel.highlights.length > 0 && panel.highlights.some((s) => !neutral(s.color)), panel.highlights.length + ' tokens')
      check(theme + ': panel toolbar icons retain at least 3:1 contrast', panel.buttons.filter((b) => /^(panel|terminal)/.test(b.id)).every((b) => b.style.contrast >= 3), panel.buttons.filter((b) => /^(panel|terminal)/.test(b.id)).map((b) => b.id + '=' + b.style.contrast.toFixed(2)).join(', '))
      const terminal = await evaluate(`(() => { ${STYLE_HELPERS} const term = window.__dshXterm; if (!term) return null; const t = term.options.theme; return { theme:t, cols:term.cols, rows:term.rows, background:rgba(t.background), foreground:rgba(t.foreground), cursor:rgba(t.cursor), contrast:contrast(rgba(t.foreground),rgba(t.background)) }; })()`)
      snapshots.push({ theme, phase: 'terminal', snapshot: terminal })
      check(theme + ': real xterm output stays neutral black with readable foreground', terminal && neutral(terminal.background) && neutral(terminal.foreground) && neutral(terminal.cursor) && terminal.background[0] <= 40 && terminal.contrast >= 4.5, JSON.stringify(terminal))
      check(theme + ': terminal has fitted visible columns for the panel', terminal && terminal.cols > 20, terminal && ('cols=' + terminal.cols + ' rows=' + terminal.rows))
      await capture('theme-' + theme + '-panel')
      await evaluate(`(() => { addBubble('notice', '示例警告'); addBubble('error', '示例错误'); return true; })()`)
      const semantic = await evaluate(probe(['.bubble.notice .bubble-label', '.bubble.error']))
      check(theme + ': warnings and errors keep distinct readable semantic colors', !neutral(semantic.results['.bubble.notice .bubble-label'].color) && semantic.results['.bubble.notice .bubble-label'].contrast >= 4.5 && !neutral(semantic.results['.bubble.error'].background) && semantic.results['.bubble.error'].contrast >= 4.5, Object.keys(semantic.results).map((key) => key + '=' + semantic.results[key].contrast.toFixed(2)).join(', '))
      await evaluate(`(() => { document.querySelectorAll('.bubble.notice, .bubble.error').forEach((el) => el.remove()); return true; })()`)
      await evaluate(`(() => { if (!document.getElementById('terminalView').classList.contains('hidden')) document.getElementById('panelTerminal').click(); window.filePanel.close(); const details = document.querySelector('.thinking-block'); if (details) details.open = false; return true; })()`)
    }
    await evaluate(`(() => { applyTheme('dark'); return true; })()`)
    await pause(40)
    check('main page theme changes publish to the real host preload IPC', publishedThemes.indexOf('light') >= 0 && publishedThemes.indexOf('dark') >= 0, publishedThemes.join(', '))
    for (const page of ['loading', 'settings', 'offline', 'update']) {
      const helper = new BrowserWindow({ width: 900, height: 820, show: false, ...chrome.windowChromeOptions(process.platform), webPreferences: { preload: path.join(ROOT, 'shell', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: ['--dsh-theme=dark'] } })
      chrome.attachWindowChrome(helper, process.platform)
      helper.webContents.on('console-message', (_event, level, message) => { if (level >= 2 && message.indexOf('Electron Security Warning') === -1) errors.push(page + ': ' + message) })
      try {
        await helper.loadFile(path.join(ROOT, 'shell', page + '.html'))
        await pause(100)
        for (const theme of ['dark', 'light']) {
          hostTheme = theme
          chrome.applyWindowTheme([helper], theme, require('electron').nativeTheme)
          await pause(40)
          const auxiliary = await helper.webContents.executeJavaScript(probe(['body', '#titlebarDrag', '.card', 'h1', '.muted']))
          snapshots.push({ theme, phase: 'shell-' + page, snapshot: auxiliary })
          check('shell ' + page + '/' + theme + ': real preload broadcast changes the theme', auxiliary.theme === theme)
          check('shell ' + page + '/' + theme + ': surfaces and ordinary buttons are neutral and flat', ['body', '#titlebarDrag', '.card'].every((key) => auxiliary.results[key] && neutral(auxiliary.results[key].background) && auxiliary.results[key].image === 'none') && auxiliary.buttons.every((b) => b.style.shadow === 'none' && b.style.image === 'none'))
          check('shell ' + page + '/' + theme + ': heading and helper text remain readable', ['h1', '.muted'].every((key) => auxiliary.results[key] && auxiliary.results[key].contrast >= 4.5), ['h1', '.muted'].map((key) => key + '=' + (auxiliary.results[key] && auxiliary.results[key].contrast.toFixed(2))).join(', '))
          fs.writeFileSync(path.join(OUT, 'theme-' + theme + '-shell-' + page + '.png'), (await helper.webContents.capturePage()).toPNG())
        }
      } finally { helper.destroy() }
    }
    check('renderer reports no runtime errors', errors.length === 0, errors.join(' | ') || 'none')
  } finally {
    fs.writeFileSync(path.join(OUT, 'theme-validation.json'), JSON.stringify({ hostPlatform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome, passed, failed, checks, snapshots, errors }, null, 2))
    win.destroy()
    /* Electron's HTTP keep-alive connections can keep server.close pending in
       Node 16. All tracked sockets belong to this temporary local test server. */
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  console.log('theme smoke: ' + passed + '/' + (passed + failed) + ' checks passed, Electron ' + process.versions.electron)
  app.exit(failed ? 1 : 0)
}

if (process.versions.electron && require('electron').app) {
  run().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1) })
} else {
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const args = [__filename]
  if (env.SMOKE_NO_SANDBOX === '1') args.unshift('--no-sandbox')
  const result = spawnSync(electronBinary(), args, { env, stdio: 'inherit' })
  process.exit(result.status === null ? 1 : result.status)
}
