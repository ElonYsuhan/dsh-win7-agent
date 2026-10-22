'use strict'

/* 在本机真实 Electron 22 中检查无菜单时的输入编辑。
   不写系统剪贴板，不使用真实用户设置，也不调用模型服务。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

async function run() {
 const {app,BrowserWindow,ipcMain}=require('electron'),{attachNavigationGuard}=require('../shell/navigation-guard')
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'agent-navigation-'));app.setPath('userData',temporary);app.disableHardwareAcceleration();await app.whenReady();app.on('window-all-closed',()=>{})
 ipcMain.handle('window:theme',()=>({theme:'dark'}));ipcMain.handle('window:state',()=>({platform:process.platform}));let win
 try{
  const old=path.join(temporary,'update.html'),main=path.join(temporary,'main.html');fs.writeFileSync(old,'<h1>UPDATE</h1>');fs.writeFileSync(main,'<button id="normal">正常按钮</button><input id="field">')
  for(const preload of ['shell/preload.js','src/main/preload.js']){
   win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'..',preload),sandbox:true,contextIsolation:true,nodeIntegration:false}});attachNavigationGuard(win)
   await win.loadFile(old);await win.loadFile(main);await new Promise(r=>setTimeout(r,100));assert(!win.webContents.canGoBack(),'Old update page removed from history');const url=win.webContents.getURL();win.webContents.goBack();await new Promise(r=>setTimeout(r,60));assert.strictEqual(win.webContents.getURL(),url)
   const result=await win.webContents.executeJavaScript(`(()=>{const result=[];for(const type of ['mousedown','mouseup','auxclick'])for(const button of [0,1,2,3,4]){const e=new MouseEvent(type,{button,bubbles:true,cancelable:true});document.body.dispatchEvent(e);result.push(e.defaultPrevented===(button===3||button===4))}const key=new KeyboardEvent('keydown',{key:'BrowserBack',bubbles:true,cancelable:true});document.body.dispatchEvent(key);result.push(key.defaultPrevented);return result.every(Boolean)})()`);assert(result,'Side buttons prevented in real sandbox preload '+preload)
   await win.webContents.reload();await new Promise(r=>setTimeout(r,200));assert.strictEqual(win.webContents.getURL(),url,'Explicit reload preserved');win.destroy();win=null
  }
  console.log('Navigation real Electron22 passed: stale update history removed, goBack inert, side buttons/mapped key blocked in both sandbox preloads, normal clicks and reload preserved')
 }finally{if(win&&!win.isDestroyed())win.destroy();fs.rmSync(temporary,{recursive:true,force:true})}
}
if (process.versions.electron && process.type === 'browser') {
  run().then(()=>require('electron').app.exit(0)).catch((error) => {
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
