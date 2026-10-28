'use strict'

/**
 * renderer-smoke.js — 渲染层运行时冒烟测试
 *
 * 背景：Chrome/Electron 在本机沙箱里跑无头渲染会被直接杀掉（SIGTERM 137），
 * 所以用 Node + 一个极简 DOM shim 把 src/renderer/icons.js + app.js 真正跑起来，
 * 断言侧边栏项目区（渲染 / 重命名 / 编辑 / 删除 / 菜单）与图标、扁平化样式的实际行为。
 *
 * 它补的是 check-syntax.js（只查语法）和 check-win7-compat.js（只查禁用 API/CSS）查不到的逻辑回归。
 *
 * 用法：node scripts/renderer-smoke.js     命中失败即 exit 1
 * 该脚本自身跨 Node 16/22，无外部依赖。
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer')

function readRenderer(file) {
  // 本仓库是 CRLF（Windows checkout），而用例里的 needle 大量带字面 '\n'（如
  // 'autoResizeComposer()\n'、'\n.titlebar-drag .page-actions {\n  display:'）。
  // 不归一的话这些断言永远匹配不到 → 静默假红。读取时统一成 LF，用例只面对一种行尾。
  return fs.readFileSync(path.join(RENDERER_DIR, file), 'utf8').replace(/\r\n/g, '\n')
}

/* ---------- 极简 DOM shim ---------- */

/* 复合选择器匹配：支持 tag / .class / [attr] / [attr=value] 的自由组合，
   让 app.js 里的 querySelector(All) 在 shim 下真正生效。
   不支持的语法（后代、子选择器、伪类等）返回 null，调用方退回空结果（与旧行为一致）。 */
function parseCompoundSelector(selector) {
  const text = String(selector || '').trim()
  if (text === '' || /[\s>+~,]/.test(text)) return null
  const pattern = /(\*|[a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g
  const parts = []
  let consumed = 0
  let match = pattern.exec(text)
  while (match !== null) {
    if (match.index !== consumed) return null
    consumed = match.index + match[0].length
    if (match[1]) parts.push({ type: 'tag', value: match[1].toLowerCase() })
    else if (match[2]) parts.push({ type: 'class', value: match[2] })
    else if (match[3]) {
      const eq = match[4] !== undefined ? match[4]
        : (match[5] !== undefined ? match[5]
          : (match[6] !== undefined ? match[6] : null))
      parts.push({ type: 'attr', value: match[3], eq })
    }
    match = pattern.exec(text)
  }
  if (consumed !== text.length || parts.length === 0) return null
  return parts
}

function matchesCompoundSelector(el, parts) {
  for (const part of parts) {
    if (part.type === 'tag') {
      if (String(el.tagName || '').toLowerCase() !== part.value) return false
      continue
    }
    if (part.type === 'class') {
      const own = String(el.className || '').split(/\s+/)
      if (own.indexOf(part.value) === -1) return false
      continue
    }
    const value = el.getAttribute ? el.getAttribute(part.value) : null
    if (part.eq === null || part.eq === undefined) {
      if (value === null || value === undefined) return false
      continue
    }
    if (String(value) !== String(part.eq)) return false
  }
  return true
}

function querySelectorAllShim(root, selector, firstOnly) {
  const parts = parseCompoundSelector(selector)
  if (parts === null) return []
  const out = []
  const walk = (el) => {
    for (const child of (el.children || [])) {
      if (matchesCompoundSelector(child, parts)) {
        out.push(child)
        if (firstOnly) return true
      }
      if (walk(child)) return true
    }
    return false
  }
  walk(root)
  return out
}

/** 最小 CSSStyleDeclaration：面板要往 documentElement 上写 --panel-width，
    纯对象没有 setProperty，会把 panel.js 的 init 直接打挂。 */
function makeStyle() {
  const props = {}
  return {
    setProperty(name, value) { props[name] = String(value) },
    removeProperty(name) { delete props[name] },
    getPropertyValue(name) { return props[name] === undefined ? '' : props[name] },
    _props: props
  }
}

/* 把 shim 节点拼成 HTML 串（innerHTML 读取用）。文本节点是 {nodeValue} 这种裸对象。 */
function serializeNode(node) {
  if (!node) return ''
  if (node.nodeValue !== undefined) return String(node.nodeValue)
  const tag = String(node.tagName || 'div').toLowerCase()
  const cls = String(node.className || '')
  const attr = cls ? ' class="' + cls + '"' : ''
  const inner = node.children && node.children.length
    ? node.children.map(serializeNode).join('')
    : String(node._text || '')
  return '<' + tag + attr + '>' + inner + '</' + tag + '>'
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    childNodes: [],
    attributes: {},
    dataset: {},
    style: makeStyle(),
    _text: '',
    _html: '',
    value: '',
    checked: false,
    title: '',
    hidden: false,
    disabled: false,
    className: '',
    /* classList 必须与 className 共享同一份数据。
       旧实现把两者做成两套独立状态，classList.add() 之后 className 不变，
       于是 querySelectorAll('.some-class') 查不到刚加上的类 —— 测试长期空转，
       "只有最新一条消息的操作行常显" 这个回归就是这样被漏掉的。 */
    classList: {
      _names() {
        return String(el.className || '').split(/\s+/).filter(Boolean)
      },
      add() {
        const names = this._names()
        for (const name of arguments) {
          if (names.indexOf(name) === -1) names.push(name)
        }
        el.className = names.join(' ')
      },
      remove() {
        const drop = Array.prototype.slice.call(arguments)
        el.className = this._names().filter((name) => drop.indexOf(name) === -1).join(' ')
      },
      contains(name) { return this._names().indexOf(name) !== -1 },
      toggle(name, on) {
        const has = this.contains(name)
        if (on === undefined) {
          if (has) this.remove(name)
          else this.add(name)
          return
        }
        if (on) this.add(name)
        else this.remove(name)
      }
    },
    appendChild(child) { this.children.push(child); this.childNodes.push(child); child.parentNode = this; return child },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child)
      this.childNodes = this.childNodes.filter((c) => c !== child)
      return child
    },
    insertBefore(child) { this.children.unshift(child); return child },
    /* remove() 必须真从父节点摘掉：app.js 的 clearMessages() 靠 child.remove() 清空消息区，
       旧实现是空函数 → 消息区在 shim 里只增不减，凡断言「有几个块」的检查全是错的。 */
    remove() {
      if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
        this.parentNode.removeChild(this)
      }
    },
    /* 监听器要真的存下来 —— 「点停止只停本会话」这类断言必须走真实的事件回调，
       光断言源码里有 addEventListener 是假绿（stub 以前直接吞掉所有监听）。 */
    addEventListener(type, handler) {
      if (!type || typeof handler !== 'function') return
      if (!el._listeners) el._listeners = {}
      if (!el._listeners[type]) el._listeners[type] = []
      el._listeners[type].push(handler)
    },
    removeEventListener(type, handler) {
      const list = el._listeners && el._listeners[type]
      if (!list) return
      el._listeners[type] = list.filter((item) => item !== handler)
    },
    setAttribute(k, v) { this.attributes[k] = String(v) },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k] },
    removeAttribute(k) { delete this.attributes[k] },
    querySelector(selector) { return querySelectorAllShim(this, selector, true)[0] || null },
    querySelectorAll(selector) { return querySelectorAllShim(this, selector, false) },
    closest(selector) {
      const parts = selector.charAt(0) === '#' ? null : parseCompoundSelector(selector)
      let node = el
      while (node) {
        if (selector.charAt(0) === '#' ? node.id === selector.slice(1) : (parts && matchesCompoundSelector(node, parts))) return node
        node = node.parentNode
      }
      return null
    },
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 } },
    focus() {}, blur() {},
    click() {
      if (el._onclick) el._onclick()
      const list = (el._listeners && el._listeners.click) || []
      let stopped = false
      const event = { target: el, stopPropagation() { stopped = true }, preventDefault() {} }
      for (const handler of list.slice()) {
        handler(event)
      }
      if (!stopped) documentStub.dispatchEvent('click', event)
    },
    scrollTo() {},
    get textContent() { return this._text },
    set textContent(v) { this._text = String(v); this.children = []; this.childNodes = [] },
    /* innerHTML 读取必须真把子节点拼出来：app.js 里「思考过程」是用
       `content.innerHTML` 存进 session.processHtml 的，旧实现只回放曾经赋值的字符串，
       于是 appendChild 攒出来的内容在测试里恒为空串 —— 任何 processHtml 断言都是假绿。 */
    get innerHTML() {
      return this._html + this.children.map(serializeNode).join('')
    },
    set innerHTML(v) { this._html = String(v); this.children = []; this.childNodes = [] },
    get scrollTop() { return this._scrollTop || 0 },
    set scrollTop(v) { this._scrollTop = v },
    scrollHeight: 100, clientHeight: 100, offsetHeight: 100, offsetWidth: 100
  }
  return el
}

const registry = new Map()
function getEl(id) {
  if (!registry.has(id)) {
    const element = makeEl('div')
    element.id = id
    registry.set(id, element)
  }
  return registry.get(id)
}

;['projectList', 'chatList', 'projectFolderList', 'projectName', 'projectModalTitle',
  'projectModal', 'projectMenu', 'sessionMenu', 'confirmModal', 'textPromptModal',
  'statusLine', 'sidebarScroll', 'settingsModal', 'pluginList', 'composerModelMenu',
  'composerModelLabel', 'providerList', 'maxIterations', 'maxTokens', 'maxConcurrentRuns',
  'contextWindowTokens', 'contextAutoCompress', 'keepRecentMessages', 'requestTimeoutSeconds', 'themeLabel',
  'workspacePath', 'messages', 'messagesInner', 'input', 'composerAttachments',
  'dirBrowserModal'].forEach(getEl)

const storage = new Map()

/* 整页就是一个网页，「刷新」= location.reload()、「链接」= location.origin。
   两样都得给 shim 造出来，否则 appLink / reloadPage 在冒烟里永远走兜底分支。 */
const locationStub = {
  href: 'http://127.0.0.1:8080/',
  protocol: 'http:',
  host: '127.0.0.1:8080',
  origin: 'http://127.0.0.1:8080',
  pathname: '/',
  reload() { sandboxRef.__reloads += 1 }
}
let sandboxRef = null

const documentStub = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  getElementById: (id) => getEl(id),
  createElement: (tag) => makeEl(tag),
  createTextNode: (t) => ({ nodeValue: t }),
  _listeners: {},
  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = []
    this._listeners[type].push(handler)
  },
  removeEventListener(type, handler) {
    if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((item) => item !== handler)
  },
  dispatchEvent(type, event) {
    for (const handler of (this._listeners[type] || []).slice()) handler(event)
  },
  querySelector(selector) {
    const roots = [documentStub.documentElement, documentStub.body]
    for (const root of roots) {
      const found = querySelectorAllShim(root, selector, true)
      if (found.length > 0) return found[0]
    }
    return null
  },
  querySelectorAll(selector) {
    const out = []
    const roots = [documentStub.documentElement, documentStub.body]
    for (const root of roots) {
      for (const item of querySelectorAllShim(root, selector, false)) out.push(item)
    }
    return out
  },
  execCommand() {},
  activeElement: null
}

/* ---------- 运行时沙箱 ---------- */

const settingsState = {
  projects: [],
  currentProjectId: '',
  workspacePath: '/ws/a',
  theme: 'dark',
  models: []
}

const mutationObservers = []

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer }, clearInterval,
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
  /* vm 里的新 context 不带 Web 全局，但面板的 decodeBytes 要用它解 UTF-8/GBK。
     宿主 Node（16/22）都带完整 ICU，两种编码都能解。 */
  TextDecoder: globalThis.TextDecoder,
  TextEncoder: globalThis.TextEncoder,
  /* 面板保存时要把字节编成 base64（bytesToBase64 用 btoa）*/
  btoa: globalThis.btoa ? globalThis.btoa.bind(globalThis) : (value) => Buffer.from(String(value), 'binary').toString('base64'),
  atob: globalThis.atob ? globalThis.atob.bind(globalThis) : (value) => Buffer.from(String(value), 'base64').toString('binary'),
  FileReader: function () {},
  /* init() 里的输入框自愈要用它；没这个 stub 就走不到 init（停止按钮那类断言就假绿了） */
  MutationObserver: function MutationObserver(callback) {
    const observer = {
      callback,
      targets: [],
      observe(target, options) { this.targets.push({ target, options }) },
      disconnect() { this.targets = [] },
      takeRecords() { return [] }
    }
    mutationObservers.push(observer)
    return observer
  },
  mutationObservers,
  navigator: {
    /* 「转发」按钮会写剪贴板；写不进去也不该拦着打开浏览器 */
    clipboard: { writeText: async (value) => { sandbox.__clipboard.push(String(value)) } }
  },
  location: locationStub,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  },
  document: documentStub,
  // Browser layout APIs used by title alignment and panel visibility.
  getComputedStyle: (element) => Object.assign({ paddingLeft: '0px', display: 'block' }, element.style || {}),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  settingsState,
  harnessResults: null
}
sandboxRef = sandbox
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.window.addEventListener = () => {}
/* 宿主侧开关：__dshRunningSessions 决定 getState 报「哪几条会话在跑」，__sendCalls
   记录渲染层真正发出去的东西。__dshRunning 是「老宿主」开关（只报全局 running、
   没有 runningSessions），用来验证向后兼容的退化路径。 */
sandbox.__dshRunning = false
sandbox.__dshRunningSessions = []
sandbox.__sendCalls = []
sandbox.__stopCalls = []
sandbox.__resetCalls = []
sandbox.__approveCalls = []
/* 宿主侧 ui-store（会话/偏好 storage 双写）的假实现：
   __uiStoreRemote 里放「服务端已有数据」（loadSessionStore 会优先用它），
   __uiStorePuts 记录渲染层推上来的每一份。设成 null 的方法可以模拟老宿主。 */
sandbox.__uiStoreRemote = null
sandbox.__uiStorePuts = []
sandbox.window.dsh = {
  isDesktop: false,
  getState: async () => {
    const value = {
      settings: settingsState,
      workspacePath: settingsState.workspacePath,
      plugins: [],
      tools: [],
      running: sandbox.__dshRunning === true
    }
    if (Array.isArray(sandbox.__dshRunningSessions)) {
      value.runningSessions = sandbox.__dshRunningSessions.slice()
      value.running = value.runningSessions.length > 0
      value.maxConcurrentRuns = 3
    }
    return value
  },
  uiStoreGet: async () => ({ ok: true, store: sandbox.__uiStoreRemote }),
  uiStorePut: async (store) => {
    sandbox.__uiStorePuts.push(JSON.parse(JSON.stringify(store || {})))
    sandbox.__uiStoreRemote = JSON.parse(JSON.stringify(store || {}))
    return { ok: true, updatedAt: Date.now() }
  },
  send: async (text, history, images, memory, sessionId) => {
    sandbox.__sendCalls.push({ text: text, images: images, history: history, memory: memory, sessionId: sessionId })
    return true
  },
  stop: async (sessionId) => {
    sandbox.__stopCalls.push(sessionId)
    return true
  },
  resetChat: async (sessionId) => {
    sandbox.__resetCalls.push(sessionId)
    return true
  },
  approve: async (id, approved) => {
    sandbox.__approveCalls.push({ id: id, approved: approved === true })
    return true
  },

  saveSettings: async (patch) => {
    Object.assign(settingsState, patch)
    return JSON.parse(JSON.stringify(settingsState))
  },
  setWorkspace: async (p) => {
    settingsState.workspacePath = p
    return { settings: settingsState, workspacePath: p }
  },
  onEvent() {},
  listServerDir: async () => ({ path: '/', parent: null, dirs: [] }),
  mkdirServerDir: async () => ({}),
  openPath: async () => {},
  openExternal: async (target) => { sandbox.__openedExternally.push(String(target)); return 'OK' }
}
sandbox.__openedExternally = []
sandbox.__reloads = 0
sandbox.__clipboard = []

const context = vm.createContext(sandbox)
vm.runInContext(readRenderer('icons.js'), context, { filename: 'icons.js' })
vm.runInContext(readRenderer('markdown.js'), context, { filename: 'markdown.js' })
vm.runInContext(readRenderer('highlight.js'), context, { filename: 'highlight.js' })
vm.runInContext(readRenderer('app.js'), context, { filename: 'app.js' })
/* 右侧文件面板。它 init() 里第一件事就是 getElementById('filePanel') —— shim 里没有这个
   元素，会直接 return，所以能安全地在这里加载（只是把纯函数和 window.filePanel 挂上）。 */
vm.runInContext(readRenderer('panel.js'), context, { filename: 'panel.js' })

/* ---------- 断言 ---------- */

const results = []
function ok(name, cond, extra) {
  results.push({ name, pass: Boolean(cond), extra: extra === undefined ? '' : String(extra) })
}

const iconsSrc = readRenderer('icons.js')
const cssSrc = readRenderer('style.css')
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
const toolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'agent', 'tools.js'), 'utf8')
const appSrc = readRenderer('app.js')
const tasksSrc = readRenderer('tasks.js')
const enhancementsSrc = readRenderer('ui-enhancements.js')
const policySrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'agent', 'permission-policy.js'), 'utf8')
const agentSrc = ['src/main/agent/agent.js', 'src/main/runtime/run-turn.js', 'src/main/flow/prompt-policy.js'].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n')
const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8')
const poolSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'agent', 'agent-pool.js'), 'utf8')
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8')
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8')
const bridgeSrc = readRenderer('web-bridge.js')
const settingsSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'agent', 'settings.js'), 'utf8')

sandbox.ok = ok
sandbox.results = results
sandbox.iconsSrc = iconsSrc
sandbox.cssSrc = cssSrc
sandbox.htmlSrc = htmlSrc
sandbox.toolsSrc = toolsSrc
sandbox.appSrc = appSrc
sandbox.tasksSrc = tasksSrc
sandbox.enhancementsSrc = enhancementsSrc
sandbox.policySrc = policySrc
sandbox.agentSrc = agentSrc
sandbox.serverSrc = serverSrc
sandbox.poolSrc = poolSrc
sandbox.mainSrc = mainSrc
sandbox.preloadSrc = preloadSrc
sandbox.bridgeSrc = bridgeSrc
sandbox.settingsSrc = settingsSrc

/* ---------------------------------------------------------------- 右侧文件面板
   ⚠️ 静态断言（正则 / 子串）一律在这边（宿主脚本）算好再传进去。
   下面 `checks` 那段是个模板字符串，里面写 `/\s/` 会被模板字符串先吃掉一层转义、
   变成 `/s/` —— 静默失配，很难查。所以正则只出现在这个文件里。 */

const panelSrc = readRenderer('panel.js')
const highlightSrc = readRenderer('highlight.js')

/** 取某条 CSS 规则的大括号内容（找不到返回 null） */
function blockOf(css, selector) {
  const at = css.indexOf(selector)
  if (at < 0) return null
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return css.slice(open + 1, close)
}

const PANEL_HTML_TOKENS = [
  'id="filePanel"', 'id="panelToggle"', 'id="panelResize"', 'id="panelExplorerToggle"',
  'id="panelTree"', 'id="panelTabs"', 'id="panelPreview"', 'id="panelVscode"',
  'id="panelTerminal"', 'id="panelRefresh"', 'id="explorerResize"',
  'id="terminalView"', 'id="terminalCwdLabel"', 'id="terminalOut"', 'id="terminalClear"',
  'id="terminalSplit"', 'id="terminalDirs"', 'vendor/xterm/xterm.js', 'vendor/xterm/addon-fit.js', 'vendor/xterm/xterm.css'
]
const missingHtmlTokens = PANEL_HTML_TOKENS.filter((token) => htmlSrc.indexOf(token) === -1)

/* 高亮 token 类名：highlight.js 里出现过的，样式表里都得有配色 */
const hlNames = []
{
  const re = /cls:\s*'([a-z-]+)'/g
  let match = re.exec(highlightSrc)
  while (match !== null) {
    hlNames.push(match[1])
    match = re.exec(highlightSrc)
  }
}

const scriptOrder = ['markdown.js', 'highlight.js', 'icons.js', 'vendor/xterm/xterm.js', 'vendor/xterm/addon-fit.js', 'app.js', 'panel.js']
  .map((file) => htmlSrc.indexOf('src="' + file + '"'))
  .every((at, index, list) => at !== -1 && (index === 0 || list[index - 1] < at))

const panelOpenBlock = blockOf(cssSrc, '\n#app.panel-open {') || ''
const mainBlock = blockOf(cssSrc, '\n.main {') || ''
const collapsedPanelBlock = blockOf(cssSrc, '#app.sidebar-collapsed.panel-open .main {') || ''
const hiddenBlock = blockOf(cssSrc, '#app:not(.panel-open) .file-panel {') || ''
const chatHiddenBlock = blockOf(cssSrc, 'html.chat-hidden #app.panel-open {') || ''
const titlebarBlock = blockOf(cssSrc, '\n.titlebar-drag {') || ''
const titlebarButtonsBlock = blockOf(cssSrc, '.titlebar-drag button,') || ''
const titlebarTogglesBlock = blockOf(cssSrc, '.titlebar-drag .sidebar-toggle,') || ''
const titlebarMatch = /<header\b[^>]*id="titlebarDrag"[\s\S]*?<\/header>/.exec(htmlSrc)
const titlebarHtml = titlebarMatch ? titlebarMatch[0] : ''
const resizeBlock = blockOf(cssSrc, '\n.panel-resize {') || ''
/* 2026-09-19 用户报的两个真机 bug（按钮点不了 / 没有滚动条）的静态守卫 */
const appGridBlock = blockOf(cssSrc, '\n#app {') || ''
const panelExplorerBlock = blockOf(cssSrc, '\n.panel-explorer {') || ''
const panelMainBlock = blockOf(cssSrc, '\n.panel-main {') || ''
const panelScrollbarBlock = blockOf(cssSrc, '.panel-tree::-webkit-scrollbar,') || ''
const panelScrollThumbBlock = blockOf(cssSrc, '.panel-tree::-webkit-scrollbar-thumb,') || ''
const sidebarScrollThumbBlock = blockOf(cssSrc, '.sidebar-scroll::-webkit-scrollbar-thumb {') || ''
const explorerResizeBlock = blockOf(cssSrc, '\n.explorer-resize {') || ''
const explorerResizeHiddenBlock = blockOf(cssSrc, '.file-panel.panel-explorer-hidden .explorer-resize {') || ''
const explorerResizeHoverBlock = blockOf(cssSrc, '.explorer-resize:hover,') || ''
const panelResizeHoverBlock = blockOf(cssSrc, '.panel-resize:hover,') || ''
const tabCloseBlock = blockOf(cssSrc, '\n.panel-tab-close {') || ''

