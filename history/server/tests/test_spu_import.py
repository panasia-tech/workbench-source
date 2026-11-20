"""仓库 SPU 对照表导入：合并单元格向下填充、表头识别、合并/覆盖两种模式。

清单是人工整理的合并单元格表（一个 SPU 占多行，品牌型号与 SPU 编码只写第一行），
openpyxl 读出来第二行起是 None——不向下填充就会把整份清单读成一堆孤儿 SKU。
另外 SKU 编码本身含空格与全角逗号（"SANC G7Pro Max"、"SONOS One S13，黑色"），
凡是按这些字符切分的地方都会把一个编码劈成几截。
"""

import io

import pytest
from openpyxl import Workbook

from app.models import WarehouseSpu, WarehouseSpuSku
from app.services.spu_import import (
    _build_column_map,
    build_export,
    build_pending_export,
    parse_workbook,
    pending_rows,
    sku_issue,
    split_brand_model,
    split_sku_codes,
    upsert_catalog,
)


def _xlsx(rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    for row in rows:
        ws.append(list(row))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


_HEADER = ("品牌+型号", "SPU编码", "SKU编码")


# ---------------------------------------------------------------- 表头识别

def test_清单表头():
    assert _build_column_map(_HEADER) == {"brand_model": 0, "spu_code": 1, "sku_code": 2}


def test_品牌型号分列的表头():
    got = _build_column_map(("品牌", "名称（兼容型号）", "SPU编号", "采购价"))
    assert got["brand"] == 0 and got["model"] == 1 and got["spu_code"] == 2


def test_品牌加型号合成列不会被同时当成品牌列和型号列():
    """「品牌+型号」里同时含「品牌」和「型号」，包含匹配兜底时一列只能落一个字段。"""
    got = _build_column_map(_HEADER)
    assert "brand" not in got and "model" not in got


def test_无SPU编码列报错():
    with pytest.raises(ValueError, match="SPU编码"):
        parse_workbook(_xlsx([("品牌+型号", "备注"), ("创维 F24G30F", "x")]))


def test_无品牌型号列报错():
    with pytest.raises(ValueError, match="品牌"):
        parse_workbook(_xlsx([("SPU编码", "SKU编码"), ("90000003", "513211549229")]))


# ---------------------------------------------------------------- 解析

def test_合并单元格向下填充():
    rows, warnings = parse_workbook(_xlsx([
        _HEADER,
        ("小米 空气净化器4PRO", "90000638", "18579673"),
        (None, None, "513211540140"),
        (None, None, "米家空气净化器4Pro"),
        ("创维 F24G30F", "6978207303771", "513211540009"),
    ]))
    assert [r["spu_code"] for r in rows] == ["90000638"] * 3 + ["6978207303771"]
    assert [r["brand"] for r in rows] == ["小米"] * 3 + ["创维"]
    assert [r["model"] for r in rows] == ["空气净化器4PRO"] * 3 + ["F24G30F"]
    assert rows[2]["sku_code"] == "米家空气净化器4Pro"  # 编码列里直接写商品名的历史数据
    assert warnings == ["第 4 行 SKU 编码「米家空气净化器4Pro」写成了中文商品名"]


def test_数字编码不带小数点():
    """Excel 把 90000003 读成 int/float，str() 出来会是 '90000003.0'。"""
    rows, _ = parse_workbook(_xlsx([_HEADER, ("戴森 HT01", 90000003, 513211549229)]))
    assert rows[0]["spu_code"] == "90000003"
    assert rows[0]["sku_code"] == "513211549229"


def test_只有SPU清单没有SKU列():
    rows, _ = parse_workbook(_xlsx([("品牌+型号", "SPU编码"), ("雷神 DQ27F240L", "90000287")]))
    assert rows == [{"brand": "雷神", "model": "DQ27F240L", "spu_code": "90000287",
                     "sku_code": None, "note": None, "spec": None}]


def test_孤儿SKU行跳过并告警():
    rows, warnings = parse_workbook(_xlsx([_HEADER, (None, None, "513211540009")]))
    assert rows == []
    assert warnings and "SPU 编码" in warnings[0]


def test_品牌型号拆分():
    assert split_brand_model("创维 F24G30F") == ("创维", "F24G30F")
    assert split_brand_model("宏碁 QG240Y S3") == ("宏碁", "QG240Y S3")   # 型号自带空格
    assert split_brand_model("音响") == ("音响", None)                    # 无空格
    assert split_brand_model("SONOS PLAYBAR + PLAY5") == ("SONOS", "PLAYBAR + PLAY5")


def test_粘贴多个SKU编码只按换行切():
    """编码里有空格和全角逗号，按它们切会把一个编码劈成几截。"""
    got = split_sku_codes("SANC G7Pro Max\nSONOS One S13，黑色\n\n513211540009\n513211540009")
    assert got == ["SANC G7Pro Max", "SONOS One S13，黑色", "513211540009"]


# ---------------------------------------------------------------- 入库

def _import(db, rows, replace=False):
    parsed, _ = parse_workbook(_xlsx(rows))
    return upsert_catalog(db, parsed, replace=replace)


def test_合并导入新建SPU与对应(db_session):
    r = _import(db_session, [
        _HEADER,
        ("小米 空气净化器4PRO", "90000638", "18579673"),
        (None, None, "513211540140"),
        ("创维 F24G30F", "6978207303771", "513211540009"),
    ])
    assert (r["spu_created"], r["sku_created"]) == (2, 3)
    spu = db_session.query(WarehouseSpu).filter_by(spu_code="90000638").one()
    assert spu.brand_model == "小米 空气净化器4PRO"
    assert sorted(s.sku_code for s in spu.skus) == ["18579673", "513211540140"]


def test_重复导入幂等(db_session):
    rows = [_HEADER, ("戴森 HT01", "90000003", "513211549229")]
    _import(db_session, rows)
    r = _import(db_session, rows)
    assert (r["spu_created"], r["sku_created"], r["sku_skipped"]) == (0, 0, 1)
    assert db_session.query(WarehouseSpuSku).count() == 1


def test_同型号多个SPU编码各自成行(db_session):
    """盛色 N50PRO6 在清单里有 3 个 SPU 编码——品牌+型号不是唯一键。"""
    r = _import(db_session, [
        _HEADER,
        ("盛色 N50PRO6", "6974772491585", "513211540006"),
        ("盛色 N50PRO6", "6974772491592", "513211540318"),
        ("盛色 N50PRO6", "6974772491776", "513211540017"),
    ])
    assert r["spu_created"] == 3
    assert db_session.query(WarehouseSpu).filter_by(model="N50PRO6").count() == 3


def test_SKU改挂到别的SPU(db_session):
    _import(db_session, [_HEADER, ("小米 空气净化器4", "90000614", "69019809")])
    r = _import(db_session, [_HEADER, ("小米 空气净化器5", "90000645", "69019809")])
    assert r["sku_moved"] == 1
    assert db_session.query(WarehouseSpuSku).count() == 1
    row = db_session.query(WarehouseSpuSku).one()
    assert db_session.get(WarehouseSpu, row.spu_id).spu_code == "90000645"
    assert any("改挂" in w for w in r["changes"])


def test_合并导入不删除库里多余的行(db_session):
    _import(db_session, [_HEADER, ("戴森 HT01", "90000003", "513211549229")])
    r = _import(db_session, [_HEADER, ("创维 F24G30F", "6978207303771", "513211540009")])
    assert (r["spu_deleted"], r["sku_deleted"]) == (0, 0)
    assert db_session.query(WarehouseSpu).count() == 2


def test_覆盖导入删除文件里没有的SPU与对应(db_session):
    _import(db_session, [
        _HEADER,
        ("戴森 HT01", "90000003", "513211549229"),
        ("小米 空气净化器4PRO", "90000638", "18579673"),
        (None, None, "513211540140"),
    ])
    r = _import(db_session, [_HEADER, ("小米 空气净化器4PRO", "90000638", "18579673")], replace=True)
    assert r["spu_deleted"] == 1          # 戴森整条没了
    assert r["sku_deleted"] == 2          # 戴森的 1 条 + 小米少列的 513211540140
    assert db_session.query(WarehouseSpu).count() == 1
    assert [s.sku_code for s in db_session.query(WarehouseSpuSku).all()] == ["18579673"]


def test_覆盖导入不会误删刚改挂过来的对应(db_session):
    """改挂只改 spu_id；session 是 autoflush=False，边改边删会把新挂的行当成旧行删掉。

    构造：69019809 原挂在 90000614 下，新文件把它挂到 90000645，
    且 90000614 仍在文件里（带另一个 SKU）——清理时它的集合里可能还留着已改挂的行。
    """
    _import(db_session, [
        _HEADER,
        ("小米 空气净化器4", "90000614", "69019809"),
        (None, None, "513211540184"),
    ])
    r = _import(db_session, [
        _HEADER,
        ("小米 空气净化器5", "90000645", "69019809"),
        ("小米 空气净化器4", "90000614", "513211540184"),
    ], replace=True)
    assert r["sku_moved"] == 1
    assert r["sku_deleted"] == 0
    moved = db_session.query(WarehouseSpuSku).filter_by(sku_code="69019809").one()
    assert db_session.get(WarehouseSpu, moved.spu_id).spu_code == "90000645"


def test_文件内同一SKU挂了两个SPU时告警(db_session):
    r = _import(db_session, [
        _HEADER,
        ("戴森 HT01", "90000003", "513211549229"),
        ("小米 12", "90000584", "513211549229"),
    ])
    assert any("同时挂了" in w for w in r["warnings"])
    assert db_session.query(WarehouseSpuSku).count() == 1


def test_导出可再导入(db_session):
    _import(db_session, [
        _HEADER,
        ("小米 空气净化器4PRO", "90000638", "18579673"),
        (None, None, "513211540140"),
        ("雷神 DQ27F240L", "90000287", None),   # 没有 SKU 对应的 SPU 也要能导出
    ])
    rows, warnings = parse_workbook(build_export(db_session))
    assert warnings == []
    assert {r["spu_code"] for r in rows} == {"90000638", "90000287"}
    assert sorted(r["sku_code"] for r in rows if r["sku_code"]) == ["18579673", "513211540140"]


# ---------------------------------------------------------------- 编码质量

@pytest.mark.parametrize("code,reason", [
    ("1", "占位/测试数字"),
    ("111111", "占位/测试数字"),
    ("22222222", "占位/测试数字"),
    ("TMP-012", "临时码"),
    ("米家空气净化器4Pro", "写成了中文商品名"),
    ("SONOS One S13，黑色", "写成了中文商品名"),
    ("$3211540330", "首字符异常（疑似打字错）"),
])
def test_可疑编码被认出来(code, reason):
    assert sku_issue(code) == reason


@pytest.mark.parametrize("code", [
    "513211540009", "69019809", "HZKKDN00042", "WMSPOPO20260429XD5GDV",
    "BC8M095900481", "JB1E97C180220", "sancg73", "SANC G7Pro Max",
])
def test_合法但长得怪的编码不误伤(code):
    """清单里这些都是正常编码，判定收紧就是为了不把它们扫进去。"""
    assert sku_issue(code) is None


def test_编码等于自家品牌型号算没填():
    assert sku_issue("AOC 25G41SNE", "AOC", "25G41SNE") is not None
    assert sku_issue("HKCMG25H3F", "HKC", "MG25H3F") is not None
    assert sku_issue("AOC 25G41SNE", "小米", "空气净化器4") is None  # 换个 SPU 就不是了


def test_待补清单只列没有正式编码的款(db_session):
    _import(db_session, [
        _HEADER,
        ("小米 空气净化器4PRO", "90000638", "18579673"),   # 有正式码
        (None, None, "TMP-009"),                          # 混着临时码也不算待补
        ("盛色 G7PRO", "90000447", "TMP-012"),             # 只有临时码 → 待补
        ("Intel I5-14600K", "6972075736044", "111111"),    # 占位数字 → 待补
    ])
    got = pending_rows(db_session)
    assert {r["spu_code"] for r in got} == {"90000447", "6972075736044"}
    assert got[0]["reasons"] and all(got[0]["reasons"])


def test_待补清单导出可读(db_session):
    _import(db_session, [_HEADER, ("盛色 G7PRO", "90000447", "TMP-012")])
    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(build_pending_export(db_session))).active
    rows = list(ws.iter_rows(values_only=True))
    assert rows[0][:4] == ("品牌+型号", "SPU编码", "现有编码", "问题")
    assert rows[1][:4] == ("盛色 G7PRO", "90000447", "TMP-012", "临时码")


def test_预览只列改动不写库(db_session):
    db = db_session
    db.add(WarehouseSpu(spu_code="90000001", brand="盛色", model="N50PRO6"))
    db.commit()
    rows = [{"brand": "盛色", "model": "N50PRO7", "spu_code": "90000001", "sku_code": None, "note": None, "spec": "8+256G"}]
    r = upsert_catalog(db, rows, dry_run=True)
    assert r["dry_run"] is True
    assert any("N50PRO6" in c and "N50PRO7" in c for c in r["changes"])
    assert any("配置" in c for c in r["changes"])
    assert db.query(WarehouseSpu).one().model == "N50PRO6"
    upsert_catalog(db, rows)
    spu = db.query(WarehouseSpu).one()
    assert (spu.model, spu.spec) == ("N50PRO7", "8+256G")
