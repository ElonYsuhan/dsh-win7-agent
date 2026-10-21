'use strict'
/* Chromium108 真实窗口验收：编辑图与执行图的滚轮缩放、鼠标锚点、视图保持，
   以及选择/连线/框选/双轴分割移动和保存恢复。
   只在临时 AGENT_HOME 与随机端口上运行，不触碰常驻实例。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawn } = require('child_process')
const { BrowserDriver } = require('../src/main/agent/browser-driver')

const root = path.resolve(__dirname, '..')
const OUT = path.join(root, 'release', 'validation')
function shot(name, buffer) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), buffer) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(fn, label, tries = 250) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return } catch (_) {}
    await sleep(60)
  }
  throw Error('Timeout ' + label)
}
function req(method, url, data) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: { 'content-type': 'application/json' } }, response => {
      let text = ''
      response.on('data', chunk => (text += chunk))
      response.on('end', () => {
        try {
          const value = JSON.parse(text)
          if (response.statusCode >= 400) reject(Error(value.error))
          else resolve(value)
        } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.end(data ? JSON.stringify(data) : undefined)
  })
}

const graph = {
  name: '画布交互验收',
  version: 2,
  editor: 'canvas',
  nodes: [
    { id: 's', type: 'start', text: '原始需求' },
    { id: 'h', type: 'human', title: '登记需求', text: '登记需求要点后继续。', interaction: { version: 1, type: 'handle', returnTo: 'previous-human' } },
    { id: 'a', type: 'human', title: '审批方案', text: '确认方案是否可以执行。', inputSchema:{type:'object',properties:Object.fromEntries(Array.from({length:14},(_,i)=>['check_'+i,{type:'string',title:'审阅依据 '+(i+1),maxLength:2000}]))}, interaction: { version: 1, type: 'approve', returnTo: 'previous-human' } },
    { id: 'e', type: 'end', title: '结果' }
  ],
  edges: [{ from: 's', to: 'h' }, { from: 'h', to: 'a' }, { from: 'a', to: 'e' }]
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-interaction-ui-'))
  const driver = new BrowserDriver()
  let child
  let logs = ''
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ workspacePath: dir, baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'mock' }))
    const probe = http.createServer()
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    const base = 'http://127.0.0.1:' + port
    child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, AGENT_HOME: dir, HOST: '127.0.0.1', PORT: String(port), PORT_MAX_ATTEMPTS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => (logs += chunk))
    child.stderr.on('data', chunk => (logs += chunk))
    await wait(async () => (await req('GET', base + '/api/health')).ok, 'server')

    const binary = path.join(root, 'node_modules/electron/dist', fs.readFileSync(path.join(root, 'node_modules/electron/path.txt'), 'utf8').trim())
    await driver.launch(base + '/', { electronPath: binary, width: 1280, height: 900, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    await wait(() => driver.evaluate('!!window.workflowUI'), 'renderer')
    const flow = await req('POST', base + '/api/workflows/save', graph)

    await driver.cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false})
    // Use actual Chromium pointer events: no synthetic move function calls.
    await driver.evaluate('workflowUI.openDraft(' + JSON.stringify(flow.id) + ')', { awaitPromise: true })
    await wait(() => driver.evaluate('!!document.getElementById("workflowCanvas").data&&document.getElementById("workflowCanvas").data.graph._nodes.length===4'), 'canvas')
    await sleep(100)
    await driver.evaluate(`(()=>{const toggle=document.getElementById('workflowStepsToggle');if(toggle&&toggle.textContent.includes('画布'))toggle.click();const c=document.getElementById('workflowCanvas').data;for(const [id,pos]of Object.entries({s:[150,110],h:[510,110],a:[150,360],e:[510,360]}))c.graph._nodes.find(n=>n.properties.workflowId===id).pos=pos;c.ds.scale=.65;c.ds.offset[0]=0;c.ds.offset[1]=0;c.setDirty(true,true);return true})()`)
    assert.deepStrictEqual(await driver.evaluate(`Array.from(document.querySelectorAll('#workflowCanvasTools [data-canvas-action]')).map(b=>b.dataset.canvasAction)`), ['select','connect','box','split'])
    const point=async(x,y)=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,r=c.canvas.getBoundingClientRect();return{x:r.left+(${x}+c.ds.offset[0])*c.ds.scale,y:r.top+(${y}+c.ds.offset[1])*c.ds.scale}})()`)
    const mouse=async(type,p,buttons=0,modifiers=0)=>driver.cdp.send('Input.dispatchMouseEvent',{type,button:'left',buttons,clickCount:1,modifiers,...p})
    const drag=async(from,to)=>{await mouse('mousePressed',from,1);await mouse('mouseMoved',to,1);await mouse('mouseReleased',to)}
    const positions=()=>driver.evaluate(`Object.fromEntries(document.getElementById('workflowCanvas').data.graph._nodes.map(n=>[n.properties.workflowId,Array.from(n.pos)]))`)
    const links=await driver.evaluate(`JSON.stringify(document.getElementById('workflowCanvas').data.graph.serialize().links)`)
    const wheel=async(p,deltaY)=>driver.cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:0,deltaY})
    const editorView=async p=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,r=c.canvas.getBoundingClientRect();return {scale:c.ds.scale,x:(${p.x}-r.left)/c.ds.scale-c.ds.offset[0],y:(${p.y}-r.top)/c.ds.scale-c.ds.offset[1]}})()`)
    async function editorWheelBothDirections(p,label){
      const before=await editorView(p)
      await wheel(p,-120);await wait(async()=>(await editorView(p)).scale>before.scale,label+' zoom in')
      const larger=await editorView(p);assert(Math.abs(larger.x-before.x)*larger.scale<2&&Math.abs(larger.y-before.y)*larger.scale<2,label+' zoom-in graph anchor')
      await wheel(p,120);await wait(async()=>(await editorView(p)).scale<larger.scale,label+' zoom out')
      const restored=await editorView(p);assert(Math.abs(restored.scale-before.scale)<.001,label+' bidirectional scale');assert(Math.abs(restored.x-before.x)*restored.scale<2&&Math.abs(restored.y-before.y)*restored.scale<2,label+' zoom-out graph anchor')
    }
    // Scrolling must work before the canvas has received a click or keyboard focus.
    await editorWheelBothDirections(await point(480,260),'editor before first click')
    for(const mode of ['select','connect','box','split']){
      await driver.click('[data-canvas-action='+mode+']')
      await editorWheelBothDirections(await point(480,260),'editor '+mode+' mode')
    }
    await driver.click('[data-canvas-action=select]')
    // Box-select the top pair and then move the complete selected group.
    await driver.click('[data-canvas-action=box]')
    await drag(await point(135,65),await point(805,185))
    assert.strictEqual(await driver.evaluate(`Object.keys(document.getElementById('workflowCanvas').data.selected_nodes).length`),2,'Marquee selects both top cards')
    assert.strictEqual(await driver.evaluate(`document.querySelector('[data-canvas-action=select]').getAttribute('aria-pressed')`),'true','Box selection returns to move mode')
    let before=await positions()
    await drag(await point(240,90),await point(280,120))
    let after=await positions()
    for(const id of ['s','h']){assert(Math.abs(after[id][0]-before[id][0]-40)<3,'Group moves horizontally: '+id);assert(Math.abs(after[id][1]-before[id][1]-30)<3,'Group moves vertically: '+id)}
    assert.deepStrictEqual(after.a,before.a,'Unselected cards remain in place')
    // Blank click clears the group, Shift-click toggles individual membership.
    let blank=await point(480,265);await mouse('mousePressed',blank,1);await mouse('mouseReleased',blank)
    assert.strictEqual(await driver.evaluate(`Object.keys(document.getElementById('workflowCanvas').data.selected_nodes).length`),0)
    const titlePoint=async id=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(n=>n.properties.workflowId===${JSON.stringify(id)}),r=c.canvas.getBoundingClientRect();return{x:r.left+(n.pos[0]+90+c.ds.offset[0])*c.ds.scale,y:r.top+(n.pos[1]-12+c.ds.offset[1])*c.ds.scale}})()`)
    for(const id of ['s','h']){const p=await titlePoint(id);await mouse('mousePressed',p,1,id==='h'?8:0);await mouse('mouseReleased',p,0,id==='h'?8:0)}
    assert.strictEqual(await driver.evaluate(`Object.keys(document.getElementById('workflowCanvas').data.selected_nodes).length`),2,'Shift-click adds to the group')
    const p=await titlePoint('h');await mouse('mousePressed',p,1,8);await mouse('mouseReleased',p,0,8)
    assert.strictEqual(await driver.evaluate(`Object.keys(document.getElementById('workflowCanvas').data.selected_nodes).length`),1,'Shift-click removes from the group')
    // Vertical divider moves all left/right nodes by equal and opposite distances.
    await driver.click('[data-canvas-action=split]')
    before=await positions();await drag(await point(480,260),await point(560,260));after=await positions()
    for(const id of ['s','a'])assert(Math.abs(after[id][0]-before[id][0]+40)<2,'Left side moves together: '+id)
    for(const id of ['h','e'])assert(Math.abs(after[id][0]-before[id][0]-40)<2,'Right side moves together: '+id)
    // Horizontal divider moves all upper/lower nodes, no edge changes.
    await driver.click('#workflowSplitAxis');assert.strictEqual(await driver.evaluate(`document.getElementById('workflowSplitAxis').textContent`),'上下')
    before=await positions();await drag(await point(480,260),await point(480,320));after=await positions()
    for(const id of ['s','h'])assert(Math.abs(after[id][1]-before[id][1]+30)<2,'Upper side moves together: '+id)
    for(const id of ['a','e'])assert(Math.abs(after[id][1]-before[id][1]-30)<2,'Lower side moves together: '+id)
    assert.strictEqual(await driver.evaluate(`JSON.stringify(document.getElementById('workflowCanvas').data.graph.serialize().links)`),links,'Split movement preserves every edge')
    // Escape rolls back a split operation without changing saved coordinates.
    before=await positions();await mouse('mousePressed',await point(480,260),1);await mouse('mouseMoved',await point(480,330),1)
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await mouse('mouseReleased',await point(480,330))
    assert.deepStrictEqual(await positions(),before,'Escape restores the whole split group')
    // Native wheel keeps its graph anchor underneath the pointer.
    const anchor=await point(480,260),scale=await driver.evaluate(`document.getElementById('workflowCanvas').data.ds.scale`)
    await driver.cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:anchor.x,y:anchor.y,deltaX:0,deltaY:-120})
    await wait(()=>driver.evaluate(`document.getElementById('workflowCanvas').data.ds.scale!==${scale}`),'wheel zoom')
    const anchored=await point(480,260);assert(Math.abs(anchored.x-anchor.x)<2&&Math.abs(anchored.y-anchor.y)<2,'Wheel zoom stays centered at the cursor')
    // Right-click reset plus keyboard dismissal/focus restoration.
    const menuPoint=await point(480,260);await driver.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...menuPoint});await driver.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...menuPoint})
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-canvas-menu button')`),'canvas menu')
    await driver.click('.workflow-canvas-menu button');assert.strictEqual(await driver.evaluate(`document.getElementById('workflowCanvas').data.ds.scale`),1)
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'F10',code:'F10',modifiers:8,windowsVirtualKeyCode:121})
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-canvas-menu')`),'keyboard menu')
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    assert(await driver.evaluate(`!document.querySelector('.workflow-canvas-menu')&&document.activeElement.id==='workflowCanvas'`),'Menu returns focus to canvas')
    // Reconnect through actual port dragging in connect mode.
    await driver.click('[data-canvas-action=connect]')
    const ports=await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,a=c.graph._nodes.find(n=>n.properties.workflowId==='s'),b=c.graph._nodes.find(n=>n.properties.workflowId==='h'),r=c.canvas.getBoundingClientRect();b.disconnectInput(0);c.ds.scale=.65;c.ds.offset[0]=0;c.ds.offset[1]=0;c.setDirty(true,true);const p=v=>({x:r.left+(v[0]+c.ds.offset[0])*c.ds.scale,y:r.top+(v[1]+c.ds.offset[1])*c.ds.scale});return{a:p(a.getConnectionPos(false,0)),b:p(b.getConnectionPos(true,0))}})()`)
    await sleep(100);await drag(ports.a,ports.b)
    assert(await driver.evaluate(`document.getElementById('workflowCanvas').data.graph._nodes.find(n=>n.properties.workflowId==='h').inputs[0].link!==null`),'Connect mode links actual ports')
    before=await positions()
    for(const theme of ['light','dark']){await driver.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await sleep(80);shot('workflow-canvas-'+theme+'.png',Buffer.from(await driver.screenshot(),'base64'))}
    await driver.click('#workflowSave');await wait(()=>driver.evaluate(`!document.getElementById('workflowCards').classList.contains('hidden')`),'saved')
    const saved=(await req('GET',base+'/api/workflows')).workflows.find(w=>w.id===flow.id)
    for(const n of saved.nodes)assert.deepStrictEqual(n.pos,before[n.id],'Position persisted for '+n.id)
    await driver.evaluate('workflowUI.openDraft(' + JSON.stringify(flow.id) + ')', { awaitPromise: true })
    await wait(()=>driver.evaluate(`document.getElementById('workflowCanvas').data.graph._nodes.length===4`),'reopened')
    assert.deepStrictEqual(await positions(),before,'Group/split positions survive reopening')
    await sleep(100)
    const reopenedPoint=await driver.evaluate(`(()=>{const r=document.getElementById('workflowCanvas').getBoundingClientRect();return{x:r.left+r.width*.7,y:r.top+r.height*.6}})()`)
    await editorWheelBothDirections(reopenedPoint,'editor reopened without canvas click')
    // Execution uses DOM nodes rather than LiteGraph: verify the actual displayed diagram too.
    const run=await req('POST',base+'/api/workflows/run',{id:flow.id})
    await wait(async()=>(await req('POST',base+'/api/workflows/detail',{id:run.id})).status==='waiting','execution waiting')
    await driver.evaluate('workflowUI.openReference('+JSON.stringify({runId:run.id,workflowId:flow.id,nodeId:'h'})+')',{awaitPromise:true})
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-map-scroll')`),'execution diagram')
    await sleep(100)
    const mapPoint=async onNode=>driver.evaluate(`(()=>{const viewport=document.querySelector('.workflow-map-scroll'),bounds=viewport.getBoundingClientRect();if(${onNode}){const visible=Array.from(viewport.querySelectorAll('.workflow-map-node')).map(card=>card.getBoundingClientRect()).find(r=>r.top>=bounds.top+4&&r.bottom<=bounds.bottom-4&&r.left>=bounds.left+4&&r.right<=bounds.right-4);if(visible)return{x:visible.left+visible.width/2,y:visible.top+visible.height/2}}for(const dx of [12,28,bounds.width-12])for(const dy of [18,bounds.height/2,bounds.height-18]){const x=bounds.left+dx,y=bounds.top+dy,hit=document.elementFromPoint(x,y);if(hit&&hit.closest('.workflow-map-scroll')===viewport&&!hit.closest('.workflow-map-node'))return{x,y}}throw Error('No execution map target')})()`)
    const executionView=async p=>driver.evaluate(`(()=>{const stage=document.querySelector('.workflow-map-stage'),r=stage.getBoundingClientRect(),scale=new DOMMatrix(getComputedStyle(stage).transform).a;return{scale,x:(${p.x}-r.left)/scale,y:(${p.y}-r.top)/scale,width:document.querySelector('.workflow-map-node').getBoundingClientRect().width}})()`)
    async function executionWheelBothDirections(p,label){
      const before=await executionView(p)
      await wheel(p,-120);await wait(async()=>(await executionView(p)).scale>before.scale,label+' zoom in',35)
      const larger=await executionView(p);assert(larger.width>before.width+1,label+' visibly enlarges cards');assert(Math.abs(larger.x-before.x)*larger.scale<2&&Math.abs(larger.y-before.y)*larger.scale<2,label+' zoom-in graph anchor')
      await wheel(p,120);await wait(async()=>(await executionView(p)).scale<larger.scale,label+' zoom out',35)
      const restored=await executionView(p);assert(Math.abs(restored.scale-before.scale)<.001,label+' restores scale');assert(Math.abs(restored.x-before.x)*restored.scale<2&&Math.abs(restored.y-before.y)*restored.scale<2,label+' zoom-out graph anchor')
    }
    await executionWheelBothDirections(await mapPoint(false),'execution blank background')
    await executionWheelBothDirections(await mapPoint(true),'execution node card')
    const rememberedPoint=await mapPoint(false);await wheel(rememberedPoint,-120)
    await wait(async()=>(await executionView(rememberedPoint)).scale>1,'execution remembered zoom')
    const rememberedScale=(await executionView(rememberedPoint)).scale
    await driver.evaluate(`window.__oldWorkflowStage=document.querySelector('.workflow-map-stage');true`)
    const currentCard=await driver.evaluate(`(()=>{const viewport=document.querySelector('.workflow-map-scroll'),v=viewport.getBoundingClientRect(),cards=Array.from(viewport.querySelectorAll('.workflow-map-node'));const card=cards.find(c=>{const r=c.getBoundingClientRect();return r.top>=v.top+4&&r.bottom<=v.bottom-4&&r.left>=v.left+4&&r.right<=v.right-4})||cards.find(c=>c.getAttribute('aria-pressed')==='true');const r=card.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await mouse('mousePressed',currentCard,1);await mouse('mouseReleased',currentCard)
    await wait(()=>driver.evaluate(`window.__oldWorkflowStage!==document.querySelector('.workflow-map-stage')`),'execution node selection redraw')
    assert(Math.abs((await executionView(await mapPoint(false))).scale-rememberedScale)<.001,'Selecting a node preserves execution zoom')
    let execution=await req('POST',base+'/api/workflows/detail',{id:run.id}),task=execution.steps.find(step=>step.id==='h')
    await req('POST',base+'/api/workflows/submit',{id:run.id,nodeId:'h',taskId:task.taskId,decision:'confirm'})
    await wait(async()=>{execution=await req('POST',base+'/api/workflows/detail',{id:run.id});return execution.steps.find(step=>step.id==='a').status==='waiting'},'execution next task')
    task=execution.steps.find(step=>step.id==='a')
    await driver.evaluate('workflowUI.refresh()',{awaitPromise:true})
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-current-task form[id$="${task.taskId}"]')`),'execution refreshed task')
    assert(Math.abs((await executionView(await mapPoint(false))).scale-rememberedScale)<.001,'Instance state refresh preserves execution zoom')
    // The adjacent form retains ordinary scroll semantics and never zooms the map.
    const formViewport=await driver.evaluate(`(()=>{const body=document.querySelector('.workflow-workbench-body'),r=body.getBoundingClientRect();body.scrollTop=0;return{x:r.right-6,y:r.top+r.height*.6,scrollable:body.scrollHeight>body.clientHeight+50,scrollTop:body.scrollTop}})()`)
    assert(formViewport.scrollable,'Fixture must provide an actual scrolling workbench form')
    await wheel(formViewport,360)
    await wait(()=>driver.evaluate(`document.querySelector('.workflow-workbench-body').scrollTop>${formViewport.scrollTop+1}`),'right form scroll')
    assert(Math.abs((await executionView(await mapPoint(false))).scale-rememberedScale)<.001,'Right form scrolling does not change map zoom')
    // Ordinary sidebar reopening must rebind a viewport cleaned up while hidden,
    // even when the instance has not emitted any new facts since the last render.
    const unchangedSequence=(await req('POST',base+'/api/workflows/detail',{id:run.id})).sequence
    await driver.click('#workflowClose')
    await wait(()=>driver.evaluate(`document.getElementById('workflowPage').classList.contains('hidden')`),'hide execution to chat')
    await driver.click('#openWorkflows')
    await wait(()=>driver.evaluate(`!document.getElementById('workflowPage').classList.contains('hidden')&&!!document.querySelector('.workflow-map-scroll')`),'sidebar reopen execution')
    await sleep(100)
    assert.strictEqual((await req('POST',base+'/api/workflows/detail',{id:run.id})).sequence,unchangedSequence,'Reopen fixture has no new instance facts')
    assert(Math.abs((await executionView(await mapPoint(false))).scale-rememberedScale)<.001,'Sidebar reopening preserves scale')
    await executionWheelBothDirections(await mapPoint(false),'execution reopened from sidebar without new facts')
    shot('workflow-execution-wheel.png',Buffer.from(await driver.screenshot(),'base64'))
    console.log('Workflow canvas: select/move, Shift multiselect, marquee group drag, vertical/horizontal split both sides, Esc rollback, wheel anchor, keyboard menu, real port connection/save/reopen, wheel zoom in both diagrams before focus and after redraw, anchored scaling, isolated form scrolling and sidebar reopen without new facts passed')
  } catch (error) {
    console.error(logs.slice(-1200))
    try { console.error(await driver.evaluate('document.getElementById("workflowNotice").textContent'));shot('workflow-canvas-failure.png',Buffer.from(await driver.screenshot(),'base64')) } catch (_) {}
    throw error
  } finally {
    await driver.close()
    if (child) {
      child.kill()
      await wait(() => child.exitCode !== null || child.signalCode !== null, 'shutdown')
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exit(1) })
