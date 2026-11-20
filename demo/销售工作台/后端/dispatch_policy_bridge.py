"""本地演示的派单容量与销售侧脱敏规则。"""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
from typing import Any

FALLBACK_SQLITE = os.path.join(os.environ["SALES_RUNTIME_DIR"], "dispatch-demo.sqlite")


DDL = """
CREATE TABLE IF NOT EXISTS shop_dispatch_capacity_policies (
    id                      TEXT PRIMARY KEY,
    group_code              TEXT NOT NULL UNIQUE,
    group_name              TEXT NOT NULL,
    bound_shops_json        TEXT NOT NULL DEFAULT '[]',
    bound_shop_keys_json    TEXT NOT NULL DEFAULT '[]',
    soft_balance_cap_yuan   INTEGER NOT NULL DEFAULT 80000,
    hard_pause_cap_yuan     INTEGER NOT NULL DEFAULT 100000,
    current_month_used_yuan INTEGER NOT NULL DEFAULT 0,
    overflow_mode           TEXT NOT NULL DEFAULT 'pause_new_listings',
    enabled                 INTEGER NOT NULL DEFAULT 1,
    updated_by              TEXT NOT NULL DEFAULT 'admin_init',
    updated_at              TEXT NOT NULL DEFAULT '',
    notes                   TEXT NOT NULL DEFAULT ''
);
"""

SEED_ROWS = [
    ("dcp-grp-a", "GRP-A", "派单均衡组 A · 数码主力组", ["果果数码", "小满优选"], ["guoguo", "xiaoman"], 80000, 100000, 84600, "一次性后台预设：优先引导分配空闲店铺"),
    ("dcp-grp-b", "GRP-B", "派单均衡组 B · 电竞硬件组", ["周周二手", "泛亚电竞严选"], ["zhouzhou", "fanya_esport"], 80000, 100000, 61500, "一次性后台预设：正常排期接单"),
    ("dcp-grp-c", "GRP-C", "派单均衡组 C · 区域仓配组", ["杭城数码仓", "周北办公外设"], ["hangcheng", "zhoubei_per"], 80000, 100000, 49200, "一次性后台预设：空闲度充裕"),
    ("dcp-grp-d", "GRP-D", "派单均衡组 D · 卡券服务组", ["小满卡券严选", "（卡券号，演示）"], ["xy_xm", "voucher_demo"], 80000, 100000, 101200, "一次性后台预设：本月排期已满暂停派新"),
]


def _db_path() -> str:
    os.makedirs(os.path.dirname(FALLBACK_SQLITE), exist_ok=True)
    return FALLBACK_SQLITE


