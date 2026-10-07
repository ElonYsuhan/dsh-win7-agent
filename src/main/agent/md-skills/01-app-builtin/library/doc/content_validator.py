# -*- coding: utf-8 -*-
"""
doc/content_validator.py —— 编辑 / 修订链路内容提交契约校验。

本模块同时负责 content/new_content 静态契约校验，以及 update old_content/new_content
前后元数据保留校验；只做本地校验，不做内容自动改写。submit_review_edit.py 与
submit_doc_edit.py 共用本模块，避免在各提交入口按单个事故场景重复补规则。
"""

import html
import ipaddress
import json
import re
from collections import Counter
from urllib.parse import urlsplit


class ContentContractError(ValueError):
    """content/new_content 不符合编辑 / 修订链路提交契约。"""


class ContentValidationMode:
    REVIEW_INSERT = "review_insert"
    REVIEW_UPDATE = "review_update"
    DIRECT_INSERT = "direct_insert"
    DIRECT_UPDATE = "direct_update"


_MARK_AR_PATTERN = re.compile(
    r"""<\s*Mark\b[^>]*\bar\s*=\s*["'](?:insert|delete|format)["'][^>]*>""",
    re.IGNORECASE,
)
_ANY_MARK_AR_PATTERN = re.compile(r"""<\s*Mark\b[^>]*\bar\s*=""", re.IGNORECASE)
_MARK_TAG_PATTERN = re.compile(r"""</?\s*Mark\b[^>]*>|<\s*Mark\b[^>]*/\s*>""", re.IGNORECASE)
_MARK_COMMENT_ATTR_PATTERN = re.compile(r"""<\s*Mark\b[^>]*\bcomment\s*=\s*\{([^{}]*)\}""", re.IGNORECASE | re.DOTALL)
_ANY_COMMENT_ATTR_PATTERN = re.compile(r"""\bcomment\s*=""", re.IGNORECASE)
_EXPRESSION_ATTR_PATTERN = re.compile(r"""\b([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{([^{}]*)\}""", re.DOTALL)
_OPENING_TAG_PATTERN = re.compile(r"""<\s*([A-Za-z][A-Za-z0-9]*)\b[^>]*>""", re.DOTALL)
_OPENING_COMPONENT_PATTERN = re.compile(r"""^\s*<\s*([A-Z][A-Za-z0-9]*)\b[^>]*>""", re.DOTALL)
_ATTRIBUTE_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
_WRITABLE_METADATA_ATTR_PATTERN = re.compile(
    r"""<\s*[A-Z][A-Za-z0-9]*\b[^>]*\b(?:id|action|reviewId|readonly)\s*=""",
    re.IGNORECASE | re.DOTALL,
)
_SAFE_HTTP_URL_PATTERN = re.compile(r"^https?://", re.IGNORECASE)
_DANGEROUS_URI_SCHEME_PATTERN = re.compile(r"(?:javascript|data|vbscript)\s*:", re.IGNORECASE)
_HTML_COMMENT_PATTERN = re.compile(r"<!--.*?-->", re.DOTALL)
_ANY_TAG_PATTERN = re.compile(r"<\s*(/)?\s*([A-Za-z][A-Za-z0-9]*)\b[^>]*>", re.DOTALL)
_MARK_WITH_BODY_PATTERN = re.compile(r"<\s*Mark\b[^>]*>(.*?)</\s*Mark\s*>", re.DOTALL)
_MARKDOWN_FENCE_PATTERN = re.compile(r"```")
_FRONTMATTER_PATTERN = re.compile(r"^\s*---(?:\r?\n|$)")
_COMPONENT_ID_ATTR_PATTERN = re.compile(r"<\s*[A-Z][A-Za-z0-9]*\b[^>]*\bid\s*=", re.IGNORECASE)
_READONLY_REVIEW_COMPONENT_PATTERN = re.compile(r"<\s*/?\s*(?:ReviewSummary|ReviewCard)\b", re.IGNORECASE)
_TOP_LEVEL_TABLE_CHILD_PATTERN = re.compile(r"(?:^|\n\s*\n)\s*<\s*(?:TableRow|TableCell)\b", re.IGNORECASE)
_COMPONENT_TAG_TOKEN_PATTERN = re.compile(r"<\s*(/)?\s*([A-Z][A-Za-z0-9]*)\b[^>]*(/?)\s*>", re.DOTALL)
_ALLOWED_TOP_LEVEL_COMPONENTS = {
    "Paragraph",
    "Heading",
    "BlockQuote",
    "Callout",
    "Divider",
    "Image",
    "Todo",
    "BulletedList",
    "NumberedList",
    "MathBlock",
    "Code",
    "Mermaid",
    "Table",
}
_KNOWN_COMPONENTS = _ALLOWED_TOP_LEVEL_COMPONENTS | {"TableRow", "TableCell", "Mark", "Link"}
_KNOWN_COMPONENT_NAME_BY_LOWER = {name.lower(): name for name in _KNOWN_COMPONENTS}
_COMPONENT_ALLOWED_ATTRIBUTES = {
    "Paragraph": {"textalign", "blockcolor"},
    "Heading": {"level", "textalign", "blockcolor"},
    "Todo": {"checked", "blockcolor"},
    "BulletedList": {"blockcolor"},
    "NumberedList": {"blockcolor"},
    "BlockQuote": {"textalign", "blockcolor"},
    "Callout": {"icon"},
    "Divider": set(),
    "Image": {"src", "alt", "align", "width", "height"},
    "Table": set(),
    "TableRow": set(),
    "TableCell": set(),
    "MathBlock": {"width"},
    "Code": {"language"},
    "Mermaid": set(),
    "Mark": {"bold", "italic", "underline", "strike", "color", "backgroundcolor", "ar", "comment"},
    "Link": {"href"},
}
_BOOLEAN_COMPONENT_ATTRIBUTES = {
    "Todo": {"checked"},
    "Mark": {"bold", "italic", "underline", "strike"},
}
_BLOCK_COLORS = {
    "default", "grey", "light_grey", "dark", "light_blue", "blue", "light_sky_blue", "sky_blue",
    "light_green", "green", "light_yellow", "yellow", "light_orange", "orange", "light_red", "red",
    "light_rose_red", "rose_red", "light_purple", "purple",
}
_TEXT_COLORS = {"default", "grey", "blue", "sky_blue", "green", "yellow", "orange", "red", "rose_red", "purple"}
_TEXT_CONTAINER_COMPONENTS = {"Paragraph", "Heading"}
_LIST_COMPONENTS = {"Todo", "BulletedList", "NumberedList"}
_CONTAINER_COMPONENTS = {"BlockQuote", "Callout"}
_LEAF_COMPONENTS = {"Divider", "Image"}
_RAW_LEAF_COMPONENTS = {"MathBlock", "Code", "Mermaid"}
_BLOCK_COMPONENTS = _ALLOWED_TOP_LEVEL_COMPONENTS
_BLOCKED_IPV4_FIRST_OCTETS = {9, 10, 11, 21, 30}
_SUMMARY_JSON_LIKE_PATTERN = re.compile(r"^\s*[\[{]")
_SUMMARY_FORBIDDEN_FIELD_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])(?:discussionId|reviewDiscussionId|commentDiscussionId|blockId|pageId|nodeId|"
    r"reviewId|commentId|authorId|targetId|anchorBlockId|affectedBlockIds|updateArgs|"
    r"cardOpArgs|pnid|selector|tag|createdAt|updatedAt|timestamp|discussion_id|"
    r"review_discussion_id|comment_discussion_id|block_id|page_id|node_id|review_id|"
    r"comment_id|author_id|target_id|anchor_block_id|affected_block_ids|created_at|updated_at)"
    r"(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_SUMMARY_INTERNAL_ID_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])(?:b|blk|block|dis|disc|discussion|page|node|pnid|rvw|review|cmmt|comment)_"
    r"[A-Za-z0-9][A-Za-z0-9_-]*(?![A-Za-z0-9_])|(?<![0-9a-f])[0-9a-f]{16,}(?![0-9a-f])",
    re.IGNORECASE,
)

