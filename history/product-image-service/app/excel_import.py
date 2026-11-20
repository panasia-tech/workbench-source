from __future__ import annotations

import io
import posixpath
import re
import unicodedata
import zipfile
from xml.etree import ElementTree


class ExcelImportError(ValueError):
    """Raised when an uploaded workbook cannot be converted into batch rows."""


_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_CELL_REF = re.compile(r"^([A-Za-z]+)")
_MODEL_HEADERS = {
    "型号",
    "model",
    "productmodel",
    "brandmodel",
}
_COMBINED_MODEL_HEADERS = {
    "品牌型号",
    "品牌和型号",
}
_BRAND_HEADERS = {"品牌", "brand"}
_SPU_HEADERS = {"spu编码", "spu", "商品编码", "货号", "编码", "sku"}


def _tag(name: str) -> str:
    return f"{{{_SHEET_NS}}}{name}"


def _normalise_header(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"[\s_\-+]+", "", value).casefold()


def _column_index(reference: str) -> int:
    match = _CELL_REF.match(reference or "")
    if not match:
        return 0
    index = 0
    for character in match.group(1).upper():
        index = index * 26 + ord(character) - ord("A") + 1
    return index - 1


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        raw = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ElementTree.fromstring(raw)
    return ["".join(node.itertext()) for node in root.findall(f"{_tag('si')}")]


def _first_sheet_path(archive: zipfile.ZipFile) -> str:
    try:
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        relationships = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    except KeyError as exc:
        raise ExcelImportError("工作簿缺少必要的结构，无法读取") from exc
    first_sheet = workbook.find(f"{_tag('sheets')}/{_tag('sheet')}")
    if first_sheet is None:
        raise ExcelImportError("工作簿没有可读取的工作表")
    relation_id = first_sheet.attrib.get(f"{{{_REL_NS}}}id")
    relation = next(
        (
            item
            for item in relationships
            if item.attrib.get("Id") == relation_id
        ),
        None,
    )
    if relation is None:
        raise ExcelImportError("工作簿的首个工作表引用无效")
    target = relation.attrib.get("Target", "").lstrip("/")
    if target.startswith("xl/"):
        return posixpath.normpath(target)
    return posixpath.normpath(posixpath.join("xl", target))


def _cell_value(cell: ElementTree.Element, shared: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(cell.itertext()).strip()
    value = cell.find(_tag("v"))
    if value is None or value.text is None:
        return ""
    raw = value.text
    if cell_type == "s":
        try:
            return shared[int(raw)].strip()
        except (IndexError, ValueError):
            return ""
    return raw.strip()


def _read_sheet(archive: zipfile.ZipFile, path: str, shared: list[str]) -> list[list[str]]:
    try:
        root = ElementTree.fromstring(archive.read(path))
    except KeyError as exc:
        raise ExcelImportError("工作表文件不存在") from exc
    rows: list[list[str]] = []
    for row in root.findall(f".//{_tag('row')}"):
        cells: dict[int, str] = {}
        for cell in row.findall(_tag("c")):
            cells[_column_index(cell.attrib.get("r", ""))] = _cell_value(cell, shared)
        if cells:
            rows.append([cells.get(index, "") for index in range(max(cells) + 1)])
        else:
            rows.append([])
    return rows


def read_xlsx_rows(content: bytes, filename: str = "workbook.xlsx") -> list[dict[str, object]]:
    """Read model/SPU rows from the first worksheet of a small .xlsx workbook."""
    if not content:
        raise ExcelImportError("上传文件为空")
    if not filename.casefold().endswith((".xlsx", ".xlsm")):
        raise ExcelImportError("目前只支持 .xlsx 或 .xlsm 文件")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            shared = _shared_strings(archive)
            rows = _read_sheet(archive, _first_sheet_path(archive), shared)
    except zipfile.BadZipFile as exc:
        raise ExcelImportError("文件不是有效的 Excel 工作簿") from exc
    except ElementTree.ParseError as exc:
        raise ExcelImportError("Excel 工作簿结构损坏，无法读取") from exc

    if not rows:
        raise ExcelImportError("工作表没有数据")
    header = rows[0]
    normalised = {_normalise_header(value): index for index, value in enumerate(header)}
    direct_model_column = next(
        (normalised[key] for key in _COMBINED_MODEL_HEADERS if key in normalised), None
    )
    brand_column = next((normalised[key] for key in _BRAND_HEADERS if key in normalised), None)
    separate_model_column = direct_model_column is None
    model_column = direct_model_column
    if model_column is None:
        model_column = next(
            (index for key, index in normalised.items() if "型号" in key or "model" in key),
            None,
        )
    if model_column is None:
        raise ExcelImportError("没有找到品牌+型号或型号列")
    spu_column = next((normalised[key] for key in _SPU_HEADERS if key in normalised), None)

    imported: list[dict[str, object]] = []
    for row_number, values in enumerate(rows[1:], 2):
        model = values[model_column].strip() if model_column < len(values) else ""
        if separate_model_column and brand_column is not None:
            brand = values[brand_column].strip() if brand_column < len(values) else ""
            model = f"{brand} {model}".strip()
        if not model:
            continue
        spu = values[spu_column].strip() if spu_column is not None and spu_column < len(values) else ""
        imported.append({"row_number": row_number, "query": model, "spu": spu})
    if not imported:
        raise ExcelImportError("型号列没有可导入的数据")
    return imported
