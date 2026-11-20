import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { asc, eq, inArray } from 'drizzle-orm';

import { okrKeyResults, okrObjectives } from '@server/database/schema';
import { AuditService } from '@server/modules/integration/audit.service';
import type {
  AdminOkrListResponse,
  OkrKeyResultCreateRequest,
  OkrKeyResultItem,
  OkrKeyResultPatchRequest,
  OkrMutationResponse,
  OkrObjectiveCreateRequest,
  OkrObjectiveItem,
  OkrObjectivePatchRequest,
  OkrObjectiveStatus,
} from '@shared/api.interface';

type ObjectiveRow = typeof okrObjectives.$inferSelect;
type KeyResultRow = typeof okrKeyResults.$inferSelect;

const OBJECTIVE_STATUSES: OkrObjectiveStatus[] = [
  'on_track',
  'at_risk',
  'behind',
  'completed',
];

function assertNumericString(value: string, field: string): void {
  if (!Number.isFinite(Number(value))) {
    throw new BadRequestException(`${field} 必须是有效数字`);
  }
}

@Injectable()
export class OkrService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<AdminOkrListResponse> {
    const objectiveRows: ObjectiveRow[] = await this.db
      .select()
      .from(okrObjectives)
      .orderBy(
        asc(okrObjectives.period),
        asc(okrObjectives.sort),
        asc(okrObjectives.createdAt),
      );

    const periods: string[] = [];
    for (const row of objectiveRows) {
      if (!periods.includes(row.period)) periods.push(row.period);
    }

    const objectiveIds: string[] = objectiveRows.map(
      (row: ObjectiveRow) => row.id,
    );
    const keyResultRows: KeyResultRow[] =
      objectiveIds.length > 0
        ? await this.db
            .select()
            .from(okrKeyResults)
            .where(inArray(okrKeyResults.objectiveId, objectiveIds))
            .orderBy(asc(okrKeyResults.sort), asc(okrKeyResults.createdAt))
        : [];

    const keyResultsByObjective = new Map<string, KeyResultRow[]>();
    for (const row of keyResultRows) {
      const group = keyResultsByObjective.get(row.objectiveId) ?? [];
      group.push(row);
      keyResultsByObjective.set(row.objectiveId, group);
    }

    const objectives: OkrObjectiveItem[] = objectiveRows.map(
      (row: ObjectiveRow): OkrObjectiveItem => ({
        id: row.id,
        period: row.period,
        title: row.title,
        status: (OBJECTIVE_STATUSES as string[]).includes(row.status)
          ? (row.status as OkrObjectiveStatus)
          : 'on_track',
        sort: row.sort,
        keyResults: (keyResultsByObjective.get(row.id) ?? []).map(
          (kr: KeyResultRow): OkrKeyResultItem => ({
            id: kr.id,
            objectiveId: kr.objectiveId,
            title: kr.title,
            unit: kr.unit,
            targetValue: kr.targetValue,
            currentValue: kr.currentValue,
            sort: kr.sort,
          }),
        ),
      }),
    );

