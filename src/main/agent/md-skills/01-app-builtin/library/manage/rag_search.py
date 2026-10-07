#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
manage/rag_search.py —— 对指定空间 / 节点做 chunk 语义检索（KInfra Retrieve）

对应文档：
    library/manage/entry.md §6「能力 · chunk 语义检索（rag_search）」

接口（§6.接口细节）：
    POST <API_BASE>/space/api/agent/v1/search-chunks
    Header: 客户端模式由脚本加 X-Skill-Token；沙箱模式由 auth-proxy 注入身份
    Body  : {
        "query":        "<检索词，必填>",
        "spaceIds":     ["<空间 ID，可选>"],       # 限定空间；超 200 截断
        "nodeIds":      ["<节点 ID，可选>"],       # 限定节点；超 200 截断，服务端反查空间
        "limit":        <int32>,                   # 返回上限，默认 20，最大 100
        "enableRerank": true,                      # 固定 true；脚本内部硬编码，不对外暴露
        "searchMode":   1,                         # 固定 1（KInfra Retrieve）；脚本内部硬编码，不对外暴露
        "useOrgData":   true,                      # 固定 true；脚本内部硬编码，不对外暴露
        "driveLimit":   <int32>,                   # Drive RAG 返回条数上限，默认 10
        "conversationRequestId": "<当前轮请求 ID，可选>"  # 取自环境变量 CODEBUDDY_CONVERSATION_REQUEST_ID；非空才下发，服务端透传为 KInfra request_id
    }
    # spaceIds 与 nodeIds 均为空 → 后端返回空 []；脚本侧前置校验至少提供一个
    # minScore 不下发：KInfra 服务端通过 rerank.threshold 自行过滤，handler 层不做后置 score 过滤

响应（SearchChunksRsp）核心字段：
    data.items[*].text        # chunk 文本内容
    data.items[*].spaceId     # 所在空间 ID
    data.items[*].nodeId      # 所在节点 ID（可用于 get-doc-review 取全文）

    data.items[*].score       # 相关性分数（KInfra rerank 原始分，值越大越相关）

    data.items[*].nodeKind    # 节点类型：doc / web / database

stdout 协议（每行一条，TSV）：
    KS_RAG\t<spaceId>\t<nodeId>\t<nodeKind>\t<chunkIdx>\t<score>\t<blockIds>\t<text>

    其中：

        <score>    KInfra rerank 原始分，保留 4 位小数；按 score 倒序输出，值越大越相关

        <text>     chunk 原文；<image> 标签已展开为「[图片 url]\nOCR内容」；换行折为空格（TSV 转义）；语法族由 nodeKind 决定（doc=markdown / web|page=纯文本 / database=字段拼接）

调用形态（token 注入见 SKILL.md §调用方式与运行模式）：
    # 仅必填 query + 一个节点（最常见：针对某文档做 RAG 召回）
    python3 rag_search.py --token-stdin --query "<问题>" --node-id "<blk_xxx>"

    # 限定空间内检索
    python3 rag_search.py --token-stdin --query "<问题>" --space-id "<sp_xxx>"

    # 多节点 + 限制返回条数
    python3 rag_search.py --token-stdin --query "<问题>" \
        --node-id "blk_a" --node-id "blk_b" --limit 10

    # 控制 Drive RAG 条数
    python3 rag_search.py --token-stdin --query "<问题>" \
        --space-id "<sp_xxx>" --drive-limit 5

    # space-id / node-id 均支持「多次传」或「逗号分隔」两种写法
    python3 rag_search.py --token-stdin --query "<问题>" --space-id "sp_a,sp_b"

任何失败一律输出 {"error":"<msg>"} 单行 JSON 后 exit 0（详见 §1 失败降级）。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Tuple

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

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# chunk 语义检索接口（与 search-nodes 同名空间 /space/api/agent/v1/*）
API_PATH = "/space/api/agent/v1/search-chunks"
HTTP_TIMEOUT = 30.0  # KInfra 链路较长，给足超时

# query 长度上限（接口未约束；脚本侧保守截断，避免超长 query 稀释召回）
QUERY_MAX_LEN = 128

# limit / ids 列表边界（与后端契约一致）
LIMIT_DEFAULT = 20
LIMIT_MAX = 100
IDS_MAX = 200  # spaceIds / nodeIds 各自上限，超出截断

# Drive RAG 默认返回条数
DRIVE_LIMIT_DEFAULT = 10

# KS_RAG_CARDS 参数
CARD_SNIPPET_MAX = 240
CARD_TITLE_FALLBACK_LEN = 40
CARD_IMAGE_MAX = 3


_IMAGE_ANCHOR_RE = re.compile(r"\[图片 (https?://[^\]\s]+)\]")


