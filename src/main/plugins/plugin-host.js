'use strict'

const fs = require('fs')
const path = require('path')
const { Context, FiberState } = require('../runtime/vendor/cordis')
const { defaultProfile } = require('../runtime/profile')
const runtimeManifest = require('../runtime/vendor/cordis/manifest.json')
const { EventBus } = require('./event-bus')
const { PluginContext } = require('./plugin-context')
const not = (value) => value ? false : true

class PluginHost {
  constructor(options) {
    this.options = options || {}
    this.workspaceRoot = this.options.workspaceRoot || ''
    this.settings = this.options.settings || null
    this.context = new Context()
    this.events = new EventBus(this.context)
    this.plugins = new Map()
    this.closed = false
    this.operations = Promise.resolve()
    const overrides = this.options.corePlugins || {}
    for (const plugin of defaultProfile(this.options)) {
      this.mount(overrides[plugin.name] || plugin, {}, true)
    }
  }

  get tools() { return this.requireService('tools') }
  get(name) { return this.context.get(name) }
  has(name) { return this.get(name) !== undefined }
  requireService(name) {
    const service = this.get(name)
    if (service === undefined) throw new Error('RUNTIME_SERVICE_UNAVAILABLE: ' + name)
    return service
  }

  mount(plugin, config, core) {
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED')
    if (!plugin || !plugin.name || typeof plugin.apply !== 'function') throw new Error('PLUGIN_INVALID')
    if (this.plugins.has(plugin.name)) throw new Error('PLUGIN_DUPLICATE: ' + plugin.name)
    const fiber = this.context.plugin(plugin, config || {})
    this.plugins.set(plugin.name, { plugin, config: config || {}, fiber, core: Boolean(core), disabled: false, tools: [] })
    return fiber
  }

  use(pluginModule) {
    const plugin = pluginModule && pluginModule.default ? pluginModule.default : pluginModule
    if (!plugin || typeof plugin.name !== 'string') throw new Error('PLUGIN_INVALID: plugin.name is required')
    const apply = plugin.apply || plugin.setup
    if (typeof apply !== 'function') throw new Error('PLUGIN_INVALID: apply is required')
    if (plugin.cordis === true) return this.mount(plugin)
    return this.mount({
      name: plugin.name,
      inject: ['tools', 'prompts'].concat(plugin.inject || []),
      apply: (ctx) => apply(new PluginContext(this, plugin.name, ctx))
    })
  }

