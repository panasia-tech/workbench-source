"""销售上手练习（练习门禁）：用户 11-13 定，对齐销售工作台交付包。

所有销售（现有员工也算）先用演练商品走一遍实物三步——定价提交审批 → 发布上架 → 扫码发货，
做完才能在真货上架、审批、发货。开关（app_setting sales_practice_required）关着时谁都不拦；
管理员不拦。每一步的规矩照真流程来，答案由服务端判，前端只管展示。
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.enums import StaffRole
from app.models import Staff, StaffPractice
from app.services.app_settings import get_setting
from app.services.auto_listing.pricing import floor_price

REQUIRED_KEY = "sales_practice_required"
PRACTICE = "phys"

# 演练商品：不在库里，只活在练习页
ITEM = {
    "name": "二手 iPhone 13 128G 黑色（演练）",
    "code": "PRACTICE-IP13",
    "cost": 2200,
    "ratio": "1.30",
    "images": ["正面", "背面", "侧边"],
    "shops": ["演练号 A", "演练号 B"],
}
FLOOR = floor_price(Decimal(ITEM["cost"]), ITEM["ratio"])
HIGH_MULTIPLE = 5
REASON_MIN = 4
TRACKING_MIN = 8

STEPS = [
    {
        "title": "定价并提交审批",
        "learn": "先看成本和最低价，给演练号 A 定一个整数价、选至少 1 张图，再提交审批。",
        "guard": f"低于最低价要写理由、只有管理员能批；高于成本 {HIGH_MULTIPLE} 倍会标黄；没选图交不了。",
    },
    {
        "title": "发布上架",
        "learn": "价和图批过的号才会发出去，没批的号这次不发。",
        "guard": "没批过不能发；货已锁单不能再上架。",
        "question": "演练号 A 已经批过，演练号 B 还在等审批。现在点「发布」，会发出去的是？",
        "options": ["只有演练号 A", "演练号 A 和 B 都发", "都不发，要等 B 也批完"],
        "answer": 0,
    },
    {
        "title": "扫码发货",
        "learn": "买家付款后，扫这件货的货号核对，填快递运单号，再确认出库。",
        "guard": "货号对不上不让出库；同一件货不能出两次。",
    },
]


def required(db: Session) -> bool:
    return get_setting(db, REQUIRED_KEY, "") == "1"


def done_steps(db: Session, staff_id: str) -> set[int]:
    rows = db.query(StaffPractice.step).filter(
        StaffPractice.staff_id == staff_id, StaffPractice.practice == PRACTICE,
    )
    return {r.step for r in rows}


def left(db: Session, staff_id: str) -> int:
    return len(STEPS) - len(done_steps(db, staff_id) & set(range(1, len(STEPS) + 1)))


def gated(db: Session, user: Staff) -> bool:
    """这个人现在会不会被拦：开关开着、是销售、还没做完。"""
    return user.role == StaffRole.SALES and required(db) and left(db, user.id) > 0


def gate(db: Session, user: Staff) -> None:
    """上架、审批、发货前调。被拦时说清还差几步、去哪做。"""
    if gated(db, user):
        raise HTTPException(
            status_code=403,
            detail=f"先做完上手练习（工作台 → 上手练习，还差 {left(db, user.id)} 步），才能上架、审批、发货",
        )


def status(db: Session, user: Staff) -> dict:
    done = done_steps(db, user.id)
    return {
        "required": required(db),
        "gated": gated(db, user),
        "item": {**ITEM, "floor": FLOOR, "high_multiple": HIGH_MULTIPLE},
        "steps": [
            {
                "no": i,
                "title": s["title"],
                "learn": s["learn"],
                "guard": s["guard"],
                "question": s.get("question"),
                "options": s.get("options"),
                "done": i in done,
            }
            for i, s in enumerate(STEPS, start=1)
        ],
        "left": len(STEPS) - len(done & set(range(1, len(STEPS) + 1))),
    }


def _check(step: int, body: dict) -> dict:
    """判一步的答案。错了抛 400，说清哪里不对（和真流程同一句话的意思）。"""
    if step == 1:
        try:
            price = int(body.get("price") or 0)
        except (TypeError, ValueError):
            price = 0
        images = [x for x in (body.get("images") or []) if x in ITEM["images"]]
        reason = str(body.get("reason") or "").strip()
        if price <= 0:
            raise HTTPException(status_code=400, detail="先填一个整数售价")
        if not images:
            raise HTTPException(status_code=400, detail="还没选图：至少选 1 张")
        if price < FLOOR and len(reason) < REASON_MIN:
            raise HTTPException(
                status_code=400,
                detail=f"低于最低价 {FLOOR} 元：要写为什么低价（至少 {REASON_MIN} 个字），提交后只有管理员能批",
            )
        return {"price": price, "images": images, "reason": reason or None,
                "below_floor": price < FLOOR, "high": price > ITEM["cost"] * HIGH_MULTIPLE}
    if step == 2:
        if body.get("choice") != STEPS[1]["answer"]:
            raise HTTPException(status_code=400, detail="不对：只有批过的号会发出去，没批的这次不发")
        return {"choice": body.get("choice")}
    if step == 3:
        code = str(body.get("code") or "").strip().upper()
        tracking = str(body.get("tracking_no") or "").strip()
        if code != ITEM["code"]:
            raise HTTPException(status_code=400, detail=f"货号对不上：订单上是 {ITEM['code']}，扫到的是 {code or '空'}，拿错件了")
        if len(tracking) < TRACKING_MIN:
            raise HTTPException(status_code=400, detail="快递运单号要填完整")
        return {"code": code, "tracking_no": tracking}
    raise HTTPException(status_code=404, detail="没有这一步")


def submit_step(db: Session, user: Staff, step: int, body: dict) -> dict:
    if step > 1 and (step - 1) not in done_steps(db, user.id):
        raise HTTPException(status_code=400, detail="按顺序做：先做完上一步")
    answer = _check(step, body)
    row = (
        db.query(StaffPractice)
        .filter(StaffPractice.staff_id == user.id, StaffPractice.practice == PRACTICE, StaffPractice.step == step)
        .first()
    )
    if row is None:
        row = StaffPractice(staff_id=user.id, practice=PRACTICE, step=step)
        db.add(row)
    row.answer = answer
    db.commit()
    # 菜单红点和「真实任务先锁着」要跟着变，别等缓存过期
    from app.services.sales_workbench import forget_badges

    forget_badges(user.id)
    return status(db, user)


def progress(db: Session) -> list[dict]:
    """管理员看：每个在职销售做到哪了。"""
    sales = (
        db.query(Staff)
        .filter(Staff.role == StaffRole.SALES, Staff.status == "ACTIVE", Staff.deleted_at.is_(None))
        .order_by(Staff.staff_no)
        .all()
    )
    out = []
    for s in sales:
        n = len(done_steps(db, s.id) & set(range(1, len(STEPS) + 1)))
        out.append({"id": s.id, "name": s.name or s.username, "done": n, "total": len(STEPS)})
    return out
