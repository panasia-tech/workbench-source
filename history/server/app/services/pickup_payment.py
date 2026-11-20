"""自提扫码收款：创建收款码、轮询/通知 → 支付成功自动出库。

支付成功的处理是幂等的，轮询接口与异步通知都会走 complete()，谁先到谁完成。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from types import SimpleNamespace

from sqlalchemy.orm import Session

from app.config import settings
from app.enums import OutboundType, ShopListingStatus, SkuStatus
from app.models import PickupPayment, Sku, SkuShopListing, Staff
from app.services import alipay
from app.services.order_no import generate_order_no

logger = logging.getLogger(__name__)

PICKUP_TIMEOUT_MINUTES = 15
PAID_STATUSES = {"TRADE_SUCCESS", "TRADE_FINISHED"}
# 过期单清扫：每轮最多处理多少张，避免堆积时一次性打爆支付宝网关
SWEEP_BATCH_SIZE = 50


class PickupPaymentError(Exception):
    pass


class PickupPaymentMismatch(PickupPaymentError):
    """收款金额或收款方与本单不符：绝不出库，置 MISMATCH 等人工处理。"""


def _now() -> datetime:
    return datetime.utcnow()


def qr_data_uri(qr_code: str | None) -> str | None:
    """把支付宝返回的 qr_code 字符串渲染成 PNG 的 base64 data URI，供小程序 <image> 直接显示。"""
    if not qr_code:
        return None
    import segno

    return segno.make(qr_code, error="m").png_data_uri(scale=8, border=2)


def _money(value) -> Decimal:
    """统一量化到分，避免 "123.0" 与 "123.00" 被判成不等。"""
    return Decimal(str(value)).quantize(Decimal("0.01"))


def verify_trade(payment: PickupPayment, trade: dict) -> None:
    """核对支付宝回传的交易与本单一致。不一致抛 PickupPaymentMismatch。

    验签只能证明「这条消息确实来自支付宝」，证明不了「这笔钱是这一单的、金额对、收款方是我们」。
    支付宝官方要求验签后再核对 out_trade_no / total_amount / seller_id / app_id，缺一不可。
    （app_id 在通知入口已校验，此处补齐其余三项。）
    """
    out_trade_no = trade.get("out_trade_no")
    if out_trade_no and out_trade_no != payment.out_trade_no:
        raise PickupPaymentMismatch(
            f"商户订单号不符：期望 {payment.out_trade_no}，实际 {out_trade_no}"
        )

    raw_amount = trade.get("total_amount")
    if raw_amount is None:
        raise PickupPaymentMismatch("支付宝未返回 total_amount，无法核对金额")
    try:
        paid = _money(raw_amount)
    except (InvalidOperation, TypeError, ValueError):
        raise PickupPaymentMismatch(f"total_amount 非法：{raw_amount!r}") from None
    expected = _money(payment.sale_price)
    if paid != expected:
        raise PickupPaymentMismatch(f"收款金额不符：应收 {expected}，实收 {paid}")

    # seller_id：异步通知必带；trade.query 并非所有版本都回传，缺失则跳过这一项
    seller_id = trade.get("seller_id")
    expected_seller = (settings.alipay_seller_id or "").strip()
    if not expected_seller:
        logger.warning(
            "未配置 alipay_seller_id，跳过收款方校验: out_trade_no=%s", payment.out_trade_no
        )
    elif seller_id and seller_id != expected_seller:
        raise PickupPaymentMismatch(f"收款方不符：期望 {expected_seller}，实际 {seller_id}")


def mark_mismatch(db: Session, payment: PickupPayment, reason: str) -> None:
    """金额/收款方对不上：冻结成 MISMATCH，不出库，留人工核。"""
    payment.status = "MISMATCH"
    payment.remark = f"{payment.remark or ''}\n[收款异常] {reason}".strip()
    db.commit()
    logger.error("自提收款校验不通过: out_trade_no=%s %s", payment.out_trade_no, reason)


def pickup_mode() -> str:
    """出码模式：wap=手机网站支付 / precreate=当面付。非法值一律按 wap 处理。"""
    return "precreate" if (settings.alipay_pickup_mode or "").strip().lower() == "precreate" else "wap"


def _public_base() -> str:
    """本服务的公网前缀，用于拼买家侧页面地址。

    优先取 alipay_pay_redirect_base；没配就从 notify_url 反推（它本来就必须是公网可达的）。
    """
    base = (settings.alipay_pay_redirect_base or "").strip().rstrip("/")
    if base:
        return base
    notify = (settings.alipay_notify_url or "").strip()
    if notify:
        from urllib.parse import urlparse

        u = urlparse(notify)
        if u.scheme and u.netloc:
            return f"{u.scheme}://{u.netloc}"
    return ""


def build_wap_pay_url(payment: PickupPayment) -> str:
    """手机网站支付：拼出买家扫码后打开的收银台 URL。

    买家用支付宝扫码 → 支付宝内置浏览器打开该 URL → 收银台付款。
    每次调用都会重新签名（时间戳刷新），同一 out_trade_no 重复打开是同一笔订单，不会重复下单。
    """
    base = _public_base()
    if not base:
        raise PickupPaymentError("未配置公网地址（ALIPAY_PAY_REDIRECT_BASE 或 ALIPAY_NOTIFY_URL），无法生成收款码")
    done_url = f"{base}/api/alipay/pay/{payment.out_trade_no}/done"
    return alipay.build_page_url(
        "alipay.trade.wap.pay",
        {
            "out_trade_no": payment.out_trade_no,
            "total_amount": f"{Decimal(payment.sale_price):.2f}",
            "subject": payment.subject or f"自提-{payment.sku_code}",
            "product_code": "QUICK_WAP_WAY",
            "timeout_express": f"{PICKUP_TIMEOUT_MINUTES}m",
            # 买家中途退出/付完都回到本服务的结果页，避免落到空白页
            "quit_url": done_url,
        },
        notify_url=settings.alipay_notify_url or None,
        return_url=done_url,
    )


def _wap_qr_target(payment: PickupPayment) -> str:
    """二维码里实际编码的字符串。

    配了 ALIPAY_PAY_REDIRECT_BASE 就编短跳转链——签名 URL 上千字符，直接编码出来的码
    格子极细、手机不好扫；短链在跳转时再实时签名，码面清爽。
    没配则退回直接编码长 URL（能用，就是密）。
    """
    base = (settings.alipay_pay_redirect_base or "").strip().rstrip("/")
    if base:
        return f"{base}/api/alipay/pay/{payment.out_trade_no}"
    return build_wap_pay_url(payment)


async def create_pickup_payment(
    db: Session,
    user: Staff,
    *,
    sku_code: str,
    sale_price: Decimal,
    buyer_name: str | None,
    evidence_urls: list | None,
    express_fee: Decimal | None,
    remark: str | None,
) -> PickupPayment:
    auto_success = settings.pickup_payment_auto_success
    if auto_success:
        if not (evidence_urls or []):
            raise PickupPaymentError("请上传至少 1 张成交凭证")
    elif not alipay.is_configured():
        raise PickupPaymentError("支付宝未配置，无法生成收款码")
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise PickupPaymentError("SKU 不存在")
    if sku.status != SkuStatus.IN_STOCK:
        raise PickupPaymentError("商品不在库，无法收款出库")
    listed_count = (
        db.query(SkuShopListing)
        .filter(
            SkuShopListing.sku_id == sku.id,
            SkuShopListing.publish_status == ShopListingStatus.LISTED,
        )
        .count()
    )
    if listed_count > 0:
        raise PickupPaymentError(f"商品仍在 {listed_count} 个店铺在架，请先全部下架后再自提收款")
    if sale_price is None or Decimal(sale_price) <= 0:
        raise PickupPaymentError("售价必须大于 0")

    out_trade_no = generate_order_no(db, "PAY", PickupPayment, "out_trade_no")
    subject = f"自提-{sku_code}"
    payment = PickupPayment(
        out_trade_no=out_trade_no,
        sku_id=sku.id,
        sku_code=sku_code,
        buyer_name=buyer_name,
        sale_price=Decimal(sale_price),
        evidence_urls=evidence_urls or [],
        express_fee=express_fee,
        remark=remark,
        operator_id=user.id,
        subject=subject,
        status="PENDING",
        expires_at=_now() + timedelta(minutes=PICKUP_TIMEOUT_MINUTES),
    )
    db.add(payment)
    db.flush()

    # 沙箱临时模式：不生成真实收款码，直接判为支付成功并出库
    if auto_success:
        logger.info("自提收款沙箱直通: out_trade_no=%s sku=%s 凭证=%d张", out_trade_no, sku_code, len(evidence_urls or []))
        return complete_pickup_payment(db, payment, trade_no=None, skip_verify=True)

    if pickup_mode() == "wap":
        # 手机网站支付：本地签名拼 URL，不需要调支付宝，也就没有网关往返
        payment.qr_code = _wap_qr_target(payment)
    else:
        biz = await alipay.call_gateway(
            "alipay.trade.precreate",
            {
                "out_trade_no": out_trade_no,
                "total_amount": f"{Decimal(sale_price):.2f}",
                "subject": subject,
                "timeout_express": f"{PICKUP_TIMEOUT_MINUTES}m",
            },
            notify_url=settings.alipay_notify_url or None,
        )
        if biz.get("code") != "10000" or not biz.get("qr_code"):
            raise PickupPaymentError(biz.get("sub_msg") or biz.get("msg") or "生成收款码失败")
        payment.qr_code = biz["qr_code"]
    db.commit()
    db.refresh(payment)
    return payment


def _lock_payment(db: Session, payment: PickupPayment) -> PickupPayment:
    """对收款单加行锁并返回最新状态，让并发的完成动作串行化。

    生产 erp-api 跑 --workers 2，通知回调、状态轮询、定时清扫可能落在不同进程里，
    没有锁的话两边会同时看到 PENDING，各自建一张出库单（双重出库）。
    SQLite（测试）不支持 FOR UPDATE，跳过加锁——测试是单线程的，不受影响。
    """
    if db is None or db.bind is None or db.bind.dialect.name == "sqlite":
        return payment
    locked = (
        db.query(PickupPayment)
        .filter(PickupPayment.id == payment.id)
        .with_for_update()
        .first()
    )
    return locked or payment


def complete_pickup_payment(
    db: Session,
    payment: PickupPayment,
    *,
    trade_no: str | None,
    paid_time: datetime | None = None,
    trade: dict | None = None,
    skip_verify: bool = False,
) -> PickupPayment:
    """幂等：校验交易 → 创建自提出库 → 标记 DONE。已 DONE 直接返回。

    trade 为支付宝回传的交易字段（通知表单或 trade.query 业务节点），会核对金额与收款方。
    skip_verify 仅供沙箱直通模式使用；真实支付路径必须传 trade，否则直接抛错——
    宁可报错也不能让「忘了校验」变成静默放行。
    """
    # 先抢行锁再判状态：并发进入时，后到的那个会在这里等，拿到锁后看到的已是 DONE
    payment = _lock_payment(db, payment)
    if payment.status == "DONE":
        return payment
    if payment.status == "MISMATCH":
        raise PickupPaymentMismatch("该收款单此前已校验不通过，请人工处理")

    if not skip_verify:
        if trade is None:
            raise PickupPaymentError("缺少支付宝交易信息，拒绝出库")
        verify_trade(payment, trade)

    sku = db.get(Sku, payment.sku_id)
    operator = db.get(Staff, payment.operator_id)
    if sku is None or operator is None:
        raise PickupPaymentError("收款单关联的 SKU 或操作人不存在")

    payment.alipay_trade_no = trade_no or payment.alipay_trade_no
    payment.paid_at = paid_time or payment.paid_at or _now()
    payment.status = "PAID"

    # 复用库存出库逻辑（_do_outbound 用 getattr 取字段，传简单对象即可）
    req = SimpleNamespace(
        sale_price=payment.sale_price,
        buyer_name=payment.buyer_name,
        evidence_urls=payment.evidence_urls or [],
        payment_screenshot_url=None,
        express_fee=payment.express_fee,
        tracking_no=None,
        tracking_phone_suffix=None,
        remark=payment.remark,
        sale_order_id=None,
    )
    from app.routers.inventory import _do_outbound  # 延迟导入避免循环依赖

    outbound = _do_outbound(db, operator, sku, req, OutboundType.PICKUP)
    db.flush()
    payment.outbound_id = outbound.id
    payment.status = "DONE"
    db.commit()
    db.refresh(payment)
    from app.services import stock_lock_delist

    stock_lock_delist.after_stock_left(db, sku, reason="自提收款出库", operator_id=operator.id)
    logger.info("自提收款完成并出库: out_trade_no=%s trade_no=%s outbound=%s", payment.out_trade_no, trade_no, outbound.outbound_no)
    return payment


async def sync_and_complete(db: Session, payment: PickupPayment) -> PickupPayment:
    """轮询用：查支付宝交易状态，已支付则自动出库，超时则置 EXPIRED。"""
    if payment.status in ("DONE", "EXPIRED", "CANCELLED", "MISMATCH"):
        return payment

    try:
        biz = await alipay.call_gateway("alipay.trade.query", {"out_trade_no": payment.out_trade_no})
    except alipay.AlipayError as exc:
        logger.warning("查询自提收款失败 %s: %s", payment.out_trade_no, exc)
        biz = {}

    trade_status = biz.get("trade_status")
    if trade_status in PAID_STATUSES:
        gmt = biz.get("send_pay_date")
        paid_time = None
        if gmt:
            try:
                paid_time = datetime.strptime(gmt, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                paid_time = None
        try:
            return complete_pickup_payment(
                db, payment, trade_no=biz.get("trade_no"), paid_time=paid_time, trade=biz
            )
        except PickupPaymentMismatch as exc:
            mark_mismatch(db, payment, str(exc))
            return payment

    # 未支付且已超时 → 关单
    if _now() >= payment.expires_at:
        payment.status = "EXPIRED"
        db.commit()
        try:
            await alipay.call_gateway("alipay.trade.cancel", {"out_trade_no": payment.out_trade_no})
        except alipay.AlipayError:
            pass
        db.refresh(payment)
    return payment


async def sweep_expired(db: Session, *, limit: int = SWEEP_BATCH_SIZE) -> int:
    """定时清扫到点仍未完结的收款单，返回处理条数。

    小程序一旦退出页面就不再轮询，没有这个兜底的话，过期单会永远挂在 PENDING、
    支付宝那边的码也不会被撤销。复用 sync_and_complete：顺便捞回「买家其实付了、
    但异步通知丢了且操作员已离开」的漏单。
    """
    if settings.pickup_payment_auto_success or not alipay.is_configured():
        return 0
    if not _try_sweep_lock(db):
        return 0  # 另一个 worker 正在扫，本轮跳过
    rows = (
        db.query(PickupPayment)
        .filter(PickupPayment.status == "PENDING", PickupPayment.expires_at <= _now())
        .order_by(PickupPayment.expires_at)
        .limit(limit)
        .all()
    )
    handled = 0
    for row in rows:
        try:
            await sync_and_complete(db, row)
            handled += 1
        except Exception:  # noqa: BLE001 - 单张失败不能带走整轮清扫
            db.rollback()
            logger.exception("清扫过期收款单失败: out_trade_no=%s", row.out_trade_no)
    if handled:
        logger.info("清扫过期自提收款单 %d 张", handled)
    _release_sweep_lock(db)
    return handled


_SWEEP_LOCK = "erp_pickup_payment_sweep"


def _try_sweep_lock(db: Session) -> bool:
    """MySQL 具名锁：多 worker 下只让一个进程真正执行清扫。

    拿不到就跳过本轮（5 分钟后还有下一轮，不需要排队等待）。
    非 MySQL（测试）直接放行。
    """
    if db.bind is None or db.bind.dialect.name != "mysql":
        return True
    from sqlalchemy import text

    try:
        return bool(db.execute(text("SELECT GET_LOCK(:k, 0)"), {"k": _SWEEP_LOCK}).scalar())
    except Exception:  # noqa: BLE001
        logger.exception("获取清扫锁失败，跳过本轮")
        return False


def _release_sweep_lock(db: Session) -> None:
    if db.bind is None or db.bind.dialect.name != "mysql":
        return
    from sqlalchemy import text

    try:
        db.execute(text("SELECT RELEASE_LOCK(:k)"), {"k": _SWEEP_LOCK})
    except Exception:  # noqa: BLE001
        logger.warning("释放清扫锁失败（连接关闭时会自动释放）")


SWEEP_INTERVAL_SECONDS = 300


async def run_sweeper_loop() -> None:
    """常驻协程：定期清扫过期收款单。由 main.lifespan 启动，进程退出时取消。

    生产是 --workers 2，每个 worker 都会起这个循环，靠 MySQL 具名锁保证同一时刻
    只有一个进程真正在扫；出库本身另有行锁兜底。
    """
    import asyncio

    from app.database import SessionLocal

    while True:
        try:
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
            db = SessionLocal()
            try:
                await sweep_expired(db)
            finally:
                db.close()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 循环必须活着
            logger.exception("自提收款清扫循环异常")
