'use strict'

// Build-machine-only type boundary check. The target runtime never loads
// TypeScript: all checked modules remain CommonJS JavaScript, while new type
// contracts and browser/build declarations are compile-time only.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const root = path.resolve(__dirname, '..')
const configs = ['tsconfig.types.json', 'tsconfig.core.json', 'tsconfig.preload.json', 'tsconfig.renderer.json', 'tsconfig.adapters.json']
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

function files(dir, result = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) files(relative, result)
    else result.push(relative)
  }
  return result
}

for (const config of configs) assert(fs.existsSync(path.join(root, config)), 'missing ' + config)
for (const dir of ['src', 'server', 'shell']) {
  const shipped = files(dir).filter(file => /\.(?:ts|tsx)$/.test(file))
  assert.deepStrictEqual(shipped, [], 'TypeScript sources must not be copied into the target application: ' + shipped.join(', '))
}
const declarations = files('types').filter(file => /\.(?:ts|tsx)$/.test(file))
assert(declarations.length > 0, 'type contracts are missing')
for (const file of declarations.filter(file => !file.includes('/tests/'))) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  assert(!/@ts-ignore|@ts-nocheck/.test(source), 'unexpected type suppression in ' + file)
}
const baseConfig = fs.readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8')
assert(baseConfig.includes('"strict": true'), 'type contracts must remain strict')
assert(baseConfig.includes('"noEmit": true'), 'type contracts must not emit runtime files')

let checked = 0
for (const config of configs) {
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, config)], { cwd: root, encoding: 'utf8', timeout: 120000 })
  const output = String(result.stdout || '') + String(result.stderr || '')
  if (result.error) throw result.error
  assert.strictEqual(result.status, 0, config + ' failed:\n' + output)
  checked += 1
}
console.log('TypeScript core boundaries passed: ' + checked + ' configs; ' + declarations.length + ' declaration/type files; no TS in target paths; Node ' + process.versions.node)
