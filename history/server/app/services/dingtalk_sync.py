"""钉钉 → ERP 账号：入职建待分配账号、离职软删除。

- 入职（user_add_org）：先看钉钉「部门」（含上级部门，后台可配，见 dept_roles；默认技术部→管理员），
  再看「职位」（见 title_roles），对得上就直接开成那个角色、已激活；
  都对不上建 PENDING（登不进去，管理员在后台分配角色、改成已激活才能用）。管理员只能按部门给，不按职位给。
  部门规则勾了「要填 GitHub」的，通知本人去「我的信息」填 GitHub，填了自动邀请进代码仓库（services/github_invite.py）。
  用户名=工号，随机初始密码用钉钉工作通知发给本人；同时通知管理员（DINGTALK_NOTIFY_USERIDS）。
- 离职（user_leave_org）：只动关联了这个钉钉 userid 的号（staff.dingtalk_userid），做法同后台「删除员工」。
  没关联的号钉钉那边动不到——存量员工先用 scripts/dingtalk_staff.py 对照、关联。
- 对账（每天）：已关联的人在钉钉里查无此人（60121）就按离职处理；钉钉里有、ERP 没关联的人只列出来，
  加 create_missing 才补建（首次开通时全员都是「没关联」，不能默认建）。

开关 DINGTALK_SYNC_ENABLED 没开时只预演；DINGTALK_SYNC_ONLY_USERIDS 非空时只处理名单里的人（试运行）。
"""
from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.config import settings
from app.enums import HUMAN_ROLES, StaffRole, StaffStatus
from app.models import Staff, StaffSimCard
from app.services import dingtalk, staff_account
from app.services.order_no import generate_staff_no
from app.services.password import hash_password

logger = logging.getLogger(__name__)

_ROLE_NAME = {
    StaffRole.ADMIN: "管理员", StaffRole.WAREHOUSE: "仓库", StaffRole.PURCHASER: "采购", StaffRole.NEGOTIATOR: "议价",
    StaffRole.BUSINESS: "业务员", StaffRole.SALES: "销售", StaffRole.FINANCE: "财务",
}

JOIN = "user_add_org"
LEAVE = "user_leave_org"
MODIFY = "user_modify_org"
LOGIN_URL = "http://127.0.0.1:8000"
# 去掉 0/O、1/l/I 这些容易看错的
_PASSWORD_CHARS = "DEMO_ONLY_REDACTED"


# 钉钉通讯录「职位」→ ERP 角色。后台「员工管理 → 钉钉职位对应」里改（app_setting），这里是没改过时的默认
TITLE_ROLES_KEY = "dingtalk_title_roles"
DEFAULT_TITLE_ROLES = [
    {"keywords": ["仓管", "仓库"], "role": StaffRole.WAREHOUSE},
    {"keywords": ["采购"], "role": StaffRole.PURCHASER},
    {"keywords": ["议价"], "role": StaffRole.NEGOTIATOR},
    {"keywords": ["业务员"], "role": StaffRole.BUSINESS},
    {"keywords": ["销售", "客服"], "role": StaffRole.SALES},
    {"keywords": ["财务", "会计", "出纳"], "role": StaffRole.FINANCE},
]
# 管理员永远不按职位自动给：钉钉里改个职位就拿到 ERP 管理权，太容易
TITLE_ROLE_CHOICES = tuple(r for r in HUMAN_ROLES if r != StaffRole.ADMIN)


# 钉钉部门 → ERP 角色。部门名含关键词就算（上级部门也算），比职位先看。后台同一个弹窗里改
DEPT_ROLES_KEY = "dingtalk_dept_roles"
DEFAULT_DEPT_ROLES = [
    {"keywords": ["技术"], "role": StaffRole.ADMIN, "github": True},  # 11-10 用户定：技术部新人给管理员、要填 GitHub
]
# 部门由钉钉管理员在通讯录里调，比职位难改，所以按部门可以给管理员
DEPT_ROLE_CHOICES = tuple(HUMAN_ROLES)


