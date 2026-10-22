'use strict'

/**
 * TestRunner：TestCase 协议（Phase 3）+ Cesium 专项断言（Phase 5）。
 *
 * TestCase 形状：
 *   {
 *     name, description?, url?, timeoutMs?,
 *     steps: [ {action:'open'|'click'|'input'|'keypress'|'wait'|'eval'|'screenshot', ...} ],
 *     assertions: [ {type:..., ...} ],
 *     screenshot?: true   // 结束后补一张全页截图
 *   }
 *
 * 断言类型（验证优先级：DOM/API > 程序状态 > 截图，第一版不做视觉判断）：
 *   element_exists  {selector, negate?}
 *   text_matches    {selector?, pattern(正则串), negate?}     // selector 缺省 = 整页文本
 *   element_state   {selector, property, equals}              // 读 JS 属性/状态，如 disabled/checked
 *   url_matches     {pattern(正则串)}
 *   eval_expr       {expression, equals?|contains?|truthy?}   // 万能口子，JSON 值比较
 *   console_clean   {}                                        // 无 console.error / JS 异常
 *   network_clean   {allowStatus?}                            // 无 4xx/5xx、无失败请求
 *   cesium_viewer   {initialized?, minEntities?, maxEntities?, hasEntity?, cameraSet?, webglClean?}
 *
 * 自验证循环（Phase 4）的分工：test_run 每次跑一轮并出 TestReport；
 * 「分析失败 → 改代码 → 重启 → 重测」由 Agent 模型完成，轮次上限在工具
 * 描述里钉死（防死循环），跑器本身保持「一次调用 = 一轮」的纯粹性。
 */

const not = (value) => value ? false : true
const MAX_REPORT_CHARS = 48 * 1024

function safeRegex(pattern, flags) {
  try {
    return new RegExp(String(pattern), flags || '')
  } catch (error) {
    return null
  }
}

/* ---- Cesium 专项探测：全部走 Runtime.evaluate 读 JS 状态，不碰图像 ---- */
const CESIUM_PROBE = '(function(){' +
  'var v=window.viewer||window.__cesiumViewer||null;' +
  'var out={found:!!v};' +
  'if(!v)return out;' +
  'try{out.destroyed=!!v.isDestroyed()}catch(e){}' +
  'try{out.entities=(v.entities&&typeof v.entities.values==="function")?v.entities.values().length:null}catch(e){out.entities=null}' +
  'try{out.primitives=(v.scene&&v.scene.primitives&&typeof v.scene.primitives.length==="function")?v.scene.primitives.length:null}catch(e){out.primitives=null}' +
  'try{var c=v.camera;if(c&&c.positionCartographic){out.camera={x:c.positionCartographic.x,y:c.positionCartographic.y,height:c.positionCartographic.height};' +
  'out.cameraSet=!(!isFinite(out.camera.height))}}catch(e){out.camera=null}' +
  'try{out.sceneError=!!v.scene&&!!v.scene.renderError}catch(e){out.sceneError=null}' +
  'try{out.canvas=(v.canvas&&v.canvas.width>0)?{width:v.canvas.width,height:v.canvas.height}:null}catch(e){out.canvas=null}' +
  'try{out.dataSources=(v.dataSources&&typeof v.dataSources.length==="function")?v.dataSources.length:null}catch(e){out.dataSources=null}' +
  'return out;' +
  '})()'

const CESIUM_ENTITY_PROBE = '(function(name){' +
  'var v=window.viewer||window.__cesiumViewer||null;' +
  'if(!v||!v.entities)return {found:false};' +
  'var list=v.entities.values();' +
  'for(var i=0;i<list.length;i++){' +
  '  var e=list[i];' +
  '  if(e.id===name||(e.name&&e.name===name))return {found:true,id:e.id,name:e.name||""};' +
  '}' +
  'return {found:false,count:list.length};' +
  '})(' + '__NAME__' + ')'

