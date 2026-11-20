#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
锚点中控 · 统筹缺口引擎 + 开店全流程教程状态机（企业支付宝15步 ↔ 闲鱼开店18步强关联双锁）
数据与交互口径严格融合：
1. 上传包内《协助客户开设网店 SOP》(7阶段11步) + 《闲鱼矩阵开店工作流 v1》(4阶段13步) + 《教程制作工作法》(元教程8步)
2. 《销售工作台 · 服务页 UI Design v1.0》与《泛亚工作台 UI 设计总纲领 v1.0》（首屏红黄绿问题箱、一步一屏、Lock原因组件、7字段防呆矩阵 G()、locked可只读预览、历史审核意见保留不覆盖、未录视频诚实标待录）
"""

from __future__ import annotations
import datetime as dt
import json
import sqlite3
import uuid


TUTORIAL_GAP_DDL = """
-- 1. 委托客户受托托管目标配额表（用于自动倒推客户证照/号卡/家宽/支付宝/各平台受托建店缺口）
CREATE TABLE IF NOT EXISTS matrix_quota_targets (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT NOT NULL UNIQUE REFERENCES legal_persons(id) ON DELETE CASCADE,
    target_licenses INTEGER NOT NULL DEFAULT 4,
    target_tax_regs INTEGER NOT NULL DEFAULT 4,
    target_annual_reports INTEGER NOT NULL DEFAULT 4,
    target_alipays INTEGER NOT NULL DEFAULT 14,
    target_proxies INTEGER NOT NULL DEFAULT 16,
    target_work_phones INTEGER NOT NULL DEFAULT 14,
    target_sim_slots INTEGER NOT NULL DEFAULT 16,
    platform_targets_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 2. 开店教程模板表（主管编写/维护 -> 老板终审发布；覆盖 13 类平台 + 企业支付宝 + 元教程）
CREATE TABLE IF NOT EXISTS tutorial_templates (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('alipay', 'platform', 'meta_authoring')),
    platform TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT 'v1.0',
    summary TEXT NOT NULL DEFAULT '',
    author_staff TEXT NOT NULL DEFAULT '演示开店主管(主管)',
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'pending_boss', 'published', 'archived')),
    reward_points INTEGER NOT NULL DEFAULT 8,
    reward_yuan INTEGER NOT NULL DEFAULT 100,
    sla_days INTEGER NOT NULL DEFAULT 14,
    boss_review_note TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 3. 教程阶段表
CREATE TABLE IF NOT EXISTS tutorial_stages (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES tutorial_templates(id) ON DELETE CASCADE,
    stage_code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_note TEXT NOT NULL DEFAULT '当天完成',
    sort_order INTEGER NOT NULL DEFAULT 1
);

-- 4. 教程原子步骤表（融合 ? 十要素 + 7字段防呆矩阵 guard_json + 跨轨强关联锁 cross_gate_rule）
CREATE TABLE IF NOT EXISTS tutorial_steps (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES tutorial_templates(id) ON DELETE CASCADE,
    stage_id TEXT NOT NULL REFERENCES tutorial_stages(id) ON DELETE CASCADE,
    step_code TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    owner_role TEXT NOT NULL DEFAULT '开店员工',
    when_to_use TEXT NOT NULL DEFAULT '',
    guide TEXT NOT NULL DEFAULT '',
    warn_text TEXT NOT NULL DEFAULT '',
    deliver_note TEXT NOT NULL DEFAULT '',
    stop_condition TEXT NOT NULL DEFAULT '',
    video_url TEXT NOT NULL DEFAULT '',
    wiki_url TEXT NOT NULL DEFAULT '',
    kpi_impact TEXT NOT NULL DEFAULT '计入开店首单一次通过率与14天建店SLA',
    terms_json TEXT NOT NULL DEFAULT '[]',
    guard_json TEXT NOT NULL DEFAULT '[]',
    require_confirm INTEGER NOT NULL DEFAULT 0 CHECK (require_confirm IN (0, 1)),
    require_review INTEGER NOT NULL DEFAULT 0 CHECK (require_review IN (0, 1)),
    cross_gate_rule TEXT NOT NULL DEFAULT '',
    unlock_vault_lockin INTEGER NOT NULL DEFAULT 0 CHECK (unlock_vault_lockin IN (0, 1)),
    UNIQUE (template_id, step_code)
);

-- 5. 步骤提交材料定义表
CREATE TABLE IF NOT EXISTS tutorial_step_materials (
    id TEXT PRIMARY KEY,
    step_id TEXT NOT NULL REFERENCES tutorial_steps(id) ON DELETE CASCADE,
    material_key TEXT NOT NULL,
    label TEXT NOT NULL,
    input_type TEXT NOT NULL DEFAULT 'text' CHECK (input_type IN ('text', 'textarea', 'number', 'select', 'date', 'image', 'video', 'file')),
    required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
    help_text TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 1
);

-- 6. 单店 / 单支付宝开店流程执行实例表（每家店、每个支付宝直接挂一条进度实例，并支持父子跨轨强关联）
CREATE TABLE IF NOT EXISTS onboarding_cases (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES tutorial_templates(id) ON DELETE RESTRICT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('alipay', 'platform', 'meta_authoring')),
    target_id TEXT NOT NULL,
    legal_person_id TEXT REFERENCES legal_persons(id) ON DELETE SET NULL,
    business_entity_id TEXT REFERENCES business_entities(id) ON DELETE SET NULL,
    linked_alipay_case_id TEXT REFERENCES onboarding_cases(id) ON DELETE SET NULL,
    case_title TEXT NOT NULL,
    assigned_staff TEXT NOT NULL DEFAULT '演示员工甲',
    supervisor_staff TEXT NOT NULL DEFAULT '演示开店主管',
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'blocked', 'completed')),
    started_at TEXT NOT NULL DEFAULT '2026-11-10',
    due_at TEXT NOT NULL DEFAULT '2026-11-24',
    completed_at TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (target_kind, target_id)
);

