'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const vendor = 'src/main/runtime/vendor/cordis/'
const manifest = JSON.parse(read(vendor + 'manifest.json'))
assert.strictEqual(crypto.createHash('sha256').update(read(vendor + 'index.js')).digest('hex'), manifest.sha256, 'Regenerate Cordis bundle using vendor:cordis; never patch it manually')
assert.strictEqual(manifest.version, '4.0.0-rc.11')
assert.strictEqual(manifest.target, 'node16.17')
for (const file of ['src/main/agent/agent.js', 'src/main/runtime/run-turn.js']) {
  const code = read(file)
  assert(!/require\(['"]\.\/(?:llm|context-compressor)['"]\)/.test(code), file + ' must resolve execution capabilities through Cordis services')
}
assert(read('src/main/agent/agent.js').includes("requireService('agentLoop').run"))
assert(read('src/main/plugins/plugin-host.js').includes('new Context()'))
assert(!read('src/main/plugins/plugin-host.js').includes('activatePending'), 'Cordis owns dependency scheduling')
assert(read('server/Dockerfile').includes('COPY src/main ./src/main'), 'Docker must include runtime and plugins')
assert(read('scripts/build-desktop.js').includes("copyDir(path.join(ROOT, 'src'), path.join(appDir, 'src'))"), 'Desktop must include runtime bundle')
assert(JSON.parse(read('package.json')).build.files.includes('src/**/*'), 'Electron builder must include runtime bundle')
// Lower layers cannot depend on execution or platform IO.
for (const directory of ['contracts', 'flow']) {
  for (const file of fs.readdirSync(path.join(root, 'src/main', directory)).filter((name) => name.endsWith('.js'))) {
    const code = read('src/main/' + directory + '/' + file)
    assert(!/require\(['"](?:fs|path|http|https|child_process|electron|[^'"]*(?:runtime|plugins|agent)\/)[^'"]*['"]\)/.test(code), directory + '/' + file + ' violates dependency direction')
    assert(!/setTimeout\(|setInterval\(/.test(code), directory + '/' + file + ' must remain pure')
  }
}
for (const file of fs.readdirSync(path.join(root, 'src/main/state')).filter(name => name.endsWith('-state.js'))) {
  const model = read('src/main/state/' + file)
  for (const match of model.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    assert(/^\.\.\/contracts(?:\/|$)/.test(match[1]), file + ' reducer may import contracts only')
  }
  assert(!/setTimeout\(|setInterval\(|Date\.now\(|Math\.random\(/.test(model), file + ' reducer must remain deterministic')
}
const executor = read('src/main/runtime/run-turn.js')
assert(!/this\.messages\.push|this\.messages\s*=|this\.memory\s*=/.test(executor), 'State changes must go through recorded transitions')
for (const capability of ['flow', 'state', 'contracts']) assert(read('src/main/runtime/plugins/agent-loop.js').includes("'" + capability + "'"), 'Executor must inject ' + capability)
console.log('Runtime architecture OK: Cordis integrity, four-layer dependency boundaries, recorded state transitions and offline packaging')
