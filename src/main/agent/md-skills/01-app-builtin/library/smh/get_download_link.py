#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
smh/get_download_link.py —— 按节点 ID 拿资料库文件下载链接。

链路（用法与参数见 smh/entry.md）：
    1. get-drive-file 换取预签名下载 URL
    2. 成功 → `KS_SMH_DOWNLOAD <json>`(node_id/file_name/ext/download_url)；
       失败 → `{"error":...}` 后 exit 0（不暴露 token / 完整签名 URL）
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
from _common import (  # noqa: E402
    HttpError,
    error_exit,
    http_request,
    safe_print,
    unwrap_data,
)

_PATH = "/space/api/agent/v1/get-drive-file"


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
        error_exit("--node-id 必填")

    # 该接口响应不是标准 {code,data} 信封，而是直接对象；http_request 已经把
    # 直接对象包装为 {data:<对象>} 形态，再经 unwrap_data 取出 data 即可。
    try:
        data = unwrap_data(
            http_request(
                "POST",
                _common.build_url(_PATH),
                token,
                body={"nodeId": node_id},
                timeout=10.0,
            )
        )
    except HttpError as e:
        error_exit(f"获取下载链接失败: {e}")

    out = {
        "node_id": (data.get("nodeId") or node_id).strip(),
        "file_name": (data.get("fileName") or "").strip(),
        "ext": (data.get("ext") or "").strip(),
        "download_url": (data.get("downloadUrl") or "").strip(),
    }
    if not out["download_url"]:
        error_exit("服务端返回的 downloadUrl 为空")

    safe_print(
        "KS_SMH_DOWNLOAD "
        + json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    )

    # 成品回执行：download_url 是短期签名，禁止在用户回复中原样展开。
    fn = out["file_name"] or "该文件"
    safe_print(f"KS_USER_REPLY\t已取到「{fn}」的下载链接（短期有效），如需保存请及时下载。")


if __name__ == "__main__":
    main()
