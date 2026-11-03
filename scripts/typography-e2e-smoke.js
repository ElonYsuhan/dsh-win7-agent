'use strict'

/* 排版验收（真窗口）：字体是否真的加载、字号层级是否落到令牌、正文有没有低于 12px 的字。
   两段环境都验：HTTP（开发/服务态）与 file://（打包态，CSP 会真正生效）。
   运行：SMOKE_NO_SANDBOX=1 node scripts/typography-e2e-smoke.js */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')
const { BrowserDriver } = require('../src/main/agent/browser-driver')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'release', 'validation')
let passed = 0

function ok (name, condition, detail) {
  if (!condition) throw new Error('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail))
  passed += 1
  console.log('  ok  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (check, label, timeoutMs) {
  const end = Date.now() + (timeoutMs || 15000)
  let last = null
  while (Date.now() < end) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { last = error }
    await sleep(120)
  }
  throw new Error('等待超时：' + label + (last ? ' (' + last.message + ')' : ''))
}

function freePort () {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function request (method, target) {
  return new Promise((resolve, reject) => {
    const url = new URL(target)
    assert(url.hostname === '127.0.0.1', '测试只走本机回环')
    const req = http.request(url, { method }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, data: body }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('HTTP_TIMEOUT')))
    req.end()
  })
}

/* 页面里的探针：字体清单、令牌、字号地板、按钮裁切。
   地板判定排除图标字形（单个符号），只抓「能读的文字」。 */
const PROBE = `(function () {
  var faces = Array.from(document.fonts).map(function (f) { return f.family + ' ' + f.weight + ' ' + f.status })
  var root = getComputedStyle(document.documentElement)
  var cs = function (el) { return el ? getComputedStyle(el) : null }
  var textish = /[A-Za-z\\u4e00-\\u9fa5]{2}/
  var small = []
  var all = document.querySelectorAll('body *')
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i]
    if (!el.getClientRects().length) continue
    var text = (el.textContent || '').trim()
    if (!textish.test(text)) continue
    if (el.querySelector('*')) continue            /* 只看叶子节点，避免父级重复计入 */
    var size = parseFloat(getComputedStyle(el).fontSize)
    if (size < 12) small.push(el.className + ':' + size + ':' + text.slice(0, 12))
  }
  var clipped = []
  var buttons = document.querySelectorAll('button, [role="button"]')
  for (var j = 0; j < buttons.length; j += 1) {
    var b = buttons[j]
    if (!b.getClientRects().length) continue
    if (!textish.test((b.textContent || '').trim())) continue
    if (b.scrollWidth > b.clientWidth + 1) clipped.push((b.id || b.className) + ':' + b.scrollWidth + '/' + b.clientWidth)
  }
  return {
    faces: faces,
    bodyFont: cs(document.body).fontFamily,
    bodySize: cs(document.body).fontSize,
    bodyWeight: cs(document.body).fontWeight,
    tokens: {
      ui: root.getPropertyValue('--font-ui').trim().slice(0, 40),
      mono: root.getPropertyValue('--font-mono').trim().slice(0, 40),
      base: root.getPropertyValue('--font-size-base').trim(),
      caption: root.getPropertyValue('--font-size-caption').trim(),
      small: root.getPropertyValue('--font-size-small').trim()
    },
    input: cs(document.getElementById('input')) ? cs(document.getElementById('input')).fontSize : 'no-input',
    titlebar: cs(document.getElementById('titlebarDrag')) ? cs(document.getElementById('titlebarDrag')).fontSize : 'no-titlebar',
    below12: small.slice(0, 6),
    below12Count: small.length,
    clipped: clipped.slice(0, 6),
    clippedCount: clipped.length
  }
})()`

/* 用真实 CSS 类名摆一段样例：标题 / 正文 / 行内代码 / 表格 / 代码块。
   这样截图看的是真规则，不是凭空画的样式。 */
