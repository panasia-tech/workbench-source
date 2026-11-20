"""Job 扇出 + Listing 记账 + Job 聚合状态。

一个业务意图(Job)→ 扇出成 N 个 Task(每账号/每 listing 一个)。
Task 约定:ref_type='sku', ref_id=sku;发布/下架/改价的关联信息放 spec。
Task 跑完由 runner 调 on_task_result 做账本记账 + Job 聚合。
"""

import hashlib
import logging
import re
from datetime import datetime, time as dtime, timedelta

from sqlalchemy import and_, func, or_

from app import chat_media
from app.config import settings
from app.database import SessionLocal
from app.notify import maybe_notify_new_messages
from app.publish_spec import validate_publish_spec
from app.models import (
    REFRESH_TASK_SOURCE,
    REFRESH_UNDO_SOURCE,
    Account,
    AccountStatus,
    ChatMessage,
    Conversation,
    Device,
    Job,
    JobStatus,
    JobType,
    Listing,
    ListingStatus,
    RiskState,
    Task,
    TaskStatus,
)

logger = logging.getLogger("gc.jobs")

# 一个账号一个 SKU 视为已占用的 listing 状态(防重复发布)
_OCCUPYING = (ListingStatus.LIVE, ListingStatus.UNCERTAIN, ListingStatus.PENDING_REPUBLISH)


# ==================== 扇出 ====================
def create_publish_batch(db, sku: str, account_ids: list[str], spec: dict, source: str = "MANUAL",
                         worry_free_by_account: dict[str, bool] | None = None) -> Job:
    """把某 SKU 发布到多个账号。已有占用 listing 的账号跳过(防重发)。

    扇出前先校验 PublishSpec(缺图/隐私图/库位图/无效价一律拒),把脏数据拦在建任务之前,
    避免既扇出又发到闲鱼才发现。校验不过抛 ValueError,API 层翻 400。
    """
    validate_publish_spec(spec)
    job = Job(job_type=JobType.PUBLISH_BATCH, source=source, ref_type="sku", ref_id=sku, spec=spec)
    db.add(job)
    db.flush()
    n = 0
    for acc_id in account_ids:
        exists = db.query(Listing).filter(
            Listing.sku == sku, Listing.account_id == acc_id,
            Listing.status.in_(_OCCUPYING),
        ).first()
        if exists:
            logger.info("跳过重发:sku=%s account=%s 已有 %s", sku, acc_id, exists.status)
            continue
        # 无忧卖按账号覆盖:ERP 侧已把「格子覆盖→账号默认→False」解析成 map;缺账号回落 spec 默认。
        task_spec = spec
        if worry_free_by_account is not None:
            task_spec = {**spec, "worry_free_sell":
                         bool(worry_free_by_account.get(acc_id, spec.get("worry_free_sell", False)))}
        db.add(Task(
            job_id=job.id, account_id=acc_id, task_type="goods_publish",
            status=TaskStatus.PENDING, spec=task_spec, source=source,
            ref_type="sku", ref_id=sku,
        ))
        n += 1
    job.total = n
    db.commit()
    db.refresh(job)
    logger.info("publish_batch job=%s sku=%s 扇出 %d 个任务", job.id, sku, n)
    return job


def create_delist_sku(db, sku: str, source: str = "ERP", account_ids: list[str] | None = None) -> Job:
    """下架某 SKU 的在架 listing(LIVE/UNCERTAIN)。

    account_ids 不传 = 全账号(库存清零 / ERP 售出后全网下架);传了只下这些账号上的
    (ERP「下架所选店铺」),记进 job.spec——焕新据此判断这单下架管不管自己那个号(_refresh_blocked)。
    """
    job = Job(job_type=JobType.DELIST_SKU, source=source, ref_type="sku", ref_id=sku,
              spec={"account_ids": account_ids} if account_ids is not None else None)
    db.add(job)
    db.flush()
    q = db.query(Listing).filter(
        Listing.sku == sku, Listing.status.in_((ListingStatus.LIVE, ListingStatus.UNCERTAIN)),
    )
    if account_ids is not None:
        q = q.filter(Listing.account_id.in_(account_ids))
    lives = q.all()
    taken_over = _take_over_queued_delists(db, lives, job.id)
    lives = [lst for lst in lives if lst.id not in taken_over["in_flight"]]
    for lst in lives:
        db.add(Task(
            job_id=job.id, account_id=lst.account_id, task_type="goods_delist",
            status=TaskStatus.PENDING, source=source, ref_type="sku", ref_id=sku,
            # 名称+价格定位:title 主锚 + price 同名消歧(闲鱼卡片不显示 SKU，title_hint 基本不命中，仅兼容)
            spec={"item_id": lst.item_id, "listing_id": lst.id,
                  "title": lst.title, "price": lst.price, "title_hint": sku},
        ))
    job.total = len(lives)
    _stop_refresh_for(db, sku, reason="货要下架", account_ids=account_ids)
    db.flush()
    for old_job_id in taken_over["jobs"]:
        _aggregate_job(db, old_job_id)
    db.commit()
    db.refresh(job)
    logger.info("delist_sku job=%s sku=%s 扇出 %d 个下架任务(账号:%s)", job.id, sku, len(lives),
                "全部" if account_ids is None else ",".join(account_ids))
    return job


_DELIST_QUEUED = (TaskStatus.PENDING,)
_DELIST_IN_FLIGHT = (TaskStatus.DISPATCHED, TaskStatus.RUNNING, TaskStatus.WAITING)


TAKEN_OVER_PREFIX = "由新的下架作业接手"


def _take_over_queued_delists(db, lives: list[Listing], new_job_id: str) -> dict:
    """同一条链接已经有下架任务时不再叠一单(11-11:手动补的下架和 ERP 售出联动撞在一起)。

    - 还在排队(PENDING)的旧任务取消,由这单新作业接手;错误里写上新作业号,
      盯着旧作业的(ERP 店铺行、群控后台手动下架)照着改盯新的,不然以为下架取消了、再也不收;
    - 已经派出去/在跑的不动,这条链接这次不再扇出(跑完账本就变了,ERP 按账本收)。
    返回 {"in_flight": 跳过的 listing_id, "jobs": 被取消任务所在的作业 id}。
    """
    by_id = {lst.id: lst for lst in lives}
    out = {"in_flight": set(), "jobs": set()}
    if not by_id:
        return out
    rows = db.query(Task).filter(
        Task.task_type == "goods_delist",
        Task.account_id.in_({lst.account_id for lst in lives}),
        Task.status.in_(_DELIST_QUEUED + _DELIST_IN_FLIGHT),
    ).all()
    now = datetime.utcnow()
    for t in rows:
        lid = (t.spec or {}).get("listing_id")
        if lid not in by_id:
            continue
        if t.status in _DELIST_IN_FLIGHT:
            out["in_flight"].add(lid)
            continue
        t.status = TaskStatus.CANCELLED
        t.error = f"{TAKEN_OVER_PREFIX}:{new_job_id}"
        t.finished_at = now
        if t.job_id:
            out["jobs"].add(t.job_id)
    return out


def recode_listings(db, pairs: list[tuple]) -> int:
    """ERP 换了货号:账本跟着改,不然售出联动、下架、回写都按新货号找不到这些链接。

    pairs 按 ERP 换码先后排(同一件货可能换过两次),每项 (旧, 新) 或 (旧, 新, 换码时间 UTC);幂等。
    带了换码时间就只改那之前建的链接:旧货号后来又分给了别的货(06 月 sancg73→TMP-010,之后另一台 G73
    又叫 sancg73),ERP 每轮重放全部历史,不看时间会把后来那台的链接改走(11-11 首发错改 8 条)。
    货号不分大小写(ERP 里有小写的老货号)。
    """
    n = 0
    for p in pairs:
        old, new = p[0], p[1]
        at = p[2] if len(p) > 2 else None
        if not old or not new or old.upper() == new.upper():
            continue
        q = db.query(Listing).filter(func.upper(Listing.sku) == old.upper())
        if at is not None:
            q = q.filter(or_(Listing.created_at.is_(None), Listing.created_at <= at))
        n += q.update({Listing.sku: new}, synchronize_session=False)
    if n:
        db.commit()
        logger.info("账本换货号:%d 条", n)
    return n


