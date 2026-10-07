#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
drive/upload_drive_file.py —— 把本地文件上传到资料库网盘，新建或覆盖网盘文件节点。

链路（用法与参数见 drive/entry.md）：
    1. get-upload-credential 获取网盘直传的 URL、headers 与 confirmKey；
    2. 携带返回的 headers 直接 PUT 文件二进制；
    3. import-local-file 传 confirmKey，由服务端确认并创建/更新 drive 节点；
    4. 成功输出 `KS_DRIVE_UPLOAD_OK <json>`；失败输出结构化错误。

本脚本不使用 cosKey 中转，不回退 SMH 节点。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
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

_PATH_GET_UPLOAD_CREDENTIAL = "/space/api/agent/v1/get-upload-credential"
_PATH_IMPORT_LOCAL_FILE = "/space/api/agent/v1/import-local-file"
_UPLOAD_TYPE_DRIVE = "drive"

# 客户端当前以单次内存 PUT 上传，保留稳妥上限；服务端配额可能更高。
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MiB
PUT_TIMEOUT = 120


def _file_meta(path: str) -> tuple[bytes, int]:
    """读取文件并返回 (content, size)；读取失败、空文件或超限时返回空结果。"""
    try:
        with open(path, "rb") as f:
            content = f.read(MAX_UPLOAD_BYTES + 1)
    except (OSError, IOError):
        return b"", 0
    size = len(content)
    if size == 0 or size > MAX_UPLOAD_BYTES:
        return b"", 0
    return content, size


def _put_to_drive(upload_url: str, headers: dict[str, str], body: bytes) -> bool:
    """携带服务端返回的直传 headers 执行 PUT；不注入 WorkBuddy 鉴权头。"""
    if not upload_url or not headers or not body:
        return False
    req = urllib.request.Request(
        url=upload_url,
        data=body,
        headers=headers,
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=PUT_TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        OSError,
        ValueError,
    ):
        return False
    except Exception:  # noqa: BLE001 - 统一转结构化失败
        return False


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("path", nargs="?", default="")
    parser.add_argument("--file-name", dest="file_name", default="")
    parser.add_argument("--space-id", dest="space_id", default="")
    parser.add_argument("--parent-id", dest="parent_id", default="")
    parser.add_argument("--node-id", dest="node_id", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    path = (args.path or "").strip()
    if not path or not os.path.isfile(path):
        error_exit("文件路径无效或文件不存在")

    content, size = _file_meta(path)
    if size == 0:
        error_exit("文件为空或超出大小上限")

    file_name = (args.file_name or os.path.basename(path)).strip()
    if not file_name:
        error_exit("文件名为空")

    ext = os.path.splitext(file_name)[1].lstrip(".").lower()
    target_space_id = (args.space_id or "").strip()
    target_parent_id = (args.parent_id or "").strip()
    target_node_id = (args.node_id or "").strip()

    cred_body: dict = {"fileName": file_name, "fileSize": size}
    if target_node_id:
        cred_body["nodeBlockId"] = target_node_id
    if target_parent_id or target_space_id:
        # spaceId 可作为根目录锚点，确保上传凭证与最终导入目标一致。
        cred_body["parentId"] = target_parent_id or target_space_id

    try:
        cred_data = unwrap_data(
            http_request(
                "POST",
                _common.build_url(_PATH_GET_UPLOAD_CREDENTIAL),
                token,
                body=cred_body,
                timeout=8.0,
            )
        )
    except HttpError as e:
        error_exit(f"获取网盘上传凭证失败: {e}")

    upload_url = (cred_data.get("uploadUrl") or "").strip()
    upload_type = (cred_data.get("uploadType") or "").strip().lower()
    upload_headers = cred_data.get("headers")
    confirm_key = (cred_data.get("confirmKey") or "").strip()
    task_id = (cred_data.get("taskId") or "").strip()

    if upload_type != _UPLOAD_TYPE_DRIVE:
        error_exit("该文件类型不走网盘上传，请使用对应资料库模块")
    if (
        not upload_url
        or not isinstance(upload_headers, dict)
        or not upload_headers
        or not confirm_key
    ):
        error_exit("当前账号尚未开放网盘上传")
    if not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in upload_headers.items()
    ):
        error_exit("网盘上传凭证格式无效")

    if not _put_to_drive(upload_url, upload_headers, content):
        error_exit("文件直传到网盘失败")

    import_body: dict = {
        "confirmKey": confirm_key,
        "fileName": file_name,
        "fileSize": size,
    }
    if task_id:
        import_body["taskId"] = task_id
    if target_space_id:
        import_body["spaceId"] = target_space_id
    if target_parent_id:
        import_body["parentId"] = target_parent_id
    if target_node_id:
        import_body["nodeBlockId"] = target_node_id

    title = os.path.splitext(file_name)[0].strip()
    if title:
        import_body["title"] = title

    try:
        import_data = unwrap_data(
            http_request(
                "POST",
                _common.build_url(_PATH_IMPORT_LOCAL_FILE),
                token,
                body=import_body,
                timeout=30.0,
            )
        )
    except HttpError as e:
        error_exit(f"导入网盘文件失败: {e}")

    node_block_id = (import_data.get("nodeBlockId") or "").strip()
    node_kind = (import_data.get("nodeKind") or "").strip().lower()
    if not node_block_id:
        error_exit("服务端返回的 nodeBlockId 为空")
    if target_node_id and node_block_id != target_node_id:
        error_exit("服务端未覆盖目标网盘文件节点")
    if node_kind and node_kind != "drive":
        error_exit("服务端未创建网盘文件节点")

    url = (import_data.get("url") or "").strip()
    output = {
        "node_block_id": node_block_id,
        "file_name": file_name,
        "ext": ext,
        "url": url,
    }
    safe_print(
        "KS_DRIVE_UPLOAD_OK "
        + json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    )

    action = "更新" if target_node_id else "上传"
    if url:
        reply = f"文件「{file_name}」已{action}到网盘，点击查看：{url}"
    else:
        reply = f"文件「{file_name}」已{action}到网盘。"
    safe_print(f"KS_USER_REPLY\t{reply}")


if __name__ == "__main__":
    main()
