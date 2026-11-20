#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
店铺分组月度派单容量与负荷均衡一次性静默配置模块
- 仅面向最高管理端开放读写接口；
- 面向业务执行端（销售工作台）仅输出脱敏后的派单可用态：
  available（正常接单） / prefer_idle（优先派空闲店） / schedule_full（本月排期已满·暂停派新）。
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from typing import Any


DDL_DISPATCH_CAPACITY = """
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
    updated_by              TEXT NOT NULL DEFAULT 'boss_init',
    updated_at              TEXT NOT NULL DEFAULT '',
    notes                   TEXT NOT NULL DEFAULT ''
);
"""


DEFAULT_POLICIES: list[dict[str, Any]] = [
    {
        'id': f'dcp-grp-{key.lower()}',
        'group_code': f'GRP-{key}',
        'group_name': f'演示派单组 {key}',
        'bound_shops': [f'演示店铺 {key}'],
        'bound_shop_keys': [f'demo_shop_{key.lower()}'],
        'soft_balance_cap_yuan': 80000,
        'hard_pause_cap_yuan': 100000,
        'current_month_used_yuan': amount,
        'overflow_mode': 'pause_new_listings',
        'enabled': 1,
        'notes': '合成派单占用示例',
    }
    for key, amount in [('A', 85000), ('B', 55000), ('C', 45000), ('D', 110000)]
]

def compute_dispatch_state(row: dict[str, Any]) -> dict[str, Any]:
    enabled = bool(int(row.get("enabled", 1) or 0))
    soft = max(1, int(row.get("soft_balance_cap_yuan") or 80000))
    hard = max(soft, int(row.get("hard_pause_cap_yuan") or 100000))
    used = max(0, int(row.get("current_month_used_yuan") or 0))
    if not enabled:
        return {
            "dispatch_state": "available",
            "dispatch_badge": "正常接单",
            "dispatch_tone": "grn",
            "dispatch_hint": "当前可正常分配上架任务",
        }
    if used >= hard:
        return {
            "dispatch_state": "schedule_full",
            "dispatch_badge": "本月排期已满 · 暂停派新",
            "dispatch_tone": "red",
            "dispatch_hint": "该组本月排期已满，新商品请分配至空闲店铺",
        }
    if used >= soft:
        return {
            "dispatch_state": "prefer_idle",
            "dispatch_badge": "负荷偏高 · 优先派空闲号",
            "dispatch_tone": "amb",
            "dispatch_hint": "当前店铺近期排期较密，建议优先分配至空闲店铺",
        }
    return {
        "dispatch_state": "available",
        "dispatch_badge": "正常接单",
        "dispatch_tone": "grn",
        "dispatch_hint": "当前排期充裕，可正常上架",
    }


