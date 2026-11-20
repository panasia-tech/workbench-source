import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import { AdminManageService } from './admin-manage.service';
import {
  AdminCatalogPatchDto,
  AdminCatalogUpsertDto,
  UpdateSystemConfigDto,
} from './admin.dto';
import type {
  AdminCatalogDeleteResponse,
  AdminConfigResponse,
  AdminEmployeeBindingsResponse,
  UpdateConfigResponse,
  WorkOrderCatalogItem,
  WorkOrderCatalogResponse,
} from '@shared/api.interface';

@Controller('api/admin')
export class AdminManageController {
  constructor(private readonly adminManageService: AdminManageService) {}

  @Get('config')
  @CanRole(['boss', 'admin'])
  getConfigs(): Promise<AdminConfigResponse> {
    return this.adminManageService.getConfigs();
  }

  @Put('config')
  @CanRole(['admin'])
  updateConfig(
    @Req() req: Request,
    @Body() dto: UpdateSystemConfigDto,
  ): Promise<UpdateConfigResponse> {
    return this.adminManageService.updateConfig(req.userContext.userId, dto);
  }

  @Get('catalog')
  @CanRole(['boss', 'admin'])
  listCatalog(): Promise<WorkOrderCatalogResponse> {
    return this.adminManageService.listCatalog();
  }

  @Post('catalog')
  @CanRole(['admin'])
  createCatalog(
    @Req() req: Request,
    @Body() dto: AdminCatalogUpsertDto,
  ): Promise<WorkOrderCatalogItem> {
    return this.adminManageService.createCatalog(req.userContext.userId, dto);
  }

  @Patch('catalog/:id')
  @CanRole(['admin'])
  updateCatalog(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: AdminCatalogPatchDto,
  ): Promise<WorkOrderCatalogItem> {
    return this.adminManageService.updateCatalog(
      req.userContext.userId,
      id,
      dto,
    );
  }

  @Delete('catalog/:id')
  @CanRole(['admin'])
  deleteCatalog(@Param('id') id: string): Promise<AdminCatalogDeleteResponse> {
    return this.adminManageService.deleteCatalog(id);
  }

  @Get('employees')
  @CanRole(['boss', 'admin'])
  listEmployees(@Req() req: Request): Promise<AdminEmployeeBindingsResponse> {
    return this.adminManageService.listEmployeeBindings({
      userId: req.userContext.userId,
      appId: req.userContext.appId,
    });
  }
}
