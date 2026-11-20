import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  McpTools,
  McpTool,
  McpToolError,
  type Infer,
  type McpContext,
  type McpToolResult,
} from '@lark-apaas/fullstack-nestjs-core';
import { AgentConfigTaskService } from '@server/modules/tasks/agent-config-task.service';

const AgentTaskItemSchema = z.object({
  taskId: z.string().describe('任务 ID（完成任务时传给 agent_task_complete）'),
  title: z.string().describe('任务标题'),
  taskType: z.string().describe('任务类型：config=配置任务，verify=验证任务'),
  instruction: z
    .string()
    .describe('完整执行指令：按此引导操作者逐步完成，不要跳步'),
  status: z.string().describe('任务状态：pending=待处理，done=已完成'),
  resultNote: z
    .string()
    .nullable()
    .describe('完成时记录的备注（未完成为 null）'),
  createdAt: z.string().describe('任务下发时间（ISO 时间）'),
});

export const AgentTaskListOutput = {
  items: z.array(AgentTaskItemSchema).describe('任务列表'),
};

export const AgentTaskCompleteInput = {
  taskId: z
    .string()
    .min(1)
    .describe('任务 ID，来自 agent_task_list 的 items[].taskId'),
  note: z
    .string()
    .optional()
    .describe('完成备注：写一句做了什么，选填但建议填'),
};

export const AgentTaskCompleteOutput = {
  taskId: z.string().describe('任务 ID'),
  status: z.string().describe('标记后的状态'),
  message: z.string().describe('执行结果说明'),
};

@McpTools({ prefix: 'agent_task_' })
export class AgentTasksMcpTools {
  constructor(private readonly tasks: AgentConfigTaskService) {}

  @McpTool({
    title: '拉妙搭下发的配置任务',
    description:
      '拉取妙搭工作台侧下发给你的待办任务：妙搭沙箱里完成不了的配置、联调、验证类工作会写成任务放在这里，每条带完整执行指令。操作者问「有什么要配的/看看任务」时、以及你空闲时主动建议检查时调用。默认只返回待处理；按 instruction 引导操作者逐条完成，完成后用 agent_task_complete 标记。',
    inputSchema: {
      status: z
        .enum(['pending', 'done', 'all'])
        .optional()
        .describe('筛选状态：pending=待处理（默认），done=已完成，all=全部'),
    },
    outputSchema: AgentTaskListOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async list(
    input: { status?: 'pending' | 'done' | 'all' },
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof AgentTaskListOutput>> {
    const items = await this.tasks.listTasks(input.status ?? 'pending');
    return { structuredContent: { items } };
  }

  @McpTool({
    title: '完成配置任务',
    description:
      '一条配置任务引导操作者做完后调用，把它标记为已完成并记录备注。只有真正做完才标记；做不完如实说明卡在哪一步，不要假完成。',
    inputSchema: AgentTaskCompleteInput,
    outputSchema: AgentTaskCompleteOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async complete(
    input: Infer<typeof AgentTaskCompleteInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof AgentTaskCompleteOutput>> {
    try {
      const item = await this.tasks.completeTask(input.taskId, input.note);
      return {
        structuredContent: {
          taskId: item.taskId,
          status: item.status,
          message: `配置任务「${item.title}」已完成${
            input.note ? `：${input.note}` : ''
          }`,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new McpToolError(error.message, { code: 'AGENT_TASK_NOT_FOUND' });
      }
      throw error;
    }
  }
}
