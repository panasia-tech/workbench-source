"""PublishSpec 校验:发布前拦下会出事的 spec(隐私图/库位图/缺图/无效价)。

「商品数据没验」的那半 —— 不管 spec 来自 ERP 组装还是人工,进 create_publish_batch
前必须过这关。对齐 publish_flow 的图片契约:
  只发商品实拍(sku/product/),**严禁** 买家隐私成交截图(asset/*_order_*)、库位图
  (sku/location/、location_images)、议价/改派证据。
校验不过抛 ValueError,由 API 层翻成 400,不让脏 spec 扇出成任务、更不让它发到闲鱼。

注意:URL 未必暴露图片归属(库位图可能存在普通 key 下),故这里是**安全网**而非唯一防线——
选对图源(只取 Sku.images/SkuListingInfo.images,绝不碰 location_images)是 ERP 组装侧的职责。
"""

from urllib.parse import urlparse

# 命中即拒的图片标记(在 URL path 里按子串匹配,大小写不敏感):
# _order_  买家隐私成交截图;/location、location_images 库位图;negotiat 议价证据;redispatch 顺丰改派凭证。
_FORBIDDEN_IMG_MARKERS = ("_order_", "/location", "location_images", "negotiat", "redispatch")


def validate_publish_spec(spec: dict) -> None:
    """校验 PublishSpec;不合法抛 ValueError(消息可直接回调用方/记日志)。成功返回 None。"""
    if not isinstance(spec, dict):
        raise ValueError("PublishSpec 必须是对象")

    imgs = spec.get("images")
    if not imgs:
        raise ValueError("缺少商品图，请先上传商品主图再上架")
    if not isinstance(imgs, list):
        raise ValueError("商品图数据异常，请重新上传后再上架")
    for u in imgs:
        if not isinstance(u, str) or not u.strip():
            raise ValueError("商品图有空项或无效链接，请重新上传后再上架")
        path = urlparse(u).path.lower()
        hit = next((m for m in _FORBIDDEN_IMG_MARKERS if m in path), None)
        if hit:
            raise ValueError("商品图里混入了隐私图/库位图/议价图，请移除后再上架")

    price = spec.get("price")
    # bool 是 int 子类,得先排掉,免得 True 被当 1 放行
    if isinstance(price, bool) or not isinstance(price, (int, float)) or int(price) <= 0:
        raise ValueError("售价必须大于 0 元，请填写正确售价后再上架")

    # 运费:闲鱼硬上限 500 元。超了发布时会被「无法发布宝贝,当前宝贝运费最高500元」弹窗拦下
    # (2026-08-01 真机实测:测试数据 fixed_fee=999 就栽在此)——拦在建 job 前,别扇出成必失败的任务。
    shipping = spec.get("shipping") or {}
    if shipping.get("mode") == "fixed_fee":
        fee = shipping.get("fixed_fee")
        if isinstance(fee, bool) or not isinstance(fee, (int, float)) or fee < 0 or fee > 500:
            raise ValueError(f"快递费必须在 0~500 元之间（闲鱼上限），当前 {fee} 元，请修改后再上架")
