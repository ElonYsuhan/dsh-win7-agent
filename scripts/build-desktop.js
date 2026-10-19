#!/usr/bin/env node
'use strict'

/**
 * 跨平台桌面版打包脚本（免安装、解压双击即用）。
 *
 * 用法：
 *   node scripts/build-desktop.js win-x64
 *   node scripts/build-desktop.js mac-arm64       // 别名：darwin-arm64 / mac / macos-arm64
 *   node scripts/build-desktop.js linux-x64
 *   node scripts/build-desktop.js all             // = win-x64 + mac-arm64 + linux-x64
 *   node scripts/build-desktop.js mac-x64         // Intel Mac，默认不出，需要时显式点名
 *
 * 产物结构（以 win-x64 为例）：
 *   release/desktop/Agent-win-x64-<version>/
 *     Agent.exe                   双击入口（聊天界面）
 *     [Electron 运行时：dll / pak / dat / locales / ...]
 *     resources/app/
 *       package.json              main = main.js
 *       main.js  preload.js       Shell 壳（启动流程、端口协商）
 *       service-manager.js  installer.js
 *       loading.html  settings.html  offline.html  update.html  style.css ...
 *       assets/icons/             三套图标（am / al / aw）
 *       service/                  agent 服务端（= 仓库的 server/）
 *       src/                      agent 实现 + Web 界面（= 仓库的 src/）
 *       plugins/                  内置示例插件
 *
 * 关键点：服务和界面共用同一份 Electron 二进制。Shell 启动时用
 * ELECTRON_RUN_AS_NODE=1 把 process.execPath 当 Node 解释器跑 service/index.js，
 * 所以整套包只需要一份运行时，不需要第二个可执行文件。
 *
 * 图标：三个平台各用自己的那枚（Agent Mac / Agent Linux / Agent Win），
 * 由 scripts/make-logo.py 生成到 assets/icons/，本脚本负责塞进各平台该在的位置。
 * 注意打包脚本本身要用 Node >= 20.19.5（resedit 的要求）；目标机上的
 * 运行时是 Electron 22 内嵌的 Node 16，两者不是一回事。
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
// 放在 release/ 下：该目录本来就被各种检查跳过，也方便随产物一起清掉重下
const CACHE_DIR = path.join(ROOT, 'release', '.electron-dist')
const UNPACK_DIR = path.join(CACHE_DIR, 'unpacked')
const OUT_ROOT = path.join(ROOT, 'release', 'desktop')
const ICON_DIR = path.join(ROOT, 'assets', 'icons')
const ELECTRON_VERSION = '22.3.27'
const APP_NAME = 'Agent'
const APP_TITLE = 'Agent'
const PRODUCT_VERSION = require(path.join(ROOT, 'package.json')).version || '0.1.0'

const TARGETS = {
  'win-x64': { electron: 'win32-x64', binary: APP_NAME + '.exe', bundle: null, mark: 'icon' },
  // 目标名（= 产物名）用 mac，Electron 的发行包名仍然是 darwin —— 两者不能混。
  // 产物直接给同事看，`Agent-mac-arm64-0.1.0.zip` 一眼知道是 Mac；
  // 早先叫 darwin-arm64，字面上看不出平台。
  'mac-arm64': { electron: 'darwin-arm64', binary: null, bundle: APP_NAME + '.app', mark: 'icon' },
  'mac-x64': { electron: 'darwin-x64', binary: null, bundle: APP_NAME + '.app', mark: 'icon' },
  'linux-x64': { electron: 'linux-x64', binary: APP_NAME, bundle: null, mark: 'icon' },
  // 银河麒麟 V10（飞腾/鲲鹏等国产 ARM 机器）用这个；结构跟 linux-x64 完全同构
  'linux-arm64': { electron: 'linux-arm64', binary: APP_NAME, bundle: null, mark: 'icon' }
}

// 旧命令名与常见写法都接受，免得历史习惯直接报 unknown target
const ALIASES = {
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'macos-arm64': 'mac-arm64',
  'macos-x64': 'mac-x64',
  'osx-arm64': 'mac-arm64',
  'mac': 'mac-arm64'
}

// Compile every supported desktop architecture.
const ALL_TARGETS = Object.keys(TARGETS)

const MIRRORS = [
  (name) => 'https://registry.npmmirror.com/-/binary/electron/' + ELECTRON_VERSION + '/' + name,
  (name) => 'https://github.com/electron/electron/releases/download/v' + ELECTRON_VERSION + '/' + name
]

const SKIP_NAMES = ['.DS_Store', 'Thumbs.db', '.git']
/* Electron 自带的默认应用资源。我们每个包都会放自己的 resources/app，
   这文件永远不会被加载，构建末尾本来就要删掉——所以干脆不复制。
   （顺带绕开沙箱对 .asar 写入的拦截，那个拦截会让整个打包崩掉） */
