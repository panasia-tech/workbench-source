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
import { eq } from 'drizzle-orm';

import { employeeBindings } from '@server/database/schema';
import {
  devRequestEvents,
  devRequestLedger,
  devRequests,
} from '@server/database/standalone-schema';
import { NotifyService } from '../integration/notify.service';
import { UserDirectoryService } from '../auth/user-directory.service';
import { parseRewardAmount, todayDateString } from '../integration/plane-mapping';
import { DevRequestDevelopersService } from './dev-request-developers.service';
import type {
  CreateDevRequestRequest,
  DevRequestAcceptRequest,
  DevRequestAction,
  DevRequestActionResponse,
  DevRequestClarifyRequest,
  DevRequestDeliverRequest,
  DevRequestQuoteRequest,
  DevRequestStage,
  TaskActionResult,
  TaskStatus,
} from '@shared/api.interface';
import {
  DevRequestPlaneService,
  PLANE_ID_RE,
  type PlaneIssueRaw,
  type PlaneStateRaw,
} from './dev-request-plane.service';
import { DevRequestLookupService, type DevRequestRow } from './dev-request-lookup.service';
import {
  buildDescriptionHtml,
  escapeHtml,
  singleLine,
  upsertManagedLines,
} from './dev-request-description';
import {
  centsToNumeric,
  findFlowState,
  findGroupState,
  hoursText,
  isDevProjectStates,
  numericToNumber,
  preconditionError,
  rolePermits,
  stagePermits,
  stageOfState,
  stageText,
  toCents,
  yuanText,
  type DevFlowStage,
} from './dev-request-stage';
import { canSeeDevRequest, type DevRequestViewer } from './dev-request-viewer';

type DevRequestInsert = typeof devRequests.$inferInsert;
type LedgerInsert = typeof devRequestLedger.$inferInsert;

/** 开发需求不存在与不是自己的（不是发布人、开发者，也不是 boss/admin）同一句话、同一个 404 */
export const DEV_REQUEST_NOT_FOUND = '开发需求不存在';

const PAGE_HINT = '报价、确认报价、交付、验收都在工作台「开发需求」页里做';

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 5000;
const MAX_ACCEPTANCE = 500;
const MAX_REASON = 500;
const MAX_NOTE = 2000;
const MAX_LINKS = 20;
const MAX_HOURS_HUNDREDTHS = 10_000 * 100;
const MAX_AMOUNT_CENTS = 10_000_000 * 100;

const ACTION_TEXT: Record<DevRequestAction, string> = {
  quote: '报价',
  return: '退回补充',
  clarify: '补充需求',
  confirm_quote: '确认报价',
  reject_quote: '退回报价',
  deliver: '交付',
  block: '提交阻塞',
  unblock: '解除阻塞',
  accept: '验收',
  reject_delivery: '打回',
  cancel: '撤销',
};

const FORBIDDEN_TEXT: Record<DevRequestAction, string> = {
  quote: '只有开发者（或老板）能报价，发布人不能给自己的需求报价',
  return: '只有开发者能退回补充',
  clarify: '只有发布人能补充需求',
  confirm_quote: '只有发布人（或老板）能确认报价，开发者不能确认自己的报价',
  reject_quote: '只有发布人（或老板）能退回报价，开发者不能退回自己的报价',
  deliver: '只有开发者能交付',
  block: '只有开发者能提交阻塞',
  unblock: '只有开发者（或老板）能解除阻塞',
  accept: '只有发布人（或老板）能验收，开发者不能验收自己的交付',
  reject_delivery: '只有发布人（或老板）能打回，开发者不能打回自己的交付',
  cancel: '只有发布人（或老板）能撤销',
};

interface NotifySpec {
  userIds: string[];
  title: string;
  body: string;
}

interface TransitionSpec {
  action: DevRequestAction;
  to: DevFlowStage | 'done' | 'cancelled';
  /** 在锁里、Plane 实读之后再查一遍流程数据（如验收金额和报价比），不通过抛 400 */
  check?: (row: DevRequestRow) => void;
  /** 改这条需求的哪些列（expected_stage、updated_at 由框架写） */
  patch?: (row: DevRequestRow, now: Date) => Partial<DevRequestInsert>;
  /** 新的 Plane 描述；不改返回 null */
  description?: (currentHtml: string | null, row: DevRequestRow) => string | null;
  note?: string | null;
  detail?: (row: DevRequestRow) => Record<string, unknown> | null;
  ledger?: (row: DevRequestRow, actorName: string, now: Date) => LedgerInsert;
  /** Plane 评论正文（纯文本，会转义） */
  comment: (actorName: string, row: DevRequestRow) => string;
  notify: (row: DevRequestRow, actorName: string, viewer: DevRequestViewer) => NotifySpec[];
  message: (row: DevRequestRow) => string;
}

/** 任务卡通用入口的调用方（TasksService 的 TaskViewer：boss/admin 本人 fullAccess） */
export interface GenericTaskActor {
  userId: string;
  fullAccess: boolean;
}

function requireText(
  raw: unknown,
  max: number,
  emptyMessage: string,
  tooLongMessage: string,
): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw new BadRequestException(emptyMessage);
  if (value.length > max) throw new BadRequestException(tooLongMessage);
  return value;
}

