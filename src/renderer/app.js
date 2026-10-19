'use strict'

const not = (value) => value ? false : true
const state = {
  settings: null,
  workspacePath: '',
  currentAssistant: null,
  currentThinking: null,
  waitingTimer: null,
  projectFolders: [],
  dirSelectCallback: null,
  currentDirData: null,
  currentSessionId: '',
  expandedProjects: {},
  sectionCollapsed: { projects: false, recent: false },
  /* 哪些会话正在跑：sessionId → true。
     多实例后端（一条会话一台 worker，见 src/main/agent/agent-pool.js）下这是**按会话**
     记账的 —— A 在跑不影响 B 发消息，用户 2026-09-19 明确要的就是这个。
     以前这里只存「当前在跑哪一条」的单个字符串，表达不了两条并行。 */
  runs: {},
  /* 后台会话的思考过程累积区：sessionId → 游离的 .thinking-content 节点。
     并发之后一条会话完全可能在后台跑完（用户正看着别的会话），它的过程事件不再进 DOM，
     但过程本身不能丢 —— 见 processRecord()。 */
  processBuffers: {},
  /* 本轮思考块**之外**、这条会话已经记下的过程（上一轮及更早）。
     saveThinkingProcess 用它兜底拼在前面 —— 新一轮开始会新起一块，
     不兜底就会「写回时只剩本轮」，上一轮的过程在重载后整段消失（用户 2026-09-23 报的丢失）。
     谁新起一块谁负责设它：另起（beginThinking）时设成此前的 processHtml，续接（resumeThinking）
     时设成空串（已有内容就在块里，再兜一次就重复了）。 */
  thinkingBase: '',
  /* 授权弹窗是单槽的（state.approvalResolver），两条会话同时要授权时必须排队，
     否则后到的会抢掉槽位、先弹的那个永远等不到答复（服务端要干等到 5 分钟超时）。 */
  approvalQueue: [],
  approvalBusy: false,
  /* 当前弹窗正在替哪个授权请求等答复（服务端的 approval id）。
     服务端 5 分钟超时会广播一条 expired，必须凭它把还开着的弹窗收掉 ——
     不收的话 approvalBusy 永远释放不了，之后所有会话的授权都会静静排队、永远不弹。 */
  approvalCurrentId: '',
  menuSession: null,
  menuProject: null,
  editingProjectId: '',
  confirmResolver: null,
  approvalResolver: null,
  currentThinkingDetails: null,
  activeProjectId: '',
  pendingMessages: [],
  queueTimer: null,
  runPoll: null,
  /* 运行状态行（消息区底部「正在 读取 xxx…（12s）」）的刷新定时器与起始时刻。
     用户评审里最重的一条：消息发出去之后以前只有一条折叠条，看不出是在跑还是卡住了。 */
  runStatusTimer: null,
  runStartedAt: 0,
  /* 宿主报的并发上限（提示文案里用），0 = 没拿到 */
  runLimit: 0,
  expandedProviderId: '',
  liveRun: false
}

let sessionStore = {}
const syncedAssistantImages = new Set()

const ROLE_LABELS = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  'tool-result': '工具结果',
  thinking: '思考',
  error: '错误',
  notice: '提示'
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role
}

function translateStatus(text) {
  const value = String(text || '')
  if (value === 'model does not support tools; continuing without tools') return '当前模型不支持工具调用，已切换为纯聊天模式'
  if (value === 'running') return '\u4e0a\u4e00\u6761\u4efb\u52a1\u4ecd\u5728\u6267\u884c\uff0c\u7b49\u5f85\u5b8c\u6210'
  if (value === 'reset') return '\u4efb\u52a1\u5df2\u91cd\u7f6e\uff0c\u53ef\u4ee5\u7ee7\u7eed\u53d1\u9001'
  if (value === 'queued') return '\u5df2\u52a0\u5165\u53d1\u9001\u961f\u5217\uff0c\u7b49\u5f85\u4e0a\u4e00\u6761\u5b8c\u6210'
  if (value === 'permission readonly') return '\u4ec5\u53ef\u67e5\u770b'
  if (value === 'permission workspace') return '\u5de5\u4f5c\u533a\u5185\u4fee\u6539'
  if (value === 'permission full') return '\u5b8c\u5168\u6743\u9650'
  if (value.startsWith('compressing context')) return '正在压缩上下文...'
  if (value.startsWith('context compressed')) return '上下文已压缩，继续任务'
  if (value.startsWith('asset save failed:')) return value.replace('asset save failed:', '资源保存失败：')
  if (value === 'models loaded') return '已获取可用模型'
  if (value === 'no models') return '没有取到可用模型'
  if (value === 'list models not supported') return '当前环境不支持获取模型列表'
  if (value === 'ready') return '就绪'
  if (value === 'connected') return '已连接'
  if (value === 'event stream disconnected') return '事件流已断开'
  if (value === 'settings saved') return '设置已保存'
  if (value === 'stopped by user') return '已停止'
  if (value === 'reached max iterations') return '达到最大轮次'
  if (value === 'workspace changed') return '工作区已切换'
  if (value === 'model created') return '模型已创建'
  if (value === 'model changed') return '模型已切换'
  if (value === 'theme changed') return '主题已切换'
  if (value === 'approval on') return '已切换为帮我批准'
  if (value === 'approval off') return '已切换为自动批准'
  if (value.startsWith('thinking (')) return value.replace('thinking (', '思考中 (')
  if (value.startsWith('session save failed:')) return value.replace('session save failed:', '会话保存失败：')
  return value
}

function activeModel() {
  const settings = state.settings || {}
  const models = Array.isArray(settings.models) ? settings.models : []
  return models.find((model) => model.id === settings.currentModelId) || models[0] || null
}

/* ---------------- 运行态：按会话记账 ----------------
   后端是多实例池（一条会话一台 worker），所以「谁在跑」必须按会话分开记。
   下面这几个小函数是唯一的读取口，别在别处直接摸 state.runs。 */

function isSessionRunning(sessionId) {
  if (not(sessionId)) return false
  return state.runs[sessionId] === true
}

/* 当前这条会话在不在跑 —— 发送/停止按钮、思考块只看它 */
function currentRunning() {
  return isSessionRunning(state.currentSessionId)
}

function addRun(sessionId) {
  if (not(sessionId)) return
  state.runs[sessionId] = true
}

function removeRun(sessionId) {
  if (not(sessionId)) return
  delete state.runs[sessionId]
}

/* 用宿主回报的 runningSessions 整份替换本地账本。
   老宿主只有全局 running（没有 runningSessions）：退化成「当前会话在跑」，
   和单实例时代的表现一致。 */
function applyRuns(sessions, anyRunning) {
  const next = {}
  if (Array.isArray(sessions)) {
    for (const id of sessions) {
      if (id) next[String(id)] = true
    }
  } else if (anyRunning === true && state.currentSessionId) {
    next[state.currentSessionId] = true
  }
  state.runs = next
}

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', value)
  const button = byId('themeToggle')
  const label = byId('themeLabel') || button
  if (label) label.textContent = '\u5207\u6362\u4e3b\u9898'
}

function fillModelSelect(select) {
  if (not(select)) return
  const settings = state.settings || {}
  const models = Array.isArray(settings.models) ? settings.models : []
  select.textContent = ''
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model.id
    option.textContent = model.name || model.model || model.id
    select.appendChild(option)
  }
  select.value = settings.currentModelId || (models[0] ? models[0].id : '')
}

function renderModelSelect() {
  renderComposerModel()
}

function renderComposerModel() {
  const menu = byId('composerModelMenu')
  const label = byId('composerModelLabel')
  if (not(menu)) return
  const active = activeModel()
  if (label) label.textContent = active ? (active.model || active.name || active.id || '\u9009\u62e9\u6a21\u578b') : '\u9009\u62e9\u6a21\u578b'
  menu.textContent = ''
  const providers = (state.settings && Array.isArray(state.settings.models)) ? state.settings.models : []
  for (const provider of providers) {
    const group = document.createElement('div')
    group.className = 'dropdown-group'
    const title = document.createElement('div')
    title.className = 'dropdown-group-title'
    title.textContent = provider.name || provider.model || provider.id
    group.appendChild(title)
    const names = (Array.isArray(provider.modelList) && provider.modelList.length > 0)
      ? provider.modelList.slice()
      : (provider.model ? [provider.model] : [])
    for (const name of names) {
      const isActive = active && provider.id === active.id && name === active.model
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'dropdown-item' + (isActive ? ' active' : '')
      const text = document.createElement('span')
      text.className = 'dropdown-item-label'
      text.textContent = name
      const check = document.createElement('span')
      check.className = 'dropdown-check icon'
      check.innerHTML = window.renderIcon('check')
      check.classList.toggle('hidden', not(isActive))
      item.appendChild(text)
      item.appendChild(check)
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        closeComposerModelMenu()
        selectProviderModel(provider.id, name).catch(noopError)
      })
      group.appendChild(item)
    }
    if (names.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'dropdown-group-empty'
      empty.textContent = '\u672a\u914d\u7f6e\u6a21\u578b'
      group.appendChild(empty)
    }
    menu.appendChild(group)
  }
  if (providers.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'dropdown-group-empty'
    empty.textContent = '\u8fd8\u6ca1\u6709\u6a21\u578b'
    menu.appendChild(empty)
  }
}

function closeComposerModelMenu() {
  const menu = byId('composerModelMenu')
  const dropdown = byId('composerModelDropdown')
  if (menu) menu.classList.add('hidden')
  if (dropdown) dropdown.classList.remove('open')
}

function setupComposerModelDropdown() {
  const trigger = byId('composerModelTrigger')
  const menu = byId('composerModelMenu')
  if (not(trigger) || not(menu)) return
  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    const willOpen = menu.classList.contains('hidden')
    closePermissionMenus()
    menu.classList.toggle('hidden', not(willOpen))
    const dropdown = byId('composerModelDropdown')
    if (dropdown) dropdown.classList.toggle('open', willOpen)
  })
  document.addEventListener('click', () => closeComposerModelMenu())
}
function workspaceLabel(value) {
  const text = String(value || '')
  const parts = text.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : text
}

/* ---------------- 渲染层会话/偏好 storage：localStorage + 服务端 ui-store 双写 ----------------
   localStorage 按 origin（协议+主机+端口）隔离 —— 8080 被别的程序占、服务跳 8081 时
   origin 就换了，光靠 localStorage 会话列表「看起来空了」（数据没删，回原端口还在）。
   所以把这份 store 双写到服务端 /api/ui-store（落 AGENT_HOME/ui-store.json，与端口无关，
   见 server/ui-store.js）：
     加载：服务端优先；服务端是空的才用 localStorage，并在随后的保存里把它推上去（迁移）；
     保存：localStorage 立即照旧（同步兜底）+ in-flight 合并 PUT（写盘中来了新数据
           就记 pending，写完补一轮，全程至多一个在途请求）。
   宿主没有这两个方法（老壳/老服务）或请求失败时退化为纯 localStorage，行为同旧版。 */

let uiStoreRemoteCurrentSessionId = '' /* 服务端记录的「当前会话」，加载后由 readSavedCurrentSessionId 优先取 */
let uiPrefsFromServer = null /* 服务端 prefs（sectionCollapsed/sidebarCollapsed/messageWidth/sentHistory） */
const uiStorePush = { inFlight: false, dirty: false, retryTimer: null, retryDelay: 1000 }
let composerObserver = null

function uiStoreApi() {
  return window.dsh && typeof window.dsh.uiStoreGet === 'function' && typeof window.dsh.uiStorePut === 'function'
    ? window.dsh
    : null
}

function buildUiStorePayload() {
  let sectionCollapsed = {}
  try {
    sectionCollapsed = JSON.parse(localStorage.getItem('dsh-section-collapsed') || '{}')
  } catch (error) {}
  return {
    sessions: sessionStore,
    currentSessionId: state.currentSessionId || '',
    prefs: {
      sectionCollapsed: sectionCollapsed,
      sidebarCollapsed: localStorage.getItem('dsh-sidebar-collapsed') === '1',
      messageWidth: Number(localStorage.getItem('dsh-message-width')) || 0,
      sentHistory: sentHistory.slice(0, SENT_HISTORY_LIMIT)
    }
  }
}

function scheduleUiStorePush() {
  uiStorePush.dirty = true
  /* 本地时间戳：加载时和服务端的 updatedAt 比「谁新」——
     关窗瞬间在途 PUT 被掐、或双客户端互相覆盖时，本地这份更新的不能被服务端旧数据盖掉。 */
  try {
    localStorage.setItem('dsh-ui-store-stamp', String(Date.now()))
  } catch (error) {}
  if (uiStorePush.inFlight) return
  flushUiStorePush()
}

async function flushUiStorePush() {
  const api = uiStoreApi()
  if (not(api) || uiStorePush.inFlight) return
  uiStorePush.inFlight = true
  try {
    /* while：写盘的那几百毫秒里可能又保存了几次，补发到干净为止 */
    while (uiStorePush.dirty) {
      uiStorePush.dirty = false
      await api.uiStorePut(buildUiStorePayload())
    }
    uiStorePush.retryDelay = 1000
  } catch (error) {
    uiStorePush.dirty = true
    if (not(uiStorePush.retryTimer)) {
      const delay = uiStorePush.retryDelay
      uiStorePush.retryDelay = Math.min(delay * 2, 30000)
      uiStorePush.retryTimer = setTimeout(() => {
        uiStorePush.retryTimer = null
        flushUiStorePush()
      }, delay)
    }
  } finally {
    uiStorePush.inFlight = false
  }
  if (uiStorePush.dirty && not(uiStorePush.retryTimer)) flushUiStorePush()
}

/* 关窗补刀：unload 阶段 fetch/invoke 不保证送达，sendBeacon 是浏览器保证「尽量发出」的
   那条通道。就算 beacon 也丢了，本地时间戳（dsh-ui-store-stamp）比服务端新，
   下次启动会以本地为准补送 —— 丢不了。 */
function beaconUiStore() {
  if (not(uiStorePush.dirty) && not(uiStorePush.inFlight)) return
  if (not(navigator.sendBeacon)) return
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return
  try {
    const blob = new Blob([JSON.stringify(buildUiStorePayload())], { type: 'text/plain' })
    navigator.sendBeacon('/api/ui-store', blob)
  } catch (error) { /* 尽力而为 */ }
}

async function loadSessionStore() {
  try {
    sessionStore = JSON.parse(localStorage.getItem('dsh-sessions-v1') || '{}')
  } catch (error) {
    sessionStore = {}
  }
  uiStoreRemoteCurrentSessionId = ''
  uiPrefsFromServer = null
  const api = uiStoreApi()
  if (api) {
    try {
      const response = await api.uiStoreGet()
      const store = response && response.store ? response.store : null
      const remoteSessions = store && store.sessions ? store.sessions : null
      const remoteHasData = Boolean(remoteSessions) && Object.keys(remoteSessions).some(
        (key) => Array.isArray(remoteSessions[key]) && remoteSessions[key].length > 0
      )
      /* 新鲜度对表：本地保存时间戳比服务端 updatedAt 新（>1.5s 容差）说明
         上一次 PUT 没送到（关窗/崩溃/双客户端竞争）——这时**本地为准**，
         migrateSessionStore 的保存会把本地这份再推上去。不然最后一次
         「思考过程/消息」的保存会被服务端旧快照盖掉（用户报的「过程有时丢」）。 */
      const serverUpdatedAt = Number(response && response.store && response.store.updatedAt) || 0
      let localStamp = 0
      try {
        localStamp = Number(localStorage.getItem('dsh-ui-store-stamp')) || 0
      } catch (error) {}
      const localIsNewer = localStamp > serverUpdatedAt + 1500
      if (remoteHasData && not(localIsNewer)) {
        /* 服务端有数据且不比本地旧：以它为准（这才是「跟端口走」的那份） */
        sessionStore = remoteSessions
        uiStoreRemoteCurrentSessionId = String((store && store.currentSessionId) || '')
        uiPrefsFromServer = (store && store.prefs) || null
      }
      /* 服务端是空的（或本地更新）→ 保留 localStorage 的数据，migrateSessionStore 的保存会把它推上去（迁移/补送） */
    } catch (error) {
      /* GET 失败：回落 localStorage，行为同旧版 */
    }
  }
  /* 迁移会立即双写。先恢复当前会话，否则首轮 PUT 会把服务端记录的
     currentSessionId 覆盖成启动时的空串，最近会话在下次启动时就恢复不了。 */
  const savedSession = findSessionById(readSavedCurrentSessionId())
  state.currentSessionId = savedSession ? savedSession.id : ''
  migrateSessionStore()
}

function migrateSessionStore() {
  const recent = []
  for (const key of Object.keys(sessionStore)) {
    if (key === '__recent__') continue
    const list = Array.isArray(sessionStore[key]) ? sessionStore[key] : []
    sessionStore[key] = list.filter((session) => {
      if (session.scope === 'recent') {
        recent.push(session)
        return false
      }
      if (not(session.scope)) session.scope = 'project'
      return true
    })
  }
  if (recent.length > 0) {
    sessionStore.__recent__ = (Array.isArray(sessionStore.__recent__) ? sessionStore.__recent__ : []).concat(recent)
  }
  if (not(Array.isArray(sessionStore.__recent__))) sessionStore.__recent__ = []
  saveSessionStore()
}

function saveSessionStore() {
  try {
    localStorage.setItem('dsh-sessions-v1', JSON.stringify(sessionStore))
  } catch (error) {}
  scheduleUiStorePush()
}

function saveCurrentSessionId(sessionId) {
  try {
    if (sessionId) localStorage.setItem('dsh-current-session', sessionId)
    else localStorage.removeItem('dsh-current-session')
  } catch (error) {}
  /* 调用点都在 state.currentSessionId 更新之后，payload 里直接带权威值 */
  syncFilePanelContext()
  scheduleUiStorePush()
}

function readSavedCurrentSessionId() {
  /* 服务端记录的优先（跟端口无关的那份）；没有再退回本 origin 的 localStorage */
  if (uiStoreRemoteCurrentSessionId) return uiStoreRemoteCurrentSessionId
  try {
    return localStorage.getItem('dsh-current-session') || ''
  } catch (error) {
    return ''
  }
}

/* loadSessionStore 拿到服务端 prefs 后，把那些「init 开头已经按 localStorage 先画过一遍」
   的界面状态再校正一次（侧边栏折叠 / 消息区宽度 / 项目·最近折叠 / 输入历史）。 */
function applyUiPrefsFromServer() {
  if (not(uiPrefsFromServer)) return
  const app = byId('app')
  if (app && typeof uiPrefsFromServer.sidebarCollapsed === 'boolean') {
    const button = byId('sidebarToggle')
    app.classList.toggle('sidebar-collapsed', uiPrefsFromServer.sidebarCollapsed === true)
    if (button) button.title = uiPrefsFromServer.sidebarCollapsed ? '\u5c55\u5f00\u4fa7\u8fb9\u680f' : '\u6298\u53e0\u4fa7\u8fb9\u680f'
  }
  const savedWidth = Number(uiPrefsFromServer.messageWidth)
  if (savedWidth >= 480) document.documentElement.style.setProperty('--message-width', savedWidth + 'px')
  loadSectionCollapsed()
  applySectionCollapse()
  loadSentHistory()
}

/* ---- 侧边栏「项目 / 最近」折叠 ---- */

const SECTION_IDS = { projects: 'sectionProjects', recent: 'sectionRecent' }

function loadSectionCollapsed() {
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem('dsh-section-collapsed') || '{}')
  } catch (error) {
    saved = {}
  }
  /* 服务端有就覆盖（跨端口一致的那份）；键不存在时保留 localStorage 的 */
  if (uiPrefsFromServer && uiPrefsFromServer.sectionCollapsed && typeof uiPrefsFromServer.sectionCollapsed === 'object') {
    saved = uiPrefsFromServer.sectionCollapsed
  }
  state.sectionCollapsed = {
    projects: saved.projects === true,
    recent: saved.recent === true
  }
}

function saveSectionCollapsed() {
  try {
    localStorage.setItem('dsh-section-collapsed', JSON.stringify(state.sectionCollapsed))
  } catch (error) {}
  scheduleUiStorePush()
}

function applySectionCollapse() {
  for (const key of Object.keys(SECTION_IDS)) {
    const section = byId(SECTION_IDS[key])
    if (not(section)) continue
    section.classList.toggle('collapsed', state.sectionCollapsed[key] === true)
  }
}

function toggleSectionCollapse(key) {
  if (key !== 'projects' && key !== 'recent') return
  state.sectionCollapsed[key] = not(state.sectionCollapsed[key] === true)
  saveSectionCollapsed()
  applySectionCollapse()
}

/* ---- 输入框上下键翻历史发送记录（最下方为空） ---- */

const SENT_HISTORY_KEY = 'dsh-sent-history'
const SENT_HISTORY_LIMIT = 100
let sentHistory = []
let sentHistoryIndex = -1 /* -1 = 底部空位（不在翻历史） */
let inputDraftBeforeHistory = ''

function loadSentHistory() {
  let raw = null
  /* 服务端有就用服务端的（跨端口一致） */
  if (uiPrefsFromServer && Array.isArray(uiPrefsFromServer.sentHistory)) {
    raw = uiPrefsFromServer.sentHistory
  }
  if (raw === null) {
    try {
      raw = JSON.parse(localStorage.getItem(SENT_HISTORY_KEY) || '[]')
    } catch (error) {
      raw = []
    }
  }
  sentHistory = Array.isArray(raw)
    ? raw.map((item) => String(item || '')).filter((item) => item !== '').slice(0, SENT_HISTORY_LIMIT)
    : []
}

function rememberSentMessage(text) {
  const value = String(text || '').replace(/\s+$/, '')
  if (value === '') return
  const existing = sentHistory.indexOf(value)
  if (existing !== -1) sentHistory.splice(existing, 1)
  sentHistory.unshift(value)
  if (sentHistory.length > SENT_HISTORY_LIMIT) sentHistory.length = SENT_HISTORY_LIMIT
  try {
    localStorage.setItem(SENT_HISTORY_KEY, JSON.stringify(sentHistory))
  } catch (error) {}
  scheduleUiStorePush()
  sentHistoryIndex = -1
  inputDraftBeforeHistory = ''
}

function setInputContent(text) {
  const input = byId('input')
  if (not(input)) return
  input.innerHTML = ''
  while (input.childNodes && input.childNodes.length) input.removeChild(input.childNodes[0])
  if (text !== '') input.appendChild(document.createTextNode(text))
  try {
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
    if (selection && document.createRange) {
      const range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  } catch (error) {}
  autoResizeComposer()
}

function navigateSentHistory(direction) {
  const input = byId('input')
  if (not(input) || sentHistory.length === 0) return
  if (direction === 'up') {
    if (sentHistoryIndex === -1) {
      inputDraftBeforeHistory = input.textContent
      sentHistoryIndex = 0
    } else if (sentHistoryIndex < sentHistory.length - 1) {
      sentHistoryIndex += 1
    } else {
      return
    }
  } else {
    if (sentHistoryIndex === -1) return
    if (sentHistoryIndex > 0) {
      sentHistoryIndex -= 1
    } else {
      sentHistoryIndex = -1
      setInputContent(inputDraftBeforeHistory)
      inputDraftBeforeHistory = ''
      return
    }
  }
  setInputContent(sentHistory[sentHistoryIndex] || '')
}

function getProjectSessions(projectId) {
  if (not(projectId)) return []
  const sessions = Array.isArray(sessionStore[projectId]) ? sessionStore[projectId] : []
  return sessions.filter((session) => session.archived !== true).sort((a,b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
}

function getRecentSessions() {
  const sessions = Array.isArray(sessionStore.__recent__) ? sessionStore.__recent__ : []
  return sessions.filter((session) => session.archived !== true).sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
}

async function openSessionAssociation(initialMode) {
  const overlay=document.createElement('div'),card=document.createElement('section');overlay.className='artifact-overlay';card.className='quick-menu';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','新建会话');const prior=document.activeElement;let pending=false
  const close=()=>{if(pending)return;overlay.remove();if(prior&&prior.isConnected)prior.focus()}
  function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',async()=>{if(pending)return;pending=true;try{await fn()}catch(e){setStatus(e.message)}finally{pending=false}});card.append(b);return b}
  async function create(mode,item){let session
    if(mode==='project'){session=createSession(item.id,'新会话','project');state.expandedProjects[item.id]=true}
    else {session=createSession('','新会话','recent');if(mode==='knowledge'){try{const linked=await window.dsh.knowledgeRequest('bind-session',{sessionId:session.id,baseId:item.id,title:'知识库 · '+item.name});session.knowledgeBaseId=item.id;session.knowledgeBaseName=item.name;session.projectId='';session.workspacePath=linked.workspaceRoot;session.title='知识库 · '+item.name;saveSessionStore()}catch(e){sessionStore.__recent__=(sessionStore.__recent__||[]).filter(s=>s.id!==session.id);saveSessionStore();throw e}}}
    pending=false;close();await selectSession(session.id);setStatus(mode==='knowledge'?'已关联知识库：'+item.name:'新会话')
  }
  async function show(mode){card.textContent='';const title=document.createElement('h3');title.textContent=mode==='knowledge'?'选择知识库':mode==='project'?'选择项目':'新建会话';card.append(title)
    if(mode==='knowledge'){const data=await window.dsh.knowledgeRequest('list');for(const base of data.bases)button(base.name,()=>create('knowledge',base));if(!data.bases.length){const p=document.createElement('p');p.textContent='请先创建知识库';card.append(p)}}
    else if(mode==='project'){const projects=(state.settings&&state.settings.projects)||[];for(const project of projects)button(project.name,()=>create('project',project));if(!projects.length){const p=document.createElement('p');p.textContent='请先添加项目';card.append(p)}}
    else {button('普通会话（默认）',()=>create('normal'));button('关联项目',()=>show('project'));button('关联知识库',()=>show('knowledge'))}
    button('取消',async()=>{pending=false;close()});const first=card.querySelector('button');if(first)first.focus()
  }
  overlay.append(card);document.body.append(overlay);overlay.addEventListener('click',e=>{if(e.target===overlay)close()});overlay.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const items=Array.from(card.querySelectorAll('button')),first=items[0],last=items[items.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});await show(initialMode)
}

function createSession(projectId, title, scope) {
  const isRecent = scope === 'recent'
  if (not(projectId) && not(isRecent)) return null
  const session = {
    id: 'session_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId: isRecent ? '' : projectId || '',
    scope: isRecent ? 'recent' : 'project',
    workspacePath: state.workspacePath || '',
    title: title || '\u65b0\u4f1a\u8bdd',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  const key = isRecent ? '__recent__' : projectId
  sessionStore[key] = [session].concat(Array.isArray(sessionStore[key]) ? sessionStore[key] : [])
  saveSessionStore()
  return session
}

/* ---- 会话自动命名：第一条用户消息总结成短标题 ---- */

const AUTO_TITLE_LIMIT = 14
const DEFAULT_SESSION_TITLE = '\u65b0\u4f1a\u8bdd'

function summarizeTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  if (clean.length <= AUTO_TITLE_LIMIT) return clean
  return clean.slice(0, AUTO_TITLE_LIMIT) + '\u2026'
}

function maybeAutoTitle(session, text) {
  if (not(session)) return
  const current = String(session.title || '')
  if (current !== '' && current !== DEFAULT_SESSION_TITLE) return
  const summary = summarizeTitle(text)
  if (summary === '') return
  session.title = summary
  session.updatedAt = new Date().toISOString()
}

function ensureProjectSession(projectId) {
  if (not(projectId)) return null
  const sessions = getProjectSessions(projectId)
  return sessions.find((item) => item.id === state.currentSessionId) || sessions[0] || null
}

function currentSession() {
  return findSessionById(state.currentSessionId)
}

function renderWindowTitle() {
  const element = byId('windowTitle')
  if (not(element)) return
  const session = currentSession()
  const projectId = state.activeProjectId || (state.settings && state.settings.currentProjectId)
  const panelTitle = byId('panelTitle')
  const fileOnly = document.documentElement.classList.contains('chat-hidden')
  const title = fileOnly
    ? ((panelTitle && panelTitle.textContent) || '文件')
    : ((session && session.scope !== 'recent' && getProjectName(session.projectId || projectId)) || (session && session.title) || getProjectName(projectId) || '新会话')
  if (element.textContent !== title) element.textContent = title
  element.title = title
  document.title = title + ' · Agent'
  scheduleTitleAlignment()
}

let titleAlignmentFrame = null
function scheduleTitleAlignment() {
  if (typeof requestAnimationFrame !== 'function' || titleAlignmentFrame !== null) return
  titleAlignmentFrame = requestAnimationFrame(() => {
    titleAlignmentFrame = null
    const title = byId('windowTitle'), header = byId('titlebarDrag')
    const target = document.documentElement.classList.contains('chat-hidden') ? byId('panelTabs') : byId('messagesInner')
    if (!title || !header || !target) return
    const bounds = header.getBoundingClientRect()
    let safeLeft = bounds.left + parseFloat(getComputedStyle(header).paddingLeft || '0')
    for (const id of ['sidebarToggle', 'restoreChat', 'pageActions']) {
      const node = byId(id)
      if (!node) continue
      const rect = node.getBoundingClientRect()
      if (rect.width) safeLeft = Math.max(safeLeft, rect.right + 12)
    }
    const content = target.getBoundingClientRect()
    const left = Math.max(safeLeft, content.left + parseFloat(getComputedStyle(target).paddingLeft || '0'))
    const panel = byId('panelToggle')
    const right = panel ? panel.getBoundingClientRect().left - 12 : bounds.right - 144
    title.style.left = Math.round(left - bounds.left) + 'px'
    title.style.width = Math.max(0, Math.floor(right - left)) + 'px'
  })
}

function setupTitleAlignment() {
  window.addEventListener('resize', scheduleTitleAlignment)
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleTitleAlignment)
    for (const id of ['messagesInner', 'contentFrame', 'sidebar', 'filePanel']) {
      const node = byId(id)
      if (node) observer.observe(node)
    }
  }
  scheduleTitleAlignment()
}

