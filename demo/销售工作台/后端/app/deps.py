from fastapi import Depends, Header, HTTPException
from itsdangerous import BadData, URLSafeTimedSerializer
from secrets import token_hex
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Staff

_login = URLSafeTimedSerializer(token_hex(32))


def make_token(staff_id):
    return _login.dumps(staff_id)


def get_current_user(db: Session = Depends(get_db), authorization: str = Header(default="")):
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() == "bearer":
        try:
            staff = db.get(Staff, _login.loads(token, max_age=86400))
        except BadData:
            staff = None
        if staff is not None:
            return staff
    raise HTTPException(401, "请重新进入本地演示")