def dept_roles(db: Session) -> list[dict]:
    from app.services.app_settings import get_setting

    raw = get_setting(db, DEPT_ROLES_KEY, "")
    if not raw:
        return [dict(r, role=str(r["role"])) for r in DEFAULT_DEPT_ROLES]
    try:
        rules = json.loads(raw)
    except ValueError:
        return []
    return [
        {"keywords": r["keywords"], "role": r["role"], "github": bool(r.get("github"))}
        for r in rules
        if isinstance(r, dict) and r.get("role") in DEPT_ROLE_CHOICES and r.get("keywords")
    ]


def clean_dept_roles(rules: list[dict]) -> list[dict]:
    """保存前整理：去空词、去重；角色必须是真人角色。不合法抛 ValueError。"""
    out = []
    for r in rules:
        words = _clean_words(r.get("keywords"))
        if not words:
            continue
        if r.get("role") not in DEPT_ROLE_CHOICES:
            raise ValueError(f"「{'、'.join(words)}」对应的角色不对")
        out.append({"keywords": words, "role": r["role"], "github": bool(r.get("github"))})
    return out


def _dept_matches(rule: dict, name: str) -> bool:
    """部门名对不对得上这条规则。开成管理员的要整个名字对上（写「技术」认「技术」「技术部」），
    别的角色名字里含这个词就算——不然「技术支持」「售后技术服务」也会被开成管理员。"""
    for w in rule["keywords"]:
        w = w.strip().lower()
        if not w:
            continue
        if str(rule["role"]) == str(StaffRole.ADMIN):
            if name in (w, w + "部"):
                return True
        elif w in name:
            return True
    return False


def rule_for_departments(db: Session, departments: list[str]) -> dict | None:
    """部门（含上级）里有一个对得上某条（见 _dept_matches）就用那条，按规则顺序取第一条；对不上返回 None。"""
    names = [d.strip().lower() for d in departments if d and d.strip()]
    if not names:
        return None
    for rule in dept_roles(db):
        if any(_dept_matches(rule, n) for n in names):
            return rule
    return None


def needs_github(db: Session, staff: Staff) -> bool:
    """这个人的部门对上了勾了「要填 GitHub」的规则。"""
    rule = rule_for_departments(db, (staff.department or "").split("、"))
    return bool(rule and rule.get("github"))


def _clean_words(keywords) -> list[str]:
    words = []
    for w in keywords or []:
        w = str(w).strip()
        if w and w not in words:
            words.append(w)
    return words


def title_roles(db: Session) -> list[dict]:
    from app.services.app_settings import get_setting

    raw = get_setting(db, TITLE_ROLES_KEY, "")
    if not raw:
        return [dict(r, role=str(r["role"])) for r in DEFAULT_TITLE_ROLES]
    try:
        rules = json.loads(raw)
    except ValueError:
        return []
    return [r for r in rules if isinstance(r, dict) and r.get("role") in TITLE_ROLE_CHOICES and r.get("keywords")]


def clean_title_roles(rules: list[dict]) -> list[dict]:
    """保存前整理：去空词、去重；角色必须是非管理员的真人角色。不合法抛 ValueError。"""
    out = []
    for r in rules:
        words = _clean_words(r.get("keywords"))
        if not words:
            continue
        if r.get("role") not in TITLE_ROLE_CHOICES:
            raise ValueError(f"「{'、'.join(words)}」对应的角色不能自动给")
        out.append({"keywords": words, "role": r["role"]})
    return out


def role_for_title(db: Session, title: str | None) -> str | None:
    """职位里含哪条的关键词就给哪个角色，按顺序取第一条；对不上返回 None（建成待分配）。"""
    t = (title or "").strip().lower()
    if not t:
        return None
    for rule in title_roles(db):
        if any(w.lower() in t for w in rule["keywords"]):
            return rule["role"]
    return None


def _csv(value: str) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


def why_not(*, dry_run: bool = False) -> str | None:
    if not dingtalk.configured():
        return "ERP 没配钉钉应用（DINGTALK_CLIENT_ID / SECRET / AGENT_ID）"
    if not dry_run and not settings.dingtalk_sync_enabled:
        return "钉钉账号同步未开启（DINGTALK_SYNC_ENABLED）"
    return None


def in_scope(userid: str) -> bool:
    only = _csv(settings.dingtalk_sync_only_userids)
    return not only or userid in only


