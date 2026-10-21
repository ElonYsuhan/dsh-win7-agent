'use strict'
;(function(){
 const clone=value=>JSON.parse(JSON.stringify(value))
 const el=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element}
 const object=value=>value&&typeof value==='object'&&!Array.isArray(value)
 const api=(action,data)=>window.dsh.workflowRequest(action,data)
 let active=null,serial=0
 const TYPE_TITLES={handle:'办理 · 完成并继续',review:'审阅 · 已审阅，继续',approve:'审批 · 通过或驳回'}
 function baseline(node){
  const design={version:1,instruction:String(node.text||node.description||''),inputSchema:node.inputSchema||null,outputSchema:node.outputSchema||null,bindings:node.bindings||{}}
  if(node.type==='human'){
   const modes=Array.isArray(node.humanModes)?node.humanModes:[node.humanKind||'review']
   design.interaction=clone(node.interaction||{version:1,type:modes.includes('approval')?'approve':modes.includes('read')?'review':'handle',returnTo:'previous-human'})
   const blocks=node.interaction?[{type:'instructions'},...(node.inputSchema?[{type:'form'}]:[]),...(modes.includes('upload')?[{type:'attachments',required:true}]:[]),{type:'conclusion',title:'备注',required:false}]:[{type:'instructions',title:'处理要求'},...(node.inputSchema?[{type:'form',title:node.inputSchema.title||'处理表单'}]:[]),{type:'attachments',title:'附件',required:modes.includes('upload')},{type:'conclusion',title:modes.includes('approval')?'审批意见':'处理结论',required:true}]
   design.processing=clone(node.processing||{version:1,blocks})
   if(modes.includes('upload'))for(const block of design.processing.blocks)if(block.type==='attachments')block.required=true
  }
  if(node.type!=='human'){design.interaction=null;design.processing=null}
  return clone(design)
 }
 function open(options){
  if(!options||!object(options.node))return Promise.reject(Error('请选择要设计执行操作的节点'))
  if(active){if(active.applying)return Promise.reject(Error('当前设计正在应用，请稍候'));active.close()}
  return new Promise(resolve=>{
   const original=clone(options.node),workflow=clone(options.workflow||{}),prior=document.activeElement,id='workflowExecutionDesigner'+(++serial)
   const overlay=el('div',undefined,'task-dialog workflow-execution-designer'),card=el('section',undefined,'task-editor workflow-design-card'),heading=el('header',undefined,'task-dialog-heading workflow-design-heading'),title=el('h2','节点执行设计'),closeButton=el('button','关闭','workflow-design-close')
   title.id=id+'Title';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby',title.id);closeButton.type='button';closeButton.setAttribute('aria-label','关闭节点执行设计');heading.append(title,closeButton)
   const workspace=el('div',undefined,'workflow-design-workspace'),chat=el('section',undefined,'workflow-design-chat'),previewPane=el('section',undefined,'workflow-design-preview-pane')
   const messages=el('div',undefined,'workflow-design-messages');messages.setAttribute('role','log');messages.setAttribute('aria-live','polite');messages.setAttribute('aria-label','节点执行设计会话')
   const prompts=el('div',undefined,'workflow-design-suggestions'),composer=el('form',undefined,'workflow-design-composer'),messageLabel=el('label','描述你需要的执行操作'),input=el('textarea'),composerActions=el('div',undefined,'workflow-design-composer-actions'),requestState=el('p','','workflow-design-request-state muted'),stop=el('button','停止生成'),send=el('button','生成设计','primary')
   input.rows=3;input.maxLength=4000;input.placeholder=original.type==='human'?'例如：上传材料，填写任务名称、负责人和截止时间，审阅后通过或驳回。':'例如：明确本步骤的处理指令，并返回包含结论、依据、风险的结构化结果。';input.id=id+'Prompt';messageLabel.htmlFor=input.id;composer.append(messageLabel,input);stop.type='button';stop.hidden=true;send.type='submit';composerActions.append(stop,send);composer.append(requestState,composerActions)
   for(const text of original.type==='human'?['增加文件上传和资料说明','设计一张任务登记表','增加通过与驳回操作']:['明确输入与输出字段','完善结构化评估结果']){const suggestion=el('button',text);suggestion.type='button';suggestion.addEventListener('click',()=>{input.value=text;input.focus()});prompts.append(suggestion)}
   // 更多设置：附件 / 填写项 / 补充意见，以及步骤说明与数据协议，收在左栏折叠区，不再单独开页签。
   const more=el('details',undefined,'workflow-design-more'),moreSummary=el('summary','更多设置');more.append(moreSummary);more.hidden=original.type!=='human'
   chat.append(messages,prompts,composer,more)
   const previewHeader=el('header',undefined,'workflow-design-preview-header'),previewTitle=el('h3','执行操作预览'),tabs=el('div',undefined,'workflow-design-tabs'),previewTab=el('button','操作预览'),jsonTab=el('button','协议 JSON')
   previewTab.type=jsonTab.type='button';previewTab.setAttribute('aria-pressed','true');jsonTab.setAttribute('aria-pressed','false');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','设计预览方式');tabs.append(previewTab,jsonTab);previewHeader.append(previewTitle,tabs)
   const settings=el('div',undefined,'workflow-design-settings'),settingsHidden=original.type!=='human'
   const typeField=el('label','交互类型'),typeSelect=el('select');typeSelect.setAttribute('aria-label','交互类型')
   for(const [value,text] of Object.entries(TYPE_TITLES)){const option=el('option',text);option.value=value;typeSelect.append(option)}
   typeField.append(typeSelect)
   const rejectField=el('label','驳回退回'),rejectSelect=el('select');rejectSelect.setAttribute('aria-label','驳回退回节点')
   rejectField.append(rejectSelect)
   settings.append(typeField,rejectField);settings.hidden=settingsHidden
   const preview=el('div',undefined,'workflow-design-preview'),protocol=el('div',undefined,'workflow-design-protocol'),jsonLabel=el('label','节点执行设计协议 V1'),json=el('textarea'),validate=el('button','校验并预览')
   json.id=id+'Json';jsonLabel.htmlFor=json.id;json.spellcheck=false;json.rows=16;json.setAttribute('aria-describedby',id+'Error');validate.type='button';protocol.hidden=true;protocol.append(jsonLabel,json,validate,el('p','只接受标准数据协议，不支持 HTML、脚本或任意可执行代码。','muted'))
   const feedback=el('p','','workflow-design-feedback'),actions=el('footer',undefined,'modal-actions workflow-design-actions'),saveHint=el('p','应用到当前流程草稿，保存流程后生效；不会启动执行。','muted'),cancel=el('button','取消'),apply=el('button','应用并保存','primary')
   feedback.id=id+'Error';feedback.setAttribute('role','alert');input.setAttribute('aria-describedby',feedback.id);cancel.type=apply.type='button';actions.append(saveHint,cancel,apply);previewPane.append(previewHeader,settings,preview,protocol,feedback,actions);workspace.append(chat,previewPane);card.append(heading,workspace);overlay.append(card)
   const adopted=[]
   if(original.type==='human'){
    for(const [hostId,caption] of [['workflowHumanExtras','补充内容'],['workflowNodeAdvanced','步骤与参数']]){
     const host=document.getElementById(hostId);if(!host)continue
     const home=host.parentNode,anchor=host.nextSibling,collapsed=host.hidden||host.classList.contains('hidden')
     const label=el('h5',caption,'workflow-design-config-section');more.append(label)
     host.hidden=false;host.classList.remove('hidden');more.append(host)
     adopted.push({host,home,anchor,collapsed,caption:label})
    }
   }
   document.body.append(overlay)
   const state={closed:false,applying:false,requestId:'',generation:0,design:baseline(original),history:[],jsonMode:false,close:null}
   const rejectTargets=(window.workflowUI&&window.workflowUI.detectRejectTarget)?window.workflowUI.detectRejectTarget(workflow,original.id):{candidates:[],detected:null}
   const append=(role,text)=>{const row=el('article',undefined,'workflow-design-message is-'+role),label=el('strong',role==='user'?'你':'节点设计助手'),body=el('p',String(text||'').slice(0,20000));row.append(label,body);messages.append(row);while(messages.children.length>14)messages.firstElementChild.remove();messages.scrollTop=messages.scrollHeight}
   const clearError=()=>{feedback.textContent='';json.removeAttribute('aria-invalid');input.removeAttribute('aria-invalid')}
   function showMode(mode){
    const name=mode===true?'json':mode===false||mode===undefined?'preview':String(mode)
    state.jsonMode=name==='json'
    preview.hidden=name!=='preview';protocol.hidden=name!=='json';settings.hidden=settingsHidden||name!=='preview'
    previewTab.setAttribute('aria-pressed',String(name==='preview'));jsonTab.setAttribute('aria-pressed',String(name==='json'))
    previewTitle.textContent=name==='json'?'节点数据协议':'执行操作预览'
    if(name==='json'){json.value=JSON.stringify(state.design,null,2);json.focus()}
   }
   // 交互类型与驳回退回目标：直接改设计数据，预览立刻跟着变。
   function syncSettings(){
    const interaction=state.design.interaction
    typeSelect.value=interaction&&interaction.type||'handle'
    const canReject=!!interaction&&interaction.type!=='handle'
    rejectField.hidden=!canReject
    if(!canReject)return
    const configured=interaction.returnTo&&interaction.returnTo!=='previous-human'?interaction.returnTo:''
    const detected=rejectTargets.detected
    rejectSelect.textContent=''
    const auto=el('option',detected?'自动 · '+detected.title+'（按连线识别）':'自动 · 没有上游人工节点')
    auto.value='';rejectSelect.append(auto)
    for(const candidate of rejectTargets.candidates){const option=el('option',candidate.title);option.value=candidate.id;rejectSelect.append(option)}
    const known=rejectTargets.candidates.some(candidate=>candidate.id===configured)
    if(configured&&!known){const option=el('option','原指定节点已不在上游');option.value=configured;rejectSelect.append(option)}
    rejectSelect.value=configured
   }
   function previewEntry(){
    const design=state.design,interaction=design.interaction||{version:1,type:'handle',returnTo:'previous-human'}
    const blocks=(design.processing&&design.processing.blocks)||[]
    const modes=[interaction.type==='approve'?'approval':interaction.type==='review'?'read':'review']
    if(blocks.some(block=>block.type==='attachments'&&block.required))modes.push('upload')
    const view=design.processing||{version:1,blocks:[{type:'instructions'}]}
    const target=interaction.returnTo&&interaction.returnTo!=='previous-human'?rejectTargets.candidates.find(candidate=>candidate.id===interaction.returnTo):rejectTargets.detected
    return {interaction,modes,view,target}
   }
   function renderPreview(){
    preview.textContent='';json.value=JSON.stringify(state.design,null,2)
    const design=state.design
    if(original.type!=='human'){
     preview.append(el('h4','自动执行指令'),el('p',design.instruction||'在左侧描述该节点需要完成的任务。','workflow-design-instructions'))
     if(design.outputSchema){const details=el('details');details.open=true;details.append(el('summary','结构化输出协议'),el('pre',JSON.stringify(design.outputSchema,null,2)));preview.append(details)}
     preview.append(el('p','自动节点使用指令和数据协议执行，不生成审批待办。','muted'))
     return
    }
    const {interaction,modes,view,target}=previewEntry()
    const entry={...original,type:'human',text:design.instruction||original.text,inputSchema:design.inputSchema,outputSchema:design.outputSchema,processing:view,interaction}
    const flowView={canReject:!!target,returnTargetTitle:target?target.title:''}
    const built=window.workflowUI.buildHumanTask({entry,interaction,modes,schema:design.inputSchema,view,step:null,flowView,formId:'workflowDesignPreviewForm'})
    const host=el('div',undefined,'workflow-workbench workflow-design-workbench'),body=el('div',undefined,'workflow-workbench-body'),section=el('section',undefined,'workflow-current-task'),content=el('div',undefined,'workflow-human-content')
    content.append(built.form);section.append(content);body.append(section);host.append(body,built.actions)
    host.addEventListener('submit',event=>event.preventDefault(),true)
    host.classList.add('is-preview')
    preview.append(host)
   }
   const unpack=value=>object(value)&&object(value.design)?value.design:value
   const checkedDesign=value=>{const design=unpack(value);if(!object(design)||design.version!==1||typeof design.instruction!=='string')throw Error('节点执行设计返回了无效协议');return clone(design)}
   async function validateDraft(raw){return checkedDesign(await api('validateDesign',{node:original,workflow,design:raw}))}
   function cancelPending(message){
    const requestId=state.requestId;state.generation++;state.requestId='';stop.hidden=true;send.textContent='生成设计';composer.removeAttribute('aria-busy');requestState.textContent=message||''
    if(requestId)Promise.resolve().then(()=>api('cancelDesign',{requestId})).catch(()=>{})
   }
   function close(applied){
    if(state.closed||state.applying)return
    state.closed=true;cancelPending()
    // 归还被采纳的配置块，避免下次打开时重复搬迁或残留在已移除的弹层里。
    for(const item of adopted){
     if(item.caption&&item.caption.parentNode)item.caption.remove()
     if(item.host.parentNode!==item.home&&item.home)item.home.insertBefore(item.host,item.anchor&&item.anchor.parentNode===item.home?item.anchor:null)
     item.host.hidden=item.collapsed
     if(item.collapsed)item.host.classList.add('hidden');else item.host.classList.remove('hidden')
    }
    overlay.remove();document.removeEventListener('keydown',keydown,true);if(active===state)active=null;if(prior&&prior.isConnected)prior.focus();resolve({applied:applied===true,design:applied===true?clone(state.design):undefined})
   }
   state.close=close;active=state
   async function generate(event){
    event.preventDefault();if(state.closed||state.applying)return
    const message=input.value.trim();if(!message){input.setAttribute('aria-invalid','true');feedback.textContent='请描述需要的节点执行操作。';input.focus();return}
    clearError();cancelPending();const generation=state.generation,requestId='node_design_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);state.requestId=requestId
    const history=state.history.slice(-8);state.history.push({role:'user',content:message});state.history=state.history.slice(-8);append('user',message);input.value='';stop.hidden=false;send.textContent='重新生成';composer.setAttribute('aria-busy','true');requestState.textContent='正在按节点设计技能生成操作…'
    try{
     const result=await api('design',{requestId,node:original,workflow,message,history,design:state.design})
     if(state.closed||generation!==state.generation)return
     const design=checkedDesign(result);state.design=design;const reply=String(result.reply||'已更新当前节点的执行设计，请在右侧预览并确认。');state.history.push({role:'assistant',content:reply});state.history=state.history.slice(-8);append('assistant',reply)
     if(Array.isArray(result.warnings)&&result.warnings.length)feedback.textContent=result.warnings.map(w=>typeof w==='string'?w:w.message||'').filter(Boolean).join('；')
     // 结果一到就刷新预览，不必再切页签。
     syncSettings();renderPreview();showMode(false);requestState.textContent='设计已更新，尚未应用到节点。'
    }catch(error){if(!state.closed&&generation===state.generation){feedback.textContent=error.message||'设计生成失败，已保留上一次有效设计。';requestState.textContent='生成未完成，当前设计保持不变。'}}
    finally{if(!state.closed&&generation===state.generation){state.requestId='';stop.hidden=true;send.textContent='生成设计';composer.removeAttribute('aria-busy')}}
   }
   async function applyDesign(){
    if(state.closed||state.applying)return;clearError();apply.disabled=true;validate.disabled=true
    try{
     const raw=state.jsonMode?JSON.parse(json.value):state.design,design=await validateDraft(raw);if(state.closed)return
     cancelPending();state.design=design;renderPreview();state.applying=true;cancel.disabled=true;closeButton.disabled=true
     if(typeof options.onApply!=='function')throw Error('当前节点没有可用的应用入口')
     await options.onApply(clone(design));state.applying=false;close(true)
    }catch(error){if(!state.closed){feedback.textContent=error.message||'设计应用失败';if(state.jsonMode)json.setAttribute('aria-invalid','true')}}
    finally{state.applying=false;if(!state.closed){apply.disabled=false;validate.disabled=false;cancel.disabled=false;closeButton.disabled=false}}
   }
   async function validateJson(){
    clearError();validate.disabled=true
    try{const design=await validateDraft(JSON.parse(json.value));if(state.closed)return;state.design=design;syncSettings();renderPreview();showMode(false);feedback.textContent='协议校验通过，预览已更新。'}catch(error){if(!state.closed){feedback.textContent=error.message;json.setAttribute('aria-invalid','true');json.focus()}}finally{if(!state.closed)validate.disabled=false}
   }
   function keydown(event){
    if(state.closed)return
    if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();close(false)}
    if(event.key==='Tab'){
     const controls=Array.from(overlay.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')).filter(control=>!control.disabled&&control.getClientRects().length),first=controls[0],last=controls[controls.length-1]
     if(!first)return
     if(event.shiftKey&&(document.activeElement===first||!overlay.contains(document.activeElement))){event.preventDefault();event.stopImmediatePropagation();last.focus()}
     else if(!event.shiftKey&&(document.activeElement===last||!overlay.contains(document.activeElement))){event.preventDefault();event.stopImmediatePropagation();first.focus()}
    }
   }
   typeSelect.addEventListener('change',()=>{const current=state.design.interaction||{version:1,returnTo:'previous-human'};state.design.interaction={version:1,type:typeSelect.value,returnTo:current.returnTo||'previous-human'};syncSettings();renderPreview()})
   rejectSelect.addEventListener('change',()=>{if(!state.design.interaction)return;state.design.interaction.returnTo=rejectSelect.value||'previous-human';renderPreview()})
   closeButton.addEventListener('click',()=>close(false));cancel.addEventListener('click',()=>close(false));previewTab.addEventListener('click',()=>{if(state.jsonMode&&json.value!==JSON.stringify(state.design,null,2))validateJson();else showMode(false)});jsonTab.addEventListener('click',()=>showMode(true));validate.addEventListener('click',validateJson);apply.addEventListener('click',applyDesign);composer.addEventListener('submit',generate);stop.addEventListener('click',()=>cancelPending('已停止生成，保留当前设计。'))
   input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();composer.requestSubmit()}})
   document.addEventListener('keydown',keydown,true)
   syncSettings();renderPreview();requestAnimationFrame(()=>{if(!state.closed)input.focus()})
  })
 }
 window.workflowExecutionDesigner={open}
})()
