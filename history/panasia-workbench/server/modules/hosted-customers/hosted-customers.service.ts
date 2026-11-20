import {
  BadRequestException,
  ForbiddenException,
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
import { and, desc, eq } from 'drizzle-orm';
import { hostedCustomers } from '@server/database/schema';
import type {
  CreateHostedCustomerRequest,
  HostedCustomerDimension,
  HostedCustomerInfo,
  HostedCustomerListResponse,
  HostedCustomerStatus,
  UpdateHostedCustomerRequest,
} from '@shared/api.interface';

type HostedCustomerRow = typeof hostedCustomers.$inferSelect;
type HostedCustomerPatch = Partial<typeof hostedCustomers.$inferInsert>;

export interface HostedUserContextLike {
  userId: string;
  appId?: string;
}

@Injectable()
export class HostedCustomersService {
  private readonly logger = new Logger(HostedCustomersService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly userDirectory: UserDirectoryService,
  ) {}

  /** 员工端列表：只返回 owner=本人的档案，ownerName 置 null（员工看自己） */
  async listForUser(
    userId: string,
    dimension?: string,
  ): Promise<HostedCustomerListResponse> {
    const rows: HostedCustomerRow[] = await this.db
      .select()
      .from(hostedCustomers)
      .where(
        and(
          eq(hostedCustomers.owner, userId),
          ...(dimension ? [eq(hostedCustomers.dimension, dimension)] : []),
        ),
      )
      .orderBy(desc(hostedCustomers.createdAt));
    return {
      items: rows.map((row: HostedCustomerRow) => this.toInfo(row, null)),
    };
  }

  /** 管理端列表：全量 + 可选 dimension/status 过滤，批量回填 ownerName */
  async listForAdmin(
    userContext: HostedUserContextLike,
    dimension?: string,
    status?: string,
  ): Promise<HostedCustomerListResponse> {
    const rows: HostedCustomerRow[] = await this.db
      .select()
      .from(hostedCustomers)
      .where(
        and(
          ...(dimension ? [eq(hostedCustomers.dimension, dimension)] : []),
          ...(status ? [eq(hostedCustomers.status, status)] : []),
        ),
      )
      .orderBy(desc(hostedCustomers.createdAt));
    const nameMap = await this.resolveOwnerNames(
      userContext,
      rows.map((row: HostedCustomerRow) => row.owner),
    );
    return {
      items: rows.map(
        (row: HostedCustomerRow) =>
          this.toInfo(row, nameMap.get(row.owner) ?? ''),
      ),
    };
  }

  /** 员工端创建：owner 固定为本人，忽略 dto.ownerUserId */
  async createForUser(
    userId: string,
    dto: CreateHostedCustomerRequest,
  ): Promise<HostedCustomerInfo> {
    const inserted = await this.db
      .insert(hostedCustomers)
      .values({
        customerName: dto.customerName,
        dimension: dto.dimension,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        legalPersonName: dto.legalPersonName ?? null,
        mainDevicePhone: dto.mainDevicePhone ?? null,
        mainEmail: dto.mainEmail ?? null,
        content: dto.content ?? null,
        status: dto.status ?? 'hosting',
        owner: userId,
        startedAt: dto.startedAt ?? null,
        remark: dto.remark ?? null,
      })
      .returning();
    return this.toInfo(inserted[0], null);
  }

  /** 管理端创建：必须指定负责员工 */
  async createForAdmin(
    userContext: HostedUserContextLike,
    dto: CreateHostedCustomerRequest,
  ): Promise<HostedCustomerInfo> {
    if (!dto.ownerUserId) {
      throw new BadRequestException('需指定负责员工');
    }
    const inserted = await this.db
      .insert(hostedCustomers)
      .values({
        customerName: dto.customerName,
        dimension: dto.dimension,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        legalPersonName: dto.legalPersonName ?? null,
        mainDevicePhone: dto.mainDevicePhone ?? null,
        mainEmail: dto.mainEmail ?? null,
        content: dto.content ?? null,
        status: dto.status ?? 'hosting',
        owner: dto.ownerUserId,
        startedAt: dto.startedAt ?? null,
        remark: dto.remark ?? null,
      })
      .returning();
    const nameMap = await this.resolveOwnerNames(userContext, [
      inserted[0].owner,
    ]);
    return this.toInfo(inserted[0], nameMap.get(inserted[0].owner) ?? '');
  }

  /** 员工端更新：仅 owner=本人的行；他人行 403；不可改负责人 */
  async updateForUser(
    userId: string,
    id: string,
    dto: UpdateHostedCustomerRequest,
  ): Promise<HostedCustomerInfo> {
    const row = await this.loadRow(id);
    if (row.owner !== userId) {
      throw new ForbiddenException('只能修改自己负责的托管客户档案');
    }
    const patch = this.buildPatch(dto, false);
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    patch.updatedBy = userId;
    const updated = await this.db
      .update(hostedCustomers)
      .set(patch)
      .where(eq(hostedCustomers.id, id))
      .returning();
    return this.toInfo(updated[0], null);
  }

  /** 管理端更新：可改任意行，含换负责人 */
  async updateForAdmin(
    userContext: HostedUserContextLike,
    id: string,
    dto: UpdateHostedCustomerRequest,
  ): Promise<HostedCustomerInfo> {
    await this.loadRow(id);
    const patch = this.buildPatch(dto, true);
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    patch.updatedBy = userContext.userId;
    const updated = await this.db
      .update(hostedCustomers)
      .set(patch)
      .where(eq(hostedCustomers.id, id))
      .returning();
    const nameMap = await this.resolveOwnerNames(userContext, [
      updated[0].owner,
    ]);
    return this.toInfo(updated[0], nameMap.get(updated[0].owner) ?? '');
  }

  /** 管理端删除 */
  async deleteForAdmin(id: string): Promise<{ ok: boolean }> {
    const deleted = await this.db
      .delete(hostedCustomers)
      .where(eq(hostedCustomers.id, id))
      .returning({ id: hostedCustomers.id });
    if (deleted.length === 0) {
      throw new NotFoundException('托管客户档案不存在');
    }
    return { ok: true };
  }

  private async loadRow(id: string): Promise<HostedCustomerRow> {
    const rows = await this.db
      .select()
      .from(hostedCustomers)
      .where(eq(hostedCustomers.id, id))
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundException('托管客户档案不存在');
    }
    return rows[0];
  }

  /** 只收集 dto 中 !== undefined 的字段；null 写入表示清空；员工端不可改 owner */
  private buildPatch(
    dto: UpdateHostedCustomerRequest,
    allowOwner: boolean,
  ): HostedCustomerPatch {
    const patch: HostedCustomerPatch = {};
    if (dto.customerName !== undefined) patch.customerName = dto.customerName;
    if (dto.dimension !== undefined) patch.dimension = dto.dimension;
    if (dto.contactName !== undefined) patch.contactName = dto.contactName;
    if (dto.contactPhone !== undefined) {
      patch.contactPhone = dto.contactPhone;
    }
    if (dto.legalPersonName !== undefined) {
      patch.legalPersonName = dto.legalPersonName;
    }
    if (dto.mainDevicePhone !== undefined) {
      patch.mainDevicePhone = dto.mainDevicePhone;
    }
    if (dto.mainEmail !== undefined) patch.mainEmail = dto.mainEmail;
    if (dto.content !== undefined) patch.content = dto.content;
    if (dto.status !== undefined) patch.status = dto.status;
    if (allowOwner && dto.ownerUserId !== undefined) {
      patch.owner = dto.ownerUserId;
    }
    if (dto.startedAt !== undefined) patch.startedAt = dto.startedAt;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    return patch;
  }

  /** 按妙搭 userId 批量查人建 Map；查不到为空字符串，失败降级不阻断列表 */
  private async resolveOwnerNames(
    userContext: HostedUserContextLike,
    ids: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids)];
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
      this.logger.warn(
        '托管档案负责人姓名查询失败，保持空展示',
        error instanceof Error ? error.stack : String(error),
      );
      return new Map<string, string>();
    }
  }

  private toInfo(
    row: HostedCustomerRow,
    ownerName: string | null,
  ): HostedCustomerInfo {
    return {
      id: row.id,
      customerName: row.customerName,
      dimension: row.dimension as HostedCustomerDimension,
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      legalPersonName: row.legalPersonName,
      mainDevicePhone: row.mainDevicePhone,
      mainEmail: row.mainEmail,
      content: row.content,
      status: row.status as HostedCustomerStatus,
      ownerUserId: row.owner,
      ownerName,
      startedAt: row.startedAt,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
