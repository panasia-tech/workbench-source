import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { AxiosError, type AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import { integrationConfig } from './integration.config';
import { CredentialsService } from './credentials.service';

export interface FrappeListOptions {
  fields?: string[];
  filters?: unknown[][];
  limit?: number;
  orderBy?: string;
}

interface FrappeErrorBody {
  exc_type?: unknown;
  exception?: unknown;
  message?: unknown;
  _server_messages?: unknown;
}

/** Frappe 报错的异常类名（TimestampMismatchError / MandatoryError / LinkValidationError 等）；不是 Frappe 报错返回 null */
export function frappeErrorType(error: unknown): string | null {
  if (!(error instanceof AxiosError)) return null;
  const body = error.response?.data as FrappeErrorBody | undefined;
  return typeof body?.exc_type === 'string' ? body.exc_type : null;
}

/** 把 Frappe 报错整理成一句人话：优先 _server_messages 里的提示，其次 exception，再次 HTTP 状态 */
export function frappeErrorMessage(error: unknown): string {
  if (!(error instanceof AxiosError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const body = error.response?.data as FrappeErrorBody | undefined;
  if (typeof body?._server_messages === 'string') {
    try {
      const list: unknown = JSON.parse(body._server_messages);
      if (Array.isArray(list) && typeof list[0] === 'string') {
        const first: unknown = JSON.parse(list[0]);
        const text =
          first && typeof first === 'object' && 'message' in first
            ? String((first as { message: unknown }).message)
            : String(first);
        return text.replace(/<[^>]+>/g, '').trim();
      }
    } catch {
      // 解不开就往下走
    }
  }
  if (typeof body?.exception === 'string' && body.exception !== '') {
    return body.exception.replace(/^[\w.]+:\s*/, '').slice(0, 300);
  }
  if (typeof body?.message === 'string' && body.message !== '') {
    return body.message.slice(0, 300);
  }
  return error.response ? `HTTP ${error.response.status}` : error.message;
}

@Injectable()
export class FrappeService {
  private readonly logger = new Logger(FrappeService.name);

  constructor(
    private readonly http: HttpService,
    private readonly credentials: CredentialsService,
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const apiKey = await this.credentials.get('FRAPPE_API_KEY');
    const apiSecret = await this.credentials.get('FRAPPE_API_SECRET');
    return {
      Authorization: `token ${apiKey}:${apiSecret}`,
    };
  }

  private async request<T>(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    params?: Record<string, string>,
    data?: unknown,
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      url: `${integrationConfig.frappeBaseUrl}${path}`,
      method,
      params,
      data,
      headers: await this.authHeaders(),
      timeout: 15000,
    };
    const res = await firstValueFrom(this.http.request<T>(config));
    return res.data;
  }

  private resourcePath(doctype: string, name?: string): string {
    const base = `/resource/${encodeURIComponent(doctype)}`;
    return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
  }

  async list<T>(doctype: string, options: FrappeListOptions = {}): Promise<T[]> {
    const params: Record<string, string> = {
      limit_page_length: String(options.limit ?? 0),
    };
    if (options.fields) {
      params.fields = JSON.stringify(options.fields);
    }
    if (options.filters) {
      params.filters = JSON.stringify(options.filters);
    }
    if (options.orderBy) {
      params.order_by = options.orderBy;
    }
    const res = await this.request<{ data: T[] }>(
      'get',
      this.resourcePath(doctype),
      params,
    );
    return res.data ?? [];
  }

  async getOptional<T>(doctype: string, name: string): Promise<T | null> {
    try {
      const res = await this.request<{ data: T }>(
        'get',
        this.resourcePath(doctype, name),
      );
      return res.data;
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        return null;
      }
      this.logger.warn(
        `Frappe 获取 ${doctype}/${name} 失败：${
          error instanceof AxiosError ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** 读一条文档：不存在返回 null，其他错误照抛（写之前要分清「没有」和「读不到」） */
  async getDoc<T>(doctype: string, name: string): Promise<T | null> {
    try {
      const res = await this.request<{ data: T }>(
        'get',
        this.resourcePath(doctype, name),
      );
      return res.data;
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** 新建文档（POST /api/resource/:doctype），子表直接放进数组 */
  async create<T>(doctype: string, values: Record<string, unknown>): Promise<T> {
    const res = await this.request<{ data: T }>(
      'post',
      this.resourcePath(doctype),
      undefined,
      values,
    );
    return res.data;
  }

  /**
   * 改文档（PUT /api/resource/:doctype/:name）。values 里带上读到的 modified，
   * 别人在这之后改过的话 Frappe 拒绝写入（TimestampMismatchError），不会互相覆盖
   */
  async update<T>(
    doctype: string,
    name: string,
    values: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.request<{ data: T }>(
      'put',
      this.resourcePath(doctype, name),
      undefined,
      values,
    );
    return res.data;
  }

  /** 调白名单方法（/api/method/...），返回 message */
  async callMethod<T>(
    method: string,
    params: Record<string, unknown> = {},
    httpMethod: 'get' | 'post' = 'post',
  ): Promise<T> {
    const res =
      httpMethod === 'get'
        ? await this.request<{ message: T }>(
            'get',
            `/method/${method}`,
            Object.fromEntries(
              Object.entries(params).map(([key, value]) => [
                key,
                typeof value === 'string' ? value : JSON.stringify(value),
              ]),
            ),
          )
        : await this.request<{ message: T }>(
            'post',
            `/method/${method}`,
            undefined,
            params,
          );
    return res.message;
  }

  async countOptional(doctype: string, filters?: unknown[][]): Promise<number | null> {
    try {
      const rows = await this.list<{ name: string }>(doctype, {
        fields: ['name'],
        filters,
      });
      return rows.length;
    } catch (error) {
      this.logger.warn(
        `Frappe 统计 ${doctype} 失败：${
          error instanceof AxiosError ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
