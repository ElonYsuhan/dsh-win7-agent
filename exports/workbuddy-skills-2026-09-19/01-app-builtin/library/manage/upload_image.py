#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
manage/upload_image.py —— 把本地图片上传到资料库图床，返回可直接内嵌 <img> 的公网直链。

设计目标：
- 这是资料库 Agent 侧的「图片上传基础组件能力」，不建资料库节点、不改目录树。
- 后端复用 `internal/app/upload` 域的 `UploadImage`（源自 docx-online mindxupload），
  返回 CDN 匿名可读 URL（`URLPrefix + "/" + cosKey`），与「分享端」保持一致。
- 上层能力（本地 MD 图片重写为在线链接、批量迁移等）应组合本 skill，不重复实现。

链路：
    1. 读取本地图片字节（<= 10 MiB，与后端 MaxImageSize 对齐）；
    2. base64 编码后作为 JSON body 里的 `data` 字段
       （对齐 Go 侧 `UploadImageReq.Data []byte` 的默认 JSON 序列化）；
    3. POST `/space/api/agent/v1/upload-image`；
    4. 成功输出 `KS_IMAGE_UPLOAD_OK <json>`，失败输出结构化错误。

依赖后端接口：`POST /space/api/agent/v1/upload-image`
    - Req  : { data: <base64>, contentType?: string, fileName?: string, url?: string }
    - Rsp  : { url: string, width: int32, height: int32 }
    - 该接口是对已有 `internal/app/upload.Service.UploadImage` 的薄适配挂载.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
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

_PATH_UPLOAD_IMAGE = "/space/api/agent/v1/upload-image"

# 与后端 upload.DefaultImageConfig.MaxImageSize 对齐（10 MiB）；
# 客户端提前拦截，避免把大字节流塞进 JSON body。
MAX_IMAGE_BYTES = 10 * 1024 * 1024
UPLOAD_TIMEOUT = 30.0

# 与后端 upload.contentTypeToExt 覆盖范围一致。
_ALLOWED_EXT = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".bmp", ".svg", ".heic", ".heif", ".tiff",
})


def _read_image(path: str) -> tuple[bytes, int]:
    """读取图片字节；空文件或超限返回空结果，由上层转结构化失败。"""
    try:
        with open(path, "rb") as f:
            content = f.read(MAX_IMAGE_BYTES + 1)
    except (OSError, IOError):
        return b"", 0
    size = len(content)
    if size == 0 or size > MAX_IMAGE_BYTES:
        return b"", 0
    return content, size


def _guess_content_type(file_name: str, path: str) -> str:
    """按 fileName 猜 MIME；猜不到时回空串，交给后端 http.DetectContentType 兜底。"""
    guess, _ = mimetypes.guess_type(file_name or path)
    if guess and guess.startswith("image/"):
        return guess
    return ""


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    _common.register_token_arg(parser)
    parser.add_argument("path", nargs="?", default="")
    parser.add_argument("--file-name", dest="file_name", default="")
    parser.add_argument("--content-type", dest="content_type", default="")
    # 预留：非空时后端走「外链转内链」路径，此时忽略 `path` / `data`。
    parser.add_argument("--url", dest="external_url", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    token = _common.acquire_token()

    external_url = (args.external_url or "").strip()
    body: dict = {}

    if external_url:
        # 外链模式：让后端下载外链图片并转内链（与 docx-online 分享端逻辑一致）。
        body["url"] = external_url
        file_name = (args.file_name or "").strip()
        if file_name:
            body["fileName"] = file_name
        content_type = (args.content_type or "").strip()
        if content_type:
            body["contentType"] = content_type
    else:
        # 本地模式：读字节 → base64 → data 字段。
        path = (args.path or "").strip()
        if not path or not os.path.isfile(path):
            error_exit("图片路径无效或文件不存在")

        content, size = _read_image(path)
        if size == 0:
            error_exit("图片为空或超出大小上限（10 MiB）")

        file_name = (args.file_name or os.path.basename(path)).strip()
        if not file_name:
            error_exit("文件名为空")

        ext = os.path.splitext(file_name)[1].lower()
        if ext and ext not in _ALLOWED_EXT:
            error_exit(f"不支持的图片扩展名: {ext}")

        content_type = (args.content_type or "").strip() or _guess_content_type(file_name, path)

        # Go 侧 `Data []byte` 的 JSON 编码就是 base64（encoding/json 默认行为），
        # 因此 Python 侧只需 b64 编码字节即可精确对齐。
        body["data"] = base64.b64encode(content).decode("ascii")
        body["fileName"] = file_name
        if content_type:
            body["contentType"] = content_type

    try:
        rsp_data = unwrap_data(
            http_request(
                "POST",
                _common.build_url(_PATH_UPLOAD_IMAGE),
                token,
                body=body,
                timeout=UPLOAD_TIMEOUT,
            )
        )
    except HttpError as e:
        error_exit(f"图片上传失败: {e}", traceid=e.traceid)

    url = (rsp_data.get("url") or "").strip()
    if not url:
        error_exit("服务端返回的图片 URL 为空")

    width = int(rsp_data.get("width") or 0)
    height = int(rsp_data.get("height") or 0)

    output = {
        "url": url,
        "width": width,
        "height": height,
    }
    if body.get("fileName"):
        output["file_name"] = body["fileName"]

    safe_print(
        "KS_IMAGE_UPLOAD_OK "
        + json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    )

    if width > 0 and height > 0:
        reply = f"图片已上传，公网直链：{url}（{width}×{height}）"
    else:
        reply = f"图片已上传，公网直链：{url}"
    safe_print(f"KS_USER_REPLY\t{reply}")


if __name__ == "__main__":
    main()
