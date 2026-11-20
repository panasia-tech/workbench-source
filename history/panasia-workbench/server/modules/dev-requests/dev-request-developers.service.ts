import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';

import { systemConfigs } from '@server/database/schema';

export const DEV_REQUEST_DEVELOPERS_CONFIG_KEY = 'dev_request.developer_user_ids';

/**
 * 开发需求「能派给谁」名单（2026-10-22 老板定，勿回退）：system_configs
 * dev_request.developer_user_ids 的 user_ids（工作台用户 ID 列表）。
 * 行不存在 = 不限制（向后兼容老环境）；行存在 = 只有名单里的人能被选为开发者，
 * 候选列表与发布接口两边都拦，API 直接传人也绕不过。加新开发 = 管理端系统配置里把 ID 加进列表。
 */
@Injectable()
export class DevRequestDevelopersService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** null = 未配置不限制；Set = 白名单（空集 = 谁都派不了） */
  async allowedDeveloperIds(): Promise<Set<string> | null> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, DEV_REQUEST_DEVELOPERS_CONFIG_KEY))
      .limit(1);
    if (rows.length === 0) return null;
    const value = rows[0].configValue as { user_ids?: unknown } | null;
    const ids = Array.isArray(value?.user_ids) ? value.user_ids : [];
    return new Set(
      ids
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    );
  }
}
