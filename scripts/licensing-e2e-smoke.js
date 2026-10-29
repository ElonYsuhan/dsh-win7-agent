'use strict'
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),crypto=require('crypto'),assert=require('assert'),{spawn}=require('child_process')
const {MiniWebSocket,CdpSession,httpGetJson}=require('../src/main/agent/cdp-client'),C=require('../src/main/contracts/licensing'),issuer=require('./license-authority/issuer')
const delay=ms=>new Promise(r=>setTimeout(r,ms)),root=path.resolve(__dirname,'..')
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function main(){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-license-ui-'))),bundle=path.resolve(process.argv[2]),debug=await port(),env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 let child,ws,cdp,url
 async function evaluate(expression){const value=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value}
 async function until(expression,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){try{const value=await evaluate(expression);if(value)return value}catch(_){}await delay(100)}throw Error('Timeout: '+expression)}
 async function start(){
  const log=fs.openSync(path.join(dir,'run.log'),'a');child=spawn(path.join(bundle,'Contents/MacOS/Electron'),['--user-data-dir='+dir,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debug],{env,stdio:['ignore',log,log]});fs.closeSync(log)
  let target;for(let i=0;i<120;i++){try{target=(await httpGetJson('127.0.0.1',debug,'/json/list',1000)).find(t=>t.type==='page'&&/^http:/.test(t.url))}catch(_){}if(target)break;if(child.exitCode!==null)throw Error('App exited: '+fs.readFileSync(path.join(dir,'run.log'),'utf8').slice(-2000));await delay(150)}assert(target);url=target.url;ws=new MiniWebSocket();const socket=new URL(target.webSocketDebuggerUrl);await ws.connect(socket.hostname,Number(socket.port),socket.pathname);cdp=new CdpSession(ws);await until('window.licensingUI && document.querySelector("#licenseGate .license-badge").textContent!=="正在检查授权…"')
 }
 async function stop(){if(ws&&ws.socket)ws.socket.destroy();if(child){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([exited,delay(3000)]);child=null}await delay(500)}
 try{
  await start();assert(await evaluate('window.licensingUI.isLocked()'));
  const requestInfo=await evaluate("window.dsh.licenseRequest('request')"),short=requestInfo.deviceDigest.slice(0,9).toUpperCase().replace(/(.{3})(.{3})(.{3})/,'$1-$2-$3')
  assert(await evaluate("document.getElementById('licenseGate').textContent.includes("+JSON.stringify(short)+")"))
  assert(!(await evaluate("document.getElementById('licenseGate').textContent.includes("+JSON.stringify(requestInfo.deviceDigest)+")")))
  assert(!(await evaluate("document.getElementById('licenseGate').textContent.includes('复制设备码')")))
  await evaluate(`(()=>{const original=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__requestDownload=this.download};Array.from(document.querySelectorAll('#licenseGate button')).find(b=>b.textContent==='导出申请文件').click();setTimeout(()=>HTMLAnchorElement.prototype.click=original,500);return true})()`)
  await until('!!window.__requestDownload');assert.strictEqual(await evaluate('window.__requestDownload'),'Agent-'+short+'.agentreq')
  assert.strictEqual(issuer.fileStem(requestInfo.deviceDigest)+'.agentreq',await evaluate('window.__requestDownload'))
  await new Promise((resolve,reject)=>{const req=require('http').get(new URL('/api/state',url),{headers:{Origin:'https://untrusted.example'}},res=>{try{assert.strictEqual(res.statusCode,403);res.resume();resolve()}catch(e){reject(e)}});req.on('error',reject)})
assert.strictEqual(await evaluate("window.fetch('/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)"),403)
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.getElementById('licenseGate').click();document.getElementById('newSession').focus()")
  await until('document.getElementById("licenseGate").contains(document.activeElement)');const focus=await evaluate(`({locked:window.licensingUI.isLocked(),focus:document.activeElement.outerHTML.slice(0,200),gate:document.getElementById('licenseGate').outerHTML.slice(0,300),display:getComputedStyle(document.getElementById('licenseGate')).display,buttons:Array.from(document.querySelectorAll('#licenseGate button')).map(b=>({text:b.textContent,disabled:b.disabled,rects:b.getClientRects().length})),inside:document.getElementById("licenseGate").contains(document.activeElement),inert:!!document.getElementById("newSession").closest("[inert]")})`);assert(focus.locked&&focus.inside&&focus.inert,JSON.stringify(focus))
  await evaluate(`(()=>{const d=new DataTransfer();d.items.add(new File(['invalid'],'bad.agentlic'));document.querySelector('#licenseGate .license-drop').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}))})()`)
  await until('document.getElementById("gateLicenseError").textContent.length>0');assert(await evaluate('window.licensingUI.isLocked()'))
  for(const theme of ['dark','light']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await delay(150);const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.mkdirSync(path.join(root,'release/validation'),{recursive:true});fs.writeFileSync(path.join(root,'release/validation/license-gate-'+theme+'.png'),Buffer.from(shot.data,'base64'))}
  await evaluate("Array.from(document.querySelectorAll('#licenseGate button')).find(b=>b.textContent==='试用10分钟').click()")
  await until('window.licensingUI && !window.licensingUI.isLocked()');await delay(600);assert.strictEqual(await evaluate("window.dsh.licenseRequest('status').then(s=>s.status)"),'trial')
  const trialEnd=await evaluate("window.dsh.licenseRequest('status').then(s=>s.expiresAt)")
  await stop();await start();assert.strictEqual(await evaluate("window.dsh.licenseRequest('status').then(s=>s.expiresAt)"),trialEnd)
  await until('typeof state!=="undefined" && !!state.runPoll && window.scheduledTasks && window.scheduledTasks.ready')
  await evaluate("document.getElementById('openSettings').click();document.querySelector('[data-settings-tab=license]').click()")
  await until('!document.querySelector("[data-settings-panel=license]").classList.contains("hidden")');assert(await evaluate("document.getElementById('licenseSettings').textContent.includes('试用中')"))
  await stop();const stateFile=path.join(dir,'agent-home/licensing/state.json'),saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));saved.trial.startedAt=Date.now()-600001;saved.trial.expired=true;fs.writeFileSync(stateFile,JSON.stringify(saved));await start();assert(await evaluate('window.licensingUI.isLocked()'));assert(await evaluate("Array.from(document.querySelectorAll('#licenseGate button')).find(b=>b.textContent==='试用已使用').disabled"))
  const request=await evaluate("window.dsh.licenseRequest('request')"),directory=issuer.defaultDirectory(),authority=issuer.status(directory),issued=issuer.issue({directory,requestText:JSON.stringify(request),customer:'隔离验收',days:1})
  const claims={...issued.claims,expiresAt:Date.now()+7000},bytes=Buffer.from(C.canonical(claims)),license=JSON.stringify({version:1,keyId:authority.keyId,payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,fs.readFileSync(path.join(directory,'private.pem'))).toString('base64')}),file=path.join(dir,'test.agentlic');fs.writeFileSync(file,license)
  const doc=await cdp.send('DOM.getDocument'),input=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#licenseGate input[type=file]'});await cdp.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[file]})
  await until('window.licensingUI && !window.licensingUI.isLocked()');await until('typeof state!=="undefined" && !!state.runPoll && window.scheduledTasks && window.scheduledTasks.ready');await evaluate("document.getElementById('openSettings').click();document.querySelector('[data-settings-tab=license]').click()");await until("document.querySelector('#licenseSettings .license-badge').textContent==='已授权'")
  assert(await evaluate("document.getElementById('licenseSettings').textContent.includes('隔离验收')"))
  await until('window.licensingUI.isLocked()',10000)
  assert.strictEqual(await evaluate("window.fetch('/api/chat/send',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)"),403);assert.strictEqual(await evaluate("window.dsh.licenseRequest('status').then(s=>s.status)"),'expired')
  fs.writeFileSync(path.join(root,'release/validation/licensing-ui.json'),JSON.stringify({gate:true,escapeBlocked:true,focusTrap:true,invalidDrop:true,trialRestart:true,settings:true,clickUpload:true,expirationGate:true,backendDenied:true,trialExpiredFixture:true,url},null,2))
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
}
main().then(()=>console.log('PASS packaged licensing UI')).catch(e=>{console.error(e);process.exitCode=1})
