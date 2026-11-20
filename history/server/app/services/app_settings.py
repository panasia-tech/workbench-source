"""页面上改的键值配置（app_setting 表）的读写。"""
from sqlalchemy.orm import Session

from app.models import AppSetting

# 聊天「发送仓库位置」发出去的那段自提地址
PICKUP_ADDRESS = "pickup_address"


def get_setting(db: Session, key: str, default: str = "") -> str:
    row = db.get(AppSetting, key)
    return row.value if row is not None else default


def set_setting(db: Session, key: str, value: str, staff_id: str | None) -> str:
    row = db.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value=value, updated_by=staff_id)
        db.add(row)
    else:
        row.value = value
        row.updated_by = staff_id
    db.commit()
    return value
