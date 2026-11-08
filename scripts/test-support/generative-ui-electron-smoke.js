'use strict'

// Runs only in a disposable Electron process. The surrounding Node process
// owns the loopback server and keeps compiled test buffers in memory.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, BrowserWindow } = require('electron')

async function run() {
  const url = process.argv[2]
  const captureDir = process.argv[3] || ''
  assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url), 'test server must use an ephemeral loopback URL')
  assert.strictEqual(process.versions.electron, '22.3.27')
  assert.strictEqual(process.versions.node, '16.17.1')
  assert(/^108\./.test(process.versions.chrome), 'must run against Chromium 108')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gui-browser-'))
  app.setPath('userData', userData)
  app.disableHardwareAcceleration()
  await app.whenReady()
  app.on('window-all-closed', () => {})
  const blocked = [], errors = []
  const win = new BrowserWindow({
    width: 1050,
    height: 950,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const contents = win.webContents
  contents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  contents.on('render-process-gone', (_event, details) => { errors.push('render-process-gone: ' + details.reason) })
  contents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const allowed = details.url.startsWith(url)
    if (!allowed) blocked.push(details.url)
    callback({ cancel: !allowed })
  })
  const js = expression => contents.executeJavaScript(expression)
  async function until(expression, label) {
    const deadline = Date.now() + 10000
    let result
    while (Date.now() < deadline) {
      result = await js(expression)
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(result) + '; browser errors: ' + JSON.stringify(errors))
  }
  async function capture(name) {
    if (!captureDir) return
    const image = await contents.capturePage()
    assert(!image.isEmpty(), 'screenshot must not be empty')
    fs.writeFileSync(path.join(captureDir, name + '.png'), image.toPNG(), { flag: 'wx' })
  }
  async function assertActionLegible(theme) {
    const style = await js(`(() => { const button=document.querySelector('.gui-action-button'), text=button.querySelector('.n-button__content') || button;
      return { color:getComputedStyle(text).color, opacity:getComputedStyle(button).opacity,
        background:getComputedStyle(document.querySelector('.gui-surface')).backgroundColor,
        note:document.querySelector('.gui-action-note').textContent } })()`)
    function luminance(color) {
      const channels = color.match(/[\d.]+/g).map(Number)
      assert(channels.length === 3 || channels.length === 4 && channels[3] === 1, 'button color must be opaque')
      const rgb = channels.slice(0, 3).map(value => { value /= 255; return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4) })
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    }
    const a = luminance(style.color), b = luminance(style.background)
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    assert.strictEqual(style.opacity, '1', theme + ': action text must not be faded by opacity')
    assert(ratio >= 4.5, theme + ': disabled action must remain readable, contrast=' + ratio)
    assert(style.note.includes('尚未启用'), theme + ': explain why the action is disabled')
  }
  try {
    await win.loadURL(url)
    await until('!!(window.__guiFixture && window.AgentGenerativeUI && window.AgentUIVendor)', 'UI scripts')
    await js("window.__guiFixture.mount(false, 'line'); true")
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.strictEqual(await js("document.querySelectorAll('.gui-plot canvas').length"), 0, 'detached fragment must not initialize ECharts')
    await js('window.__guiFixture.attach(); true')
    await until("!!document.querySelector('.gui-plot canvas')", 'connected ECharts canvas')
    await until("document.querySelector('.gui-plot canvas').width > 0 && document.querySelector('.gui-plot canvas').height > 0", 'nonzero chart size')
    await js("document.querySelector('.gui-chart-table').open = true; true")
    await new Promise(resolve => setTimeout(resolve, 150))
    const initial = await js(`(() => {
      const el = document.querySelector('.gui-slider input[type=range]'), plot = document.querySelector('.gui-plot');
      window.__testChart = AgentUIVendor.echartsCore.getInstanceByDom(plot);
      window.__beforeCanvas = plot.querySelector('canvas').toDataURL();
      return { title: document.querySelector('.gui-title').textContent,
        text: document.querySelector('.gui-text').textContent, unsafeImages: document.querySelectorAll('.gui-text img').length,
        table: [...document.querySelectorAll('.gui-chart td')].map(x => x.textContent),
        sliderValue: el && el.value, sliderName: el && el.getAttribute('aria-label'),
        disabled: !!document.querySelector('.gui-surface button[disabled]'),
        canvasWidth: plot.querySelector('canvas').width, chart: !!window.__testChart };
    })()`)
    assert.strictEqual(initial.title, '季度收入分析')
    assert(initial.text.includes('<img src='))
    assert.strictEqual(initial.unsafeImages, 0, 'model text must remain escaped')
    assert.deepStrictEqual(initial.table, ['2', '-1', '4', '0', '7', '3'])
    assert.strictEqual(initial.sliderValue, '1')
    assert.strictEqual(initial.sliderName, '调整倍数', 'actual slider thumb must have an accessible name')
    assert(initial.disabled && initial.chart && initial.canvasWidth > 0, 'button remains disabled and real ECharts is mounted')
    assert.strictEqual(await js('typeof require'), 'undefined', 'renderer must not expose Node require')
    contents.debugger.attach('1.3')
    try {
      const tree = await contents.debugger.sendCommand('Accessibility.getFullAXTree')
      assert(tree.nodes.some(node => node.role && node.role.value === 'slider' && node.name && node.name.value === '调整倍数'), 'Chromium accessibility tree names the real slider')
    } finally { contents.debugger.detach() }
    await capture('light-line')
    const tooltip = await js(`(() => { const plot = document.querySelector('.gui-plot'), chart = AgentUIVendor.echartsCore.getInstanceByDom(plot); const before = plot.querySelectorAll('div').length; chart.dispatchAction({type: 'showTip', seriesIndex: 0, dataIndex: 1}); return { mode: chart.getOption().tooltip[0].renderMode, before, after: plot.querySelectorAll('div').length }; })()`)
    assert.strictEqual(tooltip.mode, 'richText', 'chart tooltips must render inside the canvas')
    assert.strictEqual(tooltip.after, tooltip.before, 'showing a tooltip must not add HTML to the plot')
    await js("document.querySelector('.test-host').style.width = '480px'; true")
    await until("(() => {const el = document.querySelector('.gui-plot'), chart = AgentUIVendor.echartsCore.getInstanceByDom(el); return el.clientWidth < 500 && chart.getWidth() === el.clientWidth })()", 'ResizeObserver shrink')
    await js("document.querySelector('.test-host').style.width = '100%'; true")
    await until("(() => {const el = document.querySelector('.gui-plot'), chart = AgentUIVendor.echartsCore.getInstanceByDom(el); return el.clientWidth > 600 && chart.getWidth() === el.clientWidth })()", 'ResizeObserver restore')
    // Send a key through Electron/Chromium, not a synthetic DOM key event;
    // a separate visible-window accessibility pass remains necessary.
    await js("document.querySelector('.gui-slider input[type=range]').focus(); true")
    contents.focus()
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
    await until("document.querySelector('.gui-slider input[type=range]').value === '1.5'", 'keyboard-driven slider update')
    await until("document.querySelector('.gui-chart td').textContent === '3'", 'derived table update')
    await until("document.querySelector('.gui-plot canvas').toDataURL() !== window.__beforeCanvas", 'ECharts repaint after slider')
    assert.strictEqual(await js('window.__guiFixture.mismatch()'), true, 'a view cannot be updated from another session')
    await js("window.__guiFixture.update(2, 'bar', 'dark'); true")
    await until("document.querySelector('.gui-slider input[type=range]').value === '1'", 'new revision defaults')
    await until("getComputedStyle(document.querySelector('.gui-surface')).backgroundColor === 'rgb(43, 43, 43)'", 'dark surface')
    await until("!!document.querySelector('.gui-plot canvas')", 'bar chart')
    await js("document.querySelector('.gui-chart-table').open = true; true")
    await new Promise(resolve => setTimeout(resolve, 200))
    const dark = await js(`(() => { const chart = AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector('.gui-plot')); return { kind: chart.getOption().series.map(s => s.type), labels: [...document.querySelectorAll('.gui-chart th')].map(x => x.textContent), value: document.querySelector('.gui-slider output').textContent, drawnText: chart.getZr().storage.getDisplayList().map(item => item.style && item.style.text).filter(Boolean) } })()`)
    assert.deepStrictEqual(dark.kind, ['bar', 'bar'])
    // One occurrence is the legend, the other must be the last-bar label.
    assert(dark.drawnText.filter(text => text === '收入 (revenue)').length >= 2, 'revenue direct label must really be rendered')
    assert(dark.drawnText.filter(text => text === '成本 (cost)').length >= 2, 'cost direct label must really be rendered')
    assert(dark.labels.some(label => label.includes('<b>第二季度</b>')), 'table labels remain plain text')
    assert.strictEqual(dark.value, '1')
    await capture('dark-bar')
    await js('window.__guiFixture.sharedBinding(); true')
    await until("document.querySelectorAll('.gui-slider input[type=range]').length === 2", 'two sliders sharing a state key')
    assert.strictEqual(await js("document.querySelector('.gui-slider input[type=range]').getAttribute('aria-label')"), '调整倍数（新）', 'new revision updates the slider name')
    await js("document.querySelector('.gui-slider input[type=range]').focus(); true")
    contents.focus()
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
    await until("!![...document.querySelectorAll('[role=status]')].find(el => el.textContent.includes('不符合'))", 'shared-state step rejection')
    await until("document.querySelector('.gui-slider input[type=range]').value === '1'", 'rejected range value restores local view')
    assert.strictEqual(await js("document.querySelector('.gui-chart td').textContent"), '2', 'rejected input does not change chart data')
    await js("window.__guiFixture.update(1, 'line', null); true")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepStrictEqual(await js("AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector('.gui-plot')).getOption().series.map(s => s.type)"), ['bar', 'bar'], 'old revision cannot replace new chart')
    await js('window.__heldChart = AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector(".gui-plot")); window.__guiFixture.invalidFuture(); true')
    await until("document.querySelector('[role=status]') && document.querySelector('[role=status]').textContent.includes('暂不可用')", 'future-version fail-closed placeholder')
    assert.strictEqual(await js('window.__heldChart.isDisposed()'), true, 'removing a surface must dispose its ECharts instance')
    await js("window.__guiFixture.update(1, 'line', null); true")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(await js("document.querySelectorAll('.gui-plot canvas').length"), 0, 'future-version barrier must not restore an older surface')
    await js('window.__guiFixture.dispose(); true')
    assert.strictEqual(await js('window.__guiFixture.mountHistory(false)'), true, 'message projection rejects other sessions')
    await until("!!document.querySelector('.test-message .gui-plot canvas')", 'projected history chart')
    assert.strictEqual(await js("document.querySelectorAll('.gui-surface').length"), 1, 'only the latest history revision renders')
    assert.strictEqual(await js("document.querySelector('.test-message').textContent"), '前文后文', 'text order survives a superseded UI block')
    assert.deepStrictEqual(await js("AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector('.gui-plot')).getOption().series.map(s => s.type)"), ['bar', 'bar'])
    await js('window.__historyChart = AgentUIVendor.echartsCore.getInstanceByDom(document.querySelector(".gui-plot")); true')
    await js('window.__guiFixture.mountHistory(true); true')
    await until("!!document.querySelector('.gui-unavailable')", 'unsupported projected history block')
    assert.strictEqual(await js("document.querySelectorAll('.gui-plot canvas').length"), 0, 'future history blocks prevent downgrade')
    assert.strictEqual(await js('window.__historyChart.isDisposed()'), true, 'history remount disposes the old chart')
    await js('window.__guiFixture.dispose(); window.__guiFixture.mountForm(false); true')
    await until("document.querySelectorAll('.gui-input input').length === 2 && document.querySelectorAll('.gui-checkbox input').length === 2", 'form fields')
    assert.strictEqual(await js("document.querySelector('.gui-form legend').textContent"), '筛选参数')
    assert.strictEqual(await js("document.querySelectorAll('.gui-form img').length"), 0, 'form text never becomes markup')
    assert.strictEqual(await js("document.querySelector('.gui-form button').disabled"), true, 'form has no action executor')
    contents.debugger.attach('1.3')
    try {
      const tree = await contents.debugger.sendCommand('Accessibility.getFullAXTree')
      assert(tree.nodes.some(node => node.role && node.role.value === 'group' && node.name && node.name.value === '筛选参数'), 'fieldset has an accessible group name')
      assert(tree.nodes.some(node => node.role && node.role.value === 'textbox' && node.name && node.name.value === '关键词'), 'text input has an accessible name')
      assert(tree.nodes.some(node => node.role && node.role.value === 'checkbox' && node.name && node.name.value === '包含归档'), 'checkbox has an accessible name')
    } finally { contents.debugger.detach() }
    await assertActionLegible('light')
    await capture('light-form')
    // The first input has a larger maximum than the second; changing either
    // must satisfy both bindings. Insert real Chromium text and toggle by key.
    await js("document.querySelector('.gui-input input').focus(); document.querySelector('.gui-input input').select(); true")
    contents.focus(); await contents.insertText('abc')
    await until("[...document.querySelectorAll('.gui-input input')].every(x=>x.value==='abc')", 'shared text input updates')
    await js("document.querySelector('.gui-checkbox input').focus(); true")
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await until("[...document.querySelectorAll('.gui-checkbox input')].every(x=>x.checked)", 'keyboard checkbox and shared state')
    await js("(()=>{const x=document.querySelector('.gui-input input'); x.value='abcdef'; x.dispatchEvent(new InputEvent('input',{bubbles:true,data:'abcdef'})); return true})()")
    await until("!![...document.querySelectorAll('[role=status]')].find(x=>x.textContent.includes('输入不符合'))", 'shared input length rejection')
    await until("[...document.querySelectorAll('.gui-input input')].every(x=>x.value==='abc')", 'rejected input restores both fields')
    // Exercise the DOM composition contract; this is not an OS-level IME test.
    await js("(()=>{const x=document.querySelector('.gui-input input'); x.value='中文'; x.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'中文'})); return true})()")
    assert.deepStrictEqual(await js("[...document.querySelectorAll('.gui-input input')].map(x=>x.value)"), ['中文', 'abc'], 'in-progress composition is not reset or propagated')
    await js("document.querySelector('.gui-input input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'})); true")
    await until("[...document.querySelectorAll('.gui-input input')].every(x=>x.value==='中文')", 'composition commit updates shared state')
    const enter = await js(`(() => { const x=document.querySelector('.gui-input input');
      const composing=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true});
      const normal=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
      x.dispatchEvent(composing);x.dispatchEvent(normal);return { composing:composing.defaultPrevented,normal:normal.defaultPrevented } })()`)
    assert.deepStrictEqual(enter, { composing: false, normal: true }, 'Enter cannot submit the surrounding chat or interrupt composition')
    await js("window.__guiFixture.formTheme('dark'); true")
    await until("getComputedStyle(document.querySelector('.gui-input input')).backgroundColor === 'rgb(43, 43, 43)'", 'form dark theme')
    await assertActionLegible('dark')
    await capture('dark-form')
    await js('window.__guiFixture.mountForm(true); true')
    await until("!!document.querySelector('.trusted-custom')", 'trusted dynamically registered renderer')
    assert.strictEqual(await js("document.querySelector('.trusted-custom').textContent.includes('<img')"), true)
    assert.strictEqual(await js("document.querySelectorAll('.trusted-custom img').length"), 0)
    await js('window.__guiFixture.mountForm(false); true')
    assert.strictEqual(await js("document.querySelectorAll('.trusted-custom').length"), 0, 'custom registry is isolated to its own mount')
    await until("!!document.querySelector('.gui-text')", 'default renderer remains intact')
    assert.strictEqual(await js('typeof window.AgentUICesium'), 'undefined', 'ordinary charts/forms do not load the Cesium bundle')
    await js('window.__guiFixture.mountBusiness(false); true')
    await until("!!document.querySelector('.gui-visual iframe[data-loaded=true]')", 'static visual iframe loads')
    assert.strictEqual(await js("document.querySelector('.gui-visual iframe').getAttribute('sandbox')"), '')
    assert.strictEqual(await js("document.querySelector('.gui-visual iframe').src.startsWith('blob:')"), true)
    await until("document.querySelector('.gui-map')?.dataset.mapBackend === 'cesium'", 'real offline Cesium globe')
    await until("document.querySelector('.gui-map canvas')?.width > 0", 'sized Cesium canvas')
    assert.strictEqual(await js("document.querySelectorAll('.gui-table tbody tr').length"), 3)
    assert.strictEqual(await js("document.querySelectorAll('.gui-table img').length"), 0, 'business cells remain escaped text')
    assert.strictEqual(await js("document.querySelector('.gui-progress progress').value"), 25)
    assert(await js("document.querySelector('.gui-progress').textContent.includes('不代表系统任务')"))
    await js("(()=>{const select=document.querySelector('.gui-filter select');select.value='华东';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
    await until("document.querySelectorAll('.gui-table tbody tr').length===2", 'reactive table filtering')
    await js("document.querySelector('.gui-table tbody button').focus();true")
    contents.focus(); contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await until("document.querySelector('.gui-table-selection').textContent.includes('shanghai')", 'keyboard row selection')
    await js("[...document.querySelectorAll('.gui-flow-nodes button')].find(x=>x.textContent.includes('人工复核')).focus();true")
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await until("document.querySelector('.gui-flow-selection').textContent.includes('人工复核')", 'keyboard flow-node selection')
    await js("[...document.querySelectorAll('.gui-map button')].find(x=>x.textContent.includes('北京门店')).click();true")
    await until("!!document.querySelector('.gui-map button[aria-pressed=true]')", 'map selection synchronized with coordinate list')
    await js("document.querySelector('.gui-map').scrollIntoView();true")
    await new Promise(resolve => setTimeout(resolve, 150))
    await capture('business-dark-map')
    win.setSize(390, 900)
    await until("innerWidth<=390", 'phone-width viewport')
    assert(await js('document.documentElement.scrollWidth<=innerWidth'), 'business controls must not overflow phone width')
    await js("window.__guiFixture.formTheme('light');document.querySelector('.gui-flow').scrollIntoView();true")
    await new Promise(resolve => setTimeout(resolve, 150))
    await capture('business-phone-flow')
    contents.debugger.attach('1.3')
    try {
      await contents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true })
      const point=await js("(()=>{const b=document.querySelector('.gui-flow-selection button');b.scrollIntoView();const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
      await contents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x:point.x,y:point.y }] })
      await contents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await until("document.querySelector('.gui-flow-selection').textContent.includes('尚未选择')", 'touch node-selection clear')
    } finally { contents.debugger.detach() }
    await js("document.querySelector('.gui-map canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true}));true")
    await until("document.querySelector('.gui-map')?.dataset.mapBackend==='coordinates'", 'lost graphics context switches to explicit coordinate fallback')
    await capture('business-phone-map-fallback')
    await js('window.__guiFixture.mountBusiness(true);true')
    await until("document.querySelector('.gui-map')?.dataset.mapBackend==='coordinates'", 'WebGL-unavailable fallback')
    await js("[...document.querySelectorAll('.gui-map button')].find(x=>x.textContent.includes('上海门店')).click();true")
    await until("!!document.querySelector('.gui-map button[aria-pressed=true]')", 'fallback retains selection interaction')
    for(let i=0;i<3;i++) await js('(async()=>{await window.__guiFixture.mountBusiness(false);window.__guiFixture.dispose();return true})()')
    await new Promise(resolve => setTimeout(resolve,150))
    assert.strictEqual(await js("document.querySelectorAll('.cesium-widget,.gui-map canvas,.gui-flow svg').length"),0,'pending/disposed business mounts leave no renderers')
    win.setSize(1050,950)
    await js('window.__guiFixture.mountVisual(); true')
    await until("!!document.querySelector('.gui-visual iframe[data-loaded=true]')", 'malicious visual is sandboxed and loads')
    assert.strictEqual(await js("document.querySelector('.gui-visual iframe').getAttribute('sandbox')"), '')
    assert.strictEqual(await js("document.querySelector('.gui-visual iframe').src.startsWith('blob:')"), true)
    assert.strictEqual(await js('window.__visualScript || 0'), 0)
    assert.strictEqual(await js('window.__visualOnload || 0'), 0)
    const visualPayload = '<svg onload="window.parent.__visualOnload=1"><script>window.parent.__visualScript=1</script><a href="https://invalid.example/x">x</a><iframe src="https://invalid.example/frame"></iframe><circle cx="2" cy="2" r="1"/></svg>'
    const visualDocument = await js('window.AgentGenerativeUI.buildVisualDocument(' + JSON.stringify(visualPayload) + ')')
    assert(!/<script|<iframe|<a\s|onload=|https:\/\//i.test(visualDocument), 'visual sanitizer removes scripts, frames, links and external URLs')
    assert(visualDocument.includes('<circle'), 'visual sanitizer preserves safe SVG')
    await js('window.__guiFixture.dispose(); true')
    assert.strictEqual(await js('window.__unexpectedExecution || 0'), 0)
    assert.deepStrictEqual(await js('window.__guiFixture.violations'), [], 'CSP must not be violated')
    assert.deepStrictEqual(blocked, [], 'renderer must not try to access any other host')
    assert.deepStrictEqual(errors, [], 'browser console must not contain errors: ' + JSON.stringify(errors))
    console.log('Generative UI isolated Electron 22/Chromium 108: fragment mount, real Vue/Naive UI/ECharts, escaped text, keyboard slider/form controls, simulated composition, trusted dynamic registry, resize, canvas/table update, light/dark, shared-binding rejection, history projection, revision isolation, CSP, chart disposal, real lazy offline Cesium, table/filter/progress/flow selections, sandboxed static visuals, graphics degradation and phone-width/touch behavior passed.')
  } finally {
    if (!win.isDestroyed()) win.destroy()
    fs.rmSync(userData, { recursive: true, force: true })
  }
}
run().then(() => app.exit(0)).catch(error => { console.error(error.stack || error); app.exit(1) })
