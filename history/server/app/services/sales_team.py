"""销售协同（11-14 对齐销售工作台交付包）：主管加派的任务、买家消息转来的协同请求。

主管加派（主管 = 管理员）：
- 加派必须写要求、范围（做到哪算完）、交付时间、派给谁；图片这类系统自动派的活不用加派。
- 状态：待接收 → 执行中 →（等待外部 / 受阻待接管）→ 待验收 →（退回补正 → 待验收）→ 已验收。
  等待外部要写等谁、等什么；受阻要写卡在哪；交验收要写做了什么；退回要写意见。
- 改派必须写转交上下文（已做 / 未完成 / 下一步），接手的人从「待接收」开始，第一眼看到这段话。
- 「今天」里：接手人看到待接收、退回补正、过了交付时间的（红），执行中、等待外部的（黄）；
  主管看到待验收、受阻待接管的（红）。

协同请求：谁都能提（外包客服、同事），写一句要帮什么，带上会话 / 货号。
- 先给会话那个号的负责人（找不到就给所有在岗销售）；60 秒没人接，转给所有在岗销售；
  再 60 秒没人接，转主管（管理员也看得到，标红）。阶段按提出时间现算，不靠定时任务。
- 谁先点「我来接」就是谁的，别人那边立刻消失；接了的人做完点「做完了」。

遇到没见过的情况（交付包 D4）：谁都能报，写一句话（≥4 个字）。主管的「今天」里红着，直到回复处理办法；
回复时可以记成规则，大家在「没见过的情况」页都看得到。提的人没看过回复前，他的「今天」里黄着。

提给开发不在这里：需求只走禅道（11-09 定），页面上的按钮直接打开禅道「销售工作台」产品的提 Bug / 提需求页。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.enums import StaffRole, StaffStatus
from app.models import EventLog, SalesCollab, SalesReport, SalesTask, Staff
from app.services.staff_lookup import map_staff_names

CN_OFFSET = timedelta(hours=8)
URL_TASK = "/pages/sales-workbench/task/index?id={id}"
URL_CHAT_DETAIL = "/pages/gc-chat/detail/index?id={id}"
URL_ITEM = "/pages/sales-goods/item/index?code={code}"
URL_REPORT = "/pages/sales-workbench/report/index"
H5 = "http://127.0.0.1:8000"
SUP_NOTIFIED = "collab_sup_notified"
REPORT_MIN = 4

OPEN, DONE_STATES = "待接收", ("已验收", "已撤销")
# 动作 → (谁能做, 从哪些状态, 到什么状态, 必填)
ACTIONS = {
    "accept": ("assignee", ("待接收",), "执行中", ()),
    "wait": ("assignee", ("执行中",), "等待外部", ("wait_who", "wait_why")),
    "resume": ("assignee", ("等待外部",), "执行中", ()),
    "block": ("assignee", ("执行中", "等待外部"), "受阻待接管", ("note",)),
    "submit": ("assignee", ("执行中", "退回补正"), "待验收", ("note",)),
    "approve": ("sup", ("待验收",), "已验收", ()),
    "reject": ("sup", ("待验收",), "退回补正", ("note",)),
    "takeover": ("sup", ("受阻待接管",), "执行中", ()),
    "reassign": ("sup", ("待接收", "执行中", "等待外部", "受阻待接管", "退回补正"), OPEN, ("to", "handoff")),
    "cancel": ("sup", ("待接收", "执行中", "等待外部", "受阻待接管", "待验收", "退回补正"), "已撤销", ()),
}
ACTION_LABEL = {
    "create": "派出", "accept": "接收", "wait": "等待外部", "resume": "恢复执行", "block": "受阻",
    "submit": "交验收", "approve": "验收通过", "reject": "退回补正", "takeover": "接管恢复",
    "reassign": "改派", "cancel": "撤销",
}
REQUIRED_LABEL = {
    "wait_who": "写等谁（仓管 / 客户 / 同行）", "wait_why": "写等什么", "note": "写一句话说明",
    "to": "选派给谁", "handoff": "写转交上下文：已做 / 未完成 / 下一步",
}

# 协同请求：每一段等多久
COLLAB_STEP_SEC = 60
# 提了这么久还没人接就不再弹（主管那边也不再红），留在记录里
COLLAB_GIVE_UP = timedelta(hours=12)
# 我提的被人接了，在我这边留这么久告诉我谁接了
COLLAB_TAKEN_SHOW = timedelta(minutes=10)


def _is_sup(user: Staff) -> bool:
    return user.role == StaffRole.ADMIN


def _cn(dt: datetime | None) -> str:
    return f"{(dt + CN_OFFSET):%m-%d %H:%M}" if dt else ""


def _forget_badges() -> None:
    # 一条任务牵涉派的人、接的人、所有主管，红点缓存整个清掉（60 秒的缓存，清了只是下一次多算一遍）
    from app.services.sales_workbench import _badge_cache

    _badge_cache.clear()


def team(db: Session) -> list[dict]:
    """能派给谁：在职的销售。"""
    rows = (
        db.query(Staff)
        .filter(Staff.role == StaffRole.SALES, Staff.status == StaffStatus.ACTIVE, Staff.deleted_at.is_(None))
        .order_by(Staff.name)
        .all()
    )
    return [{"id": s.id, "name": s.name or s.username} for s in rows]


def parse_due(text: str) -> datetime:
    """「2026-11-14 18:00」（北京时间）→ UTC。"""
    text = str(text or "").strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt) - CN_OFFSET
        except ValueError:
            continue
    raise HTTPException(status_code=400, detail="交付时间要写清哪天几点")


def _log(t: SalesTask, user: Staff, action: str, note: str = "") -> None:
    t.log = [*(t.log or []), {"at": datetime.utcnow().isoformat(timespec="seconds"), "by": user.name or user.username,
                              "action": ACTION_LABEL.get(action, action), "note": note}]


def _active_sales(db: Session, staff_id: str) -> Staff:
    s = db.get(Staff, staff_id)
    if not s or s.status != StaffStatus.ACTIVE or s.deleted_at is not None or s.role not in (StaffRole.SALES, StaffRole.ADMIN):
        raise HTTPException(status_code=400, detail="派给的人不在职或不是销售")
    return s


def create_task(db: Session, user: Staff, body: dict) -> dict:
    title = str(body.get("title") or "").strip()
    scope = str(body.get("scope") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="写清要做什么")
    if not scope:
        raise HTTPException(status_code=400, detail="写清范围：做到哪算完（对象、地区、品牌……）")
    if not body.get("due"):
        raise HTTPException(status_code=400, detail="加派必须写交付时间")
    due = parse_due(body.get("due"))
    if due < datetime.utcnow():
        raise HTTPException(status_code=400, detail="交付时间已经过了")
    to = _active_sales(db, str(body.get("to") or ""))
    t = SalesTask(title=title[:256], scope=scope, due_at=due, sku_code=(str(body.get("sku_code") or "").strip() or None),
                  assignee_id=to.id, created_by_id=user.id, state=OPEN, log=[])
    _log(t, user, "create", f"派给 {to.name or to.username}")
    db.add(t)
    db.commit()
    _forget_badges()
    return task_out(db, t, user)


def task_out(db: Session, t: SalesTask, user: Staff, names: dict | None = None) -> dict:
    names = names if names is not None else map_staff_names(db, {t.assignee_id, t.created_by_id})
    now = datetime.utcnow()
    late = t.state not in DONE_STATES and t.state != "待验收" and now > t.due_at
    mine = t.assignee_id == user.id
    can = [a for a, (who, frm, _, _) in ACTIONS.items()
           if t.state in frm and ((who == "assignee" and mine) or (who == "sup" and _is_sup(user)))]
    return {
        "id": t.id,
        "title": t.title,
        "scope": t.scope,
        "due": _cn(t.due_at),
        "late": late,
        "sku_code": t.sku_code,
        "state": t.state,
        "assignee_id": t.assignee_id,
        "assignee": names.get(t.assignee_id, ""),
        "created_by": names.get(t.created_by_id, ""),
        "created_at": _cn(t.created_at),
        "wait_who": t.wait_who,
        "wait_why": t.wait_why,
        "wait_until": t.wait_until,
        "note": t.note,
        "handoff": t.handoff,
        "log": [{**x, "at": _cn(datetime.fromisoformat(x["at"]))} for x in t.log or []],
        "can": can,
        "url": URL_TASK.format(id=t.id),
    }


def get_task(db: Session, user: Staff, task_id: str) -> SalesTask:
    t = db.get(SalesTask, task_id)
    if not t or (t.assignee_id != user.id and not _is_sup(user)):
        raise HTTPException(status_code=404, detail="任务不存在或不是派给你的")
    return t


def act(db: Session, user: Staff, task_id: str, action: str, body: dict) -> dict:
    t = get_task(db, user, task_id)
    if action not in ACTIONS:
        raise HTTPException(status_code=400, detail="不认识的操作")
    who, frm, to_state, need = ACTIONS[action]
    if who == "assignee" and t.assignee_id != user.id:
        raise HTTPException(status_code=403, detail="只有接手的人能做这一步")
    if who == "sup" and not _is_sup(user):
        raise HTTPException(status_code=403, detail="这一步要主管来")
    if t.state not in frm:
        raise HTTPException(status_code=400, detail=f"任务现在是「{t.state}」，不能{ACTION_LABEL[action]}")
    vals = {k: str(body.get(k) or "").strip() for k in ("wait_who", "wait_why", "wait_until", "note", "to", "handoff")}
    for k in need:
        if not vals[k]:
            raise HTTPException(status_code=400, detail=REQUIRED_LABEL[k])
    note = vals["note"]
    if action == "wait":
        t.wait_who, t.wait_why, t.wait_until = vals["wait_who"][:64], vals["wait_why"][:256], vals["wait_until"][:32] or None
        note = f"等 {t.wait_who}：{t.wait_why}" + (f"，{t.wait_until} 复查" if t.wait_until else "")
    elif action == "resume":
        t.wait_who = t.wait_why = t.wait_until = None
    elif action in ("block", "submit", "reject", "takeover") and note:
        t.note = note
    elif action == "reassign":
        to = _active_sales(db, vals["to"])
        if to.id == t.assignee_id:
            raise HTTPException(status_code=400, detail="还是派给同一个人，不用改派")
        t.assignee_id, t.handoff = to.id, vals["handoff"]
        t.wait_who = t.wait_why = t.wait_until = None
        note = f"改派给 {to.name or to.username}：{vals['handoff']}"
    t.state = to_state
    if to_state in DONE_STATES:
        t.done_at = datetime.utcnow()
    _log(t, user, action, note)
    db.commit()
    _forget_badges()
    return task_out(db, t, user)


def team_tasks(db: Session, user: Staff) -> list[dict]:
    """主管看：没完的全部 + 最近 7 天完的；先要主管动手的，再按交付时间。"""
    since = datetime.utcnow() - timedelta(days=7)
    rows = (
        db.query(SalesTask)
        .filter(or_(SalesTask.state.notin_(DONE_STATES), SalesTask.done_at >= since))
        .order_by(SalesTask.due_at)
        .all()
    )
    names = map_staff_names(db, {r.assignee_id for r in rows} | {r.created_by_id for r in rows})
    order = {"待验收": 0, "受阻待接管": 1}
    out = [task_out(db, r, user, names) for r in rows]
    return sorted(out, key=lambda x: (x["state"] in DONE_STATES, order.get(x["state"], 2), not x["late"]))


def today_tasks(db: Session, user: Staff) -> list[dict]:
    """并进「今天」的几行（格式同 sales_workbench.build_tasks）。"""
    q = db.query(SalesTask).filter(SalesTask.state.notin_(DONE_STATES))
    if _is_sup(user):
        q = q.filter(or_(SalesTask.assignee_id == user.id, SalesTask.state.in_(("待验收", "受阻待接管"))))
    else:
        q = q.filter(SalesTask.assignee_id == user.id)
    rows = q.order_by(SalesTask.due_at).all()
    names = map_staff_names(db, {r.assignee_id for r in rows})
    now = datetime.utcnow()
    out = []
    for t in rows:
        mine = t.assignee_id == user.id
        if mine and t.state in ("待验收", "受阻待接管") and not _is_sup(user):
            continue  # 在等主管，不占我的清单
        late = now > t.due_at and t.state != "待验收"
        if not mine or t.state in ("待验收", "受阻待接管"):
            level, button = "red", "去验收" if t.state == "待验收" else "去接管"
            sub = f"{names.get(t.assignee_id, '')} {'交上来了，等你验收' if t.state == '待验收' else '卡住了：' + (t.note or '')}"
        else:
            level = "red" if t.state in (OPEN, "退回补正") or late else "yellow"
            button = "看要求"
            sub = {OPEN: "新派给你的，先点开接收", "退回补正": f"被退回：{t.note or ''}",
                   "等待外部": f"在等 {t.wait_who or '外部'}：{t.wait_why or ''}"}.get(t.state, "做完点「交验收」")
            if t.handoff and t.state == OPEN:
                sub = f"改派过来的，先看上一个人留的话：{t.handoff}"
        out.append({
            "key": f"assigned:{t.id}",
            "kind": "assigned",
            "level": level,
            "tag": "主管加派",
            "title": t.title,
            "sub": f"{sub} · 交付 {_cn(t.due_at)}{'（已过）' if late else ''}",
            "thumb": None,
            "url": URL_TASK.format(id=t.id),
            "button": button,
            "at": t.due_at.isoformat(),
        })
    return out


# ---------- 协同请求 ----------

def create_collab(db: Session, user: Staff, body: dict) -> dict:
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="写一句要同事帮什么")
    owner_names = [str(x) for x in body.get("owner_names") or [] if x]
    to_id = None
    if owner_names:
        s = (
            db.query(Staff)
            .filter(Staff.name.in_(owner_names), Staff.status == StaffStatus.ACTIVE, Staff.deleted_at.is_(None),
                    Staff.id != user.id)
            .first()
        )
        to_id = s.id if s else None
    c = SalesCollab(title=title[:256], detail=str(body.get("detail") or "").strip() or None,
                    sku_code=str(body.get("sku_code") or "").strip() or None,
                    conversation_id=str(body.get("conversation_id") or "").strip() or None,
                    created_by_id=user.id, to_id=to_id, state="open", created_at=datetime.utcnow())
    db.add(c)
    db.commit()
    # 只有开着页面的人轮询得到：手机锁屏、电脑没开工作台就谁都不知道，买家一直等。先叫一声负责人
    if to_id:
        _ping([db.get(Staff, to_id)], "同事请你帮忙", f"{user.name or user.username}：{c.title}", c)
    return collab_out(c, map_staff_names(db, {c.created_by_id, c.to_id}), datetime.utcnow())


def _ping(staffs: list[Staff | None], title: str, body: str, c: SalesCollab) -> None:
    """钉钉 / 企微叫一声；发不出去不影响请求本身。"""
    from app.services import staff_notify

    url = H5 + (URL_CHAT_DETAIL.format(id=c.conversation_id) if c.conversation_id
                else URL_ITEM.format(code=c.sku_code) if c.sku_code else "/pages/sales-workbench/index")
    for s in staffs:
        try:
            staff_notify.send(s, title, body, url=url, button="去看")
        except Exception:  # noqa: BLE001
            pass


def _escalate(db: Session, rows: list[SalesCollab], now: datetime) -> None:
    """转到主管这一段的，叫一声主管（每条一次，EventLog 记着）。靠谁在轮询顺带做，没人开页面就等下一个人打开。"""
    sup_rows = [c for c in rows if c.state == "open" and stage_of(c, now)[0] == "sup"]
    if not sup_rows:
        return
    done = {e for (e,) in db.query(EventLog.entity_id).filter(
        EventLog.event_type == SUP_NOTIFIED, EventLog.entity_id.in_([c.id for c in sup_rows]))}
    todo = [c for c in sup_rows if c.id not in done]
    if not todo:
        return
    for c in todo:
        db.add(EventLog(event_type=SUP_NOTIFIED, entity_type="sales_collab", entity_id=c.id, occurred_at=now))
    db.commit()
    sups = db.query(Staff).filter(Staff.role == StaffRole.ADMIN, Staff.status == StaffStatus.ACTIVE,
                                  Staff.deleted_at.is_(None)).all()
    names = map_staff_names(db, {c.created_by_id for c in todo})
    for c in todo:
        _ping([s for s in sups if s.id != c.created_by_id], "协同请求没人接",
              f"{names.get(c.created_by_id, '')}：{c.title}（2 分钟没人接，转到你了）", c)


def close_for_conversation(db: Session, user: Staff, conversation_id: str) -> int:
    """会话里已经有人回了买家（聊天页发出去就调）：这个会话还开着 / 接了没点完的协同请求都关掉。
    原来直接在聊天页回了、没点「我来接」，请求还在所有人那里红着，最长挂 12 小时。"""
    now = datetime.utcnow()
    n = 0
    for c in db.query(SalesCollab).filter(SalesCollab.conversation_id == conversation_id,
                                          SalesCollab.state.in_(("open", "taken"))):
        c.taken_by_id = c.taken_by_id or user.id
        c.taken_at = c.taken_at or now
        c.state, c.done_at = "replied", now
        n += 1
    if n:
        db.commit()
    return n


def stage_of(c: SalesCollab, now: datetime) -> tuple[str, int]:
    """(阶段, 离下一段还有几秒)：open 先给负责人 → peer 所有在岗销售 → sup 主管。"""
    age = int((now - c.created_at).total_seconds())
    if age < COLLAB_STEP_SEC:
        return "open", COLLAB_STEP_SEC - age
    if age < 2 * COLLAB_STEP_SEC:
        return "peer", 2 * COLLAB_STEP_SEC - age
    return "sup", 0


def collab_out(c: SalesCollab, names: dict, now: datetime) -> dict:
    stage, left = stage_of(c, now)
    url = (URL_CHAT_DETAIL.format(id=c.conversation_id) if c.conversation_id
           else URL_ITEM.format(code=c.sku_code) if c.sku_code else "")
    return {
        "id": c.id,
        "title": c.title,
        "detail": c.detail,
        "sku_code": c.sku_code,
        "from": names.get(c.created_by_id, ""),
        "to": names.get(c.to_id, "") if c.to_id else "",
        "stage": stage if c.state == "open" else c.state,
        "left": left,
        "taken_by": names.get(c.taken_by_id, "") if c.taken_by_id else "",
        "at": _cn(c.created_at),
        "url": url,
    }


def _visible(c: SalesCollab, user: Staff, stage: str) -> bool:
    if c.created_by_id == user.id:
        return False  # 自己提的在「我提的」里看
    if stage == "open":
        return c.to_id == user.id if c.to_id else user.role == StaffRole.SALES
    if stage == "peer":
        return user.role == StaffRole.SALES
    return True


def live(db: Session, user: Staff, now: datetime | None = None) -> dict:
    """顶上那条：等我接的、我接了还没做完的、我提的还没人接的。轮询用，查询要轻。"""
    now = now or datetime.utcnow()
    since = now - COLLAB_GIVE_UP
    # 12 小时没人接的关掉（原来从所有人那里静默消失、库里还是 open，提的人不知道没人接）
    n = (
        db.query(SalesCollab)
        .filter(SalesCollab.state == "open", SalesCollab.created_at < since)
        .update({"state": "expired", "done_at": now}, synchronize_session=False)
    )
    if n:
        db.commit()
    rows = (
        db.query(SalesCollab)
        .filter(or_(SalesCollab.state == "open", SalesCollab.state == "taken"), SalesCollab.created_at >= since)
        .order_by(SalesCollab.created_at)
        .all()
    )
    _escalate(db, rows, now)
    # 提的人看得到结果：没人接关掉了 / 会话里有人回了买家自动关了（各留 12 小时，点「知道了」收起）
    rows += (
        db.query(SalesCollab)
        .filter(SalesCollab.created_by_id == user.id, SalesCollab.state.in_(("expired", "replied")),
                SalesCollab.done_at >= since)
        .order_by(SalesCollab.created_at)
        .all()
    )
    names = map_staff_names(db, {r.created_by_id for r in rows} | {r.to_id for r in rows} | {r.taken_by_id for r in rows})
    waiting, mine, sent = [], [], []
    for c in rows:
        if c.state in ("expired", "replied"):
            sent.append(collab_out(c, names, now))
            continue
        if c.state == "taken":
            if c.taken_by_id == user.id:
                mine.append(collab_out(c, names, now))
            elif c.created_by_id == user.id and c.taken_at and now - c.taken_at < COLLAB_TAKEN_SHOW:
                sent.append(collab_out(c, names, now))
            continue
        stage, _ = stage_of(c, now)
        if c.created_by_id == user.id:
            sent.append(collab_out(c, names, now))
        elif _visible(c, user, stage):
            waiting.append(collab_out(c, names, now))
    return {"waiting": waiting, "mine": mine, "sent": sent, "step_sec": COLLAB_STEP_SEC}


def take_collab(db: Session, user: Staff, collab_id: str) -> dict:
    # 先到先得：条件更新，两个人同时点只有一个成功
    n = (
        db.query(SalesCollab)
        .filter(SalesCollab.id == collab_id, SalesCollab.state == "open")
        .update({"state": "taken", "taken_by_id": user.id, "taken_at": datetime.utcnow()}, synchronize_session=False)
    )
    db.commit()
    c = db.get(SalesCollab, collab_id)
    if not c:
        raise HTTPException(status_code=404, detail="这条请求不存在")
    if not n:
        who = map_staff_names(db, {c.taken_by_id}).get(c.taken_by_id, "别人") if c.taken_by_id else ""
        raise HTTPException(status_code=409, detail=f"{who}已经接了" if who else "这条请求已经关了")
    return collab_out(c, map_staff_names(db, {c.created_by_id, c.to_id, c.taken_by_id}), datetime.utcnow())


def close_collab(db: Session, user: Staff, collab_id: str, action: str) -> dict:
    c = db.get(SalesCollab, collab_id)
    if not c:
        raise HTTPException(status_code=404, detail="这条请求不存在")
    if action == "done":
        if c.state != "taken" or c.taken_by_id != user.id:
            raise HTTPException(status_code=400, detail="只有接了的人能点做完了")
        c.state = "done"
    elif action == "cancel":
        if c.state != "open" or (c.created_by_id != user.id and not _is_sup(user)):
            raise HTTPException(status_code=400, detail="只能撤回自己提的、还没人接的请求")
        c.state = "cancelled"
    else:
        raise HTTPException(status_code=400, detail="不认识的操作")
    c.done_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


# ---------- 遇到没见过的情况 ----------

def report_out(r: SalesReport, names: dict, user: Staff) -> dict:
    return {
        "id": r.id,
        "text": r.text,
        "sku_code": r.sku_code,
        "by": names.get(r.created_by_id, ""),
        "mine": r.created_by_id == user.id,
        "at": _cn(r.created_at),
        "state": r.state,
        "answer": r.answer,
        "answered_by": names.get(r.answered_by_id, "") if r.answered_by_id else "",
        "answered_at": _cn(r.answered_at),
        "is_rule": r.is_rule,
        "can_answer": _is_sup(user) and r.state == "open",
    }


def create_report(db: Session, user: Staff, body: dict) -> dict:
    text = str(body.get("text") or "").strip()
    if len(text) < REPORT_MIN:
        raise HTTPException(status_code=400, detail="写一句话说清发生了什么")
    r = SalesReport(text=text[:2000], sku_code=str(body.get("sku_code") or "").strip() or None,
                    created_by_id=user.id, state="open", created_at=datetime.utcnow())
    db.add(r)
    db.commit()
    _forget_badges()
    return report_out(r, map_staff_names(db, {user.id}), user)


def reports(db: Session, user: Staff) -> dict:
    """页面：主管看全部没回的；每人看自己报的；记成规则的大家都看。提的人打开这页 = 看过回复。"""
    mine = db.query(SalesReport).filter(SalesReport.created_by_id == user.id).order_by(SalesReport.created_at.desc()).limit(50).all()
    waiting = db.query(SalesReport).filter(SalesReport.state == "open").order_by(SalesReport.created_at).all() if _is_sup(user) else []
    rules = db.query(SalesReport).filter(SalesReport.is_rule.is_(True)).order_by(SalesReport.answered_at.desc()).limit(200).all()
    rows = {r.id: r for r in [*mine, *waiting, *rules]}.values()
    names = map_staff_names(db, {r.created_by_id for r in rows} | {r.answered_by_id for r in rows})
    unseen = [r for r in mine if r.state == "answered" and not r.seen]
    out = {
        "waiting": [report_out(r, names, user) for r in waiting],
        "mine": [report_out(r, names, user) for r in mine],
        "rules": [report_out(r, names, user) for r in rules],
    }
    if unseen:
        for r in unseen:
            r.seen = True
        db.commit()
        _forget_badges()
    return out


def answer_report(db: Session, user: Staff, report_id: str, body: dict) -> dict:
    if not _is_sup(user):
        raise HTTPException(status_code=403, detail="要主管来回")
    r = db.get(SalesReport, report_id)
    if not r:
        raise HTTPException(status_code=404, detail="这条上报不存在")
    answer = str(body.get("answer") or "").strip()
    if len(answer) < REPORT_MIN:
        raise HTTPException(status_code=400, detail="写清该怎么办")
    r.answer, r.answered_by_id, r.answered_at = answer[:2000], user.id, datetime.utcnow()
    r.state, r.is_rule, r.seen = "answered", bool(body.get("is_rule")), r.created_by_id == user.id
    db.commit()
    _forget_badges()
    return report_out(r, map_staff_names(db, {r.created_by_id, user.id}), user)


def report_tasks(db: Session, user: Staff) -> list[dict]:
    """并进「今天」：主管看没回的（红）；提的人看主管回了还没看的（黄）。"""
    q = SalesReport.state == "open" if _is_sup(user) else None
    rows = db.query(SalesReport).filter(q).all() if q is not None else []
    names = map_staff_names(db, {r.created_by_id for r in rows})
    out = [{
        "key": f"report:{r.id}", "kind": "report", "level": "red", "tag": "新情况",
        "title": r.text, "sub": f"{names.get(r.created_by_id, '')} {_cn(r.created_at)} 报的，回一句该怎么办",
        "thumb": None, "url": URL_REPORT, "button": "去回复", "at": r.created_at.isoformat(),
    } for r in rows]
    for r in db.query(SalesReport).filter(SalesReport.created_by_id == user.id, SalesReport.state == "answered",
                                          SalesReport.seen.is_(False)):
        out.append({
            "key": f"report:{r.id}", "kind": "report", "level": "yellow", "tag": "主管回了",
            "title": r.text, "sub": f"回复：{r.answer}", "thumb": None, "url": URL_REPORT, "button": "去看",
            "at": (r.answered_at or r.created_at).isoformat(),
        })
    return out