_RAW_SOURCE_COMPONENT_CONTRACTS = {
    "Mermaid": {
        "display": "<Mermaid>",
        "body": "Mermaid 原始源码",
        "forbid_markdown_fence": True,
        "fence_hint": "请去掉 ```mermaid 和 ```",
        "forbid_nested_same_component": True,
        "forbid_component_tags": True,
        "forbid_dangerous_uri": True,
    },
    "MathBlock": {
        "display": "<MathBlock>",
        "body": "数学公式源码",
        "forbid_component_tags": True,
    },
}

_UPDATE_FORBIDDEN_COMPONENTS = {
    "Code": "Code 内容或语言变更必须 delete + insert_before/insert_after，禁止 update",
    "Mermaid": "Mermaid 修改必须 delete + insert_before/insert_after，禁止 update",
    "Table": "Table 结构或内容变更必须按表格任务分派，禁止对最外层 Table 执行 update",
}
_RAW_SOURCE_COMPONENTS = ("Code", "Mermaid", "MathBlock")


def _component_tag_pattern(component_name: str):
    return re.compile(r"<\s*" + re.escape(component_name) + r"\b", re.IGNORECASE)


def _component_block_pattern(component_name: str):
    return re.compile(
        r"<\s*" + re.escape(component_name) + r"\b[^>]*>(.*?)</\s*" + re.escape(component_name) + r"\s*>",
        re.IGNORECASE | re.DOTALL,
    )


def _mask_raw_source_bodies(content: str) -> str:
    """屏蔽源码组件 body，避免把源码中的尖括号或表达式误判为组件语法。"""
    masked = content
    for component_name in _RAW_SOURCE_COMPONENTS:
        pattern = re.compile(
            r"(<\s*" + re.escape(component_name) + r"\b[^>]*>)(.*?)(</\s*"
            + re.escape(component_name) + r"\s*>)",
            re.IGNORECASE | re.DOTALL,
        )

        def replace_body(match):
            body = match.group(2)
            safe_body = "".join("\n" if char == "\n" else " " for char in body)
            return match.group(1) + safe_body + match.group(3)

        masked = pattern.sub(replace_body, masked)
    return masked


def _parse_tag_attributes(tag: str, idx: int):
    """解析组件 opening tag 属性；返回 (name, value, kind)，kind 为 bool/quoted/expression/bare。"""
    name_match = re.match(r"\s*<\s*[A-Za-z][A-Za-z0-9]*\b", tag)
    if not name_match:
        return []
    text = tag[name_match.end():]
    text = re.sub(r"/?>\s*$", "", text, count=1).strip()
    attributes = []
    pos = 0
    while pos < len(text):
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            break
        name_match = _ATTRIBUTE_NAME_PATTERN.match(text, pos)
        if not name_match:
            raise ContentContractError(
                f"actions[{idx}] 组件属性语法非法；请使用 name、name=\"value\" 或 comment={{[\"discussion_xxx\"]}}"
            )
        name = name_match.group(0)
        pos = name_match.end()
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text) or text[pos] != "=":
            attributes.append((name, None, "bool"))
            continue
        pos += 1
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            raise ContentContractError(f"actions[{idx}] 属性 {name} 缺少值")
        if text[pos] in ('"', "'"):
            quote = text[pos]
            end = text.find(quote, pos + 1)
            if end < 0:
                raise ContentContractError(f"actions[{idx}] 属性 {name} 引号未闭合")
            attributes.append((name, text[pos + 1:end], "quoted"))
            pos = end + 1
            continue
        if text[pos] == "{":
            depth = 1
            end = pos + 1
            in_quote = None
            escaped = False
            while end < len(text) and depth:
                char = text[end]
                if in_quote:
                    if escaped:
                        escaped = False
                    elif char == "\\":
                        escaped = True
                    elif char == in_quote:
                        in_quote = None
                elif char in ('"', "'"):
                    in_quote = char
                elif char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                end += 1
            if depth:
                raise ContentContractError(f"actions[{idx}] 属性 {name} 的表达式未闭合")
            attributes.append((name, text[pos + 1:end - 1], "expression"))
            pos = end
            continue
        end = pos
        while end < len(text) and not text[end].isspace():
            end += 1
        attributes.append((name, text[pos:end], "bare"))
        pos = end
    return attributes


def _attribute_map(tag: str, idx: int):
    result = {}
    for name, value, kind in _parse_tag_attributes(tag, idx):
        key = name.lower()
        if key in result:
            raise ContentContractError(f"actions[{idx}] 组件属性 {name} 重复；每个属性只能出现一次")
        result[key] = (value, kind)
    return result


def _require_attr_value(attributes, component_name: str, attr_name: str, idx: int) -> str:
    value_kind = attributes.get(attr_name)
    if value_kind is None or value_kind[1] != "quoted" or not str(value_kind[0] or "").strip():
        raise ContentContractError(
            f"actions[{idx}] <{component_name}>.{attr_name} 必须是非空双引号字符串"
        )
    return str(value_kind[0]).strip()


def _validate_safe_url(url: str, component_name: str, attr_name: str, idx: int) -> None:
    if any(ord(char) < 32 or ord(char) == 127 for char in url):
        raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 禁止控制字符")
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} URL 格式非法") from exc
    if parsed.scheme.lower() not in ("http", "https") or not hostname:
        raise ContentContractError(
            f"actions[{idx}] <{component_name}>.{attr_name} 仅允许完整 http:// 或 https:// URL"
        )
    if parsed.username or parsed.password:
        raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 禁止 URL userinfo")
    if port is not None and not 1 <= port <= 65535:
        raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 端口非法")

    normalized_host = hostname.rstrip(".").lower()
    if not normalized_host.isascii():
        raise ContentContractError(
            f"actions[{idx}] <{component_name}>.{attr_name} 主机名必须使用 ASCII，禁止 Unicode/IDNA 绕过"
        )
    if normalized_host == "localhost" or normalized_host.endswith(".localhost") or normalized_host.endswith(".local"):
        raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 禁止本机或内网地址")
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        labels = normalized_host.split(".")
        if normalized_host.isdigit() or all(label.isdigit() for label in labels):
            raise ContentContractError(
                f"actions[{idx}] <{component_name}>.{attr_name} 禁止非标准数字 IP 表示"
            )
        first_label = labels[0]
        if first_label.isdigit() and int(first_label) in _BLOCKED_IPV4_FIRST_OCTETS:
            raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 禁止受限内网网段")
        return
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 禁止私网、特殊或本机地址")
    if isinstance(address, ipaddress.IPv4Address) and int(str(address).split(".", 1)[0]) in _BLOCKED_IPV4_FIRST_OCTETS:
        raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 禁止受限内网网段")


def _validate_component_attribute_values(component_name: str, attributes, idx: int) -> None:
    if component_name == "Heading":
        level = _require_attr_value(attributes, component_name, "level", idx)
        if level not in {"1", "2", "3", "4", "5", "6"}:
            raise ContentContractError(f"actions[{idx}] <Heading>.level 仅允许字符串 1 到 6")
    if component_name == "Code":
        _require_attr_value(attributes, component_name, "language", idx)
    if component_name == "Link":
        _validate_safe_url(_require_attr_value(attributes, component_name, "href", idx), component_name, "href", idx)
    if component_name == "Image":
        _validate_safe_url(_require_attr_value(attributes, component_name, "src", idx), component_name, "src", idx)

    for attr_name in ("textalign", "align"):
        if attr_name in attributes and str(attributes[attr_name][0]) not in {"left", "center", "right"}:
            raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 仅允许 left/center/right")
    for attr_name in ("width", "height"):
        if attr_name in attributes and not re.fullmatch(r"[1-9][0-9]*", str(attributes[attr_name][0] or "")):
            raise ContentContractError(f"actions[{idx}] <{component_name}>.{attr_name} 必须是正整数字符串")
    if "blockcolor" in attributes and str(attributes["blockcolor"][0]) not in _BLOCK_COLORS:
        raise ContentContractError(f"actions[{idx}] <{component_name}>.blockColor 不在允许的颜色 token 中")
    if "backgroundcolor" in attributes and str(attributes["backgroundcolor"][0]) not in _BLOCK_COLORS:
        raise ContentContractError(f"actions[{idx}] <Mark>.backgroundColor 不在允许的颜色 token 中")
    if "color" in attributes and str(attributes["color"][0]) not in _TEXT_COLORS:
        raise ContentContractError(f"actions[{idx}] <Mark>.color 不在允许的颜色 token 中")


