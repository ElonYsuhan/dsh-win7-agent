'use strict'

// 生成固定版本、可跨源加载的 AgentPanel ESM 入口与清单。
// 只使用 Node 内置模块；不引入构建依赖。
// 用法：
//   node scripts/build-agent-panel.js          生成到 service/panel/<version>/
//   node scripts/build-agent-panel.js --check  校验已生成文件与清单一致

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src/panel')
const OUT = path.join(ROOT, 'service/panel')
const manifestSource = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'))
const version = manifestSource.version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('PANEL_VERSION_INVALID')
const target = path.join(OUT, version)

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function wrapper(name, source, picks) {
  return `  const ${name} = (function () {\n    const window = {}\n${source}\n    return ${picks}\n  })()`
}

function bundle() {
  const markdown = fs.readFileSync(path.join(ROOT, 'src/renderer/markdown.js'), 'utf8')
  const highlight = fs.readFileSync(path.join(ROOT, 'src/renderer/highlight.js'), 'utf8')
  const css = fs.readFileSync(path.join(SRC, 'panel.css'), 'utf8')
  const panel = fs.readFileSync(path.join(SRC, 'agent-panel.js'), 'utf8')
  const header = [
    '/* AgentPanel ' + version + ' — 由 scripts/build-agent-panel.js 生成，请勿手改。 */',
    'const __agentPanelRenderers = (function () {',
    wrapper('markdown', markdown, 'window.renderMarkdown'),
    wrapper('highlight', highlight, 'window'),
    '  return Object.freeze({ renderMarkdown: markdown, highlightAll: highlight.highlightAll })',
    '})()',
    'const { renderMarkdown, highlightAll } = __agentPanelRenderers',
    'const VERSION = ' + JSON.stringify(version),
    'const PANEL_CSS = ' + JSON.stringify(css),
    ''
  ].join('\n')
  const footer = [
    '',
    'export { AgentPanelElement, AgentPanel, defineAgentPanel }',
    'export const version = VERSION',
    'export default AgentPanel',
    ''
  ].join('\n')
  return header + panel + footer
}

function built() {
  return {
    'agent-panel.js': Buffer.from(bundle(), 'utf8'),
    'host-storage.js': Buffer.from(fs.readFileSync(path.join(SRC, 'host-storage.js'), 'utf8'), 'utf8')
  }
}

function manifestFor(files) {
  return {
    name: manifestSource.name,
    version,
    description: manifestSource.description,
    entry: manifestSource.entry,
    module: 'esm',
    dependencies: manifestSource.dependencies,
    runtime: manifestSource.runtime,
    entryUrlPath: '/panel/' + version + '/' + manifestSource.entry,
    files: Object.keys(files).sort().map(name => ({ path: name, bytes: files[name].length, sha256: sha256(files[name]) }))
  }
}

function run(checkOnly) {
  const files = built()
  const source = files['agent-panel.js'].toString('utf8')
  const forbidden = ['indexedDB', 'localStorage', 'sessionStorage', 'document.cookie', '<iframe', 'iframe', 'web-bridge', 'electron']
  for (const token of forbidden) {
    if (source.includes(token)) throw Error('PANEL_BUNDLE_FORBIDDEN_REFERENCE: ' + token)
  }
  const manifestText = JSON.stringify(manifestFor(files), null, 2) + '\n'
  if (checkOnly) {
    for (const name of Object.keys(files)) {
      const file = path.join(target, name)
      if (!fs.existsSync(file)) throw Error('PANEL_BUILD_MISSING: ' + file)
      if (!fs.readFileSync(file).equals(files[name])) throw Error('PANEL_BUILD_STALE: ' + file)
    }
    const manifestFile = path.join(target, 'manifest.json')
    if (!fs.existsSync(manifestFile)) throw Error('PANEL_MANIFEST_MISSING')
    if (fs.readFileSync(manifestFile, 'utf8') !== manifestText) throw Error('PANEL_MANIFEST_STALE')
    console.log('AgentPanel ' + version + ' 产物与清单一致')
    return
  }
  fs.mkdirSync(target, { recursive: true })
  for (const name of Object.keys(files)) fs.writeFileSync(path.join(target, name), files[name])
  fs.writeFileSync(path.join(target, 'manifest.json'), manifestText)
  for (const entry of manifestFor(files).files) console.log(entry.sha256 + '  ' + entry.path)
  console.log('AgentPanel ' + version + ' 已生成：' + path.relative(ROOT, target))
}

module.exports = { run, version }
if (require.main === module) run(process.argv.includes('--check'))
