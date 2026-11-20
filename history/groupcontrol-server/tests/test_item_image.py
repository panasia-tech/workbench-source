"""聊天页商品卡缩略图:会话标题唯一命中在架 listing → job.spec.images[0] → row.item_image(or-keep)。

直调 jobs._resolve_item_images / 经 _on_chat_scan_ok 全链路各一条。
"""
from app import jobs
from app.models import (
    Account, Conversation, Device, DeviceStatus, Job, JobType,
    Listing, ListingStatus, Task, TaskStatus,
)

IMG1 = "https://oss.example.com/sku/product/a.jpg"
IMG2 = "https://oss.example.com/sku/product/b.jpg"


def _mk(db, *, title="显示器 九成新 自用便宜出", spec=None, status=ListingStatus.LIVE):
    dev = Device(name="p1", status=DeviceStatus.ONLINE)
    db.add(dev)
    db.flush()
    acc = Account(nick="店A", device_id=dev.id)
    db.add(acc)
    db.flush()
    job = Job(job_type=JobType.PUBLISH_BATCH,
              spec=spec if spec is not None else {"images": [IMG1, IMG2]})
    db.add(job)
    db.flush()
    lst = Listing(sku="SK1", account_id=acc.id, title=title, status=status, job_id=job.id)
    db.add(lst)
    db.commit()
    return acc, lst


def _conv(db, acc, title, pk="b1"):
    c = Conversation(account_id=acc.id, peer_key=pk, item_title=title)
    db.add(c)
    db.commit()
    return c


def test_unique_match_sets_item_image(db):
    acc, _ = _mk(db)
    c = _conv(db, acc, "显示器 九成新 自用便…")   # 顶栏截断形也命中(去省略号互判前缀)
    jobs._resolve_item_images(db, acc.id, [{"peer_key": "b1", "item_title": c.item_title}])
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image == IMG1   # 只取 images[0]


def test_no_live_listing_leaves_none(db):
    acc, lst = _mk(db)
    lst.status = ListingStatus.SOLD     # 不在 LIVE/UNCERTAIN 集合
    db.commit()
    c = _conv(db, acc, "显示器 九成新 自用便宜出")
    jobs._resolve_item_images(db, acc.id, [{"peer_key": "b1", "item_title": c.item_title}])
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image is None


def test_ambiguous_match_skips(db):
    acc, _ = _mk(db)
    dup = Listing(sku="SK2", account_id=acc.id,
                  title="显示器 九成新 自用便宜出", status=ListingStatus.LIVE)
    db.add(dup)
    db.commit()
    c = _conv(db, acc, "显示器 九成新 自用便宜出")
    jobs._resolve_item_images(db, acc.id, [{"peer_key": "b1", "item_title": c.item_title}])
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image is None


def test_spec_without_images_skips(db):
    acc, _ = _mk(db, spec={"price": 100})   # 无 images 键
    c = _conv(db, acc, "显示器 九成新 自用便宜出")
    jobs._resolve_item_images(db, acc.id, [{"peer_key": "b1", "item_title": c.item_title}])
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image is None


def test_or_keep_does_not_overwrite_or_clear(db):
    acc, _ = _mk(db)
    c = _conv(db, acc, "显示器 九成新 自用便宜出")
    jobs._resolve_item_images(db, acc.id, [{"peer_key": "b1", "item_title": c.item_title}])
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image == IMG1
    # 再扫:标题解析不到了(None)→ 不清空;歧义(加了同款)→ 不覆盖
    dup = Listing(sku="SK2", account_id=acc.id,
                  title="显示器 九成新 自用便宜出", status=ListingStatus.LIVE)
    db.add(dup)
    db.commit()
    jobs._resolve_item_images(db, acc.id,
                              [{"peer_key": "b1", "item_title": None},
                               {"peer_key": "b1", "item_title": "显示器 九成新 自用便宜出"}])
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image == IMG1


def test_short_code_match(db):
    acc, _ = _mk(db, title="#0042 显示器 九成新")
    c = _conv(db, acc, "#0042 显示器 九成新")
    jobs._resolve_item_images(db, acc.id, [{"peer_key": "b1", "item_title": c.item_title}])
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image == IMG1