def validate_user_summary(summary: str, label: str = "summary", max_chars: int = 200) -> None:
    """校验用户可见摘要，避免把内部字段或 ID 暴露到审阅卡标题/回执。"""
    if not isinstance(summary, str):
        raise ContentContractError(f"{label} 必须是字符串")
    text = summary.strip()
    if not text:
        raise ContentContractError(f"{label} 不能为空")
    if len(text) > max_chars:
        raise ContentContractError(f"{label} 超过 {max_chars} 字符")
    if "\n" in text or "\r" in text or "\t" in text:
        raise ContentContractError(f"{label} 只能是单行自然语言，禁止包含控制字符")
    if _SUMMARY_JSON_LIKE_PATTERN.search(text):
        raise ContentContractError(f"{label} 必须是用户可读自然语言，禁止写 JSON/数组结构")
    if _SUMMARY_FORBIDDEN_FIELD_PATTERN.search(text):
        raise ContentContractError(f"{label} 包含内部字段名，禁止暴露 discussionId/blockId/pageId 等数据属性")
    if _SUMMARY_INTERNAL_ID_PATTERN.search(text):
        raise ContentContractError(f"{label} 包含内部 ID，禁止暴露 block/discussion/page/node 等标识")


def _reject_readonly_or_metadata(content: str, idx: int) -> None:
    if _HTML_COMMENT_PATTERN.search(content):
        raise ContentContractError(
            f"actions[{idx}] content/new_content 禁止 HTML comment；请删除 <!-- ... --> 注释"
        )
    if _FRONTMATTER_PATTERN.search(content):
        raise ContentContractError(f"actions[{idx}] content/new_content 禁止写 frontmatter")
    if _READONLY_REVIEW_COMPONENT_PATTERN.search(content):
        raise ContentContractError(f"actions[{idx}] content/new_content 禁止写 ReviewSummary/ReviewCard 只读组件")
    if _COMPONENT_ID_ATTR_PATTERN.search(content):
        raise ContentContractError(f"actions[{idx}] content/new_content 禁止手写组件 id 属性")
    if _WRITABLE_METADATA_ATTR_PATTERN.search(content):
        raise ContentContractError(
            f"actions[{idx}] content/new_content 禁止写 id/action/reviewId/readonly 等回读元数据属性"
        )
    if _TOP_LEVEL_TABLE_CHILD_PATTERN.search(content):
        raise ContentContractError(f"actions[{idx}] content 禁止直接写 TableRow/TableCell；请包在合法 <Table> 内")


def _reject_non_component_top_level_content(content: str, idx: int, require_single_block: bool) -> None:
    """编辑 / 修订链路只接受 WorkBuddy 组件块，不接受裸 Markdown。"""
    text = content.strip()
    if not text:
        raise ContentContractError(f"actions[{idx}] content/new_content 不能为空")

    stack = []
    top_level_count = 0
    pos = 0
    saw_tag = False
    for match in _COMPONENT_TAG_TOKEN_PATTERN.finditer(text):
        between = text[pos:match.start()]
        if not stack and between.strip():
            raise ContentContractError(
                f"actions[{idx}] content/new_content 必须使用组件语法，禁止裸 Markdown 或纯文本"
            )

        saw_tag = True
        is_closing = bool(match.group(1))
        name = match.group(2)
        is_self_closing = bool(match.group(3)) or match.group(0).rstrip().endswith("/>")

        if name not in _KNOWN_COMPONENTS:
            raise ContentContractError(f"actions[{idx}] content/new_content 包含未知组件 <{name}>；请改用已支持组件")

        if is_closing:
            if not stack or stack[-1] != name:
                raise ContentContractError(f"actions[{idx}] content/new_content 组件闭合顺序不匹配: </{name}>")
            stack.pop()
        else:
            if not stack:
                if name not in _ALLOWED_TOP_LEVEL_COMPONENTS:
                    raise ContentContractError(
                        f"actions[{idx}] content/new_content 顶层组件不能是 <{name}>；请使用合法块级组件"
                    )
                top_level_count += 1
            if not is_self_closing:
                stack.append(name)
        pos = match.end()

    if not saw_tag or text[pos:].strip():
        raise ContentContractError(f"actions[{idx}] content/new_content 必须使用组件语法，禁止裸 Markdown 或纯文本")
    if stack:
        raise ContentContractError(f"actions[{idx}] content/new_content 组件未闭合: <{stack[-1]}>")
    if top_level_count == 0:
        raise ContentContractError(f"actions[{idx}] content/new_content 必须包含至少 1 个块级组件")
    if require_single_block and top_level_count != 1:
        raise ContentContractError(f"actions[{idx}] update.new_content 必须是正好 1 个完整组件块")


def _allowed_child(parent: str, child: str) -> bool:
    if parent == "Table":
        return child == "TableRow"
    if parent == "TableRow":
        return child == "TableCell"
    if parent == "TableCell":
        return child in (_BLOCK_COMPONENTS - {"Table"})
    if parent in _TEXT_CONTAINER_COMPONENTS:
        return child in {"Mark", "Link"}
    if parent in _LIST_COMPONENTS:
        return child in ({"Mark", "Link"} | _LIST_COMPONENTS)
    if parent in _CONTAINER_COMPONENTS:
        return child in _BLOCK_COMPONENTS
    if parent in {"Mark", "Link"} | _LEAF_COMPONENTS | _RAW_LEAF_COMPONENTS:
        return False
    return False


def _validate_component_hierarchy(content: str, idx: int) -> None:
    """校验组件父子关系、自闭合形态和必需结构。"""
    stack = []
    for match in _COMPONENT_TAG_TOKEN_PATTERN.finditer(content):
        is_closing = bool(match.group(1))
        name = match.group(2)
        is_self_closing = bool(match.group(3)) or match.group(0).rstrip().endswith("/>")
        if is_closing:
            if not stack or stack[-1][0] != name:
                continue
            frame_name, child_count = stack.pop()
            if frame_name in {"Table", "TableRow", "TableCell"} and child_count == 0:
                raise ContentContractError(f"actions[{idx}] <{frame_name}> 必须包含合法子组件")
            continue

        parent = stack[-1][0] if stack else ""
        if parent and not _allowed_child(parent, name):
            raise ContentContractError(
                f"actions[{idx}] <{parent}> 不允许直接包含 <{name}>；请按组件父子契约调整结构"
            )
        if stack:
            stack[-1][1] += 1
        if name in _LEAF_COMPONENTS and not is_self_closing:
            raise ContentContractError(f"actions[{idx}] <{name}> 必须使用自闭合写法 <{name} ... />")
        if name not in _LEAF_COMPONENTS and is_self_closing:
            raise ContentContractError(f"actions[{idx}] <{name}> 禁止自闭合，必须提供合法内容")
        if not is_self_closing:
            stack.append([name, 0])


