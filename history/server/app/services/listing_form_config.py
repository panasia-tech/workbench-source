"""上架表单静态配置：成色选项与成色映射。"""



import hashlib

import json

import logging

import time

from typing import Any



from sqlalchemy.orm import Session



logger = logging.getLogger(__name__)



STUFF_STATUS_OPTIONS = [

    {"value": 0, "label": "无"},

    {"value": 100, "label": "全新"},

    {"value": -1, "label": "准新"},

    {"value": 99, "label": "99新"},

    {"value": 95, "label": "95新"},

    {"value": 90, "label": "9新"},

    {"value": 85, "label": "85新"},

    {"value": 80, "label": "8新"},

    {"value": 70, "label": "7新"},

    {"value": 60, "label": "6新"},

    {"value": 50, "label": "5新"},

]



CONDITION_GRADE_MAP = {

    "全新": 100,

    "准新": -1,

    "99新": 99,

    "95新": 95,

    "9新": 90,

    "85新": 85,

    "8新": 80,

    "7新": 70,

    "6新": 60,

    "5新": 50,

    "88新": 88,

    "92新": 92,

}



def condition_grade_to_stuff_status(grade: str) -> int:

    """成色文案 → stuff_status 枚举。"""

    for key, val in CONDITION_GRADE_MAP.items():

        if key in grade:

            return val

    return 85



_cache: dict[str, Any] = {"payload": None, "fetched_at": 0.0}

_CACHE_TTL = 300





def invalidate_cache() -> None:

    _cache["payload"] = None

    _cache["fetched_at"] = 0.0





def _defaults(db: Session) -> dict:

    return {

        "stuff_status": 95,

        "express_fee": 0,

    }





def _compute_version(payload: dict) -> str:

    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]





async def build_form_config(db: Session) -> dict:

    now = time.time()

    if _cache["payload"] and now - _cache["fetched_at"] < _CACHE_TTL:

        return _cache["payload"]



    defaults = _defaults(db)



    body_without_version = {

        "defaults": defaults,

        "stuff_status_options": STUFF_STATUS_OPTIONS,

        "condition_grade_map": CONDITION_GRADE_MAP,

    }

    version = _compute_version(body_without_version)

    payload = {"version": version, **body_without_version}

    _cache["payload"] = payload

    _cache["fetched_at"] = now

    return payload





async def get_config_version(db: Session) -> str:

    payload = await build_form_config(db)

    return payload["version"]





def map_condition_grade(grade: str | None) -> int:

    if not grade:

        return 85

    return condition_grade_to_stuff_status(grade)


