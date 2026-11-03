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
    await sleep(500)
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

    ok('按钮高度收到 26px', Math.abs(wide.btn.height - 26) <= 0.6, wide.btn.height)
    const iconMid = mid(wide.icon)
    const textMid = mid(wide.text)
    const btnMid = mid(wide.btn)
    ok('齿轮与「设置」同一条中线（误差 ≤1px）', Math.abs(iconMid - textMid) <= 1, iconMid + ' vs ' + textMid)
    ok('图标 / 文字都相对按钮背景上下居中（误差 ≤1px）',
      Math.abs(iconMid - btnMid) <= 1 && Math.abs(textMid - btnMid) <= 1, btnMid)
    const gapBottom = wide.sidebar.bottom - wide.footer.bottom
    const gapTop = wide.btn.top - wide.footer.top
    ok('整块高度收矮：按钮上 5px、侧栏底 6px（区块 37px）',
      Math.abs(gapTop - 5) <= 1 && Math.abs(gapBottom - 6) <= 1,
      'top=' + gapTop.toFixed(1) + ' bottom=' + gapBottom.toFixed(1)
        + ' block=' + (wide.sidebar.bottom - wide.footer.top).toFixed(1))

    /* 浅色主题下分割线还看得见（用 --divider 的浅色档 #c9c9c9） */
    await evalJs("(function(){document.documentElement.setAttribute('data-theme','light');return 'ok'})()")
    await sleep(400)
    const lightBar = JSON.parse(String(await evalJs(MEASURE)))
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

  child.kill()
  console.log('\nsidebar-footer smoke: ' + passed + '/' + (passed + failed) + ' checks passed')
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => { console.error('ERROR', e && e.stack); process.exit(1) })
