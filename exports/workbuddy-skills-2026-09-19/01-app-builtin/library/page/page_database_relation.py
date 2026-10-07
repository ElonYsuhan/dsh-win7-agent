#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""管理 Page ↔ Database 关联关系。

    --action link   --page-id X --database-id Y   # 建立关联
    --action list   --page-id X | --database-id Y # 查询关联（二者至少其一）
    --action unlink --page-id X --database-id Y   # 解除关联
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print  # noqa: E402

# action → (API 路径, 失败前缀文案)
_ACTIONS = {
    "link": ("/space/api/agent/v1/link-page-database", "建立 Page 与 Database 关联失败"),
    "list": ("/space/api/agent/v1/list-page-database-relations", "查询 Page 与 Database 关联失败"),
    "unlink": ("/space/api/agent/v1/unlink-page-database", "解除 Page 与 Database 关联失败"),
}
_SPACE_D_RE = re.compile(r"/space/d/([^/?#]+)")


def _normalize_node_id(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    match = _SPACE_D_RE.search(value)
    if match:
        return match.group(1).strip()
    return value


def _build_body(action: str, page_id: str, database_id: str) -> dict:
    """按 action 校验入参并组装请求体。"""
    if action == "list":
        if not page_id and not database_id:
            error_exit("page_id 与 database_id 至少传一个")
        body = {}
        if page_id:
            body["pageId"] = page_id
        if database_id:
            body["databaseId"] = database_id
        return body

    # link / unlink：两者都必填
    if not page_id:
        error_exit("page_id 缺失")
    if not database_id:
        error_exit("database_id 缺失")
    return {"pageId": page_id, "databaseId": database_id}


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--action", dest="action", default="")
    parser.add_argument("--page-id", dest="page_id", default="")
    parser.add_argument("--database-id", dest="database_id", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    action = (args.action or "").strip().lower()
    if action not in _ACTIONS:
        error_exit("action 必须是 link / list / unlink 之一")
    api_path, fail_prefix = _ACTIONS[action]

    token = _common.acquire_token()

    page_id = _normalize_node_id(args.page_id)
    database_id = _normalize_node_id(args.database_id)
    body = _build_body(action, page_id, database_id)

    try:
        envelope = http_request(
            "POST", _common.build_url(api_path), token, body=body, timeout=15.0
        )
    except HttpError as e:
        error_exit(f"{fail_prefix}: {e}", traceid=e.traceid)

    safe_print(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
