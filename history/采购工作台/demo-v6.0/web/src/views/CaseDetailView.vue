<template>
  <div v-if="d">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;">
      <div>
        <router-link to="/cases" class="btn btn-sm" style="margin-right: 8px;">← 返回订单列表</router-link>
        <strong style="font-size: 17px;">{{ d.case.case_id }} · {{ d.case.model_name }}</strong>
        <span class="tag" :class="d.case.lvl" style="margin-left: 8px;">{{ d.case.order_bucket }}</span>
      </div>
      <div style="display: flex; gap: 8px;">
        <button
          v-if="d.snapshot"
          class="btn btn-sm btn-blue"
          @click="openLightbox(d.case.model_name, d.snapshot.images, `${d.snapshot.snapshot_id} · 不可篡改存证`)"
        >
          📸 查看 10 图锁证快照 ({{ d.snapshot.images.length }})
        </button>
        <button class="btn btn-sm" @click="openVideoTutorial('ch6', 105.29)">▶ 本阶段视频演示</button>
      </div>
    </div>

    <!-- 基本四维金额与账号 5% 雷达条 -->
    <div class="grid grid-4" style="margin-bottom: 14px;">
      <div class="card">
        <div class="muted">行情参考 M / 绝不破上限 C</div>
        <div class="kpi-num num" style="font-size: 19px;">{{ fmtYuan(d.case.ref_cents) }} / {{ fmtYuan(d.case.ceiling_cents) }}</div>
        <div class="muted">SKU: {{ d.case.sku_code }}</div>
      </div>
      <div class="card">
        <div class="muted">当前成交 / 实付货款 P</div>
        <div class="kpi-num num" style="font-size: 19px; color: #1d4ed8;">
          {{ d.case.paid_cents ? fmtYuan(d.case.paid_cents) : (d.case.agreed_cents ? fmtYuan(d.case.agreed_cents) : '尚未锁定') }}
        </div>
        <div class="muted">单号：{{ d.case.external_order_no || '待拍' }}</div>
      </div>
      <div class="card">
        <div class="muted">当前绑定账号 & 5% 红标雷达</div>
        <div style="font-weight: 700; margin-top: 2px;">{{ d.account?.account_name || d.case.account_id }}</div>
        <span v-if="d.account" class="tag" :class="d.account.risk_level" style="margin-top: 4px;">
          退款率 {{ d.account.refund_rate_pct }}% · 纠纷 {{ d.account.dispute_rate_pct }}%
        </span>
      </div>
      <div class="card">
        <div class="muted">两段各 10% 独立提成核算</div>
        <div style="font-size: 12px; margin-top: 4px;" v-if="d.commissions.length">
          <div v-for="cm in d.commissions" :key="cm.comm_id" class="num">
            <strong>{{ cm.policy_mode === 'pre_buy_10_pct' ? '买前10%' : '到货10%' }}：</strong>
            {{ cm.confirmed_cents ? fmtYuan(cm.confirmed_cents) : fmtYuan(cm.estimated_cents) }}
            <span class="tag" :class="cm.status === 'confirmed' || cm.status === 'paid' ? 'grn' : 'amb'">{{ cm.status }}</span>
          </div>
        </div>
        <div v-else class="muted" style="margin-top: 6px;">付款后自动锁定第一段买前 10%</div>
      </div>
    </div>

    <!-- 板块一：买前 6 步硬防呆操作卡 -->
    <div class="card" data-tour="detail-prebuy" style="margin-bottom: 14px;">
      <div class="card-header">
        <h3 class="card-title">📦 阶段一：买前 6 步防呆控制（当前第 {{ d.case.prebuy_step }} / 6 步）</h3>
        <span v-if="d.case.suspect_quality_flag" class="tag red">🎯 已打「质疑成色标」（严禁买前问划痕）</span>
      </div>

      <div class="grid grid-3" style="gap: 12px;">
        <!-- 第2步：切换安全号 & 锁图 -->
        <div style="border: 1px solid var(--border); border-radius: 10px; padding: 11px; background: #f8fafc;">
          <strong style="font-size: 13px;">第 2 步：安全号隔离 & 锁 10 图快照</strong>
          <div class="muted" style="margin: 4px 0 8px;">发现「几乎全新/4.71%副号」时切绿灯闲鱼3号并锁原图。</div>
          <div style="display: flex; gap: 6px; margin-bottom: 6px;">
            <select v-model="preForm.account_id" class="select">
              <option v-for="a in safeAccounts" :key="a.id" :value="a.id">
                {{ a.account_name }} ({{ a.refund_rate_pct }}% {{ a.will_breach_on_next_refund ? '⚠逼近5%' : '✅安全' }})
              </option>
            </select>
            <button class="btn btn-sm" @click="doPrebuy('switch_account', { account_id: preForm.account_id })">切换账号</button>
          </div>
          <label style="display: flex; gap: 6px; font-size: 12px; margin-bottom: 6px;">
            <input type="checkbox" v-model="preForm.suspect_quality_flag" /> 标「质疑成色」（交仓管深检）
          </label>
          <button class="btn btn-sm btn-blue" style="width: 100%;" @click="doLockSnapshot">📸 冻结保存多图快照</button>
        </div>

        <!-- 第3-4步：谈妥价格 + 卖家已改价核对 + 付款凭证 -->
        <div style="border: 1px solid var(--border); border-radius: 10px; padding: 11px; background: #f8fafc;">
          <strong style="font-size: 13px;">第 3–4 步：谈妥核改价 & 登记实付</strong>
          <div style="display: flex; gap: 6px; margin-top: 6px;">
            <input v-model.number="preForm.agreed_yuan" type="number" class="input" placeholder="谈妥价 ¥" />
            <button class="btn btn-sm" @click="doPrebuy('lock_agreed_price', { agreed_yuan: preForm.agreed_yuan })">锁定谈妥价</button>
          </div>
          <label style="display: flex; gap: 6px; font-size: 12px; margin: 8px 0 4px; color: #b45309; font-weight: 600;">
            <input type="checkbox" v-model="preForm.seller_modified_price_verified" /> 确认卖家已在闲鱼后台把订单改成协商价
          </label>
          <input v-model="preForm.payment_receipt_no" class="input" placeholder="支付宝流水号（禁填0）" style="margin-bottom: 5px;" />
          <input v-model="preForm.external_order_no" class="input" placeholder="闲鱼平台订单号（禁填0）" style="margin-bottom: 6px;" />
          <button class="btn btn-sm btn-primary" style="width: 100%;" @click="doConfirmPay">💳 核改价无误并登记付款（锁买前10%）</button>
        </div>

        <!-- 第5步：顺丰运单 & WIN-BG-03 派送秒推 -->
        <div style="border: 1px solid var(--border); border-radius: 10px; padding: 11px; background: #f8fafc;">
          <strong style="font-size: 13px;">第 5–6 步：顺丰派送盯梢秒推仓管 10m</strong>
          <div class="muted" style="margin: 4px 0 8px;">顺丰一进入派送，WIN-BG-03 自动秒推赵仓管 10 分钟内一镜到底开箱。</div>
          <input v-model="preForm.sf_waybill_no" class="input" placeholder="顺丰运单号 SF..." style="margin-bottom: 8px;" />
          <button class="btn btn-sm btn-amber" style="width: 100%;" @click="doPrebuy('mark_sf_delivering', { sf_waybill_no: preForm.sf_waybill_no })">
            🚚 标为顺丰派送中 · 秒推仓管 10m 验机
          </button>
        </div>
      </div>
    </div>

    <!-- 板块二：仓管 10m 到货一镜到底验机（WAREHOUSE/ADMIN 专属） -->
    <div class="card" data-tour="detail-warehouse" style="margin-bottom: 14px; border-left: 4px solid #059669;">
      <div class="card-header">
        <h3 class="card-title">📹 仓管 10 分钟开箱验机定级（仅 WAREHOUSE / ADMIN 角色有权提交，防采购员越权）</h3>
        <span class="tag slate">{{ d.case.warehouse_check_state }}</span>
      </div>
      <div class="grid grid-3" style="gap: 10px;">
        <div>
          <label class="field-label">一镜到底开箱视频地址</label>
          <input v-model="whForm.warehouse_video_url" class="input" placeholder="/evidence/unbox_verified.mp4" />
        </div>
        <div>
          <label class="field-label">验机判定分支</label>
          <select v-model="whForm.outcome" class="select">
            <option value="pass_good">✓ 完好无瑕 · 直接入良品库完结</option>
            <option value="defect_refuse">🚨 检出暗伤 · 顺丰站点当场拒签（启动轨 A）</option>
            <option value="defect_signed">⚠ 已签收后检出暗伤 · 走平台退货拦截留货（轨 B）</option>
          </select>
        </div>
        <div>
          <label class="field-label">实测瑕疵 / 入库货位说明</label>
          <input v-model="whForm.warehouse_defect_note" class="input" placeholder="如：白屏检出左下角 2cm 亮斑 / 杂牌充电头" />
        </div>
      </div>
      <div style="margin-top: 10px; display: flex; justify-content: flex-end;">
        <button class="btn btn-primary btn-sm" @click="submitWarehouse">📤 提交仓管 10m 验机定级</button>
      </div>
    </div>

    <!-- 板块三：到货双轨 9 步二次议价全闭环驾驶舱 -->
    <div v-if="d.ticket" class="card" data-tour="detail-aftersales" style="border-left: 4px solid #dc2626;">
      <div class="card-header">
        <div>
          <h3 class="card-title">⚔️ 阶段二：到货双轨 9 步二次议价与钱货双清闭环（{{ d.ticket.ticket_id }} · 第 {{ d.ticket.current_step }} / 9 步）</h3>
          <div class="muted">
            当前轨道：
            <strong style="color: #1d4ed8;">{{ d.ticket.arrival_track === 'sf_express_refuse' ? '轨 A · 顺丰派送站 10m 拒签未确认收货' : '轨 B · 已签收先走闲鱼官方退货 + 拦截留货' }}</strong>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button
            class="btn btn-sm"
            @click="doAftersales('switch_track', { arrival_track: d.ticket.arrival_track === 'sf_express_refuse' ? 'signed_platform_return' : 'sf_express_refuse' })"
          >
            ⇄ 切换双轨方向
          </button>
        </div>
      </div>

      <!-- 95338 危险警示 -->
      <div v-if="d.ticket.sf_95338_status === 'requested'" class="banner red">
        <strong>🚨 【第 7 步 95338 防丢高危锁已触发】卖家已致电顺丰 95338 请求退回，快递极可能被收走！截回成功前，仓管入库已被 409 锁死。</strong>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-sm btn-primary" @click="doAftersales('handle_95338', { sf_95338_status: 'intercepted' })">✓ 确认已截回快递解开入库锁</button>
          <button class="btn btn-sm" @click="doAftersales('handle_95338', { sf_95338_status: 'returned_to_seller' })">确认已退回卖家并全额退关单</button>
        </div>
      </div>

      <div class="grid grid-2" style="gap: 14px; margin-bottom: 14px;">
        <!-- 第2-4步：拒签核验加微 + 3色情绪 + 1/2半价 vs P3首刀 -->
        <div style="border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #f8fafc;">
          <strong style="font-size: 13px;">第 2–4 步：拒签加微 · 卖家 3 色信号 · 首刀计算器</strong>
          <div style="display: flex; gap: 6px; margin-top: 8px;">
            <input v-model="asForm.seller_wx_id" class="input" placeholder="已添加卖家微信号（如 wx_laze88）" />
            <button class="btn btn-sm" @click="doAftersales('verify_refuse_and_wx', { seller_wx_id: asForm.seller_wx_id })">✓ 确认拒签已加微</button>
          </div>
          <div class="grid grid-3" style="gap: 6px; margin-top: 8px;">
            <select v-model="asForm.seller_signal" class="select">
              <option value="green_proactive">🟢 绿 · 主动询问折让</option>
              <option value="amber_anxious">🟡 黄 · 纠结亏本邮费</option>
              <option value="red_hard_address">🔴 红 · 强硬打退回</option>
            </select>
            <select v-model="asForm.first_knife_mode" class="select">
              <option value="half_price">🔪 1/2 半价极端首刀</option>
              <option value="p3_itemized">🔧 P3 拆项精确首刀</option>
            </select>
            <input v-model.number="asForm.salvage_profit_yuan" type="number" class="input" placeholder="勉强收净利 ¥" />
          </div>
          <div style="display: flex; gap: 8px; margin-top: 8px; align-items: center;">
            <input v-model.number="asForm.opening_anchor_yuan" type="number" class="input" placeholder="自定义留货低价 ¥（留空自动算半价）" />
            <button class="btn btn-sm btn-blue" @click="doAftersales('classify_signal', asForm)">确定首刀锚位</button>
          </div>
          <div class="muted" style="margin-top: 6px;">
            当前首刀锚定留货价：<strong class="num">{{ fmtYuan(d.ticket.opening_anchor_cents) }}</strong> · 兜底净利：<strong class="num">{{ fmtYuan(d.ticket.salvage_profit_cents) }}</strong>
          </div>
        </div>

        <!-- 第5-6步：十二奇兵选招 + 422 扫描 -->
        <div style="border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #f8fafc;">
          <strong style="font-size: 13px;">第 5–6 步：P1–P6 × G1–G6 十二奇兵压价实战（点招数自动填话术）</strong>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0;">
            <button
              v-for="tc in TWELVE_TACTICS"
              :key="tc.code"
              type="button"
              class="btn btn-sm"
              style="font-size: 11px; padding: 3px 7px;"
              :style="asForm.tactic_code === tc.code ? 'background: #0f766e; color: #fff; border-color: #0f766e;' : ''"
              @click="pickTactic(tc)"
            >
              {{ tc.name.split(' ')[0] }}
            </button>
          </div>
          <textarea v-model="asForm.bargain_content" class="textarea" rows="2" placeholder="点击上方奇兵卡片自动填入高水准白话话术（禁止内部词与小二介入）..."></textarea>
          <div style="display: flex; gap: 8px; margin-top: 6px; justify-content: space-between;">
            <input v-model.number="asForm.bargain_offer_yuan" type="number" class="input" style="width: 140px;" placeholder="建议折让金额 ¥" />
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-sm btn-danger" @click="doAftersales('handle_95338', { sf_95338_status: 'requested' })">模拟 95338 退回</button>
              <button class="btn btn-sm btn-primary" @click="doAftersales('send_bargain_round', { content: asForm.bargain_content, tactic_code: asForm.tactic_code, offer_yuan: asForm.bargain_offer_yuan })">
                💬 记录压价回合
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 第8-9步：整单全退关单 + 支付宝对公直转 + 财务与仓管双清完结 -->
      <div class="grid grid-2" style="gap: 14px;">
        <div style="border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #fffbeb;">
          <strong style="font-size: 13px;">第 8 步：结算落地（整单全退关单 + T+1 支付宝对公直转）→ 生第二段 10%</strong>
          <div class="grid grid-2" style="gap: 6px; margin-top: 8px;">
            <select v-model="asForm.settle_mode" class="select">
              <option value="corp_alipay_close">★ B-01 闲鱼整单退关单 + 支付宝对公转</option>
              <option value="platform_partial">平台直接部分退款留货</option>
            </select>
            <input v-model.number="asForm.agreed_reduction_yuan" type="number" class="input" placeholder="到货谈退省额 R (¥)" />
          </div>
          <div v-if="asForm.settle_mode === 'corp_alipay_close'" class="grid grid-2" style="gap: 6px; margin-top: 6px;">
            <input v-model="asForm.payee_real_name" class="input" placeholder="对公收款实名（禁填0）" />
            <input v-model="asForm.payee_alipay_account" class="input" placeholder="实名支付宝账号（禁填0）" />
          </div>
          <div style="margin-top: 8px; display: flex; justify-content: flex-end;">
            <button class="btn btn-sm btn-amber" @click="doAftersales('record_settlement', asForm)">
              📝 锁成交差额并生成 T+1 对公支付单 + 到货 10%
            </button>
          </div>
        </div>

        <div style="border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #ecfdf5;">
          <strong style="font-size: 13px;">第 9 步：会计核销 T+1 付款 + 仓管入库双清（两段 10% 永久独立）</strong>
          <div v-for="reg in d.corp_alipay_regs" :key="reg.reg_id" style="padding: 8px; background: #ffffff; border: 1px solid var(--border); border-radius: 6px; margin-top: 8px;">
            <div style="display: flex; justify-content: space-between;">
              <span>{{ reg.reg_id }} · 转 <strong>{{ reg.payee_real_name }}</strong> ({{ fmtYuan(reg.amount_cents) }})</span>
              <span class="tag" :class="reg.status === 'approved_paid' ? 'grn' : 'amb'">{{ reg.status }}</span>
            </div>
            <div v-if="reg.status === 'pending_finance'" style="display: flex; gap: 6px; margin-top: 6px;">
              <input v-model="finReceipt" class="input" placeholder="银行/支付宝回执流水号（禁填0）" />
              <button class="btn btn-sm btn-primary" @click="approveFinance(reg.reg_id)">会计核销放款</button>
            </div>
          </div>
          <div style="display: flex; gap: 6px; margin-top: 10px; align-items: center;">
            <input v-model="binLoc" class="input" placeholder="良品货位号如 A-02-05" />
            <button class="btn btn-sm btn-primary" @click="closeWarehouseInbound">📦 仓管确认入良品库完结</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { apiRequest } from '../api/client.js';
