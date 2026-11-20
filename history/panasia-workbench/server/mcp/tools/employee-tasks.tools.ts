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
import { TasksService } from '@server/modules/tasks/tasks.service';
import { TutorialOutputService } from '@server/modules/profile/tutorial-output.service';
import { todayDateString } from '@server/modules/integration/plane-mapping';
import type { TaskSummary, TutorialTask } from '@shared/api.interface';

const TaskTypeSchema = z
  .enum(['daily', 'scheduled', 'delegated', 'workorder', 'standard'])
  .describe(
    '任务类型：daily=日常、scheduled=定时、delegated=委派、workorder=工单、standard=普通',
  );

const OpenTaskItemSchema = z.object({
  id: z.string().describe('任务 ID，供 task_detail 查详情使用'),
  sequenceId: z.number().nullable().describe('任务序号'),
  title: z.string().describe('任务标题'),
  statusLabel: z.string().describe('状态文案（待处理/进行中/阻塞/待验收等）'),
  deadline: z.string().nullable().describe('截止日期 YYYY-MM-DD'),
  deadlineTime: z
    .string()
    .nullable()
    .describe('截止时刻 HH:mm（约定写在标题内，如「18:00前」）'),
  severeBlocked: z
    .boolean()
    .describe('是否严重堵塞（超截止 48 小时未完结，属严重违规，需优先处理）'),
  rewardAmount: z.number().nullable().describe('委派任务额外奖励金额（元），仅委派任务有'),
  estimatedEarning: z
    .number()
    .nullable()
    .describe('普通任务绩效估算金额（元），按当月任务量分摊'),
  taskType: TaskTypeSchema,
  projectName: z.string().describe('所属项目名'),
  currentAction: z.string().nullable().describe('当前动作（该任务眼下该做什么）'),
});

const DoneTodayItemSchema = z.object({
  title: z.string().describe('任务标题'),
  completedAt: z.string().nullable().describe('完成时间（日期）'),
});

const TutorialTaskItemSchema = z.object({
  caseId: z.number().describe('教程案例 ID'),
  title: z.string().describe('教程标题'),
  currentStageTitle: z
    .string()
    .nullable()
    .describe('当前所处阶段名称'),
  progress: z.number().describe('进度百分比 0-100'),
  stepsDone: z.number().nullable().describe('已完成步骤数'),
  stepsTotal: z.number().nullable().describe('步骤总数'),
  severeBlocked: z.boolean().describe('是否严重堵塞'),
  blockedReason: z
    .enum(['step_rejected', 'overdue'])
    .nullable()
    .describe('堵塞原因：step_rejected=材料被打回、overdue=超期未完成'),
  overdueDays: z.number().nullable().describe('超期天数（overdue 时有）'),
  rewardScore: z.number().describe('完成可获绩效分'),
  rewardAmount: z
    .number()
    .nullable()
    .describe('完成可获金额（元），绩效分按当月奖金折算'),
});

export const TaskListTodayOutput = {
  bound: z.boolean().describe('员工是否已绑定 Plane 账号'),
  today: z.string().describe('今日日期（上海时区 YYYY-MM-DD）'),
  openTasks: z
    .array(OpenTaskItemSchema)
    .describe('待办（open）任务列表，含今日任务与逾期的未完结任务，已按优先级排序'),
  doneToday: z
    .array(DoneTodayItemSchema)
    .describe('今日已完成的任务（标题+完成时间）'),
  tutorialTasks: z
    .array(TutorialTaskItemSchema)
    .describe('进行中的教程任务（未完成，含进度与堵塞情况）'),
  gamification: z.object({
    todayDone: z.number().describe('今日已完成数'),
    todayTotal: z.number().describe('今日任务总数'),
    streakDays: z.number().describe('连续完成任务天数'),
    walletMonth: z.number().describe('本月委派奖励钱包（元）'),
  }),
};

export const TaskDetailInput = {
  taskId: z
    .string()
    .min(1)
    .describe('任务 ID，来自 task_list_today 返回的 openTasks[].id'),
};

const TUTORIAL_OUTPUT_SCHEMA = z.object({
  projectId: z.string().describe('教程 ID（Learning 课程 name）'),
  projectName: z.string().describe('教程名'),
  stageCount: z.number().describe('阶段总数'),
  stepCount: z.number().describe('步骤总数'),
  videoCount: z.number().describe('实操视频数'),
  stages: z
    .array(
      z.object({
        title: z.string().describe('阶段标题'),
        steps: z
          .array(
            z.object({
              title: z.string().describe('步骤标题'),
              hasVideo: z.boolean().describe('该步骤是否有实操视频'),
            }),
          )
          .describe('阶段下的步骤列表'),
      }),
    )
    .describe('教程阶段结构'),
});

