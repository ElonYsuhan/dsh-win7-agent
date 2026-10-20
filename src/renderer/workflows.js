'use strict'
;(function(){
 const $=id=>document.getElementById(id),page=$('workflowPage');if(!page)return
 const controls={back:$('workflowBack'),save:$('workflowSave'),close:$('workflowClose')},pageHeader=page.querySelector('.workflow-header')
 let mapCollapsed=false
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
 function readCardTheme(){
  const style=getComputedStyle(page),value=name=>style.getPropertyValue('--workflow-node-'+name).trim()
  return{width:parseFloat(value('width')),height:parseFloat(value('height')),radius:parseFloat(value('radius')),background:value('background'),border:value('border'),selected:value('selected'),text:value('text'),muted:value('muted'),hover:value('hover'),hoverBorder:style.getPropertyValue('--hover-border').trim(),font:style.fontFamily,canvas:style.getPropertyValue('--bg').trim()}
 }
 function fitNodeText(ctx,text,width){let result=String(text||'');if(ctx.measureText(result).width<=width)return result;while(result&&ctx.measureText(result+'…').width>width)result=result.slice(0,-1);return result+'…'}
 function interactionName(config){return config&&{handle:'办理',review:'审阅',approve:'审批'}[config.type]||''}
 function drawNodeCard(n,ctx,size,selected,hovered){
  const theme=cardTheme,top=-LiteGraph.NODE_TITLE_HEIGHT,height=size[1]-top,width=size[0]
  ctx.save();ctx.shadowColor='transparent';ctx.globalAlpha=1
  ctx.beginPath();ctx.roundRect(.5,top+.5,width-1,height-1,[theme.radius]);ctx.fillStyle=hovered&&!selected?theme.hover:theme.background;ctx.fill();ctx.strokeStyle=selected?theme.selected:hovered?theme.hoverBorder:theme.border;ctx.lineWidth=selected?2:1;ctx.stroke()
  ctx.beginPath();ctx.roundRect(0,top+15,3,height-30,[0,2,2,0]);ctx.fillStyle=theme.muted;ctx.fill()
  ctx.beginPath();ctx.rect(12,top+8,width-24,height-16);ctx.clip();ctx.textAlign='left';ctx.font='600 14px '+theme.font;ctx.fillStyle=theme.text;ctx.fillText(fitNodeText(ctx,n.title,width-36),18,top+27)
  ctx.font='10px '+theme.font;ctx.fillStyle=theme.muted;const meta=(n.constructor.title||'')+(interactionName(n.properties&&n.properties.interaction)?' · '+interactionName(n.properties.interaction):'');ctx.fillText(fitNodeText(ctx,meta,width-36),18,size[1]-12);ctx.restore()
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
 function hide(){closeArtifact();if(artifactDownload)artifactDownload.abort();
  finishSplit(true);closeCanvasMenu(false)
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
  finishSplit(true);closeCanvasMenu(false)
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
 function drawExecution(result,host){
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
  for(const edge of result.workflow.edges){const from=positions.get(edge.from),to=positions.get(edge.to);if(!from||!to)continue;const path=document.createElementNS(svg.namespaceURI,'path'),x=from.x+NODE_W/2,y=from.y+NODE_H,tx=to.x+NODE_W/2,ty=to.y;path.setAttribute('d',`M ${x} ${y} C ${x} ${y+28}, ${tx} ${ty-28}, ${tx} ${ty}`);svg.append(path)}
  stage.append(svg)
  for(const entry of result.workflow.nodes){const step=result.steps.find(s=>s.id===entry.id),pos=positions.get(entry.id),state=executionState(step),isWaiting=step&&step.status==='waiting';const card=button('',()=>{runSelection=entry.id;pinnedSelection=true;detailSignature='';renderDetail()},entry.title+' · '+executionLabel(step));card.className='workflow-map-node workflow-state-'+state+(isWaiting?' is-waiting':'')+(runSelection===entry.id?' selected':'');card.setAttribute('aria-pressed',String(runSelection===entry.id));card.style.left=pos.x+'px';card.style.top=pos.y+'px';card.style.width=NODE_W+'px';card.style.height=NODE_H+'px';card.append(node('span',result.plan.includes(entry.id)?String(result.plan.indexOf(entry.id)+1).padStart(2,'0'):'—','workflow-map-index'),node('strong',entry.title),node('span',executionLabel(step),'workflow-map-state'),node('small',((data.nodes.find(n=>n.type===entry.type)||{}).name||entry.type)+(interactionName(entry.interaction)?' · '+interactionName(entry.interaction):''),'workflow-map-type'));stage.append(card)}
  scroll.append(stage);left.append(scroll);layout.append(left,right);host.append(layout)
  if(pinnedSelection)requestAnimationFrame(()=>{const selected=positions.get(runSelection);if(selected&&scroll.isConnected){scroll.scrollTop=Math.max(0,selected.y-scroll.clientHeight/3);scroll.scrollLeft=Math.max(0,selected.x-scroll.clientWidth/2+NODE_W/2)}})
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
 function renderHumanForm(result,entry,step,task){
  const key=result.id+':'+step.taskId
  const interaction=entry.type==='human'&&entry.interaction&&step.waitKind!=='agent'&&step.waitKind!=='evaluation'?entry.interaction:null,flowView=interaction?result.interactionViews&&result.interactionViews[step.id]:null
  const modes=interaction?[interaction.type==='approve'?'approval':interaction.type==='review'?'read':'review',...(humanModes(entry).includes('upload')?['upload']:[])]:step.waitKind==='agent'?['review']:step.waitKind==='evaluation'?['review','approval','read']:humanModes(entry)
  if(taskForms.has(key)){const cached=taskForms.get(key);task.append(cached.content);return cached.actions}
  const content=node('div'),cached={content,actions:null};task.append(content);task=content;taskForms.set(key,cached)
  content.className='workflow-human-content'
  const form=node('form'),schema=step.waitKind==='agent'?null:step.waitKind==='evaluation'?entry.outputSchema:entry.inputSchema,view=result.processingViews&&result.processingViews[step.id]||entry.processing||{version:1,blocks:[{type:'instructions'},...(schema?[{type:'form'}]:[]),{type:'attachments'},{type:'conclusion',required:true}]};let readValues=null
  form.id='workflowTaskForm-'+result.id+'-'+step.taskId
  const inputLabel=node('label',undefined,'workflow-upload-field'),uploadHeading=node('span','附件'+(modes.includes('upload')?'（必填）':'（可选）'),'workflow-field-label'),zone=node('span',undefined,'workflow-upload-zone'),zoneText=node('span',undefined,'workflow-upload-copy'),files=node('input');files.type='file';files.multiple=true;files.required=modes.includes('upload')&&!(step.returnFiles||[]).length;files.setAttribute('aria-label','添加附件')
  const hint=node('span','最多 3 个文件，合计 512 KB','workflow-upload-hint');hint.id='workflowUploadHint';zoneText.append(node('strong','点击选择或拖入文件'),hint);zone.append(glyph('upload'),zoneText,files);inputLabel.append(uploadHeading,zone)
  const selectedList=node('ul',undefined,'workflow-selected-files');selectedList.setAttribute('aria-label','已选附件');selectedList.setAttribute('aria-live','polite')
  const fileNote=node('details',undefined,'workflow-file-note');fileNote.append(node('summary','附件如何传递？'),node('p','TXT、Markdown、JSON、CSV 等文本附件提取前 16000 字传给后续步骤，其他格式保留文件引用。'))
  const label=node('label',undefined,'workflow-conclusion-field'),conclusion=node('textarea');label.append(node('span',modes.includes('approval')?'审批意见（必填）':'处理结论（必填）','workflow-field-label'));conclusion.rows=4;conclusion.maxLength=16000;conclusion.required=true;conclusion.placeholder=modes.includes('approval')?'说明审批意见、判断依据或需要修改的内容…':'填写你的判断、结论或需要补充的说明…';label.append(conclusion)
  const error=node('p',undefined,'workflow-error');error.id='workflowTaskError';error.setAttribute('role','alert');conclusion.setAttribute('aria-describedby',error.id);files.setAttribute('aria-describedby',hint.id+' '+error.id)
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
  const reused=new Set((step.returnFiles||[]).map(f=>f.ref))
  if(reused.size){const previous=node('div',undefined,'workflow-reused-files');previous.append(node('p','上轮附件已保留，可继续使用或移除后重新上传。','muted'));for(const file of step.returnFiles){const row=node('label',undefined,'workflow-radio'),check=node('input');check.type='checkbox';check.checked=true;check.addEventListener('change',()=>{if(check.checked)reused.add(file.ref);else reused.delete(file.ref);files.required=modes.includes('upload')&&!reused.size});row.append(check,document.createTextNode(file.name+' · '+formatBytes(file.size)));previous.append(row)}attachmentBlock.prepend(previous)}
  for(const block of view.blocks){
   if(block.type==='instructions'){const requirements=node('details',undefined,'workflow-task-requirements workflow-processing-block');requirements.open=true;requirements.append(node('summary',block.title||'处理要求'),node('p',block.text||step.waitReason||entry.text||'请查看本步骤资料后继续。'));form.append(requirements)}
   if(block.type==='reference'){const reference=node('section',undefined,'workflow-processing-block workflow-processing-reference');reference.append(node('h4',block.title||'参考资料'),node('pre',String(block.source==='partial'?step.partial||'暂无中间结果':step.input||'暂无上游输入')));form.append(reference)}
   if(block.type==='form'&&schema)readValues=window.workflowForms.render(form,schema,step.partialData||step.inputData,block.title)
   if(block.type==='attachments'){uploadHeading.textContent=(block.title||'附件')+(modes.includes('upload')?'（必填）':'（可选）');form.append(attachmentBlock)}
   if(block.type==='conclusion'){conclusion.required=block.required!==false;label.firstChild.textContent=(block.title||(modes.includes('approval')?'审批意见':'处理结论'))+(conclusion.required?'（必填）':'（可选）');form.append(label)}
  }
  if(modes.includes('approval')||interaction&&interaction.type==='review'&&flowView&&flowView.canReject)form.append(decision)
  if(modes.includes('read')&&!interaction){const readLabel=node('label',undefined,'workflow-radio workflow-review-confirm');readLabel.append(reviewed,document.createTextNode('我已审阅资料和相关节点的执行记录'));form.append(readLabel)}
  const actions=node('div',undefined,'workflow-task-actions'),submitTitle=interaction?(interaction.type==='approve'?'通过并继续':interaction.type==='review'?'已审阅，继续':'完成并继续'):step.waitKind==='agent'?'补充并重新执行 Agent':view.blocks.some(b=>['form','attachments','conclusion'].includes(b.type))?'提交并继续':'确认并继续',submit=node('button',submitTitle);submit.type='submit';submit.setAttribute('form',form.id);submit.append(glyph('chevron-right'));actions.append(node('span',interaction&&interaction.type==='approve'?'通过后进入下一步，驳回则退回修改':'确认后进入下一步','muted'),submit);cached.actions=actions;form.append(error)
  const fieldsBeforeDecision=Array.from(form.querySelectorAll('input,textarea,select')).filter(field=>!decision.contains(field)),initialDisabled=new Map(fieldsBeforeDecision.map(field=>[field,field.disabled]))
  const syncDecision=()=>{const rejected=choice()==='reject';if(interaction&&interaction.type==='review')decision.hidden=!rejected;if(reasonLabel)reasonLabel.hidden=!rejected;if(reason)reason.required=rejected;for(const field of fieldsBeforeDecision)field.disabled=rejected||initialDisabled.get(field);submit.textContent=rejected?'驳回并退回':submitTitle;submit.append(glyph('chevron-right'))}
  if(interaction&&modes.includes('approval'))for(const radio of decision.querySelectorAll('input[name=workflowDecision]'))radio.addEventListener('change',syncDecision)
  if(interaction&&interaction.type==='review'&&flowView&&flowView.canReject){const reject=button('驳回',()=>{reviewReject=!reviewReject;reject.textContent=reviewReject?'取消驳回':'驳回';syncDecision();if(reviewReject)reason.focus()});reject.className='workflow-review-reject';actions.insertBefore(reject,submit)}
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(submit.disabled)return;error.textContent='';submit.disabled=true;submit.textContent='正在提交…';form.setAttribute('aria-busy','true')
   try{const selected=Array.from(files.files||[]);if(selected.length>3||selected.reduce((sum,file)=>sum+file.size,0)>512*1024)throw Error('最多3个附件，总大小不能超过512KB');files.removeAttribute('aria-invalid')
    const approvable=modes.includes('approval'),rejected=!!interaction&&choice()==='reject'||approvable&&choice()==='reject'
    if(approvable&&!choice())throw Error(interaction?'请选择通过或驳回':'请选择通过或不通过')
    if(rejected&&reason&&!reason.value.trim())throw Error('请填写驳回原因（最多16000字）')
    const payload=rejected&&interaction?[]:await Promise.all(selected.map(filePayload))
    await api('submit',{id:result.id,nodeId:step.id,taskId:step.taskId,conclusion:rejected&&reason?reason.value:label.isConnected?conclusion.value:'',values:rejected&&interaction?undefined:readValues?readValues():undefined,reuseFiles:rejected&&interaction?[]:Array.from(reused),reviewed:reviewed.checked||!!(interaction&&interaction.type==='review'),decision:approvable||rejected?choice():'confirm',files:payload})
    // 退回信息由实例头部的退回横幅承载，页面顶部不再重复提示。
    pinnedSelection=false;detailSignature='';notice('')
    await refresh()
   }catch(e){error.textContent=e.message}finally{submit.disabled=false;syncDecision();form.removeAttribute('aria-busy')}
  })
  task.append(form);return actions
 }

 async function renderDetail(){
  const id=activeRun;if(!id)return
  const result=await api('detail',{id});if(mode!=='detail'||id!==activeRun)return
  const signature=JSON.stringify(result);if(signature===detailSignature)return;detailSignature=signature;runDetail=result
  if(!pinnedSelection||!result.workflow.nodes.some(n=>n.id===runSelection))runSelection=(result.steps.find(s=>['running','waiting','failed'].includes(s.status))||result.steps.find(s=>s.status==='pending')||result.steps[0]||{}).id
  const host=$('workflowRunDetail');host.textContent=''
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
 function register(){
  if(typeof LiteGraph==='undefined')return
  cardTheme=readCardTheme()
  LiteGraph.registered_node_types={}
  const defs=(data.nodes&&data.nodes.length)?data.nodes:FALLBACK_NODES
  for(const def of defs){
   function N(){
    this.addProperty('text','')
    if(!['input','start'].includes(def.type)){this.addInput('输入1','text');this.addInput('输入2','text')}
    if(!['output','end'].includes(def.type))this.addOutput('文本','text')
    this.size=this.computeSize();this.resizable=false
    applyNodeTheme(this)
   }
   N.title=def.name
   N.collapsable=false
   N.prototype.computeSize=function(out){const size=out||[0,0];size[0]=cardTheme.width;size[1]=Math.max(cardTheme.height-LiteGraph.NODE_TITLE_HEIGHT,Math.max((this.inputs||[]).length,(this.outputs||[]).length)*LiteGraph.NODE_SLOT_HEIGHT+26);return size}
   N.prototype.onConnectionsChange=function(){dirty=true}
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
function nextNodeId(type){
  const prefix=String(type||'node').replace(/[^a-zA-Z0-9_-]/g,'_')
  const used=new Set((graph&&Array.isArray(graph._nodes)?graph._nodes:[]).map(n=>(n.properties&&n.properties.workflowId)||('node_'+n.id)))
  let index=1
  while(used.has(prefix+'_'+index))index++
  return prefix+'_'+index
 }
 function parameter(n){
  selectedNode=n
  const panel=page.querySelector('.workflow-parameters');if(panel)panel.classList.toggle('is-empty',!n)
  const human=!!n&&n.type==='workflow/human',simple=human&&!!n.properties.interaction
  $('workflowNodeTitle').value=n?n.title:''
  $('workflowNodeText').value=n?(n.properties.text||(human?n.properties.description:'')||''):''
  $('workflowNodeText').rows=human?4:12
  $('workflowNodeTextField').classList.toggle('is-human',human)
  $('workflowNodeTextLabel').textContent=human?'处理描述':'执行指令'
  $('workflowNodeTitle').disabled=!n
  $('workflowNodeText').disabled=!n
  $('workflowRemoveNode').disabled=!n
  $('workflowNodeDescription').value=n?(n.properties.description||''):''
  $('workflowNodeDescription').disabled=!n
  $('workflowHumanInteractionOptions').classList.toggle('hidden',!human)
  $('workflowHumanExtras').classList.toggle('hidden',!simple)
  $('workflowLegacyHumanOptions').classList.toggle('hidden',!human||simple)
  $('workflowHumanOptions').classList.toggle('hidden',!human||simple)
  $('workflowInteractionType').value=simple?n.properties.interaction.type:'legacy'
  $('workflowInteractionType').querySelector('[value="legacy"]').hidden=!!simple
  $('workflowInteractionHint').textContent=simple?{handle:'处理完成后，一次提交进入下一步。',review:'阅读资料后直接确认，无需重复勾选或填写结论。',approve:'通过则继续；驳回时填写原因，退回人工环节修改。'}[n.properties.interaction.type]:'此节点保留原有组合要求，可在下方兼容配置中查看。'
  if(window.agentSelect)window.agentSelect.refresh($('workflowInteractionType'))
  $('workflowNodeAdvanced').classList.toggle('workflow-advanced-visible',!human)
  $('workflowNodeAdvanced').open=!human
  $('workflowNodeDescriptionField').classList.toggle('hidden',human&&(!n.properties.description||n.properties.description===n.properties.text))
  $('workflowNodeDescriptionLabel').textContent=human?'原步骤说明（兼容）':'步骤说明'
  for(const checkbox of document.querySelectorAll('[name=workflowHumanKind]'))checkbox.checked=!!n&&humanModes(n.properties).includes(checkbox.value)
  $('workflowRestOptions').classList.toggle('hidden',!n||n.type!=='workflow/rest')
  $('workflowRestUrl').value=n&&n.properties.rest?n.properties.rest.url:''
  for(const radio of document.querySelectorAll('[name=workflowRestMethod]'))radio.checked=!!n&&radio.value===(n.properties.rest&&n.properties.rest.method||'GET')
  renderPorts(n)
  renderStructured(n)
  renderHumanExtras(n)
  if(stepsMode)renderSteps()
  $('workflowNodeMode').textContent=n?(human?(simple?{handle:'人工办理 · 完成后继续',review:'人工审阅 · 已阅后继续',approve:'人工审批 · 通过或驳回'}[n.properties.interaction.type]:'人工处理 · 保留原配置'):'自动执行 · 完成后继续'):'选择节点查看配置'
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
  const add=button('添加填写项',()=>{props.inputSchema=props.inputSchema||{type:'object',properties:{},required:[],additionalProperties:false};props.inputSchema.properties=props.inputSchema.properties||{};let index=1;while(props.inputSchema.properties['field_'+index])index++;props.inputSchema.properties['field_'+index]={type:'string',title:'填写项 '+index,maxLength:16000};change(c=>{if(!c.blocks.some(b=>b.type==='form'))c.blocks.push({type:'form',title:'处理表单'})});rerender()});add.disabled=Object.keys(props.inputSchema&&props.inputSchema.properties||{}).length>=24;group.append(add,node('p','新增项默认为文本；复杂字段可在高级设置中调整。','muted'));host.append(group)
 }
 async function startRun(flow){
  if(!flow)return null
  const agents=flow.nodes.filter(n=>['agent','tool'].includes(n.type))
  if(agents.length&&!await window.appDialogs.confirm('确认执行“'+flow.name+'”？\n\n'+agents.map(n=>n.title+'：'+(n.type==='tool'?n.tool.name:((n.agent&&n.agent.tools)||[]).join('、')||'无工具')+(n.type==='tool'?'；固定调用一次':'；最多'+(n.agent&&n.agent.maxSteps||6)+'轮、'+(n.agent&&n.agent.maxRequests||6)+'次模型请求、'+(n.agent&&n.agent.maxToolCalls||8)+'次工具调用')+'；超时'+Math.round((n.agent&&n.agent.timeoutMs||120000)/1000)+'秒；'+((n.type==='tool'?n.tool.permission:n.agent&&n.agent.permission)==='workspace'?'允许工作目录内修改':'只读')).join('\n')+'\n\n人工步骤会等待确认，Agent 内部不会请求人工授权。'))return null
  return api('run',{id:flow.id,confirmed:true})
 }
 function positionSteps(){let y=80;for(let index=0;index<graph._nodes.length;index+=4){const row=graph._nodes.slice(index,index+4);row.forEach((n,column)=>{n.pos=[40+column*(cardTheme.width+40),y]});y+=Math.max(...row.map(n=>n.size[1]))+LiteGraph.NODE_TITLE_HEIGHT+48}}
 function rechain(){if(!graph)return;positionSteps();for(const link of Object.values(graph.links).filter(Boolean))graph.removeLink(link.id);for(let i=1;i<graph._nodes.length;i++){const a=graph._nodes[i-1],b=graph._nodes[i];if(a.outputs&&a.outputs.length&&b.inputs&&b.inputs.length)a.connect(0,b,0)}dirty=true;renderSteps()}
 function setSteps(value){
  if(value&&graph&&graph._nodes.length&&(Object.values(graph.links).filter(Boolean).length!==graph._nodes.length-1||graph._nodes.some(n=>(n.inputs||[]).filter(p=>p.link!==null&&p.link!==undefined).length>1||(n.outputs||[]).some(p=>p.links&&p.links.length>1)))){notice('当前流程不是完整顺序链，请继续使用画布编辑。');return setSteps(false)}
  if(value&&graph&&graph._nodes.length){const links=Object.values(graph.links).filter(Boolean),targets=new Set(links.map(l=>l.target_id)),ordered=[];let current=graph._nodes.find(n=>!targets.has(n.id));while(current&&!ordered.includes(current)){ordered.push(current);const link=links.find(l=>l.origin_id===current.id);current=link?graph.getNodeById(link.target_id):null}if(ordered.length!==graph._nodes.length){notice('当前流程无法表示为顺序步骤，请使用画布编辑。');return setSteps(false)}graph._nodes=ordered}
  if(stepsMode&&!value&&graph)positionSteps()
  stepsMode=value;$('workflowStepList').classList.toggle('hidden',!value);$('workflowCanvasHost').classList.toggle('hidden',value);$('workflowStepsToggle').textContent=value?'画布视图':'步骤视图';$('workflowStepsToggle').setAttribute('aria-pressed',String(value));if(value){if(canvas)canvas.stopRendering();renderSteps()}else if(canvas){canvas.startRendering();requestAnimationFrame(()=>{resize();fitGraph()})}
 }
 function renderSteps(){const host=$('workflowStepList');host.textContent='';if(!graph)return
  graph._nodes.forEach((n,index)=>{const row=node('article',undefined,'workflow-step-item'+(selectedNode===n?' selected':'')),select=button((index+1)+'. '+n.title,()=>{canvas.selectNode(n);parameter(n)});select.setAttribute('aria-pressed',String(selectedNode===n));const actions=node('div');for(const [offset,label]of [[-1,'上移'],[1,'下移']]){const b=button(label,()=>{const target=index+offset;[graph._nodes[index],graph._nodes[target]]=[graph._nodes[target],graph._nodes[index]];rechain()});const target=graph._nodes[index+offset];b.disabled=['workflow/start','workflow/end'].includes(n.type)||!target||['workflow/start','workflow/end'].includes(target.type);actions.append(b)}row.append(select,node('small',((data.nodes.find(d=>'workflow/'+d.type===n.type)||{}).name||n.type)+(interactionName(n.properties&&n.properties.interaction)?' · '+interactionName(n.properties.interaction):''),'muted'),actions);host.append(row)})
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
  if(type==='human'&&props.interaction&&props.interaction.type!=='handle'){
   const group=node('fieldset');group.append(node('legend','驳回设置'))
   const label=node('label','驳回后退回到'),select=node('select');select.setAttribute('aria-label','驳回退回节点')
   const fallback=node('option','默认 · 最近的上游人工办理节点');fallback.value='';select.append(fallback)
   for(const other of ancestorsOf(n).filter(item=>item.type==='workflow/human')){const option=node('option',other.title+' · '+(other.properties.workflowId||''));option.value=other.properties.workflowId;select.append(option)}
   const configured=props.interaction.returnTo&&props.interaction.returnTo!=='previous-human'?props.interaction.returnTo:''
   select.value=configured
   if(configured&&!select.value)fallback.textContent='默认 · 原指定节点已不在上游'
   select.addEventListener('change',()=>{props.interaction.returnTo=select.value||'previous-human';dirty=true})
   label.append(select);group.append(label,node('p','没有上游人工节点时，此节点只能通过。','muted'));host.append(group)
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
 function renderPorts(n){
  const host=$('workflowPorts');host.textContent=''
  if(!n){host.append(node('p','选择节点后配置端口。','muted'));return}
  for(const [kind,title] of [['inputs','输入'],['outputs','输出']]){
   const group=node('fieldset');group.append(node('legend',title+'端口'))
   const list=n[kind]||[],blocked=kind==='inputs'&&['workflow/input','workflow/start'].includes(n.type)||kind==='outputs'&&['workflow/output','workflow/end'].includes(n.type)
   list.forEach((port,index)=>{
    const row=node('div',undefined,'workflow-port-row'),label=node('label'),input=node('input');input.value=port.name;input.maxLength=40;input.setAttribute('aria-label',title+'端口'+(index+1)+'名称');label.append(input)
    input.addEventListener('input',()=>{port.name=input.value;dirty=true;graph.setDirtyCanvas(true,true)})
    row.append(label,button('×',()=>{if(kind==='inputs')n.removeInput(index);else n.removeOutput(index);n.size=n.computeSize();dirty=true;renderPorts(n);graph.setDirtyCanvas(true,true)},'删除'+title+'端口 '+port.name));group.append(row)
   })
   if(!blocked){const add=button('＋ 添加'+title,()=>{if(list.length>=32)return;let index=list.length+1;while(list.some(p=>p.name===title+index))index++;if(kind==='inputs')n.addInput(title+index,'text');else n.addOutput(title+index,'text');n.size=n.computeSize();dirty=true;renderPorts(n);graph.setDirtyCanvas(true,true)});add.disabled=list.length>=32;group.append(add)}
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
  graph.onNodeRemoved=()=>{dirty=true;parameter(null)}
  canvas=window.workflowCanvasLifecycle.create($('workflowCanvas'),graph)
  canvas.background_image=null
  canvas.render_canvas_border=false
  canvas.show_info=false
  const drawNode=canvas.drawNode
  canvas.render_shadows=false
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
  canvas.onDrawForeground=drawSplitGuide
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
     // 新加的人工节点从“办理”开始：默认只要描述和一个提交按钮。
     if(type.type==='human')n.properties.interaction={version:1,type:'handle',returnTo:'previous-human'}
     n.pos=[canvas.canvas.width/(2*canvas.ds.scale)-canvas.ds.offset[0]-n.size[0]/2+(graph._nodes.length%3)*24,canvas.canvas.height/(2*canvas.ds.scale)-canvas.ds.offset[1]-n.size[1]/2+(graph._nodes.length%3)*24]
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
 let splitAxis='x',splitGesture=null,splitGuide=null
 function canvasModeSet(mode){
  finishSplit(true);canvasMode=mode;splitGuide=null
  if(canvas){canvas.allow_dragnodes=mode==='select';canvas.allow_interaction=!['box','split'].includes(mode);canvas.dragging_canvas=false;canvas.connecting_node=null;canvas.setDirty(true,true)}
  $('workflowCanvas').style.cursor=mode==='split'?(splitAxis==='x'?'ew-resize':'ns-resize'):mode==='box'||mode==='connect'?'crosshair':'default'
  for(const b of document.querySelectorAll('[data-canvas-mode]'))b.setAttribute('aria-pressed',String(b.dataset.canvasMode===mode))
  const axis=$('workflowSplitAxis');if(axis){axis.hidden=mode!=='split';axis.textContent=splitAxis==='x'?'左右':'上下';axis.setAttribute('aria-label','分割方向：'+(splitAxis==='x'?'左右，点击切换上下':'上下，点击切换左右'))}
  $('workflowCanvasHint').textContent=mode==='split'?'拖动分割线拉开或收拢两侧全部节点 · 切换左右/上下 · Esc 取消本次移动':mode==='box'?'拖动框选多个节点 · 松开后拖动任一卡片整体移动':mode==='connect'?'从输出圆点拖到输入圆点连线 · Esc 返回选择':'拖动节点移动 · 拖动空白平移 · 滚轮缩放 · Shift 点选多个'
 }
 function splitPoint(event){const rect=$('workflowCanvas').getBoundingClientRect();return[(event.clientX-rect.left)/canvas.ds.scale-canvas.ds.offset[0],(event.clientY-rect.top)/canvas.ds.scale-canvas.ds.offset[1]]}
 function drawSplitGuide(ctx){
  if(canvasMode!=='split'||!splitGuide||!canvas)return
  const scale=canvas.ds.scale,left=-canvas.ds.offset[0],top=-canvas.ds.offset[1],width=canvas.canvas.width/scale,height=canvas.canvas.height/scale,value=splitGuide[splitAxis==='x'?0:1]
  ctx.save();ctx.strokeStyle=cardTheme.selected;ctx.lineWidth=1.5/scale;ctx.setLineDash([6/scale,5/scale]);ctx.beginPath();if(splitAxis==='x'){ctx.moveTo(value,top);ctx.lineTo(value,top+height)}else{ctx.moveTo(left,value);ctx.lineTo(left+width,value)}ctx.stroke();ctx.restore()
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
  if(splitGesture){const axis=splitGesture.axis,index=axis==='x'?0:1,delta=splitGuide[index]-splitGesture.start[index];for(const item of splitGesture.nodes)item.node.pos[index]=item.pos[index]+item.side*delta/2;splitGesture.moved=Math.abs(delta)>.01}
  canvas.setDirty(true,true)
 }
 let canvasMenu=null
 function closeCanvasMenu(restore){if(!canvasMenu)return;canvasMenu.remove();canvasMenu=null;if(restore)$('workflowCanvas').focus()}
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
  const entries=[['select','wf-select','选择与移动节点',()=>canvasModeSet('select')],['connect','wf-link','连接节点端口',()=>canvasModeSet('connect')],['box','wf-marquee','框选多个节点',()=>canvasModeSet('box')],['split','wf-split','分割移动两侧所有节点',()=>canvasModeSet('split')]]
  for(const [key,iconName,title,action] of entries){const b=button('',action,title),icon=node('span',undefined,'icon');icon.setAttribute('data-icon',iconName);icon.setAttribute('aria-hidden','true');b.append(icon);b.dataset.canvasAction=key;b.dataset.canvasMode=key;b.setAttribute('aria-pressed','false');host.append(b)}
  const axis=button('左右',()=>{splitAxis=splitAxis==='x'?'y':'x';canvasModeSet('split')});axis.id='workflowSplitAxis';axis.className='workflow-split-axis';host.append(axis)
  const zoom=node('span','100%','workflow-zoom');zoom.id='workflowZoom';zoom.setAttribute('aria-label','画布缩放比例');host.append(zoom)
  if(window.applyIcons)window.applyIcons(host);canvasModeSet('select');updateZoom()
 }
 const pointer=typeof LiteGraph!=='undefined'?LiteGraph.pointerevents_method:'pointer'
 document.addEventListener(pointer+'down',event=>{
  if(canvasMenu&&!canvasMenu.contains(event.target))closeCanvasMenu(false)
  if(mode!=='editor'||canvasMode!=='split'||event.target!==$('workflowCanvas')||event.button!==0)return
  const start=splitPoint(event),index=splitAxis==='x'?0:1
  splitGesture={axis:splitAxis,start,nodes:graph._nodes.map(n=>({node:n,pos:Array.from(n.pos),side:n.pos[index]+(index===0?n.size[0]:(n.size[1]-LiteGraph.NODE_TITLE_HEIGHT))/2<start[index]?-1:1})),moved:false}
  splitGuide=start;canvas.canvas.focus();canvas.setDirty(true,true);event.preventDefault();event.stopImmediatePropagation()
 },true)
 document.addEventListener(pointer+'move',event=>{
  if(mode!=='editor'||canvasMode!=='split'||!canvas||!splitGesture&&event.target!==$('workflowCanvas'))return
  moveSplit(event);if(splitGesture){event.preventDefault();event.stopImmediatePropagation()}
 },true)
 document.addEventListener(pointer+'up',event=>{
  if(splitGesture){moveSplit(event);finishSplit(false);event.preventDefault();event.stopImmediatePropagation();return}
  if(mode==='editor'&&canvasMode==='box')Promise.resolve().then(()=>{if(canvas&&canvasMode==='box')canvasModeSet('select')})
 },true)
 document.addEventListener('pointercancel',()=>finishSplit(true),true)
 $('workflowCanvas').addEventListener('mouseleave',()=>{if(!splitGesture){splitGuide=null;if(canvas)canvas.setDirty(true,true)}})
 $('workflowCanvas').addEventListener('keydown',event=>{if(event.key==='Escape'){finishSplit(true);closeCanvasMenu(false);canvasModeSet('select');if(canvas){canvas.deselectAllNodes();canvas.dragging_rectangle=null;canvas.setDirty(true,true)}event.preventDefault()}if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const box=$('workflowCanvas').getBoundingClientRect();showCanvasMenu(box.left+40,box.top+40)}},true)
 $('workflowCanvas').addEventListener('wheel',event=>{if(!canvas||mode!=='editor')return;event.preventDefault();event.stopImmediatePropagation();if(splitGesture||!event.deltaY)return;const rect=canvas.canvas.getBoundingClientRect();canvas.ds.changeScale(canvas.ds.scale*(event.deltaY<0?1.1:1/1.1),[event.clientX-rect.left,event.clientY-rect.top]);canvas.setDirty(true,true);updateZoom()},{passive:false,capture:true})
 window.addEventListener('blur',()=>{finishSplit(true);closeCanvasMenu(false)})
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
   const nodes=graph._nodes.map(n=>({...Object.fromEntries(['interaction','inputSchema','outputSchema','bindings','skills','agent','tool','deliverable','processing'].filter(k=>n.properties[k]!==undefined&&!(k==='interaction'&&n.type!=='workflow/human')).map(k=>[k,n.properties[k]])),id:n.properties.workflowId||nextNodeId(n.type.split('/')[1]),type:n.type.split('/')[1],title:n.title,text:n.properties.text||'',description:n.properties.description||'',humanKind:n.properties.humanKind||'review',humanModes:humanModes(n.properties),rest:n.properties.rest||{url:'',method:'GET'},inputs:(n.inputs||[]).map(p=>({name:p.name,type:'text'})),outputs:(n.outputs||[]).map(p=>({name:p.name,type:'text'})),pos:Array.from(n.pos)}))
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
 $('workflowInteractionType').addEventListener('change',()=>{
 if(!selectedNode||selectedNode.type!=='workflow/human')return
 const value=$('workflowInteractionType').value
 if(value==='legacy')delete selectedNode.properties.interaction
 else selectedNode.properties.interaction={version:1,type:value,returnTo:selectedNode.properties.interaction&&selectedNode.properties.interaction.returnTo||'previous-human'}
 // 交互类型决定提交语义，旧的必填结论不再适用。
 if(value!=='legacy'&&selectedNode.properties.processing){
  selectedNode.properties.processing.blocks=(selectedNode.properties.processing.blocks||[]).filter(b=>b.type!=='conclusion')
  if(!selectedNode.properties.processing.blocks.length)delete selectedNode.properties.processing
 }
 dirty=true;parameter(selectedNode)
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