def _stop_refresh_for(db, sku: str, reason: str, account_ids: list[str] | None = None) -> None:
    """要下架的货不能再被焕新重发上去。

    - 删完还没重发的(PENDING_REPUBLISH):闲鱼上已经没东西可下,直接记 DELETED;
    - 还没开跑的焕新任务(删/重发)取消。还在跑的拦不住——它们收尾时会看到这单下架作业,
      自己收手,刚发上去的会再删掉(_on_delete_ok / _on_republish_ok 里的 _refresh_blocked)。
    account_ids:只下了这几个号(ERP「下架所选店铺」)就只停这几个号上的焕新,别的号照常删了重发。
    """
    now = datetime.utcnow()
    waiting = db.query(Listing).filter(
        Listing.sku == sku, Listing.status == ListingStatus.PENDING_REPUBLISH)
    queued = db.query(Task).filter(
        Task.ref_id == sku, Task.source == REFRESH_TASK_SOURCE, Task.status == TaskStatus.PENDING)
    if account_ids is not None:
        waiting = waiting.filter(Listing.account_id.in_(account_ids))
        queued = queued.filter(Task.account_id.in_(account_ids))
    for lst in waiting.all():
        lst.status = ListingStatus.DELETED
        lst.last_synced_at = now
        logger.info("焕新收手:sku=%s account=%s 旧链接已删,%s,不再重发", sku, lst.account_id, reason)
    stopped = queued.all()
    for t in stopped:
        t.status = TaskStatus.CANCELLED
        t.error = f"{reason},焕新取消"
        t.finished_at = now
    if stopped:
        db.flush()
        for job_id in {t.job_id for t in stopped if t.job_id}:
            _aggregate_job(db, job_id)


def create_relist_sku(db, sku: str, source: str = "ERP") -> Job:
    """补货/人工:把某 SKU 所有已下架 listing 从仓库重新上架(全账号)。"""
    job = Job(job_type=JobType.RELIST_SKU, source=source, ref_type="sku", ref_id=sku)
    db.add(job)
    db.flush()
    offs = db.query(Listing).filter(
        Listing.sku == sku, Listing.status == ListingStatus.DELISTED,
    ).all()
    for lst in offs:
        db.add(Task(
            job_id=job.id, account_id=lst.account_id, task_type="goods_relist",
            status=TaskStatus.PENDING, source=source, ref_type="sku", ref_id=sku,
            # 名称+价格定位:title 主锚 + price 同名消歧(闲鱼卡片不显示 SKU，title_hint 基本不命中，仅兼容)
            spec={"item_id": lst.item_id, "listing_id": lst.id,
                  "title": lst.title, "price": lst.price, "title_hint": sku},
        ))
    job.total = len(offs)
    db.commit()
    db.refresh(job)
    logger.info("relist_sku job=%s sku=%s 扇出 %d 个重新上架任务", job.id, sku, len(offs))
    return job


def create_polish(db, account_ids: list, source: str = "MANUAL") -> Job:
    """账号级一键擦亮(刷曝光):每账号一个 goods_polish 任务,不改 Listing。"""
    job = Job(job_type=JobType.POLISH_ACCOUNT, source=source)
    db.add(job)
    db.flush()
    for acc_id in account_ids:
        db.add(Task(
            job_id=job.id, account_id=acc_id, task_type="goods_polish",
            status=TaskStatus.PENDING, source=source, spec={},
        ))
    job.total = len(account_ids)
    db.commit()
    db.refresh(job)
    logger.info("polish job=%s 扇出 %d 个擦亮任务", job.id, len(account_ids))
    return job


def create_reprice_batch(db, items: list[dict], source: str = "MANUAL") -> Job:
    """改价:items=[{listing_id, new_price}]。人工复核后下发。"""
    job = Job(job_type=JobType.REPRICE_BATCH, source=source)
    db.add(job)
    db.flush()
    n = 0
    for it in items:
        lst = db.get(Listing, it.get("listing_id"))
        if not lst:
            continue
        db.add(Task(
            job_id=job.id, account_id=lst.account_id, task_type="goods_reprice",
            status=TaskStatus.PENDING, source=source, ref_type="sku", ref_id=lst.sku,
            # 名称+(旧)价定位后改到 new_price:price 用改价前的现价(卡片显示的是旧价)
            spec={"item_id": lst.item_id, "listing_id": lst.id,
                  "title": lst.title, "price": lst.price, "title_hint": lst.sku,
                  "new_price": it.get("new_price")},
        ))
        n += 1
    job.total = n
    db.commit()
    db.refresh(job)
    return job


_INFLIGHT_STATUSES = (TaskStatus.PENDING, TaskStatus.DISPATCHED, TaskStatus.RUNNING, TaskStatus.WAITING)


def create_chat_scan(db, account_id: str, source: str = "SCHED") -> Job | None:
    """账号级扫会话:一个账号一个 chat_scan 任务,读回会话列表+消息落库。

    在途去重:若该账号已有未终结(PENDING/DISPATCHED/RUNNING/WAITING)的 chat_scan
    任务,直接跳过不重复建 —— 防止账号长期不派发(如不在 active_window 内、设备离线)
    时 last_op_at 从不刷新导致调度器节流失效、任务无限堆积。
    """
    inflight = db.query(Task).filter(
        Task.account_id == account_id, Task.task_type == "chat_scan",
        Task.status.in_(_INFLIGHT_STATUSES),
    ).first()
    if inflight:
        if source == "HINT":
            mark_chat_rescan(db, account_id, inflight)
        return db.get(Job, inflight.job_id) if inflight.job_id else None

    job = Job(job_type=JobType.CHAT_SCAN, source=source, ref_type="account", ref_id=account_id)
    db.add(job)
    db.flush()
    db.add(Task(
        job_id=job.id, account_id=account_id, task_type="chat_scan",
        status=TaskStatus.PENDING, source=source, ref_type="account", ref_id=account_id, spec={},
    ))
    job.total = 1
    db.commit()
    db.refresh(job)
    logger.info("chat_scan job=%s account=%s 扇出 1 个任务", job.id, account_id)
    return job


def mark_chat_rescan(db, account_id: str, inflight: Task | None = None) -> bool:
    """门铃响时这个号正在扫:那一单可能已经读过会话列表、漏掉这条新消息。
    给它记一笔「收尾后补扫」(_on_chat_scan_ok 看到就马上再建一单),不再干等下一轮周期扫描。

    还没派出去的(PENDING)不用记:它开跑时读到的列表里就有这条。
    """
    task = inflight or db.query(Task).filter(
        Task.account_id == account_id, Task.task_type == "chat_scan",
        Task.status.in_(_INFLIGHT_STATUSES),
    ).first()
    if task is None or task.status == TaskStatus.PENDING:
        return False
    if (task.spec or {}).get("rescan"):
        return True
    task.spec = {**(task.spec or {}), "rescan": True}   # 整个换掉,JSON 列原地改 ORM 看不出来
    db.commit()
    logger.info("chat_scan task=%s 正在跑,收尾后补扫一轮 account=%s", task.id, account_id)
    return True


def create_keepalive(db, account_id: str, source: str = "SCHED") -> Job | None:
    """账号级保活 + 登录体检(flow/web/keepalive_web.py)。同 chat_scan 一样在途去重:
    设备离线派不出去时不越堆越多。"""
    inflight = db.query(Task).filter(
        Task.account_id == account_id, Task.task_type == "keepalive",
        Task.status.in_(_INFLIGHT_STATUSES),
    ).first()
    if inflight:
        return None

    job = Job(job_type=JobType.KEEPALIVE, source=source, ref_type="account", ref_id=account_id)
    db.add(job)
    db.flush()
    db.add(Task(
        job_id=job.id, account_id=account_id, task_type="keepalive",
        status=TaskStatus.PENDING, source=source, ref_type="account", ref_id=account_id, spec={},
    ))
    job.total = 1
    db.commit()
    db.refresh(job)
    logger.debug("keepalive job=%s account=%s", job.id, account_id)
    return job


