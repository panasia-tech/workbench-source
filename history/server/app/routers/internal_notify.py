"""本机内部接口：群控服务端（同机）按员工发通知。外部走 nginx 的请求一律拒绝。

群控的消息响应考核（groupcontrol-server/app/chat_sla.py）要给闲鱼号负责人推新消息、超时提醒，
给管理员发超时升级。员工和钉钉/企微都在 ERP，所以由 ERP 发（services/staff_notify：钉钉优先、企微兜底）。
「管理员」= 钉钉通知名单 DINGTALK_NOTIFY_USERIDS（入职离职通知也发这些人）；没配就发给在职管理员角色。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.services import dingtalk, staff_notify

router = APIRouter(prefix="/api/internal", tags=["内部"])

_LOOPBACK = {"127.0.0.1", "::1"}


def require_local(request: Request) -> None:
    """本机直连才放行：nginx 转发来的请求都带 X-Real-IP（nginx 会覆盖客户端伪造的同名头）。"""
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK or "x-real-ip" in request.headers or "x-forwarded-for" in request.headers:
        raise HTTPException(status_code=403, detail="只允许本机调用")


class NotifyIn(BaseModel):
    staff_ids: list[str] = Field(default_factory=list)
    admins: bool = False
    title: str = Field(max_length=100)
    body: str = Field(default="", max_length=2000)
    url: str | None = None
    button: str = "去处理"


@router.post("/staff-notify", summary="给员工/管理员发通知（仅本机）", dependencies=[Depends(require_local)])
def staff_notify_api(body: NotifyIn, db: Session = Depends(get_db)):
    results = []
    for sid in dict.fromkeys(body.staff_ids):
        staff = db.get(Staff, sid)
        if staff is None or staff.deleted_at or staff.status != StaffStatus.ACTIVE:
            results.append({"staff_id": sid, "status": "SKIPPED", "detail": "员工不存在或不在职"})
            continue
        status, detail = staff_notify.send(staff, body.title, body.body, url=body.url, button=body.button)
        results.append({"staff_id": sid, "name": staff.name, "status": status, "detail": detail})
    if body.admins:
        to = [u.strip() for u in (settings.dingtalk_notify_userids or "").split(",") if u.strip()]
        if to and dingtalk.configured():
            text = f"{body.body}\n（{staff_notify._stamp()}）"
            if body.url:
                ok, detail = dingtalk.send_card(to, body.title, f"### {body.title}\n\n{text}", body.url, body.button)
            else:
                ok, detail = dingtalk.send_text(to, f"【{body.title}】\n{text}")
            results.append({"admins": "钉钉通知名单", "status": "SENT" if ok else "FAILED", "detail": detail})
        else:
            for staff in db.query(Staff).filter(Staff.role == StaffRole.ADMIN, Staff.status == StaffStatus.ACTIVE,
                                                Staff.deleted_at.is_(None)):
                status, detail = staff_notify.send(staff, body.title, body.body, url=body.url, button=body.button)
                results.append({"staff_id": staff.id, "name": staff.name, "status": status, "detail": detail})
    return {"results": results}
