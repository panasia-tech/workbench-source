import pytest

from app import library
from app.config import get_settings


@pytest.fixture
def items(db, storage, video):
    def add(item_id, title, series, sort, **kw):
        library.create_item(db, item_id, title, series=series, sort=sort, **kw)
        v = library.add_version(db, storage, item_id, video)
        library.publish(db, item_id, v.version_no)

    add("wh-basic-02", "第2课", "仓库通用基础课", 2, audience="roles", roles="WAREHOUSE,仓管")
    add("wh-basic-01", "第1课", "仓库通用基础课", 1, audience="roles", roles="WAREHOUSE,仓管")
    add("wb-guide-01", "第1集", "工作台业务教程", 1, audience="staff")
    add("partner-only", "合作方资料", "外部", 1, audience="external")
    library.create_item(db, "wb-guide-02", "还没传", series="工作台业务教程", sort=2)


def _get(client, groups="", token="cat-token"):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.get("/api/catalog", params={"groups": groups}, headers=headers)


def _names(body):
    return {s["name"]: [i["id"] for i in s["items"]] for s in body["series"]}


def test_catalog_off_without_token_setting(client, items):
    assert _get(client).status_code == 404


def test_catalog_filters_by_groups(client, items, monkeypatch):
    monkeypatch.setenv("MEDIA_CATALOG_TOKEN", "cat-token")
    monkeypatch.setenv("MEDIA_ADMIN_ROLES", "ADMIN,ERP管理员")
    get_settings.cache_clear()
    assert _get(client, token="").status_code == 401
    assert _get(client, token="wrong").status_code == 401

    assert _names(_get(client, "销售").json()) == {"工作台业务教程": ["wb-guide-01"]}
    wh = _get(client, "仓管").json()
    assert _names(wh) == {"仓库通用基础课": ["wh-basic-01", "wh-basic-02"], "工作台业务教程": ["wb-guide-01"]}
    assert wh["series"][0]["items"][0]["url"] == "http://testserver/m/wh-basic-01"
    admin = _names(_get(client, "erp管理员").json())
    assert "partner-only" not in sum(admin.values(), []) and admin["仓库通用基础课"] == ["wh-basic-01", "wh-basic-02"]
