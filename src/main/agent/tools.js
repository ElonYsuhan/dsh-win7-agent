'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { spawn } = require('child_process')
const { assertInside, existingRealPath, ensureParentInside, relativeDisplay } = require('./path-guard')
const policy = require('./permission-policy')
const { decideToolPermission, buildApprovalRequest } = policy
const { BrowserDriver } = require('./browser-driver')
const { runSuite } = require('./test-runner')

const not = (value) => value ? false : true
const MAX_READ_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage'])

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories under a workspace-relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path. Default is .' },
          depth: { type: 'number', description: 'Recursion depth, 1 to 3. Default is 1.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the workspace. Returns line-numbered content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          startLine: { type: 'number', description: 'Optional 1-based start line.' },
          endLine: { type: 'number', description: 'Optional 1-based end line.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search text in workspace files. Skips .git, node_modules and common build directories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to search.' },
          path: { type: 'string', description: 'Workspace-relative directory. Default is .' },
          maxResults: { type: 'number', description: 'Maximum matches. Default is 50.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file in the workspace atomically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'Full file content.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace exact text in a workspace file. Requires exactly one match unless replaceAll is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          oldText: { type: 'string', description: 'Exact text to replace.' },
          newText: { type: 'string', description: 'Replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace every match. Default false.' }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a local shell command in the workspace. On Windows uses cmd.exe. Requires approval by default.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to run.' },
          cwd: { type: 'string', description: 'Workspace-relative working directory. Default is .' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Default 60000.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_launch',
      description: 'Launch the built-in Chromium (Electron runtime) with remote debugging and open the given URL. The browser session persists for this conversation: launch once, then drive it with browser_act/browser_eval. Use it to verify web/Cesium changes end to end. Does NOT touch the running Agent window (separate user-data-dir). IMPORTANT: when your verification is finished, call browser_close — do not leave the verification window open.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open (e.g. http://127.0.0.1:3000).' },
          width: { type: 'number', description: 'Window width. Default 1280.' },
          height: { type: 'number', description: 'Window height. Default 800.' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_act',
      description: 'Drive the launched browser. action: open (navigate), click (selector), input (selector+text), keypress (key like Enter/Tab/a), wait (selector or JS expression, timeoutMs), getDOM (selector → outerHTML), getText (selector, body if omitted), screenshot (saves PNG under test-artifacts/), close. Prefer DOM/API verification over screenshots.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'open|click|input|keypress|wait|getDOM|getText|screenshot|close' },
          selector: { type: 'string', description: 'CSS selector. For wait you may pass a JS expression instead.' },
          text: { type: 'string', description: 'Text for input.' },
          key: { type: 'string', description: 'Key for keypress: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, or a single character.' },
          timeoutMs: { type: 'number', description: 'Timeout for wait. Default 10000.' },
          url: { type: 'string', description: 'URL for open.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_eval',
      description: 'Evaluate a JavaScript expression in the page and return its JSON value. This is the primary verification channel: read app state, Cesium viewer (window.viewer: entities.values().length, camera.positionCartographic, scene.renderError, canvas size), store state, etc. Verification priority: DOM/API > app state > screenshot.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
          awaitPromise: { type: 'boolean', description: 'Await the returned promise. Default false.' }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the browser you launched (kills its process and removes its temp profile). Call this when verification is finished — never leave the verification window open. Safe to call when nothing is open.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'test_run',
      description: 'Run structured test cases in the launched browser and produce a TestReport. cases: [{name, description?, url?, steps: [{action: open|click|input|keypress|wait|eval|screenshot, ...}], assertions: [...], screenshot?}]. Assertion types: element_exists{selector,negate?}, text_matches{selector?,pattern,negate?}, element_state{selector,property,equals}, url_matches{pattern}, eval_expr{expression,equals?|contains?|truthy?}, console_clean{}, network_clean{allowStatus?}, cesium_viewer{initialized?,minEntities?,maxEntities?,cameraSet?,noSceneError?,webglClean?}, cesium_has_entity{name,negate?}. If browser is not open it is launched with the first case url. Self-validation loop: test_run → fix code → restart service → test_run again; STOP after 5 failed rounds and report instead of looping forever. Reports and screenshots are saved under test-artifacts/ in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          cases: { type: 'array', description: 'Test cases. Each: {name, url?, steps[], assertions[], screenshot?}.' },
          path: { type: 'string', description: 'Workspace-relative JSON file containing a test case or an array of them (alternative to inline cases).' },
          closeAfter: { type: 'boolean', description: 'Close the browser after the run. Default false.' }
        }
      }
    }
  }
]


