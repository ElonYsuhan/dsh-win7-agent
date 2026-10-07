#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/md_to_html.py —— 把 md 母本转换为自包含 html 的确定性基线生成器

定位：
    本脚本只做**结构**，不做**设计**。所有视觉风格（配色 / 字体 / 排版 / 间距 /
    材质 / 布局）一律由 page/beautify/ 下的美化规范决定，agent 在基线之上落地。
    本脚本产出：
        --format page          结构正确的滚动长页（正文已渲染，带无彩占位色）
        --format presentation  翻页**空框架**（分页外壳 + 每页 md 原料 + 逐字稿，
                               页内无可见 DOM；详见 wbp-presentation-contract.md）

    生成的 html 内联全部 css/js，可直接交给 page/import_html.py 上传。

用法（纯本地运行，不依赖网络 / token）：
    python3 page/md_to_html.py --md <path/to/source.md>
    python3 page/md_to_html.py --md <path> --out <path/to/out.html>
    python3 page/md_to_html.py --md <path> --title "2026 Q1 业绩汇报" --format presentation

参数：
    --md <path>     必填，本地 md 文件路径
    --out <path>    可选，输出 html 路径；缺省时在 md 同目录生成 "<stem>.html"
    --title <str>   可选，主题名（缺省取 front-matter title / 首个 H1 / 文件名）
    --format <str>  可选，page(默认,滚动长页)/presentation(WBP native 档翻页演示，见 wbp-presentation-contract.md)

    注：**无配色 / 风格类参数**。脚本只把 :root 变量填为无彩占位灰，实际配色
        由 beautify 阶段按风格路由覆写 :root 决定。

输出契约：
    成功 → stdout 输出一行 "KS_MD2HTML_OK <JSON>"（{html_path,title,sections,format}）后 exit 0
    失败 → stdout 输出一行 {"error":"<msg>"} 后 exit 0（不抛栈、不阻塞）

安全：
    - 仅处理用户显式给出的本地路径，不遍历目录、不接受通配符
    - 输出 html 时对 md 文本做 HTML 转义，避免注入；不保留任何密钥 / token
