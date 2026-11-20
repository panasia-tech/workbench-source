<template>
  <aside v-if="conv" class="pane-col right-copilot">
    <div class="rc-scroll scroll-y">
      <!-- 0. 内部销售刚发来的「幕后回复锦囊」（置顶高亮，买家不可见） -->
      <div v-if="conv.internalNotes?.length" class="coach-note-card">
        <div class="cn-title">💡 内部销售发来回复锦囊（照着回买家即可）：</div>
        <div v-for="(n, idx) in conv.internalNotes" :key="idx" class="cn-item">
          <b>{{ n.by }} ({{ n.time }})：</b>{{ n.text }}
        </div>
      </div>

      <!-- 1. 右上核心灵魂：【🧭 当前步骤与前置动作向导小卡片】 -->
      <section class="step-guide-card" :class="stepCardTone" data-tour="right-stepper">
        <div class="sg-top">
          <div style="display: flex; align-items: center; gap: 6px">
            <span class="sg-eyebrow">🧭 当前进度与必做动作</span>
            <span v-if="conv.orderNo" class="tag">{{ conv.orderNo }}</span>
          </div>
          <Q k="copilot_card" label="规则" />
        </div>

        <!-- 4 节点可视化轨迹条 -->
        <div class="mini-track">
          <div
            v-for="(nd, i) in trackNodes"
            :key="i"
            class="mt-node"
            :class="nd.state"
          >
            <span class="mt-dot">{{ nd.state === 'done' ? '✓' : nd.state === 'err' ? '!' : i + 1 }}</span>
            <span class="mt-lbl">{{ nd.label }}</span>
          </div>
        </div>

        <!-- 分状态渲染唯一傻瓜式行动指引 -->
        <!-- 状态 A：链接对不上 WMS 货号 -->
        <div v-if="conv.workflowStep === 'LINK_ANOMALY_BLOCKED'" class="sg-body">
          <h4>🛑 卡在第 1 步：商品链接未对上 WMS 库存真机！</h4>
          <p>商品登记簿查不到这个链接对应的仓库货号。<b>严禁口头瞎答“有货”</b>，请一键呼叫内部销售核对绑定。</p>
          <button
            v-if="!conv.collabTicket"
            type="button"
            class="btn bad block"
            @click="escalate('LINK_FIX', '商品链接未挂接 WMS 货号，请销售核对绑定')"
          >
            🆘 一键呼叫内部销售绑定货号（60s响应）
          </button>
          <div v-else class="collab-wait-box">
            <span>📡 已推送 {{ conv.collabTicket.assignee }}（工单 {{ conv.collabTicket.id }} · 60s倒计时中）</span>
          </div>
          <button type="button" class="btn sm soft-acc block" @click="simSalesBindLink">
            ⚡ [演示闭环] 模拟内部销售陈小满 30s 绑好货号 ›
          </button>
        </div>

        <!-- 状态 B：链接对上了货，但仓管缺通电实拍视频 -->
        <div v-else-if="conv.workflowStep === 'WMS_MEDIA_MISSING'" class="sg-body">
          <h4>📸 卡在第 1 步：本机缺仓管高拍仪「通电实拍视频」！</h4>
          <p>二手商品<b>严禁拿网图或别台视频冒充</b>！该机器在库但售前关卡②（通电视频）未就绪，请点按钮催仓管现场补录。</p>
          <button
            v-if="!conv.collabTicket"
            type="button"
            class="btn bad block"
            @click="escalate('RUSH_VIDEO', `买家等看实拍，请仓管紧急补录货号 ${conv.boundSkuCode} 通电实拍视频`)"
          >
            ⚡ 一键催仓管 60 秒补拍实拍视频
          </button>
          <div v-else class="collab-wait-box">
            <span>📡 仓管工作台(5351)已弹窗响铃（{{ conv.collabTicket.id }} · 60s未接自动升主管）</span>
          </div>
          <button type="button" class="btn sm soft-acc block" @click="simWarehouseVideo">
            🎬 [演示闭环] 模拟仓管林庆国已补传 16s 高拍仪视频 ›
          </button>
        </div>

        <!-- 状态 C：买家已付款，通卖链接待从 WMS 挑 1 台单品 -->
        <div v-else-if="conv.workflowStep === 'PAID_WAIT_PICK_SKU'" class="sg-body">
          <h4>🔴 发货前置必做（第 2/4 步）：请从下方挑选 1 台 WMS 真机！</h4>
          <p>
            买家已实付 <b>¥{{ conv.paidAmount }}</b>。本链接同款在库有多台不同成色单品，请在下方面板点选 1 台<b>「四关全绿」</b>真机锁入本单，并一键发出实拍视频与照片！
          </p>
          <Lock
            :ok="canPickSelectedSku.ok"
            :reason="canPickSelectedSku.reason"
            :penalty="canPickSelectedSku.penalty"
            :fix-text="!practiceProgress.unlocked ? '去2分钟练兵解锁' : ''"
            block
            kind="pri"
            @go="doPickAndSend"
            @fix="openPractice"
          >
            🔒 锁入【{{ activeSku?.skuCode || '请先选货' }}】+ 发实拍照片&视频 + 开启自动发货
          </Lock>
        </div>

        <!-- 状态 D：自动发货静默观察倒计时中（理想省心状态！） -->
        <div v-else-if="conv.workflowStep === 'AUTO_OBSERVING'" class="sg-body">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <h4>⏱ 第 4/4 步：实拍已发出 · 静默自动发货观察中</h4>
            <span class="countdown-pill">{{ formatRemain(conv.autoShipRemainSec) }}</span>
          </div>
          <p>
            已锁定真机 <b>{{ conv.boundSkuCode }}</b> 并发出全套实拍照片+视频。<b>无需苦等买家回复“确认”</b>——倒计时归零无异议将全自动推入仓库波次打顺丰单；若买家开口提问，系统将毫秒级暂停发货转人工！
          </p>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 7px">
            <button type="button" class="btn sm amb" @click="simBuyerBreak">
              💬 模拟买家提问触发熔断
            </button>
            <button type="button" class="btn sm grn" @click="doAutoPushTimer">
              🚀 模拟倒计时归零自动推仓
            </button>
          </div>
        </div>

        <!-- 状态 E：买家在自动发货观察期发来疑问 -> 已毫秒级熔断暂停推仓，人工介入！ -->
        <div v-else-if="conv.workflowStep === 'AUTO_PAUSED_BY_BUYER'" class="sg-body">
          <h4>⚡ 自动发货已熔断暂停：客人对实拍有疑问，请人工介入！</h4>
          <p class="pause-reason">{{ conv.autoShipPausedReason }}</p>
          <div style="display: grid; gap: 7px">
            <Lock
              :ok="practiceProgress.unlocked"
              reason="新员工需先完成 3 个防踩坑练习才可放行真实发货单"
              fix-text="去练兵解锁"
              block
              kind="grn"
              @go="doManualResumePush"
              @fix="openPractice"
            >
              ✓ 疑问已解答且买家无异议 · 恢复推入仓库发货
            </Lock>
            <button
              v-if="activeSku && activeSku.skuCode !== conv.boundSkuCode && isSkuSelectable(activeSku)"
              type="button"
              class="btn pri block"
              @click="doPickAndSend"
            >
              ⇄ 换绑下方选中的【{{ activeSku.skuCode }} · {{ activeSku.grade }}】并重发实拍
            </button>
            <div v-else class="swap-hint">
              💡 若买家想换同款无划痕机器：直接在下方点选 <b>99新（990001540233-B）</b> 即可一键换绑重发实拍！
            </div>
          </div>
        </div>

        <!-- 状态 F：已推入仓管 WMS 波次拣货中（支持紧急改址/退单 409 红屏拦截） -->
        <div v-else-if="conv.workflowStep === 'PUSHED_TO_WMS_WAVE'" class="sg-body">
          <h4>🏃 已自动推入仓管波次：{{ conv.wmsWaveNo }}</h4>
          <p>
            仓库正在按最短路径拣货并进行激光四码（主机+附件袋+原盒+SN）复核。<b>如买家突然要求改地址或退单，立即点下方红钮锁死打包台面单！</b>
          </p>
          <button type="button" class="btn bad block" @click="doEmergencyIntercept">
            🛑 紧急拦截仓库发货（触发打包台 409 红屏三连蜂鸣锁死）
          </button>
        </div>

        <!-- 状态 G：已触发 409 红屏拦截 -->
        <div v-else-if="conv.workflowStep === 'WMS_409_INTERCEPTED'" class="sg-body">
          <h4>🛑 已成功锁死打包台电子面单（409 红屏阻断生效中）</h4>
          <p>仓管工作台已生成【双扫码退回原货架单】。等买家在平台改好新地址或完成退款后，仓库将自动销账释放库存。</p>
        </div>

        <!-- 状态 H：内部销售已抢锁接管会话 -->
        <div v-else-if="conv.workflowStep === 'INTERNAL_TAKEN_OVER'" class="sg-body">
          <h4>🔒 内部专员已接管本会话：{{ conv.owner.name }}</h4>
          <p>为防止外包与内部专员同时回复买家造成前后矛盾，外包发送框已自动锁定。处理完毕交还后将置顶显示承诺事项。</p>
          <button
            v-if="isOutsourceRole"
            type="button"
            class="btn sm soft-acc block"
            @click="switchToInternalChen"
          >
            👤 切换为【陈小满（内部销售）】视角体验写锦囊与交还 ›
          </button>
        </div>

        <!-- 状态 I：常规售前咨询就绪（四关全绿，一键发实拍促单） -->
        <div v-else class="sg-body">
          <h4>🟢 售前货况就绪：本机四关全绿，发实拍视频促单！</h4>
          <p>
            一口价 <b>¥{{ activeSku?.price || '—' }}</b>（外包最大可申请优惠券让利
            <b>¥{{ store.data.kpi.config.maxOutsourceDiscount }}</b>，再低请点下方转内部销售）。
          </p>
          <Lock
            :ok="practiceProgress.unlocked && Boolean(activeSku)"
            :reason="!practiceProgress.unlocked ? '新员工保护中：请先完成3关练习解锁' : '请先选择在库单品'"
            fix-text="去练兵解锁"
            block
            kind="pri"
            @go="doSendPreSaleMedia"
            @fix="openPractice"
          >
            📤 一键向买家发送【{{ activeSku?.skuCode }}】实拍照片 + 通电视频
          </Lock>
        </div>
      </section>

      <!-- 2. 右栏中部：【📦 WMS 同款在库真机与一件一拍实拍舱（自动脱敏）】 -->
      <section class="wms-card" data-tour="right-wms">
        <div class="wms-head">
          <div>
            <h3>📦 WMS 在库真机（一件一拍）</h3>
            <span class="desensitize-tip">
              🛡 已自动剥离进价/供应商，已过滤 {{ activeSku?.privateFilteredCount || 2 }} 张库位与议价隐私图
            </span>
          </div>
          <span v-if="sameSpuList.length" class="tag acc">同款 {{ sameSpuList.length }} 台</span>
        </div>

        <!-- 内部主管/销售专属可见条（对比验证外包脱敏效果） -->
        <div v-if="!isOutsourceRole && activeSku?.costPrice" class="internal-secret-bar">
          👁 <b>内部权限可见（外包端已物理剥离）：</b>采购净成本 ¥{{ activeSku.costPrice }} ｜ 130%红线底价 ¥{{ activeSku.floorPrice }} ｜ 来源：{{ activeSku.supplierNick }}
        </div>

        <!-- 同款多台成色分槽选择器 -->
        <div v-if="sameSpuList.length" class="slot-list">
          <button
            v-for="item in sameSpuList"
            :key="item.skuCode"
            type="button"
            class="slot-item"
            :class="{
              selected: selectedSkuCode === item.skuCode,
              bound: conv.boundSkuCode === item.skuCode,
              disabled: !isSkuSelectable(item) && conv.boundSkuCode !== item.skuCode,
            }"
            @click="selectedSkuCode = item.skuCode"
          >
            <div class="sl-row1">
              <b>{{ item.grade }}</b>
              <span class="mono" style="font-size: 11.5px">{{ item.skuCode }} (#{{ item.shortCode }})</span>
              <span style="margin-left: auto; font-weight: 900; color: var(--acc)">¥{{ item.price }}</span>
            </div>
            <div class="sl-row2">
              <span v-if="conv.boundSkuCode === item.skuCode" class="tag acc">当前绑定本单</span>
              <span v-else-if="!allGatesGreen(item)" class="tag red">🔴 缺实拍视频·禁选</span>
              <span v-else-if="item.status === 'IN_STOCK'" class="tag grn">✓ 四关全绿·可挑</span>
              <span v-else class="tag amb">{{ item.status }}</span>
              <span class="muted" style="font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {{ item.bagCode }}
              </span>
            </div>
          </button>
        </div>
        <div v-else class="empty-wms">
          ⚠️ 当前商品链接未关联 WMS 款式，请先由内部销售完成链接映射。
        </div>

        <!-- 选中单品的仓管一件一拍视频 + 微距照片 + 客观检测结论 -->
        <div v-if="activeSku" class="sku-detail-box">
          <div class="ahs-report">
            <b>🔍 仓管爱回收式全检结论：</b>{{ activeSku.ahsSummary }}
          </div>

          <!-- 可播放的高拍仪通电实拍视频卡片 -->
          <div v-if="activeSku.video" class="video-entry-card" @click="openVideoModal(activeSku)">
            <div class="ve-play">
              <Icon name="play" size="18" />
            </div>
            <div style="flex: 1; min-width: 0">
              <div class="ve-title">🎬 {{ activeSku.video.title }}</div>
              <div class="ve-meta">
                {{ activeSku.video.duration }} · {{ activeSku.video.resolution }} · 点击预览核验 SN 与屏幕坏点
              </div>
            </div>
            <span class="tag grn">可读 ✓</span>
          </div>
          <div v-else class="video-missing-card">
            🔴 售前关卡②阻塞：仓管通电实拍视频缺失/坏片，禁止向买家承诺无瑕疵！
          </div>

          <!-- 本机实拍照片缩略网格 -->
          <div class="photo-grid">
            <div
              v-for="ph in activeSku.photos"
              :key="ph.id"
              class="ph-card"
              @click="previewPhoto(ph.url, `${activeSku.skuCode} · ${ph.label}`)"
            >
              <img :src="ph.url" :alt="ph.label" />
              <span class="ph-badge" :class="{ defect: ph.type === 'defect' }">{{ ph.label }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 3. 右栏底部：【🤝 60秒一键呼叫内部协同 & 严禁关单防呆】 -->
      <section class="collab-card">
        <template v-if="isOutsourceRole">
          <div class="cb-title">🤝 超出外包极窄权限？一键转内部（60秒必接）</div>
          <div class="cb-btn-grid">
            <button
              type="button"
              class="btn sm"
              @click="escalate('RUSH_VIDEO', `买家追问细节，请仓管协助核实/补拍 ${activeSku?.skuCode || ''}`)"
            >
              📸 催仓管拍细节 (60s)
            </button>
            <button
              type="button"
              class="btn sm"
              @click="escalate('BARGAIN_ESC', `买家砍价超出授权底线，请内部销售评估接管`)"
            >
              💰 砍破底价转销售
            </button>
            <button
              type="button"
              class="btn sm"
              @click="escalate('AFTERSALES_ESC', `已出库订单反馈异常，已收齐买家凭证请售后接管`)"
            >
              🔧 收货售后转专员
            </button>
            <button
              type="button"
              class="btn sm"
              disabled
              title="历史鱼力值165血泪教训：任何情况下严禁卖家主动关闭买家订单！"
            >
              🚫 主动关单(物理移除)
            </button>
          </div>
        </template>

        <!-- 当切换为【陈小满（内部销售）】或【周安（主管）】时展示内部接管与发锦囊控制台 -->
        <template v-else>
          <div class="cb-title" style="color: var(--acc)">
            🛡 内部专员接管与指导台（当前视角：{{ currentRole.name }}）
          </div>
          <div class="internal-ops">
            <div style="display: flex; gap: 7px; flex-wrap: wrap">
              <button
                v-if="conv.owner.type !== 'internal'"
                type="button"
                class="btn sm pri"
                @click="claimSession"
              >
                🔒 我来抢锁直接接管（暂停外包输入）
              </button>
              <button
                v-if="conv.collabTicket"
                type="button"
                class="btn sm bad"
                @click="rejectLazy"
              >
                ⚠️ 退回并记外包「无效甩锅」+1
              </button>
            </div>

            <!-- 方式B：不接管，只给外包发幕后回复锦囊 -->
            <div class="note-form">
              <input
                v-model="coachDraft"
                type="text"
                placeholder="不接管，写一句回复底线锦囊让外包照回（如：最低3150顺丰包邮）"
              />
              <button type="button" class="btn sm soft-acc" @click="sendCoachNote">发锦囊</button>
            </div>

            <!-- 交还外包（必填备注 + 置顶已答应买家的事） -->
            <div v-if="conv.owner.type === 'internal'" class="release-form">
              <div style="font-size: 12px; font-weight: 800">🔓 处理完毕交还外包客服跟进：</div>
              <input
                v-model="releaseNote"
                type="text"
                placeholder="必填交还备注(≥6字)：决定了什么、后续外包不能做什么"
              />
              <input
                v-model="releasePromise"
                type="text"
                placeholder="选填已答应买家的事(将置顶高亮)：如 顺丰运费我方垫付"
              />
              <button type="button" class="btn sm grn block" @click="releaseToOutsource">
                确认交还外包客服并释放会话锁
              </button>
            </div>
          </div>
        </template>
      </section>
    </div>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import {
  store,
  currentRole,
  isOutsourceRole,
  practiceProgress,
  getVisibleSku,
  getSameSpuSkus,
  pickSkuAndStartAutoShip,
  sendChatMessage,
  simulateBuyerQuestionDuringAutoShip,
  pushOrderToWmsWave,
  triggerEmergencyWmsIntercept,
  createCollabEscalation,
  handleInternalCollabAction,
} from '../store.js';
import Icon from './Icon.vue';
import Lock from './Lock.vue';
import Q from './Q.vue';

const props = defineProps({
  conv: { type: Object, default: null },
});

const selectedSkuCode = ref('');
const coachDraft = ref('');
const releaseNote = ref('');
const releasePromise = ref('');

const sameSpuList = computed(() => (props.conv?.spuCode ? getSameSpuSkus(props.conv.spuCode) : []));

watch(
  () => [props.conv?.id, props.conv?.boundSkuCode, sameSpuList.value.length],
  () => {
    if (props.conv?.boundSkuCode) {
      selectedSkuCode.value = props.conv.boundSkuCode;
    } else if (sameSpuList.value.length) {
      const firstOk = sameSpuList.value.find((s) => isSkuSelectable(s));
      selectedSkuCode.value = (firstOk || sameSpuList.value[0]).skuCode;
    } else {
      selectedSkuCode.value = '';
    }
  },
  { immediate: true },
);

const activeSku = computed(() => getVisibleSku(selectedSkuCode.value || props.conv?.boundSkuCode));

function allGatesGreen(s) {
  return Boolean(s?.gates?.inspectOk && s?.gates?.videoOk && s?.gates?.photoOk && s?.gates?.subCodeOk);
}

function isSkuSelectable(s) {
  return allGatesGreen(s) && s.status === 'IN_STOCK';
}

const canPickSelectedSku = computed(() => {
  if (!practiceProgress.value.unlocked) {
    return {
      ok: false,
      reason: '新员工保护锁开启中：需先通关 3 个防踩坑小练习',
      penalty: '避免首日新人选错隔离件或漏发实拍视频',
    };
  }
  if (!activeSku.value) {
    return { ok: false, reason: '请先在下方 WMS 列表点选 1 台在库真机', penalty: '' };
  }
  if (!allGatesGreen(activeSku.value)) {
    return {
      ok: false,
      reason: `货号 ${activeSku.value.skuCode} 仓管售前关卡未全绿（缺通电视频）`,
      penalty: '系统硬拦截发送残缺素材，请改选上方绿灯机器',
    };
  }
  if (activeSku.value.status !== 'IN_STOCK' && activeSku.value.skuCode !== props.conv?.boundSkuCode) {
    return {
      ok: false,
      reason: `货号 ${activeSku.value.skuCode} 已被其他订单占用 (${activeSku.value.status})`,
      penalty: '同一件二手单品严禁一货两卖',
    };
  }
  return { ok: true, reason: '', penalty: '' };
});

const stepCardTone = computed(() => {
  const st = props.conv?.workflowStep;
  if (
    ['LINK_ANOMALY_BLOCKED', 'WMS_MEDIA_MISSING', 'PAID_WAIT_PICK_SKU', 'AUTO_PAUSED_BY_BUYER'].includes(st)
  ) {
    return 'tone-red';
  }
  if (['AUTO_OBSERVING', 'WMS_409_INTERCEPTED'].includes(st)) return 'tone-amb';
  if (st === 'INTERNAL_TAKEN_OVER') return 'tone-acc';
  return 'tone-grn';
});

const trackNodes = computed(() => {
  const c = props.conv;
  if (!c) return [];
  const step = c.workflowStep;
  const linkOk = c.linkResolved && step !== 'WMS_MEDIA_MISSING';
  const picked = Boolean(c.boundSkuCode) && c.orderStatus !== 'INQUIRY';
  const shotSent = Boolean(c.realShotSent);

  return [
    {
      label: '核链&四关',
      state: ['LINK_ANOMALY_BLOCKED', 'WMS_MEDIA_MISSING'].includes(step) ? 'err' : linkOk ? 'done' : 'cur',
    },
    {
      label: '挑WMS单品',
      state: step === 'PAID_WAIT_PICK_SKU' ? 'cur' : picked ? 'done' : 'todo',
    },
    {
      label: '发实拍视频',
      state: shotSent ? 'done' : picked ? 'cur' : 'todo',
    },
    {
      label: '自动发/介入',
      state:
        step === 'AUTO_PAUSED_BY_BUYER'
          ? 'err'
          : step === 'PUSHED_TO_WMS_WAVE'
            ? 'done'
            : step === 'AUTO_OBSERVING'
              ? 'cur'
              : 'todo',
    },
  ];
});

function formatRemain(sec) {
  const s = Math.max(0, Number(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function openPractice() {
  store.ui.practiceOpenKey = 'link_media';
}

function openVideoModal(sku) {
  store.ui.videoModalSku = sku;
}

function previewPhoto(url, title) {
  store.ui.photoPreviewUrl = url;
  store.ui.photoPreviewTitle = title;
}

async function doPickAndSend() {
  if (!props.conv || !activeSku.value) return;
  await pickSkuAndStartAutoShip(props.conv.id, activeSku.value.skuCode);
}

async function doSendPreSaleMedia() {
  if (!props.conv || !activeSku.value) return;
  await sendChatMessage(props.conv.id, {
    text: `亲您好！为您发来仓库【货号 ${activeSku.value.skuCode} · ${activeSku.value.grade}】的本机高清实拍照片与高拍仪通电实测视频（${activeSku.value.ahsSummary}），所见即所得，您放心核对！`,
    withRealShot: true,
    skuCode: activeSku.value.skuCode,
  });
}

async function simBuyerBreak() {
  if (!props.conv) return;
  await simulateBuyerQuestionDuringAutoShip(props.conv.id);
}

async function doAutoPushTimer() {
  if (!props.conv) return;
  await pushOrderToWmsWave(props.conv.id, 'timer_auto');
}

async function doManualResumePush() {
  if (!props.conv) return;
  await pushOrderToWmsWave(props.conv.id, 'manual_resolved');
}

async function doEmergencyIntercept() {
  if (!props.conv) return;
  await triggerEmergencyWmsIntercept(props.conv.id, '买家在拣货期间临时要求修改杭州新地址/退单重拍');
}

async function escalate(type, title) {
  if (!props.conv) return;
  await createCollabEscalation(props.conv.id, { type, title });
}

async function simWarehouseVideo() {
  if (!props.conv) return;
  await handleInternalCollabAction(props.conv.id, 'warehouse_upload_video');
}

async function simSalesBindLink() {
  if (!props.conv) return;
  await handleInternalCollabAction(props.conv.id, 'sales_bind_link');
}

function switchToInternalChen() {
  store.actorId = 'internal_chen';
}

async function claimSession() {
  if (!props.conv) return;
  await handleInternalCollabAction(props.conv.id, 'internal_claim');
}

async function sendCoachNote() {
  if (!props.conv) return;
  const ok = await handleInternalCollabAction(props.conv.id, 'internal_note', { note: coachDraft.value });
  if (ok) coachDraft.value = '';
}

async function releaseToOutsource() {
  if (!props.conv) return;
  const ok = await handleInternalCollabAction(props.conv.id, 'internal_release', {
    note: releaseNote.value,
    promise: releasePromise.value,
  });
  if (ok) {
    releaseNote.value = '';
    releasePromise.value = '';
  }
}

async function rejectLazy() {
  if (!props.conv) return;
  await handleInternalCollabAction(props.conv.id, 'reject_invalid_escalation');
}
</script>

<style scoped>
.right-copilot {
  background: var(--panel-alt);
}
.rc-scroll {
  padding: 12px 13px 20px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.coach-note-card {
  background: var(--acc-soft);
  border: 1.5px solid var(--acc);
  border-radius: 13px;
  padding: 10px 12px;
  font-size: 12.5px;
  display: grid;
  gap: 4px;
}
.cn-title {
  font-weight: 800;
  color: var(--acc);
}

/* 顶部步骤小卡片 */
.step-guide-card {
  background: var(--panel);
  border-radius: 16px;
  padding: 13px 14px;
  border: 2px solid var(--line);
  box-shadow: var(--sh);
  display: grid;
  gap: 10px;
}
.step-guide-card.tone-red {
  border-color: var(--red);
  background: linear-gradient(180deg, var(--red-soft) 0%, var(--panel) 48%);
}
.step-guide-card.tone-amb {
  border-color: var(--amb);
  background: linear-gradient(180deg, var(--amb-soft) 0%, var(--panel) 48%);
}
.step-guide-card.tone-grn {
  border-color: var(--grn);
  background: linear-gradient(180deg, var(--grn-soft) 0%, var(--panel) 48%);
}
.step-guide-card.tone-acc {
  border-color: var(--acc);
  background: linear-gradient(180deg, var(--acc-soft) 0%, var(--panel) 48%);
}

.sg-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sg-eyebrow {
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2px;
}

.mini-track {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  background: var(--panel-alt);
  padding: 7px 6px;
  border-radius: 11px;
  border: 1px solid var(--line);
}
.mt-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--mute);
  font-weight: 700;
}
.mt-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--soft);
  border: 1.5px solid var(--line);
  display: grid;
  place-items: center;
  font-size: 10.5px;
  font-weight: 900;
}
.mt-node.done {
  color: var(--grn-ink);
}
.mt-node.done .mt-dot {
  background: var(--grn);
  border-color: var(--grn);
  color: #fff;
}
.mt-node.cur {
  color: var(--acc);
}
.mt-node.cur .mt-dot {
  background: var(--acc);
  border-color: var(--acc);
  color: #fff;
}
.mt-node.err {
  color: var(--red-ink);
}
.mt-node.err .mt-dot {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
}

.sg-body {
  display: grid;
  gap: 8px;
}
.sg-body h4 {
  font-size: 13.5px;
  font-weight: 900;
  line-height: 1.35;
}
.sg-body p {
  font-size: 12.5px;
  color: var(--ink2);
  line-height: 1.48;
}
.countdown-pill {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--amb);
  color: #fff;
  font-family: monospace;
  font-size: 13px;
  font-weight: 900;
}
.pause-reason {
  padding: 7px 10px;
  border-radius: 9px;
  background: var(--red-soft);
  color: var(--red-ink);
  font-weight: 700;
}
.swap-hint {
  font-size: 11.5px;
  padding: 7px 9px;
  border-radius: 9px;
  background: var(--acc-soft);
  color: var(--acc);
}
.collab-wait-box {
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 12px;
  font-weight: 700;
}

/* WMS 卡片 */
.wms-card,
.collab-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 13px 14px;
  display: grid;
  gap: 10px;
}
.wms-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.wms-head h3 {
  font-size: 14px;
  font-weight: 900;
}
.desensitize-tip {
  display: block;
  font-size: 11px;
  color: var(--grn-ink);
  margin-top: 2px;
  font-weight: 600;
}
.internal-secret-bar {
  padding: 7px 10px;
  border-radius: 9px;
  background: #1e293b;
  color: #f8fafc;
  font-size: 11.5px;
}

