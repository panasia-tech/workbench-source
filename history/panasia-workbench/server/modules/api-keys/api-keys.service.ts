import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { createHash, randomBytes } from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  WORKBENCH_API_KEYS_DDL,
  workbenchApiKeys,
} from '@server/database/standalone-schema';
import type {
  ApiKeyIssueResponse,
  ApiKeyListItem,
  ApiKeyListResponse,
} from '@shared/api.interface';

const KEY_BODY_BYTES = 24;
/** last_used_at 写入节流：距上次更新不足这么久就不写（MCP 每次调用都会过这里） */
const LAST_USED_THROTTLE_MS = 60_000;

export function digestOf(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * 个人 API Key（2026-10-22 上线）：每人签自己的 key 调 POST /openapi/mcp，身份 = key 主人。
 * 库里只有 sha256 digest，key 本体只在签发响应里出现一次；revoked_at 非空即失效。
 * 表 workbench_api_keys 启动时幂等建（不用人工跑迁移）。
 */
@Injectable()
export class ApiKeysService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'workbench_api_keys',
      WORKBENCH_API_KEYS_DDL,
      '个人 API Key 不可用',
    );
  }

  async list(userId: string): Promise<ApiKeyListResponse> {
    const rows = await this.db
      .select()
      .from(workbenchApiKeys)
      .where(eq(workbenchApiKeys.userId, userId))
      .orderBy(desc(workbenchApiKeys.createdAt));
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        keyPrefix: row.keyPrefix,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** 签发 / 更换（2026-10-22 老板定：每人仅一把有效 key）：没有就建，有了就把旧的吊销换新；返回的 key 只此一次 */
  async issue(userId: string, rawName: unknown): Promise<ApiKeyIssueResponse> {
    const name =
      typeof rawName === 'string' && rawName.trim() !== ''
        ? rawName.trim().slice(0, 100)
        : '默认';
    const key = `wk_${randomBytes(KEY_BODY_BYTES).toString('base64url')}`;
    const now = new Date();
    try {
      return await this.db.transaction(async (tx) => {
        await tx
          .update(workbenchApiKeys)
          .set({ revokedAt: now })
          .where(
            and(
              eq(workbenchApiKeys.userId, userId),
              isNull(workbenchApiKeys.revokedAt),
            ),
          );
        const rows = await tx
          .insert(workbenchApiKeys)
          .values({
            userId: userId.slice(0, 64),
            name,
            keyPrefix: key.slice(0, 11),
            keyDigest: digestOf(key),
          })
          .returning({
            id: workbenchApiKeys.id,
            createdAt: workbenchApiKeys.createdAt,
          });
        return {
          id: rows[0].id,
          name,
          key,
          createdAt: rows[0].createdAt.toISOString(),
        };
      });
    } catch (error) {
      // 并发连点撞上部分唯一索引（一人一把有效 key）：让刷新拿最新状态
      if ((error as { code?: string }).code === '23505') {
        throw new BadRequestException('已有新 key 了，请刷新页面');
      }
      throw error;
    }
  }

  /** 吊销：只能吊销自己的，别人的 / 不存在同样 404；重复吊销幂等 */
  async revoke(userId: string, id: string): Promise<{ ok: true }> {
    const rows = await this.db
      .update(workbenchApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(workbenchApiKeys.id, id), eq(workbenchApiKeys.userId, userId)),
      )
      .returning({ id: workbenchApiKeys.id });
    if (rows.length === 0) {
      throw new NotFoundException('key 不存在');
    }
    return { ok: true };
  }

  /** 鉴权用：按 key 本体找有效行；找不到 / 已吊销返回 null */
  async findActiveByKey(
    rawKey: string,
  ): Promise<{ id: string; userId: string } | null> {
    if (!rawKey.startsWith('wk_')) return null;
    const rows = await this.db
      .select({
        id: workbenchApiKeys.id,
        userId: workbenchApiKeys.userId,
        lastUsedAt: workbenchApiKeys.lastUsedAt,
      })
      .from(workbenchApiKeys)
      .where(
        and(
          eq(workbenchApiKeys.keyDigest, digestOf(rawKey)),
          isNull(workbenchApiKeys.revokedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (
      row.lastUsedAt === null ||
      Date.now() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS
    ) {
      void this.db
        .update(workbenchApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(workbenchApiKeys.id, row.id))
        .catch(() => undefined);
    }
    return { id: row.id, userId: row.userId };
  }
}
