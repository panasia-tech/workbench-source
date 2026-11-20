"""常驻 /im 消息门铃回归（纯离线，不碰真浏览器）。

钉死五条语义：
  1. 心跳帧不触发（否则每 15 秒白看一次 DOM）；拿不准的帧一律当成有动静；
  2. 只认未读**上涨**——认下跌会让 chat_scan 清零这个动作自己再触发一次扫描，转成死循环；
  3. 首次快照只建基线不报：执行端重启不该把列表里的存量未读全部重扫一遍；
  4. 监听页登记进 reserved_pages 后，driver 挑业务页时必须跳过它
     （否则一次浏览器自愈就能把监听页挑走当业务页，接着被 goto 掉，
     症状只是「消息不再实时」，没人会立刻发现）；
  5. 本模块只读：源码里不许出现任何点击/输入/发送调用。

跑法：.venv/bin/python scripts/test_im_watch.py
"""
import asyncio
import inspect
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gc_ads import im_watch as iw  # noqa: E402
from gc_ads.config import Config  # noqa: E402
from gc_ads.driver import BrowserDriver  # noqa: E402

CONFIG = Path(__file__).resolve().parents[1] / "config.yaml"

# 2026-09-13 实测 k1gnuq4m：稳定期每 ~15s 一条,86B,没有 body
HEARTBEAT = '{"headers":{"mid":"7031789304122286 0","server-timestamp":"1789304127586"},"code":200}'
# 同一次实测：带 body 的业务帧（sid 已打码，内容无关，判据只看有没有 body）
BUSINESS = '{"headers":{"dt":"j","mid":"3661789304107349 0","sid":"x"},"code":200,"body":{"pipeline":"sync"}}'


class FakePage:
    """按次返回预设快照的假页面。"""

    def __init__(self, snapshots):
        self.snapshots = list(snapshots)
        self.calls = 0

    async def evaluate(self, _js, _arg=None):
        snap = self.snapshots[min(self.calls, len(self.snapshots) - 1)]
        self.calls += 1
        return snap

    def is_closed(self):
        return False


class FakeCtx:
    def __init__(self, pages):
        self.pages = list(pages)
        self.created = 0

    async def new_page(self):
        self.created += 1
        page = FakePage([[]])
        page.url = "about:blank"
        self.pages.append(page)
        return page


class FakeBrowser:
    def __init__(self, pages):
        self.contexts = [FakeCtx(pages)]

    def is_connected(self):
        return True


def test_heartbeat_filter():
    assert iw.is_heartbeat_frame(HEARTBEAT) is True
    assert iw.is_heartbeat_frame(BUSINESS) is False
    # 拿不准的一律当成有动静：多看一眼 DOM 的代价是一次 evaluate，
    # 漏看一条消息的代价是兜底不触发。
    assert iw.is_heartbeat_frame(b"\x00\x01") is False          # 二进制帧
    assert iw.is_heartbeat_frame("x" * 5000) is False           # 超大帧（初始 sync）
    assert iw.is_heartbeat_frame("not json") is False
    assert iw.is_heartbeat_frame('["a"]') is False              # JSON 但不是对象


def test_diff_only_counts_rises():
    prev = [{"nick": "买家甲", "unread": 0}, {"nick": "买家乙", "unread": 2}]

    # 首次快照只建基线
    assert iw.diff_unread(None, prev) == []
    # 没变化
    assert iw.diff_unread(prev, prev) == []
    # 0 → 1 触发
    up = iw.diff_unread(prev, [{"nick": "买家甲", "unread": 1}, {"nick": "买家乙", "unread": 2}])
    assert up == [{"nick": "买家甲", "from": 0, "to": 1}], up
    # 2 → 3 也触发（已有未读的会话又来一条）
    up = iw.diff_unread(prev, [{"nick": "买家甲", "unread": 0}, {"nick": "买家乙", "unread": 3}])
    assert up == [{"nick": "买家乙", "from": 2, "to": 3}], up
    # 下跌不触发：那是我们自己刚把它读掉了，认它就成死循环
    assert iw.diff_unread(prev, [{"nick": "买家甲", "unread": 0}, {"nick": "买家乙", "unread": 0}]) == []
    # 列表里新冒出来的会话带未读 = 新消息
    up = iw.diff_unread(prev, prev + [{"nick": "买家丙", "unread": 1}])
    assert up == [{"nick": "买家丙", "from": 0, "to": 1}], up
    # 忽略名单只压即时触发（官方通知天天有，周期 chat_scan 照常会扫到）
    assert iw.diff_unread(prev, [{"nick": "通知消息", "unread": 5}],
                          frozenset({"通知消息"})) == []


