"""各号上架图看起来像不像（E03，2026-11-10）。

以前只挡得住「同一个文件」：换个文件名、重新上传、轻微裁剪的同一张图挡不住。现在按图的长相比：
  - 每个号的首图要和别的号的首图看起来不同；
  - 整组图不能和别的号大面积相同；
  - 按店铺选图发布时，任意一张图和别的号的看起来是同一张也不行（那边本来就不许同一个文件给两个号）。
改文件名不算不同。

怎么比：灰度 dHash。让 OSS 把图缩成 9×8 的 BMP 取回来（生产环境没有 Pillow / numpy，不加依赖），
纯 Python 读像素、转灰度，每行相邻两点比明暗得 8 位，8 行 64 位。两张图的距离 = 64 位里不一样的位数。
算出来的按 OSS 对象 key 存进 image_dhash 表，同一张图只取一次。

取不到图（OSS 超时、停了、不是图床的图）就是「判不了」，不当成不像，也不直接拦：
  - 提交上架审批时判不了先放过去，后面还有管理员批；
  - 管理员批准、员工按店铺选图发布时判不了，先提示「对照看一眼」，10 分钟内同样的内容再点一次才放过，
    提示和放过都记在 event_log（image_check_unknown / image_check_confirmed）。
关掉整个判重：app_setting image_similarity_off = 1（OSS 处理出问题挡住大家时用）。
"""
from __future__ import annotations

import hashlib
import struct
import zlib
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import httpx
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import EventLog, ImageDhash
from app.services.app_settings import get_setting
from app.services.oss_media import is_oss_url_unavailable, is_video_url, public_url_to_object_key, strip_oss_signature

OFF_KEY = "image_similarity_off"

# m_fixed 强制缩成 9×8（不管原图比例），format,bmp 出未压缩位图，纯 Python 好读。
# 不加 auto-orient：原图宽高 ≥4096 时 OSS 会 400（10-27 实测，见 oss_media.OSS_PUBLISH_IMG_PROCESS）。
DHASH_PROCESS = "image/resize,m_fixed,w_9,h_8/format,bmp"

# 阈值（64 位里不一样的位数）怎么定的：
#   - 同一张图改名、重传、重新压缩、缩放：0~2；轻微裁剪（几个百分点）、调亮度：一般 2~6；
#   - 两张不相干的图平均差 32 位左右；同一件货换个角度、换个背景重拍，一般 12 位以上。
#   - dHash 的常用经验：≤10 基本是同一张图的变体（Neal Krawetz「Kind of Like That」）。
# 首图、整组配对用 10：宁可把「几乎一样的重拍」也拦下（闲鱼看首图判重复，正是要避开的）。
# 「同一张图」用 4：只抓改名 / 重传 / 轻微裁剪；它是逐张卡的，放宽了会把同一件货的不同照片也误拦。
LOOK_ALIKE_MAX = 10
SAME_PICTURE_MAX = 4
# 整组相似：两组一对一配上的「看起来一样」的图，超过小的那组一半（只有 1 张的组，这 1 张配上了就算）。
# 拿小的那组算：我 3 张有 2 张在你 9 张里，我这组就大半是重复的。

FETCH_TIMEOUT = 3.0   # 单张取图
FETCH_BUDGET = 8.0    # 一次判重最多等这么久，剩下没取到的算判不了（按店铺发布是在异步流程里同步跑的，不能久等）
FETCH_WORKERS = 8
CONFIRM_WINDOW = timedelta(minutes=10)

WARN_EVENT = "image_check_unknown"
CONFIRM_EVENT = "image_check_confirmed"


# ---------------------------------------------------------------- 读位图、算 dHash

def _gray(r: int, g: int, b: int) -> int:
    return (299 * r + 587 * g + 114 * b) // 1000