def _validate_nonempty_marks(content: str, idx: int) -> None:
    opening_marks = [match for match in _OPENING_TAG_PATTERN.finditer(content) if match.group(1) == "Mark"]
    bodies = {match.start(): match.group(1) for match in _MARK_WITH_BODY_PATTERN.finditer(content)}
    for match in opening_marks:
        body = bodies.get(match.start())
        if body is None or not body.strip():
            raise ContentContractError(f"actions[{idx}] <Mark> 必须包含非空文字，禁止自闭合或空 Mark")


def _validate_raw_leaf_bodies(content: str, idx: int) -> None:
    for component_name in _RAW_LEAF_COMPONENTS:
        tag_pattern = _component_tag_pattern(component_name)
        block_pattern = _component_block_pattern(component_name)
        tag_count = len(tag_pattern.findall(content))
        blocks = list(block_pattern.finditer(content))
        if tag_count and not blocks:
            raise ContentContractError(
                f"actions[{idx}] <{component_name}> 必须使用成对标签并包含非空源码"
            )
        for match in blocks:
            if not match.group(1).strip():
                raise ContentContractError(f"actions[{idx}] <{component_name}> 源码不能为空")


def _parse_comment_ids(raw_value: str, idx: int, label: str):
    try:
        values = json.loads(raw_value)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ContentContractError(
            f"actions[{idx}] {label} 的 Mark.comment 必须是合法 JSON 字符串数组；"
            "正确格式：comment={[\"discussion_xxx\"]}"
        ) from exc
    if not isinstance(values, list) or not values or any(
        not isinstance(value, str) or not value.strip() for value in values
    ):
        raise ContentContractError(
            f"actions[{idx}] {label} 的 Mark.comment 必须是非空字符串数组；"
            "正确格式：comment={[\"discussion_xxx\"]}"
        )
    return [value.strip() for value in values]


def _extract_comment_ids(content: str, idx: int, label: str):
    ids = []
    content_without_comments = _HTML_COMMENT_PATTERN.sub("", content)
    for match in _OPENING_TAG_PATTERN.finditer(content_without_comments):
        if match.group(1).lower() != "mark":
            continue
        attributes = _attribute_map(match.group(0), idx)
        comment = attributes.get("comment")
        if comment is None:
            continue
        value, kind = comment
        if kind != "expression":
            raise ContentContractError(
                f"actions[{idx}] {label} 的 Mark.comment 必须使用表达式字符串数组"
            )
        ids.extend(_parse_comment_ids(str(value), idx, label))
    return ids


def _validate_tag_names_and_text(content: str, idx: int) -> None:
    """拒绝未知/大小写错误标签及组件正文中的 content expression。"""
    pos = 0
    for tag_match in _ANY_TAG_PATTERN.finditer(content):
        between = content[pos:tag_match.start()]
        if "{" in between or "}" in between:
            raise ContentContractError(
                f"actions[{idx}] 组件正文禁止 {{...}} content expression；请改为普通文本"
            )
        component_name = tag_match.group(2)
        canonical_name = _KNOWN_COMPONENT_NAME_BY_LOWER.get(component_name.lower())
        if not canonical_name:
            raise ContentContractError(
                f"actions[{idx}] content/new_content 包含不支持的标签 <{component_name}>；"
                "禁止写 HTML/script 标签，请使用受支持的 WorkBuddy 组件"
            )
        if component_name != canonical_name:
            raise ContentContractError(
                f"actions[{idx}] 组件名 <{component_name}> 大小写非法；正确写法是 <{canonical_name}>"
            )
        pos = tag_match.end()
    if "{" in content[pos:] or "}" in content[pos:]:
        raise ContentContractError(
            f"actions[{idx}] 组件正文禁止 {{...}} content expression；请改为普通文本"
        )


