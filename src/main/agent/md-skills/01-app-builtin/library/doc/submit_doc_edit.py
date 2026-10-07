#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doc/submit_doc_edit.py —— 直接编辑资料库在线文档（不走审阅/修订模式）。

Token 注入见 SKILL.md §调用方式与运行模式。

接口：
    POST <API_BASE>/space/api/agent/v1/submit-doc-edit

输入 actions（推荐 --actions-stdin）使用用户友好的 snake_case：
    [
      {"type":"insert_after", "id":"blk_xxx", "content":"<Paragraph>最终正文</Paragraph>"},
      {"type":"update", "id":"blk_yyy", "old_content":"<Paragraph>旧正文</Paragraph>", "new_content":"<Paragraph>新正文</Paragraph>"},
      {"type":"delete", "id":"blk_zzz"},
      {"type":"update_title", "title":"新的文档标题"}
    ]

与 submit_review_edit.py 的关键区别：
    - 禁止 card_op（不创建审阅卡片）
    - 禁止 summary
    - 禁止 <Mark ar="insert/delete/format">（content 必须是最终正文）
    - INSERT 直接落正文，DELETE 走物理删除，UPDATE 直接覆盖 title
    - 独占支持 update_title：修改文档节点页面标题（frontmatter.title / 节点树显示名），
      仅编辑模式可用；审阅模式（submit_review_edit.py）不支持

stdout 协议：
    # 正式提交成功
    KS_DOC_EDIT_SUBMIT\t<anchorBlockId>\t<affectedCount>
    {"anchorBlockId":"...","anchorUrl":"https://...#blk_xxx","affectedBlockIds":[...]}

    # --dry-run 成功（不发 HTTP）
    KS_DOC_EDIT_DRYRUN\t<N>\tactions=ok
    {"dryRun":true,"actionsCount":N,"pageId":"...","mode":"edit"}

失败：stdout 输出单行 JSON {"error":"<脱敏原因>"}，exit 0。
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable, List, Mapping, Optional, Set

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import (  # noqa: E402
    HttpError,
    build_direct_edit_user_reply,
    emit_user_reply,
    error_exit,
    http_request,
    safe_print,
    unwrap_data,
)
from doc.content_validator import (  # noqa: E402
    ContentContractError,
    ContentValidationMode,
    validate_content_contract,
    validate_update_preserves_inline_metadata,
)

API_PATH = "/space/api/agent/v1/submit-doc-edit"
HTTP_TIMEOUT = 30.0

# 编辑模式 content/new_content 契约统一由 doc.content_validator 校验。

# update_title 的 title 长度上限
UPDATE_TITLE_MAX_CHARS = 200

# 编辑模式允许的 action type（禁止 card_op；允许 update_title）
_TYPE_TO_NUM = {
    "insert_before": "1",
    "insertbefore": "1",
    "insert_after": "2",
    "insertafter": "2",
    "delete": "3",
    "update": "4",
    "move": "5",
    "update_title": "7",
    "updatetitle": "7",
    "1": "1",
    "2": "2",
    "3": "3",
    "4": "4",
    "5": "5",
    "7": "7",
}


class JsonErrorArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        error_exit("参数解析失败")


def _build_parser() -> argparse.ArgumentParser:
    parser = JsonErrorArgumentParser(
        description="Submit direct edit actions for a library doc (no review card).",
        add_help=True,
    )
    _common.register_token_arg(parser)
    parser.add_argument("--page-id", required=True)
    parser.add_argument("--dry-run", action="store_true",
                        help="Validate and print request summary without sending HTTP request.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--actions-json")
    group.add_argument("--actions-file")
    group.add_argument("--actions-stdin", action="store_true")
    return parser


def _normalize_id(raw: Optional[str]) -> str:
    if not isinstance(raw, str):
        return ""
    v = raw.strip()
    if not v or any(ch in v for ch in ("/", "?", "#", "\t", "\n", "\r")):
        return ""
    return v


