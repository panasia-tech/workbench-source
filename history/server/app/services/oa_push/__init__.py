"""OA/台账 MCP 数据推送（本 ERP 作 MCP 客户端，向外部 OA 推送员工/出库/提成/反馈/KPI）。

导入本包即注册 outbox 的 after_commit 投递监听器。触发点只需调用 events.on_* / enqueue_push，
业务 commit 后自动异步投递、失败重试；scripts 复用 events 做存量补推、run_due_batch 做定时兜底。
"""
from app.services.oa_push import client, events, mapping, outbox, worker  # noqa: F401
from app.services.oa_push.events import (  # noqa: F401
    enqueue_kpi_for_month,
    on_feedback_handled,
    on_inspection_done,
    on_outbound_created,
    on_staff_synced,
)
from app.services.oa_push.outbox import enqueue_push  # noqa: F401
from app.services.oa_push.worker import (  # noqa: F401
    enqueue,
    reclaim_stale,
    run_due_batch,
    shutdown_executor,
)

__all__ = [
    "client",
    "events",
    "mapping",
    "outbox",
    "worker",
    "enqueue_push",
    "on_staff_synced",
    "on_outbound_created",
    "on_inspection_done",
    "on_feedback_handled",
    "enqueue_kpi_for_month",
    "enqueue",
    "reclaim_stale",
    "run_due_batch",
    "shutdown_executor",
]
