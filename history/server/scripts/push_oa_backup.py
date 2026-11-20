"""一次性：把 ERP 存量数据映射成 OA 5 工具入参，直连指定 MCP 端点推送（测试库备份）。

自包含：不依赖未部署的 app.services.oa_push；仅用 app.models / commission / finance + mcp client。
字段口径对齐文档 v1.7（全部用 erpStaffId(UUID)，OA 侧自动映射 userId；finance 不传 userId）。

健壮性（穿透/网络会断流）：断线自动重连续跑；进度写 --progress，成功/幂等/永久失败即标记，
重连后跳过已完成；--fresh 清空进度从头来。

用法（erp-txy，cd /www/wwwroot/py-api）：
  ./venv/bin/python -m scripts.push_oa_backup --target http://127.0.0.1:8000 \
      [--api-key …] [--only all] [--limit N] [--no-staff] [--dry-run] [--fresh]
钥匙默认读 .env 的 OA_MCP_API_KEY，别写进代码或命令示例。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal

from app.config import settings
from app.database import SessionLocal
from app.enums import StaffRole
from app.models import AnonymousFeedback, Inspection, PurchaseOrder, SaleOrder, SalesOutbound, Sku, Staff
from app.services import commission
from app.services.finance import CN_TZ

logger = logging.getLogger("push_oa_backup")

NON_HUMAN = {"RFID_DEVICE", "CRAWLER"}
SRC = "erp"


def _to_cn(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(CN_TZ)


def _pm(dt): return _to_cn(dt).strftime("%Y%m")
def _pd(dt): return _to_cn(dt).strftime("%Y%m%d")
def _bd(dt): return _to_cn(dt).strftime("%Y-%m-%d")
def _dtcn(dt): return _to_cn(dt).strftime("%Y-%m-%d %H:%M:%S")
def _status(s): return "ENABLED" if (s or "").upper() == "ACTIVE" else "DISABLED"
def _human(r): return (r or "").upper() not in NON_HUMAN
def _r2(x): return round(float(x or 0), 2)


def build_staff(s):
    a = {"staffId": s.id, "username": s.username, "role": s.role,
         "status": _status(s.status), "staffNo": s.staff_no}
    if s.name: a["name"] = s.name
    if s.shop: a["shop"] = s.shop
    if s.openid: a["openid"] = s.openid
    if s.password_hash: a["passwordHash"] = s.password_hash
    return a


def build_sale(ob, so):
    created = ob.created_at or datetime.utcnow()
    pay, cost = _r2(ob.sale_price), _r2(ob.cost_price)
    a = {"sourceSystem": SRC, "sourceNo": ob.outbound_no, "erpStaffId": ob.operator_id,
         "erpSkuId": ob.sku_id, "payAmount": pay, "refundAmount": 0, "netPayAmount": pay,
         "costAmount": cost, "grossProfit": round(pay - cost, 2), "payOrderCount": 1, "payUserCount": 1,
         "periodType": "day", "periodValue": _pd(created), "bizDate": _bd(created)}
    if so is not None:
        if getattr(so, "platform", None): a["platform"] = so.platform
        if getattr(so, "shop_name", None): a["storeName"] = so.shop_name
        if getattr(so, "id", None): a["erpOrderId"] = so.id
    return a


def build_fin_outbound(ob, po, role):
    created = ob.created_at or datetime.utcnow()
    period = _pm(created)
    out = []
    if po is not None and po.created_by_id and not po.is_overdue:
        margin = (ob.sale_price or Decimal("0")) - (ob.cost_price or Decimal("0"))
        out.append(({"erpStaffId": po.created_by_id, "settleZone": "income",
                     "amount": _r2(margin * commission.PURCHASER_RATE),
                     "itemDesc": f"采购提成｜{ob.outbound_no}", "period": period}, "purchase"))
    role = (role or "").upper()
    if role in (StaffRole.WAREHOUSE, StaffRole.ADMIN):
        out.append(({"erpStaffId": ob.operator_id, "settleZone": "income",
                     "amount": float(commission.WAREHOUSE_OUTBOUND_FEE),
                     "itemDesc": f"仓管出库计件｜{ob.outbound_no}", "period": period}, "wh_outbound"))
    if role in (StaffRole.SALES, StaffRole.ADMIN):
        out.append(({"erpStaffId": ob.operator_id, "settleZone": "income",
                     "amount": float(commission.SALES_OUTBOUND_FEE),
                     "itemDesc": f"销售出库计件｜{ob.outbound_no}", "period": period}, "sales_outbound"))
    return out


def build_inspect(insp):
    done = insp.inspected_at or datetime.utcnow()
    return {"erpStaffId": insp.inspector_id, "settleZone": "income",
            "amount": float(commission.WAREHOUSE_INSPECT_FEE),
            "itemDesc": f"验货计件｜{insp.inspect_no}", "period": _pm(done)}


def build_reply(fb):
    h = fb.handled_at or datetime.utcnow()
    return {"sourceSystem": SRC, "sourceNo": fb.id, "erpStaffId": fb.handled_by_id,
            "content": fb.handled_note or "", "replyContent": fb.content or "", "replyTime": _dtcn(h)}


def collect(db, only, limit, include_staff):
    recs = []
    if include_staff and only in ("staff", "all"):
        q = db.query(Staff).order_by(Staff.created_at.asc())
        if limit: q = q.limit(limit)
        for s in q.all():
            if _human(s.role):
                recs.append(("sync_staff_user", build_staff(s), f"staff:{s.id}"))
    if only in ("sale", "finance", "all"):
        q = db.query(SalesOutbound).order_by(SalesOutbound.created_at.asc())
        if limit: q = q.limit(limit)
        for ob in q.all():
            if only in ("sale", "all"):
                so = db.get(SaleOrder, ob.sale_order_id) if ob.sale_order_id else None
                recs.append(("push_sale_stat", build_sale(ob, so), f"sale:{ob.id}"))
            if only in ("finance", "all"):
                sku = db.get(Sku, ob.sku_id)
                po = db.get(PurchaseOrder, sku.purchase_order_id) if sku else None
                operator = db.get(Staff, ob.operator_id)
                for a, suf in build_fin_outbound(ob, po, operator.role if operator else None):
                    recs.append(("push_finance_record", a, f"fin:ob:{ob.id}:{suf}"))
    if only in ("finance", "all"):
        q = (db.query(Inspection)
             .filter(Inspection.status == "DONE", Inspection.deleted_at.is_(None),
                     Inspection.inspector_id.isnot(None))
             .order_by(Inspection.inspected_at.asc()))
        if limit: q = q.limit(limit)
        for insp in q.all():
            recs.append(("push_finance_record", build_inspect(insp), f"fin:insp:{insp.id}"))
    if only in ("reply", "all"):
        q = (db.query(AnonymousFeedback)
             .filter(AnonymousFeedback.handled_by_id.isnot(None), AnonymousFeedback.handled_note.isnot(None))
             .order_by(AnonymousFeedback.created_at.asc()))
        if limit: q = q.limit(limit)
        for fb in q.all():
            recs.append(("push_reply_record", build_reply(fb), f"reply:{fb.id}"))
    return recs


async def _try_list(url, key):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    try:
        async with streamablehttp_client(url, headers={"X-Mcp-Api-Key": key}, timeout=20) as (r, w, _):
            async with ClientSession(r, w) as s:
                await s.initialize()
                t = await s.list_tools()
                return [x.name for x in t.tools]
    except Exception as e:
        logger.info("  %s 不可用: %s", url, str(e)[:120])
        return None


async def _push(url, key, recs, done, progress_path):
    """断线重连续跑。成功/幂等/永久失败即标记进度；仅传输中断的记录会在重连后重试。"""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    ok = dup = fail = 0
    fails = []
    pf = open(progress_path, "a", encoding="utf-8")

    def mark(k):
        done.add(k)
        pf.write(k + "\n")
        pf.flush()

    no_progress = 0
    total = len({k for _, _, k in recs})
    while True:
        pending = [(t, a, k) for (t, a, k) in recs if k not in done]
        if not pending:
            break
        if no_progress >= 6:
            logger.error("连续 %d 轮无进展，放弃剩余 %d 条", no_progress, len(pending))
            break
        before = len(done)
        try:
            async with streamablehttp_client(url, headers={"X-Mcp-Api-Key": key}, timeout=60) as (r, w, _):
                async with ClientSession(r, w) as s:
                    await s.initialize()
                    for tool, args, k in pending:
                        res = await s.call_tool(tool, arguments=args)  # 传输异常→抛出→外层重连
                        text = "".join(getattr(b, "text", "") or "" for b in (res.content or []))
                        if not getattr(res, "isError", False):
                            ok += 1
                        elif ("已存在" in text) or ("重复" in text):
                            dup += 1
                        else:
                            fail += 1
                            fails.append((tool, text[:120]))
                        mark(k)
                        n = len(done)
                        if n % 50 == 0:
                            logger.info("  进度 %d/%d (ok=%d dup=%d fail=%d)", n, total, ok, dup, fail)
        except Exception as e:
            logger.warning("session 中断，重连续跑：%s", str(e)[:120])
            await asyncio.sleep(1.0)
        no_progress = no_progress + 1 if len(done) == before else 0

    pf.close()
    return ok, dup, fail, fails


def main():
    global SRC
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s | %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, help="OA 基址，如 http://127.0.0.1:8000")
    ap.add_argument("--api-key", default=settings.oa_mcp_api_key, help="默认读 .env 的 OA_MCP_API_KEY")
    ap.add_argument("--only", default="all", choices=("staff", "sale", "finance", "reply", "all"))
    ap.add_argument("--limit", type=int, default=0, help="每类源数据最多多少条，0=不限")
    ap.add_argument("--no-staff", action="store_true", help="不推员工(排除密码哈希/PII)")
    ap.add_argument("--source-system", default="erp")
    ap.add_argument("--progress", default="/tmp/oa_backup_done.txt", help="进度文件(断点续跑/防重)")
    ap.add_argument("--fresh", action="store_true", help="忽略并清空进度，从头推")
    ap.add_argument("--dry-run", action="store_true", help="只统计不连接不推送")
    args = ap.parse_args()
    if not args.api_key:
        ap.error("缺少钥匙：在 .env 设 OA_MCP_API_KEY，或用 --api-key 传")
    SRC = args.source_system

    db = SessionLocal()
    try:
        recs = collect(db, args.only, args.limit, include_staff=(not args.no_staff))
    finally:
        db.close()
    logger.info("待推送 %d 条，分布：%s", len(recs), dict(Counter(t for t, _, _ in recs)))

    if args.dry_run:
        for t, a, k in recs[:3]:
            logger.info("样例 %s [%s]: %s", t, k, json.dumps(a, ensure_ascii=False)[:200])
        logger.info("dry-run 结束（未连接、未推送）")
        return

    if args.fresh and os.path.exists(args.progress):
        os.remove(args.progress)
    done = set()
    if os.path.exists(args.progress):
        with open(args.progress, encoding="utf-8") as f:
            done = {ln.strip() for ln in f if ln.strip()}
    logger.info("进度文件 %s：已完成 %d 条（将跳过）", args.progress, len(done))

    base = args.target.rstrip("/")

    async def go():
        for path in ("/mcp", "/api/mcp"):
            names = await _try_list(base + path, args.api_key)
            if names is not None:
                logger.info("端点可用：%s  tools=%s", base + path, names)
                return await _push(base + path, args.api_key, recs, done, args.progress)
        raise SystemExit("端点 /mcp 与 /api/mcp 都连不上或鉴权失败")

    ok, dup, fail, fails = asyncio.run(go())
    logger.info("完成：成功 %d，幂等重复 %d，失败 %d，累计完成 %d", ok, dup, fail, len(done))
    for t, m in fails[:30]:
        logger.warning("FAIL %s | %s", t, m)


if __name__ == "__main__":
    main()