function optionalText(raw: unknown, max: number, tooLongMessage: string): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return null;
  if (value.length > max) throw new BadRequestException(tooLongMessage);
  return value;
}

function requireReason(raw: unknown, what: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < 2) throw new BadRequestException(`请写${what}（至少 2 个字）`);
  if (value.length > MAX_REASON) {
    throw new BadRequestException(`${what}最多 ${MAX_REASON} 个字`);
  }
  return value;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function quoteSummary(row: Pick<DevRequestRow, 'quoteHours' | 'quoteAmount'>): string {
  const hours = numericToNumber(row.quoteHours) ?? 0;
  const amount = numericToNumber(row.quoteAmount) ?? 0;
  return `工时 ${hoursText(hours)} 小时，报价 ¥${yuanText(amount)}`;
}

/**
 * 开发需求的流程：发布、报价、退回补充、已补充、确认 / 退回报价、交付、验收 / 打回、撤销。
 *
 * 每个动作：先认人（看不到 404、身份不对 403）→ 锁住这一行 → 实读 Plane 当前状态，不在该在的环节就 400
 * （状态可能刚被别人、或在 Plane 里改过）→ 写库（需求、事件、验收时的台账）→ 改 Plane 状态和描述 → 提交；
 * Plane 改失败整个回滚。提交后补 Plane 评论、发站内消息给下一步该动手的人（失败只记日志）。
 * 价格只记账、不进钱包：不写 reward_ledger，标题里不写「+N元」。
 */
@Injectable()
export class DevRequestsService {
  private readonly logger = new Logger(DevRequestsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly planeApi: DevRequestPlaneService,
    private readonly lookup: DevRequestLookupService,
    private readonly notifyService: NotifyService,
    private readonly directory: UserDirectoryService,
    private readonly developersService: DevRequestDevelopersService,
  ) {}

  // ==================== 发布 ====================

