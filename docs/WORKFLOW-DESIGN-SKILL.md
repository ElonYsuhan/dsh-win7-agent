# 内置业务流程设计规范

## 选型与来源

本次检索 skills.sh、GitHub 的 BPMN/流程建模 Skill，并对照 OMG 官方规范。选定 Camunda 官方 `camunda/skills` 的 `camunda-bpmn` 建模方法，适配为 `01-app-builtin/workflow-process-designer`。不存在可核实的“全网最标准Skill”认证；官方来源、明确许可与本地能力匹配，是本次选择依据。

- 固定上游提交：`65634f22ed80e06c4053fa06fe79a0401010ea03`。
- 原文件：https://github.com/camunda/skills/blob/65634f22ed80e06c4053fa06fe79a0401010ea03/skills/camunda-bpmn/SKILL.md
- 许可：Apache-2.0，原许可证、改编署名、来源摘要保留在 Skill 内。
- 标准：https://www.omg.org/spec/BPMN/2.0.2/ 。不分发完整标准PDF，不宣称完整BPMN兼容或认证。
- 上游为Camunda 8/Zeebe环境，仓库标注技术预览。未经改编直接内置会要求外部CLI/集群，与当前离线/Win7运行边界不符。

## 适配范围

保留起止可达、原子任务、动宾命名、输入输出、结构校验与业务验证分开、限制重复修复等方法。改为中文业务指南，补充审批与技术失败区分、明确人工退回目标、失效范围、重提、已发生外部操作的重放核查，以及同一草稿ID修订。

只输出现有 JSON 定义，不引入 Camunda、Zeebe、c8ctl、FEEL、XML运行引擎、新npm生产依赖或运行时下载。条件网关、子流程、会签/或签、按角色分派、边界计时器及补偿等未实现的语义必须标为能力缺口，不以备注或普通连线冒充支持。原实例状态、用户权限和外部操作仍由既有Cordis服务及事实仓库决定。

主指南保持短小，按场景读取 references 的退回规则、能力映射、走查清单和真实可运行审批例子。上游许可与provenance记录可离线查看；使用时不访问来源网站。

## 运行时接入

`core/workflow-tools` inject统一`skillLibrary`。调用`workflow_catalog`时返回`designGuide:{id,available,text}`，让模型实际收到指南；停用/缺失时返回不可用信息，不越过全局开关偷偷读取。普通会话仅包含技能索引和短路由提示，不全量注入引用文档。

创建草稿仍调用`workflow_create_draft`；修改仍先完整读取，再携带revision调用`workflow_update_draft`。Skill不启动实例、不审批、不替代结构校验；现有流程不自动重写。

## 离线分发

源码资源：`src/main/agent/md-skills/01-app-builtin/workflow-process-designer/`，随默认桌面包内置并默认启用。

另按现有formatVersion 1生成：

```
node scripts/pack-extension.js src/main/agent/md-skills/01-app-builtin/workflow-process-designer exports/skills/workflow-process-designer.skill.pgk
```

该包用于没有内置该技能的Agent进行离线迁移；沿用能力中心既有导入、校验、安装后停用及显式启用机制，没有新安装器。

## 验证与限制

`workflow-process-skill-smoke` 覆盖固定来源/许可摘要、标准离线包、引用可读性、真实Cordis目录注入、停用、材料驳回→补正→审批驳回→再次补正→通过→真实产物、旧待办拒绝、同ID草稿更新及实例快照不变；纳入check和内嵌Node16检查。

`workflows-e2e-smoke` 用隔离模型替身断言目录工具的Skill正文确实进入后续模型请求，并验证设计会话创建草稿。该断言证明上下文接线，不证明任意真实模型能设计所有复杂流程。未进行生产模型质量基准或Win7真机验收；Skill不会自动赋予引擎尚未实现的能力。
