'use strict'

// Agent Service 启动器（主进程侧）。
// 服务本体运行在独立子进程，使用 Electron 内嵌 Node 16.17.1（ELECTRON_RUN_AS_NODE），
// 与桌面应用自身的 Cordis 运行时隔离；这里只负责生成配置、启动、停止和回报地址。
// 仅监听回环地址：按 service 契约，明文 HTTP 不得绑定非回环地址。

const fs = require('fs')
const net = require('net')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const DEFAULT_PORT = 18090
const LOOPBACK = '127.0.0.1'
const hash = value => crypto.createHash('sha256').update(value).digest('hex')


async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK, () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/** 优先使用固定端口：前端（如 HESYN）按固定地址代理，端口每次随机就会 502。 */
async function preferredPort(preferred) {
  const free = await new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(preferred, LOOPBACK, () => server.close(() => resolve(true)))
  })
  return free ? preferred : freePort()
}

class AgentService {
  constructor(options) {
    this.root = options.root
    this.home = options.home
    this.settingsHome = options.settingsHome || ''
    this.directKey = ''
    this.child = null
    this.state = { running: false, address: '', port: 0, startedAt: 0, error: '' }
  }

  configPath() { return path.join(this.home, 'config.json') }

  // 首次启动生成一份本机配置并持久化；令牌只写入本地文件，不在界面展示。
  ensureConfig(port) {
    fs.mkdirSync(this.home, { recursive: true })
    let config = null
    try { config = JSON.parse(fs.readFileSync(this.configPath(), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw Error('AGENT_SERVICE_CONFIG_INVALID: ' + error.message)
    }
    if (config && (!Array.isArray(config.users) || !config.users.length || !Array.isArray(config.hosts) || !config.hosts.length)) throw Error('AGENT_SERVICE_CONFIG_INVALID')
    if (!config) {
      const userToken = crypto.randomBytes(32).toString('base64url')
      const hostToken = crypto.randomBytes(32).toString('base64url')
      config = {
        users: [{ id: 'local', tokenHash: hash(userToken), hosts: ['local'] }],
        hosts: [{ id: 'local', tokenHash: hash(hostToken), users: ['local'], tools: {} }]
      }
    }
    config.publicOrigin = 'http://' + LOOPBACK + ':' + port
    config.host = LOOPBACK
    config.port = port
    config.panelOrigins = ['*']
    delete config.settingsHome
    if (this.settingsHome) {
      config.modelsFile = path.join(this.settingsHome, 'settings.json')
      config.licensingHome = this.settingsHome
      config.allowPanelSettings = true
    }
    if (typeof config.directKey !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(config.directKey)) config.directKey = crypto.randomBytes(24).toString('base64url')
    // 面板与场景工具通道只凭这一条地址 + 密钥直连，不再需要独立桥接。
    this.directKey = config.directKey
    fs.writeFileSync(this.configPath(), JSON.stringify(config, null, 2) + '\n')
    return config
  }

  /** 只同步模型字段到服务自己的设置，避免共享工作流/工作区及其进程锁。 */
  syncModels() {
    if (!this.settingsHome) return
    const source = path.join(this.settingsHome, 'settings.json')
    let settings
    try { settings = JSON.parse(fs.readFileSync(source, 'utf8')) } catch (error) { return }
    const fields = ['models', 'currentModelId', 'maxIterations', 'contextWindowTokens', 'maxTokens', 'baseURL', 'apiKey', 'model', 'thinking']
    const patch = {}
    for (const field of fields) if (settings[field] !== undefined) patch[field] = settings[field]
    if (!Object.keys(patch).length) return
    const dataHome = path.join(this.home, 'data')
    fs.mkdirSync(dataHome, { recursive: true })
    const target = path.join(dataHome, 'settings.json')
    let current = {}
    try { current = JSON.parse(fs.readFileSync(target, 'utf8')) } catch (error) {}
    fs.writeFileSync(target, JSON.stringify({ ...current, ...patch }, null, 2) + String.fromCharCode(10))
  }


  async start() {
    if (this.child) return this.status()
    const port = await preferredPort(DEFAULT_PORT)
    this.ensureConfig(port)
    this.syncModels()
    const dataHome = path.join(this.home, 'data')
    // 打包后位于 agent-service/index.js（与桌面自带 service/ 分离）；开发态直接跑仓库 service/。
    const candidates = [path.join(this.root, 'agent-service', 'index.js'), path.join(this.root, 'service', 'index.js')]
    const entry = candidates.find(file => fs.existsSync(file))
    if (!entry) throw Error('AGENT_SERVICE_ENTRY_MISSING')
    const env = Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_SERVICE_CONFIG: this.configPath(),
      AGENT_HOME: dataHome
    })
    const child = spawn(process.execPath, [entry], { cwd: this.home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.state = { running: true, address: '', port, startedAt: Date.now(), error: '' }
    let output = ''
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('AGENT_SERVICE_START_TIMEOUT')) }, 20000)
      const cleanup = () => { clearTimeout(timer); child.stdout.removeListener('data', onData); child.removeListener('exit', onExit); child.removeListener('error', onError) }
      const onError = error => { cleanup(); this.child = null; reject(error) }
      const onData = chunk => {
        output += String(chunk)
        const match = /listening on ([^\s:]+):(\d+)/.exec(output)
        if (match) {
          cleanup()
          this.state.address = match[1] + ':' + match[2]
          this.state.port = Number(match[2])
          resolve()
        }
      }
      const onExit = code => {
        cleanup()
        this.child = null
        this.state = { running: false, address: '', port: 0, startedAt: 0, error: 'AGENT_SERVICE_EXITED_' + (code === null ? 'ABORTED' : code) }
        reject(Error(this.state.error))
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', chunk => { output += String(chunk) })
      child.once('exit', onExit)
      child.once('error', onError)
    })
    try {
      await ready
    } catch (error) {
      this.state.error = error.message
      if (this.child) this.child.kill()
      this.child = null
      this.state.running = false
      throw error
    }
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      this.state = { running: false, address: '', port: 0, startedAt: 0, error: code ? 'AGENT_SERVICE_EXITED_' + code : '' }
    })
    return this.status()
  }

  async stop() {
    const child = this.child
    if (!child) { this.state.running = false; return this.status() }
    this.child = null
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(done, 5000)
      child.once('exit', done)
      child.kill()
    })
    this.state = { running: false, address: '', port: 0, startedAt: 0, error: '' }
    return this.status()
  }

  status() {
    const address = this.state.address ? 'http://' + this.state.address : ''
    return {
      running: Boolean(this.child),
      address,
      port: this.state.port,
      ip: LOOPBACK,
      key: this.directKey,
      connectUrl: address && this.directKey ? address + '/?key=' + this.directKey : '',
      error: this.state.error || '',
      configPath: this.configPath()
    }
  }

  dispose() {
    if (this.child) { try { this.child.kill() } catch (_) {} this.child = null }
  }
}

module.exports = { AgentService, DEFAULT_PORT }
