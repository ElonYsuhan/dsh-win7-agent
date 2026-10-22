'use strict'
;(function(){
 const $=id=>document.getElementById(id),page=$('workflowPage');if(!page)return
 const controls={back:$('workflowBack'),save:$('workflowSave'),close:$('workflowClose')},pageHeader=page.querySelector('.workflow-header')
 let mapCollapsed=false,executionViewport=null,executionMapCleanup=()=>{}
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
  human:'完成办理、审阅或审批后进入下一步；驳回时填写原因，退回指定的人工环节修改。附件和填写项按业务需要添加。',
  input:'提供流程的初始输入文本。',
  start:'流程起点，可填写初始文本或运行目标。',
  end:'流程终点，汇总上游内容并保存为实例产物。',
  rest:'填写 HTTP/HTTPS 接口地址与方法；POST、PUT、PATCH 的节点内容为 JSON 请求体，支持 {{inputN}}，留空发送 {input}。当前不配置接口凭据；失败不自动重试。',
  evaluate:'填写评估标准。使用当前模型给出依据、结论、风险和建议；不代替人工审批。',
  ai:'输入 AI 处理指令；默认自动附加上游输入，也可在指令中用 {{input}}、{{input1}}、{{input2}} 指定引用位置。',
  template:'使用 {{input}} 引用全部上游内容，或用 {{input1}}、{{input2}} 分别引用输入1、输入2端口。',
  output:'将上游汇聚的文本保存为本次执行的产物文件（可留空节点内容）。'
 }
 let data={workflows:[],runs:[],nodes:FALLBACK_NODES.slice()},mode='flows',filter='',activeRun='',editing=null,graph=null,canvas=null,selectedNode=null,refreshing=false,refreshAgain=false,detailSignature='',disposed=false,dirty=false,runSelection='',runDetail=null,pinnedSelection=false,canvasMode='select'
 const taskForms=new Map()
 const humanModes=n=>Array.isArray(n.humanModes)?n.humanModes:[n.humanKind||'review']
 // 旧节点没有 interaction 时，按已有处理方式归纳成三种预设之一，不再保留「保留原有组合配置」。
 const interactionPreset=props=>{const type=props&&props.interaction&&props.interaction.type;if(type==='handle'||type==='review'||type==='approve')return type;const modes=humanModes(props||{});return modes.includes('approval')?'approve':modes.includes('read')?'review':'handle'}
 let stepsMode=false
 let cardTheme=null
 const api=(action,payload)=>window.dsh.workflowRequest(action,payload)
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
 function notice(text){const el=$('workflowNotice');if(el)el.textContent=text||''}
 function button(text,fn,title){
  const b=node('button',text);b.type='button'
  if(title){b.title=title;b.setAttribute('aria-label',title)}
  b.addEventListener('click',async()=>{if(b.disabled)return;b.disabled=true;try{await fn()}catch(e){notice(e.message)}finally{b.disabled=false}})
  return b
 }
 function glyph(name,cls){const icon=node('span',undefined,'icon'+(cls?' '+cls:''));icon.setAttribute('aria-hidden','true');if(window.renderIcon)icon.innerHTML=window.renderIcon(name);return icon}
 function formatBytes(size){return size<1024?size+' 字节':size<1024*1024?(size/1024).toFixed(1)+' KB':(size/1024/1024).toFixed(1)+' MB'}
 async function copyText(text){
  if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){await navigator.clipboard.writeText(text);return}
  const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()
 }
 function nodeTitle(entry){const title=node('strong',undefined,'workflow-typed-title');title.append(glyph(window.workflowNodeIcons.name(entry.type)),node('span',entry.title,'workflow-node-title-text'));return title}
 function readCardTheme(){
  const style=getComputedStyle(page),value=name=>style.getPropertyValue('--workflow-node-'+name).trim()
  return{width:parseFloat(value('width')),height:parseFloat(value('height')),radius:parseFloat(value('radius')),background:value('background'),border:value('border'),selected:value('selected'),text:value('text'),muted:value('muted'),hover:value('hover'),hoverBorder:style.getPropertyValue('--hover-border').trim(),font:style.fontFamily,canvas:style.getPropertyValue('--bg').trim()}
 }
