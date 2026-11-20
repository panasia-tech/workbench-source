"""售出土账:chat_scan 会话 order_status 售出态 + 宝贝标题匹配 → 本账号在架账本标 SOLD。

直调 jobs._detect_sold_listings / 经 _on_chat_scan_ok 全链路各一条。
"""
from app import jobs
from app.models import Account, Device, DeviceStatus, Listing, ListingStatus, Task, TaskStatus


def _mk_account_with_listing(db, *, title="#0042 显示器 九成新", status=ListingStatus.LIVE):
    dev = Device(name="p1", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.flush()
    acc = Account(nick="店A", device_id=dev.id)
    db.add(acc)
    db.flush()
    lst = Listing(sku="SK1", account_id=acc.id, title=title, status=status)
    db.add(lst)
    db.commit()
    return acc, lst


def test_sold_status_marks_listing_sold(db):
    acc, lst = _mk_account_with_listing(db)
    jobs._detect_sold_listings(db, acc.id, [
        {"peer_key": "buyer1", "item_title": "#0042 显示器 九成新", "order_status": "等待你发货"},
    ])
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD
    assert db.get(Listing, lst.id).last_synced_at is not None


def test_unpaid_and_refund_statuses_ignored(db):
    acc, lst = _mk_account_with_listing(db)
    jobs._detect_sold_listings(db, acc.id, [
        {"peer_key": "b1", "item_title": "#0042 显示器 九成新", "order_status": "等待付款"},
        {"peer_key": "b2", "item_title": "#0042 显示器 九成新", "order_status": "退款中"},
        {"peer_key": "b3", "item_title": "#0042 显示器 九成新", "order_status": "已关闭"},
    ])
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.LIVE


def test_full_title_match_marks_sold(db):
    # 2026-08-31 起标题不再注入 #NNNN:整标题一致即定位本账号在架账本
    acc, lst = _mk_account_with_listing(db, title="显示器 九成新 自用便宜出")
    jobs._detect_sold_listings(db, acc.id, [
        {"peer_key": "b1", "item_title": "显示器 九成新 自用便宜出", "order_status": "交易成功"},
    ])
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD


def test_truncated_title_prefix_marks_sold(db):
    # 聊天顶栏标题截断(尾部 …):去省略号后前缀匹配仍命中
    acc, lst = _mk_account_with_listing(db, title="显示器 九成新 自用便宜出")
    jobs._detect_sold_listings(db, acc.id, [
        {"peer_key": "b1", "item_title": "显示器 九成新 自用…", "order_status": "待发货"},
    ])
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD


def test_ambiguous_title_skipped(db):
    # 同款多件在架且前缀都命中:歧义跳过,宁漏勿错
    acc, lst = _mk_account_with_listing(db, title="显示器 九成新 A 款")
    lst2 = Listing(sku="SK2", account_id=acc.id, title="显示器 九成新 B 款", status=ListingStatus.LIVE)
    db.add(lst2)
    db.commit()
    jobs._detect_sold_listings(db, acc.id, [
        {"peer_key": "b1", "item_title": "显示器 九成新", "order_status": "交易成功"},
    ])
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.LIVE
    assert db.get(Listing, lst2.id).status == ListingStatus.LIVE


def test_unrelated_title_ignored(db):
    # 标题对不上的会话不误标
    acc, lst = _mk_account_with_listing(db, title="显示器 九成新")
    jobs._detect_sold_listings(db, acc.id, [
        {"peer_key": "b1", "item_title": "键盘鼠标套装全新", "order_status": "交易成功"},
    ])
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.LIVE


def test_other_account_and_terminal_listings_untouched(db):
    acc, lst = _mk_account_with_listing(db)
    # 别人账号的账本:不标
    other_dev = Device(name="p2", status=DeviceStatus.ONLINE)
    db.add(other_dev)
    db.flush()
    other = Account(nick="店B", device_id=other_dev.id)
    db.add(other)
    db.flush()
    other_lst = Listing(sku="SK1", account_id=other.id, title="#0042 同款", status=ListingStatus.LIVE)
    # 已下架的:不复活
    delisted = Listing(sku="SK1", account_id=acc.id, title="#0042 旧的", status=ListingStatus.DELISTED)
    db.add_all([other_lst, delisted])
    db.commit()

    jobs._detect_sold_listings(db, acc.id, [
        {"peer_key": "b1", "item_title": "#0042 显示器 九成新", "order_status": "待发货"},
    ])
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD
    assert db.get(Listing, other_lst.id).status == ListingStatus.LIVE
    assert db.get(Listing, delisted.id).status == ListingStatus.DELISTED


def test_idempotent_second_scan(db):
    acc, lst = _mk_account_with_listing(db)
    conv = [{"peer_key": "b1", "item_title": "#0042 显示器 九成新", "order_status": "交易成功"}]
    jobs._detect_sold_listings(db, acc.id, conv)
    jobs._detect_sold_listings(db, acc.id, conv)   # 老会话反复扫到不炸不重复
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD


def test_via_chat_scan_ok_full_path(db, monkeypatch):
    monkeypatch.setattr(jobs, "maybe_notify_new_messages",
                        lambda db_, n, details=None: None)
    acc, lst = _mk_account_with_listing(db)
    task = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS,
                device_id=acc.device_id, spec={},
                result={"conversations": [
                    {"peer_key": "buyer9", "item_title": "#0042 显示器 九成新",
                     "order_status": "等待你发货", "last_message": "好的", "unread": 1},
                ], "messages": {"buyer9": []}})
    db.add(task)
    db.commit()

    jobs._on_chat_scan_ok(db, task)
    db.flush()
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD
