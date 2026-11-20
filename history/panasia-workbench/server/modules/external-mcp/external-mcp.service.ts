import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { asc, eq } from 'drizzle-orm';

import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  EXTERNAL_MCP_SERVERS_DDL,
  externalMcpServers,
} from '@server/database/standalone-schema';
import type {
  ExternalMcpListResponse,
  ExternalMcpServerView,
  ExternalMcpUpsertRequest,
} from '@shared/api.interface';
import { AuthConfig } from '../auth/auth.config';
import { AuditService } from '../integration/audit.service';
import { authHeaders, probeMcpServer } from './mcp-probe';
import { deriveSecretKey, openSecret, sealSecret } from './secret-box';

type ServerRow = typeof externalMcpServers.$inferSelect;

/** 测试连接整趟的超时：初始化 + 列工具，正常的服务一两秒就回 */
const PROBE_TIMEOUT_MS = 8_000;
const URL_MAX = 2000;
const SECRET_MAX = 4000;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,100}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

function normalizeUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw new BadRequestException('请填地址');
  if (value.length > URL_MAX) throw new BadRequestException('地址太长');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('地址看不懂，要 http:// 或 https:// 开头');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('地址要 http:// 或 https:// 开头');
  }
  return parsed.toString();
}

function normalizeHeader(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return null;
  if (!HEADER_NAME_RE.test(value)) {
    throw new BadRequestException('请求头名只能是字母、数字和横线，如 X-Api-Key');
  }
  return value;
}

function cleanText(raw: unknown, max: number): string | null {
  const value = typeof raw === 'string' ? raw.trim().slice(0, max) : '';
  return value === '' ? null : value;
}

/**
 * 外部 MCP 登记（11-10 销售工作台 A03）：名称、地址、密钥、用途、启停；「测试连接」真去连
 * （initialize + tools/list，8 秒超时），结果存在行上，列表里能看到上次测的结果和工具数。
 * 密钥 AES-256-GCM 加密存、从不回显。表启动时自建。只有老板、管理员能看能改。
 */
