'use strict'

// Build-host verification of the pre-protection browser resource manifest and
// its fixed locations in a staged app. No keys or renderer code are loaded.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const REPORT = 'third-party/generative-ui/pre-protection.json'
const APP = 'src/renderer/generative-ui/agent-generative-ui.js'
const VENDOR = 'src/renderer/vendor/generative-ui/agent-ui-vendor.js'
const CSS = 'src/renderer/generative-ui/agent-generative-ui.css'
const CESIUM = 'src/renderer/vendor/generative-ui/agent-ui-cesium.js'
const digest = data => crypto.createHash('sha256').update(data).digest('hex')
function destination(name) {
  if (name === 'agent-generative-ui.js') return APP
  if (name === 'agent-ui-vendor.js') return VENDOR
  if (name === 'agent-ui-cesium.js') return CESIUM
  if (name === 'agent-generative-ui.css') return CSS
  if (/^cesium\/Assets\/IAU2006_XYS\/IAU2006_XYS_(?:[0-9]|1[0-9]|2[0-7])\.json$/.test(name)) return 'src/renderer/vendor/generative-ui/' + name.slice('cesium/'.length)
  if (/^licenses\/[0-9a-f]+\/[A-Za-z0-9._-]+$/.test(name)) return 'third-party/generative-ui/' + name
  throw new Error('GENERATIVE_UI_STAGE_PATH: ' + String(name))
}
function file(root, relative) { return path.join(root, ...relative.split('/')) }
function exists(root) {
  return [REPORT, APP, VENDOR, CSS, CESIUM].some(name => fs.existsSync(file(root, name)))
}
function verify(root, records) {
  const reportBytes = fs.readFileSync(file(root, REPORT))
  const document = JSON.parse(reportBytes.toString('utf8'))
  if (document.formatVersion !== 1 || document.phase !== 'before-agent-source-v1' || !document.build) throw new Error('GENERATIVE_UI_STAGE_MANIFEST')
  const build = document.build
  if (build.formatVersion !== 1 || !build.runtime || build.runtime.electron !== '22.3.27' || build.runtime.node !== '16.17.1' || build.runtime.chromium !== '108' || !Array.isArray(build.files) || !Array.isArray(build.packages)) throw new Error('GENERATIVE_UI_STAGE_BUILD')
  const known = new Set(), paths = new Set()
  for (const item of build.files) {
    if (!item || typeof item.path !== 'string' || known.has(item.path) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('GENERATIVE_UI_STAGE_FILE')
    known.add(item.path)
    const relative = destination(item.path)
    if (paths.has(relative)) throw new Error('GENERATIVE_UI_STAGE_DUPLICATE')
    paths.add(relative)
    const bytes = fs.readFileSync(file(root, relative))
    if (relative === APP && records) {
      const record = records.find(entry => entry.path === APP)
      if (!record || record.mode !== 'obfuscated' || record.sourceSha256 !== item.sha256 || record.entrySha256 !== digest(bytes) || record.entrySha256 === record.sourceSha256) throw new Error('GENERATIVE_UI_STAGE_PROTECTION')
    } else if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw new Error('GENERATIVE_UI_STAGE_INTEGRITY: ' + relative)
  }
  for (const required of ['agent-generative-ui.js', 'agent-ui-vendor.js', 'agent-generative-ui.css']) if (!known.has(required)) throw new Error('GENERATIVE_UI_STAGE_MISSING: ' + required)
  if (build.tools && build.tools.cesium) {
    if (!known.has('agent-ui-cesium.js')) throw new Error('GENERATIVE_UI_STAGE_MISSING: agent-ui-cesium.js')
    for (let index = 0; index < 28; index++) {
      const asset = 'cesium/Assets/IAU2006_XYS/IAU2006_XYS_' + index + '.json'
      if (!known.has(asset)) throw new Error('GENERATIVE_UI_STAGE_MISSING: ' + asset)
    }
  }
  for (const pkg of build.packages) {
    if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || typeof pkg.integrity !== 'string' || !pkg.integrity || pkg.folder !== Buffer.from(pkg.name + '@' + pkg.version).toString('hex')) throw new Error('GENERATIVE_UI_STAGE_PACKAGE')
    const prefix = 'licenses/' + pkg.folder + '/'
    if (![...known].some(name => name.startsWith(prefix) && /\/(?:licen[cs]e|copying)(?:\.[\w-]+)?$/i.test(name))) throw new Error('GENERATIVE_UI_STAGE_LICENSE: ' + pkg.name)
  }
  return { reportSha256: digest(reportBytes), packages: build.packages.length, vendorSha256: build.files.find(item => item.path === 'agent-ui-vendor.js').sha256 }
}
module.exports = { REPORT, APP, VENDOR, CSS, CESIUM, destination, exists, verify }