def _load_actions(args: argparse.Namespace) -> List[Mapping[str, Any]]:
    raw: Optional[str] = None
    if args.actions_json:
        raw = args.actions_json
    elif args.actions_file:
        try:
            raw = Path(args.actions_file).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            error_exit("读取 actions-file 失败")
    elif args.actions_stdin:
        raw = sys.stdin.read()
    try:
        data = json.loads(raw or "")
    except json.JSONDecodeError:
        error_exit("actions JSON 解析失败")
    if not isinstance(data, list) or not data:
        error_exit("actions 必须是非空数组")
    out: List[Mapping[str, Any]] = []
    for item in data:
        if not isinstance(item, Mapping):
            error_exit("actions 中存在非对象元素")
        out.append(item)
    return out


def _type_num(action_type: Any) -> str:
    key = str(action_type or "").strip()
    if not key:
        return ""
    normalized = key.replace("-", "_")
    return _TYPE_TO_NUM.get(normalized) or _TYPE_TO_NUM.get(normalized.lower(), "")


def _require_str(action: Mapping[str, Any], key: str) -> str:
    v = action.get(key)
    if not isinstance(v, str):
        return ""
    return v.strip()


def _has_value(action: Mapping[str, Any], key: str) -> bool:
    if key not in action:
        return False
    v = action.get(key)
    if v is None:
        return False
    if isinstance(v, str):
        return bool(v.strip())
    return True


def _reject_unknown_fields(action: Mapping[str, Any], idx: int, allowed: Set[str]) -> None:
    unknown_count = sum(1 for key in action if key not in allowed)
    if unknown_count:
        error_exit(
            f"actions[{idx}] 包含 {unknown_count} 个当前 action 不支持的字段；"
            f"请删除未知字段，仅保留: {', '.join(sorted(allowed))}"
        )


def _reject_alias_conflict(action: Mapping[str, Any], idx: int, snake_key: str, camel_key: str) -> None:
    if snake_key in action and camel_key in action:
        error_exit(f"actions[{idx}] 不能同时提供 {snake_key} 与 {camel_key}；请只保留一种写法")


def _optional_bool(action: Mapping[str, Any], idx: int, snake_key: str, camel_key: str) -> bool:
    if snake_key not in action and camel_key not in action:
        return False
    value = action.get(snake_key) if snake_key in action else action.get(camel_key)
    if isinstance(value, bool):
        return value
    error_exit(f"actions[{idx}] {snake_key} 必须是布尔值")
    return False


def _validate_content_contract_or_exit(content: str, idx: int, mode: str) -> None:
    try:
        validate_content_contract(content, idx, mode)
    except ContentContractError as e:
        error_exit(str(e))


def _validate_update_preserves_inline_metadata_or_exit(
    old_content: str,
    new_content: str,
    idx: int,
    allow_drop_comment: bool,
    drop_comment_reason: str,
) -> None:
    try:
        validate_update_preserves_inline_metadata(
            old_content,
            new_content,
            idx,
            allow_drop_comment,
            drop_comment_reason,
        )
    except ContentContractError as e:
        error_exit(str(e))


