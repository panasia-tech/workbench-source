"""禅道按 ERP 账号认人：禅道服务器（阿里云北京，zentao.panasia.fun）问 ERP「这是谁」。

11-09 用户定：禅道的账号以 ERP 为准。禅道有两个入口，都落到同一个 ERP 员工上：
  - 浏览器「用 ERP 账号登录」：走统一登录（Authentik 应用 zentao），回来带 erp_sub，禅道拿它来这里查；
  - 钉钉工作台免登：禅道拿到钉钉 userid，来这里查这个 userid 关联的是哪个员工（staff.dingtalk_userid）。
禅道每次登录都来问一次：停用、删除、改成设备账号的员工马上进不去；管理员按 ERP 角色定，改了下次登录就变。
只回认人要用的几项，不回手机号、密码这些。
"""
from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.enums import StaffRole
from app.models import Staff
from app.services.platform_groups import is_active_human

router = APIRouter(prefix="/api/zentao", tags=["禅道"])


def require_zentao_token(authorization: str = Header(default="")) -> None:
    token = settings.zentao_link_token
    if not token:
        raise HTTPException(status_code=404, detail="Not Found")
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(value.strip().encode(), token.encode()):
        raise HTTPException(status_code=401, detail="token 不对")


@router.get("/staff", summary="禅道查员工（按员工 ID 或钉钉 userid）", dependencies=[Depends(require_zentao_token)])
def lookup_staff(
    sub: str | None = Query(default=None, max_length=64),
    dingtalk_userid: str | None = Query(default=None, max_length=64),
    db: Session = Depends(get_db),
):
    if bool(sub) == bool(dingtalk_userid):
        raise HTTPException(status_code=400, detail="sub 和 dingtalk_userid 只传一个")
    if sub:
        staff = db.get(Staff, sub)
    else:
        staff = db.query(Staff).filter(Staff.dingtalk_userid == dingtalk_userid, Staff.deleted_at.is_(None)).first()
    if staff is None:
        return {"found": False}
    return {
        "found": True,
        "sub": staff.id,
        "username": staff.username,
        "name": staff.name,
        "staff_no": staff.staff_no,
        "role": staff.role,
        "active": is_active_human(staff),
        "admin": staff.role == StaffRole.ADMIN,
    }
