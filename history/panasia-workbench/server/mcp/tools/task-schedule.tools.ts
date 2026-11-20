import { BadRequestException, NotFoundException } from '@nestjs/common';
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
import { TaskTemplateService } from '@server/modules/tasks/task-template.service';
import type { TaskTemplateSummary } from '@shared/api.interface';

// 定时单 = 工作台「任务模板」：按每天 / 工作日 / 每周几，到点在 Plane 里给员工生成当天的任务。
// 一次性的单走 delegate_create（委派），这里只管定时的。和手填页面（管理 → 任务模板）是同一张表、同一套校验。

const ScheduleSchema = z.object({
  kind: z
    .enum(['every_day', 'workdays', 'weekly'])
    .describe('every_day=每天；workdays=周一到周五；weekly=每周几（配 weekdays）'),
  weekdays: z
    .array(z.number().int().min(1).max(7))
    .optional()
    .describe('kind=weekly 时必填：1=周一 … 7=周日'),
});

const ScheduleItemSchema = z.object({
  id: z.string().describe('定时单 ID，改 / 停用时传'),
  title: z.string(),
  schedule: ScheduleSchema,
  scheduleLabel: z.string().describe('人看的周期，如「每周一、周四」'),
  projectId: z.string(),
  projectName: z.string(),
  assigneeName: z.string().nullable().describe('指派员工；null=不指定，所有人都能看到'),
  enabled: z.boolean(),
  runsToday: z.boolean().describe('今天是否轮到生成'),
});

export const ScheduleListOutput = {
  items: z.array(ScheduleItemSchema),
  autoGenerateNote: z.string().describe('到点自动生成是否打开的说明'),
};

export const ScheduleCreateInput = {
  title: z.string().min(1).describe('任务标题，到点原样生成'),
  schedule: ScheduleSchema,
  assigneeId: z
    .string()
    .optional()
    .describe('指派员工 userId，取自 delegate_info 的 employees[].userId；不传=不指定'),
  projectId: z
    .string()
    .optional()
    .describe('Plane 项目 ID，取自 delegate_info 的 projects[].projectId；不传默认「日常执行」'),
  description: z.string().optional().describe('任务说明，生成时带进任务描述'),
  enabled: z.boolean().optional().describe('建好就生效，默认 true'),
};

export const ScheduleUpdateInput = {
  id: z.string().min(1).describe('schedule_list 返回的 id'),
  title: z.string().min(1).optional(),
  schedule: ScheduleSchema.optional(),
  assigneeId: z
    .string()
    .nullable()
    .optional()
    .describe('换人传 userId；传 null=改成不指定；不传=不改'),
  projectId: z.string().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional().describe('false=停用（不删，随时可再开）'),
};

export const ScheduleItemOutput = { item: ScheduleItemSchema };

function assertBoss(ctx: McpContext): string {
  const userId: string | undefined = ctx.user.userId;
  const roles: string[] = ctx.user.roles ?? [];
  if (!userId || !roles.includes('boss')) {
    throw new McpToolError('定时单仅限老板账号（boss 角色）操作。', {
      code: 'BOSS_ROLE_REQUIRED',
    });
  }
  return userId;
}

function toToolError(error: unknown): never {
  if (error instanceof BadRequestException || error instanceof NotFoundException) {
    const message = typeof error.message === 'string' ? error.message : '参数无效';
    throw new McpToolError(message, {
      code: error instanceof NotFoundException ? 'SCHEDULE_NOT_FOUND' : 'SCHEDULE_INVALID_INPUT',
    });
  }
  throw error;
}

@McpTools({ prefix: 'schedule_' })
export class TaskScheduleMcpTools {
  constructor(
    private readonly templates: TaskTemplateService,
    private readonly delegate: TaskDelegateService,
  ) {}