  async create(
    viewer: DevRequestViewer,
    dto: CreateDevRequestRequest,
  ): Promise<DevRequestActionResponse> {
    const title = requireText(dto.title, MAX_TITLE, '请写标题', `标题最多 ${MAX_TITLE} 个字`);
    if (parseRewardAmount(title) !== null) {
      throw new BadRequestException(
        '标题里不能写「+N元」（会被当成委派奖励）；价格由开发者报价，只记账',
      );
    }
    const description = requireText(
      dto.description,
      MAX_DESCRIPTION,
      '请写需求说明',
      `需求说明最多 ${MAX_DESCRIPTION} 个字`,
    );
    const acceptance = singleLine(typeof dto.acceptance === 'string' ? dto.acceptance : '');
    if (acceptance === '') throw new BadRequestException('请写验收条件');
    if (acceptance.length > MAX_ACCEPTANCE) {
      throw new BadRequestException(`验收条件最多 ${MAX_ACCEPTANCE} 个字`);
    }
    const projectId = typeof dto.projectId === 'string' ? dto.projectId.trim() : '';
    const developerId = typeof dto.developerId === 'string' ? dto.developerId.trim() : '';
    if (developerId === '') throw new BadRequestException('请选开发者');
    if (developerId === viewer.userId) {
      throw new BadRequestException('不能派给自己：自己报价、自己确认就没意义了');
    }
    const project = PLANE_ID_RE.test(projectId)
      ? (await this.planeApi.listProjects()).find((p) => p.id === projectId)
      : undefined;
    if (!project) throw new BadRequestException('项目不存在');
    const states: PlaneStateRaw[] = await this.planeApi.loadStates(projectId);
    const submitState = findFlowState(states, 'submitted');
    if (!isDevProjectStates(states) || !submitState) {
      throw new BadRequestException(
        `「${project.name}」不是开发类项目（没有「需求提交」到「结果验收」五步状态），不能发开发需求`,
      );
    }
    const binding = (
      await this.db
        .select()
        .from(employeeBindings)
        .where(eq(employeeBindings.miaodaUserId, developerId))
        .limit(1)
    )[0];
    if (!binding) {
      throw new BadRequestException(
        '这个人还没绑定 Plane 成员，派不了（找管理员在「管理 → 员工绑定」里绑）',
      );
    }
    // 开发名单白名单（2026-10-22 老板定）：配了 dev_request.developer_user_ids 就只放行名单里的人
    const allowedDevelopers = await this.developersService.allowedDeveloperIds();
    if (allowedDevelopers !== null && !allowedDevelopers.has(developerId)) {
      throw new BadRequestException(
        '这个人不在开发名单里，派不了（管理员在「管理 → 系统配置」的 dev_request.developer_user_ids 里加）',
      );
    }
    const [publisherName, developerName] = await this.namesOf([viewer.userId, developerId], {
      [developerId]: binding.planeMemberName ?? null,
    });
    const members = await this.planeApi.projectMemberIds(projectId);
    if (members !== null && !members.has(binding.planeMemberId)) {
      throw new BadRequestException(
        `${developerName} 不是「${project.name}」的项目成员，派不了`,
      );
    }

    const created: PlaneIssueRaw = await this.planeApi.createIssue(projectId, {
      name: title,
      description_html: buildDescriptionHtml(description, [
        ['验收条件', acceptance],
        ['发布人', publisherName],
        ['开发', developerName],
      ]),
      state: submitState.id,
      assignees: [binding.planeMemberId],
    });
    if (!created?.id) {
      throw new BadRequestException('建 Plane 任务失败：Plane 没返回任务 ID');
    }
    // Plane 会悄悄去掉不是项目正式成员（访客、已停用）的负责人：没派上就删掉刚建的任务
    const assignees =
      created.assignees ??
      (await this.planeApi.getIssueFresh(projectId, created.id))?.assignees ??
      [];
    if (!assignees.includes(binding.planeMemberId)) {
      await this.discardIssue(projectId, created.id);
      throw new BadRequestException(
        `${developerName} 在「${project.name}」里不是正式成员（访客或已停用），Plane 不让派给他；请先在 Plane 里把他设为成员`,
      );
    }

    const now = new Date();
    let id: string;
    try {
      id = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(devRequests)
          .values({
            planeProjectId: projectId,
            planeIssueId: created.id,
            planeSequenceId: created.sequence_id ?? null,
            projectName: project.name.slice(0, 255),
            title,
            publisherId: viewer.userId,
            publisherName: publisherName.slice(0, 100),
            developerId,
            developerName: developerName.slice(0, 100),
            developerMemberId: binding.planeMemberId,
            expectedStage: 'submitted',
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: devRequests.id });
        await tx.insert(devRequestEvents).values({
          devRequestId: rows[0].id,
          action: 'publish',
          fromStage: null,
          toStage: 'submitted',
          actorId: viewer.userId,
          actorName: publisherName.slice(0, 100),
          actorRole: 'publisher',
          note: null,
          detail: { acceptance },
          createdAt: now,
        });
        return rows[0].id;
      });
    } catch (error) {
      // 库没写进去：删掉刚建的 Plane 任务，免得留一条没人管的开发类任务
      await this.discardIssue(projectId, created.id);
      throw error;
    }

    void this.comment(
      projectId,
      created.id,
      `【开发需求·发布】${publisherName} 发布需求，派给 ${developerName}；价格由开发者报价，只记账不进钱包`,
    );
    void this.sendNotifications(id, viewer.userId, [
      {
        userIds: [developerId],
        title: '有新的开发需求派给你',
        body: `《${title}》（${project.name}）由 ${publisherName} 发布，请评估工时和报价。`,
      },
    ]);
    return { ok: true, message: '已发布，等开发者报价', id, stage: 'submitted' };
  }

  // ==================== 开发者：报价 / 退回补充 / 交付 ====================

  async quote(
    viewer: DevRequestViewer,
    id: string,
    dto: DevRequestQuoteRequest,
  ): Promise<DevRequestActionResponse> {
    const hundredths = toCents(dto.hours);
    if (hundredths === null || hundredths <= 0 || hundredths > MAX_HOURS_HUNDREDTHS) {
      throw new BadRequestException('工时要大于 0（小时），最多两位小数');
    }
    const cents = toCents(dto.amount);
    if (cents === null || cents > MAX_AMOUNT_CENTS) {
      throw new BadRequestException('报价要在 0 到 1000 万元之间，最多两位小数');
    }
    const note = optionalText(dto.note, 1000, '报价说明最多 1000 个字');
    const promisedRaw = typeof dto.promisedDate === 'string' ? dto.promisedDate.trim() : '';
    const promisedDate = promisedRaw === '' ? null : promisedRaw;
    if (promisedDate !== null) {
      if (!isValidDate(promisedDate)) {
        throw new BadRequestException('承诺交付日期格式应为 YYYY-MM-DD');
      }
      if (promisedDate < todayDateString()) {
        throw new BadRequestException('承诺交付日期不能早于今天');
      }
    }
    const hours = hundredths / 100;
    const amount = cents / 100;
    return this.transition(viewer, id, {
      action: 'quote',
      to: 'quoted',
      patch: (_row: DevRequestRow, now: Date) => ({
        quoteHours: centsToNumeric(hundredths),
        quoteAmount: centsToNumeric(cents),
        quoteNote: note,
        quotePromisedDate: promisedDate,
        quotedAt: now,
        quotedBy: viewer.userId,
        quoteConfirmedAt: null,
        quoteConfirmedBy: null,
        // 新报价 = 新一轮：以前的交付（比如在 Plane 里被拖回来过）作废
        deliveryNote: null,
        deliveryLinks: [],
        deliveredAt: null,
      }),
      description: (html: string | null) =>
        upsertManagedLines(html, {
          工时: `${hoursText(hours)}h`,
          报价: `¥${yuanText(amount)}（只记账）`,
          承诺交付: promisedDate,
        }),
      note,
      detail: () => ({ hours, amount, promisedDate }),
      comment: (actor: string) =>
        `【开发需求·报价】${actor}：工时 ${hoursText(hours)} 小时，报价 ¥${yuanText(amount)}（只记账，不进钱包）${
          promisedDate ? `，承诺 ${promisedDate} 前交付` : ''
        }${note ? `。说明：${note}` : ''}`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.publisherId],
          title: '开发需求有报价了，等你确认',
          body: `《${row.title}》${actor} 报价：工时 ${hoursText(hours)} 小时，¥${yuanText(amount)}（只记账）。确认后才开工。`,
        },
        ...(viewer.userId !== row.developerId
          ? [
              {
                userIds: [row.developerId],
                title: '老板替你报了价',
                body: `《${row.title}》${actor} 替你报价：工时 ${hoursText(hours)} 小时，¥${yuanText(amount)}。`,
              },
            ]
          : []),
      ],
      message: () => '已报价，等发布人确认',
    });
  }

  async returnForClarification(
    viewer: DevRequestViewer,
    id: string,
    rawReason: unknown,
  ): Promise<DevRequestActionResponse> {
    const reason = requireReason(rawReason, '要补充什么');
    return this.transition(viewer, id, {
      action: 'return',
      to: 'clarifying',
      note: reason,
      comment: (actor: string) => `【开发需求·退回补充】${actor}：${reason}`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.publisherId],
          title: '开发需求被退回，请补充',
          body: `《${row.title}》${actor} 需要你补充：${reason}`,
        },
      ],
      message: () => '已退回给发布人补充',
    });
  }

  async deliver(
    viewer: DevRequestViewer,
    id: string,
    dto: DevRequestDeliverRequest,
  ): Promise<DevRequestActionResponse> {
    const row = await this.loadVisible(viewer, id);
    return this.transitionRow(viewer, row, this.deliverSpec(dto.note, dto.links));
  }

  private deliverSpec(rawNote: unknown, rawLinks: unknown): TransitionSpec {
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';
    if (note.length < 2) throw new BadRequestException('请写交付说明（至少 2 个字）');
    if (note.length > MAX_NOTE) {
      throw new BadRequestException(`交付说明最多 ${MAX_NOTE} 个字`);
    }
    const links = (Array.isArray(rawLinks) ? rawLinks : [])
      .map((link: unknown) => (typeof link === 'string' ? link.trim() : ''))
      .filter((link: string) => link !== '');
    if (links.length > MAX_LINKS) {
      throw new BadRequestException(`交付链接最多 ${MAX_LINKS} 个`);
    }
    if (links.some((link: string) => !/^https?:\/\/\S+$/iu.test(link) || link.length > 1000)) {
      throw new BadRequestException('交付链接要以 http:// 或 https:// 开头');
    }
    return {
      action: 'deliver',
      to: 'reviewing',
      patch: (_row: DevRequestRow, now: Date) => ({
        deliveryNote: note,
        deliveryLinks: links,
        deliveredAt: now,
      }),
      note,
      detail: () => (links.length > 0 ? { links } : null),
      comment: (actor: string) =>
        `【开发需求·交付】${actor}：${note}${links.map((link: string) => `\n${link}`).join('')}`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.publisherId],
          title: '开发需求已交付，等你验收',
          body: `《${row.title}》${actor} 已交付：${note}`,
        },
      ],
      message: () => '已交付，等发布人验收',
    };
  }

  // ==================== 发布人：补充 / 确认报价 / 退回报价 / 验收 / 打回 / 撤销 ====================

  async clarify(
    viewer: DevRequestViewer,
    id: string,
    dto: DevRequestClarifyRequest,
  ): Promise<DevRequestActionResponse> {
    const description = requireText(
      dto.description,
      MAX_DESCRIPTION,
      '请写需求说明',
      `需求说明最多 ${MAX_DESCRIPTION} 个字`,
    );
    const acceptance = singleLine(typeof dto.acceptance === 'string' ? dto.acceptance : '');
    if (acceptance === '') throw new BadRequestException('请写验收条件');
    if (acceptance.length > MAX_ACCEPTANCE) {
      throw new BadRequestException(`验收条件最多 ${MAX_ACCEPTANCE} 个字`);
    }
    const note = optionalText(dto.note, MAX_REASON, `补充说明最多 ${MAX_REASON} 个字`);
    return this.transition(viewer, id, {
      action: 'clarify',
      to: 'submitted',
      description: (_html: string | null, row: DevRequestRow) =>
        buildDescriptionHtml(description, [
          ['验收条件', acceptance],
          ['发布人', row.publisherName ?? row.publisherId],
          ['开发', row.developerName ?? row.developerId],
        ]),
      note,
      detail: () => ({ acceptance }),
      comment: (actor: string) =>
        `【开发需求·已补充】${actor} 已补充需求${note ? `：${note}` : ''}；验收条件=${acceptance}`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.developerId],
          title: '开发需求已补充，请重新评估',
          body: `《${row.title}》${actor} 已补充需求${note ? `：${note}` : ''}，请重新评估工时和报价。`,
        },
      ],
      message: () => '已补充，等开发者重新评估报价',
    });
  }

  async confirmQuote(
    viewer: DevRequestViewer,
    id: string,
  ): Promise<DevRequestActionResponse> {
    return this.transition(viewer, id, {
      action: 'confirm_quote',
      to: 'developing',
      patch: (_row: DevRequestRow, now: Date) => ({
        quoteConfirmedAt: now,
        quoteConfirmedBy: viewer.userId,
      }),
      detail: (row: DevRequestRow) => ({
        hours: numericToNumber(row.quoteHours),
        amount: numericToNumber(row.quoteAmount),
      }),
      comment: (actor: string, row: DevRequestRow) =>
        `【开发需求·确认报价】${actor} 确认报价（${quoteSummary(row)}，只记账），开始开发`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.developerId],
          title: '报价已确认，可以开工',
          body: `《${row.title}》${actor} 已确认报价（${quoteSummary(row)}），请开始开发。`,
        },
        ...this.bossActedNotice(viewer, row, actor, '确认了报价'),
      ],
      message: () => '已确认报价，开发者可以开工',
    });
  }

  async rejectQuote(
    viewer: DevRequestViewer,
    id: string,
    rawReason: unknown,
  ): Promise<DevRequestActionResponse> {
    const reason = requireReason(rawReason, '退回报价的原因');
    return this.transition(viewer, id, {
      action: 'reject_quote',
      to: 'submitted',
      // 被退回的报价作废：当前报价清空（历史在事件里），描述里的工时、报价行去掉
      patch: () => ({
        quoteHours: null,
        quoteAmount: null,
        quoteNote: null,
        quotePromisedDate: null,
        quotedAt: null,
        quotedBy: null,
        quoteConfirmedAt: null,
        quoteConfirmedBy: null,
      }),
      description: (html: string | null) =>
        upsertManagedLines(html, { 工时: null, 报价: null, 承诺交付: null }),
      note: reason,
      detail: (row: DevRequestRow) => ({
        hours: numericToNumber(row.quoteHours),
        amount: numericToNumber(row.quoteAmount),
      }),
      comment: (actor: string, row: DevRequestRow) =>
        `【开发需求·退回报价】${actor} 退回报价（${quoteSummary(row)}）：${reason}`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.developerId],
          title: '报价被退回',
          body: `《${row.title}》${actor} 退回了报价：${reason}。请重新评估后再报价。`,
        },
        ...this.bossActedNotice(viewer, row, actor, `退回了报价：${reason}`),
      ],
      message: () => '已退回报价，等开发者重新报价',
    });
  }

  async accept(
    viewer: DevRequestViewer,
    id: string,
    dto: DevRequestAcceptRequest,
  ): Promise<DevRequestActionResponse> {
    let requestedCents: number | null = null;
    if (dto.finalAmount !== undefined && dto.finalAmount !== null) {
      requestedCents = toCents(dto.finalAmount);
      if (requestedCents === null || requestedCents > MAX_AMOUNT_CENTS) {
        throw new BadRequestException('验收金额要在 0 到 1000 万元之间，最多两位小数');
      }
    }
    const adjustInput = optionalText(dto.adjustReason, MAX_REASON, `调整原因最多 ${MAX_REASON} 个字`);
    const note = optionalText(dto.note, MAX_REASON, `验收意见最多 ${MAX_REASON} 个字`);
    const amounts = (row: DevRequestRow): { quoteCents: number; finalCents: number } => {
      const quoteCents = toCents(numericToNumber(row.quoteAmount)) ?? 0;
      return { quoteCents, finalCents: requestedCents ?? quoteCents };
    };
    const adjustReasonOf = (row: DevRequestRow): string | null => {
      const { quoteCents, finalCents } = amounts(row);
      return finalCents === quoteCents ? null : adjustInput;
    };
    return this.transition(viewer, id, {
      action: 'accept',
      to: 'done',
      check: (row: DevRequestRow) => {
        const { quoteCents, finalCents } = amounts(row);
        if (finalCents !== quoteCents && (adjustInput === null || adjustInput.length < 2)) {
          throw new BadRequestException(
            `验收金额（¥${yuanText(finalCents / 100)}）和确认的报价（¥${yuanText(quoteCents / 100)}）不一样，要写调整原因`,
          );
        }
      },
      patch: (row: DevRequestRow, now: Date) => ({
        acceptedAt: now,
        acceptedBy: viewer.userId,
        finalAmount: centsToNumeric(amounts(row).finalCents),
        adjustReason: adjustReasonOf(row),
      }),
      description: (html: string | null, row: DevRequestRow) =>
        upsertManagedLines(html, {
          验收金额: `¥${yuanText(amounts(row).finalCents / 100)}（只记账）`,
        }),
      note,
      detail: (row: DevRequestRow) => ({
        quoteAmount: amounts(row).quoteCents / 100,
        finalAmount: amounts(row).finalCents / 100,
        adjustReason: adjustReasonOf(row),
      }),
      ledger: (row: DevRequestRow, actorName: string, now: Date): LedgerInsert => ({
        devRequestId: row.id,
        planeProjectId: row.planeProjectId,
        projectName: row.projectName,
        planeIssueId: row.planeIssueId,
        planeSequenceId: row.planeSequenceId,
        title: row.title,
        publisherId: row.publisherId,
        publisherName: row.publisherName,
        developerId: row.developerId,
        developerName: row.developerName,
        quoteHours: row.quoteHours ?? '0',
        quoteAmount: centsToNumeric(amounts(row).quoteCents),
        finalAmount: centsToNumeric(amounts(row).finalCents),
        adjustReason: adjustReasonOf(row),
        acceptedBy: viewer.userId,
        acceptedByName: actorName.slice(0, 100),
        acceptedAt: now,
      }),
      comment: (actor: string, row: DevRequestRow) => {
        const { quoteCents, finalCents } = amounts(row);
        const adjusted =
          finalCents === quoteCents
            ? ''
            : `（报价 ¥${yuanText(quoteCents / 100)}，调整原因：${adjustReasonOf(row)}）`;
        return `【开发需求·验收通过】${actor} 验收通过，记账 ¥${yuanText(finalCents / 100)}${adjusted}，只记账不进钱包${
          note ? `。意见：${note}` : ''
        }`;
      },
      notify: (row: DevRequestRow, actor: string) => {
        const final = `¥${yuanText(amounts(row).finalCents / 100)}`;
        return [
          {
            userIds: [row.developerId],
            title: '开发需求验收通过',
            body: `《${row.title}》${actor} 验收通过，记账 ${final}（只记账，不进钱包）。`,
          },
          ...this.bossActedNotice(viewer, row, actor, `验收通过，记账 ${final}`),
        ];
      },
      message: (row: DevRequestRow) =>
        `验收通过，已记账 ¥${yuanText(amounts(row).finalCents / 100)}（只记账，不进钱包）`,
    });
  }

  async rejectDelivery(
    viewer: DevRequestViewer,
    id: string,
    rawReason: unknown,
  ): Promise<DevRequestActionResponse> {
    const reason = requireReason(rawReason, '打回原因');
    return this.transition(viewer, id, {
      action: 'reject_delivery',
      to: 'developing',
      // 被打回的交付作废（历史在事件里），开发者改好重新交付
      patch: () => ({ deliveryNote: null, deliveryLinks: [], deliveredAt: null }),
      note: reason,
      comment: (actor: string) => `【开发需求·验收打回】${actor}：${reason}`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.developerId],
          title: '开发需求验收被打回',
          body: `《${row.title}》${actor} 打回：${reason}。改好后重新交付。`,
        },
        ...this.bossActedNotice(viewer, row, actor, `打回了交付：${reason}`),
      ],
      message: () => '已打回，等开发者改好重新交付',
    });
  }

  async cancel(
    viewer: DevRequestViewer,
    id: string,
    rawReason: unknown,
  ): Promise<DevRequestActionResponse> {
    const reason = requireReason(rawReason, '撤销原因');
    return this.transition(viewer, id, {
      action: 'cancel',
      to: 'cancelled',
      patch: (_row: DevRequestRow, now: Date) => ({
        cancelledAt: now,
        cancelledBy: viewer.userId,
        cancelReason: reason,
      }),
      note: reason,
      comment: (actor: string) => `【开发需求·撤销】${actor}：${reason}`,
      notify: (row: DevRequestRow, actor: string) => [
        {
          userIds: [row.developerId],
          title: '开发需求已撤销',
          body: `《${row.title}》${actor} 撤销了：${reason}`,
        },
        ...this.bossActedNotice(viewer, row, actor, `撤销了：${reason}`),
      ],
      message: () => '已撤销',
    });
  }

  // ==================== 任务卡通用入口碰到开发需求（TasksService 调） ====================

  /**
   * POST /api/tasks/:id/status：只放行「解除阻塞」（阻塞状态 → 开发交付，报价得确认过）；
   * 其余（开始、完成、取消、待验收……）一律 400，引导去开发需求页
   */
  async handleGenericStatus(
    row: DevRequestRow,
    status: TaskStatus,
    actor: GenericTaskActor,
  ): Promise<TaskActionResult> {
    if (status === 'DONE') {
      throw new BadRequestException(
        '这是开发需求：要发布人在「开发需求」页验收才算完成（验收会记账），不能直接改成完成',
      );
    }
    if (status === 'CANCELLED') {
      throw new BadRequestException(
        '这是开发需求：撤销要发布人或老板在「开发需求」页写原因，不能直接取消',
      );
    }
    const { stage, stateName } = await this.currentStage(row);
    if (status !== 'IN_PROGRESS' || stage !== 'blocked') {
      if (status === 'IN_PROGRESS' && (stage === 'submitted' || stage === 'quoted' || stage === 'clarifying')) {
        throw new BadRequestException(
          '这是开发需求：报价要发布人在「开发需求」页确认后才能开工',
        );
      }
      throw new BadRequestException(
        `这是开发需求（现在在「${stateName ?? stageText(stage)}」），任务卡上的按钮不能用；${PAGE_HINT}`,
      );
    }
    const result = await this.transitionRow(
      { userId: actor.userId, isBoss: actor.fullAccess, canSeeAll: actor.fullAccess },
      row,
      {
        action: 'unblock',
        to: 'developing',
        comment: (name: string) => `【开发需求·解除阻塞】${name} 解除阻塞，继续开发`,
        notify: () => [],
        message: () => '已解除阻塞，回到「开发交付」继续开发',
      },
    );
    return { ok: true, stateChanged: true, message: result.message };
  }

  /** POST /api/tasks/:id/evidence：开发交付中 = 交付（同样的闸：只有开发者、报价确认过）；别的环节 400 */
  async handleGenericEvidence(
    row: DevRequestRow,
    dto: { notes: string; links?: string[]; materials?: string[] },
    actor: GenericTaskActor,
  ): Promise<TaskActionResult> {
    const { stage, stateName } = await this.currentStage(row);
    if (stage !== 'developing') {
      throw new BadRequestException(
        `这是开发需求（现在在「${stateName ?? stageText(stage)}」），现在不能交付；${PAGE_HINT}`,
      );
    }
    const materials =
      dto.materials && dto.materials.length > 0
        ? `（已提交材料：${dto.materials.join('；')}）`
        : '';
    const result = await this.transitionRow(
      { userId: actor.userId, isBoss: false, canSeeAll: actor.fullAccess },
      row,
      this.deliverSpec(`${dto.notes ?? ''}${materials}`, dto.links),
    );
    return { ok: true, stateChanged: true, message: result.message };
  }

  /** POST /api/tasks/:id/block：只在开发交付中能报阻塞（原有语义：评论 + 挪到阻塞状态 + SOP / 顺延 / 问题工单） */
  async assertGenericBlockAllowed(row: DevRequestRow): Promise<void> {
    if (row.acceptedAt || row.cancelledAt) {
      throw new BadRequestException('这是开发需求，已经验收或撤销了，不能再报阻塞');
    }
    const { stage, stateName } = await this.currentStage(row);
    if (stage !== 'developing') {
      throw new BadRequestException(
        `这是开发需求（现在在「${stateName ?? stageText(stage)}」），只有开发中才能报阻塞；${PAGE_HINT}`,
      );
    }
    if (!row.quoteConfirmedAt) {
      throw new BadRequestException('这是开发需求，报价还没确认，不能报阻塞');
    }
  }

  /** 通用入口报完阻塞后记一笔事件（失败只记日志） */
  async recordGenericBlock(
    row: DevRequestRow,
    actor: GenericTaskActor,
    reason: string,
    stateChanged: boolean,
  ): Promise<void> {
    try {
      const actorName = await this.nameOf(actor.userId, row);
      await this.db.transaction(async (tx) => {
        await tx.insert(devRequestEvents).values({
          devRequestId: row.id,
          action: 'block',
          fromStage: 'developing',
          toStage: stateChanged ? 'blocked' : null,
          actorId: actor.userId,
          actorName: actorName.slice(0, 100),
          actorRole: this.actorRole(actor.userId, actor.fullAccess, row),
          note: reason,
          detail: null,
        });
        if (stateChanged) {
          await tx
            .update(devRequests)
            .set({ expectedStage: 'blocked', updatedAt: new Date() })
            .where(eq(devRequests.id, row.id));
        }
      });
    } catch (error) {
      this.logger.warn(
        `开发需求阻塞事件记录失败（${row.id}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ==================== 内部 ====================

  private async loadVisible(viewer: DevRequestViewer, id: string): Promise<DevRequestRow> {
    if (!PLANE_ID_RE.test(id)) throw new NotFoundException(DEV_REQUEST_NOT_FOUND);
    const row = await this.lookup.findById(id);
    if (!row || !canSeeDevRequest(viewer, row)) {
      throw new NotFoundException(DEV_REQUEST_NOT_FOUND);
    }
    return row;
  }

  private async currentStage(
    row: DevRequestRow,
  ): Promise<{ stage: DevRequestStage; stateName: string | null; issue: PlaneIssueRaw | null; states: PlaneStateRaw[] }> {
    const [issue, states] = await Promise.all([
      this.planeApi.getIssueFresh(row.planeProjectId, row.planeIssueId),
      this.planeApi.loadStates(row.planeProjectId),
    ]);
    if (!issue) return { stage: 'missing', stateName: null, issue, states };
    const state = states.find((s: PlaneStateRaw) => s.id === issue.state);
    return {
      stage: state ? stageOfState(state) : 'other',
      stateName: state?.name ?? null,
      issue,
      states,
    };
  }

  private async transition(
    viewer: DevRequestViewer,
    id: string,
    spec: TransitionSpec,
  ): Promise<DevRequestActionResponse> {
    const row = await this.loadVisible(viewer, id);
    return this.transitionRow(viewer, row, spec);
  }

  private async transitionRow(
    viewer: DevRequestViewer,
    row: DevRequestRow,
    spec: TransitionSpec,
  ): Promise<DevRequestActionResponse> {
    if (!rolePermits(spec.action, { userId: viewer.userId, isBoss: viewer.isBoss }, row)) {
      throw new ForbiddenException(FORBIDDEN_TEXT[spec.action]);
    }
    const actorName = await this.nameOf(viewer.userId, row);
    const now = new Date();
    const locked: DevRequestRow = await this.db.transaction(async (tx) => {
      // 锁住这一行：并发、连点时后到的等前一个提交，读到的是改完的状态，Plane 也是改完的
      const lockedRow = (
        await tx
          .select()
          .from(devRequests)
          .where(eq(devRequests.id, row.id))
          .limit(1)
          .for('update')
      )[0];
      if (!lockedRow) throw new NotFoundException(DEV_REQUEST_NOT_FOUND);
      const { stage, stateName, issue, states } = await this.currentStage(lockedRow);
      // 标题以 Plane 为准（有人在 Plane 里改过就跟着改），台账、消息里用最新的
      const current: DevRequestRow = {
        ...lockedRow,
        title: (issue?.name || lockedRow.title).slice(0, 255),
      };
      if (!stagePermits(spec.action, stage)) {
        throw new BadRequestException(
          stage === 'missing'
            ? 'Plane 里找不到这条任务（可能被删除或归档了），流程没法继续'
            : `现在在「${stateName ?? stageText(stage)}」，不能${ACTION_TEXT[spec.action]}（状态可能刚被改过，请刷新）`,
        );
      }
      const precondition = preconditionError(spec.action, current);
      if (precondition) throw new BadRequestException(precondition);
      spec.check?.(current);
      const target =
        spec.to === 'done'
          ? findGroupState(states, 'completed')
          : spec.to === 'cancelled'
            ? findGroupState(states, 'cancelled')
            : findFlowState(states, spec.to);
      if (!target) {
        throw new BadRequestException(
          `项目「${current.projectName}」没有「${stageText(spec.to)}」状态，没法流转；请先在 Plane 里补上`,
        );
      }
      await tx
        .update(devRequests)
        .set({
          ...(spec.patch ? spec.patch(current, now) : {}),
          title: current.title,
          expectedStage: spec.to,
          updatedAt: now,
        })
        .where(eq(devRequests.id, current.id));
      await tx.insert(devRequestEvents).values({
        devRequestId: current.id,
        action: spec.action,
        fromStage: stage,
        toStage: spec.to,
        actorId: viewer.userId,
        actorName: actorName.slice(0, 100),
        actorRole: this.actorRole(viewer.userId, viewer.isBoss, current),
        note: spec.note ?? null,
        detail: spec.detail ? spec.detail(current) : null,
        createdAt: now,
      });
      if (spec.ledger) {
        await tx.insert(devRequestLedger).values(spec.ledger(current, actorName, now));
      }
      const payload: Record<string, unknown> = { state: target.id };
      const description = spec.description
        ? spec.description(issue?.description_html ?? null, current)
        : null;
      if (description !== null) payload.description_html = description;
      // 最后改 Plane：改失败整个事务回滚，库和 Plane 不会一边改了一边没改
      await this.planeApi.patchIssue(current.planeProjectId, current.planeIssueId, payload);
      return current;
    });

    void this.comment(
      locked.planeProjectId,
      locked.planeIssueId,
      spec.comment(actorName, locked),
    );
    void this.sendNotifications(locked.id, viewer.userId, spec.notify(locked, actorName, viewer));
    return { ok: true, message: spec.message(locked), id: locked.id, stage: spec.to };
  }

  /** 老板替发布人做了确认 / 验收 / 撤销，告诉发布人一声 */
  private bossActedNotice(
    viewer: DevRequestViewer,
    row: DevRequestRow,
    actor: string,
    what: string,
  ): NotifySpec[] {
    if (viewer.userId === row.publisherId) return [];
    return [
      {
        userIds: [row.publisherId],
        title: '老板处理了你发的开发需求',
        body: `《${row.title}》${actor} ${what}。`,
      },
    ];
  }

  private actorRole(
    userId: string,
    isBoss: boolean,
    row: Pick<DevRequestRow, 'publisherId' | 'developerId'>,
  ): string {
    if (userId === row.publisherId) return 'publisher';
    if (userId === row.developerId) return 'developer';
    return isBoss ? 'boss' : 'other';
  }

  private async nameOf(
    userId: string,
    row?: Pick<DevRequestRow, 'publisherId' | 'publisherName' | 'developerId' | 'developerName'>,
  ): Promise<string> {
    const [name] = await this.namesOf([userId], row
      ? { [row.publisherId]: row.publisherName, [row.developerId]: row.developerName }
      : {});
    return name;
  }

  /** 查姓名（账户资料 > 统一登录显示名 > Plane 成员名），查不到用快照，再不行用 ID */
  private async namesOf(
    userIds: string[],
    fallback: Record<string, string | null | undefined>,
  ): Promise<string[]> {
    const users = await this.directory.listUsersByIds(userIds).catch(() => userIds.map(() => null));
    return userIds.map(
      (userId: string, index: number) =>
        users[index]?.name.zh_cn || fallback[userId] || userId,
    );
  }

  private async comment(projectId: string, issueId: string, text: string): Promise<void> {
    try {
      const html = text
        .split('\n')
        .map((line: string) => escapeHtml(line))
        .join('<br/>');
      await this.planeApi.postComment(projectId, issueId, `<p>${html}</p>`);
    } catch (error) {
      this.logger.warn(
        `开发需求 Plane 评论失败（任务 ${issueId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 站内消息给下一步该动手的人；不发给动手的人自己 */
  private async sendNotifications(
    id: string,
    actorId: string,
    specs: NotifySpec[],
  ): Promise<void> {
    for (const spec of specs) {
      const targets = spec.userIds.filter((userId: string) => userId && userId !== actorId);
      if (targets.length === 0) continue;
      await this.notifyService.sendToUsers(targets, spec.title, spec.body, {
        category: 'dev_request',
        link: `/dev-requests/${id}`,
      });
    }
  }

  private async discardIssue(projectId: string, issueId: string): Promise<void> {
    try {
      await this.planeApi.deleteIssue(projectId, issueId);
    } catch (error) {
      this.logger.error(
        `删除没派上的开发需求 Plane 任务失败，请到 Plane 手动删（项目 ${projectId} 任务 ${issueId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
