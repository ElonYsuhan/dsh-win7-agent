'use strict'

/**
 * Runtime Telemetry UI（第三阶段）
 *
 * 定位：**纯展示层**。只经 window.dsh.telemetryRequest / onTelemetry 取数，
 * 拿不到任何写方法，也不持有会话状态——会话 id 由宿主回调给出，不另存一份。
 *
 * 展示约定（硬性）：
 *   - 未知数据一律显示「—」，绝不显示 0（0 只在计数类是真实值时才出现）
 *   - Context 是估算口径，必须带「≈」与「估算」标注
 *   - TPS 仅当 provider 真实回传 usage 时展示，否则「—」
 *   - 不渲染提示词、消息正文、工具参数、地址——数据源本身就不含这些字段
 */

;(function (root) {
  const doc = root.document
  const DASH = '\u2014'
  const RING_CIRCUMFERENCE = 2 * Math.PI * 6.5

  let host = null /* { getSessionId, getSettings } */
  const refs = {}
  const state = {
    mounted: false,
    disposed: false,
    summary: null,
    panelOpen: false,
    panelKind: '',
    panelTimer: null,
    offTelemetry: null,
    offKey: null,
    offClick: null
  }

  /* ── 小工具 ─────────────────────────────────────────────────── */
  function el(tag, className, text) {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }
  function isNum(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)) }
  /** 千分位；未知返回 — */
  function fmtInt(value) {
    if (!isNum(value)) return DASH
    return String(Math.round(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }
  /** 耗时自动换算单位 */
  function fmtDuration(ms) {
    if (!isNum(ms)) return DASH
    const n = Number(ms)
    if (n < 1000) return Math.round(n) + ' ms'
    if (n < 60000) return (n / 1000).toFixed(2) + ' s'
    return Math.floor(n / 60000) + ' 分 ' + Math.round((n % 60000) / 1000) + ' 秒'
  }
  function fmtTps(value) { return isNum(value) ? Number(value).toFixed(1) : DASH }
  function fmtPct(value) { return isNum(value) ? Math.round(Number(value) * 100) + '%' : DASH }
  function fmtBytes(bytes) {
    if (!isNum(bytes)) return DASH
    const n = Number(bytes)
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / (1024 * 1024)).toFixed(2) + ' MB'
  }
  /** 估算值展示：带 ≈ 前缀 */
  function fmtEstimate(value) { return isNum(value) ? '\u2248 ' + fmtInt(value) : DASH }

  const STATUS_LABELS = {
    running: '进行中', completed: '已完成', cancelled: '已停止', failed: '出错',
    timed_out: '超时', blocked: '受阻', exhausted: '达上限', interrupted: '已中断'
  }
  function statusLabel(status) { return STATUS_LABELS[status] || status || DASH }

  /* ── 状态栏三指标 ───────────────────────────────────────────── */
  function makePill(kind, label) {
    const button = el('button', 'tm-pill tm-pill-' + kind)
    button.type = 'button'
    button.dataset.telemetryKind = kind
    button.setAttribute('aria-haspopup', 'dialog')
    button.setAttribute('aria-expanded', 'false')
    button.appendChild(el('span', 'tm-pill-label', label))
    const value = el('span', 'tm-pill-value', DASH)
    button.appendChild(value)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      togglePanel(kind, button)
    })
    return { button: button, value: value }
  }

  function makeRing() {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('class', 'tm-ring')
    svg.setAttribute('aria-hidden', 'true')
    const bg = doc.createElementNS('http://www.w3.org/2000/svg', 'circle')
    bg.setAttribute('cx', '8'); bg.setAttribute('cy', '8'); bg.setAttribute('r', '6.5')
    bg.setAttribute('class', 'tm-ring-bg')
    const fg = doc.createElementNS('http://www.w3.org/2000/svg', 'circle')
    fg.setAttribute('cx', '8'); fg.setAttribute('cy', '8'); fg.setAttribute('r', '6.5')
    fg.setAttribute('class', 'tm-ring-fg')
    fg.setAttribute('stroke-dasharray', RING_CIRCUMFERENCE.toFixed(2))
    fg.setAttribute('stroke-dashoffset', RING_CIRCUMFERENCE.toFixed(2))
    fg.setAttribute('transform', 'rotate(-90 8 8)')
    svg.appendChild(bg); svg.appendChild(fg)
    return { svg: svg, fg: fg }
  }

  function mount(options) {
    if (state.mounted || !doc) return false
    host = options || {}
    const toolbar = doc.querySelector('.composer-toolbar .toolbar-right')
    if (!toolbar) return false

    const group = el('div', 'tm-group')
    group.id = 'telemetryGroup'
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', '运行时监控')

    refs.token = makePill('token', 'Token')
    refs.tps = makePill('tps', 'TPS')
    refs.context = makePill('context', 'Context')
    const ring = makeRing()
    refs.context.button.insertBefore(ring.svg, refs.context.value)
    refs.ring = ring

    group.appendChild(refs.token.button)
    group.appendChild(refs.tps.button)
    group.appendChild(refs.context.button)
    /* 放在用量估算之前，与模型下拉分开 */
    toolbar.insertBefore(group, toolbar.firstChild)
    refs.group = group

    ensurePanel()
    subscribe()
    state.mounted = true
    refresh()
    return true
  }

  /* ── 数据订阅 ───────────────────────────────────────────────── */
  function subscribe() {
    if (typeof root.dsh === 'undefined') return
    if (typeof root.dsh.onTelemetry === 'function') {
      state.offTelemetry = root.dsh.onTelemetry((payload) => {
        if (state.disposed || !payload || !Array.isArray(payload.sessions)) return
        const mine = payload.sessions.find((item) => item.sessionId === currentSessionId())
        if (mine) { state.summary = mine; renderPills() }
      })
    }
  }

  function currentSessionId() {
    try { return String((host && host.getSessionId && host.getSessionId()) || '') } catch (error) { return '' }
  }

  async function refresh() {
    const sessionId = currentSessionId()
    if (!sessionId || typeof root.dsh === 'undefined' || typeof root.dsh.telemetryRequest !== 'function') {
      state.summary = null
      renderPills()
      return
    }
    try {
      const result = await root.dsh.telemetryRequest('get', { sessionId: sessionId })
      if (state.disposed) return
      const metrics = result && result.metrics
      state.summary = metrics ? buildSummary(metrics) : null
      renderPills()
    } catch (error) {
      if (state.disposed) return
      state.summary = null
      renderPills()
    }
  }

  /** 与主进程 summarize 同构：UI 侧兜底一份，避免版本错位时整块空白 */
  function buildSummary(metrics) {
    const turns = Array.isArray(metrics.turns) ? metrics.turns : []
    const current = turns.length > 0 ? turns[turns.length - 1] : null
    const context = metrics.context || {}
    const usage = metrics.usage || {}
    const turnUsage = (current && current.usage) || {}
    const isProvider = (value) => value === 'provider'
    return {
      sessionId: metrics.sessionId,
      running: Boolean(metrics.running),
      status: current ? current.status : null,
      turnUsage: {
        dataClass: turnUsage.source || turnUsage.dataClass || 'unknown',
        promptTokens: isProvider(turnUsage.source) ? turnUsage.promptTokens : null,
        completionTokens: isProvider(turnUsage.source) ? turnUsage.completionTokens : null
      },
      sessionUsage: {
        dataClass: usage.dataClass || 'unknown',
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cacheHitRate: usage.cacheHitRate
      },
      tps: current && isNum(current.tps) ? current.tps : metrics.tps,
      tpsDataClass: (current && current.tpsDataClass) || (isNum(metrics.tps) ? 'provider' : 'unknown'),
      contextTokens: context.totalTokens,
      contextMethod: context.method || 'estimated',
      modelRequests: metrics.modelRequests || 0,
      toolCalls: metrics.toolCalls || 0
    }
  }

  function renderPills() {
    if (!refs.token) return
    const summary = state.summary

    /* Token：本轮输入 / 输出。无 provider 数据 → — */
    const turn = (summary && summary.turnUsage) || {}
    if (turn.dataClass === 'provider') {
      refs.token.value.textContent = fmtInt(turn.promptTokens) + ' / ' + fmtInt(turn.completionTokens)
      refs.token.button.title = '本轮输入 ' + fmtInt(turn.promptTokens) + ' / 输出 ' + fmtInt(turn.completionTokens) + ' token（供应商回传）'
    } else {
      refs.token.value.textContent = DASH
      refs.token.button.title = '本轮暂无供应商 token 数据（不伪造为 0）'
    }

    /* TPS：只在 provider 口径下展示 */
    if (summary && summary.tpsDataClass === 'provider' && isNum(summary.tps)) {
      refs.tps.value.textContent = fmtTps(summary.tps)
      refs.tps.button.title = '模型生成速度 ' + fmtTps(summary.tps) + ' token/秒（供应商真实输出计算）'
    } else {
      refs.tps.value.textContent = DASH
      refs.tps.button.title = '无供应商 usage 时不计算 TPS（估算 token 会虚高）'
    }

    /* Context：估算口径，必须带 ≈ 与「估算」标注 */
    const settings = (host && host.getSettings && host.getSettings()) || {}
    const limit = Number(settings.contextWindowTokens) || 0
    if (summary && isNum(summary.contextTokens)) {
      refs.context.value.textContent = fmtEstimate(summary.contextTokens)
      refs.context.button.title = '上下文占用 ' + fmtEstimate(summary.contextTokens) + ' token（本地估算，含系统提示词与工具定义；非供应商计费数据）'
      if (limit > 0) {
        const ratio = Math.max(0, Math.min(1, Number(summary.contextTokens) / limit))
        refs.ring.fg.setAttribute('stroke-dashoffset', (RING_CIRCUMFERENCE * (1 - ratio)).toFixed(2))
        refs.context.button.title += '，约占窗口 ' + fmtPct(ratio)
      }
    } else {
      refs.context.value.textContent = DASH
      refs.context.button.title = '尚无上下文估算数据'
    }

    /* 运行态：让指标条在跑的时候有视觉反馈 */
    if (refs.group) refs.group.classList.toggle('tm-running', Boolean(summary && summary.running))
  }

  /* ── 浮动详情面板 ───────────────────────────────────────────── */
  function ensurePanel() {
    if (refs.panel) return refs.panel
    const panel = el('div', 'tm-panel hidden')
    panel.id = 'telemetryPanel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', '运行时监控详情')

    const head = el('div', 'tm-panel-head')
    refs.panelTitle = el('span', 'tm-panel-title', '运行时监控')
    const close = el('button', 'tm-panel-close', '\u00d7')
    close.type = 'button'
    close.setAttribute('aria-label', '关闭')
    close.addEventListener('click', () => closePanel())
    head.appendChild(refs.panelTitle)
    head.appendChild(close)

    refs.panelBody = el('div', 'tm-panel-body')
    const foot = el('div', 'tm-panel-foot', '仅本次运行的内存数据，未持久化；不含提示词、消息正文与工具参数。')
    panel.appendChild(head)
    panel.appendChild(refs.panelBody)
    panel.appendChild(foot)
    doc.body.appendChild(panel)
    refs.panel = panel
    return panel
  }

  function kv(key, value, extraClass) {
    const row = el('div', 'tm-kv' + (extraClass ? ' ' + extraClass : ''))
    row.appendChild(el('span', 'tm-k', key))
    row.appendChild(el('span', 'tm-v', value))
    return row
  }

  function section(id, title, rows) {
    const box = el('section', 'tm-section')
    box.id = 'tm-sec-' + id
    box.appendChild(el('h4', 'tm-section-title', title))
    const wrap = el('div', 'tm-section-rows')
    for (const row of rows) if (row) wrap.appendChild(row)
    box.appendChild(wrap)
    return box
  }

  function renderPanel(panel) {
    const body = refs.panelBody
    body.textContent = ''
    if (!panel) {
      body.appendChild(el('p', 'tm-empty', '暂无数据（本会话尚未产生运行记录）'))
      return
    }
    const model = panel.model || {}
    const perf = panel.perf || {}
    const ctx = panel.context || {}
    const tools = panel.tools || {}
    const usage = model.usage || {}
    const provider = usage.dataClass === 'provider'

    /* 区域一：模型调用 */
    body.appendChild(section('model', '模型调用', [
      kv('本轮请求数', String(model.requests || 0)),
      kv('请求耗时', fmtDuration(model.durationMs)),
      kv('首字延迟 TTFT', fmtDuration(model.ttftMs)),
      kv('输入 Token', provider ? fmtInt(usage.promptTokens) : DASH),
      kv('输出 Token', provider ? fmtInt(usage.completionTokens) : DASH),
      kv('总 Token', provider ? fmtInt(usage.totalTokens) : DASH),
      kv('数据口径', provider ? '供应商真实回传' : '未知（不伪造）'),
      kv('本轮状态', statusLabel(panel.turnStatus) + (panel.turnReason ? ' · ' + panel.turnReason : ''))
    ]))

    /* 区域二：性能指标 */
    body.appendChild(section('perf', '性能指标', [
      kv('TPS', perf.tpsDataClass === 'provider' ? fmtTps(perf.tps) + ' tok/s' : DASH),
      kv('本轮总耗时', fmtDuration(perf.turnDurationMs)),
      kv('模型累计耗时', fmtDuration(perf.modelDurationMs)),
      kv('工具累计耗时', fmtDuration(perf.toolDurationMs)),
      kv('请求次数', String(perf.requestCount || 0)),
      kv('轮次 / 步数', (perf.turnCount || 0) + ' / ' + (perf.steps || 0)),
      kv('重试次数', String(perf.retries || 0))
    ]))

    /* 区域三：上下文分析（估算） */
    const ctxRows = [
      kv('总量', fmtEstimate(ctx.totalTokens)),
      kv('System', fmtEstimate(ctx.systemTokens)),
      kv('工具定义', fmtEstimate(ctx.toolDefinitionTokens)),
      kv('对话历史', fmtEstimate(ctx.conversationTokens)),
      kv('图片', fmtEstimate(ctx.imageTokens)),
      kv('记忆段', ctx.memoryTokens === 0 ? '0（并入 System）' : fmtEstimate(ctx.memoryTokens)),
      kv('消息 / 工具数', (ctx.messageCount || 0) + ' / ' + (ctx.toolCount || 0))
    ]
    const ctxSection = section('context', '上下文分析（估算）', ctxRows)
    ctxSection.appendChild(el('p', 'tm-note', '本地估算，用于看占比；不能当计费依据。' + (ctx.notes ? ' ' + ctx.notes : '')))
    body.appendChild(ctxSection)

    /* 区域四：工具执行 */
    const toolRows = [
      kv('调用次数', String(tools.calls || 0)),
      kv('成功 / 失败 / 取消', (tools.completed || 0) + ' / ' + (tools.failed || 0) + ' / ' + (tools.cancelled || 0)),
      kv('总耗时', fmtDuration(tools.durationMs)),
      kv('结果体积合计', fmtBytes(tools.resultBytesTotal)),
      kv('缓存命中率', provider ? fmtPct(tools.cacheHitRate) : DASH)
    ]
    const toolSection = section('tools', '工具执行', toolRows)
    if (Array.isArray(tools.items) && tools.items.length > 0) {
      const list = el('div', 'tm-tool-list')
      const shown = tools.items.slice(0, 12)
      for (const item of shown) {
        const row = el('div', 'tm-tool-row')
        row.appendChild(el('span', 'tm-tool-name', item.toolName || 'unknown'))
        row.appendChild(el('span', 'tm-tool-status state-' + (item.status || ''), statusLabel(item.status)))
        row.appendChild(el('span', 'tm-tool-dur', fmtDuration(item.durationMs)))
        row.appendChild(el('span', 'tm-tool-size', fmtBytes(item.resultBytes)))
        list.appendChild(row)
      }
      if (tools.items.length > shown.length) {
        list.appendChild(el('div', 'tm-tool-more', '… 另有 ' + (tools.items.length - shown.length) + ' 项'))
      }
      toolSection.appendChild(list)
    }
    body.appendChild(toolSection)
  }

  function togglePanel(kind, anchor) {
    if (state.panelOpen && state.panelKind === kind) { closePanel(); return }
    openPanel(kind, anchor)
  }

  async function openPanel(kind, anchor) {
    ensurePanel()
    state.panelOpen = true
    state.panelKind = kind
    refs.panel.classList.remove('hidden')
    for (const key of ['token', 'tps', 'context']) {
      if (refs[key]) refs[key].button.setAttribute('aria-expanded', String(refs[key] === refs[kind]))
    }
    const titles = { token: '模型调用', tps: '性能指标', context: '上下文分析' }
    refs.panelTitle.textContent = '运行时监控 · ' + (titles[kind] || '')
    positionPanel(anchor)
    await pollPanel(kind)
    stopPanelPoll()
    state.panelTimer = setInterval(() => pollPanel(kind), 600)
    if (state.panelTimer && typeof state.panelTimer.unref === 'function') state.panelTimer.unref()
  }

  async function pollPanel(kind) {
    const sessionId = currentSessionId()
    if (!state.panelOpen || !sessionId || typeof root.dsh === 'undefined') return
    try {
      const result = await root.dsh.telemetryRequest('panel', { sessionId: sessionId })
      if (!state.panelOpen) return
      renderPanel(result && result.panel)
      scrollToKind(kind)
    } catch (error) {
      if (state.panelOpen) renderPanel(null)
    }
  }

  function scrollToKind(kind) {
    const target = { token: 'model', tps: 'perf', context: 'context' }[kind]
    if (!target || !refs.panelBody) return
    const node = refs.panelBody.querySelector('#tm-sec-' + target)
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }

  function positionPanel(anchor) {
    if (!refs.panel) return
    const panel = refs.panel
    panel.style.visibility = 'hidden'
    /* 先量尺寸再定位，避免闪烁 */
    const pw = panel.offsetWidth || 320
    const ph = panel.offsetHeight || 360
    let left = 8
    let top = 8
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const rect = anchor.getBoundingClientRect()
      left = rect.right - pw
      top = rect.top - ph - 8
      if (left < 8) left = 8
      const maxLeft = (root.innerWidth || 1024) - pw - 8
      if (left > maxLeft) left = Math.max(8, maxLeft)
      if (top < 8) top = rect.bottom + 8
    }
    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(top) + 'px'
    panel.style.visibility = ''
  }

  function stopPanelPoll() {
    if (state.panelTimer) { clearInterval(state.panelTimer); state.panelTimer = null }
  }

  function closePanel() {
    if (!state.panelOpen) return
    state.panelOpen = false
    state.panelKind = ''
    stopPanelPoll()
    if (refs.panel) refs.panel.classList.add('hidden')
    for (const key of ['token', 'tps', 'context']) {
      if (refs[key]) refs[key].button.setAttribute('aria-expanded', 'false')
    }
  }

  function onKeydown(event) {
    if (state.panelOpen && (event.key === 'Escape' || event.key === 'Esc')) { event.preventDefault(); closePanel() }
  }
  function onDocClick(event) {
    if (!state.panelOpen) return
    if (refs.panel && refs.panel.contains(event.target)) return
    if (refs.group && refs.group.contains(event.target)) return
    closePanel()
  }

  function bindGlobal() {
    if (state.offKey || !doc) return
    doc.addEventListener('keydown', onKeydown)
    doc.addEventListener('click', onDocClick)
    state.offKey = () => doc.removeEventListener('keydown', onKeydown)
    state.offClick = () => doc.removeEventListener('click', onDocClick)
  }

  function setSession() {
    /* 切会话：立刻收面板并重新拉当前会话数据，避免把上一个会话的数字留在屏上 */
    closePanel()
    state.summary = null
    renderPills()
    refresh()
  }

  /** 卸载：只摘自己的订阅与 DOM，不碰 Runtime 与采集 */
  function dispose() {
    state.disposed = true
    closePanel()
    if (state.offTelemetry) { try { state.offTelemetry() } catch (error) {} state.offTelemetry = null }
    if (state.offKey) { try { state.offKey() } catch (error) {} state.offKey = null }
    if (state.offClick) { try { state.offClick() } catch (error) {} state.offClick = null }
    if (refs.group && refs.group.parentNode) refs.group.parentNode.removeChild(refs.group)
    if (refs.panel && refs.panel.parentNode) refs.panel.parentNode.removeChild(refs.panel)
    for (const key of Object.keys(refs)) delete refs[key]
    state.mounted = false
  }

  root.telemetryUI = {
    mount: mount,
    refresh: refresh,
    setSession: setSession,
    close: closePanel,
    dispose: dispose,
    isOpen: () => state.panelOpen,
    /* 暴露给测试：读当前展示的文本，断言「—」与真实值 */
    debugText: () => ({
      token: refs.token ? refs.token.value.textContent : null,
      tps: refs.tps ? refs.tps.value.textContent : null,
      context: refs.context ? refs.context.value.textContent : null
    }),
    formatters: { fmtInt, fmtDuration, fmtTps, fmtPct, fmtBytes, fmtEstimate }
  }

  bindGlobal()
})(typeof window === 'undefined' ? null : window)
