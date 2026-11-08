'use strict'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert')
const { spawn } = require('child_process'), { BrowserDriver } = require('../src/main/agent/browser-driver')
const root = path.resolve(__dirname, '..'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const bundle = process.argv[2] ? path.resolve(process.argv[2]) : null
const application = bundle ? path.join(bundle, 'Contents/Resources/app') : root
async function wait(fn, label) { for (let i = 0; i < 600; i++) { if (await fn()) return; await sleep(80) } throw Error('timeout ' + label) }
function request(method, url, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'content-type': 'application/json' } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => {
        try { const result = JSON.parse(body); if (response.statusCode >= 400) reject(Error(result.error)); else resolve(result) } catch (error) { reject(error) }
      })
    }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
  })
}
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-suggest-e2e-')), driver = new BrowserDriver()
  let service, logs = '', requests = 0, backgroundReply, finishBackgroundReply
  const firstTurnIndexes = []
  const model = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      if (req.method === 'GET') { res.end(JSON.stringify({ data: [] })); return }
      requests++
      const messages = JSON.parse(raw).messages
      const userIndex = messages.map(message => message.role).lastIndexOf('user')
      const text = String(messages[userIndex].content)
      const background = text.includes('后台回复验证')
      const suggested = messages.slice(userIndex + 1).some(message => message.role === 'tool')
      const system = messages.find(message => message.role === 'system').content
      const line = system.split('\n').find(value => value.startsWith('SAVED_WORKFLOWS_JSON: '))
      const index = line ? JSON.parse(line.slice('SAVED_WORKFLOWS_JSON: '.length)) : { workflows: [] }
      const candidate = index.workflows.find(workflow => workflow.name === (text.includes('锻炼') ? '每日运动训练' : '周报汇总'))
      if (!background && !suggested) firstTurnIndexes.push({ text, candidate })
      const delta = background ? { content: '后台回复验证已完成' } : suggested ? { content: '请点击卡片开启已推荐的流程。' } : candidate ? {
        tool_calls: [{ index: 0, id: 'suggest_saved_workflow', type: 'function', function: { name: 'workflow_suggest', arguments: JSON.stringify({ workflowId: candidate.id, reason: '覆盖当前任务；人工确认由用户在流程中完成，完成后交付记录。', matches: ['goal', 'steps', 'human', 'deliverable'] }) } }]
      } : { content: '首个请求中没有可用的流程索引。' }
      const send = () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n') }
      if (background) {
        backgroundReply = () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '后台回复验证' }, finish_reason: null }] }) + '\n\n')
          finishBackgroundReply = () => res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '已完成' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
        }
      } else send()
    })
  })
  try {
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspacePath: home, baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'test', model: 'mock', contextAutoCompress: false }))
    if (bundle) {
      const device = await require('../src/main/licensing/device').deviceIdentity()
      const license = require('./license-authority/issuer').issue({ requestText: JSON.stringify({ version: 1, product: 'dsh-agent', deviceDigest: device.deviceDigest, platform: device.platform, arch: device.arch, name: device.name }), customer: '隔离流程会话验收', days: 1 })
      fs.mkdirSync(path.join(home, 'licensing'))
      fs.writeFileSync(path.join(home, 'licensing/state.json'), JSON.stringify({ version: 1, lastSeenAt: Date.now(), trial: null, license: license.text, sequences: { [license.claims.licenseId]: license.claims.sequence } }))
    }
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    const base = 'http://127.0.0.1:' + port
    const runtime = bundle ? path.join(bundle, 'Contents/MacOS/Electron') : process.execPath
    service = spawn(runtime, [path.join(application, bundle ? 'service/index.js' : 'server/index.js')], { cwd: application, env: { ...process.env, ...(bundle ? { ELECTRON_RUN_AS_NODE: '1' } : {}), AGENT_HOME: home, HOST: '127.0.0.1', PORT: String(port), PORT_MAX_ATTEMPTS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    service.stdout.on('data', chunk => { logs += chunk }); service.stderr.on('data', chunk => { logs += chunk })
    await wait(async () => { try { return (await request('GET', base + '/api/health')).ok } catch (_) { return false } }, 'service ready')
    const schema = { type: 'object', properties: { notes: { type: 'string', title: '本周工作', minLength: 1 } }, required: ['notes'], additionalProperties: false }
    const flow = await request('POST', base + '/api/workflows/save', {
      name: '周报汇总', description: '收集本周进展并人工审阅后生成周报', nodes: [
        { id: 's', type: 'start', title: '开始', text: '本周进展' },
        { id: 'h', type: 'human', title: '登记素材', interaction: { version: 1, type: 'handle' }, inputSchema: schema, processing: { version: 1, blocks: [{ type: 'instructions', text: '登记已核实的本周工作，可附上原始素材。' }, { type: 'form' }, { type: 'attachments' }] } },
        { id: 'r', type: 'human', title: '审阅确认', interaction: { version: 1, type: 'approve', returnTo: 'h' }, processing: { version: 1, blocks: [{ type: 'instructions', text: '核对素材后通过，或说明原因退回。' }, { type: 'reference', source: 'input' }] } },
        { id: 'e', type: 'end', title: '交付', deliverable: { format: 'markdown', name: '周报' } }
      ], edges: [{ from: 's', to: 'h' }, { from: 'h', to: 'r' }, { from: 'r', to: 'e' }]
    })
    const exercise = await request('POST', base + '/api/workflows/save', {
      name: '每日运动训练', description: '每日锻炼，逐组由本人确认后继续，交付训练记录', nodes: [
        { id: 'start', type: 'start', text: '今日训练' },
        { id: 'confirm', type: 'human', title: '确认本组完成', interaction: { version: 1, type: 'handle' } },
        { id: 'end', type: 'end', deliverable: { format: 'markdown', name: '训练记录' } }
      ], edges: [{ from: 'start', to: 'confirm' }, { from: 'confirm', to: 'end' }]
    })
    const binary = bundle ? runtime : path.join(root, 'node_modules/electron/dist', fs.readFileSync(path.join(root, 'node_modules/electron/path.txt'), 'utf8').trim())
    await driver.launch(base + '/', { electronPath: binary, width: 1280, height: 900, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    await wait(() => driver.evaluate('!!window.workflowChat&&!!window.workflowUI&&!!state.settings'), 'renderer ready')
    await driver.evaluate('window.__chatErrors=[];window.addEventListener("error",event=>window.__chatErrors.push(event.message));window.addEventListener("unhandledrejection",event=>window.__chatErrors.push(String(event.reason)));true')
    await wait(() => driver.evaluate("!document.getElementById('licenseGate')||document.getElementById('licenseGate').classList.contains('hidden')"), 'license gate closed')
    await driver.evaluate('document.getElementById("newSession").click();true')
    await wait(() => driver.evaluate('!!currentSession()'), 'ordinary session')
    await driver.evaluate('setInputContent("我想开始今天的锻炼");document.getElementById("send").click();true')
    await wait(() => firstTurnIndexes.length > 0, 'ordinary task reaches the first model request')
    assert(firstTurnIndexes[0].candidate && firstTurnIndexes[0].candidate.id === exercise.id, 'first request already contains the relevant live workflow without a user library hint or catalog round trip')
    await wait(() => driver.evaluate('!currentRunning()&&!!document.querySelector("#messages .workflow-suggestion-start")'), 'non-coding task produces an actionable recommendation')
    assert.strictEqual((await request('GET', base + '/api/workflows')).runs.length, 0, 'automatic discovery must not start a workflow')
    const buttonStyle = () => driver.evaluate('(()=>{const button=document.querySelector("#messages .workflow-suggestion-start"),style=getComputedStyle(button);return {color:style.color,background:style.backgroundColor,opacity:Number(style.opacity),parent:getComputedStyle(button.closest(".workflow-suggestion")).backgroundColor,cursor:style.cursor,hover:button.matches(":hover")}})()')
    const contrast = style => {
      const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number)
      const parent = rgb(style.parent), blend = color => rgb(color).map((value, index) => (value * style.opacity + parent[index] * (1 - style.opacity)) / 255)
      const luminance = color => color.map(value => value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4)).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const levels = [luminance(blend(style.color)), luminance(blend(style.background))].sort((a, b) => b - a)
      return (levels[0] + .05) / (levels[1] + .05)
    }
    for (const theme of ['dark', 'light']) {
      await driver.evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme) + ';true')
      await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
      await sleep(180)
      const normal = await buttonStyle(), box = await driver.centerOf('#messages .workflow-suggestion-start')
      assert(contrast(normal) >= 4.5, 'normal recommendation action has readable contrast in ' + theme)
      await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
      await sleep(180)
      const hover = await buttonStyle()
      assert(hover.hover, 'real pointer activates the hover state')
      assert.strictEqual(hover.color, normal.color)
      assert.strictEqual(hover.background, normal.background, 'global hover styling must not replace the primary action background')
      assert(contrast(hover) >= 4.5, 'hover recommendation action has readable contrast in ' + theme)
      fs.writeFileSync(path.join(root, 'release/validation/workflow-suggestion-hover-' + theme + '.png'), Buffer.from(await driver.screenshot(), 'base64'))
      await driver.evaluate('document.querySelector("#messages .workflow-suggestion-start").disabled=true;true')
      assert.strictEqual((await buttonStyle()).cursor, 'not-allowed', 'pending action keeps its disabled cursor')
      await driver.evaluate('document.querySelector("#messages .workflow-suggestion-start").disabled=false;true')
      await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
      let focused = false
      for (let i = 0; i < 80; i++) {
        await driver.keypress('Tab')
        focused = await driver.evaluate('document.activeElement===document.querySelector("#messages .workflow-suggestion-start")')
        if (focused) break
      }
      assert(focused, 'recommendation action is reachable with Tab')
      assert(await driver.evaluate('(()=>{const button=document.activeElement;return button.matches(":focus-visible")&&getComputedStyle(button).outlineStyle!=="none"})()'), 'keyboard focus remains visible in ' + theme)
    }
    await driver.evaluate('document.getElementById("newSession").click();true')
    const ordinaryId = await driver.evaluate('currentSession().id')
    await driver.evaluate('setInputContent("我要写周报");document.getElementById("send").click();true')
    await wait(() => driver.evaluate('!currentRunning()&&!!document.querySelector("#messages .workflow-suggestion-start")'), 'real tool recommendation')
    assert.strictEqual((await request('GET', base + '/api/workflows')).runs.length, 0, 'recommending must not execute')
    assert(await driver.evaluate('(()=>{const card=document.querySelector("#messages .workflow-suggestion");return !card.closest("details")&&card.textContent.includes("周报汇总")&&card.textContent.includes("v1")&&card.getBoundingClientRect().width>0})()'), 'card is visible outside collapsed process history')
    await driver.evaluate('document.getElementById("newSession").click();true'); await driver.evaluate('selectSession(' + JSON.stringify(ordinaryId) + ')', { awaitPromise: true })
    assert(await driver.evaluate('!!document.querySelector("#messages .workflow-suggestion-start")&&!document.querySelector("#messages .workflow-suggestion").closest("details")'), 'authoritative tool messages restore the actionable card')
    const sessionsBeforeStart = await driver.evaluate('Object.values(sessionStore).flat().length')
    assert(await driver.evaluate('!document.querySelector("#messages .workflow-suggestion-reason")&&!!document.querySelector("#messages .workflow-suggestion-panel")'), 'a compact card keeps its optional workflow panel action without repeating the explanation')
    await driver.click('#messages .workflow-suggestion-start')
    await wait(() => driver.evaluate('!!document.querySelector("#messages .workflow-current-task [data-schema-field=notes]")'), 'manual form appears directly in the originating conversation')
    assert.strictEqual(await driver.evaluate('currentSession().id'), ordinaryId)
    assert.strictEqual(await driver.evaluate('Object.values(sessionStore).flat().length'), sessionsBeforeStart, 'starting in chat never creates a separate execution conversation')
    assert(await driver.evaluate('document.getElementById("workflowPage").classList.contains("hidden")&&document.getElementById("workflowChatContext").classList.contains("hidden")'), 'starting does not force panel navigation or show a duplicate composer banner')
    const run = (await request('GET', base + '/api/workflows')).runs[0]
    const runSessionId = ordinaryId
    const detail = () => request('POST', base + '/api/workflows/detail', { id: run.id })
    await driver.click('#messages .workflow-suggestion-start')
    assert.strictEqual((await request('GET', base + '/api/workflows')).runs.length, 1, 'repeated startup clicks return to the existing active run')
    await driver.click('#messages .workflow-suggestion-panel')
    await wait(() => driver.evaluate('!document.getElementById("workflowPage").classList.contains("hidden")&&!!document.querySelector("#workflowRunDetail [data-schema-field=notes]")'), 'the workflow panel opens only when requested')
    await driver.evaluate('document.querySelector("#workflowRunDetail [data-schema-field=notes]").value="工作台的未提交草稿";true')
    await driver.click('#workflowRunDetail .workflow-analyze-action')
    await wait(() => driver.evaluate('!!document.querySelector("#messages .workflow-current-task [data-schema-field=notes]")'), 'panel returns to the originating conversation')
    assert.strictEqual(await driver.evaluate('currentSession().id'), runSessionId)
    await wait(() => driver.evaluate('!document.querySelector("[data-session-id=' + runSessionId + '] .session-unread")'), 'displaying the conversation automatically acknowledges its workflow records')
    for (const theme of ['dark', 'light']) {
      await driver.evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme) + ';true')
      assert(await driver.evaluate('(()=>{const card=document.querySelector(".workflow-execution-chat");return card.scrollWidth<=card.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()'), 'execution chat fits in ' + theme)
      fs.writeFileSync(path.join(root, 'release/validation/workflow-chat-' + theme + '.png'), Buffer.from(await driver.screenshot(), 'base64'))
    }
    await driver.evaluate('document.getElementById("newSession").click();true')
    const awayId = await driver.evaluate('currentSession().id')
    assert(await driver.evaluate('!workflowChat.hasRuns(currentSession())&&!currentSession().workflowReference'), 'new ordinary chat must not reuse a workflow-bound conversation')
    await driver.evaluate('selectSession(' + JSON.stringify(runSessionId) + ')', { awaitPromise: true })
    await wait(() => driver.evaluate('!!document.querySelector("#messages [data-schema-field=notes]")'), 'return to the pending form')
    await driver.evaluate('document.querySelector("#messages [data-schema-field=notes]").value="已完成接口联调";document.querySelector("#messages .workflow-execution-chat header button").click();true')
    await wait(() => driver.evaluate('!document.getElementById("workflowPage").classList.contains("hidden")&&!!document.querySelector("#workflowRunDetail [data-schema-field=notes]")'), 'return to original run interface')
    assert.strictEqual(await driver.evaluate('document.querySelector("#workflowRunDetail [data-schema-field=notes]").value'), '工作台的未提交草稿', 'execution chat must not move or replace the workbench form')
    await driver.click('#workflowRunDetail .workflow-analyze-action')
    await wait(() => driver.evaluate('!document.getElementById("contentFrame").classList.contains("hidden")&&!!document.querySelector("#messages [data-schema-field=notes]")'), 'return to execution chat')
    assert.strictEqual(await driver.evaluate('document.querySelector("#messages [data-schema-field=notes]").value'), '已完成接口联调', 'returning from the workbench preserves the current chat draft')
    await request('POST', base + '/api/workflows/save', { ...flow, description: '无关元信息更新' })
    await driver.evaluate('workflowChat.syncRuns()', { awaitPromise: true })
    assert.strictEqual(await driver.evaluate('document.querySelector("#messages [data-schema-field=notes]").value'), '已完成接口联调', 'unrelated workflow events must not erase form input')
    const firstTask = (await detail()).steps.find(step => step.id === 'h')
    await driver.evaluate('(()=>{const file=document.querySelector("#messages input[type=file]"),transfer=new DataTransfer();transfer.items.add(new File(["已核实的工作素材"],"素材.md",{type:"text/markdown"}));file.files=transfer.files;file.dispatchEvent(new Event("change"));document.querySelector("#messages .workflow-current-task form").requestSubmit();return true})()')
    await driver.evaluate('selectSession(' + JSON.stringify(awayId) + ')', { awaitPromise: true })
    await wait(async () => (await detail()).steps.some(step => step.id === 'r' && step.status === 'waiting'), 'original workflow continues to review')
    await wait(() => driver.evaluate('!!document.querySelector("[data-session-id=' + runSessionId + '] .session-unread")'), 'next human task marks its own conversation unread')
    await assert.rejects(request('POST', base + '/api/workflows/submit', { id: run.id, nodeId: 'h', taskId: firstTask.taskId, values: { notes: '重复提交' }, decision: 'confirm' }), /已处理|过期/, 'obsolete task ids cannot submit twice')
    await driver.evaluate('selectSession(' + JSON.stringify(runSessionId) + ')', { awaitPromise: true })
    await wait(() => driver.evaluate('!!document.querySelector("#messages input[value=reject]")'), 'review task in same conversation')
    await driver.evaluate('(()=>{const session=currentSession(),ref=session.workflowRuns[0];session.workflowRunId=ref.runId;session.workflowReadSequence=ref.readSequence;session.workflowReference={workflowId:ref.workflowId,runId:ref.runId,name:ref.name};delete session.workflowRuns;saveSessionStore();return true})()')
    await driver.evaluate('flushUiStorePush()', { awaitPromise: true })
    await driver.evaluate('location.reload();true')
    await wait(() => driver.evaluate('!!window.workflowChat&&currentSession()&&currentSession().id===' + JSON.stringify(runSessionId) + '&&!!document.querySelector("#messages input[value=reject]")'), 'old execution-conversation references still restore their real pending task')
    await driver.evaluate('(()=>{const radio=document.querySelector("#messages input[value=reject]");radio.checked=true;radio.dispatchEvent(new Event("change"));const reason=document.querySelector("#messages .workflow-decision textarea");reason.value="请补充验收结论";document.querySelector("#messages .workflow-current-task form").requestSubmit();return true})()')
    await wait(() => driver.evaluate('!!document.querySelector("#messages [data-schema-field=notes]")'), 'rejection returns to the original human node')
    const returnedTask = (await detail()).steps.find(step => step.id === 'h')
    assert.notStrictEqual(returnedTask.taskId, firstTask.taskId, 'rejection creates a new task identity')
    assert(await driver.evaluate('document.querySelector("#messages .workflow-reused-files").textContent.includes("素材.md")'), 'uploaded files remain reusable after rejection')
    await driver.evaluate('document.querySelector("#messages [data-schema-field=notes]").value="已完成接口联调与验收";document.querySelector("#messages .workflow-current-task form").requestSubmit();true')
    await wait(() => driver.evaluate('!!document.querySelector("#messages input[value=approve]")'), 'resubmitted work returns to review')
    await driver.evaluate('document.querySelector("#messages .workflow-current-task form").requestSubmit();true')
    await wait(async () => (await detail()).status === 'succeeded', 'human approval resumes and completes the workflow')
    await wait(() => driver.evaluate('!document.querySelector("#messages .workflow-current-task form")&&!!document.querySelector("#messages .workflow-artifact-item")'), 'completed conversation has artifacts and no stale form')
    assert.strictEqual(await driver.evaluate('Object.values(sessionStore).flat().filter(session=>(session.workflowRuns||[]).some(ref=>ref.runId===' + JSON.stringify(run.id) + ')).length'), 1, 'the original conversation keeps the run binding across tasks and refresh')
    const done = await detail(); assert.strictEqual(done.steps.find(step => step.id === 'h').data.notes, '已完成接口联调与验收')
    await driver.evaluate('document.querySelector("#messages .workflow-artifact-item button").click();true')
    await wait(() => driver.evaluate('!!document.querySelector(".workflow-artifact-dialog[open]")'), 'shared artifact preview in chat')
    await driver.evaluate('document.querySelector(".workflow-artifact-dialog").close();true')
    const sessionsBeforeRestart = await driver.evaluate('Object.values(sessionStore).flat().length')
    await driver.click('#messages .workflow-suggestion-start')
    await wait(async () => (await request('GET', base + '/api/workflows')).runs.length === 2, 'restart creates a new instance in the same conversation')
    const stopped = (await request('GET', base + '/api/workflows')).runs.find(item => item.id !== run.id)
    const stoppedSelector = '#messages [data-run-id="' + stopped.id + '"]'
    await wait(() => driver.evaluate('!!document.querySelector(' + JSON.stringify(stoppedSelector + ' [data-schema-field=notes]') + ')'), 'second run form appears alongside the previous result')
    assert.strictEqual(await driver.evaluate('currentSession().id'), runSessionId)
    assert.strictEqual(await driver.evaluate('Object.values(sessionStore).flat().length'), sessionsBeforeRestart, 'another run does not create a new conversation')
    assert.strictEqual(await driver.evaluate('currentSession().workflowRuns.length'), 2, 'multiple real run references remain attached without copying execution facts')
    await request('POST', base + '/api/workflows/stop', { id: stopped.id })
    await wait(() => driver.evaluate('!document.querySelector(' + JSON.stringify(stoppedSelector + ' .workflow-current-task form') + ')&&document.querySelector(' + JSON.stringify(stoppedSelector + ' .workflow-chat-status') + ').textContent.includes("已停止")'), 'external stop invalidates only that instance form')
    await driver.evaluate('selectSession(' + JSON.stringify(ordinaryId) + ')', { awaitPromise: true })
    await driver.evaluate('setInputContent("后台回复验证");document.getElementById("send").click();true')
    await wait(() => typeof backgroundReply === 'function', 'background model request arrives')
    await wait(() => driver.evaluate('currentRunning()'), 'pending background chat reconciles with the host')
    await driver.evaluate('document.getElementById("newSession").click();true')
    backgroundReply()
    await wait(() => driver.evaluate('!!document.querySelector("[data-session-id=' + ordinaryId + '] .session-unread")'), 'the first background reply chunk marks the original conversation unread before completion')
    assert(await driver.evaluate('isSessionRunning(' + JSON.stringify(ordinaryId) + ')'), 'unread does not wait for the whole turn to finish')
    await driver.evaluate('flushUiStorePush()', { awaitPromise: true }); await driver.evaluate('location.reload();true')
    await wait(() => driver.evaluate('!!document.querySelector("[data-session-id=' + ordinaryId + '] .session-unread")'), 'streaming unread receipt survives reload')
    finishBackgroundReply()
    await wait(() => driver.evaluate('!isSessionRunning(' + JSON.stringify(ordinaryId) + ')'), 'background turn completes')
    assert(await driver.evaluate('!!document.querySelector("[data-session-id=' + ordinaryId + '] .session-unread")'), 'background completion does not acknowledge unread content')
    await driver.click('[data-session-id="' + ordinaryId + '"]')
    await wait(() => driver.evaluate('document.getElementById("messages").textContent.includes("后台回复验证已完成")&&!document.querySelector("[data-session-id=' + ordinaryId + '] .session-unread")'), 'opening the actual conversation shows the reply and automatically clears unread')
    assert.strictEqual(requests, 5, 'both recommendations use only the tool/result round trip; manual workflow interactions never trigger hidden model requests')
    assert.strictEqual(firstTurnIndexes.length, 2)
    assert.strictEqual(firstTurnIndexes[1].candidate.id, flow.id)
    console.log('Workflow chat e2e passed: first-request discovery, compact recommendation with optional panel, start/forms in the originating chat without new conversations, repeat-click reuse, multiple runs, legacy references, dark/light hover/focus, submission/review/rejection, reload, artifacts, stop and streaming background unread with automatic acknowledgement; Chromium108')
  } catch (error) {
    console.error(logs.slice(-1200))
    try { console.error(await driver.evaluate('document.getElementById("messages").innerText.slice(-2500)')); fs.writeFileSync(path.join(root, 'release/validation/workflow-chat-failure.png'), Buffer.from(await driver.screenshot(), 'base64')) } catch (_) {}
    throw error
  } finally {
    await driver.close(); await driver.finishClose()
    if (service) { service.kill('SIGTERM'); await wait(() => service.exitCode !== null || service.signalCode !== null, 'service shutdown') }
    await new Promise(resolve => model.close(resolve)); fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
