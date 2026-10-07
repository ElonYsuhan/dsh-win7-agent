#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
database/get_database_record.py —— 获取 Database 单条记录

用法（macOS / Linux / Git Bash；token 注入见 SKILL.md §调用方式与运行模式）：
    python3 database/get_database_record.py --token-stdin --database-id "<id>" --record-id "<rid>"

行为：
    - POST <API_BASE>/space/api/agent/v1/get-record
      body = {"databaseId": "...", "recordId": "..."}
    - 成功 → stdout JSON: {"record_id": "...", "fields": {...}}
    - 失败 → stdout JSON: {"error": "具体错误描述"}，exit 0

参数变更说明：
    - 本接口不再需要 spaceId 参数
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 复用 library/_common.py 的 token / HTTP / 脱敏 / 静默退出约定。
_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print, unwrap_data  # noqa: E402

_PATH_GET_RECORD = "/space/api/agent/v1/get-record"


def db_post(url: str, token: str, body: dict, *, timeout: float = 15.0) -> dict:
    """Database POST 封装：发请求 + 解包 {code, msg, data} 信封，失败抛 HttpError。"""
    return unwrap_data(http_request("POST", url, token, body=body, timeout=timeout))


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--database-id", dest="database_id", default="")
    parser.add_argument("--record-id", dest="record_id", default="")
    try:
        args, _ = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    database_id = (args.database_id or "").strip()
    record_id = (args.record_id or "").strip()

    if not database_id or not record_id:
        error_exit("database_id 或 record_id 缺失")

    body = {
        "databaseId": database_id,
        "recordId": record_id,
    }

    try:
        data = db_post(_common.build_url(_PATH_GET_RECORD), token, body, timeout=15.0)
    except HttpError as e:
        error_exit(f"获取记录请求失败: {e}")

    record = data.get("result", {})
    if not isinstance(record, dict):
        error_exit("响应中 result 字段格式非法")

    output = {
        "record_id": str(record.get("_id") or record_id),
        "fields": {key: value for key, value in record.items() if key != "_id"},
    }
    safe_print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
