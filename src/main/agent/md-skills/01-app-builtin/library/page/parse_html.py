#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mindx-page skill：解析 HTML 文件，提取 Database Schema

用法：
    python3 scripts/parse_html.py --html <path/to/page.html>

行为：
    - 从 HTML 文件中解析出数据表结构（schema）
    - stdout 输出 JSON：{ tables, source, sdk_calls_found, html_has_template_syntax, confidence }
    - 解析失败 → stdout 输出 "{}"，silent exit 0

解析策略（见 reference/html-parse-spec.md）：
    1. HTML 中已有的 __SMART_PAGE__.database.* 调用
    2. HTML <table> 结构
    3. HTML <form> 表单结构（报名表/注册/反馈等）
    4. HTML data-table / data-field 属性
    5. HTML 模板占位符 {{xxx}} / ${xxx}
    6. HTML fetch/XHR 调用
    7. HTML 重复结构检测（卡片/列表/定义列表）
    8. HTML div 伪表格（CSS Grid/Flexbox 模拟的表格）
    9. JavaScript 内联数据对象

改进点：
    - 先提取 <body> 内容，忽略 <head>（减少误匹配，Agent 读取时省 token）
    - 多策略合并：收集所有命中策略的结果，合并后输出（不再"第一个成功即返回"）
    - 增强中文字段映射：覆盖更多行业用语
    - select 枚举推断：通过多行数据检测有限枚举
    - 置信度字段：每个表附带 confidence，供 Agent 做最终决策
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
from collections import Counter
from html.parser import HTMLParser
from typing import Any, Optional


# ========== 预处理：提取 <body> ==========

def _extract_body(html: str) -> str:
    """提取 <body> 内容，忽略 <head>。保留 <body> 中的 <script>。"""
    body_match = re.search(r'<body[^>]*>', html, re.I)
    if body_match:
        body_start = body_match.end()
        body_end_match = re.search(r'</body>', html[body_start:], re.I)
        if body_end_match:
            return html[body_start:body_start + body_end_match.start()]
        return html[body_start:]
    # 没有 <body> 标签（HTML 片段）→ 原样返回
    return html


def _extract_title(html: str) -> str:
    """从 <head> 中提取 <title> 作为表名参考。"""
    m = re.search(r'<title[^>]*>(.*?)</title>', html, re.I | re.S)
    return m.group(1).strip() if m else ""


# ========== HTML 解析器 ==========

class _TableExtractor(HTMLParser):
    """从 HTML 中提取 <table> 结构（支持多表）。

    同步收集每列的 selector 信息（用于 P0-3 field_mapping），保存到
    self.tables[i]["cell_classes"] / ["data_fields"]，方便后续生成 mapping。
    """

    def __init__(self):
        super().__init__()
        self.tables: list[dict] = []
        self._current_table: Optional[dict] = None
        self._current_row: list[str] = []
        self._current_row_classes: list[str] = []   # 当前行每个 td 的 class
        self._current_row_dfields: list[str] = []   # 当前行每个 td 的 data-field
        self._all_rows: list[list[str]] = []
        self._all_rows_classes: list[list[str]] = []
        self._all_rows_dfields: list[list[str]] = []
        self._in_thead = False
        self._in_th = False
        self._in_td = False
        self._in_table = False
        self._cell_text = ""
        self._table_id = ""
        self._row_count = 0

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        if tag == "table":
            self._in_table = True
            self._table_id = attr_dict.get("id", attr_dict.get("data-table", ""))
            self._current_table = {
                "id": self._table_id,
                "headers": [],
                "rows": [],
                "cell_classes": [],   # 与 rows 同 shape，记录每格 class
                "data_fields": [],    # 与 rows 同 shape，记录每格 data-field
            }
            self._all_rows = []
            self._all_rows_classes = []
            self._all_rows_dfields = []
            self._row_count = 0
        elif tag == "thead":
            self._in_thead = True
        elif tag == "th" and self._in_table:
            self._in_th = True
            self._cell_text = ""
        elif tag == "td" and self._in_table:
            self._in_td = True
            self._cell_text = ""
            # 记录该 td 的 class / data-field（供 selector 推断）
            self._current_row_classes.append(attr_dict.get("class", ""))
            self._current_row_dfields.append(attr_dict.get("data-field", ""))
        elif tag == "tr" and self._in_table and not self._in_thead:
            self._current_row = []
            self._current_row_classes = []
            self._current_row_dfields = []

    def handle_endtag(self, tag):
        if tag == "table":
            if self._current_table and self._current_table["headers"]:
                self._current_table["rows"] = self._all_rows
                self._current_table["cell_classes"] = self._all_rows_classes
                self._current_table["data_fields"] = self._all_rows_dfields
                self.tables.append(self._current_table)
            self._current_table = None
            self._in_table = False
        elif tag == "thead":
            self._in_thead = False
        elif tag == "th":
            if self._in_th and self._current_table is not None:
                self._current_table["headers"].append(self._cell_text.strip())
            self._in_th = False
        elif tag == "td":
            if self._in_td:
                self._current_row.append(self._cell_text.strip())
            self._in_td = False
        elif tag == "tr" and self._in_table and not self._in_thead:
            if self._current_row and self._row_count < 20:
                self._all_rows.append(self._current_row)
                self._all_rows_classes.append(self._current_row_classes)
                self._all_rows_dfields.append(self._current_row_dfields)
                self._row_count += 1

    def handle_data(self, data):
        if self._in_th or self._in_td:
            self._cell_text += data


class _DataAttrExtractor(HTMLParser):
    """提取 data-table / data-field 属性。同步收集 selector。"""

    def __init__(self):
        super().__init__()
        self.tables: dict[str, list[dict]] = {}
        self._current_table = ""
        self._current_field = ""
        self._field_text = ""
        self._in_field = False

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        if "data-table" in attr_dict:
            self._current_table = attr_dict["data-table"]
            if self._current_table not in self.tables:
                self.tables[self._current_table] = []
        if "data-field" in attr_dict and self._current_table:
            self._current_field = attr_dict["data-field"]
            self._field_text = ""
            self._in_field = True

    def handle_endtag(self, tag):
        if self._in_field and self._current_field:
            existing_names = [f["name"] for f in self.tables.get(self._current_table, [])]
            if self._current_field not in existing_names:
                # selector：data-field 既能定位 form 输入也能定位展示元素
                selector = f'[data-field="{self._current_field}"]'
                self.tables.setdefault(self._current_table, []).append({
                    "name": self._current_field,
                    "sample_value": self._field_text.strip(),
                    "_selector": selector,
                })
            self._in_field = False
            self._current_field = ""

    def handle_data(self, data):
        if self._in_field:
            self._field_text += data


class _FormExtractor(HTMLParser):
    """从 HTML 中提取 <form> 表单结构。同步收集每个字段的 selector。"""

    _INPUT_TYPE_MAP = {
        "text": "text", "email": "email", "tel": "phone_number",
        "url": "url", "number": "number", "date": "date",
        "datetime-local": "date", "checkbox": "checkbox",
        "hidden": "text", "password": "text", "range": "number",
        "color": "text", "file": "file", "time": "text",
        "month": "date", "week": "date",
    }

    def __init__(self):
        super().__init__()
        self.forms: list[dict] = []
        self._current_form: Optional[dict] = None
        self._in_form = False
        self._in_label = False
        self._label_text = ""
        self._label_for = ""
        # 反向映射：input_id -> label_text，处理 label 出现在 input 之前的情况
        self._pending_labels: dict[str, str] = {}
        self._select_pending_label = ""
        self._in_select = False
        self._select_name = ""
        self._select_id = ""
        self._select_data_field = ""
        self._select_multiple = False
        # 每个 option 是 (text, has_value_attr, value_attr_or_text)
        self._select_options: list[tuple[str, bool, str]] = []
        self._in_option = False
        self._option_text = ""
        self._option_has_value_attr = False
        self._option_value_attr = ""

    @staticmethod
    def _build_form_input_selector(name: str, elem_id: str, data_field: str) -> str:
        """按优先级 [name=] > [data-field=] > [id=] 生成 form_input selector。"""
        if name:
            return f'[name="{name}"]'
        if data_field:
            return f'[data-field="{data_field}"]'
        if elem_id:
            return f'#{elem_id}'
        return ""

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        if tag == "form":
            self._in_form = True
            form_id = attr_dict.get("id", attr_dict.get("data-table", ""))
            self._current_form = {"id": form_id, "fields": []}
        elif self._in_form:
            if tag == "label":
                self._in_label = True
                self._label_text = ""
                self._label_for = attr_dict.get("for", "")
            elif tag == "input":
                input_type = attr_dict.get("type", "text").lower()
                name = attr_dict.get("name", "")
                if name and input_type not in ("submit", "button", "reset", "image"):
                    ftype = self._INPUT_TYPE_MAP.get(input_type, "text")
                    placeholder = attr_dict.get("placeholder", "")
                    elem_id = attr_dict.get("id", "")
                    data_field = attr_dict.get("data-field", "")
                    new_field: dict[str, Any] = {
                        "name": name, "type": ftype,
                        "placeholder": placeholder,
                        "input_id": elem_id,
                        "_form_input": self._build_form_input_selector(name, elem_id, data_field),
                    }
                    # 检查是否有早出现的 label
                    if elem_id and elem_id in self._pending_labels:
                        new_field["label"] = self._pending_labels.pop(elem_id)
                    self._current_form["fields"].append(new_field)
            elif tag == "select":
                self._in_select = True
                self._select_name = attr_dict.get("name", "")
                self._select_id = attr_dict.get("id", "")
                self._select_data_field = attr_dict.get("data-field", "")
                self._select_multiple = "multiple" in attr_dict
                self._select_options = []
                # 预存 select 的 pending label，延后到 select endtag 时挂上
                self._select_pending_label = (
                    self._pending_labels.pop(self._select_id, "")
                    if self._select_id else ""
                )
            elif tag == "option" and self._in_select:
                self._in_option = True
                self._option_text = ""
                # value 属性可能为空字符串，但只要"出现"就视为显式声明
                self._option_has_value_attr = "value" in attr_dict
                self._option_value_attr = attr_dict.get("value", "")
            elif tag == "textarea":
                name = attr_dict.get("name", "")
                if name:
                    elem_id = attr_dict.get("id", "")
                    data_field = attr_dict.get("data-field", "")
                    new_field = {
                        "name": name, "type": "text",
                        "placeholder": attr_dict.get("placeholder", ""),
                        "input_id": elem_id,
                        "_form_input": self._build_form_input_selector(name, elem_id, data_field),
                    }
                    if elem_id and elem_id in self._pending_labels:
                        new_field["label"] = self._pending_labels.pop(elem_id)
                    self._current_form["fields"].append(new_field)

    def handle_endtag(self, tag):
        if tag == "form" and self._in_form:
            if self._current_form and self._current_form["fields"]:
                self.forms.append(self._current_form)
            self._current_form = None
            self._in_form = False
        elif tag == "label":
            if self._in_label and self._label_text.strip() and self._current_form:
                text = self._label_text.strip()
                matched = False
                if self._label_for:
                    for f in self._current_form["fields"]:
                        if f.get("input_id") == self._label_for:
                            f["label"] = text
                            matched = True
                            break
                    if not matched:
                        # input 还没出现 → 暂存
                        self._pending_labels[self._label_for] = text
            self._in_label = False
        elif tag == "select" and self._in_select:
            if self._select_name and self._current_form is not None:
                ftype = "multi_select" if self._select_multiple else "select"
                # 选项纯文本列表（向后兼容）
                option_texts = [t for t, _, _ in self._select_options if t]
                # 推断 options_value_key：
                #   - 所有 option 都带显式 value 属性 → "value"
                #   - 否则（混合或全无） → "text"（保最稳）
                if self._select_options and all(has for _, has, _ in self._select_options):
                    options_value_key = "value"
                else:
                    options_value_key = "text"
                # selector：select 元素本身的 form_input
                selector = self._build_form_input_selector(
                    self._select_name, self._select_id, self._select_data_field,
                )
                field = {
                    "name": self._select_name, "type": ftype,
                    "input_id": self._select_id,
                    "_form_input": selector,
                    "_options_value_key": options_value_key,
                    # 完整 option 元数据（供后续 OPTIONS_MAP 构建）
                    "_options_meta": [
                        {"text": t, "value": v, "has_value": has}
                        for t, has, v in self._select_options
                    ],
                }
                # 挂 select 的 label（来自前置 pending）
                if self._select_pending_label:
                    field["label"] = self._select_pending_label
                    self._select_pending_label = ""
                if option_texts:
                    field["options"] = option_texts
                self._current_form["fields"].append(field)
            self._in_select = False
        elif tag == "option" and self._in_option:
            text = self._option_text.strip()
            if text:
                self._select_options.append(
                    (text, self._option_has_value_attr, self._option_value_attr),
                )
            self._in_option = False
            self._option_has_value_attr = False
            self._option_value_attr = ""

    def handle_data(self, data):
        if self._in_label:
            self._label_text += data
        if self._in_option:
            self._option_text += data


