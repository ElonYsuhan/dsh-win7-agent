# 来源与适配记录

- 官方 Skill：[Camunda camunda-bpmn](https://github.com/camunda/skills/blob/65634f22ed80e06c4053fa06fe79a0401010ea03/skills/camunda-bpmn/SKILL.md)。固定提交 `65634f22ed80e06c4053fa06fe79a0401010ea03`，上游 Apache-2.0，许可与署名在本 Skill 根目录。
- 标准依据：[OMG BPMN 2.0.2](https://www.omg.org/spec/BPMN/2.0.2/)，版本发布日期2013-12。此适配不复制完整规范，离线使用不访问该链接。
- 保留/改编：起止可达、原子任务、清晰名称、输入输出、结构校验和业务走查分开、定点修复且限制重复尝试。
- 本地扩展：人工驳回补正、明确上游目标、重提失效范围、外部操作重放、草稿同ID修改。
- 移除/替换：Camunda集群、c8ctl、Zeebe/FEEL/XML、部署与运行指令；用本Agent的workflow_catalog和草稿工具替换。
- 检索时另比较了社区BPMN生成/流程建模Skill；没有统一的“全网最标准Skill”认证。本适配选择官方维护来源及明确许可证，未以热度宣称质量排名。

上游仓库将这些 Skill 标注为技术预览；本适配固定提交并做本地契约/退回回归，不以官方来源替代业务验收。
