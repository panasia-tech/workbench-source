#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
锚点中控 V3 · 全工作台组织与制度基建缺口治理引擎（Wiki / 培训视频 / KPI 口径 / OKR 目标）
设计原则：
1. 与「法人/执照/支付宝/号卡/密码」硬资产线在数据库表与前端 UI 分区上彻底解耦，绝不混表杂糅；
2. 只管「缺口槽位注册、责任指派、结构化 KPI/OKR 口径锁死、钉钉/飞书 Wiki 与视频链接回填、总经办初审与老板终审闭环」，不重造富文本长文档或网盘；
3. 支持绑定具体教程步骤编码（如 C10 / S08）：一旦培训视频或 Wiki 经老板终审变为 published，对应工作台/开店向导里的「待录/待补」自动实时点亮！
"""

from __future__ import annotations
import datetime as dt
import json
import sqlite3


WORKBENCH_META = {
    "sales": {"label": "💼 销售工作台（含虚拟产品&服务页）", "supervisor": "演示销售主管", "order": 1},
    "cs": {"label": "🎧 客服工作台（售前接待&小法庭举证）", "supervisor": "演示客服主管", "order": 2},
    "procurement": {"label": "🛒 采购工作台（买券团购&3C货源）", "supervisor": "演示采购主管", "order": 3},
    "warehouse": {"label": "📦 仓管工作台（3C质检分级&出入库）", "supervisor": "演示仓管主管", "order": 4},
    "account_ops": {"label": "🏪 账号与开店中控台（矩阵建店&防关联）", "supervisor": "演示开店主管", "order": 5},
    "gm_office": {"label": "🏛 总经办全司治理（跨部门制度&离职安全）", "supervisor": "演示总经办", "order": 6},
}

GOV_ITEM_TYPE_LABELS = {
    "wiki": "📖 Wiki / SOP文档",
    "video": "🎬 实操培训视频",
    "kpi": "🎯 岗位 KPI 口径",
    "okr": "🧭 季度 OKR 目标",
}

GOVERNANCE_DDL = """
-- 1. 六大工作台软基建应有配额目标表（用于自动倒推各工作台 Wiki / 视频 / KPI / OKR 净缺口与完备率）
CREATE TABLE IF NOT EXISTS workbench_governance_targets (
    workbench_key TEXT PRIMARY KEY,
    workbench_label TEXT NOT NULL,
    lead_staff TEXT NOT NULL,
    target_wiki INTEGER NOT NULL DEFAULT 4,
    target_video INTEGER NOT NULL DEFAULT 4,
    target_kpi INTEGER NOT NULL DEFAULT 3,
    target_okr INTEGER NOT NULL DEFAULT 2,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 2. 全工作台 Wiki / 培训视频 / KPI / OKR 缺口槽位与生效标准主表
CREATE TABLE IF NOT EXISTS governance_gap_items (
    id TEXT PRIMARY KEY,
    slot_code TEXT NOT NULL UNIQUE,
    workbench_key TEXT NOT NULL REFERENCES workbench_governance_targets(workbench_key) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('wiki', 'video', 'kpi', 'okr')),
    title TEXT NOT NULL,
    owner_dept TEXT NOT NULL DEFAULT '总经办',
    assignee_staff TEXT NOT NULL DEFAULT '演示总经办',
    priority TEXT NOT NULL DEFAULT 'high' CHECK (priority IN ('critical', 'high', 'normal')),
    status TEXT NOT NULL DEFAULT 'missing'
        CHECK (status IN ('missing', 'draft', 'pending_gm', 'pending_boss', 'published', 'rejected')),
    due_date TEXT NOT NULL DEFAULT '2026-11-25',
    -- 若关联到具体页面或开店教程步骤（如 C10 / S08），老板终审通过后自动点亮对应步骤的 video_url / wiki_url！
    bound_step_code TEXT NOT NULL DEFAULT '',
    page_anchor_note TEXT NOT NULL DEFAULT '',
    -- 交付物核心元数据（链接索引 + 结构化考核公式，不存重富文本与视频二进制）
    resource_url TEXT NOT NULL DEFAULT '',
    video_duration TEXT NOT NULL DEFAULT '',
    summary_note TEXT NOT NULL DEFAULT '',
    kpi_formula TEXT NOT NULL DEFAULT '',
    kpi_data_source TEXT NOT NULL DEFAULT '',
    kpi_thresholds TEXT NOT NULL DEFAULT '',
    okr_kr_json TEXT NOT NULL DEFAULT '[]',
    current_version INTEGER NOT NULL DEFAULT 0,
    last_reject_reason TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_gov_items_wb_type ON governance_gap_items (workbench_key, item_type, status);
CREATE INDEX IF NOT EXISTS idx_gov_items_assignee ON governance_gap_items (assignee_staff, status);

-- 3. 缺口补齐多版本提审与审批历史表（Append-Only：总经办初审意见、老板驳回意见永久保留不覆盖！）
CREATE TABLE IF NOT EXISTS governance_item_submissions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES governance_gap_items(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL DEFAULT 1,
    submitted_by TEXT NOT NULL,
    submitted_role TEXT NOT NULL DEFAULT 'supervisor',
    submitted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('pending_gm', 'pending_boss', 'approved', 'rejected')),
    gm_reviewed_by TEXT NOT NULL DEFAULT '',
    gm_reviewed_at TEXT NOT NULL DEFAULT '',
    gm_note TEXT NOT NULL DEFAULT '',
    boss_reviewed_by TEXT NOT NULL DEFAULT '',
    boss_reviewed_at TEXT NOT NULL DEFAULT '',
    boss_note TEXT NOT NULL DEFAULT '',
    UNIQUE (item_id, version_no)
);
"""


def sync_published_governance_to_tutorial_steps(conn: sqlite3.Connection) -> None:
    """将已终审生效 (published) 且绑定了教程步骤码的培训视频/Wiki 自动同步点亮至 tutorial_steps"""
    rows = conn.execute(
        """SELECT item_type, bound_step_code, resource_url
           FROM governance_gap_items
           WHERE status = 'published' AND bound_step_code <> '' AND resource_url <> ''"""
    ).fetchall()
    for itype, scode, url in rows:
        if itype == "video":
            conn.execute("UPDATE tutorial_steps SET video_url = ? WHERE step_code = ?", (url, scode))
        elif itype == "wiki":
            conn.execute("UPDATE tutorial_steps SET wiki_url = ? WHERE step_code = ?", (url, scode))


def ensure_governance_seeded(conn: sqlite3.Connection) -> None:
    from demo_seed import insert

    conn.executescript(GOVERNANCE_DDL)
    if not conn.execute('SELECT 1 FROM workbench_governance_targets LIMIT 1').fetchone():
        today = str(dt.date.today())
        for workbench, meta in WORKBENCH_META.items():
            insert(conn, 'workbench_governance_targets', workbench_key=workbench, workbench_label=meta['label'],
                   lead_staff=meta['supervisor'], target_wiki=2, target_video=2, target_kpi=1, target_okr=1)
            for kind, status in [('wiki', 'published'), ('video', 'pending_gm'), ('kpi', 'pending_boss'), ('okr', 'rejected')]:
                gid = f'gov-demo-{workbench}-{kind}'
                insert(conn, 'governance_gap_items', id=gid, slot_code=gid.upper(), workbench_key=workbench,
                       item_type=kind, title=f"演示 {GOV_ITEM_TYPE_LABELS[kind]}", assignee_staff=meta['supervisor'], status=status,
                       current_version=1, due_date=today, bound_step_code='C10' if workbench == 'account_ops' and kind == 'video' else '',
                       resource_url=f'https://resources.example.invalid/{workbench}/{kind}' if kind in ('wiki', 'video') else '',
                       video_duration='02:00' if kind == 'video' else '', summary_note='合成提交示例',
                       kpi_formula='验收通过数 ÷ 提交数' if kind == 'kpi' else '',
                       kpi_data_source='离线演示提交记录' if kind == 'kpi' else '', kpi_thresholds='≥ 95%' if kind == 'kpi' else '',
                       okr_kr_json='["独立完成 2 次离线演练"]' if kind == 'okr' else '[]',
                       published_at=today if status == 'published' else '', last_reject_reason='需补合成验收记录' if status == 'rejected' else '')
                insert(conn, 'governance_item_submissions', id=f'sub-{gid}-1', item_id=gid, submitted_by=meta['supervisor'],
                       status='approved' if status == 'published' else status, payload_json='{"summary_note":"合成提交示例"}')
        insert(conn, 'governance_gap_items', id='gov-demo-account_ops-video-missing', slot_code='DEMO-VIDEO-MISSING',
               workbench_key='account_ops', item_type='video', title='待提交的录屏演示', assignee_staff='演示开店主管',
               status='missing', due_date=today, bound_step_code='D15')
    sync_published_governance_to_tutorial_steps(conn)
    conn.commit()

def get_governance_item_detail(conn: sqlite3.Connection, item_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM governance_gap_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["type_label"] = GOV_ITEM_TYPE_LABELS.get(d["item_type"], d["item_type"])
    d["workbench_label"] = WORKBENCH_META.get(d["workbench_key"], {}).get("label", d["workbench_key"])
    d["okr_krs"] = json.loads(d["okr_kr_json"] or "[]")
    subs = [dict(r) for r in conn.execute(
        "SELECT * FROM governance_item_submissions WHERE item_id = ? ORDER BY version_no DESC",
        (item_id,),
    ).fetchall()]
    for s in subs:
        s["payload"] = json.loads(s["payload_json"] or "{}")
    d["history"] = subs
    return d


def build_governance_overview(conn: sqlite3.Connection, viewer_role: str = "boss", viewer_staff: str = "") -> dict:
    ensure_governance_seeded(conn)
    cur = conn.cursor()
    targets = [dict(r) for r in cur.execute("SELECT * FROM workbench_governance_targets").fetchall()]
    targets.sort(key=lambda x: WORKBENCH_META.get(x["workbench_key"], {}).get("order", 99))

    all_items = [dict(r) for r in cur.execute("SELECT * FROM governance_gap_items ORDER BY workbench_key, item_type, id").fetchall()]
    subs_by_item: dict[str, list[dict]] = {}
    for sr in cur.execute("SELECT * FROM governance_item_submissions ORDER BY version_no DESC").fetchall():
        sd = dict(sr)
        sd["payload"] = json.loads(sd["payload_json"] or "{}")
        subs_by_item.setdefault(sd["item_id"], []).append(sd)

    for it in all_items:
        it["type_label"] = GOV_ITEM_TYPE_LABELS.get(it["item_type"], it["item_type"])
        it["workbench_label"] = WORKBENCH_META.get(it["workbench_key"], {}).get("label", it["workbench_key"])
        it["okr_krs"] = json.loads(it["okr_kr_json"] or "[]")
        it["history"] = subs_by_item.get(it["id"], [])

    # 计算每个工作台的 4 维（Wiki / 视频 / KPI / OKR）目标 vs 已生效 vs 提审中 vs 净缺口
    wb_cards = []
    totals = {"target": 0, "published": 0, "in_review": 0, "missing_or_rejected": 0}
    by_type_summary = {
        k: {"key": k, "label": lbl, "target": 0, "published": 0, "in_review": 0, "gap": 0}
        for k, lbl in GOV_ITEM_TYPE_LABELS.items()
    }

    for tg in targets:
        wk = tg["workbench_key"]
        w_items = [x for x in all_items if x["workbench_key"] == wk]
        dims = {}
        w_target_sum = 0
        w_pub_sum = 0
        w_rev_sum = 0
        w_gap_sum = 0
        for tkey, col_name in [("wiki", "target_wiki"), ("video", "target_video"), ("kpi", "target_kpi"), ("okr", "target_okr")]:
            t_goal = int(tg[col_name] or 0)
            sub_list = [x for x in w_items if x["item_type"] == tkey]
            pub_n = sum(1 for x in sub_list if x["status"] == "published")
            rev_n = sum(1 for x in sub_list if x["status"] in ("pending_gm", "pending_boss"))
            rej_n = sum(1 for x in sub_list if x["status"] == "rejected")
            unreg_gap = max(0, t_goal - pub_n - rev_n)
            dims[tkey] = {
                "key": tkey,
                "label": GOV_ITEM_TYPE_LABELS[tkey],
                "target": t_goal,
                "published": pub_n,
                "in_review": rev_n,
                "rejected": rej_n,
                "gap": unreg_gap,
            }
            w_target_sum += t_goal
            w_pub_sum += pub_n
            w_rev_sum += rev_n
            w_gap_sum += unreg_gap

            by_type_summary[tkey]["target"] += t_goal
            by_type_summary[tkey]["published"] += pub_n
            by_type_summary[tkey]["in_review"] += rev_n
            by_type_summary[tkey]["gap"] += unreg_gap

        pct = int(round(w_pub_sum * 100.0 / w_target_sum)) if w_target_sum else 100
        wb_cards.append({
            "workbench_key": wk,
            "workbench_label": tg["workbench_label"],
            "lead_staff": tg["lead_staff"],
            "notes": tg["notes"],
            "target_total": w_target_sum,
            "published_total": w_pub_sum,
            "in_review_total": w_rev_sum,
            "gap_total": w_gap_sum,
            "completion_pct": pct,
            "dimensions": dims,
        })
        totals["target"] += w_target_sum
        totals["published"] += w_pub_sum
        totals["in_review"] += w_rev_sum
        totals["missing_or_rejected"] += w_gap_sum

    # 按角色裁剪主管端默认关注的工作台
    supervisor_wb_map = {meta["supervisor"]: wk for wk, meta in WORKBENCH_META.items()}
    focus_wb = supervisor_wb_map.get(viewer_staff, "") if viewer_role == "supervisor" else ""

    if viewer_role == "employee":
        visible_items = [x for x in all_items if x["status"] == "published"]
    elif viewer_role == "supervisor" and focus_wb:
        visible_items = [x for x in all_items if x["workbench_key"] == focus_wb or x["assignee_staff"] == viewer_staff]
    else:
        visible_items = all_items

    pending_gm_items = [x for x in all_items if x["status"] == "pending_gm"]
    pending_boss_items = [x for x in all_items if x["status"] == "pending_boss"]
    rejected_items = [x for x in visible_items if x["status"] == "rejected"]
    missing_items = [x for x in visible_items if x["status"] in ("missing", "draft")]

    # 生成软基建专属红黄绿行动箱（用于总经办端、各业务主管端及老板端11专区首屏）
    gov_issues = []
    for rj in rejected_items:
        gov_issues.append({
            "level": "red",
            "category": "制度/文档被退回",
            "title": f"【被打回待重交】{rj['workbench_label']} · {rj['title']}",
            "detail": rj["last_reject_reason"] or "请按退回意见修订后提交新版本（历史意见永久保留）",
            "item_id": rj["id"],
            "action_label": "去修订重交 ›",
        })
    for ms in missing_items:
        if ms["priority"] == "critical":
            gov_issues.append({
                "level": "red",
                "category": f"高优{GOV_ITEM_TYPE_LABELS[ms['item_type']]}缺口",
                "title": f"【关键缺口】{ms['workbench_label']} 缺：{ms['title']}",
                "detail": f"责任人：{ms['assignee_staff']} · 截止：{ms['due_date']} · {ms['summary_note']}",
                "item_id": ms["id"],
                "action_label": "立即提报补齐 ›",
            })
    if viewer_role in ("gm_office", "boss"):
        for pg in pending_gm_items:
            gov_issues.append({
                "level": "yellow",
                "category": "待总经办初审",
                "title": f"【待初审】{pg['assignee_staff']} 已提交 {pg['workbench_label']} · {pg['title']}",
                "detail": pg["summary_note"],
                "item_id": pg["id"],
                "action_label": "总经办初审 ›",
            })
    if viewer_role in ("boss", "gm_office"):
        for pb in pending_boss_items:
            gov_issues.append({
                "level": "yellow",
                "category": "待老板终审拍板",
                "title": f"【待老板终审】{pb['workbench_label']} · {pb['title']}",
                "detail": f"类型：{pb['type_label']}{(' · 审过即自动点亮教程步骤 ' + pb['bound_step_code']) if pb['bound_step_code'] else ''} · {pb['summary_note']}",
                "item_id": pb["id"],
                "action_label": "老板终审 ›" if viewer_role == "boss" else "查看呈报 ›",
            })

    return {
        "workbench_meta": WORKBENCH_META,
        "item_type_labels": GOV_ITEM_TYPE_LABELS,
        "focus_workbench": focus_wb,
        "totals": {
            **totals,
            "completion_pct": int(round(totals["published"] * 100.0 / totals["target"])) if totals["target"] else 100,
        },
        "by_type_summary": list(by_type_summary.values()),
        "workbench_cards": wb_cards,
        "pending_gm_count": len(pending_gm_items),
        "pending_boss_count": len(pending_boss_items),
        "pending_gm_items": pending_gm_items,
        "pending_boss_items": pending_boss_items,
        "gov_issues": gov_issues,
        "items": visible_items,
    }
