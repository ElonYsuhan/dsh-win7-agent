#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
table_edit_helper.py
====================

本地表格组件算子脚本（纯本地、无网络、无 token）。

用途 —— 表格行列矩阵结构变换
------------------------------
输入完整 `<Table>...</Table>` 和行列操作，输出变换后的完整 Table 组件文本。
列宽、表头开关、合并单元格和 cell 富文本保真不属于本脚本能力。

是否应使用本脚本、目标 block 准入和最终 actions 统一按
`doc/tasks/table_edit.md` 判断；审阅卡由 `doc/action_decision.md` 决定。
本脚本只生成组件文本，不提交修改。

它解决的是 Agent 侧痛点
----------------------
  1. 结构级变更时不用手抄整表，token / 语法出错率 / 重试次数下降；
  2. 把「TableCell 内文字必须包 <Paragraph>」「禁 id / readonly」「4 空格缩进无
     Tab」「子块间无空行」等组件语法约束收敛到本脚本里。

它只生成组件语法，不提交修改；整表 `delete + insert` 后 Table 内所有
blockId 都会变。这只是 Agent 侧的语法辅助，不承担 blockId 稳定性。

CLI
---
    python3 table_edit_helper.py \
        --op <insert_row|delete_row|insert_column|delete_column|set_table> \
        --table-content '<Table>...</Table>' \
        --args '{"...": "..."}'

    # 自检用例外置在 scripts/fixtures/table_edit_helper_cases.json
    # 扩展新用例只需编辑 JSON，无需改脚本
    python3 table_edit_helper.py --self-check

stdout 协议
-----------
成功：
    KS_TABLE_EDIT_HELPER_SUCCESS
    {"new_table_content": "<Table>...</Table>"}

失败：
    KS_TABLE_EDIT_HELPER_ERROR
    {"code": "<ERR_CODE>", "message": "<脱敏原因>"}

自检成功：
    KS_TABLE_EDIT_HELPER_SELFCHECK_OK

