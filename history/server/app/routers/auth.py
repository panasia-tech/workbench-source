from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import create_access_token, get_current_user, get_landing_page, get_tabs_for_role
from app.enums import HUMAN_ROLES, StaffRole, StaffStatus
from app.models import MiaodaBinding, Staff
from app.schemas.auth import (
    AdminLoginRequest,
    AuthResponse,
    BindRequest,
    ChangePasswordRequest,
    DeviceLoginRequest,
    DingtalkConfigOut,
    DingtalkLoginRequest,
    GithubAccountIn,
    MiaodaConfirmRequest,
    MiaodaEntryRequest,
    MiaodaEntryResponse,
    RememberLoginRequest,
    StaffOut,
    TabItem,
    WxLoginRequest,
)
from app.schemas.sim_card import SimCardOut, SimCardWrite
from app.services import dingtalk, login_throttle, remember_login
from app.services import miaoda_entry as miaoda_entry_service
from app.services import sim_card as sim_card_service
from app.services.password import hash_password, verify_password
from app.services.wechat import code_to_openid

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/wx-login", summary="微信小程序登录", response_model=AuthResponse)
async def wx_login(body: WxLoginRequest, db: Session = Depends(get_db)):
    wx_data = await code_to_openid(body.code)
    openid = wx_data["openid"]
    staff = db.query(Staff).filter(Staff.openid == openid, Staff.deleted_at.is_(None)).first()
    if not staff:
        return AuthResponse(needs_bind=True)
    if staff.status != StaffStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="账号未激活")
    token = create_access_token(staff.id, staff.role)
    tabs = [TabItem(**t) for t in get_tabs_for_role(staff.role)]
    return AuthResponse(
        token=token,
        staff=StaffOut.model_validate(staff),
        tabs=tabs,
        landing_page=get_landing_page(staff.role),
    )


@router.post("/bind", summary="绑定微信账号", response_model=AuthResponse)
async def bind_account(body: BindRequest, db: Session = Depends(get_db), request: Request = None):
    ip = login_throttle.client_ip(request)
    login_throttle.check(db, body.username, ip)
    wx_data = await code_to_openid(body.code)
    openid = wx_data["openid"]
    staff = (
        db.query(Staff)
        .filter(Staff.username == body.username, Staff.deleted_at.is_(None))
        .first()
    )
    login_throttle.admit(db, body.username, ip, known=staff is not None)
    if not staff or not verify_password(body.password, staff.password_hash):
        login_throttle.failed(db, body.username, ip, known=staff is not None)
        raise HTTPException(status_code=400, detail="账号或密码错误")
    login_throttle.succeeded(db, body.username, ip)
    if staff.status != StaffStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="账号未激活")
    existing = db.query(Staff).filter(Staff.openid == openid, Staff.id != staff.id).first()
    if existing:
        raise HTTPException(status_code=400, detail="该微信已绑定其他账号")
    staff.openid = openid
    # OA/台账推送：openid 变更同步到 OA（写入其 remark 对账串）
    from app.services import oa_push

    oa_push.on_staff_synced(db, staff)
    db.commit()
    db.refresh(staff)
    token = create_access_token(staff.id, staff.role)
    tabs = [TabItem(**t) for t in get_tabs_for_role(staff.role)]
    return AuthResponse(
        token=token,
        staff=StaffOut.model_validate(staff),
        tabs=tabs,
        landing_page=get_landing_page(staff.role),
    )


# ── 密码登录 ────────────────────────────────────────────────────────────────
# 密码登录端点（admin / workbench / device / crawler / dev，后来又加了 h5）曾经是五份
# 几乎一样的代码：查 Staff → 验密码 → 判角色 → 判状态 → 签令牌，只有角色白名单和报错
# 话术不同。复制到第五份时它已经不是"简单所以不用抽象"，而是"改一处容易漏另外四处"。
#
# 端点本身保留不动：小程序、H5、后台、PDA、工作台、执行端各自写死了自己的地址，
# 合并 URL 要一次协调所有客户端发版，不值得。合的是**后面那段逻辑**。