def create_sold_scan(db, account_id: str, source: str = "SCHED",
                     max_confirm: int | None = None, max_swipes: int | None = None) -> Job | None:
    """账号级售出巡检(flow/web/sold_scan_web.py)。spec 带本号带 item_id 的在架账本,流程拿「已售出」
    里的商品链接逐个对、开详情页确认。没有可对的在架链接就不建(白开一趟页面);同 chat_scan 在途去重。

    max_confirm / max_swipes 只给人工补查老成交用(已售出很多的号要多滚几页、一轮多确认几件)。"""
    inflight = db.query(Task).filter(
        Task.account_id == account_id, Task.task_type == "sold_scan",
        Task.status.in_(_INFLIGHT_STATUSES),
    ).first()
    if inflight:
        return None

    rows = db.query(Listing).filter(
        Listing.account_id == account_id,
        Listing.status.in_((ListingStatus.LIVE, ListingStatus.UNCERTAIN)),
        Listing.item_id.isnot(None),
    ).all()
    if not rows:
        return None
    spec = {
        "listings": [{"listing_id": x.id, "item_id": x.item_id, "title": x.title} for x in rows],
        "max_confirm": max_confirm or settings.sold_scan_max_confirm,
    }
    if max_swipes:
        spec["max_swipes"] = max_swipes
    job = Job(job_type=JobType.SOLD_SCAN, source=source, ref_type="account", ref_id=account_id)
    db.add(job)
    db.flush()
    db.add(Task(
        job_id=job.id, account_id=account_id, task_type="sold_scan",
        status=TaskStatus.PENDING, source=source, ref_type="account", ref_id=account_id, spec=spec,
    ))
    job.total = 1
    db.commit()
    db.refresh(job)
    logger.debug("sold_scan job=%s account=%s 账本 %d 条", job.id, account_id, len(rows))
    return job


def create_chat_reply(db, conversation_id: str, text: str, source: str = "MANUAL",
                      media: list[dict] | None = None, card: dict | None = None,
                      by_id: str | None = None, by_name: str | None = None) -> Job:
    """人工回复(1b):给会话归属账号建一个 chat_reply 任务,驱动设备进会话发文本。

    media = [{type, key}](chat_media.normalize_media 收过的)→ 发图片 / 视频;带 text 时图片发完再发文字。
    card 只记账给我们自己的聊天页显示,不发给买家。
    """
    conv = db.get(Conversation, conversation_id)
    if not conv:
        raise ValueError("会话不存在")
    text = (text or "").strip()
    if not text and not media:
        raise ValueError("回复内容为空")
    spec = {"conversation_id": conv.id, "peer_key": conv.peer_key, "text": text}
    if media:
        spec["media"] = list(media)
    if card:
        spec["card"] = dict(card)
    if by_id or by_name:
        # 谁回的（消息响应考核按它记，见 chat_sla.on_staff_reply）
        spec["by_id"], spec["by_name"] = by_id, by_name
    job = Job(job_type=JobType.CHAT_REPLY, source=source,
              ref_type="conversation", ref_id=conv.id)
    db.add(job)
    db.flush()
    db.add(Task(
        job_id=job.id, account_id=conv.account_id, task_type="chat_reply",
        status=TaskStatus.PENDING, source=source, ref_type="conversation", ref_id=conv.id,
        spec=spec,
    ))
    job.total = 1
    db.commit()
    db.refresh(job)
    logger.info("chat_reply job=%s conv=%s account=%s", job.id, conv.id, conv.account_id)
    return job


# ==================== 链接焕新(删掉重发)====================
class RefreshRejected(ValueError):
    """这条今天不焕新(状态/在途/额度),不是请求写错了。API 翻 409,ERP 记一笔跳过,第二天再来。"""


# 动一条链接的任务类型:焕新开单前,这条链接上不能有它们在跑
_LISTING_TASK_TYPES = ("goods_publish", "goods_delist", "goods_relist", "goods_reprice", "goods_delete")


def _cn_day_start_utc(now: datetime | None = None) -> datetime:
    """北京时间今天 00:00 对应的 UTC naive(库里存 naive UTC,额度按北京日界算,与 scheduler 一致)。"""
    cn = (now or datetime.utcnow()) + timedelta(hours=8)
    return datetime.combine(cn.date(), dtime.min) - timedelta(hours=8)


def _refresh_usable(db, acc: Account | None) -> str | None:
    """这个号能不能焕新:能返回 None,不能返回原因。"""
    if not acc or acc.status != AccountStatus.ACTIVE or acc.risk_state != RiskState.NORMAL:
        return "账号不可用或已冻结"
    dev = db.get(Device, acc.device_id) if acc.device_id else None
    if not dev or dev.kind != "browser":
        return "删链接只有网页版做得了,这个号不在浏览器上"
    return None


def refresh_room(db, acc: Account, now: datetime | None = None) -> int:
    """这个号今天还能再开几单焕新。两道上限取小:

    1. 焕新自己的日上限(listing_refresh_per_account_daily),给当天新入库的货留出发布额度;
    2. 账号日发布配额的剩余 = 配额 − 今天已发成功 − 在途的发布 − 在途的焕新删除(删完马上要发)。
       重发也是一次发布,配额是风控线;删了却因为配额满发不上去,链接就要空着过夜。配额 0 = 不限。
    """
    lo = _cn_day_start_utc(now)
    started = (
        db.query(func.count(Job.id))
        .join(Listing, Listing.id == Job.ref_id)
        .filter(Job.job_type == JobType.REFRESH_LISTING, Listing.account_id == acc.id,
                Job.created_at >= lo)
        .scalar()
    ) or 0
    room = settings.listing_refresh_per_account_daily - started
    quota = acc.daily_publish_quota or 0
    if quota > 0:
        published = (
            db.query(func.count(Task.id))
            .filter(Task.account_id == acc.id, Task.task_type == "goods_publish",
                    Task.status == TaskStatus.SUCCESS, Task.finished_at >= lo)
            .scalar()
        ) or 0
        inflight = (
            db.query(func.count(Task.id))
            .filter(Task.account_id == acc.id, Task.status.in_(_INFLIGHT_STATUSES),
                    or_(Task.task_type == "goods_publish",
                        and_(Task.task_type == "goods_delete",
                             Task.source == REFRESH_TASK_SOURCE)))
            .scalar()
        ) or 0
        room = min(room, quota - published - inflight)
    return max(room, 0)


