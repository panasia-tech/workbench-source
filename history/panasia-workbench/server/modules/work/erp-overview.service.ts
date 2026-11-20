import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { CredentialsService } from '../integration/credentials.service';

const ERP_OVERVIEW_URL = 'http://127.0.0.1:8000';
const TOKEN_NAME = 'ERP_MIAODA_TOKEN';
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type ErpCounterField =
  | 'today_purchase'
  | 'pending_inspect'
  | 'today_inspected'
  | 'today_inbound'
  | 'today_outbound'
  | 'in_stock'
  | 'reserved';

export type ErpOverviewCounters = {
  generated_at: string;
} & Record<ErpCounterField, number>;

const COUNTER_FIELDS: ErpCounterField[] = [
  'today_purchase',
  'pending_inspect',
  'today_inspected',
  'today_inbound',
  'today_outbound',
  'in_stock',
  'reserved',
];

function isCounterResponse(data: unknown): data is ErpOverviewCounters {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.generated_at === 'string' &&
    COUNTER_FIELDS.every((field: ErpCounterField) => typeof obj[field] === 'number')
  );
}

@Injectable()
export class ErpOverviewService {
  private readonly logger = new Logger(ErpOverviewService.name);
  private cache: { data: ErpOverviewCounters; expiresAt: number } | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly credentials: CredentialsService,
  ) {}

  async getCounters(): Promise<ErpOverviewCounters | null> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.data;
    }
    const token = await this.credentials.get(TOKEN_NAME);
    if (!token) {
      this.logger.warn(`凭证 ${TOKEN_NAME} 未配置，工作台 ERP 计数不可用`);
      return null;
    }
    try {
      const response = await firstValueFrom(
        this.http.get(ERP_OVERVIEW_URL, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      if (!isCounterResponse(response.data)) {
        this.logger.warn(
          `ERP 计数响应结构不符：${JSON.stringify(response.data).slice(0, 200)}`,
        );
        return null;
      }
      this.cache = {
        data: response.data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      this.logger.warn(
        `ERP 计数接口调用失败（401=key 不对；503=ERP 侧未配 key）：status=${status ?? '无响应'} ${axiosError.message ?? String(error)}`,
      );
      return null;
    }
  }
}
