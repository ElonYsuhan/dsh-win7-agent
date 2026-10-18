'use strict'
const path=require('path'),crypto=require('crypto'),C=require('../../contracts/workflows'),P=require('../../flow/workflow-policy'),{Repository}=require('../../workflows/repository')
const randomId=()=>crypto.randomBytes(12).toString('hex')
module.exports={name:'core/workflows',inject:['agentConfig','workflowNodes'],apply(ctx){
 let repo,closed=false,closing=false,emit=()=>{}
 const active=new Map(),jobs=new Set()
 const notify=()=>{try{emit({type:'workflows:changed'})}catch(_){}}
 function ready(){if(closed)throw Error('WORKFLOW_CLOSED');if(!repo){const settings=ctx.agentConfig.settings;if(!settings||!settings.file)throw Error('WORKFLOW_HOME_UNAVAILABLE');const candidate=new Repository(path.dirname(settings.file));candidate.open();repo=candidate}return repo}
 function record(id,event){const result=ready().append(id,event);notify();return result}
 function capacity(){if(closing)throw Error('WORKFLOW_CLOSED');if(active.size>=2)throw Error('工作流最多同时执行2个实例')}
 function launch(run){const controller=new AbortController();active.set(run.id,controller);const job=Promise.resolve().then(()=>execute(run,controller));jobs.add(job);job.catch(e=>console.error('[workflows]',e.message)).finally(()=>jobs.delete(job))}
 async function execute(run,controller){
  let expired=false,totalBytes=0,modelCalls=run.steps.filter(s=>s.status==='succeeded'&&['ai','evaluate'].includes(run.workflow.nodes.find(n=>n.id===s.id).type)).length
  const timer=setTimeout(()=>{expired=true;controller.abort()},10*60*1000)
  try{
   if(run.status==='pending')record(run.id,{type:'started'})
   const values=new Map(run.steps.filter(s=>s.status==='succeeded').map(s=>[s.id,s.output||'']))
   totalBytes=[...values.values()].reduce((sum,text)=>sum+Buffer.byteLength(text),0)
   for(const key of run.plan){
    if(values.has(key))continue
    if(controller.signal.aborted)throw Error('ABORTED')
    const node=run.workflow.nodes.find(n=>n.id===key),incoming=run.workflow.edges.filter(e=>e.to===key).slice().sort((a,b)=>(a.slot||0)-(b.slot||0)),inputs=Array.from({length:node.inputs?node.inputs.length:2},(_,slot)=>{const edge=incoming.find(e=>(e.slot||0)===slot);return edge?(values.get(edge.from)||''):''}),input=incoming.map(e=>values.get(e.from)||'').join('\n')
    record(run.id,{type:'node-started',nodeId:key,input})
    if(node.type==='human'){
     record(run.id,{type:'node-waiting',nodeId:key,taskId:randomId()})
     return // Waiting is a durable fact, never a suspended execution Promise.
    }
    let text='',artifact=''
    try{
     record(run.id,{type:'node-progress',nodeId:key,message:['ai','evaluate'].includes(node.type)?'已请求当前配置的模型，等待处理结果':['output','end'].includes(node.type)?'正在保存本次实例的结果文件':node.type==='rest'?'正在调用 '+node.rest.method+' 接口（不自动重试）':node.type==='template'?'正在按模板整理上游内容':'正在读取节点输入'})
     if(['ai','evaluate'].includes(node.type)&&++modelCalls>20)throw Error('单次流程最多调用模型20次')
     text=String(await ctx.workflowNodes.execute({node,input,inputs,signal:controller.signal,settings:ctx.agentConfig.settings.data}))
     if(controller.signal.aborted)throw Error('ABORTED')
     if(Buffer.byteLength(text)>128*1024)throw Error('节点输出超过128KB')
     totalBytes+=Buffer.byteLength(text);if(totalBytes>1024*1024)throw Error('单次流程累计输出超过1MB')
     if(['output','end'].includes(node.type))artifact=ready().artifact(run.id,key,text)
     values.set(key,text);record(run.id,{type:'node-finished',nodeId:key,status:'succeeded',output:text,artifact})
    }catch(error){record(run.id,{type:'node-finished',nodeId:key,status:controller.signal.aborted?'cancelled':'failed',error:error.message});throw error}
   }
   record(run.id,{type:'finished',status:'succeeded'})
  }catch(error){record(run.id,{type:'finished',status:controller.signal.aborted&&!expired?'cancelled':'failed',error:expired?'自动执行超过10分钟时限':error.message})}
  finally{clearTimeout(timer);active.delete(run.id)}
 }
 const service={
  attach(fn){emit=typeof fn==='function'?fn:()=>{}},
  list(){const r=ready();return {workflows:r.definitions,runs:Array.from(r.runs.values()).sort((a,b)=>b.createdAt-a.createdAt).map(({steps,workflow,...run})=>({...run,stepCount:steps.length,completed:steps.filter(s=>s.status==='succeeded').length,currentStep:(steps.find(s=>['running','waiting'].includes(s.status))||{}).title||''})),nodes:ctx.workflowNodes.definitions}},
  save(raw){const r=ready(),graph=C.validate(raw,ctx.workflowNodes.definitions);P.plan(graph);const old=r.definitions.find(w=>w.id===graph.id);if(old&&raw.revision!==old.revision)throw Error('流程已被其他窗口修改，请重新打开');if(graph.id&&!old)throw Error('WORKFLOW_NOT_FOUND');if(r.definitions.length>=100&&!old)throw Error('流程数量超过100');const next={...graph,id:graph.id||randomId(),revision:old?old.revision+1:1};const previous=r.definitions;r.definitions=old?r.definitions.map(w=>w.id===old.id?next:w):[...r.definitions,next];try{r.save()}catch(e){r.definitions=previous;throw e}notify();return next},
  remove(raw){const r=ready(),id=C.id(raw.id);if([...r.runs.values()].some(run=>run.workflowId===id&&['pending','running','waiting'].includes(run.status)))throw Error('请先停止正在执行或等待人工处理的实例');const previous=r.definitions;r.definitions=r.definitions.filter(w=>w.id!==id);try{r.save()}catch(e){r.definitions=previous;throw e}notify();return {ok:true}},
  run(raw){const r=ready(),workflow=r.definitions.find(w=>w.id===C.id(raw.id));if(!workflow)throw Error('WORKFLOW_NOT_FOUND');C.validate(workflow,ctx.workflowNodes.definitions);capacity();if(r.runs.size>=2000)throw Error('运行记录达到2000条上限，当前版本暂不支持继续创建实例');const id=randomId(),run=record(id,{type:'created',run:{id,workflowId:workflow.id,name:workflow.name,revision:workflow.revision,workflow:JSON.parse(JSON.stringify(workflow)),plan:P.plan(workflow),createdAt:Date.now()}});launch(run);return run},
  submit(raw){
   const payload=C.submission(raw),r=ready(),run=r.getRun(raw.id),step=run&&run.steps.find(s=>s.id===raw.nodeId)
   if(!run||run.status!=='waiting'||!step||step.status!=='waiting'||step.taskId!==raw.taskId)throw Error('人工待办已处理或已过期，请刷新')
   const node=run.workflow.nodes.find(n=>n.id===step.id)
   if(node.type!=='human')throw Error('WORKFLOW_NODE_TRANSITION')
   if(C.humanModes(node).includes('upload')&&!payload.files.length)throw Error('请先上传所需文件')
   if(C.humanModes(node).includes('approval')&&!['approve','reject'].includes(payload.decision))throw Error('请选择通过或不通过')
   if(!C.humanModes(node).includes('approval')&&payload.decision!=='confirm')throw Error('此节点不支持审批操作')
   if(C.humanModes(node).includes('read')&&raw.reviewed!==true)throw Error('请确认已审阅资料与历史执行记录')
   capacity()
   const files=r.upload(run.id,step.taskId,payload.files)
   const output=[step.input||'',payload.decision==='reject'?'审批结论：不通过':payload.decision==='approve'?'审批结论：通过':'人工结论：',payload.conclusion,...files.map(f=>'附件：'+f.name+'（'+f.size+'字节）'+(f.text?'\n'+f.text:''))].filter(Boolean).join('\n')
   if(Buffer.byteLength(output)>128*1024)throw Error('提交内容与上游输入合计超过128KB')
   const next=record(run.id,{type:'node-submitted',nodeId:step.id,taskId:step.taskId,conclusion:payload.conclusion,decision:payload.decision,reviewed:raw.reviewed===true,files,output});launch(next);return {ok:true}
  },
  context(raw){
   const r=ready(),run=raw.runId?r.getRun(C.id(raw.runId)):null,workflow=run?run.workflow:r.definitions.find(w=>w.id===C.id(raw.workflowId))
   if(!workflow||raw.runId&&!run||raw.workflowId&&workflow.id!==raw.workflowId)throw Error('流程或实例不存在或引用不匹配')
   const selected=raw.nodeId?workflow.nodes.find(n=>n.id===C.id(raw.nodeId)):null
   if(raw.nodeId&&!selected)throw Error('流程节点不存在')
   const step=selected&&run&&run.steps.find(s=>s.id===selected.id)
   return {workflow:{id:workflow.id,name:workflow.name,revision:run?run.revision:workflow.revision,nodes:workflow.nodes.map(n=>({id:n.id,title:n.title,type:n.type})),edges:workflow.edges},run:run?{id:run.id,status:run.status,createdAt:run.createdAt}:null,node:selected?{...selected,text:selected.text.slice(0,4000)}:null,execution:step?{status:step.status,input:(step.input||'').slice(0,8000),output:(step.output||'').slice(0,8000),error:step.error||'',conclusion:step.conclusion||'',files:(step.files||[]).map(f=>({name:f.name,size:f.size,ref:f.ref}))}:null,history:run?run.steps.map(s=>({id:s.id,title:s.title,status:s.status,output:(s.output||'').slice(0,500),error:s.error||''})):[]}
  },
  detail(raw){const r=ready(),run=r.getRun(C.id(raw.id));if(!run)throw Error('WORKFLOW_RUN_NOT_FOUND');return {...run,steps:run.steps.map(s=>s.artifact?{...s,artifactPath:r.artifactFile(run.id,s.id)}:s)}},
  stop(raw){const id=C.id(raw.id),control=active.get(id);if(control)control.abort();else{const run=ready().runs.get(id);if(run&&run.status==='waiting')record(id,{type:'finished',status:'cancelled',error:'用户停止了人工待办'})}return {ok:true}},
  async close(){if(closed||closing)return;closing=true;for(const control of active.values())control.abort();await Promise.allSettled([...jobs]);closed=true;if(repo)repo.close()}
 }
 ctx.provide('workflows',service);ctx.effect(()=>()=>service.close())
}}
