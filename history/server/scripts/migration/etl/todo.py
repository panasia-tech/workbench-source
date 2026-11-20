"""todo_task_templates / assignments / logs。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.todo import TodoTaskAssignment, TodoTaskLog, TodoTaskTemplate
from scripts.migration.common import (
    IdMapper,
    is_soft_deleted,
    iter_jsonl,
    parse_date,
    parse_dt,
    safe_dict,
    safe_list,
    safe_str,
)


def run_templates(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("todo_task_templates"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("todo_task_templates", cloud_id)
        t = TodoTaskTemplate(
            id=local_id,
            template_id=safe_str(doc.get("taskTemplateId"), 64) or cloud_id[:32],
            title=safe_str(doc.get("title"), 256) or "无标题",
            content=safe_str(doc.get("content")),
            remark=safe_str(doc.get("remark")),
            priority=safe_str(doc.get("priority"), 16) or "normal",
            effective_date=parse_date(doc.get("effectiveDate")),
            due_at=parse_dt(doc.get("dueAt")),
            status=safe_str(doc.get("status"), 16) or "active",
            remind_mode=safe_str(doc.get("remindMode"), 16),
            strong_remind=bool(doc.get("strongRemind", False)),
            assignee_user_ids=safe_list(doc.get("assigneeUserIds")),
            assignee_names=safe_list(doc.get("assigneeNames")),
            created_by_id=mapper.get("users", doc.get("createdBy")),
        )
        if c := parse_dt(doc.get("createdAt")):
            t.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            t.updated_at = u
        db.merge(t)
        n += 1
    return n


def run_assignments(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("todo_task_assignments"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("todo_task_assignments", cloud_id)
        a = TodoTaskAssignment(
            id=local_id,
            assignment_id=safe_str(doc.get("assignmentId"), 128) or cloud_id[:64],
            task_template_id=safe_str(doc.get("taskTemplateId"), 64),
            user_id=mapper.get("users", doc.get("userId")),
            user_name=safe_str(doc.get("userName"), 64),
            title_snapshot=safe_str(doc.get("titleSnapshot"), 256),
            content_snapshot=safe_str(doc.get("contentSnapshot")),
            remark_snapshot=safe_str(doc.get("remarkSnapshot")),
            priority=safe_str(doc.get("priority"), 16),
            effective_date=parse_date(doc.get("effectiveDate")),
            due_at=parse_dt(doc.get("dueAt")),
            status=safe_str(doc.get("status"), 16) or "pending",
            remind_visible=bool(doc.get("remindVisible", True)),
            completed_at=parse_dt(doc.get("completedAt")),
            completed_by_id=mapper.get("users", doc.get("completedBy")),
        )
        if c := parse_dt(doc.get("createdAt")):
            a.created_at = c
        if u := parse_dt(doc.get("updatedAt")):
            a.updated_at = u
        db.merge(a)
        n += 1
    return n


def run_logs(db: Session, mapper: IdMapper) -> int:
    n = 0
    for doc in iter_jsonl("todo_task_logs"):
        if is_soft_deleted(doc):
            continue
        cloud_id = doc["_id"]
        local_id = mapper.get_or_new("todo_task_logs", cloud_id)
        log = TodoTaskLog(
            id=local_id,
            template_id=safe_str(doc.get("taskTemplateId"), 64),
            assignment_id=safe_str(doc.get("assignmentId"), 128),
            action=safe_str(doc.get("action"), 32) or "EVENT",
            operator_id=mapper.get("users", doc.get("operatorId") or doc.get("createdBy")),
            payload=safe_dict(doc.get("payload")),
            created_at=parse_dt(doc.get("createdAt")),
        )
        db.merge(log)
        n += 1
    return n
