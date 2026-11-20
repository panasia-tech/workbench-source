"""自提扫码收款：交易校验、防误放行、通知验签。

这条链路直接决定「钱有没有真收到就出库」，之前零覆盖。重点守三件事：
1. 验签通过 ≠ 这笔钱是这一单的 —— 金额/订单号/收款方必须逐项核对；
2. 忘记传交易信息时必须报错，不能静默出库；
3. 通知验签的待签名串要排除 sign 和 sign_type（与网关请求签名规则不同）。
"""

import base64
from decimal import Decimal

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.config import settings
from app.models import PickupPayment
from app.services import alipay
from app.services.pickup_payment import (
    PickupPaymentError,
    PickupPaymentMismatch,
    complete_pickup_payment,
    verify_trade,
)


def _payment(**kw) -> PickupPayment:
    base = dict(
        out_trade_no="PAY20260907001",
        sku_code="SKU-1",
        sale_price=Decimal("1288.00"),
        status="PENDING",
    )
    base.update(kw)
    return PickupPayment(**base)


def _trade(**kw) -> dict:
    base = {
        "out_trade_no": "PAY20260907001",
        "total_amount": "1288.00",
        "seller_id": "2088999900001111",
        "trade_status": "TRADE_SUCCESS",
    }
    base.update(kw)
    return base


@pytest.fixture()
def seller(monkeypatch):
    monkeypatch.setattr(settings, "alipay_seller_id", "2088999900001111")


# ---------------------------------------------------------------- 金额与收款方

def test_金额一致时通过(seller):
    verify_trade(_payment(), _trade())


def test_金额末尾零不影响判定(seller):
    """支付宝可能回 "1288.0"，不能因为字符串不同就误判成金额不符。"""
    verify_trade(_payment(), _trade(total_amount="1288.0"))


def test_少付被拦下(seller):
    with pytest.raises(PickupPaymentMismatch, match="收款金额不符"):
        verify_trade(_payment(), _trade(total_amount="12.88"))


def test_多付也被拦下(seller):
    with pytest.raises(PickupPaymentMismatch, match="收款金额不符"):
        verify_trade(_payment(), _trade(total_amount="2000.00"))


def test_缺少金额字段拒绝出库(seller):
    t = _trade()
    del t["total_amount"]
    with pytest.raises(PickupPaymentMismatch, match="无法核对金额"):
        verify_trade(_payment(), t)


def test_金额非法拒绝出库(seller):
    with pytest.raises(PickupPaymentMismatch, match="非法"):
        verify_trade(_payment(), _trade(total_amount="abc"))


def test_串单被拦下(seller):
    with pytest.raises(PickupPaymentMismatch, match="商户订单号不符"):
        verify_trade(_payment(), _trade(out_trade_no="PAY-别人的单"))


def test_跨商户收款被拦下(seller):
    with pytest.raises(PickupPaymentMismatch, match="收款方不符"):
        verify_trade(_payment(), _trade(seller_id="2088000000000000"))


def test_未配置seller_id时跳过该项但仍校验金额(monkeypatch):
    monkeypatch.setattr(settings, "alipay_seller_id", "")
    verify_trade(_payment(), _trade(seller_id="2088000000000000"))
    with pytest.raises(PickupPaymentMismatch, match="收款金额不符"):
        verify_trade(_payment(), _trade(seller_id="2088000000000000", total_amount="1.00"))


def test_查单未回传seller_id时不误判(seller):
    """alipay.trade.query 并非总回 seller_id，缺失应跳过而不是判为不符。"""
    t = _trade()
    del t["seller_id"]
    verify_trade(_payment(), t)


# ------------------------------------------------------------ 防「忘记校验」

def test_未传交易信息拒绝出库():
    """真实支付路径漏传 trade 必须炸出来，绝不能默认放行。"""
    with pytest.raises(PickupPaymentError, match="缺少支付宝交易信息"):
        complete_pickup_payment(None, _payment(), trade_no="2026090722001", trade=None)


def test_已出库单幂等返回():
    p = _payment(status="DONE")
    assert complete_pickup_payment(None, p, trade_no="x", trade=None) is p


def test_已标记异常的单不再出库():
    with pytest.raises(PickupPaymentMismatch, match="人工处理"):
        complete_pickup_payment(None, _payment(status="MISMATCH"), trade_no="x", trade=_trade())