def create_refresh_listing(db, listing_id: str, spec: dict, source: str = "ERP") -> Job:
    """链接焕新:在架满 N 天没卖掉的链接,删掉、用 ERP 刚组装的发布内容在同一账号重发。

    发布内容为什么要 ERP 现给、不用当初存下的 spec:那里面的商品图是 24 小时过期的 OSS 签名
    链接(生产库里每一条都过期了),7 天后拿去重发,执行端下载图必失败——而那时旧链接已经删了。
    所以内容在**删之前**就要到手并校验过(validate_publish_spec),不合格一条都不删。

    先删后发:先发会让同一账号同时挂两份同款(闲鱼查重复铺货),要是删那步再失败,一件货就
    挂成了两条能下单的链接。先删的代价只是中间几分钟不在架——重发在调度里排最前面。

    拆成两段任务,不是一条流程跑到底:删 ~1 分钟、发 5~8 分钟,串起来会顶到流程硬超时;拆开也让
    每段各自过调度器的风控闸(作息窗口/操作间隔/日配额)。删成功才建发布(_on_delete_ok)。
    上次重发没成的(PENDING_REPUBLISH,旧链接已删)跳过删、直接发。

    今天不做抛 RefreshRejected;发布内容不合格抛 ValueError(validate_publish_spec 的原话)。
    """
    validate_publish_spec(spec)
    if not spec.get("confirm_publish") or spec.get("dry_run"):
        # 只填不发(GC_PUBLISH_CONFIRM=false 的联调模式)下焕新 = 只删不发,链接就没了
        raise ValueError("焕新的发布内容必须真发(confirm_publish),只填不发会删掉旧链接却发不上新的")
    lst = db.get(Listing, listing_id)
    if not lst:
        raise RefreshRejected("链接不存在")
    if lst.status not in (ListingStatus.LIVE, ListingStatus.PENDING_REPUBLISH):
        raise RefreshRejected(f"链接状态是 {lst.status},不焕新")
    if lst.status == ListingStatus.LIVE and not lst.item_id:
        raise RefreshRejected("链接没有闲鱼商品 id,删不准")
    if lst.refresh_skip:
        if source != "MANUAL":
            raise RefreshRejected(f"参加了{lst.refresh_skip},先不焕新")
        # 人点了「立即重新上架」:多半是退出无忧卖了。清掉标记照常删了重发;
        # 还在无忧卖的话删不掉(链接不动),删除流程会再标回来
        logger.info("焕新:手动重新上架,清掉 %s 的不焕新标记(%s)", lst.item_id, lst.refresh_skip)
        lst.refresh_skip = None
    acc = db.get(Account, lst.account_id)
    why = _refresh_usable(db, acc)
    if why:
        raise RefreshRejected(why)
    busy = db.query(Task.id).filter(
        Task.account_id == lst.account_id, Task.ref_id == lst.sku,
        Task.task_type.in_(_LISTING_TASK_TYPES), Task.status.in_(_INFLIGHT_STATUSES),
    ).first()
    if busy:
        raise RefreshRejected("这条链接还有任务在跑")
    if refresh_room(db, acc) <= 0:
        raise RefreshRejected("这个号今天的焕新额度用完了")

    job = Job(job_type=JobType.REFRESH_LISTING, source=source, ref_type="listing", ref_id=lst.id,
              spec=spec)
    db.add(job)
    db.flush()
    start_with_delete = lst.status == ListingStatus.LIVE
    if start_with_delete:
        db.add(Task(
            job_id=job.id, account_id=lst.account_id, task_type="goods_delete",
            status=TaskStatus.PENDING, source=REFRESH_TASK_SOURCE, ref_type="sku", ref_id=lst.sku,
            spec={"item_id": lst.item_id, "listing_id": lst.id,
                  "title": lst.title, "price": lst.price},
        ))
    else:
        db.add(_republish_task(job, lst))
    job.total = 1
    db.commit()
    db.refresh(job)
    logger.info("refresh_listing job=%s sku=%s account=%s 从%s开始",
                job.id, lst.sku, lst.account_id, "删除" if start_with_delete else "重发")
    return job


def _republish_task(job: Job, lst: Listing) -> Task:
    return Task(
        job_id=job.id, account_id=lst.account_id, task_type="goods_publish",
        status=TaskStatus.PENDING, source=REFRESH_TASK_SOURCE, ref_type="sku", ref_id=lst.sku,
        spec={**(job.spec or {}), "refresh_listing_id": lst.id},
    )


def _refresh_blocked(db, sku: str, since: datetime, account_id: str) -> str | None:
    """焕新开始之后,这件货还该不该挂:同货号有链接被买走,或 ERP 下过架(库存清零/别处卖了)。

    只看 since 之后的:退货回库的货以前卖过一次,那条老 SOLD 账本不该把它永远挡在焕新外面。
    开单前在不在库由 ERP 判(它才是库存的真源),这里只防焕新途中发生的事。
    下架只下了别的号(ERP「下架所选店铺」,job.spec.account_ids 里没有本号)的不算:那家店没让下,
    这里收手它就平白没了链接,ERP 里却还显示在架。
    """
    sold = db.query(Listing.id).filter(
        Listing.sku == sku, Listing.status == ListingStatus.SOLD,
        Listing.last_synced_at >= since,
    ).first()
    if sold:
        return "焕新途中同款卖掉了"
    for (spec,) in db.query(Job.spec).filter(
            Job.job_type == JobType.DELIST_SKU, Job.ref_id == sku, Job.created_at >= since):
        only = (spec or {}).get("account_ids")
        if only is None or account_id in only:
            return "焕新途中这件货被下架了"
    return None


def _in_talk(title: str | None, talk_titles: list[str]) -> bool:
    """链接标题对得上最近有买家消息的会话吗(聊天顶栏标题会截成「前半截…」,按前缀互判)。

    和 _match_live_listings 不同:那边命中多条就当歧义跳过(宁漏勿错标售出),这里命中就算——
    宁可这一轮不删。
    """
    mine = (title or "").strip()
    if not mine:
        return False
    for raw in talk_titles:
        raw = (raw or "").strip()
        code = _SHORT_CODE.search(raw)
        if code and f"#{code.group(1)}" in mine:
            return True
        core = raw.rstrip("…").rstrip(".").strip()
        if len(core) >= 6 and (mine.startswith(core) or core.startswith(mine)):
            return True
    return False


def _recent_talk(db, now: datetime) -> dict[str, list[str]]:
    """每个号最近 listing_refresh_buyer_quiet_hours 小时有买家消息的会话标题。"""
    talk: dict[str, list[str]] = {}
    quiet_since = now - timedelta(hours=settings.listing_refresh_buyer_quiet_hours)
    for acc_id, item_title in db.query(Conversation.account_id, Conversation.item_title).filter(
            Conversation.last_message_at >= quiet_since, Conversation.item_title.isnot(None)):
        talk.setdefault(acc_id, []).append(item_title)
    return talk


def refresh_candidates(db, now: datetime | None = None) -> dict:
    """今天该焕新的链接,给 ERP 每天定时来拉:它逐条判库存、组发布内容,再调 create_refresh_listing。

    - 上次重发没成的(PENDING_REPUBLISH):旧链接已经删了、闲鱼上空着,排最前;
    - 在架满 listing_refresh_min_age_days 天的(按 published_at,焕新/重新上架都会刷新它),
      要有闲鱼商品 id(网页版只能按 id 打开详情页删),最老的先;
    - 只要浏览器上能用的号;这条链接上有别的任务在跑的不要;
    - 最近 listing_refresh_buyer_quiet_hours 小时有买家来问过的在架链接先不动:买家手里是旧链接,
      一删他就下不了单了。等下一轮。
    - 标了 refresh_skip 的(无忧卖,网页上删不掉)不焕新。
    rooms 是每个号今天还能开几单(refresh_room),多列的开单时会被 409 挡回去。
    """
    now = now or datetime.utcnow()
    cutoff = now - timedelta(days=settings.listing_refresh_min_age_days)
    rows = (
        db.query(Listing)
        .filter(or_(
            Listing.status == ListingStatus.PENDING_REPUBLISH,
            and_(Listing.status == ListingStatus.LIVE, Listing.item_id.isnot(None),
                 Listing.published_at.isnot(None), Listing.published_at <= cutoff),
        ), Listing.refresh_skip.is_(None))
        .all()
    )
    accounts = {a.id: a for a in db.query(Account).filter(
        Account.id.in_({r.account_id for r in rows})).all()} if rows else {}
    usable = {aid for aid, acc in accounts.items() if _refresh_usable(db, acc) is None}
    busy = {(t.account_id, t.ref_id) for t in db.query(Task.account_id, Task.ref_id).filter(
        Task.task_type.in_(_LISTING_TASK_TYPES), Task.status.in_(_INFLIGHT_STATUSES))}
    talk = _recent_talk(db, now)

    rows.sort(key=lambda r: (r.status != ListingStatus.PENDING_REPUBLISH, r.published_at or now))
    items, held = [], 0
    for lst in rows:
        if lst.account_id not in usable or (lst.account_id, lst.sku) in busy:
            continue
        if lst.status == ListingStatus.LIVE and _in_talk(lst.title, talk.get(lst.account_id, [])):
            held += 1
            continue
        items.append({
            "listing_id": lst.id, "sku": lst.sku, "account_id": lst.account_id,
            "account_nick": accounts[lst.account_id].nick, "status": lst.status,
            "item_id": lst.item_id, "title": lst.title, "price": lst.price,
            "published_at": lst.published_at,
        })
    rooms = {aid: refresh_room(db, accounts[aid], now) for aid in sorted(usable)}
    return {"min_age_days": settings.listing_refresh_min_age_days, "rooms": rooms,
            "items": items, "held_for_buyers": held}


