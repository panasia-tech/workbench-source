import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import type {
  AccountCenterResponse,
  UpdateAccountProfileRequest,
  UpdateAccountProfileResponse,
} from '@shared/api.interface';
import { AccountService } from './account.service';

@Controller('api/my/account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  async getAccountCenter(
    @Req() req: Request,
  ): Promise<AccountCenterResponse> {
    return this.accountService.getAccountCenter(req);
  }

  @Put()
  async updateProfile(
    @Req() req: Request,
    @Body() dto: UpdateAccountProfileRequest,
  ): Promise<UpdateAccountProfileResponse> {
    const viewProfile = await this.accountService.updateProfile(req, dto);
    return { viewProfile };
  }
}
