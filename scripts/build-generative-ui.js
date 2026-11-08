'use strict'

// Build-machine-only bundler. Target code is browser JavaScript for Chromium
// 108; the target does not install packages or download resources. Nothing is
// copied into the application until a caller explicitly integrates the output.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const stageManifest = require('./desktop/generative-ui-manifest')
const ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(ROOT, 'ui/generative-ui')
const NODE_MODULES = path.join(ROOT, 'node_modules')
const EXPECTED = Object.freeze({ vue: '3.5.22', 'naive-ui': '2.39.0', echarts: '5.5.1', vite: '5.4.21', '@vitejs/plugin-vue': '5.2.4', typescript: '5.9.3', cesium: '1.104.0' })
const LODASH_ROOT_SHA256 = 'df58ff96c454ca91ace20d20e6af49b354c70dfba7e737adc00cd23e8ff77168'
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
function readPackage(name) { return JSON.parse(fs.readFileSync(path.join(NODE_MODULES, ...name.split('/'), 'package.json'), 'utf8')) }
function verifyPinned() {
  const lock = require('../package-lock.json')
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const actual = readPackage(name)
    const entry = lock.packages['node_modules/' + name]
    if (actual.version !== expected || !entry || entry.version !== expected || !entry.integrity) throw new Error('GENERATIVE_UI_PACKAGE_VERSION: ' + name)
  }
}
function readCesiumAssets() {
  if (readPackage('@cesium/engine').version !== '2.2.0') throw new Error('GENERATIVE_UI_CESIUM_ENGINE_VERSION')
  return Array.from({ length: 28 }, (_, index) => {
    const suffix = 'Assets/IAU2006_XYS/IAU2006_XYS_' + index + '.json'
    const source = 'node_modules/@cesium/engine/Source/' + suffix
    return { path: 'cesium/' + suffix, data: fs.readFileSync(path.join(ROOT, source)), source }
  })
}
function packageRoot(moduleId) {
  const file = moduleId.split('?')[0]
  if (!path.isAbsolute(file) || !file.startsWith(NODE_MODULES + path.sep)) return null
  let dir = path.dirname(file)
  while (dir.startsWith(NODE_MODULES + path.sep)) {
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      const info = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (typeof info.name === 'string' && typeof info.version === 'string') return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error('GENERATIVE_UI_MODULE_WITHOUT_PACKAGE: ' + moduleId)
}
function licenseCollector(used, renderedModules) {
  return {
    name: 'agent-gui-licenses',
    generateBundle(_options, bundle) {
      // Rollup may resolve modules which it later completely tree-shakes. Only
      // packages with code actually rendered into a chunk are distributed.
      // A nonempty module's side effects also count, even without exports.
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, details] of Object.entries(output.modules)) {
          if (details.renderedLength <= 0) continue
          const directory = packageRoot(id)
          if (directory) {
            used.add(directory)
            if (renderedModules) renderedModules.add(id.split('?')[0])
          }
        }
      }
    }
  }
}
// All actually bundled transitive packages must match the lockfile, not just
// the six top-level build tools. Lock integrity identifies the npm artifact;
// individual rendered-source hashes below record the installed build inputs.
function verifyRenderedPackages(directories) {
  const lock = require('../package-lock.json'), entries = new Map(), seen = new Map()
  for (const directory of directories) {
    const relative = path.relative(ROOT, directory).split(path.sep).join('/')
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const entry = lock.packages[relative]
    if (!relative.startsWith('node_modules/') || !entry || entry.version !== metadata.version || typeof entry.integrity !== 'string' || !entry.integrity) throw new Error('GENERATIVE_UI_TRANSITIVE_VERSION: ' + relative)
    const key = metadata.name + '@' + metadata.version
    if (seen.has(key) && seen.get(key) !== entry.integrity) throw new Error('GENERATIVE_UI_TRANSITIVE_INTEGRITY: ' + key)
    seen.set(key, entry.integrity)
    entries.set(directory, entry.integrity)
  }
  return entries
}
function renderedSourceHashes(modules) {
  return [...modules].sort().map(file => ({ path: path.relative(ROOT, file).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(file)) }))
}
// lodash-es detects unknown JS hosts with Function('return this'). The UI
// target is a Chromium renderer with `self`, so fail closed outside known
// browser/Node globals rather than carrying an unsafe-eval fallback. Apply only
// to the exact pinned, hashed upstream file; never modify node_modules itself.
function lodashCspPlugin(transforms) {
  const target = path.join(NODE_MODULES, 'lodash-es', '_root.js')
  const before = "var root = freeGlobal || freeSelf || Function('return this')();"
  const after = "var root = freeGlobal || freeSelf;\nif (!root) throw new Error('GENERATIVE_UI_GLOBAL_UNAVAILABLE');"
  return {
    name: 'agent-gui-lodash-csp',
    enforce: 'pre',
    transform(code, id) {
      if (path.resolve(id.split('?')[0]) !== target) return null
      const manifest = readPackage('lodash-es')
      if (manifest.version !== '4.18.1' || sha256(code) !== LODASH_ROOT_SHA256 || code.split(before).length !== 2) throw new Error('GENERATIVE_UI_CSP_TRANSFORM_MISMATCH: lodash-es/_root.js')
      const result = code.replace(before, after)
      transforms.push({ package: 'lodash-es', version: manifest.version, path: '_root.js', inputSha256: LODASH_ROOT_SHA256, outputSha256: sha256(result), reason: 'remove unsafe-eval global fallback for the Chromium renderer' })
      return { code: result, map: null }
    }
  }
}
// This check catches direct eval, Function constructors and dynamic imports in
// the generated code. CSP remains the runtime enforcement; this static check
// does not claim to detect every conceivable indirect evaluation technique.
function assertNoDynamicExecution(buffer, label) {
  const ts = require('typescript')
  const tree = ts.createSourceFile(label, buffer.toString('utf8'), ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS)
  if (tree.parseDiagnostics.length) throw new Error('GENERATIVE_UI_BUNDLE_PARSE: ' + label)
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let expression = node.expression
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression
      let name = ''
      if (ts.isIdentifier(expression)) name = expression.text
      else if (ts.isPropertyAccessExpression(expression)) name = expression.name.text
      else if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) name = expression.argumentExpression.text
      if (expression.kind === ts.SyntaxKind.ImportKeyword || name === 'eval' || name === 'Function') throw new Error('GENERATIVE_UI_DYNAMIC_CODE: ' + label + ' ' + (name || 'import'))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}
