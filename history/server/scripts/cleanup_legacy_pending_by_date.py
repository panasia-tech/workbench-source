"""按北京显示日期清理「老系统导入的待验收 + 待议价」数据（可逆软删，默认 dry-run）。

背景：云端 ETL 老系统迁移把一批货导进来，入库时间/验货单创建时间都落在某一天，
导致当天的 SKU 涌进「待议价」、对应 INPO 验货单涌进「待验收」。老板要求按显示日期清掉。

口径（与各列表接口完全一致）：
  待验收 = Inspection status=PENDING 且 deleted_at IS NULL，列表显示按 created_at
  待议价 = Sku status=IN_STOCK 且 negotiated_at IS NULL 且未打 LEGACY_IMPORT，列表显示按 inbound_at
显示日期为北京日历日，经 cn_range_to_utc 换算成 naive UTC [start, end) 比较。

清理方式（均可逆，回滚物料写入 backup JSON）：
  待验收：Inspection.deleted_at = now()            （列表已 filter deleted_at IS NULL）
  待议价：Sku.tags 追加 "LEGACY_IMPORT"            （待议价接口本就排除该标签；库存不动、仍可售）

用法（生产 py-api 目录，能读 .env → erp_xcx）：
    cd /www/wwwroot/py-api
    python -m scripts.cleanup_legacy_pending_by_date 2026-06-23            # dry-run，只统计+分布
    python -m scripts.cleanup_legacy_pending_by_date 2026-06-23 --commit   # 真正执行（先写 backup JSON）
    python -m scripts.cleanup_legacy_pending_by_date 2026-06-23 --commit --only inspection   # 只清待验收
    python -m scripts.cleanup_legacy_pending_by_date 2026-06-23 --commit --only negotiation  # 只清待议价

回滚：见执行时打印的 backup JSON 路径（含 inspection id 列表 + sku id/原 tags）。
"""
import json
import sys
from collections import Counter
from datetime import date, datetime

from app.database import SessionLocal
from app.enums import InspectionStatus, SkuStatus
from app.models import Inspection, Sku
from app.services.finance import cn_range_to_utc

LEGACY_TAG = "LEGACY_IMPORT"


def _prefix(no: str | None) -> str:
    if not no:
        return "(空)"
    for p in ("INPO", "INMAN", "INLEG"):
        if no.startswith(p):
            return p
    if no.startswith("IN") and len(no) >= 10 and no[2:10].isdigit():
        return "IN+日期(应用内)"
    return no[:5]


def main():
    args = sys.argv[1:]
    commit = "--commit" in args
    args = [a for a in args if a != "--commit"]
    only = None
    if "--only" in args:
        i = args.index("--only")
        only = args[i + 1]
        del args[i : i + 2]
    target = date.fromisoformat(args[0]) if args else date(2026, 6, 23)

    start, end = cn_range_to_utc(target, target)
    mode = "执行(commit)" if commit else "DRY-RUN(仅预览)"
    scope = only or "inspection+negotiation"
    print(f"目标北京日期 {target} → naive UTC [{start}, {end})  | 模式：{mode} | 范围：{scope}\n")

    db = SessionLocal()
    backup: dict = {"date": str(target), "inspections": [], "skus": []}
    try:
        # ---------- 待验收 ----------
        if only in (None, "inspection"):
            ins_rows = (
                db.query(Inspection)
                .filter(
                    Inspection.status == InspectionStatus.PENDING,
                    Inspection.deleted_at.is_(None),
                    Inspection.created_at >= start,
                    Inspection.created_at < end,
                )
                .all()
            )
            dist = Counter(_prefix(r.inspect_no) for r in ins_rows)
            print(f"【待验收】命中 PENDING 验货单 {len(ins_rows)} 条，按单号前缀分布：")
            for k, v in sorted(dist.items(), key=lambda x: -x[1]):
                print(f"    {k:18s} {v}")
            for r in ins_rows[:15]:
                print(f"      e.g. {r.inspect_no}  created={r.created_at}")
            backup["inspections"] = [r.id for r in ins_rows]
            if commit:
                now = datetime.utcnow()
                for r in ins_rows:
                    r.deleted_at = now
                print(f"  → 已置 deleted_at（{len(ins_rows)} 条）")
            print()

        # ---------- 待议价 ----------
        if only in (None, "negotiation"):
            sku_rows = (
                db.query(Sku)
                .filter(
                    Sku.status == SkuStatus.IN_STOCK,
                    Sku.negotiated_at.is_(None),
                    Sku.inbound_at >= start,
                    Sku.inbound_at < end,
                )
                .all()
            )
            # 已带 LEGACY_IMPORT 的本就不在待议价，排除
            sku_rows = [s for s in sku_rows if LEGACY_TAG not in (s.tags or [])]
            print(f"【待议价】命中在库待议价 SKU {len(sku_rows)} 条，按采购单号前缀分布：")
            dist = Counter(
                _prefix(s.purchase_order.order_no if s.purchase_order else None) for s in sku_rows
            )
            for k, v in sorted(dist.items(), key=lambda x: -x[1]):
                print(f"    {k:18s} {v}")
            for s in sku_rows[:15]:
                po = s.purchase_order.order_no if s.purchase_order else None
                print(f"      e.g. {s.sku_code}  po={po}  inbound={s.inbound_at}")
            backup["skus"] = [{"id": s.id, "tags": list(s.tags or [])} for s in sku_rows]
            if commit:
                for s in sku_rows:
                    tags = list(s.tags or [])
                    if LEGACY_TAG not in tags:
                        tags.append(LEGACY_TAG)
                        s.tags = tags
                print(f"  → 已追加 {LEGACY_TAG} 标签（{len(sku_rows)} 条）")
            print()

        if commit:
            stamp = target.strftime("%Y%m%d")
            path = f"backup_cleanup_legacy_pending_{stamp}.json"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(backup, f, ensure_ascii=False, indent=2)
            db.commit()
            print(f"已提交。回滚物料：{path}")
            print(f"  待验收软删 {len(backup['inspections'])} 条 / 待议价打标 {len(backup['skus'])} 条")
        else:
            print("（DRY-RUN，未改动。确认无误后加 --commit 执行）")
    finally:
        db.close()


if __name__ == "__main__":
    main()