class _RepeatingStructureExtractor(HTMLParser):
    """
    检测重复 DOM 结构（卡片/列表/定义列表）。
    原理：找到相同父级下结构相同的兄弟元素组，提取共同子元素作为字段。

    注意：合法 HTML 解析完毕后 self._stack 会被清空（所有元素均已 pop），
    因此使用 self._roots 单独收集已闭合的根节点，作为后续重复模式分析的入口。
    """

    # 自闭合 / 空元素，HTMLParser 不会发 endtag 事件，需在 starttag 阶段直接闭合
    _VOID_TAGS = frozenset({
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    })

    def __init__(self):
        super().__init__()
        self._stack: list[dict] = []  # 当前未闭合元素栈
        self._roots: list[dict] = []  # 已闭合的顶层根节点（不再属于任何父节点）
        self._depth = 0
        self._current_texts: dict[int, str] = {}  # depth -> accumulated text

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        self._depth += 1
        elem = {
            "tag": tag,
            "attrs": attr_dict,
            "depth": self._depth,
            "children": [],
            "text": "",
        }
        self._current_texts[self._depth] = ""

        # void 元素：立即"闭合"——挂到父节点 children，不入栈，不等 endtag
        if tag in self._VOID_TAGS:
            if self._stack:
                self._stack[-1]["children"].append(elem)
            else:
                self._roots.append(elem)
            self._current_texts.pop(self._depth, None)
            self._depth -= 1
            return

        self._stack.append(elem)

    def handle_startendtag(self, tag, attrs):
        # 显式自闭合写法 <tag />：等价于 starttag + 立即 endtag
        # 直接走 void 路径，避免把没有 children 的占位节点错误入栈
        self.handle_starttag(tag, attrs)
        if tag not in self._VOID_TAGS:
            # 非 void 但用了 /> 写法（如 <span/>）：手动闭合一次
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not self._stack:
            return
        # 容错：endtag 与栈顶不匹配时（HTML 嵌套不规范），向上找最近匹配的祖先并一次性闭合
        match_idx = -1
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i]["tag"] == tag:
                match_idx = i
                break
        if match_idx < 0:
            # 没找到匹配：忽略此次 endtag，不动栈、不动 depth（避免 stack/depth 漂移）
            return

        # 把 [match_idx, end] 这一段全部 pop 并按层级正确挂接
        while len(self._stack) - 1 >= match_idx:
            elem = self._stack.pop()
            elem["text"] = self._current_texts.get(self._depth, "").strip()
            if self._stack:
                self._stack[-1]["children"].append(elem)
            else:
                self._roots.append(elem)
            self._current_texts.pop(self._depth, None)
            self._depth -= 1

    def handle_data(self, data):
        if self._depth in self._current_texts:
            self._current_texts[self._depth] += data

    def get_repeating_groups(self) -> list[dict]:
        """分析所有已闭合根节点的整棵子树，找到重复模式。"""
        # 处理 HTML 残缺、最外层未闭合的兜底场景：把仍在栈中的元素也视作根节点
        roots = list(self._roots)
        if self._stack:
            roots.extend(self._stack)
        if not roots:
            return []
        return self._find_repeating_in_children(roots)

    def _find_repeating_in_children(self, elements: list, depth: int = 0) -> list[dict]:
        if depth > 5:  # 防止过深递归
            return []

        groups = []

        # 按 tag 分组
        tag_groups: dict[str, list] = {}
        for elem in elements:
            tag_groups.setdefault(elem["tag"], []).append(elem)

        for tag, elems in tag_groups.items():
            if len(elems) >= 2 and tag not in ("script", "style", "meta", "link", "br", "hr"):
                # 检查这些元素是否结构同构
                signatures = []
                for e in elems:
                    child_tags = tuple(c["tag"] for c in e.get("children", []))
                    signatures.append(child_tags)

                # 找到最常见的签名
                sig_counter = Counter(signatures)
                most_common_sig, count = sig_counter.most_common(1)[0]
                if count >= 2 and most_common_sig:
                    # 提取字段
                    matching_elems = [e for e, s in zip(elems, signatures) if s == most_common_sig]
                    fields = self._extract_fields_from_group(matching_elems)
                    if fields:
                        # 尝试从 class 或 tag 推断表名
                        first_cls = elems[0].get("attrs", {}).get("class", "")
                        table_name = self._infer_table_name_from_class(first_cls) or f"list_{len(groups) + 1}"
                        groups.append({
                            "name": table_name,
                            "fields": fields,
                            "item_count": count,
                        })

        # 递归检查子元素
        for elem in elements:
            children = elem.get("children", [])
            if children:
                sub_groups = self._find_repeating_in_children(children, depth + 1)
                groups.extend(sub_groups)

        return groups

    def _extract_fields_from_group(self, elems: list) -> list[dict]:
        """从同构元素组中提取字段定义（含 selector mapping）。"""
        if not elems:
            return []

        # 取所有元素的子结构
        all_samples: list[list[dict]] = []
        for elem in elems[:10]:  # 最多分析 10 个
            children = elem.get("children", [])
            sample = []
            for child in children:
                child_class = child.get("attrs", {}).get("class", "")
                child_tag = child["tag"]
                child_text = child.get("text", "")
                sample.append({
                    "tag": child_tag,
                    "class": child_class,
                    "text": child_text,
                })
            all_samples.append(sample)

        if not all_samples or not all_samples[0]:
            return []

        first = all_samples[0]
        fields = []
        for i, child_info in enumerate(first):
            fname = self._infer_field_name_from_class(child_info["class"], child_info["tag"], i)
            col_values = []
            col_classes = []
            col_tags = []
            for sample in all_samples:
                if i < len(sample):
                    col_values.append(sample[i]["text"])
                    col_classes.append(sample[i]["class"])
                    col_tags.append(sample[i]["tag"])

            ftype = _infer_type_from_multiple(col_values)
            field: dict[str, Any] = {"name": fname, "type": ftype}

            # 图片字段
            if child_info["tag"] == "img":
                field["type"] = "url"
                field["name"] = fname if fname != f"field_{i + 1}" else "image"

            # 推断 display_selector
            display_selector = self._pick_repeating_selector(
                col_classes, col_tags, i,
            )
            field["mapping"] = {
                "form_input": None,
                "display_selector": display_selector,
                "render_signal": display_selector,
            }

            fields.append(field)

        return fields

    @staticmethod
    def _pick_repeating_selector(col_classes: list, col_tags: list, idx: int) -> str:
        """为重复结构里的某一列子元素选 selector。

        优先级：
            1. 整列 class 首 token 一致 → `.first-class`
            2. 整列 tag 一致 → `tag:nth-child(N)`
            3. 兜底：`:nth-child(N)`
        """
        first_classes = []
        for cls in col_classes:
            tokens = (cls or "").split()
            first_classes.append(tokens[0] if tokens else "")
        nonempty = [c for c in first_classes if c]
        if nonempty and len(set(nonempty)) == 1 and len(nonempty) == len(first_classes):
            return f'.{nonempty[0]}'

        nonempty_tags = [t for t in col_tags if t]
        if nonempty_tags and len(set(nonempty_tags)) == 1:
            return f'{nonempty_tags[0]}:nth-child({idx + 1})'

        return f':nth-child({idx + 1})'

    @staticmethod
    def _infer_field_name_from_class(cls: str, tag: str, index: int) -> str:
        """从 CSS class 名推断字段名。"""
        if cls:
            # 取第一个 class，清理常见前缀
            parts = cls.split()
            for part in parts:
                cleaned = re.sub(r'^(item[-_]?|card[-_]?|cell[-_]?|col[-_]?|field[-_]?)', '', part)
                if cleaned and re.match(r'^[a-zA-Z]\w*$', cleaned):
                    return cleaned.lower()
                # 直接用 class 名
                if re.match(r'^[a-zA-Z]\w*$', part) and part not in (
                    'container', 'wrapper', 'item', 'card', 'cell', 'col', 'row',
                    'left', 'right', 'top', 'bottom', 'inner', 'outer',
                ):
                    return part.lower()
        # 按 tag 猜测
        tag_guess = {"h1": "title", "h2": "title", "h3": "title",
                     "h4": "title", "h5": "title", "h6": "title",
                     "img": "image", "a": "link", "p": "description",
                     "span": f"field_{index + 1}", "div": f"field_{index + 1}",
                     "time": "date", "address": "address"}
        return tag_guess.get(tag, f"field_{index + 1}")

    @staticmethod
    def _infer_table_name_from_class(cls: str) -> str:
        """从容器 class 推断表名。"""
        if not cls:
            return ""
        parts = cls.split()
        for part in parts:
            # 去掉 -list, -container, -wrapper 等后缀
            cleaned = re.sub(r'[-_](list|container|wrapper|items|group|grid|cards?)$', '', part, flags=re.I)
            if cleaned and re.match(r'^[a-zA-Z]\w*$', cleaned) and cleaned.lower() not in (
                'main', 'content', 'app', 'page', 'section', 'body',
            ):
                return cleaned.lower()
        return ""


