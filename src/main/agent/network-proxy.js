'use strict'

/* Node 16 不会自动读取桌面系统代理。这里是可替换的模型传输适配器，
 * 不承担模型协议、Agent 状态或 Cordis 服务装配。仅支持手动 HTTP(S) 代理；
 * PAC/WPAD 和仅 SOCKS 的配置明确报错，不静默改为直连。 */
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const tls = require('tls')
const { execFileSync } = require('child_process')

const SYSTEM_PROXY_CACHE_MS = 2000
let systemProxyCache = { at: 0, platform: '', value: null }

function hostWithoutBrackets(value) {
  return String(value || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
}

function formatHost(host) {
  const value = hostWithoutBrackets(host)
  return net.isIP(value) === 6 ? '[' + value + ']' : value
}

function normalizeProxy(value) {
  let raw = String(value || '').trim()
  if (!raw || /^(?:direct|off)$/i.test(raw)) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw
  let parsed
  try { parsed = new URL(raw) } catch (error) { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return null
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null
  try {
    return {
      protocol: parsed.protocol, hostname: hostWithoutBrackets(parsed.hostname), port,
      username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password)
    }
  } catch (error) { return null }
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return {}
  return { 'proxy-authorization': 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password, 'utf8').toString('base64') }
}

// 只处理字面 IP，不把 DNS 解析结果假定为可信的内网身份。
function ipValue(hostname) {
  const host = hostWithoutBrackets(hostname)
  const family = net.isIP(host)
  if (family === 4) {
    return { family, bits: 32, value: host.split('.').reduce((sum, part) => (sum << 8n) + BigInt(Number(part)), 0n) }
  }
  if (family !== 6) return null
  let text = host
  if (text.includes('.')) {
    const index = text.lastIndexOf(':')
    const bytes = text.slice(index + 1).split('.').map(Number)
    text = text.slice(0, index + 1) + ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16)
  }
  const halves = text.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups = halves.length > 1 ? left.concat(Array(8 - left.length - right.length).fill('0'), right) : left
  return { family, bits: 128, value: groups.reduce((sum, part) => (sum << 16n) + BigInt(parseInt(part, 16)), 0n) }
}

function privateIpv4(value) {
  const a = Number(value >> 24n)
  const b = Number((value >> 16n) & 255n)
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function isPrivateHost(hostname) {
  const host = hostWithoutBrackets(hostname)
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.home.arpa')) return true
  const ip = ipValue(host)
  if (!ip) return !host.includes('.') // 避免单标签内网主机名泄露给代理。
  if (ip.family === 4) return privateIpv4(ip.value)
  if (ip.value === 0n || ip.value === 1n) return true
  if ((ip.value >> 32n) === 65535n) return privateIpv4(ip.value & 0xffffffffn) // IPv4 mapped
  return (ip.value >> 121n) === 0x7en || (ip.value >> 118n) === 0x3fan // fc00::/7, fe80::/10
}

function splitBypass(value) {
  if (Array.isArray(value)) return value.reduce((all, item) => all.concat(splitBypass(item)), [])
  return String(value || '').split(/[;,\s]+/).map(item => item.trim()).filter(Boolean)
}

function inCidr(host, entry) {
  const parts = entry.split('/')
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return false
  const target = ipValue(host)
  const network = ipValue(parts[0])
  const length = Number(parts[1])
  if (!target || !network || target.family !== network.family || length > target.bits) return false
  const shift = BigInt(target.bits - length)
  return (target.value >> shift) === (network.value >> shift)
}

function bypasses(hostname, port, entries) {
  const host = hostWithoutBrackets(hostname)
  for (let entry of splitBypass(entries)) {
    entry = entry.toLowerCase()
    if (entry === '*') return true
    if (entry === '<local>') {
      if (!net.isIP(host) && !host.includes('.')) return true
      continue
    }
    if (entry.includes('/')) {
      if (inCidr(host, entry)) return true
      continue
    }
    if (entry.startsWith('[')) {
      const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
      if (!match || (match[2] && Number(match[2]) !== Number(port))) continue
      entry = match[1]
    } else if (!net.isIP(entry)) {
      const match = /^(.*):(\d+)$/.exec(entry)
      if (match) {
        if (Number(match[2]) !== Number(port)) continue
        entry = match[1]
      }
    }
    entry = hostWithoutBrackets(entry)
    if (entry.includes('*')) {
      const pattern = '^' + entry.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
      if (new RegExp(pattern).test(host)) return true
    } else if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true
    } else if (host === entry || (!net.isIP(entry) && host.endsWith('.' + entry))) return true
    else if (net.isIP(entry) && ipValue(host) && ipValue(entry).value === ipValue(host).value && net.isIP(entry) === net.isIP(host)) return true
  }
  return false
}

function readScutilValue(text, key) {
  const expression = new RegExp('(?:^|\\n)\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^\\r\\n]+)')
  const match = expression.exec(String(text || ''))
  return match ? match[1].trim() : ''
}

