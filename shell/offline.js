'use strict'

const not = (value) => value ? false : true

async function init() {
  const config = await window.shell.getConfig()
  const target = config.resolvedServiceUrl || config.serviceUrl
  document.getElementById('serviceUrl').textContent = target || '（未配置服务地址）'
  document.getElementById('retry').addEventListener('click', async () => {
    document.getElementById('status').textContent = '正在重试…'
    await window.shell.retry()
  })
  document.getElementById('settings').addEventListener('click', () => {
    window.shell.openSettings()
  })
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    document.getElementById('status').textContent = error && error.message ? error.message : String(error)
  })
})
