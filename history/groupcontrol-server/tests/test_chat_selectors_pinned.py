"""消息页选择器：两个项目各有一份，不许飘。

# 为什么会有两份

闲鱼 /im 这一个页面，有两处代码在读它：

  groupcontrol-server/app/flow/web/parse.py   服务端的 chat_scan 流程解析会话与消息
  adspower-executor/gc_ads/selectors.py       执行端的消息门铃（常驻 /im 盯未读角标）

门铃整个跑在执行端本机，不经服务端，所以它必须自己认得页面结构。而执行端是独立
打包、装到操作员电脑上离线跑的，读不到服务端仓库里的文件——所以没法像风控判据
那样做成「一份 JSON 两边读」。

# 那就钉住

两份都在同一个 git 仓库里。这条测试逐个比对它们描述同一个元素时用的 class 前缀，
对不上就红。飘移因此没法被合进主干——这和 test_workbench_login.py 直接去读端上
menu.js 是同一个手法。

# 漏改一边会怎样

不会报错。服务端那份漏改 → chat_scan 解析不出消息，会话看着是空的；
执行端那份漏改 → 门铃数不到未读，消息不再实时，而周期扫描还在跑，
所以**表面上一切正常**，只是慢了五分钟。两种都要等人发现，而不是等报错。
"""

import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_PARSE = _ROOT / "groupcontrol-server/app/flow/web/parse.py"
_EXECUTOR = _ROOT / "adspower-executor/gc_ads/selectors.py"

#: 同一个元素在两边分别叫什么。左边是服务端的常量名，右边是执行端的。
SHARED = {
    "CLS_CONV_ITEM": "CONV_ITEM",
    "CLS_LOGIN_NICK": "NICK_ANCHOR",
    "CLS_TOPBAR": "CHAT_TOPBAR",
    "CLS_MSG_ROW": "MESSAGE_ROW",
    "CLS_MSG_LIST": "MESSAGE_LIST",
}


def _consts(path: Path) -> dict[str, str]:
    """把 `NAME = "值"` 这类顶层常量抠出来。两边写法不同（一个是裸前缀、
    一个是完整属性选择器），所以只取字符串值，比对时再归一化。"""
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        # 闭合引号必须和开引号同类：执行端写的是 '[class*="conversation-item--"]'，
        # 单引号里包着双引号，不配对就会在第一个内层引号处截断。
        m = re.match(r'^([A-Z][A-Z0-9_]*)\s*=\s*(["\'])(.*?)\2', line)
        if m:
            out[m.group(1)] = m.group(3)
    return out


def _class_prefix(value: str) -> str:
    """从两种写法里取出 class 前缀：

    服务端写裸前缀        `"conversation-item--"`
    执行端写属性选择器     `'[class*="conversation-item--"]'`
    执行端偶尔带备选       `'li.ant-list-item, [class*="message-row--"]'`
    """
    m = re.search(r'class\*="([^"]+)"', value)
    return m.group(1) if m else value


@pytest.fixture(scope="module")
def sides():
    assert _PARSE.exists(), f"找不到 {_PARSE}"
    assert _EXECUTOR.exists(), f"找不到 {_EXECUTOR}"
    return _consts(_PARSE), _consts(_EXECUTOR)


@pytest.mark.parametrize("server_name,executor_name", list(SHARED.items()))
def test_同一个元素两边用同一个_class(sides, server_name, executor_name):
    server, executor = sides
    assert server_name in server, f"服务端少了常量 {server_name}（改名了就同步改这张表）"
    assert executor_name in executor, f"执行端少了常量 {executor_name}"
    a = _class_prefix(server[server_name])
    b = _class_prefix(executor[executor_name])
    assert a == b, (
        f"同一个元素两边对不上：服务端 {server_name}={a!r}，执行端 {executor_name}={b!r}。"
        "闲鱼改版时漏改一边不会报错——服务端漏改是会话解析不出来，执行端漏改是"
        "门铃数不到未读、消息不再实时而周期扫描照跑，表面一切正常。"
    )


def test_一律用属性包含不写死完整_class(sides):
    """闲鱼是 css-modules 打包，class 带 `--` 哈希后缀，每次发版都变。"""
    _, executor = sides
    for name, value in executor.items():
        if "class" not in value:
            continue
        assert 'class*=' in value, f"{name} 没用属性包含选择器，闲鱼一发版就失效"


def test_这张表本身别忘了维护(sides):
    """两边都有、但没进 SHARED 的消息页常量，提醒一下。

    不判失败——有些常量确实只有一边用得上（比如服务端要分气泡左右、执行端要读
    未读角标）。但如果哪天两边都加了同一个新元素，这条会提醒有人把它钉进来。
    """
    server, executor = sides
    server_prefixes = {_class_prefix(v) for v in server.values() if "--" in v}
    executor_prefixes = {_class_prefix(v) for v in executor.values() if "--" in v}
    pinned = {_class_prefix(server[k]) for k in SHARED if k in server}
    both_unpinned = (server_prefixes & executor_prefixes) - pinned
    assert not both_unpinned, (
        f"这些 class 两边都在用，但没钉进 SHARED：{sorted(both_unpinned)}。"
        "加进上面那张表，否则它们会各飘各的。"
    )
