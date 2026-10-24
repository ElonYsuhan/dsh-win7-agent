'use strict'
// Run the actual startup/update functions with isolated files and native APIs stubbed.
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('assert')
const {spawn}=require('child_process')
const installer=require('../shell/installer'),source=fs.readFileSync(path.join(__dirname,'../shell/main.js'),'utf8')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-takeover-'))
function pkg(name,code){const dir=path.join(tmp,name);fs.mkdirSync(path.join(dir,'resources/app'),{recursive:true});fs.writeFileSync(path.join(dir,'resources/app/main.js'),code);fs.writeFileSync(path.join(dir,'Agent'),'binary');return dir}
const newer=pkg('new','new code'),older=pkg('old','old code'),home=path.join(tmp,'home');fs.mkdirSync(home)
let live=new Set(),calls=[],current=newer,forcedFailure=false,verified=true
const sandbox={fs,path,console,not:v=>!v,process:{platform:'linux',pid:999,argv:['Agent']},setTimeout:fn=>{calls.push('exit-scheduled');return 0},
 app:{getPath:()=>home,exit:()=>{},quit:()=>{}},mainWindow:null,updateDecision:null,updatePromise:null,backgroundUpdating:true,runningBuildId:null,
 appVersion:()=> '0.4.3',programDir:()=>current,isDesktopPackage:()=>true,
 createMainWindow:()=>{calls.push('window');sandbox.mainWindow={isDestroyed:()=>false}},
 boot:async()=>{calls.push('boot')},singleInstance:()=>{calls.push('lock');return true},
 setUpdateState:patch=>calls.push(patch.phase),
 installer:{...installer,isAlive:pid=>live.has(pid),processOwnsPackage:()=>verified,
 killTree:pid=>{assert.notStrictEqual(pid,999);calls.push('kill:'+pid);live.delete(pid)},waitGone:async pid=>!live.has(pid),sleep:async()=>{},cleanupTrash:()=>{},
 replacePackage:async options=>{calls.push('replace');return forcedFailure?{ok:false,error:'COPY_FAILED'}:installer.replacePackage(options)},
 relaunch:(dir)=>{calls.push('relaunch');assert.strictEqual(fs.readFileSync(path.join(dir,'resources/app/main.js'),'utf8'),'new code');const buildId=installer.packageBuildId(dir,'linux');installer.writeManifest(home,{path:dir,pid:303,version:'0.4.3',buildId});live.add(303);return {ok:true,pid:303}}
 }}