function isProbablyText(buffer) {
  if (buffer.includes(0)) return false
  let suspicious = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 32) suspicious += 1
  }
  return suspicious * 20 < buffer.length
}

function lineNumbered(text) {
  const lines = text.split(/\r?\n/)
  const width = String(lines.length).length
  return lines.map((line, index) => String(index + 1).padStart(width, ' ') + '  ' + line).join('\n')
}

async function readTextFile(root, relativePath) {
  const absolute = existingRealPath(root, relativePath)
  const stat = await fsp.stat(absolute)
  if (stat.isDirectory()) {
    throw new Error('IS_DIRECTORY: ' + relativePath + ' is a directory')
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error('FILE_TOO_LARGE: ' + relativePath + ' is larger than ' + MAX_READ_BYTES + ' bytes')
  }
  const buffer = await fsp.readFile(absolute)
  if (not(isProbablyText(buffer))) {
    throw new Error('NOT_TEXT: ' + relativePath + ' is not a UTF-8 text file')
  }
  return { absolute, text: buffer.toString('utf8'), stat }
}

async function listDirectory(root, relativePath, depth) {
  const absolute = existingRealPath(root, relativePath)
  const stat = await fsp.stat(absolute)
  if (not(stat.isDirectory())) {
    throw new Error('NOT_DIRECTORY: ' + relativePath + ' is not a directory')
  }
  const limit = Math.max(1, Math.min(3, Number(depth) || 1))
  const lines = []
  async function walk(current, remaining) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
      const child = path.join(current, entry.name)
      const display = relativeDisplay(root, child) + (entry.isDirectory() ? '/' : '')
      lines.push(display)
      if (entry.isDirectory() && remaining > 1) {
        await walk(child, remaining - 1)
      }
    }
  }
  await walk(absolute, limit)
  return lines.length ? lines.join('\n') : '(empty directory)'
}

async function searchFiles(root, relativePath, query, maxResults) {
  const absolute = existingRealPath(root, relativePath)
  const stat = await fsp.stat(absolute)
  if (not(stat.isDirectory())) {
    throw new Error('NOT_DIRECTORY: ' + relativePath + ' is not a directory')
  }
  const needle = String(query || '')
  if (needle.length === 0) {
    throw new Error('EMPTY_QUERY: query must not be empty')
  }
  const limit = Math.max(1, Math.min(200, Number(maxResults) || 50))
  const results = []
  let scanned = 0
  async function walk(current) {
    if (results.length >= limit) return
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= limit) return
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(path.join(current, entry.name))
        continue
      }
      if (not(entry.isFile())) continue
      const child = path.join(current, entry.name)
      const fileStat = await fsp.stat(child)
      if (fileStat.size > MAX_READ_BYTES) continue
      const buffer = await fsp.readFile(child)
      if (not(isProbablyText(buffer))) continue
      scanned += 1
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes(needle)) {
          results.push(relativeDisplay(root, child) + ':' + (index + 1) + ': ' + lines[index].trim().slice(0, 240))
          if (results.length >= limit) return
        }
      }
    }
  }
  await walk(absolute)
  return 'matches=' + results.length + ' scanned=' + scanned + '\n' + (results.length ? results.join('\n') : '(no matches)')
}

async function replaceFile(root, relativePath, content) {
  const target = ensureParentInside(root, relativePath)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temp = target + '.dsh-tmp-' + Date.now()
  await fsp.writeFile(temp, content, 'utf8')
  try {
    await fsp.rename(temp, target)
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      await fsp.unlink(target).catch(() => undefined)
      await fsp.rename(temp, target)
      return target
    }
    await fsp.unlink(temp).catch(() => undefined)
    throw error
  }
  return target
}

async function writeFile(root, relativePath, content) {
  const target = await replaceFile(root, relativePath, String(content === undefined ? '' : content))
  const stat = await fsp.stat(target)
  return 'wrote ' + relativeDisplay(root, target) + ' (' + stat.size + ' bytes)'
}

async function editFile(root, relativePath, oldText, newText, replaceAll) {
  const { absolute, text } = await readTextFile(root, relativePath)
  const needle = String(oldText === undefined ? '' : oldText)
  if (needle.length === 0) {
    throw new Error('EMPTY_OLD_TEXT: oldText must not be empty')
  }
  let matches = 0
  let cursor = 0
  while (true) {
    const found = text.indexOf(needle, cursor)
    if (found === -1) break
    matches += 1
    cursor = found + needle.length
  }
  if (matches === 0) {
    throw new Error('EDIT_NOT_FOUND: oldText was not found in ' + relativePath)
  }
  if (matches > 1 && not(replaceAll)) {
    throw new Error('AMBIGUOUS_EDIT: oldText matched ' + matches + ' times; pass replaceAll=true or use more context')
  }
  const next = replaceAll ? text.split(needle).join(String(newText === undefined ? '' : newText)) : text.replace(needle, String(newText === undefined ? '' : newText))
  await replaceFile(root, relativePath, next)
  return 'edited ' + relativeDisplay(root, absolute) + ' matches=' + matches
}

function commandBlocked(command) {
  const value = String(command).toLowerCase()
  const patterns = [
    'format ',
    'diskpart',
    'shutdown',
    'reg delete',
    'sc delete',
    'del /s',
    'del /q',
    'rd /s',
    'rmdir /s',
    'takeown /f',
    'icacls'
  ]
  for (const pattern of patterns) {
    if (value.includes(pattern)) return pattern
  }
  return ''
}

function runCommand(root, command, cwd, timeoutMs, ctx) {
  const targetCwd = assertInside(root, cwd || '.', 'cwd')
  const blocked = commandBlocked(command)
  if (blocked) {
    throw new Error('COMMAND_BLOCKED: pattern=' + blocked)
  }
  const timeout = Math.max(1000, Math.min(600000, Number(timeoutMs) || 60000))
  return new Promise((resolve, reject) => {
    const child = spawn(String(command), [], {
      cwd: targetCwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' }
    })
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcessTree(child)
      resolve('TIMEOUT after ' + timeout + 'ms\n' + output)
    }, timeout)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killProcessTree(child)
      resolve('ABORTED\n' + output)
    }
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true })
    const append = (chunk) => {
      output += chunk.toString()
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated]'
        killProcessTree(child)
      }
    }
    /* 同 llm.js：先 setEncoding 再挂监听，中文输出才不会被 chunk 边界切成 U+FFFD */
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort)
      resolve('exitCode=' + code + '\n' + (output.length ? output : '(no output)'))
    })
  })
}

function killProcessTree(child) {
  if (not(child) || not(child.pid)) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => { try { child.kill() } catch (error) {} })
      return
    } catch (error) { /* fall through */ }
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    try { child.kill() } catch (innerError) {}
  }
}

/**
 * 命令程序名与危险命令判断统一在 permission-policy.js（本文件 re-export 保持旧引用可用）
 */
function commandProgram(command) {
  return policy.commandProgram(command)
}

const READ_TOOLS = ['list_dir', 'read_file', 'search_files']
const TOOL_PERMISSIONS = {
  list_dir: 'read',
  read_file: 'read',
  search_files: 'read',
  write_file: 'write',
  edit_file: 'edit',
  run_command: 'command',
  browser_launch: 'command',
  browser_act: 'command',
  browser_eval: 'command',
  browser_close: 'command',
  test_run: 'command'
}

