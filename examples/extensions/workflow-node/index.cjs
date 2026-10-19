'use strict'
module.exports={name:'example.workflow-utils',cordis:true,inject:['workflowNodes'],apply(ctx){
 ctx.effect(()=>ctx.workflowNodes.register({type:'example.normalize',version:'1.0.0',name:'文本规范化',description:'确定性整理空白并转换为大写，不调用模型。'},async({input,signal,onProgress})=>{
  if(signal.aborted)throw Error('ABORTED')
  onProgress('按确定性规则整理文本')
  return String(input).replace(/\s+/g,' ').trim().toUpperCase()
 }))
}}
