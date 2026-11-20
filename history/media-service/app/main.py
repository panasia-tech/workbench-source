"""对外入口。

  GET  /m/<资料ID>                      固定入口：播放页 / 教材页（工作台和钉钉 Wiki 只存这个）
  GET  /api/m/<资料ID>/play             现签一个播放地址（每次都重新判权限）
  GET  /api/m/<资料ID>/files/<文件ID>   配套文件：现签地址后 302 过去（存储不能改响应头时，PDF 由本服务转发）
  GET  /api/catalog?groups=…            工作台取「培训视频」目录（服务令牌；按传来的分组判能看哪些）
  GET  /auth/login、/auth/callback      统一登录
  GET  /_local/<对象键>                 本地存储模式下代替 OSS 出文件（支持 Range）
"""
import hmac
import html
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth, usage
from app.config import Settings, get_settings
from app.db import get_db, init_db
from app.models import Attachment, MediaItem
from app.storage import LocalStorage, Storage, build_storage, content_disposition

TEMPLATES = Path(__file__).parent / "templates"
NO_STORE = {"Cache-Control": "no-store"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    s = get_settings()
    if not s.session_secret:
        raise RuntimeError("没配 MEDIA_SESSION_SECRET")
    init_db()
    yield


app = FastAPI(title="media-service", lifespan=lifespan)

_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        _storage = build_storage(get_settings())
    return _storage


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[Session, Depends(get_db)]


def get_viewer(
    db: DbDep, s: SettingsDep,
    media_session: Annotated[str | None, Cookie()] = None,
    media_pass: Annotated[str | None, Cookie()] = None,
) -> auth.Viewer:
    return auth.load_viewer(db, s, media_session, media_pass)


ViewerDep = Annotated[auth.Viewer, Depends(get_viewer)]


def _cookie(resp: Response, s: Settings, name: str, value: str, max_age: int) -> None:
    resp.set_cookie(name, value, max_age=max_age, httponly=True, samesite="lax", secure=s.secure_cookies, path="/")


def _render(name: str, **values: str) -> str:
    """一次替换完所有 {{占位}}；值要先转义好。"""
    page = (TEMPLATES / name).read_text()
    return re.sub(r"\{\{(\w+)\}\}", lambda m: values.get(m.group(1), ""), page)


def _message(title: str, text: str, status: int) -> HTMLResponse:
    page = _render("message.html", title=html.escape(title), text=html.escape(text))
    return HTMLResponse(page, status_code=status, headers=NO_STORE)


def _published_item(db: Session, item_id: str) -> MediaItem | None:
    item = db.get(MediaItem, item_id)
    if item is None or (item.kind == "video" and item.published_version_id is None):
        return None
    return item


# ---------------------------------------------------------------- 固定入口


@app.get("/m/{item_id}", response_class=HTMLResponse)
def item_page(item_id: str, request: Request, db: DbDep, s: SettingsDep, viewer: ViewerDep):
    # 外部凭证从链接 ?pass= 进来：存进 cookie，再跳回不带令牌的地址，免得令牌留在地址栏和转发里
    token = request.query_params.get("pass")
    if token:
        if auth.active_pass(db, token) is None:
            return _message("链接已失效", "这个访问链接过期或被收回了，找发给你链接的人要一个新的。", 403)
        resp = RedirectResponse(f"/m/{quote(item_id)}", status_code=303, headers=NO_STORE)
        _cookie(resp, s, auth.PASS_COOKIE, token, 30 * 86400)
        return resp

    item = _published_item(db, item_id)
    if item is None:
        return _message("资料不存在", "这份资料还没发布，或者链接写错了。", 404)
    if auth.needs_login(item, viewer, s):
        return RedirectResponse(f"/auth/login?next={quote('/m/' + item_id)}", status_code=303, headers=NO_STORE)
    if not auth.can_view(item, viewer, s):
        return _message("没有权限", "你的账号看不了这份资料。需要的话找管理员开通。", 403)

    files = "".join(
        f'<li><a href="/api/m/{quote(item.id)}/files/{a.id}" target="_blank" rel="noopener">'
        f'{html.escape(a.title)}</a><span>{_file_hint(a)}</span></li>'
        for a in item.attachments
    )
    page = _render(
        "item.html",
        title=html.escape(item.title),
        item_id=html.escape(item.id),  # 资料 ID 只有小写字母、数字、横线，可以直接放进脚本字符串
        description=html.escape(item.description),
        has_video="1" if item.published_version_id else "",
        files=files,
        viewer=html.escape(viewer.name or ("外部访问" if viewer.passes else "")),
    )
    return HTMLResponse(page, headers=NO_STORE)


def _file_hint(a: Attachment) -> str:
    if a.content_type == "application/pdf":
        return "在线预览"
    if a.content_type.startswith("text/"):
        return "在线阅读"
    return "下载原件"


def _check(db: Session, s: Settings, viewer: auth.Viewer, item_id: str) -> MediaItem:
    item = _published_item(db, item_id)
    if item is None:
        raise HTTPException(404, "资料不存在")
    if not auth.can_view(item, viewer, s):
        raise HTTPException(401 if auth.needs_login(item, viewer, s) else 403, "没有权限")
    return item


@app.get("/api/m/{item_id}/play")
def play_url(item_id: str, request: Request, db: DbDep, s: SettingsDep, viewer: ViewerDep):
    item = _check(db, s, viewer, item_id)
    v = item.published_version
    if v is None:
        raise HTTPException(404, "这份资料没有视频")
    usage.record_play(db, item.id, v, usage.viewer_key(viewer, item.id, request))
    url = get_storage().signed_url(v.object_key, s.sign_ttl_seconds, content_type=v.content_type,
                                   disposition=content_disposition("inline", f"{item.title}.mp4"))
    # version 给播放页判断换没换版本；expires_in 留余量，播放页提前换地址
    return JSONResponse({"url": url, "expires_in": s.sign_ttl_seconds, "version": v.version_no}, headers=NO_STORE)


@app.get("/api/catalog")
def catalog(db: DbDep, s: SettingsDep, groups: str = "", authorization: Annotated[str, Header()] = ""):
    """工作台学习中心的「培训视频」：按员工的平台分组列出他能看的已发布资料，按课程分组、按集排序。

    工作台带服务令牌来问，分组由工作台从统一登录拿到的组名转过来。这里只给标题和固定链接，真正打开播放时
    固定入口还会让员工自己登录、再判一次权限，所以分组传错了最多是多看到或少看到标题。
    """
    scheme, _, token = authorization.partition(" ")
    if not s.catalog_token:
        raise HTTPException(404)
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip().encode(), s.catalog_token.encode()):
        raise HTTPException(401, "令牌不对")
    viewer = auth.Viewer(staff_id="catalog", roles={g.strip().casefold() for g in groups.split(",") if g.strip()})
    base = s.base_url.rstrip("/")
    series: dict[str, list[dict]] = {}
    items = db.scalars(select(MediaItem).order_by(MediaItem.series, MediaItem.sort, MediaItem.id))
    for item in items:
        # 只给外部人员的资料不是培训课，管理员能看也不列进员工的课程表
        if item.audience == "external" or _published_item(db, item.id) is None or not auth.can_view(item, viewer, s):
            continue
        series.setdefault(item.series or "其他资料", []).append(
            {"id": item.id, "title": item.title, "kind": item.kind, "url": f"{base}/m/{quote(item.id)}"})
    return JSONResponse({"series": [{"name": k, "items": v} for k, v in series.items()]}, headers=NO_STORE)


