"""把数据库里残留的 CloudBase `cloud://` 图片/视频搬到阿里云 OSS,并改写 URL。

迁移时所有媒体字段照搬了云端的 fileID(cloud://env.bucket/path),新系统的
OSS 签名只认 OSS URL,导致"商品图片没复制到新系统"。本脚本:

1. 扫描各表媒体字段,收集所有 cloud:// fileID;
2. 用 CloudBase CLI(tcb,需已 `tcb login`)逐个下载到本地临时目录;
3. 上传到 OSS `migrate/<云端原路径>`;
4. 改写数据库字段(字符串、列表、嵌套 dict 都会递归替换);
5. 映射缓存在 data/cloud_dump/media_map.json,可中断重跑(断点续传)。

用法:
    cd server
    python3 -m scripts.migration.migrate_media --dry-run   # 只统计不动数据
    python3 -m scripts.migration.migrate_media              # 正式执行
    python3 -m scripts.migration.migrate_media --env-id wms-8g7f6vae1ef8f780
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import subprocess
import tempfile
from pathlib import Path

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.database import SessionLocal
from app.models import Inspection, NegotiationTask, PurchaseOrder, Sku, SkuListingInfo
from app.services.oss import upload_object
from scripts.migration.common import CLOUD_DUMP_DIR

logger = logging.getLogger("migration.media")

DEFAULT_ENV_ID = os.environ.get("TCB_ENV_ID", "wms-8g7f6vae1ef8f780")
MEDIA_MAP_FILE = CLOUD_DUMP_DIR / "media_map.json"

# 表 → 需要扫描/改写的媒体字段
MEDIA_FIELDS = {
    PurchaseOrder: ["product_images", "attachments", "screenshot_url", "screenshot_url_2"],
    Sku: ["images", "location_images", "cover_url"],
    Inspection: ["listing_images", "defect_images", "defect_videos", "reject_images"],
    NegotiationTask: ["product_images", "defect_images", "defect_videos", "close_evidence_files"],
    SkuListingInfo: ["images"],
}


def _collect_file_ids(value, out: set) -> None:
    if isinstance(value, str):
        if value.startswith("cloud://"):
            out.add(value)
    elif isinstance(value, list):
        for v in value:
            _collect_file_ids(v, out)
    elif isinstance(value, dict):
        for v in value.values():
            _collect_file_ids(v, out)


def _rewrite(value, mapping: dict):
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_rewrite(v, mapping) for v in value]
    if isinstance(value, dict):
        return {k: _rewrite(v, mapping) for k, v in value.items()}
    return value


def _cloud_path(file_id: str) -> str:
    """cloud://<env>.<bucket>/<path> → <path>"""
    rest = file_id[len("cloud://") :]
    return rest.split("/", 1)[1] if "/" in rest else rest


def _download(file_id: str, env_id: str, dest: Path) -> bool:
    cmd = ["tcb", "storage", "download", _cloud_path(file_id), str(dest), "-e", env_id]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)  # noqa: S603
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        logger.warning("下载失败 %s: %s", file_id, (proc.stderr or proc.stdout).strip()[:200])
        return False
    return True


def _load_map() -> dict:
    if MEDIA_MAP_FILE.exists():
        return json.loads(MEDIA_MAP_FILE.read_text())
    return {}


def _save_map(mapping: dict) -> None:
    MEDIA_MAP_FILE.write_text(json.dumps(mapping, ensure_ascii=False, indent=1))


def migrate_files(file_ids: set, env_id: str, mapping: dict) -> None:
    todo = sorted(fid for fid in file_ids if fid not in mapping)
    logger.info("待搬运文件 %d 个(已有映射 %d 个)", len(todo), len(mapping))
    with tempfile.TemporaryDirectory() as tmp:
        for i, fid in enumerate(todo, 1):
            cloud_path = _cloud_path(fid)
            filename = cloud_path.rsplit("/", 1)[-1] or "file"
            local = Path(tmp) / f"{i}_{filename}"
            if not _download(fid, env_id, local):
                continue
            content_type = mimetypes.guess_type(filename)[0] or "image/jpeg"
            dir_prefix = "migrate/" + (cloud_path.rsplit("/", 1)[0] if "/" in cloud_path else "")
            result = upload_object(dir_prefix.rstrip("/"), filename, local.read_bytes(), content_type)
            mapping[fid] = result["public_url"]
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
    parser.add_argument("--env-id", default=DEFAULT_ENV_ID)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        file_ids: set = set()
        per_table = {}
        for model, fields in MEDIA_FIELDS.items():
            before = len(file_ids)
            for row in db.query(model).all():
                for field in fields:
                    _collect_file_ids(getattr(row, field, None), file_ids)
            per_table[model.__tablename__] = len(file_ids) - before
        logger.info("各表 cloud:// 文件数: %s,合计 %d", per_table, len(file_ids))

        if args.dry_run:
            return

        mapping = _load_map()
        migrate_files(file_ids, args.env_id, mapping)
        changed = rewrite_db(db, mapping)
        remaining = len([f for f in file_ids if f not in mapping])
        logger.info("完成:改写 %d 行;未能搬运 %d 个文件(见上方下载失败日志)", changed, remaining)
    finally:
        db.close()


if __name__ == "__main__":
    main()
