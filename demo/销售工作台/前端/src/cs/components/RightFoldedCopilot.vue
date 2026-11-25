<template>
  <aside v-if="conv" class="col-right">
    <!-- ==================== 表层卡片 1：当前进度与唯一主操作（默认展开·极简直观） ==================== -->
    <section class="r-card" data-tour="right-stepper">
      <div class="rc-head">
        <div style="display: flex; align-items: center; gap: 6px">
          <b>🧭 当前进度</b>
          <Q k="copilot_card" />
        </div>
        <span class="step-pill" :class="stepTone">{{ stepLabel }}</span>
      </div>

      <!-- 售前/问题单：极简三步圆点条 -->
      <div v-if="conv.category !== 'after_sale'" class="dot-steps">
        <div
          class="ds-node"
          :class="{
            done: conv.realShotSent || conv.stepState === 'SHIPPED_AUTO',
            cur: !conv.realShotSent && conv.stepState !== 'SHIPPED_AUTO',
          }"
        >
          <span>1</span>发实拍
        </div>
        <div class="ds-bar" />
        <div
          class="ds-node"
          :class="{
            done: conv.warrantyActivated || conv.stepState === 'SHIPPED_AUTO',
            cur: conv.stepState === 'WAIT_WARRANTY_AGREE',
          }"
        >
          <span>2</span>同意/静默
        </div>
        <div class="ds-bar" />
        <div class="ds-node" :class="{ done: conv.stepState === 'SHIPPED_AUTO' }">
          <span>3</span>自动推仓
        </div>
      </div>

      <!-- 售后单：极简两步圆点条 -->
      <div v-else class="dot-steps">
        <div
          class="ds-node"
          :class="{
            done: conv.stepState === 'REFUND_GUIDE_SENT' || conv.stepState === 'REFUND_DONE',
            cur: conv.stepState === 'WAIT_BUYER_REFUND_CLICK',
          }"
        >
          <span>1</span>0秒发退款UI图
        </div>
        <div class="ds-bar" />
        <div class="ds-node" :class="{ done: conv.stepState === 'REFUND_DONE', cur: conv.stepState === 'REFUND_GUIDE_SENT' }">
          <span>2</span>改协商一致秒退
        </div>
      </div>

      <!-- 分场景大白话一句话指引 + 防呆主按钮 -->
      <!-- 1. 已付款待挑货发实拍 + 自动发保修卡 -->
      <div v-if="conv.stepState === 'WAIT_PICK_SEND'" class="guide-box">
        <p>
          买家已付款！请在下方确认绿灯真机，点按钮<b>一键发出实拍图/视频，系统将自动跟发《保修激活确认卡》</b>。
        </p>
        <Lock
          :ok="canSendRealShot"
          :reason="sendRealShotLockReason"
          :fix-text="newbieLocked ? '去做3关练习' : ''"
          block
          @go="emitSendRealShot"
          @fix="openPractice"
        >
          📤 发实拍图/视频 + 自动发保修激活卡
        </Lock>
      </div>

      <!-- 2. 已发保修激活卡，等买家回“同意”或静默倒计时自动发货 -->
      <div v-else-if="conv.stepState === 'WAIT_WARRANTY_AGREE'" class="guide-box">
        <div class="timer-banner">
          <span>⏱ 静默自动推仓倒计时</span>
          <b>{{ formatSec(conv.autoShipRemainSec) }}</b>
        </div>
        <p>
          已发实拍与《保修激活卡（含富阳法院管辖）》。<b>买家回“同意”立即激活保修并发货</b>；不说话倒计时满自动推仓；买家一旦发问自动停发！
        </p>
      </div>

      <!-- 3. 已推入仓库波次顺丰发货 -->
      <div v-else-if="conv.stepState === 'SHIPPED_AUTO'" class="guide-box ok">
        <p>
          ✅ <b>已推入仓库顺丰波次！</b>{{ conv.wmsWaveNo || '激光扫四码打包中' }}（无需人工再催发）。
        </p>
      </div>

      <!-- 4. 409 红屏已紧急拦停 -->
      <div v-else-if="conv.stepState === 'INTERCEPTED_409'" class="guide-box warn">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px">
          <span>🛑 <b>急停截单已生效</b></span>
          <Q k="auto_refund" label="退款与急停" />
        </div>
        <p>🛑 <b>打包台已红屏急停锁单！</b>仓管无法出库，请引导买家申请退款选“不想要了/协商一致”。</p>
      </div>

      <!-- 5. 售后：已自动发出 3 步手机 UI 退款引导图 -->
      <div v-else-if="conv.stepState === 'REFUND_GUIDE_SENT'" class="guide-box">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px">
          <span>📱 <b>0 秒退款 UI 指引</b></span>
          <Q k="auto_refund" label="退款与急停" />
        </div>
        <p>
          已 0 秒自动发出<b>《手机UI三步选“不想要了/协商一致”引导图》</b>。买家照图修改提交后，系统将自动 0 秒全额退款。
        </p>
      </div>

      <!-- 6. 售后：拣货中买家口头说想退（如 C5） -->
      <div v-else-if="conv.stepState === 'WAIT_BUYER_REFUND_CLICK'" class="guide-box warn">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px">
          <span>⚠️ <b>拣货中急停拦单</b></span>
          <Q k="auto_refund" label="退款与急停" />
        </div>
        <p>
          ⚠️ 该单已在仓管拣货（{{ conv.wmsWaveNo }}）！请先点<b>紧急拦截仓库面单</b>，等买家点申请退款会自动发引导图。
        </p>
        <button type="button" class="btn red full" @click="triggerEmergencyWmsIntercept(conv.id)">
          🛑 立即下发红屏急停拦截仓库面单
        </button>
      </div>

      <!-- 7. 售后：已改对原因秒退完成 -->
      <div v-else-if="conv.stepState === 'REFUND_DONE'" class="guide-box ok">
        <p>✓ 买家已改选「不想要了/协商一致」，系统已 0 秒全额秒退并释放库存。</p>
      </div>

      <!-- 8. 问题单：买家提疑问触发自动发货熔断（如 C6） -->
      <div v-else-if="conv.stepState === 'ISSUE_BUYER_QUESTION'" class="guide-box warn">
        <p>⚡ {{ conv.issueReason }}</p>
        <Lock
          v-if="pickedSku && pickedSku.skuCode !== conv.skuCode"
          :ok="canSendRealShot"
          :reason="sendRealShotLockReason"
          block
          @go="emitSendRealShot"
        >
          ⇄ 换选中的【{{ pickedSku.grade }}】重发实拍与保修卡
        </Lock>
        <button
          type="button"
          class="btn grn full"
          style="margin-top: 6px"
          @click="pushOrderToWmsWave(conv.id, 'manual_resume')"
        >
          ✓ 疑问已解答 · 恢复推入仓库发货
        </button>
      </div>

      <!-- 9. 问题单：仓管漏传通电实拍视频（如 C7） -->
      <div v-else-if="conv.stepState === 'ISSUE_NO_VIDEO'" class="guide-box warn">
        <p>📸 {{ conv.issueReason }}</p>
        <button
          v-if="!conv.collabTicket || conv.collabTicket.status !== 'PENDING'"
          type="button"
          class="btn amb full"
          @click="createCollabEscalation(conv.id, 'rush_video', '买家已拍下等看亮屏视频，请60秒补录')"
        >
          ⚡ 一键催仓管 60 秒补拍通电视频
        </button>
        <button
          type="button"
          class="btn pri full"
          style="margin-top: 6px"
          @click="handleInternalCollabAction(conv.id, 'sim_warehouse_upload_video')"
        >
          🎬 模拟仓管高拍仪刚传回视频（立即解锁）
        </button>
      </div>

      <!-- 10. 问题单：商品链接未挂接 WMS 货号（如 C8） -->
      <div v-else-if="conv.stepState === 'ISSUE_LINK_UNMAPPED'" class="guide-box warn">
        <p>🛑 {{ conv.issueReason }}</p>
        <button
          v-if="!conv.collabTicket || conv.collabTicket.status !== 'PENDING'"
          type="button"
          class="btn amb full"
          @click="createCollabEscalation(conv.id, 'bind_link', '淘宝商品链接未绑仓库货号，请协助挂接')"
        >
          🔗 一键呼叫内部销售 60s 绑定仓库货号
        </button>
        <button
          type="button"
          class="btn pri full"
          style="margin-top: 6px"
          @click="handleInternalCollabAction(conv.id, 'sim_sales_bind_link')"
        >
          ✓ 模拟内部销售刚完成绑货（立即关联实拍）
        </button>
      </div>

      <!-- 11. 常规售前咨询（如 C3） -->
      <div v-else class="guide-box">
        <p>买家正在售前咨询，可直接把下方仓管拍好的本机实拍照片和视频发过去促单。</p>
        <Lock
          :ok="canSendRealShot"
          :reason="sendRealShotLockReason"
          :fix-text="newbieLocked ? '去做3关练习' : ''"
          block
          @go="emitSendRealShot"
          @fix="openPractice"
        >
          📤 一键发送本机实拍照片与视频
        </Lock>
      </div>

      <!-- 折叠：交互演示模拟器（不占用日常视觉，点开即可一键测全套自动触发） -->
      <FoldBox title="🧪 演示测试模拟（回“同意”/提疑问/申请退款）" chip="点开实测" chip-tone="pri">
        <div class="sim-grid">
          <button type="button" class="btn sm grn full" @click="simAgree">
            ✅ 模拟买家回复“同意” → 自动激活保修并推仓
          </button>
          <button type="button" class="btn sm full" @click="simQuestion">
            ❓ 模拟买家发来疑问 → 毫秒级熔断转【问题订单】
          </button>
          <button
            v-if="conv.orderNo && conv.realShotSent && conv.stepState !== 'SHIPPED_AUTO'"
            type="button"
            class="btn sm full"
            @click="pushOrderToWmsWave(conv.id, 'silent_timeout')"
          >
            ⏱ 模拟 30 分钟静默期满无异议 → 自动推仓发货
          </button>
          <button type="button" class="btn sm amb full" @click="triggerBuyerApplyRefund(conv.id)">
            ⚡ 模拟买家点【申请退款】→ 0秒自动发手机UI步骤图
          </button>
          <button
            v-if="conv.category === 'after_sale'"
            type="button"
            class="btn sm grn full"
            @click="simulateBuyerModifiedRefundReason(conv.id)"
          >
            ✓ 模拟买家已照图改选“不想要了/协商一致” → 秒退
          </button>
        </div>
      </FoldBox>
    </section>

    <!-- ==================== 表层卡片 2：WMS 仓库一件一拍实拍舱（默认展开·清爽选货） ==================== -->
    <section class="r-card" data-tour="right-wms">
      <div class="rc-head">
        <b>📦 仓库实拍（一件一拍）</b>
        <span v-if="pickedSku" class="price-tag">¥{{ pickedSku.price }}</span>
        <span v-else class="tag amb">待绑货号</span>
      </div>

      <template v-if="pickedSku">
        <!-- 同款多台分槽切换（缺视频单品自动标锁） -->
        <div v-if="sameModelList.length > 1" class="slot-pills">
          <button
            v-for="s in sameModelList"
            :key="s.skuCode"
            type="button"
            class="slot-btn"
            :class="{
              active: pickedSku.skuCode === s.skuCode,
              blocked: !s.allGatesOk,
            }"
            @click="$emit('update:pickedSkuCode', s.skuCode)"
          >
            <span>{{ s.allGatesOk ? '🟢' : '🔒' }} {{ s.grade }}</span>
            <small>¥{{ s.price }}</small>
          </button>
        </div>

        <div class="sku-title">{{ pickedSku.title }}</div>
        <div class="sku-sub">
          货号 <code>{{ pickedSku.skuCode }}</code> ｜ 序列号 <code>{{ pickedSku.sn }}</code>
        </div>
        <div class="sku-brief" :class="{ warn: !pickedSku.allGatesOk }">
          {{ pickedSku.ahsSummary }}
        </div>

        <!-- 本机实拍缩略图 -->
        <div class="photo-strip">
          <button
            v-for="ph in pickedSku.photos"
            :key="ph.id"
            type="button"
            class="photo-item"
            @click="openPhoto(ph.url, `${pickedSku.skuCode} · ${ph.label}`)"
          >
            <img :src="ph.url" :alt="ph.label" />
            <span>{{ ph.label }}</span>
          </button>
        </div>

        <!-- 1080p60 通电视频播放按钮 -->
        <button
          v-if="pickedSku.videoReady"
          type="button"
          class="video-btn"
          @click="store.ui.videoModalSku = pickedSku"
        >
          🎬 播放仓管通电实拍视频（{{ pickedSku.video.duration }} · {{ pickedSku.video.resolution }}）
        </button>
        <div v-else class="video-missing">
          🔒 缺少高拍仪通电实拍视频，系统已禁选锁死（可在下方折叠面板一键催仓管补拍）
        </div>
      </template>

      <div v-else class="unmapped-empty">
        当前买家发来的商品链接尚未绑定仓库货号，严禁口头盲答“有货”，请点上方按钮呼叫内部销售 60 秒绑货。
      </div>
    </section>

    <!-- ==================== 折叠层 1：仓管全检四关 · 子母码 · RBAC 隐私脱敏盾 ==================== -->
    <FoldBox
      v-if="pickedSku"
      title="🔍 全检四关 · 配件子母码 · 脱敏盾"
      :chip="pickedSku.allGatesOk ? '四关全绿 ✓' : '缺项阻塞'"
      :chip-tone="pickedSku.allGatesOk ? 'ok' : 'warn'"
    >
      <div class="gate-grid">
        <span class="gate-chip" :class="{ ok: pickedSku.gates?.inspectOk }">
          {{ pickedSku.gates?.inspectOk ? '✓' : '✗' }} ① 爱回收全检
        </span>
        <span class="gate-chip" :class="{ ok: pickedSku.gates?.videoOk, bad: !pickedSku.gates?.videoOk }">
          {{ pickedSku.gates?.videoOk ? '✓' : '✗' }} ② 通电实拍视频
        </span>
        <span class="gate-chip" :class="{ ok: pickedSku.gates?.photoOk }">
          {{ pickedSku.gates?.photoOk ? '✓' : '✗' }} ③ 微距实拍图
        </span>
        <span class="gate-chip" :class="{ ok: pickedSku.gates?.subCodeOk }">
          {{ pickedSku.gates?.subCodeOk ? '✓' : '✗' }} ④ SPU与子母码
        </span>
      </div>

      <div class="kv-mini">
        <div><span>附件袋码：</span>{{ pickedSku.bagCode }}</div>
        <div><span>包装箱码：</span>{{ pickedSku.boxCode }}</div>
        <div>
          <span>图像过滤：</span>已自动剥离库位照/上游议价截图
          <b>{{ pickedSku.privateFilteredCount || 2 }} 张</b>（防泄露货架与收货源）
        </div>
      </div>

      <!-- 外包角色看到物理脱敏保护盾；内部销售/主管看到真实进价与底价 -->
      <div v-if="isOutsourceRole" class="desens-shield">
        🛡️ <b>外包安全边界已生效：</b>采购进价与上游卖家已在服务端物理剥离；本商品实价标售，买家砍价超
        ¥{{ store.data.kpi.config.maxOutsourceDiscount }} 请点下方转内部销售。
      </div>
      <div v-else class="internal-secret-box">
        🔑 <b>内部专员/主管可见机密：</b>采购进价 <b>¥{{ pickedSku.costPrice }}</b> ｜ 内部授权底价
        <b>¥{{ pickedSku.floorPrice }}</b> ｜ 上游来源：{{ pickedSku.supplierNick }}
      </div>
    </FoldBox>

    <!-- ==================== 折叠层 2：跨部门60秒协同 · 409红屏拦截 · 内部接管控制台 ==================== -->
    <FoldBox
      title="🤝 跨部门协同 · 红屏急停 · 内部接管"
      :chip="collabChipText"
      :chip-tone="collabChipTone"
    >
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px">
        <span style="font-size: 11.5px; color: var(--mute)">60s 一键跨部门派单</span>
        <Q k="collab_escalate" label="跨台呼救" />
      </div>
      <!-- 当前活跃协同工单状态 -->
      <div v-if="conv.collabTicket" class="ticket-banner" :class="conv.collabTicket.status.toLowerCase()">
        <div>
          <b>{{ conv.collabTicket.title }}</b>
          <span class="tag sm" style="margin-left: 6px">{{ conv.collabTicket.status }}</span>
        </div>
        <div style="font-size: 11.5px; opacity: 0.88">{{ conv.collabTicket.note }}</div>
      </div>

      <div class="sub-label">外包一键 60 秒呼救（直达仓管/销售首页红灯队列）：</div>
      <div class="collab-btns">
        <button
          type="button"
          class="btn sm"
          @click="createCollabEscalation(conv.id, 'rush_video', '请仓管60s补拍本机高拍仪通电视频')"
        >
          📸 催仓管拍视频
        </button>
        <button
          type="button"
          class="btn sm"
          @click="createCollabEscalation(conv.id, 'bind_link', '请内部销售绑定商品链接与仓库货号')"
        >
          🔗 呼销售绑链接
        </button>
        <button
          type="button"
          class="btn sm"
          @click="createCollabEscalation(conv.id, 'bargain_sales', '买家大刀砍价超权限，申请内部销售定夺')"
        >
          💰 砍价转销售
        </button>
        <button
          type="button"
          class="btn sm"
          @click="createCollabEscalation(conv.id, 'aftersale_tech', '收货后技术故障/理赔申请专员介入')"
        >
          🛠️ 疑难售后升级
        </button>
      </div>

      <!-- 仓管波次 409 红屏急停拦截 -->
      <div class="sub-label" style="margin-top: 4px">已进波次订单紧急拦停 &amp; 关单红线防呆：</div>
      <Lock
        :ok="Boolean(conv.wmsWaveNo) && conv.stepState !== 'INTERCEPTED_409'"
        :reason="
          conv.stepState === 'INTERCEPTED_409'
            ? '当前订单已处于红屏锁单状态，无需重复下发'
            : '仅已进仓库拣货波次的订单需要急停锁单；未推仓订单系统会自动停发'
        "
        kind="red"
        block
        @go="triggerEmergencyWmsIntercept(conv.id)"
      >
        🛑 下发仓库打包台红屏急停锁单
      </Lock>

      <!-- 永久防呆：禁止主动关闭买家订单（鱼力值 165 红线） -->
      <Lock
        :ok="false"
        reason="闲鱼鱼力值165历史事故红线：外包端已物理移除「卖家关闭订单」权限！"
        penalty="缺货或拍错请引导同款其他槽位，或让买家自行发起退款选【不想要了/协商一致】秒退"
        block
      >
        🚫 卖家主动关闭买家订单（永久禁用）
      </Lock>

      <!-- 内部兜底销售（陈小满 / 主管）排他接管与幕后锦囊区 -->
      <div class="internal-console">
        <div class="ic-head">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
            <b>🎯 内部销售【陈小满】协同台</b>
            <Q k="takeover_handoff" label="排他接管" />
          </div>
          <button
            v-if="isOutsourceRole"
            type="button"
            class="link-mini"
            @click="switchActor('internal_chen')"
          >
            切换为陈小满操作 ›
          </button>
          <span v-else class="tag grn">当前内部权限已激活</span>
        </div>

        <template v-if="isInternalOrSupervisor">
          <div style="display: flex; gap: 6px; flex-wrap: wrap">
            <button
              v-if="conv.owner?.type !== 'internal'"
              type="button"
              class="btn sm pri"
              @click="handleInternalCollabAction(conv.id, 'internal_claim')"
            >
              🔒 我来排他接管（锁外包输入）
            </button>
            <button
              type="button"
              class="btn sm amb"
              @click="handleInternalCollabAction(conv.id, 'reject_invalid_escalation')"
            >
              ↩ 退回无效甩锅（记反作弊）
            </button>
          </div>

          <div class="ic-form">
            <input
              v-model="coachText"
              type="text"
              placeholder="不接管直接写幕后回复锦囊（仅外包可见，如：最低让20送DP线）..."
            />
            <button type="button" class="btn sm soft" @click="sendCoach">💡 发幕后锦囊</button>
          </div>

          <div v-if="conv.owner?.type === 'internal'" class="ic-release-box">
            <input
              v-model="handoffNote"
              type="text"
              placeholder="【必填】交还外包跟进备注（如：已谈妥1000顺丰包邮）"
            />
            <input
              v-model="commitmentText"
              type="text"
              placeholder="【选填】置顶承诺事项（如：附赠全新1.8m DP线）"
            />
            <button type="button" class="btn sm grn full" @click="releaseToOutsource">
              🔓 填妥备注并交还外包继续跟进
            </button>
          </div>
        </template>
        <div v-else style="font-size: 11.5px; color: var(--mute)">
          当前为外包视角。点右上角切换至「陈小满（内部销售）」可现场体验抢锁接管、发幕后黄色锦囊与必填备注交还。
        </div>
      </div>
    </FoldBox>

    <!-- ==================== 折叠层 3：手边十要素防呆锦囊 ==================== -->
    <FoldBox title="❓ 本步防呆锦囊与考核口径" chip="零培训指南">
      <div class="help-mini">
        <div><b>✅ 成功标准：</b>30 秒内人工首响，已付款单 100% 发本机实拍视频+保修卡留证。</div>
        <div><b>🛑 停手红线：</b>链接标红未绑货、机器缺实拍视频、买家留微信或大刀砍价 → 立即点升级！</div>
        <div><b>📊 考核五防：</b>自动剔除 50 秒机器人兜底与单字“1”刷尾响；未发实拍强发倒扣绩效。</div>
        <button type="button" class="btn sm soft full" @click="store.ui.helpKey = 'copilot_card'">
          📖 展开完整十要素防呆抽屉 ›
        </button>
      </div>
    </FoldBox>
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue';
import {
  store,
  newbieLocked,
  practiceStatus,
  isOutsourceRole,
  isInternalOrSupervisor,
  formatSec,
  switchActor,
  pickSkuAndSendRealShot,
  simulateBuyerMessage,
  pushOrderToWmsWave,
  triggerEmergencyWmsIntercept,
  triggerBuyerApplyRefund,
  simulateBuyerModifiedRefundReason,
  createCollabEscalation,
  handleInternalCollabAction,
} from '../store.js';
import FoldBox from './FoldBox.vue';
import Lock from './Lock.vue';
import Q from './Q.vue';