class _DivTableExtractor(HTMLParser):
    """
    检测 div 伪表格（CSS Grid/Flexbox 模拟的表格布局）。
    原理：找到带有 header/cell 结构的 div 网格。
    """

    def __init__(self):
        super().__init__()
        self.grids: list[dict] = []
        self._depth = 0
        self._stack: list[dict] = []
        self._current_text = ""

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        self._depth += 1
        cls = attr_dict.get("class", "")
        self._stack.append({
            "tag": tag, "class": cls, "depth": self._depth,
            "children": [], "text": "",
        })
        self._current_text = ""

    def handle_endtag(self, tag):
        if self._stack and self._stack[-1]["tag"] == tag:
            elem = self._stack.pop()
            elem["text"] = self._current_text.strip()
            if self._stack:
                self._stack[-1]["children"].append(elem)
            else:
                # 顶层元素，检查是否是 grid
                self._check_grid(elem)
            self._depth = max(0, self._depth - 1)
            self._current_text = ""

    def handle_data(self, data):
        self._current_text += data

    def _check_grid(self, elem: dict):
        """检查是否是 div 伪表格。"""
        cls = elem.get("class", "")
        children = elem.get("children", [])
        if not children:
            return

        # 检查 class 是否包含 grid/table 相关关键词
        is_grid_like = bool(re.search(r'(grid|table|matrix|board|schedule)', cls, re.I))

        # 检查子元素是否有 header + cell 模式
        header_keywords = re.compile(r'(header|head|th|title|label|col[-_]?name)', re.I)
        cell_keywords = re.compile(r'(cell|td|col|data|value|field)', re.I)

        headers = []
        header_classes = []
        cells = []
        cell_classes = []
        for child in children:
            child_cls = child.get("class", "")
            if header_keywords.search(child_cls):
                headers.append(child.get("text", ""))
                header_classes.append(child_cls)
            elif cell_keywords.search(child_cls):
                cells.append(child.get("text", ""))
                cell_classes.append(child_cls)

        if headers and len(headers) >= 2 and cells:
            # 确认 cells 数量是 headers 的整数倍
            if len(cells) % len(headers) == 0:
                self.grids.append({
                    "headers": headers,
                    "header_classes": header_classes,
                    "cells": cells,
                    "cell_classes": cell_classes,
                    "source_class": cls,
                })

        # 递归检查子元素
        for child in children:
            self._check_grid(child)


# ========== 类型推断 ==========

def _infer_type(value: str) -> str:
    """从单个样本值推断字段类型。"""
    v = value.strip()
    if not v:
        return "text"

    # 日期
    if re.match(r'^\d{4}[-/年]\d{1,2}[-/月]\d{0,2}', v):
        return "date"
    # 月/日/年 格式
    if re.match(r'^\d{1,2}/\d{1,2}/\d{2,4}$', v):
        return "date"

    # 邮箱
    if re.match(r'^[\w.+-]+@[\w.-]+\.\w+$', v):
        return "email"

    # URL
    if re.match(r'^https?://', v, re.I):
        return "url"

    # 电话
    if re.match(r'^[+\d][\d\s\-()]{6,}$', v):
        return "phone_number"

    # 布尔
    if v.lower() in ('true', 'false', '是', '否', '✓', '✗', '√', '×', 'yes', 'no'):
        return "checkbox"

    # 数字（含货币符号、百分号）
    cleaned = re.sub(r'[¥$€£,\s%％]', '', v)
    if cleaned:
        try:
            float(cleaned)
            return "number"
        except ValueError:
            pass

    return "text"


def _infer_type_from_multiple(values: list[str]) -> str:
    """从多个样本值推断字段类型，支持 select 枚举检测。"""
    if not values:
        return "text"

    # 先用单值推断获取基础类型
    type_counts: Counter = Counter()
    non_empty = [v.strip() for v in values if v.strip()]

    if not non_empty:
        return "text"

    for v in non_empty:
        type_counts[_infer_type(v)] += 1

    # 取最常见类型
    base_type = type_counts.most_common(1)[0][0]

    # select 枚举检测：如果基础类型是 text，且值为有限枚举（<=10 种且重复出现）
    if base_type == "text" and len(non_empty) >= 3:
        unique_vals = set(non_empty)
        if len(unique_vals) <= 10 and len(non_empty) > len(unique_vals):
            return "select"

    # multi_select 检测：如果值包含逗号/顿号分隔
    if base_type == "text":
        comma_count = sum(1 for v in non_empty if re.search(r'[,，、]', v))
        if comma_count > len(non_empty) * 0.5:
            return "multi_select"

    return base_type


# ========== 字段名规范化 ==========

# 中文表头 → 英文字段名 映射（增强版）
_CN_FIELD_MAP = {
    # 基础标识
    "编号": "id", "序号": "id", "订单号": "order_id", "ID": "id", "工号": "employee_id",
    "学号": "student_id", "会员号": "member_id", "流水号": "serial_no",
    # 姓名/名称
    "名称": "name", "名字": "name", "姓名": "name", "产品名": "product_name",
    "产品": "product", "商品": "product", "项目名": "project_name", "项目": "project",
    "课程": "course", "活动": "activity", "标题": "title", "主题": "subject",
    # 金额/数量
    "价格": "price", "金额": "amount", "费用": "cost", "单价": "unit_price",
    "总价": "total_price", "数量": "quantity", "数目": "count", "库存": "stock",
    "营收": "revenue", "利润": "profit", "薪资": "salary", "工资": "salary",
    "客单价": "avg_order_value", "成交额": "turnover",
    # 时间
    "日期": "date", "时间": "time", "创建时间": "created_at", "更新时间": "updated_at",
    "开始时间": "start_time", "结束时间": "end_time", "截止日期": "deadline",
    "报名时间": "register_time", "签到时间": "checkin_time",
    # 状态
    "状态": "status", "进度": "progress", "阶段": "stage", "优先级": "priority",
    "等级": "level", "级别": "level",
    # 联系方式
    "邮箱": "email", "电子邮件": "email",
    "电话": "phone", "手机": "phone", "手机号": "phone", "联系方式": "contact",
    "微信": "wechat", "QQ": "qq",
    # 地理
    "地址": "address", "城市": "city", "省份": "province", "国家": "country",
    "地区": "region", "门店": "store",
    # 描述
    "描述": "description", "备注": "remark", "说明": "description",
    "详情": "detail", "内容": "content", "简介": "summary", "评价": "review",
    "留言": "message", "反馈": "feedback", "意见": "opinion",
    # 分类
    "类型": "type", "分类": "category", "品类": "category", "标签": "tags",
    "部门": "department", "团队": "team", "班级": "class_name", "年级": "grade",
    # 人员
    "负责人": "owner", "作者": "author", "创建人": "creator", "审核人": "reviewer",
    "老师": "teacher", "学生": "student", "参与者": "participant",
    # 链接/图片
    "图片": "image", "头像": "avatar", "封面": "cover", "链接": "link",
    "网址": "url", "附件": "attachment",
    # 业务指标
    "KPI": "kpi", "转化率": "conversion_rate", "完成率": "completion_rate",
    "签到码": "checkin_code", "评分": "rating", "得分": "score",
    "排名": "rank", "权重": "weight",
    # 布尔
    "是否": "is_active", "已读": "is_read", "已完成": "is_completed",
    "是否参加": "is_joined",
}


def _normalize_field_name(cn_name: str) -> str:
    """将中文表头转为英文字段名（增强版）。"""
    cn = cn_name.strip()
    if not cn:
        return ""

    # 已经是英文
    if re.match(r'^[a-zA-Z_]\w*$', cn):
        return cn.lower()

    # 精确匹配
    if cn in _CN_FIELD_MAP:
        return _CN_FIELD_MAP[cn]

    # 包含匹配
    for k, v in _CN_FIELD_MAP.items():
        if k in cn:
            return v

    # 尝试用拼音缩写或下划线连接
    # 简单策略：如果全是中文，生成 field_N（后续由 Agent 补全）
    return ""


# ========== 策略函数 ==========

def _extract_js_string_property(body: str, key: str) -> str:
    """从简单 JS object literal 中提取字符串属性值。"""
    m = re.search(
        rf'\b{re.escape(key)}\s*:\s*[\'"]([^\'"]+)[\'"]',
        body,
        re.S,
    )
    return m.group(1).strip() if m else ""


