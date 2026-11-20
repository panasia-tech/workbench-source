import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { AxiosError, type AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import { integrationConfig } from './integration.config';
import { CredentialsService } from './credentials.service';
import { feishuOpenBaseUrl } from './optional-features';

interface TenantTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface AilyEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

/**
 * 豆包（飞书 aily）OpenAPI：会话 / 运行 / 取结果。调用方各有开关（optional-features.ts，默认全开）：
 * 工单 AI 初审、快速下任务 AI 草稿、堵塞 AI 生成 SOP；开关关着时调用方不会走到这里。
 */
@Injectable()
export class AilyOpenApiService {
  private readonly logger = new Logger(AilyOpenApiService.name);
  private readonly tokenExpiresSoonCode = 99991663;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly credentials: CredentialsService,
  ) {}

  /** 飞书开放平台地址可配（FEISHU_OPEN_BASE_URL），与通知、Wiki 同一个 */
  private get baseUrl(): string {
    return `${feishuOpenBaseUrl()}/open-apis`;
  }

  private async ensureConfigured(): Promise<string> {
    const appSecret = await this.credentials.get('AILY_APP_SECRET');
    if (!appSecret) {
      throw new InternalServerErrorException(
        '未配置 AILY_APP_SECRET（环境变量或系统配置），智能体委派暂不可用',
      );
    }
    return appSecret;
  }

  private async getTenantAccessToken(): Promise<string> {
    const appSecret = await this.ensureConfigured();
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    const res = await firstValueFrom(
      this.http.post<TenantTokenResponse>(
        `${this.baseUrl}/auth/v3/tenant_access_token/internal`,
        {
          app_id: integrationConfig.ailyAppId,
          app_secret: appSecret,
        },
        { timeout: 15000 },
      ),
    );
    const body = res.data;
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new InternalServerErrorException(
        `获取豆包工作伙伴访问令牌失败：${body.msg ?? body.code}`,
      );
    }
    const expireMs = (body.expire ?? 3600) * 1000;
    this.token = {
      value: body.tenant_access_token,
      expiresAt: Date.now() + expireMs - 5 * 60 * 1000,
    };
    return this.token.value;
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    data?: unknown,
  ): Promise<T> {
    const token = await this.getTenantAccessToken();
    const config: AxiosRequestConfig = {
      url: `${this.baseUrl}${path}`,
      method,
      data,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    };
    for (let attempt = 0; ; attempt += 1) {
      let envelope: AilyEnvelope<T> | undefined;
      try {
        const res = await firstValueFrom(
          this.http.request<AilyEnvelope<T>>(config),
        );
        envelope = res.data;
      } catch (error) {
        const axiosError =
          error instanceof AxiosError ? error : undefined;
        const body = axiosError?.response?.data as
          | AilyEnvelope<T>
          | undefined;
        if (body) {
          envelope = body;
        } else {
          throw new InternalServerErrorException(
            `豆包工作伙伴接口请求失败：${axiosError?.message ?? '未知错误'}`,
          );
        }
      }
      if (
        envelope?.code === this.tokenExpiresSoonCode &&
        attempt === 0
      ) {
        this.token = null;
        config.headers = {
          Authorization: `Bearer ${await this.getTenantAccessToken()}`,
        };
        continue;
      }
      if (!envelope || envelope.code !== 0) {
        throw new InternalServerErrorException(
          `豆包工作伙伴接口错误 ${envelope?.code ?? 'unknown'}：${envelope?.msg ?? '无错误信息'}`,
        );
      }
      return envelope.data as T;
    }
  }

  async createSession(agentId: string): Promise<string> {
    const data = await this.request<{ session_id?: string }>(
      'post',
      `/aily/v1/agents/${agentId}/sessions`,
      {},
    );
    if (!data?.session_id) {
      throw new InternalServerErrorException('创建豆包会话失败');
    }
    return data.session_id;
  }

  async createRun(
    agentId: string,
    sessionId: string,
    text: string,
  ): Promise<string> {
    const data = await this.request<{ agent_chat_id?: string }>(
      'post',
      `/aily/v1/agents/${agentId}/sessions/${sessionId}/runs`,
      { user_message: { content: [{ type: 'text', text }] } },
    );
    if (!data?.agent_chat_id) {
      throw new InternalServerErrorException('发起豆包对话失败');
    }
    return data.agent_chat_id;
  }

  async getChat(
    agentId: string,
    chatId: string,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'get',
      `/aily/v1/agents/${agentId}/agent_chats/${chatId}`,
    );
  }

  extractTextFromContent(content: unknown): string | null {
    if (typeof content === 'string' && content.trim()) {
      return content;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content as Array<Record<string, unknown>>) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          parts.push(item.text);
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
    return null;
  }

  extractChatReply(chat: Record<string, unknown>): string | null {
    const messages = chat.messages ?? chat.message_list ?? chat.chats;
    if (Array.isArray(messages)) {
      const replies: string[] = [];
      for (const message of messages as Array<Record<string, unknown>>) {
        const text = this.extractTextFromContent(
          message.content ?? message.body ?? message.text,
        );
        if (text) replies.push(text);
      }
      if (replies.length > 0) return replies[replies.length - 1];
    }
    const direct = chat.answer ?? chat.reply ?? chat.response;
    if (typeof direct === 'string' && direct.trim()) {
      return direct;
    }
    if (direct && typeof direct === 'object') {
      const text = this.extractTextFromContent(direct);
      if (text) return text;
    }
    return null;
  }
}
