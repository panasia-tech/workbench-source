-- =========================================================================================
-- 044_workbench_governance_wiki_video_kpi_okr_postgres.sql
-- 锚点中控 V3 线上 PostgreSQL 增量迁移脚本：
-- 六大工作台（销售 / 客服 / 采购 / 仓管 / 账号开店 / 总经办）组织与制度基建缺口治理表
-- 核心原则：与资产/账号/密码表同库分专区物理隔离；管理缺口清单、结构化 KPI/OKR 口径锁死、
--           钉钉/飞书 Wiki 与培训视频链接回填、总经办初审与老板终审闭环，审批生效后自动点亮前端 ? 槽位。
-- =========================================================================================

BEGIN;

-- 1. 各工作台软基建应有配额目标表（自动计算各工作台 Wiki / 视频 / KPI / OKR 完备率与净缺口）
CREATE TABLE IF NOT EXISTS ledger_workbench_governance_targets (
    workbench_key   VARCHAR(64)  PRIMARY KEY,
    workbench_label VARCHAR(128) NOT NULL,
    lead_staff      VARCHAR(64)  NOT NULL,
    target_wiki     INTEGER      NOT NULL DEFAULT 4,
    target_video    INTEGER      NOT NULL DEFAULT 4,
    target_kpi      INTEGER      NOT NULL DEFAULT 3,
    target_okr      INTEGER      NOT NULL DEFAULT 2,
    notes           TEXT         NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2. 全工作台 Wiki / 培训视频 / KPI / OKR 缺口槽位与生效标准主表
CREATE TABLE IF NOT EXISTS ledger_governance_gap_items (
    id                 VARCHAR(64)  PRIMARY KEY,
    slot_code          VARCHAR(96)  NOT NULL UNIQUE,
    workbench_key      VARCHAR(64)  NOT NULL REFERENCES ledger_workbench_governance_targets(workbench_key) ON DELETE CASCADE,
    item_type          VARCHAR(32)  NOT NULL CHECK (item_type IN ('wiki', 'video', 'kpi', 'okr')),
    title              VARCHAR(255) NOT NULL,
    owner_dept         VARCHAR(64)  NOT NULL DEFAULT '总经办',
    assignee_staff     VARCHAR(64)  NOT NULL DEFAULT '演示总经办',
    priority           VARCHAR(32)  NOT NULL DEFAULT 'high' CHECK (priority IN ('critical', 'high', 'normal')),
    status             VARCHAR(32)  NOT NULL DEFAULT 'missing'
        CHECK (status IN ('missing', 'draft', 'pending_gm', 'pending_boss', 'published', 'rejected')),
    due_date           DATE,
    bound_step_code    VARCHAR(32)  NOT NULL DEFAULT '',
    page_anchor_note   VARCHAR(255) NOT NULL DEFAULT '',
    resource_url       TEXT         NOT NULL DEFAULT '',
    video_duration     VARCHAR(32)  NOT NULL DEFAULT '',
    summary_note       TEXT         NOT NULL DEFAULT '',
    kpi_formula        TEXT         NOT NULL DEFAULT '',
    kpi_data_source    VARCHAR(255) NOT NULL DEFAULT '',
    kpi_thresholds     TEXT         NOT NULL DEFAULT '',
    okr_kr_json        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    current_version    INTEGER      NOT NULL DEFAULT 0,
    last_reject_reason TEXT         NOT NULL DEFAULT '',
    published_at       TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_items_wb_type_status
    ON ledger_governance_gap_items (workbench_key, item_type, status);
CREATE INDEX IF NOT EXISTS idx_gov_items_assignee
    ON ledger_governance_gap_items (assignee_staff, status);
CREATE INDEX IF NOT EXISTS idx_gov_items_bound_step
    ON ledger_governance_gap_items (bound_step_code)
    WHERE bound_step_code <> '';

-- 3. 多版本提审、总经办初审与老板终审历史留痕表（Append-Only：每次退回重交递增 version_no，永久保留历史意见）
CREATE TABLE IF NOT EXISTS ledger_governance_item_submissions (
    id               VARCHAR(64) PRIMARY KEY,
    item_id          VARCHAR(64) NOT NULL REFERENCES ledger_governance_gap_items(id) ON DELETE CASCADE,
    version_no       INTEGER     NOT NULL DEFAULT 1,
    submitted_by     VARCHAR(64) NOT NULL,
    submitted_role   VARCHAR(32) NOT NULL DEFAULT 'supervisor',
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status           VARCHAR(32) NOT NULL CHECK (status IN ('pending_gm', 'pending_boss', 'approved', 'rejected')),
    gm_reviewed_by   VARCHAR(64) NOT NULL DEFAULT '',
    gm_reviewed_at   TIMESTAMPTZ,
    gm_note          TEXT        NOT NULL DEFAULT '',
    boss_reviewed_by VARCHAR(64) NOT NULL DEFAULT '',
    boss_reviewed_at TIMESTAMPTZ,
    boss_note        TEXT        NOT NULL DEFAULT '',
    UNIQUE (item_id, version_no)
);

COMMIT;
