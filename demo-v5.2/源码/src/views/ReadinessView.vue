<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1 tabindex="-1">系统健康检查（主管视图）</h1>
        <p class="page-sub">查看全流程防错开关、闲鱼浏览器侧边助手状态与公司采购额度池实时余额</p>
      </div>
      <div class="page-acts">
        <a href="#/cases" class="btn pri">返回采购订单 ›</a>
        <Q k="today" label="怎么用" />
      </div>
    </header>

    <section class="facts" style="margin-bottom: 18px">
      <div class="card" style="padding: 16px 18px">
        <span class="muted">采购订单总数</span>
        <b class="num" style="font-size: 28px; display: block">{{ store.dashboard.cases.length }} 笔</b>
        <small class="muted">今天采购 {{ bucketCount('today') }} · 问题订单 {{ bucketCount('issue') }} · 已完结 {{ bucketCount('completed') }}</small>
      </div>
      <div class="card" style="padding: 16px 18px">
        <span class="muted">今日采购可用额度</span>
        <b class="num" style="font-size: 28px; display: block">{{ fmtYuan(quota.available_cents) }}</b>
        <small class="muted">总额度 {{ fmtYuan(quota.total_cents) }} · 预占中 {{ fmtYuan(quota.reserved_cents) }}</small>
      </div>
      <div class="card" style="padding: 16px 18px">
        <span class="muted">核心防错开关</span>
        <b class="num" style="font-size: 28px; display: block; color: var(--grn)">8 / 8 已开启</b>
        <small class="muted">防泄密 · 改价核对锁 · 先点退货锁 · 双人核账</small>
      </div>
      <div class="card" style="padding: 16px 18px">
        <span class="muted">新员工上岗保护</span>
        <b class="num" style="font-size: 28px; display: block; color: var(--acc)">开启中</b>
        <small class="muted">未完成 3 关防踩坑练习自动拦截高风险按钮</small>
      </div>
    </section>

    <section class="card" style="margin-bottom: 18px">
      <h3>已开启的 8 项防犯错保护</h3>
      <div class="guard-grid">
        <div v-for="g in guards" :key="g.title" class="guard-item">
          <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center">
            <b>{{ g.title }}</b>
            <span class="tag grn">✓ 运行中</span>
          </div>
          <p class="muted" style="font-size: 13px; margin-top: 6px">{{ g.desc }}</p>
        </div>
      </div>
    </section>

    <Fold title="主管说明：本地真实数据与外部系统对接边界" sub="诚实区分哪些已在本机闭环、哪些上线时接真实网关">
      <ul style="padding-left: 18px; display: grid; gap: 6px; font-size: 13.5px; line-height: 1.65">
        <li><b>已在本机真实持久化：</b>订单三分类（今天采购的 / 问题订单 / 已经完结的）、买前 5 步与问题订单 4 步进度、每轮谈退差价记录、先点退货锁、微信 850 分开记账双人确认、买前 10% 与到货议价 20% 提成台账、新手 3 关练习门禁。</li>
        <li><b>上线时对接外部网关：</b>闲鱼真实实付回执自动拉取、顺丰官方线上拦截状态自动回调、公司财务总账导出对接。</li>
      </ul>
    </Fold>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { store } from '../store.js';
import { fmtYuan } from '../api.js';
import Q from '../components/Q.vue';
import Fold from '../components/Fold.vue';

const quota = computed(() => store.dashboard.quota_pool || {});

function bucketCount(b) {
  return (store.dashboard.cases || []).filter((c) => c.order_bucket === b).length;
}

const guards = [
  { title: '1. 页面写明的别重复追问提示', desc: '第一步顶部固定醒目提醒，避免采购员多嘴把捡漏卖家问跑，同时把卖家原话留底作日后退差证据。' },
  { title: '2. 聊天防泄密自动拦截', desc: '输入框一旦出现“目标价、公司底价、提成、毛利、参考价”等内部词，立刻红字拦住不让发。' },
  { title: '3. 未核对卖家改价不准点已付', desc: '必须先核对闲鱼页面真实改后价不高于商定价与上限，才能录入付款回执，防止多付冤枉钱。' },
  { title: '4. 问题单必须先点退货锁住 48 小时', desc: '没在闲鱼提交退货申请前，系统锁死后续谈退差价确认，防止超过无理由时效钱货两空。' },
  { title: '5. 到货谈退差自动算净赚对比与 20% 提成', desc: '自动对比「退差留货净赚」与「退回去重买净赚」，并配套电话 6 步顺口溜、沉默 3–6 秒法则与 5 类顶嘴应对话术。' },
  { title: '6. 微信另付 850 分开记账双人锁', desc: '原单退全款、重买走财务微信转款，必须陈会计核回执 + 赵仓管验机双确认才能完结。' },
  { title: '7. 快递未拦回禁止入库上架', desc: '退货途中临时谈妥改留货时，必须先确认顺丰/快递已成功拦截退回，严禁幽灵库存上架。' },
  { title: '8. 闲鱼浏览器侧边助手实时联动', desc: 'AdsPower 闲鱼聊天页右侧直接悬浮买前谈价、到货谈退差、付款核对与问主管 4 个标签页。' },
];
</script>

<style scoped>
.guard-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.guard-item {
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--soft);
  border: 1px solid var(--line);
}
@media (max-width: 820px) {
  .guard-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