def test_via_chat_scan_ok_full_path(db, monkeypatch):
    monkeypatch.setattr(jobs, "maybe_notify_new_messages",
                        lambda db_, n, details=None: None)
    acc, _ = _mk(db)
    task = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS,
                result={"conversations": [
                    {"peer_key": "buyer1", "peer_nick": "买家甲",
                     "item_title": "显示器 九成新 自用便宜出", "order_status": None}],
                    "messages": {"buyer1": [{"direction": "in", "text": "在吗", "msg_at": None}]}})
    db.add(task)
    db.commit()
    jobs._on_chat_scan_ok(db, task)
    db.flush()
    db.expire_all()
    c = db.query(Conversation).filter_by(account_id=acc.id, peer_key="buyer1").one()
    assert c.item_image == IMG1


def test_direct_image_wins_over_title_guess(db, monkeypatch):
    """聊天页 img src 直取优先于标题反猜:会话带 item_image 时,即便标题唯一命中在架
    listing,_resolve_item_images 也不许覆盖(同款多件在架时反猜结果本就是错的)。"""
    monkeypatch.setattr(jobs, "maybe_notify_new_messages",
                        lambda db_, n, details=None: None)
    acc, _ = _mk(db)
    direct = "https://img.alicdn.com/direct-from-card.jpg"
    task = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS,
                result={"conversations": [
                    {"peer_key": "buyer1", "peer_nick": "买家甲",
                     "item_title": "显示器 九成新 自用便宜出",
                     "item_image": direct, "order_status": None}],
                    "messages": {"buyer1": [{"direction": "in", "text": "在吗", "msg_at": None}]}})
    db.add(task)
    db.commit()
    jobs._on_chat_scan_ok(db, task)
    db.flush()
    db.expire_all()
    c = db.query(Conversation).filter_by(account_id=acc.id, peer_key="buyer1").one()
    assert c.item_image == direct, "直取的卡图必须原样入库,不能被标题反猜(IMG1)覆盖"


def test_direct_image_or_keep_and_fallback_still_works(db, monkeypatch):
    """or-keep 语义不变:直取这轮没解析到图(item_image 缺省/None)时,标题反猜照常被底;
    已有直取图的会话下一轮没图也不丢。"""
    monkeypatch.setattr(jobs, "maybe_notify_new_messages",
                        lambda db_, n, details=None: None)
    acc, _ = _mk(db)
    # 第一轮:无 item_image → 反猜兜底写入 IMG1
    task = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS,
                result={"conversations": [
                    {"peer_key": "buyer1", "peer_nick": "买家甲",
                     "item_title": "显示器 九成新 自用便宜出", "order_status": None}],
                    "messages": {}})
    db.add(task)
    db.commit()
    jobs._on_chat_scan_ok(db, task)
    db.flush()
    db.expire_all()
    c = db.query(Conversation).filter_by(account_id=acc.id, peer_key="buyer1").one()
    assert c.item_image == IMG1
    # 第二轮:直取到了卡图 → 覆盖反猜值
    task2 = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS,
                 result={"conversations": [
                     {"peer_key": "buyer1", "peer_nick": "买家甲",
                      "item_title": "显示器 九成新 自用便宜出",
                      "item_image": "https://img.alicdn.com/direct.jpg", "order_status": None}],
                     "messages": {}})
    db.add(task2)
    db.commit()
    jobs._on_chat_scan_ok(db, task2)
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image == "https://img.alicdn.com/direct.jpg"
    # 第三轮:又没图 → or-keep 不清空
    task3 = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS,
                 result={"conversations": [
                     {"peer_key": "buyer1", "peer_nick": "买家甲",
                      "item_title": "显示器 九成新 自用便宜出", "order_status": None}],
                     "messages": {}})
    db.add(task3)
    db.commit()
    jobs._on_chat_scan_ok(db, task3)
    db.flush()
    db.expire_all()
    assert db.get(Conversation, c.id).item_image == "https://img.alicdn.com/direct.jpg"