const props = defineProps({
  conv: { type: Object, default: null },
  pickedSku: { type: Object, default: null },
  sameModelList: { type: Array, default: () => [] },
});

defineEmits(['update:pickedSkuCode']);

const coachText = ref('');
const handoffNote = ref('');
const commitmentText = ref('');

const canSendRealShot = computed(() => {
  if (newbieLocked.value) return false;
  if (!props.pickedSku) return false;
  if (!props.pickedSku.videoReady) return false;
  if (props.conv?.owner?.type === 'internal' && isOutsourceRole.value) return false;
  return true;
});

const sendRealShotLockReason = computed(() => {
  if (newbieLocked.value) {
    return `首日新人保护锁：请先完成 3 个 60 秒防踩坑情景练习（当前已过 ${practiceStatus.value.passedCount}/3 关）`;
  }
  if (props.conv?.owner?.type === 'internal' && isOutsourceRole.value) {
    return `会话正由内部销售【${props.conv.owner.name}】排他接管中，防止双方重复发消息`;
  }
  if (!props.pickedSku) {
    return '当前商品链接还没绑仓库货号，请先点上面按钮找内部销售';
  }
  if (!props.pickedSku.videoReady) {
    return `货号 ${props.pickedSku.skuCode} 缺少高拍仪通电实拍视频（售前关卡②阻塞），请换选绿灯机器或催仓管补拍`;
  }
  return '';
});

