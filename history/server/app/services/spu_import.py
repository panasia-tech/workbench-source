"""仓库 SPU 对照表的 Excel 导入 / 模板 / 导出。

被 routers/spu.py 的导入接口与 scripts/import_spu_catalog.py 复用，保证
「后台上传导入」与「命令行批量导入」走同一套解析 / 入库逻辑。

能直接吃下用户手头的两份清单：
  仓库SPU品牌型号_SPUSKU对应清单.xlsx  品牌+型号 / SPU编码 / SKU编码（合并单元格 → 向下填充）
  仓库SPU品牌型号及编码清单.xlsx        品牌+型号 / SPU编码（无 SKU 列，只建 SPU）
也认「品牌」「型号」分开两列的写法（巡航台任务清单那种表头）。
"""

from __future__ import annotations

import io
import re

from openpyxl import Workbook, load_workbook
from sqlalchemy.orm import Session

from app.models import WarehouseSpu, WarehouseSpuSku

# 表头别名 -> 字段。按首行表头识别列，大小写 / 空格不敏感。
# 「品牌+型号」合成列与「品牌」「型号」分列两种写法都认，优先用分列的。
_HEADER_ALIASES = {
    "brand_model": {"品牌+型号", "品牌型号", "品牌 型号", "brand_model"},
    "brand": {"品牌", "brand"},
    "model": {"型号", "名称", "商品名", "model"},
    "spu_code": {"spu编码", "spu编号", "spu码", "spu", "spu_code"},
    "sku_code": {"sku编码", "sku编号", "sku码", "sku", "sku_code"},
    "note": {"备注", "说明", "note"},
    "spec": {"配置", "规格", "版本", "spec"},
}

TEMPLATE_HEADERS = ["品牌+型号", "SPU编码", "SKU编码", "备注"]

# 与模型列宽对齐，超长截断而非报错
_MAX_BRAND = 64
_MAX_MODEL = 128
_MAX_SPU = 64
_MAX_SKU = 64
_MAX_NOTE = 255

# 追加 SKU 时只按换行切分：清单里的编码本身含空格与全角逗号
# （"SANC G7Pro Max"、"米家空气净化器4 Lite"、"SONOS One S13，黑色"），
# 按空格/逗号切会把一个编码劈成几截。一行一个编码。
_SPLIT_RE = re.compile(r"[\r\n]+")


def _norm(v) -> str:
    return str(v).strip().lower() if v is not None else ""


def _text(v) -> str:
    """单元格 → 去空白字符串。数字型编码（Excel 常把 90000003 读成 int/float）不要带小数点。"""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def split_brand_model(text: str) -> tuple[str, str | None]:
    """「品牌+型号」按首个空白拆分。无空白的（如「音响」「NF-HCSAM450」）只有品牌。"""
    parts = re.split(r"\s+", text.strip(), maxsplit=1)
    brand = parts[0][:_MAX_BRAND]
    model = parts[1].strip()[:_MAX_MODEL] if len(parts) > 1 and parts[1].strip() else None
    return brand, model


def split_sku_codes(raw: str | list[str]) -> list[str]:
    """把粘贴进来的多行 SKU 编码切成列表（一行一个），保序去重（大小写不敏感）。"""
    items = raw if isinstance(raw, list) else [raw]
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        for code in _SPLIT_RE.split(str(item or "")):
            code = code.strip()[:_MAX_SKU]
            if code and code.lower() not in seen:
                seen.add(code.lower())
                out.append(code)
    return out


# 占位/临时/写成商品名的编码：仓库还没给正式码，导入时列出来让人过目。
# 判定收紧到「不可能是真编码」的几类，避免误伤清单里合法但长得怪的码
# （HZKKDN00042 / WMSPOPO2026… / BC8M095900481 / sancg73 都是正常的）。
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_TEMP_PREFIXES = ("TMP-",)


