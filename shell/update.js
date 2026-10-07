'use strict'

const not = (value) => value ? false : true

function byId(id) {
  return document.getElementById(id)
}

// 各阶段对应的进度：closing -> copying -> cleaning -> relaunching
const PHASE_STEP = {
  idle: -1,
  closing: 0,
  copying: 1,
  cleaning: 2,
  relaunching: 3,
  failed: -1
}

const PHASE_HINT = {
  closing: '正在关闭旧版本…',
  copying: '正在替换程序文件（这一步最慢，会复制整个运行时）…',
  cleaning: '正在清理旧版本残留…',
  relaunching: '正在启动新版本…'
}

const FAILURE_TEXT = {
  DIR_LOCKED: '旧版本目录仍被占用。请确认旧版本已完全退出（任务管理器里结束 Agent 进程）后重试。',
  COPY_FAILED: '复制文件失败，旧目录已尽量还原，没有留下半成品。',
  BINARY_MISSING: '新版本文件已就位，但没找到可执行文件，请手动打开目标目录。',
  OLD_RUNNING: '旧版本还在运行，请点「立即更新」由程序来关闭它。'
}

let lastStep = 0

function renderSteps(phase) {
  const active = PHASE_STEP[not(phase) ? 'idle' : phase]
  if (active >= 0) lastStep = active
  const nodes = document.querySelectorAll('#steps .step')
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    node.classList.remove('done', 'active', 'failed')
    if (phase === 'failed') {
      if (index < lastStep) node.classList.add('done')
      else if (index === lastStep) node.classList.add('failed')
      continue
    }
    if (index < active) node.classList.add('done')
    else if (index === active) node.classList.add('active')
  }
}

function apply(state) {
  if (not(state)) return
  const phase = state.phase
  const running = phase === 'closing' || phase === 'copying' || phase === 'cleaning' || phase === 'relaunching'

  byId('hint').textContent = running
    ? PHASE_HINT[phase]
    : (phase === 'failed' ? '更新没有完成。' : '检测到本机已经有一份旧版本。')

  byId('steps').classList.toggle('hidden', not(running) && not(phase === 'failed'))
  renderSteps(phase)

  // 运行中不让点按钮，避免重复触发替换
  byId('actions').classList.toggle('hidden', running)
  byId('keep').classList.toggle('hidden', phase === 'failed' || !!window.__oldRunning)

  const status = byId('status')
  if (phase === 'failed') {
    status.textContent = FAILURE_TEXT[state.detail] || ('更新失败：' + (state.detail || '未知原因'))
    status.className = 'status error'
    return
  }
  status.textContent = state.detail || ''
  status.className = 'status'
}

async function init() {
  const info = await window.shell.getUpdateInfo()
  if (not(info)) {
    byId('status').textContent = '没有待处理的更新信息。'
    byId('status').className = 'status error'
    return
  }
  window.__oldRunning = !!info.oldRunning

  byId('oldLabel').textContent = '旧版本' + (info.oldVersion ? ' v' + info.oldVersion : '') +
    (info.oldRunning ? '（正在运行）' : '')
  byId('oldPath').textContent = info.oldPath
  byId('newLabel').textContent = '当前这份 v' + info.newVersion
  byId('newPath').textContent = info.newPath

  if (info.oldRunning) {
    byId('note').textContent = '旧版本正在运行，点「立即更新」会先把它关掉，再替换文件并从原位置重启。' +
      '会话、设置、工作区都在数据目录里，不会被删除。'
  }

  byId('update').addEventListener('click', async () => {
    byId('update').disabled = true
    byId('keep').classList.add('hidden')
    byId('cancel').disabled = true
    const result = await window.shell.runUpdate()
    if (not(result) || not(result.ok)) return
    byId('status').textContent = '更新完成，新版本正在启动，本窗口即将关闭。'
  })

  byId('keep').addEventListener('click', async () => {
    byId('update').disabled = true
    byId('keep').disabled = true
    byId('cancel').disabled = true
    byId('status').textContent = '正在以当前这份启动…'
    const result = await window.shell.useCurrent()
    if (result && result.ok === false) {
      byId('status').textContent = FAILURE_TEXT[result.error] || ('启动失败：' + result.error)
      byId('status').className = 'status error'
      byId('update').disabled = false
      byId('cancel').disabled = false
    }
  })

  byId('cancel').addEventListener('click', () => {
    window.shell.cancelUpdate()
  })

  window.shell.onUpdateState((state) => apply(state))
  apply(await window.shell.getUpdateState())
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    byId('status').textContent = error && error.message ? error.message : String(error)
    byId('status').className = 'status error'
  })
})