def _validate_component_attributes(content: str, idx: int, allow_comment: bool) -> None:
    """拒绝未知属性、危险 URL 与任意表达式；update 仅放行合法 Mark.comment。"""
    for tag_match in _OPENING_TAG_PATTERN.finditer(content):
        tag = tag_match.group(0)
        component_name = tag_match.group(1)
        canonical_name = _KNOWN_COMPONENT_NAME_BY_LOWER.get(component_name.lower())
        if not canonical_name:
            raise ContentContractError(
                f"actions[{idx}] content/new_content 包含不支持的标签 <{component_name}>；"
                "禁止写 HTML/script 标签，请使用受支持的 WorkBuddy 组件"
            )
        if component_name != canonical_name:
            raise ContentContractError(
                f"actions[{idx}] 组件名 <{component_name}> 大小写非法；正确写法是 <{canonical_name}>"
            )

        attributes = _attribute_map(tag, idx)
        allowed_attributes = _COMPONENT_ALLOWED_ATTRIBUTES[component_name]
        unknown_attributes = sorted(name for name in attributes if name not in allowed_attributes)
        if unknown_attributes:
            raise ContentContractError(
                f"actions[{idx}] <{component_name}> 包含不支持的属性；"
                f"仅允许: {', '.join(sorted(allowed_attributes)) or '无属性'}"
            )
        boolean_attributes = _BOOLEAN_COMPONENT_ATTRIBUTES.get(component_name, set())
        for attr_name, (_, kind) in attributes.items():
            if attr_name in boolean_attributes and kind != "bool":
                raise ContentContractError(
                    f"actions[{idx}] <{component_name}>.{attr_name} 是布尔属性，必须只写属性名、不写值"
                )
            if attr_name not in boolean_attributes and kind == "bool":
                raise ContentContractError(
                    f"actions[{idx}] <{component_name}>.{attr_name} 必须提供双引号字符串值"
                )
            if kind == "bare":
                raise ContentContractError(
                    f"actions[{idx}] <{component_name}>.{attr_name} 必须使用双引号属性值"
                )
        comment = attributes.get("comment")
        if comment is not None:
            value, kind = comment
            if component_name != "Mark":
                raise ContentContractError(
                    f"actions[{idx}] comment 属性只能写在 <Mark> 上；"
                    "正确格式：<Mark comment={[\"discussion_xxx\"]}>文本</Mark>"
                )
            if not allow_comment:
                raise ContentContractError(
                    f"actions[{idx}] insert 不得创建评论锚点；请删除 Mark.comment，"
                    "仅 update 可原样保留 old_content 中已有的评论 ID"
                )
            if kind != "expression":
                raise ContentContractError(
                    f"actions[{idx}] Mark.comment 必须使用表达式形式的非空字符串数组；"
                    "正确格式：comment={[\"discussion_xxx\"]}"
                )
            _parse_comment_ids(str(value), idx, "new_content")

        for attr_name, (value, kind) in attributes.items():
            if kind == "expression" and not (component_name == "Mark" and attr_name == "comment"):
                raise ContentContractError(
                    f"actions[{idx}] content/new_content 禁止表达式属性 {attr_name}={{...}}；"
                    "仅 update 可原样保留 Mark.comment={字符串数组}"
                )

        _validate_component_attribute_values(component_name, attributes, idx)


def _top_level_signature(content: str, idx: int, label: str, ignore_readonly: bool):
    masked = _mask_raw_source_bodies(content)
    match = _OPENING_TAG_PATTERN.match(masked)
    if not match:
        raise ContentContractError(
            f"actions[{idx}] {label} 必须以完整块级组件开头；请使用最新回读的完整组件块"
        )
    component_name = match.group(1)
    attributes = _attribute_map(match.group(0), idx)
    if ignore_readonly:
        for name in ("id", "action", "reviewid", "readonly"):
            attributes.pop(name, None)
    normalized_attrs = tuple(sorted(
        (name, kind, "" if value is None else str(value))
        for name, (value, kind) in attributes.items()
    ))
    return component_name, normalized_attrs


def _block_component_tree(content: str, idx: int, ignore_readonly: bool):
    masked = _mask_raw_source_bodies(content)
    stack = []
    tree = []
    for match in _COMPONENT_TAG_TOKEN_PATTERN.finditer(masked):
        name = match.group(2)
        is_closing = bool(match.group(1))
        is_self_closing = bool(match.group(3)) or match.group(0).rstrip().endswith("/>")
        if is_closing:
            if stack and stack[-1] == name:
                stack.pop()
            continue
        if name not in ("Mark", "Link"):
            attributes = _attribute_map(match.group(0), idx)
            if ignore_readonly:
                for attr_name in ("id", "action", "reviewid", "readonly"):
                    attributes.pop(attr_name, None)
            normalized_attrs = tuple(sorted(
                (attr_name, kind, "" if value is None else str(value))
                for attr_name, (value, kind) in attributes.items()
            ))
            tree.append((tuple(stack), name, normalized_attrs))
        if not is_self_closing:
            stack.append(name)
    return tree


def _validate_mark_comment_alignment(old_content: str, new_content: str, idx: int) -> None:
    old_entries = []
    new_entries = []
    for label, content, entries in (
        ("old_content", old_content, old_entries),
        ("new_content", new_content, new_entries),
    ):
        without_comments = _HTML_COMMENT_PATTERN.sub("", content)
        for match in _MARK_WITH_BODY_PATTERN.finditer(without_comments):
            attributes = _attribute_map(match.group(0).split(">", 1)[0] + ">", idx)
            comment = attributes.get("comment")
            if comment is None:
                continue
            value, kind = comment
            if kind != "expression":
                raise ContentContractError(f"actions[{idx}] {label} 的 Mark.comment 格式非法")
            ids = tuple(_parse_comment_ids(str(value), idx, label))
            entries.append((ids, _normalize_visible_text(match.group(1))))
    if Counter(old_entries) != Counter(new_entries):
        raise ContentContractError(
            f"actions[{idx}] update.new_content 改变了 comment 锚点文本或范围；"
            "请原样保留评论 Mark 的文本范围，并把 ar/样式属性合并到同一个 Mark"
        )


def _raw_source_snapshots(content: str):
    snapshots = []
    for component_name in _RAW_SOURCE_COMPONENTS:
        for match in _component_block_pattern(component_name).finditer(content):
            snapshots.append((match.start(), component_name, match.group(1)))
    return [(name, body) for _, name, body in sorted(snapshots)]


def _normalize_visible_text(text: str) -> str:
    return " ".join(text.split())


def _review_before_projection(content: str, idx: int) -> str:
    parts = []
    mark_modes = []
    pos = 0
    for match in _ANY_TAG_PATTERN.finditer(content):
        text = content[pos:match.start()]
        if not mark_modes or mark_modes[-1] != "insert":
            parts.append(text)
        name = match.group(2)
        is_closing = bool(match.group(1))
        if name == "Mark":
            if is_closing:
                if mark_modes:
                    mark_modes.pop()
            else:
                attributes = _attribute_map(match.group(0), idx)
                ar_attr = attributes.get("ar")
                mark_modes.append(str(ar_attr[0]) if ar_attr else "")
        pos = match.end()
    if not mark_modes or mark_modes[-1] != "insert":
        parts.append(content[pos:])
    return _normalize_visible_text("".join(parts))