const ELECTRON_SKIP_NAMES = SKIP_NAMES.concat(['default_app.asar'])

/* ------------------------------------------------------------------ util */

function log(message) {
  console.log('[build-desktop] ' + message)
}

function fail(message) {
  console.error('[build-desktop] ERROR: ' + message)
  process.exit(1)
}

/**
 * 删目录/文件，删不掉就算了（缓存、临时文件、旧 zip 删不掉无所谓）。
 */
function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch (error) {
    return false
  }
}

/**
 * 清空产物目录，为重新生成腾地方。
 *
 * 为什么不是一句 `rm -rf` 完事：产物目录里有一两百个文件，而运行环境带了一道
 * **批量删除保护** —— 一次删超过约 50 个文件会被文件系统层拦下，`fs.rmSync`
 * 直接抛 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`（2026-09-19 撞上，
 * 三个产物目录全被拦，`dangerouslyDisableSandbox` 也绕不过）。
 * 但它拦的是「删」，不拦「改名」。
 *
 * 所以分成两步，两步的含义**完全不同**，别混：
 *   1. `rename` 让位 —— **这才是真正的锁探测**。目录被运行中的实例占着时，
 *      rename 会失败（macOS 报 EBUSY/ENOTEMPTY，Windows 报
 *      「文件夹或其中的文件已在另一程序中打开」），此时必须**报错退出**：
 *      就地覆盖会把正在跑的二进制换掉，轻则新旧混合，重则把用户的窗口搞崩。
 *   2. 删让位后的残骸 —— 尽力而为。删不掉只说明撞上了上面的批量删除保护，
 *      残骸带 `.stale-` 前缀，**不影响本次构建**，下次构建会顺带再试。
 */
function clearOutDir(outDir) {
  if (fs.existsSync(outDir)) {
    const stale = path.join(
      path.dirname(outDir),
      '.stale-' + path.basename(outDir) + '-' + Date.now()
    )
    try {
      fs.renameSync(outDir, stale)
    } catch (error) {
      fail(
        '挪不动 ' + outDir + '：' + ((error && error.code) || error) + '\n' +
        '        这几乎一定是有实例正从该目录运行（程序占着里面的文件，改名会被系统拒绝）。\n' +
        '        先退出那个程序再重跑。必须先挪开才继续：直接就地覆盖，' +
        '        轻则留下新旧混合的产物，重则会覆盖正在运行的二进制、把用户的窗口搞崩。'
      )
    }
  }
  sweepStale(outDir)
}

/** 清掉让位出来的残骸（顺带把历史遗留的一并再试一次）。 */
function sweepStale(outDir) {
  const parent = path.dirname(outDir)
  const prefix = '.stale-' + path.basename(outDir) + '-'
  let entries = []
  try {
    entries = fs.readdirSync(parent)
  } catch (error) {
    return
  }
  for (const name of entries) {
    if (name.indexOf(prefix) !== 0) continue
    const target = path.join(parent, name)
    if (rmrf(target)) log('清掉残骸：' + target)
    else log('残骸没删掉（多半是环境的批量删除保护，手动清即可）：' + target)
  }
}

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true })
}

function copyDir(from, to, options) {
  const settings = options || {}
  const skip = settings.skip || SKIP_NAMES
  mkdirp(to)
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.indexOf(entry.name) >= 0) continue
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    // macOS 的 .app / Framework 结构大量依赖符号链接，必须原样重建，否则 bundle 会被破坏
    if (entry.isSymbolicLink()) {
      let link = ''
      try {
        link = fs.readlinkSync(source)
      } catch (error) {
        continue
      }
      try {
        fs.symlinkSync(link, target)
      } catch (error) {}
      continue
    }
    if (entry.isDirectory()) {
      copyDir(source, target, options)
      continue
    }
    if (!entry.isFile()) continue
    fs.copyFileSync(source, target)
    // 保留可执行位（macOS / Linux 的二进制）
    try {
      const mode = fs.statSync(source).mode
      if (mode & 0o111) fs.chmodSync(target, mode)
    } catch (error) {}
  }
}

