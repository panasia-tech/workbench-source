from app.api import router
from app.auth import require_chat_access


def _dep_calls(route):
    calls, stack = set(), [route.dependant]
    while stack:
        d = stack.pop()
        if d.call is not None:
            calls.add(d.call)
        stack.extend(d.dependencies)
    return calls


def test_chat_routes_require_chat_access():
    """每条 /api/gc/chat/ 路由都必须过 require_chat_access。

    不再断言条数:硬编码的数字只会在加接口时报一个「6 != 4」,指不到是哪条漏了
    守卫——而漏守卫恰恰是这个测试要防的事。改成逐条点名,新增接口忘了加守卫会
    直接把路径打出来。只保留一个下限,防止路由前缀改名导致这里空跑却仍然通过。
    """
    chat_routes = [r for r in router.routes
                   if getattr(r, "path", "").startswith("/api/gc/chat/")]
    assert len(chat_routes) >= 4, "chat 路由前缀可能改了,这个测试正在空跑"

    ungated = [r.path for r in chat_routes if require_chat_access not in _dep_calls(r)]
    assert not ungated, f"以下 chat 路由没有鉴权守卫: {ungated}"
