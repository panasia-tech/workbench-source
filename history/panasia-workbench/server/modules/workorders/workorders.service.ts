import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { UserDirectoryService } from '../auth/user-directory.service';
import { and, asc, count, desc, eq, inArray, like, max, ne } from 'drizzle-orm';
import {
  employeeBindings,
  systemConfigs,
  workOrderCatalog,
  workOrderEvents,
  workOrderEvidence,
  workOrders,
} from '@server/database/schema';
import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  WORK_ORDERS_UPGRADE_DDL,
  WORK_ORDER_CATALOG_UPGRADE_DDL,
  WORK_ORDER_HANDOVERS_DDL,
  workOrderHandovers,
} from '@server/database/standalone-schema';
import type {
  AcceptanceRecordView,
  AdminWorkOrderCreateRequest,
  AdminWorkOrderDeleteResponse,
  AdminWorkOrderDraftRow,
  AdminWorkOrderDraftsResponse,
  AdminWorkOrderPublishResponse,
  AdminWorkOrderQueueResponse,
  CreateWorkOrderRequest,
  CreateWorkOrderResponse,
  SubmitEvidenceRequest,
  WorkOrderActionResult,
  SubmissionVersionView,
  WorkOrderAiVerdict,
  WorkOrderAiVerdictKind,
  WorkOrderCatalogItem,
  WorkOrderCatalogResponse,
  WorkOrderChecklistItem,
  WorkOrderComplexity,
  WorkOrderContactBossFields,
  WorkOrderDetail,
  WorkOrderDetailResponse,
  WorkOrderEvidenceItem,
  WorkOrderEventView,
  WorkOrderHandoverCandidatesResponse,
  WorkOrderHandoverRequest,
  WorkOrderHandoverView,
  WorkOrderHumanVerdict,
  WorkOrderPriority,
  WorkOrderSource,
  WorkOrderSpecialTutorial,
  WorkOrderStatus,
  WorkOrderSummary,
  WorkOrderTransitionRequest,
  WorkOrderType,
  WorkOrdersResponse,
} from '@shared/api.interface';
import { AilyOpenApiService } from '../integration/aily-openapi.service';
import { isFeatureEnabled } from '../integration/optional-features';
import { NotifyService } from '../integration/notify.service';
import { PlaneService } from '../integration/plane.service';
import { DevRequestLookupService } from '../dev-requests/dev-request-lookup.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskViewer } from '../tasks/task-viewer';
import { AcceptanceService } from '../acceptance/acceptance.service';
import {
  planeTargetDate,
  priorityFromNote,
  priorityNote,
  resolveDispatchFields,
} from './dispatch-fields';
import {
  parseBusinessLine,
  parseChecklist,
  parseSubjects,
} from './workorder-fields';

type OrderRow = typeof workOrders.$inferSelect;
type EvidenceRow = typeof workOrderEvidence.$inferSelect;
type EventRow = typeof workOrderEvents.$inferSelect;
type CatalogRow = typeof workOrderCatalog.$inferSelect;
type HandoverRow = typeof workOrderHandovers.$inferSelect;

/** 能转交的状态：还在员工手里的（送审中、已结的不能转） */
const HANDOVER_STATUSES = ['pending', 'executing', 'needs_revision'] as const;
const HANDOVER_TEXT_MAX = 2000;
const HANDOVER_URLS_MAX = 20;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface PlaneIssueAssigneesRaw {
  id: string;
  assignees?: string[];
}

interface PlaneProjectRaw {
  id: string;
  name: string;
}

interface PlaneLabelRaw {
  id: string;
  name: string;
}

const WORK_ORDER_STATUSES = [
  'draft',
  'pending',
  'executing',
  'pending_submit',
  'ai_reviewing',
  'needs_revision',
  'rejected',
  'pending_boss',
  'approved',
  'refused',
] as const;
type StatusString = (typeof WORK_ORDER_STATUSES)[number];

const OPERATOR_TYPES = [
  'user',
  'ai',
  'boss',
  'webhook',
  'system',
] as const;
type OperatorTypeString = (typeof OPERATOR_TYPES)[number];

const ORDER_TYPES = [
  'purchase',
  'sales',
  'special_delegation',
  'other',
] as const;

const COMPLEXITIES = ['simple', 'medium', 'complex'] as const;

// 与 shared WorkOrderSource 的 5 个字面量完全一致
const SOURCES = ['manual', 'webhook', 'ai', 'auto_event', 'mcp'] as const;

/** 工单任务卡默认落在名称含该关键词的 Plane 项目（与委派任务同款找法） */
const ROUTINE_PROJECT_KEYWORD = '日常执行';
/** 工单任务卡标签全名，Plane 匹配为 includes 口径；不存在时自动创建 */
const WORK_ORDER_LABEL_NAME = '工单任务';
const WORK_ORDER_LABEL_COLOUR = '#2563eb';

/** 在途工单态：计入员工负载（未结工单数） */
const ACTIVE_ORDER_STATUSES = [
  'pending',
  'executing',
  'pending_submit',
  'ai_reviewing',
  'needs_revision',
] as const;

interface AdminWorkOrderUserContextLike {
  userId?: string;
  appId?: string;
}

const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  draft: '草稿',
  pending: '待执行',
  executing: '执行中',
  pending_submit: '待提交',
  ai_reviewing: 'AI初审中',
  needs_revision: '需修改',
  rejected: '已驳回',
  pending_boss: '待老板终审',
  approved: '已通过',
  refused: '已拒绝',
};

interface TransitionRule {
  from: StatusString[];
  to: StatusString;
}

// 状态机流转表（蓝图 §3，9 态强校验）
const TRANSITIONS: Record<WorkOrderTransitionRequest['action'], TransitionRule> =
  {
    start: { from: ['pending'], to: 'executing' },
    revoke_submit: { from: ['pending_submit'], to: 'executing' },
    resubmit: { from: ['needs_revision'], to: 'executing' },
    confirm_review: { from: ['ai_reviewing'], to: 'pending_boss' },
    return_revision: { from: ['pending_boss', 'refused'], to: 'needs_revision' },
  };

const TRANSITION_MESSAGES: Record<
  WorkOrderTransitionRequest['action'],
  string
> = {
  start: '工单已开始执行',
  revoke_submit: '已撤回提交，回到执行中',
  resubmit: '已重新进入执行，请补充凭证后提交',
  confirm_review: 'AI 初审完成，已提交老板终审',
  return_revision: '已退回需修改',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth += 1
  ) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item: unknown): item is string => typeof item === 'string');
}

function parseCheckedItems(
  value: unknown,
): { name: string; pass: boolean }[] {
  if (!Array.isArray(value)) return [];
  const items: { name: string; pass: boolean }[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.name !== 'string' || typeof raw.pass !== 'boolean') continue;
    items.push({ name: raw.name, pass: raw.pass });
  }
  return items;
}

function parseAiVerdict(value: unknown): WorkOrderAiVerdict | null {
  if (!isRecord(value)) return null;
  const verdict: WorkOrderAiVerdict = {};
  if (
    value.verdict === 'pass' ||
    value.verdict === 'reject' ||
    value.verdict === 'revise' ||
    value.verdict === 'need_human'
  ) {
    verdict.verdict = value.verdict;
  }
  if (Array.isArray(value.checkedItems)) {
    verdict.checkedItems = parseCheckedItems(value.checkedItems);
  }
  if (typeof value.summary === 'string') verdict.summary = value.summary;
  if (typeof value.at === 'string') verdict.at = value.at;
  if (value.engine === 'rule' || value.engine === 'aily') {
    verdict.engine = value.engine;
  }
  return verdict;
}

function parseHumanVerdict(value: unknown): WorkOrderHumanVerdict | null {
  if (!isRecord(value)) return null;
  const verdict: WorkOrderHumanVerdict = {};
  if (
    value.result === 'approved' ||
    value.result === 'refused' ||
    value.result === 'returned'
  ) {
    verdict.result = value.result;
  }
  if (typeof value.comment === 'string') verdict.comment = value.comment;
  if (typeof value.at === 'string') verdict.at = value.at;
  return verdict;
}

function parseContactBossFields(
  value: unknown,
): WorkOrderContactBossFields | null {
  if (!isRecord(value)) return null;
  const fields: WorkOrderContactBossFields = {};
  if (typeof value.contact === 'string') fields.contact = value.contact;
  if (typeof value.urgency === 'string') fields.urgency = value.urgency;
  if (Array.isArray(value.reportPoints)) {
    fields.reportPoints = parseStringArray(value.reportPoints);
  }
  return fields;
}

