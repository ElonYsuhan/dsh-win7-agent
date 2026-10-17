'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { Context } = require('../src/main/runtime/vendor/cordis')
const { Agent } = require('../src/main/agent/agent')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cordis-'))
  const host = new PluginHost({ workspaceRoot: root, settings: { data: {} } })
  const order = []
  try {
    assert(Context.is(host.context), 'must use actual Cordis Context')
    host.use({
      name: 'test/consumer', inject: ['sample'],
      apply(ctx) {
        assert.strictEqual(ctx.get('sample').value, 1)
        ctx.registerTool({ name: 'sample_tool', permission: 'read', execute: () => 'ok' })
        ctx.addSystemPrompt(() => 'SAMPLE_PROMPT')
        ctx.on('sample:event', () => order.push('event'))
        ctx.on('sample:hook', (value) => value + 1)
        ctx.effect(async () => { await Promise.resolve(); order.push('consumer disposed') })
      }
    })
    await host.ready()
    assert.strictEqual(host.inspectPlugins().find((item) => item.name === 'test/consumer').state, 'pending')
    host.use({
      name: 'test/provider',
      apply(ctx) {
        ctx.provide('sample', { value: 1 })
        ctx.effect(() => { order.push('provider disposed') })
      }
    })
    await host.ready()
    assert(host.getTool('sample_tool'))
    assert((await host.buildSystemPrompt('BASE')).includes('SAMPLE_PROMPT'))
    assert.strictEqual(await host.executeTool('sample_tool', {}, { settings: {} }), 'ok')
    assert.strictEqual(await host.events.hook('sample:hook', 2), 3)
    host.events.emit('sample:event', {})
    assert.deepStrictEqual(order, ['event'])
    await host.unload('test/provider')
    assert.deepStrictEqual(order, ['event', 'consumer disposed', 'provider disposed'])
    assert.strictEqual(host.get('sample'), undefined)
    assert.strictEqual(host.getTool('sample_tool'), undefined)
    assert(!(await host.buildSystemPrompt('BASE')).includes('SAMPLE_PROMPT'))
    host.events.emit('sample:event', {})
    assert.strictEqual(order.length, 3, 'no listeners survive dependency unload')
    host.use({ name: 'test/provider', apply(ctx) { ctx.provide('sample', { value: 1 }) } })
    await host.ready()
    assert(host.getTool('sample_tool'), 'consumer automatically reactivates')

    // Native Cordis plugin and legacy plugin share the SAME dependency graph.
    host.use({
      name: 'test/native', cordis: true, inject: ['sample'],
      apply(ctx) { ctx.provide('nativeSample', { value: ctx.sample.value + 1 }) }
    })
    await host.ready()
    assert.strictEqual(host.get('nativeSample').value, 2)

    host.settings.data.disabledPlugins = ['test/consumer']
    await host.configure()
    assert.strictEqual(host.inspectPlugins().find((item) => item.name === 'test/consumer').state, 'disabled')
    assert.strictEqual(host.tools.get('sample_tool'), undefined)
    assert(!(await host.buildSystemPrompt('BASE')).includes('SAMPLE_PROMPT'))
    assert((await host.executeTool('sample_tool', {}, {})).startsWith('DISABLED:'))
    host.settings.data.disabledPlugins = []
    await host.configure()
    assert(host.tools.get('sample_tool'))

    // Unload waits for a running tool, and cancels a pending approval.
    let releaseTool
    let enteredTool
    const toolStarted = new Promise((resolve) => { enteredTool = resolve })
    host.use({ name: 'test/drain', apply(ctx) {
      ctx.registerTool({ name: 'drain_tool', permission: 'read', execute: async () => {
        enteredTool()
        return new Promise((resolve) => { releaseTool = resolve })
      } })
    } })
    await host.ready()
    const toolRun = host.executeTool('drain_tool', {}, {})
    await toolStarted
    let unloaded = false
    const unloading = host.unload('test/drain').then(() => { unloaded = true })
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
    assert(!unloaded, 'unload must wait for in-flight tools')
    assert.strictEqual(host.tools.get('drain_tool'), undefined)
    releaseTool('drained')
    assert.strictEqual(await toolRun, 'drained')
    await unloading
    let enteredApproval
    const approving = new Promise((resolve) => { enteredApproval = resolve })
    host.use({ name: 'test/approval', apply(ctx) {
      ctx.registerTool({ name: 'approval_tool', permission: 'command', execute: () => assert.fail('must not execute') })
    } })
    await host.ready()
    const approvalRun = host.executeTool('approval_tool', { command: 'rm -rf x' }, {
      settings: { permissionMode: 'full' }, approve: () => { enteredApproval(); return new Promise(() => {}) }
    })
    const approvalRejected = assert.rejects(approvalRun, /ABORTED/)
    await approving
    await host.unload('test/approval')
    await approvalRejected

    // The real public Agent dispatches through replaceable runtime services.
    await host.replace('core/llm', {
      name: 'core/llm',
      apply(ctx) {
        ctx.provide('llm', { request: async () => ({ content: 'cordis-model', toolCalls: [] }) })
      }
    })
    const events = []
    const agent = new Agent({ data: { maxIterations: 1 }, workspacePath: root }, (event) => events.push(event), async () => true, path.join(root, 'session'), host)
    await agent.run('hello')
    assert(events.some((event) => event.type === 'done' && event.text === 'cordis-model'))
    assert(JSON.parse(fs.readFileSync(path.join(root, 'session', 'last-session.json'), 'utf8')).messages.some((message) => message.content === 'cordis-model'))

    // A bad replacement restores the previous provider and its consumers.
    await assert.rejects(host.replace('core/llm', {
      name: 'core/llm', apply() { throw new Error('replacement failed') }
    }), /replacement failed/)
    assert.strictEqual((await host.get('llm').request({})).content, 'cordis-model')
    let enteredModel
    const modelStarted = new Promise((resolve) => { enteredModel = resolve })
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) {
      ctx.provide('llm', { request: (request) => new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true })
        enteredModel()
      }) })
    } })
    const turn = agent.run('cancel during replacement')
    await modelStarted
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) {
      ctx.provide('llm', { request: async () => ({ content: 'resumed-model', toolCalls: [] }) })
    } })
    await turn
    assert(!agent.disposed, 'replacing a model must preserve conversation workers')
    await agent.run('continue after replacement')
    assert(events.some((event) => event.type === 'done' && event.text === 'resumed-model'))
    let dispatched = false
    await host.replace('core/agent-loop', {
      name: 'core/agent-loop',
      apply(ctx) { ctx.provide('agentLoop', { run: async () => { dispatched = true } }) }
    })
    await agent.run('replacement')
    assert(dispatched, 'public Agent cannot bypass Cordis loop service')
    await agent.dispose()
    await host.dispose()
    await host.dispose()
    assert.strictEqual(host.get('llm'), undefined)
    assert.strictEqual(host.context.registry.size, 0)

    // Failed activation must roll back tools, prompts and service provisions.
    const failed = new PluginHost()
    failed.use({ name: 'test/broken', apply(ctx) {
      ctx.provide('temporary', {})
      ctx.registerTool({ name: 'temporary_tool', execute: async () => '' })
      throw new Error('expected activation failure')
    } })
    await assert.rejects(failed.ready(), /expected activation failure/)
    await failed.dispose()
    assert.strictEqual(failed.get('temporary'), undefined)
    assert.strictEqual(failed.context.registry.size, 0)
    console.log('Cordis runtime OK: native context, dependency activation, dependent-first async cleanup, reactivation, events, prompt/tool rollback, replaceable model/loop, persistence, shutdown')
  } finally {
    await host.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
