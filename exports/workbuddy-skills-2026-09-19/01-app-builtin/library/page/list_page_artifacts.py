#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/list_page_artifacts.py —— 查询已托管 Page 的指定或最新版本产物列表

用法（macOS / Linux / Git Bash；token 注入见 SKILL.md §调用方式与运行模式）：
    python3 page/list_page_artifacts.py --token-stdin --node-id "<page_node_id>"
    python3 page/list_page_artifacts.py --token-stdin --node-id "<page_node_id>" --version 3
    python3 page/list_page_artifacts.py --token-stdin --node-id "https://workbuddy.cn/space/d/<page_node_id>"

行为：
    - POST <API_BASE>/space/api/agent/v1/list-page-artifacts
    - --version 可选；不传时查询当前最新版本
    - 成功时 stdout 直接输出服务端 JSON 信封
    - 失败输出 {"error":"<msg>"} 后 exit 0，不暴露 token / Cookie / 堆栈
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Optional

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print  # noqa: E402

API_PATH = "/space/api/agent/v1/list-page-artifacts"
_SPACE_D_RE = re.compile(r"/space/d/([^/?#]+)")
# 发布态短链 workbuddy.link/p/<id>。
_PUBLISH_P_RE = re.compile(r"/p/([^/?#]+)")
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1


def _normalize_node_id(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    match = _SPACE_D_RE.search(value)
    if match:
        return match.group(1).strip()
    match = _PUBLISH_P_RE.search(value)
    if match:
        return match.group(1).strip()
    return value


def _parse_version(raw: str) -> Optional[int]:
    value = (raw or "").strip()
    if not value:
        return None
    try:
        version = int(value, 10)
    except ValueError:
        error_exit("version 必须是 int64 整数")
    if version < _INT64_MIN or version > _INT64_MAX:
        error_exit("version 必须是 int64 整数")
    return version


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--node-id", dest="node_id", default="")
    parser.add_argument("--version", dest="version", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    node_id = _normalize_node_id(args.node_id)
    if not node_id:
        error_exit("node_id 缺失")

    body = {"nodeId": node_id}
    version = _parse_version(args.version)
    if version is not None:
        body["version"] = version

    try:
        envelope = http_request(
            "POST",
            _common.build_url(API_PATH),
            token,
            body=body,
            timeout=15.0,
        )
    except HttpError as e:
        error_exit(f"获取 Page 产物列表失败: {e}")

    safe_print(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