def refresh_status(db, sku: str, now: datetime | None = None) -> dict:
    """这件货各条链接的焕新情况,给 ERP 商品详情页:上次上架时间,以及现在能不能手动重新上架。

    usable=False 是这个号定时焕新也轮不到(手机号、冻结)。
    blocker 是现在不能做的原因,None = 能做。买家在聊的和定时焕新一样不动;额度和在途任务
    create_refresh_listing 开单时还会再判一次,这里只是让页面提前说清楚。
    """
    now = now or datetime.utcnow()
    rows = db.query(Listing).filter(
        Listing.sku == sku,
        Listing.status.in_((ListingStatus.LIVE, ListingStatus.PENDING_REPUBLISH)),
    ).all()
    accounts = {a.id: a for a in db.query(Account).filter(
        Account.id.in_({r.account_id for r in rows})).all()} if rows else {}
    busy = {t.account_id for t in db.query(Task.account_id).filter(
        Task.ref_id == sku, Task.task_type.in_(_LISTING_TASK_TYPES),
        Task.status.in_(_INFLIGHT_STATUSES))}
    talk = _recent_talk(db, now)
    items = []
    for lst in rows:
        acc = accounts.get(lst.account_id)
        unusable = _refresh_usable(db, acc)
        blocker = unusable
        if not blocker and lst.account_id in busy:
            blocker = "这条链接还有任务在跑"
        if not blocker and lst.status == ListingStatus.LIVE:
            if not lst.item_id:
                blocker = "链接没有闲鱼商品 id,删不准"
            elif _in_talk(lst.title, talk.get(lst.account_id, [])):
                blocker = f"{settings.listing_refresh_buyer_quiet_hours} 小时内有买家问过,先不动"
        if not blocker and refresh_room(db, acc, now) <= 0:
            blocker = "这个号今天的焕新额度用完了"
        items.append({
            "listing_id": lst.id, "account_id": lst.account_id, "status": lst.status,
            "item_id": lst.item_id, "published_at": lst.published_at,
            "usable": unusable is None, "blocker": blocker,
            # 不焕新的原因(无忧卖):定时焕新不挑它,人手动「立即重新上架」可以(见 create_refresh_listing)
            "refresh_skip": lst.refresh_skip,
        })
    return {"min_age_days": settings.listing_refresh_min_age_days, "items": items}


def _on_delete_ok(db, task: Task) -> None:
    """删链接成功。焕新里的删:闲鱼上已经空了 → 账本 PENDING_REPUBLISH(仍占位)+ 建重发任务;
    焕新途中货卖了/被下架了、或者这一删本来就是撤回(UNDO),就不再发,记 DELETED。"""
    spec = task.spec or {}
    lst = db.get(Listing, spec.get("listing_id")) if spec.get("listing_id") else None
    if not lst:
        return
    lst.last_synced_at = datetime.utcnow()
    if lst.status == ListingStatus.SOLD:
        return  # 删的同时被买走了:售出是终态,别盖掉(ERP 靠 SOLD 账本收敛售出、锁库存)
    job = db.get(Job, task.job_id) if task.job_id else None
    if not job or job.job_type != JobType.REFRESH_LISTING:
        lst.status = ListingStatus.DELETED
        return
    blocked = _refresh_blocked(db, lst.sku, job.created_at, lst.account_id)
    if blocked or task.source == REFRESH_UNDO_SOURCE:
        lst.status = ListingStatus.DELETED
        logger.info("焕新收手:sku=%s account=%s 链接 %s 已删,%s,不再重发",
                    lst.sku, lst.account_id, lst.item_id, blocked or "撤回")
        return
    lst.status = ListingStatus.PENDING_REPUBLISH
    db.add(_republish_task(job, lst))
    job.total = (job.total or 0) + 1
    logger.info("焕新:sku=%s account=%s 旧链接 %s 已删,重发排队", lst.sku, lst.account_id, lst.item_id)


def _on_republish_ok(db, task: Task, lst: Listing, item_id, title, status) -> None:
    """焕新的重发成功:原账本行原地换上新链接(新 item_id/标题,上架时间从现在重算)。

    原地换、不另起一行:ERP 按(货号,账号)取最新一行收敛店铺状态,一个店铺位一行最省事;
    旧 item_id 在这单焕新的删除任务 spec 里查得到。
    """
    spec = task.spec or {}
    now = datetime.utcnow()
    old_status = lst.status
    lst.item_id, lst.title, lst.status = item_id, title, status
    lst.price = spec.get("price")
    lst.published_at = now
    lst.expire_at = None
    lst.last_synced_at = now
    lst.job_id = task.job_id
    lst.shot_key = task.shot_key
    logger.info("焕新完成:sku=%s account=%s 新链接 item_id=%s -> %s",
                lst.sku, lst.account_id, item_id, status)
    job = db.get(Job, task.job_id) if task.job_id else None
    blocked = _refresh_blocked(db, lst.sku, job.created_at, lst.account_id) if job else None
    if old_status == ListingStatus.DELETED:
        blocked = blocked or "重发途中这件货被下架了"
    if not blocked:
        return
    if not item_id or not job:
        _alert_relisted_while_gone(lst, blocked, "新链接没读到商品 id,只能人工去删")
        return
    db.add(Task(
        job_id=job.id, account_id=lst.account_id, task_type="goods_delete",
        status=TaskStatus.PENDING, source=REFRESH_UNDO_SOURCE, ref_type="sku", ref_id=lst.sku,
        spec={"item_id": item_id, "listing_id": lst.id, "title": title, "price": lst.price},
    ))
    job.total = (job.total or 0) + 1
    logger.warning("焕新撤回:sku=%s account=%s %s,刚发上去的 %s 马上删掉",
                   lst.sku, lst.account_id, blocked, item_id)


def _alert_relisted_while_gone(lst: Listing, why: str, what: str) -> None:
    """货已经卖了/下架了,焕新发上去的新链接却还挂着:一件货多一条能下单的链接,必须叫人。"""
    try:
        from app.notify import _send
        _send("有条链接要人工删除",
              f"货号 {lst.sku}:{why},但焕新发上去的链接还在架({what})。"
              f"请到这个号的闲鱼「我发布的」里删掉它,免得一货多卖。")
    except Exception:
        logger.exception("焕新撤回告警失败 sku=%s", lst.sku)


