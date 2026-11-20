/**
 * 闲鱼监控引擎与工作台联动服务
 * 直接复用客户端核心过滤链 shared/sxjk-item-filter.js 与 areas.json，
 * 实现：全域监听轮询 / 店铺上新监控 / 钉钉加签测试 / 命中锁图一键建采购单 / SSE 实时推送
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filterPollCandidateItems,
  parseSellerBlacklistUserIds,
} from '../../shared/sxjk-item-filter.js';
import { withTx } from '../db/database.js';
import {
  HttpError,
  assertCleanCommunicationText,
  assertDingtalkRobotsReady,
  assertMonitorWithinPricebookCeiling,
  assertPracticeUnlocked,
  assertSafeMonitorAccount,
  assertSellerNotBlacklisted,
  computeAccountRisk,
  scanListingConditionRisk,
  validateTaskRangesAndInterval,
} from './guards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, '../../shared');

let cachedAreas = null;
export function getDivisionOptions() {
  if (cachedAreas) return cachedAreas;
  try {
    const raw = fs.readFileSync(path.join(SHARED_DIR, 'areas.json'), 'utf8');
    cachedAreas = JSON.parse(raw);
  } catch {
    cachedAreas = [];
  }
  return cachedAreas;
}

// SSE 连接池
const sseClients = new Set();
export function registerSseClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

export function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function writeAudit(db, actor, action, entityType, entityId, detail) {
  const id = `AUD-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_name, action, entity_type, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    actor?.id || 'system',
    actor?.name || '系统引擎',
    action,
    entityType,
    String(entityId || ''),
    typeof detail === 'string' ? detail : JSON.stringify(detail),
    new Date().toISOString()
  );
}

/**
 * 钉钉加签 URL 生成（timestamp + "\n" + secret → HMAC-SHA256 Base64）
 */
