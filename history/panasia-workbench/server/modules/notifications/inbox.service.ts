import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, count, desc, eq, isNull } from 'drizzle-orm';

import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  WORKBENCH_NOTIFICATIONS_DDL,
  workbenchNotifications,
} from '@server/database/standalone-schema';
import type {
  NotificationCategory,
  NotificationItem,
  NotificationListResponse,
} from '@shared/api.interface';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const TITLE_MAX = 200;
const BODY_MAX = 2000;
const LINK_MAX = 500;
const CATEGORIES: readonly NotificationCategory[] = [
  'task',
  'task_review',
  'block_defer',
  'workorder',
  'tutorial',
  'dev_request',
  'general',
];

type NotificationRow = typeof workbenchNotifications.$inferSelect;

export interface InboxMessage {
  title: string;
  body: string;
  /** 站内跳转路径（前端路由，以 / 开头）；不合规的一律丢掉，按只看不跳处理 */
  link?: string | null;
  category?: NotificationCategory;
}

/** 只认本站前端路由，防止消息里带出站链接或 javascript: 之类 */
function safeLink(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.length > LINK_MAX
  ) {
    return null;
  }
  return value;
}

function toItem(row: NotificationRow): NotificationItem {
  const category = (CATEGORIES as readonly string[]).includes(row.category)
    ? (row.category as NotificationCategory)
    : 'general';
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    link: row.link,
    category,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 站内消息收件箱：通知的主通道，NotifyService 每发一条都先写这里。
 * 表 workbench_notifications 启动时幂等建（不用人工跑迁移）。
 */
@Injectable()
export class InboxService implements OnModuleInit {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'workbench_notifications',
      WORKBENCH_NOTIFICATIONS_DDL,
      '站内消息不可用',
    );
  }

  /** 给每个收件人写一条；返回写入条数。不抛错（调用方多数是 fire-and-forget） */
  async deliver(userIds: string[], message: InboxMessage): Promise<number> {
    const targets = [...new Set(userIds.filter((id: string) => Boolean(id)))];
    if (targets.length === 0) return 0;
    const link = safeLink(message.link);
    const category = message.category ?? 'general';
    try {
      const rows = await this.db
        .insert(workbenchNotifications)
        .values(
          targets.map((userId: string) => ({
            miaodaUserId: userId.slice(0, 64),
            title: message.title.slice(0, TITLE_MAX),
            body: message.body.slice(0, BODY_MAX),
            link,
            category,
          })),
        )
        .returning({ id: workbenchNotifications.id });
      return rows.length;
    } catch (error) {
      this.logger.error(
        `站内消息写入失败（${message.title}，${targets.length} 人）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  async list(
    userId: string,
    page?: string,
    pageSize?: string,
  ): Promise<NotificationListResponse> {
    const parsedPage = page !== undefined ? Number.parseInt(page, 10) : NaN;
    const parsedSize = pageSize !== undefined ? Number.parseInt(pageSize, 10) : NaN;
    const currentPage = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
    const currentSize = Math.min(
      Number.isFinite(parsedSize) && parsedSize >= 1 ? parsedSize : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );
    const mine = eq(workbenchNotifications.miaodaUserId, userId);
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(workbenchNotifications)
      .where(mine);
    const rows: NotificationRow[] = await this.db
      .select()
      .from(workbenchNotifications)
      .where(mine)
      .orderBy(desc(workbenchNotifications.createdAt), desc(workbenchNotifications.id))
      .limit(currentSize)
      .offset((currentPage - 1) * currentSize);
    return {
      items: rows.map(toItem),
      total,
      page: currentPage,
      pageSize: currentSize,
      unreadCount: await this.unreadCount(userId),
    };
  }

  async unreadCount(userId: string): Promise<number> {
    const [{ value }] = await this.db
      .select({ value: count() })
      .from(workbenchNotifications)
      .where(
        and(
          eq(workbenchNotifications.miaodaUserId, userId),
          isNull(workbenchNotifications.readAt),
        ),
      );
    return value;
  }

  /**
   * 标一条已读：只认自己的。返回 null = 没有这条（或不是自己的）；
   * 已读过的再标一次算成功、updated=0。
   */
  async markRead(userId: string, id: string): Promise<number | null> {
    const updated = await this.db
      .update(workbenchNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(workbenchNotifications.id, id),
          eq(workbenchNotifications.miaodaUserId, userId),
          isNull(workbenchNotifications.readAt),
        ),
      )
      .returning({ id: workbenchNotifications.id });
    if (updated.length > 0) return updated.length;
    const exists = await this.db
      .select({ id: workbenchNotifications.id })
      .from(workbenchNotifications)
      .where(
        and(
          eq(workbenchNotifications.id, id),
          eq(workbenchNotifications.miaodaUserId, userId),
        ),
      )
      .limit(1);
    return exists.length > 0 ? 0 : null;
  }

  async markAllRead(userId: string): Promise<number> {
    const updated = await this.db
      .update(workbenchNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(workbenchNotifications.miaodaUserId, userId),
          isNull(workbenchNotifications.readAt),
        ),
      )
      .returning({ id: workbenchNotifications.id });
    return updated.length;
  }
}
