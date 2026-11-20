#!/usr/bin/env python3
"""创建 / 重置 闲鱼行情爬虫 APP 设备账号。

用法:
    python scripts/create_crawler_device.py [username] [password] [name]

不带参数时默认创建: 用户名 crawler01 / 密码 crawler888888 / 名称 "闲鱼行情爬虫01"。
该账号角色为 CRAWLER,APP 用 POST /api/auth/crawler-login 登录。
若用户名已存在,则重置其密码并确保角色/状态正确。
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
    username = sys.argv[1] if len(sys.argv) > 1 else "crawler01"
    password = sys.argv[2] if len(sys.argv) > 2 else "crawler888888"
    name = sys.argv[3] if len(sys.argv) > 3 else "闲鱼行情爬虫01"

    db = SessionLocal()
    staff = db.query(Staff).filter(Staff.username == username).first()
    if staff:
        staff.password_hash = hash_password(password)
        staff.role = StaffRole.CRAWLER
        staff.status = StaffStatus.ACTIVE
        action = "更新"
    else:
        staff = Staff(
            staff_no=generate_staff_no(db),
            username=username,
            password_hash=hash_password(password),
            name=name,
            role=StaffRole.CRAWLER,
            status=StaffStatus.ACTIVE,
        )
        db.add(staff)
        action = "创建"
    db.commit()
    print(f"{action} 爬虫设备账号成功: 用户名={username} 密码={password} 角色=CRAWLER")


if __name__ == "__main__":
    main()
