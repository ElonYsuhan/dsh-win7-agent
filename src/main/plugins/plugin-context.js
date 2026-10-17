'use strict'

// Compatibility facade only: lifetime, services and events belong to Cordis.
class PluginContext {
  constructor(host, name, cordis) {
    this.host = host
    this.name = name
    this.cordis = cordis
    this.logger = cordis.logger
  }

  registerTool(tool) {
    return this.cordis.effect(() => this.cordis.tools.register({ ...tool, plugin: this.name }))
  }

  provide(name, service) { this.cordis.provide(name, service); return service }
  get(name) { return this.cordis.get(name) }
  has(name) { return this.get(name) !== undefined }
  on(event, listener) { return this.host.events.listen(this.cordis, event, listener) }
  emit(event, payload) { return this.host.events.emit(event, payload) }
  hook(event, payload) { return this.host.events.hook(event, payload) }
  addSystemPrompt(resolver) {
    return this.cordis.effect(() => this.cordis.prompts.add(resolver))
  }

  // Legacy effect(disposer) keeps its old meaning. Native Cordis uses
  // ctx.effect(() => acquire-and-return-disposer).
  effect(disposer) {
    if (typeof disposer !== 'function') throw new TypeError('Plugin effect must be a disposer')
    return this.cordis.effect(() => disposer)
  }

  get workspaceRoot() { return this.host.workspaceRoot }
  get settings() { return this.host.settings }
}

module.exports = { PluginContext }
