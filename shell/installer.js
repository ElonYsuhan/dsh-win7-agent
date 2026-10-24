'use strict'

/**
 * 桌面版「双击新版就自动接管旧版」的替换逻辑。
 *
 * 背景：安装包是免安装便携包，用户可能把不同版本的包解压到不同目录。
 * 数据（会话 / 设置 / 工作区）全在 Electron userData 下，不在程序目录，
 * 所以程序目录可以整份删掉重来。于是更新 = 把新版文件搬到旧版位置。
 *
 * 登记文件：<userData>/install.json
 *   { path, version, pid, updatedAt }
 * 每次正常启动都会刷新，记录「当前生效的是哪一份程序」。
 *
 * 本模块是纯 Node，不依赖 Electron，方便单测。
 */

const fs = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const crypto = require('crypto')
const metadata = require(fs.existsSync(path.join(__dirname, 'src/main/platform/build-metadata.js')) ? './src/main/platform/build-metadata' : '../src/main/platform/build-metadata')

const MANIFEST_NAME = 'install.json'
const TRASH_PREFIX = '.old-'
const DEFAULT_APP_NAME = 'Agent'

// Managed installers own their installation. AppImage mounts are read-only and
// must never be copied into an old loose Electron directory by legacy takeover.
function allowsDirectoryTakeover(appDirectory, platform, environment) {
  if (platform === 'linux' && environment && environment.APPIMAGE) return false
  const marker = path.join(appDirectory, 'distribution.json')
  if (!fs.existsSync(marker)) return true
  try {
    const info = JSON.parse(fs.readFileSync(marker, 'utf8'))
    return info.formatVersion === 1 && info.kind === 'app-bundle' && info.directoryTakeover === true
  } catch (error) { return false }
}

// macOS Gatekeeper mounts quarantined apps read-only at a transient location.
function isTransientPackage(packageDir, platform) {
  return platform === 'darwin' && /(?:^|\/)AppTranslocation\//.test(String(packageDir || '').replace(/\\/g, '/'))
}

const not = (value) => value ? false : true

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Fingerprint shipped application code, independent of the public version. */
function packageBuildId(packageDir, platform) {
  const root = platform === 'darwin' ? path.join(packageDir, 'Contents', 'Resources', 'app') : path.join(packageDir, 'resources', 'app')
  const built = metadata.read(root)
  return built ? built.packageBuildId : computePackageBuildId(root)
}

function computePackageBuildId(root) {
  const hash = crypto.createHash('sha256')
  function visit(dir, relative, depth) {
    if (depth > 16) throw new Error('APP_BUILD_DEPTH')
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      if (item.name === 'node_modules' || item.name === metadata.NAME || item.isSymbolicLink()) continue
      const rel = relative ? relative + '/' + item.name : item.name
      if (item.isDirectory()) visit(path.join(dir, item.name), rel, depth + 1)
      else if (/\.(js|json|css|html)$/.test(item.name)) { hash.update(rel + '\0'); hash.update(fs.readFileSync(path.join(dir, item.name))); hash.update('\0') }
    }
  }
  visit(root, '', 0)
  return hash.digest('hex')
}

/* --------------------------------------------------------------- manifest */

function manifestPath(userDataDir) {
  return path.join(String(userDataDir || ''), MANIFEST_NAME)
}

/** 读登记文件；不存在或损坏都返回 null（不抛）。 */
function readManifest(userDataDir) {
  try {
    const raw = fs.readFileSync(manifestPath(userDataDir), 'utf8')
    const parsed = JSON.parse(raw)
    if (not(parsed) || typeof parsed !== 'object') return null
    return {
      path: typeof parsed.path === 'string' ? parsed.path : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
      pid: Number(parsed.pid) || 0,
      buildId: typeof parsed.buildId === 'string' ? parsed.buildId : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    }
  } catch (error) {
    return null
  }
}

