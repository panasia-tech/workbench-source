<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">到货防损与资金安全红线 · 10×N分钟全检显示拒签 · 17:00去留清零 · 10分钟站点召回 · 企微微信群直连</div>
        <h1>快递驻点协调与企微召回<Q k="courier" /></h1>
        <p class="sub">
          严控三道硬时效：① 送 <b>N 票货必须在 10×N 分钟内</b>（如 10 票 = 100 分钟）全检完并让问题件<b>显示拒签</b>供采购议价；② 采购议妥留货件<b>10 分钟内从站点/待退区紧急召回</b>（回仓前硬锁死打款，防卖家收钱后反手操控退回）；③ 每日 <b>17:00 前</b>完成全部快件去留清零。
        </p>
      </div>
      <div class="acts">
        <button class="btn pri" :disabled="locked" @click="newBatchModal = true">+ 登记新送达快递批次（10分钟/票开表）</button>
        <button class="btn" @click="openHelp('courier')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 顶部四张时效与防损指标卡 -->
    <div class="sla-strip">
      <div class="sla-card" :class="activeBatch ? 'amb' : 'grn'" @click="tab = 'batch'">
        <div class="sc-top">
          <span class="tag" :class="activeBatch ? 'amb' : 'grn'">① 批次 10×N 分钟拒签时效</span>
          <b class="mono" style="font-size:18px;color:var(--amb)">{{ activeBatch ? fmtMinSec(activeBatch.remainingSec) : '全部达标' }}</b>
        </div>
        <b>{{ activeBatch ? `${activeBatch.carrier} ${activeBatch.parcelCount} 票 = ${activeBatch.slaMinutes} 分钟内验完` : '今日到货批次已 100% 按时验完' }}</b>
        <span class="muted">瑕疵件必须巴枪挂出「显示拒签」，采购才能向卖家议价</span>
      </div>

      <div class="sla-card" :class="pendingRecallCount ? 'red' : 'grn'" @click="tab = 'recall'">
        <div class="sc-top">
          <span class="tag" :class="pendingRecallCount ? 'red' : 'grn'">② 10分钟站点紧急召回</span>
          <b class="mono" style="font-size:18px" :style="{ color: pendingRecallCount ? 'var(--red)' : 'var(--grn)' }">
            {{ activeRecall ? fmtMinSec(activeRecall.remainingSec) : '0 待召回' }}
          </b>
        </div>
        <b>{{ pendingRecallCount ? `${pendingRecallCount} 票议妥件待从站点追回 · 打款已硬锁` : '所有议妥快件已安全追回入仓' }}</b>
        <span class="muted">防打款进个人账户后卖家随意操控退回导致钱货两空</span>
      </div>

      <div class="sla-card" :class="pendingEodCount ? 'amb' : 'grn'" @click="tab = 'eod'">
        <div class="sc-top">
          <span class="tag" :class="pendingEodCount ? 'amb' : 'grn'">③ 当日 17:00 去留清零</span>
          <b style="font-size:18px">{{ pendingEodCount }} 票待定</b>
        </div>
        <b>{{ pendingEodCount ? `17:00 晚班发车前须拍板剩余 ${pendingEodCount} 票去留` : '今日全部暂存/拒签快件去留已清零' }}</b>
        <span class="muted">严禁悬而未决快件拖过下午 5 点晚班装车线</span>
      </div>

      <div class="sla-card acc">
        <div class="sc-top">
          <span class="tag acc">④ 企微×微信互通群接口</span>
          <span class="tag grn">● Webhook 在线</span>
        </div>
        <b>微信群直连顺丰 / 京东 / 圆通业务员</b>
        <span class="muted">群内自动 @快递员 发拒签/召回令，微信回复自动回调写单</span>
      </div>
    </div>

    <!-- 主体双栏：左三轨实操台 + 右侧企微×微信外部互通群实时会话窗 -->
    <div class="cc-grid">
      <div class="cc-left">
        <div class="seg" style="margin-bottom:14px">
          <button :class="{ on: tab === 'recall' }" @click="tab = 'recall'">
            <i class="dot" :class="pendingRecallCount ? 'red' : 'grn'"></i>🚨 10分钟站点紧急召回（防钱货两空）<em>{{ cc.urgentRecalls.length }}</em>
          </button>
          <button :class="{ on: tab === 'batch' }" @click="tab = 'batch'">
            <i class="dot amb"></i>批次 10×N 分钟全检与显示拒签<em>{{ cc.batches.length }}</em>
          </button>
          <button :class="{ on: tab === 'eod' }" @click="tab = 'eod'">
            <i class="dot" :class="pendingEodCount ? 'amb' : 'grn'"></i>下午 17:00 快件去留清零<em>{{ cc.eodItems.length }}</em>
          </button>
        </div>

        <!-- TAB A：10分钟站点/待退快件紧急召回（防钱货两空硬锁） -->
        <div v-if="tab === 'recall'" style="display:grid;gap:14px">
          <div class="why-box red">
            <b>为什么采购回馈后必须 10 分钟内召回？</b>
            二手 3C 个人交易中，我方货款直接打入卖家支付宝或点确认收货后立即到对方账上；若此时快件仍在顺丰/京东站点或挂着退回状态，<b>卖家收到钱后可随时在快递小程序点「催派退回/确认退回」操控快件退走，造成钱货两空！</b>因此未完成 10 分钟物理召回前，系统强制锁死打款放行！
          </div>

          <section
            v-for="rc in cc.urgentRecalls"
            :key="rc.id"
            class="card rc-card"
            :class="rc.status === 'RECALLED_SAFE' ? 'grn' : 'red'"
          >
            <div class="rc-head">
              <div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <span class="badge-l" :class="rc.status === 'RECALLED_SAFE' ? 'grn' : 'red'">
                    {{ rc.status === 'RECALLED_SAFE' ? '✓ 已安全召回入仓 · 允许结算' : `🚨 10分钟生死召回倒计时 ${fmtMinSec(rc.remainingSec)}` }}
                  </span>
                  <span class="tag dark mono">{{ rc.carrier }} {{ rc.trackingNo }}</span>
                  <span class="tag">{{ rc.courierWechat }}</span>
                </div>
                <h2 style="font-size:18.5px;margin:8px 0 4px">{{ rc.model }}（<code>#{{ rc.skuCode }}</code>）</h2>
                <p class="muted" style="font-size:13px">
                  采购回馈（{{ rc.feedbackAt }} · {{ rc.purchaser }}）：<b>{{ rc.agreedDeal }}</b>
                </p>
              </div>
              <span class="tag" :class="rc.paymentReleaseLocked ? 'red' : 'grn'" style="font-size:12.5px;padding:6px 10px">
                {{ rc.paymentReleaseLocked ? '🔒 采购打款/确认收货已硬锁死' : '🔓 实物在仓 · 打款锁已解除' }}
              </span>
            </div>

            <div class="rc-loc">
              <b>当前快件物理位置：</b>{{ rc.currentPhysicalLoc }}
            </div>

            <!-- 三步闭环进度与操作 -->
            <div class="rc-steps">
              <div class="rcs-item" :class="{ ok: rc.wecomAlertSent }">
                <span class="tag" :class="rc.wecomAlertSent ? 'grn' : 'red'">第 1 步</span>
                <b>企微微信群强 @业务员 下发 10 分钟拦截令</b>
                <p class="muted">采购议妥瞬间秒推微信群，超 3 分钟未回自动升级语音电话提醒</p>
                <button v-if="rc.status !== 'RECALLED_SAFE'" class="btn sm pri" :disabled="locked" @click="pushWecomUrgentRecall10Min(rc)">
                  <Icon name="chat" />再次企微强催 @快递员
                </button>
              </div>

              <div class="rcs-item" :class="{ ok: Boolean(rc.courierAckedAt) }">
                <span class="tag" :class="rc.courierAckedAt ? 'grn' : 'amb'">第 2 步</span>
                <b>驻点业务员微信群回执「已拦下撤回退件」</b>
                <p v-if="rc.courierAckedAt" style="font-size:12px;color:var(--grn);font-weight:600">
                  ✓ {{ rc.courierAckedAt }} 回调写入：{{ rc.courierAckText }}
                </p>
                <p v-else class="muted">等待快递员在微信群回复「已拦下」或上传巴枪撤销退回截图</p>
                <button
                  v-if="!rc.courierAckedAt && rc.status !== 'RECALLED_SAFE'"
                  class="btn sm"
                  :disabled="locked"
                  @click="simulateCourierWecomInterceptReply(rc)"
                >⚡ 模拟顺丰小哥微信回「已拦下」</button>
              </div>

              <div class="rcs-item" :class="{ ok: rc.backInWhConfirmed }">
                <span class="tag" :class="rc.backInWhConfirmed ? 'grn' : 'red'">第 3 步</span>
                <b>实物追回仓内扫码 · 解除采购打款防损锁</b>
                <p class="muted">确认货已回到自己手里且巴枪改妥投签收，才通知采购安全打款</p>
                <span v-if="rc.backInWhConfirmed" class="tag grn">✓ 已回仓入账并安全解锁结算</span>
                <Lock
                  v-else
                  :ok="Boolean(rc.courierAckedAt) && !locked"
                  :reason="locked ? '先做完首日练习' : '尚未收到驻点快递员微信群「已拦下撤回退件」回执（可先点第2步模拟按钮），严禁提前解锁给卖家打款！'"
                  kind="sm ok"
                  @go="confirmRecallBackInWarehouse(rc)"
                >扫码确认实物已回仓 · 解锁打款</Lock>
              </div>
            </div>
          </section>
        </div>

        <!-- TAB B：批次 10×N 分钟全检与「显示拒签」协同 -->
        <div v-else-if="tab === 'batch'" style="display:grid;gap:14px">
          <div class="why-box amb">
            <b>批次 10×N 分钟全检与「显示拒签」铁律：</b>例如快递员一次送来 <b>10 票货 = 100 分钟内</b>必须全部拆封验完！凡有暗病/碎裂/货不对板的快件，必须在时限内让快递员巴枪挂出官方<b>「显示拒签（留站暂缓退回）」</b>轨迹——<b>只有物流显示拒签，我方采购去和个人卖家议价才有主动权！</b>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button
              v-for="b in cc.batches"
              :key="b.id"
              class="btn sm"
              :class="{ pri: curBatch?.id === b.id }"
              @click="selectedBatchId = b.id"
            >
              {{ b.id }} · {{ b.carrier }}（{{ b.parcelCount }}票 = {{ b.slaMinutes }}分钟 · {{ b.status === 'COMPLETED' ? '✓已达标' : fmtMinSec(b.remainingSec) }}）
            </button>
          </div>

          <section v-if="curBatch" class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
              <div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <span class="tag dark">{{ curBatch.carrier }} · {{ curBatch.id }}</span>
                  <span class="tag acc">送达 {{ curBatch.parcelCount }} 票 × 10分钟 = 限 {{ curBatch.slaMinutes }} 分钟验完</span>
                  <span class="tag" :class="curBatch.status === 'COMPLETED' ? 'grn' : 'red'">
                    {{ curBatch.status === 'COMPLETED' ? '✓ 整批已按时全检并分流完毕' : `⏱ 剩余 ${fmtMinSec(curBatch.remainingSec)}` }}
                  </span>
                </div>
                <p class="muted" style="font-size:12.5px;margin-top:4px">
                  到仓时间：{{ curBatch.arrivedAt }} · 对接业务员：{{ curBatch.courierName }}（{{ curBatch.courierWechat }}）
                </p>
              </div>
              <div style="text-align:right;font-size:12.5px">
                已闭环 <b>{{ resolvedCountOf(curBatch) }} / {{ curBatch.parcelCount }}</b> 票
              </div>
            </div>

            <div class="bar" style="height:8px;margin-bottom:12px">
              <i :style="{ width: Math.round((resolvedCountOf(curBatch) / curBatch.parcelCount) * 100) + '%', background: curBatch.status === 'COMPLETED' ? 'var(--grn)' : 'var(--acc)' }"></i>
            </div>

            <div class="parcel-list">
              <div
                v-for="p in curBatch.parcels"
                :key="p.trackingNo"
                class="parcel-row"
                :class="p.trajectoryState === 'REFUSED_SHOWN' ? 'amb' : p.trajectoryState === 'SIGNED_OK' ? 'grn' : 'red'"
              >
                <div style="min-width:0;flex:1">
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <b class="mono">{{ p.trackingNo }}</b>
                    <b>{{ p.model }}</b>
                    <span class="muted" style="font-size:12px">采购：{{ p.purchaser }}</span>
                    <span class="tag" :class="trajTag(p).cls">{{ trajTag(p).text }}</span>
                  </div>
                  <p class="muted" style="font-size:12px;margin-top:3px">
                    验货情况：{{ p.issueSummary }} · <span>{{ p.note }}</span>
                  </p>
                </div>

                <div style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">
                  <button
                    v-if="p.trajectoryState === 'WAIT_REFUSE_SYNC'"
                    class="btn sm bad"
                    :disabled="locked"
                    @click="syncParcelRefusalToWecom(curBatch, p)"
                  >
                    <Icon name="chat" />企微推群让小哥挂「显示拒签」
                  </button>
                  <template v-else-if="p.trajectoryState === 'UNDECIDED'">
                    <button class="btn sm ok" :disabled="locked" @click="completeRemainingBatchParcel(curBatch, p, false)">✓ 验完无瑕·通知签收</button>
                    <button class="btn sm bad" :disabled="locked" @click="completeRemainingBatchParcel(curBatch, p, true)">✕ 检出问题·推群挂拒签</button>
                  </template>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- TAB C：当日下午 17:00 前全量快件最终去留清零台 -->
        <div v-else style="display:grid;gap:14px">
          <div class="why-box amb">
            <b>每日 17:00 快件去留清零死线：</b>每天下午 5 点快递网点晚班装车发往分拨中心前，全仓所有暂存、挂拒签议价中的快件必须 100% 明确<b>「议妥改签留仓」或「谈崩正式退回」</b>，一键向企微快递群下发日清总对账单，绝不留隔夜糊涂账！
          </div>

          <section class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
              <h3 style="margin:0">今日暂存 / 拒签待定去留快件清单（死线：今日 17:00）</h3>
              <Lock
                :ok="pendingEodCount === 0 && !locked"
                :reason="locked ? '先做完首日练习' : `还有 ${pendingEodCount} 票快件未拍板最终去留，请先在下方点定案按钮后再发 17:00 总对账单！`"
                kind="pri"
                @go="pushEod1700SummaryToWecom"
              >
                <Icon name="chat" />{{ cc.eodSheetPushedAt ? `已推送(${cc.eodSheetPushedAt}) · 重发17:00去留总单` : '一键向企微群发送《17:00 快件去留清场总单》' }}
              </Lock>
            </div>

            <div class="parcel-list">
              <div
                v-for="item in cc.eodItems"
                :key="item.id"
                class="parcel-row"
                :class="item.decision === 'PENDING' ? 'red' : 'grn'"
              >
                <div style="min-width:0;flex:1">
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <span class="tag" :class="item.decision === 'PENDING' ? 'red' : item.decision === 'KEEP_AND_SIGN' ? 'grn' : 'acc'">
                      {{ item.decision === 'PENDING' ? '! 待17:00前定去留' : item.decision === 'KEEP_AND_SIGN' ? '✓ 定案：改签留仓' : '↩ 定案：确认退回发走' }}
                    </span>
                    <b class="mono">{{ item.carrier }} {{ item.trackingNo }}</b>
                    <b>{{ item.model }}</b>
                  </div>
                  <p class="muted" style="font-size:12px;margin-top:4px">
                    当前位置：{{ item.currentHoldLoc }} · 采购（{{ item.purchaser }}）反馈：<b>{{ item.negotiationState }}</b>
                  </p>
                </div>

                <div v-if="item.decision === 'PENDING'" style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">
                  <button class="btn sm ok" :disabled="locked" @click="setEodParcelDecision(item, 'KEEP_AND_SIGN')">议妥改签留仓</button>
                  <button class="btn sm bad" :disabled="locked" @click="setEodParcelDecision(item, 'RETURN_TO_SELLER')">确认退回发走</button>
                </div>
                <span v-else class="muted mono" style="font-size:12px">定案于 {{ item.decidedAt }}</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <!-- 右栏：企业微信 × 微信外部互通群实时会话与接口面板 -->
      <aside class="cc-right">
        <section class="card wecom-panel">
          <div class="wp-top">
            <div>
              <span class="tag grn">企微外部互通群 · 微信直连</span>
              <h3 style="margin:5px 0 2px;font-size:15px">{{ cc.groupName }}</h3>
              <p class="muted" style="font-size:11.5px">顺丰/京东/圆通业务员直接在个人微信群收指令并回执，无需装额外软件</p>
            </div>
          </div>

          <div class="wecom-feed">
            <div
              v-for="m in cc.wecomFeed"
              :key="m.id"
              class="wc-msg"
              :class="m.dir === 'IN_COURIER' ? 'in' : 'out'"
            >
              <div class="wc-meta">
                <b>{{ m.sender }}</b>
                <span class="tag" :class="m.tag.includes('🚨') ? 'red' : m.dir === 'IN_COURIER' ? 'grn' : 'acc'">{{ m.tag }}</span>
                <span class="mono muted">{{ m.time }}</span>
              </div>
              <div class="wc-bubble">
                <b v-if="m.mention" style="color:var(--acc)">{{ m.mention }} </b>{{ m.content }}
              </div>
            </div>
          </div>

          <!-- 手动快捷 @驻点业务员 发消息 -->
          <div class="wc-send">
            <select v-model="quickMention" class="inp" style="min-height:32px;padding:4px 8px;font-size:12px">
              <option value="@顺丰-王建军(（演示号码已隐藏）)">@顺丰-王建军</option>
              <option value="@京东-陈海涛(（演示号码已隐藏）)">@京东-陈海涛</option>
              <option value="@圆通-刘强(（演示号码已隐藏）)">@圆通-刘强</option>
            </select>
            <input
              v-model="quickMsg"
              class="inp"
              style="flex:1;min-width:120px;min-height:32px;padding:4px 8px;font-size:12.5px"
              placeholder="输入协调指令推至微信互通群…"
              @keydown.enter="sendCustomWecom"
            />
            <button class="btn sm pri" :disabled="locked" @click="sendCustomWecom">推企微群</button>
          </div>

          <div class="wc-api-note">
            <b>程序员企微对接契约：</b><br />
            · 群发推送：<code>POST /api/wecom/courier-bot</code>（企微外部群应用消息 / 客户群机器人卡片 + 超3分钟未回执调语音提醒）<br />
            · 微信回调：<code>POST {{ cc.callbackEndpoint }}</code>（解析快递员回复中的运单号与「已拒签 / 已拦下」自动写回工单）
          </div>
        </section>
      </aside>
    </div>

    <!-- 新建快递送达批次弹窗 -->
    <div v-if="newBatchModal" class="mask" @click.self="newBatchModal = false">
      <div class="modal" role="dialog" aria-label="登记新送达快递批次">
        <h3>登记新送达快递批次（自动按 10 分钟 / 票核算死线）</h3>
        <label>
          快递公司与驻点业务员
          <select v-model="batchForm.preset" class="inp">
            <option value="SF">顺丰速运 · 王建军（@顺丰-王建军 （演示号码已隐藏））</option>
            <option value="JD">京东快递 · 陈海涛（@京东-陈海涛 （演示号码已隐藏））</option>
            <option value="YT">圆通速递 · 刘强（@圆通-刘强 （演示号码已隐藏））</option>
          </select>
        </label>
        <label>
          本批送达包裹票数 N（系统自动设定 <b>{{ (Number(batchForm.count) || 10) * 10 }} 分钟</b> 内完成全部验货与显示拒签）
          <input v-model.number="batchForm.count" type="number" min="1" max="30" class="inp mono" />
        </label>
        <div class="mfoot">
          <button class="btn" @click="newBatchModal = false">取消</button>
          <button class="btn pri" @click="submitNewBatch">立即开表并推送企微微信群</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  currentUser,
  openHelp,
  notify,
  appendWecomFeed,
  createCourierArrivalBatch,
  syncParcelRefusalToWecom,
  completeRemainingBatchParcel,
  pushWecomUrgentRecall10Min,
  simulateCourierWecomInterceptReply,
  confirmRecallBackInWarehouse,
  setEodParcelDecision,
  pushEod1700SummaryToWecom
} from '../store/warehouseStore.js'

