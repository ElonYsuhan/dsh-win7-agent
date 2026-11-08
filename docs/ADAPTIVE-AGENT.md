# 长期记忆与自适应 Agent

状态：核心链路已实现并通过隔离回归；Win7 真机、完整语义检索和自动安装扩展尚未验收。

## 已实现

- `core/memory-store` 使用随包 SQLite 3.54 + FTS5 bridge，数据库位于用户数据目录的
  `memory/memory.db`，与知识库数据库分离。支持 user/project/session 作用域、CRUD、
  版本修订、证据来源、候选确认、删除同步清理检索索引和反馈记录。
- 对话结束后由 Cordis `agent:afterRun` 异步提取明确的偏好/事实；密码、密钥、令牌、
  验证码等敏感内容不会自动保存。AI 推断的任务经验进入候选，不自动成为可信记忆。
- `run-turn` 在模型请求前按当前用户文本检索长期记忆并注入有限的参考块；记忆被明确
  标注为参考数据，不是系统指令。
- 设置 → 记忆页面支持搜索、编辑、删除、停用自动提取、查看和确认候选。
- `core/capability-registry` 从真实 `tools`、`skillLibrary`、`workflows`、`mcp` 和
  `extensions` 服务读取能力，不维护第二份业务状态；提供检索、检查和统计。
- `core/adaptive` 提供意图分析、记忆检索、能力匹配、缺口分析、只读计划和推荐；
  `adaptive_plan`、`adaptive_recommend`、`capability_search`、`memory_search` 等工具
  只读取数据，不安装、不授权、不执行。推荐卡片支持忽略并记录反馈。
- 执行结果通过 `memory_feedback` 记录；任务结果同时可生成经验候选，供用户确认。重复成功的同类任务、能力缺口和重复失败会生成不同优先级的建议，能力缺口带可查看的 Skill/MCP 草案，不自动安装。
- Workflow 保存时保留最近 100 个历史版本；服务、HTTP/IPC 和流程卡片提供历史查看及回滚，回滚生成新 revision，旧版本仍保留。

## 验证

`node scripts/adaptive-agent-smoke.js` 在真实 Cordis/AgentPool、真实 SQLite bridge 和
临时工作区下验证：FTS5 检索、作用域隔离、显式提取、候选确认、上下文注入、能力目录、
计划/推荐、反馈和删除。`npm run check` 与 `npm run check:node16` 均执行该回归。

## 边界

当前意图/能力匹配是确定性的关键词与能力目录匹配，不包含 embedding、向量数据库或
新的模型调用；不自动安装 MCP/Skill/Plugin，不自动执行计划。记忆提取是保守规则，
需要在真实使用中补充更多语言样本。P5 的 Workflow 历史/回滚已复用既有 revision 机制；自动对比优化效果和自动改写流程仍以建议形式呈现，不自动执行。旧 SQLite
数据库、完整目标包和 Win7 真机必须分别验证；构建机检查不能替代目标机验收。
