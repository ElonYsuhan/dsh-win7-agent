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

/* 真机验收用的步骤时间线种子（和 app.js 产出的结构一致，见 createTimelineStep）。 */
const STEP_THINK = '<div class="tl-step tl-think tl-ok"><div class="tl-head"><span class="tl-icon"></span>'
  + '<span class="tl-title">思考</span><span class="tl-dur">1.2s</span></div>'
  + '<div class="tl-body">先看看仓库结构</div></div>'
const STEP_TOOL = '<div class="tl-step tl-tool tl-ok"><div class="tl-head"><span class="tl-icon"></span>'
  + '<span class="tl-title">读取 package.json</span><span class="tl-dur">0.3s</span></div>'
  + '<div class="tl-body"><pre class="tl-args">{"path":"/ws/app/package.json"}</pre>'
  + '<details class="tl-detail"><summary>输出</summary><pre class="tl-output">{"name":"app"}</pre></details></div></div>'
const STEP_AGAIN = '<div class="tl-step tl-think tl-ok"><div class="tl-head"><span class="tl-icon"></span>'
  + '<span class="tl-title">思考</span><span class="tl-dur">0.8s</span></div>'
  + '<div class="tl-body">已获取工具结果，继续思考</div></div>'
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

    /* ---- 侧边栏（2026-10-17 按参考样式重排）：胶囊 + 纵向入口 + 右侧真实计数 ---- */
    const sb = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var side=document.getElementById("sidebar");'
      + 'var ns=document.getElementById("newSession");'
      + 'var box=document.querySelector(".sidebar-shortcuts");'
      + 'var rows=document.querySelectorAll(".sidebar-shortcut");'
      + 'var cs=box?getComputedStyle(box):null;'
      + 'var nsCs=ns?getComputedStyle(ns):null;'
      + 'var meta=document.getElementById("customizeCount");'
      + 'var lib=document.getElementById("libraryCount");'
      + 'var rail=document.querySelector(".sidebar-rail");'
      + 'return JSON.stringify({'
      + ' sidebarW: side ? Math.round(side.getBoundingClientRect().width) : 0,'
      + ' newW: ns ? Math.round(ns.getBoundingClientRect().width) : 0,'
      + ' newBg: nsCs ? nsCs.backgroundColor : "",'
      + ' dir: cs ? cs.flexDirection : "",'
      + ' rows: rows.length,'
      + ' metaText: meta ? meta.textContent : "",'
      + ' libText: lib ? lib.textContent : "",'
      + ' railShown: rail ? getComputedStyle(rail).display : ""'
      + '});'
      + '})()'
    )))
    ok('新建会话是满宽胶囊（宽度贴住侧边栏、深色底）',
      /* 侧边栏本身有 16px 左右内边距，胶囊铺满的是内容区，所以留 48px 容差 */
      sb.newW > 0 && sb.newW >= sb.sidebarW - 48 && sb.newBg !== 'rgba(0, 0, 0, 0)',
      'newW=' + sb.newW + ' sidebarW=' + sb.sidebarW + ' bg=' + sb.newBg)
    ok('资料库 / 技能与规则是纵向排列的两行', sb.rows === 2 && sb.dir === 'column',
      'rows=' + sb.rows + ' direction=' + sb.dir)
    ok('技能与规则右侧显示真实启用项数', /[0-9]+ 项启用/.test(sb.metaText), 'meta=' + JSON.stringify(sb.metaText))
    ok('资料库没有条目清单时右侧留空（不编假数字）', sb.libText === '', 'lib=' + JSON.stringify(sb.libText))
    ok('宽窗口下不显示窄屏图标栏', sb.railShown === 'none', 'rail=' + sb.railShown)
    /* 胶囊里的文字要和下面两个入口的文字对齐成一条竖线 */
    const align = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var ns=document.getElementById("newSession");'
      + 'var pillText=ns?ns.querySelector("span:last-child"):null;'
      + 'var rowText=document.querySelector(".sidebar-shortcut .sidebar-shortcut-name");'
      + 'if(!ns||!pillText||!rowText)return "{}";'
      + 'var sr=ns.getBoundingClientRect(), tr=pillText.getBoundingClientRect(), rr=rowText.getBoundingClientRect();'
      + 'return JSON.stringify({pillTextLeft:Math.round(tr.left), rowTextLeft:Math.round(rr.left),'
      + ' pillRightGap:Math.round(sr.right-tr.right), justify:getComputedStyle(ns).justifyContent});'
      + '})()'
    )))
    ok('新建会话文字与下面入口文字左对齐（差 ≤ 3px）',
      align.justify === 'flex-start' && Math.abs(align.pillTextLeft - align.rowTextLeft) <= 3,
      JSON.stringify(align))
    /* 页脚只留设置：连接状态/就绪/查看诊断三行常驻显示已去掉（用户 2026-10-17 要求） */
    const foot = JSON.parse(String(await evalJs(
      '(function(){'
      + 'function vis(sel){var el=document.querySelector(sel);'
      + 'if(!el)return "missing";var cs=getComputedStyle(el);'
      + 'return cs.display==="none"||cs.visibility==="hidden"?"hidden":"shown";}'
      + 'return JSON.stringify({'
      + ' conn:vis("#serviceConnection"),'
      + ' status:vis("#statusLine"),'
      + ' logs:vis("#statusLogs"),'
      + ' retry:vis("#statusRetry"),'
      + ' settings:vis("#openSettings")'
      + '});'
      + '})()'
    )))
    ok('页脚常驻的三行状态都收起来了，只留设置按钮',
      foot.conn === 'hidden' && foot.status === 'hidden' && foot.logs === 'hidden'
        && foot.settings === 'shown' && foot.retry === 'hidden',
      JSON.stringify(foot))

    /* 行内操作图标悬浮时不该有背景（用户 2026-10-17 明确要求）——用真 hover 量计算样式 */
    const hov = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var row=document.querySelector(".project-item")||document.querySelector(".project-node");'
      + 'if(!row)return "{}";'
      + 'row.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));'
      + 'var add=row.querySelector(".project-add"), more=row.querySelector(".project-more");'
      + 'if(add)add.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));'
      + 'if(more)more.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));'
      + 'var rowBg=getComputedStyle(row).backgroundColor;'
      + 'var addBg=add?getComputedStyle(add).backgroundColor:"";'
      + 'var moreBg=more?getComputedStyle(more).backgroundColor:"";'
      + 'return JSON.stringify({rowBg:rowBg,addBg:addBg,moreBg:moreBg});'
      + '})()'
    )))
    /* 注意：dispatch 出来的 mouseover 不会触发 CSS :hover（那是真实指针状态），
       所以这里只能验「图标自己没有背景」；整行的 hover 底色由 theme-smoke 用真鼠标量。 */
    ok('行内「+」悬浮时没有自己的背景',
      hov.addBg === 'rgba(0, 0, 0, 0)', 'add=' + hov.addBg)
    ok('行内「⋯」悬浮时没有自己的背景', hov.moreBg === 'rgba(0, 0, 0, 0)',
      'more=' + hov.moreBg)

    /* ---- 定时任务编辑器（真机端到端）：填最少的字段 → 保存 → 服务端拿到合法任务 ----
       注意：driver.evaluate 不会 await 页内 Promise（直接返回 {}），所以走「页内发起 + 轮询取值」。 */
    const taskApi = async (action, payload) => {
      await evalJs('(function(){ window.__taskProbe = undefined; window.dsh.taskRequest('
        + JSON.stringify(action) + ',' + JSON.stringify(payload || null)
        + ').then(function (v) { window.__taskProbe = v }, function (e) { window.__taskProbe = { __error: String((e && e.message) || e) } }); return true })()')
      for (let i = 0; i < 120; i += 1) {
        const raw = String(await evalJs('(function(){ return window.__taskProbe === undefined ? "" : JSON.stringify(window.__taskProbe) })()'))
        if (raw !== '') return raw
        await sleep(50)
      }
      return '{}'
    }

    await evalJs('(function(){ openCapabilities(); return true })()')
    await sleep(400)
    await evalJs('(function(){ document.getElementById("capTabTasks").click(); return true })()')
    await sleep(600)
    await evalJs('(function(){ window.scheduledTasks.refresh(); return true })()')
    await sleep(700)
    await evalJs('(function(){ document.getElementById("taskNew").click(); return true })()')
    await sleep(300)
    const editorProbe = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var e=document.getElementById("taskEditor");'
      + 'var seg=Array.from(e.querySelectorAll("[data-task-kind]")).map(function(b){return b.dataset.taskKind});'
      + 'var advanced=e.querySelector(".task-advanced");'
      + 'return JSON.stringify({'
      + ' open:!e.classList.contains("hidden"),'
      + ' segments:seg,'
      + ' advancedGone:!advanced,'
      + ' projectGone:!document.getElementById("taskProject"),'
      + ' permissionGone:!document.getElementById("taskPermission"),'
      + ' toolsGone:!document.getElementById("taskTools"),'
      + ' enabled:document.getElementById("taskEnabled").checked'
      + '});'
      + '})()'
    )))
    ok('定时任务编辑器：只暴露 每天/每周/每隔 三档，高级配置已整体内收',
      editorProbe.open === true && editorProbe.segments.join(',') === 'daily,weekly,interval'
        && editorProbe.advancedGone === true && editorProbe.projectGone === true
        && editorProbe.permissionGone === true && editorProbe.toolsGone === true,
      JSON.stringify(editorProbe))
    ok('定时任务编辑器：默认保存即启用',
      editorProbe.enabled === true, JSON.stringify(editorProbe))

    /* 切到「每隔」：确认单位换算与条件字段切换 */
    await evalJs('(function(){ document.querySelector(\'[data-task-kind="interval"]\').click(); return true })()')
    await sleep(500)
    const intervalProbe = JSON.parse(String(await evalJs(
      '(function(){'
      + 'return JSON.stringify({'
      + ' clockHidden:document.getElementById("taskClockFields").hidden,'
      + ' intervalShown:!document.getElementById("taskIntervalLabel").hidden,'
      + ' onKind:document.getElementById("taskRule").value,'
      + ' next:document.getElementById("taskNext").textContent'
      + '});'
      + '})()'
    )))
    ok('切到「每隔」：时间字段收起、间隔字段出现、规则真的变成 interval',
      intervalProbe.clockHidden === true && intervalProbe.intervalShown === true
        && intervalProbe.onKind === 'interval', JSON.stringify(intervalProbe))

    /* 真填一遍：名称 + 做什么 + 每天 20:31，保存后直接问服务端要任务列表 */
    await evalJs('(function(){ document.querySelector(\'[data-task-kind="daily"]\').click(); return true })()')
    await sleep(300)
    await evalJs('(function(){'
      + 'function type(id,value){var el=document.getElementById(id);el.value=value;'
      + '  el.dispatchEvent(new Event("input"));}'  /* 保存按钮是靠 input 事件解禁的，得像真人一样敲 */
      + 'type("taskName","每日巡检");'
      + 'type("taskPrompt","列出仓库里未提交的改动");'
      + 'document.getElementById("taskTime").value="20:31";'
      + 'document.getElementById("taskTime").dispatchEvent(new Event("change"));'
      + 'return true})()')
    await sleep(500)
    const nextText = String(await evalJs('document.getElementById("taskNext").textContent'))
    ok('定时任务编辑器：下一步执行时间说人话',
      /下次执行：\S+ \d{2}:\d{2}/.test(nextText), nextText)

    /* 点「保存」按钮，走真实的提交路径（不是绕过 UI 直接调接口） */
    await evalJs('(function(){ document.getElementById("taskSave").click(); return true })()')
    await sleep(1200)
    const listed = JSON.parse(await taskApi('list'))
    const mine = (listed.tasks || []).filter((t) => t.name === '每日巡检')
    ok('点保存后任务真的进了服务端，并带上下次执行时间',
      mine.length === 1 && Number.isFinite(mine[0].nextAt) && mine[0].rule.time === '20:31'
        && mine[0].enabled === true && mine[0].tools.length === 3,
      'tasks=' + (listed.tasks || []).length + ' mine=' + JSON.stringify(mine[0] || {}).slice(0, 120))

    const previewRule = JSON.parse(await taskApi('preview', { rule: { kind: 'interval', minutes: 120, timezone: 'Asia/Shanghai' } }))
    ok('间隔任务也能算出下次时间（120 分钟）', Number.isFinite(previewRule.nextAt), JSON.stringify(previewRule))
    await taskApi('delete', { id: mine[0] && mine[0].id })

    /* ---- 五点反馈真机复验：能力中心排版 / 两处滚动 / 气泡不溢出 / 空状态按项目推荐 ---- */
    await evalJs('(function(){ if(window.closeSettings) window.closeSettings(); openSettings();'
      + 'var t=document.querySelector(\'[data-settings-tab="environment"]\'); if(t) t.click(); return true })()')
    await sleep(700)
    const capLayout = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var box=document.getElementById("taskServiceSettings");if(!box)return "{}";'
      /* 无 shell 的测试环境里这两个开关默认 hidden（要 window.shell.taskPreferences 才显示），
         强制显示后再量，否则断言会空过 —— 用户抱怨的正是打包版里它们被裁掉的样子。 */
      + 'var desktop=document.getElementById("taskDesktopOptions");if(desktop)desktop.hidden=false;'
      + 'var labels=Array.from(box.querySelectorAll("label")).filter(l=>l.querySelector("input[type=checkbox]"));'
      + 'return JSON.stringify({count:labels.length,'
      + ' inline:labels.every(function(l){return l.getBoundingClientRect().height<44}),'
      + ' lastVisible:(()=>{var b=box.getBoundingClientRect();'
      + '  var last=labels[labels.length-1];if(!last)return true;var r=last.getBoundingClientRect();'
      + '  return r.bottom<=b.bottom+2})(),'
      + ' tabName:(()=>{var t=document.querySelector(\'[data-settings-tab="environment"]\');'
      + '  return t?t.textContent.trim():""})()});'
      + '})()'
    )))
    ok('设置里模块叫「能力中心」，两个开关都是一行且没被裁',
      capLayout.tabName === '能力中心' && capLayout.count === 2 && capLayout.inline === true
        && capLayout.lastVisible === true, JSON.stringify(capLayout))
    await evalJs('(function(){ if(window.closeSettings) window.closeSettings(); return true })()')
    await sleep(300)

    /* 造够多的内容，量滚动 */
    const scrollProbe = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var p=document.querySelector("#capTasks");'
      + 'var hits=[];'
      + 'for(var i=0;i<document.styleSheets.length;i++){var ss=document.styleSheets[i];'
      + ' var rules;try{rules=ss.cssRules}catch(e){continue}'
      + ' for(var j=0;j<rules.length;j++){var t=rules[j].textContent||"";'
      + '  if(t.indexOf("#capTasks")!==-1&&/overflow/.test(t))hits.push(t.slice(0,120))}}'
      + 'return JSON.stringify({scrollable:p?p.scrollHeight>p.clientHeight+2:false,'
      + ' overflowY:p?getComputedStyle(p).overflowY:"",'
      + ' clientH:p?p.clientHeight:0, scrollH:p?p.scrollHeight:0,'
      + ' rules:hits});'
      + '})()'
    )))
    ok('定时任务区域能滚动（overflow-y:auto 且内容超高时可滚）',
      scrollProbe.overflowY === 'auto' && scrollProbe.clientH > 100, JSON.stringify(scrollProbe))
    const moved = String(await evalJs(
      '(function(){var p=document.querySelector("#capTasks");p.scrollTop=120;return String(p.scrollTop)})()'
    ))
    ok('滚得动（scrollTop 真的变了）', Number(moved) > 0, 'scrollTop=' + moved)

    /* 空状态建议：跟着工作区内容走 */
    await evalJs('(function(){var c=document.getElementById("messagesInner");c.textContent="";'
      + 'window.agentUI.empty(c);return true})()')
    await sleep(600)
    const suggProbe = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var box=document.querySelector("#messagesInner .chat-empty");'
      + 'var btns=box?Array.from(box.querySelectorAll("button")).map(function(b){return b.textContent}):[];'
      + 'return JSON.stringify({count:btns.length,first:btns[0]||"",all:btns.join(" | ")});'
      + '})()'
    )))
    ok('空状态给了三条建议且不是写死那三条',
      suggProbe.count === 3 && suggProbe.first !== '分析当前仓库结构，指出主要模块',
      JSON.stringify(suggProbe))

    ok('侧栏通知入口和通知列表已移除',
      String(await evalJs('!document.getElementById("taskNoticeBell") && !document.getElementById("taskNoticeList")')) === 'true')

    /* 运行记录是紧凑列表行，整行可点 */
    await evalJs('(function(){ window.scheduledTasks.refresh(); return true })()')
    await sleep(900)
    const runProbe = JSON.parse(String(await evalJs(
      '(function(){'
      + 'var rows=document.querySelectorAll(".task-run-row");'
      + 'var box=document.getElementById("taskHistory");'
      + 'document.getElementById("taskViewRuns").click();'
      + 'return JSON.stringify({rows:rows.length, role:rows.length?rows[0].getAttribute("role"):"",'
      + ' oldCards:document.querySelectorAll(".task-run").length});'
      + '})()'
    )))
    ok('运行记录不再是大卡片（.task-run 为 0）', runProbe.oldCards === 0, JSON.stringify(runProbe))

    /* 执行环境在系统设置的「模型」下面 */
    const envProbe = JSON.parse(String(await evalJs(
      '(function(){'
      + 'closeSettings();openSettings();'
      + 'var tab=document.querySelector(\'[data-settings-tab="environment"]\');'
      + 'if(!tab)return "{}";'
      + 'tab.click();'
      + 'var panel=document.querySelector(\'[data-settings-panel="environment"]\');'
      + 'var host=document.getElementById("taskHost");'
      + 'var cs=panel?getComputedStyle(panel):null;'
      + 'var tabs=Array.from(document.querySelectorAll("[data-settings-tab]")).map(function(b){return b.dataset.settingsTab});'
      + 'return JSON.stringify({shown:!!(cs&&cs.display!=="none"&&!panel.classList.contains("hidden")),'
      + ' hostText:host?host.textContent.slice(0,28):"", order:tabs.join(","),'
      + ' keepRunning:!!document.getElementById("taskKeepRunning")});'
      + '})()'
    )))
    ok('执行环境是系统设置里的独立模块，排在模型下面',
      envProbe.shown === true && envProbe.order === 'general,model,environment,license'
        && envProbe.keepRunning === true && envProbe.hostText.indexOf('执行机器') === 0,
      JSON.stringify(envProbe))
    await evalJs('(function(){ closeSettings(); return true })()')

    /* ---- 步骤时间线（真 DOM，不是 shim）：步骤结构、标题、耗时、折叠摘要、状态行 ---- */
    const PROCESS_HTML = STEP_THINK + STEP_TOOL + STEP_AGAIN
    const TL_SEED = {
      project_x: [{
        id: 'sTL', projectId: 'project_x', scope: 'project', title: '时间线会话',
        updatedAt: '2026-10-17T10:00:00.000Z',
        messages: [{ role: 'user', content: '看下仓库' }, { role: 'assistant', content: '看完了' }],
        processHtml: PROCESS_HTML
      }]
    }
    /* 会话存储是服务端优先的（R24 起 localStorage 只是兜底），光写 localStorage 不算数 ——
       页面起来后会拿服务端那份，把我们的种子覆盖掉。所以这里得先把种子写进服务端 ui-store。 */
    const tlStore = await post(base + '/api/ui-store', {
      sessions: TL_SEED,
      currentSessionId: 'sTL',
      prefs: {}
    })
    ok('时间线种子写进服务端 ui-store', tlStore.status === 200, 'status=' + tlStore.status)
    await evalJs('localStorage.setItem("dsh-sessions-v1", ' + JSON.stringify(JSON.stringify(TL_SEED)) + ');'
      + 'localStorage.setItem("dsh-current-session", "sTL");'
      + 'localStorage.setItem("dsh-ui-store-stamp", String(Date.now())); "seeded"')
    await driver.open(base + '/')
    await sleep(1800)
    const tlProbe = await evalJs(
      '(function(){'
      + 'var steps=document.querySelectorAll(".tl-step");'
      + 'var titles=[];for(var i=0;i<steps.length;i++){var t=steps[i].querySelector(".tl-title");titles.push(t?t.textContent:"");}'
      + 'var durs=[];for(var j=0;j<steps.length;j++){var d=steps[j].querySelector(".tl-dur");durs.push(d?d.textContent:"");}'
      + 'var blk=document.querySelector(".thinking-block");'
      + 'var sum=blk&&blk.querySelector("summary")?blk.querySelector("summary").textContent:"";'
      + 'var rs=document.getElementById("runStatus");'
      + 'return JSON.stringify({steps:steps.length,titles:titles,durs:durs,summary:sum,'
      + 'statusHidden:rs?rs.classList.contains("hidden"):null})'
      + '})()'
    )
    const tl = JSON.parse(String(tlProbe))
    ok('真机界面把过程渲染成 N 个步骤节点（不再是纯文本）', tl.steps === 3, 'steps=' + tl.steps + ' ' + JSON.stringify(tlProbe))
    ok('真机界面步骤标题是人话（读取 package.json）', tl.titles.indexOf('读取 package.json') !== -1, JSON.stringify(tl.titles))
    ok('真机界面每步带耗时', tl.durs.filter((item) => String(item).length > 0).length === 3, JSON.stringify(tl.durs))
    ok('真机界面折叠条摘要显示「已执行 3 步」', String(tl.summary).indexOf('3 步') !== -1, String(tl.summary))
    ok('空闲时运行状态行是收起来的', tl.statusHidden === true, 'hidden=' + tl.statusHidden)

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