def placeholder_reason(code: str) -> str | None:
    """编码可疑就返回原因，正常返回 None。用于导入告警与「待补编码」筛选。"""
    code = (code or "").strip()
    if not code:
        return "空编码"
    if not code[0].isalnum():
        return "首字符异常（疑似打字错）"
    if code.upper().startswith(_TEMP_PREFIXES):
        return "临时码"
    if _CJK_RE.search(code):
        return "写成了中文商品名"
    if code.isdigit() and (len(code) < 6 or len(set(code)) == 1):
        return "占位/测试数字"
    return None


def looks_like_product_name(code: str, brand: str | None, model: str | None) -> bool:
    """SKU 编码跟自家「品牌+型号」是同一串——说明这格填的是商品名，不是编码。

    清单里的「AOC 25G41SNE」「SANC G7Pro Max」属于这类：形态上像编码，
    但和所属 SPU 的名字撞了，靠 placeholder_reason 的通用规则认不出来。
    """
    flat = re.sub(r"[\s\-_]+", "", (code or "")).lower()
    if not flat:
        return False
    name = re.sub(r"[\s\-_]+", "", f"{brand or ''}{model or ''}").lower()
    return bool(name) and flat == name


def sku_issue(code: str, brand: str | None = None, model: str | None = None) -> str | None:
    """SKU 编码有问题就返回原因，正常返回 None。导入告警 / 接口字段 / 待补清单共用一个判定。"""
    reason = placeholder_reason(code)
    if reason is None and looks_like_product_name(code, brand, model):
        return "编码与品牌+型号相同（疑似没填真实编码）"
    return reason


def _build_column_map(header_row: tuple) -> dict[str, int]:
    """首行表头 -> {字段: 列索引}。先精确匹配，再「包含」兜底带括号说明的表头。"""
    alias_to_field = {}
    for field, aliases in _HEADER_ALIASES.items():
        for a in aliases:
            alias_to_field[a.lower()] = field
    col_map: dict[str, int] = {}
    for idx, cell in enumerate(header_row):
        field = alias_to_field.get(_norm(cell))
        if field and field not in col_map:
            col_map[field] = idx
    used = set(col_map.values())
    for idx, cell in enumerate(header_row):
        text = _norm(cell)
        if not text or idx in used:
            continue  # 一列只认一个字段：否则「品牌+型号」会同时被当成「品牌」和「型号」列
        for alias, field in alias_to_field.items():
            if field not in col_map and alias in text:
                col_map[field] = idx
                used.add(idx)
                break
    return col_map


