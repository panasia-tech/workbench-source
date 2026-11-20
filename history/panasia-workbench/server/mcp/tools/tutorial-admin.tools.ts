import { z } from 'zod';
import {
  McpTools,
  McpTool,
  McpToolError,
  type Infer,
  type McpContext,
  type McpToolResult,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  TutorialContentService,
  type TutorialCourse,
  type TutorialStage,
  type TutorialStep,
} from '@server/modules/profile/tutorial-content.service';
import {
  MATERIAL_KEY_PATTERN,
  type TutorialMaterialDef,
} from '@server/modules/profile/tutorial-lesson-body';
import { runTutorialTool } from './tutorial-tool-errors';

export const TutorialListStepsOutput = {
  projects: z.array(
    z.object({
      id: z.string().describe('教程 ID（Learning 课程 name）'),
      name: z.string().describe('教程名称'),
      stages: z.array(
        z.object({
          id: z.string().describe('阶段 ID（Learning 章节 name）'),
          title: z.string().describe('阶段名称'),
          sort: z.number().nullable(),
          steps: z.array(
            z.object({
              id: z.string().describe('步骤 ID（课时上的步骤编号）'),
              title: z.string().describe('步骤名称'),
              sort: z.number().nullable(),
              requireReview: z.boolean().describe('是否需审核后进下一步'),
              formFieldCount: z.number().describe('该步骤提交表单的字段数'),
            }),
          ),
        }),
      ),
    }),
  ),
};

export const TutorialListFormFieldsInput = {
  stepId: z.string().min(1).describe('步骤 ID，来自 tutorial_list_steps 的 steps[].id'),
};

export const TutorialListFormFieldsOutput = {
  stepId: z.string(),
  stepTitle: z.string().describe('步骤名称'),
  fields: z.array(
    z.object({
      sort: z.number().describe('在表单里排第几个（从 1 开始）'),
      label: z.string().describe('字段显示名称'),
      materialKey: z.string().describe('字段英文键名'),
      inputType: z.string().describe('输入类型'),
      required: z.boolean().describe('是否必填'),
    }),
  ),
};

export const TutorialAddFormFieldInput = {
  stepId: z
    .string()
    .min(1)
    .describe('步骤 ID，来自 tutorial_list_steps 的 steps[].id'),
  label: z
    .string()
    .min(1)
    .describe('字段显示名称，如「上传营业执照照片」'),
  materialKey: z
    .string()
    .regex(MATERIAL_KEY_PATTERN)
    .describe('字段英文键名：小写字母开头，仅小写字母、数字、下划线'),
  inputType: z
    .enum(['image', 'text', 'textarea', 'date', 'video'])
    .describe(
      '输入类型：image=图片上传、text=单行文本、textarea=多行文本、date=日期、video=视频上传',
    ),
  required: z.boolean().default(true).describe('是否必填'),
  helpText: z.string().optional().describe('填写说明，可不填'),
};

export const TutorialAddFormFieldOutput = {
  stepId: z.string(),
  sort: z.number().describe('新字段排第几个（加在末尾）'),
  label: z.string(),
  materialKey: z.string(),
};

export const TutorialRemoveFormFieldInput = {
  stepId: z
    .string()
    .min(1)
    .describe('步骤 ID，来自 tutorial_list_steps 的 steps[].id'),
  materialKey: z
    .string()
    .describe('要删除的字段英文键名，来自 tutorial_list_form_fields 的 fields[].materialKey'),
  confirm: z
    .literal(true)
    .describe(
      '删除前必须先向员工确认「将删除该表单字段，已提交的凭证数据不再展示」，确认后传 true',
    ),
};

export const TutorialRemoveFormFieldOutput = {
  removed: z.boolean(),
  materialKey: z.string(),
};

/** 教程表单字段 4 件：结构从 Learning 读；材料字段改写课时的 pa_materials（带 modified，别人刚改过就拒写） */
@McpTools({ prefix: 'tutorial_' })
export class TutorialAdminMcpTools {
  constructor(private readonly content: TutorialContentService) {}