def _parse_html_sdk_calls(html: str) -> Optional[dict]:
    """策略 1：从 __SMART_PAGE__.database.* 调用提取 database 绑定信息。

    与其他策略不同：SDK 命中时不需要建表（HTML 已经接入了一个或多个 database）。
    输出格式与 canonical schema 不同——列出 existing_databases，让 Agent 跳过建表/改造。
    """
    call_re = re.compile(
        r'__SMART_PAGE__\.database\.(?:addRecord|updateRecord|deleteRecord|getRecord|getSchema|query)\s*\(\s*\{(?P<body>.*?)\}\s*\)',
        re.S,
    )
    databases: dict[str, dict[str, str]] = {}
    for match in call_re.finditer(html):
        body = match.group("body")
        db_id = _extract_js_string_property(body, "databaseId")
        if not db_id:
            continue
        databases.setdefault(db_id, {"id": db_id})

    if not databases:
        return None

    existing_databases = [databases[k] for k in sorted(databases)]

    return {
        # 内部字段：合并阶段会用，最终输出会清掉
        "tables": [{"name": db["id"], "fields": [], "confidence": "high"} for db in existing_databases],
        "source": "sdk_calls",
        "sdk_calls_found": True,
        "html_has_template_syntax": False,
        "confidence": "high",
        # 对外契约字段：Agent 直接消费这个
        "existing_databases": existing_databases,
    }


def _parse_html_tables(html: str) -> Optional[dict]:
    """策略 2：从 <table> 结构提取 schema（支持 select 枚举推断）。

    输出每个 field 上挂 `mapping` 子对象，记录列在 HTML 中的物理位置：
      - display_selector：优先 `[data-field=]` > `.first-class` > `td:nth-child(N)`
      - render_signal：固定为 `th:contains('原表头')`
      - form_input：表格场景通常无表单输入 → null
    """
    extractor = _TableExtractor()
    try:
        extractor.feed(html)
    except Exception:
        return None

    if not extractor.tables:
        return None

    result_tables = []
    for idx, tbl in enumerate(extractor.tables):
        headers = tbl["headers"]
        rows = tbl.get("rows", [])
        cell_classes = tbl.get("cell_classes", [])
        data_fields = tbl.get("data_fields", [])
        if not headers:
            continue

        table_name = tbl["id"] or f"table_{idx + 1}"
        fields = []
        for i, h in enumerate(headers):
            # 收集该列所有行的值 / class / data-field
            col_values = [row[i] for row in rows if i < len(row)]
            col_classes = [r[i] for r in cell_classes if i < len(r)]
            col_dfields = [r[i] for r in data_fields if i < len(r)]

            fname = _normalize_field_name(h) or f"field_{i + 1}"

            if len(col_values) >= 2:
                ftype = _infer_type_from_multiple(col_values)
            else:
                ftype = _infer_type(col_values[0]) if col_values else "text"

            # 计算 display_selector
            display_selector = _pick_table_cell_selector(col_dfields, col_classes, i)

            field: dict[str, Any] = {
                "name": fname,
                "type": ftype,
                "description": h,
                "mapping": {
                    "form_input": None,
                    "display_selector": display_selector,
                    "render_signal": f"th:contains('{h}')" if h else "",
                },
            }

            if ftype == "select" and col_values:
                unique_vals = sorted(set(v for v in col_values if v.strip()))
                if unique_vals:
                    field["options"] = unique_vals
                # 表格里的 select 通常通过文本展示（非 <option> 元素）
                field["mapping"]["options_value_key"] = "text"

            fields.append(field)

        if fields:
            result_tables.append({"name": table_name, "fields": fields, "confidence": "high"})

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "table_structure",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "high",
    }


def _pick_table_cell_selector(col_dfields: list[str], col_classes: list[str], col_idx: int) -> str:
    """为 <table> 列选择最稳定的 selector。

    优先级：
        1. 整列 td 都有同一个 data-field → `[data-field="X"]`
        2. 整列 td 都共享同一个 class（首 class 一致）→ `.first-class`
        3. 兜底：`td:nth-child(N)`（N 从 1 计）
    """
    # 1. data-field 一致
    nonempty_dfields = [d for d in col_dfields if d]
    if nonempty_dfields and len(set(nonempty_dfields)) == 1 and len(nonempty_dfields) == len(col_dfields):
        return f'[data-field="{nonempty_dfields[0]}"]'

    # 2. class 首 token 一致
    first_classes = []
    for cls in col_classes:
        if cls:
            tokens = cls.split()
            first_classes.append(tokens[0] if tokens else "")
        else:
            first_classes.append("")
    nonempty_first = [c for c in first_classes if c]
    if nonempty_first and len(set(nonempty_first)) == 1 and len(nonempty_first) == len(first_classes):
        return f'.{nonempty_first[0]}'

    # 3. nth-child 兜底
    return f'td:nth-child({col_idx + 1})'


def _parse_html_forms(html: str) -> Optional[dict]:
    """策略 3：从 <form> 表单结构提取 schema。

    每个 field 上挂 `mapping`：
      - form_input：来自 _FormExtractor 收集的 [name=]/[data-field=]/[id=] selector
      - display_selector：表单页通常无展示视图 → null（混合页由后续合并补齐）
      - options_value_key：仅 select / multi_select 有，由 <option value> 属性推断
    """
    extractor = _FormExtractor()
    try:
        extractor.feed(html)
    except Exception:
        return None

    if not extractor.forms:
        return None

    result_tables = []
    for idx, form in enumerate(extractor.forms):
        table_name = form["id"] or f"form_{idx + 1}"
        fields = []
        seen_names: set[str] = set()
        for f in form["fields"]:
            fname = f["name"]
            if fname in seen_names:
                continue
            seen_names.add(fname)

            mapping: dict[str, Any] = {
                "form_input": f.get("_form_input") or None,
                "display_selector": None,
                # render_signal：表单字段以 label 为主，没有就用 name
                "render_signal": (
                    f"label[for]:contains('{f['label']}')" if f.get("label")
                    else f'[name="{fname}"]'
                ),
            }
            if f["type"] in ("select", "multi_select"):
                mapping["options_value_key"] = f.get("_options_value_key", "text")

            field: dict[str, Any] = {
                "name": fname, "type": f["type"], "mapping": mapping,
            }
            desc = f.get("label") or f.get("placeholder", "")
            if desc:
                field["description"] = desc
            if f["type"] in ("select", "multi_select") and f.get("options"):
                field["options"] = f["options"]
                # 把完整 option 元数据透传出去（后续 normalizer 用来构 OPTIONS_MAP）
                if f.get("_options_meta"):
                    field["_options_meta"] = f["_options_meta"]
            fields.append(field)

        if fields:
            result_tables.append({"name": table_name, "fields": fields, "confidence": "high"})

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "form_structure",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "high",
    }


def _parse_html_data_attrs(html: str) -> Optional[dict]:
    """策略 4：从 data-table / data-field 属性提取 schema。"""
    extractor = _DataAttrExtractor()
    try:
        extractor.feed(html)
    except Exception:
        return None

    if not extractor.tables:
        return None

    result_tables = []
    for table_name, fields_raw in extractor.tables.items():
        fields = []
        for f in fields_raw:
            ftype = _infer_type(f.get("sample_value", ""))
            selector = f.get("_selector") or f'[data-field="{f["name"]}"]'
            fields.append({
                "name": f["name"],
                "type": ftype,
                "mapping": {
                    # data-field 既能定位 form 输入也能定位展示元素
                    "form_input": selector,
                    "display_selector": selector,
                    "render_signal": selector,
                },
            })
        if fields:
            result_tables.append({"name": table_name, "fields": fields, "confidence": "high"})

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "data_attributes",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "high",
    }


def _parse_html_templates(html: str) -> Optional[dict]:
    """策略 5：从 {{xxx}} / ${xxx} 模板占位符提取 schema。"""
    mustache = re.findall(r'\{\{(\w+(?:\.\w+)?)\}\}', html)
    template_lit = re.findall(r'\$\{(\w+(?:\.\w+)?)\}', html)
    all_vars = list(set(mustache + template_lit))

    if not all_vars:
        return None

    tables_map: dict[str, list[str]] = {}
    for v in all_vars:
        if "." in v:
            parts = v.split(".", 1)
            tables_map.setdefault(parts[0], []).append(parts[1])
        else:
            tables_map.setdefault("data", []).append(v)

    result_tables = []
    for tname, fnames in tables_map.items():
        fields = []
        for fn in sorted(set(fnames)):
            # 模板占位符无法精确定位 selector，render_signal 记录占位符样式供后续 normalizer 参考
            fields.append({
                "name": fn, "type": "text",
                "mapping": {
                    "form_input": None,
                    "display_selector": None,
                    "render_signal": f"template:{{{{{fn}}}}}",
                },
            })
        if fields:
            result_tables.append({"name": tname, "fields": fields, "confidence": "medium"})

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "template_syntax",
        "sdk_calls_found": False,
        "html_has_template_syntax": True,
        "confidence": "medium",
    }


def _parse_html_fetch(html: str) -> Optional[dict]:
    """策略 6：从 fetch/XHR 调用提取 table 名。"""
    pattern = r'''fetch\s*\(\s*['"](?:https?://[^'"]*)?/api/(\w+)'''
    matches = re.findall(pattern, html)
    pattern2 = r'''\.open\s*\(\s*['"](?:GET|POST|PUT|DELETE)['"]\s*,\s*['"](?:https?://[^'"]*)?/api/(\w+)'''
    matches += re.findall(pattern2, html, re.I)

    # 也检查 axios 调用
    pattern3 = r'''axios\.(?:get|post|put|delete|patch)\s*\(\s*['"](?:https?://[^'"]*)?/api/(\w+)'''
    matches += re.findall(pattern3, html, re.I)

    if not matches:
        return None

    table_names = list(set(matches))
    result_tables = [{"name": tn, "fields": [], "confidence": "medium"} for tn in sorted(table_names)]

    return {
        "tables": result_tables,
        "source": "fetch_calls",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "medium",
    }


def _parse_html_repeating_structure(html: str) -> Optional[dict]:
    """策略 7：重复结构检测（卡片/列表/定义列表）。"""
    extractor = _RepeatingStructureExtractor()
    try:
        extractor.feed(html)
    except Exception:
        return None

    groups = extractor.get_repeating_groups()
    if not groups:
        # 回退：检测 <ul>/<ol>/<dl> 列表
        return _parse_html_lists(html)

    result_tables = []
    for g in groups:
        if g["fields"]:
            result_tables.append({
                "name": g["name"],
                "fields": g["fields"],
                "confidence": "medium",
                "item_count": g.get("item_count", 0),
            })

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "repeating_structure",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "medium",
    }


