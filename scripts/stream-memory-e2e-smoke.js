'use strict'
// Isolated stream memory regression. Synthetic UI events never execute tools or call a model.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http')
const {spawn}=require('child_process')
const {BrowserDriver}=require('../src/main/agent/browser-driver')
const ROOT=path.resolve(__dirname,'..')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(check,label){for(let i=0;i<100;i++){try{const v=await check();if(v)return v}catch(e){}await sleep(100)}throw Error('Timeout: '+label)}
async function port(){const s=http.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p}
function get(url){return new Promise((resolve,reject)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(e)}})}).on('error',reject))}
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
  await driver.cdp.send('Performance.enable',{})
  await driver.evaluate(`(async()=>{clearInterval(state.runPoll);state.runPoll=null;const filler=createSession('','历史内容','recent');filler.messages=[{role:'assistant',content:'x'.repeat(3*1024*1024)}];const s=createSession('','流式内存回归','recent');await selectSession(s.id);addRun(s.id);applyRunState();window.__memorySession=s.id;window.__writes={count:0,bytes:0};const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='dsh-sessions-v1'){window.__writes.count++;window.__writes.bytes+=String(v).length}return original.call(this,k,v)};return true})()`,{awaitPromise:true})
  const count=Number(process.env.AGENT_MEMORY_CHUNKS)||1200,start=Date.now()
  for(let i=0;i<count;i+=100){await driver.evaluate(`(async()=>{for(let j=0;j<100;j++)await handleEvent({type:'assistant:thinking',sessionId:window.__memorySession,text:'推理增量内容0123456789'});return true})()`,{awaitPromise:true});await sleep(10)}
  await driver.evaluate(`(async()=>{await handleEvent({type:'tool:start',sessionId:window.__memorySession,name:'run_command',args:{command:'synthetic only'}});await handleEvent({type:'tool:result',sessionId:window.__memorySession,name:'run_command',result:'exitCode=0\\n验证输出',outcome:'success'});return true})()`,{awaitPromise:true})
  await sleep(500)
  const stats=await driver.evaluate(`({writes:window.__writes,steps:document.querySelectorAll('.tl-step').length,chunks:Array.from(document.querySelectorAll('.tl-think .tl-body')).reduce((n,b)=>n+b.textContent.split('推理增量内容0123456789').length-1,0),timeline:currentSession().processTimeline.length})`)
  const heap=await driver.cdp.send('Runtime.getHeapUsage',{}),dom=await driver.cdp.send('Memory.getDOMCounters',{})
  console.log(JSON.stringify({chunks:count,elapsedMs:Date.now()-start,...stats,heap,dom}))
  if(!process.env.AGENT_MEMORY_BASELINE){
   assert(stats.writes.count<100,'Stream must coalesce full session writes');assert(stats.writes.bytes<400*1024*1024,'Storage serialization budget');assert.strictEqual(stats.chunks,count);assert(stats.steps<=3,'Text increments must not create unbounded nodes');assert(heap.usedSize<256*1024*1024,'Bounded JS heap for small stream')
   const answer=await driver.evaluate(`(async()=>{window.__artifactRenders=0;const old=window.agentUI.artifacts;window.agentUI.artifacts=function(...args){window.__artifactRenders++;return old.apply(this,args)};for(let i=0;i<1000;i++)await handleEvent({type:'assistant:delta',sessionId:window.__memorySession,text:'正文片段'});const calls=window.__artifactRenders;await handleEvent({type:'assistant:message',sessionId:window.__memorySession,text:'**最终答案**\\n'+('正文片段'.repeat(1000))});return{calls,finalCalls:window.__artifactRenders,strong:document.querySelectorAll('.bubble.assistant strong').length,raw:document.querySelector('.bubble.assistant .bubble-body')?.dataset.raw||''}})()`,{awaitPromise:true})
   assert(answer.calls<=1,'No repeated artifact/image work during text stream');assert(answer.finalCalls<=2,'Rich render only at final message');assert(answer.strong>0&&answer.raw.includes('正文片段'.repeat(1000)),'Final Markdown and complete answer preserved')
   const transfer=await driver.evaluate(`(async()=>{const a=currentSession(),b=createSession('','后台流','recent');addRun(b.id);await handleEvent({type:'assistant:thinking',sessionId:b.id,text:'后台待保存的完整片段'});await selectSession(b.id);const restored=messagesContent().textContent.includes('后台待保存的完整片段');await handleEvent({type:'assistant:thinking',sessionId:b.id,text:'切回后的片段'});await handleEvent({type:'assistant:message',sessionId:b.id,text:'第二会话答案'});return{restored,saved:findSessionById(b.id).processHtml,entries:findSessionById(b.id).processTimeline.length}})()`,{awaitPromise:true})
   assert(transfer.restored&&transfer.saved.includes('后台待保存的完整片段')&&transfer.saved.includes('切回后的片段'),'Flush on switch and reply preserves foreground/background traces');assert.strictEqual(transfer.entries,1)
  }

 }catch(error){console.error(logs.slice(-2000));throw error}finally{await driver.close();child.kill('SIGTERM');await wait(()=>child.exitCode!==null||child.signalCode!==null,'shutdown').catch(()=>child.kill('SIGKILL'));fs.rmSync(temp,{recursive:true,force:true})}
 console.log('Stream memory regression passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
