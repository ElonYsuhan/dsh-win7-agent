'use strict'
const {id}=require('../contracts/workflows'),Artifacts=require('../contracts/workflow-artifacts')
const terminal=['succeeded','failed','cancelled','interrupted']
function reduce(previous,event){
 if(event.version!==1||!Number.isFinite(event.at)||event.sequence!==(previous?previous.sequence+1:1))throw Error('WORKFLOW_EVENT_INVALID')
 if(!previous){if(event.type!=='created')throw Error('WORKFLOW_FIRST_EVENT');id(event.run.id);return {...event.run,sequence:1,status:'pending',steps:event.run.plan.map(key=>({id:key,title:event.run.workflow.nodes.find(n=>n.id===key).title,status:'pending',timeline:[],attempts:[]}))}}
 if(terminal.includes(previous.status)&&event.type!=='retry-requested')throw Error('WORKFLOW_ALREADY_FINISHED')
 const next={...previous,sequence:event.sequence,steps:previous.steps.map(s=>({...s,timeline:(s.timeline||[]).slice(),attempts:(s.attempts||[]).map(a=>({...a}))}))}
 const step=next.steps.find(s=>s.id===event.nodeId)
 const log=(phase,message,extra={})=>step.timeline.push({at:event.at,phase,message,...extra})
 const attempt=()=>step.attempts[step.attempts.length-1]
 if(event.type==='started'){
  if(previous.status!=='pending')throw Error('WORKFLOW_TRANSITION');next.status='running';next.startedAt=event.at
 }else if(event.type==='pause-requested'){
  if(previous.status!=='running')throw Error('WORKFLOW_TRANSITION');next.pauseRequested=true
 }else if(event.type==='paused'){
  if(previous.status!=='running'||next.steps.some(s=>s.status==='running'))throw Error('WORKFLOW_TRANSITION');next.status='paused';next.pauseRequested=false
 }else if(event.type==='resumed'){
  if(previous.status!=='paused')throw Error('WORKFLOW_TRANSITION');next.status='running';next.pauseRequested=false
 }else if(event.type==='retry-requested'){
  if(!['failed','interrupted','paused','waiting'].includes(previous.status)||!step||!Array.isArray(event.affected)||!event.affected.includes(step.id))throw Error('WORKFLOW_TRANSITION')
  for(const key of event.affected){const item=next.steps.find(s=>s.id===key);if(!item)throw Error('WORKFLOW_NODE_TRANSITION');item.status='pending';delete item.output;delete item.data;delete item.error;delete item.taskId;delete item.waitReason;delete item.artifact;delete item.artifacts;delete item.endedAt;delete item.assistance;item.timeline.push({at:event.at,phase:'run',message:'用户确认重新执行，此步及下游旧结果失效'})}
  next.status='running';next.pauseRequested=false;delete next.endedAt;delete next.error
 }else if(event.type==='node-started'){
  if(!step||previous.status!=='running'||step.status!=='pending')throw Error('WORKFLOW_NODE_TRANSITION')
  if(step.attempts.length>=10)throw Error('节点最多允许10次执行尝试')
  step.status='running';delete step.partial;delete step.partialData;step.startedAt=event.at;step.input=event.input||'';step.inputData=event.data;step.attempt=(step.attempt||0)+1
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
  if(attempt())Object.assign(attempt(),{status:'succeeded',endedAt:event.at,output:event.output,data:event.data})
  if(event.reviewed)log('run','人工确认已审阅资料与历史执行记录')
  log('run','人工已提交'+(event.decision==='reject'?'：不通过':event.decision==='approve'?'：通过':''),{files:step.files,conclusion:event.conclusion})
  log('end','人工处理完成',{conclusion:event.conclusion,output:event.output})
  if(event.pause){next.status='paused';next.pauseRequested=false;next.error='人工未通过，请修改或重试相应步骤后继续'}
 }else if(event.type==='node-finished'){
  if(!step||previous.status!=='running'||step.status!=='running'||!['succeeded','failed','cancelled'].includes(event.status))throw Error('WORKFLOW_NODE_TRANSITION')
  Object.assign(step,{status:event.status,output:event.output||'',error:event.error||'',artifact:event.artifact||'',artifacts:Artifacts.records(event.artifacts||[]),endedAt:event.at});if(event.data!==undefined)step.data=event.data;if(event.sessionId)step.agentSessionId=event.sessionId
  if(attempt())Object.assign(attempt(),{status:event.status,output:event.output||'',data:event.data,error:event.error||'',artifact:event.artifact||'',artifacts:Artifacts.records(event.artifacts||[]),endedAt:event.at,sessionId:event.sessionId||''})
  log('end',event.status==='succeeded'?'节点完成':event.status==='cancelled'?'节点已停止':'节点执行失败',{output:step.output,error:step.error,artifact:step.artifact})
 }else if(event.type==='finished'){
  if(!terminal.includes(event.status))throw Error('WORKFLOW_TERMINAL_INVALID')
  next.status=event.status;next.error=event.error||'';next.endedAt=event.at;next.pauseRequested=false
  for(const item of next.steps){if(['running','waiting'].includes(item.status)){item.status=event.status==='interrupted'?'interrupted':event.status==='cancelled'?'cancelled':'failed';item.endedAt=event.at;if(item.attempts.length)Object.assign(item.attempts[item.attempts.length-1],{status:item.status,endedAt:event.at});item.timeline.push({at:event.at,phase:'end',message:event.error||'执行已停止'})}else if(item.status==='pending')item.status='skipped'}
 }else throw Error('WORKFLOW_EVENT_UNKNOWN')
 return next
}
module.exports={reduce}
