#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/publish_page.py —— 发布 Page

用法（token 注入见 SKILL.md §调用方式与运行模式）：
    python3 page/publish_page.py --token-stdin --node-id "<node_id>"

行为：
    - POST <API_BASE>/space/api/agent/v1/publish-page
    - 将指定 Page 节点的最新版本发布为公开可访问状态，返回发布后的访问 URL
    - 需要对该节点有管理员权限
    - 成功时 stdout 输出服务端 JSON 信封
    - 失败输出 {"error":"<msg>"} 后 exit 0
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from pathlib import Path

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print  # noqa: E402

API_PATH = "/space/api/agent/v1/publish-page"


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
        error_exit(f"发布 Page 失败: {e}", traceid=e.traceid)

    safe_print(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))

    code = envelope.get("code", envelope.get("retcode"))
    if code in (0, "0", "OK", "ok"):
        data = envelope.get("data") or envelope.get("result") or {}
        if isinstance(data, Mapping):
            publish_url = str(data.get("publishUrl") or "").strip()
            if publish_url:
                safe_print(f"KS_PAGE_PUBLISH\t{publish_url}")
                safe_print(f"KS_USER_REPLY\t页面已发布，访问链接：{publish_url}")


if __name__ == "__main__":
    main()
