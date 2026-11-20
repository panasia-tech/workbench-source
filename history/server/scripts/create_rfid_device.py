#!/usr/bin/env python3
"""创建 / 重置 RFID 手持机(PDA)设备账号。

用法:
    python scripts/create_rfid_device.py [username] [password] [name]

不带参数时默认创建: 用户名 rfid01 / 密码 rfid888888 / 名称 "RFID手持机01"。
该账号角色为 RFID_DEVICE,PDA 用 POST /api/auth/device-login 登录。
若用户名已存在,则重置其密码并确保角色/状态正确(便于改密)。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.services.order_no import generate_staff_no
from app.services.password import hash_password


def main():
    username = sys.argv[1] if len(sys.argv) > 1 else "rfid01"
    password = sys.argv[2] if len(sys.argv) > 2 else "rfid888888"
    name = sys.argv[3] if len(sys.argv) > 3 else "RFID手持机01"

    db = SessionLocal()
    staff = db.query(Staff).filter(Staff.username == username).first()
    if staff:
        staff.password_hash = hash_password(password)
        staff.role = StaffRole.RFID_DEVICE
        staff.status = StaffStatus.ACTIVE
        action = "更新"
    else:
        staff = Staff(
            staff_no=generate_staff_no(db),
            username=username,
            password_hash=hash_password(password),
            name=name,
            role=StaffRole.RFID_DEVICE,
            status=StaffStatus.ACTIVE,
        )
        db.add(staff)
        action = "创建"
    db.commit()
    print(f"{action} RFID 设备账号成功: 用户名={username} 密码={password} 角色=RFID_DEVICE")


if __name__ == "__main__":
    main()
