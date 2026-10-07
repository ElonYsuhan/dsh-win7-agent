'use strict'
/**
 * ui-e2e-smoke：真实界面（真 Electron / Chromium 108）端到端，走 CDP 驱动。
 *
 * 覆盖三条只有真机才看得出的路径：
 *  1. 点「切换模型」下拉 → #composerModelLabel 到底变没变
 *     （含「切回单模型供应商自己那个 model」那个早返回分支，以及刷新后是否落盘）
 *  2. 在界面里真的点发送 → 会话历史思考过程（processHtml）不能被清掉
 *  3. browser_close 之后验证窗口的进程是不是真的没了
 *
 * 不进默认 check 链（要开真窗口），与 check:drag / check:shellpage / check:browser 同级。
 * 跑法（本机 seatbelt 起不来，必须带 SMOKE_NO_SANDBOX=1）：
 *   SMOKE_NO_SANDBOX=1 node scripts/ui-e2e-smoke.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const { BrowserDriver } = require(path.join(ROOT, 'src/main/agent/browser-driver.js'))

const not = (v) => v ? false : true
let passed = 0
let failed = 0
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('PASS  ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 220) + ']' : '')) }
  else { failed += 1; console.log('FAIL  ' + name + '  [' + String(detail).slice(0, 300) + ']') }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')) })
  })
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length }
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronPath() {
  const txt = fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
  return path.join(ROOT, 'node_modules/electron/dist', txt)
}

async function main() {
  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-e2e-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-ws-'))
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), AGENT_HOME: home }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let logs = ''
  child.stdout.on('data', (c) => { logs += c.toString() })
  child.stderr.on('data', (c) => { logs += c.toString() })

  const base = 'http://127.0.0.1:' + port
  let up = false
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await get(base + '/api/health')
      if (res.status === 200) { up = true; break }
    } catch (e) { /* 还没起来 */ }
    await sleep(250)
  }
  ok('独立服务起来了（界面由服务托管）', up, 'port=' + port + ' | ' + logs.slice(-140))
  if (not(up)) { child.kill('SIGKILL'); process.exit(1) }

  const home1 = await get(base + '/')
  ok('服务托管主界面', home1.status === 200 && home1.body.indexOf('composerModelTrigger') !== -1, 'status=' + home1.status)

  const put = await post(base + '/api/settings', {
    models: [
      { id: 'p1', name: '供应商一', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm1', modelList: ['m1'] },
      { id: 'p2', name: '供应商二', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm2', modelList: ['m2'] }
    ],
    currentModelId: 'p1',
    workspacePath: workspace,
    projects: [{ id: 'project_x', name: 'E2E', folders: [workspace] }],
    currentProjectId: 'project_x'
  })
  ok('设置写入成功（两家供应商 + 工作区 + 项目）',
    put.status === 200 && put.body.indexOf('"currentModelId":"p1"') !== -1, 'status=' + put.status)

  const driver = new BrowserDriver({})
  let childPid = 0
  try {
    const launched = await driver.launch(base + '/', {
      electronPath: electronPath(), width: 1100, height: 800,
      noSandbox: process.env.SMOKE_NO_SANDBOX === '1'
    })
    childPid = driver.child ? driver.child.pid : 0
    ok('真机浏览器起来了（CDP 已连上）', driver.isOpen && launched.port > 0, JSON.stringify(launched))

    const evalJs = async (expr) => driver.evaluate(expr)
    const readLabel = async () => String(await evalJs('document.getElementById("composerModelLabel").textContent'))
    const openMenu = () => evalJs('document.getElementById("composerModelTrigger").click(); "ok"')
    const pickItem = (text) => evalJs(
      '(function(){var items=document.querySelectorAll("#composerModelMenu .dropdown-item");'
      + 'for(var i=0;i<items.length;i++){if(items[i].textContent.trim()===' + JSON.stringify(text) + '){items[i].click();return "clicked"}}return "not-found"})()'
    )

    let ready = false
    for (let i = 0; i < 40; i += 1) {
      const has = await evalJs('document.getElementById("composerModelLabel") !== null && document.querySelectorAll("#composerModelMenu .dropdown-item").length > 0')
      if (has === true) { ready = true; break }
      await sleep(300)
    }
    ok('界面加载完成（模型下拉里有两个供应商的条目）', ready, 'ready=' + ready)

    const label0 = await readLabel()
    ok('初始标签 = 当前 model（m1）', label0 === 'm1', label0)

    await openMenu()
    const c2 = await pickItem('m2')
    await sleep(700)
    const label1 = await readLabel()
    ok('切到 p2/m2 后标签变成 m2（用户报的「没切换成功」）',
      c2 === 'clicked' && label1 === 'm2', 'clicked=' + c2 + ' label=' + label1)

    const activeNow = await evalJs(
      '(function(){var out=[];var items=document.querySelectorAll("#composerModelMenu .dropdown-item");'
      + 'for(var i=0;i<items.length;i++){if(String(items[i].className).indexOf("active")!==-1)out.push(items[i].textContent.trim())}return out.join("|")})()'
    )
    ok('下拉里打勾的也跟到 m2', String(activeNow) === 'm2', String(activeNow))

    const c1 = await pickItem('m1')
    await sleep(700)
    const label2 = await readLabel()
    ok('切回 p1/m1（单模型供应商命中的早返回分支）标签也变回来',
      c1 === 'clicked' && label2 === 'm1', 'clicked=' + c1 + ' label=' + label2)

    await driver.open(base + '/')
    await sleep(1800)
    const label3 = await readLabel()
    ok('刷新后标签仍是 m1（切换真的落盘了）', label3 === 'm1', label3)

    /* ---- 思考过程：塞一条带历史过程的会话 → 刷新渲染 → 点发送 → 过程不许被清 ---- */
    const SEED = {
      project_x: [{
        id: 'sE2E', projectId: 'project_x', scope: 'project', title: 'e2e 会话',
        updatedAt: '2026-09-23T10:00:00.000Z',
        messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }],
        processHtml: '<div class="thinking-tool">第一轮痕迹</div><div class="thinking-turn-sep"></div><div class="thinking-tool">第二轮痕迹</div>'
      }]
    }
    await evalJs('localStorage.setItem("dsh-sessions-v1", ' + JSON.stringify(JSON.stringify(SEED)) + ');'
      + 'localStorage.setItem("dsh-current-session", "sE2E");'
      + 'localStorage.setItem("dsh-ui-store-stamp", String(Date.now())); "seeded"')
    await driver.open(base + '/')
    await sleep(1800)

    const rendered = await evalJs(
      '(function(){var b=document.querySelectorAll(".thinking-block");if(!b.length)return "no-block";'
      + 'var t="";for(var i=0;i<b.length;i++)t+=b[i].textContent;'
      + 'return t.indexOf("第一轮痕迹")!==-1 && t.indexOf("第二轮痕迹")!==-1 ? "both" : ("partial:"+t.slice(0,60))})()'
    )
    ok('真实界面里「思考过程」块把多轮过程都渲染出来了', String(rendered) === 'both', String(rendered))

    /* 界面里真的点发送（走 sendMessage → 旧实现会在这里把 processHtml 清空） */
    const before = await evalJs(
      '(function(){var s=JSON.parse(localStorage.getItem("dsh-sessions-v1"));return (s.project_x[0].processHtml||"").length})()'
    )
    await evalJs('document.getElementById("input").innerText = "再问一句"; "typed"')
    await evalJs('document.getElementById("send").click(); "sent"')
    await sleep(1500)
    const after = await evalJs(
      '(function(){var s=JSON.parse(localStorage.getItem("dsh-sessions-v1"));'
      + 'var sess=s.project_x[0];return JSON.stringify({len:(sess.processHtml||"").length, has1:(sess.processHtml||"").indexOf("第一轮痕迹")!==-1, has2:(sess.processHtml||"").indexOf("第二轮痕迹")!==-1, msgs:sess.messages.length})})()'
    )
    const parsed = JSON.parse(String(after))
    ok('在界面里点发送之后，历史思考过程没被清掉（旧实现 sendMessage 里整段清空）',
      parsed.has1 === true && parsed.has2 === true, 'before=' + before + ' after=' + String(after))

    const childAliveBefore = (function () { try { process.kill(childPid, 0); return true } catch (e) { return false } })()
    await driver.close()
    /* close() 是先 SIGTERM、3s 后才 SIGKILL 兜底，所以这里必须**轮询等它死**，
       固定 sleep 900ms 会偶发假红（Electron 退出快慢本来就不稳）。 */
    let aliveAfter = true
    let waitedMs = 0
    for (let i = 0; i < 30; i += 1) {
      try { process.kill(childPid, 0); aliveAfter = true } catch (e) { aliveAfter = false; break }
      await sleep(200)
      waitedMs += 200
    }
    ok('browser_close 真的把验证窗口关掉了（进程消失）',
      childAliveBefore === true && aliveAfter === false && driver.isOpen === false,
      'before=' + childAliveBefore + ' after=' + aliveAfter + ' isOpen=' + driver.isOpen
        + ' pid=' + childPid + ' waited=' + waitedMs + 'ms')
  } catch (error) {
    failed += 1
    console.log('FAIL  探针异常  [' + ((error && error.message) || String(error)) + ']')
    try { await driver.close() } catch (e) { /* 收摊 */ }
  }

  child.kill('SIGKILL')
  for (const dir of [home, workspace]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* 收摊 */ }
  }
  console.log('')
  console.log('ui e2e: ' + passed + '/' + (passed + failed) + ' checks passed')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ui e2e harness error: ' + ((error && error.stack) || error))
  process.exit(1)
})