def test_tick_reports_once_then_throttles():
    hints = []
    watcher = iw.ImWatcher(driver=None, on_hint=hints.append, min_hint_interval_sec=0.0)
    page = FakePage([
        [{"nick": "买家甲", "unread": 0}],
        [{"nick": "买家甲", "unread": 1}],
        [{"nick": "买家甲", "unread": 2}],
    ])
    asyncio.run(watcher._tick(page))      # 建基线
    assert hints == []
    asyncio.run(watcher._tick(page))      # 0 → 1
    assert len(hints) == 1
    assert hints[0]["kind"] == "chat_hint"
    assert hints[0]["convs"] == [{"nick": "买家甲", "from": 0, "to": 1}]
    assert hints[0]["unread_total"] == 1
    # 提示里只带昵称与计数，不带消息正文
    assert "preview" not in str(hints[0])

    watcher.min_hint_interval_sec = 999.0
    asyncio.run(watcher._tick(page))      # 1 → 2，但在最小间隔内
    assert len(hints) == 1, "最小间隔内不该再报"
    # 基线仍然跟进：被压掉的那次不会让后续判断错位
    assert watcher._prev == [{"nick": "买家甲", "unread": 2}]


def test_throttled_rise_is_reported_after_gap():
    """间隔内压下的上涨不能丢：基线已经跟进，下一拍不会再涨——间隔到了要补报一次。"""
    hints = []
    watcher = iw.ImWatcher(driver=None, on_hint=hints.append, min_hint_interval_sec=999.0)
    page = FakePage([
        [{"nick": "买家甲", "unread": 0}],
        [{"nick": "买家甲", "unread": 1}],
        [{"nick": "买家甲", "unread": 1}],
        [{"nick": "买家甲", "unread": 1}],
    ])
    watcher._last_hint_at = __import__("time").monotonic()   # 刚报过
    asyncio.run(watcher._tick(page))      # 建基线
    asyncio.run(watcher._tick(page))      # 0 → 1，在间隔内：压着
    assert hints == [] and watcher._pending == [{"nick": "买家甲", "from": 0, "to": 1}]
    asyncio.run(watcher._tick(page))      # 没再涨、仍在间隔内：继续压着
    assert hints == []
    watcher.min_hint_interval_sec = 0.0   # 间隔到了
    asyncio.run(watcher._tick(page))      # 没再涨，也要把压着的补报
    assert len(hints) == 1 and hints[0]["convs"] == [{"nick": "买家甲", "from": 0, "to": 1}]
    assert watcher._pending is None


def test_empty_snapshot_never_becomes_baseline():
    """虚拟列表重渲染的瞬间会返回空快照。拿它当基线，下一拍列表回来就被整列当成
    未读上涨，平白扫一轮。空快照一律跳过，基线保持不动。"""
    hints = []
    watcher = iw.ImWatcher(driver=None, on_hint=hints.append, min_hint_interval_sec=0.0)
    page = FakePage([
        [{"nick": "买家甲", "unread": 3}],   # 基线：已有 3 条未读（存量，不报）
        [],                                   # 重渲染瞬间
        [{"nick": "买家甲", "unread": 3}],   # 列表回来，未读没变
    ])
    for _ in range(3):
        asyncio.run(watcher._tick(page))
    assert hints == [], hints
    assert watcher._prev == [{"nick": "买家甲", "unread": 3}]


def test_driver_skips_reserved_page():
    cfg = Config.load(CONFIG)
    driver = BrowserDriver(cfg)

    watch_page, biz_page = FakePage([[]]), FakePage([[]])
    watch_page.url = "https://www.goofish.com/im"
    biz_page.url = "https://www.goofish.com/personal"
    driver.browser = FakeBrowser([watch_page, biz_page])
    driver.reserve_page(watch_page)

    picked = asyncio.run(driver._attach_page())
    assert picked is biz_page, "业务页不能挑到常驻监听页"

    # 只剩监听页时必须新开一张，而不是退而求其次抢它
    driver.page = None
    driver.browser = FakeBrowser([watch_page])
    picked = asyncio.run(driver._attach_page())
    assert picked is not watch_page
    assert driver.browser.contexts[0].created == 1

    driver.release_page(watch_page)
    assert watch_page not in driver.reserved_pages


def test_module_is_read_only():
    """门铃只许读。买家会真的收到发出去的消息，撤不回来——这条用纪律不够，用测试钉。"""
    src = inspect.getsource(iw)
    forbidden = r"\.(click|fill|type|press|tap|dblclick|check|set_input_files|send_keys)\s*\("
    hits = [m.group(0) for m in re.finditer(forbidden, src)]
    assert not hits, f"im_watch 出现了写操作：{hits}"


def main():
    test_heartbeat_filter()
    test_diff_only_counts_rises()
    test_tick_reports_once_then_throttles()
    test_throttled_rise_is_reported_after_gap()
    test_empty_snapshot_never_becomes_baseline()
    test_driver_skips_reserved_page()
    test_module_is_read_only()
    print("test_im_watch: PASS")


if __name__ == "__main__":
    main()