/* ---------------- 自验证能力（浏览器驱动 / 测试跑器）----------------
 * 浏览器会话挂在 ctx.agent 上（每个会话一台 worker，互不串扰）；
 * 进程意外退出后下一次调用自动重新 spawn。截图/报告落工作区 test-artifacts/。
 */
function agentDriver(ctx) {
  const agent = ctx.agent
  if (not(agent)) {
    throw new Error('BROWSER_NO_CONTEXT: browser tools need a conversation context')
  }
  if (not(agent._browserDriver)) {
    const driver = new BrowserDriver({})
    driver.onExited = () => { /* isOpen 变 false，下次调用重新 launch */ }
    agent._browserDriver = driver
  }
  return agent._browserDriver
}

function browserWorking(ctx) {
  const driver = agentDriver(ctx)
  if (not(driver.isOpen)) {
    throw new Error('BROWSER_NOT_OPEN: call browser_launch first (it survives until browser_act close / conversation end)')
  }
  return driver
}

async function saveArtifact(root, relativePath, base64) {
  const target = ensureParentInside(root, relativePath)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, Buffer.from(base64, 'base64'))
  return relativeDisplay(root, target)
}

async function browserAct(root, input, ctx) {
  const action = String(input.action || '').toLowerCase()
  if (action === 'close') {
    const result = await agentDriver(ctx).close()
    return 'browser closed'
  }
  const driver = browserWorking(ctx)
  if (action === 'open') return JSON.stringify(await driver.open(input.url))
  if (action === 'click') return JSON.stringify(await driver.click(input.selector))
  if (action === 'input') return JSON.stringify(await driver.input(input.selector, input.text))
  if (action === 'keypress') return JSON.stringify(await driver.keypress(input.key))
  if (action === 'wait') return JSON.stringify(await driver.wait(input.selector || input.expression, input.timeoutMs))
  if (action === 'getdom' || action === 'get_dom') {
    const dom = await driver.getDom(input.selector, input.maxLength)
    return 'selector=' + input.selector + ' truncated=' + dom.truncated + '\n' + dom.html
  }
  if (action === 'gettext' || action === 'get_text') {
    const text = await driver.getText(input.selector, input.maxLength)
    return 'selector=' + (input.selector || 'body') + ' truncated=' + text.truncated + '\n' + text.text
  }
  if (action === 'screenshot') {
    const base64 = await driver.screenshot()
    const label = String(input.label || ('shot-' + Date.now())).replace(/[^\w.-]+/g, '-')
    const saved = await saveArtifact(root, 'test-artifacts/' + label + '.png', base64)
    return 'screenshot saved: ' + saved
  }
  throw new Error('UNKNOWN_BROWSER_ACTION: ' + action)
}

