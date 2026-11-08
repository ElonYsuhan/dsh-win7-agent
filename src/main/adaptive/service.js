'use strict'

function text(value, max) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max) }
function words(value) {
  const normalized = text(value, 4000).toLowerCase()
  const tokens = normalized.match(/[a-z0-9_]+|[㐀-鿿]/g) || []
  const han = normalized.match(/[㐀-鿿]+/g) || []
  for (const part of han) for (let i = 0; i < part.length - 1; i++) tokens.push(part.slice(i, i + 2))
  return Array.from(new Set(tokens))
}
function analyze(value) {
  const task = text(value, 8000)
  const normalized = task.toLowerCase()
  const domain = /周报|日报|报告|总结|文档/.test(task) ? 'report'
    : /代码|开发|修复|重构|测试|bug|接口|部署/.test(task) ? 'software'
    : /数据|分析|图表|统计|报表/.test(task) ? 'data'
    : /审批|流程|工作流|任务/.test(task) ? 'workflow'
    : /邮件|消息|通知|客服/.test(task) ? 'communication'
    : 'general'
  const complexity = Math.max(1, Math.min(5, Math.ceil(task.length / 120) + (/然后|并且|同时|多步|整个|全流程|and then|multiple/.test(normalized) ? 2 : 0) + (/文件|代码|数据|工作流|审批/.test(task) ? 1 : 0)))
  const intent = /修复|bug|报错|失败|不工作/.test(normalized) ? 'fix'
    : /创建|新建|生成|写|设计|实现/.test(normalized) ? 'create'
    : /分析|检查|排查|对比/.test(normalized) ? 'analyze'
    : /优化|改进|提升|加快/.test(normalized) ? 'optimize'
    : /安装|连接|配置/.test(normalized) ? 'setup'
    : 'answer'
  return { task, intent, domain, complexity, keywords: words(task).slice(0, 30) }
}
function capabilityDraft(task) {
  const value = String(task || '').toLowerCase()
  if (/邮件|email|smtp|imap/.test(value)) return { type: 'mcp', name: '邮件连接器', description: '连接用户授权的内网邮件服务，先读取服务器能力和权限，不自动发送邮件。' }
  if (/excel|表格|文档|word|ppt|演示|报告/.test(value)) return { type: 'skill', name: '办公文档处理', description: '封装文档读取、表格整理和报告生成步骤，输入输出与模板由用户确认。' }
  if (/浏览器|网页|抓取|网站/.test(value)) return { type: 'mcp', name: '浏览器连接器', description: '连接受控浏览器或内网页面读取能力，保留域名和权限白名单。' }
  return { type: 'skill', name: '任务专用技能', description: '把重复使用的步骤、输入输出和验证方法固化为可审阅的 Skill 草案。' }
}
class AdaptiveService {
  constructor(ctx) { this.ctx = ctx }
  scope(task) {
    const workspaceRoot = text(task && task.workspaceRoot, 512)
    const sessionId = text(task && task.sessionId, 128)
    return { scope: workspaceRoot ? 'project' : 'session', scopeId: workspaceRoot || sessionId, sessionId }
  }
  async memory(task, limit) {
    try { return (await this.ctx.memoryStore.search({ ...this.scope(task), query: task.task || task.text || '', limit: limit || 8 })).items } catch (_) { return [] }
  }
  analyze(task) { return analyze(task && (task.task || task.text)) }
  async plan(task) {
    const analysis = analyze(task && (task.task || task.text))
    const memories = await this.memory({ ...task, task: analysis.task })
    const matches = this.ctx.capabilities.search(analysis.task, { limit: 10 })
    const workflows = matches.filter(item => item.type === 'workflow')
    const workflow = workflows.find(item => item.score >= 9) || null
    const steps = []
    if (workflow) steps.push({ order: 1, type: 'workflow', id: workflow.id, name: workflow.name, reason: '已保存流程与目标直接匹配', status: workflow.status })
    else {
      for (const item of matches.filter(item => ['tool', 'skill', 'mcp-tool', 'mcp'].includes(item.type)).slice(0, 4)) {
        steps.push({ order: steps.length + 1, type: item.type, id: item.id, name: item.name, reason: item.description || '能力目录匹配', status: item.status })
      }
    }
    const gaps = []
    if (!workflow && !steps.length) gaps.push({ kind: 'capability', reason: '没有找到直接匹配的已授权能力', suggestion: '先确认目标，再创建 Skill、连接 MCP 或保存 Workflow' })
    if (analysis.complexity >= 3 && !workflow) gaps.push({ kind: 'workflow', reason: '多步骤任务适合固化为可复用流程', suggestion: '任务完成后可确认保存 Workflow' })
    return { analysis, memories: memories.map(item => ({ id: item.id, kind: item.kind, content: item.content, confidence: item.confidence })), capabilities: matches, steps, gaps, requiresConfirmation: gaps.length > 0 || steps.some(step => step.type === 'workflow') }
  }
  async recommend(task) {
    const plan = await this.plan(task)
    const recommendations = []
    if (plan.gaps.some(gap => gap.kind === 'workflow')) recommendations.push({ id: 'recommend:workflow', kind: 'workflow', title: '把这次执行保存为 Workflow', reason: '任务包含多个步骤，保存后下次可直接复用', action: 'draft_workflow', confidence: 0.7 })
    const feedback = await this.feedbackList(50)
    const repeated = feedback.filter(item => item.outcome === 'failed').length
    if (repeated >= 2) recommendations.push({ id: 'recommend:optimize', kind: 'optimization', title: '检查重复失败的工作步骤', reason: '最近多次任务失败，建议复核流程节点或工具权限', action: 'review_workflow', confidence: 0.5 })
    const repeatedSuccess = feedback.filter(item => item.outcome === 'completed' && analyze(item.task).domain === plan.analysis.domain).length
    if (repeatedSuccess >= 2 && !plan.steps.some(step => step.type === 'workflow')) recommendations.push({ id: 'recommend:workflow', kind: 'workflow', title: '把这套步骤保存为 Workflow', reason: '同类任务已成功执行多次，适合固化为可复用流程', action: 'draft_workflow', confidence: 0.75 })
    for (const gap of plan.gaps.filter(item => item.kind === 'capability')) {
      const draft = capabilityDraft(plan.analysis.task)
      recommendations.push({ id: 'recommend:capability:' + draft.type, kind: draft.type, title: '建议创建' + draft.name, reason: gap.reason, action: 'draft_capability', confidence: 0.6, draft })
    }
    const ignored = new Set(feedback.filter(item => item.outcome === 'ignored').map(item => item.detail).filter(Boolean))
    return { analysis: plan.analysis, recommendations: recommendations.filter(item => !ignored.has(item.id)), plan: plan.steps, gaps: plan.gaps }
  }
  async feedback(event) {
    return this.ctx.memoryStore.feedback(event)
  }
  async feedbackList(limit) {
    try { return (await this.ctx.memoryStore.feedbackList({ limit })).items } catch (_) { return [] }
  }
}
module.exports = { AdaptiveService, analyze, words }