function findSessionById(sessionId) {
  if (not(sessionId)) return null
  for (const projectId of Object.keys(sessionStore)) {
    const sessions = Array.isArray(sessionStore[projectId]) ? sessionStore[projectId] : []
    const found = sessions.find((session) => session.id === sessionId)
    if (found) return found
  }
  return null
}

function getAllSessions() {
  const result = []
  for (const projectId of Object.keys(sessionStore)) {
    const sessions = Array.isArray(sessionStore[projectId]) ? sessionStore[projectId] : []
    for (const session of sessions) result.push(session)
  }
  return result.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
}

function updateSessionMessages(sessionId, messages, memory) {
  const session = findSessionById(sessionId)
  if (not(session) || not(Array.isArray(messages))) return
  session.messages = messages
  if (memory === null) delete session.memory
  else if (memory && typeof memory === 'object' && memory.text) session.memory = memory
  session.updatedAt = new Date().toISOString()
  saveSessionStore()
}

function addThinkingBlock(html) {
  const container = messagesContent()
  const previous = container.children[container.children.length - 1]
  if (previous && previous.classList && previous.classList.contains('process-timeline')) {
    const prior = previous.querySelector('.thinking-content')
    if (prior) {
      prior.innerHTML += THINKING_TURN_SEP + (html || '')
      if (not(currentRunning())) for (const step of prior.querySelectorAll('.tl-running')) closeTimelineStep(step, 'interrupted')
      refreshTimelineSummary(previous, prior, false); return
    }
  }
  const details = document.createElement('details')
  details.open = true
  details.className = 'thinking-block process-timeline'
  const summary = document.createElement('summary')
  summary.textContent = '思考过程'
  const content = document.createElement('div')
  content.className = 'thinking-content'
  content.innerHTML = html || ''
  if (not(currentRunning())) for (const step of content.querySelectorAll('.tl-running')) closeTimelineStep(step, 'interrupted')
  details.appendChild(summary)
  details.appendChild(content)
  messagesContent().appendChild(details)
  /* 老会话存的是纯文本 / .thinking-tool，没有 .tl-step：这时 summary 保持「思考过程」，
     有步骤的新记录才升级成「已执行 N 步」。 */
  refreshTimelineSummary(details, content, false)
}

/* UI 过程按模型回复定位；不进入发给模型的 messages，也不参与执行状态迁移。 */
function recordProcessTimeline(sessionId, event) {
  const session = findSessionById(sessionId)
  if (not(session)) return
  const processTypes = ['assistant:thinking', 'tool:start', 'tool:result', 'notice', 'capability:missing']
  const isProcess = processTypes.indexOf(event.type) !== -1
  if (not(isProcess) && event.type !== 'assistant:message' && event.type !== 'finished') return
  if (not(Array.isArray(session.processTimeline))) {
    if (not(isProcess)) return
    const resumed = sessionId === state.currentSessionId && state.currentThinking && state.thinkingBase === ''
      && state.currentThinking.innerHTML === session.processHtml
    session.legacyProcessHtml = resumed ? '' : (session.processHtml || '')
    session.processTimeline = []
    session.legacyMessageCount = Array.isArray(session.messages) ? session.messages.length : 0
  }
  const entries = session.processTimeline
  let entry = entries[entries.length - 1]
  if (event.type === 'assistant:message' || event.type === 'finished') {
    const traceContent = sessionId === state.currentSessionId ? state.currentThinking : state.processBuffers[sessionId]
    if (traceContent) {
      const step = activeTimelineStep(traceContent)
      if (step) {
        const status = event.execution && event.execution.status
        closeTimelineStep(step, status === 'cancelled' ? 'cancelled' : status === 'failed' || status === 'timed_out' ? false : true)
        if (sessionId === state.currentSessionId) saveThinkingProcess(traceContent)
      }
    }
    if (state.processBuffers[sessionId]) {
      commitProcessRecord(sessionId)
      dropProcessRecord(sessionId)
      entry = entries[entries.length - 1]
    }
    const messages = Array.isArray(event.messages) ? event.messages : []
    const lastAssistant = messages.slice().reverse().find((item) => item.role === 'assistant' && typeof item.content === 'string' && item.content)
    const text = event.text || (lastAssistant && lastAssistant.content)
    if (entry && not(entry.beforeText) && text) {
      entry.beforeText = String(text)
      saveSessionStore()
    }
    return
  }
  /* 内容由前台/后台共用的保存入口写入，避免重复记录同一增量。 */
}

function saveProcessTimelineContent(session, html) {
  const entries = session.processTimeline
  let entry = entries[entries.length - 1]
  if (not(entry) || entry.beforeText) {
    entry = { html: '', beforeText: '', afterMessage: Array.isArray(session.messages) ? session.messages.length : 0 }
    entries.push(entry)
  }
  entry.html = html
  session.processHtml = trimProcessHtml([session.legacyProcessHtml || ''].concat(entries.map((item) => item.html)).filter(Boolean).join(THINKING_TURN_SEP))
  saveSessionStore()
}

function renderProcessTimeline(session, list, runningHere) {
  const remaining = session.processTimeline.slice()
  if (session.legacyProcessHtml) addThinkingBlock(session.legacyProcessHtml)
  for (let messageIndex = 0; messageIndex < list.length; messageIndex += 1) {
    const message = list[messageIndex]
    if (message.role === 'user') addUserBubble(message.content)
    if (message.role === 'tool' && message.content && messageIndex < (session.legacyMessageCount || 0)) {
      const content = document.createElement('div')
      appendProcessToolResult(content, message.name || '工具', message.content)
      addThinkingBlock(content.innerHTML)
    }
    if (message.role !== 'assistant' || not(message.content)) continue
    const text = Array.isArray(message.content) ? extractUserContent(message.content).text : message.content
    const index = remaining.findIndex((entry) => entry.beforeText === text && messageIndex >= (entry.afterMessage || 0))
    if (index !== -1) {
      /* 压缩/断线造成定位回复缺失时，仍保留之前未匹配的过程。 */
      for (const entry of remaining.splice(0, index + 1)) {
        if (entry.html) addThinkingBlock(entry.html)
      }
    }
    if (text) addBubble('assistant', text, { markdown: true })
  }
  let activeHtml = ''
  for (const entry of remaining) {
    if (runningHere && not(entry.beforeText)) activeHtml += entry.html || ''
    else if (entry.html) addThinkingBlock(entry.html)
  }
  if (runningHere) {
    dropProcessRecord(session.id)
    resumeThinking(activeHtml)
    scheduleWaitingHint()
  }
}

function renderMessages(session) {
  clearMessages()
  state.currentAssistant = null
  state.currentThinking = null
  clearWaitingTimer()
  const list = session && Array.isArray(session.messages) ? session.messages : []
  const processHtml = session && session.processHtml ? session.processHtml : ''
  if (window.agentUI) window.agentUI.planFromMessages(list)
  if (list.length === 0 && not(currentRunning()) && window.agentUI) window.agentUI.empty(messagesContent())
  if (session && session.memory && session.memory.text) {
    const memoryDetails = document.createElement('details')
    memoryDetails.className = 'thinking-block memory-block'
    const memorySummary = document.createElement('summary')
    memorySummary.textContent = '历史记忆 (' + (session.memory.compressedCount || 0) + ')'
    const memoryContent = document.createElement('div')
    memoryContent.className = 'thinking-content'
    memoryContent.textContent = session.memory.text
    memoryDetails.appendChild(memorySummary)
    memoryDetails.appendChild(memoryContent)
    messagesContent().appendChild(memoryDetails)
  }
  /* 这条会话正在跑 → 过程还在长：不要再摆一份静态快照（否则会变成两块，一块是切走时的
     旧内容、一块是新的空块），直接把已有内容接进「进行中」的块，后续增量往里续写。 */
  const runningHere = Boolean(session && session.id === state.currentSessionId && currentRunning())
  const seedHtml = runningHere && session && session.processHtml ? session.processHtml : ''
  const staticProcessHtml = runningHere ? '' : processHtml
  if (session && Array.isArray(session.processTimeline)) {
    renderProcessTimeline(session, list, runningHere)
    scrollToBottom()
    return
  }
  let processRendered = false
  let toolThinking = null
  for (const message of list) {
    if (message.role === 'user') {
      toolThinking = null
      addUserBubble(message.content)
    }
    if (message.role === 'assistant' && message.content) {
      toolThinking = null
      const assistantText = Array.isArray(message.content) ? extractUserContent(message.content).text : message.content
      if (assistantText) {
        if (not(processRendered) && staticProcessHtml) {
          addThinkingBlock(staticProcessHtml)
          processRendered = true
        }
        addBubble('assistant', assistantText, { markdown: true })
      }
    }
    if (message.role === 'tool' && message.content) {
      /* 旧数据只有会话级过程 HTML：仍在工具原位置恢复结果，不能全部隐藏。 */
      if (not(toolThinking)) {
        const details = document.createElement('details')
        details.className = 'thinking-block'
        const summary = document.createElement('summary')
        summary.textContent = '\u601d\u8003\u8fc7\u7a0b'
        const content = document.createElement('div')
        content.className = 'thinking-content'
        details.appendChild(summary)
        details.appendChild(content)
        messagesContent().appendChild(details)
        toolThinking = content
      }
      const block = document.createElement('div')
      block.className = 'thinking-tool-result'
      block.textContent = '\u5de5\u5177\u7ed3\u679c\n' + message.content
      toolThinking.appendChild(block)
    }
  }
  if (not(processRendered) && staticProcessHtml) addThinkingBlock(staticProcessHtml)
  if (runningHere) {
    /* 之前的游离累积区已经同步进 processHtml，接着画就够，别再单独记一份 */
    dropProcessRecord(session.id)
    resumeThinking(seedHtml)
    scheduleWaitingHint()
  }
  scrollToBottom()
}

async function selectSession(sessionId) {
  if(window.workflowUI)window.workflowUI.hide()
  if (window.knowledgeUI) { window.knowledgeUI.hide(); byId('contentFrame').classList.remove('hidden') }
  const center = byId('capabilityCenter')
  if (center && !center.classList.contains('hidden')) {
    center.classList.add('hidden')
    byId('contentFrame').classList.remove('hidden')
    byId('app').classList.remove('capabilities-open')
    byId('openCustomize').removeAttribute('aria-current')
  }
  const session = findSessionById(sessionId)
  if (not(session)) return
  const settings = state.settings || {}
  if (session.scope === 'recent') {
    state.activeProjectId = ''
    const workspacePath = session.knowledgeBaseId ? state.workspacePath : session.workspacePath || state.workspacePath
    if (workspacePath && workspacePath !== state.workspacePath) {
      /* 不再静默切换工作区：必须用户确认，否则只看历史不动目录 */
      const ok = await confirmDialog('该会话原工作区是「' + workspaceLabel(workspacePath) + '」：\n' + workspacePath + '\n\n与当前工作区不同，切换过去吗？（取消则只查看历史，工作区保持不变）')
      if (ok) {
        state.settings = await window.dsh.saveSettings({ workspacePath })
        state.workspacePath = state.settings.workspacePath || workspacePath
      }
    }
  } else {
    state.activeProjectId = session.projectId
    if (settings.currentProjectId !== session.projectId) {
      const project = (settings.projects || []).find((item) => item.id === session.projectId)
    if (project) {
      state.settings = await window.dsh.saveSettings({
        currentProjectId: project.id,
        workspacePath: (project.folders || [])[0] || state.workspacePath
      })
        await refreshState()
      }
    }
  }
  state.currentSessionId = sessionId
  saveCurrentSessionId(sessionId)
  /* 换会话前先丢掉上一个会话留下的「思考中」引用（它们是上一个会话的 DOM 节点，
     留着会让 beginThinking 复用到一个已经不在文档里的块）。 */
  state.currentThinking = null
  state.currentThinkingDetails = null
  clearWaitingTimer()
  /* 本窗口没有连续跟踪这条会话的流 —— 它跑完时要从权威消息重画一次，
     否则「切走期间丢掉的增量」会留下一条半截回答。 */
  state.liveRun = false
  const fresh = findSessionById(sessionId)
  renderMessages(fresh)
  renderWorkspaceList()
  /* 换会话时必须跟宿主对一次表：上一个会话跑完但事件没到（断线/错过 finished）时，
     发送按钮会一直停在「停止」态、新消息只能排队 —— 用户报的「切换会话后不能发送」。
     对了表后把「当前会话」积压的队列冲出去（别的会话的队列等切回去再说）。 */
  syncRunningState().then(() => flushPendingMessage()).catch(() => {})
  if (state.pendingMessages.length > 0) scheduleQueueFlush()
  /* 换了会话 = 换了「谁在跑」的参照物，发送/停止按钮和提示条都要重算 */
  applyRunState()
  setStatus('\u4f1a\u8bdd\u5df2\u5207\u6362')
}

async function renameSession(session) {
  if (not(session)) return
  const title = await promptText('\u4f1a\u8bdd\u6807\u9898', session.title || '\u65b0\u4f1a\u8bdd')
  if (not(title)) return
  session.title = title
  session.updatedAt = new Date().toISOString()
  saveSessionStore()
  renderWorkspaceList()
  setStatus('\u4f1a\u8bdd\u6807\u9898\u5df2\u4fee\u6539')
}

function getProjectName(projectId) {
  const settings = state.settings || {}
  const project = (settings.projects || []).find((item) => item.id === projectId)
  return project ? (project.name || workspaceLabel((project.folders || [])[0])) : ''
}

async function deleteSession(session) {
  if (not(session)) return
  if (isSessionRunning(session.id)) { setStatus('请先停止该会话再删除'); return }
  const confirmed = await confirmDialog('\u786e\u5b9a\u5220\u9664\u8fd9\u4e2a\u4f1a\u8bdd\uff1f')
  if (not(confirmed)) return
  try { await window.dsh.knowledgeRequest('delete-session',{sessionId:session.id}) } catch(error) { setStatus('删除失败：'+error.message); return }
  try { const files=JSON.parse(localStorage.getItem('dsh-panel-session-files')||'{}');delete files[session.id];localStorage.setItem('dsh-panel-session-files',JSON.stringify(files)) } catch(_) {}
  for (const key of Object.keys(sessionStore)) {
    if (Array.isArray(sessionStore[key])) {
      sessionStore[key] = sessionStore[key].filter((item) => item.id !== session.id)
    }
  }
  saveSessionStore()
  if(window.knowledgeUI)window.knowledgeUI.refresh()
  if (state.currentSessionId === session.id) {
    state.currentSessionId = ''
    saveCurrentSessionId('')
    renderMessages(null)
  }
  renderWorkspaceList()
  setStatus('\u4f1a\u8bdd\u5df2\u5220\u9664')
}

let confirmPriorFocus = null
const confirmBacklog = []
function confirmDialog(message, options) {
  if(state.confirmResolver)return new Promise(resolve=>confirmBacklog.push({message,options,resolve}))
  confirmPriorFocus=document.activeElement
  return new Promise((resolve) => {
    const opts = options || {}
    state.confirmResolver = resolve
    byId('confirmTitle').textContent = opts.cancel === false ? '\u63d0\u793a' : '\u786e\u8ba4'
    byId('confirmMessage').textContent = message || '\u786e\u8ba4\u64cd\u4f5c\uff1f'
    const cancel = byId('confirmCancel')
    if (opts.cancel === false) cancel.classList.add('hidden')
    else cancel.classList.remove('hidden')
    byId('confirmModal').classList.remove('hidden')
    if(typeof cancel.focus==='function')(opts.cancel===false?byId('confirmOk'):cancel).focus()
  })
}

function alertDialog(message) {
  return confirmDialog(message, { cancel: false })
}

function resolveConfirm(value) {
  if (not(state.confirmResolver)) return
  const resolver = state.confirmResolver
  state.confirmResolver = null
  byId('confirmModal').classList.add('hidden')
  if(confirmPriorFocus&&confirmPriorFocus.isConnected&&typeof confirmPriorFocus.focus==='function')confirmPriorFocus.focus()
  resolver(value)
  const next=confirmBacklog.shift();if(next)confirmDialog(next.message,next.options).then(next.resolve)
  else {const prior=confirmPriorFocus;setTimeout(()=>{if(!state.confirmResolver&&prior&&prior.isConnected&&typeof prior.focus==='function')prior.focus()},0)}
}
window.appDialogs={confirm:confirmDialog,prompt:promptText,alert:alertDialog}

/* ---------- 授权（approval）策略 ----------
   两档记忆，命中即自动批准，不再弹窗：
   - 会话级：session.approvals 存 kind（command / write / edit），跟着会话对象走；
     新建会话天然是空的，等于恢复询问。
   - 全局级：settings.approvalAllow 存 signature（例如 command:npm），持久化，可在设置里清空。
   服务端只负责「问」，本层负责「答」，所以策略全部收敛在这里。 */

const APPROVAL_KIND_LABELS = {
  command: '\u8fd0\u884c\u547d\u4ee4',
  write: '\u5199\u5165\u6587\u4ef6',
  edit: '\u7f16\u8f91\u6587\u4ef6'
}

function sessionApprovals(session) {
  if (not(session)) return []
  if (not(Array.isArray(session.approvals))) session.approvals = []
  return session.approvals
}

function globalApprovals() {
  const settings = state.settings || {}
  return Array.isArray(settings.approvalAllow) ? settings.approvalAllow : []
}

function approvalGrant(request, session) {
  const kind = String(request.kind || 'command')
  const signature = String(request.signature || '')
  if (sessionApprovals(session).indexOf(kind) !== -1) return 'session'
  if (signature !== '' && globalApprovals().indexOf(signature) !== -1) return 'global'
  return ''
}

/* 授权弹窗。sessionLabel 只有「后台会话」的请求才带 —— 那时用户正看着另一条会话，
   弹窗必须点明是谁在等授权，否则不知道按下去会发生什么。 */
function approvalDialog(request, sessionLabel) {
  return new Promise((resolve) => {
    const kind = String(request.kind || 'command')
    const program = String(request.program || '')
    const signature = String(request.signature || '')
    const canAlways = kind === 'command' && program !== ''
    state.approvalResolver = resolve
    byId('approvalTitle').textContent = '需要确认：' + (APPROVAL_KIND_LABELS[kind] || '执行操作')
    byId('approvalKind').textContent = (APPROVAL_KIND_LABELS[kind] || '\u64cd\u4f5c') +
      (sessionLabel ? '\uff08\u6765\u81ea\u4f1a\u8bdd\uff1a' + sessionLabel + '\uff09' : '')
    const sigNode = byId('approvalSignature')
    sigNode.textContent = signature
    if (signature === '') sigNode.classList.add('hidden')
    else sigNode.classList.remove('hidden')
    byId('approvalDetail').textContent = String(request.detail || request.title || '').trim()
    const always = byId('approvalAlways')
    always.textContent = canAlways ? '\u59cb\u7ec8\u5141\u8bb8 ' + program : '\u59cb\u7ec8\u5141\u8bb8'
    if (canAlways) always.classList.remove('hidden')
    else always.classList.add('hidden')
    byId('approvalNote').textContent = canAlways
      ? '\u300c\u672c\u4f1a\u8bdd\u90fd\u5141\u8bb8\u300d= \u5f53\u524d\u4f1a\u8bdd\u5185\u540e\u7eed\u6240\u6709\u547d\u4ee4\u90fd\u4e0d\u518d\u8be2\u95ee\uff1b\u300c\u59cb\u7ec8\u5141\u8bb8\u300d\u53ea\u653e\u884c ' + program + '\uff0c\u5e76\u4f1a\u5199\u8fdb\u8bbe\u7f6e\u91cc\u7684\u653e\u884c\u6e05\u5355\u3002'
      : '\u300c\u672c\u4f1a\u8bdd\u90fd\u5141\u8bb8\u300d= \u5f53\u524d\u4f1a\u8bdd\u5185\u540c\u7c7b\u64cd\u4f5c\u4e0d\u518d\u8be2\u95ee\u3002'
    state.approvalFocus = document.activeElement
    byId('approvalModal').classList.remove('hidden')
    byId('approvalOnce').focus()
  })
}

function resolveApproval(approved, scope) {
  if (not(state.approvalResolver)) return
  const resolver = state.approvalResolver
  state.approvalResolver = null
  byId('approvalModal').classList.add('hidden')
  if (state.approvalFocus && typeof state.approvalFocus.focus === 'function') state.approvalFocus.focus()
  state.approvalFocus = null
  resolver({ approved: approved === true, scope: scope || 'once' })
}

/* 授权请求的统一入口：排队拿弹窗。
   弹窗一次只能显示一个（approvalDialog 用单槽 state.approvalResolver），而并发之后
   两条会话完全可能同时要授权 —— 后到的若直接抢槽，先弹的那个 resolver 就被顶掉，
   那条会话会一直卡到服务端 5 分钟超时被拒（用户看不见任何提示）。所以排队。 */
function requestApproval(request, sessionLabel, requestId) {
  return new Promise((resolve) => {
    state.approvalQueue.push({
      request: request,
      sessionLabel: sessionLabel || '',
      requestId: String(requestId || ''),
      resolve: resolve
    })
    pumpApprovalQueue()
  })
}

async function pumpApprovalQueue() {
  if (state.approvalBusy === true) return
  if (state.approvalQueue.length === 0) return
  state.approvalBusy = true
  const item = state.approvalQueue.shift()
  state.approvalCurrentId = item.requestId || ''
  try {
    const decision = await approvalDialog(item.request, item.sessionLabel)
    item.resolve(decision)
  } finally {
    state.approvalCurrentId = ''
    state.approvalBusy = false
  }
  pumpApprovalQueue()
}

/* 服务端说这个授权请求超时了：把正在为它开的弹窗收掉、或者把它从队里摘掉。
   不处理的话这条会话要干等到服务端 5 分钟超时才被拒，而队列会被它一个人堵死。 */
function expireApproval(approvalId) {
  const id = String(approvalId || '')
  if (id === '') return
  if (state.approvalCurrentId !== '' && state.approvalCurrentId === id) {
    resolveApproval(false, 'once')
  }
  const rest = []
  for (const item of state.approvalQueue) {
    if (item.requestId !== '' && item.requestId === id) item.resolve({ approved: false, scope: 'once' })
    else rest.push(item)
  }
  state.approvalQueue = rest
}

/* 能力缺失弹窗：显示缺失详情，可直达设置→插件 */
function showCapabilityModal(text) {
  byId('capabilityText').textContent = String(text || '')
  byId('capabilityModal').classList.remove('hidden')
}

function hideCapabilityModal() {
  byId('capabilityModal').classList.add('hidden')
}