  async ready(signal) {
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED')
    const wait = async () => {
      await this.operations
      await this.settle()
      if (this.closed) throw new Error('PLUGIN_HOST_CLOSED')
      return this
    }
    if (!signal) return wait()
    if (signal.aborted) throw new Error('ABORTED')
    let abort
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(new Error('ABORTED'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try { return await Promise.race([wait(), cancelled]) } finally { signal.removeEventListener('abort', abort) }
  }

  async settle() {
    // Service activation can wake dependents, so settle until the whole tree is idle.
    let loading
    do {
      const fibers = []
      for (const runtime of this.context.registry.values()) fibers.push(...runtime.fibers)
      await Promise.all(fibers.map((fiber) => fiber.await()))
      const current = []
      for (const runtime of this.context.registry.values()) current.push(...runtime.fibers)
      loading = current.some((fiber) => fiber.inertia || !fibers.includes(fiber))
    } while (loading)
    return this
  }

  runtimeInfo() {
    return { engine: 'cordis', version: runtimeManifest.version, plugins: this.inspectPlugins() }
  }

  inspectPlugins() {
    return Array.from(this.plugins.entries(), ([name, record]) => ({
      name, core: record.core,
      state: record.disabled ? 'disabled' : FiberState[record.fiber.state].toLowerCase(),
      missing: Object.keys(record.fiber.inject).filter((key) => !this.has(key))
    }))
  }

  unload(name) {
    return this.enqueue(async () => {
      const record = this.plugins.get(name)
      if (!record) return false
      await record.fiber.dispose()
      this.plugins.delete(name)
      await this.settle()
      return true
    })
  }

  configure() {
    return this.enqueue(async () => {
      const disabled = this.disabledPlugins()
      for (const [name, record] of this.plugins) {
        if (record.core) continue
        const next = disabled.includes(name)
        if (next === record.disabled) continue
        if (next) {
          record.tools = this.tools.list().filter((tool) => tool.plugin === name)
          await record.fiber.dispose()
          record.disabled = true
        } else {
          record.fiber = this.context.plugin(record.plugin, record.config)
          record.disabled = false
        }
      }
      await this.settle()
    })
  }

  replace(name, plugin, config) {
    return this.enqueue(async () => {
      const record = this.plugins.get(name)
      if (!plugin || plugin.name !== name) throw new Error('PLUGIN_REPLACEMENT_NAME_MISMATCH')
      if (record) { await record.fiber.dispose(); this.plugins.delete(name) }
      try {
        this.mount(plugin, config, record && record.core)
        await this.settle()
      } catch (error) {
        const failed = this.plugins.get(name)
        if (failed) { await failed.fiber.dispose(); this.plugins.delete(name) }
        if (record) { this.mount(record.plugin, record.config, record.core); await this.settle() }
        throw error
      }
    })
  }

  enqueue(action) {
    if (this.closed) return Promise.reject(new Error('PLUGIN_HOST_CLOSED'))
    const result = this.operations.then(action)
    this.operations = result.catch(() => {})
    return result
  }

  async buildSystemPrompt(base, signal, executionContext) {
    if (!executionContext) await this.ready(signal)
    const prompts = executionContext ? executionContext.prompts : this.requireService('prompts')
    return prompts.build(base, { workspaceRoot: this.workspaceRoot, settings: this.settings })
  }

  loadBuiltins() {
    const builtins = [
      require('./builtins/fs-tools'),
      require('./builtins/search-tools'),
      require('./builtins/shell-tools'),
      require('./builtins/browser-tools'),
      require('./builtins/self-validate'),
      require('./builtins/skill-tools')
    ]
    for (const plugin of builtins) {
      this.use(plugin)
    }
    return this
  }

  loadFromDirectory(directory) {
    if (not(directory) || not(fs.existsSync(directory))) return this
    const base = path.resolve(directory)
    const entries = fs.readdirSync(base, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(base, entry.name)
      try {
        if (entry.isFile() && entry.name.endsWith('.js')) {
          this.use(require(full))
          continue
        }
        if (entry.isDirectory()) {
          const manifestPath = path.join(full, 'package.json')
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            const main = manifest.main || 'index.js'
            this.use(require(path.join(full, main)))
          } else {
            const index = path.join(full, 'index.js')
            if (fs.existsSync(index)) this.use(require(index))
          }
        }
      } catch (error) {
        console.error('[plugins] failed to load ' + full + ': ' + error.message)
      }
    }
    return this
  }

  getToolDefinitions() {
    /* 热插拔：被禁用插件的工具不下发给模型（每轮请求重新取，改设置即时生效） */
    const disabled = this.disabledPlugins()
    const all = this.tools.definitions()
    if (disabled.length === 0) return all
    return all.filter((definition) => {
      const tool = this.tools.get(definition.function.name)
      return not(tool) || disabled.indexOf(tool.plugin) === -1
    })
  }

  disabledPlugins() {
    const data = this.settings && this.settings.data ? this.settings.data : this.settings
    const list = data && Array.isArray(data.disabledPlugins) ? data.disabledPlugins : []
    return list.map((item) => String(item || ''))
  }

  async executeTool(name, args, context) {
    const execution = context && context.agent && context.agent.executionContext
    if (!execution) await this.ready(context && context.signal)
    const tools = execution ? execution.tools : this.tools
    const known = this.getTool(name)
    if (known && this.disabledPlugins().includes(known.plugin)) return 'DISABLED: ' + name + ' belongs to disabled plugin ' + known.plugin
    return this.context.waterfall('tools:execute', { name, args, context }, () => tools.execute(name, args, context))
  }

  getTool(name) {
    const active = this.tools.get(name)
    if (active) return active
    for (const record of this.plugins.values()) {
      if (record.disabled) {
        const tool = record.tools.find((item) => item.name === name)
        if (tool) return tool
      }
    }
  }

  listPlugins() {
    return Array.from(this.plugins.entries()).filter((entry) => !entry[1].core).map((entry) => entry[0])
  }

  listTools() {
    const tools = this.tools.list().concat(...Array.from(this.plugins.values()).filter((record) => record.disabled).map((record) => record.tools))
    return tools.map((tool) => ({ name: tool.name, plugin: tool.plugin, description: tool.description }))
  }

  dispose() {
    if (this.shutdown) return this.shutdown
    this.closed = true
    this.shutdown = this.operations.then(() => this.context.fiber.dispose()).then(() => { this.plugins.clear() })
    return this.shutdown
  }
}

module.exports = { PluginHost }
