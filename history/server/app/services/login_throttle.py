"""登录防暴力尝试。所有账号密码登录的门共用（admin / workbench / h5 / device / crawler / dev，
外加小程序的 bind）——这些门都走 routers/auth.py 的 _password_login，加在那一处就全覆盖了。

# 三把尺子，任何一把到线就先挡住（429），冷却完自动放开

  pair  同一账号 + 同一 IP：15 分钟内错 5 次 → 锁 15 分钟；再犯翻倍，最长 12 小时
        主力。挡的是对着一个账号猜密码。
  ip    同一 IP，只数「账号不存在」：15 分钟内 20 次 → 这个 IP 锁 30 分钟
        挡拿一个 IP 撞一批账号（撞库）。只数不存在的账号，是因为办公室共用一个出口 IP：
        某台执行端配错了密码反复重试，只该锁它自己那一对，不能把整个办公室锁在外面。
  user  同一账号，不管哪个 IP：1 小时内错 30 次 → 这个账号锁 30 分钟
        挡换着 IP 猜同一个账号。放得很宽：单锁账号的话，别人随手输错几次就能把员工锁在外面。

# 几条约定

  - 账号不存在也照样计数、照样锁，对外提示一模一样：「被锁了」不能变成「这个账号存在」。
  - 锁住期间不验密码直接回 429：既不让人接着猜，也省掉密码哈希的 CPU。
  - 先记数再验密码（admit → failed / succeeded），并发打进来的请求也只有额度内的能验到密码。
  - 登录成功清掉这个账号的 pair / user 计数；ip 计数不清（不然拿自己的账号登一下就能洗掉）。
  - 计数放 MySQL：生产 erp-api 跑 2 个 worker，放进程内存等于各算各的、限额翻倍，重启还清零。
    每次计数是一条 INSERT … ON DUPLICATE KEY UPDATE，用 LAST_INSERT_ID 取回自己这一次的数：
    并发时不丢数、不多放，新键上也不会撞间隙锁死锁（真撞上了重来）。
  - 计数表本身出意外（表没建、库抖了）就放行这次登录、记日志：挡不住几次猜测，总比所有人都登不上强。
  - 出问题能关：.env 里 LOGIN_THROTTLE_ENABLED=false，重启生效。手工解锁就删 login_throttle 里对应的行。
"""

import logging
import math
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, case, delete, insert, or_, select, text, update
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.models.login_throttle import LoginThrottle
from app.models.staff import new_uuid


@dataclass(frozen=True)
class Policy:
    max_failures: int
    window: timedelta
    lock: timedelta
    max_lock: timedelta
    escalate: bool = False


POLICIES = {
    "pair": Policy(5, timedelta(minutes=15), timedelta(minutes=15), timedelta(hours=12), escalate=True),
    "ip": Policy(20, timedelta(minutes=15), timedelta(minutes=30), timedelta(minutes=30)),
    "user": Policy(30, timedelta(hours=1), timedelta(minutes=30), timedelta(minutes=30)),
}

# 安静这么久不再犯，锁的翻倍从头算
LOCK_DECAY = timedelta(hours=24)
LOOPBACK = {"127.0.0.1", "::1", "localhost"}

_t = LoginThrottle.__table__
log = logging.getLogger(__name__)


def _now() -> datetime:
    # 对齐到秒：MySQL DATETIME 存的时候会把微秒四舍五入，不对齐的话「还要等几分钟」会多算一分钟
    return datetime.utcnow().replace(microsecond=0)


def client_ip(request) -> str | None:
    """真实客户端 IP；拿不准就返回 None（只按账号计数，不按 IP）。

    nginx 在本机，经它转发的请求对端是 127.0.0.1、带 X-Real-IP（nginx 填的 $remote_addr，客户端伪造不了）。
    uvicorn 默认也会按本机代理的 X-Forwarded-For 改写对端地址，所以对端不是本机时直接用对端。
    直连 8000 端口的请求对端就是真实地址，这时不看任何请求头——那是可以随便填的。
    """
    if request is None:
        return None
    peer = request.client.host if request.client else None
    if peer and peer not in LOOPBACK:
        return peer
    real = (request.headers.get("x-real-ip") or "").strip()
    if real and real not in LOOPBACK:
        return real[:64]
    return None


def _name(username: str) -> str:
    return (username or "").strip().lower()[:64]


