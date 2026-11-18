-- =========================================================================================
-- 043_gap_tutorials_adspower_rbac_postgres.sql
-- 锚点中控 v5 线上 PostgreSQL 增量迁移脚本：
-- 1. 密码库扩展 AdsPower Authenticator 桥接字段 (fakey 同步状态) 与员工免明文托管 RBAC 字段
-- 2. 法人标准矩阵配额与全维缺口自动倒推表 (ledger_matrix_quota_targets)
-- 3. 三层开店教程编排表 (ledger_tutorial_templates / stages / steps / step_materials)
-- 4. 店铺/企业支付宝开户步进实例、版本化留痕提交表（禁覆盖历史驳回意见）与双闸跳步申请表
-- =========================================================================================

BEGIN;

-- 1. 扩展密码保险箱表：对接 AdsPower Local API (/api/v1/user/update fakey) 与员工免明文托管权限
ALTER TABLE vault_credentials
    ADD COLUMN IF NOT EXISTS assigned_staff        VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS employee_totp_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS adspower_profile_id   VARCHAR(64) REFERENCES ledger_adspower_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS adspower_sync_status  VARCHAR(32) NOT NULL DEFAULT 'not_applicable'
        CHECK (adspower_sync_status IN ('not_applicable', 'pending_sync', 'synced', 'sync_error')),
    ADD COLUMN IF NOT EXISTS adspower_synced_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_vault_cred_assigned_staff
    ON vault_credentials (assigned_staff)
    WHERE assigned_staff <> '';

-- 2. 法人标准矩阵目标配额表（用于自动倒推证照/税务/年报/企支/家宽/真机/号卡及13类平台开店净缺口）
CREATE TABLE IF NOT EXISTS ledger_matrix_quota_targets (
    id                    VARCHAR(64) PRIMARY KEY,
    legal_person_id       VARCHAR(64) NOT NULL UNIQUE REFERENCES ledger_legal_persons(id) ON DELETE CASCADE,
    target_licenses       INTEGER     NOT NULL DEFAULT 4,
    target_tax_regs       INTEGER     NOT NULL DEFAULT 4,
    target_annual_reports INTEGER     NOT NULL DEFAULT 4,
    target_alipays        INTEGER     NOT NULL DEFAULT 14,
    target_proxies        INTEGER     NOT NULL DEFAULT 16,
    target_work_phones    INTEGER     NOT NULL DEFAULT 14,
    target_sim_slots      INTEGER     NOT NULL DEFAULT 16,
    platform_targets_json JSONB       NOT NULL DEFAULT '{}'::jsonb,
    notes                 TEXT        NOT NULL DEFAULT '',
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. 开店教程模板表（主管端编写 -> 老板端终审上线；覆盖企业支付宝 + 13类业务平台 + 做教程元指南）
CREATE TABLE IF NOT EXISTS ledger_tutorial_templates (
    id               VARCHAR(64)  PRIMARY KEY,
    code             VARCHAR(64)  NOT NULL UNIQUE,
    target_kind      VARCHAR(32)  NOT NULL CHECK (target_kind IN ('alipay', 'platform', 'meta_authoring')),
    platform         VARCHAR(64)  NOT NULL DEFAULT '',
    title            VARCHAR(255) NOT NULL,
    version          VARCHAR(32)  NOT NULL DEFAULT 'v1.0',
    summary          TEXT         NOT NULL DEFAULT '',
    author_staff     VARCHAR(64)  NOT NULL DEFAULT '周安(主管)',
    status           VARCHAR(32)  NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'pending_boss', 'published', 'archived')),
    reward_points    INTEGER      NOT NULL DEFAULT 8,
    reward_yuan      INTEGER      NOT NULL DEFAULT 100,
    sla_days         INTEGER      NOT NULL DEFAULT 14,
    boss_review_note TEXT         NOT NULL DEFAULT '',
    published_at     TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tutorial_tpl_platform_status
    ON ledger_tutorial_templates (target_kind, platform, status);

-- 4. 教程阶段表
CREATE TABLE IF NOT EXISTS ledger_tutorial_stages (
    id            VARCHAR(64)  PRIMARY KEY,
    template_id   VARCHAR(64)  NOT NULL REFERENCES ledger_tutorial_templates(id) ON DELETE CASCADE,
    stage_code    VARCHAR(32)  NOT NULL,
    title         VARCHAR(255) NOT NULL,
    description   TEXT         NOT NULL DEFAULT '',
    duration_note VARCHAR(64)  NOT NULL DEFAULT '当天完成',
    sort_order    INTEGER      NOT NULL DEFAULT 1
);

