'use strict'
const TYPES=['handle','review','approve'],ID=/^[A-Za-z0-9_-]{1,80}$/
function configuration(raw){
 if(raw===undefined)return undefined
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['version','type','returnTo'].includes(k))||raw.version!==1||!TYPES.includes(raw.type))throw Error('请选择有效的人工交互类型')
 const returnTo=raw.returnTo===undefined?'previous-human':raw.returnTo
 if(typeof returnTo!=='string'||returnTo!=='previous-human'&&!ID.test(returnTo))throw Error('驳回目标无效')
 return{version:1,type:raw.type,returnTo}
}
function modes(node){const config=configuration(node.interaction);if(!config)return Array.isArray(node.humanModes)?node.humanModes:[node.humanKind||'review'];return[config.type==='approve'?'approval':config.type==='review'?'read':'review',...(Array.isArray(node.humanModes)&&node.humanModes.includes('upload')?['upload']:[])]}
function reachable(graph,id,reverse=false){const found=new Set([id]);let changed=true;while(changed){changed=false;for(const edge of graph.edges){const from=reverse?edge.to:edge.from,to=reverse?edge.from:edge.to;if(found.has(from)&&!found.has(to)){found.add(to);changed=true}}}return[...found]}
function affectedOf(run,targetId){const inside=new Set(reachable(run.workflow,targetId));return run.plan.filter(key=>inside.has(key))}
function replayNodes(run,affected){const safe=['start','input','end','output','human','ai','evaluate','template'];return run.steps.filter(step=>affected.includes(step.id)&&(step.attempt||0)>0&&!safe.includes(run.workflow.nodes.find(n=>n.id===step.id).type)).map(s=>s.id)}
function validateReturn(run,event){
 const source=run.steps.find(s=>s.id===event.nodeId),sourceNode=run.workflow.nodes.find(n=>n.id===event.nodeId),target=run.steps.find(s=>s.id===event.targetId),targetNode=run.workflow.nodes.find(n=>n.id===event.targetId)
 if(run.status!=='waiting'||!source||source.status!=='waiting'||source.taskId!==event.taskId||!sourceNode||!sourceNode.interaction||sourceNode.type!=='human'||!['review','approve'].includes(sourceNode.interaction.type))throw Error('人工待办已处理或已过期')
 if(!target||!targetNode||targetNode.type!=='human'||target.id===source.id||target.status!=='succeeded'||!reachable(run.workflow,source.id,true).includes(target.id)||event.targetTaskId!==undefined&&event.targetTaskId!==target.taskId)throw Error('只能驳回已完成的上游人工环节')
 if((target.attempt||0)>=10)throw Error('节点最多允许10次执行尝试')
 if(typeof event.conclusion!=='string'||!event.conclusion.trim()||event.conclusion.length>16000)throw Error('请填写驳回原因（最多16000字）')
 const affected=affectedOf(run,target.id);if(!Array.isArray(event.affected)||JSON.stringify(event.affected)!==JSON.stringify(affected)||!affected.includes(source.id))throw Error('退回影响范围无效')
 return{source,target,affected,replayRequired:replayNodes(run,affected)}
}
module.exports={TYPES,configuration,modes,reachable,affectedOf,replayNodes,validateReturn}
