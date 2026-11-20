"""本机内部通知接口：只放本机直连；按员工发、管理员发通知名单。"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.config import settings
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers import internal_notify as R
from app.services import dingtalk, staff_notify


def _req(host="127.0.0.1", headers=None):
    return SimpleNamespace(client=SimpleNamespace(host=host), headers=headers or {})


def test_only_local_without_proxy_headers():
    R.require_local(_req())
    for req in (_req("127.0.0.1"), _req(headers={"x-real-ip": "127.0.0.1"}), _req(headers={"x-forwarded-for": "127.0.0.1"})):
        with pytest.raises(HTTPException):
            R.require_local(req)


def test_sends_to_staff_and_admin_list(db_session, monkeypatch):
    db = db_session
    db.add(Staff(id="s1", staff_no="E1", username="a", name="小王", role=StaffRole.SALES, status=StaffStatus.ACTIVE,
                 password_hash="x", dingtalk_userid="d1"))
    db.add(Staff(id="s2", staff_no="E2", username="b", name="离职", role=StaffRole.SALES, status=StaffStatus.DISABLED, password_hash="x"))
    db.commit()
    monkeypatch.setattr(dingtalk, "configured", lambda: True)
    monkeypatch.setattr(settings, "dingtalk_notify_userids", "boss1,boss2")
    calls = []
    monkeypatch.setattr(dingtalk, "send_card", lambda ids, t, md, url, b: calls.append(ids) or (True, "ok"))
    out = R.staff_notify_api(R.NotifyIn(staff_ids=["s1", "s2", "s1"], admins=True, title="闲鱼新消息", body="买家：在吗", url="https://x"), db)
    assert calls == [["d1"], ["boss1", "boss2"]]
    assert [r["status"] for r in out["results"]] == ["SENT", "SKIPPED", "SENT"]
