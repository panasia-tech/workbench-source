import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';

import { demoProfiles } from '@server/database/schema';

export interface ResolvedView {
  userId: string;
  userName: string | null;
  demoAs: boolean;
}

interface DemoProfileRow {
  userId: string;
  name: string;
  enabled: boolean;
  isDemoAccount: boolean;
}

const CACHE_TTL_MS = 60_000;

@Injectable()
export class DemoViewService {
  private cacheAt = 0;
  private cache = new Map<string, DemoProfileRow>();
  /**
   * 演示视角开关：带 x-demo-as 头 / demoAs 参数就能以演示账号身份读写，
   * 上公网后默认关闭，只在本机演示时用 DEMO_VIEW_ENABLED=true 打开。
   */
  readonly enabled: boolean = process.env.DEMO_VIEW_ENABLED === 'true';

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async resolve(req: Request): Promise<ResolvedView> {
    const realUserId: string = req.userContext.userId;
    const realName: string | null = req.userContext.userName || null;
    if (!this.enabled) {
      return { userId: realUserId, userName: realName, demoAs: false };
    }
    const header = req.headers['x-demo-as'];
    const query = (req.query as Record<string, unknown>).demoAs;
    const raw =
      typeof header === 'string'
        ? header
        : typeof query === 'string'
          ? query
          : '';
    const candidate = raw.trim();
    if (!candidate || candidate === realUserId) {
      return { userId: realUserId, userName: realName, demoAs: false };
    }
    const profile = await this.lookup(candidate);
    if (!profile || !profile.enabled || !profile.isDemoAccount) {
      return { userId: realUserId, userName: realName, demoAs: false };
    }
    return { userId: candidate, userName: profile.name, demoAs: true };
  }

  async lookup(userId: string): Promise<DemoProfileRow | null> {
    if (Date.now() - this.cacheAt > CACHE_TTL_MS) {
      const rows = await this.db
        .select({
          userId: demoProfiles.miaodaUserId,
          name: demoProfiles.displayName,
          enabled: demoProfiles.enabled,
          isDemoAccount: demoProfiles.isDemoAccount,
        })
        .from(demoProfiles);
      this.cache = new Map(
        rows.map((row: DemoProfileRow) => [row.userId, row]),
      );
      this.cacheAt = Date.now();
    }
    return this.cache.get(userId) ?? null;
  }

  invalidate(): void {
    this.cacheAt = 0;
  }
}
