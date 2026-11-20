/**
 * 外部 MCP 连通测试（11-10 销售工作台 A03）：真去连一次——initialize → notifications/initialized → tools/list，
 * 走 MCP Streamable HTTP（POST JSON-RPC，回 JSON 或 SSE 都认）。整趟共用一个超时，超了就停。
 * 纯函数、不依赖 Nest，scripts/checks/external-mcp.check.mjs 直接拿编译产物对着本机假服务测。
 */

export const PROBE_PROTOCOL_VERSION = '2025-06-18';
/** tools/list 最多翻几页（防对面一直给 nextCursor） */
const MAX_TOOL_PAGES = 10;
/** 结果里最多带多少个工具名 */
const MAX_TOOL_NAMES = 100;
const BODY_SNIPPET = 120;

export interface McpProbeOptions {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface McpProbeResult {
  ok: boolean;
  message: string;
  toolCount: number | null;
  tools: string[];
  latencyMs: number;
  serverName: string | null;
  protocolVersion: string | null;
}

class ProbeError extends Error {}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpMessage(status: number, body: string): string {
  if (status === 401 || status === 403) return `密钥不对或没权限（HTTP ${status}）`;
  if (status === 404) return '地址不对（HTTP 404）';
  if (status === 405) {
    return '这个地址不收 POST（HTTP 405），可能是旧版 SSE 地址；只支持 Streamable HTTP';
  }
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, BODY_SNIPPET);
  return `对方回了 HTTP ${status}${snippet ? `：${snippet}` : ''}`;
}

function networkMessage(error: unknown, timeoutMs: number, timedOut: boolean): string {
  if (timedOut) return `连接超时（${Math.round(timeoutMs / 1000)} 秒没回）`;
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : null;
  const code = cause && typeof cause.code === 'string' ? cause.code : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析不了，检查地址';
  if (code === 'ECONNREFUSED') return '连不上（对方端口没开）';
  if (code === 'ECONNRESET') return '连接被对方断开';
  if (code.startsWith('CERT_') || code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return `HTTPS 证书有问题（${code}）`;
  }
  const causeMessage = cause && typeof cause.message === 'string' ? cause.message : '';
  const message = error instanceof Error ? error.message : String(error);
  return `连不上：${code || causeMessage || message}`;
}

/** 从一条 JSON-RPC 回复里取 result；报错转成人话 */
function takeResult(message: JsonRpcMessage): unknown {
  if (isRecord(message.error)) {
    const text =
      typeof message.error.message === 'string' ? message.error.message : '未知错误';
    throw new ProbeError(`对方报错：${text}`);
  }
  return message.result;
}

function matchId(candidate: unknown, id: number): JsonRpcMessage | null {
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const hit = matchId(item, id);
      if (hit) return hit;
    }
    return null;
  }
  if (isRecord(candidate) && candidate.id === id) return candidate as JsonRpcMessage;
  return null;
}

/** 读 SSE 流直到等到 id 对上的那条回复（中间的通知、进度消息跳过） */
async function readSseReply(
  body: ReadableStream<Uint8Array>,
  id: number,
): Promise<JsonRpcMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line: string) => line.startsWith('data:'))
          .map((line: string) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data !== '') {
          try {
            const hit = matchId(JSON.parse(data), id);
            if (hit) return hit;
          } catch {
            // 不是 JSON 的事件（心跳之类）跳过
          }
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  throw new ProbeError('对方的事件流结束了也没给回复');
}

export async function probeMcpServer(options: McpProbeOptions): Promise<McpProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let serverName: string | null = null;

  const post = async (
    payload: Record<string, unknown>,
    expectId: number | null,
  ): Promise<JsonRpcMessage | null> => {
    const headers: Record<string, string> = {
      ...options.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    const res = await fetch(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
      signal: controller.signal,
      redirect: 'follow',
    });
    const newSession = res.headers.get('mcp-session-id');
    if (newSession) sessionId = newSession;
    if (expectId === null) {
      // 通知：202 / 200 都行，不读内容
      if (!res.ok) throw new ProbeError(httpMessage(res.status, await res.text().catch(() => '')));
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      throw new ProbeError(httpMessage(res.status, await res.text().catch(() => '')));
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      if (!res.body) throw new ProbeError('对方回了空的事件流');
      return readSseReply(res.body, expectId);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProbeError(
        `回的不是 JSON，不像 MCP 服务${text ? `：${text.replace(/\s+/g, ' ').slice(0, BODY_SNIPPET)}` : ''}`,
      );
    }
    const hit = matchId(parsed, expectId);
    if (!hit) throw new ProbeError('回复里没有对应的结果，不像 MCP 服务');
    return hit;
  };

  try {
    const init = await post(
      {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROBE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'panasia-workbench', version: '1.0.0' },
        },
      },
      1,
    );
    const initResult = init ? takeResult(init) : null;
    if (!isRecord(initResult) || typeof initResult.protocolVersion !== 'string') {
      throw new ProbeError('initialize 没回协议版本，不像 MCP 服务');
    }
    protocolVersion = initResult.protocolVersion;
    if (isRecord(initResult.serverInfo) && typeof initResult.serverInfo.name === 'string') {
      const version =
        typeof initResult.serverInfo.version === 'string' ? ` ${initResult.serverInfo.version}` : '';
      serverName = `${initResult.serverInfo.name}${version}`;
    }

    await post({ method: 'notifications/initialized' }, null);

    const tools: string[] = [];
    let toolCount = 0;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const id = 2 + page;
      const reply = await post(
        { id, method: 'tools/list', params: cursor ? { cursor } : {} },
        id,
      );
      const result = reply ? takeResult(reply) : null;
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new ProbeError('tools/list 回的格式不对');
      }
      toolCount += result.tools.length;
      for (const tool of result.tools) {
        if (isRecord(tool) && typeof tool.name === 'string' && tools.length < MAX_TOOL_NAMES) {
          tools.push(tool.name);
        }
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : null;
      if (!cursor) break;
    }

    return {
      ok: true,
      message: `连上了${serverName ? `：${serverName}` : ''}，${toolCount} 个工具`,
      toolCount,
      tools,
      latencyMs: Date.now() - started,
      serverName,
      protocolVersion,
    };
  } catch (error) {
    const message =
      error instanceof ProbeError ? error.message : networkMessage(error, options.timeoutMs, timedOut);
    return {
      ok: false,
      message,
      toolCount: null,
      tools: [],
      latencyMs: Date.now() - started,
      serverName,
      protocolVersion,
    };
  } finally {
    clearTimeout(timer);
    // 有会话就顺手关掉（对方不支持也无所谓），不等结果
    if (sessionId) {
      const headers: Record<string, string> = { ...options.headers, 'Mcp-Session-Id': sessionId };
      if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
      void fetch(options.url, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
    }
  }
}

/** 密钥放进请求头：没指定头名 = Authorization: Bearer <密钥>；指定了就原样放进那个头 */
export function authHeaders(authHeader: string | null, secret: string | null): Record<string, string> {
  if (!secret) return {};
  const name = authHeader?.trim() ?? '';
  if (name === '') return { Authorization: `Bearer ${secret}` };
  return { [name]: secret };
}