const cc = computed(() => store.data.courierCoord || { batches: [], urgentRecalls: [], eodItems: [], wecomFeed: [] })
const locked = computed(() => !currentUser.value.practiceDone)

const tab = ref(store.routeParam?.startsWith('CBAT-') ? 'batch' : store.routeParam?.startsWith('EOD-') ? 'eod' : 'recall')
const selectedBatchId = ref(cc.value.batches[0]?.id || '')

watch(() => store.routeParam, (v) => {
  if (!v) return
  if (v.startsWith('CBAT-')) {
    tab.value = 'batch'
    selectedBatchId.value = v
  } else if (v.startsWith('RCL-')) {
    tab.value = 'recall'
  }
})

const curBatch = computed(() => cc.value.batches.find(b => b.id === selectedBatchId.value) || cc.value.batches[0] || null)
const activeBatch = computed(() => cc.value.batches.find(b => b.status === 'IN_PROGRESS') || null)
const activeRecall = computed(() => cc.value.urgentRecalls.find(r => r.status !== 'RECALLED_SAFE') || null)
const pendingRecallCount = computed(() => cc.value.urgentRecalls.filter(r => r.status !== 'RECALLED_SAFE').length)
const pendingEodCount = computed(() => cc.value.eodItems.filter(i => i.decision === 'PENDING').length)