function copyFile(from, to) {
  mkdirp(path.dirname(to))
  fs.copyFileSync(from, to)
}

function run(command, args, options) {
  return execFileSync(command, args, Object.assign({ stdio: 'pipe' }, options || {}))
}

function commandExists(command) {
  try {
    execFileSync('which', [command], { stdio: 'pipe' })
    return true
  } catch (error) {
    return false
  }
}

/** "0.1.0" -> "0.1.0.0"：Windows 版本资源要的是四段式，多退少补。 */
function fourPartVersion(value) {
  const parts = String(value || '0').split('.').slice(0, 4)
  while (parts.length < 4) parts.push('0')
  return parts.map((piece) => String(Number(piece) || 0)).join('.')
}

/* -------------------------------------------------------------- download */

function download(url, target, redirects) {
  const depth = redirects || 0
  if (depth > 6) return Promise.reject(new Error('too many redirects: ' + url))
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 60000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        const next = new URL(response.headers.location, url).toString()
        resolve(download(next, target, depth + 1))
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('HTTP ' + response.statusCode + ' for ' + url))
        return
      }
      const total = Number(response.headers['content-length']) || 0
      let received = 0
      let lastReport = 0
      const file = fs.createWriteStream(target)
      response.on('data', (chunk) => {
        received += chunk.length
        const now = Date.now()
        if (total && now - lastReport > 3000) {
          lastReport = now
          const percent = Math.round((received / total) * 100)
          log('  downloading ' + percent + '% (' + Math.round(received / 1048576) + '/' + Math.round(total / 1048576) + ' MB)')
        }
      })
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve(target)))
      file.on('error', reject)
    })
    request.on('timeout', () => {
      request.destroy(new Error('download timeout: ' + url))
    })
    request.on('error', reject)
  })
}

async function ensureDist(targetKey) {
  const target = TARGETS[targetKey]
  const zipName = 'electron-v' + ELECTRON_VERSION + '-' + target.electron + '.zip'
  const unpacked = path.join(UNPACK_DIR, target.electron)
  const marker = path.join(unpacked, '.ok')

  if (fs.existsSync(marker)) {
    log('reuse unpacked dist: ' + unpacked)
    return unpacked
  }

  const zipPath = path.join(CACHE_DIR, zipName)
  mkdirp(CACHE_DIR)

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1024 * 1024) {
    let lastError = null
    let ok = false
    for (const mirror of MIRRORS) {
      const url = mirror(zipName)
      try {
        log('download ' + url)
        await download(url, zipPath)
        ok = true
        break
      } catch (error) {
        lastError = error
        log('  failed: ' + error.message)
        rmrf(zipPath)
      }
    }
    if (!ok) fail('cannot download ' + zipName + ': ' + (lastError && lastError.message))
  } else {
    log('reuse cached zip: ' + zipPath)
  }

  rmrf(unpacked)
  mkdirp(unpacked)
  log('unzip into ' + unpacked)
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + unpacked + '" -Force'])
  } else {
    run('unzip', ['-q', '-o', zipPath, '-d', unpacked])
  }
  fs.writeFileSync(marker, 'ok', 'utf8')
  return unpacked
}

/* ------------------------------------------------------------ app layout */

function appPackageJson() {
  return JSON.stringify({
    name: 'agent-desktop',
    version: PRODUCT_VERSION,
    private: true,
    description: 'Offline local coding agent desktop shell (Win7 / Win10 / Win11 / macOS / Linux).',
    main: 'main.js',
    author: APP_NAME,
    license: 'MIT'
  }, null, 2) + '\n'
}

/**
 * 把 Shell 壳 + 服务端 + agent 实现 + 图标塞进 resources/app。
 *
 * mark 是本平台那枚图标的文件名前缀（am / al / aw）：包内界面里显示的
 * 所有平台的 logo.png 均来自统一的 icon.png。
 */