async function runTestCases(root, input, ctx) {
  let cases = Array.isArray(input.cases) ? input.cases : null
  if (not(cases) && input.path) {
    const { text } = await readTextFile(root, input.path)
    const parsed = JSON.parse(text)
    cases = Array.isArray(parsed) ? parsed : [parsed]
  }
  if (not(cases) || not(cases.length)) {
    throw new Error('NO_TEST_CASES: pass cases[] or path to a test JSON file')
  }
  const driver = agentDriver(ctx)
  if (not(driver.isOpen)) {
    const firstUrl = (cases.find((item) => item && item.url) || {}).url
    if (not(firstUrl)) {
      throw new Error('BROWSER_NOT_OPEN: no case has url and browser is not launched — call browser_launch or give cases a url')
    }
    await driver.launch(firstUrl, { noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    if (firstUrl !== cases[0].url) {
      await driver.open(cases[0].url)
    }
  }
  const outcome = await runSuite(driver, cases, {})
  /* 截图落盘 + 全量 JSON 报告（给用户看，模型只读紧凑版） */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const savedFiles = []
  for (const artifact of (outcome.suite.screenshots || [])) {
    try {
      const label = String(artifact.label || 'shot').replace(/[^\w.-]+/g, '-')
      savedFiles.push(await saveArtifact(root, 'test-artifacts/' + stamp + '-' + label + '.png', artifact.base64))
    } catch (error) { /* 截图落盘失败不挡报告 */ }
  }
  try {
    const reportFile = ensureParentInside(root, 'test-artifacts/report-' + stamp + '.json')
    await fsp.mkdir(path.dirname(reportFile), { recursive: true })
    const json = Object.assign({}, outcome.suite)
    json.screenshots = (outcome.suite.screenshots || []).map((artifact) => artifact.label)
    await fsp.writeFile(reportFile, JSON.stringify(json, null, 2), 'utf8')
    savedFiles.push(relativeDisplay(root, reportFile))
  } catch (error) { /* 同上 */ }
  if (input.closeAfter === true) {
    await driver.close()
  }
  return outcome.compact + '\nartifacts: ' + (savedFiles.join(', ') || '(none)')
}

async function executeTool(name, args, ctx) {
  const settings = (ctx && ctx.settings) || {}
  const permission = TOOL_PERMISSIONS[name] || 'read'
  const decision = decideToolPermission(permission, settings.permissionMode, args && typeof args === 'object' ? args : {})
  if (decision === 'deny') {
    return 'DENIED: ' + name + ' is blocked by read-only permission'
  }
  if (decision === 'ask') {
    const approved = await ctx.approve(buildApprovalRequest(permission, args && typeof args === 'object' ? args : {}))
    if (not(approved)) return 'DENIED: ' + name + ' was not approved'
  }
  const root = ctx.workspaceRoot
  const input = args && typeof args === 'object' ? args : {}
  if (name === 'list_dir') {
    return listDirectory(root, input.path || '.', input.depth || 1)
  }
  if (name === 'read_file') {
    const { text } = await readTextFile(root, input.path || '.')
    const lines = text.split(/\r?\n/)
    const start = Math.max(1, Number(input.startLine) || 1)
    const end = Math.min(lines.length, Number(input.endLine) || lines.length)
    const slice = lines.slice(start - 1, end).join('\n')
    return 'file=' + (input.path || '.') + ' lines=' + start + '-' + end + ' of ' + lines.length + '\n' + lineNumbered(slice)
  }
  if (name === 'search_files') {
    return searchFiles(root, input.path || '.', input.query, input.maxResults || 50)
  }
  if (name === 'write_file') {
    return writeFile(root, input.path, input.content)
  }
  if (name === 'edit_file') {
    return editFile(root, input.path, input.oldText, input.newText, input.replaceAll === true)
  }
  if (name === 'run_command') {
    return runCommand(root, input.command, input.cwd, input.timeoutMs, ctx)
  }
  if (name === 'browser_launch') {
    const driver = agentDriver(ctx)
    const result = await driver.launch(input.url, {
      width: input.width,
      height: input.height,
      noSandbox: process.env.SMOKE_NO_SANDBOX === '1'
    })
    return JSON.stringify(Object.assign({ url: input.url }, result))
  }
  if (name === 'browser_act') {
    return browserAct(root, input, ctx)
  }
  if (name === 'browser_eval') {
    const value = await browserWorking(ctx).evaluate(String(input.expression), { awaitPromise: input.awaitPromise === true })
    return value === undefined ? '(undefined)' : (typeof value === 'string' ? value : JSON.stringify(value, null, 1))
  }
  if (name === 'browser_close') {
    /* 收尾用：没开也当成功（幂等），免得模型为了「关掉一个本来就没开的」反复试。 */
    await agentDriver(ctx).close()
    return 'browser closed'
  }
  if (name === 'test_run') {
    return runTestCases(root, input, ctx)
  }
  throw new Error('UNKNOWN_TOOL: ' + name)
}

module.exports = {
  toolDefinitions,
  executeTool,
  isProbablyText,
  lineNumbered,
  readTextFile,
  listDirectory,
  searchFiles,
  replaceFile,
  writeFile,
  editFile,
  commandBlocked,
  commandProgram,
  isDangerousCommand: policy.isDangerousCommand,
  runCommand,
  agentDriver,
  browserWorking,
  browserAct,
  runTestCases
}