def _parse_html_lists(html: str) -> Optional[dict]:
    """策略 7.5：从 <ul>/<ol>/<dl> 列表提取字段。"""

    class _ListExtractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self.lists: list[dict] = []
            self._in_list = False
            self._list_tag = ""
            self._list_id = ""
            self._list_class = ""
            self._items: list[list[dict]] = []
            self._current_item_children: list[dict] = []
            self._in_item = False
            self._in_child = False
            self._child_tag = ""
            self._child_class = ""
            self._child_text = ""
            self._in_dt = False
            self._in_dd = False
            self._dt_text = ""
            self._dd_text = ""
            self._dl_pairs: list[tuple[str, str]] = []

        def handle_starttag(self, tag, attrs):
            attr_dict = dict(attrs)
            if tag in ("ul", "ol"):
                self._in_list = True
                self._list_tag = tag
                self._list_id = attr_dict.get("id", "")
                self._list_class = attr_dict.get("class", "")
                self._items = []
            elif tag == "dl":
                self._in_list = True
                self._list_tag = "dl"
                self._list_id = attr_dict.get("id", "")
                self._list_class = attr_dict.get("class", "")
                self._dl_pairs = []
            elif tag == "li" and self._in_list:
                self._in_item = True
                self._current_item_children = []
            elif self._in_item and tag in ("span", "div", "a", "strong", "em", "b", "i", "time", "p"):
                self._in_child = True
                self._child_tag = tag
                self._child_class = attr_dict.get("class", "")
                self._child_text = ""
            elif tag == "dt" and self._list_tag == "dl":
                self._in_dt = True
                self._dt_text = ""
            elif tag == "dd" and self._list_tag == "dl":
                self._in_dd = True
                self._dd_text = ""

        def handle_endtag(self, tag):
            if tag in ("ul", "ol", "dl") and self._in_list:
                if self._list_tag == "dl" and self._dl_pairs:
                    self.lists.append({
                        "id": self._list_id, "class": self._list_class,
                        "type": "dl", "pairs": self._dl_pairs,
                    })
                elif self._items:
                    self.lists.append({
                        "id": self._list_id, "class": self._list_class,
                        "type": self._list_tag, "items": self._items,
                    })
                self._in_list = False
            elif tag == "li" and self._in_item:
                if self._current_item_children:
                    self._items.append(self._current_item_children)
                self._in_item = False
            elif self._in_child and tag == self._child_tag:
                if self._child_text.strip():
                    self._current_item_children.append({
                        "tag": self._child_tag,
                        "class": self._child_class,
                        "text": self._child_text.strip(),
                    })
                self._in_child = False
            elif tag == "dt" and self._in_dt:
                self._in_dt = False
            elif tag == "dd" and self._in_dd:
                if self._dt_text.strip() and self._dd_text.strip():
                    self._dl_pairs.append((self._dt_text.strip(), self._dd_text.strip()))
                self._in_dd = False

        def handle_data(self, data):
            if self._in_child:
                self._child_text += data
            if self._in_dt:
                self._dt_text += data
            if self._in_dd:
                self._dd_text += data

    extractor = _ListExtractor()
    try:
        extractor.feed(html)
    except Exception:
        return None

    if not extractor.lists:
        return None

    result_tables = []
    for lst in extractor.lists:
        if lst["type"] == "dl":
            # 定义列表 → 每个 dt/dd 对是一个字段
            pairs = lst["pairs"]
            if len(pairs) >= 2:
                fields = []
                for dt, dd in pairs:
                    fname = _normalize_field_name(dt) or dt.lower().replace(" ", "_")
                    ftype = _infer_type(dd)
                    # dl 结构：dd 紧跟在 dt 后，selector 用 dt 文本匹配
                    selector = f"dt:contains('{dt}') + dd"
                    fields.append({
                        "name": fname, "type": ftype, "description": dt,
                        "mapping": {
                            "form_input": None,
                            "display_selector": selector,
                            "render_signal": f"dt:contains('{dt}')",
                        },
                    })
                table_name = lst["id"] or "data"
                result_tables.append({"name": table_name, "fields": fields, "confidence": "low"})
        else:
            # ul/ol 列表
            items = lst.get("items", [])
            if len(items) >= 2 and items[0]:
                first_sig = tuple(c["tag"] for c in items[0])
                matching = [it for it in items if tuple(c["tag"] for c in it) == first_sig]
                if len(matching) >= 2:
                    fields = []
                    for i, child in enumerate(items[0]):
                        cls = child["class"]
                        fname = _RepeatingStructureExtractor._infer_field_name_from_class(
                            cls, child["tag"], i
                        )
                        col_values = []
                        col_classes = []
                        col_tags = []
                        for item in matching[:10]:
                            if i < len(item):
                                col_values.append(item[i]["text"])
                                col_classes.append(item[i]["class"])
                                col_tags.append(item[i]["tag"])
                        ftype = _infer_type_from_multiple(col_values) if col_values else "text"
                        selector = _RepeatingStructureExtractor._pick_repeating_selector(
                            col_classes, col_tags, i,
                        )
                        fields.append({
                            "name": fname, "type": ftype,
                            "mapping": {
                                "form_input": None,
                                "display_selector": selector,
                                "render_signal": selector,
                            },
                        })

                    if fields:
                        table_name = lst["id"] or "list_data"
                        result_tables.append({
                            "name": table_name, "fields": fields, "confidence": "low",
                        })

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "list_structure",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "low",
    }


def _parse_html_div_table(html: str) -> Optional[dict]:
    """策略 8：div 伪表格检测（CSS Grid/Flexbox 模拟的表格）。"""
    extractor = _DivTableExtractor()
    try:
        extractor.feed(html)
    except Exception:
        return None

    if not extractor.grids:
        # 回退：用正则检测带 header/cell class 的连续 div
        return _parse_div_table_by_regex(html)

    result_tables = []
    for grid in extractor.grids:
        headers = grid["headers"]
        cells = grid["cells"]
        header_classes = grid.get("header_classes", [])
        cell_classes = grid.get("cell_classes", [])
        cols = len(headers)

        # 将 cells / cell_classes 按列分组
        col_values: dict[int, list[str]] = {i: [] for i in range(cols)}
        col_cell_classes: dict[int, list[str]] = {i: [] for i in range(cols)}
        for i, cell in enumerate(cells):
            col_idx = i % cols
            col_values[col_idx].append(cell)
            if i < len(cell_classes):
                col_cell_classes[col_idx].append(cell_classes[i])

        fields = []
        for i, h in enumerate(headers):
            fname = _normalize_field_name(h) or f"field_{i + 1}"
            values = col_values.get(i, [])
            ftype = _infer_type_from_multiple(values) if values else "text"

            # selector：优先列 cell class 一致，再退到 header class，再退到 nth-child
            display_selector = _pick_table_cell_selector(
                col_dfields=[],
                col_classes=col_cell_classes.get(i, []),
                col_idx=i,
            )
            if display_selector.startswith("td:") and i < len(header_classes):
                # 没有 cell 级 class，但 header 有 → 用 header 首 token 作 fallback
                hcls = header_classes[i].split()
                if hcls:
                    display_selector = f'.{hcls[0].replace("header", "cell")}'

            field: dict[str, Any] = {
                "name": fname, "type": ftype, "description": h,
                "mapping": {
                    "form_input": None,
                    "display_selector": display_selector,
                    "render_signal": (
                        f'.{header_classes[i].split()[0]}'
                        if i < len(header_classes) and header_classes[i].split()
                        else f"th:contains('{h}')"
                    ),
                },
            }
            if ftype == "select" and values:
                unique_vals = sorted(set(v for v in values if v.strip()))
                if unique_vals:
                    field["options"] = unique_vals
                field["mapping"]["options_value_key"] = "text"
            fields.append(field)

        if fields:
            result_tables.append({
                "name": grid.get("source_class", "grid_table").split()[0].lower(),
                "fields": fields,
                "confidence": "medium",
            })

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "div_table",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "medium",
    }


def _parse_div_table_by_regex(html: str) -> Optional[dict]:
    """用正则检测 class 含 header/cell 的 div 伪表格。"""
    # 找 class 含 header 的 div
    header_pattern = r'<div[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)</div>'
    cell_pattern = r'<div[^>]*class="[^"]*cell[^"]*"[^>]*>(.*?)</div>'

    headers = [m.strip() for m in re.findall(header_pattern, html, re.I | re.S)]
    cells = [m.strip() for m in re.findall(cell_pattern, html, re.I | re.S)]

    # 清理 HTML tags
    def strip_tags(s):
        return re.sub(r'<[^>]+>', '', s).strip()

    headers = [strip_tags(h) for h in headers if strip_tags(h)]
    cells = [strip_tags(c) for c in cells if strip_tags(c)]

    if not headers or len(headers) < 2 or not cells:
        return None

    if len(cells) % len(headers) != 0:
        return None

    cols = len(headers)
    col_values: dict[int, list[str]] = {i: [] for i in range(cols)}
    for i, cell in enumerate(cells):
        col_values[i % cols].append(cell)

    fields = []
    for i, h in enumerate(headers):
        fname = _normalize_field_name(h) or f"field_{i + 1}"
        values = col_values.get(i, [])
        ftype = _infer_type_from_multiple(values) if values else "text"
        # 正则兜底：无足够 class 信息，仅给 render_signal，display_selector 用通用 cell class 通配
        fields.append({
            "name": fname, "type": ftype, "description": h,
            "mapping": {
                "form_input": None,
                "display_selector": f'.cell:nth-child({i + 1})',
                "render_signal": f"div.header:contains('{h}')",
            },
        })

    if not fields:
        return None

    return {
        "tables": [{"name": "grid_data", "fields": fields, "confidence": "medium"}],
        "source": "div_table",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "medium",
    }


