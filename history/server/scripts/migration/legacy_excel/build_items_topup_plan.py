"""31 条 items 缺口补迁 - 第1步:构建补迁计划(本地,只读)。

这批 item 在 CloudBase items 集合、在库、采购单已迁进生产,但 2026-06-09 那次
items->sku 漏跑导致没生成 sku。本脚本复用 items.py 的字段语义,把真实字段提取出来,
并带上采购单号(purchaseNo)用于在生产里关联已存在的 PO。

输入:
  - items.jsonl(含这31条)
  - purchase_orders.jsonl(提供 purchaseOrderId -> purchaseNo/outTradeNo)
  - gap_item_ids.txt(31个 item _id,每行一个)
输出:
  - items_topup_plan.jsonl
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.migration.common import fen_to_yuan, safe_list, safe_str


def _ms(v):
    if isinstance(v, dict):
        v = v.get("$date")
        if isinstance(v, dict):
            v = v.get("$numberLong")
    if isinstance(v, str):
        from datetime import datetime
        try:
            return int(datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


_STATUS_MAP = {
    "IN_STOCK": "IN_STOCK", "RESERVED": "RESERVED", "LOCKED": "RESERVED",
    "SHIPPED": "SHIPPED", "OUT_STOCK": "SHIPPED", "DELETED": "LOSS", "LOSS": "LOSS",
}


def main() -> None:
    here = Path(__file__).resolve().parent
    srv = here.parent.parent.parent  # .../server
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", default=str(srv / "data/cloud_dump/items.jsonl"))
    ap.add_argument("--pos", default=str(srv / "data/cloud_dump/purchase_orders.jsonl"))
    ap.add_argument("--ids", required=True, help="31个 item _id,每行一个")
    ap.add_argument("--out", default=str(srv / "data/legacy_excel/items_topup_plan.jsonl"))
    args = ap.parse_args()

    want = {x.strip() for x in Path(args.ids).read_text().split() if x.strip()}

    # PO 映射:cloud_id -> {purchaseNo, outTradeNo}
    po_map: dict[str, dict] = {}
    with open(args.pos, encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            po_map[d["_id"]] = {"purchaseNo": d.get("purchaseNo"), "outTradeNo": d.get("outTradeNo")}

    plan = []
    seen_items = set()
    with open(args.items, encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            if d["_id"] not in want or d["_id"] in seen_items:
                continue
            seen_items.add(d["_id"])
            goods_code = safe_str(d.get("goodsCode"), 64)
            sn_raw = safe_str(d.get("sn"), 128)
            raw_code = goods_code or sn_raw or d["_id"]
            serial = safe_str(d.get("serialNo"), 128) or (
                sn_raw if sn_raw and sn_raw != goods_code else None)
            model = safe_str(d.get("model"), 128)
            if model and goods_code and model == goods_code:
                model = None
            images = safe_list(d.get("images"))
            cover = safe_str(d.get("mainImage") or d.get("imageUrl") or d.get("cover"), 512) or (
                images[0] if images and isinstance(images[0], str) else None)
            cloud_po = d.get("purchaseOrderId")
            pom = po_map.get(cloud_po, {})
            plan.append({
                "cloud_item_id": d["_id"],
                "raw_sku_code": raw_code,
                "serial_number": serial,
                "product_name": safe_str(d.get("productName"), 256) or model or "未命名商品",
                "model": model,
                "cost_price": float(fen_to_yuan(d.get("purchasePriceFen"))),
                "location_code": safe_str(d.get("location"), 32),
                "cover_url": cover,
                "images": [i for i in images if isinstance(i, str)],
                "status": _STATUS_MAP.get(safe_str(d.get("status")) or "", "IN_STOCK"),
                "inbound_ms": _ms(d.get("createdAt")),
                "outbound_ms": _ms(d.get("outStockAt")),
                "cloud_po_id": cloud_po,
                "po_purchase_no": pom.get("purchaseNo"),
                "po_external_no": pom.get("outTradeNo"),
                "po_fallback_order_no": (f"PO{cloud_po[:30]}" if cloud_po else None),
            })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as w:
        for e in plan:
            w.write(json.dumps(e, ensure_ascii=False) + "\n")

    from collections import Counter
    print(f"补迁计划: {len(plan)} 条 -> {out}")
    print("缺 purchaseNo 的:", sum(1 for e in plan if not e["po_purchase_no"]))
    print("成本=0 的:", sum(1 for e in plan if not e["cost_price"]))
    print("有真实序列号的:", sum(1 for e in plan if e["serial_number"]))
    print("缺封面的:", sum(1 for e in plan if not e["cover_url"]))
    print("同货号多件:", {k: v for k, v in Counter(e["raw_sku_code"] for e in plan).items() if v > 1})
    miss = [e["cloud_item_id"] for e in plan if e["cloud_item_id"] not in want]
    got = want - seen_items
    if got:
        print("⚠️ 计划里缺失的 item _id:", got)


if __name__ == "__main__":
    main()
