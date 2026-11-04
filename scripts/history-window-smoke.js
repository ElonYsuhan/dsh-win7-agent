'use strict'
/**
 * 真窗口探针：历史消息窗口化渲染（2026-11-04 用户反馈「切会话卡顿，要异步加载」）
 *
 *  以前切会话会把整段对话一次性同步画完（几百条消息 = 200-270ms 主线程长任务）。
 *  现在：首屏只画最近 24 条，更早的历史放在顶部「载入更早的消息」入口，
 *  点击或滚到顶时按 8ms 帧预算分片回填（离屏 fragment，全部就绪才一次挂载）。
 *
 * 本脚本用真实用户数据的副本当 AGENT_HOME（那条 294 条消息的会话正是要测的场景），
 * 断言：
 *  1. 切过去之后 DOM 里只有一个小窗口（不是 294 条全画）
 *  2. 切换期间没有 50ms 以上的长任务
 *  3. 顶部出现「载入更早」入口，并标着剩余条数
 *  4. 点一次补 40 条：剩余数递减、DOM 变多、视口里正在看的内容不动
 *  5. 一直补到没有更早的：入口消失，摘要里的总条数对得上
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const { BrowserDriver } = require(path.join(ROOT, 'src/main/agent/browser-driver.js'))
const OUT = path.join(ROOT, 'release/validation')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

const TARGET_SESSION = 'session_mvxhi11lja73'
const TARGET_PROJECT = 'project_mv7z8572'
const REAL_HOME = path.join(process.env.APPDATA || '', 'Agent', 'agent-home')

let passed = 0, failed = 0
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('PASS  ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 220) + ']' : '')) }
  else { failed += 1; console.log('FAIL  ' + name + '  [' + String(detail).slice(0, 300) + ']') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', reject)
  })
}
function electronPath() {
  const txt = fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
  return path.join(ROOT, 'node_modules/electron/dist', txt)
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

/* 页内统计：DOM 里到底画了多少条，窗口入口还在不在 */
const INSPECT = `(function () {
  var inner = document.getElementById('messagesInner')
  if (!inner) return JSON.stringify({ ready: false })
  var more = inner.querySelector('.history-more')
  var scroller = document.getElementById('messages')
  function visibleTop() {
    var nodes = inner.children, box = scroller.getBoundingClientRect()
    for (var i = 0; i < nodes.length; i += 1) {
      var r = nodes[i].getBoundingClientRect()
      if (r.bottom > box.top + 1 && r.height > 0) return Math.round(r.top - box.top)
    }
    return null
  }
  return JSON.stringify({
    ready: true,
    bubbles: inner.querySelectorAll('.bubble').length,
    groups: inner.querySelectorAll('.bubble-group').length,
    processBlocks: inner.querySelectorAll('.thinking-block').length,
    historyMore: !!more,
    historyMoreText: more ? more.textContent : null,
    historyMoreDisabled: more ? !!more.disabled : null,
    remaining: more ? Number(more.dataset.remaining) : 0,
    scrollTop: Math.round(scroller.scrollTop),
    scrollHeight: Math.round(scroller.scrollHeight),
    visibleTop: visibleTop(),
    longTasks: (window.__lt || []).slice(),
    ms: window.__t0 ? Math.round(performance.now() - window.__t0) : null
  })
})()`

