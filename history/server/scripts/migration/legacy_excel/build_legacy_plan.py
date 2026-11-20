"""方案 A 第 1 步:从对账 Excel + legacy 快照构建迁移计划(本地运行,纯只读)。

产出:
  - legacy_migration_plan.jsonl   将要写入生产的目标行(每行=一个货号一批)
  - gap_items_unmigrated.csv       items 源在库但没迁进生产的缺口清单(不属本次方案A)
  - 控制台打印 dry-run 概览

口径(已与用户确认):
  - 范围 = Excel 库存>0(excel_qty>0)
  - 数量以 CloudBase 为准(best_qty);best_qty<=0 的(含161行Excel有货但云端已出库) → 不进库
  - items* 源 → 已走 items->sku,跳过
  - legacy* 源 & best_qty>0 → 本次新建(从 legacy 快照补全)
  - 无 CloudBase 源 & 库存>0 → 建占位,cost=0 待补
  - 一码多件(qty>1) → 拆 N 行,sku_code 加 -1/-2 后缀
  - 已在生产 sku 的货号一律跳过(去重)

用法:
  python build_legacy_plan.py \
      --excel /path/inventory_reconcile_full_20260615.xlsx \
      --snapshot ../../data/cloud_dump/legacy_inventory_snapshot.jsonl \
      --prod-sku-codes /tmp/prod_sku_codes.txt \
      --out-dir ../../data/legacy_excel
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _ms(v):
    """{'$date': ms} | ms | None -> int ms | None"""
    if isinstance(v, dict):
        v = v.get("$date")
    n = _num(v)
    return int(n) if n is not None else None


def _cost_yuan(doc: dict) -> float:
    fen = _num(doc.get("purchasePriceFen"))
    if fen is not None:
        return round(fen / 100, 2)
    for k in ("costPrice", "totalCost", "factoryPrice"):
        c = _num(doc.get(k))
        if c is not None:
            return round(c, 2)
    return 0.0


def load_snapshot(path: Path) -> dict[str, list[dict]]:
    """code -> [docs];同一货号历史上可能有多条(多台/多次出入库)。"""
    by_code: dict[str, list[dict]] = defaultdict(list)
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            for k in ("goodsCode", "goodsNo", "itemNo"):
                code = d.get(k)
                if code:
                    by_code[str(code)].append(d)
    # 去重(同 _id 只留一份)
    for code, docs in by_code.items():
        seen, uniq = set(), []
        for d in docs:
            if d.get("_id") in seen:
                continue
            seen.add(d.get("_id"))
            uniq.append(d)
        by_code[code] = uniq
    return by_code


def pick_legacy_doc(docs: list[dict]) -> dict:
    """优先在库(stockQty>0 / status=IN_STOCK),否则取最新更新的一条。"""
    def instock(d):
        return (_num(d.get("stockQty")) or 0) > 0 or d.get("status") == "IN_STOCK"
    cand = [d for d in docs if instock(d)] or docs
    return max(cand, key=lambda d: _ms(d.get("updatedAt")) or 0)


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--excel", required=True)
    ap.add_argument("--snapshot", default=str(here / "../../data/cloud_dump/legacy_inventory_snapshot.jsonl"))
    ap.add_argument("--prod-sku-codes", required=True)
    ap.add_argument("--out-dir", default=str(here / "../../data/legacy_excel"))
    args = ap.parse_args()

    import openpyxl

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    prod_codes = {
        c.strip() for c in Path(args.prod_sku_codes).read_text(encoding="utf-8").splitlines() if c.strip()
    }
    snap = load_snapshot(Path(args.snapshot).resolve())

    wb = openpyxl.load_workbook(args.excel, read_only=True, data_only=True)
    ws = wb["全量对账"]
    rows = list(ws.iter_rows(values_only=True))
    hdr = rows[0]
    idx = {h: i for i, h in enumerate(hdr)}

    def g(r, k):
        return r[idx[k]]

    plan: list[dict] = []
    gap: list[dict] = []
    skipped_in_prod = 0
    stat = defaultdict(int)

    for r in rows[1:]:
        excel_qty = _num(g(r, "excel_qty")) or 0
        if excel_qty <= 0:
            continue  # 范围只含库存>0
        code = g(r, "excel_code")
        code = str(code).strip() if code is not None else None
        if not code:
            stat["无货号跳过"] += 1
            continue
        src = g(r, "best_source")
        src = None if src in (None, "", "None") else str(src)
        best_qty = _num(g(r, "best_qty")) or 0

        # 已在生产 sku → 去重跳过
        if code in prod_codes:
            skipped_in_prod += 1
            continue

        # items* 源:已走 items->sku;若没在生产 = 迁移漏网,记入缺口清单(不属方案A)
        if src and src.startswith("items"):
            if best_qty > 0:
                gap.append({
                    "excel_code": code,
                    "excel_name": g(r, "excel_name"),
                    "best_source": src,
                    "best_qty": best_qty,
                    "items_total_records": g(r, "items_total_records"),
                    "items_in_stock_qty": g(r, "items_in_stock_qty"),
                    "items_out_stock_records": g(r, "items_out_stock_records"),
                    "notes": g(r, "notes"),
                })
            stat["items源(跳过/记缺口)"] += 1
            continue

        # legacy* 源 & best_qty>0 → 新建
        if src and src.startswith("legacy"):
            if best_qty <= 0:
                stat["legacy但云端=0(信云端不进库)"] += 1
                continue
            docs = snap.get(code) or []
            ld = pick_legacy_doc(docs) if docs else {}
            n = int(round(best_qty))
            plan.append(_plan_entry(code, "legacy", n, r, idx, ld))
            stat["legacy新建"] += 1
            continue

        # 无 CloudBase 源 & 库存>0 → Excel 占位
        if not src:
            n = int(round(excel_qty))
            plan.append(_plan_entry(code, "nosrc", n, r, idx, {}))
            stat["无源占位新建"] += 1
            continue

        stat["未分类(异常)"] += 1

    # 写出
    plan_path = out_dir / "legacy_migration_plan.jsonl"
    with plan_path.open("w", encoding="utf-8") as w:
        for e in plan:
            w.write(json.dumps(e, ensure_ascii=False) + "\n")

    gap_path = out_dir / "gap_items_unmigrated.csv"
    with gap_path.open("w", encoding="utf-8", newline="") as w:
        wr = csv.DictWriter(w, fieldnames=[
            "excel_code", "excel_name", "best_source", "best_qty",
            "items_total_records", "items_in_stock_qty", "items_out_stock_records", "notes"])
        wr.writeheader()
        wr.writerows(gap)

    total_units = sum(e["qty"] for e in plan)
    multi = [e for e in plan if e["qty"] > 1]
    print("==================== DRY-RUN 计划概览 ====================")
    for k, v in sorted(stat.items()):
        print(f"  {k:32s}: {v}")
    print(f"  已在生产sku(去重跳过)            : {skipped_in_prod}")
    print("---------------------------------------------------------")
    print(f"  计划新建货号(plan行)            : {len(plan)}")
    print(f"  └ legacy源                      : {sum(1 for e in plan if e['source']=='legacy')}")
    print(f"  └ 无源占位                      : {sum(1 for e in plan if e['source']=='nosrc')}")
    print(f"  将创建 sku 实物件数(拆行后)     : {total_units}")
    print(f"  需加后缀的多件货号              : {len(multi)}  {[(e['excel_code'], e['qty']) for e in multi]}")
    print(f"  → 每个货号建 1 占位PO + 1 占位验货单;sku 共 {total_units} 件")
    print("---------------------------------------------------------")
    print(f"  items源迁移缺口(单独清单,不迁) : {len(gap)} 行 → {gap_path.name}")
    print(f"  计划文件                        : {plan_path}")
    print("=========================================================")


def _plan_entry(code, source, n, r, idx, ld) -> dict:
    def g(k):
        return r[idx[k]]
    if source == "legacy" and ld:
        product_name = ld.get("productName") or ld.get("goodsName") or g("excel_name") or "未命名商品"
        model = ld.get("model")
        if model and model == code:
            model = None
        cost = _cost_yuan(ld)
        cover = ld.get("mainImage") or ld.get("imageUrl") or ld.get("cover")
        location = ld.get("location") or ld.get("storehouseName") or g("excel_warehouse")
        inbound_ms = _ms(ld.get("inboundAt")) or _ms(ld.get("createdAt"))
        barcode = ld.get("barCode") or g("excel_barcode")
        supplier = ld.get("supplierName")
        legacy_id = ld.get("_id")
        legacy_status = ld.get("status")
    else:  # nosrc:仅 Excel
        product_name = g("excel_name") or "未命名商品"
        model = None
        cost = 0.0
        cover = None
        location = g("excel_warehouse")
        inbound_ms = None
        barcode = g("excel_barcode")
        supplier = None
        legacy_id = None
        legacy_status = None
    return {
        "sku_code": code,
        "source": source,
        "qty": n,
        "product_name": str(product_name)[:256],
        "model": (str(model)[:128] if model else None),
        "brand": None,
        "cost_price": cost,
        "location_code": (str(location)[:32] if location else None),
        "cover_url": (str(cover)[:512] if cover else None),
        "barcode": (str(barcode) if barcode else None),
        "inbound_ms": inbound_ms,
        "supplier": supplier,
        "legacy_id": legacy_id,
        "legacy_status": legacy_status,
        "excel_color": g("excel_color"),
        "excel_size": g("excel_size"),
        "excel_qty": _num(g("excel_qty")),
    }


if __name__ == "__main__":
    main()
