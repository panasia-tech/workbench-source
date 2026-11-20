"""技术部新人填了 GitHub 账号，自动邀请进公司代码仓库（settings.github_invite_repos）。

仓库是个人仓库（superzou2021），GitHub 只支持按用户名邀请协作者，不支持按邮箱：
- 填的是用户名：查一下有没有这个人，直接邀请；
- 填的是邮箱：用 GitHub 搜索按邮箱找用户名，只有对方在 GitHub 公开了这个邮箱才找得到，
  找不到就在结果里写清楚「请改填用户名」。
邀请结果写进 staff.github_status（一句给人看的话），后台和「我的信息」都显示它。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime

import httpx

from app.config import settings
from app.models import Staff

logger = logging.getLogger(__name__)

API = "https://api.github.com"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")


def clean_account(value: str | None) -> str | None:
    """去空格；空返回 None；不像邮箱也不像用户名抛 ValueError。"""
    value = (value or "").strip()
    if not value:
        return None
    if value.startswith("@"):
        value = value[1:]
    if len(value) > 128 or not (EMAIL_RE.match(value) or LOGIN_RE.match(value)):
        raise ValueError("GitHub 账号要填邮箱或用户名（字母、数字、短横线）")
    return value


def _repos() -> list[str]:
    return [r.strip() for r in (settings.github_invite_repos or "").split(",") if r.strip()]


def _http(method: str, path: str, *, params=None, json=None) -> tuple[int, dict]:
    headers = {
        "Authorization": f"Bearer {settings.github_invite_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    resp = httpx.request(method, f"{API}{path}", headers=headers, params=params, json=json, timeout=15)
    try:
        body = resp.json() if resp.content else {}
    except ValueError:
        body = {}
    if isinstance(body, list):
        body = {"items": body}
    return resp.status_code, body if isinstance(body, dict) else {}


def resolve_login(account: str, *, http=_http) -> tuple[str | None, str]:
    """邮箱或用户名 → GitHub 用户名。找不到返回 (None, 原因)。"""
    if EMAIL_RE.match(account):
        code, body = http("GET", "/search/users", params={"q": f"{account} in:email"})
        if code != 200:
            return None, f"按邮箱查 GitHub 用户失败（{code}）"
        items = body.get("items") or []
        if len(items) != 1:
            return None, f"邮箱 {account} 在 GitHub 上查不到（对方没公开这个邮箱），请改填 GitHub 用户名"
        return items[0]["login"], ""
    code, body = http("GET", f"/users/{account}")
    if code == 404:
        return None, f"GitHub 上没有用户 {account}，请检查拼写"
    if code != 200:
        return None, f"查 GitHub 用户失败（{code}）"
    return body.get("login") or account, ""


def invite(staff: Staff, *, http=_http, now: datetime | None = None) -> str:
    """按 staff.github_account 邀请进所有仓库，结果写进 staff.github_status 并返回（不 commit）。"""
    stamp = (now or datetime.now()).strftime("%m-%d %H:%M")
    account = staff.github_account
    if not account:
        staff.github_status = None
        return ""
    if not settings.github_invite_token:
        staff.github_status = f"{stamp} 已记下，ERP 还没配 GitHub 令牌，配好后管理员在后台补发邀请"
        return staff.github_status
    try:
        login, why = resolve_login(account, http=http)
        if not login:
            staff.github_status = f"{stamp} {why}"
            return staff.github_status
        parts = []
        for repo in _repos():
            code, body = http("PUT", f"/repos/{repo}/collaborators/{login}", json={"permission": "push"})
            if code == 201:
                parts.append(f"{repo} 已发邀请，去 GitHub 邮箱或 github.com/notifications 点接受")
            elif code == 204:
                parts.append(f"{repo} 已经在仓库里")
            else:
                parts.append(f"{repo} 邀请失败（{code} {body.get('message') or ''}）".replace(" ）", "）"))
        staff.github_status = f"{stamp} {login}：" + "；".join(parts or ["没配要邀请的仓库"])
    except httpx.HTTPError as exc:
        logger.warning("GitHub 邀请 %s 失败：%s", account, exc)
        staff.github_status = f"{stamp} 连不上 GitHub，稍后在后台补发"
    staff.github_status = staff.github_status[:255]
    logger.info("GitHub 邀请 %s %s：%s", staff.staff_no, account, staff.github_status)
    return staff.github_status


def revoke(account: str | None, *, http=_http) -> str:
    """把这个账号移出所有仓库、撤掉没接受的邀请（换了账号、离职）。不改 staff；返回一句说明，失败只记日志。

    原来只会邀请不会收回：反复改账号每次都多一个有 push 权限的人，离职了也还能 push。
    """
    if not account or not settings.github_invite_token:
        return ""
    try:
        login, why = resolve_login(account, http=http)
        if not login:
            return why
        parts = []
        for repo in _repos():
            code, _ = http("DELETE", f"/repos/{repo}/collaborators/{login}")
            if code not in (204, 404):
                parts.append(f"{repo} 移出失败（{code}）")
            code, body = http("GET", f"/repos/{repo}/invitations", params={"per_page": 100})
            for inv in (body.get("items") if isinstance(body, dict) else None) or []:
                if (inv.get("invitee") or {}).get("login", "").lower() == login.lower():
                    http("DELETE", f"/repos/{repo}/invitations/{inv['id']}")
        msg = f"{login} 已移出代码仓库" + ("；" + "；".join(parts) if parts else "")
    except httpx.HTTPError as exc:
        msg = f"连不上 GitHub，{account} 没移出代码仓库：{exc}"
    logger.info("GitHub 收回 %s：%s", account, msg)
    return msg