def ensure_dispatch_capacity_seeded(conn: sqlite3.Connection) -> None:
    conn.executescript(DDL_DISPATCH_CAPACITY)
    cnt = conn.execute("SELECT COUNT(*) FROM shop_dispatch_capacity_policies").fetchone()[0]
    if cnt > 0:
        return
    now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for item in DEFAULT_POLICIES:
        conn.execute(
            """INSERT INTO shop_dispatch_capacity_policies
               (id, group_code, group_name, bound_shops_json, bound_shop_keys_json,
                soft_balance_cap_yuan, hard_pause_cap_yuan, current_month_used_yuan,
                overflow_mode, enabled, updated_by, updated_at, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                item["id"],
                item["group_code"],
                item["group_name"],
                json.dumps(item["bound_shops"], ensure_ascii=False),
                json.dumps(item["bound_shop_keys"], ensure_ascii=False),
                int(item["soft_balance_cap_yuan"]),
                int(item["hard_pause_cap_yuan"]),
                int(item["current_month_used_yuan"]),
                item["overflow_mode"],
                int(item["enabled"]),
                "boss_init",
                now_s,
                item["notes"],
            ),
        )
    conn.commit()


def list_dispatch_capacity_policies(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    ensure_dispatch_capacity_seeded(conn)
    rows = conn.execute(
        "SELECT * FROM shop_dispatch_capacity_policies ORDER BY group_code ASC"
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        d["bound_shops"] = json.loads(d.get("bound_shops_json") or "[]")
        d["bound_shop_keys"] = json.loads(d.get("bound_shop_keys_json") or "[]")
        d["enabled"] = bool(int(d.get("enabled", 1) or 0))
        d.update(compute_dispatch_state(d))
        out.append(d)
    return out


def save_dispatch_capacity_policies(
    conn: sqlite3.Connection, items: list[dict[str, Any]], updated_by: str = "boss"
) -> list[dict[str, Any]]:
    ensure_dispatch_capacity_seeded(conn)
    now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for raw in items:
        rec_id = str(raw.get("id") or "").strip()
        gcode = str(raw.get("group_code") or "").strip()
        if not rec_id and not gcode:
            continue
        existing = None
        if rec_id:
            existing = conn.execute(
                "SELECT * FROM shop_dispatch_capacity_policies WHERE id = ?", (rec_id,)
            ).fetchone()
        if not existing and gcode:
            existing = conn.execute(
                "SELECT * FROM shop_dispatch_capacity_policies WHERE group_code = ?", (gcode,)
            ).fetchone()
        soft = max(1000, int(float(raw.get("soft_balance_cap_yuan") or 80000)))
        hard = max(soft, int(float(raw.get("hard_pause_cap_yuan") or 100000)))
        used = max(0, int(float(raw.get("current_month_used_yuan") if raw.get("current_month_used_yuan") is not None else (existing["current_month_used_yuan"] if existing else 0))))
        enabled = 1 if raw.get("enabled", True) else 0
        gname = str(raw.get("group_name") or (existing["group_name"] if existing else gcode)).strip()
        overflow = str(raw.get("overflow_mode") or (existing["overflow_mode"] if existing else "pause_new_listings")).strip()
        notes = str(raw.get("notes") if raw.get("notes") is not None else (existing["notes"] if existing else "")).strip()
        shops = raw.get("bound_shops")
        if isinstance(shops, str):
            shops = [s.strip() for s in shops.replace("，", ",").split(",") if s.strip()]
        elif not isinstance(shops, list):
            shops = json.loads(existing["bound_shops_json"]) if existing else []
        shop_keys = raw.get("bound_shop_keys")
        if isinstance(shop_keys, str):
            shop_keys = [s.strip() for s in shop_keys.replace("，", ",").split(",") if s.strip()]
        elif not isinstance(shop_keys, list):
            shop_keys = json.loads(existing["bound_shop_keys_json"]) if existing else []

        if existing:
            conn.execute(
                """UPDATE shop_dispatch_capacity_policies
                   SET group_name=?, bound_shops_json=?, bound_shop_keys_json=?,
                       soft_balance_cap_yuan=?, hard_pause_cap_yuan=?, current_month_used_yuan=?,
                       overflow_mode=?, enabled=?, updated_by=?, updated_at=?, notes=?
                   WHERE id=?""",
                (
                    gname,
                    json.dumps(shops, ensure_ascii=False),
                    json.dumps(shop_keys, ensure_ascii=False),
                    soft,
                    hard,
                    used,
                    overflow,
                    enabled,
                    updated_by,
                    now_s,
                    notes,
                    existing["id"],
                ),
            )
        else:
            new_id = rec_id or f"dcp-{gcode.lower()}"
            conn.execute(
                """INSERT INTO shop_dispatch_capacity_policies
                   (id, group_code, group_name, bound_shops_json, bound_shop_keys_json,
                    soft_balance_cap_yuan, hard_pause_cap_yuan, current_month_used_yuan,
                    overflow_mode, enabled, updated_by, updated_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    new_id,
                    gcode or new_id,
                    gname or new_id,
                    json.dumps(shops, ensure_ascii=False),
                    json.dumps(shop_keys, ensure_ascii=False),
                    soft,
                    hard,
                    used,
                    overflow,
                    enabled,
                    updated_by,
                    now_s,
                    notes,
                ),
            )
    conn.commit()
    return list_dispatch_capacity_policies(conn)