def _translate_action(idx: int, action: Mapping[str, Any]) -> Mapping[str, Any]:
    t = _type_num(action.get("type"))
    if not t:
        error_exit(f"actions[{idx}] 的 type 无效或不允许（编辑模式禁止 card_op）")

    block_id = _require_str(action, "id")
    content = action.get("content")
    content_str = content if isinstance(content, str) else ""

    if t == "1":  # insert_before
        _reject_unknown_fields(action, idx, {"type", "id", "content"})
        if not block_id or not content_str:
            error_exit(f"actions[{idx}] insert_before 缺少 id 或 content")
        _validate_content_contract_or_exit(content_str, idx, ContentValidationMode.DIRECT_INSERT)
        return {"type": t, "id": block_id, "content": content_str}

    if t == "2":  # insert_after；id 允许空表示追加到文末
        _reject_unknown_fields(action, idx, {"type", "id", "content"})
        if not content_str:
            error_exit(f"actions[{idx}] insert_after 缺少 content")
        _validate_content_contract_or_exit(content_str, idx, ContentValidationMode.DIRECT_INSERT)
        return {"type": t, "id": block_id, "content": content_str}

    if t == "3":  # delete
        _reject_unknown_fields(action, idx, {"type", "id", "content"})
        if not block_id or _has_value(action, "content"):
            error_exit(f"actions[{idx}] delete 需要 id 且不能有 content")
        return {"type": t, "id": block_id}

    if t == "4":  # update
        _reject_unknown_fields(action, idx, {
            "type", "id", "content", "old_content", "oldContent", "new_content", "newContent",
            "allow_drop_comment", "allowDropComment", "drop_comment_reason", "dropCommentReason",
        })
        for snake_key, camel_key in (
            ("old_content", "oldContent"),
            ("new_content", "newContent"),
            ("allow_drop_comment", "allowDropComment"),
            ("drop_comment_reason", "dropCommentReason"),
        ):
            _reject_alias_conflict(action, idx, snake_key, camel_key)
        new_content = _require_str(action, "new_content") or _require_str(action, "newContent")
        old_content = _require_str(action, "old_content") or _require_str(action, "oldContent")
        if not block_id or not new_content or _has_value(action, "content"):
            error_exit(f"actions[{idx}] update 需要 id + old_content + new_content 且不能有 content")
        _validate_content_contract_or_exit(new_content, idx, ContentValidationMode.DIRECT_UPDATE)
        allow_drop_comment = _optional_bool(action, idx, "allow_drop_comment", "allowDropComment")
        drop_comment_reason = _require_str(action, "drop_comment_reason") or _require_str(action, "dropCommentReason")
        _validate_update_preserves_inline_metadata_or_exit(
            old_content,
            new_content,
            idx,
            allow_drop_comment,
            drop_comment_reason,
        )
        return {
            "type": t,
            "id": block_id,
            "updateArgs": {"targetId": block_id, "newContent": new_content},
        }

    if t == "5":  # move
        _reject_unknown_fields(action, idx, {"type", "id", "content", "after_id", "afterId", "before_id", "beforeId"})
        _reject_alias_conflict(action, idx, "after_id", "afterId")
        _reject_alias_conflict(action, idx, "before_id", "beforeId")
        after_id = _require_str(action, "after_id") or _require_str(action, "afterId")
        before_id = _require_str(action, "before_id") or _require_str(action, "beforeId")
        if not block_id or _has_value(action, "content") or (after_id and before_id) or (not after_id and not before_id):
            error_exit(f"actions[{idx}] move 参数非法（需 id + 恰好一个 after_id/before_id，且不能有 content）")
        return {
            "type": t,
            "id": block_id,
            "moveArgs": {"targetId": block_id, "afterId": after_id, "beforeId": before_id},
        }

    if t == "7":  # update_title：修改文档节点页面标题（frontmatter.title / 节点树显示名）
        _reject_unknown_fields(action, idx, {"type", "id", "content", "title"})
        # update_title 是 page 级操作，操作对象是文档节点自身（pageID 由 --page-id 承载），
        # 不需要 block id，也不涉及正文 content。允许 title 为空字符串（清空标题语义）。
        if block_id or _has_value(action, "content"):
            error_exit(f"actions[{idx}] update_title 不允许携带 id 或 content")
        # 允许 title 缺失时报错；允许空字符串（清空标题语义）。
        if "title" not in action:
            error_exit(f"actions[{idx}] update_title 缺少 title 字段")
        title_raw = action.get("title")
        if not isinstance(title_raw, str):
            error_exit(f"actions[{idx}] update_title 的 title 必须是字符串")
        # 长度校验：按原始字符数，非字节数。
        if len(title_raw) > UPDATE_TITLE_MAX_CHARS:
            error_exit(f"actions[{idx}] update_title 的 title 超过 {UPDATE_TITLE_MAX_CHARS} 字符")
        return {
            "type": t,
            "updateTitleArgs": {"title": title_raw},
        }

    error_exit(f"actions[{idx}] 未知的 type: {t}")
    return {}