const SAMPLE = `(function () {
  var host = document.getElementById('messagesInner') || document.body
  host.innerHTML =
    '<div class="bubble user"><div class="bubble-body">把这份 DCS 报警清单整理成表格，顺便看一下 PLC 地址段有没有冲突。</div></div>' +
    '<div class="bubble assistant"><div class="bubble-body">' +
    '<h2>报警清单汇总</h2>' +
    '<p>共 3 条，其中 <code>DB12.DBW4</code> 与 <code>DB12.DBW6</code> 存在地址重叠，需要合并。英文 mixed with 中文 的行高与基线应保持一致。</p>' +
    '<table><thead><tr><th>位号</th><th>地址</th><th>阈值</th></tr></thead>' +
    '<tbody><tr><td>PT-101</td><td>DB12.DBW4</td><td>1200.5</td></tr>' +
    '<tr><td>FT-202</td><td>DB12.DBW6</td><td>38.25</td></tr>' +
    '<tr><td>TT-303</td><td>DB13.DBW2</td><td>86.0</td></tr></tbody></table>' +
    '<pre><code>const alarm = collect("DB12");\\nalarm.merge("DBW4", "DBW6");</code></pre>' +
    '<p>参数说明：采样周期 500ms，超时 3 次触发。</p>' +
    '</div></div>'
  return true
})()`

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-typography-e2e-'))
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const driver = new BrowserDriver({})
  let service = null
  let logs = ''
  const noSandbox = process.env.SMOKE_NO_SANDBOX === '1'

  try {
    const port = await freePort()
    const base = 'http://127.0.0.1:' + port
    service = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        HOST: '127.0.0.1', PORT: String(port), PORT_MAX_ATTEMPTS: '1', AGENT_HOME: home, WORKSPACE_PATH: workspace
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    service.stdout.on('data', (chunk) => { logs += chunk })
    service.stderr.on('data', (chunk) => { logs += chunk })
    await waitFor(async () => (await request('GET', base + '/api/health')).status === 200, '隔离服务启动')

    const binary = fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
    await driver.launch(base + '/', {
      electronPath: path.join(ROOT, 'node_modules', 'electron', 'dist', binary),
      userDataDir: path.join(root, 'browser'), width: 1180, height: 820, noSandbox
    })
    await waitFor(() => driver.evaluate('!!document.getElementById("input") && typeof state !== "undefined"'), '界面就绪')
    /* 授权门是另一套验收的题目，这里只关心排版，先摘掉免得挡视线。 */
    await driver.evaluate(`(function () {
      var gate = document.getElementById('licenseGate')
      if (gate) gate.remove()
      document.documentElement.dataset.theme = 'dark'
      return true
    })()`)
    /* 强制把 6 个字面都取一遍：unloaded 只代表「还没用到」，只有 load() 才能证明
       文件能解析（字体损坏时这一步会 reject）。 */
    const loadedAll = await driver.evaluate(`Promise.all(Array.from(document.fonts).map(function (f) {
      return f.load().then(function () { return true }, function () { return false })
    }))`, { awaitPromise: true })
    ok('六个字面都能真正加载', Array.isArray(loadedAll) && loadedAll.every(Boolean), JSON.stringify(loadedAll))
    await driver.evaluate('document.fonts.ready.then(function(){return true})', { awaitPromise: true })
    await sleep(400)

    const page = await driver.evaluate(PROBE)

    /* ---------- 字体真的加载了 ---------- */
    ok('六个字面都已注册', page.faces.length === 6, page.faces.join(' | '))
    ok('六个字面状态都是 loaded', page.faces.every((line) => line.indexOf(' loaded') > 0), page.faces.join(' | '))
    for (const face of ['Inter 400 loaded', 'Inter 500 loaded', 'Inter 600 loaded',
      'Noto Sans SC 400 loaded', 'Noto Sans SC 600 loaded', 'JetBrains Mono 400 loaded']) {
      ok('字面可用：' + face, page.faces.indexOf(face) >= 0, page.faces.join(' | '))
    }
    ok('body 走 Inter 打头的中英混排链', page.bodyFont.indexOf('Inter') === 0, page.bodyFont)
    ok('body 字号是 14px 基准', page.bodySize === '14px', page.bodySize)
    ok('body 字重是 400', page.bodyWeight === '400', page.bodyWeight)

    /* ---------- 令牌生效 ---------- */
    ok('--font-size-base = 14px', page.tokens.base === '14px', page.tokens.base)
    ok('--font-size-caption = 12px', page.tokens.caption === '12px', page.tokens.caption)
    ok('--font-size-small = 13px', page.tokens.small === '13px', page.tokens.small)
    ok('--font-mono 以 JetBrains Mono 打头', page.tokens.mono.replace(/^"/, '').indexOf('JetBrains Mono') === 0, page.tokens.mono)

    /* ---------- 层级地板 ---------- */
    ok('输入区是 14px 正文档', page.input === '14px', page.input)
    ok('可读文字没有低于 12px 的', page.below12Count === 0, page.below12Count + ' 处：' + page.below12.join(' | '))
    ok('可见按钮没有被文字撑破', page.clippedCount === 0, page.clippedCount + ' 处：' + page.clipped.join(' | '))

    fs.mkdirSync(OUT, { recursive: true })
    await driver.evaluate(SAMPLE)
    await sleep(350)
    fs.writeFileSync(path.join(OUT, 'typography-sample-dark.png'), Buffer.from(await driver.screenshot(), 'base64'))

    const sample = await driver.evaluate(`(function () {
      var q = function (sel) { var el = document.querySelector(sel); return el ? getComputedStyle(el) : null }
      var body = document.querySelector('.bubble.assistant .bubble-body')
      return {
        bodySize: body ? getComputedStyle(body).fontSize : 'none',
        h2: q('.bubble-body h2') ? q('.bubble-body h2').fontSize : 'none',
        code: q('.bubble-body code') ? q('.bubble-body code').fontFamily : 'none',
        codeSize: q('.bubble-body code') ? q('.bubble-body code').fontSize : 'none',
        table: q('.bubble-body table') ? q('.bubble-body table').fontSize : 'none',
        pre: q('.bubble-body pre') ? q('.bubble-body pre').fontSize : 'none',
        preFamily: q('.bubble-body pre') ? q('.bubble-body pre').fontFamily : 'none',
        digits: body ? getComputedStyle(body).fontVariantNumeric : 'none'
      }
    })()`)
    ok('正文落到 14px', sample.bodySize === '14px', sample.bodySize)
    ok('markdown 二级标题落到 20px', sample.h2 === '20px', sample.h2)
    ok('行内代码用等宽字体', sample.code.indexOf('JetBrains Mono') >= 0, sample.code)
    ok('表格落到 13px 数据档', sample.table === '13px', sample.table)
    ok('代码块 13px + mono', sample.pre === '13px' && sample.preFamily.indexOf('JetBrains Mono') >= 0, sample.pre + ' / ' + sample.preFamily)
    ok('数字等宽已生效', sample.digits.indexOf('tabular-nums') >= 0, sample.digits)

    await driver.evaluate('document.documentElement.dataset.theme = "light"; true')
    await sleep(600)
    fs.writeFileSync(path.join(OUT, 'typography-sample-light.png'), Buffer.from(await driver.screenshot(), 'base64'))
    const lightCheck = await driver.evaluate('getComputedStyle(document.body).fontSize + "|" + getComputedStyle(document.body).fontFamily.slice(0, 5)')
    ok('浅色主题共用同一套排版', lightCheck === '14px|Inter', lightCheck)

    /* ---------- 150% 缩放：CSS 像素不变，但要确认没有被挤坏 ---------- */
    await driver.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1.5, mobile: false })
    await sleep(600)
    /* 1.5x 缩放下软件光栅化截图很慢，超时就跳过这张图，不影响断言。 */
    try {
      fs.writeFileSync(path.join(OUT, 'typography-dpi-150.png'), Buffer.from(await driver.screenshot(), 'base64'))
    } catch (error) {
      console.log('  ..  150% 截图跳过：' + error.message)
    }
    const dpi = await driver.evaluate(`(function () {
      var textish = /[A-Za-z\u4e00-\u9fa5]{2}/
      var small = 0
      var all = document.querySelectorAll('body *')
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i]
        if (!el.getClientRects().length || el.querySelector('*')) continue
        if (!textish.test((el.textContent || '').trim())) continue
        if (parseFloat(getComputedStyle(el).fontSize) < 12) small += 1
      }
      return { size: getComputedStyle(document.body).fontSize, small: small }
    })()`)
    ok('150% 缩放下基准字号仍是 14px', dpi.size === '14px', JSON.stringify(dpi))
    ok('150% 缩放下依然没有低于 12px 的文字', dpi.small === 0, JSON.stringify(dpi))
    await driver.cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(300)

    /* ---------- 最密的表单也过一遍：设置弹窗 ---------- */
    await driver.evaluate('document.getElementById("messagesInner") && (document.getElementById("messagesInner").innerHTML = ""); true')
    await driver.click('#openSettings')
    await waitFor(() => driver.evaluate('!document.getElementById("settingsModal").classList.contains("hidden")'), '设置弹窗打开')
    await sleep(450)
    /* 弹层遮罩带 backdrop-filter，整屏模糊时 CDP 截图容易超时：
       截图前先关掉模糊（只影响这张验收图，不改产品样式）。 */
    await driver.evaluate(`(function () {
      var all = document.querySelectorAll('*')
      for (var i = 0; i < all.length; i += 1) {
        var cs = getComputedStyle(all[i])
        if (cs.backdropFilter && cs.backdropFilter !== 'none') {
          all[i].style.backdropFilter = 'none'
          all[i].style.webkitBackdropFilter = 'none'
        }
      }
      return true
    })()`)
    await sleep(250)
    let settingsShot = null
    try { settingsShot = await driver.screenshot() } catch (error) {
      await sleep(800)
      settingsShot = await driver.screenshot()
    }
    fs.writeFileSync(path.join(OUT, 'typography-settings-dark.png'), Buffer.from(settingsShot, 'base64'))
    const dialog = await driver.evaluate(`(function () {
      var box = document.getElementById('settingsModal')
      var textish = /[A-Za-z\u4e00-\u9fa5]{2}/
      var small = 0, clipped = 0, sample = []
      var all = box.querySelectorAll('*')
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i]
        if (!el.getClientRects().length || el.querySelector('*')) continue
        if (!textish.test((el.textContent || '').trim())) continue
        var size = parseFloat(getComputedStyle(el).fontSize)
        if (size < 12) { small += 1; if (sample.length < 3) sample.push(el.className + ':' + size) }
      }
      var buttons = box.querySelectorAll('button')
      for (var j = 0; j < buttons.length; j += 1) {
        var b = buttons[j]
        if (!b.getClientRects().length || !textish.test((b.textContent || '').trim())) continue
        if (b.scrollWidth > b.clientWidth + 1) clipped += 1
      }
      return { small: small, clipped: clipped, sample: sample.join(',') }
    })()`)
    ok('设置弹窗里也没有低于 12px 的文字', dialog.small === 0, JSON.stringify(dialog))
    ok('设置弹窗的按钮没被文字撑破', dialog.clipped === 0, JSON.stringify(dialog))
    await driver.evaluate('document.getElementById("settingsClose") && document.getElementById("settingsClose").click(); true')
    await sleep(200)

    /* ---------- 打包态：file:// 下 CSP 是否放行本地字体 ---------- */
    await driver.launch(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'index.html')).toString(), {
      electronPath: path.join(ROOT, 'node_modules', 'electron', 'dist', binary),
      userDataDir: path.join(root, 'browser-file'), width: 1180, height: 820, noSandbox
    })
    await sleep(1200)
    /* check() 只认「已加载」的字面，所以打包态也要先拉一遍再判。 */
    const fileLoaded = await driver.evaluate(`Promise.all(Array.from(document.fonts).map(function (f) {
      return f.load().then(function () { return true }, function () { return false })
    }))`, { awaitPromise: true })
    ok('file:// 下六个字面都能加载（CSP 放行本地字体）', Array.isArray(fileLoaded) && fileLoaded.every(Boolean), JSON.stringify(fileLoaded))
    const fileBound = await driver.evaluate(`(function () {
      return {
        href: location.href.slice(0, 8),
        inter: document.fonts.check('400 14px Inter'),
        inter600: document.fonts.check('600 14px Inter'),
        cjk: document.fonts.check('400 14px "Noto Sans SC"'),
        mono: document.fonts.check('400 13px "JetBrains Mono"'),
        faces: document.fonts.size
      }
    })()`)
    ok('打包态走 file://', fileBound.href.indexOf('file://') === 0, fileBound.href)
    ok('file:// 下 Inter 可用（CSP 未拦截）', fileBound.inter === true && fileBound.inter600 === true, JSON.stringify(fileBound))
    ok('file:// 下中文与等宽可用', fileBound.cjk === true && fileBound.mono === true, JSON.stringify(fileBound))

    console.log('typography e2e: ' + passed + ' checks passed, Electron 22')
  } finally {
    await driver.finishClose().catch(() => {})
    if (service) service.kill()
    if (process.env.SMOKE_KEEP_LOGS !== '1') { /* 日志只在失败时有用 */ }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