def event_userids(data) -> list[str]:
    """事件里的人。钉钉不同通道键名大小写不一（UserId / userId / userid），值可能是数组或单个。"""
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return []
    if not isinstance(data, dict):
        return []
    for key in ("UserId", "userId", "userid", "UserIds", "userIds"):
        value = data.get(key)
        if value:
            return [str(v) for v in (value if isinstance(value, list) else [value]) if v]
    return []


def _linked(db: Session, userid: str) -> list[Staff]:
    return db.query(Staff).filter(Staff.dingtalk_userid == userid, Staff.deleted_at.is_(None)).all()


def _new_password() -> str:
    return "".join(secrets.choice(_PASSWORD_CHARS) for _ in range(10))


def _notify_admins(api, text: str) -> None:
    to = _csv(settings.dingtalk_notify_userids)
    if to:
        api.send_text(to, text)


def on_join(db: Session, userid: str, *, api=dingtalk, dry_run: bool = False) -> str:
    """给钉钉新员工建待分配账号。返回一行说明；读钉钉失败抛 DingtalkError（调用方决定重试）。"""
    if not in_scope(userid):
        return f"{userid}：不在试运行名单，跳过"
    existing = _linked(db, userid)
    if existing:
        return f"{userid}：已有账号 {existing[0].staff_no}，跳过"
    user = api.get_user(userid)
    name = (user.get("name") or "").strip()[:64]
    title = (user.get("title") or "").strip()
    departments, dept_error = _departments(api, user)
    dept_rule = rule_for_departments(db, departments)
    role = dept_rule["role"] if dept_rule else role_for_title(db, title)
    need_github = bool(dept_rule and dept_rule.get("github"))
    dept_text = "、".join(departments)[:128]
    staff_no = generate_staff_no(db)
    what = f"{_ROLE_NAME.get(role, role)}账号" if role else "待分配账号"
    who = f"职位「{title or '空'}」，部门「{dept_text or ('没读到：' + dept_error if dept_error else '空')}」"
    if dry_run:
        return f"{name}（{userid}，{who}）：会建{what} {staff_no}" + ("，要填 GitHub" if need_github else "")

    username, n = staff_no, 1
    while db.query(Staff.id).filter(Staff.username == username).first():
        n += 1
        username = f"{staff_no}-{n}"
    password = _new_password()
    staff = Staff(
        staff_no=staff_no,
        username=username,
        password_hash=hash_password(password),
        name=name,
        status=StaffStatus.ACTIVE if role else StaffStatus.PENDING,
        dingtalk_userid=userid,
        department=dept_text or None,
    )
    if role:
        staff.role = role
    db.add(staff)
    from app.services import oa_push

    oa_push.on_staff_synced(db, staff)
    db.commit()

    sent, why = api.send_text(
        [userid],
        f"{name}，你的 ERP 账号已开通。\n账号：{username}\n初始密码：{password}\n"
        + (f"岗位：{_ROLE_NAME.get(role, role)}，现在就能登录，登录后请尽快改密码。" if role
           else "管理员分配岗位后才能登录，登录后请尽快改密码。")
        + f"\n登录地址：{LOGIN_URL}"
        + ("\n你的部门要用公司代码仓库：登录后到「我的 → 我的信息」填 GitHub 邮箱或用户名，填了会自动邀请你进仓库。" if need_github else ""),
    )
    _send_guide(api, userid, staff, name)
    logger.info("钉钉入职建号 %s %s（%s），初始密码%s", staff_no, name, userid, "已发本人" if sent else f"没发出：{why}")
    _notify_admins(
        api,
        f"钉钉新员工「{name}」（{who}）入职，ERP 已建{what} {username}（工号 {staff_no}）。\n"
        + ("初始密码已用工作通知发给本人。" if sent else f"初始密码没发到本人（{why}），请在后台重置密码后告诉他。")
        + (f"\n已按部门开成{_ROLE_NAME.get(role, role)}，不对到后台「员工管理」改。" if dept_rule
           else "\n已按职位开通，角色不对到后台「员工管理」改。" if role
           else "\n部门、职位都对不上角色：请到后台「员工管理」分配角色并改为已激活（常见的可在「钉钉部门/职位对应」里加上）。")
        + ("\n这个部门要填 GitHub，本人填了会自动邀请进代码仓库，后台「员工管理」看得到结果。" if need_github else ""),
    )
    return f"{name}（{userid}）：已建{what} {staff_no}，初始密码{'已发本人' if sent else '没发出：' + why}"