@Injectable()
export class ExternalMcpService implements OnModuleInit {
  private readonly logger = new Logger(ExternalMcpService.name);
  private readonly secretKey: Buffer;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    config: AuthConfig,
    private readonly audit: AuditService,
  ) {
    this.secretKey = deriveSecretKey(config.sessionSecret);
  }

  async onModuleInit(): Promise<void> {
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'external_mcp_servers',
      EXTERNAL_MCP_SERVERS_DDL,
      '外部 MCP 登记不可用',
    );
  }

  async list(): Promise<ExternalMcpListResponse> {
    const rows = await this.db
      .select()
      .from(externalMcpServers)
      .orderBy(asc(externalMcpServers.createdAt));
    return { items: rows.map((row: ServerRow) => this.toView(row)) };
  }

  async create(
    operatorId: string | null,
    dto: ExternalMcpUpsertRequest,
  ): Promise<ExternalMcpServerView> {
    const name = cleanText(dto.name, 100);
    if (!name) throw new BadRequestException('请填名称');
    const url = normalizeUrl(dto.url);
    const secret = cleanText(dto.secret, SECRET_MAX);
    try {
      const rows = await this.db
        .insert(externalMcpServers)
        .values({
          name,
          url,
          authHeader: normalizeHeader(dto.authHeader),
          secretEnc: secret ? sealSecret(this.secretKey, secret) : null,
          purpose: cleanText(dto.purpose, 2000),
          enabled: dto.enabled ?? true,
          createdBy: operatorId,
        })
        .returning();
      void this.audit.log({
        action: 'external_mcp_create',
        operatorId: operatorId ?? undefined,
        targetType: 'external_mcp',
        targetId: rows[0].id,
        detail: { summary: `登记外部 MCP「${name}」${url}` },
      });
      return this.toView(rows[0]);
    } catch (error) {
      if (pgCode(error) === '23505') throw new ConflictException('名称重复了');
      throw error;
    }
  }

  async update(
    operatorId: string | null,
    id: string,
    dto: Partial<ExternalMcpUpsertRequest>,
  ): Promise<ExternalMcpServerView> {
    await this.load(id);
    const patch: Partial<typeof externalMcpServers.$inferInsert> = {};
    const changed: string[] = [];
    if (dto.name !== undefined) {
      const name = cleanText(dto.name, 100);
      if (!name) throw new BadRequestException('请填名称');
      patch.name = name;
      changed.push('名称');
    }
    if (dto.url !== undefined) {
      patch.url = normalizeUrl(dto.url);
      changed.push('地址');
    }
    if (dto.authHeader !== undefined) {
      patch.authHeader = normalizeHeader(dto.authHeader);
      changed.push('请求头');
    }
    // 密钥：不传不动；传空串 = 清掉；传了值 = 换新
    if (dto.secret !== undefined) {
      const secret = cleanText(dto.secret, SECRET_MAX);
      patch.secretEnc = secret ? sealSecret(this.secretKey, secret) : null;
      changed.push(secret ? '密钥' : '清掉密钥');
    }
    if (dto.purpose !== undefined) {
      patch.purpose = cleanText(dto.purpose, 2000);
      changed.push('用途');
    }
    if (dto.enabled !== undefined) {
      patch.enabled = dto.enabled;
      changed.push(dto.enabled ? '启用' : '停用');
    }
    if (changed.length === 0) throw new BadRequestException('没有要改的');
    patch.updatedAt = new Date();
    try {
      const rows = await this.db
        .update(externalMcpServers)
        .set(patch)
        .where(eq(externalMcpServers.id, id))
        .returning();
      void this.audit.log({
        action: 'external_mcp_update',
        operatorId: operatorId ?? undefined,
        targetType: 'external_mcp',
        targetId: id,
        detail: { summary: `改外部 MCP「${rows[0].name}」：${changed.join('、')}` },
      });
      return this.toView(rows[0]);
    } catch (error) {
      if (pgCode(error) === '23505') throw new ConflictException('名称重复了');
      throw error;
    }
  }

  async remove(operatorId: string | null, id: string): Promise<{ ok: boolean }> {
    const row = await this.load(id);
    await this.db.delete(externalMcpServers).where(eq(externalMcpServers.id, id));
    void this.audit.log({
      action: 'external_mcp_delete',
      operatorId: operatorId ?? undefined,
      targetType: 'external_mcp',
      targetId: id,
      detail: { summary: `删外部 MCP「${row.name}」` },
    });
    return { ok: true };
  }

  /** 真去连一次：initialize + tools/list；结果存到行上（停用的也能测） */
  async test(id: string): Promise<ExternalMcpServerView> {
    const row = await this.load(id);
    let secret: string | null = null;
    if (row.secretEnc) {
      secret = openSecret(this.secretKey, row.secretEnc);
    }
    const at = new Date();
    let patch: Partial<typeof externalMcpServers.$inferInsert>;
    if (row.secretEnc && secret === null) {
      patch = {
        lastTestAt: at,
        lastTestOk: false,
        lastTestMessage: '存的密钥解不开（服务器会话密钥换过），请重新填一次密钥',
        lastToolCount: null,
        lastTools: [],
        lastLatencyMs: null,
      };
    } else {
      const result = await probeMcpServer({
        url: row.url,
        headers: authHeaders(row.authHeader, secret),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (!result.ok) {
        this.logger.warn(`外部 MCP「${row.name}」测试没连上：${result.message}`);
      }
      patch = {
        lastTestAt: at,
        lastTestOk: result.ok,
        lastTestMessage: result.message,
        lastToolCount: result.toolCount,
        lastTools: result.tools,
        lastLatencyMs: result.latencyMs,
      };
    }
    const rows = await this.db
      .update(externalMcpServers)
      .set(patch)
      .where(eq(externalMcpServers.id, id))
      .returning();
    return this.toView(rows[0] ?? { ...row, ...patch });
  }

  private async load(id: string): Promise<ServerRow> {
    if (!UUID_RE.test(id)) throw new NotFoundException('没有这条登记');
    const rows = await this.db
      .select()
      .from(externalMcpServers)
      .where(eq(externalMcpServers.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('没有这条登记');
    return rows[0];
  }

  private toView(row: ServerRow): ExternalMcpServerView {
    const tools = Array.isArray(row.lastTools)
      ? row.lastTools.filter((name: unknown): name is string => typeof name === 'string')
      : [];
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      authHeader: row.authHeader,
      hasSecret: !!row.secretEnc,
      purpose: row.purpose,
      enabled: row.enabled,
      lastTest: row.lastTestAt
        ? {
            ok: row.lastTestOk === true,
            at: row.lastTestAt.toISOString(),
            message: row.lastTestMessage ?? '',
            toolCount: row.lastToolCount,
            tools,
            latencyMs: row.lastLatencyMs,
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
