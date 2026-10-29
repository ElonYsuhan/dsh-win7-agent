'use strict'
const assert = require('assert'), path = require('path'), { EventEmitter } = require('events'), { pathToFileURL } = require('url')
const { trustedSender, assertSender, attachWebSecurity } = require('../shell/ipc-security')
const file = path.resolve('shell/settings.html'), frame = { url: pathToFileURL(file).href + '?standalone=1' }
const wc = new EventEmitter(); wc.mainFrame = frame
const win = new EventEmitter(); win.webContents = wc; win.isDestroyed = () => false
const event = { sender: wc, senderFrame: frame }
assert(trustedSender(event, [win], [file]))
for (const value of [null, {}, { sender: {}, senderFrame: frame }, { sender: wc, senderFrame: { url: frame.url } }]) assert.throws(() => assertSender(value, [win], [file]), /IPC_SENDER_FORBIDDEN/)
for (const url of [pathToFileURL(file + '.evil').href, 'file:///etc/passwd', 'https://evil.example/', 'http://localhost:8081/', 'http://user:pass@localhost:8080/', 'http://localhost:8080/preview.html', 'null']) {
  frame.url = url; assert(!trustedSender(event, [win], [file], 'http://localhost:8080/'), url)
}
frame.url = 'http://localhost:8080/?theme=light'; assert(trustedSender(event, [win], [file], 'http://localhost:8080/'))
frame.url = 'http://localhost:8080/index.html'; assert(trustedSender(event, [win], [file], 'http://localhost:8080/'))
let check, request, intercept, count = 0
wc.session = { setPermissionCheckHandler(fn) { check = fn }, setPermissionRequestHandler(fn) { request = fn }, webRequest: { onBeforeRequest(_filter, fn) { intercept = fn } } }
attachWebSecurity(win, { verifyFile(filename) { count++; if (filename.endsWith('bad.js')) throw Error('tamper') } })
assert.strictEqual(check(), false); request(null, 'media', result => assert.strictEqual(result, false))
let prevented = false; wc.emit('will-attach-webview', { preventDefault() { prevented = true } }); assert(prevented)
for (const [name, cancel] of [['good.js', false], ['bad.js', true], ['logo.png', false]]) intercept({ url: pathToFileURL(path.resolve(name)).href }, result => assert.strictEqual(result.cancel === true, cancel))
assert.strictEqual(count, 2)
win.emit('closed'); assert.strictEqual(wc.listenerCount('will-attach-webview'), 0)
console.log('Desktop security passed: exact window/top-frame/page IPC gate, credential/origin/path rejection, denied device permissions/webviews, file-resource tamper blocking, listener cleanup')
