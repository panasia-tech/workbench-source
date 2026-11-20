<template>
  <div class="page-scroll">
    <div class="page-wrap">
      <!-- 头部：支持一键在「外包个人激励卡」与「主管全维反作弊考核大盘」之间切换查看 -->
      <header class="card kpi-hero">
        <div>
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="tag acc">参考千牛 · 拼多多 · 京麦咚咚 · 抖店飞鸽标准</span>
            <span class="tag grn">内置总纲领 KPI 五防（防机器人假回 / 防单字刷尾响 / 防乱甩锅）</span>
          </div>
          <h1 style="font-size: 21px; margin-top: 6px">
            {{ viewMode === 'personal' ? `我的今日接待战绩（${myStats.name}）` : '外包客服全维考核与反作弊结算大盘' }}
          </h1>
          <p class="muted" style="font-size: 13px; margin-top: 3px">
            考核静默期：{{ kpi.config.quietHours }} ｜ 硬红线：<b>30秒首响 · 3分钟人工回复率 ≥{{ kpi.config.threeMinReplyRateTarget }}% · 一件一拍实拍前置 100%</b>
          </p>
        </div>

        <div style="display: flex; align-items: center; gap: 8px">
          <div class="seg-switch">
            <button
              type="button"
              :class="{ on: viewMode === 'personal' }"
              @click="viewMode = 'personal'"
            >
              👤 坐席个人战绩视图
            </button>
            <button
              type="button"
              :class="{ on: viewMode === 'supervisor' }"
              @click="viewMode = 'supervisor'"
            >
              📊 主管全团考核与结算大盘
            </button>
          </div>
          <button type="button" class="btn sm pri" @click="exportSettlementCsv">
            <Icon name="download" size="15" /> 导出月度结算 CSV
          </button>
          <Q k="kpi" label="考核口径" />
        </div>
      </header>

      <!-- ==================== 模式 A：C端清爽外包个人战绩舱 ==================== -->
      <template v-if="viewMode === 'personal'">
        <div class="personal-grid">
          <div class="card stat-big good">
            <span class="sb-lbl">今日独立接待人数（去重买家 UV）</span>
            <div class="sb-val">{{ myStats.todayUv }} <small>人</small></div>
            <span class="sb-sub">有效人工回复 {{ myStats.manualReplied }} 会话 · 在岗 {{ myStats.onlineHours }}h</span>
          </div>

          <div class="card stat-big" :class="myStats.firstReplyMedianSec <= 30 ? 'good' : 'warn'">
            <span class="sb-lbl">首次响应中位时长（对标京麦 ≤30s）</span>
            <div class="sb-val">{{ myStats.firstReplyMedianSec }} <small>秒</small></div>
            <span class="sb-sub">平均每轮响应 {{ myStats.avgReplySec }} 秒 · 30秒应答率 {{ myStats.thirtySecRate }}%</span>
          </div>

          <div class="card stat-big" :class="myStats.threeMinRate >= 96 ? 'good' : 'warn'">
            <span class="sb-lbl">3分钟人工回复率（拼多多/抖店生死线）</span>
            <div class="sb-val">{{ myStats.threeMinRate }}<small>%</small></div>
            <span class="sb-sub">目标 ≥{{ kpi.config.threeMinReplyRateTarget }}%（已剔除50s自动兜底假回）</span>
          </div>

          <div class="card stat-big good">
            <span class="sb-lbl">发货前「一件一拍」实拍执行率</span>
            <div class="sb-val">{{ myStats.realShotExecRate }}<small>%</small></div>
            <span class="sb-sub">疑问熔断跟进 {{ myStats.pauseFollowupSec }}s · 乱承诺倒扣 {{ myStats.promiseRefundPenalty }} 单</span>
          </div>
        </div>

        <div class="card" style="display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px">
          <div>
            <h3 style="font-size: 16px; margin-bottom: 10px">🎯 今日待补救提醒（处理完可稳拿满勤达标奖）</h3>
            <div class="rescue-list">
              <div v-for="c in urgentConvs" :key="c.id" class="rescue-row">
                <span class="plat-badge" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
                <span class="muted" style="font-size: 12.5px">
                  {{ c.autoRepliedOnly ? '机器人刚兜底，待你补人工真回' : '待发实拍或解答买家疑问' }}
                </span>
                <button type="button" class="btn sm pri" style="margin-left: auto" @click="goConv(c.id)">
                  立即去处理 ›
                </button>
              </div>
              <div v-if="!urgentConvs.length" class="tag grn" style="padding: 10px 14px">
                ✓ 太棒了！你名下所有红黄预警会话已全部清零！
              </div>
            </div>
          </div>

          <div class="bonus-card">
            <span class="tag acc">透明计件与质量达标预估</span>
            <div style="font-size: 28px; font-weight: 900; margin: 8px 0">
              ¥{{ myStats.estimatedDailyBonus }}
              <span style="font-size: 13px; font-weight: 600; color: var(--mute)">今日预计绩效（演示基准）</span>
            </div>
            <ul style="margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--ink2); display: grid; gap: 5px">
              <li>尾响礼貌闭环率：<b>{{ myStats.tailCloseRate }}%</b>（达标 ≥90%）</li>
              <li>有货询单支付转化率：<b>{{ myStats.inquiryConvRate }}%</b></li>
              <li>好评满意率：<b>{{ myStats.satisfactionRate }}%</b> · 无效甩锅退回：<b>{{ myStats.invalidEscalations }} 次</b></li>
            </ul>
          </div>
        </div>
      </template>

      <!-- ==================== 模式 B：主管/老板 14 项全维考核与反作弊大盘 ==================== -->
      <template v-else>
        <!-- 顶部 6 大核心健康度卡片 -->
        <div class="sup-six-grid">
          <div class="card mini-kpi">
            <span>今日总独立接待 UV</span>
            <b>{{ totalUv }} 人</b>
            <small>总会话 {{ totalSessions }} 轮</small>
          </div>
          <div class="card mini-kpi">
            <span>全团 3分钟人工回复率</span>
            <b style="color: var(--grn)">95.4%</b>
            <small>剔除 14 轮仅机器人兜底未回</small>
          </div>
          <div class="card mini-kpi">
            <span>中位首次响应（首响）</span>
            <b>25 秒</b>
            <small>对标京东咚咚 ≤30s 黄金线</small>
          </div>
          <div class="card mini-kpi">
            <span>发货前实拍视频执行率</span>
            <b style="color: var(--grn)">100.0%</b>
            <small>系统门禁物理锁死漏发</small>
          </div>
          <div class="card mini-kpi">
            <span>静默自动推仓免人工率</span>
            <b style="color: var(--acc)">81.5%</b>
            <small>仅 18.5% 买家提疑问转人工</small>
          </div>
          <div class="card mini-kpi">
            <span>站外引流 / 主动关单事故</span>
            <b style="color: var(--grn)">0 起</b>
            <small>守卫今日已自动拦阻 5 次</small>
          </div>
        </div>

        <!-- 坐席 14 项全维对比考核表 -->
        <section class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px">
            <div>
              <h3 style="font-size: 16px">外包坐席 14 项全维度实时对账表（红行代表跌破考核红线或触发反作弊预警）</h3>
              <span class="muted" style="font-size: 12px">
                区分「人工真回」与「50秒自动兜底」，挂机靠机器人撑回复率直接显形
              </span>
            </div>
          </div>

          <div class="tbl-wrap">
            <table class="kpi-table">
              <thead>
                <tr>
                  <th>坐席 / 班组</th>
                  <th>当前状态</th>
                  <th class="num-r">独立接待UV</th>
                  <th class="num-r">人工真回/总轮</th>
                  <th class="num-r">仅兜底未回</th>
                  <th class="num-r">首响(≤30s)</th>
                  <th class="num-r">平响(≤45s)</th>
                  <th class="num-r">3分钟回复率</th>
                  <th class="num-r">尾响闭环率</th>
                  <th class="num-r">实拍执行率</th>
                  <th class="num-r">询单转化率</th>
                  <th class="num-r">无效甩锅退回</th>
                  <th class="num-r">乱承诺倒扣</th>
                  <th class="num-r">小休时长</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="ag in kpi.agents"
                  :key="ag.id"
                  :class="{ 'bad-row': ag.threeMinRate < 95 || ag.autoFallbackOnly >= 5 }"
                >
                  <td>
                    <b>{{ ag.name }}</b>
                    <div class="muted" style="font-size: 11px">{{ ag.group }}</div>
                  </td>
                  <td>
                    <span class="tag" :class="ag.threeMinRate < 95 ? 'red' : 'grn'">{{ ag.onlineStatus }}</span>
                  </td>
                  <td class="num-r"><b>{{ ag.todayUv }}</b> 人</td>
                  <td class="num-r">{{ ag.manualReplied }} / {{ ag.totalSessions }}</td>
                  <td class="num-r">
                    <span :class="ag.autoFallbackOnly >= 5 ? 'tag red' : ''">{{ ag.autoFallbackOnly }}</span>
                  </td>
                  <td class="num-r">{{ ag.firstReplyMedianSec }}s</td>
                  <td class="num-r">{{ ag.avgReplySec }}s</td>
                  <td class="num-r">
                    <b :style="{ color: ag.threeMinRate < 95 ? 'var(--red)' : 'var(--grn)' }">
                      {{ ag.threeMinRate }}%
                    </b>
                  </td>
                  <td class="num-r">{{ ag.tailCloseRate }}%</td>
                  <td class="num-r"><span class="tag grn">{{ ag.realShotExecRate }}%</span></td>
                  <td class="num-r">{{ ag.inquiryConvRate }}%</td>
                  <td class="num-r">
                    <span :class="ag.invalidEscalations >= 3 ? 'tag red' : ''">{{ ag.invalidEscalations }} 次</span>
                  </td>
                  <td class="num-r">
                    <span :class="ag.promiseRefundPenalty > 0 ? 'tag red' : ''">{{ ag.promiseRefundPenalty }} 单</span>
                  </td>
                  <td class="num-r">{{ ag.breakMinutes }}m</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- 下半区：五平台达标矩阵 + 分时段负载柱状图 + 反作弊拦截雷达 -->
        <div class="bottom-two-grid">
          <section class="card">
            <h3 style="font-size: 15.5px; margin-bottom: 12px">五大电商平台分渠道 SLA 达标与自动推仓占比</h3>
            <div class="plat-rows">
              <div v-for="p in kpi.platformSummary" :key="p.k" class="plat-stat-row">
                <span class="plat-badge" :class="'plat-' + p.k">{{ p.name }}</span>
                <span>今日 <b>{{ p.sessions }}</b> 会话</span>
                <span>首响 <b>{{ p.firstSec }}</b></span>
                <span>3分钟率 <b style="color: var(--grn)">{{ p.threeMinRate }}</b></span>
                <span class="tag acc">静默自动发 {{ p.autoShipRate }}</span>
              </div>
            </div>

            <h3 style="font-size: 15px; margin: 18px 0 10px">分时段进线峰值与人工接起热力（排班依据）</h3>
            <div class="hour-bars">
              <div v-for="h in kpi.hourlyLoad" :key="h.h" class="hb-col">
                <div class="hb-track">
                  <div class="hb-fill" :style="{ height: Math.min(100, h.inCount * 2) + '%' }" />
                </div>
                <b>{{ h.inCount }}</b>
                <span>{{ h.h }}</span>
              </div>
            </div>
          </section>

          <section class="card">
            <h3 style="font-size: 15.5px; margin-bottom: 12px">🛡 KPI 五防 · 反作弊与风控实时审计流</h3>
            <div style="display: grid; gap: 10px">
              <div v-for="al in kpi.antiCheatAlerts" :key="al.id" class="ac-card" :class="al.level">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <b>{{ al.type }}</b>
                  <span class="tag" :class="al.level">对象：{{ al.agent }}</span>
                </div>
                <p style="font-size: 12.5px; margin-top: 4px">{{ al.detail }}</p>
              </div>
            </div>
          </section>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store, isSupervisor, showToast } from '../store.js';
