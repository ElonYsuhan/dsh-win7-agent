'use strict'
// Portable delivery declaration; filesystem ownership is enforced by the repository.
function declaration(raw){
 if(raw===undefined||raw===null)return {format:'text',name:'',files:[]}
 if(!raw||typeof raw!=='object'||!['text','markdown','json','files'].includes(raw.format))throw Error('请选择有效的交付格式')
 const name=String(raw.name||'').trim();if(name.length>120||/[\\/\x00-\x1f<>:"|?*]/.test(name)||/[. ]$/.test(name))throw Error('产物名称无效')
 const files=raw.format==='files'?(raw.files||[]):[];if(!Array.isArray(files)||files.length>20||raw.format==='files'&&!files.length)throw Error('文件交付需要1～20个文件')
 const result=files.map(f=>{if(!f||typeof f.nodeId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(f.nodeId)||typeof f.path!=='string'||f.path.length>240||f.path.split('/').some(s=>!s||s==='.'||s==='..'||/[\\\x00-\x1f<>:"|?*]/.test(s)))throw Error('交付文件必须使用节点工作目录内的相对路径');return {nodeId:f.nodeId,path:f.path}})
 if(new Set(result.map(f=>f.nodeId+':'+f.path)).size!==result.length)throw Error('交付文件不能重复')
 const field=String(raw.field||'');if(field&&!field.split('.').every(s=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)&&!['__proto__','constructor','prototype'].includes(s)))throw Error('产物字段路径无效');if(field.length>200||field.split('.').length>5)throw Error('产物字段路径过长');return {format:raw.format,name,files:result,field}
}
function records(value){
 if(!Array.isArray(value)||value.length>20)throw Error('产物记录无效')
 for(const a of value)if(!a||typeof a.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(a.id)||typeof a.name!=='string'||!a.name||a.name.length>200||typeof a.file!=='string'||!a.file||a.file.length>200||/[\\/\x00-\x1f]/.test(a.file)||!Number.isSafeInteger(a.size)||a.size<0||a.size>64*1024*1024||typeof a.sha256!=='string'||! /^[a-f0-9]{64}$/.test(a.sha256))throw Error('产物记录无效')
 return value.map(a=>({...a}))
}
function current(run){return run.steps.flatMap(s=>(s.artifacts&&s.artifacts.length?s.artifacts:s.artifact?[{id:s.id,name:s.artifact,file:s.artifact,format:'txt'}]:[]).map(a=>({...a,nodeId:s.id,attempt:s.attempt||1})))}
function filename(node){const spec=declaration(node.deliverable);return (spec.name||node.title||'流程结果').replace(/[\\/\x00-\x1f<>:"|?*]/g,'_').replace(/\.(txt|md|json)$/i,'')+({text:'.txt',markdown:'.md',json:'.json'}[spec.format]||'')}
function planned(workflow){return workflow.nodes.filter(n=>['end','output'].includes(n.type)).flatMap(n=>{const spec=declaration(n.deliverable);return spec.format==='files'?spec.files.map((f,index)=>({nodeId:n.id,index,name:f.path.split('/').pop(),format:f.path.split('.').pop().toLowerCase(),sourceNodeId:f.nodeId,status:'planned'})):[{nodeId:n.id,index:0,name:filename(n),format:{text:'txt',markdown:'md',json:'json'}[spec.format],sourceNodeId:n.id,status:'draft'}]})}
function initial(value,workflow){
 if(!Array.isArray(value)||value.length>2000||new Set(value.map(a=>a&&a.id)).size!==value.length||new Set(value.map(a=>a&&a.nodeId+':'+a.index)).size!==value.length)throw Error('产物计划无效')
 const expected=workflow?planned(workflow):null;if(expected&&expected.length!==value.length)throw Error('产物计划与流程不匹配')
 for(const a of value){if(!a||! /^[a-f0-9]{32}$/.test(a.id)||!['draft','planned'].includes(a.status)||!Number.isInteger(a.index)||a.index<0||a.index>19||typeof a.nodeId!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(a.nodeId)||typeof a.name!=='string'||!a.name||a.name.length>240)throw Error('产物计划无效');if(a.status==='draft'&&(typeof a.file!=='string'||a.file!==a.id+'.'+a.format||!['txt','md','json'].includes(a.format)||a.size!==(a.format==='json'?2:0)||typeof a.sha256!=='string'||! /^[a-f0-9]{64}$/.test(a.sha256)))throw Error('产物草稿记录无效');if(expected&&!expected.some(p=>p.nodeId===a.nodeId&&p.index===a.index&&p.name===a.name&&p.status===a.status&&p.format===a.format))throw Error('产物计划与流程不匹配')}
 return value.map(a=>({...a}))
}
function deliverables(run){return(run.plannedArtifacts||[]).map(item=>{const step=run.steps.find(s=>s.id===item.nodeId),actual=step&&((step.artifacts||[])[item.index]||item.index===0&&step.artifact&&{id:step.id,name:step.artifact,format:'txt'});return step&&step.status==='skipped'?{...item,status:'skipped'}:actual?{...actual,nodeId:item.nodeId,index:item.index,status:'delivered'}:item})}
module.exports={declaration,current,records,filename,planned,initial,deliverables}
