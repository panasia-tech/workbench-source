/**
 * 全链路业务防呆与合规校验引擎（400 / 403 / 409 / 422 单点权威实现）
 */

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const INTERNAL_SECRET_WORDS = [
  '底价',
  '参考价',
  '成本价',
  '毛利',
  '二次议价',
  '刀手',
  '首刀',
  '极限底线',
  '公司给到',
  '利润空间',
  '提成',
];

const TRAFFIC_DIVERSION_WORDS = [
  '微信号',
  '加我微',
  '加vx',
  '加v',
  'vx:',
  'wx:',
  'v我',
  '私下转账',
  '支付宝直接转',
  '退差价到微信',
];

const ANTI_BICKERING_WORDS = [
  '申请小二介入',
  '点小二介入',
  '小二介入',
  '闲鱼小法庭',
  '小法庭见',
  '法庭见',
  '投诉你到底',
  '跟你死磕',
  '差评伺候',
  '举报封号',
];

/**
 * 1) 422 话术与消息三合一违禁扫描（内部泄密词 / 封号引流词 / 扯皮小二介入词）
 */
export function assertCleanCommunicationText(text, fieldLabel = '内容') {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  for (const w of ANTI_BICKERING_WORDS) {
    if (low.includes(w.toLowerCase())) {
      throw new HttpError(
        422,
        'ANTI_BICKERING_BLOCKED',
        `【5%防红标反扯皮硬锁】${fieldLabel}包含「${w}」！公司严禁与卖家在闲鱼斗嘴或擅点小二介入，请走零退款率直补或和平退回。`,
        { matched_word: w, category: 'anti_bickering' }
      );
    }
  }
  for (const w of INTERNAL_SECRET_WORDS) {
    if (low.includes(w.toLowerCase())) {
      throw new HttpError(
        422,
        'INTERNAL_WORD_BLOCKED',
        `【422 防泄密拦截】${fieldLabel}包含公司内部敏感词「${w}」，已阻断发送与保存，请用白话对齐。`,
        { matched_word: w, category: 'internal_secret' }
      );
    }
  }
  for (const w of TRAFFIC_DIVERSION_WORDS) {
    if (low.includes(w.toLowerCase())) {
      throw new HttpError(
        422,
        'TRAFFIC_DIVERSION_BLOCKED',
        `【422 防封号引流拦截】${fieldLabel}包含站外引流风险词「${w}」，闲鱼聊天禁止直接发微信/转账诱导词！`,
        { matched_word: w, category: 'traffic_diversion' }
      );
    }
  }
}

/**
 * 2) 403 新员工 3 关防踩坑保护门禁（未通关前，采购员禁止任何真实写操作）
 */
export function assertPracticeUnlocked(staff) {
  if (!staff) throw new HttpError(401, 'UNAUTHORIZED', '请先登录真实员工账号');
  if (staff.role === 'PURCHASER' && !staff.practice_unlocked) {
    throw new HttpError(
      403,
      'PRACTICE_GATE_LOCKED',
      `【新员工保护中】${staff.name} 目前仅完成 ${staff.practice_passed_gates.length}/3 关防踩坑练习，请先到「视频教程与防踩坑闯关」通过 3 道实操题再操作真实业务！`,
      { passed: staff.practice_passed_gates.length, required: 3 }
    );
  }
}

/**
 * 3) 403 岗位角色强制边界（严禁采购员代会计核销、代仓管验机入库、越权改行情发布版）
 */
export function assertRoleIn(staff, allowedRoles, message) {
  if (!staff) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  if (!allowedRoles.includes(staff.role)) {
    throw new HttpError(403, 'ROLE_FORBIDDEN', message || `当前岗位（${staff.role_label}）无权执行该操作`);
  }
}

/**
 * 4) 400 禁止填 0 或占位符校验
 */
export function assertNoZeroPlaceholder(fieldsMap) {
  for (const [label, val] of Object.entries(fieldsMap)) {
    const s = String(val ?? '').trim();
    if (!s || s === '0' || s === '0000' || s === 'none' || s === 'null' || s === '暂无' || s === 'test') {
      throw new HttpError(
        400,
        'PLACEHOLDER_FORBIDDEN',
        `【防敷衍校验】「${label}」不可留空或填写 "${s || '空'}" 占位，请录入真实凭证/信息！`,
        { field: label }
      );
    }
  }
}

/**
 * 5) 监控任务 ↔ 行情参考表上限强校验（403 MONITOR_PRICE_EXCEEDS_CEILING）
 */
