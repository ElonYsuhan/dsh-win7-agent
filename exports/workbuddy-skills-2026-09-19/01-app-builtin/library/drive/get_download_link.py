#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
drive/get_download_link.py —— 按节点 ID 拿网盘文件下载链接（仅网盘文件节点适用）

完整链路：
    1. POST /space/api/agent/v1/get-drive-file
    2. 成功 → stdout 输出 `KS_DRIVE_DOWNLOAD <json>`，exit 0
       JSON 含 node_id、file_name、ext、download_url；
       失败 → stdout 单行 {"error":"<msg>"} 后 exit 0（不暴露 token / 完整签名 URL）

用法（token 注入见 SKILL.md §调用方式与运行模式）：
    python3 drive/get_download_link.py --token-stdin --node-id <blk_xxx>

约定：
    - 仅网盘文件节点可用；类型不确定时调用方先调 space.workspace.node-info 仲裁（node.kind == "drive"）
    - downloadUrl 是 COS 预签名 URL，短期有效；不要在用户回执中原样回显完整签名
    - 失败一律输出结构化错误 JSON 后 exit 0
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
        "KS_DRIVE_DOWNLOAD "
        + json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    )

    # 成品回执行：download_url 是短期 COS 签名，禁止在用户回复中原样展开（entry.md §2）。
    # 因此回执只给文件名话术，签名 URL 仅供 Agent 立即直拉文件字节使用。
    fn = out["file_name"] or "该文件"
    safe_print(f"KS_USER_REPLY\t已取到「{fn}」的下载链接（短期有效），如需保存请及时下载。")


if __name__ == "__main__":
    main()
