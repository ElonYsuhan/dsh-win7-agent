'use strict'

/* 平台分支用隔离 VM 和子进程替身运行，不打开系统对话框、不杀真实进程、不读取用户设置。
 * 真机行为仍需在 Windows / Linux 上验证；这里检查它们收到的路径、参数和协议。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')

const ROOT = path.resolve(__dirname, '..')
let passed = 0

function check(name, action) {
  action()
  passed += 1
  console.log('PASS  ' + name)
}

function load(file, platform, overrides) {
  const context = {
    module: { exports: {} },
    exports: {},
    Buffer,
    console,
    Date: Object.assign(function () { return new Date() }, { now: () => 1700000000000 }),
    process: {
      platform,
      env: platform === 'win32' ? { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\Tools' } : { SHELL: '/bin/bash', PATH: '/usr/bin' },
      kill: () => {}
    },
    setTimeout: () => ({ unref: () => {} }),
    clearTimeout: () => {},
    require: (name) => {
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name]
      return require(name)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file })
  return context.module.exports
}

async function nativeFolders() {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const calls = []
    const selected = platform === 'win32' ? 'C:\\项目\\示例' : '/home/用户/项目'
    const picker = load('server/native-folder.js', platform, {
      child_process: { execFile: (command, args, options, done) => {
        calls.push({ command, args, options })
        done(null, selected + '\n')
      } }
    })
    const result = await picker.pickNativeFolder()
    check(platform + ' 原生选目录保留中文路径', () => {
      assert.strictEqual(result.path, selected)
      assert.strictEqual(result.canceled, false)
    })
    check(platform + ' 原生选目录使用 UTF-8 和超时', () => {
      assert.strictEqual(calls[0].options.encoding, 'utf8')
      assert.strictEqual(calls[0].options.timeout, 120000)
    })
    check(platform + ' 原生选目录使用系统工具', () => {
      assert.strictEqual(calls[0].command, platform === 'win32' ? 'powershell.exe' : (platform === 'darwin' ? 'osascript' : 'zenity'))
      if (platform === 'win32') {
        assert(calls[0].args.includes('-STA'))
        assert(calls[0].args[3].includes('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding'))
        assert.strictEqual(calls[0].options.windowsHide, true)
      }
    })
  }
  const missing = Object.assign(new Error('not found'), { code: 'ENOENT' })
  const calls = []
  const kde = load('server/native-folder.js', 'linux', {
    child_process: { execFile: (command, args, options, done) => {
      calls.push(command)
      if (command === 'zenity') done(missing, '')
      else done(null, '/home/user/KDE project\n')
    } }
  })
  const kdePath = await kde.pickNativeFolder()
  check('Linux 缺少 zenity 时使用 kdialog', () => {
    assert.deepStrictEqual(calls, ['zenity', 'kdialog'])
    assert.strictEqual(kdePath.path, '/home/user/KDE project')
    assert.strictEqual(kdePath.canceled, false)
  })
  const cancelCalls = []
  const canceled = load('server/native-folder.js', 'linux', {
    child_process: { execFile: (command, args, options, done) => {
      cancelCalls.push(command)
      done(Object.assign(new Error('canceled'), { code: 1 }), '')
    } }
  })
  const canceledPath = await canceled.pickNativeFolder()
  check('Linux 用户取消后结束选择', () => {
    assert.strictEqual(canceledPath.path, '')
    assert.strictEqual(canceledPath.canceled, true)
    assert.deepStrictEqual(cancelCalls, ['zenity'])
  })
  const warningCalls = []
  const warningCancel = load('server/native-folder.js', 'linux', {
    child_process: { execFile: (command, args, options, done) => {
      warningCalls.push(command)
      done(Object.assign(new Error('canceled'), { code: 1 }), '', 'Gtk-WARNING: theme not found')
    } }
  })
  const warningCancelResult = await warningCancel.pickNativeFolder()
  check('Linux 真取消同时带普通 GTK 警告仍结束选择', () => {
    assert.strictEqual(warningCancelResult.canceled, true)
    assert.deepStrictEqual(warningCalls, ['zenity'])
  })
  const unavailable = load('server/native-folder.js', 'linux', {
    child_process: { execFile: (command, args, options, done) => done(missing, '') }
  })
  const unavailablePath = await unavailable.pickNativeFolder()
  check('Linux 两个选目录工具均缺失时允许服务器目录浏览器回退', () => {
    assert.strictEqual(unavailablePath.path, '')
    assert.strictEqual(unavailablePath.canceled, false)
  })
  const noDisplay = load('server/native-folder.js', 'linux', {
    child_process: { execFile: (command, args, options, done) => {
      done(Object.assign(new Error('display unavailable'), { code: 1 }), '', 'cannot open display')
    } }
  })
  const displayResult = await noDisplay.pickNativeFolder()
  check('Linux 原生工具无法连接桌面时允许目录浏览器回退', () => {
    assert.strictEqual(displayResult.path, '')
    assert.strictEqual(displayResult.canceled, false)
  })
  for (const [platform, error, stderr] of [
    ['win32', Object.assign(new Error('canceled'), { code: 2 }), ''],
    ['darwin', Object.assign(new Error('User canceled. (-128)'), { code: 1 }), 'User canceled. (-128)']
  ]) {
    const canceledPicker = load('server/native-folder.js', platform, {
      child_process: { execFile: (command, args, options, done) => done(error, '', stderr) }
    })
    const canceledResult = await canceledPicker.pickNativeFolder()
    check(platform + ' 用户取消原生选择器后不打开回退浏览器', () => {
      assert.strictEqual(canceledResult.path, '')
      assert.strictEqual(canceledResult.canceled, true)
    })
    const missingPicker = load('server/native-folder.js', platform, {
      child_process: { execFile: (command, args, options, done) => done(missing, '', '') }
    })
    const missingResult = await missingPicker.pickNativeFolder()
    check(platform + ' 原生选择器启动失败允许目录浏览器回退', () => {
      assert.strictEqual(missingResult.path, '')
      assert.strictEqual(missingResult.canceled, false)
    })
  }
}

function terminals() {
  for (const platform of ['win32', 'linux']) {
    const calls = []
    const killed = []
    const writes = []
    const filesystem = Object.assign({}, fs, {
      statSync: () => ({ isDirectory: () => true }),
      readdirSync: () => [],
      readlinkSync: () => '/home/user/changed'
    })
    const terminal = load('server/terminal-api.js', platform, {
      path: platform === 'win32' ? path.win32 : path.posix,
      fs: filesystem,
      os: { homedir: () => platform === 'win32' ? 'C:\\Users\\User' : '/home/user' },
      child_process: {
        spawn: (command, args, options) => {
          const proc = new EventEmitter()
          proc.pid = 1000 + calls.length
          proc.stdout = new EventEmitter()
          proc.stderr = new EventEmitter()
          proc.stdin = { write: (value) => writes.push(value) }
          proc.kill = (signal) => killed.push({ pid: proc.pid, signal })
          calls.push({ command, args, options, proc })
          return proc
        },
        spawnSync: (command, args, options) => {
          killed.push({ command, args, options })
          return { status: 0 }
        }
      }
    })
    const first = terminal.start(platform === 'win32' ? 'C:\\Projects\\Demo' : '/home/user/project')
    const second = terminal.start(platform === 'win32' ? 'C:\\Projects\\Other' : '/home/user/other')
    check(platform + ' 同毫秒创建的两个终端可独立访问', () => {
      assert.notStrictEqual(first.sid, second.sid)
      assert.strictEqual(terminal.state().sessions.length, 2)
      assert.strictEqual(terminal.state(first.sid).sid, first.sid)
    })
    check(platform + ' 使用系统 shell 和正确的进程选项', () => {
      assert.strictEqual(calls[0].command, platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/bash')
      assert.strictEqual(calls[0].options.windowsHide, true)
      assert.strictEqual(calls[0].options.detached, platform !== 'win32')
      assert.strictEqual(first.shell, platform === 'win32' ? 'cmd.exe' : 'bash')
      if (platform === 'win32') assert.deepStrictEqual(Array.from(calls[0].args), ['/Q'])
      else assert(calls[0].options.env.PATH.includes('/home/user/.local/bin'))
    })
    terminal.write(first.sid, 'echo hello')
    check(platform + ' 命令输入使用系统换行并包含就绪标记', () => {
      assert(writes[0].startsWith('echo hello' + (platform === 'win32' ? '\r\n' : '\n')))
      assert(writes[0].includes('__DSH_CMD_READY__'))
    })
    const payloads = []
    terminal.subscribe(first.sid, (value) => payloads.push(value))
    const raw = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    calls[0].proc.stdout.emit('data', raw)
    check(platform + ' 终端输出保留原始字节和回放', () => {
      assert(payloads[0].replay)
      assert.strictEqual(payloads[1].data, raw.toString('base64'))
    })
    check(platform + ' 终端工作目录查询按系统处理', () => {
      assert.strictEqual(terminal.state(first.sid).cwd, platform === 'win32' ? 'C:\\Projects\\Demo' : '/home/user/changed')
    })
    terminal.kill(first.sid)
    check(platform + ' 关闭一个终端保留另一个', () => {
      assert.strictEqual(terminal.state().sessions.length, 1)
      assert.strictEqual(terminal.state(second.sid).alive, true)
      if (platform === 'win32') {
        assert.strictEqual(killed[0].command, 'taskkill')
        assert.deepStrictEqual(Array.from(killed[0].args), ['/pid', '1000', '/T', '/F'])
        assert.strictEqual(killed[0].options.windowsHide, true)
      }
    })
    terminal.teardownAll()
    check(platform + ' 服务退出清理全部终端', () => assert.strictEqual(terminal.state().sessions.length, 0))
  }
}

function installationPaths() {
  const installer = load('shell/installer.js', 'win32', { path: path.win32 })
  check('Windows 安装路径使用盘符和反斜杠', () => {
    assert.strictEqual(installer.packageDirOf('C:\\Tools\\Agent\\Agent.exe'), 'C:\\Tools\\Agent')
    assert.strictEqual(installer.mainBinaryOf('C:\\Tools\\Agent'), 'C:\\Tools\\Agent\\Agent.exe')
    assert.strictEqual(installer.samePath('C:\\Tools\\Agent\\', 'c:/TOOLS/Agent'), true)
  })
  const linux = load('shell/installer.js', 'linux', { path: path.posix })
  check('Linux 安装路径和可执行文件使用 POSIX 语义', () => {
    assert.strictEqual(linux.packageDirOf('/opt/Agent/Agent'), '/opt/Agent')
    assert.strictEqual(linux.mainBinaryOf('/opt/Agent'), '/opt/Agent/Agent')
    assert.strictEqual(linux.samePath('/opt/Agent', '/opt/agent'), false)
  })
}

function packaging() {
  const files = require('../package.json').build.files
  check('Windows NSIS / portable 包含主进程依赖的服务模块和共享菜单', () => {
    assert(files.includes('src/**/*'))
    assert(files.includes('server/**/*'))
    assert(files.includes('shell/menu.js'))
  })
  const buildSource = fs.readFileSync(path.join(ROOT, 'scripts/build-desktop.js'), 'utf8')
  const serviceFiles = /const SERVICE_FILES = (\[[^\n]+\])/.exec(buildSource)
  assert(serviceFiles)
  const included = vm.runInNewContext(serviceFiles[1])
  check('跨平台便携包包含全部服务端模块', () => {
    for (const file of fs.readdirSync(path.join(ROOT, 'server'))) {
      if (file.endsWith('.js')) assert(included.includes(file), file + ' 未包含在便携包')
    }
  })
}

async function main() {
  await nativeFolders()
  terminals()
  installationPaths()
  packaging()
  console.log('\nplatform smoke: ' + passed + '/' + passed + ' checks passed, node ' + process.version)
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