import { fmtYuan, handleApiError, openLightbox, openVideoTutorial, pushToast, refreshGlobalSummary } from '../store/store.js';
import { TWELVE_TACTICS } from '../data/tutorials.js';

const route = useRoute();
const d = ref(null);
const safeAccounts = ref([]);
const finReceipt = ref('ALI-CORP-20261119-01');
const binLoc = ref('A-02-05');

const preForm = reactive({
  account_id: 'ACC-GF-03',
  suspect_quality_flag: true,
  agreed_yuan: null,
  seller_modified_price_verified: false,
  payment_receipt_no: '',
  external_order_no: '',
  sf_waybill_no: '',
});

const whForm = reactive({
  warehouse_video_url: '/evidence/unbox_verified.mp4',
  outcome: 'defect_refuse',
  warehouse_defect_note: '',
});

const asForm = reactive({
  seller_wx_id: '',
  seller_signal: 'amber_anxious',
  first_knife_mode: 'half_price',
  salvage_profit_yuan: 350,
  opening_anchor_yuan: null,
  tactic_code: 'P3_ITEMIZED_ANCHOR',
  bargain_content: '',
  bargain_offer_yuan: 450,
  settle_mode: 'corp_alipay_close',
  agreed_reduction_yuan: 550,
  payee_real_name: '卖家张哲',
  payee_alipay_account: '00038155728',
});

