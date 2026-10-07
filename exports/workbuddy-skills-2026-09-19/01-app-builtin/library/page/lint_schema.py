#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mindx-page skill：lint canonical schema

用法：
    # 方式 A：管道直接接 parse_html.py（无 HTML 路径，只查 schema 自洽）
    python3 scripts/parse_html.py --html page.html | python3 scripts/lint_schema.py --stdin

    # 方式 B：命令行参数（同时校验 selector 是否真在 HTML 中）
    python3 scripts/lint_schema.py --schema '<JSON>' --html page.html

输出协议：
    - 全部通过 → stdout 只输出一行 `MINDX_LINT_OK`，exit 0
    - 任一失败 → stdout 逐行输出 `MINDX_LINT_FAIL <rule> <field>: <reason>`，exit 2
    - 输入错误（无法解析 JSON 等） → stderr 一行简短提示，exit 1
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from html.parser import HTMLParser
from typing import Any, Optional


# ========== 校验主流程 ==========

# 顶层必填字段
_REQUIRED_TOP_KEYS = {
    "title", "page_type", "properties", "field_mapping", "options_map",
}
# PropertyConfig 合法的 oneof 类型
_VALID_TYPES = {
    "text", "number", "select", "multi_select", "date",
    "checkbox", "url", "email", "phone_number", "image",
}
_VALID_SELECTOR_RE = re.compile(
    r"""^(
        \[[\w-]+(?:[~|^$*]?=["'][^"']*["'])?\]       # [attr] / [attr="value"]
        |\.[A-Za-z_][\w-]*(?::[\w-]+(?:\([^)]*\))?)? # .class / .class:nth-child(1)
        |\#[A-Za-z_][\w-]*(?::[\w-]+(?:\([^)]*\))?)? # #id / #id:...
        |[A-Za-z][\w-]*(?:\.[A-Za-z_][\w-]*)?(?::[\w-]+(?:\([^)]*\))?)? # td / td.cell / td:nth-child(1)
        |:[\w-]+(?:\([^)]*\))?                       # :nth-child(1) fallback
    )$""",
    re.VERBOSE,
)


def _emit_fail(rule: str, field: str, reason: str, fails: list) -> None:
    """收集一条违规。"""
    fails.append((rule, field, reason))


