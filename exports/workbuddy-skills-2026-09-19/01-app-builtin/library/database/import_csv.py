#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
database/import_csv.py —— 导入本地 CSV 文件到 Database

完整链路：
    1. 读取本地 csv 文件 → 计算 size
    2. POST /space/api/agent/v1/get-upload-credential 申请 COS 临时上传链接
    3. 用 HTTP PUT 把文件二进制上传到 uploadUrl
    4. POST /space/api/agent/v1/import-local-file 触发服务端创建/更新 database；
       响应包含 nodeBlockId、url
    5. 成功 → stdout 输出 JSON，exit 0
       JSON 含 node_block_id、file_name、url；
       失败 → stdout 单行 {"error":"<msg>"} 后 exit 0（不暴露 token / 中间响应）

用法（macOS / Linux / Git Bash；token 注入见 SKILL.md §调用方式与运行模式）：
    python3 database/import_csv.py --token-stdin <path-to-local.csv>
    python3 database/import_csv.py --token-stdin <path-to-local.csv> --file-name "自定义文件名.csv"
    python3 database/import_csv.py --token-stdin <path-to-local.csv> --database-id <existing_database_id>
    python3 database/import_csv.py --token-stdin <path-to-local.csv> --space-id <target_space_id>
    python3 database/import_csv.py --token-stdin <path-to-local.csv> --parent-id <target_parent_node_id>

约定:
    - <path> 必须是**已存在的单个文件**且后缀为 .csv；非该后缀直接 exit 0
    - --file-name 缺省时取 path 的 basename，作为透传给后端的展示名
    - --database-id 可选，指定已有 Database ID（重导入覆盖）
    - --space-id 可选；由 Skill 按显式目标解析后传入，缺省落我的文档
    - --parent-id 可选
    - 任一步业务异常一律输出结构化错误 JSON 后 exit 0
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# 复用 library/_common.py 的 token / HTTP / 脱敏 / 失败出口约定。
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

# 单次允许上传的最大文件大小（字节），与后端 cos 配置保持一个数量级；
# 超出直接静默退出，避免长时阻塞与超大请求体。
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MiB

# COS PUT 上传超时（秒）；与本地网络条件相关，给一个相对宽松的值。
PUT_TIMEOUT = 60

# 允许的本地文件扩展名（小写）。
_ALLOWED_EXTS = (".csv",)


def _file_meta(path: str) -> tuple:
    """读取文件内容并返回 (content, size)；任何异常 → (b"", 0) 由调用方按失败处理。"""
    try:
        with open(path, "rb") as f:
            content = f.read(MAX_UPLOAD_BYTES + 1)
    except (OSError, IOError):
        return b"", 0
    size = len(content)
    if size == 0 or size > MAX_UPLOAD_BYTES:
        return b"", 0
    return content, size


def _put_to_cos(upload_url: str, body: bytes) -> bool:
    """把文件二进制 PUT 到 COS 预签名 URL；2xx 视为成功。"""
    if not upload_url or not body:
        return False
    req = urllib.request.Request(
        url=upload_url,
        data=body,
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
    except Exception:  # noqa: BLE001 - 任何意外都静默
        return False


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("path", nargs="?", default="")
    parser.add_argument("--file-name", dest="file_name", default="")
    parser.add_argument("--database-id", dest="database_id", default="")
    parser.add_argument("--space-id", dest="space_id", default="")
    parser.add_argument("--parent-id", dest="parent_id", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    # 读取 token（必须在读 stdin 之前，因为 --token-stdin 从 stdin 读首行）
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
    ext = os.path.splitext(file_name)[1].lower()
    if ext not in _ALLOWED_EXTS:
        error_exit(f"不支持的文件扩展名: {ext}（仅支持 .csv）")

    target_space_id = (args.space_id or "").strip()
    target_parent_id = (args.parent_id or "").strip()
    existing_database_id = (args.database_id or "").strip()

    # ---- Step 1: 获取上传凭证 ----
    credential_body: dict = {
        "fileName": file_name,
        "fileSize": size,
    }
    if target_parent_id or target_space_id:
        credential_body["parentId"] = target_parent_id or target_space_id
    try:
        cred_data = unwrap_data(
            http_request(
                "POST",
                _common.build_url(_PATH_GET_UPLOAD_CREDENTIAL),
                token,
                body=credential_body,
                timeout=8.0,
            )
        )
    except HttpError as e:
        error_exit(f"获取上传凭证失败: {e}")

    upload_url = (cred_data.get("uploadUrl") or "").strip()
    cos_key = (cred_data.get("cosKey") or "").strip()
    if not upload_url or not cos_key:
        error_exit("上传凭证响应缺少 uploadUrl 或 cosKey")

    # ---- Step 2: PUT 上传文件到 COS ----
    if not _put_to_cos(upload_url, content):
        error_exit("文件上传到 COS 失败")

    # ---- Step 3: 触发导入 ----
    import_body: dict = {
        "cosKey": cos_key,
        "fileName": file_name,
    }

    # --space-id
    if target_space_id:
        import_body["spaceId"] = target_space_id

    # --parent-id
    if target_parent_id:
        import_body["parentId"] = target_parent_id

    # --database-id（重导入：非空时覆盖更新该 database，留空则新建）
    if existing_database_id:
        import_body["nodeBlockId"] = existing_database_id

    # 可选 title：默认用文件名去掉扩展名
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
        error_exit(f"导入文件请求失败: {e}")

    node_block_id = (import_data.get("nodeBlockId") or "").strip()
    if not node_block_id:
        error_exit("服务端返回的 nodeBlockId 为空")

    url = (import_data.get("url") or "").strip()
    publish_url = (import_data.get("publishUrl") or "").strip()

    output = {
        "node_block_id": node_block_id,
        "file_name": file_name,
        "url": url,
        "publish_url": publish_url,
    }
    safe_print(
        "KS_IMPORT_OK "
        + json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    )


if __name__ == "__main__":
    main()
