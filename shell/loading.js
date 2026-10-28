'use strict'

const not = (value) => value ? false : true

function byId(id) {
  return document.getElementById(id)
}

// 各阶段对应的进度：probe -> spawn -> ready
const PHASE_STEP = {
  idle: -1,
  probing: 0,
  starting: 1,
  remote: 1,
  unconfigured: -1,
  ready: 2,
  failed: -1
}

const FAILURE_TEXT = {
  NO_FREE_PORT: '本机 8080 – 8099 端口全部被占用，请关闭占用端口的程序后重试。',
  'service-exited': '本地服务进程异常退出。',
  timeout: '本地服务启动超时，可能是端口被防火墙拦截或程序权限不足。'
}

function renderSteps(phase) {
  const active = PHASE_STEP[not(phase) ? 'idle' : phase]
  const nodes = document.querySelectorAll('#steps .step')
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    node.classList.remove('done', 'active', 'failed')
    if (phase === 'failed') {
      node.classList.add(index <= 0 ? 'failed' : '')
      continue
    }
    if (index < active) node.classList.add('done')
    else if (index === active) node.classList.add('active')
  }
}

function describe(state) {
  const phase = state.phase
  if (phase === 'probing') return '正在检查可用端口…'
  if (phase === 'starting') return '正在启动本地服务（端口 ' + state.port + '）…'
  if (phase === 'remote') return '正在连接远程服务…'
  if (phase === 'ready') return '服务已就绪，正在打开界面…'
  if (phase === 'unconfigured') return '还没有配置服务地址。'
  if (phase === 'failed') return FAILURE_TEXT[state.detail] || '本地服务启动失败。'
  return '正在启动本地服务，请稍候…'
}

function apply(state) {
  if (not(state)) return
  const phase = state.phase
  byId('hint').textContent = phase === 'failed' || phase === 'unconfigured' ? describe(state) : '正在加载…'
  renderSteps(phase)

  const detail = byId('detail')
  const lines = []
  if (state.port) lines.push('端口: ' + state.port)
  if (state.probes && state.probes.length > 1) {
    const busy = state.probes.filter((item) => item.kind === 'other').map((item) => item.port)
    if (busy.length) lines.push('已跳过被占用的端口: ' + busy.join(', '))
  }
  if (phase === 'failed' && state.message) lines.push(state.message)
  if (lines.length && phase === 'failed') {
    detail.textContent = lines.join('\n')
    detail.classList.remove('hidden')
  } else {
    detail.classList.add('hidden')
  }

  const showActions = phase === 'failed' || phase === 'unconfigured'
  byId('actions').classList.toggle('hidden', not(showActions))
  byId('retry').classList.toggle('hidden', phase === 'unconfigured')

  const status = byId('status')
  status.textContent = phase === 'ready' ? '已就绪' : ''
  status.className = 'status'
}

async function init() {
  byId('retry').addEventListener('click', () => {
    byId('status').textContent = '正在重试…'
    window.shell.retry()
  })
  byId('settings').addEventListener('click', () => {
    window.shell.openSettings()
  })
  window.shell.onStartupState((state) => apply(state))
  const state = await window.shell.getStartupState()
  apply(state)
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    byId('status').textContent = error && error.message ? error.message : String(error)
    byId('status').className = 'status error'
  })
})
