import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';

import { systemConfigs } from '@server/database/schema';
import type {
  AdminTaskDraft,
  QuickTaskDraftRequest,
  QuickTaskDraftResponse,
} from '@shared/api.interface';
import { AilyOpenApiService } from '../integration/aily-openapi.service';
import { isFeatureEnabled } from '../integration/optional-features';

const DRAFT_CONFIG_KEY = 'quick_task.draft_agent_id';
const POLL_TOTAL_LIMIT_MS = 45_000;
const POLL_FIRST_DELAY_MS = 2_000;
const POLL_MAX_DELAY_MS = 5_000;

interface DraftAgentConfig {
  agent_id?: unknown;
}

interface RawDraft {
  title?: unknown;
  description?: unknown;
  dueDate?: unknown;
  confidence?: unknown;
}

@Injectable()
export class QuickTaskDraftService {
  private readonly logger = new Logger(QuickTaskDraftService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly aily: AilyOpenApiService,
  ) {}

  async generateDraft(
    dto: QuickTaskDraftRequest,
  ): Promise<QuickTaskDraftResponse> {
    // AI 草稿是可选集成（AILY_QUICK_TASK_DRAFT_ENABLED，默认开）：关着前端不显示按钮，这里兜底
    if (!isFeatureEnabled('aiQuickTaskDraft')) {
      return this.fallback('AI 草稿未启用，请直接填写');
    }
    const input = dto.input?.trim() ?? '';
    if (!input) {
      return this.fallback('请先输入一句话需求');
    }
    const agentId = await this.resolveAgentId();
    if (!agentId) {
      return this.fallback(
        '尚未配置 AI 草稿智能体 ID：请到 管理 → 系统配置 填写 quick_task.draft_agent_id',
      );
    }
    try {
      const sessionId = await this.aily.createSession(agentId);
      const chatId = await this.aily.createRun(
        agentId,
        sessionId,
        this.buildPrompt(input),
      );
      const chat = await this.pollUntilSettled(agentId, chatId);
      const status = typeof chat.status === 'string' ? chat.status : '';
      if (status !== 'Completed') {
        return this.fallback(
          status === 'Failed'
            ? '豆包智能体执行失败，请重试或手工填写'
            : 'AI 草稿生成超时，请重试或手工填写',
        );
      }
      const reply = this.aily.extractChatReply(chat);
      if (!reply) {
        return this.fallback('AI 未返回草稿内容，请重试或手工填写');
      }
      const draft = this.parseDraft(reply);
      if (!draft) {
        return this.fallback('AI 返回内容无法解析为任务草稿，请重试或手工填写');
      }
      return { draft, fallback: false };
    } catch (error) {
      this.logger.error(
        'AI 草稿生成失败',
        error instanceof Error ? error.stack : String(error),
      );
      const message = error instanceof Error ? error.message : '未知错误';
      return this.fallback(`AI 草稿生成失败：${message}`);
    }
  }

  private fallback(message: string): QuickTaskDraftResponse {
    return { draft: null, fallback: true, message };
  }

  private async resolveAgentId(): Promise<string> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, DRAFT_CONFIG_KEY))
      .limit(1);
    const config = (rows[0]?.configValue ?? {}) as DraftAgentConfig;
    return typeof config.agent_id === 'string' ? config.agent_id.trim() : '';
  }

  private buildPrompt(input: string): string {
    const today = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
    }).format(new Date());
    return [
      '你是任务规划助手。根据管理者的一句话需求，产出一份可执行的任务草稿。',
      '只输出一个 JSON 对象，禁止输出 markdown 代码块或其他文字，字段：',
      'title：任务标题，40 字以内；若需求提到截止时刻，以「HH:mm前」结尾内联',
      'description：任务说明，含执行要求与验收条件，分点',
      `dueDate：建议截止日期，格式 YYYY-MM-DD；今天是 ${today}；无明确要求时填今天`,
      'confidence：对需求理解的把握，0-100 整数',
      `管理者需求：${input}`,
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

  private parseDraft(reply: string): AdminTaskDraft | null {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }
    let parsed: RawDraft;
    try {
      parsed = JSON.parse(reply.slice(start, end + 1)) as RawDraft;
    } catch {
      return null;
    }
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    if (!title) {
      return null;
    }
    const draft: AdminTaskDraft = { title, confidence: 80 };
    const description =
      typeof parsed.description === 'string' ? parsed.description.trim() : '';
    if (description) {
      draft.description = description;
    }
    const dueDate = typeof parsed.dueDate === 'string' ? parsed.dueDate : '';
    if (/^\d{4}-\d{2}-\d{2}$/u.test(dueDate)) {
      draft.dueDate = dueDate;
    }
    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.round(parsed.confidence)
        : 80;
    draft.confidence = Math.max(0, Math.min(100, confidence));
    return draft;
  }
}
