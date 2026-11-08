'use strict'
/**
 * 真窗口探针：侧边栏底部「设置」行（2026-11-03 用户反馈三点）
 *  1. 顶部一条分割线，不要拉满，80% 长、居中
 *  2. 整体高度再矮一点
 *  3. 齿轮图标与「设置」文字上下居中，并且在自己那一行里也上下居中
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

let passed = 0
let failed = 0
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('PASS  ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 240) + ']' : '')) }
  else { failed += 1; console.log('FAIL  ' + name + '  [' + String(detail).slice(0, 320) + ']') }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(test, label) {
  for (let i = 0; i < 120; i += 1) {
    if (await test()) return
    await sleep(60)
  }
  throw new Error('Timeout: ' + label)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
  })
}
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length }
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}
function electronPath() {
  const txt = fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
  return path.join(ROOT, 'node_modules/electron/dist', txt)
}

/* 一线量全：容器、按钮、图标、文字、伪元素、侧栏底部内距 */
const MEASURE = `(function () {
  function r(el) { if (!el) return null; var x = el.getBoundingClientRect(); return { top: x.top, bottom: x.bottom, left: x.left, right: x.right, width: x.width, height: x.height } }
  var footer = document.querySelector('.sidebar-footer')
  var btn = document.getElementById('openSettings')
  var icon = btn ? btn.querySelector('.icon') : null
  var text = btn ? btn.querySelector('span:last-child') : null
  var side = document.querySelector('.sidebar')
  var scroll = document.getElementById('sidebarScroll')
  var bar = footer ? getComputedStyle(footer, '::before') : null
  var fade = footer ? getComputedStyle(footer, '::after') : null
  var fr = r(footer)
  return JSON.stringify({
    footer: fr,
    sidebar: r(side),
    scroll: r(scroll),
    btn: r(btn),
    newSession: r(document.querySelector('.new-session-entry')),
    icon: r(icon),
    text: r(text),
    textContent: text ? text.textContent : '',
    bar: bar ? {
      content: bar.content,
      position: bar.position,
      height: bar.height,
      left: bar.left,
      right: bar.right,
      width: bar.width,
      background: bar.backgroundColor,
      transform: bar.transform,
      transformOrigin: bar.transformOrigin
    } : null,
    footerDisplay: footer ? getComputedStyle(footer).display : '',
    fade: fade ? {
      content: fade.content,
      position: fade.position,
      height: fade.height,
      bottom: fade.bottom,
      image: fade.backgroundImage
    } : null,
    footerBackground: footer ? getComputedStyle(footer).backgroundColor : '',
    sidebarBackground: side ? getComputedStyle(side).backgroundColor : '',
    dividerVar: getComputedStyle(document.documentElement).getPropertyValue('--divider').trim(),
    sidebarVar: getComputedStyle(document.documentElement).getPropertyValue('--sidebar').trim(),
    theme: document.documentElement.getAttribute('data-theme') || 'dark'
  })
})()`

function mid(r) { return (r.top + r.bottom) / 2 }