退出码统一 0（协议对齐现有 doc/*.py 脚本）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from html import escape as html_escape, unescape as html_unescape
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ------------------------------------------------------------------
# 配置
# ------------------------------------------------------------------

MAX_ROWS = 200
MAX_COLS = 20
INDENT = "    "  # 一级缩进 4 空格，禁 Tab
SUPPORTED_OPS = {
    "insert_row",
    "delete_row",
    "insert_column",
    "delete_column",
    "set_table",
}

# ------------------------------------------------------------------
# 输出协议
# ------------------------------------------------------------------

def _emit_success(new_table_content: str) -> None:
    print("KS_TABLE_EDIT_HELPER_SUCCESS")
    print(json.dumps({"new_table_content": new_table_content}, ensure_ascii=False))


def _emit_error(code: str, message: str) -> None:
    print("KS_TABLE_EDIT_HELPER_ERROR")
    print(json.dumps({"code": code, "message": message}, ensure_ascii=False))


class HelperError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------
# 解析：<Table> 组件语法 -> 二维 cells (list[list[str]])
# ------------------------------------------------------------------
#
# 只支持规范定义的结构：
#   <Table> -> <TableRow>+
#   <TableRow> -> <TableCell>+
#   <TableCell> -> <Paragraph>...</Paragraph> (纯文本, 允许 <Mark>/<Link> 之类 inline)
#
# 不支持 rowspan / colspan（规范未定义），遇到直接拒绝。

_TABLE_OPEN = re.compile(r"<Table(\s[^>]*)?>", re.IGNORECASE)
_TABLE_CLOSE = re.compile(r"</Table\s*>", re.IGNORECASE)
_ROW_OPEN = re.compile(r"<TableRow(\s[^>]*)?>", re.IGNORECASE)
_ROW_CLOSE = re.compile(r"</TableRow\s*>", re.IGNORECASE)
_CELL_OPEN = re.compile(r"<TableCell(\s[^>]*)?>", re.IGNORECASE)
_CELL_CLOSE = re.compile(r"</TableCell\s*>", re.IGNORECASE)

# 只允许 TableCell 内出现 <Paragraph>...</Paragraph>；遇到 <Mark>/<Link> 等 inline 富文本时拒绝，避免静默丢样式或链接。
_PARA_BLOCK = re.compile(
    r"<Paragraph(?:\s[^>]*)?>(?P<inner>.*?)</Paragraph\s*>",
    re.IGNORECASE | re.DOTALL,
)
_INLINE_TAG = re.compile(r"</?\s*(Mark|Link)\b", re.IGNORECASE)

# 检测跨行/跨列合并（规范未定义 → 直接拒绝）
_SPAN_ATTR = re.compile(r"\b(rowspan|colspan|rowSpan|colSpan)\s*=", re.IGNORECASE)


def _strip_inline_tags(text: str) -> str:
    """
    把 Paragraph 内允许的 inline 标签（<Mark>/<Link>）剥离，只保留纯文本。
    第一版收敛：算子输入/输出的 cells 一律是纯文本；不承担 inline 样式的保真。
    Agent 若需要保留 Mark/Link，请手工生成完整新表（不经过本脚本）。
    """
    # 去掉常见 inline 开闭标签
    text = re.sub(r"<Mark(?:\s[^>]*)?>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"</Mark\s*>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<Link(?:\s[^>]*)?>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"</Link\s*>", "", text, flags=re.IGNORECASE)
    # 折叠所有换行/多空白为单空格；解析已有实体后，输出阶段统一重新转义，避免二次转义。
    text = re.sub(r"\s+", " ", text).strip()
    return html_unescape(text)


def _parse_table_content(table_content: str) -> List[List[str]]:
    if not isinstance(table_content, str) or not table_content.strip():
        raise HelperError("EMPTY_TABLE_CONTENT", "--table-content 为空")

    if _SPAN_ATTR.search(table_content):
        raise HelperError(
            "UNSUPPORTED_SPAN",
            "检测到 rowspan/colspan 合并单元格，当前规范未定义，脚本拒绝处理",
        )

    m_open = _TABLE_OPEN.search(table_content)
    m_close = _TABLE_CLOSE.search(table_content)
    if not m_open or not m_close or m_close.start() < m_open.end():
        raise HelperError(
            "INVALID_TABLE_CONTENT",
            "未找到成对的 <Table>...</Table>",
        )

    inner = table_content[m_open.end(): m_close.start()]

    # 逐行切
    rows: List[List[str]] = []
    pos = 0
    while True:
        rm = _ROW_OPEN.search(inner, pos)
        if not rm:
            break
        rc = _ROW_CLOSE.search(inner, rm.end())
        if not rc:
            raise HelperError(
                "INVALID_TABLE_CONTENT",
                "存在未闭合的 <TableRow>",
            )
        row_body = inner[rm.end(): rc.start()]
        pos = rc.end()

        # 逐 cell 切
        cells: List[str] = []
        cpos = 0
        while True:
            cm = _CELL_OPEN.search(row_body, cpos)
            if not cm:
                break
            cc = _CELL_CLOSE.search(row_body, cm.end())
            if not cc:
                raise HelperError(
                    "INVALID_TABLE_CONTENT",
                    "存在未闭合的 <TableCell>",
                )
            cell_body = row_body[cm.end(): cc.start()]
            cpos = cc.end()

            if _INLINE_TAG.search(cell_body):
                raise HelperError(
                    "UNSUPPORTED_INLINE_CONTENT",
                    "检测到 Mark/Link 等 inline 富文本；为避免丢样式或链接，脚本拒绝处理",
                )

            # cell 内应有至少 1 个 <Paragraph>；取其纯文本
            paras = _PARA_BLOCK.findall(cell_body)
            if paras:
                text = "\n".join(_strip_inline_tags(p) for p in paras)
            else:
                # 兼容 cell 里意外只写了裸文本的情况：也剥成纯文本
                # 但仍视为格式不规范（这里不抛错，尽量宽进严出）
                text = _strip_inline_tags(cell_body)
            cells.append(text)

        if cells:
            rows.append(cells)

    if not rows:
        raise HelperError(
            "EMPTY_TABLE",
            "解析出 0 行，无法作为已有表格处理",
        )

    # 列数一致性
    col_count = len(rows[0])
    for i, r in enumerate(rows):
        if len(r) != col_count:
            raise HelperError(
                "COL_LENGTH_MISMATCH",
                f"表格列数不一致：第 1 行 {col_count} 列，第 {i + 1} 行 {len(r)} 列",
            )

    return rows


# ------------------------------------------------------------------
# 序列化：二维 cells -> 合法组件语法
# ------------------------------------------------------------------

def _render_cell_text(text: str) -> str:
    """
    把 cell 文本渲染成 <Paragraph>...</Paragraph>。
    多行文本按换行拆成多个 <Paragraph>。空文本渲染成一个空 <Paragraph></Paragraph>。
    对 <, >, & 做 XML 实体转义，防止用户把裸尖括号塞进来污染结构。
    """
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise HelperError(
            "INVALID_CELL_TEXT",
            f"cell 文本必须是字符串，收到 {type(text).__name__}",
        )
    lines = text.split("\n") if text else [""]
    out: List[str] = []
    for ln in lines:
        # 剥掉两端多余空白；转义
        safe = html_escape(ln.strip(), quote=False)
        out.append(f"{INDENT * 3}<Paragraph>{safe}</Paragraph>")
    return "\n".join(out)


def _render_table_content(cells: List[List[str]]) -> str:
    if not cells:
        raise HelperError("EMPTY_TABLE", "结果表格 0 行，拒绝输出")
    row_count = len(cells)
    col_count = len(cells[0])
    if row_count > MAX_ROWS:
        raise HelperError(
            "ROW_LIMIT_EXCEEDED",
            f"行数 {row_count} 超过上限 {MAX_ROWS}",
        )
    if col_count > MAX_COLS:
        raise HelperError(
            "COL_LIMIT_EXCEEDED",
            f"列数 {col_count} 超过上限 {MAX_COLS}",
        )
    for i, r in enumerate(cells):
        if len(r) != col_count:
            raise HelperError(
                "COL_LENGTH_MISMATCH",
                f"输出表格列数不一致：第 1 行 {col_count} 列，第 {i + 1} 行 {len(r)} 列",
            )

    parts: List[str] = ["<Table>"]
    for row in cells:
        parts.append(f"{INDENT}<TableRow>")
        for cell in row:
            parts.append(f"{INDENT * 2}<TableCell>")
            parts.append(_render_cell_text(cell))
            parts.append(f"{INDENT * 2}</TableCell>")
        parts.append(f"{INDENT}</TableRow>")
    parts.append("</Table>")
    return "\n".join(parts)


# ------------------------------------------------------------------
# 算子实现
# ------------------------------------------------------------------

def _resolve_row_insert_index(
    row_count: int, after: Optional[int], before: Optional[int]
) -> int:
    """
    返回 Python list.insert 用的目标 index（0..row_count）。
    - both None -> 追加到表尾 = row_count
    - after 与 before 只能二选一
    """
    if after is not None and before is not None:
        raise HelperError(
            "AMBIGUOUS_ROW_ANCHOR",
            "after_row_index 与 before_row_index 只能二选一",
        )
    if after is None and before is None:
        return row_count
    if after is not None:
        if not isinstance(after, int) or after < 0 or after >= row_count:
            raise HelperError(
                "ROW_INDEX_OUT_OF_RANGE",
                f"after_row_index={after} 越界，合法范围 [0, {row_count - 1}]",
            )
        return after + 1
    # before
    if not isinstance(before, int) or before < 0 or before >= row_count:
        raise HelperError(
            "ROW_INDEX_OUT_OF_RANGE",
            f"before_row_index={before} 越界，合法范围 [0, {row_count - 1}]",
        )
    return before


def _resolve_col_insert_index(
    col_count: int, after: Optional[int], before: Optional[int]
) -> int:
    if after is not None and before is not None:
        raise HelperError(
            "AMBIGUOUS_COL_ANCHOR",
            "after_col_index 与 before_col_index 只能二选一",
        )
    if after is None and before is None:
        return col_count
    if after is not None:
        if not isinstance(after, int) or after < 0 or after >= col_count:
            raise HelperError(
                "COL_INDEX_OUT_OF_RANGE",
                f"after_col_index={after} 越界，合法范围 [0, {col_count - 1}]",
            )
        return after + 1
    if not isinstance(before, int) or before < 0 or before >= col_count:
        raise HelperError(
            "COL_INDEX_OUT_OF_RANGE",
            f"before_col_index={before} 越界，合法范围 [0, {col_count - 1}]",
        )
    return before


def _op_insert_row(cells: List[List[str]], args: Dict[str, Any]) -> List[List[str]]:
    col_count = len(cells[0])
    new_cells = args.get("cells")
    if not isinstance(new_cells, list) or not all(isinstance(x, str) for x in new_cells):
        raise HelperError(
            "INVALID_ARGS",
            "insert_row.cells 必须是字符串数组",
        )
    if len(new_cells) != col_count:
        raise HelperError(
            "COL_LENGTH_MISMATCH",
            f"新行有 {len(new_cells)} 列，与现表 {col_count} 列不一致",
        )
    idx = _resolve_row_insert_index(
        len(cells),
        args.get("after_row_index"),
        args.get("before_row_index"),
    )
    result = [list(r) for r in cells]
    result.insert(idx, list(new_cells))
    return result


def _op_delete_row(cells: List[List[str]], args: Dict[str, Any]) -> List[List[str]]:
    ri = args.get("row_index")
    if not isinstance(ri, int) or ri < 0 or ri >= len(cells):
        raise HelperError(
            "ROW_INDEX_OUT_OF_RANGE",
            f"row_index={ri} 越界，合法范围 [0, {len(cells) - 1}]",
        )
    if len(cells) <= 1:
        raise HelperError(
            "CANNOT_DELETE_LAST_ROW",
            "只剩 1 行，删除后表格为空，拒绝",
        )
    result = [list(r) for r in cells]
    del result[ri]
    return result



def _op_insert_column(cells: List[List[str]], args: Dict[str, Any]) -> List[List[str]]:
    row_count = len(cells)
    col_count = len(cells[0])
    new_col = args.get("cells")
    if not isinstance(new_col, list) or not all(isinstance(x, str) for x in new_col):
        raise HelperError(
            "INVALID_ARGS",
            "insert_column.cells 必须是字符串数组",
        )
    if len(new_col) != row_count:
        raise HelperError(
            "COL_LENGTH_MISMATCH",
            f"新列有 {len(new_col)} 个 cell，与现表 {row_count} 行不一致",
        )
    idx = _resolve_col_insert_index(
        col_count,
        args.get("after_col_index"),
        args.get("before_col_index"),
    )
    result: List[List[str]] = []
    for i, row in enumerate(cells):
        new_row = list(row)
        new_row.insert(idx, new_col[i])
        result.append(new_row)
    return result


def _op_delete_column(cells: List[List[str]], args: Dict[str, Any]) -> List[List[str]]:
    ci = args.get("col_index")
    col_count = len(cells[0])
    if not isinstance(ci, int) or ci < 0 or ci >= col_count:
        raise HelperError(
            "COL_INDEX_OUT_OF_RANGE",
            f"col_index={ci} 越界，合法范围 [0, {col_count - 1}]",
        )
    if col_count <= 1:
        raise HelperError(
            "CANNOT_DELETE_LAST_COLUMN",
            "只剩 1 列，删除后表格为空，拒绝",
        )
    result: List[List[str]] = []
    for row in cells:
        new_row = list(row)
        del new_row[ci]
        result.append(new_row)
    return result


def _op_set_table(_cells: List[List[str]], args: Dict[str, Any]) -> List[List[str]]:
    grid = args.get("cells")
    if not isinstance(grid, list) or not grid:
        raise HelperError(
            "INVALID_ARGS",
            "set_table.cells 必须是非空二维数组",
        )
    for i, row in enumerate(grid):
        if not isinstance(row, list) or not row:
            raise HelperError(
                "INVALID_ARGS",
                f"set_table.cells[{i}] 必须是非空数组",
            )
        for j, v in enumerate(row):
            if not isinstance(v, str):
                raise HelperError(
                    "INVALID_ARGS",
                    f"set_table.cells[{i}][{j}] 必须是字符串",
                )
    col_count = len(grid[0])
    for i, row in enumerate(grid):
        if len(row) != col_count:
            raise HelperError(
                "COL_LENGTH_MISMATCH",
                f"set_table 第 1 行 {col_count} 列，第 {i + 1} 行 {len(row)} 列",
            )
    return [list(r) for r in grid]


_OP_DISPATCH = {
    "insert_row": _op_insert_row,
    "delete_row": _op_delete_row,
    "insert_column": _op_insert_column,
    "delete_column": _op_delete_column,
    "set_table": _op_set_table,
}


# ------------------------------------------------------------------
# 顶层入口
# ------------------------------------------------------------------

def run(op: str, table_content: str, args: Dict[str, Any]) -> str:
    if op not in SUPPORTED_OPS:
        raise HelperError(
            "UNKNOWN_OP",
            f"未知算子 {op!r}；支持 {sorted(SUPPORTED_OPS)}",
        )
    if op == "set_table":
        # set_table 不依赖旧表结构，但仍要求 table_content 是合法 <Table>...</Table>
        # 以保证调用方是"在改现有表格"，避免误用当新建入口
        _parse_table_content(table_content)
        new_cells = _OP_DISPATCH[op]([[""]], args)
    else:
        cells = _parse_table_content(table_content)
        new_cells = _OP_DISPATCH[op](cells, args)
    return _render_table_content(new_cells)


# ------------------------------------------------------------------
# self-check（用例外置在 scripts/fixtures/table_edit_helper_cases.json）
# ------------------------------------------------------------------

_FIXTURES_PATH = (
    Path(__file__).resolve().parent
    / "scripts"
    / "fixtures"
    / "table_edit_helper_cases.json"
)


def _load_fixtures() -> Dict[str, Any]:
    """加载 self-check fixtures JSON。缺失文件时抛 FileNotFoundError。"""
    if not _FIXTURES_PATH.exists():
        raise FileNotFoundError(
            f"self-check fixtures 缺失：{_FIXTURES_PATH}；请随脚本一起分发"
        )
    with _FIXTURES_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def _run_one_case(base_table: str, case: Dict[str, Any]) -> None:
    """执行单个 self-check 用例；不通过时抛 AssertionError。"""
    name = case.get("name") or "<unnamed>"
    op = case.get("op") or ""
    args = case.get("args") or {}
    expect = case.get("expect") or {}

    # 决定输入 table_content
    table_content = base_table
    override = case.get("table_content_override")
    if override == "rowspan":
        # 特殊 override：在 base_table 上注入 rowspan 属性
        table_content = base_table.replace(
            "<TableCell>", '<TableCell rowspan="2">', 1
        )
    elif isinstance(override, str) and override:
        table_content = override  # 直接使用 override 字符串

    # 期望是错误码
    if "error_code" in expect:
        expected_code = expect["error_code"]
        try:
            if op == "PARSE":
                _parse_table_content(table_content)
            else:
                run(op, table_content, args)
        except HelperError as e:
            if e.code != expected_code:
                raise AssertionError(
                    f"[{name}] 期望 error_code={expected_code}，实际 {e.code}"
                )
            return
        else:
            raise AssertionError(f"[{name}] 期望抛 HelperError({expected_code})，但未抛")

    # 期望成功路径：跑 op 并检查输出
    if op == "PARSE":
        raise AssertionError(f"[{name}] PARSE op 只能配合 error_code，缺失时视为用例配置错误")
    out = run(op, table_content, args)

    if "cells" in expect:
        actual = _parse_table_content(out)
        if actual != expect["cells"]:
            raise AssertionError(
                f"[{name}] cells 不符：\n  期望 {expect['cells']}\n  实际 {actual}"
            )

    for token in expect.get("contains", []) or []:
        if token not in out:
            raise AssertionError(f"[{name}] 期望输出包含 {token!r}，但未找到")

    for token in expect.get("not_contains", []) or []:
        # `not_contains` 里的 "readonly" 不带 = 号，做小写化匹配以覆盖属性大小写
        haystack = out.lower() if token.lower() == token and token.isalpha() else out
        needle = token.lower() if haystack is not out else token
        if needle in haystack:
            raise AssertionError(f"[{name}] 期望输出**不**包含 {token!r}，但找到了")


def _selfcheck() -> None:
    """跑外置 fixtures 里所有用例；全部通过打印 KS_TABLE_EDIT_HELPER_SELFCHECK_OK。"""
    fixtures = _load_fixtures()
    base_table = "\n".join(fixtures.get("base_table") or [])
    if not base_table:
        raise AssertionError("fixtures.base_table 为空")
    cases = fixtures.get("cases") or []
    if not cases:
        raise AssertionError("fixtures.cases 为空")
    for case in cases:
        _run_one_case(base_table, case)
    print("KS_TABLE_EDIT_HELPER_SELFCHECK_OK")


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------

def _parse_cli() -> Tuple[argparse.Namespace, argparse.ArgumentParser]:
    p = argparse.ArgumentParser(
        prog="table_edit_helper.py",
        description="本地表格组件算子（无网络、无 token），供 Agent 改已有 <Table> 时避免手抄整表。",
    )
    p.add_argument("--op", help=f"算子名，支持 {sorted(SUPPORTED_OPS)}")
    p.add_argument("--table-content", help="完整的 <Table>...</Table> 组件片段")
    p.add_argument(
        "--table-content-file",
        help="从文件读入 <Table> 组件语法（与 --table-content 二选一，方便传大表）",
    )
    p.add_argument("--args", help="算子参数 JSON")
    p.add_argument("--args-file", help="算子参数 JSON 文件（与 --args 二选一）")
    p.add_argument(
        "--self-check",
        action="store_true",
        help="跑内建自检，成功打印 KS_TABLE_EDIT_HELPER_SELFCHECK_OK",
    )
    return p.parse_args(), p


def _read_file_utf8(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def main() -> int:
    ns, _parser = _parse_cli()

    if ns.self_check:
        try:
            _selfcheck()
            return 0
        except Exception as e:  # noqa: BLE001
            _emit_error("SELFCHECK_FAILED", f"{type(e).__name__}: {e}")
            return 0

    # 常规模式
    try:
        if not ns.op:
            raise HelperError("MISSING_OP", "--op 必填")
        if ns.table_content and ns.table_content_file:
            raise HelperError(
                "AMBIGUOUS_TABLE_INPUT",
                "--table-content 与 --table-content-file 只能二选一",
            )
        if ns.table_content:
            table_content = ns.table_content
        elif ns.table_content_file:
            table_content = _read_file_utf8(ns.table_content_file)
        else:
            raise HelperError(
                "MISSING_TABLE_CONTENT",
                "必须提供 --table-content 或 --table-content-file",
            )

        if ns.args and ns.args_file:
            raise HelperError(
                "AMBIGUOUS_ARGS_INPUT",
                "--args 与 --args-file 只能二选一",
            )
        if ns.args:
            args_raw = ns.args
        elif ns.args_file:
            args_raw = _read_file_utf8(ns.args_file)
        else:
            args_raw = "{}"

        try:
            args_obj = json.loads(args_raw)
        except json.JSONDecodeError as e:
            raise HelperError("INVALID_ARGS_JSON", f"--args 不是合法 JSON: {e}") from e
        if not isinstance(args_obj, dict):
            raise HelperError("INVALID_ARGS_JSON", "--args 必须是 JSON 对象")

        new_table_content = run(ns.op, table_content, args_obj)
        _emit_success(new_table_content)
        return 0

    except HelperError as e:
        _emit_error(e.code, e.message)
        return 0
    except Exception as e:  # noqa: BLE001
        _emit_error("INTERNAL_ERROR", f"{type(e).__name__}: {e}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
