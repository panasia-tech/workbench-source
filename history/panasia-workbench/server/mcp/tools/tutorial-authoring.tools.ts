import { z } from 'zod';
import { Logger } from '@nestjs/common';
import {
  McpTools,
  McpTool,
  McpToolError,
  type Infer,
  type McpContext,
  type McpToolResult,
} from '@lark-apaas/fullstack-nestjs-core';
import { TutorialContentService } from '@server/modules/profile/tutorial-content.service';
import { TutorialOutputService } from '@server/modules/profile/tutorial-output.service';
import { runTutorialTool } from './tutorial-tool-errors';

/** 豆包新建的教程课编号（工作台后台建的是 wb-，迁移来的是 nocobase-） */
function newCourseCode(): string {
  return `authoring-${Date.now().toString(36)}`;
}

/** sort 从 1 开始；Learning 的插入位置从 0 开始，超出范围就追加到末尾 */
function toPosition(sort: number | undefined, count: number): number | undefined {
  if (sort === undefined || sort > count) return undefined;
  return Math.max(0, sort - 1);
}

export const TutorialCreateProjectInput = {
  title: z.string().min(1).describe('教程名称'),
  description: z.string().optional().describe('教程简介，可不填'),
  taskId: z
    .string()
    .optional()
    .describe('关联任务 ID，传了则建立映射，续作时直接返回已有教程'),
};

export const TutorialCreateProjectOutput = {
  projectId: z.string().describe('教程 ID（Learning 课程 name）'),
  created: z.boolean().describe('是否本次新建；false 表示命中已有映射直接返回'),
  title: z.string().describe('教程名称'),
};

export const TutorialCreateStageInput = {
  projectId: z.string().min(1).describe('教程 ID，来自 tutorial_create_project 或 tutorial_list_steps'),
  title: z.string().min(1).describe('阶段名称'),
  description: z.string().optional().describe('阶段说明，可不填'),
  sort: z.number().int().min(1).optional().describe('排第几个（从 1 开始），不传则追加到末尾'),
};

export const TutorialCreateStageOutput = {
  stageId: z.string().describe('新建阶段 ID（Learning 章节 name）'),
  projectId: z.string().describe('所属教程 ID'),
  title: z.string().describe('阶段名称'),
};

export const TutorialCreateStepInput = {
  stageId: z.string().min(1).describe('阶段 ID，来自 tutorial_create_stage 或 tutorial_list_steps'),
  title: z.string().min(1).describe('步骤名称'),
  guide: z
    .string()
    .optional()
    .describe('操作指引：员工可直接照做的具体步骤，一步一句，动作清晰'),
  warnText: z
    .string()
    .optional()
    .describe('易错点提醒：这一步最容易出错的地方，提前告知'),
  deliverNote: z
    .string()
    .optional()
    .describe('提交说明：学员提交材料时需要注意的事项'),
  requireReview: z
    .boolean()
    .optional()
    .describe('是否需老板审核后才能进入下一步；仅关键闸口步骤置 true'),
  requireConfirm: z
    .boolean()
    .optional()
    .describe('是否需要学员点确认已完成；默认 false'),
  sort: z.number().int().min(1).optional().describe('排第几个（从 1 开始），不传则追加到阶段末尾'),
};

export const TutorialCreateStepOutput = {
  stepId: z.string().describe('新建步骤 ID（课时上的步骤编号）'),
  stageId: z.string().describe('所属阶段 ID'),
  title: z.string().describe('步骤名称'),
};

export const TutorialSetStepVideoInput = {
  stepId: z.string().min(1).describe('步骤 ID，来自 tutorial_create_step 或 tutorial_list_steps'),
  videoUrl: z
    .string()
    .url()
    .describe('实操视频 URL，必须来自员工任务凭证（evidenceFileUrls），禁止编造'),
};

export const TutorialSetStepVideoOutput = {
  stepId: z.string().describe('步骤 ID'),
  videoUrl: z.string().describe('已设置的视频 URL'),
  updated: z.boolean().describe('是否更新成功'),
};

/** 教程生产 4 件：内容写进 Learning（课程 / 章节 / 课时 + pa_ 字段），任务↔教程映射存工作台库 */
@McpTools({ prefix: 'tutorial_' })
export class TutorialAuthoringMcpTools {
  private readonly logger = new Logger(TutorialAuthoringMcpTools.name);

  constructor(
    private readonly content: TutorialContentService,
    private readonly tutorialOutput: TutorialOutputService,
  ) {}