def lint_schema(schema: dict, html: Optional[str] = None) -> list:
    """
    校验 canonical schema 是否符合契约。

    返回：违规列表 list[(rule, field, reason)]；空列表表示通过。
    """
    fails: list = []

    # SDK 路径直接通过（不需要 schema lint）
    if schema.get("sdk_calls_found"):
        existing_databases = schema.get("existing_databases")
        if not isinstance(existing_databases, list):
            _emit_fail("R1", "_top",
                       "sdk_calls_found=true 但缺少 existing_databases 数组", fails)
        else:
            for i, db in enumerate(existing_databases):
                if isinstance(db, str):
                    continue
                if not isinstance(db, dict) or not db.get("id"):
                    _emit_fail("R1", "_top",
                               f"existing_databases[{i}] 必须是 database id 字符串或含 id 的对象", fails)
        return fails

    # ----- R1 顶层契约字段齐全 -----
    missing = _REQUIRED_TOP_KEYS - set(schema.keys())
    if missing:
        for k in sorted(missing):
            _emit_fail("R1", "_top", f"缺少顶层字段 {k!r}", fails)
        # 顶层缺字段时后续规则可能崩，提前返回
        return fails

    properties = schema.get("properties") or {}
    field_mapping = schema.get("field_mapping") or {}
    options_map = schema.get("options_map") or {}
    page_type = schema.get("page_type", "")

    if not isinstance(properties, dict) or not properties:
        _emit_fail("R1", "_top", "properties 必须是非空 dict", fails)
        return fails
    if not isinstance(field_mapping, dict):
        _emit_fail("R1", "_top", "field_mapping 必须是 dict", fails)
        return fails
    if not isinstance(options_map, dict):
        _emit_fail("R1", "_top", "options_map 必须是 dict", fails)
        return fails

    # ----- R2 properties 与 field_mapping key 一致 -----
    p_keys = set(properties.keys())
    fm_keys = set(field_mapping.keys())
    only_in_p = p_keys - fm_keys
    only_in_fm = fm_keys - p_keys
    for k in sorted(only_in_p):
        _emit_fail("R2", k,
                   "字段在 properties 中存在但 field_mapping 缺失（rename 没同步）", fails)
    for k in sorted(only_in_fm):
        _emit_fail("R2", k,
                   "字段在 field_mapping 中存在但 properties 缺失", fails)

    # 收集所有 selector 用于 R10
    all_selectors: list[tuple[str, str, str]] = []  # (field, role, selector)

    # ----- R5 / R6 PropertyConfig oneof 互斥 + 选项 ID -----
    all_option_ids: dict[str, str] = {}  # id -> "field/option_text"

    for fname, cfg in properties.items():
        if not isinstance(cfg, dict):
            _emit_fail("R5", fname, "PropertyConfig 不是 dict", fails)
            continue
        type_keys = set(cfg.keys()) & _VALID_TYPES
        if len(type_keys) == 0:
            _emit_fail("R5", fname,
                       f"PropertyConfig 没有合法类型 key，got={list(cfg.keys())}", fails)
            continue
        if len(type_keys) > 1:
            _emit_fail("R5", fname,
                       f"PropertyConfig oneof 冲突：同时含 {sorted(type_keys)}", fails)
            continue

        ftype = next(iter(type_keys))
        type_value = cfg[ftype]

        # R6: select / multi_select 选项校验
        if ftype in ("select", "multi_select"):
            if not isinstance(type_value, dict) or "options" not in type_value:
                _emit_fail("R6", fname,
                           f"{ftype} 配置缺少 options 数组", fails)
                continue
            opts = type_value.get("options") or []
            if not isinstance(opts, list) or not opts:
                _emit_fail("R6", fname, f"{ftype} options 必须是非空数组", fails)
                continue
            for i, opt in enumerate(opts):
                if not isinstance(opt, dict):
                    _emit_fail("R6", fname,
                               f"option[{i}] 不是 dict", fails)
                    continue
                text = opt.get("text")
                opt_id = opt.get("id")
                if not text or not isinstance(text, str):
                    _emit_fail("R6", fname,
                               f"option[{i}] 缺少非空 text", fails)
                if not opt_id or not isinstance(opt_id, str):
                    _emit_fail("R6", fname,
                               f"option[{i}] 缺少非空 id", fails)
                    continue
                if opt_id in all_option_ids:
                    _emit_fail("R6", fname,
                               f"option id 与 {all_option_ids[opt_id]!r} 冲突 (id={opt_id})",
                               fails)
                else:
                    all_option_ids[opt_id] = f"{fname}/{text}"

    # ----- R3 / R4 / R8 / R9 field_mapping 项校验 -----
    display_selectors_present = []
    form_inputs_present = []

    for fname, mapping in field_mapping.items():
        if fname not in p_keys:
            continue  # 已在 R2 报过
        if not isinstance(mapping, dict):
            _emit_fail("R3", fname, "field_mapping 项不是 dict", fails)
            continue

        form_input = mapping.get("form_input")
        display_selector = mapping.get("display_selector")
        value_type = mapping.get("value_type", "")

        # R3 selector 形态校验
        for role, sel in (("form_input", form_input),
                          ("display_selector", display_selector)):
            if sel is None:
                continue  # null 合法
            if not isinstance(sel, str) or not sel.strip():
                _emit_fail("R3", fname,
                           f"{role} 必须是 null 或非空字符串", fails)
                continue
            if not _is_valid_selector_shape(sel):
                _emit_fail("R3", fname,
                           f"{role}={sel!r} 不是合法 selector（应为简单 CSS selector，或为 null）",
                           fails)
                continue
            all_selectors.append((fname, role, sel))

        # R4 select / multi_select 必须有 options_value_key
        if value_type in ("select", "multi_select"):
            ovk = mapping.get("options_value_key")
            if ovk not in ("value", "text"):
                _emit_fail("R4", fname,
                           f"{value_type} 字段缺少合法 options_value_key（应为 'value' 或 'text'，got={ovk!r}）",
                           fails)

        if display_selector:
            display_selectors_present.append(fname)
        if form_input:
            form_inputs_present.append(fname)

    # ----- R8 / R9 视图 selector 完整性 -----
    if page_type in ("display", "mixed") and not display_selectors_present:
        _emit_fail("R8", "_top",
                   f"page_type={page_type} 但没有任何字段提供 display_selector", fails)
    if page_type in ("form", "mixed") and not form_inputs_present:
        _emit_fail("R9", "_top",
                   f"page_type={page_type} 但没有任何字段提供 form_input", fails)

    # ----- R7 options_map 与 properties 一致 -----
    select_fields = set()
    for fname, cfg in properties.items():
        if not isinstance(cfg, dict):
            continue
        if "select" in cfg or "multi_select" in cfg:
            select_fields.add(fname)

    for fname in sorted(select_fields - set(options_map.keys())):
        _emit_fail("R7", fname, "select/multi_select 字段缺少 options_map 映射", fails)

    for fname, sub_map in options_map.items():
        if fname not in properties:
            _emit_fail("R7", fname,
                       "options_map 中存在但 properties 不存在", fails)
            continue
        cfg = properties[fname]
        # 找 select / multi_select 配置
        opt_cfg = cfg.get("select") or cfg.get("multi_select") or {}
        if not opt_cfg:
            _emit_fail("R7", fname, "options_map 只能用于 select/multi_select 字段", fails)
            continue
        cfg_options = opt_cfg.get("options") or []
        cfg_id_map = {o["text"]: o["id"]
                      for o in cfg_options if isinstance(o, dict) and o.get("text")}
        cfg_ids = set(cfg_id_map.values())
        seen_entry_ids = set()

        if not isinstance(sub_map, dict) or not sub_map:
            _emit_fail("R7", fname, "options_map 项必须是非空 dict", fails)
            continue
        for key2, entry in sub_map.items():
            if not isinstance(entry, dict):
                _emit_fail("R7", fname,
                           f"options_map[{key2!r}] 不是 dict", fails)
                continue
            text = entry.get("text")
            entry_id = entry.get("id")
            if not text or not entry_id:
                _emit_fail("R7", fname,
                           f"options_map[{key2!r}] 缺少 text 或 id", fails)
                continue
            seen_entry_ids.add(entry_id)
            if cfg_id_map and cfg_id_map.get(text) != entry_id:
                _emit_fail("R7", fname,
                           f"options_map[{key2!r}].id={entry_id!r} 与 properties 中 option(text={text!r}).id={cfg_id_map.get(text)!r} 不一致",
                           fails)
        missing_ids = cfg_ids - seen_entry_ids
        if missing_ids:
            _emit_fail("R7", fname,
                       f"options_map 未覆盖 properties 中的选项 id: {sorted(missing_ids)}", fails)

    # ----- R10 selector 在 HTML 中可解析 -----
    if html and all_selectors:
        existing_classes, existing_ids, existing_attrs, existing_tags = _scan_html_targets(html)
        for fname, role, sel in all_selectors:
            if not _selector_likely_present(sel, existing_classes,
                                            existing_ids, existing_attrs,
                                            existing_tags):
                _emit_fail("R10", fname,
                           f"{role}={sel!r} 在 HTML 中找不到匹配元素", fails)

    return fails