function readScutilList(text, key) {
  const result = []
  let active = false
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!active && new RegExp('^\\s*' + key + '\\s*:\\s*<array>').test(line)) { active = true; continue }
    if (!active) continue
    if (/^\s*}/.test(line)) break
    const match = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)
    if (match) result.push(match[1])
  }
  return result
}

function parseMacSystemProxy(text) {
  const result = { http: null, https: null, bypass: readScutilList(text, 'ExceptionsList'), socks: readScutilValue(text, 'SOCKSEnable') === '1', pac: false }
  result.pac = readScutilValue(text, 'ProxyAutoConfigEnable') === '1' || readScutilValue(text, 'ProxyAutoDiscoveryEnable') === '1'
  if (readScutilValue(text, 'ExcludeSimpleHostnames') === '1') result.bypass.push('<local>')
  for (const kind of ['HTTP', 'HTTPS']) {
    if (readScutilValue(text, kind + 'Enable') !== '1') continue
    const host = readScutilValue(text, kind + 'Proxy')
    const port = readScutilValue(text, kind + 'Port')
    const value = host && port ? normalizeProxy('http://' + formatHost(host) + ':' + port) : null
    if (!value) throw new Error('MODEL_PROXY_INVALID_SYSTEM_CONFIG')
    result[kind.toLowerCase()] = value
  }
  return result
}

function parseWindowsProxyServer(value) {
  const values = { plain: '' }
  for (const part of String(value || '').split(';').map(item => item.trim()).filter(Boolean)) {
    const index = part.indexOf('=')
    if (index === -1) values.plain = part
    else values[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim()
  }
  const result = { http: null, https: null, bypass: [], socks: Boolean(values.socks), pac: false }
  for (const kind of ['http', 'https']) {
    const raw = values[kind] || values.plain
    if (!raw) continue
    if (/^socks(?:4|5|5h)?:\/\//i.test(raw)) { result.socks = true; continue }
    result[kind] = normalizeProxy(raw)
    if (!result[kind]) throw new Error('MODEL_PROXY_INVALID_SYSTEM_CONFIG')
  }
  return result
}

function readWindowsSystemProxy() {
  // 一次查询同一键，避免在 Windows 下每个请求启动多个 reg 子进程。
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('MODEL_PROXY_SYSTEM_DISCOVERY_FAILED')
  // 不从工作区/PATH 搜索可执行文件，防止工作区内的同名程序被执行。
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe')
  const output = execFileSync(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
    encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
  })
  const values = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+REG_\w+\s+(.+?)\s*$/.exec(line)
    if (match) values[match[1].toLowerCase()] = match[2].trim()
  }
  const enabled = /^(?:0x)?1$/i.test(values.proxyenable || '')
  const result = enabled ? parseWindowsProxyServer(values.proxyserver) : { http: null, https: null, bypass: [], socks: false, pac: false }
  if (enabled && !result.http && !result.https && !result.socks) throw new Error('MODEL_PROXY_INVALID_SYSTEM_CONFIG')
  result.bypass = splitBypass(values.proxyoverride)
  result.pac = Boolean(values.autoconfigurl) || /^(?:0x)?1$/i.test(values.autodetect || '')
  return result
}

function readSystemProxy(platform) {
  const current = platform || process.platform
  const now = Date.now()
  if (systemProxyCache.platform === current && systemProxyCache.value && now - systemProxyCache.at < SYSTEM_PROXY_CACHE_MS) return systemProxyCache.value
  let value = { http: null, https: null, bypass: [], socks: false, pac: false }
  try {
    if (current === 'darwin') value = parseMacSystemProxy(execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }))
    else if (current === 'win32') value = readWindowsSystemProxy()
  } catch (error) {
    if (error && /^MODEL_PROXY_/.test(error.message)) throw error
    throw new Error('MODEL_PROXY_SYSTEM_DISCOVERY_FAILED')
  }
  systemProxyCache = { at: now, platform: current, value }
  return value
}

function clearSystemProxyCache() { systemProxyCache = { at: 0, platform: '', value: null } }

function environmentProxy(target, env) {
  const protocol = target.protocol === 'https:' ? 'HTTPS' : 'HTTP'
  const names = ['AGENT_MODEL_PROXY', 'AGENT_' + protocol + '_PROXY', protocol + '_PROXY', protocol.toLowerCase() + '_proxy', 'AGENT_PROXY', 'ALL_PROXY', 'all_proxy']
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) continue
    const value = String(env[name] || '').trim()
    if (!value) continue
    if (/^(?:direct|off)$/i.test(value)) return { declared: true, proxy: null }
    const proxy = normalizeProxy(value)
    if (!proxy) throw new Error('MODEL_PROXY_UNSUPPORTED_OR_INVALID: ' + name)
    return { declared: true, proxy }
  }
  return { declared: false, proxy: null }
}