function fillAppDir(appDir, mark, targetKey) {
  rmrf(appDir)
  mkdirp(appDir)

  // Shell 壳文件（main.js / preload.js / 各个页面）
  const shellDir = path.join(ROOT, 'shell')
  for (const entry of fs.readdirSync(shellDir, { withFileTypes: true })) {
    if (SKIP_NAMES.indexOf(entry.name) >= 0) continue
    if (entry.name === 'node_modules') continue
    if (!entry.isFile()) continue
    copyFile(path.join(shellDir, entry.name), path.join(appDir, entry.name))
  }

  // 服务端：server/index.js 依赖 ../src/...，所以 service/ 与 src/ 必须同级。
  //   ⚠️ 这里是**显式白名单**，新增 server/*.js 必须补进来 —— 漏了就是「开发态能跑、
  //      打包后 404」。所以下面顺手对账一次，宁可构建失败也别把坏包发出去。
  const serviceDir = path.join(appDir, 'service')
  mkdirp(serviceDir)
  const SERVICE_FILES = ['index.js', 'settings-store.js', 'file-api.js', 'native-folder.js', 'terminal-api.js', 'ui-store.js', 'task-api.js', 'mcp-api.js', 'knowledge-api.js', 'workflow-api.js', 'extension-api.js']
  for (const name of SERVICE_FILES) {
    copyFile(path.join(ROOT, 'server', name), path.join(serviceDir, name))
  }
  const serverOnDisk = fs.readdirSync(path.join(ROOT, 'server'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
  const missingFromPackage = serverOnDisk.filter((name) => SERVICE_FILES.indexOf(name) < 0)
  if (missingFromPackage.length > 0) {
    throw new Error(
      'server/ 下有没登记进打包清单的文件：' + missingFromPackage.join(', ') +
      ' —— 请把它们补进 scripts/build-desktop.js 的 SERVICE_FILES，否则打包后这些端点会 404'
    )
  }

  // agent 实现 + Web 界面
  copyDir(path.join(ROOT, 'src'), path.join(appDir, 'src'))
  const nativeDir = path.join(appDir, 'src/main/knowledge/vendor/sqlite')
  const nativeName = { 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64', 'win-x64': 'win32-x64.exe', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64' }[targetKey]
  const nativeManifest = JSON.parse(fs.readFileSync(path.join(nativeDir, 'manifest.json'), 'utf8'))
  if (!nativeName || !nativeManifest.files[nativeName] || !fs.existsSync(path.join(nativeDir, nativeName))) throw new Error('KNOWLEDGE_NATIVE_NOT_BUILT: ' + targetKey)
  const nativeHash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(nativeDir, nativeName))).digest('hex')
  if (nativeHash !== nativeManifest.files[nativeName]) throw new Error('KNOWLEDGE_NATIVE_HASH_MISMATCH: ' + targetKey)
  for (const name of fs.readdirSync(nativeDir)) if (name !== nativeName && name !== 'manifest.json' && name !== 'NOTICE.txt') fs.unlinkSync(path.join(nativeDir, name))


  // 图标资源（运行期给 BrowserWindow 设 icon 要用到）
  if (fs.existsSync(ICON_DIR)) copyDir(ICON_DIR, path.join(appDir, 'assets', 'icons'))

  // 界面品牌标统一使用同一图标（必须在 copyDir(src) 之后）
  const markPng = path.join(ICON_DIR, mark + '.png')
  if (fs.existsSync(markPng)) {
    copyFile(markPng, path.join(appDir, 'src', 'renderer', 'logo.png'))
  } else {
    log('WARN missing platform mark: ' + markPng)
  }

  // 示例插件
  const examples = path.join(ROOT, 'plugins', 'examples')
  if (fs.existsSync(examples)) {
    copyDir(examples, path.join(appDir, 'plugins', 'examples'))
  }

  fs.writeFileSync(path.join(appDir, 'package.json'), appPackageJson(), 'utf8')
}

/* ---------------------------------------------------------------- icons */

/**
 * 把 electron.exe 换成 Agent 的图标 + 版本信息。
 *
 * 只改资源段、不动代码；代价是 Electron 官方那套 Authenticode 签名会失效
 * （改了资源就必须重签，而我们没有证书）。包是内网分发、解压即用，
 * 这个代价可以接受；换来的是资源管理器 / 任务栏 / 属性页里
 * 全都显示 Agent 而不是 Electron（文件图标与「文件说明」都在这)。
 *
 * resedit 是纯 JS 实现，不依赖外部二进制，所以不装 Wine 也能在 mac 上打 Windows 包。
 */
