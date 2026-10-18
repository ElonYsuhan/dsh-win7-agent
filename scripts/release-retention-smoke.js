'use strict'
const assert = require('assert')
const { plan } = require('./release-retention')
const entries = ['Agent-mac-arm64-0.3.9.zip', 'Agent-mac-arm64-0.3.10.zip', 'Agent-mac-arm64-0.3.9', 'Agent-mac-arm64-0.3.10', 'Agent-win-x64-0.3.8.zip', 'Agent-win-x64-0.3.8', 'Agent-linux-x64-0.3.11', 'personal-notes']
assert.deepStrictEqual(plan(entries, 'mac-arm64', []), ['Agent-mac-arm64-0.3.9.zip', 'Agent-mac-arm64-0.3.9', 'Agent-win-x64-0.3.8'])
assert(!plan(entries, 'mac-arm64', ['Agent-mac-arm64-0.3.9']).includes('Agent-mac-arm64-0.3.9'))
assert.deepStrictEqual(plan(entries, 'mac-arm64', null), ['Agent-mac-arm64-0.3.9.zip'])
assert.deepStrictEqual(plan(['Agent-mac-arm64-0.4.0', 'Agent-mac-arm64-0.3.10.zip'], 'mac-arm64', []), [])
console.log('release retention: numeric version, active process, incomplete build, unknown entries passed')
