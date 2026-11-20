import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { Request } from 'express';
import { z } from 'zod';
import {
  MCP_TOOLS_METADATA_KEY,
  MCP_TOOL_METADATA_KEY,
  type McpContext,
  McpToolError,
} from '@lark-apaas/fullstack-nestjs-core';

interface RegisteredTool {
  name: string;
  title: string | undefined;
  description: string;
  inputSchema: z.ZodType;
  jsonInputSchema: Record<string, unknown>;
  annotations: Record<string, unknown> | undefined;
  handler: DynamicToolHandler;
}

interface DynamicToolHandler {
  (input: Record<string, unknown>, ctx: McpContext): unknown;
}

interface ToolMethodOptions {
  name: string | undefined;
  title: string | undefined;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown> | undefined;
}

function readToolMethodMeta(value: unknown): ToolMethodOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const options = value as {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    annotations?: unknown;
  };
  if (
    typeof options.description !== 'string' ||
    options.description.trim() === ''
  ) {
    return undefined;
  }
  return {
    name: typeof options.name === 'string' ? options.name : undefined,
    title: typeof options.title === 'string' ? options.title : undefined,
    description: options.description,
    inputSchema: options.inputSchema,
    annotations:
      options.annotations && typeof options.annotations === 'object'
        ? (options.annotations as Record<string, unknown>)
        : undefined,
  };
}

function toObjectSchema(schema: unknown): z.ZodType {
  const candidate = schema as { parse?: unknown } | null;
  if (candidate && typeof candidate.parse === 'function') {
    return schema as z.ZodType;
  }
  if (schema && typeof schema === 'object') {
    return z.object(schema as Record<string, z.ZodType>);
  }
  return z.object({});
}

function toPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// 工具类未使用 ctx.extra（已核实），空对象占位满足类型契约
const EMPTY_EXTRA = {} as McpContext['extra'];

/**
 * 工具可见性分档（2026-10-22 个人 API Key 上线）：
 * user = 所有登录身份可用（task_* 按本人过滤）；boss = 角色含 boss 才可见（工具内还有 assertBoss 兜底）；
 * system = 只有环境变量系统 key（豆包链路）可用，个人 key 不可见不可调——tutorial_* 无角色门禁，靠这档隔离。
 * 新工具默认落 system（fail-closed），要开放得显式改这里。
 */
type ToolTier = 'user' | 'boss' | 'system';

function tierOf(name: string): ToolTier {
  if (
    name.startsWith('task_review_') ||
    name.startsWith('workorder_') ||
    name.startsWith('delegate_') ||
    name.startsWith('schedule_') ||
    name.startsWith('block_defer_')
  ) {
    return 'boss';
  }
  if (name.startsWith('task_') || name.startsWith('agent_task_')) return 'user';
  return 'system';
}

/** 系统 key（isSystemAccount）全量可见；个人 key 按档过滤 */
function visibleTo(name: string, ctx: McpContext): boolean {
  const user = ctx.user as { isSystemAccount?: unknown; roles?: unknown } | undefined;
  if (user?.isSystemAccount === true) return true;
  const tier = tierOf(name);
  if (tier === 'user') return true;
  if (tier === 'boss') {
    return Array.isArray(user?.roles) && (user.roles as unknown[]).includes('boss');
  }
  return false;
}

@Injectable()
export class McpToolRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(McpToolRegistryService.name);
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(
    private readonly modulesContainer: ModulesContainer,
  ) {}

  onApplicationBootstrap(): void {
    for (const module of this.modulesContainer.values()) {
      for (const wrapper of module.providers.values()) {
        const metatype = wrapper.metatype;
        if (typeof metatype !== 'function') continue;
        const classOptions = Reflect.getMetadata(
          MCP_TOOLS_METADATA_KEY,
          metatype,
        );
        if (!classOptions || typeof classOptions !== 'object') continue;
        const instance = wrapper.instance;
        if (typeof instance !== 'object' || instance === null) continue;
        const prefixRecord = toPlainObject(classOptions);
        const prefix =
          typeof prefixRecord.prefix === 'string' ? prefixRecord.prefix : '';
        this.registerToolMethods(instance, prefix);
      }
    }
    this.logger.log(`MCP 桥接端点已发现 ${this.tools.size} 个工具`);
  }

  /** ctx 为空 = 不过滤（内部用）；带 ctx 按调用者身份只回他能用的 */
  listTools(ctx?: McpContext): Array<Record<string, unknown>> {
    return [...this.tools.values()]
      .filter((tool: RegisteredTool) => ctx === undefined || visibleTo(tool.name, ctx))
      .map(
        (tool: RegisteredTool): Record<string, unknown> => ({
          name: tool.name,
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: tool.jsonInputSchema,
          ...(tool.annotations !== undefined
            ? { annotations: tool.annotations }
            : {}),
        }),
      );
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: McpContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    // 无权使用的工具与不存在同一口径（-32601 TOOL_NOT_FOUND），不暴露工具是否存在
    if (!tool || !visibleTo(name, ctx)) {
      throw new McpToolError(
        `工具 ${name} 不存在。请先调用 tools/list 获取可用工具列表。`,
        { code: 'TOOL_NOT_FOUND' },
      );
    }
    const input = tool.inputSchema.parse(args) as Record<string, unknown>;
    return tool.handler(input, ctx);
  }

  buildContext(req: Request, requestId: string | number): McpContext {
    const userContext = toPlainObject(req.userContext);
    // 系统身份（openapi 系统 key）的 user_id 是数字 -1，员工身份是字符串；统一归一为 string
    const rawUserId = userContext.userId;
    const userId =
      typeof rawUserId === 'string'
        ? rawUserId
        : typeof rawUserId === 'number'
          ? String(rawUserId)
          : undefined;
    // 角色一律取闸门注入的（系统 key=boss、个人 key=本人真实角色），不再硬覆盖
    const roles = Array.isArray(userContext.roles)
      ? userContext.roles.filter((role: unknown) => typeof role === 'string')
      : [];
    const controller = new AbortController();
    return {
      user: {
        ...userContext,
        userId,
        roles,
      },
      request: req,
      signal: controller.signal,
      requestId,
      extra: EMPTY_EXTRA,
    };
  }

  private registerToolMethods(instance: object, prefix: string): void {
    const proto = Object.getPrototypeOf(instance) as object | null;
    if (proto === null) return;
    for (const methodName of Object.getOwnPropertyNames(proto)) {
      const method: unknown = Reflect.get(proto, methodName);
      // Nest SetMetadata 三参形态把元数据存在方法函数本身上（实验验证），
      // 与平台 collectFromClass 的读取方式一致
      const meta =
        typeof method === 'function'
          ? Reflect.getMetadata(MCP_TOOL_METADATA_KEY, method)
          : undefined;
      const options = readToolMethodMeta(meta);
      if (!options) continue;
      const name = `${prefix}${options.name ?? methodName}`;
      if (this.tools.has(name)) {
        this.logger.warn(`重复 MCP 工具名 ${name}，跳过后者`);
        continue;
      }
      const inputSchema = toObjectSchema(options.inputSchema);
      this.tools.set(name, {
        name,
        title: options.title,
        description: options.description,
        inputSchema,
        jsonInputSchema: z.toJSONSchema(inputSchema, {
          io: 'input',
          unrepresentable: 'any',
        }) as Record<string, unknown>,
        annotations: options.annotations,
        handler: (method as DynamicToolHandler).bind(instance),
      });
    }
  }
}
