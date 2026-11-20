import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  McpTools,
  McpTool,
  McpToolError,
  type Infer,
  type McpContext,
  type McpToolResult,
} from '@lark-apaas/fullstack-nestjs-core';
import { TaskReviewService } from '@server/modules/tasks/task-review.service';

const ReviewItemSchema = z.object({
  taskId: z.string().describe('Plane 任务 ID'),
  sequenceId: z.number().nullable().describe('任务序号'),
  title: z.string().describe('任务标题（含内联奖励 +N元）'),
  projectName: z.string().describe('所属项目名'),
  assigneeName: z.string().describe('提交材料的员工姓名'),
  rewardAmount: z.number().nullable().describe('委派奖励金额（元）'),
  deadline: z.string().nullable().describe('截止日期'),
  submittedAt: z.string().nullable().describe('材料提交时间'),
  evidenceText: z
    .string()
    .nullable()
    .describe('员工最新提交的验收凭证全文（含材料清单与说明）'),
  evidenceFileUrls: z
    .array(z.string())
    .describe('验收凭证里的文件 URL 列表（图片/文档，可打开核对）'),
});

export const ReviewListOutput = {
  items: z.array(ReviewItemSchema).describe('待审核的委派任务材料列表'),
};

export const ReviewWriteInput = {
  taskId: z.string().min(1).describe('Plane 任务 ID，来自 task_review_list 的 items[].taskId'),
  verdict: z
    .enum(['pass', 'revise'])
    .describe('审核结论：pass=通过（转老板终审），revise=打回（员工重做）'),
  reason: z
    .string()
    .describe('审核意见：revise 打回时必填具体原因（会通知员工），pass 时可填一句话结论'),
};

export const ReviewWriteOutput = {
  taskId: z.string().describe('Plane 任务 ID'),
  verdict: z.enum(['pass', 'revise']).describe('已执行的结论'),
  stateChanged: z.boolean().describe('revise 时是否已流转为阻塞状态'),
  notified: z.boolean().describe('revise 时是否已通知员工'),
  message: z.string().describe('执行结果说明'),
};

export const ReviewApproveInput = {
  taskId: z.string().min(1).describe('Plane 任务 ID，来自 task_review_list 的 items[].taskId'),
  action: z
    .enum(['approve', 'reject'])
    .describe('老板终审动作：approve=通过验收（任务完成、奖励入钱包），reject=打回'),
  comment: z
    .string()
    .optional()
    .describe('终审意见：reject 打回时必填具体原因（会通知员工），approve 时选填'),
};

export const ReviewApproveOutput = {
  taskId: z.string().describe('Plane 任务 ID'),
  action: z.enum(['approve', 'reject']).describe('已执行的动作'),
  stateChanged: z.boolean().describe('是否已流转状态'),
  message: z.string().describe('执行结果说明'),
};

function assertBoss(ctx: McpContext): string {
  const userId: string | undefined = ctx.user.userId;
  const roles: string[] = ctx.user.roles ?? [];
  if (!userId || !roles.includes('boss')) {
    throw new McpToolError(
      '任务审核仅限老板账号（boss 角色）操作。请让老板在豆包工作伙伴里以 boss 角色账号发起审核。',
      { code: 'BOSS_ROLE_REQUIRED' },
    );
  }
  return userId;
}

@McpTools({ prefix: 'task_review_' })
export class TaskReviewMcpTools {
  constructor(private readonly review: TaskReviewService) {}

  @McpTool({
    title: '查待审核材料',
    description:
      '拉取待审核的委派任务材料：每条含任务标题、员工、奖励、材料全文与文件 URL。老板说「审一下今天交的材料」或 Webhook 触发后先调此工具。可选 taskId 精确过滤（Webhook 自动触发时 payload.data.taskId 传这里）。只审委派任务；材料不足或看不清楚时不要硬给结论。',
    inputSchema: {
      taskId: z
        .string()
        .optional()
        .describe('按任务 ID 精确过滤，选填；不传返回全部待审列表'),
    },
    outputSchema: ReviewListOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async list(
    input: { taskId?: string },
    ctx: McpContext,
  ): Promise<McpToolResult<typeof ReviewListOutput>> {
    assertBoss(ctx);
    const items = await this.review.listPendingReviews(input.taskId);
    return { structuredContent: { items } };
  }

  @McpTool({
    title: '回写审核结论',
    description:
      '审核完材料后回写结论：verdict=pass 记录通过（任务保持待老板终审）、verdict=revise 打回（任务转阻塞并通知员工重做，reason 必填具体原因）。结论要基于 task_review_list 看到的实际材料，不要凭空判断。',
    inputSchema: ReviewWriteInput,
    outputSchema: ReviewWriteOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async write(
    input: Infer<typeof ReviewWriteInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof ReviewWriteOutput>> {
    assertBoss(ctx);
    try {
      const result = await this.review.writeAiVerdict(
        input.taskId,
        input.verdict,
        input.reason,
      );
      return { structuredContent: result };
    } catch (error) {
      return mapDomainError(error, 'TASK_REVIEW_INVALID_INPUT');
    }
  }

  @McpTool({
    title: '老板终审任务',
    description:
      '老板对 AI 初审通过的任务拍板：approve=通过验收（任务完成、委派奖励进员工钱包）、reject=打回。老板在豆包里说「通过张三那个任务」时调用；AI 初审未通过的任务不用调此工具（已自动打回）。',
    inputSchema: ReviewApproveInput,
    outputSchema: ReviewApproveOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async approve(
    input: Infer<typeof ReviewApproveInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof ReviewApproveOutput>> {
    assertBoss(ctx);
    try {
      const result = await this.review.approveTask(
        input.taskId,
        input.action,
        input.comment,
        { userId: ctx.user.userId ?? null, userName: null },
      );
      return { structuredContent: result };
    } catch (error) {
      return mapDomainError(error, 'TASK_REVIEW_INVALID_INPUT');
    }
  }
}

function mapDomainError(error: unknown, code: string): never {
  if (error instanceof BadRequestException || isNotFoundException(error)) {
    const message =
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '审核参数无效';
    throw new McpToolError(message, { code });
  }
  throw error;
}

function isNotFoundException(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundException'
  );
}
