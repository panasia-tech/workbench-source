"""验货全检、异常时限、出库复核的业务规则。路由和现有验货、出库流程都调这里。

通知先记成站内待办（InspectionExceptionEvent），再推送（钉钉优先、企微兜底，见 staff_notify），
每条记送达结果（channel_status），失败的自动重试几次。「已发出」是接口收下了，不代表对方看了；
没绑、发送失败的照实显示，不能写成已通知。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.enums import StaffRole, StaffStatus
from app.models import (
    Inspection,
    InspectionCheckItem,
    InspectionCheckItemLog,
    InspectionEvidence,
    InspectionException,
    InspectionExceptionEvent,
    InspectionTemplate,
    OutboundReview,
    PurchaseOrder,
    Sku,
    Staff,
)
from app.services import staff_notify, wecom
from app.services.app_settings import get_setting

logger = logging.getLogger(__name__)

# 页面上改的开关，默认都关：线上小程序还没有逐项验货页，打开前行为不变
FULL_CHECK_REQUIRED = "inspection_full_check_required"
OUTBOUND_REVIEW_REQUIRED = "outbound_review_required"

EXCEPTION_DUE_MINUTES = 10
POLL_SECONDS = 60

CHECK_RESULTS = ("PASS", "FAIL", "UNTESTABLE")
EXCEPTION_TYPES = ("DAMAGED", "MISMATCH", "OTHER")
# 一单多件没到货的那件：只能从「分件到货」标，不能手工登记
MISSING_EXCEPTION = "MISSING"
EVIDENCE_KINDS = ("UNBOX_VIDEO", "PRODUCT_PHOTO", "DEFECT_PHOTO")
REJECT_STATUSES = ("PENDING", "REJECTED", "RETURNING", "RETURNED", "NOT_NEEDED")
REFUND_STATUSES = ("PENDING", "APPLIED", "ACCEPTED", "PARTIAL", "RECEIVED", "DENIED", "NOT_NEEDED")
RETURN_LOGISTICS = ("IN_TRANSIT", "ABNORMAL", "SIGNED")
# 这些出库类型是把货寄出去，才要复核；自提当面验、切单走自己的凭证
REVIEWED_OUTBOUND_TYPES = ("ORDER_SHIP", "MANUAL")


def setting_on(db: Session, key: str) -> bool:
    return get_setting(db, key, "") == "1"


def _contains(needle: str | None, haystack: str | None) -> bool:
    return bool(needle) and bool(haystack) and needle.strip().lower() in haystack.lower()


def match_template(db: Session, order: PurchaseOrder) -> InspectionTemplate | None:
    """型号 > 品牌 > 品类关键词。同级取最新改的。"""
    best = None
    best_score = 0
    text = " ".join(filter(None, [order.product_name, order.brand, order.model]))
    rows = (
        db.query(InspectionTemplate)
        .filter(InspectionTemplate.enabled.is_(True))
        .order_by(InspectionTemplate.updated_at.desc())
        .all()
    )
    for row in rows:
        by_keyword = any(_contains(k, text) for k in (row.keywords or [])) or _contains(row.category, text)
        # 模板写了品牌、型号却对不上，不能退回去按品类用：那是另一个型号的流程
        if row.brand and not _contains(row.brand, text):
            continue
        if row.model and not _contains(row.model, text):
            continue
        # 写了型号就够具体；只写品牌还得品类对得上，戴尔显示器的流程不能用到戴尔笔记本上
        score = 3 if row.model else (2 if row.brand else 1) if by_keyword else 0
        if score > best_score:
            best, best_score = row, score
    return best


def check_items(db: Session, inspection_id: str) -> list[InspectionCheckItem]:
    return (
        db.query(InspectionCheckItem)
        .filter(InspectionCheckItem.inspection_id == inspection_id)
        .order_by(InspectionCheckItem.sort_order)
        .all()
    )


def start_check(db: Session, task: Inspection, order: PurchaseOrder, template: InspectionTemplate) -> None:
    for i, step in enumerate(template.steps or []):
        db.add(
            InspectionCheckItem(
                inspection_id=task.id,
                template_id=template.id,
                template_version=template.version,
                item_key=step["key"],
                title=step["title"],
                guide=step.get("guide"),
                need_photo=bool(step.get("need_photo")),
                sort_order=i,
                evidence=[],
                dimension=_dimension(step),
            )
        )


def _dimension(step: dict) -> str:
    from app.services.inspection_compare import dimension_of

    return dimension_of(step["key"], step.get("dimension"))


def validate_item(result: str, note: str | None, evidence: list, need_photo: bool) -> None:
    if result not in CHECK_RESULTS:
        raise HTTPException(status_code=400, detail="检查结果不正确")
    if result == "UNTESTABLE":
        if not (note or "").strip():
            raise HTTPException(status_code=400, detail="无法测试要写明原因")
        if not evidence:
            raise HTTPException(status_code=400, detail="无法测试要留凭证")
    if result == "FAIL" and not (note or "").strip() and not evidence:
        raise HTTPException(status_code=400, detail="不通过要写说明或留凭证")
    if need_photo and result != "UNTESTABLE" and not evidence:
        raise HTTPException(status_code=400, detail="这一项要拍照")


def unbox_gap(db: Session, inspection_id: str) -> str | None:
    """开箱原片缺失或中断：给页面和复核看的一句话（禅道 WH04-16/17）。没开始逐项验的老单不提示。"""
    videos = (
        db.query(InspectionEvidence)
        .filter(InspectionEvidence.inspection_id == inspection_id, InspectionEvidence.kind == "UNBOX_VIDEO")
        .all()
    )
    if not videos:
        return "没有开箱视频：拆封前要先录，漏录了在复核时写明原因，补拍不能当作开箱原片"
    broken = [v for v in videos if v.interrupted]
    if broken and len(broken) == len(videos):
        return "开箱视频录制中断过：" + "；".join(v.gap_note or "原因没写" for v in broken)
    return None


def full_check_state(items: list[InspectionCheckItem]) -> dict:
    """全检到哪一步。「无法测试」可以先提交（货先入库或拒签），但不算全检完成：要补测成通过/不通过。

    NONE 没开始逐项验 / IN_PROGRESS 还有空项 / RETEST 只剩无法测试的待补测 / COMPLETE 全检完成
    """
    if not items:
        return {"state": "NONE", "label": "未开始逐项验货", "left": [], "retest": []}
    left = [i.title for i in items if not i.result]
    retest = [i.title for i in items if i.result == "UNTESTABLE"]
    if left:
        return {"state": "IN_PROGRESS", "label": f"验货中，还有 {len(left)} 项没验", "left": left, "retest": retest}
    if retest:
        return {"state": "RETEST", "label": f"全检未完成：{len(retest)} 项无法测试，待补测", "left": [], "retest": retest}
    return {"state": "COMPLETE", "label": "全检完成", "left": [], "retest": []}


def record_item(
    db: Session, task: Inspection, item: InspectionCheckItem, *, result: str, note: str | None, evidence: list, user_id: str,
    defect_part: str | None = None, seller_claim: str | None = None,
    disclosed: bool | None = None, cause: str | None = None,
) -> str:
    """记一个检查项。提交前随便改（留痕）；提交后只允许把「无法测试」补测成通过/不通过。

    返回动作 FILL / CHANGE / RETEST。改了已有答案时，排在它后面、已经填过的项要提示复核（见 review_hints）。
    """
    from app.enums import InspectionStatus

    submitted = task.status != InspectionStatus.PENDING
    if submitted:
        if item.result != "UNTESTABLE":
            raise HTTPException(status_code=400, detail="验货单已经提交，只有「无法测试」的项目能补测")
        if result not in ("PASS", "FAIL"):
            raise HTTPException(status_code=400, detail="补测要填通过或不通过")
    validate_item(result, note, evidence, item.need_photo)
    action = "RETEST" if submitted else ("FILL" if not item.result else "CHANGE")
    note = (note or "").strip() or None
    from app.services.inspection_compare import CAUSES

    if cause is not None and cause not in CAUSES:
        raise HTTPException(status_code=400, detail="原因只能是卖家没说清、运输造成或待判")
    new_disclosed = bool(disclosed) if result == "FAIL" and disclosed is not None else (item.disclosed if result == "FAIL" else False)
    new_cause = (cause or item.cause or "unknown") if result == "FAIL" else None
    if (action == "CHANGE" and item.result == result and item.note == note and (item.evidence or []) == evidence
            and item.defect_part == ((defect_part or "").strip() or None) and item.seller_claim == ((seller_claim or "").strip() or None)
            and bool(item.disclosed) == new_disclosed and item.cause == new_cause):
        return action  # 没改东西，不记
    db.add(InspectionCheckItemLog(
        inspection_id=task.id, item_key=item.item_key, action=action,
        old_result=item.result, new_result=result, old_note=item.note, new_note=note,
        old_evidence=list(item.evidence or []), operator_id=user_id,
    ))
    item.result = result
    item.note = note
    item.evidence = evidence
    # 部位、卖家描述只对不通过有意义；改成通过就清掉，免得旧瑕疵挂在合格项上
    item.defect_part = ((defect_part or "").strip()[:64] or None) if result == "FAIL" else None
    item.seller_claim = ((seller_claim or "").strip()[:255] or None) if result == "FAIL" else None
    # W11：卖家原来说过的不算新问题；原因没判的先待判
    item.disclosed = new_disclosed
    item.cause = new_cause
    item.operator_id = user_id
    item.checked_at = datetime.utcnow()
    return action


def review_hints(db: Session, inspection_id: str, items: list[InspectionCheckItem]) -> dict[str, str]:
    """前面的项改过答案、而后面的项是改之前填的：提示后面的项复核（判断可能受影响）。"""
    changes = (
        db.query(InspectionCheckItemLog)
        .filter(InspectionCheckItemLog.inspection_id == inspection_id, InspectionCheckItemLog.action == "CHANGE")
        .all()
    )
    if not changes:
        return {}
    order = {i.item_key: i.sort_order for i in items}
    hints = {}
    for item in items:
        if not item.result or not item.checked_at:
            continue
        for c in changes:
            if order.get(c.item_key, 1 << 30) < item.sort_order and c.created_at > item.checked_at:
                before = next((i.title for i in items if i.item_key == c.item_key), c.item_key)
                hints[item.item_key] = f"「{before}」改过答案，这一项请复核"
                break
    return hints


def assert_ready_to_submit(db: Session, task: Inspection, order: PurchaseOrder) -> None:
    """验货提交的门槛。坏货、拒签一样要验完，这是全检的意义。

    开始了逐项验货的单子一律要验完；没开始的，开关打开且有对应规范才拦（旧小程序还在用）。
    """
    items = check_items(db, task.id)
    if items:
        # 「无法测试」可以先提交，提交后挂在补测待办里，全检状态是「待补测」不是「完成」
        left = [i.title for i in items if not i.result]
        if left:
            raise HTTPException(status_code=400, detail=f"还有 {len(left)} 项没验：{'、'.join(left[:5])}")
        return
    if setting_on(db, FULL_CHECK_REQUIRED) and match_template(db, order):
        raise HTTPException(status_code=400, detail="这个商品要按验货规范逐项验完才能提交")


def check_uploaded(url: str, size_bytes: int | None) -> str | None:
    """凭证文件确实在图床上、大小对得上就返回 None；不是我们图床的地址不查。查不了（没配 OSS）也放行。"""
    from app.services.oss_media import public_url_to_object_key

    key = public_url_to_object_key(url)
    if not key:
        return None
    try:
        from app.services.oss import get_oss_bucket

        meta = get_oss_bucket().head_object(key)
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status", None)
        if status == 404:
            return "文件没传上去（图床上找不到），请重试上传"
        logger.warning("查凭证文件失败 %s：%s", key, exc)
        return None
    if size_bytes and meta.content_length and int(meta.content_length) != int(size_bytes):
        return f"文件只传了一部分（{meta.content_length}/{size_bytes} 字节），请重试上传"
    return None


def bind_evidence_to_sku(db: Session, inspection_id: str, sku_id: str) -> None:
    """入库生成 SKU 后，把验货时录的凭证挂上去。"""
    db.query(InspectionEvidence).filter(InspectionEvidence.inspection_id == inspection_id).update(
        {InspectionEvidence.sku_id: sku_id}, synchronize_session=False
    )


def _log(db: Session, exc: InspectionException, action: str, *, operator_id=None, target=None, detail=None) -> None:
    db.add(
        InspectionExceptionEvent(
            exception_id=exc.id,
            action=action,
            operator_id=operator_id,
            target_staff_id=target,
            detail=detail,
        )
    )


NOTICE_TITLES = {
    "NOTIFY_HANDLER": "验货异常，请处理拒签",
    "NOTIFY_PURCHASER": "验货异常，请交首轮凭证",
    "REMIND": "验货异常超时提醒",
    "ESCALATE": "验货异常超时升级",
}


def _notify(db: Session, exc: InspectionException, action: str, target: str | None, detail: str) -> None:
    """记一条待办，标成待推送。真正发企微在提交之后（deliver_pending），别让网络拖住请求。"""
    db.add(
        InspectionExceptionEvent(
            exception_id=exc.id,
            action=action,
            target_staff_id=target,
            detail=detail,
            channel_status="PENDING" if target else None,
        )
    )


MAX_ATTEMPTS = 3
EXCEPTIONS_URL = "http://127.0.0.1:8000"


def deliver_pending(db: Session, *, sender=None, ding_sender=None, limit: int = 50) -> int:
    """把待推送的通知发出去（钉钉优先、企微兜底，见 staff_notify）。两个 worker 都会调，靠条件更新抢到的才发。

    发送失败的过一会儿重试，最多 MAX_ATTEMPTS 次；第 n 次失败后隔 n×2 分钟再试。
    """
    now = datetime.utcnow()
    candidates = (
        db.query(InspectionExceptionEvent)
        .filter(InspectionExceptionEvent.channel_status.in_(("PENDING", "FAILED")))
        .order_by(InspectionExceptionEvent.created_at)
        .limit(limit * 2)
        .all()
    )
    rows = [
        e for e in candidates
        if e.channel_status == "PENDING"
        or ((e.channel_attempts or 0) < MAX_ATTEMPTS and e.channel_at and e.channel_at <= now - timedelta(minutes=2 * (e.channel_attempts or 1)))
    ][:limit]
    sent = 0
    for ev in rows:
        claimed = db.execute(
            update(InspectionExceptionEvent)
            .where(InspectionExceptionEvent.id == ev.id, InspectionExceptionEvent.channel_status == ev.channel_status)
            .values(channel_status="SENDING")
        ).rowcount
        db.commit()
        if not claimed:
            continue
        staff = db.get(Staff, ev.target_staff_id) if ev.target_staff_id else None
        status, detail = staff_notify.send(
            staff, NOTICE_TITLES.get(ev.action, "验货异常"), ev.detail or "", url=EXCEPTIONS_URL,
            ding_sender=ding_sender, wecom_sender=sender,
        )
        sent += status == staff_notify.SENT
        ev.channel_attempts = (ev.channel_attempts or 0) + (status != staff_notify.NO_ACCOUNT)
        ev.channel_status, ev.channel_detail, ev.channel_at = status, detail[:255], datetime.utcnow()
        db.commit()
    return sent


def deliver_in_background() -> None:
    """请求提交后由 BackgroundTasks 调，自己开会话。"""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        deliver_pending(db)
    except Exception:  # noqa: BLE001 - 发不出去巡检会再试，别影响请求
        logger.exception("验货异常通知推送失败")
    finally:
        db.close()


def notice_summary(events: list[InspectionExceptionEvent]) -> str | None:
    """给页面一句实话：发到了几个人、几个没绑企微、几个失败。"""
    notices = [e for e in events if e.channel_status]
    if not notices:
        return None
    count = lambda st: sum(1 for e in notices if e.channel_status == st)  # noqa: E731
    parts = []
    if count("SENT"):
        sent = [e for e in notices if e.channel_status == "SENT"]
        ding = sum(1 for e in sent if (e.channel_detail or "").startswith("钉钉"))
        how = "钉钉" if ding == len(sent) else ("企微" if not ding else f"钉钉 {ding} 人、企微 {len(sent) - ding} 人")
        parts.append(f"{how}已发出 {count('SENT')} 人" if ding in (0, len(sent)) else f"已发出 {count('SENT')} 人（{how}）")
    if count("NO_ACCOUNT"):
        parts.append(f"{count('NO_ACCOUNT')} 人没绑钉钉或企微，只有站内待办")
    failed = [e for e in notices if e.channel_status == "FAILED"]
    if failed:
        gave_up = sum(1 for e in failed if (e.channel_attempts or 0) >= MAX_ATTEMPTS)
        parts.append(f"{len(failed)} 人发送失败（{failed[-1].channel_detail}）" + ("，已停止重试" if gave_up else "，会自动重试"))
    if count("PENDING") + count("SENDING"):
        parts.append(f"{count('PENDING') + count('SENDING')} 人正在发")
    return "；".join(parts)


def _active_ids(db: Session, role: str) -> list[str]:
    rows = db.query(Staff.id).filter(Staff.role == role, Staff.status == StaffStatus.ACTIVE).all()
    return [r[0] for r in rows]


def _handler_ids(db: Session) -> list[str]:
    """所有业务员。还没有人是这个角色时给管理员，不能当没这回事。"""
    return _active_ids(db, StaffRole.BUSINESS) or _active_ids(db, StaffRole.ADMIN)


def raise_exception(
    db: Session,
    task: Inspection,
    order: PurchaseOrder,
    *,
    exception_type: str,
    description: str,
    user_id: str,
    now: datetime | None = None,
    reject_status: str = "PENDING",
    refund_amount: Decimal | None = None,
) -> InspectionException:
    """登记异常并立刻生成通知。不改验货单状态：发现异常后还要接着验。

    这张单已经有没结的异常时，新发现的情况追加到原异常上：十分钟从第一次发现算，
    不重新起算，也不再重复通知一遍。
    """
    if exception_type not in EXCEPTION_TYPES and exception_type != MISSING_EXCEPTION:
        raise HTTPException(status_code=400, detail="异常类型不正确")
    description = (description or "").strip()
    if not description:
        raise HTTPException(status_code=400, detail="请描述异常情况")
    now = now or datetime.utcnow()
    existing = (
        db.query(InspectionException)
        .filter(InspectionException.inspection_id == task.id, InspectionException.status == "OPEN")
        .order_by(InspectionException.raised_at)
        .first()
    )
    if existing:
        existing.description = f"{existing.description}\n追加：{description}"
        _log(db, existing, "APPENDED", operator_id=user_id, detail=description)
        return existing
    exc = InspectionException(
        inspection_id=task.id,
        purchase_order_id=order.id,
        exception_type=exception_type,
        description=description,
        status="OPEN",
        raised_by=user_id,
        raised_at=now,
        purchaser_id=order.created_by_id,
        due_at=now + timedelta(minutes=EXCEPTION_DUE_MINUTES),
        purchaser_evidence=[],
        reject_status=reject_status,
        refund_status="PENDING",
        refund_amount=refund_amount,
    )
    db.add(exc)
    db.flush()
    _log(db, exc, "RAISED", operator_id=user_id, detail=description)
    summary = f"{order.order_no} {order.product_name}：{description}"
    for target in _handler_ids(db):
        _notify(db, exc, "NOTIFY_HANDLER", target, f"请处理拒签、退回发件网点。{summary}")
    _notify(db, exc, "NOTIFY_PURCHASER", order.created_by_id, f"请 {EXCEPTION_DUE_MINUTES} 分钟内提交首轮凭证并处理退货退款。{summary}")
    return exc


def ensure_exception_for_reject(db: Session, task: Inspection, order: PurchaseOrder, reason: str, user_id: str) -> None:
    """走老的拒签按钮时也要有跟踪记录，否则退回和退款没人跟。"""
    existing = (
        db.query(InspectionException.id)
        .filter(InspectionException.inspection_id == task.id, InspectionException.status == "OPEN")
        .first()
    )
    if not existing:
        raise_exception(db, task, order, exception_type="OTHER", description=reason, user_id=user_id)


def overdue_parts(exc: InspectionException) -> list[str]:
    parts = []
    if not exc.handler_ack_at:
        parts.append("业务员未接单")
    if not exc.purchaser_evidence_at:
        parts.append("采购员未交凭证")
    return parts


def escalate_overdue(db: Session, now: datetime | None = None) -> int:
    """超时的催一次并升级给管理员。两个 worker 都在跑，靠条件更新保证只有一个做成。"""
    now = now or datetime.utcnow()
    rows = (
        db.query(InspectionException)
        .filter(
            InspectionException.status == "OPEN",
            InspectionException.escalated_at.is_(None),
            InspectionException.due_at <= now,
        )
        .all()
    )
    done = 0
    for exc in rows:
        parts = overdue_parts(exc)
        if not parts:
            continue
        claimed = db.execute(
            update(InspectionException)
            .where(InspectionException.id == exc.id, InspectionException.escalated_at.is_(None))
            .values(escalated_at=now)
        ).rowcount
        if not claimed:
            continue
        detail = f"超过 {EXCEPTION_DUE_MINUTES} 分钟：{'、'.join(parts)}"
        if not exc.handler_ack_at:
            for target in _active_ids(db, StaffRole.BUSINESS):
                _notify(db, exc, "REMIND", target, detail)
        if not exc.purchaser_evidence_at and exc.purchaser_id:
            _notify(db, exc, "REMIND", exc.purchaser_id, detail)
        for admin_id in _active_ids(db, StaffRole.ADMIN):
            _notify(db, exc, "ESCALATE", admin_id, detail)
        done += 1
    db.commit()
    return done


def _tick() -> int:
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        n = escalate_overdue(db)
        # 请求里的后台推送没跑成（进程重启等）的，在这里补发
        deliver_pending(db)
        return n
    finally:
        db.close()


async def run_escalation_loop() -> None:
    """常驻协程，由 main.lifespan 启动。"""
    while True:
        try:
            await asyncio.sleep(POLL_SECONDS)
            n = await asyncio.to_thread(_tick)
            if n:
                logger.info("验货异常超时升级 %d 条", n)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 循环必须活着
            logger.exception("验货异常超时升级一轮异常")


def assert_outbound_reviewed(db: Session, sku: Sku, outbound_type: str) -> OutboundReview | None:
    """发货门槛。开关关着放行，但有复核记录照样消耗，免得之后打开时拿旧复核出库。"""
    review = (
        db.query(OutboundReview)
        .filter(OutboundReview.sku_id == sku.id, OutboundReview.consumed_at.is_(None))
        .order_by(OutboundReview.created_at.desc())
        .first()
    )
    if review is not None and review.result == "PROBLEM":
        # 复核发现了新问题：不看开关，处理完重新复核成「核对无误」才能出库
        raise HTTPException(status_code=400, detail=f"出库复核发现新问题，处理后要重新复核：{review.remark or ''}".rstrip("："))
    if review is None and outbound_type in REVIEWED_OUTBOUND_TYPES and setting_on(db, OUTBOUND_REVIEW_REQUIRED):
        raise HTTPException(status_code=400, detail="发货前要先做出库复核")
    return review