function fmtMinSec(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const m = String(Math.floor(s / 60)).padStart(2, '0')
  const r = String(s % 60).padStart(2, '0')
  return `${m}:${r}`
}

function resolvedCountOf(b) {
  return (b.parcels || []).filter(p => p.inspectDone && (p.trajectoryState === 'SIGNED_OK' || p.trajectoryState === 'REFUSED_SHOWN')).length
}

function trajTag(p) {
  if (p.trajectoryState === 'REFUSED_SHOWN') return { cls: 'amb', text: '✓ 轨迹已显示拒签（采购议价中）' }
  if (p.trajectoryState === 'SIGNED_OK') return { cls: 'grn', text: '✓ 无瑕已正常签收' }
  if (p.trajectoryState === 'WAIT_REFUSE_SYNC') return { cls: 'red', text: '! 待推企微让小哥挂拒签' }
  return { cls: 'red', text: '待验货分流' }
}

const quickMention = ref('@顺丰-王建军(（演示号码已隐藏）)')
const quickMsg = ref('')
function sendCustomWecom() {
  if (!quickMsg.value.trim()) return notify('请输入要发送到企微快递群的内容', 'err')
  appendWecomFeed({
    dir: 'OUT_BOT',
    tag: '仓管人工协同',
    sender: `仓管 · ${currentUser.value.name}`,
    mention: quickMention.value,
    content: quickMsg.value.trim()
  })
  quickMsg.value = ''
  notify('已推送至企微×微信外部互通快递群！', 'ok')
}

