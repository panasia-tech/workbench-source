"""经群控(真机)做上下架。

**异步语义**:建作业后目标店铺先置「处理中」,真正的 LISTED/DELISTED
由 sync_gc_publish_status 依 gc 上架账本(Listing)回写。gc 上架 = 建 publish_batch 作业
→ 调度器分钟级驱动真机 → 回读标题落 gc Listing(LIVE/UNCERTAIN)。

店铺 = gc 账号镜像(shop_sync.sync_gc_shops 全自动:新账号建店、未绑老店按名认领),
发布只面向 gc_account_id 非空的店铺;账号须已在群控绑好设备(手机开机自检自动完成),
没绑设备直接报错,不静默跳过。
"""

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.enums import ListingInfoStatus, ShopListingStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing
from app.services.gc_bridge import client as gc
from app.services.gc_bridge.assembler import build_publish_spec
from app.services.gc_bridge.shop_sync import sync_gc_shops

# gc Listing.status → ERP ShopListingStatus(发布回写)
_GC_LIVE = "LIVE"
_GC_DELISTED = "DELISTED"
# 链接焕新删了旧链接、又不再重发（焕新途中货卖了/被下架了）。对店铺来说和下架一样：不在架了。
_GC_DELETED = "DELETED"

_SKIP_PUBLISH_STATUSES = frozenset({ShopListingStatus.LISTED, ShopListingStatus.SOLD})


async def _resolve_targets(db: Session, sku: Sku, sale_shop_ids: list[str] | None):
    """目标店铺(启用 + 已绑 gc 账号 + 未在架/未售)→ [(shop, gc_account_id)]。

    先跑店铺镜像同步(新账号建店/认领老店),故「手机上报昵称 → 自动注册 → 自动建店
    → 可发布」全链路无需人工绑定;gc 不可达时退化为 DB 已有镜像。

    防发错号(软闸):设备**当前实际登录**的闲鱼(device.reported_nick)若与目标账号不符则拒发。
    reported_nick 为空(真机昵称读取未校准/未上报)时**放行**,不回退现有绑定流程——
    只堵「明确知道设备登着别的号」这种账号轮换后的串号,不误伤未知态。
    """
    try:
        await sync_gc_shops(db)
    except Exception:
        pass
    shops = (
        db.query(SaleShop)
        .filter(SaleShop.enabled.is_(True), SaleShop.gc_account_id.isnot(None))
        .order_by(SaleShop.sort_order, SaleShop.code)
        .all()
    )
    if sale_shop_ids is not None:
        if not sale_shop_ids:
            raise ValueError("请至少选择一个店铺")
        idset = set(sale_shop_ids)
        shops = [s for s in shops if s.id in idset]
        if not shops:
            raise ValueError("所选店铺未绑定群控账号(等自动同步,或到群控绑定页核对)")
    if not shops:
        raise ValueError("无已绑定群控账号的店铺(等手机上线自动注册建店)")

    devices = await gc.list_devices()
    dev_by_id = {d.get("id"): d for d in devices}

    targets: list[tuple[SaleShop, str]] = []
    for shop in shops:
        row = (
            db.query(SkuShopListing)
            .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == shop.id)
            .first()
        )
        if row and row.publish_status in _SKIP_PUBLISH_STATUSES:
            continue
        # 显式绑定:群控账号为真源,ERP 闲鱼账号名不参与解析
        acc = await gc.get_account(shop.gc_account_id)
        if not acc:
            raise ValueError(f"店铺「{shop.label}」绑定的群控账号已不存在,请重新绑定")
        nick = acc.get("nick") or ""
        if not acc.get("device_id"):
            raise ValueError(f"群控账号「{nick}」未绑定设备,无法上架")
        reported = (dev_by_id.get(acc["device_id"]) or {}).get("reported_nick")
        if reported and reported != nick:
            raise ValueError(
                f"店铺「{shop.label}」的设备当前登录「{reported}」,与账号「{nick}」不符,"
                "已拒绝发布以防发错号;请在群控核对该机登录的闲鱼账号"
            )
        targets.append((shop, acc["id"]))
    return targets


