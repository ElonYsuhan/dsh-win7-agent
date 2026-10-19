'use strict'
;(function(){
 const $=id=>document.getElementById(id),page=$('workflowPage');if(!page)return
 const controls={back:$('workflowBack'),save:$('workflowSave')}
 const labels={paused:'已暂停',pending:'等待执行',running:'执行中',waiting:'待人工处理',succeeded:'已结束',failed:'失败',cancelled:'已停止',interrupted:'已中断',skipped:'未执行'}
 const FALLBACK_NODES=[
  {type:'input',name:'文本输入',description:'提供初始文本'},
  {type:'ai',name:'AI 处理',description:'调用当前配置的内网模型'},
  {type:'template',name:'文本整理',description:'用 {{input}}、{{input1}}、{{input2}} 引用上游内容'},
  {type:'output',name:'保存结果',description:'保存本次实例的文本产物'}
 ]
 const PARAM_HINTS={
  agent:'在固定白名单和限额内完成多步任务，不在节点内部请求人工授权。缺少资料或需要判断时转外层人工待办；绑定技能提供专业方法，不扩大权限。',
  tool:'固定调用一个已启用的工具，不请求模型。JSON 参数中的文本支持 {{input}} 引用上游内容。文件访问范围为本实例工作目录。',
  human:'此节点会暂停流程。根据处理方式上传资料、填写判断或审批结论，提交后继续。审批不通过作为业务结论传递，首版不自动回退。',
  input:'提供流程的初始输入文本。',
  start:'流程起点，可填写初始文本或运行目标。',
  end:'流程终点，汇总上游内容并保存为实例产物。',
  rest:'填写 HTTP/HTTPS 接口地址与方法；POST、PUT、PATCH 的节点内容为 JSON 请求体，支持 {{inputN}}，留空发送 {input}。当前不配置接口凭据；失败不自动重试。',
  evaluate:'填写评估标准。使用当前模型给出依据、结论、风险和建议；不代替人工审批。',
  ai:'输入 AI 处理指令；默认自动附加上游输入，也可在指令中用 {{input}}、{{input1}}、{{input2}} 指定引用位置。',
  template:'使用 {{input}} 引用全部上游内容，或用 {{input1}}、{{input2}} 分别引用输入1、输入2端口。',
  output:'将上游汇聚的文本保存为本次执行的产物文件（可留空节点内容）。'
 }
 let data={workflows:[],runs:[],nodes:FALLBACK_NODES.slice()},mode='flows',filter='',activeRun='',editing=null,graph=null,canvas=null,selectedNode=null,refreshing=false,refreshAgain=false,detailSignature='',disposed=false,dirty=false,runSelection='',runDetail=null,pinnedSelection=false,canvasMode='select',panDrag=null
 const taskForms=new Map()
 const humanModes=n=>Array.isArray(n.humanModes)?n.humanModes:[n.humanKind||'review']
 let stepsMode=false
 const api=(action,payload)=>window.dsh.workflowRequest(action,payload)
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
 function notice(text){const el=$('workflowNotice');if(el)el.textContent=text||''}
 function button(text,fn,title){
  const b=node('button',text);b.type='button'
  if(title){b.title=title;b.setAttribute('aria-label',title)}
  b.addEventListener('click',async()=>{if(b.disabled)return;b.disabled=true;try{await fn()}catch(e){notice(e.message)}finally{b.disabled=false}})
  return b
 }
 async function copyText(text){
  if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){await navigator.clipboard.writeText(text);return}
  const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()
 }
 function isLightTheme(){return document.documentElement.getAttribute('data-theme')==='light'}
 function applyNodeTheme(n){
  if(!n)return
  const light=isLightTheme()
  n.color=light?'#e4e4e4':'#2f2f2f'
  n.bgcolor=light?'#ffffff':'#262626'
  n.boxcolor=light?'#888888':'#888888'
 }
 function syncCanvasTheme(){
  if(typeof LiteGraph==='undefined')return
  const light=isLightTheme()
  LiteGraph.NODE_DEFAULT_COLOR=light?'#e4e4e4':'#2f2f2f'
  LiteGraph.NODE_DEFAULT_BGCOLOR=light?'#ffffff':'#262626'
  LiteGraph.NODE_DEFAULT_BOXCOLOR='#888888'
  LiteGraph.NODE_TEXT_COLOR=light?'#252525':'#eeeeee'
  LiteGraph.NODE_TITLE_COLOR=light?'#252525':'#eeeeee'
  LiteGraph.WIDGET_TEXT_COLOR=light?'#252525':'#eeeeee'
  if(canvas){
   canvas.clear_background_color=light?'#f5f5f5':'#1e1e1e'
   canvas.default_link_color=light?'#666666':'#aaaaaa'
  }
  if(graph&&Array.isArray(graph._nodes)){
   for(const n of graph._nodes)applyNodeTheme(n)
   graph.setDirtyCanvas(true,true)
  }
 }
 async function confirmLeaveEditor(){
  if(mode!=='editor'||!dirty)return true
  return Boolean(await window.appDialogs.confirm('当前流程有未保存的修改，确定放弃修改吗？'))
 }
 function hide(){closeArtifact();if(artifactDownload)artifactDownload.abort();
  panDrag=null
  dirty=false
  page.classList.add('hidden')
  $('app').classList.remove('workflows-open')
  $('openWorkflows').removeAttribute('aria-current')
  if(canvas)canvas.stopRendering()
 }
 function open(){
  if(window.knowledgeUI)window.knowledgeUI.hide()
  $('capabilityCenter').classList.add('hidden')
  $('contentFrame').classList.add('hidden')
  $('app').classList.remove('capabilities-open')
  $('openCustomize').removeAttribute('aria-current')
  $('app').classList.add('workflows-open')
  $('openWorkflows').setAttribute('aria-current','page')
  page.classList.remove('hidden')
  notice('')
  if(canvas&&mode==='editor'&&!stepsMode){syncCanvasTheme();canvas.startRendering();requestAnimationFrame(resize)}
  refresh()
 }
 async function refresh(){
  if(disposed||page.classList.contains('hidden'))return
  if(refreshing){refreshAgain=true;return}
  refreshing=true
  try{
   const next=await api('list')
   data={...next,workflows:next.workflows||[],runs:next.runs||[],nodes:(next.nodes&&next.nodes.length)?next.nodes:FALLBACK_NODES.slice()}
   $('workflowCount').textContent=String(data.workflows.length)
   const waitingRuns=new Set(data.runs.filter(run=>run.status==='waiting').map(run=>run.id));for(const key of taskForms.keys())if(!waitingRuns.has(key.split(':')[0]))taskForms.delete(key)
   if(mode==='flows')renderFlows()
   if(mode==='runs')renderRuns()
   if(mode==='detail')await renderDetail()
  }catch(e){notice(e.message)}
  finally{
   refreshing=false
   if(refreshAgain){refreshAgain=false;refresh()}
  }
 }
 function view(next){
  mode=next
  page.classList.toggle('workflow-detail-mode',next==='detail')
  page.classList.toggle('workflow-editor-mode',next==='editor')
  $('workflowMainToolbar').classList.toggle('hidden',next==='editor'||next==='detail')
  $('workflowAI').classList.toggle('hidden',next!=='flows')
  $('workflowTemplate').classList.toggle('hidden',next!=='flows')
  if(next==='editor')$('workflowEditorActions').append(controls.back,controls.save)
  else{$('workflowMainToolbar').prepend(controls.back);$('workflowMainToolbar').append(controls.save)}
  $('workflowCards').classList.toggle('hidden',next!=='flows')
  $('workflowInstances').classList.toggle('hidden',next!=='runs')
  $('workflowRunDetail').classList.toggle('hidden',next!=='detail')
  $('workflowEditor').classList.toggle('hidden',next!=='editor')
  $('workflowSearch').classList.toggle('hidden',next!=='runs'&&next!=='flows')
  $('workflowSearch').placeholder=next==='runs'?'搜索实例名称、编号、步骤或状态':'搜索流程名称'
  $('workflowNew').classList.toggle('hidden',next!=='flows')
  $('workflowAllRuns').classList.toggle('hidden',next==='editor'||next==='detail'||(next==='runs'&&!filter))
  $('workflowAllRuns').textContent=next==='runs'&&filter?'全部实例':'执行实例'
  controls.save.classList.toggle('hidden',next!=='editor')
  controls.back.classList.toggle('hidden',next==='flows')
  const filteredFlow=filter&&data.workflows.find(w=>w.id===filter)
  $('workflowHeading').textContent=next==='editor'?'编辑流程':next==='runs'?(filteredFlow?'执行实例 · '+filteredFlow.name:'执行实例'):next==='detail'?'实例详情':'工作流'
  if(canvas){if(next==='editor'&&!stepsMode)canvas.startRendering();else canvas.stopRendering()}
 }
 function renderFlows(){
  const list=$('workflowCards');list.textContent=''
  const query=$('workflowSearch').value.trim().toLowerCase()
  for(const flow of data.workflows.filter(f=>f.name.toLowerCase().includes(query))){
   const card=node('article',undefined,'workflow-card'),head=node('div',undefined,'workflow-card-head')
   head.append(node('strong',flow.name),node('span','v'+flow.revision,'muted'))
   const instances=data.runs.filter(r=>r.workflowId===flow.id)
   const latest=instances[0]
   const meta=flow.nodes.length+' 个节点 · '+instances.length+' 个执行实例'+(latest?' · 最近：'+(labels[latest.status]||latest.status):'')
   card.append(head,node('p',meta,'muted'))
   const actions=node('div',undefined,'workflow-card-actions')
   actions.append(
    button('▶',async()=>{notice('');const run=await startRun(flow);if(!run)return;filter=flow.id;activeRun=run.id;runSelection='';pinnedSelection=false;detailSignature='';view('detail');await refresh()},'执行 '+flow.name),
    button('☷',()=>{notice('');filter=flow.id;$('workflowSearch').value='';view('runs');renderRuns()},'查看执行实例'),
    button('编辑',()=>{notice('');edit(flow)}),
    button('删除',async()=>{if(await window.appDialogs.confirm('删除流程“'+flow.name+'”？已产生的执行记录仍保留。')){await api('remove',{id:flow.id});if(filter===flow.id)filter='';await refresh()}})
   )
   card.append(actions);list.append(card)
  }
  if(!list.children.length)list.append(node('p',query?'没有匹配的流程':'还没有流程，点击右上角“＋ 新建流程”开始。','muted'))
 }
 function renderRuns(){
  const list=$('workflowInstances');list.textContent=''
  const query=$('workflowSearch').value.trim().toLowerCase()
  for(const run of data.runs.filter(r=>(!filter||r.workflowId===filter)&&[r.id,r.name,labels[r.status],r.currentStep,new Date(r.createdAt).toLocaleString()].join(' ').toLowerCase().includes(query))){
   const row=node('article',undefined,'workflow-run-row'),info=node('div')
   info.append(
    node('strong',run.name),
    node('p',(labels[run.status]||run.status)+' · '+run.completed+'/'+run.stepCount+' 步'+(run.currentStep?' · 当前：'+run.currentStep:'')+' · '+new Date(run.createdAt).toLocaleString(),'muted'),
    node('small',run.id,'muted')
   )
   const actions=node('div',undefined,'workflow-run-actions');if(run.artifactCount)actions.append(button('产物 '+run.artifactCount,async()=>{notice('');activeRun=run.id;runSelection='';pinnedSelection=false;detailSignature='';view('detail');await renderDetail();const section=$('workflowArtifacts');if(section){section.scrollIntoView({block:'nearest'});section.focus()}}));else info.append(node('small','尚未生成产物','muted'));row.append(info,actions);actions.append(button('查看步骤',async()=>{notice('');activeRun=run.id;runSelection='';pinnedSelection=false;detailSignature='';view('detail');await renderDetail()}))
   list.append(row)
  }
  if(!list.children.length)list.append(node('p','暂无匹配的执行实例','muted'))
 }
 function renderArtifacts(result,host){
  const section=node('section',undefined,'workflow-artifacts');section.id='workflowArtifacts';section.tabIndex=-1;section.setAttribute('aria-label','工作流产物');section.append(node('h4','工作流产物'))
  const artifacts=result.artifacts||[]
  if(!artifacts.length)section.append(node('p',['failed','cancelled','interrupted'].includes(result.status)?'流程未完成，尚无最终交付产物。节点中间结果可在上方查看。':'尚未生成。完成结束节点后，最终报告或文件会出现在这里。','muted'))
  if(artifacts.length&&result.status!=='succeeded')section.append(node('p','流程尚未完成，以下为已生成的部分产物。','muted'));
  for(const item of artifacts){const row=node('article',undefined,'workflow-artifact-item'),entry=result.workflow.nodes.find(n=>n.id===item.nodeId);row.append(node('strong',item.name),node('small',(item.format||'文件').toUpperCase()+(item.size!==undefined?' · '+(item.size<1024?item.size+' 字节':(item.size/1024).toFixed(1)+' KB'):'')+' · '+(entry?entry.title:item.nodeId),'muted'));const actions=node('div');actions.append(button('查看',()=>openArtifact(result,item)),button('下载',()=>downloadArtifact(result,item)));row.append(actions);section.append(row)}
  host.append(section)
 }
 let artifactDialog=null,artifactDownload=null
 function closeArtifact(){if(artifactDialog)artifactDialog.close()}
 async function downloadArtifact(result,item,signal){
  if(artifactDownload)throw Error('已有产物正在下载，请稍候');const controller=new AbortController(),cancel=()=>controller.abort();artifactDownload=controller;if(signal){signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()}
  try{return await readArtifactDownload(result,item,controller.signal)}finally{if(signal)signal.removeEventListener('abort',cancel);if(artifactDownload===controller)artifactDownload=null}
 }
 async function readArtifactDownload(result,item,signal){
  const chunks=[];let offset=0,total
  do{if(signal&&signal.aborted)return;const part=await api('artifact',{id:result.id,artifactId:item.id,offset});if(signal&&signal.aborted)return;if(total!==undefined&&part.size!==total||part.offset!==offset||part.next<offset||part.next===offset&&offset<part.size)throw Error('产物读取不完整');total=part.size;offset=part.next;chunks.push(Uint8Array.from(atob(part.bytes),c=>c.charCodeAt(0)))}while(offset<total)
  const url=URL.createObjectURL(new Blob(chunks)),link=node('a');link.href=url;link.download=item.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
 }
 async function openArtifact(result,item){
  closeArtifact();const prior=document.activeElement,dialog=node('dialog',undefined,'workflow-artifact-dialog'),header=node('header'),title=node('h2',item.name),body=node('div',undefined,'panel-preview'),controller=new AbortController();let url=''
  artifactDialog=dialog;title.id='workflowArtifactTitle';dialog.setAttribute('aria-labelledby',title.id)
  header.append(title,button('下载',()=>downloadArtifact(result,item,controller.signal)),button('关闭',()=>dialog.close()));dialog.append(header,body);document.body.append(dialog)
  dialog.addEventListener('close',()=>{controller.abort();if(url)URL.revokeObjectURL(url);dialog.remove();if(artifactDialog===dialog)artifactDialog=null;if(prior&&prior.isConnected)prior.focus()},{once:true});dialog.showModal();body.textContent='正在读取产物…'
  try{const value=await api('artifact',{id:result.id,artifactId:item.id,preview:true});if(controller.signal.aborted)return;const ext=item.name.split('.').pop().toLowerCase();let text=value.text||''
   if(value.bytes){const bytes=Uint8Array.from(atob(value.bytes),c=>c.charCodeAt(0));if(['text','markdown'].includes(value.kind))text=window.filePanel.decodeBytes(bytes).text;else url=URL.createObjectURL(new Blob([bytes],{type:value.mime}))}
   body.textContent='';window.filePreview.render(body,{...value,text,url,name:item.name,ext,kind:value.kind==='text'&&!['txt','log','csv'].includes(ext)?'code':value.kind});if(value.notice)body.append(node('p',value.notice,'muted'))
  }catch(e){if(!controller.signal.aborted)body.textContent=e.message}
 }
 function executionState(step){return step&&step.status==='succeeded'?'done':step&&['running','waiting'].includes(step.status)?'active':step&&['failed','interrupted','cancelled'].includes(step.status)?'error':'pending'}
 function executionLabel(step){return step&&step.status==='waiting'?'执行中 · 待人工处理':step&&step.status==='succeeded'?'已结束':step&&['interrupted','cancelled'].includes(step.status)?labels[step.status]:step&&step.status==='skipped'?'待执行 · 已跳过':step&&step.status==='pending'?'待执行':labels[step&&step.status]||'待执行'}
 function drawExecution(result,host){
  const layout=node('div',undefined,'workflow-execution-layout'),left=node('section',undefined,'workflow-execution-map'),right=node('section',undefined,'workflow-workbench')
  left.setAttribute('aria-label','执行流程图');right.setAttribute('aria-label','节点执行工作台')
  const legend=node('div',undefined,'workflow-state-legend')
  for(const [state,label] of [['done','已结束'],['active','执行中'],['pending','待执行'],['error','失败']])legend.append(node('span',label,'workflow-state-'+state))
  left.append(legend)
  const scroll=node('div',undefined,'workflow-map-scroll'),stage=node('div',undefined,'workflow-map-stage'),positions=new Map(),depth=new Map()
  for(const id of result.plan){const upstream=result.workflow.edges.filter(e=>e.to===id).map(e=>depth.get(e.from)||0);depth.set(id,upstream.length?Math.max(...upstream)+1:0)}
  // Include unconnected nodes as pending; the actual dependency edges remain visible.
  for(const entry of result.workflow.nodes)if(!depth.has(entry.id))depth.set(entry.id,Math.max(0,...depth.values())+1)
  const ranks=new Map();for(const entry of result.workflow.nodes){const rank=depth.get(entry.id);if(!ranks.has(rank))ranks.set(rank,[]);ranks.get(rank).push(entry)}
  const columns=Math.max(1,...[...ranks.values()].map(items=>items.length)),width=Math.max(320,columns*240+40),height=(Math.max(...depth.values())+1)*136+40
  stage.style.width=width+'px';stage.style.height=height+'px'
  for(const [rank,entries] of ranks)entries.forEach((entry,index)=>positions.set(entry.id,{x:(width-entries.length*240)/2+index*240+10,y:rank*136+24}))
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('aria-hidden','true')
  for(const edge of result.workflow.edges){const from=positions.get(edge.from),to=positions.get(edge.to);if(!from||!to)continue;const path=document.createElementNS(svg.namespaceURI,'path'),x=from.x+110,y=from.y+90,tx=to.x+110,ty=to.y;path.setAttribute('d',`M ${x} ${y} C ${x} ${y+24}, ${tx} ${ty-24}, ${tx} ${ty}`);svg.append(path)}
  stage.append(svg)
  for(const entry of result.workflow.nodes){const step=result.steps.find(s=>s.id===entry.id),pos=positions.get(entry.id),state=executionState(step);const card=button('',()=>{runSelection=entry.id;pinnedSelection=true;detailSignature='';renderDetail()},entry.title+' · '+executionLabel(step));card.className='workflow-map-node workflow-state-'+state+(runSelection===entry.id?' selected':'');card.setAttribute('aria-pressed',String(runSelection===entry.id));card.style.left=pos.x+'px';card.style.top=pos.y+'px';card.append(node('strong',entry.title),node('span',executionLabel(step)),node('small',(data.nodes.find(n=>n.type===entry.type)||{}).name||entry.type));stage.append(card)}
  scroll.append(stage);left.append(scroll);layout.append(left,right);host.append(layout)
  requestAnimationFrame(()=>{const selected=positions.get(runSelection);if(selected&&scroll.isConnected){scroll.scrollTop=Math.max(0,selected.y-scroll.clientHeight/3);scroll.scrollLeft=Math.max(0,selected.x-scroll.clientWidth/2+110)}})
  const entry=result.workflow.nodes.find(n=>n.id===runSelection),step=result.steps.find(s=>s.id===runSelection)
  if(!entry){right.append(node('p','选择左侧节点查看执行过程。'));return}
  const propertyHeader=node('header',undefined,'workflow-property-header');propertyHeader.append(node('h3',entry.title),node('p',executionLabel(step),'muted'));right.append(propertyHeader)
  const history=node('details',undefined,'workflow-node-evidence');history.append(node('summary','查看所选节点的输入与结果'));const propertyContent=node('div');history.append(propertyContent)
  if(entry.description)propertyContent.append(node('p',entry.description))
  if(step&&step.attempt)propertyContent.append(node('p','第 '+step.attempt+' 次尝试'+(step.agentSessionId?' · Agent '+step.agentSessionId:''),'muted'))
  if(step&&step.partial)propertyContent.append(node('pre',step.partial))
  if(step&&step.data!==undefined){const details=node('details');details.append(node('summary','结构化结果'),node('pre',JSON.stringify(step.data,null,2)));propertyContent.append(details)}
  if(step&&['failed','interrupted','paused','waiting'].includes(result.status)&&!['pending','skipped'].includes(step.status))propertyContent.append(button('从此步骤重试',async()=>{if(!await window.appDialogs.confirm('从“'+entry.title+'”重新执行？此步及下游的当前结果将失效，历史尝试保留。若涉及工具或外部接口，请先核查中间结果及外部操作是否已完成。'))return;await api('retry',{id:result.id,nodeId:entry.id,confirmExternal:true});pinnedSelection=false;detailSignature='';await refresh()}))
  if(step&&step.input)propertyContent.append(node('pre',step.input));if(step&&step.output)propertyContent.append(node('pre',step.output));if(step&&step.error)propertyContent.append(node('p',step.error,'workflow-error'));for(const file of step&&step.files||[])propertyContent.append(node('p','附件：'+file.name));
  if(step&&step.timeline&&step.timeline.length){const records=node('details'),list=node('ul');records.append(node('summary','执行记录'));for(const fact of step.timeline){const row=node('li',new Date(fact.at).toLocaleTimeString()+' · '+fact.message);if(fact.output)row.append(node('pre',fact.output));list.append(row)}records.append(list);propertyContent.append(records)}
  const task=node('section',undefined,'workflow-current-task'),waiting=result.steps.find(s=>s.status==='waiting'),waitingEntry=waiting&&result.workflow.nodes.find(n=>n.id===waiting.id)
  task.append(node('h4',waiting?'当前待办 · '+waiting.title:'当前待办'))
  for(const key of taskForms.keys())if(key.startsWith(result.id+':')&&(!waiting||key!==result.id+':'+waiting.taskId))taskForms.delete(key)
  if(waiting){
   task.append(button('打开会话分析',()=>window.workflowChat.open({workflowId:result.workflowId,runId:result.id,nodeId:waiting.id,name:result.name,nodeTitle:waiting.title})))
   if(waiting.id!==runSelection){task.append(node('p','正在查看历史节点，当前待办可在此直接处理。','muted'));task.append(button('定位当前节点',()=>{runSelection=waiting.id;pinnedSelection=false;detailSignature='';renderDetail()}))}
   renderHumanForm(result,waitingEntry,waiting,task)
  }else task.append(node('p',result.status==='running'?'系统正在自动处理，无需人工操作。':result.status==='pending'?'等待执行。':'此实例当前没有待办。','muted'))
  if(step&&step.output)propertyContent.append(button('复制结果',()=>copyText(step.output)))
  right.append(task,history);renderArtifacts(result,right)
 }
 function filePayload(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:String(reader.result).split(',')[1]||''});reader.onerror=()=>reject(Error('文件读取失败：'+file.name));reader.readAsDataURL(file)})}
 function renderHumanForm(result,entry,step,task){
  const key=result.id+':'+step.taskId,modes=step.waitKind==='agent'?['review']:step.waitKind==='evaluation'?['review','approval','read']:humanModes(entry)
  if(taskForms.has(key)){task.append(taskForms.get(key));return}
  const content=node('div');task.append(content);task=content;taskForms.set(key,content)
  task.append(node('p',step.waitReason||entry.text||'请查看输入资料并填写处理结论。'))
  task.append(node('p','TXT、Markdown、JSON、CSV 等文本附件提取前16000字传给下游；其他文件仅保存引用，暂不自动解析。','muted'))
  const form=node('form'),schema=step.waitKind==='agent'?null:step.waitKind==='evaluation'?entry.outputSchema:entry.inputSchema,readValues=schema?window.workflowForms.render(form,schema,step.partialData||step.inputData):null,inputLabel=node('label','附件（最多3个，总计512KB）'),files=node('input');files.type='file';files.multiple=true;files.required=modes.includes('upload');inputLabel.append(files)
  const label=node('label',modes.includes('approval')?'审批意见（必填）':'处理结论（必填）'),conclusion=node('textarea');conclusion.rows=4;conclusion.maxLength=16000;conclusion.required=true;label.append(conclusion)
  const error=node('p',undefined,'workflow-error');error.id='workflowTaskError';error.setAttribute('role','alert');conclusion.setAttribute('aria-describedby',error.id);files.setAttribute('aria-describedby',error.id)
  const decision=node('fieldset'),legend=node('legend','审批结论');decision.append(legend)
  if(modes.includes('approval'))for(const [value,title] of [['approve','通过'],['reject','不通过']]){const row=node('label',undefined,'workflow-radio'),radio=node('input');radio.type='radio';radio.name='workflowDecision';radio.value=value;radio.required=true;row.append(radio,document.createTextNode(title));decision.append(row)}
  const reviewed=node('input');reviewed.type='checkbox';reviewed.required=modes.includes('read')
  if(modes.includes('read')){const readLabel=node('label',undefined,'workflow-radio');readLabel.append(reviewed,document.createTextNode('我已审阅资料和相关节点的执行记录'));form.append(readLabel)}
  const submit=node('button',step.waitKind==='agent'?'补充并重新执行 Agent':'提交并继续');submit.type='submit'
  if(modes.includes('approval'))form.append(decision)
  form.append(inputLabel,label,error,submit)
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(submit.disabled)return;error.textContent='';submit.disabled=true
   try{const selected=Array.from(files.files||[]);if(selected.length>3||selected.reduce((sum,file)=>sum+file.size,0)>512*1024)throw Error('最多3个附件，总大小不能超过512KB');const payload=await Promise.all(selected.map(filePayload));await api('submit',{id:result.id,nodeId:step.id,taskId:step.taskId,conclusion:conclusion.value,values:readValues?readValues():undefined,reviewed:reviewed.checked,decision:modes.includes('approval')?new FormData(form).get('workflowDecision'):'confirm',files:payload});pinnedSelection=false;detailSignature='';await refresh()}catch(e){error.textContent=e.message}finally{submit.disabled=false}
  })
  task.append(form)
 }
 async function renderDetail(){
  const id=activeRun;if(!id)return
  const result=await api('detail',{id});if(mode!=='detail'||id!==activeRun)return
  const signature=JSON.stringify(result);if(signature===detailSignature)return;detailSignature=signature;runDetail=result
  if(!pinnedSelection||!result.workflow.nodes.some(n=>n.id===runSelection))runSelection=(result.steps.find(s=>['running','waiting','failed'].includes(s.status))||result.steps.find(s=>s.status==='pending')||result.steps[result.steps.length-1]||{}).id
  const host=$('workflowRunDetail');host.textContent=''
  const head=node('div',undefined,'workflow-detail-heading');head.append(controls.back,node('h2',result.name),node('span',labels[result.status]||result.status,'muted'))
  if(['pending','running','waiting','paused'].includes(result.status))head.append(button('停止执行',async()=>{await api('stop',{id});detailSignature='';await refresh()}))
  else if(data.workflows.some(w=>w.id===result.workflowId))head.append(button('再次执行',async()=>{const next=await startRun(data.workflows.find(w=>w.id===result.workflowId));if(!next)return;activeRun=next.id;runSelection='';pinnedSelection=false;detailSignature='';await refresh()}))
  if(result.status==='running')head.append(button(result.pauseRequested?'等待当前步骤结束后暂停':'暂停',async()=>{await api('pause',{id});detailSignature='';await refresh()}))
  if(result.status==='paused')head.append(button('继续执行',async()=>{await api('resume',{id});detailSignature='';await refresh()}))
  host.append(head,node('p','实例 '+result.id+' · 流程版本 v'+result.revision,'workflow-instance-meta'))
  if(result.error)host.append(node('p',result.error,'workflow-error'))
  drawExecution(result,host)
 }
 function register(){
  if(typeof LiteGraph==='undefined')return
  LiteGraph.registered_node_types={}
  const defs=(data.nodes&&data.nodes.length)?data.nodes:FALLBACK_NODES
  for(const def of defs){
   function N(){
    this.addProperty('text','')
    if(!['input','start'].includes(def.type)){this.addInput('输入1','text');this.addInput('输入2','text')}
    if(!['output','end'].includes(def.type))this.addOutput('文本','text')
    this.size=[190,86]
    applyNodeTheme(this)
   }
   N.title=def.name
   N.prototype.getTitle=function(){
    const context=$('workflowCanvas').getContext('2d');context.save();context.font=$('workflowCanvas').data&&$('workflowCanvas').data.title_text_font||'14px Arial';let title=String(this.title||'');const width=Math.max(20,this.size[0]-40);let clipped=false;while(title.length&&context.measureText(title).width>width){title=title.slice(0,-1);clipped=true}context.restore();return clipped?title.slice(0,-1)+'…':title
   }
   N.prototype.onConnectionsChange=function(){dirty=true}
   N.prototype.onDrawForeground=function(ctx){
    if(this.flags&&this.flags.collapsed)return
    const raw=String((this.properties&&this.properties.text)||'').replace(/\s+/g,' ').trim()
    const summary=raw?(raw.length>22?raw.slice(0,22)+'…':raw):(def.type==='output'?'输出产物':'点击右侧配置参数')
    ctx.save()
    ctx.font='11px "Segoe UI","Microsoft YaHei",sans-serif'
    ctx.fillStyle=isLightTheme()?'#666666':'#aaaaaa'
    ctx.beginPath();ctx.rect(8,0,Math.max(0,this.size[0]-16),this.size[1]);ctx.clip()
    let fitted=summary;const width=Math.max(0,this.size[0]-24);while(fitted.length&&ctx.measureText(fitted).width>width)fitted=fitted.slice(0,-1);if(fitted!==summary){fitted=fitted.slice(0,-1)+'…'}
    ctx.fillText(fitted,12,this.size[1]-12)
    ctx.restore()
   }
   LiteGraph.registerNodeType('workflow/'+def.type,N)
   LiteGraph.registered_node_types['workflow/'+def.type].title=def.name
  }
 }
 function nextNodeId(type){
  const prefix=String(type||'node').replace(/[^a-zA-Z0-9_-]/g,'_')
  const used=new Set((graph&&Array.isArray(graph._nodes)?graph._nodes:[]).map(n=>(n.properties&&n.properties.workflowId)||('node_'+n.id)))
  let index=1
  while(used.has(prefix+'_'+index))index++
  return prefix+'_'+index
 }
 function parameter(n){
  selectedNode=n
  $('workflowNodeTitle').value=n?n.title:''
  $('workflowNodeText').value=n?(n.properties.text||''):''
  $('workflowNodeTitle').disabled=!n
  $('workflowNodeText').disabled=!n
  $('workflowRemoveNode').disabled=!n
  $('workflowNodeDescription').value=n?(n.properties.description||''):''
  $('workflowNodeDescription').disabled=!n
  $('workflowHumanOptions').classList.toggle('hidden',!n||n.type!=='workflow/human')
  for(const checkbox of document.querySelectorAll('[name=workflowHumanKind]'))checkbox.checked=!!n&&humanModes(n.properties).includes(checkbox.value)
  $('workflowRestOptions').classList.toggle('hidden',!n||n.type!=='workflow/rest')
  $('workflowRestUrl').value=n&&n.properties.rest?n.properties.rest.url:''
  for(const radio of document.querySelectorAll('[name=workflowRestMethod]'))radio.checked=!!n&&radio.value===(n.properties.rest&&n.properties.rest.method||'GET')
  renderPorts(n)
  renderStructured(n)
  if(stepsMode)renderSteps()
  $('workflowNodeMode').textContent=n?(n.type==='workflow/human'?'人工处理 · 提交后继续':'自动执行 · 完成后继续'):'选择节点查看配置'
  const hint=$('workflowParamHint')
  if(hint){
   const type=n&&typeof n.type==='string'?n.type.split('/')[1]:''
   hint.textContent=PARAM_HINTS[type]||'文本整理或 AI 节点可用 {{input}}、{{input1}}、{{input2}} 引用上游内容。拖动端口连线，选中节点后修改参数。'
  }
 }
 async function startRun(flow){
  if(!flow)return null
  const agents=flow.nodes.filter(n=>['agent','tool'].includes(n.type))
  if(agents.length&&!await window.appDialogs.confirm('确认执行“'+flow.name+'”？\n\n'+agents.map(n=>n.title+'：'+(n.type==='tool'?n.tool.name:((n.agent&&n.agent.tools)||[]).join('、')||'无工具')+(n.type==='tool'?'；固定调用一次':'；最多'+(n.agent&&n.agent.maxSteps||6)+'轮、'+(n.agent&&n.agent.maxRequests||6)+'次模型请求、'+(n.agent&&n.agent.maxToolCalls||8)+'次工具调用')+'；超时'+Math.round((n.agent&&n.agent.timeoutMs||120000)/1000)+'秒；'+((n.type==='tool'?n.tool.permission:n.agent&&n.agent.permission)==='workspace'?'允许工作目录内修改':'只读')).join('\n')+'\n\n人工步骤会等待确认，Agent 内部不会请求人工授权。'))return null
  return api('run',{id:flow.id,confirmed:true})
 }
 function rechain(){if(!graph)return;graph._nodes.forEach((n,i)=>{n.pos=[40+(i%4)*240,80+Math.floor(i/4)*160]});for(const link of Object.values(graph.links).filter(Boolean))graph.removeLink(link.id);for(let i=1;i<graph._nodes.length;i++){const a=graph._nodes[i-1],b=graph._nodes[i];if(a.outputs&&a.outputs.length&&b.inputs&&b.inputs.length)a.connect(0,b,0)}dirty=true;renderSteps()}
 function setSteps(value){
  if(value&&graph&&graph._nodes.length&&(Object.values(graph.links).filter(Boolean).length!==graph._nodes.length-1||graph._nodes.some(n=>(n.inputs||[]).filter(p=>p.link!==null&&p.link!==undefined).length>1||(n.outputs||[]).some(p=>p.links&&p.links.length>1)))){notice('当前流程不是完整顺序链，请继续使用画布编辑。');return setSteps(false)}
  if(value&&graph&&graph._nodes.length){const links=Object.values(graph.links).filter(Boolean),targets=new Set(links.map(l=>l.target_id)),ordered=[];let current=graph._nodes.find(n=>!targets.has(n.id));while(current&&!ordered.includes(current)){ordered.push(current);const link=links.find(l=>l.origin_id===current.id);current=link?graph.getNodeById(link.target_id):null}if(ordered.length!==graph._nodes.length){notice('当前流程无法表示为顺序步骤，请使用画布编辑。');return setSteps(false)}graph._nodes=ordered}
  stepsMode=value;$('workflowStepList').classList.toggle('hidden',!value);$('workflowCanvasHost').classList.toggle('hidden',value);$('workflowStepsToggle').textContent=value?'画布视图':'步骤视图';$('workflowStepsToggle').setAttribute('aria-pressed',String(value));if(value){if(canvas)canvas.stopRendering();renderSteps()}else if(canvas){canvas.startRendering();requestAnimationFrame(()=>{resize();fitGraph()})}
 }
 function renderSteps(){const host=$('workflowStepList');host.textContent='';if(!graph)return
  graph._nodes.forEach((n,index)=>{const row=node('article',undefined,'workflow-step-item'+(selectedNode===n?' selected':'')),select=button((index+1)+'. '+n.title,()=>{canvas.selectNode(n);parameter(n)});select.setAttribute('aria-pressed',String(selectedNode===n));const actions=node('div');for(const [offset,label]of [[-1,'上移'],[1,'下移']]){const b=button(label,()=>{const target=index+offset;[graph._nodes[index],graph._nodes[target]]=[graph._nodes[target],graph._nodes[index]];rechain()});const target=graph._nodes[index+offset];b.disabled=['workflow/start','workflow/end'].includes(n.type)||!target||['workflow/start','workflow/end'].includes(target.type);actions.append(b)}row.append(select,node('small',(data.nodes.find(d=>'workflow/'+d.type===n.type)||{}).name||n.type,'muted'),actions);host.append(row)})
  if(!graph._nodes.length)host.append(node('p','从上方选择节点，按步骤配置流程。','muted'))
 }
 function renderStructured(n){
  const host=$('workflowStructuredOptions');host.textContent='';if(!n)return
  const props=n.properties,type=n.type.split('/')[1]
  if(['end','output'].includes(type)){
   const group=node('fieldset');group.append(node('legend','最终交付产物'))
   const spec=props.deliverable||(props.deliverable={format:'text',name:'',files:[]}),label=node('label','交付格式'),select=node('select');select.setAttribute('aria-label','交付格式')
   for(const [value,title]of [['text','文本报告（TXT）'],['markdown','Markdown 报告'],['json','结构化结果（JSON）'],['files','实际文件（PPT、模型、场景等）']]){const option=node('option',title);option.value=value;option.selected=spec.format===value;select.append(option)}
   select.addEventListener('change',()=>{spec.format=select.value;dirty=true;renderStructured(n)});label.append(select);group.append(label)
   if(spec.format!=='files'){const nameLabel=node('label','产物名称'),input=node('input');input.value=spec.name;input.maxLength=120;input.placeholder='默认使用节点标题';input.addEventListener('input',()=>{spec.name=input.value;dirty=true});nameLabel.append(input);group.append(nameLabel);const fieldLabel=node('label','提取结构化结果字段（可选）'),field=node('input');field.value=spec.field||'';field.placeholder='例如 report，留空交付全部结果';field.addEventListener('input',()=>{spec.field=field.value;dirty=true});fieldLabel.append(field);group.append(fieldLabel)}
   else{
    group.append(node('p','文件由 Agent、工具或扩展节点实际生成，也可使用人工节点上传的附件名称，结束时归档。所有配置文件均为必需交付，缺失时不会标记成功。每文件最多64MB，单实例总计256MB。','muted'))
    for(const [index,file]of spec.files.entries()){
     const row=node('div',undefined,'workflow-delivery-file'),source=node('select');source.setAttribute('aria-label','产物 '+(index+1)+' 来源节点')
     const empty=node('option','选择来源节点');empty.value='';source.append(empty)
     for(const other of graph._nodes.filter(item=>item!==n&&(['workflow/agent','workflow/tool','workflow/human'].includes(item.type)||!(data.nodes||[]).some(t=>t.type===item.type.split('/')[1]&&['start','end','input','output','ai','evaluate','rest','template'].includes(t.type))))){const option=node('option',other.title+' · '+other.properties.workflowId);option.value=other.properties.workflowId;source.append(option)}source.value=file.nodeId;source.addEventListener('change',()=>{file.nodeId=source.value;dirty=true})
     const input=node('input');input.setAttribute('aria-label','产物 '+(index+1)+' 相对文件路径');input.placeholder='例如 output/report.pptx';input.value=file.path;input.maxLength=240;input.addEventListener('input',()=>{file.path=input.value;dirty=true})
     row.append(source,input,button('移除',()=>{spec.files.splice(index,1);dirty=true;renderStructured(n)},'移除产物 '+(index+1)));group.append(row)
    }
    const add=button('添加交付文件',()=>{spec.files.push({nodeId:'',path:''});dirty=true;renderStructured(n)});add.disabled=spec.files.length>=20;group.append(add)
   }
   host.append(group)
  }
  for(const [key,title]of [['inputSchema',type==='human'?'人工表单 Schema':'结构化输入 Schema'],['outputSchema','结构化输出 Schema'],['bindings','输入字段映射']]){
   const details=node('details');details.append(node('summary',title));const label=node('label',key==='bindings'?'示例：{"字段":{"nodeId":"上游ID","path":"report"}}':'支持 object、string、number、boolean、integer、array；字段使用英文标识'),text=node('textarea'),error=node('p',undefined,'workflow-error');text.rows=5;text.maxLength=16000;text.value=props[key]?JSON.stringify(props[key],null,2):'';text.setAttribute('aria-label',title);error.setAttribute('role','alert');text.addEventListener('input',()=>{try{props[key]=text.value.trim()?JSON.parse(text.value):key==='bindings'?{}:null;props.schemaErrors=props.schemaErrors||{};delete props.schemaErrors[key];error.textContent='';text.removeAttribute('aria-invalid');dirty=true}catch(e){props.schemaErrors=props.schemaErrors||{};props.schemaErrors[key]=true;error.textContent='JSON 格式无效';text.setAttribute('aria-invalid','true')}});label.append(text);details.append(label,error);if(key==='inputSchema'&&type==='human'&&props[key]){const preview=node('div',undefined,'workflow-form-preview');preview.append(node('p','运行时表单预览（填写内容不会提交）','muted'));try{window.workflowForms.render(preview,props[key],{})}catch(_){preview.append(node('p','Schema 无效，请修正后重新选择节点。','workflow-error'))}details.append(preview)}host.append(details)
  }
  if(['ai','agent','evaluate'].includes(type)){
   const group=node('fieldset');group.append(node('legend','绑定技能（最多4项）'));for(const skill of (data.capabilities&&data.capabilities.skills||[])){const label=node('label',undefined,'workflow-radio'),check=node('input');check.type='checkbox';check.checked=(props.skills||[]).includes(skill.id);check.addEventListener('change',()=>{const set=new Set(props.skills||[]);if(check.checked&&set.size>=4){check.checked=false;notice('每个节点最多绑定4个技能');return}check.checked?set.add(skill.id):set.delete(skill.id);props.skills=[...set];dirty=true});label.append(check,document.createTextNode(skill.name));group.append(label)}group.classList.add('workflow-capability-options');host.append(group)
  }
  if(type==='tool'){const details=node('fieldset');details.append(node('legend','固定工具调用'));props.tool=props.tool||{name:'',arguments:{},permission:'readonly'};const label=node('label','工具'),select=node('select');const empty=node('option','请选择工具');empty.value='';select.append(empty);for(const item of(data.capabilities&&data.capabilities.tools||[])){const option=node('option',item.name+' · '+item.permission);option.value=item.name;select.append(option)}select.value=props.tool.name;select.addEventListener('change',()=>{props.tool.name=select.value;dirty=true});label.append(select);details.append(label);const argsLabel=node('label','参数 JSON（文本可引用 {{input}}）'),args=node('textarea');args.rows=4;args.value=JSON.stringify(props.tool.arguments||{},null,2);args.addEventListener('input',()=>{try{props.tool.arguments=JSON.parse(args.value);props.schemaErrors=props.schemaErrors||{};delete props.schemaErrors.tool;dirty=true}catch(_){props.schemaErrors=props.schemaErrors||{};props.schemaErrors.tool=true}});argsLabel.append(args);details.append(argsLabel);const pLabel=node('label','权限'),permission=node('select');for(const [v,t]of [['readonly','只读'],['workspace','允许工作目录内修改']]){const option=node('option',t);option.value=v;permission.append(option)}permission.value=props.tool.permission;permission.addEventListener('change',()=>{props.tool.permission=permission.value;dirty=true});pLabel.append(permission);details.append(pLabel);host.append(details)}
  if(type!=='agent')return
  props.agent=props.agent||{tools:[],permission:'readonly',maxSteps:6,maxRequests:6,maxToolCalls:8,timeoutMs:120000,tokenBudget:150000,outputBytes:131072}
  const config=props.agent,limits=node('fieldset');limits.append(node('legend','Headless Agent 执行限制'))
  const permission=node('label','权限'),select=node('select');for(const [value,title]of [['readonly','只读'],['workspace','允许工作目录内修改']]){const option=node('option',title);option.value=value;select.append(option)}select.value=config.permission||'readonly';select.addEventListener('change',()=>{config.permission=select.value;dirty=true;renderStructured(n)});permission.append(select);limits.append(permission)
  for(const [key,title,min,max,fallback]of [['maxSteps','最大轮数',1,20,6],['maxRequests','最大模型请求数',1,20,6],['maxToolCalls','最大工具调用数',1,32,8],['timeoutMs','超时（毫秒）',1000,600000,120000],['tokenBudget','上下文与输出保守预算',4096,500000,150000],['outputBytes','最大输出字节数',4096,262144,131072]]){const label=node('label',title),input=node('input');input.type='number';input.min=min;input.max=max;input.value=config[key]||fallback;input.addEventListener('input',()=>{config[key]=Number(input.value);dirty=true});label.append(input);limits.append(label)}host.append(limits)
  const tools=node('fieldset');tools.className='workflow-capability-options';tools.append(node('legend','固定工具白名单（不支持命令和浏览器）'))
  for(const tool of(data.capabilities&&data.capabilities.tools||[])){const label=node('label',undefined,'workflow-radio'),check=node('input');check.type='checkbox';check.checked=(config.tools||[]).includes(tool.name);check.disabled=(config.permission||'readonly')==='readonly'&&tool.permission!=='read'&&!check.checked;check.addEventListener('change',()=>{const set=new Set(config.tools||[]);check.checked?set.add(tool.name):set.delete(tool.name);config.tools=[...set];dirty=true});label.title=tool.description;label.append(check,document.createTextNode(tool.name+' · '+tool.permission));tools.append(label)}host.append(tools)
 }
 function renderPorts(n){
  const host=$('workflowPorts');host.textContent=''
  if(!n){host.append(node('p','选择节点后配置端口。','muted'));return}
  for(const [kind,title] of [['inputs','输入'],['outputs','输出']]){
   const group=node('fieldset');group.append(node('legend',title+'端口'))
   const list=n[kind]||[],blocked=kind==='inputs'&&['workflow/input','workflow/start'].includes(n.type)||kind==='outputs'&&['workflow/output','workflow/end'].includes(n.type)
   list.forEach((port,index)=>{
    const row=node('div',undefined,'workflow-port-row'),label=node('label'),input=node('input');input.value=port.name;input.maxLength=40;input.setAttribute('aria-label',title+'端口'+(index+1)+'名称');label.append(input)
    input.addEventListener('input',()=>{port.name=input.value;dirty=true;graph.setDirtyCanvas(true,true)})
    row.append(label,button('×',()=>{if(kind==='inputs')n.removeInput(index);else n.removeOutput(index);n.size=n.computeSize();n.size[1]=Math.max(n.size[1]+24,86);dirty=true;renderPorts(n);graph.setDirtyCanvas(true,true)},'删除'+title+'端口 '+port.name));group.append(row)
   })
   if(!blocked){const add=button('＋ 添加'+title,()=>{if(list.length>=32)return;let index=list.length+1;while(list.some(p=>p.name===title+index))index++;if(kind==='inputs')n.addInput(title+index,'text');else n.addOutput(title+index,'text');n.size=n.computeSize();n.size[1]=Math.max(n.size[1]+24,86);dirty=true;renderPorts(n);graph.setDirtyCanvas(true,true)});add.disabled=list.length>=32;group.append(add)}
   else group.append(node('p',kind==='inputs'?'起始输入节点不接收上游连线。':'保存结果节点为终点。','muted'))
   host.append(group)
  }
  host.append(node('p','当前端口传递文本。多个输出端口分发同一节点结果；{{input3}} 等按输入端口序号引用。删除端口会同时断开对应连线。','muted'))
 }
 function edit(flow){
  register()
  editing=JSON.parse(JSON.stringify(flow))
  dirty=false
  $('workflowName').value=flow.name
  view('editor')
  if(canvas)canvas.dispose()
  graph=new LGraph()
  canvas=window.workflowCanvasLifecycle.create($('workflowCanvas'),graph)
  canvas.background_image=null
  canvas.render_canvas_border=false
  canvas.show_info=false
  const drawNode=canvas.drawNode
  canvas.drawNode=function(n,ctx){ctx.save();ctx.beginPath();ctx.rect(-8,-LiteGraph.NODE_TITLE_HEIGHT-8,n.size[0]+16,n.size[1]+LiteGraph.NODE_TITLE_HEIGHT+16);ctx.clip();try{return drawNode.call(this,n,ctx)}finally{ctx.restore()}}
  canvas.allow_searchbox=false
  canvas.processContextMenu=(n,e)=>{if(e&&typeof e.preventDefault==='function')e.preventDefault();if(n){canvas.selectNode(n);parameter(n)}return false}
  canvas.onShowNodePanel=n=>{canvas.selectNode(n);parameter(n);if(!$('workflowNodeText').disabled)$('workflowNodeText').focus();return false}
  canvas.prompt=()=>false
  canvas.onNodeMoved=()=>{dirty=true}
  canvas.onNodeSelected=parameter
  canvas.onNodeDeselected=()=>parameter(null)
  syncCanvasTheme()
  const map=new Map()
  for(const entry of flow.nodes){
   const n=LiteGraph.createNode('workflow/'+entry.type)
   if(!n)throw Error('无法加载节点类型：'+entry.type)
   n.title=entry.title
   n.properties.text=entry.text||''
   n.properties.description=entry.description||''
   n.properties.humanKind=entry.humanKind||'review'
   n.properties.humanModes=humanModes(entry).slice()
   n.properties.rest=entry.rest||{url:'',method:'GET'}
   for(const key of ['inputSchema','outputSchema','bindings','skills','agent','tool','deliverable'])if(entry[key]!==undefined)n.properties[key]=JSON.parse(JSON.stringify(entry[key]))
   if(Array.isArray(entry.inputs)){n.inputs=[];for(const port of entry.inputs)n.addInput(port.name,'text')}
   if(Array.isArray(entry.outputs)){n.outputs=[];for(const port of entry.outputs)n.addOutput(port.name,'text')}
   n.size=n.computeSize()
   n.size[1]=Math.max(n.size[1]+24,86)
   n.properties.workflowId=entry.id
   n.pos=Array.isArray(entry.pos)?entry.pos.slice(0,2):[40,100]
   applyNodeTheme(n)
   graph.add(n)
   map.set(entry.id,n)
  }
  for(const edge of flow.edges){
   const fromNode=map.get(edge.from),toNode=map.get(edge.to)
   if(fromNode&&toNode)fromNode.connect(edge.outputSlot||0,toNode,edge.slot||0)
  }
  dirty=false
  const toolbar=$('workflowNodeTypes');toolbar.textContent=''
  const defs=(data.nodes&&data.nodes.length)?data.nodes:FALLBACK_NODES
  const iconNames={start:'wf-start',human:'wf-human',ai:'model',agent:'workflow',tool:'plugin',rest:'wf-rest',evaluate:'wf-evaluate',end:'stop'}
  const groups=[['边界节点',defs.filter(d=>!d.legacy&&d.type==='start')],['处理节点',defs.filter(d=>!d.legacy&&!['start','end'].includes(d.type))],['结束节点',defs.filter(d=>!d.legacy&&d.type==='end')]]
  for(const [title,items] of groups){
   if(!items.length)continue
   if(toolbar.children.length){const separator=node('span','｜','workflow-toolbar-divider');separator.setAttribute('aria-hidden','true');toolbar.append(separator)}
   const group=node('div',undefined,'workflow-node-group');group.setAttribute('role','group');group.setAttribute('aria-label',title)
   for(const type of items){
    const add=button('',()=>{
     const n=LiteGraph.createNode('workflow/'+type.type);n.title=type.name;n.properties.workflowId=nextNodeId(type.type)
     n.pos=[canvas.canvas.width/(2*canvas.ds.scale)-canvas.ds.offset[0]-95+(graph._nodes.length%3)*24,canvas.canvas.height/(2*canvas.ds.scale)-canvas.ds.offset[1]-40+(graph._nodes.length%3)*24]
     applyNodeTheme(n);graph.add(n);if(stepsMode){const end=graph._nodes.find(v=>v.type==='workflow/end');if(end&&end!==n){graph._nodes.splice(graph._nodes.indexOf(n),1);graph._nodes.splice(graph._nodes.indexOf(end),0,n)}rechain()}canvas.selectNode(n);parameter(n);dirty=true;graph.setDirtyCanvas(true,true)
    },'添加'+type.name)
    const icon=node('span',undefined,'icon');icon.setAttribute('data-icon',iconNames[type.type]||'workflow');icon.setAttribute('aria-hidden','true');add.dataset.nodeType=type.type;add.append(icon,node('span',type.name));group.append(add)
   }
   toolbar.append(group)
  }
  if(window.applyIcons)window.applyIcons(toolbar)
  setupCanvasTools()
  stepsMode=flow.editor==='steps';setSteps(stepsMode);parameter(null)
  canvas.startRendering()
  resize()
  requestAnimationFrame(()=>{resize();fitGraph()})
 }
 function updateZoom(){if(canvas)$('workflowZoom').textContent=Math.round(canvas.ds.scale*100)+'%'}
 function canvasModeSet(mode){
  canvasMode=mode;panDrag=null
  if(canvas){canvas.allow_dragnodes=mode==='select';canvas.allow_interaction=mode!=='pan';canvas.dragging_canvas=false;canvas.connecting_node=null;canvas.setDirty(true,true)}
  $('workflowCanvas').style.cursor=mode==='pan'?'grab':mode==='connect'?'crosshair':'default'
  for(const b of document.querySelectorAll('[data-canvas-mode]'))b.setAttribute('aria-pressed',String(b.dataset.canvasMode===mode))
  $('workflowCanvasHint').textContent=mode==='pan'?'拖动平移画布 · 滚轮缩放':mode==='connect'?'从输出圆点拖到输入圆点连线':'拖动节点调整位置 · 从端口拖动连线'
 }
 function canvasZoom(factor){if(!canvas)return;canvas.ds.changeScale(canvas.ds.scale*factor);canvas.setDirty(true,true);updateZoom()}
 function fitGraph(){
  if(!canvas)return
  if(!graph._nodes.length){canvas.ds.scale=1;canvas.ds.offset[0]=0;canvas.ds.offset[1]=0}
  else{const bounds=graph._nodes.map(n=>n.getBounding()),x=Math.min(...bounds.map(b=>b[0])),y=Math.min(...bounds.map(b=>b[1])),right=Math.max(...bounds.map(b=>b[0]+b[2])),bottom=Math.max(...bounds.map(b=>b[1]+b[3]));canvas.ds.scale=Math.max(.1,Math.min(1.5,(canvas.canvas.width-140)/Math.max(1,right-x),(canvas.canvas.height-100)/Math.max(1,bottom-y)));canvas.ds.offset[0]=canvas.canvas.width/(2*canvas.ds.scale)-(x+right)/2;canvas.ds.offset[1]=canvas.canvas.height/(2*canvas.ds.scale)-(y+bottom)/2}
  canvas.setDirty(true,true);updateZoom()
 }
 function setupCanvasTools(){
  const host=$('workflowCanvasTools');host.textContent=''
  const entries=[['select','wf-select','选择与移动节点',()=>canvasModeSet('select')],['pan','wf-pan','拖拽平移画布',()=>canvasModeSet('pan')],['connect','wf-link','连接节点端口',()=>canvasModeSet('connect')],['in','wf-zoom-in','放大',()=>canvasZoom(1.2)],['out','wf-zoom-out','缩小',()=>canvasZoom(1/1.2)],['fit','wf-fit','适应全部节点',fitGraph],['reset','refresh','重置为100%',()=>{canvas.ds.changeScale(1);canvas.setDirty(true,true);updateZoom()}]]
  for(const [key,iconName,title,action] of entries){const b=button('',action,title),icon=node('span',undefined,'icon');icon.setAttribute('data-icon',iconName);icon.setAttribute('aria-hidden','true');b.append(icon);b.dataset.canvasAction=key;if(['select','pan','connect'].includes(key)){b.dataset.canvasMode=key;b.setAttribute('aria-pressed','false')}host.append(b)}
  const zoom=node('span','100%','workflow-zoom');zoom.id='workflowZoom';zoom.setAttribute('aria-label','画布缩放比例');host.append(zoom)
  if(window.applyIcons)window.applyIcons(host);canvasModeSet('select');updateZoom()
 }
 const pointer=typeof LiteGraph!=='undefined'?LiteGraph.pointerevents_method:'pointer'
 $('workflowCanvas').addEventListener(pointer+'down',event=>{if(mode!=='editor'||canvasMode!=='pan'||event.button!==0)return;event.preventDefault();event.stopImmediatePropagation();panDrag={x:event.clientX,y:event.clientY};$('workflowCanvas').style.cursor='grabbing'},true)
 document.addEventListener(pointer+'move',event=>{if(!panDrag||!canvas)return;event.preventDefault();event.stopImmediatePropagation();canvas.ds.offset[0]+=(event.clientX-panDrag.x)/canvas.ds.scale;canvas.ds.offset[1]+=(event.clientY-panDrag.y)/canvas.ds.scale;panDrag={x:event.clientX,y:event.clientY};canvas.setDirty(true,true)},true)
 document.addEventListener(pointer+'up',event=>{if(!panDrag)return;event.preventDefault();event.stopImmediatePropagation();panDrag=null;$('workflowCanvas').style.cursor='grab'},true)
 $('workflowCanvas').addEventListener('wheel',()=>requestAnimationFrame(updateZoom),{passive:true})
 window.addEventListener('blur',()=>{panDrag=null})
 function resize(){
  if(canvas&&mode==='editor'&&!page.classList.contains('hidden')){
   const rect=$('workflowCanvasHost').getBoundingClientRect()
   canvas.resize(Math.max(320,rect.width),Math.max(240,rect.height))
   syncCanvasTheme()
  }
 }
 async function create(){
  const name=await window.appDialogs.prompt('新建流程','资料整理流程')
  if(!name)return
  edit({
   version:1,
   name,
   nodes:[],
   edges:[]
  })
  dirty=true
 }
 function removeSelectedNode(){
  if(!selectedNode||!graph)return
  graph.remove(selectedNode)
  if(stepsMode)rechain()
  parameter(null)
  dirty=true
  graph.setDirtyCanvas(true,true)
 }
 $('openWorkflows').addEventListener('click',open)
 $('workflowClose').addEventListener('click',async()=>{
  if(!await confirmLeaveEditor())return
  hide()
  $('contentFrame').classList.remove('hidden')
 })
 $('workflowTemplate').addEventListener('click',async()=>{try{const draft=await api('template',{id:'report'});edit(draft);dirty=true;notice('步骤模板已载入，检查表单、Agent 白名单和限额后保存；尚未执行。')}catch(e){notice(e.message)}})
 $('workflowStepsToggle').addEventListener('click',()=>setSteps(!stepsMode))
 $('workflowAI').addEventListener('click',()=>window.workflowChat.open({mode:'create'}).catch(e=>notice(e.message)))
 $('workflowNew').addEventListener('click',()=>create().catch(e=>notice(e.message)))
 controls.back.addEventListener('click',async()=>{
  if(mode==='editor'&&!await confirmLeaveEditor())return
  dirty=false
  notice('')
  if(mode==='detail'){view('runs');renderRuns()}
  else{filter='';view('flows');refresh()}
 })
 $('workflowAllRuns').addEventListener('click',()=>{notice('');filter='';$('workflowSearch').value='';view('runs');renderRuns();refresh()})
 $('workflowSearch').addEventListener('input',()=>{if(mode==='runs')renderRuns();else renderFlows()})
 $('workflowName').addEventListener('input',()=>{dirty=true})
 controls.save.addEventListener('click',async()=>{
  const b=controls.save;b.disabled=true
  try{
   if(graph._nodes.some(n=>Object.keys(n.properties.schemaErrors||{}).length))throw Error('请先修正节点 Schema 或输入映射 JSON')
   const nodes=graph._nodes.map(n=>({...Object.fromEntries(['inputSchema','outputSchema','bindings','skills','agent','tool','deliverable'].filter(k=>n.properties[k]!==undefined).map(k=>[k,n.properties[k]])),id:n.properties.workflowId||nextNodeId(n.type.split('/')[1]),type:n.type.split('/')[1],title:n.title,text:n.properties.text||'',description:n.properties.description||'',humanKind:n.properties.humanKind||'review',humanModes:humanModes(n.properties),rest:n.properties.rest||{url:'',method:'GET'},inputs:(n.inputs||[]).map(p=>({name:p.name,type:'text'})),outputs:(n.outputs||[]).map(p=>({name:p.name,type:'text'})),pos:Array.from(n.pos)}))
   const byGraph=new Map(graph._nodes.map((n,i)=>[n.id,nodes[i].id]))
   const edges=Object.values(graph.links).filter(Boolean).map(l=>({from:byGraph.get(l.origin_id),to:byGraph.get(l.target_id),slot:l.target_slot||0,outputSlot:l.origin_slot||0}))
   await api('save',{...editing,editor:stepsMode?'steps':'canvas',name:$('workflowName').value,nodes,edges})
   dirty=false
   view('flows')
   notice('流程已保存')
   await refresh()
  }catch(e){notice(e.message)}
  finally{b.disabled=false}
 })
 $('workflowNodeTitle').addEventListener('input',()=>{if(selectedNode){selectedNode.title=$('workflowNodeTitle').value;if(stepsMode)renderSteps();dirty=true;graph.setDirtyCanvas(true,true)}})
 $('workflowNodeText').addEventListener('input',()=>{if(selectedNode){selectedNode.properties.text=$('workflowNodeText').value;dirty=true;graph.setDirtyCanvas(true,true)}})
 $('workflowNodeDescription').addEventListener('input',()=>{if(selectedNode){selectedNode.properties.description=$('workflowNodeDescription').value;dirty=true}})
 for(const checkbox of document.querySelectorAll('[name=workflowHumanKind]'))checkbox.addEventListener('change',()=>{if(selectedNode){const modes=Array.from(document.querySelectorAll('[name=workflowHumanKind]:checked')).map(el=>el.value);selectedNode.properties.humanModes=modes;selectedNode.properties.humanKind=modes[0]||'review';dirty=true}})
 $('workflowRestUrl').addEventListener('input',()=>{if(selectedNode){selectedNode.properties.rest={...(selectedNode.properties.rest||{method:'GET'}),url:$('workflowRestUrl').value};dirty=true}})
 for(const radio of document.querySelectorAll('[name=workflowRestMethod]'))radio.addEventListener('change',()=>{if(selectedNode&&radio.checked){selectedNode.properties.rest={...(selectedNode.properties.rest||{url:''}),method:radio.value};dirty=true}})
 $('workflowRemoveNode').addEventListener('click',removeSelectedNode)
 $('workflowCanvas').addEventListener('keydown',e=>{
  if((e.key==='Delete'||e.key==='Backspace')&&selectedNode&&document.activeElement===$('workflowCanvas')){
   e.preventDefault()
   removeSelectedNode()
  }
 })
 document.addEventListener('click',e=>{if(e.target.closest('#openLibrary,#openCustomize,#newSession,.session-item,.project-item'))hide()})
 if(typeof MutationObserver==='function'){
  const themeObserver=new MutationObserver(()=>syncCanvasTheme())
  themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']})
 }
 Promise.resolve().then(()=>api('list')).then(next=>{
  if(next&&Array.isArray(next.workflows))$('workflowCount').textContent=String(next.workflows.length)
  if(next&&Array.isArray(next.nodes)&&next.nodes.length)data.nodes=next.nodes
 }).catch(()=>{})
 const timer=setInterval(()=>{if(!document.hidden&&mode!=='editor')refresh()},1500)
 window.addEventListener('resize',resize)
 window.addEventListener('beforeunload',()=>{disposed=true;clearInterval(timer);if(canvas)canvas.dispose()})
 async function openDraft(id){
  if(!await confirmLeaveEditor())return
  open();const latest=await api('list');data=latest;const flow=latest.workflows.find(w=>w.id===id);if(!flow)throw Error('流程不存在');edit(flow)
 }
 async function openReference(ref){
  open()
  if(ref.runId){activeRun=ref.runId;filter=ref.workflowId;runSelection=ref.nodeId||'';pinnedSelection=!!ref.nodeId;detailSignature='';view('detail');await refresh()}
  else if(ref.workflowId)await openDraft(ref.workflowId)
  else{view('flows');await refresh()}
 }
 window.workflowUI={open,hide,refresh,openDraft,openReference}
})()
