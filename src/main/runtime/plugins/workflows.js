'use strict'
const path=require('path'),crypto=require('crypto'),C=require('../../contracts/workflows'),P=require('../../flow/workflow-policy'),Schema=require('../../contracts/workflow-schema'),Templates=require('../../contracts/workflow-templates'),Artifacts=require('../../contracts/workflow-artifacts'),Processing=require('../../contracts/workflow-processing'),Interaction=require('../../contracts/workflow-interaction'),{Repository}=require('../../workflows/repository')
const randomId=()=>crypto.randomBytes(12).toString('hex')
module.exports={name:'core/workflows',inject:['agentConfig','workflowNodes','workflowAgent'],apply(ctx){
 let repo,closed=false,closing=false,emit=()=>{}
 const active=new Map(),jobs=new Set()
 const notify=()=>{try{emit({type:'workflows:changed'})}catch(_){}}
 function ready(){if(closed)throw Error('WORKFLOW_CLOSED');if(!repo){const settings=ctx.agentConfig.settings;if(!settings||!settings.file)throw Error('WORKFLOW_HOME_UNAVAILABLE');const candidate=new Repository(path.dirname(settings.file));candidate.open();repo=candidate}return repo}
 function record(id,event){const result=ready().append(id,event);notify();return result}
 function capacity(){if(closing)throw Error('WORKFLOW_CLOSED');if(active.size>=2)throw Error('工作流最多同时执行2个实例')}
 function resumeExternal(run,raw){
  if(raw.confirmExternal!==true)throw Error('退回后需要重新执行外部操作，请先核查上一次调用与中间结果，再确认继续')
  const key=run.replayGuard?run.replayGuard.nodeId:run.plan.find(id=>run.externalConfirm.includes(id));if(!key)throw Error('没有待确认的外部操作');capacity();const next=record(run.id,{type:'resumed',confirmedExternal:true,confirmedExternalNode:key});launch(next);return{ok:true,external:[key]}
 }
 function launch(run){const controller=new AbortController();active.set(run.id,controller);const job=Promise.resolve().then(()=>execute(run,controller));jobs.add(job);job.catch(e=>console.error('[workflows]',e.message)).finally(()=>jobs.delete(job))}
 async function execute(run,controller){
  let expired=false,totalBytes=0,modelCalls=run.steps.reduce((sum,s)=>sum+(['ai','evaluate','agent'].includes(run.workflow.nodes.find(n=>n.id===s.id).type)?(s.attempt||0):0),0)
  const timer=setTimeout(()=>{expired=true;controller.abort()},10*60*1000)
  try{
   if(run.status==='pending')run=record(run.id,{type:'started'})
   const values=new Map(run.steps.filter(s=>s.status==='succeeded').map(s=>[s.id,s.output||'']))
   totalBytes=[...values.values()].reduce((sum,text)=>sum+Buffer.byteLength(text),0)
   for(const key of run.plan){
    if(values.has(key))continue
    if(controller.signal.aborted)throw Error('ABORTED')
    const current=ready().getRun(run.id)
    if(current.pauseRequested){record(run.id,{type:'paused'});return}
    if(current.externalConfirm&&current.externalConfirm.includes(key)){record(run.id,{type:'external-checkpoint',nodeId:key});return}
    const node=run.workflow.nodes.find(n=>n.id===key),incoming=run.workflow.edges.filter(e=>e.to===key).slice().sort((a,b)=>(a.slot||0)-(b.slot||0)),inputs=Array.from({length:node.inputs?node.inputs.length:2},(_,slot)=>{const edge=incoming.find(e=>(e.slot||0)===slot);return edge?(values.get(edge.from)||''):''}),mapped=P.mapped(node,current.steps)
    let input=incoming.map(e=>values.get(e.from)||'').join('\n')
    if(Object.keys(node.bindings||{}).length){if(node.inputSchema&&node.type!=='human')Schema.validate(mapped,node.inputSchema,'节点输入');input=JSON.stringify(mapped)}
    else if(node.inputSchema&&node.type!=='human')Schema.validate(mapped,node.inputSchema,'节点输入')
    const before=current.steps.find(s=>s.id===key);if(before.assistance)input+='\n\n上次中间结论：'+(before.partial||'')+'\n人工补充：'+before.assistance
    const expected=run.workflow.nodes.flatMap(n=>(n.deliverable&&n.deliverable.files||[]).filter(f=>f.nodeId===key).map(f=>f.path));if(expected.length&&['agent','ai'].includes(node.type))input+='\n\n本步骤必须实际生成以下交付文件（相对于当前工作目录）：'+expected.join('、')+'。不得只描述文件已创建；若没有写文件能力，明确报告无法完成。';
    const started=record(run.id,{type:'node-started',nodeId:key,input,data:mapped}),step=started.steps.find(s=>s.id===key)
    if(node.type==='human'){record(run.id,{type:'node-waiting',nodeId:key,taskId:randomId()});return}
    let text='',artifact='',artifacts=[],resultData,sessionId='',progressCount=0
    try{
     record(run.id,{type:'node-progress',nodeId:key,message:node.type==='agent'?'开始受限 Headless Agent 执行':['ai','evaluate'].includes(node.type)?'已请求当前配置的模型，等待处理结果':['output','end'].includes(node.type)?'正在保存本次实例的结果文件':node.type==='rest'?'正在调用 '+node.rest.method+' 接口（不自动重试）':node.type==='template'?'正在按模板整理上游内容':'正在读取节点输入'})
     if(['ai','evaluate','agent'].includes(node.type)&&++modelCalls>20)throw Error('单次流程最多执行20个模型/Agent节点尝试')
     const resources=run.resources||{skills:{},tools:{}}
     if(resources.nodeVersions&&resources.nodeVersions[node.type]!==String((ctx.workflowNodes.definitions.find(d=>d.type===node.type)||{}).version||'1'))throw Error('节点扩展版本已变更，请创建新实例')
     let workspaceRoot
     if(['agent','tool'].includes(node.type)||run.workflow.nodes.some(n=>(n.deliverable&&n.deliverable.files||[]).some(f=>f.nodeId===key))){sessionId='wf_'+run.id+'_'+crypto.createHash('sha256').update(key+':'+step.attempt).digest('hex').slice(0,16);workspaceRoot=ready().workspace(run.id,key,step.attempt,input,started.steps.flatMap(s=>s.files||[]))}
     const raw=await ctx.workflowNodes.execute({node,input,inputs,signal:controller.signal,settings:ctx.agentConfig.settings.data,resources,workspaceRoot,sessionId,onProgress:(message,extra={})=>{if(progressCount++>=100)return;record(run.id,{type:'node-progress',nodeId:key,message:String(message).slice(0,1000),...(extra.tool?{tool:String(extra.tool).slice(0,80)}:{}),...(extra.result?{result:String(extra.result).slice(0,1500)}:{}),...(extra.sessionId?{sessionId:String(extra.sessionId).slice(0,80)}:{})})}})
     text=typeof raw==='object'&&raw!==null?String(raw.output||''):String(raw)
     if(raw&&raw.sessionId)sessionId=raw.sessionId
     if(controller.signal.aborted)throw Error('ABORTED')
     if(Buffer.byteLength(text)>128*1024)throw Error('节点输出超过128KB')
     totalBytes+=Buffer.byteLength(text);if(totalBytes>1024*1024)throw Error('单次流程累计输出超过1MB')
     if(raw&&raw.needsHuman){record(run.id,{type:'node-waiting',nodeId:key,taskId:randomId(),kind:'agent',reason:String(raw.reason),output:text,sessionId});return}
     resultData=Schema.parse(text,node.outputSchema)
     if(node.type==='evaluate'&&resultData&&['revise','fail'].includes(resultData.verdict)){record(run.id,{type:'node-waiting',nodeId:key,taskId:randomId(),kind:'evaluation',reason:'评估未通过，请人工审阅问题，修改上游或明确给出处理结论',output:text,data:resultData});return}
     if(['output','end'].includes(node.type)){artifacts=ready().deliveries(ready().getRun(run.id),node,text,step.attempt);artifact=artifacts[0].file}
     values.set(key,text);record(run.id,{type:'node-finished',nodeId:key,status:'succeeded',output:text,...(resultData!==null?{data:resultData}:{}),artifact,artifacts,sessionId})
    }catch(error){record(run.id,{type:'node-finished',nodeId:key,status:controller.signal.aborted?'cancelled':'failed',output:String(error.partial||text).slice(0,64000),sessionId:error.sessionId||sessionId,error:error.message});throw error}
   }
   if(ready().getRun(run.id).pauseRequested){record(run.id,{type:'paused'});return}
   record(run.id,{type:'finished',status:'succeeded'})
  }catch(error){record(run.id,{type:'finished',status:controller.signal.aborted&&!expired?'cancelled':'failed',error:expired?'自动执行超过10分钟时限':error.message})}
  finally{clearTimeout(timer);active.delete(run.id)}
 }
 const service={
  attach(fn){emit=typeof fn==='function'?fn:()=>{}},
  list(){const r=ready();return{workflows:r.definitions,runs:Array.from(r.runs.values()).sort((a,b)=>b.createdAt-a.createdAt).map(({steps,workflow,resources,plan,plannedArtifacts,...run})=>({...run,deliveryCount:run.deliveryCount===undefined?(plannedArtifacts||[]).length:run.deliveryCount,artifactCount:run.artifactCount===undefined?steps.reduce((n,s)=>n+(s.artifacts?s.artifacts.length:s.artifact?1:0),0):run.artifactCount,stepCount:steps.length,completed:steps.filter(s=>s.status==='succeeded').length,currentStep:(steps.find(s=>['running','waiting'].includes(s.status))||{}).title||''})),nodes:ctx.workflowNodes.definitions,templates:Templates.catalog,capabilities:ctx.workflowAgent.catalog()}},
  template(raw){return C.validate(Templates.create(raw.id),ctx.workflowNodes.definitions)},
  save(raw){const r=ready(),graph=C.validate(raw,ctx.workflowNodes.definitions);P.validateInteractions(graph,P.plan(graph));const old=r.definitions.find(w=>w.id===graph.id);if(old&&raw.revision!==old.revision)throw Error('流程已被其他窗口修改，请重新打开');if(graph.id&&!old)throw Error('WORKFLOW_NOT_FOUND');if(r.definitions.length>=100&&!old)throw Error('流程数量超过100');const next={...graph,id:graph.id||randomId(),revision:old?old.revision+1:1};const previous=r.definitions;r.definitions=old?r.definitions.map(w=>w.id===old.id?next:w):[...r.definitions,next];try{r.save()}catch(e){r.definitions=previous;throw e}notify();return next},
  remove(raw){const r=ready(),id=C.id(raw.id);if([...r.runs.values()].some(run=>run.workflowId===id&&['pending','running','waiting','paused'].includes(run.status)))throw Error('请先停止正在执行、暂停或等待人工处理的实例');const previous=r.definitions;r.definitions=r.definitions.filter(w=>w.id!==id);try{r.save()}catch(e){r.definitions=previous;throw e}notify();return{ok:true}},
  run(raw){const r=ready(),workflow=r.definitions.find(w=>w.id===C.id(raw.id));if(!workflow)throw Error('WORKFLOW_NOT_FOUND');C.validate(workflow,ctx.workflowNodes.definitions);P.validateInteractions(workflow,P.plan(workflow));if(workflow.nodes.some(n=>['agent','tool'].includes(n.type))&&raw.confirmed!==true)throw Error('请先确认流程步骤、Agent 工具白名单和执行限额');capacity();if(r.runs.size>=2000)throw Error('运行记录达到2000条上限');const resources={...ctx.workflowAgent.snapshot(workflow.nodes),nodeVersions:Object.fromEntries(ctx.workflowNodes.definitions.map(d=>[d.type,String(d.version||'1')]))},id=randomId(),plannedArtifacts=r.drafts(id,workflow),run=record(id,{type:'created',run:{id,plannedArtifacts,workflowId:workflow.id,name:workflow.name,revision:workflow.revision,workflow:JSON.parse(JSON.stringify(workflow)),confirmed:raw.confirmed===true,resources,plan:P.plan(workflow),createdAt:Date.now()}});launch(run);return run},
  submit(raw){
   const r=ready(),run=r.getRun(C.id(raw.id)),step=run&&run.steps.find(s=>s.id===raw.nodeId)
   if(!run||run.status!=='waiting'||!step||step.status!=='waiting'||step.taskId!==raw.taskId)throw Error('人工待办已处理或已过期，请刷新')
   const node=run.workflow.nodes.find(n=>n.id===step.id),agentWait=step.waitKind==='agent',evaluation=step.waitKind==='evaluation',modes=agentWait?['review']:evaluation?['review','approval','read']:C.humanModes(node),interaction=node.type==='human'?node.interaction:undefined
   if(node.type!=='human'&&!agentWait&&!evaluation)throw Error('WORKFLOW_NODE_TRANSITION')
   // 审阅预设只记录一次动作：不再重复勾选确认，也不再强制填写结论。
   const reviewed=raw.reviewed===true||!!(interaction&&interaction.type==='review')
   const payload=C.submission(raw,Processing.requiresConclusion(node,step.waitKind||'human'))
   const view=P.interactionView(run,node)
   // 审阅与审批都可以驳回；驳回必须填写原因，并退回一个已完成的上游人工环节。
   const canReject=!!(interaction&&interaction.type!=='handle'&&view&&view.canReject)
   if(interaction&&payload.decision==='reject'&&!canReject)throw Error(interaction.type==='handle'?'办理环节不能驳回，完成后由后续审阅或审批环节决定':'没有可退回的上游人工办理环节，不能驳回')
   if(!payload.conclusion&&payload.decision!=='reject')payload.conclusion=payload.decision==='approve'?'审批通过':node.inputSchema?'已提交处理表单':'已确认此步骤'
   if(payload.files.length&&!Processing.view(node,step.waitKind||'human').blocks.some(b=>b.type==='attachments'))throw Error('此节点未启用附件处理');
   const reuse=raw.reuseFiles===undefined?[]:raw.reuseFiles;if(!Array.isArray(reuse)||reuse.length>3||reuse.some(ref=>typeof ref!=='string')||new Set(reuse).size!==reuse.length)throw Error('复用附件无效');const reused=reuse.map(ref=>{const file=(step.returnFiles||[]).find(f=>f.ref===ref);if(!file)throw Error('附件不属于当前退回环节');return file});if(reused.length+payload.files.length>3||reused.reduce((sum,f)=>sum+f.size,0)+payload.files.reduce((sum,f)=>sum+Buffer.byteLength(f.data,'base64'),0)>512*1024)throw Error('最多3个附件，总大小不能超过512KB')
   if(modes.includes('upload')&&!payload.files.length&&!reused.length&&payload.decision!=='reject')throw Error('请先上传所需文件')
   if(modes.includes('approval')&&!['approve','reject'].includes(payload.decision))throw Error('请选择通过或驳回')
   if(!modes.includes('approval')&&payload.decision!=='confirm'&&!canReject)throw Error(interaction?'办理环节不能驳回，完成后由后续审阅或审批环节决定':'此节点不支持审批操作')
   if(modes.includes('read')&&!reviewed)throw Error('请确认已审阅资料与历史执行记录')
   const formSchema=agentWait?null:evaluation?node.outputSchema:node.inputSchema
   const returning=interaction&&payload.decision==='reject'
   const formData=formSchema&&!returning?Schema.validate(raw.values,formSchema,'人工表单'):undefined
   if(node.outputSchema&&!agentWait&&!returning)Schema.validate(formData,node.outputSchema,'人工输出')
   capacity()
   // 业务驳回是真实的流程动作：退回目标节点及下游全部回到待处理，历史与产物版本保留。
   if(interaction&&payload.decision==='reject'){
    if(payload.files.length)throw Error('驳回只填写原因，不需要上传附件')
    const target=P.returnTarget(run.workflow,node,run.plan);if(!target)throw Error('找不到可退回的上游人工环节')
    const targetStep=run.steps.find(s=>s.id===target.id)
    const affected=Interaction.affectedOf(run,target.id)
    const check=Interaction.validateReturn(run,{nodeId:step.id,taskId:step.taskId,targetId:target.id,targetTaskId:targetStep&&targetStep.taskId,conclusion:payload.conclusion,affected})
    const next=record(run.id,{type:'node-returned',nodeId:step.id,taskId:step.taskId,targetId:target.id,targetTitle:target.title,conclusion:payload.conclusion,targetTaskId:targetStep&&targetStep.taskId,affected,external:check.replayRequired})
    launch(next);return{ok:true,returnedTo:target.id,returnedToTitle:target.title,external:check.replayRequired}
   }
   const files=reused.concat(r.upload(run.id,step.taskId,payload.files))
   if(agentWait){if(step.attempt>=10)throw Error('节点最多允许10次执行尝试');const assistance=JSON.stringify({conclusion:payload.conclusion,files:files.map(f=>({name:f.name,text:f.text,ref:f.ref}))});const next=record(run.id,{type:'node-assisted',nodeId:step.id,taskId:step.taskId,assistance,conclusion:payload.conclusion,files});launch(next);return{ok:true}}
   const output=formData!==undefined?JSON.stringify(formData):[step.input||'',payload.decision==='reject'?'审批结论：不通过':payload.decision==='approve'?'审批结论：通过':'人工结论：',payload.conclusion,...files.map(f=>'附件：'+f.name+'（'+f.size+'字节）'+(f.text?'\n'+f.text:''))].filter(Boolean).join('\n')
   if(Buffer.byteLength(output)>128*1024)throw Error('提交内容与上游输入合计超过128KB')
   const pause=!interaction&&run.workflow.version===2&&payload.decision==='reject'
   const next=record(run.id,{type:'node-submitted',nodeId:step.id,taskId:step.taskId,conclusion:payload.conclusion,decision:payload.decision,reviewed,files,output,data:formData,pause});if(!pause)launch(next);return{ok:true}
  },
  pause(raw){const run=ready().getRun(C.id(raw.id));if(!run||run.status!=='running'||run.pauseRequested)throw Error('当前实例不能请求暂停');record(run.id,{type:'pause-requested'});return{ok:true}},
  resume(raw){const run=ready().getRun(C.id(raw.id));if(!run||run.status!=='paused'||active.has(run.id))throw Error('实例尚未到达可恢复的暂停点')
   if(run.externalConfirm&&run.externalConfirm.length)return resumeExternal(run,raw)
   if(run.steps.some(s=>s.decision==='reject'&&s.status==='succeeded'))throw Error('请先重试未通过的人工节点并重新确认')
   capacity();const next=record(run.id,{type:'resumed'});launch(next);return{ok:true}},
  retry(raw){const r=ready(),run=r.getRun(C.id(raw.id)),node=run&&run.workflow.nodes.find(n=>n.id===C.id(raw.nodeId));if(!run||!node||active.has(run.id)||!['failed','interrupted','paused','waiting'].includes(run.status))throw Error('当前实例不能重试');const step=run.steps.find(s=>s.id===node.id);if(!step||['pending','skipped'].includes(step.status))throw Error('请选择已执行过的节点');if((step.attempt||0)>=10)throw Error('节点最多允许10次执行尝试');if(['agent','rest','tool'].includes(node.type)&&raw.confirmExternal!==true)throw Error('请先核查外部操作及中间结果，再明确确认重试');capacity();const affected=P.descendants(run.workflow,node.id).filter(key=>run.steps.some(s=>s.id===key)),external=Interaction.replayNodes(run,affected).filter(key=>!(key===node.id&&raw.confirmExternal===true));const next=record(run.id,{type:'retry-requested',nodeId:node.id,affected,external,confirmedExternal:raw.confirmExternal===true});launch(next);return{ok:true}},
  context(raw){
   const r=ready(),run=raw.runId?r.getRun(C.id(raw.runId)):null,workflow=run?run.workflow:r.definitions.find(w=>w.id===C.id(raw.workflowId))
   if(!workflow||raw.runId&&!run||raw.workflowId&&workflow.id!==raw.workflowId)throw Error('流程或实例不存在或引用不匹配')
   const selected=raw.nodeId?workflow.nodes.find(n=>n.id===C.id(raw.nodeId)):null
   if(raw.nodeId&&!selected)throw Error('流程节点不存在')
   const step=selected&&run&&run.steps.find(s=>s.id===selected.id)
   return{workflow:{id:workflow.id,name:workflow.name,revision:run?run.revision:workflow.revision,nodes:workflow.nodes.map(n=>({id:n.id,title:n.title,type:n.type})),edges:workflow.edges},run:run?{id:run.id,status:run.status,createdAt:run.createdAt}:null,node:selected?{...selected,text:selected.text.slice(0,4000)}:null,execution:step?{status:step.status,input:(step.input||'').slice(0,8000),output:(step.output||step.partial||'').slice(0,8000),error:step.error||'',conclusion:step.conclusion||'',files:(step.files||[]).map(f=>({name:f.name,size:f.size,ref:f.ref})),attempt:step.attempt||1}:null,history:run?run.steps.map(s=>({id:s.id,title:s.title,status:s.status,output:(s.output||'').slice(0,500),error:s.error||''})):[]}
  },
  detail(raw){const r=ready();let run=r.getRun(C.id(raw.id));if(!run)throw Error('WORKFLOW_RUN_NOT_FOUND');if(run.plannedArtifacts===undefined)run=record(run.id,{type:'deliveries-initialized',deliverables:r.drafts(run.id,run.workflow)});return{...run,deliverables:Artifacts.deliverables(run),processingViews:Object.fromEntries(run.steps.map(s=>[s.id,Processing.view(run.workflow.nodes.find(n=>n.id===s.id),s.waitKind||'human')])),interactionViews:Object.fromEntries(run.workflow.nodes.filter(n=>n.interaction).map(n=>[n.id,P.interactionView(run,n)])),artifacts:Artifacts.current(run),steps:run.steps.map(s=>s.artifact?{...s,artifactPath:s.artifacts&&s.artifacts.length?path.join(r.dir,'artifacts',run.id,s.artifacts[0].file):r.artifactFile(run.id,s.id,s.attempt||1)}:s)}},
  async artifact(raw){const r=ready(),run=r.getRun(C.id(raw.id));if(!run)throw Error('WORKFLOW_RUN_NOT_FOUND');if(raw.preview){const {item,target}=r.artifactEntry(run,raw.artifactId);return {...await require('../../knowledge/file-preview').preview(target),title:item.name,status:item.status}}return r.readArtifact(run,raw.artifactId,raw.offset===undefined?0:raw.offset)},
  stop(raw){const id=C.id(raw.id),control=active.get(id);if(control)control.abort();else{const run=ready().runs.get(id);if(run&&['waiting','paused'].includes(run.status))record(id,{type:'finished',status:'cancelled',error:'用户停止了流程'})}return{ok:true}},
  async close(){if(closed||closing)return;closing=true;for(const control of active.values())control.abort();await Promise.allSettled([...jobs]);closed=true;if(repo)repo.close()}
 }
 ctx.provide('workflows',service);ctx.effect(()=>()=>service.close())
}}
