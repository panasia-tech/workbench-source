"""H5 的「记住密码」：设备上存的不是密码，是一张只能拿来换登录令牌的凭证。

# 为什么不存密码

H5 和管理后台同一个域名（panasia.fun/h5/ 与 /console/），浏览器存储按域名共享——
后台哪天出个 XSS，存在本地的密码就能被读走，而员工的密码往往别处也在用。
凭证被偷了能做的事有限：换不出原密码，改个密码就作废。

# 凭证长什么样

JWT {sub, pwh, typ, exp}，签名密钥由 jwt_secret 派生、和登录令牌不是同一把：
  - 拿它当登录令牌（Bearer）用验不过签名；拿登录令牌冒充它也验不过
  - pwh 是当前密码哈希的指纹：员工一改密码，所有设备上记住的凭证一起作废
  - 账号停用 / 删除 / 角色不在 H5 的门里，都换不出令牌
  - 30 天有效；每次登录后端上换一张新的，常用的人不会过期
"""

import hashlib
import hmac
from datetime import datetime, timedelta

from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.config import settings
from app.enums import StaffStatus
from app.models import Staff

REMEMBER_DAYS = 30
_TYP = "h5-remember"


def _key() -> str:
    return hmac.new(settings.jwt_secret.encode(), b"h5-remember-v1", hashlib.sha256).hexdigest()


def _pwh(staff: Staff) -> str:
    return hashlib.sha256((staff.password_hash or "").encode()).hexdigest()[:16]


def issue(staff: Staff) -> str:
    exp = datetime.utcnow() + timedelta(days=REMEMBER_DAYS)
    return jwt.encode({"sub": staff.id, "pwh": _pwh(staff), "typ": _TYP, "exp": exp}, _key(), algorithm="HS256")


def verify(db: Session, token: str) -> Staff | None:
    """凭证有效就返回员工，否则 None（不区分是哪种无效：过期、改过密码、伪造的都一样回）。"""
    try:
        payload = jwt.decode(token or "", _key(), algorithms=["HS256"])
    except JWTError:
        return None
    if payload.get("typ") != _TYP:
        return None
    staff = db.get(Staff, payload.get("sub"))
    if not staff or staff.deleted_at or staff.status != StaffStatus.ACTIVE:
        return None
    if not hmac.compare_digest(str(payload.get("pwh") or ""), _pwh(staff)):
        return None
    return staff
