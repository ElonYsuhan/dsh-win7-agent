#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doc/get_doc_reviews.py —— 读取资料库在线文档为带审阅摘要的 content。

Token 注入见 SKILL.md §调用方式与运行模式。

接口：
    POST <API_BASE>/space/api/agent/v1/get-doc-review
Header: 客户端模式由脚本加 X-Skill-Token；沙箱模式由 auth-proxy 注入身份
    Body  : {"pageId":"..."}

stdout 协议：
    KS_DOC_REVIEWS\t<pageId>\t<byteSize>\t<url>
    <content 文本原文>

失败：stdout 输出单行 JSON {"error":"<脱敏原因>"}，exit 0。
"""

import argparse
import sys
from pathlib import Path
from typing import Iterable, Optional

# 复用 library/_common.py 的 token / HTTP / 脱敏 / 统一失败协议。
_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print, unwrap_data  # noqa: E402

API_PATH = "/space/api/agent/v1/get-doc-review"
HTTP_TIMEOUT = 15.0


class JsonErrorArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        error_exit("参数解析失败")


def _build_parser() -> argparse.ArgumentParser:
    parser = JsonErrorArgumentParser(
        description="Read a knowledge-base doc as content with agent review summary.",
        add_help=True,
    )
    _common.register_token_arg(parser)
    parser.add_argument("--page-id", required=True, help="Doc/page node id.")
    parser.add_argument("--output-mode", default="", help="Reserved output mode; normally empty.")
    parser.add_argument("--page-type", default="", help="Reserved page type; normally empty.")
    return parser


def _normalize_id(raw: Optional[str]) -> str:
    if not isinstance(raw, str):
        return ""
    v = raw.strip()
    if not v or any(ch in v for ch in ("/", "?", "#", "\t", "\n", "\r")):
        return ""
    return v


def main(argv: Optional[Iterable[str]] = None) -> None:
    parser = _build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit:
        raise

    token = _common.acquire_token()

    page_id = _normalize_id(args.page_id)
    if not page_id:
        error_exit("page_id 缺失或格式非法")

    body = {
        "pageId": page_id,
    }
    if args.output_mode:
        body["outputMode"] = str(args.output_mode)
    if args.page_type:
        body["pageType"] = str(args.page_type)

    try:
        envelope = http_request(
            "POST",
            _common.build_url(API_PATH),
            token,
            body=body,
            timeout=HTTP_TIMEOUT,
        )
        data = unwrap_data(envelope)
    except HttpError as e:
        error_exit(f"获取文档审阅内容失败: {e}", traceid=e.traceid)
        return

    content = data.get("content")
    if content is None:
        content = ""
    if not isinstance(content, str):
        error_exit("响应中 content 字段格式非法")

    encoded = content.encode("utf-8", errors="replace")
    url = _common.build_public_url(f"/space/d/{page_id}")
    safe_print(f"KS_DOC_REVIEWS\t{page_id}\t{len(encoded)}\t{url}")
    try:
        sys.stdout.buffer.write(encoded)
        if content and not content.endswith("\n"):
            sys.stdout.buffer.write(b"\n")
    except Exception:
        error_exit("输出 content 失败")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        error_exit("未预期的异常")
