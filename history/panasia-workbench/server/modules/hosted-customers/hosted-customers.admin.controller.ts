import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import {
  HostedCustomersService,
  type HostedUserContextLike,
} from './hosted-customers.service';
import {
  CreateHostedCustomerDto,
  UpdateHostedCustomerDto,
} from './hosted-customers.dto';
import type {
  HostedCustomerInfo,
  HostedCustomerListResponse,
} from '@shared/api.interface';

/** 管理端 · 托管客户档案全量管理（boss/admin）：增删改、指派负责人 */
@Controller('api/admin/hosted-customers')
export class HostedCustomersAdminController {
  constructor(private readonly service: HostedCustomersService) {}

  @NeedLogin()
  @CanRole(['boss', 'admin'])
  @Get()
  listAll(
    @Req() req: Request,
    @Query('dimension') dimension?: string,
    @Query('status') status?: string,
  ): Promise<HostedCustomerListResponse> {
    return this.service.listForAdmin(this.contextOf(req), dimension, status);
  }

  @NeedLogin()
  @CanRole(['boss', 'admin'])
  @Post()
  create(
    @Req() req: Request,
    @Body() dto: CreateHostedCustomerDto,
  ): Promise<HostedCustomerInfo> {
    return this.service.createForAdmin(this.contextOf(req), dto);
  }

  @NeedLogin()
  @CanRole(['boss', 'admin'])
  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateHostedCustomerDto,
  ): Promise<HostedCustomerInfo> {
    return this.service.updateForAdmin(this.contextOf(req), id, dto);
  }

  @NeedLogin()
  @CanRole(['boss', 'admin'])
  @Delete(':id')
  remove(@Param('id') id: string): Promise<{ ok: boolean }> {
    return this.service.deleteForAdmin(id);
  }

  private contextOf(req: Request): HostedUserContextLike {
    return {
      userId: req.userContext.userId,
      appId: req.userContext.appId,
    };
  }
}
