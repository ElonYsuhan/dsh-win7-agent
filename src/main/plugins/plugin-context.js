'use strict'

const not = (value) => value ? false : true

class PluginContext {
  constructor(host, pluginName) {
    this.host = host
    this.name = pluginName
    this.logger = {
      info: (...args) => console.log('[plugin:' + pluginName + ']', ...args),
      warn: (...args) => console.warn('[plugin:' + pluginName + ']', ...args),
      error: (...args) => console.error('[plugin:' + pluginName + ']', ...args)
    }
  }

  registerTool(tool) {
    const next = { ...tool, plugin: this.name }
    const disposer = this.host.tools.register(next)
    this.effect(disposer)
    return disposer
  }

  provide(name, service) {
    this.host.provide(name, service, this.name)
  }

  get(name) {
    return this.host.get(name)
  }

  has(name) {
    return this.host.has(name)
  }

  on(event, listener) {
    const off = this.host.events.on(event, listener)
    this.effect(off)
    return off
  }

  emit(event, payload) {
    this.host.events.emit(event, payload)
  }

  hook(event, payload) {
    return this.host.events.hook(event, payload)
  }

  addSystemPrompt(resolver) {
    this.host.addSystemPrompt(resolver, this.name)
  }

  effect(disposer) {
    if (typeof disposer === 'function') {
      this.host.effects.push(disposer)
    }
  }

  get workspaceRoot() {
    return this.host.workspaceRoot
  }

  get settings() {
    return this.host.settings
  }
}

module.exports = { PluginContext }
