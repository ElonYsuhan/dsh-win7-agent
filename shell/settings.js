'use strict'

const not = (value) => value ? false : true

function byId(id) {
  return document.getElementById(id)
}

function setStatus(text, isError) {
  const status = byId('status')
  status.textContent = text
  status.className = isError ? 'status error' : 'status'
}

function currentMode() {
  const checked = document.querySelector('input[name="mode"]:checked')
  return checked && checked.value === 'remote' ? 'remote' : 'local'
}

function renderMode() {
  const mode = currentMode()
  byId('remoteBox').classList.toggle('hidden', mode !== 'remote')
  byId('localBox').classList.toggle('hidden', mode !== 'local')
}

function renderInfo(config) {
  byId('localService').textContent = config.resolvedServiceUrl && config.mode === 'local'
    ? config.resolvedServiceUrl
    : '启动后自动分配'
  byId('agentHome').textContent = config.agentHome || '—'
  byId('versionLabel').textContent = config.version ? '程序版本 v' + config.version : '程序版本'
  byId('programPath').textContent = config.programPath || '—'
}

async function init() {
  const config = await window.shell.getConfig()
  const mode = config.mode === 'remote' ? 'remote' : 'local'
  const radio = document.querySelector('input[name="mode"][value="' + mode + '"]')
  if (radio) radio.checked = true
  byId('serviceUrl').value = config.serviceUrl || ''
  renderInfo(config)
  renderMode()

  const standalone = new URLSearchParams(window.location.search).has('standalone')
  if (standalone) byId('close').classList.remove('hidden')

  const modeGroup = byId('modeGroup')
  modeGroup.addEventListener('change', () => {
    renderMode()
    setStatus('')
  })

  byId('save').addEventListener('click', async () => {
    try {
      setStatus('正在应用…', false)
      await window.shell.saveConfig({
        mode: currentMode(),
        serviceUrl: byId('serviceUrl').value
      })
      setStatus('已保存，正在切换到新服务…', false)
    } catch (error) {
      setStatus(error && error.message ? error.message : String(error), true)
    }
  })

  byId('restart').addEventListener('click', async () => {
    const radio = document.querySelector('input[name="mode"][value="local"]')
    if (radio) radio.checked = true
    renderMode()
    setStatus('正在重启本地服务…', false)
    try {
      await window.shell.retry()
      setStatus('本地服务已重启。', false)
    } catch (error) {
      setStatus(error && error.message ? error.message : String(error), true)
    }
  })

  byId('test').addEventListener('click', async () => {
    const mode = currentMode()
    const raw = mode === 'remote' ? byId('serviceUrl').value.trim() : ''
    if (mode === 'remote' && not(raw)) {
      setStatus('请先填写远程服务地址。', true)
      return
    }
    if (mode === 'remote') {
      window.shell.openExternal(raw)
      return
    }
    const latest = await window.shell.getConfig()
    if (latest.resolvedServiceUrl) {
      window.shell.openExternal(latest.resolvedServiceUrl)
    } else {
      setStatus('本地服务还没启动完成。', true)
    }
  })

  byId('close').addEventListener('click', () => {
    window.shell.close()
  })

  byId('serviceUrl').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') byId('save').click()
  })
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => setStatus(error && error.message ? error.message : String(error), true))
})