function parseSpecialTutorial(
  value: unknown,
): WorkOrderSpecialTutorial | null {
  if (!isRecord(value)) return null;
  const tutorial: WorkOrderSpecialTutorial = {};
  if (typeof value.title === 'string') tutorial.title = value.title;
  if (Array.isArray(value.steps)) tutorial.steps = parseStringArray(value.steps);
  if (typeof value.generated === 'boolean') tutorial.generated = value.generated;
  return tutorial;
}

function parseAutoTriggerRules(
  value: unknown,
): WorkOrderCatalogItem['autoTriggerRules'] {
  if (!isRecord(value)) return null;
  const rules: { event?: string; conditions?: Record<string, string> } = {};
  if (typeof value.event === 'string') rules.event = value.event;
  if (isRecord(value.conditions)) {
    const conditions: Record<string, string> = {};
    for (const [key, val] of Object.entries(value.conditions)) {
      if (typeof val === 'string') conditions[key] = val;
    }
    rules.conditions = conditions;
  }
  return rules;
}

function parseNotifyTargets(
  value: unknown,
): WorkOrderCatalogItem['notifyTargets'] {
  if (!isRecord(value)) return null;
  const targets: { roles?: string[]; userIds?: string[] } = {};
  if (Array.isArray(value.roles)) targets.roles = parseStringArray(value.roles);
  if (Array.isArray(value.user_ids)) {
    targets.userIds = parseStringArray(value.user_ids);
  }
  return targets;
}

function toStatus(value: string | null): WorkOrderStatus | null {
  const found = WORK_ORDER_STATUSES.find((s: StatusString) => s === value);
  return found ?? null;
}

function toOperatorType(value: string): OperatorTypeString {
  const found = OPERATOR_TYPES.find((t: OperatorTypeString) => t === value);
  return found ?? 'system';
}

function toOrderType(value: string): WorkOrderType {
  const found = ORDER_TYPES.find((t: WorkOrderType) => t === value);
  return found ?? 'other';
}

function toComplexity(value: string): WorkOrderComplexity {
  const found = COMPLEXITIES.find((c: WorkOrderComplexity) => c === value);
  return found ?? 'medium';
}

function toSource(value: string): WorkOrderSource {
  const found = SOURCES.find((s: WorkOrderSource) => s === value);
  return found ?? 'manual';
}

const AI_REVIEW_CONFIG_KEY = 'workorder.ai_review_agent_id';
/** 老板侧通知接收人（值形如 { user_ids: [...] }），未配置则跳过通知 */
const BOSS_NOTIFY_CONFIG_KEY = 'workorder.boss_notify_user_ids';
/** 工单 SLA 小时数配置：数字（全体状态）或 { <status>: hours } 按状态 */
const SLA_CONFIG_KEY = 'workorder.sla_hours';
/** SLA 终结态：这些状态不再计算超时 */
const SLA_TERMINAL_STATUSES = ['approved', 'refused', 'rejected'] as const;
const AI_POLL_TOTAL_LIMIT_MS = 45_000;
const AI_POLL_FIRST_DELAY_MS = 2_000;
const AI_POLL_MAX_DELAY_MS = 5_000;
/** ai_reviewing 超过该时长未回写（进程重启丢异步任务）→ 查详情时自动降级老板终审 */
const AI_REVIEW_STALE_MS = 3 * 60_000;

const ORDER_TYPE_LABELS: Record<WorkOrderType, string> = {
  purchase: '采购',
  sales: '销售',
  special_delegation: '特殊委派',
  other: '其他',
};

const COMPLEXITY_LABELS: Record<WorkOrderComplexity, string> = {
  simple: '简单',
  medium: '中等',
  complex: '复杂',
};

const AI_VERDICT_LABELS: Record<WorkOrderAiVerdictKind, string> = {
  pass: '通过',
  revise: '退回修改',
  reject: '不通过',
  need_human: '无法判断',
};

interface AiReviewAgentConfig {
  agent_id?: unknown;
}

interface BossNotifyConfig {
  user_ids?: unknown;
  userIds?: unknown;
}

/** SLA 配置解析：数字 → 全体状态；对象 → 按状态取值，缺省回退 default 键 */
function resolveSlaHoursFromConfig(
  config: unknown,
  status: string,
): number | null {
  if (typeof config === 'number' && config > 0) return config;
  if (isRecord(config)) {
    const perStatus = config[status];
    if (typeof perStatus === 'number' && perStatus > 0) return perStatus;
    const fallback = config.default;
    if (typeof fallback === 'number' && fallback > 0) return fallback;
  }
  return null;
}

interface AiGateLaunch {
  orderId: string;
  code: string;
  agentId: string;
  title: string;
  typeLabel: string;
  complexityLabel: string;
  checklist: WorkOrderChecklistItem[];
  evidence: EvidenceRow[];
  checkedItems: WorkOrderAiVerdict['checkedItems'];
  gateAt: string;
}

interface AiGateOutcome {
  status: 'pending_boss' | 'needs_revision';
  verdict: WorkOrderAiVerdictKind;
  comment: string;
  summary: string;
}

@Injectable()
export class WorkordersService implements OnModuleInit {
  private readonly logger = new Logger(WorkordersService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly userDirectory: UserDirectoryService,
    private readonly aily: AilyOpenApiService,
    private readonly notify: NotifyService,
    private readonly plane: PlaneService,
    private readonly tasksService: TasksService,
    private readonly devRequestLookup: DevRequestLookupService,
    private readonly acceptance: AcceptanceService,
  ) {}

