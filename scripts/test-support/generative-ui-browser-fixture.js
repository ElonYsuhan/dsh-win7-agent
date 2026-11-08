'use strict'

// Test-only page, loaded from a loopback server into an isolated sandboxed
// Electron window. Never installed or shipped as a renderer.
;(function () {
  const sessionId = 'generative-ui-test-session'
  let mounted = null
  let messageMounts = []
  let host = null
  let fragment = null
  let surface = null
  let theme = 'light'
  const violations = []
  window.addEventListener('securitypolicyviolation', event => {
    violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI })
  })

  function example(revision, chartType) {
    return {
      version: 1,
      id: 'sales',
      revision,
      title: '季度收入分析',
      root: 'layout',
      state: { factor: 1 },
      components: [
        { id: 'layout', type: 'column', children: ['description', 'graph', 'scale', 'send'] },
        { id: 'description', type: 'text', text: '拖动滑块调整数据。<img src="https://invalid.example/test" onerror="window.__unexpectedExecution=1">' },
        { id: 'graph', type: 'chart', chartType, title: '收入与成本', labels: ['第一季度', '<b>第二季度</b>', '第三季度'], series: [
          { id: 'revenue', name: '收入', values: [2, 4, 7] },
          { id: 'cost', name: '成本', values: [-1, 0, 3] }
        ], multiplierKey: 'factor' },
        { id: 'scale', type: 'slider', label: '调整倍数', stateKey: 'factor', min: 0, max: 5, step: 0.5 },
        { id: 'send', type: 'button', label: '分析数据', actionId: 'analyze' }
      ],
      actions: [{ id: 'analyze', type: 'ask_agent', message: '分析当前数据', stateKeys: ['factor'] }]
    }
  }
  function dispose() {
    if (mounted) mounted.dispose()
    for (const item of messageMounts) item.dispose()
    messageMounts = []
    mounted = null
    if (host) host.remove()
    host = null
    fragment = null
  }
  function mount(attached, chartType) {
    dispose()
    surface = example(1, chartType || 'line')
    host = document.createElement('div')
    host.className = 'test-host'
    fragment = document.createDocumentFragment()
    fragment.appendChild(host)
    mounted = window.AgentGenerativeUI.mountSurface(host, { sessionId, surface, theme })
    if (attached) attach()
  }
  function attach() {
    if (fragment) document.getElementById('stage').appendChild(fragment)
    fragment = null
  }
  function update(revision, chartType, nextTheme) {
    if (nextTheme) {
      theme = nextTheme
      document.documentElement.dataset.theme = nextTheme
    }
    if (revision !== null) surface = example(revision, chartType || 'line')
    mounted.update({ sessionId, surface, theme })
  }
  function sharedBinding() {
    surface = example(3, 'bar')
    surface.components.find(item => item.id === 'scale').label = '调整倍数（新）'
    surface.components[0].children.push('secondScale')
    surface.components.push({ id: 'secondScale', type: 'slider', label: '整数倍数', stateKey: 'factor', min: 0, max: 2, step: 1 })
    mounted.update({ sessionId, surface, theme })
  }
  function mountForm(customRenderer) {
    dispose()
    theme = 'light'; document.documentElement.dataset.theme = theme
    surface = {
      version: 1, id: 'formtest', revision: 1, title: '条件表单', root: 'group',
      state: { note: '初', confirmed: false },
      components: [
        { id: 'group', type: 'form', label: '筛选参数', children: ['description', 'query', 'mirror', 'check', 'mirrorCheck', 'send'] },
        { id: 'description', type: 'text', text: '<img src=x onerror=window.__unexpectedExecution=1>' },
        { id: 'query', type: 'input', label: '关键词', stateKey: 'note', maxLength: 12 },
        { id: 'mirror', type: 'input', label: '镜像关键词', stateKey: 'note', maxLength: 5 },
        { id: 'check', type: 'checkbox', label: '包含归档', stateKey: 'confirmed' },
        { id: 'mirrorCheck', type: 'checkbox', label: '镜像勾选', stateKey: 'confirmed' },
        { id: 'send', type: 'button', label: '提交', actionId: 'analyze' }
      ],
      actions: [{ id: 'analyze', type: 'ask_agent', message: '分析', stateKeys: ['note', 'confirmed'] }]
    }
    host = document.createElement('div'); host.className = 'test-host'
    document.getElementById('stage').appendChild(host)
    let registry
    if (customRenderer) {
      const vue = window.AgentUIVendor.vue
      const builder = window.AgentGenerativeUI.createRendererRegistryBuilder()
      builder.replace('text', vue.defineComponent({
        props: ['node'], setup(props) { return () => vue.h('p', { class: 'trusted-custom' }, props.node.text) }
      }))
      registry = builder.build()
      try { builder.replace('text', {}); throw new Error('sealed builder accepted a replacement') } catch (error) {
        if (!String(error.message).includes('sealed')) throw error
      }
    }
    mounted = window.AgentGenerativeUI.mountSurface(host, { sessionId, surface, theme }, registry)
  }
  function formTheme(nextTheme) {
    theme = nextTheme; document.documentElement.dataset.theme = theme
    mounted.update({ sessionId, surface, theme })
  }
  function invalidFuture() {
    mounted.update({ sessionId, surface: { version: 3, id: 'sales', revision: 4 }, theme })
  }
  function mismatch() {
    try {
      mounted.update({ sessionId: 'different-session', surface, theme })
      return false
    } catch (_) { return true }
  }
  function mountHistory(withFuture) {
    dispose()
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: '前文' }, { type: 'ui', toolCallId: 'history-one', surface: example(1, 'line') }, { type: 'text', text: '后文' }] },
      { role: 'assistant', content: [{ type: 'ui', toolCallId: 'history-two', surface: example(2, 'bar') }] }
    ]
    if (withFuture) messages.push({ role: 'assistant', content: [{ type: 'ui', toolCallId: 'history-future', surface: { version: 3, id: 'sales', revision: 3 } }] })
    const projected = window.AgentGenerativeUI.projectMessages(sessionId, messages)
    host = document.createElement('div')
    host.className = 'test-host'
    fragment = document.createDocumentFragment()
    fragment.appendChild(host)
    for (const message of projected) {
      const node = document.createElement('div')
      node.className = 'test-message'
      host.appendChild(node)
      messageMounts.push(window.AgentGenerativeUI.mountMessage(node, { sessionId, message, theme }))
    }
    let mismatchRejected = false
    try { window.AgentGenerativeUI.mountMessage(document.createElement('div'), { sessionId: 'other-session', message: projected[0], theme }) } catch (_) { mismatchRejected = true }
    attach()
    return mismatchRejected
  }
  function mountVisual() {
    dispose()
    theme = 'light'; document.documentElement.dataset.theme = theme
    surface = {
      version: 2, id: 'visualtest', revision: 1, title: '静态沙箱页面', root: 'visual', state: {},
      components: [{
        id: 'visual', type: 'visual', title: '沙箱页面', height: 260,
        html: '<style>.safe{fill:#1f8a7a}</style><svg viewBox="0 0 80 60" onload="window.parent.__visualOnload=1"><circle class="safe" cx="24" cy="30" r="14"/><script>window.parent.__visualScript=1</script><a href="https://invalid.example/link">外部</a><image href="https://invalid.example/x.png"/></svg><iframe src="https://invalid.example/frame"></iframe>'
      }],
      actions: []
    }
    host = document.createElement('div'); host.className = 'test-host'
    document.getElementById('stage').appendChild(host)
    mounted = window.AgentGenerativeUI.mountSurface(host, { sessionId, surface, theme })
  }
  async function mountBusiness(withoutWebgl) {
    dispose()
    if (!window.__originalContext) {
      window.__originalContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (kind, options) {
        if (window.__withoutWebgl && /^webgl|^experimental-webgl/.test(kind)) return null
        return window.__originalContext.call(this, kind, options)
      }
    }
    window.__withoutWebgl = Boolean(withoutWebgl)
    const response = await window.fetch('/business-surface.json')
    surface = await response.json()
    host = document.createElement('div'); host.className = 'test-host'
    document.getElementById('stage').appendChild(host)
    mounted = window.AgentGenerativeUI.mountSurface(host, { sessionId, surface, theme })
  }
  window.__guiFixture = { mountVisual, mountBusiness, mount, attach, update, sharedBinding, mountForm, formTheme, invalidFuture, mismatch, mountHistory, dispose, violations }
})()