"""

from __future__ import annotations

# NOTE: 本文件较长（含 page 与 presentation 两套内联 CSS/JS/模板）。若后续模板继续膨胀，
#       可把 _CSS_TEMPLATE / _JS_TEMPLATE / _PAGE_TEMPLATE 与 _PRES_CSS_TEMPLATE / _PRES_PAGE_TEMPLATE
#       抽到独立的 md_to_html_theme.py，主文件只保留解析与组装逻辑。

import argparse
import html as _html
import json
import os
import re
import sys
from html.parser import HTMLParser


# ──────────────────────────────────────────────────────────────────────────
# 失败出口
# ──────────────────────────────────────────────────────────────────────────
def _fail(msg: str) -> None:
    """结构化失败：stdout 一行 JSON 后 exit 0。"""
    sys.stdout.write(json.dumps({"error": msg}, ensure_ascii=False) + "\n")
    sys.exit(0)


# ──────────────────────────────────────────────────────────────────────────
# 内容净化兜底：拒绝把凭证 / 执行轨迹当成"文档内容"渲染进 html
# ──────────────────────────────────────────────────────────────────────────
# 本脚本头部承诺「不保留任何密钥 / token」。这道扫描就是兑现该承诺的代码：
# md 母本必须是面向读者的成品内容，绝不能混入 agent 自身的执行轨迹、凭证、
# 内部工具调用。一旦命中，立即中止生成（而不是静默渲染并发布到公网），
# 逼调用方回去清理母本。这能挡住"把过程当内容、把 token 写进产物"的事故。
_SECRET_PATTERNS = [
    # JWT（早期登录态 token 形态，当前已迁至 op_xxx，保留兼容扰扰）
    (r"eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}", "疑似 JWT / 登录态 token"),
    # open-platform token op_xxx（connect_open_platform 返回的当前形态）
    (r"\bop_[A-Za-z0-9]{16,}\b", "疑似 open-platform token"),
    # 临时令牌 tk_xxx
    (r"\btk_[A-Za-z0-9]{16,}\b", "疑似临时令牌 tempToken"),
    # Authorization: Bearer xxx（历史产物可能残留）
    (r"Bearer\s+[A-Za-z0-9._-]{20,}", "疑似 Bearer 凭证"),
    # X-Skill-Token: <token>（当前客户端鉴权头）
    (r"(?i)X-Skill-Token\s*[:=]\s*\S+", "疑似 X-Skill-Token 凭证"),
    # 凭证信封字段（历史 tempToken/maskedToken/expiresAt 类字段，命中即视为 raw 返回混入）
    (r'"(maskedToken|tempToken|tempTokenExpiresAt)"\s*:', "疑似凭证返回信封字段"),
    # 工具调用 raw 信封（把过程当内容渲染的典型特征）
    (r'"type"\s*:\s*"mcp_call_tool_result"', "疑似工具调用 raw 返回（执行轨迹混入内容）"),
]


def _scan_secrets(text: str) -> None:
    """扫描 md 母本，命中凭证 / 执行轨迹特征即中止生成。"""
    hits = []
    for pat, label in _SECRET_PATTERNS:
        if re.search(pat, text):
            hits.append(label)
    if hits:
        _fail(
            "md 母本疑似混入凭证或 agent 执行轨迹，已中止生成（命中："
            + "；".join(dict.fromkeys(hits))
            + "）。md 母本只能是面向读者的成品内容，请先剥离 token / 工具调用 / "
            "内部思考 / 本地路径等过程信息后重试。"
        )


# ──────────────────────────────────────────────────────────────────────────
# :root 变量占位值（**不是主题、不是设计选择**）
# ──────────────────────────────────────────────────────────────────────────
# 本脚本不承载任何视觉风格：配色一律由 beautify（page/beautify/beautify-guide.md）
# 按风格路由决定，覆写 :root 变量落地。这里只为让变量有合法初值，统一填**无彩灰**
# （零色相、零饱和），刻意不好看——未覆写即肉眼可见"未美化"，避免脚本默认色被当成成品。
# 严禁在此处引入任何有色相的品牌色 / 渐变配色 / 明暗风格倾向。
_BASELINE_VARS = {
    "accent": "#8f8f8f", "accent2": "#8f8f8f", "accent3": "#8f8f8f",
    "bg": "#121212", "panel": "#1c1c1c", "text": "#e9e9e9", "muted": "#9b9b9b",
}


# ──────────────────────────────────────────────────────────────────────────
# front-matter 解析
# ──────────────────────────────────────────────────────────────────────────
def _split_front_matter(text: str) -> tuple[dict, str]:
    """提取 YAML-ish front-matter（仅取简单 key: value），返回 (meta, body)。"""
    meta: dict = {}
    if text.startswith("---"):
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
        if m:
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip('"').strip("'")
            text = text[m.end():]
    return meta, text


# ──────────────────────────────────────────────────────────────────────────
# WorkBuddy 文档组件 XML → Markdown 归一化（防御性）
#
# 背景：一键可视化读 doc 节点时，doc 模块（get_doc_reviews）回读的是 WorkBuddy 文档
# 的「块组件序列化」格式，如：
#   <Heading id="..." level="1">标题</Heading>
#   <Paragraph id="...">正文 <Mark bold>关键词</Mark> ...</Paragraph>
#   <BlockQuote id="..."><Paragraph>...</Paragraph></BlockQuote>
#   <BulletedList>条目</BulletedList> / <Link href="...">文字</Link> / <Image src="..."/> ...
# 若把这种组件 XML 当成 markdown 直接喂进来，会被 HTML 转义成字面标签文本（线上实测：
# 页面上直接显示 "<Heading id=... level=1>" 之类）。本归一化器把它还原为干净 Markdown，
# 使无论上游喂进来的是组件 XML 还是纯 md，都能正确生成。
# ──────────────────────────────────────────────────────────────────────────
_DOC_COMPONENT_RE = re.compile(
    r"</?\s*(Paragraph|Heading|BlockQuote|Callout|BulletedList|NumberedList|"
    r"Divider|Image|Todo|Table|TableRow|TableCell|Mark|Link|MathBlock)\b",
    re.IGNORECASE,
)


def _looks_like_doc_components(text: str) -> bool:
    return bool(_DOC_COMPONENT_RE.search(text))


class _DocToMarkdown(HTMLParser):
    """把 WorkBuddy 文档组件树解析为 Markdown。剥离所有 id 等属性，只保留语义。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []     # 输出的 markdown 块
        self.inline: list[str] = []    # 当前块的行内文本缓冲
        self.quote = 0                 # BlockQuote / Callout 嵌套深度
        self._mark_bold: list[bool] = []
        self._link_href = ""
        self._link_start = 0
        self._table: list[list[str]] = []
        self._row: list[str] = []
        self._heading_level = 1

    def _flush(self) -> str:
        s = re.sub(r"\s+", " ", "".join(self.inline)).strip()
        self.inline = []
        return s

    def _emit(self, line: str) -> None:
        if self.quote > 0 and line.strip():
            line = "> " + line
        self.parts.append(line)

    def handle_starttag(self, tag, attrs) -> None:
        t = tag.lower()
        a = {k.lower(): (v or "") for k, v in attrs}
        if t in ("blockquote", "callout"):
            self.quote += 1
        elif t == "heading":
            try:
                self._heading_level = max(1, min(6, int(a.get("level", "1") or 1)))
            except ValueError:
                self._heading_level = 1
            self.inline = []
        elif t in ("paragraph", "bulletedlist", "numberedlist", "todo",
                   "mathblock", "tablecell"):
            self.inline = []
        elif t == "mark":
            bold = "bold" in a
            self._mark_bold.append(bold)
            if bold:
                self.inline.append("**")
        elif t == "link":
            self._link_href = a.get("href", "")
            self._link_start = len(self.inline)
        elif t == "image":
            self._emit(f"![{a.get('alt', '')}]({a.get('src', '')})")
        elif t == "divider":
            self._emit("---")
        elif t == "tablerow":
            self._row = []
        elif t == "table":
            self._table = []

    def handle_startendtag(self, tag, attrs) -> None:
        t = tag.lower()
        if t == "divider":
            self._emit("---")
        elif t == "image":
            a = {k.lower(): (v or "") for k, v in attrs}
            self._emit(f"![{a.get('alt', '')}]({a.get('src', '')})")

    def handle_endtag(self, tag) -> None:
        t = tag.lower()
        if t in ("blockquote", "callout"):
            self.quote = max(0, self.quote - 1)
        elif t == "mark":
            if self._mark_bold and self._mark_bold.pop():
                self.inline.append("**")
        elif t == "link":
            text = "".join(self.inline[self._link_start:]).strip()
            del self.inline[self._link_start:]
            self.inline.append(f"[{text}]({self._link_href})" if text else "")
        elif t == "heading":
            s = self._flush()
            if s:
                self._emit("#" * self._heading_level + " " + s)
        elif t == "paragraph":
            s = self._flush()
            if s:
                self._emit(s)
        elif t == "bulletedlist":
            s = self._flush()
            if s:
                self._emit("- " + s)
        elif t == "numberedlist":
            s = self._flush()
            if s:
                self._emit("1. " + s)
        elif t == "todo":
            s = self._flush()
            if s:
                self._emit("- [ ] " + s)
        elif t == "mathblock":
            s = self._flush()
            if s:
                self._emit("$$" + s + "$$")
        elif t == "tablecell":
            self._row.append(self._flush())
        elif t == "tablerow":
            if self._row:
                self._table.append(self._row)
            self._row = []
        elif t == "table":
            if self._table:
                head = self._table[0]
                self._emit("| " + " | ".join(head) + " |")
                self._emit("| " + " | ".join("---" for _ in head) + " |")
                for r in self._table[1:]:
                    self._emit("| " + " | ".join(r) + " |")
            self._table = []

    def handle_data(self, data) -> None:
        self.inline.append(data)

    def to_markdown(self) -> str:
        tail = self._flush()
        if tail:
            self._emit(tail)
        return "\n\n".join(p for p in self.parts if p is not None)


def _normalize_doc_components(text: str) -> str:
    """若输入是 WorkBuddy 文档组件 XML，转成干净 Markdown；否则原样返回。"""
    if not _looks_like_doc_components(text):
        return text
    parser = _DocToMarkdown()
    try:
        parser.feed(text)
        md = parser.to_markdown()
    except Exception:  # noqa: BLE001 - 归一化失败则退回原文，至少不崩
        return text
    return md if md.strip() else text


