'use strict'

// Build-host-only regression: Vite 5 requires a newer build-machine Node than
// the target runtime. The generated files stay in a fresh temporary directory;
// this does not create or replace an application or installer.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { build, assertNoDynamicExecution } = require('./build-generative-ui')
const digest = data => crypto.createHash('sha256').update(data).digest('hex')

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gui-build-check-'))
  const rejected = path.join(temporary, 'nonempty')
  const output = path.join(temporary, 'output')
  fs.mkdirSync(rejected)
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(rejected, 'sentinel'), 'do not modify')
  try {
    await assert.rejects(build(rejected), /GENERATIVE_UI_EMPTY_OUTPUT_REQUIRED/)
    assert.strictEqual(fs.readFileSync(path.join(rejected, 'sentinel'), 'utf8'), 'do not modify')
    const report = await build(output)
    const stored = JSON.parse(fs.readFileSync(path.join(output, 'generative-ui-build.json'), 'utf8'))
    assert.deepStrictEqual(stored, report)
    assert.deepStrictEqual(report.runtime, { electron: '22.3.27', node: '16.17.1', chromium: '108' })
    assert(report.packages.some(item => item.name === 'vue'))
    assert(report.packages.some(item => item.name === 'naive-ui'))
    assert(report.packages.some(item => item.name === 'echarts'))
    assert(report.packages.every(item => typeof item.integrity === 'string' && item.integrity.length > 0), 'every bundled package has locked npm integrity')
    assert(report.dependencySources.length > 0 && report.dependencySources.every(item => item.path.startsWith('node_modules/') && /^[a-f0-9]{64}$/.test(item.sha256)), 'rendered dependency source hashes are inventoried')
    assert(!report.packages.some(item => item.name === 'vdirs'), 'the unused directive must not be included without its license')
    assert(report.transforms.some(item => item.package === 'lodash-es' && item.path === '_root.js'))
    for (const relative of ['scripts/build-generative-ui.js', 'scripts/desktop/generative-ui-manifest.js', 'scripts/desktop/source-protection.js', 'package.json', 'package-lock.json', 'src/main/contracts/generative-ui.js']) {
      assert(report.sources.some(item => item.path === relative), 'manifest must cover build input ' + relative)
    }
    const listed = new Set()
    for (const item of report.files) {
      assert(!path.isAbsolute(item.path) && !item.path.split('/').includes('..'), 'file path must stay within output')
      assert(!listed.has(item.path), 'file entries must be unique')
      listed.add(item.path)
      const content = fs.readFileSync(path.join(output, item.path))
      assert.strictEqual(content.length, item.size)
      assert.strictEqual(digest(content), item.sha256)
      assert(!/\.(?:map|ts|vue)$/.test(item.path), 'do not ship original UI source or source maps')
    }
    for (const item of report.packages) {
      assert(report.files.some(file => file.path.startsWith('licenses/' + item.folder + '/') && /\/(?:licen[cs]e|copying)(?:\.[\w-]+)?$/i.test(file.path)), 'missing bundled license: ' + item.name)
    }
    assertNoDynamicExecution(fs.readFileSync(path.join(output, 'agent-ui-vendor.js')), 'vendor')
    assertNoDynamicExecution(fs.readFileSync(path.join(output, 'agent-generative-ui.js')), 'app')
    assert(!/url\s*\(/i.test(fs.readFileSync(path.join(output, 'agent-generative-ui.css'), 'utf8')), 'UI CSS must not load remote assets')
    console.log('Generative UI build check passed: pinned versions, source inventory, ' + report.packages.length + ' licensed runtime packages, CSP transform, hashes and no source maps; no app packaged.')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