/* 2026-09-19 用户要的顶栏页面操作（刷新整页 / 转发链接）+ 「上一个会话仍在执行」提示条 */
const pageActionsBlock = blockOf(cssSrc, '\n.titlebar-drag .page-actions {\n  display:') || ''
const restoreChatBlock = blockOf(cssSrc, 'html.chat-hidden .titlebar-restore {') || ''
const runHintBlock = blockOf(cssSrc, '\n.composer-run-hint {') || ''

/* 所有 #app.panel-open（含 .sidebar-collapsed 变体）的三列规则都必须用 --panel-width
   写第三列。响应式覆盖里再用 px/vw 写死一层的话，CSS 会把 panel.js 算好的宽度
   悄悄压回去 —— 2026-09-19 真机量到过：1000px 窗口里 JS 给 460px、CSS 硬压回 420px。
   「只看文件」那条除外（它就是要把前两列压成 0、面板铺满，本来就不用这个变量）。 */
const panelColumnBad = []
{
  const re = /([^{]*#app[a-z.-]*panel-open[^{]*)\{([^}]*)\}/g
  let match
  while ((match = re.exec(cssSrc)) !== null) {
    const selector = match[1].trim()
    const body = match[2]
    if (selector.indexOf('chat-hidden') >= 0) continue
    if (body.indexOf('grid-template-columns') === -1) continue
    if (body.indexOf('var(--panel-width') === -1) panelColumnBad.push(selector + ' ⇒ ' + body.replace(/\s+/g, ' ').trim())
  }
}

const panelStatic = {
  scriptOrder: scriptOrder,
  htmlTokens: missingHtmlTokens.length === 0,
  missingHtmlTokens: missingHtmlTokens,
  panelOpenColumns: /grid-template-columns:\s*260px 1fr var\(--panel-width/.test(panelOpenBlock),
  mainColumn: /grid-column:\s*2\s*(;|})/.test(mainBlock),
  collapsedPanelMain: /grid-column:\s*1\s*\/\s*3\s*(;|})/.test(collapsedPanelBlock),
  panelHidden: /display:\s*none/.test(hiddenBlock),
  chatHiddenColumns: /grid-template-columns:\s*0 0 1fr/.test(chatHiddenBlock),
  titlebarContainsControls: ['sidebarToggle', 'pageActions', 'windowTitle', 'panelToggle', 'restoreChat']
    .every((id) => titlebarHtml.indexOf('id="' + id + '"') !== -1)
    && htmlSrc.indexOf('</header>') < htmlSrc.indexOf('<div id="app">'),
  contentBelowTitlebar: /height:\s*48px/.test(titlebarBlock)
    && /height:\s*calc\(100vh - 48px\)/.test(appGridBlock)
    && /position:\s*static/.test(titlebarTogglesBlock),
  resizeUsable: resizeBlock !== '' && !/display:\s*none/.test(resizeBlock),
  /* 网格行钉住剩余内容高度，避免文件面板把整个网格撑高，打断内部滚动链。 */
  gridRowPinned: /grid-template-rows:\s*minmax\(\s*0\s*,\s*1fr\s*\)/.test(appGridBlock),
  explorerMinHeight: /min-height:\s*0/.test(panelExplorerBlock),
  mainMinHeight: /min-height:\s*0/.test(panelMainBlock),
  /* ② 滚动条要和侧边栏同一套（用户：样式需要和其他的一样） */
  scrollbarsMatchSidebar: panelScrollbarBlock.indexOf('display: block') >= 0
    && panelScrollThumbBlock.indexOf('var(--scrollbar-thumb)') >= 0
    && sidebarScrollThumbBlock.indexOf('var(--scrollbar-thumb)') >= 0,
  /* ③ 2026-09-19 用户续报的三件事 */
  /* 文件列表宽度走 CSS 变量（它是 flex-basis，写 width 不生效） */
  explorerWidthVar: /flex:\s*0 0 var\(--explorer-width/.test(panelExplorerBlock),
  /* 文件列表右缘的拖拽把手：跟面板那条同款，不能 display:none（否则拖不动） */
  explorerResizeUsable: explorerResizeBlock.indexOf('left: -4px') >= 0
    && explorerResizeBlock.indexOf('display: none') === -1,
  explorerResizeHiddenWithExplorer: explorerResizeHiddenBlock.indexOf('display: none') >= 0,
  /* 响应式覆盖不得把面板第三列写死（CSS/JS 打架 = 拖不动、宽度对不上） */
  panelColumnBad: panelColumnBad,
  /* 两条把手的高亮必须各用各的 body 类，共用一条的话拖这条另一条也亮 */
  /* 两条把手的高亮必须各用各的 body 类，共用一条的话拖这条另一条也亮。
     注意 body.resizing-panel 在**选择器**里而不是块里，得在全文里查。 */
  resizeHighlightsSplit:
    cssSrc.indexOf('body.resizing-panel .panel-resize') >= 0
    && cssSrc.indexOf('body.resizing-explorer .explorer-resize') >= 0
    && cssSrc.indexOf('body.resizing .panel-resize') === -1
    && cssSrc.indexOf('body.resizing .explorer-resize') === -1,
  /* 拖动时打晕 iframe（PDF），不然鼠标划过去事件被吃掉、像卡住 */
  iframeDisabledWhileResizing: /body\.resizing iframe\s*\{[^}]*pointer-events:\s*none/.test(cssSrc),
  /* ---- 2026-09-19 用户截图续报的两条 ---- */
  /* 输入框上限钉死 180px（innerHeight 比例会让输入框长到半屏） */
  composerMaxHeightFixed: appSrc.indexOf('const maxHeight = 180') !== -1
    && appSrc.indexOf('innerHeight * 0.4') === -1,
  /* style.css 不得再用 40vh 当 composer 上限（两套 max-height 打架时后者赢） */
  composerNoVhCap: cssSrc.indexOf('max-height: 40vh') === -1,
  /* 拖拽 rAF 节流：mousemove 只记事件，帧里才 apply（一帧最多一次整列重排） */
  resizeRafThrottled: panelSrc.indexOf('requestAnimationFrame(flush)') !== -1
    && panelSrc.indexOf('cancelAnimationFrame(frame)') !== -1,
  /* applyExplorer 值未变就跳过（applyWidth 连带调用不再白发样式失效） */
  explorerApplySkipsUnchanged: panelSrc.indexOf('if (next === panel.explorerWidth) return') !== -1,
  /* ---- 2026-09-19 标签页（用户截图骂的） ---- */
  /* 关闭按钮平时藏、悬停标签才露（0.65 常显太小太灰，用户：不好看也看不见） */
  tabCloseHoverOnly: tabCloseBlock.indexOf('opacity: 0') >= 0
    && tabCloseBlock.indexOf('opacity: 0.65') === -1
    && cssSrc.indexOf('.panel-tab:hover .panel-tab-close') >= 0,
  /* × 要够大才看得见（11px → 13px，按钮 18px）；renderIcon 给的是裸 svg，选择器不能带 .icon；
     通用 button 的 8px 12px 内边距必须重置掉，否则 border-box 下内容区 0 宽、× 隐形 */
  tabCloseBigger: /width:\s*18px/.test(tabCloseBlock)
    && /panel-tab-close svg \{[^}]*width:\s*13px/.test(cssSrc)
    && tabCloseBlock.indexOf('padding: 0') >= 0
    && cssSrc.indexOf('.panel-tab-close .icon svg') === -1,
  /* 标签多了横向滚：滚轮搬成横向（overflow-x:auto 由 CSS 保证） */
  tabsWheelScroll: panelSrc.indexOf('setupTabsScroller') !== -1
    && panelSrc.indexOf('scrollLeft') !== -1,
  /* ---- 终端（三期 → xterm 改版）---- */
  terminalApiWired: panelSrc.indexOf('function setupTerminal') !== -1
    && panelSrc.indexOf('termSubscribe') !== -1
    && panelSrc.indexOf('termStart') !== -1
    && panelSrc.indexOf('decodeBytes(base64ToBytes') !== -1,
  /* 终端停靠预览区**下方**：高度走 --terminal-height 变量 + 独立横向分隔条；
     旧的「终端模式藏掉预览」CSS 必须删干净 */
  terminalDocked: cssSrc.indexOf('.panel-terminal') >= 0
    && cssSrc.indexOf('var(--terminal-height') >= 0
    && cssSrc.indexOf('.terminal-resize') >= 0
    && cssSrc.indexOf('.file-panel.panel-terminal-mode .panel-preview') === -1,
  /* xterm 真终端内核已接：实例化 + fit + 本地行编辑 + 分隔条拖拽 */
  terminalXtermWired: panelSrc.indexOf('new window.Terminal') !== -1
    && panelSrc.indexOf('FitAddon') !== -1
    && panelSrc.indexOf('function handleTerminalData') !== -1
    && panelSrc.indexOf('function bindTerminalResize') !== -1,
  /* 旧输入行必须删干净（输入/回显都归 xterm 了） */
  terminalInputGone: panelSrc.indexOf('terminalInput') === -1
    && cssSrc.indexOf('.terminal-input-row') === -1,
  /* 目录切换（用户定稿）：编号列表，弃下拉框；⌥+数字热键在 xterm 收键前拦截 */
  terminalDirsList: htmlSrc.indexOf('id="terminalDirs"') !== -1
    && cssSrc.indexOf('.terminal-dir-item') >= 0
    && panelSrc.indexOf('function renderTerminalDirs') !== -1
    && panelSrc.indexOf('function terminalDirHotkey') !== -1
    && panelSrc.indexOf('attachCustomKeyEventHandler') !== -1
    && panelSrc.indexOf('toggleCwdMenu') === -1
    && cssSrc.indexOf('.terminal-cwd-menu') === -1,
  /* ---- 编辑器（四期：编辑 + 实时保存）----
     用户 2026-09-19：「可读文件，支持编辑保存为实时保存」。
     三条硬要求：① 按**原编码**写回（不然 GBK 文件一存就毁）
                ② 按**原换行**写回（textarea 会把 \r\n 吃成 \n）
                ③ 停手即存（防抖）+ 各类「临走」路径都要 flush */
  editorWired: panelSrc.indexOf('function startEdit') !== -1
    && panelSrc.indexOf('function saveNow') !== -1
    && panelSrc.indexOf('function scheduleSave') !== -1
    && panelSrc.indexOf('function flushSave') !== -1
    && panelSrc.indexOf('function forceSave') !== -1,
  editorKeepsEncoding: panelSrc.indexOf('function encodeText') !== -1
    && panelSrc.indexOf('function encodeGbk') !== -1
    && panelSrc.indexOf('function gbkReverse') !== -1
    && panelSrc.indexOf('function encodeUtf16') !== -1
    && panelSrc.indexOf("kind === 'utf-8-bom'") !== -1,
  editorKeepsEol: panelSrc.indexOf('function detectEol') !== -1
    && panelSrc.indexOf('function applyEol') !== -1,
  /* 防抖 + 所有「临走」路径都写：切标签 / 关标签 / 关面板 / 刷新 / 失焦 / beforeunload */
  editorAutosave: panelSrc.indexOf('AUTOSAVE_DELAY') !== -1
    && panelSrc.indexOf('function releaseEditorIfLeaving') !== -1
    && panelSrc.indexOf('await releaseEditorIfLeaving(target)') !== -1
    && panelSrc.indexOf('if (not(open)) flushSave()') !== -1
    && panelSrc.indexOf("ta.addEventListener('blur'") !== -1
    && panelSrc.indexOf("window.addEventListener('beforeunload'") !== -1,
  /* 冲突：mtime 不一样就不覆盖，要人点「强制保存」（force → expectedMtime 传 0 = 不检查） */
  editorConflictGuard: panelSrc.indexOf('MTIME_CONFLICT') !== -1
    && panelSrc.indexOf('force ? 0 : ed.mtime') !== -1
    && panelSrc.indexOf("window.appDialogs.confirm('文件已被外部修改。确定用当前编辑内容覆盖磁盘文件吗？')") !== -1,
  editorCss: cssSrc.indexOf('.preview-editor') >= 0
    && cssSrc.indexOf('.preview-bar') >= 0
    && cssSrc.indexOf('.editor-status') >= 0
    && cssSrc.indexOf('.panel-preview.is-editing') >= 0
    && cssSrc.indexOf('.panel-tab.dirty .panel-tab-label::after') >= 0,
  /* 编辑器必须真撑满预览区（不是挤成一条）。
     踩过的坑：style.css 顶部那条**远古全局** `textarea { max-height: 220px }`
     （composer 还是 textarea 的年代留下的；composer 现在已是 contenteditable 的
     .composer-input）一直泄漏到编辑器上，真机量到 taH=220 / 预览区 589。
     这条守卫钉死三件事：
       ① .preview-editor 自己声明 max-height: none（谁以后再加全局上限也压不扁它）
       ② 裸 `textarea { ... }` 规则里不许再出现 max-height（根因不许回来）
       ③ 预览区编辑态确实是纵向 flex（flex:1 才有意义） */
  editorFillsHeight: (function () {
    /* ⚠️ 必须先把 CSS 注释扒掉再匹配：上面那段注释里就写着 `textarea { max-height: 220px }`，
       不扒的话 [^}]* 会在注释里那个 } 上截断，拿到的「块」根本没有 max-height: none
       （这条守卫第一次就是这么假红的）。 */
    const css = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    const own = /\.preview-editor\s*\{[^}]*\}/.exec(css)
    /* 只认**裸** textarea 选择器：`.composer-card textarea` 之类带前缀的不算 */
    const bare = /(?:^|\})\s*textarea\s*\{[^}]*\}/.exec(css)
    return Boolean(own)
      && own[0].indexOf('max-height: none') >= 0
      && !(bare && bare[0].indexOf('max-height') >= 0)
      && /\.panel-preview\.is-editing\s*\{[^}]*flex-direction:\s*column/.test(css)
  })(),
  /* 输入框空了必须把内联高度撤掉（脏高度=「重启后输入框又变高」的病灶） */
  composerEmptyReset: appSrc.indexOf("input.style.height = ''") !== -1
    && appSrc.indexOf('autoResizeComposer()\n') !== -1,
  /* 只读约束对终端模块不适用（terminal-api 是服务端文件，不在 panelSrc 扫描范围） */
  hlTotal: hlNames.length,
  hlMissing: hlNames.filter((name) => cssSrc.indexOf('.hl-' + name) === -1),
  /* 只读：面板不得出现写盘 / 执行命令 / 外网 / node 内置模块 */
  /* 写口子在四期被**有意**放宽一条：面板现在能写文件（编辑 + 实时保存，用户 2026-09-19 要的）。
     但只能有一个口子 —— window.dsh.fsWrite。别的越权路径（建目录 / 执行命令 /
     node 内置模块）一个都不许出现。 */
  readOnly: panelSrc.indexOf('fsWrite') !== -1 && panelSrc.indexOf('fsMkdir') === -1
    && panelSrc.indexOf('runCommand') === -1 && panelSrc.indexOf('child_process') === -1,
  noExternal: !/https?:\/\//.test(panelSrc),
  noNodeRequire: !/require\s*\(\s*['"](electron|fs|path|child_process)['"]/.test(panelSrc)
}

/* ---------------------------------------------------------------- 2026-09-19 聊天收发两条
   用户报：① 切换会话后「发送中」状态还是上一个会话的、然后就发不出去了；
          ② 只发图片不写字会报错。
   静态守卫放在宿主侧（模板字符串吃转义），动态复现放在 checks 里。 */
const sendStatic = {
  /* ① 运行标志必须能自愈：常驻对表（对表 + 冲队列）+ 换会话对表 + 发之前对表 */
  runPoll: appSrc.indexOf('function startRunPoll') !== -1
    && appSrc.indexOf('state.runPoll = setInterval') !== -1
    && appSrc.indexOf('startRunPoll()') !== -1
    && appSrc.indexOf('setInterval(() => { syncRunningState() }') === -1,
  runPollFlushesQueue: /setInterval\(async \(\) => \{[\s\S]{0,120}?await syncRunningState\(\)[\s\S]{0,60}?flushPendingMessage\(\)/.test(appSrc),
  runPollUnref: appSrc.indexOf('state.runPoll.unref') !== -1,
  syncReturnsLive: /const next = await window\.dsh\.getState\(\)[\s\S]{0,1200}?applyRuns\(next\.runningSessions, next\.running\)[\s\S]{0,240}?return currentRunning\(\)/.test(appSrc),
  switchResyncsRun: appSrc.indexOf('syncRunningState().then(() => flushPendingMessage())') !== -1,
  switchDropsStaleThinking: appSrc.indexOf('state.currentThinkingDetails = null') !== -1,
  sendResyncsBeforeQueue: appSrc.indexOf('if (currentRunning())') !== -1
    && appSrc.indexOf('await syncRunningState()') !== -1,
  queueReArms: appSrc.indexOf('if (pendingCountForCurrent() > 0) scheduleQueueFlush()') !== -1,
  /* ② 只发图片不许塞空的 text 段 */
  rendererNoEmptyTextPart: appSrc.indexOf("String(text || '') === '' ? [] : [{ type: 'text', text: text }]") !== -1,
  agentNoEmptyTextPart: agentSrc.indexOf("text === '' ? imageParts : [{ type: 'text', text }].concat(imageParts)") !== -1,
  serverAllowsImageOnly: serverSrc.indexOf("text.trim() === '' && images.length === 0") !== -1
    && serverSrc.indexOf("images.length > 0 ? images : undefined") !== -1
}

/* ---------------------------------------------------------------- 2026-09-19 多实例并发
   用户：「那不行啊，我需要多个 agent 实例」。
   后端原来是单个 agent + 全局 running（第二条被 BUSY 顶回去），现在是一条会话一台
   worker（src/main/agent/agent-pool.js），事件/审批都盖 sessionId，渲染层按会话记账。
   静态守卫盯住「哪一层少了 sessionId / 又回到全局单值」这类退化。 */
const concurrencyStatic = {
  /* 池子本身：按会话隔离目录 + 上限 + 同会话重入判定 */
  poolIsPerSession: poolSrc.indexOf('this.workers = new Map()') !== -1
    && poolSrc.indexOf('this.running = new Map()') !== -1
    && poolSrc.indexOf('sessionDir(sessionId)') !== -1
    && poolSrc.indexOf('SESSION_BUSY') !== -1
    && poolSrc.indexOf('POOL_BUSY') !== -1,
  poolTagsEvents: poolSrc.indexOf('tag(sessionId, event)') !== -1
    && poolSrc.indexOf('worker.sessionId = key') !== -1,
  poolLimits: poolSrc.indexOf('maxConcurrentRuns') !== -1
    && poolSrc.indexOf('evictIfNeeded') !== -1,
  settingsHasLimit: settingsSrc.indexOf('maxConcurrentRuns') !== -1,
  /* 服务端：接池、按会话判忙、状态里回 runningSessions */
  serverUsesPool: serverSrc.indexOf('new AgentPool(') !== -1 && serverSrc.indexOf('new Agent(') === -1,
  serverSessionBusy: serverSrc.indexOf('pool.isRunning(sessionId)') !== -1
    && serverSrc.indexOf("error: 'SESSION_BUSY'") !== -1
    && serverSrc.indexOf("error: 'POOL_BUSY'") !== -1,
  serverStateHasRunningSessions: serverSrc.indexOf('runningSessions: pool.runningSessions()') !== -1,
  serverApprovalTagged: serverSrc.indexOf('sessionId: owner || undefined') !== -1
    && serverSrc.indexOf('approvalRequest, sessionId') !== -1,
  /* 桌面主进程：同一套池 */
  mainUsesPool: mainSrc.indexOf('new AgentPool(') !== -1 && mainSrc.indexOf('new Agent(') === -1
    && mainSrc.indexOf('pool.listPlugins()') !== -1,
  /* 两条入口都把 sessionId 带下去 */
  preloadCarriesSessionId: preloadSrc.indexOf('{ text, history, images, memory, sessionId }') !== -1
    && preloadSrc.indexOf("invoke('chat:stop', sessionId)") !== -1,
  bridgeCarriesSessionId: bridgeSrc.indexOf('{ text, history, images, memory, sessionId }') !== -1
    && bridgeSrc.indexOf('/api/chat') !== -1
    && bridgeSrc.indexOf("String(event.sessionId) !== String(sessionId)") !== -1,
  bridgeStopBySession: bridgeSrc.indexOf("request('POST', '/api/stop', { sessionId })") !== -1,
  /* 渲染层：按会话记账（runs 是 map，不是单个 activeRunSessionId） */
  rendererRunsMap: appSrc.indexOf('runs: {}') !== -1
    && appSrc.indexOf('function isSessionRunning') !== -1
    && appSrc.indexOf('function currentRunning') !== -1
    && appSrc.indexOf('function runningTotal') !== -1
    && appSrc.indexOf('activeRunSessionId') === -1,
  rendererRoutesBySession: appSrc.indexOf('const eventSessionId = event.sessionId') !== -1
    && appSrc.indexOf('function settleRun') !== -1
    /* 别的会话的过程事件不进本画布，但要走 recordBackgroundProcess 记进它自己
       （以前是裸 return，后台跑完的会话切回去思考过程是空的 —— 2026-09-19 的 bug） */
    && appSrc.indexOf('function recordBackgroundProcess') !== -1
    && appSrc.indexOf('recordBackgroundProcess(eventSessionId, event)') !== -1
    /* 路由完必须 return，不能继续往下走到画 DOM 的分支（否则 A 的增量会画到 B 上） */
    && appSrc.indexOf('recordBackgroundProcess(eventSessionId, event)\n    return') !== -1,
  /* 思考过程按会话记账：数据（processHtml）与视图（渲染）分开。
     注意写回必须是「本轮 + 此前记下的」，不能只写本轮（见 §⑧ 的行为级用例）。 */
  processRecordsBackground: appSrc.indexOf('function processRecord') !== -1
    && appSrc.indexOf('function commitProcessRecord') !== -1
    && appSrc.indexOf('mergeProcessHtml') !== -1
    && appSrc.indexOf('state.processBuffers') !== -1
    && appSrc.indexOf('state.thinkingBase') !== -1,
  processResumesLive: appSrc.indexOf('function resumeThinking') !== -1
    && appSrc.indexOf('dropProcessRecord(session.id)') !== -1
    && appSrc.indexOf('const staticProcessHtml = runningHere') !== -1,
  /* 授权弹窗单槽 → 必须排队，否则后到的抢槽、先弹的干等 5 分钟超时 */
  approvalQueued: appSrc.indexOf('function requestApproval') !== -1
    && appSrc.indexOf('function pumpApprovalQueue') !== -1
    && appSrc.indexOf('state.approvalQueue.push') !== -1
    && appSrc.indexOf("await requestApproval(request, '', event.id)") !== -1
    /* 当前会话那条也必须走排队入口，不许再直连弹窗（否则会把别人的槽顶掉） */
    && appSrc.indexOf('await approvalDialog(request)') === -1,
  backgroundApprovalHandled: appSrc.indexOf('function handleBackgroundApproval') !== -1
    && appSrc.indexOf('handleBackgroundApproval(key, event)') !== -1
    && appSrc.indexOf('await requestApproval(request, label, event.id)') !== -1,
  /* 服务端 5 分钟超时（expired）必须收掉还开着的弹窗，否则 approvalBusy 释放不了、队列永久堵死 */
  approvalExpiryReleases: appSrc.indexOf('function expireApproval') !== -1
    && appSrc.indexOf('state.approvalCurrentId') !== -1
    && appSrc.indexOf('expireApproval(event.id)') !== -1
    && appSrc.indexOf('state.approvalBusy = false') !== -1,
  rendererSendCarriesSessionId: appSrc.indexOf('window.dsh.send(workflowText, history, images, memory, sessionId)') !== -1 && appSrc.indexOf('workflowChat.textFor(session,text)') !== -1,
  rendererStopIsPerSession: appSrc.indexOf('window.dsh.stop(sessionId)') !== -1
    && appSrc.indexOf('resetChat(sessionId)') !== -1,
  rendererQueueIsPerSession: appSrc.indexOf('sessionId: state.currentSessionId,') !== -1
    && appSrc.indexOf('const sessionId = state.currentSessionId') !== -1,
  /* 别的会话在跑不再藏发送按钮（多实例下本会话照发） */
  rendererSendNotBlocked: appSrc.indexOf("send.classList.toggle('hidden', running)") !== -1
    && appSrc.indexOf('send.disabled = false') !== -1,
  /* 设置页能改并发上限（POOL_BUSY 的提示让用户来这里调） */
  settingsUiHasLimit: htmlSrc.indexOf('id="maxConcurrentRuns"') !== -1
    && appSrc.indexOf("byId('maxConcurrentRuns').value = settings.maxConcurrentRuns || 8") !== -1
    && appSrc.indexOf("maxConcurrentRuns: Math.max(1, Math.min(64, Number(byId('maxConcurrentRuns').value) || 8))") !== -1
    && appSrc.indexOf("const settingsAutoSaveIds = ['maxIterations', 'maxConcurrentRuns'") !== -1
}

/* ---------------------------------------------------------------- 2026-09-19 顶栏页面操作
   用户要：① 一个刷新整页的按钮（整页本来就是一个网页）② 一个转发图标，
   点了直接用系统默认浏览器打开当前软件的链接。
   另外「别的会话在跑」是真实状态（后端只有单个 agent），要有提示条说明白。 */
const pageStatic = {
  htmlWired: titlebarHtml.indexOf('id="pageActions"') !== -1
    && titlebarHtml.indexOf('id="pageRefresh"') !== -1
    && titlebarHtml.indexOf('id="pageShare"') !== -1,
  iconsExist: iconsSrc.indexOf("refresh: '<svg") !== -1 && iconsSrc.indexOf("external: '<svg") !== -1,
  clickWired: appSrc.indexOf("byId('pageRefresh').addEventListener('click', reloadPage)") !== -1
    && appSrc.indexOf("byId('pageShare').addEventListener('click', sharePageLink)") !== -1,
  /* 刷新 = 整页 reload（shell 的窗口本来就是从本地服务 loadURL 起来的） */
  reloadIsFullPage: /function reloadPage\(\)[\s\S]{0,240}?window\.location\.reload\(\)/.test(appSrc),
  /* 链接 = location.origin（http/https 才有；file:// 的开发模式返回空串） */
  linkIsOrigin: /function appLink\(\)[\s\S]{0,420}?loc\.protocol !== 'http:'[\s\S]{0,320}?origin \+ '\/'/.test(appSrc),
  shareCopiesAndOpens: /async function sharePageLink\(\)[\s\S]{0,700}?navigator\.clipboard\.writeText\(link\)[\s\S]{0,300}?openExternalLink\(link\)/.test(appSrc),
  /* 操作按钮在独立顶栏内按 flex 排列，离开窗口拖拽区。 */
  controlsInHeaderFlow: /display:\s*flex/.test(pageActionsBlock)
    && !/position:\s*absolute/.test(pageActionsBlock)
    && /app-region:\s*no-drag/.test(titlebarButtonsBlock),
  fileModeHasTopbarActions: cssSrc.indexOf('html.chat-hidden .page-actions') === -1
    && cssSrc.indexOf('html.chat-hidden .panel-toggle') === -1
    && /display:\s*inline-flex/.test(restoreChatBlock),
  /* 输入框上方那条提示：**只在并发池满时**出现。
     「别的会话在跑」不再提示 —— 那是正常并发（多实例池），用户 2026-09-19
     问「已经支持并发了，这个是不是就多余了」。留着这条守卫防回归。 */
  hintHtml: htmlSrc.indexOf('id="composerRunHint"') !== -1,
  hintCss: runHintBlock.indexOf('display: flex') >= 0 && cssSrc.indexOf('.composer-run-hint.hidden') !== -1,
  hintLogic: appSrc.indexOf('function updateComposerRunHint') !== -1
    && appSrc.indexOf('function runningTotal') !== -1
    /* 触发条件是「池满」，不是「有别的会话在跑」 */
    && appSrc.indexOf('total >= state.runLimit') !== -1
    && appSrc.indexOf("hint.classList.toggle('hidden', not(full))") !== -1
    /* 旧的「别的会话在跑就提示」必须删干净，否则又变成噪音。
       只查代码特征（`others === 0` 是旧实现独有的 toggle 条件）——
       中文文案不进静态守卫：注释里一提就自伤，文案回归交给下面的动态断言兜。 */
    && appSrc.indexOf('otherRunningCount') === -1
    && appSrc.indexOf('others === 0') === -1
    /* 池满也**不**禁用发送（禁了像 bug）；照样 send.disabled = false */
    && appSrc.indexOf('send.disabled = false') !== -1,
  /* 会话/偏好 storage 双写（会话记录跟端口解耦，2026-09-20）：
     加载 = 服务端优先、空 store 才用 localStorage（保存时自动迁移上去）；
     保存 = localStorage 照旧（同步兜底）+ in-flight 合并 PUT。
     老宿主没有这两个方法时退化为纯 localStorage（行为同旧版）。 */
  uiStoreWired: appSrc.indexOf('function uiStoreApi') !== -1
    && appSrc.indexOf('function scheduleUiStorePush') !== -1
    && appSrc.indexOf('function flushUiStorePush') !== -1
    && appSrc.indexOf('function buildUiStorePayload') !== -1
    && appSrc.indexOf('function applyUiPrefsFromServer') !== -1
    && appSrc.indexOf('await loadSessionStore()') !== -1
    && appSrc.indexOf('uiStoreRemoteCurrentSessionId') !== -1
    && appSrc.indexOf('window.addEventListener(\'beforeunload\'') !== -1,
  uiStoreBridge: preloadSrc.indexOf('ui-store:get') !== -1
    && preloadSrc.indexOf('uiStorePut') !== -1
    && bridgeSrc.indexOf("request('GET', '/api/ui-store')") !== -1
    && bridgeSrc.indexOf("request('PUT', '/api/ui-store', store)") !== -1
}

/* absoluteFor 的用例表。写在这里（普通 JS）才能直接写反斜杠，
   塞进模板字符串就得四层转义、越写越糊。 */
const pathCases = [
  { label: 'posix 相对路径', roots: [{ path: '/ws/project', name: 'project' }], input: 'src/app.js', expect: '/ws/project/src/app.js' },
  { label: './ 前缀', roots: [{ path: '/ws/project', name: 'project' }], input: './README.md', expect: '/ws/project/README.md' },
  { label: 'posix 绝对路径', roots: [{ path: '/ws/project', name: 'project' }], input: '/etc/hosts', expect: '/etc/hosts' },
  { label: '空路径', roots: [{ path: '/ws/project', name: 'project' }], input: '', expect: '' },
  { label: '当前目录', roots: [{ path: '/ws/project', name: 'project' }], input: '.', expect: '' },
  { label: 'windows 相对路径', roots: [{ path: 'C:\\proj', name: 'proj' }], input: 'src\\main.js', expect: 'C:\\proj\\src\\main.js' },
  { label: 'windows 绝对路径', roots: [{ path: 'C:\\proj', name: 'proj' }], input: 'D:\\other\\a.ts', expect: 'D:\\other\\a.ts' },
  { label: 'windows 混合分隔符', roots: [{ path: 'C:\\proj', name: 'proj' }], input: 'src/util/x.ts', expect: 'C:\\proj\\src\\util\\x.ts' },
  { label: '没有工作区根', roots: [], input: 'a.js', expect: '' }
]

sandbox.panelStatic = panelStatic
sandbox.sendStatic = sendStatic
sandbox.pageStatic = pageStatic
sandbox.concurrencyStatic = concurrencyStatic
sandbox.pathCases = pathCases
/* 含反斜杠的字符串一律从宿主侧喂进去 —— 模板字符串里写 'C:\\x\\y.md' 会变成
   'C:\x\y.md'，'\x' 是非法十六进制转义，直接语法错误。 */
sandbox.baseCases = {
  posix: '/a/b/c.js',
  posixWant: 'c.js',
  win: 'C:\\x\\y.md',
  winWant: 'y.md'
}

const checks = `
(async () => {
  settingsState.projects = [{ id: 'project_a', name: 'Alpha', folders: ['/ws/a'] }]
  settingsState.currentProjectId = 'project_a'
  state.settings = settingsState
  state.workspacePath = '/ws/a'
  sessionStore = {
    project_a: [{ id: 's1', projectId: 'project_a', scope: 'project', title: '会话1', messages: [], updatedAt: '2026-01-01T00:00:00Z' }],
    __recent__: []
  }

  // --- 项目列表渲染 ---
  renderProjectList()
  const listEl = document.getElementById('projectList')
  const row = listEl.children[0].children[0]
  ok('项目行渲染 folder/name/add/more 四个元素',
    JSON.stringify(row.children.map((c) => c.className)) === JSON.stringify(['project-folder-toggle', 'flat-name', 'project-add', 'project-more']),
    row.children.map((c) => c.className).join(' / '))

  // --- 扁平化 + 按钮 ---
  const flatIdx = cssSrc.indexOf('no background by default, background only on hover')
  const flatBlock = flatIdx >= 0 ? cssSrc.slice(flatIdx, flatIdx + 320) : ''
  ok('扁平化规则块存在', flatIdx !== -1)
  ok('扁平化规则覆盖 .project-more', flatBlock.indexOf('.project-more') !== -1)
  ok('扁平化默认背景透明', flatBlock.indexOf('background: transparent') !== -1)
  ok('扁平化默认边框透明', flatBlock.indexOf('border-color: transparent') !== -1)
  /* 2026-10-17 需求反转：行内操作图标（新建/更多）悬浮时**不要**背景，
     只有「更多」按钮本身在悬浮时才显形。守卫跟着改成「不许有背景」。 */
  ok('行内操作图标悬浮时不出现背景', cssSrc.indexOf('行内操作图标悬浮不给背景') !== -1)
  ok('悬浮才显出更多按钮', cssSrc.indexOf('.project-item:hover .project-more') !== -1)
  ok('删除菜单项红色样式', cssSrc.indexOf('.context-menu button.menu-danger') !== -1)

  // --- 侧栏底部（状态行 + 设置）去掉背景 ---
  ok('底部容器背景透明', /\.sidebar-footer \{[^}]*background: transparent/.test(cssSrc))
  ok('底部渐隐渐变已删除', cssSrc.indexOf('linear-gradient(180deg, rgba(15, 23, 42, 0)') === -1)
  ok('底部浅色渐隐已删除', cssSrc.indexOf('linear-gradient(180deg, rgba(255, 255, 255, 0)') === -1)
  const footerRules = cssSrc.match(/[^{}]*\.sidebar-footer[^{}]*\{[^}]*\}/g) || []
  ok('底部不再用 --sidebar 实心底', footerRules.length > 0 && footerRules.every((rule) => rule.indexOf('background: var(--sidebar)') === -1))

  // --- 右键菜单：按内容自适应 + 文字左对齐 ---
  ok('菜单不再写死 150px 宽', cssSrc.indexOf('min-width: 150px') === -1)
  ok('菜单按内容自适应宽度', cssSrc.indexOf('width: max-content') !== -1 && cssSrc.indexOf('min-width: 104px') !== -1)
  ok('菜单项恢复左对齐', /\\.context-menu button \\{[^}]*justify-content: flex-start/.test(cssSrc))
  ok('菜单定位按实测宽度', typeof placeContextMenu === 'function')
  ok('session 菜单同一套定位', typeof openSessionMenu === 'function')

  // --- 图标：干掉像瞄准镜的滑杆图标 ---
  ok('滑杆式(两条横线+圆圈)图标已移除', iconsSrc.indexOf('x1="4" y1="7" x2="20" y2="7"') === -1)
  const settingsIcon = window.renderIcon('settings')
  const generalIcon = window.renderIcon('general')
  ok('settings 已换成齿轮', settingsIcon.indexOf('19.4 15a1.65') !== -1 && settingsIcon.indexOf('<circle cx="12" cy="12" r="3"') !== -1)
  ok('general 已换成齿轮', generalIcon.indexOf('19.4 15a1.65') !== -1)
  ok('两处图标一致', settingsIcon === generalIcon)

  // --- 重命名 ---
  promptText = async () => 'Alpha2'
  await renameProject(settingsState.projects[0])
  ok('重命名写入设置', settingsState.projects[0].name === 'Alpha2', settingsState.projects[0].name)

  // --- 编辑：预填 + 增删工作目录 ---
  openProjectModal(settingsState.projects[0])
  ok('编辑模式已标记', state.editingProjectId === 'project_a')
  ok('编辑弹窗标题', document.getElementById('projectModalTitle').textContent === '编辑工作区', document.getElementById('projectModalTitle').textContent)
  ok('编辑预填名称', document.getElementById('projectName').value === 'Alpha2', document.getElementById('projectName').value)
  ok('编辑预填工作目录', JSON.stringify(state.projectFolders) === JSON.stringify(['/ws/a']), JSON.stringify(state.projectFolders))
  state.projectFolders.push('/ws/b')
  renderProjectFolders()
  ok('目录列表渲染两行', document.getElementById('projectFolderList').children.length === 2)
  removeProjectFolder(1)
  ok('removeProjectFolder 生效', state.projectFolders.length === 1)
  state.projectFolders.push('/ws/c')
  await saveProjectFromModal()
  ok('编辑保存写回工作目录', JSON.stringify(settingsState.projects[0].folders) === JSON.stringify(['/ws/a', '/ws/c']), JSON.stringify(settingsState.projects[0].folders))
  ok('编辑保存后弹窗复位', state.editingProjectId === '' && state.projectFolders.length === 0)

  // --- 新建 ---
  openProjectModal()
  ok('新建模式标题', document.getElementById('projectModalTitle').textContent === '新建工作区')
  ok('新建模式目录为空', state.projectFolders.length === 0)
  state.projectFolders.push('/ws/z')
  document.getElementById('projectName').value = 'Zeta'
  await saveProjectFromModal()
  ok('新建追加项目', settingsState.projects.length === 2 && settingsState.projects[1].name === 'Zeta')
  ok('新建后切到新项目', settingsState.currentProjectId === settingsState.projects[1].id)

  // --- 删除 ---
  confirmDialog = async () => true
  const doomedId = settingsState.projects[1].id
  sessionStore[doomedId] = [{ id: 'sx', projectId: doomedId, scope: 'project', title: 'x', messages: [] }]
  state.currentSessionId = 'sx'
  state.activeProjectId = doomedId
  await deleteProject(settingsState.projects[1])
  ok('删除移除项目', settingsState.projects.length === 1 && settingsState.projects[0].id === 'project_a', settingsState.projects.map((p) => p.id).join(','))
  ok('删除清掉其会话', sessionStore[doomedId] === undefined)
  ok('删除清空 currentSessionId', state.currentSessionId === '')
  ok('删除回落到剩余项目', settingsState.currentProjectId === 'project_a', settingsState.currentProjectId)
  ok('删除重置 activeProjectId', state.activeProjectId === 'project_a', state.activeProjectId)

  // --- 菜单 ---
  openProjectMenu(settingsState.projects[0], { currentTarget: { getBoundingClientRect: () => ({ right: 200, bottom: 40 }) }, stopPropagation: () => {} })
  ok('打开菜单记录目标项目', state.menuProject && state.menuProject.id === 'project_a')
  ok('打开菜单显示浮层', document.getElementById('projectMenu').classList.contains('hidden') === false)
  closeAllMenus()
  ok('关闭菜单清理状态', state.menuProject === null && state.menuSession === null)

  // --- 授权策略：服务端只问，客户端按会话/全局策略作答 ---
  const approveCalls = []
  window.dsh.approve = async (id, approved) => { approveCalls.push([id, approved]) }
  settingsState.approvalAllow = []
  state.settings = settingsState

  const demoSession = { id: 's_demo', projectId: 'project_a', scope: 'project', title: 'demo', messages: [] }
  ok('命令程序名提取 npm', policySrc.indexOf('function commandProgram') !== -1
    && policySrc.indexOf("'command:' + program") !== -1)
  ok('write/edit 请求也带 signature', policySrc.indexOf("signature: 'write'") !== -1 && policySrc.indexOf("signature: 'edit'") !== -1)

  ok('会话级授权初始为空', JSON.stringify(sessionApprovals(demoSession)) === '[]')
  ok('未授权时询问', approvalGrant({ kind: 'command', signature: 'command:npm' }, demoSession) === '')
  demoSession.approvals.push('command')
  ok('会话级命中', approvalGrant({ kind: 'command', signature: 'command:npm' }, demoSession) === 'session')
  ok('会话级授权只按 kind，不按程序名', approvalGrant({ kind: 'command', signature: 'command:rm' }, demoSession) === 'session')
  const fresh = { id: 's_fresh', projectId: 'project_a', scope: 'project', title: 'fresh', messages: [] }
  ok('新会话不带旧授权', approvalGrant({ kind: 'command', signature: 'command:npm' }, fresh) === '')
  settingsState.approvalAllow = ['command:npm']
  ok('全局放行清单命中', approvalGrant({ kind: 'command', signature: 'command:npm' }, fresh) === 'global')
  ok('全局清单不误放其他程序', approvalGrant({ kind: 'command', signature: 'command:rm' }, fresh) === '')

  // 弹窗：命令类显示「始终允许 npm」，写/编辑类隐藏
  // 注意：不能写成 "await approvalDialog(...)" 再在下一行 resolve —— 那会自己等自己（死锁）。
  const dialogPromise = approvalDialog({ kind: 'command', signature: 'command:npm', program: 'npm', title: 'Run command', detail: 'npm create vite@latest' })
  ok('弹窗已打开', document.getElementById('approvalModal').classList.contains('hidden') === false)
  ok('弹窗显示操作类型', document.getElementById('approvalKind').textContent === '运行命令')
  ok('弹窗显示完整命令', document.getElementById('approvalDetail').textContent === 'npm create vite@latest')
  ok('命令类显示始终允许', document.getElementById('approvalAlways').classList.contains('hidden') === false)
  ok('始终允许带程序名', document.getElementById('approvalAlways').textContent.indexOf('npm') !== -1)
  resolveApproval(true, 'session')
  const dialogDecision = await dialogPromise
  ok('resolveApproval 返回会话级决定', dialogDecision.approved === true && dialogDecision.scope === 'session', JSON.stringify(dialogDecision))
  ok('resolveApproval 收口弹窗', document.getElementById('approvalModal').classList.contains('hidden') === true)

  const denyPromise = approvalDialog({ kind: 'edit', signature: 'edit', title: 'Edit file', detail: 'a.js' })
  ok('写/编辑类隐藏始终允许', document.getElementById('approvalAlways').classList.contains('hidden') === true)
  approvalDenyScope()
  const denyDecision = await denyPromise
  ok('拒绝返回 once 且未批准', denyDecision.approved === false && denyDecision.scope === 'once', JSON.stringify(denyDecision))
  ok('拒绝也收口弹窗', state.approvalResolver === null)

  await rememberApproval('session', { kind: 'command' }, fresh)
  ok('会话级授权被记住', fresh.approvals.indexOf('command') !== -1)
  await rememberApproval('always', { kind: 'command', signature: 'command:node' }, fresh)
  ok('全局授权被记住并写设置', settingsState.approvalAllow.indexOf('command:node') !== -1)
  renderApprovalAllow()
  const allowList = document.getElementById('approvalAllowList')
  ok('设置页放行清单可渲染', allowList.children.length === settingsState.approvalAllow.length)

  ok('授权弹窗已入 HTML', htmlSrc.indexOf('id="approvalModal"') !== -1
    && htmlSrc.indexOf('id="approvalSession"') !== -1 && htmlSrc.indexOf('id="approvalAlways"') !== -1)
  ok('设置页放行清单已入 HTML', htmlSrc.indexOf('id="approvalAllowList"') !== -1 && htmlSrc.indexOf('id="clearApprovalAllow"') !== -1)
  ok('权限模式说明文案已配置', typeof PERMISSION_HINTS !== 'undefined' && typeof PERMISSION_HINTS.workspace === 'string'
    && PERMISSION_HINTS.workspace.indexOf('询问') !== -1)
  ok('授权弹窗样式已落 CSS', cssSrc.indexOf('.approval-detail') !== -1 && cssSrc.indexOf('.approval-allow-item') !== -1)
  ok('权限说明样式已落 CSS', cssSrc.indexOf('.dropdown-hint') !== -1)

  /* ---- 链接：markdown 渲染 + 默认浏览器打开 ---- */
  const mdLink = renderMarkdown('文档见 [spec](https://example.com/spec)')
  ok('markdown 链接渲染为 a 标签', mdLink.indexOf('<a href="https://example.com/spec" target="_blank"') !== -1, mdLink.slice(0, 80))
  const bare = renderMarkdown('去 https://example.com/a. 看看')
  ok('裸 URL 链接化且句点留在外面', bare.indexOf('<a href="https://example.com/a"') !== -1 && bare.indexOf('</a>.') !== -1, bare.slice(0, 100))
  const noScheme = renderMarkdown('不是链接 ftp://x.com')
  ok('非 http 协议不链接化', noScheme.indexOf('<a ') === -1)
  const mdImage = renderMarkdown('生成结果 ![预览](https://example.com/result.png)')
  ok('Markdown 图片直接渲染为回复内预览',
    mdImage.indexOf('class="md-image"') !== -1 && mdImage.indexOf('src="https://example.com/result.png"') !== -1,
    mdImage)
  __openedExternally.length = 0
  ok('openExternalLink 走桌面桥', openExternalLink('https://example.com/x') === true && __openedExternally[0] === 'https://example.com/x')
  const denyCount = __openedExternally.length
  ok('openExternalLink 拒绝非 http', openExternalLink('file:///etc/passwd') === false && __openedExternally.length === denyCount)
  ok('点击拦截器已挂 document', appSrc.indexOf("node.closest('a[href]')") !== -1 && appSrc.indexOf('openExternalLink(href)') !== -1)

  /* ---- 表格渲染 ---- */
  const tableSrc = ['| 请求 | 结果 |', '|---|---|', '| GET / | 200 |', '| GET /src/App.tsx | 200 |'].join('\\n')
  const tableHtml = renderMarkdown(tableSrc)
  ok('表格渲染出 table/thead/th', tableHtml.indexOf('<table>') !== -1 && tableHtml.indexOf('<thead>') !== -1 && tableHtml.indexOf('<th>请求</th>') !== -1, tableHtml.slice(0, 120))
  ok('表格正文渲染 td 单元格', tableHtml.indexOf('<td>GET /</td>') !== -1 && tableHtml.indexOf('<td>200</td>') !== -1)
  ok('分隔行不残留在输出里', tableHtml.indexOf('---') === -1)
  const tablePlusSrc = ['前置说明', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '表格后的正文'].join('\\n')
  const tablePlusText = renderMarkdown(tablePlusSrc)
  ok('表格与前后正文互不吞并', tablePlusText.indexOf('前置说明') !== -1 && tablePlusText.indexOf('表格后的正文') !== -1 && tablePlusText.indexOf('</table>') !== -1)
  ok('链接悬停下划线样式已落 CSS', cssSrc.indexOf('.bubble-body a:hover') !== -1 && cssSrc.indexOf('text-decoration: underline') !== -1)
  ok('表格样式已落 CSS', cssSrc.indexOf('.bubble-body table') !== -1 && cssSrc.indexOf('.bubble-body th') !== -1)

  /* ---- 侧边栏折叠 ---- */
  ok('折叠按钮已入 HTML', htmlSrc.indexOf('id="toggleProjects"') !== -1 && htmlSrc.indexOf('id="toggleRecent"') !== -1
    && htmlSrc.indexOf('id="sectionProjects"') !== -1 && htmlSrc.indexOf('id="sectionRecent"') !== -1
    && htmlSrc.indexOf('id="headProjects"') !== -1 && htmlSrc.indexOf('id="headRecent"') !== -1)
  ok('折叠样式已落 CSS', cssSrc.indexOf('.sidebar-section.collapsed .flat-list') !== -1 && cssSrc.indexOf('.section-toggle') !== -1)
  ok('标题区可点且无箭头 hover 背景', cssSrc.indexOf('.section-head') !== -1 && cssSrc.indexOf('cursor: pointer') !== -1
    && cssSrc.indexOf('.section-toggle:hover') === -1)
  const projSection = document.getElementById('sectionProjects')
  ok('初始为展开', state.sectionCollapsed.projects === false && projSection.classList.contains('collapsed') === false)
  toggleSectionCollapse('projects')
  ok('点击折叠生效并落 class', state.sectionCollapsed.projects === true && projSection.classList.contains('collapsed') === true)
  toggleSectionCollapse('projects')
  ok('再点恢复展开', state.sectionCollapsed.projects === false && projSection.classList.contains('collapsed') === false)

  /* ---- 会话自动命名 ---- */
  ok('短消息原样作为标题', summarizeTitle('修复侧边栏折叠') === '修复侧边栏折叠')
  const longTitle = summarizeTitle('帮我写一个特别长的需求说明文档用来验证标题会不会被正确截断加上省略号')
  ok('长消息截断到14字加省略号', longTitle.length === 15 && longTitle.charAt(14) === '\u2026', longTitle)
  ok('换行与连续空白折叠', summarizeTitle('第一行\\n\\n第二行   很多空格') === '第一行 第二行 很多空格')
  ok('空内容不给标题', summarizeTitle('') === '' && summarizeTitle('   \\n  ') === '')
  const titleSession = { title: DEFAULT_SESSION_TITLE, messages: [] }
  maybeAutoTitle(titleSession, '总结一下 vite 配置')
  ok('默认标题被替换为摘要', titleSession.title === '总结一下 vite 配置')
  const namedSession = { title: '我自己起的名', messages: [] }
  maybeAutoTitle(namedSession, '新消息内容')
  ok('手动标题不被覆盖', namedSession.title === '我自己起的名')
  const emptySession = { title: DEFAULT_SESSION_TITLE, messages: [] }
  maybeAutoTitle(emptySession, '')
  ok('空消息不改标题', emptySession.title === DEFAULT_SESSION_TITLE)

  /* ---- 插件卡片与热插拔 ---- */
  ok('插件卡片样式已落 CSS', cssSrc.indexOf('.plugin-card') !== -1 && cssSrc.indexOf('.plugin-switch') !== -1)
  state.plugins = ['builtin/fs-tools', 'builtin/search-tools', 'builtin/shell-tools']
  state.tools = [
    { name: 'list_dir', plugin: 'builtin/fs-tools', description: 'x' },
    { name: 'read_file', plugin: 'builtin/fs-tools', description: '' },
    { name: 'write_file', plugin: 'builtin/fs-tools', description: '' },
    { name: 'edit_file', plugin: 'builtin/fs-tools', description: '' },
    { name: 'search_files', plugin: 'builtin/search-tools', description: '' },
    { name: 'run_command', plugin: 'builtin/shell-tools', description: '' }
  ]
  state.settings.disabledPlugins = []
  renderPlugins(state.plugins, state.tools)
  const pluginCards = document.getElementById('pluginList').children
  ok('三个插件渲染成三张卡片', pluginCards.length === 3, String(pluginCards.length))
  ok('卡片含标题/说明/工具 chips', pluginCards[0].children[0].children[1].textContent.indexOf('\u6587\u4ef6') !== -1
    && pluginCards[0].children[1].textContent.indexOf('list_dir') !== -1
    && pluginCards[0].children[2].children.length === 4)
  ok('开关初始为开', pluginCards[0].children[0].children[4].className.indexOf(' on') !== -1)
  state.settings.disabledPlugins = ['builtin/shell-tools']
  renderPlugins(state.plugins, state.tools)
  const offCards = document.getElementById('pluginList').children
  ok('禁用插件卡片带 off 态且开关为关', offCards[2].className.indexOf('plugin-off') !== -1
    && offCards[2].children[0].children[4].className.indexOf(' on') === -1)
  ok('禁用清单读写一致', isPluginEnabled('builtin/shell-tools') === false && isPluginEnabled('builtin/fs-tools') === true)
  await togglePlugin('builtin/fs-tools')
  ok('togglePlugin 走 saveSettings 持久化', settingsState.disabledPlugins.indexOf('builtin/fs-tools') !== -1
    && isPluginEnabled('builtin/fs-tools') === false)
  ok('开关后卡片列表不消失（回归）', document.getElementById('pluginList').children.length === 3)
  await togglePlugin('builtin/fs-tools')
  ok('再次点击恢复启用', isPluginEnabled('builtin/fs-tools') === true)
  ok('恢复后卡片仍在且开关为开', document.getElementById('pluginList').children.length === 3
    && document.getElementById('pluginList').children[0].children[0].children[4].className.indexOf(' on') !== -1)
  state.settings.disabledPlugins = []
  renderPlugins(state.plugins, state.tools)

  /* ---- 输入框历史翻阅 ---- */
  /* rememberSentMessage 去重并置顶：发送 第一条/第二条/第三条/第二条 后顺序为 [第二条,第三条,第一条] */
  const composerInput = document.getElementById('input')
  rememberSentMessage('第一条')
  rememberSentMessage('第二条')
  rememberSentMessage('第三条')
  rememberSentMessage('第二条')
  navigateSentHistory('up')
  ok('上键取最新一条（去重置顶）', composerInput.childNodes.length === 1 && composerInput.childNodes[0].nodeValue === '第二条')
  navigateSentHistory('up')
  ok('再上取更早一条', composerInput.childNodes.length === 1 && composerInput.childNodes[0].nodeValue === '第三条')
  navigateSentHistory('up')
  ok('继续上翻到最老一条', composerInput.childNodes.length === 1 && composerInput.childNodes[0].nodeValue === '第一条')
  navigateSentHistory('up')
  ok('已到最老不再上翻', composerInput.childNodes[0].nodeValue === '第一条')
  navigateSentHistory('down')
  ok('下键回新一条', composerInput.childNodes[0].nodeValue === '第三条')
  navigateSentHistory('down')
  ok('再下回到最新一条', composerInput.childNodes[0].nodeValue === '第二条')
  navigateSentHistory('down')
  ok('再按下回到空位（输入清空）', composerInput.childNodes.length === 0)
  composerInput.textContent = '我打到一半的草稿'
  navigateSentHistory('up')
  ok('带草稿上翻进入历史', composerInput.childNodes.length === 1 && composerInput.childNodes[0].nodeValue === '第二条')
  navigateSentHistory('down')
  ok('翻回底部恢复草稿', composerInput.childNodes.length === 1 && composerInput.childNodes[0].nodeValue === '我打到一半的草稿')
  navigateSentHistory('down')
  ok('已在底部再按不动', composerInput.childNodes.length === 1 && composerInput.childNodes[0].nodeValue === '我打到一半的草稿')
  rememberSentMessage('')
  ok('空消息不进历史', sentHistory[0] === '第二条')
  ok('历史上限 100 条', (function () { for (let i = 0; i < 130; i++) rememberSentMessage('msg_' + i); return sentHistory.length === 100 && sentHistory[0] === 'msg_129' })())

  /* ---- capability-notice 内置 skill ---- */
  ok('能力弹窗已入 HTML', htmlSrc.indexOf('id="capabilityModal"') !== -1
    && htmlSrc.indexOf('id="capabilitySettings"') !== -1 && htmlSrc.indexOf('id="capabilityOk"') !== -1)
  ok('弹窗样式已落 CSS', cssSrc.indexOf('.capability-modal-card') !== -1)
  showCapabilityModal('测试提示')
  ok('showCapabilityModal 打开弹窗', document.getElementById('capabilityModal').classList.contains('hidden') === false
    && document.getElementById('capabilityText').textContent === '测试提示')
  hideCapabilityModal()
  ok('hideCapabilityModal 收口', document.getElementById('capabilityModal').classList.contains('hidden') === true)
  await handleEvent({ type: 'capability:missing', plugin: 'builtin/fs-tools', text: '插件「builtin/fs-tools」已停用' })
  ok('capability:missing 事件弹窗', document.getElementById('capabilityModal').classList.contains('hidden') === false)
  hideCapabilityModal()
  ok('skill 抢救逻辑已入 agent', agentSrc.indexOf('this.skills.transformContent') !== -1
    && agentSrc.indexOf('capability:missing') !== -1)

  /* ---- 能力缺失提示（notice） ---- */
  const noticeText = '\u63d2\u4ef6\u300cbuiltin/fs-tools\u300d\u5df2\u505c\u7528\uff0c\u5de5\u5177 read_file \u65e0\u6cd5\u6267\u884c'
  await handleEvent({ type: 'notice', text: noticeText })
  const msgChildren = document.getElementById('messagesInner').children
  const noticeWrapper = msgChildren[msgChildren.length - 1]
  ok('notice 事件渲染提示气泡', noticeWrapper && noticeWrapper.className.indexOf('bubble notice') !== -1)
  ok('notice 内容与标签正确', noticeWrapper.children[0].textContent === '\u63d0\u793a'
    && noticeWrapper.children[1].textContent.indexOf('read_file') !== -1)
  ok('notice 样式已落 CSS', cssSrc.indexOf('.bubble.notice') !== -1)
  ok('系统提示词含禁用插件约束', agentSrc.indexOf('Disabled plugins:') !== -1
    && agentSrc.indexOf('Never work around them with other tools') !== -1)

  /* ---- 回复语言设置 ---- */
  ok('回复语言自定义下拉已入 HTML', htmlSrc.indexOf('data-reply-dropdown') !== -1
    && htmlSrc.indexOf('data-reply-option="zh"') !== -1 && htmlSrc.indexOf('data-reply-option="en"') !== -1
    && htmlSrc.indexOf('data-reply-label') !== -1)
  ok('下拉复用权限菜单样式体系', htmlSrc.indexOf('pill-button dropdown-trigger') !== -1
    && htmlSrc.indexOf('dropdown-item" data-reply-option') !== -1)
  setReplyLanguageUI('en')
  ok('setReplyLanguageUI 空环境安全', readReplyLanguage() === 'zh')
  ok('下拉已绑定且入 init', appSrc.indexOf('setupReplyLanguageDropdown()') !== -1
    && appSrc.indexOf('function setupReplyLanguageDropdown') !== -1)
  ok('系统提示词带回复语言约束（含标题/列表/禁止中途换语言的硬化措辞）', agentSrc.indexOf('replyLanguage') !== -1
    && agentSrc.indexOf('ALL user-facing replies MUST be written in') !== -1
    && agentSrc.indexOf('Never switch to another language in the middle') !== -1)

  /* ---- 消息操作行 ----
     两个回归点：
     1) 角色判断曾经是 role !== 'user' 兜底，工具调用 / 工具结果 / 错误 / 提示
        气泡也各挂了一份"复制 + 删除"，看上去就是"每条消息下面都显示按钮"；
     2) 用户消息曾经提前 return，跳过「清除旧常显标记」，导致上一条回复的按钮不掉。 */
  const msgBox = document.getElementById('messagesInner')
  const collectActionRows = (el, out) => {
    for (const child of (el.children || [])) {
      if (String(child.className || '').split(/\\s+/).indexOf('bubble-actions') !== -1) out.push(child)
      collectActionRows(child, out)
    }
    return out
  }
  const resetMessages = () => { msgBox.children = []; msgBox.childNodes = [] }

  resetMessages()
  addBubble('user', '第一条提问')
  addBubble('assistant', '第一条回复')
  addBubble('user', '第二条提问')
  addBubble('assistant', '第二条回复')
  const actionRows = collectActionRows(msgBox, [])
  const visibleRows = actionRows.filter((item) => item.classList.contains('actions-visible'))
  ok('四条消息各有一个操作行', actionRows.length === 4, actionRows.length)
  ok('只有最新一条消息的操作行常显', visibleRows.length === 1
    && visibleRows[0] === actionRows[actionRows.length - 1], 'visible=' + visibleRows.length)
  ok('用户消息操作行在气泡外的分组里', msgBox.children[2]
    && msgBox.children[2].className === 'bubble-group'
    && msgBox.children[2].children.length === 2,
    msgBox.children[2] ? msgBox.children[2].className : 'missing')
  ok('助手消息操作行仍在气泡内', msgBox.children[3]
    && msgBox.children[3].className.indexOf('bubble assistant') !== -1
    && msgBox.children[3].querySelector('.bubble-actions') !== null)

  resetMessages()
  addBubble('tool', '正在运行 run_command')
  addBubble('tool-result', 'run_command ok')
  addBubble('notice', '插件已停用')
  addBubble('error', '出错了')
  addBubble('assistant', '这是最终回复')
  const noiseRows = collectActionRows(msgBox, [])
  ok('工具/工具结果/提示/错误气泡不带操作按钮', noiseRows.length === 1, noiseRows.length)
  ok('常显的那一行属于助手回复', noiseRows.length === 1
    && noiseRows[0] === msgBox.children[4].querySelector('.bubble-actions'))

  resetMessages()
  addBubble('assistant', '前一条回复')
  addBubble('user', '最后一条是用户消息')
  const rowsAfterUser = collectActionRows(msgBox, [])
  const visibleAfterUser = rowsAfterUser.filter((item) => item.classList.contains('actions-visible'))
  ok('最后一条是用户消息时也承接常显', visibleAfterUser.length === 1
    && visibleAfterUser[0] === rowsAfterUser[rowsAfterUser.length - 1],
    'visible=' + visibleAfterUser.length)

  /* ============================ 右侧文件面板（一期） ============================
     ⚠️ 静态断言（正则 / 字符串）**在宿主脚本里算好传进来**，这里只读结果。
     原因：这一段本身是个模板字符串，正则里的反斜杠转义会被模板字符串先吃掉一层，
     最后静默失配 —— 最难查的那种 bug。 */

  ok('面板入口已挂到 window.filePanel', typeof window.filePanel === 'object'
    && typeof window.filePanel.toggle === 'function'
    && typeof window.filePanel.openFile === 'function')

  ok('脚本顺序：markdown → highlight → icons → app → panel', panelStatic.scriptOrder)

  ok('面板骨架已入 HTML', panelStatic.htmlTokens,
    panelStatic.missingHtmlTokens.join(','))

  /* —— CSS 布局不变式 —— */
  ok('面板列宽写的是 --panel-width（不是写死 px）', panelStatic.panelOpenColumns)
  ok('会话区固定在第 2 列', panelStatic.mainColumn)
  ok('侧边栏折叠 + 面板展开时 .main 只跨前两列（不然会被面板压住）',
    panelStatic.collapsedPanelMain)
  ok('面板收起时整块 display:none', panelStatic.panelHidden)
  ok('「只看文件」模式把前两列压成 0', panelStatic.chatHiddenColumns)
  ok('侧栏/面板开关、页面操作和标题都在 #app 外的独立 header 中', panelStatic.titlebarContainsControls)
  ok('48px 顶栏与剩余内容高度分离，开关按钮跟随顶栏布局', panelStatic.contentBelowTitlebar)
  ok('拖拽把手不是 display:none（否则拖不动）', panelStatic.resizeUsable)
  ok('#app 的网格行钉死在视口高（minmax(0,1fr)，不然面板把行撑爆、滚动条不出现）',
    panelStatic.gridRowPinned)
  ok('面板栏的 flex 中间层都有 min-height:0（滚动链不能断）',
    panelStatic.explorerMinHeight && panelStatic.mainMinHeight,
    'explorer=' + panelStatic.explorerMinHeight + ' main=' + panelStatic.mainMinHeight)
  ok('面板滚动条与侧边栏同一套配色/尺寸', panelStatic.scrollbarsMatchSidebar)
  ok('文件列表宽度写的是 --explorer-width（不是写死 px）', panelStatic.explorerWidthVar)
  ok('文件列表右缘有可拖的把手（不是 display:none）', panelStatic.explorerResizeUsable)
  ok('文件列表收起时把手跟着消失', panelStatic.explorerResizeHiddenWithExplorer)
  ok('所有 #app.panel-open 三列规则都用 --panel-width 写第三列（响应式也不许写死）',
    panelStatic.panelColumnBad.length === 0, panelStatic.panelColumnBad.join(' | '))
  ok('两条把手的高亮各用各的 body 类（不会一起亮）', panelStatic.resizeHighlightsSplit)
  ok('拖动时 iframe 不再吃鼠标事件（否则划过 PDF 把手就「卡住」）',
    panelStatic.iframeDisabledWhileResizing)

  /* —— 高亮 token 配色齐不齐 —— */
  ok('每个高亮 token 都有配色（' + panelStatic.hlTotal + ' 种）',
    panelStatic.hlTotal > 15 && panelStatic.hlMissing.length === 0,
    panelStatic.hlMissing.join(','))

  /* —— 只读约束：面板不碰写操作 / 命令 / 外网 / node 模块 —— */
  ok('面板唯一的写口子是 fsWrite（没有建目录 / 执行命令的越权路径）', panelStatic.readOnly)
  ok('面板不引用任何外网地址', panelStatic.noExternal)
  ok('面板不 require electron / node 内置模块', panelStatic.noNodeRequire)

  /* —— 纯函数行为 —— */
  const fp = window.filePanel

  const utf8Decoded = fp.decodeBytes(new TextEncoder().encode('中文 abc'))
  ok('decodeBytes 认得 UTF-8', utf8Decoded.text === '中文 abc', utf8Decoded.encoding)

  /* 「你好，世界」的 GBK 字节。宿主 Node 16/22 都带完整 ICU，能解，
     所以这条是实打实的断言，不是「能过就行」。 */
  const gbkDecoded = fp.decodeBytes(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]))
  ok('decodeBytes 解得了 GBK（Win7 上的常见编码）', gbkDecoded.text === '你好，世界', gbkDecoded.encoding)

  const bomDecoded = fp.decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))
  ok('decodeBytes 会剥 UTF-8 BOM', bomDecoded.text === 'a', bomDecoded.encoding)

  /* —— 编辑器：文本 → 字节必须「原编码进、原编码出」——
     这一组的价值在于**往返**：只断言「编出来是几个字节」是假绿，
     磁盘上留下的东西能不能被原来的读法读回同一串字符才是真的。 */
  const encRound = (text, encoding) => {
    const bytes = fp.encodeText(text, encoding)
    return { bytes: bytes, back: fp.decodeBytes(bytes) }
  }
  const utf8Round = encRound('中文 abc', 'utf-8')
  ok('UTF-8 往返一致（无 BOM）',
    utf8Round.back.text === '中文 abc' && utf8Round.back.encoding === 'utf-8'
      && utf8Round.bytes[0] !== 0xef,
    utf8Round.back.encoding + ' ' + utf8Round.bytes.length + 'B')

  const bomRound = encRound('a中', 'utf-8-bom')
  ok('UTF-8 BOM 文件写回时 BOM 还在（不然有些 Windows 工具会认错编码）',
    bomRound.bytes[0] === 0xef && bomRound.bytes[1] === 0xbb && bomRound.bytes[2] === 0xbf
      && bomRound.back.encoding === 'utf-8-bom' && bomRound.back.text === 'a中',
    bomRound.back.encoding)

  /* 这一条是整个功能的命门：GBK 文件保存后必须还是 GBK 字节。
     先解一段真 GBK（decodeBytes 认出来的），再编回去，逐字节比对。 */
  const gbkSource = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7])
  const gbkText = fp.decodeBytes(gbkSource)
  const gbkBack = fp.encodeText(gbkText.text + ' ABCD', 'gbk')
  const gbkHeadSame = gbkBack.length >= gbkSource.length
    && gbkSource.every((byte, index) => gbkBack[index] === byte)
  ok('GBK 文件保存后还是 GBK（原有字节原样保留，不是悄悄转成 UTF-8）',
    gbkText.encoding === 'gbk' && gbkHeadSame
      && fp.decodeBytes(gbkBack).text === gbkText.text + ' ABCD'
      && fp.decodeBytes(gbkBack).encoding === 'gbk',
    Array.from(gbkBack).join(','))

  ok('GBK 存不下的字符（emoji）宁可报错也不写问号吃掉内容',
    (() => {
      try { fp.encodeText('😀', 'gbk'); return false } catch (error) {
        return String(error.message).indexOf('GBK_UNENCODABLE') === 0
      }
    })(), 'GBK_UNENCODABLE')

  const u16Round = encRound('中文a', 'utf-16le')
  ok('UTF-16LE 往返一致且补回 BOM',
    u16Round.bytes[0] === 0xff && u16Round.bytes[1] === 0xfe
      && u16Round.back.text === '中文a' && u16Round.back.encoding === 'utf-16le',
    u16Round.back.encoding)
  const u16beRound = encRound('中文a', 'utf-16be')
  ok('UTF-16BE 往返一致且补回 BOM',
    u16beRound.bytes[0] === 0xfe && u16beRound.bytes[1] === 0xff
      && u16beRound.back.text === '中文a' && u16beRound.back.encoding === 'utf-16be',
    u16beRound.back.encoding)

  /* —— 换行：textarea 的 value 一定是 LF，所以保存时必须自己还原 ——
     （下面这些 \r \n 全是**两层**模板，写单层会被外层吃掉，务必写成 \\r \\n） */
  ok('detectEol 认得出 CRLF / LF',
    fp.detectEol('a\\r\\nb') === '\\r\\n' && fp.detectEol('a\\nb') === '\\n',
    JSON.stringify([fp.detectEol('a\\r\\nb'), fp.detectEol('a\\nb')]))
  ok('CRLF 文件保存后仍是 CRLF（否则 git diff 会变成「每一行都改了」）',
    fp.applyEol('a\\nb\\n', '\\r\\n') === 'a\\r\\nb\\r\\n',
    JSON.stringify(fp.applyEol('a\\nb\\n', '\\r\\n')))
  ok('LF 文件不会被强加回车',
    fp.applyEol('a\\nb\\n', '\\n') === 'a\\nb\\n', JSON.stringify(fp.applyEol('a\\nb\\n', '\\n')))
  ok('已有 CRLF 的文本再按 CRLF 编不会变成 \\r\\r\\n（重复归一才是对的）',
    fp.applyEol('a\\r\\nb', '\\r\\n').indexOf('\\r\\r') === -1,
    JSON.stringify(fp.applyEol('a\\r\\nb', '\\r\\n')))

  /* —— base64：写入通道的载体（HTTP 与 IPC 都走它）—— */
  const b64Bytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])
  const b64 = fp.bytesToBase64(b64Bytes)
  const b64Back = new Uint8Array(atob(b64).split('').map((char) => char.charCodeAt(0)))
  ok('bytesToBase64 出的串能原样解回字节（含非 ASCII 高位字节）',
    b64Back.length === b64Bytes.length && b64Back.every((byte, index) => byte === b64Bytes[index]),
    b64)

  /* —— 能不能编辑：文本、且没大到离谱 —— */
  ok('大文件（>5MB）不给编辑', fp.canEdit({ isText: true, size: 6 * 1024 * 1024 }) === false)
  ok('二进制不给编辑', fp.canEdit({ isText: false, size: 100 }) === false)
  ok('普通文本可以编辑', fp.canEdit({ isText: true, size: 2048 }) === true)

  ok('defaultWidth 按窗口算（38%，夹在 460..720）',
    fp.defaultWidth(1000) === 460 && fp.defaultWidth(1440) === 547 && fp.defaultWidth(2400) === 720,
    [fp.defaultWidth(1000), fp.defaultWidth(1440), fp.defaultWidth(2400)].join(','))

  ok('clampWidth 的上限只由边界决定（视口 − 会话区左沿 − 320），不再写死 760',
    fp.clampWidth(9999, 1440, 260) === 860 && fp.clampWidth(9999, 1440, 0) === 1120,
    fp.clampWidth(9999, 1440, 260) + '/' + fp.clampWidth(9999, 1440, 0))
  ok('clampWidth 下限 240，会话区再窄也不被挤没',
    fp.clampWidth(10, 1440, 260) === 240 && fp.clampWidth(9999, 1440, 1200) === 240,
    fp.clampWidth(10, 1440, 260) + '/' + fp.clampWidth(9999, 1440, 1200))
  ok('clampExplorer 夹在 [120, 面板宽 − 160]（文件列表拖不穿预览区）',
    fp.clampExplorer(9999, 520) === 360 && fp.clampExplorer(10, 520) === 120,
    fp.clampExplorer(9999, 520) + '/' + fp.clampExplorer(10, 520))

  /* 输入框高度 + 拖拽节流（2026-09-19 用户截图骂的两条，宿主侧算好传进 panelStatic） */
  ok('autoResizeComposer 上限钉死 180px（innerHeight 比例会让输入框长到半屏）',
    panelStatic.composerMaxHeightFixed, 'maxHeight=180')
  ok('.composer-input 不再用 40vh 当上限（两套 max-height 打架时后者赢，输入框变高）',
    panelStatic.composerNoVhCap, 'style.css 无 40vh')
  ok('bindColResize 拖动走 rAF 节流（mousemove 只记事件，帧里才 apply，松手 flush）',
    panelStatic.resizeRafThrottled, 'rAF 节流')
  ok('applyExplorer 值未变就跳过（applyWidth 连带调用不再白发样式失效）',
    panelStatic.explorerApplySkipsUnchanged, 'early-return')
  ok('标签关闭按钮平时藏、悬停标签才露（0.65 常显太小太灰）',
    panelStatic.tabCloseHoverOnly, 'hover-only')
  ok('标签关闭 × 加大到 13px/18px（11px 谁都瞧不见）',
    panelStatic.tabCloseBigger, '18px/13px')
  ok('标签区滚轮横向滚动（标签页太多要能滚）',
    panelStatic.tabsWheelScroll, 'wheel → scrollLeft')
  /* 定时任务编辑器（2026-10-17 重做，用户嫌原版太复杂）：
     常态只暴露「名称 / 做什么 / 什么时候 / 启用」，其余全部收进高级设置。 */
  ok('定时任务编辑器：重复方式改成分段按钮，不再是下拉',
    htmlSrc.indexOf('task-segment') !== -1 && htmlSrc.indexOf('data-task-kind="daily"') !== -1
      && htmlSrc.indexOf('data-task-kind="weekly"') !== -1 && htmlSrc.indexOf('data-task-kind="interval"') !== -1
      && htmlSrc.indexOf('type="hidden" id="taskRule"') !== -1)
  ok('定时任务编辑器：间隔带单位（分钟/小时/天），提交时换算成分钟',
    htmlSrc.indexOf('id="taskIntervalUnit"') !== -1
      && tasksSrc.indexOf('taskIntervalUnit') !== -1)
  ok('定时任务编辑器：下次执行用「今天/明天/周几」的人话，不是整串时间戳',
    tasksSrc.indexOf('function whenText(') !== -1 && tasksSrc.indexOf('今天') !== -1)
  ok('定时任务编辑器：高级配置已内收，不再显示（项目/权限/时区/工具白名单/限额）',
    htmlSrc.indexOf('id="taskProject"') === -1 && htmlSrc.indexOf('id="taskPermission"') === -1
      && htmlSrc.indexOf('id="taskTools"') === -1 && htmlSrc.indexOf('task-advanced') === -1
      && htmlSrc.indexOf('id="taskTimezone"') === -1)
  ok('定时任务编辑器：没有原生 select 了（星期用统一下拉、间隔单位用分段按钮）',
    htmlSrc.indexOf('<select id="taskWeekday"') === -1
      && htmlSrc.indexOf('<select id="taskIntervalUnit"') === -1
      && htmlSrc.indexOf('data-weekday-dropdown') !== -1
      && htmlSrc.indexOf('data-task-unit="1"') !== -1)
  ok('定时任务编辑器：权限与工具用内置默认值，不再由用户勾',
    tasksSrc.indexOf('BUILTIN') !== -1 && tasksSrc.indexOf("permission:'readonly'") !== -1
      && tasksSrc.indexOf('BUILTIN.tools.slice()') !== -1)
  ok('运行记录是紧凑列表行，整行可点（不再是大卡片）',
    tasksSrc.indexOf('task-run-row') !== -1 && tasksSrc.indexOf("setAttribute('role','button')") !== -1
      && tasksSrc.indexOf('openRunConversation') !== -1)
  ok('执行环境与后台运行挪进系统设置，且排在模型模块下面',
    htmlSrc.indexOf('data-settings-panel="environment"') !== -1
      && htmlSrc.indexOf('data-settings-tab="environment"') !== -1
      && /data-settings-panel="model"[^]{0,6000}data-settings-panel="environment"/.test(htmlSrc)
      && htmlSrc.indexOf('id="taskServiceSettings"') !== -1)
  /* 五点反馈（2026-10-17 19:45）：能力中心改名与排版 / 两处滚动 / 气泡不溢出 / 空状态按项目给建议 */
  ok('设置里的模块改叫「能力中心」', htmlSrc.indexOf('data-settings-tab="environment"') !== -1
    && htmlSrc.indexOf('\u6267\u884c\u73af\u5883') === -1)
  ok('能力中心的每个标签页自己滚动（内容长时不撑破窗口）',
    cssSrc.indexOf('.capability-center { display:flex') !== -1
      && cssSrc.indexOf('#capabilityCenter > #capTasks') !== -1
      && cssSrc.indexOf('overflow-y: auto') !== -1)
  ok('空状态的建议按当前工作区内容生成，不再写死三条',
    enhancementsSrc.indexOf('function suggestions(') !== -1
      && enhancementsSrc.indexOf('FALLBACK_SUGGESTIONS') !== -1
      && enhancementsSrc.indexOf('fsTree') !== -1)
  const taskDialogRules = cssSrc.split('}').filter(rule => ['.task-dialog', '.task-editor', '.task-segment', '#taskDialog'].some(selector => rule.split('{')[0].includes(selector))).join('}')
  ok('定时任务对话框不再用蓝色高亮（项目主题要求中性灰）',
    taskDialogRules.indexOf('#4e78bc') === -1 && taskDialogRules.indexOf('rgba(91,139,255') === -1)
  ok('侧栏不再有品牌行（logo / 名称 / 系统徽章，用户 2026-10-17 要求）',
    htmlSrc.indexOf('titlebar-brand') === -1 && htmlSrc.indexOf('brandBadge') === -1
      && htmlSrc.indexOf('brandIcon') === -1,
    'brand row removed')
  ok('终端已接通：panel.js 挂了 setupTerminal + term API（订阅/启动/解码）',
    panelStatic.terminalApiWired, 'setupTerminal + termSubscribe')
  ok('终端停靠预览区下方：--terminal-height 变量 + 独立分隔条，旧「藏预览」CSS 已删',
    panelStatic.terminalDocked, 'var(--terminal-height) + .terminal-resize')
  ok('xterm 已接：new window.Terminal + FitAddon + 本地行编辑 + 分隔条拖拽',
    panelStatic.terminalXtermWired, 'xterm + handleTerminalData')
  ok('旧终端输入行删干净（输入/回显归 xterm）',
    panelStatic.terminalInputGone, 'no terminalInput')
  ok('终端目录切换用编号列表（弃下拉框，⌥+数字热键拦截）',
    panelStatic.terminalDirsList, '#terminalDirs + terminalDirHotkey')
  /* —— 编辑器（四期：编辑 + 实时保存）—— */
  ok('编辑器已接：编辑/完成切换 + 防抖自动保存 + 立即落盘 + 强制保存',
    panelStatic.editorWired, 'startEdit + scheduleSave + flushSave')
  ok('保存按原编码编回去（UTF-8/BOM/UTF-16/GBK 都有编码器，GBK 反查表懒建）',
    panelStatic.editorKeepsEncoding, 'encodeText + gbkReverse')
  ok('保存按原换行编回去（textarea 会把 CRLF 吃成 LF）',
    panelStatic.editorKeepsEol, 'detectEol + applyEol')
  ok('切标签/关标签/关面板/刷新/失焦/关窗都会把没落盘的写掉',
    panelStatic.editorAutosave, 'flush 全覆盖')
  ok('文件被外部改过时不静默覆盖（mtime 冲突 → 要人点强制保存）',
    panelStatic.editorConflictGuard, 'MTIME_CONFLICT + force→0')
  ok('编辑器样式齐（工具条 / textarea / 状态 / 预览区切纵向布局 / 标签脏点）',
    panelStatic.editorCss, '.preview-editor + .panel-preview.is-editing')
  ok('编辑器真的撑满预览区（textarea 没被远古全局 max-height 压成一条）',
    panelStatic.editorFillsHeight, '.preview-editor{max-height:none} + 裸 textarea 无上限')
  ok('输入框空内容时清内联高度（防重启后输入框又变高）',
    panelStatic.composerEmptyReset, 'empty → height reset')
  ok('applyPlatformBadge 已接：userAgent 认系统（NT 6.1 → Win7），init 里调用',
    appSrc.indexOf('function applyPlatformBadge') !== -1
      && appSrc.indexOf('Windows NT ') !== -1
      && appSrc.indexOf('applyPlatformBadge()') !== -1,
    'badge')
  ok('输入框挂了 MutationObserver 自愈（只改 DOM 不发 input 事件的路径也要重算高度）',
    appSrc.indexOf('new MutationObserver(autoResizeComposer)') !== -1,
    'observer')

  ok('fmtSize 可读', fp.fmtSize(0) === '0 B' && fp.fmtSize(2048) === '2.0 KB'
    && fp.fmtSize(3 * 1024 * 1024) === '3.0 MB',
    [fp.fmtSize(0), fp.fmtSize(2048), fp.fmtSize(3 * 1024 * 1024)].join(' / '))

  const pathContextBackup = fp._state.context
  fp._state.context = null
  const pathResults = pathCases.map((item) => {
    fp._state.roots = item.roots
    return { label: item.label, got: fp.absoluteFor(item.input), want: item.expect }
  })
  fp._state.context = pathContextBackup
  const badPath = pathResults.filter((item) => item.got !== item.want)
  ok('工具给的文件路径都能还原成绝对路径（含 Windows 反斜杠）',
    badPath.length === 0, badPath.map((item) => item.label + ':' + item.got + '≠' + item.want).join(' | '))

  ok('baseOf 认得两种分隔符', fp.baseOf(baseCases.posix) === baseCases.posixWant
    && fp.baseOf(baseCases.win) === baseCases.winWant,
    fp.baseOf(baseCases.win))

  /* ================= 2026-09-19 用户报的两条聊天收发 bug =================
     ① 切换会话后「发送中」状态还是上一个会话的 → 之后就发不出去
     ② 只发图片不写字会报错                                                      */

  ok('运行标志有常驻对表（事件流断线/错过 finished 也能自愈：对表 + 冲队列）',
    sendStatic.runPoll && sendStatic.runPollFlushesQueue && sendStatic.runPollUnref, 'startRunPoll')
  ok('syncRunningState 回传宿主真实状态（调用方靠它判断能不能直接发）',
    sendStatic.syncReturnsLive, 'returns running')
  ok('切换会话时跟宿主对表，并丢掉上一个会话的思考块引用',
    sendStatic.switchResyncsRun && sendStatic.switchDropsStaleThinking, 'selectSession')
  ok('发送前先对表：脏 running 不会把消息塞进队列', sendStatic.sendResyncsBeforeQueue, 'pre-send sync')
  ok('队列一次冲不完会继续盯（不在数组里睡死）', sendStatic.queueReArms, 're-arm')
  ok('只发图片：渲染层 content 不出现空 text 段', sendStatic.rendererNoEmptyTextPart, 'buildUserContent')
  ok('只发图片：agent 不塞空 text 段（严格的模型服务会判 400）', sendStatic.agentNoEmptyTextPart, 'agent.run')
  ok('只发图片：HTTP /api/chat 不再拿 TEXT_REQUIRED 挡回去', sendStatic.serverAllowsImageOnly, 'server 400')

  /* ================= 2026-09-19 多实例并发（用户：我需要多个 agent 实例） ================= */
  ok('后端换成按会话的 worker 池（一条会话一台，不再共用全局 running）',
    concurrencyStatic.poolIsPerSession, 'agent-pool')
  ok('池子给每条事件 / 每个 worker 盖上 sessionId', concurrencyStatic.poolTagsEvents, 'tag')
  ok('并发上限 + 常驻 worker 上限都在', concurrencyStatic.poolLimits, 'maxConcurrentRuns / LRU')
  ok('设置里有 maxConcurrentRuns', concurrencyStatic.settingsHasLimit, 'settings.js')
  ok('服务端接上池（不再 new Agent）', concurrencyStatic.serverUsesPool, 'server/index.js')
  ok('同会话重入 409 SESSION_BUSY、池满 503 POOL_BUSY',
    concurrencyStatic.serverSessionBusy, 'two codes')
  ok('/api/state 回 runningSessions（渲染层靠它按会话记账）',
    concurrencyStatic.serverStateHasRunningSessions, 'runningSessions')
  ok('审批请求也带 sessionId（两条会话同时要授权时分得清）',
    concurrencyStatic.serverApprovalTagged, 'approval')
  ok('桌面主进程用同一个池', concurrencyStatic.mainUsesPool, 'main.js')
  ok('preload 把 sessionId 带下去（send / stop）', concurrencyStatic.preloadCarriesSessionId, 'preload.js')
  ok('web-bridge 带 sessionId，且只认本会话的 finished', concurrencyStatic.bridgeCarriesSessionId, 'web-bridge.js')
  ok('web-bridge 的 stop / reset 按会话', concurrencyStatic.bridgeStopBySession, 'stop')
  ok('渲染层改成按会话记账（runs 是 map，activeRunSessionId 已删）',
    concurrencyStatic.rendererRunsMap, 'state.runs')
  ok('事件按 sessionId 路由（别的会话的过程事件不画进本画布）',
    concurrencyStatic.rendererRoutesBySession, 'settleRun')
  ok('发送带 sessionId、停止只停本会话',
    concurrencyStatic.rendererSendCarriesSessionId && concurrencyStatic.rendererStopIsPerSession, 'sessionId')
  ok('排队队列也是按会话的（A 的消息不会在 B 里被冲出去）',
    concurrencyStatic.rendererQueueIsPerSession, 'pendingMessages')
  ok('别的会话在跑不再藏发送按钮', concurrencyStatic.rendererSendNotBlocked, 'applyRunState')
  ok('设置页能改并发上限（而且改完自动保存）', concurrencyStatic.settingsUiHasLimit, 'maxConcurrentRuns')

  /* ---- 动态复现（用 shim 里的假宿主跑真的 sendMessage） ---- */
  window.__sendCalls = []
  window.__stopCalls = []
  window.__resetCalls = []
  window.__dshRunning = false
  window.__dshRunningSessions = []
  state.runs = {}
  applyRunState()
  clearWaitingTimer()
  settingsState.models = [{ id: 'model_mock', name: 'mock', baseURL: 'http://127.0.0.1:1/v1', model: 'mock', apiKey: 'x' }]
  settingsState.currentModelId = 'model_mock'
  state.settings = settingsState
  state.workspacePath = '/ws/a'
  state.activeProjectId = 'project_a'
  sessionStore.project_a = [
    { id: 's1', projectId: 'project_a', scope: 'project', title: '会话1', messages: [], updatedAt: '2026-01-01T00:00:00Z' },
    { id: 's2', projectId: 'project_a', scope: 'project', title: '会话2', messages: [], updatedAt: '2026-01-01T00:00:00Z' }
  ]
  state.currentSessionId = 's1'
  renderWorkspaceList()

  /* ① 只贴图不写字 */
  const imgUrl = 'data:image/png;base64,iVBORw0KGgo='
  const imageOnly = buildUserContent('', [imgUrl])
  ok('只发图片时 content 只有图片段',
    Array.isArray(imageOnly) && imageOnly.length === 1 && imageOnly[0].type === 'image_url',
    JSON.stringify(imageOnly))
  const bothContent = buildUserContent('看图', [imgUrl])
  ok('有图有字时第一段是 text',
    bothContent.length === 2 && bothContent[0].type === 'text' && bothContent[0].text === '看图')

  const composerInputEl = document.getElementById('input')
  composerInputEl.innerText = ''
  clearComposerAttachments()
  addComposerAttachment(imgUrl)
  ok('附件区放进了 1 张图', document.getElementById('composerAttachments').querySelectorAll('img').length === 1)
  await sendMessage()
  ok('只发图片能发出去（旧行为：server 400 TEXT_REQUIRED 直接报错）',
    window.__sendCalls.length === 1 && window.__sendCalls[0].text === ''
      && window.__sendCalls[0].images.length === 1,
    JSON.stringify(window.__sendCalls))
  ok('发送把当前会话 id 一起带上（后端才知道往哪台 worker 派）',
    window.__sendCalls[0].sessionId === 's1', String(window.__sendCalls[0].sessionId))
  ok('只发图片发完清空附件区', document.getElementById('composerAttachments').children.length === 0)
  const firstStored = findSessionById('s1').messages[0]
  ok('只发图片的消息进了会话历史且不带空 text 段',
    Boolean(firstStored) && firstStored.role === 'user' && Array.isArray(firstStored.content)
      && firstStored.content.length === 1 && firstStored.content[0].type === 'image_url',
    JSON.stringify(firstStored && firstStored.content))
  state.runs = {}
  applyRunState()
  clearWaitingTimer()

  /* ② 本地账本脏了（遗留 s1 在跑）但宿主说没有 → 必须直接发 */
  window.__sendCalls = []
  state.pendingMessages.length = 0
  state.runs = { s1: true }
  window.__dshRunning = false
  window.__dshRunningSessions = []
  composerInputEl.innerText = '切完会话打的第一句'
  await sendMessage()
  ok('脏「在跑」不会吞掉消息（先对表，宿主说没跑就直接发）',
    window.__sendCalls.length === 1 && state.pendingMessages.length === 0,
    'calls=' + window.__sendCalls.length + ' queue=' + state.pendingMessages.length)
  state.runs = {}
  applyRunState()
  clearWaitingTimer()

  /* ③ 宿主说**本会话**真在跑 → 照旧排队，跑完能冲出去 */
  window.__sendCalls = []
  state.pendingMessages.length = 0
  state.runs = { s1: true }
  window.__dshRunningSessions = ['s1']
  composerInputEl.innerText = '排队的一句'
  await sendMessage()
  ok('本会话在跑：消息进队列而不是被丢掉',
    window.__sendCalls.length === 0 && state.pendingMessages.length === 1,
    'calls=' + window.__sendCalls.length + ' queue=' + state.pendingMessages.length)
  ok('队列项记着自己属于哪条会话', state.pendingMessages[0].sessionId === 's1',
    String(state.pendingMessages[0] && state.pendingMessages[0].sessionId))
  window.__dshRunningSessions = []
  state.runs = {}
  applyRunState()
  flushPendingMessage()
  ok('宿主跑完后队列能冲出去', state.pendingMessages.length === 0 && window.__sendCalls.length === 1,
    'calls=' + window.__sendCalls.length)
  state.runs = {}
  applyRunState()
  clearWaitingTimer()

  /* ④ 并发核心：别的会话在跑，本会话照样直接发（不再排队、不再被 BUSY 顶回来） */
  window.__sendCalls = []
  state.pendingMessages.length = 0
  state.runs = { s2: true }
  window.__dshRunningSessions = ['s2']
  composerInputEl.innerText = '另一条会话在跑时我照发'
  await sendMessage()
  ok('别的会话在跑时本会话直接发（多实例的真正价值）',
    window.__sendCalls.length === 1 && state.pendingMessages.length === 0
      && window.__sendCalls[0].sessionId === 's1',
    'calls=' + window.__sendCalls.length + ' queue=' + state.pendingMessages.length
      + ' sid=' + (window.__sendCalls[0] && window.__sendCalls[0].sessionId))
  state.runs = { s2: true }
  applyRunState()
  clearWaitingTimer()

  /* ⑤ 事件路由：别的会话的 finished 写回它自己，不碰当前会话的运行态 */
  sessionStore.project_a[1].messages = []
  state.runs = { s1: true, s2: true }
  applyRunState()
  await handleEvent({ type: 'finished', sessionId: 's2', messages: [{ role: 'user', content: '远端会话的消息' }], memory: null })
  ok('别的会话的 finished 写回它自己的历史',
    (findSessionById('s2').messages || []).length === 1
      && findSessionById('s2').messages[0].content === '远端会话的消息')
  ok('别的会话收尾后，本会话的「在跑」不受影响',
    state.runs.s1 === true && state.runs.s2 !== true && currentRunning() === true,
    JSON.stringify(state.runs))
  ok('别的会话收尾不会把本会话的停止按钮收走',
    document.getElementById('stop').className.indexOf('hidden') === -1,
    document.getElementById('stop').className)
  await handleEvent({ type: 'finished', sessionId: 's1', messages: [], memory: null })
  ok('本会话收尾后运行账本清空', currentRunning() === false, JSON.stringify(state.runs))

  /* ⑥ 切换会话时对表并把脏「在跑」纠正回来 */
  state.runs = { s1: true }
  window.__dshRunningSessions = []
  await selectSession('s1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok('切换会话把脏「在跑」纠正回来（发送按钮回来、停止按钮收走）',
    currentRunning() === false && document.getElementById('send').className.indexOf('hidden') === -1
      && document.getElementById('stop').className.indexOf('hidden') !== -1,
    'runs=' + JSON.stringify(state.runs) + ' send=[' + document.getElementById('send').className + ']')
  state.runs = {}
  applyRunState()

  /* ⑦ 老宿主（只报全局 running、没有 runningSessions）退化成「当前会话在跑」 */
  state.runs = {}
  window.__dshRunningSessions = null
  window.__dshRunning = true
  await syncRunningState()
  ok('老宿主只报 running 时退化成「当前会话在跑」（向后兼容）',
    currentRunning() === true && state.runs.s1 === true, JSON.stringify(state.runs))
  window.__dshRunning = false
  window.__dshRunningSessions = []
  state.runs = {}
  applyRunState()

  if (state.queueTimer) { clearTimeout(state.queueTimer); state.queueTimer = null }
  clearWaitingTimer()
  state.pendingMessages.length = 0

  /* ================= 2026-09-19 顶栏页面操作（刷新 / 转发）+ 并发提示 ================= */

  ok('刷新与转发放在独立顶栏中，折叠侧栏仍可使用', pageStatic.htmlWired, '#pageActions')
  ok('刷新 / 转发图标都在 icons.js 里', pageStatic.iconsExist, 'refresh + external')
  ok('两个按钮都接上了点击处理', pageStatic.clickWired, 'reloadPage / sharePageLink')
  ok('刷新走整页 reload（整页本来就是一个网页）', pageStatic.reloadIsFullPage, 'location.reload')
  ok('链接取 location.origin（http/https 才有；file:// 报空串）', pageStatic.linkIsOrigin, 'appLink')
  ok('转发 = 复制链接 + 甩给系统默认浏览器', pageStatic.shareCopiesAndOpens, 'clipboard + openExternal')
  ok('页面操作按顶栏 flex 排列，点击区域退出窗口拖拽', pageStatic.controlsInHeaderFlow)
  ok('只看文件时保留顶栏操作与返回聊天入口', pageStatic.fileModeHasTopbarActions)
  ok('「并发已满」提示条（HTML/CSS/逻辑齐，只在池满时露）',
    pageStatic.hintHtml && pageStatic.hintCss && pageStatic.hintLogic, '#composerRunHint')
  ok('会话存储已双写服务端（服务端优先 + 空 store 迁移 + local 立即兜底 + in-flight 合并 PUT）',
    pageStatic.uiStoreWired, 'loadSessionStore + scheduleUiStorePush')
  ok('ui-store 桥接齐（preload IPC + web-bridge HTTP 各一条，签名一致）',
    pageStatic.uiStoreBridge, 'uiStoreGet/uiStorePut')

  /* 动态：链接 + 刷新 + 转发 */
  ok('appLink 取到当前软件链接', appLink() === 'http://127.0.0.1:8080/', appLink())
  window.__reloads = 0
  reloadPage()
  ok('刷新按钮真的触发整页 reload', window.__reloads === 1, String(window.__reloads))
  window.__openedExternally.length = 0
  window.__clipboard.length = 0
  await sharePageLink()
  ok('转发按钮复制链接并用默认浏览器打开',
    window.__clipboard[0] === 'http://127.0.0.1:8080/'
      && window.__openedExternally[0] === 'http://127.0.0.1:8080/',
    JSON.stringify([window.__clipboard[0], window.__openedExternally[0]]))

  /* 动态：输入框上方那条提示**只在并发池满、且本会话发得出去时**才出现。
     别的会话在跑 = 正常并发（多实例池），不再提示、也不再挡发送；
     本会话在跑才收起发送钮。 */
  const hintEl = document.getElementById('composerRunHint')
  const sendEl = document.getElementById('send')
  const stopEl = document.getElementById('stop')
  state.currentSessionId = 's1'
  state.runLimit = 3
  state.runs = { session_other: true }
  applyRunState()
  ok('别的会话在跑、池没满：不提示（正常并发，提示了是噪音）+ 发送按钮留在原地',
    hintEl.className.indexOf('hidden') !== -1 && sendEl.className.indexOf('hidden') === -1
      && stopEl.className.indexOf('hidden') !== -1,
    'hint=[' + hintEl.className + '] send=[' + sendEl.className + '] stop=[' + stopEl.className + ']')
  state.runs = { session_a: true, session_b: true, session_c: true }
  applyRunState()
  ok('并发池满（3/3）：提示条出来说实话「再发会被拒」（后端 503 不排队）',
    hintEl.className.indexOf('hidden') === -1
      && hintEl.textContent.indexOf('并发已满') !== -1
      && hintEl.textContent.indexOf('3/3') !== -1
      && hintEl.textContent.indexOf('再发会被拒') !== -1,
    'hint=[' + hintEl.className + '] ' + hintEl.textContent)
  ok('池满也不禁用发送（禁了像 bug），本会话空闲照样能点',
    sendEl.className.indexOf('hidden') === -1 && sendEl.disabled === false
      && stopEl.className.indexOf('hidden') !== -1,
    'send=[' + sendEl.className + '] disabled=' + sendEl.disabled)
  state.runs = { s1: true }
  applyRunState()
  ok('只有本会话在跑：提示条收起、发送收走、只留停止',
    hintEl.className.indexOf('hidden') !== -1 && sendEl.className.indexOf('hidden') !== -1
      && stopEl.className.indexOf('hidden') === -1,
    'hint=[' + hintEl.className + '] send=[' + sendEl.className + ']')
  state.runs = { s1: true, session_a: true, session_b: true }
  applyRunState()
  ok('池满但本会话自己也在跑：不提示「再发会被拒」（他按的是停止，这句不成立）',
    hintEl.className.indexOf('hidden') !== -1 && sendEl.className.indexOf('hidden') !== -1
      && stopEl.className.indexOf('hidden') === -1,
    'hint=[' + hintEl.className + ']')
  state.runLimit = 0
  state.runs = { session_a: true, session_b: true, session_c: true, session_d: true }
  applyRunState()
  ok('上限未知（旧宿主没回报 maxConcurrentRuns）：不猜、不提示',
    hintEl.className.indexOf('hidden') !== -1, 'hint=[' + hintEl.className + ']')
  state.runLimit = 3
  state.runs = {}
  applyRunState()
  ok('全都空闲：提示条收起、发送按钮回来', hintEl.className.indexOf('hidden') !== -1
    && sendEl.className.indexOf('hidden') === -1 && stopEl.className.indexOf('hidden') !== -1)

  /* ================= 会话/偏好 storage 双写（跟端口解耦） =================
     localStorage 按 origin（协议+主机+端口）隔离，端口一换就是新空间 ——
     用户问「下次打开端口被占用、进了下一个端口还有记录吗」引出的改造。
     加载服务端优先、空 store 迁移；保存 local 立即 + PUT 合并。
     ⚠️ 这组用例会整体替换 sessionStore / 界面偏好，开头备份、结尾恢复，
        别把后面「后台思考过程」「真跑 init()」的用例状态带偏。 */
  const savedStoreBackup = JSON.parse(JSON.stringify(sessionStore || {}))
  const savedCurrentIdBackup = state.currentSessionId
  const savedCollapsedBackup = { projects: state.sectionCollapsed.projects, recent: state.sectionCollapsed.recent }
  const savedSentBackup = sentHistory.slice()
  const waitPushes = async () => { await new Promise((r) => setTimeout(r, 30)) }
  window.__uiStorePuts.length = 0
  /* 清掉本地新鲜度时间戳：模拟「本地和服务端本来同步」——不然上一组用例的保存
     会把 stamp 顶成最新，下面的「服务端为准」就变成「本地为准」了。 */
  localStorage.removeItem('dsh-ui-store-stamp')
  window.__uiStoreRemote = {
    sessions: { __recent__: [{ id: 'srv1', scope: 'recent', title: '服务端的会话', messages: [], updatedAt: '' }] },
    currentSessionId: 'srv1',
    prefs: {
      sidebarCollapsed: true, messageWidth: 900,
      sectionCollapsed: { projects: true, recent: false },
      sentHistory: ['服务端历史']
    }
  }
  localStorage.setItem('dsh-sessions-v1', JSON.stringify({
    proj1: [{ id: 'loc1', scope: 'project', projectId: 'proj1', title: '本地的会话', messages: [] }]
  }))
  await loadSessionStore()
  await waitPushes()
  ok('服务端有数据：会话列表以服务端为准（本 origin 的 localStorage 被盖掉）',
    Array.isArray(sessionStore.__recent__) && sessionStore.__recent__.length === 1
      && sessionStore.__recent__[0].id === 'srv1' && not(sessionStore.proj1),
    JSON.stringify(Object.keys(sessionStore)))
  ok('服务端记录的「当前会话」优先于本 origin 的 localStorage',
    readSavedCurrentSessionId() === 'srv1', readSavedCurrentSessionId())
  applyUiPrefsFromServer()
  ok('服务端 prefs 生效：侧边栏折叠 / 消息宽度 / 折叠分组 / 输入历史跟着走',
    byId('app').classList.contains('sidebar-collapsed') === true
      && document.documentElement.style.getPropertyValue('--message-width') === '900px'
      && state.sectionCollapsed.projects === true
      && sentHistory.indexOf('服务端历史') !== -1,
    'width=' + document.documentElement.style.getPropertyValue('--message-width')
      + ' sidebar=' + byId('app').classList.contains('sidebar-collapsed'))
  window.__uiStorePuts.length = 0
  sessionStore.__recent__.push({ id: 'srv2', scope: 'recent', title: '新会话', messages: [] })
  saveSessionStore()
  ok('saveSessionStore 仍然立即写 localStorage（同步兜底不丢）',
    JSON.parse(localStorage.getItem('dsh-sessions-v1')).__recent__.length === 2, '')
  await waitPushes()
  ok('保存同时把整份 store 推上服务端（in-flight 合并后至多一份）',
    window.__uiStorePuts.length === 1
      && window.__uiStorePuts[0].sessions.__recent__.length === 2
      && window.__uiStorePuts[0].currentSessionId === state.currentSessionId
      && typeof window.__uiStorePuts[0].prefs === 'object',
    'puts=' + window.__uiStorePuts.length)
  const realUiGet = window.dsh.uiStoreGet
  const realUiPut = window.dsh.uiStorePut
  delete window.dsh.uiStoreGet
  delete window.dsh.uiStorePut
  window.__uiStorePuts.length = 0
  saveSessionStore()
  await waitPushes()
  ok('老宿主（没有 ui-store 方法）：退化为纯 localStorage，不炸也不推',
    window.__uiStorePuts.length === 0 && Boolean(localStorage.getItem('dsh-sessions-v1')),
    'puts=' + window.__uiStorePuts.length)
  window.dsh.uiStoreGet = realUiGet
  window.dsh.uiStorePut = realUiPut
  window.__uiStoreRemote = null
  window.__uiStorePuts.length = 0
  localStorage.setItem('dsh-sessions-v1', JSON.stringify({
    projX: [{ id: 'old1', scope: 'project', projectId: 'projX', title: '要迁移的旧会话', messages: [] }]
  }))
  await loadSessionStore()
  await waitPushes()
  ok('服务端为空 + 本地有旧数据：加载后自动把旧数据迁上服务端（换端口前的那份不丢）',
    window.__uiStorePuts.length >= 1 && window.__uiStoreRemote
      && Array.isArray(window.__uiStoreRemote.sessions.projX)
      && window.__uiStoreRemote.sessions.projX.length === 1,
    'puts=' + window.__uiStorePuts.length)

  /* ---- 新鲜度对表（2026-09-20 用户报「思考过程有时丢」）：最后一次 PUT 没送到
     （关窗被掐/双客户端竞争）时，服务端是旧的 —— 这时本地为准，不能被旧快照盖掉。 ---- */
  window.__uiStoreRemote = {
    sessions: { __recent__: [{ id: 'srvStale', scope: 'recent', title: '服务端的旧快照', messages: [] }] },
    currentSessionId: 'srvStale',
    updatedAt: Date.now() - 60000 /* 服务端 1 分钟前更新：上一次本地 PUT 丢了 */
  }
  localStorage.setItem('dsh-sessions-v1', JSON.stringify({
    projY: [{ id: 'locNew', scope: 'project', projectId: 'projY', title: '本地较新的会话', messages: [] }]
  }))
  localStorage.setItem('dsh-current-session', 'locNew')
  localStorage.setItem('dsh-ui-store-stamp', String(Date.now())) /* 本地刚保存过 = 比服务端新 */
  await loadSessionStore()
  ok('本地比服务端新（上次 PUT 丢了）：以本地为准，会话不被服务端旧快照盖掉',
    Array.isArray(sessionStore.projY) && sessionStore.projY.length === 1
      && sessionStore.projY[0].id === 'locNew'
      && not(Array.isArray(sessionStore.__recent__) && sessionStore.__recent__.length > 0),
    JSON.stringify(Object.keys(sessionStore)))
  ok('本地较新时不采纳服务端的「当前会话」，回落本 origin 记录',
    readSavedCurrentSessionId() === 'locNew', readSavedCurrentSessionId())
  await waitPushes()
  ok('本地较新时加载完立刻把本地这份补推上服务端',
    window.__uiStorePuts.length >= 1 && window.__uiStoreRemote
      && Array.isArray(window.__uiStoreRemote.sessions.projY),
    'puts=' + window.__uiStorePuts.length)

  window.__uiStoreRemote = {
    sessions: { __recent__: [{ id: 'srvFresh', scope: 'recent', title: '服务端较新', messages: [] }] },
    currentSessionId: 'srvFresh',
    updatedAt: Date.now() /* 服务端刚被另一端更新过 */
  }
  localStorage.setItem('dsh-ui-store-stamp', String(Date.now() - 60000)) /* 本地 1 分钟没保存 */
  await loadSessionStore()
  ok('服务端比本地新（另一端在用）：仍以服务端为准',
    Array.isArray(sessionStore.__recent__) && sessionStore.__recent__.length === 1
      && sessionStore.__recent__[0].id === 'srvFresh',
    JSON.stringify(Object.keys(sessionStore)))
  window.__uiStoreRemote = null
  window.__uiStorePuts.length = 0
  localStorage.removeItem('dsh-ui-store-stamp')
  /* 恢复现场：后面的「后台思考过程 / 真 init()」用例还依赖原来的会话与偏好 */
  sessionStore = savedStoreBackup
  state.currentSessionId = savedCurrentIdBackup
  state.sectionCollapsed = savedCollapsedBackup
  sentHistory = savedSentBackup
  localStorage.setItem('dsh-sessions-v1', JSON.stringify(sessionStore))
  byId('app').classList.remove('sidebar-collapsed')
  document.documentElement.style.removeProperty('--message-width')
  window.__uiStoreRemote = null
  window.__uiStorePuts.length = 0
  localStorage.removeItem('dsh-current-session')

  /* ================= 2026-09-19 后台会话的思考过程 / 授权排队 =================
     用户报「有的会话的思考过程没了」：并发之后一条会话可能在后台整轮跑完，
     它的过程事件在 handleEvent 里被一句「不是当前会话就 return」全丢了，
     processHtml 一直是空串，切回去整块「思考过程」都没有。 */

  /* shim 里没有真 DOM 解析，用递归拼串代替 textContent 读内容 */
  function domText(node) {
    if (!node) return ''
    if (node.nodeValue !== undefined) return String(node.nodeValue)
    let out = String(node._text || '') + String(node._html || '')
    for (const kid of (node.children || [])) out += domText(kid)
    return out
  }

  ok('后台会话的过程也记账（游离累积区 → processHtml）',
    concurrencyStatic.processRecordsBackground, 'processRecord')
  ok('切回正在跑的会话时接着画（不另起一个空的「正在思考」）',
    concurrencyStatic.processResumesLive, 'resumeThinking')
  ok('授权弹窗排队（两条会话同时要授权不会互相抢槽）', concurrencyStatic.approvalQueued, 'approvalQueue')
  ok('后台会话要授权不再被丢掉（会弹窗 + 记进它自己的过程）',
    concurrencyStatic.backgroundApprovalHandled, 'handleBackgroundApproval')
  ok('服务端超时（expired）会收掉弹窗、释放队列（不会被一单堵死）',
    concurrencyStatic.approvalExpiryReleases, 'expireApproval')

  /* ① 后台对话跑：过程必须落在 s2 自己身上，而且不许画进 s1 的画布 */
  state.currentSessionId = 's1'
  const s2Session = findSessionById('s2')
  s2Session.processHtml = ''
  delete state.processBuffers.s2
  renderMessages(findSessionById('s1'))
  const blocksBefore = document.getElementById('messagesInner').querySelectorAll('.thinking-block').length
  await handleEvent({ type: 'assistant:thinking', sessionId: 's2', text: '先读一下代码' })
  await handleEvent({ type: 'tool:start', sessionId: 's2', name: 'read_file', args: { path: 'a.js' } })
  await handleEvent({ type: 'tool:result', sessionId: 's2', name: 'read_file', result: 'export const a = 1' })
  const s2Html = findSessionById('s2').processHtml
  ok('后台会话的过程被逐条记进它自己的 processHtml（思考/工具/结果都在）',
    s2Html.indexOf('先读一下代码') !== -1 && s2Html.indexOf('读取 a.js') !== -1
      && s2Html.indexOf('export const a = 1') !== -1
      /* 过程改成步骤结构后，后台这一条也必须是一步一个节点，不能退回整段纯文本 */
      && s2Html.indexOf('tl-step') !== -1 && s2Html.indexOf('tl-ok') !== -1,
    s2Html.slice(0, 80))
  ok('后台会话的过程不画进当前会话的画布',
    document.getElementById('messagesInner').querySelectorAll('.thinking-block').length === blocksBefore,
    'before=' + blocksBefore)

  /* ② 切回去：思考过程必须还在（这就是用户说的「没了」） */
  await selectSession('s2')
  const s2Blocks = document.getElementById('messagesInner').querySelectorAll('.thinking-block')
  ok('切回后台跑过的会话，思考过程还在（用户报的 bug）',
    s2Blocks.length >= 1 && domText(s2Blocks[0]).indexOf('先读一下代码') !== -1
      && domText(s2Blocks[0]).indexOf('读取 a.js') !== -1,
    'blocks=' + s2Blocks.length + ' text=' + domText(s2Blocks[0]).slice(0, 60))
  /* 后台这一轮只有真实思考和工具两步，不把界面提示伪装成第三步。 */
  ok('切回来时折叠条摘要按步数显示（重载后也数得出几步）',
    s2Blocks.length >= 1 && domText(s2Blocks[0].querySelector('summary')).indexOf('2 步') !== -1,
    s2Blocks.length >= 1 ? domText(s2Blocks[0].querySelector('summary')) : 'no block')

  /* ③ 正在跑的会话切回来：过程接着画，别另起一块空的 */
  const s2Live = findSessionById('s2')
  delete s2Live.processTimeline
  delete s2Live.legacyProcessHtml
  s2Live.processHtml = '<div class="thinking-tool">工具调用：grep</div>'
  state.currentSessionId = 's2'
  state.runs = { s2: true }
  window.__dshRunningSessions = ['s2']
  applyRunState()
  renderMessages(s2Live)
  const liveBlocks = document.getElementById('messagesInner').querySelectorAll('.thinking-block')
  ok('切回正在跑的会话：只剩一个「进行中」的过程块（不重复）', liveBlocks.length === 1,
    'blocks=' + liveBlocks.length)
  ok('而且已经有内容（之前记下的过程接着画，不是空的「正在思考」）',
    domText(liveBlocks[0]).indexOf('工具调用：grep') !== -1, domText(liveBlocks[0]).slice(0, 40))
  state.runs = {}
  window.__dshRunningSessions = []
  applyRunState()

  /* ④ 授权弹窗排队：并发时后到的请求不许抢槽（抢了先弹的那条要干等 5 分钟超时） */
  state.approvalQueue.length = 0
  state.approvalBusy = false
  state.approvalResolver = null
  settingsState.approvalAllow = []
  const approvalKindEl = document.getElementById('approvalKind')
  const approvalModalEl = document.getElementById('approvalModal')
  const firstApproval = requestApproval({ kind: 'command', program: 'npm', signature: 'command:npm', title: 'Run npm', detail: 'npm i' }, '会话A')
  ok('第一个授权请求立刻弹窗，标题点明是哪条会话',
    approvalModalEl.classList.contains('hidden') === false && approvalKindEl.textContent.indexOf('会话A') !== -1,
    approvalKindEl.textContent)
  const secondApproval = requestApproval({ kind: 'edit', signature: 'edit', title: 'Edit a.js', detail: 'a.js' }, '会话B')
  ok('两条会话同时要授权：后到的排队等，不抢槽',
    state.approvalQueue.length === 1 && state.approvalResolver !== null,
    'queue=' + state.approvalQueue.length)
  resolveApproval(true, 'once')
  const firstDecision = await firstApproval
  ok('第一个请求拿到答复（不再被顶掉）', firstDecision.approved === true, JSON.stringify(firstDecision))
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok('第一个答复完，第二个自动接上（会话B 不用干等超时）',
    approvalKindEl.textContent.indexOf('会话B') !== -1
      && approvalModalEl.classList.contains('hidden') === false,
    approvalKindEl.textContent)
  resolveApproval(false, 'once')
  const secondDecision = await secondApproval
  ok('第二个请求也拿到答复（拒绝）', secondDecision.approved === false, JSON.stringify(secondDecision))
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok('队列排空、弹窗收起',
    state.approvalQueue.length === 0 && approvalModalEl.classList.contains('hidden') === true,
    'queue=' + state.approvalQueue.length)

  /* ⑤ 后台会话的授权走完整链路：弹窗 → 答复 → 记进它自己的过程 → 回给宿主 */
  state.currentSessionId = 's1'
  state.approvalQueue.length = 0
  state.approvalBusy = false
  state.approvalResolver = null
  window.__approveCalls = []
  approveCalls.length = 0
  findSessionById('s2').processHtml = ''
  await handleEvent({
    type: 'approval', id: 'ap_bg', sessionId: 's2',
    request: { kind: 'command', program: 'npm', signature: 'command:npm', title: 'Run npm', detail: 'npm i' }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok('后台会话要授权：弹窗照样出来（以前整条事件被丢掉，那条会话静默卡 5 分钟）',
    approvalKindEl.textContent.indexOf('会话2') !== -1, approvalKindEl.textContent)
  resolveApproval(true, 'once')
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok('后台会话的授权结果回给了宿主（带事件 id）',
    approveCalls.length === 1 && approveCalls[0][0] === 'ap_bg' && approveCalls[0][1] === true,
    JSON.stringify(approveCalls))
  ok('后台会话的授权结果记进了它自己的思考过程',
    findSessionById('s2').processHtml.indexOf('已批准') !== -1,
    findSessionById('s2').processHtml.slice(0, 60))

  /* ⑥ 中途接手：这条会话本来是当前会话（前半段画在 DOM 里 → 已同步进 processHtml），
     用户切走之后才轮到后台累积区接手 —— 后半段必须接在前半段后面，不能把前面盖掉。 */
  state.currentSessionId = 's2'
  findSessionById('s2').processHtml = '<div class="thinking-tool">工具调用：前半段</div>'
  delete state.processBuffers.s2
  state.currentSessionId = 's1'
  await handleEvent({ type: 'assistant:thinking', sessionId: 's2', text: '后半段' })
  flushProcessSaves() /* 流式快照合并窗口结束后核对持久化视图。 */
  const mergedHtml = findSessionById('s2').processHtml
  ok('切走后由后台接手：前半段（曾画在 DOM 里）没被盖掉，和后半段接在一起',
    mergedHtml.indexOf('前半段') !== -1 && mergedHtml.indexOf('后半段') !== -1,
    mergedHtml.slice(0, 90))

  /* ⑦ 服务端 5 分钟超时（expired）：还开着的那扇弹窗必须被收掉。
     不收的话 approvalBusy 永远为真 → 之后任何会话的授权都只排队、永远不弹（静默失效）。 */
  state.approvalQueue.length = 0
  state.approvalBusy = false
  state.approvalResolver = null
  state.approvalCurrentId = ''
  state.currentSessionId = 's1'
  renderMessages(findSessionById('s1'))
  const expiring = requestApproval({ kind: 'command', program: 'npm', title: 'Run npm' }, '', 'ap_exp')
  const waiting = requestApproval({ kind: 'edit', title: 'Edit b.js' }, '', 'ap_waiting')
  ok('超时用例就位：一单在弹、一单在排',
    state.approvalCurrentId === 'ap_exp' && state.approvalQueue.length === 1,
    'cur=' + state.approvalCurrentId + ' queue=' + state.approvalQueue.length)
  await handleEvent({
    type: 'approval', id: 'ap_exp', expired: true, sessionId: 's1',
    request: { kind: 'command', program: 'npm', title: 'Run npm' }
  })
  const expiredDecision = await expiring
  ok('服务端说超时：弹窗被收掉、按拒绝处理（不用再干等）',
    expiredDecision.approved === false, JSON.stringify(expiredDecision))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok('超时那单收掉后，排队的一单能接上（队列没被堵死）',
    state.approvalCurrentId === 'ap_waiting' && state.approvalQueue.length === 0,
    'cur=' + state.approvalCurrentId + ' queue=' + state.approvalQueue.length)
  resolveApproval(false, 'once')
  const waitingDecision = await waiting
  ok('排队那单也拿到答复，弹窗收起',
    waitingDecision.approved === false && approvalModalEl.classList.contains('hidden') === true,
    JSON.stringify(waitingDecision))

  /* ================= 2026-09-23 用户报的两个问题 =================
     ①「思考过程还是会丢失」②「模型切换完之后页面显示还是没切换成功」
     下面先按真实路径把它们跑出来，红了才说明复现成功。 */

  /* ⑧ 同一会话连跑两轮：第二轮开始时不许把第一轮记下的过程盖掉。
     saveThinkingProcess 曾经直接写 session.processHtml = content.innerHTML ——
     新的一轮会新起一个过程块，于是写回去的只有本轮内容，上一轮的过程被抹掉
     （表现：重载页面 / 切走再切回后，只剩最后一轮的思考过程，前面的都没了）。 */
  const s1keep = findSessionById('s1')
  state.currentSessionId = 's1'
  delete s1keep.processTimeline
  delete s1keep.legacyProcessHtml
  s1keep.processHtml = ''
  s1keep.messages = []
  delete state.processBuffers.s1
  state.runs = { s1: true }
  window.__dshRunningSessions = ['s1']
  applyRunState()
  renderMessages(s1keep)
  await handleEvent({ type: 'assistant:thinking', sessionId: 's1', text: '第一轮思考：先看日志' })
  await handleEvent({ type: 'tool:start', sessionId: 's1', name: 'read_file', args: { path: 'a.js' } })
  await handleEvent({
    type: 'finished', sessionId: 's1',
    messages: [{ role: 'assistant', content: '第一轮回答' }]
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  state.runs = { s1: true }
  window.__dshRunningSessions = ['s1']
  applyRunState()
  await handleEvent({ type: 'assistant:thinking', sessionId: 's1', text: '第二轮思考：复现一下' })
  flushProcessSaves() /* 流式快照合并窗口结束后核对持久化视图。 */
  const twoTurnHtml = findSessionById('s1').processHtml
  ok('同一会话连跑两轮：第一轮的过程不会被第二轮盖掉（旧实现只剩最后一轮）',
    twoTurnHtml.indexOf('第一轮思考') !== -1 && twoTurnHtml.indexOf('第二轮思考') !== -1,
    twoTurnHtml.slice(0, 110))
  renderMessages(findSessionById('s1'))
  const twoTurnBlocks = document.getElementById('messagesInner').querySelectorAll('.thinking-block')
  ok('重载 / 切走再切回后，两轮的过程都还在',
    twoTurnBlocks.length >= 1
      && Array.from(twoTurnBlocks).map(domText).join('').indexOf('第一轮思考') !== -1
      && Array.from(twoTurnBlocks).map(domText).join('').indexOf('第二轮思考') !== -1,
    'blocks=' + twoTurnBlocks.length + ' text=' + domText(twoTurnBlocks[0]).slice(0, 70))
  state.runs = {}
  window.__dshRunningSessions = []
  applyRunState()

  /* 真正序列化再加载：每段过程应保留在对应回复之前，而非全部挪到最前面。 */
  const traceSession = findSessionById('s1')
  delete traceSession.processTimeline
  delete traceSession.legacyProcessHtml
  traceSession.processHtml = ''
  traceSession.messages = []
  renderMessages(traceSession)
  await handleEvent({ type: 'assistant:thinking', sessionId: 's1', text: '定位过程甲' })
  await handleEvent({ type: 'assistant:message', sessionId: 's1', text: '定位回复甲' })
  await handleEvent({ type: 'assistant:thinking', sessionId: 's1', text: '定位过程乙' })
  await handleEvent({ type: 'tool:start', sessionId: 's1', name: 'read_file', args: { path: 'trace.js' } })
  await handleEvent({ type: 'tool:result', sessionId: 's1', name: 'read_file', result: '定位工具结果' })
  await handleEvent({ type: 'assistant:message', sessionId: 's1', text: '定位回复乙' })
  await handleEvent({ type: 'finished', sessionId: 's1', messages: [
    { role: 'assistant', content: '定位回复甲' }, { role: 'assistant', content: '定位回复乙' }
  ] })
  const reloadedTrace = JSON.parse(JSON.stringify(findSessionById('s1')))
  renderMessages(reloadedTrace)
  const traceText = domText(document.getElementById('messagesInner'))
  ok('序列化恢复后每段过程仍在对应回复前，第二段不再被挪到会话开头',
    traceText.indexOf('定位过程甲') < traceText.indexOf('定位回复甲')
      && traceText.indexOf('定位回复甲') < traceText.indexOf('定位过程乙')
      && traceText.indexOf('定位过程乙') < traceText.indexOf('定位回复乙'))
  ok('恢复后的工具调用和结果没有丢失，也不重复',
    traceText.indexOf('trace.js') !== -1 && traceText.split('定位工具结果').length === 2
      && reloadedTrace.processTimeline.length === 2)

  const backgroundTrace = findSessionById('s2')
  delete backgroundTrace.processTimeline
  backgroundTrace.processHtml = ''
  delete state.processBuffers.s2
  await handleEvent({ type: 'assistant:thinking', sessionId: 's2', text: '后台过程一' })
  await handleEvent({ type: 'assistant:message', sessionId: 's2', text: '后台回复一' })
  await handleEvent({ type: 'assistant:thinking', sessionId: 's2', text: '后台过程二' })
  await handleEvent({ type: 'assistant:message', sessionId: 's2', text: '后台回复二' })
  await handleEvent({ type: 'finished', sessionId: 's2', messages: [
    { role: 'assistant', content: '后台回复一' }, { role: 'assistant', content: '后台回复二' }
  ] })
  ok('后台会话按回复分段，finished 不重复保存已经定位的过程',
    backgroundTrace.processTimeline.length === 2
      && backgroundTrace.processTimeline[0].html.indexOf('后台过程一') !== -1
      && backgroundTrace.processTimeline[1].html.indexOf('后台过程一') === -1
      && backgroundTrace.processTimeline[1].html.indexOf('后台过程二') !== -1)

  /* ⑨ 模型切换的显示：点回「这家自己那个 model」时也不能漏渲染。
     selectProviderModel 里 name === model.model 的早返回分支只调了 renderProviderList，
     没调 renderModelSelect —— 输入框上的标签还是旧模型（用户看到的「没切换成功」）。 */
  settingsState.models = [
    { id: 'p1', name: '供应商一', model: 'm1', modelList: ['m1', 'm1b'] },
    { id: 'p2', name: '供应商二', model: 'm2', modelList: ['m2'] }
  ]
  settingsState.currentModelId = 'p1'
  state.settings = settingsState
  renderModelSelect()
  const modelLabelEl = document.getElementById('composerModelLabel')
  ok('模型标签初始就是当前 provider 的 model', modelLabelEl.textContent === 'm1', modelLabelEl.textContent)
  await selectProviderModel('p2', 'm2')
  ok('切到另家供应商：标签跟着变',
    settingsState.currentModelId === 'p2' && modelLabelEl.textContent === 'm2', modelLabelEl.textContent)
  await selectProviderModel('p1', 'm1')
  ok('切回原来那家（点的正是它自己那个 model）标签也要变回来',
    settingsState.currentModelId === 'p1' && modelLabelEl.textContent === 'm1', modelLabelEl.textContent)
  const activeModelItems = []
  for (const item of document.getElementById('composerModelMenu').querySelectorAll('.dropdown-item')) {
    if (String(item.className).indexOf('active') !== -1) activeModelItems.push(domText(item))
  }
  ok('下拉里打勾的也回到 m1（不是留着的 m2）',
    activeModelItems.length === 1
      && activeModelItems[0].indexOf('m1') !== -1
      && activeModelItems[0].indexOf('m2') === -1,
    activeModelItems.join('|'))

  /* ⑩ 续接正在跑的会话时不许自己叠自己：resumeThinking 会把已有过程放进块里，
     再来的增量保存回去时，旧内容只能出现一次（否则每次切回都翻一倍）。 */
  state.currentSessionId = 's2'
  const s2Resume = findSessionById('s2')
  delete s2Resume.processTimeline
  delete s2Resume.legacyProcessHtml
  s2Resume.processHtml = '<div class="thinking-tool">工具调用：abc</div>'
  state.runs = { s2: true }
  window.__dshRunningSessions = ['s2']
  applyRunState()
  renderMessages(s2Resume)
  await handleEvent({ type: 'assistant:thinking', sessionId: 's2', text: '续写的增量' })
  flushProcessSaves() /* 流式快照合并窗口结束后核对持久化视图。 */
  const resumedHtml = findSessionById('s2').processHtml
  const abcCount = resumedHtml.split('工具调用：abc').length - 1
  ok('续接正在跑的会话：已有过程只保存一次（出现两次就是兜底重复了）',
    abcCount === 1 && resumedHtml.indexOf('续写的增量') !== -1, 'count=' + abcCount)
  state.runs = {}
  window.__dshRunningSessions = []
  applyRunState()

  /* ⑪ 发下一条消息不许把整条会话的思考过程清掉。
     真正的元凶是 sendMessage 里那句 session.processHtml = '' —— 攒了多少轮，一发新消息全清。
     这里直接用假宿主跑真的 sendMessage。 */
  ok('源码层面不再出现「发送时清空 processHtml」那句', (function () {
    /* 先扒掉块注释：说明这段历史的注释里会引用那句话，不扒掉就是自己触发自己。
       这里刻意不用正则字面量：本段用例跑在模板字符串里，正则需要转义、而注释里又
       没法写块注释起始符（会把外层注释提前闭合），改用字符扫描最稳。 */
    let codeOnly = ''
    let rest = appSrc
    for (;;) {
      const open = rest.indexOf('/*')
      if (open === -1) { codeOnly += rest; break }
      codeOnly += rest.slice(0, open)
      const close = rest.indexOf('*/', open + 2)
      if (close === -1) break
      rest = rest.slice(close + 2)
    }
    return codeOnly.indexOf("session.processHtml = ''") === -1
  })(), 'sendMessage')
  settingsState.models = [{ id: 'model_mock', name: 'mock', baseURL: 'http://127.0.0.1:1/v1', model: 'mock', apiKey: 'x' }]
  settingsState.currentModelId = 'model_mock'
  state.settings = settingsState
  state.workspacePath = '/ws/a'
  state.currentSessionId = 's1'
  state.runs = {}
  window.__dshRunningSessions = []
  applyRunState()
  const s1Send = findSessionById('s1')
  delete s1Send.processTimeline
  delete s1Send.legacyProcessHtml
  s1Send.processHtml = '<div class="thinking-tool">上一轮留下的思考痕迹</div>'
  s1Send.messages = []
  window.__sendCalls = []
  const sendInputEl = document.getElementById('input')
  sendInputEl.innerText = '再问一句'
  await sendMessage()
  const afterSendHtml = findSessionById('s1').processHtml
  ok('发下一条消息不会清掉历史思考过程（旧实现一发新消息就全没）',
    afterSendHtml.indexOf('上一轮留下的思考痕迹') !== -1,
    'len=' + afterSendHtml.length + ' head=' + afterSendHtml.slice(0, 40))
  ok('发送流程本身没被改坏（消息照样发出去）',
    window.__sendCalls.length === 1, 'calls=' + window.__sendCalls.length)

  /* ================= 收尾：真的跑一遍 init()，让「点停止」走真实的事件回调 =================
     checks 前面所有断言都没走 init（监听器是空的），所以停止按钮只能用源码断言。
     这里补一次真实 init，把「停 A 不动 B」落成行为级断言。 */
  state.runs = {}
  window.__dshRunningSessions = []
  window.__dshRunning = false
  await waitPushes()
  window.__uiStoreRemote.currentSessionId = 's1'
  window.__uiStoreRemote.updatedAt = Date.now()
  localStorage.removeItem('dsh-ui-store-stamp')
  localStorage.removeItem('dsh-sessions-v1')
  localStorage.removeItem('dsh-current-session')
  sessionStore = {}
  state.currentSessionId = ''
  await init()
  await waitPushes()
  ok('完整 init 在新端口从服务端恢复会话，启动布局不覆盖历史或当前 id',
    state.currentSessionId === 's1' && localStorage.getItem('dsh-current-session') === 's1'
      && window.__uiStoreRemote.currentSessionId === 's1'
      && currentSession().id === 's1')

  /* 顶栏跑真实渲染与按钮回调；几何/各平台预留空间由 shell-chrome/drag 负责。 */
  const titlebarSession = currentSession()
  const titlebarOriginalTitle = titlebarSession.title
  const titlebarOriginalScope = titlebarSession.scope
  // Project sessions show the project name. Use a recent session to verify renaming.
  titlebarSession.scope = 'recent'
  renderWindowTitle()
  const titlebarObserver = mutationObservers.find((observer) =>
    observer.targets.some((entry) => entry.target === byId('app')))
  const notifyTitlebar = () => { if (titlebarObserver) titlebarObserver.callback([]) }
  ok('恢复会话后顶栏与窗口标题显示当前会话名',
    byId('windowTitle').textContent === titlebarSession.title
      && document.title === titlebarSession.title + ' · Agent')
  titlebarSession.title = '独立顶栏会话'
  renderWorkspaceList()
  ok('会话重命名后渲染列表同时更新顶栏标题',
    byId('windowTitle').textContent === '独立顶栏会话')
  titlebarSession.title = titlebarOriginalTitle

  const titlebarProjectsBackup = state.settings.projects
  const titlebarActiveProjectBackup = state.activeProjectId
  state.settings.projects = [{ id: 'titlebar_project', name: '顶栏项目', folders: ['/ws/titlebar'] }]
  state.activeProjectId = 'titlebar_project'
  state.currentSessionId = ''
  renderWindowTitle()
  ok('尚无会话时顶栏显示当前项目名', byId('windowTitle').textContent === '顶栏项目')
  state.settings.projects = titlebarProjectsBackup
  state.activeProjectId = titlebarActiveProjectBackup
  state.currentSessionId = titlebarSession.id

  const titlebarPanelTitleBackup = byId('panelTitle').textContent
  byId('panelTitle').textContent = '审阅目录'
  document.documentElement.classList.add('chat-hidden')
  notifyTitlebar()
  ok('只看文件模式的布局监听同步文件区标题',
    byId('windowTitle').textContent === '审阅目录')
  byId('restoreChat').click()
  notifyTitlebar()
  ok('返回聊天按钮经过真实文件面板委托恢复聊天与会话标题',
    not(document.documentElement.classList.contains('chat-hidden'))
      && byId('windowTitle').textContent === titlebarSession.title)
  titlebarSession.scope = titlebarOriginalScope
  byId('panelTitle').textContent = titlebarPanelTitleBackup

  const titlebarWasCollapsed = byId('app').classList.contains('sidebar-collapsed')
  byId('sidebarToggle').click()
  const titlebarSidebarExpanded = byId('sidebarToggle').getAttribute('aria-expanded')
  const titlebarSidebarLabel = byId('sidebarToggle').getAttribute('aria-label')
  byId('sidebarToggle').click()
  ok('侧栏开关点击同步展开状态和可访问名称，再次点击恢复原布局',
    titlebarSidebarExpanded === (titlebarWasCollapsed ? 'true' : 'false')
      && titlebarSidebarLabel === (titlebarWasCollapsed ? '折叠侧边栏' : '展开侧边栏')
      && byId('app').classList.contains('sidebar-collapsed') === titlebarWasCollapsed)

  const titlebarPanelWasOpen = window.filePanel.isOpen()
  byId('panelToggle').click()
  notifyTitlebar()
  const titlebarPanelExpanded = byId('panelToggle').getAttribute('aria-expanded')
  const titlebarPanelLabel = byId('panelToggle').getAttribute('aria-label')
  byId('panelToggle').click()
  notifyTitlebar()
  ok('顶栏面板按钮经过真实委托切换文件区并同步展开状态',
    titlebarPanelExpanded === (titlebarPanelWasOpen ? 'false' : 'true')
      && titlebarPanelLabel === (titlebarPanelWasOpen ? '展开文件面板' : '收起文件面板')
      && window.filePanel.isOpen() === titlebarPanelWasOpen)

  state.currentSessionId = 's1'
  state.runs = { s1: true, s2: true }
  applyRunState()
  window.__stopCalls = []
  window.__resetCalls = []
  updateThinking('取消前的思考记录')
  scheduleWaitingHint()
  const stoppedThinking = state.currentThinkingDetails
  stopEl.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok('点停止把「当前会话」的 id 发下去（真实回调，不是源码断言）',
    window.__stopCalls.length === 1 && window.__stopCalls[0] === 's1',
    JSON.stringify(window.__stopCalls))
  ok('停本会话不会顺手动到并行的 s2（A 停止不影响 B）',
    state.runs.s1 !== true && state.runs.s2 === true, JSON.stringify(state.runs))
  ok('停止后按钮回到「发送」态（只针对本会话）',
    sendEl.className.indexOf('hidden') === -1 && stopEl.className.indexOf('hidden') !== -1,
    'send=[' + sendEl.className + '] stop=[' + stopEl.className + ']')

  ok('点停止立即清理思考动画和等待定时器，保留过程内容',
    !stoppedThinking.classList.contains('thinking-active') && state.waitingTimer === null
      && state.currentThinking === null && domText(stoppedThinking).indexOf('取消前的思考记录') !== -1)
  await handleEvent({ type: 'assistant:thinking', sessionId: 's1', text: '停止后延迟送达的记录' })
  scheduleWaitingHint()
  ok('停止后迟到的过程增量保留为静态记录，不会重新转圈或启动等待提示',
    document.getElementById('messagesInner').querySelectorAll('.thinking-active').length === 0
      && state.waitingTimer === null)
  state.runs = { s1: true, s2: true }
  updateThinking('轮询收尾测试')
  applyRuns(['s2'], true)
  applyRunState()
  ok('即使漏掉 finished，宿主轮询发现本会话结束也会清理全部思考动画',
    !currentRunning() && state.runs.s2 === true && state.currentThinking === null
      && document.getElementById('messagesInner').querySelectorAll('.thinking-active').length === 0)

  /* ---- 首次启动：没有项目、没有新建会话，直接点发送 ---- */
  settingsState.projects = []
  settingsState.currentProjectId = ''
  state.settings = settingsState
  settingsState.workspacePath = '/ws/first'
  state.workspacePath = '/ws/first'
  state.activeProjectId = ''
  state.currentSessionId = ''
  state.runs = {}
  state.pendingMessages.length = 0
  window.__dshRunningSessions = []
  sessionStore = { __recent__: [] }
  window.__uiStoreRemote = null
  window.__uiStorePuts = []
  localStorage.removeItem('dsh-current-session')
  renderMessages(null)
  window.__sendCalls = []
  const firstInput = byId('input')
  firstInput.innerText = '第一次直接聊天'
  sendEl.click()
  await waitPushes()
  const firstSession = currentSession()
  const firstId = firstSession && firstSession.id
  ok('无项目且未新建会话：点击发送自动生成有 id 的最近会话',
    Boolean(firstId) && firstSession.scope === 'recent' && firstSession.projectId === ''
      && getRecentSessions().length === 1 && window.__sendCalls.length === 1
      && window.__sendCalls[0].sessionId === firstId,
    'id=' + firstId)
  ok('首次直接聊天有历史且出现在最近列表',
    firstSession.messages.length === 1 && firstSession.messages[0].content === '第一次直接聊天'
      && byId('chatList').children.length === 1,
    'messages=' + firstSession.messages.length)
  ok('自动生成的会话 id 同时保存到本地和服务端',
    localStorage.getItem('dsh-current-session') === firstId
      && window.__uiStoreRemote.currentSessionId === firstId,
    'remote=' + window.__uiStoreRemote.currentSessionId)
  await handleEvent({ type: 'finished', sessionId: firstId,
    messages: [{ role: 'user', content: '第一次直接聊天' }, { role: 'assistant', content: '第一次回复' }] })
  window.__sendCalls = []
  firstInput.innerText = '第二句话'
  await sendMessage()
  ok('第二句话继续同一会话，发送完整上下文',
    window.__sendCalls.length === 1 && window.__sendCalls[0].sessionId === firstId
      && window.__sendCalls[0].history.length === 2
      && window.__sendCalls[0].history[1].content === '第一次回复'
      && getRecentSessions().length === 1,
    'history=' + window.__sendCalls[0].history.length)
  clearWaitingTimer()
  await waitPushes()

  /* 模拟刷新：状态先清空，服务端有刚才的记录。迁移 PUT 必须保留 currentSessionId。 */
  state.currentSessionId = ''
  sessionStore = {}
  localStorage.removeItem('dsh-ui-store-stamp')
  await loadSessionStore()
  await waitPushes()
  ok('刷新恢复首条自动会话，迁移保存不把服务端当前会话覆盖为空',
    state.currentSessionId === firstId && currentSession().messages.length === 3
      && window.__uiStoreRemote.currentSessionId === firstId,
    'current=' + state.currentSessionId + ' remote=' + window.__uiStoreRemote.currentSessionId)
  const getBackup = window.dsh.uiStoreGet
  const putBackup = window.dsh.uiStorePut
  delete window.dsh.uiStoreGet
  delete window.dsh.uiStorePut
  state.currentSessionId = ''
  sessionStore = {}
  await loadSessionStore()
  ok('服务端不可用时，本地记录也能恢复首次自动会话',
    state.currentSessionId === firstId && currentSession().messages.length === 3,
    'current=' + state.currentSessionId)
  window.dsh.uiStoreGet = getBackup
  window.dsh.uiStorePut = putBackup

  /* 首条发送尚未完成时仍有可停止的会话账本。 */
  const sendBackup = window.dsh.send
  let finishFirstSend = null
  window.dsh.send = () => new Promise((resolve) => { finishFirstSend = resolve })
  state.currentSessionId = ''
  state.runs = {}
  sessionStore = { __recent__: [] }
  firstInput.innerText = '首条任务运行中'
  const firstPending = sendMessage()
  const runningFirstId = state.currentSessionId
  ok('首次直接聊天运行中可停止，账本使用自动会话 id',
    Boolean(runningFirstId) && currentRunning()
      && stopEl.className.indexOf('hidden') === -1 && sendEl.className.indexOf('hidden') !== -1,
    'running=' + runningFirstId)
  finishFirstSend(true)
  await firstPending
  clearWaitingTimer()
  window.dsh.send = sendBackup

  settingsState.projects = [{ id: 'project_first', name: 'First', folders: ['/ws/first'] }]
  settingsState.currentProjectId = 'project_first'
  state.activeProjectId = 'project_first'
  state.currentSessionId = ''
  firstInput.innerText = '选中空项目后直接聊天'
  await sendMessage()
  ok('选中空项目后直接发送，会话归入该项目并保存当前 id',
    currentSession().scope === 'project' && currentSession().projectId === 'project_first'
      && state.activeProjectId === 'project_first'
      && state.expandedProjects.project_first === true
      && localStorage.getItem('dsh-current-session') === state.currentSessionId)
  clearWaitingTimer()
  state.currentSessionId = ''
  state.activeProjectId = ''
  firstInput.innerText = '主页直接聊天'
  await sendMessage()
  ok('主页直接发送与新建会话一致，归入最近列表',
    currentSession().scope === 'recent' && state.activeProjectId === '')
  clearWaitingTimer()

  state.currentSessionId = ''
  sessionStore = { __recent__: [] }
  state.workspacePath = ''
  window.__sendCalls = []
  firstInput.innerText = '未配置工作区时的草稿'
  await sendMessage()
  ok('工作区未配置时提示错误并保留草稿，不产生无 id 聊天',
    window.__sendCalls.length === 0 && state.currentSessionId === ''
      && firstInput.innerText === '未配置工作区时的草稿')
  state.workspacePath = '/ws/first'
  settingsState.currentProjectId = ''
  settingsState.projects = []
  byId('projectModal').classList.add('hidden')
  byId('newSession').click()
  await waitPushes()
  ok('独立工作区点击新建会话也能直接生成最近会话',
    Boolean(currentSession()) && currentSession().scope === 'recent'
      && byId('projectModal').classList.contains('hidden'))
  window.dsh.isDesktop = false
  window.dsh.pickNativeFolder = async () => ({ path: '', canceled: false })
  state.projectFolders = []
  byId('dirBrowserModal').classList.add('hidden')
  await addProjectFolder()
  ok('Linux 原生目录工具不可用时回退到内置目录浏览器',
    not(byId('dirBrowserModal').classList.contains('hidden'))
      && state.currentDirData.path === '/' && state.projectFolders.length === 0)
  window.dsh.pickNativeFolder = async () => ({ path: '', canceled: true })
  byId('dirBrowserModal').classList.add('hidden')
  await addProjectFolder()
  ok('用户取消原生选目录时不再弹出回退目录浏览器',
    byId('dirBrowserModal').classList.contains('hidden') && state.projectFolders.length === 0)

  /* ---- P0 步骤时间线：一轮里思考与工具各成一步，带标题、状态、耗时，折叠成一条摘要 ----
     改之前这里全是「一排同名的思考过程折叠条」，看不出每步在做什么、也没法判断卡没卡住。 */
  const tlBox = byId('messagesInner')
  /* 这段断言的是尚未实现的能力：拿兜底实现顶一下，缺功能只让本段判 FAIL，
     不会把整个套件带崩 —— 崩了就看不到其余 300 多条回归的真实结果。 */
  const tlTitleOf = typeof toolStepTitle === 'function' ? toolStepTitle : function () { return '' }
  const tlRefresh = typeof updateRunStatus === 'function' ? updateRunStatus : function () {}
  tlBox.children = []
  tlBox.childNodes = []
  state.currentSessionId = 's1'
  state.runs = { s1: true }
  state.currentThinking = null
  state.currentThinkingDetails = null
  state.thinkingBase = ''
  applyRunState()
  /* 运行状态行：发出去之后要能看出「正在干什么、跑了多久」。
     断言按真实时序插在每一步之间 —— 工具跑完之后本来就该回到「正在 思考…」。 */
  const tlStatus = byId('runStatus')
  const tlStatusText = byId('runStatusText')
  const tlStatusTime = byId('runStatusTime')
  updateThinking('先看看仓库结构')
  ok('本会话在跑时状态行露出来',
    not(tlStatus.classList.contains('hidden')) && tlStatusText.textContent.indexOf('正在') === 0,
    tlStatusText.textContent)
  ok('状态行带耗时', /[0-9]/.test(tlStatusTime.textContent), tlStatusTime.textContent)
  appendThinkingToolStart('read_file', { path: '/ws/app/package.json' })
  ok('工具步骤开始时状态行报的是工具标题',
    tlStatusText.textContent.indexOf('读取 package.json') !== -1, tlStatusText.textContent)
  appendThinkingToolResult('read_file', '{"name":"app"}')
  ok('工具跑完、等模型回复时状态行回到「正在 分析任务…」',
    tlStatusText.textContent.indexOf('正在 分析任务…') === 0, tlStatusText.textContent)
  const tlBlocks = tlBox.querySelectorAll('.thinking-block')
  const tlContent = tlBlocks.length > 0 ? tlBlocks[0].querySelector('.thinking-content') : null
  const tlSteps = tlContent ? tlContent.querySelectorAll('.tl-step') : []
  ok('一轮里「思考」和「工具调用」各自成步', tlSteps.length === 2, 'steps=' + tlSteps.length)
  const tlToolTitle = tlSteps.length === 2 ? domText(tlSteps[1].querySelector('.tl-title')) : ''
  ok('工具步骤标题说人话（读取 package.json，不是原始工具名）',
    tlToolTitle.indexOf('读取 package.json') !== -1, tlToolTitle)
  ok('工具跑完标成功、进行中标记撤掉',
    tlSteps.length === 2 && tlSteps[1].classList.contains('tl-ok')
      && not(tlSteps[1].classList.contains('tl-running')),
    tlSteps.length === 2 ? tlSteps[1].className : 'no step')
  ok('连续步骤折叠成一条「已执行 N 步」摘要，而不是一排同名折叠条',
    tlBlocks.length === 1 && domText(tlBlocks[0].querySelector('summary')).indexOf('2 步') !== -1,
    tlBlocks.length === 1 ? domText(tlBlocks[0].querySelector('summary')) : 'blocks=' + tlBlocks.length)
  ok('命令类工具标题带命令本身',
    tlTitleOf('run_command', { command: 'npm run dev' }) === '执行 npm run dev',
    tlTitleOf('run_command', { command: 'npm run dev' }))
  ok('未识别的工具退回工具名，不编造动作',
    tlTitleOf('weird_tool', {}) === 'weird_tool', tlTitleOf('weird_tool', {}))

  appendThinkingToolStart('run_command', { command: 'npm run dev' })
  tlRefresh()
  ok('切到下一步后状态行改成当前步骤',
    tlStatusText.textContent.indexOf('执行 npm run dev') !== -1, tlStatusText.textContent)
  await handleEvent({ type: 'finished', sessionId: 's1', messages: [] })
  ok('跑完状态行收起、计时器清掉',
    tlStatus.classList.contains('hidden') && state.runStatusTimer === null, tlStatus.className)

  /* 老数据不能被新结构弄坏：历史里只有纯文本过程时，仍按原来的「思考过程」显示 */
  const tlLegacySession = { id: 's_legacy', projectId: '', scope: 'recent', title: '老会话',
    messages: [{ role: 'user', content: '之前的提问' }, { role: 'assistant', content: '之前的回复' }],
    processHtml: '以前的一段思考' }
  sessionStore.__recent__ = [tlLegacySession]
  state.currentSessionId = 's_legacy'
  state.runs = {}
  state.currentThinking = null
  renderMessages(tlLegacySession)
  const legacyBlocks = tlBox.querySelectorAll('.thinking-block')
  const legacySummary = legacyBlocks.length > 0 ? domText(legacyBlocks[0].querySelector('summary')) : ''
  ok('老会话的过程照旧能渲染（没有步骤时退回「思考过程」）',
    legacyBlocks.length === 1 && legacySummary === '思考过程'
      && legacyBlocks[0].querySelectorAll('.tl-step').length === 0,
    'blocks=' + legacyBlocks.length + ' summary=' + legacySummary)
  ok('运行状态行已入 HTML', htmlSrc.indexOf('id="runStatus"') !== -1)
  ok('时间线步骤与状态行样式已落 CSS',
    cssSrc.indexOf('.tl-step') !== -1 && cssSrc.indexOf('.run-status') !== -1)
  state.currentSessionId = 's1'
  state.runs = { s1: true }
  applyRunState()

  /* ---- 侧边栏（2026-10-17 按参考样式重排）：新建会话做满宽胶囊，
     资料库/技能与规则改纵向行并带右侧计数 ---- */
  /* 注意：.sidebar-rail 不是死代码 —— 它是窄窗口（<900px）压成 48px 图标栏时才显示的那条，
     对应 app.js 里 railNewSession / railCreateWorkspace 两个绑定，不能删。 */
  ok('窄窗口图标栏保留，且它在 <900px 时才显示（普通宽度不占位）',
    htmlSrc.indexOf('railNewSession') !== -1
      && cssSrc.indexOf('.sidebar-rail {') !== -1
      /* 反斜杠会被外层模板字符串吃掉（\s 变 s、[\s\S] 变 [sS]），正则里一律用字符类 / [^] */
      && /@media [(]max-width: 900px[)][^]{0,400}[.]sidebar-rail [{][^]{0,60}display: flex/.test(cssSrc),
    'rail kept for <900px')
  ok('窄窗口下胶囊与两个入口都要隐藏（只剩图标栏 + 会话列表）',
    /@media [(]max-width: 900px[)][^]{0,400}[.]new-session,[^]{0,160}[.]sidebar-shortcuts/.test(cssSrc),
    'media query covers pill + shortcuts')
  /* DOM shim 是懒建空元素的，拿不到 index.html 里的 class，所以这几条只能静态断言 */
  ok('新建会话是独立的胶囊按钮（原来只有 .primary，CSS 里根本没有这条规则）',
    htmlSrc.indexOf('id="newSession" class="new-session pill"') !== -1
      && cssSrc.indexOf('.new-session.pill') !== -1
      && cssSrc.indexOf('.new-session.pill:hover') !== -1,
    'pill in html/css')
  ok('资料库 / 技能与规则改成纵向入口行（各有名称与右侧计数槽位）',
    htmlSrc.indexOf('class="sidebar-shortcut-name"') !== -1
      && htmlSrc.indexOf('class="sidebar-shortcut-meta"') !== -1
      && htmlSrc.indexOf('id="libraryCount"') !== -1
      && htmlSrc.indexOf('id="customizeCount"') !== -1)
  ok('入口不再用竖分隔线拼成分段控件（评审点名要改的那条）',
    cssSrc.indexOf('.sidebar-shortcuts::after') === -1
      && cssSrc.indexOf('.sidebar-shortcuts {') !== -1
      && cssSrc.indexOf('.sidebar-shortcut-meta') !== -1)
  ok('技能与规则显示真实的启用项数，不是写死的假数字',
    appSrc.indexOf('function updateShortcutMeta') !== -1
      && appSrc.indexOf('项启用') !== -1)
  /* 纵向节奏统一在 CSS 末尾那个块里收口：前面几处 gap 互相覆盖过，
     结果分组标题贴死第一行、品牌行下面空一大片。这里钉住关键值。 */
  const sbSpace = cssSrc.slice(cssSrc.indexOf('侧边栏纵向节奏'))
  ok('侧边栏纵向节奏收口在末尾（分组之间有间距、入口行距统一）',
    /[.]sidebar [{][^}]*gap: 10px/.test(sbSpace)
      && /[.]sidebar-scroll [{][^}]*gap: 10px/.test(sbSpace)
      && /[.]sidebar-shortcuts [{][^}]*gap: 2px/.test(sbSpace),
    'spacing block present')
  /* 品牌显示卡片已移除（用户 2026-10-17）：设置里不该再有品牌表单，
     品牌行也不该再读 settings 里的自定义值 —— 否则删掉入口后旧值永远卡在侧栏上。 */
  ok('设置里不再有「品牌显示」卡片', htmlSrc.indexOf('brand-settings') === -1
    && htmlSrc.indexOf('brandNameInput') === -1 && htmlSrc.indexOf('resetBrand') === -1)
  /* 品牌行整个去掉后，applyBrand / brandIconDraft 这些逻辑也一并删干净，
     别留读已删 DOM 的死代码。 */
  ok('品牌相关逻辑已删干净（applyBrand / brandIconDraft / settings.brandName 都不再有）',
    appSrc.indexOf('applyBrand') === -1 && appSrc.indexOf('brandIconDraft') === -1
      && appSrc.indexOf('settings.brandName') === -1)
  ok('新建会话按钮左对齐，和下面两个入口的图标列对齐成一列',
    /[.]sidebar .new-session.pill [{][^}]*justify-content: flex-start/.test(cssSrc))
  ok('页脚常驻状态块已移除（服务已连接 / 就绪 / 查看诊断），只留设置 + 断线时的重试',
    /[.]sidebar-footer .service-status,[^}]*display: none/.test(cssSrc)
      && /[.]sidebar-footer #statusLine,[^}]*display: none/.test(cssSrc)
      && /[.]sidebar-footer #statusLogs *[{][^}]*display: none/.test(cssSrc)
      && /[.]sidebar-footer .service-actions [{][^}]*display: flex/.test(cssSrc)
      && htmlSrc.indexOf('id="openSettings"') !== -1)
  ok('分组标题离自己那组内容 4px、列表行距 4px（原来全是 0，标题贴死第一行）',
    /[.]sidebar .sidebar-section [{][^}]*gap: 4px/.test(sbSpace)
      && /[.]flat-list,[^}]*gap: 4px/.test(sbSpace))
})().then(() => { harnessDone() }).catch((e) => { harnessError(e) })
`

sandbox.harnessDone = () => {
  let failed = 0
  for (const r of results) {
    if (!r.pass) failed++
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''))
  }
  console.log('')
  console.log('renderer smoke: ' + (results.length - failed) + '/' + results.length + ' checks passed, node ' + process.version)
  if (failed > 0) {
    console.error('renderer smoke: ' + failed + ' check(s) FAILED')
    process.exit(1)
  }
}

sandbox.harnessError = (e) => {
  console.error('renderer smoke: HARNESS ERROR ' + ((e && e.stack) || e))
  process.exit(1)
}

vm.runInContext(checks, context, { filename: 'renderer-smoke-checks.js' })
