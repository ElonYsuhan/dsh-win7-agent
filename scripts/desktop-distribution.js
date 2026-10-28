'use strict'

// Build tools only. The target still runs the pinned Electron 22 / Node 16.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const runtime = require('./build-desktop')
const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'release', 'desktop')
const WORK = path.join(ROOT, 'release', '.desktop-build')
const REPORTS = path.join(ROOT, 'release', 'validation', 'desktop')
const VERSION = require('../package.json').version
const APPIMAGE_RUNTIME = require('./desktop/appimage-runtime.json')
const WINDOWS_7ZIP = require('./desktop/7zip-win-x64.json')

function entryName(target) {
  if (target.startsWith('mac-')) return 'Agent.app'
  return target === 'win-x64' ? 'Agent.exe' : 'Agent.AppImage'
}

function hashFile(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let count
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

// Includes link targets and executable bits; no following bundle links out of the tree.
function inventory(root) {
  const files = []
  function walk(dir, relative) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      // Finder metadata is not application payload and can appear after publication.
      if (item.name === '.DS_Store' && item.isFile()) continue
      const name = relative ? relative + '/' + item.name : item.name
      const full = path.join(dir, item.name)
      if (item.isSymbolicLink()) files.push({ path: name, link: fs.readlinkSync(full) })
      else if (item.isDirectory()) walk(full, name)
      else if (item.isFile()) files.push({ path: name, sha256: hashFile(full), executable: !!(fs.statSync(full).mode & 0o111) })
    }
  }
  walk(root, '')
  return files
}

function appDirectory(directory, target) {
  return path.join(directory, ...(target.startsWith('mac-') ? ['Agent.app', 'Contents', 'Resources', 'app'] : ['resources', 'app']))
}

function command(file, args, options) {
  return execFileSync(file, args, Object.assign({ cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }) }, options))
}

function fullSevenZip() {
  // 7za bundled with electron-builder only supports 7z/zip, not SquashFS/NSIS.
  // Build-host tool only; never shipped or installed on the target machine.
  const executable = process.env.AGENT_FULL_7ZIP || (process.platform === 'win32'
    ? path.join(ROOT, 'release', '.desktop-tools', '7zip-' + WINDOWS_7ZIP.version + '-win-x64', '7z.exe') : '7z')
  if (process.platform === 'win32') {
    for (const [name, digest] of Object.entries(WINDOWS_7ZIP.files)) {
      if (hashFile(path.join(path.dirname(executable), name)) !== digest) throw new Error('FULL_7ZIP_HASH_MISMATCH: ' + name)
    }
  }
  const banner = command(executable, ['i'], { stdio: 'pipe', encoding: 'utf8' })
  const expected = process.platform === 'win32' ? '7-Zip ' + WINDOWS_7ZIP.version + ' (x64)' : 'p7zip Version 17.05'
  if (!banner.includes(expected) || !banner.includes('SquashFS') || !banner.includes('Nsis')) throw new Error('FULL_7ZIP_REQUIRED: ' + expected)
  return executable
}

async function appImageRuntime(target, appDirectory) {
  const name = target.endsWith('arm64') ? 'runtime-aarch64' : 'runtime-x86_64'
  const cache = path.join(ROOT, 'release', '.desktop-tools', 'appimage-' + APPIMAGE_RUNTIME.version)
  fs.mkdirSync(cache, { recursive: true })
  for (const file of [name, 'LICENSE']) {
    const info = APPIMAGE_RUNTIME.files[file], destination = path.join(cache, file)
    if (!fs.existsSync(destination)) {
      const temporary = destination + '.download'
      try {
        await runtime.download(info.url, temporary)
        if (hashFile(temporary) !== info.sha256) throw new Error('APPIMAGE_RUNTIME_HASH: ' + file)
        fs.renameSync(temporary, destination)
      } finally { fs.rmSync(temporary, { force: true }) }
    }
    if (hashFile(destination) !== info.sha256) throw new Error('APPIMAGE_RUNTIME_HASH: ' + file)
  }
  assertHeader(path.join(cache, name), target)
  const notice = path.join(appDirectory, 'third-party', 'appimage')
  fs.mkdirSync(notice, { recursive: true })
  fs.copyFileSync(path.join(cache, 'LICENSE'), path.join(notice, 'LICENSE.txt'))
  fs.writeFileSync(path.join(notice, 'source.json'), JSON.stringify(APPIMAGE_RUNTIME, null, 2) + '\n')
  return fs.readFileSync(path.join(cache, name))
}

