"""钉钉入职建号、离职删号、对账、对照。不连真钉钉：FakeApi 顶替 services/dingtalk。"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.enums import StaffStatus
from app.models import Staff, StaffSimCard
from app.services import dingtalk, dingtalk_sync
from app.services.password import verify_password


class FakeApi:
    DingtalkError = dingtalk.DingtalkError

    def __init__(self, users=None, list_error=None):
        self.users = users or {}
        self.list_error = list_error
        self.sent = []

    def get_user(self, userid):
        if userid not in self.users:
            raise dingtalk.DingtalkError(dingtalk.USER_NOT_FOUND, "钉钉里找不到这个人")
        return self.users[userid]

    def list_users(self):
        if self.list_error:
            raise self.list_error
        return list(self.users.values())

    def send_text(self, userids, content):
        self.sent.append((list(userids), content))
        return True, "ok"


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    from app.models import AppSetting
    Base.metadata.create_all(engine, tables=[Staff.__table__, StaffSimCard.__table__, AppSetting.__table__])
    session = sessionmaker(bind=engine, autoflush=False)()
    yield session
    session.close()


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setattr(settings, "dingtalk_sync_only_userids", "")
    monkeypatch.setattr(settings, "dingtalk_notify_userids", "admin1")
    monkeypatch.setattr(settings, "oa_push_enabled", False)


def _staff(db, staff_no, name, *, userid=None, username=None):
    s = Staff(staff_no=staff_no, username=username or staff_no.lower(), password_hash="x", name=name,
              status=StaffStatus.ACTIVE, dingtalk_userid=userid)
    db.add(s)
    db.commit()
    return s


def test_event_userids_handles_key_casing():
    assert dingtalk_sync.event_userids({"UserId": ["a", "b"]}) == ["a", "b"]
    assert dingtalk_sync.event_userids('{"userId": ["c"]}') == ["c"]
    assert dingtalk_sync.event_userids({"userid": "d"}) == ["d"]
    assert dingtalk_sync.event_userids("not json") == []


def test_join_creates_pending_account_and_sends_password(db):
    _staff(db, "E007", "老员工")
    api = FakeApi({"u1": {"userid": "u1", "name": "张三"}})
    line = dingtalk_sync.on_join(db, "u1", api=api)
    staff = db.query(Staff).filter(Staff.dingtalk_userid == "u1").one()
    assert staff.staff_no == "E008" and staff.username == "E008" and staff.name == "张三"
    assert staff.status == StaffStatus.PENDING
    assert "已建待分配账号 E008" in line
    to_user, to_admin = api.sent
    assert to_user[0] == ["u1"] and "账号：E008" in to_user[1]
    password = to_user[1].split("初始密码：")[1].split("\n")[0]
    assert len(password) == 10 and verify_password(password, staff.password_hash)
    assert to_admin[0] == ["admin1"] and password not in to_admin[1]


def test_join_is_idempotent_and_dry_run_writes_nothing(db):
    api = FakeApi({"u1": {"userid": "u1", "name": "张三"}})
    assert "会建" in dingtalk_sync.on_join(db, "u1", api=api, dry_run=True)
    assert db.query(Staff).count() == 0 and api.sent == []
    dingtalk_sync.on_join(db, "u1", api=api)
    assert "已有账号" in dingtalk_sync.on_join(db, "u1", api=api)
    assert db.query(Staff).count() == 1


def test_join_username_collision_gets_suffix(db):
    _staff(db, "E001", "甲", username="E002")
    api = FakeApi({"u1": {"userid": "u1", "name": "乙"}})
    dingtalk_sync.on_join(db, "u1", api=api)
    assert db.query(Staff).filter(Staff.dingtalk_userid == "u1").one().username == "E002-2"


def test_leave_soft_deletes_only_linked_account(db):
    linked = _staff(db, "E001", "张三", userid="u1")
    other = _staff(db, "E002", "张三")  # 同名但没关联，不能动
    api = FakeApi()
    assert "已删除账号 E001" in dingtalk_sync.on_leave(db, "u1", api=api)
    db.refresh(linked)
    db.refresh(other)
    assert linked.deleted_at and linked.status == StaffStatus.DISABLED and "__del_" in linked.username
    assert other.deleted_at is None
    assert "没关联" in dingtalk_sync.on_leave(db, "u9", api=api)


def test_only_userids_limits_scope(db, monkeypatch):
    monkeypatch.setattr(settings, "dingtalk_sync_only_userids", "u1")
    _staff(db, "E001", "李四", userid="u2")
    api = FakeApi({"u2": {"userid": "u2", "name": "李四"}})
    assert "不在试运行名单" in dingtalk_sync.on_leave(db, "u2", api=api)
    assert "不在试运行名单" in dingtalk_sync.on_join(db, "u3", api=api)
    assert db.query(Staff).filter(Staff.deleted_at.isnot(None)).count() == 0


def test_handle_event_routes_by_type(db):
    _staff(db, "E001", "张三", userid="u1")
    api = FakeApi({"u2": {"userid": "u2", "name": "王五"}})
    assert dingtalk_sync.handle_event(db, "user_modify_org", {"UserId": ["u1"]}, api=api) == []
    lines = dingtalk_sync.handle_event(db, "user_leave_org", '{"UserId": ["u1"]}', api=api)
    assert "已删除" in lines[0]
    lines = dingtalk_sync.handle_event(db, "user_add_org", {"userId": ["u2"]}, api=api)
    assert "已建待分配账号" in lines[0]


def test_reconcile_deletes_gone_users_and_lists_unlinked(db):
    gone = _staff(db, "E001", "离职的", userid="gone")
    _staff(db, "E002", "在职的", userid="here")
    api = FakeApi({"here": {"userid": "here", "name": "在职的"}, "new": {"userid": "new", "name": "新人"}})
    report = dingtalk_sync.reconcile(db, api=api)
    db.refresh(gone)
    assert gone.deleted_at is not None
    assert any("新人" in l and "没关联" in l for l in report.lines)
    assert db.query(Staff).filter(Staff.dingtalk_userid == "new").count() == 0  # 默认不建

    report = dingtalk_sync.reconcile(db, api=api, create_missing=True)
    assert db.query(Staff).filter(Staff.dingtalk_userid == "new").count() == 1


def test_reconcile_scope_error_is_not_leave(db):
    s = _staff(db, "E001", "张三", userid="u1")

    class ScopeApi(FakeApi):
        def get_user(self, userid):
            raise dingtalk.DingtalkError(dingtalk.OUT_OF_SCOPE, "不在范围")

    report = dingtalk_sync.reconcile(db, api=ScopeApi(list_error=dingtalk.DingtalkError(50004, "不在范围")))
    db.refresh(s)
    assert s.deleted_at is None
    assert len(report.errors) == 2


def test_match_rows_by_name_and_phone(db):
    _staff(db, "E001", "已关联", userid="u1")
    by_name = _staff(db, "E002", "张三")
    by_phone = _staff(db, "E003", "阿四")
    db.add(StaffSimCard(staff_id=by_phone.id, phone="00034518065"))
    db.commit()
    rows = {r["userid"]: r for r in dingtalk_sync.match_rows(db, [
        {"userid": "u1", "name": "已关联"},
        {"userid": "u2", "name": "张三", "mobile": "00026013516"},
        {"userid": "u3", "name": "李四", "mobile": "00034518065"},
        {"userid": "u4", "name": "没这人"},
    ])}
    assert rows["u1"]["status"] == "已关联"
    assert [s.id for s in rows["u2"]["staff"]] == [by_name.id]
    assert [s.id for s in rows["u3"]["staff"]] == [by_phone.id] and rows["u3"]["mobile"] == "138****1111"
    assert rows["u4"]["status"] == "ERP 里没找到"


def test_title_maps_to_role_and_activates(db):
    from app.enums import StaffRole
    api = FakeApi({"u1": {"userid": "u1", "name": "仓管小王", "title": "仓库管理员"},
                   "u2": {"userid": "u2", "name": "程序员", "title": "程序员"}})
    dingtalk_sync.on_join(db, "u1", api=api)
    s1 = db.query(Staff).filter(Staff.dingtalk_userid == "u1").one()
    assert (s1.role, s1.status) == (StaffRole.WAREHOUSE, StaffStatus.ACTIVE)
    assert "现在就能登录" in api.sent[0][1]
    dingtalk_sync.on_join(db, "u2", api=api)
    assert db.query(Staff).filter(Staff.dingtalk_userid == "u2").one().status == StaffStatus.PENDING


def test_title_rules_from_setting_and_admin_never_auto(db):
    import json
    from app.models import AppSetting
    db.add(AppSetting(key=dingtalk_sync.TITLE_ROLES_KEY, value=json.dumps(
        [{"keywords": ["主管"], "role": "ADMIN"}, {"keywords": ["门店"], "role": "SALES"}])))
    db.commit()
    assert dingtalk_sync.role_for_title(db, "门店主管") == "SALES"  # ADMIN 那条被忽略
    with pytest.raises(ValueError):
        dingtalk_sync.clean_title_roles([{"keywords": ["主管"], "role": "ADMIN"}])
    assert dingtalk_sync.clean_title_roles([{"keywords": [" 仓管 ", "仓管", ""], "role": "WAREHOUSE"}, {"keywords": [], "role": "SALES"}]) == \
        [{"keywords": ["仓管"], "role": "WAREHOUSE"}]


class DeptApi(FakeApi):
    """带部门：dept_id_list 里的 id → 名字（已含上级）。"""

    def __init__(self, users, depts, dept_error=None):
        super().__init__(users)
        self.depts = depts
        self.dept_error = dept_error

    def department_names(self, dept_ids):
        if self.dept_error:
            raise self.dept_error
        return [n for d in dept_ids for n in self.depts.get(d, [])]


def test_tech_department_gets_admin_and_github_hint(db):
    """11-10 用户定：技术部入职给管理员，提醒填 GitHub；部门比职位先看。"""
    from app.enums import StaffRole
    api = DeptApi({"u1": {"userid": "u1", "name": "方栋梓", "title": "仓管", "dept_id_list": [7]},
                   "u2": {"userid": "u2", "name": "小李", "title": "仓库", "dept_id_list": [8]}},
                  {7: ["后端组", "技术部"], 8: ["仓管部"]})
    dingtalk_sync.on_join(db, "u1", api=api)
    s1 = db.query(Staff).filter(Staff.dingtalk_userid == "u1").one()
    assert (s1.role, s1.status, s1.department) == (StaffRole.ADMIN, StaffStatus.ACTIVE, "后端组、技术部")
    assert "GitHub" in api.sent[0][1]
    assert any("按部门开成管理员" in text for _, text in api.sent)
    assert dingtalk_sync.needs_github(db, s1)

    dingtalk_sync.on_join(db, "u2", api=api)
    s2 = db.query(Staff).filter(Staff.dingtalk_userid == "u2").one()
    assert s2.role == StaffRole.WAREHOUSE and not dingtalk_sync.needs_github(db, s2)
    assert not any("GitHub" in text for to, text in api.sent if to == ["u2"])


def test_department_unreadable_falls_back_to_title(db):
    from app.enums import StaffRole
    api = DeptApi({"u1": {"userid": "u1", "name": "小王", "title": "采购", "dept_id_list": [7]}}, {},
                  dept_error=dingtalk.DingtalkError(60011, "没有权限"))
    dingtalk_sync.on_join(db, "u1", api=api)
    s = db.query(Staff).filter(Staff.dingtalk_userid == "u1").one()
    assert (s.role, s.department) == (StaffRole.PURCHASER, None)
    assert any("没读到" in text for to, text in api.sent if to == ["admin1"])


def test_dept_rules_from_setting_allow_admin(db):
    import json
    from app.models import AppSetting
    assert dingtalk_sync.clean_dept_roles([{"keywords": [" 研发 ", "研发"], "role": "ADMIN", "github": 1}]) == \
        [{"keywords": ["研发"], "role": "ADMIN", "github": True}]
    with pytest.raises(ValueError):
        dingtalk_sync.clean_dept_roles([{"keywords": ["研发"], "role": "RFID_DEVICE"}])
    db.add(AppSetting(key=dingtalk_sync.DEPT_ROLES_KEY, value=json.dumps([{"keywords": ["直播"], "role": "SALES"}])))
    db.commit()
    assert dingtalk_sync.rule_for_departments(db, ["技术部"]) is None  # 改过就不再用默认
    assert dingtalk_sync.rule_for_departments(db, ["直播部"]) == {"keywords": ["直播"], "role": "SALES", "github": False}


def test_department_names_walks_up_to_root():
    calls = []
    tree = {7: {"name": "后端组", "parent_id": 3}, 3: {"name": "技术部", "parent_id": 1}, 4: {"name": "仓管部", "parent_id": 1}}

    def poster(url, payload):
        if "gettoken" in url or "accessToken" in url:
            return {"errcode": 0, "access_token": "DEMO_ONLY_REDACTED", "expires_in": 7200, "accessToken": "t", "expireIn": 7200}
        calls.append(payload["dept_id"])
        return {"errcode": 0, "result": tree[payload["dept_id"]]}

    dingtalk._token_cache.update(token="t", expires_at=9e18)
    try:
        assert dingtalk.department_names([7, 4, 3], poster=poster) == ["后端组", "技术部", "仓管部"]
    finally:
        dingtalk._token_cache.update(token=None, expires_at=0.0)
    assert calls == [7, 3, 4]  # 技术部只查一次


def test_admin_department_rule_needs_whole_name(db):
    """「技术」→管理员：技术、技术部、技术部下面的小组算；技术支持、售后技术服务、非技术岗不算。"""
    from app.enums import StaffRole
    assert dingtalk_sync.rule_for_departments(db, ["技术部"])["role"] == StaffRole.ADMIN
    assert dingtalk_sync.rule_for_departments(db, ["后端组", "技术部"])["role"] == StaffRole.ADMIN
    assert dingtalk_sync.rule_for_departments(db, ["技术"])["role"] == StaffRole.ADMIN
    for name in ("技术支持部", "售后技术服务", "非技术岗"):
        assert dingtalk_sync.rule_for_departments(db, [name]) is None, name


def test_modify_updates_department_and_tells_admins_when_dept_admin_moves_out(db):
    from app.enums import StaffRole
    api = DeptApi({"u1": {"userid": "u1", "name": "方栋梓", "title": "", "dept_id_list": [7]}},
                  {7: ["后端组", "技术部"], 9: ["仓管部"]})
    dingtalk_sync.on_join(db, "u1", api=api)
    s = db.query(Staff).filter(Staff.dingtalk_userid == "u1").one()
    assert s.role == StaffRole.ADMIN
    api.sent.clear()
    api.users["u1"]["dept_id_list"] = [9]
    dingtalk_sync.handle_event(db, dingtalk_sync.MODIFY, '{"userId": ["u1"]}', api=api)
    db.refresh(s)
    assert s.department == "仓管部" and s.role == StaffRole.ADMIN  # 不自动降
    assert any("没自动收回" in text for _, text in api.sent)
    api.sent.clear()
    assert dingtalk_sync.on_modify(db, "u1", api=api) == ""  # 没变不再通知
    assert api.sent == []


def test_github_revoke_removes_collaborator_and_pending_invite(monkeypatch):
    from app.services import github_invite
    monkeypatch.setattr(github_invite.settings, "github_invite_token", "t")
    monkeypatch.setattr(github_invite.settings, "github_invite_repos", "boss/erp")
    calls = []

    def http(method, path, **kw):
        calls.append((method, path))
        if path == "/users/olduser":
            return 200, {"login": "olduser"}
        if method == "GET" and path.endswith("/invitations"):
            return 200, {"items": [{"id": 5, "invitee": {"login": "OldUser"}}, {"id": 6, "invitee": {"login": "x"}}]}
        return 204, {}

    msg = github_invite.revoke("olduser", http=http)
    assert ("DELETE", "/repos/boss/erp/collaborators/olduser") in calls
    assert ("DELETE", "/repos/boss/erp/invitations/5") in calls
    assert ("DELETE", "/repos/boss/erp/invitations/6") not in calls
    assert "已移出" in msg