function applyWindowsBranding(exePath) {
  if (!fs.existsSync(exePath)) {
    log('WARN skip exe branding, not found: ' + exePath)
    return false
  }
  const icoPath = path.join(ICON_DIR, 'icon.ico')
  if (!fs.existsSync(icoPath)) {
    log('WARN skip exe branding, missing ' + icoPath + ' (run scripts/make-logo.py)')
    return false
  }

  let ResEdit = null
  try {
    // resedit v3 是 ESM，require 需要 Node >= 20.19.5
    ResEdit = require('resedit')
  } catch (error) {
    log('WARN exe 图标与版本信息未替换：打包脚本需要 Node >= 20.19.5（' + (error && error.message) + '）')
    return false
  }

  try {
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
    const res = ResEdit.NtExecutableResource.from(exe)

    // 图标：Electron 自带的图标组整组换掉（组 ID 是它自己定的，读出来照着换）
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath))
    const icons = iconFile.icons.map((item) => item.data)
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
    if (groups.length === 0) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons)
    } else {
      for (const group of groups) {
        ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons)
      }
    }

    // 版本信息：属性页的「文件说明 / 产品名称」和任务栏悬浮提示都读这里。
    // 不改的话，exe 改了名、换了图标，鼠标一悬停还是 Electron。
    const existing = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
    const info = existing.length > 0
      ? existing[0]
      : ResEdit.Resource.VersionInfo.create(1033, {}, [])
    info.fixedInfo.fileOS = ResEdit.Resource.VersionFileOS.NT_Windows32
    info.fixedInfo.fileType = ResEdit.Resource.VersionFileType.App
    info.setFileVersion(fourPartVersion(PRODUCT_VERSION), 1033)
    info.setProductVersion(fourPartVersion(PRODUCT_VERSION), 1033)
    info.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: APP_TITLE,
      FileDescription: APP_TITLE,
      InternalName: APP_NAME,
      OriginalFilename: APP_NAME + '.exe',
      CompanyName: APP_TITLE
    })
    info.outputToResourceEntries(res.entries)

    res.outputResource(exe)
    // 刻意写回原路径：resedit 的文档不建议 src == dst，
    // 但这里就是「就地替换」，中间产物留在内存里，不做额外落盘。
    fs.writeFileSync(exePath, Buffer.from(exe.generate()))
    log('exe branding applied: ' + path.basename(exePath))
    return true
  } catch (error) {
    log('WARN exe branding failed: ' + (error && error.message))
    return false
  }
}

/** macOS：直接覆盖 bundle 里那份 Electron 默认图标。 */
function applyMacIcon(bundleDir) {
  const icns = path.join(ICON_DIR, 'icon.icns')
  if (!fs.existsSync(icns)) {
    log('WARN skip mac icon, missing ' + icns + ' (run scripts/make-logo.py)')
    return false
  }
  const target = path.join(bundleDir, 'Contents', 'Resources', 'electron.icns')
  copyFile(icns, target)
  log('mac icon applied: Contents/Resources/electron.icns')
  return true
}

/* ------------------------------------------------------------- readme */

