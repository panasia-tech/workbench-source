<template>
  <!-- ==================== 抽屉 1：14 项全维考核与反作弊大盘 ==================== -->
  <div
    v-if="store.ui.kpiDrawerOpen"
    class="drawer-backdrop"
    role="dialog"
    aria-modal="true"
    @click.self="store.ui.kpiDrawerOpen = false"
  >
    <div class="wide-drawer">
      <header class="wd-head">
        <div>
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="tag acc">对标千牛 · 拼多多 · 京麦 · 飞鸽</span>
            <Q k="kpi" label="五防口径说明" />
          </div>
          <h2>📊 客服全维绩效考核与反作弊大盘</h2>
        </div>
        <div style="display: flex; align-items: center; gap: 8px">
          <button type="button" class="btn sm soft" @click="exportKpiCsv">
            <Icon name="download" size="14" /> 导出 CSV 结算单
          </button>
          <button type="button" class="btn sm" @click="store.ui.kpiDrawerOpen = false">
            <Icon name="close" size="15" /> 收起
          </button>
        </div>
      </header>

      <div class="wd-body">
        <!-- 个人直观激励战绩卡（清爽 C 端） -->
        <section class="kpi-hero-grid">
          <div class="kh-card">
            <span>今日接待人数 (UV)</span>
            <b>{{ myKpi.todayUv }}<small>人</small></b>
            <em>在岗 {{ myKpi.onlineHours }}h · 小休 {{ myKpi.breakMinutes }}m</em>
          </div>
          <div class="kh-card">
            <span>首响中位数（目标 ≤30s）</span>
            <b class="good">{{ myKpi.firstReplyMedianSec }}<small>秒</small></b>
            <em>30秒首响率 {{ myKpi.thirtySecRate }}%</em>
          </div>
          <div class="kh-card">
            <span>3分钟人工回复率（≥96%）</span>
            <b :class="myKpi.threeMinRate >= 96 ? 'good' : 'bad'">{{ myKpi.threeMinRate }}<small>%</small></b>
            <em>人工真回 {{ myKpi.manualReplied }} / 剔除机器人兜底 {{ myKpi.autoFallbackOnly }}</em>
          </div>
          <div class="kh-card">
            <span>发货前实拍执行率</span>
            <b class="good">{{ myKpi.realShotExecRate }}<small>%</small></b>
            <em>保修已激活 {{ myKpi.warrantyActiveCount }} 单</em>
          </div>
          <div class="kh-card">
            <span>尾响闭环率 / 满意度</span>
            <b>{{ myKpi.tailCloseRate }}<small>%</small></b>
            <em>好评满意度 {{ myKpi.satisfactionRate }}% · 预估日奖 ¥{{ myKpi.estimatedDailyBonus }}</em>
          </div>
        </section>

        <!-- 折叠或主管默认展开：全团 14 项指标横向对比表 + 反作弊雷达 -->
        <FoldBox
          title="📋 全团坐席 14 项硬核指标对比表（含人工真回 vs 50s机器人兜底拆分）"
          chip="主管结算台账"
          chip-tone="pri"
          :default-open="isInternalOrSupervisor"
        >
          <div class="table-scroll">
            <table class="kpi-table">
              <thead>
                <tr>
                  <th>坐席 / 班组</th>
                  <th>状态</th>
                  <th>接待UV</th>
                  <th>人工真回 / 50s兜底</th>
                  <th>首响中位</th>
                  <th>平均回复</th>
                  <th>3分钟回复率</th>
                  <th>30秒首响率</th>
                  <th>尾响闭环率</th>
                  <th>实拍执行率</th>
                  <th>保修激活</th>
                  <th>询单转化</th>
                  <th>无效甩锅</th>
                  <th>乱承诺倒扣</th>
                  <th>满意度</th>
                  <th>预估绩效</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="ag in store.data.kpi.agents" :key="ag.id" :class="{ warnrow: ag.threeMinRate < 96 }">
                  <td>
                    <b>{{ ag.name }}</b>
                    <div style="font-size: 11px; color: var(--mute)">{{ ag.group }}</div>
                  </td>
                  <td>{{ ag.onlineStatus }}</td>
                  <td>{{ ag.todayUv }}</td>
                  <td>
                    <b>{{ ag.manualReplied }}</b> /
                    <span :style="{ color: ag.autoFallbackOnly > 3 ? 'var(--red)' : 'var(--mute)' }">
                      {{ ag.autoFallbackOnly }}兜底
                    </span>
                  </td>
                  <td>{{ ag.firstReplyMedianSec }}s</td>
                  <td>{{ ag.avgReplySec }}s</td>
                  <td :class="ag.threeMinRate >= 96 ? 'good-cell' : 'bad-cell'">{{ ag.threeMinRate }}%</td>
                  <td>{{ ag.thirtySecRate }}%</td>
                  <td>{{ ag.tailCloseRate }}%</td>
                  <td class="good-cell">{{ ag.realShotExecRate }}%</td>
                  <td>{{ ag.warrantyActiveCount }}单</td>
                  <td>{{ ag.inquiryConvRate }}%</td>
                  <td :class="ag.invalidEscalations > 1 ? 'bad-cell' : ''">{{ ag.invalidEscalations }}次</td>
                  <td :class="ag.promiseRefundPenalty > 0 ? 'bad-cell' : ''">{{ ag.promiseRefundPenalty }}次</td>
                  <td>{{ ag.satisfactionRate }}%</td>
                  <td><b>¥{{ ag.estimatedDailyBonus }}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="quiet-note">
            🌙 <b>考核人性化豁免口径：</b>{{ store.data.kpi.config.quietHours }}；因群控设备 30s 节流排队按客服点击发送时刻计入，绝不让坐席背系统延迟锅。
          </div>
        </FoldBox>

        <!-- 折叠：反作弊预警雷达 + 5大平台汇总 + 分时段会话负荷 -->
        <FoldBox
          title="🛡️ 反作弊预警雷达 · 五大平台 SLA 拆解 · 分时段负荷"
          chip="KPI五防落地"
          :default-open="true"
        >
          <div class="two-col-sub">
            <div class="sub-box">
              <h4>🚨 今日反作弊实时拦截与预警</h4>
              <div
                v-for="ac in store.data.kpi.antiCheatAlerts"
                :key="ac.id"
                class="ac-item"
                :class="ac.level"
              >
                <div>
                  <b>{{ ac.agent }} · {{ ac.type }}</b>
                </div>
                <p>{{ ac.detail }}</p>
              </div>
            </div>

            <div class="sub-box">
              <h4>🏪 五大平台多店铺接待矩阵（共 24 店）</h4>
              <div class="plat-mini-table">
                <div v-for="p in store.data.kpi.platformSummary" :key="p.k" class="pm-row">
                  <span class="plat" :class="'plat-' + p.k">{{ p.name }}</span>
                  <span>会话 <b>{{ p.sessions }}</b></span>
                  <span>首响 <b>{{ p.firstSec }}</b></span>
                  <span>3分率 <b style="color: var(--grn-ink)">{{ p.threeMinRate }}</b></span>
                  <span>自动发货 <b>{{ p.autoShipRate }}</b></span>
                </div>
              </div>

              <h4 style="margin-top: 10px">📈 今日分时段进线量分布</h4>
              <div class="hour-bars">
                <div v-for="hb in store.data.kpi.hourlyLoad" :key="hb.h" class="hb-col">
                  <div class="hb-track">
                    <div class="hb-fill" :style="{ height: Math.round((hb.inCount / 52) * 100) + '%' }" />
                  </div>
                  <b>{{ hb.inCount }}</b>
                  <span>{{ hb.h }}</span>
                </div>
              </div>
            </div>
          </div>
        </FoldBox>
      </div>
    </div>
  </div>

  <!-- ==================== 抽屉 2：静默自动发货与疑问熔断监控池（4列看板） ==================== -->
  <div
    v-if="store.ui.autoShipDrawerOpen"
    class="drawer-backdrop"
    role="dialog"
    aria-modal="true"
    @click.self="store.ui.autoShipDrawerOpen = false"
  >
    <div class="wide-drawer">
      <header class="wd-head">
        <div>
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="tag grn">发完实拍自动推仓 · 客人发问毫秒级停发</span>
            <Q k="autoship" label="自动发货机制" />
          </div>
          <h2>📦 自动发货与异常熔断监控池</h2>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <label class="win-select">
            静默观察窗：
            <select v-model.number="store.data.kpi.config.autoShipWindowMin">
              <option :value="15">15 分钟</option>
              <option :value="30">30 分钟（推荐）</option>
              <option :value="60">60 分钟</option>
            </select>
          </label>
          <button type="button" class="btn sm" @click="store.ui.autoShipDrawerOpen = false">
            <Icon name="close" size="15" /> 收起
          </button>
        </div>
      </header>

      <div class="wd-body">
        <div class="kanban-grid">
          <!-- 列 1 -->
          <div class="kb-col">
            <div class="kb-head">
              <b>① 待挑货发实拍</b>
              <span class="tag">{{ autoShipLanes.waitPick.length }}</span>
            </div>
            <div v-for="c in autoShipLanes.waitPick" :key="c.id" class="kb-card">
              <div class="kbc-top">
                <span class="plat" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
              </div>
              <div class="kbc-meta">{{ c.orderNo }} · ¥{{ c.paidAmount }}</div>
              <div class="kbc-badge warn">{{ c.statusBadge }}</div>
              <button type="button" class="btn sm pri full" @click="jumpToConv(c)">
                去挑真机发实拍 ›
              </button>
            </div>
          </div>

          <!-- 列 2 -->
          <div class="kb-col">
            <div class="kb-head">
              <b>② 等回“同意”·静默倒计时</b>
              <span class="tag acc">{{ autoShipLanes.counting.length }}</span>
            </div>
            <div v-for="c in autoShipLanes.counting" :key="c.id" class="kb-card">
              <div class="kbc-top">
                <span class="plat" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
              </div>
              <div class="kbc-meta">货号 {{ c.skuCode }} · 倒计时 <b>{{ formatSec(c.autoShipRemainSec) }}</b></div>
              <div style="display: grid; gap: 5px; margin-top: 4px">
                <button type="button" class="btn sm grn full" @click="simulateBuyerMessage(c.id, '同意，安排发货吧')">
                  模拟回“同意”激活推仓
                </button>
                <button type="button" class="btn sm full" @click="pushOrderToWmsWave(c.id, 'silent_timeout')">
                  模拟静默期满自动推仓
                </button>
                <button type="button" class="btn sm amb full" @click="simulateBuyerMessage(c.id, '等下，先确认下成色细节')">
                  模拟买家发问瞬间熔断
                </button>
              </div>
            </div>
          </div>

          <!-- 列 3 -->
          <div class="kb-col">
            <div class="kb-head">
              <b>③ 疑问熔断·待人工介入</b>
              <span class="tag red">{{ autoShipLanes.paused.length }}</span>
            </div>
            <div v-for="c in autoShipLanes.paused" :key="c.id" class="kb-card warn">
              <div class="kbc-top">
                <span class="plat" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
              </div>
              <div class="kbc-meta">{{ c.issueReason || c.statusBadge }}</div>
              <div style="display: flex; gap: 6px">
                <button type="button" class="btn sm pri" style="flex: 1" @click="jumpToConv(c)">
                  去处理 ›
                </button>
                <button type="button" class="btn sm grn" @click="pushOrderToWmsWave(c.id, 'manual_resume')">
                  恢复推仓
                </button>
              </div>
            </div>
          </div>

          <!-- 列 4 -->
          <div class="kb-col">
            <div class="kb-head">
              <b>④ 已推入仓管波次 / 409急停</b>
              <span class="tag grn">{{ autoShipLanes.pushed.length }}</span>
            </div>
            <div v-for="c in autoShipLanes.pushed" :key="c.id" class="kb-card ok">
              <div class="kbc-top">
                <span class="plat" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
              </div>
              <div class="kbc-meta">{{ c.wmsWaveNo || '已推入顺丰打单波次' }}</div>
              <div style="display: flex; gap: 6px">
                <button type="button" class="btn sm" style="flex: 1" @click="jumpToConv(c)">查看会话</button>
                <button
                  v-if="c.stepState !== 'INTERCEPTED_409'"
                  type="button"
                  class="btn sm red"
                  @click="triggerEmergencyWmsIntercept(c.id)"
                >
                  🛑 409拦截
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ==================== 抽屉 3：分场景自动发图规则中心 ==================== -->
  <div
    v-if="store.ui.autoRuleModalOpen"
    class="drawer-backdrop"
    role="dialog"
    aria-modal="true"
    @click.self="store.ui.autoRuleModalOpen = false"
  >
    <div class="wide-drawer" style="max-width: 920px">
      <header class="wd-head">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <span class="tag acc">分场景自动触发 · 解放人工重复发图</span>
            <Q k="auto_rules" label="自动发图说明" />
          </div>
          <h2>🖼 场景自动发图规则配置（保修富阳管辖卡 + 退款3步UI图）</h2>
        </div>
        <button type="button" class="btn sm" @click="store.ui.autoRuleModalOpen = false">
          <Icon name="close" size="15" /> 收起
        </button>
      </header>

      <div class="wd-body">
        <div v-for="r in store.data.autoRules" :key="r.id" class="rule-card">
          <div class="rc-preview" @click="zoomImg(r.imageUrl, r.sceneName)">
            <img :src="r.imageUrl" :alt="r.sceneName" />
            <span>🔍 点击放大查看高清原图</span>
          </div>

          <div class="rc-info">
            <div class="rci-top">
              <div>
                <h3>{{ r.sceneName }}</h3>
                <p class="rci-desc">{{ r.triggerDesc }}</p>
              </div>
              <label class="switch-pill" :class="{ on: r.enabled }">
                <input v-model="r.enabled" type="checkbox" />
                <span>{{ r.enabled ? '● 自动触发开启中' : '○ 已停用' }}</span>
              </label>
            </div>

            <div v-if="r.replyKeyword" class="kw-badge">
              🔑 自动识别买家回复关键词：<b>「{{ r.replyKeyword }}」</b> → 自动激活店铺质保并生效杭州市富阳区人民法院管辖条款
            </div>

            <label class="field-lbl">随图自动发送话术（可直接修改）：</label>
            <textarea v-model="r.accompanyText" rows="2" class="rule-ta" />

            <div style="display: flex; justify-content: flex-end; gap: 8px">
              <button type="button" class="btn sm soft" @click="sendToCurrentChat(r.id)">
                📤 手动发到当前会话测试
              </button>
            </div>
          </div>
        </div>

        <!-- 折叠：新增自定义场景自动发图规则 -->
        <FoldBox title="➕ 新增自定义场景自动发图规则（支持本地上传图片）" chip="可扩展">
          <div class="new-rule-form">
            <div class="nrf-row">
              <input v-model="newSceneName" type="text" placeholder="场景名称（如：签收后好评晒图返现卡 / 顺丰保价说明图）" />
              <input v-model="newTriggerDesc" type="text" placeholder="触发时机说明（如：物流显示已签收 10 分钟后自动发送）" />
            </div>
            <textarea v-model="newAccompanyText" rows="2" placeholder="随图配套发送给买家的话术..." />
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px">
              <label class="btn sm">
                📁 选择本地图片上传
                <input type="file" accept="image/*" style="display: none" @change="onUploadFile" />
              </label>
              <span v-if="uploadedDataUrl" class="tag grn">✓ 已载入本地图片预览</span>
              <button type="button" class="btn sm pri" @click="submitNewRule">✓ 保存新增场景规则</button>
            </div>
          </div>
        </FoldBox>
      </div>
    </div>
  </div>

  <!-- ==================== 抽屉 4：新人 3 关练兵 · 外包边界红线 · SQLite 审计流水 ==================== -->
  <div
    v-if="store.ui.manualDrawerOpen"
    class="drawer-backdrop"
    role="dialog"
    aria-modal="true"
    @click.self="store.ui.manualDrawerOpen = false"
  >
    <div class="wide-drawer" style="max-width: 940px">
      <header class="wd-head">
        <div>
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="tag amb">零培训上岗 · 防呆防泄密</span>
            <Q k="learn" label="练兵说明" />
          </div>
          <h2>📖 新人 3 关演练沙盒 · 职责红线 · 审计日志</h2>
        </div>
        <button type="button" class="btn sm" @click="store.ui.manualDrawerOpen = false">
          <Icon name="close" size="15" /> 收起
        </button>
      </header>

      <div class="wd-body">
        <!-- 1. 新人上岗 3 关防踩坑情景练习 -->
        <section class="sub-box">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px">
            <h4>🎓 首日新人 3 关防踩坑沙盒（当前角色已通关 {{ practiceStatus.passedCount }} / 3 关）</h4>
            <button type="button" class="btn sm" @click="resetPracticeForCurrentActor">重置练习进度</button>
          </div>
          <div class="prac-cards">
            <div v-for="p in PRACTICES" :key="p.key" class="pc-item">
              <div style="display: flex; justify-content: space-between; align-items: center">
                <span class="tag" :class="practiceStatus.map[p.key] ? 'grn' : 'amb'">
                  {{ practiceStatus.map[p.key] ? '✓ 已通关' : `第 ${p.stepNo} 关待练` }}
                </span>
              </div>
              <b>{{ p.title }}</b>
              <button type="button" class="btn sm soft full" @click="openPracticeKey(p.key)">
                {{ practiceStatus.map[p.key] ? '重温本关情景 ›' : '▶ 开始 60 秒情景通关 ›' }}
              </button>
            </div>
          </div>
        </section>

        <!-- 2. 外包极窄职责边界：三做 / 六不做 / 四盲区脱敏 -->
        <div class="boundary-grid">
          <div class="bd-card ok">
            <h4>✅ 外包客服只做这 3 件事</h4>
            <ul>
              <li>30 秒极速礼貌响应买家售前尺码/参数/顺丰发货时效咨询；</li>
              <li>从右侧 WMS 挑绿灯真机，100% 发出本机实拍照片+视频+保修激活卡；</li>
              <li>退款第一时间引导买家按手机 UI 图选「不想要了/协商一致」秒退。</li>
            </ul>
          </div>
          <div class="bd-card bad">
            <h4>🚫 绝对严禁的 6 条高压红线</h4>
            <ul>
              <li>严禁发送微信号/手机号/外部网盘链接（外发守卫实时硬拦截）；</li>
              <li>严禁主动点「关闭买家订单」（防闲鱼鱼力值暴跌至 165 限流）；</li>
              <li>严禁拿网图或别台图顶替本机一件一拍；严禁超权限乱答应降价赠品。</li>
            </ul>
          </div>
          <div class="bd-card pri">
            <h4>🛡️ 系统物理屏蔽的 4 大盲区</h4>
            <ul>
              <li>采购进价 <code>costPrice</code> 与上游卖家昵称服务端 RBAC 物理剥离；</li>
              <li>仓管货架库位照与收货议价单自动过滤不进客服端；</li>
              <li>未过售前四关（缺通电视频）的在库机器自动灰置锁死禁选。</li>
            </ul>
          </div>
        </div>

        <!-- 3. 折叠：SQLite 不可篡改审计流水 -->
        <FoldBox title="📜 实时操作与风控拦截审计流水（SQLite WAL 落盘留痕）" :chip="`共 ${store.auditLogs.length} 条`" :default-open="true">
          <div class="audit-list">
            <div v-for="lg in store.auditLogs.slice(0, 18)" :key="lg.seq" class="al-row">
              <code>#{{ lg.seq }}</code>
              <span class="al-time">{{ lg.createdAt }}</span>
              <span class="tag">{{ lg.actor }}</span>
              <b>{{ lg.action }}</b>
              <span class="al-sum">{{ lg.summary }}</span>
            </div>
          </div>
        </FoldBox>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import {
  store,
  activeAgentKpi as myKpi,
  isInternalOrSupervisor,
  autoShipLanes,
  practiceStatus,
  formatSec,
  sendRuleCardImage,
  simulateBuyerMessage,
  pushOrderToWmsWave,
  triggerEmergencyWmsIntercept,
  addCustomAutoRule,
  exportKpiCsv,
  resetPracticeForCurrentActor,
  showToast,
} from '../store.js';
import { makeSignRemindCardSvg } from '../data/autoCardsSvg.js';
import { PRACTICES } from '../data/helpAndRules.js';
import FoldBox from './FoldBox.vue';
import Icon from './Icon.vue';
import Q from './Q.vue';

