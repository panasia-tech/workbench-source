import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { agentConfigTasks } from '@server/database/schema';
import { AilyWebhookService } from '@server/modules/integration/aily-webhook.service';
import type {
  AgentTaskCreated,
  CreateAgentTaskRequest,
} from '@shared/api.interface';

export interface AgentConfigTaskItem {
  taskId: string;
  title: string;
  taskType: string;
  instruction: string;
  status: string;
  resultNote: string | null;
  createdAt: string;
}

export type AgentTaskStatusFilter = 'pending' | 'done' | 'all';

@Injectable()
export class AgentConfigTaskService {
  private readonly logger = new Logger(AgentConfigTaskService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly webhook: AilyWebhookService,
  ) {}

  async listTasks(
    status: AgentTaskStatusFilter = 'pending',
  ): Promise<AgentConfigTaskItem[]> {
    const conditions = [];
    if (status === 'pending') {
      conditions.push(ne(agentConfigTasks.status, 'done'));
    } else if (status === 'done') {
      conditions.push(eq(agentConfigTasks.status, 'done'));
    }
    const rows = await this.db
      .select()
      .from(agentConfigTasks)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(agentConfigTasks.createdAt));
    return rows.map((row) => ({
      taskId: row.id,
      title: row.title,
      taskType: row.taskType,
      instruction: row.instruction,
      status: row.status,
      resultNote: row.resultNote,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createTask(dto: CreateAgentTaskRequest): Promise<AgentTaskCreated> {
    const inserted = await this.db
      .insert(agentConfigTasks)
      .values({
        title: dto.title,
        taskType: dto.taskType ?? 'config',
        instruction: dto.instruction,
      })
      .returning();
    const row = inserted[0];
    let notified = false;
    let notifyDisabled = false;
    let notifyDetail = '';
    try {
      const result = await this.webhook.notifyAgentTaskCreated(
        row.id,
        row.title,
      );
      notified = result.dispatched;
      notifyDisabled = result.disabled === true;
      notifyDetail = result.detail;
    } catch (error) {
      notifyDetail = `推送通知异常：${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    // 推送没开（AILY_AGENT_TASK_PUSH_ENABLED）不算失败：豆包下次拉 agent_task_list 时自己会看到
    if (!notified && !notifyDisabled) {
      this.logger.warn(
        `配置任务「${row.title}」入库但豆包通知未送达：${notifyDetail}`,
      );
    }
    return {
      taskId: row.id,
      title: row.title,
      taskType: row.taskType,
      instruction: row.instruction,
      status: row.status,
      resultNote: row.resultNote,
      createdAt: row.createdAt.toISOString(),
      notified,
      notifyDetail,
    };
  }

  async completeTask(
    taskId: string,
    note: string | undefined,
  ): Promise<AgentConfigTaskItem> {
    const updated = await this.db
      .update(agentConfigTasks)
      .set({
        status: 'done',
        resultNote: note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(agentConfigTasks.id, taskId))
      .returning();
    if (updated.length === 0) {
      throw new NotFoundException(`配置任务不存在：${taskId}`);
    }
    const row = updated[0];
    return {
      taskId: row.id,
      title: row.title,
      taskType: row.taskType,
      instruction: row.instruction,
      status: row.status,
      resultNote: row.resultNote,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