def decode_bmp(data: bytes) -> list[list[int]]:
    """BMP → 灰度像素（自上而下的行）。支持 8 位调色板、24 位、32 位（含 BITFIELDS），不支持压缩的。"""
    if len(data) < 26 or data[:2] != b"BM":
        raise ValueError("不是 BMP")
    offset = struct.unpack_from("<I", data, 10)[0]
    header = struct.unpack_from("<I", data, 14)[0]
    if header == 12:  # BITMAPCOREHEADER
        width, height, _, bpp = struct.unpack_from("<HHHH", data, 18)
        compression, colors, entry = 0, 0, 3
    else:
        width, height, _, bpp, compression = struct.unpack_from("<iiHHI", data, 18)
        colors = struct.unpack_from("<I", data, 46)[0] if header >= 40 else 0
        entry = 4
    top_down = height < 0
    height = abs(height)
    if width <= 0 or height <= 0 or width * height > 4096:
        raise ValueError("BMP 尺寸不对")
    masks = None
    if compression == 3 and bpp == 32:
        masks = struct.unpack_from("<III", data, 54)
    elif compression != 0:
        raise ValueError("不支持压缩的 BMP")
    palette = []
    if bpp == 8:
        start = 14 + header
        for i in range(colors or 256):
            b, g, r = data[start + i * entry: start + i * entry + 3]
            palette.append(_gray(r, g, b))
    elif bpp not in (24, 32):
        raise ValueError(f"不支持 {bpp} 位 BMP")
    stride = (bpp * width + 31) // 32 * 4
    if offset + stride * height > len(data):
        raise ValueError("BMP 数据不全")
    rows = []
    for y in range(height):
        base = offset + stride * y
        line = []
        for x in range(width):
            if bpp == 8:
                line.append(palette[data[base + x]])
                continue
            px = base + x * (bpp // 8)
            if masks:
                v = struct.unpack_from("<I", data, px)[0]
                r, g, b = (_channel(v, m) for m in masks)
            else:
                b, g, r = data[px], data[px + 1], data[px + 2]
            line.append(_gray(r, g, b))
        rows.append(line)
    return rows if top_down else rows[::-1]


def _channel(value: int, mask: int) -> int:
    if not mask:
        return 0
    shift = (mask & -mask).bit_length() - 1
    top = mask >> shift
    return ((value & mask) >> shift) * 255 // top


def decode_png(data: bytes) -> list[list[int]]:
    """PNG → 灰度像素。8 位深、不隔行的（OSS 缩图出来的就是这种）；万一 OSS 不出 BMP 给的是 PNG 也能读。"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG")
    pos, idat, palette = 8, b"", []
    width = height = depth = ctype = interlace = None
    while pos + 8 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, pos)
        chunk = data[pos + 8: pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"PLTE":
            palette = [_gray(*chunk[i:i + 3]) for i in range(0, len(chunk) - 2, 3)]
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ctype)
    if width is None or depth != 8 or interlace or channels is None or width * height > 4096:
        raise ValueError("不支持的 PNG")
    raw = zlib.decompress(idat)
    stride = width * channels
    prev = bytearray(stride)
    rows = []
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1: (y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b, c = prev[i], prev[i - channels] if i >= channels else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        out = []
        for x in range(width):
            px = line[x * channels: x * channels + channels]
            if ctype == 3:
                out.append(palette[px[0]])
            elif ctype in (0, 4):
                out.append(px[0])
            else:
                out.append(_gray(px[0], px[1], px[2]))
        rows.append(out)
    return rows


def _shrink(rows: list[list[int]], w: int, h: int) -> list[list[int]]:
    """缩成 w×h（按块取平均）。OSS 给的就是 9×8 时原样返回。"""
    src_h, src_w = len(rows), len(rows[0])
    if (src_w, src_h) == (w, h):
        return rows
    out = []
    for y in range(h):
        y0, y1 = y * src_h // h, max((y + 1) * src_h // h, y * src_h // h + 1)
        line = []
        for x in range(w):
            x0, x1 = x * src_w // w, max((x + 1) * src_w // w, x * src_w // w + 1)
            cells = [rows[yy][xx] for yy in range(y0, min(y1, src_h)) for xx in range(x0, min(x1, src_w))]
            line.append(sum(cells) // len(cells))
        out.append(line)
    return out


def dhash_rows(rows: list[list[int]]) -> int:
    """9×8 灰度 → 64 位：每行相邻两点，左边比右边亮记 1。"""
    grid = _shrink(rows, 9, 8)
    bits = 0
    for line in grid:
        for x in range(8):
            bits = (bits << 1) | (1 if line[x] > line[x + 1] else 0)
    return bits


def dhash_image(data: bytes) -> int:
    rows = decode_bmp(data) if data[:2] == b"BM" else decode_png(data)
    if not rows or not rows[0]:
        raise ValueError("空图")
    return dhash_rows(rows)


def distance(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


# ---------------------------------------------------------------- 取哈希（带缓存）

def enabled(db: Session) -> bool:
    if get_setting(db, OFF_KEY, "") == "1":
        return False
    return bool(settings.oss_bucket and settings.oss_access_key_id and settings.oss_access_key_secret)


def image_ref(url: str | None) -> str | None:
    """一张图认哪个：图床对象 key（换签名、换域名写法都是同一个）；认不出 key 的用干净地址。视频不算图。"""
    if not isinstance(url, str) or not url.strip() or is_oss_url_unavailable(url) or is_video_url(url):
        return None
    clean = strip_oss_signature(url.strip()) or url.strip()
    return public_url_to_object_key(clean) or clean


def _key_hash(ref: str) -> str:
    return hashlib.md5(ref.encode("utf-8")).hexdigest()


def _side_session(db: Session) -> Session:
    """单独的短事务：缓存和提示要留下来，调用方拦下后会 rollback。"""
    return Session(bind=db.get_bind())


def _download_dhash(url: str) -> int | None:
    try:
        resp = httpx.get(url, timeout=FETCH_TIMEOUT)
        if resp.status_code != 200:
            return None
        return dhash_image(resp.content)
    except Exception:  # noqa: BLE001 — 取不到、读不了都算判不了
        return None


def _signed_dhash_url(ref: str) -> str | None:
    if ref.startswith(("http://", "https://")):
        return None  # 不是图床的图，没法让 OSS 缩
    from app.services.oss import get_oss_bucket

    return get_oss_bucket().sign_url("GET", ref, 600, params={"x-oss-process": DHASH_PROCESS})


def _fetch_many(refs: list[str]) -> dict[str, int]:
    jobs = {}
    for ref in refs:
        try:
            url = _signed_dhash_url(ref)
        except Exception:  # noqa: BLE001 — OSS 没配好之类，算判不了
            url = None
        if url:
            jobs[ref] = url
    if not jobs:
        return {}
    pool = ThreadPoolExecutor(max_workers=min(FETCH_WORKERS, len(jobs)))
    futures = {pool.submit(_download_dhash, url): ref for ref, url in jobs.items()}
    done, _ = wait(futures, timeout=FETCH_BUDGET)
    pool.shutdown(wait=False, cancel_futures=True)
    out = {}
    for fut in done:
        value = fut.result()
        if value is not None:
            out[futures[fut]] = value
    return out


def _store(db: Session, found: dict[str, int]) -> None:
    if not found:
        return
    side = _side_session(db)
    try:
        for ref, value in found.items():
            side.merge(ImageDhash(key_hash=_key_hash(ref), object_key=ref[:512], dhash=f"{value:016x}"))
        side.commit()
    except SQLAlchemyError:
        side.rollback()  # 两个人同时算同一张图撞主键：别人已经存了，不要紧
    finally:
        side.close()


def hashes(db: Session, refs: list[str]) -> dict[str, int | None]:
    """ref → dHash；取不到的是 None。先查缓存，缺的并发去 OSS 取，取到的存起来。"""
    wanted = list(dict.fromkeys(r for r in refs if r))
    if not wanted:
        return {}
    by_hash = {_key_hash(r): r for r in wanted}
    out: dict[str, int | None] = {r: None for r in wanted}
    for row in db.query(ImageDhash).filter(ImageDhash.key_hash.in_(list(by_hash))).all():
        ref = by_hash.get(row.key_hash)
        if ref:
            out[ref] = int(row.dhash, 16)
    missing = [r for r, v in out.items() if v is None]
    if missing:
        found = _fetch_many(missing)
        _store(db, found)
        out.update(found)
    return out


# ---------------------------------------------------------------- 比两组图

@dataclass
class Verdict:
    clash: str | None = None
    unknown_refs: set[str] = field(default_factory=set)
    unknown_with: list[str] = field(default_factory=list)  # 判不了的是和哪些号比


def _refs(urls: list[str]) -> list[str]:
    return [r for r in (image_ref(u) for u in urls or []) if r]


def _dist(a: str, b: str, known: dict[str, int | None]) -> int | None:
    if a == b:
        return 0
    ha, hb = known.get(a), known.get(b)
    return None if ha is None or hb is None else distance(ha, hb)


def compare_pair(a: list[str], b: list[str], known: dict[str, int | None], *, same_picture: bool) -> tuple[str | None, bool]:
    """两组 ref 比一次。返回 (撞了哪种 first/same/group，有没有判不了的)。"""
    if not a or not b:
        return None, False
    first = _dist(a[0], b[0], known)
    if first is not None and first <= LOOK_ALIKE_MAX:
        return "first", False
    pairs, unknown = [], first is None
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            d = _dist(x, y, known)
            if d is None:
                unknown = True
            elif d <= LOOK_ALIKE_MAX:
                pairs.append((d, i, j))
    if same_picture and any(d <= SAME_PICTURE_MAX for d, _, _ in pairs):
        return "same", False
    pairs.sort()
    used_a, used_b, matched = set(), set(), 0
    for _, i, j in pairs:
        if i not in used_a and j not in used_b:
            used_a.add(i)
            used_b.add(j)
            matched += 1
    if matched * 2 > min(len(a), len(b)):
        return "group", False
    return None, unknown


def _same_at(a: list[str], b: list[str], known: dict[str, int | None]) -> int:
    """a 里第几张（从 1 数）和 b 里某张是同一张。"""
    for i, x in enumerate(a):
        if any((d := _dist(x, y, known)) is not None and d <= SAME_PICTURE_MAX for y in b):
            return i + 1
    return 1


_MESSAGES = {
    "first": "首图和「{b}」的首图看起来一样，每个号的首图要不同",
    "same": "第 {n} 张图和「{b}」用的是同一张（改文件名、重新上传也算），每个号的图不能重复",
    "group": "整组图大半和「{b}」的看起来一样，换几张不同的",
}


def compare(
    mine: list[tuple[str | None, list[str]]],
    others: list[tuple[str, list[str]]],
    *,
    same_picture: bool,
    known: dict[str, int | None],
) -> Verdict:
    """mine 里每组和 others 每组比，mine 之间也两两比。mine 的名字是 None 时，提示里不带「店铺 X」。"""
    verdict = Verdict()
    entries = [(name, _refs(urls)) for name, urls in mine]
    opponents = [(name, _refs(urls)) for name, urls in others]
    for idx, (name, refs) in enumerate(entries):
        targets = opponents + [(n or "", r) for n, r in entries[idx + 1:]]
        for other_name, other_refs in targets:
            kind, unknown = compare_pair(refs, other_refs, known, same_picture=same_picture)
            if kind:
                prefix = f"店铺「{name}」" if name else ""
                verdict.clash = prefix + _MESSAGES[kind].format(b=other_name, n=_same_at(refs, other_refs, known))
                return verdict
            if unknown:
                verdict.unknown_refs |= {r for r in refs + other_refs if known.get(r) is None}
                if other_name not in verdict.unknown_with:
                    verdict.unknown_with.append(other_name)
    return verdict


# ---------------------------------------------------------------- 给审批、发布用

def _signature(scope: str, verdict: Verdict) -> str:
    raw = scope + "|" + ",".join(sorted(verdict.unknown_refs)) + "|" + ",".join(sorted(verdict.unknown_with))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _confirm_or_warn(db: Session, *, sku_id: str, scope: str, verdict: Verdict, action: str,
                     user_id: str | None) -> str | None:
    """判不了：第一次提示人工对照，10 分钟内同样的内容再点一次就放过。都留记录。"""
    sig = _signature(scope, verdict)
    since = datetime.utcnow() - CONFIRM_WINDOW
    warned = (
        db.query(EventLog)
        .filter(EventLog.event_type == WARN_EVENT, EventLog.entity_type == "sku", EventLog.entity_id == sku_id,
                EventLog.created_at >= since)
        .all()
    )
    payload = {"scope": scope, "sig": sig, "refs": sorted(verdict.unknown_refs)[:30], "with": verdict.unknown_with}
    if any((w.payload or {}).get("sig") == sig for w in warned):
        db.add(EventLog(event_type=CONFIRM_EVENT, entity_type="sku", entity_id=sku_id, operator_id=user_id,
                        payload=payload, occurred_at=datetime.utcnow()))
        return None
    side = _side_session(db)
    try:
        side.add(EventLog(event_type=WARN_EVENT, entity_type="sku", entity_id=sku_id, operator_id=user_id,
                          payload=payload, occurred_at=datetime.utcnow()))
        side.commit()
    except SQLAlchemyError:
        side.rollback()
    finally:
        side.close()
    names = "」「".join(verdict.unknown_with) or "别的号"
    return (f"有 {len(verdict.unknown_refs)} 张图取不到，没法自动比对是不是和「{names}」的重复。"
            f"请对照看一眼，确认不重复再点一次{action}")


def find_problem(
    db: Session,
    *,
    sku_id: str,
    mine: list[tuple[str | None, list[str]]],
    others: list[tuple[str, list[str]]],
    same_picture: bool = False,
    confirm_scope: str | None = None,
    action: str = "提交",
    user_id: str | None = None,
) -> str | None:
    """撞了返回拦下的话；判不了时 confirm_scope 为空就放过，否则要人确认一次。没问题返回 None。"""
    if not enabled(db):
        return None
    refs = [r for _, urls in list(mine) + list(others) for r in _refs(urls)]
    if not refs:
        return None
    known = hashes(db, refs)
    verdict = compare(mine, others, same_picture=same_picture, known=known)
    if verdict.clash:
        return verdict.clash
    if verdict.unknown_refs and confirm_scope:
        return _confirm_or_warn(db, sku_id=sku_id, scope=confirm_scope, verdict=verdict, action=action,
                                user_id=user_id)
    return None


def check_shop_images(db: Session, sku, chosen: dict[str, list[str]], labels: dict[str, str]) -> None:
    """按店铺选图发布前（shop_images.validate 调）：这次各号的图之间、和别的号占着的图比长相。撞了抛 ValueError。

    别的号占着的图口径跟 shop_images._held_by_others 一样：单独挑过图的号（卖掉的除外）占着自己那组，
    在架 / 上架中、用公用图的号占着公用那组。
    """
    from app.enums import ShopListingStatus
    from app.models import SaleShop, SkuShopListing
    from app.services.shop_images import _clean, _own_images

    if not enabled(db):
        return
    live = (ShopListingStatus.LISTING, ShopListingStatus.LISTED)
    others: list[tuple[str, list[str]]] = []
    common = None
    for row in db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id).all():
        if row.sale_shop_id in chosen or row.publish_status == ShopListingStatus.SOLD:
            continue
        if row.images:
            urls = _clean(row.images)
        elif row.publish_status in live:
            common = _own_images(db, sku) if common is None else common
            urls = common
        else:
            continue
        shop = db.get(SaleShop, row.sale_shop_id)
        others.append((shop.label if shop else "别的店铺", urls))
    mine = [(labels.get(sid, sid), urls) for sid, urls in chosen.items()]
    scope = "publish:" + ",".join(f"{sid}={'+'.join(sorted(_refs(urls)))}" for sid, urls in sorted(chosen.items()))
    why = find_problem(db, sku_id=sku.id, mine=mine, others=others, same_picture=True,
                       confirm_scope=scope, action="发布")
    if why:
        raise ValueError(why)
