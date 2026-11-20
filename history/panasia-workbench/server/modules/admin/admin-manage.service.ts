import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { UserDirectoryService } from '../auth/user-directory.service';
import { LoginAccountService } from '../auth/login-account.service';
import { count, eq, like, not } from 'drizzle-orm';
import {
  employeeBindings,
  systemConfigs,
  workOrderCatalog,
  workOrders,
} from '@server/database/schema';
import type {
  AdminCatalogDeleteResponse,
  AdminCatalogUpsertRequest,
  AdminConfigResponse,
  AdminEmployeeBindingRow,
  AdminEmployeeBindingsResponse,
  AdminUnboundAccountRow,
  SystemConfigItem,
  UpdateConfigResponse,
  UpdateSystemConfigRequest,
  WorkOrderCatalogItem,
  WorkOrderCatalogResponse,
  WorkOrderChecklistItem,
  WorkOrderComplexity,
  WorkOrderType,
} from '@shared/api.interface';

import { parseBusinessLine } from '../workorders/workorder-fields';

type CatalogRow = typeof workOrderCatalog.$inferSelect;

export interface UserContextLike {
  userId: string;
  appId?: string;
}

function extractPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

@Injectable()
export class AdminManageService {
  private readonly logger = new Logger(AdminManageService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly userDirectory: UserDirectoryService,
    private readonly loginAccounts: LoginAccountService,
  ) {}

  // ==================== 系统配置 ====================

  private toConfigItem(row: typeof systemConfigs.$inferSelect): SystemConfigItem {
    return {
      configKey: row.configKey,
      configValue: (row.configValue ?? {}) as Record<string, unknown>,
      description: row.description,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getConfigs(): Promise<AdminConfigResponse> {
    const rows = await this.db
      .select()
      .from(systemConfigs)
      .where(not(like(systemConfigs.configKey, 'env.%')))
      .orderBy(systemConfigs.configKey);
    return { items: rows.map((row) => this.toConfigItem(row)) };
  }

  async updateConfig(
    userId: string,
    dto: UpdateSystemConfigRequest,
  ): Promise<UpdateConfigResponse> {
    const updated = await this.db
      .update(systemConfigs)
      .set({
        configValue: dto.configValue,
        updatedAt: new Date(),
        updatedBy: userId,
      })
      .where(eq(systemConfigs.configKey, dto.configKey))
      .returning();
    if (updated.length === 0) {
      throw new NotFoundException('配置项不存在');
    }
    return { item: this.toConfigItem(updated[0]) };
  }

  // ==================== 工单目录 ====================

  private toCatalogItem(row: CatalogRow): WorkOrderCatalogItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      orderType: row.orderType as WorkOrderType,
      complexity: row.complexity as WorkOrderComplexity,
      checklistTemplate:
        (row.checklistTemplate as WorkOrderChecklistItem[] | null) ?? [],
      businessLine: parseBusinessLine(row.businessLine),
      promptTemplate: row.promptTemplate,
      autoTriggerRules:
        (row.autoTriggerRules as WorkOrderCatalogItem['autoTriggerRules']) ?? null,
      erpAction: row.erpAction,
      notifyTargets:
        (row.notifyTargets as WorkOrderCatalogItem['notifyTargets']) ?? null,
      enabled: row.enabled,
      sort: row.sort,
    };
  }

  async listCatalog(): Promise<WorkOrderCatalogResponse> {
    const rows = await this.db
      .select()
      .from(workOrderCatalog)
      .orderBy(workOrderCatalog.sort, workOrderCatalog.code);
    return { items: rows.map((row: CatalogRow) => this.toCatalogItem(row)) };
  }

  async createCatalog(
    userId: string,
    dto: AdminCatalogUpsertRequest,
  ): Promise<WorkOrderCatalogItem> {
    let created: CatalogRow[];
    try {
      created = await this.db
        .insert(workOrderCatalog)
        .values({
          code: dto.code,
          name: dto.name,
          orderType: dto.orderType,
          complexity: dto.complexity,
          checklistTemplate: dto.checklistTemplate ?? null,
          businessLine: parseBusinessLine(dto.businessLine),
          promptTemplate: dto.promptTemplate ?? null,
          erpAction: dto.erpAction ?? null,
          notifyTargets: dto.notifyTargets ?? null,
          enabled: dto.enabled ?? true,
          sort: dto.sort ?? 0,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .returning();
    } catch (error) {
      if (extractPostgresErrorCode(error) === '23505') {
        throw new ConflictException('目录编码已存在');
      }
      throw error;
    }
    return this.toCatalogItem(created[0]);
  }

  async updateCatalog(
    userId: string,
    id: string,
    dto: Partial<AdminCatalogUpsertRequest>,
  ): Promise<WorkOrderCatalogItem> {
    const patch: Partial<typeof workOrderCatalog.$inferInsert> = {};
    if (dto.code !== undefined) patch.code = dto.code;
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.orderType !== undefined) patch.orderType = dto.orderType;
    if (dto.complexity !== undefined) patch.complexity = dto.complexity;
    if (dto.checklistTemplate !== undefined) {
      patch.checklistTemplate = dto.checklistTemplate;
    }
    if (dto.businessLine !== undefined) {
      patch.businessLine = parseBusinessLine(dto.businessLine);
    }
    if (dto.promptTemplate !== undefined) patch.promptTemplate = dto.promptTemplate;
    if (dto.erpAction !== undefined) patch.erpAction = dto.erpAction;
    if (dto.notifyTargets !== undefined) patch.notifyTargets = dto.notifyTargets;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.sort !== undefined) patch.sort = dto.sort;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    const updated = await this.db
      .update(workOrderCatalog)
      .set(patch)
      .where(eq(workOrderCatalog.id, id))
      .returning();
    if (updated.length === 0) {
      throw new NotFoundException('目录不存在');
    }
    return this.toCatalogItem(updated[0]);
  }