function fitNodeText(ctx,text,width){let result=String(text||'');if(ctx.measureText(result).width<=width)return result;while(result&&ctx.measureText(result+'…').width>width)result=result.slice(0,-1);return result+'…'}
// 按宽度折行，超过行数上限时末行省略，保证卡片内文字不溢出。
function interactionName(config){return config&&{handle:'办理',review:'审阅',approve:'审批'}[config.type]||''}
function drawNodeCard(n,ctx,size,selected,hovered){
 const theme=cardTheme,top=-LiteGraph.NODE_TITLE_HEIGHT,height=size[1]-top,width=size[0]
 selected=selected||marqueeHasNode(n)
 ctx.save();ctx.shadowColor='transparent';ctx.globalAlpha=1
 ctx.beginPath();ctx.roundRect(.5,top+.5,width-1,height-1,[theme.radius]);ctx.fillStyle=hovered&&!selected?theme.hover:theme.background;ctx.fill();ctx.strokeStyle=selected?theme.selected:hovered?theme.hoverBorder:theme.border;ctx.lineWidth=selected?2:1;ctx.stroke()
 ctx.beginPath();ctx.roundRect(0,top+15,3,height-30,[0,2,2,0]);ctx.fillStyle=theme.muted;ctx.fill()
 ctx.beginPath();ctx.rect(12,top+8,width-24,height-16);ctx.clip();ctx.textAlign='left'
 // 名称在上：标题独占首行，字号与字重都高于正文。
 ctx.font='650 14px '+theme.font;ctx.fillStyle=theme.text;ctx.strokeStyle=theme.text;window.workflowNodeIcons.draw(ctx,n.type,18,top+14,17);ctx.fillText(fitNodeText(ctx,n.title,width-60),42,top+29)
 ctx.beginPath();ctx.moveTo(16,top+40);ctx.lineTo(width-16,top+40);ctx.globalAlpha=.55;ctx.strokeStyle=theme.border;ctx.lineWidth=1;ctx.stroke();ctx.globalAlpha=1
 // 文字在下：贴在卡片底部一行，按卡片宽度省略。
 const body=String((n.properties&&(n.properties.text||n.properties.description))||'').replace(/\s+/g,' ').trim()
 if(body){ctx.font='11px '+theme.font;ctx.fillStyle=theme.muted;ctx.fillText(fitNodeText(ctx,body,width-36),18,size[1]-9)}
 ctx.restore()
 // Draw outside the text clip so the edge grip stays visible in resize mode.
 if(selected||canvasMode==='resize'){ctx.save();ctx.strokeStyle=selected?theme.selected:theme.muted;ctx.lineWidth=1;for(const offset of [7,12]){ctx.beginPath();ctx.moveTo(width-offset,size[1]-5);ctx.lineTo(width-5,size[1]-offset);ctx.stroke()}ctx.restore()}
}
 function applyNodeTheme(n){
  if(!n)return
  n.color=cardTheme.border;n.bgcolor=cardTheme.background;n.boxcolor=cardTheme.muted
 }
 function syncCanvasTheme(){
  if(typeof LiteGraph==='undefined')return
  cardTheme=readCardTheme()
  LiteGraph.NODE_DEFAULT_COLOR=cardTheme.border
  LiteGraph.NODE_DEFAULT_BGCOLOR=cardTheme.background
  LiteGraph.NODE_DEFAULT_BOXCOLOR=cardTheme.muted
  LiteGraph.NODE_TEXT_COLOR=cardTheme.muted
  LiteGraph.NODE_TITLE_COLOR=cardTheme.text
  LiteGraph.WIDGET_TEXT_COLOR=cardTheme.text
  if(canvas){
   canvas.clear_background_color=cardTheme.canvas
   canvas.default_link_color=cardTheme.muted
   canvas.connections_width=1.5;canvas.render_connections_border=false;canvas.render_connections_shadows=false
   canvas.inner_text_font='11px '+cardTheme.font
   canvas.default_connection_color_byType.text=cardTheme.selected
   canvas.default_connection_color_byTypeOff.text=cardTheme.muted
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
 function hide(){executionMapCleanup();detailSignature='';closeArtifact();if(artifactDownload)artifactDownload.abort();
  finishSplit(true);finishCardResize(true);closeCanvasMenu(false)
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
  executionMapCleanup()
  finishSplit(true);finishCardResize(true);closeCanvasMenu(false)
  mode=next
  page.classList.remove('workflow-detail-ready');page.setAttribute('aria-labelledby','workflowHeading');pageHeader.append(controls.close)
  if(next==='detail'){detailSignature='';$('workflowRunDetail').textContent=''}
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
   const title=node('strong',undefined,'workflow-typed-title');title.append(glyph('workflow'),node('span',flow.name,'workflow-node-title-text'));head.append(title,node('span','v'+flow.revision,'muted'))
   const instances=data.runs.filter(r=>r.workflowId===flow.id)
   const latest=instances[0]
   const meta=flow.nodes.length+' 个节点 · '+instances.length+' 个执行实例'+(latest?' · 最近：'+(labels[latest.status]||latest.status):'')
   card.append(head,node('p',meta,'muted'))
   const actions=node('div',undefined,'workflow-card-actions');actions.setAttribute('role','group');actions.setAttribute('aria-label','流程操作')
   const action=(key,icon,title,fn)=>{const control=button('',fn,title);control.className='workflow-icon-action';control.dataset.workflowAction=key;control.append(glyph(icon));return control}
   actions.append(
    action('run','play','执行 '+flow.name,async()=>{notice('');const run=await startRun(flow);if(!run)return;filter=flow.id;activeRun=run.id;runSelection='';pinnedSelection=false;detailSignature='';view('detail');await refresh()}),
    action('instances','wf-steps','查看执行实例',()=>{notice('');filter=flow.id;$('workflowSearch').value='';view('runs');renderRuns()}),
    action('edit','edit','编辑流程',()=>{notice('');edit(flow)}),
    action('delete','trash','删除流程',async()=>{if(await window.appDialogs.confirm('删除流程“'+flow.name+'”？已产生的执行记录仍保留。')){const removed=await window.dsh.taskRequest('removeWorkflow',{id:flow.id});if(removed.syncError)notice('流程已删除，但定时任务未清理：'+removed.syncError);if(filter===flow.id)filter='';await refresh()}})
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
   const actions=node('div',undefined,'workflow-run-actions');if(run.artifactCount||run.deliveryCount)actions.append(button('产物 '+run.artifactCount+(run.deliveryCount?'/'+run.deliveryCount:''),async()=>{notice('');activeRun=run.id;runSelection='';pinnedSelection=false;detailSignature='';view('detail');await renderDetail();const section=$('workflowArtifacts');if(section){section.scrollIntoView({block:'nearest'});section.focus()}}));else info.append(node('small','尚未生成产物','muted'));row.append(info,actions);actions.append(button('查看步骤',async()=>{notice('');activeRun=run.id;runSelection='';pinnedSelection=false;detailSignature='';view('detail');await renderDetail()}))
   list.append(row)
  }
  if(!list.children.length)list.append(node('p','暂无匹配的执行实例','muted'))
 }
 function renderArtifacts(result,host){
  const artifacts=result.deliverables||result.artifacts||[],section=node('section',undefined,'workflow-artifacts'+(!artifacts.length?' is-empty':''));section.id='workflowArtifacts';section.tabIndex=-1;section.setAttribute('aria-label','工作流产物')
  const head=node('div',undefined,'workflow-section-heading');head.append(node('h3','工作流产物'),node('span',String(artifacts.length),'workflow-section-count'));section.append(head)
  if(!artifacts.length){const empty=node('div',undefined,'workflow-artifacts-empty'),copy=node('div');copy.append(node('strong','产物将在这里交付'),node('p',['failed','cancelled','interrupted'].includes(result.status)?'此次执行未完成，可展开节点记录查看中间结果。':'完成流程后，可在这里查看和下载报告、模型或场景文件。'));empty.append(glyph('file'),copy);section.append(empty)}
  if(artifacts.some(item=>!item.status||item.status==='delivered')&&result.status!=='succeeded')section.append(node('p','流程尚未完成，以下为已生成的部分产物。','muted'))
  for(const item of artifacts){
   const row=node('article',undefined,'workflow-artifact-item'),entry=result.workflow.nodes.find(n=>n.id===item.nodeId),info=node('div',undefined,'workflow-artifact-info'),actions=node('div',undefined,'workflow-artifact-actions')
   const title=node('strong',item.name);title.title=item.name;info.append(title,node('small',(item.status==='draft'?(item.size===0?'空白草稿 · ':'草稿 · '):item.status==='planned'?'待生成 · ':'已交付 · ')+(item.format||'文件').toUpperCase()+(item.size!==undefined?' · '+formatBytes(item.size):'')+' · '+(entry?entry.title:item.nodeId),'muted'))
   const preview=button(item.status==='draft'?'查看草稿':'查看',()=>openArtifact(result,item),'查看 '+item.name),download=button('',()=>downloadArtifact(result,item),'下载 '+item.name);if(item.status==='planned'){preview.disabled=true;download.disabled=true;preview.title='文件尚未生成，完成相应节点后可查看';download.title=preview.title}download.append(glyph('download'));download.className='workflow-icon-action';actions.append(preview,download);row.append(glyph('file','workflow-file-glyph'),info,actions);section.append(row)
  }
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
   body.textContent='';if(value.status==='draft')body.append(node('p','这是执行开始时创建的草稿，尚未形成正式结果。结束节点完成后会发布最终文件。','workflow-draft-note'));window.filePreview.render(body,{...value,text,url,name:item.name,ext,kind:value.kind==='text'&&!['txt','log','csv'].includes(ext)?'code':value.kind});if(value.notice)body.append(node('p',value.notice,'muted'))
  }catch(e){if(!controller.signal.aborted)body.textContent=e.message}
 }
 function executionState(step){return step&&step.status==='succeeded'?'done':step&&['running','waiting'].includes(step.status)?'active':step&&['failed','interrupted','cancelled'].includes(step.status)?'error':'pending'}
 function executionLabel(step){return step&&step.status==='waiting'?'执行中 · 待人工处理':step&&step.status==='succeeded'?'已结束':step&&['interrupted','cancelled'].includes(step.status)?labels[step.status]:step&&step.status==='skipped'?'待执行 · 已跳过':step&&step.status==='pending'?'待执行':labels[step&&step.status]||'待执行'}
 // Execution cards are DOM elements, so they need their own viewport rather
 // than the editor's LiteGraph wheel handler. Keep only the current run's view.
 function attachExecutionViewport(scroll,stage,width,height,result,positions,nodeWidth){
  executionMapCleanup()
  const fresh=!executionViewport||executionViewport.id!==result.id
  if(fresh)executionViewport={id:result.id,scale:1,x:0,y:0,selection:'',initialized:false}
  const view=executionViewport,extent=node('div',undefined,'workflow-map-extent')
  extent.append(stage);scroll.append(extent);scroll.tabIndex=0;scroll.setAttribute('aria-label','执行流程图，滚轮缩放，拖动空白平移')
  let stopped=false,drag=null,padX=0,padY=0,frame=null
  const remember=()=>{if(!stopped&&padX&&padY){view.x=(scroll.scrollLeft-padX)/view.scale;view.y=(scroll.scrollTop-padY)/view.scale}}
  const layout=()=>{
   if(stopped||!scroll.isConnected||!scroll.clientWidth||!scroll.clientHeight)return
   padX=scroll.clientWidth;padY=scroll.clientHeight
   extent.style.width=(width*view.scale+2*padX)+'px';extent.style.height=(height*view.scale+2*padY)+'px'
   stage.style.left=padX+'px';stage.style.top=padY+'px';stage.style.transform='scale('+view.scale+')'
   scroll.scrollLeft=padX+view.x*view.scale;scroll.scrollTop=padY+view.y*view.scale
   scroll.setAttribute('aria-label','执行流程图，缩放 '+Math.round(view.scale*100)+'%，滚轮缩放，拖动空白平移')
  }
  const zoom=(scale,x,y)=>{remember();const previous=view.scale;view.scale=Math.max(.1,Math.min(3,scale));view.x+=x/previous-x/view.scale;view.y+=y/previous-y/view.scale;layout()}
  const wheel=event=>{event.preventDefault();event.stopPropagation();if(drag||!event.deltaY)return;const rect=scroll.getBoundingClientRect();zoom(view.scale*(event.deltaY<0?1.1:1/1.1),event.clientX-rect.left,event.clientY-rect.top)}
  const down=event=>{if(event.button!==0||event.target.closest('.workflow-map-node'))return;remember();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:scroll.scrollLeft,top:scroll.scrollTop};scroll.setPointerCapture(event.pointerId);scroll.classList.add('is-panning');scroll.focus();event.preventDefault()}
  const move=event=>{if(!drag||event.pointerId!==drag.id)return;scroll.scrollLeft=drag.left-(event.clientX-drag.x);scroll.scrollTop=drag.top-(event.clientY-drag.y);remember()}
  const up=()=>{if(drag&&scroll.hasPointerCapture(drag.id))scroll.releasePointerCapture(drag.id);drag=null;scroll.classList.remove('is-panning')}
  const key=event=>{if(event.target!==scroll)return;if(['+','=','-','0'].includes(event.key)){event.preventDefault();zoom(event.key==='0'?1:view.scale*(event.key==='-'?1/1.1:1.1),scroll.clientWidth/2,scroll.clientHeight/2)}}
  const initial=()=>{if(stopped||!scroll.isConnected||!scroll.clientWidth||!scroll.clientHeight)return;const selected=positions.get(runSelection);if(!view.initialized){view.x=(width-scroll.clientWidth)/2;view.initialized=true}if(pinnedSelection&&selected&&view.selection!==runSelection){view.x=selected.x+nodeWidth/2-scroll.clientWidth/(2*view.scale);view.y=Math.max(0,selected.y-scroll.clientHeight/(3*view.scale))}view.selection=runSelection;layout()}
  scroll.addEventListener('wheel',wheel,{passive:false});scroll.addEventListener('scroll',remember);scroll.addEventListener('pointerdown',down);scroll.addEventListener('pointermove',move);scroll.addEventListener('pointerup',up);scroll.addEventListener('pointercancel',up);scroll.addEventListener('lostpointercapture',up);scroll.addEventListener('keydown',key);window.addEventListener('blur',up)
  const observer=new ResizeObserver(()=>layout());observer.observe(scroll)
  frame=requestAnimationFrame(initial)
  executionMapCleanup=()=>{if(stopped)return;remember();stopped=true;cancelAnimationFrame(frame);observer.disconnect();up();window.removeEventListener('blur',up);for(const [name,handler]of [['wheel',wheel],['scroll',remember],['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up],['lostpointercapture',up],['keydown',key]])scroll.removeEventListener(name,handler);executionMapCleanup=()=>{}}
 }
 function drawExecution(result,host){
  executionMapCleanup()
  const layout=node('div',undefined,'workflow-execution-layout'),left=node('section',undefined,'workflow-execution-map'),right=node('section',undefined,'workflow-workbench')
  left.setAttribute('aria-label','执行流程图');right.setAttribute('aria-label','节点执行工作台')
  const mapHeader=node('div',undefined,'workflow-map-header')
  const mapTitle=node('div',undefined,'workflow-map-title')
  mapTitle.append(node('strong','执行路径'),node('span','共 '+result.workflow.nodes.length+' 个节点 · '+result.steps.filter(step=>step.status==='succeeded').length+' 个已完成','muted'))
  const legend=node('div',undefined,'workflow-state-legend')
  for(const [state,label] of [['done','已结束'],['active','执行中'],['pending','待执行'],['error','失败']])legend.append(node('span',label,'workflow-state-'+state))
  const toggle=button(mapCollapsed?'展开执行路径':'收起执行路径',()=>{mapCollapsed=!mapCollapsed;detailSignature='';renderDetail()},mapCollapsed?'展开执行路径':'收起执行路径')
  toggle.className='workflow-map-toggle';toggle.setAttribute('aria-expanded',String(!mapCollapsed))
  const mapSide=node('div',undefined,'workflow-map-side');mapSide.append(legend,toggle)
  if(mapCollapsed)left.classList.add('is-collapsed')
  mapHeader.append(mapTitle,mapSide)
  left.append(mapHeader)
  const scroll=node('div',undefined,'workflow-map-scroll'),stage=node('div',undefined,'workflow-map-stage'),positions=new Map(),depth=new Map()
  for(const id of result.plan){const upstream=result.workflow.edges.filter(e=>e.to===id).map(e=>depth.get(e.from)||0);depth.set(id,upstream.length?Math.max(...upstream)+1:0)}
  // Include unconnected nodes as pending; the actual dependency edges remain visible.
  for(const entry of result.workflow.nodes)if(!depth.has(entry.id))depth.set(entry.id,Math.max(0,...depth.values())+1)
  const ranks=new Map();for(const entry of result.workflow.nodes){const rank=depth.get(entry.id);if(!ranks.has(rank))ranks.set(rank,[]);ranks.get(rank).push(entry)}
  const {width:NODE_W,height:NODE_H}=readCardTheme(),GAP_X=24,GAP_Y=NODE_H+52
  const columns=Math.max(1,...[...ranks.values()].map(items=>items.length)),width=Math.max(360,columns*(NODE_W+GAP_X)+48),height=(Math.max(...depth.values())+1)*GAP_Y+48
  stage.style.width=width+'px';stage.style.height=height+'px'
  for(const [rank,entries] of ranks)entries.forEach((entry,index)=>positions.set(entry.id,{x:(width-entries.length*(NODE_W+GAP_X)+GAP_X)/2+index*(NODE_W+GAP_X),y:rank*GAP_Y+24}))
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('aria-hidden','true')
  const executionRectangles=[...positions].map(([id,p])=>({id,left:p.x,top:p.y,right:p.x+NODE_W,bottom:p.y+NODE_H})),executionEdges=[]
  result.workflow.edges.forEach((edge,id)=>{const from=positions.get(edge.from),to=positions.get(edge.to);if(from&&to)executionEdges.push({id,start:[from.x+NODE_W/2,from.y+NODE_H],end:[to.x+NODE_W/2,to.y],source:edge.from,target:edge.to,startDirection:'down',endDirection:'up'})})
  const executionRoutes=window.workflowLinkRouting.create(executionRectangles).routeAll(executionEdges)
  for(const edge of executionEdges){const points=executionRoutes.get(edge.id);if(!points)continue;const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',window.workflowLinkRouting.svgPath(window.workflowLinkRouting.commands(points,executionRectangles)));svg.append(path)}
  stage.append(svg)
  for(const entry of result.workflow.nodes){const step=result.steps.find(s=>s.id===entry.id),pos=positions.get(entry.id),state=executionState(step),isWaiting=step&&step.status==='waiting';const card=button('',()=>{runSelection=entry.id;pinnedSelection=true;detailSignature='';renderDetail()},entry.title+' · '+executionLabel(step));card.className='workflow-map-node workflow-state-'+state+(isWaiting?' is-waiting':'')+(runSelection===entry.id?' selected':'');card.setAttribute('aria-pressed',String(runSelection===entry.id));card.style.left=pos.x+'px';card.style.top=pos.y+'px';card.style.width=NODE_W+'px';card.style.height=NODE_H+'px';card.append(node('span',result.plan.includes(entry.id)?String(result.plan.indexOf(entry.id)+1).padStart(2,'0'):'—','workflow-map-index'),nodeTitle(entry),node('span',executionLabel(step),'workflow-map-state'),node('small',((data.nodes.find(n=>n.type===entry.type)||{}).name||entry.type)+(interactionName(entry.interaction)?' · '+interactionName(entry.interaction):''),'workflow-map-type'));stage.append(card)}
  left.append(scroll);layout.append(left,right);host.append(layout)
  attachExecutionViewport(scroll,stage,width,height,result,positions,NODE_W)
  const entry=result.workflow.nodes.find(n=>n.id===runSelection),step=result.steps.find(s=>s.id===runSelection)
  if(!entry){right.append(node('p','选择左侧节点查看执行过程。'));return}
  const propertyHeader=node('header',undefined,'workflow-property-header'),context=node('div',undefined,'workflow-workbench-context'),propertyTitle=node('div',undefined,'workflow-node-title'),index=result.plan.indexOf(entry.id)
  context.append(node('span','节点工作台'),node('span',(index<0?'未纳入执行路径':'步骤 '+String(index+1).padStart(2,'0')+' / '+result.plan.length)+(interactionName(entry.interaction)?' · 人工'+interactionName(entry.interaction):'')));propertyTitle.append(node('h2',entry.title),node('span',executionLabel(step),'workflow-status-pill workflow-status-'+executionState(step)));propertyHeader.append(context,propertyTitle);right.append(propertyHeader)
  const workbenchBody=node('div',undefined,'workflow-workbench-body');right.append(workbenchBody)

  const history=node('details',undefined,'workflow-node-evidence');history.append(node('summary','节点输入与执行记录'));const propertyContent=node('div');history.append(propertyContent)
  if(entry.description)propertyContent.append(node('p',entry.description))
  if(step&&step.attempt)propertyContent.append(node('p','第 '+step.attempt+' 次尝试'+(step.agentSessionId?' · Agent '+step.agentSessionId:''),'muted'))
  if(step&&step.partial)propertyContent.append(node('pre',step.partial))
  if(step&&step.data!==undefined){const details=node('details');details.append(node('summary','结构化结果'),node('pre',JSON.stringify(step.data,null,2)));propertyContent.append(details)}
  if(step&&['failed','interrupted','paused','waiting'].includes(result.status)&&!['pending','skipped'].includes(step.status))propertyContent.append(button('从此步骤重试',async()=>{if(!await window.appDialogs.confirm('从“'+entry.title+'”重新执行？此步及下游的当前结果将失效，历史尝试保留。若涉及工具或外部接口，请先核查中间结果及外部操作是否已完成。'))return;await api('retry',{id:result.id,nodeId:entry.id,confirmExternal:true});pinnedSelection=false;detailSignature='';await refresh()}))
  if(step&&step.input)propertyContent.append(node('pre',step.input));if(step&&step.output)propertyContent.append(node('pre',step.output));if(step&&step.error)propertyContent.append(node('p',step.error,'workflow-error'));for(const file of step&&step.files||[])propertyContent.append(node('p','附件：'+file.name));
  if(step&&step.timeline&&step.timeline.length){const records=node('details'),list=node('ul');records.append(node('summary','执行记录'));for(const fact of step.timeline){const row=node('li',new Date(fact.at).toLocaleTimeString()+' · '+fact.message);if(fact.output)row.append(node('pre',fact.output));list.append(row)}records.append(list);propertyContent.append(records)}
  const task=node('section',undefined,'workflow-current-task'),waiting=result.steps.find(s=>s.status==='waiting'),waitingEntry=waiting&&result.workflow.nodes.find(n=>n.id===waiting.id)
  const taskHead=node('div',undefined,'workflow-task-heading'),taskTitle=node('div');taskTitle.append(node('h3',waiting?(waiting.id===runSelection?'当前待办':'当前待办 · '+waiting.title):'当前待办'))
  taskHead.append(taskTitle);task.append(taskHead)

  for(const key of taskForms.keys())if(key.startsWith(result.id+':')&&(!waiting||key!==result.id+':'+waiting.taskId))taskForms.delete(key)
  if(waiting){
   const analyze=button('打开会话分析',()=>window.workflowChat.open({workflowId:result.workflowId,runId:result.id,nodeId:waiting.id,name:result.name,nodeTitle:waiting.title}));analyze.prepend(glyph('customize'));analyze.className='workflow-analyze-action';taskHead.append(analyze)
   if(waiting.id!==runSelection){const locate=button('',()=>{runSelection=waiting.id;pinnedSelection=false;detailSignature='';renderDetail()},'定位当前待办节点：'+waiting.title);locate.className='workflow-locate-action';locate.append(glyph('wf-fit'));taskTitle.classList.add('workflow-current-task-title');taskTitle.append(locate)}
   const taskActions=renderHumanForm(result,waitingEntry,waiting,task);if(taskActions)right.append(taskActions)
  }else task.append(node('p',result.status==='running'?'系统正在自动处理，无需人工操作。':result.status==='pending'?'等待执行。':'此实例当前没有待办。','muted'))
  if(step&&step.output)propertyContent.append(button('复制结果',()=>copyText(step.output)))
  workbenchBody.append(task,history);renderArtifacts(result,workbenchBody)
 }
 function filePayload(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:String(reader.result).split(',')[1]||''});reader.onerror=()=>reject(Error('文件读取失败：'+file.name));reader.readAsDataURL(file)})}
function buildHumanTask(options){
 const {entry,interaction,modes,schema,view,step,flowView,formId}=options
 const form=node('form'),inputLabel=node('label',undefined,'workflow-upload-field'),uploadHeading=node('span','附件'+(modes.includes('upload')?'（必填）':'（可选）'),'workflow-field-label'),zone=node('span',undefined,'workflow-upload-zone'),zoneText=node('span',undefined,'workflow-upload-copy'),files=node('input')
 form.id=formId
 files.type='file';files.multiple=true;files.required=modes.includes('upload')&&!((step&&step.returnFiles)||[]).length;files.setAttribute('aria-label','添加附件')
 const hint=node('span','最多 3 个文件，合计 512 KB','workflow-upload-hint');hint.id=formId+'UploadHint'
 zoneText.append(node('strong','点击选择或拖入文件'),hint);zone.append(glyph('upload'),zoneText,files);inputLabel.append(uploadHeading,zone)
 const selectedList=node('ul',undefined,'workflow-selected-files');selectedList.setAttribute('aria-label','已选附件');selectedList.setAttribute('aria-live','polite')
 const fileNote=node('details',undefined,'workflow-file-note');fileNote.append(node('summary','附件如何传递？'),node('p','TXT、Markdown、JSON、CSV 等文本附件提取前 16000 字传给后续步骤，其他格式保留文件引用。'))
 const label=node('label',undefined,'workflow-conclusion-field'),conclusion=node('textarea');label.append(node('span',modes.includes('approval')?'审批意见（必填）':'处理结论（必填）','workflow-field-label'));conclusion.rows=4;conclusion.maxLength=16000;conclusion.required=true;conclusion.placeholder=modes.includes('approval')?'说明审批意见、判断依据或需要修改的内容…':'填写你的判断、结论或需要补充的说明…';label.append(conclusion)
 const error=node('p',undefined,'workflow-error');error.id=formId+'Error';error.setAttribute('role','alert');conclusion.setAttribute('aria-describedby',error.id);files.setAttribute('aria-describedby',hint.id+' '+error.id)
 function setFiles(list){
  if(list.length>3||list.reduce((sum,file)=>sum+file.size,0)>512*1024){error.textContent='最多 3 个附件，合计不能超过 512KB。';files.setAttribute('aria-invalid','true');return false}
  const transfer=new DataTransfer();for(const file of list)transfer.items.add(file);files.files=transfer.files;error.textContent='';files.removeAttribute('aria-invalid');renderSelected();return true
 }
 function renderSelected(){selectedList.textContent='';for(const [index,file]of Array.from(files.files||[]).entries()){const row=node('li'),name=node('span',file.name),size=node('small',formatBytes(file.size),'muted'),remove=button('',()=>setFiles(Array.from(files.files).filter((_,i)=>i!==index)),'移除附件 '+file.name);remove.append(glyph('close'));name.title=file.name;row.append(glyph('file'),name,size,remove);selectedList.append(row)}}
 files.addEventListener('change',()=>{const list=Array.from(files.files||[]);if(!setFiles(list)){files.value='';renderSelected()}})
 zone.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();zone.classList.add('is-dragging')})
 zone.addEventListener('dragleave',event=>{if(!zone.contains(event.relatedTarget))zone.classList.remove('is-dragging')})
 zone.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();zone.classList.remove('is-dragging');setFiles(Array.from(files.files||[]).concat(Array.from(event.dataTransfer&&event.dataTransfer.files||[])))})
 const decision=node('fieldset',undefined,'workflow-decision'),legend=node('legend','审批结论');decision.append(legend)
 let reviewReject=false
 const choice=()=>{if(interaction&&interaction.type==='review'&&reviewReject)return 'reject';const picked=decision.querySelector('input[name=workflowDecision]:checked');return picked?picked.value:''}
 let reason=null,reasonLabel=null
 if(modes.includes('approval'))for(const [value,title] of [['approve',interaction?'通过并继续':'通过'],['reject',interaction?'驳回并退回修改':'不通过']]){const row=node('label',undefined,'workflow-radio'),radio=node('input');radio.type='radio';radio.name='workflowDecision';radio.value=value;radio.required=true;if(interaction&&value==='approve')radio.checked=true;row.append(radio,document.createTextNode(title));if(value==='reject'&&interaction&&flowView&&!flowView.canReject){radio.disabled=true;row.title='没有可退回的上游人工办理环节';row.classList.add('is-disabled')}decision.append(row)}
 if(interaction&&['approve','review'].includes(interaction.type)){
  reasonLabel=node('label',undefined,'workflow-conclusion-field');reasonLabel.append(node('span','驳回原因（必填）','workflow-field-label'))
  reason=node('textarea');reason.rows=4;reason.maxLength=16000;reason.placeholder='说明需要修改的内容与依据，退回后由上游办理环节重新提交…'
  reasonLabel.append(reason);reasonLabel.hidden=true;decision.append(reasonLabel)
  const target=flowView&&flowView.returnTargetTitle
  decision.append(node('p',target?'驳回后退回「'+target+'」修改；原有处理记录与已交付的产物版本都会保留。':'没有可退回的上游人工办理环节，此节点只能通过。','muted'))
 }
 if(interaction&&interaction.type==='review'){legend.textContent='退回修改';decision.hidden=true}
 const reviewed=node('input');reviewed.type='checkbox';reviewed.required=modes.includes('read')&&!interaction
 const attachmentBlock=node('div',undefined,'workflow-processing-block');attachmentBlock.append(inputLabel,selectedList,fileNote)
 const reused=new Set(((step&&step.returnFiles)||[]).map(f=>f.ref))
 if(reused.size){const previous=node('div',undefined,'workflow-reused-files');previous.append(node('p','上轮附件已保留，可继续使用或移除后重新上传。','muted'));for(const file of step.returnFiles){const row=node('label',undefined,'workflow-radio'),check=node('input');check.type='checkbox';check.checked=true;check.addEventListener('change',()=>{if(check.checked)reused.add(file.ref);else reused.delete(file.ref);files.required=modes.includes('upload')&&!reused.size});row.append(check,document.createTextNode(file.name+' · '+formatBytes(file.size)));previous.append(row)}attachmentBlock.prepend(previous)}
 let readValues=null
 for(const block of view.blocks){
  if(block.type==='instructions'&&(block.text||(step&&step.waitReason)||entry.text)){const requirements=node('details',undefined,'workflow-task-requirements workflow-processing-block');requirements.open=true;requirements.append(node('summary',block.title||'处理要求'),node('p',block.text||(step&&step.waitReason)||entry.text||'请查看本步骤资料后继续。'));form.append(requirements)}
  if(block.type==='reference'){const reference=node('section',undefined,'workflow-processing-block workflow-processing-reference');reference.append(node('h4',block.title||'参考资料'),node('pre',String(block.source==='partial'?(step&&step.partial)||'暂无中间结果':(step&&step.input)||'暂无上游输入')));form.append(reference)}
  if(block.type==='form'&&schema)readValues=window.workflowForms.render(form,schema,step?(step.partialData||step.inputData):undefined,block.title)
  if(block.type==='attachments'){uploadHeading.textContent=(block.title||'附件')+(modes.includes('upload')?'（必填）':'（可选）');form.append(attachmentBlock)}
  if(block.type==='conclusion'){conclusion.required=block.required!==false;label.firstChild.textContent=(block.title||(modes.includes('approval')?'审批意见':'处理结论'))+(conclusion.required?'（必填）':'（可选）');form.append(label)}
 }
 if(modes.includes('approval')||interaction&&interaction.type==='review'&&flowView&&flowView.canReject)form.append(decision)
 if(modes.includes('read')&&!interaction){const readLabel=node('label',undefined,'workflow-radio workflow-review-confirm');readLabel.append(reviewed,document.createTextNode('我已审阅资料和相关节点的执行记录'));form.append(readLabel)}
 const actions=node('div',undefined,'workflow-task-actions'),submitTitle=interaction?(interaction.type==='approve'?'通过并继续':interaction.type==='review'?'已审阅，继续':'完成并继续'):(step&&step.waitKind==='agent'?'补充并重新执行 Agent':view.blocks.some(b=>['form','attachments','conclusion'].includes(b.type))?'提交并继续':'确认并继续'),submit=node('button',submitTitle);submit.type='submit';submit.setAttribute('form',form.id);submit.append(glyph('chevron-right'));actions.append(node('span',interaction&&interaction.type==='approve'?'通过后进入下一步，驳回则退回修改':'确认后进入下一步','muted'),submit)
 const fieldsBeforeDecision=Array.from(form.querySelectorAll('input,textarea,select')).filter(field=>!decision.contains(field)),initialDisabled=new Map(fieldsBeforeDecision.map(field=>[field,field.disabled]))
 const sync=()=>{const rejected=choice()==='reject';if(interaction&&interaction.type==='review')decision.hidden=!rejected;if(reasonLabel)reasonLabel.hidden=!rejected;if(reason)reason.required=rejected;for(const field of fieldsBeforeDecision)field.disabled=rejected||initialDisabled.get(field);submit.textContent=rejected?'驳回并退回':submitTitle;submit.append(glyph('chevron-right'))}
 if(interaction&&modes.includes('approval'))for(const radio of decision.querySelectorAll('input[name=workflowDecision]'))radio.addEventListener('change',sync)
 if(interaction&&interaction.type==='review'&&flowView&&flowView.canReject){const reject=button('驳回',()=>{reviewReject=!reviewReject;reject.textContent=reviewReject?'取消驳回':'驳回';sync();if(reviewReject)reason.focus()});reject.className='workflow-review-reject';actions.insertBefore(reject,submit)}
 form.append(error)
 return {form,error,files,label,conclusion,reason,decision,choice,reviewed,reused,submit,submitTitle,sync,actions,readValues:()=>readValues}
}
function humanTaskView(entry,step,result){
 const interaction=entry&&entry.type==='human'&&entry.interaction&&(!step||(step.waitKind!=='agent'&&step.waitKind!=='evaluation'))?entry.interaction:null
 const flowView=interaction&&result?result.interactionViews&&result.interactionViews[step.id]:null
 const modes=interaction?[interaction.type==='approve'?'approval':interaction.type==='review'?'read':'review',...(humanModes(entry).includes('upload')?['upload']:[])]:(step&&step.waitKind==='agent')?['review']:(step&&step.waitKind==='evaluation')?['review','approval','read']:humanModes(entry||{})
 const schema=step&&step.waitKind==='agent'?null:step&&step.waitKind==='evaluation'?entry.outputSchema:entry.inputSchema
 const view=result&&result.processingViews&&result.processingViews[step.id]||entry.processing||{version:1,blocks:[{type:'instructions'},...(schema?[{type:'form'}]:[]),{type:'attachments'},{type:'conclusion',required:true}]}
 return {interaction,flowView,modes,schema,view}
}
function renderHumanForm(result,entry,step,task){
 const key=result.id+':'+step.taskId
 const {interaction,flowView,modes,schema,view}=humanTaskView(entry,step,result)
 if(taskForms.has(key)){const cached=taskForms.get(key);task.append(cached.content);return cached.actions}
 const content=node('div'),cached={content,actions:null};task.append(content);task=content;taskForms.set(key,cached)
 content.className='workflow-human-content'
 const built=buildHumanTask({entry,interaction,modes,schema,view,step,flowView,formId:'workflowTaskForm-'+result.id+'-'+step.taskId})
 const {form,error,files,label,conclusion,reason,choice,reviewed,reused,submit,sync}=built
 cached.actions=built.actions
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(submit.disabled)return;error.textContent='';submit.disabled=true;submit.textContent='正在提交…';form.setAttribute('aria-busy','true')
  try{const selected=Array.from(files.files||[]);if(selected.length>3||selected.reduce((sum,file)=>sum+file.size,0)>512*1024)throw Error('最多3个附件，总大小不能超过512KB');files.removeAttribute('aria-invalid')
   const approvable=modes.includes('approval'),rejected=!!interaction&&choice()==='reject'||approvable&&choice()==='reject'
   if(approvable&&!choice())throw Error(interaction?'请选择通过或驳回':'请选择通过或不通过')
   if(rejected&&reason&&!reason.value.trim())throw Error('请填写驳回原因（最多16000字）')
   const payload=rejected&&interaction?[]:await Promise.all(selected.map(filePayload)),values=built.readValues()
   await api('submit',{id:result.id,nodeId:step.id,taskId:step.taskId,conclusion:rejected&&reason?reason.value:label.isConnected?conclusion.value:'',values:rejected&&interaction?undefined:values?values():undefined,reuseFiles:rejected&&interaction?[]:Array.from(reused),reviewed:reviewed.checked||!!(interaction&&interaction.type==='review'),decision:approvable||rejected?choice():'confirm',files:payload})
   // 退回信息由实例头部的退回横幅承载，页面顶部不再重复提示。
   pinnedSelection=false;detailSignature='';notice('')
   await refresh()
  }catch(e){error.textContent=e.message}finally{submit.disabled=false;sync();form.removeAttribute('aria-busy')}
 })
 task.append(form);return built.actions
}

 async function renderDetail(){
  const id=activeRun;if(!id)return
  const result=await api('detail',{id});if(mode!=='detail'||id!==activeRun)return
  const signature=JSON.stringify(result);if(signature===detailSignature)return;detailSignature=signature;runDetail=result
  if(!pinnedSelection||!result.workflow.nodes.some(n=>n.id===runSelection))runSelection=(result.steps.find(s=>['running','waiting','failed'].includes(s.status))||result.steps.find(s=>s.status==='pending')||result.steps[0]||{}).id
  const host=$('workflowRunDetail');executionMapCleanup();host.textContent=''
  const runState=result.status==='succeeded'?'done':result.status==='failed'?'error':['running','waiting','paused'].includes(result.status)?'active':'pending'
  const head=node('header',undefined,'workflow-detail-heading')
  const titleWrap=node('div',undefined,'workflow-detail-title')
  const titleRow=node('div',undefined,'workflow-detail-title-row')
  const heading=node('h1',result.name);heading.id='workflowDetailHeading';heading.title=result.name;titleRow.append(heading,node('span',labels[result.status]||result.status,'workflow-status-pill workflow-status-'+runState))
  const meta=node('p','实例 #'+String(result.id).slice(0,8)+' · 版本 v'+result.revision+' · '+result.workflow.nodes.length+' 个节点','workflow-detail-meta');meta.title='实例 '+result.id;titleWrap.append(titleRow,meta)
  const actions=node('div',undefined,'workflow-detail-actions');actions.setAttribute('role','group');actions.setAttribute('aria-label','实例操作')
  if(['pending','running','waiting','paused'].includes(result.status))actions.append(button('停止执行',async()=>{await api('stop',{id});detailSignature='';await refresh()}))
  else if(data.workflows.some(w=>w.id===result.workflowId))actions.append(button('再次执行',async()=>{const next=await startRun(data.workflows.find(w=>w.id===result.workflowId));if(!next)return;activeRun=next.id;runSelection='';pinnedSelection=false;detailSignature='';await refresh()}))
  if(result.status==='running')actions.append(button(result.pauseRequested?'等待当前步骤结束后暂停':'暂停',async()=>{await api('pause',{id});detailSignature='';await refresh()}))
  if(result.status==='paused')actions.append(button(result.externalConfirm&&result.externalConfirm.length?'已核查，继续执行':'继续执行',async()=>{
   let confirmExternal=false
   if(result.externalConfirm&&result.externalConfirm.length){
    const key=result.replayGuard?result.replayGuard.nodeId:result.plan.find(id=>result.externalConfirm.includes(id)),entry=result.steps.find(s=>s.id===key),names=entry?entry.title:key
    if(!await window.appDialogs.confirm('重新执行会再次调用外部接口或工具：'+names+'。\n\n请先确认上一次调用与中间结果，确实需要重放时再继续。'))return
    confirmExternal=true
   }
   await api('resume',{id,confirmExternal});detailSignature='';await refresh()}))
  actions.append(controls.close);head.append(controls.back,titleWrap,actions)
  host.append(head);page.classList.add('workflow-detail-ready');page.setAttribute('aria-labelledby',heading.id)
  if(result.returnedFrom){
   const returned=node('div',undefined,'workflow-return-banner')
   const copy=node('div');copy.append(node('strong','「'+result.returnedFrom.title+'」驳回，退回「'+result.returnedFrom.targetTitle+'」修改'),node('p',result.returnedFrom.reason,'muted'))
   returned.append(glyph('wf-marquee'),copy);host.append(returned)
  }
  if(result.externalConfirm&&result.externalConfirm.length)host.append(node('p','退回后需要重新执行外部操作：'+result.externalConfirm.map(key=>{const entry=result.steps.find(s=>s.id===key);return entry?entry.title:key}).join('、')+'。核查上一次调用与中间结果后点“已核查，继续执行”。','workflow-checkpoint-note'))
  if(result.error)host.append(node('p',result.error,'workflow-error'))
  drawExecution(result,host)
 }
 function renderExecutionSummary(n){
  const host=$('workflowExecutionSummary'),preview=$('workflowExecutionMiniPreview'),supported=!!n&&!['start','end','input','output'].includes(n.type.split('/')[1])
  host.classList.toggle('hidden',!supported);$('workflowExecutionDesign').disabled=!supported;preview.textContent=''
  if(!supported)return
  const props=n.properties,human=n.type==='workflow/human',schema=props.inputSchema,blocks=(props.processing&&props.processing.blocks)||[],names=[]
  if(schema)names.push('表单 '+Object.keys(schema.properties||{}).length+' 项')
  if(blocks.some(b=>b.type==='attachments')||humanModes(props).includes('upload'))names.push('文件上传')
  if(blocks.some(b=>b.type==='conclusion'))names.push(blocks.find(b=>b.type==='conclusion').title||'备注')
  if(human)names.push(interactionName(props.interaction)||'保留原有处理方式')
  $('workflowExecutionSummaryText').textContent=human?(names.join(' · ')||'备注 · 审阅批复'):'自动执行 · 可用 AI 设计执行要求与数据规范'
  if(human){const entry={...props,id:props.workflowId,type:'human',title:n.title},interaction=props.interaction||{version:1,type:interactionPreset(props)},modes=humanModes(props),view=props.processing||{version:1,blocks:[{type:'instructions'},...(schema?[{type:'form'}]:[]),...(modes.includes('upload')?[{type:'attachments'}]:[]),{type:'conclusion',title:'备注',required:!props.interaction}]},target=detectRejectTarget(editorDefinition(),props.workflowId).detected,built=buildHumanTask({entry,interaction,modes,schema,view,step:null,flowView:{canReject:!!target,returnTargetTitle:target&&target.title},formId:'workflowPropertyPreview'});const content=node('section',undefined,'workflow-current-task');content.append(built.form);preview.append(content,built.actions);preview.onsubmit=event=>event.preventDefault()}
 }
 $('workflowExecutionDesign').addEventListener('click',async()=>{
  const target=selectedNode;if(!target)return
  if(!window.workflowExecutionDesigner){notice('执行设计面板尚未加载');return}
  const definition=editorDefinition(),entry=definition.nodes.find(n=>n.id===target.properties.workflowId)
  try{await window.workflowExecutionDesigner.open({node:entry,workflow:definition,onApply:async design=>{
   if(!graph||!graph._nodes.includes(target))throw Error('当前节点已变更，请重新打开执行设计')
   const props=target.properties;props.text=design.instruction||''
   for(const key of ['interaction','inputSchema','outputSchema','processing','bindings']){if(design[key]===undefined||design[key]===null)delete props[key];else props[key]=JSON.parse(JSON.stringify(design[key]))}
   if(target.type==='workflow/human'&&props.interaction){props.humanKind=props.interaction.type==='approve'?'approval':props.interaction.type==='review'?'read':'review';props.humanModes=[props.humanKind,...((props.processing&&props.processing.blocks||[]).some(b=>b.type==='attachments'&&b.required)?['upload']:[])]}
   if(props.schemaErrors)for(const key of ['inputSchema','outputSchema','bindings'])delete props.schemaErrors[key]
   dirty=true;parameter(target);graph.setDirtyCanvas(true,true);notice('执行设计已应用到当前草稿，请保存流程。')
  }})}catch(error){notice(error.message)}
 })
 $('workflowSimulate').addEventListener('click',()=>{if(window.workflowSimulation)window.workflowSimulation.open({workflow:editorDefinition()}).catch(error=>notice(error.message));else notice('自测面板尚未加载')})
 // 已取消「高级设置」折叠：步骤说明／结构化参数／端口，以及交互类型与补充内容，全部收进「节点执行设计 → 节点配置」。
 function register(){
  if(typeof LiteGraph==='undefined')return
  cardTheme=readCardTheme()
  LiteGraph.registered_node_types={}
  const defs=(data.nodes&&data.nodes.length)?data.nodes:FALLBACK_NODES
  for(const def of defs){
   function N(){
    this.addProperty('text','')
    if(!['input','start'].includes(def.type))this.addInput('输入1','text')
    if(!['output','end'].includes(def.type))this.addOutput('文本','text')
    this.size=this.computeSize();this.resizable=false
    applyNodeTheme(this)
   }
   N.title=def.name
   N.collapsable=false
   N.prototype.computeSize=function(out){const size=out||[0,0],custom=this.properties&&this.properties.cardSize;size[0]=custom?custom[0]:cardTheme.width;size[1]=Math.max(custom?custom[1]:cardTheme.height-LiteGraph.NODE_TITLE_HEIGHT,Math.max((this.inputs||[]).length,(this.outputs||[]).length)*LiteGraph.NODE_SLOT_HEIGHT+22);return size}
   N.prototype.onConnectionsChange=function(){dirty=true;queuePortSync(this)}
   LiteGraph.registerNodeType('workflow/'+def.type,N)
   LiteGraph.registered_node_types['workflow/'+def.type].title=def.name
  }
 }
 function ancestorsOf(target){
 const found=new Set(),queue=[target]
 while(queue.length){
  const current=queue.shift()
  for(const input of current.inputs||[]){
   const link=input.link===null||input.link===undefined?null:graph.links[input.link]
   const from=link?graph.getNodeById(link.origin_id):null
   if(from&&from!==target&&!found.has(from)){found.add(from);queue.push(from)}
  }
 }
 return [...found]
}
function upstreamHumans(workflow,nodeId){
  const nodes=new Map(((workflow&&workflow.nodes)||[]).map(entry=>[entry.id,entry])),incoming=new Map()
  for(const edge of (workflow&&workflow.edges)||[]){if(!incoming.has(edge.to))incoming.set(edge.to,[]);incoming.get(edge.to).push(edge.from)}
  const seen=new Set([nodeId]),queue=[[nodeId,0]],found=[]
  while(queue.length){const [id,distance]=queue.shift();for(const from of incoming.get(id)||[]){if(seen.has(from))continue;seen.add(from);const entry=nodes.get(from);if(!entry)continue;if(entry.type==='human')found.push({id:entry.id,title:entry.title||'人工节点',distance:distance+1});queue.push([from,distance+1])}}
  return found.sort((a,b)=>a.distance-b.distance)
}
// 驳回退回目标按连线识别：默认取最近的上游人工节点，也可在设计里显式指定。
function detectRejectTarget(workflow,nodeId){const candidates=upstreamHumans(workflow,nodeId);return {candidates,detected:candidates[0]||null}}
function nextNodeId(type){
  const prefix=String(type||'node').replace(/[^a-zA-Z0-9_-]/g,'_')
  const used=new Set((graph&&Array.isArray(graph._nodes)?graph._nodes:[]).map(n=>(n.properties&&n.properties.workflowId)||('node_'+n.id)))
  let index=1
  while(used.has(prefix+'_'+index))index++
  return prefix+'_'+index
 }
 function parameter(n){
  selectedNode=n
  const panel=page.querySelector('.workflow-parameters');if(panel){panel.classList.toggle('is-empty',!n);panel.classList.toggle('is-flow',!n)}$('workflowFlowProperties').hidden=!!n
  const human=!!n&&n.type==='workflow/human'
  $('workflowNodeTitle').value=n?n.title:''
  $('workflowNodeText').value=n?(n.properties.text||(human?n.properties.description:'')||''):''
  $('workflowNodeText').rows=human?4:12
  $('workflowNodeTextField').classList.toggle('is-human',human)
  $('workflowNodeTextLabel').textContent=human?'处理描述':'执行指令'
  $('workflowNodeTitle').disabled=!n
  $('workflowNodeText').disabled=!n
  $('workflowRemoveNode').disabled=!n
  renderExecutionSummary(n)
  $('workflowNodeDescription').value=n?(n.properties.description||''):''
  $('workflowNodeDescription').disabled=!n
  // 属性面板只保留名称/指令/执行操作；补充内容收进「节点执行设计 → 更多设置」，交互类型与驳回退回在预览上方。
  $('workflowHumanExtras').classList.add('hidden')
  // 交互类型只在「节点执行设计」里改；这里仅按已有处理方式给出一句状态描述。
  const preset=n?interactionPreset(n.properties):'handle'
  $('workflowNodeAdvanced').hidden=true
  $('workflowNodeDescriptionField').classList.toggle('hidden',human&&(!n.properties.description||n.properties.description===n.properties.text))
  $('workflowNodeDescriptionLabel').textContent='步骤说明'
  $('workflowRestOptions').classList.toggle('hidden',!n||n.type!=='workflow/rest')
  $('workflowRestUrl').value=n&&n.properties.rest?n.properties.rest.url:''
  for(const radio of document.querySelectorAll('[name=workflowRestMethod]'))radio.checked=!!n&&radio.value===(n.properties.rest&&n.properties.rest.method||'GET')
  renderStructured(n)
  renderHumanExtras(n)
  if(stepsMode)renderSteps()
  $('workflowNodeMode').textContent=n?(human?{handle:'人工办理 · 完成后继续',review:'人工审阅 · 已阅后继续',approve:'人工审批 · 通过或驳回'}[preset]:'自动执行 · 完成后继续'):'选择节点查看配置'
  const hint=$('workflowParamHint')
  if(hint){
   const type=n&&typeof n.type==='string'?n.type.split('/')[1]:''
   hint.textContent=PARAM_HINTS[type]||'文本整理或 AI 节点可用 {{input}}、{{input1}}、{{input2}} 引用上游内容。拖动端口连线，选中节点后修改参数。'
  }
 }
 function processingForEditor(props){return props.processing||{version:1,blocks:[{type:'instructions'},...(props.inputSchema?[{type:'form'}]:[]),...(props.interaction?[]:[{type:'attachments'},{type:'conclusion',required:true}])]}}
 function renderHumanExtras(n){
  const host=$('workflowSimpleExtras');host.textContent='';if(!n||n.type!=='workflow/human'||!n.properties.interaction)return
  const props=n.properties,config=processingForEditor(props),has=type=>config.blocks.some(b=>b.type===type)
  const change=fn=>{if(!props.processing)props.processing=JSON.parse(JSON.stringify(config));fn(props.processing);dirty=true}
  const rerender=()=>{renderHumanExtras(n);renderStructured(n);$('workflowHumanExtras').open=true}
  const optional=(title,checked,fn)=>{const label=node('label',undefined,'workflow-radio'),input=node('input');input.type='checkbox';input.checked=checked;input.addEventListener('change',()=>fn(input.checked));label.append(input,document.createTextNode(title));host.append(label);return input}
  optional('允许添加附件',has('attachments'),checked=>{change(c=>{c.blocks=c.blocks.filter(b=>b.type!=='attachments');if(checked)c.blocks.push({type:'attachments',title:'附件'})});if(!checked)props.humanModes=humanModes(props).filter(m=>m!=='upload');rerender()})
  if(has('attachments'))optional('必须上传附件',humanModes(props).includes('upload'),checked=>{props.humanModes=humanModes(props).filter(m=>m!=='upload');if(checked)props.humanModes.push('upload');dirty=true})
  optional('填写补充意见（可选）',has('conclusion'),checked=>{change(c=>{c.blocks=c.blocks.filter(b=>b.type!=='conclusion');if(checked)c.blocks.push({type:'conclusion',title:'补充意见',required:false})});rerender()})
  const group=node('fieldset',undefined,'workflow-simple-fields');group.append(node('legend','填写项'))
  for(const [key,field]of Object.entries(props.inputSchema&&props.inputSchema.properties||{})){
   const row=node('div',undefined,'workflow-simple-field'),label=node('label','名称'),title=node('input');title.value=field.title||key;title.maxLength=120;title.addEventListener('input',()=>{field.title=title.value;dirty=true});label.append(title);row.append(label)
   const requiredLabel=node('label',undefined,'workflow-radio'),required=node('input');required.type='checkbox';required.checked=(props.inputSchema.required||[]).includes(key);required.addEventListener('change',()=>{props.inputSchema.required=(props.inputSchema.required||[]).filter(v=>v!==key);if(required.checked)props.inputSchema.required.push(key);dirty=true});requiredLabel.append(required,document.createTextNode('必填'));row.append(requiredLabel)
   row.append(button('移除',()=>{delete props.inputSchema.properties[key];props.inputSchema.required=(props.inputSchema.required||[]).filter(v=>v!==key);if(props.bindings)delete props.bindings[key];if(!Object.keys(props.inputSchema.properties).length){props.inputSchema=null;change(c=>{c.blocks=c.blocks.filter(b=>b.type!=='form')})}dirty=true;rerender()},'移除填写项 '+(field.title||key)));group.append(row)
  }
  const add=button('添加填写项',()=>{props.inputSchema=props.inputSchema||{type:'object',properties:{},required:[],additionalProperties:false};props.inputSchema.properties=props.inputSchema.properties||{};let index=1;while(props.inputSchema.properties['field_'+index])index++;props.inputSchema.properties['field_'+index]={type:'string',title:'填写项 '+index,maxLength:16000};change(c=>{if(!c.blocks.some(b=>b.type==='form'))c.blocks.push({type:'form',title:'处理表单'})});rerender()});add.disabled=Object.keys(props.inputSchema&&props.inputSchema.properties||{}).length>=24;group.append(add,node('p','新增项默认为文本；复杂字段可在「节点执行设计」中调整。','muted'));host.append(group)
 }
 async function startRun(flow){
  if(!flow)return null
  const agents=flow.nodes.filter(n=>['agent','tool'].includes(n.type))
  if(agents.length&&!await window.appDialogs.confirm('确认执行“'+flow.name+'”？\n\n'+agents.map(n=>n.title+'：'+(n.type==='tool'?n.tool.name:((n.agent&&n.agent.tools)||[]).join('、')||'无工具')+(n.type==='tool'?'；固定调用一次':'；最多'+(n.agent&&n.agent.maxSteps||6)+'轮、'+(n.agent&&n.agent.maxRequests||6)+'次模型请求、'+(n.agent&&n.agent.maxToolCalls||8)+'次工具调用')+'；超时'+Math.round((n.agent&&n.agent.timeoutMs||120000)/1000)+'秒；'+((n.type==='tool'?n.tool.permission:n.agent&&n.agent.permission)==='workspace'?'允许工作目录内修改':'只读')).join('\n')+'\n\n人工步骤会等待确认，Agent 内部不会请求人工授权。'))return null
  return api('run',{id:flow.id,confirmed:true})
 }
 function positionSteps(){for(const [index,n]of graph._nodes.entries())n.pos=[48+index*(cardTheme.width+72),120]}
 function arrangeGraph(){
  if(!graph||!graph._nodes.length)return
  const nodes=graph._nodes.slice(),degree=new Map(nodes.map(n=>[n.id,0])),children=new Map(nodes.map(n=>[n.id,[]])),rank=new Map(nodes.map(n=>[n.id,0]))
  for(const link of Object.values(graph.links).filter(Boolean)){degree.set(link.target_id,(degree.get(link.target_id)||0)+1);if(children.has(link.origin_id))children.get(link.origin_id).push(link.target_id)}
  const queue=nodes.filter(n=>!degree.get(n.id)).map(n=>n.id),ordered=[]
  while(queue.length){const id=queue.shift();ordered.push(id);for(const next of children.get(id)||[]){rank.set(next,Math.max(rank.get(next)||0,(rank.get(id)||0)+1));degree.set(next,degree.get(next)-1);if(!degree.get(next))queue.push(next)}}
  if(ordered.length!==nodes.length){notice('请先移除循环连线，再整理布局。');return}
  const columns=new Map();for(const id of ordered){const depth=rank.get(id);if(!columns.has(depth))columns.set(depth,[]);columns.get(depth).push(graph.getNodeById(id))}
  for(const [depth,list]of columns){let y=100;for(const n of list){n.pos=[48+depth*(cardTheme.width+72),y];y+=n.size[1]+LiteGraph.NODE_TITLE_HEIGHT+56}}
  dirty=true;graph.setDirtyCanvas(true,true);fitGraph()
 }
 function rechain(){if(!graph)return;positionSteps();for(const link of Object.values(graph.links).filter(Boolean))graph.removeLink(link.id);for(let i=1;i<graph._nodes.length;i++){const a=graph._nodes[i-1],b=graph._nodes[i];if(a.outputs&&a.outputs.length&&b.inputs&&b.inputs.length)a.connect(0,b,0)}dirty=true;renderSteps()}
 // 流程元信息在右侧共享属性面板，点击画布空白时展示。
