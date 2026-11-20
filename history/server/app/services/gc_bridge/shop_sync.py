"""店铺 = gc 账号镜像的自动同步:新账号建店、改名跟随、账号删除则停用、未绑老店按名认领。

店铺↔gc 账号因此**全自动**,无需人工绑定:
手机上报昵称 → gc 按 nick 自动注册账号(不在表即建)→ 本同步把账号镜像成店铺;
历史遗留的未绑店铺(店名/闲鱼账号名 == 昵称)直接**认领**绑定,不新建重复店铺。

同步幂等,读路径(listing_shops.build_shops_payload)与发布路径(listing_ops._resolve_targets)
都可随时调用。gc 不可达时抛异常,由调用方吞掉(快照退化为 DB 里已有的镜像)。
只自动「建/改/停/认领」,不自动启用被人工停用的店铺。
"""

from sqlalchemy.orm import Session

from app.models import SaleShop
from app.services.gc_bridge import client as gc

import logging

logger = logging.getLogger(__name__)


def _unique_shop_code(db: Session, account_id: str) -> str:
    """gc 店铺编码:gc-<账号id前8>,撞码则逐步加长。"""
    for n in (8, 12, 16, 24, 32):
        code = f"gc-{account_id[:n]}"
        if not db.query(SaleShop).filter(SaleShop.code == code).first():
            return code
    return f"gc-{account_id}"[:32]


async def sync_gc_shops(db: Session) -> None:
    """群控账号 → sale_shop 镜像:新账号自动建店(label=闲鱼昵称)、改名跟随、账号删除则停用、
    未绑历史店铺按名(xianyu_user_name 或 label == 昵称)认领绑定。"""
    accounts = await gc.list_accounts()
    bound = {
        s.gc_account_id: s
        for s in db.query(SaleShop).filter(SaleShop.gc_account_id.isnot(None)).all()
    }
    seen: set[str] = set()
    for acc in accounts:
        aid = acc.get("id")
        nick = (acc.get("nick") or "").strip()
        if not aid or not nick:
            continue
        seen.add(aid)
        shop = bound.get(aid)
        if shop:
            if shop.label != nick or shop.xianyu_user_name != nick:
                shop.label = nick
                shop.xianyu_user_name = nick
            continue
        # 认领:历史遗留的未绑店铺,其闲鱼账号名/店名 == 昵称 → 直接绑上,不新建重复店铺
        legacy = (
            db.query(SaleShop)
            .filter(
                SaleShop.gc_account_id.is_(None),
                (SaleShop.xianyu_user_name == nick) | (SaleShop.label == nick),
            )
            .order_by(SaleShop.sort_order, SaleShop.code)
            .first()
        )
        if legacy:
            legacy.gc_account_id = aid
            legacy.label = nick
            legacy.xianyu_user_name = nick
            bound[aid] = legacy
        else:
            db.add(SaleShop(code=_unique_shop_code(db, aid), label=nick,
                            xianyu_user_name=nick, gc_account_id=aid, enabled=True))
    for aid, shop in bound.items():
        if aid not in seen and shop.enabled:
            shop.enabled = False
    db.commit()
    # 账号档案同步:新账号建档(PENDING)+ 采集字段只空补齐 + SN 匹配资产。
    # 失败(如 gc_device 采集列尚未就绪)不阻塞店铺同步。
    try:
        from app.services.gc_bridge.account_profile_sync import sync_gc_account_profiles
        await sync_gc_account_profiles(db)
    except Exception:
        logger.exception("账号档案同步失败(已跳过,不影响店铺同步)")