def _departments(api, user: dict) -> tuple[list[str], str]:
    """钉钉部门名（含上级）。读不到不挡建号，退回只看职位，原因写进管理员通知。"""
    lookup = getattr(api, "department_names", None)
    if lookup is None:
        return [], ""
    try:
        return lookup(user.get("dept_id_list") or []), ""
    except dingtalk.DingtalkError as exc:
        logger.warning("钉钉部门没读到 %s：%s", user.get("userid"), exc)
        return [], str(exc)


def _send_guide(api, userid: str, staff: Staff, name: str) -> None:
    """新员工教程（商品匹配等实操视频 + 复验小测）。链接自带凭证，账号还没激活也能看、能交小测。"""
    from app.routers.guide import guide_link

    send_card = getattr(api, "send_card", None)
    if send_card is None:
        return
    send_card(
        [userid],
        "新员工教程",
        f"### {name}，欢迎加入\n\n上岗前先看完教程：怎么登录 ERP、怎么匹配商品、被退回了怎么补正。最后做 5 道复验小题，成绩管理员看得到。",
        guide_link(staff.id),
        "打开新员工教程",
    )


def on_leave(db: Session, userid: str, *, api=dingtalk, dry_run: bool = False) -> str:
    """钉钉离职：关联了这个 userid 的号软删除。"""
    if not in_scope(userid):
        return f"{userid}：不在试运行名单，跳过"
    staffs = _linked(db, userid)
    if not staffs:
        return f"{userid}：没关联 ERP 账号，跳过"
    labels = "、".join(f"{s.staff_no} {s.name}" for s in staffs)
    if dry_run:
        return f"{userid}：会删除账号 {labels}"
    for staff in staffs:
        staff_account.soft_delete(db, staff)
    db.commit()
    logger.info("钉钉离职删号 %s（%s）", labels, userid)
    _notify_admins(api, f"钉钉员工离职，ERP 账号已删除（停用、保留历史单据）：{labels}。")
    return f"{userid}：已删除账号 {labels}"


def on_modify(db: Session, userid: str, *, api=dingtalk, dry_run: bool = False, user: dict | None = None) -> str:
    """钉钉里改了人（调部门）：更新 staff.department。按部门给的角色不自动改（自动降管理员可能把人锁在外面），
    原来按部门开成管理员、现在部门对不上了，或者不再是要用代码仓库的部门，通知管理员去看。"""
    if not in_scope(userid):
        return ""
    staffs = _linked(db, userid)
    if not staffs:
        return ""
    if user is None:
        try:
            user = api.get_user(userid)
        except dingtalk.DingtalkError as exc:
            logger.warning("钉钉调部门没读到人 %s：%s", userid, exc)
            return ""
    departments, dept_error = _departments(api, user)
    if dept_error or not departments:
        return ""
    dept_text = "、".join(departments)[:128]
    changed = [s for s in staffs if (s.department or "") != dept_text]
    if not changed:
        return ""
    new_rule = rule_for_departments(db, departments)
    notes = []
    for s in changed:
        old_rule = rule_for_departments(db, (s.department or "").split("、"))
        was_admin_by_dept = bool(old_rule and str(old_rule["role"]) == str(StaffRole.ADMIN) and s.role == StaffRole.ADMIN)
        if was_admin_by_dept and not (new_rule and str(new_rule["role"]) == str(StaffRole.ADMIN)):
            notes.append(f"{s.staff_no} {s.name} 调到「{dept_text}」，原来按部门开的管理员没自动收回，到后台「员工管理」看要不要改角色")
        if old_rule and old_rule.get("github") and not (new_rule and new_rule.get("github")) and s.github_account:
            notes.append(f"{s.staff_no} {s.name} 不在要用代码仓库的部门了，GitHub {s.github_account} 还在仓库里，不用了在后台清掉")
        if not dry_run:
            s.department = dept_text
    if dry_run:
        return f"{userid}：部门会改成「{dept_text}」"
    db.commit()
    if notes:
        _notify_admins(api, "钉钉员工调部门：\n" + "\n".join(notes))
    return f"{userid}：部门改成「{dept_text}」"


