'use strict'
;(function () {
  const $=id=>document.getElementById(id)
  /* 定时任务的固定策略（界面不再暴露这些，2026-10-17 收敛为内置默认） */
  const BUILTIN={projectId:'',permission:'readonly',catchUp:false,
    tools:['list_dir','read_file','search_files'],commands:[],origins:[],
    timeoutMs:600000,maxSteps:20,tokenBudget:100000,maxTokens:4096,maxRequests:20,outputBytes:262144,failureLimit:3}
  const HOME_TZ=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'
  const WEEKDAYS=['\u5468\u65e5','\u5468\u4e00','\u5468\u4e8c','\u5468\u4e09','\u5468\u56db','\u5468\u4e94','\u5468\u516d']
  const TRIGGERS={manual:'\u624b\u52a8',scheduled:'\u5b9a\u65f6',catchup:'\u8865\u8dd1',skipped:'\u9519\u8fc7'}
  const statuses={pending:'等待执行',running:'运行中',completed:'成功',failed:'失败',needs_attention:'需人工处理',interrupted:'已中断',cancelled:'已停止',timed_out:'超时',exhausted:'达到限制',skipped:'已跳过'}
  let host, data={tasks:[],runs:[],tools:[]}, editing=null, loading=false, refreshAgain=false, initialized=false, previewSequence=0, filter="all", batch=false, selected=new Set(), priorFocus=null, saving=false, batchBusy=false
  const toggling=new Set()
  function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
  function date(n,timezone){return n?new Date(n).toLocaleString(undefined,timezone?{timeZone:timezone,timeZoneName:'short'}:undefined):'—'}
  function notice(message){$('taskNotice').textContent=message;if(!$('taskDialog').classList.contains('hidden'))$('taskEditorError').textContent=message}
  async function request(action,value){try{return await window.dsh.taskRequest(action,value)}catch(e){notice(e.message);throw e}}
  function button(text,action){const b=el('button',text);b.type='button';b.addEventListener('click',()=>{const menu=b.closest('.task-card-menu');if(menu){menu.open=false;menu.querySelector('summary').focus()}Promise.resolve().then(action).catch(()=>{})});return b}
  function describe(rule){
    if(rule.kind==='interval')return rule.minutes%1440===0?'每 '+(rule.minutes/1440)+' 天':(rule.minutes%60===0?'每 '+(rule.minutes/60)+' 小时':'每 '+rule.minutes+' 分钟')
    return (rule.kind==='weekly'?'每周'+WEEKDAYS[rule.weekday]:'每天')+' '+rule.time
  }
  async function notifyRun(run){
    if(!window.shell||!window.shell.taskNotify||!['failed','needs_attention','interrupted','timed_out','exhausted'].includes(run.status))return
    let seen=[];try{seen=JSON.parse(localStorage.getItem('task-notifications')||'[]')}catch(_){}
    if(seen.includes(run.id)||Date.now()-(run.endedAt||run.createdAt)>86400000)return
    seen.push(run.id);try{localStorage.setItem('task-notifications',JSON.stringify(seen.slice(-200)))}catch(_){}
    try{await window.shell.taskNotify({title:run.task.name,status:run.status})}catch(_){}
  }
  /* 通知中心：任务跑完、而这条会话当前没打开时才亮红点（用户 2026-10-17）。
     点铃铛看列表，点条目直接打开那次运行的会话。 */
  let notices=[]
  function loadNotices(){try{notices=JSON.parse(localStorage.getItem('task-notices')||'[]')}catch(_){notices=[]}}
  function saveNotices(){try{localStorage.setItem('task-notices',JSON.stringify(notices.slice(-50)))}catch(_){}}
  function pushNotice(item){
    if(notices.some(n=>n.runId===item.runId))return
    notices.push(item);notices=notices.slice(-50);saveNotices();renderNotices()
  }
  function markNoticeRead(runId){const hit=notices.find(n=>n.runId===runId);if(hit&&!hit.read){hit.read=true;saveNotices();renderNotices()}}
  function renderNotices(){
    const box=$('taskNoticeList'),items=$('taskNoticeItems'),dot=$('taskNoticeDot'),empty=$('taskNoticeEmpty')
    if(!box)return
    const unread=notices.filter(n=>!n.read).length
    if(dot)dot.hidden=unread===0
    const bell=$('taskNoticeBell')
    if(bell)bell.setAttribute('aria-label',unread?('通知（'+unread+' 条未读）'):'通知')
    if(items){items.textContent=''
      for(const item of notices.slice().reverse()){
        const row=el('button',undefined,'notice-item'+(item.read?'':' is-unread'))
        row.type='button'
        row.appendChild(el('span',item.title,'notice-item-title'))
        row.appendChild(el('span',(statuses[item.status]||item.status)+' · '+whenText(item.at),'notice-item-meta'))
        row.addEventListener('click',()=>openNotice(item))
        items.appendChild(row)
      }}
    if(empty)empty.hidden=notices.length>0
  }
  async function openNotice(item){
    markNoticeRead(item.runId)
    closeNotices()
    try{const value=await request('conversation',{runId:item.runId});await host.open(value)}catch(e){notice(e.message)}
  }
  function closeNotices(){const box=$('taskNoticeList');if(box)box.classList.add('hidden');const bell=$('taskNoticeBell');if(bell)bell.setAttribute('aria-expanded','false')}
  async function refresh(){if(!host)return;if(loading){refreshAgain=true;return}loading=true;try{data=await request('list');if(data.error)notice('任务调度已停止：'+data.error+'。请处理存储异常后重启服务。');if(host.sync)host.sync(data);for(const run of data.runs)notifyRun(run);render()}finally{loading=false;if(refreshAgain){refreshAgain=false;refresh().catch(()=>{})}}}
  function visibleTasks(){const query=$('taskSearch').value.trim().toLowerCase();return data.tasks.filter(t=>(filter==='all'||(filter==='enabled'?t.enabled:!t.enabled))&&(!query||(t.name+' '+t.prompt).toLowerCase().includes(query)))}
  function view(value){const runs=value==='runs';$('taskBatch').classList.toggle('hidden',runs);$('taskBatch').hidden=runs;$('taskOverview').classList.toggle('hidden',runs);$('taskHistory').classList.toggle('hidden',!runs);for(const [id,active] of [['taskViewTasks',!runs],['taskViewRuns',runs]]){$(id).setAttribute('aria-selected',String(active));$(id).tabIndex=active?0:-1}}
  function selection(){
    $('taskBatchBar').classList.toggle('hidden',!batch);$('taskSelectionCount').textContent='已选 '+selected.size+' 项';$('taskBatch').setAttribute('aria-pressed',String(batch))
    const shown=visibleTasks();$('taskSelectAll').checked=shown.length>0&&shown.every(t=>selected.has(t.id));$('taskSelectAll').indeterminate=shown.some(t=>selected.has(t.id))&&!$('taskSelectAll').checked
    for(const id of ['taskBatchEnable','taskBatchPause','taskBatchDelete'])$(id).disabled=batchBusy||selected.size===0
  }
  function render(){
    $('taskHost').textContent='执行机器：'+data.host+'。需要该机器的 Agent 服务保持运行；关闭或休眠期间不会执行。'
    for(const node of $('taskFilters').querySelectorAll('button')){const type=node.dataset.taskFilter,count=data.tasks.filter(t=>type==='all'||(type==='enabled'?t.enabled:!t.enabled)).length;node.textContent=({all:'全部',enabled:'已启用',paused:'已暂停'}[type])+' ('+count+')';node.setAttribute('aria-pressed',String(filter===type))}
    selected=new Set(Array.from(selected).filter(id=>data.tasks.some(t=>t.id===id)))
    const list=$('taskList');list.textContent=''
    for(const task of visibleTasks()){
      const card=el('article',undefined,'scheduled-task'+(selected.has(task.id)?' task-selected':'')),head=el('div',undefined,'task-card-heading')
      if(batch){const choose=el('input');choose.type='checkbox';choose.checked=selected.has(task.id);choose.setAttribute('aria-label','选择 '+task.name);choose.addEventListener('change',()=>{if(choose.checked)selected.add(task.id);else selected.delete(task.id);card.classList.toggle('task-selected',choose.checked);selection()});head.appendChild(choose)}
      const title=button(task.name,()=>edit(task));title.className='task-card-title'
      const toggle=button('',async()=>{
        if(toggling.has(task.id))return
        toggling.add(task.id);toggle.disabled=true;toggle.setAttribute('aria-busy','true')
        try{await request('save',{...task,enabled:!task.enabled});await refresh()}
        finally{toggling.delete(task.id);toggle.disabled=false;toggle.removeAttribute('aria-busy');render()}
      });toggle.className='plugin-switch task-switch'+(task.enabled?' on':'');toggle.disabled=toggling.has(task.id);toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(task.enabled));toggle.setAttribute('aria-label','启停 '+task.name)
      const knob=el('span',undefined,'plugin-switch-knob');knob.setAttribute('aria-hidden','true');toggle.appendChild(knob)
      head.append(title,toggle);card.append(head,el('p',task.prompt,'task-card-description'))
      /* 卡片压成两行：第一行名称 + 开关，第二行「频率 · 下次 · 上次结果 · ⋯」 */
      const footer=el('div',undefined,'task-card-footer')
      footer.append(el('span',describe(task.rule),'task-card-rule'))
      footer.append(el('span',task.enabled?'下次 '+whenText(task.nextAt,task.rule.timezone):'已暂停','task-card-next'))
      footer.append(el('span',task.lastRun?'上次 '+statuses[task.lastRun.status]:'尚未运行','task-card-result'));card.appendChild(footer)
      const bottom=el('div',undefined,'task-card-bottom');bottom.appendChild(el('span',task.lastRun?'上次：'+statuses[task.lastRun.status]:'尚未运行','task-card-result'))
      const more=el('details',undefined,'task-card-menu'),summary=el('summary','•••');summary.setAttribute('aria-label','管理 '+task.name);more.appendChild(summary)
      const actions=el('div',undefined,'task-card-menu-actions');actions.append(button('立即运行',async()=>{await request('run',{id:task.id});notice('任务已进入执行队列');await refresh()}),button('停止本次',async()=>{await request('stop',{id:task.id});await refresh()}),button('编辑',()=>edit(task)),button('运行记录',()=>{view('runs');renderRuns(task.id)}),button('删除',async()=>{if(await host.confirm('删除定时任务“'+task.name+'”？运行记录仍保留。')){await request('delete',{id:task.id});await refresh()}}));more.appendChild(actions);footer.appendChild(more);list.appendChild(card)
    }
    if(!list.children.length){const empty=el('div',undefined,'tasks-empty');empty.append(el('div','◷','tasks-empty-icon'),el('h3',data.tasks.length?'没有符合条件的任务':'让 Agent 按时为你工作'),el('p',data.tasks.length?'试试其他筛选条件或关键词':'创建一个定时任务，自动完成巡检、整理与信息汇总。'));if(!data.tasks.length)empty.appendChild(button('＋ 新建定时任务',()=>edit()));list.appendChild(empty)}
    selection();renderRuns($('taskRuns').dataset.taskId||'')
  }
  async function bulk(action){if(batchBusy)return;const ids=Array.from(selected);if(!ids.length)return;if(action==='delete'&&!await host.confirm('删除选中的 '+ids.length+' 个任务？运行记录仍保留。'))return
    batchBusy=true;let success=0;const failed=[]
    for(const id of ['taskBatchEnable','taskBatchPause','taskBatchDelete'])$(id).disabled=true
    try{for(const id of ids){const task=data.tasks.find(t=>t.id===id);try{await request(action==='delete'?'delete':'save',action==='delete'?{id}:{...task,enabled:action==='enable'});selected.delete(id);success++}catch(e){failed.push(task.name+'：'+e.message)}}await refresh();notice('已处理 '+success+' 项'+(failed.length?'；未完成：'+failed.join('；'):''))}finally{batchBusy=false;selection()}
  }
  function closeEditor(){if(saving)return;$('taskDialog').classList.add('hidden');$('taskEditor').classList.add('hidden');$('app').inert=false;document.body.classList.remove('task-dialog-open');if(priorFocus&&priorFocus.isConnected)priorFocus.focus();else $('taskNew').focus()}
  function validEditor(){$('taskCancel').disabled=saving;$('taskCloseEditor').disabled=saving;$('taskSave').disabled=saving||!$('taskName').value.trim()||!$('taskPrompt').value.trim()}
  /* 运行记录：紧凑列表行，整行可点开关联会话（用户 2026-10-17：「概要显示这种列表形式就好」）。
     不再是大卡片：一行里放状态点 / 任务名 / 时间 / 耗时 / 触发方式，右侧一个「打开」提示。 */
  function runDuration(run){
    if(!run.endedAt)return ''
    const ms=run.durationMs===undefined?run.endedAt-(run.startedAt||run.createdAt):run.durationMs
    const sec=Math.round(Math.max(0,ms)/1000)
    return sec<60?sec+' 秒':Math.round(sec/60)+' 分 '+sec%60+' 秒'
  }
  async function openRunConversation(run){
    if(not(run.sessionId))return
    try{const value=await request('conversation',{runId:run.id});markNoticeRead(run.id);await host.open(value)}catch(e){notice(e.message)}
  }
  function renderRuns(taskId){
    const box=$('taskRuns');box.dataset.taskId=taskId;box.textContent=''
    if(taskId)box.appendChild(button('显示全部记录',()=>renderRuns('')))
    const list=box.querySelector('.task-run-list')||el('div',undefined,'task-run-list');list.textContent=''
    const rows=data.runs.filter(r=>!taskId||r.taskId===taskId)
    if(!rows.length){box.appendChild(el('p','暂无运行记录','capability-empty'));return}
    box.appendChild(list)
    for(const run of rows.slice(0,100)){
      const row=el('div',undefined,'task-run-row run-'+run.status)
      row.setAttribute('role','button');row.tabIndex=0
      row.appendChild(el('span','','task-run-dot'))
      const main=el('span',undefined,'task-run-main')
      main.appendChild(el('strong',run.task.name))
      main.appendChild(el('span',(statuses[run.status]||run.status)+' · '+(TRIGGERS[run.trigger]||run.trigger)+' · '+date(run.createdAt),'muted'))
      if(run.summary)main.appendChild(el('span',String(run.summary).slice(0,80),'task-run-summary'))
      row.appendChild(main)
      const tail=el('span',undefined,'task-run-tail')
      tail.appendChild(el('span',runDuration(run),'muted'))
      tail.appendChild(el('span',run.sessionId?'打开会话':'无会话','task-run-open'))
      row.appendChild(tail)
      row.addEventListener('click',()=>openRunConversation(run).catch(()=>{}))
      row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openRunConversation(run).catch(()=>{})}})
      list.appendChild(row)
    }
  }
  /* 引擎只认「分钟」，界面让用户选分钟/小时/天，这里换算。
     读的时候反着来：优先挑能整除的最大单位，免得把 1440 分钟显示成「1440 分钟」。 */
  const UNITS=[[1440,'1440'],[60,'60'],[1,'1']]
  function syncUnitControlLater(){syncUnitControl()}
  function intervalParts(){for(const [factor,value] of UNITS)if(Number($('taskMinutes').value)%factor===0&&Number($('taskMinutes').value)>=factor)return {value:String(Number($('taskMinutes').value)/factor),unit:value}
    return {value:String($('taskMinutes').value||60),unit:'1'}}
  function setIntervalParts(minutes){const total=Number(minutes)||60
    syncUnitControlLater()
    for(const [factor,value] of UNITS)if(total%factor===0&&total>=factor){$('taskMinutes').value=String(total/factor);$('taskIntervalUnit').value=value;return}
    $('taskMinutes').value=String(total);$('taskIntervalUnit').value='1'}
  function rule(){return {kind:$('taskRule').value,time:$('taskTime').value,weekday:Number($('taskWeekday').value),minutes:Math.max(1,Math.round(Number($('taskMinutes').value)*Number($('taskIntervalUnit').value||1))),timezone:HOME_TZ}}
  /* 下次执行时间说人话：今天/明天/周几 + 时刻，别甩一整串带时区的时间戳。 */
  function whenText(ms,timezone){
    if(!ms)return'—'
    const tz=timezone||undefined
    const local=new Date(new Date(ms).toLocaleString('en-US',tz?{timeZone:tz}:undefined))
    const today=new Date(new Date().toLocaleString('en-US'))
    const dayDiff=Math.round((new Date(local.getFullYear(),local.getMonth(),local.getDate())-new Date(today.getFullYear(),today.getMonth(),today.getDate()))/86400000)
    const hm=String(local.getHours()).padStart(2,'0')+':'+String(local.getMinutes()).padStart(2,'0')
    if(dayDiff===0)return'今天 '+hm
    if(dayDiff===1)return'明天 '+hm
    if(dayDiff===2)return'后天 '+hm
    if(dayDiff>2&&dayDiff<7)return'周'+['日','一','二','三','四','五','六'][local.getDay()]+' '+hm
    return(local.getMonth()+1)+' 月 '+local.getDate()+' 日 '+hm
  }
  async function preview(){const seq=++previewSequence;try{const result=await window.dsh.taskRequest('preview',{rule:rule()});if(seq===previewSequence)$('taskNext').textContent='下次执行：'+whenText(result.nextAt,rule().timezone)}catch(e){if(seq===previewSequence)$('taskNext').textContent='时间设置有问题：'+e.message}}
  function ruleFields(){
    const kind=$('taskRule').value
    for(const node of $('taskEditor').querySelectorAll('.task-segment-item')){
      const on=node.dataset.taskKind===kind
      node.setAttribute('aria-checked',String(on))
      node.classList.toggle('is-on',on)
    }
    $('taskClockFields').hidden=kind==='interval'
    $('taskWeekdayLabel').hidden=kind!=='weekly'
    $('taskIntervalLabel').hidden=kind!=='interval'
    /* 时间框在「每隔」模式下是隐藏的，但 required 还在 —— 浏览器会静默拦下表单提交
       （找不到可聚焦的必填项），点保存没反应也没报错。跟着显示状态一起切。 */
    $('taskTime').required=kind!=='interval'
    syncWeekdayControl();syncUnitControl()
    preview()
  }
  function setRuleKind(kind){$('taskRule').value=kind;ruleFields()}
  function syncWeekdayControl(){
    const box=$('taskEditor').querySelector('[data-weekday-dropdown]')
    if(!box)return
    const value=Number($('taskWeekday').value)||0
    for(const item of box.querySelectorAll('[data-weekday-option]')){
      const on=Number(item.dataset.weekdayOption)===value
      item.classList.toggle('is-on',on);item.setAttribute('aria-checked',String(on))
    }
    const label=box.querySelector('[data-weekday-label]')
    if(label)label.textContent=WEEKDAYS[value]
  }
  function syncUnitControl(){
    for(const item of $('taskEditor').querySelectorAll('[data-task-unit]')){
      const on=String(item.dataset.taskUnit)===String($('taskIntervalUnit').value)
      item.classList.toggle('is-on',on);item.setAttribute('aria-checked',String(on))
    }
  }
  function edit(task){
    editing=task||null;const form=$('taskEditor');form.reset();$('taskEditorTitle').textContent=task?'编辑定时任务':'新建定时任务';priorFocus=document.activeElement;$('taskEditorError').textContent='';for(const detail of form.querySelectorAll('details'))detail.open=false
    /* 新建时默认「保存即启用」：多数人建定时任务就是要它跑起来，真要挂着不跑再取消勾选。
       编辑已有任务时按它原本的状态回填。 */
    /* 高级配置已内收：权限、工具白名单、命令/来源、限额全部用内置常量（BUILTIN），
       界面上不再摆这些控件（用户 2026-10-17：「收敛成内置的就行，不需要显示出来」）。
       只读三件套 = 只允许看和检索，改文件/跑命令一律不做。 */
    const defaults={name:'',prompt:'',projectId:'',rule:{kind:'daily',time:'09:00',weekday:1,minutes:60,timezone:HOME_TZ},enabled:true},t=task||defaults
    for(const [id,value] of Object.entries({taskName:t.name,taskPrompt:t.prompt,taskRule:t.rule.kind,taskTime:t.rule.time||'09:00',taskWeekday:t.rule.weekday===undefined?1:t.rule.weekday,taskMinutes:t.rule.minutes||60}))$(id).value=value
    setIntervalParts(t.rule.kind==='interval'?(t.rule.minutes||60):60)
    syncWeekdayControl()
    $('taskEnabled').checked=t.enabled
    form.classList.remove('hidden');$('taskDialog').classList.remove('hidden');$('app').inert=true;document.body.classList.add('task-dialog-open');ruleFields();validEditor();$('taskName').focus()
  }
  async function save(event){event.preventDefault();const submit=$('taskSave');saving=true;validEditor();submit.disabled=true;$('taskEditorError').textContent=''
    try{
      const raw={id:editing&&editing.id,name:$('taskName').value,prompt:$('taskPrompt').value,projectId:BUILTIN.projectId,permission:BUILTIN.permission,rule:rule(),enabled:$('taskEnabled').checked,catchUp:BUILTIN.catchUp,tools:BUILTIN.tools.slice(),commands:[],origins:[],timeoutMs:BUILTIN.timeoutMs,maxSteps:BUILTIN.maxSteps,tokenBudget:BUILTIN.tokenBudget,maxTokens:BUILTIN.maxTokens,maxRequests:BUILTIN.maxRequests,outputBytes:BUILTIN.outputBytes,failureLimit:BUILTIN.failureLimit}
      await request('save',raw);const on=raw.enabled;saving=false;closeEditor();notice('任务已保存'+(on?'并已启用，下次执行：'+whenText((await window.dsh.taskRequest('preview',{rule:raw.rule})).nextAt,raw.rule.timezone):'（当前是暂停状态）')+'；修改只影响后续运行。');await refresh();$('taskNew').focus()
    }finally{saving=false;validEditor()}
  }
  async function lifecycle(){if(!window.shell||!window.shell.taskPreferences)return;const prefs=await window.shell.taskPreferences();$('taskDesktopOptions').hidden=false;$('taskKeepRunning').checked=prefs.keepRunning;$('taskLaunchAtLogin').checked=prefs.launchAtLogin}
  window.scheduledTasks={refresh,pushNoticeForTest:pushNotice,onEvent(event){
    if(event.type==='tasks:notification'){
      const run=event.runId?(data.runs.filter(r=>r.id===event.runId)[0]||null):null
      /* 只有「这条会话当前没打开」才提示 —— 正在看着它就别再弹一次 */
      const open=run&&run.sessionId===window.currentSessionId&&window.currentSessionId
      notice('任务“'+event.title+'”：'+(statuses[event.status]||event.status))
      if(event.runId&&!open)pushNotice({runId:event.runId,title:event.title,status:event.status,at:Date.now(),read:false})
    }
    if(event.type==='tasks:error'){notice(event.message);if(window.shell&&window.shell.taskNotify)window.shell.taskNotify({title:'任务调度异常',status:'failed'}).catch(()=>{})}
    refresh().catch(()=>{})
  },init(callbacks){host=callbacks;if(initialized)return;initialized=true;window.scheduledTasks.ready=true
    document.body.appendChild($('taskDialog'))
    loadNotices();renderNotices()
    $('taskNoticeBell').addEventListener('click',event=>{event.stopPropagation();const box=$('taskNoticeList');const open=box.classList.contains('hidden');box.classList.toggle('hidden',!open);$('taskNoticeBell').setAttribute('aria-expanded',String(open))})
    $('taskNoticeClear').addEventListener('click',()=>{notices=notices.map(n=>({...n,read:true}));saveNotices();renderNotices()})
    document.addEventListener('click',event=>{if(!event.target.closest('.sidebar-footer-actions'))closeNotices()})
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closeNotices()})
    refresh().catch(()=>{})
    $('taskNew').addEventListener('click',()=>edit());$('taskEditor').addEventListener('submit',e=>save(e).catch(()=>{}));$('taskCancel').addEventListener('click',closeEditor);$('taskCloseEditor').addEventListener('click',closeEditor)
    for(const id of ['taskName','taskPrompt'])$(id).addEventListener('input',validEditor)
    $('taskDialog').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeEditor()}if(event.key==='Tab'){const controls=Array.from($('taskDialog').querySelectorAll('button,input,select,textarea,summary')).filter(n=>!n.disabled&&n.offsetParent!==null);const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}})
    $('taskEditor').addEventListener('invalid',event=>{for(let node=event.target.parentElement;node&&node!==$('taskEditor');node=node.parentElement)if(node.tagName==='DETAILS')node.open=true},true)
    $('taskDialog').addEventListener('click',event=>{if(event.target===$('taskDialog'))closeEditor()})
    $('taskViewTasks').addEventListener('click',()=>view('tasks'));$('taskViewRuns').addEventListener('click',()=>view('runs'))
    for(const id of ['taskViewTasks','taskViewRuns'])$(id).addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=id==='taskViewTasks'?'taskViewRuns':'taskViewTasks';$(target).click();$(target).focus()}})
    for(const node of $('taskFilters').querySelectorAll('button'))node.addEventListener('click',()=>{filter=node.dataset.taskFilter;render()})
    $('taskSearch').addEventListener('input',render)
    $('taskList').addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=event.target.closest('.task-card-menu');if(menu&&menu.open){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary').focus()}}})
    $('taskList').addEventListener('click',event=>{const current=event.target.closest('.task-card-menu');for(const menu of $('taskList').querySelectorAll('.task-card-menu[open]'))if(menu!==current)menu.open=false})
    $('taskBatch').addEventListener('click',()=>{batch=!batch;if(!batch)selected.clear();render()});$('taskBatchCancel').addEventListener('click',()=>{batch=false;selected.clear();render();$('taskBatch').focus()})
    $('taskSelectAll').addEventListener('change',()=>{for(const task of visibleTasks())if($('taskSelectAll').checked)selected.add(task.id);else selected.delete(task.id);render()})
    for(const [id,action] of [['taskBatchEnable','enable'],['taskBatchPause','pause'],['taskBatchDelete','delete']])$(id).addEventListener('click',()=>bulk(action).catch(()=>{}))
    /* 执行环境已搬进系统设置（模型下面），这里改成：打开设置面板时刷新那几项 */
    for(const id of ['taskTime','taskMinutes'])$(id).addEventListener('change',ruleFields)
    for(const node of $('taskEditor').querySelectorAll('.task-segment-item[data-task-kind]'))node.addEventListener('click',()=>setRuleKind(node.dataset.taskKind))
    for(const node of $('taskEditor').querySelectorAll('[data-task-unit]'))node.addEventListener('click',()=>{$('taskIntervalUnit').value=node.dataset.taskUnit;syncUnitControl();ruleFields()})
    const weekdayBox=$('taskEditor').querySelector('[data-weekday-dropdown]')
    if(weekdayBox){
      const trigger=weekdayBox.querySelector('.dropdown-trigger'),menu=weekdayBox.querySelector('.dropdown-menu')
      trigger.addEventListener('click',event=>{event.stopPropagation();const open=menu.classList.contains('hidden');menu.classList.toggle('hidden',!open);trigger.setAttribute('aria-expanded',String(open))})
      for(const item of weekdayBox.querySelectorAll('[data-weekday-option]'))item.addEventListener('click',event=>{event.stopPropagation();$('taskWeekday').value=item.dataset.weekdayOption;syncWeekdayControl();menu.classList.add('hidden');trigger.setAttribute('aria-expanded','false');ruleFields()})
    }
    syncUnitControlLater()
    $('capTabTasks').addEventListener('click',()=>{refresh().catch(()=>{})})
    /* 打开系统设置的「执行环境」页时刷新执行机器与两个桌面开关 */
    const envTab=document.querySelector('[data-settings-tab="environment"]')
    if(envTab)envTab.addEventListener('click',()=>{lifecycle().catch(e=>notice(e.message))})
    for(const id of ['taskKeepRunning','taskLaunchAtLogin'])$(id).addEventListener('change',async()=>{try{const prefs=await window.shell.taskPreferences({keepRunning:$('taskKeepRunning').checked,launchAtLogin:$('taskLaunchAtLogin').checked});$('taskKeepRunning').checked=prefs.keepRunning;$('taskLaunchAtLogin').checked=prefs.launchAtLogin;notice('桌面后台运行设置已更新')}catch(e){notice(e.message);lifecycle().catch(()=>{})}})
  }}
})()
