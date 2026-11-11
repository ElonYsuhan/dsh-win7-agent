'use strict'
const assert = require('assert')
const { hesynWorkflowPrompt, HESYN_WORKFLOW_INSTRUCTIONS } = require('../src/main/service/hesyn-workflow')
const { message } = require('../src/main/contracts/host-integration')
const repository = { data: { sessions: {
  scene: { workspace: '/scene', tools: { host__hesyn__hesyn_call: 'fingerprint' } },
  other: { workspace: '/other', tools: { host__other__lookup: 'fingerprint' } }
} } }
assert.equal(hesynWorkflowPrompt(repository, { workspaceRoot: '/scene' }), HESYN_WORKFLOW_INSTRUCTIONS)
assert.equal(hesynWorkflowPrompt(repository, { workspaceRoot: '/other' }), '')
assert.equal(hesynWorkflowPrompt(repository, { workspaceRoot: '/unknown' }), '')
for (const term of ['等待用户明确确认', '①部署实体', '②为已确认实体', '参数修改', '不自动重放', '仍遵守既有逐工具审批']) assert(HESYN_WORKFLOW_INSTRUCTIONS.includes(term), term)
assert.equal(message({ text: 'x'.repeat(100000), requestId: 'long_text_1', history: Array.from({ length: 2000 }, () => ({ role: 'user', content: 'old' })) }).history.length, 2000)
assert.throws(() => message({ text: 'test', requestId: 'invalid_role_1', history: [{ role: 'system', content: 'not allowed' }] }), /HISTORY_INVALID/)
const { ServiceRepository } = require('../src/main/service/repository')
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'large-event-test-'))
const repo = new ServiceRepository(home, { eventBufferMaxBytes: 12 * 1024 * 1024 })
try {
  const id = crypto.randomUUID()
  repo.event(id, { type: 'finished', messages: [{ role: 'assistant', content: 'x'.repeat(5 * 1024 * 1024) }], memory: null })
  assert.equal(repo.events(id, 0).length, 1, 'large accepted history must not lose its finished event at the old 4MiB ceiling')
  assert.equal(repo.eventGap(id, 0, repo.epoch), false)
} finally { repo.close(); fs.rmSync(home, { recursive: true, force: true }) }
console.log('PASS HESYN workflow policy, long-history contract and large completion event (not a model behavior acceptance test)')