def _parse_html_js_data(html: str) -> Optional[dict]:
    """策略 9：从 JavaScript 内联数据对象提取字段。"""
    # 匹配 const/let/var xxx = [ { ... }, { ... } ];
    array_pattern = r'(?:const|let|var)\s+(\w+)\s*=\s*\[(.*?)\]\s*;'
    matches = re.findall(array_pattern, html, re.S)
    # 过滤：内容必须包含至少一个 { ... }
    matches = [(name, content) for name, content in matches if '{' in content and ':' in content]

    if not matches:
        # 也尝试匹配 data: [{ ... }] 或 items: [{ ... }] 等对象属性
        prop_pattern = r'(\w+)\s*:\s*\[(.*?)\]\s*[,}]'
        matches = re.findall(prop_pattern, html, re.S)
        matches = [(name, content) for name, content in matches if '{' in content and ':' in content]

    if not matches:
        return None

    result_tables = []
    for var_name, array_content in matches:
        # 跳过常见的非数据变量
        if var_name.lower() in ('options', 'config', 'settings', 'plugins', 'routes',
                                'headers', 'columns', 'rules', 'validators', 'styles'):
            continue

        # 提取第一个对象的 key
        key_pattern = r'[\'"]?(\w+)[\'"]?\s*:'
        keys = re.findall(key_pattern, array_content)
        if not keys:
            continue

        # 去重保持顺序
        seen = set()
        unique_keys = []
        for k in keys:
            if k not in seen and k.lower() not in ('__v', '_id', '__proto__'):
                seen.add(k)
                unique_keys.append(k)

        # 尝试提取值来推断类型
        fields = []
        for key in unique_keys:
            value_pattern = r'[\'"]?' + re.escape(key) + r'[\'"]?\s*:\s*([\'"]?)([^,}\n]*?)\1\s*[,}]'
            value_matches = re.findall(value_pattern, array_content)
            values = [v[1].strip() for v in value_matches if v[1].strip()]

            ftype = _infer_type_from_multiple(values) if values else "text"
            fields.append({
                "name": key, "type": ftype,
                "mapping": {
                    "form_input": None,
                    "display_selector": None,
                    "render_signal": f"js:{var_name}.{key}",
                },
            })

        if fields and len(fields) >= 2:
            table_name = _normalize_js_var_to_table(var_name)
            result_tables.append({
                "name": table_name,
                "fields": fields,
                "confidence": "medium",
            })

    if not result_tables:
        return None

    return {
        "tables": result_tables,
        "source": "js_data",
        "sdk_calls_found": False,
        "html_has_template_syntax": False,
        "confidence": "medium",
    }


def _normalize_js_var_to_table(var_name: str) -> str:
    """将 JS 变量名规范化为表名。"""
    # camelCase → snake_case
    name = re.sub(r'([A-Z])', r'_\1', var_name).lower().strip('_')
    # 去掉常见后缀
    name = re.sub(r'_(data|list|items|array|records)$', '', name)
    return name or "data"


# ========== 数据库需求预判 ==========

# 强信号 source：明确的结构化数据源
_STRONG_SOURCES = {"sdk_calls", "table_structure", "form_structure", "data_attributes"}
# 中等信号 source：有重复结构但语义不够明确
_MEDIUM_SOURCES = {"repeating_structure", "div_table", "js_data"}
# 弱信号 source：仅占位符 / 列表 / 远程接口名
_WEAK_SOURCES = {"template_syntax", "list_structure", "fetch_calls"}


def _judge_needs_database(results: list[dict]) -> dict:
    """
    判断 HTML 是否需要生成 Database。

    输出：
        {
            "level": "strong" | "medium" | "weak" | "none",
            "reason": "<可读理由，给 Agent 在阶段 0 / 阶段 2 解释用>"
        }

    判定规则：
    - strong：sdk_calls 命中，或任一 table confidence=high 且 source 属于强信号
    - medium：仅命中中等信号 source；或重复结构 item_count >= 3；或表数量 >= 2
    - weak：仅命中弱信号 source（占位符 / 列表 low / 远程接口名）
    - none：所有策略都没命中
    """
    if not results:
        return {"level": "none", "reason": "未识别出任何数据结构信号"}

    has_sdk = any(r.get("sdk_calls_found") for r in results)
    if has_sdk:
        return {"level": "strong", "reason": "HTML 已包含 __SMART_PAGE__.database SDK 调用"}

    # 收集所有命中 source 与最高置信度
    hit_sources: set[str] = set()
    high_conf_tables: list[dict] = []
    medium_conf_tables: list[dict] = []
    max_item_count = 0
    total_tables = 0

    for r in results:
        src = r.get("source", "")
        hit_sources.add(src)
        for t in r.get("tables", []):
            total_tables += 1
            tconf = t.get("confidence", "low")
            ic = t.get("item_count", 0)
            if ic and ic > max_item_count:
                max_item_count = ic
            if tconf == "high":
                high_conf_tables.append(t)
            elif tconf == "medium":
                medium_conf_tables.append(t)

    # 强信号判定
    if any(src in _STRONG_SOURCES for src in hit_sources) and high_conf_tables:
        return {
            "level": "strong",
            "reason": f"识别出 {len(high_conf_tables)} 个高置信度结构化数据源（{','.join(s for s in hit_sources if s in _STRONG_SOURCES)}）",
        }

    # 中等信号判定
    if any(src in _MEDIUM_SOURCES for src in hit_sources):
        if max_item_count >= 3 or total_tables >= 2:
            return {
                "level": "medium",
                "reason": f"识别出重复结构（共 {total_tables} 个候选表，最大重复项 {max_item_count}），可能需要数据库",
            }
        return {
            "level": "medium",
            "reason": f"识别出 {total_tables} 个候选数据结构，但置信度一般，建议与用户确认",
        }

    # 弱信号判定
    if any(src in _WEAK_SOURCES for src in hit_sources):
        return {
            "level": "weak",
            "reason": f"仅识别出弱信号（{','.join(s for s in hit_sources if s in _WEAK_SOURCES)}），可能是静态展示页",
        }

    return {"level": "none", "reason": "未识别出任何数据结构信号"}


# ========== 多策略合并 ==========

_MAPPING_KEYS = ("form_input", "display_selector", "render_signal", "options_value_key")


def _merge_field_mapping(existing: dict, incoming: dict, prefer_existing: bool) -> dict:
    """合并两份 field.mapping。

    规则：每个 key 单独取——非空覆盖空；都非空时按 prefer_existing 决定保留方。
    这样混合页（table + form 双命中）能拿到 display_selector + form_input 的并集。
    """
    if not existing and not incoming:
        return {}
    if not existing:
        return dict(incoming)
    if not incoming:
        return dict(existing)

    out = dict(existing)
    for k in _MAPPING_KEYS:
        e = existing.get(k)
        i = incoming.get(k)
        if e and not i:
            out[k] = e
        elif i and not e:
            out[k] = i
        elif e and i:
            out[k] = e if prefer_existing else i
        else:
            out[k] = e or i  # 两者皆空时保持空
    return out


def _merge_field(existing: dict, incoming: dict, prefer_existing_type: bool) -> dict:
    """同名字段合并：mapping 并集 + options 并集 + 非空字段补全。"""
    out = dict(existing)
    # type：高置信先到的优先
    if not prefer_existing_type and incoming.get("type"):
        out["type"] = incoming["type"]

    # mapping：并集
    out["mapping"] = _merge_field_mapping(
        existing.get("mapping") or {},
        incoming.get("mapping") or {},
        prefer_existing=prefer_existing_type,
    )

    # description：非空补全
    if not out.get("description") and incoming.get("description"):
        out["description"] = incoming["description"]

    # options：去重并集（保持顺序，existing 在前）
    e_opts = existing.get("options") or []
    i_opts = incoming.get("options") or []
    if e_opts or i_opts:
        seen = set()
        merged_opts = []
        for o in list(e_opts) + list(i_opts):
            if o not in seen:
                seen.add(o)
                merged_opts.append(o)
        out["options"] = merged_opts

    # _options_meta：existing 优先（form 策略才会有）
    if existing.get("_options_meta"):
        out["_options_meta"] = existing["_options_meta"]
    elif incoming.get("_options_meta"):
        out["_options_meta"] = incoming["_options_meta"]

    return out


def _merge_results(results: list[dict], title: str = "") -> dict:
    """合并多个策略的解析结果，去重并取高置信度。

    同名字段（同表 + 同 name）按以下规则合并：
      - type：先到且置信度更高的优先
      - mapping：每个 selector 维度并集（非空覆盖空，都非空时 existing 优先）
      - options：去重并集
    """
    all_tables: dict[str, dict] = {}

    source_set = set()
    sdk_found = False
    has_template = False
    overall_confidence = "low"

    confidence_order = {"high": 3, "medium": 2, "low": 1}

    for result in results:
        source_set.add(result.get("source", "unknown"))
        if result.get("sdk_calls_found"):
            sdk_found = True
        if result.get("html_has_template_syntax"):
            has_template = True

        res_conf = result.get("confidence", "low")
        if confidence_order.get(res_conf, 0) > confidence_order.get(overall_confidence, 0):
            overall_confidence = res_conf

        for table in result.get("tables", []):
            tname = table["name"]
            tconf = table.get("confidence", "low")

            if tname not in all_tables:
                all_tables[tname] = {
                    "name": tname,
                    "fields": [],
                    "confidence": tconf,
                    "_field_index": {},   # name -> index in fields
                }
            else:
                existing_conf = all_tables[tname].get("confidence", "low")
                if confidence_order.get(tconf, 0) > confidence_order.get(existing_conf, 0):
                    all_tables[tname]["confidence"] = tconf

            field_index = all_tables[tname]["_field_index"]
            for field in table.get("fields", []):
                fname = field["name"]
                if fname not in field_index:
                    # 首次出现：直接 append
                    field_index[fname] = len(all_tables[tname]["fields"])
                    all_tables[tname]["fields"].append(dict(field))
                else:
                    # 同名再出现：合并 mapping / options
                    pos = field_index[fname]
                    existing = all_tables[tname]["fields"][pos]
                    existing_field_conf = confidence_order.get(
                        existing.get("_origin_confidence", tconf), 0,
                    )
                    incoming_conf = confidence_order.get(tconf, 0)
                    prefer_existing = existing_field_conf >= incoming_conf
                    merged = _merge_field(existing, field, prefer_existing)
                    all_tables[tname]["fields"][pos] = merged

                # 记录该字段最高置信度，供后续合并比较
                all_tables[tname]["fields"][field_index[fname]]["_origin_confidence"] = (
                    max(
                        all_tables[tname]["fields"][field_index[fname]].get("_origin_confidence", tconf),
                        tconf,
                        key=lambda c: confidence_order.get(c, 0),
                    )
                )

    # 清理内部字段
    final_tables = []
    for t in all_tables.values():
        t.pop("_field_index", None)
        for f in t["fields"]:
            f.pop("_origin_confidence", None)
        if t["fields"]:
            final_tables.append(t)

    if not final_tables:
        return {}

    return {
        "tables": final_tables,
        "source": "+".join(sorted(source_set)),
        "sdk_calls_found": sdk_found,
        "html_has_template_syntax": has_template,
        "confidence": overall_confidence,
        "title": title,
        "needs_database": _judge_needs_database(results),
    }


