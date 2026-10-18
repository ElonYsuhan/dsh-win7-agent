# 知识库落地方案

日期：2026-10-18。状态：实施设计，尚未实现；不改变现有运行行为。

## 1. 产品与第一期边界

统一产品名称为「知识库」，覆盖原资料库的文件管理、解析、检索与引用；不再建设两个入口。
一个知识库包含多份资料，一份资料有多个不可变版本，每版包含可定位的内容块。
项目关联知识库，会话在有权限的集合内进一步选择本次范围。全局表示用户可关联的知识库，
不代表所有会话自动获得访问权。第一版是单用户、本地服务的数据隔离，不宣称企业多租户 ACL。

第一期闭环：新建知识库 → 导入 → 查看处理进度 → 中文搜索 → Agent 引用回答 → 查看来源
→ 更新/删除 → 重启恢复。格式：TXT、Markdown、DOCX、XLSX；不包含 PDF、OCR、向量、
远程网盘、目录持续监听或模型自动生成并入库。解析不调用模型，搜索不消耗模型 token。
容量上限由阶段 0 测试确定并写入契约；不以开发机小样本宣称大规模可用。

## 2. 当前代码事实与复用边界

| 当前模块 | 已有能力 | 本期处理 |
|---|---|---|
| src/renderer/index.html 的 openLibrary | aria-disabled 的占位入口 | 启用并改名「知识库」，沿用独立主内容页模式 |
| runtime/profile.js | Cordis profile 统一装配 | 新增知识库服务和工具插件，不加服务容器 |
| contracts / flow / state | 纯契约、策略、状态迁移 | 增加知识库契约和导入任务 reducer |
| plugins/tool-registry.js | 权限、审批、取消、工具注册/注销 | 注册只读搜索/来源工具，继续复用执行与会话事实 |
| mcp/documents/host.js | 可信 workspaceRoot、每次独立 stdio MCP | 不把知识库目录冒充用户工作区，不绕过禁用开关 |
| mcp/documents/service.js、ooxml.js | 基础 DOCX/XLSX 解析与格式限制 | 提取只读解析适配接口，共用处理器；不新增写入能力 |
| server/index.js、web-bridge.js、preload.js | HTTP/SSE 与 IPC 双入口 | 增加薄传输适配，同一个 Cordis knowledge 服务 |
| 会话 / 定时任务仓库 | 现有 JSON 快照、事实日志与恢复 | 保持不变，不在本期统一迁库 |

知识库是原生 Cordis 业务服务，不是外部 MCP 连接器。已有文档 MCP 继续按原协议提供
文档读写；知识库导入用共享只读解析器。将来需要向其他客户端开放时，另做 MCP 适配。

## 3. 数据库技术决策与准入

目标存储：SQLite 元数据/内容/索引 + 本地内容寻址文件。尚未选定执行组件或版本。

当前 docs/WIN7-COMPAT.md 要求 dependencies 为空、不加 native addon；AGENTS.md 要求
不新增生产依赖。不能默认安装 better-sqlite3/sqlite3，不能调用目标机器的 Python、
系统 sqlite3、Office 或浏览器 localStorage 代替服务端持久化；Node 16 没有内置 node:sqlite。

阶段 0 必须形成单独存储 ADR：固定 SQLite 源码版本、组件版本、编译器/参数、许可、校验和、
五平台产物、打包位置和风险。任何新增随包第三方运行组件都必须显式记录规则调整，不能通过
复制到 vendor 目录规避依赖约束。本方案不修改规则，也不下载或安装组件。

候选比较：

- 优先验证固定源码自编译的 SQLite 本地适配进程：直接文件事务、无 Node ABI addon；
  成本是新增随包二进制与五平台构建维护。必须验证 Win7 API/CRT 边界和进程清理。
- 若不接受原生组件，再验证离线 WASM 适配。普通 sql.js 是内存数据库与导入/导出，
  不能把 export 后写文件当成已具备持久事务/WAL；必须验证 VFS、提交确认、崩溃与内存，
  未达标不能作为专业资料库的默认持久层。

阶段 0 未通过，不开始真实知识库入库，不用 JSON 临时实现后宣称 SQLite 已落地。
SQLite/FTS5 功能必须查询实际随包构建验证；不根据系统 sqlite 或文档猜测。

## 4. 分层与 Cordis 服务

建议目录（均为新增，名称为拟定）：

    src/main/contracts/knowledge.js
    src/main/flow/knowledge-policy.js
    src/main/state/knowledge-job-state.js
    src/main/knowledge/repository.js
    src/main/knowledge/storage/               # 可替换 DB 适配器与迁移
    src/main/knowledge/objects.js             # 流式原件保存、哈希、垃圾回收
    src/main/knowledge/parsers/               # txt/md/docx/xlsx 只读解析
    src/main/knowledge/indexer.js
    src/main/knowledge/retrieval.js
    src/main/runtime/plugins/knowledge.js
    src/main/runtime/plugins/knowledge-tools.js
    server/knowledge-api.js
    src/renderer/knowledge.js
    scripts/knowledge-*-smoke.js