/* 链接一律走系统默认浏览器：桌面壳经 IPC，浏览器模式开新标签 */
function openExternalLink(target) {
  const link = String(target || '')
  if (not(/^https?:\/\//i.test(link))) return false
  if (window.dsh && typeof window.dsh.openExternal === 'function') {
    window.dsh.openExternal(link).catch(() => {})
  } else {
    window.open(link, '_blank', 'noopener')
  }
  return true
}

/* 当前软件自己的地址。
   桌面壳的窗口本身就是从本地服务 loadURL 起来的（shell/main.js 的 resolvedServiceUrl），
   浏览器里更是直接访问这个地址 —— 所以 location.origin 就是「当前软件的链接」。
   开发模式（src/main/main.js 直接 load file://）拿不到链接，返回空串让调用方兜底。 */
function appLink() {
  try {
    const loc = window.location
    if (not(loc) || not(loc.protocol)) return ''
    if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return ''
    const origin = String(loc.origin || '')
    if (origin === '' || origin === 'null') return ''
    return origin + '/'
  } catch (error) {
    return ''
  }
}

/* 刷新整页。整页就是一个网页（桌面壳也是 loadURL 起来的），所以刷新 = reload。
   跑任务时也能刷：跑的是服务端常驻循环，刷新后 init() 会对表把运行状态接回来。 */
function reloadPage() {
  setStatus('\u6b63\u5728\u5237\u65b0\u9875\u9762')
  try {
    window.location.reload()
  } catch (error) {
    try { window.location.href = window.location.href } catch (inner) {}
  }
}

/* 转发：把当前软件的链接复制到剪贴板 + 丢给系统默认浏览器。
   剪贴板没权限（浏览器非安全上下文）就只打开，不拦着。 */
async function sharePageLink() {
  const link = appLink()
  if (link === '') {
    setStatus('\u5f53\u524d\u73af\u5883\u62ff\u4e0d\u5230\u53ef\u5206\u4eab\u7684\u94fe\u63a5')
    return
  }
  let copied = false
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(link)
      copied = true
    }
  } catch (error) {}
  const opened = openExternalLink(link)
  if (opened) setStatus(copied ? '\u94fe\u63a5\u5df2\u590d\u5236\uff0c\u5df2\u5728\u6d4f\u89c8\u5668\u6253\u5f00' : '\u5df2\u5728\u6d4f\u89c8\u5668\u6253\u5f00\uff1a' + link)
  else setStatus(link)
}

function approvalDenyScope() {
  resolveApproval(false, 'once')
}

async function rememberApproval(scope, request, session) {
  if (scope === 'session') {
    const kind = String(request.kind || 'command')
    const list = sessionApprovals(session)
    if (list.indexOf(kind) === -1) {
      list.push(kind)
      saveSessionStore()
    }
    return
  }
  if (scope === 'always') {
    const signature = String(request.signature || '')
    if (signature === '') return
    const list = globalApprovals().slice()
    if (list.indexOf(signature) === -1) {
      list.push(signature)
      state.settings = await window.dsh.saveSettings({ approvalAllow: list })
      renderApprovalAllow()
    }
  }
}

function renderApprovalAllow() {
  const list = byId('approvalAllowList')
  if (not(list)) return
  list.textContent = ''
  const items = globalApprovals()
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'muted'
    empty.textContent = '\u6682\u65e0\uff08\u6388\u6743\u65f6\u9009\u300c\u59cb\u7ec8\u5141\u8bb8\u300d\u4f1a\u52a0\u5230\u8fd9\u91cc\uff09'
    list.appendChild(empty)
    return
  }
  for (const item of items) {
    const chip = document.createElement('span')
    chip.className = 'approval-allow-item'
    chip.textContent = item
    list.appendChild(chip)
  }
}

async function clearApprovalAllow() {
  if (globalApprovals().length === 0) {
    setStatus('\u653e\u884c\u6e05\u5355\u672c\u6765\u5c31\u662f\u7a7a\u7684')
    return
  }
  state.settings = await window.dsh.saveSettings({ approvalAllow: [] })
  renderApprovalAllow()
  setStatus('\u653e\u884c\u6e05\u5355\u5df2\u6e05\u7a7a')
}

function placeContextMenu(menu, event) {
  const rect = event.currentTarget.getBoundingClientRect()
  menu.classList.remove('hidden')
  const width = menu.offsetWidth || 120
  let left = rect.right - width
  const viewport = window.innerWidth || 0
  if (viewport && left > viewport - width - 8) left = viewport - width - 8
  if (left < 8) left = 8
  menu.style.left = left + 'px'
  menu.style.top = (rect.bottom + 4) + 'px'
}

function openSessionMenu(session, event) {
  state.menuSession = session
  if (byId('sessionMenuPin')) byId('sessionMenuPin').textContent = session.pinned ? '取消置顶' : '置顶会话'
  placeContextMenu(byId('sessionMenu'), event)
  event.stopPropagation()
}

function closeSessionMenu() {
  const menu = byId('sessionMenu')
  if (menu) menu.classList.add('hidden')
  state.menuSession = null
}

async function archiveSession(session) {
  if (not(session)) return
  const ok = await confirmDialog('\u786e\u5b9a\u5f52\u6863\u8fd9\u4e2a\u4f1a\u8bdd\u5417\uff1f\u5f52\u6863\u540e\u4e0d\u518d\u5728\u9879\u76ee\u548c\u6700\u8fd1\u663e\u793a\u3002')
  if (not(ok)) return
  session.archived = true
  session.updatedAt = new Date().toISOString()
  saveSessionStore()
  if (state.currentSessionId === session.id) {
    state.currentSessionId = ''
    saveCurrentSessionId('')
    renderMessages(null)
  }
  closeSessionMenu()
  renderWorkspaceList()
  setStatus('\u4f1a\u8bdd\u5df2\u5f52\u6863')
}

function openProjectMenu(project, event) {
  closeSessionMenu()
  state.menuProject = project
  placeContextMenu(byId('projectMenu'), event)
  event.stopPropagation()
}

function closeProjectMenu() {
  const menu = byId('projectMenu')
  if (menu) menu.classList.add('hidden')
  state.menuProject = null
}

function closeAllMenus() {
  closeSessionMenu()
  closeProjectMenu()
}

async function renameProject(project) {
  if (not(project)) return
  const settings = state.settings || {}
  const fallback = project.name || workspaceLabel((project.folders || [])[0])
  const name = await promptText('\u5de5\u4f5c\u533a\u540d\u79f0', fallback)
  if (not(name)) return
  const projects = (settings.projects || []).map((item) => {
    if (item.id !== project.id) return item
    return Object.assign({}, item, { name })
  })
  state.settings = await window.dsh.saveSettings({ projects })
  renderWorkspaceList()
  setStatus('\u5de5\u4f5c\u533a\u5df2\u91cd\u547d\u540d')
}

async function deleteProject(project) {
  if (not(project)) return
  const settings = state.settings || {}
  const label = project.name || workspaceLabel((project.folders || [])[0]) || '\u672a\u547d\u540d'
  const ok = await confirmDialog('\u786e\u5b9a\u5220\u9664\u5de5\u4f5c\u533a\u300c' + label + '\u300d\u5417\uff1f\u8be5\u5de5\u4f5c\u533a\u4e0b\u7684\u4f1a\u8bdd\u4e5f\u4f1a\u4e00\u5e76\u5220\u9664\u3002')
  if (not(ok)) return
  const projects = (settings.projects || []).filter((item) => item.id !== project.id)
  const currentSession = findSessionById(state.currentSessionId)
  const sessionBelongedHere = currentSession && currentSession.projectId === project.id
  delete sessionStore[project.id]
  delete state.expandedProjects[project.id]
  const patch = { projects }
  if (settings.currentProjectId === project.id) {
    const nextProject = projects[0] || null
    patch.currentProjectId = nextProject ? nextProject.id : ''
    if (nextProject) patch.workspacePath = (nextProject.folders || [])[0] || state.workspacePath
  }
  state.settings = await window.dsh.saveSettings(patch)
  saveSessionStore()
  if (state.activeProjectId === project.id) state.activeProjectId = patch.currentProjectId || ''
  if (sessionBelongedHere) {
    state.currentSessionId = ''
    saveCurrentSessionId('')
    renderMessages(null)
  }
  await refreshState()
  setStatus('\u5de5\u4f5c\u533a\u5df2\u5220\u9664')
}

function renderProjectList() {
  const list = byId('projectList')
  if (not(list)) return
  list.textContent = ''
  const settings = state.settings || {}
  const projects = Array.isArray(settings.projects) ? settings.projects : []
  if (projects.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'flat-empty'
    empty.textContent = '\u6682\u65e0\u9879\u76ee'
    list.appendChild(empty)
    return
  }
  for (const project of projects) {
    const expanded = state.expandedProjects[project.id] !== false
    const node = document.createElement('div')
    node.className = 'project-node'
    const row = document.createElement('div')
    row.className = 'flat-item project-item'
    const folder = document.createElement('button')
    folder.className = 'project-folder-toggle'
    folder.innerHTML = window.renderIcon(expanded ? 'folder-open' : 'folder')
    folder.title = expanded ? '\u6536\u8d77\u4f1a\u8bdd' : '\u5c55\u5f00\u4f1a\u8bdd'
    folder.setAttribute('aria-label', folder.title)
    folder.setAttribute('aria-expanded', String(expanded))
    folder.addEventListener('click', (event) => {
      event.stopPropagation()
      state.expandedProjects[project.id] = not(expanded)
      renderWorkspaceList()
    })
    const name = document.createElement('span')
    name.className = 'flat-name'
    name.textContent = project.name || workspaceLabel((project.folders || [])[0])
    name.title = name.textContent + '\n' + (project.folders || []).join('\n')
    const add = document.createElement('button')
    add.className = 'project-add'
    add.innerHTML = window.renderIcon('plus')
    add.title = '\u65b0\u5efa\u4f1a\u8bdd'
    add.addEventListener('click', (event) => {
      event.stopPropagation()
      const session = createSession(project.id, '\u65b0\u4f1a\u8bdd', 'project')
      state.expandedProjects[project.id] = true
      selectSession(session.id)
    })
    const more = document.createElement('button')
    more.className = 'project-more'
    more.innerHTML = window.renderIcon('more')
    more.title = '\u66f4\u591a'
    more.addEventListener('click', (event) => {
      event.stopPropagation()
      openProjectMenu(project, event)
    })
    row.appendChild(folder)
    row.appendChild(name)
    row.appendChild(add)
    row.appendChild(more)
    row.addEventListener('click', () => {
      if (state.expandedProjects[project.id] !== false) {
        state.expandedProjects[project.id] = false
        renderWorkspaceList()
      } else {
        selectProject(project)
      }
    })
    node.appendChild(row)
    if (expanded) {
      const sessions = getProjectSessions(project.id)
      const sessionList = document.createElement('div')
      sessionList.className = 'project-session-list'
      if (sessions.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'flat-empty session-empty'
        empty.textContent = '\u6682\u65e0\u4f1a\u8bdd'
        sessionList.appendChild(empty)
      }
      for (const session of sessions) {
        const item = document.createElement('div')
        item.className = 'flat-item chat-item' + (session.id === state.currentSessionId ? ' active' : '')
        const title = document.createElement('span')
        title.className = 'flat-name'
        title.textContent = session.title || '\u65b0\u4f1a\u8bdd'
        title.title = title.textContent
        const more = document.createElement('button')
        more.className = 'chat-more'
        more.innerHTML = window.renderIcon('more')
        more.title = '\u66f4\u591a'
        more.addEventListener('click', (event) => {
          event.stopPropagation()
          openSessionMenu(session, event)
        })
        if (window.agentUI) item.appendChild(window.agentUI.sessionBadge(session, isSessionRunning(session.id)))
        item.appendChild(title)
        item.appendChild(more)
        item.setAttribute('role', 'button'); item.tabIndex = 0; item.classList.toggle('pinned', Boolean(session.pinned))
        item.addEventListener('keydown', (event) => { if (event.target === item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectSession(session.id) } })
        item.addEventListener('click', () => selectSession(session.id))
        sessionList.appendChild(item)
      }
      node.appendChild(sessionList)
    }
    list.appendChild(node)
  }
}

function renderChatList() {
  const list = byId('chatList')
  if (not(list)) return
  list.textContent = ''
  const sessions = getRecentSessions()
  if (sessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'flat-empty'
    empty.textContent = '\u6682\u65e0\u4f1a\u8bdd'
    list.appendChild(empty)
    return
  }
  for (const session of sessions) {
    const row = document.createElement('div')
    row.className = 'flat-item chat-item' + (session.id === state.currentSessionId ? ' active' : '')
    const title = document.createElement('span')
    title.className = 'flat-name'
    title.textContent = session.title || '\u65b0\u4f1a\u8bdd'
    title.title = title.textContent
    const more = document.createElement('button')
    more.className = 'chat-more'
    more.innerHTML = window.renderIcon('more')
    more.title = '\u66f4\u591a'
    more.addEventListener('click', (event) => {
      event.stopPropagation()
      openSessionMenu(session, event)
    })
    if (window.agentUI) row.appendChild(window.agentUI.sessionBadge(session, isSessionRunning(session.id)))
    row.appendChild(title)
    row.appendChild(more)
    row.setAttribute('role', 'button'); row.tabIndex = 0; row.classList.toggle('pinned', Boolean(session.pinned))
    row.addEventListener('keydown', (event) => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectSession(session.id) } })
    row.addEventListener('click', () => selectSession(session.id))
    list.appendChild(row)
  }
}

function syncFilePanelContext() {
  if (!window.filePanel || typeof window.filePanel.setContext !== 'function') return
  const session = currentSession()
  const projectId = session && session.scope !== 'recent' ? session.projectId : (!session ? state.activeProjectId : '')
  const project = ((state.settings && state.settings.projects) || []).find((item) => item.id === projectId)
  window.filePanel.setContext({
    sessionId: session ? session.id : '',
    scope: project ? 'project' : 'recent',
    projectId: project ? project.id : '',
    projectName: project ? getProjectName(project.id) : '',
    folders: project ? project.folders || [] : [],
    workspacePath: state.workspacePath || ''
  })
}

function renderWorkspaceList() {
  const associationLabel=byId('sessionAssociationLabel'),associationSession=currentSession();if(associationLabel)associationLabel.textContent=associationSession&&associationSession.knowledgeBaseId?'知识库 · '+associationSession.knowledgeBaseName:associationSession&&associationSession.scope==='project'?'项目会话':'普通会话'

  if(window.workflowChat)window.workflowChat.render(currentSession())
  syncFilePanelContext()
  renderProjectList()
  renderChatList()
  renderWindowTitle()
}


async function refreshState() {
  const next = await window.dsh.getState()
  state.settings = next.settings
  state.workspacePath = next.workspacePath
  renderSkills(next.skills)
  renderPlugins(next.plugins, next.tools)
  renderModelSelect()
  renderModelInfo()
  renderWorkspace()
  fillSettingsForm()
  renderApprovalAllow()
  renderPermission()
  applyTheme(state.settings.theme)
  return next
}

async function setWorkspacePath(target) {
  const next = await window.dsh.setWorkspace(target)
  state.settings = next.settings || state.settings
  state.workspacePath = next.workspacePath || target
  renderWorkspace()
  renderModelInfo()
  fillSettingsForm()
  setStatus('workspace changed')
}

async function addModel() {
  const current = activeModel() || {}
  const models = (state.settings && Array.isArray(state.settings.models)) ? state.settings.models : []
  const id = 'model_' + Date.now().toString(36)
  const model = {
    id,
    name: '\u65b0\u6a21\u578b ' + (models.length + 1),
    baseURL: current.baseURL || 'http://127.0.0.1:11434/v1',
    apiKey: current.apiKey || 'ollama',
    model: '',
    protocol: current.protocol || 'openai-completions',
    thinking: false,
    modelList: []
  }
  state.settings = await window.dsh.saveSettings({ models: models.concat(model) })
  state.expandedProviderId = id
  renderModelSelect()
  renderProviderList()
  showSettingsTab('model')
  byId('settingsModal').classList.remove('hidden')
  setStatus('model created')
}

function renderProviderList() {
  const list = byId('providerList')
  if (not(list)) return
  list.textContent = ''
  const settings = state.settings || {}
  const models = Array.isArray(settings.models) ? settings.models : []
  const expandedId = state.expandedProviderId
  for (const model of models) {
    const card = document.createElement('div')
    card.className = 'provider-card-flat'
    const head = document.createElement('div')
    head.className = 'provider-card-head'
    const nameBox = document.createElement('div')
    nameBox.className = 'provider-card-name'
    const name = document.createElement('span')
    name.textContent = model.name || model.model || model.id || ''
    nameBox.appendChild(name)
    const badge = document.createElement('span')
    badge.className = 'provider-badge'
    badge.textContent = '\u81ea\u5b9a\u4e49'
    nameBox.appendChild(badge)
    const dot = document.createElement('span')
    dot.className = 'provider-status'
    nameBox.appendChild(dot)
    const actions = document.createElement('div')
    actions.className = 'provider-card-actions'
    const edit = document.createElement('button')
    edit.className = 'ghost-button'
    edit.textContent = expandedId === model.id ? '\u6536\u8d77' : '\u7f16\u8f91'
    edit.addEventListener('click', () => {
      state.expandedProviderId = expandedId === model.id ? '' : model.id
      renderProviderList()
    })
    actions.appendChild(edit)
    if (models.length > 1) {
      const remove = document.createElement('button')
      remove.className = 'danger ghost-button'
      remove.textContent = '\u5220\u9664'
      remove.addEventListener('click', () => { removeProvider(model.id).catch(noopError) })
      actions.appendChild(remove)
    }
    head.appendChild(nameBox)
    head.appendChild(actions)
    card.appendChild(head)
    if (expandedId === model.id) card.appendChild(buildProviderDetail(model))
    list.appendChild(card)
  }
}

function buildProviderDetail(model) {
  const box = document.createElement('div')
  box.className = 'provider-detail'
  function addField(label, field, value, type) {
    const wrapper = document.createElement('label')
    wrapper.className = 'settings-field'
    const title = document.createElement('span')
    title.textContent = label
    const input = document.createElement('input')
    input.type = type || 'text'
    input.value = value === undefined || value === null ? '' : String(value)
    input.addEventListener('change', () => {
      const patch = {}
      patch[field] = input.value.trim()
      updateProvider(model.id, patch).catch(noopError)
    })
    wrapper.appendChild(title)
    wrapper.appendChild(input)
    box.appendChild(wrapper)
    return input
  }
  addField('API \u5bc6\u94a5', 'apiKey', model.apiKey || '', 'password')
  addField('\u663e\u793a\u540d\u79f0', 'name', model.name || '', 'text')
  addField('API \u5730\u5740', 'baseURL', model.baseURL || '', 'text')
  const protocolLabel = document.createElement('label')
  protocolLabel.className = 'settings-field'
  protocolLabel.textContent = 'API \u534f\u8bae'
  const protocol = document.createElement('select')
  for (const value of ['openai-completions', 'openai-responses']) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    protocol.appendChild(option)
  }
  protocol.value = model.protocol || 'openai-completions'
  protocol.addEventListener('change', () => {
    updateProvider(model.id, { protocol: protocol.value }).catch(noopError)
  })
  protocolLabel.appendChild(protocol)
  box.appendChild(protocolLabel)
  const thinkingRow = document.createElement('div')
  thinkingRow.className = 'settings-row provider-thinking-row'
  const thinkingLabel = document.createElement('div')
  thinkingLabel.className = 'settings-row-label'
  const thinkingTitle = document.createElement('div')
  thinkingTitle.className = 'settings-row-title'
  thinkingTitle.textContent = '\u663e\u793a\u601d\u8003\u8fc7\u7a0b'
  const thinkingDesc = document.createElement('div')
  thinkingDesc.className = 'settings-row-desc'
  thinkingDesc.textContent = '\u5f00\u542f\u540e\u4f1a\u663e\u793a\u6a21\u578b\u7684\u601d\u8003\u5185\u5bb9\uff0c\u4f46\u4f1a\u66f4\u6162'
  thinkingLabel.appendChild(thinkingTitle)
  thinkingLabel.appendChild(thinkingDesc)
  const thinkingInput = document.createElement('input')
  thinkingInput.type = 'checkbox'
  thinkingInput.checked = model.thinking === true
  thinkingInput.addEventListener('change', () => {
    updateProvider(model.id, { thinking: thinkingInput.checked }).catch(noopError)
  })
  thinkingRow.appendChild(thinkingLabel)
  thinkingRow.appendChild(thinkingInput)
  box.appendChild(thinkingRow)
  box.appendChild(buildModelDirectory(model))
  return box
}

function buildModelDirectory(model) {
  const section = document.createElement('div')
  section.className = 'model-dir-section'
  const head = document.createElement('div')
  head.className = 'model-dir-head'
  const label = document.createElement('div')
  label.className = 'settings-row-label'
  const title = document.createElement('div')
  title.className = 'settings-row-title'
  title.textContent = '\u6a21\u578b\u76ee\u5f55'
  const desc = document.createElement('div')
  desc.className = 'settings-row-desc'
  desc.textContent = '\u5df2\u81ea\u5b9a\u4e49\u6a21\u578b\u76ee\u5f55'
  label.appendChild(title)
  label.appendChild(desc)
  const actions = document.createElement('div')
  actions.className = 'model-dir-actions'
  const reset = document.createElement('button')
  reset.className = 'link-button'
  reset.textContent = '\u6062\u590d\u9ed8\u8ba4\u6a21\u578b'
  reset.addEventListener('click', () => { resetProviderModels(model.id).catch(noopError) })
  const fetchModels = document.createElement('button')
  fetchModels.className = 'link-button'
  fetchModels.textContent = '\u83b7\u53d6\u53ef\u7528\u6a21\u578b'
  fetchModels.addEventListener('click', () => { fetchProviderModels(model.id).catch(noopError) })
  actions.appendChild(reset)
  actions.appendChild(fetchModels)
  head.appendChild(label)
  head.appendChild(actions)
  section.appendChild(head)
  const list = document.createElement('div')
  list.className = 'model-list'
  const names = Array.isArray(model.modelList) ? model.modelList.slice() : []
  if (names.length === 0 && model.model) names.push(model.model)
  for (const name of names) {
    const row = document.createElement('div')
    row.className = 'model-item' + (name === model.model ? ' active' : '')
    const input = document.createElement('input')
    input.className = 'model-item-input'
    input.value = name
    input.addEventListener('change', () => { renameProviderModel(model.id, name, input.value.trim()).catch(noopError) })
    const pick = document.createElement('button')
    pick.className = 'model-item-pick'
    pick.title = name
    pick.innerHTML = window.renderIcon(name === model.model ? 'check' : 'chevron')
    pick.addEventListener('click', () => { selectProviderModel(model.id, name).catch(noopError) })
    const remove = document.createElement('button')
    remove.className = 'model-item-remove'
    remove.innerHTML = window.renderIcon('trash')
    remove.addEventListener('click', () => { removeProviderModel(model.id, name).catch(noopError) })
    row.appendChild(input)
    row.appendChild(pick)
    row.appendChild(remove)
    list.appendChild(row)
  }
  if (names.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'model-empty'
    empty.textContent = '\u6682\u65e0\u6a21\u578b'
    list.appendChild(empty)
  }
  section.appendChild(list)
  const add = document.createElement('button')
  add.className = 'link-button model-add'
  add.textContent = '+ \u6dfb\u52a0\u6a21\u578b'
  add.addEventListener('click', () => { addProviderModel(model.id).catch(noopError) })
  section.appendChild(add)
  return section
}

function providerById(id) {
  const models = (state.settings && state.settings.models) || []
  return models.find((model) => model.id === id) || null
}

function noopError(error) {
  addBubble('error', formatError(error && error.message ? error.message : String(error)))
}

async function saveProviders(models, currentId) {
  state.settings = await window.dsh.saveSettings({ models, currentModelId: currentId || state.settings.currentModelId })
  renderModelSelect()
  renderProviderList()
}

function updateProvider(id, patch) {
  const models = ((state.settings && state.settings.models) || []).map((model) => model.id === id ? Object.assign({}, model, patch) : model)
  return saveProviders(models, state.settings.currentModelId)
}

async function removeProvider(id) {
  const models = (state.settings && state.settings.models) || []
  if (models.length <= 1) {
    await alertDialog('\u81f3\u5c11\u4fdd\u7559\u4e00\u4e2a\u6a21\u578b')
    return
  }
  if (not(await confirmDialog('\u786e\u5b9a\u5220\u9664\u5f53\u524d\u6a21\u578b\uff1f'))) return
  const nextModels = models.filter((model) => model.id !== id)
  let currentId = state.settings.currentModelId
  if (currentId === id) currentId = nextModels[0].id
  if (state.expandedProviderId === id) state.expandedProviderId = currentId
  await saveProviders(nextModels, currentId)
  setStatus('model changed')
}

async function selectProviderModel(providerId, name) {
  const model = providerById(providerId)
  if (not(model)) return
  /* 点的是这家自己那个 model 名（只有单模型的供应商几乎必然命中）→ 不用改 provider 的 model 字段，
     但**显示必须照样刷新**：早返回分支以前只调了 renderProviderList，输入框上的标签原地不动，
     看起来就是「切了没生效」。 */
  if (name === model.model) {
    state.settings = await window.dsh.saveSettings({ currentModelId: providerId })
  } else {
    state.settings = await window.dsh.saveSettings({ currentModelId: providerId, model: name })
  }
  renderModelSelect()
  renderProviderList()
  setStatus('model changed')
}

async function addProviderModel(providerId) {
  const model = providerById(providerId)
  if (not(model)) return
  const list = (model.modelList || []).slice()
  let index = list.length + 1
  let name = '\u6a21\u578b ' + index
  while (list.indexOf(name) !== -1) { index += 1; name = '\u6a21\u578b ' + index }
  list.push(name)
  const models = (state.settings.models || []).map((item) => item.id === providerId ? Object.assign({}, item, { modelList: list, model: model.model || name }) : item)
  await saveProviders(models, providerId)
  setStatus('model created')
}
async function renameProviderModel(providerId, oldName, newName) {
  if (not(newName) || newName === oldName) return
  const model = providerById(providerId)
  if (not(model)) return
  const list = (model.modelList || []).map((item) => item === oldName ? newName : item)
  const current = model.model === oldName ? newName : model.model
  const models = (state.settings.models || []).map((item) => item.id === providerId ? Object.assign({}, item, { modelList: list, model: current }) : item)
  await saveProviders(models, providerId)
}

async function removeProviderModel(providerId, name) {
  const model = providerById(providerId)
  if (not(model)) return
  const list = (model.modelList || []).filter((item) => item !== name)
  const current = model.model === name ? (list.length > 0 ? list[0] : '') : model.model
  const models = (state.settings.models || []).map((item) => item.id === providerId ? Object.assign({}, item, { modelList: list, model: current }) : item)
  await saveProviders(models, providerId)
  setStatus('model changed')
}

