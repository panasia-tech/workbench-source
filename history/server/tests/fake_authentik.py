"""假的 Authentik：按 /api/v3 接口写的内存实现，挂在 httpx.MockTransport 上，同步走的是真的客户端代码（翻页、报错、
Bearer 头）。统一登录同步（test_authentik_sync.py）和能进哪些系统（test_authentik_access.py）共用。

照 Authentik 2026.8.3 的规矩：
  - 用户名、组名不许重复；每页只给 2 条，逼着同步翻页；
  - 应用按 slug 取；列表接口只列调用的人自己能进的应用，同步不该用它，这里调了直接报错；
  - 绑定的 policy / group / user 只能填一样；Authentik 要求同一个应用上「策略 + order」不重复，这里更严：同一个
    应用上 order 撞了就不收，钉死同步挑的 order 跟谁都不撞；
  - deny 里的权限，对应的接口回 403（和 Authentik 的 DRF 一样的报文）。

can_enter() 照 policies/engine.py 判一个人能不能进应用：只算启用的绑定，一条都没有谁都能进，any = 过一条就行；
策略绑定真的跑表达式（包成 def handler(request): …，和 Authentik 的 wrap_expression 一样），所以测的是线上那段代码。
"""

import copy
import json
import textwrap
import uuid
from types import SimpleNamespace

import httpx

TOKEN = "ak-test-token"

# 接口 → 要的权限（和 authentik_sync.AuthentikApi 里写的一样，是照 Authentik 的 RBAC 核对过的）
PERMS = {
    ("GET", "applications"): "authentik_core.view_application",
    ("GET", "bindings"): "authentik_policies.view_policybinding",
    ("POST", "bindings"): "authentik_policies.add_policybinding",
    ("DELETE", "bindings"): "authentik_policies.delete_policybinding",
    ("GET", "expression"): "authentik_policies_expression.view_expressionpolicy",
}
_DENIED = {"detail": "You do not have permission to perform this action."}


