#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
销售工作台 · 虚拟外部情报、在售 Gallery、同题赛马与盈利门禁 API 模块 (2026-11-24)
零第三方依赖：SQLite WAL + 直接复用 virtIntelSeed.json 同源真实种子数据。
挂载于 h5_server.py (/api/virt-intel/*)。
"""
from __future__ import annotations

import datetime
import json
import os
import sqlite3
import threading
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_PATH = next(
    (
        os.path.join(HERE, d, "src", "virtIntelSeed.json")
        for d in ("源码", "前端")
        if os.path.exists(os.path.join(HERE, d, "src", "virtIntelSeed.json"))
    ),
    os.path.join(HERE, "源码", "src", "virtIntelSeed.json"),
)
SEED_VERSION = "V6-VirtIntel-20261124.1"
RUNTIME_DIR = os.environ.get(
    "CS_RUNTIME_DIR",
    os.path.expanduser("~/Library/Caches/panasia-gallery-stitch-20261113"),
)
os.makedirs(RUNTIME_DIR, exist_ok=True)
DB_PATH = os.path.join(RUNTIME_DIR, "virt_intel.sqlite")
DB_LOCK = threading.Lock()


def _load_seed() -> dict:
    with open(SEED_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    for ddl in (
        "CREATE TABLE IF NOT EXISTS intel_meta (key TEXT PRIMARY KEY, val TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS intel_clues (id TEXT PRIMARY KEY, sort_idx INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS intel_listings (id TEXT PRIMARY KEY, sort_idx INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS intel_channels (id TEXT PRIMARY KEY, sort_idx INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS intel_races (id TEXT PRIMARY KEY, sort_idx INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS intel_directions (id TEXT PRIMARY KEY, sort_idx INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS intel_cards (id TEXT PRIMARY KEY, sort_idx INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);",
        """CREATE TABLE IF NOT EXISTS intel_audit_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            target_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            actor TEXT NOT NULL,
            created_at TEXT NOT NULL
        );""",
    ):
        conn.execute(ddl)
    return conn


CONN = _connect()


def _seed_if_needed(conn: sqlite3.Connection, force: bool = False) -> None:
    row = conn.execute("SELECT val FROM intel_meta WHERE key='seed_version'").fetchone()
    if not force and row and row[0] == SEED_VERSION:
        return
    seed = _load_seed()
    now = _now()
    for tbl in (
        "intel_clues",
        "intel_listings",
        "intel_channels",
        "intel_races",
        "intel_directions",
        "intel_cards",
    ):
        conn.execute(f"DELETE FROM {tbl}")
    table_items = [
        ("intel_clues", "id", seed.get("clues", [])),
        ("intel_listings", "id", seed.get("listings", [])),
        ("intel_channels", "id", seed.get("channels", [])),
        ("intel_races", "id", seed.get("races", [])),
        ("intel_directions", "directionId", seed.get("directionRaces", [])),
        ("intel_cards", "cardId", seed.get("productCards", [])),
    ]
    for tbl, key_field, items in table_items:
        for idx, item in enumerate(items, 1):
            conn.execute(
                f"INSERT INTO {tbl} (id, sort_idx, payload, updated_at) VALUES (?, ?, ?, ?)",
                (str(item[key_field]), idx, json.dumps(item, ensure_ascii=False), now),
            )
    conn.execute(
        "INSERT INTO intel_meta (key, val) VALUES ('thresholds', ?) ON CONFLICT(key) DO UPDATE SET val=excluded.val",
        (json.dumps(seed.get("thresholds", {}), ensure_ascii=False),),
    )
    conn.execute(
        "INSERT INTO intel_meta (key, val) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET val=excluded.val",
        (SEED_VERSION,),
    )
    if force or conn.execute("SELECT COUNT(*) FROM intel_audit_log").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO intel_audit_log (action, target_id, summary, actor, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                "seed_init",
                SEED_VERSION,
                f"初始化虚拟外部情报真样本库（{len(seed.get('listings', []))} 条在售样本 · {len(seed.get('clues', []))} 条线索 · QQ 游标至 {seed['meta']['qqCutoff']}）",
                "system",
                now,
            ),
        )
    conn.commit()


with DB_LOCK:
    _seed_if_needed(CONN, force=False)


def _json_resp(code: int, obj: dict) -> tuple[int, str, bytes]:
    return code, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _all_rows(conn: sqlite3.Connection, tbl: str) -> list[dict]:
    return [json.loads(r[0]) for r in conn.execute(f"SELECT payload FROM {tbl} ORDER BY sort_idx ASC").fetchall()]


def _get_thresholds(conn: sqlite3.Connection) -> dict:
    row = conn.execute("SELECT val FROM intel_meta WHERE key='thresholds'").fetchone()
    return json.loads(row[0]) if row else _load_seed().get("thresholds", {})


def _log_audit(conn: sqlite3.Connection, action: str, target_id: str, summary: str, actor: str) -> None:
    conn.execute(
        "INSERT INTO intel_audit_log (action, target_id, summary, actor, created_at) VALUES (?, ?, ?, ?, ?)",
        (action, target_id, summary, actor, _now()),
    )


def _bootstrap_payload(conn: sqlite3.Connection) -> dict:
    seed = _load_seed()
    audits = [
        {"seq": r[0], "action": r[1], "targetId": r[2], "summary": r[3], "actor": r[4], "createdAt": r[5]}
        for r in conn.execute("SELECT seq, action, target_id, summary, actor, created_at FROM intel_audit_log ORDER BY seq DESC LIMIT 30").fetchall()
    ]
    return {
        "ok": True,
        "meta": seed.get("meta", {}),
        "thresholds": _get_thresholds(conn),
        "businessTree": seed.get("businessTree", []),
        "sourceTree": seed.get("sourceTree", {}),
        "peers": seed.get("peers", []),
        "sellers": seed.get("sellers", []),
        "clues": _all_rows(conn, "intel_clues"),
        "listings": _all_rows(conn, "intel_listings"),
        "channels": _all_rows(conn, "intel_channels"),
        "races": _all_rows(conn, "intel_races"),
        "directionRaces": _all_rows(conn, "intel_directions"),
        "productCards": _all_rows(conn, "intel_cards"),
        "auditLog": audits,
    }


def _calc_economics(price: float, direct_cost: float, fee_rate: float, labor_hours: float, hourly_rate: float) -> dict:
    fee = price * fee_rate
    labor_cost = labor_hours * hourly_rate
    net = price - fee - direct_cost - labor_cost
    margin = (net / price * 100.0) if price > 0 else -100.0
    roi = (net / labor_hours) if labor_hours > 0 else net * 50.0
    return {
        "fee": round(fee, 2),
        "laborCost": round(labor_cost, 2),
        "netProfit": round(net, 2),
        "marginPct": round(margin, 1),
        "roiPerHour": round(roi, 1),
    }


def handle_virt_intel_request(method: str, raw_path: str, headers, body_bytes: bytes = b"") -> tuple[int, str, bytes] | None:
    parsed = urlparse(raw_path)
    path = unquote(parsed.path)
    if not path.startswith("/api/virt-intel/"):
        return None
    params = parse_qs(parsed.query)
    actor = (params.get("actor") or [headers.get("X-ERP-Actor") if headers else None] or ["chenxm"])[0] or "chenxm"

    if method == "GET" and path == "/api/virt-intel/bootstrap":
        with DB_LOCK:
            return _json_resp(200, _bootstrap_payload(CONN))

    if method not in ("POST", "PATCH"):
        return _json_resp(405, {"ok": False, "error": "Method not allowed"})

    try:
        body = json.loads((body_bytes or b"{}").decode("utf-8"))
    except Exception:
        return _json_resp(400, {"ok": False, "error": "Invalid JSON body"})
    actor = str(body.get("actor") or actor or "chenxm")

    if path == "/api/virt-intel/reset":
        with DB_LOCK:
            CONN.execute("DELETE FROM intel_audit_log")
            _seed_if_needed(CONN, force=True)
            return _json_resp(200, _bootstrap_payload(CONN))

    if path == "/api/virt-intel/thresholds":
        with DB_LOCK:
            cur = _get_thresholds(CONN)
            for k in ("followTrackFastPass", "roadTestRequireDualRepro", "minMarginPct", "warnRefundPct", "haltRefundPct", "hourlyLaborCost"):
                if k in body and body[k] is not None:
                    cur[k] = body[k]
            CONN.execute(
                "INSERT INTO intel_meta (key, val) VALUES ('thresholds', ?) ON CONFLICT(key) DO UPDATE SET val=excluded.val",
                (json.dumps(cur, ensure_ascii=False),),
            )
            _log_audit(CONN, "update_thresholds", "thresholds", f"更新盈利门禁阈值：最低毛利 {cur.get('minMarginPct')}% · 退款预警 {cur.get('warnRefundPct')}% · 自动停售 {cur.get('haltRefundPct')}%", actor)
            CONN.commit()
            return _json_resp(200, {"ok": True, "thresholds": cur})

    if path == "/api/virt-intel/clue":
        title = str(body.get("title") or "").strip()
        src = str(body.get("sourceUrl") or body.get("messageRef") or "").strip()
        if not title or not src:
            return _json_resp(400, {"ok": False, "error": "线索标题与原链接/消息定位至少填两项，禁止录入无出处传闻。"})
        level = str(body.get("evidenceLevel") or "self_claimed")
        lvl_map = {"verified": "已核实测/挂牌", "group_log": "群原始记录", "self_claimed": "博主自述·待核"}
        node_id = str(body.get("nodeId") or "pending-triage")
        cid = f"CLUE-NEW-{int(datetime.datetime.now().timestamp())}"
        item = {
            "id": cid,
            "nodeId": node_id,
            "platform": str(body.get("platform") or "Web"),
            "platformLabel": str(body.get("platformLabel") or body.get("platform") or "外部渠道"),
            "title": title,
            "author": str(body.get("author") or actor),
            "date": _now()[:16],
            "evidenceLevel": level,
            "evidenceLabel": lvl_map.get(level, "待核线索"),
            "status": "待补证入池" if level == "self_claimed" else "已核待赛马",
            "messageRef": str(body.get("messageRef") or f"custom://{cid}"),
            "sourceUrl": str(body.get("sourceUrl") or ""),
            "image": "virt-intel-thumbs/ai-ecom-workflow.png" if node_id == "ecom-photo" else "virt-intel-thumbs/cad-ceiling-pdf.png",
            "summary": str(body.get("summary") or title),
            "reusableMethod": str(body.get("reusableMethod") or "待运营拆解输入、成本与同行可比商品组。"),
            "openQuestions": str(body.get("openQuestions") or "待核可比价格带与实测步骤。"),
            "attachedFiles": [],
            "linkedListingIds": [],
        }
        with DB_LOCK:
            mn = CONN.execute("SELECT COALESCE(MIN(sort_idx), 1) FROM intel_clues").fetchone()[0]
            CONN.execute(
                "INSERT INTO intel_clues (id, sort_idx, payload, updated_at) VALUES (?, ?, ?, ?)",
                (cid, mn - 1, json.dumps(item, ensure_ascii=False), _now()),
            )
            # Re-normalize sort order so new clue sits at front
            _log_audit(CONN, "add_clue", cid, f"登记外部线索《{title[:28]}》归属节点 {node_id}", actor)
            CONN.commit()
            return _json_resp(200, {"ok": True, "clue": item, "clues": _all_rows(CONN, "intel_clues")})

    if path == "/api/virt-intel/listing/status":
        lid = str(body.get("id") or "").strip()
        new_status = str(body.get("status") or "").strip()
        if not lid or not new_status:
            return _json_resp(400, {"ok": False, "error": "缺少商品 ID 或目标状态"})
        with DB_LOCK:
            row = CONN.execute("SELECT payload FROM intel_listings WHERE id=?", (lid,)).fetchone()
            if not row:
                return _json_resp(404, {"ok": False, "error": f"未找到在售记录 {lid}"})
            obj = json.loads(row[0])
            old_status = obj.get("status", "")
            obj["status"] = new_status
            if body.get("priceText"):
                obj["priceText"] = str(body["priceText"])
            obs = obj.get("observations") or []
            obs.insert(
                0,
                {
                    "time": _now(),
                    "price": obj.get("priceText", ""),
                    "status": f"{new_status}（由 {old_status} 切换 · 保留历史证据）",
                    "source": str(body.get("note") or "工作台巡航复核更新"),
                },
            )
            obj["observations"] = obs[:12]
            CONN.execute(
                "UPDATE intel_listings SET payload=?, updated_at=? WHERE id=?",
                (json.dumps(obj, ensure_ascii=False), _now(), lid),
            )
            _log_audit(CONN, "listing_status", lid, f"商品 {lid} 状态由「{old_status}」更新为「{new_status}」，历史快照已保留", actor)
            CONN.commit()
            return _json_resp(200, {"ok": True, "listing": obj, "listings": _all_rows(CONN, "intel_listings")})

    if path == "/api/virt-intel/channel/backfill":
        chid = str(body.get("id") or "").strip()
        mode = str(body.get("mode") or "tick")
        with DB_LOCK:
            row = CONN.execute("SELECT payload FROM intel_channels WHERE id=?", (chid,)).fetchone()
            if not row:
                return _json_resp(404, {"ok": False, "error": f"未找到渠道 {chid}"})
            ch = json.loads(row[0])
            now = _now()
            if mode == "simulate_gap":
                ch["cursorState"] = "断线待补拉（缺口已标记，未漏报成零新增）"
                ch["cursorColor"] = "red"
                ch["backfillNote"] = f"{now} 检测到采集机短暂离线，请点击一键补拉从最后游标恢复。"
                msg = f"渠道 {ch['name']} 标记断线缺口"
            else:
                ch["lastCutoff"] = now.replace(" ", "T") + "Z"
                ch["lastAdded"] = int(ch.get("lastAdded") or 0) + 6
                ch["totalMessages"] = int(ch.get("totalMessages") or 0) + 6
                ch["cursorState"] = "正常增量（已从上次成功游标补拉完成 +6 条）"
                ch["cursorColor"] = "grn"
                ch["backfillNote"] = f"{now} 增量拉取并去重落库完成，游标已推进。"
                msg = f"渠道 {ch['name']} 从游标完成断点补拉 +6 条"
            CONN.execute(
                "UPDATE intel_channels SET payload=?, updated_at=? WHERE id=?",
                (json.dumps(ch, ensure_ascii=False), now, chid),
            )
            _log_audit(CONN, "channel_backfill", chid, msg, actor)
            CONN.commit()
            return _json_resp(200, {"ok": True, "channel": ch, "channels": _all_rows(CONN, "intel_channels")})

    if path == "/api/virt-intel/race/select-winner":
        with DB_LOCK:
            th = _get_thresholds(CONN)
            track = str(body.get("trackType") or "跟卖型")
            repro_ok = bool(body.get("reproConfirmed", track == "跟卖型"))
            if track == "路测型" and th.get("roadTestRequireDualRepro", True) and not repro_ok:
                return _json_resp(
                    400,
                    {"ok": False, "error": "双轨门禁拦截：路测型自研品必须完成「小额实测 + 第二人独立复现」勾选后才准生成正式产品卡。"},
                )
            price = float(body.get("price") or 0)
            dcost = float(body.get("directCost") or 0)
            frate = float(body.get("platformFeeRate") or 0.01)
            lhours = float(body.get("laborHours") or 0.1)
            econ = _calc_economics(price, dcost, frate, lhours, float(th.get("hourlyLaborCost") or 50))
            low_margin = econ["marginPct"] < float(th.get("minMarginPct") or 30) or econ["netProfit"] <= 0
            status = "黄灯预警（毛利未达 30% 基准）" if low_margin else "已上架盈利中"
            cid = str(body.get("cardId") or f"VP-RACE-{int(datetime.datetime.now().timestamp())}")
            card = {
                "cardId": cid,
                "nodeId": str(body.get("nodeId") or "cad-trace"),
                "title": str(body.get("title") or "赛马转正虚拟产品卡"),
                "trackType": track,
                "raceId": str(body.get("raceId") or ""),
                "winningPlan": str(body.get("winningPlan") or "赛马优胜方案 + Codex Skill"),
                "price": price,
                "directCost": dcost,
                "platformFeeRate": frate,
                "laborHours": lhours,
                "laborCost": econ["laborCost"],
                "netProfit": econ["netProfit"],
                "marginPct": econ["marginPct"],
                "refundRatePct": float(body.get("refundRatePct") or 2.0),
                "status": status,
                "skillName": str(body.get("skillName") or "sales-verified-workflow"),
                "tutorialNodeId": str(body.get("tutorialNodeId") or "SALES-VIRT-INTEL-08"),
                "customerInputs": body.get("customerInputs") or ["脱敏客户原件", "明确规格要求"],
                "stopBoundary": str(body.get("stopBoundary") or "超出 Skill 范围或缺失前置材料时触发人工兜底。"),
                "updatedAt": _now()[:16],
            }
            exists = CONN.execute("SELECT 1 FROM intel_cards WHERE id=?", (cid,)).fetchone()
            if exists:
                CONN.execute("UPDATE intel_cards SET payload=?, updated_at=? WHERE id=?", (json.dumps(card, ensure_ascii=False), _now(), cid))
            else:
                CONN.execute("INSERT INTO intel_cards (id, sort_idx, payload, updated_at) VALUES (?, 0, ?, ?)", (cid, json.dumps(card, ensure_ascii=False), _now()))
            _log_audit(CONN, "promote_card", cid, f"赛马转正生成产品卡《{card['title'][:22]}》净毛利 {econ['marginPct']}% ({status})", actor)
            CONN.commit()
            return _json_resp(200, {"ok": True, "card": card, "productCards": _all_rows(CONN, "intel_cards"), "lowMarginWarning": low_margin})

    if path == "/api/virt-intel/feedback":
        did = str(body.get("directionId") or "").strip()
        new_refund = body.get("refundRatePct")
        with DB_LOCK:
            th = _get_thresholds(CONN)
            row = CONN.execute("SELECT payload FROM intel_directions WHERE id=?", (did,)).fetchone()
            if not row:
                return _json_resp(404, {"ok": False, "error": f"未找到产品方向 {did}"})
            d = json.loads(row[0])
            if new_refund is not None:
                d["refundRatePct"] = round(float(new_refund), 1)
            else:
                d["refundRatePct"] = round(float(d.get("refundRatePct") or 0) + 2.5, 1)
            halt = float(th.get("haltRefundPct") or 8)
            warn = float(th.get("warnRefundPct") or 5)
            d["marginPct"] = float(d.get("marginPct") or 0)
            if d["refundRatePct"] >= halt:
                d["strategy"] = f"已熔断停售（退款 {d['refundRatePct']}% ≥ {halt:g}%）"
                d["strategyTone"] = "red"
                d["note"] = "售后回传退款率突破自动停售红线，已自动冻结该方向下关联产品卡并要求复赛。"
                for r in CONN.execute("SELECT id, payload FROM intel_cards").fetchall():
                    c = json.loads(r[1])
                    if c.get("nodeId") == d.get("nodeId"):
                        c["refundRatePct"] = d["refundRatePct"]
                        c["status"] = f"已熔断停售（退款≥{halt:g}%）"
                        CONN.execute("UPDATE intel_cards SET payload=?, updated_at=? WHERE id=?", (json.dumps(c, ensure_ascii=False), _now(), r[0]))
            elif d["refundRatePct"] >= warn:
                d["strategy"] = f"黄灯预警（退款 {d['refundRatePct']}% ≥ {warn:g}%）"
                d["strategyTone"] = "amb"
                d["note"] = "退款率触发预警阈值，请补充买家拍前材料清单并检查 Skill 边界。"
            else:
                d["strategy"] = "主力扩量"
                d["strategyTone"] = "grn"
            CONN.execute("UPDATE intel_directions SET payload=?, updated_at=? WHERE id=?", (json.dumps(d, ensure_ascii=False), _now(), did))
            _log_audit(CONN, "feedback_refund", did, f"售后回传更新 {d['name'][:18]} 退款率为 {d['refundRatePct']}% → {d['strategy']}", actor)
            CONN.commit()
            return _json_resp(200, {"ok": True, "direction": d, "directionRaces": _all_rows(CONN, "intel_directions"), "productCards": _all_rows(CONN, "intel_cards")})

    return _json_resp(404, {"ok": False, "error": "Unknown /api/virt-intel endpoint"})
