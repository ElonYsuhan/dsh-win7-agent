'use strict'
/**
 * 真窗口探针：知识库面板（2026-11-03 用户反馈四点）
 *  1. 详情视图顶部「返回」按钮换成左箭头图标 + 文案「全部知识库」（不再用文本 ←）
 *  2. 导入区并排「添加资料」与「添加文件夹」两个按钮
 *  3. 删除「每文件最多 8MB」提示文案
 *  4. 预览区/来源区空状态：文件图标在上、文案水平+垂直居中
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

let passed = 0, failed = 0
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('PASS  ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 200) + ']' : '')) }
  else { failed += 1; console.log('FAIL  ' + name + '  [' + String(detail).slice(0, 260) + ']') }
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
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', reject); req.write(data); req.end()
  })
}
function electronPath() {
  const txt = fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
  return path.join(ROOT, 'node_modules/electron/dist', txt)
}

const MEASURE = `(function () {
  function r(el){ if(!el) return null; var x=el.getBoundingClientRect(); return {top:x.top,bottom:x.bottom,left:x.left,right:x.right,width:x.width,height:x.height} }
  var back=document.getElementById('knowledgeOverview')
  var backIcon=back?back.querySelector('.icon svg'):null
  var row=document.getElementById('knowledgeImportRow')
  var fileBtn=document.getElementById('knowledgeImport')
  var folderBtn=document.getElementById('knowledgeImportFolder')
  var body=document.getElementById('knowledgePreviewBody')
  var empty=body?body.querySelector('.knowledge-empty-state'):null
  var emptyIcon=empty?empty.querySelector('.icon svg'):null
  var emptyP=empty?empty.querySelector('p'):null
  var src=document.getElementById('knowledgeSource')
  var srcEmpty=src?src.querySelector('.knowledge-empty-state'):null
  return JSON.stringify({
    backDisplay: back?getComputedStyle(back).display:null,
    backHasIcon: !!backIcon,
    backText: back?back.textContent.trim():null,
    rowDisplay: row?getComputedStyle(row).display:null,
    fileBtnExists: !!fileBtn,
    folderBtnExists: !!folderBtn,
    fileBtnDisabled: fileBtn?fileBtn.disabled:null,
    folderBtnDisabled: folderBtn?folderBtn.disabled:null,
    folderBtnHeight: r(folderBtn)?Math.round(r(folderBtn).height):null,
    emptyExists: !!empty,
    emptyIconExists: !!emptyIcon,
    emptyText: emptyP?emptyP.textContent:null,
    emptyJustify: empty?getComputedStyle(empty).justifyContent:null,
    emptyAlign: empty?getComputedStyle(empty).alignItems:null,
    srcEmptyExists: !!srcEmpty,
    hintExists: !!document.getElementById('knowledgeUploadHint')
  })
})()`

async function main() {
  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kb-home-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kb-ws-'))
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
    try { const r = await get(base + '/api/health'); if (r.status === 200) { up = true; break } } catch (e) {}
    await sleep(250)
  }
  ok('服务起来了', up, logs.slice(-160))
  if (!up) throw new Error('服务没起来')

  await postJson(base + '/api/settings', {
    models: [{ id: 'mock', name: 'Mock', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', modelList: ['m'] }],
    currentModelId: 'mock',
    workspacePath: workspace,
    projects: [{ id: 'p_kb', name: '知识库验证', folders: [workspace] }],
    currentProjectId: 'p_kb'
  })

  const driver = new BrowserDriver({})
  try {
    await driver.launch(base + '/', { electronPath: electronPath(), width: 1180, height: 860, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    const evalJs = (e) => driver.evaluate(e)
    let ready = false
    for (let i = 0; i < 50; i += 1) { if (await evalJs('document.getElementById("openLibrary") !== null') === true) { ready = true; break } await sleep(300) }
    ok('界面加载完成', ready)
    await sleep(400)

    await evalJs('document.getElementById("openLibrary").click()')
    await sleep(700)
    ok('知识库面板打开', await evalJs('!document.getElementById("knowledgePage").classList.contains("hidden")') === true)

    await evalJs('var b=document.getElementById("knowledgeNew"); if(b) b.click()')
    await sleep(400)
    await evalJs('var n=document.getElementById("knowledgeName"); n.value="验证知识库"; n.dispatchEvent(new Event("input",{bubbles:true}))')
    await sleep(200)
    await evalJs('var f=document.getElementById("knowledgeCreate"); if(f.requestSubmit){f.requestSubmit()}else{f.dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}))}')
    await sleep(1800)
    await evalJs('var c=document.querySelector(".knowledge-card"); if(c) c.click()')
    await sleep(900)
    ok('进入详情视图', await evalJs('!document.getElementById("knowledgeDetail").classList.contains("hidden")') === true)

    const m = JSON.parse(String(await evalJs(MEASURE)))
    const shot = await driver.screenshot().catch(() => '')
    if (shot) fs.writeFileSync(path.join(OUT, 'knowledge-detail.png'), Buffer.from(shot, 'base64'))

    ok('返回按钮含左箭头图标（data-icon=back 已渲染成 svg）', m.backHasIcon === true)
    ok('返回按钮为弹性容器（图标+文字并排）', m.backDisplay === 'flex' || m.backDisplay === 'inline-flex', m.backDisplay)
    ok('返回按钮文案为「全部知识库」', m.backText === '全部知识库', m.backText)
    ok('导入按钮行横向排列', m.rowDisplay === 'flex', m.rowDisplay)
    ok('存在「添加资料」按钮', m.fileBtnExists === true)
    ok('存在「添加文件夹」按钮', m.folderBtnExists === true)
    ok('两个导入按钮都启用（已选中知识库）', m.fileBtnDisabled === false && m.folderBtnDisabled === false, 'file=' + m.fileBtnDisabled + ' folder=' + m.folderBtnDisabled)
    ok('添加文件夹按钮单行不换行（高度≈36px）', m.folderBtnHeight !== null && Math.abs(m.folderBtnHeight - 36) <= 1, m.folderBtnHeight)
    ok('空状态出现在预览区', m.emptyExists === true)
    ok('空状态含文件图标', m.emptyIconExists === true)
    ok('空状态文案为「选择左侧文件以预览资料」', m.emptyText === '选择左侧文件以预览资料', m.emptyText)
    ok('空状态垂直居中（justify-content center）', m.emptyJustify === 'center', m.emptyJustify)
    ok('空状态水平居中（align-items center）', m.emptyAlign === 'center', m.emptyAlign)
    ok('来源区空状态也带图标（clearResults 路径）', m.srcEmptyExists === true)
    ok('8MB 提示文案已删除', m.hintExists === false)
  } finally {
    try { await driver.close() } catch (e) {}
    child.kill('SIGKILL')
  }
  console.log('\n==== ' + passed + ' passed, ' + failed + ' failed ====')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
