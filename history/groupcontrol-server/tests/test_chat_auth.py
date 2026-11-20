import time
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

from app.config import settings
from app import auth

SECRET = "DEMO_ONLY_REDACTED"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "jwt_secret", SECRET)


def _cred(token):
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def _tok(role="SALES", sub="s1", exp_delta=3600):
    return jwt.encode({"sub": sub, "role": role, "exp": int(time.time()) + exp_delta},
                      SECRET, algorithm="HS256")


def test_get_current_staff_valid():
    u = auth.get_current_staff(_cred(_tok(role="SALES", sub="s1")))
    assert u == {"staff_id": "s1", "role": "SALES"}


def test_get_current_staff_missing_401():
    with pytest.raises(HTTPException) as e:
        auth.get_current_staff(None)
    assert e.value.status_code == 401


def test_get_current_staff_bad_signature_401():
    bad = jwt.encode({"sub": "s1", "role": "SALES", "exp": int(time.time()) + 60},
                     "wrong-secret", algorithm="HS256")
    with pytest.raises(HTTPException) as e:
        auth.get_current_staff(_cred(bad))
    assert e.value.status_code == 401


def test_get_current_staff_expired_401():
    with pytest.raises(HTTPException) as e:
        auth.get_current_staff(_cred(_tok(exp_delta=-10)))
    assert e.value.status_code == 401


@pytest.mark.parametrize("role", ["PURCHASER", "SALES", "ADMIN"])
def test_require_chat_access_allows(role):
    u = {"staff_id": "s1", "role": role}
    assert auth.require_chat_access(u) is u


@pytest.mark.parametrize("role", ["WAREHOUSE", "NEGOTIATOR", "FINANCE", None])
def test_require_chat_access_forbids_403(role):
    with pytest.raises(HTTPException) as e:
        auth.require_chat_access({"staff_id": "s1", "role": role})
    assert e.value.status_code == 403


def test_empty_secret_rejects(monkeypatch):
    monkeypatch.setattr(settings, "jwt_secret", "")
    forged = jwt.encode({"sub": "x", "role": "ADMIN", "exp": int(time.time()) + 3600},
                        "", algorithm="HS256")
    with pytest.raises(HTTPException) as e:
        auth.get_current_staff(_cred(forged))
    assert e.value.status_code == 500


def test_missing_exp_rejected():
    tok = jwt.encode({"sub": "s1", "role": "SALES"}, SECRET, algorithm="HS256")
    with pytest.raises(HTTPException) as e:
        auth.get_current_staff(_cred(tok))
    assert e.value.status_code == 401
