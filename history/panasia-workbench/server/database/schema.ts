/* eslint-disable */
/** auto generated, do not edit */
import { sql } from 'drizzle-orm';
import { boolean, date, foreignKey, index, integer, jsonb, numeric, pgTable, serial, text, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value})::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export type FileAttachment = {
  bucket_id: string;
  file_path: string;
};

export const fileAttachment = customType<{
  data: FileAttachment;
  driverData: string;
}>({
  dataType() {
    return 'file_attachment';
  },
  toDriver(value: FileAttachment) {
    return sql`ROW(${value.bucket_id},${value.file_path})::file_attachment`;
  },
  fromDriver(value: string): FileAttachment {
    const [bucketId, filePath] = value.slice(1, -1).split(',');
    return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
  },
});

export function escapeLiteral(str: string): string {
  return "'" + str.replace(/'/g, "''") + "'";
}

export const userProfileArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType() {
    return 'user_profile[]';
  },
  toDriver(value: string[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::user_profile[]`;
    }
    const elements = value.map(id => `ROW(${escapeLiteral(id)})::user_profile`).join(',');
    return sql.raw(`ARRAY[${elements}]::user_profile[]`);
  },
  fromDriver(value: string): string[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => m.slice(1, -1).split(',')[0].trim());
  },
});

export const fileAttachmentArray = customType<{
  data: FileAttachment[];
  driverData: string;
}>({
  dataType() {
    return 'file_attachment[]';
  },
  toDriver(value: FileAttachment[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::file_attachment[]`;
    }
    const elements = value.map(f =>
      `ROW(${escapeLiteral(f.bucket_id)},${escapeLiteral(f.file_path)})::file_attachment`
    ).join(',');
    return sql.raw(`ARRAY[${elements}]::file_attachment[]`);
  },
  fromDriver(value: string): FileAttachment[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => {
      const [bucketId, filePath] = m.slice(1, -1).split(',');
      return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
    });
  },
});

