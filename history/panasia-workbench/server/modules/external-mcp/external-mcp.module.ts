import { Module } from '@nestjs/common';

import { ExternalMcpController } from './external-mcp.controller';
import { ExternalMcpService } from './external-mcp.service';

/** 外部 MCP 登记与连通测试（11-10 销售工作台 A03）。AuthConfig 来自全局 AuthModule，AuditService 来自全局 IntegrationModule */
@Module({
  controllers: [ExternalMcpController],
  providers: [ExternalMcpService],
})
export class ExternalMcpModule {}