const newBatchModal = ref(false)
const batchForm = reactive({ preset: 'SF', count: 10 })
function submitNewBatch() {
  const map = {
    SF: { carrier: '顺丰速运', courierName: '王建军（顺丰龙华大浪驻点）', courierWechat: '@顺丰-王建军(（演示号码已隐藏）)' },
    JD: { carrier: '京东快递', courierName: '陈海涛（京东大浪营业部）', courierWechat: '@京东-陈海涛(（演示号码已隐藏）)' },
    YT: { carrier: '圆通速递', courierName: '刘强（圆通龙华网点）', courierWechat: '@圆通-刘强(（演示号码已隐藏）)' }
  }
  const picked = map[batchForm.preset] || map.SF
  const created = createCourierArrivalBatch({ ...picked, parcelCount: batchForm.count })
  if (created) {
    selectedBatchId.value = created.id
    tab.value = 'batch'
    newBatchModal.value = false
  }
}
</script>

<style scoped>
.sla-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 14px 0 16px;
}
.sla-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top: 3px solid var(--acc);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 5px;
  cursor: pointer;
  min-width: 0;
}
.sla-card.red { border-top-color: var(--red); background: #fffafa; }
.sla-card.amb { border-top-color: var(--amb); }
.sla-card.grn { border-top-color: var(--grn); }
.sla-card b { font-size: 13.5px; }
.sla-card .muted { font-size: 11.5px; line-height: 1.4; }
.sc-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }

.cc-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.95fr);
  gap: 16px;
  align-items: start;
}
.cc-left, .cc-right { min-width: 0; }

.rc-card.red { border: 2px solid #dc2626; background: #fffdfd; }
.rc-card.grn { border-left: 4px solid var(--grn); }
.rc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.rc-loc {
  margin: 10px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--soft);
  font-size: 13px;
}
.rc-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.rcs-item {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 12px;
  display: grid;
  gap: 6px;
  align-content: start;
  font-size: 12.5px;
  min-width: 0;
  overflow: hidden;
}
.rcs-item :deep(.btn) {
  white-space: normal;
  height: auto;
  line-height: 1.35;
}
.rcs-item.ok { background: #f4fbf7; border-color: #bfead3; }

.parcel-list { display: grid; gap: 9px; }
.parcel-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 13px;
  border: 1px solid var(--line);
  border-left: 4px solid var(--acc);
  border-radius: 9px;
  background: var(--bg);
}
.parcel-row.red { border-left-color: var(--red); background: #fffafa; }
.parcel-row.amb { border-left-color: var(--amb); }
.parcel-row.grn { border-left-color: var(--grn); }

.wecom-panel { display: grid; gap: 12px; position: sticky; top: 14px; }
.wp-top { border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.wecom-feed {
  display: grid;
  gap: 10px;
  max-height: 440px;
  overflow-y: auto;
  padding-right: 4px;
}
.wc-msg { display: grid; gap: 4px; font-size: 12.5px; }
.wc-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; }
.wc-bubble {
  padding: 9px 11px;
  border-radius: 9px;
  background: #f1f6ff;
  border: 1px solid #cfe0ff;
  line-height: 1.5;
}
.wc-msg.in .wc-bubble {
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.wc-send { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding-top: 8px; border-top: 1px solid var(--line); }
.wc-api-note {
  font-size: 11.5px;
  color: var(--mute);
  background: var(--soft);
  border-radius: 8px;
  padding: 8px 10px;
  line-height: 1.55;
}
@media (max-width: 1200px) {
  .sla-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cc-grid { grid-template-columns: 1fr; }
  .rc-steps { grid-template-columns: 1fr; }
}
</style>
