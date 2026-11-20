import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { employeeBindings } from '@server/database/schema';
import { BindingService } from '../integration/binding.service';
import type {
  AdminPerformanceDetailResponse,
  AdminPerformanceEmployee,
  AdminPerformanceEmployeeListResponse,
} from '@shared/api.interface';
import { PerformanceService } from './performance.service';

@Injectable()
export class AdminPerformanceService {
  private readonly logger = new Logger(AdminPerformanceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly bindingService: BindingService,
    private readonly performanceService: PerformanceService,
  ) {}

  async listEmployees(): Promise<AdminPerformanceEmployeeListResponse> {
    const rows = await this.db
      .select({
        miaodaUserId: employeeBindings.miaodaUserId,
        planeMemberName: employeeBindings.planeMemberName,
        role: employeeBindings.role,
      })
      .from(employeeBindings);

    const items: AdminPerformanceEmployee[] = await Promise.all(
      rows.map(async (row) => {
        let latestTotalScore: number | null = null;
        let latestGrade: string | null = null;
        let latestCycleName: string | null = null;
        try {
          const overview = await this.performanceService.getPerformanceOverview(
            row.miaodaUserId,
          );
          const cycles = overview.cycles ?? [];
          const latest =
            cycles.find((c) => c.id === overview.currentCycleId) ??
            cycles[cycles.length - 1] ??
            null;
          if (latest) {
            latestTotalScore = latest.score;
            latestGrade = latest.ratingLabel;
            latestCycleName = latest.name;
          }
        } catch (error) {
          // Frappe 单员工失败不拖挂整个列表，三项置空降级
          this.logger.warn(
            `员工 ${row.miaodaUserId} 绩效概览获取失败，已降级为空: ${JSON.stringify(
              error instanceof Error ? error.message : error,
            )}`,
          );
        }
        return {
          userId: row.miaodaUserId,
          name: row.planeMemberName ?? row.miaodaUserId,
          planeMemberName: row.planeMemberName,
          role: row.role,
          latestTotalScore,
          latestGrade,
          latestCycleName,
        };
      }),
    );
    return { items };
  }

  async getDetail(userId: string): Promise<AdminPerformanceDetailResponse> {
    const binding = await this.bindingService.getBinding(userId);
    if (!binding) {
      throw new NotFoundException('员工不存在或未绑定');
    }
    const overview = await this.performanceService.getPerformanceOverview(
      userId,
    );
    return {
      userId,
      name: binding.planeMemberName ?? userId,
      overview,
    };
  }
}
