import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { asc, desc, eq, or } from 'drizzle-orm';

import { employeeBindings } from '@server/database/schema';
import {
  devRequestEvents,
  devRequestLedger,
  devRequests,
} from '@server/database/standalone-schema';
import { UserDirectoryService } from '../auth/user-directory.service';
import { shanghaiDateString } from '../integration/plane-mapping';
import { DevRequestDevelopersService } from './dev-request-developers.service';
import type {
  DevRequestDetail,
  DevRequestDevelopersResponse,
  DevRequestEventView,
  DevRequestLedgerGroup,
  DevRequestLedgerResponse,
  DevRequestLedgerRow,
  DevRequestListResponse,
  DevRequestOptionsResponse,
  DevRequestQuote,
  DevRequestStage,
  DevRequestSummary,
} from '@shared/api.interface';
import {
  DevRequestPlaneService,
  PLANE_ID_RE,
  toPlaneHttpError,
  type PlaneIssueRaw,
  type PlaneStateRaw,
} from './dev-request-plane.service';
import { DevRequestLookupService, type DevRequestRow } from './dev-request-lookup.service';
import { splitDescription } from './dev-request-description';
import {
  allowedActionsOf,
  flowWarningOf,
  nextStepOf,
  numericToNumber,
  stageLabelOf,
  stageOfState,
  toCents,
} from './dev-request-stage';
import { canSeeDevRequest, type DevRequestViewer } from './dev-request-viewer';
import { DEV_REQUEST_NOT_FOUND } from './dev-requests.service';

type EventRow = typeof devRequestEvents.$inferSelect;
type LedgerRowDb = typeof devRequestLedger.$inferSelect;

export type DevRequestListScope = 'mine' | 'assigned' | 'all';

const LIST_LIMIT = 300;

const STAGES: DevRequestStage[] = [
  'submitted',
  'clarifying',
  'quoted',
  'developing',
  'reviewing',
  'done',
  'cancelled',
  'blocked',
  'other',
  'missing',
];

const EVENT_LABELS: Record<string, string> = {
  publish: '发布需求',
  quote: '报价',
  return: '退回补充',
  clarify: '已补充',
  confirm_quote: '确认报价',
  reject_quote: '退回报价',
  deliver: '交付',
  block: '提交阻塞',
  unblock: '解除阻塞',
  accept: '验收通过',
  reject_delivery: '验收打回',
  cancel: '撤销',
};

interface IssueState {
  issue: PlaneIssueRaw | null;
  state: PlaneStateRaw | undefined;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function readDetail(value: unknown): DevRequestEventView['detail'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const detail: NonNullable<DevRequestEventView['detail']> = {};
  for (const key of ['hours', 'amount', 'quoteAmount', 'finalAmount'] as const) {
    if (typeof raw[key] === 'number') detail[key] = raw[key] as number;
  }
  if (typeof raw.promisedDate === 'string') detail.promisedDate = raw.promisedDate;
  if (typeof raw.adjustReason === 'string') detail.adjustReason = raw.adjustReason;
  if (Array.isArray(raw.links)) {
    detail.links = raw.links.filter((link: unknown): link is string => typeof link === 'string');
  }
  return Object.keys(detail).length > 0 ? detail : null;
}

/** 上海时区某月的起止（左闭右开） */
function monthRange(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split('-').map((part: string) => Number(part));
  const start = new Date(`${month}-01T00:00:00+08:00`);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMonth = mon === 12 ? 1 : mon + 1;
  const end = new Date(
    `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`,
  );
  return { start, end };
}

/**
 * 开发需求的读：列表（我发起的 / 派给我的 / 全部）、详情（含时间线、当前用户能做的动作）、
 * 发需求用的项目和开发者选项、开发需求台账。环节一律以 Plane 当前状态为准，和流程对不上的如实标出来。
 */
@Injectable()
export class DevRequestQueryService {
  private readonly logger = new Logger(DevRequestQueryService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly planeApi: DevRequestPlaneService,
    private readonly lookup: DevRequestLookupService,
    private readonly directory: UserDirectoryService,
    private readonly developersService: DevRequestDevelopersService,
  ) {}

  async options(): Promise<DevRequestOptionsResponse> {
    const projects = await this.planeApi.devProjects();
    return {
      projects: projects.map((project) => ({
        projectId: project.id,
        name: project.name,
        identifier: project.identifier,
      })),
    };
  }

