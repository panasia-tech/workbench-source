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
    "sales": {"label": "💼 销售工作台（含虚拟产品&服务页）", "supervisor": "陆铭", "order": 1},
    "cs": {"label": "🎧 客服工作台（售前接待&小法庭举证）", "supervisor": "苏晴", "order": 2},
    "procurement": {"label": "🛒 采购工作台（买券团购&3C货源）", "supervisor": "郑凯", "order": 3},
    "warehouse": {"label": "📦 仓管工作台（3C质检分级&出入库）", "supervisor": "马强", "order": 4},
    "account_ops": {"label": "🏪 账号与开店中控台（矩阵建店&防关联）", "supervisor": "周安", "order": 5},
    "gm_office": {"label": "🏛 总经办全司治理（跨部门制度&离职安全）", "supervisor": "沈悦", "order": 6},
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
    assignee_staff TEXT NOT NULL DEFAULT '沈悦',
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
    conn.executescript(GOVERNANCE_DDL)
    cnt = conn.execute("SELECT COUNT(*) FROM workbench_governance_targets").fetchone()[0]
    if cnt > 0:
        sync_published_governance_to_tutorial_steps(conn)
        return

    cur = conn.cursor()
    # 1. 六大工作台标准基建目标配额
    targets = [
        ("sales", "💼 销售工作台（虚拟产品&服务页）", "陆铭", 4, 4, 3, 2, "重点补齐服务页一步一屏录屏与多平台小店破局OKR"),
        ("cs", "🎧 客服工作台（接待&小法庭举证）", "苏晴", 3, 3, 2, 1, "急需修正因公退券原路冲回话术Wiki并补录小法庭举证视频"),
        ("procurement", "🛒 采购工作台（买券团购&3C货源）", "郑凯", 3, 3, 2, 2, "补齐超时退券财务对账录屏与Q4餐饮券供给池OKR"),
        ("warehouse", "📦 仓管工作台（3C质检分级&出入库）", "马强", 3, 3, 2, 1, "质检KPI已交老板终审，急缺显示器5分钟标准质检培训视频"),
        ("account_ops", "🏪 账号与开店中控台（矩阵建店&防关联）", "周安", 4, 4, 2, 2, "企业支付宝C10/D15录屏待老板终审点亮，小红书/抖店Wiki待补"),
        ("gm_office", "🏛 总经办全司治理（跨部门制度&离职安全）", "沈悦", 3, 2, 3, 2, "负责全司OKR统筹初审及员工离职30分钟权限回收KPI固化"),
    ]
    cur.executemany(
        """INSERT INTO workbench_governance_targets
           (workbench_key, workbench_label, lead_staff, target_wiki, target_video, target_kpi, target_okr, notes)
           VALUES (?,?,?,?,?,?,?,?)""",
        targets,
    )

    # 2. 真实业务场景缺口与提审样本（覆盖 published / pending_boss / pending_gm / rejected / missing 全状态）
    items = [
        # --- 销售工作台 (陆铭) ---
        (
            "gov-sales-kpi-01", "SLOT-SALES-KPI-MARGIN", "sales", "kpi",
            "销售业务员月度 10% 净毛利提成与售后退单冲减核算口径",
            "总经办+销售部", "陆铭", "critical", "published", "2026-11-05", "", "销售工作台 > 业绩提成面板 ?",
            "https://docs.example.invalid/demo_sales_kpi_margin_v2", "",
            "明确以扣除售后退款、采购券码实付成本及平台技术服务费(0.6%/1.6%/2.0%)后的净毛利作为10%提成唯一基数。",
            "月度提成 = (实收GMV - 售后退款 - 关联采购成本 - 平台佣金bps) × 10%",
            "platform_accounts (month_gmv_fen, month_cost_fen, month_refund_fen, commission_rate_bps)",
            "🟢 净毛利率 ≥ 18% 达标；🟡 12%~18% 预警；🔴 < 12% 或退单率 > 5% 暂停新店配额",
            "[]", 1, "", "2026-11-04"
        ),
        (
            "gov-sales-wiki-01", "SLOT-SALES-WIKI-CARD", "sales", "wiki",
            "《闲鱼/微信小店虚拟卡券秒发核销与防骗局SOP》",
            "销售部", "陆铭", "high", "published", "2026-11-08", "", "销售工作台 > 虚拟卡券订单页 ?",
            "https://docs.example.invalid/demo_virtual_voucher_sop", "",
            "高客单电子卡券核销前强制核对买家历史信用分，严禁脱离平台私发卡密。",
            "", "", "", "[]", 1, "", "2026-11-07"
        ),
        (
            "gov-sales-vid-01", "SLOT-SALES-VID-CAD", "sales", "video",
            "《服务页（CAD描图/远程技术）一步一屏接单与禁填0实操录屏》",
            "销售部", "陆铭", "high", "pending_gm", "2026-11-19", "", "服务页工作台 > 接单向导顶部视频槽",
            "https://pan.dingtalk.com/s/panasia_service_cad_walkthrough_v1.mp4", "06:20",
            "销售主管陆铭已按《服务页UI设计v1.0》实操录制完毕（含首屏问题箱处理、报价留痕与缺数据写『待核』演示），提请总经办沈悦初审。",
            "", "", "", "[]", 1, "", ""
        ),
        (
            "gov-sales-okr-01", "SLOT-SALES-OKR-26Q4", "sales", "okr",
            "2026 Q4 虚拟产品新渠道（微信小店 + 小红书小店 + 抖店）破局 OKR",
            "总经办", "沈悦", "critical", "pending_boss", "2026-11-18", "", "销售工作台 > 季度目标看板",
            "https://docs.example.invalid/demo_2026q4_sales_okr", "",
            "总经办沈悦会同销售主管陆铭起草完毕，明确摆脱单一闲鱼依赖的三个可量化 KR，待老板终审拍板锁死。",
            "", "", "",
            json.dumps([
                "O：跑通微信小店、小红书小店与抖店虚拟卡券合规闭环，建立第二增长曲线",
                "KR1：11月底前完成微信小店、小红书小店、抖店 3 套标准开店教程上线并开出 ≥ 8 家在售新店",
                "KR2：受托多渠道 Q4 单月实收突破 ¥350,000，且各受托客户主体独立建档核算，达 24 万法定阈值提前提醒客户依法申报",
                "KR3：小红书种草号 → 小红书小店私域导流转化率达到 ≥ 4.5%，零违规封店"
            ], ensure_ascii=False),
            1, "", ""
        ),
        (
            "gov-sales-kpi-02", "SLOT-SALES-KPI-SLA", "sales", "kpi",
            "服务页定制单（CAD/远程装机）首响时长与一次交付通过率 KPI",
            "总经办+销售部", "陆铭", "high", "missing", "2026-11-22", "", "服务页工作台 > 交付节点 ?",
            "", "", "【待补缺口】尚未明确夜间询单剔除规则及客户二次返工扣分权重，需销售主管与总经办联合提交。",
            "", "", "", "[]", 0, "", ""
        ),

        # --- 客服工作台 (苏晴) ---
        (
            "gov-cs-kpi-01", "SLOT-CS-KPI-RESP", "cs", "kpi",
            "客服工作台 3 分钟首响率与平台小法庭介入率红线口径",
            "客服部", "苏晴", "critical", "published", "2026-11-06", "", "客服工作台 > 顶栏绩效胶囊 ?",
            "https://docs.example.invalid/demo_cs_kpi_v1", "",
            "白班 09:00-22:00 人工首响 ≤ 180 秒；单店月度小法庭败诉介入率严控 ≤ 0.5%。",
            "首响达标率 = 180秒内人工回复会话数 / 有效进线会话总数 × 100%",
            "cs_sessions (first_reply_sec, dispute_escalated)",
            "🟢 首响 ≥ 96% 且败诉率 = 0；🟡 首响 90%~96%；🔴 首响 < 90% 或单周小法庭败诉 ≥ 2 单",
            "[]", 1, "", "2026-11-06"
        ),
        (
            "gov-cs-wiki-01", "SLOT-CS-WIKI-REFUND", "cs", "wiki",
            "《虚拟卡券过期退换、安抚话术与因公退券原路冲回协同手册》",
            "客服部", "苏晴", "critical", "rejected", "2026-11-18", "", "客服工作台 > 售后退款抽屉 ?",
            "https://docs.example.invalid/demo_cs_refund_draft_v1", "",
            "v1 初稿仅写了安抚买家话术，漏写了上游点评/抖音团购券退券冲回主户的登记动作，已被老板退回重改！",
            "", "", "", "[]", 1,
            "老板驳回意见(v1)：只写了前端客服怎么赔买家，完全漏了通知采购/台账登记『inflow_purchase_refund（因公退券原路冲回主资金号冲减成本）』的衔接步骤！请联合采购补齐后再提审。",
            ""
        ),
        (
            "gov-cs-vid-01", "SLOT-CS-VID-COURT", "cs", "video",
            "《闲鱼小法庭虚拟商品发货凭证与双留痕举证 4 分钟培训视频》",
            "客服部", "苏晴", "high", "missing", "2026-11-23", "", "客服工作台 > 纠纷举证卡 [视频:待录]",
            "", "", "【待录缺口】新入职客服频繁因举证截图不全败诉，需苏晴录制标准举证录屏。",
            "", "", "", "[]", 0, "", ""
        ),

        # --- 采购工作台 (郑凯) ---
        (
            "gov-proc-wiki-01", "SLOT-PROC-WIKI-ISOLATION", "procurement", "wiki",
            "《采购买券专机物理隔离与同营业执照因公支付代扣铁律 SOP》",
            "采购部", "郑凯", "critical", "published", "2026-11-05", "", "采购工作台 > 下单核销页 ?",
            "https://docs.example.invalid/demo_proc_isolation_sop", "",
            "严禁采购专机登录任何销售店铺，因公支付子号必须 100% 对应本营业执照主资金池。",
            "", "", "", "[]", 1, "", "2026-11-05"
        ),
        (
            "gov-proc-kpi-01", "SLOT-PROC-KPI-LOSS", "procurement", "kpi",
            "虚拟卡券采买折扣节省率与错买过期损耗率 KPI 口径",
            "采购部+总经办", "郑凯", "high", "published", "2026-11-09", "", "采购工作台 > 采购员绩效 ?",
            "https://docs.example.invalid/demo_proc_kpi_v1", "",
            "考核集采券包低于平台挂牌基准价的节省额，错买无法退券的死券损耗率严控 ≤ 0.2%。",
            "采购净节省额 = Σ(基准进价 - 实际因公支付净支出) - 死券报损额",
            "alipay_bills (outflow_corporate_pay - inflow_purchase_refund)",
            "🟢 损耗率 = 0 且折扣达标；🟡 损耗率 ≤ 0.2%；🔴 损耗率 > 0.2% 全额抵扣绩效池",
            "[]", 1, "", "2026-11-09"
        ),
        (
            "gov-proc-vid-01", "SLOT-PROC-VID-CLAWBACK", "procurement", "video",
            "《大众点评/抖音团购过期自动退券在台账冲减采购成本实操视频》",
            "采购部", "郑凯", "normal", "missing", "2026-11-26", "", "采购工作台 > 退券对账页 [视频:待录]",
            "", "", "【待录缺口】指导采购员核对退回同主体主资金号流水并关联原订单号。",
            "", "", "", "[]", 0, "", ""
        ),
        (
            "gov-proc-okr-01", "SLOT-PROC-OKR-26Q4", "procurement", "okr",
            "2026 Q4 高频刚需茶饮/快餐电子券直采供给池降本 OKR",
            "总经办+采购部", "沈悦", "high", "missing", "2026-11-24", "", "采购工作台 > 季度供给OKR",
            "", "", "【待补缺口】待总经办与郑凯敲定抖省省与美团点评渠道进项成本下调目标。",
            "", "", "", "[]", 0, "", ""
        ),

        # --- 仓管工作台 (马强) ---
        (
            "gov-wh-wiki-01", "SLOT-WH-WIKI-QC", "warehouse", "wiki",
            "《Reuse 二手显示器与 3C 配件入库质检分级（S/A/B/瑕）留痕 SOP》",
            "仓管部", "马强", "critical", "published", "2026-11-03", "", "仓管工作台 > 入库质检台 ?",
            "https://docs.example.invalid/demo_wh_qc_grade_sop", "",
            "每台入库设备强制拍摄序列号 SN 铭牌与纯色屏检图，严禁无图入库。",
            "", "", "", "[]", 1, "", "2026-11-03"
        ),
        (
            "gov-wh-kpi-01", "SLOT-WH-KPI-QCACC", "warehouse", "kpi",
            "仓管入库质检定级准确率与 24h 打包出库及时率 KPI 口径",
            "仓管部+总经办", "马强", "critical", "pending_boss", "2026-11-17", "", "仓管工作台 > 质检绩效看板 ?",
            "https://docs.example.invalid/demo_wh_kpi_rc1", "",
            "马强提交、总经办沈悦已完成初审校对数据表字段，现呈报老板终审生效！",
            "质检准确率 = (当月出库总台数 - 买家实锤描述不符退货台数) / 当月出库总台数 × 100%",
            "warehouse_qc_orders (inspected_by, ship_within_24h, quality_mismatch_return)",
            "🟢 准确率 ≥ 99.2% 且 24h发货率 ≥ 98.5%；🟡 准确率 98%~99.2%；🔴 < 98% 触发复检追责",
            "[]", 1, "", ""
        ),
        (
            "gov-wh-vid-01", "SLOT-WH-VID-MONITOR", "warehouse", "video",
            "《二手显示器坏点/漏光/接口 5 分钟标准质检动作培训视频》",
            "仓管部", "马强", "high", "missing", "2026-11-21", "", "仓管工作台 > 质检操作页 [视频:待录]",
            "", "", "【待录缺口】仓管新人培训必看标准动作视频，待马强在质检台实拍录制。",
            "", "", "", "[]", 0, "", ""
        ),

        # --- 账号与开店中控台 (周安) ---
        (
            "gov-ops-kpi-01", "SLOT-OPS-KPI-OPENING", "account_ops", "kpi",
            "开店专员 14 天建店一次通过率与『零不当注册废号』红线 KPI",
            "开店中控组", "周安", "critical", "published", "2026-11-10", "", "开店工作台 > 步骤十要素 KPI口径",
            "https://docs.example.invalid/demo_store_opening_kpi", "",
            "完整建成1家18步闭环闲鱼企业店奖励8积分+¥100；违规点支付宝快捷登录触发不当注册废号倒扣全额绩效。",
            "建店一次通过率 = 无主管驳回且14天内闭环店数 / 当月派发总店数 × 100%",
            "onboarding_cases & onboarding_step_submissions",
            "🟢 一次通过率 ≥ 90% 且废号 = 0；🟡 75%~90%；🔴 出现任意主动违规绑户废号立即红牌停单培训",
            "[]", 1, "", "2026-11-10"
        ),
        (
            "gov-ops-vid-c10", "SLOT-OPS-VID-ALIC10", "account_ops", "video",
            "《企业支付宝 C10 第1天趁法人在场『企业管家』一键授权实操录屏》",
            "开店中控组", "周安", "critical", "pending_boss", "2026-11-17", "C10", "企业支付宝15步教程 > C10 节点视频槽",
            "https://pan.dingtalk.com/s/panasia_alipay_c10_steward_guide.mp4", "03:45",
            "【跨模块点亮演示】周安已实拍录制 C10 企业管家授权全过程并经总经办核验，老板点击『批准上线』后，企业支付宝教程 C10 步骤里的『待录』将自动点亮为此播放链接！",
            "", "", "", "[]", 1, "", ""
        ),
        (
            "gov-ops-wiki-xhs", "SLOT-OPS-WIKI-XHSSHOP", "account_ops", "wiki",
            "《小红书小店入驻、千帆钱包结算与种草号导流防限流 Wiki》",
            "开店中控组", "周安", "high", "missing", "2026-11-22", "", "开店教程编排工坊 > 小红书小店参考Wiki",
            "", "", "【待补缺口】配合小红书小店新教程同步沉淀千帆后台保证金退保与导流规范。",
            "", "", "", "[]", 0, "", ""
        ),

        # --- 总经办全司治理 (沈悦) ---
        (
            "gov-gm-okr-01", "SLOT-GM-OKR-26Q4", "gm_office", "okr",
            "2026 Q4 总经办全工作台制度、Wiki、培训视频与考核口径 100% 消缺 OKR",
            "总经办", "沈悦", "critical", "published", "2026-11-01", "", "总经办治理台 > 顶层OKR",
            "https://docs.example.invalid/demo_gm_2026q4_okr", "",
            "消除各工作台『视频待录 / Wiki待补 / KPI模糊』历史欠账，全部纳入总控台闭环验收。",
            "", "", "",
            json.dumps([
                "O：建成全公司六大工作台统一制度、实操视频与量化考核底座，杜绝口头管理",
                "KR1：11月30日前将五大业务工作台核心节点培训视频完备率从 30% 提升至 100%",
                "KR2：全部岗位 KPI 计算公式与红黄绿阈值 100% 经老板终审锁死并映射底层数据表",
                "KR3：建立外部合约卡到期与员工离职 30 分钟权限回收零遗漏巡检机制"
            ], ensure_ascii=False),
            1, "", "2026-11-01"
        ),
        (
            "gov-gm-kpi-offboard", "SLOT-GM-KPI-OFFBOARD", "gm_office", "kpi",
            "员工离职/调岗 30 分钟内 AdsPower 专窗回收、真机改密与号卡交接 SLA 口径",
            "总经办+人事行政", "沈悦", "critical", "missing", "2026-11-20", "", "总经办 > 离职安全审计闭环槽",
            "", "", "【高危制度缺口】源自前期全文件夹背调与合同安全审计：急需明确人事发起离职后 30 分钟内收回专窗与改密的考核追责标准！",
            "", "", "", "[]", 0, "", ""
        ),
    ]

    cur.executemany(
        """INSERT INTO governance_gap_items
           (id, slot_code, workbench_key, item_type, title, owner_dept, assignee_staff, priority, status,
            due_date, bound_step_code, page_anchor_note, resource_url, video_duration, summary_note,
            kpi_formula, kpi_data_source, kpi_thresholds, okr_kr_json, current_version, last_reject_reason, published_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        items,
    )

    # 3. 插入真实多版本提审与审批历史记录（含被退回重改保留意见、总经办初审转呈老板终审）
    subs = [
        (
            "gsub-sales-vid-v1", "gov-sales-vid-01", 1, "陆铭", "supervisor", "2026-11-16 14:20:00",
            json.dumps({
                "resource_url": "https://pan.dingtalk.com/s/panasia_service_cad_walkthrough_v1.mp4",
                "video_duration": "06:20",
                "summary_note": "完整演示服务页首屏红黄绿问题箱、一步一屏报单与缺数据填『待核』禁填0。"
            }, ensure_ascii=False),
            "pending_gm", "", "", "", "", "", ""
        ),
        (
            "gsub-sales-okr-v1", "gov-sales-okr-01", 1, "沈悦", "gm_office", "2026-11-16 15:10:00",
            json.dumps({
                "resource_url": "https://docs.example.invalid/demo_2026q4_sales_okr",
                "okr_krs": [
                    "O：跑通微信小店、小红书小店与抖店虚拟卡券合规闭环，建立第二增长曲线",
                    "KR1：11月底前完成3套新平台开店教程上线并开出 ≥ 8 家在售新店",
                    "KR2：新渠道 Q4 单月合计实收 GMV 突破 ¥350,000",
                    "KR3：小红书种草号 → 小红书小店导流转化率 ≥ 4.5%"
                ]
            }, ensure_ascii=False),
            "pending_boss", "沈悦(总经办)", "2026-11-16 15:10:00", "总经办起草直呈老板终审", "", "", ""
        ),
        (
            "gsub-cs-wiki-v1", "gov-cs-wiki-01", 1, "苏晴", "supervisor", "2026-11-14 11:00:00",
            json.dumps({
                "resource_url": "https://docs.example.invalid/demo_cs_refund_draft_v1",
                "summary_note": "整理了客户卡券过期投诉的3套标准安抚话术与补发流程。"
            }, ensure_ascii=False),
            "rejected", "沈悦(总经办)", "2026-11-14 14:00:00", "话术清晰，转呈老板审阅财务衔接。",
            "老板", "2026-11-14 18:30:00",
            "只写了前端客服怎么赔买家，完全漏了通知采购/台账登记『inflow_purchase_refund（因公退券原路冲回主资金号冲减成本）』的衔接步骤！请联合采购补齐后再提审。"
        ),
        (
            "gsub-wh-kpi-v1", "gov-wh-kpi-01", 1, "马强", "supervisor", "2026-11-16 09:40:00",
            json.dumps({
                "kpi_formula": "质检准确率 = (当月出库总台数 - 买家实锤描述不符退货台数) / 当月出库总台数 × 100%",
                "kpi_data_source": "warehouse_qc_orders",
                "kpi_thresholds": "🟢 ≥99.2%；🟡 98%~99.2%；🔴 <98%"
            }, ensure_ascii=False),
            "pending_boss", "沈悦(总经办)", "2026-11-16 11:15:00", "总经办初审通过：公式无歧义且与仓管数据库字段一致，呈请老板终审锁死。", "", "", ""
        ),
        (
            "gsub-ops-vid-c10-v1", "gov-ops-vid-c10", 1, "周安", "supervisor", "2026-11-16 16:05:00",
            json.dumps({
                "resource_url": "https://pan.dingtalk.com/s/panasia_alipay_c10_steward_guide.mp4",
                "video_duration": "03:45",
                "bound_step_code": "C10",
                "summary_note": "实拍第1天趁法人在场搜企业管家完成管理员授权全流程，审过即自动点亮企支教程 C10 视频槽！"
            }, ensure_ascii=False),
            "pending_boss", "沈悦(总经办)", "2026-11-16 16:30:00", "视频画面清晰且已打码敏感隐私，呈老板终审发布。", "", "", ""
        ),
    ]
    cur.executemany(
        """INSERT INTO governance_item_submissions
           (id, item_id, version_no, submitted_by, submitted_role, submitted_at, payload_json, status,
            gm_reviewed_by, gm_reviewed_at, gm_note, boss_reviewed_by, boss_reviewed_at, boss_note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        subs,
    )

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
