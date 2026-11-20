import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { HostedCustomersService } from './hosted-customers.service';
import {
  CreateHostedCustomerDto,
  UpdateHostedCustomerDto,
} from './hosted-customers.dto';
import type {
  HostedCustomerInfo,
  HostedCustomerListResponse,
} from '@shared/api.interface';

/** 员工端 · 我的托管客户档案：只看/管自己负责的（owner=本人） */
@Controller('api/my/hosted-customers')
export class HostedCustomersController {
  constructor(private readonly service: HostedCustomersService) {}

  @NeedLogin()
  @Get()
  listMine(
    @Req() req: Request,
    @Query('dimension') dimension?: string,
  ): Promise<HostedCustomerListResponse> {
    return this.service.listForUser(req.userContext.userId, dimension);
  }

  @NeedLogin()
  @Post()
  createMine(
    @Req() req: Request,
    @Body() dto: CreateHostedCustomerDto,
  ): Promise<HostedCustomerInfo> {
    return this.service.createForUser(req.userContext.userId, dto);
  }

  @NeedLogin()
  @Patch(':id')
  updateMine(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateHostedCustomerDto,
  ): Promise<HostedCustomerInfo> {
    return this.service.updateForUser(req.userContext.userId, id, dto);
  }
}
