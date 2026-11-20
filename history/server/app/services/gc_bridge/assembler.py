"""从 ERP 商品数据组装 gc-server 的 PublishSpec。

数据取源(老板 2026-07-22 拍板):**SkuListingInfo 优先,缺则回退 Sku**。
- 图:SkuListingInfo.images 优先,缺则 Sku.images。**只取商品实拍图**,绝不碰 Sku.location_images
  (库位图)/negotiation_media(议价证据)——gc 侧 validate_publish_spec 会再拦一道。
- 价:SkuListingInfo.price 优先,缺则 Sku.suggest_price(元,取整;gc 价格用整数元)。
- 运费:不填(或填 0)→ 一口价 0 元;填了正数 → 一口价该金额。**不再用「包邮」方式**
  (老板 2026-10-29 定:执行端默认结果从包邮改为一口价 0)。
- 标题/描述:方案 C 描述由闲鱼 AI 从图生成,标题是 AI 生成后回读;
  description 字段是 AI 两轮不出时的**保底种子文案**(见 _seed_description)。

PublishSpec 形状见 groupcontrol-server/app/flow/publish_flow.py。
"""

from __future__ import annotations

from decimal import Decimal

from app.models import Sku, SkuListingInfo
from app.services.auto_listing.pricing import to_int_yuan
from app.services.oss_media import sign_oss_publish_image_url


def _to_int_yuan(v) -> int | None:
    # 跟自动定价同一个取整口径，定价时判过不亏，挂出去也不会少 1 块
    return to_int_yuan(v)


def _pick_images(info: SkuListingInfo | None, sku: Sku | None) -> list[str]:
    """商品实拍图:SkuListingInfo.images 优先,缺则 Sku.images。签名成可下载 URL。
    严格只用这两个字段——location_images/negotiation_media 等隐私/库位图绝不入选。
    签名时挂 OSS 缩放(长边 1600):执行端拿到手就是压过的图,手机原图不再卡发布页。"""
    raw = None
    if info and info.images:
        raw = info.images
    elif sku and sku.images:
        raw = sku.images
    if not raw:
        return []
    signed = [sign_oss_publish_image_url(u) for u in list(raw)]
    return [u for u in signed if isinstance(u, str) and u.strip()]


def _seed_description(sku: Sku, info: SkuListingInfo | None) -> str:
    """AI 文案两轮不出时的保底描述(gc step_description 的种子)。
    优先上架信息描述;缺则按品名拼一条,保证非空——空描述会把流程拖到标题注入才死。"""
    if info and (info.desc or "").strip():
        return info.desc.strip()
    name = (sku.product_name or "").strip() if sku else ""
    return f"【{name}】成色如图，功能正常，实物拍摄，喜欢直接拍，细节私聊。" if name else ""


def build_publish_spec(
    sku: Sku,
    info: SkuListingInfo | None,
    *,
    confirm_publish: bool = False,
    worry_free_sell: bool = False,
) -> dict:
    """组装 gc PublishSpec。price/images 缺失时**照样返回**(交给 gc 侧 validate_publish_spec 拒),
    好让「没配图/没配价」以 400 明确报错,而不是这里静默吞掉。"""
    images = _pick_images(info, sku)
    price = _to_int_yuan(info.price if info and info.price is not None else None)
    if price is None and sku is not None:
        price = _to_int_yuan(sku.suggest_price)

    # 运费:没填/填 0 都发「一口价 0 元」,不再发「包邮」(老板 2026-10-29 定)。
    fee = _to_int_yuan(info.express_fee) if info and info.express_fee is not None else None
    if fee is None or fee < 0:
        fee = 0
    shipping = {"mode": "fixed_fee", "fixed_fee": fee, "self_pickup": True}

    return {
        "images": images,
        # AI 从图生成失败时的保底文案(两轮重试仍不出 → gc 用它写入描述框)
        "description": _seed_description(sku, info),
        "ai_rewrite": True,
        "price": price,
        "shipping": shipping,
        "worry_free_sell": worry_free_sell,
        "confirm_publish": confirm_publish,
    }
