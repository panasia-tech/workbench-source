"""网页版登录态判定。

# 这个测试是怎么来的

M2 推送机制调研时，脚本报告「已登录」，但网络里却有每秒一次的
passport.goofish.com/newlogin/qrcode/query.do —— 那是扫码登录的轮询。
去页面上看，未登录的 /im **也会**渲染页头元素：

    class = "nick--RyNYtDXM"   text = "登录"   top = 26

于是原来的判定（class 含 nick-- + 文本非空 + 在视口顶部 15%）三条全中，
把未登录页判成了已登录。

后果按流程分两种，都很难查：
  - read_chats_web：不抛 LoginRequired，继续扫，返回 0 个会话——**静默假成功**，
    看板上只是「今天没人来问」；
  - reply_chat_web / goods_flows_web：继续往下点，在某个找不到的元素上报错，
    错误信息指向控件而不是「没登录」。

所以判定必须排掉登录入口自身的文案。下面的 fixture 就是实测到的那个节点。
"""
import pytest

from app.flow.web.parse import find_login_nick, is_logged_in_nick


def node(cls: str, desc: str, cy: int = 26) -> dict:
    return {"cls": cls, "desc": desc, "cy": cy, "cx": 100, "w": 40, "h": 20}


VIEWPORT_H = 900


def test_logged_out_page_is_not_mistaken_for_logged_in():
    """实测节点：未登录 /im 的页头 nick-- 元素文本是「登录」。"""
    nodes = [node("nick--RyNYtDXM", "登录", cy=26)]
    assert find_login_nick(nodes, VIEWPORT_H) is None


def test_real_nickname_is_accepted():
    nodes = [node("nick--RyNYtDXM", "东魏诚恳的椰子蟹", cy=26)]
    assert find_login_nick(nodes, VIEWPORT_H) == "东魏诚恳的椰子蟹"


@pytest.mark.parametrize("text", ["登录", "登录/注册", "注册/登录", "请登录",
                                  "立即登录", "登录注册", "Sign in", "LOGIN", " 登录 "])
def test_login_entry_labels_rejected(text):
    """登录入口可能换文案/大小写，全部按未登录处理。"""
    assert is_logged_in_nick(text) is False


@pytest.mark.parametrize("text", ["东魏诚恳的椰子蟹", "演示员工辛", "abc123", "登录小能手"])
def test_real_nicknames_accepted(text):
    """别把判定写成「包含登录二字就算未登录」——昵称里带「登录」是合法的。"""
    assert is_logged_in_nick(text) is True


def test_empty_or_missing_is_not_logged_in():
    assert is_logged_in_nick("") is False
    assert is_logged_in_nick("   ") is False
    assert is_logged_in_nick(None) is False


def test_nick_outside_header_is_ignored():
    """页面别处出现的 nick-- 元素不算登录态（比如会话列表里的对方昵称）。"""
    nodes = [node("nick--RyNYtDXM", "某个买家", cy=int(VIEWPORT_H * 0.6))]
    assert find_login_nick(nodes, VIEWPORT_H) is None


def test_picks_header_nick_among_many():
    nodes = [
        node("conversation-item--x", "买家甲", cy=300),
        node("nick--RyNYtDXM", "某个买家", cy=500),
        node("nick--RyNYtDXM", "我的店铺号", cy=26),
    ]
    assert find_login_nick(nodes, VIEWPORT_H) == "我的店铺号"


def test_all_web_flows_use_the_shared_check():
    """几条流程曾各自复制一份判定，改一处漏两处(发布流程就漏了,未登录时页头的「登录」被当成昵称)。
    收口后不允许再有本地实现;判掉登录前都要先试快速进入(web/login.recover_login)。"""
    import inspect

    from app.flow.web import goods_flows_web, publish_flow_web, read_chats_web, reply_chat_web

    for mod in (read_chats_web, reply_chat_web, goods_flows_web, publish_flow_web):
        src = inspect.getsource(mod._ensure_login)
        assert "find_login_nick" in src, f"{mod.__name__} 没走共用判定"
        assert "CLS_LOGIN_NICK in" not in src, f"{mod.__name__} 还留着本地实现"
        assert "recover_login" in src, f"{mod.__name__} 判掉登录前没先试快速进入"