export const TaskDetailOutput = {
  taskId: z.string(),
  title: z.string().describe('任务标题'),
  statusLabel: z.string().describe('状态文案'),
  projectName: z.string().describe('所属项目名'),
  deadline: z.string().nullable().describe('截止日期 YYYY-MM-DD'),
  deadlineTime: z.string().nullable().describe('截止时刻 HH:mm'),
  severeBlocked: z.boolean().describe('是否严重堵塞'),
  taskType: TaskTypeSchema,
  currentAction: z.string().nullable().describe('当前动作'),
  evidenceSummary: z.string().nullable().describe('提交材料要求摘要'),
  evidenceChecklist: z
    .array(
      z.object({
        name: z.string().describe('验收条件名称'),
        submitted: z.boolean().describe('是否已提交对应材料'),
      }),
    )
    .describe('验收条件清单（无验收条件时为空数组）'),
  rewardAmount: z
    .number()
    .nullable()
    .describe('委派任务额外奖励金额（元），仅委派任务有'),
  evidenceFileUrls: z
    .array(z.string())
    .describe(
      '员工已提交的验收凭证文件/图片/视频 URL 列表（来自任务凭证评论），挂教程视频等用途直接取用',
    ),
  tutorialOutput: TUTORIAL_OUTPUT_SCHEMA.nullable().describe(
    '该任务已产出的教程结构（教程制作任务才有）；null=尚未产出教程',
  ),
};

