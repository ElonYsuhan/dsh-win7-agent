'use strict'
// Real Chromium UI acceptance, isolated home/workspace; no model or external service calls.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http')
const {spawn}=require('child_process')
const {BrowserDriver}=require('../src/main/agent/browser-driver')
const ROOT=path.resolve(__dirname,'..')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(check,label){for(let i=0;i<100;i++){try{const v=await check();if(v)return v}catch(e){}await sleep(100)}throw Error('Timeout: '+label)}
async function port(){const s=http.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p}
function get(url){return new Promise((resolve,reject)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(e)}})}).on('error',reject))}
let passed=0
function ok(name,value){assert(value,name);console.log('PASS '+name);passed++}
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-ux-browser-')),home=path.join(temp,'home'),workspace=path.join(temp,'workspace'),driver=new BrowserDriver()
 fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(workspace,'example.txt'),'reference file')
 const p=await port(),base='http://127.0.0.1:'+p
 const child=spawn(process.execPath,[path.join(ROOT,'server/index.js')],{cwd:ROOT,env:{...process.env,HOST:'127.0.0.1',PORT:String(p),PORT_MAX_ATTEMPTS:'1',AGENT_HOME:home,WORKSPACE_PATH:workspace},stdio:['ignore','pipe','pipe']})
 let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c)
 try{
  await wait(()=>get(base+'/api/health'),'service')
  const binary=path.join(ROOT,'node_modules/electron/dist',fs.readFileSync(path.join(ROOT,'node_modules/electron/path.txt'),'utf8').trim())
  await driver.launch(base+'/',{electronPath:binary,width:1280,height:900,noSandbox:process.env.SMOKE_NO_SANDBOX==='1'})
  await wait(()=>driver.evaluate('typeof state!=="undefined" && state.settings && window.agentUI && document.getElementById("serviceConnection").textContent==="服务已连接"'),'UI ready')
  await driver.evaluate("window.__dragEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,e=>window.__dragEvents.push({type,x:e.clientX,y:e.clientY,target:e.target.tagName,drag:document.documentElement.classList.contains('dialog-dragging')}),true);window.addEventListener('blur',()=>window.__dragEvents.push({type:'blur'}));true");
  const box=()=>driver.evaluate("(()=>{const r=document.getElementById('dragPanel').getBoundingClientRect();return{x:r.left,y:r.top,w:r.width,h:r.height}})()")
  async function dragBy(dx,dy,cancel){const start=await driver.evaluate("(()=>{const r=document.querySelector('#dragPanel h2').getBoundingClientRect();return{x:r.left+20,y:r.top+10}})()");await driver.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...start});await driver.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:start.x+dx,y:start.y+dy});await sleep(40);if(cancel){await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})}await driver.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:start.x+dx,y:start.y+dy});await sleep(30)}
  for(const [outer,inner]of [['modal','modal-card'],['task-dialog','task-editor'],['artifact-overlay','quick-menu'],['artifact-overlay','artifact-viewer'],['modal','knowledge-create-modal'],['native','']]){
   await driver.cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
   await driver.evaluate(`(()=>{const overlay=document.createElement('${outer==='native'?'dialog':'div'}');overlay.id='dragFixture';overlay.className=${JSON.stringify(outer==='native'?'workflow-artifact-dialog':outer)};const card=${outer==='native'?'overlay':"document.createElement('section')"};card.id='dragPanel';card.className+=${JSON.stringify(' '+inner)};card.innerHTML='<header><h2>拖拽回归</h2><button id="dragClose" type="button">操作按钮</button></header><p id="dragText">正文可以正常选择和滚动。</p><input id="dragInput" aria-label="测试输入">';card.style.width='480px';card.style.height='280px';if(card!==overlay)overlay.append(card);document.body.append(overlay);if(overlay.showModal)overlay.showModal();window.__dragClicks=0;document.getElementById('dragClose').onclick=()=>window.__dragClicks++;return true})()`)
   for(const theme of ['light','dark']){await driver.evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));const before=await box();await dragBy(90,55);const after=await box();assert(Math.abs(after.x-before.x-90)<2&&Math.abs(after.y-before.y-55)<2,'Drag '+outer+'/'+inner+' '+theme+' '+JSON.stringify({before,after,events:await driver.evaluate('window.__dragEvents.slice(-10)')}))}
   const saved=await box();await dragBy(-60,-30,true);const restored=await box();assert(Math.abs(restored.x-saved.x)<2&&Math.abs(restored.y-saved.y)<2,'Escape cancels movement');assert(await driver.evaluate("!document.documentElement.classList.contains('dialog-dragging')"),'Drag state cleaned')
   await driver.click('#dragClose');assert.strictEqual(await driver.evaluate('window.__dragClicks'),1,'Button remains clickable');await driver.input('#dragInput','输入正常');assert.strictEqual(await driver.evaluate('document.getElementById("dragInput").value'),'输入正常')
   const textBox=await driver.evaluate("(()=>{const r=document.getElementById('dragText').getBoundingClientRect();return{x:r.left+20,y:r.top+8}})()");const original=await box();await driver.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...textBox});await driver.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:textBox.x+40,y:textBox.y+10});await driver.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:textBox.x+40,y:textBox.y+10});const untouched=await box();assert.strictEqual(untouched.x,original.x,'Body drag does not move dialog')
   await driver.evaluate('document.getElementById("dragInput").focus();true');const keyboard=await box();await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37,modifiers:9});await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37,modifiers:9});assert(Math.abs((await box()).x-keyboard.x+20)<2,'Keyboard dialog movement')
   await dragBy(2500,1800);const edge=await box();assert(edge.x<1280&&edge.x+edge.w>=90&&edge.y>=0&&edge.y<=864,'Title remains reachable')
   await driver.cdp.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:1,mobile:false});await sleep(40);const resized=await box();assert(resized.x<800&&resized.y<=564,'Viewport resize clamps position');await driver.evaluate("(document.getElementById('dragFixture')||document.getElementById('dragPanel')).remove();true");await driver.cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
  }
  await driver.evaluate("window.__confirmResult=null;window.appDialogs.confirm('实际确认框拖动').then(v=>window.__confirmResult=v);true");await wait(()=>driver.evaluate("!document.getElementById('confirmModal').classList.contains('hidden')"),'actual confirm');await driver.evaluate("document.querySelector('#confirmModal .modal-card').id='dragPanel';true");await dragBy(-70,25);await driver.click('#confirmCancel');assert.strictEqual(await driver.evaluate('window.__confirmResult'),false,'Actual dialog cancel preserved')
  console.log('Shared dialog drag passed: all six shells, dynamic/native dialogs, themes, controls/text, Escape rollback, keyboard, resize and real confirm; Chromium108')
 }catch(error){console.error(logs.slice(-2000));throw error}finally{await driver.close();child.kill('SIGTERM');await wait(()=>child.exitCode!==null||child.signalCode!==null,'shutdown').catch(()=>child.kill('SIGKILL'));fs.rmSync(temp,{recursive:true,force:true})}

}
main().catch(error=>{console.error(error);process.exitCode=1})