def parse_workbook(content: bytes) -> tuple[list[dict], list[str]]:
    """解析 Excel 字节流，返回 (行列表, 警告列表)。

    行形如 {brand, model, spu_code, sku_code(可为 None), note}。
    合并单元格在 openpyxl 里只有左上角有值，其余为 None——正是清单「一个 SPU 占多行、
    品牌型号与 SPU 编码只写第一行」的形态，因此对这两列做向下填充。

    抛 ValueError 表示文件不合法（认不出 SPU 编码列等）。
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
    if "spu_code" not in col_map:
        raise ValueError("未找到「SPU编码」列，请使用导入模板（首行需包含「SPU编码」表头）")
    if "brand_model" not in col_map and "brand" not in col_map:
        raise ValueError("未找到「品牌+型号」列（也可以用「品牌」+「型号」两列）")

    out: list[dict] = []
    warnings: list[str] = []
    cur_brand: str | None = None
    cur_model: str | None = None
    cur_spu: str | None = None

    for row_no, raw in enumerate(rows_iter, start=2):
        if raw is None:
            continue

        def cell(field: str) -> str:
            i = col_map.get(field)
            return _text(raw[i]) if i is not None and i < len(raw) else ""

        # 品牌 / 型号：分列优先，否则拆「品牌+型号」
        brand = model = ""
        if "brand" in col_map:
            brand = cell("brand")[:_MAX_BRAND]
            model = cell("model")[:_MAX_MODEL]
        if not brand:
            bm = cell("brand_model")
            if bm:
                brand, m = split_brand_model(bm)
                model = m or ""

        spu_code = cell("spu_code")[:_MAX_SPU]
        sku_code = cell("sku_code")[:_MAX_SKU] if "sku_code" in col_map else ""
        note = cell("note")[:_MAX_NOTE] if "note" in col_map else ""
        spec = cell("spec")[:128] if "spec" in col_map else ""

        # 向下填充：本行没写就沿用上一条 SPU 的值（合并单元格 / 省略写法）
        if brand:
            cur_brand, cur_model = brand, (model or None)
        if spu_code:
            cur_spu = spu_code

        if not spu_code and not sku_code and not brand:
            continue  # 整行空，跳过
        if not cur_spu:
            warnings.append(f"第 {row_no} 行没有 SPU 编码（且上方也没有可沿用的），已跳过")
            continue
        if not cur_brand:
            warnings.append(f"第 {row_no} 行没有品牌+型号（且上方也没有可沿用的），已跳过")
            continue
        if brand and not spu_code:
            warnings.append(f"第 {row_no} 行写了新的品牌+型号「{brand}」却没有 SPU 编码，按上一条 SPU 归并")

        if sku_code:
            reason = sku_issue(sku_code, cur_brand, cur_model)
            if reason:
                warnings.append(f"第 {row_no} 行 SKU 编码「{sku_code}」{reason}")

        out.append(
            {
                "brand": cur_brand,
                "model": cur_model,
                "spu_code": cur_spu,
                "sku_code": sku_code or None,
                "note": note or None,
                "spec": (spec or None) if spu_code else None,
            }
        )
    return out, warnings


def _matched_counts(db: Session) -> dict[str, int]:
    """每个 SPU 下有多少件货已提交/验收匹配（services/spu_match.py）。改它的品牌型号会连带这些货。"""
    from sqlalchemy import func as F

    from app.models import SkuSpuMatch

    rows = (
        db.query(SkuSpuMatch.spu_id, F.count(SkuSpuMatch.id))
        .filter(SkuSpuMatch.spu_id.isnot(None), SkuSpuMatch.status.in_((SkuSpuMatch.CONFIRMED, *SkuSpuMatch.WAITING_REVIEW)))
        .group_by(SkuSpuMatch.spu_id)
        .all()
    )
    return dict(rows)


def upsert_catalog(db: Session, rows: list[dict], replace: bool = False, dry_run: bool = False) -> dict:
    """按 SPU 编码导入对照表。返回各项计数 + 警告。

    replace=False（默认，「合并导入」）：只新增 / 更新 / 改挂，绝不删除。
    replace=True（「覆盖导入」）：导入后对照表与文件严格一致——
      文件里没有的 SPU 会被删除（其 SKU 对应随 cascade 一并删除），
      文件里出现过的 SPU 下、文件没列的 SKU 对应也会被删除。

    唯一键的比较一律按小写归一：MySQL 的唯一索引是大小写不敏感的
    （utf8mb4_*_ci），按原样比较会让「TMP-012」与「tmp-012」这类行撞 1062 重复键。
    """
    warnings: list[str] = []

    # 文件内按 SPU 归并（后出现的品牌/型号/备注覆盖先出现的），SKU 保序去重
    by_spu: dict[str, dict] = {}
    for r in rows:
        key = r["spu_code"].lower()
        entry = by_spu.setdefault(
            key,
            {"spu_code": r["spu_code"], "brand": r["brand"], "model": r["model"], "note": r["note"], "spec": None, "skus": {}},
        )
        if r.get("spec"):
            entry["spec"] = r["spec"]
        entry["brand"] = r["brand"] or entry["brand"]
        entry["model"] = r["model"] if r["model"] is not None else entry["model"]
        if r["note"]:
            entry["note"] = r["note"]
        if r["sku_code"]:
            entry["skus"].setdefault(r["sku_code"].lower(), {"sku_code": r["sku_code"], "note": r["note"]})

    # 同一 SKU 编码在文件里挂到了两个 SPU：以最后一次出现为准，但要提醒
    seen_sku: dict[str, str] = {}
    for key, entry in by_spu.items():
        for sku_key, sku in entry["skus"].items():
            prev = seen_sku.get(sku_key)
            if prev and prev != key:
                warnings.append(
                    f"SKU 编码「{sku['sku_code']}」在文件里同时挂了 SPU {by_spu[prev]['spu_code']} "
                    f"与 {entry['spu_code']}，按后者入库"
                )
            seen_sku[sku_key] = key

    existing_spu = {s.spu_code.lower(): s for s in db.query(WarehouseSpu).all()}
    existing_sku = {s.sku_code.lower(): s for s in db.query(WarehouseSpuSku).all()}

    spu_created = spu_updated = sku_created = sku_moved = sku_skipped = 0
    spu_deleted = sku_deleted = 0
    changes: list[str] = []
    matched = _matched_counts(db)

    for key, entry in by_spu.items():
        spu = existing_spu.get(key)
        if spu is None:
            spu = WarehouseSpu(
                spu_code=entry["spu_code"],
                brand=entry["brand"],
                model=entry["model"],
                note=entry["note"],
                spec=entry["spec"],
                enabled=True,
            )
            db.add(spu)
            db.flush()  # 拿到 id 供 SKU 行挂载
            existing_spu[key] = spu
            spu_created += 1
        else:
            old_name = spu.brand_model
            if (spu.brand, spu.model) != (entry["brand"], entry["model"]):
                n = matched.get(spu.id, 0)
                changes.append(
                    f"SPU {spu.spu_code}：品牌型号「{old_name}」→「{entry['brand']} {entry['model'] or ''}」".rstrip()
                    + (f"，已有 {n} 件货匹配到它，会跟着变" if n else "")
                )
            if entry["spec"] and entry["spec"] != spu.spec:
                changes.append(f"SPU {spu.spu_code}：配置「{spu.spec or '空'}」→「{entry['spec']}」")
                spu.spec = entry["spec"]
            spu.brand = entry["brand"]
            spu.model = entry["model"]
            if entry["note"]:
                spu.note = entry["note"]
            spu_updated += 1

        for sku_key, sku in entry["skus"].items():
            row = existing_sku.get(sku_key)
            if row is None:
                row = WarehouseSpuSku(spu_id=spu.id, sku_code=sku["sku_code"], note=sku["note"])
                db.add(row)
                existing_sku[sku_key] = row
                sku_created += 1
            elif row.spu_id != spu.id:
                # 已挂在别的 SPU 下：改挂过来（清单纠错的主要路径）
                old = db.get(WarehouseSpu, row.spu_id)
                changes.append(
                    f"SKU 编码「{row.sku_code}」由 SPU {old.spu_code if old else row.spu_id} "
                    f"改挂到 {spu.spu_code}"
                )
                row.spu_id = spu.id
                sku_moved += 1
            else:
                sku_skipped += 1

    if replace:
        # 清理必须等主循环跑完再做，且先 flush：SKU 改挂只改了 spu_id，
        # session 是 autoflush=False，此前 old_spu.skus 里还留着已改挂的行，
        # 边改边删会把刚挂过去的对应又当成「文件里没有的旧行」删掉。
        db.flush()
        for key, entry in by_spu.items():
            spu = existing_spu[key]
            stale = (
                db.query(WarehouseSpuSku)
                .filter(WarehouseSpuSku.spu_id == spu.id)
                .all()
            )
            for row in stale:
                if row.sku_code.lower() not in entry["skus"]:
                    changes.append(f"删除 SKU 编码「{row.sku_code}」与 SPU {spu.spu_code} 的对应")
                    existing_sku.pop(row.sku_code.lower(), None)
                    db.delete(row)
                    sku_deleted += 1

        for key, spu in list(existing_spu.items()):
            if key not in by_spu:
                n = matched.get(spu.id, 0)
                changes.append(f"删除 SPU {spu.spu_code}「{spu.brand_model}」" + (f"，已有 {n} 件货匹配到它，匹配会被清空" if n else ""))
                sku_deleted += len(spu.skus)
                db.delete(spu)  # SKU 对应随 cascade 一并删除
                spu_deleted += 1

    if dry_run:
        db.rollback()
    else:
        db.commit()
    return {
        "dry_run": dry_run,
        "changes": changes,
        "total": len(rows),
        "spu_created": spu_created,
        "spu_updated": spu_updated,
        "sku_created": sku_created,
        "sku_moved": sku_moved,
        "sku_skipped": sku_skipped,
        "spu_deleted": spu_deleted,
        "sku_deleted": sku_deleted,
        "warnings": warnings,
    }


def _style(ws) -> None:
    for col, width in zip("ABCD", (26, 20, 26, 28)):
        ws.column_dimensions[col].width = width


def build_template() -> bytes:
    """生成导入模板（xlsx 字节流）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "SPU-SKU对应"
    ws.append(TEMPLATE_HEADERS)
    # 示例：一个 SPU 多个 SKU（第二行起可省略前两列，与手工清单的合并单元格写法一致）
    ws.append(["小米 空气净化器4PRO", "90000638", "18579673", ""])
    ws.append(["", "", "513211540140", "同款不同渠道编码"])
    ws.append(["盛色 N50PRO6", "6974772491585", "513211540006", ""])
    ws.append(["音响", "90000676", "TMP-018", "无型号时整串当品牌"])
    _style(ws)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_export(db: Session) -> bytes:
    """导出全部对照关系（xlsx 字节流），列与导入模板一致，可直接再导入。

    与手工清单不同的是：品牌+型号 / SPU编码 在每一行都写满而不留空，
    这样在 Excel 里排序 / 筛选后再导入也不会串行。没有 SKU 的 SPU 也会占一行。
    """
    wb = Workbook()
    ws = wb.active
    ws.title = "SPU-SKU对应"
    ws.append(TEMPLATE_HEADERS)
    spus = db.query(WarehouseSpu).order_by(WarehouseSpu.brand.asc(), WarehouseSpu.model.asc()).all()
    for spu in spus:
        if not spu.skus:
            ws.append([spu.brand_model, spu.spu_code, "", spu.note or ""])
            continue
        for row in sorted(spu.skus, key=lambda r: r.sku_code):
            ws.append([spu.brand_model, spu.spu_code, row.sku_code, row.note or spu.note or ""])
    _style(ws)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def pending_rows(db: Session) -> list[dict]:
    """仓库侧一个正式编码都没有的款——挂了临时码 / 占位数字 / 商品名的也算没有。

    判定要跑上面的分类器，SQL 表达不了，所以整表算；对照表只有百来款，代价可忽略。
    """
    out: list[dict] = []
    for spu in db.query(WarehouseSpu).order_by(WarehouseSpu.brand.asc(), WarehouseSpu.model.asc()):
        pairs = [(row.sku_code, sku_issue(row.sku_code, spu.brand, spu.model)) for row in spu.skus]
        if any(reason is None for _, reason in pairs):
            continue
        out.append(
            {
                "spu_code": spu.spu_code,
                "brand_model": spu.brand_model,
                "sku_count": len(pairs),
                "codes": [c for c, _ in pairs],
                "reasons": [r or "" for _, r in pairs],
            }
        )
    return out


PENDING_HEADERS = ["品牌+型号", "SPU编码", "现有编码", "问题", "正式SKU编码(待填)"]


def build_pending_export(db: Session) -> bytes:
    """导出给仓库去补正式编码的清单（xlsx）。最后一列留空给他们填。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "待补编码"
    ws.append(PENDING_HEADERS)
    for item in pending_rows(db):
        if not item["codes"]:
            ws.append([item["brand_model"], item["spu_code"], "", "还没挂任何编码", ""])
            continue
        for code, reason in zip(item["codes"], item["reasons"]):
            ws.append([item["brand_model"], item["spu_code"], code, reason, ""])
    for col, width in zip("ABCDE", (26, 20, 26, 30, 26)):
        ws.column_dimensions[col].width = width
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