async function resetProviderModels(providerId) {
  const model = providerById(providerId)
  if (not(model)) return
  const list = model.model ? [model.model] : []
  const models = (state.settings.models || []).map((item) => item.id === providerId ? Object.assign({}, item, { modelList: list }) : item)
  await saveProviders(models, providerId)
  setStatus('model changed')
}

async function fetchProviderModels(providerId) {
  const model = providerById(providerId)
  if (not(model)) return
  if (typeof window.dsh.listModels !== 'function') {
    setStatus('list models not supported')
    return
  }
  try {
    const result = await window.dsh.listModels({ baseURL: model.baseURL, apiKey: model.apiKey })
    const list = result && Array.isArray(result.models) ? result.models : []
    if (list.length === 0) {
      setStatus('no models')
      return
    }
    const models = (state.settings.models || []).map((item) => item.id === providerId ? Object.assign({}, item, { modelList: list }) : item)
    await saveProviders(models, providerId)
    setStatus('models loaded')
  } catch (error) {
    addBubble('error', formatError(error && error.message ? error.message : String(error)))
  }
}
function byId(id) {
  return document.getElementById(id)
}

function renderModelInfo() { if (window.agentUI) window.agentUI.context(currentSession(), state.settings) }
function setStatus(text) {
  const statusLine = byId('statusLine')
  if (statusLine) {
    statusLine.textContent = text === 'ready' || text === 'idle' ? '' : translateStatus(text)
    const failed = /disconnected|连接失败|启动失败|ECONNREFUSED|error|failed/i.test(String(text))
    statusLine.setAttribute('data-connection', failed ? 'error' : 'ok')
    const retry = byId('statusRetry'); if (retry) retry.classList.toggle('hidden', not(failed))
  }
}

function messagesContent() {
  return byId('messagesInner') || byId('messages')
}

function clearMessages() {
  const container = messagesContent()
  const plan = byId('taskPlan')
  if (plan && plan.parentNode === container) byId('messages').insertBefore(plan, byId('runStatus'))
  Array.from(container.children).forEach((child) => {
    if (child.id !== 'messageResizeHandle') child.remove()
  })
}

function scrollToBottom() {
  const messages = byId('messages')
  messages.scrollTop = messages.scrollHeight
}

function setBubbleText(body, text, markdown) {
  const value = String(text === undefined || text === null ? '' : text)
  if (markdown && typeof window.renderMarkdown === 'function') {
    body.dataset.raw = value
    body.innerHTML = window.renderMarkdown(value)
    syncAssistantImages(body)
    if (window.agentUI) window.agentUI.artifacts(body)
    return
  }
  body.textContent = value
}

function imageNameFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''), location.href)
    const name = parsed.pathname.split('/').filter(Boolean).pop() || ''
    return decodeURIComponent(name).slice(0, 100) || ('generated-' + Date.now() + '.png')
  } catch (error) {
    return 'generated-' + Date.now() + '.png'
  }
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('IMAGE_READ_FAILED'))
    reader.readAsDataURL(blob)
  })
}

function syncAssistantImages(body) {
  if (not(body) || typeof body.querySelectorAll !== 'function') return
  const sessionId = state.currentSessionId
  for (const image of body.querySelectorAll('img.md-image')) {
    if (image.dataset.syncStarted === '1') continue
    image.dataset.syncStarted = '1'
    image.addEventListener('click', () => {
      if (image.src && window.dsh && typeof window.dsh.openExternal === 'function') window.dsh.openExternal(image.src)
    })
    if (not(window.dsh) || typeof window.dsh.saveAsset !== 'function') continue
    const source = image.getAttribute('src') || ''
    const syncKey = sessionId + '|' + source
    if (syncedAssistantImages.has(syncKey)) continue
    syncedAssistantImages.add(syncKey)
    Promise.resolve().then(async () => {
      let dataUrl = source
      let mime = ''
      if (source.indexOf('data:image/') !== 0) {
        const response = await fetch(source)
        if (not(response.ok)) throw new Error('IMAGE_FETCH_' + response.status)
        const blob = await response.blob()
        if (blob.size > 32 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE')
        mime = blob.type || ''
        dataUrl = await blobDataUrl(blob)
      }
      const saved = await window.dsh.saveAsset({
        dataUrl,
        mime,
        name: imageNameFromUrl(source),
        sessionId
      })
      if (saved && saved.id && typeof window.dsh.readAsset === 'function') {
        const local = await window.dsh.readAsset(saved.id)
        if (local && local.dataUrl) image.src = local.dataUrl
      }
      if (saved && saved.sessionPath && window.filePanel && typeof window.filePanel.rememberSessionFile === 'function') {
        window.filePanel.rememberSessionFile(saved.sessionPath)
      }
    }).catch(() => {
      syncedAssistantImages.delete(syncKey)
      /* 预览仍使用原地址；同步失败不打断回复 */
    })
  }
}

function addBubble(role, text, options) {
  const messages = messagesContent()
  const empty = messages.querySelector('.chat-empty'); if (empty) empty.remove()
  const wrapper = document.createElement('div')
  wrapper.className = 'bubble ' + role
  const label = document.createElement('div')
  label.className = 'bubble-label'
  label.textContent = roleLabel(role)
  const body = document.createElement('div')
  body.className = 'bubble-body'
  setBubbleText(body, text, options && options.markdown)
  wrapper.appendChild(label)
  wrapper.appendChild(body)
  const actionsRow = attachBubbleActions(wrapper, role, body)
  /* 用户消息：气泡+按钮行包进同一个分组，hover 作用在分组上，
     消息容器的大 gap 不会再切断 hover（否则鼠标移向按钮途中按钮就隐藏了） */
  if (actionsRow && role === 'user') {
    actionsRow.classList.add('below')
    const group = document.createElement('div')
    group.className = 'bubble-group'
    group.appendChild(wrapper)
    group.appendChild(actionsRow)
    messages.appendChild(group)
  } else {
    messages.appendChild(wrapper)
  }
  if (window.agentUI && window.agentUI.positionPlan) window.agentUI.positionPlan()
  scrollToBottom()
  return body
}

/* 消息悬停操作：默认隐藏，hover 才显示（最后一条常显）。用户消息=复制+编辑；助手消息=复制+删除 */
function bubblePlainText(wrapper, role, body) {
  if (role === 'assistant') return body.dataset.raw || body.textContent || ''
  const textBox = wrapper.querySelector('.user-text')
  return textBox ? textBox.textContent : (body.textContent || '')
}

function attachBubbleActions(wrapper, role, body) {
  /* 只有用户消息和助手回复带操作按钮。
     这里以前写成 role !== 'user' 兜底，于是工具调用 / 工具结果 / 错误 / 提示
     这些气泡也各挂了一份"复制 + 删除"，看上去就是"每条消息下面都显示按钮"。 */
  if (role !== 'user' && role !== 'assistant') return null
  const row = document.createElement('div')
  row.className = 'bubble-actions'
  const make = (iconName, tip, handler) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'bubble-action'
    btn.title = tip
    btn.setAttribute('aria-label', tip)
    const icon = document.createElement('span')
    icon.className = 'icon'
    icon.setAttribute('data-icon', iconName)
    if (window.renderIcon) icon.innerHTML = window.renderIcon(iconName)
    btn.appendChild(icon)
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      handler(btn)
    })
    row.appendChild(btn)
    return btn
  }
  make('copy', '\u590d\u5236', () => {
    const text = bubblePlainText(wrapper, role, body)
    if (not(text)) return
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => setStatus('\u5df2\u590d\u5236')).catch(() => setStatus('\u590d\u5236\u5931\u8d25'))
    } else {
      setStatus('\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u590d\u5236')
    }
  })
  if (role === 'user') {
    make('edit', '\u7f16\u8f91', () => {
      const text = bubblePlainText(wrapper, role, body)
      if (not(text)) return
      setInputContent(text)
      const input = byId('input')
      if (input && input.focus) input.focus()
      setStatus('\u5df2\u586b\u5165\u8f93\u5165\u6846\uff0c\u53ef\u7f16\u8f91\u540e\u91cd\u65b0\u53d1\u9001')
    })
  } else {
    make('refresh', '重新生成回答', () => {
      if (currentRunning()) { setStatus('请先停止当前任务'); return }
      const latest = (currentSession() && currentSession().messages || []).slice().reverse().find((item) => item.role === 'assistant' && item.content)
      if (latest && latest.content !== bubblePlainText(wrapper, role, body)) { setStatus('请对最新一条回答执行重新生成'); return }
      setInputContent('请基于已有上下文与工具结果重新组织上一条回答，不执行新的工具操作。'); sendMessage()
    })
    make('check', '有帮助（仅保存在本地）', () => {
      const session = currentSession(); if (!session) return
      session.feedback = (session.feedback || []).concat([{ text: bubblePlainText(wrapper, role, body), value: 'helpful', at: new Date().toISOString() }]).slice(-100)
      saveSessionStore(); setStatus('反馈已保存在本地')
    })
    make('close', '无帮助（仅保存在本地）', () => {
      const session = currentSession(); if (!session) return
      session.feedback = (session.feedback || []).concat([{ text: bubblePlainText(wrapper, role, body), value: 'unhelpful', at: new Date().toISOString() }]).slice(-100); saveSessionStore(); setStatus('反馈已保存在本地')
    })
    make('trash', '\u5220\u9664', () => {
      const session = findSessionById(state.currentSessionId)
      const text = bubblePlainText(wrapper, role, body)
      if (session && Array.isArray(session.messages)) {
        for (let index = session.messages.length - 1; index >= 0; index -= 1) {
          const message = session.messages[index]
          if (not(message) || message.role !== role) continue
          const messageText = role === 'assistant' ? (typeof message.content === 'string' ? message.content : extractUserContent(message.content).text) : extractUserContent(message.content).text
          if (messageText === text) {
            session.messages.splice(index, 1)
            break
          }
        }
        saveSessionStore()
      }
      /* 用户消息：气泡和按钮行在同一个分组里，整组移除 */
      const parentNode = wrapper.parentNode
      if (parentNode && parentNode.classList && parentNode.classList.contains('bubble-group')) {
        parentNode.remove()
      } else {
        wrapper.remove()
      }
      setStatus('\u6d88\u606f\u5df2\u5220\u9664')
    })
  }
  /* 无论角色，先让位：只保留最新一条消息的操作行常显。
     必须在下面那个 return 之前执行 —— 用户消息以前提前 return，
     它自己拿不到常显，也不让上一条的常显标记让位。 */
  const container = messagesContent()
  if (container) {
    const previous = container.querySelectorAll('.bubble-actions.actions-visible')
    for (const item of previous) {
      if (item !== row) item.classList.remove('actions-visible')
    }
  }
  row.classList.add('actions-visible')

  /* 用户消息的操作行由 addBubble 追加到气泡外（下方），助手消息留在气泡内 */
  if (role === 'user') return row
  wrapper.appendChild(row)
  return null
}

function extractUserContent(content) {
  const result = { text: '', images: [] }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (not(part)) continue
      if (part.type === 'text' && part.text) result.text += part.text
      if (part.type === 'image_url' && part.image_url && part.image_url.url) result.images.push(part.image_url.url)
      else if (part.type === 'image' && part.assetId) result.images.push({ assetId: part.assetId, mime: part.mime || '', name: part.name || '' })
    }
    return result
  }
  result.text = String(content || '')
  return result
}

function addUserBubble(content) {
  const parts = extractUserContent(content)
  const body = addBubble('user', '')
  if (parts.images.length > 0) {
    const imageBox = document.createElement('div')
    imageBox.className = 'user-images'
    for (const item of parts.images) {
      const image = document.createElement('img')
      image.className = 'user-image'
      image.alt = 'pasted-image'
      if (typeof item === 'string') {
        image.src = item
      } else if (item && item.assetId && typeof window.dsh.readAsset === 'function') {
        window.dsh.readAsset(item.assetId).then((asset) => {
          if (asset && asset.dataUrl) image.src = asset.dataUrl
        }).catch(() => { image.alt = 'missing-image' })
      }
      imageBox.appendChild(image)
    }
    body.appendChild(imageBox)
  }
  if (parts.text) {
    const textBox = document.createElement('div')
    textBox.className = 'user-text'
    textBox.textContent = parts.text
    body.appendChild(textBox)
  }
  return body.parentElement || body
}

function beginAssistant() {
  if (state.currentAssistant) return state.currentAssistant
  state.currentAssistant = addBubble('assistant', '', { markdown: true })
  return state.currentAssistant
}

function endAssistant(finalText) {
  const body = beginAssistant()
  if (finalText !== undefined && finalText !== '') {
    setBubbleText(body, finalText, true)
  }
  state.currentAssistant = null
}

function addToolStart(name, args) {
  const body = addBubble('tool', '正在运行 ' + name + '\n' + JSON.stringify(args, null, 2))
  return body
}

function addToolResult(name, result) {
  addBubble('tool-result', name + '\n' + result)
}

function formatError(message) {
  const value = String(message || '\u672a\u77e5\u9519\u8bef')
  if (value === 'BUSY' || value.includes('BUSY')) return 'Agent \u6b63\u5728\u5904\u7406\u4e0a\u4e00\u6761\u4efb\u52a1\uff0c\u8bf7\u70b9\u51fb\u505c\u6b62\u6216\u7a0d\u540e\u91cd\u8bd5'
  if (value.startsWith('LLM_TIMEOUT')) return '\u6a21\u578b\u8bf7\u6c42\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u670d\u52a1\u5730\u5740\u548c\u6a21\u578b\u662f\u5426\u6b63\u5e38\u52a0\u8f7d'
  if (value.startsWith('MODEL_NOT_CONFIGURED:')) return value.slice('MODEL_NOT_CONFIGURED:'.length).trim()
  if (value.startsWith('WORKSPACE_NOT_SET')) return '\u8bf7\u5148\u9009\u62e9\u6216\u65b0\u5efa\u672c\u5730\u5de5\u4f5c\u533a\u76ee\u5f55'
  if (value === 'AGENT_EVENT_DISCONNECTED' || value === 'AGENT_EVENT_CONNECT_TIMEOUT') return '消息连接未建立，请检查服务连接后重新发送'
  if (value === 'NO_NATIVE_OPENER') return '当前桌面版本无法打开工作区目录，请更新客户端'
  return value.replace(/^LLM_HTTP_(\d+): /, '\u6a21\u578b\u670d\u52a1\u8fd4\u56de $1: ')
}

function clearWaitingTimer() {
  if (state.waitingTimer) {
    clearTimeout(state.waitingTimer)
    state.waitingTimer = null
  }
}

function beginThinking(initialText) {
  if (state.currentThinking) return state.currentThinking
  /* 新起一块：此前记下的过程留在块外，交给 saveThinkingProcess 拼回前面（别让本轮把它盖掉）。 */
  const previous = findSessionById(state.currentSessionId)
  state.thinkingBase = previous && previous.processHtml ? previous.processHtml : ''
  const details = document.createElement('details')
  details.open = true
  details.className = 'thinking-block process-timeline' + (currentRunning() ? ' thinking-active' : '')
  const summary = document.createElement('summary')
  summary.textContent = currentRunning() ? '思考中…' : '思考过程'
  const content = document.createElement('div')
  content.className = 'thinking-content'
  /* 不再塞「正在思考...」占位文本：第一段真实增量进来时自己开第一步，
     占位文本只会让「折叠条里有几步」算错。 */
  if (initialText) appendProcessText(content, initialText)
  details.appendChild(summary)
  details.appendChild(content)
  messagesContent().appendChild(details)
  state.currentThinking = content
  state.currentThinkingDetails = details
  refreshTimelineSummary(details, content, currentRunning())
  scrollToBottom()
  return content
}

/* 本轮思考块与之前几轮之间的分隔（同一块里顺序排下来的，只是不同轮次）。 */
const THINKING_TURN_SEP = '<div class="thinking-turn-sep"></div>'
/* 一条会话的过程会一轮一轮累积（见 saveThinkingProcess），必须有上限：
   否则长会话能把 localStorage 撑爆，而且每次保存都要序列化整份。超了就**按轮次**从头丢，
   不切半句 —— 切在中间会把 HTML 标签切成两半，渲染出来是坏的。 */
const MAX_PROCESS_HTML = 262144

function trimProcessHtml(html) {
  const text = String(html || '')
  if (text.length <= MAX_PROCESS_HTML) return text
  const parts = text.split(THINKING_TURN_SEP)
  while (parts.length > 1 && parts.join(THINKING_TURN_SEP).length > MAX_PROCESS_HTML) parts.shift()
  /* 只剩一轮还是超长：这段本身就是巨无霸，只能硬截（保留尾部，最近的更有用）。 */
  return parts.length === 1 ? parts[0].slice(-MAX_PROCESS_HTML) : parts.join(THINKING_TURN_SEP)
}

function mergeProcessHtml(base, fresh) {
  const tail = trimProcessHtml(fresh)
  const head = trimProcessHtml(base)
  if (not(head)) return tail
  if (not(tail)) return head
  return trimProcessHtml(head + THINKING_TURN_SEP + tail)
}

function saveThinkingProcess(content) {
  const session = findSessionById(state.currentSessionId)
  if (not(session) || not(content)) return
  if (Array.isArray(session.processTimeline)) {
    saveProcessTimelineContent(session, content.innerHTML)
    return
  }
  /* 本轮块里的内容 + 此前记下的（state.thinkingBase）一起写回，不能只写本轮 ——
     否则会话里第二轮一开始，第一轮的思考过程就被整段覆盖掉了。 */
  const merged = mergeProcessHtml(state.thinkingBase || '', content.innerHTML)
  if (session.processHtml === merged) return
  session.processHtml = merged
  saveSessionStore()
}

/* ---- 步骤时间线 ----
   以前一轮里的「思考」和「工具调用」全糊在同一个折叠条里，还每轮并排一个，
   用户看到的是几个一模一样的「思考过程」，既不知道每步在做什么，也判断不了卡没卡住。
   现在一轮只有一个折叠条，里面每一步一行：图标 + 标题 + 耗时，正文折在标题下面。

   状态记在 class 上（tl-running / tl-ok / tl-err）而不是 data-*：过程要存进
   session.processHtml（走 innerHTML），class 能原样回来，渲染层单测的 DOM shim 也只序列化 class。 */
const TOOL_STEP_TITLES = {
  update_plan: '更新任务计划',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_dir: '浏览目录',
  search_files: '搜索文件',
  run_command: '执行命令',
  browser_launch: '启动浏览器',
  browser_act: '操作浏览器',
  browser_close: '关闭浏览器',
  load_skill: '加载技能',
  search_skills: '查找技能',
  start_process: '启动服务',
  stop_process: '停止服务',
  wait_ready: '等待服务就绪'
}

function toolStepTitle(name, args) {
  const data = (args && typeof args === 'object') ? args : {}
  const file = typeof data.path === 'string' ? data.path : (typeof data.file === 'string' ? data.file : '')
  const base = file ? file.split(/[\\/]/).pop() : ''
  const id = String(name || '')
  if (id === 'read_file') return base ? '读取 ' + base : '读取文件'
  if (id === 'write_file') return base ? '写入 ' + base : '写入文件'
  if (id === 'edit_file') return base ? '编辑 ' + base : '编辑文件'
  if (id === 'list_dir') return typeof data.path === 'string' && data.path !== '' ? '浏览 ' + data.path : '浏览目录'
  if (id === 'search_files') return data.pattern ? '搜索 ' + data.pattern : '搜索文件'
  if (id === 'run_command') return typeof data.command === 'string' && data.command !== '' ? '执行 ' + data.command : '执行命令'
  if (id === 'load_skill') return data.id ? '加载技能 ' + data.id : '加载技能'
  /* 没登记的工具别编动作，如实显示工具名。 */
  return TOOL_STEP_TITLES[id] || id || '工具'
}

function formatDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0))
  if (value < 1000) return value + 'ms'
  if (value < 60000) return (value / 1000).toFixed(1) + 's'
  return Math.floor(value / 60000) + 'm' + Math.round((value % 60000) / 1000) + 's'
}

/* 反解已写进 HTML 的耗时文案：重载之后总结行还要能算总耗时，那会儿节点上没有内存态。 */
function parseDurationText(text) {
  const value = String(text || '')
  if (value === '') return 0
  if (value.indexOf('ms') !== -1) return parseFloat(value) || 0
  if (value.indexOf('m') !== -1) {
    const parts = value.split('m')
    return (Number(parts[0]) || 0) * 60000 + (parseFloat(parts[1]) || 0) * 1000
  }
  return (parseFloat(value) || 0) * 1000
}

function timelineSteps(content) {
  if (not(content) || typeof content.querySelectorAll !== 'function') return []
  return content.querySelectorAll('.tl-step')
}

function activeTimelineStep(content) {
  const steps = timelineSteps(content)
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].classList.contains('tl-running')) return steps[index]
  }
  return null
}

function stepDuration(step) {
  const dur = step.querySelector('.tl-dur')
  if (not(dur)) return 0
  return parseDurationText(dur.textContent || '')
}

function createTimelineStep(content, kind, title) {
  const step = document.createElement('details')
  step.className = 'tl-step tl-' + kind + ' tl-running'
  const head = document.createElement('summary')
  head.className = 'tl-head'
  const icon = document.createElement('span')
  icon.className = 'tl-icon'
  const label = document.createElement('span')
  label.className = 'tl-title'
  label.textContent = title
  const dur = document.createElement('span')
  dur.className = 'tl-dur'
  head.appendChild(icon)
  head.appendChild(label)
  head.appendChild(dur)
  step.appendChild(head)
  const body = document.createElement('div')
  body.className = 'tl-body'
  step.appendChild(body)
  content.appendChild(step)
  step._startAt = Date.now()
  step.setAttribute('data-started-at', String(step._startAt))
  return step
}

function closeTimelineStep(step, ok) {
  if (not(step)) return
  const started = Number(step._startAt || step.getAttribute('data-started-at')) || 0
  step.classList.remove('tl-running')
  step.classList.add(ok === 'interrupted' ? 'tl-interrupted' : ok === 'cancelled' ? 'tl-cancelled' : ok === false ? 'tl-err' : 'tl-ok')
  step.setAttribute('aria-label', ok === 'interrupted' ? '状态未确认' : ok === 'cancelled' ? '已停止' : ok === false ? '失败' : '完成')
  if (started > 0 || ok === 'interrupted') {
    const dur = step.querySelector('.tl-dur')
    if (dur) dur.textContent = ok === 'interrupted' ? '耗时未知' : formatDuration(Date.now() - started)
  }
  step._startAt = 0
  step.removeAttribute('data-started-at')
}

/* 步数与总耗时。重载 / 切会话时整段 HTML 是刚赋给 innerHTML 的，
   这会儿不能只靠查子节点 —— 查不到就退回数 HTML 串，保证摘要还是「已执行 N 步」，
   不会退回「思考过程」让用户以为没记录。 */