/** 合并写入登记文件。写失败不抛（只影响下次是否提示更新）。 */
function writeManifest(userDataDir, patch) {
  const current = readManifest(userDataDir) || { path: '', version: '', pid: 0, updatedAt: '' }
  const next = Object.assign({}, current, patch || {}, {
    updatedAt: new Date().toISOString()
  })
  try {
    fs.mkdirSync(String(userDataDir), { recursive: true })
    const target = manifestPath(userDataDir), temporary = target + '.' + process.pid + '.tmp'
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
      fs.renameSync(temporary, target)
    } finally { try { fs.unlinkSync(temporary) } catch (error) {} }
  } catch (error) {}
  return next
}

function clearManifest(userDataDir) {
  try {
    fs.rmSync(manifestPath(userDataDir), { force: true })
    return true
  } catch (error) {
    return false
  }
}

/* ------------------------------------------------------------------ paths */

/**
 * 当前这份程序所在的「包目录」。
 *  - win / linux：可执行文件所在目录（目录里就是 exe + 运行时 + resources）
 *  - macOS：.app 本身（替换时整包换掉）
 * 开发态（未打包）不要调用，主进程里有 isPackaged 判断挡着。
 */
function packageDirOf(execPath, platform) {
  const target = String(execPath || '')
  const os = platform || process.platform
  if (os === 'darwin') {
    // <...>/Agent.app/Contents/MacOS/Electron -> <...>/Agent.app
    return path.resolve(target, '..', '..', '..')
  }
  return path.dirname(target)
}

/**
 * 读 Info.plist 里的 CFBundleExecutable。
 * 打包脚本刻意让 macOS 包内的主二进制保持 Electron 原名（只改 .app 目录名），
 * 所以不能直接拿产品名去拼路径 —— 踩过一次。
 */
function plistExecutableName(packageDir) {
  try {
    const raw = fs.readFileSync(path.join(String(packageDir), 'Contents', 'Info.plist'), 'utf8')
    const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(raw)
    return match ? match[1].trim() : ''
  } catch (error) {
    return ''
  }
}

function isExecutableFile(target) {
  try {
    const stat = fs.statSync(target)
    if (not(stat.isFile())) return false
    return (stat.mode & 0o111) !== 0
  } catch (error) {
    return false
  }
}

/** 包目录里真正要双击启动的那个可执行文件。 */
function mainBinaryOf(packageDir, platform, appName) {
  const dir = String(packageDir || '')
  const os = platform || process.platform
  const name = appName || DEFAULT_APP_NAME
  if (os === 'darwin') {
    const macosDir = path.join(dir, 'Contents', 'MacOS')
    const candidates = []
    const declared = plistExecutableName(dir)
    if (declared) candidates.push(path.join(macosDir, declared))
    candidates.push(path.join(macosDir, name))
    candidates.push(path.join(macosDir, 'Electron'))
    for (const item of candidates) {
      if (isExecutableFile(item)) return item
    }
    return candidates[0]
  }
  if (os === 'win32') return path.join(dir, name + '.exe')
  return path.join(dir, name)
}

/** 同一目录判定：Windows / macOS 文件系统大小写不敏感，比较时先归一小写。 */
function normalizePath(value, platform) {
  const os = platform || process.platform
  let out = path.resolve(String(value || ''))
  if (out.length > 1 && out.endsWith(path.sep)) out = out.slice(0, -1)
  if (os === 'win32' || os === 'darwin') out = out.toLowerCase()
  return out
}

function samePath(left, right, platform) {
  if (not(left) || not(right)) return false
  return normalizePath(left, platform) === normalizePath(right, platform)
}

/* --------------------------------------------------------------- versions */

function parseVersion(value) {
  const parts = String(value || '').split('.')
  const out = [0, 0, 0]
  for (let index = 0; index < 3; index++) {
    const num = parseInt(parts[index], 10)
    out[index] = Number.isFinite(num) && num > 0 ? num : 0
  }
  return out
}

/** a > b 返回 1，相等 0，a < b 返回 -1。 */
function compareVersion(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] > b[index]) return 1
    if (a[index] < b[index]) return -1
  }
  return 0
}

/* --------------------------------------------------------------- process */

