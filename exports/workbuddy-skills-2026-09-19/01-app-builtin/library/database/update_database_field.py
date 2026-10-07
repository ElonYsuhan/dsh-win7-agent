#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
database/update_database_field.py —— 修改 Database 单列（名称或类型）

客户端模式用法（macOS / Linux / Git Bash；沙箱模式见 SKILL.md §调用方式与运行模式）：
    printf '%s' '<token>' | python3 database/update_database_field.py --token-stdin --database-id "<id>" --field-id "<fid>" --property '<JSON>'
    printf '%s\n%s' '<token>' '{"database_id":"...","field_id":"...","property":{"name":"...","config":{...}}}' | python3 database/update_database_field.py --token-stdin --stdin

行为：
    - POST <API_BASE>/space/api/agent/v1/update-field
      body = {"databaseId": "...", "fieldId": "...", "property": {"name": "...", "config": {...}}}
    - property.name 必填且不能为空；property.config 未传或为空时仅修改名称
    - 修改类型时服务端转换存量数据，无法兼容转换的单元格会被清空
    - 成功 → stdout JSON: {"properties": [...]}
    - 失败 → stdout JSON: {"error": "具体错误描述"}，exit 0
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 复用 library/_common.py 的 token / HTTP / 脱敏 / 静默退出约定。
_SELF_DIR = Path(__file__).resolve().parent
_LIB_DIR = _SELF_DIR.parent
for _p in (str(_SELF_DIR), str(_LIB_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print, unwrap_data  # noqa: E402
from _db_types import VALID_TYPE_KEYS  # noqa: E402

_PATH_UPDATE_FIELD = "/space/api/agent/v1/update-field"


def db_post(url: str, token: str, body: dict, *, timeout: float = 15.0) -> dict:
    """Database POST 封装：发请求 + 解包 {code, msg, data} 信封，失败抛 HttpError。"""
    return unwrap_data(http_request("POST", url, token, body=body, timeout=timeout))


def _read_input(args: argparse.Namespace) -> dict:
    """从参数或 stdin 读取 database_id、field_id 和 property。"""
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
        return data if isinstance(data, dict) else {}

    database_id = (args.database_id or "").strip()
    field_id = (args.field_id or "").strip()
    prop_raw = (args.property or "").strip()
    if not database_id or not field_id or not prop_raw:
        return {}

    try:
        prop = json.loads(prop_raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(prop, dict):
        return {}
    return {"database_id": database_id, "field_id": field_id, "property": prop}


def _validate_property(prop) -> dict | str:
    """规范化 update-field property；名称必填且不能为空。"""
    if not isinstance(prop, dict):
        return "property 必须是对象格式"

    name = prop.get("name", "")
    if not isinstance(name, str):
        return "property.name 必须是字符串"
    name = name.strip()
    if not name:
        return "property.name 必填且不能为空"

    config = prop.get("config", {})
    if not isinstance(config, dict):
        return "property.config 必须是对象"

    # 仅改名时必须省略 config，不能将其编码为 {} 后让服务端
    # 误走“修改类型”分支。
    if not config:
        return {"name": name}

    type_keys = set(config.keys()) & VALID_TYPE_KEYS
    if len(type_keys) != 1:
        return f"property.config 必须且只能包含一种合法类型（{', '.join(sorted(VALID_TYPE_KEYS))}）"
    type_key = next(iter(type_keys))
    return {"name": name, "config": {type_key: config[type_key]}}


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--database-id", dest="database_id", default="")
    parser.add_argument("--field-id", dest="field_id", default="")
    parser.add_argument("--property", default="")
    parser.add_argument("--stdin", action="store_true")
    try:
        args, _ = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    data = _read_input(args)
    if not data:
        error_exit("输入 JSON 为空或格式非法")

    database_id = data.get("database_id", "")
    field_id = data.get("field_id", "")
    if not isinstance(database_id, str) or not isinstance(field_id, str):
        error_exit("database_id 或 field_id 格式非法")
    database_id = database_id.strip()
    field_id = field_id.strip()
    if not database_id or not field_id:
        error_exit("database_id 或 field_id 缺失")

    validated_prop = _validate_property(data.get("property", {}))
    if isinstance(validated_prop, str):
        error_exit(validated_prop)

    body = {
        "databaseId": database_id,
        "fieldId": field_id,
        "property": validated_prop,
    }

    try:
        resp_data = db_post(_common.build_url(_PATH_UPDATE_FIELD), token, body, timeout=15.0)
    except HttpError as e:
        error_exit(f"修改字段请求失败: {e}", traceid=e.traceid)

    properties = resp_data.get("properties")
    if not isinstance(properties, list):
        error_exit("服务端返回的 properties 格式非法")

    safe_print(json.dumps({"properties": properties}, ensure_ascii=False))


if __name__ == "__main__":
    main()