function timelineStepCount(content) {
  if (not(content)) return 0
  const nodes = timelineSteps(content)
  if (nodes.length > 0) return nodes.length
  const html = String(content.innerHTML || '')
  const matches = html.match(/class="tl-step/g)
  return matches ? matches.length : 0
}

function timelineTotalMs(content) {
  if (not(content)) return 0
  const nodes = timelineSteps(content)
  if (nodes.length > 0) {
    let sum = 0
    for (const step of nodes) sum += stepDuration(step)
    return sum
  }
  const html = String(content.innerHTML || '')
  const matches = html.match(/class="tl-dur">([^<]*)</g)
  if (not(matches)) return 0
  let sum = 0
  for (const item of matches) {
    sum += parseDurationText(item.slice(item.indexOf('>') + 1, item.length - 1))
  }
  return sum
}

/* 折叠条标题：跑的时候报进度，跑完报总量。 */
function timelineSummaryText(content, running) {
  const count = timelineStepCount(content)
  if (count === 0) return ''
  const total = timelineTotalMs(content)
  if (running) return '思考中…（' + count + ' 步）'
  return '已执行 ' + count + ' 步' + (total > 0 ? ' · ' + formatDuration(total) : '')
}

function refreshTimelineSummary(details, content, running) {
  if (not(details) || typeof details.querySelector !== 'function') return
  const summary = details.querySelector('summary')
  if (not(summary)) return
  const text = timelineSummaryText(content, running)
  if (text === '') return
  summary.textContent = ''
  const title = document.createElement('span')
  title.className = 'timeline-summary-title'
  title.textContent = '已执行 ' + timelineStepCount(content) + ' 步'
  const time = document.createElement('span')
  time.className = 'timeline-summary-time'
  const total = timelineTotalMs(content)
  time.textContent = total > 0 ? formatDuration(total) : ''
  summary.appendChild(title)
  summary.appendChild(time)
  if (window.agentUI && window.agentUI.positionPlan) window.agentUI.positionPlan()
}

function refreshTimeline(content) {
  if (not(content)) return
  const details = typeof content.closest === 'function' ? content.closest('.thinking-block') : null
  if (details) refreshTimelineSummary(details, content, currentRunning())
}

/* 往「思考过程」容器里追加内容的三个原子操作。容器既可能是当前会话挂在 DOM 上的
   活块，也可能是后台会话的游离节点（见 processRecord），所以都接元素参数。 */
function appendProcessText(target, text) {
  if (not(target)) return
  const value = String(text || '')
  if (value === '') return
  let step = activeTimelineStep(target)
  if (not(step) || not(step.classList.contains('tl-think'))) {
    /* 上一段不是思考（比如刚跑完一个工具）就另起一步，别把两件事写进同一行。 */
    if (step) closeTimelineStep(step, true)
    step = createTimelineStep(target, 'think', '思考')
  }
  const body = step.querySelector('.tl-body')
  if (body) {const last=body.lastChild;if(last&&last.nodeType===3)last.appendData(value);else body.appendChild(document.createTextNode(value))}
  refreshTimeline(target)
}

function appendProcessTool(target, name, args) {
  if (not(target)) return
  const running = activeTimelineStep(target)
  if (running) closeTimelineStep(running, true)
  const step = createTimelineStep(target, 'tool', toolStepTitle(name, args))
  step._toolArgs = args || {}
  const body = step.querySelector('.tl-body')
  if (body) {
    const detail = document.createElement('pre')
    detail.className = 'tl-args'
    detail.textContent = JSON.stringify(args || {}, null, 2)
    body.appendChild(detail)
  }
  refreshTimeline(target)
}

function appendProcessToolResult(target, name, result, executionOutcome) {
  if (not(target)) return
  const steps = timelineSteps(target)
  const step = steps.length > 0 ? steps[steps.length - 1] : null
  const value = String(result === undefined || result === null ? '' : result)
  const failed = window.agentUI ? window.agentUI.outcome(value) === 'failed' : /(^|\n)\s*(error|错误|failed|失败|DENIED:|DISABLED:)/i.test(value)
  if (step && step.classList.contains('tl-tool')) {
    closeTimelineStep(step, executionOutcome === 'cancelled' ? 'cancelled' : ['error','denied','disabled'].indexOf(executionOutcome) !== -1 ? false : not(failed))
    const body = step.querySelector('.tl-body')
    if (body && value !== '') {
      const output = document.createElement('details')
      output.className = 'tl-detail'
      const summary = document.createElement('summary')
      summary.textContent = '输出 · ' + value.split('\n').length + ' 行'
      const pre = document.createElement('pre')
      pre.className = 'tl-output'
      pre.textContent = value
      output.appendChild(summary)
      output.appendChild(pre)
      body.appendChild(output)
    }
    if(window.workflowChat&&body)window.workflowChat.decorateToolResult(body,name,value)
    if (window.agentUI) window.agentUI.diffPreview(step, name, step._toolArgs || {}, value)
  } else {
    /* 没有配对的工具步骤（比如旧宿主没发 tool:start）也要留下痕迹，不能静默丢。 */
    appendProcessText(target, '\n' + String(name || '工具') + '：' + value + '\n')
  }
  refreshTimeline(target)
}

/* ---- 后台会话的思考过程 ----
   并发之后，一条会话完全可能整轮都在后台跑完（用户在别的会话里干活）：
   它的过程事件**不能进当前画布**（否则 A 的增量画到 B 上），但也不能像以前那样直接丢掉 ——
   丢了这条会话的 processHtml 就一直是空的，切回去整块「思考过程」都没有。
   用户 2026-09-19 报的「有的会话的思考过程没了」就是这个：只有被他盯着跑的那条才留下过程。

   做法：给每条后台会话存一个游离的 .thinking-content 节点，按事件往里面追加，
   每次追加后同步回 session.processHtml（和当前会话走同一套元素级操作，格式天然一致）。 */
function processRecord(sessionId) {
  const key = String(sessionId || '')
  if (not(key)) return null
  if (not(state.processBuffers[key])) {
    const content = document.createElement('div')
    content.className = 'thinking-content'
    /* 续上这条会话已经记下的部分：它可能刚才是当前会话（过程活在 DOM 里，已经同步进
       processHtml），用户切走之后才轮到我们接手 —— 不续的话前半段会被整段盖掉。 */
    const session = findSessionById(key)
    if (session && Array.isArray(session.processTimeline)) {
      const last = session.processTimeline[session.processTimeline.length - 1]
      if (last && not(last.beforeText)) content.innerHTML = last.html || ''
    } else if (session && session.processHtml) content.innerHTML = session.processHtml
    state.processBuffers[key] = content
  }
  return state.processBuffers[key]
}

function commitProcessRecord(sessionId) {
  const key = String(sessionId || '')
  const content = state.processBuffers[key]
  if (not(content)) return
  const session = findSessionById(key)
  if (not(session)) return
  if (Array.isArray(session.processTimeline)) {
    saveProcessTimelineContent(session, content.innerHTML)
    return
  }
  const html = content.innerHTML
  const merged = mergeProcessHtml('', html)
  if (session.processHtml === merged) return
  session.processHtml = merged
  saveSessionStore()
}

function dropProcessRecord(sessionId) {
  delete state.processBuffers[String(sessionId || '')]
}

/* 后台会话的过程事件 → 只记进它自己的思考过程，不碰 DOM、不碰状态栏（用户没在看它）。
   授权事件是例外：它必须弹窗，不然那条会话会一直卡着等答复（见 handleBackgroundApproval）。 */
function recordBackgroundProcess(sessionId, event) {
  const key = String(sessionId || '')
  if (not(key)) return
  if (event.type === 'assistant:thinking') {
    appendProcessText(processRecord(key), event.text || '')
  } else if (event.type === 'tool:start') {
    appendProcessTool(processRecord(key), event.name, event.args || {})
  } else if (event.type === 'tool:result') {
    appendProcessToolResult(processRecord(key), event.name, event.result || '', event.outcome)
  } else if (event.type === 'notice' || event.type === 'capability:missing') {
    appendProcessText(processRecord(key), '\n' + (event.text || '') + '\n')
  } else if (event.type === 'approval') {
    /* 后台会话要授权：以前这里被整体丢掉，那条会话会静默卡到 5 分钟超时被拒。 */
    handleBackgroundApproval(key, event)
  } else {
    return
  }
  commitProcessRecord(key)
}

/* 后台会话的授权：能自动放行的（本会话授权 / 放行清单）直接放行，
   否则弹窗（排队 + 标题点明是哪条会话），并把结果记进它的思考过程。 */
async function handleBackgroundApproval(sessionId, event) {
  const request = event.request || {}
  const title = request.title || 'Approve action'
  const session = findSessionById(sessionId)
  if (event.expired === true) {
    /* 超时了：把这条会话可能还开着的弹窗收掉（服务端已按拒绝处理）。 */
    expireApproval(event.id)
    appendProcessText(processRecord(sessionId), '\n\u6388\u6743\u8bf7\u6c42\u5df2\u8d85\u65f6\uff0c\u6309\u62d2\u7edd\u5904\u7406\uff1a' + title + '\n')
    commitProcessRecord(sessionId)
    return
  }
  const label = session && session.title ? session.title : sessionId
  const grant = approvalGrant(request, session)
  let approved = false
  let text = ''
  if (grant !== '') {
    approved = true
    text = '\n\u5df2\u6309' + (grant === 'session' ? '\u672c\u4f1a\u8bdd\u6388\u6743' : '\u653e\u884c\u6e05\u5355') +
      '\u81ea\u52a8\u6279\u51c6\uff1a' + title + '\n'
  } else {
    const decision = await requestApproval(request, label, event.id)
    approved = decision.approved === true
    if (approved) await rememberApproval(decision.scope, request, session)
    text = '\n' + (approved ? '\u5df2\u6279\u51c6\uff1a' : '\u5df2\u62d2\u7edd\uff1a') + title + '\n'
  }
  try {
    await window.dsh.approve(event.id, approved)
  } catch (error) {
    text += '\u56de\u590d\u6388\u6743\u5931\u8d25\uff1a' + (error && error.message ? error.message : String(error)) + '\n'
  }
  appendProcessText(processRecord(sessionId), text)
  commitProcessRecord(sessionId)
}

function updateThinking(text) {
  const body = beginThinking('')
  appendProcessText(body, text)
  saveThinkingProcess(body)
  updateRunStatus()
  scrollToBottom()
}

function appendThinkingToolStart(name, args) {
  const content = beginThinking('')
  appendProcessTool(content, name, args)
  saveThinkingProcess(content)
  updateRunStatus()
  scrollToBottom()
}

function appendThinkingToolResult(name, result, executionOutcome) {
  const content = beginThinking('')
  appendProcessToolResult(content, name, result, executionOutcome)
  saveThinkingProcess(content)
  updateRunStatus()
  scrollToBottom()
}

/* 把已记录的过程接进「进行中」的块：切回一条正在跑的会话时用它续上，
   不然会另起一个空的「正在思考...」，之前的过程看着像丢了。 */
function resumeThinking(seed) {
  const body = beginThinking(seed ? '' : '\u6b63\u5728\u601d\u8003...')
  if (seed) body.innerHTML = seed
  /* 续接：已有内容就在块里（seed 或空块），别再兜一次，否则保存回去会自己叠自己。 */
  state.thinkingBase = ''
  return body
}

function endThinking(label) {
  clearWaitingTimer()
  /* 结束所有残留活动块，避免旧块失去引用后仍显示转圈。 */
  const blocks = Array.from(messagesContent().querySelectorAll('.thinking-active'))
  if (state.currentThinkingDetails && blocks.indexOf(state.currentThinkingDetails) === -1) blocks.push(state.currentThinkingDetails)
  for (const details of blocks) {
    details.classList.remove('thinking-active')
    const content = details.querySelector('.thinking-content')
    const step = content ? activeTimelineStep(content) : null
    /* 收尾时还在转圈的那步（比如等模型回复时）按完成结掉，耗时一并落盘。 */
    if (step) closeTimelineStep(step, label === '已停止' ? 'cancelled' : label === '执行失败' ? false : true)
    refreshTimelineSummary(details, content, false)
    const summary = details.querySelector('summary')
    const text = content ? timelineSummaryText(content, false) : ''
    /* 没有步骤的老块保持原标题，别把「思考过程」换成空的「已执行 0 步」。 */
    if (summary && text === '') summary.textContent = label || '思考过程'
  }
  state.currentThinking = null
  state.currentThinkingDetails = null
  if (not(currentRunning()) || label) stopRunStatus()
}

/* ---- 运行状态行 ----
   消息区底部那一行「正在 读取 package.json…（12s）」。
   以前发出去之后界面上只有一条折叠条，用户分不清是在跑、卡住了还是已经结束。 */
const RUN_STATUS_TICK = 500

function currentStepTitle() {
  const step = state.currentThinking ? activeTimelineStep(state.currentThinking) : null
  if (not(step)) {
    const execution = currentSession() && currentSession().lastExecution
    const name = execution && execution.status === 'running' && execution.activeTool && execution.activeTool.name
    return name ? (TOOL_STEP_TITLES[name] || name) : ''
  }
  const title = step.querySelector('.tl-title')
  return title ? String(title.textContent || '') : ''
}

function updateRunStatus() {
  const box = byId('runStatus')
  if (not(box)) return
  if (not(currentRunning())) { stopRunStatus(); return }
  box.classList.remove('hidden')
  const label = byId('runStatusText')
  const title = currentStepTitle()
  const nextLabel = '正在 ' + (title || '分析任务') + '…'
  if (label && label.textContent !== nextLabel) label.textContent = nextLabel
  const active = state.currentThinking && activeTimelineStep(state.currentThinking)
  if (active) { const dur = active.querySelector('.tl-dur'); const start = Number(active._startAt || active.getAttribute('data-started-at')); if (dur && start) dur.textContent = formatDuration(Date.now() - start) }
  box.classList.toggle('timeline-status-covered', Boolean(state.currentThinking && timelineStepCount(state.currentThinking)))
  if (state.currentThinking) refreshTimeline(state.currentThinking)
  const time = byId('runStatusTime')
  const execution = currentSession() && currentSession().lastExecution
  const savedStart = execution && execution.status === 'running' && Date.parse(execution.startedAt)
  if (time) time.textContent = formatDuration(savedStart ? Date.now() - savedStart : state.runStartedAt ? Date.now() - state.runStartedAt : 0)
}

function startRunStatus() {
  if (not(currentRunning())) return
  if (not(state.runStartedAt)) state.runStartedAt = Date.now()
  updateRunStatus()
  if (state.runStatusTimer) return
  state.runStatusTimer = setInterval(updateRunStatus, RUN_STATUS_TICK)
}

function stopRunStatus() {
  if (state.runStatusTimer) {
    clearInterval(state.runStatusTimer)
    state.runStatusTimer = null
  }
  state.runStartedAt = 0
  const box = byId('runStatus')
  if (box) box.classList.add('hidden')
}

function scheduleWaitingHint() {
  clearWaitingTimer()
  if (not(currentRunning())) return
  const sessionId = state.currentSessionId
  state.waitingTimer = setTimeout(() => {
    if (state.currentSessionId !== sessionId || not(currentRunning())) return
    /* 8 秒还没有任何增量才提示；这时时间线还是空的，补一步说明，别只留个空折叠条。 */
    const body = beginThinking('')
    if (timelineSteps(body).length === 0) {
      appendProcessText(body, '模型还没有返回，可能正在加载，请稍候…')
    }
    scrollToBottom()
  }, 8000)
}

/* 事件路由。后端是多实例池，每条事件都盖着发起它的 sessionId：
   - 当前会话（或老宿主没盖戳）的增量 → 正常画进 DOM；
   - 别的会话的事件 → 只有 finished 要处理（把权威消息写回那条会话 + 摘掉它的「在跑」），
     其余一律不碰 DOM（否则 A 的增量会画到 B 的画布上）。
   这样两条会话并行时，各自的增量各回各家。 */
function settleRun(sessionId, event) {
  const targetId = sessionId || state.currentSessionId
  if (not(targetId)) return
  /* finished 里带的是服务器手里的权威消息：断线期间丢掉的增量靠它一次补齐。
     注意别用空数组覆盖 —— 没有 messages 字段（比如 reset）就只摘运行标记。 */
  if (Array.isArray(event.messages)) updateSessionMessages(targetId, event.messages, event.memory)
  const completedSession = findSessionById(targetId)
  if (completedSession && event.execution) { completedSession.lastExecution = event.execution; saveSessionStore() }
  removeRun(targetId)
  /* 过程已经逐条同步进 session.processHtml 了，这里把游离累积区收掉 */
  commitProcessRecord(targetId)
  dropProcessRecord(targetId)
  const isCurrent = targetId === state.currentSessionId
  if (isCurrent) {
    endThinking(event.execution && event.execution.status === 'cancelled' ? '已停止' : event.execution && event.execution.status === 'failed' ? '执行失败' : '')
    clearWaitingTimer()
    if (state.liveRun !== true) renderMessages(findSessionById(targetId))
    state.liveRun = false
  }
  renderWorkspaceList()
  applyRunState()
  flushPendingMessage()
}

async function handleEvent(event) {
  if (not(event) || not(event.type)) return
  if (event.type.startsWith('workflows:')) {if(window.workflowUI)window.workflowUI.refresh();return}
  if (event.type.startsWith('knowledge:')) { if (window.knowledgeUI) window.knowledgeUI.refresh(); return }
  if (event.type.startsWith('tasks:')) { if (window.scheduledTasks) window.scheduledTasks.onEvent(event); return }
  if (event.type === 'connection') { if (window.agentUI) window.agentUI.connection(event.connected, event.message); return }
  if (event.type === 'user') return
  const eventSessionId = event.sessionId ? String(event.sessionId) : ''
  const isCurrent = eventSessionId === '' || eventSessionId === state.currentSessionId
  if (isCurrent && window.agentUI && event.type === 'tool:result') window.agentUI.planResult(event.result || '')
  if(window.workflowChat&&event.type==='tool:result')window.workflowChat.recordDraft(eventSessionId||state.currentSessionId,event.name,event.result)
  recordProcessTimeline(eventSessionId || state.currentSessionId, event)

  if (event.type === 'finished') {
    settleRun(eventSessionId, event)
    return
  }
  /* 别的会话的过程事件：不画进当前画布（它的最终结果由 finished 带回来），
     但**必须记进它自己的思考过程** —— 以前这里是直接 return，导致在后台跑完的会话
     切回去时「思考过程」整块是空的（用户 2026-09-19 报的 bug）。 */
  if (not(isCurrent)) {
    recordBackgroundProcess(eventSessionId, event)
    return
  }
  if (event.type === 'context:compress:start') {
    setStatus('compressing context (' + (event.count || 0) + ' messages)')
    return
  }
  if (event.type === 'context:compressed') {
    setStatus('context compressed (' + (event.compressedCount || 0) + ' messages)')
    return
  }
  if (event.type === 'approval') {
    const request = event.request || {}
    const title = request.title || 'Approve action'
    if (event.expired === true) {
      /* 先把可能还开着的弹窗收掉（服务端已经按拒绝处理了），否则它会一直占着队列。 */
      expireApproval(event.id)
      updateThinking('\n\u6388\u6743\u8bf7\u6c42\u5df2\u8d85\u65f6\uff0c\u6309\u62d2\u7edd\u5904\u7406\uff1a' + title + '\n')
      return
    }
    const session = findSessionById(state.currentSessionId)
    const grant = approvalGrant(request, session)
    if (grant !== '') {
      window.dsh.approve(event.id, true).catch((error) => {
        addBubble('error', formatError(error && error.message ? error.message : String(error)))
      })
      const source = grant === 'session' ? '\u672c\u4f1a\u8bdd\u6388\u6743' : '\u653e\u884c\u6e05\u5355'
      updateThinking('\n\u5df2\u6309' + source + '\u81ea\u52a8\u6279\u51c6\uff1a' + title + '\n')
      return
    }
    const decision = await requestApproval(request, '', event.id)
    if (decision.approved) await rememberApproval(decision.scope, request, session)
    window.dsh.approve(event.id, decision.approved).catch((error) => {
      addBubble('error', formatError(error && error.message ? error.message : String(error)))
    })
    let approvalText = (decision.approved ? '\u5df2\u6279\u51c6\uff1a' : '\u5df2\u62d2\u7edd\uff1a') + title
    if (decision.approved && decision.scope === 'session') approvalText += '\uff08\u672c\u4f1a\u8bdd\u5185\u4e0d\u518d\u8be2\u95ee\uff09'
    if (decision.approved && decision.scope === 'always') approvalText += '\uff08\u5df2\u52a0\u5165\u653e\u884c\u6e05\u5355\uff09'
    updateThinking('\n' + approvalText + '\n')
    return
  }
  if (event.type === 'assistant:thinking') {
    clearWaitingTimer()
    updateThinking(event.text || '')
    return
  }
  if (event.type === 'assistant:delta') {
    clearWaitingTimer()
    const body = beginAssistant()
    const raw = (body.dataset.raw || '') + (event.text || '')
    setBubbleText(body, raw, true)
    scrollToBottom()
    return
  }
  if (event.type === 'assistant:message') {
    clearWaitingTimer()
    endThinking()
    endAssistant(event.text || '')
    return
  }
  if (event.type === 'tool:start') {
    clearWaitingTimer()
    if (state.currentAssistant) {
      state.currentAssistant = null
    }
    appendThinkingToolStart(event.name, event.args || {})
    return
  }
  if (event.type === 'tool:result') {
    appendThinkingToolResult(event.name, event.result || '', event.outcome)
    scheduleWaitingHint()
    return
  }
  if (event.type === 'capability:missing') {
    clearWaitingTimer()
    updateThinking('\n' + (event.text || '') + '\n')
    showCapabilityModal(event.text || '')
    return
  }
  if (event.type === 'notice') {
    clearWaitingTimer()
    updateThinking('\n' + (event.text || '') + '\n')
    addBubble('notice', event.text || '')
    scrollToBottom()
    return
  }
  if (event.type === 'status') {
    setStatus(event.text)
    if (String(event.text || '').startsWith('thinking')) scheduleWaitingHint()
    return
  }
  if (event.type === 'error') {
    clearWaitingTimer()
    endThinking('执行失败')
    addBubble('error', formatError(event.message || '未知错误'))
    return
  }
  /* finished 已经在 handleEvent 开头交给 settleRun 处理（它要能在「别的会话」上跑） */
  if (event.type === 'done') {
    clearWaitingTimer()
    endThinking()
    if (state.currentAssistant) endAssistant(event.text || '')
  }
}

function buildUserContent(text, images) {
  const hasImages = Array.isArray(images) && images.length > 0
  if (not(hasImages)) return text
  /* 只发图片：不要再塞 {"type":"text","text":""} 段 —— 有些模型服务直接判 400，
     而且这段空文本会跟着会话历史一直传下去。 */
  const head = String(text || '') === '' ? [] : [{ type: 'text', text: text }]
  return head.concat(images.map((url) => ({ type: 'image_url', image_url: { url } })))
}

/* 队列是**按会话**的：消息排在哪条会话上，就只在那条会话里被冲出去。
   不然 A 会话排队的消息会在 B 会话（或用户切走之后）被冲掉，还会把用户正打的字顶掉。 */
function queueMessage(text, images, bubble) {
  const item = {
    sessionId: state.currentSessionId,
    text: String(text || ''),
    images: Array.isArray(images) ? images.slice() : [],
    bubble: bubble || null
  }
  if (item.text === '' && item.images.length === 0) return
  state.pendingMessages.push(item)
  setStatus('queued')
  scheduleQueueFlush()
}

function pendingCountForCurrent() {
  let count = 0
  for (const item of state.pendingMessages) {
    if (item.sessionId === state.currentSessionId) count += 1
  }
  return count
}

function scheduleQueueFlush() {
  if (state.queueTimer) clearTimeout(state.queueTimer)
  state.queueTimer = setTimeout(async () => {
    state.queueTimer = null
    if (state.pendingMessages.length === 0) return
    await syncRunningState()
    /* 本会话还在跑就继续等；别的会话的队列不归这条定时器管（切回去时冲） */
    if (currentRunning()) {
      scheduleQueueFlush()
      return
    }
    flushPendingMessage()
  }, 2000)
}

function flushPendingMessage() {
  if (currentRunning()) return
  let index = -1
  for (let cursor = 0; cursor < state.pendingMessages.length; cursor += 1) {
    if (state.pendingMessages[cursor].sessionId === state.currentSessionId) {
      index = cursor
      break
    }
  }
  if (index < 0) return
  const next = state.pendingMessages.splice(index, 1)[0]
  if (next.bubble && typeof next.bubble.remove === 'function') next.bubble.remove()
  const input = byId('input')
  if (not(input)) return
  input.innerText = next.text || ''
  clearComposerAttachments()
  for (const url of (next.images || [])) addComposerAttachment(url)
  autoResizeComposer()
  sendMessage()
  /* 队列里还有（一次冲不完 / 冲出去又被打回队列）就继续盯着，别让它们在数组里睡死 */
  if (pendingCountForCurrent() > 0) scheduleQueueFlush()
}

/* 与宿主对表，把「哪几条会话在跑」整份换成宿主说的样子。
   返回值 = 当前这条会话在不在跑（调用方最关心它）。 */
async function syncRunningState() {
  try {
    const next = await window.dsh.getState()
    if (window.agentUI) window.agentUI.connection(true)
    state.settings = next.settings || state.settings
    state.workspacePath = next.workspacePath || state.workspacePath
    state.runLimit = Number(next.maxConcurrentRuns) > 0 ? Number(next.maxConcurrentRuns) : state.runLimit
    if (next.executions) {
      for (const id of Object.keys(next.executions)) { const session = findSessionById(id); if (session) session.lastExecution = next.executions[id] }
    }
    if (byId('statusLine') && byId('statusLine').getAttribute('data-connection') === 'error') setStatus('ready')
    const previousRuns = JSON.stringify(state.runs)
    applyRuns(next.runningSessions, next.running)
    if (JSON.stringify(state.runs) !== previousRuns) renderWorkspaceList()
    applyRunState()
    return currentRunning()
  } catch (error) {
    if (window.agentUI) window.agentUI.connection(false, error.message)
    setStatus('服务连接失败：' + error.message)
    return currentRunning()
  }
}

/* 「正在发送」这件事唯一的时基。
   本地账本（state.runs）只靠事件/回调维护：事件流断线、切换会话时错过 finished、
   页面刷新过、await 的 send 挂在半路，都会让某条会话永远停在「在跑」—— 表现就是
   按钮停在「停止」、后续消息全被塞进队列（用户报的「切换会话之后就不能发送了」）。
   所以常驻一条 5 秒的对表：以宿主为准整份改写账本（顺带刷新设置/工作区），
   并把当前会话积压的队列冲出去。
   句柄 unref()：冒烟脚本把 app.js 跑在 vm 里，别让这条定时器拖住宿主进程。 */
function startRunPoll() {
  if (state.runPoll) return
  state.runPoll = setInterval(async () => {
    await syncRunningState()
    flushPendingMessage()
  }, 5000)
  if (state.runPoll && typeof state.runPoll.unref === 'function') state.runPoll.unref()
}

/* 池里一共几条在跑（含当前会话）—— 只有「满没满」这一个用途 */
function runningTotal() {
  let count = 0
  for (const id of Object.keys(state.runs)) {
    if (state.runs[id] === true) count += 1
  }
  return count
}

/* 输入框上方那条提示：**只在并发池满、而且本会话发得出去的时候**才出现。
   别的会话在跑但池还有空位 = 正常并发（R20 起后端就是多实例池，一条会话一台 worker），
   那种情况提示一句「可以同时发送」等于把正常能力说成异常，橙色点还容易被当成报错
   （用户 2026-09-19：既然已经支持并发了，这个是不是就多余了）。
   真正值得提前说的是**再发就会被拒**：池满时后端直接 503 POOL_BUSY、不排队（见 sendMessage），
   所以这里先说清楚，别让用户点完才撞红字。
   本会话自己也在跑时不说这句 —— 那时他按的是「停止」，Enter 也只会走 SESSION_BUSY 排队，
   「再发会被拒」不成立。
   runLimit 未知（旧宿主没回报 maxConcurrentRuns）时不猜 —— 宁可不提示，也不误报。 */
function updateComposerRunHint() {
  const hint = byId('composerRunHint')
  if (not(hint)) return
  const total = runningTotal()
  const full = state.runLimit > 0 && total >= state.runLimit && not(currentRunning())
  hint.classList.toggle('hidden', not(full))
  if (full) {
    hint.textContent = '\u5e76\u53d1\u5df2\u6ee1\uff08' + total + '/' + state.runLimit +
      '\uff09\uff0c\u518d\u53d1\u4f1a\u88ab\u62d2 \u2014\u2014 \u7b49\u4e00\u6761\u8dd1\u5b8c\uff0c\u6216\u5230\u8bbe\u7f6e\u91cc\u8c03\u5927\u4e0a\u9650'
  }
}

/* 发送 / 停止按钮只看「当前这条会话」：
   本会话在跑 → 藏发送、露停止；本会话空闲 → 反过来（哪怕别的会话在跑也照样能发）。 */
function applyRunState() {
  const running = currentRunning()
  if (window.agentUI) { window.agentUI.context(currentSession(), state.settings); window.agentUI.runState(running) }
  if (not(running)) endThinking()
  const send = byId('send')
  const stop = byId('stop')
  if (send) {
    send.classList.toggle('hidden', running)
    send.disabled = false
  }
  if (stop) {
    stop.disabled = not(running)
    stop.classList.toggle('hidden', not(running))
  }
  const input = byId('input')
  if (input) {
    input.contentEditable = 'true'
    input.classList.remove('disabled')
  }
  updateComposerRunHint()
  /* 本会话在跑就把底部状态行挂上（含 500ms 刷新耗时），不跑就收掉。 */
  if (running) startRunStatus()
  else stopRunStatus()
}

const PERMISSION_LABELS = {
  readonly: '\u4ec5\u53ef\u67e5\u770b',
  workspace: '\u5de5\u4f5c\u533a\u5185\u4fee\u6539',
  full: '\u5b8c\u5168\u6743\u9650'
}
const PERMISSION_ICONS = { readonly: 'shield-check', workspace: 'shield-edit', full: 'shield-warn' }
const PERMISSION_HINTS = {
  readonly: '文件只读，不能写入或编辑；命令需单独授权。',
  workspace: '可修改工作区文件；命令和浏览器操作会询问确认，可选择仅一次或本会话授权。',
  full: '允许普通命令和文件写入；删除等危险操作仍需确认。'
}

function permissionInfo(mode) {
  const key = PERMISSION_LABELS[mode] ? mode : 'workspace'
  return { mode: key, label: PERMISSION_LABELS[key], icon: PERMISSION_ICONS[key] }
}

function closePermissionMenus(except) {
  const dropdowns = document.querySelectorAll('[data-permission-dropdown]')
  for (const root of dropdowns) {
    if (except && root === except) continue
    const menu = root.querySelector('.dropdown-menu')
    if (menu) menu.classList.add('hidden')
    root.classList.remove('open')
  }
}

function renderPermission() {
  const mode = state.settings && state.settings.permissionMode ? state.settings.permissionMode : 'workspace'
  const info = permissionInfo(mode)
  const dropdowns = document.querySelectorAll('[data-permission-dropdown]')
  for (const root of dropdowns) {
    root.setAttribute('data-permission-mode', info.mode)
    const trigger = root.querySelector('.dropdown-trigger'); if (trigger) trigger.title = PERMISSION_HINTS[info.mode] || info.label
    const label = root.querySelector('[data-permission-label]')
    if (label) label.textContent = info.label
    const icon = root.querySelector('[data-permission-icon]')
    if (icon) { icon.setAttribute('data-icon', info.icon); if (window.renderIcon) icon.innerHTML = window.renderIcon(info.icon) }
    const items = root.querySelectorAll('[data-permission-option]')
    for (const item of items) {
      const active = item.getAttribute('data-permission-option') === mode
      item.classList.toggle('active', active)
      const check = item.querySelector('.dropdown-check')
      if (check) check.classList.toggle('hidden', not(active))
    }
    const menu = root.querySelector('.dropdown-menu')
    if (menu) {
      let hint = menu.querySelector('.dropdown-hint')
      if (not(hint)) {
        hint = document.createElement('div')
        hint.className = 'dropdown-hint'
        menu.appendChild(hint)
      }
      hint.textContent = PERMISSION_HINTS[info.mode] || ''
    }
  }
}

async function setPermissionMode(mode) {
  const info = permissionInfo(mode)
  state.settings = await window.dsh.saveSettings({ permissionMode: info.mode })
  renderPermission()
  setStatus('permission ' + info.mode)
}

function setupPermissionDropdowns() {
  const dropdowns = document.querySelectorAll('[data-permission-dropdown]')
  for (const root of dropdowns) {
    const trigger = root.querySelector('.dropdown-trigger')
    const menu = root.querySelector('.dropdown-menu')
    if (not(trigger) || not(menu)) continue
    trigger.addEventListener('click', (event) => {
      event.stopPropagation()
      const willOpen = menu.classList.contains('hidden')
      closePermissionMenus(root)
      menu.classList.toggle('hidden', not(willOpen))
      root.classList.toggle('open', willOpen)
    })
    const items = root.querySelectorAll('[data-permission-option]')
    for (const item of items) {
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        const nextMode = item.getAttribute('data-permission-option')
        setPermissionMode(nextMode).catch((error) => addBubble('error', formatError(error && error.message ? error.message : String(error))))
        closePermissionMenus()
      })
    }
  }
  document.addEventListener('click', () => closePermissionMenus())
}
/* 内置插件的展示信息：标题 / 图标 / 说明 */
const PLUGIN_META = {
  'builtin/browser-tools': { title: '浏览器工具', icon: 'plugin', description: '浏览器操作、页面检查与自动化测试' },
  'builtin/self-validate': { title: '运行验证', icon: 'plugin', description: '管理后台进程、等待服务就绪并记录验证结果' },
  'core/plans': { title: '任务计划', icon: 'plugin', description: '通过工具结果记录计划与实际进度，不代替执行状态' },
  'core/mcp': { title: 'MCP 连接器', icon: 'plugin', description: '连接外部 MCP 服务并注册其工具' },
  'core/contracts': { title: '协议契约', icon: 'plugin', description: '服务接口与事件校验' },
  'core/state': { title: '会话状态', icon: 'plugin', description: '会话状态与合法迁移' },
  'core/flow': { title: '流程策略', icon: 'plugin', description: 'Agent 执行策略' },
  'core/config': { title: '运行配置', icon: 'plugin', description: 'Agent 运行配置' },
  'core/permissions': { title: '权限管理', icon: 'plugin', description: '工具操作权限与审批' },
  'core/tools': { title: '工具注册', icon: 'plugin', description: '工具校验与调度' },
  'core/prompts': { title: '提示词管理', icon: 'plugin', description: '组装模型提示词' },
  'core/context': { title: '上下文管理', icon: 'plugin', description: '处理模型上下文' },
  'core/skills': { title: '技能管理', icon: 'plugin', description: '技能内容处理' },
  'core/llm': { title: '模型服务', icon: 'plugin', description: '模型请求与响应校验' },
  'core/sessions': { title: '会话存储', icon: 'plugin', description: '事件日志、快照与恢复' },
  'core/memory': { title: '记忆管理', icon: 'plugin', description: '会话记忆与上下文压缩' },
  'core/agent-loop': { title: '执行循环', icon: 'plugin', description: 'Agent 执行、超时与取消' },
  'core/agents': { title: '智能体管理', icon: 'plugin', description: 'Agent 实例生命周期' },
  'builtin/fs-tools': { title: '\u6587\u4ef6\u8bfb\u5199', icon: 'folder', description: '\u6d4f\u89c8\u3001\u8bfb\u53d6\u3001\u521b\u5efa\u3001\u7f16\u8f91\u5de5\u4f5c\u533a\u5185\u7684\u6587\u4ef6\uff08list_dir / read_file / write_file / edit_file\uff09' },
  'builtin/search-tools': { title: '\u5185\u5bb9\u641c\u7d22', icon: 'model', description: '\u6309\u5173\u952e\u8bcd\u641c\u7d22\u5de5\u4f5c\u533a\u6587\u4ef6\u5185\u5bb9\uff08search_files\uff09' },
  'builtin/shell-tools': { title: '\u547d\u4ee4\u6267\u884c', icon: 'send', description: '\u5728\u5de5\u4f5c\u533a\u91cc\u6267\u884c\u672c\u5730\u547d\u4ee4\uff0c\u53d7\u6743\u9650\u6863\u4f4d\u7ea6\u675f\uff08run_command\uff09' },
  'builtin/skill-tools': { title: '\u5185\u7f6e\u6280\u80fd', icon: 'plugin', description: '\u968f\u5305\u5185\u7f6e\u7684 Markdown \u6280\u80fd\u5e93\uff08SKILL.md\uff09\uff1a\u6309\u4efb\u52a1\u53d6\u7528\u73b0\u6210\u64cd\u4f5c\u6307\u5357\uff08load_skill / search_skills\uff09' }
}

