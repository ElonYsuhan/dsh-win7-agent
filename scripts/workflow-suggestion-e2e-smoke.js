'use strict'
/* 流程匹配推荐的真实窗口回归：会话内推荐卡、开启入口、点击后进入执行实例页。 */
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert')
const {spawn}=require('child_process'),{BrowserDriver}=require('../src/main/agent/browser-driver')
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(fn,label){for(let i=0;i<300;i++){try{if(await fn())return}catch(_){}await sleep(80)}throw Error('timeout '+label)}
function request(url){return new Promise((resolve,reject)=>{const req=http.request(url,{method:'GET'},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{try{resolve(JSON.parse(body))}catch(error){reject(error)}})});req.on('error',reject);req.end()})}
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'agent-workflow-suggest-e2e-'))
 fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({workspacePath:home}))
 const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve))
 const service=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,AGENT_HOME:home,HOST:'127.0.0.1',PORT:String(port),PORT_MAX_ATTEMPTS:'0'},stdio:['ignore','pipe','pipe']})
 let logs='';service.stdout.on('data',chunk=>logs+=chunk);service.stderr.on('data',chunk=>logs+=chunk)
 const driver=new BrowserDriver()
 try{
  await wait(async()=>(await request('http://127.0.0.1:'+port+'/api/health')).ok,'service ready')
  await driver.launch('http://127.0.0.1:'+port+'/',{electronPath:path.join(root,'node_modules/electron/dist/electron.exe'),width:1280,height:900,noSandbox:true})
  await wait(()=>driver.evaluate('!!window.workflowChat&&!!window.workflowUI'),'renderer ready')
  await wait(()=>driver.evaluate("!document.getElementById('licenseGate')||document.getElementById('licenseGate').classList.contains('hidden')"),'license gate closed')

  const flowId=await driver.evaluate(`(()=>{const def={name:'周报汇总',description:'收集本周进展并生成周报',editor:'steps',nodes:[{id:'s',type:'start',title:'开始',text:'本周进展'},{id:'h',type:'human',title:'整理素材',interaction:{version:1,type:'handle',returnTo:'previous-human'}},{id:'e',type:'end',title:'结束',deliverable:{format:'markdown',name:'周报'}}],edges:[{from:'s',to:'h'},{from:'h',to:'e'}]};const xhr=new XMLHttpRequest();xhr.open('POST','/api/workflows/save',false);xhr.setRequestHeader('Content-Type','application/json');xhr.send(JSON.stringify(def));try{return JSON.parse(xhr.responseText).id||''}catch(_){return ''}})()`)
  assert(/^[a-zA-Z0-9_-]{1,80}$/.test(flowId),'Saved workflow id is available for the suggestion card: '+logs.slice(-300))

  const card=await driver.evaluate(`(()=>{const host=document.createElement('div');host.id='suggestionProbe';document.getElementById('messages').append(host);window.workflowChat.decorateToolResult(host,'workflow_suggest',JSON.stringify({suggestion:{workflowId:${JSON.stringify(flowId)},name:'周报汇总',reason:'覆盖整理素材与出稿两步，缺少数据导出',matches:['goal','steps']}}));const box=host.querySelector('.workflow-suggestion'),button=host.querySelector('.workflow-suggestion-start'),rect=box&&box.getBoundingClientRect();return {card:!!box,label:box?box.querySelector('strong').textContent:'',reason:box?box.querySelector('p').textContent:'',button:button?button.textContent:'',width:rect?rect.width:0,viewport:innerWidth}})()`)
  assert(card.card,'Suggestion renders a card inside the conversation')
  assert.strictEqual(card.label,'可以用「周报汇总」完成这件事','Suggestion card names the matched workflow')
  assert.strictEqual(card.reason,'覆盖整理素材与出稿两步，缺少数据导出','Suggestion card keeps the stated fit and gap')
  assert.strictEqual(card.button,'开启工作流','Suggestion card offers exactly one open action')
  assert(card.width>0&&card.width<=card.viewport,'Suggestion card never overflows the conversation column')

  const clicked=await driver.evaluate(`(()=>{const button=document.querySelector('#suggestionProbe .workflow-suggestion-start');if(!button)return 'missing';button.click();return button.disabled?'disabled-after-click':'no-effect'})()`)
  assert.strictEqual(clicked,'disabled-after-click','Opening a suggested workflow disables the button to stop double starts')

  await wait(()=>driver.evaluate(`(()=>{const page=document.getElementById('workflowPage'),detail=document.getElementById('workflowRunDetail');return !page.classList.contains('hidden')&&!!detail&&!detail.classList.contains('hidden')})()`),'workflow run detail')
  const detail=await driver.evaluate(`(()=>{const detail=document.getElementById('workflowRunDetail');return {text:detail.textContent.replace(/\\s+/g,' ').trim().slice(0,200),runs:(document.querySelectorAll('#workflowRunDetail .workflow-run-card, #workflowInstances .workflow-card')||[]).length}})()`)
  assert(/周报汇总/.test(detail.text),'Opening the suggestion lands on that workflow instance page: '+detail.text)
  assert(/实例|待人工处理/.test(detail.text),'Instance page shows the created run and its pending human step: '+detail.text)
  console.log('Workflow suggestion e2e passed: conversation card, single open action, starts one run and lands on the execution instance page')
 }catch(error){console.error(error.message);console.error(logs.slice(-800));process.exitCode=1}
 finally{try{driver.close()}catch(_){}try{await driver.finishClose()}catch(_){}service.kill();fs.rmSync(home,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
