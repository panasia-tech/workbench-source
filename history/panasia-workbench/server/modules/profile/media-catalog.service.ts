import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { workbenchLoginAccounts } from '@server/database/standalone-schema';
import { CredentialsService } from '../integration/credentials.service';
import type { MyLearningVideos } from '@shared/api.interface';

const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL ?? '').trim().replace(/\/+$/, '');
const TOKEN_NAME = 'MEDIA_CATALOG_TOKEN';
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface CatalogResponse {
  series?: { name?: unknown; items?: { id?: unknown; title?: unknown; url?: unknown }[] }[];
}

/**
 * 学习中心「培训视频」：从媒体资料服务（禅道任务 #2，media.panasia.fun）取员工能看的视频目录。
 *
 * 带服务令牌和这个人在统一登录里的组名去问，能看哪些由媒体服务按资料的受众判，工作台不重复写一套；
 * 点开每一集走媒体服务的固定链接，那边还会让员工登录、再判一次权限。没配 MEDIA_BASE_URL /
 * MEDIA_CATALOG_TOKEN 时这一区不显示；媒体服务连不上只影响这一区，教程照常。
 */
@Injectable()
export class MediaCatalogService {
  private readonly logger = new Logger(MediaCatalogService.name);
  private readonly cache = new Map<string, { value: MyLearningVideos; expiresAt: number }>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly credentials: CredentialsService,
  ) {}

  async getVideos(userId: string): Promise<MyLearningVideos> {
    const token = await this.credentials.get(TOKEN_NAME);
    if (!MEDIA_BASE_URL || !token) {
      return { configured: false, series: [], error: null };
    }
    const groups = await this.groupsOf(userId);
    const key = [...groups].sort().join(',');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const url = `${MEDIA_BASE_URL}/api/catalog?groups=${encodeURIComponent(key)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const value: MyLearningVideos = {
        configured: true,
        series: this.parse((await response.json()) as CatalogResponse),
        error: null,
      };
      this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (error) {
      this.logger.warn(
        `取培训视频目录失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return { configured: true, series: [], error: '培训视频暂时读不到，请稍后再试' };
    }
  }

  /** 一个人可能有多行登录对照（换过统一账号），组取并集 */
  private async groupsOf(userId: string): Promise<Set<string>> {
    const rows: { idpGroups: string[] | null }[] = await this.db
      .select({ idpGroups: workbenchLoginAccounts.idpGroups })
      .from(workbenchLoginAccounts)
      .where(eq(workbenchLoginAccounts.miaodaUserId, userId));
    return new Set(rows.flatMap((row) => row.idpGroups ?? []));
  }

  private parse(body: CatalogResponse): MyLearningVideos['series'] {
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    return (body.series ?? [])
      .map((series) => ({
        name: text(series.name),
        items: (series.items ?? [])
          .map((item) => ({ id: text(item.id), title: text(item.title), url: text(item.url) }))
          // 只放媒体服务自己的链接，免得目录里混进别的地址
          .filter((item) => item.id && item.url.startsWith(`${MEDIA_BASE_URL}/m/`)),
      }))
      .filter((series) => series.name && series.items.length > 0);
  }
}
