"""密码库填进 AdsPower（11-17）：工位登记公钥 → 主人批准 → 工位领加密包 → 交回执。

红线：
  1. 没批准 / 停用的电脑领不到；换了公钥要重新批准；只有解了锁的主人能批；
  2. 发出去的是按这台电脑公钥加密的包，换一把私钥、或者挪到别的条目 / 别的电脑上都解不开；
  3. 只给本机 AdsPower 里有的环境；一条被一台领走 5 分钟内别的工位领不到；
  4. 回执对不上不算填好；读回核对不一致记「填失败」；
  5. 改了密码自动变「等填」；员工在开店步骤交的密码按店铺挂的环境自动去填。
"""

import base64
import json
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import HTTPException

from app.config import settings
from app.enums import StaffRole, StaffStatus
from app.models import LedgerVault, Staff
from app.routers import ledger as api
from app.services import ledger_onboard as lo
from app.services import ledger_vault as lv
from app.services import ledger_vault_ads as la


def _staff(db, sid, role=StaffRole.SALES):
    s = Staff(id=sid, staff_no=sid, username=sid, password_hash="x", name=sid, role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    return s


def _key():
    k = X25519PrivateKey.generate()
    pub = k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return k, base64.b64encode(pub).decode()


def _bad(fn, *a, code=400, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    assert e.value.status_code == code, e.value.detail
    return e.value.detail


@pytest.fixture()
def ctx(db_session, monkeypatch):
    monkeypatch.setattr(settings, "ledger_vault_kek", "22" * 32)
    monkeypatch.setattr(settings, "ledger_vault_owners", "boss")
    db = db_session
    boss, emp, admin2 = _staff(db, "boss", StaffRole.ADMIN), _staff(db, "emp"), _staff(db, "admin2", StaffRole.ADMIN)
    db.commit()
    secret = lv.bind_start(db, boss)["secret"]
    lv.bind_confirm(db, boss, lv.totp_now(secret)[0])
    token = lv.unlock(db, boss, lv.totp_at(secret, int(time.time() // 30) + 1), None)["token"]
    env = api.create_row("device", api.RowIn(kind="env", name="闲鱼环境 1", ads_user_id="kabc123"), db=db, user=boss)["id"]
    env2 = api.create_row("device", api.RowIn(kind="env", name="闲鱼环境 2", ads_user_id="kzzz999"), db=db, user=boss)["id"]
    db.commit()
    return db, boss, emp, admin2, token, env, env2


def _item(db, boss, env, **kw):
    v = lv.save(db, boss, {"category": "platform", "title": "闲鱼 1 号", "login_name": "tb_123", "password": "DEMO_ONLY_REDACTED",
                           "totp": "JBSWY3DPEHPK3PXP", "device_id": env, **kw})
    db.commit()
    return v


def _open(priv, item):
    return json.loads(la.open_with(priv, item["box"], la.aad_for(item["item_id"], "pc-1")))


def test_批准后领到加密包_解开是这条的密码_回执对上才算填好(ctx):
    db, boss, emp, admin2, token, env, env2 = ctx
    v = _item(db, boss, env, ads_domain="goofish.com")
    assert v.ads_status == "pending"
    priv, pub = _key()
    s = la.register(db, emp, "pc-1", "前台电脑", pub)
    assert s.status == "pending" and len(s.fingerprint) == 19
    _bad(la.poll, db, emp, "pc-1", ["kabc123"], code=403)
    _bad(la.decide_station, db, admin2, token, "pc-1", True, code=403)  # 别的管理员批不了
    la.decide_station(db, boss, token, "pc-1", True)
    db.commit()

    items = la.poll(db, emp, "pc-1", ["kabc123", "other"])
    db.commit()
    assert len(items) == 1 and items[0]["ads_user_id"] == "kabc123"
    assert "Pw-1!" not in json.dumps(items[0])  # 线上传的只有密文
    got = _open(priv, items[0])
    assert (got["username"], got["password"], got["fakey"], got["domain"]) == ("tb_123", "Pw-1!", "JBSWY3DPEHPK3PXP", "goofish.com")
    # 别的私钥、挪到别的电脑 / 条目上都解不开
    other, _ = _key()
    with pytest.raises(Exception):
        la.open_with(other, items[0]["box"], la.aad_for(v.id, "pc-1"))
    with pytest.raises(Exception):
        la.open_with(priv, items[0]["box"], la.aad_for(v.id, "pc-2"))
    # 回执编不出来
    _bad(la.result, db, emp, "pc-1", v.id, "瞎编的", True, True, None, code=409)
    la.result(db, emp, "pc-1", v.id, got["ack"], True, True, None)
    db.commit()
    assert db.get(LedgerVault, v.id).ads_status == "synced"
    assert la.poll(db, emp, "pc-1", ["kabc123"]) == []  # 填好了不再发


def test_读回对不上记填失败_主人点重填又能领(ctx):
    db, boss, emp, admin2, token, env, env2 = ctx
    v = _item(db, boss, env)
    priv, pub = _key()
    la.register(db, emp, "pc-1", "前台", pub)
    la.decide_station(db, boss, token, "pc-1", True)
    got = _open(priv, la.poll(db, emp, "pc-1", ["kabc123"])[0])
    la.result(db, emp, "pc-1", v.id, got["ack"], True, False, None)
    db.commit()
    v = db.get(LedgerVault, v.id)
    assert v.ads_status == "error" and "对不上" in v.ads_error
    api.vault_ads_sync(v.id, x_vault_token=token, db=db, user=boss)
    assert len(la.poll(db, emp, "pc-1", ["kabc123"])) == 1


def test_一台领走5分钟内别台领不到_只给本机有的环境(ctx):
    db, boss, emp, admin2, token, env, env2 = ctx
    _item(db, boss, env)
    _item(db, boss, env2, title="闲鱼 2 号")
    for sid in ("pc-1", "pc-2"):
        la.register(db, emp, sid, sid, _key()[1])
        la.decide_station(db, boss, token, sid, True)
    db.commit()
    assert [i["ads_user_id"] for i in la.poll(db, emp, "pc-1", ["kabc123"])] == ["kabc123"]
    assert la.poll(db, emp, "pc-2", ["kabc123"]) == []
    assert [i["ads_user_id"] for i in la.poll(db, emp, "pc-2", ["kabc123", "kzzz999"])] == ["kzzz999"]


def test_换公钥要重新批准_停用的领不到(ctx):
    db, boss, emp, admin2, token, env, env2 = ctx
    _item(db, boss, env)
    la.register(db, emp, "pc-1", "前台", _key()[1])
    la.decide_station(db, boss, token, "pc-1", True)
    db.commit()
    s = la.register(db, emp, "pc-1", "前台", _key()[1])
    assert s.status == "pending"
    _bad(la.poll, db, emp, "pc-1", ["kabc123"], code=403)
    la.decide_station(db, boss, token, "pc-1", False)
    _bad(la.poll, db, emp, "pc-1", ["kabc123"], code=403)
    _bad(la.register, db, emp, "pc-9", "x", "bm90LWEta2V5")


def test_改密码自动等填_没挂环境不填(ctx):
    db, boss, emp, admin2, token, env, env2 = ctx
    v = _item(db, boss, env)
    priv, pub = _key()
    la.register(db, emp, "pc-1", "前台", pub)
    la.decide_station(db, boss, token, "pc-1", True)
    got = _open(priv, la.poll(db, emp, "pc-1", ["kabc123"])[0])
    la.result(db, emp, "pc-1", v.id, got["ack"], True, True, None)
    db.commit()
    lv.save(db, boss, {"password": "DEMO_ONLY_REDACTED"}, v.id)
    db.commit()
    assert db.get(LedgerVault, v.id).ads_status == "pending"
    lv.save(db, boss, {"note": "只改备注"}, v.id)
    w = lv.save(db, boss, {"category": "other", "title": "没环境", "password": "DEMO_ONLY_REDACTED"})
    assert w.ads_status == "none"


def test_员工开店交的密码按店铺挂的环境自动去填(ctx):
    db, boss, emp, admin2, token, env, env2 = ctx
    lp = api.create_row("legal_person", api.RowIn(name="林一"), db=db, user=boss)["id"]
    ent = api.create_row("entity", api.RowIn(legal_person_id=lp, name="林一店", entity_type="company"), db=db, user=boss)["id"]
    ali = api.create_row("alipay", api.RowIn(entity_id=ent, account="a@x"), db=db, user=boss)["id"]
    db.commit()
    c = lo.dispatch(db, boss, {"kind": "shop", "platform": "xianyu", "alipay_id": ali, "assignee_id": "emp"})
    api.update_row("shop", c.target_id, api.RowIn(device_id=env), db=db, user=boss)
    db.commit()
    from tests.test_ledger_step5 import _walk

    _walk(db, c, "S06", emp, boss)
    lo.lock_in(db, emp, c.id, "S06", {"login_name": "tb_new", "password": "DEMO_ONLY_REDACTED"})
    db.commit()
    v = db.query(LedgerVault).filter(LedgerVault.target_id == c.target_id).one()
    assert v.device_id == env and v.ads_status == "pending"
    assert la.domain_of(db, v) == "goofish.com"
