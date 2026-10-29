'use strict'
// Owner-side HTTP adapter. It shares the existing offline issuer, not Agent state.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const issuer = require('./issuer')
const IDLE_MS = 10 * 60 * 1000, ABSOLUTE_MS = 8 * 60 * 60 * 1000
const COOKIE = 'agent_authority_session', PASSWORD_HASH = Buffer.from('e4abcd059efd1500b3e44a78a7be4753f407884bd70e4c6c0cb23178b1fa14de', 'hex')
function privateAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '').replace(/%.+$/, '').toLowerCase()
  return value === '::1' || /^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value) || /^169\.254\./.test(value) || /^(?:fc|fd)[0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value)
}
function createAuthorityServer({ directory = issuer.defaultDirectory(), renderer = __dirname, verifyFile = null, clock = () => Date.now() } = {}) {
  const sessions = new Map(), failures = new Map(), sockets = new Set()
  let loginWork = 0, closing = false
  const csrfEqual = (actual, expected) => typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  function sessionId(req) { const match = /(?:^|;\s*)agent_authority_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || ''); return match && match[1] }
  function clean() {
    const now = clock()
    for (const [id, value] of sessions) if (now >= value.last + IDLE_MS || now >= value.created + ABSOLUTE_MS) sessions.delete(id)
    for (const [id, value] of failures) if (now >= value.until) failures.delete(id)
  }
  function session(req, touch = false) {
    clean(); const value = sessions.get(sessionId(req))
    if (!value) return null
    if (touch) value.last = clock()
    return value
  }
  const sessionView = value => ({ authenticated: true, username: 'admin', csrf: value.csrf, expiresAt: Math.min(value.last + IDLE_MS, value.created + ABSOLUTE_MS), idleTimeoutMs: IDLE_MS })
  function json(res, status, value, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value))
  }
  function body(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0, chunks = [], failed = false
      const fail = message => { if (failed) return; failed = true; chunks = []; reject(Error(message)) }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > max) fail('请求内容过大')
      req.on('data', chunk => { if (failed) return; size += chunk.length; if (size > max) fail('请求内容过大'); else chunks.push(chunk) })
      req.on('end', () => { if (!failed) { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (_) { fail('请求内容不是有效 JSON') } } })
      req.on('error', () => fail('请求读取失败')); req.on('aborted', () => fail('请求已中断'))
    })
  }
  function addresses() {
    const port = server.address() && server.address().port
    const hosts = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase(), os.hostname().toLowerCase() + '.local'])
    const urls = []
    for (const list of Object.values(os.networkInterfaces())) for (const nic of list || []) {
      hosts.add(nic.address.toLowerCase().replace(/%.+$/, ''))
      if (!nic.internal && nic.family === 'IPv4' && privateAddress(nic.address)) urls.push('http://' + nic.address + ':' + port)
    }
    return { hosts, urls: [...new Set(urls)] }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    try {
      if (closing) { json(res, 503, { error: '签发服务正在关闭' }); return }
      if (!privateAddress(req.socket.remoteAddress)) { json(res, 403, { error: '仅允许内网访问' }); return }
      let host
      try { host = new URL('http://' + req.headers.host) } catch (_) {}
      if (!host || host.username || host.password || host.port !== String(server.address().port) || !addresses().hosts.has(host.hostname.replace(/^\[|\]$/g, '').toLowerCase())) { json(res, 403, { error: '访问地址无效' }); return }
      const origin = req.headers.origin
      if (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin !== host.origin) { json(res, 403, { error: '请求来源无效' }); return }
      const route = new URL(req.url, host.origin).pathname
      const post = req.method === 'POST'
      if (post && (origin !== host.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))) { json(res, 403, { error: '请从签发页面提交操作' }); return }
      if (route === '/api/session' && req.method === 'GET') { const value = session(req); json(res, 200, value ? sessionView(value) : { authenticated: false }); return }
      if (route === '/api/login' && post) {
        clean()
        const peer = req.socket.remoteAddress, old = failures.get(peer)
        if (old && old.count >= 5 || loginWork >= 2) { json(res, 429, { error: '尝试过于频繁，请稍后再试' }); return }
        const data = await body(req, 4096)
        if (!data || typeof data.username !== 'string' || typeof data.password !== 'string' || data.password.length > 256) { json(res, 400, { error: '请输入账号和密码' }); return }
        if (loginWork >= 2) { json(res, 429, { error: '尝试过于频繁，请稍后再试' }); return }
        loginWork++
        let derived
        try { derived = await new Promise((resolve, reject) => crypto.scrypt(data.password, 'agent-authority-admin-v1', 32, (error, value) => error ? reject(error) : resolve(value))) } finally { loginWork-- }
        const valid = crypto.timingSafeEqual(derived, PASSWORD_HASH) && data.username === 'admin'; derived.fill(0)
        if (!valid) {
          if (!old && failures.size >= 256) { json(res, 429, { error: '尝试过于频繁，请稍后再试' }); return }
          const previous = failures.get(peer)
          failures.set(peer, { count: (previous && previous.count || 0) + 1, until: previous && previous.until || clock() + 15 * 60 * 1000 })
          json(res, 401, { error: '账号或密码错误' }); return
        }
        if (closing) { json(res, 503, { error: '签发服务正在关闭' }); return }
        failures.delete(peer); sessions.delete(sessionId(req))
        if (sessions.size >= 8) sessions.delete(sessions.keys().next().value)
        const id = crypto.randomBytes(32).toString('hex'), value = { created: clock(), last: clock(), csrf: crypto.randomBytes(32).toString('hex') }
        sessions.set(id, value)
        json(res, 200, sessionView(value), { 'Set-Cookie': COOKIE + '=' + id + '; HttpOnly; SameSite=Strict; Path=/' }); return
      }
      if (route.startsWith('/api/')) {
        const value = session(req)
        if (!value) { json(res, 401, { error: '请先登录，或登录已失效' }); return }
        if (post && !csrfEqual(req.headers['x-csrf-token'], value.csrf)) { json(res, 403, { error: '操作校验失败，请重新登录' }); return }
        if (route === '/api/logout' && post) { sessions.delete(sessionId(req)); json(res, 200, { authenticated: false }, { 'Set-Cookie': COOKIE + '=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/' }); return }
        if (route === '/api/activity' && post) { value.last = clock(); json(res, 200, sessionView(value)); return }
        if (route === '/api/status' && req.method === 'GET') { const state = issuer.status(directory); json(res, 200, { configured: state.configured, keyId: state.keyId, host: os.hostname(), urls: addresses().urls }); return }
        if (route === '/api/init' && post) { await body(req, 1024); if (!session(req) || closing) { json(res, 401, { error: '登录已失效，请重新登录' }); return }; issuer.init(directory); value.last = clock(); json(res, 200, { ok: true }); return }
        if (route === '/api/issue' && post) {
          const data = await body(req, 96 * 1024)
          if (!data || typeof data.requestText !== 'string' || typeof data.customer !== 'string' || typeof data.days !== 'number') throw Error('请填写设备申请、客户与有效期')
          if (!session(req)) { json(res, 401, { error: '登录已失效，请重新登录' }); return }
          if (!issuer.status(directory).configured) throw Error('请先初始化签发身份')
          const issued = issuer.issue({ directory, requestText: data.requestText, customer: data.customer.trim(), days: data.days })
          const filename = issuer.fileStem(issued.claims.deviceDigest) + '.agentlic'
          issuer.record(directory, issued.claims, 'browser:' + filename)
          value.last = clock(); json(res, 200, { filename, text: issued.text, expiresAt: issued.claims.expiresAt }); return
        }
        json(res, 404, { error: '接口不存在' }); return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: '不支持此操作' }); return }
      const assets = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/style.css': ['style.css', 'text/css'], '/logo.png': ['logo.png', 'image/png'] }
      if (!assets[route]) { json(res, 404, { error: '页面不存在' }); return }
      const [name, type] = assets[route], file = path.join(renderer, name), bytes = fs.readFileSync(file)
      if (verifyFile && /\.(?:js|html|css)$/.test(file)) verifyFile(file, bytes)
      res.writeHead(200, { 'Content-Type': type + (type.startsWith('text/') || type === 'application/javascript' ? '; charset=utf-8' : '') }); res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: /^CODE_|^SOURCE_/.test(error.message) ? '程序文件校验失败，请重新安装' : error.message })
      else res.destroy()
    }
  })
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 15000
  server.on('connection', socket => { if (sockets.size >= 128) { socket.destroy(); return }; sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return {
    async listen(port = 8787, host = '0.0.0.0') { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve() }) }); return { url: 'http://127.0.0.1:' + server.address().port, urls: addresses().urls } },
    async close() { closing = true; sessions.clear(); failures.clear(); const done = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await done },
    address: () => server.address()
  }
}
module.exports = { createAuthorityServer, privateAddress, IDLE_MS, ABSOLUTE_MS }
