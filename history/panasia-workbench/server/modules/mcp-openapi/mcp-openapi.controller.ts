import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpOpenApiService } from './mcp-openapi.service';

@Controller('openapi/mcp')
export class McpOpenApiController {
  constructor(private readonly mcpOpenApi: McpOpenApiService) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.mcpOpenApi.handleRpc(req, res);
  }

  @Get()
  getSse(@Res() res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: '本端点为无状态 JSON 模式，不支持 GET SSE 流，请使用 POST 发送 JSON-RPC 消息',
      },
    });
  }

  @Delete()
  terminate(@Res() res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: '本端点为无状态服务器，无需 DELETE 终止会话',
      },
    });
  }
}