/* ---- 单步执行 ---- */
async function runStep(driver, step, artifacts) {
  const action = String(step.action || '').toLowerCase()
  if (action === 'open') {
    await driver.open(step.url)
    return 'open ' + step.url
  }
  if (action === 'click') {
    await driver.click(step.selector)
    return 'click ' + step.selector
  }
  if (action === 'input') {
    await driver.input(step.selector, step.text)
    return 'input ' + step.selector
  }
  if (action === 'keypress') {
    await driver.keypress(step.key)
    return 'keypress ' + step.key
  }
  if (action === 'wait') {
    const result = await driver.wait(step.selector || step.expression, step.timeoutMs)
    return 'wait ' + (step.selector || step.expression) + ' (' + Math.round(result.timeoutMs) + 'ms)'
  }
  if (action === 'eval') {
    const value = await driver.evaluate(String(step.expression), { awaitPromise: step.awaitPromise === true })
    const shown = JSON.stringify(value) === undefined ? String(value) : JSON.stringify(value)
    return 'eval → ' + shown.slice(0, 300)
  }
  if (action === 'screenshot') {
    const shot = await driver.screenshot()
    artifacts.push({ label: step.label || ('step-' + (artifacts.length + 1)), base64: shot })
    return 'screenshot ' + (step.label || '')
  }
  throw new Error('UNKNOWN_STEP: ' + action)
}

/* ---- 单条断言 ---- */
async function runAssertion(driver, assertion, before) {
  const type = String(assertion.type || '')
  if (type === 'element_exists') {
    const found = await driver.evaluate(
      '(function(sel){return !!document.querySelector(sel)})(' + JSON.stringify(String(assertion.selector)) + ')'
    )
    const ok = assertion.negate ? not(found) : !!found
    return { ok: ok, actual: found ? 'exists' : 'missing', message: (assertion.negate ? 'must NOT exist: ' : 'must exist: ') + assertion.selector }
  }
  if (type === 'text_matches') {
    const text = await driver.getText(assertion.selector || '', MAX_REPORT_CHARS)
    const regex = safeRegex(assertion.pattern)
    if (not(regex)) return { ok: false, actual: text.text.slice(0, 200), message: 'BAD_PATTERN: ' + assertion.pattern }
    const matched = regex.test(text.text)
    const ok = assertion.negate ? not(matched) : matched
    return { ok: ok, actual: text.text.slice(0, 200), message: (assertion.negate ? 'must NOT match ' : 'must match ') + assertion.pattern }
  }
  if (type === 'element_state') {
    const value = await driver.evaluate(
      '(function(sel,prop){var el=document.querySelector(sel);return el?el[prop]:null})(' +
      JSON.stringify(String(assertion.selector)) + ',' + JSON.stringify(String(assertion.property)) + ')'
    )
    const expected = assertion.equals
    const ok = value === expected
    return { ok: ok, actual: String(value), message: 'property ' + assertion.property + ' should ' + (assertion.negate ? 'not ' : '') + 'be ' + JSON.stringify(expected) }
  }
  if (type === 'url_matches') {
    const href = await driver.url()
    const regex = safeRegex(assertion.pattern)
    if (not(regex)) return { ok: false, actual: href, message: 'BAD_PATTERN: ' + assertion.pattern }
    const ok = regex.test(href)
    return { ok: ok, actual: href, message: 'url must match ' + assertion.pattern }
  }
  if (type === 'eval_expr') {
    const value = await driver.evaluate(String(assertion.expression), { awaitPromise: assertion.awaitPromise === true })
    let ok
    if (assertion.equals !== undefined) ok = JSON.stringify(value) === JSON.stringify(assertion.equals)
    else if (assertion.contains !== undefined) ok = String(value).indexOf(String(assertion.contains)) !== -1
    else ok = !!value /* truthy 缺省 */
    if (assertion.negate) ok = not(ok)
    return { ok: ok, actual: JSON.stringify(value) === undefined ? String(value) : JSON.stringify(value), message: 'eval ' + assertion.expression }
  }
  if (type === 'console_clean') {
    /* 增量语义：只看本用例产生的（基线快照长度之后的新增），历史错误不算 */
    const errors = deltaOf(driver.consoleErrors, before.consoleErrors)
    const ok = errors.length === 0
    return { ok: ok, actual: errors.length ? errors.slice(0, 5).map((item) => item.type + ': ' + item.text).join(' | ') : 'clean', message: 'console must have no errors' }
  }
  if (type === 'network_clean') {
    const allow = Array.isArray(assertion.allowStatus) ? assertion.allowStatus : []
    const fresh = deltaOf(driver.networkErrors, before.networkErrors)
    const bad = fresh.filter((item) => item.kind !== 'status' || allow.indexOf(item.status) === -1)
    const ok = bad.length === 0
    return { ok: ok, actual: bad.length ? bad.slice(0, 5).map((item) => (item.status ? item.status + ' ' : '') + (item.url || item.errorText)).join(' | ') : 'clean', message: 'network must have no failed/HTTP>=400 requests' }
  }
  if (type === 'cesium_viewer') {
    const probe = await driver.evaluate(CESIUM_PROBE)
    const problems = []
    if (not(probe) || not(probe.found)) {
      problems.push('Cesium viewer not found on window (window.viewer / window.__cesiumViewer)')
    } else {
      if (assertion.initialized !== false && probe.destroyed) problems.push('viewer is destroyed')
      if (assertion.initialized !== false && not(probe.canvas)) problems.push('viewer canvas is missing or zero-size (WebGL likely dead)')
      if (assertion.minEntities !== undefined && (probe.entities === null || probe.entities < Number(assertion.minEntities))) {
        problems.push('entities=' + probe.entities + ' < minEntities=' + assertion.minEntities)
      }
      if (assertion.maxEntities !== undefined && probe.entities !== null && probe.entities > Number(assertion.maxEntities)) {
        problems.push('entities=' + probe.entities + ' > maxEntities=' + assertion.maxEntities)
      }
      if (assertion.cameraSet && not(probe.cameraSet)) problems.push('camera position not set')
      if (assertion.noSceneError && probe.sceneError) problems.push('scene.renderError is set')
    }
    if (assertion.webglClean !== false) {
      /* 增量语义：与本用例开始前的基线比，只看新产生的 WebGL/GPU 错误 */
      const freshErrors = deltaOf(driver.consoleErrors, before.consoleErrors)
      const glErrors = freshErrors.filter((item) => /webgl|gpu|context lost/i.test(item.text))
      if (glErrors.length) problems.push('WebGL/GPU errors in console: ' + glErrors[0].text.slice(0, 200))
    }
    return {
      ok: problems.length === 0,
      actual: JSON.stringify(probe).slice(0, 400),
      message: problems.length ? problems.join('; ') : 'cesium viewer healthy'
    }
  }
  if (type === 'cesium_has_entity') {
    const expression = CESIUM_ENTITY_PROBE.replace('__NAME__', JSON.stringify(String(assertion.name)))
    const found = await driver.evaluate(expression)
    const ok = assertion.negate ? not(found.found) : !!found.found
    return { ok: ok, actual: JSON.stringify(found), message: (assertion.negate ? 'entity must NOT exist: ' : 'entity must exist: ') + assertion.name }
  }
  throw new Error('UNKNOWN_ASSERTION: ' + type)
}