  @McpTool({
    title: '查看教程步骤',
    description:
      '列出 Learning 里全部教程、阶段与步骤，以及每个步骤的提交表单字段数。员工想了解教程结构、或要修改某步骤表单前，先调用本工具找到目标步骤的 stepId。',
    inputSchema: {},
    outputSchema: TutorialListStepsOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async list_steps(
    _input: Record<string, never>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialListStepsOutput>> {
    return runTutorialTool('PROJECT_NOT_FOUND', async () => {
      const courses = await this.content.listCourses();
      if (courses.length === 0) {
        return {
          structuredContent: { projects: [] },
          content: [{ type: 'text', text: 'Learning 里暂无教程' }],
        };
      }
      const outlines = await this.content.getOutlines(
        courses.map((course: TutorialCourse) => course.name),
      );
      let stageCount = 0;
      let stepCount = 0;
      const projects = courses.map((course: TutorialCourse) => {
        const stages = outlines.get(course.name)?.stages ?? [];
        stageCount += stages.length;
        return {
          id: course.name,
          name: course.title,
          stages: stages.map((stage: TutorialStage) => {
            stepCount += stage.steps.length;
            return {
              id: stage.name,
              title: stage.title,
              sort: stage.sort,
              steps: stage.steps.map((step: TutorialStep) => ({
                id: step.key,
                title: step.title,
                sort: step.sort,
                requireReview: step.requireReview,
                formFieldCount: step.materials.length,
              })),
            };
          }),
        };
      });
      return {
        structuredContent: { projects },
        content: [
          {
            type: 'text',
            text: `共 ${projects.length} 个教程、${stageCount} 个阶段、${stepCount} 个步骤`,
          },
        ],
      };
    });
  }

  @McpTool({
    title: '查看步骤表单字段',
    description:
      '列出指定教程步骤提交表单的全部字段（显示名称、英文键名、输入类型、是否必填）。员工想看某步骤表单有哪些字段、或删除字段前确认键名时调用。stepId 来自 tutorial_list_steps。',
    inputSchema: TutorialListFormFieldsInput,
    outputSchema: TutorialListFormFieldsOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async list_form_fields(
    input: Infer<typeof TutorialListFormFieldsInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialListFormFieldsOutput>> {
    return runTutorialTool('STEP_NOT_FOUND', async () => {
      const found = await this.content.findStep(input.stepId);
      if (!found) {
        throw new McpToolError(
          `步骤 ${input.stepId} 不存在，先用 tutorial_list_steps 查有效 stepId`,
          { code: 'STEP_NOT_FOUND' },
        );
      }
      const { step } = found;
      return {
        structuredContent: {
          stepId: step.key,
          stepTitle: step.title,
          fields: step.materials.map((material: TutorialMaterialDef, index: number) => ({
            sort: index + 1,
            label: material.label,
            materialKey: material.key,
            inputType: material.inputType,
            required: material.required,
          })),
        },
        content: [
          {
            type: 'text',
            text: `步骤「${step.title}」共 ${step.materials.length} 个表单字段`,
          },
        ],
      };
    });
  }

  @McpTool({
    title: '新增步骤表单字段',
    description:
      '给教程步骤的提交表单新增一个字段（如让员工多上传一张凭证图片、多填一项文本）。员工说「教程第 X 步加一个 XX 字段」时调用；stepId 来自 tutorial_list_steps，materialKey 用小写英文下划线。键名重复时返回 MATERIAL_KEY_EXISTS。重复添加同键名不会成功，需换键名。',
    inputSchema: TutorialAddFormFieldInput,
    outputSchema: TutorialAddFormFieldOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async add_form_field(
    input: Infer<typeof TutorialAddFormFieldInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialAddFormFieldOutput>> {
    return runTutorialTool('STEP_NOT_FOUND', async () => {
      const step = await this.content.updateStep(input.stepId, (current: TutorialStep) => {
        if (current.materials.some((material: TutorialMaterialDef) => material.key === input.materialKey)) {
          throw new McpToolError(
            `步骤「${current.title}」已存在键名 ${input.materialKey}，请换一个键名`,
            { code: 'MATERIAL_KEY_EXISTS' },
          );
        }
        return {
          materials: [
            ...current.materials,
            {
              key: input.materialKey,
              label: input.label,
              inputType: input.inputType,
              required: input.required,
              options: [],
              helpText: input.helpText ?? null,
            },
          ],
        };
      });
      return {
        structuredContent: {
          stepId: input.stepId,
          sort: step.materials.length,
          label: input.label,
          materialKey: input.materialKey,
        },
        content: [
          {
            type: 'text',
            text: `已在步骤「${step.title}」新增字段「${input.label}」（${input.materialKey}）`,
          },
        ],
      };
    });
  }

  @McpTool({
    title: '删除步骤表单字段',
    description:
      '删除教程步骤提交表单中的一个字段。仅当员工明确要求删除、且已向其确认「删除后已提交的凭证数据不再展示」并得到同意（confirm=true）时调用。stepId 来自 tutorial_list_steps，materialKey 来自 tutorial_list_form_fields。字段不存在返回 MATERIAL_NOT_FOUND。',
    inputSchema: TutorialRemoveFormFieldInput,
    outputSchema: TutorialRemoveFormFieldOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async remove_form_field(
    input: Infer<typeof TutorialRemoveFormFieldInput>,
    _ctx: McpContext,
  ): Promise<McpToolResult<typeof TutorialRemoveFormFieldOutput>> {
    return runTutorialTool('STEP_NOT_FOUND', async () => {
      let removedLabel = '';
      await this.content.updateStep(input.stepId, (current: TutorialStep) => {
        const target = current.materials.find(
          (material: TutorialMaterialDef) => material.key === input.materialKey,
        );
        if (!target) {
          throw new McpToolError(
            `步骤 ${input.stepId} 下不存在键名 ${input.materialKey}，先用 tutorial_list_form_fields 核对`,
            { code: 'MATERIAL_NOT_FOUND' },
          );
        }
        removedLabel = target.label;
        return {
          materials: current.materials.filter(
            (material: TutorialMaterialDef) => material.key !== input.materialKey,
          ),
        };
      });
      return {
        structuredContent: { removed: true, materialKey: input.materialKey },
        content: [
          {
            type: 'text',
            text: `已删除字段 ${input.materialKey}（${removedLabel}）`,
          },
        ],
      };
    });
  }
}
