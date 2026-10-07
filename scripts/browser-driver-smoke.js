'use strict'

/**
 * browser-driver-smoke：自验证能力（CDP 浏览器驱动 + 测试跑器）的真机端到端。
 *
 * 链路：本脚本起一个本地 http 服务（测试页：按钮/输入框/console.error/404/
 * 伪 Cesium viewer）→ spawn 本仓库的 Electron（--remote-debugging-port）→
 * CDP 连上 → 点击/输入/按键/等待/截图/eval → test_run 跑正反用例 →
 * 断言 TestReport 的判定全对。
 *
 * 需要真 Electron：本机 seatbelt 起不来，跑法
 *   SMOKE_NO_SANDBOX=1 node scripts/browser-driver-smoke.js
 * （不进默认 check 链，与 check:drag / check:shellpage 同级：check:browser）
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { BrowserDriver } = require('../src/main/agent/browser-driver')
const { compactSuite } = require('../src/main/agent/test-runner')

const not = (value) => value ? false : true
let passed = 0
let failed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('PASS  ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 160) + ']' : ''))
  } else {
    failed += 1
    failures.push(name + '  [' + String(detail).slice(0, 300) + ']')
    console.log('FAIL  ' + name + '  [' + String(detail).slice(0, 300) + ']')
  }
}

const TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh browser smoke</title></head>
<body>
  <button id="btn">点我</button>
  <span id="out">idle</span>
  <input id="inp" value="">
  <span id="keys">0</span>
  <button id="errBtn">boom</button>
  <script>
    /* 伪 Cesium viewer：形状与真的一样，验证断言机器不依赖真 Cesium */
    window.viewer = {
      isDestroyed: function () { return false },
      entities: { values: function () { return [{ id: 'SAT-1' }, { id: 'SAT-2' }] } },
      scene: { primitives: { length: function () { return 3 } }, renderError: false },
      camera: { positionCartographic: { x: 1.2, y: 0.5, height: 1200 } },
      canvas: { width: 1280, height: 720 },
      dataSources: { length: function () { return 0 } }
    }
    var keys = 0
    document.addEventListener('keydown', function () { keys += 1; document.getElementById('keys').textContent = String(keys) })
    document.getElementById('btn').addEventListener('click', function () { document.getElementById('out').textContent = 'clicked' })
    document.getElementById('errBtn').addEventListener('click', function () { console.error('boom-test-error') })
    var xhr = new XMLHttpRequest() /* 404：给 network_clean 的负面用例当靶子（用 XHR，win7 守卫禁 Node 侧 fetch 字样） */
    xhr.open('GET', '/missing-on-purpose', true)
    xhr.send()
  </script>
