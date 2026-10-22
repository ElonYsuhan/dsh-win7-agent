'use strict'
/* Chromium108 真实窗口验收：编辑图与执行图的滚轮缩放、鼠标锚点、视图保持，
   以及 Ribbon、拖拽创建、实时框选反馈、双轴分割移动和保存恢复。
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
    assert.deepStrictEqual(await driver.evaluate(`Array.from(document.querySelectorAll('#workflowCanvasTools [data-canvas-action]')).map(b=>b.dataset.canvasAction)`), ['select','connect','box','split','resize','zoom'])
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
    for(const mode of ['select','connect','box','split','resize','zoom']){
      await driver.click('[data-canvas-action='+mode+']')
      await editorWheelBothDirections(await point(480,260),'editor '+mode+' mode')
    }
    await driver.click('[data-canvas-action=select]')
    // Box-select the top pair and then move the complete selected group.
    await driver.click('[data-canvas-action=box]')
    const marqueeFrom=await point(135,100),marqueeTo=await point(805,185)
    await mouse('mousePressed',marqueeFrom,1);await mouse('mouseMoved',marqueeTo,1);await sleep(100)
    const preview=await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(n=>n.properties.workflowId==='s'),sample=document.createElement('canvas');sample.width=n.size[0]+16;sample.height=n.size[1]+46;const ctx=sample.getContext('2d');ctx.translate(8,38);c.drawNode(n,ctx);const border=Array.from(ctx.getImageData(n.size[0]/2+8,8,1,1).data);ctx.fillStyle=getComputedStyle(document.getElementById('workflowPage')).getPropertyValue('--workflow-node-selected');ctx.fillRect(-8,-38,1,1);return{rect:Array.from(c.dragging_rectangle),selected:!!n.is_selected,border,expected:Array.from(ctx.getImageData(0,0,1,1).data)}})()`)
    assert(preview.rect[2]>100&&!preview.selected,'Marquee preview is live before actual selection')
    assert.deepStrictEqual(preview.border,preview.expected,'Candidate card renders the blue border while dragging')
    shot('workflow-marquee-live.png',Buffer.from(await driver.screenshot(),'base64'))
    await mouse('mouseReleased',marqueeTo)
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
    // Editor chrome: no 编辑流程 header row, flow properties are on the right, tool strip is centred.
    assert(await driver.evaluate(`(()=>{const h=document.querySelector('#workflowPage > .workflow-header');return !h||getComputedStyle(h).display==='none'})()`),'Editor drops the 编辑流程 header row')
    assert(await driver.evaluate(`!!document.querySelector('#workflowFlowProperties #workflowNameField')`),'Flow name belongs to the right-hand workflow properties')
    assert(await driver.evaluate(`(()=>{const t=document.getElementById('workflowCanvasTools').getBoundingClientRect(),h=document.getElementById('workflowCanvasHost').getBoundingClientRect();return Math.abs(t.top+t.height/2-(h.top+h.height/2))<=2})()`),'Canvas tool strip is vertically centred')
    // The explicit card-size mode works before a card is selected, independently of viewport zoom.
    await driver.click('[data-canvas-action=resize]')
    assert(await driver.evaluate(`(()=>{const b=document.querySelector('[data-canvas-action=resize]');return b.getAttribute('aria-label')==='卡片缩放'&&b.getAttribute('aria-pressed')==='true'&&!!b.querySelector('svg')&&document.activeElement.id==='workflowCanvas'&&!document.getElementById('workflowCanvas').data.allow_dragnodes})()`),'Card resize has a named icon, active state and keyboard focus')
    const resizeSnapshot=()=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(v=>v.properties.workflowId==='h');return{pos:Array.from(n.pos),size:Array.from(n.size),scale:c.ds.scale}})()`)
    await driver.evaluate(`document.getElementById('workflowCanvas').data.deselectAllNodes();true`)
    const initialSize=await resizeSnapshot(),topLeft=await point(initialSize.pos[0]+1,initialSize.pos[1]-30+1)
    await mouse('mouseMoved',topLeft);await wait(()=>driver.evaluate(`document.getElementById('workflowCanvas').style.cursor==='nwse-resize'`),'unselected card resize cursor')
    await drag(topLeft,{x:topLeft.x-26*initialSize.scale,y:topLeft.y-20*initialSize.scale})
    const resized=await resizeSnapshot()
    assert(Math.abs(resized.size[0]-initialSize.size[0]-26)<2&&Math.abs(resized.size[1]-initialSize.size[1]-20)<2,'Card resize mode enlarges an unselected card from its top-left corner')
    assert(Math.abs(resized.pos[0]+resized.size[0]-initialSize.pos[0]-initialSize.size[0])<2&&Math.abs(resized.pos[1]+resized.size[1]-initialSize.pos[1]-initialSize.size[1])<2,'The opposite corner stays fixed')
    assert.strictEqual(resized.scale,initialSize.scale,'Card resizing leaves viewport scale unchanged')
    assert(await driver.evaluate(`document.getElementById('workflowNodeTitle').value==='登记需求'`),'Resizing selects the target and opens its properties')
    const body=await point(resized.pos[0]+90,resized.pos[1]+30);await drag(body,{x:body.x+25,y:body.y+15})
    assert.deepStrictEqual(await resizeSnapshot(),resized,'Dragging the body in resize mode does not move or resize the card')
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39})
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39})
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40,modifiers:8})
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40})
    const keyed=await resizeSnapshot();assert.strictEqual(keyed.size[0],resized.size[0]+2);assert.strictEqual(keyed.size[1],resized.size[1]+10)
    for(const theme of ['light','dark']){await driver.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await sleep(80);shot('workflow-card-resize-'+theme+'.png',Buffer.from(await driver.screenshot(),'base64'))}
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    assert(await driver.evaluate(`document.querySelector('[data-canvas-action=select]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-canvas-action=resize]').getAttribute('aria-pressed')==='false'`),'Escape exits card resizing')
    // Card edges resize directly at the actual pointer location; Escape restores the gesture.
    await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(v=>v.properties.workflowId==='h');c.selectNode(n);c.setDirty(true,true);return true})()`)
    const cardSize=()=>driver.evaluate(`Array.from(document.getElementById('workflowCanvas').data.graph._nodes.find(n=>n.properties.workflowId==='h').size)`)
    const sizeBefore=await cardSize(),resizeCorner=()=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,r=c.canvas.getBoundingClientRect(),n=c.graph._nodes.find(v=>v.properties.workflowId==='h');return{x:r.left+(n.pos[0]+n.size[0]-1+c.ds.offset[0])*c.ds.scale,y:r.top+(n.pos[1]+n.size[1]-1+c.ds.offset[1])*c.ds.scale,scale:c.ds.scale}})()`)
    let corner=await resizeCorner();await drag(corner,{x:corner.x+35*corner.scale,y:corner.y+24*corner.scale});await sleep(100)
    const sizeAfter=await cardSize();assert(Math.abs(sizeAfter[0]-sizeBefore[0]-35)<2&&Math.abs(sizeAfter[1]-sizeBefore[1]-24)<2,'Edge dragging resizes the card at the pointer')
    corner=await resizeCorner();await mouse('mousePressed',corner,1);await mouse('mouseMoved',{x:corner.x+30,y:corner.y+20},1)
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await mouse('mouseReleased',corner);assert.deepStrictEqual(await cardSize(),sizeAfter,'Escape restores the card size')
    // A dedicated zoom entry opens controls and restores focus on dismissal.
    const zoomBefore=await driver.evaluate('document.getElementById("workflowCanvas").data.ds.scale');await driver.click('[data-canvas-action=zoom]');await wait(()=>driver.evaluate('!!document.getElementById("workflowZoomMenu")'),'zoom controls')
    await driver.click('#workflowZoomMenu [aria-label="放大画布"]');assert(await driver.evaluate('document.getElementById("workflowCanvas").data.ds.scale>'+zoomBefore),'Zoom controls enlarge the canvas')
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert(await driver.evaluate('!document.getElementById("workflowZoomMenu")&&document.activeElement.id==="workflowCanvasZoomButton"'),'Zoom menu restores focus')
    await driver.evaluate('document.getElementById("workflowCanvas").data.ds.scale='+zoomBefore+';document.getElementById("workflowCanvas").data.setDirty(true,true);true')
    // Vertical divider moves all left/right nodes by equal and opposite distances.
    await driver.click('[data-canvas-action=split]')
    assert(await driver.evaluate(`!document.querySelector('#workflowSplitAxis')&&!document.querySelectorAll('[data-split-axis]').length&&document.querySelectorAll('#workflowCanvasTools [data-canvas-action]').length===6`),'Split no longer ships 左右/上下 buttons: the axis is decided while dragging')
    before=await positions();await drag(await point(480,260),await point(560,260));after=await positions()
    for(const id of ['s','a'])assert(Math.abs(after[id][0]-before[id][0]+40)<2,'Left side moves together: '+id)
    for(const id of ['h','e'])assert(Math.abs(after[id][0]-before[id][0]-40)<2,'Right side moves together: '+id)
    // Same tool, vertical drag: the main direction decides 上下, the other guide disappears.
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
    const ports=await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,a=c.graph._nodes.find(n=>n.properties.workflowId==='s'),b=c.graph._nodes.find(n=>n.properties.workflowId==='h'),r=c.canvas.getBoundingClientRect();b.disconnectInput(0);c.ds.scale=.65;c.ds.offset[0]=0;c.ds.offset[1]=0;c.setDirty(true,true);const p=v=>({x:r.left+(v[0]+c.ds.offset[0])*c.ds.scale,y:r.top+(v[1]+c.ds.offset[1])*c.ds.scale});return{a:p([a.pos[0]+a.size[0]-9,a.pos[1]+20]),b:p([b.pos[0]+30,b.pos[1]+20])}})()`)
    await sleep(100);await drag(ports.a,ports.b)
    assert(await driver.evaluate(`document.getElementById('workflowCanvas').data.graph._nodes.find(n=>n.properties.workflowId==='h').inputs[0].link!==null`),'Connect mode links actual ports')
    // Native HTML5 drag/drop must retain graph coordinates under zoom and panning.
    const ribbon=await driver.evaluate(`(()=>{const buttons=Array.from(document.querySelectorAll('.workflow-editor-topbar .workflow-ribbon-button'));return{vertical:buttons.every(b=>{const i=b.querySelector('.icon').getBoundingClientRect(),t=b.querySelector('.workflow-ribbon-label').getBoundingClientRect();return i.bottom<=t.top+1}),drag:document.querySelector('#workflowNodeTypes [data-node-type=human]').draggable,groups:Array.from(document.querySelectorAll('#workflowNodeTypes [data-ribbon-group]')).map(g=>g.dataset.ribbonGroup)}})()`)
    assert(ribbon.vertical&&ribbon.drag,'Ribbon uses icon-over-text buttons and supports drag sources')
    assert.deepStrictEqual(ribbon.groups,['边界节点','处理节点','结束节点'])
    const dropPoint=await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,r=c.canvas.getBoundingClientRect();return{x:r.left+r.width*.7,y:r.top+r.height*.62,worldX:r.width*.7/c.ds.scale-c.ds.offset[0],worldY:r.height*.62/c.ds.scale-c.ds.offset[1]}})()`)
    const dragData={items:[{mimeType:'application/x-workflow-node',data:'human'}],dragOperationsMask:1}
    for(const type of ['dragEnter','dragOver','drop'])await driver.cdp.send('Input.dispatchDragEvent',{type,x:dropPoint.x,y:dropPoint.y,data:dragData})
    await wait(()=>driver.evaluate(`document.getElementById('workflowCanvas').data.graph._nodes.length===5`),'drop creates human node')
    const dropped=await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(n=>!['s','h','a','e'].includes(n.properties.workflowId));const result={x:n.pos[0]+n.size[0]/2,y:n.pos[1]+(n.size[1]-LiteGraph.NODE_TITLE_HEIGHT)/2,mode:n.properties.interaction.type,blocks:n.properties.processing.blocks};c.graph.remove(n);return result})()`)
    assert(Math.abs(dropped.x-dropPoint.worldX)<2&&Math.abs(dropped.y-dropPoint.worldY)<2,'Drop lands at the pointer in graph coordinates')
    assert.strictEqual(dropped.mode,'review');assert.deepStrictEqual(dropped.blocks,[{type:'instructions',title:'处理描述'},{type:'conclusion',title:'备注',required:false}])
    // A real card blocks an established edge. Rendered geometry must go around it and update after dragging.
    await driver.click('[data-canvas-action=select]');const restoredPositions=await positions()
    await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data;for(const[id,pos]of Object.entries({s:[100,160],h:[800,160],a:[460,130],e:[800,460]}))c.graph._nodes.find(n=>n.properties.workflowId===id).pos=pos;c.ds.scale=.65;c.ds.offset[0]=0;c.ds.offset[1]=0;c.setDirty(true,true);return true})()`)
    const routeState=()=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data;let checked=0;for(const link of Object.values(c.graph.links)){const points=link._workflowRoute;if(!points||points.length<2)throw Error('Route not rendered');for(let i=1;i<points.length;i++)for(const n of c.graph._nodes){if(i===1&&n.id===link.origin_id||i===points.length-1&&n.id===link.target_id)continue;if(workflowLinkRouting.hits(points[i-1],points[i],{left:n.pos[0],right:n.pos[0]+n.size[0],top:n.pos[1]-LiteGraph.NODE_TITLE_HEIGHT,bottom:n.pos[1]+n.size[1]}))throw Error('Route crosses '+n.title)}checked++}const source=c.graph._nodes.find(n=>n.properties.workflowId==='s'),link=Object.values(c.graph.links).find(l=>l.origin_id===source.id);return{checked,points:link._workflowRoute,length:workflowLinkRouting.length(link._workflowRoute)}})()`)
    await wait(async()=>(await routeState()).checked===3,'obstacle-free rendered paths');const obstructed=await routeState();assert(obstructed.points.length>2,'Blocked edge takes a detour');assert(await driver.evaluate(`Object.values(document.getElementById('workflowCanvas').data.graph.links).some(l=>l._workflowRouteCommands.some(c=>c.type==='C'))`),'Detours render cubic Bezier corners');shot('workflow-routing-detour.png',Buffer.from(await driver.screenshot(),'base64'))
    const obstacleTitle=await titlePoint('a');await drag(obstacleTitle,{x:obstacleTitle.x,y:obstacleTitle.y+280*.65});await wait(async()=>(await routeState()).length<obstructed.length,'live rerouting after obstacle drag')
    await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data;for(const[id,pos]of Object.entries(${JSON.stringify(restoredPositions)}))c.graph._nodes.find(n=>n.properties.workflowId===id).pos=pos;c.setDirty(true,true);return true})()`)
    before=await positions()
    for(const theme of ['light','dark']){await driver.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await sleep(80);shot('workflow-canvas-'+theme+'.png',Buffer.from(await driver.screenshot(),'base64'))}
    await driver.click('#workflowSave');await wait(()=>driver.evaluate(`!document.getElementById('workflowCards').classList.contains('hidden')`),'saved')
    const saved=(await req('GET',base+'/api/workflows')).workflows.find(w=>w.id===flow.id)
    for(const n of saved.nodes){assert.deepStrictEqual(n.pos,before[n.id],'Position persisted for '+n.id);if(n.id==='h')assert.deepStrictEqual(n.size,sizeAfter,'Card size persisted for '+n.id)}
    await driver.evaluate('workflowUI.openDraft(' + JSON.stringify(flow.id) + ')', { awaitPromise: true })
    await wait(()=>driver.evaluate(`document.getElementById('workflowCanvas').data.graph._nodes.length===4`),'reopened')
    assert.deepStrictEqual(await positions(),before,'Group/split positions survive reopening')
    assert.deepStrictEqual(await cardSize(),sizeAfter,'Card dimensions survive reopening')
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
    // Ports exist only for actual edges, with one transient affordance at the pointer.
    const identitySchema={type:'object',title:'处理人身份',properties:{identity:{type:'string',title:'处理人身份',enum:['A','B','C']}},required:['identity']}
    const lazy=await req('POST',base+'/api/workflows/save',{name:'按需连线验收',version:2,editor:'canvas',nodes:[{id:'s',type:'start',pos:[70,130],text:'原始资料'},{id:'h',type:'human',title:'处理资料',pos:[400,130],inputSchema:identitySchema,interaction:{version:1,type:'review'},processing:{version:1,blocks:[{type:'form',title:'处理人身份'},{type:'attachments'}]}},{id:'e',type:'end',pos:[740,130]},{id:'a',type:'template',pos:[400,340]},{id:'b',type:'template',pos:[740,340]}],edges:[{from:'s',to:'h'},{from:'h',to:'e'}]})
    await driver.evaluate('workflowUI.openDraft('+JSON.stringify(lazy.id)+')',{awaitPromise:true});await wait(()=>driver.evaluate(`document.getElementById('workflowCanvas').data.graph._nodes.length===5`),'lazy canvas')
    await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data;c.ds.scale=.8;c.ds.offset[0]=20;c.ds.offset[1]=10;c.draw(true,true);return true})()`)
    const portState=()=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data;return{edges:Object.keys(c.graph.links).length,temporary:c.graph._nodes.reduce((sum,n)=>sum+[...(n.inputs||[]),...(n.outputs||[])].filter(p=>p._workflowTemporary).length,0),nodes:Object.fromEntries(c.graph._nodes.map(n=>[n.properties.workflowId,{inputs:(n.inputs||[]).length,outputs:(n.outputs||[]).length}]))}})()`)
    let lazyState=await portState();assert.deepStrictEqual(lazyState.nodes,{s:{inputs:0,outputs:1},h:{inputs:1,outputs:1},e:{inputs:1,outputs:0},a:{inputs:0,outputs:0},b:{inputs:0,outputs:0}});assert.strictEqual(lazyState.temporary,0,'No idle spare handles')
    const edgePoint=async(id,y=40,input=false)=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(n=>n.properties.workflowId===${JSON.stringify(id)}),r=c.canvas.getBoundingClientRect();return{x:r.left+(n.pos[0]+${input?'10':'n.size[0]-9'}+c.ds.offset[0])*c.ds.scale,y:r.top+(n.pos[1]+${y}+c.ds.offset[1])*c.ds.scale}})()`)
    const bodyPoint=async id=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(n=>n.properties.workflowId===${JSON.stringify(id)}),r=c.canvas.getBoundingClientRect();return{x:r.left+(n.pos[0]+80+c.ds.offset[0])*c.ds.scale,y:r.top+(n.pos[1]+35+c.ds.offset[1])*c.ds.scale}})()`)
    const empty=await point(350,280)
    await mouse('mouseMoved',await edgePoint('s'));await wait(async()=>(await portState()).temporary===1,'hover affordance');await mouse('mouseMoved',empty);await wait(async()=>(await portState()).temporary===0,'hover exit cleanup');assert.strictEqual((await portState()).nodes.s.outputs,1)
    for(const[from,to]of[['s','a'],['a','b'],['b','e']]){const count=(await portState()).edges;await drag(await edgePoint(from),await bodyPoint(to));await wait(async()=>(await portState()).edges===count+1&&(await portState()).temporary===0,'drop onto card '+to)}
    lazyState=await portState();assert.strictEqual(lazyState.nodes.s.outputs,2);assert.strictEqual(lazyState.nodes.e.inputs,2,'Dropping on an occupied card adds a new input without replacing the old link')
    await drag(await edgePoint('h',45,true),await bodyPoint('s'));await wait(async()=>(await portState()).edges===6&&(await portState()).temporary===0,'reverse input to card connection');assert.strictEqual((await portState()).nodes.h.inputs,2)
    const reverseInput=await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(n=>n.properties.workflowId==='h'),p=n.getConnectionPos(true,1),r=c.canvas.getBoundingClientRect();return{x:r.left+(p[0]+c.ds.offset[0])*c.ds.scale,y:r.top+(p[1]+c.ds.offset[1])*c.ds.scale}})()`)
    await drag(reverseInput,empty);await wait(async()=>{const state=await portState();return state.edges===5&&state.temporary===0&&state.nodes.s.outputs===2},'disconnect removes trailing empty handles');assert.deepStrictEqual(await portState(),lazyState,'Disconnect preserves every earlier connection')
    const beforeCancel=lazyState,cancelSource=await edgePoint('s',57);await mouse('mousePressed',cancelSource,1);await mouse('mouseMoved',empty,1)
    assert((await portState()).temporary>0,'The source handle stays visible during the gesture');await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await mouse('mouseReleased',empty);await sleep(60);assert.deepStrictEqual(await portState(),beforeCancel,'Escape removes only temporary ports')
    await drag(await edgePoint('s',57),empty);await wait(async()=>(await portState()).temporary===0,'empty drop cleanup');assert.deepStrictEqual(await portState(),beforeCancel)
    await mouse('mousePressed',await edgePoint('s',57),1);await mouse('mouseMoved',empty,1);await driver.evaluate(`document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))`);await mouse('mouseReleased',empty);await wait(async()=>(await portState()).temporary===0,'system pointer cancel cleanup');assert.deepStrictEqual(await portState(),beforeCancel)
    await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data;c.selectNode(c.graph._nodes.find(n=>n.properties.workflowId==='h'));return true})()`)
    assert(await driver.evaluate(`(()=>{const p=document.getElementById('workflowExecutionMiniPreview');return p.textContent.split('处理人身份').length===2&&!p.querySelector('.workflow-file-note')&&p.querySelector('[data-schema-field=identity]')})()`),'Single-field forms display one title; no attachment transport note')
    await driver.click('#workflowExecutionDesign');await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-design-preview form')`),'design preview');assert(await driver.evaluate(`(()=>{const p=document.querySelector('.workflow-design-preview');return p.textContent.split('处理人身份').length===2&&!p.querySelector('.workflow-file-note')})()`),'Designer uses the same deduplicated form')
    await driver.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait(()=>driver.evaluate(`!document.querySelector('.workflow-execution-designer')`),'design close')
    for(const theme of ['light','dark']){await driver.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('workflowCanvas').data.setDirty(true,true)`);await sleep(80);shot('workflow-lazy-ports-'+theme+'.png',Buffer.from(await driver.screenshot(),'base64'))}
    await driver.click('#workflowSave');await wait(()=>driver.evaluate(`!document.getElementById('workflowCards').classList.contains('hidden')`),'lazy save');const lazySaved=(await req('GET',base+'/api/workflows')).workflows.find(f=>f.id===lazy.id);assert.strictEqual(lazySaved.edges.length,5);assert.strictEqual(lazySaved.nodes.find(n=>n.id==='e').inputs.length,2)
    await driver.evaluate('workflowUI.openDraft('+JSON.stringify(lazy.id)+')',{awaitPromise:true});await wait(async()=>(await portState()).edges===5,'lazy reopen');assert.strictEqual((await portState()).temporary,0)
    // A hidden hole in an old definition keeps its logical slot for {{input2}}.
    const legacy=await req('POST',base+'/api/workflows/save',{name:'旧端口编号兼容',nodes:[{id:'s',type:'start',text:'旧资料'},{id:'t',type:'template',text:'检查 {{input2}}',inputs:[{name:'旧空入口'},{name:'既有资料'}]},{id:'e',type:'end'}],edges:[{from:'s',to:'t',slot:1},{from:'t',to:'e'}]})
    await driver.evaluate('workflowUI.openDraft('+JSON.stringify(legacy.id)+')',{awaitPromise:true});await wait(()=>driver.evaluate(`document.getElementById('workflowCanvas').data.graph._nodes.length===3`),'legacy slots')
    assert(await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(n=>n.properties.workflowId==='t');return n.inputs.length===2&&n.getConnectionPos(true,0)[0]<-1e5&&n.getConnectionPos(true,1)[0]>0})()`),'Unused leading slots are hidden while logical numbering stays intact')
    await driver.click('#workflowSave');await wait(()=>driver.evaluate(`!document.getElementById('workflowCards').classList.contains('hidden')`),'legacy save');const legacySaved=(await req('GET',base+'/api/workflows')).workflows.find(f=>f.id===legacy.id);assert.strictEqual(legacySaved.edges.find(e=>e.to==='t').slot,1);const legacyRun=await req('POST',base+'/api/workflows/run',{id:legacy.id});await wait(async()=>(await req('POST',base+'/api/workflows/detail',{id:legacyRun.id})).status==='succeeded','legacy execution');assert.strictEqual((await req('POST',base+'/api/workflows/detail',{id:legacyRun.id})).steps.find(s=>s.id==='t').output,'检查 旧资料')
    // Reproduce the reported offset fourth card and two row wraps in the actual renderer.
    const wrapPositions=[[0,100],[240,100],[480,100],[680,20],[0,260],[240,260],[480,260],[720,260],[0,420]],wrapTitles=['开始 | 任务输入','上传资料','文档解析与要点提取','生成方案草案','方案评估','审阅确认','按审阅意见修订','审批定稿','结束 | 归档'],wrapTypes=['start','human','ai','ai','evaluate','human','ai','human','end']
    const wrapFlow=await req('POST',base+'/api/workflows/save',{version:2,editor:'canvas',name:'跨行连线验收',nodes:wrapPositions.map(([x,y],id)=>({id:'n'+id,type:wrapTypes[id],title:wrapTitles[id],text:'节点处理内容',pos:[x+50,y+60],size:[220,62]})),edges:wrapPositions.slice(1).map((_,id)=>({from:'n'+id,to:'n'+(id+1)}))})
    await driver.evaluate('workflowUI.openDraft('+JSON.stringify(wrapFlow.id)+')',{awaitPromise:true})
    await wait(()=>driver.evaluate(`Object.values(document.getElementById('workflowCanvas').data.graph.links).filter(l=>l._workflowRouteCommands&&l._workflowRouteCommands.length).length===8`),'wrapped routes')
    const wrappedState=()=>driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,links=Object.values(c.graph.links),before=links.map(l=>l._workflowRoute);let curves=0;const proto=CanvasRenderingContext2D.prototype,original=proto.bezierCurveTo;proto.bezierCurveTo=function(...v){curves++;return original.apply(this,v)};try{c.draw(true,true)}finally{proto.bezierCurveTo=original}return{paths:links.map(l=>l._workflowRoute),curves,cached:links.every((l,i)=>l._workflowRoute===before[i]),blocked:document.getElementById('workflowCanvasHost').dataset.blockedLinks}})()`)
    const wrapResult=await wrappedState();assert.strictEqual(wrapResult.blocked,'0');assert(wrapResult.curves>=8,'Actual Canvas paints rounded wrap corners');assert(wrapResult.cached,'An unchanged frame reuses planned lanes')
    let shared=0,crossings=0
    for(let i=0;i<wrapResult.paths.length;i++)for(let j=0;j<i;j++)for(let a=1;a<wrapResult.paths[i].length;a++)for(let b=1;b<wrapResult.paths[j].length;b++){
      const p=wrapResult.paths[i][a-1],q=wrapResult.paths[i][a],x=wrapResult.paths[j][b-1],y=wrapResult.paths[j][b],h=p[1]===q[1],v=x[1]===y[1]
      if(h===v){if(p[h?1:0]===x[h?1:0])shared+=Math.max(0,Math.min(Math.max(p[h?0:1],q[h?0:1]),Math.max(x[h?0:1],y[h?0:1]))-Math.max(Math.min(p[h?0:1],q[h?0:1]),Math.min(x[h?0:1],y[h?0:1])))}
      else{const horizontal=h?[p,q]:[x,y],vertical=h?[x,y]:[p,q],cx=vertical[0][0],cy=horizontal[0][1];if(cx>Math.min(horizontal[0][0],horizontal[1][0])&&cx<Math.max(horizontal[0][0],horizontal[1][0])&&cy>Math.min(vertical[0][1],vertical[1][1])&&cy<Math.max(vertical[0][1],vertical[1][1]))crossings++}
    }
    assert.strictEqual(shared,0,'Real wrapped lines do not share unrelated lanes');assert.strictEqual(crossings,0,'The offset card layout has no wire crossings')
    for(const theme of ['light','dark']){await driver.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('workflowCanvas').data.setDirty(true,true)`);await sleep(100);shot('workflow-routing-wrapped-'+theme+'.png',Buffer.from(await driver.screenshot(),'base64'))}
    await driver.evaluate('workflowUI.openDraft('+JSON.stringify(wrapFlow.id)+')',{awaitPromise:true});await wait(()=>driver.evaluate(`Object.values(document.getElementById('workflowCanvas').data.graph.links).filter(l=>l._workflowRouteCommands&&l._workflowRouteCommands.length).length===8`),'wrapped reopen');assert.deepStrictEqual((await wrappedState()).paths,wrapResult.paths,'Reopening preserves deterministic lane geometry')
    console.log('Workflow canvas: Ribbon icon-over-text groups, HTML5 drag/drop coordinates, live marquee blue preview, select/move, Shift multiselect, marquee group drag, vertical/horizontal split both sides, Esc rollback, wheel anchor, keyboard menu, real port connection/save/reopen, wheel zoom in both diagrams before focus and after redraw, anchored scaling, isolated form scrolling and sidebar reopen without new facts passed')
  } catch (error) {
    try{console.error('Port diagnostics',JSON.stringify(await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data;return{connecting:c.connecting_node&&c.connecting_node.properties.workflowId,nodes:c.graph._nodes.map(n=>({id:n.properties.workflowId,inputs:(n.inputs||[]).map(p=>({name:p.name,link:p.link,temp:p._workflowTemporary})),outputs:(n.outputs||[]).map(p=>({name:p.name,links:p.links,temp:p._workflowTemporary}))})),edges:Object.values(c.graph.links).map(l=>({from:l.origin_id,to:l.target_id,in:l.target_slot,out:l.origin_slot}))}})()`)))}catch(_){}
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
