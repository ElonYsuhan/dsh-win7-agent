'use strict'

// Isolated service entry: normal production profile, disposable home only.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const home = path.resolve(process.argv[2] || '')
const tempRoot = fs.realpathSync(os.tmpdir())
assert(fs.realpathSync(home).startsWith(tempRoot + path.sep), 'test service home must be a disposable temp child')
assert.strictEqual(fs.readFileSync(path.join(home, 'generative-ui-test-only'), 'utf8'), 'isolated test\n')
assert.strictEqual(path.resolve(process.env.AGENT_HOME || ''), home)
require('../../server/index.js')
