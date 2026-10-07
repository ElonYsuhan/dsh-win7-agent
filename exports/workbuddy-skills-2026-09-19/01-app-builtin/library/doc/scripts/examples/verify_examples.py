#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_examples.py —— 批量把 scripts/examples/ 下所有 JSON 示例
过一遍 `submit_review_edit.py --dry-run` 本地校验，作为"活文档"看门人。

用途
----
规则升级（例如新加 `<Mark ar>` 边界强约束）后，跑一遍本脚本，
就能立刻发现哪些示例老化了，并验证关键回归用例——每个失败项都会给出具体错误码，方便定位。

用法
----
    python3 verify_examples.py

    # 指定要校验的示例目录（默认 = 本脚本同目录）
    python3 verify_examples.py --dir /path/to/examples

stdout 协议
-----------
    KS_EXAMPLES_SELFCHECK_OK          # 全部通过
    KS_EXAMPLES_SELFCHECK_FAILED      # 有失败
    {"failed": [{"file": "...", "error": "..."}]}

设计
----
- 无网络、无 token 依赖：脚本自带假 token（长度足够通过 token 校验），
  只利用 dry-run 走本地 schema + Mark ar 边界强约束等本地校验。
- 表格准入依赖最新 content 中的目标 block 类型，dry-run 不具备该上下文，仍需按 `doc/tasks/table_edit.md` 人工自检。
- 无 pytest / vitest 之类新依赖，纯 subprocess。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

# 本脚本位于 doc/scripts/examples/verify_examples.py
# submit_review_edit.py 在 doc/submit_review_edit.py
_HERE = Path(__file__).resolve().parent
_DOC_DIR = _HERE.parent.parent  # doc/
_SUBMIT_REVIEW = _DOC_DIR / "submit_review_edit.py"
_SUBMIT_EDIT = _DOC_DIR / "submit_doc_edit.py"
_CREATE_DOC = _DOC_DIR / "create_doc.py"

# 假 token：只要长度过 minimum 校验即可（_common.read_token_from_stdin 会拒空/过短）
_FAKE_TOKEN = "fake-token-1234567890abcdefghijklmnop"


def _looks_like_review_actions(actions: list) -> bool:
    """
    判断这个 actions 数组是审阅模式还是编辑模式：
    - 末尾有 card_op → 审阅模式
    - 否则 → 编辑模式
    """
    if not actions:
        return False
    last = actions[-1] or {}
    return last.get("type") == "card_op"


def _run_submit_dry_run(args: List[str]) -> Tuple[bool, str]:
    proc = subprocess.run(
        args,
        input=_FAKE_TOKEN + "\n",
        capture_output=True,
        text=True,
        check=False,
    )
    stdout = (proc.stdout or "").strip()
    # 判定成功：首行 KS_ 开头（KS_DOC_REVIEW_DRYRUN / KS_DOC_EDIT_DRYRUN）
    ok = stdout.startswith("KS_DOC_REVIEW_DRYRUN") or stdout.startswith("KS_DOC_EDIT_DRYRUN")
    return ok, stdout


def _run_create_doc_dry_run(content: str, extra_args: Optional[List[str]] = None) -> Tuple[bool, str]:
    args: List[str] = [
        sys.executable,
        str(_CREATE_DOC),
        "--title", "verify_create_doc",
        "--content", content,
        "--dry-run",
    ]
    if extra_args:
        args.extend(extra_args)
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        check=False,
    )
    stdout = (proc.stdout or "").strip()
    ok = stdout.startswith("KS_DOC_CREATE_DRYRUN")
    return ok, stdout


def _run_dry_run(
    submit_script: Path,
    actions_file: Path,
    is_review: bool,
) -> Tuple[bool, str]:
    """
    调对应的 submit 脚本走 dry-run，返回 (ok, stdout)。
    """
    args: List[str] = [
        sys.executable,
        str(submit_script),
        "--token-stdin",
        "--page-id", "test_page_verify",
        "--actions-file", str(actions_file),
        "--dry-run",
    ]
    if is_review:
        # 审阅模式必填 --summary
        args += ["--summary", f"verify_examples:{actions_file.name}"]
    return _run_submit_dry_run(args)


