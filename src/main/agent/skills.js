'use strict'

/**
 * skills.js —— agent 内部技能（skill）注册中心
 *
 * 内置 skill 放在 ./skills/ 目录，每个 skill 导出：
 *   { name, description, apply(ctx) }
 * ctx 当前提供两个挂点：
 *   ctx.onAssistantContent(fn)  —— 加工模型正文（返回 { text, recoveredCalls }）
 *   后续按需扩展：ctx.onToolResult(fn)、ctx.onBeforeRun(fn) 等。
 *
 * agent 每轮拿到正文后先过 transformContent，抢救出的调用并入工具调用队列，
 * 与真实 tool_calls 走同一条权限/禁用闸口。
 */

const not = (value) => value ? false : true

const BUILTIN_SKILLS = [
  require('./skills/capability-notice')
]

class SkillHost {
  constructor() {
    this.skills = []
    this.contentTransformers = []
  }

  loadAll() {
    for (const skill of BUILTIN_SKILLS) {
      if (not(skill) || not(skill.name) || typeof skill.apply !== 'function') continue
      skill.apply(this.contextFor(skill))
      this.skills.push({ name: skill.name, description: skill.description || '' })
    }
    return this
  }

  contextFor(skill) {
    const host = this
    return {
      name: skill.name,
      onAssistantContent(fn) {
        if (typeof fn === 'function') host.contentTransformers.push(fn)
      }
    }
  }

  /* 返回 { text: 清理后的正文, recoveredCalls: 抢救出的工具调用 } */
  transformContent(text) {
    let current = text
    const recoveredCalls = []
    for (const fn of this.contentTransformers) {
      try {
        const result = fn(current)
        if (result && typeof result === 'object') {
          current = result.text
          if (Array.isArray(result.recoveredCalls)) {
            for (const call of result.recoveredCalls) recoveredCalls.push(call)
          }
        }
      } catch (error) {
        /* skill 出错不阻断主流程，保留原文 */
      }
    }
    return { text: current, recoveredCalls: recoveredCalls }
  }

  list() {
    return this.skills.slice()
  }
}

/* 按插件停用状态分区抢救出的调用：enabled 进执行队列，missing 触发一句话提示 */
function partitionRecovered(recoveredCalls, getTool, disabledList) {
  const disabled = Array.isArray(disabledList) ? disabledList : []
  const enabled = []
  const missing = []
  for (const call of Array.isArray(recoveredCalls) ? recoveredCalls : []) {
    const tool = typeof getTool === 'function' ? getTool(call.function.name) : null
    const pluginName = tool ? tool.plugin : ''
    if (pluginName && disabled.indexOf(pluginName) !== -1) missing.push({ call: call, plugin: pluginName })
    else enabled.push(call)
  }
  return { enabled: enabled, missing: missing }
}

module.exports = { SkillHost, BUILTIN_SKILLS, partitionRecovered }