def _subjects(username: str, ip: str | None) -> list[tuple[str, str]]:
    name = _name(username)
    out = [("user", name)]
    if ip:
        out += [("pair", f"{name}|{ip}"), ("ip", ip)]
    return out


def _match(keys):
    return or_(*[and_(_t.c.scope == scope, _t.c.subject == subject) for scope, subject in keys])


def _raise_if_locked(db: Session, keys, now: datetime) -> None:
    rows = db.execute(select(_t.c.locked_until).where(_match(keys)).where(_t.c.locked_until > now)).all()
    if rows:
        wait = max(r.locked_until for r in rows) - now
        minutes = max(1, math.ceil(wait.total_seconds() / 60))
        raise HTTPException(status_code=429, detail=f"登录失败次数太多，{minutes} 分钟后再试")


def check(db: Session, username: str, ip: str | None) -> None:
    """只查锁，锁着就抛 429。给要先做别的事（比如小程序 bind 要换微信 code）的门提前挡一下用。"""
    if not settings.login_throttle_enabled:
        return
    try:
        _raise_if_locked(db, _subjects(username, ip), _now())
    except SQLAlchemyError:
        _fail_open(db, "check")


def _counted(username: str, ip: str | None, known: bool):
    """这次尝试算进哪几把尺子：ip 只数不存在的账号，user 只数存在的账号，pair 都数。"""
    for scope, subject in _subjects(username, ip):
        if scope == "ip" and known:
            continue
        if scope == "user" and not known:
            continue
        yield scope, subject


# MySQL：一条语句完成「没有就建、有就加一」，LAST_INSERT_ID(expr) 记下这次加完的值，
# 紧接着 SELECT LAST_INSERT_ID() 拿到的就是自己这一次的数（每个连接各记各的），
# 并发时每个请求拿到的都是自己那个数。先 UPDATE 落空再 INSERT 的写法在新键上会撞间隙锁死锁。
# SET 的顺序有讲究：MySQL 从左往右算，后面的列看得到前面刚改的值，所以 updated_at 放最后。
_BUMP_MYSQL = text("""
INSERT INTO login_throttle (id, scope, subject, failures, window_start, lock_count, updated_at)
VALUES (:id, :scope, :subject, LAST_INSERT_ID(1), :now, 0, :now)
ON DUPLICATE KEY UPDATE
  failures = LAST_INSERT_ID(CASE WHEN window_start < :cutoff THEN 1 ELSE failures + 1 END),
  window_start = CASE WHEN window_start < :cutoff THEN :now ELSE window_start END,
  lock_count = CASE WHEN updated_at < :decay THEN 0 ELSE lock_count END,
  updated_at = :now
""")


def _bump_mysql(db: Session, scope: str, subject: str, now: datetime) -> int:
    p = POLICIES[scope]
    db.execute(_BUMP_MYSQL, {
        "id": new_uuid(), "scope": scope, "subject": subject, "now": now,
        "cutoff": now - p.window, "decay": now - LOCK_DECAY,
    })
    n = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
    db.commit()
    return int(n or 1)


def _bump_generic(db: Session, scope: str, subject: str, now: datetime) -> int:
    """测试用的 SQLite 走这条：没有 LAST_INSERT_ID，就先改后读（单进程测试里不存在并发）。"""
    p = POLICIES[scope]
    where = and_(_t.c.scope == scope, _t.c.subject == subject)
    stale = _t.c.window_start < now - p.window
    bump = update(_t).where(where).ordered_values(
        (_t.c.failures, case((stale, 1), else_=_t.c.failures + 1)),
        (_t.c.window_start, case((stale, now), else_=_t.c.window_start)),
        (_t.c.lock_count, case((_t.c.updated_at < now - LOCK_DECAY, 0), else_=_t.c.lock_count)),
        (_t.c.updated_at, now),
    )
    if db.execute(bump).rowcount == 0:
        try:
            db.execute(insert(_t).values(
                id=new_uuid(), scope=scope, subject=subject, failures=1,
                window_start=now, lock_count=0, updated_at=now,
            ))
        except IntegrityError:
            db.rollback()
            db.execute(bump)
    db.commit()
    row = db.execute(select(_t.c.failures).where(where)).first()
    return row.failures if row else 1