const newSceneName = ref('');
const newTriggerDesc = ref('');
const newAccompanyText = ref('');
const uploadedDataUrl = ref('');

function zoomImg(url, title) {
  store.ui.photoPreviewUrl = url;
  store.ui.photoPreviewTitle = title;
}

function jumpToConv(c) {
  store.ui.activeTab = c.category;
  store.ui.selectedConvId = c.id;
  store.ui.autoShipDrawerOpen = false;
}

async function sendToCurrentChat(ruleId) {
  if (!store.ui.selectedConvId) return;
  await sendRuleCardImage(store.ui.selectedConvId, ruleId, false);
  store.ui.autoRuleModalOpen = false;
  showToast('🖼 已将该场景图片发入当前聊天窗！');
}

function onUploadFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    uploadedDataUrl.value = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitNewRule() {
  if (!newSceneName.value.trim()) {
    showToast('请填写新场景名称');
    return;
  }
  await addCustomAutoRule({
    sceneName: newSceneName.value.trim(),
    triggerDesc: newTriggerDesc.value.trim() || '按自定义条件自动触发发送',
    accompanyText: newAccompanyText.value.trim() || '亲，请查收本单温馨提示卡～',
    imageUrl: uploadedDataUrl.value || makeSignRemindCardSvg(),
  });
  newSceneName.value = '';
  newTriggerDesc.value = '';
  newAccompanyText.value = '';
  uploadedDataUrl.value = '';
}