def _conn() -> sqlite3.Connection:
    con = sqlite3.connect(_db_path(), timeout=8.0)
    con.row_factory = sqlite3.Row
    con.executescript(DDL)
    cnt = con.execute("SELECT COUNT(*) FROM shop_dispatch_capacity_policies").fetchone()[0]
    if cnt == 0:
        now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for rid, code, name, shops, keys, soft, hard, used, notes in SEED_ROWS:
            con.execute(
                """INSERT INTO shop_dispatch_capacity_policies
                   (id, group_code, group_name, bound_shops_json, bound_shop_keys_json,
                    soft_balance_cap_yuan, hard_pause_cap_yuan, current_month_used_yuan,
                    overflow_mode, enabled, updated_by, updated_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    rid,
                    code,
                    name,
                    json.dumps(shops, ensure_ascii=False),
                    json.dumps(keys, ensure_ascii=False),
                    soft,
                    hard,
                    used,
                    "pause_new_listings",
                    1,
                    "admin_init",
                    now_s,
                    notes,
                ),
            )
        con.commit()
    return con


def _eval_state(d: dict[str, Any]) -> dict[str, str]:
    enabled = bool(int(d.get("enabled", 1) or 0))
    soft = max(1, int(d.get("soft_balance_cap_yuan") or 80000))
    hard = max(soft, int(d.get("hard_pause_cap_yuan") or 100000))
    used = max(0, int(d.get("current_month_used_yuan") or 0))
    if not enabled:
        return {
            "state": "grn",
            "dispatch_state": "available",
            "dispatch_badge": "正常接单",
            "dispatch_hint": "当前排期充裕，可正常分配上架",
        }
    if used >= hard:
        return {
            "state": "red",
            "dispatch_state": "schedule_full",
            "dispatch_badge": "本月排期已满 · 暂停派新",
            "dispatch_hint": "该组本月排期已满，新商品请分配至空闲店铺",
        }
    if used >= soft:
        return {
            "state": "amb",
            "dispatch_state": "prefer_idle",
            "dispatch_badge": "负荷偏高 · 优先派空闲号",
            "dispatch_hint": "当前店铺近期排期较密，建议优先分配空闲店铺",
        }
    return {
        "state": "grn",
        "dispatch_state": "available",
        "dispatch_badge": "正常接单",
        "dispatch_hint": "当前排期充裕，可正常分配上架",
    }


def get_admin_dispatch_policies() -> list[dict[str, Any]]:
    """仅限 ADMIN 调用：返回完整一次性容量上限配置。"""
    con = _conn()
    try:
        rows = con.execute("SELECT * FROM shop_dispatch_capacity_policies ORDER BY group_code ASC").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["bound_shops"] = json.loads(d.get("bound_shops_json") or "[]")
            d["bound_shop_keys"] = json.loads(d.get("bound_shop_keys_json") or "[]")
            d["enabled"] = bool(int(d.get("enabled", 1) or 0))
            d.update(_eval_state(d))
            out.append(d)
        return out
    finally:
        con.close()


def save_admin_dispatch_policies(items: list[dict[str, Any]], updated_by: str = "admin") -> list[dict[str, Any]]:
    """仅限 ADMIN 调用：持久化保存一次性容量上限配置，同步回写 5370 主台账。"""
    con = _conn()
    try:
        now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for raw in items:
            rid = str(raw.get("id") or "").strip()
            gcode = str(raw.get("group_code") or "").strip()
            existing = None
            if rid:
                existing = con.execute("SELECT * FROM shop_dispatch_capacity_policies WHERE id=?", (rid,)).fetchone()
            if not existing and gcode:
                existing = con.execute("SELECT * FROM shop_dispatch_capacity_policies WHERE group_code=?", (gcode,)).fetchone()
            if not existing:
                continue
            soft = max(1000, int(float(raw.get("soft_balance_cap_yuan") or existing["soft_balance_cap_yuan"])))
            hard = max(soft, int(float(raw.get("hard_pause_cap_yuan") or existing["hard_pause_cap_yuan"])))
            used = max(0, int(float(raw.get("current_month_used_yuan") if raw.get("current_month_used_yuan") is not None else existing["current_month_used_yuan"])))
            enabled = 1 if raw.get("enabled", True) else 0
            gname = str(raw.get("group_name") or existing["group_name"]).strip()
            shops = raw.get("bound_shops")
            if isinstance(shops, str):
                shops = [s.strip() for s in shops.replace("，", ",").split(",") if s.strip()]
            elif not isinstance(shops, list):
                shops = json.loads(existing["bound_shops_json"] or "[]")
            notes = str(raw.get("notes") if raw.get("notes") is not None else existing["notes"]).strip()
            con.execute(
                """UPDATE shop_dispatch_capacity_policies
                   SET group_name=?, bound_shops_json=?, soft_balance_cap_yuan=?,
                       hard_pause_cap_yuan=?, current_month_used_yuan=?, enabled=?,
                       updated_by=?, updated_at=?, notes=?
                   WHERE id=?""",
                (gname, json.dumps(shops, ensure_ascii=False), soft, hard, used, enabled, updated_by, now_s, notes, existing["id"]),
            )
        con.commit()
    finally:
        con.close()
    return get_admin_dispatch_policies()


def get_public_dispatch_groups() -> list[dict[str, Any]]:
    """销售端全脱敏视图：严禁下发任何金额、百分比或税务字样，仅输出中性派单均衡状态。"""
    rows = get_admin_dispatch_policies()
    return [
        {
            "id": r["group_code"],
            "name": r["group_name"],
            "shops": r["bound_shops"],
            "state": r["state"],
            "dispatch_state": r["dispatch_state"],
            "badge": r["dispatch_badge"],
            "hint": r["dispatch_hint"],
        }
        for r in rows
    ]


def get_shop_dispatch_status(shop_label_or_key: str) -> dict[str, Any]:
    """按店铺名或 shop_key 查询脱敏派单状态。"""
    target = (shop_label_or_key or "").strip()
    for r in get_admin_dispatch_policies():
        if target in (r.get("bound_shops") or []) or target in (r.get("bound_shop_keys") or []):
            return {
                "group_code": r["group_code"],
                "group_name": r["group_name"],
                "state": r["state"],
                "dispatch_state": r["dispatch_state"],
                "dispatch_badge": r["dispatch_badge"],
                "dispatch_hint": r["dispatch_hint"],
            }
    return {
        "group_code": "GRP-DEFAULT",
        "group_name": "常规派单组",
        "state": "grn",
        "dispatch_state": "available",
        "dispatch_badge": "正常接单",
        "dispatch_hint": "当前排期充裕，可正常分配上架",
    }
