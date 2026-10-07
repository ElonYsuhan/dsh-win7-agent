#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/get_page_upload_url.py —— 获取 Page 事务工作区上传 URL

用法（token 注入见 SKILL.md §调用方式与运行模式）：
    python3 page/get_page_upload_url.py --token-stdin --transaction-id "<tx_id>" --path "index.html"

行为：
    - POST <API_BASE>/space/api/agent/v1/get-page-upload-url
    - 成功时 stdout 直接输出服务端 JSON 信封
    - 响应 data.uploadUrl 是预签名 PUT URL；调用方不要向最终用户回显
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

API_PATH = "/space/api/agent/v1/get-page-upload-url"


def _safe_rel_path(raw: str) -> str:
    path = (raw or "").replace("\\", "/").strip()
    if not path or path.startswith("/") or "\x00" in path:
        return ""
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return ""
    return "/".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--transaction-id", dest="transaction_id", default="")
    parser.add_argument("--path", dest="path", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    tx_id = (args.transaction_id or "").strip()
    rel = _safe_rel_path(args.path)
    if not tx_id:
        error_exit("transaction_id 缺失")
    if not rel:
        error_exit("path 缺失或非法")

    try:
        envelope = http_request(
            "POST",
            _common.build_url(API_PATH),
            token,
            body={"transactionId": tx_id, "path": rel},
            timeout=15.0,
        )
    except HttpError as e:
        error_exit(f"获取 Page 上传 URL 失败: {e}")

    safe_print(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