_FILENAME_PREFIX_RE = re.compile(r"^([^\s:]+\.[A-Za-z0-9]{1,10})\s*:")
# ---------------------------------------------------------------------------
# 字段处理（详见 entry.md §6「字段 → stdout 映射」）
# ---------------------------------------------------------------------------

def _sanitize_cell(s: Any) -> str:
    """TSV 单元格转义：把可能破坏行级 TSV 协议的 \\t / \\r / \\n 替换为空格。"""
    if s is None:
        return ""
    text = s if isinstance(s, str) else str(s)
    return text.replace("\t", " ").replace("\r", " ").replace("\n", " ")


def _format_score(score: float) -> str:
    """保留 4 位小数；NaN / inf 兜底 0。"""
    try:
        if score != score or score in (float("inf"), float("-inf")):  # NaN / inf
            return "0.0000"
        return f"{score:.4f}"
    except Exception:
        return "0.0000"


def _resolve_score(item: Mapping[str, Any]) -> float:
    """解析 score；非 number 时返回 0.0。"""
    raw = item.get("score")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        try:
            return float(raw)
        except (TypeError, ValueError):
            return 0.0
    return 0.0


def _normalize_query(raw: Optional[str]) -> str:
    if not isinstance(raw, str):
        return ""
    q = raw.strip()
    if not q:
        return ""
    if len(q) > QUERY_MAX_LEN:
        q = q[:QUERY_MAX_LEN]
    return q


def _normalize_limit(value: Optional[int]) -> Optional[int]:
    """归一化 limit：None 透传；<1 视为非法返回 None；超 LIMIT_MAX 截断。"""
    if value is None:
        return None
    try:
        v = int(value)
    except (TypeError, ValueError):
        return None
    if v < 1:
        return None
    if v > LIMIT_MAX:
        v = LIMIT_MAX
    return v


def _parse_id_list(values: Optional[Iterable[str]]) -> List[str]:
    """把 argparse append 收集的值（每项可能含逗号分隔）拍平、去空、去重为 id 列表。

    支持两种写法：
      - 多次传：--node-id a --node-id b
      - 逗号分隔：--node-id "a,b,c"
    """
    if not values:
        return []
    result: List[str] = []
    seen: set[str] = set()
    for v in values:
        if not isinstance(v, str):
            continue
        for part in v.split(","):
            part = part.strip()
            if part and part not in seen:
                seen.add(part)
                result.append(part)
    return result


def _resolve_block_ids(item: Mapping[str, Any]) -> str:
    """blockIds 数组 → 逗号连接的字符串；缺失 / 非数组 → 空串。"""
    raw = item.get("blockIds")
    if not isinstance(raw, list):
        return ""
    ids = []
    for b in raw:
        if isinstance(b, str) and b.strip():
            ids.append(b.strip())
    return ",".join(ids)


def _expand_image_tags(text: str) -> str:
    """将 text 中的 <image ...>OCR内容</image> 展开为可读格式。

    格式：[图片 <url>]\n<OCR内容>
    - url 取标签 url 属性值；缺失时省略图片行
    - OCR 内容取标签内文本（XML 实体已解码）；为空时省略 OCR 行
    - 多个 <image> 标签依次展开，保留标签前后的原文
    """
    def _replace(m: re.Match) -> str:
        attrs_raw = m.group(1)
        inner = m.group(2).strip()

        # 提取 url 属性值（单引号或双引号均兼容）
        url_m = re.search(r'\burl=["\']([^"\']*)["\']', attrs_raw)
        url = url_m.group(1).strip() if url_m else ""

        # 解码 OCR 文本中的 HTML 实体（&#xA; → \n 等）
        ocr = html.unescape(inner).strip()

        parts = []
        if url:
            parts.append(f"[图片 {url}]")
        if ocr:
            parts.append(ocr)
        return "\n".join(parts) if parts else ""

    return re.sub(
        r"<image\b([^>]*)>(.*?)</image>",
        _replace,
        text,
        flags=re.DOTALL,
    )