async function main() {
  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sf-home-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sf-ws-'))
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), AGENT_HOME: home }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let logs = ''
  child.stdout.on('data', (c) => { logs += c.toString() })
  child.stderr.on('data', (c) => { logs += c.toString() })
  const base = 'http://127.0.0.1:' + port

  try {
  let up = false
  for (let i = 0; i < 60; i += 1) {
    try { const r = await get(base + '/api/health'); if (r.status === 200) { up = true; break } } catch (e) { /* wait */ }
    await sleep(250)
  }
  ok('服务起来了', up, logs.slice(-160))
  if (!up) throw new Error('服务没起来')

  await postJson(base + '/api/settings', {
    models: [{ id: 'mock', name: 'Mock', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', modelList: ['m'] }],
    currentModelId: 'mock',
    workspacePath: workspace,
    projects: [{ id: 'p_sf', name: '设计系统重构', folders: [workspace] }],
    currentProjectId: 'p_sf'
  })

  const seeded = await postJson(base + '/api/knowledge/create', { name: '已有知识库' })
  if (seeded.status !== 200) throw new Error('创建隔离知识库失败')
  const seededId = JSON.parse(seeded.body).id

  /* ---- 宽窗口（展开侧栏） ---- */
  let wide = null
  const wideDriver = new BrowserDriver({})
  try {
    await wideDriver.launch(base + '/', {
      electronPath: electronPath(), width: 1180, height: 860, noSandbox: process.env.SMOKE_NO_SANDBOX === '1'
    })
    const evalJs = (expr) => wideDriver.evaluate(expr)
    let ready = false
    for (let i = 0; i < 50; i += 1) {
      if (await evalJs('document.getElementById("openSettings") !== null') === true) { ready = true; break }
      await sleep(300)
    }
    ok('宽窗口界面加载完成', ready)
    await waitFor(() => evalJs('typeof state!=="undefined" && !!state.runPoll && ["libraryCount","customizeCount","workflowCount"].every(id => /^[0-9]+$/.test(document.getElementById(id).textContent))'), '侧栏计数初始化')
    ok('未打开知识库时就显示已有数量', await evalJs('document.getElementById("libraryCount").textContent === "1" && document.getElementById("knowledgePage").classList.contains("hidden")'))
    ok('隐藏知识库页面不提前渲染列表', await evalJs('document.getElementById("knowledgeBases").children.length === 0'))
    ok('三个入口计数均为纯数字', await evalJs('["libraryCount","customizeCount","workflowCount"].every(id => /^[0-9]+$/.test(document.getElementById(id).textContent))'))
    ok('能力全部停用时仍显示数字 0', await evalJs('(()=>{const plugins=state.settings.disabledPlugins,skills=state.settings.disabledSkills;try{state.settings.disabledPlugins=cachedPluginList.slice();state.settings.disabledSkills=systemSkillList.map(item=>item.id);updateShortcutMeta();return document.getElementById("customizeCount").textContent==="0"}finally{state.settings.disabledPlugins=plugins;state.settings.disabledSkills=skills;updateShortcutMeta()}})()'))
    const added = await postJson(base + '/api/knowledge/create', { name: '后台新增知识库' })
    if (added.status !== 200) throw new Error('后台新增知识库失败')
    await waitFor(() => evalJs('document.getElementById("libraryCount").textContent === "2"'), '后台新增同步')
    ok('知识库变更后不打开页面也会同步数量', await evalJs('document.getElementById("knowledgePage").classList.contains("hidden") && document.getElementById("knowledgeBases").children.length===0'))
    ok('读取失败保留最近确认的真实数量', await wideDriver.evaluate('(async()=>{const request=window.dsh.knowledgeRequest;let calls=0;window.dsh.knowledgeRequest=async(action,data)=>{if(action==="list"){calls++;throw Error("隔离读取失败")}return request(action,data)};try{await window.knowledgeUI.refresh(true);const retained=document.getElementById("libraryCount").textContent==="2";await window.knowledgeUI.refresh();await window.knowledgeUI.refresh();return retained&&calls===1}finally{window.dsh.knowledgeRequest=request}})()', { awaitPromise: true }))
    for (const id of [seededId, JSON.parse(added.body).id]) {
      const removed = await postJson(base + '/api/knowledge/remove-base', { id })
      if (removed.status !== 200) throw new Error('删除隔离知识库失败')
    }
    await waitFor(() => evalJs('document.getElementById("libraryCount").textContent === "0"'), '空知识库计数')
    ok('删除全部知识库后显示 0', true)
    await wideDriver.click('#openLibrary')
    await waitFor(() => evalJs('!document.getElementById("knowledgePage").classList.contains("hidden") && document.getElementById("knowledgeBases").textContent.includes("新建一个知识库")'), '打开空知识库')
    await wideDriver.click('#knowledgeNew')
    await wideDriver.input('#knowledgeName', '侧栏计数验证')
    await wideDriver.click('#knowledgeSave')
    await waitFor(() => evalJs('document.getElementById("libraryCount").textContent==="1" && document.getElementById("knowledgeBases").textContent.includes("侧栏计数验证")'), '界面新增知识库')
    ok('界面创建知识库后同步列表和侧栏数量', true)
    await wideDriver.click('#knowledgeClose')
    wide = JSON.parse(String(await evalJs(MEASURE)))
    const shot = await wideDriver.screenshot().catch(() => '')
    if (shot) fs.writeFileSync(path.join(OUT, 'sidebar-footer.png'), Buffer.from(shot, 'base64'))

    ok('分割线出现了（::before content 非 none）', wide.bar && wide.bar.content !== 'none' && wide.bar.content !== 'normal', wide.bar && wide.bar.content)
    ok('分割线是 1px 细线', wide.bar && wide.bar.height === '1px', wide.bar && wide.bar.height)
    ok('分割线不走进布局流（absolute，窄栏 flex 下也不会挤走齿轮）', wide.bar && wide.bar.position === 'absolute', wide.bar && wide.bar.position)
    const barW = parseFloat(wide.bar.width)
    const footW = wide.footer.width
    ok('分割线宽度约为容器 80%', Math.abs(barW - footW * 0.8) <= 1.5, barW + ' / ' + footW.toFixed(1))
    ok('分割线居中（左右留白相等）', Math.abs(parseFloat(wide.bar.left) - parseFloat(wide.bar.right)) <= 0.5, wide.bar.left + ' vs ' + wide.bar.right)
    ok('分割线用 --divider 而不是 --border', wide.bar.background === 'rgb(76, 76, 76)' && wide.dividerVar === '#4c4c4c', wide.bar.background + ' / ' + wide.dividerVar)
    /* 2026-11-03 用户「这个线太粗了」：1px 在 150% 缩放下被浏览器向上取整成 2 个物理像素，
       scaleY(.5) 把它压回 1 行（实测截图里 201→76 只占一行）。 */
    ok('分割线压成头发丝（scaleY .5，150% 下只占 1 个物理像素）',
      wide.bar && wide.bar.transform === 'matrix(1, 0, 0, 0.5, 0, 0)',
      (wide.bar && wide.bar.transform) + ' origin=' + (wide.bar && wide.bar.transformOrigin))
    /* 2026-11-03 用户「这些空间是啥」：那里是 .sidebar 的 row-gap:10 —— 列表裁切线和分割线之间空出一条，
       最后一行聊天被切半个字戳在空白里。footer 负 margin 抵掉 gap 后两者应该严丝合缝。 */
    ok('列表裁切线与分割线之间没有空白（抵消 row-gap:10）',
      Math.abs(wide.scroll.bottom - wide.footer.top) <= 0.5,
      'scroll.bottom=' + Number(wide.scroll.bottom).toFixed(1) + ' footer.top=' + Number(wide.footer.top).toFixed(1))
    ok('页脚不透明（sticky 时列表不会透出来）',
      wide.footerBackground === wide.sidebarBackground && wide.footerBackground !== 'rgba(0, 0, 0, 0)',
      wide.footerBackground + ' vs sidebar ' + wide.sidebarBackground)
    /* 列表底部渐隐：滚到一半时最后一行被硬裁成半截字（用户截图里那行 ghost 字） */
    ok('列表底部有渐隐（::after 铺在分割线上方，14px 渐变）',
      wide.fade && wide.fade.position === 'absolute' && wide.fade.height === '14px'
        && Math.abs(parseFloat(wide.fade.bottom) - wide.footer.height) <= 0.5
        && String(wide.fade.image).indexOf('linear-gradient') === 0,
      wide.fade && (wide.fade.height + ' bottom=' + wide.fade.bottom + ' footerH=' + wide.footer.height + ' ' + String(wide.fade.image).slice(0, 60)))

    /* 造一屏会话滚到底，出一张「列表 + 分割线 + 设置」的验收图（也顺手守住
       列表裁切线与分割线严丝合缝这条 —— 空列表时 footer 位置刚好也一样）。 */
    await evalJs(`(function () {
      var list = document.getElementById('chatList')
      if (!list) return 'no-list'
      for (var i = 0; i < 12; i += 1) {
        var row = document.createElement('div')
        row.className = 'flat-item chat-item'
        var t = document.createElement('span')
        t.className = 'flat-name'
        t.textContent = 'cesium 渲染原理 ' + (i + 1)
        row.appendChild(t)
        list.appendChild(row)
      }
      var s = document.getElementById('sidebarScroll')
      s.scrollTop = s.scrollHeight
      return 'ok'
    })()`)
    await sleep(400)
    const listShot = await wideDriver.screenshot().catch(() => '')
    if (listShot) fs.writeFileSync(path.join(OUT, 'sidebar-footer-list.png'), Buffer.from(listShot, 'base64'))

    ok('设置按钮与新建会话等高', Math.abs(wide.btn.height - wide.newSession.height) <= 0.5, wide.btn.height + ' vs ' + wide.newSession.height)
    ok('设置按钮与新建会话等宽且左右对齐',
      Math.abs(wide.btn.width - wide.newSession.width) <= 0.5 && Math.abs(wide.btn.left - wide.newSession.left) <= 0.5,
      wide.btn.width + ' vs ' + wide.newSession.width)
    const iconMid = mid(wide.icon)
    const textMid = mid(wide.text)
    const btnMid = mid(wide.btn)
    ok('齿轮与「设置」同一条中线（误差 ≤1px）', Math.abs(iconMid - textMid) <= 1, iconMid + ' vs ' + textMid)
    ok('图标 / 文字都相对按钮背景上下居中（误差 ≤1px）',
      Math.abs(iconMid - btnMid) <= 1 && Math.abs(textMid - btnMid) <= 1, btnMid)
    const gapBottom = wide.sidebar.bottom - wide.footer.bottom
    const gapTop = wide.btn.top - wide.footer.top
    ok('设置行保留上方 5px、侧栏底部 18px 留白（与会话输入框一致）',
      Math.abs(gapTop - 5) <= 1 && Math.abs(gapBottom - 18) <= 1,
      'top=' + gapTop.toFixed(1) + ' bottom=' + gapBottom.toFixed(1)
        + ' block=' + (wide.sidebar.bottom - wide.footer.top).toFixed(1))

    /* 浅色主题下分割线还看得见（用 --divider 的浅色档 #c9c9c9） */
    await evalJs("(function(){document.documentElement.setAttribute('data-theme','light');return 'ok'})()")
    await sleep(400)
    const lightBar = JSON.parse(String(await evalJs(MEASURE)))
    ok('浅色主题下设置按钮仍与新建会话等宽等高',
      Math.abs(lightBar.btn.width - lightBar.newSession.width) <= 0.5 && Math.abs(lightBar.btn.height - lightBar.newSession.height) <= 0.5,
      lightBar.btn.width + '×' + lightBar.btn.height)
    ok('浅色主题分割线换成 #c9c9c9（不是和底色同色的 --border #eee）',
      lightBar.bar.background === 'rgb(201, 201, 201)',
      lightBar.bar.background + ' / ' + lightBar.dividerVar)
    ok('浅色主题页脚底色跟着 --sidebar 走（#f7f7f7，不透出列表）',
      lightBar.footerBackground === 'rgb(247, 247, 247)',
      lightBar.footerBackground + ' / ' + lightBar.sidebarVar)
    const lightShot = await wideDriver.screenshot().catch(() => '')
    if (lightShot) fs.writeFileSync(path.join(OUT, 'sidebar-footer-light.png'), Buffer.from(lightShot, 'base64'))
    await evalJs("(function(){document.documentElement.setAttribute('data-theme','dark');return 'ok'})()")

    /* 窄栏风险点等价验证：主窗口 minWidth 980，≤900px 的 rail 媒体查询在桌面端进不去，
       所以直接把 footer 临时切成 flex（和窄栏同一种布局）看分割线会不会变成 flex 项把齿轮挤走。 */
    const flexProbe = JSON.parse(String(await evalJs(`(function () {
      var f = document.querySelector('.sidebar-footer')
      var btn = document.getElementById('openSettings')
      var old = f.getAttribute('style') || ''
      f.style.display = 'flex'
      f.style.alignItems = 'center'
      f.style.justifyContent = 'center'
      var fr = f.getBoundingClientRect()
      var br = btn.getBoundingClientRect()
      var bar = getComputedStyle(f, '::before')
      var out = {
        buttonLeft: br.left - fr.left,
        buttonWidth: br.width,
        barPosition: bar.position,
        barLeft: bar.left,
        barRight: bar.right
      }
      f.setAttribute('style', old)
      return JSON.stringify(out)
    })()`)))
    ok('footer 切成 flex（窄栏同款布局）时分割线仍是 absolute，左右留白不变（没变成 flex 项被收缩）',
      flexProbe.barPosition === 'absolute'
        && Math.abs(parseFloat(flexProbe.barLeft) - parseFloat(flexProbe.barRight)) <= 0.5
        && Math.abs(parseFloat(flexProbe.barLeft) - parseFloat(wide.bar.left)) <= 0.5,
      'bar=' + flexProbe.barPosition + ' left=' + flexProbe.barLeft + ' right=' + flexProbe.barRight
        + ' btn=' + flexProbe.buttonWidth.toFixed(1))
    ok('flex 布局下分割线依旧居中', Math.abs(parseFloat(flexProbe.barLeft) - parseFloat(flexProbe.barRight)) <= 0.5,
      flexProbe.barLeft + ' vs ' + flexProbe.barRight)
  } finally {
    await wideDriver.close().catch(() => {})
  }

  } finally {
    child.kill('SIGTERM')
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, '隔离服务退出')
    for (const dir of [home, workspace]) fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('\nsidebar-footer smoke: ' + passed + '/' + (passed + failed) + ' checks passed')
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => { console.error('ERROR', e && e.stack); process.exit(1) })
