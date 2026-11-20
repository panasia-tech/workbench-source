/**
 * 全栈端到端自动化验收测试套件（v6.0 生产架构版）
 * 独立拉起临时端口 + 隔离 SQLite DB，真实走 HTTP / SQLite / sxjk-item-filter / 206 视频流验证 40+ 核心断言
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAppServer } from '../server/index.js';

const TMP_DB = `/tmp/panasia_v6_e2e_${Date.now()}.sqlite`;

async function req(baseUrl, pathUrl, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  const resp = await fetch(`${baseUrl}${pathUrl}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: resp.status, headers: resp.headers, json };
}

async function login(baseUrl, username, password = 'DEMO_ONLY_REDACTED') {
  const r = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  return r;
}

const app = createAppServer({ dbPath: TMP_DB, disableBackgroundLoop: true });
const addr = await app.start(0, '127.0.0.1');
const BASE = `http://127.0.0.1:${addr.port}`;
let passedCount = 0;

function check(name, fn) {
  fn();
  passedCount += 1;
  console.log(`  ✓ [${passedCount}] ${name}`);
}

try {
  console.log(`\n🚀 Running PanAsia Workbench × Xianyu Monitor v6.0 Fullstack E2E Verify @ ${BASE}\n`);

  // 1. 未登录受保护路由返回 401
  const unauth = await req(BASE, '/api/dashboard');
  check('未鉴权访问 /api/dashboard 返回 401', () => {
    assert.equal(unauth.status, 401);
  });

  // 2. 连续输错 5 次密码触发第 6 次 429 防爆破锁定
  for (let i = 0; i < 5; i += 1) {
    const fail = await login(BASE, 'throttle_probe', 'wrongpwd');
    assert.equal(fail.status, 401);
  }
  const locked429 = await login(BASE, 'throttle_probe', 'wrongpwd');
  check('连续输错 5 次密码第 6 次返回 429 TOO_MANY_LOGIN_ATTEMPTS', () => {
    assert.equal(locked429.status, 429);
    assert.equal(locked429.json.code, 'TOO_MANY_LOGIN_ATTEMPTS');
  });

  // 3. 新员工 newbie 登录 -> 0/3 被 403 拦截 -> 错题 400 -> 通关 3 题解锁
  const nbLogin = await login(BASE, 'newbie');
  assert.equal(nbLogin.status, 200);
  const nbTok = nbLogin.json.token;
  check('newbie 登录初始未解锁 practice_unlocked === false', () => {
    assert.equal(nbLogin.json.staff.practice_unlocked, false);
  });

  const nbBlocked = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: nbTok,
    body: { name: '新员工测试任务', search_keyword: 'iPhone', price_to: 3000 },
  });
  check('未通关 newbie 创建监控被 403 PRACTICE_GATE_LOCKED 硬拦截', () => {
    assert.equal(nbBlocked.status, 403);
    assert.equal(nbBlocked.json.code, 'PRACTICE_GATE_LOCKED');
  });

  const wrongQuiz = await req(BASE, '/api/onboarding/practice', {
    method: 'POST',
    token: nbTok,
    body: { gate_id: 'gate1', answer: 'A' },
  });
  check('新员工闯关选错答案返回 400 WRONG_PRACTICE_ANSWER', () => {
    assert.equal(wrongQuiz.status, 400);
    assert.equal(wrongQuiz.json.code, 'WRONG_PRACTICE_ANSWER');
  });

  for (const g of ['gate1', 'gate2', 'gate3']) {
    const passG = await req(BASE, '/api/onboarding/practice', {
      method: 'POST',
      token: nbTok,
      body: { gate_id: g, answer: 'B' },
    });
    assert.equal(passG.status, 200);
  }
  const nbMe = await req(BASE, '/api/auth/me', { token: nbTok });
  check('通过 gate1/2/3 后 newbie 解锁 practice_unlocked === true', () => {
    assert.equal(nbMe.json.staff.practice_unlocked, true);
  });

  // 各角色真登录
  const lmTok = (await login(BASE, 'liming')).json.token;
  const zcgTok = (await login(BASE, 'zhaocg')).json.token;
  const ckjTok = (await login(BASE, 'chenkj')).json.token;
  const wzgTok = (await login(BASE, 'wangzg')).json.token;

  // 4. 监控关联《四维行情参考表》上限防买贵 (403) + 主管特批 (200)
  const ceilFail = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: lmTok,
    body: {
      name: '超上限测试',
      search_keyword: 'iPhone 15 Pro',
      pricebook_sku: 'IP15P-256-NAT',
      price_from: 3500,
      price_to: 4900, // 超过上限 4750
      interval_seconds: 15,
      listen_account_ids: ['ACC-GF-03'],
    },
  });
  check('采购员建监控超行情上限 4750 返回 403 MONITOR_PRICE_EXCEEDS_CEILING', () => {
    assert.equal(ceilFail.status, 403);
    assert.equal(ceilFail.json.code, 'MONITOR_PRICE_EXCEEDS_CEILING');
  });

  const adminOverride = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: wzgTok,
    body: {
      name: '主管特批高位盯梢',
      search_keyword: 'iPhone 15 Pro',
      pricebook_sku: 'IP15P-256-NAT',
      price_from: 3500,
      price_to: 4900,
      interval_seconds: 15,
      listen_account_ids: ['ACC-GF-03'],
    },
  });
  check('ADMIN 王主管特批高位监听返回 200', () => {
    assert.equal(adminOverride.status, 200);
  });

  // 5. 防风控轮询过频 < 3s (400) 与价格反转 (400)
  const fastPoll = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: lmTok,
    body: {
      name: '高频爆号测试',
      search_keyword: 'iPad',
      price_from: 2000,
      price_to: 3500,
      interval_seconds: 1,
      listen_account_ids: ['ACC-GF-03'],
    },
  });
  check('单账号 1 秒轮询被防风控 400 POLL_INTERVAL_TOO_FAST 拦截', () => {
    assert.equal(fastPoll.status, 400);
    assert.equal(fastPoll.json.code, 'POLL_INTERVAL_TOO_FAST');
  });

  const badRange = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: lmTok,
    body: {
      name: '倒挂价格测试',
      search_keyword: 'iPad',
      price_from: 5000,
      price_to: 4000,
      interval_seconds: 15,
      listen_account_ids: ['ACC-GF-03'],
    },
  });
  check('最低价 > 最高价返回 400 INVALID_PRICE_RANGE', () => {
    assert.equal(badRange.status, 400);
    assert.equal(badRange.json.code, 'INVALID_PRICE_RANGE');
  });

  // 6. 钉钉未通过连接测试禁止绑任务 (409) -> 填SEC并通过测试 -> 允许绑定 (200)
  const botFail = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: lmTok,
    body: {
      name: '未测钉钉绑任务',
      search_keyword: 'MacBook',
      price_from: 5000,
      price_to: 7000,
      interval_seconds: 15,
      dingtalk_robot_ids: ['BOT-02'],
      listen_account_ids: ['ACC-GF-03'],
    },
  });
  check('绑定未测试的 BOT-02 返回 409 DINGTALK_CONFIG_INCOMPLETE/UNTESTED', () => {
    assert.equal(botFail.status, 409);
  });

  const testEmptySec = await req(BASE, '/api/monitor/robots/BOT-02/test', {
    method: 'POST',
    token: lmTok,
    body: {},
  });
  check('无 SEC 密钥测试 BOT-02 返回 400 MISSING_DINGTALK_SECRET', () => {
    assert.equal(testEmptySec.status, 400);
  });

  const saveBot = await req(BASE, '/api/monitor/robots', {
    method: 'POST',
    token: lmTok,
    body: {
      id: 'BOT-02',
      name: '备用二组通知机器人',
      webhook: 'https://hooks.example.invalid/demo',
      secret: 'DEMO_ONLY_REDACTED',
    },
  });
  assert.equal(saveBot.status, 200);
  const testOk = await req(BASE, '/api/monitor/robots/BOT-02/test', { method: 'POST', token: lmTok, body: {} });
  check('配置 SEC 密钥并测试 BOT-02 返回 200 且 last_test_ok=1', () => {
    assert.equal(testOk.status, 200);
    assert.equal(testOk.json.robot.last_test_ok, 1);
  });

  const botPass = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: lmTok,
    body: {
      name: '已测钉钉可成功绑定',
      search_keyword: 'MacBook',
      price_from: 5000,
      price_to: 7000,
      interval_seconds: 15,
      dingtalk_robot_ids: ['BOT-02'],
      listen_account_ids: ['ACC-GF-03'],
    },
  });
  check('测试通过后绑定 BOT-02 成功返回 200', () => {
    assert.equal(botPass.status, 200);
  });

  // 7. 5% 红标防护：闲鱼副号2 (4.71%, 下一单破5.88%) 禁止绑自动秒拍 (409)
  const mpRedline = await req(BASE, '/api/monitor/tasks', {
    method: 'POST',
    token: lmTok,
    body: {
      name: '危险秒拍测试',
      search_keyword: 'iPhone',
      price_from: 3800,
      price_to: 4600,
      interval_seconds: 15,
      miaopai_enabled: true,
      miaopai_account_ids: ['ACC-GF-02'],
      miaopai_price_to: 4500,
    },
  });
  check('选用闲鱼副号2 (4.71%) 开自动秒拍返回 409 并推荐 ACC-GF-03', () => {
    assert.equal(mpRedline.status, 409);
    assert.equal(mpRedline.json.code, 'ACCOUNT_NEAR_5PCT_REDLINE');
    assert.equal(mpRedline.json.recommended_account.id, 'ACC-GF-03');
  });

  // 8. 黑名单卖家禁建店铺上新监听 (409)
  const blShop = await req(BASE, '/api/monitor/shops', {
    method: 'POST',
    token: lmTok,
    body: {
      seller_user_id: 'BLK-SELLER-991',
      seller_nick: '华强北专业翻新老李',
      price_to: 4500,
    },
  });
  check('黑名单卖家创建店铺监控返回 409 SELLER_BLACKLISTED', () => {
    assert.equal(blShop.status, 409);
    assert.equal(blShop.json.code, 'SELLER_BLACKLISTED');
  });

  // 9. 三合一 422 违禁词扫描（打招呼话术 + IM 对话）
  const g1 = await req(BASE, '/api/monitor/greetings', {
    method: 'POST',
    token: lmTok,
    body: { title: '违禁测试1', text_content: '公司给到底价4500你出不出' },
  });
  const g2 = await req(BASE, '/api/conversations/CONV-001/send', {
    method: 'POST',
    token: lmTok,
    body: { body: '哥加我微私下转账退200吧' },
  });
  const g3 = await req(BASE, '/api/conversations/CONV-001/send', {
    method: 'POST',
    token: lmTok,
    body: { body: '你不退我就点申请小二介入了' },
  });
  check('422 三合一拦截内部保密词 / 站外引流微信词 / 反扯皮小二介入词', () => {
    assert.equal(g1.status, 422);
    assert.equal(g1.json.code, 'INTERNAL_WORD_BLOCKED');
    assert.equal(g2.status, 422);
    assert.equal(g2.json.code, 'TRAFFIC_DIVERSION_BLOCKED');
    assert.equal(g3.status, 422);
    assert.equal(g3.json.code, 'ANTI_BICKERING_BLOCKED');
  });

  // 10. 执行真实 sxjk-item-filter 轮询筛选（验证 4 条原始单 -> 价格1 + 排除词1 + 黑名单1 -> 净命中1）
  const pollRes = await req(BASE, '/api/monitor/tasks/TASK-MBP-M3/poll', {
    method: 'POST',
    token: lmTok,
    body: {},
  });
  check('真实复用 sxjk-item-filter 过滤链：4条输入各层精准剔除仅净命中1条', () => {
    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.json.data.raw_count, 4);
    assert.equal(pollRes.json.data.matched_count, 1);
    assert.equal(pollRes.json.data.stats.removed.globalPrice, 1);
    assert.equal(pollRes.json.data.stats.removed.excludeTitle, 1);
    assert.equal(pollRes.json.data.stats.removed.blacklist, 1);
  });

  // 11. 疑似「几乎全新」HIT-8801 一键转采购单：用副号2被 409 拦 -> 改用闲鱼3号成功创建快照+会话+采购单
  const promFail = await req(BASE, '/api/monitor/hits/HIT-8801/promote', {
    method: 'POST',
    token: lmTok,
    body: { account_id: 'ACC-GF-02', lock_order: true },
  });
  check('质疑成色命中用 4.71% 副号2 秒拍转单返回 409', () => {
    assert.equal(promFail.status, 409);
    assert.equal(promFail.json.code, 'ACCOUNT_NEAR_5PCT_REDLINE');
  });

  const promOk = await req(BASE, '/api/monitor/hits/HIT-8801/promote', {
    method: 'POST',
    token: lmTok,
    body: { account_id: 'ACC-GF-03', lock_order: true },
  });
  check('切安全号 ACC-GF-03 一键锁 10 图快照并转入正式采购单', () => {
    assert.equal(promOk.status, 200);
    assert.ok(promOk.json.data.snapshot_id.startsWith('SNAP-HIT-'));
    assert.ok(promOk.json.data.case.case_id.startsWith('CASE-'));
    assert.equal(promOk.json.data.case.account_id, 'ACC-GF-03');
  });

  // 12. 买前第 4 步 CASE-001：未核改价 409 -> 填0占位 400 -> 真实回执 200 + 生买前 10% (¥43)
  const payNoCheck = await req(BASE, '/api/cases/CASE-001/prebuy', {
    method: 'POST',
    token: lmTok,
    body: { action: 'confirm_payment', seller_modified_price_verified: false, payment_receipt_no: 'ALI123', external_order_no: 'GF123' },
  });
  const payZero = await req(BASE, '/api/cases/CASE-001/prebuy', {
    method: 'POST',
    token: lmTok,
    body: { action: 'confirm_payment', seller_modified_price_verified: true, payment_receipt_no: '0', external_order_no: 'GF123' },
  });
  const payOk = await req(BASE, '/api/cases/CASE-001/prebuy', {
    method: 'POST',
    token: lmTok,
    body: { action: 'confirm_payment', seller_modified_price_verified: true, payment_receipt_no: 'ALI-998877', external_order_no: 'GF-ORD-778001', paid_yuan: 4620 },
  });
  check('买前第4步：未核改价 409、填0占位 400、规范付款 200 并锁买前10% (¥43)', () => {
    assert.equal(payNoCheck.status, 409);
    assert.equal(payNoCheck.json.code, 'NEED_SELLER_PRICE_CHECK');
    assert.equal(payZero.status, 400);
    assert.equal(payZero.json.code, 'PLACEHOLDER_FORBIDDEN');
    assert.equal(payOk.status, 200);
    const preCom = payOk.json.detail.commissions.find((c) => c.policy_mode === 'pre_buy_10_pct');
    assert.equal(preCom.confirmed_cents, 4300);
  });

  // 13. 次日 10:00 昨日对账单：未消异常禁签收 (409) -> 补抓漏单 ST-06/ST-07 + 核平 ST-08 -> 采购签收 403 -> 会计签收 200
  const signPremature = await req(BASE, '/api/reconcile/batches/STMT-20261118/signoff', {
    method: 'POST',
    token: ckjTok,
  });
  check('昨日对账单存在未处理漏单/差额时会计签收被 409 拦截', () => {
    assert.equal(signPremature.status, 409);
    assert.equal(signPremature.json.code, 'RECONCILE_HAS_UNRESOLVED_ITEMS');
  });

  await req(BASE, '/api/reconcile/items/ST-06/resolve', { method: 'POST', token: lmTok, body: { action: 'backfill_missing' } });
  await req(BASE, '/api/reconcile/items/ST-07/resolve', { method: 'POST', token: lmTok, body: { action: 'backfill_missing' } });
  const r8 = await req(BASE, '/api/reconcile/items/ST-08/resolve', { method: 'POST', token: lmTok, body: { action: 'confirm_amount_diff' } });
  const signNonFin = await req(BASE, '/api/reconcile/batches/STMT-20261118/signoff', { method: 'POST', token: lmTok });
  const signFin = await req(BASE, '/api/reconcile/batches/STMT-20261118/signoff', { method: 'POST', token: ckjTok });
  check('一键补抓生成正式采购单 + 非财务签收 403 + 消零后陈会计签收成功 200', () => {
    assert.equal(r8.json.data.pending_count, 0);
    assert.equal(signNonFin.status, 403);
    assert.equal(signFin.status, 200);
    assert.equal(signFin.json.data.batch.status, 'signed_off');
  });

  // 14. 仓管权限边界 + 95338 退回截停锁
  const whRoleFail = await req(BASE, '/api/cases/CASE-004/warehouse-inspect', {
    method: 'POST',
    token: lmTok,
    body: { outcome: 'pass_good', warehouse_video_url: '/evidence/v.mp4' },
  });
  const wh95338Lock = await req(BASE, '/api/cases/CASE-009/warehouse-inspect', {
    method: 'POST',
    token: zcgTok,
    body: { outcome: 'pass_good', warehouse_video_url: '/evidence/v.mp4' },
  });
  const unlock95338 = await req(BASE, '/api/aftersales/TK-2403/advance', {
    method: 'POST',
    token: lmTok,
    body: { action: 'handle_95338', sf_95338_status: 'intercepted' },
  });
  check('采购代填验机 403 + 95338退回请求期间入库 409 锁死 + 确认截回成功 200', () => {
    assert.equal(whRoleFail.status, 403);
    assert.equal(wh95338Lock.status, 409);
    assert.equal(wh95338Lock.json.code, 'WAREHOUSE_LOCKED_BY_95338');
    assert.equal(unlock95338.status, 200);
    assert.equal(unlock95338.json.detail.ticket.sf_95338_status, 'intercepted');
  });

  // 15. 两段各 10% 绝不回代重算验证（CASE-006 / TK-2402）
  const beforeDet = await req(BASE, '/api/cases/CASE-006', { token: lmTok });
  const preInitial = beforeDet.json.detail.commissions.find((c) => c.policy_mode === 'pre_buy_10_pct').confirmed_cents;
  assert.equal(preInitial, 4000);

  const setRes = await req(BASE, '/api/aftersales/TK-2402/advance', {
    method: 'POST',
    token: lmTok,
    body: {
      action: 'record_settlement',
      settle_mode: 'corp_alipay_close',
      agreed_reduction_yuan: 500,
      payee_real_name: '苏州陈先生',
      payee_alipay_account: '00077089570',
    },
  });
  assert.equal(setRes.status, 200);
  const whPremature = await req(BASE, '/api/aftersales/TK-2402/warehouse-close', {
    method: 'POST',
    token: zcgTok,
    body: { bin_location: 'A-01-01' },
  });
  check('T+1 财务未核销前仓管关单被 409 FINANCE_T1_NOT_CLEARED 拦截', () => {
    assert.equal(whPremature.status, 409);
    assert.equal(whPremature.json.code, 'FINANCE_T1_NOT_CLEARED');
  });

  const regId = setRes.json.detail.corp_alipay_regs[0].reg_id;
  const finApp = await req(BASE, `/api/finance/alipay-regs/${regId}/approve`, {
    method: 'POST',
    token: ckjTok,
    body: { receipt_no: 'CORP-ALI-20261119-999' },
  });
  assert.equal(finApp.status, 200);

  const whClose = await req(BASE, '/api/aftersales/TK-2402/warehouse-close', {
    method: 'POST',
    token: zcgTok,
    body: { bin_location: 'A-01-01' },
  });
  check('财务+仓管双清后第二段到货 10% (5000分=¥50) 转确认，且第一段买前 10% (4000分=¥40) 绝不重算', () => {
    assert.equal(whClose.status, 200);
    assert.equal(whClose.json.detail.case.order_bucket, 'done');
    const preAfter = whClose.json.detail.commissions.find((c) => c.policy_mode === 'pre_buy_10_pct');
    const postAfter = whClose.json.detail.commissions.find((c) => c.policy_mode === 'post_arrival_10_pct');
    assert.equal(preAfter.confirmed_cents, 4000);
    assert.equal(postAfter.confirmed_cents, 5000);
    assert.equal(postAfter.status, 'confirmed');
  });

  // 16. 内置教程视频 HTTP 206 Partial Content 分片流式验证
  const vidResp = await fetch(`${BASE}/media/tutorial-v6.mp4`, {
    headers: { Range: 'bytes=0-1023' },
  });
  const vidBuf = new Uint8Array(await vidResp.arrayBuffer());
  check('/media/tutorial-v6.mp4 支持 HTTP 206 Partial Content 且返回 video/mp4 (1024 bytes)', () => {
    assert.equal(vidResp.status, 206);
    assert.equal(vidResp.headers.get('content-type'), 'video/mp4');
    assert.equal(vidResp.headers.get('content-length'), '1024');
    assert.equal(vidBuf.byteLength, 1024);
  });

  console.log(`\n🎉 ALL ${passedCount} FULLSTACK E2E CHECKS PASSED SUCCESSFULLY!\n`);
} finally {
  await app.close();
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(`${TMP_DB}-wal`); } catch {}
  try { fs.unlinkSync(`${TMP_DB}-shm`); } catch {}
}