</body></html>`

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url === '/missing-on-purpose') {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('nope')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(TEST_PAGE)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function main() {
  const server = await startServer()
  const port = server.address().port
  const pageUrl = 'http://127.0.0.1:' + port + '/'
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-smoke-'))
  console.log('test page: ' + pageUrl)
  console.log('workspace: ' + workspace)

  let electronPath = ''
  try {
    const candidate = require('electron')
    if (typeof candidate === 'string' && fs.existsSync(candidate)) electronPath = candidate
  } catch (error) { /* 裸 Node 下拿不到，走 path.txt */ }
  if (not(electronPath)) {
    const pathFile = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt')
    if (fs.existsSync(pathFile)) {
      const relative = fs.readFileSync(pathFile, 'utf8').trim()
      const candidate = path.join(__dirname, '..', 'node_modules', 'electron', relative)
      if (fs.existsSync(candidate)) electronPath = candidate
    }
  }
  if (not(electronPath)) {
    console.log('FATAL cannot locate electron binary (node_modules/electron missing?)')
    process.exit(1)
  }

  const driver = new BrowserDriver({})
  let exitSeen = false
  driver.onExited = () => { exitSeen = true }

  try {
    const launched = await driver.launch(pageUrl, {
      electronPath: electronPath,
      noSandbox: process.env.SMOKE_NO_SANDBOX === '1',
      width: 1100,
      height: 700
    })
    ok('启动：DevTools 端口解析出来', launched.port > 0, 'port=' + launched.port)
    ok('启动：isOpen', driver.isOpen)

    await driver.wait('#btn', 15000)
    ok('等待：#btn 出现（页面真的加载了）', true)

    await driver.click('#btn')
    const out = await driver.getText('#out')
    ok('点击：#out 变 clicked（真鼠标事件走通）', out.text === 'clicked', out.text)

    await driver.input('#inp', 'hello via CDP')
    const value = await driver.evaluate('document.getElementById("inp").value')
    ok('输入：insertText 落进输入框', value === 'hello via CDP', JSON.stringify(value))

    await driver.keypress('Enter')
    const keys = await driver.evaluate('document.getElementById("keys").textContent')
    ok('按键：Enter 派发到页面', keys === '1', 'keys=' + keys)

    const href = await driver.url()
    ok('URL 读取', href.indexOf('127.0.0.1:' + port) !== -1, href)

    const shot = await driver.screenshot()
    ok('截图：返回 base64 PNG', typeof shot === 'string' && shot.slice(0, 8) === 'iVBORw0K', String(shot).slice(0, 12))
    const shotPath = path.join(workspace, 'test-artifacts', 'smoke.png')
    fs.mkdirSync(path.dirname(shotPath), { recursive: true })
    fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'))
    ok('截图：落盘成功', fs.existsSync(shotPath) && fs.statSync(shotPath).size > 500, String(fs.statSync(shotPath).size))

    /* ---- test_run：正面用例（DOM/eval/Cesium 全过）---- */
    const positive = await require('../src/main/agent/test-runner').runSuite(driver, [{
      name: 'positive-case',
      url: pageUrl,
      steps: [
        { action: 'click', selector: '#btn' },
        { action: 'wait', selector: '#out' }
      ],
      assertions: [
        { type: 'element_exists', selector: '#out' },
        { type: 'text_matches', selector: '#out', pattern: 'clicked' },
        { type: 'element_state', selector: '#btn', property: 'tagName', equals: 'BUTTON' },
        { type: 'url_matches', pattern: '127\\.0\\.0\\.1' },
        { type: 'eval_expr', expression: 'window.viewer.entities.values().length', equals: 2 },
        { type: 'eval_expr', expression: 'window.viewer.camera.positionCartographic.height', equals: 1200 },
        { type: 'cesium_viewer', initialized: true, minEntities: 2, maxEntities: 10, cameraSet: true, noSceneError: true },
        { type: 'cesium_has_entity', name: 'SAT-1' },
        { type: 'cesium_has_entity', name: 'SAT-999', negate: true }
      ]
    }], {})
    ok('test_run：正面用例判定 PASS', positive.suite.status === 'PASS' && positive.suite.passed === 1,
      compactSuite(positive.suite).split('\n')[0])

    /* ---- test_run：负面用例（故意触发 console.error，报告必须抓到）----
       不带 url：不复导航，避免把页面加载期那次 404 混进本用例增量；
       点击后 settle 400ms 再断言 —— console.error 事件到达 CDP 客户端有几十毫秒延迟。 */
    const negative = await require('../src/main/agent/test-runner').runSuite(driver, [{
      name: 'negative-case',
      steps: [
        { action: 'click', selector: '#errBtn' },
        { action: 'eval', expression: 'new Promise(function(r){setTimeout(r,400)})', awaitPromise: true }
      ],
      assertions: [
        { type: 'console_clean' }
      ]
    }], {})
    ok('test_run：负面用例判定 FAIL', negative.suite.status === 'FAIL' && negative.suite.failed === 1,
      compactSuite(negative.suite))
    const negReport = negative.suite.cases[0]
    const consoleAssert = negReport.assertions.find((item) => item.type === 'console_clean')
    ok('采集：console.error 被抓到（boom-test-error）',
      consoleAssert && not(consoleAssert.ok) && consoleAssert.actual.indexOf('boom-test-error') !== -1,
      consoleAssert ? consoleAssert.actual.slice(0, 80) : 'missing')
    ok('增量：负面用例的 consoleErrors 只算本用例的（恰好 1 条 boom）',
      negReport.consoleErrors.length === 1 && negReport.consoleErrors[0].text.indexOf('boom-test-error') !== -1,
      JSON.stringify(negReport.consoleErrors).slice(0, 120))

    const allowRun = await require('../src/main/agent/test-runner').runSuite(driver, [{
      name: 'allow-404',
      url: pageUrl,
      steps: [{ action: 'eval', expression: 'new Promise(function(r){setTimeout(r,400)})', awaitPromise: true }],
      assertions: [{ type: 'network_clean', allowStatus: [404] }]
    }], {})
    ok('采集：404 真的被抓到了（绝对断言，不是 allowStatus 假绿）',
      driver.networkErrors.some((item) => item.status === 404 && item.url.indexOf('missing-on-purpose') !== -1),
      JSON.stringify(driver.networkErrors).slice(0, 120))
    ok('test_run：network_clean 放行 allowStatus 后（历史错误不计入增量）',
      allowRun.suite.status === 'PASS', compactSuite(allowRun.suite))

    await driver.close()
    ok('关闭：close() 正常返回', true)
  } catch (error) {
    failed += 1
    failures.push('(fatal) ' + error.message)
    console.log('FATAL ' + error.stack)
  } finally {
    await driver.close().catch(() => undefined)
    server.close()
  }

  console.log('')
  console.log('browser driver smoke: ' + passed + '/' + (passed + failed) + ' checks passed' +
    (failed ? ', ' + failed + ' FAILED\n' + failures.join('\n') : ''))
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error.stack)
  process.exit(1)
})
