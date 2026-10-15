'use strict'

/*
 * 右侧文件面板（一期）
 *
 * 能干什么：
 *   · 顶栏右上角一枚按钮，点开/收起整块面板（与左侧 .sidebar-toggle 左右镜像）
 *   · 面板左缘一条拖拽把手，拖宽度（写 --panel-width，记在 localStorage）
 *   · 面板左边资源管理器：上半是「工作区」目录树（懒加载），下半是「本会话文件」
 *   · 点文件 → 顶部开一个标签页，右边预览：代码高亮 / markdown / 图片 / PDF / 音视频
 *
 * 与 app.js 的关系：**只读、不依赖加载顺序**。
 *   面板需要的事实（当前会话 id、本会话碰过哪些文件、工作区根）全部自己问
 *   window.dsh 和 localStorage 要，不碰 app.js 的闭包（那边没有对外出口）。
 *   反过来 app.js 也不知道有这个文件 —— 唯一的接触面是 index.html 里的 <script>。
 *
 * 数据从哪来：window.dsh.fsRoots / fsTree / fsFile / fsPreviewUrl（见 web-bridge.js）。
 *   由服务端（server/file-api.js）或主进程 IPC 提供，两者都不可用时给一句人话提示。
 *
 * ⚠️ 不得引用任何外网地址（内网硬约束，check-win7-compat.js 会扫）。
 */