# ──────────────────────────────────────────────────────────────────────────
# 行内 markdown → html（粗体 / 斜体 / 行内代码 / 链接 / 图片）
# ──────────────────────────────────────────────────────────────────────────
_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def _inline(text: str) -> str:
    """把一行 md 行内语法渲染为安全 html。先转义，再按受控规则放回标签。"""
    # 先抠出行内代码，避免其中的特殊字符被二次处理
    codes: list[str] = []

    def _stash_code(m: re.Match) -> str:
        codes.append(m.group(1))
        return f"\x00CODE{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", _stash_code, text)

    # 图片 / 链接：先用占位符保护 url 与文本
    holders: list[str] = []

    def _stash(htmlfrag: str) -> str:
        holders.append(htmlfrag)
        return f"\x00H{len(holders) - 1}\x00"

    def _img(m: re.Match) -> str:
        alt = _html.escape(m.group(1), quote=True)
        src = _html.escape(m.group(2), quote=True)
        return _stash(f'<img src="{src}" alt="{alt}" loading="lazy">')

    def _link(m: re.Match) -> str:
        label = _html.escape(m.group(1))
        href = _html.escape(m.group(2), quote=True)
        return _stash(f'<a href="{href}" target="_blank" rel="noopener">{label}</a>')

    text = _IMG_RE.sub(_img, text)
    text = _LINK_RE.sub(_link, text)

    # 转义剩余正文
    text = _html.escape(text)

    # 粗体 / 斜体（在转义后处理，标记本身是 ASCII，安全）
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", text)

    # 放回行内代码
    for i, c in enumerate(codes):
        text = text.replace(f"\x00CODE{i}\x00", f"<code>{_html.escape(c)}</code>")
    # 放回图片 / 链接
    for i, h in enumerate(holders):
        text = text.replace(f"\x00H{i}\x00", h)
    return text


# ──────────────────────────────────────────────────────────────────────────
# md 块级解析 → 结构化块列表
# 块类型：h(level,text) / p(text) / ul(items) / ol(items) / table(head,rows)
#         / quote(lines) / code(lang,code) / img(src,alt) / hr
# ──────────────────────────────────────────────────────────────────────────
def _parse_blocks(body: str) -> list[dict]:
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[dict] = []
    i, n = 0, len(lines)

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # 空行
        if not stripped:
            i += 1
            continue

        # 代码块
        if stripped.startswith("```"):
            lang = stripped[3:].strip()
            buf: list[str] = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1  # 跳过结束 ```
            blocks.append({"t": "code", "lang": lang, "code": "\n".join(buf)})
            continue

        # 分隔线
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            blocks.append({"t": "hr"})
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            blocks.append({"t": "h", "level": len(m.group(1)), "text": m.group(2).strip()})
            i += 1
            continue

        # 独占一行的图片
        im = _IMG_RE.fullmatch(stripped)
        if im:
            blocks.append({"t": "img", "alt": im.group(1), "src": im.group(2)})
            i += 1
            continue

        # 引用
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            blocks.append({"t": "quote", "lines": buf})
            continue

        # 表格（当前行含 | 且下一行是分隔行）
        if "|" in line and i + 1 < n and re.match(r"^\s*\|?[\s:|-]+\|?\s*$", lines[i + 1]) and "-" in lines[i + 1]:
            header = _split_table_row(line)
            i += 2
            rows: list[list[str]] = []
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append(_split_table_row(lines[i]))
                i += 1
            blocks.append({"t": "table", "head": header, "rows": rows})
            continue

        # 无序列表
        if re.match(r"^\s*[-*+]\s+", line):
            items = []
            while i < n and re.match(r"^\s*[-*+]\s+", lines[i]):
                items.append(re.sub(r"^\s*[-*+]\s+", "", lines[i]).strip())
                i += 1
            blocks.append({"t": "ul", "items": items})
            continue

        # 有序列表
        if re.match(r"^\s*\d+[.)]\s+", line):
            items = []
            while i < n and re.match(r"^\s*\d+[.)]\s+", lines[i]):
                items.append(re.sub(r"^\s*\d+[.)]\s+", "", lines[i]).strip())
                i += 1
            blocks.append({"t": "ol", "items": items})
            continue

        # 普通段落（连续非空、非块起始行合并）
        buf = [stripped]
        i += 1
        while i < n and lines[i].strip() and not _is_block_start(lines[i]):
            buf.append(lines[i].strip())
            i += 1
        blocks.append({"t": "p", "text": " ".join(buf)})

    return blocks


def _split_table_row(line: str) -> list[str]:
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def _is_block_start(line: str) -> bool:
    s = line.strip()
    return (
        s.startswith("#")
        or s.startswith(">")
        or s.startswith("```")
        or bool(re.match(r"^\s*[-*+]\s+", line))
        or bool(re.match(r"^\s*\d+[.)]\s+", line))
        or bool(re.match(r"^(-{3,}|\*{3,}|_{3,})$", s))
    )


# ──────────────────────────────────────────────────────────────────────────
# 块 → 汇报 section html
# 把扁平块按 H1/H2 切分成「区」，每个区是一张卡片（四区结构的物理载体）
# ──────────────────────────────────────────────────────────────────────────
def _render_blocks_html(blocks: list[dict]) -> tuple[str, int]:
    """返回 (sections_html, section_count)。首个 H1 已被抽为页眉，这里跳过。"""
    sections: list[str] = []
    cur: list[str] = []
    first_h1_consumed = False

    def flush() -> None:
        if cur:
            sections.append(
                '<section class="reveal block-card">\n'
                + "\n".join(cur)
                + "\n</section>"
            )
            cur.clear()

    for b in blocks:
        t = b["t"]
        if t == "h":
            lvl = b["level"]
            if lvl == 1 and not first_h1_consumed:
                first_h1_consumed = True  # 首个 H1 作为页眉标题，正文不再重复
                continue
            # H1/H2 作为分区边界
            if lvl <= 2:
                flush()
            cur.append(f'<h{lvl}>{_inline(b["text"])}</h{lvl}>')
        elif t == "p":
            cur.append(f"<p>{_inline(b['text'])}</p>")
        elif t == "ul":
            lis = "".join(f"<li>{_inline(x)}</li>" for x in b["items"])
            cur.append(f"<ul>{lis}</ul>")
        elif t == "ol":
            lis = "".join(f"<li>{_inline(x)}</li>" for x in b["items"])
            cur.append(f"<ol>{lis}</ol>")
        elif t == "quote":
            inner = "".join(f"<p>{_inline(x)}</p>" for x in b["lines"] if x.strip())
            cur.append(f"<blockquote>{inner}</blockquote>")
        elif t == "code":
            if (b.get("lang") or "").lower() == "mermaid":
                cur.append(_render_mermaid(b["code"]))
            else:
                cur.append(
                    f'<pre><code>{_html.escape(b["code"])}</code></pre>'
                )
        elif t == "img":
            alt = _html.escape(b["alt"], quote=True)
            src = _html.escape(b["src"], quote=True)
            cur.append(
                f'<figure><img src="{src}" alt="{alt}" loading="lazy">'
                + (f"<figcaption>{_inline(b['alt'])}</figcaption>" if b["alt"] else "")
                + "</figure>"
            )
        elif t == "table":
            cur.append(_render_table(b["head"], b["rows"]))
        elif t == "hr":
            flush()

    flush()
    return "\n".join(sections), len(sections)


