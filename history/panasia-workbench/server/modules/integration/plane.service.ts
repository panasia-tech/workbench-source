import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError, type AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import type { AxiosResponse } from 'axios';
import { integrationConfig } from './integration.config';
import { CredentialsService } from './credentials.service';

function parseRetryAfterMs(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return Number.NaN;
  const seconds: number = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at: number = Date.parse(raw);
  return Number.isNaN(at) ? Number.NaN : at - Date.now();
}

@Injectable()
export class PlaneService {
  private static readonly MAX_CONCURRENCY = 3;
  private static readonly MAX_RETRY_SLEEP_MS = 2_000;
  private readonly logger = new Logger(PlaneService.name);
  private readonly cache = new Map<string, { at: number; data: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private active = 0;
  private readonly waitQueue: Array<() => void> = [];
  private cooldownUntil = 0;

  constructor(
    private readonly http: HttpService,
    private readonly credentials: CredentialsService,
  ) {}

  private async acquire(): Promise<void> {
    if (this.active < PlaneService.MAX_CONCURRENCY) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
  }

  private release(): void {
    const next: (() => void) | undefined = this.waitQueue.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }

  private async request<T>(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    data?: unknown,
    params?: Record<string, unknown>,
  ): Promise<AxiosResponse<T>> {
    const planeApiKey = await this.credentials.get('PLANE_API_KEY');
    if (!planeApiKey) {
      throw new InternalServerErrorException(
        '未配置 PLANE_API_KEY（环境变量或系统配置），无法访问 Plane',
      );
    }
    const config: AxiosRequestConfig = {
      url: `${integrationConfig.planeBaseUrl}${path}`,
      method,
      params,
      data,
      headers: { 'X-API-Key': planeApiKey },
      timeout: 15000,
    };
    await this.acquire();
    try {
      if (Date.now() < this.cooldownUntil) {
        throw new ServiceUnavailableException(
          '外部任务系统限流冷却中，请稍后刷新',
        );
      }
      let attempt = 0;
      for (;;) {
        try {
          return await firstValueFrom(this.http.request<T>(config));
        } catch (error) {
          const status =
            error instanceof AxiosError ? error.response?.status : undefined;
          if (status === 429) {
            const remain: number = this.cooldownUntil - Date.now();
            if (remain > PlaneService.MAX_RETRY_SLEEP_MS && attempt >= 1) {
              this.logger.warn(
                `Plane API 429，全局冷却剩余 ${Math.round(remain)}ms，放弃重试`,
              );
              throw new ServiceUnavailableException(
                '外部任务系统限流冷却中，请稍后刷新',
              );
            }
            if (attempt < 3) {
              attempt += 1;
              const retryAfterHeader =
                error instanceof AxiosError
                  ? error.response?.headers?.['retry-after']
                  : undefined;
              const retryAfterMs: number = parseRetryAfterMs(retryAfterHeader);
              const cooldownMs: number =
                Number.isFinite(retryAfterMs) && retryAfterMs > 0
                  ? Math.min(retryAfterMs, 15_000)
                  : 2_500;
              this.cooldownUntil = Math.max(
                this.cooldownUntil,
                Date.now() + cooldownMs,
              );
              const backoff: number = Math.min(
                cooldownMs,
                PlaneService.MAX_RETRY_SLEEP_MS,
              );
              this.logger.warn(
                `Plane API 429，冷却 ${cooldownMs}ms、${backoff}ms 后重试（第 ${attempt} 次）`,
              );
              await this.sleep(backoff);
              const remainAfterSleep: number = this.cooldownUntil - Date.now();
              if (remainAfterSleep > PlaneService.MAX_RETRY_SLEEP_MS) {
                this.logger.warn(
                  `Plane API 429，全局冷却被并发续写（剩余 ${Math.round(
                    remainAfterSleep,
                  )}ms），放弃重试`,
                );
                throw new ServiceUnavailableException(
                  '外部任务系统限流冷却中，请稍后刷新',
                );
              }
              continue;
            }
            this.logger.warn(
              `Plane API 429，重试 ${attempt} 次后仍限流`,
            );
            throw new ServiceUnavailableException(
              '外部任务系统限流冷却中，请稍后刷新',
            );
          }
          this.logger.error(
            `Plane API ${method.toUpperCase()} ${path} 失败`,
            error instanceof AxiosError
              ? `status=${error.response?.status} body=${JSON.stringify(error.response?.data)} ${error.message}`
              : String(error),
          );
          throw error;
        }
      }
    } finally {
      this.release();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.request<T>('get', path, undefined, params);
    return res.data;
  }

  async cachedGet<T>(path: string, ttlMs = 300_000): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < ttlMs) {
      return hit.data as T;
    }
    const existing = this.inflight.get(path) as Promise<T> | undefined;
    if (existing) return existing;
    const load = (async (): Promise<T> => {
      try {
        const data = await this.get<T>(path);
        this.cache.set(path, { at: Date.now(), data });
        return data;
      } catch (error) {
        if (hit) {
          const ageSeconds = Math.round((Date.now() - hit.at) / 1000);
          this.logger.warn(
            `Plane API ${path} 拉取失败，回退 ${ageSeconds}s 前的缓存数据`,
          );
          return hit.data as T;
        }
        throw error;
      } finally {
        this.inflight.delete(path);
      }
    })();
    this.inflight.set(path, load);
    return load;
  }

  async getIssueTitle(
    issueId: string,
    projectId: string,
  ): Promise<string | null> {
    try {
      const issue = await this.cachedGet<{ name?: string }>(
        `${this.workspacePath}/projects/${projectId}/issues/${issueId}/`,
      );
      return issue?.name ?? null;
    } catch {
      return null;
    }
  }

  async listProjects<T>(): Promise<T[]> {
    const res = await this.cachedGet<{ results?: T[] }>(
      `${this.workspacePath}/projects/`,
    );
    return res.results ?? [];
  }

  async getOptional<T>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getOptionalCached<T>(
    path: string,
    ttlMs = 15_000,
  ): Promise<T | null> {
    try {
      return await this.cachedGet<T>(path, ttlMs);
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async post<T>(path: string, data: unknown): Promise<T> {
    const res = await this.request<T>('post', path, data);
    this.cache.clear();
    return res.data;
  }

  async patch<T>(path: string, data: unknown): Promise<T> {
    const res = await this.request<T>('patch', path, data);
    this.cache.clear();
    return res.data;
  }

  async delete(path: string): Promise<void> {
    await this.request<unknown>('delete', path);
    this.cache.clear();
  }

  get workspaceSlug(): string {
    return integrationConfig.planeWorkspaceSlug;
  }

  get workspacePath(): string {
    return `/workspaces/${integrationConfig.planeWorkspaceSlug}`;
  }
}
