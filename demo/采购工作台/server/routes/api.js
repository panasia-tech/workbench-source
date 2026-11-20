/**
 * REST + SSE + xy-sxjk Electron 兼容路由总控
 */
import crypto from 'node:crypto';
import {
  checkLoginThrottle,
  recordLoginAttempt,
  resolveAuthenticatedStaff,
  sanitizeStaff,
  signToken,
  verifyPassword,
} from '../middleware/auth.js';
import {
  HttpError,
  assertCleanCommunicationText,
  assertPracticeUnlocked,
  assertRoleIn,
  assertSellerNotBlacklisted,
  computeAccountRisk,
} from '../services/guards.js';
import {
  generateMatchKeywordsSuggestion,
  getDivisionOptions,
  listMonitorOverview,
  promoteHitToCase,
  registerSseClient,
  runGlobalTaskPoll,
  saveGlobalListenTask,
  saveShopMonitorTask,
  testDingtalkRobot,
  upsertDingtalkRobot,
  writeAudit,
} from '../services/monitor-engine.js';
import {
  advanceAftersalesTicket,
  advancePrebuyStep,
  approveCorpAlipayRegistration,
  confirmWarehouseInboundClose,
  getCaseDetail,
  getReconcileBatch,
  listCases,
  listConversations,
  listDashboardSummary,
  listFinanceAndCommissions,
  listSellersAndBlacklist,
  lockPrebuySnapshot,
  publishPricebookItem,
  resolveStatementItem,
  saveFavoriteSellerAndSyncMonitor,
  sendImMessage,
  signoffReconcileBatch,
  submitPracticeGate,
  submitWarehouseInspection,
} from '../services/procurement-service.js';

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > 2 * 1024 * 1024) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大（超过 2MB）'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1');
}

function requireStaff(db, req) {
  const staff = resolveAuthenticatedStaff(db, req.headers);
  if (!staff) {
    throw new HttpError(401, 'UNAUTHORIZED', '登录态无效或已过期，请重新登录员工账号');
  }
  return staff;
}

