"""工作台服务端换员工登录令牌（/api/miaoda/employee-token）。

# 这里钉死的

  1. 照样只认 MIAODA_API_KEY（鉴权在 test_miaoda_api.py 里钉死，这里不重复）；
  2. 只放在职真人：不存在 404、停用/删除 403、设备账号 403；
  3. 换出来的就是普通员工登录令牌：能过 get_current_user、角色跟着员工走。
"""

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.deps import get_current_user
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers.miaoda import employee_token
from app.schemas.miaoda import MiaodaEmployeeTokenIn
from app.services.password import hash_password


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Staff.__table__])
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield session
    session.close()


def _staff(db, username="u1", role=StaffRole.PURCHASER, status=StaffStatus.ACTIVE, deleted=False):
    from datetime import datetime

    s = Staff(staff_no=f"M-{username}", name="测试", username=username,
              password_hash=hash_password("pw"), role=role, status=status,
              deleted_at=datetime.utcnow() if deleted else None)
    db.add(s)
    db.commit()
    return s


def _exchange(db, staff_id):
    return employee_token(MiaodaEmployeeTokenIn(staff_id=staff_id), db)


def test_员工不存在404(db):
    with pytest.raises(HTTPException) as e:
        _exchange(db, "no-such-id")
    assert e.value.status_code == 404


def test_停用员工403(db):
    s = _staff(db, status=StaffStatus.DISABLED)
    with pytest.raises(HTTPException) as e:
        _exchange(db, s.id)
    assert e.value.status_code == 403


def test_已删除员工404(db):
    s = _staff(db, deleted=True)
    with pytest.raises(HTTPException) as e:
        _exchange(db, s.id)
    assert e.value.status_code == 404


@pytest.mark.parametrize("role", [StaffRole.RFID_DEVICE, StaffRole.CRAWLER, StaffRole.MARKET_BOT])
def test_设备账号403(db, role):
    s = _staff(db, role=role)
    with pytest.raises(HTTPException) as e:
        _exchange(db, s.id)
    assert e.value.status_code == 403


def test_换来的令牌能当本人登录用(db, monkeypatch):
    monkeypatch.setattr(settings, "jwt_expire_minutes", 60)
    s = _staff(db, role=StaffRole.SALES)
    res = _exchange(db, s.id)
    assert res.role == StaffRole.SALES and res.name == "测试" and res.expires_in == 3600
    me = get_current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials=res.token), db)
    assert me.id == s.id
