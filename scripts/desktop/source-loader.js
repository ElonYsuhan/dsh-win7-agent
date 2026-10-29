'use strict'
// Build template. The key is replaced in the staging tree only. An offline
// client necessarily carries decryption capability; this is not a trust boundary.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const key = Buffer.from('__AGENT_SOURCE_KEY__', 'base64')
const magic = Buffer.from('AGENTP1\0')
const publicKey = Buffer.from('__AGENT_RELEASE_PUBLIC_KEY__', 'base64').toString('utf8')
const manifestFile = path.join(__dirname, 'code-integrity.json')
if (fs.statSync(manifestFile).size > 2 * 1024 * 1024) throw Error('CODE_MANIFEST_SIZE')
const envelope = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
const signed = Buffer.from(envelope.payload, 'base64')
if (envelope.version !== 1 || !crypto.verify(null, signed, publicKey, Buffer.from(envelope.signature, 'base64'))) throw Error('CODE_MANIFEST_SIGNATURE')
const manifest = JSON.parse(signed.toString('utf8'))
if (manifest.version !== 1 || manifest.product !== 'dsh-agent-code' || !manifest.entries) throw Error('CODE_MANIFEST_FORMAT')
function verifyFile(filename, supplied) {
  const relative = path.relative(__dirname, filename).split(path.sep).join('/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw Error('CODE_FILE_PATH')
  const expected = manifest.entries[relative]
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size > 32 * 1024 * 1024) throw Error('CODE_FILE_UNKNOWN: ' + relative)
  // Size check before allocation, and no unverified symlink redirects.
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.size !== expected.size) throw Error('CODE_FILE_INTEGRITY: ' + relative)
  const bytes = supplied || fs.readFileSync(filename)
  if (bytes.length !== expected.size || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw Error('CODE_FILE_INTEGRITY: ' + relative)
  return bytes
}
exports.verifyFile = verifyFile
verifyFile(__filename)
verifyFile(path.join(__dirname, 'package.json'))
// Guard first-party/vendor CommonJS loads. User plugins outside the sealed app
// remain governed by the existing extension/permissions boundary.
const Module = require('module'), original = Module._extensions['.js']
Module._extensions['.js'] = function guarded(mod, filename) {
  const relative = path.relative(__dirname, filename)
  if (relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) verifyFile(filename)
  return original(mod, filename)
}

exports.load = function load(mod, filename) {
  const relative = path.relative(__dirname, filename).split(path.sep).join('/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || mod.filename !== filename) throw Error('SOURCE_MODULE_PATH')
  const file = filename + '.agc', size = fs.statSync(file).size
  if (size < 36 || size > 8 * 1024 * 1024) throw Error('SOURCE_PAYLOAD_SIZE')
  verifyFile(filename)
  const payload = verifyFile(file)
  if (!payload.subarray(0, 8).equals(magic)) throw Error('SOURCE_PAYLOAD_FORMAT')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(8, 20))
  decipher.setAAD(Buffer.from(relative))
  decipher.setAuthTag(payload.subarray(20, 36))
  // Authenticate completely before compiling any module code. No plaintext is
  // written to disk, and normal CommonJS caching owns the compiled module.
  const source = Buffer.concat([decipher.update(payload.subarray(36)), decipher.final()])
  try { mod._compile(source.toString('utf8'), filename) } finally { source.fill(0) }
}
