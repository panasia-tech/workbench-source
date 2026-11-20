"""假的 Frappe（hr.panasia.fun）：按 REST 接口（/api/resource/User、Role、Employee、Department，
/api/method/frappe.auth.get_logged_user）写的内存实现，挂在 httpx.MockTransport 上，同步走的是真的客户端代码（token 头、
报错、提示的解析）。Frappe 同步（test_frappe_sync.py）和部门 → 分组（test_frappe_departments.py）共用。

User 的行为照 Frappe 16 的源码学的：主键是小写邮箱、角色要在 Role 里有（不然 LinkValidationError）、LMS 给每个新号加
LMS Student、ERPNext 没有员工档案关联就删掉 Employee、停用的角色保存时去掉、用户类型按角色能不能进后台算、用户名撞了
提示一句另起一个、send_welcome_email 不关就发欢迎邮件。

Employee、Department 只读：列表接口只回点名要的字段（点了没有的字段报错，和 Frappe 一样），fields=["*"] 回全部字段；
部门是一棵树（parent_department），「停用」这一项可以去掉，模拟没有这个字段的版本。
"""

import copy
import json
import re
from urllib.parse import unquote

import httpx

KEY, SECRET = "DEMO_ONLY_REDACTED", "fr-secret"
ME = "1daee17e42@example.invalid"

# 角色名 → (能不能进后台 desk_access, 停用没有)
ROLES = {
    "System Manager": (1, 0), "Sales User": (1, 0), "Sales Manager": (1, 0), "HR User": (1, 0),
    "LMS Student": (0, 0), "Course Creator": (0, 0), "Employee": (1, 0), "Employee Self Service": (1, 0),
    "Leave Approver": (1, 0), "Expense Approver": (1, 0), "Administrator": (1, 0), "Guest": (0, 0),
    "All": (0, 0), "Desk User": (1, 0), "Old Role": (1, 1),
}
ROOT_DEPARTMENT = "所有部门"
# 10-19 线上读到的部门：ERPNext 给两个公司各种了一套默认部门（带公司后缀），另有三个自己建的，都挂在根下面
DEFAULT_DEPARTMENTS = ["会计", "市场营销", "销售", "采购", "运营", "生产", "派遣", "客户服务", "人力资源", "管理",
                       "质量管理", "研究与发展", "法律"]
LIVE_DEPARTMENTS = (
    [f"{d} - 泛亚" for d in DEFAULT_DEPARTMENTS] + [f"{d} - 泛亚D" for d in DEFAULT_DEPARTMENTS]
    + ["采购部 - 泛亚", "技术部 - 泛亚", "管理部 - 泛亚"]
)
# 员工档案的字段（列表接口只许点这些）
EMPLOYEE_FIELDS = {"name", "employee_name", "department", "user_id", "status", "company", "gender", "date_of_birth",
                   "date_of_joining", "personal_email", "cell_number", "owner", "creation", "modified"}


def frappe_error(status, exc_type, message):
    return httpx.Response(status, json={"exc_type": exc_type,
                                        "_server_messages": json.dumps([json.dumps({"message": message})])})