  /** 11-10 销售工作台 A01：已建好的库补列（业务线、关联对象、截止）、建转交记录表，都幂等 */
  async onModuleInit(): Promise<void> {
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'work_orders',
      WORK_ORDERS_UPGRADE_DDL,
      '工单读写会报错（缺业务线 / 关联对象 / 截止列），先手工跑 deploy/sql/upgrade-1110-workorder-acceptance.sql',
    );
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'work_order_catalog',
      WORK_ORDER_CATALOG_UPGRADE_DDL,
      '工单目录读写会报错（缺业务线列），先手工跑 deploy/sql/upgrade-1110-workorder-acceptance.sql',
    );
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'work_order_handovers',
      WORK_ORDER_HANDOVERS_DDL,
      '工单转交不可用',
    );
  }

  // ==================== 查询 ====================

  async listForUser(
    userId: string,
    params: {
      status?: string;
      taskId?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<WorkOrdersResponse> {
    const conditions = [
      eq(workOrders.assigneeId, userId),
      ne(workOrders.status, 'draft'),
    ];
    if (params.status) conditions.push(eq(workOrders.status, params.status));
    if (params.taskId) conditions.push(eq(workOrders.taskId, params.taskId));
    const where = and(...conditions);

    const countRows = await this.db
      .select({ total: count() })
      .from(workOrders)
      .where(where);
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(where)
      .orderBy(desc(workOrders.createdAt))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize);

    const names = await this.loadCatalogNames(
      rows.map((row: OrderRow) => row.catalogCode),
    );
    return {
      items: rows.map((row: OrderRow) =>
        this.toSummary(row, names.get(row.catalogCode) ?? null),
      ),
      total: countRows[0]?.total ?? 0,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  async getCatalog(): Promise<WorkOrderCatalogResponse> {
    const rows: CatalogRow[] = await this.db
      .select()
      .from(workOrderCatalog)
      .where(eq(workOrderCatalog.enabled, true))
      .orderBy(workOrderCatalog.sort, workOrderCatalog.code);
    return { items: rows.map((row: CatalogRow) => this.toCatalogItem(row)) };
  }

  async getDetail(
    userId: string,
    id: string,
  ): Promise<WorkOrderDetailResponse> {
    const row = await this.loadOwnedOrder(userId, id);
    const healed = await this.healStaleAiReview(row);
    const detail = await this.buildDetail(healed);
    return { workOrder: detail };
  }

  // ==================== 创建 ====================

  async create(
    viewer: TaskViewer,
    dto: CreateWorkOrderRequest,
  ): Promise<CreateWorkOrderResponse> {
    const userId = viewer.userId;
    // 员工建的单是自己做的（「我的工单」只列、流转只认负责人本人）：负责人不传默认本人，传了别人 403，
    // 给同事派活走老板发单（管理端 / 豆包 MCP，不经这里）；boss/admin 本人不限
    const assigneeId = dto.assigneeId ?? userId;
    if (!viewer.fullAccess && assigneeId !== userId) {
      throw new ForbiddenException(
        '只能建自己负责的工单，派给别人请找老板发单',
      );
    }
    // 关联任务只能挂自己的：终审通过会把关联任务置完成，不能借工单改别人的任务
    if (dto.taskId) {
      await this.tasksService.assertOperableTask(dto.taskId, viewer);
      // 开发需求不能挂工单：工单终审会把关联任务直接置完成，绕过开发需求的验收和记账
      if (await this.devRequestLookup.findByIssueId(dto.taskId)) {
        throw new BadRequestException(
          '开发需求不能挂工单：报价、交付、验收都在「开发需求」页里做',
        );
      }
    }
    const catalogRows: CatalogRow[] = await this.db
      .select()
      .from(workOrderCatalog)
      .where(eq(workOrderCatalog.code, dto.catalogCode))
      .limit(1);
    const catalog = catalogRows[0];
    if (!catalog || !catalog.enabled) {
      throw new BadRequestException('工单种类不存在或已停用');
    }

    const checklist = parseChecklist(catalog.checklistTemplate);
    const row = await this.insertOrderWithCodeRetry(
      (code: string): typeof workOrders.$inferInsert => ({
        code,
        title: dto.title,
        catalogCode: catalog.code,
        orderType: catalog.orderType,
        complexity: catalog.complexity,
        status: 'pending',
        assigneeId,
        businessLine:
          dto.businessLine ?? parseBusinessLine(catalog.businessLine),
        subjects: parseSubjects(dto.subjects),
        ...(dto.taskId !== undefined ? { taskId: dto.taskId } : {}),
        ...(catalog.promptTemplate !== null
          ? { prompt: catalog.promptTemplate }
          : {}),
        contactBossFields: dto.contactBossFields ?? null,
        checklist,
        autoGenerated: false,
        source: 'manual',
        ...(dto.remark !== undefined ? { remark: dto.remark } : {}),
      }),
    );

    await this.db.insert(workOrderEvents).values({
      workOrderId: row.id,
      fromStatus: null,
      toStatus: 'pending',
      operatorType: 'user',
      operatorId: userId,
      comment: '工单创建',
    });

    const detail = this.toDetail(row, [], []);
    return { workOrder: detail };
  }

  // ==================== 管理端发单 / 草稿箱 / 队列 ====================

  async createFromBoss(
    operatorUserId: string,
    dto: AdminWorkOrderCreateRequest,
  ): Promise<CreateWorkOrderResponse> {
    const catalogRows: CatalogRow[] = await this.db
      .select()
      .from(workOrderCatalog)
      .where(eq(workOrderCatalog.code, dto.catalogCode))
      .limit(1);
    const catalog = catalogRows[0];
    if (!catalog || !catalog.enabled) {
      throw new BadRequestException('工单种类不存在或已停用');
    }

    const status: StatusString = dto.saveAsDraft ? 'draft' : 'pending';
    // 时效拼进标题「HH:mm前」（工单与任务卡同一个标题），立即发布时截止时刻必须晚于现在；
    // 跨天的活带截止日期，任务卡 target_date 跟着日期走
    const fields = resolveDispatchFields(dto, {
      checkPassed: status !== 'draft',
    });
    const checklist = parseChecklist(catalog.checklistTemplate);
    // 立即发布：先建 Plane 任务卡，失败则整单失败（不落库，杜绝无任务卡的孤儿工单）；
    // 草稿分支不建任务卡，发布时再补
    let planeTaskId: string | null = null;
    if (status !== 'draft') {
      planeTaskId = await this.createLinkedPlaneTask({
        title: fields.title,
        assigneeId: dto.assigneeId ?? operatorUserId,
        priority: fields.priority,
        targetDate: planeTargetDate(fields.dueAt),
      });
    }
    const row = await this.insertOrderWithCodeRetry(
      (code: string): typeof workOrders.$inferInsert => ({
        code,
        title: fields.title,
        catalogCode: catalog.code,
        orderType: catalog.orderType,
        complexity: catalog.complexity,
        status,
        assigneeId: dto.assigneeId ?? operatorUserId,
        taskId: planeTaskId,
        businessLine:
          dto.businessLine ?? parseBusinessLine(catalog.businessLine),
        subjects: parseSubjects(dto.subjects),
        dueAt: fields.dueAt,
        ...(catalog.promptTemplate !== null
          ? { prompt: catalog.promptTemplate }
          : {}),
        contactBossFields: null,
        checklist,
        autoGenerated: false,
        source: dto.source ?? 'manual',
        ...(dto.remark !== undefined ? { remark: dto.remark } : {}),
      }),
    );

    await this.db.insert(workOrderEvents).values({
      workOrderId: row.id,
      fromStatus: null,
      toStatus: status,
      operatorType: 'boss',
      operatorId: operatorUserId,
      // 工单表没有优先级列：草稿的优先级靠这条备注带到发布时（publishDraft 读回）
      comment: `${
        dto.saveAsDraft ? '存入草稿箱（员工暂不可见）' : '发布工单，进入执行队列'
      } · ${priorityNote(fields.priority)}`,
    });

    if (status !== 'draft') {
      void this.notifyAssigneeNewOrder(row);
    }

    return { workOrder: this.toDetail(row, [], []) };
  }

  async listDrafts(
    userContext: AdminWorkOrderUserContextLike,
  ): Promise<AdminWorkOrderDraftsResponse> {
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.status, 'draft'))
      .orderBy(desc(workOrders.createdAt));
    if (rows.length === 0) return { items: [] };

    const [catalogNames, nameMap, activeCounts] = await Promise.all([
      this.loadCatalogNames(
        rows.map((row: OrderRow) => row.catalogCode),
      ),
      this.resolveUserNames(
        userContext,
        rows.map((row: OrderRow) => row.assigneeId),
      ),
      this.countActiveOrdersByAssignee(),
    ]);

    return {
      items: rows.map(
        (row: OrderRow): AdminWorkOrderDraftRow => ({
          id: row.id,
          code: row.code,
          title: row.title,
          catalogCode: row.catalogCode,
          catalogName: catalogNames.get(row.catalogCode) ?? null,
          orderType: toOrderType(row.orderType),
          complexity: toComplexity(row.complexity),
          assigneeId: row.assigneeId,
          assigneeName: row.assigneeId
            ? nameMap.get(row.assigneeId) ?? null
            : null,
          activeWorkOrders: row.assigneeId
            ? activeCounts.get(row.assigneeId) ?? 0
            : 0,
          remark: row.remark,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }),
      ),
    };
  }

  async publishDraft(
    operatorUserId: string,
    id: string,
  ): Promise<AdminWorkOrderPublishResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('工单不存在');
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('工单不存在');
    if (row.status !== 'draft') {
      throw new BadRequestException('仅草稿箱中的工单可发布');
    }
    if (!row.assigneeId) {
      throw new BadRequestException('工单未指派员工，无法发布并生成任务卡');
    }

    // 先建 Plane 任务卡：失败则发布直接失败，事务尚未开始、无任何状态变更；
    // 成功后在事务中回填 taskId，确保 pending 后 taskId 一定非空。
    // 截止时刻已在标题里；优先级从存草稿那条事件备注读回，老草稿没记按普通
    const planeTaskId = await this.createLinkedPlaneTask({
      title: row.title,
      assigneeId: row.assigneeId,
      priority: (await this.loadDraftPriority(id)) ?? 'medium',
      targetDate: planeTargetDate(row.dueAt),
    });

    const updatedRows: OrderRow[] = await this.db.transaction(
      async (tx) => {
        const updated: OrderRow[] = await tx
          .update(workOrders)
          .set({
            status: 'pending',
            taskId: planeTaskId,
            updatedAt: new Date(),
            updatedBy: operatorUserId,
          })
          .where(and(eq(workOrders.id, id), eq(workOrders.status, 'draft')))
          .returning();
        if (updated.length === 0) {
          throw new ConflictException('工单已被处理，请刷新后重试');
        }
        await tx.insert(workOrderEvents).values({
          workOrderId: id,
          fromStatus: 'draft',
          toStatus: 'pending',
          operatorType: 'boss',
          operatorId: operatorUserId,
          comment: '从草稿箱发布，进入执行队列',
        });
        return updated;
      },
    );

    void this.notifyAssigneeNewOrder(updatedRows[0]);

    const catalogNames = await this.loadCatalogNames([
      updatedRows[0].catalogCode,
    ]);
    return {
      workOrder: this.toSummary(
        updatedRows[0],
        catalogNames.get(updatedRows[0].catalogCode) ?? null,
      ),
    };
  }

  async deleteDraft(
    operatorUserId: string,
    id: string,
  ): Promise<AdminWorkOrderDeleteResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('工单不存在');
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('工单不存在');
    if (row.status !== 'draft') {
      throw new BadRequestException('仅草稿箱中的工单可删除');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .delete(workOrderEvents)
        .where(eq(workOrderEvents.workOrderId, id));
      const deleted: OrderRow[] = await tx
        .delete(workOrders)
        .where(and(eq(workOrders.id, id), eq(workOrders.status, 'draft')))
        .returning();
      if (deleted.length === 0) {
        throw new ConflictException('工单已被处理，请刷新后重试');
      }
    });
    this.logger.log('草稿工单已删除', row.code, 'by', operatorUserId);
    return { ok: true };
  }

  async listQueue(
    userContext: AdminWorkOrderUserContextLike,
  ): Promise<AdminWorkOrderQueueResponse> {
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(ne(workOrders.status, 'draft'))
      .orderBy(desc(workOrders.createdAt))
      .limit(200);
    if (rows.length === 0) return { items: [] };

    const [catalogNames, nameMap, slaConfig] = await Promise.all([
      this.loadCatalogNames(
        rows.map((row: OrderRow) => row.catalogCode),
      ),
      this.resolveUserNames(
        userContext,
        rows.map((row: OrderRow) => row.assigneeId),
      ),
      this.loadSlaConfigRaw(),
    ]);
    const now = Date.now();

    return {
      items: rows.map((row: OrderRow) => {
        const slaHours = resolveSlaHoursFromConfig(slaConfig, row.status);
        const slaDeadline =
          slaHours !== null
            ? new Date(
                row.createdAt.getTime() + slaHours * 3_600_000,
              ).toISOString()
            : null;
        const slaOverdue =
          slaDeadline !== null &&
          !(SLA_TERMINAL_STATUSES as readonly string[]).includes(row.status) &&
          now > Date.parse(slaDeadline);
        return {
          ...this.toSummary(
            row,
            catalogNames.get(row.catalogCode) ?? null,
          ),
          assigneeName: row.assigneeId
            ? nameMap.get(row.assigneeId) ?? null
            : null,
          slaDeadline,
          slaOverdue,
        };
      }),
    };
  }

  private async resolveUserNames(
    userContext: AdminWorkOrderUserContextLike,
    ids: Array<string | null>,
  ): Promise<Map<string, string>> {
    const uniqueIds = [
      ...new Set(
        ids.filter((candidate: string | null): candidate is string => !!candidate),
      ),
    ];
    if (uniqueIds.length === 0) {
      return new Map<string, string>();
    }
    try {
      const users = await this.userDirectory.listUsersByIds(uniqueIds);
      const map = new Map<string, string>();
      users.forEach((user, index: number) => {
        if (!user) return;
        const name = user.name?.zh_cn ?? user.name?.en_us ?? '';
        if (name) map.set(uniqueIds[index], name);
      });
      return map;
    } catch (error) {
      this.logger.warn(
        '用户姓名查询失败，保持空展示',
        (error as Error).stack,
      );
      return new Map<string, string>();
    }
  }

  private async countActiveOrdersByAssignee(): Promise<Map<string, number>> {
    const rows: { assigneeId: string | null; total: number }[] = await this.db
      .select({ assigneeId: workOrders.assigneeId, total: count() })
      .from(workOrders)
      .where(inArray(workOrders.status, [...ACTIVE_ORDER_STATUSES]))
      .groupBy(workOrders.assigneeId);
    const map = new Map<string, number>();
    for (const item of rows) {
      if (item.assigneeId !== null) map.set(item.assigneeId, item.total);
    }
    return map;
  }

  // ==================== 凭证提交 + 规则闸 ====================

  async submitEvidence(
    userId: string,
    id: string,
    dto: SubmitEvidenceRequest,
  ): Promise<WorkOrderDetailResponse> {
    const row = await this.loadOwnedOrder(userId, id);
    const currentStatus = toStatus(row.status);
    if (currentStatus === null) {
      throw new BadRequestException('工单状态异常');
    }
    if (currentStatus !== 'executing') {
      throw new BadRequestException(
        `当前状态为「${STATUS_LABELS[currentStatus]}」，不允许提交凭证；请先执行「开始工单」或「重新提交」`,
      );
    }

    const checklist = parseChecklist(row.checklist);
    const validItems = dto.items.filter(
      (item: SubmitEvidenceRequest['items'][number]) =>
        item.itemKey !== '' && item.fileUrls.length > 0,
    );
    if (validItems.length === 0) {
      throw new BadRequestException('请先上传凭证文件再提交');
    }

    const gateAt = new Date().toISOString();
    // 工单 AI 初审是可选集成（AILY_WORKORDER_REVIEW_ENABLED，默认开）：关着按「未启用」走，凭证齐直接进老板终审
    const aiAgentId = isFeatureEnabled('aiWorkorderReview')
      ? await this.resolveAiReviewAgentId()
      : '';
    let aiGateLaunch: AiGateLaunch | null = null;
    let enteredPendingBoss = false;
    await this.db.transaction(async (tx) => {
      // 锁住工单行：两次提交同时进来时排队，后到的看到状态已变就拒（也保证版本号不撞）
      const locked = await tx
        .select({ status: workOrders.status })
        .from(workOrders)
        .where(eq(workOrders.id, row.id))
        .for('update');
      if (locked[0]?.status !== 'executing') {
        throw new ConflictException('工单刚被处理过，请刷新后再提交');
      }
      const existingRows: EvidenceRow[] = await tx
        .select()
        .from(workOrderEvidence)
        .where(eq(workOrderEvidence.workOrderId, row.id));
      const byKey = new Map<string, EvidenceRow>();
      for (const evidenceRow of existingRows) {
        byKey.set(evidenceRow.itemKey, evidenceRow);
      }

      for (const item of validItems) {
        const checklistItem = checklist.find(
          (c: WorkOrderChecklistItem) => c.key === item.itemKey,
        );
        const existing = byKey.get(item.itemKey);
        if (existing) {
          const merged = [
            ...new Set([
              ...parseStringArray(existing.fileUrls),
              ...item.fileUrls,
            ]),
          ];
          await tx
            .update(workOrderEvidence)
            .set({
              fileUrls: merged,
              ...(item.note !== undefined ? { note: item.note } : {}),
              updatedAt: new Date(),
              updatedBy: userId,
            })
            .where(eq(workOrderEvidence.id, existing.id));
        } else {
          await tx.insert(workOrderEvidence).values({
            workOrderId: row.id,
            itemKey: item.itemKey,
            ...(checklistItem ? { itemName: checklistItem.name } : {}),
            fileUrls: item.fileUrls,
            ...(item.note !== undefined ? { note: item.note } : {}),
            submittedBy: userId,
            aiCheckStatus: 'pending',
          });
        }
      }

      const refreshedEvidence: EvidenceRow[] = await tx
        .select()
        .from(workOrderEvidence)
        .where(eq(workOrderEvidence.workOrderId, row.id));

      // 每交一次记一版（11-10 A02）：把这次交完后的整套凭证原样存下，重交不覆盖旧版，终审指向具体那一版
      const saved = await this.acceptance.recordVersion(tx, {
        subjectType: 'work_order',
        subjectId: row.id,
        items: refreshedEvidence.map((e: EvidenceRow) => ({
          name: e.itemName ?? e.itemKey,
          fileUrls: parseStringArray(e.fileUrls),
          note: e.note,
        })),
        summary: null,
        submittedBy: userId,
      });
      const versionNote = `第 ${saved.version} 版`;

      // 一期纯规则初审引擎：required 项有对应 item_key 且 file_urls 非空即算齐
      const gate = this.runRuleGate(checklist, refreshedEvidence);
      if (gate.missing.length > 0) {
        // 凭证不齐 → needs_revision（规则闸直接退回，不进 AI 闸）
        const ruleVerdict: WorkOrderAiVerdict = {
          verdict: 'revise',
          engine: 'rule',
          at: gateAt,
          checkedItems: gate.checkedItems,
          summary: `凭证不齐：缺少 ${gate.missing.join('、')}`,
        };
        await tx.insert(workOrderEvents).values({
          workOrderId: row.id,
          fromStatus: row.status,
          toStatus: 'needs_revision',
          operatorType: 'system',
          comment: `${versionNote}${ruleVerdict.summary ? `：${ruleVerdict.summary}` : ''}`,
        });
        await tx
          .update(workOrders)
          .set({
            status: 'needs_revision',
            aiVerdict: ruleVerdict,
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(eq(workOrders.id, row.id));
      } else if (aiAgentId !== '') {
        // 凭证齐 → pending_submit → ai_reviewing：异步调豆包初审，结论回写
        await tx.insert(workOrderEvents).values({
          workOrderId: row.id,
          fromStatus: row.status,
          toStatus: 'pending_submit',
          operatorType: 'user',
          operatorId: userId,
          comment: `提交凭证（${versionNote}）`,
        });
        await tx.insert(workOrderEvents).values({
          workOrderId: row.id,
          fromStatus: 'pending_submit',
          toStatus: 'ai_reviewing',
          operatorType: 'system',
          comment: '规则初审通过，转豆包 AI 初审',
        });
        await tx
          .update(workOrders)
          .set({
            status: 'ai_reviewing',
            aiVerdict: {
              engine: 'aily',
              at: gateAt,
              checkedItems: gate.checkedItems,
              summary: '规则闸通过，豆包 AI 初审中',
            },
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(eq(workOrders.id, row.id));
        aiGateLaunch = {
          orderId: row.id,
          code: row.code,
          agentId: aiAgentId,
          title: row.title,
          typeLabel: ORDER_TYPE_LABELS[toOrderType(row.orderType)],
          complexityLabel: COMPLEXITY_LABELS[toComplexity(row.complexity)],
          checklist,
          evidence: refreshedEvidence,
          checkedItems: gate.checkedItems,
          gateAt,
        };
      } else {
        // AI 初审未启用（未配置智能体 ID）→ 维持一期行为直接进老板终审
        await tx.insert(workOrderEvents).values({
          workOrderId: row.id,
          fromStatus: row.status,
          toStatus: 'pending_submit',
          operatorType: 'user',
          operatorId: userId,
          comment: `提交凭证（${versionNote}）`,
        });
        await tx.insert(workOrderEvents).values({
          workOrderId: row.id,
          fromStatus: 'pending_submit',
          toStatus: 'pending_boss',
          operatorType: 'system',
          comment: '规则初审通过（AI 初审未启用），进入老板终审',
        });
        await tx
          .update(workOrders)
          .set({
            status: 'pending_boss',
            aiVerdict: {
              verdict: 'pass',
              engine: 'rule',
              at: gateAt,
              checkedItems: gate.checkedItems,
              summary: '规则初审通过：必需凭证齐全',
            },
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(eq(workOrders.id, row.id));
        enteredPendingBoss = true;
      }
    });

    if (enteredPendingBoss) {
      void this.notifyBossesOfPendingReview(row);
    }

    if (aiGateLaunch !== null) {
      // 异步豆包初审：不阻塞提交响应，结论回写或失败降级终审
      void this.runAiGate(aiGateLaunch);
    }

    const refreshedRows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, row.id))
      .limit(1);
    const detail = await this.buildDetail(refreshedRows[0]);
    return { workOrder: detail };
  }

  // ==================== 状态机流转 ====================

  async transition(
    userId: string,
    id: string,
    dto: WorkOrderTransitionRequest,
  ): Promise<WorkOrderActionResult> {
    const row = await this.loadOwnedOrder(userId, id);
    const rule = TRANSITIONS[dto.action];
    const currentStatus = toStatus(row.status);
    if (currentStatus === null || !rule.from.includes(currentStatus)) {
      const label = currentStatus
        ? `当前状态为「${STATUS_LABELS[currentStatus]}」`
        : '工单状态异常';
      throw new BadRequestException(
        `${label}，不支持该操作（${dto.action}）`,
      );
    }

    await this.db.transaction(async (tx) => {
      await tx.insert(workOrderEvents).values({
        workOrderId: row.id,
        fromStatus: row.status,
        toStatus: rule.to,
        operatorType: 'user',
        operatorId: userId,
        ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
      });
      await tx
        .update(workOrders)
        .set({
          status: rule.to,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(eq(workOrders.id, row.id));
    });

    if (rule.to === 'pending_boss') {
      void this.notifyBossesOfPendingReview(row);
    }

    return {
      ok: true,
      status: rule.to,
      message: TRANSITION_MESSAGES[dto.action],
    };
  }

  // ==================== 转交（11-10 A01） ====================

  /** 能接手的人：绑过 Plane 成员的员工（任务卡要改派给他），不含自己 */
  async handoverCandidates(
    userId: string,
  ): Promise<WorkOrderHandoverCandidatesResponse> {
    const rows = await this.db
      .select({
        userId: employeeBindings.miaodaUserId,
        name: employeeBindings.planeMemberName,
      })
      .from(employeeBindings)
      .orderBy(asc(employeeBindings.planeMemberName));
    return {
      items: rows
        .filter((row: { userId: string }) => row.userId !== userId)
        .map((row: { userId: string; name: string | null }) => ({
          userId: row.userId,
          name: row.name ?? row.userId,
        })),
    };
  }

  /**
   * 转交：必须写清已做了什么、下一步、材料（文字或链接至少一样），留一条转交记录，接手人在工单里能看到。
   * 负责人本人能转；老板 / 管理员也能代转。关联的任务卡同时改派给接手人（改派失败就不转，免得接手人找不到）。
   */
  async handover(
    viewer: TaskViewer,
    id: string,
    dto: WorkOrderHandoverRequest,
  ): Promise<WorkOrderDetailResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('工单不存在');
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.status === 'draft') throw new NotFoundException('工单不存在');
    if (row.assigneeId !== viewer.userId && !viewer.fullAccess) {
      throw new ForbiddenException('只有工单负责人能转交');
    }
    if (!(HANDOVER_STATUSES as readonly string[]).includes(row.status)) {
      const label = toStatus(row.status);
      throw new BadRequestException(
        `「${label ? STATUS_LABELS[label] : row.status}」的工单不能转交，只有待执行、执行中、需修改的能转`,
      );
    }

    const done = (dto.done ?? '').trim().slice(0, HANDOVER_TEXT_MAX);
    const next = (dto.next ?? '').trim().slice(0, HANDOVER_TEXT_MAX);
    const materials = (dto.materials ?? '').trim().slice(0, HANDOVER_TEXT_MAX);
    const materialUrls = [
      ...new Set(
        (dto.materialUrls ?? [])
          .filter((url: unknown): url is string => typeof url === 'string')
          .map((url: string) => url.trim())
          .filter((url: string) => url !== ''),
      ),
    ].slice(0, HANDOVER_URLS_MAX);
    if (done === '') throw new BadRequestException('写一下已经做了什么');
    if (next === '') throw new BadRequestException('写一下下一步要做什么');
    if (materials === '' && materialUrls.length === 0) {
      throw new BadRequestException('写一下材料在哪（文字或链接都行）');
    }
    if (dto.toUserId === row.assigneeId) {
      throw new BadRequestException('接手人就是现在的负责人');
    }

    const bindings = await this.db
      .select({
        userId: employeeBindings.miaodaUserId,
        planeMemberId: employeeBindings.planeMemberId,
        name: employeeBindings.planeMemberName,
      })
      .from(employeeBindings)
      .where(
        inArray(
          employeeBindings.miaodaUserId,
          [dto.toUserId, row.assigneeId].filter(
            (value: string | null): value is string => !!value,
          ),
        ),
      );
    const toBinding = bindings.find((b) => b.userId === dto.toUserId);
    if (!toBinding) {
      throw new BadRequestException('接手人还没绑 Plane 成员，先在「管理 → 员工绑定」绑上');
    }
    const fromBinding = row.assigneeId
      ? bindings.find((b) => b.userId === row.assigneeId)
      : undefined;
    const fromName = fromBinding?.name ?? null;
    const toName = toBinding.name ?? toBinding.userId;

    if (row.taskId) {
      await this.reassignPlaneTask(row.taskId, {
        fromMemberId: fromBinding?.planeMemberId ?? null,
        toMemberId: toBinding.planeMemberId,
        commentHtml: [
          `<p>【工单转交】${escapeHtml(row.code)} 由 ${escapeHtml(fromName ?? '原负责人')} 转给 ${escapeHtml(toName)}</p>`,
          `<p>已做：${escapeHtml(done)}</p>`,
          `<p>下一步：${escapeHtml(next)}</p>`,
          `<p>材料：${escapeHtml(materials)}${materialUrls
            .map((url: string) => `<br/>${escapeHtml(url)}`)
            .join('')}</p>`,
        ].join(''),
      });
    }

    const byBoss = row.assigneeId !== viewer.userId;
    await this.db.transaction(async (tx) => {
      const moved = await tx
        .update(workOrders)
        .set({
          assigneeId: dto.toUserId,
          updatedAt: new Date(),
          updatedBy: viewer.userId,
        })
        .where(and(eq(workOrders.id, row.id), eq(workOrders.status, row.status)))
        .returning({ id: workOrders.id });
      if (moved.length === 0) {
        throw new ConflictException('工单刚被处理过，请刷新后再转交');
      }
      await tx.insert(workOrderHandovers).values({
        workOrderId: row.id,
        fromUserId: row.assigneeId,
        toUserId: dto.toUserId,
        doneText: done,
        nextText: next,
        materialsText: materials,
        materialUrls,
        operatorId: viewer.userId,
      });
      await tx.insert(workOrderEvents).values({
        workOrderId: row.id,
        fromStatus: row.status,
        toStatus: row.status,
        operatorType: byBoss ? 'boss' : 'user',
        operatorId: viewer.userId,
        comment: `转交给 ${toName}；下一步：${next.slice(0, 200)}`,
      });
    });

    void this.notify.sendToUsers(
      [dto.toUserId],
      '有工单转给你',
      `《${row.title}》（${row.code}）由 ${fromName ?? '原负责人'} 转给你。下一步：${next.slice(0, 200)}`,
      { category: 'workorder', link: row.taskId ? `/tasks/${row.taskId}` : null },
    );

    const refreshed: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, row.id))
      .limit(1);
    return { workOrder: await this.buildDetail(refreshed[0]) };
  }

  /** 任务卡改派：去掉原负责人、加上接手人（其他协作者不动），再留一条转交评论 */
  private async reassignPlaneTask(
    taskId: string,
    input: { fromMemberId: string | null; toMemberId: string; commentHtml: string },
  ): Promise<void> {
    const projects = await this.plane.listProjects<PlaneProjectRaw>();
    let projectId: string | null = null;
    let issue: PlaneIssueAssigneesRaw | null = null;
    for (const project of projects) {
      issue = await this.plane.getOptional<PlaneIssueAssigneesRaw>(
        `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/`,
      );
      if (issue) {
        projectId = project.id;
        break;
      }
    }
    if (!projectId || !issue) {
      throw new BadRequestException('关联的任务卡找不到了（可能被删了），没转交');
    }
    const assignees = [
      ...new Set([
        ...(issue.assignees ?? []).filter(
          (memberId: string) => memberId !== input.fromMemberId,
        ),
        input.toMemberId,
      ]),
    ];
    const issuePath = `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/`;
    try {
      await this.plane.patch(issuePath, { assignees });
    } catch (error) {
      this.logger.warn(
        `工单转交改派任务卡失败（${taskId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new BadRequestException('任务卡改派失败，没转交，稍后再试');
    }
    try {
      await this.plane.post(`${issuePath}comments/`, { comment_html: input.commentHtml });
    } catch (error) {
      // 评论只是给任务动态留个底，转交记录在工作台库里，失败不挡
      this.logger.warn(
        `工单转交评论没写上（${taskId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async loadHandovers(workOrderId: string): Promise<WorkOrderHandoverView[]> {
    let rows: HandoverRow[];
    try {
      rows = await this.db
        .select()
        .from(workOrderHandovers)
        .where(eq(workOrderHandovers.workOrderId, workOrderId))
        .orderBy(asc(workOrderHandovers.createdAt));
    } catch (error) {
      this.logger.warn(
        `读转交记录失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    if (rows.length === 0) return [];
    const ids = [
      ...new Set(
        rows.flatMap((r: HandoverRow) =>
          [r.fromUserId, r.toUserId].filter((v: string | null): v is string => !!v),
        ),
      ),
    ];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const bindingRows = await this.db
        .select({
          userId: employeeBindings.miaodaUserId,
          name: employeeBindings.planeMemberName,
        })
        .from(employeeBindings)
        .where(inArray(employeeBindings.miaodaUserId, ids));
      for (const b of bindingRows) if (b.name) names.set(b.userId, b.name);
    }
    return rows.map((r: HandoverRow) => ({
      id: r.id,
      fromUserId: r.fromUserId,
      fromName: r.fromUserId ? names.get(r.fromUserId) ?? null : null,
      toUserId: r.toUserId,
      toName: names.get(r.toUserId) ?? null,
      done: r.doneText,
      next: r.nextText,
      materials: r.materialsText,
      materialUrls: parseStringArray(r.materialUrls),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ==================== 内部方法 ====================

  /**
   * 规则初审引擎（一期纯规则）：checklist required 项在 evidence
   * 有对应 item_key 且 file_urls 非空即算齐；AI 通道仅留字段接口。
   */
  private runRuleGate(
    checklist: WorkOrderChecklistItem[],
    evidenceRows: EvidenceRow[],
  ): { missing: string[]; checkedItems: { name: string; pass: boolean }[] } {
    const provided = new Set<string>();
    for (const evidenceRow of evidenceRows) {
      if (parseStringArray(evidenceRow.fileUrls).length > 0) {
        provided.add(evidenceRow.itemKey);
      }
    }
    const missing: string[] = [];
    const checkedItems: { name: string; pass: boolean }[] = [];
    for (const item of checklist) {
      const has = provided.has(item.key);
      const required = item.required !== false;
      checkedItems.push({ name: item.name, pass: !required || has });
      if (required && !has) missing.push(item.name);
    }
    return { missing, checkedItems };
  }

  private async loadOwnedOrder(userId: string, id: string): Promise<OrderRow> {
    if (!UUID_RE.test(id)) {
      throw new NotFoundException('工单不存在');
    }
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('工单不存在');
    if (row.status === 'draft') {
      throw new NotFoundException('工单不存在');
    }
    if (row.assigneeId !== userId) {
      throw new ForbiddenException('仅工单负责人可操作该工单');
    }
    return row;
  }

  private async buildDetail(row: OrderRow): Promise<WorkOrderDetail> {
    const [evidenceRows, eventRows, handovers, overview] = await Promise.all([
      this.db
        .select()
        .from(workOrderEvidence)
        .where(eq(workOrderEvidence.workOrderId, row.id))
        .orderBy(workOrderEvidence.createdAt),
      this.db
        .select()
        .from(workOrderEvents)
        .where(eq(workOrderEvents.workOrderId, row.id))
        .orderBy(workOrderEvents.createdAt),
      this.loadHandovers(row.id),
      this.acceptance.overview('work_order', row.id),
    ]);
    return this.toDetail(row, evidenceRows, eventRows, {
      handovers,
      versions: overview.versions,
      acceptanceRecords: overview.records,
    });
  }

  private async loadCatalogNames(
    codes: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const unique = [...new Set(codes)];
    if (unique.length === 0) return map;
    const rows: { code: string; name: string }[] = await this.db
      .select({ code: workOrderCatalog.code, name: workOrderCatalog.name })
      .from(workOrderCatalog)
      .where(inArray(workOrderCatalog.code, unique));
    for (const row of rows) map.set(row.code, row.name);
    return map;
  }

  /** 工单编号 WO-YYYYMMDD-NNNN（上海时区当日序号，从 0001 递增） */
  private async nextOrderCode(): Promise<string> {
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .replaceAll('-', '');
    const prefix = `WO-${ymd}-`;
    const rows = await this.db
      .select({ maxCode: max(workOrders.code) })
      .from(workOrders)
      .where(like(workOrders.code, `${prefix}%`));
    const currentMax = rows[0]?.maxCode ?? null;
    let next = 1;
    if (currentMax !== null && currentMax.startsWith(prefix)) {
      const parsed = Number.parseInt(currentMax.slice(prefix.length), 10);
      if (!Number.isNaN(parsed) && parsed >= next) next = parsed + 1;
    }
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  /** 并发下编号唯一冲突（23505）可重试一次 */
  private async insertOrderWithCodeRetry(
    buildValues: (code: string) => typeof workOrders.$inferInsert,
  ): Promise<OrderRow> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const code = await this.nextOrderCode();
      try {
        const inserted: OrderRow[] = await this.db
          .insert(workOrders)
          .values(buildValues(code))
          .returning();
        return inserted[0];
      } catch (error) {
        if (attempt === 0 && extractPostgresErrorCode(error) === '23505') {
          this.logger.warn('工单编号冲突，重新生成后重试', code);
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException('工单编号生成冲突，请重试');
  }

  // ==================== 工单任务卡（Plane 同步） ====================

  /** 存草稿时记在建单事件备注里的优先级（取最早一条进 draft 的事件） */
  private async loadDraftPriority(
    workOrderId: string,
  ): Promise<WorkOrderPriority | null> {
    const rows: { comment: string | null }[] = await this.db
      .select({ comment: workOrderEvents.comment })
      .from(workOrderEvents)
      .where(
        and(
          eq(workOrderEvents.workOrderId, workOrderId),
          eq(workOrderEvents.toStatus, 'draft'),
        ),
      )
      .orderBy(asc(workOrderEvents.createdAt))
      .limit(1);
    return priorityFromNote(rows[0]?.comment ?? null);
  }

  /**
   * 为工单创建关联的 Plane 任务卡：「日常执行」项目 + 「工单任务」标签 +
   * 指派成员 + target_date（截止日期，没给是今天，上海时区）+ 优先级，标题用工单 title 原样（含「HH:mm前」）。
   * 任何失败都抛异常由调用方保证整单失败（不落库 / 不发布）。
   */
  private async createLinkedPlaneTask(input: {
    title: string;
    assigneeId: string;
    priority: WorkOrderPriority;
    targetDate: string;
  }): Promise<string> {
    const found = await this.db
      .select({ planeMemberId: employeeBindings.planeMemberId })
      .from(employeeBindings)
      .where(eq(employeeBindings.miaodaUserId, input.assigneeId))
      .limit(1);
    const binding = found[0];
    if (!binding) {
      throw new BadRequestException(
        '指派员工未绑定 Plane 成员，无法生成工单任务卡',
      );
    }

    const res = await this.plane.cachedGet<
      PlaneProjectRaw[] | { results?: PlaneProjectRaw[] }
    >(`${this.plane.workspacePath}/projects/`);
    const projects = Array.isArray(res) ? res : (res.results ?? []);
    const project = projects.find((row: PlaneProjectRaw) =>
      row.name.includes(ROUTINE_PROJECT_KEYWORD),
    );
    if (!project) {
      throw new BadRequestException(
        `找不到名称含「${ROUTINE_PROJECT_KEYWORD}」的默认项目，无法生成工单任务卡`,
      );
    }

    const labelId = await this.ensureWorkOrderLabelId(project.id);

    let created: { id?: string };
    try {
      created = await this.plane.post<{ id?: string }>(
        `${this.plane.workspacePath}/projects/${project.id}/issues/`,
        {
          name: input.title,
          assignees: [binding.planeMemberId],
          target_date: input.targetDate,
          labels: [labelId],
          priority: input.priority,
        },
      );
    } catch (error) {
      this.logger.error(
        '工单任务卡创建失败',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
    if (!created.id) {
      throw new BadRequestException('工单任务卡创建失败：Plane 未返回任务 ID');
    }
    return created.id;
  }

  /** 查「工单任务」标签 id（includes 口径），不存在则先创建再取 id */
  private async ensureWorkOrderLabelId(projectId: string): Promise<string> {
    try {
      const res = await this.plane.cachedGet<
        PlaneLabelRaw[] | { results?: PlaneLabelRaw[] }
      >(`${this.plane.workspacePath}/projects/${projectId}/labels/`);
      const labels = Array.isArray(res) ? res : (res.results ?? []);
      const hit = labels.find((label: PlaneLabelRaw) =>
        label.name.includes(WORK_ORDER_LABEL_NAME),
      );
      if (hit) return hit.id;
    } catch {
      // 拉取失败按未找到处理，走创建分支
    }

    const created = await this.plane.post<{ id?: string }>(
      `${this.plane.workspacePath}/projects/${projectId}/labels/`,
      { name: WORK_ORDER_LABEL_NAME, colour: WORK_ORDER_LABEL_COLOUR },
    );
    if (!created.id) {
      throw new BadRequestException(
        `「${WORK_ORDER_LABEL_NAME}」标签创建失败：Plane 未返回标签 ID`,
      );
    }
    return created.id;
  }

  // ==================== 豆包 AI 初审闸 ====================

  /** 工单发布通知：指派员工（assigneeId 为空跳过），失败由 NotifyService 内部兜底 */
  private async notifyAssigneeNewOrder(
    row: Pick<OrderRow, 'id' | 'code' | 'title' | 'assigneeId' | 'taskId'>,
  ): Promise<void> {
    if (!row.assigneeId) return;
    await this.notify.sendToUsers(
      [row.assigneeId],
      '你有新工单',
      `《${row.title}》（${row.code}）已发布给你，请及时处理。`,
      // 发布时已建好任务卡（任务详情页有工单区）；没挂任务的只看不跳
      { category: 'workorder', link: row.taskId ? `/tasks/${row.taskId}` : null },
    );
  }

  /** 员工送审进 pending_boss：通知老板侧接收人（未配置则跳过并 warn） */
  private async notifyBossesOfPendingReview(
    row: Pick<OrderRow, 'id' | 'code' | 'title'>,
  ): Promise<void> {
    const userIds = await this.resolveBossNotifyUserIds();
    if (userIds.length === 0) {
      this.logger.warn(
        `工单 ${row.code} 进入老板终审，system_configs 未配置 ${BOSS_NOTIFY_CONFIG_KEY}，跳过通知`,
      );
      return;
    }
    await this.notify.sendToUsers(
      userIds,
      '工单待终审',
      `工单《${row.title}》（${row.code}）已提交，等待你终审。`,
      { category: 'workorder', link: '/admin/review' },
    );
  }

  private async resolveBossNotifyUserIds(): Promise<string[]> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, BOSS_NOTIFY_CONFIG_KEY))
      .limit(1);
    const config = (rows[0]?.configValue ?? {}) as BossNotifyConfig;
    if (Array.isArray(config.user_ids)) {
      return parseStringArray(config.user_ids);
    }
    if (Array.isArray(config.userIds)) {
      return parseStringArray(config.userIds);
    }
    return [];
  }

  /** 读 SLA 配置原始值（行不存在返回 null → 队列不显示 SLA） */
  private async loadSlaConfigRaw(): Promise<unknown> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, SLA_CONFIG_KEY))
      .limit(1);
    return rows[0]?.configValue ?? null;
  }

  private async resolveAiReviewAgentId(): Promise<string> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, AI_REVIEW_CONFIG_KEY))
      .limit(1);
    const config = (rows[0]?.configValue ?? {}) as AiReviewAgentConfig;
    return typeof config.agent_id === 'string' ? config.agent_id.trim() : '';
  }

  /** 豆包 AI 初审：失败/超时/无法解析一律降级 pending_boss，终杀权留给老板 */
  private async runAiGate(launch: AiGateLaunch): Promise<void> {
    let outcome: AiGateOutcome;
    try {
      const sessionId = await this.aily.createSession(launch.agentId);
      const chatId = await this.aily.createRun(
        launch.agentId,
        sessionId,
        this.buildAiReviewPrompt(launch),
      );
      const chat = await this.pollAilyChat(launch.agentId, chatId);
      const status = typeof chat.status === 'string' ? chat.status : '';
      if (status !== 'Completed') {
        const failed = status === 'Failed';
        outcome = {
          status: 'pending_boss',
          verdict: 'need_human',
          comment: failed
            ? 'AI 初审执行失败，已转入老板终审'
            : 'AI 初审超时未完成，已转入老板终审',
          summary: failed
            ? '豆包智能体执行失败，降级人工终审'
            : '豆包 AI 初审超时，降级人工终审',
        };
      } else {
        const reply = this.aily.extractChatReply(chat);
        const parsed = reply === null ? null : this.parseAiReply(reply);
        if (parsed === null) {
          outcome = {
            status: 'pending_boss',
            verdict: 'need_human',
            comment: 'AI 初审结论无法解析，已转入老板终审',
            summary: 'AI 返回内容无法解析为初审结论，降级人工终审',
          };
        } else if (parsed.verdict === 'revise') {
          outcome = {
            status: 'needs_revision',
            verdict: 'revise',
            comment: `AI 初审退回：${parsed.summary}`,
            summary: parsed.summary,
          };
        } else if (parsed.verdict === 'pass') {
          outcome = {
            status: 'pending_boss',
            verdict: 'pass',
            comment: `AI 初审通过${
              parsed.summary !== '' ? `：${parsed.summary}` : ''
            }，进入老板终审`,
            summary: parsed.summary,
          };
        } else {
          outcome = {
            status: 'pending_boss',
            verdict: parsed.verdict,
            comment: `AI 初审「${AI_VERDICT_LABELS[parsed.verdict]}」${
              parsed.summary !== '' ? `：${parsed.summary}` : ''
            }，请老板终审裁决`,
            summary: parsed.summary,
          };
        }
      }
    } catch (error) {
      this.logger.error(
        `工单 ${launch.code} AI 初审失败`,
        error instanceof Error ? error.stack : String(error),
      );
      const message = error instanceof Error ? error.message : '未知错误';
      outcome = {
        status: 'pending_boss',
        verdict: 'need_human',
        comment: `AI 初审失败，已转入老板终审（${message}）`,
        summary: `AI 初审调用失败：${message}`,
      };
    }
    await this.applyAiVerdict(launch, outcome);
  }

  /** 回写 AI 结论：乐观锁（仅 ai_reviewing 态生效），被人工流转则跳过 */
  private async applyAiVerdict(
    launch: AiGateLaunch,
    outcome: AiGateOutcome,
  ): Promise<void> {
    const aiVerdict: WorkOrderAiVerdict = {
      verdict: outcome.verdict,
      engine: 'aily',
      checkedItems: launch.checkedItems,
      summary: outcome.summary,
      at: launch.gateAt,
    };
    try {
      const moved = await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(workOrders)
          .set({
            status: outcome.status,
            aiVerdict,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workOrders.id, launch.orderId),
              eq(workOrders.status, 'ai_reviewing'),
            ),
          )
          .returning({ id: workOrders.id });
        if (updated.length === 0) {
          return false;
        }
        await tx.insert(workOrderEvents).values({
          workOrderId: launch.orderId,
          fromStatus: 'ai_reviewing',
          toStatus: outcome.status,
          operatorType: 'ai',
          comment: outcome.comment,
        });
        return true;
      });
      if (!moved) {
        this.logger.warn(
          `工单 ${launch.code} AI 初审回写跳过：已离开 ai_reviewing 态`,
        );
      }
      if (moved && outcome.status === 'pending_boss') {
        void this.notifyBossesOfPendingReview({
          id: launch.orderId,
          code: launch.code,
          title: launch.title,
        });
      }
    } catch (error) {
      this.logger.error(
        `工单 ${launch.code} AI 初审回写失败`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async pollAilyChat(
    agentId: string,
    chatId: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + AI_POLL_TOTAL_LIMIT_MS;
    let delay = AI_POLL_FIRST_DELAY_MS;
    let chat: Record<string, unknown> = {};
    while (Date.now() + delay < deadline) {
      await new Promise((resolve: (value: void) => void) => {
        setTimeout(resolve, delay);
      });
      delay = Math.min(delay + 1_000, AI_POLL_MAX_DELAY_MS);
      chat = await this.aily.getChat(agentId, chatId);
      const status = typeof chat.status === 'string' ? chat.status : '';
      if (status === 'Completed' || status === 'Failed') {
        return chat;
      }
    }
    return chat;
  }

  private parseAiReply(
    reply: string,
  ): { verdict: WorkOrderAiVerdictKind; summary: string } | null {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }
    let parsed: { verdict?: unknown; summary?: unknown };
    try {
      parsed = JSON.parse(reply.slice(start, end + 1)) as {
        verdict?: unknown;
        summary?: unknown;
      };
    } catch {
      return null;
    }
    if (
      parsed.verdict !== 'pass' &&
      parsed.verdict !== 'revise' &&
      parsed.verdict !== 'reject' &&
      parsed.verdict !== 'need_human'
    ) {
      return null;
    }
    const summary =
      typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    return { verdict: parsed.verdict, summary };
  }

  private buildAiReviewPrompt(launch: AiGateLaunch): string {
    const lines: string[] = [];
    for (const item of launch.checklist) {
      const evidence = launch.evidence.find(
        (e: EvidenceRow) => e.itemKey === item.key,
      );
      const files =
        evidence === undefined ? [] : parseStringArray(evidence.fileUrls);
      const names = files.map((url: string) => url.split('/').pop() ?? url);
      const note = evidence?.note;
      const noteText =
        note !== null && note !== undefined && note !== ''
          ? `；备注：${note}`
          : '';
      lines.push(
        `- ${item.name}${
          item.required === false ? '（选传）' : '（必传）'
        }：${
          files.length > 0
            ? `已提交 ${files.length} 个文件（${names.join('、')}）`
            : '未提交'
        }${noteText}`,
      );
    }
    return [
      '你是泛亚工单的凭证初审助手。请核对下方工单的凭证提交情况，判断是否可以进入老板终审。',
      '一期为文本核对：只能看到文件名与员工备注，看不到图片内容；仅在文件名或备注与清单要求明显不符、必传项缺失时才退回。',
      '只输出一个 JSON 对象，禁止输出 markdown 代码块或其他文字，字段：',
      'verdict：pass（凭证齐全可进终审）/ revise（需员工补充修改）/ reject（凭证与要求严重不符）/ need_human（无法判断，需老板人工裁决）',
      'summary：一句话结论，40 字以内',
      `工单编号：${launch.code}`,
      `工单标题：${launch.title}`,
      `工单类型：${launch.typeLabel}｜复杂度：${launch.complexityLabel}`,
      '凭证清单与提交情况：',
      ...lines,
    ].join('\n');
  }

  /** ai_reviewing 超时未回写（进程重启丢异步任务）→ 查看详情时自动降级老板终审 */
  private async healStaleAiReview(row: OrderRow): Promise<OrderRow> {
    if (row.status !== 'ai_reviewing') {
      return row;
    }
    if (Date.now() - row.updatedAt.getTime() < AI_REVIEW_STALE_MS) {
      return row;
    }
    const staleAt = new Date().toISOString();
    try {
      const healed = await this.db.transaction(async (tx) => {
        const healed: OrderRow[] = await tx
          .update(workOrders)
          .set({
            status: 'pending_boss',
            aiVerdict: {
              verdict: 'need_human',
              engine: 'aily',
              summary: 'AI 初审超时未回写，自动转入老板终审',
              at: staleAt,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workOrders.id, row.id),
              eq(workOrders.status, 'ai_reviewing'),
            ),
          )
          .returning();
        if (healed.length === 0) {
          return row;
        }
        await tx.insert(workOrderEvents).values({
          workOrderId: row.id,
          fromStatus: 'ai_reviewing',
          toStatus: 'pending_boss',
          operatorType: 'system',
          comment: 'AI 初审超时未回写，自动转入老板终审',
        });
        this.logger.warn(`工单 ${row.code} AI 初审超时，自愈降级老板终审`);
        return healed[0];
      });
      if (healed.status === 'pending_boss') {
        void this.notifyBossesOfPendingReview(healed);
      }
      return healed;
    } catch (error) {
      this.logger.error(
        `工单 ${row.code} AI 初审自愈失败`,
        error instanceof Error ? error.stack : String(error),
      );
      return row;
    }
  }

  private toSummary(
    row: OrderRow,
    catalogName: string | null,
  ): WorkOrderSummary {
    const summary: WorkOrderSummary = {
      id: row.id,
      code: row.code,
      title: row.title,
      catalogCode: row.catalogCode,
      orderType: toOrderType(row.orderType),
      complexity: toComplexity(row.complexity),
      status: toStatus(row.status) ?? 'pending',
      assigneeId: row.assigneeId,
      taskId: row.taskId,
      autoGenerated: row.autoGenerated,
      source: toSource(row.source),
      erpDocName: row.erpDocName,
      businessLine: parseBusinessLine(row.businessLine),
      subjects: parseSubjects(row.subjects),
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    if (catalogName !== null) summary.catalogName = catalogName;
    return summary;
  }

  private toDetail(
    row: OrderRow,
    evidenceRows: EvidenceRow[],
    eventRows: EventRow[],
    extras: {
      handovers: WorkOrderHandoverView[];
      versions: SubmissionVersionView[];
      acceptanceRecords: AcceptanceRecordView[];
    } = { handovers: [], versions: [], acceptanceRecords: [] },
  ): WorkOrderDetail {
    return {
      ...this.toSummary(row, null),
      prompt: row.prompt,
      contactBossFields: parseContactBossFields(row.contactBossFields),
      checklist: parseChecklist(row.checklist),
      tutorialId: row.tutorialId,
      specialTutorial: parseSpecialTutorial(row.specialTutorial),
      aiVerdict: parseAiVerdict(row.aiVerdict),
      humanVerdict: parseHumanVerdict(row.humanVerdict),
      evidence: evidenceRows.map((e: EvidenceRow) => this.toEvidenceItem(e)),
      events: eventRows.map((ev: EventRow) => this.toEventView(ev)),
      remark: row.remark,
      handovers: extras.handovers,
      versions: extras.versions,
      acceptanceRecords: extras.acceptanceRecords,
    };
  }

  private toEvidenceItem(row: EvidenceRow): WorkOrderEvidenceItem {
    return {
      id: row.id,
      workOrderId: row.workOrderId,
      itemKey: row.itemKey,
      itemName: row.itemName,
      fileUrls: parseStringArray(row.fileUrls),
      note: row.note,
      submittedBy: row.submittedBy,
      aiCheckStatus: row.aiCheckStatus,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toEventView(row: EventRow): WorkOrderEventView {
    return {
      id: row.id,
      fromStatus: toStatus(row.fromStatus),
      toStatus: toStatus(row.toStatus) ?? 'pending',
      operatorType: toOperatorType(row.operatorType),
      operatorId: row.operatorId,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toCatalogItem(row: CatalogRow): WorkOrderCatalogItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      orderType: toOrderType(row.orderType),
      complexity: toComplexity(row.complexity),
      checklistTemplate: parseChecklist(row.checklistTemplate),
      businessLine: parseBusinessLine(row.businessLine),
      promptTemplate: row.promptTemplate,
      autoTriggerRules: parseAutoTriggerRules(row.autoTriggerRules),
      erpAction: row.erpAction,
      notifyTargets: parseNotifyTargets(row.notifyTargets),
      enabled: row.enabled,
      sort: row.sort,
    };
  }
}
