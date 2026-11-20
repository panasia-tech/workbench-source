import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { UserDirectoryService } from '../auth/user-directory.service';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import type { AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  employeeBindings,
  taskReviewQueue,
  workOrderCatalog,
  workOrderEvents,
  workOrderEvidence,
  workOrders,
} from '@server/database/schema';
import { TutorialOutputService } from '../profile/tutorial-output.service';
import { AcceptanceService } from '../acceptance/acceptance.service';
import {
  parseBusinessLine,
  parseChecklist,
  parseSubjects,
} from './workorder-fields';
import { DevRequestLookupService } from '../dev-requests/dev-request-lookup.service';
import { FrappeService } from '../integration/frappe.service';
import { NotifyService } from '../integration/notify.service';
import { AuditService } from '../integration/audit.service';
import { PlaneService } from '../integration/plane.service';
import { integrationConfig } from '../integration/integration.config';
import {
  mapStatusByState,
  parseWorkHours,
  stripHtml,
} from '../integration/plane-mapping';
import type {
  ReviewPlaneTaskActionRequest,
  ReviewPlaneTaskActionResponse,
  ReviewPlaneTaskRow,
  ReviewPlaneTasksResponse,
  ReviewVerdictRequest,
  ReviewVerdictResponse,
  ReviewWorkOrderRow,
  ReviewWorkOrdersResponse,
  WorkOrderAiVerdict,
  WorkOrderChecklistItem,
  WorkOrderComplexity,
  WorkOrderContactBossFields,
  WorkOrderDetail,
  WorkOrderEvidenceItem,
  WorkOrderEventView,
  WorkOrderHumanVerdict,
  WorkOrderSource,
  WorkOrderSpecialTutorial,
  WorkOrderStatus,
  WorkOrderType,
} from '@shared/api.interface';

type OrderRow = typeof workOrders.$inferSelect;
type EvidenceRow = typeof workOrderEvidence.$inferSelect;
type EventRow = typeof workOrderEvents.$inferSelect;

export interface ReviewUserContextLike {
  userId?: string;
  userName?: string;
  appId?: string;
}

interface PlaneProjectRaw {
  id: string;
  name: string;
  identifier: string;
}

interface PlaneStateRaw {
  id: string;
  name: string;
  slug: string;
  group: string;
  sequence: number;
}

interface PlaneIssueRaw {
  id: string;
  name: string;
  state: string;
  assignees: string[];
  target_date: string | null;
  description_html: string | null;
  sequence_id: number | null;
}

interface PlaneMemberRaw {
  id: string;
  first_name: string;
  last_name: string;
  display_name: string;
}

const RECENT_FINAL_LIMIT = 20;
const EVIDENCE_SUMMARY_LIMIT = 80;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (typeof value.version === 'number') verdict.version = value.version;
  return verdict;
}