const stepLabel = computed(() => {
  const map = {
    WAIT_PICK_SEND: '待挑货发实拍',
    WAIT_WARRANTY_AGREE: '等回“同意”激活保修',
    SHIPPED_AUTO: '已自动推仓发货',
    INTERCEPTED_409: '急停已锁单',
    REFUND_GUIDE_SENT: '等买家改退款原因',
    WAIT_BUYER_REFUND_CLICK: '拣货中退单急停',
    REFUND_DONE: '已秒退完结',
    ISSUE_BUYER_QUESTION: '疑问熔断待处理',
    ISSUE_NO_VIDEO: '缺通电视频阻塞',
    ISSUE_LINK_UNMAPPED: '链接未绑仓库货号',
    INQUIRY: '售前咨询促单',
  };
  return map[props.conv?.stepState] || '接待跟进中';
});

const stepTone = computed(() => {
  const s = props.conv?.stepState;
  if (s === 'SHIPPED_AUTO' || s === 'REFUND_DONE') return 'ok';
  if (
    s === 'ISSUE_BUYER_QUESTION' ||
    s === 'ISSUE_NO_VIDEO' ||
    s === 'ISSUE_LINK_UNMAPPED' ||
    s === 'WAIT_BUYER_REFUND_CLICK' ||
    s === 'INTERCEPTED_409'
  ) {
    return 'warn';
  }
  return 'pri';
});

