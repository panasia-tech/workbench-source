"""回归(I1):run_read_chats 用手动 try/except(不走 Engine.run(STEPS),因要动态遍历会话列表),
之前只捕获 StepError,RiskHit 会逃逸成 runner 里的"未预期异常"、result["risk"] 丢失,
账号命中风控(验证码等)后不会被熔断冻结、继续被反复扫描。

Bug: app/flow/read_chats.py 只有 `except StepError`,没有 `except RiskHit`。
修复:补一个 `except RiskHit as ex:` 分支,把 ex.anchor 写进 result["risk"]。
"""

import app.flow.publish_flow as publish_flow
import app.flow.read_chats as read_chats
from app.flow.engine import RiskHit


class _FakeTransport:
    def screen_size(self):
        return (1080, 2400)


def test_run_read_chats_risk_hit_populates_risk(monkeypatch):
    def _boom(e):
        raise RiskHit("验证码", shot="shots/risk_验证码.png")

    monkeypatch.setattr(read_chats, "_open_messages", _boom)
    # reset_to_clean 用真实 Engine 方法走屏幕交互,fake transport 没实现那些原语;
    # 无条件收尾逻辑本身不是本测试要验证的行为,降级为 no-op 即可。
    monkeypatch.setattr(publish_flow, "reset_to_clean", lambda e: None)

    result = read_chats.run_read_chats(_FakeTransport(), {})

    assert result["ok"] is False
    assert result["risk"] == "验证码"
    assert result["reason"]
    assert result["conversations"] == []
    assert result["messages"] == {}
