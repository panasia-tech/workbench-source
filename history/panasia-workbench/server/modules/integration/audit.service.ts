import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { adminAuditLogs } from '@server/database/schema';

export type AuditParams = {
  action: string;
  operatorId?: string;
  targetType?: string;
  targetId?: string;
  detail?: { summary?: string; changes?: Record<string, unknown> };
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async log(params: AuditParams): Promise<void> {
    try {
      await this.db.insert(adminAuditLogs).values({
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        detail: params.detail ?? null,
        ...(params.operatorId
          ? { createdBy: params.operatorId, updatedBy: params.operatorId }
          : {}),
      });
    } catch (error) {
      this.logger.warn('audit log insert failed, ignored', {
        action: params.action,
        targetId: params.targetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