.slot-list {
  display: grid;
  gap: 6px;
}
.slot-item {
  text-align: left;
  padding: 9px 11px;
  border-radius: 11px;
  border: 1.5px solid var(--line);
  background: var(--panel-alt);
  display: grid;
  gap: 4px;
  transition: all 0.12s;
}
.slot-item:hover {
  border-color: var(--acc);
}
.slot-item.selected {
  border-color: var(--acc);
  background: var(--acc-soft);
}
.slot-item.disabled {
  opacity: 0.72;
  border-style: dashed;
}
.sl-row1,
.sl-row2 {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
}

.sku-detail-box {
  display: grid;
  gap: 9px;
  padding-top: 4px;
  border-top: 1px dashed var(--line);
}
.ahs-report {
  font-size: 12px;
  line-height: 1.45;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
}
.video-entry-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%);
  color: #ffffff;
  cursor: pointer;
  transition: transform 0.12s ease;
}
.video-entry-card:hover {
  transform: translateY(-1px);
}
.ve-play {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #38bdf8;
  color: #0f172a;
  display: grid;
  place-items: center;
  flex: none;
}
.ve-title {
  font-size: 12.5px;
  font-weight: 800;
}
.ve-meta {
  font-size: 11px;
  opacity: 0.84;
  margin-top: 2px;
}
.video-missing-card {
  padding: 9px 11px;
  border-radius: 10px;
  background: var(--red-soft);
  color: var(--red-ink);
  font-size: 12px;
  font-weight: 700;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.ph-card {
  position: relative;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--line);
  cursor: pointer;
  aspect-ratio: 16 / 10;
  background: #090d16;
}
.ph-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ph-badge {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 4px;
  padding: 2px 5px;
  border-radius: 5px;
  background: rgba(15, 23, 42, 0.82);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ph-badge.defect {
  background: rgba(220, 38, 38, 0.9);
}

.empty-wms {
  padding: 12px;
  border-radius: 10px;
  background: var(--red-soft);
  color: var(--red-ink);
  font-size: 12px;
  font-weight: 700;
}

.cb-title {
  font-size: 12.5px;
  font-weight: 800;
  color: var(--ink2);
}
.cb-btn-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.internal-ops {
  display: grid;
  gap: 8px;
}
.note-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
}
.note-form input,
.release-form input {
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  font-size: 12px;
}
.release-form {
  display: grid;
  gap: 6px;
  padding: 9px;
  border-radius: 10px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
}
</style>