const collabChipText = computed(() => {
  if (props.conv?.owner?.type === 'internal') return '陈小满接管中';
  if (props.conv?.collabTicket?.status === 'PENDING') return '60s呼救处理中';
  return '催拍/转销售/拦截';
});

const collabChipTone = computed(() => {
  if (props.conv?.owner?.type === 'internal' || props.conv?.collabTicket?.status === 'PENDING') {
    return 'warn';
  }
  return '';
});

function openPractice() {
  store.ui.practiceOpenKey = practiceStatus.value.nextKey;
}

function openPhoto(url, title) {
  store.ui.photoPreviewUrl = url;
  store.ui.photoPreviewTitle = title;
}

async function emitSendRealShot() {
  if (!props.conv || !props.pickedSku) return;
  await pickSkuAndSendRealShot(props.conv.id, props.pickedSku.skuCode);
}

async function simAgree() {
  if (!props.conv) return;
  await simulateBuyerMessage(props.conv.id, '同意，本机实拍和保修卡确认无误，安排顺丰发货吧！');
}

async function simQuestion() {
  if (!props.conv) return;
  await simulateBuyerMessage(props.conv.id, '等一下先别发！我看边角好像有个小印子，还有没有更新一点的？');
}

async function sendCoach() {
  if (!props.conv) return;
  await handleInternalCollabAction(props.conv.id, 'internal_coach_note', { note: coachText.value });
  coachText.value = '';
}