/**
 * 跑一个 TestCase → TestReport。
 * before = 跑之前 driver.snapshot()（console/network 的增量 = 这次用例的，不被历史污染）。
 */
async function runCase(driver, testCase) {
  const startedAt = Date.now()
  const report = {
    name: String(testCase.name || '(unnamed)'),
    description: String(testCase.description || ''),
    status: 'PASS',
    startedAt: new Date(startedAt).toISOString(),
    steps: [],
    assertions: [],
    consoleErrors: [],
    networkErrors: [],
    screenshots: [],
    durationMs: 0
  }
  const artifacts = [] /* {label, base64} 步骤里/结尾截的图，落盘由调用方负责 */
  const beforeSnapshot = driver.snapshot() /* console/network 基线：之后的增量才算本用例的 */
  try {
    if (testCase.url) {
      await driver.open(testCase.url)
      report.steps.push({ action: 'open', ok: true, detail: testCase.url })
    }
    for (const step of (testCase.steps || [])) {
      try {
        const detail = await runStep(driver, step, artifacts)
        report.steps.push({ action: String(step.action), ok: true, detail: detail })
      } catch (error) {
        report.steps.push({ action: String(step.action), ok: false, detail: '', error: String(error.message || error).slice(0, 600) })
        report.status = 'FAIL'
        break /* 步骤失败，后续步骤失去意义 */
      }
    }
    for (const artifact of artifacts) {
      report.screenshots.push(artifact.label)
    }
    if (report.status === 'PASS') {
      for (const assertion of (testCase.assertions || [])) {
        try {
          const outcome = await runAssertion(driver, assertion, beforeSnapshot)
          report.assertions.push(Object.assign({ type: String(assertion.type), ok: outcome.ok }, outcome))
          if (not(outcome.ok)) report.status = 'FAIL'
        } catch (error) {
          report.assertions.push({ type: String(assertion.type), ok: false, actual: '', message: String(error.message || error).slice(0, 600) })
          report.status = 'FAIL'
        }
      }
      if (testCase.screenshot === true) {
        try {
          const shot = await driver.screenshot()
          const label = 'final-' + report.name
          report.screenshots.push(label)
          artifacts.push({ label: label, base64: shot })
        } catch (error) { /* 截图失败不影响判定 */ }
      }
    }
  } catch (error) {
    report.status = 'FAIL'
    report.steps.push({ action: '(case)', ok: false, detail: '', error: String(error.message || error).slice(0, 600) })
  }
  report.consoleErrors = deltaOf(driver.consoleErrors, beforeSnapshot.consoleErrors)
  report.networkErrors = deltaOf(driver.networkErrors, beforeSnapshot.networkErrors)
  report.durationMs = Date.now() - startedAt
  return { report: report, artifacts: artifacts }
}