def _on_refresh_failed(db, task: Task) -> None:
    """焕新任务失败的善后。

    - 删旧链接失败:旧链接原样在架,什么都不用动,第二天再来;
    - 重发失败,但已经点过「发布」(result.published):新链接可能已经挂上去了 → UNCERTAIN 交人对账,
      绝不再自动发(否则一件货两条链接);
    - 重发失败、没点到发布:停在 PENDING_REPUBLISH,第二天的焕新直接重发;
    - 撤回删失败:货已卖/已下架,新链接却还挂着 → 叫人;
    - 删的时候闲鱼说它参加了无忧卖(result.wuyoumai):标 refresh_skip,以后不焕新、不通知(11-11 用户定先不处理)。
    重发失败一天只推一条(notify_refresh_problem);风控/掉登录 runner 已经通知过,不重复。
    """
    spec = task.spec or {}
    result = task.result or {}
    if task.source == REFRESH_UNDO_SOURCE:
        lst = db.get(Listing, spec.get("listing_id")) if spec.get("listing_id") else None
        if lst:
            _alert_relisted_while_gone(lst, "焕新途中货卖了或被下架", f"自动删除失败:{task.error or '-'}")
        return
    if task.task_type == "goods_delete" and result.get("wuyoumai"):
        lst = db.get(Listing, spec.get("listing_id")) if spec.get("listing_id") else None
        if lst:
            lst.refresh_skip = "无忧卖"
            logger.info("焕新:货号 %s 的链接 %s 参加了无忧卖,以后不焕新", lst.sku, lst.item_id)
        return
    if task.task_type != "goods_publish":
        return
    lst = db.get(Listing, spec.get("refresh_listing_id")) if spec.get("refresh_listing_id") else None
    if not lst:
        return
    acc = db.get(Account, lst.account_id)
    who = f"账号「{acc.nick if acc else lst.account_id}」货号 {lst.sku}"
    if result.get("published"):
        lst.status = ListingStatus.UNCERTAIN
        lst.item_id = result.get("item_id")   # 旧 id 指向已删的链接,留着只会误导对账
        lst.last_synced_at = datetime.utcnow()
        title = "焕新重发结果待核对"
        problem = f"{who}:旧链接删了,重发点了「发布」但没确认上架,可能已经在架,请人工核对(不会自动再发)。"
    else:
        title = "有链接删了没发上去"
        problem = f"{who}:旧链接删了,重发没成({task.error or '原因未知'})。明天的焕新会自动再发,今天它不在架。"
    logger.warning("焕新重发失败:%s", problem)
    if result.get("risk") or result.get("login"):
        return
    try:
        from app.notify import notify_refresh_problem
        notify_refresh_problem(db, title, problem, day=_cn_day_start_utc().isoformat())
    except Exception:
        logger.exception("焕新失败通知失败 sku=%s", lst.sku)


# ==================== 记账(runner 回调)====================
def on_task_result(task_id: str, ok: bool) -> None:
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        if not task:
            return
        if ok:
            if task.task_type == "goods_publish":
                _on_publish_ok(db, task)
            elif task.task_type == "goods_delist":
                _on_delist_ok(db, task)
            elif task.task_type == "goods_reprice":
                _on_reprice_ok(db, task)
            elif task.task_type == "goods_relist":
                _on_relist_ok(db, task)
            elif task.task_type == "goods_delete":
                _on_delete_ok(db, task)
            elif task.task_type == "chat_scan":
                _on_chat_scan_ok(db, task)
            elif task.task_type == "sold_scan":
                _on_sold_scan_ok(db, task)
            elif task.task_type == "chat_reply":
                _on_chat_reply_ok(db, task)
        elif task.source in (REFRESH_TASK_SOURCE, REFRESH_UNDO_SOURCE):
            _on_refresh_failed(db, task)
        db.commit()
        if task.job_id:
            _aggregate_job(db, task.job_id)
            db.commit()


def _on_publish_ok(db, task: Task) -> None:
    spec = task.spec or {}
    result = task.result or {}
    item_id = (result.get("result") or {}).get("item_id") or result.get("item_id")
    # 闲鱼卡片不显示 item_id，回读到的是 AI 生成的标题；它是下架/改价能精确定位商品的依据。
    title = (result.get("result") or {}).get("title") or result.get("title")
    ttl_days = spec.get("ttl_days")
    now = datetime.utcnow()
    status = _publish_listing_status(item_id, title, result.get("publish_outcome"))
    refreshed = db.get(Listing, spec["refresh_listing_id"]) if spec.get("refresh_listing_id") else None
    if refreshed:
        _on_republish_ok(db, task, refreshed, item_id, title, status)
        return
    lst = Listing(
        sku=task.ref_id, account_id=task.account_id, item_id=item_id, title=title,
        status=status,
        price=spec.get("price"), published_at=now,
        expire_at=(now + timedelta(days=ttl_days)) if ttl_days else None,
        job_id=task.job_id, shot_key=task.shot_key,
    )
    db.add(lst)
    logger.info("发布记账 sku=%s account=%s item_id=%s title=%r outcome=%s -> %s",
                task.ref_id, task.account_id, item_id, title, result.get("publish_outcome"), lst.status)


def _publish_listing_status(item_id, title, publish_outcome) -> str:
    """发布后 Listing 落什么状态(纯函数,可单测)。

    - 待支付宝认证(PENDING_PAYMENT_AUTH):宝贝已提交但**未真正上架**(号主需开通支付宝收款),
      不算 LIVE,记 UNCERTAIN 交对账,勿盲重发(否则会建重复待上架宝贝)。
    - 有 item_id **或** 回读到 title:title 由 `_readback_title` 从「在卖」列表捞到,
      = 已确认在架且可精确定位 → **LIVE**(不必死等 item_id;闲鱼卡片本就不显示 item_id)。
    - 都没有:读不到任何锚点 → UNCERTAIN,交对账。
    """
    if publish_outcome == "PENDING_PAYMENT_AUTH":
        return ListingStatus.UNCERTAIN
    if item_id or title:
        return ListingStatus.LIVE
    return ListingStatus.UNCERTAIN


def _on_delist_ok(db, task: Task) -> None:
    spec = task.spec or {}
    lst = db.get(Listing, spec.get("listing_id")) if spec.get("listing_id") else None
    if not lst and task.account_id:
        lst = db.query(Listing).filter(
            Listing.sku == task.ref_id, Listing.account_id == task.account_id,
            Listing.status.in_((ListingStatus.LIVE, ListingStatus.UNCERTAIN)),
        ).first()
    if lst:
        lst.status = ListingStatus.DELISTED
        lst.last_synced_at = datetime.utcnow()


def _on_relist_ok(db, task: Task) -> None:
    spec = task.spec or {}
    lst = db.get(Listing, spec.get("listing_id")) if spec.get("listing_id") else None
    if not lst and task.account_id:
        lst = db.query(Listing).filter(
            Listing.sku == task.ref_id, Listing.account_id == task.account_id,
            Listing.status == ListingStatus.DELISTED,
        ).first()
    if lst:
        lst.status = ListingStatus.LIVE
        lst.published_at = datetime.utcnow()
        lst.last_synced_at = datetime.utcnow()


