'use strict'

// 本地模拟代理和模型，不使用真实密钥或访问外网。测试证书和密钥仅在内存中生成。
const assert = require('assert')
const http = require('http')
const https = require('https')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')
const { spawn } = childProcess
let mockRegistryError = false
let mockRegistryText = '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=proxy-win.test:8080;https=secure-win.test:8443\n    ProxyOverride    REG_SZ    <local>;*.intranet\n'
if (process.argv[2] === '--mock-win-registry') {
  process.env.SystemRoot = 'C:\\Windows'
  childProcess.execFileSync = (command, args, options) => {
    assert.strictEqual(command, 'C:\\Windows\\System32\\reg.exe')
    assert.strictEqual(options.windowsHide, true)
    if (mockRegistryError) throw new Error('simulated registry failure')
    return mockRegistryText
  }
}
const appRoot = process.env.AGENT_PROXY_TEST_APP || path.resolve(__dirname, '..')
const proxy = require(path.join(appRoot, 'src/main/agent/network-proxy'))
const { fetchModelList } = require(path.join(appRoot, 'src/main/agent/model-list'))
const { requestChat } = require(path.join(appRoot, 'src/main/agent/llm'))

const names = ['AGENT_MODEL_PROXY', 'AGENT_HTTP_PROXY', 'AGENT_HTTPS_PROXY', 'AGENT_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'AGENT_TEST_CA']
function cleanEnv() { const result = Object.assign({}, process.env); for (const name of names) delete result[name]; return result }
function cleanProcessEnv() { for (const name of names) delete process.env[name] }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function until(test, label) {
  for (let i = 0; i < 200; i++) { if (test()) return; await wait(10) }
  throw new Error('Timed out: ' + label)
}
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)) }
function close(server) { return new Promise(resolve => server.close(resolve)) }

const { certForTest } = require('./test-support/ephemeral-tls')

function child(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename].concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', code => resolve({ code, stdout, stderr }))
  })
}

// Electron 22 的 Node 模式不保证读取 NODE_EXTRA_CA_CERTS；只在测试子进程
// 为 TLS 调用注入临时信任根，未关闭证书和主机名验证，也不改生产网络代码。
if (process.env.AGENT_TEST_CA && process.argv[2] && process.argv[2].endsWith('-client')) {
  const tls = require('tls')
  const original = tls.connect
  const testCa = fs.readFileSync(process.env.AGENT_TEST_CA)
  tls.connect = function () {
    const args = Array.from(arguments)
    if (args[0] && typeof args[0] === 'object') args[0] = Object.assign({}, args[0], { ca: testCa })
    return original.apply(this, args)
  }
}
async function tlsClient(mode) {
  const expectSuccess = mode === 'trusted'
  const baseURL = mode === 'wronghost' ? 'https://wrong.test/v1' : 'https://model.test/v1'
  try {
    const list = await fetchModelList(baseURL, 'mock-model-key')
    const result = await requestChat({ settings: { baseURL, model: 'mock', apiKey: 'mock-model-key' }, messages: [{ role: 'user', content: 'test' }] })
    assert.deepStrictEqual(list, ['模拟模型'])
    assert.strictEqual(result.content, '测试成功')
    if (expectSuccess) {
      const chats = await Promise.all(Array.from({ length: 4 }, () => requestChat({ settings: { baseURL, model: 'mock' }, messages: [] })))
      assert(chats.every(item => item.content === '测试成功'))
    }
    if (!expectSuccess) throw new Error('Untrusted certificate was accepted')
  } catch (error) {
    if (expectSuccess || !/self.signed|unable to verify|certificate|does not match/i.test(error.message)) throw error
  }
}

