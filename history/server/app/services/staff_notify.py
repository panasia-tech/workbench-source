"""给员工发通知：钉钉优先，企微兜底，都没绑照实说。验货异常、消息超时等都走这里。

钉钉 ID 用员工关联的 dingtalk_userid：钉钉入职建号时自动写，老员工在后台「钉钉关联」里按名字选。
钉钉工作通知只能发给应用「可使用范围」里的人；测试阶段范围仅管理员本人，其他人会发送失败，照实记。
钉钉同一人一天内相同内容只收一条，所以正文末尾带上时间，保证每条不同。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from app.models import Staff
from app.services import dingtalk, wecom

# 状态：SENT 已发出 / NO_ACCOUNT 钉钉企微都没绑 / FAILED 发送失败（会重试）
SENT = "SENT"
NO_ACCOUNT = "NO_ACCOUNT"
FAILED = "FAILED"


def dingtalk_id(staff: Staff | None) -> str:
    if staff is None:
        return ""
    return (staff.dingtalk_userid or "").strip()


def channel_of(staff: Staff | None) -> str | None:
    """这个人能收到哪一路：DINGTALK / WECOM / None。"""
    if dingtalk_id(staff) and dingtalk.configured():
        return "DINGTALK"
    # 企微没配时不在这里拦：照样调，wecom.send_text 会如实返回「ERP 没配企微应用」
    if staff is not None and (staff.wecom_userid or "").strip():
        return "WECOM"
    return None


def _stamp() -> str:
    return (datetime.utcnow() + timedelta(hours=8)).strftime("%m-%d %H:%M")


def send(
    staff: Staff | None, title: str, body: str, *, url: str | None = None, button: str = "去处理",
    ding_sender=None, wecom_sender=None,
) -> tuple[str, str]:
    """发一条。返回 (状态, 说明)，说明写进页面，所以要是实话。"""
    channel = channel_of(staff)
    if channel is None:
        return NO_ACCOUNT, "没绑钉钉或企微，只有站内待办"
    text = f"{body}\n（{_stamp()}）"
    if channel == "DINGTALK":
        if url:
            sender = ding_sender or dingtalk.send_card
            ok, detail = sender([dingtalk_id(staff)], title, f"### {title}\n\n{text}", url, button)
        else:
            sender = ding_sender or (lambda ids, t, md, u, b: dingtalk.send_text(ids, f"【{t}】\n{text}"))
            ok, detail = sender([dingtalk_id(staff)], title, text, None, button)
        return (SENT, "钉钉已发出") if ok else (FAILED, f"钉钉：{detail}")
    sender = wecom_sender or wecom.send_text
    ok, detail = sender(staff.wecom_userid.strip(), f"【{title}】\n{text}" + (f"\n{url}" if url else ""))
    return (SENT, "企微已发出") if ok else (FAILED, detail)
