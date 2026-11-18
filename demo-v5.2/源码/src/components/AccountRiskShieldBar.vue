<template>
  <section class="shield-shell" :class="shellTone">
    <!-- 常驻极简一行：一眼看清各闲鱼采购号退款率 & 纠纷率距 5% 红标红线还有多少安全余量 -->
    <div class="sh-strip">
      <div class="sh-left">
        <span class="badge-l" :class="summary.red_account_count > 0 ? 'red' : summary.at_risk_account_count > 0 ? 'amb' : 'grn'">
          🛡️ 防红标红线 ≤ 5.0%
        </span>
        <div class="sh-meta">
          <b>闲鱼账号退款率 & 纠纷率监控：</b>
          <span>
            全组近30天总退款率 <b>{{ summary.overall_refund_rate_pct }}%</b> · 总纠纷介入率 <b>{{ summary.overall_dispute_rate_pct }}%</b>
            <span v-if="summary.at_risk_account_count > 0" class="txt-amb">
              （⚠️ <b>{{ summary.at_risk_account_count }}</b> 个号逼近 5% 预警，新拍高风险单建议切 <b>{{ summary.recommended_safe_account }} [{{ summary.recommended_safe_refund_pct }}%]</b>）
            </span>
          </span>
        </div>
      </div>

      <div class="sh-acts">
        <span class="tag red">🚫 非必要绝不扯皮 · 绝不点小二介入</span>
        <Term k="rate_5pct_guard">5%防红标规矩</Term>
        <button type="button" class="btn sm" @click="open = !open">
          {{ open ? '收起账号明细 ▲' : '📊 各号 5% 额度明细 ▼' }}
        </button>
      </div>
    </div>

    <!-- 展开看每个闲鱼采购号的 30 天退款率 / 纠纷率进度尺与剩余安全单数 -->
    <div v-if="open" class="sh-body">
      <div class="acct-grid">
        <div
          v-for="ac in accounts"
          :key="ac.account_id"
          class="acct-card"
          :class="ac.risk_level"
        >
          <div class="ac-hd">
            <b>{{ ac.account_label }}</b>
            <span class="tag" :class="ac.risk_level">{{ ac.status_badge }}</span>
          </div>

          <div class="rate-bars num">
            <div class="rb-row">
              <div class="rb-lbl">
                <span>近30天退款率（{{ ac.rolling_30d_refunds }} / {{ ac.rolling_30d_orders }}单）</span>
                <b :class="ac.refund_rate_pct >= 3.8 ? 'txt-red' : ''">{{ ac.refund_rate_pct }}% / 5.0%红线</b>
              </div>
              <div class="rtrack">
                <i
                  :style="{
                    width: Math.min(100, (ac.refund_rate_pct / 5.0) * 100) + '%',
                    background: ac.refund_rate_pct >= 4.5 ? 'var(--red)' : ac.refund_rate_pct >= 3.5 ? 'var(--amb)' : 'var(--grn)',
                  }"
                />
              </div>
              <small class="muted">
                距 5% 红标还剩 <b>{{ ac.remaining_refund_quota }} 单</b>可退额度 · 若再退 1 单将升至 <b>{{ ac.next_refund_rate_pct }}%</b>
              </small>
            </div>

            <div class="rb-row">
              <div class="rb-lbl">
                <span>近30天纠纷介入率（{{ ac.rolling_30d_disputes }} / {{ ac.rolling_30d_orders }}单）</span>
                <b :class="ac.dispute_rate_pct >= 3.0 ? 'txt-red' : ''">{{ ac.dispute_rate_pct }}% / 5.0%红线</b>
              </div>
              <div class="rtrack">
                <i
                  :style="{
                    width: Math.min(100, (ac.dispute_rate_pct / 5.0) * 100) + '%',
                    background: ac.dispute_rate_pct >= 3.0 ? 'var(--red)' : 'var(--acc)',
                  }"
                />
              </div>
              <small class="muted">
                非必要严禁扯皮或点小二介入（距 5% 剩 {{ ac.remaining_dispute_quota }} 单缓冲）
              </small>
            </div>
          </div>

          <p class="ac-note">{{ ac.note }}</p>
        </div>
      </div>

      <div class="anti-bicker-bar">
        <b>📌 公司防红标三条死纪律：</b>
        1. <b>退款率 ≤ 5%、纠纷率 ≤ 5%</b>，任一超 5% 平台立即给账号打红标限流；
        2. <b>非不必要，绝不跟卖家扯皮、绝不点「申请小二介入 / 闲鱼小法庭」</b>（能赚钱走勉强收下/直补保号，不赚钱痛快退回）；
        3. 逼近 5% 预警的账号（如 <b>闲鱼副号2 4.71%</b>）买前自动分流到安全号拍单，到货优先走「零退款率留货通道」。
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { store } from '../store.js';
import Term from './Term.vue';

const props = defineProps({
  defaultOpen: { type: Boolean, default: false },
});

const open = ref(props.defaultOpen);

const shield = computed(() => store.dashboard.account_risk_shield || {});
const accounts = computed(() => shield.value.accounts || []);
const summary = computed(
  () =>
    shield.value.summary || {
      overall_refund_rate_pct: 0,
      overall_dispute_rate_pct: 0,
      at_risk_account_count: 0,
      red_account_count: 0,
      recommended_safe_account: '闲鱼3号',
      recommended_safe_refund_pct: 1.67,
    }
);

const shellTone = computed(() => {
  if (summary.value.red_account_count > 0) return 'tone-red';
  if (summary.value.at_risk_account_count > 0) return 'tone-amb';
  return 'tone-grn';
});
</script>

<style scoped>
.shield-shell {
  background: var(--panel);
  border: 1.5px solid var(--line);
  border-radius: 18px;
  padding: 12px 18px;
  margin-bottom: 18px;
  box-shadow: var(--sh);
}
.shield-shell.tone-amb {
  border-color: var(--amb);
}
.shield-shell.tone-red {
  border-color: var(--red);
}
.sh-strip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.sh-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1;
}
.sh-meta {
  font-size: 13.5px;
  line-height: 1.45;
}
.sh-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sh-body {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  display: grid;
  gap: 12px;
}
.acct-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.acct-card {
  background: var(--soft);
  border: 1.5px solid var(--line);
  border-radius: 15px;
  padding: 13px 14px;
  display: grid;
  gap: 10px;
}
.acct-card.amb {
  border-color: var(--amb);
  background: var(--amb-soft);
}
.acct-card.red {
  border-color: var(--red);
  background: var(--red-soft);
}
.ac-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13.5px;
}
.rate-bars {
  display: grid;
  gap: 8px;
}
.rb-row {
  display: grid;
  gap: 3px;
}
.rb-lbl {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.rtrack {
  height: 7px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.1);
  overflow: hidden;
}
.rtrack > i {
  display: block;
  height: 100%;
  border-radius: 999px;
}
.ac-note {
  font-size: 12px;
  color: var(--ink2);
  line-height: 1.45;
}
.anti-bicker-bar {
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--soft);
  font-size: 12.8px;
  line-height: 1.55;
}
.txt-red { color: var(--red); }
.txt-amb { color: var(--amb-ink); }
@media (max-width: 980px) {
  .acct-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
