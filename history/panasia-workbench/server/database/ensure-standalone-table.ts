import type { Logger } from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 连接串 ?schema= 决定数据层每条查询 SET LOCAL ROLE 的角色后缀（见 deploy/sql/init-roles.sql） */
function dataRoleNames(): string[] {
  let suffix = '';
  try {
    suffix = new URL(process.env.SUDA_DATABASE_URL ?? '').searchParams.get('schema') ?? '';
  } catch {
    suffix = '';
  }
  return ['authenticated_', 'anon_', 'service_role_'].map(
    (prefix: string) => `${prefix}${suffix}`,
  );
}

/**
 * 启动时幂等建一张独立部署新增的表（standalone-schema.ts 里的 *_DDL，均为 IF NOT EXISTS），
 * 再给数据层的三个角色授权。不需要人工跑迁移；从妙搭整库导过来的库、空库都适用。
 *
 * 建表失败只记错误、返回 false，不阻断启动（日志里有原因，failureHint 说明影响面）。
 */
export async function ensureStandaloneTable(
  db: PostgresJsDatabase,
  logger: Logger,
  table: string,
  ddl: string[],
  failureHint: string,
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      // IF NOT EXISTS 每次启动都会刷一条 NOTICE，压掉
      await tx.execute(sql.raw('SET LOCAL client_min_messages TO warning'));
      for (const statement of ddl) {
        await tx.execute(sql.raw(statement));
      }
    });
  } catch (error) {
    logger.error(
      `建 ${table} 失败，${failureHint}：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  // 数据层按请求切到 authenticated_/anon_/service_role_ 角色执行，新表要给它们授权；角色没建就跳过
  for (const role of dataRoleNames()) {
    try {
      await db.execute(
        sql.raw(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdent(table)} TO ${quoteIdent(role)}`,
        ),
      );
    } catch {
      logger.warn(
        `给角色 ${role} 授权 ${table} 失败（角色不存在？见 deploy/sql/init-roles.sql）`,
      );
    }
  }
  return true;
}