export function assertMonitorWithinPricebookCeiling(db, staff, pricebookSku, priceMaxYuan, miaopaiMaxYuan) {
  if (!pricebookSku) return null;
  const pb = db
    .prepare(
      `SELECT * FROM pricebook_items
       WHERE sku_code = ? AND status = 'published'
       ORDER BY version_no DESC LIMIT 1`
    )
    .get(String(pricebookSku));
  if (!pb) {
    throw new HttpError(400, 'PRICEBOOK_SKU_NOT_FOUND', `未找到已发布的参考机型 ${pricebookSku}`);
  }
  const ceilingYuan = Number(pb.ceiling_cents) / 100;
  const max1 = priceMaxYuan != null && priceMaxYuan !== '' ? Number(priceMaxYuan) : null;
  const max2 = miaopaiMaxYuan != null && miaopaiMaxYuan !== '' ? Number(miaopaiMaxYuan) : null;
  if (staff.role !== 'ADMIN') {
    if (max1 != null && Number.isFinite(max1) && max1 > ceilingYuan) {
      throw new HttpError(
        403,
        'MONITOR_PRICE_EXCEEDS_CEILING',
        `【行情防买贵拦截】监听最高价 ¥${max1} 超过《${pb.model_name}》最高上限 ¥${ceilingYuan}（参考价 M=¥${pb.ref_cents / 100}）！请降回 ¥${ceilingYuan} 以内或请王主管特批。`,
        { ceiling_yuan: ceilingYuan, requested: max1, sku_code: pricebookSku }
      );
    }
    if (max2 != null && Number.isFinite(max2) && max2 > ceilingYuan) {
      throw new HttpError(
        403,
        'MONITOR_MIAOPAI_EXCEEDS_CEILING',
        `【秒拍防买贵拦截】自动秒拍最高价 ¥${max2} 超过《${pb.model_name}》最高上限 ¥${ceilingYuan}，已拒绝保存！`,
        { ceiling_yuan: ceilingYuan, requested: max2, sku_code: pricebookSku }
      );
    }
  }
  return pb;
}

/**
 * 6) 闲鱼账号 5% 退款/纠纷防红标校算与安全号核验
 */
export function computeAccountRisk(acct) {
  const ords = Math.max(1, Number(acct.rolling_30d_orders || 1));
  const refs = Number(acct.rolling_30d_refunds || 0);
  const disps = Number(acct.rolling_30d_disputes || 0);
  const redline = Number(acct.redline_pct || 5.0);
  const warnline = Number(acct.warn_pct || 3.8);

  const refundRate = Math.round((refs * 10000) / ords) / 100;
  const disputeRate = Math.round((disps * 10000) / ords) / 100;
  const nextRefundRate = Math.round(((refs + 1) * 10000) / ords) / 100;
  const nextDisputeRate = Math.round(((disps + 1) * 10000) / ords) / 100;
  const maxSafeRefs = Math.floor(ords * (redline / 100));
  const remRefs = Math.max(0, maxSafeRefs - refs);

  let riskLevel = 'grn';
  let badge = `安全（距5%红标余 ${remRefs} 单）`;
  if (refundRate > redline || disputeRate > redline) {
    riskLevel = 'red';
    badge = '已破 5% 红标熔断线';
  } else if (refundRate >= warnline || disputeRate >= 3.0 || nextRefundRate > redline) {
    riskLevel = 'amb';
    badge = `预警（当前 ${refundRate}%，再退1单升至 ${nextRefundRate}%）`;
  }

  return {
    ...acct,
    refund_rate_pct: refundRate,
    dispute_rate_pct: disputeRate,
    next_refund_rate_pct: nextRefundRate,
    next_dispute_rate_pct: nextDisputeRate,
    remaining_refund_quota: remRefs,
    will_breach_on_next_refund: nextRefundRate > redline,
    will_breach_on_next_dispute: nextDisputeRate > redline,
    risk_level: riskLevel,
    status_badge: badge,
  };
}

export function assertSafeMonitorAccount(db, accountId, isHighRisk = true) {
  if (!accountId) return null;
  const row = db.prepare(`SELECT * FROM xianyu_accounts WHERE id = ? OR account_name = ?`).get(String(accountId), String(accountId));
  if (!row) throw new HttpError(400, 'ACCOUNT_NOT_FOUND', `未找到闲鱼账号 ${accountId}`);
  const computed = computeAccountRisk(row);
  if (isHighRisk && (computed.risk_level === 'red' || computed.will_breach_on_next_refund)) {
    const safest = db
      .prepare(`SELECT * FROM xianyu_accounts`)
      .all()
      .map(computeAccountRisk)
      .sort((a, b) => a.refund_rate_pct - b.refund_rate_pct)[0];
    throw new HttpError(
      409,
      'ACCOUNT_NEAR_5PCT_REDLINE',
      `【5%防红标号池拦截】「${computed.account_name}」近30天退款率已达 ${computed.refund_rate_pct}%（再退1单即破 ${computed.next_refund_rate_pct}% 弹红标），禁止承接高风险秒拍/质疑单！建议一键改选「${safest?.account_name || '闲鱼3号'}」（${safest?.refund_rate_pct ?? 1.67}%）。`,
      { blocked_account: computed, recommended_account: safest }
    );
  }
  return computed;
}