function notices(directories) {
  const output = [], seen = new Set(), missing = []
  for (const directory of [...directories].sort()) {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const key = metadata.name + '@' + metadata.version
    let license = metadata.license || 'unknown'
    if (seen.has(key)) continue
    seen.add(key)
    const files = fs.readdirSync(directory).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.[\w-]+)?$/i.test(name)).sort()
    const documents = []
    for (const name of files) {
      const file = path.join(directory, name)
      if (fs.statSync(file).isFile()) documents.push({ name, content: fs.readFileSync(file) })
    }
    if (!documents.some(item => /^(?:licen[cs]e|copying)/i.test(item.name))) {
      const fallback = path.join(SOURCE, 'licenses', metadata.name + '-' + metadata.version)
      if (!fs.existsSync(path.join(fallback, 'source.json'))) { missing.push(key); continue }
      const source = JSON.parse(fs.readFileSync(path.join(fallback, 'source.json'), 'utf8'))
      const content = fs.readFileSync(path.join(fallback, 'LICENSE'))
      const lock = require('../package-lock.json')
      const lockEntry = lock.packages[path.relative(ROOT, directory).split(path.sep).join('/')]
      if (source.package !== metadata.name || source.version !== metadata.version || sha256(content) !== source.licenseSha256 || !lockEntry || lockEntry.integrity !== source.npmIntegrity) throw new Error('GENERATIVE_UI_LICENSE_FALLBACK_INTEGRITY: ' + key)
      if (source.license !== undefined) {
        if (typeof source.license !== 'string' || !source.license.trim() || source.license.length > 160) throw new Error('GENERATIVE_UI_LICENSE_FALLBACK_INTEGRITY: ' + key)
        license = source.license
      }
      documents.push({ name: 'LICENSE', content }, { name: 'source.json', content: Buffer.from(JSON.stringify(source, null, 2) + '\n') })
    }
    output.push({ name: metadata.name, version: metadata.version, license, folder: Buffer.from(key).toString('hex'), documents })
  }
  if (missing.length) throw new Error('GENERATIVE_UI_LICENSE_MISSING: ' + missing.join(', '))
  return output
}
function extract(result, expectedJs, cssRequired, allowedExternals = []) {
  const groups = Array.isArray(result) ? result : [result]
  const outputs = groups.flatMap(group => group.output)
  const js = outputs.filter(item => item.type === 'chunk')
  const assets = outputs.filter(item => item.type === 'asset')
  if (js.length !== 1 || js[0].fileName !== expectedJs || js[0].map || js[0].imports.some(name => !allowedExternals.includes(name)) || js[0].dynamicImports.length) throw new Error('GENERATIVE_UI_BUNDLE_LAYOUT: ' + expectedJs + ' ' + JSON.stringify(js.map(item => ({ fileName: item.fileName, imports: item.imports, dynamicImports: item.dynamicImports, map: !!item.map }))))
  const css = assets.filter(item => item.fileName.endsWith('.css'))
  if (assets.length !== css.length || (cssRequired ? css.length !== 1 : css.length !== 0)) throw new Error('GENERATIVE_UI_BUNDLE_ASSETS: ' + expectedJs)
  return { js: Buffer.from(js[0].code), css: css.length ? Buffer.from(css[0].source) : null }
}
function sourceFiles() {
  const result = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && (/\.(?:ts|vue|json)$/.test(entry.name) || entry.name === 'LICENSE')) result.push({ path: path.relative(ROOT, file).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(file)) })
    }
  }
  walk(SOURCE)
  for (const relative of ['src/main/contracts/generative-ui.js', 'src/main/contracts/generative-ui-interaction.js', 'src/renderer/workflow-auto-layout.js', 'src/renderer/workflow-link-routing.js', 'scripts/build-generative-ui.js', 'scripts/desktop/generative-ui-manifest.js', 'scripts/desktop/source-protection.js', 'package.json', 'package-lock.json']) {
    const file = path.join(ROOT, relative)
    result.push({ path: relative, sha256: sha256(fs.readFileSync(file)) })
  }
  return result
}
// Compile to memory only. The result is deliberately not a distributable build:
// build() must still validate every third-party license before writing anything.
// Isolated browser tests may use these buffers without publishing them.
async function compileBrowserBundles() {
  verifyPinned()
  const vite = await import('vite')
  const vuePlugin = (await import('@vitejs/plugin-vue')).default
  const used = new Set(), renderedModules = new Set(), transforms = []
  const shared = {
    root: ROOT, configFile: false, logLevel: 'warn', clearScreen: false, mode: 'production',
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' }
  }
  const commonBuild = { write: false, target: 'chrome108', minify: 'esbuild', sourcemap: false, cssCodeSplit: false, reportCompressedSize: false }
  const vendor = extract(await vite.build({
    ...shared,
    resolve: { alias: { vue: path.join(NODE_MODULES, 'vue/dist/vue.runtime.esm-bundler.js') } },
    plugins: [lodashCspPlugin(transforms), licenseCollector(used, renderedModules)],
    build: { ...commonBuild, lib: { entry: path.join(SOURCE, 'vendor.ts'), name: 'AgentUIVendor', formats: ['iife'], fileName: () => 'agent-ui-vendor.js' } }
  }), 'agent-ui-vendor.js', false)
  const cesium = extract(await vite.build({
    ...shared,
    define: { ...shared.define, CESIUM_BASE_URL: JSON.stringify('vendor/generative-ui/') },
    plugins: [licenseCollector(used, renderedModules)],
    build: { ...commonBuild, lib: { entry: path.join(SOURCE, 'cesium.ts'), name: 'AgentUICesium', formats: ['iife'], fileName: () => 'agent-ui-cesium.js' } }
  }), 'agent-ui-cesium.js', false)
  const globals = { vue: 'AgentUIVendor.vue', 'naive-ui': 'AgentUIVendor.naive', 'echarts/core': 'AgentUIVendor.echartsCore', 'echarts/charts': 'AgentUIVendor.echartsCharts', 'echarts/components': 'AgentUIVendor.echartsComponents', 'echarts/renderers': 'AgentUIVendor.echartsRenderers' }
  const app = extract(await vite.build({
    ...shared,
    plugins: [vuePlugin(), licenseCollector(used, renderedModules)],
    build: {
      ...commonBuild,
      commonjsOptions: { include: [/node_modules/, /[\\/]src[\\/]main[\\/]contracts[\\/]generative-ui(?:-interaction)?\.js$/, /[\\/]src[\\/]renderer[\\/]workflow-(?:auto-layout|link-routing)\.js$/] },
      lib: { entry: path.join(SOURCE, 'src/index.ts'), name: 'AgentGenerativeUI', formats: ['iife'], fileName: () => 'agent-generative-ui.js' },
      rollupOptions: { external: Object.keys(globals), output: { globals, assetFileNames: 'agent-generative-ui[extname]' } }
    }
  }), 'agent-generative-ui.js', true, Object.keys(globals))
  assertNoDynamicExecution(vendor.js, 'agent-ui-vendor.js')
  assertNoDynamicExecution(app.js, 'agent-generative-ui.js')
  assertNoDynamicExecution(cesium.js, 'agent-ui-cesium.js')
  const integrity = verifyRenderedPackages(used), cesiumAssets = readCesiumAssets()
  const dependencySources = renderedSourceHashes(renderedModules).concat(cesiumAssets.map(item => ({ path: item.source, sha256: sha256(item.data) })))
  const assets = cesiumAssets.map(item => ({ path: item.path.slice('cesium/'.length), data: item.data }))
  return { vendor, cesium, assets, cesiumAssets, app, used, transforms, integrity, dependencySources }
}
async function build(outputDirectory) {
  verifyPinned()
  const out = path.resolve(outputDirectory || '')
  if (!outputDirectory || !fs.existsSync(out) || !fs.statSync(out).isDirectory() || fs.readdirSync(out).length) throw new Error('GENERATIVE_UI_EMPTY_OUTPUT_REQUIRED')
  const { vendor, cesium, cesiumAssets, app, used, transforms, integrity, dependencySources } = await compileBrowserBundles()
  const packages = notices(used)
  const blobs = [
    { path: 'agent-ui-vendor.js', data: vendor.js },
    { path: 'agent-ui-cesium.js', data: cesium.js },
    { path: 'agent-generative-ui.js', data: app.js },
    { path: 'agent-generative-ui.css', data: app.css },
    ...cesiumAssets
  ]
  for (const pkg of packages) for (const doc of pkg.documents) blobs.push({ path: 'licenses/' + pkg.folder + '/' + doc.name, data: doc.content })
  const files = blobs.map(item => ({ path: item.path, size: item.data.length, sha256: sha256(item.data) }))
  const packageIntegrities = new Map([...used].map(directory => { const info = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); return [info.name + '@' + info.version, integrity.get(directory)] }))
  const report = { formatVersion: 1, runtime: { electron: '22.3.27', node: '16.17.1', chromium: '108' }, tools: EXPECTED, sources: sourceFiles(), dependencySources, transforms, packages: packages.map(({ name, version, license, folder }) => ({ name, version, license, folder, integrity: packageIntegrities.get(name + '@' + version) })), files }
  for (const blob of blobs) { const dest = path.join(out, blob.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, blob.data, { flag: 'wx' }) }
  fs.writeFileSync(path.join(out, 'generative-ui-build.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  return report
}
// Stage only generated assets and licenses. The manifest explicitly describes
// pre-protection hashes; source-protection.json later binds it and records the
// transformed app bundle separately. Never stage raw TS/Vue sources.
async function stageApp(appDir) {
  const renderer = path.join(appDir, 'src', 'renderer')
  const ownedDirectories = [path.join(renderer, 'generative-ui'), path.join(renderer, 'vendor', 'generative-ui'), path.join(appDir, 'third-party', 'generative-ui')]
  if (!fs.existsSync(renderer) || !fs.statSync(renderer).isDirectory() || stageManifest.exists(appDir) || ownedDirectories.some(dir => fs.existsSync(dir))) throw new Error('GENERATIVE_UI_STAGE_DESTINATION')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gui-stage-'))
  try {
    const report = await build(temporary)
    for (const item of report.files) {
      const dest = path.join(appDir, ...stageManifest.destination(item.path).split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(path.join(temporary, ...item.path.split('/')), dest, fs.constants.COPYFILE_EXCL)
    }
    const manifest = path.join(appDir, ...stageManifest.REPORT.split('/'))
    fs.mkdirSync(path.dirname(manifest), { recursive: true })
    fs.writeFileSync(manifest, JSON.stringify({ formatVersion: 1, phase: 'before-agent-source-v1', build: report }, null, 2) + '\n', { flag: 'wx' })
    stageManifest.verify(appDir)
    return report
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
if (require.main === module) {
  build(process.argv[2]).then(report => console.log('Generative UI browser bundles built: ' + report.packages.length + ' licensed packages'))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { build, stageApp, verifyPinned, verifyRenderedPackages, notices, sourceFiles, compileBrowserBundles, licenseCollector, lodashCspPlugin, assertNoDynamicExecution }
