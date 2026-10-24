'use strict'
// Large-history navigation in the pinned Chromium108, with an isolated data directory.
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http')
const { spawn } = require('child_process')
const { BrowserDriver } = require('../src/main/agent/browser-driver')
const ROOT = path.resolve(__dirname, '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(fn, label) { for (let i=0;i<200;i++) { try { if(await fn())return } catch (_) {} await sleep(60) } throw Error('Timeout: '+label) }
async function main() {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'agent-navigation-')),workspace=path.join(temporary,'workspace'),driver=new BrowserDriver()
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(temporary,'settings.json'),JSON.stringify({workspacePath:workspace}))
  const stamp=new Date().toISOString(),session=(id,messages)=>({id,title:id,scope:'recent',projectId:'',workspacePath:workspace,createdAt:stamp,updatedAt:stamp,messages})
  const conversations=[session('navigation_current',Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',content:'**历史段落 '+i+'**\n'+('完整历史内容 '.repeat(400))}))),...Array.from({length:16},(_,i)=>session('history_'+i,[{role:'assistant',content:'x'.repeat(256*1024)}]))]
  fs.writeFileSync(path.join(temporary,'ui-store.json'),JSON.stringify({sessions:{__recent__:conversations},currentSessionId:'navigation_current',prefs:{},updatedAt:Date.now()}))
  const listener=http.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
  const base='http://127.0.0.1:'+port,child=spawn(process.execPath,[path.join(ROOT,'server/index.js')],{cwd:ROOT,env:{...process.env,AGENT_HOME:temporary,HOST:'127.0.0.1',PORT:String(port),PORT_MAX_ATTEMPTS:'0'},stdio:['ignore','pipe','pipe']})
  let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk)
  try {
    await wait(()=>logs.includes('[agent-service] listening'),'service')
    const executable=path.join(ROOT,'node_modules/electron/dist',fs.readFileSync(path.join(ROOT,'node_modules/electron/path.txt'),'utf8').trim())
    await driver.launch(base+'/',{electronPath:executable,noSandbox:process.env.SMOKE_NO_SANDBOX==='1'})
    await wait(()=>driver.evaluate('typeof state!=="undefined"&&state.currentSessionId==="navigation_current"&&!!document.querySelector(".bubble")&&!!window.extensionUI'),'restored history')
    await sleep(800)
    await driver.evaluate(`(()=>{clearInterval(state.runPoll);state.runPoll=null;window.__navigation={writes:0,puts:0,longTasks:[]};window.__navigationBubble=document.querySelector('.bubble');window.__skillCard=document.querySelector('#skillLibraryList .capability-row');const old=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='dsh-sessions-v1')window.__navigation.writes++;return old.call(this,k,v)};const fetch=window.fetch;window.fetch=function(url,options){if(String(url).includes('/api/ui-store')&&options?.method==='PUT')window.__navigation.puts++;return fetch.apply(this,arguments)};window.__navigationObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__navigation.longTasks.push(entry.duration)});window.__navigationObserver.observe({entryTypes:['longtask']});return true})()`)
    const samples=[]
    for(let i=0;i<20;i++) {
      samples.push(await driver.evaluate(`(async()=>{const samples=[];for(const id of ['openCustomize','openWorkflows','openLibrary']){const start=performance.now();document.getElementById(id).click();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const shown=performance.now();await selectSession('navigation_current');await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);samples.push({module:id,openMs:shown-start,returnMs:performance.now()-shown});if(document.querySelector('.bubble')!==window.__navigationBubble)throw Error('unchanged conversation rebuilt')}return samples})()`,{awaitPromise:true}))
    }
    await driver.evaluate('window.extensionUI.refresh().then(()=>window.extensionUI.refresh())',{awaitPromise:true})
    const stats=await driver.evaluate(`({ ...window.__navigation,skillDomRetained:document.querySelector('#skillLibraryList .capability-row')===window.__skillCard,bubbleRetained:document.querySelector('.bubble')===window.__navigationBubble })`)
    assert.strictEqual(stats.writes,0,'module switches never rewrite the complete conversation store')
    assert.strictEqual(stats.puts,0,'module switches never push the complete history to the service')
    assert(stats.bubbleRetained&&stats.skillDomRetained,'unchanged chat and skill DOM are reused')
    // Changed messages must invalidate the cache and render actual new content.
    assert(await driver.evaluate(`(async()=>{updateSessionMessages('navigation_current',[{role:'assistant',content:'已更新的真实内容'}],null);await selectSession('navigation_current');return messagesContent().textContent.includes('已更新的真实内容')&&document.querySelector('.bubble')!==window.__navigationBubble})()`,{awaitPromise:true}),'updated conversation is never hidden behind stale cached DOM')
    const rows=samples.flat(),percentile=values=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]
    const report={platform:process.platform,arch:process.arch,chromium:'108',loops:20,historyBytes:Buffer.byteLength(JSON.stringify(conversations)),...stats,openP95Ms:percentile(rows.map(r=>r.openMs)),returnP95Ms:percentile(rows.map(r=>r.returnMs)),samples:rows}
    fs.mkdirSync(path.join(ROOT,'release/validation'),{recursive:true});fs.writeFileSync(path.join(ROOT,'release/validation/module-switch.json'),JSON.stringify(report,null,2)+'\n')
    console.log('Module navigation passed: 20 loops, unchanged history/skill DOM retained, zero full-store writes, changed-content invalidation; '+JSON.stringify({openP95Ms:report.openP95Ms,returnP95Ms:report.returnP95Ms,historyBytes:report.historyBytes}))
  } catch(error) { console.error(logs.slice(-1500));throw error }
  finally {await driver.close();child.kill('SIGTERM');await wait(()=>child.exitCode!==null||child.signalCode!==null,'service exit').catch(()=>child.kill('SIGKILL'));fs.rmSync(temporary,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