/**
 * 7) 409 钉钉机器人加签连通性校验
 */
export function assertDingtalkRobotsReady(db, robotIds) {
  if (!Array.isArray(robotIds) || !robotIds.length) return;
  for (const rid of robotIds) {
    const bot = db.prepare(`SELECT * FROM dingtalk_robots WHERE id = ?`).get(String(rid));
    if (!bot) throw new HttpError(400, 'DINGTALK_NOT_FOUND', `未找到钉钉机器人 ${rid}`);
    if (!String(bot.webhook || '').trim() || !String(bot.secret || '').trim()) {
      throw new HttpError(409, 'DINGTALK_CONFIG_INCOMPLETE', `机器人「${bot.name}」未填齐 Webhook 与 SEC 加签密钥，禁止绑定任务`);
    }
    if (Number(bot.last_test_ok) !== 1) {
      throw new HttpError(
        409,
        'DINGTALK_UNTESTED',
        `【监控防呆拦截】机器人「${bot.name}」尚未通过连接测试！请先在「基础配置 → 钉钉设置」点『发送测试消息』确认收得到消息后再绑定任务。`
      );
    }
  }
}

/**
 * 8) 409 商家黑名单互斥拦截
 */
export function assertSellerNotBlacklisted(db, sellerUserId) {
  if (!sellerUserId) return;
  const hit = db
    .prepare(`SELECT * FROM seller_blacklist WHERE user_id = ? OR plain_user_id = ?`)
    .get(String(sellerUserId), String(sellerUserId));
  if (hit) {
    throw new HttpError(
      409,
      'SELLER_BLACKLISTED',
      `【黑名单拦截】卖家「${hit.nick || sellerUserId}」已在商家黑名单内（原因：${hit.reason || '二道贩子/高纠纷'}），禁止创建店铺监听或秒拍！`
    );
  }
}

/**
 * 9) 监控轮询参数与防风控区间校验 (400)
 */
export function validateTaskRangesAndInterval(db, payload) {
  const minP = payload.price_from !== '' && payload.price_from != null ? Number(payload.price_from) : null;
  const maxP = payload.price_to !== '' && payload.price_to != null ? Number(payload.price_to) : null;
  if (minP != null && maxP != null && minP > maxP) {
    throw new HttpError(400, 'INVALID_PRICE_RANGE', `最低价 ¥${minP} 不能高于最高价 ¥${maxP}`);
  }
  const mpMin = payload.miaopai_price_from !== '' && payload.miaopai_price_from != null ? Number(payload.miaopai_price_from) : null;
  const mpMax = payload.miaopai_price_to !== '' && payload.miaopai_price_to != null ? Number(payload.miaopai_price_to) : null;
  if (mpMin != null && mpMax != null && mpMin > mpMax) {
    throw new HttpError(400, 'INVALID_MIAOPAI_RANGE', `秒拍最低价 ¥${mpMin} 不能高于最高价 ¥${mpMax}`);
  }
  const sec = Number(payload.interval_seconds || 30);
  if (!Number.isFinite(sec) || sec < 1 || sec > 86400) {
    throw new HttpError(400, 'INVALID_POLL_INTERVAL', '轮询间隔必须在 1–86400 秒之间');
  }
  const acctCount = Math.max(1, Array.isArray(payload.listen_account_ids) ? payload.listen_account_ids.length : 1);
  // Prevent reckless 1-second hammering on a single account without explicit override
  if (acctCount === 1 && sec < 3 && payload.allow_aggressive_poll !== true) {
    throw new HttpError(
      400,
      'POLL_INTERVAL_TOO_FAST',
      `【防风控拦截】仅选 1 个监听账号时轮询间隔 ${sec} 秒过短极易触发闲鱼滑块风控，请调至 ≥ 3 秒（建议 15–30 秒）或多配监听号！`
    );
  }
}

/**
 * 10) 商品「疑似几乎全新/99新」买前不追问防呆扫描器
 */
export function scanListingConditionRisk(title, desc = '') {
  const txt = `${title || ''} ${desc || ''}`;
  const looksLikeAlmostNew = /几乎全新|99新|98新|充新|准新|全新仅拆|仅拆封/.test(txt);
  const vaguePhotoOrDefect = /图糊|无磕碰|完美屏|自用|备用|箱说全|没怎么用|原盒/.test(txt);
  if (looksLikeAlmostNew) {
    return {
      suspect_quality_flag: true,
      prebuy_warning: '🎯 卖家标『几乎全新/99新』：买前严禁多嘴追问划痕防卖家补充免责！直接锁快照打『质疑成色标』交仓管 10m 深检。',
    };
  }
  if (vaguePhotoOrDefect) {
    return {
      suspect_quality_flag: true,
      prebuy_warning: '🔎 卖家描述笼统：建议锁清多图快照后再谈价，到货交仓管按质疑标核检。',
    };
  }
  return {
    suspect_quality_flag: false,
    prebuy_warning: '',
  };
}
