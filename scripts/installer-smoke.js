#!/usr/bin/env node
'use strict'

/**
 * shell/installer.js 的单元冒烟：manifest、路径判定、版本比较、复制、替换、残留清理。
 * 只用临时目录，不碰真实 userData。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const installer = require(path.join(__dirname, '..', 'shell', 'installer.js'))

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log('PASS  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
    return true
  }
  failed++
  console.log('FAIL  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
  return false
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

/* ------------------------------------------------------------------ setup */

const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installer-'))
const USER_DATA = path.join(ROOT_TMP, 'userData')
const OLD_PKG = path.join(ROOT_TMP, 'Agent')
const NEW_PKG = path.join(ROOT_TMP, 'Downloads', 'Agent-win-x64')

function fakePackage(dir, version) {
  write(path.join(dir, 'Agent.exe'), 'binary-' + version)
  write(path.join(dir, 'resources', 'app', 'package.json'), JSON.stringify({ version }))
  write(path.join(dir, 'resources', 'app', 'service', 'index.js'), '// service ' + version)
  write(path.join(dir, 'locales', 'zh-CN.pak'), 'pak-' + version)
}

async function main() {
  /* ---- 路径推导 ---- */
  check(
    'packageDirOf: macOS 上溯到 .app',
    installer.packageDirOf('/opt/Agent.app/Contents/MacOS/Agent', 'darwin') === '/opt/Agent.app',
    installer.packageDirOf('/opt/Agent.app/Contents/MacOS/Agent', 'darwin')
  )
  check(
    'packageDirOf: linux 取可执行文件所在目录',
    installer.packageDirOf('/opt/dsh/Agent', 'linux') === '/opt/dsh',
    installer.packageDirOf('/opt/dsh/Agent', 'linux')
  )
  // macOS 包内的主二进制名由 Info.plist 决定。打包脚本刻意让它保持 Electron 原名
  //（只改 .app 目录名），所以这里必须真的读 plist，不能拿产品名硬拼。
  const fakeApp = path.join(ROOT_TMP, 'Fake.app')
  write(
    path.join(fakeApp, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist><dict>\n<key>CFBundleExecutable</key>\n<string>Electron</string>\n</dict></plist>\n'
  )
  write(path.join(fakeApp, 'Contents', 'MacOS', 'Electron'), 'binary')
  fs.chmodSync(path.join(fakeApp, 'Contents', 'MacOS', 'Electron'), 0o755)
  check('plistExecutableName: 解析出 CFBundleExecutable', installer.plistExecutableName(fakeApp) === 'Electron')
  check(
    'mainBinaryOf: macOS 按 Info.plist 找到 Electron',
    installer.mainBinaryOf(fakeApp, 'darwin') === path.join(fakeApp, 'Contents', 'MacOS', 'Electron'),
    installer.mainBinaryOf(fakeApp, 'darwin')
  )
  const plistlessApp = path.join(ROOT_TMP, 'NoPlist.app')
  write(path.join(plistlessApp, 'Contents', 'MacOS', 'Agent'), 'binary')
  fs.chmodSync(path.join(plistlessApp, 'Contents', 'MacOS', 'Agent'), 0o755)
  check('plistExecutableName: 没有 plist 时返回空串', installer.plistExecutableName(plistlessApp) === '')
  check(
    'mainBinaryOf: 没有 plist 时退回产品名',
    installer.mainBinaryOf(plistlessApp, 'darwin') === path.join(plistlessApp, 'Contents', 'MacOS', 'Agent')
  )
  // 用 path.join 断言会变成复述实现；这里只断言语义：同目录 + 带 .exe 后缀。
  // （函数用宿主 path 模块拼路径，在 macOS 上跑无法复现 Windows 的分隔符）
  const winBinary = installer.mainBinaryOf('C:\\Tools\\Agent', 'win32')
  check(
    'mainBinaryOf: windows 带 .exe 且同目录',
    winBinary.endsWith('Agent.exe') && path.dirname(winBinary) === 'C:\\Tools\\Agent',
    winBinary
  )
  check(
    'mainBinaryOf: linux 不带后缀',
    installer.mainBinaryOf('/opt/dsh', 'linux') === '/opt/dsh/Agent'
  )

  /* ---- 同一目录判定 ---- */
  check('AppTranslocation 不是可替换安装目录', installer.isTransientPackage('/private/var/folders/x/AppTranslocation/uuid/d/Agent.app', 'darwin'))
  check('普通应用目录不被误判临时挂载', !installer.isTransientPackage('/Applications/Agent.app', 'darwin'))
  check('其他平台不应用 macOS 临时挂载规则', !installer.isTransientPackage('/AppTranslocation/x', 'linux'))
  check('默认后台更新无需页面或命令行标记', fs.readFileSync(path.join(__dirname, '..', 'shell/main.js'), 'utf8').includes('const result = await runUpdate()') && !fs.readFileSync(path.join(__dirname, '..', 'shell/main.js'), 'utf8').includes("loadLocal(mainWindow, 'update.html')"))
  check('samePath: 尾斜杠等价', installer.samePath('/a/b/', '/a/b', 'linux'))
  check('samePath: macOS 大小写不敏感', installer.samePath('/a/B', '/a/b', 'darwin'))
  check('samePath: linux 大小写敏感', installer.samePath('/a/B', '/a/b', 'linux') === false)
  check('samePath: 不同目录为假', installer.samePath('/a/b', '/a/c', 'linux') === false)

  /* ---- 版本比较 ---- */
  check('compareVersion: 0.2.0 > 0.1.0', installer.compareVersion('0.2.0', '0.1.0') === 1)
  check('compareVersion: 0.1.10 > 0.1.9', installer.compareVersion('0.1.10', '0.1.9') === 1)
  check('compareVersion: 相等', installer.compareVersion('1.0.0', '1.0.0') === 0)
  check('compareVersion: 0.1.0 < 0.2.0', installer.compareVersion('0.1.0', '0.2.0') === -1)
  check('compareVersion: 非法输入当 0 处理', installer.compareVersion('', '0.0.0') === 0)

  /* ---- 进程存活 ---- */
  check('isAlive: 当前进程', installer.isAlive(process.pid) === true)
  check('isAlive: 不存在的 pid', installer.isAlive(999999) === false)
  check('isAlive: pid 为 0', installer.isAlive(0) === false)

  /* ---- manifest ---- */
  check('readManifest: 文件不存在返回 null', installer.readManifest(USER_DATA) === null)
  const first = installer.writeManifest(USER_DATA, { path: OLD_PKG, version: '0.1.0', pid: 1234 })
  check('writeManifest: 落盘', fs.existsSync(installer.manifestPath(USER_DATA)))
  check('writeManifest: 返回合并结果', first.path === OLD_PKG && first.version === '0.1.0')
  check('writeManifest: 带 updatedAt', typeof first.updatedAt === 'string' && first.updatedAt.length > 0)
  const second = installer.writeManifest(USER_DATA, { version: '0.2.0' })
  check('writeManifest: 合并而不覆盖 path', second.path === OLD_PKG && second.version === '0.2.0')
  const reread = installer.readManifest(USER_DATA)
  check('readManifest: 回读一致', reread.path === OLD_PKG && reread.version === '0.2.0' && reread.pid === 1234)
  fs.writeFileSync(installer.manifestPath(USER_DATA), '{ not json')
  check('readManifest: 损坏文件返回 null', installer.readManifest(USER_DATA) === null)
  installer.writeManifest(USER_DATA, { path: OLD_PKG, version: '0.1.0', pid: 1234 })

  /* ---- copyTree ---- */
  const srcTree = path.join(ROOT_TMP, 'tree-src')
  write(path.join(srcTree, 'a.txt'), 'AAA')
  write(path.join(srcTree, 'nested', 'deep', 'b.txt'), 'BBB')
  fs.chmodSync(path.join(srcTree, 'a.txt'), 0o755)
  fs.symlinkSync('a.txt', path.join(srcTree, 'link-to-a'))
  const dstTree = path.join(ROOT_TMP, 'tree-dst')
  const stats = installer.copyTree(srcTree, dstTree, { files: 0, bytes: 0, dirs: 0, links: 0 })
  check('copyTree: 普通文件', read(path.join(dstTree, 'a.txt')) === 'AAA')
  check('copyTree: 嵌套目录', read(path.join(dstTree, 'nested', 'deep', 'b.txt')) === 'BBB')
  check('copyTree: 统计文件数', stats.files === 2, stats.files)
  check('copyTree: 统计字节数', stats.bytes === 6, stats.bytes)
  check('copyTree: 统计目录数', stats.dirs === 2, stats.dirs)
  const linkStat = fs.lstatSync(path.join(dstTree, 'link-to-a'))
  check('copyTree: 符号链接仍是链接', linkStat.isSymbolicLink() === true)
  check('copyTree: 符号链接目标保持相对', fs.readlinkSync(path.join(dstTree, 'link-to-a')) === 'a.txt')
  if (process.platform !== 'win32') {
    check(
      'copyTree: 可执行权限保留',
      (fs.statSync(path.join(dstTree, 'a.txt')).mode & 0o777) === 0o755,
      (fs.statSync(path.join(dstTree, 'a.txt')).mode & 0o777).toString(8)
    )
  }

  /* ---- replacePackage: 错误分支 ---- */
  const sameResult = await installer.replacePackage({ srcDir: OLD_PKG, dstDir: OLD_PKG, platform: 'linux' })
  check('replacePackage: 源与目标同路径被拒', sameResult.ok === false && sameResult.error === 'SAME_PATH')
  const missingResult = await installer.replacePackage({
    srcDir: path.join(ROOT_TMP, 'nope'),
    dstDir: OLD_PKG,
    platform: 'linux'
  })
  check('replacePackage: 源不存在被拒', missingResult.ok === false && missingResult.error === 'SOURCE_MISSING')

  /* ---- replacePackage: 正常替换 ---- */
  fakePackage(OLD_PKG, '0.1.0')
  fakePackage(NEW_PKG, '0.2.0')
  write(path.join(OLD_PKG, 'leftover-from-old.txt'), 'should be gone')
  const replaced = await installer.replacePackage({ srcDir: NEW_PKG, dstDir: OLD_PKG, platform: process.platform })
  check('replacePackage: 成功', replaced.ok === true, replaced.error || 'ok')
  check('replacePackage: 新文件就位', read(path.join(OLD_PKG, 'Agent.exe')) === 'binary-0.2.0')
  check(
    'replacePackage: 新包深层文件就位',
    read(path.join(OLD_PKG, 'resources', 'app', 'package.json')) === '{"version":"0.2.0"}'
  )
  check('replacePackage: 旧文件已被清掉', fs.existsSync(path.join(OLD_PKG, 'leftover-from-old.txt')) === false)
  check('replacePackage: 没有残留 .old- 目录', replaced.leftover === '', replaced.leftover)
  check('replacePackage: 源目录仍在（没被搬走）', fs.existsSync(path.join(NEW_PKG, 'Agent.exe')))
  check('replacePackage: 统计了复制的文件', replaced.stats.files === 4, replaced.stats.files)

  /* ---- cleanupTrash ---- */
  const trashDir = OLD_PKG + installer.TRASH_PREFIX + '1700000000000'
  write(path.join(trashDir, 'stale.txt'), 'stale')
  const removed = installer.cleanupTrash(OLD_PKG)
  check('cleanupTrash: 删掉残留目录', removed.length === 1, removed.length)
  check('cleanupTrash: 残留目录真的没了', fs.existsSync(trashDir) === false)
  const removedAgain = installer.cleanupTrash(OLD_PKG)
  check('cleanupTrash: 无残留时返回空', removedAgain.length === 0)

  /* ---- replacePackage: 目标被占用（用只读父目录模拟改名失败） ---- */
  const lockedParent = path.join(ROOT_TMP, 'locked')
  const lockedDst = path.join(lockedParent, 'Agent')
  fakePackage(lockedDst, '0.1.0')
  let attempts = 0
  fs.chmodSync(lockedParent, 0o555)
  let lockedResult
  try {
    lockedResult = await installer.replacePackage({
      srcDir: NEW_PKG,
      dstDir: lockedDst,
      platform: process.platform,
      retries: 2,
      retryDelay: 10,
      onLockedAttempt: () => { attempts++ }
    })
  } finally {
    fs.chmodSync(lockedParent, 0o755)
  }
  check('replacePackage: 改名失败时报 DIR_LOCKED', lockedResult.ok === false && lockedResult.error === 'DIR_LOCKED', lockedResult.error)
  check('replacePackage: 重试回调被触发', attempts >= 2, attempts)
  check('replacePackage: 失败后旧目录原样还在', read(path.join(lockedDst, 'Agent.exe')) === 'binary-0.1.0')

  /* ---- relaunch ---- */
  const noBinary = installer.relaunch(path.join(ROOT_TMP, 'empty-package'), { platform: 'linux' })
  check('relaunch: 找不到可执行文件时报错', noBinary.ok === false && noBinary.error === 'BINARY_MISSING')

  if (process.platform !== 'win32') {
    // 真起一个替身脚本，验证 relaunch 的两件事：
    //  1. 清掉残留的 ELECTRON_RUN_AS_NODE（不清理新进程会被当成 Node 解释器）
    //  2. 把启动参数带过去（丢了参数新进程会换数据目录，看起来像会话丢了）
    const envProbe = path.join(ROOT_TMP, 'env-probe.txt')
    const argsProbe = path.join(ROOT_TMP, 'args-probe.txt')
    const probeApp = path.join(ROOT_TMP, 'Probe.app')
    const probeScript = '#!/bin/sh\n' +
      'echo "${ELECTRON_RUN_AS_NODE:-absent}" > "' + envProbe + '"\n' +
      'echo "$@" > "' + argsProbe + '"\n'
    write(path.join(probeApp, 'Contents', 'MacOS', 'Electron'), probeScript)
    fs.chmodSync(path.join(probeApp, 'Contents', 'MacOS', 'Electron'), 0o755)
    process.env.ELECTRON_RUN_AS_NODE = '1'
    const probeArgs = ['--user-data-dir=/tmp/dsh-probe', '--dsh-takeover-test']
    const spawned = installer.relaunch(probeApp, { platform: 'darwin', args: probeArgs })
    delete process.env.ELECTRON_RUN_AS_NODE
    check('relaunch: 能拉起目标可执行文件', spawned.ok === true, spawned.error || ('pid ' + spawned.pid))

    async function waitFor(target) {
      for (let round = 0; round < 60; round += 1) {
        if (fs.existsSync(target)) return read(target).trim()
        await installer.sleep(50)
      }
      return ''
    }

    const probeValue = await waitFor(envProbe)
    check('relaunch: 清掉了残留的 ELECTRON_RUN_AS_NODE', probeValue === 'absent', probeValue || '没有输出')
    const seenArgs = await waitFor(argsProbe)
    check('relaunch: 启动参数原样带过去', seenArgs === probeArgs.join(' '), seenArgs || '没有输出')
    const noArgs = installer.relaunch(probeApp, { platform: 'darwin' })
    check('relaunch: 不传 args 时不报错', noArgs.ok === true && noArgs.args.length === 0)
  }

  /* ---- clearManifest ---- */
  check('clearManifest: 返回 true 并删掉文件', installer.clearManifest(USER_DATA) === true)
  check('clearManifest: 文件已消失', fs.existsSync(installer.manifestPath(USER_DATA)) === false)

  /* ---------------------------------------------------------------- 汇总 */
  console.log('')
  console.log('installer smoke: ' + passed + '/' + (passed + failed) + ' checks passed, node ' + process.version)
  if (failed > 0) process.exitCode = 1
}

function cleanup() {
  try {
    fs.rmSync(ROOT_TMP, { recursive: true, force: true })
  } catch (error) {}
}
process.on('exit', cleanup)

main().catch((error) => {
  console.error('installer smoke crashed: ' + (error && error.stack ? error.stack : error))
  process.exitCode = 1
})
