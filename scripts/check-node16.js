'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const root = path.resolve(__dirname, '..')
const platform = process.platform === 'darwin' ? 'darwin-' + process.arch : process.platform + '-' + process.arch
const binary = process.platform === 'darwin' ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron') : (process.platform === 'win32' ? 'electron.exe' : 'electron')
const candidates = [
  process.env.AGENT_NODE16_EXECUTABLE,
  process.versions.node === '16.17.1' ? process.execPath : '',
  path.join(root, 'release', '.electron-dist', 'unpacked', platform, binary),
  path.join(root, 'node_modules', 'electron', 'dist', binary)
].filter(Boolean)
const executable = candidates.find((file) => fs.existsSync(file))
if (!executable) throw new Error('NODE16_RUNTIME_NOT_FOUND: build/cache Electron 22 or set AGENT_NODE16_EXECUTABLE')
const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
const version = spawnSync(executable, ['-p', 'process.versions.node'], { env, encoding: 'utf8' })
if (version.status !== 0 || String(version.stdout).trim() !== '16.17.1') throw new Error('Expected embedded Node 16.17.1: ' + version.stdout + version.stderr)
const commands = require('../package.json').scripts.check.split(' && ')
for (const file of ['smoke', 'permission-smoke', 'context-compression-smoke', 'session-isolation-smoke', 'reasoning-smoke']) {
  const command = 'node scripts/' + file + '.js'
  if (!commands.includes(command)) commands.push(command)
}
for (const command of commands) {
  const match = /^node (scripts\/[a-z0-9-]+\.js)$/.exec(command)
  if (!match) throw new Error('Unsupported check command: ' + command)
  console.log('\nNode 16.17.1: ' + match[1])
  const result = spawnSync(executable, [path.join(root, match[1])], { cwd: root, env, stdio: 'inherit', timeout: 120000 })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log('\nNode 16.17.1 checks passed: ' + commands.length + ' suites')