契约不导入 IO；flow 负责分块/可重试分类/检索范围等纯策略；job reducer 只依赖契约。
repository 在一个持久事务里验证修订、保存迁移事实并提交下一状态。不得额外维护内存任务
状态作为事实来源；进度事件只通知界面重新读取已提交状态。

- core/knowledge：inject agentConfig，提供 knowledge；effect 获取仓库所有权，管理
  有界后台导入队列、解析 worker、取消与释放。无需依赖 agents 或 AgentPool 来解析文件。
- core/knowledge-tools：inject knowledge/tools/prompts，注册 knowledge_search、
  knowledge_read_source；卸载调用 disposer 等待在途工具结束。
- profile 显式装配两者。服务端与 IPC 通过运行时获取 knowledge，不重复创建仓库。
- Agent 继续走现有 agentLoop、ToolRegistry、reducer 和 session repository；
  不新增聊天执行循环、审批器或事件总线。使用现有 emit/SSE 分发 knowledge:* UI 事件。

## 5. 目录与表结构

服务所在机器的 AGENT_HOME 下：

    knowledge/
      knowledge.db
      objects/<sha256前两位>/<sha256>   # 内部保存，不沿用不可信文件名作路径
      staging/<jobId>/
      backups/

原件不塞进数据库；解析内容持久保存，全文/向量索引可重建。路径不进入模型输出。
原件目录与程序目录分离。单服务持有写所有权；多进程/Worker 通过服务请求访问，不各自开写库。

| 表 | 关键字段与约束 |
|---|---|
| knowledge_bases | id, name, revision, created_at, deleted_at |
| knowledge_bindings | project_id, kb_id；复合唯一 |
| documents | id, kb_id, name, active_version_id, revision, deleted_at |
| document_versions | id, document_id, object_hash, parser_version, chunker_version, status |
| objects | hash 主键, bytes, media_type；引用根据版本表核算 |
| chunks | id, version_id, ordinal, text, locator_json；version+ordinal 唯一 |
| import_jobs | id, document_id, version_id, phase, revision, error_code, counters |
| job_events | job_id, sequence, version, type, payload；顺序唯一，和状态同事务 |
| search_index | 内容块索引，按可检索版本发布；实现取决于存储 ADR |
| schema_migrations | version 主键, checksum, applied_at |

不为同一文档的新导入覆盖旧 version。去重仅节省 object 字节，不合并不同知识库的文档身份、
权限或来源。迁移前一致性备份；禁止直接复制活跃库单个文件当备份，恢复后验证版本与完整性。

## 6. 导入、更新、取消与恢复

任务状态：queued → staging → parsing → indexing → ready；各非终态可以到
failed/cancelled/interrupted。每次迁移带版本、sequence、时间和必要事实。

1. 导入边界验证知识库、来源授权、大小和格式；流式写 staging 同时计算哈希。
2. 原件独占发布到 objects；事务创建版本/任务。文件和 DB 无跨介质事务，允许安全孤儿，
   不允许发布不存在原件的可用版本；启动扫描/延迟 GC 收敛孤儿。
3. 后台只读解析，保存结构化 locator；按章节/段落/表格边界分块。限字节、段落、单元格、
   解压体积、深度和执行时间，取消后不继续发布。复用现有 OOXML 拒绝复杂内容的能力边界。
4. 内容与索引分批写入未发布 version。全部成功后，以修订条件在同一 DB 事务中设置
   active_version_id、任务 ready 和事件。搜索只看 active ready 且未删除文档。
5. 更新失败保留旧 active version。删除事务先使文档不可检索并取消任务，旧作业发布时
   仍验证文档未删除与 revision；原件 GC 确认无版本引用后再执行，不删用户原始来源。
6. 崩溃将活动作业标记 interrupted；原件已完整保存且解析器无外部副作用时，可由队列
   幂等重建未发布索引。不能自动重复用户导出、联网写入或其他 Agent 工具副作用。

后台解析默认并发 1、队列有上限（数值经阶段 0 固化），不占用聊天 worker。
无法合作取消的解析器在隔离 worker 中终止；数据库提交由仓库统一处理。

## 7. 解析、中文检索与引用

TXT/Markdown：编码明确；不能正确解码时报错，不把乱码入库。Markdown 保存标题路径与行号。
DOCX：段落/表格索引与标题路径，不能承诺未渲染文档的真实页码。
XLSX：sheet 名称、单元格范围、原值/缓存值，注明公式未重新计算。

