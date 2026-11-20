"""账号档案 = gc 账号初始化档案的自动同步。

链路:手机/PC 采集 → gc 服务器 gc_device(serial/imei/phone/member_name) → 本同步镜像进档案。
- 新 gc 账号 → 自动建 PENDING 档案;
- 采集字段**只空补齐**(人工填的/已采集的不覆盖);gc_device_id 跟随账号当前激活设备;
- device_serial 匹配 asset_device(device_sn 或 sn_normalized,均按「去非字母数字+大写」比较)→ 自动关联资产。

幂等,挂在 shop_sync.sync_gc_shops 之后跑;gc 不可达时抛异常由调用方吞掉(与店铺同步同语义)。
"""

from sqlalchemy.orm import Session

from app.models import AssetDevice
from app.models.account_profile import GcAccountProfile
from app.services.gc_bridge import client as gc

# 采集字段:只空补齐(profile 为空且 device 非空才填)
_COLLECTED_FIELDS = ("device_serial", "imei1", "imei2", "phone_number", "member_name")
# device → profile 字段名映射(device_serial ↔ serial)
_DEVICE_FIELD_MAP = {
    "device_serial": "serial",
    "imei1": "imei1",
    "imei2": "imei2",
    "phone_number": "phone_number",
    "member_name": "xianyu_member_name",
}


def _norm_sn(s: str | None) -> str:
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())


def _match_asset(db: Session, profile: GcAccountProfile) -> bool:
    """按 SN 匹配资产设备,写入 asset_device_id/asset_no。已关联或没 SN 则跳过。"""
    if profile.asset_device_id or not profile.device_serial:
        return False
    target = _norm_sn(profile.device_serial)
    if not target:
        return False
    candidates = db.query(AssetDevice).filter(
        (AssetDevice.device_sn.isnot(None)) | (AssetDevice.sn_normalized.isnot(None))
    ).all()
    for dev in candidates:
        if _norm_sn(dev.device_sn) == target or _norm_sn(dev.sn_normalized) == target:
            profile.asset_device_id = dev.id
            profile.asset_no = dev.asset_no
            return True
    return False


async def sync_gc_account_profiles(db: Session) -> dict:
    accounts = await gc.list_accounts()
    devices = await gc.list_devices()
    dev_by_id = {d.get("id"): d for d in devices if d.get("id")}

    created = filled = matched = 0
    for acc in accounts:
        aid = acc.get("id")
        nick = (acc.get("nick") or "").strip()
        if not aid or not nick:
            continue
        profile = (
            db.query(GcAccountProfile)
            .filter(GcAccountProfile.gc_account_id == aid)
            .first()
        )
        if not profile:
            profile = GcAccountProfile(gc_account_id=aid, nick=nick)
            db.add(profile)
            created += 1
        elif profile.nick != nick:
            profile.nick = nick  # 改名跟随(与店铺同步同语义)

        dev = dev_by_id.get(acc.get("device_id"))
        if dev:
            profile.gc_device_id = dev.get("id")  # 激活设备跟随
            for pfield in _COLLECTED_FIELDS:
                if getattr(profile, pfield):
                    continue  # 只空补齐
                v = dev.get(_DEVICE_FIELD_MAP[pfield])
                if v:
                    setattr(profile, pfield, v)
                    filled += 1
        if _match_asset(db, profile):
            matched += 1
    db.commit()
    return {"created": created, "filled_fields": filled, "asset_matched": matched,
            "accounts": len(accounts)}