function openPracticeKey(key) {
  store.ui.manualDrawerOpen = false;
  store.ui.practiceOpenKey = key;
}
</script>

<style scoped>
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 92;
  background: rgba(15, 23, 42, 0.52);
  display: flex;
  justify-content: flex-end;
}

.wide-drawer {
  width: min(1120px, 92vw);
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: var(--sh-pop);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.wd-head {
  padding: 15px 22px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.wd-head h2 {
  font-size: 17.5px;
  margin-top: 4px;
}

.wd-body {
  overflow-y: auto;
  padding: 18px 22px;
  display: grid;
  gap: 14px;
  align-content: start;
}

/* KPI 顶部5卡 */
.kpi-hero-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}
.kh-card {
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  display: grid;
  gap: 4px;
}
.kh-card span {
  font-size: 12px;
  color: var(--mute);
  font-weight: 600;
}
.kh-card b {
  font-size: 22px;
  font-weight: 800;
}
.kh-card b small {
  font-size: 12px;
  margin-left: 2px;
  font-weight: 700;
}
.kh-card b.good {
  color: var(--grn-ink);
}
.kh-card b.bad {
  color: var(--red-ink);
}
.kh-card em {
  font-style: normal;
  font-size: 11.5px;
  color: var(--ink2);
}

.table-scroll {
  overflow-x: auto;
}
.kpi-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}
.kpi-table th,
.kpi-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
}
.kpi-table th {
  background: var(--panel-alt);
  color: var(--mute);
  font-weight: 700;
}
.kpi-table tr.warnrow {
  background: rgba(245, 63, 63, 0.05);
}
.good-cell {
  color: var(--grn-ink);
  font-weight: 800;
}
.bad-cell {
  color: var(--red-ink);
  font-weight: 800;
}
.quiet-note {
  font-size: 12px;
  color: var(--ink2);
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--pri-soft);
}

