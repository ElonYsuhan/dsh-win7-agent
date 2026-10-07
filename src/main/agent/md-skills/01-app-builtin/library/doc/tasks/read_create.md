# 读取与创建文档

> 适用：查看、摘要、提取原文，新建整篇在线文档，或明确用完整 Markdown 全量覆盖已有 doc。普通正文修改不走本任务。

## 1. 读取已有文档

1. 按 `../entry.md` 确认节点类型并取得 `pageId`。
2. 调用 `get_doc_reviews.py --page-id <pageId>` 获取最新 content。
3. 成功首行为 `KS_DOC_REVIEWS`；其后是原始 content。
4. 只读、摘要或提取任务到此结束，不调用任何 submit 脚本。
5. JSON error 或空 stdout → 停止，读取 `../error_handling.md`。

仅在不确定参数或 stdout 协议时读取 `../edit_core.md` §1。

## 2. 新建整篇文档

1. 执行 `../../mutation.md`，按目标空间决定是否确认。
2. 准备标题和完整 Markdown 正文。
3. 用户指定空间或父节点 → 传纯 `spaceId` / `parentId`；只给 URL 时先解析 ID，不把 URL 直接传给脚本。用户未指定位置 → 使用默认创建位置，不反问。
4. 内容较复杂时先执行 `create_doc.py --dry-run`；它不发网络请求且不需要 token。
5. 正式调用 `create_doc.py`。成功后原样透传 `KS_USER_REPLY`。
6. `failedCount` 或 `fatalCount` 大于 0 → 文档已创建但内容可能不完整，必须提示用户打开核对。

## 3. 全量覆盖已有 doc

仅当用户明确要求丢弃全部正文并重导入，或唯一确认创建超时留下空 doc 壳节点时使用：

1. 回读并确认目标为可写的 `doc`，取得实际 `spaceId`；准备完整 Markdown。
2. 告知用户将清空全部正文，且旧 block ID 与评论锚点可能失效；停止并等待明确确认。personal 与 team 均须确认。
3. 确认后复查目标和内容，再调用 `create_doc.py --node-block-id <nodeId> --space-id <spaceId> --confirm-overwrite`。
4. 回读同一节点验收。响应 ID 不同、目标不存在/跨空间/非 doc 时停止，禁止降级新建。

全文润色、统一术语、跨章节修改和批量替换仍走编辑任务。

## 4. 创建内容格式

- 正文只写 Markdown；禁止混入 `<Paragraph>`、`<Callout>`、`<Table>`、`<Mermaid>`、`<Mark>` 等 WorkBuddy 组件。
- 表格使用 Markdown/GFM 表格。
- Mermaid 使用 Markdown fenced code。
- 普通引用使用 `>`；Markdown 无法表达的组件效果不能通过混写组件规避。

仅在不确定创建参数、大小限制或成功判定时读取 `../edit_core.md` §4。