vm.createContext(sandbox)
const register=source.slice(source.indexOf('function registerSelf()'),source.indexOf('/** 接管：'))
const run=source.slice(source.indexOf('function runUpdate()'),source.indexOf('/* --------------------------------------------------------- service boot */'))
vm.runInContext(register+'\n'+run,sandbox)
async function main(){try{
 if(process.platform!=='win32'){
  const probeDir=path.join(tmp,'process probe');fs.mkdirSync(probeDir);fs.symlinkSync(process.execPath,path.join(probeDir,'Agent'));const child=spawn(path.join(probeDir,'Agent'),['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});try{await new Promise(resolve=>child.once('spawn',resolve));assert(installer.processOwnsPackage(child.pid,probeDir,'linux'));assert(!installer.processOwnsPackage(child.pid,older,'linux'))}finally{child.kill();await new Promise(resolve=>child.once('close',resolve))}
  const goneApp=path.join(tmp,'Moved Agent.app'),macBinary=path.join(goneApp,'Contents/MacOS/Electron');fs.mkdirSync(path.dirname(macBinary),{recursive:true});fs.symlinkSync(process.execPath,macBinary)
  const orphan=spawn(macBinary,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});try{await new Promise(resolve=>orphan.once('spawn',resolve));assert(installer.processOwnsPackage(orphan.pid,goneApp,'darwin'));fs.rmSync(goneApp,{recursive:true,force:true});assert(installer.processOwnsPackage(orphan.pid,goneApp,'darwin'),'deleted bundle still matches its exact live Electron path');assert(!installer.processOwnsPackage(orphan.pid,path.join(tmp,'Other Agent.app'),'darwin'),'missing bundle never permits unrelated Electron process takeover')}finally{orphan.kill();await new Promise(resolve=>orphan.once('close',resolve))}
 }
 vm.runInContext(source.slice(source.indexOf('function restartUpdatedPackage()'),source.indexOf('function singleInstance()')),sandbox)
 sandbox.backgroundUpdating=false;sandbox.runningBuildId=installer.packageBuildId(newer,'linux');let relaunched=0,quit=0;sandbox.app.relaunch=()=>{relaunched++};sandbox.app.quit=()=>{quit++}
 assert.strictEqual(sandbox.restartUpdatedPackage(),false)
 fs.appendFileSync(path.join(newer,'resources/app/main.js'),' updated')
 assert.strictEqual(sandbox.restartUpdatedPackage(),true);assert.strictEqual(relaunched,1);assert.strictEqual(quit,1)
 sandbox.restartUpdatedPackage();assert.strictEqual(relaunched,1,'activation must not queue duplicate restarts')
 fs.writeFileSync(path.join(newer,'resources/app/main.js'),'new code');sandbox.backgroundUpdating=true
 const id=installer.packageBuildId(newer,'linux');assert.strictEqual(id,installer.packageBuildId(newer,'linux'));assert.notStrictEqual(id,installer.packageBuildId(older,'linux'))
 installer.writeManifest(home,{path:older,pid:101,version:'0.4.3',buildId:'older-build'});live.add(101)
 assert.strictEqual(sandbox.resolveUpdate().action,'update');assert.strictEqual(installer.readManifest(home).pid,101,'decision must not replace old ownership')
 const a=sandbox.runUpdate(),b=sandbox.runUpdate();assert.strictEqual(a,b);assert((await a).ok)
 assert.strictEqual(calls.filter(x=>x==='replace').length,1);assert(!calls.includes('window'),'background replacement must not create window');assert(calls.includes('relaunch'))
 calls=[];sandbox.mainWindow=null;current=newer;live=new Set([102]);installer.writeManifest(home,{path:newer,pid:102,version:'0.4.3',buildId:'previous-same-path-build'})
 assert.strictEqual(sandbox.resolveUpdate().action,'update');assert((await sandbox.runUpdate()).ok);assert(calls.includes('kill:102'));assert(!calls.includes('replace'),'same path must not replace its own source');assert(calls.indexOf('lock')<calls.indexOf('window'));assert(calls.includes('boot'));assert.strictEqual(installer.readManifest(home).buildId,id)
 calls=[];live=new Set([999]);installer.writeManifest(home,{path:newer,pid:999,version:'0.4.3',buildId:id});assert.strictEqual(sandbox.resolveUpdate().action,'boot')
 calls=[];const missing=path.join(tmp,'deleted-old');live=new Set([106]);installer.writeManifest(home,{path:missing,pid:106,version:'0.4.3',buildId:'old'});assert.strictEqual(sandbox.resolveUpdate().action,'update');assert((await sandbox.runUpdate()).ok);assert(calls.includes('kill:106'));assert(!calls.includes('replace'),'do not recreate a removed old installation');assert(!fs.existsSync(missing));assert.strictEqual(installer.readManifest(home).path,newer,'new stable installation owns the preserved profile')
 live=new Set([103]);installer.writeManifest(home,{path:newer,pid:103,version:'0.4.3',buildId:id});assert.strictEqual(sandbox.resolveUpdate().action,'boot'),'same build should activate the running latest instance'
 calls=[];verified=false;current=newer;installer.writeManifest(home,{path:older,pid:888,version:'0.4.3'});live=new Set([888]);sandbox.resolveUpdate();forcedFailure=true;assert.strictEqual((await sandbox.runUpdate()).error,'COPY_FAILED');assert(!calls.some(x=>x.startsWith('kill:')),'stale PID cannot terminate unrelated process')
 // Exercise the actual app.whenReady branch, including automatic fallback.
 Object.assign(sandbox,{readConfig:()=>{},configureTaskTray:()=>{},applyWindowTheme:()=>{},hideApplicationMenu:()=>{},config:{theme:'dark'},nativeTheme:{},Menu:{},BrowserWindow:{getAllWindows:()=>[]}})
 sandbox.app.whenReady=()=>Promise.resolve();sandbox.app.on=()=>{}
 const startup=source.slice(source.indexOf('app.whenReady().then(async () => {'),source.indexOf('/* ------------------------------------------------------------------ ipc */'))
 calls=[];verified=true;forcedFailure=false;current=newer;sandbox.mainWindow=null;live=new Set([104]);installer.writeManifest(home,{path:older,pid:104,version:'0.4.3',buildId:'old'});await vm.runInContext(startup,sandbox);assert(calls.includes('relaunch'));assert(!calls.includes('window'),'normal startup update stays entirely in background')
 calls=[];forcedFailure=true;sandbox.mainWindow=null;live=new Set([105]);installer.writeManifest(home,{path:older,pid:105,version:'0.4.3',buildId:'old'});await vm.runInContext(startup,sandbox);assert(calls.includes('boot'));assert.strictEqual(installer.readManifest(home).path,newer,'failed copy must still boot the new source, not old code')
 assert(!source.includes("loadLocal(mainWindow, 'update.html')"));assert(source.includes("if (backgroundUpdating) return"));
 console.log('Update takeover: same-version/cross-path replacement, same-path content fingerprint, no update window, deduplication, ownership after lock, relaunch confirmation, unrelated PID protection passed')
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exit(1)})