def _plain_component_text(content: str) -> str:
    return _normalize_visible_text(_ANY_TAG_PATTERN.sub("", content))


def _validate_review_diff_completeness(old_content: str, new_content: str, idx: int) -> None:
    if _plain_component_text(old_content) != _review_before_projection(new_content, idx):
        raise ContentContractError(
            f"actions[{idx}] review update 存在未用 Mark ar 标识的文字变化；"
            "请用 ar=\"delete\" 标旧文字、ar=\"insert\" 标新文字，未变化文字保持原样"
        )


def _validate_update_structure(old_content: str, new_content: str, idx: int) -> None:
    old_name, old_attrs = _top_level_signature(old_content, idx, "old_content", ignore_readonly=True)
    new_name, new_attrs = _top_level_signature(new_content, idx, "new_content", ignore_readonly=False)
    if old_name == "Table" or new_name == "Table":
        raise ContentContractError(
            f"actions[{idx}] 禁止对最外层 Table 执行 update；"
            "cell 内容请定位内部子块，表格结构请使用 delete + insert_after"
        )
    if old_name != new_name:
        raise ContentContractError(
            f"actions[{idx}] update 不能把 <{old_name}> 改成 <{new_name}>；"
            "块类型变化请使用 delete + insert_before/insert_after"
        )
    if old_attrs != new_attrs:
        raise ContentContractError(
            f"actions[{idx}] update 不能改变 <{old_name}> 的块级属性；"
            "请保留原属性，或使用 delete + insert_before/insert_after"
        )
    if _block_component_tree(old_content, idx, ignore_readonly=True) != _block_component_tree(
        new_content, idx, ignore_readonly=False
    ):
        raise ContentContractError(
            f"actions[{idx}] update 不能改变 <{old_name}> 的块级 children 结构；"
            "结构变化请使用 delete + insert_before/insert_after"
        )
    if _raw_source_snapshots(old_content) != _raw_source_snapshots(new_content):
        raise ContentContractError(
            f"actions[{idx}] update 不能修改容器内 Code/MathBlock/Mermaid 原始源码；"
            "请保持原子块不变，或对原子块使用 delete + insert_before/insert_after"
        )


def validate_update_preserves_inline_metadata(
    old_content: str,
    new_content: str,
    idx: int,
    allow_drop_comment: bool = False,
    drop_comment_reason: str = "",
    require_review_diff: bool = False,
) -> None:
    """校验 update 前后没有无意丢失原有结构或 inline 元数据。"""
    if not isinstance(old_content, str) or not old_content.strip():
        raise ContentContractError(
            f"actions[{idx}] update 缺少 old_content；"
            "请填入目标块修改前的完整组件内容用于本地防丢校验（不会随 actions 提交）"
        )

    _validate_update_structure(old_content, new_content, idx)
    if require_review_diff:
        _validate_review_diff_completeness(old_content, new_content, idx)
    old_comment_ids = _extract_comment_ids(old_content, idx, "old_content")
    new_comment_ids = _extract_comment_ids(new_content, idx, "new_content")
    old_counts = Counter(old_comment_ids)
    new_counts = Counter(new_comment_ids)
    added_count = sum(max(0, count - old_counts[comment_id]) for comment_id, count in new_counts.items())
    if added_count:
        raise ContentContractError(
            f"actions[{idx}] update.new_content 新增了 {added_count} 个 old_content 中不存在的 comment 锚点；"
            "只能原样保留已有评论 ID，禁止自行创建评论锚点"
        )
    if not old_comment_ids:
        return

    missing_count = sum(max(0, count - new_counts[comment_id]) for comment_id, count in old_counts.items())
    missing = missing_count > 0
    if missing and not allow_drop_comment:
        raise ContentContractError(
            f"actions[{idx}] update.new_content 丢失 {missing_count} 个原有 comment 锚点；"
            "请基于 old_content 最小修改，并把 comment 与 ar/样式属性合并在同一个 <Mark> 上；"
            "若用户明确要求删除对应评论锚点，才可同时设置 allow_drop_comment=true 与 drop_comment_reason"
        )
    if not allow_drop_comment:
        _validate_mark_comment_alignment(old_content, new_content, idx)
    if missing and not str(drop_comment_reason or "").strip():
        raise ContentContractError(
            f"actions[{idx}] allow_drop_comment=true 时必须填写 drop_comment_reason，"
            "说明用户明确要求删除评论锚点或对应文本的原因"
        )


def _reject_nested_mark(content: str, idx: int) -> None:
    """禁止嵌套 <Mark>，评论属性与审阅 / 样式属性必须合并到同一个 Mark。"""
    depth = 0
    for match in _MARK_TAG_PATTERN.finditer(content):
        tag = match.group(0)
        lower = tag.lower()
        if lower.startswith("</"):
            depth = max(0, depth - 1)
            continue
        self_closing = lower.endswith("/>")
        if depth > 0:
            raise ContentContractError(
                f"actions[{idx}] content/new_content 包含嵌套 <Mark>；"
                "请把 comment、ar、bold 等属性合并到同一个 <Mark> 上"
            )
        if not self_closing:
            depth += 1