  async deleteCatalog(id: string): Promise<AdminCatalogDeleteResponse> {
    const rows = await this.db
      .select({ id: workOrderCatalog.id, code: workOrderCatalog.code })
      .from(workOrderCatalog)
      .where(eq(workOrderCatalog.id, id))
      .limit(1);
    const catalog = rows[0];
    if (!catalog) {
      throw new NotFoundException('目录不存在');
    }
    const [{ c }] = await this.db
      .select({ c: count() })
      .from(workOrders)
      .where(eq(workOrders.catalogCode, catalog.code));
    if (c > 0) {
      throw new ConflictException('目录已被工单引用，请停用而非删除');
    }
    const deleted = await this.db
      .delete(workOrderCatalog)
      .where(eq(workOrderCatalog.id, id))
      .returning({ id: workOrderCatalog.id });
    if (deleted.length === 0) {
      throw new NotFoundException('目录不存在');
    }
    return { ok: true };
  }

  // ==================== 员工绑定 ====================

  private async resolveUserNames(
    userContext: UserContextLike,
    ids: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids.filter((id: string) => !!id))];
    if (uniqueIds.length === 0) {
      return new Map<string, string>();
    }
    try {
      const users = await this.userDirectory.listUsersByIds(uniqueIds);
      const map = new Map<string, string>();
      users.forEach((user, index: number) => {
        if (!user) return;
        const name = user.name?.zh_cn ?? user.name?.en_us ?? '';
        if (name) map.set(uniqueIds[index], name);
      });
      return map;
    } catch (error) {
      this.logger.warn('员工姓名查询失败，保持空展示', (error as Error).stack);
      return new Map<string, string>();
    }
  }

  async listEmployeeBindings(
    userContext: UserContextLike,
  ): Promise<AdminEmployeeBindingsResponse> {
    const rows = await this.db
      .select()
      .from(employeeBindings)
      .orderBy(employeeBindings.planeMemberName);
    const nameMap = await this.resolveUserNames(
      userContext,
      rows.map((row: typeof employeeBindings.$inferSelect) => row.miaodaUserId),
    );
    const items: AdminEmployeeBindingRow[] = rows.map(
      (row: typeof employeeBindings.$inferSelect) => ({
        id: row.id,
        miaodaUserId: row.miaodaUserId,
        userName: nameMap.get(row.miaodaUserId) ?? null,
        planeMemberId: row.planeMemberId,
        planeMemberName: row.planeMemberName,
        role: row.role,
        frappeEmployeeId: row.frappeEmployeeId,
        nocobaseUserId: row.nocobaseUserId,
      }),
    );
    return { items, unbound: await this.listUnboundAccounts(items) };
  }

  /**
   * 用统一账号登录过、还没绑定的人：员工首次登录自动开号后出现在这里，管理员点「绑定」直接带上
   * 用户 ID（= ERP 员工 ID），空库也不用手抄 ID。查不到只影响这一块，不挡绑定列表
   */
  private async listUnboundAccounts(
    items: AdminEmployeeBindingRow[],
  ): Promise<AdminUnboundAccountRow[]> {
    const bound = new Set(items.map((item: AdminEmployeeBindingRow) => item.miaodaUserId));
    try {
      const accounts = await this.loginAccounts.listActiveAccounts();
      return accounts
        .filter((account) => !bound.has(account.userId))
        .map((account) => ({
          miaodaUserId: account.userId,
          userName: account.displayName ?? account.loginName,
          loginName: account.loginName,
          lastLoginAt: account.lastLoginAt ? account.lastLoginAt.toISOString() : null,
        }));
    } catch (error) {
      this.logger.warn('待绑定员工查询失败，先不显示', (error as Error).stack);
      return [];
    }
  }
}
