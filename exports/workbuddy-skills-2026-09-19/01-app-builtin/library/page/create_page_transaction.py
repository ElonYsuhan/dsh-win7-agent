#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/create_page_transaction.py —— 开启 Page 编辑事务

用法（token 注入见 SKILL.md §调用方式与运行模式）：
    python3 page/create_page_transaction.py --token-stdin --node-id "<page_node_id>"

行为：
    - POST <API_BASE>/space/api/agent/v1/create-page-transaction
    - 成功时 stdout 直接输出服务端 JSON 信封
    - 失败输出 {"error":"<msg>"} 后 exit 0
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

API_PATH = "/space/api/agent/v1/create-page-transaction"
_SPACE_D_RE = re.compile(r"/space/d/([^/?#]+)")


def _normalize_node_id(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    match = _SPACE_D_RE.search(value)
    if match:
        return match.group(1).strip()
    return value


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--node-id", dest="node_id", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    node_id = _normalize_node_id(args.node_id)
    if not node_id:
        error_exit("node_id 缺失")

    try:
        envelope = http_request(
            "POST",
            _common.build_url(API_PATH),
            token,
            body={"nodeId": node_id},
            timeout=15.0,
        )
    except HttpError as e:
        error_exit(f"开启 Page 事务失败: {e}")

    safe_print(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
