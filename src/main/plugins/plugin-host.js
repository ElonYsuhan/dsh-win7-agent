'use strict'

const fs = require('fs')
const path = require('path')
const { ToolRegistry } = require('./tool-registry')
const { EventBus } = require('./event-bus')
const { PluginContext } = require('./plugin-context')

const not = (value) => value ? false : true

class PluginHost {
  constructor(options) {
    this.options = options || {}
    this.workspaceRoot = this.options.workspaceRoot || ''
    this.settings = this.options.settings || null
    this.tools = new ToolRegistry()
    this.events = new EventBus()
    this.effects = []
    this.services = new Map()
    this.systemPrompts = []
    this.plugins = new Map()
  }

  provide(name, service, owner) {
    if (this.services.has(name)) {
      throw new Error('PLUGIN_SERVICE_DUPLICATE: ' + name)
    }
    this.services.set(name, { service, owner: owner || 'unknown' })
  }

  get(name) {
    const entry = this.services.get(name)
    return entry ? entry.service : undefined
  }

  has(name) {
    return this.services.has(name)
  }

  addSystemPrompt(resolver, owner) {
    this.systemPrompts.push({ resolver, owner: owner || 'unknown' })
  }

  async buildSystemPrompt(base) {
    const parts = []
    if (base) parts.push(String(base))
    for (const item of this.systemPrompts) {
      try {
        const value = await item.resolver({
          workspaceRoot: this.workspaceRoot,
          settings: this.settings
        })
        if (value) parts.push(String(value))
      } catch (error) {
        console.error('[plugins] system prompt failed: ' + item.owner, error)
      }
    }
    return parts.join('\n')
  }

  use(pluginModule) {
    const plugin = pluginModule && pluginModule.default ? pluginModule.default : pluginModule
    if (not(plugin) || typeof plugin !== 'object') {
      throw new Error('PLUGIN_INVALID: plugin must export an object')
    }
    if (not(plugin.name) || typeof plugin.name !== 'string') {
      throw new Error('PLUGIN_INVALID: plugin.name is required')
    }
    if (this.plugins.has(plugin.name)) {
      throw new Error('PLUGIN_DUPLICATE: ' + plugin.name)
    }
    const context = new PluginContext(this, plugin.name)
    const apply = plugin.apply || plugin.setup
    if (typeof apply === 'function') {
      apply(context)
    }
    this.plugins.set(plugin.name, { plugin, context })
    this.events.emit('plugin:loaded', { name: plugin.name, plugin })
    return context
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

  executeTool(name, args, context) {
    return this.tools.execute(name, args, context)
  }

  getTool(name) {
    return this.tools.get(name)
  }

  listPlugins() {
    return Array.from(this.plugins.keys())
  }

  listTools() {
    return this.tools.list().map((tool) => ({ name: tool.name, plugin: tool.plugin, description: tool.description }))
  }

  dispose() {
    for (const disposer of this.effects.reverse()) {
      try {
        disposer()
      } catch (error) {
        console.error('[plugins] dispose failed', error)
      }
    }
    this.effects = []
    this.tools = new ToolRegistry()
    this.services.clear()
    this.systemPrompts = []
    this.plugins.clear()
    this.events.clear()
  }
}

module.exports = { PluginHost }
