#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Create or fully overwrite a knowledge-base doc node from Markdown content.

Token 注入见 SKILL.md §调用方式与运行模式。

Endpoint (apispec / agent-preview form):
    POST <API_BASE>/space/api/agent/v1/create-doc

stdout:
    # 正式新建或全量覆盖成功（末两列为内容结果统计：未完成数 / 严重错误数）
    KS_DOC_CREATE\t<nodeBlockId>\t<nodeKind>\t<url>\t<failedCount>\t<fatalCount>
    # 仅当 failedCount>0 或 fatalCount>0 时，追加一行 JSON 细节：
    {"failedCmdIds":[...],"fatalCmdIds":[...]}

    # --dry-run 成功（纯本地校验，不取缺省空间、不发任何 HTTP）
    KS_DOC_CREATE_DRYRUN\t<contentBytes>\tcontent=ok
    {"dryRun":true,"mode":"create|overwrite","title":"...","contentBytes":N,"contentField":"markdown","spaceId":"...","parentId":"...","nodeBlockId":"..."}

失败：stdout 输出单行 JSON {"error":"<脱敏原因>"}，exit 0。

注：--dry-run 不发 HTTP、不需要 token——正式新建或覆盖前可离线校验 Agent 生成的 Markdown
    及模式参数是否满足基本约束（非空、UTF-8、大小上限）。
    脚本只按 markdown 字段提交；新建与覆盖场景都不支持 WorkBuddy 组件 content。
    Markdown 已支持的语法直接写 Markdown，不要为了普通标题、列表、代码块、表格、Mermaid 等改写成组件。
    若检测到 WorkBuddy 组件标签（如 Paragraph / Callout / Table / Mermaid），脚本会拒绝提交；组件语法仅用于编辑 / 修订链路。

注：新建时 --title 可省略，为空时使用兜底标题「未命名文档」（与 api-manifest.json 中 title 非必填对齐）；
    覆盖时 --title 可省略且不会修改既有标题。

注：新建时 --space-id 未传则使用服务默认创建位置；覆盖时必须同时传
    --node-block-id 与目标实际 --space-id。覆盖保留节点 ID、链接和标题，但替换
    整棵正文块树；目标不存在、跨空间或非 doc 时不得降级新建。
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import _common  # noqa: E402
from _common import HttpError, error_exit, http_request, safe_print, unwrap_data  # noqa: E402

API_PATH = "/space/api/agent/v1/create-doc"
HTTP_TIMEOUT = 60.0
CONTENT_MAX_BYTES = 50 * 1024 * 1024
# 新建时 title 为空的兜底标题：api-manifest.json 中 title 非必填，脚本不因缺省标题拒绝调用。
DEFAULT_TITLE = "未命名文档"
_FORBIDDEN_COMPONENT_TAG_RE = re.compile(
    r"<\s*/?\s*(?:Paragraph|Heading|BlockQuote|Callout|Divider|Image|Todo|"
    r"BulletedList|NumberedList|MathBlock|Code|Mermaid|Table|TableRow|TableCell|Mark|Link|"
    r"ReviewSummary|ReviewCard)\b"
)
_FENCED_CODE_BLOCK_RE = re.compile(r"(?ms)^[ \t]{0,3}(```|~~~).*?^[ \t]{0,3}\1[^\r\n]*(?:\r?\n|$)")
_INLINE_CODE_RE = re.compile(r"`[^`\r\n]*`")


def _content_for_component_scan(content: str) -> str:
    """移除 Markdown 代码示例后再扫描组件标签，避免误拒代码块里的字面量。"""
    return _INLINE_CODE_RE.sub("", _FENCED_CODE_BLOCK_RE.sub("", content))


class JsonErrorArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        error_exit("参数解析失败")


def _build_parser() -> argparse.ArgumentParser:
    p = JsonErrorArgumentParser(description="Create or fully overwrite a knowledge-base doc by Markdown content.", add_help=True)
    _common.register_token_arg(p)
    p.add_argument("--title", default="", help=f"可选；新建时为空则使用兜底标题「{DEFAULT_TITLE}」，覆盖时省略不会修改既有标题。")
    p.add_argument("--dry-run", action="store_true",
                   help="本地校验 Markdown 并打印摘要，不取缺省空间、不发 HTTP、不需要 token。")
    # 新建时 --space-id 可省略；覆盖时必须与 --node-block-id 同时提供。
    p.add_argument("--space-id", default="")
    p.add_argument("--parent-id", default="", help="仅新建模式有效。")
    p.add_argument("--node-block-id", default="", help="既有 Doc 节点 ID；非空时全量覆盖正文。")
    p.add_argument("--confirm-overwrite", action="store_true",
                   help="确认用户已明确同意清空并全量替换目标文档正文；正式覆盖时必填。")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--content")
    g.add_argument("--content-file")
    return p


def _clean_id(v: Optional[str], label: str) -> str:
    s = (v or "").strip()
    if not s:
        return ""
    if any(ch in s for ch in ("/", "?", "#", "\t", "\n", "\r")):
        error_exit(f"{label} 格式非法：请传纯 ID，不要传 URL")
    return s


def _read_content(args: argparse.Namespace) -> str:
    if args.content is not None:
        return args.content
    try:
        return Path(args.content_file).read_text(encoding="utf-8")
    except OSError:
        error_exit("读取 content-file 失败")
    except UnicodeError:
        error_exit("content-file 编码失败")
    return ""


