'use strict'

// Launch the compiled Mac application with isolated data and an obsolete service.
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const net = require('net')
const assert = require('assert')
const { spawn } = require('child_process')
const { MiniWebSocket, CdpSession, httpGetJson } = require('../src/main/agent/cdp-client')
const { uiBuild } = require('../src/main/agent/ui-build')
const { TITLEBAR_HEIGHT } = require('../shell/window-chrome')
const ROOT = path.resolve(__dirname, '..')
const version = require('../package.json').version
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const s = net.createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  return port
}
async function run() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-package-ui-')))
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const bundle = path.resolve(process.argv[2] || path.join(ROOT, 'release/desktop/Agent-mac-' + process.arch + '/Agent.app'))
  const debug = await freePort()
  const stale = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, app: 'dsh-agent-service', version: '0.1.0', pid: process.pid }))
  })
  await new Promise((resolve) => stale.listen(0, '127.0.0.1', resolve))
  const stalePort = stale.address().port
  const model = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const messages = JSON.parse(raw).messages
      let lastUser = messages.length - 1
      while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser -= 1
      const result = messages.slice(lastUser + 1).find(message => message.role === 'tool')
      const delta = result ? { content: '当前工作目录验收：\n' + result.content } : {
        tool_calls: [{ index: 0, id: 'workspace_pwd', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'pwd' }) } }]
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: result ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const home = path.join(dir, 'agent-home')
  const recentWorkspace = path.join(home, 'workspace')
  fs.mkdirSync(home)
  const projectSettings = {
    workspacePath: workspace, recentWorkspacePath: workspace,
    projects: [{ id: 'package_project', name: '打包验收项目', folders: [workspace] }], currentProjectId: 'package_project',
    models: [{ id: 'workspace_mock', name: '隔离目录验收', baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'test', model: 'workspace_mock' }],
    currentModelId: 'workspace_mock', contextAutoCompress: false
  }
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(projectSettings))
  fs.writeFileSync(path.join(home, 'ui-store.json'), JSON.stringify({
    currentSessionId: 'legacy_recent',
    sessions: {
      __recent__: [{ id: 'legacy_recent', scope: 'recent', projectId: '', title: '旧普通会话', workspacePath: workspace, messages: [{ role: 'user', content: '历史消息' }] }],
      package_project: [{ id: 'package_project_session', scope: 'project', projectId: 'package_project', title: '项目验收会话', workspacePath: workspace, messages: [] }]
    }
  }))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'local', lastPort: stalePort, theme: 'dark' }))
  const log = fs.openSync(path.join(dir, 'app.log'), 'w')
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const flags = process.env.SMOKE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []
  const child = spawn(path.join(bundle, 'Contents/MacOS/Electron'), flags.concat(['--user-data-dir=' + dir, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debug]), { env, stdio: ['ignore', log, log] })
  let ws
  try {
    let target
    for (let i = 0; i < 120; i += 1) {
      try { target = (await httpGetJson('127.0.0.1', debug, '/json/list', 1000)).find((t) => t.type === 'page' && /^http:/.test(t.url)) } catch (error) {}
      if (target) break
      if (child.exitCode !== null) throw new Error('Package exited: ' + fs.readFileSync(path.join(dir, 'app.log'), 'utf8').slice(-2000))
      await delay(250)
    }
    assert(target, 'compiled app must reach service renderer')
    const url = new URL(target.url)
    assert.notStrictEqual(Number(url.port), stalePort, 'must skip obsolete service')
    const health = await httpGetJson('127.0.0.1', Number(url.port), '/api/health')
    assert.strictEqual(health.version, version)
    assert.strictEqual(health.uiBuild, uiBuild(path.join(bundle, 'Contents/Resources/app/src/renderer')))
    assert.strictEqual(health.agentHome, path.join(dir, 'agent-home'))
    ws = new MiniWebSocket()
    const socket = new URL(target.webSocketDebuggerUrl)
    await ws.connect(socket.hostname, Number(socket.port), socket.pathname)
    const cdp = new CdpSession(ws)
    async function evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    async function picture(file) {
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))')
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 90000)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    }
    await delay(1500)
    assert(await evaluate('navigator.userAgent.includes("Chrome/108.")'), 'packaged browser must use Chromium 108')
    const results = []
    assert(await evaluate("document.getElementById('pageShare').hidden && getComputedStyle(document.getElementById('pageShare')).display==='none'"), 'browser shortcut must be hidden')
    for (const theme of ['dark', 'light']) {
      await evaluate('document.documentElement.setAttribute("data-theme",' + JSON.stringify(theme) + ')')
      await delay(200)
      const style = await evaluate(`(() => { const t=document.querySelector('#titlebarDrag'), b=document.querySelector('#newSession'); return { theme:document.documentElement.dataset.theme, bg:getComputedStyle(document.body).backgroundColor, button:getComputedStyle(b).backgroundColor, gradient:getComputedStyle(b).backgroundImage, titlebarHeight:t.getBoundingClientRect().height, independent:t.parentElement===document.body }; })()`)
      assert.strictEqual(style.bg, theme === 'dark' ? 'rgb(33, 33, 33)' : 'rgb(255, 255, 255)')
      assert.strictEqual(style.gradient, 'none')
      assert.strictEqual(style.titlebarHeight, TITLEBAR_HEIGHT)
      assert(style.independent)
      fs.mkdirSync(path.join(ROOT, 'release/validation'), { recursive: true })
      await picture(path.join(ROOT, 'release/validation/packaged-' + theme + '.png'))
      results.push(style)
    }
    await evaluate("Array.from(document.querySelectorAll('#licenseGate button')).find(button=>button.textContent==='试用1天').click()")
    let unlocked = false
    for (let i = 0; i < 80; i += 1) {
      unlocked = await evaluate('window.licensingUI && !window.licensingUI.isLocked()')
      if (unlocked) break
      await delay(150)
    }
    assert(unlocked, 'isolated package must unlock its one-time trial')
    const restored = await evaluate('window.dsh.getState().then(value=>({workspacePath:value.workspacePath,recentWorkspacePath:value.settings.recentWorkspacePath,currentProjectId:value.settings.currentProjectId}))')
    assert.strictEqual(restored.recentWorkspacePath, recentWorkspace, 'startup must repair the contaminated recent default')
    assert.strictEqual(restored.workspacePath, recentWorkspace, 'restoring a legacy recent session must not restore its project directory')
    assert.strictEqual(restored.currentProjectId, '', 'restored ordinary conversation must not select a project')
    const saveStatus = await evaluate('window.fetch("/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(' + JSON.stringify({ workspacePath: workspace, currentProjectId: 'package_project' }) + ')})'
      + '.then(function(response){return response.status})')
    assert.strictEqual(saveStatus, 200, 'package must persist the isolated project settings')
    await evaluate('location.reload(); "reload"')
    let projectReady = false
    for (let i = 0; i < 80; i += 1) {
      projectReady = await evaluate('window.licensingUI && !window.licensingUI.isLocked() && !!document.querySelector("#projectList .project-more")')
      if (projectReady) break
      await delay(150)
    }
    assert(projectReady, 'package must render the isolated project')
    assert.strictEqual(await evaluate('typeof window.dsh.memoryRequest'), 'function', 'packaged client must expose memory management')
    assert.strictEqual(await evaluate('window.dsh.memoryRequest("list",{}).then(value=>Array.isArray(value.items))'), true, 'packaged memory API must be reachable')
    assert.strictEqual(await evaluate('!!document.querySelector("[data-settings-tab=memory]")'), true, 'packaged settings must expose the memory tab')
    await evaluate('document.querySelector("#projectList [data-session-id=package_project_session]").click(); true')
    for (let i = 0; i < 80; i += 1) {
      if (await evaluate('document.getElementById("sessionAssociationLabel").textContent==="项目会话"')) break
      await delay(100)
    }
    await evaluate('document.getElementById("newSession").click(); true')
    let ordinary
    for (let i = 0; i < 80; i += 1) {
      ordinary = await evaluate('window.dsh.uiStoreGet().then(value=>(value.store.sessions.__recent__||[]).find(session=>session.id===value.store.currentSessionId))')
      if (ordinary && ordinary.id !== 'legacy_recent') break
      await delay(100)
    }
    assert(ordinary && ordinary.id !== 'legacy_recent', 'new ordinary conversation must not reuse an empty project conversation')
    assert.strictEqual(ordinary.scope, 'recent')
    assert.strictEqual(ordinary.projectId, '')
    assert.strictEqual(ordinary.workspacePath, recentWorkspace, 'new ordinary conversation must use the repaired directory')
    async function directoryTurn(sessionId, expected) {
      await evaluate('document.getElementById("input").textContent="当前工作目录是"; document.getElementById("input").dispatchEvent(new Event("input",{bubbles:true})); document.getElementById("send").click(); true')
      let snapshot
      for (let i = 0; i < 600; i += 1) {
        await evaluate('(()=>{const modal=document.getElementById("approvalModal");if(modal.classList.contains("hidden"))return;const signature=document.getElementById("approvalSignature").textContent,detail=document.getElementById("approvalDetail").textContent.trim();if(signature!=="command:pwd"||detail!=="cwd=.\\npwd")throw Error("Unexpected isolated command approval");document.getElementById("approvalOnce").click()})()')
        try { snapshot = JSON.parse(fs.readFileSync(path.join(home, 'sessions', sessionId, 'last-session.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (snapshot && snapshot.execution.status === 'completed') break
        await delay(100)
      }
      if (!snapshot || snapshot.execution.status !== 'completed') {
        await picture(path.join(ROOT, 'release/validation/packaged-workspace-failure.png'))
        const visible = await evaluate('document.getElementById("messages").innerText')
        throw new Error('directory turn must complete through the real Agent: ' + String(visible).slice(-2000))
      }
      const tool = snapshot.messages.filter(message => message.role === 'tool').pop()
      assert(tool && String(tool.content).includes('exitCode=0\n' + expected + '\n'), 'actual command cwd must be ' + expected)
      assert(snapshot.messages.find(message => message.role === 'system').content.includes(expected), 'system prompt must agree with the actual cwd')
      for (let i = 0; i < 80; i += 1) {
        if (await evaluate('document.getElementById("messages").textContent.includes(' + JSON.stringify(expected) + ')')) return
        await delay(100)
      }
      throw new Error('command result must be visible in the actual conversation')
    }
    await directoryTurn(ordinary.id, recentWorkspace)
    await picture(path.join(ROOT, 'release/validation/packaged-ordinary-workspace.png'))
    await evaluate('document.querySelector("#projectList [data-session-id=package_project_session]").click(); true')
    await directoryTurn('package_project_session', workspace)
    const workspaceIsolation = { legacyRestored: true, ordinaryWorkspace: recentWorkspace, projectWorkspace: workspace, actualCommands: 2 }
    const projectFolderAction = JSON.parse(String(await evaluate(
      '(function(){'
      + 'var more=document.querySelector("#projectList .project-more");if(!more)return JSON.stringify({error:"missing-more"});more.click();'
      + 'var edit=document.getElementById("projectMenuEdit");if(!edit)return JSON.stringify({error:"missing-edit"});edit.click();'
      + 'var open=document.querySelector("#projectFolderList .folder-open");'
      + 'return JSON.stringify({label:open&&open.textContent,aria:open&&open.getAttribute("aria-label"),desktop:window.dsh.isDesktop,modalOpen:!document.getElementById("projectModal").classList.contains("hidden")});'
      + '})()'
    )))
    assert.strictEqual(projectFolderAction.label, '打开')
    assert.strictEqual(projectFolderAction.aria, '打开目录：' + workspace)
    assert.strictEqual(projectFolderAction.desktop, true)
    assert.strictEqual(projectFolderAction.modalOpen, true)
    assert.strictEqual(await evaluate('(function(){var open=document.querySelector("#projectFolderList .folder-open");open.focus();return document.activeElement===open})()'), true)
    await evaluate('document.documentElement.setAttribute("data-theme","dark")')
    await delay(150)
    await picture(path.join(ROOT, 'release/validation/packaged-project-folder.png'))
    await evaluate('document.documentElement.setAttribute("data-theme","light")')
    await delay(150)
    await picture(path.join(ROOT, 'release/validation/packaged-project-folder-light.png'))
    // The real compiled application must also serve and render the protected
    // declarative UI bundle and its lazy offline Cesium asset from local files.
    const business = fs.readFileSync(path.join(ROOT, 'examples/generative-ui/business.surface.json'), 'utf8')
    const generative = JSON.parse(String(await evaluate(`(async()=>{
      const controller = window.createGenerativeUIChat({ sessionId: () => 'package_ui', messages: () => [], theme: () => 'light' })
      const capabilities = await controller.capabilities()
      const assets = await Promise.all(['vendor/generative-ui/agent-ui-cesium.js','vendor/generative-ui/Assets/IAU2006_XYS/IAU2006_XYS_18.json'].map(async path => {
        const response = await window.fetch(path); return [path, response.status, (await response.arrayBuffer()).byteLength]
      }))
      document.getElementById('projectModal').classList.add('hidden')
      const host = document.createElement('div'); host.id = 'packageGuiHost'; host.style.cssText = 'position:fixed;inset:24px;z-index:9999;overflow:auto;background:var(--bg);padding:20px;border-radius:14px'; document.body.appendChild(host)
      window.__packageGui = window.AgentGenerativeUI.mountSurface(host, { sessionId: 'package_ui', surface: ${business}, theme: 'light' })
      for (let i = 0; i < 240 && (!host.querySelector('.gui-map canvas') || !host.querySelector('.gui-visual iframe[data-loaded=true]')); i++) await new Promise(resolve => setTimeout(resolve, 50))
      const backend = host.querySelector('.gui-map') && host.querySelector('.gui-map').getAttribute('data-map-backend')
      const select = host.querySelector('.gui-filter select'); select.value = '华东'; select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 50))
      return JSON.stringify({ capabilities, assets, backend,
        rows: host.querySelectorAll('.gui-table tbody tr').length,
        progress: host.querySelector('.gui-progress progress') && Number(host.querySelector('.gui-progress progress').value),
        flow: host.querySelectorAll('.gui-flow-nodes button').length,
        visual: !!host.querySelector('.gui-visual iframe[data-loaded=true]'),
        visualSandbox: host.querySelector('.gui-visual iframe') && host.querySelector('.gui-visual iframe').getAttribute('sandbox'),
        mapButtons: host.querySelectorAll('.gui-map-location').length,
        text: host.textContent.includes('<img src=x'), executed: Boolean(window.__unexpectedExecution) })
    })()`)))
    assert(generative.capabilities && generative.capabilities.versions.includes(2) && generative.capabilities.components.includes('map') && generative.capabilities.components.includes('visual'), 'package renderer must advertise v2 capabilities')
    for (const [asset, status, size] of generative.assets) assert.strictEqual(status, 200, 'package must serve ' + asset)
    assert.strictEqual(generative.backend, 'cesium', 'packaged offline map must use real Cesium')
    assert.strictEqual(generative.rows, 2, 'packaged filter must update the table')
    assert.strictEqual(generative.progress, 25)
    assert.strictEqual(generative.flow, 3)
    assert.strictEqual(generative.mapButtons, 2)
    assert.strictEqual(generative.visual, true, 'packaged static visual must load inside its sandbox')
    assert.strictEqual(generative.visualSandbox, '', 'packaged visual iframe must have an empty sandbox')
    assert.strictEqual(generative.text, true, 'packaged renderer must show untrusted text as escaped content')
    assert.strictEqual(generative.executed, false, 'packaged renderer must not execute untrusted text')
    const markdownDetails = String(await evaluate('window.renderMarkdown("<details>\\n<summary>更多</summary>\\n\\n|名称|值|\\n|---|---|\\n|甲|1|\\n\\n</details>")'))
    assert(markdownDetails.includes('<details class="md-details">') && markdownDetails.includes('<summary>更多</summary>') && markdownDetails.includes('<table>'), 'packaged Markdown must render safe details instead of tag source')
    assert(!markdownDetails.includes('&lt;details'), 'packaged Markdown must not expose raw details tags')
    for (const theme of ['dark', 'light']) {
      await evaluate('applyTheme(' + JSON.stringify(theme) + '); true')
      await delay(150)
      await picture(path.join(ROOT, 'release/validation/packaged-generative-' + theme + '.png'))
    }
    await evaluate('window.__packageGui && window.__packageGui.dispose(); document.getElementById("packageGuiHost").remove(); true').catch(() => {})
    fs.writeFileSync(path.join(ROOT, 'release/validation/packaged-ui.json'), JSON.stringify({ version, skippedObsoleteService: true, results, projectFolderAction, generative, workspaceIsolation }, null, 2))
    console.log('PASS compiled Mac app: isolated data, legacy recent recovery, actual ordinary/project command directories, obsolete service skipped, current build, independent titlebar, flat themes, project folder action, protected v2 UI, sandboxed static visual, safe Markdown details and offline Cesium')
  } finally {
    if (ws && ws.socket) ws.socket.destroy()
    child.kill('SIGTERM')
    await delay(1000)
    stale.close()
    model.close()
    fs.closeSync(log)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
