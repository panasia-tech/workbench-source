"""把历史 8 位货号迁移时照搬的老系统(秦丝)外链图片搬到阿里云 OSS,并改写 URL。

方案 A 迁移时,sku/采购单/验货单的图片字段直接存了秦丝 CDN 外链
(https://thumb.qinsilk.com/...)。这些外链虽公网可访问,但:
  1. 后端 OSS 签名逻辑(public_url_to_object_key)会把外链路径误当成本 OSS 的
     object key 去签名,导致指向我们自己 bucket 的 404;
  2. 小程序合法域名白名单不含 thumb.qinsilk.com,无法加载;
  3. 依赖老系统 CDN,不可控。

本脚本与 migrate_media.py 同构,区别是用 HTTP 下载而非 tcb:
  1. 扫描各表媒体字段,收集所有 qinsilk 外链;
  2. 用 HTTP 逐个下载到临时目录;
  3. 上传到 OSS `migrate/qinsilk/<原路径>`;
  4. 改写数据库字段(字符串、列表、嵌套 dict 递归替换);
  5. 映射缓存在 data/cloud_dump/qinsilk_media_map.json,可中断重跑。

用法(在生产服务器 /www/wwwroot/py-api 下,venv 内执行):
    python3 -m scripts.migration.migrate_qinsilk_media --dry-run   # 只统计
    python3 -m scripts.migration.migrate_qinsilk_media             # 正式执行
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.database import SessionLocal
from app.models import Inspection, NegotiationTask, PurchaseOrder, Sku, SkuListingInfo
from app.services.oss import upload_object

logger = logging.getLogger("migration.qinsilk")

# 自包含 map 路径:本地 = server/data/cloud_dump,服务器 = /www/wwwroot/py-api/data/cloud_dump
_DUMP_DIR = Path(__file__).resolve().parents[2] / "data" / "cloud_dump"
_DUMP_DIR.mkdir(parents=True, exist_ok=True)
MEDIA_MAP_FILE = _DUMP_DIR / "qinsilk_media_map.json"

# 命中这些 host 的 http(s) 外链才会被搬运(只动老系统图床,绝不碰本 OSS / 其它链接)
TARGET_HOSTS = ("qinsilk.com",)

# 表 → 需要扫描/改写的媒体字段(与 migrate_media.py 一致)
MEDIA_FIELDS = {
    PurchaseOrder: ["product_images", "attachments", "screenshot_url", "screenshot_url_2"],
    Sku: ["images", "location_images", "cover_url"],
    Inspection: ["listing_images", "defect_images", "defect_videos", "reject_images"],
    NegotiationTask: ["product_images", "defect_images", "defect_videos", "close_evidence_files"],
    SkuListingInfo: ["images"],
}


def _is_target(url: str) -> bool:
    if not isinstance(url, str) or not url.startswith("http"):
        return False
    host = urlparse(url).netloc.lower()
    return any(h in host for h in TARGET_HOSTS)


def _collect_urls(value, out: set) -> None:
    if isinstance(value, str):
        if _is_target(value):
            out.add(value)
    elif isinstance(value, list):
        for v in value:
            _collect_urls(v, out)
    elif isinstance(value, dict):
        for v in value.values():
            _collect_urls(v, out)


def _rewrite(value, mapping: dict):
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_rewrite(v, mapping) for v in value]
    if isinstance(value, dict):
        return {k: _rewrite(v, mapping) for k, v in value.items()}
    return value


def _url_path(url: str) -> str:
    """https://host/goods/album/.../x.jpg → goods/album/.../x.jpg"""
    return urlparse(url).path.lstrip("/")


def _download(url: str, dest: Path) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            data = resp.read()
        if not data:
            logger.warning("下载为空 %s", url)
            return False
        dest.write_bytes(data)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("下载失败 %s: %s", url, str(exc)[:200])
        return False


def _load_map() -> dict:
    if MEDIA_MAP_FILE.exists():
        return json.loads(MEDIA_MAP_FILE.read_text())
    return {}


def _save_map(mapping: dict) -> None:
    MEDIA_MAP_FILE.write_text(json.dumps(mapping, ensure_ascii=False, indent=1))


def migrate_files(urls: set, mapping: dict) -> None:
    todo = sorted(u for u in urls if u not in mapping)
    logger.info("待搬运外链 %d 个(已有映射 %d 个)", len(todo), len(mapping))
    with tempfile.TemporaryDirectory() as tmp:
        for i, url in enumerate(todo, 1):
            path = _url_path(url)
            filename = path.rsplit("/", 1)[-1] or "file"
            local = Path(tmp) / f"{i}_{filename}"
            if not _download(url, local):
                continue
            content_type = mimetypes.guess_type(filename)[0] or "image/jpeg"
            dir_prefix = "migrate/qinsilk/" + (path.rsplit("/", 1)[0] if "/" in path else "")
            result = upload_object(dir_prefix.rstrip("/"), filename, local.read_bytes(), content_type)
            mapping[url] = result["public_url"]
            local.unlink(missing_ok=True)
            if i % 20 == 0 or i == len(todo):
                _save_map(mapping)
                logger.info("进度 %d/%d", i, len(todo))
    _save_map(mapping)


def rewrite_db(db: Session, mapping: dict) -> int:
    changed = 0
    for model, fields in MEDIA_FIELDS.items():
        for row in db.query(model).all():
            row_changed = False
            for field in fields:
                old = getattr(row, field, None)
                if old is None:
                    continue
                new = _rewrite(old, mapping)
                if new != old:
                    setattr(row, field, new)
                    if isinstance(new, (list, dict)):
                        flag_modified(row, field)
                    row_changed = True
            if row_changed:
                changed += 1
        db.commit()
    return changed


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        urls: set = set()
        per_table = {}
        for model, fields in MEDIA_FIELDS.items():
            before = len(urls)
            for row in db.query(model).all():
                for field in fields:
                    _collect_urls(getattr(row, field, None), urls)
            per_table[model.__tablename__] = len(urls) - before
        logger.info("各表新增 qinsilk 外链(去重后): %s,合计 %d", per_table, len(urls))

        if args.dry_run:
            for u in sorted(urls)[:5]:
                logger.info("  示例: %s", u)
            return

        mapping = _load_map()
        migrate_files(urls, mapping)
        changed = rewrite_db(db, mapping)
        remaining = len([u for u in urls if u not in mapping])
        logger.info("完成:改写 %d 行;未能搬运 %d 个外链(见上方下载失败日志)", changed, remaining)
    finally:
        db.close()


if __name__ == "__main__":
    main()
