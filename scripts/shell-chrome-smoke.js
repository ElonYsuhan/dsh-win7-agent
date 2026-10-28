#!/usr/bin/env node
'use strict'

/* Independent titlebar contract. Real geometry and hit testing are covered by
   shell-drag-smoke.js; platform actions by window-controls-smoke.js. */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const chrome = require('../shell/window-chrome')
const ROOT = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')
let passed = 0

function check(name, condition) {
  assert(condition, name)
  passed++
  console.log('PASS  ' + name)
}

function cssBlock(source, selector) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].trim().split(',').map((value) => value.trim()).includes(selector)) return match[2]
  }
  return ''
}

check('shared titlebar height is 48px', chrome.TITLEBAR_HEIGHT === 48)
const mac = chrome.windowChromeOptions('darwin')
check('macOS keeps native traffic lights in a hidden titlebar', mac.titleBarStyle === 'hidden' && mac.frame !== false)
check('macOS traffic lights use the reserved 16,16 position', mac.trafficLightPosition.x === 16 && mac.trafficLightPosition.y === 16)
for (const platform of ['win32', 'linux']) {
  const options = chrome.windowChromeOptions(platform)
  check(platform + ': content owns the titlebar without a native frame', options.frame === false && !options.titleBarOverlay)
}

for (const file of ['shell/main.js', 'src/main/main.js']) {
  const source = read(file)
  const windowCount = (source.match(/new BrowserWindow\(/g) || []).length
  check(file + ': uses shared chrome options for every window', (source.match(/\.\.\.\s*windowChromeOptions\(/g) || []).length === windowCount)
  check(file + ': every window publishes state changes', (source.match(/attachWindowChrome\(/g) || []).length === windowCount)
  check(file + ': handles window state requests', source.includes("'window:state'"))
  check(file + ': handles native window actions', source.includes("'window:action'"))
  check(file + ': handles titlebar double clicks', source.includes("'shell:titlebar-dblclick'"))
  const startup = source.slice(source.indexOf('app.whenReady().then'))
  check(file + ': removes application menus before creating windows', startup.indexOf('hideApplicationMenu(Menu)') >= 0 && startup.indexOf('hideApplicationMenu(Menu)') < startup.search(/create(?:Main)?Window\(\)/))
}

for (const file of ['shell/preload.js', 'src/main/preload.js']) {
  const source = read(file)
  check(file + ': marks desktop windows', source.includes("'shell-window'"))
  check(file + ': exposes desktopWindow', source.includes("'desktopWindow'"))
  check(file + ': fetches and subscribes to window state', source.includes("'window:state'") && source.includes('onState'))
  check(file + ': invokes native actions', source.includes("'window:action'"))
  check(file + ': creates window control buttons', source.includes('data-window-action') && source.includes('toggle-maximize'))
  check(file + ': identifies titlebar double clicks', source.includes("'#titlebarDrag'") && source.includes("'shell:titlebar-dblclick'"))
  check(file + ': does not treat the content brand as a titlebar', !source.includes("'#titlebarDrag, .brand'"))
  check(file + ': excludes interactive elements from titlebar double clicks', /closest\('button, a, input, select, textarea/.test(source))
}

const html = read('src/renderer/index.html')
const header = /<header\b[^>]*id="titlebarDrag"[^>]*>([\s\S]*?)<\/header>/.exec(html)
check('main titlebar is a real header', !!header)
check('main titlebar sits before and outside #app', html.indexOf('</header>') < html.indexOf('<div id="app"'))
check('main titlebar is accessible', header && !/aria-hidden="true"/.test(header[0].slice(0, header[0].indexOf('>'))) && /aria-label=/.test(header[0]))
for (const id of ['sidebarToggle', 'pageActions', 'pageRefresh', 'pageShare', 'panelToggle']) {
  check(id + ': belongs to the independent titlebar', header && header[1].includes('id="' + id + '"'))
  check(id + ': has one DOM instance', (html.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1)
}
check('browser shortcut is hidden', /<button[^>]*id="pageShare"[^>]*\bhidden\b/.test(html) && read('src/renderer/style.css').includes('#pageShare[hidden]{display:none;}'))
check('titlebar has a restore action for file-only mode', header && header[1].includes('id="restoreChat"'))
for (const file of ['shell/loading.html', 'shell/settings.html', 'shell/offline.html', 'shell/update.html']) {
  const local = read(file)
  check(file + ': owns an independent header', /<header\b[^>]*id="titlebarDrag"/.test(local))
  check(file + ': header is outside interactive content', local.indexOf('id="titlebarDrag"') < local.indexOf('class="card'))
}

for (const file of ['src/renderer/style.css', 'shell/style.css']) {
  const css = read(file)
  const bar = cssBlock(css, '.titlebar-drag')
  check(file + ': uses a 48px titlebar', /height\s*:\s*48px/.test(bar))
  check(file + ': titlebar has the shared height', /height\s*:\s*48px/.test(bar))
  check(file + ': titlebar is draggable in desktop windows', /-webkit-app-region\s*:\s*drag/.test(cssBlock(css, '.shell-window .titlebar-drag')) || /-webkit-app-region\s*:\s*drag/.test(bar))
  check(file + ': reserves macOS native traffic lights', /padding-left\s*:\s*88px/.test(cssBlock(css, '.shell-mac .titlebar-drag')))
  check(file + ': reserves 132px for left window controls', /padding-left\s*:\s*144px/.test(cssBlock(css, '.window-controls-left .titlebar-drag')))
  check(file + ': reserves 132px for right window controls', /padding-right\s*:\s*144px/.test(cssBlock(css, '.window-controls-right .titlebar-drag')))
  check(file + ': self-drawn controls do not drag', /-webkit-app-region\s*:\s*no-drag/.test(cssBlock(css, '.titlebar-drag .window-controls')))
  check(file + ': every native-action button is 44px wide', /(?:width|flex-basis)\s*:\s*44px/.test(cssBlock(css, '.titlebar-drag .window-controls button')))
  /* 全局 `button:active:not(:disabled){transform:none}` 会连居中位移一起清掉，
     用 translate 居中的按钮按下那一帧会往下跳半个身高。菜单键必须 margin:auto 居中。 */
  const menuButton = cssBlock(css, '.titlebar-drag .app-menu-button')
  check(file + ': app menu button centres with margin, not transform', !!menuButton && /margin\s*:\s*auto/.test(menuButton) && !/transform\s*:\s*translate/.test(menuButton))
}
const css = read('src/renderer/style.css')
check('app occupies the content area below the titlebar', /height\s*:\s*calc\(100vh\s*-\s*48px\)/.test(cssBlock(css, '#app')))
check('sidebar toggle uses titlebar flow layout', !/position\s*:\s*absolute/.test(cssBlock(css, '.titlebar-drag .sidebar-toggle')))
check('page actions use titlebar flow layout', !/position\s*:\s*absolute/.test(cssBlock(css, '.titlebar-drag .page-actions')))
check('panel toggle uses titlebar flow layout', !/position\s*:\s*absolute/.test(cssBlock(css, '.titlebar-drag .panel-toggle')))
check('content no longer has a mac-only top margin', !/\.shell-mac\s+\.content-frame\s*\{[^}]*margin-top/.test(css))
check('sidebar no longer needs a mac-only spacer', !/\.shell-mac\s+\.sidebar::before/.test(css))
check('file-only mode no longer pushes file toolbar around traffic lights', !/\.shell-mac\.chat-hidden\s+\.panel-head/.test(css))

/* 应用菜单：原生 menu.popup() 的两列浮层是 Chromium 自己的排版 —— 左列比右面板顶边高 17px、
   16px 字号、系统配色，CSS 完全够不着。改成渲染层自绘后，这里守住三件事：
   ①菜单只从渲染层出（主进程不再 popup）；②左列与右列同一个外框、同一套行高；
   ③命令仍然过主进程白名单，不能出现绕过门控的直连。 */
const menuMain = read('shell/menu.js')
const menuRenderer = read('src/renderer/app-menu.js')
check('shell menu opens the renderer menu instead of a native popup', menuMain.includes("send('app:menu-open')") && !/\.popup\(\{/.test(menuMain))
check('shell menu validates commands coming back from the renderer', menuMain.includes("'app:menu-invoke'") && menuMain.includes('COMMANDS.includes(id)'))
check('shell menu keeps the native template for accelerators', menuMain.includes('Menu.setApplicationMenu'))
check('application menu hides the native menubar without Alt reveal', /setAutoHideMenuBar\(false\)/.test(menuMain) && /setMenuBarVisibility\(false\)/.test(menuMain))
for (const file of ['shell/preload.js', 'src/main/preload.js']) {
  check(file + ': forwards the menu button to the renderer', /onMenuOpen/.test(read(file)) && /menuInvoke/.test(read(file)))
}
check('renderer loads the application menu module', /<script src="app-menu\.js"><\/script>/.test(html))
check('application menu is one rounded panel with two columns', /display\s*:\s*flex/.test(cssBlock(css, '.app-menu')) && /border-right\s*:\s*1px/.test(cssBlock(css, '.app-menu-groups')))
check('application menu rows share one height', /height\s*:\s*28px/.test(cssBlock(css, '.app-menu button')))
check('application menu groups and items both come from one data list', menuRenderer.includes("id: 'file'") && menuRenderer.includes("id: 'help'") && menuRenderer.includes('app-menu-sep'))
check('application menu never positions itself with a translate', !/translateY/.test(menuRenderer) && !/transform\s*:\s*translate/.test(cssBlock(css, '.app-menu')))

console.log('shell chrome smoke: ' + passed + '/' + passed + ' checks passed, node ' + process.version)