export const TaskHistoryInput = {
  keyword: z
    .string()
    .optional()
    .describe(
      '搜索关键词：纯数字时按任务序号精确匹配，否则按标题包含匹配；提供时优先于日期范围',
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional()
    .describe('基准日期 YYYY-MM-DD，不传默认今天'),
  scope: z
    .enum(['day', 'week', 'month'])
    .default('day')
    .describe('时间范围：day=基准日当天、week=所在自然周（周一起算）、month=所在自然月'),
};

export const TaskHistoryOutput = {
  bound: z.boolean().describe('员工是否已绑定 Plane 账号'),
  total: z.number().describe('命中的任务总数'),
  items: z
    .array(
      z.object({
        completedAt: z.string().nullable().describe('完成日期'),
        sequenceId: z.number().nullable().describe('任务序号'),
        title: z.string().describe('任务标题'),
        rewardAmount: z.number().nullable().describe('委派额外奖励金额（元）'),
        estimatedEarning: z.number().nullable().describe('绩效估算金额（元）'),
      }),
    )
    .describe('已完成任务列表，按完成日期降序'),
};

@McpTools({ prefix: 'task_' })
export class EmployeeTasksMcpTools {
  constructor(
    private readonly tasks: TasksService,
    private readonly tutorialOutputService: TutorialOutputService,
  ) {}

  @McpTool({
    title: '查看今日任务',
    description:
      '查询当前员工的今日工作概览：待办（open）任务列表（含逾期与严重堵塞标识）、今日已完成任务、进行中的教程任务、游戏化摘要（今日完成数/总数、连续天数、本月钱包）。员工问「今天有什么任务」「我今天要做什么」「任务多不多」时先调用本工具；需要某任务的详细做法时，用返回的 openTasks[].id 调 task_detail。只返回本人任务，无需入参。员工未绑定 Plane 时 bound=false 且列表为空，应提示其在泛亚工作台「我的」里完成绑定。',
    inputSchema: {},
    outputSchema: TaskListTodayOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async list_today(
    _input: Record<string, never>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof TaskListTodayOutput>> {
    const userId: string = ctx.user.userId!;
    const overview = await this.tasks.getOverview(userId);
    const today = todayDateString();
    const doneToday = overview.doneTasks
      .filter((t: TaskSummary) => t.completedAt === today)
      .map((t: TaskSummary) => ({ title: t.title, completedAt: t.completedAt }));
    return {
      structuredContent: {
        bound: overview.bound,
        today,
        openTasks: overview.openTasks.map((t: TaskSummary) => ({
          id: t.id,
          sequenceId: t.sequenceId,
          title: t.title,
          statusLabel: t.statusLabel,
          deadline: t.deadline,
          deadlineTime: t.deadlineTime,
          severeBlocked: t.severeBlocked,
          rewardAmount: t.rewardAmount,
          estimatedEarning: t.estimatedEarning,
          taskType: t.taskType,
          projectName: t.projectName,
          currentAction: t.currentAction,
        })),
        doneToday,
        tutorialTasks: overview.tutorialTasks.map((t: TutorialTask) => ({
          caseId: t.caseId,
          title: t.title,
          currentStageTitle: t.currentStageTitle ?? null,
          progress: t.progress,
          stepsDone: t.stepsDone ?? null,
          stepsTotal: t.stepsTotal ?? null,
          severeBlocked: t.severeBlocked,
          blockedReason: t.blockedReason,
          overdueDays: t.overdueDays,
          rewardScore: t.rewardScore,
          rewardAmount: t.rewardAmount,
        })),
        gamification: {
          todayDone: overview.gamification.todayDone,
          todayTotal: overview.gamification.todayTotal,
          streakDays: overview.gamification.streakDays,
          walletMonth: overview.gamification.walletMonth,
        },
      },
      content: [
        {
          type: 'text',
          text: `今日 ${overview.openTasks.length} 条待办、已完成 ${doneToday.length} 条、教程任务 ${overview.tutorialTasks.length} 个`,
        },
      ],
    };
  }

  @McpTool({
    title: '查看任务详情',
    description:
      '查询单个任务的详情：标题、状态、项目、截止、当前动作（currentAction，员工接下来该做什么）、提交材料要求（evidenceSummary）、验收条件清单（含是否已提交）、委派额外奖励。员工问「这个任务怎么做」「要交什么材料」「验收条件是什么」时调用；taskId 来自 task_list_today 返回的 openTasks[].id。任务不存在时返回错误 code TASK_NOT_FOUND，应先用 task_list_today 重新获取有效 taskId。',
    inputSchema: TaskDetailInput,
    outputSchema: TaskDetailOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async detail(
    input: Infer<typeof TaskDetailInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TaskDetailOutput>> {
    let detail;
    try {
      detail = await this.tasks.getDetail(input.taskId);
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        throw new McpToolError(
          '任务不存在，先用 task_list_today 查有效 taskId',
          { code: 'TASK_NOT_FOUND' },
        );
      }
      throw error;
    }
    const task = detail.task;
    const tutorialOutput = await this.tutorialOutputService.getByTaskId(
      task.id,
    );
    return {
      structuredContent: {
        taskId: task.id,
        title: task.title,
        statusLabel: task.statusLabel,
        projectName: task.projectName,
        deadline: task.deadline,
        deadlineTime: task.deadlineTime,
        severeBlocked: task.severeBlocked,
        taskType: task.taskType,
        currentAction: task.currentAction,
        evidenceSummary: task.evidenceSummary,
        evidenceChecklist: detail.evidenceChecklist.map(
          (item: { name: string; submitted: boolean }) => ({
            name: item.name,
            submitted: item.submitted,
          }),
        ),
        rewardAmount: task.taskType === 'delegated' ? task.rewardAmount : null,
        evidenceFileUrls: detail.evidenceFileUrls,
        tutorialOutput,
      },
      content: [
        {
          type: 'text',
          text: `任务「${task.title}」（${task.statusLabel}）${
            task.currentAction ? `，当前动作：${task.currentAction}` : ''
          }${
            tutorialOutput
              ? `\n本任务已产出教程《${tutorialOutput.projectName}》：${tutorialOutput.stageCount} 个阶段 ${tutorialOutput.stepCount} 个步骤 ${tutorialOutput.videoCount} 个实操视频`
              : ''
          }`,
        },
      ],
    };
  }

  @McpTool({
    title: '查询历史完成任务',
    description:
      '查询当前员工历史已完成的任务（仅本人、非子任务）。支持三种检索：给 keyword（纯数字=按任务序号精确匹配，否则按标题包含，优先于日期范围）；给 date+scope 按时间范围查（scope=day 当天 / week 所在自然周（周一起算）/ month 所在月，默认 day，date 不传默认今天）；都不给则查今天。员工问「我之前做过什么」「上周完成了哪些任务」「#123 做完了吗」时调用。返回按完成日期降序的列表（完成日期、序号、标题、金额）与总数。',
    inputSchema: TaskHistoryInput,
    outputSchema: TaskHistoryOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async history(
    input: Infer<typeof TaskHistoryInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof TaskHistoryOutput>> {
    const userId: string = ctx.user.userId!;
    const history = await this.tasks.getHistory(userId, {
      date: input.date,
      scope: input.scope,
      keyword: input.keyword,
    });
    return {
      structuredContent: {
        bound: history.bound,
        total: history.total,
        items: history.items.map((t: TaskSummary) => ({
          completedAt: t.completedAt,
          sequenceId: t.sequenceId,
          title: t.title,
          rewardAmount: t.rewardAmount,
          estimatedEarning: t.estimatedEarning,
        })),
      },
      content: [
        {
          type: 'text',
          text: `共 ${history.total} 条已完成任务`,
        },
      ],
    };
  }
}