/* 增量：before 快照长度之后的才是本次产生的 */
function deltaOf(current, baseline) {
  if (baseline && baseline.length && baseline.every(item => Number.isInteger(item.captureSequence))) {
    const sequence = Math.max(...baseline.map(item => item.captureSequence))
    return (current || []).filter(item => item.captureSequence > sequence)
  }
  const count = Array.isArray(baseline) ? baseline.length : 0
  return (current || []).slice(count)
}

/**
 * 跑一组用例（同一浏览器会话内串行），汇总成一份 TestReport。
 * screenshots 落盘由调用方（tools.js）负责 —— 跑器只给 base64 与标签。
 */
async function runSuite(driver, testCases, options) {
  const settings = options || {}
  const suite = {
    status: 'PASS',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    passed: 0,
    failed: 0,
    cases: [],
    consoleErrors: [],
    networkErrors: [],
    screenshots: []
  }
  const startedAt = Date.now()
  for (const testCase of testCases) {
    const before = driver.snapshot()
    const outcome = await runCase(driver, testCase, { before: before })
    suite.cases.push(outcome.report)
    for (const artifact of outcome.artifacts || []) suite.screenshots.push(artifact)
    if (outcome.report.status === 'FAIL') {
      suite.failed += 1
      suite.status = 'FAIL'
    } else {
      suite.passed += 1
    }
    suite.consoleErrors = suite.consoleErrors.concat(outcome.report.consoleErrors)
    suite.networkErrors = suite.networkErrors.concat(outcome.report.networkErrors)
  }
  suite.durationMs = Date.now() - startedAt
  return { suite: suite, compact: compactSuite(suite) }
}

/* 给模型看的紧凑版：全量报告太大，只保留失败细节与关键数字 */
function compactSuite(suite) {
  const lines = []
  lines.push('TestReport: ' + suite.status + '  passed=' + suite.passed + ' failed=' + suite.failed + ' duration=' + suite.durationMs + 'ms requests=' + (suite.requests || ''))
  for (const report of suite.cases) {
    lines.push('[' + report.status + '] ' + report.name + ' (' + report.durationMs + 'ms)')
    if (report.status === 'FAIL') {
      for (const step of report.steps) {
        if (not(step.ok)) lines.push('  step FAILED: ' + step.action + ' → ' + (step.error || step.detail))
      }
      for (const assertion of report.assertions) {
        lines.push('  assert ' + (assertion.ok ? 'ok' : 'FAIL') + ': ' + assertion.type + ' — ' + assertion.message + (assertion.ok ? '' : ' (actual: ' + String(assertion.actual).slice(0, 300) + ')'))
      }
      for (const item of report.consoleErrors.slice(0, 5)) {
        lines.push('  console ' + item.type + ': ' + item.text.slice(0, 300))
      }
      for (const item of report.networkErrors.slice(0, 5)) {
        lines.push('  network: ' + (item.status ? item.status + ' ' : '') + (item.url || item.errorText))
      }
    }
  }
  if (suite.consoleErrors.length) lines.push('console errors total: ' + suite.consoleErrors.length)
  if (suite.networkErrors.length) lines.push('network errors total: ' + suite.networkErrors.length)
  let text = lines.join('\n')
  if (text.length > MAX_REPORT_CHARS) text = text.slice(0, MAX_REPORT_CHARS) + '\n[report truncated]'
  return text
}

module.exports = {
  runCase,
  runSuite,
  compactSuite,
  CESIUM_PROBE,
  MAX_REPORT_CHARS
}