function isAlive(pid) {
  const value = Number(pid)
  if (not(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但不属于当前用户
    return (error && error.code === 'EPERM') ? true : false
  }
}

/**
 * 结束旧实例。连同它拉起的服务子进程一起收掉。
 * 注意：进程退出后句柄不会立刻释放，调用方要靠 replacePackage 的改名探测确认。
 */
function killTree(pid, platform) {
  const value = Number(pid)
  if (not(value) || value <= 0) return false
  const os = platform || process.platform
  if (os === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(value), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      return true
    } catch (error) {
      return false
    }
  }
  try {
    process.kill(value, 'SIGTERM')
    return true
  } catch (error) {
    return false
  }
}

/** Only terminate the recorded PID when it still belongs to that package. */
function processOwnsPackage(pid, packageDir, platform) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0 || value === process.pid) return false
  const os = platform || process.platform, binary = mainBinaryOf(packageDir, os)
  try {
    if (os === 'win32') {
      let executable = ''
      try {
        const bytes = execFileSync('wmic', ['process', 'where', 'ProcessId=' + value, 'get', 'ExecutablePath', '/value'], { timeout: 3000, windowsHide: true })
        const text = bytes.toString(bytes.includes(0) ? 'utf16le' : 'utf8')
        const match = /ExecutablePath=([^\r\n]+)/i.exec(text); executable = match ? match[1].trim() : ''
      } catch (error) {}
      if (!executable) executable = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; (Get-WmiObject Win32_Process -Filter 'ProcessId = " + value + "').ExecutablePath"], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim()
      return samePath(executable, binary, os)
    }
    const command = execFileSync('ps', ['-p', String(value), '-o', 'command='], { encoding: 'utf8', timeout: 2000 }).trim()
    return command === binary || command.startsWith(binary + ' ')
  } catch (error) { return false }
}

/** 等进程真的消失；返回 true 表示已退出。 */
async function waitGone(pid, timeoutMs) {
  const limit = timeoutMs === undefined ? 10000 : timeoutMs
  const step = 250
  let waited = 0
  while (waited <= limit) {
    if (not(isAlive(pid))) return true
    await sleep(step)
    waited += step
  }
  return not(isAlive(pid))
}

/* ---------------------------------------------------------------- copying */

/**
 * 递归复制目录。刻意不用 fs.cp：一个是要在 Node 16 上跑，
 * 另一个是 macOS 包里的 Framework 有一堆符号链接，必须原样重建。
 */
function copyTree(srcDir, dstDir, stats) {
  const info = stats || { files: 0, bytes: 0, dirs: 0, links: 0 }
  fs.mkdirSync(dstDir, { recursive: true })
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(srcDir, entry.name)
    const to = path.join(dstDir, entry.name)
    let stat = null
    try {
      stat = fs.lstatSync(from)
    } catch (error) {
      continue
    }
    if (stat.isSymbolicLink()) {
      let link = null
      try {
        link = fs.readlinkSync(from)
      } catch (error) {
        link = null
      }
      if (link) {
        try {
          fs.symlinkSync(link, to)
          info.links++
        } catch (error) {}
      }
      continue
    }
    if (stat.isDirectory()) {
      info.dirs++
      copyTree(from, to, info)
      try {
        fs.chmodSync(to, stat.mode)
      } catch (error) {}
      continue
    }
    if (not(stat.isFile())) continue
    fs.copyFileSync(from, to)
    try {
      fs.chmodSync(to, stat.mode & 0o777)
    } catch (error) {}
    info.files++
    info.bytes += stat.size
  }
  return info
}

/** 包目录的同级残留：上次没能删掉的 .old-xxx。 */
function cleanupTrash(packageDir) {
  const dir = path.dirname(String(packageDir || ''))
  const base = path.basename(String(packageDir || ''))
  const removed = []
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (error) {
    return removed
  }
  for (const name of entries) {
    if (name.indexOf(base + TRASH_PREFIX) !== 0) continue
    const target = path.join(dir, name)
    try {
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(target)
    } catch (error) {}
  }
  return removed
}

/**
 * 把 srcDir 的内容搬到 dstDir（dstDir 原有内容清掉）。
 *
 * 顺序刻意这么排：
 *  1. dstDir 改名成 .old-<时间戳> —— 这一步同时是「文件锁探测」，
 *     Windows 上目录里有进程占用的文件时改名会失败。
 *  2. 在原名位置重新建目录并复制新版。
 *  3. 删掉 .old-<时间戳>；删不掉就留给下次启动的 cleanupTrash 收拾。
 * 第 2 步失败会尝试把旧目录改回来，避免用户手里只剩一堆垃圾。
 */
