'use strict'
const { pathToFileURL } = require('url')
// Only the named window's top frame, on an explicitly trusted application page,
// may use native privileges. Renderer-side visibility is never authorization.
function trustedSender(event, windows, files, serviceUrl = '') {
  if (!event || !event.senderFrame) return false
  const win = windows.find(value => value && !value.isDestroyed() && value.webContents === event.sender)
  if (!win || event.senderFrame !== win.webContents.mainFrame) return false
  let target
  try { target = new URL(event.senderFrame.url) } catch (_) { return false }
  if (target.username || target.password) return false
  if (target.protocol === 'file:') return files.some(file => {
    const expected = new URL(pathToFileURL(file).href)
    return target.origin === expected.origin && target.pathname === expected.pathname && target.host === expected.host
  })
  if (!serviceUrl || !['http:', 'https:'].includes(target.protocol)) return false
  try { return target.origin === new URL(serviceUrl).origin && ['/', '/index.html'].includes(target.pathname) } catch (_) { return false }
}
function assertSender(event, windows, files, serviceUrl) {
  if (!trustedSender(event, windows, files, serviceUrl)) throw Error('IPC_SENDER_FORBIDDEN')
}
function attachWebSecurity(win, options = {}) {
  const contents = win.webContents
  const webview = event => event.preventDefault()
  contents.on('will-attach-webview', webview)
  // Session permissions are denied for both asynchronous and synchronous checks.
  contents.session.setPermissionCheckHandler(() => false)
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  if (options.verifyFile) {
    // One filter per window session is sufficient; replacing it installs the
    // same stateless verifier, without retaining destroyed BrowserWindows.
    contents.session.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
      try {
        const filename = require('url').fileURLToPath(details.url)
        if (/\.(?:html|js|css)$/.test(filename)) options.verifyFile(filename)
        callback({})
      } catch (_) { callback({ cancel: true }) }
    })
  }
  win.once('closed', () => contents.removeListener('will-attach-webview', webview))
}
module.exports = { trustedSender, assertSender, attachWebSecurity }
