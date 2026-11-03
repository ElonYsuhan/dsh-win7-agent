'use strict'
/**
 * 真窗口探针：折叠条摘要行（2026-11-03 用户反馈三点）
 *  1. 前面必须是 ▸/▾ 折叠图标（不是被转圈顶掉）
 *  2. 转圈挪到「正在处理 · N 步」后面，而且是活的（动画不被重置）
 *  3. 运行中右侧耗时一直在走，不是空白
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

const CHUNKS = [
  '先说结论：', 'cesium 有一批和 AI 相关的新动静。', '\n\n### 1. 版本线\n',
  'CesiumJS 1.x 仍按月度发版，', '最近几版的重点在 3D Tiles 与光影。\n\n',
  '### 2. AI 相关\n', '官方没有把 LLM 塞进引擎，', '但在 3D Tiles 生成侧引入了模型辅助。\n\n',
  '### 3. 建议\n', '- 关注 3D Tiles 1.1 的 metadata\n', '- 观察生态里的 AI 插件\n\n',
  '最后提醒一句：具体版本号以 npm 上的 latest 为准。'
]

async function main() {
  /* ---- mock 模型：慢速流式，让思考步骤持续 running ---- */
  let mockTick = 0
  const mock = http.createServer((req, res) => {
    console.log('[mock] ' + req.method + ' ' + req.url)
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      let i = 0
      const timer = setInterval(() => {
        if (i >= CHUNKS.length) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
          clearInterval(timer)
          return
        }
        const piece = CHUNKS[i]
        i += 1
        mockTick += 1
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece }, index: 0 }] }) + '\n\n')
      }, 900)
      res.on('close', () => clearInterval(timer))
    })
  })
  const mockPort = await freePort()
  await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r))

  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tl-home-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tl-ws-'))
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

  await postJson(base + '/api/settings', {
    models: [{ id: 'mock', name: 'Mock', baseURL: 'http://127.0.0.1:' + mockPort + '/v1', apiKey: 'k', model: 'mock-1', modelList: ['mock-1'] }],
    currentModelId: 'mock',
    workspacePath: workspace,
    projects: [{ id: 'p_tl', name: 'TL', folders: [workspace] }],
    currentProjectId: 'p_tl'
  })

  const driver = new BrowserDriver({})
  try {
    await driver.launch(base + '/', { electronPath: electronPath(), width: 1180, height: 860, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    const evalJs = (expr) => driver.evaluate(expr)

    let ready = false
    for (let i = 0; i < 50; i += 1) {
      const has = await evalJs('document.getElementById("input") !== null && document.getElementById("send") !== null')
      if (has === true) { ready = true; break }
      await sleep(300)
    }
    ok('界面加载完成', ready)
    if (!ready) throw new Error('界面没起来')

    /* 内容可编辑框要先 focus 再 insertText，否则 click 落点被空态卡片挡掉、
       插进去的是空气，Enter 时 sendMessage 读到空串直接 return。 */
    const TEXT = 'cesium 有新版本吗，和 AI 有关的'
    let typed = ''
    for (let i = 0; i < 4; i += 1) {
      await evalJs("(function(){var el=document.getElementById('input');el.focus();el.scrollIntoView({block:'center'});return 'ok'})()")
      await sleep(250)
      await driver.input('#input', TEXT)
      await sleep(350)
      typed = String(await evalJs("document.getElementById('input').innerText"))
      if (typed.indexOf('cesium') !== -1) break
    }
    console.log('[typed] ' + JSON.stringify(typed))
    console.log('[send] ' + JSON.stringify(await driver.keypress('enter')))

    await sleep(1500)
    const diag = String(await evalJs("JSON.stringify({input: document.getElementById('input').innerText, modal: document.getElementById('settingsModal').className, msgs: document.getElementById('messagesInner').innerText.slice(0, 300), status: document.getElementById('statusLine') ? document.getElementById('statusLine').textContent : ''})"))
    console.log('[diag] ' + diag)

    /* 等折叠条出现 */
    let appeared = false
    for (let i = 0; i < 60; i += 1) {
      const has = await evalJs('document.querySelector(".process-timeline") !== null')
      if (has === true) { appeared = true; break }
      await sleep(250)
    }
    ok('折叠条已出现', appeared)

    const readSummary = `(function(){
      var d = document.querySelector('.process-timeline');
      if (!d) return JSON.stringify({ err: 'no-block' });
      var s = d.querySelector('summary');
      var cs = getComputedStyle(s, '::before');
      var ch = s.querySelector('.timeline-summary-chevron');
      var chcs = ch ? getComputedStyle(ch) : null;
      var sp = s.querySelector('.timeline-summary-spinner');
      var t = s.querySelector('.timeline-summary-title');
      var tm = s.querySelector('.timeline-summary-time');
      var spcs = sp ? getComputedStyle(sp) : null;
      return JSON.stringify({
        before: cs.content,
        open: d.hasAttribute('open'),
        active: d.classList.contains('thinking-active'),
        title: t ? t.textContent : '',
        time: tm ? tm.textContent : '',
        order: Array.prototype.map.call(s.children, function (c) { return c.className }).join(' > '),
        chevron: !!ch,
        chevronSvg: !!(ch && ch.querySelector('svg')),
        chevronTransform: chcs ? chcs.transform : 'no-el',
        chevronColor: chcs ? chcs.color : '',
        spinnerDisplay: spcs ? spcs.display : 'no-el',
        spinnerW: spcs ? spcs.width : '',
        spinnerTransform: spcs ? spcs.transform : '',
        spinnerBorder: spcs ? spcs.borderTopColor + '/' + spcs.borderLeftColor : ''
      });
    })()`

    /* 运行中采样：读两次，确认时间在走、动画在转 */
    let s1 = null
    let s2 = null
    let midShot = ''
    let stillRunning = false
    for (let i = 0; i < 40; i += 1) {
      const running = await evalJs('document.querySelector(".process-timeline.thinking-active") !== null')
      if (running === true) {
        stillRunning = true
        s1 = JSON.parse(String(await evalJs(readSummary)))
        await sleep(1200)
        s2 = JSON.parse(String(await evalJs(readSummary)))
        midShot = await driver.screenshot().catch(() => '')
        break
      }
      await sleep(300)
    }
    ok('抓到运行中的状态', stillRunning && s1 && s2, JSON.stringify(s1))
    if (!stillRunning) throw new Error('没抓到运行中')

    /* 2026-11-03 用户反馈「运行的时候整个小标在转圈」「整个下拉图标不好看」：
       ▸/▾ 是文本字符（缺字形时是方框套三角），且 thinking-active 那条老规则会把
       ::before 换成转圈圆环。现在箭头是独立 SVG 节点，::before 必须计算值为 none。 */
    ok('折叠箭头是图标库 chevron（::before 已置空，不再显示文本字符）',
      (s1.before === 'none' || s1.before === '"none"') && s1.chevron === true && s1.chevronSvg === true,
      'before=' + s1.before + ' chevron=' + s1.chevron + ' svg=' + s1.chevronSvg)
    ok('转圈在标题后面（DOM 顺序 chevron > title > spinner > time）',
      s1.order.indexOf('timeline-summary-chevron') === 0
      && s1.order.indexOf('timeline-summary-title') > 0
      && s1.order.indexOf('timeline-summary-spinner') > 0
      && s1.order.indexOf('timeline-summary-time') > s1.order.indexOf('timeline-summary-spinner'), s1.order)
    ok('转圈可见且是完整圆环（12px，环体半透明蓝）',
      s1.spinnerDisplay === 'block' && s1.spinnerW === '12px' && s1.spinnerBorder.indexOf('rgba(67, 136, 245') !== -1,
      s1.spinnerDisplay + ' | ' + s1.spinnerW + ' | ' + s1.spinnerBorder)
    ok('转圈真的在转（两次采样的 transform 不同 → 动画没被重建打断）',
      s1.spinnerTransform !== s2.spinnerTransform, s1.spinnerTransform + ' -> ' + s2.spinnerTransform)
    ok('转的只有那个 12px 圆环，箭头本身不参与动画',
      s1.chevronTransform === s2.chevronTransform, s1.chevronTransform + ' -> ' + s2.chevronTransform)
    ok('标题写「正在处理」', s1.title.indexOf('正在处理') !== -1, s1.title)
    ok('运行中右侧耗时不是空的', s1.time !== '' && /[0-9]/.test(s1.time), 't1=' + s1.time + ' t2=' + s2.time)
    ok('运行中耗时在走（第二次比第一次大）',
      (parseFloat(s2.time) || 0) > (parseFloat(s1.time) || 0) || (s2.time.indexOf('m') !== -1),
      s1.time + ' -> ' + s2.time)

    if (midShot) fs.writeFileSync(path.join(OUT, 'timeline-running.png'), Buffer.from(midShot, 'base64'))

    /* 等收尾 */
    let done = false
    for (let i = 0; i < 90; i += 1) {
      const running = await evalJs('document.querySelector(".process-timeline.thinking-active") !== null')
      if (running === false) { done = true; break }
      await sleep(400)
    }
    ok('最终收尾（不再 thinking-active）', done)
    const s3 = JSON.parse(String(await evalJs(readSummary)))
    ok('收尾后箭头照旧在、转圈隐藏、时间是总量',
      (s3.before === 'none' || s3.before === '"none"') && s3.chevron === true
      && s3.spinnerDisplay === 'none' && s3.time !== '',
      JSON.stringify(s3))
    const doneShot = await driver.screenshot().catch(() => '')
    if (doneShot) fs.writeFileSync(path.join(OUT, 'timeline-done.png'), Buffer.from(doneShot, 'base64'))
  } finally {
    await driver.close().catch(() => {})
    child.kill('SIGKILL')
    mock.close()
  }

  console.log('\ntimeline probe: ' + passed + '/' + (passed + failed) + ' checks passed')
  if (failed > 0) process.exit(1)
}

main().catch((err) => { console.error('PROBE ERROR: ' + (err && err.stack || err)); process.exit(1) })