# ========== 规范化输出（canonical schema） ==========
#
# 把 _merge_results 输出的 tables[].fields[] 翻译成 SKILL.md 阶段 1 承诺的
# canonical schema：顶层 properties + field_mapping + page_type，可直接喂给
# create_database.py。


# 英文字段名 → 中文展示名（_CN_FIELD_MAP 的反向 + 常用 alias）
_EN_TO_CN_DISPLAY = {
    "id": "编号", "order_id": "订单编号", "employee_id": "工号",
    "student_id": "学号", "member_id": "会员号", "serial_no": "流水号",
    "name": "名称", "product_name": "产品名称", "product": "产品",
    "project_name": "项目名称", "project": "项目", "course": "课程",
    "title": "标题", "subject": "主题",
    "price": "价格", "amount": "金额", "cost": "费用", "unit_price": "单价",
    "total_price": "总价", "quantity": "数量", "count": "数量",
    "stock": "库存", "revenue": "营收", "profit": "利润",
    "salary": "薪资", "avg_order_value": "客单价", "turnover": "成交额",
    "date": "日期", "time": "时间", "created_at": "创建时间",
    "updated_at": "更新时间", "start_time": "开始时间", "end_time": "结束时间",
    "deadline": "截止日期", "register_time": "报名时间", "checkin_time": "签到时间",
    "status": "状态", "progress": "进度", "stage": "阶段",
    "priority": "优先级", "level": "等级",
    "email": "邮箱", "phone": "电话", "contact": "联系方式",
    "wechat": "微信", "qq": "QQ",
    "address": "地址", "city": "城市", "province": "省份",
    "country": "国家", "region": "地区", "store": "门店",
    "description": "描述", "remark": "备注", "detail": "详情",
    "content": "内容", "summary": "简介", "review": "评价",
    "message": "留言", "feedback": "反馈", "opinion": "意见",
    "type": "类型", "category": "分类", "tags": "标签",
    "department": "部门", "team": "团队", "class_name": "班级", "grade": "年级",
    "owner": "负责人", "author": "作者", "creator": "创建人",
    "reviewer": "审核人", "teacher": "老师", "student": "学生",
    "participant": "参与者",
    "image": "图片", "avatar": "头像", "cover": "封面",
    "link": "链接", "url": "网址", "attachment": "附件",
    "kpi": "KPI", "conversion_rate": "转化率", "completion_rate": "完成率",
    "checkin_code": "签到码", "rating": "评分", "score": "得分",
    "rank": "排名", "weight": "权重",
    "is_active": "是否启用", "is_read": "已读", "is_completed": "已完成",
    "is_joined": "是否参加",
    "dept": "部门", "skills": "技能", "role": "角色", "age": "年龄",
    "gender": "性别", "birthday": "生日", "website": "官网",
    "agree": "同意条款", "agreement": "同意条款", "consent": "同意条款",
    "remarks": "备注", "note": "备注", "notes": "备注",
    "telephone": "电话", "mobile": "手机", "fax": "传真",
    "company": "公司", "position": "职位", "job": "职位",
    "first_name": "名", "last_name": "姓", "full_name": "姓名",
    "user_name": "用户名", "username": "用户名", "password": "密码",
    "nickname": "昵称",
}


# 主标识字段排序识别关键词
_PRIMARY_KEYWORDS_CN = ("名称", "标题", "产品名称", "商品名", "姓名", "项目名")
_PRIMARY_KEYWORDS_EN = ("name", "title", "product_name", "subject")
_TIME_KEYWORDS_CN = ("日期", "时间", "创建时间", "更新时间", "发布日期", "下单日期",
                     "开始时间", "结束时间", "截止日期", "签到时间", "报名时间")
_TIME_KEYWORDS_EN = ("date", "time", "created_at", "updated_at", "start_time",
                     "end_time", "deadline", "checkin_time", "register_time")
_ID_KEYWORDS_CN = ("编号", "订单编号", "单号", "序号", "ID")
_ID_KEYWORDS_EN = ("id", "order_id", "serial_no", "uid", "_id")


def _gen_option_id() -> str:
    """生成 SelectOption 的 id（约 16 位字母数字串，与 SKILL 文档规则等价）。"""
    # 用 base32 去掉 padding，~16 字符
    return secrets.token_urlsafe(12)[:16]


def _en_to_cn_display(name: str) -> str:
    """英文字段名翻译为中文展示名；找不到时原样返回。"""
    if not name:
        return name
    # 已经是中文（含任意 CJK）→ 原样返回
    if any('\u4e00' <= ch <= '\u9fff' for ch in name):
        return name
    # 英文精确匹配
    key = name.lower()
    if key in _EN_TO_CN_DISPLAY:
        return _EN_TO_CN_DISPLAY[key]
    # field_N 形式 → "字段_N"
    if re.match(r'^field_\d+$', key):
        return key.replace("field_", "字段_")
    return name


def _classify_field_priority(field: dict) -> int:
    """字段重要性档位（数字越小越靠前）：
        1 主标识  2 业务核心  3 时间  4 ID
    """
    name = field.get("name", "")
    desc = field.get("description", "") or ""
    ftype = field.get("type", "text")
    name_low = name.lower()

    def hit(name_str: str, kws_cn, kws_en):
        if any(k in name_str for k in kws_cn):
            return True
        return any(k == name_str.lower() or name_str.lower().endswith("_" + k)
                   or name_str.lower().startswith(k + "_") or k == name_str.lower()
                   for k in kws_en)

    # ID 类（最低）—— 注意 select / multi_select 不算主标识，但 ID 类必降到最后
    if hit(name, _ID_KEYWORDS_CN, _ID_KEYWORDS_EN) or hit(desc, _ID_KEYWORDS_CN, ()):
        return 4
    # 时间类（次低）
    if hit(name, _TIME_KEYWORDS_CN, _TIME_KEYWORDS_EN) or ftype == "date":
        return 3
    # 主标识（最高）—— 仅文本类型
    if ftype == "text" and (hit(name, _PRIMARY_KEYWORDS_CN, _PRIMARY_KEYWORDS_EN)
                            or hit(desc, _PRIMARY_KEYWORDS_CN, ())):
        return 1
    # 业务核心
    return 2


def _pick_best_table(tables: list[dict]) -> Optional[dict]:
    """从合并后的多张候选表中挑一张作为主表。

    规则：
        1. confidence 高的优先（high > medium > low）
        2. 同档位下，字段数量多的优先
        3. 都不满足时取第一张
    """
    if not tables:
        return None
    confidence_order = {"high": 3, "medium": 2, "low": 1}
    return max(
        tables,
        key=lambda t: (
            confidence_order.get(t.get("confidence", "low"), 0),
            len([f for f in t.get("fields", []) if f.get("name")]),
        ),
    )


def _resolve_cn_display_name(field: dict) -> str:
    """决定字段在 properties 中的最终展示名（优先用原始信号，不二次翻译）。

    优先级：
        1. field.description（HTML 原始表头/label，最可信，直接保留）
        2. field.name 本身已是中文 → 保留
        3. field.name 在英文翻译表中 → 翻译
        4. label / placeholder（form 字段）
        5. 兜底：原 name
    """
    desc = (field.get("description") or "").strip()
    if desc:
        return desc

    name = (field.get("name") or "").strip()
    if not name:
        return ""

    # name 含 CJK → 直接用
    if any('\u4e00' <= ch <= '\u9fff' for ch in name):
        return name

    # 英文 → 翻译
    cn = _en_to_cn_display(name)
    return cn or name


def _dedup_fields_by_canonical_name(fields: list[dict]) -> list[dict]:
    """按"翻译后的中文展示名"做二次去重。

    场景：同一份 HTML 中 <table> 与重复结构同时命中，可能产出
        {"name":"price"} 和 {"name":"price","class":".price"}
        → 翻译后都是 "价格" → 合并 mapping 取并集
    """
    out: list[dict] = []
    index: dict[str, int] = {}
    for f in fields:
        cn_name = _resolve_cn_display_name(f)
        if not cn_name:
            continue
        if cn_name in index:
            existing = out[index[cn_name]]
            # mapping 并集（复用 _merge_field_mapping）
            existing["mapping"] = _merge_field_mapping(
                existing.get("mapping") or {},
                f.get("mapping") or {},
                prefer_existing=True,
            )
            # options 合并
            e_opts = existing.get("options") or []
            i_opts = f.get("options") or []
            if e_opts or i_opts:
                seen = set()
                merged_opts = []
                for o in list(e_opts) + list(i_opts):
                    if o not in seen:
                        seen.add(o)
                        merged_opts.append(o)
                existing["options"] = merged_opts
            # _options_meta：保留已有
            if not existing.get("_options_meta") and f.get("_options_meta"):
                existing["_options_meta"] = f["_options_meta"]
            # description / type：existing 优先（已是先到的高置信版本）
        else:
            index[cn_name] = len(out)
            new_field = dict(f)
            new_field["_cn_name"] = cn_name
            out.append(new_field)
    return out


