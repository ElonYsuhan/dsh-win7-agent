# 建模概念与 Agent 能力映射

| 建模意图 | 当前映射 | 边界 |
| --- | --- | --- |
| 起点/终点 | `start` / `end` | 正向可达；结束节点声明真实 deliverable |
| 录入/补正 | `human`, interaction.type=`handle` | 需要结构化数据时用 inputSchema + processing.form |
| 审阅 | `human`, type=`review` | 可继续，可说明原因退回 |
| 审批 | `human`, type=`approve` | 操作人决定，不自动审批 |
| 文本转换 | `template` | 通过真实上游输入传值 |
| AI 整理/建议 | `ai` / `evaluate` | 不是条件网关，不拥有审批权 |
| 确定性工具/接口 | `tool` / `rest` | 真实名称、参数和权限；显式核查外部操作 |
| 有界 Agent | `agent` | 复用现有执行链及资源上限，不作为无限重试循环 |
| 定时发起 | 现有流程定时配置 | 不等同于每个节点的 BPMN 边界计时器 |
| 排他条件网关 | `condition` | 有序规则＋默认出口，只选一路 |
| 排他汇合 | `merge` | 仅汇合一条有效分支，保留选中路径数据 |
| 子流程/并行会签 | 当前无等价映射 | 不用多条边或说明文字冒充引擎能力 |

输出 `version: 2` 的本地流程 JSON。`interaction` 使用 `{version:1,type:"handle"|"review"|"approve",returnTo:"previous-human"|上游人工ID}`。`processing` 最多12块，form 必须有 inputSchema，附件、自由备注按业务需要添加。

以实时 `workflow_catalog` 为最终契约来源。Skill 的静态例子可能落后于后续引擎版本；发生冲突时修正设计，不修改系统契约去迁就例子。不需要安装外部 CLI、集群、脚本引擎或联网取规范。