def _validate_mark_ar_contract(content: str, idx: int, mode: str) -> None:
    ar_values = []
    mark_bodies = {
        match.start(): match.group(1)
        for match in _MARK_WITH_BODY_PATTERN.finditer(content)
    }
    for tag_match in _OPENING_TAG_PATTERN.finditer(content):
        if tag_match.group(1) != "Mark":
            continue
        attributes = _attribute_map(tag_match.group(0), idx)
        ar_attr = attributes.get("ar")
        if ar_attr is None:
            continue
        value, kind = ar_attr
        if kind != "quoted" or value not in ("insert", "delete", "format"):
            raise ContentContractError(
                f"actions[{idx}] Mark.ar 仅允许字符串 insert/delete/format；"
                "正确格式：<Mark ar=\"insert\">新增文字</Mark>"
            )
        body = mark_bodies.get(tag_match.start())
        if body is None or not body.strip():
            raise ContentContractError(
                f"actions[{idx}] 带 ar 的 Mark 必须包含非空文字，禁止自闭合或空 Mark"
            )
        ar_values.append(value)

    if mode == ContentValidationMode.REVIEW_UPDATE and not ar_values:
        raise ContentContractError(
            f"actions[{idx}] update.new_content 缺少 <Mark ar=\"insert|delete|format\"> "
            "diff 标识；审阅 update 必须带 Mark ar"
        )
    if mode in (
        ContentValidationMode.REVIEW_INSERT,
        ContentValidationMode.DIRECT_INSERT,
        ContentValidationMode.DIRECT_UPDATE,
    ) and ar_values:
        if mode == ContentValidationMode.REVIEW_INSERT:
            raise ContentContractError(
                f"actions[{idx}] insert.content 包含 <Mark ar=...>；"
                "审阅 insert 是块级操作，content 必须是最终新增内容，禁止行内 ar"
            )
        raise ContentContractError(
            f"actions[{idx}] content 包含审阅标记 <Mark ar=...>，编辑模式禁止使用"
        )


def _validate_raw_source_components(content: str, idx: int) -> None:
    """按组件子内容语义校验 raw-source 组件，不按单个事故场景散落判断。"""
    for component_name, contract in _RAW_SOURCE_COMPONENT_CONTRACTS.items():
        block_pattern = _component_block_pattern(component_name)
        tag_pattern = _component_tag_pattern(component_name)
        for match in block_pattern.finditer(content):
            body = match.group(1)
            display = str(contract["display"])
            body_name = str(contract["body"])
            if contract.get("forbid_markdown_fence") and _MARKDOWN_FENCE_PATTERN.search(body):
                raise ContentContractError(
                    f"actions[{idx}] {display} 内包含 Markdown fenced code；"
                    f"编辑/修订组件语法只允许 {body_name}，{contract['fence_hint']}"
                )
            if contract.get("forbid_nested_same_component") and tag_pattern.search(body):
                raise ContentContractError(
                    f"actions[{idx}] {display} 内嵌套 {display}；"
                    f"编辑/修订组件语法只允许 {body_name}"
                )
            if contract.get("forbid_component_tags"):
                normalized_body = html.unescape(body)
                if contract.get("forbid_dangerous_uri") and _DANGEROUS_URI_SCHEME_PATTERN.search(normalized_body):
                    raise ContentContractError(
                        f"actions[{idx}] {display} 源码包含 javascript:/data:/vbscript: 危险协议；请删除"
                    )
                for tag_match in _ANY_TAG_PATTERN.finditer(normalized_body):
                    name = tag_match.group(2)
                    raise ContentContractError(
                        f"actions[{idx}] {display} 内包含标签 <{name}>；"
                        f"只允许 {body_name}，禁止嵌入 HTML/Mark/Paragraph 等标签"
                    )


def _reject_update_forbidden_components(content: str, idx: int) -> None:
    match = _OPENING_TAG_PATTERN.match(content.strip())
    if not match:
        return
    component_name = match.group(1)
    reason = _UPDATE_FORBIDDEN_COMPONENTS.get(component_name)
    if reason:
        raise ContentContractError(f"actions[{idx}] update.new_content 顶层是 <{component_name}>；{reason}")


def validate_content_contract(content: str, idx: int, mode: str) -> None:
    """校验 content/new_content 在指定提交模式下是否满足契约。"""
    structural_content = _mask_raw_source_bodies(content)
    _reject_readonly_or_metadata(structural_content, idx)
    _reject_non_component_top_level_content(
        structural_content,
        idx,
        mode in (ContentValidationMode.REVIEW_UPDATE, ContentValidationMode.DIRECT_UPDATE),
    )
    _reject_nested_mark(structural_content, idx)
    _validate_tag_names_and_text(structural_content, idx)
    _validate_component_hierarchy(structural_content, idx)
    _validate_nonempty_marks(structural_content, idx)
    _validate_raw_leaf_bodies(content, idx)
    _validate_component_attributes(
        structural_content,
        idx,
        allow_comment=mode in (ContentValidationMode.REVIEW_UPDATE, ContentValidationMode.DIRECT_UPDATE),
    )
    _validate_mark_ar_contract(structural_content, idx, mode)

    if mode == ContentValidationMode.REVIEW_INSERT:
        _validate_raw_source_components(content, idx)
        return

    if mode == ContentValidationMode.REVIEW_UPDATE:
        _reject_update_forbidden_components(structural_content, idx)
        _validate_raw_source_components(content, idx)
        return

    if mode == ContentValidationMode.DIRECT_INSERT:
        _validate_raw_source_components(content, idx)
        return

    if mode == ContentValidationMode.DIRECT_UPDATE:
        _reject_update_forbidden_components(structural_content, idx)
        _validate_raw_source_components(content, idx)
        return

    raise ContentContractError(f"actions[{idx}] content 校验模式无效: {mode}")


__all__ = [
    "ContentContractError",
    "ContentValidationMode",
    "validate_content_contract",
    "validate_update_preserves_inline_metadata",
    "validate_user_summary",
]
