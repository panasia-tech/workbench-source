import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { systemConfigs } from '@server/database/schema';
import { CredentialsService } from './credentials.service';
import {
  featureOffNote,
  isFeatureEnabled,
  type OptionalFeature,
} from './optional-features';

const TASK_REVIEW_WEBHOOK_KEY = 'task_review.webhook_url';

export interface WebhookDispatchResult {
  dispatched: boolean;
  detail: string;
  /** 对应开关没打开，压根没推（调用方别当失败告警） */
  disabled?: boolean;
}

/** 开关没开时的统一返回：不读配置、不发请求 */
function disabledResult(feature: OptionalFeature): WebhookDispatchResult | null {
  return isFeatureEnabled(feature)
    ? null
    : { dispatched: false, detail: `豆包推送${featureOffNote(feature)}`, disabled: true };
}

/**
 * 豆包工作伙伴 Webhook：工作台主动推事件给豆包（委派材料审核、顺延初审、配置任务）。
 * 每类事件各有开关（optional-features.ts），默认全开；关着直接返回 disabled，不发任何请求。
 */
@Injectable()
export class AilyWebhookService {
  private readonly logger = new Logger(AilyWebhookService.name);

  constructor(
    private readonly http: HttpService,
    private readonly credentials: CredentialsService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /**
   * 员工提交委派任务材料后触发豆包工作伙伴自动审核（AILY_TASK_REVIEW_ENABLED）。
   * 不抛错：未启用/未配置/触发失败只记日志，不阻断材料提交流程。
   */
  async notifyTaskEvidenceSubmitted(
    taskId: string,
    title: string,
    assigneeName: string,
  ): Promise<WebhookDispatchResult> {
    const off = disabledResult('aiTaskReview');
    if (off) return off;
    const text = [
      `【委派材料待审核】员工 ${assigneeName} 提交了「${title}」的验收材料。`,
      '请立即执行 AI 初审：',
      `1. 调用工具 task_review_list（传 taskId=${taskId}）拉取该任务的待审材料与凭证链接；`,
      '2. 按 task-review 技能的审核规则判断凭证是否合格（图片是否清晰、是否与任务要求相符）；',
      '3. 合格：调用 task_review_write 回写结论 pass（等待老板终审）；不合格：回写结论 revise 并说明打回原因。',
    ].join('\n');
    return this.dispatchWebhook('task.evidence.submitted', text, {
      taskId,
      title,
      assignee_name: assigneeName,
    });
  }

  /**
   * 下发配置任务后主动通知豆包智能体，替代人工传话（AILY_AGENT_TASK_PUSH_ENABLED）。
   * 不抛错：未启用/推送失败只记日志，任务仍会在智能体下次拉取 agent_task_list 时被发现。
   */
  async notifyAgentTaskCreated(
    taskId: string,
    title: string,
  ): Promise<WebhookDispatchResult> {
    const off = disabledResult('aiAgentTaskPush');
    if (off) return off;
    const text = [
      `【新配置任务】妙搭工作台刚下发了新任务「${title}」。`,
      '请立即：',
      '1. 调用工具 agent_task_list 拉取待办任务列表；',
      `2. 找到「${title}」这条，按其 instruction 引导操作者逐步完成（后台需要点击的部分给出精确入口与按钮路径）；`,
      '3. 真正完成后调用 agent_task_complete 标记并写备注；做不完就如实说明卡在哪一步，不要假完成。',
    ].join('\n');
    return this.dispatchWebhook('agent.task.created', text, { taskId, title });
  }

  /**
   * 员工提交堵塞并申请顺延截止时刻后，触发豆包 AI 初审（AILY_BLOCK_DEFER_REVIEW_ENABLED）。
   * 不抛错：未配置/触发失败只记日志，不阻断堵塞提交流程（调用方据此转老板终审）。
   */
  async notifyBlockDeferSubmitted(input: {
    taskId: string;
    title: string;
    assigneeName: string;
    reason: string;
    resolution: string;
    originalDeadline: string;
    requestedDeadline: string;
    deferMinutes: number;
  }): Promise<WebhookDispatchResult> {
    const off = disabledResult('aiBlockDeferReview');
    if (off) return off;
    const text = [
      `【堵塞顺延待审核】员工 ${input.assigneeName} 在任务「${input.title}」遇到堵塞并申请顺延截止 ${input.deferMinutes} 分钟（${input.originalDeadline} → ${input.requestedDeadline}）。`,
      '请立即执行 AI 初审：',
      `1. 调用工具 block_defer_list（传 taskId=${input.taskId}）拉取申请详情（含堵塞原因与解决情况和方案）；`,
      '2. 按 block-defer 技能的审核规则判断顺延合理性：方案是否具体可行、顺延时长是否与方案匹配、是否存在拖延；',
      '3. 合理：调用 block_defer_write 回写 pass（等待老板终审）；不合理：回写 revise 并说明原因（会通知员工）。',
    ].join('\n');
    return this.dispatchWebhook('block.defer.submitted', text, {
      task_id: input.taskId,
      title: input.title,
      assignee_name: input.assigneeName,
      reason: input.reason,
      resolution: input.resolution,
      original_deadline: input.originalDeadline,
      requested_deadline: input.requestedDeadline,
      defer_minutes: input.deferMinutes,
    });
  }

  async dispatchWebhook(
    eventType: string,
    text: string,
    data: Record<string, unknown>,
  ): Promise<WebhookDispatchResult> {
    const secret = await this.credentials.get('AILY_WEBHOOK_SECRET');
    if (!secret) {
      return {
        dispatched: false,
        detail: '未配置 AILY_WEBHOOK_SECRET（环境变量或系统配置），豆包通知未启用',
      };
    }
    let url = '';
    try {
      const rows: { configValue: unknown }[] = await this.db
        .select({ configValue: systemConfigs.configValue })
        .from(systemConfigs)
        .where(eq(systemConfigs.configKey, TASK_REVIEW_WEBHOOK_KEY))
        .limit(1);
      const raw = (rows[0]?.configValue ?? {}) as { webhook_url?: unknown };
      url = typeof raw.webhook_url === 'string' ? raw.webhook_url.trim() : '';
    } catch (error) {
      return {
        dispatched: false,
        detail: `读取系统配置失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!url) {
      return {
        dispatched: false,
        detail: '未配置 task_review.webhook_url 系统配置，豆包通知未启用',
      };
    }

    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({
      event_id: eventId,
      event_type: eventType,
      event_time: Math.floor(Date.now() / 1000),
      source: 'panasia-workbench',
      text,
      data,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      return { dispatched: false, detail: `Webhook 地址不合法：${url}` };
    }
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const sigPayload = [timestamp, nonce, 'POST', path, bodyHash].join('\n');
    const signature = `v1,sha256=${createHmac('sha256', secret)
      .update(sigPayload)
      .digest('hex')}`;

    try {
      const response = await firstValueFrom(
        this.http.post(url, body, {
          timeout: 3000,
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Id': eventId,
            'X-Webhook-Timestamp': timestamp,
            'X-Webhook-Nonce': nonce,
            'X-Webhook-Signature': signature,
            'X-Webhook-Event-Type': eventType,
          },
        }),
      );
      const resData = response.data as { dispatched?: unknown };
      const dispatched = resData?.dispatched === true;
      const detail = dispatched
        ? '豆包已受理'
        : `豆包未受理：${JSON.stringify(response.data)}`;
      if (dispatched) {
        this.logger.log(`Webhook ${eventType} 已派发豆包`);
      } else {
        this.logger.warn(`Webhook ${eventType} 派发未受理：${detail}`);
      }
      return { dispatched, detail };
    } catch (error) {
      const axiosError = error as AxiosError;
      const responseDetail = axiosError.response
        ? JSON.stringify(axiosError.response.data)
        : '';
      const detail = `请求失败：${
        axiosError.message ?? String(error)
      }${responseDetail ? `（响应：${responseDetail}）` : ''}`;
      this.logger.warn(`Webhook ${eventType} 派发异常：${detail}`);
      return { dispatched: false, detail };
    }
  }
}
