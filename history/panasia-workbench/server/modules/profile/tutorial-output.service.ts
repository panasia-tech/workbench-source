import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, inArray } from 'drizzle-orm';
import { tutorialTaskLinks } from '@server/database/schema';
import {
  TutorialContentService,
  type TutorialOutline,
  type TutorialStage,
  type TutorialStep,
} from './tutorial-content.service';
import type {
  TutorialTaskOutput,
  TutorialTaskStageOutput,
} from '@shared/api.interface';

type TaskLinkRow = typeof tutorialTaskLinks.$inferSelect;

/** 沿 cause 链（最多 4 层）提取 PostgreSQL SQLSTATE code */
function extractPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth += 1
  ) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

function baseOutput(projectId: string, projectName: string): TutorialTaskOutput {
  return {
    projectId,
    projectName,
    stageCount: 0,
    stepCount: 0,
    videoCount: 0,
    stages: [],
  };
}

/** 教程产出 = Learning 大纲：阶段 → 步骤，有没有视频看 pa_video_url */
function buildOutput(
  projectId: string,
  projectName: string,
  outline: TutorialOutline,
): TutorialTaskOutput {
  const stages: TutorialTaskStageOutput[] = outline.stages.map(
    (stage: TutorialStage) => ({
      title: stage.title,
      steps: stage.steps.map((step: TutorialStep) => ({
        title: step.title,
        hasVideo: step.videoUrl !== null && step.videoUrl.trim() !== '',
      })),
    }),
  );
  return {
    projectId,
    projectName,
    stageCount: stages.length,
    stepCount: outline.steps.length,
    videoCount: outline.steps.filter(
      (step: TutorialStep) => step.videoUrl !== null && step.videoUrl.trim() !== '',
    ).length,
    stages,
  };
}

@Injectable()
export class TutorialOutputService {
  private readonly logger = new Logger(TutorialOutputService.name);

  constructor(
    private readonly content: TutorialContentService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** 按任务 ID 取教程产出；无映射返回 null，Learning 读不到降级为基础信息 */
  async getByTaskId(taskId: string): Promise<TutorialTaskOutput | null> {
    const rows: TaskLinkRow[] = await this.db
      .select()
      .from(tutorialTaskLinks)
      .where(eq(tutorialTaskLinks.taskId, taskId))
      .limit(1);
    const link = rows[0];
    if (!link) return null;
    const outline = await this.content.getOutlineSafe(link.lmsCourse);
    if (!outline) {
      this.logger.warn(`教程产出查询失败（task=${taskId}），降级返回基础信息`);
      return baseOutput(link.lmsCourse, link.projectName);
    }
    return buildOutput(link.lmsCourse, link.projectName, outline);
  }

  /** 批量按任务 ID 取教程产出映射；一次 db 查询 + 每门课一次大纲（60 秒缓存），禁 N+1 */
  async getByTaskIds(
    taskIds: string[],
  ): Promise<Map<string, TutorialTaskOutput>> {
    const result = new Map<string, TutorialTaskOutput>();
    if (taskIds.length === 0) return result;
    const rows: TaskLinkRow[] = await this.db
      .select()
      .from(tutorialTaskLinks)
      .where(inArray(tutorialTaskLinks.taskId, taskIds));
    if (rows.length === 0) return result;
    const outlines = await this.content.getOutlines(
      rows.map((row: TaskLinkRow) => row.lmsCourse),
    );
    for (const row of rows) {
      const outline = outlines.get(row.lmsCourse);
      result.set(
        row.taskId,
        outline
          ? buildOutput(row.lmsCourse, row.projectName, outline)
          : baseOutput(row.lmsCourse, row.projectName),
      );
    }
    return result;
  }

  /** 建立任务与教程课（Learning 课程 name）的映射；重复关联（23505）幂等忽略 */
  async linkTask(
    taskId: string,
    lmsCourse: string,
    projectName: string,
    userId: string,
  ): Promise<void> {
    void userId; // 审计列暂不写入，保留参数
    try {
      await this.db.insert(tutorialTaskLinks).values({
        taskId,
        lmsCourse,
        projectName,
      });
    } catch (error) {
      if (extractPostgresErrorCode(error) === '23505') return;
      throw error;
    }
  }

  /** 查任务的教程映射 */
  async findLink(
    taskId: string,
  ): Promise<{ projectId: string; projectName: string } | null> {
    const rows: { lmsCourse: string; projectName: string }[] = await this.db
      .select({
        lmsCourse: tutorialTaskLinks.lmsCourse,
        projectName: tutorialTaskLinks.projectName,
      })
      .from(tutorialTaskLinks)
      .where(eq(tutorialTaskLinks.taskId, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { projectId: row.lmsCourse, projectName: row.projectName };
  }
}