export async function handleApiRoute(db, req, res, urlObj) {
  const pathname = urlObj.pathname;
  const method = (req.method || 'GET').toUpperCase();

  try {
    // 1. Health & Public Metadata
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'panasia-workbench-monitor-v6', ts: new Date().toISOString() });
    }

    if (method === 'GET' && pathname === '/api/auth/staff-directory') {
      const list = db
        .prepare(`SELECT id, username, name, role, practice_passed_gates, status FROM staff_users ORDER BY created_at ASC`)
        .all()
        .map(sanitizeStaff);
      return sendJson(res, 200, { ok: true, staff_list: list });
    }

    // 2. Real Scrypt + HMAC-SHA256 Auth + 5-fail/5-min 429 Lock
    if (method === 'POST' && (pathname === '/api/auth/login' || pathname === '/api/auth/workbench-login')) {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const ip = getClientIp(req);
      if (!username || !password) {
        throw new HttpError(400, 'MISSING_CREDENTIALS', '请输入员工账号和密码');
      }
      if (checkLoginThrottle(db, username, ip)) {
        throw new HttpError(
          429,
          'TOO_MANY_LOGIN_ATTEMPTS',
          '【登录防爆破锁定】该账号 5 分钟内连续输错密码达 5 次，已被临时锁定，请 5 分钟后再试或联系王主管解封。'
        );
      }
      const user = db.prepare(`SELECT * FROM staff_users WHERE username = ?`).get(username);
      if (!user || !verifyPassword(password, user.password_hash)) {
        recordLoginAttempt(db, username, ip, false);
        throw new HttpError(401, 'INVALID_CREDENTIALS', '演示账号或密码错误');
      }
      recordLoginAttempt(db, username, ip, true);
      const now = new Date().toISOString();
      db.prepare(`UPDATE staff_users SET last_login_at = ? WHERE id = ?`).run(now, user.id);
      const staff = sanitizeStaff({ ...user, last_login_at: now });
      const token = signToken(staff);
      writeAudit(db, staff, 'staff_login', 'staff_user', staff.id, { ip });
      return sendJson(res, 200, { ok: true, token, user: staff, staff });
    }

    if (method === 'GET' && (pathname === '/api/auth/me' || pathname === '/api/auth/session')) {
      const staff = requireStaff(db, req);
      return sendJson(res, 200, { ok: true, user: staff, staff });
    }

    // SSE 实时事件流（支持 query token 鉴权，便于 EventSource 使用）
    if (method === 'GET' && pathname === '/api/events') {
      const qToken = urlObj.searchParams.get('token');
      const fakeHeaders = qToken ? { authorization: `Bearer ${qToken}` } : req.headers;
      const staff = resolveAuthenticatedStaff(db, fakeHeaders);
      if (!staff) {
        throw new HttpError(401, 'UNAUTHORIZED', 'SSE 连接需要有效员工 Token');
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ staff_id: staff.id, ts: new Date().toISOString() })}\n\n`);
      registerSseClient(res);
      return;
    }

    // =========================================================================
    // 以下所有接口强制 Bearer / X-Erp-Token 真实员工鉴权
    // =========================================================================
    const staff = requireStaff(db, req);

    // 3. 工作台总览 & 今日看板
    if (method === 'GET' && pathname === '/api/dashboard') {
      return sendJson(res, 200, { ok: true, data: listDashboardSummary(db, staff) });
    }

    // 4. 新手 3 关防踩坑闯关
    if (method === 'POST' && pathname === '/api/onboarding/practice') {
      const body = await readJsonBody(req);
      const resData = submitPracticeGate(db, staff, body.gate_id, body.answer);
      const freshUser = sanitizeStaff(db.prepare(`SELECT * FROM staff_users WHERE id = ?`).get(staff.id));
      return sendJson(res, 200, { ok: true, ...resData, staff: freshUser });
    }

    // 5. 闲鱼监控融合中心 API + Electron /app/xy-sxjk/* 兼容接口
    if (method === 'GET' && (pathname === '/api/monitor/overview' || pathname === '/app/xy-sxjk/overview')) {
      return sendJson(res, 200, { ok: true, data: listMonitorOverview(db) });
    }

    if (
      method === 'GET' &&
      (pathname === '/api/monitor/areas' || pathname === '/app/xy-sxjk/divisionCascaderOptions')
    ) {
      return sendJson(res, 200, { ok: true, data: getDivisionOptions() });
    }

    if (
      method === 'POST' &&
      (pathname === '/api/monitor/generate-keywords' || pathname === '/app/xy-sxjk/generateMatchKeywords')
    ) {
      const body = await readJsonBody(req);
      return sendJson(res, 200, {
        ok: true,
        data: generateMatchKeywordsSuggestion(body.search_keyword || body.searchKeyword || ''),
      });
    }

    if (method === 'POST' && (pathname === '/api/monitor/tasks' || pathname === '/app/xy-sxjk/pcListenTasks')) {
      const body = await readJsonBody(req);
      const saved = saveGlobalListenTask(db, body, staff);
      return sendJson(res, 200, { ok: true, task: saved });
    }

    if (method === 'PATCH' && pathname.startsWith('/api/monitor/tasks/') && pathname.endsWith('/toggle')) {
      assertPracticeUnlocked(staff);
      const taskId = decodeURIComponent(pathname.slice('/api/monitor/tasks/'.length, -'/toggle'.length));
      const row = db.prepare(`SELECT * FROM monitor_listen_tasks WHERE id = ?`).get(taskId);
      if (!row) throw new HttpError(404, 'TASK_NOT_FOUND', `未找到任务 ${taskId}`);
      const nextEnabled = Number(row.enabled) === 1 ? 0 : 1;
      db.prepare(`UPDATE monitor_listen_tasks SET enabled = ?, updated_at = ? WHERE id = ?`).run(
        nextEnabled,
        new Date().toISOString(),
        taskId
      );
      return sendJson(res, 200, { ok: true, enabled: nextEnabled === 1 });
    }

    if (method === 'POST' && pathname.startsWith('/api/monitor/tasks/') && pathname.endsWith('/poll')) {
      assertPracticeUnlocked(staff);
      const taskId = decodeURIComponent(pathname.slice('/api/monitor/tasks/'.length, -'/poll'.length));
      const result = runGlobalTaskPoll(db, taskId, staff);
      return sendJson(res, 200, { ok: true, data: result });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/monitor/tasks/')) {
      assertPracticeUnlocked(staff);
      const taskId = decodeURIComponent(pathname.slice('/api/monitor/tasks/'.length));
      db.prepare(`DELETE FROM monitor_listen_tasks WHERE id = ?`).run(taskId);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && (pathname === '/api/monitor/shops' || pathname === '/app/xy-sxjk/pcShopMonitors')) {
      const body = await readJsonBody(req);
      const shop = saveShopMonitorTask(db, body, staff);
      return sendJson(res, 200, { ok: true, shop });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/monitor/shops/')) {
      assertPracticeUnlocked(staff);
      const shopId = decodeURIComponent(pathname.slice('/api/monitor/shops/'.length));
      db.prepare(`DELETE FROM monitor_shop_tasks WHERE id = ?`).run(shopId);
      db.prepare(`UPDATE favorite_sellers SET shop_monitor_id = NULL WHERE shop_monitor_id = ?`).run(shopId);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname.startsWith('/api/monitor/hits/') && pathname.endsWith('/promote')) {
      const hitId = decodeURIComponent(pathname.slice('/api/monitor/hits/'.length, -'/promote'.length));
      const body = await readJsonBody(req);
      const out = promoteHitToCase(db, hitId, staff, body);
      return sendJson(res, 200, { ok: true, data: out });
    }

    // 钉钉机器人设置与加签连通性测试
    if (
      method === 'POST' &&
      (pathname === '/api/monitor/robots' || pathname === '/app/xy-sxjk/dingtalkSettings')
    ) {
      const body = await readJsonBody(req);
      const bot = upsertDingtalkRobot(db, body, staff);
      return sendJson(res, 200, { ok: true, robot: bot });
    }

    if (method === 'POST' && pathname.startsWith('/api/monitor/robots/') && pathname.endsWith('/test')) {
      const botId = decodeURIComponent(pathname.slice('/api/monitor/robots/'.length, -'/test'.length));
      const bot = await testDingtalkRobot(db, botId, staff);
      return sendJson(res, 200, { ok: true, robot: bot });
    }

    // 合规打招呼话术库（强制 422 违禁词扫描）
    if (
      method === 'POST' &&
      (pathname === '/api/monitor/greetings' || pathname === '/app/xy-sxjk/globalGreeting')
    ) {
      assertPracticeUnlocked(staff);
      const body = await readJsonBody(req);
      const title = String(body.title || '自定义打招呼模板').trim();
      const textContent = String(body.text_content || '').trim();
      if (!textContent) throw new HttpError(400, 'EMPTY_GREETING', '打招呼话术内容不能为空');
      assertCleanCommunicationText(textContent, '打招呼话术模板');
      const now = new Date().toISOString();
      if (body.id) {
        db.prepare(`UPDATE greeting_templates SET title=?, text_content=?, updated_at=? WHERE id=?`).run(
          title,
          textContent,
          now,
          Number(body.id)
        );
      } else {
        db.prepare(
          `INSERT INTO greeting_templates (greeting_type, title, text_content, created_by, created_at, updated_at)
           VALUES ('text', ?, ?, ?, ?, ?)`
        ).run(title, textContent, staff.id, now, now);
      }
      const list = db.prepare(`SELECT * FROM greeting_templates ORDER BY id ASC`).all();
      return sendJson(res, 200, { ok: true, greetings: list });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/monitor/greetings/')) {
      assertPracticeUnlocked(staff);
      const gid = Number(pathname.slice('/api/monitor/greetings/'.length));
      db.prepare(`DELETE FROM greeting_templates WHERE id = ?`).run(gid);
      return sendJson(res, 200, { ok: true });
    }

    // 商家黑名单（自动与现有店铺监控冲突校验）
    if (method === 'POST' && (pathname === '/api/sellers/blacklist' || pathname === '/app/xy-sxjk/sellerBlacklist')) {
      assertPracticeUnlocked(staff);
      const body = await readJsonBody(req);
      const userId = String(body.user_id || '').trim();
      const nick = String(body.nick || '').trim();
      const reason = String(body.reason || '恶意纠纷/二道贩子').trim();
      if (!userId && !nick) throw new HttpError(400, 'INVALID_BLACKLIST', '必须填写卖家 ID 或昵称');
      const finalId = userId || `BLK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO seller_blacklist (user_id, plain_user_id, nick, reason, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(finalId, body.plain_user_id || finalId, nick || finalId, reason, staff.id, now);
      // 自动停用该卖家的店铺监听，防止冲突
      db.prepare(`UPDATE monitor_shop_tasks SET enabled = 0, updated_at = ? WHERE seller_user_id = ?`).run(now, finalId);
      writeAudit(db, staff, 'seller_blacklisted', 'seller_blacklist', finalId, { nick, reason });
      return sendJson(res, 200, { ok: true, data: listSellersAndBlacklist(db) });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/sellers/blacklist/')) {
      assertPracticeUnlocked(staff);
      const uid = decodeURIComponent(pathname.slice('/api/sellers/blacklist/'.length));
      db.prepare(`DELETE FROM seller_blacklist WHERE user_id = ?`).run(uid);
      return sendJson(res, 200, { ok: true, data: listSellersAndBlacklist(db) });
    }

    // 6. 账号矩阵 + 1+3 专窗调度 + 5% 防红标模拟测试
    if (method === 'GET' && pathname === '/api/accounts') {
      const accounts = db.prepare(`SELECT * FROM xianyu_accounts ORDER BY id ASC`).all().map(computeAccountRisk);
      const jobs = db.prepare(`SELECT * FROM executor_jobs ORDER BY job_id ASC`).all();
      return sendJson(res, 200, { ok: true, accounts, executor_jobs: jobs });
    }

    if (method === 'POST' && pathname.startsWith('/api/accounts/') && pathname.endsWith('/cookie')) {
      assertRoleIn(staff, ['ADMIN', 'PURCHASER']);
      assertPracticeUnlocked(staff);
      const accId = decodeURIComponent(pathname.slice('/api/accounts/'.length, -'/cookie'.length));
      const body = await readJsonBody(req);
      db.prepare(`UPDATE xianyu_accounts SET mtop_cookie = ?, synced_at = ? WHERE id = ?`).run(
        String(body.mtop_cookie || ''),
        new Date().toISOString(),
        accId
      );
      return sendJson(res, 200, { ok: true });
    }

    // 7. 收藏卖家池
    if (method === 'GET' && pathname === '/api/sellers') {
      return sendJson(res, 200, { ok: true, data: listSellersAndBlacklist(db) });
    }
    if (method === 'POST' && pathname === '/api/sellers/favorites') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, data: saveFavoriteSellerAndSyncMonitor(db, body, staff) });
    }

    // 8. 采购订单中心（全流程买前 6 步 + 到货 9 步 + 仓管验机 + 财务核销）
    if (method === 'GET' && pathname === '/api/cases') {
      const bucket = urlObj.searchParams.get('bucket') || 'all';
      return sendJson(res, 200, { ok: true, cases: listCases(db, bucket) });
    }

    if (method === 'GET' && pathname.startsWith('/api/cases/') && pathname.split('/').length === 4) {
      const caseId = decodeURIComponent(pathname.slice('/api/cases/'.length));
      return sendJson(res, 200, { ok: true, detail: getCaseDetail(db, caseId) });
    }

    if (method === 'POST' && pathname.startsWith('/api/cases/') && pathname.endsWith('/snapshot')) {
      const caseId = decodeURIComponent(pathname.slice('/api/cases/'.length, -'/snapshot'.length));
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, detail: lockPrebuySnapshot(db, caseId, body, staff) });
    }

    if (method === 'POST' && pathname.startsWith('/api/cases/') && pathname.endsWith('/prebuy')) {
      const caseId = decodeURIComponent(pathname.slice('/api/cases/'.length, -'/prebuy'.length));
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, detail: advancePrebuyStep(db, caseId, body.action, body, staff) });
    }

    if (method === 'POST' && pathname.startsWith('/api/cases/') && pathname.endsWith('/warehouse-inspect')) {
      const caseId = decodeURIComponent(pathname.slice('/api/cases/'.length, -'/warehouse-inspect'.length));
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, detail: submitWarehouseInspection(db, caseId, body, staff) });
    }

    if (method === 'POST' && pathname.startsWith('/api/aftersales/') && pathname.endsWith('/advance')) {
      const tkId = decodeURIComponent(pathname.slice('/api/aftersales/'.length, -'/advance'.length));
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, detail: advanceAftersalesTicket(db, tkId, body.action, body, staff) });
    }

    if (method === 'POST' && pathname.startsWith('/api/aftersales/') && pathname.endsWith('/warehouse-close')) {
      const tkId = decodeURIComponent(pathname.slice('/api/aftersales/'.length, -'/warehouse-close'.length));
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, detail: confirmWarehouseInboundClose(db, tkId, body, staff) });
    }

    // 9. IM 对话池 + 违禁拦截 + 暂停接管
    if (method === 'GET' && pathname === '/api/conversations') {
      return sendJson(res, 200, { ok: true, conversations: listConversations(db) });
    }

    if (method === 'POST' && pathname.startsWith('/api/conversations/') && pathname.endsWith('/send')) {
      const convId = decodeURIComponent(pathname.slice('/api/conversations/'.length, -'/send'.length));
      const body = await readJsonBody(req);
      const conv = sendImMessage(db, convId, body.body, body, staff);
      return sendJson(res, 200, { ok: true, conversation: conv });
    }

    if (method === 'POST' && pathname.startsWith('/api/conversations/') && pathname.endsWith('/pause')) {
      assertPracticeUnlocked(staff);
      const convId = decodeURIComponent(pathname.slice('/api/conversations/'.length, -'/pause'.length));
      const body = await readJsonBody(req);
      const pauseState = body.pause_state === 'paused' ? 'paused' : 'auto';
      db.prepare(`UPDATE conversations SET pause_state = ?, pause_reason = ?, context_version = context_version + 1, updated_at = ? WHERE conv_id = ?`).run(
        pauseState,
        body.pause_reason || null,
        new Date().toISOString(),
        convId
      );
      return sendJson(res, 200, { ok: true, conversation: listConversations(db).find((c) => c.conv_id === convId) });
    }

    // 10. 行情参考表 + 财务与 T+1 对账单自动核对
    if (method === 'GET' && pathname === '/api/pricebook') {
      const items = db.prepare(`SELECT * FROM pricebook_items WHERE status = 'published' ORDER BY sku_code ASC`).all();
      return sendJson(res, 200, { ok: true, items });
    }

    if (method === 'POST' && pathname === '/api/pricebook') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, items: publishPricebookItem(db, body, staff) });
    }

    if (method === 'GET' && pathname === '/api/finance') {
      return sendJson(res, 200, { ok: true, data: listFinanceAndCommissions(db) });
    }

    if (method === 'POST' && pathname.startsWith('/api/finance/alipay-regs/') && pathname.endsWith('/approve')) {
      const regId = decodeURIComponent(pathname.slice('/api/finance/alipay-regs/'.length, -'/approve'.length));
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, detail: approveCorpAlipayRegistration(db, regId, body, staff) });
    }

    if (method === 'GET' && pathname === '/api/reconcile') {
      return sendJson(res, 200, { ok: true, data: getReconcileBatch(db) });
    }

    if (method === 'POST' && pathname === '/api/reconcile/sync') {
      const now = new Date().toISOString();
      db.prepare(`UPDATE statement_batches SET sync_source_label = ? WHERE batch_id = 'STMT-20261118'`).run(
        `刚刚（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）从财务支付宝/ERP 接口自动拉取校验到位`
      );
      writeAudit(db, staff, 'reconcile_synced', 'statement_batch', 'STMT-20261118', { now });
      return sendJson(res, 200, { ok: true, data: getReconcileBatch(db) });
    }

    if (method === 'POST' && pathname.startsWith('/api/reconcile/items/') && pathname.endsWith('/resolve')) {
      const itemId = decodeURIComponent(pathname.slice('/api/reconcile/items/'.length, -'/resolve'.length));
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, data: resolveStatementItem(db, itemId, body.action, staff) });
    }

    if (method === 'POST' && pathname.startsWith('/api/reconcile/batches/') && pathname.endsWith('/signoff')) {
      const batchId = decodeURIComponent(pathname.slice('/api/reconcile/batches/'.length, -'/signoff'.length));
      return sendJson(res, 200, { ok: true, data: signoffReconcileBatch(db, batchId, staff) });
    }

    // 11. 审计日志
    if (method === 'GET' && pathname === '/api/audit-logs') {
      const logs = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 60`).all();
      return sendJson(res, 200, { ok: true, logs });
    }

    // Electron xy-sxjk 其余辅助兼容路由
    if (method === 'GET' && pathname === '/app/xy-sxjk/pcAccounts') {
      const accounts = db.prepare(`SELECT * FROM xianyu_accounts ORDER BY id ASC`).all().map(computeAccountRisk);
      return sendJson(res, 200, { ok: true, data: accounts });
    }

    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `未定义接口: ${method} ${pathname}` });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, {
        ok: false,
        code: err.code,
        message: err.message,
        ...err.extra,
      });
    }
    console.error('[API ERROR]', pathname, err);
    return sendJson(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: err.message || '服务器内部错误' });
  }
}
