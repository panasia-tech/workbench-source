"""行情监控商品（爬取搜索词）的 Excel 导入 / 模板生成。

被 routers/market.py 的导入接口与 scripts/import_crawl_products.py 复用，保证
「后台上传导入」与「命令行批量导入」走同一套解析 / 入库逻辑。
"""

from __future__ import annotations

import io

from openpyxl import Workbook, load_workbook
from sqlalchemy.orm import Session

from app.models import CrawlProduct

# 表头别名 -> 字段。导入时按首行表头识别列，大小写 / 空格不敏感。
# 备注同时接受「规格」，这样 monitor_models_cn_full_2015plus.xlsx（名称 / 规格）可直接导入。
_HEADER_ALIASES = {
    "name": {"名称", "商品名", "名字", "name"},
    "keyword": {"搜索词", "关键词", "keyword", "别称", "别名", "别称1"},
    "note": {"备注", "规格", "说明", "note"},
    "sort_order": {"排序", "顺序", "sort", "sort_order"},
}

TEMPLATE_HEADERS = ["名称", "搜索词", "备注", "排序"]

# 与模型列宽对齐，超长截断而非报错
_MAX_NAME = 128
_MAX_KEYWORD = 128
_MAX_NOTE = 255


def _norm(v) -> str:
    return str(v).strip().lower() if v is not None else ""


def _build_column_map(header_row: tuple) -> dict[str, int]:
    """首行表头 -> {字段: 列索引}。"""
    alias_to_field = {}
    for field, aliases in _HEADER_ALIASES.items():
        for a in aliases:
            alias_to_field[a.lower()] = field
    col_map: dict[str, int] = {}
    # 第一轮：表头与别名完全相同
    for idx, cell in enumerate(header_row):
        field = alias_to_field.get(_norm(cell))
        if field and field not in col_map:
            col_map[field] = idx
    # 第二轮：表头「包含」别名即可，兼容带括号说明的写法
    # （巡航台任务清单的表头是「名称（兼容型号）」，精确匹配认不出来）
    for idx, cell in enumerate(header_row):
        text = _norm(cell)
        if not text:
            continue
        for alias, field in alias_to_field.items():
            if field not in col_map and alias in text:
                col_map[field] = idx
                break
    return col_map


def parse_workbook(content: bytes) -> list[dict]:
    """解析 Excel 字节流，返回待入库行 [{name, keyword, note, sort_order}]。

    抛 ValueError 表示文件不合法（无法识别名称列等）。
    """
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001 - 统一转成可读错误
        raise ValueError(f"无法读取 Excel 文件：{exc}") from exc

    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    try:
        header = next(rows_iter)
    except StopIteration:
        raise ValueError("文件为空") from None

    col_map = _build_column_map(header)
    if "name" not in col_map:
        raise ValueError("未找到「名称」列，请使用导入模板（首行需包含「名称」表头）")

    out: list[dict] = []
    for raw in rows_iter:
        if raw is None:
            continue

        def cell(field):
            i = col_map.get(field)
            return raw[i] if i is not None and i < len(raw) else None

        name = (str(cell("name")).strip() if cell("name") is not None else "")
        if not name:
            continue  # 跳过空名称行

        keyword = cell("keyword")
        keyword = str(keyword).strip() if keyword is not None else ""
        note = cell("note")
        note = str(note).strip() if note is not None else ""

        sort_order = 0
        so = cell("sort_order")
        if so is not None and str(so).strip():
            try:
                sort_order = int(float(str(so).strip()))
            except (TypeError, ValueError):
                sort_order = 0

        out.append(
            {
                "name": name[:_MAX_NAME],
                "keyword": (keyword[:_MAX_KEYWORD] or None),
                "note": (note[:_MAX_NOTE] or None),
                "sort_order": sort_order,
            }
        )
    return out


def upsert_products(
    db: Session, rows: list[dict], created_by_id: str | None, replace: bool = True
) -> dict:
    """按名称导入监控商品。返回 {total, created, updated, skipped, deleted}。

    replace=True（默认，「覆盖导入」）：导入后名单与文件严格一致——
      - 已存在：更新 keyword / note（仅当导入值非空）与 sort_order，保留 enabled / 历史价格。
      - 不存在：新建，enabled=True（导入即纳入每日爬取）。
      - 库里有、文件里没有：删除该商品，其历史行情（crawl_price）随 cascade 一并删除（不可恢复）。
      - 文件内重名：以最后一行为准。
    replace=False（旧的「合并导入」）：只新增 / 更新，绝不删除库里多余的行。

    注意：name 上的唯一索引是 MySQL 大小写不敏感（utf8mb4_*_ci）的，
    因此去重 / 命中已有行都按小写归一键比较，避免「R25F30」与「R25f30」
    这类只差大小写的行触发 1062 重复键。
    """

    def _key(name: str) -> str:
        return name.strip().lower()

    # 文件内按归一键去重，后者覆盖前者（保留该行原始大小写的 name）
    by_name: dict[str, dict] = {}
    for r in rows:
        by_name[_key(r["name"])] = r

    existing = {_key(p.name): p for p in db.query(CrawlProduct).all()}

    created = updated = deleted = 0
    for key, r in by_name.items():
        prod = existing.get(key)
        if prod is None:
            prod = CrawlProduct(
                name=r["name"],
                keyword=r["keyword"],
                note=r["note"],
                sort_order=r["sort_order"],
                enabled=True,
                created_by_id=created_by_id,
            )
            db.add(prod)
            existing[key] = prod
            created += 1
        else:
            if r["keyword"]:
                prod.keyword = r["keyword"]
            if r["note"]:
                prod.note = r["note"]
            prod.sort_order = r["sort_order"]
            updated += 1

    if replace:
        # 文件里没有的旧商品 → 删除（历史行情随 cascade 一并删除）
        for key, prod in list(existing.items()):
            if key not in by_name:
                db.delete(prod)
                deleted += 1

    db.commit()
    return {
        "total": len(rows),
        "created": created,
        "updated": updated,
        "skipped": len(rows) - len(by_name),  # 文件内重名被合并的条数
        "deleted": deleted,  # 覆盖导入时被删除的旧商品数
    }


def build_template() -> bytes:
    """生成导入模板（xlsx 字节流）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "监控商品"
    ws.append(TEMPLATE_HEADERS)
    # 两行示例，便于理解列含义
    ws.append(["AOCU27U2D", "AOC U27U2D 显示器", "27英寸 / 4K / IPS", 0])
    ws.append(["索尼A7M4", "", "全画幅微单（搜索词留空则用名称）", 1])
    # 列宽
    for col, width in zip("ABCD", (28, 28, 36, 8)):
        ws.column_dimensions[col].width = width
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_export(db: Session) -> bytes:
    """导出全部监控商品（xlsx 字节流）。

    列与导入模板一致（名称 / 搜索词 / 备注 / 排序），导出文件可直接再导入。
    按列表展示顺序（sort_order，再 created_at）排列。
    """
    wb = Workbook()
    ws = wb.active
    ws.title = "监控商品"
    ws.append(TEMPLATE_HEADERS)
    rows = (
        db.query(CrawlProduct)
        .order_by(CrawlProduct.sort_order.asc(), CrawlProduct.created_at.asc())
        .all()
    )
    for p in rows:
        ws.append([p.name, p.keyword or "", p.note or "", p.sort_order])
    for col, width in zip("ABCD", (28, 28, 36, 8)):
        ws.column_dimensions[col].width = width
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
