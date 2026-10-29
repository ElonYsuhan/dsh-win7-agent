'use strict'
const {id,scheduledTrigger}=require('../contracts/workflows'),Artifacts=require('../contracts/workflow-artifacts'),Interaction=require('../contracts/workflow-interaction')
const Materials=require('../contracts/workflow-materials'),Branch=require('../contracts/workflow-branch')
const terminal=['succeeded','failed','cancelled','interrupted']
function reduce(previous,event){
 if(event.version!==1||!Number.isFinite(event.at)||event.sequence!==(previous?previous.sequence+1:1))throw Error('WORKFLOW_EVENT_INVALID')
 if(!previous){if(event.type!=='created')throw Error('WORKFLOW_FIRST_EVENT');id(event.run.id);if(event.run.trigger)scheduledTrigger(event.run.trigger);if(event.run.materials){Materials.list(event.run.materials);if(event.run.materials.some((f,i)=>f.ref!==event.run.id+'/materials/'+i||typeof f.text!=='string'||f.text.length>16000))throw Error('流程实例资料快照无效')}if(event.run.plannedArtifacts!==undefined)Artifacts.initial(event.run.plannedArtifacts,event.run.workflow);return {...event.run,sequence:1,status:'pending',steps:event.run.plan.map(key=>({id:key,title:event.run.workflow.nodes.find(n=>n.id===key).title,status:'pending',timeline:[],attempts:[]}))}}
 if(terminal.includes(previous.status)&&!['retry-requested','deliveries-initialized'].includes(event.type))throw Error('WORKFLOW_ALREADY_FINISHED')
 const next={...previous,sequence:event.sequence,steps:previous.steps.map(s=>({...s,timeline:(s.timeline||[]).slice(),attempts:(s.attempts||[]).map(a=>({...a}))}))}
 const step=next.steps.find(s=>s.id===event.nodeId)
 const log=(phase,message,extra={})=>step.timeline.push({at:event.at,phase,message,...extra})
 const attempt=()=>step.attempts[step.attempts.length-1]
 if(event.type==='deliveries-initialized'){
  if(previous.plannedArtifacts!==undefined)throw Error('产物计划已初始化');next.plannedArtifacts=Artifacts.initial(event.deliverables,previous.workflow)
 }else if(event.type==='started'){
  if(previous.status!=='pending')throw Error('WORKFLOW_TRANSITION');next.status='running';next.startedAt=event.at
 }else if(event.type==='pause-requested'){
  if(previous.status!=='running')throw Error('WORKFLOW_TRANSITION');next.pauseRequested=true
 }else if(event.type==='paused'){
  if(previous.status!=='running'||next.steps.some(s=>s.status==='running'))throw Error('WORKFLOW_TRANSITION');next.status='paused';next.pauseRequested=false
 }else if(event.type==='resumed'){
  if(previous.status!=='paused')throw Error('WORKFLOW_TRANSITION');next.status='running';next.pauseRequested=false
  if(event.confirmedExternal){if(!previous.externalConfirm||!previous.externalConfirm.includes(event.confirmedExternalNode))throw Error('外部操作确认目标无效');next.externalConfirm=previous.externalConfirm.filter(key=>key!==event.confirmedExternalNode);next.externalConfirmedAt=event.at}
  delete next.replayGuard;delete next.error
 }else if(event.type==='retry-requested'){
  if(!['failed','interrupted','paused','waiting'].includes(previous.status)||!step||!Array.isArray(event.affected)||!event.affected.includes(step.id))throw Error('WORKFLOW_TRANSITION')
  for(const key of event.affected){const item=next.steps.find(s=>s.id===key);if(!item)throw Error('WORKFLOW_NODE_TRANSITION');item.status='pending';delete item.output;delete item.data;delete item.error;delete item.taskId;delete item.waitReason;delete item.artifact;delete item.artifacts;delete item.endedAt;delete item.assistance;delete item.route;delete item.skipReason;item.timeline.push({at:event.at,phase:'run',message:'用户确认重新执行，此步及下游旧结果失效'})}
  // New retries explicitly declare every previously executed external step that
  // must be checked again. Older facts without this field retain replay compatibility.
  if(event.external!==undefined){
   const required=Interaction.replayNodes(previous,event.affected).filter(key=>!(key===step.id&&event.confirmedExternal===true))
   if(JSON.stringify(event.external)!==JSON.stringify(required))throw Error('外部操作重放范围无效')
   const guarded=new Set([...(previous.externalConfirm||[]).filter(key=>!event.affected.includes(key)),...required]);next.externalConfirm=previous.plan.filter(key=>guarded.has(key))
  }
  delete next.replayGuard
  next.status='running';next.pauseRequested=false;delete next.endedAt;delete next.error
 }else if(event.type==='node-skipped'){
  if(!step||previous.status!=='running'||step.status!=='pending')throw Error('WORKFLOW_NODE_TRANSITION')
  const node=previous.workflow.nodes.find(n=>n.id===step.id),incoming=previous.workflow.edges.filter(e=>e.to===step.id),parents=incoming.map(e=>previous.steps.find(s=>s.id===e.from)),selected=incoming.filter((e,i)=>Branch.edgeActive(parents[i],e))
  if(!incoming.length||parents.some(s=>!s||!['succeeded','skipped'].includes(s.status))||(node.type==='merge'?selected.length>0:selected.length===incoming.length))throw Error('不能跳过有效执行路径')
  step.status='skipped';step.skipReason='未选择此分支';step.endedAt=event.at
  for(const key of ['output','data','route','files','taskId','artifact','artifacts'])delete step[key]
  if(next.externalConfirm)next.externalConfirm=next.externalConfirm.filter(key=>key!==step.id)
  log('end','未选择此分支，未执行此节点')
 }else if(event.type==='node-started'){
  if(!step||previous.status!=='running'||step.status!=='pending')throw Error('WORKFLOW_NODE_TRANSITION')
  if(previous.workflow.nodes.some(n=>n.type==='condition')){
   const node=previous.workflow.nodes.find(n=>n.id===step.id),incoming=previous.workflow.edges.filter(e=>e.to===step.id),parents=incoming.map(e=>previous.steps.find(s=>s.id===e.from)),selected=incoming.filter((e,i)=>Branch.edgeActive(parents[i],e))
   if(parents.some(s=>!s||!['succeeded','skipped'].includes(s.status))||(node.type==='merge'?selected.length!==1:selected.length!==incoming.length))throw Error('不能执行未选择或尚未就绪的路径')
  }
  if(step.attempts.length>=10)throw Error('节点最多允许10次执行尝试')
  step.status='running';delete step.partial;delete step.partialData;if(step.returnValues!==undefined)step.partialData=step.returnValues;step.startedAt=event.at;step.input=event.input||'';step.inputData=event.data;step.attempt=(step.attempt||0)+1
  step.attempts.push({number:step.attempt,status:'running',startedAt:event.at,input:step.input})
  log('start','节点开始，已接收输入',{input:step.input,attempt:step.attempt})
 }else if(event.type==='node-progress'){
  if(!step||step.status!=='running'||previous.status!=='running')throw Error('WORKFLOW_NODE_TRANSITION')
  if(event.sessionId)step.agentSessionId=event.sessionId
  log('run',event.message||'处理中',{...(event.result?{output:event.result}:{}),...(event.tool?{tool:event.tool}:{}),...(event.sessionId?{sessionId:event.sessionId}:{})})
 }else if(event.type==='node-waiting'){
  if(!step||step.status!=='running'||previous.status!=='running')throw Error('WORKFLOW_NODE_TRANSITION')
  id(event.taskId);next.status='waiting';next.pauseRequested=false;step.status='waiting';step.taskId=event.taskId;step.waitReason=event.reason||'';step.waitKind=event.kind||'human';if(event.output!==undefined)step.partial=event.output;if(event.data!==undefined)step.partialData=event.data;if(event.sessionId)step.agentSessionId=event.sessionId
  if(attempt())Object.assign(attempt(),{status:'waiting',output:event.output||'',sessionId:event.sessionId||''})
  log('run',event.reason||'已创建人工待办，等待提交结论',{output:event.output||''})
 }else if(event.type==='node-assisted'){
  if(!step||previous.status!=='waiting'||step.status!=='waiting'||step.taskId!==event.taskId||step.waitKind!=='agent')throw Error('人工待办已处理或已过期')
  next.status='running';step.status='pending';step.assistance=event.assistance;step.files=(step.files||[]).concat(event.files||[]);delete step.taskId
  if(attempt())Object.assign(attempt(),{status:'needs_human',endedAt:event.at})
  log('run','人工补充资料后发起新的受限 Agent 执行',{conclusion:event.conclusion,files:event.files||[]})
 }else if(event.type==='node-submitted'){
  if(!step||previous.status!=='waiting'||step.status!=='waiting'||step.taskId!==event.taskId)throw Error('人工待办已处理或已过期')
  next.status='running';step.status='succeeded';step.output=event.output;step.data=event.data;step.conclusion=event.conclusion;step.decision=event.decision;step.reviewed=event.reviewed===true;step.files=event.files||[];step.endedAt=event.at
  if(attempt())Object.assign(attempt(),{status:'succeeded',endedAt:event.at,output:event.output,data:event.data,files:step.files,conclusion:event.conclusion,decision:event.decision,reviewed:event.reviewed===true})
  if(event.reviewed)log('run','人工确认已审阅资料与历史执行记录')
  log('run','人工已提交'+(event.decision==='reject'?'：不通过':event.decision==='approve'?'：通过':''),{files:step.files,conclusion:event.conclusion})
  log('end','人工处理完成',{conclusion:event.conclusion,output:event.output})
  delete step.returnValues;delete step.returnFiles
  if(event.pause){next.status='paused';next.pauseRequested=false;next.error='人工未通过，请修改或重试相应步骤后继续'}
 }else if(event.type==='node-returned'){
  // A business rejection is a flow action, never a technical failure: the returned
  // node and everything downstream of it go back to pending while attempt records,
  // timelines and archived artifact versions stay readable.
  if(!step||previous.status!=='waiting'||step.status!=='waiting'||step.taskId!==event.taskId||['agent','evaluation'].includes(step.waitKind))throw Error('人工待办已处理或已过期')
  const checked=Interaction.validateReturn(previous,event)
  if(JSON.stringify(event.external)!==JSON.stringify(checked.replayRequired))throw Error('外部操作重放范围无效')
  const target=next.steps.find(s=>s.id===event.targetId)
  if(!target||!Array.isArray(event.affected)||!event.affected.length||event.affected.length>2000||!event.affected.includes(step.id))throw Error('WORKFLOW_NODE_TRANSITION')
  next.status='running';next.pauseRequested=false;delete next.endedAt;delete next.error
  const reason=String(event.conclusion||'').slice(0,16000),targetTitle=String(event.targetTitle||target.title||'').slice(0,120)
  if(attempt())Object.assign(attempt(),{status:'returned',endedAt:event.at,decision:'reject',conclusion:reason})
  for(const key of event.affected){
   const item=next.steps.find(s=>s.id===key)
   if(!item)throw Error('WORKFLOW_NODE_TRANSITION')
   item.status='pending'
   if(item.data!==undefined)item.returnValues=item.data
   if(item.files&&item.files.length)item.returnFiles=item.files
   delete item.files
   for(const field of ['output','data','error','taskId','waitReason','waitKind','artifact','artifacts','endedAt','assistance','decision','reviewed','conclusion','partial','partialData','agentSessionId','route','skipReason','returnedTo','returnReason'])delete item[field]
   item.timeline.push({at:event.at,phase:'run',message:key===step.id?'审批驳回，退回“'+targetTitle+'”修改：'+reason:'上游退回，需要重新处理',conclusion:reason})
  }
  step.returnedTo=target.id;step.returnReason=reason
  const guarded=new Set([...(previous.externalConfirm||[]).filter(key=>!event.affected.includes(key)),...checked.replayRequired]);next.externalConfirm=previous.plan.filter(key=>guarded.has(key))
  next.returnedFrom={at:event.at,nodeId:step.id,title:step.title,targetId:target.id,targetTitle,reason}
  log('run','流程已退回“'+targetTitle+'”修改')
}else if(event.type==='external-checkpoint'){
  // Replaying an already executed external call needs an explicit human acknowledgement.
  if(!step||previous.status!=='running'||step.status!=='pending')throw Error('WORKFLOW_NODE_TRANSITION')
  next.status='paused';next.pauseRequested=false;next.replayGuard={nodeId:step.id,title:step.title}
  next.error='退回后需要重新执行外部操作（'+step.title+'），请先核查上一次操作与中间结果，确认后再继续'
  step.timeline.push({at:event.at,phase:'run',message:'等待确认是否重新执行外部操作'})
}else if(event.type==='node-finished'){
  if(!step||previous.status!=='running'||step.status!=='running'||!['succeeded','failed','cancelled'].includes(event.status))throw Error('WORKFLOW_NODE_TRANSITION')
  const definition=previous.workflow.nodes.find(n=>n.id===step.id)
  if(event.status==='succeeded'&&definition.type==='condition')step.route=Branch.selection(definition,event.route)
  else if(event.route!==undefined)throw Error('分支选择只能由条件节点成功事件记录')
  Object.assign(step,{status:event.status,output:event.output||'',error:event.error||'',artifact:event.artifact||'',artifacts:Artifacts.records(event.artifacts||[]),endedAt:event.at});if(event.data!==undefined)step.data=event.data;if(event.sessionId)step.agentSessionId=event.sessionId
  if(attempt())Object.assign(attempt(),{...(step.route?{route:step.route}:{}),status:event.status,output:event.output||'',data:event.data,error:event.error||'',artifact:event.artifact||'',artifacts:Artifacts.records(event.artifacts||[]),endedAt:event.at,sessionId:event.sessionId||''})
  if(step.route)log('run','选择分支：'+step.route.name+(step.route.default?'（默认）':''),{route:step.route})
  log('end',event.status==='succeeded'?'节点完成':event.status==='cancelled'?'节点已停止':'节点执行失败',{output:step.output,error:step.error,artifact:step.artifact})
 }else if(event.type==='finished'){
  if(!terminal.includes(event.status))throw Error('WORKFLOW_TERMINAL_INVALID')
  next.status=event.status;next.error=event.error||'';next.endedAt=event.at;next.pauseRequested=false
  for(const item of next.steps){if(['running','waiting'].includes(item.status)){item.status=event.status==='interrupted'?'interrupted':event.status==='cancelled'?'cancelled':'failed';item.endedAt=event.at;if(item.attempts.length)Object.assign(item.attempts[item.attempts.length-1],{status:item.status,endedAt:event.at});item.timeline.push({at:event.at,phase:'end',message:event.error||'执行已停止'})}else if(item.status==='pending')item.status='skipped'}
 }else throw Error('WORKFLOW_EVENT_UNKNOWN')
 return next
}
module.exports={reduce}
