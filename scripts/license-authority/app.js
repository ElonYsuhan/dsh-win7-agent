'use strict'
const byId = id => document.getElementById(id)
let busy = false, configured = false, csrf = '', expiresAt = 0, lastActivity = 0
function message(text) { byId('message').textContent = text }
function locked(text = '') {
  csrf = ''; expiresAt = 0; configured = false
  byId('issuerPanel').hidden = true; byId('loginPanel').hidden = false; byId('password').value = ''; byId('request').value = ''; byId('customer').value = ''; byId('file').value = ''; byId('device').textContent = ''; byId('identity').textContent = ''; byId('network').textContent = ''; byId('directory').textContent = ''
  byId('loginMessage').textContent = text
}
async function api(action, data) {
  const options = { credentials: 'same-origin', cache: 'no-store' }
  if (data !== undefined) { options.method = 'POST'; options.headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }; options.body = JSON.stringify(data) }
  const response = await window.fetch('/api/' + action, options), value = await response.json()
  if (!response.ok) { if (response.status === 401 && action !== 'login') { locked('登录已失效，请重新登录'); byId('password').focus() } throw Error(value.error || '操作失败，请重试') }
  return value
}
function accepted(value) { csrf = value.csrf; expiresAt = value.expiresAt; byId('loginPanel').hidden = true; byId('issuerPanel').hidden = false; byId('password').value = ''; byId('loginMessage').textContent = '' }
async function status() {
  const state = await api('status'); configured = state.configured
  byId('identity').textContent = configured ? '签发方：' + state.keyId : '尚未创建签发密钥'
  byId('directory').textContent = '签发电脑：' + state.host
  const network = byId('network'); network.replaceChildren()
  network.append(document.createTextNode(state.urls.length ? '内网访问（可点击打开）：' : '当前未检测到可分享的内网地址'))
  for (const url of state.urls) {
    const row = document.createElement('div'), link = document.createElement('a'), copy = document.createElement('button')
    row.className = 'network-address'; link.href = url; link.textContent = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
    copy.type = 'button'; copy.textContent = '复制地址'; copy.setAttribute('aria-label', '复制内网地址 ' + url)
    copy.addEventListener('click', async () => {
      try {
        let written = false
        if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(url); written = true } catch (_) {} }
        if (!written) {
          const field = document.createElement('textarea'), focused = document.activeElement
          field.value = url; field.readOnly = true; field.className = 'clipboard-field'; document.body.append(field); field.select()
          let copied; try { copied = document.execCommand('copy') } finally { field.remove(); if (focused) focused.focus() }
          if (!copied) throw Error('copy')
        }
        message('已复制内网地址：' + url)
      } catch (_) { message('复制失败，请选中上方地址手动复制。') }
    })
    row.append(link, copy); network.append(row)
  }
  byId('init').hidden = configured; byId('issue').disabled = !configured || busy
}
byId('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return
  busy = true; byId('login').disabled = true; byId('loginMessage').textContent = ''
  try { accepted(await api('login', { username: byId('username').value, password: byId('password').value })); await status(); byId('drop').focus() } catch (error) { byId('loginMessage').textContent = error.message; byId('password').value = ''; byId('password').focus() } finally { busy = false; byId('login').disabled = false; byId('issue').disabled = !configured }
})
byId('logout').addEventListener('click', async () => { if (busy) return; try { await api('logout', {}); locked(); byId('password').focus() } catch (error) { message(error.message) } })
byId('init').addEventListener('click', async () => { if (busy) return; busy = true; byId('init').disabled = true; try { await api('init', {}); await status(); message('签发身份已创建。发布客户端时必须打包此公钥。') } catch (error) { message(error.message) } finally { busy = false; byId('init').disabled = false; byId('issue').disabled = !configured } })
async function read(file) { if (!file) return; try { if (file.size > 65536) throw Error('设备申请文件最大64KB'); byId('request').value = await file.text(); preview() } catch (error) { message(error.message) } }
function preview() { try { const value = JSON.parse(byId('request').value); if (!/^[a-f0-9]{64}$/.test(value.deviceDigest)) throw Error('invalid'); byId('device').textContent = '申请标识：' + value.deviceDigest.slice(0, 9).toUpperCase().replace(/(.{3})(.{3})(.{3})/, '$1-$2-$3') + ' · ' + value.platform + ' / ' + value.arch } catch (_) { byId('device').textContent = '' } }
byId('request').addEventListener('input', preview); byId('file').addEventListener('change', () => read(byId('file').files[0]))
byId('drop').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); byId('file').click() } })
for (const type of ['dragenter', 'dragover']) byId('drop').addEventListener(type, event => { event.preventDefault(); byId('drop').classList.add('dragging') })
byId('drop').addEventListener('dragleave', () => byId('drop').classList.remove('dragging'))
byId('drop').addEventListener('drop', event => { event.preventDefault(); byId('drop').classList.remove('dragging'); if (event.dataTransfer.files.length !== 1) { message('请一次导入一个设备申请文件'); return } read(event.dataTransfer.files[0]) })
byId('form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !configured || !csrf) return
  busy = true; byId('issue').disabled = true; message('正在生成授权…')
  try {
    const result = await api('issue', { requestText: byId('request').value, customer: byId('customer').value, days: Number(byId('days').value) })
    const url = URL.createObjectURL(new Blob([result.text], { type: 'application/json' })), anchor = document.createElement('a')
    anchor.href = url; anchor.download = result.filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    message('已生成：' + result.filename + '；有效期至 ' + new Date(result.expiresAt).toLocaleString('zh-CN'))
  } catch (error) { message(error.message) } finally { busy = false; byId('issue').disabled = !configured }
})
for (const form of document.forms) form.addEventListener('keydown', event => { if (event.key === 'Enter' && event.isComposing) event.preventDefault() })
async function activity() {
  if (!csrf || document.hidden || Date.now() - lastActivity < 30000) return
  lastActivity = Date.now()
  try { const value = await api('activity', {}); expiresAt = value.expiresAt } catch (_) {}
}
for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, activity, { passive: true })
async function session() { try { const value = await api('session'); if (value.authenticated) { accepted(value); await status() } else locked() } catch (error) { locked(error.message) } }
document.addEventListener('visibilitychange', () => { if (!document.hidden) session() })
const timer = setInterval(() => { if (csrf && Date.now() >= expiresAt) { locked('长时间无操作，请重新登录'); byId('password').focus() } }, 1000)
window.addEventListener('beforeunload', () => clearInterval(timer), { once: true })
session().then(() => { if (!csrf) byId('password').focus() })
