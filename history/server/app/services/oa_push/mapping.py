"""OA 推送用的纯工具函数：周期/日期换算、状态与角色映射。

时间口径：库里 created_at 等为 **naive UTC**（见 SalesOutbound / finance 过滤），
这里统一按中国时区(UTC+8)换算出 period/bizDate，与业务展示一致。
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.services.finance import CN_TZ

# 非真人角色：不同步到 OA（设备/爬虫账号）
NON_HUMAN_ROLES = {"RFID_DEVICE", "CRAWLER"}


def to_cn(dt: datetime) -> datetime:
    """naive UTC → 中国时区(aware)。已带时区的按原样换算。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(CN_TZ)


def period_month(dt: datetime) -> str:
    """归属月，如 202608（按中国自然月）。"""
    return to_cn(dt).strftime("%Y%m")


def period_day(dt: datetime) -> str:
    """归属日，如 20260810（按中国自然日）。"""
    return to_cn(dt).strftime("%Y%m%d")


def biz_date(dt: datetime) -> str:
    """业务日期 yyyy-MM-dd（按中国自然日）。"""
    return to_cn(dt).strftime("%Y-%m-%d")


def datetime_cn_str(dt: datetime) -> str:
    """yyyy-MM-dd HH:mm:ss（中国时区），供 replyTime 等。"""
    return to_cn(dt).strftime("%Y-%m-%d %H:%M:%S")


def staff_status_to_oa(status: str | None) -> str:
    """StaffStatus(PENDING/ACTIVE/DISABLED) → OA(ENABLED/DISABLED)。仅 ACTIVE 视为启用。"""
    return "ENABLED" if (status or "").upper() == "ACTIVE" else "DISABLED"


def is_human_role(role: str | None) -> bool:
    return (role or "").upper() not in NON_HUMAN_ROLES
