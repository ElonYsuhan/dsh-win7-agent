'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const root = path.resolve(__dirname, '..')
const started = Date.now()
const commands = require('../package.json').scripts.check.split(' && ')
for (const file of ['smoke', 'permission-smoke', 'context-compression-smoke', 'session-isolation-smoke', 'reasoning-smoke']) {
  const command = 'node scripts/' + file + '.js'
  if (!commands.includes(command)) commands.push(command)
}
const suites = commands.map((command) => {
  const match = /^node (scripts\/[a-z0-9-]+\.js)$/.exec(command)
  if (!match) throw new Error('Unsupported check command: ' + command)
  return match[1]
}).filter((file) => file !== 'scripts/typecheck-core.js')
const args = process.argv.slice(2)
const requested = args.filter((arg) => arg !== '--list')
const selected = requested.length ? [...new Set(requested.map((name) => {
  const file = 'scripts/' + name.replace(/^scripts\//, '').replace(/\.js$/, '') + '.js'
  if (!suites.includes(file)) throw new Error('Unknown Node 16 suite: ' + name)
  return file
}))] : suites
if (args.includes('--list')) {
  console.log(selected.join('\n'))
  process.exit(0)
}
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
for (const file of selected) {
  console.log('\nNode 16.17.1: ' + file)
  const suiteStarted = Date.now()
  const result = spawnSync(executable, [path.join(root, file)], { cwd: root, env, stdio: 'inherit', timeout: 120000 })
  console.log('Node 16.17.1 elapsed: ' + (Date.now() - suiteStarted) + ' ms; total ' + (Date.now() - started) + ' ms')
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log('\nNode 16.17.1 checks passed: ' + selected.length + ' suites, ' + (Date.now() - started) + ' ms')