-- 5. 教程原子步骤表（内置 ? 十要素 + 7字段防呆矩阵 guard_json + 跨轨强关联锁 cross_gate_rule）
CREATE TABLE IF NOT EXISTS ledger_tutorial_steps (
    id                  VARCHAR(64)  PRIMARY KEY,
    template_id         VARCHAR(64)  NOT NULL REFERENCES ledger_tutorial_templates(id) ON DELETE CASCADE,
    stage_id            VARCHAR(64)  NOT NULL REFERENCES ledger_tutorial_stages(id) ON DELETE CASCADE,
    step_code           VARCHAR(32)  NOT NULL,
    sort_order          INTEGER      NOT NULL,
    title               VARCHAR(255) NOT NULL,
    owner_role          VARCHAR(64)  NOT NULL DEFAULT '开店员工',
    when_to_use         TEXT         NOT NULL DEFAULT '',
    guide               TEXT         NOT NULL DEFAULT '',
    warn_text           TEXT         NOT NULL DEFAULT '',
    deliver_note        TEXT         NOT NULL DEFAULT '',
    stop_condition      TEXT         NOT NULL DEFAULT '',
    video_url           TEXT         NOT NULL DEFAULT '',
    wiki_url            TEXT         NOT NULL DEFAULT '',
    kpi_impact          TEXT         NOT NULL DEFAULT '计入开店首单一次通过率与14天建店SLA',
    terms_json          JSONB        NOT NULL DEFAULT '[]'::jsonb,
    guard_json          JSONB        NOT NULL DEFAULT '[]'::jsonb,
    require_confirm     BOOLEAN      NOT NULL DEFAULT FALSE,
    require_review      BOOLEAN      NOT NULL DEFAULT FALSE,
    -- 跨轨门禁语法示例：'require_alipay_step:C10'（锁闲鱼S09企业认证） / 'require_alipay_step:D15'（锁闲鱼S18正式开售）
    cross_gate_rule     VARCHAR(128) NOT NULL DEFAULT '',
    unlock_vault_lockin BOOLEAN      NOT NULL DEFAULT FALSE,
    UNIQUE (template_id, step_code)
);

-- 6. 步骤提交材料定义表
CREATE TABLE IF NOT EXISTS ledger_tutorial_step_materials (
    id          VARCHAR(64)  PRIMARY KEY,
    step_id     VARCHAR(64)  NOT NULL REFERENCES ledger_tutorial_steps(id) ON DELETE CASCADE,
    field_key   VARCHAR(64)  NOT NULL,
    label       VARCHAR(255) NOT NULL,
    kind        VARCHAR(32)  NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'video', 'account', 'amount')),
    required    BOOLEAN      NOT NULL DEFAULT TRUE,
    placeholder TEXT         NOT NULL DEFAULT '',
    sort_order  INTEGER      NOT NULL DEFAULT 1
);

-- 7. 店铺 / 企业支付宝建店执行案例表（linked_alipay_case_id 实现企支轨与闲鱼轨双锁联动）
CREATE TABLE IF NOT EXISTS ledger_onboarding_cases (
    id                    VARCHAR(64)  PRIMARY KEY,
    template_id           VARCHAR(64)  NOT NULL REFERENCES ledger_tutorial_templates(id),
    target_kind           VARCHAR(32)  NOT NULL CHECK (target_kind IN ('alipay', 'platform')),
    target_id             VARCHAR(64)  NOT NULL,
    legal_person_id       VARCHAR(64)  NOT NULL REFERENCES ledger_legal_persons(id) ON DELETE CASCADE,
    business_entity_id    VARCHAR(64)  REFERENCES ledger_business_entities(id) ON DELETE SET NULL,
    linked_alipay_case_id VARCHAR(64)  REFERENCES ledger_onboarding_cases(id) ON DELETE SET NULL,
    case_title            VARCHAR(255) NOT NULL,
    assigned_staff        VARCHAR(64)  NOT NULL,
    supervisor_staff      VARCHAR(64)  NOT NULL DEFAULT '周安',
    status                VARCHAR(32)  NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'blocked', 'completed')),
    started_at            DATE         NOT NULL DEFAULT CURRENT_DATE,
    due_at                DATE,
    completed_at          TIMESTAMPTZ,
    notes                 TEXT         NOT NULL DEFAULT '',
    UNIQUE (target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_cases_staff ON ledger_onboarding_cases (assigned_staff, status);
CREATE INDEX IF NOT EXISTS idx_onboarding_cases_linked_ali ON ledger_onboarding_cases (linked_alipay_case_id);

-- 8. 步骤提交与审核历史版本表（Append-Only：每次打回重交递增 version_no，永久保留历史驳回意见）
CREATE TABLE IF NOT EXISTS ledger_onboarding_step_submissions (
    id             VARCHAR(64) PRIMARY KEY,
    case_id        VARCHAR(64) NOT NULL REFERENCES ledger_onboarding_cases(id) ON DELETE CASCADE,
    step_id        VARCHAR(64) NOT NULL REFERENCES ledger_tutorial_steps(id) ON DELETE CASCADE,
    step_code      VARCHAR(32) NOT NULL,
    version_no     INTEGER     NOT NULL DEFAULT 1,
    status         VARCHAR(32) NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected', 'skipped')),
    materials_json JSONB       NOT NULL DEFAULT '{}'::jsonb,
    confirmed      BOOLEAN     NOT NULL DEFAULT FALSE,
    submitted_by   VARCHAR(64) NOT NULL,
    submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by    VARCHAR(64) NOT NULL DEFAULT '',
    reviewed_at    TIMESTAMPTZ,
    review_note    TEXT        NOT NULL DEFAULT '',
    UNIQUE (case_id, step_code, version_no)
);

-- 9. 双闸例外跳步申请表（员工发起 -> 老板终审特批）
CREATE TABLE IF NOT EXISTS ledger_onboarding_skip_requests (
    id           VARCHAR(64) PRIMARY KEY,
    case_id      VARCHAR(64) NOT NULL REFERENCES ledger_onboarding_cases(id) ON DELETE CASCADE,
    step_id      VARCHAR(64) NOT NULL REFERENCES ledger_tutorial_steps(id) ON DELETE CASCADE,
    step_code    VARCHAR(32) NOT NULL,
    reason       TEXT        NOT NULL,
    requested_by VARCHAR(64) NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status       VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by   VARCHAR(64) NOT NULL DEFAULT '',
    decided_at   TIMESTAMPTZ,
    boss_note    TEXT        NOT NULL DEFAULT ''
);

COMMIT;
