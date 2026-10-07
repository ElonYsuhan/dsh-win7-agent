'use strict'

// Static guard for the Windows 7 compatibility constraint.
// Target runtime: Electron 22.3.27 (Node 16.17.1, Chromium 108).
// See docs/WIN7-COMPAT.md.
//
// Add `// win7-exempt` on a line to skip it.

const fs = require('fs')
const path = require('path')

const not = (value) => value ? false : true

const ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = ['node_modules', '.git', 'release', 'dist', 'assets', 'sessions', 'vendor', 'md-skills']
const EXEMPT = 'win7-exempt'

const NODE_DIRS = ['src/main', 'server', 'scripts', 'plugins']
const NODE_FILES = ['shell/main.js', 'shell/preload.js', 'shell/service-manager.js', 'shell/installer.js', 'shell/menu.js']
const RENDERER_DIRS = ['src/renderer']
const RENDERER_FILES = ['shell/settings.js', 'shell/offline.js', 'shell/loading.js', 'shell/update.js']
const CSS_DIRS = ['src/renderer', 'shell', 'server']

// Present in Chromium 108 but NOT in Node 16.17 -> forbidden in Node-side code.
const NODE_PATTERNS = [
  { id: 'global fetch() - Node 18+', re: /(?<![\w.$])fetch\s*\(/ }, // win7-exempt
  { id: 'structuredClone - Node 17+ (main process)', re: /(?<![\w.$])structuredClone\s*\(/ },
  { id: 'AbortSignal.timeout - Node 17.3+', re: /AbortSignal\s*\.\s*timeout/ }, // win7-exempt
  { id: 'Array.prototype.findLast - Node 18+', re: /\.findLast\s*\(/ },
  { id: 'Array.prototype.findLastIndex - Node 18+', re: /\.findLastIndex\s*\(/ },
  { id: 'Array.prototype.toSorted - Node 20+', re: /\.toSorted\s*\(/ },
  { id: 'Array.prototype.toReversed - Node 20+', re: /\.toReversed\s*\(/ },
  { id: 'Array.prototype.with - Node 20+', re: /\.with\s*\(/ },
  { id: 'Object.groupBy - Node 21+', re: /Object\s*\.\s*groupBy\s*\(/ },
  { id: 'Array.fromAsync - Node 22+', re: /Array\s*\.\s*fromAsync\s*\(/ },
  { id: 'Promise.withResolvers - Node 22+', re: /Promise\s*\.\s*withResolvers\s*\(/ },
  { id: 'node:test - Node 18+', re: /require\(\s*['"]node:test['"]\s*\)/ },
  { id: 'import.meta.dirname - Node 20.11+', re: /import\s*\.\s*meta\s*\.\s*dirname/ }, // win7-exempt
  { id: 'fs.cp / fs.promises.cp', re: /fs\s*\.\s*(promises\s*\.\s*)?cp\s*\(/ }
]

// CSS not implemented in Chromium 108.
const CSS_PATTERNS = [
  { id: 'color-mix() - Chromium 111+', re: /color-mix\s*\(/i },
  { id: 'oklch() - Chromium 111+', re: /oklch\s*\(/i },
  { id: 'oklab() - Chromium 111+', re: /oklab\s*\(/i },
  { id: 'lab()/lch() - Chromium 111+', re: /(?:^|[^\w-])(?:lab|lch)\s*\(/i },
  { id: 'text-wrap: balance|pretty - Chromium 114+', re: /text-wrap\s*:\s*(balance|pretty)/i },
  { id: 'light-dark() - Chromium 123+', re: /light-dark\s*\(/i },
  { id: '@scope - Chromium 118+', re: /@scope\b/i },
  { id: 'subgrid - Chromium 117+', re: /grid-template[\w-]*\s*:[^;]*\bsubgrid\b/i },
  { id: 'popover - Chromium 114+', re: /(?::popover-open|\bpopover\s*=)/i },
  { id: '@starting-style - Chromium 117+', re: /@starting-style/i },
  { id: 'view transitions - Chromium 111+', re: /view-transition|::view-transition/i },
  { id: 'field-sizing - Chromium 123+', re: /field-sizing\s*:/i },
  { id: 'round()/mod()/rem() - Chromium 125+', re: /(?:^|[^\w-])(?:round|mod|rem)\s*\(\s*(?:[\d.]|\bfrom\b|var\()/i }
]

// Intranet hard rule: the product must run fully offline.
// Client-side files must not reference any internet host
// (allow loopback and the SVG xmlns namespace, which is not a network fetch).
const OFFLINE_PATTERNS = [
  { id: 'external http(s) reference - intranet build must not load internet resources', re: /https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/ }
]

function walk(root, dirs, files, extensions) {
  const out = []
  const push = (target) => {
    const full = path.join(ROOT, target)
    if (not(fs.existsSync(full))) return
    const stat = fs.statSync(full)
    if (stat.isFile()) {
      if (hasExtension(full, extensions)) out.push(full)
      return
    }
    const stack = [full]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch (error) {
        continue
      }
      for (const entry of entries) {
        if (SKIP_DIRS.indexOf(entry.name) >= 0) continue
        const next = path.join(current, entry.name)
        if (entry.isDirectory()) stack.push(next)
        else if (entry.isFile() && hasExtension(next, extensions)) out.push(next)
      }
    }
  }
  for (const dir of dirs) push(dir)
  for (const file of files) push(file)
  return out
}

function hasExtension(file, extensions) {
  for (const extension of extensions) {
    if (file.endsWith(extension)) return true
  }
  return false
}

function label(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function scan(file, patterns) {
  const findings = []
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch (error) {
    return findings
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.indexOf(EXEMPT) >= 0) continue
    for (const pattern of patterns) {
      if (pattern.re.test(line)) {
        findings.push({
          file: label(file),
          line: index + 1,
          rule: pattern.id,
          text: line.trim().slice(0, 120)
        })
      }
    }
  }
  return findings
}

function checkScrollbarFallback(cssFile) {
  let text
  try {
    text = fs.readFileSync(cssFile, 'utf8')
  } catch (error) {
    return null
  }
  if (!/scrollbar-(width|color)\s*:/i.test(text)) return null
  if (/::-webkit-scrollbar/.test(text)) return null
  return {
    file: label(cssFile),
    line: 0,
    rule: 'scrollbar-width/color without ::-webkit-scrollbar fallback (ignored on Chromium 108)',
    text: 'add ::-webkit-scrollbar rules in the same file'
  }
}

function main() {
  const nodeFiles = walk(ROOT, NODE_DIRS, NODE_FILES, ['.js'])
  const rendererFiles = walk(ROOT, RENDERER_DIRS, RENDERER_FILES, ['.js'])
  const cssFiles = walk(ROOT, CSS_DIRS, [], ['.css'])

  const errors = []
  for (const file of nodeFiles) errors.push(...scan(file, NODE_PATTERNS))
  for (const file of rendererFiles) errors.push(...scan(file, []))
  for (const file of cssFiles) errors.push(...scan(file, CSS_PATTERNS))

  // Intranet rule: client-side files must not load internet resources.
  const clientFiles = walk(ROOT, ['src/renderer', 'shell'], [], ['.js', '.html', '.css'])
  for (const file of clientFiles) errors.push(...scan(file, OFFLINE_PATTERNS))

  // 新增 shell/*.js 却忘了登记的话，它会完全逃过上面的扫描（这两个清单是白名单），
  // 所以这里反过来对账一次，逼着人补清单。
  const listed = NODE_FILES.concat(RENDERER_FILES)
  if (fs.existsSync(path.join(ROOT, 'shell'))) {
    for (const entry of fs.readdirSync(path.join(ROOT, 'shell'), { withFileTypes: true })) {
      if (not(entry.isFile()) || not(entry.name.endsWith('.js'))) continue
      const relative = 'shell/' + entry.name
      if (listed.indexOf(relative) < 0) {
        errors.push({
          file: relative,
          line: 1,
          rule: 'shell 脚本未登记进兼容性扫描清单',
          text: '把 ' + relative + ' 补进 NODE_FILES 或 RENDERER_FILES'
        })
      }
    }
  }

  const warnings = []
  for (const file of cssFiles) {
    const finding = checkScrollbarFallback(file)
    if (finding) warnings.push(finding)
  }

  console.log('win7 compatibility target: electron 22.3.27 / node 16.17.1 / chromium 108')
  console.log('scanned: ' + nodeFiles.length + ' node-side js, ' + rendererFiles.length +
    ' renderer js, ' + cssFiles.length + ' css')

  if (warnings.length > 0) {
    console.log('')
    console.log('warnings (' + warnings.length + ')')
    for (const item of warnings) {
      console.log('  ' + item.file + ': ' + item.rule)
    }
  }

  if (errors.length > 0) {
    console.log('')
    console.error('blocked api usage (' + errors.length + ')')
    for (const item of errors) {
      console.error('  ' + item.file + ':' + item.line + '  ' + item.rule)
      console.error('    ' + item.text)
    }
    console.error('')
    console.error('These do not exist on the Windows 7 target runtime. See docs/WIN7-COMPAT.md.')
    process.exit(1)
  }

  console.log('')
  console.log('no blocked api usage found')
}

main()