-- 7. 步骤提交与审核历史留痕表（严格遵守《服务页UI设计》要求：每次重提 version_no+1，旧驳回意见完整保留不覆盖！）
CREATE TABLE IF NOT EXISTS onboarding_step_submissions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES onboarding_cases(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES tutorial_steps(id) ON DELETE CASCADE,
    step_code TEXT NOT NULL,
    version_no INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected', 'skipped')),
    materials_json TEXT NOT NULL DEFAULT '{}',
    confirmed INTEGER NOT NULL DEFAULT 0,
    submitted_by TEXT NOT NULL DEFAULT '',
    submitted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_onb_sub_case_step ON onboarding_step_submissions (case_id, step_code, version_no DESC);

-- 8. 双闸申请跳过记录表（员工填≥5字理由+虚报追责确认 -> 老板审批）
CREATE TABLE IF NOT EXISTS onboarding_skip_requests (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES onboarding_cases(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES tutorial_steps(id) ON DELETE CASCADE,
    step_code TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    reviewer_note TEXT NOT NULL DEFAULT ''
);
"""




def _insert_template_tree(cur: sqlite3.Cursor, tpl_row: tuple, stages_spec: list[dict]) -> dict[str, str]:
    """幂等写入一套完整教程树，返回 {step_code: step_id}"""
    cur.execute(
        """INSERT INTO tutorial_templates
           (id, code, target_kind, platform, title, version, summary, author_staff, status, reward_points, reward_yuan, sla_days, boss_review_note, published_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        tpl_row,
    )
    tpl_id = tpl_row[0]
    step_id_by_code: dict[str, str] = {}
    global_order = 0

    for s_idx, stg in enumerate(stages_spec, start=1):
        stg_id = f"stg-{tpl_id}-{s_idx:02d}"
        cur.execute(
            """INSERT INTO tutorial_stages (id, template_id, stage_code, title, description, duration_note, sort_order)
               VALUES (?,?,?,?,?,?,?)""",
            (stg_id, tpl_id, stg["code"], stg["title"], stg.get("desc", ""), stg.get("duration", "当天完成"), s_idx),
        )
        for stp in stg["steps"]:
            global_order += 1
            stp_id = f"stp-{tpl_id}-{stp['code']}"
            step_id_by_code[stp["code"]] = stp_id
            cur.execute(
                """INSERT INTO tutorial_steps
                   (id, template_id, stage_id, step_code, sort_order, title, owner_role, when_to_use,
                    guide, warn_text, deliver_note, stop_condition, video_url, wiki_url, kpi_impact,
                    terms_json, guard_json, require_confirm, require_review, cross_gate_rule, unlock_vault_lockin)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    stp_id,
                    tpl_id,
                    stg_id,
                    stp["code"],
                    global_order,
                    stp["title"],
                    stp.get("who", "开店员工"),
                    stp.get("when", "按阶段顺序推进至本节点时执行"),
                    stp.get("guide", ""),
                    stp.get("warn", ""),
                    stp.get("deliver", ""),
                    stp.get("stop", "遇异常报错立即停手截图报主管，禁止盲目重试"),
                    stp.get("video_url", ""),  # 诚实留空表示待录，绝不编假链接
                    stp.get("wiki_url", ""),
                    stp.get("kpi", "影响建店一次通过率、14天开店SLA与+8分教程绩效"),
                    json.dumps(stp.get("terms", ["路线台账", "不当注册", "因公支付", "T+1账单核实"]), ensure_ascii=False),
                    json.dumps(stp.get("guards", []), ensure_ascii=False),
                    int(stp.get("require_confirm", 0)),
                    int(stp.get("require_review", 0)),
                    stp.get("cross_gate_rule", ""),
                    int(stp.get("unlock_vault_lockin", 0)),
                ),
            )
            for m_idx, mat in enumerate(stp.get("materials", []), start=1):
                m_key, m_lbl, m_type, m_req, m_help = mat
                cur.execute(
                    """INSERT INTO tutorial_step_materials
                       (id, step_id, material_key, label, input_type, required, help_text, sort_order)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (f"mat-{stp_id}-{m_idx}", stp_id, m_key, m_lbl, m_type, m_req, m_help, m_idx),
                )
    return step_id_by_code


def ensure_tutorials_and_gaps_seeded(conn: sqlite3.Connection) -> None:
    from demo_seed import insert

    conn.executescript(TUTORIAL_GAP_DDL)
    cur = conn.cursor()
    if cur.execute('SELECT 1 FROM tutorial_templates LIMIT 1').fetchone():
        return
    today = dt.date.today()
    for customer in ('a', 'b'):
        insert(conn, 'matrix_quota_targets', id=f'mqt-demo-{customer}', legal_person_id=f'lp-demo-{customer}',
               platform_targets_json=json.dumps({'xianyu': 14, 'wechat_shop': 2, 'dianping': 2}), notes='合成目标配额')

    def template(tid, code, kind, platform, title, sections, status='published'):
        stages = []
        for section, step_codes in sections:
            stages.append({'code': section, 'title': f'{section} 阶段', 'steps': [
                {'code': step, 'title': {
                    'C10': '企业管家授权确认', 'D15': '账单连通验收', 'S09': '绑定同主体收款账户', 'S18': '财务复核后上架',
                }.get(step, f'{step} 演示检查'), 'guide': '核对当前合成案例并提交离线演示材料。',
                 'deliver': '一条合成记录及核对说明。', 'warn': '演示材料请使用生成的虚构标识。',
                 'require_confirm': 1, 'require_review': int(step in ('C10', 'D15', 'S08', 'S09', 'S18')),
                 'cross_gate_rule': {'S09': 'require_alipay_step:C10', 'S18': 'require_alipay_step:D15'}.get(step, ''),
                 'unlock_vault_lockin': int(step in ('C10', 'S09')),
                 'guards': [{'pre': '选中当前案例', 'mistake': '引用其他案例', 'block': '提交前核对材料',
                             'tip': '只用演示标识', 'recover': '退回后追加一版', 'owner': '演示开店主管', 'evidence': '合成材料'}],
                 'materials': [('proof', '合成核对说明', 'textarea', 1, '填写本地演示结果')]}
                for step in step_codes]})
        return _insert_template_tree(cur, (tid, code, kind, platform, title, 'demo-v1', '虚构教程与审核示例',
                                           '演示开店主管', status, 8, 100, 14, '', str(today) if status == 'published' else ''), stages)

    ali_steps = template('tpl-alipay-ent', 'TPL-ALIPAY-ENT', 'alipay', 'alipay', '企业支付宝演示开户（15 步）',
                         [(p, [f'{p}{j:02}' for j in steps]) for p, steps in [('A', range(1, 5)), ('B', range(5, 9)),
                                                                            ('C', range(9, 13)), ('D', range(13, 16))]])
    xy_steps = template('tpl-xianyu-store', 'TPL-XIANYU-STORE', 'platform', 'xianyu', '闲鱼建店演示（18 步）',
                        [('准备', [f'S{j:02}' for j in range(1, 7)]), ('开户', [f'S{j:02}' for j in range(7, 13)]),
                         ('验收', [f'S{j:02}' for j in range(13, 19)])])
    template('tpl-meta-authoring', 'TPL-AUTHORING-META', 'meta_authoring', '', '教程制作演示', [('制作', ['M01', 'M02', 'M03'])])
    template('tpl-wechat-shop-v1', 'TPL-WECHAT-SHOP', 'platform', 'wechat_shop', '微信小店演示教程待终审',
             [('准备', ['WX01', 'WX02'])], status='pending_boss')

    def case(cid, tpl, kind, target, customer, entity, staff, state, linked=None):
        insert(conn, 'onboarding_cases', id=cid, template_id=tpl, target_kind=kind, target_id=target,
               legal_person_id=customer, business_entity_id=entity, case_title=f'演示案例 {target}',
               assigned_staff=staff, supervisor_staff='演示开店主管', status=state,
               linked_alipay_case_id=linked, started_at=str(today - dt.timedelta(days=3)),
               due_at=str(today + dt.timedelta(days=7)), notes='合成案例')

    def submission(cid, steps, code, status='approved', version=1):
        insert(conn, 'onboarding_step_submissions', id=f'sub-{cid}-{code}-{version}', case_id=cid, step_id=steps[code],
               step_code=code, version_no=version, status=status, materials_json='{"proof":"合成核对材料"}',
               confirmed=1, submitted_by='演示员工甲', reviewed_by='演示开店主管' if status != 'submitted' else '',
               review_note='请补充演示核对说明' if status == 'rejected' else '')

    case('case-ali-ali-19', 'tpl-alipay-ent', 'alipay', 'ali-19', 'lp-demo-b', 'ent-demo-b-01', '演示员工甲', 'in_progress')
    for code in list(ali_steps)[:9]:
        submission('case-ali-ali-19', ali_steps, code)
    case('case-plat-pa-demo-b-xy02', 'tpl-xianyu-store', 'platform', 'pa-demo-b-xy02', 'lp-demo-b', 'ent-demo-b-01',
         '演示员工甲', 'blocked', 'case-ali-ali-19')
    for code in list(xy_steps)[:8]:
        submission('case-plat-pa-demo-b-xy02', xy_steps, code)
    case('case-ali-ali-13', 'tpl-alipay-ent', 'alipay', 'ali-13', 'lp-demo-a', 'ent-demo-a-04', '演示员工乙', 'in_progress')
    for code in list(ali_steps)[:-1]:
        submission('case-ali-ali-13', ali_steps, code)
    submission('case-ali-ali-13', ali_steps, 'D15', 'submitted')
    case('case-plat-pa-xy-14', 'tpl-xianyu-store', 'platform', 'pa-xy-14', 'lp-demo-a', 'ent-demo-a-04',
         '演示员工乙', 'in_progress', 'case-ali-ali-13')
    for code in list(xy_steps)[:-1]:
        submission('case-plat-pa-xy-14', xy_steps, code)
    case('case-plat-pa-xy-01', 'tpl-xianyu-store', 'platform', 'pa-xy-01', 'lp-demo-a', 'ent-demo-a-01',
         '演示员工甲', 'in_progress')
    for code in list(xy_steps)[:7]:
        submission('case-plat-pa-xy-01', xy_steps, code)
    submission('case-plat-pa-xy-01', xy_steps, 'S08', 'rejected')
    submission('case-plat-pa-xy-01', xy_steps, 'S08', 'submitted', version=2)
    insert(conn, 'onboarding_skip_requests', id='skip-demo-01', case_id='case-plat-pa-demo-b-xy02',
           step_id=xy_steps['S09'], step_code='S09', reason='合成跳步申请', requested_by='演示员工甲')
    conn.commit()

def evaluate_case_detail(conn: sqlite3.Connection, case_id: str) -> dict | None:
    cur = conn.cursor()
    kase = cur.execute("SELECT * FROM onboarding_cases WHERE id = ?", (case_id,)).fetchone()
    if not kase:
        return None
    k = dict(kase)
    tpl = dict(cur.execute("SELECT * FROM tutorial_templates WHERE id = ?", (k["template_id"],)).fetchone())
    stages = [dict(r) for r in cur.execute("SELECT * FROM tutorial_stages WHERE template_id = ? ORDER BY sort_order", (k["template_id"],)).fetchall()]
    steps = [dict(r) for r in cur.execute("SELECT * FROM tutorial_steps WHERE template_id = ? ORDER BY sort_order", (k["template_id"],)).fetchall()]
    mats = [dict(r) for r in cur.execute(
        "SELECT m.* FROM tutorial_step_materials m JOIN tutorial_steps s ON s.id = m.step_id WHERE s.template_id = ? ORDER BY m.sort_order",
        (k["template_id"],),
    ).fetchall()]
    mats_by_step: dict[str, list[dict]] = {}
    for m in mats:
        m["field_key"] = m["material_key"]
        m["placeholder"] = m.get("help_text") or ""
        mats_by_step.setdefault(m["step_id"], []).append(m)

    subs = [dict(r) for r in cur.execute(
        "SELECT * FROM onboarding_step_submissions WHERE case_id = ? ORDER BY step_code, version_no DESC",
        (case_id,),
    ).fetchall()]
    history_by_code: dict[str, list[dict]] = {}
    latest_by_code: dict[str, dict] = {}
    for sb in subs:
        sb["materials"] = json.loads(sb["materials_json"] or "{}")
        history_by_code.setdefault(sb["step_code"], []).append(sb)
        if sb["step_code"] not in latest_by_code:
            latest_by_code[sb["step_code"]] = sb

    skips = [dict(r) for r in cur.execute(
        "SELECT * FROM onboarding_skip_requests WHERE case_id = ? ORDER BY requested_at DESC",
        (case_id,),
    ).fetchall()]
    skip_by_code: dict[str, dict] = {}
    for sk in skips:
        if sk["step_code"] not in skip_by_code:
            skip_by_code[sk["step_code"]] = sk

    # 若关联了上游企业支付宝开户轨，查询上游支付宝已完成步骤集合！
    linked_ali_info = None
    linked_ali_approved_codes: set[str] = set()
    if k.get("linked_alipay_case_id"):
        ali_case = cur.execute("SELECT * FROM onboarding_cases WHERE id = ?", (k["linked_alipay_case_id"],)).fetchone()
        if ali_case:
            linked_ali_info = dict(ali_case)
            ali_ok_rows = cur.execute(
                "SELECT DISTINCT step_code FROM onboarding_step_submissions WHERE case_id = ? AND status IN ('approved', 'skipped')",
                (k["linked_alipay_case_id"],),
            ).fetchall()
            linked_ali_approved_codes = {r[0] for r in ali_ok_rows}
            linked_ali_info["approved_codes"] = sorted(linked_ali_approved_codes)

    all_prev_handled = True
    done_cnt = 0
    approved_review_cnt = 0
    total_review_cnt = 0
    current_step_obj = None
    has_rejected = False
    has_pending_review = False
    cross_blocked_msg = ""

    steps_by_stage: dict[str, list[dict]] = {}
    for stp in steps:
        code = stp["step_code"]
        latest = latest_by_code.get(code)
        hist = history_by_code.get(code, [])
        sk = skip_by_code.get(code)
        if stp["require_review"]:
            total_review_cnt += 1

        # 检查跨轨强关联锁（如 require_alipay_step:C10 / require_alipay_step:D15）
        cross_lock = None
        rule = (stp.get("cross_gate_rule") or "").strip()
        if rule.startswith("require_alipay_step:"):
            req_ali_code = rule.split(":", 1)[1].strip()
            if not linked_ali_info:
                cross_lock = {
                    "required_step": req_ali_code,
                    "reason": f"本店尚未绑定关联的企业支付宝开户实例，无法核验前置节点【{req_ali_code}】",
                    "consequence": "未绑定合规同主体企业支付宝会导致收款串户或触发不当注册",
                    "action_hint": "请先在台账为本店铺绑定同营业执照下的销售专用企业支付宝",
                    "linked_case_id": "",
                }
            elif req_ali_code not in linked_ali_approved_codes:
                ali_step_title_row = cur.execute(
                    "SELECT title FROM tutorial_steps WHERE template_id = ? AND step_code = ?",
                    (linked_ali_info["template_id"], req_ali_code),
                ).fetchone()
                ali_step_title = ali_step_title_row[0] if ali_step_title_row else req_ali_code
                cross_lock = {
                    "required_step": req_ali_code,
                    "reason": f"强关联锁止：绑定的企业支付宝「{linked_ali_info['case_title']}」尚未完成前置节点【{req_ali_code} · {ali_step_title}】",
                    "consequence": "提前强行推进会导致企业店卡死在绑户环节，或卖货回款与财务账单API错乱污染税表",
                    "action_hint": f"点击下方按钮一键跳转至「{linked_ali_info['case_title']}」先完成 {req_ali_code}",
                    "linked_case_id": linked_ali_info["id"],
                    "linked_target_id": linked_ali_info["target_id"],
                }

        if latest and latest["status"] == "approved":
            state = "approved"
            done_cnt += 1
            if stp["require_review"]:
                approved_review_cnt += 1
        elif latest and latest["status"] == "skipped":
            state = "skipped"
            done_cnt += 1
        elif not all_prev_handled:
            state = "locked"
        elif latest and latest["status"] == "submitted":
            state = "submitted"
            has_pending_review = True
            all_prev_handled = False
        elif latest and latest["status"] == "rejected":
            state = "rejected"
            has_rejected = True
            all_prev_handled = False
        else:
            state = "active"
            all_prev_handled = False
            if cross_lock and not cross_blocked_msg:
                cross_blocked_msg = cross_lock["reason"]

        stp_out = {
            **stp,
            "terms": json.loads(stp["terms_json"] or "[]"),
            "guards": json.loads(stp["guard_json"] or "[]"),
            "materials": mats_by_step.get(stp["id"], []),
            "state": state,
            "step_state": state,
            "cross_lock": cross_lock,
            "cross_gate": {
                "locked": bool(cross_lock),
                "reason": cross_lock["reason"] if cross_lock else "",
                "consequence": cross_lock["consequence"] if cross_lock else "",
                "upstream_case_id": cross_lock["linked_case_id"] if cross_lock else "",
                "required_step_code": cross_lock["required_step"] if cross_lock else "",
            },
            "latest_submission": latest,
            "submission_history": hist,  # 完整保留 v1, v2... 所有历史审核意见！
            "history": hist,
            "skip_request": sk,
        }
        if current_step_obj is None and state in ("active", "rejected", "submitted"):
            current_step_obj = stp_out
        steps_by_stage.setdefault(stp["stage_id"], []).append(stp_out)

    total_cnt = len(steps)
    progress_pct = int(round(done_cnt * 100.0 / total_cnt)) if total_cnt else 0
    if current_step_obj is None and steps:
        current_step_obj = steps_by_stage[stages[-1]["id"]][-1]

    stage_list = [{**stg, "steps": steps_by_stage.get(stg["id"], [])} for stg in stages]

    return {
        **k,
        "template": tpl,
        "template_code": tpl["code"],
        "template_title": tpl["title"],
        "template_version": tpl["version"],
        "reward_points": tpl["reward_points"],
        "reward_yuan": tpl["reward_yuan"],
        "total_steps": total_cnt,
        "done_steps": done_cnt,
        "progress_pct": progress_pct,
        "approved_review_cnt": approved_review_cnt,
        "total_review_cnt": total_review_cnt,
        "current_step_code": current_step_obj["step_code"] if current_step_obj else "",
        "current_step_title": current_step_obj["title"] if current_step_obj else "全部完成",
        "current_step_state": current_step_obj["state"] if current_step_obj else "approved",
        "has_rejected": has_rejected,
        "has_pending_review": has_pending_review,
        "cross_blocked_msg": cross_blocked_msg,
        "linked_alipay_case": linked_ali_info,
        "stages": stage_list,
    }


def build_all_cases_summary(conn: sqlite3.Connection) -> tuple[list[dict], dict[str, dict]]:
    """构建全量开店实例轻量摘要列表 + {(target_kind, target_id): summary} 索引"""
    cur = conn.cursor()
    case_ids = [r[0] for r in cur.execute("SELECT id FROM onboarding_cases ORDER BY status DESC, id").fetchall()]
    summaries: list[dict] = []
    by_target: dict[str, dict] = {}
    for cid in case_ids:
        detail = evaluate_case_detail(conn, cid)
        if not detail:
            continue
        # 轻量摘要不重复塞入庞大的 stages 全量文本（单点打开时可按需或保留轻量stages）
        by_target[f"{detail['target_kind']}:{detail['target_id']}"] = detail
        summaries.append(detail)
    return summaries, by_target


# ==================== 核心引擎 2：全维统筹「看缺口」与红黄绿问题箱 ====================
def build_gap_and_issues_overview(
    conn: sqlite3.Connection,
    platform_labels: dict[str, str],
    cases_summary: list[dict],
    today: dt.date,
) -> dict:
    cur = conn.cursor()
    lps = [dict(r) for r in cur.execute("SELECT * FROM legal_persons ORDER BY id").fetchall()]
    targets = {r["legal_person_id"]: dict(r) for r in cur.execute("SELECT * FROM matrix_quota_targets").fetchall()}
    templates = [dict(r) for r in cur.execute("SELECT * FROM tutorial_templates ORDER BY id").fetchall()]

    # 1) 13类业务平台 + 企业支付宝 教程覆盖度缺口矩阵
    published_plats = {t["platform"] for t in templates if t["status"] == "published" and t["platform"]}
    pending_plats = {t["platform"]: t for t in templates if t["status"] in ("pending_boss", "draft") and t["platform"]}

    tutorial_coverage = []
    # 先放企业支付宝核心基座
    ali_tpl = next((t for t in templates if t["target_kind"] == "alipay" and t["status"] == "published"), None)
    ali_step_cnt = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (ali_tpl["id"],)).fetchone()[0] if ali_tpl else 0
    tutorial_coverage.append({
        "platform": "alipay",
        "label": "企业支付宝(基座轨)",
        "coverage_state": "published" if ali_tpl else "missing",
        "template_id": ali_tpl["id"] if ali_tpl else "",
        "template_title": ali_tpl["title"] if ali_tpl else "缺失",
        "step_count": ali_step_cnt,
        "account_count": cur.execute("SELECT COUNT(*) FROM alipay_accounts").fetchone()[0],
    })
    for p_key, p_lbl in platform_labels.items():
        acc_cnt = cur.execute("SELECT COUNT(*) FROM platform_accounts WHERE platform = ? AND account_status <> 'retired'", (p_key,)).fetchone()[0]
        if p_key in published_plats:
            tp = next(t for t in templates if t["platform"] == p_key and t["status"] == "published")
            sc = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (tp["id"],)).fetchone()[0]
            tutorial_coverage.append({
                "platform": p_key,
                "label": p_lbl,
                "coverage_state": "published",
                "template_id": tp["id"],
                "template_title": tp["title"],
                "step_count": sc,
                "account_count": acc_cnt,
            })
        elif p_key in pending_plats:
            tp = pending_plats[p_key]
            sc = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (tp["id"],)).fetchone()[0]
            tutorial_coverage.append({
                "platform": p_key,
                "label": p_lbl,
                "coverage_state": tp["status"],  # pending_boss or draft
                "template_id": tp["id"],
                "template_title": tp["title"],
                "step_count": sc,
                "account_count": acc_cnt,
            })
        else:
            tutorial_coverage.append({
                "platform": p_key,
                "label": p_lbl,
                "coverage_state": "missing",
                "template_id": "",
                "template_title": f"待主管实操录屏编写《{p_lbl}开店/买券SOP》",
                "step_count": 0,
                "account_count": acc_cnt,
            })

    missing_tutorial_count = sum(1 for x in tutorial_coverage if x["coverage_state"] == "missing")
    pending_tutorial_count = sum(1 for x in tutorial_coverage if x["coverage_state"] == "pending_boss")

    # 2) 按法人核算「标准矩阵目标 vs 现状已就绪 vs 建店推进中 vs 净缺口」
    lp_gap_cards = []
    for lp in lps:
        lid = lp["id"]
        t = targets.get(lid)
        if not t:
            continue
        p_targets: dict[str, int] = json.loads(t["platform_targets_json"] or "{}")

        lic_now = cur.execute("SELECT COUNT(*) FROM business_entities WHERE legal_person_id = ? AND license_status = 'active'", (lid,)).fetchone()[0]
        tax_now = cur.execute(
            "SELECT COUNT(*) FROM tax_registrations tr JOIN business_entities be ON be.id = tr.business_entity_id WHERE be.legal_person_id = ?",
            (lid,),
        ).fetchone()[0]
        ar_now = cur.execute(
            "SELECT COUNT(*) FROM annual_reports ar JOIN business_entities be ON be.id = ar.business_entity_id WHERE be.legal_person_id = ?",
            (lid,),
        ).fetchone()[0]
        ali_ready = cur.execute(
            """SELECT COUNT(*) FROM alipay_accounts a
               LEFT JOIN onboarding_cases c ON c.target_kind='alipay' AND c.target_id=a.id
               WHERE a.legal_person_id = ? AND (c.status = 'completed' OR c.id IS NULL)""",
            (lid,),
        ).fetchone()[0]
        ali_building = cur.execute(
            """SELECT COUNT(*) FROM alipay_accounts a
               JOIN onboarding_cases c ON c.target_kind='alipay' AND c.target_id=a.id
               WHERE a.legal_person_id = ? AND c.status <> 'completed'""",
            (lid,),
        ).fetchone()[0]
        sim_now = cur.execute("SELECT COUNT(*) FROM sim_cards WHERE legal_person_id = ? AND sim_status <> 'retired'", (lid,)).fetchone()[0]
        phone_now = cur.execute("SELECT COUNT(*) FROM physical_devices WHERE legal_person_id = ? AND device_kind IN ('work_phone', 'procurement_phone')", (lid,)).fetchone()[0]

        # 计算该委托客户实名可办剩余卡槽 vs 第三方授权卡需求
        quotas = cur.execute("SELECT statutory_limit, existing_personal_cards, carrier, holder_name FROM carrier_quotas WHERE legal_person_id = ?", (lid,)).fetchall()
        company_remaining_openable = 0
        for q in quotas:
            opened_n = cur.execute(
                "SELECT COUNT(*) FROM sim_cards WHERE real_name_holder = ? AND carrier = ? AND card_category IN ('company_master', 'company_sub') AND sim_status <> 'retired'",
                (q[3], q[2]),
            ).fetchone()[0]
            company_remaining_openable += max(0, q[0] - q[1] - opened_n)

        sim_gap = max(0, t["target_sim_slots"] - sim_now)
        external_sim_need = max(0, sim_gap - company_remaining_openable)

        plat_breakdown = []
        total_plat_target = 0
        total_plat_ready = 0
        total_plat_building = 0
        for pk, target_n in p_targets.items():
            total_plat_target += target_n
            ready_n = cur.execute(
                "SELECT COUNT(*) FROM platform_accounts WHERE legal_person_id = ? AND platform = ? AND account_status = 'active'",
                (lid, pk),
            ).fetchone()[0]
            build_n = cur.execute(
                "SELECT COUNT(*) FROM platform_accounts WHERE legal_person_id = ? AND platform = ? AND account_status IN ('warming', 'restricted')",
                (lid, pk),
            ).fetchone()[0]
            total_plat_ready += ready_n
            total_plat_building += build_n
            gap_n = max(0, target_n - ready_n - build_n)
            plat_breakdown.append({
                "platform": pk,
                "label": platform_labels.get(pk, pk),
                "target": target_n,
                "ready": ready_n,
                "building": build_n,
                "gap": gap_n,
                "has_published_tutorial": pk in published_plats,
            })

        lp_gap_cards.append({
            "legal_person_id": lid,
            "legal_person_name": lp["name"],
            "notes": t["notes"],
            "metrics": [
                {"key": "licenses", "label": "营业执照主体", "target": t["target_licenses"], "ready": lic_now, "building": 0, "gap": max(0, t["target_licenses"] - lic_now)},
                {"key": "tax", "label": "电子税务局登记", "target": t["target_tax_regs"], "ready": tax_now, "building": 0, "gap": max(0, t["target_tax_regs"] - tax_now)},
                {"key": "annual", "label": "工商年报建档", "target": t["target_annual_reports"], "ready": ar_now, "building": 0, "gap": max(0, t["target_annual_reports"] - ar_now)},
                {"key": "alipay", "label": "企业支付宝(已通API)", "target": t["target_alipays"], "ready": ali_ready, "building": ali_building, "gap": max(0, t["target_alipays"] - ali_ready - ali_building)},
                {"key": "sims", "label": "实名手机卡槽", "target": t["target_sim_slots"], "ready": sim_now, "building": 0, "gap": sim_gap, "sub_note": f"客户名额余量{company_remaining_openable}张 · 需第三方授权卡{external_sim_need}张" if sim_gap > 0 else "配额充足"},
                {"key": "phones", "label": "ADB指纹专用手机", "target": t["target_work_phones"], "ready": phone_now, "building": 0, "gap": max(0, t["target_work_phones"] - phone_now)},
                {"key": "stores", "label": "全平台账号总槽位", "target": total_plat_target, "ready": total_plat_ready, "building": total_plat_building, "gap": max(0, total_plat_target - total_plat_ready - total_plat_building)},
            ],
            "platform_breakdown": plat_breakdown,
        })

    # 3) 首屏红→黄→绿「问题与缺口行动箱」（严格遵循《服务页UI设计》1.4 节：红=现在要动手，黄=提醒或等别人，绿=正常）
    action_issues: list[dict] = []

    # 红灯 1：被打回的步骤（员工需立即重交）
    for c in cases_summary:
        if c["has_rejected"]:
            action_issues.append({
                "level": "red",
                "category": "开店步骤被打回",
                "legal_person_id": c["legal_person_id"] or "",
                "assigned_staff": c["assigned_staff"],
                "title": f"【材料被打回】{c['case_title']} 卡在 {c['current_step_code']}「{c['current_step_title']}」",
                "detail": f"负责员工：{c['assigned_staff']} · 请按主管驳回意见补齐凭证重新提交",
                "action_type": "open_case",
                "action_target": c["id"],
                "action_label": "去重交材料 ›",
            })

    # 红灯 2：跨轨强关联锁止（闲鱼店被未就绪的支付宝卡住！）
    for c in cases_summary:
        if c["cross_blocked_msg"]:
            action_issues.append({
                "level": "red",
                "category": "支付宝↔闲鱼跨轨锁死",
                "legal_person_id": c["legal_person_id"] or "",
                "assigned_staff": c["assigned_staff"],
                "title": f"【跨轨锁死】{c['case_title']} 停在 {c['current_step_code']}（等待关联支付宝解锁）",
                "detail": c["cross_blocked_msg"],
                "action_type": "open_case",
                "action_target": c["linked_alipay_case_id"] or c["id"],
                "action_label": "去解锁关联支付宝 ›",
            })

    # 红灯 3：家宽代理已过期 & 手机卡低余额
    for px in cur.execute("SELECT id, proxy_code, exit_ip, expires_at FROM proxy_ips").fetchall():
        try:
            d_left = (dt.date.fromisoformat(px[3][:10]) - today).days
        except Exception:
            d_left = 99
        if d_left < 0:
            action_issues.append({
                "level": "red",
                "category": "家宽断网停摆",
                "legal_person_id": "lp-demo-a",
                "assigned_staff": "演示员工丙",
                "title": f"【家宽已过期】{px[1]} ({px[2]}) 已过期 {abs(d_left)} 天，关联窗口已锁止防直连！",
                "detail": "严禁删除代理记录，请立即一键续期恢复店铺网络",
                "action_type": "open_proxy",
                "action_target": px[0],
                "action_label": "立即续期 ›",
            })

    # 红灯 4：委托客户受托配额缺口 & 11个平台缺标准教程
    for gc in lp_gap_cards:
        store_gap = next(m["gap"] for m in gc["metrics"] if m["key"] == "stores")
        lic_gap = next(m["gap"] for m in gc["metrics"] if m["key"] == "licenses")
        if store_gap > 0 or lic_gap > 0:
            action_issues.append({
                "level": "red" if lic_gap > 0 else "yellow",
                "category": "受托客户配额缺口",
                "legal_person_id": gc["legal_person_id"],
                "assigned_staff": "演示开店主管",
                "title": f"【受托缺口】委托客户「{gc['legal_person_name']}」托管清单尚差 {lic_gap} 本客户执照、{store_gap} 个受托店铺槽位待建",
                "detail": gc["notes"],
                "action_type": "jump_gap",
                "action_target": gc["legal_person_id"],
                "action_label": "查看缺口并派单 ›",
            })

    if missing_tutorial_count > 0:
        action_issues.append({
            "level": "yellow",
            "category": "平台教程缺口",
            "legal_person_id": "",
            "assigned_staff": "演示开店主管",
            "title": f"【教程待补齐】闲鱼与企业支付宝(33步)已完备，其余 {missing_tutorial_count} 类平台尚缺标准开店SOP",
            "detail": f"另有 {pending_tutorial_count} 套新编教程（微信小店）已提交待老板终审上线",
            "action_type": "jump_supervisor_studio",
            "action_target": "studio",
            "action_label": "去教程工坊 ›",
        })

    # 黄灯：待主管审核的步骤材料 & 待老板终审的跳步申请
    pending_subs = cur.execute(
        """SELECT s.id, s.case_id, s.step_code, s.submitted_by, s.submitted_at, c.case_title, c.legal_person_id, st.title AS step_title
           FROM onboarding_step_submissions s
           JOIN onboarding_cases c ON c.id = s.case_id
           JOIN tutorial_steps st ON st.id = s.step_id
           WHERE s.status = 'submitted'
           ORDER BY s.submitted_at ASC"""
    ).fetchall()
    for ps in pending_subs:
        action_issues.append({
            "level": "yellow",
            "category": "待主管审核闸口",
            "legal_person_id": ps[6] or "",
            "assigned_staff": "演示开店主管",
            "title": f"【待审核】{ps[3]} 已提交「{ps[5]}」节点 {ps[2]}（{ps[7]}）",
            "detail": f"提交时间：{ps[4]} · 审核通过后自动解锁下游及跨轨关联步骤",
            "action_type": "open_case",
            "action_target": ps[1],
            "action_label": "去审核放行 ›",
        })

    pending_skips = [dict(r) for r in cur.execute(
        """SELECT r.*, c.case_title, c.legal_person_id, st.title AS step_title
           FROM onboarding_skip_requests r
           JOIN onboarding_cases c ON c.id = r.case_id
           JOIN tutorial_steps st ON st.id = r.step_id
           WHERE r.status = 'pending'"""
    ).fetchall()]
    for sk in pending_skips:
        action_issues.append({
            "level": "yellow",
            "category": "待老板特批跳步",
            "legal_person_id": sk["legal_person_id"] or "",
            "assigned_staff": "老板",
            "title": f"【跳步申请】{sk['requested_by']} 申请跳过「{sk['case_title']}」步骤 {sk['step_code']}（{sk['step_title']}）",
            "detail": f"理由：{sk['reason']}",
            "action_type": "jump_boss_approvals",
            "action_target": sk["id"],
            "action_label": "老板审批 ›",
        })

    # 按红 -> 黄排序
    action_issues.sort(key=lambda x: 0 if x["level"] == "red" else 1)

    # 4) 员工负载统计（主管派单参考）
    staff_names = ["演示员工甲", "演示员工乙", "演示员工丙", "演示员工丁"]
    staff_workload = []
    for sn in staff_names:
        active_cases = [c for c in cases_summary if c["assigned_staff"] == sn and c["status"] != "completed"]
        done_cases = [c for c in cases_summary if c["assigned_staff"] == sn and c["status"] == "completed"]
        rejected_n = sum(1 for c in active_cases if c["has_rejected"])
        managed_stores = cur.execute("SELECT COUNT(*) FROM platform_accounts WHERE operator_staff = ? AND account_status <> 'retired'", (sn,)).fetchone()[0]
        staff_workload.append({
            "staff_name": sn,
            "active_onboarding_count": len(active_cases),
            "completed_onboarding_count": len(done_cases),
            "rejected_count": rejected_n,
            "managed_accounts_count": managed_stores,
            "load_level": "heavy" if len(active_cases) >= 4 else ("normal" if len(active_cases) >= 1 else "idle"),
        })

    for tc in tutorial_coverage:
        tc["has_published"] = tc["coverage_state"] == "published"
        tc["pending_status"] = "" if tc["coverage_state"] == "published" else (tc["coverage_state"] if tc["coverage_state"] != "missing" else "")
        tp_match = next((t for t in templates if t["id"] == tc["template_id"]), None)
        tc["version"] = tp_match["version"] if tp_match else "v1.0"

    for gc in lp_gap_cards:
        gc["total_gap_count"] = sum(m["gap"] for m in gc["metrics"])
        gc["dimensions"] = {m["key"]: m for m in gc["metrics"]}
        gc["platform_gaps"] = [
            {**pb, "platform_label": pb["label"], "has_tutorial": pb["has_published_tutorial"]}
            for pb in gc["platform_breakdown"]
        ]

    for ai in action_issues:
        ai["case_id"] = ai["action_target"] if ai["action_type"] == "open_case" else ""
        if ai["action_type"] == "open_proxy":
            ai["jump_view"] = "network_ads"
        elif ai["action_type"] == "jump_supervisor_studio":
            ai["jump_view"] = "sup_authoring"
        elif ai["action_type"] == "jump_boss_approvals":
            ai["jump_view"] = "onboarding_hub"
        else:
            ai["jump_view"] = "overview"

    for sw in staff_workload:
        sw["staff"] = sw["staff_name"]
        sw["in_progress"] = sw["active_onboarding_count"]
        sw["completed"] = sw["completed_onboarding_count"]
        sw["rejected"] = sw["rejected_count"]

    for tp in templates:
        tp["stage_count"] = cur.execute("SELECT COUNT(*) FROM tutorial_stages WHERE template_id = ?", (tp["id"],)).fetchone()[0]
        tp["step_count"] = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (tp["id"],)).fetchone()[0]

    return {
        "lp_gap_cards": lp_gap_cards,
        "lp_gap_rows": lp_gap_cards,
        "tutorial_coverage": tutorial_coverage,
        "missing_tutorial_count": missing_tutorial_count,
        "pending_tutorial_count": pending_tutorial_count,
        "action_issues": action_issues,
        "issues": action_issues,
        "red_count": sum(1 for x in action_issues if x["level"] == "red"),
        "yellow_count": sum(1 for x in action_issues if x["level"] == "yellow"),
        "pending_submissions": [dict(r) for r in pending_subs],
        "pending_skips": pending_skips,
        "staff_workload": staff_workload,
        "templates": templates,
    }