    return { periods, objectives };
  }

  async createObjective(
    operatorId: string,
    dto: OkrObjectiveCreateRequest,
  ): Promise<OkrMutationResponse> {
    const inserted = await this.db
      .insert(okrObjectives)
      .values({ period: dto.period, title: dto.title })
      .returning({ id: okrObjectives.id });
    const id = inserted[0].id;

    await this.auditService.log({
      action: 'okr.objective.create',
      operatorId,
      targetType: 'okr_objective',
      targetId: id,
      detail: { summary: '新建 OKR 目标', changes: { ...dto } },
    });
    return { id };
  }

  async patchObjective(
    operatorId: string,
    id: string,
    dto: OkrObjectivePatchRequest,
  ): Promise<OkrMutationResponse> {
    const patch: Partial<typeof okrObjectives.$inferInsert> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.sort !== undefined) patch.sort = dto.sort;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }

    const updated = await this.db
      .update(okrObjectives)
      .set(patch)
      .where(eq(okrObjectives.id, id))
      .returning({ id: okrObjectives.id });
    if (updated.length === 0) {
      throw new NotFoundException('目标不存在');
    }

    await this.auditService.log({
      action: 'okr.objective.update',
      operatorId,
      targetType: 'okr_objective',
      targetId: id,
      detail: { summary: '更新 OKR 目标', changes: { ...patch } },
    });
    return { id };
  }

  async deleteObjective(
    operatorId: string,
    id: string,
  ): Promise<OkrMutationResponse> {
    // 关键结果由数据库外键 ON DELETE CASCADE 级联删除
    const deleted = await this.db
      .delete(okrObjectives)
      .where(eq(okrObjectives.id, id))
      .returning({ id: okrObjectives.id });
    if (deleted.length === 0) {
      throw new NotFoundException('目标不存在');
    }

    await this.auditService.log({
      action: 'okr.objective.delete',
      operatorId,
      targetType: 'okr_objective',
      targetId: id,
      detail: { summary: '删除 OKR 目标（其下关键结果按外键级联删除）' },
    });
    return { id };
  }

  async createKeyResult(
    operatorId: string,
    objectiveId: string,
    dto: OkrKeyResultCreateRequest,
  ): Promise<OkrMutationResponse> {
    const objective = await this.db
      .select({ id: okrObjectives.id })
      .from(okrObjectives)
      .where(eq(okrObjectives.id, objectiveId));
    if (objective.length === 0) {
      throw new NotFoundException('目标不存在');
    }

    const targetValue = dto.targetValue ?? '0';
    assertNumericString(targetValue, '目标值');

    const inserted = await this.db
      .insert(okrKeyResults)
      .values({
        objectiveId,
        title: dto.title,
        unit: dto.unit ?? null,
        targetValue,
        currentValue: '0',
        sort: 0,
      })
      .returning({ id: okrKeyResults.id });
    const id = inserted[0].id;

    await this.auditService.log({
      action: 'okr.key_result.create',
      operatorId,
      targetType: 'okr_key_result',
      targetId: id,
      detail: {
        summary: '新建关键结果',
        changes: { ...dto, objectiveId },
      },
    });
    return { id };
  }

  async patchKeyResult(
    operatorId: string,
    id: string,
    dto: OkrKeyResultPatchRequest,
  ): Promise<OkrMutationResponse> {
    const patch: Partial<typeof okrKeyResults.$inferInsert> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.unit !== undefined) patch.unit = dto.unit;
    if (dto.targetValue !== undefined) {
      assertNumericString(dto.targetValue, '目标值');
      patch.targetValue = dto.targetValue;
    }
    if (dto.currentValue !== undefined) {
      assertNumericString(dto.currentValue, '当前值');
      patch.currentValue = dto.currentValue;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }

    const updated = await this.db
      .update(okrKeyResults)
      .set(patch)
      .where(eq(okrKeyResults.id, id))
      .returning({ id: okrKeyResults.id });
    if (updated.length === 0) {
      throw new NotFoundException('关键结果不存在');
    }

    await this.auditService.log({
      action: 'okr.key_result.update',
      operatorId,
      targetType: 'okr_key_result',
      targetId: id,
      detail: { summary: '更新关键结果', changes: { ...patch } },
    });
    return { id };
  }

  async deleteKeyResult(
    operatorId: string,
    id: string,
  ): Promise<OkrMutationResponse> {
    const deleted = await this.db
      .delete(okrKeyResults)
      .where(eq(okrKeyResults.id, id))
      .returning({ id: okrKeyResults.id });
    if (deleted.length === 0) {
      throw new NotFoundException('关键结果不存在');
    }

    await this.auditService.log({
      action: 'okr.key_result.delete',
      operatorId,
      targetType: 'okr_key_result',
      targetId: id,
      detail: { summary: '删除关键结果' },
    });
    return { id };
  }
}