#: 每个入口放行哪些角色。这张表是「谁能从哪个门进来」的唯一声明——
#: 加角色改这里一行，不要再复制一个端点出来。
#: None = 不限角色（只有开发登录是这样，而它另有 allow_dev_login 开关把门）。
LOGIN_SURFACES: dict[str, tuple[str, ...] | None] = {
    "admin": (StaffRole.ADMIN,),
    # 后台页面的门。仓管、采购、业务员、销售只看得到验货相关页面（admin-web/src/utils/consoleAccess.js），
    # 能调哪些接口仍由各接口的角色校验决定，和他们从 H5 登录拿到的令牌一样。
    "console": (
        StaffRole.ADMIN, StaffRole.WAREHOUSE, StaffRole.PURCHASER, StaffRole.BUSINESS, StaffRole.SALES,
    ),
    # 工作台前面坐的是人：销售/采购/管理员各用自己的员工账号，角色决定看见什么。
    # ⚠️ 改这一行必须同步端上菜单表（xianyu-seller-pilot/src/renderer/src/menu.js）：
    # 服务端放行了、端上没有这个角色，症状是"登录成功却被弹回登录页"——菜单为空，
    # 落地页算不出来，而服务端日志里是一次干净的 200。tests/test_workbench_login.py
    # 直接读那份 menu.js 把两边钉在一起。
    "workbench": (StaffRole.ADMIN, StaffRole.PURCHASER, StaffRole.SALES),
    "device": (StaffRole.RFID_DEVICE,),
    # 无人值守执行端。CRAWLER 只读，MARKET_BOT 多一条窄写（回写商品名）。
    # 人不走这条——人走 workbench，两条路分开才查得清"谁在操作"。
    "crawler": (StaffRole.CRAWLER, StaffRole.MARKET_BOT),
    # 小程序的 H5 / PWA 版（panasia.fun/h5/）：页面就是小程序那套，用的人也是那批人，
    # 所以放行的正是小程序有 tab 可落地的那几个员工角色（deps.ROLE_TAB_KEYS 的键）。
    # 设备账号不从这里进。tests/test_h5_login.py 把这一行和 ROLE_TAB_KEYS 钉在一起。
    "h5": (
        StaffRole.ADMIN, StaffRole.PURCHASER, StaffRole.WAREHOUSE,
        StaffRole.NEGOTIATOR, StaffRole.SALES, StaffRole.FINANCE,
    ),
    # 统一登录（ERP 当 Authentik 的账号来源，routers/oidc.py 的登录页）：只放真人员工，设备账号不是人。
    # 这个门不发 ERP 的登录令牌，验过密码就回统一登录。
    "oidc": HUMAN_ROLES,
    # 咸鱼外卖助手（桌面端闲鱼监听）：公司员工都能用，设备账号不行。和巡航台分开一扇门，
    # 登录记录里才分得清是哪个应用进来的。
    "xianyu": HUMAN_ROLES,
    "dev": None,
}


def authenticate_staff(
    db: Session,
    username: str,
    password: str,
    *,
    surface: str,
    wrong_role: str,
    ip: str | None = None,
) -> Staff:
    """账号密码验人的共同部分：所有密码登录的门（含统一登录的登录页）都走这里。

    报错话术有意保持「账号或密码错误」一句话：分开说「查无此人」和「密码不对」
    等于给人一个枚举用户名的接口。

    防暴力尝试（login_throttle）也在这里：锁着先回 429、不验密码；每次尝试先记数再验，
    验对了清零。只有密码错 / 查无此人留在计数里——密码对但走错门（角色不符）、账号停用都不算猜密码。
    """
    staff = (
        db.query(Staff)
        .filter(Staff.username == username, Staff.deleted_at.is_(None))
        .first()
    )
    login_throttle.admit(db, username, ip, known=staff is not None)
    if not staff or not verify_password(password, staff.password_hash):
        login_throttle.failed(db, username, ip, known=staff is not None)
        raise HTTPException(status_code=400, detail="账号或密码错误")
    login_throttle.succeeded(db, username, ip)
    allowed = LOGIN_SURFACES[surface]
    if allowed is not None and staff.role not in allowed:
        raise HTTPException(status_code=403, detail=wrong_role)
    if staff.status != StaffStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="账号未激活")
    return staff


