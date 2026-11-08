'use strict'

// Hidden, sandboxed Electron window loading the real chat renderer and an
// isolated service. Most events are synthetic; the last run uses the actual
// negotiated production Cordis plugin, Agent loop, SSE and durable repository.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, BrowserWindow } = require('electron')

async function run() {
  const url = process.argv[2]
  const captures = process.argv[3] || ''
  assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
  assert.strictEqual(process.versions.electron, '22.3.27')
  assert.strictEqual(process.versions.node, '16.17.1')
  assert(/^108\./.test(process.versions.chrome))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gui-chat-electron-'))
  app.setPath('userData', home); app.disableHardwareAcceleration()
  await app.whenReady(); app.on('window-all-closed', () => {})
  const blocked = [], errors = []
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const wc = win.webContents
  wc.on('console-message', (_event, level, message, line, source) => { if (level >= 3) errors.push(message + ' [' + source + ':' + line + ']') })
  wc.on('render-process-gone', (_event, details) => { errors.push('render-process-gone: ' + details.reason) })
  wc.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const allowed = details.url.startsWith(url)
    if (!allowed) blocked.push(details.url)
    callback({ cancel: !allowed })
  })
  const js = async expression => { try { return await wc.executeJavaScript(expression) } catch (error) { throw new Error('Renderer expression failed: ' + expression.slice(0, 400) + '; ' + JSON.stringify(errors) + '; ' + error.message) } }
  async function until(expression, label) {
    const deadline = Date.now() + 15000
    let result
    while (Date.now() < deadline) {
      result = await js(expression)
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(result) + '; browser errors: ' + JSON.stringify(errors))
  }
  try {
    await win.loadURL(url)
    await until('typeof createSession === "function" && !!state.settings && !!window.agentUI && !!window.dsh', 'real application initialization')
    // The existing LiteGraph vendor attempts Function() during startup and is
    // blocked by the unchanged CSP. Record it separately; new UI code must not
    // add console errors or CSP violations. This is not a workflow acceptance.
    const startupErrors = errors.slice()
    assert(startupErrors.every(item => item.includes('Refused to evaluate') && item.includes('/vendor/litegraph/litegraph.js:429')), JSON.stringify(startupErrors))
    await js(`(async () => {
      window.__csp = []; window.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective));
      window.__surface = (revision, title) => ({version:1,id:'sales',revision,title,root:'layout',state:{factor:1},components:[
        {id:'layout',type:'column',children:['description','chart','slider']},
        {id:'description',type:'text',text:'<img src="https://invalid.example/x" onerror="window.__bad=1">'},
        {id:'chart',type:'chart',chartType:'line',title:'收入',labels:['一月','二月'],series:[{id:'income',name:'收入',values:[2,4]}],multiplierKey:'factor'},
        {id:'slider',type:'slider',label:'调整倍数',stateKey:'factor',min:0,max:5,step:0.5}
      ],actions:[]});
      window.__block = (revision, title) => ({type:'ui',toolCallId:'call'+revision,surface:window.__surface(revision,title)});
      const a=createSession('','界面会话 A','recent'), b=createSession('','界面会话 B','recent');
      window.__a=a.id; window.__b=b.id;
      a.messages=[{role:'assistant',content:[{type:'text',text:'旧界面前'},window.__block(1,'旧图表'),{type:'text',text:'旧界面后'}]}];
      for(let i=0;i<45;i++) a.messages.push({role:'user',content:'历史消息 '+i});
      a.messages.push({role:'assistant',content:[{type:'text',text:'开头 **加粗**'},window.__block(2,'当前图表'),{type:'text',text:'结尾内容'}]});
      b.messages=[{role:'assistant',content:'另一个会话'}];
      await selectSession(a.id); await syncRunningState();
      if (state.runPoll) { clearInterval(state.runPoll); state.runPoll=null; }
      return true
    })()`)
    await until("!!document.querySelector('.gui-chat-slot .gui-plot canvas')", 'history UI rendered by real chat')
    const initial = await js(`(() => {
      const body=[...document.querySelectorAll('.bubble.assistant .bubble-body')].find(x=>x.querySelector('.gui-surface'));
      window.__chart=AgentUIVendor.echartsCore.getInstanceByDom(body.querySelector('.gui-plot'));
      return {parts:[...body.children].map(x=>x.className), text:body.textContent, title:body.querySelector('.gui-title').textContent,
        unsafeImages:body.querySelectorAll('.gui-text img').length, historyButton:!!document.querySelector('.history-more'),
        state:document.querySelector('.gui-slider input').value, cells:[...document.querySelectorAll('.gui-chart td')].map(x=>x.textContent), chart:!!window.__chart};
    })()`)
    assert.deepStrictEqual(initial.parts, ['gui-chat-text', 'gui-chat-slot', 'gui-chat-text'])
    assert(initial.text.includes('开头') && initial.text.includes('结尾内容'))
    assert.strictEqual(initial.title, '当前图表')
    assert.strictEqual(initial.unsafeImages, 0)
    assert(initial.historyButton && initial.chart)
    assert.deepStrictEqual(initial.cells, ['2', '4'])
    await js("document.querySelector('.gui-slider input').focus(); true")
    wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
    await until("document.querySelector('.gui-slider input').value === '1.5' && document.querySelector('.gui-chart td').textContent === '3'", 'keyboard interaction updates the chart table')
    await js('applyTheme("light"); true')
    await until("getComputedStyle(document.querySelector('.gui-surface')).backgroundColor === 'rgb(255, 255, 255)'", 'light theme in real chat')
    await js('applyTheme("dark"); true')
    await until("getComputedStyle(document.querySelector('.gui-surface')).backgroundColor === 'rgb(43, 43, 43)'", 'dark theme in real chat')
    await js('loadEarlierMessages(); true')
    await until('!historyJob && (historyStarts.get(window.__a) || 0) === 0', 'older history inserted')
    assert.strictEqual(await js("document.querySelectorAll('.gui-surface').length"), 1, 'superseded historical UI is not rendered')
    assert.strictEqual(await js("document.querySelector('.gui-slider input').value"), '1.5', 'history insertion retains current local view')
    await js(`(async()=>{ currentSession().messages=currentSession().messages.concat([{role:'user',content:'新一轮输入'}]);
      addRun(window.__a); state.liveRun=true; window.__savedMessages=JSON.stringify(currentSession().messages);
      await handleEvent({type:'ui:surface',sessionId:window.__b,toolCallId:'cross',surface:window.__surface(3,'错误会话')});
      await handleEvent({type:'ui:surface',toolCallId:'no-id',surface:window.__surface(3,'缺少会话')}); return true })()`)
    assert.strictEqual(await js("document.querySelectorAll('.gui-surface').length"), 1, 'cross-session and untagged notifications ignored')
    await js("handleEvent({type:'ui:surface',sessionId:window.__a,toolCallId:'live3',surface:window.__surface(3,'实时图表')})")
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent === '实时图表'", 'live revision after immutable message append')
    assert.strictEqual(await js('window.__chart.isDisposed()'), true, 'superseded chart disposed')
    assert.strictEqual(await js('JSON.stringify(currentSession().messages) === window.__savedMessages'), true, 'notification is not persisted as conversation truth')
    await js("handleEvent({type:'ui:surface',sessionId:window.__a,toolCallId:'stale',surface:window.__surface(1,'过期图表')})")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(await js("document.querySelector('.gui-title').textContent"), '实时图表', 'stale event cannot roll back the view')
    await js(`(async()=>{ const messages=JSON.parse(window.__savedMessages); messages.push({role:'assistant',content:[{type:'text',text:'已提交'},window.__block(4,'持久化图表')]});
      await handleEvent({type:'finished',sessionId:window.__a,messages,execution:{status:'completed'}}); return true })()`)
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent === '持久化图表'", 'finished snapshot reconciliation')
    assert.strictEqual(await js("document.querySelectorAll('.gui-surface').length"), 1, 'finished snapshot removes provisional duplicate')
    await until("!!document.querySelector('.gui-plot canvas') && !!AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector('.gui-plot'))", 'reconciled chart initialized')
    await js('window.__lastChart=AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector(".gui-plot")); selectSession(window.__b)')
    await until("state.currentSessionId === window.__b && document.querySelectorAll('.gui-surface').length === 0", 'switch to other session')
    assert.strictEqual(await js('window.__lastChart.isDisposed()'), true, 'session switch disposes chart')
    await js('selectSession(window.__a)')
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent === '持久化图表'", 'restore from authoritative history')
    await js(`(async()=>{addRun(window.__a); state.liveRun=true;
      await handleEvent({type:'ui:surface',sessionId:window.__a,toolCallId:'future',surface:{version:3,id:'sales',revision:5}});
      await handleEvent({type:'ui:surface',sessionId:window.__a,toolCallId:'old-again',surface:window.__surface(1,'错误回退')}); return true})()`)
    await until("!![...document.querySelectorAll('.gui-chat-slot')].find(x=>!x.hidden&&x.textContent.includes('暂不可用'))", 'future version fail-closed notice')
    assert.strictEqual(await js("document.querySelectorAll('.gui-surface').length"), 0, 'unknown future version blocks old revisions')
    // A normal send appends a user message with a new array identity. Existing
    // unrelated UI must remain mounted when another surface is published.
    await js(`(async()=>{const c=createSession('','独立界面','recent');window.__c=c.id;
      const block=window.__block(1,'保留图表');block.surface.id='inventory';c.messages=[{role:'assistant',content:[block]}];
      await selectSession(c.id);await syncRunningState();return true})()`)
    await until("!!document.querySelector('.gui-plot canvas')", 'unrelated surface initialized')
    await js("window.__keptChart=AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector('.gui-plot')); document.querySelector('.gui-slider input').focus(); true")
    wc.focus(); wc.sendInputEvent({ type:'keyDown', keyCode:'Right' }); wc.sendInputEvent({ type:'keyUp', keyCode:'Right' })
    await until("document.querySelector('.gui-slider input').value === '1.5'", 'unrelated surface interaction')
    await js(`(async()=>{currentSession().messages=currentSession().messages.concat([{role:'user',content:'下一轮'}]);addRun(window.__c);state.liveRun=true;
      await handleEvent({type:'ui:surface',sessionId:window.__c,toolCallId:'other',surface:window.__surface(1,'新图表')});return true})()`)
    await until("document.querySelectorAll('.gui-surface').length === 2", 'unrelated and new UI stay visible')
    assert.strictEqual(await js('window.__keptChart.isDisposed() === true'), false)
    assert.strictEqual(await js("document.querySelector('.gui-slider input').value"), '1.5', 'immutable append preserves unrelated presentation state')
    // Bounded notifications must fail closed rather than leave a stale chart.
    await js(`(()=>{for(let i=2;i<=257;i++)handleEvent({type:'ui:surface',sessionId:window.__c,toolCallId:'overflow'+i,surface:window.__surface(i,'版本'+i)});return true})()`)
    await until("!![...document.querySelectorAll('.gui-chat-slot')].find(x=>!x.hidden&&x.textContent.includes('任务结束后显示最终结果'))", 'notification overflow fail-closed notice')
    assert.strictEqual(await js("document.querySelectorAll('.gui-surface').length"), 0)
    assert.strictEqual(await js('window.__keptChart.isDisposed()'), true)
    // Force an early history-frame yield and then cancel while real Vue mounts
    // are still in a detached fragment. Every mount must be disposed.
    await js(`(async()=>{const d=createSession('','历史取消','recent');window.__d=d.id;
      d.messages=Array.from({length:80},(_,i)=>({role:'user',content:'消息 '+i}));
      for(let i=16;i<20;i++){const b=window.__block(1,'离屏 '+i);b.surface.id='cancel'+i;d.messages[i]={role:'assistant',content:[b]}}
      await selectSession(d.id);await syncRunningState();
      window.__originalUI=window.AgentGenerativeUI;window.__mounts=0;window.__disposed=0;window.__detached=true;
      window.AgentGenerativeUI={...window.__originalUI,mountSurface:(host,props)=>{window.__mounts++;window.__detached=window.__detached&&!host.isConnected;
        const instance=window.__originalUI.mountSurface(host,props);return {update:instance.update,dispose:()=>{window.__disposed++;instance.dispose()}}}};
      window.__originalRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>1;
      let tick=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>{tick+=100;return tick}});
      loadEarlierMessages();delete performance.now;return true})()`)
    await until('window.__mounts === 4 && !!historyJob', 'detached history Vue mounts')
    assert.strictEqual(await js('window.__detached'), true)
    await js('cancelHistoryFill(); window.requestAnimationFrame=window.__originalRaf; window.AgentGenerativeUI=window.__originalUI; true')
    assert.strictEqual(await js('window.__disposed'), 4, 'cancelling history disposes every detached Vue mount')
    assert.strictEqual(await js("document.querySelectorAll('.gui-surface').length"), 0)
    // A form in real mixed chat history is interactive without editing facts;
    // switching sessions restores the published defaults, not local edits.
    await js(`(async()=>{const f=createSession('','表单会话','recent');window.__f=f.id;
      const surface={version:1,id:'form',revision:1,title:'查询表单',root:'group',state:{note:'初始',include:false},components:[
        {id:'group',type:'form',label:'查询条件',children:['query','include']},
        {id:'query',type:'input',label:'关键词',stateKey:'note',maxLength:12},
        {id:'include',type:'checkbox',label:'包含归档',stateKey:'include'}],actions:[]};
      f.messages=[{role:'assistant',content:[{type:'text',text:'请输入条件'},{type:'ui',toolCallId:'form1',surface},{type:'text',text:'完成'}]}];
      window.__formSnapshot=JSON.stringify(f.messages);await selectSession(f.id);await syncRunningState();return true})()`)
    await until("!!document.querySelector('.gui-form input[type=text]') && !!document.querySelector('.gui-form input[type=checkbox]')", 'form in real chat history')
    await js("document.querySelector('.gui-form input[type=text]').focus(); document.querySelector('.gui-form input[type=text]').select(); true")
    wc.focus(); await wc.insertText('本地修改')
    await until("document.querySelector('.gui-form input[type=text]').value === '本地修改'", 'real chat form text entry')
    await js("document.querySelector('.gui-form input[type=checkbox]').focus(); true")
    wc.sendInputEvent({type:'keyDown',keyCode:'Space'}); wc.sendInputEvent({type:'keyUp',keyCode:'Space'})
    await until("document.querySelector('.gui-form input[type=checkbox]').checked", 'real chat checkbox')
    assert.strictEqual(await js('JSON.stringify(currentSession().messages) === window.__formSnapshot'), true, 'form changes do not mutate recorded messages')
    await js('selectSession(window.__b)')
    await until('state.currentSessionId === window.__b', 'leave form session')
    await js('selectSession(window.__f)')
    await until("document.querySelector('.gui-form input[type=text]') && document.querySelector('.gui-form input[type=text]').value === '初始'", 'form restored from published history')
    assert.strictEqual(await js("document.querySelector('.gui-form input[type=checkbox]').checked"), false, 'local checkbox is not falsely restored as durable state')
    // First send from the empty screen creates a session without selectSession.
    // Its first UI event must still be bound to that newly created session.
    await js(`(()=>{state.currentSessionId='';state.activeProjectId='';renderMessages(null);
      state.workspacePath='/tmp/isolated-ui-test';state.settings.currentProjectId='';
      state.settings.models=[{id:'synthetic',model:'synthetic',baseURL:'http://127.0.0.1:1/v1'}];state.settings.currentModelId='synthetic';
      window.__oldSend=window.dsh.send;window.dsh.send=()=>new Promise(resolve=>{window.__resolveSend=resolve});
      setInputContent('新会话第一条消息');sendMessage();return true})()`)
    await until('!!window.__resolveSend && !!state.currentSessionId && state.liveRun === true', 'first send creates session')
    // Simulate an older idle poll arriving after send() began. The existing
    // current-stream flag still lets the first UI notification through.
    await js(`(()=>{window.__firstSession=state.currentSessionId;removeRun(window.__firstSession);handleEvent({type:'ui:surface',sessionId:window.__firstSession,toolCallId:'first',surface:window.__surface(1,'首轮图表')});return true})()`)
    try {
      await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent === '首轮图表'", 'first-session UI notification')
    } catch (error) {
      const debug = await js("({current:state.currentSessionId,first:window.__firstSession,running:currentRunning(),live:generativeUiChat.hasLive(),slots:[...document.querySelectorAll('.gui-chat-slot')].map(x=>({hidden:x.hidden,text:x.textContent.slice(0,100)}))})")
      throw new Error(error.message + '; isolated state: ' + JSON.stringify(debug))
    }
    await js(`(async()=>{const messages=currentSession().messages.concat([{role:'assistant',content:[window.__block(1,'首轮图表')]}]);
      await handleEvent({type:'finished',sessionId:window.__firstSession,messages,execution:{status:'completed'}});window.__resolveSend(true);window.dsh.send=window.__oldSend;return true})()`)
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent === '首轮图表'", 'first-session authoritative snapshot')
    await until('!state.liveRun && !currentRunning()', 'finished stream clears active state')
    await js("handleEvent({type:'ui:surface',sessionId:window.__firstSession,toolCallId:'late',surface:window.__surface(2,'迟到的界面')})")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(await js("document.querySelector('.gui-title').textContent"), '首轮图表', 'late notifications after completion are ignored')
    await js(`(async()=>{const old=window.dsh.send;window.dsh.send=()=>Promise.reject(new Error('synthetic send failure'));
      setInputContent('模拟发送失败');await sendMessage();window.dsh.send=old;return true})()`)
    assert.strictEqual(await js('!state.liveRun && !currentRunning()'), true, 'a failed send clears the current stream flag')
    await js("handleEvent({type:'ui:surface',sessionId:window.__firstSession,toolCallId:'after-error',surface:window.__surface(2,'失败后界面')})")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(await js("document.querySelector('.gui-title').textContent"), '首轮图表', 'late notifications after a failed send are ignored')
    // The preceding checks injected notifications. This final run uses the
    // actual Agent loop, negotiated production Cordis plugin, permissions, service SSE and journal.
    await js(`(async()=>{state.currentSessionId='';state.activeProjectId='';renderMessages(null);await syncRunningState();
      window.__realEvents=[];window.dsh.onEvent(e=>window.__realEvents.push(e));
      setInputContent('生成一张本地测试图表');sendMessage();return true})()`)
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent === '真实工具图表'", 'real Cordis tool produces live chart')
    await until("!!document.querySelector('.gui-plot canvas')", 'real tool chart canvas')
    assert.strictEqual(await js("window.__realEvents.some(e=>e.type==='ui:surface' && e.sessionId===state.currentSessionId)"), true)
    await until("window.__realEvents.some(e=>e.type==='tool:result' && e.name==='render_ui' && e.outcome==='success')", 'real tool result and permission check')
    await until("(async()=>{const r=await window.fetch('/__test/committed?session='+encodeURIComponent(state.currentSessionId));return r.ok})()", 'UI fact persisted before model finishes')
    await js("document.querySelector('.gui-slider input').focus(); true")
    wc.focus(); wc.sendInputEvent({ type:'keyDown', keyCode:'Right' }); wc.sendInputEvent({ type:'keyUp', keyCode:'Right' })
    await until("document.querySelector('.gui-chart td').textContent === '3'", 'real tool chart interaction before finish')
    await js("document.querySelector('.gui-form input[type=text]').focus(); document.querySelector('.gui-form input[type=text]').select(); true")
    wc.focus(); await wc.insertText('真实已保存')
    await js("document.querySelector('.gui-form input[type=checkbox]').focus(); true")
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await until("(async()=>{const s=await window.dsh.generativeUiRead({version:1,sessionId:state.currentSessionId});return s.surfaces.actual.state.factor===1.5 && s.surfaces.actual.state.note==='真实已保存' && s.surfaces.actual.state.archived===true})()", 'real inputs committed through HTTP and the session journal')
    await until("!!document.querySelector('.gui-visual iframe[data-loaded=true]')", 'sandboxed static visual in production chat')
    assert.strictEqual(await js("document.querySelector('.gui-visual iframe').getAttribute('sandbox')"), '')
    await until("!!document.querySelector('.gui-map[data-map-backend=cesium] canvas')", 'real lazy offline map in production chat')
    assert.strictEqual(await js("document.querySelector('.gui-progress progress').value"), 25)
    await js("(()=>{const s=document.querySelector('.gui-filter select');s.value='华东';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
    await until("document.querySelectorAll('.gui-table tbody tr').length===2", 'business filter updates immediately in real chat')
    await js("document.querySelector('.gui-table tbody button').click();document.querySelectorAll('.gui-flow-nodes button')[1].click();document.querySelectorAll('.gui-map-location')[1].click();true")
    await until("(async()=>{const s=await window.dsh.generativeUiRead({version:1,sessionId:state.currentSessionId});const v=s.surfaces.actual.state;return v.region==='华东'&&v.row==='shanghai'&&v.node==='review'&&v.point==='beijing'})()", 'business choices committed through the production service')
    if (captures) {
      await js("applyTheme('light'); document.querySelector('.gui-chart-table').open=true; scrollToBottom(); true")
      await new Promise(resolve => setTimeout(resolve, 200))
      const light = await wc.capturePage(); assert(!light.isEmpty())
      fs.writeFileSync(path.join(captures, 'chat-light.png'), light.toPNG(), { flag: 'wx' })
      await js("applyTheme('dark'); true")
      await new Promise(resolve => setTimeout(resolve, 200))
      const dark = await wc.capturePage(); assert(!dark.isEmpty())
      fs.writeFileSync(path.join(captures, 'chat-dark.png'), dark.toPNG(), { flag: 'wx' })
    }
    assert.strictEqual(await js("(async()=>{const r=await window.fetch('/__test/release',{method:'POST'});return r.ok})()"), true)
    await until("window.__realEvents.some(e=>e.type==='finished' && e.sessionId===state.currentSessionId) && !currentRunning()", 'real Agent finished')
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent === '真实工具图表'", 'real UI restored from committed snapshot')
    assert.strictEqual(await js("currentSession().messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='ui'&&p.surface.id==='actual'))"), true)
    assert.strictEqual(await js("window.__realEvents.some(e=>e.type==='tool:result'&&e.name==='render_ui'&&JSON.parse(e.result).rendered===false)"), true, 'durable publication does not falsely claim rendering')
    await until("document.querySelector('.gui-slider input').value === '1.5' && document.querySelector('.gui-form input[type=text]').value === '真实已保存' && document.querySelector('.gui-form input[type=checkbox]').checked", 'finished snapshot preserves actual edits')
    await until("document.querySelector('.gui-action-button') && !document.querySelector('.gui-action-button').disabled", 'validated P2 action becomes available')
    const actualSession = await js('state.currentSessionId')
    await js('selectSession(window.__b)')
    await until('state.currentSessionId === window.__b', 'leave persistent UI session')
    await js('selectSession(' + JSON.stringify(actualSession) + ')')
    await until("document.querySelector('.gui-slider input') && document.querySelector('.gui-slider input').value==='1.5' && document.querySelector('.gui-form input[type=text]').value==='真实已保存' && document.querySelector('.gui-form input[type=checkbox]').checked", 'session switch restores saved state rather than defaults')
    await until("document.querySelector('.gui-filter select').value==='华东' && document.querySelector('.gui-table tbody button[aria-pressed=true]') && document.querySelector('.gui-flow-nodes button[aria-pressed=true]') && !!document.querySelector('.gui-map-location[aria-pressed=true]')", 'business selections recover after session switch')
    await until("!document.querySelector('.gui-action-button').disabled", 'restored action ready')
    await js("document.querySelector('.gui-action-button').focus(); true")
    wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await until("!document.querySelector('#confirmModal').classList.contains('hidden')", 'application confirmation for Agent feedback')
    assert.strictEqual(await js('document.activeElement.id'), 'confirmCancel', 'confirmation starts on cancel')
    await js("document.querySelector('.gui-action-button').click(); true")
    assert.strictEqual(await js('confirmBacklog.length'), 0, 'double clicks do not queue a second confirmation')
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await until("document.querySelector('#confirmModal').classList.contains('hidden') && !document.querySelector('.gui-action-button').disabled", 'cancelled action restores the button')
    assert.strictEqual(await js("(async()=>{const r=await window.fetch('/__test/model');return (await r.json()).count})()"), 2, 'cancellation does not call the model')
    await js("document.querySelector('.gui-action-button').click(); true")
    await until("!document.querySelector('#confirmModal').classList.contains('hidden')", 'second explicit confirmation')
    await js("document.querySelector('#confirmOk').click(); true")
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent==='回传后的图表'", 'confirmed action streams an update_ui revision through Cordis')
    await until("document.querySelector('.gui-action-button').disabled && currentRunning()", 'loading action cannot be resubmitted')
    const modelState = await js("(async()=>{const r=await window.fetch('/__test/model');return r.json()})()")
    assert.strictEqual(modelState.count, 4)
    assert(modelState.prompts[2].includes('\"factor\":1.5') && modelState.prompts[2].includes('真实已保存'), 'Agent receives persisted selected parameters')
    assert(!modelState.prompts[2].includes('\"archived\"') && !modelState.internalUi, 'unselected keys and internal UI blocks do not reach the provider')
    assert.strictEqual(await js("(async()=>{const r=await window.fetch('/__test/release',{method:'POST'});return r.ok})()"), true)
    await until("!currentRunning() && !document.querySelector('.gui-action-button').disabled", 'feedback action completes')
    assert.strictEqual(await js("currentSession().messages.filter(m=>Array.isArray(m.content)).flatMap(m=>m.content).filter(p=>p.type==='ui'&&p.surface.id==='actual').map(p=>p.surface.revision).join(',')"), '1,2')
    if (captures) {
      for (const theme of ['light', 'dark']) {
        await js("applyTheme('" + theme + "'); document.querySelector('.gui-chart-table').open=true; scrollToBottom(); true")
        await new Promise(resolve => setTimeout(resolve, 150))
        const colors = await js(`(()=>{const b=document.querySelector('.gui-action-button'),t=b.querySelector('.n-button__content')||b;return {disabled:b.disabled,color:getComputedStyle(t).color,background:getComputedStyle(document.querySelector('.gui-surface')).backgroundColor}})()`)
        function luminance(color) { return color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0) }
        const a=luminance(colors.color),b=luminance(colors.background)
        assert(!colors.disabled && (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5, theme+': enabled action text must remain legible')
        const image = await wc.capturePage(); assert(!image.isEmpty())
        fs.writeFileSync(path.join(captures, 'chat-p2-result-' + theme + '.png'), image.toPNG(), { flag: 'wx' })
      }
    }
    await js("document.querySelector('.gui-action-button').click(); true")
    await until("!document.querySelector('#confirmModal').classList.contains('hidden')", 'confirm cancellable action')
    await js("document.querySelector('#confirmOk').click(); true")
    await until("(async()=>{const r=await window.fetch('/__test/model');return (await r.json()).count===5})()", 'second action reaches model')
    await until('currentRunning() && !document.querySelector("#stop").classList.contains("hidden")', 'existing stop control handles UI action')
    await js("document.querySelector('#stop').click(); true")
    await until("(async()=>{const s=await window.dsh.generativeUiRead({version:1,sessionId:state.currentSessionId});return !s.running && s.receipts.some(x=>x.status==='cancelled')})()", 'cancelled receipt persisted')
    assert.deepStrictEqual(await js('window.__csp'), [], 'P2 interaction introduces no CSP violations')
    await js('flushUiStorePush()')
    const reloaded = new Promise(resolve => wc.once('dom-ready', resolve))
    wc.reload(); await reloaded
    await js("window.__csp=[];window.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.effectiveDirective));true")
    await until('!!state.settings && state.currentSessionId===' + JSON.stringify(actualSession), 'reload returns to persistent conversation')
    await until("document.querySelector('.gui-title') && document.querySelector('.gui-title').textContent==='回传后的图表' && document.querySelector('.gui-slider input').value==='2'", 'page reload restores latest schema and interaction state')
    assert.strictEqual(await js("(async()=>{const r=await window.fetch('/__test/model');return (await r.json()).count})()"), 5, 'reload does not replay the cancelled action')
    assert.strictEqual(await js('window.__bad || 0'), 0)
    assert.strictEqual(await js('typeof require'), 'undefined')
    assert.deepStrictEqual(await js('window.__csp'), [])
    assert.deepStrictEqual(blocked, [])
    assert.deepStrictEqual(errors, startupErrors.concat(startupErrors), 'UI integration must not add browser console errors')
    if (startupErrors.length) console.log('Existing LiteGraph vendor Function() was blocked by the unchanged CSP during app startup; workflow behavior was not tested here.')
    console.log('Generative UI real chat: mixed Markdown order, history paging, keyboard chart/form, themes, live session isolation, revision barriers, overflow, cancelled history, first-session and stale-poll routing, finished reconciliation, chart/map disposal, v2 business choices and negotiated production Cordis tool-to-persisted-chat, durable inputs/session/page recovery, unified confirmation/cancellation, selected-state Agent feedback, streamed update_ui and no action replay passed (isolated normal-profile service).')
  } finally {
    if (!win.isDestroyed()) win.destroy()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
run().then(() => app.exit(0)).catch(error => { console.error(error.stack || error); app.exit(1) })
