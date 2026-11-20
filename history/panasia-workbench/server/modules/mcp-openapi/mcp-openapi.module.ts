import { Module } from '@nestjs/common';
import { McpOpenApiController } from './mcp-openapi.controller';
import { McpOpenApiService } from './mcp-openapi.service';
import { McpToolRegistryService } from './mcp-tool-registry.service';

@Module({
  controllers: [McpOpenApiController],
  providers: [McpToolRegistryService, McpOpenApiService],
})
export class McpOpenApiModule {}
