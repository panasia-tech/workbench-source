import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { blockDeferRequests, sops, systemConfigs } from '@server/database/schema';
import type { SopRecord } from '@shared/api.interface';
import { AilyOpenApiService } from '../integration/aily-openapi.service';
import { FeishuWikiService } from '../integration/feishu-wiki.service';
import { isFeatureEnabled } from '../integration/optional-features';

const DRAFT_CONFIG_KEY = 'quick_task.draft_agent_id';
const POLL_TOTAL_LIMIT_MS = 45_000;
const POLL_FIRST_DELAY_MS = 2_000;
const POLL_MAX_DELAY_MS = 5_000;
const PENDING_STALE_MS = 5 * 60 * 1000;

const CATEGORY_LABELS: Record<string, string> = {
  tool: '工具类',
  system: '系统类',
  permission: '权限类',
  process: '流程类',
  external_supplier: '外部供应商',
  logistics: '物流类',
  customer: '客户类',
  resource: '资源类',
  knowledge: '知识类',
  coordination: '协同类',
  quality: '质量类',
  policy: '制度类',
  finance: '财务类',
  data: '数据类',
  other: '综合类',
};

interface AgentIdConfig {
  agent_id?: unknown;
}

export interface SopGenerateInput {
  taskId: string;
  taskTitle: string;
  sequenceId: number | null;
  category: string;
  reason: string;
  resolution: string;
  authorName: string;
}

@Injectable()
export class SopService {
  private readonly logger = new Logger(SopService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly aily: AilyOpenApiService,
    private readonly wiki: FeishuWikiService,
  ) {}

  /**
   * 堵塞提交后生成 SOP：先落 pending 行（快），后台再走 AI 生成 + Wiki 同步。
   * 调用方用 void 调用即可，不阻塞提交流程。
   * AI 生成 SOP 是可选集成（AILY_SOP_ENABLED，默认开）：关着或没配智能体 ID 都不落行、不调豆包，返回 null。
   */
  async generateForBlock(input: SopGenerateInput): Promise<string | null> {
    if (!isFeatureEnabled('aiSop')) return null;
    // 开关默认开：没配智能体 ID 就不落一行注定失败的 pending，免得没接豆包时每次堵塞都留一条失败 SOP
    if (!(await this.resolveAgentId())) return null;
    const categoryLabel = CATEGORY_LABELS[input.category] ?? '综合类';
    const shortTitle =
      input.taskTitle.length > 40
        ? `${input.taskTitle.slice(0, 40)}…`
        : input.taskTitle;
    const inserted = await this.db
      .insert(sops)
      .values({
        title: `${categoryLabel}堵塞处置 SOP：${shortTitle}`,
        content: '',
        category: input.category,
        sourceTaskId: input.taskId,
        sourceTitle: input.taskTitle,
        authorName: input.authorName,
        status: 'pending',
      })
      .returning({ id: sops.id });
    const sopId = inserted[0]?.id ?? null;
    if (sopId === null) return null;
    void this.runGeneration(sopId, input, categoryLabel);
    return sopId;
  }

