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
import { TaskDelegateService } from '@server/modules/tasks/task-delegate.service';

const EmployeeItemSchema = z.object({
  userId: z.string().describe('员工用户 ID，委派时作为 assigneeId 传入'),
  name: z.string().describe('员工姓名'),
});

const ProjectItemSchema = z.object({
  projectId: z.string().describe('Plane 项目 ID，委派时作为 projectId 传入'),
  name: z.string().describe('项目名称'),
});

export const DelegateInfoOutput = {
  employees: z.array(EmployeeItemSchema).describe('可指派的员工列表'),
  projects: z.array(ProjectItemSchema).describe(
    '可选的 Plane 项目列表；老板不指定项目时用默认「日常执行」项目，无需必填',
  ),
};

export const DelegateCreateInput = {
  title: z.string().min(1).describe('委派任务标题，一句话说清要员工做什么'),
  assigneeId: z
    .string()
    .min(1)
    .describe('指派员工的用户 ID，必须来自 delegate_info 返回的 employees[].userId'),
  rewardAmount: z
    .number()
    .positive()
    .optional()
    .describe(
      '额外奖励金额（元），完成后计入员工钱包、不计绩效；会自动内联进标题 +N元，标题不要再手写金额；老板没提奖励就不填',
    ),
  projectId: z
    .string()
    .optional()
    .describe('所属 Plane 项目 ID，来自 delegate_info 的 projects[].projectId；不传默认「日常执行」项目'),
  dueDate: z
    .string()
    .optional()
    .describe('截止日期 YYYY-MM-DD，默认今天（委派任务为当天强时效）'),
  remark: z.string().optional().describe('补充说明，选填'),
};

export const DelegateCreateOutput = {
  taskId: z.string().describe('Plane 任务 ID'),
  taskUrl: z.string().describe('工作台任务详情路径 /tasks/:id'),
  title: z.string().describe('最终任务标题（奖励金额已内联 +N元）'),
  assigneeName: z.string().describe('指派员工姓名'),
  projectName: z.string().describe('所属项目名称'),
  rewardAmount: z
    .number()
    .nullable()
    .describe('生效的奖励金额（元）；null=未设奖励'),
};

function assertBoss(ctx: McpContext): string {
  const userId: string | undefined = ctx.user.userId;
  const roles: string[] = ctx.user.roles ?? [];
  if (!userId || !roles.includes('boss')) {
    throw new McpToolError(
      '委派仅限老板账号（boss 角色）操作。请让老板在豆包工作伙伴里以 boss 角色账号发起委派。',
      { code: 'BOSS_ROLE_REQUIRED' },
    );
  }
  return userId;
}

@McpTools({ prefix: 'delegate_' })
export class TaskDelegateMcpTools {
  constructor(private readonly delegate: TaskDelegateService) {}

  @McpTool({
    title: '查可委派员工与项目',
    description:
      '老板委派前先调用：返回可指派员工列表（employees[].userId 委派时作 assigneeId）与 Plane 项目列表。委派要素=标题、指派员工、奖励金额（选填）、所属项目（选填，默认「日常执行」）、备注（选填）；拿到有效取值后再用 delegate_create 提交委派。',
    inputSchema: {},
    outputSchema: DelegateInfoOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async info(
    _input: Record<string, never>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof DelegateInfoOutput>> {
    assertBoss(ctx);
    const context = await this.delegate.getDelegationContext();
    return { structuredContent: context };
  }

  @McpTool({
    title: '创建委派任务',
    description:
      '要素齐全后提交委派：标题 title、指派员工 assigneeId 必填（取值先经 delegate_info 校验）；奖励金额 rewardAmount 选填（完成后进员工钱包、不计绩效，工具自动内联 +N元）；所属项目 projectId 选填（默认「日常执行」）；截止 dueDate 选填（默认今天）。创建成功员工立即在工作台看到委派卡。要素不齐全时不要调用，先向老板收集。重复调用会重复建任务，确认无误后再提交。',
    inputSchema: DelegateCreateInput,
    outputSchema: DelegateCreateOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async create(
    input: Infer<typeof DelegateCreateInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof DelegateCreateOutput>> {
    assertBoss(ctx);
    try {
      const result = await this.delegate.createDelegatedTask({
        title: input.title,
        assigneeId: input.assigneeId,
        projectId: input.projectId,
        rewardAmount: input.rewardAmount,
        dueDate: input.dueDate,
        remark: input.remark,
      });
      return { structuredContent: result };
    } catch (error) {
      if (error instanceof BadRequestException) {
        const message =
          typeof error.message === 'string' ? error.message : '委派参数无效';
        throw new McpToolError(message, { code: 'DELEGATE_INVALID_INPUT' });
      }
      throw error;
    }
  }
}
