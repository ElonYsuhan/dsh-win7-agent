'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const vm = require('vm')
const terser = require('terser')
const obfuscator = require('javascript-obfuscator')
const ROOT = path.resolve(__dirname, '../..')
const POLICY = 'agent-source-v1'
const TOOLS = { terser: '5.31.0', 'javascript-obfuscator': '4.1.1' }
const CACHE = path.join(ROOT, 'release/.source-cache', POLICY)
const hash = data => crypto.createHash('sha256').update(data).digest('hex')
const shellBrowser = new Set(['settings.js', 'loading.js', 'offline.js', 'update.js'])
const shellNames = new Set(fs.readdirSync(path.join(ROOT, 'shell')).filter(name => name.endsWith('.js')))
function mode(name) {
  if (name.split('/').some(part => ['vendor', 'md-skills', 'node_modules'].includes(part)) || name.startsWith('plugins/examples/')) return null
  if (name === 'preload.js' || name === 'src/main/preload.js') return 'sandbox'
  if (shellBrowser.has(name) || name.startsWith('src/renderer/') && name.endsWith('.js')) return 'browser'
  if (shellNames.has(name) || name.startsWith('service/') || name.startsWith('src/main/')) return name.endsWith('.js') ? 'node' : null
  return null
}
function files(root) {
  const result = []
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name
      if (entry.isSymbolicLink()) throw Error('SOURCE_UNEXPECTED_LINK: ' + relative)
      if (entry.isDirectory()) {
        if (['vendor', 'md-skills', 'node_modules', 'assets'].includes(entry.name) || relative === 'plugins/examples') continue
        visit(path.join(dir, entry.name), relative + '/')
      } else if (entry.isFile()) result.push(relative)
    }
  }
  visit(root, '')
  return result
}
async function transform(source, kind, cache = true) {
  const digest = hash(JSON.stringify({ policy: POLICY, tools: TOOLS, kind, source }))
  const cached = path.join(CACHE, digest + '.json')
  if (cache && fs.existsSync(cached)) {
    const record = JSON.parse(fs.readFileSync(cached, 'utf8'))
    if (record.sha256 !== hash(record.code)) throw Error('SOURCE_CACHE_INTEGRITY')
    return record.code
  }
  const compact = await terser.minify(source, { ecma: 2020, compress: { passes: 1, directives: false }, mangle: { toplevel: false }, keep_fnames: true, keep_classnames: true, format: { comments: false }, sourceMap: false })
  if (!compact.code) throw Error('SOURCE_EMPTY_OUTPUT')
  const code = obfuscator.obfuscate(compact.code, {
    target: kind === 'browser' ? 'browser-no-eval' : 'node', seed: 724103,
    compact: true, simplify: false, renameGlobals: false, renameProperties: false,
    controlFlowFlattening: false, deadCodeInjection: false, debugProtection: false,
    selfDefending: false, disableConsoleOutput: false, numbersToExpressions: false,
    splitStrings: false, stringArray: kind === 'node', stringArrayThreshold: 0.35,
    stringArrayEncoding: [], stringArrayCallsTransform: false, stringArrayRotate: false,
    stringArrayShuffle: true, identifierNamesGenerator: 'hexadecimal',
    sourceMap: false
  }).getObfuscatedCode()
  new vm.Script(code)
  if (cache) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cached, JSON.stringify({ sha256: hash(code), code })) }
  return code
}
function encrypt(code, key, relative) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(relative))
  const data = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('AGENTP1\0'), iv, cipher.getAuthTag(), data])
}
async function protect(appDir, options = {}) {
  const signingKey = options.signingKey || require('./release-signing').read()
  const publicKey = crypto.createPublicKey(signingKey).export({ type: 'spki', format: 'pem' })
  for (const [tool, version] of Object.entries(TOOLS)) if (require(tool + '/package.json').version !== version) throw Error('SOURCE_TOOL_VERSION: ' + tool)
  if (fs.existsSync(path.join(appDir, 'source-protection.json'))) throw Error('SOURCE_ALREADY_PROTECTED')
  const notices = path.join(appDir, 'source-protection-licenses'); fs.mkdirSync(notices, { recursive: true })
  for (const [tool, name] of [['terser', 'LICENSE'], ['javascript-obfuscator', 'LICENSE.BSD']]) fs.copyFileSync(path.join(path.dirname(require.resolve(tool + '/package.json')), name), path.join(notices, tool + '.txt'))
  const key = crypto.randomBytes(32), records = []
  for (const relative of files(appDir)) {
    if (/\.(?:map|ts|tsx)$/.test(relative) || /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(relative)) { fs.rmSync(path.join(appDir, relative)); continue }
    const kind = mode(relative)
    if (!kind) continue
    const file = path.join(appDir, relative), source = fs.readFileSync(file, 'utf8'), code = await transform(source, kind)
    const record = { path: relative, mode: kind === 'node' ? 'aes-256-gcm' : 'obfuscated', sourceSha256: hash(source), transformedSha256: hash(code) }
    if (kind === 'node') {
      fs.writeFileSync(file + '.agc', encrypt(code, key, relative))
      let loader = path.relative(path.dirname(file), path.join(appDir, 'source-loader.js')).split(path.sep).join('/')
      if (!loader.startsWith('.')) loader = './' + loader
      fs.writeFileSync(file, "'use strict';require(" + JSON.stringify(loader) + ').load(module,__filename);\n')
      record.payloadSha256 = hash(fs.readFileSync(file + '.agc'))
    } else fs.writeFileSync(file, code)
    record.entrySha256 = hash(fs.readFileSync(file)); records.push(record)
  }
  if (!records.some(record => record.path === 'main.js' && record.mode === 'aes-256-gcm') || !records.some(record => record.path === 'service/index.js') || !records.some(record => record.path === 'src/renderer/app.js')) throw Error('SOURCE_PROTECTION_COVERAGE')
  const template = fs.readFileSync(path.join(__dirname, 'source-loader.js'), 'utf8')
  fs.writeFileSync(path.join(appDir, 'source-loader.js'), await transform(template.replace('__AGENT_SOURCE_KEY__', key.toString('base64')).replace('__AGENT_RELEASE_PUBLIC_KEY__', Buffer.from(publicKey).toString('base64')), 'node', false)); key.fill(0)
  const report = { formatVersion: 1, policy: POLICY, tools: TOOLS, runtime: { electron: '22.3.27', node: '16.17.1', chromium: '108' }, loaderSha256: hash(fs.readFileSync(path.join(appDir, 'source-loader.js'))), limitations: 'Offline loader carries extractable key; browser/preload obfuscation is not encryption; no bytecode protection; embedded trust root still requires OS code signing against local patching.', records }
  fs.writeFileSync(path.join(appDir, 'source-protection.json'), JSON.stringify(report, null, 2) + '\n')
  const entries = {}
  function inventory(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), relative = path.relative(appDir, file).split(path.sep).join('/')
      if (entry.isSymbolicLink()) throw Error('SIGNED_UNEXPECTED_LINK')
      if (entry.isDirectory()) inventory(file)
      else if (/\.(?:js|agc|html|css)$/.test(relative) || relative === 'package.json' || relative === 'source-protection.json') {
        const data = fs.readFileSync(file); entries[relative] = { size: data.length, sha256: hash(data) }
      }
    }
  }
  inventory(appDir)
  const payload = Buffer.from(JSON.stringify({ version: 1, product: 'dsh-agent-code', entries }))
  fs.writeFileSync(path.join(appDir, 'code-integrity.json'), JSON.stringify({ version: 1, publicKey, payload: payload.toString('base64'), signature: crypto.sign(null, payload, signingKey).toString('base64') }) + '\n')
  verify(appDir, publicKey)
  return report
}
function verify(appDir, publicKey = require('./release-signing').readPublic()) {
  const report = JSON.parse(fs.readFileSync(path.join(appDir, 'source-protection.json'), 'utf8'))
  if (report.policy !== POLICY || report.formatVersion !== 1 || !report.records.length) throw Error('SOURCE_PROTECTION_MANIFEST')
  if (report.loaderSha256 !== hash(fs.readFileSync(path.join(appDir, 'source-loader.js')))) throw Error('SOURCE_LOADER_INTEGRITY')
  const known = new Set(report.records.map(record => record.path))
  for (const relative of files(appDir)) {
    if (/\.map$/.test(relative)) throw Error('SOURCE_MAP_IN_DELIVERY')
    if (mode(relative) && relative !== 'source-loader.js' && !known.has(relative)) throw Error('SOURCE_UNPROTECTED_FILE: ' + relative)
  }
  for (const record of report.records) {
    const file = path.join(appDir, record.path), entry = fs.readFileSync(file)
    if (hash(entry) !== record.entrySha256 || hash(entry) === record.sourceSha256) throw Error('SOURCE_ENTRY_INTEGRITY: ' + record.path)
    if (record.mode === 'aes-256-gcm' && (hash(fs.readFileSync(file + '.agc')) !== record.payloadSha256 || !entry.toString().includes('.load(module,__filename)'))) throw Error('SOURCE_CIPHER_INTEGRITY: ' + record.path)
  }
  const envelope = JSON.parse(fs.readFileSync(path.join(appDir, 'code-integrity.json'), 'utf8'))
  const signed = Buffer.from(envelope.payload, 'base64')
  if (envelope.publicKey !== publicKey || !crypto.verify(null, signed, publicKey, Buffer.from(envelope.signature, 'base64'))) throw Error('CODE_MANIFEST_SIGNATURE')
  const manifest = JSON.parse(signed.toString('utf8'))
  for (const [relative, expected] of Object.entries(manifest.entries)) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw Error('CODE_MANIFEST_PATH')
    const bytes = fs.readFileSync(path.join(appDir, relative))
    if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw Error('CODE_FILE_INTEGRITY: ' + relative)
  }
  return report
}
module.exports = { protect, verify, transform, encrypt, mode, POLICY, TOOLS }
