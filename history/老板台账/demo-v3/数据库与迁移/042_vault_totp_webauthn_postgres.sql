-- ============================================================================
-- Migration: 042_vault_totp_webauthn_postgres.sql
-- Target: account-ops-console (Node.js / Fastify / PostgreSQL 15+)
-- Purpose: 全量业务密码保险箱（AES-256-GCM 信封加密） + Authenticator (RFC 6238 TOTP)
--          + iPhone 相机扫码刷 Face ID (W3C WebAuthn Passkeys) + 防篡改审计日志
-- ============================================================================

BEGIN;

-- 1. 老板/高权限管理员 TOTP 验证器绑定表（兼容 iPhone 自带「密码」App / Google & Microsoft Authenticator）
CREATE TABLE IF NOT EXISTS user_mfa_totp (
    user_id               UUID PRIMARY KEY,
    totp_secret_ciphertext BYTEA NOT NULL,          -- 使用 KEK + AES-256-GCM 加密后的 20字节(160-bit) TOTP 种子
    totp_iv               BYTEA NOT NULL,           -- 12-byte GCM IV
    totp_auth_tag         BYTEA NOT NULL,           -- 16-byte GCM Auth Tag
    kek_version           SMALLINT NOT NULL DEFAULT 1,
    issuer_name           VARCHAR(64) NOT NULL DEFAULT 'AnchorLedger',
    account_label         VARCHAR(128) NOT NULL DEFAULT 'BossMasterVault',
    is_verified           BOOLEAN NOT NULL DEFAULT FALSE,
    last_used_time_step   BIGINT NOT NULL DEFAULT 0, -- 防 30s 窗口内同一验证码重放攻击
    failed_attempts       SMALLINT NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,              -- 连续失败超限自动锁定截止时间
    recovery_codes_hash   JSONB NOT NULL DEFAULT '[]'::jsonb, -- Argon2id 哈希后的应急一次性恢复码
    bound_at              TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. WebAuthn Passkey 通行密钥表（支持 iPhone 原生相机跨设备扫码 + Face ID / Mac Touch ID）
CREATE TABLE IF NOT EXISTS user_webauthn_passkeys (
    credential_id         TEXT PRIMARY KEY,         -- Base64URL Credential ID
    user_id               UUID NOT NULL,
    device_label          VARCHAR(128) NOT NULL DEFAULT '老板 iPhone Face ID',
    public_key_cose       BYTEA NOT NULL,           -- COSE 公钥字节（服务端仅存公钥，永不接触生物特征）
    sign_count            BIGINT NOT NULL DEFAULT 0,-- 签名递增计数器（防克隆检测）
    transports            TEXT[] NOT NULL DEFAULT ARRAY['hybrid', 'internal'], -- 'hybrid' 即 iPhone 跨设备扫码蓝牙通道
    aaguid                VARCHAR(64),
    credential_device_type VARCHAR(32) NOT NULL DEFAULT 'multiDevice',
    credential_backed_up  BOOLEAN NOT NULL DEFAULT TRUE, -- iCloud Keychain 同步态
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON user_webauthn_passkeys (user_id);

-- 3. 全量密码保险箱密文主表（采用 KMS/KEK + 每行独立 DEK 的 AES-256-GCM 信封加密）
CREATE TABLE IF NOT EXISTS vault_credentials (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_person_id       TEXT,
    category              VARCHAR(32) NOT NULL CHECK (category IN ('gov_tax', 'alipay', 'platform', 'network_ads', 'device_sim')),
    target_table          VARCHAR(64) NOT NULL DEFAULT '',
    target_id             VARCHAR(64) NOT NULL DEFAULT '',
    title                 VARCHAR(200) NOT NULL,
    login_account         VARCHAR(200) NOT NULL,
    secondary_label       VARCHAR(64) NOT NULL DEFAULT '支付/交易密码',

    -- 信封加密层 1：由主密钥 KEK 加密的本行专属随机 256-bit 数据密钥 (DEK)
    encrypted_dek         BYTEA NOT NULL,
    dek_iv                BYTEA NOT NULL,           -- 12 bytes
    dek_auth_tag          BYTEA NOT NULL,           -- 16 bytes
    kek_version           SMALLINT NOT NULL DEFAULT 1,

    -- 信封加密层 2：由本行 DEK + AAD(id||category||target_table||target_id) 加密的 JSON 密文载荷
    -- 载荷明文结构：{ loginPassword, secondaryPassword, subAccountTotpSecret, recoveryNote }
    ciphertext_payload    BYTEA NOT NULL,
    payload_iv            BYTEA NOT NULL,           -- 12 bytes
    payload_auth_tag      BYTEA NOT NULL,           -- 16 bytes

    has_secondary_pwd     BOOLEAN NOT NULL DEFAULT FALSE,
    has_sub_totp          BOOLEAN NOT NULL DEFAULT FALSE,
    password_rotated_at   DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by            UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vault_cred_cat ON vault_credentials (category);
CREATE INDEX IF NOT EXISTS idx_vault_cred_target ON vault_credentials (target_table, target_id);

-- 4. 不可篡改密码解密与安全审计日志表（只允许 INSERT，触发器硬禁止 UPDATE / DELETE）
CREATE TABLE IF NOT EXISTS vault_audit_logs (
    id                    BIGSERIAL PRIMARY KEY,
    occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_user_id         UUID,
    action                VARCHAR(48) NOT NULL,     -- UNLOCK_TOTP / UNLOCK_PASSKEY / UNLOCK_FAILED / REVEAL_SECRET / UPDATE_SECRET / LOCK_MANUAL
    auth_method           VARCHAR(64) NOT NULL DEFAULT '-',
    credential_id         UUID,
    target_title          VARCHAR(200) NOT NULL DEFAULT '-',
    client_ip             INET,
    user_agent            TEXT,
    detail                TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_vault_audit_time ON vault_audit_logs (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_audit_cred ON vault_audit_logs (credential_id);

CREATE OR REPLACE FUNCTION forbid_vault_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'SECURITY_VIOLATION: vault_audit_logs 为只追加防篡改安全审计表，严禁修改或删除历史记录！';
END;
$$;

DROP TRIGGER IF EXISTS trg_vault_audit_immutable ON vault_audit_logs;
CREATE TRIGGER trg_vault_audit_immutable
BEFORE UPDATE OR DELETE ON vault_audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_vault_audit_mutation();

COMMIT;