  @McpTool({
    title: '创建教程',
    description:
      '为员工的教程任务在 Learning 建一门教程课（幂等，传 taskId 续作直接返回已有）。' +
      '员工接受教程任务、开始产出教程内容时调用。title 是教程名；' +
      'taskId 必传以便建立任务与教程的映射，后续续作可直接命中。',
    inputSchema: TutorialCreateProjectInput,
    outputSchema: TutorialCreateProjectOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async create_project(
    input: Infer<typeof TutorialCreateProjectInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialCreateProjectOutput>> {
    if (input.taskId) {
      const link = await this.tutorialOutput.findLink(input.taskId);
      if (link) {
        this.logger.log(
          `教程命中已有映射 task=${input.taskId} course=${link.projectId}`,
        );
        return {
          structuredContent: {
            projectId: link.projectId,
            created: false,
            title: link.projectName,
          },
          content: [
            {
              type: 'text',
              text:
                `任务已关联教程「${link.projectName}」（ID: ${link.projectId}），` +
                '可继续在其上补充内容',
            },
          ],
        };
      }
    }
    const course = await runTutorialTool('PROJECT_NOT_FOUND', () =>
      this.content.createCourse({
        title: input.title,
        description: input.description ?? null,
        code: newCourseCode(),
      }),
    );
    if (input.taskId) {
      await this.tutorialOutput.linkTask(
        input.taskId,
        course.name,
        input.title,
        ctx.user.userId ?? '',
      );
    }
    this.logger.log(`新建教程课 course=${course.name} name=${input.title}`);
    return {
      structuredContent: {
        projectId: course.name,
        created: true,
        title: input.title,
      },
      content: [
        {
          type: 'text',
          text: `已在 Learning 创建教程「${input.title}」（ID: ${course.name}，默认不发布）`,
        },
      ],
    };
  }

  @McpTool({
    title: '创建教程阶段',
    description:
      '在指定教程下新建一个阶段（Learning 章节）。教程不存在时返回 PROJECT_NOT_FOUND。' +
      'sort 不传则自动追加到末尾。',
    inputSchema: TutorialCreateStageInput,
    outputSchema: TutorialCreateStageOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async create_stage(
    input: Infer<typeof TutorialCreateStageInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialCreateStageOutput>> {
    return runTutorialTool('PROJECT_NOT_FOUND', async () => {
      const outline = await this.content.getOutline(input.projectId);
      if (!outline) {
        throw new McpToolError(
          `教程 ${input.projectId} 不存在，先用 tutorial_list_steps 查有效 projectId`,
          { code: 'PROJECT_NOT_FOUND' },
        );
      }
      const stage = await this.content.createStage(
        outline.course.name,
        { title: input.title, description: input.description ?? null, durationNote: null },
        toPosition(input.sort, outline.stages.length),
      );
      return {
        structuredContent: {
          stageId: stage.name,
          projectId: outline.course.name,
          title: input.title,
        },
        content: [
          {
            type: 'text',
            text: `已在教程「${outline.course.title}」下创建阶段「${input.title}」`,
          },
        ],
      };
    });
  }

  @McpTool({
    title: '创建教程步骤',
    description:
      '在指定阶段下新建一个教程步骤（Learning 课时）。阶段不存在返回 STAGE_NOT_FOUND。' +
      'guide 写可直接照做的操作步骤（一步一句、动作清晰）；warnText 写易错点；' +
      'requireReview 仅关键闸口步骤置 true，其余步骤留默认 false。sort 不传则追加到阶段末尾。',
    inputSchema: TutorialCreateStepInput,
    outputSchema: TutorialCreateStepOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async create_step(
    input: Infer<typeof TutorialCreateStepInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialCreateStepOutput>> {
    return runTutorialTool('STAGE_NOT_FOUND', async () => {
      const found = await this.content.findStage(input.stageId);
      if (!found) {
        throw new McpToolError(
          `教程阶段 ${input.stageId} 不存在，先用 tutorial_list_steps 查有效 stageId`,
          { code: 'STAGE_NOT_FOUND' },
        );
      }
      const step = await this.content.createStep(
        found.outline.course.name,
        found.stage.name,
        {
          title: input.title,
          guide: input.guide ?? null,
          warnText: input.warnText ?? null,
          deliverNote: input.deliverNote ?? null,
          videoUrl: null,
          requireReview: input.requireReview ?? false,
          requireConfirm: input.requireConfirm ?? false,
          materials: [],
        },
        { position: toPosition(input.sort, found.stage.steps.length) },
      );
      return {
        structuredContent: {
          stepId: step.key,
          stageId: found.stage.name,
          title: input.title,
        },
        content: [
          {
            type: 'text',
            text: `已在阶段「${found.stage.title}」下创建步骤「${input.title}」（stepId: ${step.key}）`,
          },
        ],
      };
    });
  }

  @McpTool({
    title: '设置步骤实操视频',
    description:
      '给教程步骤挂上实操视频 URL（幂等，可重复调用覆盖），课时正文里的视频块同步更新。' +
      'videoUrl 必须来自员工在任务详情页上传的任务凭证（task_detail 的 evidenceFileUrls），' +
      '禁止编造或使用外部 URL。步骤不存在返回 STEP_NOT_FOUND。',
    inputSchema: TutorialSetStepVideoInput,
    outputSchema: TutorialSetStepVideoOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async set_step_video(
    input: Infer<typeof TutorialSetStepVideoInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialSetStepVideoOutput>> {
    return runTutorialTool('STEP_NOT_FOUND', async () => {
      const step = await this.content.updateStep(input.stepId, () => ({
        videoUrl: input.videoUrl,
      }));
      return {
        structuredContent: {
          stepId: input.stepId,
          videoUrl: input.videoUrl,
          updated: true,
        },
        content: [
          {
            type: 'text',
            text: `已为步骤「${step.title}」设置实操视频`,
          },
        ],
      };
    });
  }
}