def _resolve_worry_free(cell, shop) -> bool:
    """无忧卖两层解析:格子覆盖(SkuShopListing.worry_free_sell)→ 账号默认(SaleShop.worry_free_sell)→ False。"""
    if cell is not None and cell.worry_free_sell is not None:
        return bool(cell.worry_free_sell)
    return bool(getattr(shop, "worry_free_sell", False))


def _shop_row(db: Session, sku: Sku, shop: SaleShop) -> SkuShopListing:
    row = (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == shop.id)
        .first()
    )
    if not row:
        row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, publish_status=ShopListingStatus.PENDING)
        db.add(row)
    return row


async def _publish_approved(db: Session, sku: Sku, info: SkuListingInfo | None, targets) -> list[SkuShopListing]:
    """开了上架审批：每个号发自己批过的价和图，一个号一个作业（内容各不相同，不能一份扇出）。

    没批过的店铺不发，原因写在店铺行上；一个都发不了就报错，让人知道卡在哪。
    """
    from app.services import listing_approval as la

    approvals = la.current_by_shop(db, sku.id)
    ready, blocked = [], []
    for shop, aid in targets:
        approval = approvals.get(shop.id)
        why = la.problem_for_publish(db, sku, approval)
        if why:
            blocked.append((shop, why))
        else:
            ready.append((shop, aid, approval))
    for shop, why in blocked:
        row = _shop_row(db, sku, shop)
        if row.publish_status not in _SKIP_PUBLISH_STATUSES and not row.gc_job_id:
            row.last_error = why
    if not ready:
        db.commit()
        detail = "；".join(f"{shop.label}：{why}" for shop, why in blocked[:5])
        raise ValueError(f"没有能发的店铺（上架审批）：{detail}")

    rows: list[SkuShopListing] = []
    for shop, aid, approval in ready:
        row = _shop_row(db, sku, shop)
        spec = la.apply_to_spec(
            build_publish_spec(sku, info, confirm_publish=settings.gc_publish_confirm,
                               worry_free_sell=_resolve_worry_free(row, shop)),
            approval,
        )
        job = await gc.create_publish_job(sku.sku_code, [aid], spec, source="ERP")
        row.gc_job_id = job.get("id")
        row.gc_account_id = aid
        row.listing_approval_id = approval.id
        row.publish_status = ShopListingStatus.LISTING
        row.last_error = None
        rows.append(row)
        # 每建一单就落库：后面某个号建单失败，前面已经建出去的也要记着，免得重发
        db.commit()
    if info:
        info.status = ListingInfoStatus.PUBLISHING
    db.commit()
    return rows


async def _publish_shop_images(db: Session, sku: Sku, info: SkuListingInfo | None, targets,
                               shop_images: dict[str, list[str]]) -> list[SkuShopListing]:
    """员工给每个店铺挑了不同的图:一个号一个作业,图记在店铺行上,链接焕新重发也用它。"""
    from app.services import shop_images as si
    from app.services.oss_media import sign_oss_publish_image_url

    chosen = si.validate(db, sku, shop_images, [shop.id for shop, _ in targets])
    rows: list[SkuShopListing] = []
    for shop, aid in targets:
        row = _shop_row(db, sku, shop)
        spec = build_publish_spec(sku, info, confirm_publish=settings.gc_publish_confirm,
                                  worry_free_sell=_resolve_worry_free(row, shop))
        spec["images"] = [u for u in (sign_oss_publish_image_url(x) for x in chosen[shop.id]) if u]
        job = await gc.create_publish_job(sku.sku_code, [aid], spec, source="ERP")
        row.gc_job_id = job.get("id")
        row.gc_account_id = aid
        row.images = chosen[shop.id]
        row.publish_status = ShopListingStatus.LISTING
        row.last_error = None
        rows.append(row)
        # 每建一单就落库：后面某个号建单失败，前面已经建出去的也要记着，免得重发
        db.commit()
    if info:
        info.status = ListingInfoStatus.PUBLISHING
    db.commit()
    return rows


