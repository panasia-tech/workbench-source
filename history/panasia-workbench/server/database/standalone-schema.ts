/**
 * 独立部署（脱离妙搭）后新增的表。
 *
 * schema.ts 是从妙搭平台库反推、会被 gen:db-schema 覆盖的自动生成文件，新表不放那里。
 * 这些表在服务启动时以 IF NOT EXISTS 建出来（ensureStandaloneTable，见 ensure-standalone-table.ts）：
 * 登录对照表由 LoginAccountService、站内消息由 InboxService、开发需求三张表由 DevRequestsService 负责。
 * 不依赖平台的复合类型（user_profile 等），空库、整库导入的库都能建。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * 统一登录身份 → 妙搭 userId 对照表。
 *
 * 库里各业务表仍以妙搭 userId 做外键，登录换成 Authentik 后靠这张表把人对回原来的 userId。
 * 管理员先建行（login_name + miaoda_user_id），本人第一次用统一账号登录时按 login_name
 * 认领并写入 subject，此后只认 subject。
 */
export const workbenchLoginAccounts = pgTable('workbench_login_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 身份来源，目前只有 authentik */
  provider: varchar('provider', { length: 32 }).notNull().default('authentik'),
  /** OIDC sub，首次登录认领后写入；为空表示还没人认领 */
  subject: varchar('subject', { length: 255 }),
  /** 管理员预填的登录名：Authentik 用户名或邮箱（不区分大小写） */
  loginName: varchar('login_name', { length: 255 }),
  /** 登录时 IdP 给的邮箱；飞书通知没有 open_id 时按邮箱发 */
  email: varchar('email', { length: 255 }),
  /** 原妙搭 userId，业务表外键 */
  miaodaUserId: varchar('miaoda_user_id', { length: 64 }).notNull(),
  displayName: varchar('display_name', { length: 100 }),
  /** 本地授予的平台角色（boss / admin），与 Authentik 组映射出的角色取并集 */
  roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
  /** 最近一次登录时 IdP 给的组名 */
  idpGroups: text('idp_groups').array().notNull().default(sql`'{}'::text[]`),
  /** 自有飞书应用视角下的 open_id，通知优先用它 */
  feishuOpenId: varchar('feishu_open_id', { length: 64 }),
  enabled: boolean('enabled').notNull().default(true),
  note: text('note'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

/** 与上面定义一致的建表语句（逐条执行，均幂等） */
export const WORKBENCH_LOGIN_ACCOUNTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS workbench_login_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider varchar(32) NOT NULL DEFAULT 'authentik',
    subject varchar(255),
    login_name varchar(255),
    email varchar(255),
    miaoda_user_id varchar(64) NOT NULL,
    display_name varchar(100),
    roles text[] NOT NULL DEFAULT '{}'::text[],
    idp_groups text[] NOT NULL DEFAULT '{}'::text[],
    feishu_open_id varchar(64),
    enabled boolean NOT NULL DEFAULT true,
    note text,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_login_accounts_subject
    ON workbench_login_accounts (provider, subject) WHERE subject IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_login_accounts_login_name
    ON workbench_login_accounts (provider, lower(login_name)) WHERE login_name IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workbench_login_accounts_user
    ON workbench_login_accounts (miaoda_user_id)`,
];

/**
 * 站内消息：替代飞书通知的主通道（飞书只在 FEISHU_NOTIFY_ENABLED 打开时另发一份）。
 * 一人一行；收件人是妙搭 userId（与各业务表外键同口径），只能看、只能标自己的。
 */
export const workbenchNotifications = pgTable('workbench_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 收件人妙搭 userId */
  miaodaUserId: varchar('miaoda_user_id', { length: 64 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull().default(''),
  /** 站内跳转路径（前端路由，以 / 开头）；空 = 只看不跳 */
  link: varchar('link', { length: 500 }),
  /** task / task_review / block_defer / workorder / tutorial / dev_request / general */
  category: varchar('category', { length: 32 }).notNull().default('general'),
  readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const WORKBENCH_NOTIFICATIONS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS workbench_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    miaoda_user_id varchar(64) NOT NULL,
    title varchar(200) NOT NULL,
    body text NOT NULL DEFAULT '',
    link varchar(500),
    category varchar(32) NOT NULL DEFAULT 'general',
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workbench_notifications_user_created
    ON workbench_notifications (miaoda_user_id, created_at DESC)`,
  // 铃铛未读数每分钟查一次，走部分索引
  `CREATE INDEX IF NOT EXISTS idx_workbench_notifications_user_unread
    ON workbench_notifications (miaoda_user_id) WHERE read_at IS NULL`,
];

/**
 * 个人 API Key（2026-10-22 上线）：每个人签自己的 key 调 POST /openapi/mcp，调用身份 = key 主人本人。
 * 库里只存 sha256 digest，key 本体（wk_ 前缀）只在签发时展示一次；revoked_at 非空即失效。
 */
export const workbenchApiKeys = pgTable('workbench_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 主人工作台用户 ID（= ERP 员工 ID） */
  userId: varchar('user_id', { length: 64 }).notNull(),
  /** 备注名（如「我的 Codex」） */
  name: varchar('name', { length: 100 }).notNull().default(''),
  /** 展示用前缀（wk_ + 前 8 位），列表里给人认 */
  keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
  /** sha256(key) hex，查找与比对只用它 */
  keyDigest: varchar('key_digest', { length: 64 }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const WORKBENCH_API_KEYS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS workbench_api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id varchar(64) NOT NULL,
    name varchar(100) NOT NULL DEFAULT '',
    key_prefix varchar(16) NOT NULL,
    key_digest varchar(64) NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_api_keys_digest
    ON workbench_api_keys (key_digest)`,
  // 每人仅一把有效 key（2026-10-22 老板定）：更换 = 事务里吊销旧的签新的，这个索引兜底并发
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_api_keys_user_active
    ON workbench_api_keys (user_id) WHERE revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workbench_api_keys_user
    ON workbench_api_keys (user_id) WHERE revoked_at IS NULL`,
];

/**
 * OAuth 授权（2026-10-25 上线）：ChatGPT 网页版这类只能走 OAuth 的 MCP 客户端按 RFC 7591 自助注册成「应用」，
 * 员工在工作台授权页点同意后拿令牌调 POST /openapi/mcp，身份 = 授权的人（同个人 API Key）。
 * client_secret、授权码、刷新令牌库里只存 sha256；访问令牌（wkat_）签名自带不落库，靠授权行吊销。
 */
export const workbenchOauthClients = pgTable('workbench_oauth_clients', {
  /** client_id（随机，对外） */
  id: varchar('id', { length: 64 }).primaryKey(),
  /** client_secret 的 sha256 hex；公开客户端（token_endpoint_auth_method=none）为空 */
  secretDigest: varchar('secret_digest', { length: 64 }),
  authMethod: varchar('auth_method', { length: 32 }).notNull(),
  /** 应用自报的名字（可能是假的，授权页另写回调站点给人认） */
  clientName: varchar('client_name', { length: 100 }).notNull().default(''),
  redirectUris: text('redirect_uris').array().notNull(),
  /** 注册请求里其余字段原样留存（client_uri / logo_uri / software_id …） */
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  /** 最近一次签授权码；从没用过的注册 30 天后清掉 */
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const WORKBENCH_OAUTH_CLIENTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS workbench_oauth_clients (
    id varchar(64) PRIMARY KEY,
    secret_digest varchar(64),
    auth_method varchar(32) NOT NULL,
    client_name varchar(100) NOT NULL DEFAULT '',
    redirect_uris text[] NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

/** 授权码：一次性、几分钟有效，绑定应用、回调地址和 PKCE */
export const workbenchOauthCodes = pgTable('workbench_oauth_codes', {
  codeDigest: varchar('code_digest', { length: 64 }).primaryKey(),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: varchar('code_challenge', { length: 128 }).notNull(),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
  /** 换出的授权；同一张码再来换（可能被截获）就吊销它 */
  grantId: uuid('grant_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const WORKBENCH_OAUTH_CODES_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS workbench_oauth_codes (
    code_digest varchar(64) PRIMARY KEY,
    client_id varchar(64) NOT NULL,
    user_id varchar(64) NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge varchar(128) NOT NULL,
    resource text,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    grant_id uuid,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workbench_oauth_codes_expires
    ON workbench_oauth_codes (expires_at)`,
];

/** 授权：一个人对一个应用一行（再授权一次换新行、旧行吊销）；「我的」页列出来可收回 */
export const workbenchOauthGrants = pgTable('workbench_oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  scope: varchar('scope', { length: 100 }).notNull().default('mcp'),
  resource: text('resource'),
  refreshDigest: varchar('refresh_digest', { length: 64 }).notNull(),
  /** 公开客户端轮换刷新令牌时留的上一张：没收到新令牌、拿旧的重试还能换；用了新的这张它就作废 */
  prevRefreshDigest: varchar('prev_refresh_digest', { length: 64 }),
  /** 刷新令牌有效期，每次刷新顺延；过了要回 AI 工具里重新连接 */
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const WORKBENCH_OAUTH_GRANTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS workbench_oauth_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id varchar(64) NOT NULL,
    user_id varchar(64) NOT NULL,
    scope varchar(100) NOT NULL DEFAULT 'mcp',
    resource text,
    refresh_digest varchar(64) NOT NULL,
    prev_refresh_digest varchar(64),
    refresh_expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_oauth_grants_refresh
    ON workbench_oauth_grants (refresh_digest)`,
  `CREATE INDEX IF NOT EXISTS idx_workbench_oauth_grants_prev_refresh
    ON workbench_oauth_grants (prev_refresh_digest) WHERE prev_refresh_digest IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workbench_oauth_grants_user
    ON workbench_oauth_grants (user_id) WHERE revoked_at IS NULL`,
];

/**
 * 开发需求（2026-10-19 老板定）：A 发需求给 B → B 报工时和价格 → A 确认报价才开工 → B 交付 → A 验收。
 *
 * 状态以 Plane 为准（开发类项目的五步状态，按名字认），这张表存流程数据：谁发的、派给谁、当前有效的报价、
 * 谁确认的、最近一次交付、验收、撤销。expected_stage 是工作台最后一次把它挪到的环节，
 * 和 Plane 当前状态对不上就是有人在 Plane 里直接改了（详情页如实标出来）。
 * 价格只记账、不进钱包：验收通过记 dev_request_ledger 一笔，不写 reward_ledger。
 */
export const devRequests = pgTable('dev_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  planeProjectId: varchar('plane_project_id', { length: 64 }).notNull(),
  planeIssueId: varchar('plane_issue_id', { length: 64 }).notNull(),
  planeSequenceId: integer('plane_sequence_id'),
  /** 项目名快照（台账、列表用） */
  projectName: varchar('project_name', { length: 255 }).notNull().default(''),
  /** 标题快照（Plane 为准，发布时写入） */
  title: varchar('title', { length: 255 }).notNull(),
  /** 发布人工作台用户 ID（= ERP 员工 ID） */
  publisherId: varchar('publisher_id', { length: 64 }).notNull(),
  publisherName: varchar('publisher_name', { length: 100 }),
  /** 开发者工作台用户 ID 与对应的 Plane 成员（任务负责人） */
  developerId: varchar('developer_id', { length: 64 }).notNull(),
  developerName: varchar('developer_name', { length: 100 }),
  developerMemberId: varchar('developer_member_id', { length: 64 }).notNull(),
  /** submitted / clarifying / quoted / developing / reviewing / blocked / done / cancelled */
  expectedStage: varchar('expected_stage', { length: 20 })
    .notNull()
    .default('submitted'),
  /** 当前有效报价：被退回时清空（历史在事件里） */
  quoteHours: numeric('quote_hours', { precision: 10, scale: 2 }),
  quoteAmount: numeric('quote_amount', { precision: 12, scale: 2 }),
  quoteNote: text('quote_note'),
  quotePromisedDate: date('quote_promised_date', { mode: 'string' }),
  quotedAt: timestamp('quoted_at', { withTimezone: true, mode: 'date' }),
  quotedBy: varchar('quoted_by', { length: 64 }),
  quoteConfirmedAt: timestamp('quote_confirmed_at', {
    withTimezone: true,
    mode: 'date',
  }),
  quoteConfirmedBy: varchar('quote_confirmed_by', { length: 64 }),
  /** 最近一次交付：验收打回时清空（历史在事件里） */
  deliveryNote: text('delivery_note'),
  deliveryLinks: jsonb('delivery_links')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
  acceptedBy: varchar('accepted_by', { length: 64 }),
  finalAmount: numeric('final_amount', { precision: 12, scale: 2 }),
  adjustReason: text('adjust_reason'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  cancelledBy: varchar('cancelled_by', { length: 64 }),
  cancelReason: text('cancel_reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

/** 开发需求的事件历史：只追加，不改不删（详情页时间线） */
export const devRequestEvents = pgTable('dev_request_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  devRequestId: uuid('dev_request_id').notNull(),
  /** publish / quote / return / clarify / confirm_quote / reject_quote / deliver / block / unblock / accept / reject_delivery / cancel */
  action: varchar('action', { length: 32 }).notNull(),
  fromStage: varchar('from_stage', { length: 20 }),
  toStage: varchar('to_stage', { length: 20 }),
  actorId: varchar('actor_id', { length: 64 }),
  actorName: varchar('actor_name', { length: 100 }),
  /** publisher / developer / boss / other */
  actorRole: varchar('actor_role', { length: 16 }),
  note: text('note'),
  /** 报价数字、验收金额、交付链接等 */
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

/** 开发需求台账：验收通过记一笔（一条需求只记一次），只记账、不进钱包 */
export const devRequestLedger = pgTable('dev_request_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  devRequestId: uuid('dev_request_id').notNull(),
  planeProjectId: varchar('plane_project_id', { length: 64 }).notNull(),
  projectName: varchar('project_name', { length: 255 }).notNull().default(''),
  planeIssueId: varchar('plane_issue_id', { length: 64 }).notNull(),
  planeSequenceId: integer('plane_sequence_id'),
  title: varchar('title', { length: 255 }).notNull(),
  publisherId: varchar('publisher_id', { length: 64 }).notNull(),
  publisherName: varchar('publisher_name', { length: 100 }),
  developerId: varchar('developer_id', { length: 64 }).notNull(),
  developerName: varchar('developer_name', { length: 100 }),
  /** 确认过的报价 */
  quoteHours: numeric('quote_hours', { precision: 10, scale: 2 }).notNull(),
  quoteAmount: numeric('quote_amount', { precision: 12, scale: 2 }).notNull(),
  /** 验收金额：默认等于报价，改了要写 adjust_reason */
  finalAmount: numeric('final_amount', { precision: 12, scale: 2 }).notNull(),
  adjustReason: text('adjust_reason'),
  acceptedBy: varchar('accepted_by', { length: 64 }),
  acceptedByName: varchar('accepted_by_name', { length: 100 }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const DEV_REQUESTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS dev_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plane_project_id varchar(64) NOT NULL,
    plane_issue_id varchar(64) NOT NULL,
    plane_sequence_id integer,
    project_name varchar(255) NOT NULL DEFAULT '',
    title varchar(255) NOT NULL,
    publisher_id varchar(64) NOT NULL,
    publisher_name varchar(100),
    developer_id varchar(64) NOT NULL,
    developer_name varchar(100),
    developer_member_id varchar(64) NOT NULL,
    expected_stage varchar(20) NOT NULL DEFAULT 'submitted',
    quote_hours numeric(10,2),
    quote_amount numeric(12,2),
    quote_note text,
    quote_promised_date date,
    quoted_at timestamptz,
    quoted_by varchar(64),
    quote_confirmed_at timestamptz,
    quote_confirmed_by varchar(64),
    delivery_note text,
    delivery_links jsonb NOT NULL DEFAULT '[]'::jsonb,
    delivered_at timestamptz,
    accepted_at timestamptz,
    accepted_by varchar(64),
    final_amount numeric(12,2),
    adjust_reason text,
    cancelled_at timestamptz,
    cancelled_by varchar(64),
    cancel_reason text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  // 一条 Plane 任务只对应一条开发需求
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_requests_issue
    ON dev_requests (plane_issue_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dev_requests_publisher
    ON dev_requests (publisher_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_dev_requests_developer
    ON dev_requests (developer_id, created_at DESC)`,
];

export const DEV_REQUEST_EVENTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS dev_request_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dev_request_id uuid NOT NULL REFERENCES dev_requests (id),
    action varchar(32) NOT NULL,
    from_stage varchar(20),
    to_stage varchar(20),
    actor_id varchar(64),
    actor_name varchar(100),
    actor_role varchar(16),
    note text,
    detail jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dev_request_events_request
    ON dev_request_events (dev_request_id, created_at)`,
];

export const DEV_REQUEST_LEDGER_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS dev_request_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dev_request_id uuid NOT NULL REFERENCES dev_requests (id),
    plane_project_id varchar(64) NOT NULL,
    project_name varchar(255) NOT NULL DEFAULT '',
    plane_issue_id varchar(64) NOT NULL,
    plane_sequence_id integer,
    title varchar(255) NOT NULL,
    publisher_id varchar(64) NOT NULL,
    publisher_name varchar(100),
    developer_id varchar(64) NOT NULL,
    developer_name varchar(100),
    quote_hours numeric(10,2) NOT NULL,
    quote_amount numeric(12,2) NOT NULL,
    final_amount numeric(12,2) NOT NULL,
    adjust_reason text,
    accepted_by varchar(64),
    accepted_by_name varchar(100),
    accepted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  // 一条需求只记一次账：并发、连点验收时后到的撞唯一约束
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_request_ledger_request
    ON dev_request_ledger (dev_request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dev_request_ledger_accepted
    ON dev_request_ledger (accepted_at)`,
];

/**
 * erp_entry_tokens（表在 schema.ts）10-19 加的「工作台担保」列：已建好的库（线上）启动时由 ErpBridgeService 幂等补上，
 * 不用人工迁移；旧 token 这一列是默认的 false（ERP 照旧要输一次密码）。init-schema.sql 建表时就带。
 */
export const ERP_ENTRY_TOKENS_UPGRADE_DDL: string[] = [
  `ALTER TABLE erp_entry_tokens ADD COLUMN IF NOT EXISTS erp_verified boolean NOT NULL DEFAULT false`,
];

// ───────── 销售工作台 A 链（11-10）：派单验收补丁 + 外部 MCP 登记 ─────────

/**
 * work_orders / work_order_catalog（表在 schema.ts）补的列：业务线、关联对象、截止（日期 + 时刻）。
 * 已建好的库启动时由 WorkordersService 幂等补上，不用人工迁移；init-schema.sql 建表时就带。
 */
export const WORK_ORDERS_UPGRADE_DDL: string[] = [
  `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS business_line varchar(32)`,
  `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS subjects jsonb`,
  `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS due_at timestamptz(3)`,
];

export const WORK_ORDER_CATALOG_UPGRADE_DDL: string[] = [
  `ALTER TABLE work_order_catalog ADD COLUMN IF NOT EXISTS business_line varchar(32)`,
];

/**
 * 工单转交记录（A01-11）：转交时写清已做了什么、下一步、材料，接手人在工单里能看到。
 * 一次转交一行，只增不改。
 */
export const workOrderHandovers = pgTable('work_order_handovers', {
  id: uuid('id').primaryKey().defaultRandom(),
  workOrderId: uuid('work_order_id').notNull(),
  fromUserId: varchar('from_user_id', { length: 64 }),
  toUserId: varchar('to_user_id', { length: 64 }).notNull(),
  doneText: text('done_text').notNull(),
  nextText: text('next_text').notNull(),
  materialsText: text('materials_text').notNull().default(''),
  /** @type string[] */
  materialUrls: jsonb('material_urls').notNull().default(sql`'[]'::jsonb`),
  /** 谁点的转交（负责人本人，或老板 / 管理员代转） */
  operatorId: varchar('operator_id', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const WORK_ORDER_HANDOVERS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS work_order_handovers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id uuid NOT NULL,
    from_user_id varchar(64),
    to_user_id varchar(64) NOT NULL,
    done_text text NOT NULL,
    next_text text NOT NULL,
    materials_text text NOT NULL DEFAULT '',
    material_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    operator_id varchar(64),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_work_order_handovers_order
    ON work_order_handovers (work_order_id, created_at)`,
];

/**
 * 提交版本（A02-03 / A02-06）：工单交凭证、任务交材料，每交一次记一版，重提不覆盖。
 * subject_type = work_order（subject_id 是工单 uuid）/ task（Plane 任务 id）；版本号从 1 起，同一对象内唯一。
 */
export const submissionVersions = pgTable('submission_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  subjectType: varchar('subject_type', { length: 16 }).notNull(),
  subjectId: varchar('subject_id', { length: 64 }).notNull(),
  version: integer('version').notNull(),
  /** @type { items: { name: string, fileUrls: string[], note: string | null }[] } */
  content: jsonb('content').notNull().default(sql`'{}'::jsonb`),
  summary: text('summary'),
  submittedBy: varchar('submitted_by', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const SUBMISSION_VERSIONS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS submission_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type varchar(16) NOT NULL,
    subject_id varchar(64) NOT NULL,
    version integer NOT NULL,
    content jsonb NOT NULL DEFAULT '{}'::jsonb,
    summary text,
    submitted_by varchar(64),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_submission_versions_subject_version
    ON submission_versions (subject_type, subject_id, version)`,
];

/**
 * 验收记录（A02）：四类分开记——review 验收（通过 / 退回 / 拒绝，退回和拒绝必须写原因）、
 * research_pass 研究通过、business_approval 经营批准（只有管理员给；state 生效 / 暂停 / 已退出，变动记在 history）、
 * listing_confirm 上架确认。都指向具体那一版提交（version，没交过为空）。
 */
export const acceptanceRecords = pgTable('acceptance_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  subjectType: varchar('subject_type', { length: 16 }).notNull(),
  subjectId: varchar('subject_id', { length: 64 }).notNull(),
  kind: varchar('kind', { length: 32 }).notNull(),
  decision: varchar('decision', { length: 16 }).notNull(),
  version: integer('version'),
  submissionId: uuid('submission_id'),
  reason: text('reason'),
  scope: text('scope'),
  state: varchar('state', { length: 16 }),
  /** @type { action: string, at: string, by: string | null, reason: string | null }[] */
  history: jsonb('history').notNull().default(sql`'[]'::jsonb`),
  operatorId: varchar('operator_id', { length: 64 }),
  operatorName: varchar('operator_name', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const ACCEPTANCE_RECORDS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS acceptance_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type varchar(16) NOT NULL,
    subject_id varchar(64) NOT NULL,
    kind varchar(32) NOT NULL,
    decision varchar(16) NOT NULL,
    version integer,
    submission_id uuid,
    reason text,
    scope text,
    state varchar(16),
    history jsonb NOT NULL DEFAULT '[]'::jsonb,
    operator_id varchar(64),
    operator_name varchar(100),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_records_subject
    ON acceptance_records (subject_type, subject_id, created_at)`,
];

/**
 * 教程步骤提交的旧版本（A02-06 评估后做的最小改动）：tutorial_step_submissions 仍是一案例一步骤一行、
 * 重交原地更新（当前版本照旧从那张表读，审核流程不动），只是覆盖前把旧的那一版原样存到这里。
 */
export const tutorialStepSubmissionHistory = pgTable('tutorial_step_submission_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: integer('submission_id').notNull(),
  caseId: integer('case_id').notNull(),
  stepKey: varchar('step_key', { length: 64 }).notNull(),
  data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
  status: varchar('status', { length: 32 }).notNull(),
  reviewNote: text('review_note'),
  reviewedBy: varchar('reviewed_by', { length: 255 }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  submittedBy: varchar('submitted_by', { length: 255 }),
  submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const TUTORIAL_STEP_SUBMISSION_HISTORY_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS tutorial_step_submission_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id integer NOT NULL,
    case_id integer NOT NULL,
    step_key varchar(64) NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(32) NOT NULL,
    review_note text,
    reviewed_by varchar(255),
    reviewed_at timestamptz,
    submitted_by varchar(255),
    submitted_at timestamptz,
    archived_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tutorial_step_submission_history_case_step
    ON tutorial_step_submission_history (case_id, step_key)`,
];

/**
 * 外部 MCP 登记（A03-07 / A03-08）：名称、地址、密钥、用途、启停，「测试连接」真去连（initialize + tools/list）。
 * 密钥 AES-256-GCM 加密存（密钥由 AUTH_SESSION_SECRET 派生），接口从不回显，只告诉填没填。
 */
export const externalMcpServers = pgTable('external_mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  url: text('url').notNull(),
  /** 密钥放哪个请求头；空 = Authorization: Bearer */
  authHeader: varchar('auth_header', { length: 100 }),
  secretEnc: text('secret_enc'),
  purpose: text('purpose'),
  enabled: boolean('enabled').notNull().default(true),
  lastTestAt: timestamp('last_test_at', { withTimezone: true, mode: 'date' }),
  lastTestOk: boolean('last_test_ok'),
  lastTestMessage: text('last_test_message'),
  lastToolCount: integer('last_tool_count'),
  /** @type string[] */
  lastTools: jsonb('last_tools'),
  lastLatencyMs: integer('last_latency_ms'),
  createdBy: varchar('created_by', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const EXTERNAL_MCP_SERVERS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS external_mcp_servers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(100) NOT NULL,
    url text NOT NULL,
    auth_header varchar(100),
    secret_enc text,
    purpose text,
    enabled boolean NOT NULL DEFAULT true,
    last_test_at timestamptz,
    last_test_ok boolean,
    last_test_message text,
    last_tool_count integer,
    last_tools jsonb,
    last_latency_ms integer,
    created_by varchar(64),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_external_mcp_servers_name
    ON external_mcp_servers (lower(name))`,
];