def _password_login(
    db: Session,
    username: str,
    password: str,
    *,
    surface: str,
    wrong_role: str,
    with_tabs: bool = False,
    ip: str | None = None,
) -> AuthResponse:
    """账号密码登录：验人（authenticate_staff）+ 签 ERP 的登录令牌。"""
    staff = authenticate_staff(db, username, password, surface=surface, wrong_role=wrong_role, ip=ip)
    token = create_access_token(staff.id, staff.role)
    if not with_tabs:
        return AuthResponse(token=token, staff=StaffOut.model_validate(staff))
    return AuthResponse(
        token=token,
        staff=StaffOut.model_validate(staff),
        tabs=[TabItem(**t) for t in get_tabs_for_role(staff.role)],
        landing_page=get_landing_page(staff.role),
    )


@router.post("/dev-login", summary="开发环境登录", response_model=AuthResponse)
def dev_login(body: AdminLoginRequest, db: Session = Depends(get_db), request: Request = None):
    """开发环境登录：不限角色，靠 allow_dev_login 开关把门（生产必须关）。"""
    if not settings.allow_dev_login:
        raise HTTPException(status_code=403, detail="开发登录已关闭")
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="dev", wrong_role="", with_tabs=True)

@router.post("/admin-login", summary="管理员登录", response_model=AuthResponse)
def admin_login(body: AdminLoginRequest, db: Session = Depends(get_db), request: Request = None):
    """管理后台的门。只放行 ADMIN。"""
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="admin", wrong_role="非管理员账号")

@router.post("/console-login", summary="后台页面登录（含验货相关角色）", response_model=AuthResponse)
def console_login(body: AdminLoginRequest, db: Session = Depends(get_db), request: Request = None):
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="console", wrong_role="这个账号不能登录后台")


@router.post("/workbench-login", summary="浏览器工作台登录", response_model=AuthResponse)
def workbench_login(body: AdminLoginRequest, db: Session = Depends(get_db), request: Request = None):
    """浏览器工作台按**人**登录：销售 / 采购 / 管理员各用自己的员工账号。

    为什么不复用另外两条：admin-login 只放行 ADMIN（后台管理的门）、
    crawler-login 只认设备账号（无人值守执行端的门）。工作台前面坐的是人，
    要的是「员工账号 + 角色」，第三种语义。放行名单见 LOGIN_SURFACES。
    """
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="workbench", wrong_role="这个账号不能登录工作台")

@router.post("/h5-login", summary="H5 版账号密码登录", response_model=AuthResponse)
def h5_login(body: AdminLoginRequest, db: Session = Depends(get_db), request: Request = None):
    """小程序 H5 / PWA 版的门：员工账号密码直接登录，不经微信。

    和 /bind 的区别：不写 openid。H5 的登录、退出都不能碰小程序那边的微信绑定——
    同一个人两边都在用，H5 这边退出不该把他的小程序也踢掉（所以 H5 退出也不调 /logout）。
    返回带 tabs / landing_page，和小程序登录一样，页面按它落地。
    """
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="h5", wrong_role="这个账号不能登录 H5", with_tabs=True)


@router.get("/dingtalk-config", summary="H5 钉钉免登前端配置", response_model=DingtalkConfigOut)
def dingtalk_config():
    """给钉钉工作台打开的 H5 用：Client ID / corpId，不含 Secret。"""
    return DingtalkConfigOut(
        enabled=dingtalk.h5_sso_ready(),
        client_id=settings.dingtalk_client_id.strip() if dingtalk.h5_sso_ready() else "",
        corp_id=settings.dingtalk_corp_id.strip() if dingtalk.h5_sso_ready() else "",
    )


@router.post("/dingtalk-login", summary="钉钉工作台免登进 H5", response_model=AuthResponse)
def dingtalk_login(body: DingtalkLoginRequest, db: Session = Depends(get_db)):
    """钉钉工作台打开 H5：前端 dd.requestAuthCode → 这里用 code 换 userid → 按 staff.dingtalk_userid 发令牌。

    没关联钉钉的员工回 403，H5 落到账号密码页。应用凭证没配齐回 503。
    """
    if not dingtalk.h5_sso_ready():
        raise HTTPException(status_code=503, detail="钉钉免登未配置")
    try:
        identity = dingtalk.userinfo_by_auth_code(body.code)
    except dingtalk.DingtalkError as exc:
        raise HTTPException(status_code=401, detail=str(exc) or "钉钉登录凭证无效") from exc
    userid = (identity.get("userid") or "").strip()
    staff = (
        db.query(Staff)
        .filter(Staff.dingtalk_userid == userid, Staff.deleted_at.is_(None))
        .first()
    )
    if not staff:
        raise HTTPException(status_code=403, detail="当前钉钉未关联 ERP 账号，请用账号密码登录，或让管理员在后台绑定钉钉")
    if staff.role not in LOGIN_SURFACES["h5"]:
        raise HTTPException(status_code=403, detail="这个账号不能登录 H5")
    if staff.status != StaffStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="账号未激活")
    return AuthResponse(
        token=create_access_token(staff.id, staff.role),
        staff=StaffOut.model_validate(staff),
        tabs=[TabItem(**t) for t in get_tabs_for_role(staff.role)],
        landing_page=get_landing_page(staff.role),
    )

