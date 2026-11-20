from datetime import datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.services import wk_verify

security = HTTPBearer(auto_error=False)

ALL_TABS = {
    "workbench": {"key": "workbench", "text": "工作台", "pagePath": "pages/workbench/index"},
    "profile": {"key": "profile", "text": "我的", "pagePath": "pages/profile/index"},
}

ROLE_TAB_KEYS: dict[str, list[str]] = {
    StaffRole.PURCHASER: ["workbench", "profile"],
    StaffRole.WAREHOUSE: ["workbench", "profile"],
    StaffRole.NEGOTIATOR: ["workbench", "profile"],
    StaffRole.SALES: ["workbench", "profile"],
    # 财务原本没有工作台；资产录入开给所有员工后多一个工作台 tab，排在后面，落地页仍是「我的」
    StaffRole.FINANCE: ["profile", "workbench"],
    StaffRole.ADMIN: ["workbench", "profile"],
}


def get_tabs_for_role(role: str) -> list[dict]:
    keys = ROLE_TAB_KEYS.get(role, ROLE_TAB_KEYS[StaffRole.PURCHASER])
    return [ALL_TABS[k] for k in keys]


def get_landing_page(role: str) -> str:
    tabs = get_tabs_for_role(role)
    return tabs[0]["pagePath"] if tabs else "pages/profile/index"


def create_access_token(staff_id: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    return jwt.encode({"sub": staff_id, "role": role, "exp": expire}, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
    db: Annotated[Session, Depends(get_db)],
    # 放最后并给默认 None：注解保持裸 Request，FastAPI 才按特殊类型注入（Optional 会被当成表单字段）；
    # 测试直接调本函数不传也行，只影响 wk_ 分支的只读判断
    request: Request = None,
) -> Staff:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录")
    token = credentials.credentials
    # 个人 API Key（wk_ 前缀，工作台签发）：全系统个人通行证，只读——非 GET 一律 403，
    # 身份去工作台 verify 换（userId 就是 ERP 员工 ID），换完和 JWT 走同一套在职校验。
    if token.startswith("wk_"):
        if request is not None and request.method != "GET":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="个人 API Key 只读，写操作请用账号登录")
        try:
            identity = wk_verify.verify(token)
        except wk_verify.WkUnavailable as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="身份验证服务暂时不可用") from exc
        except wk_verify.WkRejected as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API Key 无效") from exc
        staff_id = identity.user_id
    else:
        try:
            staff_id = decode_token(token).get("sub")
        except JWTError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效令牌") from exc
    staff = db.get(Staff, staff_id)
    if not staff or staff.deleted_at or staff.status != StaffStatus.ACTIVE:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="员工未激活或未绑定")
    return staff


def require_roles(*roles: str):
    def checker(user: Annotated[Staff, Depends(get_current_user)]) -> Staff:
        if user.role == StaffRole.ADMIN:
            return user
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="权限不足")
        return user

    return checker