# ---------------------------------------------------------------- 通知验签

@pytest.fixture()
def keypair(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = base64.b64encode(
        key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    ).decode()
    pub = base64.b64encode(
        key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    ).decode()
    monkeypatch.setattr(settings, "alipay_app_private_key", priv)
    monkeypatch.setattr(settings, "alipay_public_key", pub)
    monkeypatch.setattr(settings, "alipay_sign_type", "RSA2")
    return priv, pub


def _signed_notify(params: dict) -> dict:
    """按异步通知规则签名：待签名串排除 sign 与 sign_type。"""
    content = alipay._sign_content(params, exclude_sign_type=True)
    key = alipay._load_private_key()
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    sig = key.sign(content.encode(), padding.PKCS1v15(), hashes.SHA256())
    return {**params, "sign": base64.b64encode(sig).decode(), "sign_type": "RSA2"}


def test_合法通知验签通过(keypair):
    assert alipay.verify_notify(_signed_notify(_trade())) is True


def test_金额被篡改后验签失败(keypair):
    """签名覆盖全部业务字段：改一个字都过不了。"""
    notify = _signed_notify(_trade())
    notify["total_amount"] = "0.01"
    assert alipay.verify_notify(notify) is False


def test_无签名直接拒绝(keypair):
    assert alipay.verify_notify(_trade()) is False


def test_签名串必须排除sign_type(keypair):
    """把 sign_type 也算进待签名串是常见错法，这里锁住正确规则。"""
    params = _trade()
    wrong = alipay._sign_content({**params, "sign_type": "RSA2"})  # 错：含 sign_type
    right = alipay._sign_content(params, exclude_sign_type=True)
    assert "sign_type" in wrong and "sign_type" not in right


# ------------------------------------------------- 手机网站支付出码（wap 模式）

from urllib.parse import parse_qs, urlparse  # noqa: E402

from app.services.pickup_payment import (  # noqa: E402
    _wap_qr_target,
    build_wap_pay_url,
    pickup_mode,
)


@pytest.fixture()
def wap(monkeypatch, keypair):
    monkeypatch.setattr(settings, "alipay_app_id", "2021000000000000")
    monkeypatch.setattr(settings, "alipay_gateway", "https://openapi.alipay.com/gateway.do")
    monkeypatch.setattr(settings, "alipay_notify_url", "https://api.example.com/api/alipay/notify")
    monkeypatch.setattr(settings, "alipay_encrypt_key", "")
    monkeypatch.setattr(settings, "alipay_pickup_mode", "wap")
    monkeypatch.setattr(settings, "alipay_pay_redirect_base", "")


def _query(url: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def test_模式默认为wap(monkeypatch):
    monkeypatch.setattr(settings, "alipay_pickup_mode", "")
    assert pickup_mode() == "wap"


def test_模式非法值回落wap(monkeypatch):
    monkeypatch.setattr(settings, "alipay_pickup_mode", "乱填的")
    assert pickup_mode() == "wap"


def test_显式配置当面付(monkeypatch):
    monkeypatch.setattr(settings, "alipay_pickup_mode", "PreCreate")
    assert pickup_mode() == "precreate"


def test_wap链接带齐必要业务参数(wap):
    url = build_wap_pay_url(_payment(subject="自提-SKU-1"))
    q = _query(url)
    assert q["method"] == "alipay.trade.wap.pay"
    assert q["app_id"] == "2021000000000000"
    assert q["sign"]
    biz = __import__("json").loads(q["biz_content"])
    assert biz["out_trade_no"] == "PAY20260907001"
    assert biz["total_amount"] == "1288.00"
    assert biz["product_code"] == "QUICK_WAP_WAY"  # 手机网站支付固定值，写错会被网关拒
    assert biz["quit_url"].endswith("/api/alipay/pay/PAY20260907001/done")


def test_wap链接金额按分格式化(wap):
    """1288 必须变成 "1288.00"，支付宝对金额格式是强校验。"""
    biz = __import__("json").loads(_query(build_wap_pay_url(_payment(sale_price=Decimal("1288"))))["biz_content"])
    assert biz["total_amount"] == "1288.00"


def test_wap链接签名可被验证(wap):
    """自签自验一遍，确保 URL 里的 sign 覆盖的是实际发出的参数。"""
    q = _query(build_wap_pay_url(_payment()))
    sign = q.pop("sign")
    content = alipay._sign_content(q)
    assert alipay._verify_content(content, sign, "RSA2", settings.alipay_public_key)


def test_未配公网地址时拒绝出码(wap, monkeypatch):
    """quit_url 缺不得，宁可报错也不能出一个跳到空白页的码。"""
    monkeypatch.setattr(settings, "alipay_notify_url", "")
    monkeypatch.setattr(settings, "alipay_pay_redirect_base", "")
    with pytest.raises(PickupPaymentError, match="未配置公网地址"):
        build_wap_pay_url(_payment())


def test_配了短链就编码短链(wap, monkeypatch):
    monkeypatch.setattr(settings, "alipay_pay_redirect_base", "https://api.example.com/")
    target = _wap_qr_target(_payment())
    assert target == "https://api.example.com/api/alipay/pay/PAY20260907001"
    assert len(target) < 60  # 码面清爽的关键


def test_没配短链就直接编码长URL(wap):
    target = _wap_qr_target(_payment())
    assert target.startswith("https://openapi.alipay.com/gateway.do?")
    # 长 URL 远超 qr_code 原来的 String(512)，065 迁移放宽为 Text 就是为了这个
    assert len(target) > 512


# ------------------------------------------------ 买家侧页面（扫码后真正会看到的）

@pytest.fixture()
def client(wap, monkeypatch):
    """只建 pickup_payment 一张表：这两个页面不碰其他表。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.database import Base, get_db
    from app.routers.alipay import router

    monkeypatch.setattr(settings, "alipay_pay_redirect_base", "https://api.example.com")
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine, tables=[PickupPayment.__table__])
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: Session()

    db = Session()
    app.state._db = db
    with TestClient(app) as c:
        c._db = db
        yield c
    db.close()


def _persist(db, **kw):
    from datetime import datetime, timedelta

    p = _payment(**kw)
    p.sku_id = "sku-1"
    p.operator_id = "staff-1"
    p.expires_at = kw.pop("expires_at", None) or datetime.utcnow() + timedelta(minutes=15)
    db.add(p)
    db.commit()
    return p


def test_扫码跳转到支付宝收银台(client):
    _persist(client._db)
    r = client.get("/api/alipay/pay/PAY20260907001", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://openapi.alipay.com/gateway.do?")
    assert "alipay.trade.wap.pay" in loc


def test_不存在的单不跳转(client):
    r = client.get("/api/alipay/pay/PAY-不存在", follow_redirects=False)
    assert r.status_code == 404
    assert "收款单不存在" in r.text


def test_已支付的单不再跳转收银台(client):
    """防重复付款：钱已经收了就不能再把买家送进收银台。"""
    _persist(client._db, status="DONE")
    r = client.get("/api/alipay/pay/PAY20260907001", follow_redirects=False)
    assert r.status_code == 200
    assert "已支付" in r.text


def test_过期的单不再跳转收银台(client):
    from datetime import datetime, timedelta

    _persist(client._db, expires_at=datetime.utcnow() - timedelta(minutes=1))
    r = client.get("/api/alipay/pay/PAY20260907001", follow_redirects=False)
    assert r.status_code == 200
    assert "超时" in r.text


def test_异常单引导找店员(client):
    _persist(client._db, status="MISMATCH")
    r = client.get("/api/alipay/pay/PAY20260907001", follow_redirects=False)
    assert "人工处理" in r.text


def test_结果页按本地状态回显(client):
    _persist(client._db, status="DONE")
    r = client.get("/api/alipay/pay/PAY20260907001/done")
    assert r.status_code == 200
    assert "支付成功" in r.text and "1288" in r.text


def test_结果页未付款时不谎报成功(client):
    """买家中途退出也会落到这页，绝不能显示成功。"""
    _persist(client._db)
    r = client.get("/api/alipay/pay/PAY20260907001/done")
    assert "尚未收到付款" in r.text and "支付成功" not in r.text


def test_买家页面不泄露内部信息(client):
    _persist(client._db, buyer_name="张三")
    r = client.get("/api/alipay/pay/PAY20260907001/done")
    assert "SKU-1" not in r.text and "张三" not in r.text
