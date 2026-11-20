import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { tutorialCases, tutorialStepSubmissions } from '@server/database/schema';
import { AuditService } from '../integration/audit.service';
import { NotifyService } from '../integration/notify.service';
import {
  TutorialCaseService,
  composeCaseTitle,
  parseSubmissionData,
  type TutorialCaseRow,
  type TutorialSubmissionRow,
} from './tutorial-case.service';
import {
  TutorialContentService,
  type TutorialStage,
  type TutorialStep,
} from './tutorial-content.service';
import type { TutorialMaterialDef } from './tutorial-lesson-body';
import type {
  TutorialReviewItem,
  TutorialReviewListResponse,
  TutorialReviewMaterial,
  TutorialReviewVerdictRequest,
  TutorialReviewVerdictResponse,
} from '@shared/api.interface';

const FILE_INPUT_TYPES = new Set<string>(['image', 'video', 'file']);

function materialValueToStrings(
  inputType: string,
  value: unknown,
): string[] {
  if (FILE_INPUT_TYPES.has(inputType)) {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v: unknown): v is string => typeof v === 'string' && v !== '',
    );
  }
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    return value.trim() === '' ? [] : [value];
  }
  return [String(value)];
}

/** 读不到材料定义时（Learning 连不上 / 步骤被删）按交上来的键原样列出，老板照样能看能审 */
function rawMaterials(data: Record<string, unknown>): TutorialReviewMaterial[] {
  return Object.entries(data).map(([key, value]) => {
    const type = Array.isArray(value) ? 'file' : 'text';
    return { key, name: key, type, value: materialValueToStrings(type, value) };
  });
}

interface PendingRow {
  sub: TutorialSubmissionRow;
  kase: TutorialCaseRow;
}

/** 管理端教程审核：待审列表与审核结论都读写工作台库，步骤标题、材料定义从 Learning 取 */
@Injectable()
export class TutorialReviewService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly content: TutorialContentService,
    private readonly tutorialCaseService: TutorialCaseService,
    private readonly auditService: AuditService,
    private readonly notifyService: NotifyService,
  ) {}

  async listPending(): Promise<TutorialReviewListResponse> {
    const rows: PendingRow[] = await this.db
      .select({ sub: tutorialStepSubmissions, kase: tutorialCases })
      .from(tutorialStepSubmissions)
      .innerJoin(tutorialCases, eq(tutorialStepSubmissions.caseId, tutorialCases.id))
      .where(
        and(
          eq(tutorialStepSubmissions.status, 'submitted'),
          ne(tutorialCases.status, 'cancelled'),
        ),
      )
      .orderBy(asc(tutorialStepSubmissions.submittedAt));
    if (rows.length === 0) return { items: [] };

    const outlines = await this.content.getOutlines(
      rows.map((row: PendingRow) => row.kase.lmsCourse),
    );
    const items: TutorialReviewItem[] = rows.map(({ sub, kase }: PendingRow) => {
      const outline = outlines.get(kase.lmsCourse);
      const stage = outline?.stages.find((item: TutorialStage) =>
        item.steps.some((step: TutorialStep) => step.key === sub.stepKey),
      );
      const step = stage?.steps.find((item: TutorialStep) => item.key === sub.stepKey);
      const data = parseSubmissionData(sub.data);
      const projectName = outline?.course.title ?? '';
      return {
        submissionId: sub.id,
        caseId: kase.id,
        caseTitle: composeCaseTitle(projectName || null, kase.clientName),
        projectName,
        stageTitle: stage?.title ?? '',
        stepId: sub.stepKey,
        stepTitle: step?.title ?? '',
        stepSort: step?.sort ?? 0,
        ownerUserId: kase.ownerUserId,
        submittedAt: sub.submittedAt ? sub.submittedAt.toISOString() : '',
        materials: step
          ? step.materials.map(
              (material: TutorialMaterialDef): TutorialReviewMaterial => ({
                key: material.key,
                name: material.label || material.key,
                type: material.inputType,
                value: materialValueToStrings(material.inputType, data[material.key]),
              }),
            )
          : rawMaterials(data),
      };
    });
    return { items };
  }

  async submitVerdict(
    operatorId: string,
    submissionId: number,
    dto: TutorialReviewVerdictRequest,
  ): Promise<TutorialReviewVerdictResponse> {
    const rows: PendingRow[] = await this.db
      .select({ sub: tutorialStepSubmissions, kase: tutorialCases })
      .from(tutorialStepSubmissions)
      .innerJoin(tutorialCases, eq(tutorialStepSubmissions.caseId, tutorialCases.id))
      .where(eq(tutorialStepSubmissions.id, submissionId))
      .limit(1);
    const found = rows[0];
    if (!found) throw new NotFoundException('提交记录不存在');
    const { sub: submission, kase } = found;
    if (submission.status !== 'submitted') {
      throw new ConflictException('该提交不在待审核状态');
    }

    const comment = dto.comment?.trim() ?? '';
    if (dto.action === 'rejected' && comment === '') {
      throw new BadRequestException('打回时必须填写打回意见');
    }

    const now = new Date();
    // 带状态条件写：两个人同时审，后到的不覆盖先到的
    const updated = await this.db
      .update(tutorialStepSubmissions)
      .set({
        status: dto.action,
        reviewedAt: now,
        reviewNote: comment !== '' ? comment : null,
        reviewedBy: operatorId,
        updatedAt: now,
      })
      .where(
        and(
          eq(tutorialStepSubmissions.id, submissionId),
          eq(tutorialStepSubmissions.status, 'submitted'),
        ),
      )
      .returning({ id: tutorialStepSubmissions.id });
    if (updated.length === 0) {
      throw new ConflictException('该提交不在待审核状态');
    }

    const outline = await this.content.getOutlineSafe(kase.lmsCourse);
    const caseTitle = composeCaseTitle(outline?.course.title ?? null, kase.clientName);
    const stepTitle =
      outline?.steps.find((step: TutorialStep) => step.key === submission.stepKey)?.title ??
      '步骤';

    if (dto.action === 'approved') {
      if (outline) {
        await this.tutorialCaseService.syncCaseProgress(kase, outline);
      }
      await this.auditService.log({
        action: 'tutorial_review_approve',
        operatorId,
        targetType: 'tutorial_submission',
        targetId: String(submissionId),
        detail: { summary: `${stepTitle} 审核通过` },
      });
    } else {
      await this.notifyService.sendToUsers(
        [kase.ownerUserId],
        '教程材料被打回',
        `案例《${caseTitle}》步骤「${stepTitle}」材料被打回：${comment}，请重新提交或跳过`,
        { category: 'tutorial', link: `/my/learning/case/${kase.id}` },
      );
      await this.auditService.log({
        action: 'tutorial_review_reject',
        operatorId,
        targetType: 'tutorial_submission',
        targetId: String(submissionId),
        detail: { summary: `${stepTitle} 审核打回：${comment}` },
      });
    }

    return { submissionId, status: dto.action };
  }
}
