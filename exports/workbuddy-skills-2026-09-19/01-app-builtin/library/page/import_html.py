#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/import_html.py —— 导入本地 HTML / ZIP 文件到资料库

完整链路：
    1. 读取本地 html / zip 文件 → 计算 size
    2. 智能命名兜底（仅 html 路径）：当最终 file_name 缺乏语义（如 index/default/UUID 等，
       不论是用户显式传 --file-name 还是来自本地 basename），从 HTML <title>/<h1>
       抠语义名替换；用户传入的有语义名保持不动。zip 路径跳过本兜底（zip 是二进制包，
       且可能含多个 html 入口，无法稳定抠出单一语义名）。
    3. POST /space/api/agent/v1/get-upload-credential 申请 COS 临时上传链接
    4. 用 HTTP PUT 把文件二进制上传到 uploadUrl
    5. POST /space/api/agent/v1/import-local-file 触发服务端创建/更新 page；
       响应包含 nodeBlockId、url
    6. 成功 → stdout 输出一行 "KS_IMPORT_OK <JSON>"，exit 0
       JSON 含 node_block_id、file_name、url；
       失败 → stdout 单行 {"error":"<msg>"} 后 exit 0（不暴露 token / 中间响应）

用法（macOS / Linux / Git Bash；token 注入见 SKILL.md §调用方式与运行模式）：
    python3 page/import_html.py --token-stdin <path-to-local.html>
    python3 page/import_html.py --token-stdin <path-to-local.zip>
    python3 page/import_html.py --token-stdin <path-to-local.html> --file-name "自定义文件名.html"
    python3 page/import_html.py --token-stdin <path-to-local.html> --databases '[{"id":"db_xxx"}]'
    python3 page/import_html.py --token-stdin <path-to-local.html> --node-block-id <existing_node_block_id>
    python3 page/import_html.py --token-stdin <path-to-local.html> --space-id <target_space_id>
    python3 page/import_html.py --token-stdin <path-to-local.html> --parent-id <target_parent_node_id>

约定:
    - <path> 必须是**已存在的单个文件**且后缀为 .html / .htm / .zip；非该后缀直接 exit 0
    - **目录场景**：本脚本不直接接受目录路径（os.path.isfile 校验拦截）。如果用户给的是
      文件夹，由 agent 工作流在调用本脚本之前先把目录压缩成 zip。
    - .zip 路径要求压缩包内至少含一个 .html / .htm 入口文件 + 同包资源
    - --file-name 缺省时取 path 的 basename，作为透传给后端的展示名
    - --databases 可选，JSON 数组字符串，每个元素包含 id 字段
    - --node-block-id 可选，**重导入定位字段**（对应旧 --file-id 语义）
    - --space-id 可选；由 Skill 按显式目标解析后传入，缺省落我的文档
    - --parent-id 可选
    - 任一步业务异常一律输出结构化错误 JSON 后 exit 0
"""

from __future__ import annotations

import argparse
import json
import os
import re
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
_ALLOWED_EXTS = (".html", ".htm", ".zip")
_ZIP_EXT = ".zip"

# 缺乏语义的文件名模式（不含扩展名）
_NON_SEMANTIC_PATTERNS = re.compile(
    r"^(index|default|page|untitled|temp|tmp|new|test"
    r"|[0-9a-f]{8,}"         # hex 随机串（如 UUID 片段）
    r"|[a-z0-9]{1,3}"        # 极短无意义名
    r"|[0-9]+)$",            # 纯数字
    re.IGNORECASE,
)

# 下载器/系统常见的重复文件后缀模式（循环剥离）
_DOWNLOAD_SUFFIX = re.compile(
    r"(\s*\(\d+\)"          # " (2)", "(1)"
    r"|\s*-\s*副本"          # " - 副本"
    r"|\s*copy\s*\d*"       # " copy", " copy2"
    r"|_\d+)$",             # "_1", "_02"
    re.IGNORECASE,
)


def _is_non_semantic(name: str) -> bool:
    """判断文件名（不含扩展名）是否缺乏语义。"""
    stem = os.path.splitext(name)[0].strip()
    if not stem:
        return True
    # 循环剥离下载器/系统副本后缀：index (2) → index
    while True:
        m = _DOWNLOAD_SUFFIX.search(stem)
        if not m:
            break
        stem = stem[:m.start()].strip()
    if not stem:
        return True
    return bool(_NON_SEMANTIC_PATTERNS.match(stem))


def _extract_title_from_html(content: bytes) -> str:
    """从 HTML 内容中提取 <title> 标签文本；提取失败返回空字符串。"""
    try:
        # 只解析前 64KB 即可找到 title
        head = content[:65536].decode("utf-8", errors="replace")
    except Exception:
        return ""
    m = re.search(r"<title[^>]*>(.*?)</title>", head, re.IGNORECASE | re.DOTALL)
    if not m:
        return ""
    title = m.group(1).strip()
    # 去掉 HTML 实体和多余空白
    title = re.sub(r"&[^;]+;", " ", title)
    title = re.sub(r"\s+", " ", title).strip()
    # 过滤掉过长或无意义的 title
    if not title or len(title) > 80:
        return ""
    return title


def _extract_semantic_name(content: bytes) -> str:
    """尝试从 HTML 内容生成语义文件名。

    策略：
    1. 优先提取 <title> 标签
    2. 若无 title，提取第一个 <h1> 标签文本
    3. 若均失败，返回空字符串（调用方降级使用原文件名）
    """
    # 策略 1：<title>
    title = _extract_title_from_html(content)
    if title:
        return title

    # 策略 2：第一个 <h1>
    try:
        head = content[:131072].decode("utf-8", errors="replace")
    except Exception:
        return ""
    m = re.search(r"<h1[^>]*>(.*?)</h1>", head, re.IGNORECASE | re.DOTALL)
    if m:
        h1 = re.sub(r"<[^>]+>", "", m.group(1))  # 去内嵌标签
        h1 = re.sub(r"\s+", " ", h1).strip()
        if h1 and len(h1) <= 80:
            return h1

    return ""


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
    parser.add_argument("--databases", dest="databases", default="")
    parser.add_argument("--node-block-id", dest="node_block_id", default="")
    parser.add_argument("--space-id", dest="space_id", default="")
    parser.add_argument("--parent-id", dest="parent_id", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    database_ref = []
    if args.databases:
        try:
            parsed = json.loads(args.databases)
        except json.JSONDecodeError:
            error_exit("databases JSON 格式非法")
        if not isinstance(parsed, list):
            error_exit("databases 必须是 JSON 数组")
        for item in parsed:
            if not isinstance(item, dict) or not item.get("id"):
                error_exit("databases 每一项都必须包含 id")
            database_ref.append({"id": item["id"]})

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
        error_exit(f"不支持的文件扩展名: {ext}（仅支持 .html / .htm / .zip）")

    # 智能命名兜底：仅对 .html / .htm 单文件链路生效。
    if ext != _ZIP_EXT and _is_non_semantic(file_name):
        semantic = _extract_semantic_name(content)
        if semantic and not _is_non_semantic(semantic + ext):
            file_name = semantic + ext

    target_space_id = (args.space_id or "").strip()
    target_parent_id = (args.parent_id or "").strip()
    existing_node_block_id = (args.node_block_id or "").strip()

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

    # --node-block-id（重导入：非空时覆盖更新该节点内容，留空则新建）
    if existing_node_block_id:
        import_body["nodeBlockId"] = existing_node_block_id

    if database_ref:
        import_body["databaseRef"] = database_ref

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