class FakeFrappe:
    def __init__(self):
        self.me = ME
        self.roles = {name: {"desk_access": d, "disabled": x} for name, (d, x) in ROLES.items()}
        self.users: dict[str, dict] = {}
        self.employee_docs: dict[str, dict] = {}     # 档案号 → 员工档案
        self.departments: dict[str, dict] = {}       # 部门名 → 部门
        self.has_disabled_field = True               # False：模拟部门没有「停用」字段的版本
        self.strip: set[str] = set()       # 假装某个 app 的钩子每次保存都把这些角色删掉
        self.fail: dict[tuple[str, str], int] = {}   # (方法, 用户名 / Employee / Department) → 状态码
        self.on_get: dict[str, object] = {}          # 用户名 → 每次 GET 这个号之前调一下（模拟有人同时在改）
        self.calls: list[tuple[str, str]] = []
        self.welcome: list[str] = []

    # 造数据
    def add_user(self, name, *, owner="Administrator", roles=(), enabled=True, first_name=None, username=None):
        u = {"name": name, "email": name, "owner": owner, "enabled": int(enabled),
             "first_name": first_name or name.split("@")[0], "middle_name": None, "last_name": None,
             "username": username, "roles": list(roles)}
        self._derive(u)
        self.users[name] = u
        return u

    def add_department(self, name, parent=ROOT_DEPARTMENT, *, disabled=False, is_group=False):
        company = name.rsplit(" - ", 1)[1] if " - " in name else None
        self.departments[name] = {
            "name": name, "department_name": name.rsplit(" - ", 1)[0], "parent_department": parent or "",
            "company": company, "is_group": int(is_group), "disabled": int(disabled), "lft": 0, "rgt": 0,
            "old_parent": parent or "", "owner": "Administrator", "docstatus": 0,
        }
        if parent and parent in self.departments:
            self.departments[parent]["is_group"] = 1
        return self.departments[name]

    def add_employee(self, name, employee_name, *, department=None, user_id=None, status="Active"):
        self.employee_docs[name] = {
            "name": name, "employee_name": employee_name, "department": department, "user_id": user_id,
            "status": status, "company": "泛亚", "gender": "Male", "date_of_birth": "1990-01-01",
            "date_of_joining": "2024-01-01", "personal_email": None, "cell_number": "00030902120",
            "owner": "Administrator", "creation": "2026-10-01 10:00:00", "modified": "2026-10-01 10:00:00",
        }
        return self.employee_docs[name]

    def seed_live_hr(self):
        """10-19 线上 Frappe HR 的样子：部门树，三份测试档案（张三关联的是 961000e173@example.invalid，不是 ERP 的号；
        李四、王主管没关联号）。"""
        self.add_department(ROOT_DEPARTMENT, None, is_group=True)
        for name in LIVE_DEPARTMENTS:
            self.add_department(name)
        self.add_employee("HR-EMP-00001", "张三", department="销售 - 泛亚", user_id="961000e173@example.invalid")
        self.add_employee("HR-EMP-00002", "李四", department="采购部 - 泛亚")
        self.add_employee("HR-EMP-00003", "王主管", department="管理部 - 泛亚")

    # 查数据
    def roles_of(self, name):
        return sorted(self.users[name]["roles"])

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def snapshot(self):
        return copy.deepcopy((self.users, self.employee_docs, self.departments))

    def has_employee(self, user):
        """有员工档案关联着这个号（ERPNext 才不删它的 Employee 角色）。"""
        return any(e["user_id"] == user for e in self.employee_docs.values())

    # 接口
    def _derive(self, u):
        u["full_name"] = " ".join(p for p in (u["first_name"], u["middle_name"], u["last_name"]) if p)
        u["user_type"] = "System User" if any(self.roles[r]["desk_access"] for r in u["roles"]) else "Website User"

    def _doc(self, u):
        rows = [{"name": f"hr-{i}", "role": r, "parent": u["name"], "parenttype": "User", "parentfield": "roles"}
                for i, r in enumerate(u["roles"])]
        return {**{k: v for k, v in u.items() if k != "roles"}, "roles": rows}

    def _list(self, doctype, docs, request, allowed):
        """Frappe 的列表接口：只回点名要的字段，* 回全部；点了没有的字段报错。"""
        assert request.url.params["limit_page_length"] == "0", "人和部门要全取，不分页"
        if (status := self.fail.get(("GET", doctype))):
            return frappe_error(status, "PermissionError", f"No permission for {doctype}")
        fields = json.loads(request.url.params.get("fields") or '["name"]')
        if fields == ["*"]:
            return httpx.Response(200, json={"data": [dict(d) for d in docs]})
        if missing := [f for f in fields if f not in allowed]:
            return frappe_error(417, "DataError", f"Field not permitted in query: {missing[0]}")
        return httpx.Response(200, json={"data": [{f: d.get(f) for f in fields} for d in docs]})

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"token {KEY}:{SECRET}"
        method, path = request.method, unquote(request.url.path)
        self.calls.append((method, path))
        if path == "/api/method/frappe.auth.get_logged_user":
            return httpx.Response(200, json={"message": self.me})
        if path == "/api/resource/Role" and method == "GET":
            assert request.url.params["limit_page_length"] == "0"
            assert json.loads(request.url.params["fields"]) == ["name", "disabled"]
            rows = [{"name": k, "disabled": v["disabled"]} for k, v in self.roles.items()]
            return httpx.Response(200, json={"data": rows})
        if path == "/api/resource/Employee" and method == "GET":
            return self._list("Employee", self.employee_docs.values(), request, EMPLOYEE_FIELDS)
        if path == "/api/resource/Department" and method == "GET":
            docs = [{k: v for k, v in d.items() if k != "disabled" or self.has_disabled_field}
                    for d in self.departments.values()]
            allowed = set().union(*docs) if docs else {"name"}
            return self._list("Department", docs, request, allowed)
        if path == "/api/resource/User" and method == "GET":
            assert request.url.params["limit_page_length"] == "0"
            return httpx.Response(200, json={"data": [{"name": n} for n in self.users]})
        if path == "/api/resource/User" and method == "POST":
            return self._save(None, json.loads(request.content))
        if path.startswith("/api/resource/User/"):
            name = path.removeprefix("/api/resource/User/")
            if (status := self.fail.get((method, name))):
                return frappe_error(status, "ValidationError", "boom")
            if name not in self.users:
                return frappe_error(404, "DoesNotExistError", f"User {name} not found")
            if method == "GET":
                if (hook := self.on_get.get(name)):
                    hook(self.users[name])
                return httpx.Response(200, json={"data": self._doc(self.users[name])})
            if method == "PUT":
                return self._save(name, json.loads(request.content))
        return frappe_error(404, "DoesNotExistError", f"fake 没实现 {method} {path}")

    def _save(self, name, body):
        """照 Frappe 的 User.validate 和各 app 挂在 User 上的钩子走一遍。"""
        messages = []
        new = name is None
        if new:
            name = (body.get("email") or "").strip().lower()
            if (status := self.fail.get(("POST", name))):
                return frappe_error(status, "ValidationError", "boom")
            if not re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+", name):
                return frappe_error(417, "InvalidEmailAddressError", f"{name} is not a valid Email Address")
            if name in self.users:
                return frappe_error(409, "DuplicateEntryError", f"User {name} already exists")
            u = {"name": name, "email": name, "owner": self.me, "enabled": 1, "first_name": "",
                 "middle_name": None, "last_name": None, "username": None, "roles": []}
        else:
            u = copy.deepcopy(self.users[name])
        for key in ("first_name", "middle_name", "last_name", "enabled", "username"):
            if key in body:
                u[key] = body[key]
        if "roles" in body:
            u["roles"] = [r["role"] for r in body["roles"]]
        if missing := [r for r in u["roles"] if r not in self.roles]:
            return frappe_error(417, "LinkValidationError", f"Could not find Row #1: Role: {missing[0]}")
        if new:
            if int(body.get("send_welcome_email", 1)):
                self.welcome.append(name)
            u["roles"].append("LMS Student")   # lms：before_insert 给每个新号加 LMS Student
        u["roles"] = [r for r in dict.fromkeys(u["roles"]) if not self.roles[r]["disabled"]]
        if not self.has_employee(name):     # erpnext：validate_employee_role
            for role in ("Employee", "Employee Self Service"):
                if role in u["roles"]:
                    u["roles"].remove(role)
                    messages.append(f"User {name}: Removed {role} role as there is no mapped employee.")
        u["roles"] = [r for r in u["roles"] if r not in self.strip]
        if u["username"] and any(o["username"] == u["username"] and o["name"] != name for o in self.users.values()):
            messages.append(f"Username {u['username']} already exists")
            u["username"] = name.replace("@", "").replace(".", "")
        self._derive(u)
        self.users[name] = u
        data = {"data": self._doc(u)}
        if messages:
            data["_server_messages"] = json.dumps([json.dumps({"message": f"<b>{m}</b>"}) for m in messages])
        return httpx.Response(200, json=data)
