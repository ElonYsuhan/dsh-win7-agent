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
  name: '人工交互验收',
  version: 2,
  editor: 'steps',
  nodes: [
    { id: 's', type: 'start', text: '原始需求' },
    { id: 'h', type: 'human', title: '登记需求', text: '登记需求要点后继续。', interaction: { version: 1, type: 'handle', returnTo: 'previous-human' } },
    { id: 'a', type: 'human', title: '审批方案', text: '确认方案是否可以执行。', inputSchema:{type:'object',properties:{check:{type:'string',title:'审批依据',minLength:1}},required:['check']}, interaction: { version: 1, type: 'approve', returnTo: 'previous-human' } },
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

    /* 编辑器：默认只露名称、处理描述、交互类型 */
    await driver.evaluate('workflowUI.openDraft(' + JSON.stringify(flow.id) + ')', { awaitPromise: true })
    await wait(() => driver.evaluate('!document.getElementById("workflowEditor").classList.contains("hidden")'), 'editor open')
    await driver.evaluate(`(()=>{const c=document.getElementById('workflowCanvas').data,n=c.graph._nodes.find(x=>x.properties.workflowId==='a');c.selectNode(n);c.onNodeSelected(n);return true})()`)
    await wait(() => driver.evaluate('document.getElementById("workflowNodeTitle").value==="审批方案"'), 'approve node selected')
    const editor = await driver.evaluate(`(()=>{
      const interaction=document.getElementById('workflowHumanInteractionOptions'),extras=document.getElementById('workflowHumanExtras'),advanced=document.getElementById('workflowNodeAdvanced')
      const attachment=extras.querySelector('input[type=checkbox]'),target=Array.from(document.querySelectorAll('#workflowStructuredOptions select')).find(s=>s.getAttribute('aria-label')==='驳回退回节点')
      return {type:document.getElementById('workflowInteractionType').value,hint:document.getElementById('workflowInteractionHint').textContent,
        interactionVisible:!interaction.classList.contains('hidden'),extrasCollapsed:extras.open===false,advancedCollapsed:advanced.open===false,
        attachmentEnabled:attachment.checked,targets:target?Array.from(target.options).map(o=>o.textContent):null,mode:document.getElementById('workflowNodeMode').textContent,
        textLabel:document.getElementById('workflowNodeTextLabel').textContent}
    })()`)
    assert.strictEqual(editor.type, 'approve', 'Interaction type must load from the definition')
    assert(editor.interactionVisible && editor.textLabel === '处理描述', 'Default editor shows only description and interaction type')
    assert(editor.extrasCollapsed, 'Attachments and forms stay inside a collapsed 补充内容 section')
    assert(editor.advancedCollapsed, 'Advanced settings stay collapsed by default')
    assert.strictEqual(editor.attachmentEnabled, false, 'Attachment box is off unless the node asks for it')
    assert(editor.targets.some(text => text.includes('登记需求')), 'Return target lists upstream human handling step')
    assert(editor.mode.includes('人工审批'), 'Mode line names the interaction preset')
    shot('workflow-interaction-editor.png', Buffer.from(await driver.screenshot(), 'base64'))

    /* 执行：办理 → 审批 → 驳回 → 退回办理 */
    const run = await req('POST', base + '/api/workflows/run', { id: flow.id, confirmed: true })
    await driver.evaluate('workflowUI.openReference(' + JSON.stringify({ runId: run.id, workflowId: flow.id }) + ')', { awaitPromise: true })
    await wait(() => driver.evaluate('!!document.querySelector(".workflow-current-task form")'), 'handle task')
    const handle = await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task');return {title:document.querySelector('.workflow-node-title h2').textContent,files:!!task.querySelector('input[type=file]'),conclusions:!!task.querySelector('.workflow-conclusion-field'),reads:!!task.querySelector('.workflow-review-confirm'),submit:document.querySelector('.workflow-task-actions button[type=submit]').textContent}})()`)
    assert.strictEqual(handle.title, '登记需求')
    assert.strictEqual(handle.files, false, 'Attachment box must not appear on a 办理 step')
    assert.strictEqual(handle.conclusions, false, 'A 办理 step must not force a conclusion')
    assert.strictEqual(handle.reads, false, 'A 办理 step must not ask for a redundant read checkbox')
    assert(handle.submit.includes('完成并继续'), 'One click completes a 办理 step')
    await driver.evaluate('document.querySelector(".workflow-current-task form").requestSubmit();true')

    await wait(() => driver.evaluate('document.querySelector(".workflow-node-title h2").textContent==="审批方案"&&!!document.querySelector(".workflow-current-task form")'), 'approve task')
    await driver.evaluate(`(()=>{document.querySelector('.workflow-map-toggle').click();return true})()`)
    await wait(() => driver.evaluate('document.querySelector(".workflow-execution-map").classList.contains("is-collapsed")'), 'collapsed map')
    assert(await driver.evaluate('document.querySelector(".workflow-map-scroll").getBoundingClientRect().height===0'), 'Collapsing the map gives the first screen to the task')
    shot('workflow-interaction-collapsed.png', Buffer.from(await driver.screenshot(), 'base64'))
    await driver.evaluate(`(()=>{document.querySelector('.workflow-map-toggle').click();return true})()`)
    await wait(() => driver.evaluate('!document.querySelector(".workflow-execution-map").classList.contains("is-collapsed")&&!!document.querySelector(".workflow-current-task form")'), 'expanded map')
    const approve = await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task'),radios=Array.from(task.querySelectorAll('.workflow-decision input[type=radio]')).map(r=>r.value),reason=task.querySelector('.workflow-decision .workflow-conclusion-field');return {radios,reasonHidden:!reason||getComputedStyle(reason).display==='none',hint:task.querySelector('.workflow-decision p')?task.querySelector('.workflow-decision p').textContent:'',submit:document.querySelector('.workflow-task-actions button[type=submit]').textContent}})()`)
    assert.deepStrictEqual(approve.radios, ['approve', 'reject'], 'Approve step offers 通过 / 驳回')
    assert(approve.reasonHidden, 'Reason field stays hidden until 驳回 is chosen')
    assert(approve.hint.includes('登记需求'), 'Approve step names the return target')
    await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task'),reject=task.querySelector('.workflow-decision input[value=reject]');reject.click();const reason=task.querySelector('.workflow-decision .workflow-conclusion-field');return {visible:getComputedStyle(reason).display!=='none',required:task.querySelector('.workflow-decision textarea').required,submit:document.querySelector('.workflow-task-actions button[type=submit]').textContent}})()`).then(state => {
      assert(state.visible, 'Choosing 驳回 reveals the reason field')
      assert(state.required, 'Reason is required for 驳回')
      assert(state.submit.includes('驳回'), 'Submit button follows the chosen decision')
    })
    shot('workflow-interaction-approve.png', Buffer.from(await driver.screenshot(), 'base64'))
    await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task');task.querySelector('.workflow-decision textarea').value='方案缺少验收步骤，请补充';task.querySelector('form').requestSubmit();return true})()`)

    await wait(() => driver.evaluate('document.querySelector(".workflow-node-title h2").textContent==="登记需求"&&!!document.querySelector(".workflow-current-task form")'), 'returned to handling step')
    const returned = await driver.evaluate(`(()=>{const banner=document.querySelector('.workflow-return-banner');return {banner:banner?banner.textContent:'',notice:document.getElementById('workflowNotice').textContent,error:Array.from(document.querySelectorAll('#workflowRunDetail .workflow-error')).filter(e=>e.textContent.trim()&&!e.closest('.workflow-current-task')).map(e=>e.textContent).join(' | ')}})()`)
    assert(returned.banner.includes('退回') && returned.banner.includes('方案缺少验收步骤'), 'A business rejection is shown as a return, with its reason')
    assert(!returned.error, 'A business rejection must not read as a technical failure: '+returned.error)
    shot('workflow-interaction-returned.png', Buffer.from(await driver.screenshot(), 'base64'))
    let detail = await req('POST', base + '/api/workflows/detail', { id: run.id })
    const handling = detail.steps.find(step => step.id === 'h')
    assert.strictEqual(handling.attempt, 2, 'Returned step runs a fresh attempt')
    assert.strictEqual(handling.attempts.length, 2, 'Returned step keeps the first attempt in history')
    assert(handling.attempts[0].output.includes('已确认此步骤'), 'First attempt output is preserved verbatim')
    assert(detail.steps.find(step => step.id === 'a').timeline.some(fact => JSON.stringify(fact).includes('方案缺少验收步骤')), 'Rejection reason stays in execution history')
    assert.strictEqual(detail.steps.find(step => step.id === 'a').status, 'pending')

    /* 修改后重新提交：下游重新处理，最终完成 */
    await driver.evaluate('document.querySelector(".workflow-current-task form").requestSubmit();true')
    await wait(() => driver.evaluate('document.querySelector(".workflow-node-title h2").textContent==="审批方案"&&!!document.querySelector(".workflow-current-task form")'), 'approve again')
    await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task');task.querySelector('[data-schema-field=check]').value='资料已补充，同意';task.querySelector('.workflow-decision input[value=approve]').click();task.querySelector('form').requestSubmit();return true})()`)
    await wait(() => driver.evaluate('document.querySelector(".workflow-detail-heading").textContent.includes("已结束")'), 'completed')
    detail = await req('POST', base + '/api/workflows/detail', { id: run.id })
    assert.strictEqual(detail.steps.find(step => step.id === 'a').attempts.length, 2, 'Approval reruns after the returned step changes')
    assert.strictEqual(detail.steps.find(step => step.id === 'a').reviewed, false, 'Approval keeps its explicit decision record')
    // Review has a one-click normal path and an optional rejection path.
    const reviewFlow=await req('POST',base+'/api/workflows/save',{
      name:'审阅、表单与附件退回',version:2,editor:'steps',nodes:[
        {id:'s',type:'start'},
        {id:'h',type:'human',title:'填写依据',interaction:{version:1,type:'handle'},humanModes:['upload'],inputSchema:{type:'object',properties:{finding:{type:'string',title:'核查依据',minLength:1}},required:['finding']}},
        {id:'r',type:'human',title:'审阅确认',interaction:{version:1,type:'review'}},
        {id:'e',type:'end'}
      ],edges:[{from:'s',to:'h'},{from:'h',to:'r'},{from:'r',to:'e'}]
    })
    const reviewRun=await req('POST',base+'/api/workflows/run',{id:reviewFlow.id})
    await driver.evaluate('workflowUI.openReference('+JSON.stringify({runId:reviewRun.id,workflowId:reviewFlow.id})+')',{awaitPromise:true})
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-current-task [data-schema-field=finding]')`),'review form')
    await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task'),transfer=new DataTransfer();transfer.items.add(new File(['原始依据'],'来源.md'));task.querySelector('[data-schema-field=finding]').value='第一版核查依据';task.querySelector('.workflow-upload-zone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));task.querySelector('form').requestSubmit();return true})()`)
    await wait(()=>driver.evaluate(`document.querySelector('.workflow-node-title h2').textContent==='审阅确认'&&!!document.querySelector('.workflow-review-reject')`),'review decision')
    assert(await driver.evaluate(`!document.querySelector('.workflow-current-task .workflow-review-confirm')&&document.querySelector('.workflow-task-actions button[type=submit]').textContent.includes('已审阅，继续')`),'Review does not force a redundant checkbox')
    await driver.click('.workflow-review-reject')
    await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task');task.querySelector('.workflow-decision textarea').value='请补充出处';task.querySelector('form').requestSubmit();return true})()`)
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-current-task [data-schema-field=finding]')`),'returned form')
    assert.strictEqual(await driver.evaluate(`document.querySelector('.workflow-current-task [data-schema-field=finding]').value`),'第一版核查依据','Return restores editable field values')
    assert(await driver.evaluate(`document.querySelector('.workflow-reused-files').textContent.includes('来源.md')&&document.querySelector('.workflow-reused-files input').checked`),'Returned attachments remain selected for reuse')
    // Historical node selection keeps the current task usable as a decision aid.
    await driver.evaluate(`Array.from(document.querySelectorAll('.workflow-map-node')).find(n=>n.textContent.includes('开始')).click();true`)
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-current-task [data-schema-field=finding]')&&!!document.querySelector('.workflow-locate-action')`),'Viewing a previous node keeps current task')
    await driver.evaluate(`(()=>{const task=document.querySelector('.workflow-current-task');task.querySelector('[data-schema-field=finding]').value='第二版：出处已补充';task.querySelector('form').requestSubmit();return true})()`)
    await wait(()=>driver.evaluate(`!!document.querySelector('.workflow-review-reject')`),'review again')
    await driver.evaluate(`document.querySelector('.workflow-current-task form').requestSubmit();true`)
    await wait(async()=>(await req('POST',base+'/api/workflows/detail',{id:reviewRun.id})).status==='succeeded','review complete')
    const completed=await req('POST',base+'/api/workflows/detail',{id:reviewRun.id})
    assert.strictEqual(completed.steps.find(n=>n.id==='r').reviewed,true)
    assert.strictEqual(completed.steps.find(n=>n.id==='h').files[0].name,'来源.md')
    assert.strictEqual(completed.steps.find(n=>n.id==='h').data.finding,'第二版：出处已补充')
    console.log('Workflow interaction UI: interaction presets, collapsed extras, one-click handling, real return to the upstream handling step, reason evidence, rerun and completion passed')
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