def _iter_items(
    data: Mapping[str, Any],
) -> Iterator[Tuple[Mapping[str, Any], str, str]]:
    """遍历 data.items（list 形态），过滤脏数据，返回 (item, space_id, node_id) 三元组。

    过滤规则（§6「过滤规则」）：
        1. item 非 dict → 丢弃
        2. spaceId 为空 → 丢弃
        3. nodeId 为空 → 丢弃
        4. text 为空 → 丢弃（chunk 无内容无召回价值）
    """
    items = data.get("items")
    if not isinstance(items, list):
        return
    for it in items:
        if not isinstance(it, Mapping):
            continue
        space_id = it.get("spaceId")
        if not isinstance(space_id, str) or not space_id.strip():
            continue
        node_id = it.get("nodeId")
        if not isinstance(node_id, str) or not node_id.strip():
            continue
        text = it.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        yield it, space_id.strip(), node_id.strip()


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="RAG chunk semantic search (KInfra Retrieve) over knowledge bases.",
        add_help=True,
    )
    _common.register_token_arg(parser)
    parser.add_argument(
        "--query",
        required=True,
        help="Search query. Up to %d chars." % QUERY_MAX_LEN,
    )
    parser.add_argument(
        "--space-id",
        dest="space_ids",
        action="append",
        default=None,
        help="Restrict to space id(s). Repeatable or comma-separated. "
        "At least one --space-id or --node-id required.",
    )
    parser.add_argument(
        "--node-id",
        dest="node_ids",
        action="append",
        default=None,
        help="Restrict to node id(s). Repeatable or comma-separated. "
        "At least one --space-id or --node-id required.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Max items to return (default %d, max %d)." % (LIMIT_DEFAULT, LIMIT_MAX),
    )
    parser.add_argument(
        "--drive-limit",
        dest="drive_limit",
        type=int,
        default=None,
        help="Max Drive RAG items to return (default %d)." % DRIVE_LIMIT_DEFAULT,
    )
    return parser



def _clean_snippet(raw: str, limit: int = CARD_SNIPPET_MAX) -> str:
    if not raw: return ""
    t = _expand_image_tags(raw)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > limit: t = t[:limit].rstrip() + "…"
    return t



def _extract_card_title(raw: str, node_kind: str) -> str:
    """从 RAG text 提取卡片标题，优先从 text 前缀提取文件名（保留扩展名）。"""
    if not raw:
        return ""
    # doc chunk text 常见格式：<filename.ext>: # heading ...
    # 提取冒号前的文件名部分作为 title（保留 .md/.txt 等扩展名）
    if node_kind == "doc":
        m = _FILENAME_PREFIX_RE.match(raw)
        if m:
            name = m.group(1)
            return name[:CARD_TITLE_FALLBACK_LEN] if len(name) > CARD_TITLE_FALLBACK_LEN else name
    # 其他类型或未匹配文件名前缀：回退到 snippet 前 40 字
    snippet = _clean_snippet(raw, limit=CARD_TITLE_FALLBACK_LEN + 20)
    # 剥离 [图片 ...] 锚点后再截取
    snippet = _IMAGE_ANCHOR_RE.sub("", snippet).strip()
    if len(snippet) > CARD_TITLE_FALLBACK_LEN:
        snippet = snippet[:CARD_TITLE_FALLBACK_LEN].rstrip("…")
    return snippet if snippet else ""

def _extract_image_urls(snippet: str, limit: int = CARD_IMAGE_MAX) -> List[str]:
    seen = set(); urls: List[str] = []
    for m in _IMAGE_ANCHOR_RE.finditer(snippet):
        u = m.group(1).strip()
        if u and u not in seen:
            seen.add(u); urls.append(u)
            if len(urls) >= limit: break
    return urls


