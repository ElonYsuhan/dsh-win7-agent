'use strict'
// Exercise the actual shell lifecycle handlers with native APIs replaced; never change OS login settings.
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm')
const source=fs.readFileSync(path.join(__dirname,'../shell/main.js'),'utf8'),handlers={},calls=[]
let shown=0,focused=0,quit=0
class Tray { constructor(){calls.push('tray')} displayBalloon(){calls.push('balloon')} setToolTip(){} setContextMenu(items){this.menu=items} on(){} destroy(){calls.push('destroy')} }
class Notification { static isSupported(){return true} constructor(value){this.value=value} on(){} show(){calls.push('notification')} }
const config={keepRunning:false,launchAtLogin:false},app={getAppPath:()=>'/test-app',on:()=>{},setLoginItemSettings:v=>calls.push(v),quit:()=>quit++}
const sandbox={path,setTimeout:()=>({unref(){}}),taskNotificationTrays:new Set(),config,app,taskTray:null,mainWindow:{isDestroyed:()=>false,show:()=>shown++,focus:()=>focused++},nativeImage:{createFromPath:(file)=>{assert.strictEqual(typeof file,'string');return ({resize:()=>({isEmpty:()=>false})})}},windowIconPath:()=>undefined,Tray,Notification,Menu:{buildFromTemplate:x=>x},ipcMain:{handle:(name,fn)=>{handlers[name]=fn}},writeConfig:v=>Object.assign(config,v),process:{platform:'darwin'}}
vm.createContext(sandbox);vm.runInContext(source.slice(source.indexOf('function configureTaskTray()')),sandbox)
const prefs=handlers['shell:task-preferences'];assert.strictEqual(prefs(null).keepRunning,false)
prefs(null,{keepRunning:true,launchAtLogin:true});assert(calls.includes('tray'));assert(calls.some(x=>x&&x.openAtLogin===true));assert.strictEqual(config.keepRunning,true)
sandbox.taskTray.menu[0].click();assert.strictEqual(shown,1);assert.strictEqual(focused,1)
sandbox.taskTray.menu[2].click();assert.strictEqual(quit,1)
handlers['shell:task-notify'](null,{title:'任务'});assert(calls.includes('notification'))
prefs(null,{keepRunning:false,launchAtLogin:false});assert(calls.includes('destroy'));assert.strictEqual(sandbox.taskTray,null)
sandbox.process.platform='win32';handlers['shell:task-notify'](null,{title:'Win7 任务'});assert(calls.includes('balloon'));for(const tray of sandbox.taskNotificationTrays)tray.destroy();sandbox.taskNotificationTrays.clear()
const closeBlock=source.slice(source.indexOf("mainWindow.on('close',"),source.indexOf("mainWindow.on('closed',"))
assert(closeBlock.includes('!quittingRequested')&&closeBlock.includes('event.preventDefault()')&&closeBlock.includes('mainWindow.hide()'))
console.log('Task desktop lifecycle: opt-in tray/login, show, quit, notification/Win7 balloon, teardown and close-vs-quit guard passed')