function pluginDisabledList() {
  const settings = state.settings || {}
  return Array.isArray(settings.disabledPlugins) ? settings.disabledPlugins : []
}

function isPluginEnabled(name) {
  return pluginDisabledList().indexOf(String(name || '')) === -1
}

/* 侧边栏入口右侧的计数（2026-10-17 按参考样式加的）。
   只写真实可得的数字：技能与规则按「已启用插件数」算；
   资料库目前还没有条目清单（服务端只有按 id 取单个资源，没有列表端点），
   所以先留空 —— 写个假的「6」比空着更糟：用户会以为里面真有 6 条。 */
function updateShortcutMeta() {
  const enabled = cachedPluginList.filter((name) => isPluginEnabled(name)).length
  const meta = byId('customizeCount')
  if (meta) {
    const skills = typeof systemSkillList === 'undefined' ? [] : systemSkillList
    const total = enabled + skills.filter((item) => !(state.settings.disabledSkills || []).includes(item.id)).length
    meta.textContent = total > 0 ? (total + ' 项启用') : ''
    meta.title = '已启用的插件与工具能力'
  }
  const library = byId('libraryCount')
  if (library) {
    library.title = '知识库数量'
  }
}

async function togglePlugin(name) {
  const target = String(name || '')
  if (target === '') return
  const disabled = pluginDisabledList().slice()
  const index = disabled.indexOf(target)
  if (index === -1) disabled.push(target)
  else disabled.splice(index, 1)
  state.settings = await window.dsh.saveSettings({ disabledPlugins: disabled })
  renderPlugins()
  setStatus(isPluginEnabled(target) ? '\u63d2\u4ef6\u5df2\u542f\u7528\uff1a' + target : '\u63d2\u4ef6\u5df2\u505c\u7528\uff1a' + target)
}

let cachedPluginList = []
let cachedToolList = []

function renderPlugins(plugins, tools) {
  const element = byId('pluginList')
  /* 缓存最近一次列表：togglePlugin 等只有 settings 变化的重渲染直接复用 */
  if (Array.isArray(plugins)) cachedPluginList = plugins
  updateShortcutMeta()
  if (not(element)) return
  if (Array.isArray(tools)) cachedToolList = tools
  element.textContent = ''
  const pluginNames = cachedPluginList.filter(name => !window.extensionUI || !window.extensionUI.isManagedPlugin(name))
  const toolItems = cachedToolList
  if (byId('capTabPlugins')) byId('capTabPlugins').textContent = '插件 ' + (pluginNames.length + (window.extensionUI ? window.extensionUI.packageCount('plugin') : 0))
  if (pluginNames.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'muted'
    empty.textContent = '\u672a\u52a0\u8f7d\u63d2\u4ef6'
    element.appendChild(empty)
    return
  }
  for (const name of pluginNames) {
    const meta = PLUGIN_META[name] || { title: '扩展插件', icon: 'plugin', description: '' }
    const pluginTools = toolItems.filter((tool) => tool && tool.plugin === name)
    const enabled = isPluginEnabled(name)

    const card = document.createElement('div')
    card.className = 'plugin-card' + (enabled ? '' : ' plugin-off')

    const head = document.createElement('div')
    head.className = 'plugin-card-head'
    const icon = document.createElement('span')
    icon.className = 'icon plugin-card-icon'
    icon.setAttribute('data-icon', meta.icon)
    if (window.renderIcon) icon.innerHTML = window.renderIcon(meta.icon)
    const title = document.createElement('span')
    title.className = 'plugin-card-title'
    title.textContent = meta.title
    const sub = document.createElement('span')
    sub.className = 'plugin-card-sub'
    sub.textContent = name
    const spacer = document.createElement('span')
    spacer.className = 'plugin-card-spacer'

    const toggle = document.createElement('button')
    toggle.className = 'plugin-switch' + (enabled ? ' on' : '')
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-checked', String(enabled))
    toggle.setAttribute('aria-label', meta.title)
    toggle.title = enabled ? '\u70b9\u51fb\u505c\u7528' : '\u70b9\u51fb\u542f\u7528'
    const knob = document.createElement('span')
    knob.className = 'plugin-switch-knob'
    toggle.appendChild(knob)
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      toggle.disabled = true
      togglePlugin(name).catch((error) => {
        byId('capabilityNotice').textContent = formatError(error && error.message ? error.message : String(error))
        toggle.disabled = false
      })
    })

    head.appendChild(icon)
    head.appendChild(title)
    head.appendChild(sub)
    head.appendChild(spacer)
    head.appendChild(toggle)

    const desc = document.createElement('div')
    desc.className = 'plugin-card-desc'
    desc.textContent = meta.description || (pluginTools.map((tool) => tool.name).join(' / '))

    const chips = document.createElement('div')
    chips.className = 'plugin-card-tools'
    if (pluginTools.length === 0) {
      const none = document.createElement('span')
      none.className = 'plugin-tool-chip'
      none.textContent = '\u65e0\u5de5\u5177'
      chips.appendChild(none)
    }
    for (const tool of pluginTools) {
      const chip = document.createElement('span')
      chip.className = 'plugin-tool-chip'
      chip.textContent = tool.name
      chip.title = (tool.exposedName || tool.name) + (tool.description ? '\n' + tool.description : '')
      chips.appendChild(chip)
    }

    card.appendChild(head)
    card.appendChild(desc)
    card.appendChild(chips)
    element.appendChild(card)
  }
}

function renderWorkspace() {
  const element = byId('workspacePath')
  if (element) {
    element.textContent = state.workspacePath || '未选择工作区'
    element.title = state.workspacePath || ''
  }
  renderWorkspaceList()
}

function readReplyLanguage() {
  const root = document.querySelector('[data-reply-dropdown]')
  if (not(root)) return 'zh'
  const active = root.querySelector('[data-reply-option].active')
  return active && active.getAttribute('data-reply-option') === 'en' ? 'en' : 'zh'
}

function setReplyLanguageUI(lang) {
  const target = lang === 'en' ? 'en' : 'zh'
  const root = document.querySelector('[data-reply-dropdown]')
  if (not(root)) return
  const label = root.querySelector('[data-reply-label]')
  if (label) label.textContent = target === 'en' ? 'English' : '\u4e2d\u6587'
  const items = root.querySelectorAll('[data-reply-option]')
  for (const item of items) {
    const active = item.getAttribute('data-reply-option') === target
    item.classList.toggle('active', active)
    const check = item.querySelector('.dropdown-check')
    if (check) check.classList.toggle('hidden', not(active))
  }
}

function closeReplyMenus(except) {
  const dropdowns = document.querySelectorAll('[data-reply-dropdown]')
  for (const root of dropdowns) {
    if (except && root === except) continue
    const menu = root.querySelector('.dropdown-menu')
    if (menu) menu.classList.add('hidden')
    root.classList.remove('open')
  }
}

function setupReplyLanguageDropdown() {
  const dropdowns = document.querySelectorAll('[data-reply-dropdown]')
  for (const root of dropdowns) {
    const trigger = root.querySelector('.dropdown-trigger')
    const menu = root.querySelector('.dropdown-menu')
    if (not(trigger) || not(menu)) continue
    trigger.addEventListener('click', (event) => {
      event.stopPropagation()
      const willOpen = menu.classList.contains('hidden')
      closeReplyMenus(root)
      menu.classList.toggle('hidden', not(willOpen))
      root.classList.toggle('open', willOpen)
    })
    const items = root.querySelectorAll('[data-reply-option]')
    for (const item of items) {
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        setReplyLanguageUI(item.getAttribute('data-reply-option'))
        scheduleSettingsSave()
        closeReplyMenus()
      })
    }
  }
  document.addEventListener('click', () => closeReplyMenus())
}

function readSettingsForm() {
  return {
    maxIterations: Math.max(1, Math.min(500, Number(byId('maxIterations').value) || 100)),
    /* 并发会话上限：后端按会话起 worker，这里就是「同时能跑几条」 */
    maxConcurrentRuns: Math.max(1, Math.min(64, Number(byId('maxConcurrentRuns').value) || 8)),
    maxTokens: Number(byId('maxTokens').value) || 0,
    contextWindowTokens: Number(byId('contextWindowTokens').value) || 0,
    contextAutoCompress: byId('contextAutoCompress').checked,
    keepRecentMessages: Math.max(2, Math.min(500, Number(byId('keepRecentMessages').value) || 50)),
    requestTimeoutMs: Math.max(5000, Math.min(3600000, (Number(byId('requestTimeoutSeconds').value) || 1800) * 1000)),
    replyLanguage: readReplyLanguage()
  }
}

function fillSettingsForm() {
  const settings = state.settings || {}
  byId('maxIterations').value = settings.maxIterations || 100
  byId('maxConcurrentRuns').value = settings.maxConcurrentRuns || 8
  byId('maxTokens').value = settings.maxTokens === undefined ? 32768 : settings.maxTokens
  byId('contextWindowTokens').value = settings.contextWindowTokens === undefined ? 131072 : settings.contextWindowTokens
  byId('contextAutoCompress').checked = settings.contextAutoCompress !== false
  byId('keepRecentMessages').value = settings.keepRecentMessages || 50
  byId('requestTimeoutSeconds').value = Math.round((settings.requestTimeoutMs || 1800000) / 1000)
  setReplyLanguageUI(settings.replyLanguage === 'en' ? 'en' : 'zh')
  renderProviderList()
  renderPermission()
}

function showSettingsTab(name) {
  const active = name || 'general'
  const tabs = document.querySelectorAll('[data-settings-tab]')
  for (const tab of tabs) tab.classList.toggle('active', tab.getAttribute('data-settings-tab') === active)
  const panels = document.querySelectorAll('[data-settings-panel]')
  for (const panel of panels) panel.classList.toggle('hidden', panel.getAttribute('data-settings-panel') !== active)
}

function openSettings() {
  fillSettingsForm()
  showSettingsTab('general')
  byId('settingsModal').classList.remove('hidden')
}

function closeSettings() {
  byId('settingsModal').classList.add('hidden')
}

let settingsSaveTimer = null
async function saveSettingsNow() {
  if (not(state.settings)) return
  state.settings = await window.dsh.saveSettings(readSettingsForm())
  renderModelSelect()
  renderModelInfo()
  renderPermission()
  renderWorkspace()
  setStatus('settings saved')
}

function scheduleSettingsSave() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  settingsSaveTimer = setTimeout(() => {
    saveSettingsNow().catch((error) => addBubble('error', formatError(error && error.message ? error.message : String(error))))
  }, 350)
}

function addComposerAttachment(dataUrl) {
  const box = byId('composerAttachments')
  if (not(box) || not(dataUrl)) return
  const item = document.createElement('div')
  item.className = 'composer-attachment'
  const image = document.createElement('img')
  image.src = dataUrl
  image.alt = 'pasted-image'
  const remove = document.createElement('button')
  remove.className = 'composer-attachment-remove'
  remove.textContent = '\u00d7'
  remove.addEventListener('click', () => {
    item.remove()
    autoResizeComposer()
  })
  item.appendChild(image)
  item.appendChild(remove)
  box.appendChild(item)
  autoResizeComposer()
}

function clearComposerAttachments() {
  const box = byId('composerAttachments')
  if (box) box.textContent = ''
}

function autoResizeComposer() {
  const input = byId('input')
  if (not(input)) return
  /* 空输入框直接把内联高度撤掉、回落到 CSS（min-height 52）——
     任何路径留下的脏内联高度（发完消息/编辑填入/恢复会话）到这里一律归零。
     用户两次报「重启后输入框又变高了」，与其追每条路径不如空了就归位。 */
  const hasAttachment = input.querySelector && input.querySelector('img')
  if (String(input.innerText || '').trim() === '' && not(hasAttachment)) {
    input.style.height = ''
    input.classList.remove('needs-scroll')
    return
  }
  input.style.height = 'auto'
  /* 上限钉死 180px，和 style.css .composer-input 的 max-height 一致（守卫在 renderer-smoke）。
     别用 innerHeight 的比例 —— 大窗口上 40% 就是半屏，用户骂过「输入框为啥变得这么高」。 */
  const maxHeight = 180
  const nextHeight = Math.min(input.scrollHeight, maxHeight)
  input.style.height = nextHeight + 'px'
  input.classList.toggle('needs-scroll', input.scrollHeight > maxHeight)
}

async function sendMessage() {
  const input = byId('input')
  const text = String(input.innerText || '').trim()
  const attachments = byId('composerAttachments')
  const images = attachments ? Array.from(attachments.querySelectorAll('img')).map((image) => image.src).filter((src) => Boolean(src)) : []
  if (text === '' && images.length === 0) return
  /* 本地账本只是记忆，可能是遗留的假状态（事件流断线 / 错过 finished）。
     直接排队会让用户看到「已加入队列，等待上一条完成」却永远等不到 —— 先跟宿主对一次表，
     宿主说这条会话没在跑就往下走正常发送。
     注意只关心**当前这条会话**：别的会话在跑完全不影响这里（多实例池）。 */
  if (currentRunning()) {
    await syncRunningState()
  }
  if (currentRunning()) {
    const queuedBubble = addUserBubble(buildUserContent(text, images))
    queueMessage(text, images, queuedBubble)
    input.innerHTML = ''
    clearComposerAttachments()
    autoResizeComposer()
    return
  }
  if (not(state.workspacePath) && !(currentSession() && currentSession().knowledgeBaseId)) {
    addBubble('error', '\u8bf7\u5148\u9009\u62e9\u6216\u65b0\u5efa\u672c\u5730\u5de5\u4f5c\u533a\u76ee\u5f55')
    return
  }
  const active = activeModel() || {}
  if (not(active.baseURL) || not(active.model)) {
    addBubble('error', '\u8bf7\u5148\u914d\u7f6e\u6a21\u578b\uff1a\u670d\u52a1\u5730\u5740\u548c\u6a21\u578b\u540d\u4e0d\u80fd\u4e3a\u7a7a')
    openSettings()
    showSettingsTab('model')
    return
  }
  let session = currentSession()
  if (not(session)) {
    /* 首页直接发送与「新建会话」一样生成最近会话；选中空项目后发送，
       则归入该项目。独立工作区不一定已经建项目，也必须有自己的会话 id。 */
    const projectId = state.activeProjectId || ''
    const scope = projectId ? 'project' : 'recent'
    session = createSession(projectId || (state.settings && state.settings.currentProjectId), undefined, scope)
    state.currentSessionId = session.id
    state.activeProjectId = scope === 'project' ? session.projectId : ''
    if (scope === 'project') state.expandedProjects[session.projectId] = true
    saveCurrentSessionId(session.id)
  }
  const sessionId = session ? session.id : ''
  const history = session && Array.isArray(session.messages) ? session.messages.slice() : []
  const memory = session && session.memory ? session.memory : undefined
  let workflowText=text
  try{if(window.workflowChat)workflowText=await window.workflowChat.textFor(session,text)}catch(error){addBubble('error','流程引用读取失败：'+error.message);return}
  const chatPayload = JSON.stringify({ text:workflowText, history, images, memory })
  const chatBytes = typeof Blob === 'function' ? new Blob([chatPayload]).size : chatPayload.length
  if (chatBytes > 32 * 1024 * 1024) {
    addBubble('error', '本次消息与附件过大，请减少附件或新建会话；草稿已保留。'); return
  }
  const userContent = buildUserContent(text, images)
  if (session) {
    /* 新一轮开始：把上一轮的思考块**收尾**（去掉「进行中」样式、标题改回「思考过程」），
       但过程本身必须留着 —— 它已经累积在 session.processHtml 里。
       这里以前写的是 session.processHtml = ''，等于每发一条消息就把整条会话的思考过程
       全清掉，用户 2026-09-23 报的「思考过程还是会丢失」主因就是它（攒了多少轮都白攒）。 */
    endThinking()
    session.messages = session.messages.concat([{ role: 'user', content: userContent }])
    maybeAutoTitle(session, text || (images.length > 0 ? '\u56fe\u7247' : ''))
    rememberSentMessage(text)
    session.updatedAt = new Date().toISOString()
    saveSessionStore()
    renderWorkspaceList()
  }
  const userBubble = addUserBubble(userContent)
  input.innerHTML = ''
  clearComposerAttachments()
  autoResizeComposer()
  if (window.agentUI) window.agentUI.clearPlan()
  addRun(sessionId)
  state.liveRun = true
  applyRunState()
  beginThinking('\u6b63\u5728\u601d\u8003...')
  scheduleWaitingHint()
  /* SESSION_BUSY：这条会话自己还在跑 → 排队等它（原有行为）。
     POOL_BUSY：整个池满了（设置里的并发上限）→ 不排队，排队也等不到，
     直接告诉用户把上限调大或稍后再发。 */
  let isBusy = false
  try {
    await window.dsh.send(workflowText, history, images, memory, sessionId)
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error)
    const isPoolBusy = message.indexOf('POOL_BUSY') !== -1
    isBusy = not(isPoolBusy) && message.indexOf('BUSY') !== -1
    endThinking()
    if (isBusy || isPoolBusy) {
      /* 这条没跑起来：把乐观写进去的用户消息回滚，避免历史里留下重复的一条 */
      if (session) {
        session.messages = history.slice()
        session.updatedAt = new Date().toISOString()
        saveSessionStore()
        renderWorkspaceList()
      }
      if (userBubble && typeof userBubble.remove === 'function') userBubble.remove()
    }
    if (isBusy) {
      const queuedBubble = addUserBubble(buildUserContent(text, images))
      queueMessage(text, images, queuedBubble)
    } else if (isPoolBusy) {
      addBubble('error', '\u5e76\u53d1\u4f1a\u8bdd\u5df2\u8fbe\u4e0a\u9650\uff08' +
        (state.runLimit > 0 ? state.runLimit : '设置里配置的') +
        ' \u6761\uff09\uff0c\u8bf7\u7b49\u4e00\u6761\u8dd1\u5b8c\uff0c\u6216\u5230\u8bbe\u7f6e\u91cc\u8c03\u5927\u4e0a\u9650')
    } else {
      addBubble('error', formatError(message))
    }
  } finally {
    /* 还排着队（SESSION_BUSY）就保持「在跑」的显示；否则摘掉本会话的运行标记 */
    if (not(isBusy)) removeRun(sessionId)
    else addRun(sessionId)
    applyRunState()
  }
}

function promptText(title, defaultValue) {
  const prior=document.activeElement
  return new Promise((resolve) => {
    const modal = byId('textPromptModal')
    const input = byId('textPromptInput')
    const ok = byId('textPromptOk')
    const cancel = byId('textPromptCancel')
    byId('textPromptTitle').textContent = title
    input.value = defaultValue || ''
    modal.classList.remove('hidden')
    input.focus()
    const cleanup = () => {
      modal.classList.add('hidden')
      ok.removeEventListener('click', onOk)
      cancel.removeEventListener('click', onCancel)
      input.removeEventListener('keydown', onKey)
      setTimeout(()=>{if(prior&&prior.isConnected&&typeof prior.focus==='function')prior.focus()},0)
    }
    const onOk = () => {
      const value = input.value.trim()
      cleanup()
      resolve(value)
    }
    const onCancel = () => {
      cleanup()
      resolve(null)
    }
    const onKey = (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        onOk()
      }
      if (event.key === 'Escape') onCancel()
    }
    ok.addEventListener('click', onOk)
    cancel.addEventListener('click', onCancel)
    input.addEventListener('keydown', onKey)
  })
}