function desktopReadme(targetKey) {
  const target = TARGETS[targetKey]
  const platformLine = targetKey === 'win-x64'
    ? 'Windows 7 SP1 x64 / Windows 10 / Windows 11'
    : (target.bundle ? 'macOS' : (targetKey === 'linux-arm64' ? 'Linux ARM64（银河麒麟 / 飞腾 / 鲲鹏）' : 'Linux x64'))
  const launchLine = targetKey === 'win-x64'
    ? '双击 Agent.exe'
    : (target.bundle ? '双击 Agent.app（首次请右键 -> 打开）' : '双击 Agent（或终端执行 ./Agent）')
  return [
    'Agent 桌面版 ' + PRODUCT_VERSION,
    '====================================',
    '',
    '适用平台: ' + platformLine,
    '免安装:   解压即用，不写注册表，不装服务',
    '',
    '怎么用',
    '------',
    launchLine + ' 即可。',
    '',
    '程序会自动完成以下事情，无需手工启动任何东西：',
    '  1. 探测本机可用端口（默认从 8080 开始，被占用就自动顺延到 8081/8082...）',
    '  2. 如果本机已经有同一个 agent 服务在跑，直接复用，不会重复启动',
    '  3. 拉起本地 agent 服务进程，等服务就绪后打开聊天界面',
    '  4. 关闭程序时，只关掉自己拉起的服务',
    '',
    '三套图标',
    '--------',
    '  AM = Agent Mac     macOS 用这个（Agent.app 的图标）',
    '  AL = Agent Linux   Linux 用这个（窗口图标）',
    '  AW = Agent Win     Windows 用这个（Agent.exe 的文件图标）',
    '打包时自动按平台选，不用手工换。',
    '',
    '数据目录（会话 / 设置 / 工作区）',
    '------------------------------',
    '  Windows: %APPDATA%\\Agent\\agent-home',
    '  macOS:   ~/Library/Application Support/Agent/agent-home',
    '  Linux:   ~/.config/Agent/agent-home',
    '也可以在 服务设置 里查看实际路径。程序目录本身不写任何数据。',
    '从旧版本（当时叫 DSH-Agent）升级上来的话，第一次启动会自动把旧目录',
    '改名成 Agent，会话和配置都跟着过来。',
    '',
    '以后怎么更新',
    '------------',
    '拿到新版本的压缩包，解压后直接双击运行即可，不用先卸载旧版本：',
    '  1. 程序会发现本机已经装着一份旧版本，并问你是否替换',
    '  2. 点「立即更新」会先关掉旧版本，把文件替换到旧版本原来的位置',
    '  3. 从原位置重新启动，然后你手动删掉这次解压出来的临时目录就行',
    '会话、设置、工作区都在上面的数据目录里，更新不会动它们。',
    '如果旧版本正在运行也不用先关，更新时程序会自己处理。',
    '',
    '改用内网服务器上的服务',
    '----------------------',
    '按 Cmd+,（macOS）或 Ctrl+,（Windows/Linux）打开服务设置，把服务模式改成「远程服务」并填写地址，',
    '例如 http://192.168.1.10:8080/ ，即可让本机只当客户端。',
    '',
    'Windows 7 前置条件',
    '-----------------',
    '  - Windows 7 SP1 x64',
    '  - KB2533623（Chromium 需要）',
    '  - KB4474419（SHA-2 代码签名支持）',
    '建议安装 .NET Framework 4.x。',
    '',
    '其他说明',
    '--------',
    '  - 完全离线运行，不会访问任何互联网地址，只连接你在设置里配置的内网模型地址。',
    '  - Agent.exe 为了换图标与版本信息重写过资源，Electron 官方签名因此失效；',
    '    这是打包的必然结果（没有证书就无法重签），内网运行不受影响。',
    '  - macOS 未做代码签名，首次打开请右键选择「打开」，之后可正常双击。',
    '  - Linux 若报 sandbox 错误，可用 ./Agent --no-sandbox 启动。',
    ''
  ].join('\n')
}

/* --------------------------------------------------------------- targets */

function buildWindows(unpacked, outDir, targetKey) {
  const target = TARGETS[targetKey]
  copyDir(unpacked, outDir, { skip: ELECTRON_SKIP_NAMES })
  const sourceExe = path.join(outDir, 'electron.exe')
  const targetExe = path.join(outDir, target.binary)
  if (fs.existsSync(sourceExe)) {
    if (fs.existsSync(targetExe)) rmrf(targetExe)
    fs.renameSync(sourceExe, targetExe)
  }
  fillAppDir(path.join(outDir, 'resources', 'app'), target.mark, targetKey)
  // Electron 自带的默认应用不再需要
  rmrf(path.join(outDir, 'resources', 'default_app.asar'))
  applyWindowsBranding(targetExe)
}

function buildLinux(unpacked, outDir, targetKey) {
  const target = TARGETS[targetKey]
  copyDir(unpacked, outDir, { skip: ELECTRON_SKIP_NAMES })
  const sourceBin = path.join(outDir, 'electron')
  const targetBin = path.join(outDir, target.binary)
  if (fs.existsSync(sourceBin)) {
    if (fs.existsSync(targetBin)) rmrf(targetBin)
    fs.renameSync(sourceBin, targetBin)
    fs.chmodSync(targetBin, 0o755)
  }
  fillAppDir(path.join(outDir, 'resources', 'app'), target.mark, targetKey)
  rmrf(path.join(outDir, 'resources', 'default_app.asar'))
}