def _emit_cards(query: str, rows: List[Tuple[float, str, str, str, int, str, str]]) -> None:
    if not rows: return
    grouped: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for score, space_id, node_id, node_kind, _idx, _bids, raw in rows:
        card = grouped.get(node_id)
        if card is None:
            snippet = _clean_snippet(raw)
            title = _extract_card_title(raw, node_kind) or node_id
            card = {
                "title": title,
            "source": _common.build_public_url(f"/space/d/{node_id}"),
                "space_id": space_id,
                "node_id": node_id,
                "node_kind": node_kind or "unknown",
                "score": round(float(score), 4),
                "snippet": snippet,
                "image_urls": _extract_image_urls(snippet),
                "chunk_count": 1,
            }
            grouped[node_id] = card; order.append(node_id)
        else:
            card["chunk_count"] += 1
    payload = {"query": query, "total": len(order), "cards": [grouped[n] for n in order]}
    safe_print("KS_RAG_CARDS " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def _emit_row(
    space_id: str,
    node_id: str,
    node_kind: str,
    chunk_idx: int,
    score: float,
    block_ids: str,
    text: str,
) -> None:
    """按 TSV 协议输出一行（写出前 _common.safe_print 会再走一次 redact）。

    协议（8 列）：
        KS_RAG\\t<spaceId>\\t<nodeId>\\t<nodeKind>\\t<chunkIdx>\\t<score>\\t<blockIds>\\t<text>
    """
    safe_print(
        "KS_RAG\t{sid}\t{nid}\t{kind}\t{idx}\t{score}\t{bids}\t{text}".format(
            sid=_sanitize_cell(space_id),
            nid=_sanitize_cell(node_id),
            kind=_sanitize_cell(node_kind or "unknown"),
            idx=str(int(chunk_idx) if chunk_idx else 0),
            score=_format_score(score),
            bids=_sanitize_cell(block_ids),
            text=_sanitize_cell(text),
        )
    )


def main(argv: Optional[Iterable[str]] = None) -> None:
    parser = _build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit:
        # argparse 自身的 -h / 参数错误：维持其默认行为
        raise

    # 1) 按运行模式读取凭证：客户端从 stdin 取 token；沙箱由 auth-proxy 注入身份
    token = _common.acquire_token()

    # 2) 参数归一化与校验
    query = _normalize_query(args.query)
    if not query:
        error_exit("query 为空")

    space_ids = _parse_id_list(args.space_ids)
    node_ids = _parse_id_list(args.node_ids)

    # 接口语义：spaceIds 与 nodeIds 均空 → 后端返回空 []；
    # 脚本侧前置拦截，避免无意义请求并给 agent 明确错因
    if not space_ids and not node_ids:
        error_exit("至少指定一个 --space-id 或 --node-id")
        return

    limit = _normalize_limit(args.limit)

    # 3) 构造请求体（仅包含非空字段；可选字段未指定时不下发，由 service 层填默 / 截断）
    body: dict = {
        "query": query,
        "enableRerank": True,  # 固定开启二阶段精排
        "searchMode": 1,       # 固定使用 KInfra Retrieve
        "useOrgData": True,    # 固定请求 KInfra org_data
    }
    if space_ids:
        body["spaceIds"] = space_ids[:IDS_MAX]
    if node_ids:
        body["nodeIds"] = node_ids[:IDS_MAX]
    if limit is not None:
        body["limit"] = limit
    if args.drive_limit is not None:
        body["driveLimit"] = max(1, args.drive_limit)
    # minScore 不下发：KInfra 服务端通过 rerank.threshold 自行过滤

    # 当前轮请求 ID：由 Agent 运行时注入子进程环境（CODEBUDDY_CONVERSATION_REQUEST_ID），
    # 非空时下发，服务端最终作为 KInfra Retrieve 的 request_id 用于全链路追踪；缺失时不下发。
    conversation_request_id = os.environ.get("CODEBUDDY_CONVERSATION_REQUEST_ID", "").strip()
    if conversation_request_id:
        body["conversationRequestId"] = conversation_request_id

    # 4) 拼接请求地址；客户端按 JWT issuer 选域名，沙箱固定走 auth-proxy
    url = _common.build_url(API_PATH)
    try:
        envelope = http_request(
            "POST",
            url,
            token,
            body=body,
            timeout=HTTP_TIMEOUT,
        )
        data = unwrap_data(envelope)
    except HttpError as e:
        error_exit(f"chunk 检索请求失败: {e}")
        return

    # 5) 收集命中 chunk → 行级元组
    rows: List[Tuple[float, str, str, str, int, str, str]] = []
    for item, space_id, node_id in _iter_items(data):
        node_kind = item.get("nodeKind")
        if not isinstance(node_kind, str):
            node_kind = ""
        node_kind = node_kind.strip()

        chunk_idx_raw = item.get("chunkIdx")
        try:
            chunk_idx = int(chunk_idx_raw) if chunk_idx_raw is not None else 0
        except (TypeError, ValueError):
            chunk_idx = 0

        score = _resolve_score(item)
        block_ids = _resolve_block_ids(item)
        text = _expand_image_tags(str(item.get("text") or ""))

        rows.append((score, space_id, node_id, node_kind, chunk_idx, block_ids, text))

    if not rows:
        error_exit("chunk 检索无命中结果")

    # stdout 首行：告诉下游 agent 哪些字段是内部字段
    safe_print("KS_RAG_HEADER " + json.dumps({
        "internal_only": ["score", "spaceId", "nodeId"],
        "user_facing": ["title", "source", "snippet", "node_kind", "chunk_count", "image_urls"],
        "see": "manage/entry.md §检索结果呈现契约",
    }, ensure_ascii=False, separators=(",", ":")))

    # 按 score 倒序排
    rows.sort(key=lambda r: r[0], reverse=True)

    for score, space_id, node_id, node_kind, chunk_idx, block_ids, text in rows:
        _emit_row(space_id, node_id, node_kind, chunk_idx, score, block_ids, text)

    # 聚合 KS_RAG_CARDS
    _emit_cards(query, rows)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # 任何兜底未捕获的异常：输出错误信息
        error_exit(f"未预期的异常: {e}")
