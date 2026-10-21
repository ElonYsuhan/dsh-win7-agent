'use strict'
// One declarative editor protocol; execution still consumes canonical node fields.
const Schema=require('./workflow-schema'),Interaction=require('./workflow-interaction'),Processing=require('./workflow-processing')
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const clone=value=>JSON.parse(JSON.stringify(value))
const KEYS=['version','instruction','interaction','inputSchema','outputSchema','processing','bindings']
function bounded(raw){
 if(!object(raw)||JSON.stringify(raw).length>128000)throw Error('节点执行设计需要对象，最多128000字')
 const inspect=(value,depth)=>{if(depth>16)throw Error('节点执行设计嵌套过深');if(typeof value==='string'&&/<\s*\/?\s*(?:script|iframe|html|body|input|form|button|style|object|embed)\b|javascript\s*:/i.test(value))throw Error('执行设计只接受声明式数据，不接受 HTML 或脚本');if(object(value)||Array.isArray(value))for(const [key,item]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw Error('节点执行设计字段无效');inspect(item,depth+1)}}
 inspect(raw,0)
}
function nodeIdentity(node){if(!object(node)||typeof node.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(node.id)||typeof node.type!=='string'||!/^[a-z][a-z0-9_.-]{0,79}$/.test(node.type))throw Error('请选择有效的流程节点')}
function bindings(raw,node,workflow){
 const source=raw===undefined?{}:raw
 if(!object(source)||Object.keys(source).length>24)throw Error('输入映射最多24个字段')
 const result={}
 for(const [field,b]of Object.entries(source)){
  if(!Schema.safe(field)||!object(b)||Object.keys(b).some(k=>!['nodeId','path'].includes(k))||typeof b.nodeId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(b.nodeId)||b.nodeId===node.id||b.path!==undefined&&(typeof b.path!=='string'||b.path.length>200||b.path&&b.path.split('.').some(k=>!Schema.safe(k))))throw Error('输入字段映射无效')
  if(workflow){const sourceNode=(workflow.nodes||[]).find(n=>n.id===b.nodeId),upstream=Interaction.reachable(workflow,node.id,true);if(!sourceNode||!upstream.includes(b.nodeId))throw Error('输入映射必须来自本流程上游节点')}
  result[field]={nodeId:b.nodeId,path:b.path||''}
 }
 return result
}
function validate(raw,node,workflow){
 nodeIdentity(node);bounded(raw)
 if(raw.version!==1||Object.keys(raw).some(key=>!KEYS.includes(key)))throw Error('执行设计协议需要 version 1，不能包含自定义动作或代码')
 if(typeof raw.instruction!=='string'||raw.instruction.length>16000)throw Error('节点处理描述最多16000字')
 const inputSchema=Schema.schema(raw.inputSchema),outputSchema=Schema.schema(raw.outputSchema)
 if(inputSchema&&inputSchema.type!=='object')throw Error('节点输入 Schema 根类型必须为 object')
 const mapped=bindings(raw.bindings,node,workflow)
 if(inputSchema&&Object.keys(mapped).some(key=>!Object.prototype.hasOwnProperty.call(inputSchema.properties,key)))throw Error('输入映射字段必须在输入 Schema 中声明')
 const result={version:1,instruction:raw.instruction,interaction:null,inputSchema,outputSchema,processing:null,bindings:mapped}
 if(node.type==='human'){
  result.interaction=Interaction.configuration(raw.interaction||{version:1,type:'review',returnTo:'previous-human'})
  const processing=raw.processing||{version:1,blocks:[{type:'instructions'},...(inputSchema?[{type:'form'}]:[]),{type:'conclusion',title:'备注',required:false}]}
  const modes=[result.interaction.type==='approve'?'approval':result.interaction.type==='review'?'read':'review',...(processing.blocks&&processing.blocks.some(b=>b.type==='attachments'&&b.required===true)?['upload']:[])]
  result.processing=Processing.view({type:'human',interaction:result.interaction,humanModes:modes,inputSchema,processing})
  if(workflow&&result.interaction.returnTo!=='previous-human'){const target=(workflow.nodes||[]).find(n=>n.id===result.interaction.returnTo);if(!target||target.type!=='human'||target.id===node.id||!Interaction.reachable(workflow,node.id,true).includes(target.id))throw Error('驳回目标必须是上游人工节点')}
 }else if(raw.interaction!==undefined&&raw.interaction!==null||raw.processing!==undefined&&raw.processing!==null)throw Error('自动节点不能配置人工审批或表单动作，也不能改变节点类型')
 return result
}
function fromNode(node){
 nodeIdentity(node)
 const modes=Interaction.modes(node)
 let processing=null,interaction=null
 if(node.type==='human'){
  interaction=node.interaction||{version:1,type:modes.includes('approval')?'approve':modes.includes('read')?'review':'handle',returnTo:'previous-human'}
  // Preserve legacy required conclusion/upload behavior when opening its designer.
  processing=node.processing||!node.interaction?Processing.view(node):{version:1,blocks:[{type:'instructions'},...(node.inputSchema?[{type:'form'}]:[]),...(modes.includes('upload')?[{type:'attachments',required:true}]:[]),{type:'conclusion',title:'备注',required:false}]}
  processing={...processing,blocks:processing.blocks.map(block=>block.type==='attachments'&&modes.includes('upload')?{...block,required:true}:block)}
 }
 return validate({version:1,instruction:node.text||'',inputSchema:node.inputSchema||null,outputSchema:node.outputSchema||null,bindings:node.bindings||{},interaction,processing},node)
}
function apply(node,raw,workflow){
 const design=validate(raw,node,workflow),result={...clone(node),text:design.instruction,inputSchema:design.inputSchema,outputSchema:design.outputSchema,bindings:design.bindings}
 if(node.type==='human'){result.interaction=design.interaction;result.processing=design.processing;result.humanModes=[design.interaction.type==='approve'?'approval':design.interaction.type==='review'?'read':'review',...(design.processing.blocks.some(b=>b.type==='attachments'&&b.required===true)?['upload']:[])];result.humanKind=result.humanModes[0]}
 return result
}
function fileMetadata(files){return(Array.isArray(files)?files:[]).slice(0,32).map(file=>({name:String(file.name||'').slice(0,200),size:Number.isFinite(file.size)?file.size:0,ref:String(file.ref||'').slice(0,300)}))}
function envelope(node,step,upstreamFiles=[],textLimit=128000){
 nodeIdentity(node)
 const source=step||{}
 return{version:1,nodeId:node.id,attempt:source.attempt||0,status:source.status||'pending',input:{text:String(source.input||'').slice(0,textLimit),data:source.inputData===undefined?null:clone(source.inputData),files:fileMetadata(upstreamFiles)},output:{text:String(source.output===undefined?source.partial||'':source.output).slice(0,textLimit),data:source.data===undefined?(source.partialData===undefined?null:clone(source.partialData)):clone(source.data),files:fileMetadata(source.files)},review:{note:String(source.conclusion||'').slice(0,16000),decision:source.decision||null,reviewed:source.reviewed===true}}
}
module.exports={KEYS,validate,fromNode,apply,envelope,fileMetadata}
