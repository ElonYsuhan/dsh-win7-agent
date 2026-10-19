'use strict'

// One system-wide Markdown library; Cordis owns the service lifetime.
const { createLibrary } = require('../../agent/md-skills')
const policy = require('../../flow/skill-policy')
module.exports = {
  name: 'core/skill-library',
  inject: ['agentConfig', 'contracts'],
  apply(ctx) {
    let packages = []
    const library = createLibrary(() => packages)
    const disabled = () => {
      const settings = ctx.agentConfig.settings
      const data = settings && typeof settings.all === 'function' ? settings.all() : {}
      return new Set(data.disabledSkills || [])
    }
    const enabled = (item) => policy.enabled(item, disabled())
    const service = {
      setPackages: items => { packages = items.slice() },
      list: () => {
        const ids = disabled()
        return library.list().map((item) => ({ id: item.id, packageId: item.packageId, name: item.name, description: item.description, enabled: policy.enabled(item, ids) }))
      },
      read: (name, file) => {
        const item = library.find(name)
        return item && !enabled(item) ? { ok: false, error: 'SKILL_DISABLED: ' + item.id } : library.read(name, file)
      },
      search: (query, limit) => {
        const result = library.search(query, library.list().length)
        const ids = disabled()
        const items = result.items.filter((item) => policy.enabled(item, ids))
        return { ok: true, total: items.length, items: items.slice(0, Math.max(1, Math.min(200, Number(limit) || 20))) }
      },
      prompt: () => library.systemPromptBlock(disabled())
    }
    ctx.contracts.assertService('skillLibrary', service)
    ctx.provide('skillLibrary', service)
  }
}
