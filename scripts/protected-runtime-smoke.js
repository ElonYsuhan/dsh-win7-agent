'use strict'
// Exercise the shipped encrypted modules, not development imports. Test files
// and fixtures live in a separate temporary harness and never enter the app.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), assert = require('assert')
const root = path.resolve(__dirname, '..'), bundle = path.resolve(process.argv[2] || 'release/.desktop-build/mac-arm64/delivery/Agent.app')
const app = path.join(bundle, 'Contents/Resources/app'), executable = path.join(bundle, 'Contents/MacOS/Electron')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-protected-runtime-'))
try {
  const report = require('./desktop/source-protection').verify(app)
  assert(report.records.some(record => record.path === 'src/main/runtime/plugins/workflows.js' && record.mode === 'aes-256-gcm'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.symlinkSync(path.join(app, 'src'), path.join(dir, 'src'), 'junction')
  fs.symlinkSync(path.join(root, 'examples'), path.join(dir, 'examples'), 'junction')
  fs.copyFileSync(path.join(app, 'package.json'), path.join(dir, 'package.json'))
  for (const test of ['cordis-runtime-smoke.js', 'workflow-v2-smoke.js', 'workflow-node-design-smoke.js']) {
    // Explicit in-process test fixture; shipped client has no environment/UI bypass.
    const fixture = '{ licensing: { policy: { version: 1, enforced: false, publicKeys: {} } }, '
    const source = fs.readFileSync(path.join(root, 'scripts', test), 'utf8').replace(/new PluginHost\(\{/g, 'new PluginHost('+fixture).replace(/new PluginHost\(\)/g, 'new PluginHost('+fixture+'})')
    fs.writeFileSync(path.join(dir, 'scripts', test), source)
    const result = cp.spawnSync(executable, [path.join(dir, 'scripts', test)], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 120000 })
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.strictEqual(result.status, 0, 'Protected runtime: ' + test)
  }
  console.log('Actual encrypted Mac payload passed Cordis, workflows and node designer regressions under embedded Node16.17.1.')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