def _translate_actions(actions: List[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    translated = [_translate_action(i, a) for i, a in enumerate(actions)]
    # 编辑模式强约束：禁止 card_op
    for i, a in enumerate(actions):
        raw_type = str(a.get("type", "")).strip().replace("-", "_").lower()
        if raw_type in ("card_op", "cardop", "6"):
            error_exit(f"actions[{i}] 编辑模式禁止 card_op")
    # 至少 1 条 action
    if not translated:
        error_exit("actions 至少需要 1 条操作")
    # update_title 必须位于末尾，且至多 1 条。
    title_indices = [i for i, t in enumerate(translated) if t.get("type") == "7"]
    if len(title_indices) > 1:
        error_exit("actions 至多允许 1 条 update_title")
    if title_indices:
        first_title_idx = title_indices[0]
        for j in range(first_title_idx + 1, len(translated)):
            if translated[j].get("type") != "7":
                error_exit(
                    f"actions[{j}] 必须出现在 update_title 之前"
                    f"（update_title 必须位于 actions 末尾）"
                )
    return translated


def main(argv: Optional[Iterable[str]] = None) -> None:
    parser = _build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit:
        raise

    token = _common.acquire_token()

    page_id = _normalize_id(args.page_id)
    if not page_id:
        error_exit("page_id 缺失或格式非法")

    raw_actions = _load_actions(args)
    actions = _translate_actions(raw_actions)

    body = {
        "pageId": page_id,
        "actions": actions,
    }

    if args.dry_run:
        safe_print(f"KS_DOC_EDIT_DRYRUN\t{len(actions)}\tactions=ok")
        safe_print(json.dumps({
            "dryRun": True,
            "actionsCount": len(actions),
            "pageId": page_id,
            "mode": "edit",
        }, ensure_ascii=False, separators=(",", ":")))
        return

    try:
        envelope = http_request(
            "POST",
            _common.build_url(API_PATH),
            token,
            body=body,
            timeout=HTTP_TIMEOUT,
        )
        data = unwrap_data(envelope)
    except HttpError as e:
        error_exit(f"直接编辑提交失败: {e}")
        return

    anchor_raw = data.get("anchorBlockId")
    affected = data.get("affectedBlockIds")
    if anchor_raw in (None, ""):
        anchor_block_id = "-"
    else:
        anchor_block_id = _normalize_id(anchor_raw)
        if not anchor_block_id:
            error_exit("直接编辑提交失败: 响应 anchorBlockId 格式非法")
    if not isinstance(affected, list):
        error_exit("直接编辑提交失败: 响应 affectedBlockIds 类型非法")
    normalized_affected = [_normalize_id(item) for item in affected]
    if any(not item for item in normalized_affected):
        error_exit("直接编辑提交失败: 响应 affectedBlockIds 包含非法 ID")
    affected = normalized_affected

    anchor_url = (
        _common.build_public_url(f"/space/d/{page_id}#{anchor_block_id}")
        if anchor_block_id and anchor_block_id != "-" else ""
    )

    safe_print(f"KS_DOC_EDIT_SUBMIT\t{anchor_block_id}\t{len(affected)}")
    safe_print(json.dumps({
        "anchorBlockId": "" if anchor_block_id == "-" else anchor_block_id,
        "anchorUrl": anchor_url,
        "affectedBlockIds": affected,
    }, ensure_ascii=False, separators=(",", ":")))

    # 成品回执行：上层必须原样透传，禁止自拼近似链接（易丢 #锚点）。
    emit_user_reply(build_direct_edit_user_reply(len(affected), anchor_url))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        error_exit("未预期的异常")