def _on_chat_scan_ok(db, task: Task) -> None:
    """按 account_id + peer_key upsert Conversation;消息按 dedup_key 忽略重复插入。"""
    result = task.result or {}
    acc_id = task.account_id
    now = datetime.utcnow()
    new_in = 0
    details: list[dict] = []   # 本轮有新 inbound 的会话明细,攒给 maybe_notify_new_messages
    acc = db.get(Account, acc_id) if acc_id else None
    acc_label = (acc.nick if acc else None) or (acc_id or "")[:8]
    for conv in result.get("conversations", []):
        pk = conv.get("peer_key")
        if not pk:
            continue
        row = db.query(Conversation).filter(
            Conversation.account_id == acc_id, Conversation.peer_key == pk).first()
        if not row:
            row = Conversation(account_id=acc_id, peer_key=pk)
            db.add(row)
            db.flush()
        row.peer_nick = conv.get("peer_nick") or row.peer_nick
        row.item_title = conv.get("item_title") or row.item_title
        row.item_price = conv.get("item_price") or row.item_price
        # 商品卡缩略图:聊天页 img src 直取优先(or-keep);标题反猜(_resolve_item_images)
        # 只在直取不到时兜底——2026-10-10 起执行端 dump 带 img src,同款多件在架也能配图
        row.item_image = conv.get("item_image") or row.item_image
        row.order_status = conv.get("order_status")
        row.last_message = conv.get("last_message")
        row.updated_at = now
        seen = set()
        conv_new_in = 0
        last_in_text = None
        for m in result.get("messages", {}).get(pk, []):
            text = m.get("text") or ""
            direction = m.get("direction") or "in"
            dk = hashlib.sha1((direction + "\x1f" + text).encode("utf-8")).hexdigest()
            if dk in seen:
                continue
            seen.add(dk)
            # 回复记账的 out 行键里带任务号(_on_chat_reply_ok,同一句话发两次要留两条),
            # 键对不上,再按方向+原文认一遍:已有这句就不再记
            exists = db.query(ChatMessage).filter(
                ChatMessage.conversation_id == row.id,
                or_(ChatMessage.dedup_key == dk,
                    and_(ChatMessage.direction == direction, ChatMessage.text == text))).first()
            if exists:
                continue
            # msg_at 来自 task.result(JSON),1a 的 parse_chat_page 恒吐 None;
            # 1b/2 接入真实时间戳解析后会以字符串形式抵达 —— DateTime 列不接受字符串,
            # 防御性只放行真 datetime 实例,真时间戳解析留给 1b。
            mv = m.get("msg_at")
            msg_at_val = mv if isinstance(mv, datetime) else None
            db.add(ChatMessage(conversation_id=row.id, direction=direction, text=text,
                                msg_at=msg_at_val, dedup_key=dk))
            if direction == "in":
                new_in += 1
                conv_new_in += 1
                last_in_text = text
        # 小程序未读 = 累计人工尚未在小程序查看的进站消息(去重后只算真正新插入的);
        # 打开会话(POST .../read)清零。与闲鱼端红点是否清除无关(此处是小程序侧状态)。
        if conv_new_in:
            row.unread = int(row.unread or 0) + conv_new_in
            row.last_message_at = now
            # 通知明细:账号 + 买家 + 商品(标题/价格,可缺省) + 本轮最新一句(~40 字,换行拍平)
            details.append({
                "account": acc_label,
                "buyer": conv.get("peer_nick") or pk,
                "title": conv.get("item_title") or None,
                "price": conv.get("item_price") or None,
                "text": (last_in_text or "").replace("\n", " ")[:40] or None,
            })
    # 1c:聚合+冷却后推一条通知(企微优先/Server酱回退);未配置 sendkey 或失败均不影响读链路
    maybe_notify_new_messages(db, new_in, details=details)
    # 消息响应考核：最后一条是买家的开一轮、是我们的结束一轮（chat_sla.py）
    try:
        from app import chat_sla
        touched = [c for c in (db.query(Conversation).filter(
            Conversation.account_id == acc_id,
            Conversation.peer_key.in_([c.get("peer_key") for c in result.get("conversations", []) if c.get("peer_key")])).all())]
        db.flush()
        chat_sla.track_after_scan(db, touched, now)
    except Exception:  # noqa: BLE001 - 考核记账失败不能拖垮读消息
        logger.exception("chat_sla 记账失败")
    # 会话聊的是哪件货(listing_sku / item_id):同样要在 _detect_sold_listings 之前,理由同下
    _link_listings(db, acc_id, result.get("conversations", []))
    # 商品卡缩略图:标题唯一命中在架 listing → job.spec.images[0] → row.item_image(or-keep)。
    # 须在 _detect_sold_listings 之前:售出态会话本轮会把 listing 标 SOLD,标完就不在 LIVE 集里了
    _resolve_item_images(db, acc_id, result.get("conversations", []))
    # 售出土账:会话 order_status 为售出态 + 宝贝标题匹配 → 本账号在架账本标 SOLD
    _detect_sold_listings(db, acc_id, result.get("conversations", []))
    # 浏览器号的聊天页商品卡没有标题,上面那步对不上;看到成交状态就提前跑一趟售出巡检
    _ring_sold_scan(db, acc, result.get("conversations", []))
    # 扫的过程中门铃又响过:这单可能漏了那条,马上补扫一轮(本单已是 SUCCESS,不算在途)
    if (task.spec or {}).get("rescan") and acc_id:
        create_chat_scan(db, acc_id, source="HINT")


# 售出态(买家已付款及以后):会话行 order_status 命中即「该宝贝已卖出」。
# 排除:等待付款(未成交)、退款中/退款成功/已关闭(可能回滚,交人工对账)。
_SOLD_ORDER_STATUSES = frozenset({
    "等待你发货", "待发货", "等待卖家发货", "等待见面交易",
    "已发货", "待收货", "等待买家收货", "交易成功",
})
# 老账本兼容:2026-08-31 之前发布的标题带 `#NNNN ` 上架短编码,按码定位优先
_SHORT_CODE = re.compile(r"#(\d{4})(?=\s|$)")


def _match_live_listings(conv_title: str, live: list[Listing]) -> list[Listing]:
    """会话商品标题 → 本账号在架 listing 匹配(_detect_sold_listings 同款规则,抽出共用)。

    1. 标题含 #NNNN → 老路径,按码命中同码账本(可多条,码是强锚);
    2. 否则整标题前缀匹配——聊天顶栏标题会截断(尾部 …),去掉省略号后与账本标题
       互判前缀;命中多条(同款多件在架)歧义跳过,宁漏勿错。
    """
    title = (conv_title or "").strip()
    if not title:
        return []
    m = _SHORT_CODE.search(title)
    if m:
        return [lst for lst in live if lst.title and f"#{m.group(1)}" in lst.title]
    # 顶栏截断形:「前半截…」/「前半截...」——去掉尾部省略号再互判前缀;
    # 短于 6 字不做(太短的前缀满街都是,误标比漏检代价大)
    core = title.rstrip("…").rstrip(".").strip()
    if len(core) < 6:
        return []
    rows = [
        lst for lst in live
        if lst.title and (lst.title.startswith(core) or core.startswith(lst.title))
    ]
    if len(rows) > 1:
        logger.warning("会话标题「%s」命中 %d 条在架账本,歧义跳过", title[:20], len(rows))
        return []
    return rows


def _price_int(text) -> int | None:
    """商品卡价格文本「1,588.00」→ 1588(账本 price 是整数元);认不出 → None。"""
    try:
        v = float(str(text or "").replace(",", "").replace("¥", "").strip())
    except ValueError:
        return None
    return int(round(v)) if v > 0 else None


def _link_listings(db, account_id: str, conversations: list[dict]) -> None:
    """会话 → 本号哪一条账本:写 Conversation.listing_sku / item_id,聊天页「+」面板按它找同款在库货。

    依次认:① 商品卡带的闲鱼商品 id(有就是准的,不管还在不在架);② 标题(安卓号,规则同
    _match_live_listings);③ 价格(网页版商品卡没有标题只有价:本号在架只有一条这个价才认)。
    认不出就不动、留着上次的——宁漏勿错,认错了客服会把别的货的实拍发给买家。
    """
    convs = [c for c in conversations if c.get("peer_key")]
    if not convs:
        return
    live = db.query(Listing).filter(
        Listing.account_id == account_id,
        Listing.status.in_((ListingStatus.LIVE, ListingStatus.UNCERTAIN)),
    ).all()
    for conv in convs:
        lst = None
        item_id = str(conv.get("item_id") or "").strip()
        if item_id:
            lst = db.query(Listing).filter(
                Listing.account_id == account_id, Listing.item_id == item_id,
            ).order_by(Listing.created_at.desc()).first()
        if lst is None and (conv.get("item_title") or "").strip():
            rows = _match_live_listings(conv["item_title"], live)
            lst = rows[0] if len(rows) == 1 else None
        if lst is None and not item_id:
            price = _price_int(conv.get("item_price"))
            rows = [x for x in live if price and x.price == price]
            lst = rows[0] if len(rows) == 1 else None
        if lst is None and not item_id:
            continue
        row = db.query(Conversation).filter(
            Conversation.account_id == account_id, Conversation.peer_key == conv["peer_key"]).first()
        if row is None:
            continue
        if lst is not None:
            row.listing_sku = lst.sku
            row.item_id = lst.item_id or item_id or row.item_id
        else:
            # 只认出商品 id、本号账本里没有这件:买家换了一件聊,旧的对应作废
            if row.item_id != item_id:
                row.listing_sku = None
            row.item_id = item_id


def _detect_sold_listings(db, account_id: str, conversations: list[dict]) -> None:
    """chat_scan 会话 order_status 售出态 + 宝贝标题匹配 → 本账号在架账本标 SOLD(幂等)。

    漏了下轮 chat_scan 还会再扫到;ERP 轮询 SOLD 后负责标店/锁库存/全账号下架。
    """
    now = datetime.utcnow()
    live = db.query(Listing).filter(
        Listing.account_id == account_id,
        Listing.status.in_((ListingStatus.LIVE, ListingStatus.UNCERTAIN)),
    ).all()
    for conv in conversations:
        if conv.get("order_status") not in _SOLD_ORDER_STATUSES:
            continue
        conv_title = (conv.get("item_title") or "").strip()
        if not conv_title:
            continue
        for lst in _match_live_listings(conv_title, live):
            lst.status = ListingStatus.SOLD
            lst.last_synced_at = now
            logger.info("检出售出:account=%s sku=%s title=%r status=%r → SOLD",
                        account_id, lst.sku, conv_title[:24], conv.get("order_status"))