.two-col-sub {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 12px;
}
.sub-box {
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  display: grid;
  gap: 8px;
  align-content: start;
}
.sub-box h4 {
  font-size: 13.5px;
  font-weight: 800;
}
.ac-item {
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.45;
}
.ac-item p {
  margin-top: 3px;
  opacity: 0.9;
}
.ac-item.red {
  background: var(--red-soft);
  color: var(--red-ink);
}
.ac-item.amb {
  background: var(--amb-soft);
  color: var(--amb-ink);
}
.ac-item.grn {
  background: var(--grn-soft);
  color: var(--grn-ink);
}

.plat-mini-table {
  display: grid;
  gap: 6px;
}
.pm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 9px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 12px;
}

.hour-bars {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 8px;
  padding-top: 4px;
}
.hb-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 11px;
}
.hb-track {
  width: 18px;
  height: 58px;
  border-radius: 6px;
  background: var(--soft);
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}
.hb-fill {
  width: 100%;
  background: var(--pri);
  border-radius: 6px 6px 0 0;
}
.hb-col span {
  color: var(--mute);
}

/* 自动发货看板 */
.win-select {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink2);
}
.win-select select {
  height: 30px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
}
.kanban-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
.kb-col {
  background: var(--panel-alt);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 11px;
  display: grid;
  gap: 9px;
}
.kb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}
.kb-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.kb-card.warn {
  border-color: rgba(245, 63, 63, 0.35);
}
.kb-card.ok {
  border-color: rgba(0, 180, 42, 0.3);
}
.kbc-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kbc-meta {
  color: var(--ink2);
  line-height: 1.4;
}
.kbc-badge.warn {
  color: var(--red-ink);
  font-weight: 700;
}

