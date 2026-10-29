'use strict'
const { app, BrowserWindow, shell, dialog } = require('electron'), path = require('path')
const issuer = require('./service/index'), { createAuthorityServer } = require('./service/web')
const { attachWebSecurity } = require('./ipc-security'), integrity = require('./source-loader')
const override = process.argv.find(value => value.startsWith('--authority-dir=')), directory = override ? path.resolve(override.slice(16)) : issuer.defaultDirectory()
const portArgument = process.argv.find(value => value.startsWith('--authority-port='))
const requestedPort = portArgument ? Number(portArgument.slice(17)) : 8787
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65525) throw Error('签发服务端口无效')
app.setName('Agent 授权签发工具')
let window, service, stopping = false
app.whenReady().then(async () => {
  service = createAuthorityServer({ directory, renderer: path.join(__dirname, 'src/renderer'), verifyFile: integrity.verifyFile })
  let address
  for (let offset = 0; offset < 10; offset++) {
    try { address = await service.listen(requestedPort === 0 ? 0 : requestedPort + offset); break } catch (error) { if (error.code !== 'EADDRINUSE' || offset === 9) throw error }
  }
  window = new BrowserWindow({ width: 800, height: 880, minWidth: 620, minHeight: 640, title: 'Agent 授权签发工具', icon: path.join(__dirname, 'src/renderer/logo.png'), webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
  attachWebSecurity(window)
  window.webContents.setWindowOpenHandler(({ url }) => { if ([address.url, ...address.urls].some(base => url === base || url === base + '/')) shell.openExternal(url).catch(() => {}); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, target) => { if (target !== address.url && target !== address.url + '/') event.preventDefault() })
  await window.loadURL(address.url)
}).catch(error => { dialog.showErrorBox('签发工具启动失败', error.message); app.quit() })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (!service || stopping) return
  event.preventDefault(); stopping = true
  service.close().finally(() => app.quit())
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit())
