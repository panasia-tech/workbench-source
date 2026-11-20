import {
  BadGatewayException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import type { Request } from 'express';
import { DemoViewService } from '../demo/demo-view.service';
import { getSessionFacts } from '../auth/session-facts';
import {
  ErpBridgeService,
  type ErpCaller,
} from '../erp-bridge/erp-bridge.service';
import { ErpTokenService } from './erp-token.service';

const ERP_API_BASE =
  (process.env.ERP_API_BASE ?? '').trim() || 'http://127.0.0.1:8000';
const REQUEST_TIMEOUT_MS = 10_000;
const ACTIVITY_PAGE_SIZE = 20;

function queryOf(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.trim()) {
      qs.set(key, value.trim());
    }
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

function toNonNegativeInt(raw: string | undefined, fallback: number): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

/**
 * 员工端 · ERP 业务接口原生代理。「工作」tab 不再 iframe 嵌 H5，工作台页面直接读这些数据：
 * 每个端点要求 ERP 身份且绑定的就是本人（同 erp-bridge 免密口径），服务端代持员工 JWT 转发，
 * ERP 角色权限照常生效。管理端点另要求 me.staff.role === 'ADMIN'。
 */
@Controller('api/erp-api')
export class ErpApiController {
  constructor(
    private readonly erpBridge: ErpBridgeService,
    private readonly erpToken: ErpTokenService,
    private readonly demoView: DemoViewService,
    private readonly http: HttpService,
  ) {}

  @NeedLogin()
  @Get('me')
  async me(@Req() req: Request): Promise<unknown> {
    const caller = await this.assertPasswordFree(req);
    return this.erpGet(caller.userId, '/api/auth/me');
  }

  @NeedLogin()
  @Get('dashboard/summary')
  async summary(@Req() req: Request): Promise<unknown> {
    const caller = await this.assertPasswordFree(req);
    return this.erpGet(caller.userId, '/api/dashboard/summary');
  }

  @NeedLogin()
  @Get('dashboard/workload')
  async workload(@Req() req: Request): Promise<unknown> {
    const caller = await this.assertPasswordFree(req);
    return this.erpGet(caller.userId, '/api/dashboard/workload');
  }

  @NeedLogin()
  @Get('dashboard/commission')
  async commission(
    @Req() req: Request,
    @Query('period') period?: string,
  ): Promise<unknown> {
    const caller = await this.assertPasswordFree(req);
    return this.erpGet(
      caller.userId,
      `/api/dashboard/commission${queryOf({ period })}`,
    );
  }

  @NeedLogin()
  @Get('dashboard/payslip')
  async payslip(
    @Req() req: Request,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
  ): Promise<unknown> {
    const caller = await this.assertPasswordFree(req);
    return this.erpGet(
      caller.userId,
      `/api/dashboard/payslip${queryOf({ date_from: dateFrom, date_to: dateTo })}`,
    );
  }

  @NeedLogin()
  @Get('dashboard/admin-stats')
  async adminStats(
    @Req() req: Request,
    @Query('period') period?: string,
  ): Promise<unknown> {
    const caller = await this.assertErpAdmin(req);
    return this.erpGet(
      caller.userId,
      `/api/dashboard/admin-stats${queryOf({ period })}`,
    );
  }

  @NeedLogin()
  @Get('dashboard/activities')
  async activities(
    @Req() req: Request,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const caller = await this.assertErpAdmin(req);
    return this.erpGet(
      caller.userId,
      `/api/dashboard/activities${queryOf({
        offset: String(toNonNegativeInt(offset, 0)),
        limit: String(toNonNegativeInt(limit, ACTIVITY_PAGE_SIZE)),
      })}`,
    );
  }

  /**
   * 口径同 erp-bridge.controller：演示视角按被演示的员工算 userId，
   * 但 ERP 身份只认真实登录人自己的会话
   */
  private async callerOf(req: Request): Promise<ErpCaller> {
    const view = await this.demoView.resolve(req);
    const facts = getSessionFacts(req);
    const ownSession =
      !view.demoAs && facts !== null && facts.kind === 'oidc' && facts.userId === view.userId;
    return {
      userId: view.userId,
      erpIdentity: ownSession && facts.erpIdentity,
      loginName: ownSession ? facts.loginName : null,
    };
  }

  /** 所有业务端点的门槛：ERP 身份，且绑定的就是本人（getBindingState 的 passwordFree 口径） */
  private async assertPasswordFree(req: Request): Promise<ErpCaller> {
    const caller = await this.callerOf(req);
    const state = await this.erpBridge.getBindingState(caller);
    if (!state.passwordFree) {
      throw new ForbiddenException(
        '需要 ERP 身份且绑定的就是本人账号（可在「我的」页绑定或改回本人）',
      );
    }
    return caller;
  }

  /** 管理端点另查 ERP 角色（ERP 自己的管理员，与工作台 boss/admin 平台角色是两回事） */
  private async assertErpAdmin(req: Request): Promise<ErpCaller> {
    const caller = await this.assertPasswordFree(req);
    const me = (await this.erpGet(caller.userId, '/api/auth/me')) as {
      staff?: { role?: unknown };
    };
    if (me?.staff?.role !== 'ADMIN') {
      throw new ForbiddenException('仅 ERP 管理员可见');
    }
    return caller;
  }

  /** 透传 ERP JSON；ERP 的 4xx 把中文 detail 和状态码透给前端，网络错/5xx 统一 502 */
  private async erpGet(
    userId: string,
    path: string,
    allowRetry = true,
  ): Promise<unknown> {
    const token = await this.erpToken.tokenFor(userId);
    try {
      const response = await firstValueFrom(
        this.http.get(`${ERP_API_BASE}${path}`, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError<{ detail?: string }>;
      const status = axiosError.response?.status;
      // 缓存的员工 JWT 被 ERP 拒（如 ERP 重启换签发密钥）：丢缓存换新令牌重试一次
      if (status === 401 && allowRetry) {
        this.erpToken.invalidate(userId);
        return this.erpGet(userId, path, false);
      }
      const detail = axiosError.response?.data?.detail;
      if (status && detail) {
        throw new HttpException(detail, status);
      }
      throw new BadGatewayException('ERP 暂时连不上，请稍后重试');
    }
  }
}
