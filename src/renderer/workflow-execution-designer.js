'use strict'
;(function(){
 const clone=value=>JSON.parse(JSON.stringify(value))
 const el=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element}
 const object=value=>value&&typeof value==='object'&&!Array.isArray(value)
 const icon=name=>{const item=el('span',undefined,'icon');item.setAttribute('aria-hidden','true');if(window.renderIcon)item.innerHTML=window.renderIcon(name);return item}
 const api=(action,data)=>window.dsh.workflowRequest(action,data)
 let active=null,serial=0,preferredModel=null
 const TYPE_TITLES={handle:'办理 · 完成并继续',review:'审阅 · 已审阅，继续',approve:'审批 · 通过或驳回'}
 function baseline(node){
  const design={version:1,instruction:String(node.text||node.description||''),inputSchema:node.inputSchema||null,outputSchema:node.outputSchema||null,bindings:node.bindings||{},...(['agent','tool'].includes(node.type)?{runPermission:(node.type==='tool'?node.tool&&node.tool.permission:node.agent&&node.agent.permission)||'readonly'}:{})}
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
   const chatHeading=el('header',undefined,'workflow-design-chat-heading'),chatTitle=el('span','节点设计助手'),status=el('span','待输入','workflow-design-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.dataset.state='idle';chatHeading.append(icon('customize'),chatTitle,status)
   const messages=el('div',undefined,'workflow-design-messages');messages.setAttribute('role','log');messages.setAttribute('aria-live','polite');messages.setAttribute('aria-label','节点执行设计会话')
   const pending=el('article',undefined,'workflow-design-pending'),pendingSpinner=el('span',undefined,'workflow-design-spinner');pendingSpinner.setAttribute('aria-hidden','true');pending.append(pendingSpinner,el('span','正在设计执行操作…'));pending.hidden=true;messages.append(pending)
   const prompts=el('div',undefined,'workflow-design-suggestions'),composer=el('form',undefined,'workflow-design-composer'),messageLabel=el('label','描述你需要的执行操作'),input=el('textarea'),composerActions=el('div',undefined,'workflow-design-composer-actions'),requestState=el('p','','workflow-design-request-state muted'),stop=el('button','停止生成'),send=el('button','生成设计','primary')
   const composerOptions=el('div',undefined,'workflow-design-composer-options'),modelField=el('label',undefined,'workflow-design-option'),modelSelect=el('select'),follow=el('option','跟随当前模型');modelSelect.id=id+'Model';modelSelect.setAttribute('aria-label','设计模型');modelField.htmlFor=modelSelect.id;follow.value='';modelSelect.append(follow);modelSelect.disabled=true;modelField.append(icon('model'),modelSelect);composerOptions.append(modelField)
   const permissionField=el('label',undefined,'workflow-design-option'),permissionSelect=el('select'),hasRunPermission=['agent','tool'].includes(original.type);permissionSelect.id=id+'Permission';permissionSelect.setAttribute('aria-label','节点运行权限');permissionField.htmlFor=permissionSelect.id;for(const [value,text]of [['readonly','只读'],['workspace','工作区修改'],['full','完全访问']]){const option=el('option',text);option.value=value;permissionSelect.append(option)}permissionSelect.value=baseline(original).runPermission||'readonly';permissionSelect.disabled=!hasRunPermission;permissionField.append(icon('shield-check'),permissionSelect);composerOptions.append(permissionField)
   let modelChoices=[],modelsLoading=true
   input.rows=3;input.maxLength=4000;input.placeholder=original.type==='human'?'例如：上传材料，填写任务名称、负责人和截止时间，审阅后通过或驳回。':'例如：明确本步骤的处理指令，并返回包含结论、依据、风险的结构化结果。';input.id=id+'Prompt';messageLabel.htmlFor=input.id;composer.append(messageLabel,input);stop.type='button';stop.dataset.designAction='stop';stop.hidden=true;send.type='submit';composerActions.append(composerOptions,stop,send);composer.append(requestState,composerActions)
   for(const text of original.type==='human'?['增加文件上传和资料说明','设计一张任务登记表','增加通过与驳回操作']:['明确输入与输出字段','完善结构化评估结果']){const suggestion=el('button',text);suggestion.type='button';suggestion.addEventListener('click',()=>{input.value=text;input.focus()});prompts.append(suggestion)}
   chat.append(chatHeading,messages,prompts,composer)
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
   const stage=el('div',undefined,'workflow-design-preview-stage'),generationMask=el('div',undefined,'workflow-design-generation'),generationCard=el('div',undefined,'workflow-design-generation-card'),generationSpinner=el('span',undefined,'workflow-design-spinner');generationMask.hidden=true;generationMask.setAttribute('aria-hidden','true');generationSpinner.setAttribute('aria-hidden','true');generationCard.append(generationSpinner,el('strong','正在生成执行操作'),el('p','完成后会更新预览，当前设计会保留。'));generationMask.append(generationCard)
   json.id=id+'Json';jsonLabel.htmlFor=json.id;json.spellcheck=false;json.rows=16;json.setAttribute('aria-describedby',id+'Error');validate.type='button';protocol.hidden=true;protocol.append(jsonLabel,json,validate,el('p','只接受标准数据协议，不支持 HTML、脚本或任意可执行代码。','muted'))
   const feedback=el('p','','workflow-design-feedback'),actions=el('footer',undefined,'modal-actions workflow-design-actions'),saveHint=el('p','应用到当前流程草稿，保存流程后生效；不会启动执行。','muted'),cancel=el('button','取消'),apply=el('button','应用并保存','primary')
   feedback.id=id+'Error';feedback.setAttribute('role','alert');input.setAttribute('aria-describedby',feedback.id);cancel.type=apply.type='button';actions.append(saveHint,cancel,apply);stage.append(preview,protocol,generationMask);previewPane.append(previewHeader,settings,stage,feedback,actions);workspace.append(chat,previewPane);card.append(heading,workspace);overlay.append(card)
   document.body.append(overlay)
   const state={closed:false,applying:false,requestId:'',generation:0,design:baseline(original),history:[],jsonMode:false,close:null}
   const rejectTargets=(window.workflowUI&&window.workflowUI.detectRejectTarget)?window.workflowUI.detectRejectTarget(workflow,original.id):{candidates:[],detected:null}
   const append=(role,text)=>{const row=el('article',undefined,'workflow-design-message is-'+role),avatar=el('span',undefined,'workflow-design-avatar'),bubble=el('div',undefined,'workflow-design-bubble'),body=el('p',String(text||'').slice(0,20000));row.setAttribute('aria-label',role==='user'?'你的消息':'设计助手的消息');avatar.append(icon(role==='user'?'wf-human':'customize'));bubble.append(body);row.append(avatar,bubble);messages.insertBefore(row,pending);while(messages.querySelectorAll('.workflow-design-message').length>14)messages.querySelector('.workflow-design-message').remove();messages.scrollTop=messages.scrollHeight}
   const setStatus=(phase,text)=>{status.dataset.state=phase;status.textContent=text}
   function setGenerating(value){
    const disabled=value||state.applying
    generationMask.hidden=!value;pending.hidden=!value;stage.setAttribute('aria-busy',String(disabled));composer.setAttribute('aria-busy',String(disabled));stop.hidden=!value;send.hidden=value;send.disabled=disabled;input.disabled=state.applying
    for(const control of [apply,validate,previewTab,jsonTab,typeSelect,rejectSelect])control.disabled=disabled
    permissionSelect.disabled=disabled||!hasRunPermission
    modelSelect.disabled=disabled||modelsLoading
    if(value){setStatus('running','正在生成');requestState.textContent='正在按节点设计技能生成操作，可随时停止。';messages.scrollTop=messages.scrollHeight}
   }
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
    if(hasRunPermission){permissionSelect.value=state.design.runPermission||'readonly';if(window.agentSelect)window.agentSelect.refresh(permissionSelect)}
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
    const requestId=state.requestId;state.generation++;state.requestId='';setGenerating(false);requestState.textContent=message||''
    if(message){setStatus('stopped','已停止');if(requestId&&!state.closed)append('assistant','已停止生成，之前的设计没有改动。')}
    if(requestId)Promise.resolve().then(()=>api('cancelDesign',{requestId})).catch(()=>{})
   }
   function close(applied){
    if(state.closed||state.applying)return
    state.closed=true;cancelPending()
    overlay.remove();document.removeEventListener('keydown',keydown,true);if(active===state)active=null;if(prior&&prior.isConnected)prior.focus();resolve({applied:applied===true,design:applied===true?clone(state.design):undefined})
   }
   state.close=close;active=state
   async function generate(event){
    event.preventDefault();if(state.closed||state.applying||state.requestId)return
    const message=input.value.trim();if(!message){input.setAttribute('aria-invalid','true');feedback.textContent='请描述需要的节点执行操作。';input.focus();return}
    clearError();cancelPending();const generation=state.generation,requestId='node_design_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);state.requestId=requestId
    const history=state.history.slice(-8);state.history.push({role:'user',content:message});state.history=state.history.slice(-8);append('user',message);input.value='';setGenerating(true)
    try{
     const result=await api('design',{requestId,node:original,workflow,message,history,design:state.design,runPermission:hasRunPermission?permissionSelect.value:undefined,model:modelSelect.value?modelChoices[Number(modelSelect.value)-1]:undefined})
     if(state.closed||generation!==state.generation)return
     const design=checkedDesign(result);state.design=design;const reply=String(result.reply||'已更新当前节点的执行设计，请在右侧预览并确认。');state.history.push({role:'assistant',content:reply});state.history=state.history.slice(-8);append('assistant',reply)
     if(Array.isArray(result.warnings)&&result.warnings.length)feedback.textContent=result.warnings.map(w=>typeof w==='string'?w:w.message||'').filter(Boolean).join('；')
     // 结果一到就刷新预览，不必再切页签。
     syncSettings();renderPreview();showMode(false);setStatus('ready','预览已更新');requestState.textContent='可以继续补充要求，确认后应用并保存。'
    }catch(error){if(!state.closed&&generation===state.generation){feedback.textContent=error.message||'设计生成失败，已保留上一次有效设计。';setStatus('error','生成失败');append('assistant','这次没有生成成功：'+feedback.textContent+'\n已有设计已保留，可以修改要求后重试。');requestState.textContent='生成未完成，当前设计保持不变。';if(!input.value.trim())input.value=message}}
    finally{if(!state.closed&&generation===state.generation){state.requestId='';setGenerating(false)}}
   }
   async function applyDesign(){
    if(state.closed||state.applying||state.requestId)return;clearError();state.applying=true;setGenerating(false);cancel.disabled=true;closeButton.disabled=true;setStatus('saving','正在保存')
    try{
     const raw=state.jsonMode?JSON.parse(json.value):state.design,design=await validateDraft(raw);if(state.closed)return
     cancelPending();state.design=design;renderPreview();state.applying=true;cancel.disabled=true;closeButton.disabled=true
     if(typeof options.onApply!=='function')throw Error('当前节点没有可用的应用入口')
     await options.onApply(clone(design));state.applying=false;close(true)
    }catch(error){if(!state.closed){setStatus('error','保存失败');feedback.textContent=error.message||'设计应用失败';if(state.jsonMode)json.setAttribute('aria-invalid','true')}}
    finally{state.applying=false;if(!state.closed){setGenerating(false);cancel.disabled=false;closeButton.disabled=false}}
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
   modelSelect.addEventListener('change',()=>{preferredModel=modelSelect.value?clone(modelChoices[Number(modelSelect.value)-1]):null})
   permissionSelect.title=hasRunPermission?'保存后用于当前节点实际运行，仍受工具白名单、工作目录范围和执行限额约束。':'此节点不执行文件或命令工具；运行权限仅适用于 Agent 与工具节点。'
   permissionField.title=permissionSelect.title
   permissionSelect.addEventListener('change',()=>{if(!hasRunPermission)return;let edited=state.design;if(state.jsonMode){try{edited=JSON.parse(json.value);if(!object(edited))throw Error('协议需要对象')}catch(_){permissionSelect.value=state.design.runPermission||'readonly';if(window.agentSelect)window.agentSelect.refresh(permissionSelect);feedback.textContent='请先修正协议 JSON，再修改运行权限。';return}}edited.runPermission=permissionSelect.value;state.design.runPermission=permissionSelect.value;json.value=JSON.stringify(edited,null,2);requestState.textContent='运行权限已调整，应用并保存流程后生效。'})
   api('designOptions',{}).then(value=>{
    if(state.closed)return
    follow.textContent='当前模型'+(value.current&&value.current.model?' · '+value.current.model:'')
    for(const provider of value.providers||[]){const group=el('optgroup');group.label=provider.name;for(const name of provider.models||[]){modelChoices.push({providerId:provider.id,model:name});const option=el('option',name);option.value=String(modelChoices.length);group.append(option)}modelSelect.append(group)}
    if(preferredModel){const index=modelChoices.findIndex(choice=>choice.providerId===preferredModel.providerId&&choice.model===preferredModel.model);modelSelect.value=index<0?'':String(index+1)}
   }).catch(()=>{if(!state.closed)follow.textContent='当前模型（列表未加载）'}).finally(()=>{modelsLoading=false;if(!state.closed)modelSelect.disabled=state.applying||!!state.requestId})
   document.addEventListener('keydown',keydown,true)
   append('assistant',original.type==='human'?'描述这个节点需要怎样办理，例如填写信息、上传材料或审阅审批。我会生成右侧操作，确认后再应用。':'描述这个节点要完成的任务，我会完善执行指令与输入输出。确认预览后再应用。');requestState.textContent='Ctrl / ⌘ + Enter 生成设计';syncSettings();renderPreview();requestAnimationFrame(()=>{if(!state.closed)input.focus()})
  })
 }
 window.workflowExecutionDesigner={open}
})()
