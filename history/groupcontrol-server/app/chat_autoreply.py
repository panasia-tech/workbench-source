"""50 秒未回复自动兜底(M1)。

闲鱼把商家消息回复率算进核心考核,未及时回复直接影响销售绩效与账号权重。
所以买家发来消息后若 N 秒内没人回,系统自动补一条,先把回复率保住。

# 判定

一个会话「欠回复」要同时满足:
  1. 最后一条消息方向是 in(买家说的);
  2. 它已经超过阈值还没被回;
  3. 这个会话没有在途的 chat_reply 任务;
  4. 买家这句之后没有停在 reply_verify 的回复单。

第 3 条是关键:调度器每轮都会跑一遍,没有这个闸,同一个会话会被反复排队,
买家那边会收到一串重复的兜底话术。回复发送成功后 out 消息落库(同一句话第二次发
也落,一单一条,见 jobs._on_chat_reply_ok),第 1 条自然不再成立,所以两道闸接得上,
中间没有空窗。

第 4 条:reply_verify 是「点了发送,回读没核对上」,那句多半已经到了买家那边(2026-10-15
生产 3 单都是这样),但没有落库,第 1 条照样成立。不拦的话每一轮都再补发一遍——
交人工核对,不自动补。其它失败(没找到会话、没登录…)没发出去,照旧重新欠回复。

# 与反风控节流的关系

兜底建的是普通 chat_reply 任务,照样过派发器的 op_min_interval_sec(同账号两次
操作最小间隔)。也就是说**阈值到点不等于立刻发出**——账号刚做过别的操作时会再
等一会儿。这是有意的:抢那几十秒的回复率,不值得换一个账号风控。

# 文案从哪来

generate_text 是可替换的生成器。默认给一条稳妥的过渡话术(明确告知稍后人工跟进),
**不编造任何商品、价格、库存信息**——兜底的目的是接住回复率,不是替销售做承诺。
接入大模型时替换这个函数即可(会上定的是 DeepSeek / Luna 级轻量模型配定制提示词,
模型与提示词尚未选型,见 M5 自动报价)。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import ChatMessage, Conversation, Task, TaskStatus

logger = logging.getLogger(__name__)

# 在途任务:还没跑完的都算,避免重复排队
_OPEN_TASK_STATES = (TaskStatus.PENDING, TaskStatus.DISPATCHED, TaskStatus.RUNNING)

DEFAULT_TEXT = "您好，消息已收到，正在为您确认，稍后马上回复您～"


def _msg_time(msg: ChatMessage) -> datetime:
    """气泡自带时间优先;闲鱼只给到分钟且可能缺失,缺了就用落库时间兜底。"""
    return msg.msg_at or msg.created_at


def last_message(db: Session, conversation_id: str) -> ChatMessage | None:
    return (
        db.query(ChatMessage)
        .filter(ChatMessage.conversation_id == conversation_id)
        .order_by(ChatMessage.created_at.desc())
        .first()
    )


def has_open_reply_task(db: Session, conversation_id: str) -> bool:
    """该会话是否已有在途的 chat_reply(人工或自动都算)。"""
    return (
        db.query(func.count(Task.id))
        .filter(
            Task.task_type == "chat_reply",
            Task.ref_type == "conversation",
            Task.ref_id == conversation_id,
            Task.status.in_(_OPEN_TASK_STATES),
        )
        .scalar()
        or 0
    ) > 0


def has_unverified_reply_since(db: Session, conversation_id: str, since: datetime) -> bool:
    """since 之后有没有回复单停在 reply_verify(可能已发出、没核对上,见模块说明第 4 条)。"""
    return (
        db.query(func.count(Task.id))
        .filter(
            Task.task_type == "chat_reply",
            Task.ref_type == "conversation",
            Task.ref_id == conversation_id,
            Task.status == TaskStatus.FAILED,
            Task.failed_step == "reply_verify",
            Task.created_at >= since,
        )
        .scalar()
        or 0
    ) > 0


def is_overdue(db: Session, conv: Conversation, now: datetime, threshold_sec: int) -> bool:
    """该会话是否欠一条兜底回复。"""
    msg = last_message(db, conv.id)
    if msg is None or msg.direction != "in":
        return False
    if (now - _msg_time(msg)).total_seconds() < threshold_sec:
        return False
    if has_open_reply_task(db, conv.id):
        return False
    return not has_unverified_reply_since(db, conv.id, _msg_time(msg))


def overdue_conversations(
    db: Session, now: datetime | None = None, threshold_sec: int = 50, limit: int = 200
) -> list[Conversation]:
    """所有欠回复的会话。

    先用 last_message_at 粗筛(带索引的会话表),再逐条精判——直接扫消息表在
    账号多起来之后会很贵,而绝大多数会话根本不在窗口里。
    """
    now = now or datetime.utcnow()
    cutoff = now - timedelta(seconds=threshold_sec)
    candidates = (
        db.query(Conversation)
        .filter(Conversation.last_message_at.isnot(None), Conversation.last_message_at <= cutoff)
        .order_by(Conversation.last_message_at.asc())
        .limit(limit)
        .all()
    )
    return [c for c in candidates if is_overdue(db, c, now, threshold_sec)]


def generate_text(db: Session, conv: Conversation) -> str:
    """兜底话术。

    可替换点:接大模型时在这里按会话上下文生成。默认实现刻意保守——
    只表示「收到、稍后回复」,不提商品、不报价、不承诺库存。兜底是为了接住
    回复率考核,一条乱编的自动回复造成的损失远大于那点考核分。
    """
    return DEFAULT_TEXT


def run_autoreply_pass(
    db: Session, now: datetime | None = None, threshold_sec: int = 50, limit: int = 200
) -> list[str]:
    """跑一轮兜底,返回本轮建单的会话 id。"""
    from app import jobs  # 延迟导入避免环

    now = now or datetime.utcnow()
    created: list[str] = []
    for conv in overdue_conversations(db, now, threshold_sec, limit):
        text = (generate_text(db, conv) or "").strip()
        if not text:
            continue
        try:
            jobs.create_chat_reply(db, conv.id, text, source="AUTO")
        except ValueError as exc:
            # 会话在本轮中途被删之类:跳过,不要让一条坏数据停掉整轮兜底
            logger.warning("兜底回复建单失败 conv=%s: %s", conv.id, exc)
            continue
        created.append(conv.id)
        logger.info("兜底回复 conv=%s account=%s", conv.id, conv.account_id)
    return created
