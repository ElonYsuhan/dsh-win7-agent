'use strict'
// Isolated service, loopback model and real Electron Chromium. Never touches user tasks.
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),{spawn}=require('child_process')
const {BrowserDriver}=require('../src/main/agent/browser-driver')
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));let passed=0
function ok(label,value){assert(value,label);console.log('PASS '+label);passed++}
async function wait(fn,label){for(let i=0;i<150;i++){try{const x=await fn();if(x)return x}catch(_){}await sleep(100)}throw Error('Timeout '+label)}
function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port))})}
async function port(){const s=http.createServer(),p=await listen(s);await new Promise(r=>s.close(r));return p}
function request(method,url,value){return new Promise((resolve,reject)=>{const req=http.request(url,{method,headers:{'content-type':'application/json'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(b)})}catch(e){reject(e)}})});req.on('error',reject);if(value)req.write(JSON.stringify(value));req.end()})}
async function main(){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'tasks-browser-'))),home=path.join(temp,'data'),workspace=path.join(temp,'workspace');fs.mkdirSync(home);fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'hello.txt'),'ok')
 let calls=0
 const model=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{calls++;const data=JSON.parse(body);assert(data.messages.some(m=>m.role==='user'));res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:data.messages.some(m=>m.role==='tool')?{content:'定时巡检完成，没有发现问题。'}:{tool_calls:[{index:0,id:'task_read',type:'function',function:{name:'read_file',arguments:'{"path":"hello.txt"}'}}]},finish_reason:data.messages.some(m=>m.role==='tool')?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n')})})
 const mp=await listen(model),p=await port(),base='http://127.0.0.1:'+p
 fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({workspacePath:workspace,baseURL:'http://127.0.0.1:'+mp+'/v1',model:'local-test',apiKey:'local',permissionMode:'workspace',maxConcurrentRuns:4}))
 let child,logs='',driver=new BrowserDriver()
 async function start(){child=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,AGENT_HOME:home,HOST:'127.0.0.1',PORT:String(p),PORT_MAX_ATTEMPTS:'0'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);await wait(async()=> (await request('GET',base+'/api/health')).status===200,'service')}
 async function stop(){if(!child)return;child.kill('SIGTERM');await wait(()=>child.exitCode!==null||child.signalCode!==null,'stop');await sleep(100)}
 try{
  await start();const binary=path.join(root,'node_modules/electron/dist',fs.readFileSync(path.join(root,'node_modules/electron/path.txt'),'utf8').trim());await driver.launch(base,{electronPath:binary,noSandbox:process.env.SMOKE_NO_SANDBOX==='1'});await driver.cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await wait(()=>driver.evaluate('typeof state!=="undefined" && state.settings && window.scheduledTasks && window.scheduledTasks.ready && document.getElementById("serviceConnection").textContent==="服务已连接"'),'UI')
  ok('通知入口已移除，侧栏可直接打开设置',await driver.evaluate('!document.getElementById("taskNoticeBell")&&!document.getElementById("taskNoticeList")&&!!document.getElementById("openSettings")'))
  await driver.click('#openCustomize');await driver.click('#capTabTasks');await wait(()=>driver.evaluate('document.getElementById("taskHost")'),'task list')
  ok('能力中心有任务页（执行机器说明已搬进系统设置）',await driver.evaluate('!document.getElementById("capTasks").classList.contains("hidden")'))
  ok('执行环境在系统设置里且排在模型下面',await driver.evaluate('Array.from(document.querySelectorAll("[data-settings-tab]")).map(b=>b.dataset.settingsTab).join(",")==="general,model,environment,license"&&!!document.querySelector(\'[data-settings-panel="environment"] #taskKeepRunning\')'))
  /* 2026-10-17 起高级配置内收为内置默认：权限/工具白名单/补跑/限额都不在界面上了 */
  await driver.click('#taskNew');ok('新建界面不再暴露权限/工具/补跑',await driver.evaluate('!document.getElementById("taskPermission")&&!document.getElementById("taskTools")&&!document.getElementById("taskCatchUp")&&!document.querySelector(".task-advanced")'))
  ok('默认保存即启用',await driver.evaluate('document.getElementById("taskEnabled").checked===true'))
  ok('新建为独立居中弹窗且背景不可操作',await driver.evaluate('document.getElementById("taskDialog").parentElement===document.body && document.getElementById("app").inert && getComputedStyle(document.getElementById("taskDialog")).position==="fixed"'))
  ok('每天只显示时间（星期与间隔都藏着）',await driver.evaluate('document.getElementById("taskWeekdayLabel").hidden && document.getElementById("taskIntervalLabel").hidden'))
  await driver.evaluate('document.getElementById("taskCancel").focus();true');await driver.keypress('TAB');ok('Tab 焦点限制在弹窗内部',await driver.evaluate('document.activeElement.id==="taskCloseEditor"'))
  await driver.evaluate('applyTheme("light");true');await sleep(250);fs.writeFileSync(path.join(os.tmpdir(),'task-dialog-light.png'),Buffer.from(await driver.screenshot(),'base64'))
  await driver.keypress('ESC');ok('Escape 只关闭弹窗并恢复新建按钮焦点',await driver.evaluate('document.getElementById("taskDialog").classList.contains("hidden") && !document.getElementById("capabilityCenter").classList.contains("hidden") && document.activeElement.id==="taskNew"'))
  await driver.click('#taskNew')
  await driver.input('#taskName','每日巡检');await driver.input('#taskPrompt','检查当前项目并汇总');
  /* 保存按钮靠 input 事件解禁；CDP 的 insertText 不一定冒泡出 input，这里补一刀 */
  await driver.evaluate('["taskName","taskPrompt"].forEach(function(id){document.getElementById(id).dispatchEvent(new Event("input"))});true')
  /* 重复方式与单位都改成分段按钮了 */
  await driver.evaluate('document.querySelector(\'[data-task-kind="interval"]\').click();document.getElementById("taskMinutes").value="5";document.querySelector(\'[data-task-unit="1"]\').click();document.getElementById("taskEnabled").checked=true;true')
  ok('分段按钮真的改写了规则（间隔 5 分钟）',await driver.evaluate('document.getElementById("taskRule").value==="interval"&&document.getElementById("taskIntervalUnit").value==="1"&&!document.getElementById("taskIntervalLabel").hidden'))
  await driver.click('#taskSave');
  await wait(()=>driver.evaluate('document.querySelectorAll("#taskList .scheduled-task").length===1'),'saved')
  let state=(await request('GET',base+'/api/tasks')).data;const id=state.tasks[0].id
  ok('保存后持久化定义与下次执行时间',state.tasks[0].enabled&&state.tasks[0].nextAt>Date.now()&&fs.existsSync(path.join(home,'tasks','tasks.json')))
  ok('新建表单收起并恢复焦点',await driver.evaluate('document.getElementById("taskEditor").classList.contains("hidden") && document.activeElement.id==="taskNew"'))
  ok('任务概览使用卡片网格',await driver.evaluate('getComputedStyle(document.getElementById("taskList")).display==="grid" && document.querySelectorAll(".task-card-footer").length===1 && document.getElementById("taskHistory").classList.contains("hidden")'))
  await sleep(200)
  ok('任务开关复用统一组件且开启圆点不越界',await driver.evaluate('(function(){const b=document.querySelector(".task-switch"),k=b.querySelector(".plugin-switch-knob"),r=b.getBoundingClientRect(),q=k.getBoundingClientRect();return b.classList.contains("plugin-switch")&&b.classList.contains("on")&&q.left>=r.left&&q.right<=r.right&&q.top>=r.top&&q.bottom<=r.bottom})()'))
  await driver.click('.task-switch');await wait(()=>driver.evaluate('document.querySelector(".task-switch").getAttribute("aria-checked")==="false"&&!document.querySelector(".task-switch").disabled'),'switch off')
  ok('单个开关暂停保存且关闭圆点不越界',!(await request('GET',base+'/api/tasks')).data.tasks[0].enabled&&await driver.evaluate('(function(){const b=document.querySelector(".task-switch"),r=b.getBoundingClientRect(),q=b.querySelector(".plugin-switch-knob").getBoundingClientRect();return !b.classList.contains("on")&&q.left>=r.left&&q.right<=r.right})()'))
  await driver.click('.task-switch');await wait(()=>driver.evaluate('document.querySelector(".task-switch").getAttribute("aria-checked")==="true"&&!document.querySelector(".task-switch").disabled'),'switch on')
  await driver.click('[data-task-filter="paused"]');ok('状态筛选隐藏不匹配任务',await driver.evaluate('document.querySelectorAll("#taskList .scheduled-task").length===0'));await driver.click('[data-task-filter="all"]')
  await driver.click('#taskBatch');await driver.click('#taskSelectAll');await driver.click('#taskBatchPause');await wait(async()=> !(await request('GET',base+'/api/tasks')).data.tasks[0].enabled,'batch pause');ok('批量暂停保存真实状态',true)
  await wait(()=>driver.evaluate('document.querySelector(".task-switch").getAttribute("aria-checked")==="false"'),'paused UI');await driver.click('#taskSelectAll');await driver.click('#taskBatchEnable');await wait(async()=> (await request('GET',base+'/api/tasks')).data.tasks[0].enabled,'batch enable');await driver.click('#taskBatchCancel')
  await sleep(200);fs.writeFileSync(path.join(os.tmpdir(),'task-cards-light.png'),Buffer.from(await driver.screenshot(),'base64'));await driver.evaluate('applyTheme("dark");true');await sleep(250);fs.writeFileSync(path.join(os.tmpdir(),'task-cards-dark.png'),Buffer.from(await driver.screenshot(),'base64'))
  await driver.evaluate('Array.from(document.querySelectorAll("#taskList button")).find(b=>b.textContent==="立即运行").click();true')
  await wait(async()=> (await request('GET',base+'/api/tasks')).data.runs.some(r=>r.status==='completed'),'run completion')
  await wait(()=>driver.evaluate('document.getElementById("taskRuns").textContent.includes("成功")'),'SSE update')
  state=(await request('GET',base+'/api/tasks')).data;const run=state.runs[0]
  ok('立即运行调用真实主循环并显示成功摘要',calls===2&&run.summary.includes('巡检完成')&&run.trigger==='manual')
  ok('独立任务会话在侧边栏有状态',await driver.evaluate('Array.from(document.querySelectorAll("#chatList .flat-name")).some(x=>x.textContent==="每日巡检") && document.querySelector("#chatList .state-completed")!==null'))
  await driver.click('#taskViewRuns')
  ok('运行记录移除冗余标题和操作且隐藏批量管理',await driver.evaluate('!document.getElementById("taskRefresh")&&!document.getElementById("taskStopAll")&&!document.querySelector("#taskRuns h3")&&getComputedStyle(document.getElementById("taskBatch")).display==="none"'))
  ok('任务区域与能力中心标题左右对齐',await driver.evaluate('(()=>{const a=document.getElementById("capTasks").getBoundingClientRect(),b=document.querySelector(".capability-heading").getBoundingClientRect();return Math.abs(a.left-b.left)<2&&Math.abs(a.right-b.right)<2})()'))
  ok('长记录只滚动内容并保持顶部位置',await driver.evaluate('(()=>{const list=document.getElementById("taskRuns"),toolbar=document.querySelector(".tasks-toolbar"),top=toolbar.getBoundingClientRect().top;const filler=document.createElement("div");filler.style.height="3000px";list.appendChild(filler);list.scrollTop=500;const good=list.scrollTop===500&&list.scrollHeight>list.clientHeight&&toolbar.getBoundingClientRect().top===top&&document.getElementById("capTasks").scrollTop===0;filler.remove();list.scrollTop=0;return good})()'))
  /* 运行记录现在是紧凑列表行：整行可点开关联会话 */
  ok('运行记录是紧凑行不是大卡片',await driver.evaluate('document.querySelectorAll(".task-run-row").length>=1&&document.querySelectorAll(".task-run").length===0'))
  await driver.evaluate('document.querySelector("#taskRuns .task-run-row").click();true');await wait(()=>driver.evaluate('document.getElementById("messagesInner").textContent.includes("定时巡检完成")'),'conversation')
  ok('点运行记录行可进入完整独立会话',await driver.evaluate('currentSession().id==='+JSON.stringify(run.sessionId)+' && document.getElementById("capabilityCenter").classList.contains("hidden")'))
  ok('无界面运行的工具步骤从持久化事实恢复',await driver.evaluate('Array.from(document.querySelectorAll(".tl-title")).some(x=>x.textContent.includes("hello.txt")) && document.querySelectorAll(".tl-output").length>0'))
  const invalid=await request('POST',base+'/api/tasks',{...state.tasks[0],permission:'full'});ok('接口强制拒绝无人值守完全访问',invalid.status===400)
  await stop();await start();const loaded=(await request('GET',base+'/api/tasks')).data;ok('服务重启恢复任务和运行记录且不重复执行',loaded.tasks.length===1&&loaded.runs[0].id===run.id&&calls===2)
  const conversation=(await request('GET',base+'/api/tasks/conversation?runId='+encodeURIComponent(run.id))).data;ok('重启后完整结果仍在磁盘',conversation.session.messages.some(m=>m.role==='assistant'&&String(m.content||'').includes('巡检完成')))
  const other=(await request('POST',base+'/api/tasks',{...loaded.tasks[0],id:undefined,name:'保留任务',enabled:false})).data.task
  await driver.evaluate('openCapabilities("tasks");document.getElementById("capTabTasks").click();true');await wait(()=>driver.evaluate('document.querySelectorAll("#taskList .scheduled-task").length===2'),'two cards');await driver.click('#taskViewTasks')
  await driver.click('#taskBatch');await driver.click('input[aria-label="选择 每日巡检"]');await driver.click('#taskBatchDelete');await wait(()=>driver.evaluate('!document.getElementById("confirmModal").classList.contains("hidden")'),'delete confirmation');await driver.click('#confirmOk');await wait(async()=> (await request('GET',base+'/api/tasks')).data.tasks.length===1,'bulk delete')
  const remaining=(await request('GET',base+'/api/tasks')).data;ok('批量删除仅影响选中任务并保留历史',remaining.tasks[0].id===other.id&&remaining.runs.length===1)
  await request('POST',base+'/api/tasks/delete',{id:other.id});const deleted=(await request('GET',base+'/api/tasks')).data;ok('删除任务保留运行记录',deleted.tasks.length===0&&deleted.runs.length===1)
  await driver.open(base);await wait(()=>driver.evaluate('typeof state!=="undefined" && window.scheduledTasks'),'reload');await driver.evaluate('openCapabilities("tasks");document.getElementById("capTabTasks").click();true');await sleep(200);fs.writeFileSync(path.join(temp,'tasks.png'),Buffer.from(await driver.screenshot(),'base64'))
  console.log('Tasks real Chromium/API: '+passed+' checks passed')
 }catch(error){console.error(logs.slice(-2000));throw error}finally{await driver.close();await stop().catch(()=>{});await new Promise(r=>model.close(r));fs.rmSync(temp,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