第一期离线关键词检索，中文召回与英文排名用固定评测集验收。
SQLite FTS5 unicode61 不等同于中文分词器。根据实际构建验证 FTS5/分词适配或应用层
中文 n-gram 索引；短查询有明确的有界策略，不退化成无限全表扫描。
分词器版本和索引版本持久保存，升级重建派生索引。检索先限定授权知识库与 active versions，
再召回/排序，不允许先全局检索再裁掉泄露片段。SQL 参数绑定，FTS 查询独立转义和限长。

搜索结果契约：citationId、kbId、documentId、versionId、chunkId、title、excerpt、locator、
score、indexVersion。引用采用稳定 source ID，不能只用文件名或变化中的文本偏移。
读取来源再次校验当前授权。旧引用保留版本身份；资料删除或撤权后返回明确不可用，
不能为了历史引用绕过访问检查。是否保留历史版本原件有独立清理策略。

不把全文自动塞进系统提示词。模型使用只读搜索工具获取受限片段，再按需读取；引用进入
现有工具结果和会话事实。界面依据实际返回的 source ID 渲染可点击引用，不把模型编造的
标记解析成有效文件路径。

## 8. 权限与远程使用

现有 ToolRegistry 的 read/write 是操作档位，不是知识库授权，两者必须同时成立。
知识库服务统一校验服务端计算的 scope；模型参数 kbIds 只能进一步缩小范围。
会话选择随现有版本化会话状态持久化，新增兼容事件/字段，旧会话默认无额外知识库权限。
定时任务如需知识库，要在任务创建时保存明确授权集合；第一期不开放无人值守导入和删除。

不为访问 AGENT_HOME 关闭工作区检查。knowledge_read_source 只接受 source ID，通过
repository/object store 解引用；禁止传入原始磁盘路径。MCP 原有 workspaceRoot 边界不变。

本地桌面可以在导入 UI 授权选择外部文件。远程浏览器选择的文件通过有界流式上传传入服务，
不能让远程服务读取浏览器机器路径。服务端本地路径导入需要单独明确授权入口，不能把普通
HTTP 的 path 字段当文件读取许可。远程部署沿用现有访问控制边界，不声称新增了多用户鉴权。

## 9. API 与界面

拟定 API：GET/POST /api/knowledge/bases；资料列表、导入、更新、删除和作业状态；
POST /api/knowledge/search；GET /api/knowledge/sources/:id；项目关联与会话范围选择。
普通 JSON 请求复用 readBody；文件上传独立流式入口、独立上限，不走 JSON/base64 大包。
IPC knowledge:request 与 HTTP 调用同一服务方法，不在适配器内做 SQL/解析。
SSE knowledge:job-changed / knowledge:document-changed 仅在提交后发出，断线重连重新拉快照。

侧边栏独立知识库页：集合卡片、资料列表与处理状态、搜索、来源预览。上传/失败重试是
明确动作；状态自动更新，不新增手工刷新按钮。卡片沿用当前能力中心尺寸与开关规范。
知识库有资料数量与可检索数量，不能把「上传成功」画成「可检索」。
导入失败显示具体阶段/原因；资料更新期间显示「旧版本仍可用」。

## 10. 实施与验收顺序

| 阶段 | 可审查产物 | 放行条件 |
|---|---|---|
| 0 存储准入 | ADR、固定组件与离线构建、兼容/性能报告 | 规则变更明确记录；Node16/Win7、中文路径、FTS能力、崩溃提交、内存/容量、五平台构建证据 |
| 1 数据闭环 | 契约/reducer、仓库、原件、知识库 CRUD、TXT/MD 导入、作业恢复 | 取消/断电模拟/磁盘满/修订冲突/迁移失败不发布半成品；关闭释放资源 |
| 2 解析与检索 | DOCX/XLSX、中文索引、搜索与引用定位 | 中文/英文/表格固定评测；文件越界拒绝；更新成功切换、失败保留旧版 |
| 3 产品闭环 | 独立页、项目关联、会话范围、Agent工具与引用预览 | 真实 renderer→HTTP/IPC→Cordis→ToolRegistry→来源链路；撤权/删除无泄露；重启不丢选择 |
| 4 增强 | 混合检索、向量适配、PDF/OCR、目录变化检测 | 分别独立选型和验收；不将联网或模型下载隐式加入第一期 |

每阶段交付当前平台同版本验收包；仅明确发版时升级版本并构建全部平台。
运行时固定 Electron 22.3.27 / Node 16.17.1 / Chromium 108；检查运行在构建机和实际
内嵌 Node；Win7 真机验证另列，不以 Mac 验收替代。最终 UI 和业务功能只能在阶段 3
闭环通过后称为「知识库第一期完成」。

## 11. 外部依据

- SQLite FTS5：https://www.sqlite.org/fts5.html
- SQLite 外键与连接配置：https://www.sqlite.org/foreignkeys.html
- sql.js 内存与导入/导出边界：https://github.com/sql-js/sql.js

以上资料用于选型边界核对，不代表已对某个具体发行版本完成 Win7 认证。
