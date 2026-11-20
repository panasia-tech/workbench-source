"""浏览器工作台的设备登记与爬虫租约。

一个员工账号可以在多台电脑上同时登录，但**同一个爬虫任何时候只能在一台电脑上开着**
（老板 2026-09-16 定：不然就乱套）。本地开关做不到互斥——两台电脑各记一个「我开着」，
谁也不知道对方——所以判归属的必须是服务端，这里就是那个第三方。

租约的语义见 app/models/workbench.py 的模块 docstring，不在这里重复。

# 权限

爬虫开关只有管理员有。心跳不限角色：销售和采购的电脑也要登记，否则管理员在
「哪台机器」那张表里根本看不到它们，也就没法把爬虫指过去。
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_current_user, require_roles
from app.enums import StaffRole
from app.models import Staff
from app.models.workbench import (
    VALID_OWNERS,
    AdsEnvPurpose,
    CrawlerFeature,
    CrawlerLease,
    CrawlRunStatus,
    CrawlSnapshotRequest,
    MarketCrawlRun,
    SnapshotRequestStatus,
    WorkbenchDevice,
)
from app.schemas.workbench import (
    CrawlRunClaimIn,
    CrawlRunCreateIn,
    CrawlRunFinishIn,
    CrawlRunListOut,
    CrawlRunOut,
    DeviceHeartbeatIn,
    EnvPurposeIn,
    EnvPurposeListOut,
    EnvPurposeOut,
    DeviceOut,
    HeartbeatOut,
    LeaseActionIn,
    LeaseListOut,
    LeaseOut,
    LeaseTransferIn,
    SnapshotRequestOut,
)
from app.database import get_db

router = APIRouter(prefix="/api/workbench", tags=["workbench"])

# 图片爬虫还没有真实实现（2026-09-16 老板确认「现在还没在跑」）。租约先占位，
# 界面如实显示「未接入」——做一个管不着真实进程的开关比没有开关更糟。
IMPLEMENTED_FEATURES = (CrawlerFeature.MARKET,)


def _ttl() -> int:
    return int(getattr(settings, "workbench_lease_ttl_sec", 90) or 90)


def _assert_feature(feature: str) -> str:
    if feature not in CrawlerFeature.ALL:
        raise HTTPException(404, f"没有这个爬虫：{feature}")
    return feature


def _device_names(db: Session, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = db.query(WorkbenchDevice).filter(WorkbenchDevice.id.in_(ids)).all()
    return {d.id: d.name for d in rows}


def _staff_names(db: Session, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = db.query(Staff).filter(Staff.id.in_(ids)).all()
    return {s.id: s.name for s in rows}


def _lease_out(row: CrawlerLease | None, feature: str, now: datetime,
               device_names: dict, staff_names: dict, me: str | None) -> LeaseOut:
    held = bool(row and row.held_at(now))
    return LeaseOut(
        feature=feature,
        label=CrawlerFeature.LABEL[feature],
        held=held,
        # 过期的租约等于没人持有：不把旧持有者报上去，免得界面显示「归某台」
        # 而实际上谁都能抢——那会让人以为要先去找那台机器。
        device_id=row.device_id if held else None,
        device_name=device_names.get(row.device_id) if held else None,
        mine=bool(held and me and row.device_id == me),
        staff_name=staff_names.get(row.staff_id) if held else None,
        expires_at=row.expires_at if held else None,
        handoff_to=row.handoff_to if held else None,
        handoff_to_name=device_names.get(row.handoff_to) if held and row.handoff_to else None,
        available=feature in IMPLEMENTED_FEATURES,
    )


def _all_leases(db: Session, now: datetime, me: str | None = None) -> list[LeaseOut]:
    rows = {r.feature: r for r in db.query(CrawlerLease).all()}
    names = _device_names(db, {r.device_id for r in rows.values()} |
                              {r.handoff_to for r in rows.values() if r.handoff_to})
    staff = _staff_names(db, {r.staff_id for r in rows.values() if r.staff_id})
    return [_lease_out(rows.get(f), f, now, names, staff, me) for f in CrawlerFeature.ALL]


def _device_out(d: WorkbenchDevice, now: datetime, staff_names: dict) -> DeviceOut:
    return DeviceOut(
        id=d.id,
        name=d.name,
        os=d.os,
        app_version=d.app_version,
        online=(now - d.last_seen_at).total_seconds() <= _ttl(),
        last_seen_at=d.last_seen_at,
        last_staff_name=staff_names.get(d.last_staff_id),
        ads_env_count=len(d.ads_env_ids or []),
    )


@router.post("/devices/heartbeat", summary="工作台心跳", response_model=HeartbeatOut)
def heartbeat(
    body: DeviceHeartbeatIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    """登记这台电脑，并捎回两个爬虫此刻分别归谁。

    捎回租约是有意的：端上不必再单独轮询一次。心跳本来就每几十秒一拍，
    「这个开关现在是开是关」跟着它走，界面上就不会出现「本地显示开着、
    实际租约早被别人抢走」这种两套事实。
    """
    now = datetime.utcnow()
    device = db.get(WorkbenchDevice, body.device_id)
    if device is None:
        device = WorkbenchDevice(id=body.device_id, created_at=now)
        db.add(device)
    if body.name:
        device.name = body.name[:64]
    device.os = body.os
    device.app_version = body.app_version
    device.last_staff_id = user.id
    device.last_seen_at = now
    # 只在端上真枚举到环境时才覆盖：本机代理没起时端上报的是空列表，
    # 那是「这一拍问不到」，不是「这台电脑上没有环境」——用它清掉记录会让
    # 管理员在关键时刻看到一台空空如也的机器。
    if body.ads_env_ids:
        device.ads_env_ids = list(dict.fromkeys(body.ads_env_ids))[:200]
    db.commit()
    db.refresh(device)
    return HeartbeatOut(
        server_time=now,
        ttl_sec=_ttl(),
        device=_device_out(device, now, _staff_names(db, {device.last_staff_id})),
        leases=_all_leases(db, now, me=device.id),
        pending_crawl_run_id=_pending_run_id(db, device.id),
        pending_snapshot_request=_pending_snapshot(db, device.id),
    )


@router.get("/leases", summary="两个爬虫分别归谁", response_model=LeaseListOut)
def list_leases(
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    now = datetime.utcnow()
    devices = db.query(WorkbenchDevice).order_by(WorkbenchDevice.last_seen_at.desc()).all()
    staff = _staff_names(db, {d.last_staff_id for d in devices})
    return LeaseListOut(
        ttl_sec=_ttl(),
        server_time=now,
        leases=_all_leases(db, now),
        devices=[_device_out(d, now, staff) for d in devices],
    )


@router.post("/leases/{feature}/acquire", summary="开启：抢下这个爬虫", response_model=LeaseOut)
def acquire(
    feature: str,
    body: LeaseActionIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """抢租约。已被别人持有且没过期 → 409，并说清楚在哪台机器上。

    不做「强行抢过来」：那等于允许两台机器先后开同一个爬虫，而前一台可能正跑到
    一半。要换机器走 transfer。
    """
    _assert_feature(feature)
    if feature not in IMPLEMENTED_FEATURES:
        raise HTTPException(400, f"{CrawlerFeature.LABEL[feature]}还没接入，开不了")
    now = datetime.utcnow()
    if db.get(WorkbenchDevice, body.device_id) is None:
        raise HTTPException(404, "这台电脑还没登记过，先让工作台连上一次")

    row = db.get(CrawlerLease, feature)
    if row and row.held_at(now) and row.device_id != body.device_id:
        names = _device_names(db, {row.device_id})
        raise HTTPException(
            409,
            f"{CrawlerFeature.LABEL[feature]}正在「{names.get(row.device_id, row.device_id)}」"
            f"上开着。要换一台请用转移，别直接抢——那台可能正跑到一半。",
        )

    expires = now + timedelta(seconds=_ttl())
    if row is None:
        row = CrawlerLease(feature=feature, device_id=body.device_id, staff_id=user.id,
                           acquired_at=now, expires_at=expires)
        db.add(row)
    else:
        # 续开自己的、或接手一个已过期的：两种都从这里走，acquired_at 重新计时
        row.device_id = body.device_id
        row.staff_id = user.id
        row.acquired_at = now
        row.expires_at = expires
        row.handoff_to = None
        row.handoff_by = None
    db.commit()
    db.refresh(row)
    return _lease_out(row, feature, now, _device_names(db, {row.device_id}),
                      _staff_names(db, {row.staff_id}), me=body.device_id)


@router.post("/leases/{feature}/renew", summary="续租", response_model=LeaseOut)
def renew(
    feature: str,
    body: LeaseActionIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """持有方定期续。不是持有方 → 409，端上据此立刻停掉本地那份爬虫。

    这条是「机器掉线后自动释放」的另一半：掉线的机器回来续租时会发现租约已经
    易主，于是自己停手，而不是两台一起跑。
    """
    _assert_feature(feature)
    now = datetime.utcnow()
    row = db.get(CrawlerLease, feature)
    if row is None or not row.held_at(now) or row.device_id != body.device_id:
        raise HTTPException(409, f"{CrawlerFeature.LABEL[feature]}已经不归这台电脑了，请停止运行")
    row.expires_at = now + timedelta(seconds=_ttl())
    db.commit()
    db.refresh(row)
    return _lease_out(row, feature, now, _device_names(db, {row.device_id, row.handoff_to}),
                      _staff_names(db, {row.staff_id}), me=body.device_id)


@router.post("/leases/{feature}/release", summary="关闭：让出这个爬虫", response_model=LeaseOut)
def release(
    feature: str,
    body: LeaseActionIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """主动还租约。不是持有方就当已经还过了——关一个本来就没开的东西不该报错。"""
    _assert_feature(feature)
    now = datetime.utcnow()
    row = db.get(CrawlerLease, feature)
    if row is not None and row.device_id == body.device_id:
        db.delete(row)
        db.commit()
        row = None
    return _lease_out(row, feature, now, {}, {}, me=body.device_id)


@router.post("/leases/{feature}/transfer", summary="转移到另一台", response_model=LeaseOut)
def transfer(
    feature: str,
    body: LeaseTransferIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """把爬虫指到另一台电脑上。

    **不掐断正在跑的那一轮**：只写下 handoff_to，持有方下一次续租时看见它，
    跑完当前这批再主动让位。采集跑到一半被拔掉，留下的是半批脏数据和一个开着的
    浏览器——为了少等一分钟不值得。

    租约已经过期（那台本来就联系不上了）则直接改判，没什么可等的。
    """
    _assert_feature(feature)
    if feature not in IMPLEMENTED_FEATURES:
        raise HTTPException(400, f"{CrawlerFeature.LABEL[feature]}还没接入，转不了")
    now = datetime.utcnow()
    target = db.get(WorkbenchDevice, body.to_device_id)
    if target is None:
        raise HTTPException(404, "目标电脑还没登记过")

    row = db.get(CrawlerLease, feature)
    if row is None or not row.held_at(now):
        expires = now + timedelta(seconds=_ttl())
        if row is None:
            row = CrawlerLease(feature=feature, device_id=body.to_device_id, staff_id=user.id,
                               acquired_at=now, expires_at=expires)
            db.add(row)
        else:
            row.device_id, row.staff_id = body.to_device_id, user.id
            row.acquired_at, row.expires_at = now, expires
            row.handoff_to = row.handoff_by = None
    elif row.device_id == body.to_device_id:
        row.handoff_to = row.handoff_by = None   # 转给它自己 = 取消让位
    else:
        row.handoff_to = body.to_device_id
        row.handoff_by = user.id
    db.commit()
    db.refresh(row)
    names = _device_names(db, {row.device_id, row.handoff_to})
    return _lease_out(row, feature, now, names, _staff_names(db, {row.staff_id}), me=None)


# ---------- AdsPower 分组归属 ----------
# 这张表原来每台机器一份（executor 的 run/env_purposes.json），谁改谁的。收到服务端
# 之后它成了唯一说明书：工作台登录时拉下来推进本机代理，本地那份退化成缓存。
#
# 出厂三条：没有它们，第一台连上来的机器会看到一张空表，然后把所有分组都当成
# 「没登记」——而代理对没登记的分组是拒绝驱动的，等于全机停摆。
_SEED_PURPOSES = (
    ("行情", "executor", "行情爬虫常驻驱动"),
    ("采购", "executor", "采购号：消息门铃 + 会话任务"),
    ("销售", "executor", "销售号：网页版上下架"),
    ("未分配", "none", "显式隔离：谁都不许驱动"),
)


def _seed_if_empty(db: Session) -> None:
    if db.query(AdsEnvPurpose).count():
        return
    now = datetime.utcnow()
    for name, owner, note in _SEED_PURPOSES:
        db.add(AdsEnvPurpose(name=name, owner=owner, note=note, updated_at=now))
    db.commit()


@router.get("/env-purposes", summary="AdsPower 分组归谁驱动", response_model=EnvPurposeListOut)
def list_env_purposes(
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    """工作台登录后拉这一份，推进本机代理。不限角色——销售的电脑也要知道边界。"""
    _seed_if_empty(db)
    rows = db.query(AdsEnvPurpose).order_by(AdsEnvPurpose.name).all()
    return EnvPurposeListOut(
        purposes=[EnvPurposeOut.model_validate(r) for r in rows],
        valid_owners=list(VALID_OWNERS),
    )


@router.put("/env-purposes", summary="改一条分组归属", response_model=EnvPurposeOut)
def upsert_env_purpose(
    body: EnvPurposeIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "分组名不能为空")
    if body.owner not in VALID_OWNERS:
        raise HTTPException(400, f"归属只能是 {' / '.join(VALID_OWNERS)}")
    row = db.get(AdsEnvPurpose, name)
    if row is None:
        row = AdsEnvPurpose(name=name)
        db.add(row)
    row.owner = body.owner
    row.note = body.note
    row.updated_by = user.id
    db.commit()
    db.refresh(row)
    return EnvPurposeOut.model_validate(row)


@router.delete("/env-purposes/{name}", summary="删一条分组归属")
def delete_env_purpose(
    name: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """删掉登记不会让那批环境消失，只会让它们变成谁也不驱动——代理对没登记的分组
    一律拒绝。所以这是个危险动作，界面上要说清楚，不是"清理一条没用的记录"。"""
    row = db.get(AdsEnvPurpose, name)
    if row is None:
        raise HTTPException(404, f"没有「{name}」这条登记")
    db.delete(row)
    db.commit()
    return {"ok": True, "name": name}


# ---------- 行情采集轮次 ----------
# 采集此前完全是本机的事，服务端收不到轮次——「昨晚那台电脑跑没跑」只有坐在它
# 跟前的人知道。这几条接口把「登记 → 认领 → 结束」搬上来，采集本身仍在端上跑：
# 一轮几十分钟、中途断点续跑，做成队列会把端上跑了三个月的调度推倒重来。


def _lease_holder(db: Session, now: datetime) -> str | None:
    row = db.get(CrawlerLease, CrawlerFeature.MARKET)
    return row.device_id if row and row.held_at(now) else None


def _pending_run_id(db: Session, device_id: str) -> str | None:
    row = (
        db.query(MarketCrawlRun)
        .filter(MarketCrawlRun.device_id == device_id,
                MarketCrawlRun.status == CrawlRunStatus.PENDING)
        .order_by(MarketCrawlRun.created_at)
        .first()
    )
    return row.id if row else None


def _run_out(db: Session, row: MarketCrawlRun) -> CrawlRunOut:
    out = CrawlRunOut.model_validate(row)
    out.device_name = _device_names(db, {row.device_id}).get(row.device_id) if row.device_id else None
    out.staff_name = _staff_names(db, {row.staff_id}).get(row.staff_id) if row.staff_id else None
    # 现场取回状态跟着轮次一起给：界面据此决定显示「取回现场」按钮、「等那台电脑
    # 上线」、还是下载链接。分两次查会让列表出现「按钮闪一下变成链接」。
    snap = (
        db.query(CrawlSnapshotRequest)
        .filter(CrawlSnapshotRequest.run_id == row.id,
                CrawlSnapshotRequest.status != SnapshotRequestStatus.CANCELLED)
        .order_by(CrawlSnapshotRequest.created_at.desc())
        .first()
    )
    if snap is None:
        # 取不到的那条也要给，否则界面会一直显示「取回现场」，人会反复点
        snap = (
            db.query(CrawlSnapshotRequest)
            .filter(CrawlSnapshotRequest.run_id == row.id)
            .order_by(CrawlSnapshotRequest.created_at.desc())
            .first()
        )
    out.snapshot = _snapshot_out(snap).model_dump(mode="json") if snap else None
    return out


@router.post("/crawl/runs", summary="发起一轮行情采集", response_model=CrawlRunOut)
def create_crawl_run(
    body: CrawlRunCreateIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """登记一轮。两种来路都走这条：

    - 管理员在任意一台点「跑一轮」→ 派给当前持有行情爬虫租约的那台电脑；
    - 端上到点自动跑，跑之前先来登记一轮（trigger=schedule）。

    不指定 device_id 就派给租约持有者——爬虫本来就只能有一台在跑，指给别人
    那台也不会认领。
    """
    now = datetime.utcnow()
    device_id = body.device_id or _lease_holder(db, now)
    if not device_id:
        raise HTTPException(409, "现在没有电脑持有行情爬虫，先在爬虫开关页把它打开")
    if db.get(WorkbenchDevice, device_id) is None:
        raise HTTPException(404, "这台电脑还没登记过")
    # 已经有一轮在等或在跑就不再排：采集是独占的，排队只会让人以为点了两次会快些
    existing = (
        db.query(MarketCrawlRun)
        .filter(MarketCrawlRun.device_id == device_id,
                MarketCrawlRun.status.in_((CrawlRunStatus.PENDING, CrawlRunStatus.RUNNING)))
        .first()
    )
    if existing:
        raise HTTPException(409, f"这台电脑已经有一轮在{'跑' if existing.status == CrawlRunStatus.RUNNING else '排队'}了")

    row = MarketCrawlRun(
        device_id=device_id,
        trigger=body.trigger if body.trigger in ("manual", "schedule") else "manual",
        staff_id=user.id,
        local_run_id=body.local_run_id,
        offline_started=bool(body.offline_started),
        created_at=now,
    )
    # 端上离线先跑、事后补登记的：它已经在跑了，不该再等人认领
    if body.offline_started:
        row.status = CrawlRunStatus.RUNNING
        row.started_at = now
    db.add(row)
    db.commit()
    db.refresh(row)
    return _run_out(db, row)


@router.post("/crawl/runs/{run_id}/claim", summary="认领这一轮", response_model=CrawlRunOut)
def claim_crawl_run(
    run_id: str,
    body: CrawlRunClaimIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    """端上开跑前认领。认领要过两道：这轮是派给你的，而且爬虫租约也在你手上。

    只看派给谁不够——派单之后租约可能已经转走了，那台电脑不该再跑。
    """
    now = datetime.utcnow()
    row = db.get(MarketCrawlRun, run_id)
    if row is None:
        raise HTTPException(404, "没有这一轮")
    if row.status != CrawlRunStatus.PENDING:
        raise HTTPException(409, f"这一轮已经是 {row.status} 了，不能再认领")
    if row.device_id != body.device_id:
        raise HTTPException(409, "这一轮不是派给这台电脑的")
    if _lease_holder(db, now) != body.device_id:
        raise HTTPException(409, "行情爬虫已经不归这台电脑了，请勿开跑")
    row.status = CrawlRunStatus.RUNNING
    row.started_at = now
    row.local_run_id = body.local_run_id or row.local_run_id
    db.commit()
    db.refresh(row)
    return _run_out(db, row)


@router.post("/crawl/runs/{run_id}/finish", summary="上报这一轮的结果", response_model=CrawlRunOut)
def finish_crawl_run(
    run_id: str,
    body: CrawlRunFinishIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    """跑完上报。**不校验租约**：跑到一半租约被转走是常事（管理员改主意了），
    但这一轮的结果照样要记下来——丢掉它等于这轮白跑还查不到。"""
    row = db.get(MarketCrawlRun, run_id)
    if row is None:
        raise HTTPException(404, "没有这一轮")
    if row.device_id != body.device_id:
        raise HTTPException(409, "这一轮不是这台电脑在跑")
    if row.status in (CrawlRunStatus.SUCCESS, CrawlRunStatus.FAILED):
        return _run_out(db, row)          # 重复上报当成功——端上重试不该报错
    row.status = CrawlRunStatus.SUCCESS if body.ok else CrawlRunStatus.FAILED
    row.total, row.success, row.failed = body.total, body.success, body.failed
    row.empty, row.invalid_price, row.risk_control = body.empty, body.invalid_price, body.risk_control
    row.reason = (body.reason or "")[:300] or None
    row.finished_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return _run_out(db, row)


@router.get("/crawl/runs", summary="最近几轮采集", response_model=CrawlRunListOut)
def list_crawl_runs(
    limit: int = 20,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    rows = (
        db.query(MarketCrawlRun)
        .order_by(MarketCrawlRun.created_at.desc())
        .limit(max(1, min(100, limit)))
        .all()
    )
    return CrawlRunListOut(runs=[_run_out(db, r) for r in rows])


# ---------- 取回某一轮的现场 ----------
# 快照是整页 DOM，一个型号一轮最多 12 份。全量传是 GB 级的量，而绝大多数永远不会
# 有人看——只有出了事那几轮才有人想看。所以默认不传，要看再取。
#
# 做成「待办」而不是「在线推送」：要看的时候往往正是出事的时候，那台电脑很可能
# 恰好不在线。待办让端上每次心跳问一句「有没有要我传的」，在线就传、不在线下次
# 开机补传，一条路覆盖两种情况。手法搬自群控的 gc_log_request。

_SNAPSHOT_DIR = "crawl-snapshots"


def _pending_snapshot(db: Session, device_id: str) -> dict | None:
    row = (
        db.query(CrawlSnapshotRequest)
        .filter(CrawlSnapshotRequest.device_id == device_id,
                CrawlSnapshotRequest.status == SnapshotRequestStatus.PENDING)
        .order_by(CrawlSnapshotRequest.created_at)
        .first()
    )
    if row is None:
        return None
    return {"id": row.id, "run_id": row.run_id, "local_run_id": row.local_run_id}


def _snapshot_out(row: CrawlSnapshotRequest) -> SnapshotRequestOut:
    out = SnapshotRequestOut.model_validate(row)
    if row.status == SnapshotRequestStatus.UPLOADED and row.object_key:
        from app.services.oss import sign_download_url

        try:
            out.download_url = sign_download_url(row.object_key, expires=3600)
        except Exception:
            out.download_url = None      # OSS 没配好时不该把整条记录变成 500
    return out


@router.post("/crawl/runs/{run_id}/snapshot", summary="取回这一轮的现场", response_model=SnapshotRequestOut)
def request_snapshot(
    run_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    run = db.get(MarketCrawlRun, run_id)
    if run is None:
        raise HTTPException(404, "没有这一轮")
    if not run.device_id:
        raise HTTPException(409, "这一轮没有记录是哪台电脑跑的，取不了")

    # 同一轮重复点不再排队：现场是确定的东西，取一次就够，重复请求只会让那台
    # 电脑反复打包上传同一批文件。已经传回来的直接把那条还给调方。
    existing = (
        db.query(CrawlSnapshotRequest)
        .filter(CrawlSnapshotRequest.run_id == run_id,
                CrawlSnapshotRequest.status != SnapshotRequestStatus.CANCELLED)
        .order_by(CrawlSnapshotRequest.created_at.desc())
        .first()
    )
    if existing:
        return _snapshot_out(existing)

    row = CrawlSnapshotRequest(
        run_id=run_id,
        device_id=run.device_id,
        local_run_id=run.local_run_id,
        requested_by=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _snapshot_out(row)


@router.get("/crawl/runs/{run_id}/snapshot", summary="看这一轮的现场取回状态",
            response_model=SnapshotRequestOut | None)
def get_snapshot(
    run_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    row = (
        db.query(CrawlSnapshotRequest)
        .filter(CrawlSnapshotRequest.run_id == run_id,
                CrawlSnapshotRequest.status != SnapshotRequestStatus.CANCELLED)
        .order_by(CrawlSnapshotRequest.created_at.desc())
        .first()
    )
    return _snapshot_out(row) if row else None


@router.post("/crawl/snapshots/{request_id}/upload", summary="端上回传现场")
async def upload_snapshot(
    request_id: str,
    device_id: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    """端上把打好的包传回来。**不校验租约**：取现场是事后的事，那一轮早跑完了，
    租约在谁手上跟这件事无关。"""
    row = db.get(CrawlSnapshotRequest, request_id)
    if row is None:
        raise HTTPException(404, "没有这条取回待办")
    if row.device_id != device_id:
        raise HTTPException(409, "这条待办不是给这台电脑的")
    if row.status == SnapshotRequestStatus.UPLOADED:
        return {"ok": True, "already": True}

    content = await file.read()
    if not content:
        raise HTTPException(400, "传上来的是空文件")

    from app.services.oss import upload_object

    result = upload_object(_SNAPSHOT_DIR, f"{row.run_id}.tar.gz", content,
                           content_type="application/gzip")
    row.object_key = result["object_key"]
    row.bytes = len(content)
    row.status = SnapshotRequestStatus.UPLOADED
    row.uploaded_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "bytes": row.bytes}


@router.post("/crawl/snapshots/{request_id}/fail", summary="端上说这份现场取不到了")
def fail_snapshot(
    request_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    """端上找不到那一轮的快照（过了 30 天保留期、或者换过电脑）时来说一声。

    不说的话这条待办会永远 PENDING，端上每拍心跳都收到它、每次都失败——
    而点过按钮的人一直在等一个不会来的东西。
    """
    row = db.get(CrawlSnapshotRequest, request_id)
    if row is None:
        raise HTTPException(404, "没有这条取回待办")
    if row.device_id != str(body.get("device_id") or ""):
        raise HTTPException(409, "这条待办不是给这台电脑的")
    row.status = SnapshotRequestStatus.CANCELLED
    row.reason = str(body.get("reason") or "端上找不到这一轮的快照")[:300]
    db.commit()
    return {"ok": True}