async function pickWorkspaceAction() {
  try {
    if (window.dsh.isDesktop) {
      await window.dsh.pickWorkspace()
    } else {
      const value = await promptText('\u9009\u62e9\u672c\u5730\u5de5\u4f5c\u533a\u8def\u5f84', state.workspacePath || '')
      if (not(value)) return
      await window.dsh.setWorkspace(value)
    }
    await refreshState()
  } catch (error) {
    addBubble('error', formatError(error && error.message ? error.message : String(error)))
  }
}

async function createWorkspaceAction() {
  try {
    if (window.dsh.isDesktop) {
      await window.dsh.createWorkspace()
    } else {
      const value = await promptText('\u65b0\u5efa\u5de5\u4f5c\u533a\u8def\u5f84', state.workspacePath || '')
      if (not(value)) return
      await window.dsh.setWorkspace(value)
    }
    await refreshState()
  } catch (error) {
    addBubble('error', formatError(error && error.message ? error.message : String(error)))
  }
}

async function openWorkspaceAction() {
  try {
    if (not(state.workspacePath)) return
    if (window.dsh.isDesktop) {
      await window.dsh.openPath(state.workspacePath)
      return
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(state.workspacePath)
      setStatus('\u5de5\u4f5c\u533a\u8def\u5f84\u5df2\u590d\u5236')
    } else {
      setStatus(state.workspacePath)
    }
  } catch (error) {
    addBubble('error', formatError(error && error.message ? error.message : String(error)))
  }
}

function renderProjectFolders() {
  const list = byId('projectFolderList')
  list.textContent = ''
  state.projectFolders.forEach((folder, index) => {
    const row = document.createElement('div')
    row.className = 'folder-item'
    const name = document.createElement('span')
    name.className = 'folder-name'
    name.textContent = workspaceLabel(folder)
    name.title = folder
    row.appendChild(name)
    if (index === 0) {
      const badge = document.createElement('span')
      badge.className = 'folder-badge'
      badge.textContent = '\u4e3b\u8981'
      row.appendChild(badge)
    }
    const remove = document.createElement('button')
    remove.className = 'folder-remove'
    remove.textContent = 'x'
    remove.addEventListener('click', () => removeProjectFolder(index))
    row.appendChild(remove)
    list.appendChild(row)
  })
}

function openProjectModal(project) {
  const editing = project && project.id ? project : null
  state.editingProjectId = editing ? editing.id : ''
  state.projectFolders = editing ? (editing.folders || []).slice() : []
  byId('projectModalTitle').textContent = editing ? '\u7f16\u8f91\u5de5\u4f5c\u533a' : '\u65b0\u5efa\u5de5\u4f5c\u533a'
  byId('projectName').value = editing ? (editing.name || '') : ''
  renderProjectFolders()
  byId('projectModal').classList.remove('hidden')
  byId('projectName').focus()
}

function closeProjectModal() {
  state.editingProjectId = ''
  state.projectFolders = []
  byId('projectModal').classList.add('hidden')
}

async function addProjectFolder() {
  if (window.dsh.isDesktop) {
    const chosen = await window.dsh.pickFolder()
    if (chosen) {
      state.projectFolders.push(chosen)
      renderProjectFolders()
    }
    return
  }
  if (typeof window.dsh.pickNativeFolder === 'function') {
    try {
      const result = await window.dsh.pickNativeFolder()
      if (result && result.canceled) return
      if (result && result.path) {
        state.projectFolders.push(result.path)
        renderProjectFolders()
        return
      }
    } catch (error) {}
  }
  await openDirBrowser(state.workspacePath || '')
}

function removeProjectFolder(index) {
  state.projectFolders.splice(index, 1)
  renderProjectFolders()
}

async function saveProjectFromModal() {
  const folders = state.projectFolders.slice()
  if (folders.length === 0) {
    await alertDialog('\u8bf7\u5148\u6dfb\u52a0\u81f3\u5c11\u4e00\u4e2a\u6587\u4ef6\u5939')
    return
  }
  const name = byId('projectName').value.trim() || workspaceLabel(folders[0])
  const editingId = state.editingProjectId
  if (editingId) {
    const projects = (state.settings.projects || []).map((item) => {
      if (item.id !== editingId) return item
      return Object.assign({}, item, { name, folders })
    })
    const patch = { projects }
    if (state.settings.currentProjectId === editingId) patch.workspacePath = folders[0]
    state.settings = await window.dsh.saveSettings(patch)
    closeProjectModal()
    await refreshState()
    setStatus('\u5de5\u4f5c\u533a\u5df2\u66f4\u65b0')
    return
  }
  const project = {
    id: 'project_' + Date.now().toString(36),
    name,
    folders
  }
  const projects = (state.settings.projects || []).concat(project)
  state.settings = await window.dsh.saveSettings({
    projects,
    currentProjectId: project.id,
    workspacePath: folders[0]
  })
  closeProjectModal()
  state.expandedProjects[project.id] = true
  state.activeProjectId = project.id
  const session = createSession(project.id)
  await refreshState()
  if (session) selectSession(session.id)
  setStatus('\u5de5\u4f5c\u533a\u5df2\u521b\u5efa')
}

async function openDirBrowser(startPath) {
  state.dirSelectCallback = (path) => {
    state.projectFolders.push(path)
    renderProjectFolders()
  }
  byId('dirBrowserModal').classList.remove('hidden')
  await loadDirBrowser(startPath)
}

async function loadDirBrowser(target) {
  try {
    const data = await window.dsh.listServerDir(target)
    state.currentDirData = data
    renderDirBrowser(data)
  } catch (error) {
    await alertDialog(formatError(error && error.message ? error.message : String(error)))
  }
}

function renderDirBrowser(data) {
  byId('dirBrowserPath').textContent = data.path || ''
  const list = byId('dirBrowserList')
  list.textContent = ''
  const dirs = Array.isArray(data.dirs) ? data.dirs : []
  for (const dir of dirs) {
    const button = document.createElement('button')
    button.className = 'dir-item'
    button.textContent = dir.name
    button.addEventListener('click', () => loadDirBrowser(dir.path))
    list.appendChild(button)
  }
}

async function selectProject(project) {
  if (not(project) || not(Array.isArray(project.folders)) || project.folders.length === 0) return
  state.settings = await window.dsh.saveSettings({
    currentProjectId: project.id,
    workspacePath: project.folders[0]
  })
  state.expandedProjects[project.id] = true
  state.activeProjectId = project.id
  const session = ensureProjectSession(project.id)
  await refreshState()
  if (session) {
    selectSession(session.id)
  } else {
    state.currentSessionId = ''
    renderMessages(null)
    renderWorkspaceList()
  }
  setStatus('\u5de5\u4f5c\u533a\u5df2\u5207\u6362')
}

function modalVisible(id) {
  const element = byId(id)
  return element && not(element.classList.contains('hidden'))
}

function handleGlobalKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return
  const active = document.activeElement
  const activeTag = active ? active.tagName : ''
  if (event.key === 'Escape') {
    if (modalVisible('approvalModal')) {
      event.preventDefault()
      approvalDenyScope()
      return
    }
    if (modalVisible('confirmModal')) {
      event.preventDefault()
      resolveConfirm(false)
      return
    }
    if (modalVisible('textPromptModal')) {
      event.preventDefault()
      byId('textPromptCancel').click()
      return
    }
    if (modalVisible('projectModal')) {
      event.preventDefault()
      closeProjectModal()
      return
    }
    if (modalVisible('dirBrowserModal')) {
      event.preventDefault()
      byId('dirBrowserModal').classList.add('hidden')
      return
    }
    if (modalVisible('settingsModal')) {
      event.preventDefault()
      byId('settingsModal').classList.add('hidden')
      return
    }
    if (modalVisible('capabilityModal')) {
      event.preventDefault()
      hideCapabilityModal()
      return
    }
    return
  }
  if (event.key !== 'Enter' || event.isComposing) return
  if (event.target === byId('input')) return
  if (activeTag === 'BUTTON' && active) {
    return
  }
  if (modalVisible('confirmModal')) {
    event.preventDefault()
    resolveConfirm(true)
    return
  }
  if (modalVisible('textPromptModal')) {
    event.preventDefault()
    byId('textPromptOk').click()
    return
  }
  if (modalVisible('projectModal')) {
    event.preventDefault()
    saveProjectFromModal()
    return
  }
  if (modalVisible('dirBrowserModal')) {
    event.preventDefault()
    byId('dirBrowserSelect').click()
    return
  }
  if (modalVisible('settingsModal')) {
    event.preventDefault()
    closeSettings()
  }
}

function setupSidebarToggle() {
  const app = byId('app')
  const button = byId('sidebarToggle')
  if (not(app) || not(button)) return
  const setCollapsed = (collapsed, persist) => {
    app.classList.toggle('sidebar-collapsed', collapsed)
    button.title = collapsed ? '\u5c55\u5f00\u4fa7\u8fb9\u680f' : '\u6298\u53e0\u4fa7\u8fb9\u680f'
    button.setAttribute('aria-label', button.title)
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    if (persist) {
      localStorage.setItem('dsh-sidebar-collapsed', collapsed ? '1' : '0')
      scheduleUiStorePush()
    }
  }
  /* 启动只应用布局。此时会话还没加载，写回会把服务端记录覆盖为空，
     并将本地时间戳顶成最新，使后续读取误认为空的本地数据更新。 */
  setCollapsed(localStorage.getItem('dsh-sidebar-collapsed') === '1')
  const toggle = () => setCollapsed(not(app.classList.contains('sidebar-collapsed')), true)
  button.addEventListener('click', toggle)
  document.addEventListener('app:toggle-sidebar', toggle)
}

function setupTitlebar() {
  const app = byId('app')
  const restore = byId('restoreChat')
  if (restore) {
    restore.addEventListener('click', () => {
      const button = byId('panelVscode')
      if (button) button.click()
      const sidebar = byId('sidebarToggle')
      if (sidebar) sidebar.focus()
    })
  }
  const sync = () => {
    const sidebar = byId('sidebarToggle')
    const panel = byId('panelToggle')
    if (app && sidebar) {
      const expanded = not(app.classList.contains('sidebar-collapsed'))
      sidebar.setAttribute('aria-label', expanded ? '折叠侧边栏' : '展开侧边栏')
      sidebar.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    }
    if (app && panel) {
      const expanded = app.classList.contains('panel-open')
      panel.setAttribute('aria-label', expanded ? '收起文件面板' : '展开文件面板')
      panel.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    }
    renderWindowTitle()
  }
  sync()
  const observer = new MutationObserver(sync)
  if (app) observer.observe(app, { attributes: true, attributeFilter: ['class'] })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const panelTitle = byId('panelTitle')
  if (panelTitle) observer.observe(panelTitle, { childList: true, characterData: true, subtree: true })
}

function setupMessageResize() {
  const left = byId('contentResizeLeft')
  const right = byId('contentResizeRight')
  const frame = byId('contentFrame')
  if (not(left) || not(right) || not(frame)) return
  const saved = Number(localStorage.getItem('dsh-message-width'))
  if (saved >= 480) {
    document.documentElement.style.setProperty('--message-width', saved + 'px')
  }
  const handleHeight = 96
  let resizingSide = ''
  const moveHandle = (handle, y, frameHeight) => {
    const top = Math.max(0, Math.min(frameHeight - handleHeight, y - handleHeight / 2))
    handle.style.top = top + 'px'
  }
  frame.addEventListener('mousemove', (event) => {
    const rect = frame.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (resizingSide) {
      const handle = resizingSide === 'left' ? left : right
      moveHandle(handle, y, rect.height)
      handle.classList.add('visible')
      if (resizingSide === 'left') right.classList.remove('visible')
      else left.classList.remove('visible')
      return
    }
    if (x <= 18) {
      moveHandle(left, y, rect.height)
      left.classList.add('visible')
    } else {
      left.classList.remove('visible')
    }
    if (rect.width - x <= 18) {
      moveHandle(right, y, rect.height)
      right.classList.add('visible')
    } else {
      right.classList.remove('visible')
    }
  })
  frame.addEventListener('mouseleave', () => {
    if (resizingSide) return
    left.classList.remove('visible')
    right.classList.remove('visible')
  })
  const startResize = (event, side, handle) => {
    event.preventDefault()
    resizingSide = side
    handle.classList.add('visible')
    const startX = event.clientX
    const startWidth = frame.getBoundingClientRect().width
    document.body.classList.add('resizing')
    const onMove = (moveEvent) => {
      const delta = side === 'right' ? moveEvent.clientX - startX : startX - moveEvent.clientX
      const maxWidth = Math.min(window.innerWidth - 40, 1400)
      const nextWidth = Math.max(480, Math.min(maxWidth, startWidth + delta))
      document.documentElement.style.setProperty('--message-width', nextWidth + 'px')
    }
    const onUp = () => {
      resizingSide = ''
      document.body.classList.remove('resizing')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const width = Math.round(frame.getBoundingClientRect().width)
      localStorage.setItem('dsh-message-width', String(width))
      scheduleUiStorePush()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  left.addEventListener('mousedown', (event) => startResize(event, 'left', left))
  right.addEventListener('mousedown', (event) => startResize(event, 'right', right))
}

/** 品牌行后面的系统徽章（用户：不同系统搞一个不同的标签，如 WIN7 / MAC / LINUX）。
 *  contextIsolation 下渲染层拿不到 process.platform，从 userAgent 认：
 *  Win7 = Windows NT 6.1；Win10/11 都是 NT 10.0 分不出来，统一显示 WIN；
 *  徽章样式 .brand-badge 早已在 style.css（灰底小圆角、uppercase）。
 *  DOM shim 里没有 navigator.userAgent 之外的直接平台位，mac/Win 由真机验。 */
function applyPlatformBadge() {
  const badge = byId('brandBadge')
  if (not(badge)) return
  const ua = String(navigator.userAgent || '')
  const nt = /Windows NT ([\d.]+)/.exec(ua)
  let label = 'Linux'
  if (nt) {
    label = nt[1].indexOf('6.1') === 0 ? 'Win7' : 'Win'
  } else if (/Mac OS X|Macintosh/.test(ua)) {
    label = 'Mac'
  }
  badge.textContent = label
  badge.title = '当前系统：' + label
}

/** 输入框的事件绑定。⚠️ 必须在 init 里、任何 await 之前就挂上：
    init 中途一旦抛异常（getState 失败、会话恢复出错……），后面的绑定全体缺席，
    输入框就「死」了 —— 自动高度 / 粘贴图片全都失灵（真机冒烟踩过）。 */
function setupComposer() {
  const input = byId('input')
  if (not(input)) return
  input.addEventListener('input', autoResizeComposer)
  /* 启动先归一化一次：不管上一次退出前高度停在哪，进来就是干净的 52px */
  autoResizeComposer()
  /* 兜底自愈：内容被任何途径改掉（撤销 / 拖字进来自动高度没跟上 / 脚本清空）
     不一定都发 input 事件 —— 用户见过「发完长消息输入框莫名其妙停在半屏高」。
     MutationObserver 只盯 childList/characterData，不盯 style，不会自己触发自己；
     只写 DOM 不发事件的路径全被它兜住。 */
  if (composerObserver) composerObserver.disconnect()
  composerObserver = new MutationObserver(autoResizeComposer)
  composerObserver.observe(input, {
    childList: true,
    characterData: true,
    subtree: true
  })
  input.addEventListener('paste', (event) => {
    const items = event.clipboardData ? event.clipboardData.items : null
    if (not(items)) return
    for (const item of items) {
      if (item.type.indexOf('image/') === 0) {
        event.preventDefault()
        const file = item.getAsFile()
        if (not(file)) continue
        const reader = new FileReader()
        reader.onload = () => addComposerAttachment(reader.result)
        reader.readAsDataURL(file)
      }
    }
  })
}

async function init() {
  if (window.applyIcons) window.applyIcons(document)
  setupMessageResize()
  setupSidebarToggle()
  setupTitlebar()
  autoResizeComposer()
  applyPlatformBadge()
  setupComposer()
  if (window.agentUI) window.agentUI.init({
    status: setStatus, setInput: setInputContent, input: () => byId('input').textContent || '',
    attach: addComposerAttachment, association: openSessionAssociation, workspace: () => byId('createWorkspace').click(), retry: reloadPage,
    logs: async () => { try { const info = await window.dsh.getState(); addBubble('notice', JSON.stringify({ runtime: info.runtime, executions: info.executions }, null, 2)) } catch (error) { addBubble('error', error.message) } }
  })
  const initial = await window.dsh.getState()
  if (window.agentUI) window.agentUI.connection(true)
  state.settings = initial.settings
  state.workspacePath = initial.workspacePath
  /* 会话存储：服务端优先（跟端口无关），拿完顺手把界面偏好校正一次。
     GET 失败会在 loadSessionStore 内部回落 localStorage，不会卡 init。 */
  await loadSessionStore()
  applyUiPrefsFromServer()
  loadSectionCollapsed()
  loadSentHistory()
  applySectionCollapse()
  const savedSessionId = readSavedCurrentSessionId()
  const savedSession = savedSessionId ? findSessionById(savedSessionId) : null
  if (savedSession) {
    state.currentSessionId = savedSession.id
    state.activeProjectId = savedSession.scope === 'recent' ? '' : savedSession.projectId
    if (savedSession.scope === 'recent' && !savedSession.knowledgeBaseId && savedSession.workspacePath) {
      state.settings = await window.dsh.saveSettings({ workspacePath: savedSession.workspacePath })
      state.workspacePath = state.settings.workspacePath || savedSession.workspacePath
    }
    if (savedSession.scope !== 'recent') state.expandedProjects[savedSession.projectId] = true
  } else {
    const initialProjectId = state.settings.currentProjectId
    if (initialProjectId) {
      state.expandedProjects[initialProjectId] = true
      const initialSession = ensureProjectSession(initialProjectId)
      state.currentSessionId = initialSession ? initialSession.id : ''
      state.activeProjectId = initialSession ? initialProjectId : ''
    }
  }
  saveCurrentSessionId(state.currentSessionId)
  renderSkills(initial.skills)
  renderPlugins(initial.plugins, initial.tools)
  renderMcp(initial.mcp)
  renderModelSelect()
  renderWorkspace()
  /* 宿主可能已经在跑几条会话（页面刚刷新过）：**先把账本铺上再画消息区** ——
     renderMessages 要靠 currentRunning() 判断「这条会话是不是正在跑」，
     顺序反了会画出一个静态过程块、紧接着又起一个空块（重复）。 */
  if (initial.executions) for (const id of Object.keys(initial.executions)) { const session = findSessionById(id); if (session) session.lastExecution = initial.executions[id] }
  applyRuns(initial.runningSessions, initial.running)
  state.runLimit = Number(initial.maxConcurrentRuns) > 0 ? Number(initial.maxConcurrentRuns) : state.runLimit
  renderMessages(currentSession())
  renderModelInfo()
  applyTheme(state.settings.theme)
  setStatus('ready')
  applyRunState()
  if (currentRunning() && currentSession()) {
    /* 过程块在 renderMessages 里已经接上了（正在跑 → 直接用已有内容起「进行中」的块）。
       这里只在它还没接上时兜底，别再 beginThinking 一次 —— 那会多出一块空的。 */
    if (not(state.currentThinking)) resumeThinking(currentSession().processHtml || '')
    scheduleWaitingHint()
    setStatus('running')
  }
  fillSettingsForm()
  renderPermission()
  window.dsh.onEvent(handleEvent)
  /* 关窗前把还没推上服务端的会话/偏好补一刀（fire-and-forget：桌面壳走 IPC 一般来得及；
     就算没赶上，localStorage 那份同 origin 还在，最多丢最后一次不到一秒的变更） */
  window.addEventListener('beforeunload', () => {
    flushUiStorePush()
    beaconUiStore()
  })
  /* 常驻对表（顺带刷新设置/工作区，并把积压队列冲出去）。
     以前这里只 sync 不冲队列 —— 错过一次 finished，队列就永远堵着。 */
  startRunPoll()

  byId('createWorkspace').addEventListener('click', (event) => {
    event.stopPropagation()
    openProjectModal()
  })
  /* 点标题或箭头都能折叠：head 整体接管点击（箭头按钮不再单独绑定，冒泡上来只翻一次） */
  byId('headProjects').addEventListener('click', () => toggleSectionCollapse('projects'))
  byId('headRecent').addEventListener('click', () => toggleSectionCollapse('recent'))
  byId('projectAddFolder').addEventListener('click', addProjectFolder)
  byId('projectCancel').addEventListener('click', closeProjectModal)
  byId('projectCreate').addEventListener('click', saveProjectFromModal)
  byId('dirBrowserUp').addEventListener('click', () => {
    const data = state.currentDirData
    if (data && data.parent) loadDirBrowser(data.parent)
  })
  byId('dirBrowserNew').addEventListener('click', async () => {
    const data = state.currentDirData
    if (not(data)) return
    const name = await promptText('\u65b0\u5efa\u6587\u4ef6\u5939\u540d\u79f0', '')
    if (not(name)) return
    try {
      await window.dsh.mkdirServerDir(data.path, name)
      await loadDirBrowser(data.path)
    } catch (error) {
      await alertDialog(formatError(error && error.message ? error.message : String(error)))
    }
  })
  byId('dirBrowserSelect').addEventListener('click', () => {
    const data = state.currentDirData
    if (data && state.dirSelectCallback) state.dirSelectCallback(data.path)
    byId('dirBrowserModal').classList.add('hidden')
  })
  byId('dirBrowserCancel').addEventListener('click', () => byId('dirBrowserModal').classList.add('hidden'))
  byId('sessionMenuRename').addEventListener('click', () => {
    const session = state.menuSession
    closeSessionMenu()
    if (session) renameSession(session)
  })
  byId('sessionMenuArchive').addEventListener('click', () => {
    archiveSession(state.menuSession)
  })
  byId('projectMenuRename').addEventListener('click', () => {
    const project = state.menuProject
    closeAllMenus()
    if (project) renameProject(project)
  })
  byId('projectMenuEdit').addEventListener('click', () => {
    const project = state.menuProject
    closeAllMenus()
    if (project) openProjectModal(project)
  })
  byId('projectMenuDelete').addEventListener('click', () => {
    const project = state.menuProject
    closeAllMenus()
    if (project) deleteProject(project)
  })
  byId('confirmCancel').addEventListener('click', () => resolveConfirm(false))
  byId('confirmOk').addEventListener('click', () => resolveConfirm(true))
  byId('approvalDeny').addEventListener('click', approvalDenyScope)
  byId('approvalOnce').addEventListener('click', () => resolveApproval(true, 'once'))
  byId('approvalSession').addEventListener('click', () => resolveApproval(true, 'session'))
  byId('approvalAlways').addEventListener('click', () => resolveApproval(true, 'always'))
  byId('clearApprovalAllow').addEventListener('click', clearApprovalAllow)
  document.addEventListener('click', () => closeAllMenus())
  byId('capabilityOk').addEventListener('click', hideCapabilityModal)
  byId('capabilitySettings').addEventListener('click', () => {
    hideCapabilityModal()
    openCapabilities('plugins')
  })
  /* 消息里的链接：拦截默认跳转，交给默认浏览器（Electron 壳内跳转会弹安全策略） */
  document.addEventListener('click', (event) => {
    const node = event.target
    const anchor = node && typeof node.closest === 'function' ? node.closest('a[href]') : null
    if (not(anchor)) return
    const href = anchor.getAttribute('href') || ''
    if (not(openExternalLink(href))) return
    event.preventDefault()
  })
  const newSessionAction = () => { const session=createSession('','新会话','recent');selectSession(session.id);setStatus('新会话') }
  byId('newSession').addEventListener('click', newSessionAction)
  if(byId('newSessionAssociation'))byId('newSessionAssociation').addEventListener('click',()=>openSessionAssociation())
  if (window.desktopWindow && window.desktopWindow.onCommand) {
    const unsubscribe = window.desktopWindow.onCommand((id) => {
      if (id === 'new-session') newSessionAction()
      if (id === 'add-project') openProjectModal()
      if (id === 'settings') openSettings()
      if (id === 'sidebar') document.dispatchEvent(new Event('app:toggle-sidebar'))
      const panel = window.filePanel
      if (panel && id === 'panel') panel.toggle()
      if (panel && id === 'markdown') panel.toggleMarkdownPreview()
      if (panel && id === 'close-file') panel.closeActive().catch((error) => setStatus(error.message))
    })
    let previous = ''
    const publish = () => {
      const value = window.filePanel ? window.filePanel.menuState() : {}
      value.sidebar = !byId('app').classList.contains('sidebar-collapsed')
      const serialized = JSON.stringify(value)
      if (serialized !== previous && window.desktopWindow.menuState) {
        previous = serialized
        window.desktopWindow.menuState(value)
      }
    }
    const observer = new MutationObserver(publish)
    observer.observe(document.getElementById('app'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    publish()
    window.addEventListener('beforeunload', () => { unsubscribe(); observer.disconnect() }, { once: true })
  }

  if (byId('railNewSession')) byId('railNewSession').addEventListener('click', () => byId('newSession').click())
  if (byId('railCreateWorkspace')) byId('railCreateWorkspace').addEventListener('click', () => byId('createWorkspace').click())
  setupComposerModelDropdown()
  byId('composerMore').addEventListener('click', () => window.agentUI ? window.agentUI.menu() : openSettings())
  setupPermissionDropdowns()
  setupReplyLanguageDropdown()
  byId('addModel').addEventListener('click', addModel)
  byId('themeToggle').addEventListener('click', async () => {
    const nextTheme = state.settings.theme === 'light' ? 'dark' : 'light'
    state.settings = await window.dsh.saveSettings({ theme: nextTheme })
    applyTheme(nextTheme)
    setStatus('theme changed')
  })
  byId('send').addEventListener('click', sendMessage)
  /* 顶栏那两枚页面操作：刷新整页 / 转发（复制链接 + 用系统默认浏览器打开） */
  byId('pageRefresh').addEventListener('click', reloadPage)
  byId('pageShare').addEventListener('click', sharePageLink)
  /* 停止只停**当前这条会话**：别的并行会话不该被一起掀掉 */
  byId('stop').addEventListener('click', async () => {
    const sessionId = state.currentSessionId
    try {
      await window.dsh.stop(sessionId)
    } catch (error) {
      addBubble('error', error && error.message ? error.message : String(error))
      return
    }
    if (state.currentSessionId === sessionId) endThinking('已停止')
    removeRun(sessionId)
    applyRunState()
    setStatus('stopped by user')
    setTimeout(async () => {
      try {
        const next = await window.dsh.getState()
        const stillRunning = Array.isArray(next && next.runningSessions)
          ? next.runningSessions.indexOf(sessionId) !== -1
          : next && next.running === true
        if (stillRunning && typeof window.dsh.resetChat === 'function') {
          await window.dsh.resetChat(sessionId)
        }
      } catch (error) {}
      await syncRunningState()
      flushPendingMessage()
    }, 1500)
  })
  const approvalCard = byId('approvalModal')
  const composer = document.querySelector('.composer')
  if (approvalCard && composer && composer.parentNode) composer.parentNode.insertBefore(approvalCard, composer)
  if (byId('sessionMenuDelete')) byId('sessionMenuDelete').addEventListener('click', () => { const session = state.menuSession; closeAllMenus(); deleteSession(session) })
  if (byId('sessionMenuPin')) byId('sessionMenuPin').addEventListener('click', () => {
    const session = state.menuSession; if (session) { session.pinned = !session.pinned; saveSessionStore(); renderWorkspaceList() }; closeAllMenus()
  })
  setupTitleAlignment()
  setupCapabilityCenter()
  byId('openSettings').addEventListener('click', openSettings)
  byId('closeSettings').addEventListener('click', closeSettings)
  const settingsAutoSaveIds = ['maxIterations', 'maxConcurrentRuns', 'maxTokens', 'contextWindowTokens', 'keepRecentMessages', 'requestTimeoutSeconds', 'contextAutoCompress']
  for (const id of settingsAutoSaveIds) {
    const element = byId(id)
    if (not(element)) continue
    element.addEventListener('change', scheduleSettingsSave)
    if (element.type === 'text' || element.type === 'password' || element.type === 'number') element.addEventListener('input', scheduleSettingsSave)
  }
  const settingsTabs = document.querySelectorAll('[data-settings-tab]')
  for (const tab of settingsTabs) {
    tab.addEventListener('click', () => showSettingsTab(tab.getAttribute('data-settings-tab')))
  }
  byId('settingsModal').addEventListener('click', (event) => {
    if (event.target === byId('settingsModal')) closeSettings()
  })
  byId('input').addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      /* 空输入按上 = 翻历史；翻历史中上下都可；有草稿时先存草稿，翻回底部恢复 */
      const navigating = sentHistoryIndex !== -1
      if ((event.key === 'ArrowUp' && byId('input').textContent.trim() === '') || navigating) {
        if (not(event.shiftKey) && not(event.ctrlKey) && not(event.altKey) && not(event.metaKey)) {
          event.preventDefault()
          navigateSentHistory(event.key === 'ArrowUp' ? 'up' : 'down')
        }
      }
      return
    }
    if (event.key === 'Enter' && not(event.shiftKey)) {
      event.preventDefault()
      sendMessage()
      return
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      document.execCommand('insertLineBreak')
      autoResizeComposer()
    }
  })
  /* 输入框的 input / paste / MutationObserver 绑定已提前到 setupComposer()
     （init 开头、任何 await 之前）—— 这里不再重复挂，见 setupComposer 的注释。 */
}

window.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  init().catch((error) => { if (window.agentUI) window.agentUI.connection(false, error.message); addBubble('error', formatError(error.message)) })
})

