import logging
from datetime import datetime
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import PaymentBinding, PaymentTransaction, PickupPayment
from app.services import alipay
from app.services.pickup_payment import (
    PAID_STATUSES,
    PickupPaymentMismatch,
    build_wap_pay_url,
    complete_pickup_payment,
    mark_mismatch,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/alipay", tags=["alipay"])


def _parse_amount(raw: str | None) -> Decimal | None:
    if not raw:
        return None
    try:
        return Decimal(raw)
    except (InvalidOperation, TypeError):
        return None


def _parse_time(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


@router.post("/notify", summary="支付宝异步通知回调")
async def alipay_notify(request: Request, db: Session = Depends(get_db)):
    """支付宝异步通知回调：验签 + 落库（幂等），成功必须回纯文本 success。"""
    form = await request.form()
    params = {k: str(v) for k, v in form.items()}

    if not alipay.verify_notify(params):
        logger.warning("alipay notify 验签失败: out_trade_no=%s", params.get("out_trade_no"))
        return PlainTextResponse("failure")

    # 校验 app_id，避免他人伪造（已验签前提下仍兜底）
    if settings.alipay_app_id and params.get("app_id") and params["app_id"] != settings.alipay_app_id:
        logger.warning("alipay notify app_id 不匹配: %s", params.get("app_id"))
        return PlainTextResponse("failure")

    out_trade_no = params.get("out_trade_no")
    trade_no = params.get("trade_no")
    trade_status = params.get("trade_status") or ""
    amount = _parse_amount(params.get("total_amount"))

    # 优先处理自提扫码收款：支付成功 → 自动出库（幂等）
    pickup = (
        db.query(PickupPayment).filter(PickupPayment.out_trade_no == out_trade_no).first()
        if out_trade_no
        else None
    )
    if pickup is not None:
        if trade_status in PAID_STATUSES and pickup.status != "DONE":
            try:
                complete_pickup_payment(
                    db,
                    pickup,
                    trade_no=trade_no,
                    paid_time=_parse_time(params.get("gmt_payment")),
                    trade=params,
                )
            except PickupPaymentMismatch as exc:
                # 金额/收款方对不上：重推多少次都是同样结果，落 MISMATCH 等人工，
                # 回 success 停止重推（不出库，钱也不会被误认为收到）
                db.rollback()
                mark_mismatch(db, pickup, str(exc))
                return PlainTextResponse("success")
            except Exception:  # noqa: BLE001
                logger.exception("自提收款自动出库失败: out_trade_no=%s", out_trade_no)
                return PlainTextResponse("failure")  # 让支付宝重推，下次再试
        return PlainTextResponse("success")

    binding = (
        db.query(PaymentBinding).filter(PaymentBinding.out_trade_no == out_trade_no).first()
        if out_trade_no
        else None
    )

    # 幂等：同一 trade_no 已落库则直接成功返回
    txn = None
    if trade_no:
        txn = db.query(PaymentTransaction).filter(PaymentTransaction.txn_id == trade_no).first()

    if txn is None:
        if binding is None:
            # 无法匹配业务单：记日志但仍回 success，避免支付宝无限重推
            logger.warning("alipay notify 未匹配到 binding: out_trade_no=%s trade_no=%s", out_trade_no, trade_no)
            return PlainTextResponse("success")
        txn = PaymentTransaction(
            account_id=binding.account_id,
            channel="ALIPAY",
            direction=binding.direction or "IN",
            amount=amount if amount is not None else binding.expected_amount,
            out_trade_no=out_trade_no,
            txn_id=trade_no,
            status=trade_status[:16],
            source="ALIPAY_NOTIFY",
            trade_time=_parse_time(params.get("gmt_payment")),
            ingested_at=datetime.utcnow(),
            raw=params,
        )
        db.add(txn)
    else:
        # 状态推进（如 WAIT_BUYER_PAY -> TRADE_SUCCESS）
        txn.status = trade_status[:16]
        if amount is not None:
            txn.amount = amount
        txn.trade_time = _parse_time(params.get("gmt_payment")) or txn.trade_time
        txn.raw = params

    # 回写 binding 的支付宝交易号
    if binding is not None and trade_no:
        binding.alipay_trade_no = trade_no

    if trade_status in PAID_STATUSES:
        logger.info("alipay notify 支付成功: out_trade_no=%s trade_no=%s amount=%s", out_trade_no, trade_no, amount)

    db.commit()
    return PlainTextResponse("success")


# ---------------------------------------------------------------------------
# 买家侧页面（无需登录：这是买家在自己手机上打开的，不是 ERP 内部接口）
# 只回显金额与状态，不暴露货号、成本、操作人等内部信息。
# ---------------------------------------------------------------------------

_PAGE = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
 body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      background:#f5f5f7;color:#1d1d1f;padding:24px}}
 .box{{background:#fff;border-radius:16px;padding:32px 24px;text-align:center;
       max-width:340px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.06)}}
 .icon{{font-size:44px;line-height:1}}
 h1{{font-size:19px;margin:16px 0 8px}}
 p{{margin:0;color:#6e6e73;font-size:14px}}
 .amt{{font-size:30px;font-weight:600;margin:12px 0 4px}}
</style>
<div class="box"><div class="icon">{icon}</div><h1>{title}</h1>{body}</div>"""


def _page(icon: str, title: str, body: str = "", status_code: int = 200) -> HTMLResponse:
    return HTMLResponse(_PAGE.format(icon=icon, title=title, body=body), status_code=status_code)


@router.get("/pay/{out_trade_no}", include_in_schema=False)
def pickup_pay_redirect(out_trade_no: str, db: Session = Depends(get_db)):
    """买家扫码后落到这里，302 跳支付宝收银台。

    二维码里放这个短链而不是上千字符的签名 URL，码面才扫得动；
    签名在这一刻实时生成，时间戳总是新的。
    """
    payment = db.query(PickupPayment).filter(PickupPayment.out_trade_no == out_trade_no).first()
    if payment is None:
        return _page("❓", "收款单不存在", "<p>请让店员重新出示收款码</p>", status_code=404)
    if payment.status in ("PAID", "DONE"):
        return _page("✅", "该订单已支付", "<p>无需重复付款</p>")
    if payment.status in ("EXPIRED", "CANCELLED"):
        return _page("⏰", "收款码已失效", "<p>请让店员重新生成</p>")
    if payment.status == "MISMATCH":
        return _page("⚠️", "该订单需人工处理", "<p>请联系店员</p>")
    if datetime.utcnow() >= payment.expires_at:
        return _page("⏰", "收款码已超时", "<p>请让店员重新生成</p>")
    try:
        url = build_wap_pay_url(payment)
    except Exception:  # noqa: BLE001
        logger.exception("生成收银台地址失败: out_trade_no=%s", out_trade_no)
        return _page("⚠️", "收款码生成失败", "<p>请让店员重试</p>", status_code=500)
    return RedirectResponse(url, status_code=302)


@router.get("/pay/{out_trade_no}/done", include_in_schema=False)
def pickup_pay_done(out_trade_no: str, db: Session = Depends(get_db)):
    """付款完成 / 中途退出后的落地页。

    以本地状态为准展示：钱是否真到账由异步通知和店员那边的轮询决定，
    这个页面不触发任何状态变更，纯回显。
    """
    payment = db.query(PickupPayment).filter(PickupPayment.out_trade_no == out_trade_no).first()
    if payment is None:
        return _page("❓", "订单不存在", status_code=404)
    amount = f'<div class="amt">¥{payment.sale_price}</div>'
    if payment.status in ("PAID", "DONE"):
        return _page("✅", "支付成功", f"{amount}<p>请等待店员确认后取货</p>")
    if payment.status in ("EXPIRED", "CANCELLED"):
        return _page("⏰", "订单已失效", "<p>如已扣款请联系店员</p>")
    return _page("⏳", "尚未收到付款", f"{amount}<p>若已完成支付，请稍候片刻或联系店员</p>")
