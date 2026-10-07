'use strict'

/**
 * self-validate-smoke：自我验证闭环 P0 的真机冒烟 —— 进程生命周期 + 就绪等待 + 验证账本。
 *
 * 全链路用真东西：真 spawn 一个 node 服务（监听随机端口）、真轮询 HTTP 就绪、
 * 真读 stdout、真杀进程树、真校验端口关闭；账本走真文件（临时工作区）。
 * 插件注册那层也验：PluginHost + self-validate 插件 → 6 个工具可被模型看到、能执行。
 *
 * 不需要 Electron，所以进默认 check 链。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { ProcessManager, waitReady } = require('../src/main/agent/process-manager')
const { initLedger, appendLedger, readLedger, slugify } = require('../src/main/agent/validation-ledger')

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

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function portClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: port })
    let settled = false
    const finish = (closed) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch (error) { /* 忽略 */ }
      resolve(closed)
    }
    socket.setTimeout(1500, () => finish(false) /* 连不上就是"已关闭"，这里超时算开着 */)
    socket.on('connect', () => finish(false))
    socket.on('error', () => finish(true))
  })
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selfvalidate-'))
  /* 被测服务：把端口与启动日志交给宿主校验 */
  fs.writeFileSync(path.join(workspace, 'server.js'), [
    'const http = require("http")',
    'const port = Number(process.argv[2])',
    'const server = http.createServer((request, response) => {',
    '  if (request.url === "/health") { response.writeHead(200, {"Content-Type": "application/json"}); response.end(JSON.stringify({ok: true})); return }',
    '  if (request.url === "/boom") { response.writeHead(500); response.end("boom"); return }',
    '  response.writeHead(200); response.end("hi")',
    '})',
    'server.listen(port, "127.0.0.1", () => console.log("listening on " + port))',
    'setInterval(() => {}, 1000)',
    ''
  ].join('\n'), 'utf8')

  const port = await freePort()
  const manager = new ProcessManager({ workspaceRoot: workspace })
  const nodePath = process.execPath

  try {
    /* ---- 进程生命周期 ---- */
    const started = manager.start({ name: 'dev', command: '"' + nodePath + '" server.js ' + port })
    ok('start_process：后台起进程拿到 pid', started.pid > 0 && started.name === 'dev', JSON.stringify(started))

    const ready = await waitReady({ url: 'http://127.0.0.1:' + port + '/health', timeoutMs: 15000 })
    ok('wait_ready：服务起来后立刻返回 ready（带 2xx 状态码）',
      ready.ready === true && ready.status === 200, JSON.stringify(ready))

    const logs = manager.logs('dev', { tail: 20 })
    ok('process_logs：抓到启动日志（stdout 环形缓冲）',
      logs.text.indexOf('listening on ' + port) !== -1, JSON.stringify(logs.text.slice(0, 120)))

    const list = manager.list()
    ok('list_processes：报得出在跑的名字/pid/命令',
      list.length === 1 && list[0].name === 'dev' && list[0].running === true && list[0].command.indexOf('server.js') !== -1,
      JSON.stringify(list))

    let duplicate = ''
    try {
      manager.start({ name: 'dev', command: '"' + nodePath + '" server.js ' + port })
    } catch (error) {
      duplicate = error.message
    }
    ok('同名重复启动被拦住（提示先 stop）', duplicate.indexOf('PROCESS_EXISTS') === 0, duplicate)

    let badName = ''
    try {
      manager.start({ name: '../evil', command: 'echo hi' })
    } catch (error) {
      badName = error.message
    }
    ok('进程名白名单挡住路径穿越（../evil）', badName.indexOf('BAD_PROCESS_NAME') === 0, badName)

    let badCwd = ''
    try {
      manager.start({ name: 'escape', command: 'echo hi', cwd: '../../..' })
    } catch (error) {
      badCwd = error.message
    }
    ok('cwd 越界被 path-guard 拦住', badCwd.indexOf('PATH_ESCAPE') === 0, badCwd)

    /* 500 也是「起来了」：状态码要带回来，别和服务没起来混为一谈 */
    const boom = await waitReady({ url: 'http://127.0.0.1:' + port + '/boom', timeoutMs: 5000 })
    ok('wait_ready：接口 500 也算 ready（区分"没起来"和"起来了但报错"）',
      boom.ready === true && boom.status === 500, JSON.stringify(boom))

    /* ---- 重启（改完代码的常态动作）---- */
    const stopped = await manager.stop('dev')
    ok('stop_process：进程真的停了', stopped.stopped === true, JSON.stringify(stopped))
    const closed = await portClosed(port)
    ok('stop 之后端口真的关了（不是只标记）', closed === true, 'port=' + port)

    const restart = await waitReady({ url: 'http://127.0.0.1:' + port + '/health', timeoutMs: 2000, intervalMs: 200 })
    ok('停掉之后 wait_ready 如实报 not ready（不会假绿）',
      restart.ready === false && Boolean(restart.lastError || restart.note), JSON.stringify(restart).slice(0, 160))

    let unknown = ''
    try {
      await manager.stop('never-started')
    } catch (error) {
      unknown = error.message
    }
    ok('只能停自己启动的进程（没启过的名字直接拒）', unknown.indexOf('PROCESS_NOT_FOUND') === 0, unknown)

    const restartStart = manager.start({ name: 'dev2', command: '"' + nodePath + '" server.js ' + port })
    ok('停掉之后同名/新名可再次启动（重启路径可用）', restartStart.pid > 0, 'pid=' + restartStart.pid)
    await manager.stopAll()
    ok('stopAll：收尾把所有自己起的都收掉',
      manager.list().every((item) => item.running === false), JSON.stringify(manager.list()))

    /* ---- 就绪等待的失败路径 ---- */
    const deadPort = await freePort()
    const deadStart = Date.now()
    const notReady = await waitReady({ port: deadPort, timeoutMs: 1200, intervalMs: 200 })
    ok('wait_ready：服务压根没起 → ready=false 且耗时约等于超时（不早退不装死）',
      notReady.ready === false && Date.now() - deadStart >= 1000, JSON.stringify(notReady).slice(0, 160))

    /* ---- 验证账本 ---- */
    const task = '修复新增卫星后场景不显示'
    const init = initLedger(workspace, task, {
      requirement: '修复新增卫星后场景不显示的问题，并验证功能。',
      criteria: ['POST /api/satellite 返回 200', '列表里多出一行', 'console 无报错']
    })
    ok('账本 init：建在 .agent/validation/ 下且带验收标准清单',
      init.created === true && init.path.indexOf('.agent/validation/') === 0
        && init.text.indexOf('- [ ] POST /api/satellite 返回 200') !== -1,
      init.path)

    const again = initLedger(workspace, task, { criteria: ['别的标准'] })
    ok('账本 init 幂等：已存在不覆盖（append-only 底线）',
      again.created === false && readLedger(workspace, task).text.indexOf('别的标准') === -1, '')

    appendLedger(workspace, task, '轮次 1：test_run → FAIL（断言 eval_expr entities=1，期望 2）；证据：TestReport + 截图。下一步：查新增流程是否漏 add。')
    const after = readLedger(workspace, task)
    ok('账本 append：追加轮次记录（带时间戳）且不丢原有内容',
      after.text.indexOf('验收标准') !== -1 && after.text.indexOf('轮次 1：') !== -1
        && after.text.indexOf('### 20') !== -1,
      after.bytes + ' bytes')

    let emptyCriteria = ''
    try {
      initLedger(workspace, '另一个任务', { requirement: 'x' })
    } catch (error) {
      emptyCriteria = error.message
    }
    ok('账本拒绝"没有验收标准"的任务（判不了的句子不算标准）',
      emptyCriteria.indexOf('LEDGER_NO_CRITERIA') === 0, emptyCriteria)

    ok('账本文件名做 slug 化（中文/空格/斜杠都安全）',
      slugify('修复 新增卫星/后 不显示') === '修复-新增卫星-后-不显示', slugify('修复 新增卫星/后 不显示'))

    const missing = readLedger(workspace, '从没建过的任务')
    ok('读不存在的账本如实报 not found（不编内容）',
      missing.exists === false, missing.path)

    /* ---- 插件注册层：工具真的能被模型看到并执行 ---- */
    const { PluginHost } = require('../src/main/plugins/plugin-host')
    const plugin = require('../src/main/plugins/builtins/self-validate')
    const host = new PluginHost({ workspaceRoot: workspace, settings: { data: {}, permissionMode: 'full' } })
    host.use(plugin)
    const names = plugin.PROCESS_TOOLS.map((item) => item.name)
    const registered = new Set(host.tools.list().map((item) => item.name))
    const allRegistered = names.every((name) => registered.has(name))
    ok('插件注册：6 个自验证工具都注册进 registry',
      allRegistered && names.length === 6, names.join(','))

    const toolCtx = { workspaceRoot: workspace, settings: { permissionMode: 'full' }, agent: { }, approve: async () => true }
    const startOut = await host.tools.execute('start_process', { name: 'svc', command: '"' + nodePath + '" server.js ' + port }, toolCtx)
    ok('工具执行链路：start_process 走 registry 正常返回',
      String(startOut).indexOf('"pid"') !== -1, String(startOut).slice(0, 100))
    const readyOut = await host.tools.execute('wait_ready', { url: 'http://127.0.0.1:' + port + '/health', timeoutMs: 10000 }, toolCtx)
    ok('工具执行链路：wait_ready 真等到服务就绪', String(readyOut).indexOf('"ready":true') !== -1, String(readyOut).slice(0, 100))
    const ledgerOut = await host.tools.execute('validate_ledger', { action: 'read', task: task }, toolCtx)
    ok('工具执行链路：validate_ledger 读回账本', String(ledgerOut).indexOf('轮次 1：') !== -1, String(ledgerOut).slice(0, 80))
    const listOut = await host.tools.execute('list_processes', {}, toolCtx)
    ok('工具执行链路：list_processes 看得见进程', String(listOut).indexOf('"svc"') !== -1, String(listOut).slice(0, 100))
    await host.tools.execute('stop_process', { name: 'svc' }, toolCtx)
    const afterStop = await host.tools.execute('list_processes', {}, toolCtx)
    ok('工具执行链路：stop_process 后状态变 running=false',
      String(afterStop).indexOf('"running":false') !== -1, String(afterStop).slice(0, 120))

    /* 提示词：完成判定那几条必须在系统提示里（防止将来被误删） */
    const prompt = await host.buildSystemPrompt('BASE')
    ok('系统提示带上"证据优先"的完成判定（含无进展即停）',
      prompt.indexOf('REAL EVIDENCE from tool results') !== -1
        && prompt.indexOf('Rounds are not the metric') !== -1
        && prompt.indexOf('not verified') !== -1)
  } catch (error) {
    failed += 1
    failures.push('(fatal) ' + error.message)
    console.log('FATAL ' + error.stack)
  } finally {
    await manager.stopAll().catch(() => undefined)
    fs.rmSync(workspace, { recursive: true, force: true })
  }

  console.log('')
  console.log('self-validate smoke: ' + passed + '/' + (passed + failed) + ' checks passed' +
    (failed ? ', ' + failed + ' FAILED\n' + failures.join('\n') : ''))
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error.stack)
  process.exit(1)
})
