"""用秦丝(老系统)导出的商品图，回填新 ERP 里「无图」的 sku。

背景
----
方案 A 迁移时并非所有 sku 都带上了图：
  1. 122 条 sku 的 cover_url 与 images 全空；
  2. 另有 30 条 cover_url 还是腾讯云开发的 `cloud://` 死链（HTTP 取不到）。
合计 152 条在小程序/上架页显示为无图。

秦丝导出的《商品列表导出(含图片).xlsx》里每行带一个 thumb.qinsilk.com 外链，
该图床至今仍可公网访问，且与已迁移的图 **字节一致**（对 257 条能唯一匹配的
sku 做过 MD5 比对：136 条服务器封面与秦丝原图 MD5 完全相同，其余 96 条是 ERP
自己拍的验货图 inspection/listing/*，本就不该被覆盖）。所以可以拿它补图。

匹配置信度（由 scripts/migration/build_qinsilk_image_plan.py 在本地生成 plan）
    A  货号==sku_code 唯一命中，或 秦丝条码==sku.serial_number 唯一命中 → 同一实物
    B  唯一名称命中，或 货号/条码多命中取首条
    C  同名多件（二手一物一码，图可能张冠李戴）——默认不回填
    D  秦丝里也找不到源图

写入口径
--------
* 下载秦丝原图 → 上传 OSS `migrate/qinsilk/<原路径>`（与 migrate_qinsilk_media.py
  同一约定，URL 映射共用 data/cloud_dump/qinsilk_media_map.json，可中断重跑）；
* 只写 canonical public_url，**不写签名 URL**（签名会过期，闲鱼 push_media 会挂）；
* 只补「本来没有可用图」的 sku：cover_url 为空/cloud:// 且 images 里没有 http 图；
  已有 inspection/listing 实拍图的 sku 一律不碰。

用法（生产 /www/wwwroot/py-api，venv 内执行）：
    venv/bin/python -m scripts.migration.backfill_missing_images_from_qinsilk --plan plan.json            # 预演
    venv/bin/python -m scripts.migration.backfill_missing_images_from_qinsilk --plan plan.json --tiers A --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse

from sqlalchemy.orm.attributes import flag_modified

from app.database import SessionLocal
from app.models import Sku
from app.services.oss import upload_object

logger = logging.getLogger("migration.backfill_img")

_DUMP_DIR = Path(__file__).resolve().parents[2] / "data" / "cloud_dump"
_DUMP_DIR.mkdir(parents=True, exist_ok=True)
# 与 migrate_qinsilk_media.py 共用同一份映射，同一张图不会重复上传
MEDIA_MAP_FILE = _DUMP_DIR / "qinsilk_media_map.json"


def _load_map() -> dict:
    if MEDIA_MAP_FILE.exists():
        return json.loads(MEDIA_MAP_FILE.read_text())
    return {}


def _save_map(mapping: dict) -> None:
    MEDIA_MAP_FILE.write_text(json.dumps(mapping, ensure_ascii=False, indent=1))


def _url_path(url: str) -> str:
    return unquote(urlparse(url).path).lstrip("/")


def _download(url: str) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=45) as resp:  # noqa: S310
            data = resp.read()
        return data or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("下载失败 %s: %s", url, str(exc)[:160])
        return None


def _needs_image(sku: Sku) -> bool:
    """与生成 plan 时同一口径：没有任何可用 http 图才算缺图。"""
    cover_ok = bool(sku.cover_url) and sku.cover_url.startswith("http")
    imgs_ok = any(isinstance(u, str) and u.startswith("http") for u in (sku.images or []))
    return not cover_ok and not imgs_ok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True, help="本地生成的回填计划 JSON")
    ap.add_argument("--tiers", default="A", help="要回填的置信度档，逗号分隔，如 A 或 A,B")
    ap.add_argument("--apply", action="store_true", help="真正写库（默认只预演）")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    tiers = {t.strip().upper() for t in args.tiers.split(",") if t.strip()}

    plan = json.loads(Path(args.plan).read_text(encoding="utf8"))
    todo = [p for p in plan if p.get("tier") in tiers and p.get("src_url")]
    logger.info("计划共 %d 条，本次档位 %s 命中 %d 条", len(plan), sorted(tiers), len(todo))

    mapping = _load_map()
    db = SessionLocal()
    stats = {"filled": 0, "skip_has_img": 0, "skip_no_sku": 0, "dl_fail": 0, "reused": 0}
    try:
        for i, item in enumerate(todo, 1):
            code = item["sku_code"]
            sku = db.query(Sku).filter(Sku.sku_code == code).one_or_none()
            if sku is None:
                stats["skip_no_sku"] += 1
                logger.warning("sku 不存在 %s", code)
                continue
            if not _needs_image(sku):
                stats["skip_has_img"] += 1
                logger.info("已有图，跳过 %s", code)
                continue

            src = item["src_url"]
            public_url = mapping.get(src)
            if public_url:
                stats["reused"] += 1
            else:
                if not args.apply:
                    logger.info("[预演] 将下载并上传 %s -> %s", src, code)
                    stats["filled"] += 1
                    continue
                data = _download(src)
                if not data:
                    stats["dl_fail"] += 1
                    continue
                path = _url_path(src)
                filename = path.rsplit("/", 1)[-1] or "file.jpg"
                dir_prefix = "migrate/qinsilk/" + (path.rsplit("/", 1)[0] if "/" in path else "")
                content_type = mimetypes.guess_type(filename)[0] or "image/jpeg"
                result = upload_object(dir_prefix.rstrip("/"), filename, data, content_type)
                public_url = result["public_url"]  # 只存 canonical，不存签名 URL
                mapping[src] = public_url
                if i % 20 == 0:
                    _save_map(mapping)

            if not args.apply:
                logger.info("[预演] 复用映射 %s -> %s", public_url, code)
                stats["filled"] += 1
                continue

            sku.cover_url = public_url
            sku.images = [public_url]
            flag_modified(sku, "images")
            stats["filled"] += 1
            if i % 20 == 0 or i == len(todo):
                db.commit()
                logger.info("进度 %d/%d", i, len(todo))

        if args.apply:
            db.commit()
            _save_map(mapping)
    finally:
        db.close()

    logger.info(
        "完成%s：回填 %d，复用已迁移图 %d，已有图跳过 %d，sku 不存在 %d，下载失败 %d",
        "" if args.apply else "（预演，未写库）",
        stats["filled"], stats["reused"], stats["skip_has_img"],
        stats["skip_no_sku"], stats["dl_fail"],
    )


if __name__ == "__main__":
    main()
