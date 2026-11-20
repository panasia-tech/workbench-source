"""上架图看起来像不像（E03，2026-11-10）。

钉死的口径：
  1. 灰度 dHash：OSS 缩成 9×8 的 BMP（或 PNG）取回来纯 Python 读，64 位，按 OSS key 缓存。
  2. 首图距离 ≤10 算看起来一样；整组一对一配上「看起来一样」的超过小的那组一半算整组相同；
     按店铺发布时任意一张 ≤4 算同一张。改文件名不算不同。
  3. 取不到图：提交审批放过（后面有人批）；批准、发布要人对照确认一次（10 分钟内再点一次），都留记录。
  4. 同一件货的提交、批准排队做，后提交的看得见先提交的（锁 + 不吃会话里的旧数据）。
"""
import struct
import zlib
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

import app.services.shop_images as SI
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.models import EventLog, ImageDhash, SaleShop, Sku, SkuListingInfo, SkuShopListing, Staff, WarehouseSpu
from app.models import SpuImageSearch
from app.routers import listing_approval as R
from app.services import image_similarity as IS
from app.services import listing_approval as la

MASK = (1 << 64) - 1
REAL_ENABLED = IS.enabled  # conftest 默认把它关了，这里拿原来的测开关
A = 0x0F0F_0F0F_0F0F_0F0F
B = 0x3333_5555_3333_5555
C = 0x00FF_00FF_00FF_00FF
X = 0x1234_5678_9ABC_DEF0  # 跟上面几张都差得远


def near(h, bits=3):
    return h ^ ((1 << bits) - 1)


# ---------------------------------------------------------------- 造位图

def bmp24(grid, top_down=False):
    h, w = len(grid), len(grid[0])
    stride = (24 * w + 31) // 32 * 4
    rows = grid if top_down else grid[::-1]
    pixels = b"".join(bytes(v for g in row for v in (g, g, g)) + b"\0" * (stride - 3 * w) for row in rows)
    info = struct.pack("<IiiHHIIiiII", 40, w, -h if top_down else h, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    head = b"BM" + struct.pack("<IHHI", 14 + 40 + len(pixels), 0, 0, 54)
    return head + info + pixels


def bmp32_bitfields(grid):
    h, w = len(grid), len(grid[0])
    pixels = b"".join(struct.pack("<I", (g << 16) | (g << 8) | g | 0xFF000000) for row in grid[::-1] for g in row)
    info = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 32, 3, len(pixels), 0, 0, 0, 0)
    masks = struct.pack("<III", 0xFF0000, 0x00FF00, 0x0000FF)
    head = b"BM" + struct.pack("<IHHI", 14 + 40 + 12 + len(pixels), 0, 0, 66)
    return head + info + masks + pixels


def bmp8(grid):
    h, w = len(grid), len(grid[0])
    stride = (8 * w + 31) // 32 * 4
    palette = b"".join(bytes((i, i, i, 0)) for i in range(256))
    pixels = b"".join(bytes(row) + b"\0" * (stride - w) for row in grid[::-1])
    info = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 8, 0, len(pixels), 0, 0, 256, 0)
    off = 14 + 40 + len(palette)
    return b"BM" + struct.pack("<IHHI", off + len(pixels), 0, 0, off) + info + palette + pixels


def png_rgb(grid, filt=1):
    h, w = len(grid), len(grid[0])
    raw = b""
    prev = bytes(3 * w)
    for row in grid:
        line = bytes(v for g in row for v in (g, g, g))
        if filt == 1:  # Sub
            enc = bytes((line[i] - (line[i - 3] if i >= 3 else 0)) & 255 for i in range(len(line)))
        elif filt == 2:  # Up
            enc = bytes((line[i] - prev[i]) & 255 for i in range(len(line)))
        else:
            enc = line
        raw += bytes([filt]) + enc
        prev = line

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


GRID = [[(x * 29 + y * 13) % 256 for x in range(9)] for y in range(8)]


def test_bmp_and_png_decode_to_same_gray():
    assert IS.decode_bmp(bmp24(GRID)) == GRID
    assert IS.decode_bmp(bmp24(GRID, top_down=True)) == GRID
    assert IS.decode_bmp(bmp32_bitfields(GRID)) == GRID
    assert IS.decode_bmp(bmp8(GRID)) == GRID
    assert IS.decode_png(png_rgb(GRID, filt=1)) == GRID
    assert IS.decode_png(png_rgb(GRID, filt=2)) == GRID
    h = IS.dhash_image(bmp24(GRID))
    assert h == IS.dhash_image(png_rgb(GRID)) == IS.dhash_image(bmp8(GRID))