def _run_dry_run_json(
    submit_script: Path,
    actions: list,
    is_review: bool,
    name: str,
) -> Tuple[bool, str]:
    args: List[str] = [
        sys.executable,
        str(submit_script),
        "--token-stdin",
        "--page-id", "test_page_verify",
        "--actions-json", json.dumps(actions, ensure_ascii=False),
        "--dry-run",
    ]
    if is_review:
        args += ["--summary", "验证本地回归用例"]
    return _run_submit_dry_run(args)


_CREATE_DOC_REGRESSION_CASES = [
    (
        "create_doc_markdown_table_allowed",
        True,
        '"contentField":"markdown"',
        "# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |",
        [],
    ),
    (
        "create_doc_component_rejected",
        False,
        "create_doc 只支持 Markdown",
        "<Callout><Paragraph>提示</Paragraph></Callout>",
        [],
    ),
    (
        "create_doc_component_in_fence_allowed",
        True,
        '"contentField":"markdown"',
        "# 示例\n\n```xml\n<Callout><Paragraph>提示</Paragraph></Callout>\n```",
        [],
    ),
    (
        "create_doc_mixed_markdown_component_rejected",
        False,
        "create_doc 只支持 Markdown",
        "# 标题\n\n正常段落\n\n<Callout><Paragraph>提示</Paragraph></Callout>",
        [],
    ),
    (
        "create_doc_table_component_rejected",
        False,
        "create_doc 只支持 Markdown",
        "<Table><TableRow><TableCell><Paragraph>A</Paragraph></TableCell></TableRow></Table>",
        [],
    ),
    (
        "create_doc_mermaid_fence_allowed",
        True,
        '"contentField":"markdown"',
        "# 图\n\n```mermaid\ngraph TD\n  A-->B\n```",
        [],
    ),
    (
        "create_doc_review_component_rejected",
        False,
        "create_doc 只支持 Markdown",
        "<ReviewSummary>总结</ReviewSummary>",
        [],
    ),
    (
        "create_doc_invalid_space_id_rejected",
        False,
        "space_id 格式非法",
        "# 标题",
        ["--space-id", "https://docs.example.com/space/s/abc"],
    ),
]


_REGRESSION_CASES = [
    (
        "review_insert_mark_ar_rejected",
        True,
        False,
        "insert.content 包含 <Mark ar=...>",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><Mark ar=\"insert\">新增</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 insert 禁止 ar", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_without_mark_ar_rejected",
        True,
        False,
        "update.new_content 缺少 <Mark ar=",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph>新内容</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 update 必须 ar", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_plain_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增内容</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 insert 纯内容", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_missing_old_content_rejected",
        True,
        False,
        "update 缺少 old_content",
        [
            {"type": "update", "id": "blk_intro", "new_content": "<Paragraph><Mark ar=\"format\">内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 update 必须带旧内容", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_comment_drop_rejected",
        True,
        False,
        "丢失 1 个原有 comment 锚点",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>012<Mark comment={[\"disc_xxx\"]}>345</Mark></Paragraph>", "new_content": "<Paragraph>012<Mark ar=\"format\" bold>345</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证保留评论锚点", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_comment_preserved_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>012<Mark comment={[\"disc_xxx\"]}>345</Mark></Paragraph>", "new_content": "<Paragraph>012<Mark comment={[\"disc_xxx\"]} ar=\"format\" bold>345</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证保留评论锚点", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_allow_drop_comment_without_reason_rejected",
        True,
        False,
        "必须填写 drop_comment_reason",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>012<Mark comment={[\"disc_xxx\"]}>345</Mark></Paragraph>", "new_content": "<Paragraph>012<Mark ar=\"delete\">345</Mark></Paragraph>", "allow_drop_comment": True},
            {"type": "card_op", "op": "insert", "summary": "验证删除评论锚点理由", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_allow_drop_comment_with_reason_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>012<Mark comment={[\"disc_xxx\"]}>345</Mark></Paragraph>", "new_content": "<Paragraph>012<Mark ar=\"delete\">345</Mark></Paragraph>", "allow_drop_comment": True, "drop_comment_reason": "用户明确要求删除对应被评论文本"},
            {"type": "card_op", "op": "insert", "summary": "验证删除评论锚点理由", "kind": "agent_review"},
        ],
    ),
    (
        "mermaid_fence_rejected",
        True,
        False,
        "<Mermaid> 内包含 Markdown fenced code",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Mermaid>\n```mermaid\nsequenceDiagram\nA->>B: hi\n```\n</Mermaid>"},
            {"type": "card_op", "op": "insert", "summary": "验证 Mermaid 原始源码", "kind": "agent_review"},
        ],
    ),
    (
        "summary_internal_field_rejected",
        True,
        False,
        "summary 包含内部字段名",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增内容</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "根据 blockId 修改", "kind": "agent_review"},
        ],
    ),
    (
        "direct_update_mark_ar_rejected",
        False,
        False,
        "编辑模式禁止使用",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark ar=\"insert\">新增</Mark></Paragraph>"},
        ],
    ),
    (
        "direct_update_title_allowed",
        False,
        True,
        "KS_DOC_EDIT_DRYRUN",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增内容</Paragraph>"},
            {"type": "update_title", "title": "新的文档标题"},
        ],
    ),
    (
        "review_insert_markdown_rejected",
        True,
        False,
        "必须使用组件语法",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "# Markdown 标题"},
            {"type": "card_op", "op": "insert", "summary": "验证 insert 禁止 Markdown", "kind": "agent_review"},
        ],
    ),
    (
        "direct_insert_markdown_table_rejected",
        False,
        False,
        "必须使用组件语法",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "| A | B |\n|---|---|\n| 1 | 2 |"},
        ],
    ),
    (
        "review_update_multiple_blocks_rejected",
        True,
        False,
        "update.new_content 必须是正好 1 个完整组件块",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark ar=\"delete\">旧内容</Mark></Paragraph>\n<Paragraph><Mark ar=\"insert\">新内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 update 单块", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_comment_rejected",
        True,
        False,
        "insert 不得创建评论锚点",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><Mark comment={[\"discussion_xxx\"]}>新增</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 insert 禁止评论锚点", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_invalid_comment_array_rejected",
        True,
        False,
        "Mark.comment 必须是非空字符串数组",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark comment={[123]} ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证评论锚点数组", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_comment_string_rejected",
        True,
        False,
        "Mark.comment 必须使用表达式形式的非空字符串数组",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark comment=\"discussion_xxx\" ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证评论锚点格式", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_comment_expression_rejected",
        True,
        False,
        "Mark.comment 必须是合法 JSON 字符串数组",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark comment={loadSecret()} ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证评论表达式", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_expression_attribute_rejected",
        True,
        False,
        "<Paragraph> 包含不支持的属性",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph data={loadSecret()}><Mark ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证表达式属性", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_new_comment_rejected",
        True,
        False,
        "old_content 中不存在的 comment 锚点",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark comment={[\"discussion_new\"]} ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证禁止新增评论锚点", "kind": "agent_review"},
        ],
    ),
    (
        "direct_update_comment_preserved_allowed",
        False,
        True,
        "KS_DOC_EDIT_DRYRUN",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph><Mark comment={[\"discussion_xxx\"]}>旧内容</Mark></Paragraph>", "new_content": "<Paragraph><Mark comment={[\"discussion_xxx\"]} bold>旧内容</Mark></Paragraph>"},
        ],
    ),
    (
        "direct_insert_comment_rejected",
        False,
        False,
        "insert 不得创建评论锚点",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><Mark comment={[\"discussion_xxx\"]}>新增</Mark></Paragraph>"},
        ],
    ),
    (
        "direct_summary_field_rejected",
        False,
        False,
        "包含 1 个当前 action 不支持的字段",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增</Paragraph>", "summary": "不应出现在直编 action"},
        ],
    ),
    (
        "review_block_summary_field_rejected",
        True,
        False,
        "包含 1 个当前 action 不支持的字段",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增</Paragraph>", "summary": "应放在 card_op"},
            {"type": "card_op", "op": "insert", "summary": "验证 summary 位置", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_alias_conflict_rejected",
        True,
        False,
        "不能同时提供 old_content 与 oldContent",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "oldContent": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证字段别名冲突", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_lowercase_mark_comment_rejected",
        True,
        False,
        "组件名 <mark> 大小写非法",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><mark comment={[\"discussion_new\"]}>新增</mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证组件大小写", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_non_mark_comment_rejected",
        True,
        False,
        "<Paragraph> 包含不支持的属性",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph comment=\"discussion_new\"><Mark ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 comment 归属", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_duplicate_comment_rejected",
        True,
        False,
        "组件属性 comment 重复",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph><Mark comment={[\"discussion_xxx\"]}>旧内容</Mark></Paragraph>", "new_content": "<Paragraph><Mark comment={[\"discussion_xxx\"]} comment=\"discussion_new\" ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证重复 comment", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_block_type_change_rejected",
        True,
        False,
        "update 不能把 <Paragraph> 改成 <Heading>",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Heading level=\"2\"><Mark ar=\"format\">旧内容</Mark></Heading>"},
            {"type": "card_op", "op": "insert", "summary": "验证块类型变化", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_table_rejected",
        True,
        False,
        "禁止对最外层 Table 执行 update",
        [
            {"type": "update", "id": "tbl_root", "old_content": "<Table><TableRow><TableCell><Paragraph>A</Paragraph></TableCell></TableRow></Table>", "new_content": "<Table><TableRow><TableCell><Paragraph><Mark ar=\"format\">A</Mark></Paragraph></TableCell></TableRow></Table>"},
            {"type": "card_op", "op": "insert", "summary": "验证 Table update", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_children_change_rejected",
        True,
        False,
        "块级 children 结构",
        [
            {"type": "update", "id": "blk_callout", "old_content": "<Callout><Paragraph>旧内容</Paragraph></Callout>", "new_content": "<Callout><Paragraph><Mark ar=\"format\">旧内容</Mark></Paragraph><Paragraph>新增段落</Paragraph></Callout>"},
            {"type": "card_op", "op": "insert", "summary": "验证 children 变化", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_code_with_jsx_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Code language=\"tsx\">const button = <Button data={value} />;</Code>"},
            {"type": "card_op", "op": "insert", "summary": "验证 Code 原始源码", "kind": "agent_review"},
        ],
    ),
    (
        "review_unknown_sensitive_field_redacted",
        True,
        False,
        "包含 1 个当前 action 不支持的字段",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增</Paragraph>", "api_key_sk_sensitive_value": "secret"},
            {"type": "card_op", "op": "insert", "summary": "验证字段脱敏", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_html_script_rejected",
        True,
        False,
        "不支持的标签 <script>",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><script>alert(1)</script></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 HTML 标签", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_javascript_link_rejected",
        True,
        False,
        "<Link>.href 仅允许完整 http:// 或 https:// URL",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><Link href=\"javascript:alert(1)\">点击</Link></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证链接协议", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_https_link_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><Link href=\"https://example.com/path\">链接</Link></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证安全链接", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_metadata_injection_rejected",
        True,
        False,
        "禁止写 id/action/reviewId/readonly",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph action=\"delete\" reviewId=\"review_xxx\"><Mark ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证回读元数据注入", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_old_metadata_compatible",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph id=\"blk_intro\" action=\"update\" reviewId=\"review_xxx\">旧内容</Paragraph>", "new_content": "<Paragraph><Mark ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "update", "discussion_id": "review_xxx", "summary": "验证回读元数据兼容"},
        ],
    ),
    (
        "review_insert_mermaid_mark_rejected",
        True,
        False,
        "<Mermaid> 内包含标签 <Mark>",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Mermaid><Mark ar=\"insert\">A --&gt; B</Mark></Mermaid>"},
            {"type": "card_op", "op": "insert", "summary": "验证 Mermaid 组件边界", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_mermaid_raw_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Mermaid>graph TD\n  A --&gt; B</Mermaid>"},
            {"type": "card_op", "op": "insert", "summary": "验证 Mermaid 源码", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_mark_ar_in_value_rejected",
        True,
        False,
        "<Mark> 包含不支持的属性",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark title=\"ar='insert'\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证 ar 属性诱饵", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_duplicate_ar_rejected",
        True,
        False,
        "组件属性 ar 重复",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark ar=\"format\" ar=\"insert\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证重复 ar", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_same_sequence_different_tree_rejected",
        True,
        False,
        "块级 children 结构",
        [
            {"type": "update", "id": "blk_callout", "old_content": "<Callout><BlockQuote><Paragraph>A</Paragraph></BlockQuote><Paragraph>B</Paragraph></Callout>", "new_content": "<Callout><BlockQuote><Paragraph><Mark ar=\"format\">A</Mark></Paragraph><Paragraph>B</Paragraph></BlockQuote></Callout>"},
            {"type": "card_op", "op": "insert", "summary": "验证 children 父子关系", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_attribute_order_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "update", "id": "blk_heading", "old_content": "<Heading level=\"2\" textAlign=\"right\">旧标题</Heading>", "new_content": "<Heading textAlign=\"right\" level=\"2\"><Mark ar=\"format\">旧标题</Mark></Heading>"},
            {"type": "card_op", "op": "insert", "summary": "验证属性顺序兼容", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_content_expression_rejected",
        True,
        False,
        "组件正文禁止 {...} content expression",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>{globalThis.alert(1)}</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证正文表达式", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_unknown_closing_tag_rejected",
        True,
        False,
        "不支持的标签 <script>",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>正文</script></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证未知闭合标签", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_image_event_rejected",
        True,
        False,
        "<Image> 包含不支持的属性",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Image src=\"https://example.com/a.png\" onerror=\"alert(1)\" />"},
            {"type": "card_op", "op": "insert", "summary": "验证图片事件属性", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_mermaid_dangerous_uri_rejected",
        True,
        False,
        "<Mermaid> 源码包含 javascript:/data:/vbscript: 危险协议",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Mermaid>flowchart LR\nA[点击]\nclick A \"javascript:alert(1)\"</Mermaid>"},
            {"type": "card_op", "op": "insert", "summary": "验证 Mermaid 危险协议", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_html_comment_mark_rejected",
        True,
        False,
        "禁止 HTML comment",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph>新内容<!-- <Mark ar=\"format\">隐藏</Mark> --></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证隐藏 Mark", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_empty_mark_rejected",
        True,
        False,
        "<Mark> 必须包含非空文字",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph>新内容<Mark ar=\"format\"></Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证空 Mark", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_bare_metadata_rejected",
        True,
        False,
        "<Paragraph> 包含不支持的属性",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph readonly>正文</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证无值回读属性", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_nested_attribute_change_rejected",
        True,
        False,
        "块级 children 结构",
        [
            {"type": "update", "id": "blk_callout", "old_content": "<Callout><Paragraph textAlign=\"left\">旧内容</Paragraph></Callout>", "new_content": "<Callout><Paragraph textAlign=\"right\"><Mark ar=\"format\">旧内容</Mark></Paragraph></Callout>"},
            {"type": "card_op", "op": "insert", "summary": "验证嵌套块属性", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_heading_level_required",
        True,
        False,
        "<Heading>.level 必须是非空双引号字符串",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Heading>标题</Heading>"},
            {"type": "card_op", "op": "insert", "summary": "验证标题级别", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_heading_level_invalid",
        True,
        False,
        "<Heading>.level 仅允许字符串 1 到 6",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Heading level=\"9\">标题</Heading>"},
            {"type": "card_op", "op": "insert", "summary": "验证标题级别范围", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_private_image_rejected",
        True,
        False,
        "禁止私网、特殊或本机地址",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Image src=\"http://127.0.0.1/a.png\" />"},
            {"type": "card_op", "op": "insert", "summary": "验证图片地址", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_restricted_image_rejected",
        True,
        False,
        "禁止受限内网网段",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Image src=\"https://9.1.2.3/a.png\" />"},
            {"type": "card_op", "op": "insert", "summary": "验证受限地址", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_invalid_table_child_rejected",
        True,
        False,
        "<Table> 不允许直接包含 <Paragraph>",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Table><Paragraph>错误</Paragraph></Table>"},
            {"type": "card_op", "op": "insert", "summary": "验证表格结构", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_divider_body_rejected",
        True,
        False,
        "<Divider> 必须使用自闭合写法",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Divider>正文</Divider>"},
            {"type": "card_op", "op": "insert", "summary": "验证叶子组件", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_mermaid_self_closing_rejected",
        True,
        False,
        "<Mermaid> 禁止自闭合",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Mermaid />"},
            {"type": "card_op", "op": "insert", "summary": "验证图表源码", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_empty_style_mark_rejected",
        True,
        False,
        "<Mark> 必须包含非空文字",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph><Mark bold></Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证空样式标记", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_duplicate_comment_count_rejected",
        True,
        False,
        "丢失 1 个原有 comment 锚点",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph><Mark comment={[\"discussion_xxx\"]}>甲</Mark><Mark comment={[\"discussion_xxx\"]}>乙</Mark></Paragraph>", "new_content": "<Paragraph><Mark comment={[\"discussion_xxx\"]} ar=\"format\">甲乙</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证评论锚点次数", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_container_with_code_allowed",
        True,
        True,
        "KS_DOC_REVIEW_DRYRUN",
        [
            {"type": "update", "id": "blk_callout", "old_content": "<Callout><Paragraph>旧内容</Paragraph><Code language=\"tsx\">const x = <Button />;</Code></Callout>", "new_content": "<Callout><Paragraph><Mark ar=\"delete\">旧内容</Mark><Mark ar=\"insert\">新内容</Mark></Paragraph><Code language=\"tsx\">const x = <Button />;</Code></Callout>"},
            {"type": "card_op", "op": "insert", "summary": "验证容器内原子块", "kind": "agent_review"},
        ],
    ),
    (
        "summary_review_id_rejected",
        True,
        False,
        "summary 包含内部 ID",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "复用 review_abcdef123456", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_short_ipv4_rejected",
        True,
        False,
        "禁止非标准数字 IP 表示",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Image src=\"http://127.1/a.png\" />"},
            {"type": "card_op", "op": "insert", "summary": "验证短地址", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_integer_ipv4_rejected",
        True,
        False,
        "禁止非标准数字 IP 表示",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Image src=\"http://2130706433/a.png\" />"},
            {"type": "card_op", "op": "insert", "summary": "验证整数地址", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_unmarked_change_rejected",
        True,
        False,
        "存在未用 Mark ar 标识的文字变化",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>A B</Paragraph>", "new_content": "<Paragraph>X <Mark ar=\"format\">B</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证完整差异标识", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_nested_code_change_rejected",
        True,
        False,
        "不能修改容器内 Code/MathBlock/Mermaid 原始源码",
        [
            {"type": "update", "id": "blk_callout", "old_content": "<Callout><Paragraph>旧内容</Paragraph><Code language=\"js\">const x = 1;</Code></Callout>", "new_content": "<Callout><Paragraph><Mark ar=\"format\">旧内容</Mark></Paragraph><Code language=\"js\">const x = 2;</Code></Callout>"},
            {"type": "card_op", "op": "insert", "summary": "验证嵌套源码不变", "kind": "agent_review"},
        ],
    ),
    (
        "summary_disc_id_rejected",
        True,
        False,
        "summary 包含内部 ID",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "复用disc_abcdef123456完成调整", "kind": "agent_review"},
        ],
    ),
    (
        "summary_chinese_adjacent_field_rejected",
        True,
        False,
        "summary 包含内部字段名",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "根据blockId修改", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_comment_brace_id_rejected",
        True,
        False,
        "old_content 中不存在的 comment 锚点",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph>旧内容</Paragraph>", "new_content": "<Paragraph><Mark comment={[\"discussion_new\",\"{\"]} ar=\"format\">旧内容</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证评论属性解析", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_unicode_host_rejected",
        True,
        False,
        "主机名必须使用 ASCII",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Image src=\"http://127。0。0。1/a.png\" />"},
            {"type": "card_op", "op": "insert", "summary": "验证 Unicode 主机", "kind": "agent_review"},
        ],
    ),
    (
        "review_insert_mermaid_encoded_uri_rejected",
        True,
        False,
        "<Mermaid> 源码包含 javascript:/data:/vbscript: 危险协议",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Mermaid>flowchart LR\nA[点击]\nclick A \"java&#115;cript:alert(1)\"</Mermaid>"},
            {"type": "card_op", "op": "insert", "summary": "验证编码危险协议", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_mathblock_html_rejected",
        True,
        False,
        "<MathBlock> 内包含标签 <img>",
        [
            {"type": "update", "id": "blk_callout", "old_content": "<Callout><Paragraph>旧内容</Paragraph><MathBlock>x+1</MathBlock></Callout>", "new_content": "<Callout><Paragraph><Mark ar=\"format\">旧内容</Mark></Paragraph><MathBlock>&lt;img src=x onerror=alert(1)&gt;</MathBlock></Callout>"},
            {"type": "card_op", "op": "insert", "summary": "验证公式标签", "kind": "agent_review"},
        ],
    ),
    (
        "review_update_comment_drift_rejected",
        True,
        False,
        "改变了 comment 锚点文本或范围",
        [
            {"type": "update", "id": "blk_intro", "old_content": "<Paragraph><Mark comment={[\"discussion_xxx\"]}>甲</Mark>乙</Paragraph>", "new_content": "<Paragraph>甲<Mark comment={[\"discussion_xxx\"]} ar=\"format\">乙</Mark></Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "验证评论范围", "kind": "agent_review"},
        ],
    ),
    (
        "summary_short_id_rejected",
        True,
        False,
        "summary 包含内部 ID",
        [
            {"type": "insert_after", "id": "blk_intro", "content": "<Paragraph>新增</Paragraph>"},
            {"type": "card_op", "op": "insert", "summary": "根据blk_intro修改", "kind": "agent_review"},
        ],
    ),
]


def verify(examples_dir: Path) -> int:
    if not examples_dir.exists():
        print("KS_EXAMPLES_SELFCHECK_FAILED")
        print(json.dumps(
            {"failed": [{"file": str(examples_dir), "error": "examples 目录不存在"}]},
            ensure_ascii=False,
        ))
        return 0

    example_files = sorted(examples_dir.glob("example_*.json"))
    if not example_files:
        print("KS_EXAMPLES_SELFCHECK_FAILED")
        print(json.dumps(
            {"failed": [{"file": str(examples_dir), "error": "未找到 example_*.json"}]},
            ensure_ascii=False,
        ))
        return 0

    failures: List[dict] = []
    for name, should_pass, expected_text, content, extra_args in _CREATE_DOC_REGRESSION_CASES:
        ok, stdout = _run_create_doc_dry_run(content, extra_args)
        if ok != should_pass or (expected_text and expected_text not in stdout):
            first_line = stdout.split("\n", 1)[0] if stdout else "<empty stdout>"
            failures.append({
                "file": f"<regression:{name}>",
                "error": f"expected pass={should_pass}, contains={expected_text!r}; got: {first_line}",
            })

    for name, is_review, should_pass, expected_text, actions in _REGRESSION_CASES:
        submit_script = _SUBMIT_REVIEW if is_review else _SUBMIT_EDIT
        ok, stdout = _run_dry_run_json(submit_script, actions, is_review, name)
        if ok != should_pass or (expected_text and expected_text not in stdout):
            first_line = stdout.split("\n", 1)[0] if stdout else "<empty stdout>"
            failures.append({
                "file": f"<regression:{name}>",
                "error": f"expected pass={should_pass}, contains={expected_text!r}; got: {first_line}",
            })

    for f in example_files:
        try:
            with f.open("r", encoding="utf-8") as fp:
                actions = json.load(fp)
        except (OSError, json.JSONDecodeError) as e:
            failures.append({"file": f.name, "error": f"JSON 解析失败: {e}"})
            continue

        if not isinstance(actions, list):
            failures.append({"file": f.name, "error": "顶层必须是 JSON 数组"})
            continue

        is_review = _looks_like_review_actions(actions)
        submit_script = _SUBMIT_REVIEW if is_review else _SUBMIT_EDIT

        ok, stdout = _run_dry_run(submit_script, f, is_review)
        if not ok:
            # 抽取脚本 stdout 首行（通常是 JSON error）
            first_line = stdout.split("\n", 1)[0] if stdout else "<empty stdout>"
            failures.append({"file": f.name, "error": first_line})

    if failures:
        print("KS_EXAMPLES_SELFCHECK_FAILED")
        print(json.dumps({"failed": failures}, ensure_ascii=False))
        return 0

    print("KS_EXAMPLES_SELFCHECK_OK")
    print(json.dumps(
        {"checked": [f.name for f in example_files]},
        ensure_ascii=False,
    ))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="批量校验 doc 示例合规性")
    parser.add_argument(
        "--dir",
        default=str(_HERE),
        help="示例目录（默认为本脚本所在目录）",
    )
    ns = parser.parse_args()
    return verify(Path(ns.dir))


if __name__ == "__main__":
    sys.exit(main())
