'use strict'

// Real macOS bundles, native launch and Chromium108, with a private profile and
// a unique bundle identifier. Never activates or terminates the user's Agent.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert')
const { spawn, execFileSync } = require('child_process')
const net = require('net')
const { MiniWebSocket, CdpSession, httpGetJson } = require('../src/main/agent/cdp-client')
const installer = require('../shell/installer')
const { computeUiBuild } = require('../src/main/agent/ui-build')
const ROOT = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, name, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { try { const value = await fn(); if (value) return value } catch (_) {} await pause(100) }
  throw Error('Timed out: ' + name)
}
async function port() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
async function main() {
  assert.strictEqual(process.platform, 'darwin', 'This test exercises native macOS bundles')
  const original = path.resolve(process.argv[2] || path.join(ROOT, 'release/desktop/Agent-mac-' + process.arch + '/Agent.app'))
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-real-upgrade-')))
  const old = path.join(temporary, 'old', 'Agent.app'), next = path.join(temporary, 'new', 'Agent.app')
  const profile = path.join(temporary, 'profile'), agentHome = path.join(profile, 'agent-home')
  const sockets = [], children = [], servicePids = new Set()
  const identity = 'com.dsh.upgrade.fixture.' + Date.now()
  let oldPid = 0, log = -1
  try {
    fs.mkdirSync(agentHome, { recursive: true })
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ mode: 'local', lastPort: await port(), theme: 'light' }))
    fs.writeFileSync(path.join(agentHome, 'settings.json'), JSON.stringify({ workspacePath: temporary }))
    const stamp = new Date().toISOString()
    fs.writeFileSync(path.join(agentHome, 'ui-store.json'), JSON.stringify({ sessions: { __recent__: [{ id: 'preserved_fixture', title: '升级前的会话', scope: 'recent', workspacePath: temporary, createdAt: stamp, updatedAt: stamp, messages: [{ role: 'user', content: '升级验收保留内容' }] }] }, currentSessionId: 'preserved_fixture', prefs: {} }))
    const sentinel = Buffer.from('profile sentinel \u0000 retained without migration')
    fs.writeFileSync(path.join(agentHome, 'preserved.bin'), sentinel)
    let newBuild
    for (const bundle of [old, next]) {
      fs.mkdirSync(path.dirname(bundle), { recursive: true })
      execFileSync('ditto', [original, bundle])
      const plist = path.join(bundle, 'Contents/Info.plist'), app = path.join(bundle, 'Contents/Resources/app')
      fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/, '$1' + identity + '$2'))
      if (bundle === old) fs.appendFileSync(path.join(app, 'src/renderer/app.js'), '\nwindow.__upgradeFixtureOld=true;\n')
      if (bundle === next && process.env.AGENT_SMOKE_WORKTREE === '1') {
        for (const name of ['main.js', 'installer.js']) fs.copyFileSync(path.join(ROOT, 'shell', name), path.join(app, name))
      }
      const metadataFile = path.join(app, 'desktop-build.json'), metadata = JSON.parse(fs.readFileSync(metadataFile))
      metadata.uiBuild = computeUiBuild(path.join(app, 'src/renderer'))
      metadata.packageBuildId = installer.computePackageBuildId(app)
      fs.writeFileSync(metadataFile, JSON.stringify(metadata))
      if (bundle === next) newBuild = metadata.packageBuildId
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' })
    }
    const oldDebug = await port(), nextDebug = await port(), env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    log = fs.openSync(path.join(temporary, 'process.log'), 'w')
    const args = debug => ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debug]
    const first = spawn(path.join(old, 'Contents/MacOS/Electron'), args(oldDebug), { env, stdio: ['ignore', log, log] })
    children.push(first); oldPid = first.pid
    async function connect(debug) {
      const page = await until(async () => (await httpGetJson('127.0.0.1', debug, '/json/list', 500)).find(item => item.type === 'page' && /^http:/.test(item.url)), 'service renderer')
      const health = await httpGetJson('127.0.0.1', Number(new URL(page.url).port), '/api/health')
      servicePids.add(health.pid)
      const socket = new MiniWebSocket(), url = new URL(page.webSocketDebuggerUrl)
      await socket.connect(url.hostname, Number(url.port), url.pathname); sockets.push(socket)
      const cdp = new CdpSession(socket)
      const evaluate = async expression => { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
      await until(() => evaluate('typeof state!=="undefined"&&state.currentSessionId==="preserved_fixture"&&!!document.querySelector(".bubble")'), 'preserved conversation')
      return { evaluate, health }
    }
    const before = await connect(oldDebug)
    assert(await before.evaluate('window.__upgradeFixtureOld===true'))
    await until(() => installer.readManifest(profile)?.pid === oldPid, 'old package registration')
    fs.renameSync(old, path.join(temporary, 'moved-old.app'))
    assert(!fs.existsSync(old) && installer.isAlive(oldPid))
    assert(installer.processOwnsPackage(oldPid, old, 'darwin'), 'exact identity survives a moved bundle')
    // Finder/LaunchServices may only activate an existing process. Observe that
    // behavior separately, then explicitly launch a fresh instance if necessary.
    execFileSync('open', [next, '--args', ...args(nextDebug)], { env })
    let finderLaunchedFresh = true
    try { await until(() => installer.readManifest(profile)?.buildId === newBuild, 'Finder handoff', 8000) }
    catch (_) {
      finderLaunchedFresh = false
      execFileSync('open', ['-n', next, '--args', ...args(nextDebug)], { env })
    }
    const record = await until(() => { const value = installer.readManifest(profile); return value?.buildId === newBuild && value?.path === next && value?.pid !== oldPid ? value : null }, 'new package takes ownership')
    const after = await connect(nextDebug)
    assert(!installer.isAlive(oldPid), 'old shell has exited')
    assert.strictEqual(await after.evaluate('window.__upgradeFixtureOld===true'), false, 'new renderer actually loaded')
    assert.strictEqual(after.health.agentHome, agentHome, 'profile path does not change')
    assert(fs.readFileSync(path.join(agentHome, 'preserved.bin')).equals(sentinel))
    assert(!fs.existsSync(old), 'do not recreate an obsolete missing installation')
    const report = { platform: process.platform, arch: process.arch, finderLaunchedFresh, freshLaunchTakeover: true, missingBundleOwnership: true, oldProcessExited: true, sameVersion: true, profilePreserved: true, newRendererLoaded: true, newBuild, newPid: record.pid }
    fs.mkdirSync(path.join(ROOT, 'release/validation'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'release/validation/update-takeover.json'), JSON.stringify(report, null, 2) + '\n')
    console.log('Real Mac upgrade passed: ' + JSON.stringify(report))
  } catch (error) {
    try { console.error(fs.readFileSync(path.join(temporary, 'process.log'), 'utf8').slice(-4000)) } catch (_) {}
    throw error
  } finally {
    for (const socket of sockets) if (socket.socket) socket.socket.destroy()
    const manifest = installer.readManifest(profile)
    for (const pid of [manifest?.pid, oldPid, ...children.map(child => child.pid)]) {
      if (!pid || pid === process.pid) continue
      const command = (() => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }) } catch (_) { return '' } })()
      if (command.startsWith(temporary + '/')) try { process.kill(pid, 'SIGTERM') } catch (_) {}
    }
    await pause(2800)
    for (const pid of servicePids) { try { const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); if (command.startsWith(temporary + '/')) process.kill(pid, 'SIGTERM') } catch (_) {} }
    if (log >= 0) fs.closeSync(log)
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
