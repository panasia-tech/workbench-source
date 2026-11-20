import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { McpToolError, type McpContext } from '@lark-apaas/fullstack-nestjs-core';
import { McpToolRegistryService } from './mcp-tool-registry.service';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'panasia-workbench';
const SERVER_VERSION = '1.0.0';
const INSTRUCTIONS =
  '泛亚员工工作台 MCP 工具集（任务查询、工单发单、任务委派、委派材料审核、教程管理、配置任务）。' +
  '身份分两种：环境变量系统 key = 老板身份（boss），全量工具可用；' +
  '个人凭证 = 本人身份——个人 API Key（wk_ 前缀，工作台「我的 → API Key」签发）或 OAuth 授权（ChatGPT 等，' +
  '员工在工作台授权页点同意），只能用本人角色可见的工具（task_* 按本人过滤，boss 工具要有 boss 角色，教程类 tutorial_* 不对个人凭证开放）。';

interface RpcOutcome {
  status: number;
  body?: unknown;
}

interface RpcMessage {
  id: string | number | undefined;
  hasId: boolean;
  method: string;
  params: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
): RpcOutcome {
  return {
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  };
}

function readMessage(value: unknown): RpcMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof candidate.method !== 'string') return undefined;
  const params =
    candidate.params && typeof candidate.params === 'object' &&
    !Array.isArray(candidate.params)
      ? (candidate.params as Record<string, unknown>)
      : {};
  return {
    id:
      typeof candidate.id === 'string' || typeof candidate.id === 'number'
        ? candidate.id
        : undefined,
    hasId: 'id' in candidate,
    method: candidate.method,
    params,
  };
}

function asTextContent(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text }];
}

@Injectable()
export class McpOpenApiService {
  private readonly logger = new Logger(McpOpenApiService.name);

  constructor(private readonly registry: McpToolRegistryService) {}

  async handleRpc(req: Request, res: Response): Promise<void> {
    const outcome = Array.isArray(req.body)
      ? await this.handleBatch(req.body as unknown[], req)
      : await this.handleSingle(req.body, req);
    if (outcome.status === 202) {
      res.status(202).end();
      return;
    }
    res.status(outcome.status).json(outcome.body);
  }

  private async handleBatch(
    messages: unknown[],
    req: Request,
  ): Promise<RpcOutcome> {
    const outcomes: RpcOutcome[] = [];
    for (const message of messages) {
      const outcome = await this.handleSingle(message, req);
      if (outcome.status === 202) continue;
      outcomes.push(outcome);
    }
    if (outcomes.length === 0) return { status: 202 };
    return {
      status: 200,
      body: outcomes.map((outcome: RpcOutcome) => outcome.body),
    };
  }

  private async handleSingle(message: unknown, req: Request): Promise<RpcOutcome> {
    const parsed = readMessage(message);
    if (!parsed) {
      return rpcError(null, -32600, 'Invalid Request：必须是 JSON-RPC 2.0 消息对象');
    }
    if (!parsed.hasId) return { status: 202 };
    switch (parsed.method) {
      case 'initialize':
        return rpcResult(parsed.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      case 'ping':
        return rpcResult(parsed.id, {});
      case 'tools/list':
        return rpcResult(parsed.id, {
          tools: this.registry.listTools(
            this.registry.buildContext(req, parsed.id ?? ''),
          ),
        });
      case 'tools/call':
        return this.handleToolsCall(parsed, req);
      default:
        return rpcError(
          parsed.id,
          -32601,
          `Method not found：${parsed.method}（仅支持 initialize / ping / tools/list / tools/call）`,
        );
    }
  }

  private async handleToolsCall(
    message: RpcMessage,
    req: Request,
  ): Promise<RpcOutcome> {
    const name = message.params.name;
    if (typeof name !== 'string' || name.trim() === '') {
      return rpcError(message.id, -32602, 'Invalid params：params.name 必填（工具名）');
    }
    const args =
      message.params.arguments && typeof message.params.arguments === 'object' &&
      !Array.isArray(message.params.arguments)
        ? (message.params.arguments as Record<string, unknown>)
        : {};
    const ctx: McpContext = this.registry.buildContext(
      req,
      message.id ?? '',
    );
    try {
      const result = await this.registry.callTool(name, args, ctx);
      return rpcResult(message.id, this.buildCallResult(result));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return rpcError(
          message.id,
          -32602,
          `Invalid params：${error.message}`,
        );
      }
      if (error instanceof McpToolError) {
        return rpcResult(message.id, {
          content: asTextContent(
            `${error.message}${error.code ? `\n[code: ${error.code}]` : ''}`,
          ),
          isError: true,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`MCP tools/call ${name} 执行失败：${detail}`, error instanceof Error ? error.stack : undefined);
      return rpcResult(message.id, {
        content: asTextContent(`工具执行失败：${detail}`),
        isError: true,
      });
    }
  }

  private buildCallResult(result: unknown): Record<string, unknown> {
    const record =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as {
            content?: unknown;
            structuredContent?: unknown;
            isError?: unknown;
          })
        : {};
    const body: Record<string, unknown> = {};
    if (Array.isArray(record.content)) {
      body.content = record.content;
    } else if (record.structuredContent !== undefined) {
      body.content = asTextContent(
        JSON.stringify(record.structuredContent, null, 2),
      );
    }
    if (record.structuredContent !== undefined) {
      body.structuredContent = record.structuredContent;
    }
    if (record.isError === true) body.isError = true;
    return body;
  }
}