function resolveProxy(target, options) {
  const settings = options || {}
  const parsed = target instanceof URL ? target : new URL(String(target))
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('MODEL_URL_UNSUPPORTED_PROTOCOL')
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  const env = settings.env || process.env
  if (isPrivateHost(parsed.hostname) || bypasses(parsed.hostname, port, [env.NO_PROXY, env.no_proxy])) return null
  const configured = environmentProxy(parsed, env)
  if (configured.declared) return configured.proxy
  const system = settings.systemProxy || readSystemProxy(settings.platform)
  if (bypasses(parsed.hostname, port, system.bypass)) return null
  if (system.pac) throw new Error('MODEL_PROXY_PAC_UNSUPPORTED')
  const proxy = parsed.protocol === 'https:' ? system.https : system.http
  if (!proxy && system.socks) throw new Error('MODEL_PROXY_SOCKS_UNSUPPORTED')
  return proxy || null
}

function proxyTransport(proxy) { return proxy.protocol === 'https:' ? https : http }

class HttpsTunnelAgent extends https.Agent {
  constructor(proxy, timeout) {
    super({ keepAlive: false })
    this.proxy = proxy
    this.connectTimeout = timeout
    this.pending = null
  }

  cancelPending(error) {
    const pending = this.pending
    if (pending) pending.finish(error || new Error('MODEL_PROXY_ABORTED'))
  }

  createConnection(options, callback) {
    const host = hostWithoutBrackets(options.servername || options.host || options.hostname)
    const port = Number(options.port || 443)
    const address = formatHost(host) + ':' + port
    const pending = { connect: null, socket: null, secure: null, timer: null }
    this.pending = pending
    const finish = (error, socket) => {
      if (this.pending !== pending) { if (socket) socket.destroy(); return }
      this.pending = null
      clearTimeout(pending.timer)
      if (error) {
        if (pending.connect) pending.connect.destroy()
        if (pending.secure) pending.secure.destroy()
        else if (pending.socket) pending.socket.destroy()
      }
      callback(error, socket)
    }
    pending.finish = finish
    pending.timer = setTimeout(() => finish(new Error('MODEL_PROXY_TIMEOUT')), this.connectTimeout)
    pending.connect = proxyTransport(this.proxy).request({
      protocol: this.proxy.protocol, hostname: this.proxy.hostname, port: this.proxy.port,
      method: 'CONNECT', path: address, headers: Object.assign({ host: address }, proxyAuthorization(this.proxy)), agent: false
    })
    pending.connect.once('connect', (response, socket, head) => {
      pending.socket = socket
      if (this.pending !== pending) { socket.destroy(); return }
      if (response.statusCode !== 200) { finish(new Error('MODEL_PROXY_CONNECT_' + response.statusCode)); return }
      if (head && head.length) socket.unshift(head)
      const servername = options.servername || (net.isIP(host) ? undefined : host)
      pending.secure = tls.connect(Object.assign({}, options, { socket, servername }))
      pending.secure.once('secureConnect', () => finish(null, pending.secure))
      pending.secure.once('error', (error) => finish(error))
    })
    pending.connect.once('error', (error) => finish(error))
    pending.connect.end()
    return undefined
  }
}

function request(target, options, callback) {
  const parsed = target instanceof URL ? target : new URL(String(target))
  const proxy = resolveProxy(parsed)
  // WHATWG URL.hostname 保留 IPv6 方括号，Node 的 request hostname 却要求不带方括号。
  const requestOptions = Object.assign({}, options)
  if (requestOptions.hostname && /^\[.*\]$/.test(requestOptions.hostname)) requestOptions.hostname = requestOptions.hostname.slice(1, -1)
  if (!proxy) return (parsed.protocol === 'https:' ? https : http).request(requestOptions, callback)
  if (parsed.protocol === 'https:') {
    const timeout = Math.max(1000, Math.min(30000, Number(requestOptions.timeout) || 15000))
    const agent = new HttpsTunnelAgent(proxy, timeout)
    const outgoing = https.request(Object.assign({}, requestOptions, { agent }), callback)
    const destroy = outgoing.destroy
    outgoing.destroy = function (error) {
      const result = destroy.call(this, error)
      agent.cancelPending(error)
      return result
    }
    outgoing.once('close', () => agent.cancelPending())
    return outgoing
  }
  const headers = Object.assign({}, options.headers || {})
  if (!Object.keys(headers).some(key => key.toLowerCase() === 'host')) headers.host = parsed.host
  Object.assign(headers, proxyAuthorization(proxy))
  // URL 凭据和 fragment 不能进入 HTTP 代理请求行。
  return proxyTransport(proxy).request({
    protocol: proxy.protocol, hostname: proxy.hostname, port: proxy.port, method: options.method,
    path: parsed.protocol + '//' + parsed.host + parsed.pathname + parsed.search,
    headers, timeout: options.timeout, agent: false
  }, callback)
}

module.exports = { request, resolveProxy, normalizeProxy, parseMacSystemProxy, parseWindowsProxyServer, isPrivateHost, bypasses, clearSystemProxyCache }
