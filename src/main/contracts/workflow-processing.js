'use strict'
const TYPES=['instructions','reference','form','attachments','conclusion']
function view(node,kind='human'){
 const schema=kind==='evaluation'?node.outputSchema:kind==='agent'?null:node.inputSchema,modes=kind==='evaluation'?['review','approval','read']:kind==='agent'?['review']:Array.isArray(node.humanModes)?node.humanModes:[node.humanKind||'review']
 const raw=kind==='human'?node.processing:null
 if(raw!==undefined&&raw!==null){
  if(!raw||Object.keys(raw).some(k=>!['version','blocks'].includes(k))||raw.version!==1||!Array.isArray(raw.blocks)||raw.blocks.length>12)throw Error('节点处理内容需要 version 1，最多12个内容块')
  const blocks=raw.blocks.map(b=>{if(!b||!TYPES.includes(b.type)||Object.keys(b).some(k=>!['type','title','text','required','source'].includes(k)))throw Error('节点处理内容类型或字段无效');const title=String(b.title||'');if(b.title!==undefined&&typeof b.title!=='string'||title.length>80||b.text!==undefined&&(typeof b.text!=='string'||b.text.length>16000)||b.required!==undefined&&typeof b.required!=='boolean'||b.source!==undefined&&!['input','partial'].includes(b.source))throw Error('节点处理内容参数无效');return{type:b.type,title,...(b.text!==undefined?{text:b.text}:{}),...(b.type==='conclusion'?{required:b.required!==false}:{}),...(b.type==='reference'?{source:b.source||'input'}:{})}})
  for(const type of TYPES.filter(t=>t!=='instructions'&&t!=='reference'))if(blocks.filter(b=>b.type===type).length>1)throw Error('表单、附件和结论内容块各最多一个')
  if(schema&&!blocks.some(b=>b.type==='form')||!schema&&blocks.some(b=>b.type==='form'))throw Error('处理表单内容块必须与输入 Schema 一起配置')
  if(modes.includes('upload')&&!blocks.some(b=>b.type==='attachments'))throw Error('上传处理方式必须包含附件内容块')
  return{version:1,blocks}
 }
 return{version:1,blocks:[{type:'instructions',title:'处理要求'},...(schema?[{type:'form',title:schema.title||'处理表单'}]:[]),{type:'attachments',title:'附件'},{type:'conclusion',title:modes.includes('approval')?'审批意见':'处理结论',required:true}]}
}
function requiresConclusion(node,kind){return view(node,kind).blocks.some(b=>b.type==='conclusion'&&b.required!==false)}
module.exports={TYPES,view,requiresConclusion}