def _id_list(data: Mapping[str, Any], key: str) -> List[str]:
    """从响应里安全提取一个 cmdId 列表；非 list / 非字符串元素一律丢弃。"""
    raw = data.get(key)
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for it in raw:
        s = str(it).strip() if it is not None else ""
        if s:
            out.append(s)
    return out


def main(argv: Optional[Iterable[str]] = None) -> None:
    try:
        args = _build_parser().parse_args(list(argv) if argv is not None else None)
    except SystemExit:
        raise

    title = (args.title or "").strip()
    space_id = _clean_id(args.space_id, "space_id") if args.space_id else ""
    parent_id = _clean_id(args.parent_id, "parent_id") if args.parent_id else ""
    node_block_id = _clean_id(args.node_block_id, "node_block_id") if args.node_block_id else ""
    overwrite = bool(node_block_id)
    content = _read_content(args)

    # --- 本地校验（dry-run 与正式提交共用，先于任何网络动作）---
    if not content:
        error_exit("content 为空")
    if not overwrite and not title:
        # 与 api-manifest.json 保持一致：title 非必填，缺省时兜底而不是拒绝调用。
        title = DEFAULT_TITLE
    if overwrite and not space_id:
        error_exit("全量覆盖文档时 space_id 不能为空")
    if overwrite and parent_id:
        error_exit("全量覆盖文档时不能传 parent_id")
    if overwrite and not args.dry_run and not args.confirm_overwrite:
        error_exit("全量覆盖文档前必须取得用户明确确认，并传 --confirm-overwrite")
    if not overwrite and args.confirm_overwrite:
        error_exit("--confirm-overwrite 只能与 --node-block-id 同时使用")
    try:
        content_bytes = len(content.encode("utf-8"))
    except Exception:
        error_exit("content 编码失败")
        return
    if content_bytes > CONTENT_MAX_BYTES:
        error_exit(f"content 超出大小上限（{content_bytes} bytes > {CONTENT_MAX_BYTES} bytes）")
    if _FORBIDDEN_COMPONENT_TAG_RE.search(_content_for_component_scan(content)):
        error_exit("create_doc 只支持 Markdown；组件语法仅用于编辑 / 修订链路")
    content_field = "markdown"

    # --- dry-run：不取缺省空间、不发 HTTP、不需要 token（正式创建前离线自检）---
    if args.dry_run:
        safe_print(f"KS_DOC_CREATE_DRYRUN\t{content_bytes}\tcontent=ok")
        safe_print(json.dumps({
            "dryRun": True,
            "mode": "overwrite" if overwrite else "create",
            "title": title,
            "contentBytes": content_bytes,
            "contentField": content_field,
            "spaceId": space_id,
            "parentId": parent_id,
            "nodeBlockId": node_block_id,
        }, ensure_ascii=False, separators=(",", ":")))
        return

    # 客户端模式正式提交才需要 token；沙箱模式由 auth-proxy 注入身份。收在 _common.acquire_token() 一处，不在各业务脚本前辞重写 check。
    token = _common.acquire_token()

    # create_doc.py 只按 Markdown 字段提交；WorkBuddy 组件语法仅用于编辑 / 修订链路。
    body: Dict[str, Any] = {content_field: content}
    if title:
        body["title"] = title
    if space_id:
        body["spaceId"] = space_id
    if parent_id:
        body["parentId"] = parent_id
    if node_block_id:
        body["nodeBlockId"] = node_block_id

    operation = "全量覆盖文档" if overwrite else "创建文档"
    try:
        envelope = http_request("POST", _common.build_url(API_PATH), token, body=body, timeout=HTTP_TIMEOUT)
        data = unwrap_data(envelope)
    except HttpError as e:
        error_exit(f"{operation}失败: {e}", traceid=e.traceid)
        return

    raw_node_id = data.get("nodeBlockId")
    raw_node_kind = data.get("nodeKind")
    if not isinstance(raw_node_id, str) or not raw_node_id.strip():
        error_exit(f"{operation}接口未返回有效的 nodeBlockId")
    if not isinstance(raw_node_kind, str) or raw_node_kind.strip().lower() != "doc":
        error_exit(f"{operation}接口未返回有效的 doc 类型")
    node_id = raw_node_id.strip()
    node_kind = raw_node_kind.strip()
    if overwrite and node_id != node_block_id:
        error_exit("全量覆盖返回了不同的 nodeBlockId，已拒绝报告成功")
    url = _common.build_public_url(f"/space/d/{node_id}")

    # 保留 KS_DOC_CREATE 兼容既有消费方；mode 由 dry-run 和用户回执区分。
    failed = _id_list(data, "failedCmdIds")
    fatal = _id_list(data, "fatalCmdIds")
    safe_print(f"KS_DOC_CREATE\t{node_id}\t{node_kind}\t{url}\t{len(failed)}\t{len(fatal)}")
    if failed or fatal:
        safe_print(json.dumps(
            {"failedCmdIds": failed, "fatalCmdIds": fatal},
            ensure_ascii=False, separators=(",", ":"),
        ))

    # 成品回执行：Agent 直接原样透传给用户；url 来自脚本，禁止自拼。
    if overwrite:
        if failed or fatal:
            reply = f"原文档已进入全量覆盖流程，但新正文可能未完整写入，请打开核对：{url}"
        else:
            reply = f"原文档正文已全量覆盖，节点链接和标题保持不变，点击查看：{url}"
    elif failed or fatal:
        reply = f"文档已创建（部分内容可能不完整，建议核对），点击查看：{url}"
    else:
        reply = f"文档已创建，点击查看：{url}"
    safe_print(f"KS_USER_REPLY\t{reply}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        error_exit("未预期的异常")
