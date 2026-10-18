'use strict'
const {id}=require('../contracts/workflows')
const terminal=['succeeded','failed','cancelled','interrupted']
function reduce(previous,event){
 if(event.version!==1||!Number.isFinite(event.at)||event.sequence!==(previous?previous.sequence+1:1))throw Error('WORKFLOW_EVENT_INVALID')
 if(!previous){if(event.type!=='created')throw Error('WORKFLOW_FIRST_EVENT');id(event.run.id);return {...event.run,sequence:1,status:'pending',steps:event.run.plan.map(key=>({id:key,title:event.run.workflow.nodes.find(n=>n.id===key).title,status:'pending',timeline:[]}))}}
 if(terminal.includes(previous.status))throw Error('WORKFLOW_ALREADY_FINISHED')
 const next={...previous,sequence:event.sequence,steps:previous.steps.map(s=>({...s,timeline:(s.timeline||[]).slice()}))}
 const step=next.steps.find(s=>s.id===event.nodeId)
 const log=(phase,message,extra={})=>step.timeline.push({at:event.at,phase,message,...extra})
 if(event.type==='started'){
  if(previous.status!=='pending')throw Error('WORKFLOW_TRANSITION');next.status='running';next.startedAt=event.at
 }else if(event.type==='node-started'){
  if(!step||previous.status!=='running'||step.status!=='pending')throw Error('WORKFLOW_NODE_TRANSITION')
  step.status='running';step.startedAt=event.at;step.input=event.input||''
  log('start','节点开始，已接收输入',{input:step.input})
 }else if(event.type==='node-progress'){
  if(!step||step.status!=='running'||previous.status!=='running')throw Error('WORKFLOW_NODE_TRANSITION')
  log('run',event.message||'处理中')
 }else if(event.type==='node-waiting'){
  if(!step||step.status!=='running'||previous.status!=='running')throw Error('WORKFLOW_NODE_TRANSITION')
  id(event.taskId);next.status='waiting';step.status='waiting';step.taskId=event.taskId
  log('run','已创建人工待办，等待提交结论')
 }else if(event.type==='node-submitted'){
  if(!step||previous.status!=='waiting'||step.status!=='waiting'||step.taskId!==event.taskId)throw Error('人工待办已处理或已过期')
  next.status='running';step.status='succeeded';step.output=event.output;step.conclusion=event.conclusion;step.decision=event.decision;step.reviewed=event.reviewed===true;step.files=event.files||[];step.endedAt=event.at
  if(event.reviewed)log('run','人工确认已审阅资料与历史执行记录')
  log('run','人工已提交'+(event.decision==='reject'?'：不通过':event.decision==='approve'?'：通过':''),{files:step.files,conclusion:event.conclusion})
  log('end','人工处理完成',{conclusion:event.conclusion,output:event.output})
 }else if(event.type==='node-finished'){
  if(!step||previous.status!=='running'||step.status!=='running'||!['succeeded','failed','cancelled'].includes(event.status))throw Error('WORKFLOW_NODE_TRANSITION')
  Object.assign(step,{status:event.status,output:event.output||'',error:event.error||'',artifact:event.artifact||'',endedAt:event.at})
  log('end',event.status==='succeeded'?'节点完成':event.status==='cancelled'?'节点已停止':'节点执行失败',{output:step.output,error:step.error,artifact:step.artifact})
 }else if(event.type==='finished'){
  if(!terminal.includes(event.status))throw Error('WORKFLOW_TERMINAL_INVALID')
  next.status=event.status;next.error=event.error||'';next.endedAt=event.at
  for(const item of next.steps){if(['running','waiting'].includes(item.status)){item.status=event.status==='interrupted'?'interrupted':event.status==='cancelled'?'cancelled':'failed';item.endedAt=event.at;item.timeline.push({at:event.at,phase:'end',message:event.error||'执行已停止'})}else if(item.status==='pending')item.status='skipped'}
 }else throw Error('WORKFLOW_EVENT_UNKNOWN')
 return next
}
module.exports={reduce}
