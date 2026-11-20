"""技术部新人 GitHub 账号 → 自动邀请进代码仓库。不连真 GitHub：FakeGithub 顶替 HTTP。"""
from datetime import datetime

import pytest

from app.config import settings
from app.models import Staff
from app.services import github_invite

NOW = datetime(2026, 11, 10, 22, 30)


class FakeGithub:
    def __init__(self, users=(), emails=None, invite_code=201):
        self.users = {u.lower(): u for u in users}
        self.emails = emails or {}
        self.invite_code = invite_code
        self.calls = []

    def __call__(self, method, path, *, params=None, json=None):
        self.calls.append((method, path))
        if path == "/search/users":
            email = params["q"].split(" ")[0]
            login = self.emails.get(email)
            return 200, {"total_count": 1 if login else 0, "items": [{"login": login}] if login else []}
        if path.startswith("/users/"):
            login = self.users.get(path.rsplit("/", 1)[1].lower())
            return (200, {"login": login}) if login else (404, {"message": "Not Found"})
        if method == "PUT" and "/collaborators/" in path:
            return self.invite_code, {}
        raise AssertionError(path)


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setattr(settings, "github_invite_token", "t")
    monkeypatch.setattr(settings, "github_invite_repos", "superzou2021/erp-miniprogram")


def _staff(account):
    return Staff(staff_no="E021", username="E021", password_hash="x", name="新人", github_account=account)


def test_clean_account():
    assert github_invite.clean_account(" @FangDongzi ") == "FangDongzi"
    assert github_invite.clean_account("a.b@example.com") == "a.b@example.com"
    assert github_invite.clean_account("  ") is None
    for bad in ("有中文", "a b", "-bad", "x" * 40):
        with pytest.raises(ValueError):
            github_invite.clean_account(bad)


def test_username_is_invited():
    gh = FakeGithub(users=["FangDongzi"])
    staff = _staff("fangdongzi")
    status = github_invite.invite(staff, http=gh, now=NOW)
    assert ("PUT", "/repos/superzou2021/erp-miniprogram/collaborators/FangDongzi") in gh.calls
    assert status.startswith("11-10 22:30 FangDongzi：") and "已发邀请" in status
    assert staff.github_status == status


def test_email_resolved_to_login_or_asks_for_username():
    gh = FakeGithub(emails={"478abec743@example.invalid": "alice"})
    assert "alice：" in github_invite.invite(_staff("478abec743@example.invalid"), http=gh, now=NOW)
    status = github_invite.invite(_staff("d2e87fa970@example.invalid"), http=gh, now=NOW)
    assert "请改填 GitHub 用户名" in status
    assert not any(m == "PUT" for m, _ in gh.calls[2:])


def test_already_collaborator_unknown_user_and_no_token(monkeypatch):
    assert "已经在仓库里" in github_invite.invite(_staff("bob"), http=FakeGithub(users=["bob"], invite_code=204), now=NOW)
    assert "没有用户 nobody" in github_invite.invite(_staff("nobody"), http=FakeGithub(), now=NOW)
    assert "邀请失败（403" in github_invite.invite(_staff("bob"), http=FakeGithub(users=["bob"], invite_code=403), now=NOW)
    monkeypatch.setattr(settings, "github_invite_token", "")
    gh = FakeGithub(users=["bob"])
    assert "还没配 GitHub 令牌" in github_invite.invite(_staff("bob"), http=gh, now=NOW)
    assert gh.calls == []
