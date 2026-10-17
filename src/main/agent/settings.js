'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_MODEL_ID = 'default'
const DEFAULT_MODEL_NAME = '\u9ed8\u8ba4\u6a21\u578b'

const DEFAULTS = {
  baseURL: '',
  apiKey: '',
  model: '',
  temperature: 0.2,
  maxIterations: 100,
  turnTimeoutMs: 0,
  autoApproveReads: true,
  approveWrites: true,
  approveCommands: true,
  permissionMode: 'workspace',
  requestTimeoutMs: 1800000,
  maxTokens: 32768,
  contextWindowTokens: 131072,
  contextAutoCompress: true,
  contextCompressThreshold: 0.8,
  keepRecentMessages: 50,
  summaryMaxTokens: 1024,
  workspacePath: '',
  /* 同时能跑几条会话（每条一个 worker Agent，见 agent-pool.js）。
     同一条会话重入仍然会被 SESSION_BUSY 挡下；这个上限管的是「几条会话能并行」 */
  maxConcurrentRuns: 8,
  theme: 'dark',
  brandName: 'Agent',
  brandIcon: '',
  showBrandName: true,
  showBrandIcon: true,
  showPlatformBadge: true,
  replyLanguage: 'zh',
  disabledPlugins: [],
  models: [],
  currentModelId: '',
  recentWorkspaces: [],
  limitsVersion: 2
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function normalizeModel(model, index) {
  const rawModel = model && model.model ? String(model.model) : ''
  const list = Array.isArray(model && model.modelList)
    ? model.modelList.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  if (rawModel && list.indexOf(rawModel) === -1) list.unshift(rawModel)
  const activeModel = rawModel || (list.length > 0 ? list[0] : '')
  return {
    id: model && model.id ? String(model.id) : (index === 0 ? DEFAULT_MODEL_ID : makeId('model_')),
    name: model && model.name ? String(model.name) : (DEFAULT_MODEL_NAME + ' ' + (index + 1)),
    baseURL: model && model.baseURL ? String(model.baseURL) : '',
    apiKey: model && model.apiKey !== undefined ? String(model.apiKey) : '',
    model: activeModel,
    protocol: model && model.protocol ? String(model.protocol) : 'openai-completions',
    thinking: model && model.thinking === true,
    modelList: list
  }
}

function normalize(data) {
  const source = data || {}
  const next = { ...DEFAULTS, ...source }
  const limitsVersion = Number(source.limitsVersion)
  if (not(Number.isFinite(limitsVersion)) || limitsVersion < 2) {
    if (Number(source.maxIterations) === 20 || source.maxIterations === undefined) next.maxIterations = 100
    if (Number(source.maxConcurrentRuns) === 3 || source.maxConcurrentRuns === undefined) next.maxConcurrentRuns = 8
    if (Number(source.maxTokens) === 8192 || source.maxTokens === undefined) next.maxTokens = 32768
    if (Number(source.contextWindowTokens) === 0 || source.contextWindowTokens === undefined) next.contextWindowTokens = 131072
    if (Number(source.keepRecentMessages) === 12 || source.keepRecentMessages === undefined) next.keepRecentMessages = 50
    if (Number(source.requestTimeoutMs) === 120000 || source.requestTimeoutMs === undefined) next.requestTimeoutMs = 1800000
    next.limitsVersion = 2
  }
  if (not(Array.isArray(next.models)) || next.models.length === 0) {
    next.models = [normalizeModel({
      id: next.currentModelId || DEFAULT_MODEL_ID,
      name: DEFAULT_MODEL_NAME,
      baseURL: next.baseURL,
      apiKey: next.apiKey,
      model: next.model
    }, 0)]
  } else {
    next.models = next.models.map((model, index) => normalizeModel(model, index))
  }
  const ids = new Set()
  for (const model of next.models) {
    if (ids.has(model.id)) model.id = makeId('model_')
    ids.add(model.id)
  }
  if (not(next.currentModelId) || not(next.models.some((model) => model.id === next.currentModelId))) {
    next.currentModelId = next.models[0].id
  }
  const active = next.models.find((model) => model.id === next.currentModelId) || next.models[0]
  next.baseURL = active.baseURL
  next.apiKey = active.apiKey
  next.model = active.model
  next.thinking = active.thinking === true
  const permissionModes = ['readonly', 'workspace', 'full']
  let permissionMode = String(next.permissionMode || '')
  if (permissionModes.indexOf(permissionMode) === -1) {
    permissionMode = (next.approveWrites === false && next.approveCommands === false) ? 'full' : 'workspace'
  }
  next.permissionMode = permissionMode
  next.approveWrites = permissionMode === 'readonly'
  next.approveCommands = permissionMode !== 'full'
  if (not(Array.isArray(next.recentWorkspaces))) next.recentWorkspaces = []
  /* 并发上限：1 ~ 16 之间的整数，配坏了退回默认 3（与 agent-pool 的兜底一致） */
  const concurrent = Math.floor(Number(next.maxConcurrentRuns))
  next.maxConcurrentRuns = Number.isFinite(concurrent) && concurrent >= 1
    ? Math.min(64, concurrent)
    : DEFAULTS.maxConcurrentRuns
  next.turnTimeoutMs = Math.max(0, Math.min(86400000, Math.floor(Number(next.turnTimeoutMs) || 0)))
  next.brandName = typeof next.brandName === 'string' ? next.brandName.trim().slice(0, 40) : 'Agent'
  next.brandIcon = typeof next.brandIcon === 'string' && next.brandIcon.length <= 200000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(next.brandIcon) ? next.brandIcon : ''
  for (const key of ['showBrandName', 'showBrandIcon', 'showPlatformBadge']) next[key] = next[key] !== false
  if (not(next.theme)) next.theme = 'dark'
  next.replyLanguage = next.replyLanguage === 'en' ? 'en' : 'zh'
  next.disabledPlugins = Array.isArray(next.disabledPlugins)
    ? next.disabledPlugins.map((item) => String(item || '')).filter(Boolean)
    : []
  return next
}

const not = (value) => value ? false : true

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json')
    this.data = normalize({})
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.data = normalize(JSON.parse(raw))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.error('[settings] load failed:', error.message)
      }
      this.data = normalize({})
      this.save()
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  all() {
    return clone(this.data)
  }

  update(patch) {
    const next = { ...this.data, ...(patch || {}) }
    if (Array.isArray(patch.models)) {
      next.models = patch.models.map((model, index) => normalizeModel(model, index))
    }
    if (patch.currentModelId) next.currentModelId = patch.currentModelId
    if (patch.modelName !== undefined) {
      next.models = next.models.map((model) => model.id === next.currentModelId ? { ...model, name: String(patch.modelName) } : model)
    }
    if (patch.baseURL !== undefined || patch.apiKey !== undefined || patch.model !== undefined) {
      next.models = next.models.map((model) => model.id === next.currentModelId ? {
        ...model,
        baseURL: patch.baseURL !== undefined ? patch.baseURL : model.baseURL,
        apiKey: patch.apiKey !== undefined ? patch.apiKey : model.apiKey,
        model: patch.model !== undefined ? patch.model : model.model
      } : model)
    }
    if (patch.protocol !== undefined || patch.modelList !== undefined || patch.thinking !== undefined) {
      next.models = next.models.map((model) => model.id === next.currentModelId ? {
        ...model,
        protocol: patch.protocol !== undefined ? patch.protocol : model.protocol,
        modelList: Array.isArray(patch.modelList) ? patch.modelList : model.modelList,
        thinking: patch.thinking !== undefined ? patch.thinking === true : model.thinking
      } : model)
    }
    if (patch.workspacePath) {
      const workspace = path.resolve(patch.workspacePath)
      next.workspacePath = workspace
      next.recentWorkspaces = [workspace].concat(next.recentWorkspaces || []).filter((value, index, list) => list.indexOf(value) === index).slice(0, 10)
    }
    this.data = normalize(next)
    this.save()
    return this.all()
  }
}

module.exports = { Settings, DEFAULTS, normalizeModel, makeId }
