import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { systemConfigs } from '@server/database/schema';

const CREDENTIAL_CONFIG_PREFIX = 'env.';
const CACHE_TTL_MS = 60_000;

@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /**
   * 读取外部系统凭证：环境变量优先，缺失时读 system_configs（configKey = `env.<NAME>`，
   * configValue = { value: string }）。线上运行时无 .env.local，靠库兜底。
   */
  async get(name: string): Promise<string> {
    const fromEnv = process.env[name];
    if (fromEnv) {
      return fromEnv;
    }
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    let value = '';
    try {
      const rows: { configValue: unknown }[] = await this.db
        .select({ configValue: systemConfigs.configValue })
        .from(systemConfigs)
        .where(
          eq(systemConfigs.configKey, `${CREDENTIAL_CONFIG_PREFIX}${name}`),
        )
        .limit(1);
      const raw = (rows[0]?.configValue ?? {}) as { value?: unknown };
      if (typeof raw.value === 'string') {
        value = raw.value;
      }
    } catch (error) {
      this.logger.warn(
        `读取凭证 ${name} 失败，本次按未配置处理`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    this.cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }
}
