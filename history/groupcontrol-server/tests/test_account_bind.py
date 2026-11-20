"""账号 upsert-by-nick(= 设备号↔闲鱼账号名 映射表):同名只更新设备号,不新增。

直接调 endpoint 函数(仓库风格,不经 TestClient/httpx)。
"""
import pytest
from fastapi import HTTPException

from app import api
from app.schemas import AccountBind, DeviceCreate


def _device(db, name="phone-1"):
    return api.create_device(DeviceCreate(name=name), db).id


def test_bind_creates_then_updates_device_by_nick(db_session):
    d1 = _device(db_session, "phone-1")
    d2 = _device(db_session, "phone-2")

    acc = api.bind_account(AccountBind(nick="闲鱼小铺A", device_id=d1), db_session)
    assert acc.device_id == d1
    acc_id = acc.id

    # 同名再 bind:同一账号,只换设备号(不新增)
    acc2 = api.bind_account(AccountBind(nick="闲鱼小铺A", device_id=d2), db_session)
    assert acc2.id == acc_id
    assert acc2.device_id == d2

    # 全表只有一个「闲鱼小铺A」
    got = api.list_accounts(nick="闲鱼小铺A", db=db_session)
    assert len(got) == 1
    assert got[0].id == acc_id and got[0].device_id == d2


def test_bind_rejects_unknown_device(db_session):
    with pytest.raises(HTTPException) as e:
        api.bind_account(AccountBind(nick="闲鱼小铺B", device_id="nope"), db_session)
    assert e.value.status_code == 404


def test_list_accounts_filter_by_nick(db_session):
    api.bind_account(AccountBind(nick="A"), db_session)
    api.bind_account(AccountBind(nick="B"), db_session)
    assert len(api.list_accounts(nick="A", db=db_session)) == 1
    assert len(api.list_accounts(nick=None, db=db_session)) == 2