async function releaseToOutsource() {
  if (!props.conv) return;
  await handleInternalCollabAction(props.conv.id, 'internal_release', {
    handoffNote: handoffNote.value,
    commitment: commitmentText.value,
  });
  if (props.conv.owner?.type === 'outsource') {
    handoffNote.value = '';
    commitmentText.value = '';
  }
}
</script>

<style scoped>
.col-right {
  background: var(--panel-alt);
  border-left: 1px solid var(--line);
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.r-card {
  flex-shrink: 0;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 13px;
  padding: 13px;
  display: grid;
  gap: 10px;
}

.rc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.step-pill {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}
.step-pill.pri {
  background: var(--pri-soft);
  color: var(--pri);
}
.step-pill.ok {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.step-pill.warn {
  background: var(--red-soft);
  color: var(--red-ink);
}

.dot-steps {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--panel-alt);
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 11.5px;
  color: var(--mute);
}
.ds-node {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 700;
  white-space: nowrap;
}
.ds-node span {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: var(--line);
  color: var(--ink2);
  font-size: 11px;
  display: grid;
  place-items: center;
}
.ds-node.cur {
  color: var(--pri);
}
.ds-node.cur span {
  background: var(--pri);
  color: #fff;
}
.ds-node.done {
  color: var(--grn-ink);
}
.ds-node.done span {
  background: var(--grn);
  color: #fff;
}
.ds-bar {
  flex: 1;
  height: 1px;
  background: var(--line);
  margin: 0 6px;
}

.guide-box {
  padding: 10px 11px;
  border-radius: 10px;
  background: var(--pri-soft);
  border: 1px solid rgba(22, 119, 255, 0.2);
  display: grid;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.5;
}
.guide-box.ok {
  background: var(--grn-soft);
  border-color: rgba(0, 180, 42, 0.24);
  color: var(--grn-ink);
}
.guide-box.warn {
  background: var(--red-soft);
  border-color: rgba(245, 63, 63, 0.24);
}

.timer-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 9px;
  border-radius: 7px;
  background: var(--panel);
  font-size: 12px;
}
.timer-banner b {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--pri);
  font-size: 14px;
}

