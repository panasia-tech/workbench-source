<template>
  <div class="dpage">
    <div v-if="!c" class="card">
      <p>没有找到这笔采购订单，可能已恢复初始数据。</p>
      <a href="#/cases" class="btn pri" style="margin-top: 12px">← 返回采购订单</a>
    </div>

    <template v-else>
      <!-- 1. 顶部极简返回栏 -->
      <div class="dbar">
        <a :href="`#/cases?bucket=${c.order_bucket || 'today'}`" class="btn sm">
          <Icon name="back" size="16" /> 返回{{ c.bucket_label || '采购订单' }}
        </a>
        <span class="crumb">
          {{ c.bucket_label }} / {{ c.category_label }} · {{ c.sub_category }}
        </span>

        <div class="dbar-right">
          <button type="button" class="btn sm" @click="store.ui.askBossOpen = true">
            🆘 遇到没见过的情况
          </button>
          <Q k="case-detail" label="本页怎么用" />
        </div>
      </div>

      <!-- 2. 顶部明白摘要卡（左图点开可放大 + 右侧一句话当前任务 + 4 个关键数字） -->
      <section class="hero" :class="{ zoom: zoomed }">
        <div class="pic">
          <div class="big" :class="c.lvl" @click="zoomed = !zoomed">
            <img v-if="c.cover_url" :src="c.cover_url" :alt="c.title" />
            <div v-else class="noimg">
              <b>📷</b>
              <span>还没有机器实拍图</span>
              <small>绝不放假网图，拿到卖家照片后补传</small>
            </div>
            <span class="pic-cap">{{ c.cover_kind || '商品照片' }}</span>
          </div>
        </div>

        <div class="info">
          <div class="row1">
            <span class="badge-l" :class="c.lvl">
              {{ LV[c.lvl].icon }} {{ LV[c.lvl].text }}
            </span>
            <span class="tag" :class="c.order_bucket === 'issue' ? 'red' : c.order_bucket === 'completed' ? 'grn' : 'acc'">
              {{ c.bucket_label }}
            </span>
            <span class="tag">{{ c.source_type }}</span>
            <span
              v-if="c.prebuy_eval?.potential_badge"
              class="tag"
              :class="c.prebuy_eval.can_secondary_bargain ? 'red' : 'amb'"
            >
              {{ c.prebuy_eval.potential_badge }}
            </span>
          </div>

          <h1>{{ c.title }}</h1>
          <p class="codes">
            卖家：<b>{{ c.seller_name }}</b> · 成色声明：<b>{{ c.condition_grade }}</b> · 跟进人：{{ c.owner_name }}（{{ c.owner_role_label }}）
          </p>

          <!-- 一眼看清现在要干嘛 -->
          <div class="issuebox" :class="c.lvl" data-tour="case-issues">
            <template v-if="c.issues?.length">
              <div class="t">👉 现在要做的事：</div>
              <ul>
                <li v-for="(iss, ii) in c.issues" :key="ii">
                  <i class="dot" :class="iss.lvl" />
                  <span>{{ iss.text }}</span>
                  <button type="button" class="go-link" @click="jumpToStep(iss.step)">
                    去这一步 ›
                  </button>
                </li>
              </ul>
            </template>
            <div v-else class="okline">
              ✓ 这笔订单已经全部办妥入库归档，提成已确认，不用再操作。
            </div>
          </div>

          <!-- 4 个明白数字（根据买前采购 vs 问题订单自动展示最关心的钱） -->
          <div v-if="c.order_bucket === 'issue' && c.bargain_plan" class="facts num">
            <div>
              <span>原实付货款</span>
              <b>{{ fmtYuan(c.ticket?.paid_cents) }}</b>
              <small>已锁闲鱼快照</small>
            </div>
            <div>
              <span>卖家目前已松口退</span>
              <b>{{ c.ticket?.partial_refund_cents > 0 ? fmtYuan(c.ticket.partial_refund_cents) : '待开口谈' }}</b>
              <small>开口报 {{ fmtYuan(c.bargain_plan.anchor_a_cents) }}</small>
            </div>
            <div>
              <span>目标退差 / 底线</span>
              <b>{{ fmtYuan(c.bargain_plan.target_b_cents) }}</b>
              <small>最少退 {{ fmtYuan(c.bargain_plan.floor_c_cents) }} 才留货</small>
            </div>
            <div>
              <span>你的 20% 议价高提成</span>
              <b style="color: var(--grn)">{{ fmtYuan(c.prices?.est_comm_cents) }}</b>
              <small>谈退越多提成越高</small>
            </div>
          </div>

          <div v-else class="facts num">
            <div>
              <span>{{ c.prices?.has_paid ? '已实付金额' : c.prices?.has_agreed ? '口头谈妥价' : '卖家挂牌价' }}</span>
              <b>{{ fmtYuan(c.prices?.seller_or_agreed_cents) }}</b>
              <small>{{ c.condition_grade }}</small>
            </div>
            <div>
              <span>公司参考行情价</span>
              <b>{{ fmtYuan(c.prices?.ref_price_cents) }}</b>
              <small>开口建议 {{ fmtYuan(c.prices?.first_offer_cents) }}</small>
            </div>
            <div>
              <span>你的最高出价上限</span>
              <b>{{ fmtYuan(c.prices?.ceiling_price_cents) }}</b>
              <small>超上限点按钮找主管</small>
            </div>
            <div>
              <span>{{ c.all_done ? '已确认提成' : '预计谈价提成' }}</span>
              <b style="color: var(--grn)">{{ fmtYuan(c.prices?.est_comm_cents) }}</b>
              <small>{{ c.ticket ? '到货议价按 20% 算' : '买前省钱按 10% 算' }}</small>
            </div>
          </div>
        </div>
      </section>

      <!-- 3. 核心：一步一屏步入式陪跑组件（买前 5 步 / 问题订单二次议价 4 步） -->
      <ProcurementFlow :c="c" :jump-step="jumpedStep" />

      <!-- 4. 辅助核对资料全部收进折叠抽屉（平时收起干干净净，需要核对原话或流水时点开即看） -->
      <div data-tour="case-folds">
        <Fold
          title="📂 买前卖家原话 · 四样底牌 · 账本与提成明细"
          :chips="foldChips"
        >
          <div class="secs">
            <div class="card">
              <h3>买前留存的四样底牌</h3>
              <dl class="kv">
                <template v-for="(ev, k) in c.capture" :key="k">
                  <dt>{{ ev.name }}</dt>
                  <dd>
                    <span class="tag" :class="ev.state === 'ok' ? 'grn' : ev.state === 'unknown' ? 'amb' : 'red'" style="margin-right:6px">
                      {{ ev.state === 'ok' ? '已留好' : ev.state === 'unknown' ? '暂时拿不到' : '待补' }}
                    </span>
                    {{ ev.detail }}
                  </dd>
                </template>
              </dl>
            </div>

            <div class="card">
              <h3>本单资金流水与提成记录</h3>
              <dl class="kv">
                <dt>真实单机净成本</dt>
                <dd><b>{{ c.prices?.net_cost_cents ? fmtYuan(c.prices.net_cost_cents) : '待付款核销后生成' }}</b></dd>
                <dt>收付款流水</dt>
                <dd v-if="!c.ledger_entries?.length" class="muted">暂无流水记录</dd>
                <dd v-else>
                  <div v-for="l in c.ledger_entries" :key="l.entry_id" style="margin-bottom:4px">
                    {{ l.channel }} {{ fmtYuan(l.amount_cents) }}（{{ l.status === 'verified' ? '已由陈会计核实到账' : '待陈会计核对' }}）
                  </div>
                </dd>
                <dt>提成明细</dt>
                <dd v-if="!c.commissions?.length" class="muted">入库对账后自动生成提成记录</dd>
                <dd v-else>
                  <div v-for="cm in c.commissions" :key="cm.comm_id">
                    <b>{{ fmtYuan(cm.confirmed_cents || cm.estimated_cents) }}</b> — {{ cm.note }}
                  </div>
                </dd>
              </dl>
            </div>
          </div>
        </Fold>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store, LV } from '../store.js';
