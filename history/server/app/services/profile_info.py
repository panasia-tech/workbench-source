"""员工手机卡信息字段（手机号 / ICCID / 空卡序列号）的统一校验。

手机号只做基本格式校验；ICCID / 空卡序列号不限内容、仅限长度。空串视为清空（存 NULL）。
"""
import re

from fastapi import HTTPException

PHONE_RE = re.compile(r"^1[3-9]\d{9}$")
ICCID_MAX_LEN = 50
BLANK_SERIAL_MAX_LEN = 64


def normalize_phone(value: str | None) -> str | None:
    phone = (value or "").strip()
    if not phone:
        return None
    if not PHONE_RE.match(phone):
        raise HTTPException(status_code=400, detail="手机号格式不正确")
    return phone


def normalize_iccid(value: str | None) -> str | None:
    iccid = (value or "").strip()
    if not iccid:
        return None
    if len(iccid) > ICCID_MAX_LEN:
        raise HTTPException(status_code=400, detail=f"ICCID 长度不能超过 {ICCID_MAX_LEN} 位")
    return iccid


def normalize_blank_serial(value: str | None) -> str | None:
    serial = (value or "").strip()
    if not serial:
        return None
    if len(serial) > BLANK_SERIAL_MAX_LEN:
        raise HTTPException(status_code=400, detail=f"空卡序列号长度不能超过 {BLANK_SERIAL_MAX_LEN} 位")
    return serial