  private async toItem(
    row: TaskTemplateSummary,
    names: Map<string, string>,
  ): Promise<z.infer<typeof ScheduleItemSchema>> {
    return {
      id: row.id,
      title: row.title,
      schedule: row.schedule,
      scheduleLabel: row.scheduleLabel,
      projectId: row.planeProjectId,
      projectName: row.planeProjectName,
      assigneeName: row.assigneeMemberId ? (names.get(row.assigneeMemberId) ?? row.assigneeMemberId) : null,
      enabled: row.enabled,
      runsToday: row.runsToday,
    };
  }

  private async memberNames(): Promise<Map<string, string>> {
    return this.delegate.memberNames();
  }

  @McpTool({
    title: '查定时单',
    description:
      '列出全部定时单（任务模板）：周期、指派员工、所属项目、是否启用、今天是否轮到。改 / 停用前先查拿 id。',
    inputSchema: {},
    outputSchema: ScheduleListOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })
  async list(
    _input: Record<string, never>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof ScheduleListOutput>> {
    assertBoss(ctx);
    const names = await this.memberNames();
    const rows = await this.templates.listAll();
    const items = await Promise.all(rows.map((row: TaskTemplateSummary) => this.toItem(row, names)));
    return {
      structuredContent: {
        items,
        autoGenerateNote: this.templates.autoGenerateNote(),
      },
    };
  }

  @McpTool({
    title: '建定时单',
    description:
      '新建一张定时单：标题 title、周期 schedule 必填（weekly 要带 weekdays）；指派员工 assigneeId、项目 projectId 先用 delegate_info 取有效值。' +
      '建好后按周期每天在 Plane 生成当天任务（同名同日不重复生成）。一次性的事用 delegate_create，不要建定时单。重复调用会建出两张，确认无误再提交。',
    inputSchema: ScheduleCreateInput,
    outputSchema: ScheduleItemOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  })
  async create(
    input: Infer<typeof ScheduleCreateInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof ScheduleItemOutput>> {
    assertBoss(ctx);
    try {
      const project = await this.delegate.resolveProject(input.projectId);
      const assignee = input.assigneeId ? await this.delegate.resolveAssignee(input.assigneeId) : null;
      const row = await this.templates.create({
        title: input.title,
        templateType: input.schedule.kind === 'every_day' ? 'daily' : 'scheduled',
        schedule: input.schedule,
        planeProjectId: project.projectId,
        planeProjectName: project.name,
        assigneeMemberId: assignee ? assignee.planeMemberId : null,
        description: input.description ?? null,
        enabled: input.enabled ?? true,
      });
      return { structuredContent: { item: await this.toItem(row, await this.memberNames()) } };
    } catch (error) {
      toToolError(error);
    }
  }

  @McpTool({
    title: '改定时单 / 停用',
    description:
      '按 id 修改定时单：只传要改的字段。enabled=false 是停用（不删，随时可再开）；assigneeId 传 null 改成不指定。改完回读返回最新内容。',
    inputSchema: ScheduleUpdateInput,
    outputSchema: ScheduleItemOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })
  async update(
    input: Infer<typeof ScheduleUpdateInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof ScheduleItemOutput>> {
    assertBoss(ctx);
    try {
      const patch: Parameters<TaskTemplateService['update']>[1] = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.schedule !== undefined) {
        patch.schedule = input.schedule;
        patch.templateType = input.schedule.kind === 'every_day' ? 'daily' : 'scheduled';
      }
      if (input.projectId !== undefined) {
        const project = await this.delegate.resolveProject(input.projectId);
        patch.planeProjectId = project.projectId;
        patch.planeProjectName = project.name;
      }
      if (input.assigneeId !== undefined) {
        patch.assigneeMemberId = input.assigneeId
          ? (await this.delegate.resolveAssignee(input.assigneeId)).planeMemberId
          : null;
      }
      if (input.description !== undefined) patch.description = input.description;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      await this.templates.update(input.id, patch);
      // 回读:以库里现在的样子为准,不拿入参拼
      const fresh = (await this.templates.listAll()).find((row: TaskTemplateSummary) => row.id === input.id);
      if (!fresh) throw new NotFoundException('定时单不存在');
      return { structuredContent: { item: await this.toItem(fresh, await this.memberNames()) } };
    } catch (error) {
      toToolError(error);
    }
  }
}