def _bump(db: Session, scope: str, subject: str, now: datetime) -> int:
    """这一次尝试记上，返回记上之后窗口里的次数。遇到死锁 / 锁等待超时重来，最多三次。"""
    fn = _bump_mysql if db.get_bind().dialect.name == "mysql" else _bump_generic
    for attempt in range(3):
        try:
            return fn(db, scope, subject, now)
        except OperationalError as e:
            code = e.orig.args[0] if e.orig is not None and e.orig.args else None
            db.rollback()
            if code not in (1213, 1205) or attempt == 2:
                raise
            time.sleep(0.02 * (attempt + 1))
    return 1


def _lock(db: Session, scope: str, subject: str, now: datetime) -> None:
    p = POLICIES[scope]
    where = and_(_t.c.scope == scope, _t.c.subject == subject)
    row = db.execute(select(_t.c.lock_count).where(where)).first()
    lock_count = row.lock_count if row else 0
    until = now + min(p.lock * (2 ** lock_count) if p.escalate else p.lock, p.max_lock)
    # 只锁一次：并发里同时到线的几个请求，只有第一个真去上锁（翻倍也只算一次）。
    # 计数不清零、留在线上：还在路上的请求接着往上加，照样超额被挡；
    # 计数窗口设成和锁同时到期：锁一解，下一次尝试从 1 重新数，不会一解锁就又锁上。
    db.execute(
        update(_t).where(where).where(or_(_t.c.locked_until.is_(None), _t.c.locked_until <= now)).ordered_values(
            (_t.c.locked_until, until),
            (_t.c.lock_count, _t.c.lock_count + 1),
            (_t.c.failures, p.max_failures),
            (_t.c.window_start, until - p.window),
        )
    )
    db.commit()


def admit(db: Session, username: str, ip: str | None, *, known: bool) -> None:
    """验密码之前调：先查锁，再把这一次尝试记上；这次已经超出额度就直接 429，不验密码。

    先记数再验，是为了挡并发：一口气同时打进几十个请求的话，「验完再记」会让它们全都赶在
    锁生效之前验完密码。先记数的话第 6 个起就进不去了。正常输错 4 次、第 5 次输对不受影响。
    """
    if not settings.login_throttle_enabled:
        return
    now = _now()
    try:
        _raise_if_locked(db, _subjects(username, ip), now)
        over = False
        for scope, subject in _counted(username, ip, known):
            p = POLICIES[scope]
            if _bump(db, scope, subject, now) > p.max_failures:
                _lock(db, scope, subject, now)
                over = True
        if over:
            _raise_if_locked(db, _subjects(username, ip), now)
    except SQLAlchemyError:
        _fail_open(db, "admit")


def failed(db: Session, username: str, ip: str | None, *, known: bool) -> None:
    """密码错 / 查无此人之后调（这一次在 admit 里已经记过数）：到线就上锁。"""
    if not settings.login_throttle_enabled:
        return
    now = _now()
    try:
        for scope, subject in _counted(username, ip, known):
            p = POLICIES[scope]
            row = db.execute(
                select(_t.c.failures).where(_t.c.scope == scope, _t.c.subject == subject)
            ).first()
            if row and row.failures >= p.max_failures:
                _lock(db, scope, subject, now)
        if random.random() < 0.02:
            # 顺手清掉两天没动静、也没锁着的行，表不会越长越大
            db.execute(delete(_t).where(_t.c.updated_at < now - timedelta(days=2)).where(
                or_(_t.c.locked_until.is_(None), _t.c.locked_until < now)
            ))
            db.commit()
    except SQLAlchemyError:
        _fail_open(db, "failed")


def succeeded(db: Session, username: str, ip: str | None) -> None:
    """密码验对之后调：清掉这个账号的 pair / user 计数（ip 的不清，不然拿自己账号登一下就能洗掉）。"""
    if not settings.login_throttle_enabled:
        return
    keys = [k for k in _subjects(username, ip) if k[0] in ("pair", "user")]
    try:
        db.execute(delete(_t).where(_match(keys)))
        db.commit()
    except SQLAlchemyError:
        _fail_open(db, "succeeded")


def _fail_open(db: Session, where: str) -> None:
    """计数表本身出了意外（表没建、库抖了）：放行这次登录，记一笔。
    挡不住几次猜测，总比所有人都登不上强——小程序、后台、执行端都走这几个门。"""
    log.exception("login_throttle.%s 出错，本次不限流", where)
    try:
        db.rollback()
    except SQLAlchemyError:
        pass
