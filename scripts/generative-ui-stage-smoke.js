'use strict'

// Exercises the real resource staging and protection pipeline in a synthetic
// temporary app; it does not create, publish, or replace a desktop package.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { stageApp } = require('./build-generative-ui')
const manifest = require('./desktop/generative-ui-manifest')
const protection = require('./desktop/source-protection')
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gui-protection-')))
  const put = (name, value) => { const file = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
  const read = name => fs.readFileSync(path.join(root, ...name.split('/')))
  const mutate = (name, expected) => {
    const original = read(name)
    fs.appendFileSync(path.join(root, ...name.split('/')), '\ntampered')
    assert.throws(() => protection.verify(root, publicKey), expected)
    fs.writeFileSync(path.join(root, ...name.split('/')), original)
  }
  const pair = crypto.generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' })
  try {
    put('package.json', '{"name":"gui-stage-test","main":"main.js"}')
    put('main.js', "'use strict';module.exports=require('./service/index')")
    put('service/index.js', "'use strict';module.exports=1")
    put('src/renderer/app.js', "'use strict';window.test=true")
    const result = await stageApp(root)
    assert(result.packages.some(item => item.name === 'vue') && result.packages.some(item => item.name === 'naive-ui') && result.packages.some(item => item.name === 'echarts'))
    assert(!result.packages.some(item => item.name === 'vdirs'))
    const before = manifest.verify(root), vendor = read(manifest.VENDOR), app = read(manifest.APP)
    assert.strictEqual(protection.mode(manifest.VENDOR), null, 'vendor code must not be obfuscated')
    assert.strictEqual(protection.mode(manifest.APP), 'browser', 'app UI must be protected as browser code')
    await assert.rejects(stageApp(root), /GENERATIVE_UI_STAGE_DESTINATION/, 'a second stage must not overwrite existing assets')
    const protectedReport = await protection.protect(root, { signingKey: pair.privateKey })
    assert.deepStrictEqual(protectedReport.generativeUi, before)
    assert(read(manifest.VENDOR).equals(vendor), 'staged vendor code is retained unchanged')
    assert(!read(manifest.APP).equals(app), 'self-authored UI bundle is transformed')
    assert(protectedReport.records.some(item => item.path === manifest.APP && item.mode === 'obfuscated'))
    protection.verify(root, publicKey)
    const loader = require(path.join(root, 'source-loader.js'))
    for (const name of [manifest.APP, manifest.VENDOR, manifest.CSS]) loader.verifyFile(path.join(root, ...name.split('/')))
    mutate(manifest.VENDOR, /GENERATIVE_UI_STAGE_INTEGRITY/)
    mutate(manifest.CSS, /GENERATIVE_UI_STAGE_INTEGRITY/)
    mutate(manifest.APP, /GENERATIVE_UI_STAGE_PROTECTION/)
    const license = result.files.find(item => item.path.startsWith('licenses/') && /\/LICENSE(?:\.[\w-]+)?$/i.test(item.path))
    assert(license)
    mutate(manifest.destination(license.path), /GENERATIVE_UI_STAGE_INTEGRITY/)
    mutate(manifest.REPORT, /GENERATIVE_UI_MANIFEST_INTEGRITY|SyntaxError|JSON/)
    protection.verify(root, publicKey)
    console.log('Generative UI staging: licensed offline resources, vendor boundary, pre/post-protection provenance, signed manifest and tamper rejection passed; no app packaged.')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