import Icon from '../components/Icon.vue';
import Q from '../components/Q.vue';

const viewMode = ref(isSupervisor.value ? 'supervisor' : 'personal');

watch(isSupervisor, (v) => {
  viewMode.value = v ? 'supervisor' : 'personal';
});

const kpi = computed(() => store.data.kpi);

const myStats = computed(
  () => kpi.value.agents.find((a) => a.id === store.actorId) || kpi.value.agents[0],
);

const totalUv = computed(() => kpi.value.agents.reduce((s, a) => s + a.todayUv, 0));
const totalSessions = computed(() => kpi.value.agents.reduce((s, a) => s + a.totalSessions, 0));

const urgentConvs = computed(() =>
  store.data.conversations.filter((c) => c.priority === 'red' || c.autoRepliedOnly),
);

function goConv(id) {
  store.ui.selectedConvId = id;
  store.ui.route = 'chat';
}

function exportSettlementCsv() {
  const headers = [
    '坐席ID',
    '姓名',
    '班组',
    '今日接待UV',
    '总会话轮数',
    '人工真回轮数',
    '仅50s机器人兜底未回',
    '首响中位秒数',
    '平均响应秒数',
    '3分钟人工回复率(%)',
    '尾响闭环率(%)',
    '一件一拍实拍执行率(%)',
    '询单转化率(%)',
    '无效甩锅退回数',
    '乱承诺售后倒扣单',
    '小休分钟数',
    '当日预估绩效(元)',
  ];
  const rows = kpi.value.agents.map((a) => [
    a.id,
    a.name,
    a.group,
    a.todayUv,
    a.totalSessions,
    a.manualReplied,
    a.autoFallbackOnly,
    a.firstReplyMedianSec,
    a.avgReplySec,
    a.threeMinRate,
    a.tailCloseRate,
    a.realShotExecRate,
    a.inquiryConvRate,
    a.invalidEscalations,
    a.promiseRefundPenalty,
    a.breakMinutes,
    a.estimatedDailyBonus,
  ]);
  const csv = '\uFEFF' + [headers, ...rows].map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '泛亚外包客服SLA全维考核结算单_20261116.csv';
  link.click();
  URL.revokeObjectURL(url);
  showToast('已导出《泛亚外包客服SLA全维考核结算单_20261116.csv》');
}
</script>

