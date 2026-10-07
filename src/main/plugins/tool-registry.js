'use strict'

const not = (value) => value ? false : true
const { decideToolPermission, buildApprovalRequest } = require('../agent/permission-policy')

class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  register(tool) {
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
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      execute: tool.execute,
      permission: tool.permission || 'write',
      plugin: tool.plugin || 'unknown'
    })
    return () => this.tools.delete(tool.name)
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
    const tool = this.get(name)
    if (not(tool)) throw new Error('UNKNOWN_TOOL: ' + name)
    const settings = (context && context.settings) || {}
    /* 热插拔兜底：插件被禁用后，即使模型仍拿着旧定义调用也拒绝执行 */
    const disabled = Array.isArray(settings.disabledPlugins) ? settings.disabledPlugins : []
    if (disabled.indexOf(tool.plugin) !== -1) {
      return 'DISABLED: ' + name + ' belongs to disabled plugin ' + tool.plugin
    }
    const mode = settings.permissionMode || 'workspace'
    const permission = tool.permission || 'write'
    // 唯一的权限闸口：deny 直接拒绝，ask 先走审批，allow 才落到工具本体
    const decision = decideToolPermission(permission, mode, args || {})
    if (decision === 'deny') {
      return 'DENIED: ' + name + ' is blocked by read-only permission'
    }
    if (decision === 'ask') {
      if (not(context) || typeof context.approve !== 'function') {
        return 'DENIED: ' + name + ' requires approval but no approver is available'
      }
      const approved = await context.approve(buildApprovalRequest(permission, args || {}))
      if (not(approved)) return 'DENIED: ' + name + ' was not approved'
    }
    return tool.execute(args || {}, context || {})
  }
}

module.exports = { ToolRegistry }
