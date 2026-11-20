#!/usr/bin/env python3
"""创建 / 重置财务(FINANCE)账号。

用法:
    python scripts/create_finance.py [username] [password] [name]

不带参数时默认创建: 用户名 finance01 / 密码 finance888888 / 名称 "财务"。
该账号角色为 FINANCE：登录后仅显示「我的」页面，可在「经营账单」查看采购/销售
金额统计与逐笔明细。财务首次使用在小程序「绑定」页输入该用户名+密码绑定微信。
若用户名已存在,则重置其密码并确保角色/状态为 FINANCE / ACTIVE。
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
    username = sys.argv[1] if len(sys.argv) > 1 else "finance01"
    password = sys.argv[2] if len(sys.argv) > 2 else "finance888888"
    name = sys.argv[3] if len(sys.argv) > 3 else "财务"

    db = SessionLocal()
    staff = db.query(Staff).filter(Staff.username == username).first()
    if staff:
        staff.password_hash = hash_password(password)
        staff.role = StaffRole.FINANCE
        staff.status = StaffStatus.ACTIVE
        action = "更新"
    else:
        staff = Staff(
            staff_no=generate_staff_no(db),
            username=username,
            password_hash=hash_password(password),
            name=name,
            role=StaffRole.FINANCE,
            status=StaffStatus.ACTIVE,
        )
        db.add(staff)
        action = "创建"
    db.commit()
    print(f"{action}财务账号成功: 用户名={username} 密码={password} 角色=FINANCE")


if __name__ == "__main__":
    main()