function parseSpecialTutorial(
  value: unknown,
): WorkOrderSpecialTutorial | null {
  if (!isRecord(value)) return null;
  const tutorial: WorkOrderSpecialTutorial = {};
  if (typeof value.title === 'string') tutorial.title = value.title;
  if (Array.isArray(value.steps)) {
    tutorial.steps = parseStringArray(value.steps);
  }
  if (typeof value.generated === 'boolean') {
    tutorial.generated = value.generated;
  }
  return tutorial;
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

function toStatus(value: string | null): WorkOrderStatus {
  const allowed: WorkOrderStatus[] = [
    'pending',
    'executing',
    'pending_submit',
    'ai_reviewing',
    'needs_revision',
    'rejected',
    'pending_boss',
    'approved',
    'refused',
  ];
  return allowed.find((s: WorkOrderStatus) => s === value) ?? 'pending';
}

function toOrderType(value: string): WorkOrderType {
  const found = (['purchase', 'sales', 'special_delegation', 'other'] as const)
    .find((t: WorkOrderType) => t === value);
  return found ?? 'other';
}

function toComplexity(value: string): WorkOrderComplexity {
  const found = (['simple', 'medium', 'complex'] as const)
    .find((c: WorkOrderComplexity) => c === value);
  return found ?? 'medium';
}

function toSource(value: string): WorkOrderSource {
  const found = (['manual', 'webhook', 'ai', 'auto_event'] as const)
    .find((s: WorkOrderSource) => s === value);
  return found ?? 'manual';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shanghaiDateString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function summarizeDescription(descriptionHtml: string | null): string | null {
  const text = stripHtml(descriptionHtml ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.slice(0, EVIDENCE_SUMMARY_LIMIT);
}

function memberName(
  members: PlaneMemberRaw[],
  memberId: string | undefined,
): string | null {
  if (!memberId) return null;
  const member = members.find((m: PlaneMemberRaw) => m.id === memberId);
  if (!member) return null;
  return member.first_name || member.display_name || null;
}

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly frappe: FrappeService,
    private readonly plane: PlaneService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
    private readonly userDirectory: UserDirectoryService,
    private readonly http: HttpService,
    private readonly tutorialOutputService: TutorialOutputService,
    private readonly devRequestLookup: DevRequestLookupService,
    private readonly acceptance: AcceptanceService,
  ) {}

  // ==================== 工单终审列表 ====================

  async listWorkOrders(
    userContext: ReviewUserContextLike,
  ): Promise<ReviewWorkOrdersResponse> {
    const pendingRows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.status, 'pending_boss'))
      .orderBy(workOrders.createdAt);
    const recentRows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(inArray(workOrders.status, ['approved', 'refused']))
      .orderBy(desc(workOrders.updatedAt))
      .limit(RECENT_FINAL_LIMIT);
    const rows: OrderRow[] = [...pendingRows, ...recentRows];
    if (rows.length === 0) return { items: [] };

    const evidenceRows: EvidenceRow[] = await this.db
      .select()
      .from(workOrderEvidence)
      .where(
        inArray(
          workOrderEvidence.workOrderId,
          rows.map((row: OrderRow) => row.id),
        ),
      )
      .orderBy(workOrderEvidence.createdAt);
    const evidenceByOrder = new Map<string, EvidenceRow[]>();
    for (const evidenceRow of evidenceRows) {
      const list = evidenceByOrder.get(evidenceRow.workOrderId) ?? [];
      list.push(evidenceRow);
      evidenceByOrder.set(evidenceRow.workOrderId, list);
    }

    const catalogCodes = [...new Set(rows.map((row: OrderRow) => row.catalogCode))];
    const catalogRows: { code: string; name: string }[] = await this.db
      .select({ code: workOrderCatalog.code, name: workOrderCatalog.name })
      .from(workOrderCatalog)
      .where(inArray(workOrderCatalog.code, catalogCodes));
    const catalogNames = new Map<string, string>();
    for (const row of catalogRows) catalogNames.set(row.code, row.name);

    const [nameMap, overviews] = await Promise.all([
      this.resolveUserNames(
        userContext,
        rows.map((row: OrderRow) => row.assigneeId),
      ),
      this.acceptance.overviewMany(
        'work_order',
        rows.map((row: OrderRow) => row.id),
      ),
    ]);

    return {
      items: rows.map((row: OrderRow): ReviewWorkOrderRow => ({
        id: row.id,
        code: row.code,
        title: row.title,
        catalogName: catalogNames.get(row.catalogCode) ?? null,
        orderType: toOrderType(row.orderType),
        complexity: toComplexity(row.complexity),
        status: toStatus(row.status),
        assigneeName: row.assigneeId
          ? nameMap.get(row.assigneeId) ?? null
          : null,
        prompt: row.prompt,
        contactBossFields: parseContactBossFields(row.contactBossFields),
        checklist: parseChecklist(row.checklist),
        evidence: (evidenceByOrder.get(row.id) ?? []).map(
          (e: EvidenceRow) => this.toEvidenceItem(e),
        ),
        aiVerdict: parseAiVerdict(row.aiVerdict),
        humanVerdict: parseHumanVerdict(row.humanVerdict),
        erpDocType: row.erpDocType,
        erpDocName: row.erpDocName,
        businessLine: parseBusinessLine(row.businessLine),
        subjects: parseSubjects(row.subjects),
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        versions: overviews.get(row.id)?.versions ?? [],
        acceptanceRecords: overviews.get(row.id)?.records ?? [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  // ==================== 老板终审 ====================

  async submitVerdict(
    userContext: ReviewUserContextLike,
    id: string,
    dto: ReviewVerdictRequest,
  ): Promise<ReviewVerdictResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('工单不存在');
    const rows: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('工单不存在');
    if (row.status !== 'pending_boss') {
      throw new BadRequestException(
        '当前工单不在「待老板终审」状态，无法终审',
      );
    }
    // 退回、拒绝必须写原因（11-10 A02）
    const comment = (dto.comment ?? '').trim();
    if (dto.result !== 'approved' && comment === '') {
      throw new BadRequestException(
        dto.result === 'returned' ? '退回要写原因' : '拒绝要写原因',
      );
    }
    // 退回 = 回到员工手里重交（needs_revision），通过 / 拒绝是终态
    const nextStatus = dto.result === 'returned' ? 'needs_revision' : dto.result;

    await this.db.transaction(async (tx) => {
      // 先落验收记录：它会核对审的是不是最新那一版，对不上整笔回滚
      const record = await this.acceptance.recordReview(tx, {
        subjectType: 'work_order',
        subjectId: row.id,
        decision: dto.result,
        reason: comment !== '' ? comment : null,
        expectedVersion: dto.version,
        operator: {
          userId: userContext.userId ?? null,
          userName: userContext.userName ?? null,
        },
      });
      const humanVerdict: WorkOrderHumanVerdict = {
        result: dto.result,
        at: new Date().toISOString(),
        ...(comment !== '' ? { comment } : {}),
        ...(record.version !== null ? { version: record.version } : {}),
      };
      const versionNote = record.version !== null ? `第 ${record.version} 版` : '';
      const eventComment = [versionNote, comment].filter((part: string) => part !== '').join('：');
      await tx.insert(workOrderEvents).values({
        workOrderId: row.id,
        fromStatus: row.status,
        toStatus: nextStatus,
        operatorType: 'boss',
        operatorId: userContext.userId ?? null,
        ...(eventComment !== '' ? { comment: eventComment } : {}),
      });
      const moved = await tx
        .update(workOrders)
        .set({
          status: nextStatus,
          humanVerdict,
          updatedAt: new Date(),
          updatedBy: userContext.userId ?? null,
        })
        .where(and(eq(workOrders.id, row.id), eq(workOrders.status, 'pending_boss')))
        .returning({ id: workOrders.id });
      if (moved.length === 0) {
        throw new ConflictException('工单刚被处理过，请刷新');
      }
    });

    const refreshed: OrderRow[] = await this.db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))
      .limit(1);
    const detail = await this.buildDetail(refreshed[0]);

    // 终审绩效入账：任何失败只降级 erpSettled=false，不阻断终审主流程
    const settle =
      dto.result === 'approved' && (dto.performanceAmount ?? 0) > 0
        ? await this.settlePerformance(
            userContext,
            refreshed[0],
            dto.performanceAmount as number,
          )
        : { erpSettled: false };

    // 终审结果通知：指派员工（交凭证的人）优先，其次提交人；与入账相互独立
    void this.notifyVerdictResult(refreshed[0], dto.result, comment);

    // 终审联动 Plane 任务状态：approved→completed 组 / refused→cancelled 组；
    // 工单未关联任务（taskId 为空）或退回修改（returned）不联动；
    // 同步失败只记 warn，不阻断终审（工单状态已落库）
    const planeTaskId: string | null = row.taskId;
    if (
      planeTaskId !== null &&
      planeTaskId !== '' &&
      (dto.result === 'approved' || dto.result === 'refused')
    ) {
      void this.syncPlaneTaskState(planeTaskId, dto.result);
    }

    return {
      order: detail,
      erpSettled: settle.erpSettled,
      ...(settle.erpSettleError !== undefined
        ? { erpSettleError: settle.erpSettleError }
        : {}),
    };
  }

  /** 终审绩效入账：工单执行人 → employee_bindings 反查 Frappe 雇员 →
 * Additional Salary；失败返回 erpSettled=false + 原因，终审照常落库 */
  private async settlePerformance(
    userContext: ReviewUserContextLike,
    row: OrderRow,
    amount: number,
  ): Promise<{ erpSettled: boolean; erpSettleError?: string }> {
    try {
      // 谁执行算谁的（老板 10-18 定）：老板发的单 createdBy 是老板本人、豆包发的是系统身份，
      // 按 createdBy 优先会把绩效记到老板头上。没指派人的（员工自己建、自己做）才退回建单人
      const performerId = row.assigneeId ?? row.createdBy;
      if (!performerId) {
        return { erpSettled: false, erpSettleError: '工单没有执行人，无法入账' };
      }
      const bindingRows: { frappeEmployeeId: string | null }[] = await this.db
        .select({ frappeEmployeeId: employeeBindings.frappeEmployeeId })
        .from(employeeBindings)
        .where(eq(employeeBindings.miaodaUserId, performerId))
        .limit(1);
      const frappeEmployeeId = bindingRows[0]?.frappeEmployeeId ?? null;
      if (!frappeEmployeeId) {
        this.logger.warn(
          `工单 ${row.code} 绩效入账跳过：执行人未绑定 HR 雇员`,
        );
        return {
          erpSettled: false,
          erpSettleError: '执行人未绑定 HR 雇员，无法入账',
        };
      }
      const components = await this.frappe.list<{ name: string }>(
        'Salary Component',
        { fields: ['name'], limit: 100 },
      );
      const component = components.find((c: { name: string }) =>
        /奖|Bonus|Reward/i.test(c.name),
      );
      if (!component) {
        this.logger.warn(
          '绩效入账跳过：Frappe 未找到奖励类 Salary Component（名称含 奖/Bonus/Reward）',
        );
        return {
          erpSettled: false,
          erpSettleError: '未找到奖励类 Salary Component（名称含 奖/Bonus/Reward）',
        };
      }
      const resourcePath = `/resource/${encodeURIComponent('Additional Salary')}`;
      const config: AxiosRequestConfig = {
        url: `${integrationConfig.frappeBaseUrl}${resourcePath}`,
        method: 'post',
        data: {
          employee: frappeEmployeeId,
          company: '杭州泛亚电子',
          payroll_date: shanghaiDateString(),
          amount,
          salary_component: component.name,
        },
        headers: {
          Authorization: `token ${integrationConfig.frappeApiKey}:${integrationConfig.frappeApiSecret}`,
        },
        timeout: 15000,
      };
      const res = await firstValueFrom(
        this.http.request<{ data: { name?: string } }>(config),
      );
      const docName = res.data?.data?.name;
      if (!docName) {
        return {
          erpSettled: false,
          erpSettleError: 'ERP 未返回入账单据编号',
        };
      }
      await this.audit.log({
        action: 'workorder_performance_settle',
        operatorId: userContext.userId ?? null,
        targetType: 'work_order',
        targetId: row.id,
        detail: { summary: `终审入账 ¥${amount}` },
      });
      this.logger.log(
        `工单 ${row.code} 终审入账 ¥${amount}：Additional Salary ${docName}`,
      );
      return { erpSettled: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `工单 ${row.code} 绩效入账失败：${message}`,
      );
      return {
        erpSettled: false,
        erpSettleError: `绩效入账失败：${message}`,
      };
    }
  }

  /**
   * 终审结果通知：指派员工优先，其次提交人（createdBy）；发送失败由 NotifyService 兜底。
   * 老板发的单 createdBy 是老板本人、豆包发的是系统身份，按 createdBy 优先会发错人。
   */
  private async notifyVerdictResult(
    row: OrderRow,
    result: 'approved' | 'refused' | 'returned',
    comment?: string,
  ): Promise<void> {
    const targetId = row.assigneeId ?? row.createdBy;
    if (!targetId) return;
    // 工单挂在任务卡上（任务详情页有工单区）；没挂任务的只看不跳
    const options = {
      category: 'workorder' as const,
      link: row.taskId ? `/tasks/${row.taskId}` : null,
    };
    if (result === 'approved') {
      await this.notify.sendToUsers(
        [targetId],
        '工单终审通过',
        `工单《${row.title}》（${row.code}）终审通过。`,
        options,
      );
      return;
    }
    if (result === 'returned') {
      await this.notify.sendToUsers(
        [targetId],
        '工单被退回',
        `工单《${row.title}》（${row.code}）被退回修改：${comment ?? ''}。改好后重新提交凭证。`,
        options,
      );
      return;
    }
    const suffix = comment ? `拒绝理由：${comment}` : '如有疑问请联系老板。';
    await this.notify.sendToUsers(
      [targetId],
      '工单被拒绝',
      `工单《${row.title}》（${row.code}）被拒绝。${suffix}`,
      options,
    );
  }

  // ==================== 终审联动 Plane 任务状态 ====================

  /** 终审结果联动 Plane：approved→completed 状态组 / refused→cancelled 状态组。
   * 任何失败（任务不存在 / 项目缺状态组 / PATCH 失败）只记 warn，
   * 不阻断终审主流程（工单状态已落库）。completed_at 由服务端在
   * state 流转进 completed 组时自动写入，直接 PATCH state 即可。 */
  private async syncPlaneTaskState(
    taskId: string,
    result: 'approved' | 'refused',
  ): Promise<void> {
    try {
      // 开发需求的完成只能走它自己的验收（要记账）；工单建单时已经挡了关联，这里再兜一层
      if (await this.devRequestLookup.findByIssueId(taskId)) {
        this.logger.warn(
          `工单终审联动 Plane 跳过：任务 ${taskId} 是开发需求，状态只能在「开发需求」页流转`,
        );
        return;
      }
      const projectId = await this.locateIssueProjectId(taskId);
      if (!projectId) {
        this.logger.warn(
          `工单终审联动 Plane 跳过：未找到任务 ${taskId}（可能已删除）`,
        );
        return;
      }
      const stateGroup = result === 'approved' ? 'completed' : 'cancelled';
      const target = (await this.loadStates(projectId))
        .filter((s: PlaneStateRaw) => s.group === stateGroup)
        .sort(
          (a: PlaneStateRaw, b: PlaneStateRaw) => a.sequence - b.sequence,
        )[0];
      if (!target) {
        this.logger.warn(
          `工单终审联动 Plane 跳过：任务 ${taskId} 所在项目没有「${stateGroup}」状态组`,
        );
        return;
      }
      await this.plane.patch(
        `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/`,
        { state: target.id },
      );
      this.logger.log(
        `工单终审联动 Plane：任务 ${taskId} 已流转为「${target.name}」`,
      );
    } catch (error) {
      this.logger.warn(
        `工单终审联动 Plane 任务状态失败（taskId=${taskId}，result=${result}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 在全部项目里定位任务所属项目 ID（Plane 无跨项目按 ID 取 issue 接口） */
  private async locateIssueProjectId(taskId: string): Promise<string | null> {
    const projects = await this.plane.listProjects<PlaneProjectRaw>();
    for (const project of projects) {
      const issue = await this.plane.getOptional<PlaneIssueRaw>(
        `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/`,
      );
      if (issue) return project.id;
    }
    return null;
  }

  // ==================== Plane 任务验收 ====================

  async listPlaneTasks(): Promise<ReviewPlaneTasksResponse> {
    const projects = await this.plane.listProjects<PlaneProjectRaw>();
    const membersRes = await this.plane.cachedGet<PlaneMemberRaw[]>(
      `${this.plane.workspacePath}/members/`,
    );
    const members: PlaneMemberRaw[] = Array.isArray(membersRes)
      ? membersRes
      : [];
    const items: ReviewPlaneTaskRow[] = [];
    const BATCH_SIZE = 3;
    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      const batch = projects.slice(i, i + BATCH_SIZE);
      const entries = await Promise.all(
        batch.map(
          async (
            project: PlaneProjectRaw,
          ): Promise<{
            project: PlaneProjectRaw;
            states: PlaneStateRaw[];
            issues: PlaneIssueRaw[];
          } | null> => {
            try {
              const [states, issues] = await Promise.all([
                this.loadStates(project.id),
                this.loadIssues(project.id),
              ]);
              return { project, states, issues };
            } catch (error) {
              this.logger.warn(
                `Plane 项目 ${project.name}(${project.id}) 数据拉取失败，已跳过`,
                error instanceof Error ? error.message : String(error),
              );
              return null;
            }
          },
        ),
      );
      for (const entry of entries) {
        if (entry === null) continue;
        for (const issue of entry.issues) {
          const state = entry.states.find(
            (s: PlaneStateRaw) => s.id === issue.state,
          );
          if (!state || mapStatusByState(state) !== 'READY_FOR_REVIEW')
            continue;
          items.push({
            taskId: issue.id,
            sequenceId: issue.sequence_id ?? 0,
            title: issue.name,
            projectName: entry.project.name,
            assigneeName: memberName(members, (issue.assignees ?? [])[0]),
            targetDate: issue.target_date,
            evidenceSummary: summarizeDescription(issue.description_html),
            ...parseWorkHours(issue.description_html),
            tutorialOutput: null,
            latestVersion: null,
          });
        }
      }
    }
    // 开发需求不在这里验收（要核对报价和验收金额、会记账）：验收 Dock 另有「开发需求待验收」
    const devRequestIds = await this.devRequestLookup.idMapByIssueIds(
      items.map((r: ReviewPlaneTaskRow) => r.taskId),
    );
    const generic = items.filter((r: ReviewPlaneTaskRow) => !devRequestIds.has(r.taskId));
    const outputMap = await this.tutorialOutputService.getByTaskIds(
      generic.map((r: ReviewPlaneTaskRow) => r.taskId),
    );
    const versionMap = await this.acceptance.latestVersionNumbers(
      'task',
      generic.map((r: ReviewPlaneTaskRow) => r.taskId),
    );
    for (const row of generic) {
      row.tutorialOutput = outputMap.get(row.taskId) ?? null;
      row.latestVersion = versionMap.get(row.taskId) ?? null;
    }
    return { items: generic };
  }

  async planeTaskAction(
    userContext: ReviewUserContextLike,
    taskId: string,
    dto: ReviewPlaneTaskActionRequest,
  ): Promise<ReviewPlaneTaskActionResponse> {
    if (await this.devRequestLookup.findByIssueId(taskId)) {
      throw new BadRequestException(
        '这是开发需求，请到「开发需求」页验收（要核对报价和验收金额，验收会记账）',
      );
    }
    const reason = (dto.comment ?? '').trim();
    if (dto.action === 'reject' && reason === '') {
      throw new BadRequestException('打回要写原因');
    }
    // 审的是哪一版：员工这期间又交了新版就拒（11-10 A02）
    await this.acceptance.assertLatestVersion('task', taskId, dto.version);
    const operator = {
      userId: userContext.userId ?? null,
      userName: userContext.userName ?? null,
    };
    const found = await this.findIssueProject(taskId);
    if (!found) throw new NotFoundException('任务不存在');
    const { project, issue } = found;
    const issuePath = `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/`;
    const states = (await this.loadStates(project.id)).sort(
      (a: PlaneStateRaw, b: PlaneStateRaw) => a.sequence - b.sequence,
    );

    if (dto.action === 'approve') {
      const target = states.find((s: PlaneStateRaw) => s.group === 'completed');
      if (!target) {
        throw new BadRequestException(
          '当前项目没有「完成」状态组，无法通过验收；请先在 Plane 中补充状态',
        );
      }
      await this.plane.patch(issuePath, { state: target.id });
      if (dto.comment !== undefined && dto.comment !== '') {
        await this.postComment(project.id, taskId, dto.comment);
      }
      await this.settleTaskReviewQueue(taskId, 'approved');
      await this.acceptance.recordReviewSafe({
        subjectType: 'task',
        subjectId: taskId,
        decision: 'approved',
        reason: reason !== '' ? reason : null,
        operator,
      });
      void this.notify.sendToPlaneMembers(
        issue.assignees ?? [],
        '任务验收通过',
        `《${issue.name}》已通过验收。`,
        { category: 'task_review', link: `/tasks/${taskId}?projectId=${project.id}` },
      );
      return { ok: true, message: `已通过验收，任务流转为「${target.name}」` };
    }

    // 打回落点与员工侧「提交阻塞」同口径（mapStatusByState），中文名「阻塞」的状态也认
    const target = states.find(
      (s: PlaneStateRaw) => mapStatusByState(s) === 'BLOCKED',
    );
    if (!target) {
      throw new BadRequestException(
        '当前项目没有「阻塞」状态（slug 含 block 或名称含「阻塞」），无法打回；请先在 Plane 中补充状态',
      );
    }
    const commentHtml = `<p>【验收打回】${escapeHtml(reason)}（来源任务：${escapeHtml(issue.name)}）</p>`;
    await this.plane.post(
      `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/comments/`,
      { comment_html: commentHtml },
    );
    await this.plane.patch(issuePath, { state: target.id });
    await this.settleTaskReviewQueue(taskId, 'rejected');
    await this.acceptance.recordReviewSafe({
      subjectType: 'task',
      subjectId: taskId,
      decision: 'returned',
      reason,
      operator,
    });
    void this.notify.sendToPlaneMembers(
      issue.assignees ?? [],
      '任务验收被打回',
      `《${issue.name}》验收被打回：${reason}。处理后在任务详情重新提交凭证。`,
      { category: 'task_review', link: `/tasks/${taskId}?projectId=${project.id}` },
    );
    return { ok: true, message: `已打回，任务流转为「${target.name}」` };
  }

  private async settleTaskReviewQueue(
    taskId: string,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    try {
      await this.db
        .update(taskReviewQueue)
        .set({ status, updatedAt: new Date() })
        .where(eq(taskReviewQueue.taskId, taskId));
    } catch (error) {
      this.logger.warn(
        `审核登记状态更新失败（${taskId} → ${status}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ==================== 内部方法 ====================

  private async loadStates(projectId: string): Promise<PlaneStateRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneStateRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/states/`,
    );
    return res.results ?? [];
  }

  private async loadIssues(projectId: string): Promise<PlaneIssueRaw[]> {
    const base = `${this.plane.workspacePath}/projects/${projectId}/issues/`;
    const all: PlaneIssueRaw[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await this.plane.cachedGet<{
        results?: PlaneIssueRaw[];
        next_page_results?: boolean;
        next_cursor?: string | null;
      }>(cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base);
      all.push(...(res.results ?? []));
      if (res.next_page_results !== true) break;
      cursor = res.next_cursor ?? undefined;
      if (cursor === undefined) break;
    }
    return all;
  }

  private async findIssueProject(
    taskId: string,
  ): Promise<{ project: PlaneProjectRaw; issue: PlaneIssueRaw } | null> {
    const projects = await this.plane.listProjects<PlaneProjectRaw>();
    const BATCH_SIZE = 3;
    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      const batch = projects.slice(i, i + BATCH_SIZE);
      const entries = await Promise.all(
        batch.map(
          async (project: PlaneProjectRaw): Promise<{
            project: PlaneProjectRaw;
            issues: PlaneIssueRaw[];
          }> => {
            const issues = await this.loadIssues(project.id).catch(
              () => [] as PlaneIssueRaw[],
            );
            return { project, issues };
          },
        ),
      );
      for (const entry of entries) {
        const issue = entry.issues.find(
          (i: PlaneIssueRaw) => i.id === taskId,
        );
        if (issue) return { project: entry.project, issue };
      }
    }
    return null;
  }

  private async postComment(
    projectId: string,
    taskId: string,
    comment: string,
  ): Promise<void> {
    await this.plane.post(
      `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/comments/`,
      { comment_html: `<p>【验收通过】${escapeHtml(comment)}</p>` },
    );
  }

  private async resolveUserNames(
    userContext: ReviewUserContextLike,
    ids: Array<string | null>,
  ): Promise<Map<string, string>> {
    const uniqueIds = [
      ...new Set(ids.filter((id: string | null): id is string => !!id)),
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
      this.logger.warn('用户姓名查询失败，保持空展示', (error as Error).stack);
      return new Map<string, string>();
    }
  }

  private async buildDetail(row: OrderRow): Promise<WorkOrderDetail> {
    const [evidenceRows, eventRows, overview] = await Promise.all([
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
      this.acceptance.overview('work_order', row.id),
    ]);
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      catalogCode: row.catalogCode,
      orderType: toOrderType(row.orderType),
      complexity: toComplexity(row.complexity),
      status: toStatus(row.status),
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
      // 终审返回给老板看的详情不带转交记录（员工端详情才列）
      handovers: [],
      versions: overview.versions,
      acceptanceRecords: overview.records,
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
      fromStatus: row.fromStatus ? toStatus(row.fromStatus) : null,
      toStatus: toStatus(row.toStatus),
      operatorType:
        row.operatorType === 'user' ||
        row.operatorType === 'ai' ||
        row.operatorType === 'boss' ||
        row.operatorType === 'webhook'
          ? row.operatorType
          : 'system',
      operatorId: row.operatorId,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
