'use strict'

// Explicit maintenance command. Normal builds and target machines never install
// packages or access the network: the generated bundle is committed under src/.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const root = path.resolve(__dirname, '..')
const build = path.resolve(process.argv[2] || path.join(__dirname, 'cordis-vendor'))
const modules = path.join(build, 'node_modules')
const output = path.join(root, 'src', 'main', 'runtime', 'vendor', 'cordis')
const esbuild = require(path.join(modules, 'esbuild'))
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'cordis-vendor', 'package-lock.json'), 'utf8'))
for (const name of ['cordis', 'cosmokit', 'esbuild']) {
  const actual = require(path.join(modules, name, 'package.json')).version
  const expected = lock.packages['node_modules/' + name].version
  if (actual !== expected) throw new Error('VENDOR_VERSION_MISMATCH: ' + name)
}
esbuild.buildSync({
  absWorkingDir: build,
  stdin: { contents: "export * from 'cordis'", resolveDir: build, sourcefile: 'cordis-entry.js' },
  bundle: true, platform: 'node', target: 'node16.17', format: 'cjs',
  legalComments: 'inline', outfile: path.join(output, 'index.js')
})
const manifest = {
  name: 'cordis', version: '4.0.0-rc.11', target: 'node16.17', format: 'cjs',
  repository: 'https://github.com/cordiverse/cordis',
  packages: Object.fromEntries(['cordis', 'cosmokit'].map((name) => {
    const entry = lock.packages['node_modules/' + name]
    return [name, { version: entry.version, integrity: entry.integrity, license: entry.license }]
  })),
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(output, 'index.js'))).digest('hex')
}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('Bundled Cordis ' + manifest.version + ' for ' + manifest.target + ': ' + manifest.sha256)
