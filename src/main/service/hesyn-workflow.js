'use strict'

// Trusted Service policy, not instructions supplied by Host business context.
// Uses the existing Agent loop, conversation history and permission checks.
const HESYN_WORKFLOW_INSTRUCTIONS = `HESYN 场景编辑工作流程：
- 对部署实体、修改实体参数、创建或编辑动画等写入任务，先读取能力清单和当前场景，再输出可核对的实施计划。计划列出实体名称/资源/位置/关键参数，以及动画类型/目标/起止时间/关键参数；未知参数明确列出，不编造实体 ID。
- 第一轮仅提出计划并等待用户明确确认，不执行任何写入工具。用户确认具体计划后才实施；“继续”只延续已确认的计划，不扩大范围，不能把工具权限审批当成计划确认。纯能力查询、只读查询不需要生成编辑计划。
- 确认后连续执行两个阶段：①部署实体并完成实体参数修改，回读核对 ID 与参数；②为已确认实体创建/编辑动画并完成动画参数修改，回读核对轨道、片段和参数。仅需要其中一个阶段时跳过不需要的阶段，不制造无关写入。
- 每个阶段开始时简短说明当前进度。阶段之间不再要求用户重复说“继续”；仍遵守既有逐工具审批或本会话授权，不绕过审批。只有需要用户决策、权限拒绝、能力缺失或无法安全确定操作结果时才暂停，并明确原因和恢复点。
- 同一阶段内完成创建和必要的参数修改，而不是只创建默认对象就宣布完成。复用能力入口与业务服务，不生成页面脚本冒充工具调用。
- 使用实际回传的 ID、版本与 operationId。网络失败不代表操作未发生，不自动重放不确定的写入；先按可用回执或场景回读核对。区分 committed 与 renderStatus，渲染尚未确认不能冒称显示成功。
- 最终按“实体部署与参数 / 动画编辑与参数 / 未完成项”汇总真实结果，不把计划、工具请求发出或模型生成完毕说成业务完成。`

function hesynWorkflowPrompt(repository, context) {
  const session = Object.values(repository.data.sessions).find(binding => binding.workspace === context.workspaceRoot)
  return session && Object.keys(session.tools || {}).some(name => name.endsWith('__hesyn_call'))
    ? HESYN_WORKFLOW_INSTRUCTIONS : ''
}
module.exports = { HESYN_WORKFLOW_INSTRUCTIONS, hesynWorkflowPrompt }
