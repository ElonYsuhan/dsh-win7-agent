'use strict'

// P1's dependency-free view model is a development source, not a shipped UI.
// Compile it and the actual P0 validator together in a disposable directory so
// the same checks can run under both the build machine and embedded Node 16.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const root = path.resolve(__dirname, '..')
const version = require('typescript/package.json').version
assert.strictEqual(version, '5.9.3', 'use the existing lockfile-pinned TypeScript compiler; do not silently select a different version')
const compiler = require.resolve('typescript/bin/tsc')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-view-test-'))

function example(revision) {
  return {
    version: 1, id: 'sales', revision, title: '季度收入', root: 'layout',
    state: { factor: 1, note: 'unchanged' },
    components: [
      { id: 'layout', type: 'column', children: ['description', 'graph', 'scale', 'send'] },
      { id: 'description', type: 'text', text: '<img src=x onerror=alert(1)>' },
      { id: 'graph', type: 'chart', chartType: 'line', title: '收入', labels: ['第一季', '<b>第二季</b>'], series: [
        { id: 'income', name: '收入', values: [2, 4] },
        { id: 'cost', name: '成本', values: [-1, 0] }
      ], multiplierKey: 'factor' },
      { id: 'scale', type: 'slider', label: '倍数', stateKey: 'factor', min: 0, max: 5, step: 0.5 },
      { id: 'send', type: 'button', label: '分析', actionId: 'analyze' }
    ],
    actions: [{ id: 'analyze', type: 'ask_agent', message: '分析当前数据', stateKeys: ['factor'] }]
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)) }
// A structural check only, not the real Vue template compiler.
function checkTemplateTags(source, name) {
  const start = source.indexOf('<template>'), end = source.lastIndexOf('</template>')
  assert(start >= 0 && end > start, name + ': template boundaries')
  const text = source.slice(start + '<template>'.length, end), stack = []
  for (let i = 0; i < text.length;) {
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4); assert(close >= 0, name + ': unterminated comment'); i = close + 3; continue
    }
    if (text[i] !== '<' || !/[A-Za-z/]/.test(text[i + 1] || '')) { i += 1; continue }
    let j = i + 1, quote = ''
    for (; j < text.length; j += 1) {
      const ch = text[j]
      if (quote) { if (ch === quote) quote = '' }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
    }
    assert(j < text.length && !quote, name + ': unterminated tag')
    const tag = text.slice(i, j + 1), match = /^<\s*(\/?)\s*([A-Za-z][\w-]*)/.exec(tag)
    assert(match, name + ': invalid tag')
    const closing = !!match[1], id = match[2]
    if (closing) assert.strictEqual(stack.pop(), id, name + ': unbalanced closing tag ' + id)
    else if (!/\/\s*>$/.test(tag) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'].includes(id.toLowerCase())) stack.push(id)
    i = j + 1
  }
  assert.deepStrictEqual(stack, [], name + ': unclosed tags')
}
// Static draft checks do not compile Vue templates or verify library APIs.
function checkDraftComponents() {
  const ts = require('typescript')
  const folder = path.join(root, 'ui/generative-ui/src/components')
  const names = fs.readdirSync(folder).filter(name => name.endsWith('.vue')).sort()
  assert.deepStrictEqual(names, ['ButtonNode.vue', 'ChartNode.vue', 'CheckboxNode.vue', 'ContainerNode.vue', 'FilterNode.vue', 'FlowNode.vue', 'FormNode.vue', 'InputNode.vue', 'MapNode.vue', 'ProgressNode.vue', 'SliderNode.vue', 'SurfaceNode.vue', 'SurfaceRenderer.vue', 'TableNode.vue', 'TextNode.vue', 'UIMessageRenderer.vue', 'VisualNode.vue'])
  for (const name of names) {
    const file = path.join(folder, name), source = fs.readFileSync(file, 'utf8')
    const script = /^<script setup lang="ts">\r?\n([\s\S]*?)\r?\n<\/script>/m.exec(source)
    assert(script, name + ' requires TypeScript script setup')
    checkTemplateTags(source, name)
    const tree = ts.createSourceFile(name + '.ts', script[1], ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS)
    assert.deepStrictEqual(tree.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], name + ' has invalid TypeScript syntax')
    assert(!/v-html|v-bind\s*=|innerHTML|outerHTML|insertAdjacentHTML/.test(source), name + ' cannot treat agent data as markup')
    assert(!/<script[^>]*\bsrc\s*=/.test(source), name + ' cannot load remote scripts')
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const spec = node.moduleSpecifier.text
        if (spec.startsWith('.')) {
          const target = path.resolve(folder, spec)
          assert(fs.existsSync(target) || fs.existsSync(target + '.ts'), name + ': missing local import ' + spec)
        } else assert(['vue', 'naive-ui', 'echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'].includes(spec), name + ': unexpected dependency ' + spec)
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        assert(node.expression.kind !== ts.SyntaxKind.ImportKeyword, name + ': dynamic import is not permitted')
        if (ts.isIdentifier(node.expression)) assert(!['eval', 'Function', 'fetch', 'require'].includes(node.expression.text), name + ': unsafe call')
        if (ts.isPropertyAccessExpression(node.expression)) assert(!['fetch', 'open', 'write', 'writeln'].includes(node.expression.name.text), name + ': unsafe side effect')
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
}
// Type-check extracted scripts against the installed pinned library types.
// Only Vue SFC macro and component declarations are stubbed; this still does
// not compile templates or establish real renderer behavior.
function typecheckDraftScripts() {
  const ts = require('typescript'), testRoot = path.join(tmp, 'sfc-type-check')
  const from = path.join(root, 'ui/generative-ui/src'), to = path.join(testRoot, 'ui/generative-ui/src')
  const components = path.join(to, 'components')
  fs.mkdirSync(components, { recursive: true })
  for (const name of fs.readdirSync(from)) if (name.endsWith('.ts')) fs.copyFileSync(path.join(from, name), path.join(to, name))
  const inputs = []
  for (const name of fs.readdirSync(path.join(from, 'components'))) {
    if (!name.endsWith('.vue')) continue
    const source = fs.readFileSync(path.join(from, 'components', name), 'utf8')
    const match = /<script setup lang="ts">\r?\n([\s\S]*?)\r?\n<\/script>/.exec(source)
    assert(match)
    const file = path.join(components, name.replace(/\.vue$/, '.script.ts'))
    fs.writeFileSync(file, match[1]); inputs.push(file)
  }
  const contractDir = path.join(testRoot, 'src/main/contracts')
  fs.mkdirSync(contractDir, { recursive: true })
  for (const name of ['generative-ui.js', 'generative-ui-interaction.js']) fs.copyFileSync(path.join(root, 'src/main/contracts', name), path.join(contractDir, name))
  const geometryDir = path.join(testRoot, 'src/renderer')
  fs.mkdirSync(geometryDir, { recursive: true })
  for (const name of ['workflow-auto-layout.js', 'workflow-link-routing.js']) fs.copyFileSync(path.join(root, 'src/renderer', name), path.join(geometryDir, name))
  const stubs = path.join(testRoot, 'draft-stubs.d.ts')
  fs.writeFileSync(stubs, [
    "declare module '*.vue' { const value: import('vue').DefineComponent; export default value }",
    'declare function defineProps<T>(): Readonly<T>',
    'declare function defineEmits<T extends { [K in keyof T]: unknown[] }>(): <K extends keyof T>(event: K, ...args: T[K]) => void'
  ].join('\n'))
  const program = ts.createProgram([stubs, ...inputs], {
    strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, allowJs: true, checkJs: false,
    skipLibCheck: true, types: [], lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'], noEmit: true,
    baseUrl: root, paths: { 'vue': ['node_modules/vue'], '@cesium/engine': ['node_modules/@cesium/engine'], 'naive-ui': ['node_modules/naive-ui'], 'echarts/*': ['node_modules/echarts/*'] }
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) throw new Error('Draft SFC script type check failed:\n' + diagnostics.map(d => {
    const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null
    return (d.file ? path.relative(testRoot, d.file.fileName) : '') + (where ? ':' + (where.line + 1) : '') + ' TS' + d.code + ' ' + ts.flattenDiagnosticMessageText(d.messageText, '\n')
  }).join('\n'))
}

function compile() {
  const result = spawnSync(process.execPath, [compiler, '--project', path.join(root, 'ui/generative-ui/tsconfig.json'), '--outDir', tmp], { cwd: root, encoding: 'utf8', timeout: 120000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('TypeScript compilation failed:\n' + result.stdout + result.stderr)
}

async function checkInteractionController() {
  const { createInteractionController } = require(path.join(tmp, 'ui/generative-ui/src/interaction-controller.js'))
  const UI = require('../src/main/contracts/generative-ui-interaction')
  const schema = example(1), sessionId = 'controllerA'
  let sequence = 1, stateVersion = 0, values = { ...schema.state }, receipts = [], count = 0
  let changeGate = null, failChange = false, failAction = false, confirmed = true, running = false
  let display, controller
  const sent = [], actions = [], phases = []
  function snapshot(definitions) {
    return { version: 1, sessionId, sequence, running, surfaces: { sales: { revision: 1, stateVersion, state: { ...values } } }, receipts: receipts.slice(), definitions: definitions ? { sales: clone(schema) } : {} }
  }
  const host = {
    requestId: () => 'req' + (++count),
    read: async () => snapshot(true),
    change: async request => {
      UI.assertRequest(request, 'change'); sent.push(request)
      if (changeGate) await changeGate
      if (failChange) throw new Error('network failed')
      if (request.expectedStateVersion !== stateVersion) throw new Error('STATE_UI_STATE_CONFLICT')
      values = UI.changeState(schema, values, request.componentId, request.value)
      stateVersion++; sequence++
      const result = snapshot(false)
      controller.receive(result)
      return result
    },
    confirm: async () => confirmed,
    dispatch: async request => {
      UI.assertRequest(request, 'action'); actions.push(request)
      receipts.push({ requestId: request.requestId, surfaceId: 'sales', revision: 1, actionId: 'analyze', status: 'accepted', reason: '', sequence: ++sequence })
      if (failAction) throw new Error('response lost after accept')
      return { snapshot: snapshot(false), receipt: {}, started: true }
    },
    onRun: (owner, phase) => { assert.strictEqual(owner, sessionId); phases.push(phase) }
  }
  controller = createInteractionController(sessionId, schema, host, value => { display = value })
  await Promise.resolve(); await Promise.resolve()
  assert(display.canAct)
  let release
  changeGate = new Promise(resolve => { release = resolve })
  controller.change({ componentId: 'scale', value: 1.5 })
  controller.change({ componentId: 'scale', value: 2 })
  controller.change({ componentId: 'scale', value: 2.5 })
  assert.strictEqual(display.state.factor, 2.5, 'local redraw does not wait for IO')
  assert.strictEqual(display.canAct, false, 'unsaved values cannot start an action')
  release(); await controller.flush(); changeGate = null
  assert.strictEqual(values.factor, 2.5)
  assert.deepStrictEqual(sent.map(item => item.value), [1.5, 2.5], 'coalesce pending same-control edits, never the in-flight request')
  confirmed = false; await controller.submit({ componentId: 'send', actionId: 'analyze' })
  assert.strictEqual(actions.length, 0)
  assert(display.canAct)
  confirmed = true
  let confirmRelease
  const oldConfirm = host.confirm
  host.confirm = () => new Promise(resolve => { confirmRelease = resolve })
  const submitting = controller.submit({ componentId: 'send', actionId: 'analyze' })
  await Promise.resolve(); await Promise.resolve()
  await controller.submit({ componentId: 'send', actionId: 'analyze' })
  confirmRelease(true); await submitting; host.confirm = oldConfirm
  assert.strictEqual(actions.length, 1, 'double submit is ignored while confirming')
  assert.strictEqual(actions[0].expectedStateVersion, 2)
  assert(!display.canAct)
  receipts = receipts.map(item => ({ ...item, status: 'completed' })); sequence++
  controller.receive(snapshot(false))
  assert(display.canAct)
  assert.throws(() => controller.receive({ ...snapshot(false), sessionId: 'other' }), /SESSION_MISMATCH/)
  const stale = snapshot(false); stale.sequence = 1; stale.receipts = []; stale.surfaces.sales.state.factor = 0
  controller.receive(stale)
  assert.strictEqual(display.state.factor, 2.5, 'stale snapshots cannot roll back the view')
  failAction = true
  await controller.submit({ componentId: 'send', actionId: 'analyze' })
  assert.strictEqual(actions.length, 2, 'lost action response is not retried')
  assert(!display.canAct && display.note.includes('不会自动重试'))
  assert.deepStrictEqual(phases, ['begin', 'begin', 'rejected'])
  receipts = receipts.map(item => ({ ...item, status: 'interrupted' })); sequence++
  failAction = false; await controller.reload()
  assert(display.canAct && display.note.includes('不会自动重试'))
  stateVersion++; values = { ...values, factor: 4 }; sequence++
  controller.change({ componentId: 'scale', value: 3 })
  await controller.flush()
  assert.strictEqual(display.state.factor, 4, 'concurrent changes require review rather than silent overwrite')
  assert(!display.canAct && display.note.includes('其他窗口'))
  await controller.reload()
  failChange = true
  controller.change({ componentId: 'scale', value: 3.5 }); await controller.flush()
  assert(!display.canAct && display.note.includes('保存失败'))
  failChange = false
  await controller.reload()
  let drained
  changeGate = new Promise(resolve => { drained = resolve })
  controller.change({ componentId: 'scale', value: 2 })
  controller.change({ componentId: 'scale', value: 3 })
  controller.dispose(); drained(); await controller.flush()
  assert.strictEqual(values.factor, 3, 'already accepted local edits drain on unmount without invoking an action')
  const before = actions.length
  await controller.submit({ componentId: 'send', actionId: 'analyze' })
  assert.strictEqual(actions.length, before, 'disposed controllers never dispatch actions')
  const forged = clone(schema); forged.actions[0].message = '伪造操作'
  const readOnly = createInteractionController(sessionId, forged, host, value => { display = value })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert(!display.canAct, 'client history cannot replace a server-confirmed action definition')
  readOnly.dispose()
}
async function main() {
try {
  checkDraftComponents()
  typecheckDraftScripts()
  // License inventory includes every rendered module, including side effects,
  // but not modules that Rollup completely removed from the browser bundle.
  const build = require('./build-generative-ui')
  const used = new Set(), collector = build.licenseCollector(used)
  const vueFile = require.resolve('vue/dist/vue.runtime.esm-bundler.js')
  const vueDir = path.dirname(path.dirname(vueFile))
  collector.generateBundle({}, { chunk: { type: 'chunk', modules: { [vueFile]: { renderedLength: 0 } } } })
  assert(!used.has(vueDir), 'a zero-length tree-shaken module is not shipped')
  collector.generateBundle({}, { chunk: { type: 'chunk', modules: { [vueFile]: { renderedLength: 1 } } } })
  assert(used.has(vueDir), 'nonempty modules must be inventoried even without exports')
  const missingLicense = path.join(tmp, 'missing-license')
  fs.mkdirSync(missingLicense)
  fs.writeFileSync(path.join(missingLicense, 'package.json'), JSON.stringify({ name: 'missing-test-license', version: '1.0.0' }))
  assert.throws(() => build.notices(new Set([missingLicense])), /GENERATIVE_UI_LICENSE_MISSING/, 'a bundled package without a license fails closed')
  assert.throws(() => build.verifyRenderedPackages(new Set([missingLicense])), /GENERATIVE_UI_TRANSITIVE_VERSION/, 'a rendered package without a lockfile entry fails closed')
  const rootFile = path.join(root, 'node_modules/lodash-es/_root.js')
  const upstream = fs.readFileSync(rootFile, 'utf8'), transforms = []
  const plugin = build.lodashCspPlugin(transforms)
  const transformed = plugin.transform(upstream, rootFile)
  assert(!transformed.code.includes("Function('return this')"), 'pinned browser build removes the unsafe-eval fallback')
  assert.strictEqual(transforms.length, 1)
  assert.throws(() => plugin.transform(upstream + ' ', rootFile), /GENERATIVE_UI_CSP_TRANSFORM_MISMATCH/, 'unknown upstream changes fail closed')
  assert.strictEqual(plugin.transform(upstream, rootFile + '.other'), null)
  for (const code of ['eval("1")', 'new Function("return 1")', 'window["eval"]("1")', 'import("./module.js")']) {
    assert.throws(() => build.assertNoDynamicExecution(Buffer.from(code), 'test.js'), /GENERATIVE_UI_DYNAMIC_CODE/)
  }
  build.assertNoDynamicExecution(Buffer.from('const value = typeof self === "object" ? self : null;'), 'safe.js')
  compile()
  const { createSurfaceView, replaceSurfaceView, updateSlider, updateField, deriveChart, prepareTree } = require(path.join(tmp, 'ui/generative-ui/src/surface-view.js'))
  const { COMPONENT_KINDS, createComponentRegistry, createComponentRegistryBuilder, assertComponentRegistry } = require(path.join(tmp, 'ui/generative-ui/src/component-registry.js'))
  const { makeChartPlan } = require(path.join(tmp, 'ui/generative-ui/src/chart-options.js'))
  const { createChartController } = require(path.join(tmp, 'ui/generative-ui/src/chart-lifecycle.js'))
  const { projectMessages } = require(path.join(tmp, 'ui/generative-ui/src/message-projection.js'))
  const business = require('../examples/generative-ui/business.surface.json')
  let businessView = createSurfaceView('business-view', business)
  assert.strictEqual(prepareTree(businessView).children.find(node => node.type === 'table').rows.length, 3)
  businessView = updateField(businessView, 'region', '华东')
  assert.strictEqual(prepareTree(businessView).children.find(node => node.type === 'table').rows.length, 2)
  businessView = updateField(businessView, 'records', 'shanghai')
  businessView = updateField(businessView, 'process', 'review')
  businessView = updateField(businessView, 'places', 'beijing')
  assert.deepStrictEqual(businessView.state, { region: '华东', row: 'shanghai', node: 'review', point: 'beijing', done: 25 })
  const businessTree = prepareTree(businessView)
  assert.strictEqual(businessTree.children.find(node => node.type === 'progress').value,25)
  assert.strictEqual(businessTree.children.find(node => node.type === 'map').selected,'beijing')
  assert.strictEqual(businessTree.children.find(node => node.type === 'flow').selected,'review')
  for(const [id,value] of [['region','absent'],['records','absent'],['process','absent'],['places','absent'],['progress',42]]) assert.throws(()=>updateField(businessView,id,value),/GENERATIVE_UI_/)
  const { layoutFlow } = require(path.join(tmp,'ui/generative-ui/src/flow-layout.js'))
  const flow = businessTree.children.find(node=>node.type==='flow')
  const layout = layoutFlow(flow)
  assert.deepStrictEqual(layoutFlow(flow),layout,'flow geometry is deterministic')
  assert.strictEqual(layout.nodes.length,3)
  assert(layout.edges.every(edge=>edge.routed && edge.path && edge.arrow),'all example edges have routed arrows')
  assert(Object.isFrozen(businessTree.children.find(node=>node.type==='map').points))
  const sketch = businessTree.children.find(node=>node.type==='visual')
  assert.strictEqual(sketch.title,'离线静态示意图')
  assert.strictEqual(sketch.height,240)
  assert(sketch.html.includes('<svg') && Object.isFrozen(sketch))
  const source = example(1), original = clone(source)
  const first = createSurfaceView('session-A', source)
  assert.deepStrictEqual(source, original, 'view creation does not modify a persisted surface')
  source.title = 'mutated outside the view'
  source.state.factor = 5
  assert.strictEqual(first.surface.title, '季度收入', 'subsequent external mutations cannot alter the snapshot')
  assert.strictEqual(first.state.factor, 1)
  assert(Object.isFrozen(first) && Object.isFrozen(first.state) && Object.isFrozen(first.surface.components[2].series[0].values))
  assert.throws(() => { first.state.factor = 4 }, TypeError)

  const base = deriveChart(first, 'graph')
  assert.deepStrictEqual(base.labels, ['第一季', '<b>第二季</b>'], 'untrusted text stays data; no HTML interpretation is performed')
  assert.deepStrictEqual(base.series.map(item => item.values), [[2, 4], [-1, 0]])
  assert.deepStrictEqual(base.rows, [{ label: '第一季', values: [2, -1] }, { label: '<b>第二季</b>', values: [4, 0] }])
  assert(Object.isFrozen(base) && Object.isFrozen(base.rows[0].values))
  assert.deepStrictEqual(Object.keys(base).sort(), ['chartType', 'id', 'labels', 'rows', 'series', 'title'], 'no raw ECharts options or executable callbacks')
  const changed = updateSlider(first, 'scale', 2.5)
  assert.notStrictEqual(changed, first)
  assert.strictEqual(first.state.factor, 1, 'updates are immutable')
  assert.strictEqual(changed.state.factor, 2.5)
  assert.strictEqual(changed.state.note, 'unchanged')
  assert.deepStrictEqual(deriveChart(changed, 'graph').series.map(item => item.values), [[5, 10], [-2.5, 0]])
  assert.strictEqual(updateSlider(changed, 'scale', 2.5), changed, 'idempotent updates preserve identity')
  for (const value of [-0.5, 5.5, 2.3, Infinity, NaN, '2', null, {}]) {
    assert.throws(() => updateSlider(first, 'scale', value), /GENERATIVE_UI_(INVALID|VIEW_INVALID)/, 'reject invalid slider value ' + String(value))
  }
  for (const id of ['graph', 'send', 'missing', '__proto__']) assert.throws(() => updateSlider(first, id, 1), /GENERATIVE_UI_VIEW_INVALID/)
  assert.throws(() => deriveChart(first, 'scale'), /GENERATIVE_UI_VIEW_INVALID/)
  assert.throws(() => deriveChart({ ...first, state: { factor: 1 } }, 'graph'), /state keys differ/)
  assert.throws(() => deriveChart({ ...first, state: { ...first.state, extra: 1 } }, 'graph'), /state keys differ/)
  assert.throws(() => deriveChart({ ...first, state: { ...first.state, factor: 9 } }, 'graph'), /GENERATIVE_UI_INVALID/)

  const tree = prepareTree(changed)
  assert.strictEqual(tree.type, 'column')
  assert.deepStrictEqual(tree.children.map(child => child.id), ['description', 'graph', 'scale', 'send'], 'tree follows declared component order')
  assert.strictEqual(tree.children[0].text, '<img src=x onerror=alert(1)>', 'text remains data, not trusted HTML')
  assert.deepStrictEqual(tree.children[1].data.series[0].values, [5, 10], 'chart follows slider state')
  assert.deepStrictEqual(tree.children[2], { id: 'scale', type: 'slider', label: '倍数', value: 2.5, min: 0, max: 5, step: 0.5 })
  assert.deepStrictEqual(tree.children[3], { id: 'send', type: 'button', label: '分析', actionId: 'analyze', disabled: true, disabledReason: '交互回传尚未启用' }, 'no action is available without a trusted interaction host')
  assert(Object.isFrozen(tree.children) && Object.isFrozen(tree.children[1].data))
  assert.throws(() => prepareTree({ ...first, state: { factor: 7, note: 'x' } }), /GENERATIVE_UI_INVALID/)

  const shared = example(1)
  shared.components[0].children.push('secondScale')
  shared.components.push({ id: 'secondScale', type: 'slider', label: '上限 2', stateKey: 'factor', min: 0, max: 2, step: 1 })
  const sharedView = createSurfaceView('session-A', shared)
  assert.strictEqual(updateSlider(sharedView, 'scale', 2).state.factor, 2)
  assert.throws(() => updateSlider(sharedView, 'scale', 2.5), /slider range is invalid/)
  assert.throws(() => updateSlider(sharedView, 'scale', 1.5), /slider value is not aligned/)
  assert.strictEqual(sharedView.state.factor, 1)

  const formSurface = example(1)
  formSurface.state.confirmed = false
  formSurface.components[0].children.push('form')
  formSurface.components.push(
    { id: 'form', type: 'form', label: '筛选条件', children: ['input', 'mirror', 'check', 'send2'] },
    { id: 'input', type: 'input', label: '关键词', stateKey: 'note', maxLength: 16 },
    { id: 'mirror', type: 'input', label: '镜像', stateKey: 'note', maxLength: 10 },
    { id: 'check', type: 'checkbox', label: '包含归档', stateKey: 'confirmed' },
    { id: 'send2', type: 'button', label: '查询', actionId: 'analyze' }
  )
  const formView = createSurfaceView('session-A', formSurface)
  const typed = updateField(formView, 'input', '<b>数据</b>')
  assert.strictEqual(formView.state.note, 'unchanged', 'form updates are immutable')
  assert.strictEqual(typed.state.note, '<b>数据</b>', 'untrusted text remains data')
  assert.strictEqual(updateField(typed, 'mirror', '<b>数据</b>'), typed, 'unchanged inputs preserve identity')
  const toggled = updateField(typed, 'check', true)
  assert.strictEqual(toggled.state.confirmed, true)
  assert.strictEqual(formView.state.confirmed, false)
  const prepared = prepareTree(toggled).children.find(child => child.id === 'form')
  assert.strictEqual(prepared.type, 'form')
  assert.strictEqual(prepared.label, '筛选条件')
  assert.deepStrictEqual(prepared.children.map(child => child.type), ['input', 'input', 'checkbox', 'button'])
  assert.strictEqual(prepared.children[1].value, '<b>数据</b>', 'shared bindings follow local state')
  assert.strictEqual(prepared.children[2].value, true)
  assert.strictEqual(prepared.children[3].disabled, true, 'form buttons cannot execute actions in P1')
  for (const value of [null, 42, {}, true, 'x'.repeat(11), 'a\nb']) {
    assert.throws(() => updateField(formView, 'input', value), /GENERATIVE_UI_(INVALID|VIEW_INVALID)/)
  }
  for (const value of [null, 1, 'true', {}]) assert.throws(() => updateField(formView, 'check', value), /GENERATIVE_UI_VIEW_INVALID/)
  for (const id of ['form', 'scale', 'send2', 'missing', '__proto__']) assert.throws(() => updateField(formView, id, 'x'), /GENERATIVE_UI_VIEW_INVALID/)
  assert.strictEqual(formView.state.note, 'unchanged', 'invalid or conflicting shared values do not mutate state')

  // A presentation-state update is not a republished full surface. Near the
  // 48k surface cap, a valid value may have a longer textual representation.
  const nearLimit = example(1)
  for (let i = 0; i < 11; i += 1) {
    const id = 'padding' + i
    nearLimit.components[0].children.push(id)
    nearLimit.components.push({ id, type: 'text', text: 'x'.repeat(4000) })
  }
  nearLimit.components[0].children.push('tail')
  nearLimit.components.push({ id: 'tail', type: 'text', text: '' })
  const room = 48000 - JSON.stringify(nearLimit).length
  assert(room >= 0 && room <= 4000)
  nearLimit.components[nearLimit.components.length - 1].text = 'x'.repeat(room)
  const UI = require('../src/main/contracts/generative-ui')
  assert.strictEqual(JSON.stringify(nearLimit).length, 48000)
  UI.assertSurface(nearLimit)
  const nearView = updateSlider(createSurfaceView('session-A', nearLimit), 'scale', 2.5)
  assert.strictEqual(nearView.state.factor, 2.5)
  UI.assertSurfaceState(nearLimit, nearView.state)
  assert.throws(() => UI.assertSurface({ ...nearLimit, state: nearView.state }), /size limit/, 'the published-surface size cap itself remains unchanged')
  assert.throws(() => UI.assertSurfaceState(nearLimit, { factor: 2.5 }), /state keys differ/)
  assert.throws(() => UI.assertSurfaceState(nearLimit, { ...nearLimit.state, factor: 2.3 }), /not aligned/)

  const bar = example(1)
  bar.components[2].chartType = 'bar'
  delete bar.components[2].multiplierKey
  assert.deepStrictEqual(deriveChart(updateSlider(createSurfaceView('session-A', bar), 'scale', 2), 'graph').series[0].values, [2, 4], 'an unbound chart never follows unrelated state')

  const next = example(3); next.title = '新版'; next.state.factor = 3
  const latest = replaceSurfaceView(changed, 'session-A', next)
  assert.strictEqual(latest.surface.revision, 3)
  assert.strictEqual(latest.state.factor, 3, 'new model revision starts with its own published state')
  assert.strictEqual(replaceSurfaceView(latest, 'session-A', example(2)), latest, 'out-of-order updates are ignored')
  assert.strictEqual(replaceSurfaceView(latest, 'session-A', example(3)), latest, 'duplicate revision is ignored')
  assert.throws(() => replaceSurfaceView(latest, 'session-B', example(4)), /session mismatch/)
  const another = example(4); another.id = 'another'
  assert.throws(() => replaceSurfaceView(latest, 'session-A', another), /surface mismatch/)
  assert.throws(() => replaceSurfaceView(latest, 'session-A', { version: 3, id: 'sales', revision: 4 }), /GENERATIVE_UI_INVALID/)
  const otherSession = createSurfaceView('session-B', example(1))
  assert.strictEqual(otherSession.state.factor, 1, 'same surface id in another session has independent local state')
  assert.throws(() => createSurfaceView('', example(1)), /invalid session/)
  assert.throws(() => createSurfaceView('session-A', { ...example(1), version: 3 }), /unsupported surface version/)
  const injected = example(1); injected.components[2].option = { formatter: 'function(){return 1}' }
  assert.throws(() => createSurfaceView('session-A', injected), /not allowed/)
  const polluted = example(1); polluted.state = JSON.parse('{"__proto__":1}')
  assert.throws(() => createSurfaceView('session-A', polluted), /reserved key/)

  const part = (revision, toolCallId) => ({ type: 'ui', toolCallId, surface: example(revision) })
  const history = [
    { role: 'assistant', content: [{ type: 'text', text: '前文' }, part(1, 'create'), { type: 'text', text: '后文' }] },
    { role: 'user', content: [{ type: 'ui', toolCallId: 'not-assistant', surface: example(9) }] },
    { role: 'assistant', content: [part(3, 'newer'), { type: 'image', image_url: { url: 'asset' } }, part(2, 'out-of-order')] },
    { role: 'assistant', content: '旧字符串' }
  ]
  const beforeHistory = clone(history)
  const projected = projectMessages('session-A', history)
  assert.deepStrictEqual(history, beforeHistory, 'projection never mutates persisted history')
  assert(projected.every(message => message.sessionId === 'session-A'), 'projections carry their originating session')
  assert.throws(() => projectMessages('', history), /invalid session/)
  assert.deepStrictEqual(projected[0].parts.map(item => item.kind), ['text', 'superseded', 'text'])
  assert.strictEqual(projected[1].parts[0].kind, 'other', 'a non-assistant UI block is never rendered')
  assert.deepStrictEqual(projected[2].parts.map(item => item.kind), ['ui', 'other', 'superseded'])
  assert.strictEqual(projected[2].parts[0].surface.revision, 3)
  assert.strictEqual(projected[3].parts[0].text, '旧字符串')
  const futureHistory = history.concat([
    { role: 'assistant', content: [{ type: 'ui', toolCallId: 'future', surface: { version: 3, id: 'sales', revision: 4, opaque: 'not executable' } }] },
    { role: 'assistant', content: [part(5, 'future-downgrade')] }
  ])
  const futureProjected = projectMessages('session-A', futureHistory)
  assert.strictEqual(futureProjected[2].parts[0].kind, 'superseded')
  assert.strictEqual(futureProjected[4].parts[0].kind, 'unavailable')
  assert.strictEqual(futureProjected[5].parts[0].kind, 'superseded', 'an opaque future version prevents downgrade even if v1 revision is higher')
  const malformed = part(4, 'bad'); malformed.surface.components[2].option = { formatter: 'bad' }
  const afterInvalid = projectMessages('session-A', [history[0], { role: 'assistant', content: [malformed] }, { role: 'assistant', content: [part(5, 'stale')] }])
  assert.strictEqual(afterInvalid[0].parts[1].kind, 'superseded')
  assert.strictEqual(afterInvalid[1].parts[0].kind, 'unavailable')
  assert.strictEqual(afterInvalid[2].parts[0].kind, 'superseded', 'invalid replacements do not expose stale interactive UI')
  assert.strictEqual(projectMessages('session-B', [{ role: 'assistant', content: [part(1, 'other-session')] }])[0].parts[0].kind, 'ui', 'independent session projections never share state')

  const lightPlan = makeChartPlan(base, 'light')
  assert.strictEqual(lightPlan.option.tooltip.renderMode, 'richText', 'tooltips must not create HTML')
  assert.strictEqual(lightPlan.option.tooltip.trigger, 'axis')
  assert.strictEqual(lightPlan.option.legend.show, true)
  assert.strictEqual(lightPlan.option.aria.enabled, true)
  assert.deepStrictEqual(lightPlan.option.xAxis.data, base.labels, 'labels remain canvas text')
  assert.deepStrictEqual(lightPlan.option.series[0].data, [2, 4])
  assert.strictEqual(lightPlan.option.series[0].itemStyle.color, '#2a78d6')
  assert.strictEqual(lightPlan.option.series[0].endLabel.show, true)
  assert.notStrictEqual(lightPlan.option.series[0].symbol, lightPlan.option.series[1].symbol, 'series also have non-color encoding')
  const reversed = { ...base, series: base.series.slice().reverse() }
  const darkPlan = makeChartPlan(reversed, 'dark', lightPlan.colors, true)
  assert.strictEqual(darkPlan.option.aria.decal.show, true)
  assert.strictEqual(darkPlan.option.series.find(item => item.id === 'income').itemStyle.color, '#3987e5', 'surviving series retain their slot when reordered')
  assert.strictEqual(darkPlan.option.series.find(item => item.id === 'cost').itemStyle.color, '#d95926')
  const temporarilyHidden = makeChartPlan({ ...base, series: [base.series[1]] }, 'light', lightPlan.colors)
  const restored = makeChartPlan(base, 'light', temporarilyHidden.colors)
  assert.strictEqual(restored.option.series[0].itemStyle.color, '#2a78d6', 'a restored series retains a free historical slot')
  const extra = { id: 'third', name: '<script>bad()</script>', values: [3, 4] }
  const filtered = makeChartPlan({ ...base, series: [base.series[1], extra] }, 'light', lightPlan.colors)
  assert.strictEqual(filtered.option.series[0].itemStyle.color, '#eb6834', 'removing a peer never repaints a surviving series')
  assert.strictEqual(filtered.option.series[1].itemStyle.color, '#2a78d6', 'new visible series can reuse a released slot')
  assert(filtered.option.series[1].name.includes('<script>'), 'untrusted names are data, not formatter code')
  assert.strictEqual(filtered.option.tooltip.renderMode, 'richText')
  const barPlan = makeChartPlan(deriveChart(createSurfaceView('session-A', bar), 'graph'), 'light')
  assert.deepStrictEqual(barPlan.option.series[1].data[0], { value: -1, itemStyle: { borderRadius: [0, 0, 4, 4] } })
  assert.deepStrictEqual(barPlan.option.series[0].data[0], { value: 2, itemStyle: { borderRadius: [4, 4, 0, 0] } })
  assert.strictEqual(barPlan.option.series[0].markPoint.label.show, true, 'direct label is selective')
  assert.notStrictEqual(barPlan.option.series[0].markPoint.symbol, 'none', 'ECharts otherwise suppresses the marker label')
  assert.strictEqual(barPlan.option.series[0].markPoint.itemStyle.color, 'transparent')
  assert.throws(() => makeChartPlan(base, 'unknown'), /theme/)
  assert.throws(() => makeChartPlan(base, 'light', [{ id: 'income', slot: 0 }, { id: 'cost', slot: 0 }]), /color assignment/)
  assert.throws(() => makeChartPlan({ ...base, series: [base.series[0], base.series[0]] }, 'light'), /series/)

  // This controller section uses deterministic adapters, not Vue/ECharts.
  // The separate browser smoke runs real Electron and the installed libraries.
  let nextFrame = 0, pending = new Map(), size = { connected: false, width: 0, height: 0 }
  const calls = [], errors = []
  const chart = {
    setOption(option, replace) { calls.push(['setOption', option, replace]) },
    resize() { calls.push(['resize']) },
    dispose() { calls.push(['dispose']) }
  }
  const environment = {
    measure: () => size,
    create() { calls.push(['create']); return chart },
    requestFrame(callback) { const id = ++nextFrame; pending.set(id, callback); return id },
    cancelFrame(id) { pending.delete(id); calls.push(['cancel', id]) },
    onError(error) { errors.push(error) }
  }
  function runFrame() {
    const entry = pending.entries().next().value
    assert(entry, 'a frame must be queued')
    pending.delete(entry[0]); entry[1]()
  }
  const controller = createChartController(environment)
  controller.update({ serial: 1 }); controller.update({ serial: 2 }); controller.notifyLayout()
  assert.strictEqual(pending.size, 1, 'updates and resize coalesce into one frame')
  runFrame()
  assert.strictEqual(calls.length, 0, 'detached/zero-sized hosts never initialize')
  assert.strictEqual(pending.size, 0, 'detached hosts do not spin')
  size = { connected: true, width: 400, height: 240 }
  controller.notifyLayout(); runFrame()
  assert.deepStrictEqual(calls, [['create'], ['setOption', { serial: 2 }, true], ['resize']])
  controller.notifyLayout(); controller.notifyLayout(); runFrame()
  assert.deepStrictEqual(calls.slice(-1), [['resize']])
  controller.update({ serial: 3 }); controller.dispose(); controller.dispose()
  assert.strictEqual(pending.size, 0, 'unmount cancels scheduled work')
  assert.strictEqual(calls.filter(call => call[0] === 'dispose').length, 1, 'dispose occurs once')
  controller.update({ serial: 4 }); controller.notifyLayout()
  assert.strictEqual(pending.size, 0, 'disposed views cannot resurrect')
  assert.strictEqual(errors.length, 0)

  let aborted = 0, early
  const earlyEnv = { ...environment, create() { early.dispose(); return { ...chart, dispose() { aborted++ } } } }
  early = createChartController(earlyEnv); early.update({ serial: 1 }); runFrame()
  assert.strictEqual(aborted, 1, 'teardown during initialization releases the returned instance')
  let reentrant, reentered = false
  const seenUpdates = []
  const reentrantEnv = { ...environment, create() { return { ...chart, setOption(option) { seenUpdates.push(option.serial); if (!reentered) { reentered = true; reentrant.update({ serial: 2 }) } } } } }
  reentrant = createChartController(reentrantEnv); reentrant.update({ serial: 1 }); runFrame()
  assert.strictEqual(pending.size, 1, 'a reentrant update gets its own frame')
  runFrame(); assert.deepStrictEqual(seenUpdates, [1, 2]); reentrant.dispose()
  let brokenDisposed = 0, reported = 0
  const brokenEnv = { ...environment, create() { return { ...chart, setOption() { throw new Error('chart failed') }, dispose() { brokenDisposed++ } } }, onError() { reported++ } }
  const broken = createChartController(brokenEnv); broken.update({ serial: 1 }); runFrame()
  assert.strictEqual(brokenDisposed, 1); assert.strictEqual(reported, 1)
  broken.update({ serial: 2 }); broken.notifyLayout()
  assert.strictEqual(pending.size, 0, 'failed renderer waits for explicit remount')
  broken.dispose(); assert.strictEqual(brokenDisposed, 1)

  const trusted = Object.fromEntries(COMPONENT_KINDS.map(kind => [kind, Object.freeze({ kind })]))
  const registry = createComponentRegistry(trusted)
  assert.strictEqual(registry.resolve('chart'), trusted.chart)
  trusted.chart = Object.freeze({ kind: 'swapped' })
  assert.strictEqual(registry.resolve('chart').kind, 'chart', 'later changes to the input cannot replace trusted entries')
  for (const name of ['__proto__', 'constructor', 'option', '../chart', 'https://example.invalid/a.js', '', null]) assert.throws(() => registry.resolve(name), /unsupported component/)
  assert.throws(() => createComponentRegistry({ ...trusted, chart: 'https://example.invalid/chart.js' }), /untrusted component/)
  const missing = { ...trusted }; delete missing.chart
  assert.throws(() => createComponentRegistry(missing), /built-in kinds/)
  assert.throws(() => createComponentRegistry({ ...trusted, script: {} }), /built-in kinds/)
  assertComponentRegistry(registry)
  assert.throws(() => assertComponentRegistry({ resolve: () => ({}) }), /trusted assembly/)
  const builder = createComponentRegistryBuilder()
  assert.throws(() => builder.register('script', {}), /unsupported component/)
  assert.throws(() => builder.register('chart', 'https://invalid.example/code.js'), /untrusted component/)
  assert.throws(() => builder.replace('chart', {}), /missing component/)
  assert.throws(() => builder.build(), /built-in kinds/)
  for (const [kind, component] of Object.entries(trusted)) builder.register(kind, component)
  assert.throws(() => builder.register('chart', {}), /duplicate component/)
  const replacement = Object.freeze({ kind: 'trusted replacement' })
  builder.replace('chart', replacement)
  const custom = builder.build()
  assert.strictEqual(custom.resolve('chart'), replacement)
  assert.throws(() => builder.replace('chart', {}), /sealed/)
  assert.throws(() => builder.register('chart', {}), /sealed/)
  assert.throws(() => builder.build(), /sealed/)
  assert.strictEqual(custom.resolve('chart'), replacement)
  await checkInteractionController()
  console.log('Generative UI P1/P2 view foundations OK: exact P0 validator, strict TypeScript, immutable session-scoped view, bounded shared control bindings, form fields, stale revisions, chart/table data, safe chart configuration, lifecycle, mixed-message projection, display-only tree, sealed trusted registry and draft SFC syntax and real-library script types; P2 controller IO coalescing, confirmation, conflicts, lost responses, snapshot isolation, disposal and schema binding passed')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
