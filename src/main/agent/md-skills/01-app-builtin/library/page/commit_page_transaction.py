#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/commit_page_transaction.py —— 提交 Page 编辑事务

用法（token 注入见 SKILL.md §调用方式与运行模式）：
    python3 page/commit_page_transaction.py --token-stdin --transaction-id "<tx_id>" --pnid "<data_page_node_id>" --message "更新页面"

行为：
    - POST <API_BASE>/space/api/agent/v1/commit-page-transaction
    - 必须传入 message；pnid 可选，有值时一并提交
    - 成功时 stdout 直接输出服务端 JSON 信封
    - 失败时透传安全错误码，由 SKILL.md 错误码表决定恢复动作
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

API_PATH = "/space/api/agent/v1/commit-page-transaction"


def _post_envelope(token: str, body: dict, *, timeout: float = 30.0) -> dict:
    return http_request(
        "POST", _common.build_url(API_PATH), token, body=body, timeout=timeout
    )


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("--transaction-id", dest="transaction_id", default="")
    parser.add_argument("--pnid", dest="pnid", default="")
    parser.add_argument("--message", dest="message", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    tx_id = (args.transaction_id or "").strip()
    if not tx_id:
        error_exit("transaction_id 缺失")

    pnid = (args.pnid or "").strip()

    message = (args.message or "").strip()
    if not message:
        error_exit("message 缺失")

    body = {"transactionId": tx_id, "message": message}
    if pnid:
        body["pnid"] = pnid

    try:
        envelope = _post_envelope(token, body)
    except HttpError as e:
        error_exit(f"提交 Page 事务失败: {e}", traceid=e.traceid)

    # 业务失败已由公共请求层转为 code + 安全 msg；这里只输出成功信封。
    safe_print(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))

    # 仅在业务成功时追加成品回执行；409/失败不给"成功"话术，避免误导。
    code = envelope.get("code", envelope.get("retcode"))
    if code in (0, "0", "OK", "ok"):
        data = envelope.get("data") or envelope.get("result") or {}
        if isinstance(data, Mapping):
            url = str(data.get("url") or "").strip()
            new_version = data.get("newVersion")
            if url:
                # url 由后端返回，Agent 直接原样透传，禁止自拼。
                safe_print(f"KS_PAGE_COMMIT\t{new_version if new_version is not None else '-'}\t{url}")
                safe_print(f"KS_USER_REPLY\tAgent 已为您完成页面修改，点击查看：{url}")


if __name__ == "__main__":
    main()
