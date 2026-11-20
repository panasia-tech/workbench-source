"""第五步：看缺口、开店教程、开店进度（V2 交付包，11-17）。

三种人：
  - 老板 = 管理员：发布教程、批跳步、改目标数，别的也都能做；
  - 审核人（「主管」，管理员在「开店」页指定，存 app_setting 的 ledger_reviewers）：写教程、审员工交的步骤、派开店单；
  - 员工：只看派给自己的开店进度，一步一步交材料。

规矩：
  - 还没有已发布教程的平台不能派开店单；
  - 一步一步来：前一步没通过（或没批准跳过）后面的只能看不能交；要审核的步骤交了等审核人通过，不要审核的交了就算过；
  - 材料必填的不能空、不能只填 0（没有就写「待核」）；要勾确认的必须勾；打回必须写原因（至少 4 个字），
    重交是新的一版，旧的打回意见一直留着；审核人不能审自己交的（管理员可以）；
  - 跨轨两道锁：闲鱼店挂的那个支付宝没过 C10，店铺做不了 S09；没过 D15 做不了 S18。系统上线前就在用的支付宝
    （没有开户进度、状态在用）当作都过了。店铺没挂支付宝收款号就一直锁着；
  - D14 的测试金额每个支付宝不能一样；审 D15 时直接显示账单里有没有那笔（要先授权对账）；
  - 要交新设密码的步骤（B09、S06），没交进密码库不让过（密码库没配主密钥时不拦）；
  - 跳步只能跳当前这一步，老板批了才算；
  - 走完最后一步：支付宝 / 店铺从「开店中」改成「在用」。

看缺口：每个法人填目标数，缺口 = 目标 − 已就绪 − 开店中（不到 0 算 0）。没填的项不算。
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.enums import StaffRole
from app.models import (
    LedgerAlipay,
    LedgerBillRow,
    LedgerCase,
    LedgerCaseSkip,
    LedgerCaseStep,
    LedgerDevice,
    LedgerEntity,
    LedgerLegalPerson,
    LedgerShop,
    LedgerSim,
    LedgerTarget,
    LedgerTutorial,
    LedgerVault,
    Staff,
)
from app.services import ledger as lg
from app.services import ledger_vault as lv
from app.services.app_settings import get_setting, set_setting

TUTORIAL_STATUSES = {"draft": "草稿", "pending": "等老板发布", "published": "已发布", "archived": "已归档"}
TUTORIAL_KINDS = {"alipay": "企业支付宝", "shop": "店铺", "meta": "写教程的教程"}
CASE_STATUSES = {"open": "进行中", "done": "已完成", "cancelled": "已撤销"}
STEP_STATES = {"approved": "已通过", "skipped": "已跳过", "submitted": "等审核", "rejected": "被打回", "active": "现在做",
               "gated": "被支付宝锁住", "locked": "还没到"}
TARGET_KEYS = {"licenses": "执照", "tax": "税务登记", "reports": "年报已报", "alipays": "企业支付宝", "proxies": "代理 IP",
               "phones": "工作手机", "sims": "手机卡"}
MATERIAL_KINDS = {"text": "一行字", "textarea": "多行字"}
GATE_RE = re.compile(r"^alipay:[A-Z]\d{2}$")
LOCKIN_CATEGORIES = ("alipay", "platform")
REVIEWERS_KEY = "ledger_reviewers"
SEED = Path(__file__).with_name("ledger_tutorials_seed.json")
PLACEHOLDER = "开店中·"  # 派单时占位的支付宝账号 / 店铺名的开头，A03 交了登录邮箱就换成真的


def _bad(msg: str, code: int = 400):
    raise HTTPException(status_code=code, detail=msg)


def _cn(dt: datetime | None) -> str | None:
    return (dt + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if dt else None


def _names(db: Session, ids) -> dict[str, str]:
    ids = {i for i in ids if i}
    return {s.id: s.name or s.username for s in db.query(Staff).filter(Staff.id.in_(ids)).all()} if ids else {}


# ---------------------------------------------------------------- 谁能干什么

def reviewer_ids(db: Session) -> list[str]:
    try:
        v = json.loads(get_setting(db, REVIEWERS_KEY, "[]") or "[]")
        return [x for x in v if isinstance(x, str)]
    except ValueError:
        return []


def set_reviewers(db: Session, user: Staff, ids: list[str]) -> list[str]:
    ids = list(dict.fromkeys(i for i in ids if i))
    found = {s.id for s in db.query(Staff).filter(Staff.id.in_(ids)).all()} if ids else set()
    if set(ids) - found:
        _bad("有的员工不存在")
    set_setting(db, REVIEWERS_KEY, json.dumps(ids), user.id)
    lg.log(db, user, "update", "reviewers", None, "审核人：" + "、".join(_names(db, ids).values()))
    return ids


def is_boss(user: Staff) -> bool:
    return user.role == StaffRole.ADMIN


def is_reviewer(db: Session, user: Staff) -> bool:
    return is_boss(user) or user.id in reviewer_ids(db)


def require_reviewer(db: Session, user: Staff):
    if not is_reviewer(db, user):
        _bad("只有审核人和管理员能做", 403)


def require_boss(user: Staff):
    if not is_boss(user):
        _bad("只有老板（管理员）能做", 403)


# ---------------------------------------------------------------- 教程

def ensure_seed(db: Session) -> None:
    """交付包里的四套（企业支付宝、闲鱼、写教程的教程已发布，微信小店样稿是草稿），哪套的编号库里还没有就放进去。"""
    have = {c for (c,) in db.query(LedgerTutorial.code).distinct().all()}
    seeds = [t for t in json.loads(SEED.read_text(encoding="utf-8")) if t["code"] not in have]
    for t in seeds:
        db.add(LedgerTutorial(code=t["code"], version=1, kind=t["kind"], platform=t["platform"], title=t["title"],
                              summary=t["summary"], body=normalize(t["body"], t["kind"]), status=t["status"],
                              published_at=datetime.utcnow() if t["status"] == "published" else None))
    db.flush()


def _s(v, n: int = 4000) -> str:
    return (str(v).strip() if v is not None else "")[:n]


def normalize(body, kind: str) -> list:
    """教程整棵树校验 + 补默认值。步骤编号整份唯一；材料的键一步内唯一；跨轨锁只有店铺教程能用。"""
    if not isinstance(body, list) or not body:
        _bad("教程至少要有一个阶段")
    seen: set[str] = set()
    out = []
    for i, st in enumerate(body, 1):
        if not isinstance(st, dict) or not _s(st.get("title")):
            _bad(f"第 {i} 个阶段没写标题")
        steps = []
        for j, sp in enumerate(st.get("steps") or [], 1):
            code = _s(sp.get("code"), 16).upper()
            if not re.fullmatch(r"[A-Z]{1,3}\d{2}", code or ""):
                _bad(f"阶段「{st['title']}」第 {j} 步的编号要像 A01、S09 这样")
            if code in seen:
                _bad(f"步骤编号 {code} 重复了")
            seen.add(code)
            if not _s(sp.get("title")):
                _bad(f"{code} 没写标题")
            gate = _s(sp.get("gate"), 32)
            if gate and (kind != "shop" or not GATE_RE.match(gate)):
                _bad(f"{code} 的跨轨锁只能写在店铺教程里，格式是 alipay:C10")
            lockin = _s(sp.get("vault_lockin"), 16)
            if lockin and lockin not in LOCKIN_CATEGORIES:
                _bad(f"{code} 交密码进库的分类不对")
            keys: set[str] = set()
            mats = []
            for m in sp.get("materials") or []:
                key = _s(m.get("key"), 40)
                if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", key or ""):
                    _bad(f"{code} 的材料键要是小写字母、数字、下划线")
                if key in keys:
                    _bad(f"{code} 的材料键 {key} 重复了")
                keys.add(key)
                if not _s(m.get("label")):
                    _bad(f"{code} 的材料 {key} 没写叫什么")
                mats.append({"key": key, "label": _s(m.get("label"), 128),
                             "kind": m.get("kind") if m.get("kind") in MATERIAL_KINDS else "text",
                             "required": bool(m.get("required", True)), "placeholder": _s(m.get("placeholder"), 255)})
            guards = [{k: _s(g.get(k), 500) for k in ("pre", "mistake", "block", "tip", "recover", "owner", "evidence")}
                      for g in (sp.get("guards") or []) if isinstance(g, dict)]
            video = _s(sp.get("video_url"), 500)
            if video and not video.startswith("https://"):
                _bad(f"{code} 的视频地址要 https:// 开头（没录就空着，页面上会写「待录」）")
            steps.append({
                "code": code, "title": _s(sp.get("title"), 200), "who": _s(sp.get("who"), 64) or "开店员工",
                "when": _s(sp.get("when"), 500), "guide": _s(sp.get("guide")), "warn": _s(sp.get("warn"), 1000),
                "deliver": _s(sp.get("deliver"), 500), "stop": _s(sp.get("stop"), 500), "video_url": video,
                "require_review": bool(sp.get("require_review")), "require_confirm": bool(sp.get("require_confirm")),
                "gate": gate, "vault_lockin": lockin, "guards": guards, "materials": mats,
            })
        if not steps:
            _bad(f"阶段「{st['title']}」至少要有一步")
        out.append({"code": _s(st.get("code"), 16) or f"P{i}", "title": _s(st.get("title"), 200),
                    "desc": _s(st.get("desc"), 1000), "duration": _s(st.get("duration"), 64), "steps": steps})
    return out


def steps_of(t: LedgerTutorial) -> list[dict]:
    return [sp for st in (t.body or []) for sp in st.get("steps", [])]


def tutorial_out(db: Session, t: LedgerTutorial, *, full: bool = False, names: dict | None = None) -> dict:
    names = names if names is not None else _names(db, [t.author_id, t.reviewed_by_id])
    steps = steps_of(t)
    out = {
        "id": t.id, "code": t.code, "version": t.version, "kind": t.kind, "kind_label": TUTORIAL_KINDS.get(t.kind, t.kind),
        "platform": t.platform, "platform_label": lg.PLATFORMS.get(t.platform or "", None), "title": t.title,
        "summary": t.summary, "status": t.status, "status_label": TUTORIAL_STATUSES.get(t.status, t.status),
        "author_name": names.get(t.author_id or ""), "reviewed_by_name": names.get(t.reviewed_by_id or ""),
        "review_note": t.review_note, "published_at": _cn(t.published_at), "updated_at": _cn(t.updated_at),
        "stage_count": len(t.body or []), "step_count": len(steps),
        "review_count": sum(1 for s in steps if s.get("require_review")),
        "video_missing": sum(1 for s in steps if not s.get("video_url")),
    }
    if full:
        out["body"] = t.body
    return out


def list_tutorials(db: Session) -> list[dict]:
    ensure_seed(db)
    rows = db.query(LedgerTutorial).order_by(LedgerTutorial.code, LedgerTutorial.version.desc()).all()
    names = _names(db, [r.author_id for r in rows] + [r.reviewed_by_id for r in rows])
    return [tutorial_out(db, r, names=names) for r in rows]


def _published(db: Session, kind: str, platform: str | None) -> LedgerTutorial | None:
    q = db.query(LedgerTutorial).filter(LedgerTutorial.kind == kind, LedgerTutorial.status == "published")
    if kind == "shop":
        q = q.filter(LedgerTutorial.platform == platform)
    return q.order_by(LedgerTutorial.published_at.desc()).first()


def save_tutorial(db: Session, user: Staff, data: dict, tid: str | None) -> LedgerTutorial:
    """草稿和等发布的直接改（等发布的改了退回草稿）；已发布 / 归档的改 = 另存一个新版本草稿。"""
    require_reviewer(db, user)
    ensure_seed(db)
    if tid:
        old = db.get(LedgerTutorial, tid)
        if old is None:
            _bad("没有这份教程", 404)
        kind, platform, code = old.kind, old.platform, old.code
        if old.status in ("draft", "pending"):
            t = old
        else:
            ver = max(v for (v,) in db.query(LedgerTutorial.version).filter(LedgerTutorial.code == code).all()) + 1
            t = LedgerTutorial(code=code, version=ver, kind=kind, platform=platform, title=old.title, summary=old.summary,
                               body=old.body)
    else:
        kind = data.get("kind")
        platform = data.get("platform") or None
        if kind not in TUTORIAL_KINDS:
            _bad("教程是开支付宝、开店还是写教程？")
        if kind == "shop" and platform not in lg.PLATFORMS:
            _bad("开哪个平台的店？")
        if kind != "shop":
            platform = None
        code = _s(data.get("code"), 32).upper() or (f"SHOP_{platform.upper()}" if kind == "shop" else kind.upper())
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,31}", code):
            _bad("教程编号只能是大写字母、数字、下划线")
        if db.query(LedgerTutorial.id).filter(LedgerTutorial.code == code).first() is not None:
            _bad(f"已经有编号 {code} 的教程了，去改那一份（会出新版本）")
        t = LedgerTutorial(code=code, version=1, kind=kind, platform=platform)
    t.title = _s(data.get("title"), 128) or t.title
    if not t.title:
        _bad("教程标题不能为空")
    if "summary" in data:
        t.summary = _s(data.get("summary"), 2000) or None
    t.body = normalize(data.get("body") if "body" in data else t.body, kind)
    t.status = "draft"
    t.author_id = user.id
    db.add(t)
    db.flush()
    lg.log(db, user, "update" if tid else "create", "tutorial", t.id, f"{t.code} v{t.version}")
    return t


def submit_tutorial(db: Session, user: Staff, tid: str) -> LedgerTutorial:
    require_reviewer(db, user)
    t = db.get(LedgerTutorial, tid)
    if t is None or t.status != "draft":
        _bad("只有草稿能提交老板发布")
    t.status = "pending"
    lg.log(db, user, "submit", "tutorial", t.id, f"{t.code} v{t.version} 提交发布")
    return t


def verdict_tutorial(db: Session, user: Staff, tid: str, approve: bool, note: str | None) -> LedgerTutorial:
    require_boss(user)
    t = db.get(LedgerTutorial, tid)
    if t is None or t.status != "pending":
        _bad("这份教程不在等发布")
    note = _s(note, 2000)
    t.reviewed_by_id, t.review_note = user.id, note or None
    if approve:
        for old in db.query(LedgerTutorial).filter(LedgerTutorial.code == t.code, LedgerTutorial.status == "published",
                                                   LedgerTutorial.id != t.id).all():
            old.status = "archived"
        t.status, t.published_at = "published", datetime.utcnow()
    else:
        if len(note) < 4:
            _bad("退回要写清楚哪里要改（至少 4 个字）")
        t.status = "draft"
    lg.log(db, user, "publish" if approve else "reject", "tutorial", t.id, f"{t.code} v{t.version} {note}")
    return t


# ---------------------------------------------------------------- 一份进度现在走到哪

def _target(db: Session, c: LedgerCase):
    if c.target_type == "alipay":
        return db.get(LedgerAlipay, c.target_id) if c.target_id else None
    if c.target_type == "shop":
        return db.get(LedgerShop, c.target_id) if c.target_id else None
    return None


def _passed(db: Session, case_id: str) -> set[str]:
    rows = db.query(LedgerCaseStep.step_code, LedgerCaseStep.status, LedgerCaseStep.version_no).filter(
        LedgerCaseStep.case_id == case_id).all()
    latest: dict[str, tuple[int, str]] = {}
    for code, st, ver in rows:
        if code not in latest or ver > latest[code][0]:
            latest[code] = (ver, st)
    return {k for k, (_, st) in latest.items() if st in ("approved", "skipped")}


def _alipay_case(db: Session, alipay_id: str) -> LedgerCase | None:
    rows = db.query(LedgerCase).filter(LedgerCase.target_type == "alipay", LedgerCase.target_id == alipay_id,
                                       LedgerCase.status != "cancelled").order_by(LedgerCase.created_at.desc()).all()
    return next((r for r in rows if r.status == "open"), rows[0] if rows else None)


def gate_lock(db: Session, c: LedgerCase, gate: str) -> dict | None:
    """跨轨锁：返回 None = 放行；否则 {reason, consequence, case_id}。"""
    if not gate or c.target_type != "shop":
        return None
    need = gate.split(":", 1)[1]
    shop = _target(db, c)
    ali = db.get(LedgerAlipay, shop.alipay_id) if shop is not None and shop.alipay_id else None
    consequence = "店开到一半绑不上支付宝要法人再跑一趟，或者开卖后账单拉不到、钱对不上"
    if ali is None:
        return {"reason": "这家店还没挂支付宝收款号，没法确认支付宝做没做 " + need, "consequence": consequence,
                "case_id": None, "hint": "管理员先在台账里给店铺挂上同主体的收款号"}
    ac = _alipay_case(db, ali.id)
    if ac is None:
        if ali.status == "active":
            return None  # 系统上线前就开好、在用的支付宝
        return {"reason": f"支付宝 {ali.account} 还没有开户进度，没法确认做没做 {need}", "consequence": consequence,
                "case_id": None, "hint": "先给这个支付宝派开户单"}
    if need in _passed(db, ac.id):
        return None
    t = db.get(LedgerTutorial, ac.tutorial_id)
    title = next((s["title"] for s in steps_of(t) if s["code"] == need), need) if t else need
    return {"reason": f"支付宝「{ac.title}」还没过 {need}「{title}」", "consequence": consequence, "case_id": ac.id,
            "hint": f"先把那边的 {need} 做完、审过"}


def _test_amount(materials: dict) -> Decimal | None:
    raw = (materials or {}).get("unique_test_yuan")
    try:
        v = Decimal(str(raw).strip())
    except (InvalidOperation, TypeError, ValueError):
        return None
    return v if Decimal("0") < v < Decimal("1") else None


def _latest_rows(db: Session, case_ids: list[str]) -> dict[tuple[str, str], LedgerCaseStep]:
    out: dict[tuple[str, str], LedgerCaseStep] = {}
    if not case_ids:
        return out
    for r in db.query(LedgerCaseStep).filter(LedgerCaseStep.case_id.in_(case_ids)).all():
        k = (r.case_id, r.step_code)
        if k not in out or r.version_no > out[k].version_no:
            out[k] = r
    return out


def bill_check(db: Session, c: LedgerCase) -> dict | None:
    """D15 用：D14 登记的测试金额，在这个支付宝的账单里找到几笔；还有别的支付宝用没用同一个金额。"""
    if c.target_type != "alipay":
        return None
    d14 = _latest_rows(db, [c.id]).get((c.id, "D14"))
    amount = _test_amount(d14.materials) if d14 is not None and d14.status == "approved" else None
    ali = _target(db, c)
    if amount is None or ali is None:
        return {"amount": None, "authorized": bool(ali and ali.auth_status == "authorized"), "found": []}
    rows = db.query(LedgerBillRow).filter(LedgerBillRow.alipay_id == ali.id, LedgerBillRow.income == amount).order_by(
        LedgerBillRow.bill_date.desc()).limit(5).all()
    return {"amount": str(amount), "authorized": ali.auth_status == "authorized",
            "found": [{"bill_date": r.bill_date.isoformat(), "flow_no": r.flow_no, "counterparty": r.counterparty}
                      for r in rows],
            "same_amount": _same_amount(db, c, amount)}


def _same_amount(db: Session, c: LedgerCase, amount: Decimal) -> list[str]:
    others = db.query(LedgerCase).filter(LedgerCase.target_type == "alipay", LedgerCase.id != c.id,
                                         LedgerCase.status != "cancelled").all()
    latest = _latest_rows(db, [o.id for o in others])
    return [o.title for o in others if (r := latest.get((o.id, "D14"))) is not None
            and r.status in ("approved", "submitted") and _test_amount(r.materials) == amount]


def evaluate(db: Session, c: LedgerCase, *, full: bool = True) -> dict:
    t = db.get(LedgerTutorial, c.tutorial_id)
    steps = steps_of(t) if t else []
    subs = db.query(LedgerCaseStep).filter(LedgerCaseStep.case_id == c.id).order_by(
        LedgerCaseStep.step_code, LedgerCaseStep.version_no.desc()).all()
    hist: dict[str, list[LedgerCaseStep]] = {}
    for r in subs:
        hist.setdefault(r.step_code, []).append(r)
    skips = {s.step_code: s for s in db.query(LedgerCaseSkip).filter(LedgerCaseSkip.case_id == c.id).order_by(
        LedgerCaseSkip.created_at).all()}
    names = _names(db, [r.submitted_by_id for r in subs] + [r.reviewed_by_id for r in subs]
                   + [s.requested_by_id for s in skips.values()] + [s.decided_by_id for s in skips.values()]
                   + [c.assignee_id, c.created_by_id])
    blocked = False
    done = 0
    current = None
    out_steps = []
    for sp in steps:
        h = hist.get(sp["code"], [])
        latest = h[0] if h else None
        lock = None
        if latest is not None and latest.status in ("approved", "skipped"):
            state = latest.status
            done += 1
        elif blocked:
            state = "locked"
        else:
            blocked = True
            if latest is not None and latest.status in ("submitted", "rejected"):
                state = latest.status
            else:
                lock = gate_lock(db, c, sp.get("gate"))
                state = "gated" if lock else "active"
        if current is None and state in ("active", "gated", "submitted", "rejected"):
            current = sp["code"]
        row = {"code": sp["code"], "title": sp["title"], "state": state, "state_label": STEP_STATES[state]}
        if full:
            sk = skips.get(sp["code"])
            row.update(
                step=sp, lock=lock,
                history=[{"version_no": r.version_no, "status": r.status, "materials": r.materials,
                          "confirmed": r.confirmed, "submitted_by": names.get(r.submitted_by_id),
                          "submitted_at": _cn(r.submitted_at), "reviewed_by": names.get(r.reviewed_by_id or ""),
                          "reviewed_at": _cn(r.reviewed_at), "review_note": r.review_note} for r in h],
                skip=None if sk is None else {
                    "id": sk.id, "status": sk.status, "reason": sk.reason, "requested_by": names.get(sk.requested_by_id),
                    "decided_by": names.get(sk.decided_by_id or ""), "decide_note": sk.decide_note,
                    "created_at": _cn(sk.created_at)},
            )
            if sp["code"] == "D15":
                row["bill_check"] = bill_check(db, c)
        out_steps.append(row)
    cur = next((s for s in out_steps if s["code"] == current), None)
    target = _target(db, c)
    res = {
        "id": c.id, "title": c.title, "status": c.status, "status_label": CASE_STATUSES.get(c.status, c.status),
        "target_type": c.target_type, "target_id": c.target_id,
        "target_label": (getattr(target, "account", None) or getattr(target, "name", None)) if target is not None else None,
        "target_status": getattr(target, "status", None), "legal_person_id": c.legal_person_id,
        "tutorial_id": c.tutorial_id, "tutorial_title": t.title if t else None, "tutorial_version": t.version if t else None,
        "assignee_id": c.assignee_id, "assignee_name": names.get(c.assignee_id),
        "created_by_name": names.get(c.created_by_id), "due_on": c.due_on.isoformat() if c.due_on else None,
        "overdue": bool(c.status == "open" and c.due_on and c.due_on < lg._today()),
        "created_at": _cn(c.created_at), "done_at": _cn(c.done_at), "note": c.note,
        "total": len(steps), "done": done, "pct": round(done * 100 / len(steps)) if steps else 0,
        "current_code": cur["code"] if cur else None, "current_title": cur["title"] if cur else None,
        "current_state": cur["state"] if cur else None,
        "steps": out_steps,  # 不带 full 时每步只有编号、标题、状态
    }
    if full and t is not None:
        res["stages"] = [{"code": st["code"], "title": st["title"], "desc": st.get("desc"), "duration": st.get("duration"),
                          "codes": [s["code"] for s in st["steps"]]} for st in t.body]
    return res


# ---------------------------------------------------------------- 派单、撤销

def dispatch(db: Session, user: Staff, data: dict) -> LedgerCase:
    """派开店单。kind=alipay：给某主体开一个企业支付宝（或给已有的一个补进度）；kind=shop：开一家店；
    kind=tutorial：派人写某个平台的教程。占位的支付宝 / 店铺状态是「开店中」，走完自动改成在用。"""
    require_reviewer(db, user)
    ensure_seed(db)
    kind = data.get("kind")
    assignee = db.get(Staff, data.get("assignee_id") or "")
    if assignee is None:
        _bad("派给谁？")
    due = None
    if data.get("due_on"):
        try:
            due = date.fromisoformat(str(data["due_on"]))
        except ValueError:
            _bad("截止日期格式不对")
    target_id = data.get("target_id") or None
    link = None
    if kind == "alipay":
        tut = _published(db, "alipay", None)
        if tut is None:
            _bad("企业支付宝还没有发布的开户教程，先写教程")
        if target_id:
            ali = lg._get(db, "alipay", target_id)
        else:
            ent = lg._get(db, "entity", data.get("entity_id") or "")
            n = db.query(LedgerAlipay).filter(LedgerAlipay.entity_id == ent.id).count() + 1
            ali = lg.create(db, user, "alipay", {"entity_id": ent.id, "account": f"{PLACEHOLDER}{ent.name}·{n}",
                                                 "role": data.get("role") or "sales", "status": "building"})
        ent = db.get(LedgerEntity, ali.entity_id)
        target_type, target_id, lp_id = "alipay", ali.id, ent.legal_person_id
        title = data.get("title") or f"开企业支付宝 · {ent.name}"
    elif kind == "shop":
        if target_id:
            shop = lg._get(db, "shop", target_id)
            platform = shop.platform
        else:
            platform = data.get("platform")
        if platform not in lg.PLATFORMS:
            _bad("开哪个平台的店？")
        tut = _published(db, "shop", platform)
        if tut is None:
            _bad(f"{lg.PLATFORMS[platform]}还没有发布的开店教程，派不了单；先派人写教程")
        if not target_id:
            row = {"platform": platform, "status": "building", "role": data.get("role") or "sales"}
            if data.get("alipay_id"):
                row.update(alipay_id=data["alipay_id"], channel="alipay")
            else:
                row["entity_id"] = lg._get(db, "entity", data.get("entity_id") or "").id
                if row["role"] == "sales":
                    row["channel"] = data.get("channel") or "other"
            ent_id = row.get("entity_id") or lg._get(db, "alipay", row["alipay_id"]).entity_id
            ent = db.get(LedgerEntity, ent_id)
            n = db.query(LedgerShop).filter(LedgerShop.entity_id == ent.id, LedgerShop.platform == platform).count() + 1
            row["name"] = f"{PLACEHOLDER}{lg.PLATFORMS[platform]}·{ent.name}·{n}"
            shop = lg.create(db, user, "shop", row)
        ent = db.get(LedgerEntity, shop.entity_id)
        target_type, target_id, lp_id = "shop", shop.id, ent.legal_person_id
        if shop.alipay_id:
            ac = _alipay_case(db, shop.alipay_id)
            link = ac.id if ac else None
        title = data.get("title") or f"开{lg.PLATFORMS[platform]} · {ent.name}"
    elif kind == "tutorial":
        tut = _published(db, "meta", None)
        if tut is None:
            _bad("「写教程的教程」没发布，派不了写教程的单")
        platform = data.get("platform")
        if platform not in lg.PLATFORMS and platform != "alipay":
            _bad("写哪个平台的教程？")
        target_type, target_id, lp_id = "tutorial", None, None
        label = "企业支付宝" if platform == "alipay" else lg.PLATFORMS[platform]
        title = data.get("title") or f"写教程 · {label}"
    else:
        _bad("派什么单？")
    if target_id and db.query(LedgerCase.id).filter(LedgerCase.target_type == target_type, LedgerCase.target_id == target_id,
                                                    LedgerCase.status == "open").first() is not None:
        _bad("这个已经有一份没走完的开店进度了")
    c = LedgerCase(tutorial_id=tut.id, target_type=target_type, target_id=target_id, legal_person_id=lp_id,
                   link_case_id=link, title=_s(title, 128), assignee_id=assignee.id, due_on=due,
                   note=_s(data.get("note"), 2000) or None, created_by_id=user.id, status="open")
    db.add(c)
    db.flush()
    lg.log(db, user, "dispatch", "case", c.id, f"{c.title} → {assignee.name or assignee.username}")
    return c


def update_case(db: Session, user: Staff, cid: str, data: dict) -> LedgerCase:
    require_reviewer(db, user)
    c = _case(db, cid)
    if "assignee_id" in data:
        if db.get(Staff, data["assignee_id"] or "") is None:
            _bad("派给谁？")
        c.assignee_id = data["assignee_id"]
    if "due_on" in data:
        try:
            c.due_on = date.fromisoformat(data["due_on"]) if data["due_on"] else None
        except ValueError:
            _bad("截止日期格式不对")
    if "note" in data:
        c.note = _s(data["note"], 2000) or None
    if data.get("cancel"):
        if c.status != "open":
            _bad("只有进行中的能撤销")
        c.status = "cancelled"
    lg.log(db, user, "update", "case", c.id, ",".join(sorted(data)))
    return c


def _case(db: Session, cid: str) -> LedgerCase:
    c = db.get(LedgerCase, cid)
    if c is None:
        _bad("没有这份开店进度", 404)
    return c


def can_see(db: Session, user: Staff, c: LedgerCase) -> bool:
    return c.assignee_id == user.id or is_reviewer(db, user)


def get_case(db: Session, user: Staff, cid: str) -> dict:
    c = _case(db, cid)
    if not can_see(db, user, c):
        _bad("这份开店进度不是派给你的", 403)
    return evaluate(db, c)


# ---------------------------------------------------------------- 交、审、跳

def _step(db: Session, c: LedgerCase, code: str) -> tuple[dict, dict]:
    ev = evaluate(db, c)
    row = next((s for s in ev["steps"] if s["code"] == code), None)
    if row is None:
        _bad(f"没有 {code} 这一步")
    return ev, row


def _next_ver(db: Session, cid: str, code: str) -> int:
    return max([v for (v,) in db.query(LedgerCaseStep.version_no).filter(
        LedgerCaseStep.case_id == cid, LedgerCaseStep.step_code == code).all()] or [0]) + 1


def submit_step(db: Session, user: Staff, cid: str, code: str, materials: dict, confirmed: bool) -> LedgerCaseStep:
    c = _case(db, cid)
    if c.assignee_id != user.id and not is_reviewer(db, user):
        _bad("这份开店进度不是派给你的", 403)
    if c.status != "open":
        _bad("这份开店进度已经结束了")
    _, row = _step(db, c, code)
    if row["state"] == "gated":
        lock = row["lock"]
        _bad(f"{lock['reason']}。{lock['hint']}")
    if row["state"] not in ("active", "rejected"):
        _bad(f"{code} 现在是「{row['state_label']}」，交不了；先把前面的做完")
    sp = row["step"]
    clean = {}
    for m in sp["materials"]:
        v = _s((materials or {}).get(m["key"]), 4000)
        if m["required"]:
            if not v:
                _bad(f"「{m['label']}」要填（真没有就写「待核」并说明为什么）")
            if v == "0":
                _bad(f"「{m['label']}」不能只填 0，没有就写「待核」")
        clean[m["key"]] = v
    if sp.get("require_confirm") and not confirmed:
        _bad("先看完红字，勾上「我已经照着做完、检查过了」")
    if code == "D14":
        amount = _test_amount(clean)
        if amount is None:
            _bad("测试金额要填 0.01～0.99 之间的数")
        same = _same_amount(db, c, amount)
        if same:
            _bad(f"测试金额 {amount} 元已经被「{same[0]}」用了，每个支付宝要不一样")
    if sp.get("vault_lockin") and lv.ready() and c.target_id and db.query(LedgerVault.id).filter(
            LedgerVault.target_type == c.target_type, LedgerVault.target_id == c.target_id,
            LedgerVault.has_password.is_(True)).first() is None:
        _bad("这一步要先点「交新设的密码」把密码交进密码库")
    review = bool(sp.get("require_review"))
    r = LedgerCaseStep(case_id=c.id, step_code=code, version_no=_next_ver(db, c.id, code),
                       status="submitted" if review else "approved", materials=clean, confirmed=bool(confirmed),
                       submitted_by_id=user.id, submitted_at=datetime.utcnow())
    if not review:
        r.reviewed_at, r.review_note = datetime.utcnow(), "这一步不用审核，交了就算过"
    db.add(r)
    db.flush()
    lg.log(db, user, "submit", "case", c.id, f"{code} 第 {r.version_no} 版")
    if not review:
        _after_pass(db, c, code, clean)
    return r


def review_step(db: Session, user: Staff, cid: str, code: str, approve: bool, note: str | None) -> LedgerCaseStep:
    require_reviewer(db, user)
    c = _case(db, cid)
    r = db.query(LedgerCaseStep).filter(LedgerCaseStep.case_id == c.id, LedgerCaseStep.step_code == code).order_by(
        LedgerCaseStep.version_no.desc()).first()
    if r is None or r.status != "submitted":
        _bad(f"{code} 没有等审核的材料")
    if r.submitted_by_id == user.id and not is_boss(user):
        _bad("自己交的不能自己审，找另一个审核人或管理员", 403)
    note = _s(note, 2000)
    if not approve and len(note) < 4:
        _bad("打回要写清楚哪里不对、怎么改（至少 4 个字）")
    r.status = "approved" if approve else "rejected"
    r.reviewed_by_id, r.reviewed_at, r.review_note = user.id, datetime.utcnow(), note or None
    lg.log(db, user, "approve" if approve else "reject", "case", c.id, f"{code} 第 {r.version_no} 版 {note}")
    if approve:
        db.flush()
        _after_pass(db, c, code, r.materials)
    return r


def _after_pass(db: Session, c: LedgerCase, code: str, materials: dict):
    """一步过了：A03 登录邮箱、B09 支付宝 UID 填回台账占位行；最后一步过了整份结束、占位行改在用。"""
    target = _target(db, c)
    if c.target_type == "alipay" and target is not None:
        email = (materials or {}).get("login_email", "")
        if code == "A03" and target.account.startswith(PLACEHOLDER) and "@" in email:
            target.account = email[:128]
        uid = (materials or {}).get("alipay_uid_recorded", "")
        if code == "B09" and not target.alipay_user_id and re.fullmatch(r"2088\d{12}", uid or ""):
            target.alipay_user_id = uid
    ev = evaluate(db, c, full=False)
    if ev["total"] and ev["done"] >= ev["total"]:
        c.status, c.done_at = "done", datetime.utcnow()
        if target is not None and target.status == "building":
            target.status = "active"


def request_skip(db: Session, user: Staff, cid: str, code: str, reason: str) -> LedgerCaseSkip:
    c = _case(db, cid)
    if c.assignee_id != user.id and not is_reviewer(db, user):
        _bad("这份开店进度不是派给你的", 403)
    reason = _s(reason, 2000)
    if len(reason) < 4:
        _bad("跳过要写清楚为什么（至少 4 个字）")
    _, row = _step(db, c, code)
    if row["state"] not in ("active", "gated", "rejected"):
        _bad("只能申请跳过现在卡着的这一步")
    if db.query(LedgerCaseSkip.id).filter(LedgerCaseSkip.case_id == c.id, LedgerCaseSkip.step_code == code,
                                          LedgerCaseSkip.status == "pending").first() is not None:
        _bad("这一步已经申请过了，等老板批")
    s = LedgerCaseSkip(case_id=c.id, step_code=code, reason=reason, requested_by_id=user.id)
    db.add(s)
    db.flush()
    lg.log(db, user, "skip_request", "case", c.id, f"{code}：{reason}")
    return s


def decide_skip(db: Session, user: Staff, sid: str, approve: bool, note: str | None) -> LedgerCaseSkip:
    require_boss(user)
    s = db.get(LedgerCaseSkip, sid)
    if s is None or s.status != "pending":
        _bad("没有等批的跳步申请")
    s.status = "approved" if approve else "rejected"
    s.decided_by_id, s.decided_at, s.decide_note = user.id, datetime.utcnow(), _s(note, 2000) or None
    c = _case(db, s.case_id)
    if approve:
        db.add(LedgerCaseStep(case_id=c.id, step_code=s.step_code, version_no=_next_ver(db, c.id, s.step_code),
                              status="skipped", materials={}, submitted_by_id=s.requested_by_id,
                              reviewed_by_id=user.id, reviewed_at=datetime.utcnow(),
                              review_note=f"老板批准跳过：{s.decide_note or s.reason}"))
        db.flush()
        _after_pass(db, c, s.step_code, {})
    lg.log(db, user, "skip_" + s.status, "case", c.id, f"{s.step_code} {s.decide_note or ''}")
    return s


def lock_in(db: Session, user: Staff, cid: str, code: str, data: dict):
    """开店步骤里交新设的密码。只有这一步开了「交密码进库」、并且是现在这一步才能交。"""
    c = _case(db, cid)
    if c.assignee_id != user.id and not is_reviewer(db, user):
        _bad("这份开店进度不是派给你的", 403)
    _, row = _step(db, c, code)
    cat = row["step"].get("vault_lockin")
    if not cat:
        _bad("这一步不用交密码")
    if row["state"] not in ("active", "rejected", "submitted"):
        _bad("只能在做这一步时交")
    target = _target(db, c)
    title = (getattr(target, "account", None) or getattr(target, "name", None) or c.title) if target is not None else c.title
    return lv.lock_in(db, user, title=title, category=cat, target_type=c.target_type, target_id=c.target_id,
                      login_name=_s(data.get("login_name"), 128) or None, password=data.get("password"),
                      secondary=data.get("secondary"), totp=data.get("totp"), source=f"{c.title} {code}")


# ---------------------------------------------------------------- 列表

def list_cases(db: Session, *, assignee_id: str | None = None, include_closed: bool = False) -> list[dict]:
    q = db.query(LedgerCase)
    if assignee_id:
        q = q.filter(LedgerCase.assignee_id == assignee_id)
    if not include_closed:
        q = q.filter(LedgerCase.status == "open")
    return [evaluate(db, c, full=False) for c in q.order_by(LedgerCase.created_at.desc()).limit(300).all()]


def pending_reviews(db: Session) -> list[dict]:
    open_ids = [i for (i,) in db.query(LedgerCase.id).filter(LedgerCase.status == "open").all()]
    latest = _latest_rows(db, open_ids)
    rows = [r for r in latest.values() if r.status == "submitted"]
    cases = {c.id: c for c in db.query(LedgerCase).filter(LedgerCase.id.in_([r.case_id for r in rows])).all()} if rows else {}
    names = _names(db, [r.submitted_by_id for r in rows])
    out = []
    for r in sorted(rows, key=lambda x: x.submitted_at):
        c = cases[r.case_id]
        t = db.get(LedgerTutorial, c.tutorial_id)
        title = next((s["title"] for s in steps_of(t) if s["code"] == r.step_code), r.step_code) if t else r.step_code
        out.append({"case_id": c.id, "case_title": c.title, "step_code": r.step_code, "step_title": title,
                    "version_no": r.version_no, "submitted_by": names.get(r.submitted_by_id),
                    "submitted_by_id": r.submitted_by_id, "submitted_at": _cn(r.submitted_at)})
    return out


def pending_skips(db: Session) -> list[dict]:
    rows = db.query(LedgerCaseSkip).filter(LedgerCaseSkip.status == "pending").order_by(LedgerCaseSkip.created_at).all()
    cases = {c.id: c for c in db.query(LedgerCase).filter(LedgerCase.id.in_([r.case_id for r in rows])).all()} if rows else {}
    names = _names(db, [r.requested_by_id for r in rows])
    return [{"id": r.id, "case_id": r.case_id, "case_title": cases[r.case_id].title if r.case_id in cases else None,
             "step_code": r.step_code, "reason": r.reason, "requested_by": names.get(r.requested_by_id),
             "created_at": _cn(r.created_at)} for r in rows]


# ---------------------------------------------------------------- 看缺口

def _report_ok(e: LedgerEntity, today: date) -> bool:
    due = today.year - 1
    if e.registered_on is not None and e.registered_on.year > due:
        return True
    return (e.report_year or 0) >= (due if today > date(today.year, 6, 30) else due - 1)


def gaps(db: Session) -> list[dict]:
    """每个法人：每一项的目标、已就绪、开店中、缺口。法人没填目标的也列出来（目标全空，提示去填）。"""
    today = lg._today()
    open_targets = {(c.target_type, c.target_id) for c in db.query(LedgerCase).filter(LedgerCase.status == "open").all()}
    targets = {t.legal_person_id: t for t in db.query(LedgerTarget).all()}
    out = []
    for lp in db.query(LedgerLegalPerson).filter(LedgerLegalPerson.status != "closed").order_by(LedgerLegalPerson.name).all():
        ents = [e for e in db.query(LedgerEntity).filter(LedgerEntity.legal_person_id == lp.id,
                                                         LedgerEntity.status != "closed").all()]
        lic = [e for e in ents if e.entity_type in lg.LICENSED]
        ent_ids = [e.id for e in ents]
        alis = db.query(LedgerAlipay).filter(LedgerAlipay.entity_id.in_(ent_ids), LedgerAlipay.status != "closed").all() \
            if ent_ids else []
        shops = db.query(LedgerShop).filter(LedgerShop.entity_id.in_(ent_ids), LedgerShop.status != "closed").all() \
            if ent_ids else []
        dev_ids = {s.device_id for s in shops if s.device_id}
        devs = db.query(LedgerDevice).filter(LedgerDevice.id.in_(dev_ids), LedgerDevice.status != "closed").all() \
            if dev_ids else []
        sims = db.query(LedgerSim).filter(LedgerSim.legal_person_id == lp.id, LedgerSim.status != "closed").count()

        def split(rows, kind):
            b = [r for r in rows if r.status == "building" or (kind, r.id) in open_targets]
            return len(rows) - len(b), len(b)

        have = {
            "licenses": (len(lic), 0), "tax": (sum(1 for e in lic if e.tax_office), 0),
            "reports": (sum(1 for e in lic if _report_ok(e, today)), 0), "alipays": split(alis, "alipay"),
            "proxies": (len({d.proxy_id for d in devs if d.proxy_id}), 0),
            "phones": (sum(1 for d in devs if d.kind == "phone"), 0), "sims": (sims, 0),
        }
        for p in lg.PLATFORMS:
            have[f"platform:{p}"] = split([s for s in shops if s.platform == p], "shop")
        tg = (targets.get(lp.id).targets if lp.id in targets else None) or {}
        items = []
        for key, (ready, building) in have.items():
            target = tg.get(key)
            if target in (None, "") and not ready and not building:
                continue
            label = TARGET_KEYS.get(key) or lg.PLATFORMS.get(key.split(":", 1)[-1], key)
            gap = max(0, int(target) - ready - building) if isinstance(target, int) else None
            items.append({"key": key, "label": label, "target": target if isinstance(target, int) else None,
                          "ready": ready, "building": building, "gap": gap})
        out.append({"legal_person_id": lp.id, "name": lp.name, "has_target": lp.id in targets,
                    "note": targets[lp.id].note if lp.id in targets else None,
                    "gap_total": sum(i["gap"] or 0 for i in items), "items": items})
    return out


def set_target(db: Session, user: Staff, lp_id: str, data: dict) -> LedgerTarget:
    require_boss(user)
    lg._get(db, "legal_person", lp_id)
    clean = {}
    for k, v in (data.get("targets") or {}).items():
        if k not in TARGET_KEYS and not (k.startswith("platform:") and k.split(":", 1)[1] in lg.PLATFORMS):
            _bad(f"目标项 {k} 不认识")
        if v in (None, ""):
            continue
        try:
            n = int(v)
        except (TypeError, ValueError):
            _bad("目标数要填整数")
        if n < 0 or n > 999:
            _bad("目标数在 0～999 之间")
        clean[k] = n
    lic = clean.get("licenses")
    xy = clean.get("platform:xianyu")
    if lic is not None and xy is not None and xy > lic * lg.XIANYU_PER_LICENSE:
        _bad(f"{lic} 张执照最多挂 {lic * lg.XIANYU_PER_LICENSE} 家闲鱼店，目标填了 {xy} 家；要么多办执照，要么少开")
    t = db.query(LedgerTarget).filter(LedgerTarget.legal_person_id == lp_id).first() or LedgerTarget(legal_person_id=lp_id)
    t.targets, t.note, t.updated_by_id = clean, _s(data.get("note"), 2000) or None, user.id
    db.add(t)
    db.flush()
    lg.log(db, user, "update", "target", lp_id, json.dumps(clean, ensure_ascii=False))
    return t


def coverage(db: Session) -> list[dict]:
    """每个平台（加企业支付宝）有没有发布的教程。"""
    ensure_seed(db)
    rows = db.query(LedgerTutorial).filter(LedgerTutorial.kind.in_(("alipay", "shop")),
                                           LedgerTutorial.status.in_(("draft", "pending", "published"))).all()
    by: dict[str, set[str]] = {}
    for r in rows:
        by.setdefault("alipay" if r.kind == "alipay" else r.platform, set()).add(r.status)
    keys = [("alipay", "企业支付宝")] + list(lg.PLATFORMS.items())
    out = []
    for k, label in keys:
        st = by.get(k, set())
        state = "published" if "published" in st else "pending" if "pending" in st else "draft" if "draft" in st else "none"
        out.append({"key": k, "label": label, "state": state,
                    "state_label": {"published": "已上线", "pending": "等老板发布", "draft": "在写", "none": "没有教程"}[state]})
    return out


# ---------------------------------------------------------------- 首屏：红、黄、绿

def issues(db: Session, user: Staff) -> list[dict]:
    """要人动手的事。红 = 现在就要动手；黄 = 等谁批 / 审；按人过滤：员工只看自己的进度。"""
    boss, rev = is_boss(user), is_reviewer(db, user)
    out = []
    cases = list_cases(db, assignee_id=None if rev else user.id)
    for c in cases:
        if c["current_state"] == "rejected":
            out.append({"level": "red", "text": f"「{c['title']}」{c['current_code']} 被打回了，改好重交",
                        "who": c["assignee_name"], "action": {"type": "case", "id": c["id"]}})
        elif c["current_state"] == "gated":
            out.append({"level": "red", "text": f"「{c['title']}」卡在 {c['current_code']}，等支付宝那边",
                        "who": c["assignee_name"], "action": {"type": "case", "id": c["id"]}})
        if c["overdue"]:
            out.append({"level": "red", "text": f"「{c['title']}」过了截止日 {c['due_on']}，做到 {c['done']}/{c['total']}",
                        "who": c["assignee_name"], "action": {"type": "case", "id": c["id"]}})
    if rev:
        for r in pending_reviews(db):
            if r["submitted_by_id"] == user.id and not boss:
                continue
            out.append({"level": "yellow", "text": f"等审核：「{r['case_title']}」{r['step_code']} {r['step_title']}（第 {r['version_no']} 版）",
                        "who": r["submitted_by"], "action": {"type": "case", "id": r["case_id"], "step": r["step_code"]}})
        for g in gaps(db):
            if g["gap_total"]:
                short = "、".join(f"{i['label']} {i['gap']}" for i in g["items"] if i["gap"])
                out.append({"level": "red", "text": f"法人「{g['name']}」还差：{short}", "who": None,
                            "action": {"type": "gap", "id": g["legal_person_id"]}})
    if boss:
        for t in db.query(LedgerTutorial).filter(LedgerTutorial.status == "pending").all():
            out.append({"level": "yellow", "text": f"教程等你发布：{t.title}（v{t.version}）", "who": None,
                        "action": {"type": "tutorial", "id": t.id}})
        for s in pending_skips(db):
            out.append({"level": "yellow", "text": f"跳步等你批：「{s['case_title']}」{s['step_code']}——{s['reason']}",
                        "who": s["requested_by"], "action": {"type": "skip", "id": s["id"], "case_id": s["case_id"]}})
    order = {"red": 0, "yellow": 1}
    out.sort(key=lambda x: order[x["level"]])
    return out