@router.post("/xianyu-login", summary="咸鱼外卖助手登录", response_model=AuthResponse)
def xianyu_login(body: AdminLoginRequest, db: Session = Depends(get_db), request: Request = None):
    """咸鱼外卖助手（桌面端）按人登录。放行名单见 LOGIN_SURFACES["xianyu"]。"""
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="xianyu", wrong_role="这个账号不能登录咸鱼外卖助手")

@router.post("/xianyu-refresh", summary="咸鱼外卖助手续期登录", response_model=AuthResponse)
def xianyu_refresh(user: Staff = Depends(get_current_user)):
    """拿还有效的令牌换一张新的（又是 jwt_expire_minutes）。端上每次启动和每隔几小时续一次，
    所以只有连续这么久没打开，令牌过期了才要重新输密码。账号停用、角色被改出放行名单都续不了。"""
    if user.role not in LOGIN_SURFACES["xianyu"]:
        raise HTTPException(status_code=403, detail="这个账号不能登录咸鱼外卖助手")
    return AuthResponse(token=create_access_token(user.id, user.role), staff=StaffOut.model_validate(user))

@router.post("/h5-remember", summary="H5 记住密码：给这台设备发一张记住登录的凭证")
def h5_remember(user: Staff = Depends(get_current_user)):
    """登录之后、用户勾了「记住密码」时调。端上存这张凭证，不存密码（为什么见 services/remember_login.py）。
    30 天有效，员工改密码即作废；每次登录后端上会再要一张，常用的人不会过期。"""
    if user.role not in LOGIN_SURFACES["h5"]:
        raise HTTPException(status_code=403, detail="这个账号不能登录 H5")
    return {"remember_token": remember_login.issue(user), "expires_in_days": remember_login.REMEMBER_DAYS}


@router.post("/h5-remember-login", summary="H5 用记住的凭证登录", response_model=AuthResponse)
def h5_remember_login(body: RememberLoginRequest, db: Session = Depends(get_db)):
    """登录页「已记住密码」直接点登录走这里。凭证无效（过期、改过密码、账号停用、伪造）一律 401，
    端上据此清掉记住的状态、让人重新输密码。不走防暴力计数：凭证是签名过的，猜不出来。"""
    staff = remember_login.verify(db, body.remember_token)
    if not staff or staff.role not in LOGIN_SURFACES["h5"]:
        raise HTTPException(status_code=401, detail="记住的密码已失效，请重新输入")
    return AuthResponse(
        token=create_access_token(staff.id, staff.role),
        staff=StaffOut.model_validate(staff),
        tabs=[TabItem(**t) for t in get_tabs_for_role(staff.role)],
        landing_page=get_landing_page(staff.role),
    )