def test_dhash_bits_and_distance():
    left_bright = [[250 - 25 * x for x in range(9)] for _ in range(8)]
    right_bright = [row[::-1] for row in left_bright]
    assert IS.dhash_rows(left_bright) == MASK
    assert IS.dhash_rows(right_bright) == 0
    assert IS.distance(MASK, 0) == 64 and IS.distance(A, near(A)) == 3
    # 大一倍的同一张图缩下来是同一个哈希（OSS 没按 9×8 给也能算）
    big = [[GRID[y // 2][x // 2] for x in range(18)] for y in range(16)]
    assert IS.dhash_rows(big) == IS.dhash_rows(GRID)
    # 整体调亮一点不影响
    brighter = [[min(255, g + 10) for g in row] for row in GRID]
    assert IS.distance(IS.dhash_rows(brighter), IS.dhash_rows(GRID)) <= 4


def test_bad_bytes_are_not_images():
    for data in (b"", b"GIF89a....", b"BM" + b"\0" * 10):
        with pytest.raises(Exception):
            IS.dhash_image(data)


# ---------------------------------------------------------------- 比两组图

def _known(**kv):
    return {f"oss/{k}.jpg": v for k, v in kv.items()}


def _u(*names):
    return [f"oss/{n}.jpg" for n in names]


def test_compare_pair_rules():
    known = _known(a=A, a2=near(A), b=B, b2=near(B, 2), c=C, c2=near(C, 4), x=X, y=X ^ MASK)
    ref = IS._refs
    # 首图看起来一样（改了名）
    assert IS.compare_pair(ref(_u("a", "b")), ref(_u("a2", "c")), known, same_picture=False)[0] == "first"
    # 首图不一样，但 3 张里 2 张看起来一样：整组大半相同
    assert IS.compare_pair(ref(_u("a", "b", "c")), ref(_u("x", "b2", "c2")), known, same_picture=False)[0] == "group"
    # 4 张里只有 2 张：刚好一半，不算
    assert IS.compare_pair(ref(_u("x", "b", "c", "y")), ref(_u("a", "b2", "c2", "a2")), known,
                           same_picture=False) == (None, False)
    four = IS.compare_pair(ref(_u("a", "b", "c", "x")), ref(_u("y", "b2", "c2")), known, same_picture=False)
    assert four[0] == "group"  # 小的那组 3 张配上 2 张
    # 只有 1 张的组，这张在别的号里：整组都重复
    assert IS.compare_pair(ref(_u("b")), ref(_u("x", "b2")), known, same_picture=False)[0] == "group"
    # 按店铺发布：任意一张是同一张就不行
    assert IS.compare_pair(ref(_u("x", "b")), ref(_u("y", "c", "b2", "a")), known, same_picture=True)[0] == "same"
    # 不像
    assert IS.compare_pair(ref(_u("a", "b")), ref(_u("x", "c")), known, same_picture=True) == (None, False)


def test_compare_pair_same_key_counts_even_without_hash_and_unknown_is_reported():
    known = {"oss/a.jpg": None, "oss/b.jpg": None}
    assert IS.compare_pair(["oss/a.jpg"], ["oss/a.jpg"], known, same_picture=False)[0] == "first"
    assert IS.compare_pair(["oss/a.jpg"], ["oss/b.jpg"], known, same_picture=False) == (None, True)


def test_compare_names_the_other_shop_and_checks_mine_between_themselves():
    known = _known(a=A, a2=near(A), x=X)
    v = IS.compare([(None, _u("a"))], [("店2", _u("a2"))], same_picture=False, known=known)
    assert v.clash == "首图和「店2」的首图看起来一样，每个号的首图要不同"
    v = IS.compare([("店1", _u("a")), ("店3", _u("a2"))], [("店2", _u("x"))], same_picture=True, known=known)
    assert v.clash.startswith("店铺「店1」首图和「店3」")


# ---------------------------------------------------------------- 取哈希、缓存

@pytest.fixture()
def hashing(monkeypatch):
    table: dict[str, int] = {}
    fetched: list[list[str]] = []

    def fetch_many(refs):
        fetched.append(list(refs))
        return {r: table[r] for r in refs if r in table}

    monkeypatch.setattr(IS, "enabled", lambda db: True)
    monkeypatch.setattr(IS, "_fetch_many", fetch_many)
    return SimpleNamespace(table=table, fetched=fetched)


def test_hashes_are_cached_by_object_key(db_session, hashing):
    hashing.table.update({"oss/a.jpg": A})
    got = IS.hashes(db_session, ["oss/a.jpg", "oss/gone.jpg"])
    assert got == {"oss/a.jpg": A, "oss/gone.jpg": None}
    assert db_session.query(ImageDhash).one().dhash == f"{A:016x}"
    # 第二次 a 走缓存，取不到的那张再取一次
    IS.hashes(db_session, ["oss/a.jpg", "oss/gone.jpg"])
    assert hashing.fetched == [["oss/a.jpg", "oss/gone.jpg"], ["oss/gone.jpg"]]


def test_image_ref_ignores_signature_and_videos():
    signed = "https://bkt.oss-cn-hangzhou.aliyuncs.com/listing/a%2Fb.jpg?OSSAccessKeyId=k&Expires=1&Signature=s"
    assert IS.image_ref(signed) == IS.image_ref("https://bkt.oss-cn-hangzhou.aliyuncs.com/listing/a/b.jpg")
    assert IS.image_ref("oss/v.mp4") is None


def test_download_failure_is_unknown(monkeypatch):
    def boom(url, timeout):
        raise TimeoutError

    monkeypatch.setattr(IS.httpx, "get", boom)
    assert IS._download_dhash("https://x/y.jpg") is None
    monkeypatch.setattr(IS.httpx, "get", lambda url, timeout: SimpleNamespace(status_code=200, content=bmp24(GRID)))
    assert IS._download_dhash("https://x/y.jpg") == IS.dhash_rows(GRID)


def test_switch_off_skips_everything(db_session, monkeypatch):
    from app.services.app_settings import set_setting

    monkeypatch.setattr(IS.settings, "oss_bucket", "b")
    monkeypatch.setattr(IS.settings, "oss_access_key_id", "k")
    monkeypatch.setattr(IS.settings, "oss_access_key_secret", "s")
    assert REAL_ENABLED(db_session)
    set_setting(db_session, IS.OFF_KEY, "1", None)
    assert not REAL_ENABLED(db_session)
    monkeypatch.setattr(IS.settings, "oss_bucket", "")
    set_setting(db_session, IS.OFF_KEY, "", None)
    assert not REAL_ENABLED(db_session)


# ---------------------------------------------------------------- 上架审批

def _staff(db, name, role):
    row = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def w(db_session, monkeypatch):
    db = db_session
    monkeypatch.setattr(R, "sign_oss_url", lambda u, expires=86400: u)
    monkeypatch.setattr(la, "market_of", lambda db, sku: {"price": None, "basis": None, "date": None, "query": "x"})
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1000"), status=SkuStatus.IN_STOCK, images=_u("a", "b", "c"))
    shops = [SaleShop(code=f"s{i}", label=f"店{i}", xianyu_user_name=f"号{i}", enabled=True, sort_order=i,
                      gc_account_id=f"acc{i}") for i in (1, 2, 3)]
    db.add_all([sku, *shops])
    db.flush()
    clerk = _staff(db, "员工", StaffRole.SALES)
    boss = _staff(db, "老板", StaffRole.ADMIN)
    db.commit()
    return SimpleNamespace(db=db, sku=sku, s1=shops[0], s2=shops[1], s3=shops[2], clerk=clerk, boss=boss)


def _draft(w, shop, images, db=None):
    R.save_draft("SK1", shop.id, R.DraftIn(price=Decimal("1200"), images=images), db or w.db, w.clerk)


def _submit(w, shop, db=None):
    R.submit("SK1", R.ShopIdsIn(shop_ids=[shop.id]), db or w.db, w.clerk)


def _approve(w, shop):
    R.review("SK1", R.ReviewIn(shop_ids=[shop.id], approve=True), w.db, w.boss)


def test_submit_blocks_renamed_first_image(w, hashing):
    hashing.table.update(_known(a=A, b=B, c=C, a2=near(A), x=X))
    _draft(w, w.s1, _u("a", "b"))
    _submit(w, w.s1)
    _draft(w, w.s2, _u("a2", "c"))
    with pytest.raises(HTTPException) as exc:
        _submit(w, w.s2)
    assert exc.value.detail == "「店2」：首图和「店1」的首图看起来一样，每个号的首图要不同"
    _draft(w, w.s2, _u("x", "c"))
    _submit(w, w.s2)
    assert la.current(w.db, w.sku.id, w.s2.id).status == "SUBMITTED"


def test_submit_blocks_group_mostly_the_same(w, hashing):
    # b2、c2 和 b、c 看起来像（距离 6、7），但还不到「同一张」（≤4）
    hashing.table.update(_known(a=A, b=B, c=C, x=X, b2=near(B, 6), c2=near(C, 7)))
    _draft(w, w.s1, _u("a", "b", "c"))
    _submit(w, w.s1)
    _draft(w, w.s2, _u("x", "b2", "c2"))
    with pytest.raises(HTTPException) as exc:
        _submit(w, w.s2)
    assert "整组图大半和「店1」的看起来一样" in exc.value.detail


def test_submit_blocks_renamed_copy_of_any_image(w, hashing):
    """各号的图一张都不能重复：不是首图、换了文件名的同一张也拦，说清第几张、和哪个号。"""
    hashing.table.update(_known(a=A, b=B, x=X, b2=near(B, 2)))
    _draft(w, w.s1, _u("a", "b"))
    _submit(w, w.s1)
    _draft(w, w.s2, _u("x", "b2"))
    with pytest.raises(HTTPException) as exc:
        _submit(w, w.s2)
    assert exc.value.detail == ("「店2」：第 2 张图和「店1」用的是同一张（改文件名、重新上传也算），"
                                "每个号的图不能重复")


def test_live_listing_with_its_own_images_counts(w, hashing):
    hashing.table.update(_known(a=A, a2=near(A), x=X))
    w.db.add(SkuShopListing(sku_id=w.sku.id, sale_shop_id=w.s3.id, publish_status=ShopListingStatus.LISTED,
                            images=_u("a")))
    w.db.commit()
    _draft(w, w.s1, _u("a2"))
    with pytest.raises(HTTPException) as exc:
        _submit(w, w.s1)
    assert "「店3」" in exc.value.detail


def test_unknown_passes_submit_but_approval_needs_a_second_click(w, hashing):
    hashing.table.update(_known(a=A))  # b 取不到
    _draft(w, w.s1, _u("a"))
    _submit(w, w.s1)
    _approve(w, w.s1)
    _draft(w, w.s2, _u("b"))
    _submit(w, w.s2)  # 判不了，提交放过
    assert la.current(w.db, w.sku.id, w.s2.id).status == "SUBMITTED"
    with pytest.raises(HTTPException) as exc:
        _approve(w, w.s2)
    assert exc.value.detail == ("「店2」：有 1 张图取不到，没法自动比对是不是和「店1」的重复。"
                                "请对照看一眼，确认不重复再点一次通过")
    assert la.current(w.db, w.sku.id, w.s2.id).status == "SUBMITTED"
    assert w.db.query(EventLog).filter(EventLog.event_type == IS.WARN_EVENT).count() == 1
    _approve(w, w.s2)  # 看过了，再点一次
    assert la.current(w.db, w.sku.id, w.s2.id).status == "APPROVED"
    assert w.db.query(EventLog).filter(EventLog.event_type == IS.CONFIRM_EVENT).one().operator_id == w.boss.id


def test_approval_rechecks_similarity(w, hashing):
    hashing.table.update(_known(a=A, x=X))
    _draft(w, w.s1, _u("a"))
    _submit(w, w.s1)
    _draft(w, w.s2, _u("x"))
    _submit(w, w.s2)
    # 提交之后才知道 x 和 a 是同一张（比如之前取不到）
    w.db.query(ImageDhash).filter(ImageDhash.object_key == "oss/x.jpg").update({"dhash": f"{near(A):016x}"})
    w.db.commit()
    with pytest.raises(HTTPException) as exc:
        _approve(w, w.s2)
    assert "看起来一样" in exc.value.detail


def test_submit_and_approve_lock_the_sku(w, hashing, monkeypatch):
    locked = []
    real = la._lock_sku
    monkeypatch.setattr(la, "_lock_sku", lambda db, sku_id: (locked.append(sku_id), real(db, sku_id)))
    hashing.table.update(_known(a=A))
    _draft(w, w.s1, _u("a"))
    _submit(w, w.s1)
    _approve(w, w.s1)
    assert locked == [w.sku.id, w.sku.id]


def test_lock_is_select_for_update_on_mysql(w):
    from sqlalchemy.dialects import mysql

    q = w.db.query(Sku.id).filter(Sku.id == "x").with_for_update()
    assert "FOR UPDATE" in str(q.statement.compile(dialect=mysql.dialect()))


def test_second_person_sees_first_persons_fresh_submission(w, hashing):
    """两个人同时清洗：B 的会话里还是 A 提交前的样子，A 先提交了，B 再提交要看得到 A 的、被拦下。"""
    hashing.table.update(_known(a=A, a2=near(A)))
    other = Session(bind=w.db.get_bind())
    _draft(w, w.s1, _u("a"))
    _draft(w, w.s2, _u("a2"))
    seen = la.current_by_shop(other, w.sku.id)  # B 打开页面时，店1 还是草稿（留着引用，会话里一直是这份）
    _submit(w, w.s1)  # A 先提交并落库
    assert seen[w.s1.id].status == "DRAFT"
    with pytest.raises(HTTPException) as exc:
        _submit(w, w.s2, db=other)
    assert "「店1」" in exc.value.detail
    other.close()


# ---------------------------------------------------------------- 按店铺选图发布

@pytest.fixture()
def pub(db_session, monkeypatch):
    db = db_session
    pool = [{"url": "https://oss.example.com/spu-ref/9/pool/p1.jpg", "source_url": "s1"}]
    spu = WarehouseSpu(spu_code="9", brand="AOC", model="24G2Z", enabled=True)
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1000"), status=SkuStatus.IN_STOCK, images=_u("a", "b"))
    s1 = SaleShop(code="s1", label="店1", xianyu_user_name="甲", enabled=True, sort_order=0, gc_account_id="acc1")
    s2 = SaleShop(code="s2", label="店2", xianyu_user_name="乙", enabled=True, sort_order=1, gc_account_id="acc2")
    db.add_all([spu, sku, s1, s2])
    db.flush()
    db.add(SkuListingInfo(sku_id=sku.id, images=_u("a", "b"), status=ListingInfoStatus.READY))
    db.add(SpuImageSearch(spu_id=spu.id, query="AOC 24G2Z", status=SpuImageSearch.READY, pool_images=pool))
    db.commit()
    monkeypatch.setattr(SI, "resolve_spu", lambda db, sku: SimpleNamespace(matched=True, spu=spu))
    monkeypatch.setattr(SI, "sign_oss_thumb_url", lambda u, **kw: f"thumb:{u}")
    return SimpleNamespace(db=db, sku=sku, s1=s1, s2=s2, pool_url=pool[0]["url"])


def test_publish_blocks_crawler_copy_of_own_photo(pub, hashing):
    hashing.table.update({"oss/a.jpg": A, "oss/b.jpg": B, "spu-ref/9/pool/p1.jpg": near(A, 2)})
    with pytest.raises(ValueError) as exc:
        SI.validate(pub.db, pub.sku, {pub.s1.id: _u("a"), pub.s2.id: [pub.pool_url]}, [pub.s1.id, pub.s2.id])
    assert str(exc.value).startswith("店铺「店1」首图和「店2」")
    out = SI.validate(pub.db, pub.sku, {pub.s1.id: _u("a"), pub.s2.id: _u("b")}, [pub.s1.id, pub.s2.id])
    assert out == {pub.s1.id: _u("a"), pub.s2.id: _u("b")}


def test_publish_unknown_needs_a_second_click(pub, hashing):
    hashing.table.update({"oss/a.jpg": A})
    picks = {pub.s1.id: _u("a"), pub.s2.id: _u("b")}
    with pytest.raises(ValueError) as exc:
        SI.validate(pub.db, pub.sku, picks, [pub.s1.id, pub.s2.id])
    assert "再点一次发布" in str(exc.value)
    assert SI.validate(pub.db, pub.sku, picks, [pub.s1.id, pub.s2.id]) == picks
    # 换了图就是另一回事，要重新确认
    hashing.table.pop("oss/a.jpg")
    pub.db.query(ImageDhash).delete()
    pub.db.commit()
    with pytest.raises(ValueError):
        SI.validate(pub.db, pub.sku, {pub.s1.id: _u("b"), pub.s2.id: _u("a")}, [pub.s1.id, pub.s2.id])