def _render_table(head: list[str], rows: list[list[str]]) -> str:
    th = "".join(f"<th>{_inline(c)}</th>" for c in head)
    body_rows = []
    for r in rows:
        tds = "".join(f"<td>{_inline(c)}</td>" for c in r)
        body_rows.append(f"<tr>{tds}</tr>")
    return (
        '<div class="table-wrap"><table>'
        f"<thead><tr>{th}</tr></thead>"
        f"<tbody>{''.join(body_rows)}</tbody>"
        "</table></div>"
    )


# ──────────────────────────────────────────────────────────────────────────
# 提取首屏 TL;DR：首个 H1 作标题，其后第一段作核心结论（结论先行）
# ──────────────────────────────────────────────────────────────────────────
def _extract_hero(blocks: list[dict], fallback_title: str) -> tuple[str, str]:
    title = fallback_title
    summary = ""
    seen_h1 = False
    for b in blocks:
        if b["t"] == "h" and b["level"] == 1 and not seen_h1:
            title = b["text"]
            seen_h1 = True
            continue
        if seen_h1 and not summary and b["t"] == "p":
            summary = b["text"]
            break
    return title, summary


# ──────────────────────────────────────────────────────────────────────────
# 组装最终 html
# ──────────────────────────────────────────────────────────────────────────
def _build_html(
    title: str, summary: str, sections_html: str, theme: dict,
) -> str:
    css = _CSS_TEMPLATE.format(**theme)
    hero_summary = (
        f'<p class="hero-summary">{_inline(summary)}</p>' if summary else ""
    )
    esc_title = _html.escape(title)
    return _PAGE_TEMPLATE.format(
        title=esc_title,
        css=css,
        hero_title=_inline(title),
        hero_summary=hero_summary,
        sections=sections_html,
        js=_JS_TEMPLATE,
        mermaid_js=_MERMAID_JS,
    )


_CSS_TEMPLATE = """
/* :root 只是变量插槽：值为无彩占位灰，配色由 beautify 覆写决定（见 beautify/beautify-guide.md）。
   下面的排版仅为「结构可读」的最低限度基线，agent 美化时应整体重写，不必沿用。 */
:root {{
  --accent: {accent}; --accent2: {accent2};
  --bg: {bg}; --panel: {panel}; --text: {text}; --muted: {muted};
}}
* {{ box-sizing: border-box; }}
html {{ scroll-behavior: smooth; }}
body {{
  margin: 0; background: var(--bg); color: var(--text);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", Segoe UI, sans-serif;
  line-height: 1.7; -webkit-font-smoothing: antialiased;
}}
.wrap {{ max-width: 880px; margin: 0 auto; padding: 0 20px 80px; }}
.hero {{ padding: 96px 20px 56px; text-align: center; }}
.hero h1 {{
  font-size: clamp(28px, 5vw, 46px); margin: 0 0 18px; line-height: 1.25; color: var(--text);
}}
.hero-summary {{
  max-width: 720px; margin: 0 auto; font-size: clamp(15px, 2.2vw, 19px);
  color: var(--text);
}}
.block-card {{
  background: var(--panel); border: 1px solid rgba(255,255,255,.06);
  border-radius: 16px; padding: 28px 30px; margin: 22px 0;
}}
.block-card h1, .block-card h2 {{ margin-top: 4px; color: var(--accent2); }}
.block-card h2 {{ font-size: 22px; border-left: 4px solid var(--accent); padding-left: 12px; }}
.block-card h3 {{ font-size: 18px; color: var(--text); }}
.block-card p {{ color: var(--text); }}
.block-card ul, .block-card ol {{ padding-left: 22px; }}
.block-card li {{ margin: 6px 0; }}
a {{ color: var(--accent2); }}
code {{
  background: rgba(255,255,255,.08); padding: 2px 6px; border-radius: 6px;
  font-family: SFMono-Regular, Consolas, monospace; font-size: .92em;
}}
pre {{
  background: var(--panel); border: 1px solid rgba(255,255,255,.08);
  border-radius: 12px; padding: 16px; overflow: auto;
}}
pre code {{ background: none; padding: 0; }}
.mermaid {{
  background: var(--panel); border: 1px solid rgba(255,255,255,.08);
  border-radius: 12px; padding: 20px; margin: 16px 0; text-align: center; overflow-x: auto;
}}
.mermaid svg {{ max-width: 100%; height: auto; }}
.mermaid-loading {{
  display: inline-flex; align-items: center; gap: 8px;
  color: var(--muted); font-size: 14px;
}}
.mermaid-loading::before {{
  content: ""; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.2); border-top-color: var(--accent);
  animation: mermaidSpin .8s linear infinite;
}}
@keyframes mermaidSpin {{ to {{ transform: rotate(360deg); }} }}
blockquote {{
  margin: 12px 0; padding: 8px 16px; border-left: 4px solid var(--accent);
  background: rgba(255,255,255,.04); border-radius: 0 10px 10px 0; color: var(--muted);
}}
.table-wrap {{ overflow-x: auto; }}
table {{ width: 100%; border-collapse: collapse; margin: 10px 0; }}
th, td {{ padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.08); text-align: left; }}
th {{ color: var(--accent2); font-weight: 600; }}
figure {{ margin: 14px 0; }}
figure img {{ width: 100%; border-radius: 12px; }}
figcaption {{ color: var(--muted); font-size: 13px; text-align: center; margin-top: 8px; }}
img {{ max-width: 100%; }}
.reveal {{ opacity: 0; transform: translateY(24px); transition: opacity .6s ease, transform .6s ease; }}
.reveal.in {{ opacity: 1; transform: none; }}
footer {{ text-align: center; color: var(--muted); font-size: 12px; padding: 40px 0 0; }}
@media (prefers-reduced-motion: reduce) {{
  html {{ scroll-behavior: auto; }}
  .reveal {{ opacity: 1; transform: none; transition: none; }}
  .mermaid-loading::before {{ animation: none; }}
}}
"""