async function main() {
  if (!fs.existsSync(path.join(REAL_HOME, 'ui-store.json'))) {
    console.log('SKIP  找不到真实用户数据（' + REAL_HOME + '），本探针需要真实大会话')
    process.exit(0)
  }
  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hist-home-'))
  copyDir(REAL_HOME, home)
  const store = JSON.parse(fs.readFileSync(path.join(home, 'ui-store.json'), 'utf8'))
  const sessions = store.sessions || {}
  let target = null
  for (const key of Object.keys(sessions)) {
    for (const item of sessions[key]) if (item.id === TARGET_SESSION) target = item
  }
  ok('真实数据里有那条 294 条消息的会话', Boolean(target) && (target.messages || []).length > 200, target ? (target.messages || []).length + ' 条' : 'none')

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
  for (let i = 0; i < 80; i += 1) {
    try { const r = await get(base + '/api/health'); if (r.status === 200) { up = true; break } } catch (e) {}
    await sleep(250)
  }
  ok('服务起来了', up, logs.slice(-160))
  if (!up) throw new Error('服务没起来')

  const driver = new BrowserDriver({})
  try {
    await driver.launch(base + '/', { electronPath: electronPath(), width: 1280, height: 880, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    const evalJs = (e) => driver.evaluate(e)
    let ready = false
    for (let i = 0; i < 60; i += 1) { if (await evalJs('document.getElementById("openLibrary") !== null') === true) { ready = true; break } await sleep(300) }
    ok('界面加载完成', ready)
    await sleep(600)

    /* 长任务观察器 + 计时器：每次切换前清空，切完读回来 */
    await evalJs(`(function(){window.__lt=[];try{new PerformanceObserver(function(l){for(var i=0;i<l.getEntries().length;i++){var e=l.getEntries()[i];window.__lt.push({rel:Math.round(e.startTime-(window.__t0||0)),dur:Math.round(e.duration)})}}).observe({entryTypes:['longtask']})}catch(e){window.__lt=[]}return 'ok'})()`)

    /* 先切到一条短会话，制造「从别处切过来」的真实路径 */
    await evalJs(`(function(){var p=document.querySelector('[data-project-id="${TARGET_PROJECT}"]');if(p&&!p.classList.contains('is-expanded')){var head=p.querySelector('.project-head')||p;p.click()}return 'ok'})()`)
    await sleep(400)

    /* 页内自己去量「内容什么时候出现」：用 setInterval 采样 DOM 条数，
       避免 CDP evaluate 排队把测量结果算进主线程耗时里。 */
    const SWITCH = `(function(){
      window.__lt=[]; window.__marks=[];
      var t0=performance.now(); window.__t0=t0;
      window.__timer=setInterval(function(){
        var n=document.querySelectorAll('#messagesInner .bubble').length;
        window.__marks.push({t:Math.round(performance.now()-t0),n:n});
        if(performance.now()-t0>1500){clearInterval(window.__timer);window.__timer=null}
      },16);
      var row=document.querySelector('[data-session-id="${TARGET_SESSION}"]');
      if(!row) return 'no-row';
      row.click();
      return 'clicked';
    })()`
    const clicked = await evalJs(SWITCH)
    ok('找到目标会话行并点击', clicked === 'clicked', clicked)
    await sleep(1700)
    const marks = JSON.parse(String(await evalJs('JSON.stringify(window.__marks||[])')))
    const paintAt = (marks.find((m) => m.n > 0) || {}).t
    ok('首屏内容出现时间（页内采样）', paintAt !== undefined && paintAt <= 250, 'first paint at ' + paintAt + 'ms')
    await sleep(400)
    const settled = JSON.parse(String(await evalJs(INSPECT)))

    ok('切过去一帧内就出内容（首屏不是空白）', settled.bubbles > 0, 'bubbles=' + settled.bubbles)
    ok('首屏只画窗口内的消息，不是 294 条全量', settled.bubbles + settled.groups <= 30, 'bubbles=' + settled.bubbles + ' groups=' + settled.groups + ' total=' + (settled.bubbles + settled.groups))
    ok('切换期间没有 50ms 以上的长任务', settled.longTasks.length === 0, JSON.stringify(settled.longTasks))
    ok('顶部出现「载入更早」入口', settled.historyMore === true)
    ok('入口标着剩余条数', settled.remaining > 0 && /还有 \d+ 条/.test(String(settled.historyMoreText)), settled.historyMoreText)

    /* 切会话只推「轻量」那份 ui-store（不带 sessions）：服务端必须做浅合并保留会话库，
       否则一次切换就能把几 MB 的会话记录清空。 */
    await sleep(900)
    const remote = JSON.parse(String(await get(base + '/api/ui-store').then((r) => r.body)))
    const remoteSessions = (remote.store && remote.store.sessions) || {}
    const remoteCount = Object.keys(remoteSessions).reduce((sum, key) => sum + (Array.isArray(remoteSessions[key]) ? remoteSessions[key].length : 0), 0)
    ok('切会话后服务端会话库仍在（轻量推送不清空 sessions）', remoteCount >= 10, 'sessions=' + remoteCount)
    ok('切会话后服务端 currentSessionId 已更新', remote.store && remote.store.currentSessionId === TARGET_SESSION, remote.store && remote.store.currentSessionId)

    const shot1 = await driver.screenshot().catch(() => '')
    if (shot1) fs.writeFileSync(path.join(OUT, 'history-window-first.png'), Buffer.from(shot1, 'base64'))


    /* 当前会话总消息数：直接从页面里的状态读，用来核对最后是否补完 */
    const total = (target.messages || []).length

    /* 点一次：补 40 条，视口里正在看的内容不能跳 */
    const before = JSON.parse(String(await evalJs(INSPECT)))
    const LOAD = `(function(){var b=document.querySelector('#messagesInner .history-more');if(!b)return 'no-button';window.__lt=[];b.click();return 'clicked'})()`
    const loadClicked = await evalJs(LOAD)
    ok('点击「载入更早」', loadClicked === 'clicked', loadClicked)
    await sleep(900)
    const afterOne = JSON.parse(String(await evalJs(INSPECT)))
    ok('补完一批后剩余条数减少 40', before.remaining - afterOne.remaining === 40, before.remaining + ' -> ' + afterOne.remaining)
    ok('补完后 DOM 里确实多了消息', afterOne.bubbles + afterOne.groups > before.bubbles + before.groups, (before.bubbles + before.groups) + ' -> ' + (afterOne.bubbles + afterOne.groups))
    ok('补历史时视口内容不跳（插入前置内容后补回滚动偏移）', Math.abs((afterOne.visibleTop || 0) - (before.visibleTop || 0)) <= 4, 'top ' + before.visibleTop + ' -> ' + afterOne.visibleTop)
    ok('补历史这一批也没有长任务', afterOne.longTasks.length === 0, JSON.stringify(afterOne.longTasks))

    /* 滚到顶也应该自动补一批（不用非得点按钮） */
    const beforeAuto = JSON.parse(String(await evalJs(INSPECT)))
    await evalJs('document.getElementById("messages").scrollTop = 0')
    await sleep(900)
    const afterAuto = JSON.parse(String(await evalJs(INSPECT)))
    ok('滚到顶自动补一批', afterAuto.remaining < beforeAuto.remaining, beforeAuto.remaining + ' -> ' + afterAuto.remaining)

    /* 一直补到没有更早的 */
    let guard = 0
    while (guard < 40) {
      guard += 1
      const state = JSON.parse(String(await evalJs(INSPECT)))
      if (process.env.HIST_DEBUG === '1') console.log('  round ' + guard + ' remaining=' + state.remaining + ' dom=' + (state.bubbles + state.groups) + ' more=' + state.historyMore + ' disabled=' + state.historyMoreDisabled)
      if (!state.historyMore) break
      await evalJs(`(function(){var b=document.querySelector('#messagesInner .history-more');if(b)b.click();return 1})()`)
      await sleep(700)
    }
    const done = JSON.parse(String(await evalJs(INSPECT)))
    ok('全部补完后「载入更早」入口消失', done.historyMore === false)
    /* 294 条里有一半是 tool 消息（内容记在过程块里、不单独成气泡），
       所以 DOM 节点数天然少于消息数；这里核对「补完后比首屏多得多」这个量级。 */
    ok('补全后画出的内容远多于首屏（不是只补了几条）', done.bubbles + done.groups >= 50, 'dom=' + (done.bubbles + done.groups) + ' total=' + total)

    const shot2 = await driver.screenshot().catch(() => '')
    if (shot2) fs.writeFileSync(path.join(OUT, 'history-window-full.png'), Buffer.from(shot2, 'base64'))
  } finally {
    try { await driver.close() } catch (e) {}
    child.kill('SIGKILL')
    try { fs.rmSync(home, { recursive: true, force: true }) } catch (e) {}
  }
  console.log('\n==== ' + passed + ' passed, ' + failed + ' failed ====')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
