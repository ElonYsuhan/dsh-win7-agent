#!/usr/bin/env node
'use strict'

/* Native menu roles and renderer command lifecycle, simulated on all three platforms. */
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
  const calls=[],ipcMain=new EventEmitter(),win=new EventEmitter();win.webContents=new EventEmitter()
  win.webContents.send=(...args)=>calls.push(args);win.isFocused=()=>true;win.setMenuBarVisibility=v=>calls.push(['visible',v]);win.setAutoHideMenuBar=v=>calls.push(['autohide',v])
  let menu
  const Menu={buildFromTemplate:template=>{const items=new Map();for(const group of template)for(const item of group.submenu||[])if(item.id)items.set(item.id,item);return {template,getMenuItemById:id=>items.get(id),popup:()=>calls.push('popup')}},setApplicationMenu:value=>{menu=value},getApplicationMenu:()=>menu}
  const electron={Menu,ipcMain,BrowserWindow:{getFocusedWindow:()=>win},app:{getVersion:()=> 'test',getPath:()=>'/tmp'},dialog:{showMessageBox:()=>{}},shell:{openPath:async()=>''},clipboard:{writeText:()=>{}}}
  const module={exports:{}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../shell/menu.js'),'utf8'),{module,exports:module.exports,require:()=>electron,process:{platform,arch:'x64',versions:{node:'16.17.1'}}})
  module.exports.hideApplicationMenu(Menu);module.exports.configureWindowMenu(win)
  return {calls,ipcMain,win,menu,api:module.exports}
}
for(const platform of ['darwin','win32','linux']) {
  const f=fixture(platform)
  check(platform+': native menu includes editing and exit roles',()=>{const items=f.menu.template.flatMap(g=>g.submenu||[]);assert(items.some(i=>i.role==='copy'));assert(items.some(i=>i.role==='paste'));assert(items.some(i=>i.role==='quit'))})
  check(platform+': page commands disabled until matching renderer is ready',()=>{assert.strictEqual(f.menu.getMenuItemById('new-session').enabled,false);f.ipcMain.emit('app:menu-ready',{sender:{}});assert.strictEqual(f.menu.getMenuItemById('new-session').enabled,false);f.ipcMain.emit('app:menu-ready',{sender:f.win.webContents});assert.strictEqual(f.menu.getMenuItemById('new-session').enabled,true)})
  check(platform+': page command forwards exactly once to selected renderer',()=>{f.calls.length=0;f.menu.getMenuItemById('new-session').click();assert.deepStrictEqual(Array.from(f.calls[0]),['app:command','new-session']);assert.strictEqual(f.calls.length,1)})
  check(platform+': file and preview commands follow actual page state',()=>{assert.strictEqual(f.menu.getMenuItemById('close-file').enabled,false);f.ipcMain.emit('app:menu-state',{sender:f.win.webContents},{file:true,markdown:true,sidebar:true,panel:false,preview:true});assert.strictEqual(f.menu.getMenuItemById('close-file').enabled,true);assert.strictEqual(f.menu.getMenuItemById('sidebar').checked,true);assert.strictEqual(f.menu.getMenuItemById('markdown').checked,true)})
  check(platform+': navigation disables stale page commands and closed window releases IPC handlers',()=>{f.win.webContents.emit('did-start-loading');assert.strictEqual(f.menu.getMenuItemById('new-session').enabled,false);f.win.emit('closed');assert.strictEqual(f.ipcMain.listenerCount('app:menu-ready'),0);assert.strictEqual(f.ipcMain.listenerCount('app:menu-state'),0)})
  check(platform+': native editing roles do not register a second key interceptor',()=>assert.strictEqual(f.win.webContents.listenerCount('before-input-event'),0))
}

for (const entry of ['shell/main.js', 'src/main/main.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8')
  check(entry + ': startup installs the shared application menu before creating windows', () => {
    const startup = source.slice(source.indexOf('app.whenReady().then'))
    assert(startup.indexOf('hideApplicationMenu(Menu)') >= 0)
    assert(startup.indexOf('hideApplicationMenu(Menu)') < startup.search(/create(?:Main)?Window\(\)/))
    assert(!/menuTemplate\(/.test(source))
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
  const start = source.indexOf("secureHandle('shell:open-path'")
  const end = source.indexOf("secureHandle('shell:open-external'", start)
  let handler
  const calls = []
  vm.runInNewContext(source.slice(start, end), {
    secureHandle: (_name, fn) => { handler = fn },
    shell: { openPath: (target) => { calls.push(target); return '' } },
    path
  })
  assert.strictEqual(handler({}, '/tmp/中文 工作区'), '')
  assert.deepStrictEqual(calls, [require('path').resolve('/tmp/中文 工作区')])
  assert(handler({}, '') !== '')
  assert(handler({}, '  ') !== '')
  assert(handler({}, null) !== '')
  assert(handler({}, { path: '/tmp' }) !== '')
  assert.strictEqual(calls.length, 1)
})

console.log('shell menu smoke: ' + passed + '/' + passed + ' checks passed, node ' + process.version)
