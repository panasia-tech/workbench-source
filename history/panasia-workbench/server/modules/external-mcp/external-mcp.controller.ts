import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';

import { ExternalMcpService } from './external-mcp.service';
import type {
  ExternalMcpListResponse,
  ExternalMcpServerResponse,
  ExternalMcpUpsertRequest,
} from '@shared/api.interface';

export class ExternalMcpCreateDto implements ExternalMcpUpsertRequest {
  @IsString()
  name!: string;

  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  authHeader?: string | null;

  @IsOptional()
  @IsString()
  secret?: string;

  @IsOptional()
  @IsString()
  purpose?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ExternalMcpPatchDto implements Partial<ExternalMcpUpsertRequest> {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  authHeader?: string | null;

  @IsOptional()
  @IsString()
  secret?: string;

  @IsOptional()
  @IsString()
  purpose?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** 外部 MCP 登记与连通测试（11-10 销售工作台 A03）：管理 → 外部 MCP，老板 / 管理员 */
@Controller('api/admin/external-mcp')
export class ExternalMcpController {
  constructor(private readonly service: ExternalMcpService) {}

  @Get()
  @CanRole(['boss', 'admin'])
  list(): Promise<ExternalMcpListResponse> {
    return this.service.list();
  }

  @Post()
  @CanRole(['boss', 'admin'])
  async create(
    @Req() req: Request,
    @Body() dto: ExternalMcpCreateDto,
  ): Promise<ExternalMcpServerResponse> {
    return { item: await this.service.create(req.userContext.userId ?? null, dto) };
  }

  @Patch(':id')
  @CanRole(['boss', 'admin'])
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ExternalMcpPatchDto,
  ): Promise<ExternalMcpServerResponse> {
    return { item: await this.service.update(req.userContext.userId ?? null, id, dto) };
  }

  @Delete(':id')
  @CanRole(['boss', 'admin'])
  remove(@Req() req: Request, @Param('id') id: string): Promise<{ ok: boolean }> {
    return this.service.remove(req.userContext.userId ?? null, id);
  }

  @Post(':id/test')
  @CanRole(['boss', 'admin'])
  async test(@Param('id') id: string): Promise<ExternalMcpServerResponse> {
    return { item: await this.service.test(id) };
  }
}