async def gc_publish_shops(
    db: Session, sku: Sku, info: SkuListingInfo | None, sale_shop_ids: list[str] | None = None,
    shop_images: dict[str, list[str]] | None = None,
) -> list[SkuShopListing]:
    """真机上架:解析目标店铺→gc账号,建 publish_batch 作业,店铺置 LISTING(待回写 LISTED)。
    shop_images:员工按店铺挑的图(shop_id → 图),给了就每个号发自己那组。"""
    from app.services.listing_approval import approval_required

    targets = await _resolve_targets(db, sku, sale_shop_ids)
    if not targets:
        raise ValueError("所选店铺已在架或已售出,无需重复上架")
    if approval_required(db):
        return await _publish_approved(db, sku, info, targets)
    if shop_images is not None:
        return await _publish_shop_images(db, sku, info, targets, shop_images)

    spec = build_publish_spec(sku, info, confirm_publish=settings.gc_publish_confirm)
    # 无忧卖按账号解析:格子(SkuShopListing.worry_free_sell)覆盖 → 账号默认(SaleShop.worry_free_sell)→ False。
    wf_by_account: dict[str, bool] = {}
    for shop, aid in targets:
        cell = (
            db.query(SkuShopListing)
            .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == shop.id)
            .first()
        )
        wf_by_account[aid] = _resolve_worry_free(cell, shop)
    # spec 不合法(缺图/隐私图/无效价)时 gc 返回 400 → GcBridgeError,上层翻 400
    job = await gc.create_publish_job(sku.sku_code, [aid for _, aid in targets], spec,
                                      source="ERP", worry_free_by_account=wf_by_account)
    job_id = job.get("id")

    rows: list[SkuShopListing] = []
    for shop, aid in targets:
        row = (
            db.query(SkuShopListing)
            .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == shop.id)
            .first()
        )
        if not row:
            row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id,
                                 publish_status=ShopListingStatus.PENDING)
            db.add(row)
        row.gc_job_id = job_id
        row.gc_account_id = aid
        row.images = None   # 这次发的是公用那组图,以前单独挑的作废
        row.publish_status = ShopListingStatus.LISTING   # 异步:LISTED 由 sync_gc_publish_status 回写
        row.last_error = None
        rows.append(row)
    if info:
        info.status = ListingInfoStatus.PUBLISHING
    db.commit()
    return rows


async def gc_delist_shops(
    db: Session, sku: Sku, sale_shop_ids: list[str] | None = None
) -> list[SkuShopListing]:
    """真机下架:建 delist_sku 作业,店铺行打上作业号 = 「下架中」(状态保留 LISTED,回写确认后转 DELISTED)。

    - 选了店铺:只把这几家店铺行上的 gc 账号交给群控,群控只下这些账号上的链接,没选的店不动;
      已经在下架中的不重复下。两家店挂同一个 gc 账号 = 闲鱼上同一条链接,没勾的那家会跟着下掉,
      一起标下架中,免得 ERP 里它还显示在架。
    - 不选(下架全部 / 售出后全网下架 sold_sync):不传账号,群控照旧对该 SKU 全账号在架 listing 下架。
    """
    q = db.query(SkuShopListing).filter(
        SkuShopListing.sku_id == sku.id, SkuShopListing.publish_status == ShopListingStatus.LISTED
    )
    if sale_shop_ids is not None:
        if not sale_shop_ids:
            raise ValueError("请至少选择一个店铺")
        q = q.filter(SkuShopListing.sale_shop_id.in_(sale_shop_ids))
    rows = q.all()
    if not rows:
        if sale_shop_ids is not None:
            raise ValueError("所选店铺均非在架状态,无法下架")
        return []

    account_ids = None   # 不传 = 群控全账号下架
    if sale_shop_ids is not None:
        idle = [r for r in rows if not r.gc_job_id]
        if not idle:
            raise ValueError("所选店铺正在下架中,不用重复提交")
        account_ids = sorted({r.gc_account_id for r in idle if r.gc_account_id})
        if not account_ids:
            # 行上没有 gc 账号 = 这条链接不是群控发的,群控那边对不上;打了标记回写也永远收不了
            raise ValueError("所选店铺的这件货不是群控发的,群控下不了")
        rows = (
            db.query(SkuShopListing)
            .filter(SkuShopListing.sku_id == sku.id,
                    SkuShopListing.publish_status == ShopListingStatus.LISTED,
                    SkuShopListing.gc_job_id.is_(None),
                    SkuShopListing.gc_account_id.in_(account_ids))
            .all()
        )

    job = await gc.create_delist_job(sku.sku_code, source="ERP", account_ids=account_ids)
    job_id = job.get("id")
    for row in rows:
        row.gc_job_id = job_id          # 下架中标记;状态保留 LISTED,回写确认后转 DELISTED
        row.last_error = None
    db.commit()
    return rows