export const erpEntryTokens = pgTable("erp_entry_tokens", {
  token: varchar("token", { length: 64 }).primaryKey(),
  miaodaUserId: varchar("miaoda_user_id", { length: 64 }).notNull(),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  usedAt: customTimestamptz("used_at", { precision: 3 }),
  // 工作台担保（10-19 加）：开入口的是本人（不是演示视角）、工作台 ID 来自 ERP 身份、绑定的就是这个 ID。
  // 已建好的库启动时自动补列（ERP_ENTRY_TOKENS_UPGRADE_DDL），旧 token 为 false
  erpVerified: boolean("erp_verified").notNull().default(false),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const erpBindings = pgTable("erp_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  miaodaUserId: varchar("miaoda_user_id", { length: 64 }).notNull().unique(),
  erpUserId: varchar("erp_user_id", { length: 255 }).notNull(),
  erpUsername: varchar("erp_username", { length: 255 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_erp_bindings_miaoda_user").on(table.miaodaUserId),
]);

export const rewardLedger = pgTable("reward_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  beneficiary: userProfile("beneficiary").notNull(),
  amount: numeric("amount").notNull(),
  type: varchar("type", { length: 32 }).notNull(),
  sourceId: uuid("source_id"),
  note: varchar("note", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // Complex index: CREATE INDEX idx_reward_ledger_beneficiary ON reward_ledger USING btree (((beneficiary).user_id)),
  // Complex index: CREATE UNIQUE INDEX uq_reward_ledger_problem_bounty ON reward_ledger (type, source_id, ((beneficiary).user_id)) WHERE type = 'problem_bounty'（问题奖励一题只发一次，见 deploy/sql/init-schema.sql）,
  index("idx_reward_ledger_source").on(table.sourceId),
]);

export const hostedCustomers = pgTable("hosted_customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerName: varchar("customer_name", { length: 200 }).notNull(),
  dimension: varchar("dimension", { length: 50 }).notNull(),
  contactName: varchar("contact_name", { length: 100 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  content: text("content"),
  status: varchar("status", { length: 32 }).notNull().default('hosting'),
  owner: varchar("owner", { length: 255 }).notNull(),
  startedAt: date("started_at"),
  remark: text("remark"),
  legalPersonName: varchar("legal_person_name", { length: 100 }),
  mainDevicePhone: varchar("main_device_phone", { length: 50 }),
  mainEmail: varchar("main_email", { length: 200 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_hosted_customers_owner").on(table.owner),
  index("idx_hosted_customers_dimension").on(table.dimension),
]);

export const tutorialSkipRequests = pgTable("tutorial_skip_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: integer("case_id").notNull(),
  // 步骤编号 = Learning 课时的 pa_step_key（10-19 起，原来是 NocoBase 步骤数字 ID）
  stepId: varchar("step_id", { length: 64 }).notNull(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  reason: text("reason").notNull(),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  reviewerNote: text("reviewer_note"),
  reviewedBy: varchar("reviewed_by", { length: 255 }),
  reviewedAt: customTimestamptz("reviewed_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_tutorial_skip_requests_user").on(table.userId),
  index("idx_tutorial_skip_requests_status").on(table.status),
  uniqueIndex("uq_tutorial_skip_pending").on(table.caseId, table.stepId),
]);

/**
 * 教程案例：某个员工在学某套教程（10-19 从 NocoBase 搬回工作台库；教程内容在 Learning）。
 * ID 仍是数字，前端路由 /my/learning/case/:caseId 不用改。
 * 部分唯一索引 uq_tutorial_cases_active（同一人同一教程同一对象只能有一个进行中的）见 deploy/sql/init-schema.sql
 */
export const tutorialCases = pgTable("tutorial_cases", {
  id: serial("id").primaryKey(),
  // Learning 课程 name（课程上 pa_code 有值的才是工作台教程）
  lmsCourse: varchar("lms_course", { length: 140 }).notNull(),
  // 工作台用户 ID（= ERP 员工 ID）
  ownerUserId: varchar("owner_user_id", { length: 255 }).notNull(),
  clientName: varchar("client_name", { length: 255 }),
  // in_progress / completed / cancelled
  status: varchar("status", { length: 32 }).notNull().default('in_progress'),
  assignedBy: varchar("assigned_by", { length: 255 }),
  completedAt: customTimestamptz("completed_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_tutorial_cases_owner").on(table.ownerUserId),
  // Complex index: CREATE UNIQUE INDEX uq_tutorial_cases_active ON tutorial_cases (owner_user_id, lms_course, (COALESCE(client_name, ''))) WHERE status = 'in_progress'（见 deploy/sql/init-schema.sql）,
]);

/** 教程步骤材料提交与审核结果：一案例一步骤一行，重交原地更新（同 NocoBase 时期） */
export const tutorialStepSubmissions = pgTable("tutorial_step_submissions", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  // Learning 课时的 pa_step_key
  stepKey: varchar("step_key", { length: 64 }).notNull(),
  data: jsonb("data").notNull().default({}),
  // submitted / approved / rejected / skipped
  status: varchar("status", { length: 32 }).notNull(),
  reviewNote: text("review_note"),
  reviewedBy: varchar("reviewed_by", { length: 255 }),
  reviewedAt: customTimestamptz("reviewed_at", { precision: 3 }),
  submittedBy: varchar("submitted_by", { length: 255 }),
  submittedAt: customTimestamptz("submitted_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_tutorial_step_submissions_case_step").on(table.caseId, table.stepKey),
  index("idx_tutorial_step_submissions_status").on(table.status),
]);

export const sops = pgTable("sops", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  category: varchar("category", { length: 32 }).notNull().default('other'),
  sourceTaskId: varchar("source_task_id", { length: 255 }),
  sourceTitle: text("source_title"),
  authorName: varchar("author_name", { length: 255 }),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  wikiUrl: text("wiki_url"),
  syncError: text("sync_error"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_sops_status").on(table.status),
  index("idx_sops_category").on(table.category),
]);

export const blockDeferRequests = pgTable("block_defer_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: varchar("task_id", { length: 255 }).notNull(),
  projectId: varchar("project_id", { length: 255 }).notNull(),
  projectName: varchar("project_name", { length: 255 }).notNull(),
  title: text("title").notNull(),
  sequenceId: integer("sequence_id"),
  assigneeName: varchar("assignee_name", { length: 255 }).notNull(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  reason: text("reason").notNull(),
  resolution: text("resolution").notNull(),
  category: varchar("category", { length: 32 }).notNull().default('other'),
  deferMinutes: integer("defer_minutes").notNull().default(30),
  originalDeadline: varchar("original_deadline", { length: 8 }),
  requestedDeadline: varchar("requested_deadline", { length: 8 }).notNull(),
  aiOpinion: text("ai_opinion"),
  bossComment: text("boss_comment"),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  sopId: uuid("sop_id"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_block_defer_status").on(table.status),
  index("idx_block_defer_task_id").on(table.taskId),
]);

export const taskReviewQueue = pgTable("task_review_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: varchar("task_id", { length: 255 }).notNull().unique(),
  projectId: varchar("project_id", { length: 255 }).notNull(),
  projectName: varchar("project_name", { length: 255 }).notNull(),
  title: text("title").notNull(),
  assigneeName: varchar("assignee_name", { length: 255 }).notNull(),
  /**
   * @type string[]
   */
  evidenceUrls: jsonb("evidence_urls").notNull().default('[]'),
  submittedAt: customTimestamptz("submitted_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  sequenceId: integer("sequence_id"),
  targetDate: varchar("target_date", { length: 255 }),
  evidenceText: text("evidence_text"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("task_review_queue_task_id_key").on(table.taskId),
  index("idx_task_review_queue_status").on(table.status),
]);

export const agentConfigTasks = pgTable("agent_config_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  taskType: varchar("task_type", { length: 32 }).notNull().default('config'),
  instruction: text("instruction").notNull(),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  resultNote: text("result_note"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_agent_config_tasks_status").on(table.status),
]);

export const okrKeyResults = pgTable("okr_key_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  objectiveId: uuid("objective_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  unit: varchar("unit", { length: 20 }),
  targetValue: numeric("target_value").notNull().default('0'),
  currentValue: numeric("current_value").notNull().default('0'),
  sort: integer("sort").notNull().default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_okr_key_results_objective").on(table.objectiveId),
  foreignKey({
    columns: [table.objectiveId],
    foreignColumns: [okrObjectives.id],
    name: "okr_key_results_objective_id_fkey",
  }).onDelete("cascade"),
]);

export const okrObjectives = pgTable("okr_objectives", {
  id: uuid("id").primaryKey().defaultRandom(),
  period: varchar("period", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default('on_track'),
  sort: integer("sort").notNull().default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_okr_objectives_period").on(table.period),
]);

export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: varchar("action", { length: 100 }).notNull(),
  targetType: varchar("target_type", { length: 50 }),
  targetId: varchar("target_id", { length: 255 }),
  /**
   * @type { summary?: string, changes?: Record<string, unknown> }
   */
  detail: jsonb("detail"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_admin_audit_logs_action").on(table.action),
  index("idx_admin_audit_logs_created").on(table.createdAt),
]);

export const taskTemplates = pgTable("task_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  templateType: varchar("template_type", { length: 20 }).notNull().default('daily'),
  /**
   * @type { kind: "every_day" | "workdays" | "weekly", weekdays?: number[] }
   */
  schedule: jsonb("schedule").notNull(),
  planeProjectId: varchar("plane_project_id", { length: 64 }).notNull(),
  planeProjectName: varchar("plane_project_name", { length: 255 }).notNull(),
  assigneeMemberId: varchar("assignee_member_id", { length: 64 }),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_task_templates_type").on(table.templateType),
]);

export const tutorialTaskLinks = pgTable("tutorial_task_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: varchar("task_id", { length: 64 }).notNull().unique(),
  // Learning 课程 name（10-19 起；原列 nocobase_project_id integer）
  lmsCourse: varchar("lms_course", { length: 140 }).notNull(),
  projectName: varchar("project_name", { length: 255 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_tutorial_task_links_task").on(table.taskId),
]);

export const demoProfiles = pgTable("demo_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  miaodaUserId: varchar("miaoda_user_id", { length: 64 }).notNull().unique(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }),
  avatarUrl: text("avatar_url"),
  roleLabel: varchar("role_label", { length: 50 }),
  isDemoAccount: boolean("is_demo_account").notNull().default(true),
  enabled: boolean("enabled").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  note: text("note"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("demo_profiles_miaoda_user_id_key").on(table.miaodaUserId),
]);

export const systemConfigs = pgTable("system_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  configKey: varchar("config_key", { length: 100 }).notNull().unique(),
  /**
   * @type Record<string, unknown>
   */
  configValue: jsonb("config_value").notNull(),
  description: varchar("description", { length: 255 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("system_configs_config_key_key").on(table.configKey),
]);

export const improvementProjects = pgTable("improvement_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  problemId: uuid("problem_id"),
  planeProjectId: varchar("plane_project_id", { length: 64 }),
  planeProjectName: varchar("plane_project_name", { length: 255 }),
  title: varchar("title", { length: 255 }).notNull(),
  stage: varchar("stage", { length: 32 }).notNull().default('define'),
  ownerId: userProfile("owner_id"),
  expectedBenefit: text("expected_benefit"),
  planeProjectUrl: varchar("plane_project_url", { length: 500 }),
  observeStartedAt: customTimestamptz("observe_started_at", { precision: 3 }),
  observeUntil: customTimestamptz("observe_until", { precision: 3 }),
  closedAt: customTimestamptz("closed_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_improvement_stage").on(table.stage),
  index("idx_improvement_problem").on(table.problemId),
  foreignKey({
    columns: [table.problemId],
    foreignColumns: [problemPool.id],
    name: "improvement_projects_problem_id_fkey",
  }),
]);

export const problemPool = pgTable("problem_pool", {
  id: uuid("id").primaryKey().defaultRandom(),
  recurrenceKey: varchar("recurrence_key", { length: 255 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  category: varchar("category", { length: 50 }),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  affectedUsers: integer("affected_users").notNull().default(1),
  totalLossHours: numeric("total_loss_hours").notNull().default('0'),
  overdueCount: integer("overdue_count").notNull().default(0),
  lastOccurredAt: customTimestamptz("last_occurred_at", { precision: 3 }),
  status: varchar("status", { length: 32 }).notNull().default('candidate'),
  /**
   * @type { days7_count?: number, users?: number, loss_hours?: number, overdue_count?: number, manual?: boolean }
   */
  thresholdMet: jsonb("threshold_met"),
  manualFlagged: boolean("manual_flagged").notNull().default(false),
  reporterId: userProfile("reporter_id"),
  responseAt: customTimestamptz("response_at", { precision: 3 }),
  respondedAt: customTimestamptz("responded_at", { precision: 3 }),
  respondedBy: userProfile("responded_by"),
  rejectReason: text("reject_reason"),
  bountyAmount: numeric("bounty_amount").notNull().default('0'),
  sourceTaskId: varchar("source_task_id", { length: 64 }),
  repairedAt: customTimestamptz("repaired_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("problem_pool_recurrence_key_key").on(table.recurrenceKey),
]);

export const blockers = pgTable("blockers", {
  id: uuid("id").primaryKey().defaultRandom(),
  reporterId: userProfile("reporter_id"),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 50 }).notNull().default('other'),
  severity: varchar("severity", { length: 20 }).notNull().default('normal'),
  recurrenceKey: varchar("recurrence_key", { length: 255 }).notNull(),
  waitingFor: varchar("waiting_for", { length: 100 }),
  status: varchar("status", { length: 32 }).notNull().default('open'),
  taskId: varchar("task_id", { length: 64 }),
  lossHours: numeric("loss_hours"),
  resolvedAt: customTimestamptz("resolved_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_blockers_recurrence").on(table.recurrenceKey),
  index("idx_blockers_status").on(table.status),
]);

export const workOrderCatalog = pgTable("work_order_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  orderType: varchar("order_type", { length: 50 }).notNull(),
  complexity: varchar("complexity", { length: 20 }).notNull().default('medium'),
  /**
   * @type { key: string, name: string, required?: boolean, type?: string }[]
   */
  checklistTemplate: jsonb("checklist_template"),
  // 销售工作台 A01（11-10 加）：这类工单默认的业务线 used_goods / virtual_goods / tech_service。
  // 已建好的库启动时自动补列（WORK_ORDER_CATALOG_UPGRADE_DDL）
  businessLine: varchar("business_line", { length: 32 }),
  promptTemplate: text("prompt_template"),
  /**
   * @type { event?: string, conditions?: Record<string, string> }
   */
  autoTriggerRules: jsonb("auto_trigger_rules"),
  erpAction: varchar("erp_action", { length: 100 }),
  /**
   * @type { roles?: string[], user_ids?: string[] }
   */
  notifyTargets: jsonb("notify_targets"),
  enabled: boolean("enabled").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("work_order_catalog_code_key").on(table.code),
]);

export const workOrderEvents = pgTable("work_order_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workOrderId: uuid("work_order_id").notNull(),
  fromStatus: varchar("from_status", { length: 32 }),
  toStatus: varchar("to_status", { length: 32 }).notNull(),
  operatorType: varchar("operator_type", { length: 32 }).notNull(),
  operatorId: userProfile("operator_id"),
  comment: text("comment"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_wo_events_order").on(table.workOrderId),
  foreignKey({
    columns: [table.workOrderId],
    foreignColumns: [workOrders.id],
    name: "work_order_events_work_order_id_fkey",
  }),
]);

export const workOrderEvidence = pgTable("work_order_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  workOrderId: uuid("work_order_id").notNull(),
  itemKey: varchar("item_key", { length: 100 }).notNull(),
  itemName: varchar("item_name", { length: 255 }),
  /**
   * @type string[]
   */
  fileUrls: jsonb("file_urls"),
  note: text("note"),
  submittedBy: userProfile("submitted_by"),
  aiCheckStatus: varchar("ai_check_status", { length: 32 }).notNull().default('pending'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_wo_evidence_order").on(table.workOrderId),
  foreignKey({
    columns: [table.workOrderId],
    foreignColumns: [workOrders.id],
    name: "work_order_evidence_work_order_id_fkey",
  }),
]);

export const workOrders = pgTable("work_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  catalogCode: varchar("catalog_code", { length: 100 }).notNull().default('other'),
  orderType: varchar("order_type", { length: 50 }).notNull().default('other'),
  complexity: varchar("complexity", { length: 20 }).notNull().default('medium'),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  assigneeId: userProfile("assignee_id"),
  taskId: varchar("task_id", { length: 64 }),
  prompt: text("prompt"),
  /**
   * @type { contact?: string, urgency?: string, report_points?: string[] }
   */
  contactBossFields: jsonb("contact_boss_fields"),
  /**
   * @type { key: string, name: string, required?: boolean, type?: string }[]
   */
  checklist: jsonb("checklist"),
  tutorialId: varchar("tutorial_id", { length: 64 }),
  /**
   * @type { title?: string, steps?: string[], generated?: boolean }
   */
  specialTutorial: jsonb("special_tutorial"),
  /**
   * @type { verdict?: string, checked_items?: { name: string, pass: boolean }[], summary?: string, at?: string }
   */
  aiVerdict: jsonb("ai_verdict"),
  /**
   * @type { result?: string, comment?: string, at?: string }
   */
  humanVerdict: jsonb("human_verdict"),
  ailyChatId: varchar("aily_chat_id", { length: 255 }),
  autoGenerated: boolean("auto_generated").notNull().default(false),
  source: varchar("source", { length: 32 }).notNull().default('manual'),
  idempotencyKey: varchar("idempotency_key", { length: 255 }),
  erpDocType: varchar("erp_doc_type", { length: 100 }),
  erpDocName: varchar("erp_doc_name", { length: 255 }),
  remark: text("remark"),
  // 销售工作台 A01（11-10 加）：业务线、关联对象、截止（日期 + 时刻，跨天的活用）。
  // 已建好的库启动时自动补列（WORK_ORDERS_UPGRADE_DDL），老工单三列为空
  businessLine: varchar("business_line", { length: 32 }),
  /**
   * @type { kind: string, name: string, ref?: string }[]
   */
  subjects: jsonb("subjects"),
  dueAt: customTimestamptz("due_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("work_orders_code_key").on(table.code),
  index("idx_work_orders_status").on(table.status),
  index("idx_work_orders_catalog").on(table.catalogCode),
  // Complex index: CREATE INDEX idx_work_orders_assignee ON work_orders USING btree (((assignee_id).user_id)),
]);

export const taskAgentDelegations = pgTable("task_agent_delegations", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: varchar("task_id", { length: 64 }).notNull(),
  agentId: uuid("agent_id").notNull(),
  prompt: text("prompt").notNull(),
  status: varchar("status", { length: 32 }).notNull().default('running'),
  ailySessionId: varchar("aily_session_id", { length: 255 }),
  ailyChatId: varchar("aily_chat_id", { length: 255 }),
  resultText: text("result_text"),
  resultSummary: text("result_summary"),
  errorMessage: text("error_message"),
  taskTitle: varchar("task_title", { length: 255 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_task_agent_delegations_task").on(table.taskId),
  // Complex index: CREATE INDEX idx_task_agent_delegations_created_by ON task_agent_delegations USING btree (((_created_by).user_id)),
]);

export const workbenchAgents = pgTable("workbench_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }),
  ailyAgentId: varchar("aily_agent_id", { length: 255 }),
  enabled: boolean("enabled").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_workbench_agents_code").on(table.code),
]);

export const employeeBindings = pgTable("employee_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  miaodaUserId: varchar("miaoda_user_id", { length: 64 }).notNull().unique(),
  planeMemberId: varchar("plane_member_id", { length: 64 }).notNull(),
  planeMemberName: varchar("plane_member_name", { length: 255 }),
  role: varchar("role", { length: 50 }).notNull().default('general'),
  frappeEmployeeId: varchar("frappe_employee_id", { length: 255 }),
  nocobaseUserId: varchar("nocobase_user_id", { length: 64 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_employee_bindings_miaoda_user").on(table.miaodaUserId),
]);

// table aliases
export const adminAuditLogsTable = adminAuditLogs;
export const agentConfigTasksTable = agentConfigTasks;
export const blockDeferRequestsTable = blockDeferRequests;
export const blockersTable = blockers;
export const demoProfilesTable = demoProfiles;
export const employeeBindingsTable = employeeBindings;
export const erpBindingsTable = erpBindings;
export const erpEntryTokensTable = erpEntryTokens;
export const hostedCustomersTable = hostedCustomers;
export const improvementProjectsTable = improvementProjects;
export const okrKeyResultsTable = okrKeyResults;
export const okrObjectivesTable = okrObjectives;
export const problemPoolTable = problemPool;
export const rewardLedgerTable = rewardLedger;
export const sopsTable = sops;
export const systemConfigsTable = systemConfigs;
export const taskAgentDelegationsTable = taskAgentDelegations;
export const taskReviewQueueTable = taskReviewQueue;
export const taskTemplatesTable = taskTemplates;
export const tutorialCasesTable = tutorialCases;
export const tutorialSkipRequestsTable = tutorialSkipRequests;
export const tutorialStepSubmissionsTable = tutorialStepSubmissions;
export const tutorialTaskLinksTable = tutorialTaskLinks;
export const workOrderCatalogTable = workOrderCatalog;
export const workOrderEventsTable = workOrderEvents;
export const workOrderEvidenceTable = workOrderEvidence;
export const workOrdersTable = workOrders;
export const workbenchAgentsTable = workbenchAgents;
