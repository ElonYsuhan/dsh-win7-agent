'use strict'

const not = (value) => value ? false : true
const defaultPolicy = require('../agent/permission-policy')
const defaultContracts = require('../contracts')

class ToolRegistry {
  constructor(policy, contracts) {
    this.contracts = contracts || defaultContracts
    this.policy = policy || defaultPolicy
    this.tools = new Map()
  }

  register(tool) {
    this.contracts.assertTool(tool)
    if (not(tool) || typeof tool !== 'object') {
      throw new Error('PLUGIN_TOOL_INVALID: tool must be an object')
    }
    if (not(tool.name) || typeof tool.name !== 'string') {
      throw new Error('PLUGIN_TOOL_INVALID: tool.name is required')
    }
    if (typeof tool.execute !== 'function') {
      throw new Error('PLUGIN_TOOL_INVALID: tool.execute is required for ' + tool.name)
    }
    if (this.tools.has(tool.name)) {
      throw new Error('PLUGIN_TOOL_DUPLICATE: ' + tool.name)
    }
    const entry = {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      execute: tool.execute,
      permission: tool.permission || 'write',
      plugin: tool.plugin || 'unknown',
      active: true,
      pending: new Set(),
      controllers: new Set()
    }
    this.tools.set(tool.name, entry)
    return async () => {
      entry.active = false
      for (const controller of entry.controllers) controller.abort()
      if (this.tools.get(tool.name) === entry) this.tools.delete(tool.name)
      await Promise.allSettled(Array.from(entry.pending))
    }
  }

  get(name) {
    return this.tools.get(name)
  }

  list() {
    return Array.from(this.tools.values())
  }

  definitions() {
    return this.list().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
  }

  async execute(name, args, context) {
    const unattended = context && context.settings && context.settings.unattended
    if (unattended && !unattended.tools.includes(name)) return 'DENIED: unattended ' + name + ': outside task tool allowlist'
    const tool = this.get(name)
    if (not(tool) || !tool.active) {
      if (unattended) return 'DENIED: unattended ' + name + ': tool unavailable'
      throw new Error('UNKNOWN_TOOL: ' + name)
    }
    if (unattended && unattended.toolContracts && unattended.toolContracts[name] !== JSON.stringify({name:tool.name,permission:tool.permission,plugin:tool.plugin,parameters:tool.parameters})) return 'DENIED: tool definition changed during workflow execution'
    if (unattended && unattended.skillIds && name === 'load_skill' && !unattended.skillIds.includes(args && args.name)) return 'DENIED: skill is not bound to this workflow node'
    const controller = new AbortController()
    const signal = context && context.signal
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    tool.controllers.add(controller)
    const input = Object.assign({}, context, { signal: controller.signal })
    const pending = this.executeEntry(tool, name, args, input)
    tool.pending.add(pending)
    try { return await pending } finally {
      tool.pending.delete(pending)
      tool.controllers.delete(controller)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  async executeEntry(tool, name, args, context) {
    this.contracts.assertArguments(tool.parameters, args || {})
    const settings = (context && context.settings) || {}
    /* 热插拔兜底：插件被禁用后，即使模型仍拿着旧定义调用也拒绝执行 */
    const disabled = Array.isArray(settings.disabledPlugins) ? settings.disabledPlugins : []
    if (disabled.indexOf(tool.plugin) !== -1) {
      return (settings.unattended ? 'DENIED: unattended ' : 'DISABLED: ') + name + ' belongs to disabled plugin ' + tool.plugin
    }
    if (settings.unattended) {
      const reason = require('../flow/unattended-policy').blocked(tool, args || {}, settings)
      if (reason) return 'DENIED: unattended ' + name + ': ' + reason
    }
    const mode = settings.permissionMode || 'workspace'
    const permission = tool.permission || 'write'
    // 唯一的权限闸口：deny 直接拒绝，ask 先走审批，allow 才落到工具本体
    const decision = this.policy.decideToolPermission(permission, mode, args || {}, settings)
    if (decision === 'deny') {
      return 'DENIED: ' + name + ' is blocked by read-only permission'
    }
    if (decision === 'ask' && settings.unattended) return 'DENIED: unattended ' + name + ' requires human approval'
    if (decision === 'ask') {
      if (not(context) || typeof context.approve !== 'function') {
        return 'DENIED: ' + name + ' requires approval but no approver is available'
      }
      const approved = await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('ABORTED'))
        if (context.signal.aborted) return abort()
        context.signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => context.approve(this.policy.buildApprovalRequest(permission, args || {}, name))).then(resolve, reject)
          .finally(() => context.signal.removeEventListener('abort', abort))
      })
      if (not(approved)) return 'DENIED: ' + name + ' was not approved'
    }
    if (context.signal.aborted) throw new Error('ABORTED')
    if (!tool.active) return 'DISABLED: ' + name + ' was unloaded while awaiting approval'
    try { return await tool.execute(args || {}, context || {}) } catch (error) {
      if (settings.unattended && /PATH_ESCAPE|COMMAND_BLOCKED/.test(error.message)) return 'DENIED: unattended ' + name + ': ' + error.message
      throw error
    }
  }
}

module.exports = { ToolRegistry }