_SETTLED = {"SUCCESS", "FAILED", "CANCELLED"}
# 群控取消排队中的下架、由新作业接手时写的错误前缀(后面跟新作业号),见 groupcontrol-server jobs._take_over_queued_delists
_TAKEN_OVER = "由新的下架作业接手"
# 多久没动才算「不是还在扇出途中」。派发到执行端最多几分钟,给到一天是为了
# 宁可晚判也不误判——这一行判错的代价是有人以为没发、去重发一次。
_STALE_HOURS = 24


def _job_settled(tasks: list[dict]) -> bool:
    """这个作业扇出的任务是不是都已经有结论了。空列表不算——查不到 ≠ 都跑完了。"""
    return bool(tasks) and all((t.get("status") or "") in _SETTLED for t in tasks)


def _stale(row) -> bool:
    updated = getattr(row, "updated_at", None)
    return bool(updated and (datetime.utcnow() - updated) > timedelta(hours=_STALE_HOURS))


async def sync_gc_publish_status(db: Session, sku: Sku) -> int:
    """回写:按 gc 上架账本把「处理中」的 SkuShopListing 收敛到 LISTED/DELISTED/FAILED。

    对每个带 gc_job_id 的店铺行:查 gc Listing(sku×该店铺 gc 账号)。
    上架中 = LISTING + gc_job_id;下架中 = LISTED + gc_job_id(gc_delist_shops 打的,只有它会这么打)。
    - gc LIVE  → LISTED(清 gc_job_id 表示已收敛)。下架中的行除外:下架任务跑完之前账本一直是 LIVE,
      拿它当上架确认清掉标记,店铺就又显示在架、还能再点一次下架——它走下面的任务级判定;
    - gc DELISTED / DELETED(焕新删了不再发)→ DELISTED;
    - 账本未确认时查该 job 扇出到**本账号**的任务:FAILED/CANCELLED → 上架中的行置 FAILED
      (下架中的行保留 LISTED = 恢复在架),记 last_error 并清 gc_job_id;下架任务 SUCCESS → DELISTED;
      上架任务 SUCCESS 但账本 UNCERTAIN → 不改状态,记 last_error 留人工对账,勿盲重发。
    返回本次收敛条数。轮询式(供定时任务/接口触发);gc 侧后续可改主动回调。
    """
    rows = (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == sku.id, SkuShopListing.gc_job_id.isnot(None))
        .all()
    )
    changed = 0
    dirty = False
    tasks_by_job: dict[str, list[dict]] = {}
    for row in rows:
        if not row.gc_account_id:
            continue
        listings = await gc.list_listings(sku.sku_code, row.gc_account_id)
        gc_status = listings[0].get("status") if listings else None
        delisting = row.publish_status == ShopListingStatus.LISTED   # 下架中(见上)
        if gc_status == _GC_LIVE and not delisting:
            row.publish_status = ShopListingStatus.LISTED
            row.gc_job_id = None
            changed += 1
        elif gc_status in (_GC_DELISTED, _GC_DELETED):
            if row.publish_status != ShopListingStatus.DELISTED:
                row.publish_status = ShopListingStatus.DELISTED
                row.delisted_at = datetime.utcnow()
                changed += 1
            row.gc_job_id = None
        else:
            # 账本未确认:gc 发布任务失败时不长账本行,只查账本会让行永远卡「上架中」
            # (08-30 实测:FAILED 任务无账本,sync 跳过 → 前端永远显示上架中)。
            # 须查 job 扇出到本账号的任务级状态做终结收敛。
            # 下架中的行账本还是 LIVE 也走这里:下架任务没结论之前一直挂着「下架中」。
            if row.gc_job_id not in tasks_by_job:
                try:
                    tasks_by_job[row.gc_job_id] = await gc.list_tasks(row.gc_job_id)
                except Exception:
                    tasks_by_job[row.gc_job_id] = None   # gc 不可达:本轮跳过,下轮再试
            tasks = tasks_by_job[row.gc_job_id]
            if tasks is None:
                continue
            task = next((t for t in tasks if t.get("account_id") == row.gc_account_id), None)
            tstatus = (task or {}).get("status") or ""
            taken = ((task or {}).get("error") or "").startswith(_TAKEN_OVER + ":")
            if tstatus == "CANCELLED" and taken and delisting:
                # 排队中的下架被新的下架作业接手(售出联动 / 群控后台手动下架撞在一起):改盯新作业。
                # 原来当成取消清掉作业号、行留在架,新作业真下掉了 ERP 也不再收,一直显示在架
                row.gc_job_id = (task.get("error") or "").split(":", 1)[1].strip() or None
                dirty = True
            elif tstatus in ("FAILED", "CANCELLED"):
                reason = ((task or {}).get("error") or "").strip() or "群控任务失败"
                step = (task or {}).get("failed_step") or "-"
                row.last_error = f"[{step}] {reason}"[:200]
                if row.publish_status == ShopListingStatus.LISTING:
                    row.publish_status = ShopListingStatus.FAILED
                    changed += 1
                # 下架中(LISTED)失败的行保留 LISTED,只记错误
                row.gc_job_id = None
                dirty = True
            elif tstatus == "SUCCESS" and delisting:
                # 下架任务成功、账本还没跟上:群控先落任务状态、另开事务记账本,中间有空档,
                # 记账那步失败账本就一直停在 LIVE。下架流程自己核过商品已不在卖,按任务结论收。
                # 不能走下面上架那句「待对账」——那句是叫人别重发的,还会被算进人工对账数。
                row.publish_status = ShopListingStatus.DELISTED
                row.delisted_at = datetime.utcnow()
                row.gc_job_id = None
                changed += 1
            elif tstatus == "SUCCESS":
                # 任务成功但账本 UNCERTAIN:可能真发了也可能没发,不改状态,提示人工对账。
                # 这条有意不自动收敛——猜成 FAILED 会有人去重发,同一件货在闲鱼上挂两份。
                note = "发布结果待对账(gc 账本未确认),请勿直接重发"
                if row.last_error != note:
                    row.last_error = note
                    dirty = True
            elif task is None and (not tasks or _job_settled(tasks)) and _stale(row):
                # 作业里**压根没有本账号的任务**:扇出时这个店铺就被跳过了(账号当时冻结/
                # 被排除),等于这一单从没派出去。它不会自己变,不判就永远挂在「上架中」。
                #
                # 两道闸防误杀:作业里其它任务必须都已终结(不是还在扇出途中),
                # 且这行已经很久没动(不是刚建出来还没排到)。没发出去 = 没有重发风险,
                # 所以这里判 FAILED 是安全的,与上面 UNCERTAIN 那条性质不同。
                # 作业一个任务都没有也算(下架时这些链接全在别的作业里跑着,新作业扇出 0 个):
                # 原来空列表不算「都跑完了」,这行永远挂「下架中」,售出同步看它带着作业号也不再建下架。
                # 清掉作业号、行留在架,售出同步下一轮会重建下架。
                row.last_error = ("这次下架没派出去，等重新下架" if delisting
                                  else "群控作业里没有这个店铺的任务，本次派发未生效")
                if row.publish_status == ShopListingStatus.LISTING:
                    row.publish_status = ShopListingStatus.FAILED
                    changed += 1
                row.gc_job_id = None
                dirty = True
            # 其它(在途/作业还没扇完):不动,下轮再收敛
    if changed or dirty:
        db.commit()
    return changed
