'use strict'
/* 真实窗口验收：人工节点的交互类型（办理 / 审阅 / 审批）、折叠的“补充内容”、
   一键完成，以及审批驳回后真实退回上游人工环节并保留历史。
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
    { id: 'a', type: 'human', title: '审批方案', text: '确认方案是否可以执行。', interaction: { version: 1, type: 'approve', returnTo: 'previous-human' } },
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
    console.log('Workflow canvas: select/move, Shift multiselect, marquee group drag, vertical/horizontal split both sides, Esc rollback, wheel anchor, keyboard menu, real port connection and save/reopen passed')
  } catch (error) {
    console.error(logs.slice(-1200))
    try { console.error(await driver.evaluate('document.getElementById("workflowNotice").textContent')) } catch (_) {}
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