@app.get("/api/m/{item_id}/files/{file_id}")
def file_url(item_id: str, file_id: int, db: DbDep, s: SettingsDep, viewer: ViewerDep):
    item = _check(db, s, viewer, item_id)
    a = db.get(Attachment, file_id)
    if a is None or a.item_id != item.id:
        raise HTTPException(404, "文件不存在")
    inline = a.content_type == "application/pdf" or a.content_type.startswith("text/")
    filename = a.title if Path(a.title).suffix else a.title + Path(a.object_key).suffix
    disposition = content_disposition("inline" if inline else "attachment", filename)
    storage = get_storage()
    if inline and not storage.can_override:
        # OSS 默认域名一律按下载返回，讲义这类小文件由本服务转发才能在浏览器里预览
        return StreamingResponse(storage.read_chunks(a.object_key), media_type=a.content_type,
                                 headers={**NO_STORE, "Content-Disposition": disposition, "Content-Length": str(a.size)})
    url = storage.signed_url(a.object_key, s.sign_ttl_seconds, content_type=a.content_type, disposition=disposition)
    return RedirectResponse(url, status_code=302, headers=NO_STORE)


# ---------------------------------------------------------------- 登录


@app.get("/auth/login")
def login(s: SettingsDep, next: str = "/"):
    if not next.startswith("/") or next.startswith("//"):
        next = "/"
    if not s.oidc_issuer:
        if s.dev_login:
            return RedirectResponse(f"/auth/dev-login?next={quote(next)}", status_code=303)
        return _message("登录没配好", "资料服务还没接上统一登录，找管理员。", 503)
    url, cookie = auth.start_login(s, next)
    resp = RedirectResponse(url, status_code=303, headers=NO_STORE)
    _cookie(resp, s, auth.LOGIN_COOKIE, cookie, 600)
    return resp


@app.get("/auth/callback")
def callback(s: SettingsDep, code: str = "", state: str = "",
             media_login: Annotated[str | None, Cookie()] = None):
    try:
        payload, next_path = auth.finish_login(s, media_login, code, state)
    except auth.LoginFailed as exc:
        return _message("登录没成功", str(exc), 400)
    resp = RedirectResponse(next_path, status_code=303, headers=NO_STORE)
    _cookie(resp, s, auth.SESSION_COOKIE, auth.sign(payload, s.session_secret), s.session_ttl_hours * 3600)
    resp.delete_cookie(auth.LOGIN_COOKIE, path="/")
    return resp


@app.get("/auth/dev-login")
def dev_login(s: SettingsDep, next: str = "/", role: str = "staff", name: str = "测试员工", staff_id: str = "dev"):
    if not s.dev_login:
        raise HTTPException(404)
    if not next.startswith("/") or next.startswith("//"):
        next = "/"
    resp = RedirectResponse(next, status_code=303, headers=NO_STORE)
    payload = auth.session_payload(s, staff_id, name, {r for r in role.split(",") if r})
    _cookie(resp, s, auth.SESSION_COOKIE, auth.sign(payload, s.session_secret), s.session_ttl_hours * 3600)
    return resp


@app.get("/auth/logout")
def logout():
    resp = RedirectResponse("/", status_code=303)
    resp.delete_cookie(auth.SESSION_COOKIE, path="/")
    resp.delete_cookie(auth.PASS_COOKIE, path="/")
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------------------------------------------------------------- 本地存储出文件


@app.get("/_local/{key:path}")
def local_file(key: str, e: int, ct: str, cd: str, s: str):
    storage = get_storage()
    if not isinstance(storage, LocalStorage):
        raise HTTPException(404)
    if not storage.verify(key, e, ct, cd, s):
        # 和 OSS 一样：过期或签名不对一律 403，播放页看到出错就去换地址
        raise HTTPException(403, "签名过期或无效")
    path = storage.path_for(key)
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type=ct, headers={"Content-Disposition": cd, "Accept-Ranges": "bytes"})