async function replacePackage(options) {
  const settings = options || {}
  const srcDir = settings.srcDir
  const dstDir = settings.dstDir
  const platform = settings.platform || process.platform
  const retries = settings.retries === undefined ? 12 : settings.retries
  const retryDelay = settings.retryDelay === undefined ? 500 : settings.retryDelay

  if (not(srcDir) || not(dstDir)) return { ok: false, error: 'MISSING_PATH' }
  if (samePath(srcDir, dstDir, platform)) return { ok: false, error: 'SAME_PATH' }
  if (not(fs.existsSync(srcDir))) return { ok: false, error: 'SOURCE_MISSING' }

  const trash = dstDir + TRASH_PREFIX + Date.now()
  let moved = false
  let lastLocked = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (fs.existsSync(dstDir)) fs.renameSync(dstDir, trash)
      moved = true
      break
    } catch (error) {
      lastLocked = error
      if (typeof settings.onLockedAttempt === 'function') {
        try {
          await settings.onLockedAttempt(attempt + 1)
        } catch (inner) {}
      }
      if (attempt < retries) await sleep(retryDelay)
    }
  }

  if (not(moved)) {
    return {
      ok: false,
      error: 'DIR_LOCKED',
      detail: String((lastLocked && lastLocked.message) || lastLocked || ''),
      dstDir
    }
  }

  let stats = null
  try {
    stats = copyTree(srcDir, dstDir, { files: 0, bytes: 0, dirs: 0, links: 0 })
  } catch (error) {
    try {
      fs.rmSync(dstDir, { recursive: true, force: true })
    } catch (inner) {}
    let rolledBack = false
    try {
      fs.renameSync(trash, dstDir)
      rolledBack = true
    } catch (inner) {}
    return {
      ok: false,
      error: 'COPY_FAILED',
      detail: String((error && error.message) || error || ''),
      rolledBack
    }
  }

  let leftover = ''
  try {
    fs.rmSync(trash, { recursive: true, force: true })
  } catch (error) {
    leftover = trash
  }

  return { ok: true, stats, trash, leftover, dstDir, srcDir }
}

/**
 * 启动刚搬过去的新版本。
 *
 * 两个坑：
 *  1. 必须清掉 ELECTRON_RUN_AS_NODE —— Shell 为了跑服务会把它塞进环境变量，
 *     残留下去新进程会被当成 Node 解释器跑。
 *  2. 必须把当前进程的启动参数带过去。用户可能就是用 --user-data-dir 之类的
 *     开关启动的，参数丢了新进程会换一个数据目录，看起来就像「会话全没了」。
 */
function relaunch(packageDir, options) {
  const settings = options || {}
  const platform = settings.platform || process.platform
  const binary = mainBinaryOf(packageDir, platform, settings.appName)
  if (not(fs.existsSync(binary))) {
    return { ok: false, error: 'BINARY_MISSING', binary }
  }
  const args = Array.isArray(settings.args) ? settings.args : []
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(binary, args, {
    cwd: packageDir,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', () => {})
  child.unref()
  return child.pid ? { ok: true, pid: child.pid, binary, args } : { ok: false, error: 'RELAUNCH_FAILED', binary }
}

module.exports = {
  computePackageBuildId,
  allowsDirectoryTakeover,
  isTransientPackage,
  packageBuildId,
  MANIFEST_NAME,
  TRASH_PREFIX,
  DEFAULT_APP_NAME,
  manifestPath,
  readManifest,
  writeManifest,
  clearManifest,
  packageDirOf,
  mainBinaryOf,
  plistExecutableName,
  isExecutableFile,
  normalizePath,
  samePath,
  parseVersion,
  compareVersion,
  isAlive,
  processOwnsPackage,
  killTree,
  waitGone,
  copyTree,
  cleanupTrash,
  replacePackage,
  relaunch,
  sleep
}