class FakeAuthentik:
    PAGE = 2

    def __init__(self):
        self.users: dict[int, dict] = {}
        self.groups: dict[str, dict] = {}
        self.apps: dict[str, dict] = {}       # slug → 应用
        self.policies: dict[str, dict] = {}   # pk → 表达式策略
        self.bindings: dict[str, dict] = {}   # pk → 绑定
        self._next_pk = 1
        self.calls: list[tuple[str, str]] = []
        self.fail: dict[tuple[str, str], int] = {}   # (方法, 用户名或组名或应用 slug) → 状态码
        self.deny: set[str] = set()                  # 服务账号没有的权限

    # 造数据
    def add_user(self, username, *, path="users", type="internal", attributes=None, name="", is_active=True):
        pk = self._next_pk
        self._next_pk += 1
        self.users[pk] = {"pk": pk, "username": username, "name": name, "is_active": is_active,
                          "path": path, "type": type, "attributes": attributes or {}}
        return pk

    def add_group(self, name, *, attributes=None, is_superuser=False, members=()):
        pk = str(uuid.uuid4())
        self.groups[pk] = {"pk": pk, "name": name, "is_superuser": is_superuser,
                           "attributes": attributes or {}, "users": set(members)}
        return pk

    def add_app(self, slug, *, mode="any", name=None):
        pk = str(uuid.uuid4())
        self.apps[slug] = {"pk": pk, "pbm_uuid": pk, "slug": slug, "name": name or slug,
                           "policy_engine_mode": mode, "provider": None, "meta_launch_url": ""}
        return pk

    def add_policy(self, name, expression):
        pk = str(uuid.uuid4())
        self.policies[pk] = {"pk": pk, "name": name, "expression": expression, "execution_logging": False,
                             "component": "ak-policy-expression-form", "meta_model_name": "authentik_policies_expression.expressionpolicy"}
        return pk

    def bind(self, slug, *, group=None, policy=None, user=None, order=None, enabled=True, negate=False,
             failure_result=False, expiring=False):
        """group / policy 给名字，user 给用户名。order 不给就照后台的做法取这个应用上最大的 +1。"""
        target = self.apps[slug]["pk"]
        if order is None:
            order = max((b["order"] for b in self.bindings.values() if b["target"] == target), default=-1) + 1
        pk = str(uuid.uuid4())
        self.bindings[pk] = {
            "pk": pk, "target": target, "order": order, "enabled": enabled, "negate": negate, "timeout": 30,
            "failure_result": failure_result, "expiring": expiring, "expires": None,
            "policy": self.policy(policy)["pk"] if policy else None,
            "group": self.group(group)["pk"] if group else None,
            "user": self.user(user)["pk"] if user else None,
        }
        return pk

    # 查数据
    def user(self, username):
        return next((u for u in self.users.values() if u["username"] == username), None)

    def group(self, name):
        return next((g for g in self.groups.values() if g["name"] == name), None)

    def policy(self, name):
        return next((p for p in self.policies.values() if p["name"] == name), None)

    def member_names(self, username):
        u = self.user(username)
        return sorted(g["name"] for g in self.groups.values() if u["pk"] in g["users"])

    def bindings_of(self, slug):
        target = self.apps[slug]["pk"]
        return sorted((b for b in self.bindings.values() if b["target"] == target), key=lambda b: b["order"])

    def describe(self, slug):
        """应用上的绑定，给人看：「组 X」「策略 Y」「用户 Z」，停用、取反的另外标出来。"""
        out = []
        for b in self.bindings_of(slug):
            if b["policy"]:
                text = f"策略 {self.policies[b['policy']]['name']}"
            elif b["group"]:
                text = f"组 {self.groups[b['group']]['name']}"
            else:
                text = f"用户 {self.users[b['user']]['username']}"
            if not b["enabled"]:
                text += "（停用）"
            if b["negate"]:
                text += "（取反）"
            out.append(text)
        return sorted(out)

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def snapshot(self):
        return copy.deepcopy((self.users, self.groups, self.bindings, self.policies))

    # 照 Authentik 判能不能进
    def can_enter(self, slug, username):
        u = self.user(username)
        who = SimpleNamespace(is_authenticated=True, username=u["username"], path=u["path"],
                              attributes=copy.deepcopy(u["attributes"]))
        live = [b for b in self.bindings_of(slug) if b["enabled"]]
        if not live:
            return True   # 租户标志 core_default_app_access 默认开：没绑定谁都能进
        for b in live:
            if b["policy"]:
                passing = run_expression(self.policies[b["policy"]]["expression"], who)
            elif b["group"]:
                passing = u["pk"] in self.groups[b["group"]]["users"]
            else:
                passing = b["user"] == u["pk"]
            if passing != b["negate"]:
                return True
        return False

    def access_table(self, usernames):
        return {slug: {name: self.can_enter(slug, name) for name in usernames} for slug in sorted(self.apps)}

    # 接口
    def _user_json(self, u):
        return {**u, "groups": [pk for pk, g in self.groups.items() if u["pk"] in g["users"]]}

    def _group_json(self, g):
        return {**g, "users": sorted(g["users"])}

    def _binding_json(self, b):
        p = self.policies.get(b["policy"]) if b["policy"] else None
        g = self.groups.get(b["group"]) if b["group"] else None
        u = self.users.get(b["user"]) if b["user"] is not None else None
        return {
            **b,
            "policy_obj": dict(p) if p else None,   # Authentik 会解析成子类，带着 expression
            "group_obj": {"pk": g["pk"], "name": g["name"], "is_superuser": g["is_superuser"],
                          "attributes": g["attributes"]} if g else None,
            "user_obj": {"pk": u["pk"], "username": u["username"], "name": u["name"]} if u else None,
        }

    def _page(self, rows, request):
        page = int(request.url.params.get("page", 1))
        start = (page - 1) * self.PAGE
        nxt = page + 1 if start + self.PAGE < len(rows) else 0
        return httpx.Response(200, json={"pagination": {"next": nxt, "count": len(rows), "current": page},
                                         "results": rows[start:start + self.PAGE]})

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        method, path = request.method, request.url.path
        self.calls.append((method, path))
        body = json.loads(request.content) if request.content else {}
        parts = path.removeprefix("/api/v3/").strip("/").split("/")
        if PERMS.get((method, parts[1] if len(parts) > 1 else "")) in self.deny:
            return httpx.Response(403, json=_DENIED)
        if parts[0] == "core" and parts[1] in ("users", "groups"):
            return self._core(method, parts[1:], body, request)
        if parts[:2] == ["core", "applications"]:
            if len(parts) == 2:
                return httpx.Response(400, json={"detail": "fake：列表接口只列调用的人自己能进的应用，同步不该用它"})
            app = self.apps.get(parts[2])
            if method == "GET" and app is not None:
                return httpx.Response(200, json=app)
            return httpx.Response(404, json={"detail": "No Application matches the given query."})
        if parts[:2] == ["policies", "expression"] and method == "GET" and len(parts) == 2:
            name = request.url.params.get("name")
            rows = [p for p in self.policies.values() if name is None or p["name"] == name]
            return self._page(rows, request)
        if parts[:2] == ["policies", "bindings"]:
            return self._bindings(method, parts[2:], body, request)
        return httpx.Response(404, json={"detail": f"fake 没实现 {method} {path}"})

    def _core(self, method, parts, body, request):
        if parts[0] == "users":
            if method == "GET":
                return self._page([self._user_json(u) for u in self.users.values()], request)
            if method == "POST":
                return self._write_user(None, body, "POST")
            if method == "PATCH":
                return self._write_user(int(parts[1]), body, "PATCH")
        if parts[0] == "groups":
            if method == "GET":
                return self._page([self._group_json(g) for g in self.groups.values()], request)
            if method == "POST" and len(parts) == 1:
                if (status := self.fail.get(("POST", body.get("name")))):
                    return httpx.Response(status, json={"detail": "boom"})
                if self.group(body["name"]):
                    return httpx.Response(400, json={"name": ["group with this name already exists."]})
                pk = self.add_group(body["name"], attributes=body.get("attributes"),
                                    is_superuser=body.get("is_superuser", False))
                return httpx.Response(201, json=self._group_json(self.groups[pk]))
            group = self.groups.get(parts[1])
            if group is None:
                return httpx.Response(404, json={"detail": "Not found."})
            if method == "PATCH":
                if "name" in body and self.group(body["name"]) not in (None, group):
                    return httpx.Response(400, json={"name": ["group with this name already exists."]})
                group.update(body)
                return httpx.Response(200, json=self._group_json(group))
            if method == "POST" and parts[2] in ("add_user", "remove_user"):
                if body["pk"] not in self.users:
                    return httpx.Response(404, json={"detail": "Not found."})
                (group["users"].add if parts[2] == "add_user" else group["users"].discard)(body["pk"])
                return httpx.Response(204)
        return httpx.Response(404, json={"detail": f"fake 没实现 {method} {parts}"})

    def _write_user(self, pk, body, method):
        target = self.users.get(pk) if pk else None
        name = body.get("username") or (target or {}).get("username")
        if (status := self.fail.get((method, name))):
            return httpx.Response(status, json={"detail": "boom"})
        if pk and target is None:
            return httpx.Response(404, json={"detail": "Not found."})
        if target and target["type"] == "internal_service_account":
            return httpx.Response(400, json={"non_field_errors": ["Can't modify internal service account users"]})
        if "username" in body and self.user(body["username"]) not in (None, target):
            return httpx.Response(400, json={"username": ["This field must be unique."]})
        if target is None:
            pk = self.add_user(body["username"])
            target = self.users[pk]
        target.update({k: v for k, v in body.items() if k != "groups"})
        return httpx.Response(201 if method == "POST" else 200, json=self._user_json(target))

    def _bindings(self, method, parts, body, request):
        if method == "GET" and not parts:
            targets = set(request.url.params.get_list("target_in"))
            rows = [self._binding_json(b) for b in sorted(self.bindings.values(), key=lambda b: (b["order"], b["pk"]))
                    if not targets or b["target"] in targets]
            return self._page(rows, request)
        if method == "POST" and not parts:
            app = next((a for a in self.apps.values() if a["pk"] == body.get("target")), None)
            if app is None:
                return httpx.Response(400, json={"target": ["Invalid pk - object does not exist."]})
            if (status := self.fail.get(("POST", app["slug"]))):
                return httpx.Response(status, json={"detail": "boom"})
            picked = [k for k in ("policy", "group", "user") if body.get(k)]
            if len(picked) != 1:
                return httpx.Response(400, json={"non_field_errors": ["Only one of 'group', 'policy', 'user' can be set."]})
            if (body.get("policy") and body["policy"] not in self.policies) or (
                    body.get("group") and body["group"] not in self.groups):
                return httpx.Response(400, json={picked[0]: ["Invalid pk - object does not exist."]})
            if not isinstance(body.get("order"), int):
                return httpx.Response(400, json={"order": ["This field is required."]})
            if any(b["target"] == app["pk"] and b["order"] == body["order"] for b in self.bindings.values()):
                return httpx.Response(400, json={"non_field_errors": ["fake：同一个应用上 order 撞了"]})
            pk = str(uuid.uuid4())
            self.bindings[pk] = {
                "pk": pk, "target": app["pk"], "order": body["order"], "enabled": body.get("enabled", True),
                "negate": body.get("negate", False), "timeout": body.get("timeout", 30),
                "failure_result": body.get("failure_result", False), "expiring": False, "expires": None,
                "policy": body.get("policy"), "group": body.get("group"), "user": body.get("user"),
            }
            return httpx.Response(201, json=self._binding_json(self.bindings[pk]))
        if method == "DELETE" and len(parts) == 1:
            if self.bindings.pop(parts[0], None) is None:
                return httpx.Response(404, json={"detail": "No PolicyBinding matches the given query."})
            return httpx.Response(204)
        return httpx.Response(404, json={"detail": f"fake 没实现 {method} bindings/{parts}"})


def run_expression(expression: str, user) -> bool:
    """照 Authentik 的 BaseEvaluator.wrap_expression 跑一段表达式策略（只给 request，够这两条用）。"""
    code = "def handler(request):\n" + textwrap.indent(expression, "    ") + "\nresult = handler(request)"
    scope = {"request": SimpleNamespace(user=user)}
    exec(compile(code, "expression", "exec"), {}, scope)   # noqa: S102 —— 跑的是本仓库自己写的策略
    return bool(scope["result"])