/* 场景自动发图规则卡 */
.rule-card {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
  padding: 14px;
  border-radius: 13px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
}
.rc-preview {
  cursor: pointer;
  display: grid;
  gap: 5px;
  text-align: center;
}
.rc-preview img {
  width: 100%;
  height: 152px;
  object-fit: cover;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel);
}
.rc-preview span {
  font-size: 11.5px;
  color: var(--pri);
  font-weight: 600;
}
.rc-info {
  display: grid;
  gap: 8px;
  align-content: start;
}
.rci-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.rci-top h3 {
  font-size: 15px;
}
.rci-desc {
  font-size: 12px;
  color: var(--ink2);
  margin-top: 2px;
}
.switch-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 999px;
  background: var(--soft);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.switch-pill input {
  display: none;
}
.switch-pill.on {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.kw-badge {
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--pri-soft);
  color: var(--pri);
  font-size: 12px;
}
.field-lbl {
  font-size: 12px;
  font-weight: 700;
  color: var(--mute);
}
.rule-ta {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: 12.5px;
  resize: vertical;
}

.new-rule-form {
  display: grid;
  gap: 8px;
}
.nrf-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.nrf-row input,
.new-rule-form textarea {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: 12.5px;
}

/* 手册与审计 */
.prac-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.pc-item {
  padding: 11px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  display: grid;
  gap: 8px;
  font-size: 12.5px;
}
.boundary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.bd-card {
  padding: 12px 14px;
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.55;
}
.bd-card h4 {
  font-size: 13.5px;
  margin-bottom: 6px;
}
.bd-card ul {
  margin: 0;
  padding-left: 17px;
  display: grid;
  gap: 4px;
}
.bd-card.ok {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.bd-card.bad {
  background: var(--red-soft);
  color: var(--red-ink);
}
.bd-card.pri {
  background: var(--pri-soft);
  color: var(--pri);
}

.audit-list {
  display: grid;
  gap: 5px;
  max-height: 250px;
  overflow-y: auto;
}
.al-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 7px;
  background: var(--panel-alt);
  font-size: 12px;
}
.al-time {
  font-family: monospace;
  color: var(--mute);
}
.al-sum {
  color: var(--ink2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