function placeNameField(){const field=$('workflowNameField'),slot=$('workflowFlowNameSlot');if(field&&slot&&field.parentNode!==slot)slot.append(field)}
function setSteps(value){
  if(value&&graph&&graph._nodes.length&&(Object.values(graph.links).filter(Boolean).length!==graph._nodes.length-1||graph._nodes.some(n=>(n.inputs||[]).filter(p=>p.link!==null&&p.link!==undefined).length>1||(n.outputs||[]).some(p=>p.links&&p.links.length>1)))){notice('当前流程不是完整顺序链，请继续使用画布编辑。');return setSteps(false)}
  if(value&&graph&&graph._nodes.length){const links=Object.values(graph.links).filter(Boolean),targets=new Set(links.map(l=>l.target_id)),ordered=[];let current=graph._nodes.find(n=>!targets.has(n.id));while(current&&!ordered.includes(current)){ordered.push(current);const link=links.find(l=>l.origin_id===current.id);current=link?graph.getNodeById(link.target_id):null}if(ordered.length!==graph._nodes.length){notice('当前流程无法表示为顺序步骤，请使用画布编辑。');return setSteps(false)}graph._nodes=ordered}
  if(stepsMode&&!value&&graph)positionSteps()
  stepsMode=value;$('workflowStepList').classList.toggle('hidden',!value);$('workflowCanvasHost').classList.toggle('hidden',value);placeNameField(value);ribbonButton($('workflowStepsToggle'),value?'wf-canvas':'wf-steps',value?'画布视图':'步骤视图');$('workflowStepsToggle').setAttribute('aria-pressed',String(value));if(value){if(canvas)canvas.stopRendering();renderSteps()}else if(canvas){canvas.startRendering();requestAnimationFrame(()=>{resize();fitGraph()})}
 }
 function renderSteps(){const host=$('workflowStepList');host.textContent='';if(!graph)return
  graph._nodes.forEach((n,index)=>{const row=node('article',undefined,'workflow-step-item'+(selectedNode===n?' selected':'')),select=button((index+1)+'. '+n.title,()=>{canvas.selectNode(n);parameter(n)});select.setAttribute('aria-pressed',String(selectedNode===n));select.prepend(glyph(window.workflowNodeIcons.name(n.type)));const actions=node('div');for(const [offset,label]of [[-1,'上移'],[1,'下移']]){const b=button(label,()=>{const target=index+offset;[graph._nodes[index],graph._nodes[target]]=[graph._nodes[target],graph._nodes[index]];rechain()});const target=graph._nodes[index+offset];b.disabled=['workflow/start','workflow/end'].includes(n.type)||!target||['workflow/start','workflow/end'].includes(target.type);actions.append(b)}row.append(select,node('small',((data.nodes.find(d=>'workflow/'+d.type===n.type)||{}).name||n.type)+(interactionName(n.properties&&n.properties.interaction)?' · '+interactionName(n.properties.interaction):''),'muted'),actions);host.append(row)})
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
  if(type==='human'&&!props.interaction){
   const details=node('details',undefined,'workflow-processing-editor');details.append(node('summary','节点处理内容（可组合）'))
   const defaults={version:1,blocks:[{type:'instructions'},...(props.inputSchema?[{type:'form'}]:[]),{type:'attachments'},{type:'conclusion',required:true}]},config=props.processing||defaults,names={instructions:'文字说明',reference:'上游 / 中间资料',form:'处理表单',attachments:'文件上传',conclusion:'文字结论'}
   const change=fn=>{if(!props.processing)props.processing=JSON.parse(JSON.stringify(config));fn(props.processing);dirty=true}
   const redraw=index=>{renderStructured(n);const section=host.querySelector('.workflow-processing-editor');if(!section)return;for(let parent=section;parent&&parent!==document.body;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)parent.open=true;section.open=true;const rows=section.querySelectorAll(':scope > fieldset'),row=rows[Math.min(index,rows.length-1)];if(row)row.querySelector('input').focus();else{const select=section.querySelector('select');if(window.agentSelect)window.agentSelect.enhance(select);(section.querySelector('.select-trigger')||select).focus()}}
   details.append(node('p','按顺序组合本步骤需要展示的内容；表单字段由下方输入 Schema 定义。','muted'))
   config.blocks.forEach((block,index)=>{const row=node('fieldset');row.append(node('legend',names[block.type]||block.type));const title=node('label','标题'),input=node('input');input.value=block.title||'';input.maxLength=80;input.placeholder=names[block.type];input.addEventListener('input',()=>change(c=>c.blocks[index].title=input.value));title.append(input);row.append(title)
    if(block.type==='instructions'){const textLabel=node('label','说明文字（留空使用节点处理要求）'),text=node('textarea');text.value=block.text||'';text.maxLength=16000;text.rows=3;text.addEventListener('input',()=>change(c=>c.blocks[index].text=text.value));textLabel.append(text);row.append(textLabel)}
    if(block.type==='reference'){const sourceLabel=node('label','引用内容'),source=node('select');for(const [v,t]of [['input','上游输入'],['partial','中间结果']]){const option=node('option',t);option.value=v;source.append(option)}source.value=block.source||'input';source.addEventListener('change',()=>change(c=>c.blocks[index].source=source.value));sourceLabel.append(source);row.append(sourceLabel)}
    if(block.type==='conclusion'){const label=node('label',undefined,'workflow-radio'),required=node('input');required.type='checkbox';required.checked=block.required!==false;required.addEventListener('change',()=>change(c=>c.blocks[index].required=required.checked));label.append(required,document.createTextNode('必须填写结论'));row.append(label)}
    const actions=node('div',undefined,'workflow-processing-editor-actions');for(const [offset,name]of [[-1,'上移'],[1,'下移']]){const move=button(name,()=>{change(c=>{[c.blocks[index],c.blocks[index+offset]]=[c.blocks[index+offset],c.blocks[index]]});redraw(index+offset)},name+'内容块 '+(index+1));move.disabled=index+offset<0||index+offset>=config.blocks.length;actions.append(move)}actions.append(button('移除',()=>{change(c=>c.blocks.splice(index,1));redraw(index)},'移除内容块 '+(index+1)));row.append(actions);details.append(row)
   })
   const select=node('select');select.setAttribute('aria-label','新增处理内容类型');for(const [value,title]of Object.entries(names)){const option=node('option',title);option.value=value;option.disabled=!['instructions','reference'].includes(value)&&config.blocks.some(b=>b.type===value)||value==='form'&&!props.inputSchema;select.append(option)}const add=button('添加内容',()=>{if(config.blocks.length>=12)return;change(c=>c.blocks.push({type:select.value,...(select.value==='conclusion'?{required:true}:{})}));redraw(props.processing.blocks.length-1)});add.disabled=config.blocks.length>=12;details.append(select,add);host.append(details)
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
 // 端口不在界面里单独配置：按连线自动增减，始终保留一个空闲入口 / 出口，多进多出直接拖线即可。
let portSyncPending=false
function queuePortSync(){if(portSyncPending||!graph)return;portSyncPending=true;requestAnimationFrame(()=>{portSyncPending=false;if(!graph)return;for(const item of graph._nodes)syncNodePorts(item);graph.setDirtyCanvas(true,true)})}
function syncNodePorts(n){
 if(!n||!graph||graph._nodes.indexOf(n)<0)return
 const type=n.type.split('/')[1],limits=stepsMode?{inputs:1,outputs:1}:{inputs:8,outputs:8}
 const wantIn=['input','start'].includes(type)?0:Math.max(1,Math.min(limits.inputs,(n.inputs||[]).filter(port=>port.link!==null&&port.link!==undefined).length+(stepsMode?0:1)))
 const wantOut=['output','end'].includes(type)?0:Math.max(1,Math.min(limits.outputs,stepsMode?1:(n.outputs||[]).reduce((sum,port)=>sum+((port.links&&port.links.length)||0),0)+1))
 let changed=false
 while((n.inputs||[]).length<wantIn){n.addInput('输入'+((n.inputs||[]).length+1),'text');changed=true}
 while((n.inputs||[]).length>wantIn&&(n.inputs[n.inputs.length-1].link===null||n.inputs[n.inputs.length-1].link===undefined)){n.removeInput(n.inputs.length-1);changed=true}
 while((n.outputs||[]).length<wantOut){n.addOutput((n.outputs||[]).length?'输出'+((n.outputs||[]).length+1):'文本','text');changed=true}
 while((n.outputs||[]).length>wantOut&&!((n.outputs[n.outputs.length-1].links||[]).length)){n.removeOutput(n.outputs.length-1);changed=true}
 if(changed&&n.size)n.size=n.computeSize()
}
function syncAllPorts(){if(!graph)return;for(const item of graph._nodes)syncNodePorts(item)}
function edit(flow){
  register()
  editing=JSON.parse(JSON.stringify(flow))
  dirty=false
  $('workflowName').value=flow.name;loadFlowProperties(flow)
  view('editor')
  finishCardResize(true)
  if(canvas)canvas.dispose()
  graph=new LGraph()
  graph.onNodeRemoved=()=>{dirty=true;parameter(null)}
  canvas=window.workflowCanvasLifecycle.create($('workflowCanvas'),graph)
  canvas.background_image=null
  canvas.render_canvas_border=false
  canvas.show_info=false
  const drawNode=canvas.drawNode
  canvas.render_shadows=false
  canvas.connections_width=1.5;canvas.render_connections_border=false;canvas.render_connections_shadows=false
  const renderLink=canvas.renderLink,directions={[LiteGraph.RIGHT]:'right',[LiteGraph.LEFT]:'left',[LiteGraph.UP]:'up',[LiteGraph.DOWN]:'down'}
  let geometry='',router=null,routingSignature='';const routes=new Map()
  canvas.drawConnections=function(ctx){
   const rectangles=graph._nodes.map(n=>({id:n.id,left:n.pos[0],top:n.pos[1]-LiteGraph.NODE_TITLE_HEIGHT,right:n.pos[0]+n.size[0],bottom:n.pos[1]+n.size[1]})).sort((a,b)=>a.id-b.id),signature=rectangles.map(r=>[r.id,r.left,r.top,r.right,r.bottom].join(',')).join(';')
   if(!router||signature!==geometry){geometry=signature;router=window.workflowLinkRouting.create(rectangles)}
   const edges=[]
   for(const link of Object.values(graph.links).filter(Boolean)){
    const from=graph.getNodeById(link.origin_id),to=graph.getNodeById(link.target_id);if(!from||!to||!from.outputs[link.origin_slot]||!to.inputs[link.target_slot])continue
    const a=from.getConnectionPos(false,link.origin_slot),b=to.getConnectionPos(true,link.target_slot),startDir=from.outputs[link.origin_slot].dir||LiteGraph.RIGHT,endDir=to.inputs[link.target_slot].dir||LiteGraph.LEFT
    edges.push({id:link.id,link,start:Array.from(a),end:Array.from(b),source:from.id,target:to.id,startDir,endDir,startDirection:directions[startDir],endDirection:directions[endDir]})
   }
   const nextSignature=geometry+'|'+edges.map(e=>[e.id,e.source,e.target,...e.start,...e.end,e.startDir,e.endDir].join(',')).join(';')
   if(nextSignature!==routingSignature){routingSignature=nextSignature;routes.clear();const planned=router.routeAll(edges);for(const edge of edges){const points=planned.get(edge.id);routes.set(edge.id,{points,commands:window.workflowLinkRouting.commands(points,rectangles)})}}
   let blocked=0
   for(const edge of edges){
    const {link,start:a,end:b,startDir,endDir}=edge,cached=routes.get(edge.id)
    link._workflowRoute=cached.points||[];link._workflowRouteBlocked=!cached.points
    link._workflowRouteCommands=cached.commands
    if(!cached.points){blocked++;if(link._pos){link._pos[0]=-1e9;link._pos[1]=-1e9}continue}
    this.renderLink(ctx,a,b,link,false,0,null,startDir,endDir)
   }
   const host=$('workflowCanvasHost');if(host.dataset.blockedLinks!==String(blocked))host.dataset.blockedLinks=String(blocked)
   const warning=$('workflowRoutingWarning');if(warning){warning.hidden=!blocked;const text=blocked?'有 '+blocked+' 条连线的端口被卡片挡住，请移开重叠卡片。':'';if(warning.textContent!==text)warning.textContent=text}
  }
  canvas.renderLink=function(ctx,a,b,link,skip,flow,color,startDir,endDir,count){
   if(!link)return renderLink.call(this,ctx,a,b,link,true,flow,color,startDir,endDir,count)
   const points=link._workflowRoute;if(!points||!points.length)return
   this.visible_links.push(link);const middle=window.workflowLinkRouting.pointAt(points,.5);if(link._pos){link._pos[0]=middle[0];link._pos[1]=middle[1]}
   ctx.save();ctx.lineWidth=1.5;ctx.lineJoin='round';ctx.lineCap='round';ctx.globalAlpha=this.editor_alpha;ctx.strokeStyle=this.highlighted_links[link.id]||marqueeHasLink(a,b,startDir,endDir,points)?cardTheme.selected:color||link.color||this.default_link_color;ctx.beginPath();window.workflowLinkRouting.trace(ctx,link._workflowRouteCommands);ctx.stroke();ctx.restore()
  }
  canvas.drawNodeShape=function(n,ctx,size,color,background,selected,hovered){drawNodeCard(n,ctx,size,selected,hovered)}
  canvas.drawNode=function(n,ctx){ctx.save();ctx.beginPath();ctx.rect(-8,-LiteGraph.NODE_TITLE_HEIGHT-8,n.size[0]+16,n.size[1]+LiteGraph.NODE_TITLE_HEIGHT+16);ctx.clip();ctx.font=this.inner_text_font;for(const ports of [n.inputs||[],n.outputs||[]])for(const port of ports)port.label=fitNodeText(ctx,port.name,n.size[0]/2-28);try{return drawNode.call(this,n,ctx)}finally{ctx.restore()}}
  canvas.allow_searchbox=false
  canvas.processContextMenu=(n,e)=>{if(e&&typeof e.preventDefault==='function')e.preventDefault();if(n){canvas.selectNode(n);parameter(n)}else if(e)showCanvasMenu(e.clientX,e.clientY);return false}
  canvas.onShowNodePanel=n=>{if(n.is_selected&&Object.keys(canvas.selected_nodes).length>1)return false;canvas.selectNode(n);parameter(n);if(!$('workflowNodeText').disabled)$('workflowNodeText').focus();return false}
  canvas.prompt=()=>false
  canvas.onNodeMoved=()=>{dirty=true}
  const selectionChanged=()=>{const nodes=Object.values(canvas.selected_nodes);parameter(nodes.length===1?nodes[0]:null);if(nodes.length>1)$('workflowNodeMode').textContent='已选择 '+nodes.length+' 个节点 · 拖动可整体移动，点击空白取消选择'}
  canvas.onNodeSelected=selectionChanged
  canvas.onNodeDeselected=()=>parameter(null)
  canvas.onSelectionChange=selectionChanged
  canvas.onDrawForeground=drawEditorGuides
  canvas.onMouse=function(event){if(canvasMode==='select'&&event.which===1&&event.shiftKey){const hit=graph.getNodeOnPos(event.canvasX,event.canvasY,canvas.visible_nodes);if(hit){this.selectNode(hit,true);this.node_dragged=null;this.setDirty(true,true);event.preventDefault();event.stopPropagation();return true}}if(canvasMode!=='box'||event.which!==1)return false;if(!event.shiftKey)this.deselectAllNodes();this.dragging_rectangle=new Float32Array([event.canvasX,event.canvasY,1,1]);this.dragging_canvas=false;this.last_mouse[0]=event.clientX;this.last_mouse[1]=event.clientY;event.preventDefault();event.stopPropagation();this.setDirty(true,true);return true}
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
   for(const key of ['interaction','inputSchema','outputSchema','bindings','skills','agent','tool','deliverable','processing'])if(entry[key]!==undefined)n.properties[key]=JSON.parse(JSON.stringify(entry[key]))
   if(Array.isArray(entry.inputs)){n.inputs=[];for(const port of entry.inputs)n.addInput(port.name,'text')}
   if(Array.isArray(entry.outputs)){n.outputs=[];for(const port of entry.outputs)n.addOutput(port.name,'text')}
   if(Array.isArray(entry.size))n.properties.cardSize=entry.size.slice(0,2).map(v=>Number(v)||0).map((v,i)=>Math.max(i?LiteGraph.NODE_TITLE_HEIGHT+36:200,Math.min(i?360:520,v||(i?66:280))))
   n.size=n.computeSize()
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
  syncAllPorts()
  if(flow.nodes.length>1&&new Set(flow.nodes.map(n=>JSON.stringify(n.pos||[0,0]))).size===1)arrangeGraph()
  dirty=false
  const toolbar=$('workflowNodeTypes');toolbar.textContent=''
  const defs=(data.nodes&&data.nodes.length)?data.nodes:FALLBACK_NODES
  const iconNames={start:'wf-start',human:'wf-human',ai:'model',agent:'workflow',tool:'plugin',rest:'wf-rest',evaluate:'wf-evaluate',end:'stop'}
  const groups=[['边界节点',defs.filter(d=>!d.legacy&&d.type==='start')],['处理节点',defs.filter(d=>!d.legacy&&!['start','end'].includes(d.type))],['结束节点',defs.filter(d=>!d.legacy&&d.type==='end')]]
  for(const [title,items] of groups){
   if(!items.length)continue
   if(toolbar.children.length){const separator=node('span','｜','workflow-toolbar-divider');separator.setAttribute('aria-hidden','true');toolbar.append(separator)}
   const group=node('div',undefined,'workflow-node-group');group.dataset.ribbonGroup=title;group.setAttribute('role','group');group.setAttribute('aria-label',title)
   for(const type of items){
    const add=button('',()=>addEditorNode(type),'添加'+type.name)
    add.className='workflow-ribbon-button';add.draggable=true;add.dataset.nodeType=type.type;add.append(glyph(iconNames[type.type]||'workflow'),node('span',type.name,'workflow-ribbon-label'))
    add.addEventListener('dragstart',event=>{event.dataTransfer.setData('application/x-workflow-node',type.type);event.dataTransfer.setData('text/plain',type.type);event.dataTransfer.effectAllowed='copy';add.classList.add('is-dragging')})
    add.addEventListener('dragend',()=>add.classList.remove('is-dragging'));group.append(add)
   }
   toolbar.append(group)
  }
  if(window.applyIcons)window.applyIcons(toolbar)
  setupCanvasTools();setupRibbonActions()
  stepsMode=flow.editor==='steps';setSteps(stepsMode);parameter(null)
  canvas.startRendering()
  resize()
  requestAnimationFrame(()=>{resize();fitGraph()})
 }
 function addEditorNode(type,position){
  const n=LiteGraph.createNode('workflow/'+type.type);n.title=type.name;n.properties.workflowId=nextNodeId(type.type)
  if(type.type==='human'){n.properties.interaction={version:1,type:'review',returnTo:'previous-human'};n.properties.processing={version:1,blocks:[{type:'instructions',title:'处理描述'},{type:'conclusion',title:'备注',required:false}]}}
  n.pos=position?[position[0]-n.size[0]/2,position[1]-(n.size[1]-LiteGraph.NODE_TITLE_HEIGHT)/2]:[canvas.canvas.width/(2*canvas.ds.scale)-canvas.ds.offset[0]-n.size[0]/2+(graph._nodes.length%3)*24,canvas.canvas.height/(2*canvas.ds.scale)-canvas.ds.offset[1]-n.size[1]/2+(graph._nodes.length%3)*24]
  applyNodeTheme(n);graph.add(n)
  if(stepsMode){const end=graph._nodes.find(v=>v.type==='workflow/end');if(end&&end!==n){graph._nodes.splice(graph._nodes.indexOf(n),1);graph._nodes.splice(graph._nodes.indexOf(end),0,n)}rechain()}
  canvas.selectNode(n);parameter(n);dirty=true;graph.setDirtyCanvas(true,true);return n
 }
 function ribbonButton(control,iconName,text){if(!control)return;control.classList.add('workflow-ribbon-button');control.textContent='';control.append(glyph(iconName),node('span',text,'workflow-ribbon-label'));control.setAttribute('aria-label',text)}
 function setupRibbonActions(){
  let arrange=$('workflowArrange');if(!arrange){arrange=button('',()=>{if(stepsMode){positionSteps();dirty=true;renderSteps()}else arrangeGraph()},'整理节点布局');arrange.id='workflowArrange';$('workflowStepsToggle').before(arrange)}
  for(const [id,title,items]of [['workflowRibbonViews','视图',[arrange,$('workflowStepsToggle')]],['workflowRibbonValidation','验证',[$('workflowSimulate')]]]){let group=$(id);const controls=items.filter(Boolean);if(!group&&controls.length){group=node('div',undefined,'workflow-ribbon-action-group');group.id=id;group.dataset.ribbonGroup=title;group.setAttribute('role','group');group.setAttribute('aria-label',title);controls[0].before(group);group.append(...controls)}}
  $('workflowEditorActions').dataset.ribbonGroup='流程'
  for(const [id,iconName,text]of [['workflowArrange','wf-layout','整理布局'],['workflowStepsToggle',stepsMode?'wf-canvas':'wf-steps',stepsMode?'画布视图':'步骤视图'],['workflowSimulate','wf-test','自测验证'],['workflowBack','wf-back','返回'],['workflowSave','wf-save','保存流程']])ribbonButton($(id),iconName,text)
 }
 const canvasHost=$('workflowCanvasHost')
 canvasHost.addEventListener('dragover',event=>{if(mode!=='editor'||!event.dataTransfer||!Array.from(event.dataTransfer.types).includes('application/x-workflow-node'))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';canvasHost.classList.add('is-node-drop-target')},true)
 canvasHost.addEventListener('dragleave',event=>{if(!canvasHost.contains(event.relatedTarget))canvasHost.classList.remove('is-node-drop-target')})
 canvasHost.addEventListener('drop',event=>{canvasHost.classList.remove('is-node-drop-target');if(mode!=='editor'||!canvas||!event.dataTransfer)return;const kind=event.dataTransfer.getData('application/x-workflow-node'),type=(data.nodes||FALLBACK_NODES).find(item=>item.type===kind&&!item.legacy);if(!type)return;event.preventDefault();event.stopImmediatePropagation();const rect=canvas.canvas.getBoundingClientRect();addEditorNode(type,[(event.clientX-rect.left)/canvas.ds.scale-canvas.ds.offset[0],(event.clientY-rect.top)/canvas.ds.scale-canvas.ds.offset[1]]);canvas.canvas.focus()},true)
 function updateZoom(){if(canvas&&$('workflowZoom'))$('workflowZoom').textContent=Math.round(canvas.ds.scale*100)+'%'}
 let splitGesture=null,splitGuide=null
 function canvasModeSet(mode){
  finishSplit(true);finishCardResize(true);canvasMode=mode;splitGuide=null
  if(canvas){canvas.allow_dragnodes=mode==='select';canvas.allow_interaction=!['box','split','resize'].includes(mode);canvas.dragging_canvas=false;canvas.connecting_node=null;canvas.setDirty(true,true)}
  $('workflowCanvas').style.cursor=mode==='split'||mode==='box'||mode==='connect'?'crosshair':'default'
  for(const b of document.querySelectorAll('[data-canvas-mode]'))b.setAttribute('aria-pressed',String(b.dataset.canvasMode===mode))
  $('workflowCanvasHint').textContent=mode==='resize'?'拖动卡片边缘或边角调整大小 · 选中后方向键微调，Shift 加速 · Esc 返回选择':mode==='split'?'十字分割：拖动时按主方向自动判断左右或上下，另一条线随即消失 · Esc 取消本次移动':mode==='box'?'拖动框选多个节点 · 松开后拖动任一卡片整体移动':mode==='connect'?'从输出圆点拖到输入圆点连线 · Esc 返回选择':'拖动节点移动 · 拖动空白平移 · 滚轮缩放 · Shift 点选多个'
 }
 function splitPoint(event){const rect=$('workflowCanvas').getBoundingClientRect();return[(event.clientX-rect.left)/canvas.ds.scale-canvas.ds.offset[0],(event.clientY-rect.top)/canvas.ds.scale-canvas.ds.offset[1]]}
 function marqueeBounds(){const rect=canvas&&canvas.dragging_rectangle;if(!rect)return null;return[Math.min(rect[0],rect[0]+rect[2]),Math.min(rect[1],rect[1]+rect[3]),Math.abs(rect[2]),Math.abs(rect[3])]}
 function marqueeHasNode(n){const rect=marqueeBounds();if(!rect)return false;const bound=n.getBounding();return rect[0]<=bound[0]+bound[2]&&rect[0]+rect[2]>=bound[0]&&rect[1]<=bound[1]+bound[3]&&rect[1]+rect[3]>=bound[1]}
 function marqueeHasLink(a,b,startDir,endDir,points){
  const rect=marqueeBounds();if(!rect)return false
  if(points)return points.slice(1).some((p,i)=>window.workflowLinkRouting.hits(points[i],p,{left:rect[0],top:rect[1],right:rect[0]+rect[2],bottom:rect[1]+rect[3]}))
  const inside=p=>p[0]>=rect[0]&&p[0]<=rect[0]+rect[2]&&p[1]>=rect[1]&&p[1]<=rect[1]+rect[3]
  for(let i=0;i<=24;i++)if(inside(canvas.computeConnectionPoint(a,b,i/24,startDir,endDir)))return true
  return false
 }
 function drawEditorGuides(ctx){
  if(!canvas)return
  const scale=canvas.ds.scale,rect=marqueeBounds()
  if(rect){ctx.save();ctx.fillStyle=cardTheme.selected;ctx.globalAlpha=.1;ctx.fillRect(...rect);ctx.globalAlpha=1;ctx.strokeStyle=cardTheme.selected;ctx.lineWidth=2/scale;ctx.setLineDash([]);ctx.strokeRect(...rect);ctx.restore()}
  if(canvasMode!=='split'||!splitGuide)return
  // 两条分割线同时存在；一旦开始拖动并判断出主方向，只保留正在用的那一条。
  const left=-canvas.ds.offset[0],top=-canvas.ds.offset[1],width=canvas.canvas.width/scale,height=canvas.canvas.height/scale,x=splitGuide[0],y=splitGuide[1],axis=splitGesture&&splitGesture.axis
  ctx.save();ctx.strokeStyle=cardTheme.selected;ctx.lineWidth=1.5/scale;ctx.setLineDash([6/scale,5/scale])
  if(!axis||axis==='x'){ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+height);ctx.stroke()}
  if(!axis||axis==='y'){ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+width,y);ctx.stroke()}
  ctx.restore()
 }
 function finishSplit(cancel){
  if(!splitGesture)return
  const gesture=splitGesture;splitGesture=null
  if(cancel){for(const item of gesture.nodes){item.node.pos[0]=item.pos[0];item.node.pos[1]=item.pos[1]}}
  else if(gesture.moved){dirty=true;if(graph)graph.change()}
  splitGuide=null;if(canvas)canvas.setDirty(true,true)
 }
 function moveSplit(event){
  if(!canvas)return
  splitGuide=splitPoint(event)
  const gesture=splitGesture
  if(gesture){
   // 先看主方向：横向位移大走左右，纵向位移大走上下，未超过阈值前两条线都留着。
   if(!gesture.axis){const dx=splitGuide[0]-gesture.start[0],dy=splitGuide[1]-gesture.start[1],threshold=4/canvas.ds.scale;if(Math.abs(dx)>=threshold||Math.abs(dy)>=threshold)gesture.axis=Math.abs(dx)>=Math.abs(dy)?'x':'y'}
   if(gesture.axis){const index=gesture.axis==='x'?0:1,delta=splitGuide[index]-gesture.start[index];for(const item of gesture.nodes)item.node.pos[index]=item.pos[index]+(index===0?item.sideX:item.sideY)*delta/2;gesture.moved=Math.abs(delta)>.01}
  }
  canvas.setDirty(true,true)
 }
 let canvasMenu=null,canvasMenuReturn=null
 function closeCanvasMenu(restore){if(!canvasMenu)return;const focus=canvasMenuReturn||$('workflowCanvas');canvasMenu.remove();canvasMenu=null;canvasMenuReturn=null;const control=$('workflowCanvasZoomButton');if(control)control.setAttribute('aria-expanded','false');if(restore&&focus.isConnected)focus.focus()}
 function showCanvasMenu(x,y){
  closeCanvasMenu(false);const menu=node('div',undefined,'workflow-canvas-menu');canvasMenu=menu;menu.setAttribute('role','menu');menu.setAttribute('aria-label','画布视图');menu.style.left=Math.max(8,Math.min(x,innerWidth-180))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-60))+'px'
  const reset=button('恢复100%',()=>{canvas.ds.changeScale(1);canvas.setDirty(true,true);updateZoom();closeCanvasMenu(true)});reset.setAttribute('role','menuitem');menu.append(reset);page.append(menu);reset.focus()
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCanvasMenu(true)}else if(event.key==='Tab')closeCanvasMenu(true)})
 }
 function fitGraph(){
  if(!canvas)return
  if(!graph._nodes.length){canvas.ds.scale=1;canvas.ds.offset[0]=0;canvas.ds.offset[1]=0}
  else{const bounds=graph._nodes.map(n=>n.getBounding()),x=Math.min(...bounds.map(b=>b[0])),y=Math.min(...bounds.map(b=>b[1])),right=Math.max(...bounds.map(b=>b[0]+b[2])),bottom=Math.max(...bounds.map(b=>b[1]+b[3]));canvas.ds.scale=Math.max(.1,Math.min(1.5,(canvas.canvas.width-140)/Math.max(1,right-x),(canvas.canvas.height-100)/Math.max(1,bottom-y)));canvas.ds.offset[0]=canvas.canvas.width/(2*canvas.ds.scale)-(x+right)/2;canvas.ds.offset[1]=canvas.canvas.height/(2*canvas.ds.scale)-(y+bottom)/2}
  canvas.setDirty(true,true);updateZoom()
 }
 function setupCanvasTools(){
  const host=$('workflowCanvasTools');host.textContent=''
  const entries=[['select','wf-select','选择与移动节点',()=>canvasModeSet('select')],['connect','wf-link','连接节点端口',()=>canvasModeSet('connect')],['box','wf-marquee','框选多个节点',()=>canvasModeSet('box')],['split','wf-split','分割移动两侧所有节点',()=>canvasModeSet('split')],['resize','wf-card-resize','卡片缩放',()=>{canvasModeSet('resize');canvas.canvas.focus({preventScroll:true})}]]
  for(const [key,iconName,title,action] of entries){const b=button('',action,title),icon=node('span',undefined,'icon');icon.setAttribute('data-icon',iconName);icon.setAttribute('aria-hidden','true');b.append(icon);b.dataset.canvasAction=key;b.dataset.canvasMode=key;b.setAttribute('aria-pressed','false');host.append(b)}
  const zoomButton=button('',()=>showZoomMenu(zoomButton),'画布缩放');zoomButton.id='workflowCanvasZoomButton';zoomButton.dataset.canvasAction='zoom';zoomButton.setAttribute('aria-expanded','false');zoomButton.setAttribute('aria-controls','workflowZoomMenu');zoomButton.append(glyph('wf-zoom-in'));host.append(zoomButton)
  let warning=$('workflowRoutingWarning');if(!warning){warning=node('div',undefined,'workflow-routing-warning');warning.id='workflowRoutingWarning';warning.hidden=true;warning.setAttribute('role','status');$('workflowCanvasHost').append(warning)}
  const zoom=node('span','100%','workflow-zoom');zoom.id='workflowZoom';zoom.setAttribute('aria-label','画布缩放比例');host.append(zoom)
  if(window.applyIcons)window.applyIcons(host);canvasModeSet('select');updateZoom()
 }
 let cardResizeGesture=null
 function cardResizeHit(event){
  if(!canvas||!['select','resize'].includes(canvasMode)||event.target!==canvas.canvas||canvas.node_dragged||canvas.dragging_canvas||canvas.connecting_node)return null
  const point=splitPoint(event),tolerance=6/canvas.ds.scale
  for(const n of graph._nodes.slice().reverse()){
   if(canvasMode!=='resize'&&!canvas.selected_nodes[n.id])continue
   const left=n.pos[0],right=left+n.size[0],top=n.pos[1]-LiteGraph.NODE_TITLE_HEIGHT,bottom=n.pos[1]+n.size[1]
   if(point[0]<left-tolerance||point[0]>right+tolerance||point[1]<top-tolerance||point[1]>bottom+tolerance)continue
   // Selection mode keeps port connections; explicit resizing owns the entire edge.
   if(canvasMode!=='resize'&&[...(n.inputs||[]).map((_,i)=>n.getConnectionPos(true,i)),...(n.outputs||[]).map((_,i)=>n.getConnectionPos(false,i))].some(p=>Math.hypot(point[0]-p[0],point[1]-p[1])<10/canvas.ds.scale))continue
   const x=Math.abs(point[0]-left)<=tolerance?-1:Math.abs(point[0]-right)<=tolerance?1:0,y=Math.abs(point[1]-top)<=tolerance?-1:Math.abs(point[1]-bottom)<=tolerance?1:0
   if(x||y)return{node:n,x,y,cursor:x&&y?(x===y?'nwse-resize':'nesw-resize'):x?'ew-resize':'ns-resize'}
  }
  return null
 }
 function moveCardResize(event){
  const g=cardResizeGesture;if(!g||!canvas)return
  const point=splitPoint(event),dx=point[0]-g.start[0],dy=point[1]-g.start[1],ports=Math.max((g.node.inputs||[]).length,(g.node.outputs||[]).length),minHeight=Math.max(cardTheme.height-LiteGraph.NODE_TITLE_HEIGHT,ports*LiteGraph.NODE_SLOT_HEIGHT+22)
  const width=g.x?Math.max(200,Math.min(520,g.size[0]+g.x*dx)):g.size[0],height=g.y?Math.max(minHeight,Math.min(Math.max(360,minHeight),g.size[1]+g.y*dy)):g.size[1]
  g.node.size=[width,height];g.node.properties.cardSize=[width,height];g.node.pos=[g.pos[0]+(g.x<0?g.size[0]-width:0),g.pos[1]+(g.y<0?g.size[1]-height:0)];canvas.canvas.style.cursor=g.cursor;canvas.setDirty(true,true)
 }
 function finishCardResize(cancel){
  const g=cardResizeGesture;if(!g)return;cardResizeGesture=null
  if(cancel){g.node.pos=g.pos;g.node.size=g.size;if(g.custom)g.node.properties.cardSize=g.custom;else delete g.node.properties.cardSize}
  else if(g.node.size[0]!==g.size[0]||g.node.size[1]!==g.size[1]){dirty=true;if(graph)graph.change()}
  if(canvas){canvas.canvas.style.cursor='';canvas.setDirty(true,true)}
 }
 function resizeCardByKey(event){
  if(mode!=='editor'||canvasMode!=='resize'||!canvas||cardResizeGesture||event.target!==canvas.canvas||event.isComposing||event.ctrlKey||event.metaKey||event.altKey)return false
  const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key],nodes=Object.values(canvas.selected_nodes)
  if(!delta||nodes.length!==1)return false
  const n=nodes[0],step=event.shiftKey?10:2,ports=Math.max((n.inputs||[]).length,(n.outputs||[]).length),minHeight=Math.max(cardTheme.height-LiteGraph.NODE_TITLE_HEIGHT,ports*LiteGraph.NODE_SLOT_HEIGHT+22)
  n.size=[Math.max(200,Math.min(520,n.size[0]+delta[0]*step)),Math.max(minHeight,Math.min(Math.max(360,minHeight),n.size[1]+delta[1]*step))];n.properties.cardSize=Array.from(n.size)
  dirty=true;graph.change();canvas.setDirty(true,true);event.preventDefault();event.stopImmediatePropagation();return true
 }
 function showZoomMenu(control){
  if(canvasMenu&&canvasMenu.id==='workflowZoomMenu'){closeCanvasMenu(true);return}
  closeCanvasMenu(false);const bounds=control.getBoundingClientRect(),menu=node('div',undefined,'workflow-canvas-menu workflow-zoom-menu'),label=node('label','画布缩放'),range=node('input'),row=node('div',undefined,'workflow-zoom-actions')
  menu.id='workflowZoomMenu';menu.setAttribute('role','group');menu.setAttribute('aria-label','画布缩放');range.type='range';range.min='10';range.max='1000';range.step='5';range.value=String(Math.round(canvas.ds.scale*100));range.setAttribute('aria-label','缩放比例');label.append(range)
  const change=factor=>{canvas.ds.changeScale(canvas.ds.scale*factor,[canvas.canvas.width/2,canvas.canvas.height/2]);canvas.setDirty(true,true);updateZoom();range.value=String(Math.round(canvas.ds.scale*100))}
  const minus=button('−',()=>change(1/1.1),'缩小画布'),plus=button('+',()=>change(1.1),'放大画布'),reset=button('100%',()=>{canvas.ds.changeScale(1);canvas.setDirty(true,true);updateZoom();range.value='100'},'恢复100%'),fit=button('适应全部',()=>{fitGraph();range.value=String(Math.round(canvas.ds.scale*100))})
  row.append(minus,reset,plus,fit);menu.append(label,row);range.addEventListener('input',()=>{canvas.ds.changeScale(Number(range.value)/100);canvas.setDirty(true,true);updateZoom()});menu.style.left=Math.max(8,Math.min(bounds.right+8,innerWidth-270))+'px';menu.style.top=Math.max(8,Math.min(bounds.top,innerHeight-130))+'px';canvasMenu=menu;canvasMenuReturn=control;control.setAttribute('aria-expanded','true');page.append(menu);range.focus()
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCanvasMenu(true)}else if(event.key==='Tab')closeCanvasMenu(true)})
 }
 document.addEventListener('keydown',event=>{if(canvasMenu&&event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();closeCanvasMenu(true)}},true)
 const pointer=typeof LiteGraph!=='undefined'?LiteGraph.pointerevents_method:'pointer'
 document.addEventListener(pointer+'down',event=>{
  if(canvasMenu&&!canvasMenu.contains(event.target)&&!event.target.closest('[data-canvas-action=zoom]'))closeCanvasMenu(false)
  if(mode==='editor'&&event.button===0){const hit=cardResizeHit(event);if(hit){if(canvasMode==='resize')canvas.selectNode(hit.node);cardResizeGesture={...hit,start:splitPoint(event),pos:Array.from(hit.node.pos),size:Array.from(hit.node.size),custom:hit.node.properties.cardSize&&Array.from(hit.node.properties.cardSize)};canvas.canvas.focus();event.preventDefault();event.stopImmediatePropagation();return}}
  if(mode==='editor'&&canvasMode==='resize'&&canvas&&event.target===canvas.canvas&&event.button===0){const point=splitPoint(event),n=graph.getNodeOnPos(point[0],point[1],canvas.visible_nodes);if(n){canvas.selectNode(n);canvas.canvas.focus();event.preventDefault();event.stopImmediatePropagation();return}}
  if(mode!=='editor'||canvasMode!=='split'||event.target!==$('workflowCanvas')||event.button!==0)return
  const start=splitPoint(event)
  splitGesture={axis:null,start,nodes:graph._nodes.map(n=>({node:n,pos:Array.from(n.pos),sideX:n.pos[0]+n.size[0]/2<start[0]?-1:1,sideY:n.pos[1]+(n.size[1]-LiteGraph.NODE_TITLE_HEIGHT)/2<start[1]?-1:1})),moved:false}
  splitGuide=start;canvas.canvas.focus();canvas.setDirty(true,true);event.preventDefault();event.stopImmediatePropagation()
 },true)
 document.addEventListener(pointer+'move',event=>{
  if(cardResizeGesture){moveCardResize(event);event.preventDefault();event.stopImmediatePropagation();return}
  if(mode==='editor'&&['select','resize'].includes(canvasMode)&&canvas&&event.target===canvas.canvas){const hit=cardResizeHit(event);queueMicrotask(()=>{if(canvas&&event.target===canvas.canvas&&['select','resize'].includes(canvasMode))canvas.canvas.style.cursor=hit?hit.cursor:'default'})}
  if(canvas&&mode==='editor'&&canvas.dragging_rectangle)canvas.setDirty(true,true)
  if(mode!=='editor'||canvasMode!=='split'||!canvas||!splitGesture&&event.target!==$('workflowCanvas'))return
  moveSplit(event);if(splitGesture){event.preventDefault();event.stopImmediatePropagation()}
 },true)
 document.addEventListener(pointer+'up',event=>{
  if(cardResizeGesture){moveCardResize(event);finishCardResize(false);event.preventDefault();event.stopImmediatePropagation();return}
  if(splitGesture){moveSplit(event);finishSplit(false);event.preventDefault();event.stopImmediatePropagation();return}
  if(mode==='editor'&&canvasMode==='box')Promise.resolve().then(()=>{if(canvas&&canvasMode==='box')canvasModeSet('select')})
 },true)
 document.addEventListener('pointercancel',()=>{finishSplit(true);finishCardResize(true)},true)
 $('workflowCanvas').addEventListener('mouseleave',()=>{if(!splitGesture){splitGuide=null;if(canvas)canvas.setDirty(true,true)}})
 $('workflowCanvas').addEventListener('keydown',event=>{if(resizeCardByKey(event))return;if(event.key==='Escape'){finishCardResize(true);finishSplit(true);closeCanvasMenu(false);canvasModeSet('select');if(canvas){canvas.deselectAllNodes();canvas.dragging_rectangle=null;canvas.setDirty(true,true)}event.preventDefault()}if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const box=$('workflowCanvas').getBoundingClientRect();showCanvasMenu(box.left+40,box.top+40)}},true)
 $('workflowCanvasHost').addEventListener('wheel',event=>{if(!canvas||mode!=='editor')return;event.preventDefault();event.stopImmediatePropagation();if(splitGesture||cardResizeGesture||!event.deltaY)return;const rect=canvas.canvas.getBoundingClientRect();canvas.ds.changeScale(canvas.ds.scale*(event.deltaY<0?1.1:1/1.1),[event.clientX-rect.left,event.clientY-rect.top]);canvas.setDirty(true,true);updateZoom()},{passive:false,capture:true})
 window.addEventListener('blur',()=>{finishSplit(true);finishCardResize(true);closeCanvasMenu(false)})
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
 let scheduleTask=null,scheduleLoaded=true
 function scheduleFields(){const enabled=$('workflowScheduleEnabled').checked,kind=$('workflowScheduleKind').value;$('workflowScheduleFields').hidden=!enabled;$('workflowScheduleTimeField').hidden=kind==='interval';$('workflowScheduleWeekdayField').hidden=kind!=='weekly';$('workflowScheduleMinutesField').hidden=kind!=='interval'}
 function flowSchedule(){return{taskId:scheduleTask&&scheduleTask.id,taskRevision:scheduleTask&&scheduleTask.revision,enabled:$('workflowScheduleEnabled').checked,rule:{kind:$('workflowScheduleKind').value,time:$('workflowScheduleTime').value,weekday:Number($('workflowScheduleWeekday').value),minutes:Number($('workflowScheduleMinutes').value),timezone:$('workflowScheduleTimezone').value.trim()},catchUp:!!(scheduleTask&&scheduleTask.catchUp)}}
 function setSchedule(task){scheduleTask=task||null;const rule=task&&task.rule||{kind:'daily',time:'09:00',weekday:1,minutes:60,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai'};$('workflowScheduleEnabled').checked=!!(task&&task.enabled);for(const[key,value]of Object.entries({Kind:rule.kind,Time:rule.time||'09:00',Weekday:rule.weekday===undefined?1:rule.weekday,Minutes:rule.minutes||60,Timezone:rule.timezone}))$('workflowSchedule'+key).value=value;$('workflowScheduleStatus').textContent=task?(task.enabled?'已同步 · 下次 '+new Date(task.nextAt).toLocaleString():'对应定时任务已暂停'):'尚未启用定时执行';scheduleFields()}
 function loadFlowProperties(flow){const target=editing;$('workflowDescription').value=flow.description||'';placeNameField();setSchedule(null);if(!flow.id){scheduleLoaded=true;controls.save.disabled=false;return}scheduleLoaded=false;controls.save.disabled=true;$('workflowScheduleStatus').textContent='正在加载定时配置…';window.dsh.taskRequest('list').then(result=>{if(editing!==target)return;setSchedule(result.tasks.find(t=>t.workflow&&t.workflow.id===flow.id));scheduleLoaded=true}).catch(error=>{if(editing===target){$('workflowScheduleStatus').textContent='加载失败：'+error.message;notice('定时配置加载失败，请重新打开流程，避免覆盖已有设置。')}}).finally(()=>{if(editing===target)controls.save.disabled=!scheduleLoaded})}
 $('workflowDescription').addEventListener('input',()=>{dirty=true})
 for(const id of ['Enabled','Kind','Time','Weekday','Minutes','Timezone'])$('workflowSchedule'+id).addEventListener('change',()=>{dirty=true;scheduleFields();$('workflowScheduleStatus').textContent='定时设置将在保存流程时同步'})
 $('workflowName').addEventListener('input',()=>{dirty=true})
 function editorDefinition(){
   const nodes=graph._nodes.map(n=>({...Object.fromEntries(['interaction','inputSchema','outputSchema','bindings','skills','agent','tool','deliverable','processing'].filter(k=>n.properties[k]!==undefined&&!(k==='interaction'&&n.type!=='workflow/human')).map(k=>[k,n.properties[k]])),id:n.properties.workflowId||nextNodeId(n.type.split('/')[1]),type:n.type.split('/')[1],title:n.title,text:n.properties.text||'',description:n.properties.description||'',humanKind:n.properties.humanKind||'review',humanModes:humanModes(n.properties),rest:n.properties.rest||{url:'',method:'GET'},inputs:(n.inputs||[]).map(p=>({name:p.name,type:'text'})),outputs:(n.outputs||[]).map(p=>({name:p.name,type:'text'})),size:Array.from(n.size||[]),pos:Array.from(n.pos)}))
   const byGraph=new Map(graph._nodes.map((n,i)=>[n.id,nodes[i].id]))
   const edges=Object.values(graph.links).filter(Boolean).map(l=>({from:byGraph.get(l.origin_id),to:byGraph.get(l.target_id),slot:l.target_slot||0,outputSlot:l.origin_slot||0}))
   return {...editing,editor:stepsMode?'steps':'canvas',name:$('workflowName').value,description:$('workflowDescription').value,nodes,edges}
 }
 controls.save.addEventListener('click',async()=>{
  const b=controls.save;b.disabled=true
  try{
   if(graph._nodes.some(n=>Object.keys(n.properties.schemaErrors||{}).length))throw Error('请先修正节点 Schema 或输入映射 JSON')
   if(!scheduleLoaded)throw Error('定时配置尚未加载完成，请稍后保存')
   const definition=editorDefinition(),schedule=flowSchedule();if(schedule.enabled&&definition.nodes.some(n=>['agent','tool','rest'].includes(n.type))){if(!await window.appDialogs.confirm('保存并启用定时执行“'+definition.name+'”？\n\n定时执行会调用此流程配置的接口、工具或 Agent，并沿用节点中的工具白名单与限额。人工环节仍需确认；已有未结束实例时跳过。'))return;schedule.confirmed=true}
   const result=await window.dsh.taskRequest('saveWorkflow',{definition,schedule});editing=result.workflow;if(result.syncError){dirty=true;notice('流程已保存，但定时设置未同步：'+result.syncError+'。修正后可再次保存。');return}
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
 window.addEventListener('beforeunload',()=>{executionMapCleanup();disposed=true;clearInterval(timer);if(canvas)canvas.dispose()})
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
 window.workflowUI={open,hide,refresh,openDraft,openReference,buildHumanTask,humanTaskView,detectRejectTarget}
})()
