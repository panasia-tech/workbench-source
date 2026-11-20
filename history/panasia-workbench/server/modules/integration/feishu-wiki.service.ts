import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { systemConfigs } from '@server/database/schema';
import { integrationConfig } from './integration.config';
import { feishuOpenBaseUrl, isFeatureEnabled } from './optional-features';

const WIKI_SPACE_CONFIG_KEY = 'sop.wiki_space_id';
const TOKEN_TTL_MS = 90 * 60 * 1000;

interface WikiSpaceConfig {
  space_id?: unknown;
}

interface WikiNodeResponse {
  code?: number;
  msg?: string;
  data?: {
    node?: { node_token?: string; obj_token?: string };
  };
}

interface DocxBlockResponse {
  code?: number;
  msg?: string;
}

interface TextElement {
  text_run: { content: string; text_element_style: Record<string, never> };
}

function textBlock(blockType: number, content: string): {
  block_type: number;
  text: { elements: TextElement[]; style: Record<string, never> };
} {
  return {
    block_type: blockType,
    text: {
      elements: [{ text_run: { content, text_element_style: {} } }],
      style: {},
    },
  };
}

function bulletBlock(content: string): {
  block_type: number;
  bullet: { elements: TextElement[] };
} {
  return {
    block_type: 12,
    bullet: { elements: [{ text_run: { content, text_element_style: {} } }] },
  };
}

function orderedBlock(content: string): {
  block_type: number;
  ordered: { elements: TextElement[] };
} {
  return {
    block_type: 13,
    ordered: { elements: [{ text_run: { content, text_element_style: {} } }] },
  };
}

/** markdown 行 → docx 块（# ## ### → heading，- / * → bullet，其余 text） */
export function markdownToBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const heading = /^(#{1,3})\s+(.*)$/u.exec(line);
    if (heading) {
      blocks.push(textBlock(2 + heading[1].length, heading[2]));
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/u.exec(line);
    if (bullet) {
      blocks.push(bulletBlock(bullet[1]));
      continue;
    }
    const ordered = /^\d+[.、)]\s+(.*)$/u.exec(line);
    if (ordered) {
      blocks.push(orderedBlock(ordered[1]));
      continue;
    }
    blocks.push(textBlock(2, line));
  }
  return blocks;
}

@Injectable()
export class FeishuWikiService {
  private readonly logger = new Logger(FeishuWikiService.name);
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly http: HttpService,
  ) {}

  /**
   * 把一篇 SOP 同步为飞书 Wiki 文档节点（可选集成，FEISHU_WIKI_SYNC_ENABLED，默认开）。
   * 返回 wikiUrl；失败返回 error（不抛错，调用方落 sync_error 即可）。
   * 开关关着：什么都不发，wikiUrl 空、error 为 null（SOP 照样存在工作台库里）。
   */
  async syncSop(
    title: string,
    markdown: string,
  ): Promise<{ wikiUrl: string; error: string | null }> {
    if (!isFeatureEnabled('feishuWikiSync')) {
      return { wikiUrl: '', error: null };
    }
    const spaceId = await this.resolveSpaceId();
    if (!spaceId) {
      return {
        wikiUrl: '',
        error: '未配置 sop.wiki_space_id（管理 → 系统配置），SOP 未同步 Wiki',
      };
    }
    try {
      const token = await this.getTenantToken();
      const node = await this.createWikiNode(token, spaceId, title);
      const nodeToken = node.node_token ?? '';
      const objToken = node.obj_token ?? '';
      if (!nodeToken || !objToken) {
        return { wikiUrl: '', error: '创建 Wiki 节点返回缺少 token' };
      }
      const blocks = markdownToBlocks(markdown);
      if (blocks.length > 0) {
        await this.writeDocxBlocks(token, objToken, blocks);
      }
      return {
        wikiUrl: `https://www.feishu.cn/wiki/${nodeToken}`,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`SOP 同步 Wiki 失败（不阻断）：${message}`);
      return { wikiUrl: '', error: message };
    }
  }

  private async resolveSpaceId(): Promise<string> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, WIKI_SPACE_CONFIG_KEY))
      .limit(1);
    const raw = (rows[0]?.configValue ?? {}) as WikiSpaceConfig;
    return typeof raw.space_id === 'string' ? raw.space_id.trim() : '';
  }

  private async getTenantToken(): Promise<string> {
    if (
      this.tokenCache &&
      this.tokenCache.expiresAt > Date.now() + 60 * 1000
    ) {
      return this.tokenCache.token;
    }
    const appId = integrationConfig.ailyAppId;
    const appSecret = integrationConfig.ailyAppSecret;
    if (!appId || !appSecret) {
      throw new Error('未配置飞书应用凭证（AILY_APP_ID / AILY_APP_SECRET）');
    }
    const response = await firstValueFrom(
      this.http.post(
        `${feishuOpenBaseUrl()}/open-apis/auth/v3/tenant_access_token/internal`,
        { app_id: appId, app_secret: appSecret },
        { timeout: 10_000 },
      ),
    );
    const body = response.data as { code?: number; msg?: string; tenant_access_token?: string };
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败：${body.msg ?? body.code}`);
    }
    this.tokenCache = {
      token: body.tenant_access_token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return this.tokenCache.token;
  }

  private async createWikiNode(
    token: string,
    spaceId: string,
    title: string,
  ): Promise<{ node_token?: string; obj_token?: string }> {
    const response = await firstValueFrom(
      this.http.post(
        `${feishuOpenBaseUrl()}/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
        { obj_type: 'docx', title: title.slice(0, 100) },
        {
          timeout: 10_000,
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    const body = response.data as WikiNodeResponse;
    if (body.code !== 0) {
      throw new Error(`创建 Wiki 节点失败：${body.msg ?? body.code}`);
    }
    return body.data?.node ?? {};
  }

  private async writeDocxBlocks(
    token: string,
    documentId: string,
    blocks: unknown[],
  ): Promise<void> {
    const response = await firstValueFrom(
      this.http.post(
        `${feishuOpenBaseUrl()}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/descendant`,
        { index: 0, descendants: blocks },
        {
          timeout: 15_000,
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    const body = response.data as DocxBlockResponse;
    if (body.code !== 0 && body.code !== undefined) {
      throw new Error(`写入 Wiki 文档块失败：${body.msg ?? body.code}`);
    }
  }
}
