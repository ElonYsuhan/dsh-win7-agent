'use strict'
const Interaction=require('../contracts/workflow-interaction'),Branch=require('../contracts/workflow-branch')
function plan(graph){const pending=new Map(graph.nodes.map(n=>[n.id,0])),children=new Map(graph.nodes.map(n=>[n.id,[]]));for(const e of graph.edges){pending.set(e.to,pending.get(e.to)+1);children.get(e.from).push(e.to)}const ready=[...pending].filter(e=>!e[1]).map(e=>e[0]),ordered=[];while(ready.length){const id=ready.shift();ordered.push(id);for(const next of children.get(id)){pending.set(next,pending.get(next)-1);if(!pending.get(next))ready.push(next)}}if(ordered.length!==graph.nodes.length)throw Error('流程存在循环连线');const outputs=graph.nodes.filter(n=>['output','end'].includes(n.type));if(!outputs.length)throw Error('流程至少需要一个结束节点');const needed=new Set();function visit(id){if(needed.has(id))return;needed.add(id);for(const e of graph.edges)if(e.to===id)visit(e.from)}outputs.forEach(n=>visit(n.id));if(graph.nodes.some(n=>['start','end'].includes(n.type))){const starts=graph.nodes.filter(n=>n.type==='start');if(starts.length!==1)throw Error('流程需要且只能有一个开始节点');if(!graph.nodes.some(n=>n.type==='end'))throw Error('流程需要结束节点');const reachable=new Set([starts[0].id]);for(const key of ordered)if(graph.edges.some(e=>e.to===key&&reachable.has(e.from)))reachable.add(key);if([...needed].some(key=>!reachable.has(key)))throw Error('执行路径必须从开始节点连通')}for(const node of graph.nodes)for(const binding of Object.values(node.bindings||{}))if(!descendants(graph,binding.nodeId).includes(node.id))throw Error('输入映射必须来自上游节点');for(const node of outputs)for(const file of node.deliverable&&node.deliverable.files||[])if(!descendants(graph,file.nodeId).includes(node.id))throw Error('产物来源必须是结束节点的上游');for(const node of graph.nodes)if(node.type==='condition')for(const edge of graph.edges.filter(e=>e.from===node.id))if(!needed.has(edge.to))throw Error('每条分支都必须到达结束节点');return ordered.filter(id=>needed.has(id))}
function descendants(graph,id){const found=new Set([id]);let changed=true;while(changed){changed=false;for(const edge of graph.edges)if(found.has(edge.from)&&!found.has(edge.to)){found.add(edge.to);changed=true}}return [...found]}
function mapped(node,steps){const result={};for(const [field,binding]of Object.entries(node.bindings||{})){const source=steps.find(s=>s.id===binding.nodeId);if(!source||source.status!=='succeeded')throw Error('输入映射依赖尚未完成：'+binding.nodeId);result[field]=require('../contracts/workflow-schema').pathValue(source.data===undefined?{text:source.output||''}:source.data,binding.path||'')}return result}
function returnTarget(graph,node,order){const config=Interaction.configuration(node.interaction);if(!config)return null;const upstream=new Set(Interaction.reachable(graph,node.id,true).filter(key=>key!==node.id)),human=order.filter(key=>upstream.has(key)).map(key=>graph.nodes.find(n=>n.id===key)).filter(n=>n.type==='human');if(config.returnTo!=='previous-human')return human.find(n=>n.id===config.returnTo)||null;const handling=human.filter(n=>n.interaction?n.interaction.type==='handle':(n.humanModes||[n.humanKind||'review']).some(mode=>['review','upload'].includes(mode)));return(handling.length?handling:human).slice(-1)[0]||null}
function validateInteractions(graph,order){for(const node of graph.nodes)if(node.interaction&&node.interaction.returnTo!=='previous-human'&&!returnTarget(graph,node,order))throw Error('驳回目标必须是上游人工环节')}
function interactionView(run,node){const config=Interaction.configuration(node.interaction);if(!config)return null;const target=returnTarget(run.workflow,node,run.plan),step=target&&run.steps.find(s=>s.id===target.id);return{type:config.type,canReject:!!target&&!!step&&step.status==='succeeded',...(target?{returnTargetId:target.id,returnTargetTitle:target.title}:{})}}
// Files travel by immutable upload references through all upstream steps, including
// text-only intermediate nodes. Keep branch provenance and remove duplicate refs.
function inputFiles(graph,steps,nodeId,materials=[]){
 const upstream=new Set(),queue=[nodeId]
 while(queue.length){const to=queue.shift();for(const edge of graph.edges)if(edge.to===to&&!upstream.has(edge.from)&&edge.from!==nodeId){upstream.add(edge.from);queue.push(edge.from)}}
 const seen=new Set(materials.map(f=>f.ref)),files=materials.slice()
 for(const step of steps)if((upstream.has(step.id)&&step.status==='succeeded')||(step.id===nodeId&&step.assistance))for(const file of step.files||[])if(!seen.has(file.ref)){seen.add(file.ref);files.push(file)}
 return files
}
function choose(node,data){
 const config=Branch.configuration(node.branch)
 for(const rule of config.cases){
  const present=Object.prototype.hasOwnProperty.call(data,rule.field),value=data[rule.field],empty=!present||value===null||value===''||Array.isArray(value)&&!value.length
  let matches=false
  if(rule.operator==='empty')matches=empty
  else if(rule.operator==='not_empty')matches=!empty
  else{
   if(!present)throw Error('条件字段缺失：'+rule.field)
   if(['gt','gte','lt','lte'].includes(rule.operator)){if(typeof value!=='number'||!Number.isFinite(value))throw Error('条件字段必须是数字：'+rule.field);matches={gt:value>rule.value,gte:value>=rule.value,lt:value<rule.value,lte:value<=rule.value}[rule.operator]}
   else if(['eq','ne'].includes(rule.operator)){if(value!==null&&rule.value!==null&&typeof value!==typeof rule.value)throw Error('条件字段类型不匹配：'+rule.field);matches=rule.operator==='eq'?value===rule.value:value!==rule.value}
   else if(['in','not_in'].includes(rule.operator)){if(value!==null&&!['string','number','boolean'].includes(typeof value))throw Error('集合条件字段必须是简单值');matches=rule.value.includes(value);if(rule.operator==='not_in')matches=!matches}
   else if(rule.operator==='contains'){if(typeof value==='string'&&typeof rule.value==='string')matches=value.includes(rule.value);else if(Array.isArray(value))matches=value.includes(rule.value);else throw Error('包含条件需要文本或数组字段：'+rule.field)}
  }
  if(matches){const outputSlot=config.cases.indexOf(rule);return{id:rule.id,name:rule.name,outputSlot,default:false}}
 }
 return{id:config.default.id,name:config.default.name,outputSlot:config.cases.length,default:true}
}
function activation(graph,steps,node){
 const incoming=graph.edges.filter(edge=>edge.to===node.id),parents=incoming.map(edge=>steps.find(step=>step.id===edge.from))
 if(parents.some(step=>!step||!['succeeded','skipped'].includes(step.status)))return{state:'waiting',incoming:[]}
 const selected=incoming.filter((edge,index)=>Branch.edgeActive(parents[index],edge))
 if(node.type==='merge'&&selected.length>1)throw Error('分支汇合只能接收一条有效路径；并行会签尚未支持')
 return{state:node.type==='merge'?(selected.length?'active':'skipped'):selected.length===incoming.length?'active':'skipped',incoming:selected}
}
module.exports={choose,activation,plan,descendants,mapped,returnTarget,validateInteractions,interactionView,inputFiles}
