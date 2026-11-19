<script setup>
// 一个法人连同下面三层和名下的手机卡。editable 时每层带「改 / 加下一层 / 删」，管理员用；否则只读（临时开放）。
defineProps({
  lp: { type: Object, required: true },
  editable: { type: Boolean, default: false },
})
const emit = defineEmits(['edit', 'add', 'remove', 'auth', 'sim'])
const AUTH = { none: '没授权对账', authorized: '已授权对账', expired: '授权过期', error: '授权出错' }
const money = (v) => `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
function shopLine(s) {
  return [s.role && s.role !== 'sales' ? s.role_label : '', s.lead_shop_name ? `往 ${s.lead_shop_name} 引流` : '',
    s.fee_rate != null ? `服务费 ${s.fee_rate}%` : '', s.deposit != null ? `保证金 ${money(s.deposit)}` : '',
    s.month ? `本月净毛利 ${money(s.month.net)}` : '', s.device_name ? `跑在 ${s.device_name}` : ''].filter(Boolean).join(' · ')
}
function simLine(c) {
  const kind = c.category === 'sub' ? `副卡 · ${c.master_phone || '?'}` : c.category === 'external' ? `外部合约卡 · ${c.holder || ''}` : c.category_label
  const fee = c.billing === 'shared' ? '共用主卡话费' : c.balance != null ? `话费 ${money(c.balance)}` : ''
  return [c.carrier.replace('中国', ''), kind, fee, c.in_device ? `插在 ${c.in_device}` : ''].filter(Boolean).join(' · ')
}
</script>

<template>
  <div class="lt">
    <div class="lt-node lt-node--lp">
      <div class="lg-row">
        <div>
          <b>{{ lp.name }}</b><span v-if="editable && lp.needs_check" class="lg-tag">要核对</span>
          <div class="lg-muted">{{ lp.phone || '没填手机号' }}<span v-if="lp.email"> · {{ lp.email }}</span></div>
          <div v-if="lp.face_sla || lp.agreement_end" class="lg-muted">{{ [lp.face_sla && '刷脸 ' + lp.face_sla, lp.agreement_end && '托管合同到 ' + lp.agreement_end].filter(Boolean).join(' · ') }}</div>
          <div v-for="(x, i) in lp.alerts || []" :key="i" :class="['lt-alert', 'lt-alert--' + x.level]">{{ x.text }}</div>
          <div v-if="lp.note" class="lg-muted">{{ lp.note }}</div>
        </div>
        <div v-if="editable" class="lt-ops">
          <a @click="emit('edit', 'legal_person', lp)">改</a>
          <a @click="emit('add', 'entity', lp)">加主体</a>
          <a @click="emit('add', 'sim', lp)">加卡</a>
        </div>
      </div>
    </div>

    <div v-for="c in lp.sims || []" :key="c.id" class="lt-node lt-node--entity">
      <div class="lg-row">
        <div>
          <span class="lt-level">手机卡</span><b>{{ c.phone }}</b><span v-if="editable && c.needs_check" class="lg-tag">要核对</span>
          <div class="lg-muted">{{ simLine(c) }}</div>
          <div v-for="(x, i) in c.alerts || []" :key="i" :class="['lt-alert', 'lt-alert--' + x.level]">{{ x.text }}</div>
        </div>
        <div v-if="editable" class="lt-ops lt-ops--wrap">
          <a @click="emit('edit', 'sim', c)">改</a>
          <a v-if="c.billing !== 'shared'" @click="emit('sim', 'recharge', c)">充值</a>
          <a @click="emit('sim', 'uses', c)">绑了什么</a>
          <a v-if="c.status !== 'closed'" @click="emit('sim', 'rebind', c)">换号</a>
          <a class="lt-del" @click="emit('remove', 'sim', c)">删</a>
        </div>
      </div>
    </div>

    <div v-if="!lp.entities.length" class="lt-empty">还没有主体</div>
    <div v-for="e in lp.entities" :key="e.id" class="lt-node lt-node--entity">
      <div class="lg-row">
        <div>
          <span class="lt-level">主体</span><b>{{ e.name }}</b><span v-if="editable && e.needs_check" class="lg-tag">要核对</span>
          <div class="lg-muted">{{ e.entity_type_label }}<span v-if="e.credit_code"> · {{ e.credit_code }}</span></div>
          <div class="lg-muted">{{ e.tax_payer_label }} · {{ e.tax_levy_label }}<span v-if="e.report_year"> · 年报报到 {{ e.report_year }}</span></div>
          <div v-for="(x, i) in e.alerts || []" :key="i" :class="['lt-alert', 'lt-alert--' + x.level]">{{ x.text }}</div>
        </div>
        <div v-if="editable" class="lt-ops lt-ops--wrap">
          <a @click="emit('edit', 'entity', e)">改</a>
          <a @click="emit('add', 'alipay', e)">加支付宝</a>
          <a @click="emit('add', 'shop', e, true)">加店铺</a>
          <a @click="emit('add', 'shop', e, 'marketing')">加引流号</a>
          <a class="lt-del" @click="emit('remove', 'entity', e)">删</a>
        </div>
      </div>

      <div v-for="a in e.alipays" :key="a.id" class="lt-node lt-node--alipay">
        <div class="lg-row">
          <div>
            <span class="lt-level">{{ a.role_label }}</span><b>{{ a.account }}</b><span v-if="editable && a.needs_check" class="lg-tag">要核对</span>
            <span v-if="editable" :class="['lt-auth', 'lt-auth--' + (a.auth_status || 'none')]" :title="a.auth_error || ''">{{ AUTH[a.auth_status || 'none'] }}</span>
            <div v-if="a.alias || a.alipay_user_id || a.corporate_pay" class="lg-muted">{{ [a.alias, a.alipay_user_id, a.corporate_pay ? '因公付' : ''].filter(Boolean).join(' · ') }}</div>
            <div v-for="(x, i) in a.alerts || []" :key="i" :class="['lt-alert', 'lt-alert--' + x.level]">{{ x.text }}</div>
          </div>
          <div v-if="editable" class="lt-ops">
            <a @click="emit('edit', 'alipay', a)">改</a>
            <a v-if="a.role === 'sales'" @click="emit('add', 'shop', a)">加店铺</a>
            <a v-if="a.role === 'purchase'" @click="emit('add', 'shop', a)">加采购号</a>
            <a v-if="a.auth_status !== 'authorized'" @click="emit('auth', a)">授权对账</a>
            <a class="lt-del" @click="emit('remove', 'alipay', a)">删</a>
          </div>
        </div>

        <div v-for="s in a.shops" :key="s.id" class="lt-node lt-node--shop">
          <div class="lg-row">
            <div>
              <span class="lt-level">{{ s.platform_label }}</span>{{ s.name }}<span v-if="editable && s.needs_check" class="lg-tag">要核对</span>
              <div v-if="s.sale_shop_label" class="lg-muted">ERP 店铺：{{ s.sale_shop_label }}</div>
              <div v-if="shopLine(s)" class="lg-muted">{{ shopLine(s) }}</div>
              <div v-for="(x, i) in s.alerts || []" :key="i" :class="['lt-alert', 'lt-alert--' + x.level]">{{ x.text }}</div>
            </div>
            <div v-if="editable" class="lt-ops">
              <a @click="emit('edit', 'shop', s)">改</a>
              <a class="lt-del" @click="emit('remove', 'shop', s)">删</a>
            </div>
          </div>
        </div>
      </div>

      <div v-for="s in e.shops || []" :key="s.id" class="lt-node lt-node--alipay">
        <div class="lg-row">
          <div>
            <span class="lt-level">{{ s.platform_label }}</span>{{ s.name }}<span v-if="editable && s.needs_check" class="lg-tag">要核对</span>
            <div class="lg-muted">{{ s.channel_label }}<span v-if="s.merchant_no"> · {{ s.merchant_no }}</span></div>
            <div v-if="shopLine(s)" class="lg-muted">{{ shopLine(s) }}</div>
            <div v-for="(x, i) in s.alerts || []" :key="i" :class="['lt-alert', 'lt-alert--' + x.level]">{{ x.text }}</div>
          </div>
          <div v-if="editable" class="lt-ops">
            <a @click="emit('edit', 'shop', s)">改</a>
            <a class="lt-del" @click="emit('remove', 'shop', s)">删</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lt-node { padding: 10px 0 10px 12px; border-left: 2px solid var(--lg-line); overflow-wrap: anywhere; }
.lt-node--lp { border-left: 0; padding-left: 0; }
.lt-node--entity { margin-top: 6px; }
.lt-node--alipay, .lt-node--shop { margin-left: 4px; }
.lt-level { font-size: 12px; color: var(--lg-ink-2); margin-right: 6px; }
.lt-ops { display: flex; gap: 10px; flex-shrink: 0; font-size: 13px; }
.lt-ops a { color: var(--lg-accent); cursor: pointer; white-space: nowrap; }
.lt-ops a.lt-del { color: var(--lg-danger); }
.lt-ops--wrap { flex-wrap: wrap; justify-content: flex-end; max-width: 45%; }
.lt-auth { display: inline-block; margin-left: 6px; font-size: 12px; padding: 0 6px; border-radius: 4px; background: #f3f4f6; color: var(--lg-ink-2); }
.lt-auth--authorized { background: #ecfdf5; color: #047857; }
.lt-auth--expired, .lt-auth--error { background: #fef2f2; color: var(--lg-danger); }
.lt-alert { font-size: 12px; margin-top: 2px; }
.lt-alert--warn { color: #b45309; }
.lt-alert--danger { color: var(--lg-danger); }
.lt-empty { padding: 8px 0; font-size: 13px; color: var(--lg-ink-2); }
</style>
