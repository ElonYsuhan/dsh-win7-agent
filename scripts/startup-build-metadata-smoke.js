'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { uiBuild, computeUiBuild } = require('../src/main/agent/ui-build')
const { packageBuildId, computePackageBuildId } = require('../shell/installer')
const metadata = require('../src/main/platform/build-metadata')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-build-metadata-'))
const directory = path.join(temporary, 'resources', 'app')
const renderer = path.join(directory, 'src', 'renderer')
try {
  fs.mkdirSync(renderer, { recursive: true })
  fs.writeFileSync(path.join(renderer, 'app.js'), 'original UI')
  fs.writeFileSync(path.join(directory, 'main.js'), 'original shell')
  const first = { formatVersion: 1, target: 'win-x64', version: '0.4.3', electron: '22.3.27', node: '16.17.1', chromium: '108', uiBuild: computeUiBuild(renderer), packageBuildId: computePackageBuildId(directory) }
  assert.strictEqual(uiBuild(renderer), first.uiBuild)
  assert.strictEqual(packageBuildId(temporary, 'win32'), first.packageBuildId, 'old packages and development still hash real contents')
  const manifest = path.join(directory, metadata.NAME)
  fs.writeFileSync(manifest, JSON.stringify(first))
  const oldRead = fs.readFileSync, oldList = fs.readdirSync
  let reads = 0, bytes = 0
  try {
    fs.readdirSync = () => { throw Error('Startup must not enumerate application files') }
    fs.readFileSync = function(file, ...args) { assert.strictEqual(file, manifest); const value = oldRead.call(this, file, ...args); reads++; bytes += Buffer.byteLength(value); return value }
    assert.strictEqual(uiBuild(renderer), first.uiBuild)
    assert.strictEqual(packageBuildId(temporary, 'win32'), first.packageBuildId)
    assert.strictEqual(reads, 2)
    assert(bytes < 2048, 'two startup consumers only read bounded build metadata')
  } finally { fs.readFileSync = oldRead; fs.readdirSync = oldList }
  // Daily builds retain the public version. A new immutable manifest changes both identities.
  fs.writeFileSync(path.join(renderer, 'app.js'), 'updated UI')
  fs.writeFileSync(path.join(directory, 'main.js'), 'updated shell')
  const second = { ...first, uiBuild: computeUiBuild(renderer), packageBuildId: computePackageBuildId(directory) }
  assert.notStrictEqual(second.packageBuildId, first.packageBuildId)
  assert.notStrictEqual(second.uiBuild, first.uiBuild)
  fs.writeFileSync(manifest, JSON.stringify(second))
  assert.strictEqual(uiBuild(renderer), second.uiBuild, 'same-path replacement must not use a process-global manifest cache')
  assert.strictEqual(packageBuildId(temporary, 'win32'), second.packageBuildId)
  for (const bad of ['{', JSON.stringify({ ...second, electron: '23.0.0' }), JSON.stringify({ ...second, uiBuild: 'bad' }), ' '.repeat(8193)]) {
    fs.writeFileSync(manifest, bad)
    assert.strictEqual(metadata.read(directory), null)
    assert.strictEqual(uiBuild(renderer), second.uiBuild)
    assert.strictEqual(packageBuildId(temporary, 'win32'), second.packageBuildId, 'invalid manifest safely falls back without hashing itself')
  }
  console.log('Startup metadata: bounded two-file reads, no package traversal, same-version replacement, invalid/old/dev fallback passed; '+bytes+' bytes read')
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