export function buildSignedDingtalkUrl(webhook, secret) {
  const ts = Date.now();
  const stringToSign = `${ts}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  const sign = encodeURIComponent(hmac);
  const sep = webhook.includes('?') ? '&' : '?';
  return `${webhook}${sep}timestamp=${ts}&sign=${sign}`;
}

/**
 * 本地校验钉钉机器人加签配置
 */
export async function testDingtalkRobot(db, robotId, staff) {
  assertPracticeUnlocked(staff);
  const bot = db.prepare(`SELECT * FROM dingtalk_robots WHERE id = ?`).get(String(robotId));
  if (!bot) throw new HttpError(404, 'DINGTALK_NOT_FOUND', `未找到钉钉机器人 ${robotId}`);

  const webhook = String(bot.webhook || '').trim();
  const secret = String(bot.secret || '').trim();
  if (!webhook || !webhook.startsWith('https://')) {
    throw new HttpError(400, 'INVALID_WEBHOOK', 'Webhook 必须是以 https:// 开头的钉钉机器人地址');
  }
  if (!secret || secret.length < 6) {
    const msg = '测试失败：未填写有效的加签 SEC 密钥（SEC 密钥不少于 6 位）';
    db.prepare(`UPDATE dingtalk_robots SET last_test_ok = 0, last_test_msg = ?, last_test_at = ? WHERE id = ?`)
      .run(msg, new Date().toISOString(), robotId);
    throw new HttpError(400, 'MISSING_DINGTALK_SECRET', msg);
  }

  buildSignedDingtalkUrl(webhook, secret);
  const resultMsg = '本地模拟成功（已生成 HMAC-SHA256 加签地址，模拟 errcode=0）';
  db.prepare(`UPDATE dingtalk_robots SET last_test_ok = 1, last_test_msg = ?, last_test_at = ? WHERE id = ?`)
    .run(resultMsg, new Date().toISOString(), robotId);
  writeAudit(db, staff, 'dingtalk_test', 'dingtalk_robot', robotId, { ok: true, resultMsg });
  return db.prepare(`SELECT * FROM dingtalk_robots WHERE id = ?`).get(robotId);
}

/**
 * 保存/更新钉钉机器人（改密钥后自动重置测试状态为待测，防跳过测试）
 */
export function upsertDingtalkRobot(db, payload, staff) {
  assertPracticeUnlocked(staff);
  const name = String(payload.name || '').trim();
  const webhook = String(payload.webhook || '').trim();
  const secret = String(payload.secret || '').trim();
  if (!name || !webhook) {
    throw new HttpError(400, 'INVALID_ROBOT', '机器人名称与 Webhook 不能为空');
  }
  const id = payload.id || `BOT-${Date.now().toString(36).toUpperCase()}`;
  const existing = db.prepare(`SELECT * FROM dingtalk_robots WHERE id = ?`).get(id);
  const now = new Date().toISOString();
  if (existing) {
    const changedCreds = existing.webhook !== webhook || existing.secret !== secret;
    db.prepare(
      `UPDATE dingtalk_robots
       SET name = ?, webhook = ?, secret = ?,
           last_test_ok = CASE WHEN ? THEN 0 ELSE last_test_ok END,
           last_test_msg = CASE WHEN ? THEN '凭证已修改，请重新连接测试' ELSE last_test_msg END
       WHERE id = ?`
    ).run(name, webhook, secret, changedCreds ? 1 : 0, changedCreds ? 1 : 0, id);
  } else {
    db.prepare(
      `INSERT INTO dingtalk_robots (id, name, webhook, secret, last_test_ok, last_test_msg, created_at)
       VALUES (?, ?, ?, ?, 0, '尚未连接测试，请先点发送测试消息', ?)`
    ).run(id, name, webhook, secret, now);
  }
  return db.prepare(`SELECT * FROM dingtalk_robots WHERE id = ?`).get(id);
}

/**
 * 智能生成检索分词（对应 xianyu-waimai /app/xy-sxjk/generateMatchKeywords 逻辑）
 */
export function generateMatchKeywordsSuggestion(searchKeyword) {
  const kw = String(searchKeyword || '').trim();
  const low = kw.toLowerCase();
  if (!kw) {
    return {
      match_sub: '个人自用 | 国行 | 箱说全 | 几乎全新',
      exclude_keywords: '坏机 | 零件 | 维修 | 定金 | 租赁 | 到付定金',
      seller_exclude_keywords: '官方商城 | 二手批发 | 回收宝',
    };
  }
  if (low.includes('macbook') || low.includes('mbp')) {
    return {
      match_sub: '16+512 | M3 | 14寸 | 几乎全新 | 国行',
      exclude_keywords: '进水 | ID锁 | 绕过 | 碎屏 | 维修 | 扩容 | 仅主板 | 定金',
      seller_exclude_keywords: '官方商城 | 回收宝 | 二手批发',
    };
  }
  if (low.includes('iphone') || low.includes('苹果')) {
    return {
      match_sub: '国行 | 256G | 原装 | 无拆修 | 电池90%',
      exclude_keywords: '美版 | 日版 | 卡贴 | 有锁 | 换屏 | 面容坏 | 扩容 | 演示机',
      seller_exclude_keywords: '手机靓号行 | 华强北批发',
    };
  }
  if (low.includes('sony') || low.includes('a7') || low.includes('相机')) {
    return {
      match_sub: '单机身 | 快门 | 国行 | CMOS | 原盒',
      exclude_keywords: '发霉 | 进灰严重 | 摔过 | 故障 | 仅外壳 | 租赁 | 模型',
      seller_exclude_keywords: '器材租赁店',
    };
  }
  if (low.includes('rog') || low.includes('显示器') || low.includes('tuf') || low.includes('dell')) {
    return {
      match_sub: '27寸 | 2K | 原盒 | 完美屏 | 顺丰',
      exclude_keywords: '碎屏 | 漏液 | 竖线 | 亮线 | 自提不出外地 | 坏屏配件',
      seller_exclude_keywords: '网吧清仓批发',
    };
  }
  return {
    match_sub: `${kw} | 国行 | 个人自用 | 原盒 | 几乎全新`,
    exclude_keywords: '坏机 | 零件 | 维修 | 定金 | 租赁 | 扩容 | 仅尸体',
    seller_exclude_keywords: '官方商城 | 批发商行',
  };
}

function hydrateListenTask(row) {
  if (!row) return null;
  const parseJson = (s, fb) => {
    try {
      return JSON.parse(s);
    } catch {
      return fb;
    }
  };
  return {
    ...row,
    match_sub_price_ranges: parseJson(row.match_sub_price_ranges, {}),
    division_options: parseJson(row.division_options, []),
    quick_filters: parseJson(row.quick_filters, []),
    listen_account_ids: parseJson(row.listen_account_ids, []),
    miaopai_account_ids: parseJson(row.miaopai_account_ids, []),
    dingtalk_robot_ids: parseJson(row.dingtalk_robot_ids, []),
    greeting_template_ids: parseJson(row.greeting_template_ids, []),
    enabled: Number(row.enabled) === 1,
    miaopai_enabled: Number(row.miaopai_enabled) === 1,
    greeting_enabled: Number(row.greeting_enabled) === 1,
    filter_pushed_enabled: Number(row.filter_pushed_enabled) === 1,
  };
}

function hydrateShopTask(row) {
  if (!row) return null;
  const parseJson = (s, fb) => {
    try {
      return JSON.parse(s);
    } catch {
      return fb;
    }
  };
  return {
    ...row,
    listen_account_ids: parseJson(row.listen_account_ids, []),
    miaopai_account_ids: parseJson(row.miaopai_account_ids, []),
    dingtalk_robot_ids: parseJson(row.dingtalk_robot_ids, []),
    enabled: Number(row.enabled) === 1,
    miaopai_enabled: Number(row.miaopai_enabled) === 1,
  };
}

/**
 * 新建/保存全域关键词监听任务（严格串行执行防呆校验）
 */
export function saveGlobalListenTask(db, payload, staff) {
  assertPracticeUnlocked(staff);
  const name = String(payload.name || '').trim();
  const searchKeyword = String(payload.search_keyword || '').trim();
  if (!name || !searchKeyword) {
    throw new HttpError(400, 'INVALID_TASK_FIELDS', '任务名称与搜索主关键词不能为空');
  }

  // 防风控与区间校验
  validateTaskRangesAndInterval(db, payload);

  // 关联行情参考表上限硬锁 (403)
  assertMonitorWithinPricebookCeiling(
    db,
    staff,
    payload.pricebook_sku,
    payload.price_to,
    payload.miaopai_enabled ? payload.miaopai_price_to : null
  );

  // 若启用了钉钉推送，必须机器人已填加签且测试通过 (409)
  const robotIds = Array.isArray(payload.dingtalk_robot_ids) ? payload.dingtalk_robot_ids : [];
  if (robotIds.length) {
    assertDingtalkRobotsReady(db, robotIds);
  }

  // 若开启自动秒拍或选定了秒拍账号，严防高退款率红标号接入自动锁单 (409)
  if (payload.miaopai_enabled) {
    const mpIds = Array.isArray(payload.miaopai_account_ids) ? payload.miaopai_account_ids : [];
    if (!mpIds.length) {
      throw new HttpError(400, 'MISSING_MIAOPAI_ACCOUNT', '启用自动秒拍必须选择至少一个安全绿灯监听账号');
    }
    for (const aid of mpIds) {
      assertSafeMonitorAccount(db, aid, true);
    }
  }

  // 如果启用自动打招呼，检查所选模板（若内含违禁词拦截 422）
  const grIds = Array.isArray(payload.greeting_template_ids) ? payload.greeting_template_ids : [];
  if (payload.greeting_enabled && grIds.length) {
    for (const gid of grIds) {
      const tpl = db.prepare(`SELECT * FROM greeting_templates WHERE id = ?`).get(Number(gid));
      if (tpl) assertCleanCommunicationText(tpl.text_content, `自动打招呼话术「${tpl.title}」`);
    }
  }

  const now = new Date().toISOString();
  const id = payload.id || `TASK-${Date.now().toString(36).toUpperCase()}`;
  const existing = db.prepare(`SELECT id FROM monitor_listen_tasks WHERE id = ?`).get(id);

  const fields = {
    name,
    search_keyword: searchKeyword,
    match_sub: String(payload.match_sub || ''),
    exclude_keywords: String(payload.exclude_keywords || ''),
    seller_exclude_keywords: String(payload.seller_exclude_keywords || ''),
    match_sub_price_ranges: JSON.stringify(payload.match_sub_price_ranges || {}),
    price_from: payload.price_from !== '' && payload.price_from != null ? Number(payload.price_from) : null,
    price_to: payload.price_to !== '' && payload.price_to != null ? Number(payload.price_to) : null,
    division_options: JSON.stringify(Array.isArray(payload.division_options) ? payload.division_options : []),
    sort_mode: String(payload.sort_mode || 'publish_latest'),
    publish_within_minutes:
      payload.publish_within_minutes != null && payload.publish_within_minutes !== ''
        ? Number(payload.publish_within_minutes)
        : 30,
    quick_filters: JSON.stringify(Array.isArray(payload.quick_filters) ? payload.quick_filters : ['filterPersonal']),
    filter_pushed_enabled: payload.filter_pushed_enabled === false ? 0 : 1,
    interval_seconds: Number(payload.interval_seconds || 15),
    listen_account_ids: JSON.stringify(
      Array.isArray(payload.listen_account_ids) && payload.listen_account_ids.length
        ? payload.listen_account_ids
        : ['ACC-GF-03']
    ),
    miaopai_enabled: payload.miaopai_enabled ? 1 : 0,
    miaopai_account_ids: JSON.stringify(Array.isArray(payload.miaopai_account_ids) ? payload.miaopai_account_ids : []),
    miaopai_price_from:
      payload.miaopai_price_from !== '' && payload.miaopai_price_from != null ? Number(payload.miaopai_price_from) : null,
    miaopai_price_to:
      payload.miaopai_price_to !== '' && payload.miaopai_price_to != null ? Number(payload.miaopai_price_to) : null,
    dingtalk_robot_ids: JSON.stringify(robotIds),
    greeting_enabled: payload.greeting_enabled ? 1 : 0,
    greeting_template_ids: JSON.stringify(grIds),
    pricebook_sku: String(payload.pricebook_sku || ''),
    enabled: payload.enabled === false ? 0 : 1,
  };

  if (existing) {
    db.prepare(
      `UPDATE monitor_listen_tasks SET
         name=?, search_keyword=?, match_sub=?, exclude_keywords=?, seller_exclude_keywords=?,
         match_sub_price_ranges=?, price_from=?, price_to=?, division_options=?, sort_mode=?,
         publish_within_minutes=?, quick_filters=?, filter_pushed_enabled=?, interval_seconds=?,
         listen_account_ids=?, miaopai_enabled=?, miaopai_account_ids=?, miaopai_price_from=?,
         miaopai_price_to=?, dingtalk_robot_ids=?, greeting_enabled=?, greeting_template_ids=?,
         pricebook_sku=?, enabled=?, updated_at=?
       WHERE id=?`
    ).run(
      fields.name,
      fields.search_keyword,
      fields.match_sub,
      fields.exclude_keywords,
      fields.seller_exclude_keywords,
      fields.match_sub_price_ranges,
      fields.price_from,
      fields.price_to,
      fields.division_options,
      fields.sort_mode,
      fields.publish_within_minutes,
      fields.quick_filters,
      fields.filter_pushed_enabled,
      fields.interval_seconds,
      fields.listen_account_ids,
      fields.miaopai_enabled,
      fields.miaopai_account_ids,
      fields.miaopai_price_from,
      fields.miaopai_price_to,
      fields.dingtalk_robot_ids,
      fields.greeting_enabled,
      fields.greeting_template_ids,
      fields.pricebook_sku,
      fields.enabled,
      now,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO monitor_listen_tasks (
         id, name, search_keyword, match_sub, exclude_keywords, seller_exclude_keywords,
         match_sub_price_ranges, price_from, price_to, division_options, sort_mode,
         publish_within_minutes, quick_filters, filter_pushed_enabled, interval_seconds,
         listen_account_ids, miaopai_enabled, miaopai_account_ids, miaopai_price_from,
         miaopai_price_to, dingtalk_robot_ids, greeting_enabled, greeting_template_ids,
         pricebook_sku, enabled, created_by, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      fields.name,
      fields.search_keyword,
      fields.match_sub,
      fields.exclude_keywords,
      fields.seller_exclude_keywords,
      fields.match_sub_price_ranges,
      fields.price_from,
      fields.price_to,
      fields.division_options,
      fields.sort_mode,
      fields.publish_within_minutes,
      fields.quick_filters,
      fields.filter_pushed_enabled,
      fields.interval_seconds,
      fields.listen_account_ids,
      fields.miaopai_enabled,
      fields.miaopai_account_ids,
      fields.miaopai_price_from,
      fields.miaopai_price_to,
      fields.dingtalk_robot_ids,
      fields.greeting_enabled,
      fields.greeting_template_ids,
      fields.pricebook_sku,
      fields.enabled,
      staff.id,
      now,
      now
    );
  }

  writeAudit(db, staff, existing ? 'monitor_task_updated' : 'monitor_task_created', 'listen_task', id, {
    name: fields.name,
    pricebook_sku: fields.pricebook_sku,
    price_to: fields.price_to,
  });
  return hydrateListenTask(db.prepare(`SELECT * FROM monitor_listen_tasks WHERE id = ?`).get(id));
}

/**
 * 新建/保存店铺上新监控，并与收藏卖家双向同步
 */
export function saveShopMonitorTask(db, payload, staff) {
  assertPracticeUnlocked(staff);
  const sellerUserId = String(payload.seller_user_id || '').trim();
  const sellerNick = String(payload.seller_nick || sellerUserId).trim();
  if (!sellerUserId) {
    throw new HttpError(400, 'INVALID_SELLER_ID', '店铺卖家 ID 不能为空');
  }
  assertSellerNotBlacklisted(db, sellerUserId);
  validateTaskRangesAndInterval(db, payload);
  assertMonitorWithinPricebookCeiling(db, staff, payload.pricebook_sku, payload.price_to, null);

  const robotIds = Array.isArray(payload.dingtalk_robot_ids) ? payload.dingtalk_robot_ids : [];
  if (robotIds.length) assertDingtalkRobotsReady(db, robotIds);
  if (payload.miaopai_enabled) {
    for (const aid of payload.miaopai_account_ids || []) {
      assertSafeMonitorAccount(db, aid, true);
    }
  }

  const now = new Date().toISOString();
  const id = payload.id || `SHOP-${Date.now().toString(36).toUpperCase()}`;
  const existing = db.prepare(`SELECT * FROM monitor_shop_tasks WHERE id = ?`).get(id);
  const shopUrl = payload.shop_url || `https://shop.demo.invalid/personal?userId=${encodeURIComponent(sellerUserId)}`;
  const listenIds = JSON.stringify(
    Array.isArray(payload.listen_account_ids) && payload.listen_account_ids.length
      ? payload.listen_account_ids
      : ['ACC-GF-03']
  );

  withTx(db, () => {
    if (existing) {
      db.prepare(
        `UPDATE monitor_shop_tasks SET
           seller_user_id=?, seller_nick=?, shop_url=?, match_sub=?, exclude_keywords=?,
           price_from=?, price_to=?, pricebook_sku=?, listen_account_ids=?, miaopai_enabled=?,
           miaopai_account_ids=?, dingtalk_robot_ids=?, interval_seconds=?, enabled=?, updated_at=?
         WHERE id=?`
      ).run(
        sellerUserId,
        sellerNick,
        shopUrl,
        String(payload.match_sub || ''),
        String(payload.exclude_keywords || ''),
        payload.price_from !== '' && payload.price_from != null ? Number(payload.price_from) : null,
        payload.price_to !== '' && payload.price_to != null ? Number(payload.price_to) : null,
        String(payload.pricebook_sku || ''),
        listenIds,
        payload.miaopai_enabled ? 1 : 0,
        JSON.stringify(payload.miaopai_account_ids || []),
        JSON.stringify(robotIds),
        Number(payload.interval_seconds || 30),
        payload.enabled === false ? 0 : 1,
        now,
        id
      );
    } else {
      db.prepare(
        `INSERT INTO monitor_shop_tasks (
           id, seller_user_id, seller_nick, shop_url, match_sub, exclude_keywords,
           price_from, price_to, pricebook_sku, listen_account_ids, miaopai_enabled,
           miaopai_account_ids, dingtalk_robot_ids, interval_seconds, favorite_seller_id,
           enabled, created_by, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        sellerUserId,
        sellerNick,
        shopUrl,
        String(payload.match_sub || ''),
        String(payload.exclude_keywords || ''),
        payload.price_from !== '' && payload.price_from != null ? Number(payload.price_from) : null,
        payload.price_to !== '' && payload.price_to != null ? Number(payload.price_to) : null,
        String(payload.pricebook_sku || ''),
        listenIds,
        payload.miaopai_enabled ? 1 : 0,
        JSON.stringify(payload.miaopai_account_ids || []),
        JSON.stringify(robotIds),
        Number(payload.interval_seconds || 30),
        sellerUserId,
        payload.enabled === false ? 0 : 1,
        staff.id,
        now,
        now
      );
    }

    // 双向关联收藏卖家池
    const fav = db.prepare(`SELECT seller_id FROM favorite_sellers WHERE seller_id = ?`).get(sellerUserId);
    if (fav) {
      db.prepare(`UPDATE favorite_sellers SET shop_monitor_id = ?, updated_at = ? WHERE seller_id = ?`).run(
        id,
        now,
        sellerUserId
      );
    } else if (payload.sync_to_favorite !== false) {
      db.prepare(
        `INSERT INTO favorite_sellers (seller_id, seller_nick, category_focus, visibility_scope, owner_staff_id, tags_json, notes, total_deals, shop_monitor_id, updated_at)
         VALUES (?, ?, ?, 'personal', ?, ?, ?, 0, ?, ?)`
      ).run(
        sellerUserId,
        sellerNick,
        payload.category_focus || '店铺监控关联',
        staff.id,
        JSON.stringify(['店铺监控自动关注']),
        '由监控中心店铺监听自动同步入收藏卖家池',
        id,
        now
      );
    }
  });

  writeAudit(db, staff, 'shop_monitor_saved', 'monitor_shop_task', id, { sellerUserId, sellerNick });
  return hydrateShopTask(db.prepare(`SELECT * FROM monitor_shop_tasks WHERE id = ?`).get(id));
}

/**
 * 构建用于过滤链的模拟+可插拔真实闲鱼候选批（含合格捡漏单、超价噪音、排除词噪音、黑名单噪音）
 */
function buildCandidateBatchForTask(task, pb, sampleIdx) {
  const nowMs = Date.now();
  const kw = task.search_keyword || '数码自用';
  const refYuan = pb ? pb.ref_cents / 100 : Math.round((Number(task.price_to) || 4000) * 1.08);
  const ceilingYuan = pb ? pb.ceiling_cents / 100 : Number(task.price_to) || 3800;
  const targetYuan = pb ? pb.target_cents / 100 : Math.round(ceilingYuan * 0.94);

  const firstSub = String(task.match_sub || '')
    .split(/[|｜,，]/)[0]
    ?.trim();
  const samplePicMap = [
    '/evidence/item_mbp_m3.jpg',
    '/evidence/item_ip15p.jpg',
    '/evidence/item_a7m4.jpg',
    '/evidence/item_rog_2k.jpg',
    '/evidence/item_ipad_m2.jpg',
    '/evidence/item_dell_4k.jpg',
  ];
  const kwLow = kw.toLowerCase();
  let pic = samplePicMap[sampleIdx % samplePicMap.length];
  if (kwLow.includes('mac') || kwLow.includes('mbp')) pic = '/evidence/item_mbp_m3.jpg';
  else if (kwLow.includes('iphone')) pic = '/evidence/item_ip15p.jpg';
  else if (kwLow.includes('sony') || kwLow.includes('a7')) pic = '/evidence/item_a7m4.jpg';
  else if (kwLow.includes('rog') || kwLow.includes('显示')) pic = '/evidence/item_rog_2k.jpg';
  else if (kwLow.includes('ipad')) pic = '/evidence/item_ipad_m2.jpg';

  const randCode = crypto.randomBytes(2).toString('hex').toUpperCase();
  const goodPrice = Math.max(300, Math.round(targetYuan - (sampleIdx % 3) * 40));

  return [
    {
      itemId: `GF-POLL-${randCode}-A`,
      title: `${kw} ${firstSub || '国行'} 几乎全新 个人自用急出包顺丰`,
      desc: `个人一手自用，买来放家里吃灰几乎全新，箱说配件齐全，诚心收可顺丰保价，今天直接拍优先发！`,
      price: String(goodPrice),
      seller: `杭州自用卖家_${randCode}`,
      sellerNick: `杭州自用卖家_${randCode}`,
      sellerUserId: `SELLER-POLL-${randCode}`,
      sellerBlacklistId: `SELLER-POLL-${randCode}`,
      area: '浙江 杭州 西湖区',
      publishTimeMs: nowMs - 90 * 1000,
      picUrl: pic,
      images: [pic, '/evidence/snapshot-description.png', '/evidence/snapshot-condition.png'],
      tags: ['个人自用', '刚刚发布', '信用极好'],
    },
    {
      itemId: `GF-POLL-${randCode}-B`,
      title: `${kw} ${firstSub || ''} 全套仅拆封 低于行价`,
      desc: `公司年会抽中闲置，配件未拆，看上拍下发顺丰。`,
      price: String(ceilingYuan + 420), // 故作超预算噪音：应被 globalPrice 过滤拦截
      seller: `溢价卖家_${randCode}`,
      sellerNick: `溢价卖家_${randCode}`,
      sellerUserId: `SELLER-HI-${randCode}`,
      area: '上海 浦东新区',
      publishTimeMs: nowMs - 120 * 1000,
      picUrl: pic,
      images: [pic],
      tags: ['超上限噪音'],
    },
    {
      itemId: `GF-POLL-${randCode}-C`,
      title: `${kw} ${firstSub || ''} 坏机维修配件 定金不退 勿直接拍`,
      desc: `主板坏机拆件定金专拍`,
      price: String(goodPrice), // 在价格区间内但命中标题排除词：应被 excludeTitle 精准拦截
      seller: `配件摊_${randCode}`,
      sellerNick: `配件摊_${randCode}`,
      sellerUserId: `SELLER-EX-${randCode}`,
      area: '广东 深圳',
      publishTimeMs: nowMs - 150 * 1000,
      picUrl: pic,
      images: [pic],
      tags: ['排除词噪音'],
    },
    {
      itemId: `GF-POLL-${randCode}-D`,
      title: `${kw} ${firstSub || ''} 成色好 实体批发`,
      desc: `华强北批量出货`,
      price: String(goodPrice - 50),
      seller: '华强北专业翻新老李',
      sellerNick: '华强北专业翻新老李',
      sellerUserId: 'BLK-SELLER-991',
      sellerBlacklistId: 'BLK-SELLER-991', // 应被商家黑名单精确拦截
      area: '广东 深圳 华强北',
      publishTimeMs: nowMs - 180 * 1000,
      picUrl: pic,
      images: [pic],
      tags: ['黑名单噪音'],
    },
  ];
}

/**
 * 执行一次真实的全域监控轮询（调用 shared/sxjk-item-filter.js 完整过滤链）
 */
export function runGlobalTaskPoll(db, taskId, staff) {
  const row = db.prepare(`SELECT * FROM monitor_listen_tasks WHERE id = ?`).get(String(taskId));
  if (!row) throw new HttpError(404, 'TASK_NOT_FOUND', `未找到监控任务 ${taskId}`);
  const task = hydrateListenTask(row);

  const pb = task.pricebook_sku
    ? db
        .prepare(`SELECT * FROM pricebook_items WHERE sku_code = ? AND status = 'published' ORDER BY version_no DESC LIMIT 1`)
        .get(task.pricebook_sku)
    : null;

  const blRows = db.prepare(`SELECT user_id, plain_user_id, nick FROM seller_blacklist`).all();
  const sellerBlacklistIds = parseSellerBlacklistUserIds({
    seller_blacklist_user_ids: blRows.flatMap((r) => [r.user_id, r.plain_user_id].filter(Boolean)),
  });
  const extraSellerExcludeRaw = blRows.map((r) => r.nick).filter(Boolean).join('|');

  const pushedRows = db.prepare(`SELECT item_id FROM monitor_hits WHERE source_task_id = ?`).all(task.id);
  const pushedSet = new Set(pushedRows.map((r) => r.item_id));

  const rawCandidates = buildCandidateBatchForTask(task, pb, Number(row.hit_count || 0));
  const taskBody = {
    price_from: task.price_from,
    price_to: task.price_to,
    match_sub: task.match_sub,
    exclude_keywords: task.exclude_keywords,
    exclude_seller_keywords: task.seller_exclude_keywords,
    match_sub_price_ranges: task.match_sub_price_ranges,
    sort_mode: task.sort_mode,
    sort_latest_within_minutes: task.publish_within_minutes,
  };

  const { items: matchedItems, stats } = filterPollCandidateItems(rawCandidates, taskBody, {
    sellerBlacklistIds,
    pushedSet,
    shouldFilterPushed: task.filter_pushed_enabled,
    extraSellerExcludeRaw,
  });

  // 根据 5% 防红标规则自动优选当前监听账号组内最安全账号作为归属展示账号
  const boundAccounts = (task.listen_account_ids || [])
    .map((id) => db.prepare(`SELECT * FROM xianyu_accounts WHERE id = ?`).get(id))
    .filter(Boolean)
    .map(computeAccountRisk)
    .sort((a, b) => a.refund_rate_pct - b.refund_rate_pct);
  const primaryAccountId = boundAccounts[0]?.id || 'ACC-GF-03';

  const now = new Date().toISOString();
  const createdHits = [];

  withTx(db, () => {
    for (const it of matchedItems) {
      const priceYuan = Number(it.price || 0);
      const priceCents = Math.round(priceYuan * 100);
      const refCents = pb ? Number(pb.ref_cents) : Math.round(priceCents * 1.07);
      const ceilingCents = pb ? Number(pb.ceiling_cents) : Math.round((Number(task.price_to) || priceYuan) * 100);
      const prebuySaveCents = Math.max(0, refCents - priceCents);
      const prebuyCommCents = Math.round(prebuySaveCents * 0.1);
      const risk = scanListingConditionRisk(it.title, it.desc);

      const hitId = `HIT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO monitor_hits (
             hit_id, source_type, source_task_id, source_task_name, platform, item_id, account_id,
             title, desc_text, price_yuan, price_str, seller_user_id, seller_nick, area_text,
             publish_time_ms, pic_url, images_json, tags_json, pricebook_sku, ref_cents, ceiling_cents,
             prebuy_save_cents, prebuy_comm_cents, suspect_quality_flag, prebuy_warning,
             dingtalk_pushed, greeting_sent, raw_payload, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          hitId,
          'global',
          task.id,
          task.name,
          'goofish',
          it.itemId,
          primaryAccountId,
          it.title,
          it.desc || '',
          priceYuan,
          String(priceYuan),
          it.sellerUserId || it.seller,
          it.sellerNick || it.seller,
          it.area || '全国',
          Number(it.publishTimeMs || Date.now()),
          it.picUrl || '/evidence/item_mbp_m3.jpg',
          JSON.stringify(it.images || [it.picUrl || '/evidence/item_mbp_m3.jpg']),
          JSON.stringify(it.tags || []),
          task.pricebook_sku || '',
          refCents,
          ceilingCents,
          prebuySaveCents,
          prebuyCommCents,
          risk.suspect_quality_flag ? 1 : 0,
          risk.prebuy_warning,
          (task.dingtalk_robot_ids || []).length > 0 ? 1 : 0,
          task.greeting_enabled ? 1 : 0,
          JSON.stringify(it),
          now
        );

      if (res.changes > 0) {
        const inserted = db.prepare(`SELECT * FROM monitor_hits WHERE hit_id = ?`).get(hitId);
        createdHits.push(inserted);
      }
    }

    const filteredOutCount =
      (stats.removed?.globalPrice || 0) +
      (stats.removed?.excludeTitle || 0) +
      (stats.removed?.excludeSeller || 0) +
      (stats.removed?.matchInclude || 0) +
      (stats.removed?.matchSubKeywordPrice || 0) +
      (stats.removed?.blacklist || 0);

    db.prepare(
      `INSERT INTO monitor_poll_logs (
         task_id, task_name, source_type, raw_count, deduped_count, filtered_out_count,
         matched_count, pushed_count, account_id, detail_json, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      task.id,
      task.name,
      'global',
      rawCandidates.length,
      stats.afterPageDedupeCount || rawCandidates.length,
      filteredOutCount,
      matchedItems.length,
      createdHits.length,
      primaryAccountId,
      JSON.stringify({ stats, activeFiltersSummary: stats.activeFiltersSummary }),
      now
    );

    db.prepare(`UPDATE monitor_listen_tasks SET last_run_at = ?, hit_count = hit_count + ? WHERE id = ?`).run(
      now,
      createdHits.length,
      task.id
    );
  });

  if (createdHits.length) {
    broadcastSse('monitor:hit', { task_id: task.id, hits: createdHits, stats });
  }
  if (staff) {
    writeAudit(db, staff, 'monitor_poll_manual', 'listen_task', task.id, {
      raw: rawCandidates.length,
      matched: matchedItems.length,
      created: createdHits.length,
      stats,
    });
  }

  return {
    task_id: task.id,
    task_name: task.name,
    raw_count: rawCandidates.length,
    matched_count: matchedItems.length,
    created_hits: createdHits,
    stats,
  };
}

/**
 * 命中商品一键锁10图快照并转入正式采购工作台（买前流程 + IM 会话 + 5%防红标账号拦截）
 */
export function promoteHitToCase(db, hitId, staff, opts = {}) {
  assertPracticeUnlocked(staff);
  const hit = db.prepare(`SELECT * FROM monitor_hits WHERE hit_id = ?`).get(String(hitId));
  if (!hit) throw new HttpError(404, 'HIT_NOT_FOUND', `未找到监控命中商品 ${hitId}`);

  if (hit.linked_case_id && !opts.allow_duplicate) {
    const existingCase = db.prepare(`SELECT * FROM procurement_cases WHERE case_id = ?`).get(hit.linked_case_id);
    if (existingCase) {
      return {
        already_linked: true,
        case: existingCase,
        conv_id: hit.linked_conv_id,
      };
    }
  }

  // 黑名单硬拦截
  assertSellerNotBlacklisted(db, hit.seller_user_id);

  // 目标接单账号 5% 防红标核验：只要商品存在成色质疑或用户请求自动锁单，严禁使用接近 5% 红标号
  const targetAccountId = String(opts.account_id || hit.account_id || 'ACC-GF-03');
  const isHighRisk = Number(hit.suspect_quality_flag) === 1 || Boolean(opts.lock_order);
  const safeAccount = assertSafeMonitorAccount(db, targetAccountId, isHighRisk);

  // 金额不能超行情上限（除非 ADMIN 特批）
  const priceYuan = Number(hit.price_yuan || 0);
  if (hit.ceiling_cents && Math.round(priceYuan * 100) > Number(hit.ceiling_cents) && staff.role !== 'ADMIN') {
    throw new HttpError(
      403,
      'MONITOR_PRICE_EXCEEDS_CEILING',
      `该命中商品挂价 ¥${priceYuan} 超过行情上限 ¥${hit.ceiling_cents / 100}，严禁采购员直接建单，请先砍价或请主管特批`
    );
  }

  const now = new Date().toISOString();
  const stamp = Date.now().toString(36).toUpperCase();
  const snapId = `SNAP-HIT-${stamp}`;
  const convId = `CONV-HIT-${stamp}`;
  const caseId = `CASE-${stamp}`;
  const priceCents = Math.round(priceYuan * 100);
  const pb = hit.pricebook_sku
    ? db
        .prepare(`SELECT * FROM pricebook_items WHERE sku_code = ? AND status = 'published' ORDER BY version_no DESC LIMIT 1`)
        .get(hit.pricebook_sku)
    : null;

  const refCents = pb ? Number(pb.ref_cents) : Number(hit.ref_cents || Math.round(priceCents * 1.06));
  const initCents = pb ? Number(pb.initial_offer_cents) : Math.round(priceCents * 0.92);
  const targetCents = pb ? Number(pb.target_cents) : priceCents;
  const ceilingCents = pb ? Number(pb.ceiling_cents) : Number(hit.ceiling_cents || priceCents);
  const imgs = (() => {
    try {
      return JSON.parse(hit.images_json || '[]');
    } catch {
      return [hit.pic_url || '/evidence/item_mbp_m3.jpg'];
    }
  })();

  const result = withTx(db, () => {
    db.prepare(
      `INSERT INTO item_snapshots (
         snapshot_id, product_id, version_no, seller_title, seller_declaration,
         pricebook_sku, pricebook_ref_version, images_json, source_type, captured_by, captured_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, '监控自动锁图(10图归档)', ?, ?)`
    ).run(
      snapId,
      hit.item_id,
      hit.title,
      hit.desc_text || hit.title,
      hit.pricebook_sku || pb?.sku_code || '',
      pb?.version_no || 1,
      JSON.stringify(imgs.length ? imgs : ['/evidence/item_mbp_m3.jpg']),
      staff.id,
      now
    );

    const advice =
      Number(hit.suspect_quality_flag) === 1
        ? `【监控直转】卖家标『几乎全新』，严禁在 IM 追问划痕！用「${safeAccount.account_name}」(${safeAccount.refund_rate_pct}%) 打质疑成色标跟进拍下。`
        : `【监控直转】按行情目标价 ¥${targetCents / 100} 谈判，绝对上限 ¥${ceilingCents / 100}。`;

    db.prepare(
      `INSERT INTO conversations (
         conv_id, account_id, product_id, bucket, seller_id, seller_nick, sku_code, title,
         listed_cents, ref_cents, initial_offer_cents, target_cents, ceiling_cents, agreed_cents,
         pause_state, context_version, snapshot_id, seller_attitude, ai_score, advice_summary,
         needs_manual, wait_minutes, unread_count, slow_group, matched_status, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      convId,
      safeAccount.id,
      hit.item_id,
      opts.lock_order ? 'urgent_10m' : 'bargaining',
      hit.seller_user_id,
      hit.seller_nick,
      hit.pricebook_sku || pb?.sku_code || 'CUSTOM-SKU',
      hit.title,
      priceCents,
      refCents,
      initCents,
      targetCents,
      ceilingCents,
      opts.lock_order ? priceCents : null,
      'auto',
      1,
      snapId,
      'willing_drop',
      86,
      advice,
      Number(hit.suspect_quality_flag) === 1 ? 1 : 0,
      1,
      1,
      0,
      'matched',
      now
    );

    db.prepare(
      `INSERT INTO messages (msg_id, conv_id, sender_type, sender_name, body, offer_cents, round_no, idempotency_key, created_at)
       VALUES (?, ?, 'system', '监控锁图卫士', ?, ?, 1, ?, ?)`
    ).run(
      `MSG-${stamp}`,
      convId,
      `已自动固定宝贝原始多图快照 ${snapId}（挂价 ¥${priceYuan}，参考价 M=¥${refCents / 100}）。${
        hit.prebuy_warning || '请严守 6 步买前合规动作推进。'
      }`,
      priceCents,
      `promote-${hitId}-${stamp}`,
      now
    );

    const extOrd = opts.lock_order ? `GF-LOCK-${stamp}` : null;
    db.prepare(
      `INSERT INTO procurement_cases (
         case_id, order_bucket, lvl, title, sku_code, model_name, account_id, seller_id, seller_nick,
         conv_id, snapshot_id, pricebook_ref_version, ref_cents, target_cents, ceiling_cents,
         agreed_cents, prebuy_step, suspect_quality_flag, prebuy_note, external_order_no,
         sf_delivery_status, warehouse_check_state, owner_staff_id, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      caseId,
      'today',
      Number(hit.suspect_quality_flag) === 1 ? 'red' : 'grn',
      `【监控转单】${hit.title}`,
      hit.pricebook_sku || pb?.sku_code || 'CUSTOM-SKU',
      pb?.model_name || hit.title.slice(0, 32),
      safeAccount.id,
      hit.seller_user_id,
      hit.seller_nick,
      convId,
      snapId,
      pb?.version_no || 1,
      refCents,
      targetCents,
      ceilingCents,
      opts.lock_order ? priceCents : null,
      opts.lock_order ? 4 : 2,
      Number(hit.suspect_quality_flag) === 1 ? 1 : 0,
      hit.prebuy_warning || '从闲鱼监控池锁定快照转入',
      extOrd,
      'prebuy',
      'pending',
      staff.id,
      now,
      now
    );

    db.prepare(
      `UPDATE monitor_hits SET linked_case_id = ?, linked_conv_id = ?, locked_order_id = COALESCE(?, locked_order_id) WHERE hit_id = ?`
    ).run(caseId, convId, extOrd, hitId);

    writeAudit(db, staff, opts.lock_order ? 'hit_locked_order' : 'hit_promoted_to_case', 'monitor_hit', hitId, {
      caseId,
      convId,
      snapId,
      accountId: safeAccount.id,
    });

    return {
      already_linked: false,
      snapshot_id: snapId,
      conv_id: convId,
      case: db.prepare(`SELECT * FROM procurement_cases WHERE case_id = ?`).get(caseId),
      hit: db.prepare(`SELECT * FROM monitor_hits WHERE hit_id = ?`).get(hitId),
    };
  });

  broadcastSse('case:created', { case: result.case, hit_id: hitId });
  return result;
}

export function listMonitorOverview(db) {
  const listenTasks = db.prepare(`SELECT * FROM monitor_listen_tasks ORDER BY updated_at DESC`).all().map(hydrateListenTask);
  const shopTasks = db.prepare(`SELECT * FROM monitor_shop_tasks ORDER BY updated_at DESC`).all().map(hydrateShopTask);
  const hits = db.prepare(`SELECT * FROM monitor_hits ORDER BY created_at DESC LIMIT 80`).all().map((h) => ({
    ...h,
    images: (() => {
      try {
        return JSON.parse(h.images_json || '[]');
      } catch {
        return [];
      }
    })(),
    tags: (() => {
      try {
        return JSON.parse(h.tags_json || '[]');
      } catch {
        return [];
      }
    })(),
    suspect_quality_flag: Number(h.suspect_quality_flag) === 1,
  }));
  const robots = db.prepare(`SELECT * FROM dingtalk_robots ORDER BY created_at ASC`).all();
  const greetings = db.prepare(`SELECT * FROM greeting_templates ORDER BY id ASC`).all();
  const blacklist = db.prepare(`SELECT * FROM seller_blacklist ORDER BY added_at DESC`).all();
  const logs = db.prepare(`SELECT * FROM monitor_poll_logs ORDER BY id DESC LIMIT 40`).all();
  const accounts = db.prepare(`SELECT * FROM xianyu_accounts ORDER BY id ASC`).all().map(computeAccountRisk);

  return {
    listen_tasks: listenTasks,
    shop_tasks: shopTasks,
    hits,
    robots,
    greetings,
    blacklist,
    logs,
    accounts,
  };
}

let bgTimer = null;
export function startBackgroundMonitorLoop(db) {
  if (bgTimer) return;
  // 每 60 秒轻巡检到期任务，不造成高CPU与噪音
  bgTimer = setInterval(() => {
    try {
      const now = Date.now();
      const tasks = db.prepare(`SELECT * FROM monitor_listen_tasks WHERE enabled = 1`).all();
      for (const t of tasks) {
        const lastMs = t.last_run_at ? Date.parse(t.last_run_at) : 0;
        const gapSec = Math.max(120, Number(t.interval_seconds || 30) * 6);
        if (now - lastMs > gapSec * 1000) {
          runGlobalTaskPoll(db, t.id, null);
        }
      }
    } catch {
      // background loop resilient
    }
  }, 60000);
  if (typeof bgTimer.unref === 'function') bgTimer.unref();
}

export function stopBackgroundMonitorLoop() {
  if (bgTimer) {
    clearInterval(bgTimer);
    bgTimer = null;
  }
}
