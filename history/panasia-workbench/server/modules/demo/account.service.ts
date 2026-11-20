import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { asc, eq } from 'drizzle-orm';
import type { Request } from 'express';

import { demoProfiles } from '@server/database/schema';
import type {
  AccountCenterResponse,
  DemoAccountItem,
  UpdateAccountProfileRequest,
} from '@shared/api.interface';
import { DemoViewService } from './demo-view.service';

interface ProfileRow {
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  roleLabel: string | null;
  isDemoAccount: boolean;
  enabled: boolean;
}

@Injectable()
export class AccountService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly demoView: DemoViewService,
  ) {}

  async getAccountCenter(req: Request): Promise<AccountCenterResponse> {
    const view = await this.demoView.resolve(req);
    const realUserId: string = req.userContext.userId;
    const realName: string | null = req.userContext.userName || null;
    const roles: string[] = req.userContext.roles ?? [];
    const canAdmin: boolean = roles.includes('boss') || roles.includes('admin');

    const rows: ProfileRow[] = await this.db
      .select({
        userId: demoProfiles.miaodaUserId,
        name: demoProfiles.displayName,
        email: demoProfiles.email,
        avatarUrl: demoProfiles.avatarUrl,
        roleLabel: demoProfiles.roleLabel,
        isDemoAccount: demoProfiles.isDemoAccount,
        enabled: demoProfiles.enabled,
      })
      .from(demoProfiles)
      .orderBy(asc(demoProfiles.sort));

    const viewProfile = this.toItem(
      rows.find((row: ProfileRow) => row.userId === view.userId),
    );
    const fallbackProfile: DemoAccountItem | null =
      !viewProfile && !view.demoAs
        ? {
            userId: view.userId,
            name: view.userName ?? '同事',
            email: null,
            avatarUrl: null,
            roleLabel: null,
          }
        : null;

    const demoAccounts: DemoAccountItem[] = [];
    for (const row of rows) {
      // 演示视角关闭时不给切换列表，前端就不显示「切换演示账户」
      if (this.demoView.enabled && row.isDemoAccount && row.enabled) {
        demoAccounts.push(this.toItem(row) as DemoAccountItem);
      }
    }

    return {
      realUser: { userId: realUserId, name: realName },
      viewUserId: view.userId,
      isDemoView: view.demoAs,
      viewProfile: viewProfile ?? fallbackProfile,
      demoAccounts,
      canAdmin,
    };
  }

  async updateProfile(
    req: Request,
    dto: UpdateAccountProfileRequest,
  ): Promise<DemoAccountItem> {
    const view = await this.demoView.resolve(req);
    const name: string = dto.name.trim();
    if (!name) {
      throw new BadRequestException('姓名不能为空');
    }
    const email: string | null = dto.email?.trim() || null;
    const avatarUrl: string | null = dto.avatarUrl?.trim() || null;

    await this.db
      .insert(demoProfiles)
      .values({
        miaodaUserId: view.userId,
        displayName: name,
        email,
        avatarUrl,
        roleLabel: null,
        isDemoAccount: view.demoAs,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: demoProfiles.miaodaUserId,
        set: { displayName: name, email, avatarUrl },
      });
    this.demoView.invalidate();

    const [row] = await this.db
      .select({
        userId: demoProfiles.miaodaUserId,
        name: demoProfiles.displayName,
        email: demoProfiles.email,
        avatarUrl: demoProfiles.avatarUrl,
        roleLabel: demoProfiles.roleLabel,
        isDemoAccount: demoProfiles.isDemoAccount,
        enabled: demoProfiles.enabled,
      })
      .from(demoProfiles)
      .where(eq(demoProfiles.miaodaUserId, view.userId));
    const profile = this.toItem(row);
    if (!profile) {
      throw new BadRequestException('保存账户资料失败');
    }
    return profile;
  }

  private toItem(
    row: ProfileRow | undefined,
  ): DemoAccountItem | null {
    if (!row) return null;
    return {
      userId: row.userId,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatarUrl,
      roleLabel: row.roleLabel,
    };
  }
}