function builderConfig(target, output) {
  return {
    extends: null,
    appId: 'com.dsh.agent', productName: 'Agent', electronVersion: '22.3.27',
    npmRebuild: false, asar: false, compression: 'normal', publish: null,
    directories: { output, buildResources: path.join(ROOT, 'assets', 'icons') },
    win: { executableName: 'Agent', icon: path.join(ROOT, 'assets', 'icons', 'icon.ico'), signAndEditExecutable: false, artifactName: 'Agent.exe' },
    nsis: {
      oneClick: true, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false,
      createDesktopShortcut: true, createStartMenuShortcut: true,
      shortcutName: 'Agent', runAfterFinish: true, deleteAppDataOnUninstall: false,
      differentialPackage: false, installerLanguages: ['zh_CN', 'en_US'],
      displayLanguageSelector: false, unicode: true,
      include: path.join(ROOT, 'scripts', 'desktop', 'installer.nsh')
    },
    linux: { executableName: 'Agent', icon: path.join(ROOT, 'assets', 'icons', 'icon.png'), category: 'Office', artifactName: 'Agent.AppImage' },
    appImage: { artifactName: 'Agent.AppImage', executableArgs: [] }
  }
}

async function prepare(target) {
  const builder = require('electron-builder')
  if (require('electron-builder/package.json').version !== '24.13.3') throw new Error('DESKTOP_BUILDER_VERSION')
  const workspace = path.join(WORK, target)
  fs.mkdirSync(workspace, { recursive: true })
  const input = await runtime.buildTarget(target, { noZip: true, outRoot: workspace })
  const appDir = appDirectory(input, target)
  const licensing = require('./desktop/license-policy').stamp(appDir)
  const protection = await require('./desktop/source-protection').protect(appDir)
  fs.writeFileSync(path.join(appDir, 'distribution.json'), JSON.stringify({
    formatVersion: 1, target, version: VERSION,
    kind: target.startsWith('mac-') ? 'app-bundle' : target === 'win-x64' ? 'nsis' : 'appimage',
    directoryTakeover: target.startsWith('mac-')
  }, null, 2) + '\n')
  const imageRuntime = target.startsWith('linux-') ? await appImageRuntime(target, appDir) : null
  // Compute once on the build host, rather than opening hundreds of small files at startup.
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' }).trim()
  const buildMetadata = {
    formatVersion: 1, target, version: VERSION, sourceCommit, electron: '22.3.27', node: '16.17.1', chromium: '108',
    uiBuild: require('../src/main/agent/ui-build').computeUiBuild(path.join(appDir, 'src', 'renderer')),
    packageBuildId: require('../shell/installer').computePackageBuildId(appDir)
  }
  fs.writeFileSync(path.join(appDir, 'desktop-build.json'), JSON.stringify(buildMetadata, null, 2) + '\n')
  const staged = path.join(workspace, 'delivery')
  // Only scratch output is cleared. The previous delivery remains until verification succeeds.
  fs.rmSync(staged, { recursive: true, force: true })
  fs.mkdirSync(staged, { recursive: true })
  if (target.startsWith('mac-')) {
    if (process.platform !== 'darwin') throw new Error('MAC_BUNDLE_REQUIRES_MAC_BUILD_HOST')
    command('codesign', ['--force', '--deep', '--sign', '-', path.join(input, 'Agent.app')])
    command('ditto', [path.join(input, 'Agent.app'), path.join(staged, 'Agent.app')])
    command('codesign', ['--verify', '--deep', '--strict', path.join(staged, 'Agent.app')])
  } else {
    const config = builderConfig(target, path.join(workspace, 'builder'))
    if (target === 'win-x64') {
      const launcherInclude = path.join(workspace, 'installer-build.nsh')
      // NSIS resolves a nested !include only for a backslash-separated absolute
      // path; forward slashes fail with a misleading "could not find".
      fs.writeFileSync(launcherInclude, '!define AGENT_PACKAGE_BUILD_ID "' + buildMetadata.packageBuildId + '"\n!include "' + config.nsis.include + '"\n')
      config.nsis.include = launcherInclude
    }
    const platform = target === 'win-x64' ? builder.Platform.WINDOWS : builder.Platform.LINUX
    const arch = target.endsWith('arm64') ? builder.Arch.arm64 : builder.Arch.x64
    await builder.build({ projectDir: ROOT, prepackaged: input, config, targets: platform.createTarget(target === 'win-x64' ? 'nsis' : 'AppImage', arch), publish: 'never' })
    fs.copyFileSync(path.join(config.directories.output, entryName(target)), path.join(staged, entryName(target)))
    if (imageRuntime) {
      // Keep the generated filesystem, replace only the obsolete dynamic ELF stub.
      const file = path.join(staged, entryName(target)), data = fs.readFileSync(file)
      const { offset, size } = squashfsRange(data)
      fs.writeFileSync(file, Buffer.concat([imageRuntime, data.subarray(offset, offset + size)]))
      fs.chmodSync(file, 0o755)
    }
  }
  await verify(target, staged, input)
  const payload = inventory(input)
  const delivery = inventory(staged)
  const report = { formatVersion: 1, target, version: VERSION, sourceCommit, buildMetadata, licensing, sourceProtection: { policy: protection.policy, tools: protection.tools, encrypted: protection.records.filter(r => r.mode === 'aes-256-gcm').length, obfuscated: protection.records.filter(r => r.mode === 'obfuscated').length },
    runtime: { electron: '22.3.27', node: '16.17.1', chromium: '108' },
    tools: { electronBuilder: '24.13.3', appBuilder: '4.0.0', nsis: '3.0.4.1', appimage: '12.0.1', appimageRuntime: APPIMAGE_RUNTIME.version, full7zip: process.platform === 'win32' ? { name: '7-Zip', ...WINDOWS_7ZIP } : 'p7zip 17.06 (17.05 banner)' },
    payload, delivery, verification: 'payload byte comparison and platform headers passed',
    targetMachineTest: target === 'mac-' + process.arch && process.platform === 'darwin' ? 'embedded runtime checked separately' : 'not performed' }
  fs.mkdirSync(REPORTS, { recursive: true })
  fs.writeFileSync(path.join(REPORTS, target + '.json'), JSON.stringify(report, null, 2) + '\n')
  return { target, staged, report }
}

