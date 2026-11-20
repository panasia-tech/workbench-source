import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { inArray } from 'drizzle-orm';
import { firstValueFrom } from 'rxjs';

import { employeeBindings } from '@server/database/schema';
import type { NotificationCategory } from '@shared/api.interface';
import { CredentialsService } from './credentials.service';
import { LoginAccountService } from '../auth/login-account.service';
import { InboxService } from '../notifications/inbox.service';
import { feishuOpenBaseUrl, isFeatureEnabled } from './optional-features';

const REQUEST_TIMEOUT_MS = 10_000;
/** 飞书通知默认开：没配应用凭证时整个进程只提醒一次，不然每条通知都刷一行警告 */
let warnedMissingFeishuApp = false;
/** 飞书 tenant_access_token 有效期约 2 小时，提前 5 分钟换 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

interface FeishuResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface Receiver {
  type: 'open_id' | 'email';
  id: string;
}

export interface NotifyOptions {
  /** 站内消息点开后跳去的前端路由（以 / 开头）；不传 = 只看不跳 */
  link?: string | null;
  category?: NotificationCategory;
}

/**
 * 通知：站内消息是主通道，飞书是可选的第二通道（10-18 定：工作台脱离飞书独立使用）。
 *
 * 1. 每条先写站内消息（workbench_notifications，员工在右上角铃铛里看）；
 * 2. 只有 FEISHU_NOTIFY_ENABLED 打开时，才另用自有飞书应用的机器人发一张卡片
 *    （FEISHU_APP_ID / FEISHU_APP_SECRET，环境变量或 system_configs 的 env.*；
 *    收件人取 workbench_login_accounts 的 feishu_open_id，空着就用登录时 IdP 给的邮箱）。
 *    飞书发送不等结果、失败只记日志。
 * 全程不抛错（调用方多数是 fire-and-forget）。
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);
  private tokenCache: { appId: string; token: string; expiresAt: number } | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly http: HttpService,
    private readonly credentials: CredentialsService,
    private readonly accounts: LoginAccountService,
    private readonly inbox: InboxService,
  ) {}

  /** 站内消息至少写进一人返回 true */
  async sendToUsers(
    userIds: string[],
    title: string,
    content: string,
    options: NotifyOptions = {},
  ): Promise<boolean> {
    const targets: string[] = [
      ...new Set(userIds.filter((id: string) => Boolean(id))),
    ];
    if (targets.length === 0) {
      this.logger.warn(`notify skipped: no valid receiverIds（${title}）`);
      return false;
    }
    const delivered = await this.inbox.deliver(targets, {
      title,
      body: content,
      link: options.link ?? null,
      category: options.category,
    });
    if (isFeatureEnabled('feishuNotify')) {
      void this.sendFeishu(targets, title, content);
    }
    return delivered > 0;
  }

  /** 按 Plane 成员发：反查 employee_bindings 得到妙搭 userId（没绑定的人静默跳过） */
  async sendToPlaneMembers(
    planeMemberIds: string[],
    title: string,
    content: string,
    options: NotifyOptions = {},
  ): Promise<boolean> {
    const memberIds = [...new Set(planeMemberIds.filter((id: string) => Boolean(id)))];
    if (memberIds.length === 0) return false;
    try {
      const rows: { miaodaUserId: string | null }[] = await this.db
        .select({ miaodaUserId: employeeBindings.miaodaUserId })
        .from(employeeBindings)
        .where(inArray(employeeBindings.planeMemberId, memberIds));
      const userIds = rows
        .map((row: { miaodaUserId: string | null }) => row.miaodaUserId)
        .filter((id: string | null): id is string => Boolean(id));
      if (userIds.length === 0) return false;
      return await this.sendToUsers(userIds, title, content, options);
    } catch (error) {
      this.logger.warn(
        `通知收件人反查失败（${title}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /** 飞书第二通道：至少送达一人返回 true；任何失败只记日志 */
  private async sendFeishu(
    targets: string[],
    title: string,
    content: string,
  ): Promise<boolean> {
    try {
      const appId = await this.credentials.get('FEISHU_APP_ID');
      const appSecret = await this.credentials.get('FEISHU_APP_SECRET');
      if (!appId || !appSecret) {
        if (!warnedMissingFeishuApp) {
          warnedMissingFeishuApp = true;
          this.logger.warn(
            '飞书通知开着但没配 FEISHU_APP_ID / FEISHU_APP_SECRET，通知只发站内消息（本进程只提醒这一次）',
          );
        }
        return false;
      }
      const directory = await this.accounts.findNotifyTargets(targets);
      const token = await this.getTenantToken(appId, appSecret);
      let delivered = 0;
      for (const userId of targets) {
        const entry = directory.get(userId);
        const receiver: Receiver | null = entry?.openId
          ? { type: 'open_id', id: entry.openId }
          : entry?.email
            ? { type: 'email', id: entry.email }
            : null;
        if (!receiver) {
          this.logger.warn(
            `用户 ${userId} 没有飞书 open_id 也没有邮箱（workbench_login_accounts），「${title}」的飞书卡片未发给他`,
          );
          continue;
        }
        if (await this.sendCard(token, receiver, title, content, userId)) {
          delivered += 1;
        }
      }
      return delivered > 0;
    } catch (error) {
      this.logger.warn(
        `飞书通知发送失败，已忽略（${title}，${targets.length} 人）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async getTenantToken(appId: string, appSecret: string): Promise<string> {
    if (
      this.tokenCache &&
      this.tokenCache.appId === appId &&
      this.tokenCache.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS
    ) {
      return this.tokenCache.token;
    }
    const response = await firstValueFrom(
      this.http.post(
        `${feishuOpenBaseUrl()}/open-apis/auth/v3/tenant_access_token/internal`,
        { app_id: appId, app_secret: appSecret },
        { timeout: REQUEST_TIMEOUT_MS },
      ),
    );
    const body = response.data as FeishuResponse;
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败：${body.msg ?? body.code}`);
    }
    this.tokenCache = {
      appId,
      token: body.tenant_access_token,
      expiresAt: Date.now() + (body.expire ?? 7200) * 1000,
    };
    return this.tokenCache.token;
  }

  /** 发一张「标题 + markdown 正文」消息卡片，与原平台插件的卡片样式一致（无按钮） */
  private async sendCard(
    token: string,
    receiver: Receiver,
    title: string,
    content: string,
    userId: string,
  ): Promise<boolean> {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: title },
      },
      elements: [{ tag: 'markdown', content }],
    };
    try {
      const response = await firstValueFrom(
        this.http.post(
          `${feishuOpenBaseUrl()}/open-apis/im/v1/messages`,
          {
            receive_id: receiver.id,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
          {
            params: { receive_id_type: receiver.type },
            headers: { Authorization: `Bearer ${token}` },
            timeout: REQUEST_TIMEOUT_MS,
          },
        ),
      );
      const body = response.data as FeishuResponse;
      if (body.code !== 0) {
        this.logger.warn(
          `飞书消息发送失败（user=${userId} ${receiver.type}）：${body.code} ${body.msg ?? ''}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `飞书消息发送失败（user=${userId} ${receiver.type}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
