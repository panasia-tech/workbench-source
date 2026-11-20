"""禅道按 ERP 账号认人：没配 token 接口不存在，token 不对拒绝；按员工 ID、钉钉 userid 都能查；停用、设备账号算不在职。"""
import pytest
from fastapi import HTTPException

from app.config import settings
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers import zentao_link as R


def test_token_required(monkeypatch):
    monkeypatch.setattr(settings, "zentao_link_token", "")
    with pytest.raises(HTTPException) as e:
        R.require_zentao_token("Bearer x")
    assert e.value.status_code == 404
    monkeypatch.setattr(settings, "zentao_link_token", "secret-1")
    for bad in ("", "Bearer", "Bearer secret-2", "Basic secret-1"):
        with pytest.raises(HTTPException) as e:
            R.require_zentao_token(bad)
        assert e.value.status_code == 401
    R.require_zentao_token("Bearer secret-1")


def test_lookup_by_sub_and_dingtalk(db_session):
    db = db_session
    db.add(Staff(id="s1", staff_no="E1", username="hyc", name="何", role=StaffRole.ADMIN, status=StaffStatus.ACTIVE,
                 password_hash="x", dingtalk_userid="d1"))
    db.add(Staff(id="s2", staff_no="E2", username="lz", name="离职", role=StaffRole.SALES, status=StaffStatus.DISABLED,
                 password_hash="x", dingtalk_userid="d2"))
    db.add(Staff(id="s3", staff_no="E3", username="rfid", name="手持机", role=StaffRole.RFID_DEVICE, status=StaffStatus.ACTIVE,
                 password_hash="x"))
    db.commit()
    got = R.lookup_staff(sub=None, dingtalk_userid="d1", db=db)
    assert got == {"found": True, "sub": "s1", "username": "hyc", "name": "何", "staff_no": "E1", "role": "ADMIN",
                   "active": True, "admin": True}
    assert R.lookup_staff(sub="s2", dingtalk_userid=None, db=db)["active"] is False
    assert R.lookup_staff(sub="s3", dingtalk_userid=None, db=db)["active"] is False
    assert R.lookup_staff(sub="nope", dingtalk_userid=None, db=db) == {"found": False}
    assert R.lookup_staff(sub=None, dingtalk_userid="d9", db=db) == {"found": False}
    with pytest.raises(HTTPException):
        R.lookup_staff(sub="s1", dingtalk_userid="d1", db=db)