function assertHeader(file, target) {
  const fd = fs.openSync(file, 'r'), header = Buffer.alloc(4096)
  try { fs.readSync(fd, header, 0, header.length, 0) } finally { fs.closeSync(fd) }
  if (target === 'win-x64') {
    if (header.toString('ascii', 0, 2) !== 'MZ' || header.toString('ascii', header.readUInt32LE(60), header.readUInt32LE(60) + 2) !== 'PE') throw new Error('INVALID_PE')
  } else if (target.startsWith('linux-')) {
    if (header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 || header.readUInt16LE(18) !== (target.endsWith('arm64') ? 183 : 62)) throw new Error('INVALID_ELF_ARCH')
  } else if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== (target.endsWith('arm64') ? 0x100000c : 0x1000007)) throw new Error('INVALID_MACH_ARCH')
}

function squashfsRange(data) {
  let offset = -1
  while ((offset = data.indexOf(Buffer.from('hsqs'), offset + 1)) >= 0) {
    if (offset + 96 > data.length || data.readUInt16LE(offset + 28) !== 4 || data.readUInt16LE(offset + 30) !== 0) continue
    const size = Number(data.readBigUInt64LE(offset + 40))
    if (Number.isSafeInteger(size) && size >= 96 && offset + size <= data.length) return { offset, size }
  }
  throw new Error('APPIMAGE_SQUASHFS_MISSING')
}