function pickTactic(tc) {
  asForm.tactic_code = tc.code;
  asForm.bargain_content = tc.script;
}

async function load() {
  try {
    const [detRes, accRes] = await Promise.all([
      apiRequest(`/api/cases/${encodeURIComponent(route.params.caseId)}`),
      apiRequest('/api/accounts'),
    ]);
    d.value = detRes.detail;
    safeAccounts.value = accRes.accounts || [];
    preForm.account_id = d.value.case.account_id || 'ACC-GF-03';
    preForm.agreed_yuan = d.value.case.agreed_cents ? d.value.case.agreed_cents / 100 : d.value.case.target_cents / 100;
    preForm.sf_waybill_no = d.value.case.sf_waybill_no || `SF${Date.now().toString().slice(-8)}`;
    if (d.value.ticket) {
      asForm.seller_wx_id = d.value.ticket.seller_wx_id || '';
      asForm.agreed_reduction_yuan = d.value.ticket.agreed_reduction_cents
        ? d.value.ticket.agreed_reduction_cents / 100
        : 450;
    }
  } catch (err) {
    handleApiError(err);
  }
}

async function doLockSnapshot() {
  try {
    const res = await apiRequest(`/api/cases/${encodeURIComponent(d.value.case.case_id)}/snapshot`, {
      method: 'POST',
      body: { account_id: preForm.account_id, suspect_quality_flag: preForm.suspect_quality_flag },
    });
    d.value = res.detail;
    pushToast('不可篡改快照已固定！', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

async function doPrebuy(action, payload) {
  try {
    const res = await apiRequest(`/api/cases/${encodeURIComponent(d.value.case.case_id)}/prebuy`, {
      method: 'POST',
      body: { action, ...payload },
    });
    d.value = res.detail;
    await refreshGlobalSummary();
    pushToast('买前流程推进成功！', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

async function doConfirmPay() {
  await doPrebuy('confirm_payment', {
    seller_modified_price_verified: preForm.seller_modified_price_verified,
    payment_receipt_no: preForm.payment_receipt_no,
    external_order_no: preForm.external_order_no,
    paid_yuan: preForm.agreed_yuan,
  });
}

async function submitWarehouse() {
  try {
    const res = await apiRequest(`/api/cases/${encodeURIComponent(d.value.case.case_id)}/warehouse-inspect`, {
      method: 'POST',
      body: whForm,
    });
    d.value = res.detail;
    await refreshGlobalSummary();
    pushToast('仓管 10m 开箱验机结果已提交！', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

async function doAftersales(action, payload) {
  try {
    const res = await apiRequest(`/api/aftersales/${encodeURIComponent(d.value.ticket.ticket_id)}/advance`, {
      method: 'POST',
      body: { action, ...payload },
    });
    d.value = res.detail;
    await refreshGlobalSummary();
    pushToast('到货二次议价动作已落库生效！', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

async function approveFinance(regId) {
  try {
    const res = await apiRequest(`/api/finance/alipay-regs/${encodeURIComponent(regId)}/approve`, {
      method: 'POST',
      body: { receipt_no: finReceipt.value },
    });
    d.value = res.detail;
    await refreshGlobalSummary();
    pushToast('T+1 对公付款核销完成！', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

async function closeWarehouseInbound() {
  try {
    const res = await apiRequest(`/api/aftersales/${encodeURIComponent(d.value.ticket.ticket_id)}/warehouse-close`, {
      method: 'POST',
      body: { bin_location: binLoc.value },
    });
    d.value = res.detail;
    await refreshGlobalSummary();
    pushToast('钱货双清！已入良品库完结并转正第二段 10% 提成（绝不重算买前段）', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(load);
watch(() => route.params.caseId, load);
</script>