# 同一个号两次「门铃」建单的最小间隔:成交后买家接着聊,每轮 chat_scan 都会再看到成交状态
_SOLD_SCAN_RING_GAP_SEC = 600


def _ring_sold_scan(db, acc: Account | None, conversations: list[dict]) -> None:
    """浏览器号的会话里出现成交状态(买家付款后会话会冒未读,chat_scan 读得到)→ 马上建一单售出巡检,
    不等 sold_scan_interval_sec 的周期。只是门铃:卖掉的是哪件,由售出巡检按 item_id 确认。

    网页版聊天页的商品卡没有标题(2026-10-17 实测),_detect_sold_listings 在浏览器号上对不上任何一单。
    """
    if not settings.sold_scan_enabled or acc is None or not acc.device_id:
        return
    if not any(c.get("order_status") in _SOLD_ORDER_STATUSES for c in conversations):
        return
    dev = db.get(Device, acc.device_id)
    if not dev or dev.kind != "browser":
        return
    recent = db.query(Task.id).filter(
        Task.account_id == acc.id, Task.task_type == "sold_scan",
        Task.created_at >= datetime.utcnow() - timedelta(seconds=_SOLD_SCAN_RING_GAP_SEC),
    ).first()
    if recent:
        return
    if create_sold_scan(db, acc.id, source="CHAT"):
        logger.info("会话里出现成交状态,提前跑售出巡检 account=%s", acc.id)


def _on_sold_scan_ok(db, task: Task) -> None:
    """售出巡检记账:流程在详情页按 item_id 确认卖掉的 → 本号在架账本标 SOLD(幂等)。

    只认 item_id + 本账号 + 还在架(LIVE/UNCERTAIN):spec 是建单时的快照,派发前这期间
    下架/删掉了的不改;已经是 SOLD 的不重复记。ERP 轮询 SOLD 后负责标店/锁库存/全账号下架。
    """
    now = datetime.utcnow()
    for s in (task.result or {}).get("sold") or []:
        item_id = str(s.get("item_id") or "")
        if not item_id:
            continue
        lst = db.query(Listing).filter(
            Listing.account_id == task.account_id, Listing.item_id == item_id,
            Listing.status.in_((ListingStatus.LIVE, ListingStatus.UNCERTAIN)),
        ).first()
        if not lst:
            continue
        lst.status = ListingStatus.SOLD
        lst.last_synced_at = now
        logger.info("检出售出(已售出列表):account=%s sku=%s item_id=%s title=%r → SOLD",
                    task.account_id, lst.sku, item_id, (lst.title or "")[:24])


def _resolve_item_images(db, account_id: str, conversations: list[dict]) -> None:
    """聊天页商品卡缩略图(兜底通道):会话标题唯一命中在架 listing → 其发布 job 的
    spec.images[0] 写入 row.item_image。直取(parse 的 img src)优先——conv 已带
    item_image 的会话一律跳过,且只在 row.item_image 为空时才写(不覆盖直取值/历史值,
    只在解析不到时填空兜底,or-keep 与 item_title 一致)。

    只在标题唯一命中时才取图(同款多件歧义时不猜);listing 全量每轮查一次,不 N+1。
    """
    live = db.query(Listing).filter(
        Listing.account_id == account_id,
        Listing.status.in_((ListingStatus.LIVE, ListingStatus.UNCERTAIN)),
    ).all()
    if not live:
        return
    for conv in conversations:
        pk = conv.get("peer_key")
        title = (conv.get("item_title") or "").strip()
        if not pk or not title or conv.get("item_image"):
            continue
        rows = _match_live_listings(title, live)
        if len(rows) != 1:
            continue
        job = db.get(Job, rows[0].job_id) if rows[0].job_id else None
        images = (job.spec or {}).get("images") if job else None
        url = images[0] if isinstance(images, list) and images else None
        if not url:
            continue
        row = db.query(Conversation).filter(
            Conversation.account_id == account_id, Conversation.peer_key == pk).first()
        if row and not row.item_image:
            row.item_image = url   # 只填空不覆盖:直取值/历史值都比反猜可靠(同款歧义)


def _on_chat_reply_ok(db, task: Task) -> None:
    """回复成功记账:把已确认发出的文本作为 out 消息落库,会话末条改成这条。

    dedup_key = sha1(out+text+任务号):一单一条,同一单重放不重复记。原来与 chat_scan 同键
    sha1(direction+text),同一会话第二次发同一句撞键不落库,会话末条还是买家那句——开着兜底
    (兜底话术每次都是同一句)就每轮判欠回复、隔一分钟再发一遍。之后的扫描读到这个气泡,
    按方向+原文认出已有(_on_chat_scan_ok),不会再记一条。
    流程端已回读核对过(同文 out 多出一条才算发出),这里直接信任 spec.text。
    """
    spec = task.spec or {}
    conv = db.get(Conversation, spec.get("conversation_id")) if spec.get("conversation_id") else None
    media = spec.get("media") or None
    # 只发图片 / 视频:文字那格记一行摘要(「[图片]×3」),会话列表和兜底看末条都靠它。
    # 图片带文字记文字原文,之后的扫描读到这个气泡才认得出,不会再记一条
    text = (spec.get("text") or "") or (chat_media.summary_text(media) if media else "")
    if not conv or not text:
        return
    now = datetime.utcnow()
    dk = hashlib.sha1(("out" + "\x1f" + text + "\x1f" + task.id).encode("utf-8")).hexdigest()
    exists = db.query(ChatMessage).filter(
        ChatMessage.conversation_id == conv.id, ChatMessage.dedup_key == dk).first()
    if not exists:
        db.add(ChatMessage(conversation_id=conv.id, direction="out", text=text,
                           msg_at=None, dedup_key=dk, media=media, card=spec.get("card") or None))
    # 末条一律是这条:兜底按最后一条消息的方向判欠回复,last_message_at 是它粗筛用的时间
    conv.last_message = text
    conv.last_message_at = now
    conv.updated_at = now
    # 员工手动回的才算处理了这一轮；兜底自动回复（source=AUTO）不算
    if task.source != "AUTO":
        from app import chat_sla
        chat_sla.on_staff_reply(db, conv.id, spec.get("by_id"), spec.get("by_name"), now)


def _on_reprice_ok(db, task: Task) -> None:
    spec = task.spec or {}
    lst = db.get(Listing, spec.get("listing_id")) if spec.get("listing_id") else None
    if lst and spec.get("new_price") is not None:
        lst.price = int(spec["new_price"])
        lst.last_synced_at = datetime.utcnow()


def _aggregate_job(db, job_id: str) -> None:
    job = db.get(Job, job_id)
    if not job:
        return
    rows = dict(
        db.query(Task.status, func.count()).filter(Task.job_id == job_id)
        .group_by(Task.status).all()
    )
    succeeded = rows.get(TaskStatus.SUCCESS, 0)
    failed = rows.get(TaskStatus.FAILED, 0) + rows.get(TaskStatus.CANCELLED, 0)
    job.succeeded = succeeded
    job.failed = failed
    done = succeeded + failed
    if done >= job.total and job.total > 0:
        if failed == 0:
            job.status = JobStatus.DONE
        elif succeeded == 0:
            job.status = JobStatus.FAILED
        else:
            job.status = JobStatus.PARTIAL
        job.finished_at = datetime.utcnow()
    elif done > 0:
        job.status = JobStatus.RUNNING
        job.finished_at = None   # 有任务被重新排队(执行端维护收尾)时,作业从收尾态退回进行中
