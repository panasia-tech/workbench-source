import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { inArray } from 'drizzle-orm';

import { demoProfiles, employeeBindings } from '@server/database/schema';
import { LoginAccountService } from './login-account.service';

/** 与平台 MiaodaUserInfo 同形，调用方照旧读 name.zh_cn */
export interface DirectoryUser {
  miaodaUserID: string;
  name: { zh_cn: string; en_us: string };
}

/**
 * 按妙搭 userId 查姓名，替代平台 AuthNPaasService.listUsersByIds（外面调不到平台通讯录）。
 * 来源优先级：员工自己在「账户设置」填的姓名 > 统一登录显示名 > Plane 成员名。
 */
@Injectable()
export class UserDirectoryService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly accounts: LoginAccountService,
  ) {}

  /** 与入参等长同序，查不到的位置为 null */
  async listUsersByIds(userIds: string[]): Promise<(DirectoryUser | null)[]> {
    const unique = [...new Set(userIds.filter((id: string) => Boolean(id)))];
    if (unique.length === 0) {
      return userIds.map(() => null);
    }
    const names = new Map<string, string>();
    const bindings: { userId: string; name: string | null }[] = await this.db
      .select({
        userId: employeeBindings.miaodaUserId,
        name: employeeBindings.planeMemberName,
      })
      .from(employeeBindings)
      .where(inArray(employeeBindings.miaodaUserId, unique));
    for (const row of bindings) {
      if (row.name) names.set(row.userId, row.name);
    }
    for (const [userId, name] of await this.accounts.listDisplayNames(unique)) {
      names.set(userId, name);
    }
    const profiles: { userId: string; name: string }[] = await this.db
      .select({
        userId: demoProfiles.miaodaUserId,
        name: demoProfiles.displayName,
      })
      .from(demoProfiles)
      .where(inArray(demoProfiles.miaodaUserId, unique));
    for (const row of profiles) {
      if (row.name) names.set(row.userId, row.name);
    }
    return userIds.map((id: string): DirectoryUser | null => {
      const name = names.get(id);
      return name ? { miaodaUserID: id, name: { zh_cn: name, en_us: name } } : null;
    });
  }
}
