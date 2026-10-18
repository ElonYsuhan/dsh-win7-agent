'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path')
const {definition}=require('../src/main/contracts/tasks')
const {runTransition}=require('../src/main/state/task-state')
const policy=require('../src/main/flow/task-policy'),{blocked}=require('../src/main/flow/unattended-policy')
const {TaskRepository}=require('../src/main/tasks/repository'),{PluginHost}=require('../src/main/plugins/plugin-host')
const {AgentPool}=require('../src/main/agent/agent-pool')
let passed=0
function ok(name,condition){assert(condition,name);console.log('PASS '+name);passed++}
async function wait(fn){for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw new Error('timeout')}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-task-test-')),base={name:'巡检',prompt:'检查文件',rule:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'}}
async function main(){
 try{
  const d=definition(base);ok('默认只读、最小工具白名单、补跑关闭',d.permission==='readonly'&&d.tools.length===3&&!d.catchUp)
  assert.throws(()=>definition({...base,permission:'full'}));assert.throws(()=>definition({...base,tools:['browser_eval']}));assert.throws(()=>definition({...base,rule:{kind:'cron'}}));ok('拒绝完全访问、任意脚本和无效规则',true)
  const now=Date.parse('2026-10-17T00:00:00Z');ok('每日按指定时区计算',policy.next(d.rule,now)===Date.parse('2026-10-17T01:00:00Z'))
  ok('每周与固定间隔计算',policy.next({kind:'weekly',weekday:1,time:'09:00',timezone:'UTC'},now)===Date.parse('2026-10-19T09:00:00Z')&&policy.advance({kind:'interval',minutes:5},0,610000)===900000)
  const spring=policy.next({kind:'daily',time:'02:30',timezone:'America/New_York'},Date.parse('2026-03-08T05:00:00Z'));ok('夏令时不存在的时刻跳过',spring===Date.parse('2026-03-09T06:30:00Z'))
  const hourly={kind:'interval',minutes:60,timezone:'UTC'},weekly={kind:'weekly',weekday:1,time:'09:00',timezone:'UTC'}
  ok('错过补最近一次且限24小时，长期停机不丢近期发生项',policy.due({enabled:true,catchUp:true,rule:hourly,nextAt:now-3600000},now)==='catchup'&&policy.due({enabled:true,catchUp:true,rule:hourly,nextAt:now-90000000},now)==='catchup'&&policy.due({enabled:true,catchUp:true,rule:weekly,nextAt:now-604800000},now)==='skipped'&&policy.due({enabled:true,catchUp:false,rule:hourly,nextAt:now-3600000},now)==='skipped')
  const settings={permissionMode:'workspace',unattended:{tools:['run_command','browser_act'],commands:['npm test'],origins:['https://example.com']}}
  ok('命令精确授权且不能改变cwd',!blocked({name:'run_command',permission:'command'},{command:'npm test'},settings)&&!!blocked({name:'run_command',permission:'command'},{command:'npm test && rm -rf /'},settings)&&!!blocked({name:'run_command',permission:'command'},{command:'npm test',cwd:'..'},settings))
  ok('浏览器脚本与写交互拒绝，来源受检',!!blocked({name:'browser_act',permission:'command'},{action:'click'},settings)&&!!blocked({name:'browser_act',permission:'command'},{action:'open',url:'https://other.com'},settings))
  const r=new TaskRepository(path.join(temp,'repository'));r.open();r.save([{id:'t',version:1}]);r.save([{id:'t',version:2}]);ok('原子快照保留上一份备份',JSON.parse(fs.readFileSync(r.snapshot+'.bak')).tasks[0].version===1)
  assert.throws(()=>new TaskRepository(path.join(temp,'repository')).open(),/LOCKED/);ok('同数据目录拒绝第二个调度所有者',true)
  r.append({version:1,sequence:1,id:'r',taskId:'t',createdAt:now,task:{...d},status:'pending'});r.transition('r',{status:'running'});assert.throws(()=>r.transition('r',{status:'pending'}));r.close()
  fs.appendFileSync(r.log,'{"incomplete":');const restored=new TaskRepository(path.join(temp,'repository'));restored.open();ok('恢复截断尾部并标记运行中为中断',restored.runs.get('r').status==='interrupted');restored.close()
  assert.throws(()=>runTransition(null,{version:1,id:'x',taskId:'t',status:'completed'}));ok('运行记录受版本化状态迁移校验',true)
  const home=path.join(temp,'runtime'),workspace=path.join(temp,'workspace');fs.mkdirSync(home);fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'hello.txt'),'ok')
  const config={data:{workspacePath:workspace,permissionMode:'full',maxConcurrentRuns:4,maxIterations:10,model:'mock'},all(){return this.data},update(p){Object.assign(this.data,p)}}
  const events=[],host=new PluginHost({workspaceRoot:workspace,settings:config});host.loadBuiltins();await host.ready();await host.configure()
  // Replace the selected native model service, exercising the real loop and tool registry.
  let mode='complete',calls=0,hold=null
  await host.replace('core/llm',{name:'core/llm',apply(ctx){ctx.provide('llm',{request:async(request)=>{
    calls++
    if(mode==='output'){request.onDelta({type:'content',text:'x'.repeat(4096)});return {content:'oversize',toolCalls:[]}}
    if(mode==='cancel')return new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(new Error('ABORTED')),{once:true})})
    if(mode==='hold')return new Promise(resolve=>{hold=()=>resolve({content:'完成',toolCalls:[]})})
    if(mode==='deny'&&calls===1)return {content:'',toolCalls:[{id:'denied',type:'function',function:{name:'write_file',arguments:'{"path":"bad.txt","content":"bad"}'}}]}
    return {content:'巡检完成',toolCalls:[]}
  }})}})
  await host.ready()
  const pool=new AgentPool({settings:config,pluginHost:host,sessionRoot:path.join(home,'sessions'),emit:e=>events.push(e),approve:async()=>{throw Error('unattended must not ask')}})
  let time=now;const tasks=host.get('tasks');tasks.attach({home,pool,emit:e=>events.push(e),clock:()=>time,timer:false})
  const task=tasks.save({...base,enabled:true,rule:{kind:'interval',minutes:5,timezone:'UTC'}})
  const manual=tasks.run(task.id);await wait(()=>tasks.list().runs.find(r=>r.id===manual.id).status==='completed')
  ok('真实Cordis/AgentPool无界面执行并持久化会话',fs.existsSync(path.join(pool.sessionDir(manual.sessionId),'last-session.json'))&&tasks.conversation(manual.id).session.messages.some(m=>m.content==='巡检完成'))
  ok('任务设置不污染交互配置',config.data.permissionMode==='full'&&!config.data.unattended)
  mode='deny';calls=0;const denyRun=tasks.run(task.id);await wait(()=>tasks.list().runs.find(r=>r.id===denyRun.id).status==='needs_attention');ok('越权写入被执行边界拦截并记需人工处理',!fs.existsSync(path.join(workspace,'bad.txt'))&&tasks.list().runs.find(r=>r.id===denyRun.id).blockedOperations.length===1)
  mode='hold';calls=0;const running=tasks.run(task.id);await wait(()=>hold!==null);time+=300000;await tasks.tick();ok('上次未完成时定时触发跳过且记录',tasks.list().runs.some(r=>r.status==='skipped'))
  const snap=tasks.list().runs.find(r=>r.id===running.id).task;tasks.save({...task,prompt:'新指令'});ok('运行持有不可变修订快照',snap.prompt==='检查文件')
  hold();await wait(()=>!tasks.list().running);mode='complete';time+=900000;await tasks.tick();ok('默认不补跑并推进下次时间',tasks.list().runs.some(r=>r.trigger==='skipped')&&tasks.list().tasks[0].nextAt>time)
  mode='complete';const scheduledTask=tasks.save({...base,name:'定时触发测试',enabled:true,rule:{kind:'interval',minutes:5,timezone:'UTC'}});time+=300000;await tasks.tick();await wait(()=>tasks.list().runs.some(r=>r.taskId===scheduledTask.id&&r.status==='completed'));ok('到点任务实际派发且标为定时触发',tasks.list().runs.some(r=>r.taskId===scheduledTask.id&&r.trigger==='scheduled'))
  const catchTask=tasks.save({...base,name:'补跑测试',enabled:true,catchUp:true,rule:{kind:'interval',minutes:5,timezone:'UTC'}});time+=3600000;await tasks.tick();await wait(()=>tasks.list().runs.some(r=>r.taskId===catchTask.id&&r.status==='completed'));ok('多次错过仅补一条并推进下一次',tasks.list().runs.filter(r=>r.taskId===catchTask.id&&r.trigger==='catchup').length===1)
  const limited=tasks.save({...base,name:'预算测试',tokenBudget:4096,maxTokens:4096});const priorCalls=calls;const budgetRun=tasks.run(limited.id);await wait(()=>tasks.list().runs.find(r=>r.id===budgetRun.id).status==='failed');ok('预算不足在模型请求前终止',calls===priorCalls&&tasks.list().runs.find(r=>r.id===budgetRun.id).summary.includes('TASK_BUDGET'))
  mode='output';const outputTask=tasks.save({...base,name:'输出测试',outputBytes:1024,failureLimit:1,enabled:true});const outputRun=tasks.run(outputTask.id);await wait(()=>tasks.list().runs.find(r=>r.id===outputRun.id).status==='failed');ok('输出预算与连续失败自动停用生效',!tasks.list().tasks.find(t=>t.id===outputTask.id).enabled&&tasks.list().runs.find(r=>r.id===outputRun.id).summary.includes('TASK_OUTPUT'))
  mode='cancel';const stopTask=tasks.save({...base,name:'停止测试'}),stopRun=tasks.run(stopTask.id);await wait(()=>pool.isRunning(stopRun.sessionId));await new Promise(r=>setTimeout(r,10));tasks.stop(stopTask.id);await wait(()=>tasks.list().runs.find(r=>r.id===stopRun.id).status==='cancelled');ok('停止本次运行传递到真实Agent取消信号',true)
  const deadlineTask=tasks.save({...base,name:'超时测试',timeoutMs:1000}),deadlineRun=tasks.run(deadlineTask.id);await wait(()=>tasks.list().runs.find(r=>r.id===deadlineRun.id).status==='timed_out');ok('单次任务超时强制取消并记录',true)
  await tasks.close();await pool.dispose();await host.dispose()
  ok('插件清理释放数据目录锁',!fs.existsSync(path.join(home,'tasks','owner.json')))
  console.log('Tasks: '+passed+' checks passed')
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
