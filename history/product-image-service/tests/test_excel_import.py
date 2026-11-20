from __future__ import annotations

import io
import zipfile

import pytest

from app.excel_import import ExcelImportError, read_xlsx_rows


def make_xlsx(rows: list[list[str]]) -> bytes:
    def cell(column: str, value: str, row_number: int) -> str:
        escaped = (
            value.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )
        return f'<c r="{column}{row_number}" t="inlineStr"><is><t>{escaped}</t></is></c>'

    sheet_rows = []
    for row_number, values in enumerate(rows, 1):
        cells = "".join(cell(chr(ord("A") + index), value, row_number) for index, value in enumerate(values))
        sheet_rows.append(f'<row r="{row_number}">{cells}</row>')
    sheet = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData>' + "".join(sheet_rows) + "</sheetData></worksheet>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="型号清单" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    relationships = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>'
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", relationships)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    return output.getvalue()


def test_read_xlsx_rows_extracts_model_and_spu():
    content = make_xlsx([
        ["品牌+型号", "SPU编码"],
        ["AOC 24G2", "9001"],
        ["盛色 N50PRO6", "9002"],
    ])

    assert read_xlsx_rows(content) == [
        {"row_number": 2, "query": "AOC 24G2", "spu": "9001"},
        {"row_number": 3, "query": "盛色 N50PRO6", "spu": "9002"},
    ]


def test_read_xlsx_rows_combines_separate_brand_and_model_columns():
    content = make_xlsx([
        ["品牌", "型号", "编码"],
        ["华硕", "PG248QP", "sku-1"],
    ])

    assert read_xlsx_rows(content) == [
        {"row_number": 2, "query": "华硕 PG248QP", "spu": "sku-1"}
    ]


def test_read_xlsx_rows_rejects_missing_model_column():
    with pytest.raises(ExcelImportError, match="没有找到"):
        read_xlsx_rows(make_xlsx([["SPU编码"], ["9001"]]))


def test_read_xlsx_rows_rejects_non_xlsx_filename():
    with pytest.raises(ExcelImportError, match="只支持"):
        read_xlsx_rows(b"not-a-workbook", "models.csv")