def handle_event(db: Session, event_type: str, data, *, api=dingtalk, dry_run: bool = False) -> list[str]:
    """Stream 收到的一条事件。不是入职/离职/调部门的返回空。"""
    if event_type == JOIN:
        handler = on_join
    elif event_type == LEAVE:
        handler = on_leave
    elif event_type == MODIFY:
        handler = on_modify
    else:
        return []
    return [line for uid in event_userids(data) if (line := handler(db, uid, api=api, dry_run=dry_run))]


@dataclass
class Report:
    lines: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def reconcile(db: Session, *, api=dingtalk, dry_run: bool = False, create_missing: bool = False) -> Report:
    """每天对一次账，补漏掉的事件。见模块说明。"""
    report = Report()
    linked = db.query(Staff).filter(Staff.dingtalk_userid.isnot(None), Staff.deleted_at.is_(None)).all()
    for userid in sorted({s.dingtalk_userid for s in linked}):
        if not in_scope(userid):
            continue
        try:
            user = api.get_user(userid)
        except dingtalk.DingtalkError as exc:
            if exc.code == dingtalk.USER_NOT_FOUND:
                report.lines.append(on_leave(db, userid, api=api, dry_run=dry_run))
            else:
                report.errors.append(f"{userid}：{exc}")
            continue
        # 调部门的事件没订阅上 / 漏了，每天对账时补
        line = on_modify(db, userid, api=api, dry_run=dry_run, user=user)
        if line:
            report.lines.append(line)

    try:
        members = api.list_users()
    except dingtalk.DingtalkError as exc:
        report.errors.append(f"读不到钉钉全员，只核了已关联的人：{exc}")
        return report
    known = {s.dingtalk_userid for s in linked}
    missing = [m for m in members if m["userid"] not in known and in_scope(m["userid"])]
    for m in missing:
        if create_missing:
            try:
                report.lines.append(on_join(db, m["userid"], api=api, dry_run=dry_run))
            except dingtalk.DingtalkError as exc:
                report.errors.append(f"{m.get('name')}（{m['userid']}）：{exc}")
        else:
            report.lines.append(f"{m.get('name')}（{m['userid']}）：钉钉里有，ERP 没关联")
    return report


def _mask(mobile: str | None) -> str:
    return f"{mobile[:3]}****{mobile[-4:]}" if mobile and len(mobile) >= 7 else ""


def match_rows(db: Session, members: list[dict]) -> list[dict]:
    """钉钉成员 ↔ ERP 账号的候选：已关联的直接给出；没关联的按姓名、手机卡号码找。只读。"""
    staffs = db.query(Staff).filter(Staff.deleted_at.is_(None)).all()
    by_userid = {s.dingtalk_userid: s for s in staffs if s.dingtalk_userid}
    by_name: dict[str, list[Staff]] = {}
    for s in staffs:
        by_name.setdefault((s.name or "").strip(), []).append(s)
    by_phone: dict[str, set[str]] = {}
    for card in db.query(StaffSimCard).filter(StaffSimCard.phone.isnot(None)).all():
        by_phone.setdefault(card.phone.strip(), set()).add(card.staff_id)
    staff_by_id = {s.id: s for s in staffs}

    rows = []
    for m in sorted(members, key=lambda x: x.get("name") or ""):
        row = {"userid": m["userid"], "name": m.get("name") or "", "mobile": _mask(m.get("mobile")), "title": m.get("title") or ""}
        if m["userid"] in by_userid:
            row.update(status="已关联", staff=[by_userid[m["userid"]]])
        else:
            cands = {s.id: s for s in by_name.get(row["name"].strip(), [])}
            for sid in by_phone.get((m.get("mobile") or "").strip(), ()):
                if sid in staff_by_id:
                    cands[sid] = staff_by_id[sid]
            cands = [s for s in cands.values() if not s.dingtalk_userid]
            row.update(status="候选" if cands else "ERP 里没找到", staff=cands)
        rows.append(row)
    return rows


def link(db: Session, staff: Staff, userid: str) -> None:
    """把 ERP 账号关联到钉钉 userid。不 commit。"""
    staff.dingtalk_userid = userid