<style scoped>
.kpi-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}
.seg-switch {
  display: inline-flex;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 3px;
}
.seg-switch button {
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 800;
  color: var(--mute);
}
.seg-switch button.on {
  background: var(--acc);
  color: #fff;
}

.personal-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.stat-big {
  display: grid;
  gap: 6px;
}
.stat-big.good {
  border-top: 4px solid var(--grn);
}
.stat-big.warn {
  border-top: 4px solid var(--red);
}
.sb-lbl {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--mute);
}
.sb-val {
  font-size: 32px;
  font-weight: 900;
}
.sb-val small {
  font-size: 14px;
  font-weight: 700;
}
.sb-sub {
  font-size: 12px;
  color: var(--ink2);
}

.rescue-list {
  display: grid;
  gap: 8px;
}
.rescue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 11px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
}
.bonus-card {
  padding: 16px;
  border-radius: 15px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
}

.sup-six-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}
.mini-kpi {
  padding: 14px 16px;
  display: grid;
  gap: 4px;
}
.mini-kpi span {
  font-size: 12px;
  color: var(--mute);
  font-weight: 700;
}
.mini-kpi b {
  font-size: 24px;
  font-weight: 900;
}
.mini-kpi small {
  font-size: 11.5px;
  color: var(--ink2);
}

.tbl-wrap {
  overflow-x: auto;
}
.kpi-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.kpi-table th,
.kpi-table td {
  padding: 10px 9px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  white-space: nowrap;
}
.kpi-table th {
  background: var(--panel-alt);
  color: var(--mute);
  font-weight: 800;
}
.kpi-table tr.bad-row {
  background: var(--red-soft);
}
.num-r {
  text-align: right !important;
}

.bottom-two-grid {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: 16px;
}
.plat-rows {
  display: grid;
  gap: 8px;
}
.plat-stat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  font-size: 12.5px;
}
.hour-bars {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 10px;
  height: 120px;
  align-items: end;
  padding-top: 10px;
}
.hb-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  height: 100%;
  font-size: 11px;
}
.hb-track {
  flex: 1;
  width: 24px;
  background: var(--soft);
  border-radius: 6px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}
.hb-fill {
  width: 100%;
  background: linear-gradient(180deg, #2952ff, #38bdf8);
  border-radius: 6px;
}

.ac-card {
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
}
.ac-card.red {
  border-left: 4px solid var(--red);
}
.ac-card.amb {
  border-left: 4px solid var(--amb);
}
.ac-card.grn {
  border-left: 4px solid var(--grn);
}
</style>
