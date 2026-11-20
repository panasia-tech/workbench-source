import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { blockDeferRequests, sops, systemConfigs } from '@server/database/schema';
import type {
  BlockDeferInfo,
  BlockDeferReviewItem,
  BlockDeferStatus,
} from '@shared/api.interface';
import { PlaneService } from '../integration/plane.service';
import { AilyWebhookService } from '../integration/aily-webhook.service';
import { NotifyService } from '../integration/notify.service';
import { isFeatureEnabled } from '../integration/optional-features';
import { SopService } from './sop.service';
import { minutesToHHmm } from './rhythm.util';

const DEFER_CONFIG_KEY = 'block.defer_minutes';
const DEFAULT_DEFER_MINUTES = 30;
const DAY_END_MINUTES = 23 * 60 + 59;
const TITLE_DEADLINE_RE = /(\d{1,2})[:：](\d{2})前/u;
/** AI 初审推出去了却一直没回写（豆包没跑、进程重启等）：超过这个时长转老板终审，别把申请卡死 */
const AI_REVIEW_STALE_MS = 10 * 60_000;
const AI_SKIPPED_NOTE = 'AI 初审没能发起，已直接转老板终审';
const AI_STALE_NOTE = 'AI 初审超过 10 分钟没有结果，已转老板终审';

interface DeferConfig {
  minutes?: unknown;
}

export interface SubmitBlockDeferInput {
  taskId: string;
  projectId: string;
  projectName: string;
  title: string;
  sequenceId: number | null;
  assigneeName: string;
  userId: string;
  reason: string;
  resolution: string;
  category: string;
  originalDeadline: string | null;
}

