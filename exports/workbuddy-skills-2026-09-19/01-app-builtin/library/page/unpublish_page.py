#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/unpublish_page.py —— 取消发布 Page

用法（token 注入见 SKILL.md §调用方式与运行模式）：
    python3 page/unpublish_page.py --token-stdin --node-id "<node_id>"

行为：
    - POST <API_BASE>/space/api/agent/v1/unpublish-page
    - 取消指定 Page 节点的发布状态，发布链接将不再可访问
    - 需要对该节点有管理员权限
    - 成功时 stdout 输出服务端 JSON 信封
    - 失败输出 {"error":"<msg>"} 后 exit 0
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print  # noqa: E402

API_PATH = "/space/api/agent/v1/unpublish-page"


def _post_envelope(token: str, body: dict, *, timeout: float = 30.0) -> dict:
    return http_request(
        "POST", _common.build_url(API_PATH), token, body=body, timeout=timeout
    )


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--node-id", dest="node_id", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    node_id = (args.node_id or "").strip()
    if not node_id:
        error_exit("node_id 缺失")

    body = {"nodeId": node_id}

    try:
        envelope = _post_envelope(token, body)
    except HttpError as e:
        error_exit(f"取消发布 Page 失败: {e}", traceid=e.traceid)

    safe_print(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))

    code = envelope.get("code", envelope.get("retcode"))
    if code in (0, "0", "OK", "ok"):
        safe_print("KS_PAGE_UNPUBLISH\tOK")
        safe_print("KS_USER_REPLY\t页面已取消发布，发布链接不再可访问。")


if __name__ == "__main__":
    main()
