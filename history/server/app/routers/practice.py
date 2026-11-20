"""销售上手练习（练习门禁）。规矩见 services/practice.py。"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import StaffRole
from app.models import Staff
from app.services import practice as P
from app.services.app_settings import set_setting

router = APIRouter(prefix="/api/practice", tags=["上手练习"])


class SettingIn(BaseModel):
    required: bool


@router.get("", summary="我的上手练习：演练商品、三步、做到哪了、会不会被拦")
def my_practice(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    return P.status(db, user)


@router.post("/steps/{step}", summary="交一步的答案（服务端判对错，对了记下）")
def submit_step(step: int, body: dict, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    return P.submit_step(db, user, step, body)


@router.get("/progress", summary="管理员：开关和每个销售做到哪了")
def progress(db: Session = Depends(get_db), _: Staff = Depends(require_roles(StaffRole.ADMIN))):
    return {"required": P.required(db), "staff": P.progress(db)}


@router.put("/setting", summary="管理员：打开 / 关掉练习门禁")
def write_setting(body: SettingIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    set_setting(db, P.REQUIRED_KEY, "1" if body.required else "", user.id)
    db.commit()
    return {"required": P.required(db), "staff": P.progress(db)}