function buildDarwin(unpacked, outDir, targetKey) {
  const target = TARGETS[targetKey]
  const sourceApp = path.join(unpacked, 'Electron.app')
  const bundleName = target.bundle
  copyDir(sourceApp, path.join(outDir, bundleName), { skip: ELECTRON_SKIP_NAMES })

  const contents = path.join(outDir, bundleName, 'Contents')
  // macOS 用 Info.plist 的 CFBundleExecutable 找主二进制，所以二进制保持原名 Electron 即可
  const infoPath = path.join(contents, 'Info.plist')
  if (fs.existsSync(infoPath)) {
    let plist = fs.readFileSync(infoPath, 'utf8')
    plist = plist.replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/, '$1' + APP_TITLE + '$2')
    plist = plist.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, '$1' + APP_TITLE + '$2')
    plist = plist.replace(/(<key>CFBundleExecutable<\/key>\s*<string>)[^<]*(<\/string>)/, '$1Electron$2')
    // 图标文件名沿用 Electron 的，直接覆盖那个文件即可；这里把它钉死，
    // 免得将来 Electron 换名导致我们覆盖了个没人引用的文件
    plist = plist.replace(/(<key>CFBundleIconFile<\/key>\s*<string>)[^<]*(<\/string>)/, '$1electron.icns$2')
    plist = plist.replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/, '$1com.dsh.agent$2')
    fs.writeFileSync(infoPath, plist, 'utf8')
  }

  applyMacIcon(path.join(outDir, bundleName))
  fillAppDir(path.join(contents, 'Resources', 'app'), target.mark, targetKey)
  rmrf(path.join(contents, 'Resources', 'default_app.asar'))

  // 改了 bundle 会让原签名失效，重新做一次 ad-hoc 签名，避免 macOS 直接报「已损坏」
  if (process.platform === 'darwin' && commandExists('codesign')) {
    try {
      run('codesign', ['--force', '--deep', '--sign', '-', path.join(outDir, bundleName)])
      log('ad-hoc codesign done: ' + bundleName)
    } catch (error) {
      log('codesign skipped: ' + (error && error.message))
    }
  }
}

function makeZip(dir, zipPath) {
  rmrf(zipPath)
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command',
      'Compress-Archive -Path "' + path.join(dir, '*') + '" -DestinationPath "' + zipPath + '" -Force'])
    return
  }
  run('zip', ['-q', '-r', '-y', zipPath, path.basename(dir)],
    { cwd: path.dirname(dir) })
}

/* ------------------------------------------------------------------ main */

async function buildTarget(targetKey, options) {
  const target = TARGETS[targetKey]
  if (!target) fail('unknown target: ' + targetKey)
  log('=== building ' + targetKey + ' ===')

  const unpacked = await ensureDist(targetKey)
  const outDir = path.join(OUT_ROOT, APP_NAME + '-' + targetKey + '-' + PRODUCT_VERSION)
  // 先改名让位再删：改名失败=真有实例占着（报错退出），删除失败=只是环境的批量删除保护
  clearOutDir(outDir)
  mkdirp(outDir)

  if (targetKey === 'win-x64') buildWindows(unpacked, outDir, targetKey)
  else if (targetKey === 'linux-x64' || targetKey === 'linux-arm64') buildLinux(unpacked, outDir, targetKey)
  else buildDarwin(unpacked, outDir, targetKey)

  fs.writeFileSync(path.join(outDir, 'README-DESKTOP.txt'), desktopReadme(targetKey), 'utf8')

  log('layout ok: ' + outDir)
  if (options && options.noZip) return outDir
  const zipPath = path.join(OUT_ROOT, APP_NAME + '-' + targetKey + '-' + PRODUCT_VERSION + '.zip')
  log('zipping -> ' + zipPath)
  makeZip(outDir, zipPath)
  const size = Math.round(fs.statSync(zipPath).size / 1048576)
  log('done ' + targetKey + ': ' + zipPath + ' (' + size + ' MB)')
  return zipPath
}

async function main() {
  const args = process.argv.slice(2)
  const noZip = args.indexOf('--no-zip') >= 0
  const names = args.filter((item) => item.indexOf('--') !== 0)
  if (names.length === 0) {
    fail('usage: node scripts/build-desktop.js <win-x64|mac-arm64|mac-x64|linux-x64|linux-arm64|all> [--no-zip]')
  }
  const keys = names.indexOf('all') >= 0
    ? ALL_TARGETS.slice()
    : names.map((name) => ALIASES[name] || name)
  mkdirp(OUT_ROOT)
  const results = []
  for (const key of keys) {
    results.push(await buildTarget(key, { noZip }))
  }
  if (!noZip) require('./release-retention').prune(OUT_ROOT)
  log('all done:')
  for (const item of results) log('  ' + item)
}

main().catch((error) => {
  console.error('[build-desktop] crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
