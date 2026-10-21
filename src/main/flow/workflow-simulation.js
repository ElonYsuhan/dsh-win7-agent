'use strict'
// Pure structural simulation: no registered executor, model, repository or IO.
const C=require('../contracts/workflows'),Schema=require('../contracts/workflow-schema'),Design=require('../contracts/workflow-node-design'),Processing=require('../contracts/workflow-processing'),P=require('./workflow-policy')
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key)
const textLength=schema=>Math.max(schema.minLength||0,Math.min(schema.maxLength===undefined?8:schema.maxLength,8))
function exampleCost(schema,depth=0){
 const cost={values:1,text:0},check=()=>{if(cost.values>512||cost.text>32000)throw Error('模拟样例超过512个值或32000字符预算，请提供精简的输出样例');return cost}
 if(depth>5)throw Error('模拟样例嵌套过深')
 if(!schema)return cost
 if(schema.enum){cost.text=typeof schema.enum[0]==='string'?schema.enum[0].length:0;return check()}
 if(schema.type==='object')for(const [key,child]of Object.entries(schema.properties||{})){const nested=exampleCost(child,depth+1);cost.values+=nested.values;cost.text+=key.length+nested.text;check()}
 else if(schema.type==='array'){
  const length=schema.minItems||0
  if(!Number.isInteger(length)||length<0||length>100)throw Error('模拟样例数组长度无效')
  if(length){const nested=exampleCost(schema.items,depth+1);cost.values+=length*nested.values;cost.text+=length*nested.text}
 }else if(schema.type==='string')cost.text=textLength(schema)
 return check()
}
// Estimate repeated subtree cost before materializing even the first array.
// Schema depth alone cannot bound nested array/object expansion.
function example(schema){exampleCost(schema);return buildExample(schema)}
function buildExample(schema){
 if(!schema)return null
 if(schema.enum)return schema.enum[0]
 if(schema.type==='object')return Object.fromEntries(Object.entries(schema.properties||{}).map(([key,child])=>[key,buildExample(child)]))
 if(schema.type==='array')return Array.from({length:schema.minItems||0},()=>buildExample(schema.items))
 if(schema.type==='boolean')return false
 if(['number','integer'].includes(schema.type)){
  const minimum=schema.minimum===undefined?-Infinity:schema.minimum,maximum=schema.maximum===undefined?Infinity:schema.maximum
  return schema.type==='integer'?Math.max(Math.ceil(minimum),Math.min(Math.floor(maximum),0)):Math.max(minimum,Math.min(maximum,0))
 }
 const length=textLength(schema);return'模拟数据'.repeat(Math.ceil(length/4)).slice(0,length)
}
function joinBounded(parts,separator='\n'){
 const size=parts.reduce((sum,text)=>sum+String(text).length,Math.max(0,parts.length-1)*separator.length)
 if(size>128000)throw Error('模拟节点文本超过128000字符预算，请精简输入或输出样例')
 return parts.join(separator)
}
function templateBounded(text,inputs,input){
 const parts=[];let offset=0;const pattern=/\{\{input(\d*)\}\}/g;let match
 while((match=pattern.exec(text))){parts.push(text.slice(offset,match.index),match[1]?(inputs[Number(match[1])-1]||''):input);offset=pattern.lastIndex}
 parts.push(text.slice(offset));return joinBounded(parts,'')
}
function simulate(raw,types){
 const report={mode:'simulation',passed:false,issues:[],steps:[],summary:'仅验证流程结构、样例数据与交付声明；未调用模型、工具、接口或创建真实产物。'}
 const issue=(nodeId,severity,message)=>report.issues.push({nodeId:nodeId||null,severity,message})
 if(!raw||typeof raw!=='object'||JSON.stringify(raw).length>768000){issue(null,'error','仿真请求无效或超过768000字');return report}
 let workflow,plan
 try{workflow=C.validate(raw.workflow,types);plan=P.plan(workflow);P.validateInteractions(workflow,plan)}catch(error){issue(null,'error',error.message);return report}
 const samples=raw.samples||{},outputs=raw.outputs||{},files=raw.files||{}
 for(const [name,map]of Object.entries({samples,outputs,files}))if(!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).some(id=>!workflow.nodes.some(n=>n.id===id))){issue(null,'error',name+' 必须按本流程节点 ID 提供样例');return report}
 const states=[];let textBudget=1000000
 for(const id of plan){
  const node=workflow.nodes.find(n=>n.id===id),incoming=workflow.edges.filter(e=>e.to===id).sort((a,b)=>(a.slot||0)-(b.slot||0)),sources=incoming.map(edge=>states.find(s=>s.id===edge.from)),row={nodeId:id,title:node.title,type:node.type,status:'simulated',input:null,output:null}
  const state={id,title:node.title,attempt:1,status:'succeeded',input:'',output:'',files:[]}
  if(sources.some(s=>!s||s.status!=='succeeded')){row.status='blocked';state.status='pending';issue(id,'warning','上游样例未通过，暂不验证此节点');row.envelope=Design.envelope(node,state);report.steps.push(row);states.push(state);continue}
  try{
   const inputs=incoming.map(edge=>(states.find(s=>s.id===edge.from)||{}).output||'')
   const combined=joinBounded(inputs),mapped=P.mapped(node,states);if(JSON.stringify(mapped).length>64000)throw Error('模拟输入数据超过64000字符预算');state.input=incoming.length?combined:'';state.inputData=mapped
   if(Object.keys(node.bindings||{}).length)state.input=JSON.stringify(mapped)
   row.input={text:state.input,data:mapped}
   if(node.type==='human'){
    const configured=!!node.inputSchema,provided=own(samples,id),values=provided?samples[id]:mapped
    if(configured&&!provided&&!Object.keys(mapped).length&&(node.inputSchema.required||[]).length){row.status='needs_input';state.status='waiting';issue(id,'needs_input','请为人工表单提供样例：'+(node.inputSchema.required||[]).join('、'))}
    else{
     if(configured)Schema.validate(values,node.inputSchema,'人工表单样例')
     if(node.outputSchema)Schema.validate(configured?values:outputs[id],node.outputSchema,'人工输出样例')
     state.data=configured?values:own(outputs,id)?outputs[id]:undefined;state.output=state.data===undefined?joinBounded([state.input,'模拟审阅完成'].filter(Boolean)):JSON.stringify(state.data)
     state.conclusion='模拟备注：仅验证操作与数据协议';state.reviewed=C.humanModes(node).includes('read');state.decision=C.humanModes(node).includes('approval')?'approve':'confirm'
     const attachments=Processing.view(node).blocks.find(block=>block.type==='attachments')
     if(attachments){
      if(own(files,id)){if(!Array.isArray(files[id])||files[id].length>3||files[id].some(file=>!file||typeof file.name!=='string'||!file.name.trim()||file.name.length>200||!Number.isFinite(file.size)||file.size<0))throw Error('模拟附件最多3个，需有效名称和非负大小');state.files=Design.fileMetadata(files[id]);if(state.files.reduce((sum,f)=>sum+f.size,0)>512*1024)throw Error('模拟附件合计不能超过512KB')}
      else if(C.humanModes(node).includes('upload')||attachments.required)state.files=[{name:'模拟附件.txt',size:0,ref:'simulation://'+id+'/attachment'}]
      if(state.files.length)issue(id,'warning','附件仅使用模拟元数据，未读取或上传真实文件')
     }
    }
   }else if(['start','input'].includes(node.type)){state.output=node.text;row.status='passed'}
   else if(['template','end','output'].includes(node.type)){
    if(node.inputSchema)Schema.validate(mapped,node.inputSchema,'节点输入样例')
    state.output=node.type==='template'&&node.text?templateBounded(node.text,inputs,state.input):state.input
    if(own(outputs,id)){state.data=outputs[id];state.output=typeof state.data==='string'?state.data:JSON.stringify(state.data)}
    if(node.outputSchema)state.data=Schema.parse(state.output,node.outputSchema)
    row.status='passed'
    if(['end','output'].includes(node.type)){
     const delivery=node.deliverable
     if(delivery&&delivery.format==='files'){issue(id,'warning','已校验文件交付来源声明；仿真不会创建或证明实际交付文件存在');row.deliverable={format:'files',files:delivery.files,actualFilesCreated:false}}
     else if(delivery&&delivery.field)Schema.pathValue(JSON.parse(state.output),delivery.field)
     if(delivery&&delivery.format==='json'&&!delivery.field)JSON.parse(state.output)
    }
   }else{
    if(node.inputSchema)Schema.validate(mapped,node.inputSchema,'节点输入样例')
    state.data=own(outputs,id)?outputs[id]:example(node.outputSchema)
    if(node.outputSchema)Schema.validate(state.data,node.outputSchema,'自动节点输出样例')
    state.output=state.data===null?'模拟输出：'+node.title:typeof state.data==='string'?state.data:JSON.stringify(state.data)
    issue(id,'warning',own(outputs,id)?'使用提供的输出样例；未执行真实能力':'使用按 Schema 合成的模拟输出；未执行真实能力')
   }
   joinBounded([state.output],'');textBudget-=state.input.length+state.output.length;if(textBudget<0)throw Error('流程自测累计文本超过1000000字符预算，请精简样例')
   row.output={text:state.output,data:state.data===undefined?null:state.data,files:state.files}
  }catch(error){row.status='invalid';state.status='failed';state.output='';state.data=undefined;issue(id,'error',error.message)}
  row.envelope=Design.envelope(node,state,sources.flatMap(source=>source.files||[]));report.steps.push(row);states.push(state)
 }
 report.passed=!report.issues.some(item=>['error','needs_input'].includes(item.severity))
 return report
}
module.exports={simulate,example}
