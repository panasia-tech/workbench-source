import {
  BadGatewayException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { CredentialsService } from '../integration/credentials.service';

const ERP_API_BASE =
  (process.env.ERP_API_BASE ?? '').trim() || 'http://127.0.0.1:8000';
const MIAODA_TOKEN_NAME = 'DEMO_ONLY_REDACTED';
/** 提前 5 分钟视为过期，避免拿着临界令牌调业务接口被 ERP 拒 */
const REFRESH_AHEAD_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

interface CachedEmployeeToken {
  token: string;
  expiresAt: number;
}

/**
 * 员工 JWT 代持：工作台服务端用 MIAODA_API_KEY 换某员工的 ERP 登录令牌，
 * 缓存在内存里给 erp-api 控制器转发业务接口用。令牌绝不发给浏览器。
 */
@Injectable()
export class ErpTokenService {
  private readonly logger = new Logger(ErpTokenService.name);
  private readonly cache = new Map<string, CachedEmployeeToken>();

  constructor(
    private readonly http: HttpService,
    private readonly credentials: CredentialsService,
  ) {}

  async tokenFor(userId: string): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt - REFRESH_AHEAD_MS > Date.now()) {
      return cached.token;
    }
    return this.exchange(userId, true);
  }

  /** 业务接口被 ERP 401（如 ERP 重启换密钥）时丢缓存，让下一次调用重换一枚 */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private async exchange(userId: string, allowRetry: boolean): Promise<string> {
    const miaodaToken = await this.credentials.get(MIAODA_TOKEN_NAME);
    if (!miaodaToken) {
      throw new BadGatewayException(
        'ERP 暂时连不上（工作台凭证未配置，请联系管理员）',
      );
    }
    try {
      const response = await firstValueFrom(
        this.http.post(
          `${ERP_API_BASE}/api/miaoda/employee-token`,
          { staff_id: userId },
          {
            timeout: REQUEST_TIMEOUT_MS,
            headers: { Authorization: `Bearer ${miaodaToken}` },
          },
        ),
      );
      const data = response.data as { token?: unknown; expires_in?: unknown };
      if (typeof data.token !== 'string' || !data.token) {
        throw new BadGatewayException('ERP 暂时连不上（换令牌响应异常）');
      }
      const expiresIn =
        typeof data.expires_in === 'number' && data.expires_in > 0
          ? data.expires_in
          : DEFAULT_TOKEN_TTL_SECONDS;
      this.cache.set(userId, {
        token: data.token,
        expiresAt: Date.now() + expiresIn * 1000,
      });
      return data.token;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      const axiosError = error as AxiosError<{ detail?: string }>;
      const status = axiosError.response?.status;
      // ERP 侧 401 = 换令牌被拒（凭证轮换中）：丢缓存重换一次，再不行才报错
      if (status === 401 && allowRetry) {
        this.invalidate(userId);
        return this.exchange(userId, false);
      }
      const detail = axiosError.response?.data?.detail;
      this.logger.warn(
        `ERP employee-token 失败：userId=${userId} status=${
          status ?? '无响应'
        } ${detail ?? axiosError.message ?? String(error)}`,
      );
      throw new BadGatewayException(
        `ERP 暂时连不上${detail ? `（${detail}）` : ''}`,
      );
    }
  }
}
