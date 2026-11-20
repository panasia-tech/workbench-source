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
import { BlockDeferService } from '@server/modules/tasks/block-defer.service';

const DeferItemSchema = z.object({
  id: z.string().describe('申请 ID（老板终审 block_defer_approve 用）'),
  taskId: z.string().describe('Plane 任务 ID'),
  sequenceId: z.number().nullable().describe('任务序号'),
  title: z.string().describe('任务标题'),
  projectName: z.string().describe('所属项目名'),
  assigneeName: z.string().describe('申请顺延的员工姓名'),
  reason: z.string().describe('堵塞原因（员工原话）'),
  resolution: z
    .string()
    .describe('解决情况和方案（员工原话，审核重点：是否具体可行）'),
  category: z.string().describe('堵塞分类'),
  deferMinutes: z.number().describe('申请顺延的分钟数'),
  originalDeadline: z.string().describe('原截止时刻 HH:mm'),
  requestedDeadline: z.string().describe('申请顺延到 HH:mm'),
  status: z
    .enum(['pending', 'ai_passed', 'ai_rejected', 'approved', 'rejected', 'cancelled'])
    .describe('申请状态'),
  aiOpinion: z.string().nullable().describe('AI 初审意见'),
  sopId: z.string().nullable().describe('自动生成的 SOP 记录 ID'),
  sopTitle: z.string().nullable().describe('SOP 标题'),
  requestedAt: z.string().describe('申请时间'),
});

export const DeferListOutput = {
  items: z
    .array(DeferItemSchema)
    .describe('顺延申请列表（不传 taskId 时返回待 AI 初审 + 待老板终审的申请）'),
};

export const DeferWriteInput = {
  taskId: z.string().min(1).describe('Plane 任务 ID，来自 block_defer_list 的 items[].taskId'),
  verdict: z
    .enum(['pass', 'revise'])
    .describe('初审结论：pass=顺延合理（转老板终审），revise=不合理（通知员工按原截止推进）'),
  reason: z
    .string()
    .describe('初审意见：revise 时必填具体原因（会通知员工），pass 时可填一句话结论'),
};

export const DeferWriteOutput = {
  taskId: z.string().describe('Plane 任务 ID'),
  verdict: z.enum(['pass', 'revise']).describe('已执行的结论'),
  accepted: z.boolean().describe('是否回写成功（申请已被处理时为 false）'),
  message: z.string().describe('执行结果说明'),
};

export const DeferApproveInput = {
  requestId: z.string().min(1).describe('申请 ID，来自 block_defer_list 的 items[].id'),
  action: z
    .enum(['approve', 'reject'])
    .describe('老板终审动作：approve=批准顺延（改写任务截止时刻），reject=拒绝'),
  comment: z.string().optional().describe('终审意见，选填'),
};

export const DeferApproveOutput = {
  requestId: z.string().describe('申请 ID'),
  action: z.enum(['approve', 'reject']).describe('已执行的动作'),
  message: z.string().describe('执行结果说明'),
};

function assertBoss(ctx: McpContext): void {
  const userId: string | undefined = ctx.user.userId;
  const roles: string[] = ctx.user.roles ?? [];
  if (!userId || !roles.includes('boss')) {
    throw new McpToolError(
      '堵塞顺延审核仅限老板账号（boss 角色）操作。',
      { code: 'BOSS_ROLE_REQUIRED' },
    );
  }
}

@McpTools({ prefix: 'block_defer_' })
export class BlockDeferMcpTools {
  constructor(private readonly defer: BlockDeferService) {}

  @McpTool({
    title: '查顺延申请',
    description:
      '拉取堵塞顺延申请：每条含任务标题、员工、堵塞原因、解决情况和方案、原截止与申请顺延到的时刻。传 taskId 返回该任务全部申请（各状态）；不传返回待审列表（AI 初审中 + 待老板终审）。Webhook【堵塞顺延待审核】触发后先调此工具（payload.data.task_id 传 taskId）。',
    inputSchema: {
      taskId: z
        .string()
        .optional()
        .describe('按任务 ID 过滤（含全部状态），选填；不传返回待审列表'),
    },
    outputSchema: DeferListOutput,
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
  ): Promise<McpToolResult<typeof DeferListOutput>> {
    assertBoss(ctx);
    if (input.taskId) {
      const rows = await this.defer.listByTaskAll(input.taskId);
      return { structuredContent: { items: rows } };
    }
    const items = await this.defer.listForReview();
    return { structuredContent: { items } };
  }

  @McpTool({
    title: '回写顺延初审',
    description:
      'AI 初审顺延申请后回写：verdict=pass 记录合理（转待老板终审）、verdict=revise 判定不合理（通知员工按原截止推进）。判断依据 block_defer_list 里的解决情况和方案：是否具体可行、顺延时长是否与方案匹配、是否存在拖延。',
    inputSchema: DeferWriteInput,
    outputSchema: DeferWriteOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async write(
    input: Infer<typeof DeferWriteInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof DeferWriteOutput>> {
    assertBoss(ctx);
    try {
      const accepted = await this.defer.aiReview(input.taskId, input.verdict, input.reason);
      return {
        structuredContent: {
          taskId: input.taskId,
          verdict: input.verdict,
          accepted,
          message: accepted
            ? input.verdict === 'pass'
              ? '已记录初审通过，等待老板终审'
              : '已打回并通知员工'
            : '该任务没有待初审的顺延申请（可能已处理）',
        },
      };
    } catch (error) {
      throw mapDomainError(error, 'BLOCK_DEFER_INVALID_INPUT');
    }
  }

  @McpTool({
    title: '老板终审顺延',
    description:
      '老板对 AI 初审通过的顺延申请拍板：approve=批准（任务截止时刻自动顺延并通知员工）、reject=拒绝（通知员工按原截止推进）。老板在豆包里说「同意张三的顺延」时调用。',
    inputSchema: DeferApproveInput,
    outputSchema: DeferApproveOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async approve(
    input: Infer<typeof DeferApproveInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof DeferApproveOutput>> {
    assertBoss(ctx);
    try {
      const item = await this.defer.bossVerdict(input.requestId, input.action, input.comment);
      return {
        structuredContent: {
          requestId: input.requestId,
          action: input.action,
          message:
            input.action === 'approve'
              ? `已批准顺延：${item.title} 截止时刻 ${item.originalDeadline} → ${item.requestedDeadline}，已通知员工`
              : `已拒绝顺延：${item.title}，员工需按原截止 ${item.originalDeadline} 推进`,
        },
      };
    } catch (error) {
      throw mapDomainError(error, 'BLOCK_DEFER_INVALID_INPUT');
    }
  }
}

function mapDomainError(error: unknown, code: string): never {
  if (
    error instanceof BadRequestException ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'NotFoundException')
  ) {
    const message =
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '顺延审核参数无效';
    throw new McpToolError(message, { code });
  }
  throw error;
}
