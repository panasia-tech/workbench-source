/**
 * 泛亚采购全流程核心业务服务（买前 6 步 + 到货双轨 9 步 + T+1 对账单自动同步/补抓签收 + 两段各 10% 零重算提成）
 */
import crypto from 'node:crypto';
import { withTx } from '../db/database.js';
import {
  HttpError,
  assertCleanCommunicationText,
  assertNoZeroPlaceholder,
  assertPracticeUnlocked,
  assertRoleIn,
  assertSafeMonitorAccount,
  assertSellerNotBlacklisted,
  computeAccountRisk,
} from './guards.js';
import { broadcastSse, saveShopMonitorTask, writeAudit } from './monitor-engine.js';

function safeJson(str, fb) {
  try {
    return JSON.parse(str);
  } catch {
    return fb;
  }
}

export function listDashboardSummary(db, staff) {
  const countsRows = db
    .prepare(`SELECT order_bucket, COUNT(*) AS cnt FROM procurement_cases GROUP BY order_bucket`)
    .all();
  const counts = { today: 0, issue: 0, done: 0 };
  for (const r of countsRows) counts[r.order_bucket] = Number(r.cnt || 0);

  const pool = db.prepare(`SELECT * FROM quota_pools LIMIT 1`).get();
  const accounts = db.prepare(`SELECT * FROM xianyu_accounts ORDER BY id ASC`).all().map(computeAccountRisk);
  const jobs = db.prepare(`SELECT * FROM executor_jobs ORDER BY job_id ASC`).all();

  const batch = db.prepare(`SELECT * FROM statement_batches ORDER BY created_at DESC LIMIT 1`).get();
  const stmtItems = batch
    ? db.prepare(`SELECT * FROM statement_items WHERE batch_id = ?`).all(batch.batch_id)
    : [];
  const unresolvedCount = stmtItems.filter((i) => i.resolution_state === 'pending').length;

  const commRows = db.prepare(`SELECT * FROM commissions`).all();
  const commTotals = {
    pre_confirmed_cents: 0,
    post_confirmed_cents: 0,
    post_estimated_cents: 0,
    paid_cents: 0,
  };
  for (const c of commRows) {
    if (c.policy_mode === 'pre_buy_10_pct') commTotals.pre_confirmed_cents += Number(c.confirmed_cents || 0);
    if (c.policy_mode === 'post_arrival_10_pct') {
      commTotals.post_confirmed_cents += Number(c.confirmed_cents || 0);
      if (c.status === 'estimated') commTotals.post_estimated_cents += Number(c.estimated_cents || 0);
    }
    commTotals.paid_cents += Number(c.paid_cents || 0);
  }

  const hitsCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM monitor_hits`).get()?.c || 0);
  const activeTasksCount = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM monitor_listen_tasks WHERE enabled = 1`).get()?.c || 0
  );
  const pendingFinanceCount = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM corp_alipay_registrations WHERE status = 'pending_finance'`).get()?.c || 0
  );

  const urgentCases = db
    .prepare(
      `SELECT * FROM procurement_cases WHERE order_bucket != 'done' ORDER BY CASE lvl WHEN 'red' THEN 1 WHEN 'amb' THEN 2 ELSE 3 END, updated_at DESC LIMIT 6`
    )
    .all();

  return {
    staff,
    counts,
    pool,
    accounts,
    executor_jobs: jobs,
    reconcile_summary: {
      batch,
      total_items: stmtItems.length,
      unresolved_count: unresolvedCount,
      missing_count: stmtItems.filter((i) => i.diff_type === 'missing_order' && i.resolution_state === 'pending').length,
      diff_count: stmtItems.filter((i) => i.diff_type === 'amount_diff' && i.resolution_state === 'pending').length,
    },
    commission_summary: commTotals,
    monitor_stats: { hits_count: hitsCount, active_tasks_count: activeTasksCount },
    pending_finance_count: pendingFinanceCount,
    urgent_cases: urgentCases,
  };
}

export function listCases(db, bucket = 'all') {
  const sql =
    bucket && bucket !== 'all'
      ? `SELECT c.*, t.ticket_id, t.current_step AS aftersales_step, t.arrival_track, t.sf_95338_status, t.settle_mode, t.agreed_reduction_cents
         FROM procurement_cases c
         LEFT JOIN aftersales_tickets t ON t.case_id = c.case_id
         WHERE c.order_bucket = ?
         ORDER BY CASE c.lvl WHEN 'red' THEN 1 WHEN 'amb' THEN 2 ELSE 3 END, c.updated_at DESC`
      : `SELECT c.*, t.ticket_id, t.current_step AS aftersales_step, t.arrival_track, t.sf_95338_status, t.settle_mode, t.agreed_reduction_cents
         FROM procurement_cases c
         LEFT JOIN aftersales_tickets t ON t.case_id = c.case_id
         ORDER BY CASE c.order_bucket WHEN 'issue' THEN 1 WHEN 'today' THEN 2 ELSE 3 END, c.updated_at DESC`;

  const rows = bucket && bucket !== 'all' ? db.prepare(sql).all(bucket) : db.prepare(sql).all();
  return rows.map((r) => ({
    ...r,
    warehouse_defect_photos: safeJson(r.warehouse_defect_photos, []),
    suspect_quality_flag: Number(r.suspect_quality_flag) === 1,
    seller_modified_price: Number(r.seller_modified_price) === 1,
  }));
}

export function getCaseDetail(db, caseId) {
  const c = db.prepare(`SELECT * FROM procurement_cases WHERE case_id = ?`).get(String(caseId));
  if (!c) throw new HttpError(404, 'CASE_NOT_FOUND', `未找到采购订单 ${caseId}`);

  const account = db.prepare(`SELECT * FROM xianyu_accounts WHERE id = ?`).get(c.account_id);
  const snapshot = c.snapshot_id
    ? db.prepare(`SELECT * FROM item_snapshots WHERE snapshot_id = ?`).get(c.snapshot_id)
    : db.prepare(`SELECT * FROM item_snapshots WHERE product_id = ? ORDER BY version_no DESC LIMIT 1`).get(c.case_id);
  const conv = c.conv_id ? db.prepare(`SELECT * FROM conversations WHERE conv_id = ?`).get(c.conv_id) : null;
  const messages = conv
    ? db.prepare(`SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at ASC`).all(conv.conv_id)
    : [];
  const ticket = db.prepare(`SELECT * FROM aftersales_tickets WHERE case_id = ?`).get(c.case_id);
  const bargainLogs = ticket
    ? db.prepare(`SELECT * FROM aftersales_bargain_logs WHERE ticket_id = ? ORDER BY round_no ASC, created_at ASC`).all(ticket.ticket_id)
    : [];
  const alipayRegs = db
    .prepare(`SELECT * FROM corp_alipay_registrations WHERE case_id = ? ORDER BY created_at DESC`)
    .all(c.case_id);
  const ledger = db.prepare(`SELECT * FROM finance_ledger WHERE case_id = ? ORDER BY created_at DESC`).all(c.case_id);
  const commissions = db.prepare(`SELECT * FROM commissions WHERE case_id = ? ORDER BY policy_mode ASC`).all(c.case_id);
  const helpRequests = db.prepare(`SELECT * FROM help_requests WHERE case_id = ? ORDER BY created_at DESC`).all(c.case_id);
  const pricebook = db
    .prepare(`SELECT * FROM pricebook_items WHERE sku_code = ? AND status = 'published' ORDER BY version_no DESC LIMIT 1`)
    .get(c.sku_code);

  return {
    case: {
      ...c,
      warehouse_defect_photos: safeJson(c.warehouse_defect_photos, []),
      suspect_quality_flag: Number(c.suspect_quality_flag) === 1,
      seller_modified_price: Number(c.seller_modified_price) === 1,
    },
    account: account ? computeAccountRisk(account) : null,
    snapshot: snapshot ? { ...snapshot, images: safeJson(snapshot.images_json, []) } : null,
    conversation: conv,
    messages,
    ticket: ticket
      ? {
          ...ticket,
          tactics_used: safeJson(ticket.tactics_used_json, []),
          is_salvage_profitable: Number(ticket.is_salvage_profitable) === 1,
          waybill_refuse_verified: Number(ticket.waybill_refuse_verified) === 1,
          seller_wx_added: Number(ticket.seller_wx_added) === 1,
          platform_return_locked: Number(ticket.platform_return_locked) === 1,
          finance_settled: Number(ticket.finance_settled) === 1,
          warehouse_confirmed: Number(ticket.warehouse_confirmed) === 1,
        }
      : null,
    bargain_logs: bargainLogs,
    corp_alipay_regs: alipayRegs,
    ledger,
    commissions,
    help_requests: helpRequests,
    pricebook,
  };
}

/**
 * 买前第 2 步：锁死卖家多图描述快照 & 切安全账号
 */
export function lockPrebuySnapshot(db, caseId, payload, staff) {
  assertPracticeUnlocked(staff);
  const c = db.prepare(`SELECT * FROM procurement_cases WHERE case_id = ?`).get(String(caseId));
  if (!c) throw new HttpError(404, 'CASE_NOT_FOUND', `未找到采购订单 ${caseId}`);

  const nextAccountId = String(payload.account_id || c.account_id);
  const markSuspect = payload.suspect_quality_flag ? 1 : 0;
  // 若改选号或打质疑标，禁止绑接近 5% 红标账号
  assertSafeMonitorAccount(db, nextAccountId, markSuspect === 1 || nextAccountId !== c.account_id);

  const now = new Date().toISOString();
  const prevMax = Number(
    db.prepare(`SELECT COALESCE(MAX(version_no),0) AS v FROM item_snapshots WHERE product_id = ?`).get(c.case_id)?.v || 0
  );
  const snapId = `SNAP-${c.case_id}-V${prevMax + 1}`;
  const imgs = Array.isArray(payload.images) && payload.images.length ? payload.images : ['/evidence/item_mbp_m3.jpg', '/evidence/snapshot-description.png'];

  withTx(db, () => {
    db.prepare(
      `INSERT INTO item_snapshots (
         snapshot_id, product_id, version_no, seller_title, seller_declaration,
         pricebook_sku, pricebook_ref_version, images_json, source_type, captured_by, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '买前手动锁10图', ?, ?)`
    ).run(
      snapId,
      c.case_id,
      prevMax + 1,
      payload.seller_title || c.title,
      payload.seller_declaration || c.prebuy_note || '成色栏与描述详情完整冻结保存',
      c.sku_code,
      c.pricebook_ref_version,
      JSON.stringify(imgs),
      staff.id,
      now
    );

    db.prepare(
      `UPDATE procurement_cases
       SET account_id = ?, snapshot_id = ?, suspect_quality_flag = ?, prebuy_step = MAX(prebuy_step, 3),
           prebuy_note = ?, updated_at = ?
       WHERE case_id = ?`
    ).run(
      nextAccountId,
      snapId,
      markSuspect,
      payload.note || c.prebuy_note,
      now,
      c.case_id
    );

    writeAudit(db, staff, 'prebuy_snapshot_locked', 'procurement_case', c.case_id, { snapId, nextAccountId, markSuspect });
  });

  return getCaseDetail(db, c.case_id);
}

/**
 * 买前 6 步推进引擎（谈妥改价 → 核改价付款 & 冻结买前 10% 提成 → 发顺丰 → 派送秒推仓管）
 */
export function advancePrebuyStep(db, caseId, action, payload, staff) {
  assertPracticeUnlocked(staff);
  const c = db.prepare(`SELECT * FROM procurement_cases WHERE case_id = ?`).get(String(caseId));
  if (!c) throw new HttpError(404, 'CASE_NOT_FOUND', `未找到采购订单 ${caseId}`);
  const now = new Date().toISOString();

  if (action === 'switch_account') {
    const newAcct = String(payload.account_id || '');
    const checked = assertSafeMonitorAccount(db, newAcct, true);
    withTx(db, () => {
      db.prepare(`UPDATE procurement_cases SET account_id = ?, updated_at = ? WHERE case_id = ?`).run(
        checked.id,
        now,
        c.case_id
      );
      if (c.conv_id) {
        db.prepare(`UPDATE conversations SET account_id = ?, updated_at = ? WHERE conv_id = ?`).run(checked.id, now, c.conv_id);
      }
      writeAudit(db, staff, 'account_switched_safe', 'procurement_case', c.case_id, { from: c.account_id, to: checked.id });
    });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'lock_agreed_price') {
    const agreedCents = Math.round(Number(payload.agreed_yuan || 0) * 100);
    if (!agreedCents || agreedCents <= 0) {
      throw new HttpError(400, 'INVALID_AGREED_PRICE', '谈妥金额必须大于 0');
    }
    if (agreedCents > Number(c.ceiling_cents) && staff.role !== 'ADMIN') {
      throw new HttpError(
        403,
        'PRICE_EXCEEDS_CEILING',
        `【行情上限硬拦截】谈妥价 ¥${agreedCents / 100} 超过行情参考表上限 ¥${c.ceiling_cents / 100}（参考价 M=¥${c.ref_cents / 100}），采购员严禁超价锁定！`
      );
    }
    withTx(db, () => {
      db.prepare(`UPDATE procurement_cases SET agreed_cents = ?, prebuy_step = MAX(prebuy_step, 4), updated_at = ? WHERE case_id = ?`).run(
        agreedCents,
        now,
        c.case_id
      );
      const idempKey = `RES-${c.case_id}-${agreedCents}`;
      const existingRes = db.prepare(`SELECT reservation_id FROM quota_reservations WHERE idempotency_key = ?`).get(idempKey);
      if (!existingRes) {
        db.prepare(
          `INSERT INTO quota_reservations (reservation_id, pool_id, case_id, staff_id, amount_cents, status, idempotency_key, note, created_at, updated_at)
           VALUES (?, 'POOL-202611', ?, ?, ?, 'reserved', ?, '买前第3步锁定买货预算额度', ?, ?)`
        ).run(`QRES-${Date.now().toString(36)}`, c.case_id, staff.id, agreedCents, idempKey, now, now);
        db.prepare(`UPDATE quota_pools SET reserved_cents = reserved_cents + ?, updated_at = ? WHERE pool_id = 'POOL-202611'`).run(
          agreedCents,
          now
        );
      }
      writeAudit(db, staff, 'agreed_price_locked', 'procurement_case', c.case_id, { agreedCents });
    });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'confirm_payment') {
    if (!payload.seller_modified_price_verified) {
      throw new HttpError(
        409,
        'NEED_SELLER_PRICE_CHECK',
        '【防冤大头未改价付款拦截】必须先勾选确认「卖家已在闲鱼订单把价格改到协商价」，才允许登记付款！'
      );
    }
    assertNoZeroPlaceholder({
      支付回执单号: payload.payment_receipt_no,
      闲鱼平台订单号: payload.external_order_no,
    });
    const paidCents = payload.paid_yuan
      ? Math.round(Number(payload.paid_yuan) * 100)
      : Number(c.agreed_cents || c.target_cents);
    if (paidCents > Number(c.ceiling_cents) && staff.role !== 'ADMIN') {
      throw new HttpError(
        403,
        'PAYMENT_EXCEEDS_CEILING',
        `实际付款 ¥${paidCents / 100} 高于行情上限 ¥${c.ceiling_cents / 100}，禁止入账！`
      );
    }

    withTx(db, () => {
      db.prepare(
        `UPDATE procurement_cases SET
           seller_modified_price = 1, paid_cents = ?, agreed_cents = COALESCE(agreed_cents, ?),
           payment_receipt_no = ?, external_order_no = ?, prebuy_step = MAX(prebuy_step, 5), updated_at = ?
         WHERE case_id = ?`
      ).run(paidCents, paidCents, payload.payment_receipt_no.trim(), payload.external_order_no.trim(), now, c.case_id);

      db.prepare(
        `INSERT INTO finance_ledger (ledger_id, case_id, entry_type, title, amount_cents, direction, receipt_no, verified_by, status, created_at)
         VALUES (?, ?, 'po_payment', ?, ?, 'outflow', ?, ?, 'verified', ?)`
      ).run(
        `FIN-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
        c.case_id,
        `${c.model_name} 买前实付货款`,
        paidCents,
        payload.payment_receipt_no.trim(),
        staff.name,
        now
      );

      // 第一段买前 10% 提成独立锁定：(M - P) * 10%，绝不随到货 R 重算
      const preSavedCents = Math.max(0, Number(c.ref_cents) - paidCents);
      const preCommCents = Math.round(preSavedCents * 0.1);
      const existingPre = db
        .prepare(`SELECT comm_id FROM commissions WHERE case_id = ? AND policy_mode = 'pre_buy_10_pct'`)
        .get(c.case_id);
      if (!existingPre && preCommCents > 0) {
        db.prepare(
          `INSERT INTO commissions (comm_id, staff_id, case_id, policy_mode, base_saved_cents, estimated_cents, confirmed_cents, paid_cents, status, note, updated_at)
           VALUES (?, ?, ?, 'pre_buy_10_pct', ?, ?, ?, 0, 'confirmed', ?, ?)`
        ).run(
          `COM-${c.case_id}-PRE`,
          c.owner_staff_id || staff.id,
          c.case_id,
          preSavedCents,
          preCommCents,
          preCommCents,
          `买前独立 10% 核算（M ¥${c.ref_cents / 100} - 实付 P ¥${paidCents / 100} = 省 ¥${preSavedCents / 100}，获 ¥${preCommCents / 100}，到货二次议价永不回代重算）`,
          now
        );
      }

      db.prepare(`UPDATE quota_pools SET consumed_cents = consumed_cents + ?, updated_at = ? WHERE pool_id = 'POOL-202611'`).run(
        paidCents,
        now
      );
      writeAudit(db, staff, 'payment_confirmed', 'procurement_case', c.case_id, { paidCents, preCommCents });
    });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'mark_sf_delivering') {
    assertNoZeroPlaceholder({ 顺丰运单号: payload.sf_waybill_no || c.sf_waybill_no });
    const waybill = String(payload.sf_waybill_no || c.sf_waybill_no).trim();
    withTx(db, () => {
      db.prepare(
        `UPDATE procurement_cases
         SET sf_waybill_no = ?, sf_delivery_status = 'delivering', warehouse_check_state = 'delivering_10m_sla',
             prebuy_step = 6, updated_at = ?
         WHERE case_id = ?`
      ).run(waybill, now, c.case_id);

      db.prepare(
        `UPDATE executor_jobs SET status = 'triggered_10m_sla', target_ref = ?, detail = ?, updated_at = ? WHERE job_id = 'JOB-BG-03'`
      ).run(`${c.case_id} / ${waybill}`, `WIN-BG-03 侦测到「${c.model_name}」派送中，已秒推赵仓管 10 分钟重点验机！`, now);

      writeAudit(db, staff, 'sf_delivering_pushed_10m', 'procurement_case', c.case_id, { waybill });
    });
    broadcastSse('warehouse:10m_sla', { case_id: c.case_id, model_name: c.model_name, waybill });
    return getCaseDetail(db, c.case_id);
  }

  throw new HttpError(400, 'UNKNOWN_PREBUY_ACTION', `未知买前推进动作: ${action}`);
}

