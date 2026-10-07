#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
database/query_database_record.py —— 查询 Database 记录列表

客户端模式用法（macOS / Linux / Git Bash；沙箱模式见 SKILL.md §调用方式与运行模式）：
    printf '%s' '<token>' | python3 database/query_database_record.py --token-stdin --database-id "<id>" [--filter '<JSON>'] [--sorts '<JSON>'] [--fields '<JSON>'] [--page-size N] [--start-cursor "<cursor>"]
    printf '%s\n%s' '<token>' '{"database_id":"...","filter":{...}}' | python3 database/query_database_record.py --token-stdin --stdin

行为：
    - POST <API_BASE>/space/api/agent/v1/query-database
      body = {"databaseId": "...", "filter": {...}, "sorts": [...], ...}
    - 成功 → stdout JSON: {"results": [{"record_id": "...", ...}], "next_cursor": "...", "has_more": bool}
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

_PATH_QUERY_RECORD = "/space/api/agent/v1/query-database"


def db_post(url: str, token: str, body: dict, *, timeout: float = 15.0) -> dict:
    """Database POST 封装：发请求 + 解包 {code, msg, data} 信封，失败抛 HttpError。"""
    return unwrap_data(http_request("POST", url, token, body=body, timeout=timeout))


def _parse_json_arg(raw: str) -> object:
    """解析可选 JSON 字符串；显式传入非法 JSON 时拒绝请求。"""
    if not raw or not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("JSON 参数格式非法") from exc


def _read_input(args: argparse.Namespace) -> dict:
    """从参数或 stdin 读取输入。"""
    if args.stdin:
        try:
            raw = sys.stdin.read()
        except (OSError, IOError):
            return {}
        if not raw or not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict):
            return {}
        return data

    # 从命令行参数组合
    database_id = (args.database_id or "").strip()
    if not database_id:
        return {}

    body: dict = {"database_id": database_id}

    filter_obj = _parse_json_arg(args.filter or "")
    if filter_obj is not None and not isinstance(filter_obj, dict):
        raise ValueError("filter 必须是 JSON 对象")
    if filter_obj:
        body["filter"] = filter_obj

    sorts_obj = _parse_json_arg(args.sorts or "")
    if sorts_obj is not None and not isinstance(sorts_obj, list):
        raise ValueError("sorts 必须是 JSON 数组")
    if sorts_obj:
        body["sorts"] = sorts_obj

    fields_obj = _parse_json_arg(args.fields or "")
    if fields_obj is not None and not isinstance(fields_obj, list):
        raise ValueError("fields 必须是 JSON 数组")
    if fields_obj:
        body["fields"] = fields_obj

    if args.page_size and args.page_size > 0:
        body["page_size"] = args.page_size

    if args.start_cursor and args.start_cursor.strip():
        body["start_cursor"] = args.start_cursor.strip()

    return body


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--database-id", dest="database_id", default="")
    parser.add_argument("--filter", default="")
    parser.add_argument("--sorts", default="")
    parser.add_argument("--fields", default="")
    parser.add_argument("--page-size", dest="page_size", type=int, default=0)
    parser.add_argument("--start-cursor", dest="start_cursor", default="")
    parser.add_argument("--stdin", action="store_true")
    try:
        args, _ = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    try:
        data = _read_input(args)
    except ValueError as exc:
        error_exit(str(exc))
    if not data:
        error_exit("输入参数为空或格式非法")

    database_id = (data.get("database_id") or "").strip()
    if not database_id:
        error_exit("database_id 缺失")

    # 构建请求 body（使用驼峰式字段名，与新 API 对齐）
    body: dict = {"databaseId": database_id}

    if data.get("filter"):
        body["filter"] = data["filter"]
    if data.get("sorts"):
        body["sorts"] = data["sorts"]
    if data.get("fields"):
        body["fields"] = data["fields"]
    if data.get("page_size"):
        body["pageSize"] = int(data["page_size"])
    if data.get("start_cursor"):
        body["startCursor"] = str(data["start_cursor"])

    try:
        resp_data = db_post(_common.build_url(_PATH_QUERY_RECORD), token, body, timeout=15.0)
    except HttpError as e:
        error_exit(f"查询记录请求失败: {e}")

    results = resp_data.get("results", [])
    if results is None:
        results = []
    if not isinstance(results, list):
        error_exit("服务端返回的 results 格式非法")
    for index, record in enumerate(results):
        if not isinstance(record, dict):
            error_exit(f"服务端返回的 results[{index}] 格式非法")
        record_id = record.pop("_id", None)
        if not isinstance(record_id, str) or not record_id.strip():
            error_exit(f"服务端返回的 results[{index}]._id 缺失")
        record["record_id"] = record_id.strip()
    next_cursor = str(resp_data.get("nextCursor", resp_data.get("next_cursor", "")))
    has_more = bool(resp_data.get("hasMore", resp_data.get("has_more", False)))

    output = {
        "results": results,
        "next_cursor": next_cursor,
        "has_more": has_more,
    }
    safe_print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