# ========== HTML 简易扫描（用于 R10） ==========

class _HtmlTargetScanner(HTMLParser):
    """收集 HTML 中存在的 class / id / attr 名 / tag 名。"""

    def __init__(self):
        super().__init__()
        self.classes: set = set()
        self.ids: set = set()
        # attrs: {"name": {"value1", "value2"}, "data-field": {...}}
        self.attrs: dict = {}
        self.tags: set = set()

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        for k, v in attrs:
            if k == "class" and v:
                for c in v.split():
                    self.classes.add(c)
            elif k == "id" and v:
                self.ids.add(v)
            else:
                self.attrs.setdefault(k, set()).add(v or "")


def _is_valid_selector_shape(sel: str) -> bool:
    """校验 parse_html.py 会输出的简单 selector 形态。"""
    return bool(_VALID_SELECTOR_RE.match(sel.strip()))


def _scan_html_targets(html: str):
    scanner = _HtmlTargetScanner()
    try:
        scanner.feed(html)
    except Exception:
        pass
    return scanner.classes, scanner.ids, scanner.attrs, scanner.tags


def _selector_likely_present(sel: str, classes: set, ids: set,
                             attrs: dict, tags: set) -> bool:
    """非完整 CSS 引擎，仅判断 selector 中的关键 token 是否在 HTML 中存在。

    覆盖：
      - .class
      - #id
      - [attr="value"]
      - tag:nth-child(N) / tag (仅判断 tag 是否存在)
      - dt:contains('...') 等 jQuery 风格仅检查 tag 存在
    """
    s = sel.strip()
    # [attr="value"]
    m = re.match(r'^\[([\w-]+)(?:[~|^$*]?=["\']?([^"\']*)["\']?)?\]$', s)
    if m:
        attr_name, attr_value = m.group(1), m.group(2)
        existing_values = attrs.get(attr_name)
        if existing_values is None:
            return False
        if attr_value is None:
            return True
        return attr_value in existing_values
    # #id
    if s.startswith("#"):
        return s[1:] in ids
    # .class（可能后接 :nth-child(N) 等，取首段）
    if s.startswith("."):
        first_token = re.split(r'[:\s>+~]', s[1:], 1)[0]
        return first_token in classes
    # tag:contains / tag:nth-child / 纯 tag
    tag_match = re.match(r'^([\w-]+)', s)
    if tag_match:
        return tag_match.group(1) in tags
    # 兜底：放过（避免误报）
    return True


# ========== 入口 ==========

def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--schema", default="")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--html", default="")
    try:
        args, _ = parser.parse_known_args()
    except SystemExit:
        sys.stderr.write("invalid args\n")
        sys.exit(1)

    raw = ""
    if args.schema:
        raw = args.schema
    elif args.stdin:
        try:
            raw = sys.stdin.read()
        except (OSError, IOError):
            raw = ""

    if not raw or not raw.strip():
        sys.stderr.write("no schema input (use --schema or --stdin)\n")
        sys.exit(1)

    try:
        schema = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"invalid JSON: {e}\n")
        sys.exit(1)
    if not isinstance(schema, dict):
        sys.stderr.write("schema must be a JSON object\n")
        sys.exit(1)

    html_content = ""
    if args.html:
        if os.path.isfile(args.html):
            try:
                with open(args.html, "r", encoding="utf-8") as f:
                    html_content = f.read()
            except (OSError, IOError):
                pass
        else:
            sys.stderr.write(f"html file not found: {args.html}\n")
            # 不致命，只跳过 R10

    fails = lint_schema(schema, html=html_content or None)

    if not fails:
        sys.stdout.write("MINDX_LINT_OK\n")
        sys.exit(0)

    for rule, field, reason in fails:
        sys.stdout.write(f"MINDX_LINT_FAIL {rule} {field}: {reason}\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
