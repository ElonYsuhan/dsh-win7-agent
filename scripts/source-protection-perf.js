'use strict'
// macOS acceptance probe: independent app processes/data, alternating baseline
// and protected payloads. OS filesystem caches are NOT flushed; these are not
// hardware-cold/Gatekeeper-first-launch or Windows 7 measurements.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), cp = require('child_process'), assert = require('assert')
const { MiniWebSocket, CdpSession, httpGetJson } = require('../src/main/agent/cdp-client')
const root = path.resolve(__dirname, '..'), protectedBundle = path.resolve(process.argv[2] || 'release/.desktop-build/mac-arm64/delivery/Agent.app')
const count = Number(process.env.AGENT_PERF_SAMPLES || 30)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const value = s.address().port; await new Promise(r => s.close(r)); return value }
async function sample(bundle, cycles) {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-protection-perf-'))), debug = await port()
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ mode: 'local', theme: 'light' }))
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
  const begin = Date.now(), child = cp.spawn(path.join(bundle, 'Contents/MacOS/Electron'), ['--user-data-dir='+userData, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port='+debug], { env: environment, stdio: ['ignore','pipe','pipe'] })
  let log = '', socket, firstPage = null
  for (const stream of [child.stdout,child.stderr]) stream.on('data', d => { log = (log + d).slice(-4000) })
  try {
    let target
    for (let i=0;i<1000;i++) {
      let targets=[]; try { targets = await httpGetJson('127.0.0.1', debug, '/json/list', 500) } catch (_) {}
      if (firstPage===null && targets.some(t=>t.type==='page')) firstPage=Date.now()-begin
      target=targets.find(t=>t.type==='page' && /^http:/.test(t.url));if(target)break
      if(child.exitCode!==null)throw Error('APP_EXIT: '+log)
      await sleep(25)
    }
    assert(target, 'application renderer: '+log)
    socket = new MiniWebSocket();const url=new URL(target.webSocketDebuggerUrl);await socket.connect(url.hostname,Number(url.port),url.pathname)
    const cdp=new CdpSession(socket)
    async function evaluate(expression) { const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value }
    let ready=false
    for(let i=0;i<500;i++){try{ready=await evaluate("typeof state!=='undefined'&&!!state.runPoll&&!!window.workflowUI&&!!window.knowledgeUI&&!!window.extensionUI")}catch(_){}if(ready)break;await sleep(20)}
    assert(ready,'UI ready: '+log)
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
    const readyMs=Date.now()-begin
    const fcp=await evaluate("performance.getEntriesByName('first-contentful-paint')[0]?.startTime||null")
    await cdp.send('Performance.enable')
    const resources=async()=>{await cdp.send('HeapProfiler.collectGarbage');const data=await cdp.send('Performance.getMetrics');return Object.fromEntries(data.metrics.filter(x=>['Nodes','JSEventListeners','JSHeapUsedSize'].includes(x.name)).map(x=>[x.name,x.value]))}
    const rows=[]
    const loop=async()=>evaluate(`(async()=>{const result=[];for(const [button,page,close]of [['openCustomize','capabilityCenter','closeCapabilities'],['openWorkflows','workflowPage','workflowClose'],['openLibrary','knowledgePage','knowledgeClose']]){const start=performance.now();document.getElementById(button).click();for(let i=0;i<100&&document.getElementById(page).classList.contains('hidden');i++)await new Promise(requestAnimationFrame);if(document.getElementById(page).classList.contains('hidden'))throw Error('Module never opened '+page);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);result.push({module:page,ms:performance.now()-start});document.getElementById(close).click();await new Promise(requestAnimationFrame)}return result})()`)
    rows.push(...(await loop()).map(r=>({...r,phase:'first'})))
    const before=await resources()
    for(let i=0;i<cycles;i++)rows.push(...(await loop()).map(r=>({...r,phase:'repeat'})))
    const after=await resources()
    const rssKb=Number(cp.execFileSync('ps',['-o','rss=','-p',String(child.pid)],{encoding:'utf8'}).trim())
    return { readyMs,windowObservedMs:firstPage,fcpMs:fcp,rows,before,after,mainRssKb:rssKb }
  } finally {
    if(socket&&socket.socket)socket.socket.destroy()
    child.kill('SIGTERM')
    for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await sleep(20)
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
    await sleep(100);fs.rmSync(userData,{recursive:true,force:true,maxRetries:20,retryDelay:100})
  }
}
function p95(values){const rows=values.slice().sort((a,b)=>a-b);return rows[Math.ceil(rows.length*.95)-1]}
function summary(samples){return {readyP95Ms:p95(samples.map(s=>s.readyMs)),windowObservedP95Ms:p95(samples.map(s=>s.windowObservedMs)),firstModuleP95Ms:p95(samples.flatMap(s=>s.rows.filter(r=>r.phase==='first').map(r=>r.ms))),repeatModuleP95Ms:p95(samples.flatMap(s=>s.rows.filter(r=>r.phase==='repeat').map(r=>r.ms))),maxListenerGrowth:Math.max(...samples.map(s=>s.after.JSEventListeners-s.before.JSEventListeners)),maxNodeGrowth:Math.max(...samples.map(s=>s.after.Nodes-s.before.Nodes))}}
async function main(){
  assert.strictEqual(process.platform,'darwin');assert(Number.isInteger(count)&&count>=1&&count<=60)
  const baselineRoot=await require('./build-desktop').buildTarget('mac-'+process.arch,{noZip:true,outRoot:path.join(root,'release/.desktop-build/performance-baseline')})
  const baselineBundle=path.join(baselineRoot,'Agent.app'),app=path.join(baselineBundle,'Contents/Resources/app')
  fs.writeFileSync(path.join(app,'distribution.json'),JSON.stringify({formatVersion:1,target:'mac-'+process.arch,version:require('../package.json').version,kind:'app-bundle',directoryTakeover:true}))
  const baselineMeta={formatVersion:1,target:'mac-'+process.arch,version:require('../package.json').version,electron:'22.3.27',node:'16.17.1',chromium:'108',uiBuild:require('../src/main/agent/ui-build').computeUiBuild(path.join(app,'src/renderer')),packageBuildId:require('../shell/installer').computePackageBuildId(app)}
  fs.writeFileSync(path.join(app,'desktop-build.json'),JSON.stringify(baselineMeta))
  cp.execFileSync('codesign',['--force','--deep','--sign','-',baselineBundle],{stdio:'ignore'})
  const samples={baseline:[],protected:[]}
  for(let i=0;i<count;i++)for(const kind of i%2?['protected','baseline']:['baseline','protected']){const value=await sample(kind==='baseline'?baselineBundle:protectedBundle,i===0?20:1);samples[kind].push(value);console.log(kind+' '+(i+1)+'/'+count+' ready='+value.readyMs+'ms')}
  const baseline=summary(samples.baseline),protectedStats=summary(samples.protected)
  const report={platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0].model,cpuCount:os.cpus().length,memoryBytes:os.totalmem(),storage:cp.execFileSync('diskutil',['info','/'],{encoding:'utf8'}),power:cp.execFileSync('pmset',['-g','batt'],{encoding:'utf8'}),samplesPerBuild:count,dataset:'isolated empty user data',notes:'Alternating independent process launches. OS caches not flushed; windowObserved is CDP page detection, not native compositor first paint; no Win7/physical Linux claim; real-history workload and service/renderer child RSS need separate profiling.',baseline,protected:protectedStats,relativeStartup:protectedStats.readyP95Ms/baseline.readyP95Ms,relativeFirstModule:protectedStats.firstModuleP95Ms/baseline.firstModuleP95Ms,relativeRepeatModule:protectedStats.repeatModuleP95Ms/baseline.repeatModuleP95Ms,samples}
  report.accepted=count>=30&&report.relativeStartup<=1.1&&report.relativeFirstModule<=1.1&&report.relativeRepeatModule<=1.1&&protectedStats.readyP95Ms<=3000&&protectedStats.firstModuleP95Ms<=500&&protectedStats.repeatModuleP95Ms<=150
  fs.mkdirSync(path.join(root,'release/validation'),{recursive:true});fs.writeFileSync(path.join(root,'release/validation/source-protection-perf.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({baseline,protected:protectedStats,relativeStartup:report.relativeStartup,relativeFirstModule:report.relativeFirstModule,relativeRepeatModule:report.relativeRepeatModule,accepted:report.accepted}))
  if(!report.accepted)process.exitCode=1
}
main().catch(error=>{console.error(error);process.exitCode=1})
