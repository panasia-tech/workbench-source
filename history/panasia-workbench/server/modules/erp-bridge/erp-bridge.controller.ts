import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { DemoViewService } from '../demo/demo-view.service';
import { getSessionFacts } from '../auth/session-facts';
import { ErpBridgeService, type ErpCaller } from './erp-bridge.service';
import { UpdateErpBindingDto } from './erp-bridge.dto';
import type {
  ErpBindingDeletedResponse,
  ErpBindingResponse,
  ErpEntryResponse,
} from '@shared/api.interface';

/** 员工端 · ERP 账号绑定与免登入口 */
@Controller('api/erp')
export class ErpBridgeController {
  constructor(
    private readonly erpBridge: ErpBridgeService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get('binding')
  async getBinding(@Req() req: Request): Promise<ErpBindingResponse> {
    return this.erpBridge.getBindingState(await this.callerOf(req));
  }

  @NeedLogin()
  @Put('binding')
  async upsertBinding(
    @Req() req: Request,
    @Body() dto: UpdateErpBindingDto,
  ): Promise<ErpBindingResponse> {
    return this.erpBridge.upsertBinding(await this.callerOf(req), dto);
  }

  @NeedLogin()
  @Delete('binding')
  async deleteBinding(
    @Req() req: Request,
  ): Promise<ErpBindingDeletedResponse> {
    const view = await this.demoView.resolve(req);
    const deleted = await this.erpBridge.deleteBinding(view.userId);
    return { deleted };
  }

  @NeedLogin()
  @Post('entry')
  async createEntry(@Req() req: Request): Promise<ErpEntryResponse> {
    return this.erpBridge.createEntry(await this.callerOf(req));
  }

  /**
   * 演示视角按被演示的员工算 userId，但 ERP 身份只认真实登录人自己的会话：演示视角、开发登录、
   * 10-19 之前签的会话都不算（不自动绑定、开的入口没有工作台担保，ERP 照旧要输一次密码）
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
}