_JS_TEMPLATE = """
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var els = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    els.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12 });
  els.forEach(function (el) { io.observe(el); });
})();
"""

# 仅当页面存在 .mermaid 时才按需加载：加载中显示 loading 占位，成功→图，失败/无网/超时→退回代码块。
# 用动态 import() 表达式（非顶层 import 声明），避免脚本重复执行时'mermaid already declared'。
# 图表配色一律运行时读页面 :root（随 beautify 覆写走）；themeVariables 里 v() 的第二参数
# 只是 var() 取不到时的无彩兜底，与 _BASELINE_VARS 一致，不承载任何配色设计。
_MERMAID_JS = """
(function () {
  if (!document.querySelector('.mermaid') || window.__mermaidLoaded) return;
  window.__mermaidLoaded = true;
  function fallback() {
    document.querySelectorAll('.mermaid').forEach(function (el) {
      if (el.getAttribute('data-mermaid-done')) return;
      var pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = el.getAttribute('data-mermaid-src') || el.textContent;
      pre.appendChild(code); el.replaceWith(pre);
    });
  }
  window.__mermaidFallback = fallback;
  var s = document.createElement('script');
  s.type = 'module';
  s.textContent =
    'import("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs").then(function(mod){'
    +   'var mermaid = mod.default;'
    +   'var cs = getComputedStyle(document.documentElement);'
    +   'function v(n,d){return (cs.getPropertyValue(n).trim()||d);}'
    +   'mermaid.initialize({startOnLoad:false,theme:"base",themeVariables:{'
    +     'primaryColor:v("--panel","#1c1c1c"),primaryBorderColor:v("--accent","#8f8f8f"),'
    +     'primaryTextColor:v("--text","#e9e9e9"),secondaryColor:v("--accent2","#8f8f8f"),'
    +     'tertiaryColor:v("--bg","#121212"),lineColor:v("--accent2","#8f8f8f"),'
    +     'textColor:v("--text","#e9e9e9"),mainBkg:v("--panel","#1c1c1c"),'
    +     'nodeBorder:v("--accent","#8f8f8f"),clusterBkg:v("--bg","#121212"),'
    +     'clusterBorder:v("--accent","#8f8f8f"),edgeLabelBackground:v("--panel","#1c1c1c"),'
    +     'fontFamily:"-apple-system, PingFang SC, Microsoft YaHei, Segoe UI, sans-serif"}});'
    +   'document.querySelectorAll(".mermaid").forEach(function(el){el.textContent=el.getAttribute("data-mermaid-src")||el.textContent;});'
    +   'return mermaid.run({querySelector:".mermaid"});'
    + '}).then(function(){'
    +   'document.querySelectorAll(".mermaid").forEach(function(el){el.setAttribute("data-mermaid-done","1");});'
    + '}).catch(function(){window.__mermaidFallback&&window.__mermaidFallback();});';
  document.body.appendChild(s);
  setTimeout(fallback, 8000);  // CDN 长时间无响应也退回代码块
})();
"""


def _render_mermaid(code: str) -> str:
    """mermaid 代码块 → <div class="mermaid">：加载中显示 loading，源码存 data-mermaid-src
    供脚本渲染 / 失败回退；<noscript> 兜底无 JS 环境。"""
    # 属性内换行需编码为 &#10;，否则浏览器会把换行规范化成空格、破坏 mermaid 语法
    attr = _html.escape(code, quote=True).replace("\n", "&#10;")
    esc = _html.escape(code)
    return (
        f'<div class="mermaid" data-mermaid-src="{attr}">'
        f'<span class="mermaid-loading">图表加载中…</span>'
        f'<noscript><pre><code>{esc}</code></pre></noscript>'
        f'</div>'
    )

_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN" data-sp-mode="scroll">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<header class="hero">
  <h1>{hero_title}</h1>
  {hero_summary}
</header>
<main class="wrap">
{sections}
<footer>由 WorkBuddy 资料库生成</footer>
</main>
<script>{js}</script>
<script>{mermaid_js}</script>
</body>
</html>
"""


# ──────────────────────────────────────────────────────────────────────────
# PPT 演示（--format presentation）：md → WBP native 档 html
# 见 wbp-presentation-contract.md。每个 H1/H2 切 section，再按 16:9 盒子高度自动分页，
# 自动推断四区结构（overview/data/logic/next）、生成逐字稿，内联 .is-active 动画。
# ──────────────────────────────────────────────────────────────────────────
# 设计盒 1280×720：竖向 padding 64*2=128，留 16 余量 → 可用内容高度 ≈ 576px。
# 单页内容估算超过 (576 - 标题高) 即触发分页（拆为「标题（续）」续页），避免撑破 16:9。
_PRES_CONTENT_H = 540           # 盒内可用内容高度（px，去掉上下 padding 72*2 与余量）
_PRES_COVER_TITLE_H = 128       # 封面 h1 + TL;DR 摘要占高
_PRES_SECTION_TITLE_H = 84      # 普通页 h2 标题占高
_MAX_TOTAL_SLIDES = 40          # 总页数安全上限（防长文档跑飞；正常远小于此）

# WBP 元信息固定为中性默认（scene/audience 参数已移除，播放器契约仍需这两个字段）
_WBP_SCENE_DEFAULT = "report"
_WBP_AUDIENCE_DEFAULT = "boss"


def _hex_to_rgb(hexstr: str) -> str:
    """#2f6df6 → '47,109,246'，用于发光边框 rgba。"""
    h = (hexstr or "").lstrip("#")
    if len(h) != 6:
        return "47,109,246"
    try:
        return f"{int(h[0:2], 16)},{int(h[2:4], 16)},{int(h[4:6], 16)}"
    except ValueError:
        return "47,109,246"


