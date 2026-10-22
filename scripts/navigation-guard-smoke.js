'use strict'
const assert=require('assert'),{EventEmitter}=require('events'),fs=require('fs'),path=require('path'),vm=require('vm'),{attachNavigationGuard}=require('../shell/navigation-guard')
const win=new EventEmitter(),web=new EventEmitter();win.webContents=web;let clears=0;web.clearHistory=()=>clears++;web.isDestroyed=()=>false;attachNavigationGuard(win)
for(const name of ['browser-backward','browser-forward']){let blocked=false;win.emit('app-command',{preventDefault(){blocked=true}},name);assert(blocked)}
let blocked=false;win.emit('app-command',{preventDefault(){blocked=true}},'volume-up');assert(!blocked)
web.emit('did-finish-load');assert.strictEqual(clears,1);win.emit('closed');assert.strictEqual(web.listenerCount('did-finish-load'),0)
for(const file of ['shell/preload.js','src/main/preload.js']){
 const code=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),start=code.indexOf('// Mouse side buttons must not navigate'),handlers={};assert(start>0)
 vm.runInNewContext(code.slice(start),{window:{addEventListener(type,fn){handlers[type]=fn}}})
 for(const type of ['mousedown','mouseup','auxclick'])for(const button of [0,1,2,3,4]){let cancelled=false;handlers[type]({button,preventDefault(){cancelled=true},stopImmediatePropagation(){}});assert.strictEqual(cancelled,button===3||button===4,file+' '+type+' '+button)}
 for(const key of ['BrowserBack','BrowserForward','a']){let cancelled=false;handlers.keydown({key,preventDefault(){cancelled=true},stopImmediatePropagation(){}});assert.strictEqual(cancelled,key!=='a')}
}
console.log('Navigation guard: side buttons and mapped keys blocked in both preloads, normal clicks preserved, startup history cleared and listeners cleaned')
