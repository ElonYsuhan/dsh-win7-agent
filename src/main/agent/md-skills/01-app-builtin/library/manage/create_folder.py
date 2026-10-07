#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""manage/create_folder.py —— 在资料库中创建一个空文件夹（纯容器目录节点）。

Token 注入见 SKILL.md §调用方式与运行模式。

用途：Agent 需要为用户「新建目录 / 建文件夹 / 建分组来组织资料」时使用。
文件夹是纯容器节点，没有正文；建完后可用 move-node 把已有节点挪进去，
或用 create_doc / import-local-file 时把 --parent-id 指向该文件夹。

复用后端 create-doc 接口，通过 nodeKind=folder 区分文档与文件夹：
    POST <API_BASE>/space/api/agent/v1/create-doc
    Body: {"title":"...", "nodeKind":"folder", "spaceId":"...(可选)", "parentId":"...(可选)"}

stdout 协议：
    # 后端确实建成文件夹（返回 nodeKind=folder）：
    KS_FOLDER_CREATE\t<nodeBlockId>\t<nodeKind>\t<url>
    KS_USER_REPLY\t<给用户的回执文案>

    # 后端未把节点建成文件夹（多半是后端尚未支持 nodeKind=folder，按普通文档建了）：
    KS_FOLDER_CREATE_UNEXPECTED\t<nodeBlockId>\t<实际 kind>\t<url>
    {"error":"<脱敏原因，含实际 kind 与链接>"}

失败：stdout 输出单行 JSON {"error":"<脱敏原因>"}，exit 0。

注：
    --space-id 未传时不传 spaceId，使用服务默认创建位置。
    --parent-id 未传时挂到空间顶层。
"""

import argparse
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print, unwrap_data  # noqa: E402

API_PATH = "/space/api/agent/v1/create-doc"
HTTP_TIMEOUT = 30.0
# 与后端 CreateDocByMdxReq.NodeKind 的 folder 取值保持一致。
NODE_KIND_FOLDER = "folder"


class JsonErrorArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        error_exit("参数解析失败")


def _build_parser() -> argparse.ArgumentParser:
    p = JsonErrorArgumentParser(
        description="Create an empty folder (container node) in the knowledge base.",
        add_help=True,
    )
    _common.register_token_arg(p)
    p.add_argument("--title", required=True, help="文件夹名称（必填）。")
    # --space-id 可选：缺省时不传 spaceId，使用服务默认创建位置。
    p.add_argument("--space-id", default="", help="目标空间 ID（可选，缺省用默认空间）。")
    p.add_argument("--parent-id", default="", help="父节点 ID（可选，缺省挂空间顶层）。")
    return p


def _clean_id(v: Optional[str], label: str) -> str:
    s = (v or "").strip()
    if not s:
        return ""
    if any(ch in s for ch in ("/", "?", "#", "\t", "\n", "\r")):
        error_exit(f"{label} 格式非法：请传纯 ID，不要传 URL")
    return s


def _get(data: Mapping[str, Any], *keys: str) -> str:
    for k in keys:
        v = data.get(k)
        if v is not None:
            return str(v).strip()
    return ""


def main(argv: Optional[Iterable[str]] = None) -> None:
    try:
        args = _build_parser().parse_args(list(argv) if argv is not None else None)
    except SystemExit:
        raise

    title = (args.title or "").strip()
    if not title:
        error_exit("title 为空")
    space_id = _clean_id(args.space_id, "space_id") if args.space_id else ""
    parent_id = _clean_id(args.parent_id, "parent_id") if args.parent_id else ""

    # 客户端模式正式提交才需要 token；沙箱模式由 auth-proxy 注入身份。
    token = _common.acquire_token()

    # 文件夹是纯容器，没有正文：固定 nodeKind=folder，不带 content / markdown。
    body: Dict[str, Any] = {"title": title, "nodeKind": NODE_KIND_FOLDER}
    if space_id:
        body["spaceId"] = space_id
    if parent_id:
        body["parentId"] = parent_id

    try:
        envelope = http_request("POST", _common.build_url(API_PATH), token, body=body, timeout=HTTP_TIMEOUT)
        data = unwrap_data(envelope)
    except HttpError as e:
        error_exit(f"创建文件夹失败: {e}", traceid=e.traceid)
        return

    node_id = _get(data, "nodeBlockId", "nodeId")
    if not node_id:
        error_exit("创建接口返回的 nodeBlockId 为空")
    node_kind = _get(data, "nodeKind")
    url = _common.build_url(f"/space/d/{node_id}")

    # 后端真建成 folder 才如实回执；否则不谎报（例如后端未支持 nodeKind=folder
    # 时会按普通文档建节点并返回 nodeKind=doc / 空）。不再无脑兜底成 "folder"，
    # 避免把"实际建成 md 文档"掩盖成"文件夹已创建"。
    if node_kind == NODE_KIND_FOLDER:
        safe_print(f"KS_FOLDER_CREATE\t{node_id}\t{node_kind}\t{url}")
        # 成品回执行：Agent 直接原样透传给用户；url 来自脚本，禁止自拼。
        safe_print(f"KS_USER_REPLY\t文件夹已创建，点击查看：{url}")
        return

    # 兜底：后端没有把节点建成 folder。如实报告真实 kind，提示很可能是
    # 后端尚未支持 nodeKind=folder（把请求按普通文档处理了），供上层判断。
    actual = node_kind or "doc"
    safe_print(f"KS_FOLDER_CREATE_UNEXPECTED\t{node_id}\t{actual}\t{url}")
    error_exit(
        f"创建结果不是文件夹（实际 kind={actual}），"
        f"很可能后端未支持 nodeKind=folder，已按普通文档创建：{url}"
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        error_exit("未预期的异常")