@router.post("/miaoda-entry", summary="从员工工作台免登录进 H5", response_model=MiaodaEntryResponse)
def miaoda_entry(body: MiaodaEntryRequest, db: Session = Depends(get_db)):
    """员工工作台用 iframe 带一次性 entry_token 打开 H5，H5 拿它来这里换登录。

    这里去工作台的 verify 端点换员工身份（key 只在服务端，见 services/miaoda_entry.py）。
    工作台那边的绑定是填进去的 ERP 账号 ID，默认不直接信：同一个工作台账号第一次进来回 needs_confirm，
    要输一次这个 ERP 账号的密码（/miaoda-confirm），确认过的记在 miaoda_binding，之后再进免登录。

    不用输密码的只有一种：工作台担保了（erpVerified，本人用 ERP 账号从统一登录登的工作台，见
    services/miaoda_entry.py），而且工作台用户 ID 就是这个员工的 ERP 员工 ID。这时直接记一条确认过的绑定、
    登录进来。工作台用户 ID 已经确认绑在别的 ERP 账号上的，照旧要输密码，不悄悄改绑。账号不存在、
    不能登录 H5、停用的，前面就挡住了。

    token 作废、过期回 401，H5 按没带 token 处理（有会话照用，没有去登录页）。
    """
    try:
        who = miaoda_entry_service.verify(body.entry_token)
    except miaoda_entry_service.EntryRejected as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except miaoda_entry_service.EntryUnavailable as exc:
        raise HTTPException(status_code=503, detail="暂时没法从工作台直接进入，请用账号密码登录") from exc
    staff = _staff_for_erp_user_id(db, who.erp_user_id)
    if not staff:
        raise HTTPException(status_code=401, detail="工作台绑定的 ERP 账号不存在，请回工作台重新绑定")
    if staff.role not in LOGIN_SURFACES["h5"]:
        raise HTTPException(status_code=403, detail="这个账号不能登录 H5")
    if staff.status != StaffStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="账号未激活")
    binding = db.get(MiaodaBinding, who.miaoda_user_id)
    if binding is None and who.erp_verified and who.miaoda_user_id == staff.id:
        # 工作台担保了、工作台 ID 就是 ERP 员工 ID：这次就算本人确认过
        binding = MiaodaBinding(miaoda_user_id=who.miaoda_user_id, staff_id=staff.id)
        db.add(binding)
    if binding is None or binding.staff_id != staff.id:
        # 没确认过，或者工作台那边改绑成了别的账号：都要本人再确认一次
        return MiaodaEntryResponse(
            needs_confirm=True,
            ticket=miaoda_entry_service.issue_ticket(who.miaoda_user_id, staff.id),
            username=staff.username,
        )
    binding.last_entry_at = datetime.utcnow()
    db.commit()
    return MiaodaEntryResponse(
        token=create_access_token(staff.id, staff.role),
        staff=StaffOut.model_validate(staff),
        tabs=[TabItem(**t) for t in get_tabs_for_role(staff.role)],
        landing_page=get_landing_page(staff.role),
    )


@router.post("/miaoda-confirm", summary="从员工工作台第一次进入：输一次 ERP 密码确认本人", response_model=AuthResponse)
def miaoda_confirm(body: MiaodaConfirmRequest, db: Session = Depends(get_db), request: Request = None):
    """miaoda-entry 回 needs_confirm 之后，H5 带着票据和密码来这里。

    账号取自票据（就是工作台绑定的那个），这里只收密码：确认的是"工作台这个人是这个 ERP 账号
    的主人"，不是换个账号登录。走 _password_login，防暴力计数和普通登录是同一套。
    """
    try:
        miaoda_user_id, staff_id = miaoda_entry_service.read_ticket(body.ticket)
    except miaoda_entry_service.TicketInvalid as exc:
        raise HTTPException(status_code=401, detail="确认超时，请回工作台重新进入") from exc
    staff = db.get(Staff, staff_id)
    if not staff or staff.deleted_at:
        raise HTTPException(status_code=401, detail="确认超时，请回工作台重新进入")
    res = _password_login(db, staff.username, body.password, ip=login_throttle.client_ip(request),
                          surface="h5", wrong_role="这个账号不能登录 H5", with_tabs=True)
    binding = db.get(MiaodaBinding, miaoda_user_id)
    if binding is None:
        binding = MiaodaBinding(miaoda_user_id=miaoda_user_id, staff_id=staff.id)
        db.add(binding)
    binding.staff_id = staff.id
    binding.last_entry_at = datetime.utcnow()
    db.commit()
    return res


def _staff_for_erp_user_id(db: Session, erp_user_id: str) -> Staff | None:
    """工作台的「ERP 账号 ID」员工可能填登录账号、工号或内部 ID，按这个顺序认。"""
    for column in (Staff.username, Staff.staff_no, Staff.id):
        staff = db.query(Staff).filter(column == erp_user_id, Staff.deleted_at.is_(None)).first()
        if staff:
            return staff
    return None


@router.post("/device-login", summary="RFID 设备登录", response_model=AuthResponse)
def device_login(body: DeviceLoginRequest, db: Session = Depends(get_db), request: Request = None):
    """RFID 手持终端（PDA）登录。仅 RFID_DEVICE 角色可用。"""
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="device", wrong_role="非 RFID 设备账号")

