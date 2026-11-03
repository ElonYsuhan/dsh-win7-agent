'use strict'
/*
 * 真窗口探针：输入框换行语义（2026-11-03 用户反馈）
 *   - Ctrl+Enter 另起一行，不再直接发送
 *   - Shift+Enter 同样另起一行
 *   - 新行必须是「没有任何样式」的干净块：粘贴进来的 <h2>/<strong>/<em> 不能被继承
 *   - 粘贴进来的富文本本身要原样保留（不然用户看不出哪段是复制的）
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

let passed = 0
let failed = 0
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('PASS  ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 300) + ']' : '')) }
  else { failed += 1; console.log('FAIL  ' + name + '  [' + String(detail).slice(0, 400) + ']') }
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
    http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b })) }).on('error', reject)
  })
}
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    req.on('error', reject); req.write(data); req.end()
  })
}
function electronPath() {
  const txt = fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
  return path.join(ROOT, 'node_modules/electron/dist', txt)
}

const REPLY = 'ok'

async function main() {
  const mock = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const mockPort = await freePort()
  await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r))

  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nl-home-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nl-ws-'))
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), AGENT_HOME: home }), stdio: ['ignore', 'pipe', 'pipe']
  })
  let logs = ''
  child.stdout.on('data', (c) => { logs += c.toString() })
  child.stderr.on('data', (c) => { logs += c.toString() })
  const base = 'http://127.0.0.1:' + port
  for (let i = 0; i < 60; i += 1) {
    try { const r = await get(base + '/api/health'); if (r.status === 200) break } catch (e) {}
    await sleep(250)
  }
  await postJson(base + '/api/settings', {
    models: [{ id: 'mock', name: 'Mock', baseURL: 'http://127.0.0.1:' + mockPort + '/v1', apiKey: 'k', model: 'mock-1', modelList: ['mock-1'] }],
    currentModelId: 'mock', workspacePath: workspace,
    projects: [{ id: 'p_c', name: 'C', folders: [workspace] }], currentProjectId: 'p_c'
  })

  const driver = new BrowserDriver({})
  try {
    await driver.launch(base + '/', { electronPath: electronPath(), width: 1180, height: 900, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    const evalJs = (expr) => driver.evaluate(expr)
    async function evalAsync(expr) {
      await evalJs('window.__r = undefined; (async function(){ try { window.__r = await (' + expr + ') } catch (e) { window.__r = "ERR " + e.name + ": " + e.message } })(); "queued"')
      for (let i = 0; i < 40; i += 1) {
        const v = await evalJs('window.__r === undefined ? null : String(window.__r)')
        if (v !== null) return v
        await sleep(150)
      }
      return '(timeout)'
    }
    for (let i = 0; i < 60; i += 1) {
      if (await evalJs('document.getElementById("input") !== null')) break
      await sleep(300)
    }
    ok('界面加载完成', true)
    /* 输入框的 keydown 在 init() 的后半段才挂上：界面 DOM 有了不代表监听器就绪，
       这里等一下，否则第一发 Ctrl+Enter 会被丢掉（真窗口里表现为「没反应」）。 */
    await sleep(2500)




    /* ---------- 输入框换行 ---------- */
    await evalJs([
      "(function(){",
      "  var el = document.getElementById('input')",
      "  el.innerHTML = '<h2>复制的标题</h2><p><strong>粗体段落</strong></p>'",
      "  el.focus()",
      "  var t = el.querySelector('p strong').firstChild",
      "  var r = document.createRange(); r.setStart(t, t.length); r.collapse(true)",
      "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r)",
      "  return 'ok'",
      "})()",
    ].join('\n'))

    const pressEnter = (extra) => evalJs("(function(){var el=document.getElementById('input');var e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true," + extra + "});el.dispatchEvent(e);return 'sent'})()")

    await pressEnter('ctrlKey:true')
    await sleep(250)
    const st1 = JSON.parse(String(await evalJs(
      "(function(){var s=window.getSelection();var n=s.anchorNode;var el=n&&n.nodeType===3?n.parentNode:n;var inp=document.getElementById('input');return JSON.stringify({caretInStrong: !!(el&&el.closest&&el.closest('strong')),blocks:Array.prototype.map.call(inp.children,function(c){return c.tagName}).join(','),msgs:document.querySelectorAll('.bubble').length})})()"
    )))
    ok('Ctrl+Enter 另起一行（不发送）', st1.caretInStrong === false && st1.blocks.indexOf('DIV') !== -1, JSON.stringify(st1))

    await evalJs("document.execCommand('insertText', false, '我自己写的一行')")
    await sleep(250)
    const typed2 = JSON.parse(String(await evalJs(
      "(function(){var el=document.getElementById('input');var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null);var n=null;while(w.nextNode()){if(w.currentNode.nodeValue.indexOf('我自己写的一行')!==-1){n=w.currentNode;break}}if(!n)return JSON.stringify({found:false});return JSON.stringify({found:true,parent:n.parentNode.tagName,weight:getComputedStyle(n.parentNode).fontWeight,text:el.innerText})})()"
    )))
    ok('自己写的那行是正文字重（不带粗体/标题样式）', typed2.found === true && typed2.weight === '400', JSON.stringify(typed2))
    ok('粘贴内容保留、两段在纯文本里分开', typed2.found === true && typed2.text.indexOf('复制的标题') === 0 && typed2.text.indexOf('我自己写的一行') > typed2.text.indexOf('粗体段落'), JSON.stringify(typed2.text))

    /* Shift+Enter 同样干净 */
    await evalJs([
      "(function(){",
      "  var el = document.getElementById('input')",
      "  el.innerHTML = '<p><em>斜体来源</em></p>'",
      "  el.focus()",
      "  var t = el.querySelector('em').firstChild",
      "  var r = document.createRange(); r.setStart(t, t.length); r.collapse(true)",
      "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r)",
      "  return 'ok'",
      "})()",
    ].join('\n'))
    await pressEnter('shiftKey:true')
    await sleep(250)
    const st2 = JSON.parse(String(await evalJs(
      "(function(){var s=window.getSelection();var n=s.anchorNode;var el=n&&n.nodeType===3?n.parentNode:n;return JSON.stringify({caretInEm: !!(el&&el.closest&&el.closest('em')),html:document.getElementById('input').innerHTML})})()"
    )))
    ok('Shift+Enter 也另起一行且不带斜体', st2.caretInEm === false && st2.html.indexOf('<div') !== -1, JSON.stringify(st2))

    const shot = await driver.screenshot().catch(() => '')
    if (shot) fs.writeFileSync(path.join(OUT, 'composer-plain-line.png'), Buffer.from(shot, 'base64'))


  } finally {
    await driver.close().catch(() => {})
    child.kill('SIGKILL')
    mock.close()
  }
  console.log('composer newline smoke: ' + passed + '/' + (passed + failed) + ' checks passed')
  if (failed > 0) process.exitCode = 1
}
main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1) })
