#!/usr/bin/env python3
"""创建初始管理员与基础数据。用法: python scripts/seed.py"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.enums import StaffRole, StaffStatus
from app.models import PurchaseAccount, Staff, WarehouseLocation
from app.services.order_no import generate_staff_no
from app.services.password import hash_password


def main():
    db = SessionLocal()
    if not db.query(Staff).filter(Staff.username == "admin").first():
        db.add(
            Staff(
                staff_no=generate_staff_no(db),
                username="admin",
                password_hash=hash_password("admin123"),
                name="管理员",
                role=StaffRole.ADMIN,
                status=StaffStatus.ACTIVE,
            )
        )
    if not db.query(PurchaseAccount).first():
        db.add_all([
            PurchaseAccount(code="xianyu_a", label="闲鱼号 A", sort_order=1),
            PurchaseAccount(code="xianyu_b", label="闲鱼号 B", sort_order=2),
        ])
    if not db.query(WarehouseLocation).first():
        db.add(WarehouseLocation(code="A-01", zone="A", sort_order=1))
    db.commit()
    print("seed ok: admin / admin123")


if __name__ == "__main__":
    main()
