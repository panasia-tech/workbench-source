"""行情监控型号导入：表头兼容与合并/覆盖两种模式。

巡航台的任务清单表头是「名称（兼容型号）」「别称1」，与 ERP 原模板不同；
且它只是巡航台自己的任务集，不是 ERP 的完整监控名单——用覆盖模式导会连带
删掉其余型号的历史行情，所以合并模式必须可用且真的不删。
"""

import io

import pytest
from openpyxl import Workbook

from app.services.crawl_import import _build_column_map, parse_workbook


def _xlsx(rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    for row in rows:
        ws.append(list(row))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------- 表头识别

def test_原模板表头():
    assert _build_column_map(("名称", "搜索词", "备注", "排序")) == {
        "name": 0, "keyword": 1, "note": 2, "sort_order": 3
    }


def test_巡航台表头带括号说明也能认出名称列():
    """精确匹配认不出「名称（兼容型号）」，靠包含匹配兜底。"""
    got = _build_column_map(("品牌", "名称（兼容型号）", "别称1", "别称2", "SPU编号", "采购价"))
    assert got["name"] == 1
    assert got["keyword"] == 2  # 别称1 作搜索词


def test_精确匹配优先于包含匹配():
    """同时存在「名称」和「名称（兼容型号）」时，取精确的那个。"""
    got = _build_column_map(("名称（兼容型号）", "名称"))
    assert got["name"] == 1


def test_无名称列报错():
    with pytest.raises(ValueError, match="名称"):
        parse_workbook(_xlsx([("品牌", "采购价"), ("AOC", 500)]))


def test_不相干表头不会被误配():
    got = _build_column_map(("品牌", "SPU编号", "采购价"))
    assert got == {}


# ---------------------------------------------------------------- 解析结果

def test_解析巡航台清单():
    rows = parse_workbook(_xlsx([
        ("品牌", "名称（兼容型号）", "别称1", "别称2", "SPU编号", "采购价"),
        ("AOC", "24G10ZF", None, None, "90002", 500),
        ("小米", "空气净化器4PRO", "米家空气净化器4PRO", "小米净化器4PRO", "90003", 1299),
    ]))
    assert [r["name"] for r in rows] == ["24G10ZF", "空气净化器4PRO"]
    assert rows[0]["keyword"] is None          # 别称1 为空
    assert rows[1]["keyword"] == "米家空气净化器4PRO"


def test_跳过空名称行():
    rows = parse_workbook(_xlsx([
        ("名称（兼容型号）", "别称1"),
        ("24G10ZF", "AOC24"),
        (None, "孤儿别称"),
        ("", "空字符串"),
    ]))
    assert len(rows) == 1


def test_超长字段截断而非报错():
    rows = parse_workbook(_xlsx([("名称", "搜索词"), ("A" * 200, "B" * 200)]))
    assert len(rows[0]["name"]) == 128
    assert len(rows[0]["keyword"]) == 128
