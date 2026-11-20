/**
 * OAuth 授权服务器的纯规则离线自检（不进构建、不连库）：回调地址校验与比对、PKCE、resource、
 * Basic 认证解析、发现文档里 ChatGPT 必看的字段。跑编译后的产物：
 *
 *   npm run build:server && node --test scripts/checks/oauth.check.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const rules = require('../../dist/server/modules/oauth/oauth-rules.js');
const {
  redirectUriProblem,
  redirectUriMatches,
  describeRedirect,
  isPkceValue,
  pkceChallengeOf,
  checkResource,
  parseBasicAuth,
  withQuery,
  oauthUrls,
  protectedResourceMetadata,
  authorizationServerMetadata,
} = rules;

test('回调地址：https 任意站点、http 只许本机、私有协议放行、会执行脚本的拒', () => {
  assert.equal(redirectUriProblem('https://chatgpt.com/connector_platform_oauth_redirect'), null);
  assert.equal(redirectUriProblem('http://127.0.0.1:53682/callback'), null);
  assert.equal(redirectUriProblem('http://localhost:8976/oauth/callback'), null);
  assert.equal(redirectUriProblem('http://[::1]:9000/cb'), null);
  assert.equal(redirectUriProblem('cursor://anysphere.cursor-retrieval/oauth/callback'), null);
  assert.notEqual(redirectUriProblem('http://evil.example.com/cb'), null);
  assert.notEqual(redirectUriProblem('javascript:alert(1)'), null);
  assert.notEqual(redirectUriProblem('data:text/html,hi'), null);
  assert.notEqual(redirectUriProblem('file:///etc/passwd'), null);
  assert.notEqual(redirectUriProblem('https://chatgpt.com/cb#frag'), null);
  assert.notEqual(redirectUriProblem('https://chatgpt.com/c b'), null);
  assert.notEqual(redirectUriProblem('not a url'), null);
  assert.notEqual(redirectUriProblem(''), null);
  assert.notEqual(redirectUriProblem(42), null);
});

test('回调比对：逐字相等；本机回环不比端口，其余差一个字符都不行', () => {
  const chatgpt = 'https://chatgpt.com/connector_platform_oauth_redirect';
  assert.equal(redirectUriMatches(chatgpt, chatgpt), true);
  assert.equal(redirectUriMatches(chatgpt, `${chatgpt}/`), false);
  assert.equal(redirectUriMatches(chatgpt, 'https://chatgpt.com.evil.com/connector_platform_oauth_redirect'), false);
  assert.equal(redirectUriMatches('http://127.0.0.1:1111/callback', 'http://127.0.0.1:2222/callback'), true);
  assert.equal(redirectUriMatches('http://127.0.0.1:1111/callback', 'http://127.0.0.1:2222/other'), false);
  assert.equal(redirectUriMatches('http://127.0.0.1:1111/callback', 'http://localhost:1111/callback'), false);
  assert.equal(redirectUriMatches('https://a.com:1/cb', 'https://a.com:2/cb'), false);
});

test('授权页上的站点：常用 AI 工具不提醒，仿冒域名和私有协议要提醒', () => {
  assert.deepEqual(describeRedirect('https://chatgpt.com/connector_platform_oauth_redirect'), {
    label: 'chatgpt.com',
    known: true,
  });
  assert.deepEqual(describeRedirect('https://claude.ai/api/mcp/auth_callback'), { label: 'claude.ai', known: true });
  assert.equal(describeRedirect('https://chatgpt.com.evil.com/cb').known, false);
  assert.equal(describeRedirect('https://evilchatgpt.com/cb').known, false);
  assert.deepEqual(describeRedirect('http://127.0.0.1:5000/cb'), { label: '本机程序', known: true });
  assert.equal(describeRedirect('cursor://x/cb').known, false);
});

test('PKCE S256：RFC 7636 附录 B 的样例', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(isPkceValue(verifier), true);
  assert.equal(pkceChallengeOf(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(isPkceValue('short'), false);
  assert.equal(isPkceValue('a'.repeat(129)), false);
  assert.equal(isPkceValue(`${'a'.repeat(43)}!`), false);
  assert.equal(isPkceValue(undefined), false);
});

test('resource：没带算默认，本站任意路径都认，外站拒', () => {
  const origin = 'http://127.0.0.1:8000';
  assert.deepEqual(checkResource(undefined, origin), { ok: true, resource: null });
  assert.deepEqual(checkResource('', origin), { ok: true, resource: null });
  assert.deepEqual(checkResource('http://127.0.0.1:8000', origin), {
    ok: true,
    resource: 'http://127.0.0.1:8000',
  });
  assert.equal(checkResource('http://127.0.0.1:8000', origin).ok, true);
  assert.equal(checkResource('https://evil.example.com/openapi/mcp', origin).ok, false);
  assert.equal(checkResource('http://127.0.0.1:8000', origin).ok, false);
  assert.equal(checkResource(['http://127.0.0.1:8000', 'https://evil.com/b'], origin).ok, false);
  assert.equal(checkResource({ x: 1 }, origin).ok, false);
});

test('Basic 认证：按 RFC 6749 先 urlencode 再 base64，解出来要还原', () => {
  const header = `Basic ${Buffer.from(`${encodeURIComponent('id:1')}:${encodeURIComponent('s/ec+ret')}`).toString('base64')}`;
  assert.deepEqual(parseBasicAuth(header), { clientId: 'id:1', clientSecret: 'DEMO_ONLY_REDACTED' });
  assert.deepEqual(parseBasicAuth(`Basic ${Buffer.from('abc:def').toString('base64')}`), {
    clientId: 'abc',
    clientSecret: 'def',
  });
  assert.equal(parseBasicAuth('Bearer xyz'), null);
  assert.equal(parseBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`), null);
  assert.equal(parseBasicAuth(undefined), null);
});

test('回调地址加参数：保留原有查询参数，null 不加', () => {
  assert.equal(
    withQuery('https://chatgpt.com/cb?x=1', { code: 'abc', state: 'st=1&2', error: null }),
    'https://chatgpt.com/cb?x=1&code=abc&state=st%3D1%262',
  );
});

test('发现文档：ChatGPT 必看的字段齐全、互相指得上', () => {
  const urls = oauthUrls('http://127.0.0.1:8000', '');
  const prm = protectedResourceMetadata(urls);
  assert.equal(prm.resource, 'http://127.0.0.1:8000');
  assert.deepEqual(prm.authorization_servers, ['http://127.0.0.1:8000']);
  assert.equal(
    urls.resourceMetadata,
    'http://127.0.0.1:8000',
  );
  const as = authorizationServerMetadata(urls);
  // RFC 8414 3.3：issuer 要和 authorization_servers 里的逐字一致
  assert.equal(as.issuer, prm.authorization_servers[0]);
  assert.ok(as.code_challenge_methods_supported.includes('S256'));
  assert.ok(as.response_types_supported.includes('code'));
  assert.ok(as.grant_types_supported.includes('authorization_code'));
  assert.ok(as.grant_types_supported.includes('refresh_token'));
  assert.equal(as.registration_endpoint, 'http://127.0.0.1:8000');
  assert.equal(as.authorization_endpoint, 'http://127.0.0.1:8000');
  assert.equal(as.token_endpoint, 'http://127.0.0.1:8000');
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
  // 访问令牌和刷新令牌前缀与个人 key（wk_）互不相撞
  assert.equal(rules.ACCESS_TOKEN_PREFIX.startsWith('wk_'), false);
  assert.equal(rules.REFRESH_TOKEN_PREFIX.startsWith('wk_'), false);
  // S256 = sha256 的 base64url（不带 = 填充）
  assert.equal(
    pkceChallengeOf('x'.repeat(43)),
    createHash('sha256').update('x'.repeat(43)).digest('base64url'),
  );
});