/**
 * 仓管 10 分钟开箱验机提交（仅 WAREHOUSE / ADMIN 角色可操作）
 */
export function submitWarehouseInspection(db, caseId, payload, staff) {
  assertRoleIn(staff, ['WAREHOUSE', 'ADMIN'], '必须由仓管岗位（如赵仓管）或主管提交开箱验机视频与实物定级！');
  const c = db.prepare(`SELECT * FROM procurement_cases WHERE case_id = ?`).get(String(caseId));
  if (!c) throw new HttpError(404, 'CASE_NOT_FOUND', `未找到采购订单 ${caseId}`);

  const existingTicket = db.prepare(`SELECT * FROM aftersales_tickets WHERE case_id = ?`).get(c.case_id);
  if (existingTicket && existingTicket.sf_95338_status === 'requested') {
    throw new HttpError(
      409,
      'WAREHOUSE_LOCKED_BY_95338',
      '【95338 已打退回防丢锁】卖家已致电 95338 发起退回，快递随时将被顺丰收走！截回单确认前严禁仓管入库处置！'
    );
  }

  const outcome = String(payload.outcome || 'defect_refuse');
  const videoUrl = String(payload.warehouse_video_url || '/evidence/unbox-sample.mp4').trim();
  assertNoZeroPlaceholder({ 一镜到底开箱视频: videoUrl });
  const defectNote = String(payload.warehouse_defect_note || '').trim();
  const photos = Array.isArray(payload.photos) && payload.photos.length ? payload.photos : ['/evidence/snapshot-condition.png'];
  const now = new Date().toISOString();

  withTx(db, () => {
    if (outcome === 'pass_good') {
      db.prepare(
        `UPDATE procurement_cases SET
           order_bucket = 'done', lvl = 'grn', sf_delivery_status = 'delivered_ok',
           warehouse_check_state = 'restocked_good', warehouse_video_url = ?, warehouse_defect_note = ?,
           prebuy_step = 6, updated_at = ?
         WHERE case_id = ?`
      ).run(videoUrl, defectNote || '开箱成色完全吻合，已入良品库', now, c.case_id);

      if (existingTicket) {
        db.prepare(
          `UPDATE aftersales_tickets SET warehouse_confirmed = 1, warehouse_disposal_status = 'restocked_good',
             status = CASE WHEN finance_settled = 1 THEN 'done' ELSE status END, updated_at = ? WHERE ticket_id = ?`
        ).run(now, existingTicket.ticket_id);
      }
      writeAudit(db, staff, 'warehouse_restocked_good', 'procurement_case', c.case_id, { videoUrl });
    } else {
      assertNoZeroPlaceholder({ 实测硬伤缺陷说明: defectNote });
      const track = outcome === 'defect_signed' ? 'signed_platform_return' : 'sf_express_refuse';
      const delivStatus = track === 'signed_platform_return' ? 'signed_defect' : 'refused_at_station';
      db.prepare(
        `UPDATE procurement_cases SET
           order_bucket = 'issue', lvl = 'red', sf_delivery_status = ?,
           warehouse_check_state = 'defect', warehouse_video_url = ?, warehouse_defect_photos = ?,
           warehouse_defect_note = ?, prebuy_step = 6, updated_at = ?
         WHERE case_id = ?`
      ).run(delivStatus, videoUrl, JSON.stringify(photos), defectNote, now, c.case_id);

      if (!existingTicket) {
        const tkId = `TK-${Date.now().toString(36).toUpperCase()}`;
        const paid = Number(c.paid_cents || c.agreed_cents || c.target_cents);
        const anchor = Math.round(paid * 0.45);
        const targetKeep = Math.round(paid * 0.25);
        const bottomKeep = Math.round(paid * 0.14);
        db.prepare(
          `INSERT INTO aftersales_tickets (
             ticket_id, case_id, arrival_track, current_step, opening_anchor_cents, target_keep_cents,
             bottom_line_cents, is_salvage_profitable, warehouse_disposal_status, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'defect_hold', 'open', ?)`
        ).run(tkId, c.case_id, track, track === 'signed_platform_return' ? 4 : 2, anchor, targetKeep, bottomKeep, now);
      } else {
        db.prepare(`UPDATE aftersales_tickets SET arrival_track = ?, updated_at = ? WHERE ticket_id = ?`).run(
          track,
          now,
          existingTicket.ticket_id
        );
      }
      writeAudit(db, staff, 'warehouse_defect_reported', 'procurement_case', c.case_id, { track, defectNote });
    }
  });

  broadcastSse('warehouse:inspected', { case_id: c.case_id, outcome });
  return getCaseDetail(db, c.case_id);
}