async function verify(target, staged, input) {
  const entry = entryName(target)
  if (JSON.stringify(fs.readdirSync(staged)) !== JSON.stringify([entry])) throw new Error('DELIVERY_MUST_HAVE_ONE_ENTRY')
  if (target.startsWith('mac-')) {
    assertHeader(path.join(staged, entry, 'Contents', 'MacOS', 'Electron'), target)
    // Re-signing changes signature files; application payload must remain identical.
    if (JSON.stringify(inventory(appDirectory(input, target))) !== JSON.stringify(inventory(appDirectory(staged, target)))) throw new Error('MAC_PAYLOAD_MISMATCH')
    return
  }
  const executable = path.join(staged, entry)
  assertHeader(executable, target)
  const extracted = path.join(path.dirname(staged), 'verify')
  fs.rmSync(extracted, { recursive: true, force: true })
  fs.mkdirSync(extracted, { recursive: true })
  const sevenZip = fullSevenZip()
  let payloadRoot
  if (target === 'win-x64') {
    command(sevenZip, ['x', '-y', '-o' + extracted, executable], { stdio: 'pipe' })
    const archive = path.join(extracted, '$PLUGINSDIR', 'app-64.7z')
    if (!fs.existsSync(archive)) throw new Error('NSIS_OFFLINE_PAYLOAD_MISSING')
    payloadRoot = path.join(extracted, 'payload')
    command(sevenZip, ['x', '-y', '-o' + payloadRoot, archive], { stdio: 'pipe' })
    const pe = fs.readFileSync(path.join(payloadRoot, 'Agent.exe'))
    if (pe.readUInt16LE(pe.readUInt32LE(60) + 4) !== 0x8664) throw new Error('WINDOWS_PAYLOAD_NOT_X64')
  } else {
    // Extract exactly SquashFS bytes, excluding the ELF prefix and update blockmap.
    const data = fs.readFileSync(executable)
    const { offset, size } = squashfsRange(data)
    const squash = path.join(extracted, 'payload.squashfs')
    fs.writeFileSync(squash, data.subarray(offset, offset + size))
    payloadRoot = path.join(extracted, 'payload')
    command(sevenZip, ['x', '-y', '-o' + payloadRoot, squash], { stdio: 'pipe' })
    assertHeader(path.join(payloadRoot, 'Agent'), target)
  }
  for (const item of inventory(input)) {
    const file = path.join(payloadRoot, item.path)
    if (item.link ? fs.readlinkSync(file) !== item.link : hashFile(file) !== item.sha256) throw new Error('PACKAGED_PAYLOAD_MISMATCH: ' + item.path)
  }
}

function publish(prepared, output) {
  const directory = output || OUTPUT
  fs.mkdirSync(directory, { recursive: true })
  const destination = path.join(directory, 'Agent-' + prepared.target)
  if (fs.existsSync(destination) && process.platform !== 'win32') {
    const processes = command('ps', ['-axo', 'command='], { stdio: 'pipe', encoding: 'utf8' })
    if (processes.includes(destination + path.sep)) throw new Error('DELIVERY_IN_USE: ' + destination)
  }
  // Backup is private build state, outside the delivery tree. Rename failure leaves old data intact.
  const backup = path.join(path.dirname(prepared.staged), 'previous-delivery')
  if (fs.existsSync(backup)) throw new Error('PREVIOUS_DELIVERY_REQUIRES_RECOVERY: ' + backup)
  if (fs.existsSync(destination)) fs.renameSync(destination, backup)
  try { fs.renameSync(prepared.staged, destination) } catch (error) {
    if (fs.existsSync(backup)) fs.renameSync(backup, destination)
    throw error
  }
  try { fs.rmSync(backup, { recursive: true, force: true }) } catch (error) { console.warn('保留待清理的旧包：' + backup) }
  return destination
}

function checksums(directory) {
  const lines = []
  for (const target of runtime.targets) {
    const dir = path.join(directory, 'Agent-' + target)
    if (!fs.existsSync(dir)) continue
    for (const item of inventory(dir)) if (item.sha256) lines.push(item.sha256 + '  Agent-' + target + '/' + item.path + '\n')
  }
  const temporary = path.join(directory, '.SHA256SUMS.tmp')
  fs.writeFileSync(temporary, lines.join(''))
  fs.renameSync(temporary, path.join(directory, 'SHA256SUMS.txt'))
}

async function main() {
  const args = process.argv.slice(2), stageOnly = args.includes('--stage-only')
  const names = args.filter(name => name !== '--stage-only')
  if (!names.length || names.some(name => name.startsWith('--'))) throw new Error('usage: node scripts/build-desktop.js <all|win-x64|mac-arm64|mac-x64|linux-x64|linux-arm64> [--stage-only]')
  const targets = [...new Set(names.includes('all') ? runtime.targets : names.map(name => runtime.aliases[name] || name))]
  if (targets.some(target => !runtime.targets.includes(target))) throw new Error('UNKNOWN_DESKTOP_TARGET')
  const prepared = []
  for (const target of targets) prepared.push(await prepare(target))
  if (stageOnly) { for (const item of prepared) console.log('[desktop-distribution] verified staging ' + item.staged); return }
  // Validate the whole requested batch before replacing any previously working delivery.
  for (const item of prepared) console.log('[desktop-distribution] delivered ' + publish(item))
  checksums(OUTPUT)
  require('./release-retention').pruneLegacy(OUTPUT, targets)
}

module.exports = { entryName, inventory, builderConfig, publish, checksums, assertHeader, squashfsRange, main }