.sim-grid {
  display: grid;
  gap: 6px;
}

.price-tag {
  font-size: 15px;
  font-weight: 800;
  color: var(--pri);
}

.slot-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.slot-btn {
  padding: 5px 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.slot-btn small {
  color: var(--mute);
  font-weight: 600;
}
.slot-btn.active {
  border-color: var(--pri);
  background: var(--pri-soft);
  color: var(--pri);
}
.slot-btn.blocked {
  opacity: 0.72;
  border-style: dashed;
}

.sku-title {
  font-size: 13.5px;
  font-weight: 800;
  line-height: 1.4;
}
.sku-sub {
  font-size: 11.5px;
  color: var(--mute);
}
.sku-sub code {
  background: var(--soft);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--ink2);
}
.sku-brief {
  font-size: 12px;
  color: var(--ink2);
  background: var(--panel-alt);
  padding: 7px 9px;
  border-radius: 8px;
  line-height: 1.45;
}
.sku-brief.warn {
  background: var(--amb-soft);
  color: var(--amb-ink);
}

.photo-strip {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.photo-item {
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
  background: var(--panel-alt);
  text-align: center;
  display: grid;
}
.photo-item img {
  width: 100%;
  height: 82px;
  object-fit: cover;
  display: block;
}
.photo-item span {
  font-size: 11px;
  padding: 4px 6px;
  color: var(--ink2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.video-btn {
  width: 100%;
  padding: 9px 11px;
  border-radius: 9px;
  background: #0f172a;
  color: #f8fafc;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
}
.video-btn:hover {
  background: #1e293b;
}
.video-missing {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 11.5px;
  line-height: 1.45;
}
.unmapped-empty {
  padding: 12px;
  border-radius: 9px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 12px;
  line-height: 1.5;
}

.gate-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}
.gate-chip {
  padding: 4px 8px;
  border-radius: 7px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  font-size: 11.5px;
  font-weight: 700;
}
.gate-chip.ok {
  background: var(--grn-soft);
  color: var(--grn-ink);
  border-color: rgba(0, 180, 42, 0.22);
}
.gate-chip.bad {
  background: var(--red-soft);
  color: var(--red-ink);
  border-color: rgba(245, 63, 63, 0.25);
}

.kv-mini {
  font-size: 12px;
  color: var(--ink2);
  display: grid;
  gap: 4px;
  line-height: 1.45;
}
.kv-mini span {
  color: var(--mute);
  font-weight: 700;
}

.desens-shield {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--grn-soft);
  color: var(--grn-ink);
  font-size: 11.5px;
  line-height: 1.45;
}
.internal-secret-box {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 12px;
  line-height: 1.45;
}

.ticket-banner {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 12px;
  display: grid;
  gap: 3px;
}
.ticket-banner.done {
  background: var(--grn-soft);
  color: var(--grn-ink);
}

.sub-label {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--mute);
}
.collab-btns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.internal-console {
  margin-top: 4px;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--panel-alt);
  border: 1px dashed var(--line);
  display: grid;
  gap: 8px;
}
.ic-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}
.link-mini {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--pri);
}
.ic-form {
  display: flex;
  gap: 6px;
}
.ic-form input,
.ic-release-box input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: 12px;
}
.ic-release-box {
  display: grid;
  gap: 6px;
}

.help-mini {
  font-size: 12px;
  color: var(--ink2);
  display: grid;
  gap: 6px;
  line-height: 1.45;
}
</style>