/**
 * 到货二次议价 9 步双轨闭环引擎
 */
export function advanceAftersalesTicket(db, ticketId, action, payload, staff) {
  assertPracticeUnlocked(staff);
  const tk = db.prepare(`SELECT * FROM aftersales_tickets WHERE ticket_id = ?`).get(String(ticketId));
  if (!tk) throw new HttpError(404, 'TICKET_NOT_FOUND', `未找到二次议价工单 ${ticketId}`);
  const c = db.prepare(`SELECT * FROM procurement_cases WHERE case_id = ?`).get(tk.case_id);
  const now = new Date().toISOString();

  if (action === 'switch_track') {
    const newTrack = payload.arrival_track === 'signed_platform_return' ? 'signed_platform_return' : 'sf_express_refuse';
    db.prepare(`UPDATE aftersales_tickets SET arrival_track = ?, updated_at = ? WHERE ticket_id = ?`).run(
      newTrack,
      now,
      tk.ticket_id
    );
    writeAudit(db, staff, 'aftersales_track_switched', 'aftersales_ticket', tk.ticket_id, { newTrack });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'verify_refuse_and_wx') {
    assertNoZeroPlaceholder({ 卖家微信号: payload.seller_wx_id });
    withTx(db, () => {
      db.prepare(
        `UPDATE aftersales_tickets SET
           waybill_refuse_verified = 1, seller_wx_added = 1, seller_wx_id = ?,
           current_step = MAX(current_step, 3), updated_at = ?
         WHERE ticket_id = ?`
      ).run(payload.seller_wx_id.trim(), now, tk.ticket_id);
      writeAudit(db, staff, 'aftersales_refuse_wx_verified', 'aftersales_ticket', tk.ticket_id, {
        wx: payload.seller_wx_id,
      });
    });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'classify_signal') {
    const signal = String(payload.seller_signal || 'amber_anxious');
    const salvageProfit = Math.round(Number(payload.salvage_profit_yuan ?? 350) * 100);
    const paidCents = Number(c.paid_cents || c.agreed_cents || c.target_cents);
    const knifeMode = payload.first_knife_mode === 'p3_itemized' ? 'p3_itemized' : 'half_price';
    const openingAnchor =
      payload.opening_anchor_yuan != null && payload.opening_anchor_yuan !== ''
        ? Math.round(Number(payload.opening_anchor_yuan) * 100)
        : knifeMode === 'half_price'
          ? Math.round(paidCents * 0.5)
          : Math.max(20000, Math.round(paidCents * 0.3));

    withTx(db, () => {
      db.prepare(
        `UPDATE aftersales_tickets SET
           seller_signal = ?, seller_signal_note = ?, first_knife_mode = ?,
           opening_anchor_cents = ?, salvage_profit_cents = ?, is_salvage_profitable = ?,
           current_step = MAX(current_step, 4), updated_at = ?
         WHERE ticket_id = ?`
      ).run(
        signal,
        payload.seller_signal_note || '',
        knifeMode,
        openingAnchor,
        salvageProfit,
        salvageProfit >= 10000 ? 1 : 0,
        now,
        tk.ticket_id
      );
      writeAudit(db, staff, 'aftersales_signal_classified', 'aftersales_ticket', tk.ticket_id, {
        signal,
        knifeMode,
        openingAnchor,
      });
    });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'send_bargain_round') {
    assertNoZeroPlaceholder({ 压价沟通内容: payload.content });
    assertCleanCommunicationText(payload.content, '二次议价沟通话术');
    const tacticCode = String(payload.tactic_code || 'P3_ITEMIZED_ANCHOR');
    const offerCents =
      payload.offer_yuan != null && payload.offer_yuan !== '' ? Math.round(Number(payload.offer_yuan) * 100) : null;
    const prevRound = Number(
      db.prepare(`SELECT COALESCE(MAX(round_no),0) AS r FROM aftersales_bargain_logs WHERE ticket_id = ?`).get(tk.ticket_id)?.r || 0
    );
    const used = safeJson(tk.tactics_used_json, []);
    if (tacticCode && !used.includes(tacticCode)) used.push(tacticCode);

    withTx(db, () => {
      db.prepare(
        `INSERT INTO aftersales_bargain_logs (log_id, ticket_id, round_no, speaker, tactic_code, offer_cents, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `BLOG-${Date.now().toString(36)}`,
        tk.ticket_id,
        prevRound + 1,
        `buyer_${staff.id}`,
        tacticCode,
        offerCents,
        payload.content.trim(),
        now
      );
      db.prepare(
        `UPDATE aftersales_tickets SET
           tactics_used_json = ?, current_step = MAX(current_step, 6), updated_at = ?
         WHERE ticket_id = ?`
      ).run(JSON.stringify(used), now, tk.ticket_id);
      writeAudit(db, staff, 'aftersales_bargain_logged', 'aftersales_ticket', tk.ticket_id, { tacticCode, offerCents });
    });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'handle_95338') {
    const status = String(payload.sf_95338_status || 'intercepted');
    if (!['none', 'requested', 'intercepted', 'returned_to_seller'].includes(status)) {
      throw new HttpError(400, 'INVALID_95338_STATUS', '无效 95338 截停状态');
    }
    withTx(db, () => {
      db.prepare(`UPDATE aftersales_tickets SET sf_95338_status = ?, current_step = MAX(current_step, 7), updated_at = ? WHERE ticket_id = ?`).run(
        status,
        now,
        tk.ticket_id
      );
      if (status === 'returned_to_seller') {
        db.prepare(`UPDATE aftersales_tickets SET warehouse_disposal_status = 'returned_to_seller', status = 'done', updated_at = ? WHERE ticket_id = ?`).run(
          now,
          tk.ticket_id
        );
        db.prepare(`UPDATE procurement_cases SET order_bucket = 'done', sf_delivery_status = 'returned_to_seller', updated_at = ? WHERE case_id = ?`).run(
          now,
          c.case_id
        );
      }
      writeAudit(db, staff, 'aftersales_95338_updated', 'aftersales_ticket', tk.ticket_id, { status });
    });
    return getCaseDetail(db, c.case_id);
  }

  if (action === 'record_settlement') {
    const mode = String(payload.settle_mode || 'corp_alipay_close');
    const agreedReductionCents = Math.round(Number(payload.agreed_reduction_yuan || 0) * 100);
    if (!agreedReductionCents || agreedReductionCents <= 0) {
      throw new HttpError(400, 'INVALID_REDUCTION_AMOUNT', '到货议价降价差额 R 必须大于 0');
    }
    const paidCents = Number(c.paid_cents || c.agreed_cents || c.target_cents);
    const finalKeepCents = Math.max(0, paidCents - agreedReductionCents);

    if (mode === 'corp_alipay_close') {
      assertNoZeroPlaceholder({
        对公收款人真实姓名: payload.payee_real_name,
        对公支付宝账号: payload.payee_alipay_account,
      });
    }

    withTx(db, () => {
      db.prepare(
        `UPDATE aftersales_tickets SET
           settle_mode = ?, agreed_reduction_cents = ?, final_keep_cents = ?,
           platform_return_locked = CASE WHEN ? = 'corp_alipay_close' THEN 1 ELSE platform_return_locked END,
           current_step = 9, warehouse_disposal_status = 'waiting_inbound_confirm',
           status = 'waiting_finance', updated_at = ?
         WHERE ticket_id = ?`
      ).run(mode, agreedReductionCents, finalKeepCents, mode, now, tk.ticket_id);

      if (mode === 'corp_alipay_close') {
        const regId = `ALIPAY-REG-${Date.now().toString(36).toUpperCase()}`;
        db.prepare(
          `INSERT INTO corp_alipay_registrations (reg_id, ticket_id, case_id, payee_real_name, payee_alipay_account, amount_cents, wx_contract_confirmed, status, schedule_slot, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'pending_finance', '次日 10:00 (T+1)', ?, ?)`
        ).run(
          regId,
          tk.ticket_id,
          c.case_id,
          payload.payee_real_name.trim(),
          payload.payee_alipay_account.trim(),
          finalKeepCents,
          staff.id,
          now
        );

        db.prepare(
          `INSERT INTO finance_ledger (ledger_id, case_id, ticket_id, entry_type, title, amount_cents, direction, status, created_at)
           VALUES (?, ?, ?, 'corp_alipay_payout', ?, ?, 'outflow', 'pending_finance', ?)`
        ).run(
          `FIN-${Date.now().toString(36)}`,
          c.case_id,
          tk.ticket_id,
          `支付宝对公直转卖家 ${payload.payee_real_name.trim()}（T+1审批）`,
          finalKeepCents,
          now
        );
      }

      // 第二段到货后独立 10% 提成：仅按 R * 10% 生成或更新 post_arrival_10_pct，绝不动 pre_buy_10_pct！
      const postCommCents = Math.round(agreedReductionCents * 0.1);
      const existingPost = db
        .prepare(`SELECT comm_id FROM commissions WHERE case_id = ? AND policy_mode = 'post_arrival_10_pct'`)
        .get(c.case_id);
      const ownerId = c.owner_staff_id || staff.id;
      if (existingPost) {
        db.prepare(
          `UPDATE commissions SET base_saved_cents = ?, estimated_cents = ?, status = 'estimated', note = ?, updated_at = ? WHERE comm_id = ?`
        ).run(
          agreedReductionCents,
          postCommCents,
          `到货谈退降价 R=¥${agreedReductionCents / 100} × 10% = 预计 ¥${postCommCents / 100}（等财务+仓管双清转确认；第一段买前提成绝不重算）`,
          now,
          existingPost.comm_id
        );
      } else {
        db.prepare(
          `INSERT INTO commissions (comm_id, staff_id, case_id, ticket_id, policy_mode, base_saved_cents, estimated_cents, confirmed_cents, paid_cents, status, note, updated_at)
           VALUES (?, ?, ?, ?, 'post_arrival_10_pct', ?, ?, 0, 0, 'estimated', ?, ?)`
        ).run(
          `COM-${c.case_id}-POST`,
          ownerId,
          c.case_id,
          tk.ticket_id,
          agreedReductionCents,
          postCommCents,
          `到货谈退降价 R=¥${agreedReductionCents / 100} × 10% = 预计 ¥${postCommCents / 100}（等财务+仓管双清转确认；第一段买前提成绝不重算）`,
          now
        );
      }

      writeAudit(db, staff, 'aftersales_settlement_recorded', 'aftersales_ticket', tk.ticket_id, {
        mode,
        agreedReductionCents,
        finalKeepCents,
        postCommCents,
      });
    });
    return getCaseDetail(db, c.case_id);
  }

  throw new HttpError(400, 'UNKNOWN_AFTERSALES_ACTION', `未知到货议价动作: ${action}`);
}

/**
 * 第 9 步：会计核销 T+1 支付宝对公付款 / 直转入账（仅 FINANCE / ADMIN）
 */
export function approveCorpAlipayRegistration(db, regId, payload, staff) {
  assertRoleIn(staff, ['FINANCE', 'ADMIN'], '必须由会计（如陈会计）或主管完成 T+1 支付宝对公付款核销！');
  assertNoZeroPlaceholder({ 银行或支付宝流水凭证号: payload.receipt_no });
  const reg = db.prepare(`SELECT * FROM corp_alipay_registrations WHERE reg_id = ?`).get(String(regId));
  if (!reg) throw new HttpError(404, 'REG_NOT_FOUND', `未找到对公支付登记单 ${regId}`);

  const now = new Date().toISOString();
  withTx(db, () => {
    db.prepare(
      `UPDATE corp_alipay_registrations SET status = 'approved_paid', receipt_no = ?, approved_by = ?, approved_at = ? WHERE reg_id = ?`
    ).run(payload.receipt_no.trim(), staff.id, now, reg.reg_id);

    db.prepare(
      `UPDATE finance_ledger SET status = 'verified', receipt_no = ?, verified_by = ?
       WHERE ticket_id = ? AND entry_type = 'corp_alipay_payout'`
    ).run(payload.receipt_no.trim(), staff.name, reg.ticket_id);

    db.prepare(`UPDATE aftersales_tickets SET finance_settled = 1, updated_at = ? WHERE ticket_id = ?`).run(now, reg.ticket_id);

    const tk = db.prepare(`SELECT * FROM aftersales_tickets WHERE ticket_id = ?`).get(reg.ticket_id);
    if (tk && Number(tk.warehouse_confirmed) === 1) {
      db.prepare(`UPDATE aftersales_tickets SET status = 'done', updated_at = ? WHERE ticket_id = ?`).run(now, tk.ticket_id);
      db.prepare(`UPDATE procurement_cases SET order_bucket = 'done', lvl = 'grn', updated_at = ? WHERE case_id = ?`).run(
        now,
        reg.case_id
      );
      db.prepare(
        `UPDATE commissions SET confirmed_cents = estimated_cents, status = 'confirmed', updated_at = ?
         WHERE case_id = ? AND policy_mode = 'post_arrival_10_pct'`
      ).run(now, reg.case_id);
    }

    writeAudit(db, staff, 'corp_alipay_approved', 'corp_alipay_registration', reg.reg_id, {
      receipt_no: payload.receipt_no,
      amount_cents: reg.amount_cents,
    });
  });

  return getCaseDetail(db, reg.case_id);
}

/**
 * 第 9 步：仓管入库双清确认（仅 WAREHOUSE / ADMIN；若 95338 请求中则 409 拦截）
 */
export function confirmWarehouseInboundClose(db, ticketId, payload, staff) {
  assertRoleIn(staff, ['WAREHOUSE', 'ADMIN'], '必须由仓管（如赵仓管）或主管确认实物转入良品库并闭环！');
  const tk = db.prepare(`SELECT * FROM aftersales_tickets WHERE ticket_id = ?`).get(String(ticketId));
  if (!tk) throw new HttpError(404, 'TICKET_NOT_FOUND', `未找到工单 ${ticketId}`);
  if (tk.sf_95338_status === 'requested') {
    throw new HttpError(
      409,
      'WAREHOUSE_LOCKED_BY_95338',
      '【95338 退回拦截锁】卖家已发起顺丰退回请求，截回确认前禁止仓管入库贴标！'
    );
  }
  if (tk.settle_mode === 'corp_alipay_close' && Number(tk.finance_settled) !== 1) {
    throw new HttpError(
      409,
      'FINANCE_T1_NOT_CLEARED',
      '【钱货双清前置校验】该单为支付宝对公留货单，请先由陈会计审批 T+1 对公付款核销后，再完成最终入库完结！'
    );
  }

  const now = new Date().toISOString();
  withTx(db, () => {
    db.prepare(
      `UPDATE aftersales_tickets SET warehouse_confirmed = 1, warehouse_disposal_status = 'restocked_good', status = 'done', updated_at = ? WHERE ticket_id = ?`
    ).run(now, tk.ticket_id);

    db.prepare(
      `UPDATE procurement_cases SET order_bucket = 'done', lvl = 'grn', sf_delivery_status = 'delivered_ok',
         warehouse_check_state = 'restocked_good', warehouse_defect_note = COALESCE(?, warehouse_defect_note), updated_at = ?
       WHERE case_id = ?`
    ).run(payload.bin_location ? `货位 ${payload.bin_location} 良品入库` : null, now, tk.case_id);

    // 钱货双清后转正第二段到货 10% 提成（不动第一段！）
    db.prepare(
      `UPDATE commissions SET confirmed_cents = estimated_cents, status = 'confirmed', updated_at = ?
       WHERE case_id = ? AND policy_mode = 'post_arrival_10_pct'`
    ).run(now, tk.case_id);

    writeAudit(db, staff, 'warehouse_inbound_closed', 'aftersales_ticket', tk.ticket_id, {
      bin: payload.bin_location || 'A-01',
    });
  });

  return getCaseDetail(db, tk.case_id);
}

/**
 * 次日 10:00 前昨日财务对账单自动同步、漏单补抓、差额核对与签收（无人工上传CSV UI）
 */
export function getReconcileBatch(db) {
  const batch = db.prepare(`SELECT * FROM statement_batches ORDER BY created_at DESC LIMIT 1`).get();
  if (!batch) return null;
  const items = db
    .prepare(`SELECT * FROM statement_items WHERE batch_id = ? ORDER BY CASE resolution_state WHEN 'pending' THEN 1 ELSE 2 END, item_id ASC`)
    .all(batch.batch_id);
  const pendingCount = items.filter((i) => i.resolution_state === 'pending').length;
  return { batch, items, pending_count: pendingCount };
}

export function resolveStatementItem(db, itemId, action, staff) {
  assertPracticeUnlocked(staff);
  const st = db.prepare(`SELECT * FROM statement_items WHERE item_id = ?`).get(String(itemId));
  if (!st) throw new HttpError(404, 'STATEMENT_ITEM_NOT_FOUND', `未找到对账单明细 ${itemId}`);
  const now = new Date().toISOString();

  if (action === 'backfill_missing') {
    if (st.resolution_state === 'backfilled' && st.linked_case_id) {
      return getReconcileBatch(db);
    }
    const newCaseId = `CASE-BF-${st.item_id.replace(/[^A-Z0-9]/gi, '')}`;
    const pb =
      db.prepare(`SELECT * FROM pricebook_items WHERE sku_code = ? AND status = 'published' ORDER BY version_no DESC LIMIT 1`).get(st.sku_code) ||
      { ref_cents: st.statement_amount_cents, target_cents: st.statement_amount_cents, ceiling_cents: st.statement_amount_cents, version_no: 1 };
    const acct = db.prepare(`SELECT id FROM xianyu_accounts WHERE account_name = ?`).get(st.account_name) || { id: 'ACC-GF-01' };

    withTx(db, () => {
      db.prepare(
        `INSERT OR IGNORE INTO procurement_cases (
           case_id, order_bucket, lvl, title, sku_code, model_name, account_id, seller_nick,
           pricebook_ref_version, ref_cents, target_cents, ceiling_cents, agreed_cents, paid_cents,
           prebuy_step, suspect_quality_flag, prebuy_note, seller_modified_price, payment_receipt_no,
           external_order_no, sf_delivery_status, warehouse_check_state, owner_staff_id, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        newCaseId,
        'today',
        'red',
        `【对账单补抓】${st.item_title}`,
        st.sku_code,
        st.item_title.slice(0, 32),
        acct.id,
        st.seller_nick,
        pb.version_no || 1,
        pb.ref_cents,
        pb.target_cents,
        pb.ceiling_cents,
        st.statement_amount_cents,
        st.statement_amount_cents,
        5,
        1,
        `由次日 10:00 昨日对账单 ${st.alipay_tx_no} 自动补抓生成采购单，已标红推仓管重点深检`,
        1,
        st.alipay_tx_no,
        st.external_order_no,
        'delivering',
        'delivering_10m_sla',
        staff.id,
        now,
        now
      );

      db.prepare(
        `UPDATE statement_items SET resolution_state = 'backfilled', system_amount_cents = ?, linked_case_id = ?, note = ?, updated_at = ? WHERE item_id = ?`
      ).run(st.statement_amount_cents, newCaseId, `已一键补抓生成采购单 ${newCaseId}`, now, st.item_id);

      writeAudit(db, staff, 'reconcile_backfilled_case', 'statement_item', st.item_id, { newCaseId });
    });
    broadcastSse('reconcile:updated', { item_id: st.item_id, linked_case_id: newCaseId });
    return getReconcileBatch(db);
  }

  if (action === 'confirm_amount_diff') {
    withTx(db, () => {
      db.prepare(
        `UPDATE statement_items SET resolution_state = 'amount_adjusted', note = ?, updated_at = ? WHERE item_id = ?`
      ).run(`${st.note}（已由 ${staff.name} 核对确认差额合规）`, now, st.item_id);
      if (st.linked_case_id) {
        const diffCents = Number(st.statement_amount_cents) - Number(st.system_amount_cents || st.statement_amount_cents);
        if (diffCents !== 0) {
          db.prepare(
            `INSERT INTO finance_ledger (ledger_id, case_id, entry_type, title, amount_cents, direction, receipt_no, verified_by, status, created_at)
             VALUES (?, ?, 'sf_insure_diff', '顺丰保价/运费对账差额调平', ?, 'outflow', ?, ?, 'verified', ?)`
          ).run(`FIN-DIFF-${st.item_id}`, st.linked_case_id, Math.abs(diffCents), st.alipay_tx_no, staff.name, now);
        }
      }
      writeAudit(db, staff, 'reconcile_diff_confirmed', 'statement_item', st.item_id, {});
    });
    return getReconcileBatch(db);
  }

  if (action === 'ignore_non_po') {
    db.prepare(`UPDATE statement_items SET resolution_state = 'ignored_non_po', updated_at = ? WHERE item_id = ?`).run(
      now,
      st.item_id
    );
    writeAudit(db, staff, 'reconcile_ignored_non_po', 'statement_item', st.item_id, {});
    return getReconcileBatch(db);
  }

  throw new HttpError(400, 'UNKNOWN_RECONCILE_ACTION', `未知对账操作: ${action}`);
}

export function signoffReconcileBatch(db, batchId, staff) {
  assertRoleIn(staff, ['FINANCE', 'ADMIN'], '必须由会计（陈会计）或主管（王主管）签收昨日对账单！');
  const items = db.prepare(`SELECT * FROM statement_items WHERE batch_id = ?`).all(String(batchId));
  const pending = items.filter((i) => i.resolution_state === 'pending');
  if (pending.length > 0) {
    throw new HttpError(
      409,
      'RECONCILE_HAS_UNRESOLVED_ITEMS',
      `【漏单与差额未消防签收锁】还有 ${pending.length} 条对账异常（如 ${pending.map((p) => p.item_id).join('、')}）未补抓或核平，禁止签收完结！`,
      { pending_items: pending.map((p) => p.item_id) }
    );
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE statement_batches SET status = 'signed_off', signed_off_by = ?, signed_off_at = ? WHERE batch_id = ?`).run(
    staff.id,
    now,
    String(batchId)
  );
  writeAudit(db, staff, 'reconcile_batch_signed_off', 'statement_batch', batchId, {});
  return getReconcileBatch(db);
}

/**
 * IM 实时议价会话 + 422 违禁扫描 + 单人独占暂停接管
 */
export function listConversations(db) {
  const rows = db.prepare(`SELECT * FROM conversations ORDER BY updated_at DESC`).all();
  return rows.map((r) => {
    const msgs = db.prepare(`SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at ASC`).all(r.conv_id);
    const snap = r.snapshot_id ? db.prepare(`SELECT * FROM item_snapshots WHERE snapshot_id = ?`).get(r.snapshot_id) : null;
    const acct = db.prepare(`SELECT * FROM xianyu_accounts WHERE id = ?`).get(r.account_id);
    return {
      ...r,
      messages: msgs,
      snapshot: snap ? { ...snap, images: safeJson(snap.images_json, []) } : null,
      account: acct ? computeAccountRisk(acct) : null,
    };
  });
}

export function sendImMessage(db, convId, body, opts, staff) {
  assertPracticeUnlocked(staff);
  assertNoZeroPlaceholder({ 发送消息: body });
  assertCleanCommunicationText(body, 'IM 对话消息');

  const conv = db.prepare(`SELECT * FROM conversations WHERE conv_id = ?`).get(String(convId));
  if (!conv) throw new HttpError(404, 'CONV_NOT_FOUND', `未找到会话 ${convId}`);
  const now = new Date().toISOString();
  const offerCents = opts.offer_yuan != null && opts.offer_yuan !== '' ? Math.round(Number(opts.offer_yuan) * 100) : null;

  if (offerCents != null && offerCents > Number(conv.ceiling_cents) && staff.role !== 'ADMIN') {
    throw new HttpError(
      403,
      'OFFER_EXCEEDS_CEILING',
      `报价 ¥${offerCents / 100} 高于行情上限 ¥${conv.ceiling_cents / 100}，已自动拦截发送！`
    );
  }

  const prevMax = Number(
    db.prepare(`SELECT COALESCE(MAX(round_no),0) AS r FROM messages WHERE conv_id = ?`).get(conv.conv_id)?.r || 0
  );
  withTx(db, () => {
    db.prepare(
      `INSERT INTO messages (msg_id, conv_id, sender_type, sender_name, body, offer_cents, round_no, idempotency_key, created_at)
       VALUES (?, ?, 'buyer_human', ?, ?, ?, ?, ?, ?)`
    ).run(
      `MSG-${Date.now().toString(36)}`,
      conv.conv_id,
      staff.name,
      body.trim(),
      offerCents,
      prevMax + 1,
      `im-${conv.conv_id}-${Date.now()}`,
      now
    );
    db.prepare(`UPDATE conversations SET unread_count = 0, updated_at = ? WHERE conv_id = ?`).run(now, conv.conv_id);
    writeAudit(db, staff, 'im_message_sent', 'conversation', conv.conv_id, { body: body.slice(0, 50), offerCents });
  });
  return listConversations(db).find((x) => x.conv_id === conv.conv_id);
}

/**
 * 新员工 3 关防踩坑通关检验
 */
const PRACTICE_ANSWERS = {
  gate1: 'B', // 买前不追问『几乎全新』划痕，锁 10 图快照直接打质疑标拍下交仓管深检
  gate2: 'B', // 切 1.67% 的闲鱼3号接单，严禁点小二介入扯皮破坏 5% 红标
  gate3: 'B', // 选 B-01 整单全退关单 + 支付宝对公直转；两段各 10% 绝不回代买前重算
};

export function submitPracticeGate(db, staff, gateId, answer) {
  if (!PRACTICE_ANSWERS[gateId]) {
    throw new HttpError(400, 'INVALID_GATE', `未知关卡 ${gateId}`);
  }
  const ans = String(answer || '').trim().toUpperCase();
  if (ans !== PRACTICE_ANSWERS[gateId]) {
    throw new HttpError(
      400,
      'WRONG_PRACTICE_ANSWER',
      `这题选错啦！再看一眼红线提示：${
        gateId === 'gate1'
          ? '买前多嘴问划痕会让卖家补充免责！应直接锁快照打质疑标。'
          : gateId === 'gate2'
            ? '退款/纠纷红线是 ≤5%，必须切绿灯安全号且禁点小二介入！'
            : '脱离平台风险必须选整单全退关单+对公转，且两段 10% 各自独立永不回代重算！'
      }`
    );
  }
  const cur = Array.isArray(staff.practice_passed_gates) ? [...staff.practice_passed_gates] : [];
  if (!cur.includes(gateId)) cur.push(gateId);
  db.prepare(`UPDATE staff_users SET practice_passed_gates = ? WHERE id = ?`).run(JSON.stringify(cur), staff.id);
  writeAudit(db, staff, 'practice_gate_passed', 'staff_user', staff.id, { gateId, passed: cur });
  return {
    passed_gates: cur,
    practice_unlocked: cur.length >= 3,
  };
}

export function listSellersAndBlacklist(db) {
  const favorites = db
    .prepare(`SELECT * FROM favorite_sellers ORDER BY total_deals DESC, updated_at DESC`)
    .all()
    .map((r) => ({ ...r, tags: safeJson(r.tags_json, []) }));
  const blacklist = db.prepare(`SELECT * FROM seller_blacklist ORDER BY added_at DESC`).all();
  return { favorites, blacklist };
}

export function saveFavoriteSellerAndSyncMonitor(db, payload, staff) {
  assertPracticeUnlocked(staff);
  const sellerId = String(payload.seller_id || `SELLER-${Date.now().toString(36).toUpperCase()}`).trim();
  const nick = String(payload.seller_nick || '').trim();
  if (!nick) throw new HttpError(400, 'INVALID_SELLER_NICK', '卖家昵称不能为空');
  assertSellerNotBlacklisted(db, sellerId);

  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT seller_id FROM favorite_sellers WHERE seller_id = ?`).get(sellerId);
  if (existing) {
    db.prepare(
      `UPDATE favorite_sellers SET seller_nick=?, category_focus=?, visibility_scope=?, tags_json=?, notes=?, updated_at=? WHERE seller_id=?`
    ).run(
      nick,
      payload.category_focus || '',
      payload.visibility_scope === 'team' ? 'team' : 'personal',
      JSON.stringify(Array.isArray(payload.tags) ? payload.tags : ['优质卖家']),
      payload.notes || '',
      now,
      sellerId
    );
  } else {
    db.prepare(
      `INSERT INTO favorite_sellers (seller_id, seller_nick, category_focus, visibility_scope, owner_staff_id, tags_json, notes, total_deals, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      sellerId,
      nick,
      payload.category_focus || '',
      payload.visibility_scope === 'team' ? 'team' : 'personal',
      staff.id,
      JSON.stringify(Array.isArray(payload.tags) ? payload.tags : ['优质卖家']),
      payload.notes || '',
      now
    );
  }
  if (payload.enable_shop_monitor) {
    saveShopMonitorTask(
      db,
      {
        seller_user_id: sellerId,
        seller_nick: nick,
        pricebook_sku: payload.pricebook_sku || '',
        price_to: payload.price_to || '',
        listen_account_ids: ['ACC-GF-03'],
        dingtalk_robot_ids: ['BOT-01'],
        sync_to_favorite: false,
      },
      staff
    );
  }
  return listSellersAndBlacklist(db);
}

export function listFinanceAndCommissions(db) {
  const pendingRegs = db
    .prepare(`SELECT * FROM corp_alipay_registrations ORDER BY CASE status WHEN 'pending_finance' THEN 1 ELSE 2 END, created_at DESC`)
    .all();
  const ledger = db.prepare(`SELECT * FROM finance_ledger ORDER BY created_at DESC LIMIT 80`).all();
  const commissions = db.prepare(`SELECT * FROM commissions ORDER BY updated_at DESC`).all();
  const reconcile = getReconcileBatch(db);
  return { corp_alipay_regs: pendingRegs, ledger, commissions, reconcile };
}

export function publishPricebookItem(db, payload, staff) {
  assertRoleIn(staff, ['ADMIN', 'FINANCE'], '必须由主管或会计审核发布《四维行情参考表》');
  const sku = String(payload.sku_code || '').trim();
  const modelName = String(payload.model_name || '').trim();
  if (!sku || !modelName) throw new HttpError(400, 'INVALID_PRICEBOOK', 'SKU 编码与机型名称不能为空');
  const refCents = Math.round(Number(payload.ref_yuan || 0) * 100);
  const initCents = Math.round(Number(payload.initial_offer_yuan || 0) * 100);
  const targetCents = Math.round(Number(payload.target_yuan || 0) * 100);
  const ceilingCents = Math.round(Number(payload.ceiling_yuan || 0) * 100);
  if (!refCents || ceilingCents > refCents || targetCents > ceilingCents) {
    throw new HttpError(400, 'INVALID_PRICEBOOK_BOUNDS', '行情四维报价必须满足：目标价 <= 上限 <= 行情参考价 M');
  }
  const prevMax = Number(
    db.prepare(`SELECT COALESCE(MAX(version_no),0) AS v FROM pricebook_items WHERE sku_code = ?`).get(sku)?.v || 0
  );
  const id = `PB-${Date.now().toString(36).toUpperCase()}`;
  const now = new Date().toISOString();
  withTx(db, () => {
    if (prevMax > 0) {
      db.prepare(`UPDATE pricebook_items SET status = 'archived' WHERE sku_code = ? AND status = 'published'`).run(sku);
    }
    db.prepare(
      `INSERT INTO pricebook_items (id, sku_code, model_name, category, condition_grade, version_no, ref_cents, initial_offer_cents, target_cents, ceiling_cents, status, created_by, approved_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`
    ).run(
      id,
      sku,
      modelName,
      payload.category || '数码自用',
      payload.condition_grade || '95新以上',
      prevMax + 1,
      refCents,
      initCents || Math.round(targetCents * 0.94),
      targetCents,
      ceilingCents,
      staff.id,
      staff.id,
      now
    );
    writeAudit(db, staff, 'pricebook_published', 'pricebook_item', sku, { version: prevMax + 1, refCents, ceilingCents });
  });
  return db.prepare(`SELECT * FROM pricebook_items WHERE status = 'published' ORDER BY updated_at DESC`).all();
}
