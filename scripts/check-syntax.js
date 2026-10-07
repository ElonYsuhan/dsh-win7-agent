'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const not = (value) => value ? false : true

const ROOT = path.resolve(__dirname, '..')
const SCAN_DIRS = ['src', 'server', 'shell', 'plugins', 'scripts']
const SKIP_DIRS = ['node_modules', '.git', 'release', 'dist', 'assets', 'sessions']

function walk(dir, out) {
  if (not(fs.existsSync(dir))) return out
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP_DIRS.indexOf(entry.name) >= 0) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && full.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

function label(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function main() {
  const files = []
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), files)
  files.sort()

  const failed = []
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      const error = String(result.stderr || result.stdout || '').trim()
      failed.push({ file, error })
    }
  }

  if (failed.length > 0) {
    console.error('syntax check FAILED: ' + failed.length + ' of ' + files.length + ' files')
    for (const item of failed) {
      console.error('  ' + label(item.file))
      console.error('    ' + item.error.split('\n').slice(0, 3).join('\n    '))
    }
    process.exit(1)
  }

  console.log('syntax OK: ' + files.length + ' files, node ' + process.versions.node)
}

main()
