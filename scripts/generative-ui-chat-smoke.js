'use strict'

// Dependency-free adapter regression, also run under Electron's Node 16. The
// real Vue/ECharts and actual chat are covered by separate browser tests.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
class Element {
  constructor() { this.children = []; this.parent = null; this.hidden = false; this.textContent = ''; this.attributes = {} }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  contains(child) { return child === this || this.children.some(item => item.contains(child)) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  removeAttribute(name) { delete this.attributes[name] }
}
function projection(sessionId, messages) {
  const latest = new Map()
  for (const message of messages) for (const block of message.content || []) {
    if (!block || block.type !== 'ui' || !block.surface || !block.surface.id) continue
    const old = latest.get(block.surface.id)
    if (block.surface.version !== 1) latest.set(block.surface.id, block)
    else if (!old || old.surface.version === 1 && block.surface.revision > old.surface.revision) latest.set(block.surface.id, block)
  }
  return messages.map(message => ({ sessionId, parts: (message.content || []).map(block => {
    if (!block || block.type !== 'ui') return { kind: 'other' }
    if (block.surface && latest.get(block.surface.id) !== block) return { kind: 'superseded' }
    if (!block.surface || block.surface.version !== 1) return { kind: 'unavailable' }
    return { kind: 'ui', surface: block.surface }
  }) }))
}
async function tick() { await new Promise(resolve => setImmediate(resolve)) }
async function main() {
  const mounts = []
  const engine = {
    capabilities: () => ({ versions: [1, 2], components: ['text'] }),
    projectMessages: projection,
    mountSurface(host, props) {
      const record = { host, props, disposed: 0, updates: 0 }; mounts.push(record)
      host.textContent = props.surface.title
      return { update(next) { record.props = next; record.updates += 1 }, dispose() { record.disposed += 1 } }
    }
  }
  let sessionId = 'A', theme = 'light'
  const block = (id, revision, version = 1) => ({ type: 'ui', toolCallId: 'c' + revision, surface: { id, revision, version, title: id + revision } })
  let messages = [{ role: 'assistant', content: [block('history', 1)] }]
  const sandbox = { window: { AgentGenerativeUI: engine }, document: { createElement: () => new Element(), head: new Element() }, Promise, Set, Object, Array }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/generative-ui-chat.js'), 'utf8'), sandbox)
  const ui = sandbox.window.createGenerativeUIChat({ sessionId: () => sessionId, messages: () => messages, theme: () => theme })
  assert.deepStrictEqual(await ui.capabilities(), engine.capabilities())
  ui.reset('A')
  const fragment = new Element(), wrapper = fragment.appendChild(new Element()), host = wrapper.appendChild(new Element())
  const group = ui.group(wrapper, false)
  ui.addSlot(host, group, 'A', messages, 0, 0)
  await tick()
  assert.strictEqual(mounts.length, 1)
  assert.strictEqual(mounts[0].props.surface.id, 'history')
  messages = messages.concat([{ role: 'user', content: [] }])
  theme = 'dark'; ui.themeChanged()
  assert.strictEqual(mounts[0].disposed, 0, 'immutable append must retain earlier mount')
  assert.strictEqual(mounts[0].props.theme, 'dark')
  const liveRoot = new Element()
  const create = () => { const wrapper = liveRoot.appendChild(new Element()); return { wrapper, host: wrapper.appendChild(new Element()) } }
  assert.strictEqual(ui.notification({ sessionId: 'B', ...block('other', 1) }, create), false)
  assert.strictEqual(liveRoot.children.length, 0, 'wrong session cannot create a live host')
  assert.strictEqual(ui.notification({ sessionId: 'A', toolCallId: 'c2', surface: block('other', 1).surface }, create), true)
  await tick()
  assert.strictEqual(mounts[0].disposed, 0)
  assert.strictEqual(mounts.length, 2)
  ui.disposeWithin(fragment)
  assert.strictEqual(mounts[0].disposed, 1, 'cancelled detached history must be disposed')
  for (let i = 2; i <= 257; i += 1) ui.notification({ sessionId: 'A', toolCallId: 'c' + i, surface: block('other', i).surface }, create)
  await tick()
  assert.strictEqual(mounts[1].disposed, 1, 'overflow must not leave stale charts running')
  assert(liveRoot.children.some(item => item.children[0].textContent.includes('任务结束后显示最终结果')))
  sessionId = 'B'; ui.reset('B')
  assert.strictEqual(ui.hasLive(), false)
  assert.strictEqual(ui.notification({ sessionId: 'A', toolCallId: 'late', surface: block('other', 300).surface }, create), false)
  console.log('Generative UI chat adapter: session isolation, immutable append, theme, detached cleanup and bounded live notifications passed. Node ' + process.versions.node)
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