def _build_property_config(field: dict) -> dict:
    """根据 field.type 构造 PropertyConfig（oneof）。

    占位值规则：
        text/email/phone_number → ""
        number → {"decimalPlaces": 2, "useSeparate": False}（NumberConfig）
        select/multi_select → {"options": [{"text":..., "id":...}]}
        date → "1970-01-01T00:00:00Z"
        checkbox → False
        url → {"text": "", "link": ""}
        image → {}（空 ImageConfig）
        file → 降级为 text（不在 PropertyConfig 支持列表）
    """
    ftype = field.get("type", "text")

    if ftype in ("text", "email", "phone_number"):
        return {ftype: ""}
    if ftype == "number":
        return {"number": {"decimalPlaces": 2, "useSeparate": False}}
    if ftype in ("select", "multi_select"):
        options_text = field.get("options") or []
        # 用 _options_meta 优先（含完整 text+value）
        meta = field.get("_options_meta") or []
        if meta:
            # meta 里 text 是 <option> 显示文本
            seen = set()
            opts = []
            for m in meta:
                t = (m.get("text") or "").strip()
                if t and t not in seen:
                    seen.add(t)
                    opts.append({"text": t, "id": _gen_option_id()})
        else:
            opts = [{"text": str(o), "id": _gen_option_id()}
                    for o in options_text if str(o).strip()]
        if not opts:
            # 退化为 text（无可用选项）
            return {"text": ""}
        return {ftype: {"options": opts}}
    if ftype == "date":
        return {"date": "1970-01-01T00:00:00Z"}
    if ftype == "checkbox":
        return {"checkbox": False}
    if ftype == "url":
        return {"url": {"text": "", "link": ""}}
    if ftype == "image":
        return {"image": {}}
    # 兜底：file / 未知 → text
    return {"text": ""}


def _build_options_value_map(field: dict, options_in_config: dict) -> dict:
    """为 select / multi_select 字段构造 OPTIONS_MAP 的一份子映射。

    输入：
        options_in_config = {"options": [{"text": "工程部", "id": "..."}, ...]}
        field._options_meta = [{"text": "工程部", "value": "dept_eng", "has_value": True}, ...]

    输出（供 阶段 4 改造 HTML 时直接使用）：
        {
          "dept_eng": {"text": "工程部", "id": "k3..."},
          ...
        }
    第二层 key 由 mapping.options_value_key 决定（"value" 或 "text"）。
    """
    if not options_in_config or "options" not in options_in_config:
        return {}
    cfg_options = options_in_config["options"]
    # text → id 速查
    text_to_id = {o["text"]: o["id"] for o in cfg_options}

    meta = field.get("_options_meta") or []
    options_value_key = (field.get("mapping") or {}).get("options_value_key", "text")

    out = {}
    if meta:
        for m in meta:
            text = (m.get("text") or "").strip()
            value = m.get("value") or ""
            if not text or text not in text_to_id:
                continue
            key = value if (options_value_key == "value" and m.get("has_value")) else text
            if key:
                out[key] = {"text": text, "id": text_to_id[text]}
    else:
        # 没有 meta（重复结构等）→ key 用 text
        for o in cfg_options:
            out[o["text"]] = {"text": o["text"], "id": o["id"]}
    return out


def _infer_page_type(merged: dict) -> str:
    """根据命中的 source 推断 page_type。

    form 单源 → form
    table / repeating / div_table / data_attr / list / template 单源 → display
    form + 任意展示源 → mixed
    js_data / fetch / sdk → display（默认）
    """
    source = merged.get("source") or ""
    parts = source.split("+")

    has_form = "form_structure" in parts
    has_display = any(s in parts for s in (
        "table_structure", "repeating_structure", "div_table",
        "data_attributes", "list_structure", "template_syntax",
    ))

    if has_form and has_display:
        return "mixed"
    if has_form:
        return "form"
    return "display"


def _to_canonical_schema(merged: dict) -> dict:
    """把 _merge_results 的输出翻译成 canonical schema。

    输出顶层结构（与 SKILL.md 阶段 1 承诺的格式一致）：
        {
          "title": "<中文展示名>",
          "page_type": "form | display | mixed",
          "properties": { "<中文字段名>": <PropertyConfig oneof> },
          "field_mapping": { "<中文字段名>": <MappingEntry> },
          "options_map": { "<中文字段名>": { ... } },   // 供阶段 4 OPTIONS_MAP 使用
          "needs_database": {...},
          "confidence": "...",
          "source": "...",
          "sdk_calls_found": bool,
          "html_has_template_syntax": bool
        }

    sdk_calls_found 命中时直接返回输入 merged（已经包含 database_id 列表，不需要 schema）。
    """
    if not merged:
        return {}
    if merged.get("sdk_calls_found"):
        # SDK 已存在 → 不需要建表，原样输出
        return merged

    tables = merged.get("tables", [])
    if not tables:
        return merged

    # 选主表
    main_table = _pick_best_table(tables)
    if not main_table:
        return merged
    # extra_tables 已不再输出——一次只建一张主表，其余表丢弃

    # 字段去重（按中文名）
    raw_fields = main_table.get("fields", [])
    deduped = _dedup_fields_by_canonical_name(raw_fields)
    if not deduped:
        return merged

    # 字段排序
    deduped.sort(key=_classify_field_priority)

    # 组装 properties / field_mapping / options_map
    properties: dict[str, dict] = {}
    field_mapping: dict[str, dict] = {}
    options_map: dict[str, dict] = {}

    for f in deduped:
        cn_name = f["_cn_name"]
        ftype = f.get("type", "text")

        config = _build_property_config(f)
        properties[cn_name] = config

        # field_mapping
        fm: dict[str, Any] = {
            "value_type": ftype if ftype in (
                "text", "number", "select", "multi_select", "date",
                "checkbox", "url", "email", "phone_number", "image",
            ) else "text",
            "form_input": (f.get("mapping") or {}).get("form_input"),
            "display_selector": (f.get("mapping") or {}).get("display_selector"),
            "render_signal": (f.get("mapping") or {}).get("render_signal", ""),
        }
        if ftype in ("select", "multi_select"):
            fm["options_value_key"] = (f.get("mapping") or {}).get("options_value_key", "text")
            # OPTIONS_MAP 子映射
            cfg = config.get(ftype, {}) if isinstance(config.get(ftype), dict) else {}
            sub_map = _build_options_value_map(f, cfg)
            if sub_map:
                options_map[cn_name] = sub_map

        field_mapping[cn_name] = fm

    # title：优先用合并后的 HTML <title>，没有就用主表名翻译
    title = merged.get("title") or _en_to_cn_display(main_table.get("name", "数据"))

    canonical = {
        "title": (title or "数据").strip(),
        "page_type": _infer_page_type(merged),
        "properties": properties,
        "field_mapping": field_mapping,
        "options_map": options_map,
        "needs_database": merged.get("needs_database", {}),
        "confidence": merged.get("confidence", "low"),
        "source": merged.get("source", ""),
        "sdk_calls_found": False,
        "html_has_template_syntax": merged.get("html_has_template_syntax", False),
    }
    return canonical


# ========== 入口 ==========

def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--html", dest="html_file", default="")
    try:
        args, _ = parser.parse_known_args()
    except SystemExit:
        sys.exit(0)

    html_content = ""
    if args.html_file and os.path.isfile(args.html_file):
        try:
            with open(args.html_file, "r", encoding="utf-8") as f:
                html_content = f.read()
        except (OSError, IOError):
            pass

    if not html_content:
        sys.stdout.write("{}")
        return

    # 提取 title（从 head）
    title = _extract_title(html_content)

    # 提取 body（忽略 head 的 meta/css/外部 script 引用）
    body_html = _extract_body(html_content)

    # 策略 1（sdk 调用）需要扫描全文（包括 head 中可能的 inline script）
    # 但实际上 sdk 调用几乎都在 body 中的 <script>，所以也用 body
    # 策略 5（模板占位符）和策略 6（fetch）也只扫描 body

    # 所有策略收集结果
    strategies = [
        ("sdk_calls", _parse_html_sdk_calls),
        ("table", _parse_html_tables),
        ("form", _parse_html_forms),
        ("data_attr", _parse_html_data_attrs),
        ("template", _parse_html_templates),
        ("fetch", _parse_html_fetch),
        ("repeating", _parse_html_repeating_structure),
        ("div_table", _parse_html_div_table),
        ("js_data", _parse_html_js_data),
    ]

    all_results = []

    for name, strategy in strategies:
        try:
            result = strategy(body_html)
            if result and result.get("tables"):
                all_results.append(result)
        except Exception:
            continue  # 单策略失败不影响其他

    # ---- 兜底契约 ----
    # 历史上：所有策略未命中时直接 sys.stdout.write("{}") 让下游自行处理 →
    # 但 SKILL.md §1.1 在 {} 时无 level 可读，只能落到 §3 阶段 1 Step 2 的 Agent 兜底，
    # 又会反问用户「请描述表结构」，对纯静态页（如营销落地页 / 文章页）形成意图死结。
    # 现在统一输出一个最小契约对象，明确告知 needs_database.level=none，让 SKILL.md §1.1 总闸
    # 直接落到仅上传，不再触发任何 Agent 兜底。
    def _empty_static_page_payload() -> dict:
        return {
            "title": title or "",
            "page_type": "display",
            "properties": {},
            "field_mapping": {},
            "options_map": {},
            "needs_database": {
                "level": "none",
                "reason": "未识别出任何数据结构信号（纯静态页面）",
            },
            "source": "",
            "sdk_calls_found": False,
            "html_has_template_syntax": False,
            "confidence": "low",
        }

    if not all_results:
        sys.stdout.write(json.dumps(_empty_static_page_payload(), ensure_ascii=False, indent=2))
        return

    # 如果策略 1（sdk_calls）命中 → 直接输出（已有 SDK 调用，不需要建表/改造）
    sdk_results = [r for r in all_results if r.get("sdk_calls_found")]
    if sdk_results:
        out = dict(sdk_results[0])
        out["needs_database"] = _judge_needs_database(sdk_results)
        # 清理内部字段，对外只暴露 existing_databases / sdk_calls_found / needs_database 等契约字段
        out.pop("tables", None)
        out.pop("html_has_template_syntax", None)
        sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=2))
        return

    # 否则合并所有结果 → 规范化为 canonical schema
    merged = _merge_results(all_results, title=title)
    if not merged:
        sys.stdout.write(json.dumps(_empty_static_page_payload(), ensure_ascii=False, indent=2))
        return

    canonical = _to_canonical_schema(merged)
    if canonical and (canonical.get("properties") or canonical.get("sdk_calls_found")):
        sys.stdout.write(json.dumps(canonical, ensure_ascii=False, indent=2))
    else:
        # canonical 退化成空骨架（没有 properties 也没有 sdk）→ 当作静态页处理
        sys.stdout.write(json.dumps(_empty_static_page_payload(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
