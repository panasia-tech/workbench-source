import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';

import {
  TutorialContentService,
  type TutorialCourse,
  type TutorialOutline,
  type TutorialStage,
  type TutorialStep,
} from '@server/modules/profile/tutorial-content.service';
import type { TutorialMaterialDef } from '@server/modules/profile/tutorial-lesson-body';
import type {
  TutorialAuthoringCreateRequest,
  TutorialAuthoringCreateResponse,
  TutorialAuthoringListResponse,
  TutorialAuthoringMaterialView,
  TutorialAuthoringProjectView,
} from '@shared/api.interface';

function optional(value: string | undefined): string | null {
  return value && value.trim() !== '' ? value : null;
}

/** 工作台新建的教程课编号：wb- + 36 进制毫秒（迁移来的是 nocobase-<id>-<code>） */
function newCourseCode(): string {
  return `wb-${Date.now().toString(36)}`;
}

function toView(
  course: TutorialCourse,
  outline: TutorialOutline | null,
): TutorialAuthoringProjectView {
  const stages = outline?.stages ?? [];
  return {
    projectId: course.name,
    name: course.title,
    // 简介为空时建课用标题兜底，读回来等于标题的当没写
    description: course.intro && course.intro !== course.title ? course.intro : null,
    learningUrl: course.learningUrl,
    published: course.published,
    stageCount: stages.length,
    stepCount: outline?.steps.length ?? 0,
    stages: stages.map((stage: TutorialStage) => ({
      title: stage.title,
      description: stage.description,
      durationNote: stage.durationNote,
      steps: stage.steps.map((step: TutorialStep) => ({
        title: step.title,
        guide: step.guide,
        warnText: step.warnText,
        deliverNote: step.deliverNote,
        videoUrl: step.videoUrl,
        requireConfirm: step.requireConfirm,
        requireReview: step.requireReview,
        materials: step.materials.map(
          (material: TutorialMaterialDef): TutorialAuthoringMaterialView => ({
            label: material.label,
            inputType: material.inputType,
            required: material.required,
            helpText: material.helpText,
          }),
        ),
      })),
    })),
  };
}

/** 管理端「教程模板」：列表读 Learning 教程课，新建写 Learning（课程 → 章节 → 课时），中途失败整门课删掉 */
@Injectable()
export class TutorialAuthoringService {
  private readonly logger = new Logger(TutorialAuthoringService.name);

  constructor(private readonly content: TutorialContentService) {}

  async listProjects(): Promise<TutorialAuthoringListResponse> {
    const courses = await this.content.listCourses();
    const outlines = await this.content.getOutlines(
      courses.map((course: TutorialCourse) => course.name),
    );
    return {
      items: courses.map((course: TutorialCourse) =>
        toView(course, outlines.get(course.name) ?? null),
      ),
    };
  }

  async createProject(
    input: TutorialAuthoringCreateRequest,
  ): Promise<TutorialAuthoringCreateResponse> {
    // 标题规矩同 TutorialContentService（文档名不许 < >），先整份过一遍，免得建到一半才失败
    const titles = [
      input.name,
      ...input.stages.flatMap((stage) => [stage.title, ...stage.steps.map((step) => step.title)]),
    ];
    const bad = titles.find((title: string) => /[<>]/.test(title) || title.length > 120);
    if (bad !== undefined) {
      throw new BadRequestException(
        `「${bad.slice(0, 30)}」：标题里不能有 < >，也不能超过 120 个字（Learning 的章节、课时名不允许）`,
      );
    }
    const existing = await this.content.listCourses();
    if (existing.some((course: TutorialCourse) => course.title === input.name)) {
      throw new ConflictException(
        `教程「${input.name}」已存在，请换个名称或直接在原教程上调整`,
      );
    }

    const course = await this.content.createCourse({
      title: input.name,
      description: optional(input.description),
      code: newCourseCode(),
    });
    let stepCount = 0;
    let materialCount = 0;
    try {
      for (const [si, stage] of input.stages.entries()) {
        const chapter = await this.content.createStage(course.name, {
          title: stage.title,
          description: optional(stage.description),
          durationNote: optional(stage.durationNote),
        });
        for (const [pi, step] of stage.steps.entries()) {
          await this.content.createStep(course.name, chapter.name, {
            title: step.title,
            guide: optional(step.guide),
            warnText: optional(step.warnText),
            deliverNote: optional(step.deliverNote),
            videoUrl: optional(step.videoUrl),
            requireConfirm: step.requireConfirm === true,
            requireReview: step.requireReview === true,
            materials: step.materials.map((material, mi) => ({
              key: `m${si + 1}_${pi + 1}_${mi + 1}`,
              label: material.label,
              inputType: material.inputType,
              required: material.required === true,
              options: [],
              helpText: optional(material.helpText),
            })),
          });
          stepCount += 1;
          materialCount += step.materials.length;
        }
      }
    } catch (error) {
      this.logger.warn(
        `新建教程中途失败，整门课删掉 course=${course.name}：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.content.deleteCourse(course.name).catch((cleanupError: unknown) => {
        this.logger.error(
          `回滚删课失败，请到 Learning 手工删课程 ${course.name}：${String(cleanupError)}`,
        );
      });
      throw error;
    }

    this.logger.log(
      `教程模板创建完成 course=${course.name} name=${input.name}` +
        ` stages=${input.stages.length} steps=${stepCount} materials=${materialCount}`,
    );
    return {
      projectId: course.name,
      name: course.title,
      stageCount: input.stages.length,
      stepCount,
      materialCount,
    };
  }
}
