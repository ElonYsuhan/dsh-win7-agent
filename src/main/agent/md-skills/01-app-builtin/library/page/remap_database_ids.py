#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
page/remap_database_ids.py —— HTML 内 databaseId 全局重映射（纯本地，无网络 / 无 token）

用于「HTML 产物复刻」链路：源页面 HTML 里硬编码的旧 databaseId（db_old）需整体
替换成复刻出的新 databaseId（db_new），使复刻页指向复刻后的表。

行为：
    1. 读入口 HTML + 映射表 M = {db_old: db_new}
    2. 对全文按 M 做 db_old → db_new 精确替换（带 id 边界，防子串误伤）
    3. 硬门校验：
       (a) 替换后不残留任何 db_old
       (b) 每个 db_new 的新增出现次数 == 对应 db_old 的原出现次数
       任一不过 → 报错停止，不写出残缺页
    4. 写回（默认就地覆盖 --html；或写到 --out）
    5. 成功 → stdout 一行 "KS_REMAP_OK <JSON>"（含每个 id 替换次数），exit 0
       失败 → stdout 单行 {"error":"<msg>"} 后 exit 0

用法：
    python3 page/remap_database_ids.py --html page.html --mapping '{"db_old":"db_new"}'
    python3 page/remap_database_ids.py --html page.html --mapping @mapping.json --out out.html

约定:
    - 纯本地脚本，不需要 --token-stdin
    - --mapping 传 JSON 对象字符串，或 @<path> 从文件读 JSON
    - old/new 值须是非空字符串且互不重叠（old 集合与 new 集合无交集，避免链式替换）
    - 采用一次性并发替换，不会 A→B 后又把 B→C
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import NoReturn


def _die(msg: str) -> NoReturn:
    """失败统一出口：stdout 单行 {"error":...} 后 exit 0（与其它脚本对齐）。"""
    sys.stdout.write(json.dumps({"error": msg}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(0)


# databaseId 合法字符集（字母数字下划线连字符）；用于边界断言。
_ID_CHAR = r"[A-Za-z0-9_-]"


def _load_mapping(raw: str) -> dict[str, str]:
    raw = (raw or "").strip()
    if not raw:
        _die("mapping 缺失")
    if raw.startswith("@"):
        p = Path(raw[1:]).expanduser()
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError as e:
            _die(f"读取 mapping 文件失败: {e}")
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        _die("mapping JSON 格式非法")
    if not isinstance(obj, dict) or not obj:
        _die("mapping 必须是非空 JSON 对象")

    mapping: dict[str, str] = {}
    for k, v in obj.items():
        ks, vs = str(k).strip(), str(v).strip()
        if not ks or not vs:
            _die("mapping 的 key/value 不能为空")
        mapping[ks] = vs
    # old 与 new 集合不得相交，避免链式/循环替换歧义。
    if set(mapping) & set(mapping.values()):
        _die("mapping 的 old 集合与 new 集合存在交集，拒绝链式替换")
    return mapping


def _count_id(text: str, ident: str) -> int:
    """带边界统计 ident 出现次数：前后不能是 id 合法字符，防子串误计。"""
    pat = re.compile(rf"(?<!{_ID_CHAR}){re.escape(ident)}(?!{_ID_CHAR})")
    return len(pat.findall(text))


def _remap_once(text: str, mapping: dict[str, str]) -> str:
    """一次性替换所有 old（不链式）：单个正则交替匹配，命中后查表换 new。"""
    olds = sorted(mapping, key=len, reverse=True)
    pat = re.compile(
        rf"(?<!{_ID_CHAR})(?:" + "|".join(re.escape(o) for o in olds) + rf")(?!{_ID_CHAR})"
    )
    return pat.sub(lambda m: mapping[m.group(0)], text)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--html", dest="html", default="")
    parser.add_argument("--mapping", dest="mapping", default="")
    parser.add_argument("--out", dest="out", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        _die("参数解析失败")

    html_path = Path((args.html or "").strip()).expanduser()
    if not args.html or not html_path.is_file():
        _die("html 路径无效或文件不存在")

    mapping = _load_mapping(args.mapping)

    try:
        text = html_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        _die(f"读取 HTML 失败: {e}")

    # 记录每个 old 的原出现次数。
    old_counts = {old: _count_id(text, old) for old in mapping}
    if all(c == 0 for c in old_counts.values()):
        _die("HTML 中未找到任何待替换的 databaseId")

    new_text = _remap_once(text, mapping)

    # ---- 硬门 (a): 无残留任何 old ----
    residual = {old: _count_id(new_text, old) for old in mapping if _count_id(new_text, old)}
    if residual:
        _die(f"替换后仍残留旧 databaseId: {residual}")

    # ---- 硬门 (b): 每个 new 的新增次数 == 对应 old 原次数 ----
    #   new 可能本就在原文出现（一般不会，但严格核对）：新增数 = 现次数 - 原次数。
    stats: dict[str, int] = {}
    mismatches: dict[str, str] = {}
    for old, new in mapping.items():
        expected = old_counts[old]
        before_new = _count_id(text, new)
        after_new = _count_id(new_text, new)
        added = after_new - before_new
        stats[old] = expected
        if added != expected:
            mismatches[old] = f"expected {expected}, got {added}"
    if mismatches:
        _die(f"替换计数校验不通过: {mismatches}")

    # ---- 写出 ----
    out_path = Path((args.out or "").strip()).expanduser() if args.out else html_path
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(new_text, encoding="utf-8")
    except OSError as e:
        _die(f"写出 HTML 失败: {e}")

    output = {
        "out": str(out_path),
        "replaced": {old: {"new": mapping[old], "count": stats[old]} for old in mapping},
        "total": sum(stats.values()),
    }
    sys.stdout.write(
        "KS_REMAP_OK "
        + json.dumps(output, ensure_ascii=False, separators=(",", ":"))
        + "\n"
    )


if __name__ == "__main__":
    main()