  async listSops(options?: {
    authorName?: string;
    category?: string;
    limit?: number;
  }): Promise<SopRecord[]> {
    await this.failStalePending();
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const conditions = [];
    if (options?.authorName) {
      conditions.push(eq(sops.authorName, options.authorName));
    }
    if (options?.category) {
      conditions.push(eq(sops.category, options.category));
    }
    const rows = await (conditions.length > 0
      ? this.db
          .select()
          .from(sops)
          .where(and(...conditions))
          .orderBy(desc(sops.createdAt))
          .limit(limit)
      : this.db
          .select()
          .from(sops)
          .orderBy(desc(sops.createdAt))
          .limit(limit));
    return rows.map((row: typeof sops.$inferSelect): SopRecord => ({
      id: row.id,
      title: row.title,
      category: row.category,
      status: row.status,
      wikiUrl: row.wikiUrl,
      syncError: row.syncError,
      sourceTaskId: row.sourceTaskId,
      sourceTitle: row.sourceTitle,
      authorName: row.authorName,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * 顺延奖惩策略同步：把顺延制度的奖惩口径沉淀为制度类 SOP（存工作台库），
   * 开了 FEISHU_WIKI_SYNC_ENABLED 时再同步飞书 Wiki。
   * 幂等：已有同名已完成行则跳过；老板终审后 fire-and-forget 调用。
   */
  async syncDeferPolicy(deferMinutes: number): Promise<void> {
    const title = '堵塞顺延与奖惩策略';
    const existing = await this.db
      .select({ id: sops.id, status: sops.status })
      .from(sops)
      .where(eq(sops.title, title))
      .limit(1);
    if (existing[0] && existing[0].status === 'done') return;
    const content = [
      `# ${title}`,
      '## 适用场景',
      '员工在执行今日任务时遇到堵塞（Blocked ≠ 截断，任务仍在执行中），预计短时间内可解决，需要顺延任务结束时刻时适用本策略。',
      '## 顺延规则',
      `- 默认可申请顺延时长：${deferMinutes} 分钟（管理端系统配置 block.defer_minutes 可调，范围 5-480 分钟）。`,
      '- 仅限标题含内联截止时刻（HH:mm前）的任务可申请顺延；无截止时刻的任务不适用。',
      '- 审核：老板终审（终杀权）；开了 AI 初审时先过豆包 AI 初审（判断堵塞原因与解决方案的合理性）。审核通过后，任务截止时刻由系统自动改写。',
      '## 奖惩口径',
      '- 顺延获批：截止时刻顺延后，任务在顺延后的截止时刻前完成，不计逾期、不扣绩效。',
      '- 顺延被拒（AI 驳回或老板拒绝）：按原截止时刻执行；超截止未完结按既有逾期规则处理（逾期完成绩效补偿口径见《员工绩效 Rating 标准》）。',
      '- 滥用顺延（频繁以堵塞为由顺延）：计入 KRA「阻塞升级次数」，影响月度绩效评估。',
      '- 堵塞后主动沉淀解决情况和方案，作为流程改进的正向贡献（开了 AI 生成 SOP 时自动整理成 SOP）。',
      '## 流程说明',
      '1. 员工在任务详情页提交堵塞（必填：原因 / 等待谁 / 下一步 / 解决情况和方案），勾选「同步申请顺延」。',
      `2. 系统按当前配置生成顺延申请（原截止 → +${deferMinutes} 分钟），登记待审。`,
      '3. 开了 AI 初审时先过豆包 AI 初审：通过则转「待老板终审」，驳回则退回员工按原截止推进；没开则直接进「待老板终审」。',
      '4. 老板在验收 Dock「顺延审核」终审：批准即改写任务标题内联截止时刻；拒绝则维持原截止。',
      '5. 全程结果写入任务时间线（Plane 评论）并通知员工。',
    ].join('\n');
    let sopId = existing[0]?.id ?? null;
    if (sopId === null) {
      const inserted = await this.db
        .insert(sops)
        .values({
          title,
          content,
          category: 'policy',
          status: 'done',
        })
        .returning({ id: sops.id });
      sopId = inserted[0]?.id ?? null;
    } else {
      await this.db
        .update(sops)
        .set({ content, status: 'done', syncError: null })
        .where(eq(sops.id, sopId));
    }
    if (sopId === null) return;
    const sync = await this.wiki.syncSop(title, content);
    await this.db
      .update(sops)
      .set({ wikiUrl: sync.wikiUrl || null, syncError: sync.error })
      .where(eq(sops.id, sopId));
    if (sync.error) {
      this.logger.warn(`顺延奖惩策略 Wiki 同步失败：${sync.error}`);
    }
  }

  async attachSopTitle<T extends { sopId: string | null }>(
    rows: T[],
  ): Promise<(T & { sopTitle: string | null })[]> {
    const sopIds = rows
      .map((row: T) => row.sopId)
      .filter((id: string | null): id is string => id !== null);
    if (sopIds.length === 0) {
      return rows.map((row: T) => ({ ...row, sopTitle: null }));
    }
    const sopRows = await this.db
      .select({ id: sops.id, title: sops.title })
      .from(sops)
      .where(inArray(sops.id, sopIds));
    const titleById = new Map(sopRows.map((r: { id: string; title: string }) => [r.id, r.title]));
    return rows.map((row: T) => ({
      ...row,
      sopTitle: row.sopId ? (titleById.get(row.sopId) ?? null) : null,
    }));
  }

  /** 进程重启丢任务的自愈：pending 超 5 分钟视为生成失败 */
  private async failStalePending(): Promise<void> {
    const staleBefore = new Date(Date.now() - PENDING_STALE_MS);
    await this.db
      .update(sops)
      .set({ status: 'failed', syncError: '生成超时（可能进程重启），可重新提交堵塞生成' })
      .where(and(eq(sops.status, 'pending'), lt(sops.createdAt, staleBefore)));
  }

  private async runGeneration(
    sopId: string,
    input: SopGenerateInput,
    categoryLabel: string,
  ): Promise<void> {
    try {
      const agentId = await this.resolveAgentId();
      if (!agentId) {
        await this.markFailed(sopId, '未配置 AI 草稿智能体 ID（quick_task.draft_agent_id），无法自动生成 SOP');
        return;
      }
      const sessionId = await this.aily.createSession(agentId);
      const chatId = await this.aily.createRun(
        agentId,
        sessionId,
        this.buildPrompt(input, categoryLabel),
      );
      const chat = await this.pollUntilSettled(agentId, chatId);
      const status = typeof chat.status === 'string' ? chat.status : '';
      if (status !== 'Completed') {
        await this.markFailed(
          sopId,
          status === 'Failed' ? '豆包智能体生成 SOP 失败' : 'SOP 生成超时（45 秒）',
        );
        return;
      }
      const reply = this.aily.extractChatReply(chat);
      if (!reply || reply.trim().length < 20) {
        await this.markFailed(sopId, 'AI 未返回有效 SOP 内容');
        return;
      }
      const content = reply.trim();
      await this.db
        .update(blockDeferRequests)
        .set({ sopId })
        .where(
          and(
            eq(blockDeferRequests.taskId, input.taskId),
            isNull(blockDeferRequests.sopId),
          ),
        );
      const updated = await this.db
        .update(sops)
        .set({ content, status: 'done', syncError: null })
        .where(eq(sops.id, sopId))
        .returning({ title: sops.title });
      if (updated.length === 0) return;
      const sync = await this.wiki.syncSop(updated[0].title, content);
      await this.db
        .update(sops)
        .set({
          wikiUrl: sync.wikiUrl || null,
          syncError: sync.error,
        })
        .where(eq(sops.id, sopId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`SOP 生成异常（${sopId}）：${message}`);
      await this.markFailed(sopId, message).catch((): void => undefined);
    }
  }

  private async markFailed(sopId: string, reason: string): Promise<void> {
    await this.db
      .update(sops)
      .set({ status: 'failed', syncError: reason })
      .where(eq(sops.id, sopId));
  }

  private async resolveAgentId(): Promise<string> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, DRAFT_CONFIG_KEY))
      .limit(1);
    const raw = (rows[0]?.configValue ?? {}) as AgentIdConfig;
    return typeof raw.agent_id === 'string' ? raw.agent_id.trim() : '';
  }

  private buildPrompt(input: SopGenerateInput, categoryLabel: string): string {
    return [
      '你是流程管理专家。根据员工提交的堵塞报告与解决情况，沉淀一份标准处置 SOP（标准作业程序），供全公司遇到同类堵塞时参照执行。',
      '只输出 SOP 的 markdown 正文（不要代码块包裹、不要前后缀说明），结构固定为：',
      '# SOP 标题（10-20 字，概括堵塞处置要点）',
      '## 适用场景（2-3 句，说明什么情况适用本 SOP）',
      '## 处置步骤（有序列表，每步具体到操作入口/联系人/要准备的材料，5 步左右）',
      '## 预防措施（无序列表，3 条左右）',
      '堵塞分类：' + categoryLabel,
      `任务标题：${input.taskTitle}`,
      `堵塞原因：${input.reason}`,
      `解决情况和方案：${input.resolution}`,
    ].join('\n');
  }

  private async pollUntilSettled(
    agentId: string,
    chatId: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + POLL_TOTAL_LIMIT_MS;
    let delay = POLL_FIRST_DELAY_MS;
    let chat: Record<string, unknown> = {};
    while (Date.now() + delay < deadline) {
      await new Promise((resolve: (value: void) => void) => {
        setTimeout(resolve, delay);
      });
      delay = Math.min(delay + 1_000, POLL_MAX_DELAY_MS);
      chat = await this.aily.getChat(agentId, chatId);
      const status = typeof chat.status === 'string' ? chat.status : '';
      if (status === 'Completed' || status === 'Failed') {
        return chat;
      }
    }
    return chat;
  }
}