import { fmtYuan } from '../api.js';
import Icon from '../components/Icon.vue';
import Q from '../components/Q.vue';
import Fold from '../components/Fold.vue';
import ProcurementFlow from '../components/ProcurementFlow.vue';

const props = defineProps({
  caseId: { type: String, required: true },
  initStep: { type: Number, default: null },
});

const zoomed = ref(false);
const jumpedStep = ref(props.initStep);

watch(
  () => props.initStep,
  (v) => {
    jumpedStep.value = v;
  }
);

const c = computed(() => (store.dashboard.cases || []).find((x) => x.case_id === props.caseId) || null);

const foldChips = computed(() => {
  if (!c.value) return [];
  const okCnt = Object.values(c.value.capture || {}).filter((x) => x.state === 'ok').length;
  const chips = [
    { text: `买前底牌 ${okCnt}/4 项`, cls: okCnt >= 3 ? 'grn' : 'amb' },
  ];
  if (c.value.prices?.net_cost_cents) {
    chips.push({ text: `真实净成本 ${fmtYuan(c.value.prices.net_cost_cents)}`, cls: '' });
  }
  if (c.value.prices?.est_comm_cents > 0) {
    chips.push({ text: `提成 ${fmtYuan(c.value.prices.est_comm_cents)}`, cls: 'grn' });
  }
  return chips;
});

function jumpToStep(stepNum) {
  jumpedStep.value = null;
  setTimeout(() => {
    jumpedStep.value = stepNum;
    document.getElementById('sec-flow')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 10);
}
</script>
