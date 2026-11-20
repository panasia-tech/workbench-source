"""手动上架的 AI 主图兜底:货没有商品图时先 AI 生成主图(同款实拍图重绘,或按型号文生图),再上架。

2026-10-08 现场:小程序「店铺上架」点了几个没拍照的货,群控一律拒收「缺少商品图」,提示一闪
而过,同事以为没反应、反复点。当时在库、已填上架信息的 320 个货里 134 个一张图都没有。
自动上架流水线 9 月就有「没实拍图按 SPU 文生图补一张」(auto_listing/images.py,老板 09-08 定),
手动上架没接上——这里接上:同一套提示词、同一条生图流水线(ai_redraw_job + redraw_worker)。

参考图从哪来(10-08 文生图把「盛色 N50PRO6」这台显示器画成了耳机——没参考时 AI 只能凭型号名猜品类):
- 同型号(同 SPU,退一步同品名)有别的货拍过实拍图 → 拿它当参考重绘成白底主图,品类外观都对,自动上架;
- 没有同款 → 照样按型号文生图,但**不自动上架**:上架信息标 ai_image_unconfirmed,店铺挂着等人在小程序
  看一眼点「确认上架」(或「重新生成」,可补一句品类)。用户 10-08 定的口径。
- 封面绝不用(当图或当参考都不行):抽查过,没图的货封面是箱标/铭牌照,还有带买家姓名电话的闲鱼订单截图。

流程:
- 上架时没有图:有参考图的现成 AI 图(同款重绘/人工重绘)直接用;没有就发起生图,目标店铺先置
  「上架中」并记下在等哪个生图任务,接口立刻返回。
- 后台每 20 秒巡一次(具名锁,两个 worker 只跑一份):同款重绘的图出来了写进上架信息、照常下发;
  文生图的图出来了写进上架信息并标待确认、不下发;确认后下一轮下发。生图失败/超时 → 店铺置「失败」
  并写明原因,补图后重新上架即可。等图期间人工传了实拍图 → 不等了,直接用实拍图上架。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.enums import ListingInfoStatus, ShopListingStatus
from app.models import AiRedrawJob, Sku, SkuListingInfo, SkuShopListing, WarehouseSpuSku
from app.services import product_image, redraw_worker
from app.services.auto_listing.images import _text_to_image_supported, build_prompt
from app.services.gc_bridge.listing_ops import _resolve_targets, gc_publish_shops
from app.services.oss_media import sign_media_payload, strip_oss_signature
from app.services.spu_resolve import resolve_spu

logger = logging.getLogger("gc.ai_image_publish")

LOCK_KEY = "erp:listing:ai_image_publish"
POLL_SECONDS = 20
# 文生图一张四十秒上下;人在等着上架,十分钟还没出来就当它废了,别让店铺一直挂在「上架中」
JOB_TIMEOUT = timedelta(minutes=10)
_RETRY_HINT = "请上传商品主图后重新上架"
# 同群控 publish_spec 的隐私图判据:买家成交截图、库位图、议价/改派证据不能当参考图
_FORBIDDEN_IMG_MARKERS = ("_order_", "/location", "location_images", "negotiat", "redispatch")
# 参考图只要真拍的:拿 AI 图再当参考,错了会一路传下去
_AI_IMAGE_MARKER = "/ai-redraw/"
# 有参考图时补在提示词后面:让它照着参考图里那件东西画,别自己发挥品类
_REFERENCE_SUFFIX = "。以参考图中的商品为准,保持同一型号的品类、外观、颜色和结构,只换成白底棚拍效果"


def has_images(info: SkuListingInfo | None, sku: Sku) -> bool:
    """上架取图的口径同 assembler._pick_images:上架信息里的图,没有再用货本身的实拍图。"""
    raw = (info.images if info and info.images else None) or sku.images or []
    return any(isinstance(u, str) and u.strip() for u in raw)


def latest_ai_image(db: Session, sku_code: str) -> str | None:
    """这个货最近一张**照着参考图**生成成功的 AI 图(同款重绘、人工在填表页重绘的),可直接用。
    纯文生图、照图片爬虫的图重绘的都不算:要经人确认后写进上架信息再用。"""
    job = (
        db.query(AiRedrawJob)
        .filter(AiRedrawJob.sku_code == sku_code, AiRedrawJob.status == "SUCCEEDED",
                AiRedrawJob.result_url.isnot(None), AiRedrawJob.source_image_url != "",
                ~AiRedrawJob.source_image_url.contains(product_image.REF_MARKER))
        .order_by(AiRedrawJob.created_at.desc())
        .first()
    )
    # 存干净原始 URL,不存短效签名(与 listing.save_listing 同一口径)
    return strip_oss_signature(job.result_url) if job else None


def _usable_reference(url) -> bool:
    return (isinstance(url, str) and bool(url.strip()) and _AI_IMAGE_MARKER not in url
            and not any(m in url for m in _FORBIDDEN_IMG_MARKERS))


def same_model_photo(db: Session, sku: Sku, match=None) -> str | None:
    """同型号别的货拍过的实拍图(取它上架用的第一张),没有返回 None。

    同型号 = 仓库 SPU 对照表里同一个 SPU;对照表解析不出来就退一步按同品名。
    优先它上架信息里的图(人挑过、已经挂到闲鱼上的),其次它自己的实拍图。
    """
    match = match if match is not None else resolve_spu(db, sku)
    others: list[Sku] = []
    if match.matched:
        codes = [x.sku_code for x in
                 db.query(WarehouseSpuSku).filter(WarehouseSpuSku.spu_id == match.spu.id).all()]
        if codes:
            others = (db.query(Sku).filter(Sku.sku_code.in_(codes), Sku.id != sku.id)
                      .order_by(Sku.created_at.desc()).all())
    if not others and (sku.product_name or "").strip():
        others = (db.query(Sku).filter(Sku.product_name == sku.product_name, Sku.id != sku.id)
                  .order_by(Sku.created_at.desc()).all())
    for other in others:
        info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == other.id).first()
        for url in (info.images if info and info.images else None) or other.images or []:
            if _usable_reference(url):
                return strip_oss_signature(url)
    return None


def needs_confirm(job: AiRedrawJob) -> bool:
    """出的图要不要人确认才上架:纯文生图(可能猜错品类)、照图片爬虫的图重绘的(爬来的图审过也可能是
    配件广告、相近变体)都要;只有照同款实拍图重绘的直接用。"""
    src = job.source_image_url or ""
    return not src or product_image.REF_MARKER in src


def _inflight_ai_job(db: Session, sku_code: str) -> AiRedrawJob | None:
    cutoff = datetime.utcnow() - JOB_TIMEOUT
    return (
        db.query(AiRedrawJob)
        .filter(AiRedrawJob.sku_code == sku_code, AiRedrawJob.status.in_(("PENDING", "RUNNING")),
                AiRedrawJob.created_at >= cutoff)
        .order_by(AiRedrawJob.created_at.desc())
        .first()
    )


def _product_subject(sku: Sku, match) -> str:
    """提示词里「这是什么货」:SPU 对照表的规范名 > 品牌+型号 > 商品名。
    很多货品牌字段是空的,只剩型号(N50PRO6)时 AI 更没法猜对,所以缺品牌就用商品名(盛色 N50PRO6)。"""
    if match.matched and match.query:
        return match.query
    brand, model = (sku.brand or "").strip(), (sku.model or "").strip()
    if brand and model:
        return f"{brand} {model}"
    return (sku.product_name or "").strip() or model


def _submit_ai_job(db: Session, sku: Sku, hint: str = "", *, skip_crawled_ref: bool = False) -> AiRedrawJob:
    """出一张主图:有同款实拍图就照着它重绘;没有就用图片爬虫审过的同款图当参考;都没有按「品牌 型号」
    文生图(与自动上架同一个模板),并顺手给这个 SPU 发起一次搜图,下次就有参考了。
    hint 是人在「重新生成」时补的一句品类(如「显示器」),拼在型号前面;上一张就是照爬虫图画的、人说不对,
    skip_crawled_ref 让这次别再照同一张画。"""
    match = resolve_spu(db, sku)
    ref = same_model_photo(db, sku, match)
    if not ref and match.matched and not skip_crawled_ref:
        ref = product_image.reference_for_spu(db, match.spu.id)
        if not ref:
            product_image.request_for_spu(db, match.spu)
    if not ref and not _text_to_image_supported():
        raise ValueError("这个货没有商品图、也没有同款实拍图,当前生图供应商又不支持文生图"
                         "(需 REDRAW_PROVIDER=apinebula)," + _RETRY_HINT)
    subject = " ".join(x for x in ((hint or "").strip()[:20], _product_subject(sku, match)) if x)
    prompt = build_prompt(sku, subject or None)
    if not prompt:
        raise ValueError("这个货没有商品图,品牌、型号、商品名也都是空的,没法自动生成主图," + _RETRY_HINT)
    # 参考图要能直接下载(私有桶):给签名链接,生图几分钟内就用掉,够用
    source = sign_media_payload([ref])[0] if ref else ""
    job = AiRedrawJob(sku_code=sku.sku_code, source_image_url=source,
                      prompt=prompt + (_REFERENCE_SUFFIX if ref else ""), status="PENDING")
    db.add(job)
    # 先落库再投递:redraw_worker 在别的线程按 id 查库,没提交它就查不到,这边会一直等一张不会来的图
    db.commit()
    redraw_worker.enqueue(job.id)
    how = ("按型号文生图(待人确认)" if not ref else
           "照图片爬虫参考图重绘(待人确认)" if needs_confirm(job) else "照同款实拍图重绘")
    logger.info("手动上架缺图,%s: sku=%s job=%s", how, sku.sku_code, job.id)
    return job


async def publish_or_wait_for_image(db: Session, sku: Sku, info: SkuListingInfo,
                                    sale_shop_ids: list[str] | None) -> tuple[list[SkuShopListing], bool]:
    """手动上架入口。返回 (店铺行, 是否在等 AI 主图)。有图照常下发;没图先生图,出图后由
    advance_waiting 接着上架;图是文生图、还没人确认 → 店铺挂着等确认,不下发。"""
    if info.ai_image_unconfirmed and has_images(info, sku):
        job = _job_of_unconfirmed_image(db, sku, info)
        if job is None:
            raise ValueError("这个货的主图是 AI 生成的、还没确认,请在上架页确认后再上架")
        return await _mark_waiting(db, sku, info, sale_shop_ids, job.id), True
    if not has_images(info, sku):
        url = latest_ai_image(db, sku.sku_code)
        if url:
            info.images = [url]
            db.commit()
        else:
            drawn = _latest_text_to_image(db, sku.sku_code)
            if drawn:
                # 之前文生图出过一张:不再花钱重画,拿它等人确认
                info.images = [strip_oss_signature(drawn.result_url)]
                info.ai_image_unconfirmed = True
                return await _mark_waiting(db, sku, info, sale_shop_ids, drawn.id), True
            job = _inflight_ai_job(db, sku.sku_code) or _submit_ai_job(db, sku)
            return await _mark_waiting(db, sku, info, sale_shop_ids, job.id), True
    return await gc_publish_shops(db, sku, info, sale_shop_ids), False


def _latest_text_to_image(db: Session, sku_code: str) -> AiRedrawJob | None:
    return (
        db.query(AiRedrawJob)
        .filter(AiRedrawJob.sku_code == sku_code, AiRedrawJob.status == "SUCCEEDED",
                AiRedrawJob.result_url.isnot(None),
                (AiRedrawJob.source_image_url == "")
                | AiRedrawJob.source_image_url.contains(product_image.REF_MARKER))
        .order_by(AiRedrawJob.created_at.desc())
        .first()
    )


def _job_of_unconfirmed_image(db: Session, sku: Sku, info: SkuListingInfo) -> AiRedrawJob | None:
    """上架信息里那张待确认的 AI 图是哪个生图任务出的(店铺行要记着它才算「在等」)。"""
    want = strip_oss_signature((info.images or [""])[0])
    jobs = (db.query(AiRedrawJob)
            .filter(AiRedrawJob.sku_code == sku.sku_code, AiRedrawJob.status == "SUCCEEDED")
            .order_by(AiRedrawJob.created_at.desc()).all())
    return next((j for j in jobs if strip_oss_signature(j.result_url or "") == want), None)


def regenerate(db: Session, sku: Sku, info: SkuListingInfo, hint: str = "") -> AiRedrawJob:
    """人觉得 AI 图不对:清掉它、再生成一张(可补一句品类),在等的店铺改等新图。"""
    waiting = db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id,
                                              SkuShopListing.ai_image_job_id.isnot(None)).all()
    if not waiting:
        raise ValueError("没有在等主图的店铺,先点上架")
    if info.ai_image_unconfirmed:
        info.images = []
        info.ai_image_unconfirmed = False
    prev = db.get(AiRedrawJob, waiting[0].ai_image_job_id)
    job = _submit_ai_job(db, sku, hint, skip_crawled_ref=bool(prev and prev.source_image_url
                                                              and product_image.REF_MARKER in prev.source_image_url))
    for r in waiting:
        r.ai_image_job_id = job.id
        r.last_error = None
    db.commit()
    return job


def confirm(db: Session, info: SkuListingInfo) -> int:
    """人看过了、AI 图是对的:去掉待确认,下一轮后台就把在等的店铺下发。返回在等的店铺数。"""
    if not info.ai_image_unconfirmed:
        raise ValueError("没有待确认的 AI 主图")
    info.ai_image_unconfirmed = False
    db.commit()
    return (db.query(SkuShopListing)
            .filter(SkuShopListing.sku_id == info.sku_id, SkuShopListing.ai_image_job_id.isnot(None))
            .count())


async def _mark_waiting(db: Session, sku: Sku, info: SkuListingInfo,
                        sale_shop_ids: list[str] | None, job_id: str) -> list[SkuShopListing]:
    """目标店铺(与正式上架同一套挑法,含防发错号软闸)先置「上架中」,记下在等的生图任务。"""
    targets = await _resolve_targets(db, sku, sale_shop_ids)
    rows: list[SkuShopListing] = []
    for shop, aid in targets:
        row = (
            db.query(SkuShopListing)
            .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == shop.id)
            .first()
        )
        if row and row.publish_status == ShopListingStatus.LISTING and row.gc_job_id:
            continue   # 已经在下发途中,别把它的作业号冲掉
        if not row:
            row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, publish_status=ShopListingStatus.PENDING)
            db.add(row)
        row.gc_account_id = aid
        row.gc_job_id = None
        row.ai_image_job_id = job_id
        row.publish_status = ShopListingStatus.LISTING
        row.last_error = None
        rows.append(row)
    if not rows:
        raise ValueError("所选店铺已在架或已售出,无需重复上架")
    info.status = ListingInfoStatus.PUBLISHING
    db.commit()
    return rows


def _job_outcome(db: Session, job_ids: set[str]) -> tuple[AiRedrawJob | None, str | None]:
    """(出好图的任务, 失败原因);两个都是 None = 还在生成。"""
    jobs = [db.get(AiRedrawJob, j) for j in job_ids]
    for j in jobs:
        if j and j.status == "SUCCEEDED" and j.result_url:
            return j, None
    now = datetime.utcnow()
    for j in jobs:
        if j and j.status in ("PENDING", "RUNNING") and now - (j.created_at or now) <= JOB_TIMEOUT:
            return None, None
    j = next((x for x in jobs if x), None)
    if j is None:
        why = "生成主图的任务不见了"
    elif j.status == "FAILED":
        why = f"AI 生成主图失败({(j.error_message or '未知原因')[:80]})"
    else:
        why = "AI 生成主图超时"
    return None, f"{why}," + _RETRY_HINT


def _fail(rows: list[SkuShopListing], why: str) -> None:
    for r in rows:
        r.publish_status = ShopListingStatus.FAILED
        r.last_error = f"[image] {why}"
        r.ai_image_job_id = None


async def advance_waiting(db: Session, *, publish=gc_publish_shops) -> int:
    """推进所有在等 AI 主图的店铺行,返回这一轮了结(下发或失败)的行数。"""
    waiting = db.query(SkuShopListing).filter(SkuShopListing.ai_image_job_id.isnot(None)).all()
    by_sku: dict[str, list[SkuShopListing]] = {}
    for r in waiting:
        by_sku.setdefault(r.sku_id, []).append(r)

    settled = 0
    for sku_id, rows in by_sku.items():
        sku = db.get(Sku, sku_id)
        info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku_id).first() if sku else None
        if sku is None or info is None:
            _fail(rows, "货或上架信息已不存在")
            db.commit()
            settled += len(rows)
            continue

        if info.ai_image_unconfirmed and has_images(info, sku):
            continue                     # 文生图的主图在等人确认
        url = None
        if not has_images(info, sku):   # 等图期间人工传了实拍图就不等了
            job, why = _job_outcome(db, {r.ai_image_job_id for r in rows})
            if why:
                _fail(rows, why)
                db.commit()
                settled += len(rows)
                continue
            if job is None:
                continue                 # 还在生成,下一轮再看
            url = strip_oss_signature(job.result_url)
            info.images = [url]
            if needs_confirm(job):
                # 凭型号名文生图的可能猜错品类,照爬虫图重绘的参考图可能不是这件东西:先给人确认,不下发
                info.ai_image_unconfirmed = True
                db.commit()
                logger.info("AI 主图(文生图/爬虫参考)已出,等人确认 sku=%s", sku.sku_code)
                continue

        row_ids = [r.id for r in rows]
        shop_ids = [r.sale_shop_id for r in rows]
        for r in rows:
            r.ai_image_job_id = None
        try:
            await publish(db, sku, info, shop_ids)
        except Exception as exc:  # noqa: BLE001 - 群控拒收/不可达:这几行记失败,别的货照常推进
            db.rollback()
            rows = db.query(SkuShopListing).filter(SkuShopListing.id.in_(row_ids)).all()
            if url:
                info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku_id).first()
                info.images = [url]      # 图是好的,留着,下次上架直接用
            for r in rows:
                r.publish_status = ShopListingStatus.FAILED
                r.last_error = f"[publish] {exc}"
                r.ai_image_job_id = None
            db.commit()
            settled += len(rows)
            logger.warning("出图后上架失败 sku=%s: %s", sku.sku_code, exc)
            continue
        # 等图期间店铺被停用/解绑的,正式下发时会被挑掉,别让它们一直挂在「上架中」
        left = (
            db.query(SkuShopListing)
            .filter(SkuShopListing.id.in_(row_ids), SkuShopListing.gc_job_id.is_(None),
                    SkuShopListing.publish_status == ShopListingStatus.LISTING)
            .all()
        )
        if left:
            _fail(left, "店铺已停用或解绑,没有上架")
            db.commit()
        settled += len(rows)
        logger.info("AI 主图已出,接着上架 sku=%s 店铺 %d 个", sku.sku_code, len(rows))
    return settled


def _tick() -> int:
    """一轮:独立会话 + 具名锁(两个 worker 只跑一份,不然出图后会各下发一次、挂两份)。"""
    from app.database import SessionLocal
    from app.services.auto_listing.worker import _batch_lock

    db = SessionLocal()
    try:
        with _batch_lock(db, LOCK_KEY) as got:
            if not got:
                return 0
            return asyncio.run(advance_waiting(db))
    finally:
        db.close()


async def run_loop() -> None:
    """常驻协程,ERP 启动时拉起(同自动上架 worker、上架对账)。每轮丢线程里跑:下发要起临时事件循环。"""
    logger.info("手动上架 AI 主图兜底已启动:每 %ss 看一轮在等图的店铺", POLL_SECONDS)
    while True:
        try:
            n = await asyncio.to_thread(_tick)
            if n:
                logger.info("AI 主图兜底:了结 %d 个店铺行", n)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 兜底的东西自己不能把主进程带崩
            logger.exception("AI 主图兜底一轮异常,下一轮继续: %s", exc)
        await asyncio.sleep(POLL_SECONDS)
