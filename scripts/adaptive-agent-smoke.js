'use strict'

// Real Cordis/AgentPool regression for the long-term memory, live capability
// directory and adaptive planner. No model/network/credentials are used.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { AgentPool } = require('../src/main/agent/agent-pool')

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-adaptive-'))
  const settings = { file: path.join(tmp, 'settings.json'), data: { maxIterations: 3, permissionMode: 'readonly', workspacePath: tmp }, all() { return this.data } }
  const host = new PluginHost({ workspaceRoot: tmp, settings })
  const events = [], requests = []
  const pool = new AgentPool({ settings, pluginHost: host, sessionRoot: path.join(tmp, 'sessions'), emit: event => events.push(event), approve: async () => false })
  try {
    await host.ready()
    const memory = host.requireService('memoryStore')
    const seeded = await memory.remember({ scope: 'project', scopeId: tmp, kind: 'preference', key: 'response_style', content: '先给结论，再给细节', confidence: 0.95, sourceType: 'explicit', sourceRef: 'seed' })
    assert(seeded.id && seeded.status === 'active')
    assert((await memory.search({ scope: 'project', scopeId: tmp, query: '结论' })).items.length === 1)
    assert((await memory.context({ scope: 'project', scopeId: tmp, query: '结论' })).includes('先给结论'))
    await memory.extract({ sessionId: 'extract', workspaceRoot: tmp, messages: [{ role: 'user', content: '请记住我喜欢使用清单' }, { role: 'user', content: '今天完成一个任务' }], outcome: 'completed' })
    await assert.rejects(memory.remember({ scope: 'project', scopeId: tmp, kind: 'fact', content: '我的密码是 abc123' }), /MEMORY_SENSITIVE/)
    await memory.remember({ scope: 'session', scopeId: 'other', kind: 'fact', content: '另一个会话的私有事实' })
    assert.strictEqual((await memory.search({ scope: 'session', scopeId: 'other', sessionId: 'other', query: '私有事实' })).items.length, 1)
    assert.strictEqual((await memory.search({ scope: 'session', scopeId: 'other', sessionId: 'this-session', query: '私有事实' })).items.length, 0, 'session memory must not leak across sessions')
    const candidates = await memory.candidates({ scope: 'project', scopeId: tmp })
    assert(candidates.items.length >= 1, 'task experience should be a candidate, not auto-trusted memory')
    const confirmed = await memory.confirm({ id: candidates.items[0].id })
    assert(confirmed.kind === 'experience')

    let handleMemoryApi
    try { ({ handleMemoryApi } = require('../server/memory-api')) } catch (_) { ({ handleMemoryApi } = require('../service/memory-api')) }
    let apiBody = {}, apiResponse = null
    const handled = await handleMemoryApi({ method: 'POST' }, {}, new URL('http://127.0.0.1/api/memory/search'), {
      memory, workspace: () => tmp, readBody: async () => apiBody,
      json: (_response, code, value) => { apiResponse = { code, value } }
    })
    assert.strictEqual(handled, true)
    apiBody = { query: '结论' }
    await handleMemoryApi({ method: 'POST' }, {}, new URL('http://127.0.0.1/api/memory/search'), { memory, workspace: () => tmp, readBody: async () => apiBody, json: (_response, code, value) => { apiResponse = { code, value } } })
    assert.strictEqual(apiResponse.code, 200)
    assert(apiResponse.value.items.length >= 1)

    const capabilities = host.requireService('capabilities')
    assert(capabilities.list().some(item => item.type === 'tool'))
    assert(capabilities.list().some(item => item.type === 'skill'))
    const toolCapability = capabilities.list().find(item => item.type === 'tool')
    assert(toolCapability, 'at least one live tool must be registered')
    assert(capabilities.search(toolCapability.name, { limit: 5 }).length > 0)
    assert(capabilities.inspect(toolCapability.id).type === 'tool')

    const workflows = host.requireService('workflows')
    const definition = { version: 2, editor: 'steps', name: '回滚验收', description: '验证历史版本', nodes: [{ id: 's', type: 'start', text: '开始' }, { id: 'e', type: 'end', deliverable: { format: 'text', name: '结果' } }], edges: [{ from: 's', to: 'e' }] }
    const first = workflows.save(definition)
    const second = workflows.save({ ...first, description: '新版说明' })
    assert.strictEqual(second.revision, 2)
    const revisions = workflows.history({ id: first.id }).revisions
    assert(revisions.some(item => item.revision === 1 && !item.current) && revisions.some(item => item.revision === 2 && item.current))
    const rolled = workflows.rollback({ id: first.id, revision: 1 })
    assert.strictEqual(rolled.revision, 3)
    assert.strictEqual(rolled.description, '验证历史版本')
    assert(workflows.history({ id: first.id }).revisions.some(item => item.revision === 3 && item.current))

    const adaptive = host.requireService('adaptive')
    const plan = await adaptive.plan({ task: '修复代码并整理周报', sessionId: 's1', workspaceRoot: tmp })
    assert(plan.analysis.intent === 'fix')
    assert(Array.isArray(plan.steps) && Array.isArray(plan.gaps))
    const recommendation = await adaptive.recommend({ task: '修复代码并整理周报', sessionId: 's1', workspaceRoot: tmp })
    assert(Array.isArray(recommendation.recommendations))
    await adaptive.feedback({ sessionId: 's1', task: '修复代码', outcome: 'failed', capabilities: ['tool:read_file'] })
    assert((await memory.feedbackList({ limit: 5 })).items.length === 1)

    await host.replace('core/llm', { name: 'core/llm', apply(ctx) { ctx.provide('llm', { request: async input => { requests.push(input); return { content: '已根据记忆回答', toolCalls: [] } } }) } })
    await pool.run('memory-session', '请按结论优先分析当前数据', [])
    assert.strictEqual(requests.length, 1)
    const system = requests[0].messages.find(message => message.role === 'system').content
    assert(system.includes('长期记忆'), 'memory must be injected into the Agent context')
    assert(system.includes('先给结论'))
    const tools = requests[0].tools.map(tool => tool.function.name)
    assert(tools.includes('memory_search') && tools.includes('capability_search') && tools.includes('adaptive_plan'))
    const recentWorkspace = path.join(tmp, 'recent-workspace')
    fs.mkdirSync(recentWorkspace, { recursive: true })
    await pool.run('recent-session', '普通聊天', [], undefined, undefined, undefined, undefined, undefined, undefined, recentWorkspace)
    assert.strictEqual(pool.acquire('recent-session').workspaceRoot, recentWorkspace)
    assert(requests[requests.length - 1].messages.find(message => message.role === 'system').content.includes(recentWorkspace), 'per-session workspace must reach the Agent system prompt')

    const result = await host.requireService('tools').execute('memory_search', { query: '结论' }, { agent: pool.acquire('memory-session'), settings: settings.data })
    const denied = await host.requireService('tools').execute('memory_remember', { content: '只读模式不能写入' }, { agent: pool.acquire('memory-session'), settings: settings.data })
    assert(/^DENIED: memory_remember/.test(denied), 'memory writes must follow the existing permission policy')

    assert(JSON.parse(result).items.length >= 1)

    const forget = await memory.forget(seeded.id)
    assert(forget.ok)
    const afterForget = await memory.search({ scope: 'project', scopeId: tmp, query: '结论' }); assert(afterForget.items.length === 0)
    console.log('Adaptive Agent memory/capability/planner: SQLite FTS5 CRUD, explicit extraction, candidate confirmation, context injection, live capability directory, adaptive plan/recommendation, feedback and forget passed. Node ' + process.versions.node)
  } finally {
    await pool.dispose()
    await host.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
