/**
 * 销售工作台 A01 / A03（11-10）的离线自检：跨天截止、工单字段解析、外部 MCP 密钥加密、
 * 外部 MCP 连通测试（对着本机起的假 MCP 服务真连：JSON 回复、SSE 回复、会话头、翻页、401、超时、端口没开、不是 MCP）。
 * 不连任何外部服务。跑编译后的产物：
 *
 *   npm run build:server && node --test scripts/checks/workorder-acceptance.check.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const dispatch = require('../../dist/server/modules/workorders/dispatch-fields.js');
const fields = require('../../dist/server/modules/workorders/workorder-fields.js');
const probe = require('../../dist/server/modules/external-mcp/mcp-probe.js');
const box = require('../../dist/server/modules/external-mcp/secret-box.js');

const { resolveDispatchFields, DispatchInputException, normalizeDateString, shanghaiDateOf } = dispatch;

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DispatchInputException);
    return error.code;
  }
  return null;
};

test('跨天截止：给日期 + 时刻，dueAt 按上海时区，任务卡日期跟着走', () => {
  const now = new Date('2026-11-10T12:00:00Z'); // 上海 20:00
  const next = resolveDispatchFields(
    { title: '整理显示器型号', deadlineTime: '9:00', deadlineDate: '2026-11-12' },
    { checkPassed: true, now },
  );
  assert.equal(next.title, '整理显示器型号 09:00前');
  assert.equal(next.deadlineDate, '2026-11-12');
  assert.equal(next.dueAt.toISOString(), '2026-11-12T01:00:00.000Z');
  assert.equal(shanghaiDateOf(next.dueAt), '2026-11-12');
  // 明天早上的时刻比现在早也没关系（不是今天）
  assert.equal(
    codeOf(() =>
      resolveDispatchFields(
        { title: '对账', deadlineTime: '08:00', deadlineDate: '2026-11-11' },
        { checkPassed: true, now },
      ),
    ),
    null,
  );
  const make = (input) => () => resolveDispatchFields(input, { checkPassed: true, now });
  assert.equal(codeOf(make({ title: '对账', deadlineTime: '19:00', deadlineDate: '2026-11-10' })), 'DEADLINE_PASSED');
  assert.equal(codeOf(make({ title: '对账', deadlineTime: '19:00', deadlineDate: '2026-11-09' })), 'DEADLINE_PASSED');
  assert.equal(codeOf(make({ title: '对账', deadlineTime: '19:00', deadlineDate: '2026-02-30' })), 'DATE_INVALID');
  assert.equal(codeOf(make({ title: '对账', deadlineTime: '19:00', deadlineDate: '2028-01-01' })), 'DATE_INVALID');
  assert.equal(codeOf(make({ title: '对账', deadlineDate: '2026-11-12' })), 'DEADLINE_INVALID');
  // 存草稿不判已过
  assert.equal(
    codeOf(() =>
      resolveDispatchFields(
        { title: '对账', deadlineTime: '19:00', deadlineDate: '2026-11-09' },
        { checkPassed: false, now },
      ),
    ),
    null,
  );
  assert.equal(normalizeDateString('2026/1/5'), '2026-01-05');
  assert.equal(normalizeDateString('2026-13-01'), null);
});

test('工单字段：业务线、关联对象、需现场', () => {
  assert.equal(fields.parseBusinessLine('used_goods'), 'used_goods');
  assert.equal(fields.parseBusinessLine('二手'), null);
  assert.deepEqual(
    fields.parseSubjects([
      { kind: 'peer', name: ' 张三的店 ', ref: 'https://x' },
      { kind: 'weird', name: '某物' },
      { kind: 'product', name: '   ' },
      'bad',
    ]),
    [
      { kind: 'peer', name: '张三的店', ref: 'https://x' },
      { kind: 'other', name: '某物' },
    ],
  );
  assert.equal(fields.parseSubjects(Array.from({ length: 15 }, (_, i) => ({ kind: 'product', name: `p${i}` }))).length, 10);
  assert.deepEqual(
    fields.parseChecklist([
      { key: 'a', name: '验货照', onSite: true },
      { key: 'b', name: '发票', required: false, onSite: 'yes' },
    ]),
    [
      { key: 'a', name: '验货照', onSite: true },
      { key: 'b', name: '发票', required: false },
    ],
  );
});

test('外部 MCP 密钥：加密能解，换了会话密钥解不开', () => {
  const key = box.deriveSecretKey(randomBytes(32));
  const sealed = box.sealSecret(key, 'sk-test-密钥');
  assert.ok(sealed.startsWith('v1.'));
  assert.ok(!sealed.includes('sk-test'));
  assert.equal(box.openSecret(key, sealed), 'sk-test-密钥');
  assert.equal(box.openSecret(box.deriveSecretKey(randomBytes(32)), sealed), null);
  assert.equal(box.openSecret(key, 'garbage'), null);
  assert.deepEqual(probe.authHeaders(null, 'abc'), { Authorization: 'Bearer abc' });
  assert.deepEqual(probe.authHeaders('X-Api-Key', 'abc'), { 'X-Api-Key': 'DEMO_ONLY_REDACTED' });
  assert.deepEqual(probe.authHeaders(null, null), {});
});

// ───────── 假 MCP 服务 ─────────

const TOKEN = 'secret-token';
const SESSION = 'sess-123';
let server;
let base;
const seen = [];

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

function reply(res, mode, message) {
  if (mode === 'sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': SESSION });
    // 先来一条无关的通知，再来真正的回复，分两块写
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
    setTimeout(() => {
      res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      res.end();
    }, 20);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION });
  res.end(JSON.stringify(message));
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    seen.push({ path: url.pathname, method: req.method, headers: req.headers, body });
    if (url.pathname === '/hang') return; // 永远不回
    if (url.pathname === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>login</html>');
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const mode = url.pathname === '/sse' ? 'sse' : 'json';
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      reply(res, mode, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '9.9' } },
      });
      return;
    }
    if (req.headers['mcp-session-id'] !== SESSION) {
      res.writeHead(400);
      res.end('no session');
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (msg.method === 'tools/list') {
      const page2 = msg.params && msg.params.cursor === 'p2';
      reply(res, mode, {
        jsonrpc: '2.0',
        id: msg.id,
        result: page2
          ? { tools: [{ name: 'c' }] }
          : { tools: [{ name: 'a' }, { name: 'b' }], nextCursor: 'p2' },
      });
      return;
    }
    reply(res, mode, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

const auth = { Authorization: `Bearer ${TOKEN}` };

test('连通测试：JSON 回复、带会话头、翻页数全工具', async () => {
  const result = await probe.probeMcpServer({ url: `${base}/mcp`, headers: auth, timeoutMs: 3000 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.toolCount, 3);
  assert.deepEqual(result.tools, ['a', 'b', 'c']);
  assert.equal(result.serverName, 'fake 9.9');
  assert.match(result.message, /3 个工具/);
  const list = seen.filter((r) => r.path === '/mcp' && r.body.includes('tools/list'));
  assert.equal(list[0].headers['mcp-protocol-version'], '2025-06-18');
});

test('连通测试：SSE 回复（中间夹通知）也认', async () => {
  const result = await probe.probeMcpServer({ url: `${base}/sse`, headers: auth, timeoutMs: 3000 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.toolCount, 3);
});

test('连通测试：密钥不对、超时、端口没开、不是 MCP 都给人话', async () => {
  const wrong = await probe.probeMcpServer({ url: `${base}/mcp`, headers: { Authorization: 'Bearer nope' }, timeoutMs: 3000 });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /密钥不对/);

  const hang = await probe.probeMcpServer({ url: `${base}/hang`, headers: auth, timeoutMs: 300 });
  assert.equal(hang.ok, false);
  assert.match(hang.message, /超时/);

  // 拿一个刚放掉的端口当「没开」
  const spare = createServer();
  await new Promise((resolve) => spare.listen(0, '127.0.0.1', resolve));
  const sparePort = spare.address().port;
  await new Promise((resolve) => spare.close(resolve));
  const closed = await probe.probeMcpServer({ url: `http://127.0.0.1:${sparePort}/mcp`, headers: auth, timeoutMs: 3000 });
  assert.equal(closed.ok, false);
  assert.match(closed.message, /端口没开/);

  const html = await probe.probeMcpServer({ url: `${base}/html`, headers: auth, timeoutMs: 3000 });
  assert.equal(html.ok, false);
  assert.match(html.message, /不像 MCP/);
});