def _split_sections(blocks: list[dict]) -> list[dict]:
    """按 H1/H2 切分为 section。第一个 section 以首个 H1 为标题（封面），其后每个 H1/H2 各一段。

    返回 [{"title": str, "blocks": [非标题块]}]。**不做"超页合并"**——长 section 由
    _paginate_blocks 按盒子高度拆成多张续页（避免把多段揉成一张巨型 slide 撑破 16:9）。
    """
    sections: list[dict] = []
    cur_title = ""
    cur_blocks: list[dict] = []
    started = False

    for b in blocks:
        if b["t"] == "h" and b["level"] <= 2:
            if started:
                sections.append({"title": cur_title, "blocks": cur_blocks})
            cur_title = b["text"]
            cur_blocks = []
            started = True
        elif b["t"] == "hr":
            continue
        else:
            cur_blocks.append(b)
    if started:
        sections.append({"title": cur_title, "blocks": cur_blocks})

    # 无任何 H1/H2：整篇作为单段
    if not sections:
        sections = [{"title": "", "blocks": [b for b in blocks if b["t"] != "hr"]}]
    return sections


# ── 内容高度估算（px，按 1280 宽设计盒内 ~1136px 内容宽估行数）────────────────
def _text_height(s: str, per_line: int, pad: int) -> int:
    n = len((s or "").strip())
    lines = max(1, (n + 41) // 42)   # 约 42 字/行（保守高估 → 更易触发分页，更安全）
    return lines * per_line + pad


def _li_height(s: str) -> int:
    return _text_height(s, 26, 8)


def _block_height(b: dict) -> int:
    """估算单个块渲染高度（px）。保守偏高，宁可多分页也不撑破盒子。"""
    t = b["t"]
    if t == "h":
        return 44
    if t == "p":
        return _text_height(b.get("text", ""), 30, 14)
    if t in ("ul", "ol"):
        return sum(_li_height(x) for x in b.get("items", [])) + 12
    if t == "quote":
        return sum(_li_height(x) for x in b.get("lines", [])) + 24
    if t == "code":
        return ((b.get("code", "").count("\n") + 1) * 22) + 28
    if t == "table":
        return (len(b.get("rows", [])) + 1) * 40 + 24
    if t == "img":
        return 380
    return 30


def _expand_units(blocks: list[dict], budget: int) -> list[dict]:
    """把超过单页预算的长列表（ul/ol）按条目拆成多个小列表块，便于跨页分页。"""
    units: list[dict] = []
    for b in blocks:
        if b["t"] in ("ul", "ol") and _block_height(b) > budget:
            chunk: list[str] = []
            ch = 12
            for it in b.get("items", []):
                h = _li_height(it)
                if chunk and ch + h > budget:
                    units.append({"t": b["t"], "items": chunk})
                    chunk, ch = [], 12
                chunk.append(it)
                ch += h
            if chunk:
                units.append({"t": b["t"], "items": chunk})
        else:
            units.append(b)
    return units


def _paginate_blocks(blocks: list[dict], budget: int) -> list[list[dict]]:
    """按估算高度把一段 blocks 贪心打包成多页，每页累计高度 ≤ budget。

    单个块本身超 budget（如超大表格/图片）时独占一页（无法再拆）。长列表已在
    _expand_units 里按条目预拆。返回至少一页（可能为空页）。
    """
    budget = max(160, budget)
    units = _expand_units(blocks, budget)
    pages: list[list[dict]] = []
    cur: list[dict] = []
    used = 0
    for u in units:
        h = _block_height(u)
        if cur and used + h > budget:
            pages.append(cur)
            cur, used = [], 0
        cur.append(u)
        used += h
    if cur:
        pages.append(cur)
    return pages or [[]]


def _infer_zone(idx: int, total: int) -> str:
    """四区结构：第一段→overview，最后一段→next，中间前半 data、后半 logic。"""
    if idx == 0:
        return "overview"
    if idx == total - 1:
        return "next"
    return "data" if idx < total / 2 else "logic"


_TRANSITIONS = ["slide-left", "slide-up", "zoom"]


def _make_notes(title: str, blocks: list[dict]) -> str:
    """脚本生成的占位逐字稿（150-300 字口语化草稿，可后续人工润色）。"""
    texts: list[str] = []
    for b in blocks:
        if b["t"] == "p":
            texts.append(b["text"])
        elif b["t"] in ("ul", "ol"):
            texts.extend(b["items"])
        elif b["t"] == "quote":
            texts.extend(b["lines"])
    body = re.sub(r"\s+", " ", " ".join(texts)).strip()
    t = title.strip() or "这一部分"
    if not body:
        return f"接下来这一页讲的是「{t}」，请结合页面要点展开说明，并自然过渡到下一页。"
    if len(body) > 240:
        body = body[:240] + "…"
    return f"这一页重点说明「{t}」：{body} 讲的时候可以放慢语速、点出其中的关键数字与结论，再自然过渡到下一页。"


def _block_to_md(b: dict) -> str:
    """把一个内容块还原为 markdown 片段（用于 slide 内的建版原料）。"""
    t = b["t"]
    if t == "h":
        return "#" * max(3, b["level"]) + " " + b["text"]
    if t == "p":
        return b["text"]
    if t == "ul":
        return "\n".join(f"- {x}" for x in b["items"])
    if t == "ol":
        return "\n".join(f"{i}. {x}" for i, x in enumerate(b["items"], 1))
    if t == "quote":
        return "\n".join(f"> {x}" for x in b["lines"] if x.strip())
    if t == "code":
        lang = b.get("lang") or ""
        return f"```{lang}\n{b['code']}\n```"
    if t == "img":
        return f"![{b['alt']}]({b['src']})"
    if t == "table":
        head = b["head"]
        rows = b["rows"]
        lines = ["| " + " | ".join(head) + " |",
                 "|" + "|".join(["---"] * len(head)) + "|"]
        lines += ["| " + " | ".join(r) + " |" for r in rows]
        return "\n".join(lines)
    return ""


def _source_payload(title: str, blocks: list[dict], summary: str, is_cover: bool) -> str:
    """该页的 md 原料文本。放进 <script data-wbp-source>，供 agent 逐张建版读取。

    `<script>` 是 raw text 元素（实体不解码），所以不做 html 转义，只中和可能提前
    闭合标签的 `</script`，避免原料里出现该串时截断文档。
    """
    parts: list[str] = []
    if title:
        parts.append(("# " if is_cover else "## ") + title)
    if is_cover and summary:
        parts.append(summary)
    for b in blocks:
        frag = _block_to_md(b)
        if frag:
            parts.append(frag)
    text = "\n\n".join(parts)
    return text.replace("</script", "<\\/script")


def _build_slide(slide: dict, idx: int, layout: str, summary: str) -> str:
    """产出一张 slide 的**空框架**：外壳 + 不可见 md 原料 + 隐藏逐字稿。

    刻意不渲染任何页内可见 DOM——页内版面由 agent 逐张建版时按原料自行设计
    （见 wbp-presentation-contract.md §12）。脚本若给出版式，建版会退化成换色，每页雷同。
    """
    sid = f"s{idx + 1}"
    transition = _TRANSITIONS[idx % len(_TRANSITIONS)]
    zone = slide["zone"]
    title = slide["title"]
    shown = title if slide["is_cover"] else title + ("（续）" if slide["is_cont"] else "")

    source = _source_payload(shown, slide["blocks"], summary, slide["is_cover"])
    notes = _make_notes(title, slide["blocks"])

    return (
        f'<section data-wbp-slide data-slide-id="{sid}" data-layout="{layout}" '
        f'data-zone="{zone}" data-transition="{transition}">\n'
        f'      <script type="text/markdown" data-wbp-source>\n{source}\n</script>\n'
        f"      <aside data-wbp-notes>{_inline(notes)}</aside>\n"
        f"    </section>"
    )


def _build_presentation(
    title: str, summary: str, blocks: list[dict], theme: dict,
) -> tuple[str, int]:
    """组装 WBP native 档 html，返回 (html, slide_count)。

    流程：H1/H2 切 section → 每个 section 按盒子高度分页（长 section 拆多张续页）
    → 逐页定 layout/zone → 渲染。这样任何一页内容都不会超出 16:9 设计盒。
    """
    sections = _split_sections(blocks)
    nsec = len(sections)

    # 1) 把每个 section 按高度预算分页，展开成"页"列表（带 section/续页信息）
    slides: list[dict] = []
    for si, sec in enumerate(sections):
        zone = _infer_zone(si, nsec)
        is_cover_sec = (si == 0)
        title_h = _PRES_COVER_TITLE_H if (is_cover_sec and summary) else _PRES_SECTION_TITLE_H
        budget = _PRES_CONTENT_H - title_h

        sec_blocks = sec["blocks"]
        # 封面已用首段作 TL;DR，避免重复渲染同一段
        if is_cover_sec and summary:
            sec_blocks = [
                b for b in sec_blocks
                if not (b["t"] == "p" and b["text"].strip() == summary.strip())
            ]

        pages = _paginate_blocks(sec_blocks, budget)
        for pi, pg in enumerate(pages):
            slides.append({
                "title": sec["title"],
                "blocks": pg,
                "zone": zone,
                "is_cover": is_cover_sec and pi == 0,
                "is_cont": pi > 0,
            })

    # 2) 安全上限（防长文档跑飞）
    if len(slides) > _MAX_TOTAL_SLIDES:
        slides = slides[:_MAX_TOTAL_SLIDES]
    nsl = len(slides)

    # 3) 逐页定 layout + 渲染
    slides_html: list[str] = []
    meta_slides: list[dict] = []
    for i, sl in enumerate(slides):
        if sl["is_cover"]:
            layout = "cover"
        elif i == nsl - 1:
            layout = "cta"
        elif any(b["t"] == "table" for b in sl["blocks"]):
            layout = "chart"
        else:
            layout = "bullets"
        slides_html.append(
            _build_slide(sl, i, layout, summary if sl["is_cover"] else "")
        )
        meta_slides.append({
            "id": f"s{i + 1}",
            "layout": layout,
            "zone": sl["zone"],
            "title": (sl["title"] or title) if sl["is_cover"] else sl["title"],
        })

    scene_code = _WBP_SCENE_DEFAULT
    aud_code = _WBP_AUDIENCE_DEFAULT
    accent_rgb = _hex_to_rgb(theme.get("accent", "#2f6df6"))
    accent2_rgb = _hex_to_rgb(theme.get("accent2", theme.get("accent", "#2f6df6")))
    accent3_rgb = _hex_to_rgb(theme.get("accent3", theme.get("accent2", "#2f6df6")))

    css = _PRES_CSS_TEMPLATE.format(
        accent_rgb=accent_rgb, accent2_rgb=accent2_rgb, accent3_rgb=accent3_rgb, **theme,
    )
    meta_json = json.dumps({
        "title": title,
        "audience": aud_code,
        "scene": scene_code,
        "slideCount": nsl,
        "slides": meta_slides,
    }, ensure_ascii=False, separators=(",", ":"))

    html = _PRES_PAGE_TEMPLATE.format(
        title=_html.escape(title),
        audience_code=aud_code,
        scene_code=scene_code,
        meta_json=meta_json,
        css=css,
        slides="\n    ".join(slides_html),
        mermaid_js=_MERMAID_JS,
    )
    return html, nsl


_PRES_CSS_TEMPLATE = """
/* :root 只是**变量插槽**：值为无彩占位灰，配色由 beautify 覆写决定（见 beautify/beautify-guide.md）。
   此处不定义任何复合视觉（渐变构成、材质半透明度等）——那是设计决策，属 beautify 职责。 */
:root {{
  --accent: {accent}; --accent2: {accent2}; --accent3: {accent3};
  --accent-rgb: {accent_rgb}; --accent2-rgb: {accent2_rgb}; --accent3-rgb: {accent3_rgb};
  --bg: {bg}; --panel: {panel}; --text: {text}; --muted: {muted};
  /* 入场动画缓动（属 .is-active 时序契约，非配色） */
  --ease: cubic-bezier(.4,0,.2,1);
  --ease-bounce: cubic-bezier(.22,1.3,.36,1);
}}
* {{ box-sizing: border-box; }}
html, body {{
  margin: 0; background: var(--bg); color: var(--text);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", Segoe UI, sans-serif;
  -webkit-font-smoothing: antialiased;
}}
[data-wbp-deck] {{ display: block; }}

/* ── 框架级样式（仅此而已）─────────────────────────────────────────────────
   本文件只提供结构必需项：slide 的 1280x720 定格盒 + 隐藏槽位 + 动画关键帧。
   排版 / 间距 / 内边距 / 圆角 / 材质 / 配色一律不提供——那是 beautify 的职责，
   页内 DOM 与全部样式由 agent 逐张建版时编写（见 wbp-presentation-contract.md §12）。 */
[data-wbp-slide] {{
  /* 结构必需：定格尺寸（播放器按 data-design-w/h 等比缩放投屏），不可改 */
  position: relative; width: 1280px; min-height: 720px; overflow: hidden;
  /* 以下两项仅为浏览态可读的最低限度，可自由覆写（含 padding:0 做满幅出血） */
  margin: 28px auto; padding: 64px;
  background: var(--panel);
}}
[data-wbp-notes] {{ display: none; }}
[data-wbp-source] {{ display: none; }}

/* ── 页内动画钩子 ─────────────────────────────────────────────────────────
   入场动画一律挂 .is-active（容器翻到该页时加，离开移除，重访重播）。
   关键安全约束：绝不预隐藏元素（不写静态 opacity:0）——浏览态 iframe 无容器、
   不加 .is-active，预隐藏会整页白屏。元素默认可见，.is-active 只「重播」入场。
   性能约束：批量入场只用 transform + opacity（合成器可加速），不写 filter/blur，
   否则每帧重新栅格化，一页十几个元素同时动会明显掉帧。
   下面只提供关键帧；具体挂到哪些选择器由 agent 建版时按自建 DOM 决定。 */
@keyframes wbpRise {{ from {{ opacity: 0; transform: translateY(40px) scale(.985); }}
                      to {{ opacity: 1; transform: none; }} }}
@keyframes wbpBlurIn {{ from {{ opacity: 0; filter: blur(16px); }} to {{ opacity: 1; filter: none; }} }}
@keyframes wbpZoom {{ 0% {{ opacity: 0; transform: scale(.86); }}
                      60% {{ transform: scale(1.03); }}
                      100% {{ opacity: 1; transform: scale(1); }} }}

@media (prefers-reduced-motion: reduce) {{
  [data-wbp-slide] * {{ animation: none !important; }}
}}
"""

_PRES_PAGE_TEMPLATE = """<!doctype html>
<html lang="zh" data-wbp data-wbp-version="1.1" data-aspect="16:9" data-design-w="1280" data-design-h="720">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="wbp:audience" content="{audience_code}">
<meta name="wbp:scene" content="{scene_code}">
<script type="application/json" id="wbp-meta">{meta_json}</script>
<style>{css}</style>
</head>
<body>
  <main data-wbp-deck>
    {slides}
  </main>
  <script>{mermaid_js}</script>
</body>
</html>
"""


def _content_chars(blocks: list[dict]) -> int:
    """统计 md 正文有效字数（标题/段落/要点/引用/表格单元/代码），用于最少内容门槛。"""
    n = 0
    for b in blocks:
        t = b["t"]
        if t in ("h", "p"):
            n += len((b.get("text") or "").strip())
        elif t in ("ul", "ol"):
            n += sum(len((x or "").strip()) for x in b.get("items", []))
        elif t == "quote":
            n += sum(len((x or "").strip()) for x in b.get("lines", []))
        elif t == "code":
            n += len((b.get("code") or "").strip())
        elif t == "table":
            for row in b.get("rows", []):
                n += sum(len((c or "").strip()) for c in row)
    return n


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--md", dest="md", default="")
    parser.add_argument("--out", dest="out", default="")
    parser.add_argument("--title", dest="title", default="")
    parser.add_argument("--format", dest="format", default="page",
                        choices=["page", "presentation"])
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        _fail("参数解析失败")

    md_path = (args.md or "").strip()
    if not md_path or not os.path.isfile(md_path):
        _fail("md 路径无效或文件不存在")

    try:
        with open(md_path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except (OSError, IOError):
        _fail("md 文件读取失败")

    if not raw.strip():
        _fail("md 内容为空")

    # 凭证 / 执行轨迹兜底扫描：命中即中止，绝不把过程信息渲染进公网产物
    _scan_secrets(raw)

    meta, body = _split_front_matter(raw)
    # 防御性归一化：上游若传入 WorkBuddy 文档组件 XML（Heading/Paragraph/Mark...），先还原为 markdown
    body = _normalize_doc_components(body)
    blocks = _parse_blocks(body)
    if not blocks:
        _fail("md 解析后无有效内容块")

    fallback_title = (
        (args.title or "").strip()
        or meta.get("title", "").strip()
        or os.path.splitext(os.path.basename(md_path))[0]
    )
    # title 优先级：--title > front-matter title > 首个 H1 > 文件名。
    # 显式 / front-matter 指定时锁定标题，_extract_hero 只用于提取结论先行的 summary。
    title_locked = bool((args.title or "").strip() or meta.get("title", "").strip())
    hero_title, summary = _extract_hero(blocks, fallback_title)
    title = fallback_title if title_locked else hero_title

    theme = _BASELINE_VARS
    fmt = (args.format or "page").strip()

    if fmt == "presentation":
        # 内容过少 → 提示补充，不硬生成空架子（WBP 契约 §4 / md-to-html-flow §4.1 生成规则 5）
        if _content_chars(blocks) < 200:
            _fail("md 内容过少（不足 200 字），不足以支撑一份演示，请补充内容后再生成")
        page, section_count = _build_presentation(title, summary, blocks, theme)
    else:
        sections_html, section_count = _render_blocks_html(blocks)
        page = _build_html(title, summary, sections_html, theme)

    out_path = (args.out or "").strip()
    if not out_path:
        stem = os.path.splitext(md_path)[0]
        suffix = "-presentation.html" if fmt == "presentation" else ".html"
        out_path = stem + suffix
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(page)
    except (OSError, IOError):
        _fail("html 写入失败")

    sys.stdout.write(
        "KS_MD2HTML_OK "
        + json.dumps(
            {"html_path": out_path, "title": title,
             "sections": section_count, "format": fmt},
            ensure_ascii=False, separators=(",", ":"),
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