async function main() {
  // 独立测试策略，完全不读取系统代理或用户凭据。
  const fallback = { http: proxy.normalizeProxy('http://http.example:8080'), https: null, bypass: [], socks: false, pac: false }
  const choose = (target, env, systemProxy) => proxy.resolveProxy(target, { env, systemProxy: systemProxy || fallback })
  assert.strictEqual(choose('https://model.test', {}, fallback), null)
  assert.strictEqual(choose('http://model.test', {}, fallback).hostname, 'http.example')
  assert.strictEqual(choose('https://api.model.test', { NO_PROXY: 'one.test,.model.test', HTTPS_PROXY: 'http://proxy:8080' }), null)
  assert.strictEqual(choose('https://api.model.test:8443', { no_proxy: '[2001:db8::1]:8443,api.model.test:443', HTTPS_PROXY: 'http://proxy:8080' }).hostname, 'proxy')
  assert.strictEqual(choose('https://api.model.test:8443', { no_proxy: 'wrong,api.model.test:8443', HTTPS_PROXY: 'http://proxy:8080' }), null)
  assert.strictEqual(choose('https://[2001:db8::1]:8443', { NO_PROXY: '[2001:db8::1]:8443', HTTPS_PROXY: 'http://proxy:8080' }), null)
  assert(proxy.bypasses('2001:db8::23', 443, '2001:db8::/32'))
  assert(proxy.bypasses('45.3.4.5', 80, '10.0.0.0/8,45.3.0.0/16'))
  assert(!proxy.bypasses('45.4.4.5', 80, '45.3.0.0/16'))
  for (const host of ['127.0.0.1', '10.4.3.2', '172.31.3.4', '192.168.2.1', 'fe90::1', 'fd42::1', '::ffff:127.0.0.1', 'server', 'printer.local']) assert(proxy.isPrivateHost(host), host)
  for (const host of ['fc.example.com', 'fd.example.com', '8.8.8.8', '2001:db8::1']) assert(!proxy.isPrivateHost(host), host)
  assert.strictEqual(choose('https://model.test', { AGENT_MODEL_PROXY: 'direct', HTTPS_PROXY: 'http://proxy:8080' }), null)
  assert.strictEqual(choose('https://model.test', { AGENT_MODEL_PROXY: 'http://first:8080', HTTPS_PROXY: 'http://second:8080' }).hostname, 'first')
  assert.throws(() => choose('https://model.test', { HTTPS_PROXY: 'socks5://proxy:1080' }), /MODEL_PROXY_UNSUPPORTED_OR_INVALID/)
  assert.throws(() => choose('https://model.test', {}, { pac: true, bypass: [] }), /MODEL_PROXY_PAC_UNSUPPORTED/)
  assert.throws(() => choose('https://model.test', {}, { socks: true, bypass: [] }), /MODEL_PROXY_SOCKS_UNSUPPORTED/)
  const mac = proxy.parseMacSystemProxy('HTTPEnable : 1\nHTTPProxy : proxy.test\nHTTPPort : 8080\nHTTPSEnable : 0\nExceptionsList : <array> {\n 0 : *.internal\n 1 : 10.0.0.0/8\n}\n')
  assert(mac.http && !mac.https && mac.bypass.length === 2)
  const win = proxy.parseWindowsProxyServer('http=proxy.test:8080;https=secure.test:8443;socks=proxy.test:1080')
  assert.strictEqual(win.https.hostname, 'secure.test')
  assert(proxy.parseWindowsProxyServer('http=proxy.test:8080').https === null)
  const windows = await child(['--mock-win-registry'], Object.assign(cleanEnv(), { ELECTRON_RUN_AS_NODE: '1' }))
  assert.strictEqual(windows.code, 0, 'Windows proxy discovery simulation failed: ' + windows.stderr)
  console.log('PASS 代理优先级、平台解析、NO_PROXY、CIDR 和内网地址')

  cleanProcessEnv()
  const credentials = 'Basic ' + Buffer.from('mock-user:mock-password').toString('base64')
  const observed = { http: [], connect: [], model: [], sockets: new Set(), mode: 'forward', pending: null }
  const cert = certForTest()
  const handler = (req, res) => {
    observed.model.push({ path: req.url, auth: req.headers.authorization, proxyAuth: req.headers['proxy-authorization'] })
    req.resume()
    req.on('end', () => {
      if (observed.mode === 'drop-response') {
        res.writeHead(200, { 'content-type': req.url === '/api/chat' ? 'application/x-ndjson' : 'text/event-stream' })
        res.write('partial')
        setTimeout(() => res.destroy(), 20)
        return
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        const text = Buffer.from(JSON.stringify({ data: [{ id: '模拟模型' }] }))
        for (const byte of text) res.write(Buffer.from([byte]))
        res.end()
      } else if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(JSON.stringify({ message: { content: '测试成功' }, done: true }) + '\n')
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '测试成功' } }] }) + '\n\ndata: [DONE]\n\n')
      }
    })
  }
  const model = http.createServer(handler)
  const secureModel = https.createServer({ key: cert.key, cert: cert.cert }, handler)
  const proxyHandler = (req, res) => {
    observed.http.push({ path: req.url, auth: req.headers.authorization, proxyAuth: req.headers['proxy-authorization'] })
    const headers = Object.assign({}, req.headers); delete headers['proxy-authorization']
    const outgoing = http.request({ hostname: '127.0.0.1', port: model.address().port, path: new URL(req.url).pathname, method: req.method, headers }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers)
      upstream.on('aborted', () => res.destroy())
      upstream.on('error', () => res.destroy())
      upstream.pipe(res)
    })
    outgoing.on('error', () => res.destroy())
    req.pipe(outgoing)
  }
  const server = http.createServer(proxyHandler)
  const secureProxy = https.createServer({ key: cert.key, cert: cert.cert }, proxyHandler)
  for (const instance of [server, secureProxy]) {
    instance.on('connection', socket => { observed.sockets.add(socket); socket.once('close', () => observed.sockets.delete(socket)) })
    instance.on('connect', (req, socket, head) => {
    observed.connect.push({ path: req.url, auth: req.headers.authorization, proxyAuth: req.headers['proxy-authorization'] })
    if (observed.mode === 'reject') { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
    if (observed.mode === 'stall' || observed.mode === 'tls-stall') {
      observed.pending = { closed: false, socket }
      socket.resume()
      socket.once('end', () => socket.end())
      socket.once('close', () => { if (observed.pending && observed.pending.socket === socket) observed.pending.closed = true })
      if (observed.mode === 'tls-stall') socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      return
    }
    const upstream = net.connect(secureModel.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    })
  }
  let temp
  try {
    await listen(model); await listen(secureModel); await listen(server); await listen(secureProxy)
    const address = 'http://mock-user:mock-password@127.0.0.1:' + server.address().port
    process.env.AGENT_MODEL_PROXY = address
    const localBase = 'http://127.0.0.1:' + model.address().port
    const before = observed.http.length
    assert.deepStrictEqual(await fetchModelList(localBase + '/v1', 'mock-model-key'), ['模拟模型'])
    assert.strictEqual(observed.http.length, before, 'loopback must bypass proxy')
    const ipv6 = http.createServer(handler)
    let ipv6Available = false
    try {
      await new Promise((resolve, reject) => { ipv6.once('error', reject); ipv6.listen(0, '::1', resolve) })
      ipv6Available = true
      const ipv6Base = 'http://[::1]:' + ipv6.address().port
      assert.deepStrictEqual(await fetchModelList(ipv6Base + '/v1', 'mock-model-key'), ['模拟模型'])
      const ipv6Chat = await requestChat({ settings: { baseURL: ipv6Base + '/v1', model: 'mock' }, messages: [] })
      assert.strictEqual(ipv6Chat.content, '测试成功')
      assert.strictEqual(observed.http.length, before, 'IPv6 loopback must bypass proxy')
    } catch (error) {
      if (ipv6Available || !['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error
      console.log('SKIP IPv6 loopback: unavailable on this host')
    } finally { if (ipv6Available) await close(ipv6) }
    assert.deepStrictEqual(await fetchModelList('http://model.test/v1', 'mock-model-key'), ['模拟模型'])
    const chat = await requestChat({ settings: { baseURL: 'http://model.test/v1', model: 'mock', apiKey: 'mock-model-key' }, messages: [] })
    assert.strictEqual(chat.content, '测试成功')
    const ollama = await requestChat({ settings: { baseURL: 'http://ollama.test/v1', model: 'mock' }, messages: [] })
    assert.strictEqual(ollama.content, '测试成功')
    assert(observed.http.every(item => item.proxyAuth === credentials))
    assert(observed.http.some(item => item.path === 'http://model.test/v1/models'))
    assert(observed.model.every(item => item.proxyAuth === undefined))
    await new Promise((resolve, reject) => {
      const target = new URL('http://fake-user:fake-password@model.test/v1/models#not-sent')
      const req = proxy.request(target, { hostname: target.hostname, path: target.pathname, method: 'GET' }, response => { response.resume(); response.on('end', resolve) })
      req.on('error', reject); req.end()
    })
    assert.strictEqual(observed.http[observed.http.length - 1].path, 'http://model.test/v1/models')
    console.log('PASS 模型列表、OpenAI SSE、Ollama NDJSON 与本地直连')

    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-proxy-test-'))
    const caPath = path.join(temp, 'test-ca.pem')
    fs.writeFileSync(caPath, cert.cert)
    const env = Object.assign(cleanEnv(), { AGENT_MODEL_PROXY: address, ELECTRON_RUN_AS_NODE: '1' })
    let result = await child(['--tls-client', 'trusted'], Object.assign({}, env, { AGENT_TEST_CA: caPath }))
    assert.strictEqual(result.code, 0, 'trusted TLS client failed: ' + result.stderr)
    result = await child(['--tls-client', 'untrusted'], env)
    assert.strictEqual(result.code, 0, 'untrusted TLS test failed: ' + result.stderr)
    const secureAddress = 'https://mock-user:mock-password@127.0.0.1:' + secureProxy.address().port
    result = await child(['--tls-client', 'trusted'], Object.assign({}, env, { AGENT_MODEL_PROXY: secureAddress, AGENT_TEST_CA: caPath }))
    assert.strictEqual(result.code, 0, 'HTTPS proxy TLS test failed: ' + result.stderr)
    result = await child(['--http-client'], Object.assign({}, env, { AGENT_MODEL_PROXY: secureAddress, AGENT_TEST_CA: caPath }))
    assert.strictEqual(result.code, 0, 'HTTPS proxy to HTTP model test failed: ' + result.stderr)
    assert(observed.connect.length >= 3)
    assert(observed.connect.every(item => item.path === 'model.test:443' && item.proxyAuth === credentials && item.auth === undefined))
    assert(observed.model.some(item => item.auth === 'Bearer mock-model-key'))
    result = await child(['--tls-client', 'wronghost'], Object.assign({}, env, { AGENT_TEST_CA: caPath }))
    assert.strictEqual(result.code, 0, 'TLS hostname mismatch test failed: ' + result.stderr)
    console.log('PASS HTTPS CONNECT、端到端证书校验、代理与模型凭据隔离')

    observed.mode = 'reject'
    await assert.rejects(fetchModelList('https://model.test/v1', 'mock-model-key'), /MODEL_PROXY_CONNECT_407/)
    const ipv6Error = await new Promise(resolve => {
      const target = new URL('https://[2001:db8::1]:8443/v1')
      const req = proxy.request(target, { protocol: 'https:', hostname: target.hostname, port: target.port, path: target.pathname }, () => {})
      req.on('error', resolve); req.end()
    })
    assert(/MODEL_PROXY_CONNECT_407/.test(ipv6Error.message))
    assert.strictEqual(observed.connect[observed.connect.length - 1].path, '[2001:db8::1]:8443')
    observed.mode = 'drop-response'
    await assert.rejects(requestChat({ settings: { baseURL: 'http://model.test/v1', model: 'mock' }, messages: [] }), /ABORTED|aborted|socket hang up/i)
    await assert.rejects(requestChat({ settings: { baseURL: 'http://ollama.test/v1', model: 'mock' }, messages: [] }), /ABORTED|aborted|socket hang up/i)
    await assert.rejects(fetchModelList('http://model.test/v1'), /ABORTED|aborted|socket hang up/i)
    observed.mode = 'stall'; observed.pending = null
    const alreadyAborted = new AbortController(); alreadyAborted.abort()
    await assert.rejects(requestChat({ settings: { baseURL: 'https://model.test/v1', model: 'mock' }, messages: [], signal: alreadyAborted.signal }), /ABORTED/)
    const controller = new AbortController()
    const pending = requestChat({ settings: { baseURL: 'https://model.test/v1', model: 'mock' }, messages: [], signal: controller.signal })
    await until(() => observed.pending, 'CONNECT arrival')
    controller.abort()
    await assert.rejects(pending, /ABORTED/)
    await until(() => observed.pending.closed, 'CONNECT closed after abort')
    if (process.env.AGENT_PROXY_VERIFY_MODEL_TIMEOUT === '1') {
      observed.mode = 'stall'; observed.pending = null
      const start = Date.now()
      await assert.rejects(fetchModelList('https://model.test/v1'), /MODEL_(?:LIST|PROXY)_TIMEOUT/)
      assert(Date.now() - start >= 14000 && Date.now() - start < 18000, 'catalog timeout deadline')
      await until(() => observed.pending.closed, 'model catalog timeout cleanup')
      console.log('PASS 模型列表整体超时和连接释放')
    }
    observed.mode = 'tls-stall'; observed.pending = null
    const failed = new Promise((resolve, reject) => {
      const target = new URL('https://model.test/v1')
      const req = proxy.request(target, { protocol: 'https:', hostname: target.hostname, path: target.pathname, timeout: 1000 }, () => reject(new Error('Unexpected response')))
      req.once('error', resolve); req.end()
    })
    await until(() => observed.pending, 'TLS handshake arrival')
    const error = await failed
    assert(/MODEL_PROXY_TIMEOUT/.test(error.message), error.message)
    await until(() => observed.pending.closed, 'TLS closed after timeout')
    console.log('PASS 代理拒绝、响应中断、连接中取消和 TLS 握手超时资源释放')
  } finally {
    for (const socket of observed.sockets) socket.destroy()
    await Promise.all([close(server), close(secureProxy), close(model), close(secureModel)])
    if (temp) { fs.unlinkSync(path.join(temp, 'test-ca.pem')); fs.rmdirSync(temp) }
  }
}

if (process.argv[2] === '--mock-win-registry') {
  try {
    const windows = target => proxy.resolveProxy(target, { env: {}, platform: 'win32' })
    assert.strictEqual(windows('https://model.test').hostname, 'secure-win.test')
    assert.strictEqual(windows('http://model.test').hostname, 'proxy-win.test')
    assert.strictEqual(windows('https://server.intranet'), null)
    proxy.clearSystemProxyCache(); mockRegistryText += '    AutoConfigURL    REG_SZ    https://pac.invalid/config\n'
    assert.throws(() => windows('https://model.test'), /MODEL_PROXY_PAC_UNSUPPORTED/)
    proxy.clearSystemProxyCache(); mockRegistryError = true
    assert.throws(() => windows('https://model.test'), /MODEL_PROXY_SYSTEM_DISCOVERY_FAILED/)
  } catch (error) { console.error(error.stack); process.exitCode = 1 }
} else if (process.argv[2] === '--http-client') {
  fetchModelList('http://model.test/v1', 'mock-model-key').then(list => assert.deepStrictEqual(list, ['模拟模型'])).catch(error => { console.error(error.stack); process.exitCode = 1 })
} else if (process.argv[2] === '--tls-client') {
  tlsClient(process.argv[3]).catch(error => { console.error(error.stack); process.exitCode = 1 })
} else {
  main().then(() => console.log('Network proxy smoke passed, node ' + process.version)).catch(error => { console.error(error.stack); process.exitCode = 1 })
}