window.addEventListener('beforeunload', () => {
  beaconUiStore()
  if (composerObserver) composerObserver.disconnect()
  composerObserver = null
  stopRunStatus()
  if (state.runPoll) clearInterval(state.runPoll)
  if (state.queueTimer) clearTimeout(state.queueTimer)
  if (state.waitingTimer) clearTimeout(state.waitingTimer)
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  if (uiStorePush.retryTimer) clearTimeout(uiStorePush.retryTimer)
  state.runPoll = null
  state.queueTimer = null
  state.waitingTimer = null
  settingsSaveTimer = null
  uiStorePush.retryTimer = null
})


let systemSkillList = []
let skillSavePending = false
function renderSkills(items) {
  if (Array.isArray(items)) systemSkillList = items
  const list = byId('skillLibraryList')
  if (!list) return
  const query = (byId('skillSearch').value || '').trim().toLowerCase()
  list.textContent = ''
  for (const item of systemSkillList.filter((item) => !item.packageId).filter((item) => (item.name + ' ' + item.id + ' ' + item.description).toLowerCase().includes(query))) {
    const row = document.createElement('div')
    row.className = 'capability-row'
    const icon = document.createElement('span')
    icon.className = 'capability-skill-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = window.renderIcon('customize')
    const info = document.createElement('div')
    const title = document.createElement('strong'); title.textContent = item.name
    const desc = document.createElement('p'); desc.textContent = item.description || item.id; desc.className = 'muted'; desc.title = desc.textContent
    info.append(title, desc)
    const scope = document.createElement('span'); scope.textContent = '全局'; scope.className = 'capability-scope'
    const toggle = document.createElement('button')
    const enabled = !(state.settings.disabledSkills || []).includes(item.id)
    toggle.className = 'plugin-switch' + (enabled ? ' on' : '')
    toggle.disabled = skillSavePending
    toggle.dataset.skillId = item.id
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(enabled)); toggle.setAttribute('aria-label', item.name)
    const knob = document.createElement('span'); knob.className = 'plugin-switch-knob'; toggle.appendChild(knob)
    toggle.addEventListener('click', async () => {
      if (skillSavePending) return
      skillSavePending = true
      list.querySelectorAll('button').forEach((button) => { button.disabled = true })
      try {
        const disabled = new Set(state.settings.disabledSkills || [])
        if (enabled) disabled.add(item.id); else disabled.delete(item.id)
        state.settings = await window.dsh.saveSettings({ disabledSkills: Array.from(disabled) })
        byId('capabilityNotice').textContent = (enabled ? '已关闭：' : '已启用：') + item.name
      } catch (error) { byId('capabilityNotice').textContent = formatError(error.message) }
      finally {
        skillSavePending = false
        renderSkills()
        const target = Array.from(list.querySelectorAll('[data-skill-id]')).find((button) => button.dataset.skillId === item.id)
        if (target) target.focus()
      }
    })
    row.append(icon, info, scope, toggle); list.appendChild(row)
  }
  if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '没有匹配的技能'; list.appendChild(empty) }
  byId('capTabSkills').textContent = '技能 ' + (systemSkillList.filter(item => !item.packageId).length + (window.extensionUI ? window.extensionUI.packageCount('skill') : 0))
  updateShortcutMeta()
}

/* ---------------- MCP 连接器（能力中心） ----------------
   MCP 服务配置是全局设置；保存后宿主会重连服务并重新注册工具。
   UI 只负责编辑/测试，不直接 spawn 进程或发 JSON-RPC。 */
let mcpServerState = { servers: [], connected: 0, tools: 0 }
let mcpEditingConfig = null
let mcpTransport = 'stdio'
let mcpSavePending = false
let mcpPriorFocus = null
const mcpExpandedTools = new Set()

function mcpConfigList() {
  const list = state.settings && Array.isArray(state.settings.mcpServers) ? state.settings.mcpServers : []
  return list.map((item) => Object.assign({}, item))
}

function renderMcp(data) {
  if (data && typeof data === 'object') mcpServerState = data
  const list = byId('mcpList')
  if (not(list)) return
  list.textContent = ''
  const tab = byId('capTabConnectors')
  if (tab) tab.textContent = '连接器 ' + (mcpServerState.available || mcpServerState.connected || 0)
  if (mcpServerState.error) {
    const error = document.createElement('p')
    error.className = 'mcp-error'
    error.textContent = formatError(mcpServerState.error)
    list.appendChild(error)
  }
  if (not(mcpServerState.servers) || mcpServerState.servers.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'capability-empty'
    empty.textContent = '还没有 MCP 服务。添加本地 stdio 或内网 HTTP 服务后，工具会自动出现在模型工具列表里。'
    list.appendChild(empty)
    return
  }
  for (const server of mcpServerState.servers) {
    if (server.packageId) continue
    const card = document.createElement('div')
    card.className = 'mcp-server' + ((server.status === 'connected' || server.status === 'available') ? '' : ' mcp-server-off')
    const head = document.createElement('div')
    head.className = 'mcp-server-head'
    const dot = document.createElement('span')
    dot.className = 'mcp-dot ' + ((server.status === 'connected' || server.status === 'available') ? 'on' : server.status === 'error' ? 'error' : 'off')
    dot.setAttribute('aria-hidden', 'true')
    const info = document.createElement('div')
    info.className = 'mcp-server-info'
    const title = document.createElement('strong')
    title.textContent = server.name || server.id
    const meta = document.createElement('span')
    meta.className = 'mcp-server-meta'
    meta.textContent = (server.builtin ? '内置' : server.transport === 'http' ? 'HTTP' : 'stdio') + ' · ' + ((server.status === 'connected' || server.status === 'available') ? (server.builtin ? '离线可用' : '已连接') : server.status === 'error' ? '连接失败' : server.status === 'disabled' ? '已停用' : '未连接') + ' · ' + server.tools.length + ' 个工具'
    info.append(title, meta)
    const spacer = document.createElement('span')
    spacer.className = 'mcp-spacer'
    const edit = document.createElement('button')
    edit.type = 'button'; edit.className = 'mcp-icon-button'; edit.textContent = '编辑'
    edit.addEventListener('click', () => openMcpEditor(server))
    const remove = document.createElement('button')
    remove.type = 'button'; remove.className = 'mcp-icon-button danger'; remove.textContent = '删除'
    remove.addEventListener('click', async () => {
      if (not(await confirmDialog('确定删除 MCP 服务「' + (server.name || server.id) + '」吗？'))) return
      const next = mcpConfigList().filter((item) => item.id !== server.id)
      await saveMcpConfigs(next, '已删除 MCP 服务：' + (server.name || server.id))
    })
    const toggle = document.createElement('button')
    const enabled = server.enabled !== false
    toggle.className = 'plugin-switch' + (enabled ? ' on' : '')
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-checked', String(enabled))
    toggle.setAttribute('aria-label', '启用 MCP 服务 ' + (server.name || server.id))
    const knob = document.createElement('span'); knob.className = 'plugin-switch-knob'; toggle.appendChild(knob)
    toggle.addEventListener('click', async () => {
      toggle.disabled = true
      try {
        if (server.builtin) {
          const disabled = new Set(state.settings.disabledBuiltinMcp || [])
          if (enabled) disabled.add(server.id); else disabled.delete(server.id)
          state.settings = await window.dsh.saveSettings({ disabledBuiltinMcp: Array.from(disabled) })
          await refreshMcp()
          return
        }
        const next = mcpConfigList().map((item) => item.id === server.id ? Object.assign({}, item, { enabled: not(enabled) }) : item)
        await saveMcpConfigs(next, (enabled ? '已停用：' : '已启用：') + (server.name || server.id))
      } finally { toggle.disabled = false }
    })
    head.append(dot, info, spacer)
    if (!server.builtin) head.append(edit, remove)
    head.appendChild(toggle)
    card.appendChild(head)
    if (server.error) {
      const error = document.createElement('p'); error.className = 'mcp-error'; error.textContent = formatError(server.error); card.appendChild(error)
    }
    if (server.tools.length > 0) {
      const details = document.createElement('details'); details.className = 'mcp-tool-details'
      details.open = mcpExpandedTools.has(server.id)
      details.addEventListener('toggle', () => { if (details.open) mcpExpandedTools.add(server.id); else mcpExpandedTools.delete(server.id) })
      const summary = document.createElement('summary'); summary.textContent = '查看 ' + server.tools.length + ' 个工具'
      details.appendChild(summary)
      const chips = document.createElement('div'); chips.className = 'mcp-tool-chips'
      for (const tool of server.tools.slice(0, 40)) {
        const chip = document.createElement('span'); chip.className = 'plugin-tool-chip'
        const titles = { docx_read: '读取 Word', docx_create: '新建 Word', docx_edit: '编辑 Word', xlsx_read: '读取 Excel', xlsx_create: '新建 Excel', xlsx_edit: '编辑 Excel' }
        chip.textContent = (server.builtin && titles[tool.name] ? titles[tool.name] + ' · ' : '') + tool.name
        chip.title = (tool.exposedName || tool.name) + (tool.description ? '\n' + tool.description : '')
        chips.appendChild(chip)
      }
      details.appendChild(chips); card.appendChild(details)
    }
    list.appendChild(card)
  }
}

// Repeatable rows keep argv values literal; no whitespace splitting or shell parsing.
const MCP_ROW_TYPES = { mcpArgs: false, mcpEnv: true, mcpEnvPass: false, mcpHeaders: true, mcpHeaderEnv: true }
function addMcpRow(id, values, focus) {
  const box = byId(id), row = document.createElement('div'); row.className = 'mcp-config-row'
  const pair = MCP_ROW_TYPES[id], labels = pair ? ['键', id === 'mcpHeaderEnv' ? '环境变量名' : '值'] : [id === 'mcpEnvPass' ? '环境变量名' : '参数']
  for (let index = 0; index < labels.length; index++) {
    const input = document.createElement('input'); input.value = (values && values[index]) || ''; input.placeholder = labels[index]
    input.setAttribute('aria-label', box.getAttribute('aria-label') + ' ' + labels[index]); input.maxLength = 8192
    row.appendChild(input)
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mcp-remove-row'; remove.textContent = '×'; remove.setAttribute('aria-label', '删除此行')
  remove.addEventListener('click', () => { const next = row.nextElementSibling || row.previousElementSibling; row.remove(); if (next) next.querySelector('input').focus(); else document.querySelector('[data-mcp-add="' + id + '"]').focus() })
  row.appendChild(remove); box.appendChild(row); if (focus) row.querySelector('input').focus()
}
function fillMcpRows(id, value) {
  byId(id).textContent = ''
  const rows = MCP_ROW_TYPES[id] ? Object.entries(value || {}) : (value || []).map(v => [v])
  for (const values of rows.length ? rows : [[]]) addMcpRow(id, values)
}
function readMcpRows(id) {
  const rows = Array.from(byId(id).children).map(row => Array.from(row.querySelectorAll('input')).map(input => input.value))
  if (!MCP_ROW_TYPES[id]) return rows.map(row => row[0]).filter(value => value !== '')
  const out = {}, seen = new Set()
  for (const [rawKey, value] of rows) {
    const key = rawKey.trim(); if (!key && !value) continue
    if (!key) throw new Error('请填写' + byId(id).getAttribute('aria-label') + '的键')
    const comparable = id === 'mcpHeaders' || id === 'mcpHeaderEnv' ? key.toLowerCase() : key
    if (seen.has(comparable) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('配置键重复或无效：' + key)
    seen.add(comparable); out[key] = value
  }
  return out
}

function setMcpTransport(value) {
  mcpTransport = value === 'http' ? 'http' : 'stdio'
  for (const button of document.querySelectorAll('[data-mcp-transport]')) {
    const active = button.getAttribute('data-mcp-transport') === mcpTransport
    button.setAttribute('aria-checked', String(active))
    button.classList.toggle('is-on', active)
    button.tabIndex = active ? 0 : -1
  }
  byId('mcpStdioFields').classList.toggle('hidden', mcpTransport !== 'stdio')
  byId('mcpHttpFields').classList.toggle('hidden', mcpTransport !== 'http')
  for (const [id, active] of [['mcpStdioFields', mcpTransport === 'stdio'], ['mcpHttpFields', mcpTransport === 'http']]) {
    byId(id).hidden = !active
    for (const input of byId(id).querySelectorAll('input,textarea')) input.disabled = !active
  }
}

function openMcpEditor(server) {
  mcpPriorFocus = document.activeElement
  mcpEditingConfig = server && server.config ? Object.assign({}, server.config) : null
  const config = mcpEditingConfig || { transport: 'stdio', permission: 'write', enabled: true }
  byId('mcpId').value = config.id || ''
  byId('mcpName').value = config.name || ''
  byId('mcpCommand').value = config.command || ''
  fillMcpRows('mcpArgs', config.args)
  fillMcpRows('mcpEnv', config.env)
  fillMcpRows('mcpEnvPass', config.envPass)
  byId('mcpCwd').value = config.cwd || ''
  byId('mcpUrl').value = config.url || ''
  fillMcpRows('mcpHeaders', config.headers)
  fillMcpRows('mcpHeaderEnv', config.headerEnv)
  byId('mcpBearerEnv').value = config.bearerTokenEnv || ''
  for (const details of byId('mcpForm').querySelectorAll('.mcp-optional')) details.open = false
  byId('mcpPermission').value = config.permission || 'write'
  if (window.agentSelect) window.agentSelect.refresh(byId('mcpPermission'))
  byId('mcpEnabled').checked = config.enabled !== false
  byId('mcpTestResult').textContent = ''
  byId('mcpEditorTitle').textContent = server ? '编辑 MCP 服务' : '添加 MCP 服务'
  setMcpTransport(config.transport || 'stdio')
  byId('mcpDialog').classList.remove('hidden')
  byId('app').inert = true
  byId('mcpName').focus()
}

function closeMcpEditor() {
  if (mcpSavePending) return
  if (window.agentSelect) window.agentSelect.close(false)
  byId('app').inert = false
  byId('mcpDialog').classList.add('hidden')
  mcpEditingConfig = null
  if (mcpPriorFocus && mcpPriorFocus.isConnected) mcpPriorFocus.focus()
}

function readMcpForm() {
  const base = mcpEditingConfig || {}
  const config = Object.assign({}, base, {
    id: byId('mcpId').value || base.id || '',
    name: byId('mcpName').value.trim(),
    transport: mcpTransport,
    permission: byId('mcpPermission').value,
    enabled: byId('mcpEnabled').checked
  })
  if (config.name === '') throw new Error('请填写 MCP 服务名称')
  if (mcpTransport === 'stdio') {
    config.command = byId('mcpCommand').value.trim()
    config.args = readMcpRows('mcpArgs')
    config.env = readMcpRows('mcpEnv')
    config.envPass = readMcpRows('mcpEnvPass').map(name => name.trim())
    config.cwd = byId('mcpCwd').value.trim()
    if (config.command === '') throw new Error('请填写 MCP 启动命令')
  } else {
    config.url = byId('mcpUrl').value.trim()
    if (config.url === '') throw new Error('请填写 MCP endpoint')
    config.headers = readMcpRows('mcpHeaders')
    config.headerEnv = readMcpRows('mcpHeaderEnv')
    config.bearerTokenEnv = byId('mcpBearerEnv').value.trim()
  }
  return config
}

let mcpRefreshPending = false
async function refreshMcp() {
  if (mcpRefreshPending || not(window.dsh) || typeof window.dsh.mcpRequest !== 'function') return
  mcpRefreshPending = true
  try {
    const data = await window.dsh.mcpRequest('list')
    renderMcp(data)
  } catch (error) {
    byId('mcpNotice').textContent = formatError(error && error.message ? error.message : String(error))
  } finally { mcpRefreshPending = false }
}

async function saveMcpConfigs(list, message) {
  mcpSavePending = true
  byId('mcpNotice').textContent = '正在保存并重新连接…'
  try {
    state.settings = await window.dsh.saveSettings({ mcpServers: list })
    await refreshMcp()
    byId('mcpNotice').textContent = message || 'MCP 配置已保存'
  } finally { mcpSavePending = false }
}

async function testMcpForm() {
  if (mcpSavePending) return
  const output = byId('mcpTestResult')
  let config
  try { config = readMcpForm() } catch (error) { output.textContent = formatError(error.message); return }
  output.textContent = '正在连接并读取工具列表…'
  try {
    const result = await window.dsh.mcpRequest('test', config)
    const tools = Array.isArray(result.tools) ? result.tools : []
    output.textContent = '连接成功，发现 ' + tools.length + ' 个工具' + (tools.length ? '：' + tools.slice(0, 6).map((tool) => tool.name).join(' / ') : '')
  } catch (error) {
    output.textContent = formatError(error && error.message ? error.message : String(error))
  }
}

function setupMcp() {
  if (not(byId('mcpAdd'))) return
  const statusTimer = setInterval(() => {
    if (!document.hidden && !byId('capabilityCenter').classList.contains('hidden') && !byId('capConnectors').classList.contains('hidden')) refreshMcp()
  }, 5000)
  window.addEventListener('beforeunload', () => clearInterval(statusTimer), { once: true })
  document.body.appendChild(byId('mcpDialog'))
  for (const button of document.querySelectorAll('[data-mcp-add]')) button.addEventListener('click', () => addMcpRow(button.dataset.mcpAdd, [], true))
  byId('mcpAdd').addEventListener('click', () => openMcpEditor(null))
  byId('mcpCloseEditor').addEventListener('click', closeMcpEditor)
  byId('mcpCancel').addEventListener('click', closeMcpEditor)
  byId('mcpTest').addEventListener('click', () => testMcpForm())
  for (const button of document.querySelectorAll('[data-mcp-transport]')) {
    button.addEventListener('click', () => setMcpTransport(button.getAttribute('data-mcp-transport')))
    button.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        setMcpTransport(event.key === 'Home' ? 'stdio' : event.key === 'End' ? 'http' : mcpTransport === 'stdio' ? 'http' : 'stdio')
        document.querySelector('[data-mcp-transport="' + mcpTransport + '"]').focus()
      }
    })
  }
  byId('mcpForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (mcpSavePending) return
    let config
    try { config = readMcpForm() } catch (error) { byId('mcpTestResult').textContent = formatError(error.message); return }
    const list = mcpConfigList()
    const existing = list.findIndex((item) => item.id === config.id)
    if (config.id && existing >= 0) list[existing] = config
    else list.push(config)
    try {
      await saveMcpConfigs(list, '已保存 MCP 服务：' + config.name)
      closeMcpEditor()
    } catch (error) { byId('mcpTestResult').textContent = formatError(error && error.message ? error.message : String(error)) }
  })
  byId('mcpDialog').addEventListener('click', event => { if (event.target === byId('mcpDialog')) closeMcpEditor() })
  byId('mcpDialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMcpEditor() }
    if (event.key === 'Tab') {
      const controls = Array.from(byId('mcpDialog').querySelectorAll('button,input,select,textarea,summary')).filter(n => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null)
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  })
  refreshMcp()
}

function openCapabilities(section) {
  if(window.workflowUI)window.workflowUI.hide()
  const center = byId('capabilityCenter')
  center.classList.remove('hidden')
  byId('contentFrame').classList.add('hidden')
  byId('app').classList.add('capabilities-open')
  byId('openCustomize').setAttribute('aria-current', 'page')
  if (section) {
    for (const tab of center.querySelectorAll('[data-cap-tab]')) {
      const active = tab.dataset.capTab === section
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1
      byId(tab.getAttribute('aria-controls')).classList.toggle('hidden', !active)
    }
  }
  const selected = center.querySelector('[role="tab"][aria-selected="true"]')
  if (selected) selected.focus()
}
// Restore task tool rows from durable conversation facts when no browser observed the run.
// No per-step timestamps exist in these messages: never manufacture elapsed times.
function scheduledProcessEntries(messages) {
  const entries = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue
    const content = document.createElement('div')
    content.className = 'thinking-content'
    for (const call of message.tool_calls) {
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}') } catch (_) {}
      appendProcessTool(content, call.function.name, args)
      const step = activeTimelineStep(content)
      if (step) { step._startAt = 0; step.removeAttribute('data-started-at') }
      const result = messages.slice(index + 1).find(item => item.role === 'tool' && item.tool_call_id === call.id)
      if (result) appendProcessToolResult(content, call.function.name, result.content)
      else if (step) closeTimelineStep(step, 'interrupted')
    }
    const nextReply = messages.slice(index + 1).find(item => item.role === 'assistant' && typeof item.content === 'string' && item.content)
    entries.push({ html: content.innerHTML, beforeText: nextReply ? nextReply.content : '', afterMessage: index + 1 })
  }
  return entries
}

function setupCapabilityCenter() {
  if (window.scheduledTasks) window.scheduledTasks.init({ settings: () => state.settings || {}, confirm: confirmDialog, sync: (data) => {
    let changed = false
    for (const run of data.runs.slice(0,20)) {
      if (!run.sessionId) continue
      let session = findSessionById(run.sessionId)
      if (!session) { session = createSession('', run.task.name, 'recent'); session.id = run.sessionId; session.workspacePath = run.task.workspaceRoot; session.taskRunId = run.id; changed = true }
      const status = run.status === 'needs_attention' ? 'blocked' : run.status === 'pending' ? 'idle' : run.status
      if (!session.lastExecution || session.lastExecution.status !== status) { session.lastExecution = {status,startedAt:new Date(run.startedAt||run.createdAt).toISOString()}; changed = true }
    }
    if (changed) { saveSessionStore(); renderWorkspaceList() }
  }, open: async (data) => {
    let session = findSessionById(data.run.sessionId)
    if (!session) { session = createSession('', data.run.task.name, 'recent'); session.id = data.run.sessionId; session.workspacePath = data.run.task.workspaceRoot }
    session.lastExecution = data.session.execution
    if (!session.processTimeline || !session.processTimeline.length) {
      session.processTimeline = scheduledProcessEntries(data.session.messages || [])
      session.legacyMessageCount = 0
      session.legacyProcessHtml = ''
      session.processHtml = session.processTimeline.map(entry => entry.html).join(THINKING_TURN_SEP)
    }
    updateSessionMessages(session.id, data.session.messages || [], data.session.memory)
    byId('capabilityCenter').classList.add('hidden'); byId('contentFrame').classList.remove('hidden'); byId('app').classList.remove('capabilities-open'); byId('openCustomize').removeAttribute('aria-current')
    await selectSession(session.id)
  } })
  const center = byId('capabilityCenter')
  const open = (visible) => {
    if (window.knowledgeUI) window.knowledgeUI.hide()
    if (visible && window.workflowUI) window.workflowUI.hide()
    center.classList.toggle('hidden', !visible)
    byId('contentFrame').classList.toggle('hidden', visible)
    byId('app').classList.toggle('capabilities-open', visible)
    if (visible) openCapabilities(); else {
      byId('openCustomize').removeAttribute('aria-current')
      byId('openCustomize').focus()
    }
  }
  byId('openCustomize').addEventListener('click', () => open(true))
  byId('closeCapabilities').addEventListener('click', () => open(false))
  byId('skillSearch').addEventListener('input', () => renderSkills())
  setupMcp()
  const tabs = Array.from(center.querySelectorAll('[data-cap-tab]'))
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        const active = other === tab
        other.setAttribute('aria-selected', String(active)); other.tabIndex = active ? 0 : -1
        byId(other.getAttribute('aria-controls')).classList.toggle('hidden', !active)
      }
      if (tab.dataset.capTab === 'connectors') refreshMcp()
    })
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = tabs.indexOf(tab)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      tabs[next].click(); tabs[next].focus()
    })
  }
  center.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); open(false) } })
}