  /** 这个项目能派的开发者：项目成员且绑定了员工，排除自己 */
  async developers(
    viewer: DevRequestViewer,
    projectId: string,
  ): Promise<DevRequestDevelopersResponse> {
    if (!PLANE_ID_RE.test(projectId ?? '')) {
      throw new BadRequestException('请先选项目');
    }
    const members = await this.planeApi.projectMemberIds(projectId);
    const bindings: { userId: string; memberId: string; name: string | null }[] =
      await this.db
        .select({
          userId: employeeBindings.miaodaUserId,
          memberId: employeeBindings.planeMemberId,
          name: employeeBindings.planeMemberName,
        })
        .from(employeeBindings);
    const candidates = bindings.filter(
      (binding) =>
        binding.userId !== viewer.userId &&
        (members === null || members.has(binding.memberId)),
    );
    // 开发名单白名单（2026-10-22）：配了 dev_request.developer_user_ids 就只留名单里的人
    const allowed = await this.developersService.allowedDeveloperIds();
    const selectable =
      allowed === null
        ? candidates
        : candidates.filter((binding) => allowed.has(binding.userId));
    const names = await this.directory
      .listUsersByIds(selectable.map((c) => c.userId))
      .catch(() => selectable.map(() => null));
    return {
      developers: selectable
        .map((candidate, index: number) => ({
          userId: candidate.userId,
          name: names[index]?.name.zh_cn || candidate.name || candidate.userId,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    };
  }

  async list(
    viewer: DevRequestViewer,
    scope: DevRequestListScope,
  ): Promise<DevRequestListResponse> {
    if (scope === 'all' && !viewer.canSeeAll) {
      throw new ForbiddenException('只有老板、管理员能看全部开发需求');
    }
    const where =
      scope === 'all'
        ? undefined
        : scope === 'assigned'
          ? eq(devRequests.developerId, viewer.userId)
          : eq(devRequests.publisherId, viewer.userId);
    const rows: DevRequestRow[] = await this.db
      .select()
      .from(devRequests)
      .where(where)
      .orderBy(desc(devRequests.updatedAt))
      .limit(LIST_LIMIT);
    const items = await this.summarize(viewer, rows);
    return { items, canSeeAll: viewer.canSeeAll };
  }

  /** 管理端：全部，可按环节筛 */
  async adminList(
    viewer: DevRequestViewer,
    stage: string | undefined,
  ): Promise<DevRequestListResponse> {
    const result = await this.list(viewer, 'all');
    if (stage && (STAGES as string[]).includes(stage)) {
      result.items = result.items.filter(
        (item: DevRequestSummary) => item.stage === stage,
      );
    }
    return result;
  }

  async detail(viewer: DevRequestViewer, id: string): Promise<DevRequestDetail> {
    if (!PLANE_ID_RE.test(id)) throw new NotFoundException(DEV_REQUEST_NOT_FOUND);
    const row = await this.lookup.findById(id);
    if (!row || !canSeeDevRequest(viewer, row)) {
      throw new NotFoundException(DEV_REQUEST_NOT_FOUND);
    }
    const [issue, states, events] = await Promise.all([
      this.planeApi.getIssueFresh(row.planeProjectId, row.planeIssueId),
      this.planeApi.loadStates(row.planeProjectId),
      this.db
        .select()
        .from(devRequestEvents)
        .where(eq(devRequestEvents.devRequestId, row.id))
        .orderBy(asc(devRequestEvents.createdAt)),
    ]);
    const issueState: IssueState = {
      issue,
      state: issue ? states.find((s: PlaneStateRaw) => s.id === issue.state) : undefined,
    };
    const names = await this.nameMap([row]);
    const summary = this.toSummary(viewer, row, issueState, names);
    const { body, acceptance } = splitDescription(issue?.description_html ?? null);
    const lastAcceptance = [...events]
      .reverse()
      .map((event: EventRow) => (event.detail as { acceptance?: unknown } | null)?.acceptance)
      .find((value: unknown): value is string => typeof value === 'string');
    return {
      ...summary,
      description: body,
      acceptance: acceptance ?? lastAcceptance ?? null,
      delivery: row.deliveredAt
        ? {
            note: row.deliveryNote ?? '',
            links: Array.isArray(row.deliveryLinks) ? row.deliveryLinks : [],
            deliveredAt: row.deliveredAt.toISOString(),
          }
        : null,
      adjustReason: row.adjustReason,
      acceptedByName: row.acceptedBy ? (names.get(row.acceptedBy) ?? null) : null,
      cancelReason: row.cancelReason,
      events: events.map(
        (event: EventRow): DevRequestEventView => ({
          id: event.id,
          action: event.action,
          actionLabel: EVENT_LABELS[event.action] ?? event.action,
          actorName: event.actorName,
          toStage: (STAGES as string[]).includes(event.toStage ?? '')
            ? (event.toStage as DevRequestStage)
            : null,
          note: event.note,
          detail: readDetail(event.detail),
          createdAt: event.createdAt.toISOString(),
        }),
      ),
      actions: allowedActionsOf(
        { userId: viewer.userId, isBoss: viewer.isBoss },
        row,
        summary.stage,
      ),
    };
  }

  // ==================== 台账 ====================

  async ledger(query: {
    month?: string;
    developerId?: string;
    projectId?: string;
  }): Promise<DevRequestLedgerResponse> {
    const monthRaw = (query.month ?? '').trim();
    const month = monthRaw === '' || monthRaw === 'all' ? null : monthRaw;
    if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) {
      throw new BadRequestException('月份格式应为 YYYY-MM');
    }
    const all: LedgerRowDb[] = await this.db
      .select()
      .from(devRequestLedger)
      .orderBy(desc(devRequestLedger.acceptedAt));
    const developerOptions = new Map<string, string>();
    const projectOptions = new Map<string, string>();
    for (const row of all) {
      developerOptions.set(row.developerId, row.developerName ?? row.developerId);
      projectOptions.set(row.planeProjectId, row.projectName || row.planeProjectId);
    }
    const range = month ? monthRange(month) : null;
    const developerId = (query.developerId ?? '').trim();
    const projectId = (query.projectId ?? '').trim();
    const filtered = all.filter(
      (row: LedgerRowDb) =>
        (!range || (row.acceptedAt >= range.start && row.acceptedAt < range.end)) &&
        (developerId === '' || row.developerId === developerId) &&
        (projectId === '' || row.planeProjectId === projectId),
    );
    const rows: DevRequestLedgerRow[] = filtered.map(
      (row: LedgerRowDb): DevRequestLedgerRow => ({
        id: row.id,
        devRequestId: row.devRequestId,
        title: row.title,
        projectId: row.planeProjectId,
        projectName: row.projectName,
        sequenceId: row.planeSequenceId,
        publisherId: row.publisherId,
        publisherName: row.publisherName ?? row.publisherId,
        developerId: row.developerId,
        developerName: row.developerName ?? row.developerId,
        quoteHours: numericToNumber(row.quoteHours) ?? 0,
        quoteAmount: numericToNumber(row.quoteAmount) ?? 0,
        finalAmount: numericToNumber(row.finalAmount) ?? 0,
        adjustReason: row.adjustReason,
        acceptedByName: row.acceptedByName,
        acceptedAt: row.acceptedAt.toISOString(),
        acceptedDate: shanghaiDateString(row.acceptedAt.toISOString()),
      }),
    );
    // 金额按分加，免得浮点误差
    const cents = (value: number): number => toCents(value) ?? 0;
    const group = (
      keyOf: (row: DevRequestLedgerRow) => [string, string],
    ): DevRequestLedgerGroup[] => {
      const map = new Map<string, { name: string; count: number; quote: number; final: number }>();
      for (const row of rows) {
        const [key, name] = keyOf(row);
        const entry = map.get(key) ?? { name, count: 0, quote: 0, final: 0 };
        entry.count += 1;
        entry.quote += cents(row.quoteAmount);
        entry.final += cents(row.finalAmount);
        map.set(key, entry);
      }
      return [...map.entries()]
        .map(([key, entry]) => ({
          id: key,
          name: entry.name,
          count: entry.count,
          quoteAmount: entry.quote / 100,
          finalAmount: entry.final / 100,
        }))
        .sort((a, b) => b.finalAmount - a.finalAmount);
    };
    return {
      month,
      rows,
      total: {
        count: rows.length,
        hours:
          Math.round(rows.reduce((sum: number, row) => sum + row.quoteHours * 100, 0)) / 100,
        quoteAmount: rows.reduce((sum: number, row) => sum + cents(row.quoteAmount), 0) / 100,
        finalAmount: rows.reduce((sum: number, row) => sum + cents(row.finalAmount), 0) / 100,
      },
      byDeveloper: group((row) => [row.developerId, row.developerName]),
      byProject: group((row) => [row.projectId, row.projectName]),
      developerOptions: [...developerOptions.entries()].map(([id, name]) => ({ id, name })),
      projectOptions: [...projectOptions.entries()].map(([id, name]) => ({ id, name })),
    };
  }

  /** 给「我的」页入口用：轮到我处理的条数（列表接口里 needsMe 的数） */
  async countNeedsMe(viewer: DevRequestViewer): Promise<number> {
    const rows: DevRequestRow[] = await this.db
      .select()
      .from(devRequests)
      .where(
        or(
          eq(devRequests.publisherId, viewer.userId),
          eq(devRequests.developerId, viewer.userId),
        ),
      )
      .orderBy(desc(devRequests.updatedAt))
      .limit(LIST_LIMIT);
    const items = await this.summarize(viewer, rows);
    return items.filter((item: DevRequestSummary) => item.needsMe).length;
  }

  // ==================== 内部 ====================

  private async summarize(
    viewer: DevRequestViewer,
    rows: DevRequestRow[],
  ): Promise<DevRequestSummary[]> {
    if (rows.length === 0) return [];
    const issueStates = await this.loadIssueStates(rows);
    const names = await this.nameMap(rows);
    return rows.map((row: DevRequestRow) =>
      this.toSummary(
        viewer,
        row,
        issueStates.get(row.id) ?? { issue: null, state: undefined },
        names,
      ),
    );
  }

  /** 按项目一次拉全任务（15 秒缓存）拿各条的当前状态；列表里没有的单取一次 */
  private async loadIssueStates(rows: DevRequestRow[]): Promise<Map<string, IssueState>> {
    const result = new Map<string, IssueState>();
    const byProject = new Map<string, DevRequestRow[]>();
    for (const row of rows) {
      const list = byProject.get(row.planeProjectId);
      if (list) list.push(row);
      else byProject.set(row.planeProjectId, [row]);
    }
    await Promise.all(
      [...byProject.entries()].map(async ([projectId, projectRows]) => {
        try {
          const [states, issues] = await Promise.all([
            this.planeApi.loadStates(projectId),
            this.planeApi.listIssues(projectId),
          ]);
          const issueById = new Map(issues.map((issue: PlaneIssueRaw) => [issue.id, issue]));
          for (const row of projectRows) {
            const issue =
              issueById.get(row.planeIssueId) ??
              (await this.planeApi.getIssueCached(projectId, row.planeIssueId));
            result.set(row.id, {
              issue,
              state: issue
                ? states.find((s: PlaneStateRaw) => s.id === issue.state)
                : undefined,
            });
          }
        } catch (error) {
          this.logger.warn(
            `读开发需求所在项目（${projectId}）的任务失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw toPlaneHttpError(error);
        }
      }),
    );
    return result;
  }

  /** 报价人、确认人、验收人的姓名（快照优先，查不到用 ID） */
  private async nameMap(rows: DevRequestRow[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const row of rows) {
      names.set(row.publisherId, row.publisherName ?? row.publisherId);
      names.set(row.developerId, row.developerName ?? row.developerId);
    }
    const missing = [
      ...new Set(
        rows
          .flatMap((row: DevRequestRow) => [row.quotedBy, row.quoteConfirmedBy, row.acceptedBy])
          .filter((id: string | null): id is string => Boolean(id) && !names.has(id as string)),
      ),
    ];
    if (missing.length > 0) {
      const users = await this.directory
        .listUsersByIds(missing)
        .catch(() => missing.map(() => null));
      missing.forEach((id: string, index: number) => {
        names.set(id, users[index]?.name.zh_cn || id);
      });
    }
    return names;
  }

  private toSummary(
    viewer: DevRequestViewer,
    row: DevRequestRow,
    { issue, state }: IssueState,
    names: Map<string, string>,
  ): DevRequestSummary {
    const stage: DevRequestStage = !issue
      ? 'missing'
      : state
        ? stageOfState(state)
        : 'other';
    const stateName = state?.name ?? null;
    const quoteHours = numericToNumber(row.quoteHours);
    const quoteAmount = numericToNumber(row.quoteAmount);
    const quote: DevRequestQuote | null =
      row.quotedAt && quoteHours !== null && quoteAmount !== null
        ? {
            hours: quoteHours,
            amount: quoteAmount,
            note: row.quoteNote,
            promisedDate: row.quotePromisedDate,
            quotedAt: row.quotedAt.toISOString(),
            quotedByName: row.quotedBy ? (names.get(row.quotedBy) ?? null) : null,
            confirmedAt: toIso(row.quoteConfirmedAt),
            confirmedByName: row.quoteConfirmedBy
              ? (names.get(row.quoteConfirmedBy) ?? null)
              : null,
          }
        : null;
    const actions = allowedActionsOf(
      { userId: viewer.userId, isBoss: viewer.isBoss },
      row,
      stage,
    );
    const myRole: DevRequestSummary['myRole'] =
      viewer.userId === row.publisherId
        ? 'publisher'
        : viewer.userId === row.developerId
          ? 'developer'
          : viewer.isBoss
            ? 'boss'
            : 'viewer';
    return {
      id: row.id,
      title: issue?.name ?? row.title,
      projectId: row.planeProjectId,
      projectName: row.projectName,
      issueId: row.planeIssueId,
      sequenceId: issue?.sequence_id ?? row.planeSequenceId,
      stage,
      stageLabel: stageLabelOf(stage, stateName, row),
      nextStep: nextStepOf(stage, row),
      publisherId: row.publisherId,
      publisherName: row.publisherName ?? row.publisherId,
      developerId: row.developerId,
      developerName: row.developerName ?? row.developerId,
      quote,
      finalAmount: numericToNumber(row.finalAmount),
      acceptedAt: toIso(row.acceptedAt),
      cancelledAt: toIso(row.cancelledAt),
      warning: flowWarningOf(stage, stateName, row),
      myRole,
      needsMe: actions.some((action) => action !== 'cancel'),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