function addMinutesClamped(hhmm: string, minutes: number): string {
  const [hour, minute] = hhmm.split(':').map((part: string) => Number(part));
  return minutesToHHmm(Math.min(hour * 60 + minute + minutes, DAY_END_MINUTES));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

@Injectable()
export class BlockDeferService {
  private readonly logger = new Logger(BlockDeferService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly webhook: AilyWebhookService,
    private readonly notify: NotifyService,
    private readonly sopService: SopService,
  ) {}

  /** 顺延时长（分钟），管理端可配 block.defer_minutes，默认 30 */
  async getDeferMinutes(): Promise<number> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, DEFER_CONFIG_KEY))
      .limit(1);
    const raw = (rows[0]?.configValue ?? {}) as DeferConfig;
    const minutes =
      typeof raw.minutes === 'number' ? Math.round(raw.minutes) : NaN;
    if (Number.isFinite(minutes) && minutes >= 5 && minutes <= 480) {
      return minutes;
    }
    return DEFAULT_DEFER_MINUTES;
  }

  /**
   * 员工提交堵塞时登记顺延申请。
   * 顺延 AI 初审开着（AILY_BLOCK_DEFER_REVIEW_ENABLED）：登记 pending 并异步推豆包，推送没成功直接转老板终审；
   * 关着（默认）：直接进「待老板终审」（ai_passed，没有 AI 意见）。
   */
  async submitBlockDefer(input: SubmitBlockDeferInput): Promise<BlockDeferInfo> {
    if (!input.originalDeadline) {
      throw new BadRequestException(
        '该任务没有内联截止时刻（标题需含 HH:mm前），无法申请顺延',
      );
    }
    const deferMinutes = await this.getDeferMinutes();
    const requestedDeadline = addMinutesClamped(
      input.originalDeadline,
      deferMinutes,
    );
    const aiReview = isFeatureEnabled('aiBlockDeferReview');
    const inserted = await this.db
      .insert(blockDeferRequests)
      .values({
        taskId: input.taskId,
        projectId: input.projectId,
        projectName: input.projectName,
        title: input.title,
        sequenceId: input.sequenceId,
        assigneeName: input.assigneeName,
        userId: input.userId,
        reason: input.reason,
        resolution: input.resolution,
        category: input.category,
        deferMinutes,
        originalDeadline: input.originalDeadline,
        requestedDeadline,
        status: aiReview ? 'pending' : 'ai_passed',
      })
      .returning();
    const row = inserted[0];
    if (!aiReview) {
      return this.toInfo(row);
    }
    const originalDeadline = input.originalDeadline;
    void this.webhook
      .notifyBlockDeferSubmitted({
        taskId: input.taskId,
        title: input.title,
        assigneeName: input.assigneeName,
        reason: input.reason,
        resolution: input.resolution,
        originalDeadline,
        requestedDeadline,
        deferMinutes,
      })
      .then(async (result: { dispatched: boolean; detail: string }) => {
        if (!result.dispatched) {
          this.logger.warn(
            `堵塞顺延 AI 初审未自动触发（任务 ${input.taskId}）：${result.detail}，转老板终审`,
          );
          await this.skipAiReview(row.id, AI_SKIPPED_NOTE);
        }
      })
      .catch(async (error: unknown) => {
        this.logger.warn(
          `堵塞顺延通知异常（任务 ${input.taskId}），转老板终审：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.skipAiReview(row.id, AI_SKIPPED_NOTE).catch((): void => undefined);
      });
    return this.toInfo(row);
  }

  /** 仍在 pending 的申请跳过 AI 初审，直接进「待老板终审」 */
  private async skipAiReview(id: string, note: string): Promise<void> {
    await this.db
      .update(blockDeferRequests)
      .set({ status: 'ai_passed', aiOpinion: note })
      .where(and(eq(blockDeferRequests.id, id), eq(blockDeferRequests.status, 'pending')));
  }

  /** AI 初审超时自愈：pending 超过 10 分钟没回写的转老板终审（列表与详情读之前调） */
  private async healStalePending(): Promise<void> {
    try {
      await this.db
        .update(blockDeferRequests)
        .set({ status: 'ai_passed', aiOpinion: AI_STALE_NOTE })
        .where(
          and(
            eq(blockDeferRequests.status, 'pending'),
            lt(blockDeferRequests.createdAt, new Date(Date.now() - AI_REVIEW_STALE_MS)),
          ),
        );
    } catch (error) {
      this.logger.warn(
        `顺延申请超时自愈失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 豆包 AI 初审回写：pass → ai_passed（待老板终审）；revise → ai_rejected（终局，通知员工） */
  async aiReview(
    taskId: string,
    verdict: 'pass' | 'revise',
    opinion: string,
  ): Promise<boolean> {
    const latest = await this.db
      .select()
      .from(blockDeferRequests)
      .where(eq(blockDeferRequests.taskId, taskId))
      .orderBy(desc(blockDeferRequests.createdAt))
      .limit(1);
    const row = latest[0];
    if (!row || row.status !== 'pending') return false;
    const updated = await this.db
      .update(blockDeferRequests)
      .set({ status: verdict === 'pass' ? 'ai_passed' : 'ai_rejected', aiOpinion: opinion })
      .where(and(eq(blockDeferRequests.id, row.id), eq(blockDeferRequests.status, 'pending')))
      .returning({ id: blockDeferRequests.id });
    if (updated.length === 0) return false;
    if (verdict === 'revise') {
      void this.notify.sendToUsers(
        [row.userId],
        '顺延申请未通过 AI 初审',
        `你在「${row.title}」的顺延申请被 AI 初审驳回：${opinion}。请按原截止时刻推进，或解决后重新提交。`,
        { category: 'block_defer', link: `/tasks/${row.taskId}?projectId=${row.projectId}` },
      );
    }
    return true;
  }

  /** 老板终审：approve → 改 Plane 标题内联截止（真正顺延）+ 通知；reject → 通知 */
  async bossVerdict(
    id: string,
    action: 'approve' | 'reject',
    comment: string | undefined,
  ): Promise<BlockDeferReviewItem> {
    const rows = await this.db
      .select()
      .from(blockDeferRequests)
      .where(eq(blockDeferRequests.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('顺延申请不存在');
    if (row.status !== 'ai_passed') {
      throw new BadRequestException(
        '该申请当前不可终审（需 AI 初审通过后处于「待老板终审」状态）',
      );
    }
    if (action === 'approve') {
      await this.applyDeferToPlane(row);
      await this.postComment(
        row.projectId,
        row.taskId,
        `<p>【顺延已批准】老板终审通过，截止时刻由 ${row.originalDeadline} 顺延至 ${row.requestedDeadline}（+${row.deferMinutes} 分钟）` +
          `${comment ? `。意见：${escapeHtml(comment)}` : ''}</p>`,
      );
      void this.notify.sendToUsers(
        [row.userId],
        '顺延申请已批准',
        `你在「${row.title}」的顺延申请已由老板批准，截止时刻已顺延至 ${row.requestedDeadline}（+${row.deferMinutes} 分钟）。`,
        { category: 'block_defer', link: `/tasks/${row.taskId}?projectId=${row.projectId}` },
      );
    } else {
      await this.postComment(
        row.projectId,
        row.taskId,
        `<p>【顺延被拒绝】老板终审未通过该顺延申请${comment ? `：${escapeHtml(comment)}` : ''}，请按原截止时刻 ${row.originalDeadline} 推进。</p>`,
      );
      void this.notify.sendToUsers(
        [row.userId],
        '顺延申请被老板拒绝',
        `你在「${row.title}」的顺延申请被老板拒绝${comment ? `：${comment}` : ''}。请按原截止时刻 ${row.originalDeadline} 推进。`,
        { category: 'block_defer', link: `/tasks/${row.taskId}?projectId=${row.projectId}` },
      );
    }
    const updated = await this.db
      .update(blockDeferRequests)
      .set({ status: action === 'approve' ? 'approved' : 'rejected', bossComment: comment ?? null })
      .where(and(eq(blockDeferRequests.id, id), eq(blockDeferRequests.status, 'ai_passed')))
      .returning();
    if (updated.length === 0) {
      throw new BadRequestException('该申请已被处理，请刷新列表');
    }
    void this.sopService
      .syncDeferPolicy(row.deferMinutes)
      .catch((error: unknown) => {
        this.logger.warn(
          `顺延奖惩策略 Wiki 同步失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return this.toReviewItem(updated[0], row.sopId ? (await this.loadSopTitle(row.sopId)) : null);
  }

  private async loadSopTitle(sopId: string): Promise<string | null> {
    const sopRows = await this.db
      .select({ title: sops.title })
      .from(sops)
      .where(eq(sops.id, sopId))
      .limit(1);
    return sopRows[0]?.title ?? null;
  }

  /** 任务完成/取消时出队在途申请（顺延已无意义） */
  async cancelByTask(taskId: string): Promise<void> {
    await this.db
      .update(blockDeferRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(blockDeferRequests.taskId, taskId),
          inArray(blockDeferRequests.status, ['pending', 'ai_passed']),
        ),
      );
  }

  /** 按任务查全部状态申请（MCP block_defer_list 传 taskId 时用） */
  async listByTaskAll(taskId: string): Promise<BlockDeferReviewItem[]> {
    await this.healStalePending();
    const rows = await this.db
      .select()
      .from(blockDeferRequests)
      .where(eq(blockDeferRequests.taskId, taskId))
      .orderBy(desc(blockDeferRequests.createdAt));
    const attached = await this.attachSopTitles(rows);
    return attached.map((row) => this.toReviewItem(row, row.sopTitle));
  }

  async getLatestByTask(taskId: string): Promise<BlockDeferInfo | null> {
    await this.healStalePending();
    const rows = await this.db
      .select()
      .from(blockDeferRequests)
      .where(eq(blockDeferRequests.taskId, taskId))
      .orderBy(desc(blockDeferRequests.createdAt))
      .limit(1);
    return rows[0] ? this.toInfo(rows[0]) : null;
  }

  /** 管理端审核列表：pending（AI 初审中）+ ai_passed（待老板终审） */
  async listForReview(): Promise<BlockDeferReviewItem[]> {
    await this.healStalePending();
    const rows = await this.db
      .select()
      .from(blockDeferRequests)
      .where(inArray(blockDeferRequests.status, ['pending', 'ai_passed']))
      .orderBy(desc(blockDeferRequests.createdAt));
    const attached = await this.attachSopTitles(rows);
    return attached.map((row) => this.toReviewItem(row, row.sopTitle));
  }

  /** 员工维度申请历史（管理端员工详情用） */
  async listByUser(userId: string, limit = 20): Promise<BlockDeferReviewItem[]> {
    await this.healStalePending();
    const rows = await this.db
      .select()
      .from(blockDeferRequests)
      .where(eq(blockDeferRequests.userId, userId))
      .orderBy(desc(blockDeferRequests.createdAt))
      .limit(limit);
    const attached = await this.attachSopTitles(rows);
    return attached.map((row) => this.toReviewItem(row, row.sopTitle));
  }

  private async applyDeferToPlane(
    row: typeof blockDeferRequests.$inferSelect,
  ): Promise<void> {
    const issue = await this.plane.getOptional<{ name: string }>(
      `${this.plane.workspacePath}/projects/${row.projectId}/issues/${row.taskId}/`,
    );
    if (!issue) {
      this.logger.warn(`顺延生效失败：任务 ${row.taskId} 已不存在`);
      return;
    }
    const newTitle = issue.name.replace(
      TITLE_DEADLINE_RE,
      `${row.requestedDeadline}前`,
    );
    if (newTitle === issue.name) {
      this.logger.warn(
        `顺延生效失败：任务 ${row.taskId} 标题缺少内联截止「HH:mm前」`,
      );
      return;
    }
    await this.plane.patch(
      `${this.plane.workspacePath}/projects/${row.projectId}/issues/${row.taskId}/`,
      { name: newTitle },
    );
  }

  private async postComment(
    projectId: string,
    taskId: string,
    commentHtml: string,
  ): Promise<void> {
    await this.plane.post(
      `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/comments/`,
      { comment_html: commentHtml },
    );
  }

  private async attachSopTitles(
    rows: (typeof blockDeferRequests.$inferSelect)[],
  ): Promise<(typeof blockDeferRequests.$inferSelect & { sopTitle: string | null })[]> {
    const sopIds = rows
      .map((row) => row.sopId)
      .filter((id: string | null): id is string => id !== null);
    if (sopIds.length === 0) {
      return rows.map((row) => ({ ...row, sopTitle: null }));
    }
    const sopRows = await this.db
      .select({ id: sops.id, title: sops.title })
      .from(sops)
      .where(inArray(sops.id, sopIds));
    const titleById = new Map(
      sopRows.map((r: { id: string; title: string }) => [r.id, r.title]),
    );
    return rows.map((row) => ({
      ...row,
      sopTitle: row.sopId ? (titleById.get(row.sopId) ?? null) : null,
    }));
  }

  private toInfo(row: typeof blockDeferRequests.$inferSelect): BlockDeferInfo {
    return {
      status: row.status as BlockDeferStatus,
      deferMinutes: row.deferMinutes,
      originalDeadline: row.originalDeadline,
      requestedDeadline: row.requestedDeadline,
      reason: row.reason,
      resolution: row.resolution,
      aiOpinion: row.aiOpinion,
      bossComment: row.bossComment,
      requestedAt: row.createdAt.toISOString(),
    };
  }

  private toReviewItem(
    row: typeof blockDeferRequests.$inferSelect,
    sopTitle: string | null,
  ): BlockDeferReviewItem {
    return {
      id: row.id,
      taskId: row.taskId,
      title: row.title,
      sequenceId: row.sequenceId,
      projectName: row.projectName,
      assigneeName: row.assigneeName,
      userId: row.userId,
      reason: row.reason,
      resolution: row.resolution,
      category: row.category,
      deferMinutes: row.deferMinutes,
      originalDeadline: row.originalDeadline,
      requestedDeadline: row.requestedDeadline,
      status: row.status as BlockDeferStatus,
      aiOpinion: row.aiOpinion,
      sopId: row.sopId,
      sopTitle,
      requestedAt: row.createdAt.toISOString(),
    };
  }
}
