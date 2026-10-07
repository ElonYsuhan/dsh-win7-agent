#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
manage/get_node_comments.py —— 拉取资料库节点的普通用户评论（kind=comment）。

Token 注入见 SKILL.md §调用方式与运行模式。

供 Agent 在感知到「根据评论修改文档 / 页面」类 prompt 时，拉取评论上下文
（锚点 blockId + 楼层纯文本），再结合 doc / page 对应的最新内容读取结果
决策如何生成后续编辑动作。

注意：nodeId 与 pageId 完全等价，是同一个 ID 的两种叫法。
传给 --node-id 的值与传给 get_doc_reviews.py --page-id 的值相同。

接口：
    POST <API_BASE>/space/api/agent/v1/get-node-comments
Header: 客户端模式由脚本加 X-Skill-Token；沙箱模式由 auth-proxy 注入身份
    Body  : {"nodeId":"...(即 pageId)", "discussionId":"...(可选)", "includeResolved": false}

stdout 协议：
    KS_DOC_COMMENTS\t<nodeId>\t<totalThreads>
    <threads JSON 数组文本>

threads 数组结构：
    [
      {
        "discussionId": "disc_xxx",
        "blockId": "blk_xxx",        # 评论锚点 block id
        "resolved": false,
        "commentType": "inline",     # "inline"=划词评论 / "block"=块评论
        "anchorText": "这里措辞",    # 划词评论时被选中的原文；块评论时为空字符串
        "props": {                   # 锚点扩展信息；例如 pageAnchors
          "pageAnchors": [
            {
              "pnid": "page_node_id",
              "selector": "h1[data-page-node-id=\"page_node_id\"]",
              "tag": "h1",
              "textContent": "标题"
            }
          ]
        },
        "comments": [
          {
            "commentId": "cmt_xxx",
            "authorId": "uid_xxx",
            "plainText": "这里措辞需要改",
            "createdAt": 1700000000000
          }
        ]
      }
    ]

失败：stdout 输出单行 JSON {"error":"<脱敏原因>"}，exit 0。
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable, Optional

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print, unwrap_data  # noqa: E402

API_PATH = "/space/api/agent/v1/get-node-comments"
HTTP_TIMEOUT = 15.0


class JsonErrorArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        error_exit("参数解析失败")


def _build_parser() -> argparse.ArgumentParser:
    parser = JsonErrorArgumentParser(
        description="Fetch user comments on a knowledge-base node for Agent context.",
        add_help=True,
    )
    _common.register_token_arg(parser)
    parser.add_argument("--node-id", required=True, help="Knowledge-base node id；doc 中与 pageId 完全等价。")
    parser.add_argument(
        "--discussion-id",
        default="",
        help="Optional: return only this single comment thread.",
    )
    parser.add_argument(
        "--include-resolved",
        action="store_true",
        default=False,
        help="Include resolved comment threads (default: active only).",
    )
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

    node_id = _normalize_id(args.node_id)
    if not node_id:
        error_exit("node_id 缺失或格式非法")

    discussion_id = _normalize_id(args.discussion_id) if args.discussion_id else ""

    body: dict = {"nodeId": node_id}
    if discussion_id:
        body["discussionId"] = discussion_id
    if args.include_resolved:
        body["includeResolved"] = True

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
        error_exit(f"获取评论失败: {e}", traceid=e.traceid)
        return

    threads = data.get("threads")
    total = data.get("totalThreads", 0)

    if not isinstance(threads, list):
        error_exit("响应中 threads 字段格式非法")

    safe_print(f"KS_DOC_COMMENTS\t{node_id}\t{total}")
    try:
        out = json.dumps(threads, ensure_ascii=False, indent=2)
        encoded = out.encode("utf-8", errors="replace")
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.write(b"\n")
    except Exception:
        error_exit("输出 threads 失败")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        error_exit("未预期的异常")