@router.post("/crawler-login", summary="爬虫设备登录", response_model=AuthResponse)
def crawler_login(body: DeviceLoginRequest, db: Session = Depends(get_db), request: Request = None):
    """无人值守执行端登录。CRAWLER（只读采集）与 MARKET_BOT（多一条窄写）走这条。

    人不走这条——人走 /auth/workbench-login。两条路分开，"谁在操作"才查得清。
    """
    return _password_login(db, body.username, body.password, ip=login_throttle.client_ip(request),
                           surface="crawler", wrong_role="非设备账号")

@router.post("/refresh", summary="续期登录令牌", response_model=AuthResponse)
def refresh(user: Staff = Depends(get_current_user)):
    """用未过期的 token 换发一枚新的 7 天 token（PDA 启动/定期自动续期）。"""
    token = create_access_token(user.id, user.role)
    return AuthResponse(token=token, staff=StaffOut.model_validate(user))


@router.get("/me", summary="查询当前员工信息")
def me(user: Staff = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.dingtalk_sync import needs_github

    tabs = [TabItem(**t) for t in get_tabs_for_role(user.role)]
    return {
        "staff": StaffOut.model_validate(user),
        "tabs": tabs,
        "landing_page": get_landing_page(user.role),
        # 钉钉部门要用代码仓库（默认技术部）：「我的信息」显示 GitHub 那一栏
        "need_github": needs_github(db, user),
    }


@router.put("/me/github", summary="填自己的 GitHub 邮箱或用户名，自动邀请进代码仓库（部门要用代码仓库的人才能填）")
def set_my_github(body: GithubAccountIn, user: Staff = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services import github_invite
    from app.services.dingtalk_sync import needs_github

    if not needs_github(db, user):
        raise HTTPException(status_code=403, detail="你的部门不用代码仓库，要用找管理员在后台填")
    try:
        account = github_invite.clean_account(body.account)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if user.github_account and user.github_account != account:
        github_invite.revoke(user.github_account)  # 换账号：旧的移出，不然改几次就多几个能 push 的
    user.github_account = account
    github_invite.invite(user)
    db.commit()
    return {"github_account": user.github_account, "github_status": user.github_status}


@router.post("/change-password", summary="修改登录密码")
def change_password(
    body: ChangePasswordRequest,
    user: Staff = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码错误")
    if body.old_password == body.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与原密码相同")
    user.password_hash = hash_password(body.new_password)
    # OA/台账推送：密码哈希直接覆盖 OA 的 sys_user.password，不同步会导致 OA 侧登录用旧密码
    from app.services import oa_push

    oa_push.on_staff_synced(db, user)
    db.commit()
    return {"ok": True}


# ==================== 个人信息：手机卡信息自助管理（手机号 / ICCID / 空卡序列号）====================
@router.get("/sim-cards", summary="本人手机卡列表", response_model=list[SimCardOut])
def list_my_sim_cards(
    user: Staff = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """列出本人绑定的所有手机卡信息。"""
    return sim_card_service.list_cards(db, user.id)


@router.post("/sim-cards", summary="新增手机卡", response_model=SimCardOut)
def create_my_sim_card(
    body: SimCardWrite,
    user: Staff = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """新增一张本人的手机卡信息（三字段至少填一项）。"""
    return sim_card_service.create_card(db, user.id, body.model_dump(exclude_unset=True))


@router.patch("/sim-cards/{card_id}", summary="修改手机卡", response_model=SimCardOut)
def update_my_sim_card(
    card_id: str,
    body: SimCardWrite,
    user: Staff = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改本人的某张卡片（未传的字段不动，传空串视为清空）。"""
    return sim_card_service.update_card(db, user.id, card_id, body.model_dump(exclude_unset=True))


@router.delete("/sim-cards/{card_id}", summary="删除手机卡", status_code=204)
def delete_my_sim_card(
    card_id: str,
    user: Staff = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除本人的某张卡片。"""
    sim_card_service.delete_card(db, user.id, card_id)
    return Response(status_code=204)


@router.post("/logout", summary="退出登录")
def logout(user: Staff = Depends(get_current_user), db: Session = Depends(get_db)):
    user.openid = None
    db.commit()
    return {"ok": True}