;(function () {
  const WIDTH_KEY = 'dsh-panel-width'
  const OPEN_KEY = 'dsh-panel-open'
  const TERMINAL_TABS_KEY = 'dsh-terminal-tabs'
  const EXPLORER_KEY = 'dsh-panel-explorer'
  const EXPLORER_WIDTH_KEY = 'dsh-panel-explorer-width'
  const FILES_KEY = 'dsh-panel-session-files'
  const SESSION_KEY = 'dsh-current-session'

  /** 超过这个大小的文件不给编辑（下载式的大文件，编辑没有意义还得整块进内存） */
  const MAX_EDIT_BYTES = 5 * 1024 * 1024
  /** 自动保存的防抖窗口：停手 350ms 就写盘。太短会一个字符一次写，
      太长（>1.5s）用户会觉得「我明明改完了怎么还没存」。 */
  const AUTOSAVE_DELAY = 350
  let terminalResizeObserver = null

  const MIN_PANEL = 240
  /** 会话区至少留这么宽 —— 面板拖到头也不许把它挤没（这就是「最大」那条边界）。
      至少保留 320px，避免文件面板把聊天正文和输入框挤成窄条。 */
  const MIN_CHAT = 320
  /** 资源管理器（文件列表）的宽度 */
  const DEFAULT_EXPLORER = 210
  const MIN_EXPLORER = 120
  /** 预览区至少留这么宽 —— 文件列表拖到头也不许把它挤没 */
  const MIN_PREVIEW = 160
  /** 默认宽度 = 窗口宽 × 0.38，再夹到这个区间（见 defaultWidth） */
  const DEFAULT_PANEL_MIN = 460
  const DEFAULT_PANEL_MAX = 720

  /** 工具名 → 参数里那个「代表性路径」字段。本会话文件就靠它攒出来。 */
  const TOOL_PATH_FIELD = {
    list_dir: 'path',
    read_file: 'path',
    write_file: 'path',
    edit_file: 'path',
    search_files: 'path'
  }
  /** 只有这几个工具的参数路径**一定是文件**；list_dir / search_files 收的是目录，别记进「本会话文件」。 */
  const FILE_TOOLS = { read_file: true, write_file: true, edit_file: true }

  const panel = {
    open: false,
    explorer: true,
    /* 0 = 还没写过，init 的 applyExplorer 必然真正落一次 CSS 变量
       （applyExplorer 值没变会跳过，初值不能直接等于默认宽） */
    explorerWidth: 0,
    width: 0,
    /* 终端（三期）：会话在服务端常驻（关面板不杀），这里存视图状态 + 客户端缓冲。
       xterm = 真·终端前端（vendor/xterm，VS Code 同款内核）；line/promptDrawn 是渲染层
       行编辑状态 —— 管道 shell 没有 tty，回显/退格/历史都由渲染层自己做。 */
    terminal: {
      open: false,
      tabId: '',
      title: '',
      picker: true,
      sid: '',
      cwd: '',
      buffer: '',
      history: [],
      histIndex: -1,
      unsubscribe: null,
      busy: false,
      line: '',
      promptDrawn: false,
      replayApplied: '',
      host: null,
      xterm: null,
      fit: null,
      height: 0,
      cwdOptions: [],
      outputEndsNL: true,
      scanBuffer: '',
      idlePromptTimer: null
    },
    terminalTabs: [],
    activeTerminalId: '',
    /* 终端**视图**的开关，必须和标签自己的 open 分开 ——
       标签从 localStorage 恢复时 open 默认 true，两处共用同一个字段的话，
       重启软件后点终端图标等于 setTerminalMode(false)，终端反而被关掉（用户报的「重开不对」） */
    terminalView: false,
    markdownPreview: false,
    markdownAutoExplorer: false,
    context: null,
    contextKey: '',
    contextRevision: 0,
    roots: [],
    projectName: '',
    loading: false,
    error: '',
    /* 树：path -> entries；展开态记在 expanded 里，收起来不丢缓存 */
    children: {},
    expanded: {},
    pending: {},
    sessionFiles: [],
    sessionId: '',
    tabs: [],
    active: '',
    /* 编辑器（四期）：只服一个文件，换文件/关标签就退出。
       手动同步的那几个字段是「写回时要知道」的全部事实 —— 编码不对会毁掉 GBK 文件，
       换行不对会让整个文件的 diff 变成「全删全加」，mtime 不对则会静默盖掉别人刚写的内容。 */
    editor: {
      path: '',
      active: false,
      text: '',
      loaded: '',
      encoding: 'utf-8',
      eol: '\n',
      mtime: 0,
      size: 0,
      dirty: false,
      saving: false,
      conflict: false,
      /* 起名带 Node 后缀，别和上面那些「值」混起来 —— 这两个是 DOM 引用 */
      taNode: null,
      statusNode: null,
      timer: null
    }
  }

  /** 路径 → kind（服务端给的；树里点过的、预览过的都记下来，省一次 /fs/file） */
  const kindCache = {}

  /* ------------------------------------------------------------ 小工具 */

  const not = (value) => value ? false : true
  const byId = (id) => document.getElementById(id)

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key)
      if (not(raw)) return fallback
      const parsed = JSON.parse(raw)
      return parsed === null || parsed === undefined ? fallback : parsed
    } catch (error) {
      return fallback
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      /* 存储满了就算了，别让面板崩 */
    }
  }

  function fmtSize(bytes) {
    const size = Number(bytes) || 0
    if (size < 1024) return size + ' B'
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
    if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
    return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  function fmtTime(ms) {
    const value = Number(ms) || 0
    if (not(value)) return ''
    const date = new Date(value)
    const pad = (n) => (n < 10 ? '0' + n : String(n))
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }

  function dirOf(target) {
    const text = String(target || '')
    const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
    return cut > 0 ? text.slice(0, cut) : text
  }

  function baseOf(target) {
    const text = String(target || '')
    const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
    return cut >= 0 ? text.slice(cut + 1) : text
  }

  function extOf(name) {
    const text = String(name || '').toLowerCase()
    if (text === 'dockerfile') return '.dockerfile'
    if (text === 'makefile') return '.makefile'
    const cut = text.lastIndexOf('.')
    return cut > 0 ? text.slice(cut) : ''
  }

  /**
   * 字节 → 文本。先严格按 UTF-8 解，解不动再退 GBK。
   *
   * 为什么在渲染层做：Node 16.17.1 是 small-icu，`new TextDecoder('gbk')` 直接抛；
   * Chromium 有完整 ICU，能解。服务端因此只吐字节（见 server/file-api.js 顶部注释）。
   * Win7 上 GBK 文件满地都是，这一层必须有。
   */
  function decodeBytes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    /* BOM 优先 */
    if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
      return { text: utf8(view.subarray(3)), encoding: 'utf-8-bom' }
    }
    if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
      return { text: decodeWith(view, 'utf-16le') || '', encoding: 'utf-16le' }
    }
    if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
      return { text: decodeWith(view, 'utf-16be') || '', encoding: 'utf-16be' }
    }
    /* 严格 UTF-8：解不动就说明不是 UTF-8（多半是 GBK） */
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), encoding: 'utf-8' }
    } catch (error) {
      const gbk = decodeWith(view, 'gbk') || decodeWith(view, 'gb18030')
      if (gbk !== null) return { text: gbk, encoding: 'gbk' }
      return { text: utf8(view), encoding: 'utf-8-lossy' }
    }
  }

  function utf8(view) {
    return new TextDecoder('utf-8').decode(view)
  }

  /** 解不出来（引擎没有这个编码表）返回 null，让调用方继续降级 */
  function decodeWith(view, encoding) {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(view)
    } catch (error) {
      return null
    }
  }

  /* ------------------------------------------------------------ 文本 → 字节
     保存必须**按原编码写回**。这一层看着啰嗦，但少写一段的后果很实在：
     GBK 文件一保存就变 UTF-8，Win7 上那些按 GBK 读它的老工具（还有 cmd 的 type）
     全成乱码 —— 这是编辑器最经典的坑，而且用户往往几天后才发现。 */

  /** UTF-8，按需带 BOM（原来是 bom 的要留着，不然某些 Windows 工具会认错编码） */
  function encodeUtf8(text, bom) {
    const body = new TextEncoder().encode(text)
    if (not(bom)) return body
    const out = new Uint8Array(body.length + 3)
    out[0] = 0xef
    out[1] = 0xbb
    out[2] = 0xbf
    out.set(body, 3)
    return out
  }

  /** UTF-16：TextEncoder 只认 UTF-8，只能按 code unit 手工拼（decodeBytes 认过的那两种都补回 BOM） */
  function encodeUtf16(text, little) {
    const out = new Uint8Array(text.length * 2 + 2)
    out[0] = little ? 0xff : 0xfe
    out[1] = little ? 0xfe : 0xff
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      out[2 + index * 2] = little ? (code & 0xff) : (code >> 8)
      out[3 + index * 2] = little ? (code >> 8) : (code & 0xff)
    }
    return out
  }

  /** GBK 反向表（字符 → 双字节），懒建，见 gbkReverse 的说明 */
  let gbkMap = null

  /**
   * 为什么要自己建这张表：Chromium 的 TextEncoder 只支持 UTF-8，
   * TextDecoder 能解 GBK 但**没有对应的编码器**。所以反过来做 ——
   * 把 GBK 的全部双字节组合（首字节 0x81-0xFE × 尾字节 0x40-0xFE，跳掉 0x7F）
   * 逐个 decode 一遍，倒着记下「这个字符该编成哪两个字节」。约 2.4 万次解码，
   * 只在**第一次保存 GBK 文件**时跑（懒建），实测个位数毫秒。
   */
  function gbkReverse() {
    if (gbkMap) return gbkMap
    const map = new Map()
    const decoder = new TextDecoder('gbk')
    const pair = new Uint8Array(2)
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) {
        if (trail === 0x7f) continue
        pair[0] = lead
        pair[1] = trail
        const char = decoder.decode(pair)
        /* 一个合法双字节应当解出恰好一个字符；多个字符说明这对字节被拆成了
           「一个半角 + 一个替换符」，那种组合不能反向使用 */
        if (char.length !== 1 || char === '\ufffd') continue
        if (not(map.has(char))) map.set(char, [lead, trail])
      }
    }
    gbkMap = map
    return map
  }

  /**
   * 文本 → GBK 字节。ASCII 直通；欧元号那一类单字节补在前面；
   * 表里没有的字符（GBK 表示不了的，比如 emoji）直接抛 ——
   * 宁可不保存，也不能偷偷写个问号把用户的内容吃掉。
   */
  function encodeGbk(text) {
    const map = gbkReverse()
    const out = new Uint8Array(text.length * 2)
    let size = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code < 0x80) {
        out[size] = code
        size += 1
        continue
      }
      const char = text.charAt(index)
      if (char === '\u20ac') {
        out[size] = 0x80
        size += 1
        continue
      }
      const bytes = map.get(char)
      if (not(bytes)) throw new Error('GBK_UNENCODABLE: ' + char)
      out[size] = bytes[0]
      out[size + 1] = bytes[1]
      size += 2
    }
    return out.slice(0, size)
  }

  /** 文本 → 字节。encoding 就用 decodeBytes 给的那个名字，一一对应。 */
  function encodeText(text, encoding) {
    const kind = String(encoding || 'utf-8')
    if (kind === 'utf-16le') return encodeUtf16(text, true)
    if (kind === 'utf-16be') return encodeUtf16(text, false)
    if (kind === 'gbk') return encodeGbk(text)
    return encodeUtf8(text, kind === 'utf-8-bom')
  }

  /**
   * 换行风格探测 + 还原。
   * <textarea> 的 value **一定是 \n**（HTML 规范这么定的，Chromium 也照做），
   * 所以从编辑框拿回来的文本已经没有 \r 了。不还原的话，一个 CRLF 的 Windows 文件
   * 保存后整个变 LF —— git diff 看着像「每一行都改了」。
   */
  function detectEol(text) {
    return String(text || '').indexOf('\r\n') !== -1 ? '\r\n' : '\n'
  }

  /** 先把已有的 \r\n / \r 归一成 \n，再展开成目标风格（直接 replace 会得到 \r\r\n） */
  function applyEol(text, eol) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
  }

  /** 字节 → base64。分块拼 —— 对 5MB 的数组一次 apply 会爆调用栈。 */
  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const chunk = 0x8000
    let binary = ''
    for (let index = 0; index < view.length; index += chunk) {
      binary += String.fromCharCode.apply(null, view.subarray(index, index + chunk))
    }
    return btoa(binary)
  }

  /** 这个文件能不能编辑：文本、且没大到离谱 */
  function canEdit(meta) {
    if (not(meta)) return false
    if (meta.isText !== true) return false
    return Number(meta.size || 0) <= MAX_EDIT_BYTES
  }

  /* ------------------------------------------------------------ 后端接口 */

  function dsh() {
    return window.dsh || null
  }

  function hasApi() {
    const api = dsh()
    return Boolean(api && typeof api.fsRoots === 'function' && typeof api.fsTree === 'function')
  }

  async function readText(target) {
    const api = dsh()
    if (not(api)) throw new Error('NO_FS_API')
    /* HTTP 路径：直接在渲染层拿字节（能解 GBK） */
    const url = typeof api.fsRawUrl === 'function' ? api.fsRawUrl(target) : ''
    if (url) {
      const response = await fetch(url)
      if (not(response.ok)) throw new Error('HTTP_' + response.status)
      return decodeBytes(new Uint8Array(await response.arrayBuffer()))
    }
    /* IPC 路径：主进程解好再给我（开发态，只保证 UTF-8） */
    if (typeof api.fsText === 'function') {
      return { text: await api.fsText(target), encoding: 'utf-8' }
    }
    throw new Error('NO_FS_API')
  }

  /* ------------------------------------------------------------ 编辑 + 实时保存

     用户 2026-09-19 定的交互：「可读文件，支持编辑保存为实时保存」。
     契约：
       · 文本文件打开即编辑，工具条只显示编码、换行和保存状态
       · 打字停 350ms 自动写盘；切标签、关标签、关面板、Ctrl+S 都立刻写
       · 写回时按**原编码 + 原换行**编回去（见 encodeText / applyEol）
       · 期间文件被外部改过（mtime 变了）→ 不覆盖，标黄提示，要人点「强制保存」
     编解码那一层在文件上半部分（跟着 decodeBytes 走），这里只管交互与落盘。 */

  function timeNow() {
    const now = new Date()
    const pad = (value) => (value < 10 ? '0' : '') + value
    return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())
  }

  function editorIsFor(target) {
    return panel.editor.active === true && panel.editor.path === target
  }

  function editorMessage(text, tone) {
    const node = panel.editor.statusNode || byId('editorStatus')
    if (node) {
      node.textContent = String(text || '')
      node.className = 'editor-status' + (tone ? ' ' + tone : '')
    }
    const ed = panel.editor
    ed.statusText = String(text || '')
    const tab = panel.tabs.find((item) => item.path === ed.path)
    if (tab) {
      tab.saveState = ed.conflict ? 'conflict' : (tone === 'error' ? 'error' : (ed.statusText.indexOf('保存中') === 0 ? 'saving' : (ed.dirty ? 'dirty' : 'saved')))
      tab.saveMessage = ed.statusText
      renderTabs()
    }
  }

  /** 一句人话提示。编辑态写进状态行；预览态也复用它，免得再造一套提示 */
  function previewNote(text, tone) {
    const node = byId('editorStatus')
    if (node) {
      node.textContent = String(text || '')
      node.className = 'editor-status' + (tone ? ' ' + tone : '')
      return
    }
    const host = byId('panelPreview')
    if (not(host)) return
    const bar = document.createElement('div')
    bar.className = 'preview-bar'
    const note = document.createElement('span')
    note.className = 'editor-status' + (tone ? ' ' + tone : '')
    note.textContent = String(text || '')
    bar.appendChild(note)
    host.insertBefore(bar, host.firstChild)
  }

  async function startEdit(target) {
    const api = dsh()
    if (not(api) || typeof api.fsWrite !== 'function') {
      previewNote('当前环境不支持写文件，只能看。')
      return
    }
    let meta = null
    let decoded = null
    try {
      meta = await api.fsFile(target)
      decoded = await readText(target)
    } catch (error) {
      meta = null
    }
    if (panel.active !== target) return
    if (not(meta) || not(decoded)) {
      previewNote('这个文件打不开，没法编辑。')
      return
    }
    if (not(canEdit(meta))) {
      previewNote(Number(meta.size || 0) > MAX_EDIT_BYTES
        ? '文件超过 ' + fmtSize(MAX_EDIT_BYTES) + '，不给编辑。'
        : '这不是文本文件，没法编辑。')
      return
    }
    activateEditor(target, meta, decoded)
    renderTabs()
    await renderPreview()
  }

  function activateEditor(target, meta, decoded) {
    const ed = panel.editor
    ed.path = target
    ed.active = true
    ed.text = decoded.text
    ed.loaded = decoded.text
    ed.encoding = decoded.encoding
    ed.kind = String(meta.kind || 'text')
    /* 换行风格在这里定下来，往后每次保存都按它编回去 */
    ed.eol = detectEol(decoded.text)
    ed.mtime = Number(meta.mtime || 0)
    ed.size = Number(meta.size || 0)
    ed.dirty = false
    ed.conflict = false
    ed.saving = false
  }

  /** 内部释放入口：仅在成功保存后放开编辑状态。 */
  async function stopEdit() {
    await flushSave()
    if (panel.editor.dirty) return
    const ed = panel.editor
    ed.active = false
    ed.path = ''
    ed.taNode = null
    ed.statusNode = null
    renderTabs()
    renderPreview()
  }

  function scheduleSave() {
    const ed = panel.editor
    if (ed.timer) clearTimeout(ed.timer)
    ed.timer = setTimeout(() => {
      ed.timer = null
      saveNow(false)
    }, AUTOSAVE_DELAY)
  }

  /** 立刻写盘（切标签 / 关面板 / Ctrl+S）。有冲突时**不自动重试** —— 那得人拍板。 */
  async function flushSave() {
    const ed = panel.editor
    if (ed.timer) {
      clearTimeout(ed.timer)
      ed.timer = null
    }
    if (not(ed.active) || not(ed.dirty) || ed.conflict) return
    await saveNow(false)
  }

  async function forceSave() {
    const ed = panel.editor
    if (ed.timer) {
      clearTimeout(ed.timer)
      ed.timer = null
    }
    if (not(ed.active)) return
    ed.conflict = false
    await saveNow(true)
  }

  async function saveNow(force) {
    const ed = panel.editor
    const target = ed.path
    if (ed.savePromise) {
      await ed.savePromise
      if (ed.path === target && ed.dirty && !ed.conflict) return saveNow(force)
      return
    }
    const task = performSave(force)
    ed.savePromise = task
    try { await task } finally {
      if (ed.savePromise === task) ed.savePromise = null
    }
  }

  async function performSave(force) {
    const ed = panel.editor
    if (not(ed.active) || not(ed.path) || ed.saving || not(ed.dirty)) return
    const api = dsh()
    if (not(api) || typeof api.fsWrite !== 'function') return
    const target = ed.path
    const text = ed.text

    let bytes = null
    try {
      bytes = encodeText(applyEol(text, ed.eol), ed.encoding)
    } catch (error) {
      const message = String((error && error.message) || error)
      /* GBK 存不下的字符（emoji 之类）：宁可不存，也不能写个 '?' 把内容吃掉 */
      editorMessage(message.indexOf('GBK_UNENCODABLE') === 0
        ? '有 GBK 存不下的字符（' + message.replace('GBK_UNENCODABLE: ', '') + '），没保存。'
        : '编码失败：' + message, 'error')
      return
    }

    ed.saving = true
    editorMessage('保存中…', '')
    try {
      const info = await api.fsWrite(target, bytesToBase64(bytes), force ? 0 : ed.mtime)
      /* 保存期间用户可能已经切走了 —— 只认还停在这个文件上那次 */
      if (panel.editor.path !== target) return
      ed.loaded = text
      ed.dirty = ed.text !== text
      ed.mtime = Number((info && info.mtime) || 0)
      ed.size = Number((info && info.size) || ed.size)
      ed.conflict = false
      editorMessage(ed.dirty ? '编辑中…' : '已保存 ' + timeNow(), '')
      renderTabs()
    } catch (error) {
      const message = String((error && error.message) || error)
      /* ⚠️ 必须用「包含」而不是「开头是」：走 HTTP 时 message 就是 `MTIME_CONFLICT: /path`，
         但走 IPC 时 Electron 会包一层 —— `Error invoking remote method 'fs:write': Error: MTIME_CONFLICT: /path`。
         用 indexOf(...) === 0 判断的话，开发态（HTTP）能过、打包后（IPC）静默失效。 */
      if (message.indexOf('MTIME_CONFLICT') !== -1) {
        ed.conflict = true
        editorMessage('文件已被外部修改，没敢覆盖 —— 点「强制保存」覆盖它', 'warn')
      } else {
        editorMessage('保存失败：' + message, 'error')
      }
    } finally {
      ed.saving = false
    }
  }

  function onEditorInput() {
    const ed = panel.editor
    if (not(ed.taNode)) return
    ed.text = ed.taNode.value
    if (ed.updateHighlight) ed.updateHighlight()
    if (ed.updateMarkdownPreview) ed.updateMarkdownPreview()
    /* 输入法组字、按方向键也会触发 input —— 内容真变了才算脏 */
    const dirty = ed.text !== ed.loaded
    if (dirty !== ed.dirty) {
      ed.dirty = dirty
      if (not(dirty)) ed.conflict = false
      renderTabs()
    }
    if (not(dirty)) {
      editorMessage('已保存 ' + timeNow(), '')
      return
    }
    if (ed.conflict) {
      editorMessage('文件已被外部修改，没敢覆盖 —— 点「强制保存」覆盖它', 'warn')
      return
    }
    editorMessage('编辑中…', '')
    scheduleSave()
  }

  function onEditorKeydown(event) {
    if (not(event)) return
    const key = String(event.key || '')
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 's') {
      event.preventDefault()
      if (panel.editor.conflict) forceSave()
      else flushSave()
      return
    }
    /* Tab 打两格空格 —— 这是个代码编辑器，按 Tab 跳焦点等于没法用 */
    if (key === 'Tab') {
      event.preventDefault()
      const ta = panel.editor.taNode
      if (not(ta)) return
      const start = Number(ta.selectionStart) || 0
      const end = ta.selectionEnd === undefined ? start : Number(ta.selectionEnd)
      const value = String(ta.value || '')
      ta.value = value.slice(0, start) + '  ' + value.slice(end)
      ta.selectionStart = start + 2
      ta.selectionEnd = start + 2
      onEditorInput()
    }
  }

  /** 编辑态那枚 textarea + 挂上监听。返回节点，由 renderPreview 决定挂哪儿。 */
  function isMarkdownFile(target) {
    return /\.(?:md|markdown|mdown)$/i.test(String(target || '')) || kindCache[target] === 'markdown'
  }

  function syncMarkdownPreviewButton() {
    const button = byId('markdownPreviewToggle')
    if (!button) return
    const visible = isMarkdownFile(panel.active)
    button.classList.toggle('hidden', !visible)
    button.classList.toggle('active', visible && panel.markdownPreview)
    button.setAttribute('aria-pressed', visible && panel.markdownPreview ? 'true' : 'false')
    const label = panel.markdownPreview ? '关闭 Markdown 侧边预览' : '打开 Markdown 侧边预览'
    button.title = label
    button.setAttribute('aria-label', label)
  }

  function markdownSplit(source) {
    const split = document.createElement('div')
    split.className = 'markdown-split'
    split.appendChild(source)
    const divider = document.createElement('div')
    divider.className = 'markdown-divider'
    divider.tabIndex = 0
    divider.setAttribute('role', 'separator')
    divider.setAttribute('aria-label', '调整 Markdown 源码与预览宽度')
    divider.setAttribute('aria-orientation', 'vertical')
    divider.setAttribute('aria-valuemin', '10')
    divider.setAttribute('aria-valuemax', '90')
    split.appendChild(divider)
    const preview = document.createElement('section')
    preview.className = 'markdown-side-preview preview-markdown'
    preview.setAttribute('aria-label', 'Markdown 预览')
    split.appendChild(preview)
    let ratio = Number(localStorage.getItem('dsh-markdown-split')) || 50
    const applyRatio = (value, persist) => {
      ratio = Math.max(10, Math.min(90, value))
      split.style.setProperty('--markdown-source-fr', ratio + 'fr')
      split.style.setProperty('--markdown-preview-fr', (100 - ratio) + 'fr')
      divider.setAttribute('aria-valuenow', String(Math.round(ratio)))
      if (persist) localStorage.setItem('dsh-markdown-split', String(ratio))
    }
    applyRatio(ratio, false)
    let dragging = false
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      dragging = true
      split.classList.add('is-resizing')
      divider.setPointerCapture(event.pointerId)
    })
    divider.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const rect = split.getBoundingClientRect()
      if (rect.width > 6) applyRatio((event.clientX - rect.left) / rect.width * 100, false)
    })
    const endDrag = () => {
      if (!dragging) return
      dragging = false
      split.classList.remove('is-resizing')
      applyRatio(ratio, true)
    }
    divider.addEventListener('pointerup', endDrag)
    divider.addEventListener('pointercancel', endDrag)
    divider.addEventListener('lostpointercapture', endDrag)
    divider.addEventListener('keydown', (event) => {
      let next = ratio
      if (event.key === 'ArrowLeft') next -= 5
      else if (event.key === 'ArrowRight') next += 5
      else if (event.key === 'Home') next = 10
      else if (event.key === 'End') next = 90
      else return
      event.preventDefault()
      applyRatio(next, true)
    })
    const ed = panel.editor
    const target = ed.path
    let scheduled = false
    const paint = () => {
      scheduled = false
      if (panel.editor.path !== target || !split.isConnected) return
      if (typeof window.renderMarkdown === 'function') {
        preview.innerHTML = window.renderMarkdown(ed.text)
        if (window.highlightAll) window.highlightAll(preview)
      } else preview.textContent = ed.text
    }
    ed.updateMarkdownPreview = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(paint)
    }
    ed.updateMarkdownPreview()
    return split
  }

  function editorBody() {
    const ed = panel.editor
    ed.updateMarkdownPreview = null
    const wrapper = document.createElement('div')
    wrapper.className = 'code-editor'
    const highlight = document.createElement('pre')
    highlight.className = 'editor-highlight'
    highlight.setAttribute('aria-hidden', 'true')
    const code = document.createElement('code')
    highlight.appendChild(code)
    wrapper.appendChild(highlight)
    const ta = document.createElement('textarea')
    ta.id = 'panelEditor'
    ta.setAttribute('aria-label', '文件编辑器：' + baseOf(ed.path))
    ta.className = 'preview-editor'
    ta.spellcheck = false
    ta.setAttribute('wrap', 'off')
    ta.value = ed.text
    const syncScroll = () => {
      highlight.scrollTop = ta.scrollTop
      highlight.scrollLeft = ta.scrollLeft
    }
    let scheduled = false
    const paint = () => {
      scheduled = false
      if (panel.editor.taNode !== ta) return
      const text = ta.value + (ta.value.endsWith('\n') ? ' ' : '')
      if (ed.kind !== 'text' && typeof window.highlightCode === 'function') code.innerHTML = window.highlightCode(text, extOf(baseOf(ed.path)))
      else code.textContent = text
      syncScroll()
    }
    ed.updateHighlight = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(paint)
    }
    ta.addEventListener('input', onEditorInput)
    ta.addEventListener('scroll', syncScroll)
    ta.addEventListener('blur', () => { flushSave() })
    ta.addEventListener('keydown', onEditorKeydown)
    wrapper.appendChild(ta)
    const status = document.createElement('span')
    status.className = 'editor-status'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    wrapper.appendChild(status)
    ed.taNode = ta
    ed.statusNode = status
    paint()
    editorMessage(ed.conflict
      ? '文件已被外部修改，尚未覆盖'
      : (ed.dirty ? '编辑中…' : '已保存'), ed.conflict ? 'warn' : '')
    return wrapper
  }

  /**
   * 预览区顶上那条工具条。
   * 文本：编码/换行 + 自动保存状态 + （冲突时）强制保存
   * 其他文件：大小 + 状态
   */
  function previewBar(meta, editing) {
    const bar = document.createElement('div')
    bar.className = 'preview-bar'

    const label = document.createElement('span')
    label.className = 'preview-bar-label'
    label.textContent = editing
      ? panel.editor.encoding + ' · ' + (panel.editor.eol === '\r\n' ? 'CRLF' : 'LF')
      : (meta ? fmtSize(meta.size) : '')
    bar.appendChild(label)

    const status = document.createElement('span')
    status.id = 'editorStatus'
    status.className = 'editor-status'
    bar.appendChild(status)

    return bar
  }

  /* ------------------------------------------------------------ 面板开合 / 宽度 */

  /**
   * 默认宽度按窗口算，不写死。
   * 写死 420 的教训：面板里还有一条 210px 的资源管理器，留给预览只剩 209px ——
   * 代码要横向拖、PDF 缩到看不清。取窗口的 38%，再夹到 [460, 720]。
   */
  function defaultWidth(innerWidth) {
    const viewport = Number(innerWidth) || 1280
    return Math.max(DEFAULT_PANEL_MIN, Math.min(DEFAULT_PANEL_MAX, Math.round(viewport * 0.38)))
  }

  /**
   * 会话区的左沿 = 面板左沿能推到的最左边。
   * 不再写死一个上限（以前 MAX_PANEL=760，宽窗口上一拖就卡住，用户骂「不能无限拖」）——
   * 边界就是「会话区左沿 − 会话区下限」，拖到那儿自然停。
   * 侧边栏折叠 / 「只看文件」模式下会话区不显示，返回 0（面板可一路推到窗口左沿）。
   */
  function chatLeftEdge() {
    try {
      const main = document.querySelector('.main')
      if (not(main)) return 260
      if (getComputedStyle(main).display === 'none') return 0
      return Math.max(0, Math.round(main.getBoundingClientRect().left))
    } catch (error) {
      return 260
    }
  }

  /**
   * 夹宽度。上限只由边界决定：视口 − 会话区左沿 − 会话区下限。
   * 第三个参数留给冒烟直接喂数（DOM shim 里量不了 .main 的位置）。
   */
  function clampWidth(width, innerWidth, chatLeft) {
    const viewport = Number(innerWidth) || window.innerWidth || 1280
    const left = chatLeft === undefined ? chatLeftEdge() : (Number(chatLeft) || 0)
    const ceiling = Math.max(MIN_PANEL, viewport - left - MIN_CHAT)
    const floor = Math.min(MIN_PANEL, ceiling)
    return Math.max(floor, Math.min(ceiling, Math.round(width)))
  }

  /** 文件列表的宽度：夹在 [140, 面板宽 − 预览区下限]，同样没有写死的上限 */
  function clampExplorer(width, panelWidth) {
    const total = Number(panelWidth) || panel.width || 520
    const ceiling = Math.max(MIN_EXPLORER, total - MIN_PREVIEW)
    const floor = Math.min(MIN_EXPLORER, ceiling)
    return Math.max(floor, Math.min(ceiling, Math.round(width)))
  }

  /**
   * 写宽度。
   * ⚠️ 只能写 CSS 变量、不能直接写 style.width —— 面板宽度是 grid 的第三列
   *    （见 style.css 的 #app.panel-open），写宽度不生效。
   * ⚠️ 第二个参数 = 拖拽**开始时**量好的会话区左沿。别在 mousemove 里现量：
   *    chatLeftEdge() 要 getComputedStyle + getBoundingClientRect，
   *    写完样式又读布局 = 每帧强制重排，拖起来一顿一顿的（用户骂过「拖动太卡」）。
   */
  function applyWidth(width, chatLeft) {
    panel.width = clampWidth(width, window.innerWidth, chatLeft)
    document.documentElement.style.setProperty('--panel-width', panel.width + 'px')
    /* 面板变窄可能把文件列表顶出边界，跟着夹一次 */
    applyExplorer(panel.explorerWidth)
  }

  /** 文件列表宽度同样只走 CSS 变量（它是 .panel-explorer 的 flex-basis）。
   *  值没变就不写 —— applyWidth 每次拖动都连带调它，重复 setProperty
   *  会白白发一次样式失效，拖起来更卡。 */
  function applyExplorer(width) {
    const next = clampExplorer(width, panel.width)
    if (next === panel.explorerWidth) return
    panel.explorerWidth = next
    document.documentElement.style.setProperty('--explorer-width', next + 'px')
  }

  let projectPanelOpen = localStorage.getItem(OPEN_KEY) === '1'

  function setContext(value) {
    const context = value || {}
    const key = JSON.stringify([context.scope, context.projectId || '', context.projectName || '', context.scope === 'recent' ? context.sessionId || '' : '', context.folders || [], context.workspacePath || ''])
    const changed = key !== panel.contextKey
    if (changed && panel.context && panel.context.scope === 'project') projectPanelOpen = panel.open
    panel.context = context
    const previousSession = panel.sessionId
    refreshSessionContext()
    if (!changed) {
      if (previousSession !== panel.sessionId) renderTree()
      return
    }
    panel.contextKey = key
    panel.contextRevision += 1
    panel.roots = []
    panel.children = {}
    panel.expanded = {}
    panel.pending = {}
    panel.loading = false
    panel.error = ''
    panel.projectName = context.scope === 'project' ? context.projectName || '' : ''
    const title = byId('panelTitle')
    if (title) title.textContent = panel.projectName || '会话文件'
    clearKindCache()
    renderTree()
    if (context.scope !== 'project') setOpen(false)
    else setOpen(projectPanelOpen)
  }

  function setOpen(open) {
    const app = byId('app')
    if (not(app)) return
    /* 收起面板 = 用户先收工了：编辑器里没落盘的那一段先写掉 */
    if (not(open)) flushSave()
    panel.open = Boolean(open)
    if (panel.context && panel.context.scope === 'project') projectPanelOpen = panel.open
    app.classList.toggle('panel-open', panel.open)
    const panelEl = byId('filePanel')
    if (panelEl) panelEl.setAttribute('aria-hidden', panel.open ? 'false' : 'true')
    const toggle = byId('panelToggle')
    if (toggle) {
      toggle.title = panel.open ? '收起文件面板' : '展开文件面板'
      toggle.classList.toggle('active', panel.open)
    }
    localStorage.setItem(OPEN_KEY, panel.open ? '1' : '0')
    if (panel.open) {
      /* 关着的时候窗口可能变过尺寸，重夹一次（顺带把文件列表也夹了） */
      applyWidth(panel.width)
      refreshSessionContext()
      if (not(panel.roots.length)) loadRoots()
      else renderTree()
      if (not(panel.tabs.length)) renderPreview()
      return
    }
    /* 面板都收起来了，「只看文件」那套自然也不该留着 */
    setChatHidden(false)
  }

  function toggleOpen() {
    setOpen(not(panel.open))
  }

  function setExplorer(visible) {
    panel.explorer = Boolean(visible)
    const panelEl = byId('filePanel')
    if (panelEl) panelEl.classList.toggle('panel-explorer-hidden', not(panel.explorer))
    const button = byId('panelExplorerToggle')
    if (button) button.classList.toggle('panel-explorer-toggle-on', panel.explorer)
    localStorage.setItem(EXPLORER_KEY, panel.explorer ? '1' : '0')
  }

  /** 两条纵向拖拽把手共用的绑定（面板左缘 / 文件列表右缘）。
   *  mousemove 只记下最新事件，真正 apply 放到 requestAnimationFrame：
   *  鼠标事件频率经常超过刷新率（125Hz 鼠标很常见），一帧里 setProperty
   *  好几次 = 白白多排几遍整列 grid（第三列一动 .main 整个跟着重排，
   *  用户骂过「外面这条拖动很卡，里面那条却丝滑」——里面那条只动面板内部，重排范围小）。
   *  mouseup 时把最后一帧同步 flush 掉，松手位置必定落盘。 */
  function bindColResize(handle, hooks) {
    if (not(handle)) return
    let startX = 0
    let startWidth = 0
    /** 按下那一刻量好的会话区左沿 —— 拖动全程复用，绝不在 mousemove 里读布局 */
    let startLeft = 0
    /** rAF 节流：最新一次 mousemove；0 = 当前没有排在帧里的 apply */
    let pendingEvent = null
    let frame = 0
    const flush = () => {
      frame = 0
      if (pendingEvent) {
        hooks.onMove(startX, startWidth, startLeft, pendingEvent)
        pendingEvent = null
      }
    }
    const onMove = (event) => {
      pendingEvent = event
      if (not(frame)) frame = requestAnimationFrame(flush)
    }
    const onUp = () => {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      flush()
      document.body.classList.remove('resizing')
      if (hooks.bodyClass) document.body.classList.remove(hooks.bodyClass)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (hooks.onEnd) hooks.onEnd()
    }
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      startX = event.clientX
      startWidth = hooks.startWidth()
      if (hooks.onStart) startLeft = hooks.onStart()
      document.body.classList.add('resizing')
      /* 各自的 body 类：高亮只亮自己手上那条（共用一个类的话两条把手会一起亮） */
      if (hooks.bodyClass) document.body.classList.add(hooks.bodyClass)
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
    /* 双击把手 = 回到默认宽度 */
    handle.addEventListener('dblclick', () => {
      hooks.onDbl()
      if (hooks.onEnd) hooks.onEnd()
    })
  }

  function setupResize() {
    /* 面板左缘：往左拖 = 变宽 */
    bindColResize(byId('panelResize'), {
      bodyClass: 'resizing-panel',
      startWidth: () => panel.width,
      onStart: () => chatLeftEdge(),
      onMove: (startX, startWidth, startLeft, event) =>
        applyWidth(startWidth + (startX - event.clientX), startLeft),
      onEnd: () => localStorage.setItem(WIDTH_KEY, String(panel.width)),
      onDbl: () => applyWidth(defaultWidth(window.innerWidth))
    })
    /* 文件列表右缘：往右拖 = 变宽（它的边界只跟面板宽有关，不用量布局） */
    bindColResize(byId('explorerResize'), {
      bodyClass: 'resizing-explorer',
      startWidth: () => panel.explorerWidth,
      onMove: (startX, startWidth, startLeft, event) =>
        applyExplorer(startWidth + (event.clientX - startX)),
      onEnd: () => localStorage.setItem(EXPLORER_WIDTH_KEY, String(panel.explorerWidth)),
      onDbl: () => applyExplorer(DEFAULT_EXPLORER)
    })
  }

  /* ------------------------------------------------------------ 目录树 */

  function treeNode(path, kind, name, extra) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'tree-row'
    row.setAttribute('data-path', path)
    row.setAttribute('data-dir', kind === 'dir' ? '1' : '0')
    row.style.paddingLeft = (6 + (extra && extra.depth ? extra.depth * 12 : 0)) + 'px'
    row.title = path

    const caret = document.createElement('span')
    caret.className = 'tree-caret'
    if (kind === 'dir') {
      const open = panel.expanded[path] === true
      if (open) caret.classList.add('open')
      const icon = document.createElement('span')
      icon.className = 'icon'
      icon.innerHTML = window.renderIcon('chevron-right')
      caret.appendChild(icon)
    } else {
      caret.classList.add('leaf')
    }
    row.appendChild(caret)

    const glyph = document.createElement('span')
    glyph.className = 'tree-glyph kind-' + (kind === 'dir' ? 'dir' : (extra && extra.kind) || 'text')
    const glyphIcon = document.createElement('span')
    glyphIcon.className = 'icon'
    glyphIcon.innerHTML = window.renderIcon(kind === 'dir' ? 'folder' : 'file')
    glyph.appendChild(glyphIcon)
    row.appendChild(glyph)

    const label = document.createElement('span')
    label.className = 'tree-label'
    label.textContent = name
    row.appendChild(label)

    if (panel.active === path) row.classList.add('active')
    return row
  }

  function renderChildren(container, entries, depth) {
    for (const entry of entries) {
      const row = treeNode(entry.path, entry.dir ? 'dir' : 'file', entry.name, { depth: depth, kind: entry.kind })
      container.appendChild(row)
      if (entry.dir && panel.expanded[entry.path] === true) {
        const box = document.createElement('div')
        box.className = 'tree-children'
        box.setAttribute('data-children-of', entry.path)
        const cached = panel.children[entry.path]
        if (cached) {
          renderChildren(box, cached, depth + 1)
        } else {
          const loading = document.createElement('div')
          loading.className = 'tree-loading'
          loading.textContent = '加载中...'
          box.appendChild(loading)
        }
        container.appendChild(box)
      }
    }
  }

  function groupTitle(text, count) {
    const head = document.createElement('div')
    head.className = 'tree-group-title'
    head.appendChild(document.createTextNode(text))
    if (count !== undefined && count !== null) {
      const badge = document.createElement('span')
      badge.className = 'tree-group-count'
      badge.textContent = String(count)
      head.appendChild(badge)
    }
    return head
  }

  function emptyHint(text) {
    const node = document.createElement('div')
    node.className = 'tree-empty'
    node.textContent = text
    return node
  }

  function renderTree() {
    const host = byId('panelTree')
    if (not(host)) return
    host.textContent = ''

    /* 第一部分：关联的所有工作区目录 */
    host.appendChild(groupTitle('工作区', panel.roots.length))
    if (not(hasApi())) {
      host.appendChild(emptyHint('文件接口不可用。请用桌面应用打开，或让服务端（server/index.js）提供服务。'))
      return
    }
    if (panel.loading && not(panel.roots.length)) {
      const loading = document.createElement('div')
      loading.className = 'tree-loading'
      loading.textContent = '正在读取工作区...'
      host.appendChild(loading)
      return
    }
    if (panel.error && not(panel.roots.length)) {
      const failed = document.createElement('div')
      failed.className = 'tree-error'
      failed.textContent = panel.error
      host.appendChild(failed)
      return
    }
    if (not(panel.roots.length)) {
      host.appendChild(emptyHint(panel.context && panel.context.scope === 'recent' ? '当前为普通会话，未关联项目目录。' : '当前项目还没有关联工作目录。'))
    }
    for (const root of panel.roots) {
      const row = treeNode(root.path, 'dir', root.name, { depth: 0 })
      host.appendChild(row)
      if (panel.expanded[root.path] === true) {
        const box = document.createElement('div')
        box.className = 'tree-children'
        box.setAttribute('data-children-of', root.path)
        const cached = panel.children[root.path]
        if (cached) renderChildren(box, cached, 1)
        else {
          const loading = document.createElement('div')
          loading.className = 'tree-loading'
          loading.textContent = '加载中...'
          box.appendChild(loading)
        }
        host.appendChild(box)
      }
    }

    /* 第二部分：只列工作区之外、明确归当前会话的产物。项目文件已经在上面的树里。 */
    const sessionOnly = panel.sessionFiles.filter((target) => not(isWorkspaceFile(target)))
    host.appendChild(groupTitle('本会话文件', sessionOnly.length))
    if (not(sessionOnly.length)) {
      host.appendChild(emptyHint('这次会话还没有生成独立资源。'))
    }
    for (const target of sessionOnly) {
      const row = treeNode(target, 'file', baseOf(target), { depth: 0, kind: kindCache[target] || 'text' })
      row.title = target
      host.appendChild(row)
    }

    applyIcons()
  }

  function applyIcons() {
    if (window.applyIcons) window.applyIcons(byId('filePanel') || document)
  }

  async function loadRoots() {
    const revision = panel.contextRevision
    if (panel.context && panel.context.scope !== 'project') {
      panel.roots = []
      panel.loading = false
      renderTree()
      return
    }
    if (not(hasApi())) {
      renderTree()
      return
    }
    panel.loading = true
    panel.error = ''
    renderTree()
    try {
      const data = await dsh().fsRoots()
      if (revision !== panel.contextRevision) return
      panel.roots = (data && Array.isArray(data.roots) ? data.roots : []).map((item) => ({
        path: String(item.path || ''),
        name: String(item.name || baseOf(item.path))
      })).filter((item) => item.path)
      panel.projectName = String((data && data.projectName) || '')
      const title = byId('panelTitle')
      if (title) title.textContent = panel.projectName || '文件'
      /* 只有一个根时默认展开，省一次点击 */
      if (panel.roots.length === 1) await toggleDir(panel.roots[0].path, true)
    } catch (error) {
      if (revision !== panel.contextRevision) return
      panel.roots = []
      panel.error = friendlyError(error)
    } finally {
      if (revision === panel.contextRevision) {
        panel.loading = false
        renderTree()
      }
    }
  }

  /**
   * 错误转人话。
   * 最常见的一种：进程是很久以前起的（那时还没有 /api/fs/*），静态资源是现读磁盘的
   * 所以渲染层是新的，接口却是 404 —— 不写清楚会以为是面板坏了。
   */
  function friendlyError(error) {
    const message = String((error && error.message) || error || '')
    if (message.indexOf('404') >= 0 || message.indexOf('NOT_FOUND') >= 0) {
      return '服务端还没有文件接口（404）。重启一下服务端（server/index.js）即可。'
    }
    if (message.indexOf('WORKSPACE_NOT_SET') >= 0) {
      return '还没有关联工作区目录，先在左侧建一个。'
    }
    if (message.indexOf('PATH_ESCAPE') >= 0) {
      return '这个路径不在关联的工作区内，已拒绝访问。'
    }
    return message || '读取工作区失败'
  }

  async function loadChildren(target) {
    if (panel.children[target]) return panel.children[target]
    if (panel.pending[target]) return panel.pending[target]
    const task = dsh().fsTree(target, 1).then((data) => {
      const entries = (data && Array.isArray(data.entries) ? data.entries : []).map((item) => ({
        path: String(item.path || ''),
        name: String(item.name || ''),
        dir: item.dir === true,
        size: Number(item.size) || 0,
        kind: String(item.kind || 'text')
      }))
      panel.children[target] = entries
      for (const entry of entries) if (not(entry.dir)) kindCache[entry.path] = entry.kind
      return entries
    }).catch((error) => {
      panel.children[target] = []
      throw error
    }).then((value) => {
      delete panel.pending[target]
      return value
    })
    panel.pending[target] = task
    return task
  }

  async function toggleDir(target, forceOpen) {
    const open = forceOpen === undefined ? panel.expanded[target] !== true : Boolean(forceOpen)
    panel.expanded[target] = open
    if (open) {
      renderTree()
      try {
        await loadChildren(target)
      } catch (error) {
        panel.children[target] = []
        panel.error = String((error && error.message) || error)
      }
    }
    renderTree()
  }

  /* ------------------------------------------------------------ 标签页 */

  function tabIndex(target) {
    for (let index = 0; index < panel.tabs.length; index += 1) {
      if (panel.tabs[index].path === target) return index
    }
    return -1
  }

  function renderTabs() {
    syncMarkdownPreviewButton()
    const host = byId('panelTabs')
    if (not(host)) return
    host.textContent = ''
    for (const tab of panel.tabs) {
      const node = document.createElement('div')
      /* dirty：这个文件正开着编辑器且有改动没落盘 —— 标签上点一枚小圆点，
         不然用户切走了根本不知道那边还有没写完的东西 */
      const dirty = panel.editor.dirty === true && panel.editor.path === tab.path
      node.className = 'panel-tab' + (tab.path === panel.active ? ' active' : '') + (dirty ? ' dirty' : '')
      node.setAttribute('data-path', tab.path)

      const label = document.createElement('span')
      label.className = 'panel-tab-label'
      label.textContent = tab.name
      label.title = dirty ? tab.path + '（有改动未保存）' : tab.path
      node.appendChild(label)

      const phase = tab.saveState || (dirty ? 'dirty' : '')
      node.setAttribute('data-save-state', phase)
      const failed = phase === 'error' || phase === 'conflict'
      const save = document.createElement(failed ? 'button' : 'span')
      save.className = 'panel-tab-save'
      save.title = tab.saveMessage || (dirty ? '未保存' : '已保存')
      save.setAttribute('aria-label', save.title)
      if (failed) {
        save.type = 'button'
        save.id = phase === 'conflict' ? 'editorForce' : 'editorRetry'
        save.title += phase === 'conflict' ? '；点击确认强制保存' : '；点击重试'
        save.textContent = '!'
      } else if (phase === 'saved') save.innerHTML = window.renderIcon('check')
      else if (phase) save.textContent = phase === 'saving' ? '◌' : '●'
      node.appendChild(save)

      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'panel-tab-close'
      close.title = '关闭'
      close.setAttribute('data-close', tab.path)
      close.innerHTML = window.renderIcon('close')
      node.appendChild(close)

      host.appendChild(node)
    }
  }

  /** 编辑器只服一个文件：换文件/关标签时把没落盘的最后一段写掉再放手 */
  async function releaseEditorIfLeaving(target) {
    if (not(panel.editor.active)) return true
    if (panel.editor.path === target) return true
    await flushSave()
    if (panel.editor.dirty) return false
    panel.editor.active = false
    panel.editor.path = ''
    panel.editor.taNode = null
    panel.editor.statusNode = null
    return true
  }

  async function closeTab(target) {
    let index = tabIndex(target)
    if (index < 0) return
    if (panel.editor.active && panel.editor.path === target) {
      /* 等保存结束；失败或冲突时保留编辑内容和标签，避免丢失改动。 */
      await flushSave()
      if (panel.editor.dirty) return
      panel.editor.active = false
      panel.editor.path = ''
      panel.editor.taNode = null
      panel.editor.statusNode = null
    }
    index = tabIndex(target)
    if (index < 0) return
    panel.tabs.splice(index, 1)
    if (panel.active === target) {
      const next = panel.tabs[index] || panel.tabs[index - 1] || null
      panel.active = next ? next.path : ''
    }
    renderTabs()
    renderTree()
    renderPreview()
  }

  async function openFile(target, options) {
    const name = baseOf(target)
    /* 换到别的文件：把上一个文件没落盘的写掉，编辑器跟着转场 */
    if ((await releaseEditorIfLeaving(target)) === false) return
    if (tabIndex(target) < 0) {
      panel.tabs.push({ path: target, name: name, kind: (options && options.kind) || kindCache[target] || 'text' })
      /* 标签页最多留 12 个，前面的一律关掉（内存 + 视觉都好） */
      while (panel.tabs.length > 12) panel.tabs.shift()
    }
    panel.active = target
    renderTabs()
    renderTree()
    await renderPreview()
    const host = byId('panelTabs')
    if (host) {
      const node = host.querySelector('[data-path="' + cssEscape(target) + '"]')
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  function cssEscape(value) {
    return String(value || '').replace(/["\\]/g, '\\$&')
  }

  /* ------------------------------------------------------------ 预览 */

  function placeholder(text) {
    const node = document.createElement('div')
    node.className = 'panel-placeholder'
    node.textContent = text
    return node
  }

  function card(title, icon, lines) {
    const box = document.createElement('div')
    box.className = 'preview-card'
    const head = document.createElement('div')
    head.className = 'preview-card-title'
    const glyph = document.createElement('span')
    glyph.className = 'icon'
    glyph.innerHTML = window.renderIcon(icon)
    head.appendChild(glyph)
    head.appendChild(document.createTextNode(title))
    box.appendChild(head)
    const meta = document.createElement('div')
    meta.className = 'preview-card-meta'
    for (const line of lines) {
      const row = document.createElement('div')
      row.textContent = line
      meta.appendChild(row)
    }
    box.appendChild(meta)
    return box
  }

  async function renderPreview() {
    const host = byId('panelPreview')
    if (not(host)) return
    host.textContent = ''
    host.classList.remove('is-fit')
    /* is-editing：把预览区切成「工具条 + 撑满的 textarea」的纵向布局（见 style.css） */
    host.classList.remove('is-editing')

    if (not(panel.active)) {
      host.appendChild(placeholder('点击左边的文件即可预览。'))
      return
    }

    const target = panel.active
    const name = baseOf(target)

    if (not(hasApi())) {
      host.appendChild(placeholder('文件接口不可用，无法预览。'))
      return
    }

    let meta = null
    try {
      meta = await dsh().fsFile(target)
    } catch (error) {
      meta = null
    }
    /* 面板打开期间用户可能又点了别的文件 —— 只认最新那一次 */
    if (panel.active !== target) return

    if (not(meta)) {
      host.appendChild(card('打不开这个文件', 'warning', [target, '文件可能已被删除，或不在关联的工作区内。']))
      return
    }

    const kind = String(meta.kind || 'text')
    const ext = String(meta.ext || extOf(name))
    kindCache[target] = kind
    syncMarkdownPreviewButton()

    if (kind === 'code' || kind === 'text' || kind === 'markdown') {
      let editing = editorIsFor(target)
      let decoded = null
      if (editing) {
        /* 编辑态下正文以编辑框为准，**不再从磁盘读一遍** ——
           重读会把用户刚敲的内容冲掉（自动保存还没落盘的那几百毫秒） */
        decoded = { text: panel.editor.text, encoding: panel.editor.encoding }
      } else {
        try {
          decoded = await readText(target)
        } catch (error) {
          decoded = null
        }
      }
      if (panel.active !== target) return
      if (not(decoded)) {
        host.appendChild(card('读取失败', 'warning', [target]))
        return
      }

      if (!editing && canEdit(meta) && typeof dsh().fsWrite === 'function') {
        activateEditor(target, meta, decoded)
        editing = true
        renderTabs()
      }

      if (!editing) host.appendChild(previewBar(meta, false))

      if (editing) {
        host.classList.add('is-editing')
        const source = editorBody()
        host.appendChild(isMarkdownFile(target) && panel.markdownPreview ? markdownSplit(source) : source)
        return
      }

      if (kind === 'markdown' && window.renderMarkdown) {
        const box = document.createElement('div')
        box.className = 'preview-markdown'
        box.innerHTML = window.renderMarkdown(decoded.text)
        if (window.highlightAll) window.highlightAll(box)
        host.appendChild(box)
        return
      }
      const pre = document.createElement('pre')
      pre.className = kind === 'code' ? 'preview-code' : 'preview-text'
      const code = document.createElement('code')
      if (kind === 'code' && window.highlightCode) {
        code.innerHTML = window.highlightCode(decoded.text, ext)
      } else {
        code.textContent = decoded.text
      }
      pre.appendChild(code)
      host.appendChild(pre)
      return
    }

    if (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video') {
      let url = ''
      try {
        url = await dsh().fsPreviewUrl(target)
      } catch (error) {
        url = ''
      }
      if (panel.active !== target) return
      if (not(url)) {
        host.appendChild(card('无法内嵌预览', 'warning', [target]))
        return
      }
      if (kind === 'image') {
        const img = document.createElement('img')
        img.className = 'preview-image'
        img.alt = name
        img.src = url
        host.appendChild(img)
        return
      }
      if (kind === 'pdf') {
        const frame = document.createElement('iframe')
        frame.className = 'preview-pdf'
        frame.title = name
        frame.src = url
        host.appendChild(frame)
        host.classList.add('is-fit')
        return
      }
      const media = document.createElement(kind === 'audio' ? 'audio' : 'video')
      media.className = 'preview-media'
      media.controls = true
      media.src = url
      host.appendChild(media)
      return
    }

    /* Office / 压缩包 / 二进制：给一张卡，不进内存。
       二期再接「用系统默认程序打开」。 */
    const label = kind === 'office' ? 'Office 文档'
      : (kind === 'archive' ? '压缩包' : '二进制文件')
    host.appendChild(card(label, kind === 'office' ? 'file' : 'warning', [
      target,
      fmtSize(meta.size) + (meta.mtime ? ' · ' + fmtTime(meta.mtime) : ''),
      '这类文件不能内嵌预览。'
    ]))
  }

  /* ------------------------------------------------------------ 本会话文件 */

  function loadSessionFiles() {
    const store = readJSON(FILES_KEY, {})
    const list = store && Array.isArray(store[panel.sessionId]) ? store[panel.sessionId] : []
    panel.sessionFiles = list.slice()
  }

  function rememberSessionFile(target) {
    if (not(target) || not(panel.sessionId)) return
    if (panel.sessionFiles.indexOf(target) >= 0) return
    panel.sessionFiles.push(target)
    const store = readJSON(FILES_KEY, {})
    store[panel.sessionId] = panel.sessionFiles.slice()
    writeJSON(FILES_KEY, store)
  }

  function normalizedPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  function isWorkspaceFile(target) {
    const value = normalizedPath(target)
    if (not(value)) return false
    return panel.roots.some((root) => {
      const base = normalizedPath(root.path)
      return value === base || value.indexOf(base + '/') === 0
    })
  }

  /** 现在属于哪个会话 —— app.js 只往 localStorage 里写，这里照读 */
  function refreshSessionContext() {
    const current = localStorage.getItem(SESSION_KEY) || ''
    if (current !== panel.sessionId) {
      panel.sessionId = current
      loadSessionFiles()
    }
  }

  /** 工具参数里的相对路径 → 绝对路径（相对第一个工作区根） */
  function absoluteFor(relative) {
    const text = String(relative || '').trim()
    if (not(text) || text === '.') return ''
    if (/^([a-zA-Z]:[\\/]|\/)/.test(text)) return text
    const root = panel.roots[0] || (panel.context && panel.context.workspacePath ? { path: panel.context.workspacePath } : null)
    if (not(root)) return ''
    const separator = root.path.indexOf('\\') >= 0 ? '\\' : '/'
    const trimmed = text.replace(/^[.][\\/]/, '')
    return root.path.replace(/[\\/]+$/, '') + separator + trimmed.split(/[\\/]/).join(separator)
  }

  function handleEvent(event) {
    if (not(event) || not(event.type)) return

    if (event.type === 'tool:start') {
      /* 会话有可能刚被换掉（新建会话后第一条工具调用），先对齐再记 */
      refreshSessionContext()
      const field = TOOL_PATH_FIELD[event.name]
      if (field && FILE_TOOLS[event.name]) {
        const raw = String((event.args || {})[field] || '')
        /* 目录（结尾带斜杠）不收 —— 目录本来就由上面那棵树负责 */
        if (raw && not(/[\\/]\s*$/.test(raw))) {
          const absolute = absoluteFor(raw)
          if (absolute) beforeRemember(absolute)
        }
      }
      return
    }

    if (event.type === 'tool:result' || event.type === 'finished') {
      /* 任务收尾时可能已经切到别的会话了，顺手对一次 */
      refreshSessionContext()
      renderTreeIfVisible()
    }
  }

  function renderTreeIfVisible() {
    if (not(panel.open) || panel.explorer !== true) return
    if (rememberTimer) return
    rememberTimer = setTimeout(() => {
      rememberTimer = null
      renderTree()
    }, 250)
  }

  let rememberTimer = null

  function beforeRemember(target) {
    if (isWorkspaceFile(target)) return
    rememberSessionFile(target)
    renderTreeIfVisible()
  }

  /* ------------------------------------------------------------ 事件绑定 */

  function bindClick() {
    document.addEventListener('click', (event) => {
      const target = event.target
      if (not(target) || typeof target.closest !== 'function') return

      if (target.closest('#panelToggle')) {
        event.preventDefault()
        toggleOpen()
        return
      }
      if (target.closest('#markdownPreviewToggle')) {
        event.preventDefault()
        const current = panel.active
        const ta = panel.editor.taNode
        const selection = ta ? { start: ta.selectionStart, end: ta.selectionEnd, top: ta.scrollTop, left: ta.scrollLeft } : null
        panel.markdownPreview = !panel.markdownPreview
        if (panel.markdownPreview) {
          const main = document.querySelector('.panel-main')
          if (panel.explorer && main && main.getBoundingClientRect().width < 480) {
            panel.markdownAutoExplorer = true
            setExplorer(false)
          }
        } else if (panel.markdownAutoExplorer) {
          panel.markdownAutoExplorer = false
          setExplorer(true)
        }
        syncMarkdownPreviewButton()
        renderPreview().then(() => {
          const next = panel.editor.taNode
          if (selection && next && panel.active === current) {
            next.setSelectionRange(selection.start, selection.end)
            next.scrollTop = selection.top
            next.scrollLeft = selection.left
            next.dispatchEvent(new Event('scroll'))
          }
        })
        return
      }
      if (target.closest('#panelExplorerToggle')) {
        panel.markdownAutoExplorer = false
        setExplorer(not(panel.explorer))
        return
      }
      if (target.closest('#panelRefresh')) {
        /* 刷新前先把编辑器里没落盘的写掉，别让「刷新」把改动刷没了 */
        flushSave()
        panel.children = {}
        panel.pending = {}
        panel.error = ''
        clearKindCache()
        loadRoots()
        return
      }
      if (target.closest('#panelVscode')) {
        setChatHidden(not(document.documentElement.classList.contains('chat-hidden')))
        return
      }
      if (target.closest('#panelTerminal')) {
        toggleTerminal()
        return
      }
      if (target.closest('#editorForce')) {
        event.preventDefault()
        if (window.confirm('文件已被外部修改。确定用当前编辑内容覆盖磁盘文件吗？')) forceSave()
        return
      }
      if (target.closest('#editorRetry')) {
        event.preventDefault()
        flushSave()
        return
      }

      const closeNode = target.closest('[data-close]')
      if (closeNode && closeNode.closest('#panelTabs')) {
        event.stopPropagation()
        closeTab(closeNode.getAttribute('data-close'))
        return
      }
      const tabNode = target.closest('.panel-tab')
      if (tabNode && tabNode.closest('#panelTabs')) {
        const path = tabNode.getAttribute('data-path')
        if (path && path !== panel.active) {
          const previous = panel.active
          panel.active = path
          /* 目标是别的文件时先把上一个的改动写掉（写的时候 panel.active 已经变了，
             保存逻辑只认 panel.editor.path，不受影响） */
          releaseEditorIfLeaving(previous).then(() => {
            if (panel.active !== path) return
            renderTabs()
            renderTree()
            renderPreview()
          })
          renderTabs()
        }
        return
      }
      const row = target.closest('.tree-row')
      if (row && row.closest('#panelTree')) {
        const path = row.getAttribute('data-path')
        if (not(path)) return
        if (row.getAttribute('data-dir') === '1') toggleDir(path)
        else openFile(path, { kind: kindCache[path] })
      }
    })
  }

  function clearKindCache() {
    for (const key of Object.keys(kindCache)) delete kindCache[key]
  }

  /**
   * 「只看文件」模式（面板顶栏那枚 VS Code 图标）：
   * 侧边栏 + 会话区整块收起，面板铺满窗口 —— 资源管理器 + 预览，跟 VS Code 一样。
   * 开关挂在 <html> 上（和 .shell-mac 同一层），CSS 选择器写 html.chat-hidden #app...
   */
  function setChatHidden(hidden) {
    document.documentElement.classList.toggle('chat-hidden', Boolean(hidden))
    const button = byId('panelVscode')
    if (button) button.classList.toggle('panel-explorer-toggle-on', Boolean(hidden))
  }

  /** 终端是三期的事。这里先给一条明说的提示带，别让按钮看起来是坏的。 */
  /* ------------------------------------------------------------ 终端（三期） */

  const TERMINAL_BUFFER_MAX_CHARS = 200000
  const TERMINAL_READY_MARKER = '__DSH_CMD_READY__'
  /** 终端高度（停靠在预览区下方那块）：记住用户拖出来的值 */
  const TERMINAL_HEIGHT_KEY = 'dsh-panel-terminal-height'
  const TERMINAL_HEIGHT_DEFAULT = 240
  const TERMINAL_HEIGHT_MIN = 120

  function clampTerminalHeight(value, maxHeight) {
    let next = Math.round(Number(value) || TERMINAL_HEIGHT_DEFAULT)
    if (next < TERMINAL_HEIGHT_MIN) next = TERMINAL_HEIGHT_MIN
    if (maxHeight && next > maxHeight) next = Math.max(maxHeight, TERMINAL_HEIGHT_MIN)
    return next
  }

  /** 高度只走 CSS 变量（和面板宽那条规矩一样：布局值不许写死在 JS 里） */
  function applyTerminalHeight() {
    const panelEl = byId('filePanel')
    if (not(panelEl) || not(panel.terminal.height)) return
    panelEl.style.setProperty('--terminal-height', panel.terminal.height + 'px')
  }

  /** 预览 | 终端 之间的分隔条：拖高度。和 bindColResize 同一套纪律 ——
      mousedown 一次量好边界，mousemove 只记事件，rAF 帧里才 apply，mouseup flush。 */
  function bindTerminalResize() {
    const handle = byId('terminalSplit')
    if (not(handle)) return
    let startY = 0
    let startHeight = 0
    let maxHeight = 0
    let pendingEvent = null
    let frame = 0
    const apply = (event) => {
      const next = clampTerminalHeight(startHeight + (startY - event.clientY), maxHeight)
      if (next === panel.terminal.height) return
      panel.terminal.height = next
      applyTerminalHeight()
      fitTerminal()
    }
    const flush = () => {
      frame = 0
      if (pendingEvent) {
        apply(pendingEvent)
        pendingEvent = null
      }
    }
    const onMove = (event) => {
      pendingEvent = event
      if (not(frame)) frame = requestAnimationFrame(flush)
    }
    const onUp = () => {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      flush()
      document.body.classList.remove('resizing')
      document.body.classList.remove('resizing-term')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeJSON(TERMINAL_HEIGHT_KEY, panel.terminal.height)
    }
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      startY = event.clientY
      const view = byId('terminalView')
      startHeight = view ? Math.round(view.getBoundingClientRect().height) : TERMINAL_HEIGHT_DEFAULT
      /* 上限 = .panel-main 高度 − 预览区最少留 140 */
      const main = document.querySelector('.panel-main')
      maxHeight = (main ? Math.round(main.getBoundingClientRect().height) : 480) - 140
      document.body.classList.add('resizing')
      document.body.classList.add('resizing-term')
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
    /* 双击分隔条 = 回到默认高度 */
    handle.addEventListener('dblclick', () => {
      panel.terminal.height = TERMINAL_HEIGHT_DEFAULT
      applyTerminalHeight()
      fitTerminal()
    })
  }

  /** 终端 API 在两个入口都有（preload IPC / web-bridge HTTP），拿不到就明说 */
  function termApi() {
    const api = dsh()
    if (api && typeof api.termState === 'function' && typeof api.termStart === 'function') return api
    return null
  }


  function makeTerminalState(tabId, options) {
    const opts = options || {}
    return {
      open: true,
      tabId: tabId || (String.fromCharCode(116, 97, 98, 95) + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      title: opts.title || "",
      picker: opts.picker !== false,
      sid: opts.sid || "",
      cwd: opts.cwd || "",
      buffer: "",
      history: [],
      histIndex: -1,
      unsubscribe: null,
      busy: false,
      line: "",
      promptDrawn: false,
      replayApplied: "",
      host: null,
      xterm: null,
      fit: null,
      height: panel.terminal.height || 0,
      cwdOptions: [],
      outputEndsNL: true,
      idlePromptTimer: null
    }
  }

  function tabById(tabId) {
    for (const tab of panel.terminalTabs) {
      if (tab.tabId === tabId) return tab
    }
    return null
  }

  function saveTerminalTabs() {
    try {
      const data = {
        active: panel.activeTerminalId,
        tabs: panel.terminalTabs.map((tab) => ({ tabId: tab.tabId, sid: tab.sid, cwd: tab.cwd, title: tab.title, picker: tab.picker === true }))
      }
      localStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify(data))
    } catch (error) {}
  }

  function renderTerminalTabs() {
    const host = byId("terminalTabs")
    if (not(host)) return
    host.textContent = ""
    for (const tab of panel.terminalTabs) {
      const item = document.createElement("div")
      item.className = "terminal-tab" + (tab.tabId === panel.activeTerminalId ? " on" : "")
      item.title = tab.cwd || tab.title || "terminal"
      const name = document.createElement("span")
      name.className = "terminal-tab-name"
      name.textContent = tab.title || baseOf(tab.cwd || "") || "terminal"
      const close = document.createElement("button")
      close.type = "button"
      close.className = "terminal-tab-close"
      close.textContent = "x"
      close.title = "close terminal"
      item.appendChild(name)
      item.appendChild(close)
      item.addEventListener("click", () => setActiveTerminal(tab.tabId))
      close.addEventListener("click", (event) => {
        event.stopPropagation()
        closeTerminalTab(tab.tabId)
      })
      host.appendChild(item)
    }
  }

  function setActiveTerminal(tabId) {
    const tab = tabById(tabId)
    if (not(tab)) return
    panel.terminal = tab
    panel.activeTerminalId = tab.tabId
    for (const item of panel.terminalTabs) {
      if (item.host) item.host.classList.toggle("hidden", item.tabId !== tabId)
    }
    renderTerminalTabs()
    renderTerminalDirs()
    const label = byId("terminalCwdLabel")
    if (label) label.textContent = tab.cwd || ""
    window.__dshTermState = panel.terminal
    if (tab.open) {
      const term = ensureXterm()
      if (term) {
        requestAnimationFrame(fitTerminal)
        term.focus()
      }
      openTerminalSession()
    }
    saveTerminalTabs()
  }

  function createTerminalTab(options) {
    const tab = makeTerminalState("", options)
    panel.terminalTabs.push(tab)
    setActiveTerminal(tab.tabId)
    return tab
  }
  async function resolveDefaultTerminalCwd() {
    const revision = panel.contextRevision
    if (panel.context && panel.context.scope === 'recent') return panel.context.workspacePath || ''
    if (panel.roots.length > 0) return panel.roots[0].path
    const api = dsh()
    if (api && typeof api.fsRoots === "function") {
      try {
        const data = await api.fsRoots()
        if (revision !== panel.contextRevision) return ""
        panel.roots = (data && Array.isArray(data.roots) ? data.roots : []).map((item) => ({ path: String(item.path || ""), name: String(item.name || "") })).filter((item) => item.path)
        if (panel.roots.length > 0) return panel.roots[0].path
      } catch (error) {}
    }
    return ""
  }

  async function newTerminalTab() {
    let cwd = await resolveDefaultTerminalCwd()
    if (not(cwd) && panel.terminal && panel.terminal.cwd) cwd = panel.terminal.cwd
    if (cwd) {
      const tab = createTerminalTab({ picker: false, cwd: cwd, title: baseOf(cwd) })
      restartTerminalAt(cwd)
      return tab
    }
    return createTerminalTab({ picker: true })
  }


  function closeTerminalTab(tabId) {
    const index = panel.terminalTabs.findIndex((tab) => tab.tabId === tabId)
    if (index < 0) return
    const tab = panel.terminalTabs[index]
    if (tab.unsubscribe) { tab.unsubscribe(); tab.unsubscribe = null }
    if (tab.sid) {
      const api = termApi()
      if (api && typeof api.termKill === "function") api.termKill(tab.sid).catch(() => {})
    }
    if (tab.xterm) { try { tab.xterm.dispose() } catch (error) {} }
    if (tab.host && tab.host.parentNode) tab.host.parentNode.removeChild(tab.host)
    panel.terminalTabs.splice(index, 1)
    if (panel.activeTerminalId === tabId) {
      const next = panel.terminalTabs[Math.max(0, index - 1)]
      if (next) setActiveTerminal(next.tabId)
      else newTerminalTab()
    } else {
      renderTerminalTabs()
    }
    saveTerminalTabs()
  }

  function restoreTerminalTabs() {
    const data = readJSON(TERMINAL_TABS_KEY, null)
    if (not(data) || not(Array.isArray(data.tabs))) return
    for (const item of data.tabs) {
      const tab = makeTerminalState(item.tabId, {
        sid: item.sid || "",
        cwd: item.cwd || "",
        title: item.title || "",
        picker: item.picker !== false
      })
      panel.terminalTabs.push(tab)
    }
    const active = tabById(data.active) || panel.terminalTabs[0]
    if (active) setActiveTerminal(active.tabId)
  }

  function setTerminalMode(open) {
    const next = Boolean(open)
    panel.terminalView = next
    const panelEl = byId("filePanel")
    if (panelEl) panelEl.classList.toggle("panel-terminal-mode", next)
    const button = byId("panelTerminal")
    if (button) button.classList.toggle("panel-terminal-toggle-on", next)
    const view = byId("terminalView")
    if (view) view.classList.toggle("hidden", not(next))
    if (next) {
      if (panel.terminalTabs.length === 0) {
        newTerminalTab()
        return
      }
      if (not(panel.terminal.tabId)) {
        setActiveTerminal(panel.terminalTabs[0].tabId)
        return
      }
      const term = ensureXterm()
      if (term) {
        requestAnimationFrame(fitTerminal)
        term.focus()
      }
      openTerminalSession()
      renderTerminalTabs()
    } else if (panel.terminal.unsubscribe) {
      panel.terminal.unsubscribe()
      panel.terminal.unsubscribe = null
    }
  }

  function toggleTerminal() {
    setTerminalMode(not(panel.terminalView))
  }

  function base64ToBytes(text) {
    const binary = atob(String(text || ''))
    const out = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
    return out
  }

  function appendTerminal(text) {
    if (not(text)) return
    let buffer = panel.terminal.buffer + text
    if (buffer.length > TERMINAL_BUFFER_MAX_CHARS) {
      buffer = buffer.slice(buffer.length - TERMINAL_BUFFER_MAX_CHARS)
    }
    panel.terminal.buffer = buffer
    renderTerminalBuffer()
  }

  function renderTerminalBuffer() {
    const out = byId('terminalOut')
    if (not(out)) return
    out.textContent = panel.terminal.buffer
    out.scrollTop = out.scrollHeight
  }

  /* ---------------- xterm.js（真终端前端，vendor/xterm 离线内置） ---------------- */

  /** xterm 没加载成功（vendor 缺文件之类）就走纯文本兜底：功能不断，只是没真终端观感 */
  function xtermAvailable() {
    try {
      return typeof window !== 'undefined' && typeof window.Terminal === 'function'
    } catch (error) {
      return false
    }
  }

  function setupTerminalLinks(term) {
    const HTTP_PREFIX = 'http' + '://'
    const HTTPS_PREFIX = 'https' + '://'
    if (not(term) || typeof term.registerLinkProvider !== 'function') return
    term.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        try {
          const line = term.buffer.active.getLine(lineNumber - 1)
          if (not(line)) { callback(undefined); return }
          const text = line.translateToString(true)
          const words = text.split(' ')
          const links = []
          let offset = 0
          for (const word of words) {
            const index = text.indexOf(word, offset)
            offset = index + word.length
            let uri = word
            while (uri.length > 0 && '),.;]}>'.indexOf(uri.charAt(uri.length - 1)) !== -1) uri = uri.slice(0, -1)
            if (uri.indexOf(HTTP_PREFIX) !== 0 && uri.indexOf(HTTPS_PREFIX) !== 0) continue
            const start = index + 1
            const end = start + uri.length - 1
            links.push({
              range: { start: { x: start, y: lineNumber }, end: { x: end, y: lineNumber } },
              text: uri,
              activate: (event, target) => {
                if (not(event) || (not(event.metaKey) && not(event.ctrlKey))) return
                const api = dsh()
                if (api && typeof api.openExternal === 'function') api.openExternal(target)
              }
            })
          }
          callback(links.length > 0 ? links : undefined)
        } catch (error) {
          callback(undefined)
        }
      }
    })
  }

  function ensureXterm() {
    if (panel.terminal.xterm) return panel.terminal.xterm
    const out = byId('terminalOut')
    if (not(out) || not(xtermAvailable())) return null
    if (not(panel.terminal.host)) {
      const host = document.createElement('div')
      host.className = 'terminal-instance'
      panel.terminal.host = host
      out.appendChild(host)
    }
    const host = panel.terminal.host
    for (const item of panel.terminalTabs) {
      if (item.host) item.host.classList.toggle('hidden', item.tabId !== panel.activeTerminalId)
    }
    const term = new window.Terminal({
      fontFamily: 'Consolas, Menlo, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 3000,
      /* buffer API 是 proposed：不开这个，访问 term.buffer 直接抛异常 */
      allowProposedApi: true,
      theme: {
        background: '#1b1b1b',
        foreground: '#eeeeee',
        cursor: '#dddddd',
        selectionBackground: '#444444'
      }
    })
    try {
      if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
        panel.terminal.fit = new window.FitAddon.FitAddon()
        term.loadAddon(panel.terminal.fit)
      }
      term.open(host)
      panel.terminal.xterm = term
      setupTerminalLinks(term)
      if (panel.terminal.buffer) {
        const pending = panel.terminal.buffer
        panel.terminal.buffer = ""
        processOutputFor(panel.terminal, pending)
      }
      /* 用户敲键 → handleTerminalData（行编辑/回显/历史都在渲染层做，见下） */
      term.onData(handleTerminalData)
      /* ⌥/Alt + 数字切目录：在 xterm 收键前拦掉，别让它进输入行 */
      if (typeof term.attachCustomKeyEventHandler === 'function') {
        term.attachCustomKeyEventHandler(terminalDirHotkey)
      }
      fitTerminal()
    } catch (error) {
      panel.terminal.xterm = null
      panel.terminal.fit = null
      return null
    }
    /* 测试/调试钩子：check:drag 读 buffer API 用 */
    window.__dshXterm = term
    return term
  }

  /** fit 要多试几帧：面板刚从 display:none 变可见那一帧 xterm 还没量出字符尺寸
      （量到 0 时 fit 直接放弃）—— 结果列数停在个位数，输出被折断成一段一段。
      用户看到的就是「命令结果不正常」。 */
  function fitTerminal(retry) {
    const term = panel.terminal.xterm
    if (not(term) || not(panel.terminal.fit)) return
    /* 重试计数：这个函数也会被 rAF 直接调（传时间戳进来）和 resize 事件调（传事件对象），
       所以只有拿到 0..7 这样的小整数才当重试次数，别的一律归零 */
    const raw = Number(retry)
    const attempt = raw >= 0 && raw < 8 ? Math.floor(raw) : 0
    try {
      panel.terminal.fit.fit()
    } catch (error) { /* 容器不可见时 fit 会量出 0，忽略这帧 */ }
    if (term.cols <= 20 && attempt < 7) {
      requestAnimationFrame(() => fitTerminal(attempt + 1))
    }
  }

  /** 管道 shell 在 mac/linux 只吐 \n，xterm 里必须 \r\n 才回到行首 */
  function terminalToXterm(text) {
    return String(text).replace(/\r?\n/g, '\r\n')
  }

  /** 统一出口：有 xterm 写 xterm，没有走纯文本兜底（buffer + textContent） */
  function writeRawFor(state, text) {
    if (not(text) || not(state)) return
    const term = state.xterm
    if (term) {
      term.write(terminalToXterm(text))
      const last = String(text).slice(-1)
      state.outputEndsNL = last === String.fromCharCode(10) || last === String.fromCharCode(13)
      return
    }
    let buffer = state.buffer + text
    if (buffer.length > TERMINAL_BUFFER_MAX_CHARS) buffer = buffer.slice(buffer.length - TERMINAL_BUFFER_MAX_CHARS)
    state.buffer = buffer
    if (state.tabId === panel.activeTerminalId) renderTerminalBuffer()
  }

  function processOutputFor(state, text) {
    if (not(text) || not(state)) return
    state.scanBuffer = (state.scanBuffer || "") + String(text)
    while (true) {
      const index = state.scanBuffer.indexOf(TERMINAL_READY_MARKER)
      if (index === -1) {
        const keep = TERMINAL_READY_MARKER.length - 1
        if (state.scanBuffer.length > keep) {
          const ready = state.scanBuffer.slice(0, state.scanBuffer.length - keep)
          state.scanBuffer = state.scanBuffer.slice(state.scanBuffer.length - keep)
          writeRawFor(state, ready)
        }
        return
      }
      const before = state.scanBuffer.slice(0, index)
      writeRawFor(state, before)
      state.scanBuffer = state.scanBuffer.slice(index + TERMINAL_READY_MARKER.length)
      while (state.scanBuffer.length > 0) {
        const first = state.scanBuffer.charAt(0)
        if (first === String.fromCharCode(10) || first === String.fromCharCode(13)) { state.scanBuffer = state.scanBuffer.slice(1); continue }
        break
      }
      state.promptDrawn = false
      state.line = ""
      drawTerminalPromptFor(state)
    }
  }

  function writeTerminalFor(state, text) {
    processOutputFor(state, text)
  }

  function writeTerminal(text) {
    writeTerminalFor(panel.terminal, text)
  }

  function terminalPromptTextFor(state) {
    const where = state.cwd || ""
    const name = where ? baseOf(where) : ""
    return (name || "~") + " " + String.fromCharCode(0x276f) + " "
  }

  function terminalPromptText() {
    return terminalPromptTextFor(panel.terminal)
  }

  function drawTerminalPromptFor(state) {
    const term = state.xterm
    if (not(term) || state.promptDrawn) return
    if (state.outputEndsNL === false) {
      term.write(String.fromCharCode(13) + String.fromCharCode(10))
      state.outputEndsNL = true
    }
    term.write(String.fromCharCode(27) + "[36m" + terminalToXterm(terminalPromptTextFor(state)) + String.fromCharCode(27) + "[0m")
    state.promptDrawn = true
    state.outputEndsNL = false
  }

  function drawTerminalPrompt() {
    drawTerminalPromptFor(panel.terminal)
  }

  function redrawTerminalLine() {
    const term = panel.terminal.xterm
    if (not(term)) return
    term.write('\r\x1b[2K')
    panel.terminal.promptDrawn = false
    drawTerminalPrompt()
    if (panel.terminal.line) term.write(panel.terminal.line)
  }

  /** 新会话 / 换会话：清屏重来。xterm 走 reset，兜底走 buffer 清空 */
  function resetTerminalView() {
    panel.terminal.replayApplied = ''
    panel.terminal.scanBuffer = ''
    panel.terminal.line = ''
    panel.terminal.promptDrawn = false
    const term = ensureXterm()
    if (term) {
      try { term.reset() } catch (error) {}
      return
    }
    panel.terminal.buffer = ''
    renderTerminalBuffer()
  }

  function rememberTerminalHistory(text) {
    if (panel.terminal.history[panel.terminal.history.length - 1] === text) return
    panel.terminal.history.push(text)
    if (panel.terminal.history.length > 100) panel.terminal.history.shift()
  }

  /** 用户敲键（xterm onData）。行编辑在渲染层做：管道 shell 没有 tty，
      自己回显才有真终端的手感 —— 回显 / 退格 / 上下历史 / Ctrl+C 全在这。
      单键是一段一个字符；粘贴是一整段 —— 除转义序列外逐字符处理。 */
  function handleTerminalData(data) {
    const term = panel.terminal.xterm
    if (not(term) || not(data)) return
    /* 方向键等转义序列必须整段判，拆开就没意义了；其余转义序列不处理 */
    if (data === '\x1b[A' || data === '\x1b[B') {
      terminalHistory(data === '\x1b[A' ? 1 : -1)
      return
    }
    if (data.charAt(0) === '\x1b') return
    for (const ch of String(data)) {
      if (ch === '\r' || ch === '\n') {
        const text = panel.terminal.line
        term.write('\r\n')
        panel.terminal.line = ''
        panel.terminal.promptDrawn = false
        if (text) rememberTerminalHistory(text)
        commitTerminalLine(text)
        continue
      }
      if (ch === '\x7f') {
        if (panel.terminal.line) {
          panel.terminal.line = panel.terminal.line.slice(0, -1)
          term.write('\b \b')
        }
        continue
      }
      if (ch === String.fromCharCode(3)) {
        term.write("^C" + String.fromCharCode(13) + String.fromCharCode(10))
        const state = panel.terminal
        state.line = ""
        state.promptDrawn = false
        state.outputEndsNL = true
        const cwd = state.cwd || (panel.roots[0] && panel.roots[0].path) || ""
        if (state.sid && cwd) restartTerminalAt(cwd)
        continue
      }
      /* 可见字符才回显 */
      if (ch.charCodeAt(0) >= 32) {
        drawTerminalPrompt()
        panel.terminal.line += ch
        term.write(ch)
      }
    }
  }

  async function commitTerminalLine(text) {
    const api = termApi()
    if (not(api)) return
    if (not(panel.terminal.sid)) await openTerminalSession()
    try {
      await api.termWrite(panel.terminal.sid, text)
    } catch (error) { /* 服务断了：输出区很快会看到断开，这里不弹框 */ }
    /* cd 之后 shell 的真实 cwd 只有服务端能查到（无 tty 收不到通知）：
       延迟一下让 cd 先生效，再拉 state 刷新目录列表和提示符文案 */
    if (/^\s*cd\s/.test(text) && panel.terminal.sid) {
      setTimeout(async () => {
        try {
          /* ⚠️ 必须带 sid：不带的话服务端（多会话版）返回 {sessions:[...]}，
             拿不到 cwd，cd 后的目录显示就不会更新 */
          const st = await api.termState(panel.terminal.sid)
          if (st && st.sid === panel.terminal.sid && st.cwd && st.cwd !== panel.terminal.cwd) {
            panel.terminal.cwd = st.cwd
            renderTerminalDirs()
          }
        } catch (error) { /* 断了就算了 */ }
      }, 800)
    }
  }

  /** payload = { replay|data: base64, closed?: true } —— 与两条入口的约定一致 */
  /** xterm 里还有没有内容：用来判断「重开面板 / 重启界面后 xterm 是空实例、
      需要让服务端 replay 把历史补回来」（用户：重开就只剩提示符，命令结果没了） */
  function terminalHasContent(state) {
    const term = state && state.xterm
    if (not(term)) return false
    try {
      const buf = term.buffer.active
      for (let index = 0; index < buf.length; index += 1) {
        const line = buf.getLine(index)
        if (line && line.translateToString(true).trim() !== '') return true
      }
      return false
    } catch (error) {
      return true /* 读不到就当有内容，别乱重放 */
    }
  }

  function handleTerminalPayload(state, payload) {
    if (not(payload) || not(state)) return
    if (payload.replay !== undefined) {
      const text = decodeBytes(base64ToBytes(payload.replay)).text || ""
      const term = state.xterm
      if (term) {
        if (state.replayApplied === state.sid) return
        state.replayApplied = state.sid
        if (not(text)) return
        state.scanBuffer = ""
        state.promptDrawn = false
        state.line = ""
        try { term.reset() } catch (error) {}
        processOutputFor(state, text)
        return
      }
      state.buffer = text
      state.scanBuffer = ""
      if (state.tabId === panel.activeTerminalId) renderTerminalBuffer()
      return
    }
    if (payload.data !== undefined) {
      writeTerminalFor(state, decodeBytes(base64ToBytes(payload.data)).text || "")
      return
    }
    if (payload.closed) {
      state.sid = ""
      state.picker = true
      if (state.tabId === panel.activeTerminalId) {
        renderTerminalDirs()
        state.promptDrawn = false
        drawTerminalPromptFor(state)
      }
    }
  }

  function subscribeTerminal() {
    const state = panel.terminal
    if (state.unsubscribe) return

    const api = termApi()
    if (not(api) || not(state.sid)) return
    state.unsubscribe = api.termSubscribe(state.sid, (payload) => handleTerminalPayload(state, payload))
  }

  async function openTerminalSession() {
    const state = panel.terminal
    if (not(state)) return
    const api = termApi()
    if (not(api)) {
      writeTerminalFor(state, String.fromCharCode(10) + "[terminal not supported]" + String.fromCharCode(10))
      return
    }
    if (state.busy) return
    if (not(state.sid)) {
      state.picker = true
      if (not(state.cwd) && panel.roots.length > 0) state.cwd = panel.roots[0].path
      if (state.tabId === panel.activeTerminalId) {
        renderTerminalDirs()
        state.promptDrawn = false
        drawTerminalPromptFor(state)
      }
      return
    }
    state.busy = true
    try {
      const st = await api.termState(state.sid)
      const alive = st && st.alive === true && st.sid === state.sid
      if (alive) {
        state.cwd = st.cwd || state.cwd
        state.picker = false
        /* xterm 是空实例（重开面板/重启界面/新 host）→ 强制走 replay 补历史 */
        if (not(terminalHasContent(state))) state.replayApplied = ""
        subscribeTerminal()
        drawTerminalPromptFor(state)
        if (state.tabId === panel.activeTerminalId) {
          renderTerminalDirs()
          renderTerminalTabs()
        }
        return
      }
      state.sid = ""
      const fallback = state.cwd || (panel.roots[0] && panel.roots[0].path) || ""
      if (fallback) {
        state.busy = false
        await restartTerminalAt(fallback)
        return
      }
      state.picker = true
      if (state.tabId === panel.activeTerminalId) {
        renderTerminalDirs()
        state.promptDrawn = false
        drawTerminalPromptFor(state)
      }
    } catch (error) {
      writeTerminalFor(state, String.fromCharCode(10) + "[terminal failed: " + (error && error.message ? error.message : error) + "]" + String.fromCharCode(10))
    } finally {
      state.busy = false
    }
  }

  /** 路径去重用的归一化键：尾斜杠 / 大小写差异不该产生「重复目录」。
      为什么要这个：服务端 lsof 查回来的 cwd 和 roots 里的字符串可能只是长得不一样，
      列表上就多出一条看着一样的目录（用户：来回切换就多一个目录）。 */
  function pathKey(value) {
    return String(value || '').replace(/[/\\]+$/, '').toLowerCase()
  }

  function renderTerminalDirs() {
    const host = byId('terminalDirs')
    const label = byId('terminalCwdLabel')
    if (not(host)) return
    const options = []
    const seen = {}
    for (const root of panel.roots) {
      if (root && root.path && not(seen[pathKey(root.path)])) {
        seen[pathKey(root.path)] = true
        options.push({ path: root.path, name: root.name || baseOf(root.path) })
      }
    }
    if (panel.terminal.cwd && not(seen[pathKey(panel.terminal.cwd)])) {
      options.push({ path: panel.terminal.cwd, name: baseOf(panel.terminal.cwd) })
    }
    panel.terminal.cwdOptions = options
    host.textContent = ''
    options.forEach((option, index) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'terminal-dir-item' + (pathKey(option.path) === pathKey(panel.terminal.cwd) ? ' on' : '')
      item.setAttribute('data-path', option.path)
      item.title = option.path
      const num = document.createElement('span')
      num.className = 'terminal-dir-num'
      num.textContent = String(index + 1)
      const name = document.createElement('span')
      name.className = 'terminal-dir-name'
      name.textContent = option.name
      item.appendChild(num)
      item.appendChild(name)
      host.appendChild(item)
    })
    if (options.length > 1) {
      const hint = document.createElement('span')
      hint.className = 'terminal-dirs-hint'
      hint.textContent = '⌥ + 数字切换'
      host.appendChild(hint)
    }
    if (label) label.textContent = panel.terminal.cwd || ''
  }

  /** ⌥/Alt + 数字 → 切到第 N 个候选目录（xterm attachCustomKeyEventHandler 调；
      命中要 return false，xterm 就不会再把这个键喂进输入行） */
  function terminalDirHotkey(event) {
    const match = /^Digit([1-9])$/.test(String(event.code || '')) ? RegExp.$1 : ''
    if (not(match)) return true
    if (not(event.altKey || event.metaKey || event.ctrlKey)) return true
    const option = (panel.terminal.cwdOptions || [])[Number(match) - 1]
    if (not(option) || pathKey(option.path) === pathKey(panel.terminal.cwd)) return false
    restartTerminalAt(option.path)
    return false
  }

  /** 换工作目录 = 顶掉旧会话开新的（管道终端没法从外面 chdir） */
  async function restartTerminalAt(cwd) {
    if (not(cwd)) return
    const state = panel.terminal
    const api = termApi()
    if (not(api) || not(state)) return
    if (state.unsubscribe) {
      state.unsubscribe()
      state.unsubscribe = null
    }
    if (state.sid) {
      try { await api.termKill(state.sid) } catch (error) {}
    }
    state.sid = ""
    state.cwd = cwd
    state.picker = false
    state.replayApplied = ""
    resetTerminalView()
    try {
      const started = await api.termStart(cwd)
      state.sid = started.sid
      state.cwd = started.cwd
      state.title = baseOf(started.cwd) || "terminal"
      state.picker = false
      state.replayApplied = ""
      resetTerminalView()
      subscribeTerminal()
      state.promptDrawn = false
      drawTerminalPromptFor(state)
      renderTerminalDirs()
      renderTerminalTabs()
      saveTerminalTabs()
    } catch (error) {
      writeTerminalFor(state, String.fromCharCode(10) + "[terminal failed: " + (error && error.message ? error.message : error) + "]" + String.fromCharCode(10))
    }
  }

  function terminalHistory(direction) {
    const term = panel.terminal.xterm
    if (not(term) || not(panel.terminal.history.length)) return
    if (direction > 0) {
      panel.terminal.histIndex = Math.min(panel.terminal.histIndex + 1, panel.terminal.history.length - 1)
    } else {
      panel.terminal.histIndex = Math.max(panel.terminal.histIndex - 1, -1)
    }
    panel.terminal.line = panel.terminal.histIndex >= 0 ? panel.terminal.history[panel.terminal.histIndex] : ''
    redrawTerminalLine()
  }

  function setupTerminal() {
    /* 上次拖出来的终端高度记得恢复（clamp 一下，防窗口变小后爆掉） */
    panel.terminal.height = clampTerminalHeight(readJSON(TERMINAL_HEIGHT_KEY, TERMINAL_HEIGHT_DEFAULT), 0)
    applyTerminalHeight()
    /* 编号目录列表：点击切换（委托监听，列表是后画的也点得到） */
    const dirs = byId('terminalDirs')
    if (dirs) {
      dirs.addEventListener('click', (event) => {
        const item = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('.terminal-dir-item')
          : null
        if (not(item)) return
        restartTerminalAt(item.getAttribute('data-path'))
      })
    }
    const clear = byId('terminalClear')
    if (clear) {
      clear.addEventListener('click', () => {
        panel.terminal.line = ''
        panel.terminal.promptDrawn = false
        const term = panel.terminal.xterm
        if (term) {
          try { term.clear() } catch (error) {}
          return
        }
        panel.terminal.buffer = ''
        renderTerminalBuffer()
      })
    }
    const newButton = byId("terminalNew")
    if (newButton) newButton.addEventListener("click", () => newTerminalTab())
    restoreTerminalTabs()
    renderTerminalTabs()
    bindTerminalResize()
    window.addEventListener('resize', fitTerminal)
    /* 容器尺寸一变就重新 fit（拖面板宽/拖终端高/切标签都自愈，不用每个入口记得手调） */
    if (typeof ResizeObserver === 'function') {
      const out = byId('terminalOut')
      if (out) {
        terminalResizeObserver = new ResizeObserver(() => fitTerminal())
        terminalResizeObserver.observe(out)
      }
    }
    /* 测试钩子：check:drag 用它模拟敲键盘（跟 xterm onData 同一条链路） */
    window.__dshTerminalInput = handleTerminalData
    window.__dshTermState = panel.terminal
  }

  /* ------------------------------------------------------------ 启动 */

  /** 标签多了要能横向滚：CSS 里已有 overflow-x:auto（滚动条隐藏），
      但鼠标滚轮默认只会上下滚 —— 这里把滚轮搬成横向。
      （用户：标签页太多肯定要支持标签区域横向滚动） */
  function setupTabsScroller() {
    const host = byId('panelTabs')
    if (not(host)) return
    host.addEventListener('wheel', (event) => {
      if (not(host.scrollWidth > host.clientWidth)) return
      event.preventDefault()
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      host.scrollLeft += delta
    }, { passive: false })
  }

  function init() {
    if (not(byId('filePanel'))) return

    /* 面板顶栏那几枚按钮也带 data-icon，app.js 的 applyIcons 跑过一遍，这里兜一次底
       （比如 app.js 早期抛错时面板仍要完整显示） */
    if (window.applyIcons) window.applyIcons(document)

    applyWidth(Number(localStorage.getItem(WIDTH_KEY)) || defaultWidth(window.innerWidth))
    applyExplorer(Number(localStorage.getItem(EXPLORER_WIDTH_KEY)) || DEFAULT_EXPLORER)
    setExplorer(localStorage.getItem(EXPLORER_KEY) !== '0')
    setupResize()
    setupTabsScroller()
    setupTerminal()
    bindClick()
    renderTabs()
    renderPreview()

    refreshSessionContext()

    if (dsh() && typeof dsh().onEvent === 'function') {
      dsh().onEvent(handleEvent)
    }

    const wantOpen = localStorage.getItem(OPEN_KEY) === '1'
    if (wantOpen) setOpen(true)

    /* 窗口尺寸变了要重新夹一次宽度 */
    window.addEventListener('resize', () => {
      applyWidth(panel.width)
    })

    /* 关页面/重启前把最后一段写掉。异步的写不一定跑得完，但防抖只有 350ms，
       真正能丢的也就是「打完最后一个字就立刻关窗」那一瞬 —— 值得试一次。 */
    window.addEventListener('beforeunload', () => {
      flushSave()
    })
  }

  /**
   * 对外只暴露窗口级入口，供 app.js / 冒烟脚本驱动。
   * （内部状态一律留在闭包里，免得两个文件互相改。）
   *
   * ⚠️ 先挂 window.filePanel、**再**跑 init()：init 里只要有一处抛异常，
   *    不能把整个 IIFE 带走 —— 那样接口也没了，外面连「面板坏了」都看不出来。
   */
  window.filePanel = {
    init: init,
    setContext: setContext,
    toggle: toggleOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => panel.open,
    openFile: openFile,
    refresh: () => loadRoots(),
    /* 纯函数，方便冒烟直接单测 */
    decodeBytes: decodeBytes,
    encodeText: encodeText,
    detectEol: detectEol,
    applyEol: applyEol,
    bytesToBase64: bytesToBase64,
    canEdit: canEdit,
    clampWidth: clampWidth,
    clampExplorer: clampExplorer,
    defaultWidth: defaultWidth,
    fmtSize: fmtSize,
    baseOf: baseOf,
    absoluteFor: absoluteFor,
    /* 编辑器的动作入口，真机冒烟也从这几条走（与点按钮同一条路） */
    startEdit: startEdit,
    stopEdit: stopEdit,
    flushSave: flushSave,
    _state: panel,
    rememberSessionFile: (target) => {
      refreshSessionContext()
      beforeRemember(String(target || ''))
    }
  }

  function start() {
    try {
      init()
    } catch (error) {
      console.error('[filePanel] 初始化失败', error)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }

  window.addEventListener('beforeunload', () => {
    window.removeEventListener('resize', fitTerminal)
    if (terminalResizeObserver) terminalResizeObserver.disconnect()
    terminalResizeObserver = null
    for (const tab of panel.terminalTabs) {
      if (tab.unsubscribe) tab.unsubscribe()
      tab.unsubscribe = null
      if (tab.idlePromptTimer) clearTimeout(tab.idlePromptTimer)
      tab.idlePromptTimer = null
      if (tab.xterm) {
        try { tab.xterm.dispose() } catch (error) {}
      }
      tab.xterm = null
    }
  })
})()
