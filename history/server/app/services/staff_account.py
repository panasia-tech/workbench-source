"""员工账号的软删除。后台「删除员工」和钉钉离职同步共用一套做法。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.enums import StaffStatus
from app.models import Staff


def soft_delete(db: Session, staff: Staff) -> None:
    """软删除：行保留，历史单据的制单人/操作人/验货人照常可查。不 commit，调用方提交。

    同时置 status=DISABLED（切断所有登录与按 ACTIVE 取人的查询）、清 openid（放开微信重新绑定）、
    改写 username 腾出用户名（工号 staff_no 不动，避免与历史单据上的工号重号）。
    """
    from app.services import github_invite, oa_push

    if staff.github_account:
        # 离职：移出代码仓库（仓库里有密钥）；账号留着看历史
        staff.github_status = (github_invite.revoke(staff.github_account) or staff.github_status or "")[:255] or None
    staff.deleted_at = datetime.utcnow()
    staff.status = StaffStatus.DISABLED
    staff.openid = None
    # OA/台账推送：先推(此时 username 仍是原值，OA 只收到"离职→DISABLED")，再改写用户名
    oa_push.on_staff_synced(db, staff)
    staff.username = f"{staff.username[:50]}__del_{staff.id[:8]}"
