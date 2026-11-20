"""采购商品快照服务（W04）：多版本原文、哈希、冻结。

11-16 补：
  - 快照可以挂采购单，也可以挂执行端抓回来的平台订单（一单多件几张采购单共用）；
  - 卖家写的型号、规格分开存；标明是采购手填、下单前抓的、还是下单后补抓的（补抓的不能说成当时的页面）；
  - 原图 / 视频 / 检测报告转存到我们图床，记对象名、大小和 SHA-256；转存失败标失败，不说成已存；
    缩略图不顶替原件。转存不改快照内容，冻结了也能转。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import urllib.request
from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.purchase import PurchaseOrder
from app.models.purchase_snapshot import PurchaseItemSnapshot
from app.services.oss_media import strip_oss_signature

log = logging.getLogger(__name__)

CAPTURE_KINDS = {"manual": "采购手填", "live": "下单前抓的", "late": "下单后补抓的"}
MEDIA_MAX_BYTES = 30 * 1024 * 1024
_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4",
        "application/pdf": ".pdf"}


def _clean_images(images: list[str] | None) -> list[str]:
    out: list[str] = []
    for u in images or []:
        if isinstance(u, str) and u.strip():
            url = strip_oss_signature(u.strip()) or u.strip()
            if url not in out:
                out.append(url)
    return out[:20]


def content_hash(
    *,
    platform_item_id: str | None,
    source_url: str | None,
    title: str | None,
    description: str | None,
    condition_text: str | None,
    accessories_text: str | None,
    listed_price: Decimal | None,
    images: list[str] | None,
    declared_model: str | None = None,
    specs: str | None = None,
) -> str:
    payload = {
        "platform_item_id": (platform_item_id or "").strip(),
        "source_url": (source_url or "").strip(),
        "title": (title or "").strip(),
        "description": (description or "").strip(),
        "condition_text": (condition_text or "").strip(),
        "accessories_text": (accessories_text or "").strip(),
        "listed_price": str(listed_price) if listed_price is not None else "",
        "images": _clean_images(images),
    }
    # 11-16 加的两项只在有值时算进去，老快照的哈希不变
    if (declared_model or "").strip():
        payload["declared_model"] = declared_model.strip()
    if (specs or "").strip():
        payload["specs"] = specs.strip()
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def latest(db: Session, purchase_order_id: str) -> PurchaseItemSnapshot | None:
    return (
        db.query(PurchaseItemSnapshot)
        .filter(PurchaseItemSnapshot.purchase_order_id == purchase_order_id)
        .order_by(PurchaseItemSnapshot.version.desc())
        .first()
    )


def list_versions(db: Session, purchase_order_id: str) -> list[PurchaseItemSnapshot]:
    return (
        db.query(PurchaseItemSnapshot)
        .filter(PurchaseItemSnapshot.purchase_order_id == purchase_order_id)
        .order_by(PurchaseItemSnapshot.version.desc())
        .all()
    )


def create_version(
    db: Session,
    *,
    purchase_order_id: str | None,
    user_id: str | None,
    platform: str = "xianyu",
    platform_item_id: str | None = None,
    source_url: str | None = None,
    title: str | None = None,
    description: str | None = None,
    condition_text: str | None = None,
    accessories_text: str | None = None,
    listed_price: Decimal | None = None,
    seller_name: str | None = None,
    images: list[str] | None = None,
    raw_payload: dict | None = None,
    capture_status: str = "OK",
    capture_error: str | None = None,
    freeze: bool = False,
    platform_order_id: str | None = None,
    declared_model: str | None = None,
    specs: str | None = None,
    capture_kind: str = "manual",
    captured_at: datetime | None = None,
    videos: list[str] | None = None,
    reports: list[str] | None = None,
) -> PurchaseItemSnapshot:
    """新增一版快照。内容与上一版哈希相同则直接返回上一版，不灌重复行。"""
    images = _clean_images(images)
    digest = content_hash(
        platform_item_id=platform_item_id,
        source_url=source_url,
        title=title,
        description=description,
        condition_text=condition_text,
        accessories_text=accessories_text,
        listed_price=listed_price,
        images=images,
        declared_model=declared_model,
        specs=specs,
    )
    if purchase_order_id:
        prev = latest(db, purchase_order_id)
    elif platform_order_id:
        prev = latest_for_platform(db, platform_order_id)
    else:
        prev = None
    if prev is not None and prev.frozen_at is not None:
        raise HTTPException(status_code=400, detail="快照已冻结（下单后），不能再改；如需对照请另开议价凭证")
    if prev is not None and prev.content_hash == digest and prev.capture_status == capture_status:
        return prev

    version = (prev.version + 1) if prev else 1
    root_id = prev.root_id or prev.id if prev else None
    row = PurchaseItemSnapshot(
        purchase_order_id=purchase_order_id,
        platform=(platform or "xianyu")[:32],
        platform_item_id=(platform_item_id or "").strip()[:64] or None,
        source_url=(source_url or "").strip()[:1024] or None,
        title=(title or "").strip()[:512] or None,
        description=(description or "").strip() or None,
        condition_text=(condition_text or "").strip()[:128] or None,
        accessories_text=(accessories_text or "").strip()[:512] or None,
        listed_price=listed_price,
        seller_name=(seller_name or "").strip()[:128] or None,
        images=images or None,
        raw_payload=raw_payload,
        content_hash=digest,
        version=version,
        root_id=root_id,
        capture_status=(capture_status or "OK")[:32],
        capture_error=(capture_error or "").strip()[:255] or None,
        created_by_id=user_id,
        frozen_at=datetime.utcnow() if freeze else None,
        platform_order_id=platform_order_id,
        declared_model=(declared_model or "").strip()[:128] or None,
        specs=(specs or "").strip() or None,
        capture_kind=capture_kind if capture_kind in CAPTURE_KINDS else "manual",
        captured_at=captured_at or datetime.utcnow(),
        media=_media(images, "image") + _media(videos, "video") + _media(reports, "report") or None,
    )
    db.add(row)
    db.flush()
    if root_id is None:
        row.root_id = row.id
        db.flush()
    return row


def freeze_latest(db: Session, purchase_order_id: str) -> PurchaseItemSnapshot | None:
    row = latest(db, purchase_order_id)
    if row is None:
        return None
    if row.frozen_at is None:
        row.frozen_at = datetime.utcnow()
    return row


def attach_to_order(db: Session, snapshot_id: str, order: PurchaseOrder, user_id: str | None) -> PurchaseItemSnapshot:
    row = db.get(PurchaseItemSnapshot, snapshot_id)
    if row is None:
        raise HTTPException(status_code=404, detail="快照不存在")
    if row.purchase_order_id and row.purchase_order_id != order.id:
        raise HTTPException(status_code=400, detail="快照已绑到别的采购单")
    row.purchase_order_id = order.id
    if user_id and not row.created_by_id:
        row.created_by_id = user_id
    return row


def latest_for_platform(db: Session, platform_order_id: str) -> PurchaseItemSnapshot | None:
    return (db.query(PurchaseItemSnapshot).filter(PurchaseItemSnapshot.platform_order_id == platform_order_id,
                                                  PurchaseItemSnapshot.purchase_order_id.is_(None))
            .order_by(PurchaseItemSnapshot.version.desc()).first())


def for_order(db: Session, order: PurchaseOrder) -> list[PurchaseItemSnapshot]:
    """一张采购单能看的快照：自己的（议价 / 手填）+ 挂的平台订单上执行端抓的。新→旧。"""
    rows = list_versions(db, order.id)
    if order.platform_order_id:
        rows += (db.query(PurchaseItemSnapshot)
                 .filter(PurchaseItemSnapshot.platform_order_id == order.platform_order_id,
                         PurchaseItemSnapshot.purchase_order_id.is_(None))
                 .order_by(PurchaseItemSnapshot.version.desc()).all())
    return rows


def _media(urls: list[str] | None, kind: str) -> list[dict]:
    """我们图床里的对象（采购自己传的）直接算已存；外面的链接排队转存。"""
    out = []
    for u in _clean_images(urls):
        if u.startswith(("http://", "https://")):
            out.append({"src": u, "type": kind, "status": "pending"})
        else:
            out.append({"src": u, "type": kind, "status": "saved", "key": u, "ours": True})
    return out


def _fetch(url: str) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.goofish.com/"})
    with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 —— 只拉 http(s)，上面已经筛过
        body = r.read(MEDIA_MAX_BYTES + 1)
        if len(body) > MEDIA_MAX_BYTES:
            raise ValueError("文件超过 30MB")
        return body, (r.headers.get_content_type() or "")


def _upload(key_dir: str, name: str, body: bytes, content_type: str) -> str:
    from app.services import oss

    return oss.upload_object(key_dir, name, body, content_type=content_type or None)["object_key"]


def archive_media(row: PurchaseItemSnapshot, *, fetch=_fetch, upload=_upload) -> int:
    """把还没转存的原图 / 视频 / 报告拉下来存进我们图床。返回这次存成功几个。失败的留着原因，能再试。"""
    media = [dict(m) for m in (row.media or [])]
    saved = 0
    for m in media:
        if m.get("status") not in ("pending", "failed"):
            continue
        try:
            body, ctype = fetch(m["src"])
            if not body:
                raise ValueError("拉回来是空的")
            digest = hashlib.sha256(body).hexdigest()
            ext = _EXT.get(ctype) or os.path.splitext(m["src"].split("?")[0])[1][:6] or ".bin"
            key = upload(f"purchase/snapshots/{row.root_id or row.id}", f"{digest[:16]}{ext}", body, ctype)
            m.update(status="saved", key=key, sha256=digest, size=len(body), content_type=ctype,
                     saved_at=datetime.utcnow().isoformat(timespec="seconds"), error=None)
            saved += 1
        except Exception as exc:  # noqa: BLE001 —— 单个失败不拖累别的，原因留给人看
            m.update(status="failed", error=str(exc)[:200])
            log.warning("快照原件转存失败 %s %s: %s", row.id, m.get("src"), exc)
    row.media = media
    return saved


def archive_pending(db: Session, limit: int = 30) -> int:
    """后台：把有待转存原件的快照转一遍（失败的也再试一次）。"""
    rows = (db.query(PurchaseItemSnapshot).filter(PurchaseItemSnapshot.media.isnot(None))
            .order_by(PurchaseItemSnapshot.created_at.desc()).limit(500).all())
    n = 0
    for row in rows:
        if n >= limit:
            break
        if any(m.get("status") in ("pending", "failed") for m in row.media or []):
            n += 1
            archive_media(row)
            db.commit()
    return n


def _media_out(media: list | None) -> list[dict]:
    out = []
    for m in media or []:
        x = {k: m.get(k) for k in ("src", "type", "status", "sha256", "size", "error", "saved_at")}
        if m.get("status") == "saved" and m.get("key"):
            try:
                from app.services.oss import sign_download_url

                x["url"] = sign_download_url(m["key"], expires=3600)
            except Exception:  # noqa: BLE001 —— 本机没配图床时照样能看清单
                x["url"] = None
        out.append(x)
    return out


def snapshot_out(row: PurchaseItemSnapshot) -> dict:
    return {
        "id": row.id,
        "purchase_order_id": row.purchase_order_id,
        "platform": row.platform,
        "platform_item_id": row.platform_item_id,
        "source_url": row.source_url,
        "title": row.title,
        "description": row.description,
        "condition_text": row.condition_text,
        "accessories_text": row.accessories_text,
        "listed_price": row.listed_price,
        "seller_name": row.seller_name,
        "images": row.images or [],
        "content_hash": row.content_hash,
        "version": row.version,
        "root_id": row.root_id,
        "frozen_at": row.frozen_at,
        "capture_status": row.capture_status,
        "capture_error": row.capture_error,
        "created_by_id": row.created_by_id,
        "created_at": row.created_at,
        "platform_order_id": row.platform_order_id,
        "declared_model": row.declared_model,
        "specs": row.specs,
        "capture_kind": row.capture_kind,
        "capture_kind_label": CAPTURE_KINDS.get(row.capture_kind or "manual", row.capture_kind),
        "captured_at": row.captured_at,
        "media": _media_out(row.media),
        "media_saved": sum(1 for m in row.media or [] if m.get("status") == "saved"),
        "media_total": len(row.media or []),
    }
