'use strict'
;(function(){
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
 const copy=value=>JSON.parse(JSON.stringify(value))
 // A legal nested array can expand exponentially. Bound the whole sample, not each level.
 function sample(schema,budget={items:512,chars:32000},depth=0){
  const fail=()=>{throw Error('样例超过自动生成上限，请手工填写较小的模拟数据')}
  if(!schema||--budget.items<0||depth>5)fail()
  const text=value=>{budget.chars-=String(value).length;if(budget.chars<0)fail();return value}
  if(schema.enum)return text(schema.enum[0])
  if(schema.type==='object'){const result={},entries=Object.entries(schema.properties||{});if(entries.length>24)fail();for(const[key,s]of entries){text(key);result[key]=sample(s,budget,depth+1)}return result}
  if(schema.type==='array'){const length=schema.minItems||0;if(!Number.isInteger(length)||length<0||length>100||length>budget.items)fail();return Array.from({length},()=>sample(schema.items,budget,depth+1))}
  if(schema.type==='boolean')return true
  if(['number','integer'].includes(schema.type)){const low=schema.minimum===undefined?-Infinity:schema.minimum,high=schema.maximum===undefined?Infinity:schema.maximum;const min=schema.type==='integer'?Math.ceil(low):low,max=schema.type==='integer'?Math.floor(high):high;if(min>max)fail();return Math.max(min,Math.min(max,0))}
  const min=schema.minLength||0,max=schema.maxLength===undefined?16000:schema.maxLength
  if(!Number.isInteger(min)||!Number.isInteger(max)||min<0||min>max||max>16000||min>budget.chars)fail()
  return text('模拟示例'.repeat(Math.max(1,Math.ceil(min/4))).slice(0,max))
 }
 let active=null
 async function open({workflow}){
  if(active)active.close()
  const previous=document.activeElement,overlay=el('div',undefined,'task-dialog workflow-simulation-dialog'),card=el('section',undefined,'task-editor workflow-simulation-card'),head=el('header',undefined,'task-dialog-heading'),title=el('h2','流程自测'),close=el('button','关闭'),summary=el('p','正在准备模拟数据…','workflow-simulation-status'),body=el('div',undefined,'workflow-simulation-body'),list=el('nav',undefined,'workflow-simulation-list'),detail=el('section',undefined,'workflow-simulation-detail'),actions=el('footer',undefined,'modal-actions'),note=el('p','模拟数据仅用于验证结构与流转，不调用模型、工具或外部接口，不生成真实审批或文件。','muted'),run=el('button','重新验证','primary')
  let closed=false,busy=false,result=null,selected='',reader=null,selectedEntry=null
  const definition=copy(workflow),samples={},sampleErrors={};for(const n of definition.nodes)if(n.type==='human'&&n.inputSchema){try{samples[n.id]=sample(n.inputSchema)}catch(error){sampleErrors[n.id]=error.message}}
  title.id='workflowSimulationTitle';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby',title.id);list.setAttribute('aria-label','模拟步骤');summary.setAttribute('role','status');close.type='button';run.type='button';head.append(title,close);body.append(list,detail);actions.append(run);card.append(head,note,summary,body,actions);overlay.append(card);document.body.append(overlay)
  const api=active={close(){if(closed)return;closed=true;overlay.remove();document.removeEventListener('keydown',escape,true);if(active===api)active=null;if(previous&&previous.isConnected)previous.focus()}}
  const escape=event=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();api.close()}}
  document.addEventListener('keydown',escape,true);close.addEventListener('click',api.close);close.focus()
  function flush(){if(reader&&selectedEntry)samples[selectedEntry.id]=reader()}
  function renderDetail(){
   detail.textContent='';reader=null;selectedEntry=definition.nodes.find(n=>n.id===selected);const record=result&&result.steps.find(s=>s.nodeId===selected);if(!selectedEntry){detail.append(el('h3','验证结果'));for(const issue of result&&result.issues||[])detail.append(el('p',issue.message,'workflow-simulation-issue is-'+issue.severity));return}
   detail.append(el('h3',selectedEntry.title||selectedEntry.id))
   if(sampleErrors[selectedEntry.id])detail.append(el('p',sampleErrors[selectedEntry.id],'workflow-simulation-issue'))
   if(selectedEntry.type==='human'&&selectedEntry.inputSchema){const group=el('section',undefined,'workflow-simulation-sample');group.append(el('p','模拟填写内容，可修改后重新验证。','muted'));reader=window.workflowForms.render(group,selectedEntry.inputSchema,samples[selectedEntry.id],'表单示例');detail.append(group)}
   const issues=(result&&result.issues||[]).filter(i=>i.nodeId===selected||!i.nodeId);for(const issue of issues)detail.append(el('p',issue.message,'workflow-simulation-issue is-'+issue.severity))
   if(record){for(const [key,label]of [['input','模拟输入'],['output','模拟输出'],['envelope','标准数据包']])if(record[key]!==undefined){const section=el('details');section.append(el('summary',label),el('pre',JSON.stringify(record[key],null,2).slice(0,24000)));detail.append(section)}}
  }
  function render(){
   list.textContent='';const steps=result&&result.steps||definition.nodes.map(n=>({nodeId:n.id,title:n.title,status:'pending'}));for(const step of steps){const b=el('button',undefined,'workflow-simulation-step'+(step.nodeId===selected?' selected':''));b.type='button';b.setAttribute('aria-pressed',String(step.nodeId===selected));b.append(el('strong',step.title||step.nodeId),el('small',({passed:'已验证',simulated:'模拟通过',needs_input:'需补充示例',failed:'未通过',error:'未通过',invalid:'数据无效',blocked:'等待上游修正',pending:'待验证'})[step.status]||step.status));b.addEventListener('click',()=>{try{flush();selected=step.nodeId;render()}catch(error){summary.textContent=error.message}});list.append(b)}renderDetail()
  }
  async function execute(){
   if(busy||closed)return
   busy=true;run.disabled=true;summary.textContent='正在模拟验证…'
   try{flush();const next=await window.dsh.workflowRequest('simulate',{workflow:definition,samples});if(closed)return;result=next;selected=selected||((next.issues||[]).find(i=>i.nodeId)||{}).nodeId||(next.steps[0]||{}).nodeId;const count=(next.issues||[]).filter(i=>['error','needs_input'].includes(i.severity)).length;summary.textContent=next.passed?'模拟验证通过 · 业务效果仍需真实运行验证':'模拟验证未通过 · '+count+' 个错误或缺失输入';summary.classList.toggle('is-passed',!!next.passed);render()}catch(error){if(!closed)summary.textContent='无法完成模拟：'+error.message}finally{busy=false;if(!closed)run.disabled=false}
  }
  run.addEventListener('click',execute);await execute();return api
 }
 window.workflowSimulation={open}
})()
