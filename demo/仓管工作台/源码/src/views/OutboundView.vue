<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">日常标准化 WMS · 波次路径拣货 · 子母四码防漏防串 · 拣货后紧急拦截归架</div>
        <h1>波次拣货与出库<Q k="outbound" /></h1>
        <p class="sub">
          承接「订单抓取与聚合」波次单：按<b>最优库位路径拣货</b>、打包台执行<b>「主机码 + #BAG附件袋副码 + #BOX原盒副码 + 原厂SN」四码逐一扫绿</b>；若拣出后买家退单/改址，扫码瞬间触发<b>红屏蜂鸣强拦截并双扫码退回原储位</b>。
        </p>
      </div>
      <div class="acts">
        <button class="btn" @click="store.pdaOpen = true"><Icon name="pda" />打开 PDA 走动拣货端</button>
        <button class="btn" @click="go('orders')"><Icon name="inbox" />回订单池组新波次 ›</button>
        <button class="btn" @click="openHelp('outbound')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <div class="seg" style="margin:16px 0">
      <button :class="{ on: tab === 'ship' }" @click="tab = 'ship'">
        <i class="dot red"></i>波次拣货 · 四码复核 · 拦截归架<em>{{ store.data.outbounds.length }}</em>
      </button>
      <button :class="{ on: tab === 'pickup' }" @click="tab = 'pickup'">
        <i class="dot amb"></i>同城自提五步接待<em>{{ store.data.pickups.length }}</em>
      </button>
      <button :class="{ on: tab === 'return' }" @click="tab = 'return'">
        <i class="dot amb"></i>买家退回三代影像复验<em>{{ store.data.returns.length }}</em>
      </button>
    </div>

    <!-- 一、波次拣货路径单 + 子母四码复核 + 拣货后紧急拦截归架 -->
    <template v-if="tab === 'ship'">
      <!-- 顶部：波次最短路径拣货单 -->
      <section v-if="store.data.pickingWaves?.length" class="wave-panel">
        <div class="wp-head">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="tag dark">当前波次拣货路径单</span>
            <button
              v-for="wv in store.data.pickingWaves"
              :key="wv.waveNo"
              class="btn sm"
              :class="{ pri: curWave?.waveNo === wv.waveNo }"
              @click="selectedWaveNo = wv.waveNo"
            >
              {{ wv.waveNo }}（{{ wv.routeStops.length }} 站）
            </button>
            <span v-if="curWave" class="muted" style="font-size:12.5px">
              创建：{{ curWave.createdAt }} · {{ curWave.carrierGroup }} · 已按货架由近及远 + 分格箱 LPN 自动排序
            </span>
          </div>
          <button v-if="curWave" class="btn sm" @click="notify(`已发送波次拣货路径单 ${curWave.waveNo} 至工位打印机（演示）`, 'ok')">
            <Icon name="printer" />打印波次拣货单
          </button>
        </div>

        <div v-if="curWave" class="route-stops">
          <div
            v-for="st in curWave.routeStops"
            :key="st.seq + st.skuCode"
            class="stop-chip"
            :class="{ done: st.picked }"
            @click="st.picked = !st.picked"
          >
            <span class="seq">{{ st.seq }}</span>
            <div>
              <b class="mono">库位 {{ st.loc }}</b> · <span class="mono">#{{ st.skuCode }}</span>
              <div class="muted" style="font-size:11.5px">{{ st.model.slice(0, 24) }}（{{ st.orderNo }}）</div>
            </div>
            <span class="tag" :class="st.picked ? 'grn' : 'acc'">{{ st.picked ? '✓ 已拣' : '点此拣出' }}</span>
          </div>
        </div>
      </section>

      <div class="cols-split">
        <div class="ob-list">
          <article
            v-for="o in store.data.outbounds"
            :key="o.id"
            class="ob-card"
            :class="[obLvl(o), { sel: selOb?.id === o.id }]"
            @click="selectOb(o.id)"
          >
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <span class="tag" :class="obLvl(o)">{{ obTag(o) }}</span>
              <span class="mono muted" style="font-size:12px">{{ o.orderNo }}</span>
            </div>
            <h3>{{ o.model }}</h3>
            <p class="muted" style="font-size:12px;margin-top:4px">
              <span v-if="o.waveNo" class="mono">[{{ o.waveNo }}] </span>{{ o.shop }} · {{ o.buyer }}
            </p>
            <div v-if="o.subOrderNos && o.subOrderNos.length > 1" style="margin-top:5px">
              <span class="tag acc">合单共包裹：{{ o.subOrderNos.join(' + ') }}</span>
            </div>
            <p class="why-box" :class="obLvl(o)" style="margin-top:8px;padding:6px 9px;font-size:12px">{{ obWhy(o) }}</p>
          </article>
        </div>

        <section v-if="selOb" class="card ob-det">
          <div class="ob-top">
            <img :src="selOb.thumb" alt="" class="ob-thumb" />
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span class="badge-l" :class="obLvl(selOb)">{{ LV[obLvl(selOb)].icon }} {{ obTag(selOb) }}</span>
                <span class="tag dark">锁定单件 {{ selOb.skuCode }}</span>
                <span class="tag">原库位 {{ selOb.locationCode }}</span>
                <span v-if="selOb.waveNo" class="tag acc">{{ selOb.waveNo }}</span>
              </div>
              <h2 style="font-size:20px;margin:8px 0 4px">{{ selOb.model }}</h2>
              <p class="muted" style="font-size:13px">
                订单 {{ selOb.orderNo }}
                <template v-if="selOb.subOrderNos?.length > 1">（含合单子单 {{ selOb.subOrderNos.join('、') }}）</template>
                · 买家 {{ selOb.buyer }} · 时限：<b>{{ selOb.deadline }}</b>
              </p>
            </div>
          </div>

          <!-- 🚨 拣货后紧急拦截红屏蜂鸣阻断 + 自动生成待归架单闭环 -->
          <div
            v-if="selOb.emergencyIntercept || selOb.addressChanged || selOb.status === 'BLOCKED_NEW_ISSUE'"
            class="intercept-alarm"
            :class="{ triggered: selOb.emergencyAlertTriggered }"
          >
            <div class="ia-head">
              <div>
                <span class="tag red">🚨 拣货后紧急拦截 · 严禁贴单出库</span>
                <h3 style="margin:6px 0 3px;font-size:16.5px;color:#991b1b">
                  订单 {{ selOb.orderNo }} 在拣出后触发平台退款/改址或新瑕疵拦截，电子面单通道已硬锁死！
                </h3>
                <p style="font-size:12.5px;color:#7f1d1d">
                  拦截原因：{{ selOb.pausedReason || '买家在拣货完成后发起退单/改址申请' }} ·
                  <b>防桌底积压黑货铁律：</b>被拦截实物严禁随手塞在打包台桌底，必须当场执行下方<b>「双扫码退回原货架」</b>才算销账！
                </p>
              </div>
              <button class="btn bad sm" :disabled="locked" @click="doScanCode(selOb.skuCode)">
                🚨 模拟打包台扫码触发红屏蜂鸣阻断
              </button>
            </div>

            <div class="ia-return-box">
              <div style="font-size:13px;font-weight:700;color:#1e293b">
                待归架任务单：请将实物 <code class="mono">#{{ selOb.skuCode }}</code> 退回原储位 <code class="mono">LOC-{{ selOb.returnShelfBin || selOb.locationCode }}</code>
              </div>
              <div class="ia-inputs">
                <input v-model="returnForm.scannedSku" class="inp mono" placeholder="① 扫被拦截商品码" />
                <input v-model="returnForm.scannedBin" class="inp mono" :placeholder="`② 扫原货架库位码 LOC-${selOb.returnShelfBin || selOb.locationCode}`" />
                <button class="btn sm" :disabled="locked" @click="prefillAndReturn(selOb)">⚡ 一键双扫码退回原货架并释放锁库</button>
                <button class="btn sm pri" :disabled="locked" @click="submitReturnShelf(selOb)">核验双码归架</button>
              </div>
            </div>
          </div>

          <div v-else-if="selOb.status === 'RETURNED_TO_SHELF'" class="why-box grn" style="margin:14px 0">
            <b>✓ 拣货后拦截件已完成双扫码归架闭环：</b>实物 <code>#{{ selOb.skuCode }}</code> 已退回原储位 <code>{{ selOb.returnShelfBin || selOb.locationCode }}</code>，锁库已自动释放恢复可售，零桌底积压！
          </div>

          <div v-else class="why-box amb" style="margin:14px 0">
            <b>入库披露与买家确认状态：</b>{{ selOb.disclosedDefect }}（买家确认时间：{{ selOb.customerConfirmedAt }}）
          </div>

          <!-- 打包前发现新瑕疵或买家改址：一键暂停退回销售 -->
          <div v-if="selOb.status !== 'SHIPPED' && selOb.status !== 'RETURNED_TO_SHELF'" class="pause-bar">
            <div>
              <b>打包前发现新增划痕 / 配件缺失 / 买家改地址？</b>
              <p class="muted" style="font-size:12px">严禁按旧放行资格强发！暂停后自动撤销本次出库资格并推回销售 {{ selOb.salesOwner }} 重新与买家确认。</p>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <input v-model="pauseNote" placeholder="写明新问题或改址说明" style="padding:6px 10px;border:1px solid var(--line);border-radius:6px;width:230px;font-size:12.5px" />
              <button class="btn bad sm" :disabled="locked" @click="pauseOutboundForIssue(selOb, pauseNote || selOb.pausedReason || '出库前复核异常暂停')">暂停出库并退回销售重核</button>
            </div>
          </div>

          <div class="check-grid">
            <!-- 升级：一机多码（主码 + #BAG附件袋 + #BOX原盒 + 原厂SN）逐一激光扫绿 -->
            <div class="ck-box span2">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                <h4>1 & 2. 一机多码齐套防漏发 · 激光逐一扫绿（主机码 + #BAG附件袋 + #BOX原盒 + 原厂SN）</h4>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  <button class="btn sm pri" :disabled="locked || selOb.status === 'SHIPPED' || selOb.status === 'RETURNED_TO_SHELF'" @click="scanAllFourCodes(selOb)">
                    ⚡ 模拟激光连扫四码全绿
                  </button>
                  <button class="btn sm" :disabled="locked || selOb.status === 'SHIPPED'" @click="doScanCode('910000000002')">
                    模拟扫错隔壁同款（触发红闪蜂鸣）
                  </button>
                </div>
              </div>

              <div class="multicode-grid">
                <div
                  v-for="(chk, key) in activeScanChecks"
                  :key="key"
                  class="mc-pill"
                  :class="{ ok: chk.scanned }"
                >
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                    <span class="tag" :class="chk.scanned ? 'grn' : 'amb'">{{ chk.scanned ? '✓ 已扫绿' : '待扫码' }}</span>
                    <span class="muted" style="font-size:11.5px">取件位：{{ chk.loc }}</span>
                  </div>
                  <b style="font-size:13px">{{ chk.label }}</b>
                  <code class="mono mc-code">{{ chk.code }}</code>
                  <button
                    v-if="!chk.scanned && selOb.status !== 'SHIPPED' && selOb.status !== 'RETURNED_TO_SHELF'"
                    class="btn sm ghost"
                    :disabled="locked"
                    @click="doScanCode(chk.code)"
                  >🔫 激光扫此码</button>
                </div>
              </div>

              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">
                <input
                  v-model="scanInput"
                  class="inp mono"
                  style="flex:1;min-width:220px;min-height:34px;padding:6px 10px"
                  placeholder="支持硬件激光扫码枪免聚焦直扫，或在此输入条码回车核验…"
                  @keydown.enter="doScanCode(scanInput)"
                />
                <button class="btn sm" :disabled="locked" @click="doScanCode(scanInput)">回车核验条码</button>
              </div>

              <p v-if="selOb.scannedCode && !selOb.scanVerified && !isAllMultiScanned" class="why-box amb" style="margin-top:4px">
                当前最近扫描：<code class="mono">{{ selOb.scannedCode }}</code> · 请把上方 4 项子母码与机身 SN 全部扫绿后方可解锁面单发货（硬防漏发电源线/附件袋与串件）！
              </p>
              <p v-else-if="selOb.scanVerified && isAllMultiScanned" class="why-box grn" style="margin-top:4px">
                ✓ 主机码 + 编号附件袋 #BAG + 原盒/合单件 #BOX + 机身原厂 SN 四码核验 100% 齐套一致！
              </p>
            </div>

            <div class="ck-box">
              <h4>3. 出库品相复核与封箱录像可读确认</h4>
              <label><input type="checkbox" v-model="selOb.conditionRechecked" :disabled="selOb.status === 'SHIPPED' || selOb.status === 'RETURNED_TO_SHELF'" />当前外观与入库披露一致，无新增未确认磕碰</label>
              <label><input type="checkbox" v-model="selOb.packVideoRecorded" :disabled="selOb.status === 'SHIPPED' || selOb.status === 'RETURNED_TO_SHELF'" />已全程录制气泡柱加固与封箱贴单视频</label>
              <label><input type="checkbox" v-model="selOb.packVideoReadable" :disabled="selOb.status === 'SHIPPED' || selOb.status === 'RETURNED_TO_SHELF'" />已回放确认打包视频清晰可读（非黑屏坏片）</label>
            </div>

            <div class="ck-box">
              <h4>4. 选用包材 · 打印热敏电子面单 · 揽收出库</h4>
              <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px">
                <label style="display:grid;gap:4px;font-size:12px;font-weight:600;min-width:0">
                  打包耗材型号（出库自动扣减）
                  <select v-model="selOb.packMaterialCode" class="inp" style="min-height:32px;padding:4px 8px;font-size:12px;min-width:0" :disabled="selOb.status === 'SHIPPED'">
                    <option v-for="pm in store.data.packingMaterials" :key="pm.code" :value="pm.code">
                      {{ pm.name.slice(0, 14) }}（余 {{ pm.stock }}{{ pm.unit }}）
                    </option>
                  </select>
                </label>
                <label style="display:grid;gap:4px;font-size:12px;font-weight:600;min-width:0">
                  快递电子运单号
                  <input v-model="selOb.waybillNo" class="inp mono" style="min-height:32px;padding:4px 8px;font-size:12.5px;min-width:0" placeholder="打印面单自动取号" />
                </label>
              </div>

              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">
                <button class="btn sm" :disabled="locked || selOb.addressChanged || selOb.emergencyIntercept || selOb.status === 'RETURNED_TO_SHELF'" @click="openWaybillPreview(selOb)">
                  <Icon name="printer" />{{ selOb.waybillPrinted ? '预览重打热敏电子面单' : '取号并打印热敏电子面单' }}
                </button>
                <span v-if="selOb.waybillPrinted" class="tag grn">✓ 三段码面单已就绪</span>
              </div>

              <div style="margin-top:6px">
                <span v-if="selOb.status === 'SHIPPED'" class="tag grn">✓ 已完成齐套扫码出库 · 运单 {{ selOb.waybillNo }} 已回写店铺</span>
                <span v-else-if="selOb.status === 'RETURNED_TO_SHELF'" class="tag grn">✓ 拦截件已双扫码退回原储位 {{ selOb.returnShelfBin || selOb.locationCode }}</span>
                <Lock
                  v-else
                  :ok="shipCheck.ok"
                  :reason="shipCheck.why"
                  penalty="确认出库后自动扣减包材耗材、记录 WMS 出库流水，并将运单号同步回写订单聚合池与平台店铺。"
                  @go="confirmShipOutbound(selOb)"
                >确认四码齐套无误 · 放行发货出库</Lock>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>

    <!-- 二、同城自提五步接待 -->
    <div v-else-if="tab === 'pickup'" class="pickup-wrap">
      <section v-for="p in store.data.pickups" :key="p.id" class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
          <div>
            <span class="tag amb">同城自提预约 · 取货码 {{ p.pickupCode }}</span>
            <h3 style="margin:6px 0 2px;font-size:19px">{{ p.model }}（货号 <code>{{ p.skuCode }}</code> · 库位 {{ p.locationCode }}）</h3>
            <p class="muted" style="font-size:13px">{{ p.buyer }} · {{ p.appointment }} · 对接销售：{{ p.salesOwner }}</p>
          </div>
          <div class="why-box amb">
            <b>自提三条铁律：</b>① 客户严禁进仓库货架区；② 1楼接待区由客户自行验货，仓管绝不议价谈钱；③ 装车过半当场点确认收货。
          </div>
        </div>

        <div class="pkp-steps">
          <div v-for="(s, idx) in p.steps" :key="s.n" class="pkp-card" :class="{ done: s.done }">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="tag" :class="s.done ? 'grn' : 'acc'">第 {{ s.n }} 步</span>
              <span v-if="s.done" class="tag grn">✓ 已完成</span>
            </div>
            <b>{{ s.title }}</b>
            <p class="muted" style="font-size:12.5px">{{ s.desc }}</p>
            <Lock
              v-if="!s.done"
              :ok="(idx === 0 || p.steps[idx - 1].done) && !locked"
              :reason="locked ? '先做完练习' : `请先完成第 ${idx} 步「${p.steps[idx - 1]?.title}」`"
              kind="sm pri"
              @go="advancePickupStep(p, idx)"
            >完成此步</Lock>
          </div>
        </div>
      </section>
    </div>

    <!-- 三、买家退回三代影像同屏比对与独立复验（G10） -->
    <div v-else class="return-wrap">
      <section v-for="r in store.data.returns" :key="r.id" class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div>
            <div style="display:flex;gap:8px;align-items:center">
              <span class="badge-l" :class="r.recheckDone ? 'grn' : 'amb'">{{ r.recheckDone ? '✓ 已完成独立复验' : '! 待三代影像独立复验' }}</span>
              <span class="tag">退回单 {{ r.returnNo }}</span>
              <span class="tag">原订单 {{ r.origOrderNo }}</span>
            </div>
            <h2 style="font-size:20px;margin:8px 0 4px">{{ r.model }}（<code>{{ r.skuCode }}</code> · SN {{ r.sn }}）</h2>
            <p class="muted" style="font-size:13px">买家退货理由：{{ r.buyerReason }} · 签收运单：{{ r.returnWaybill }}</p>
          </div>
          <span class="tag grn">机身 SN 三码核对一致（非调包件）</span>
        </div>

        <div class="gen3-grid">
          <div class="gen-box">
            <b>① 原入库全检影像（底档）</b>
            <img :src="r.generationPhotos.inboundOrig" alt="原入库影像" />
          </div>
          <div class="gen-box">
            <b>② 原发货封箱影像（出库前完好证明）</b>
            <img :src="r.generationPhotos.outboundOrig" alt="原发货影像" />
          </div>
          <div class="gen-box">
            <b>③ 本次买家退回拆封复验影像</b>
            <img :src="r.generationPhotos.returnNow" alt="本次退回影像" />
          </div>
        </div>

        <div class="ret-form">
          <div class="rf-left">
            <label>
              本次退回独立复验实测结论（必填，严禁照抄上次入库结论！）
              <textarea v-model="retForm.summary" :disabled="r.recheckDone" placeholder="例如：本次退回实测音量开至85%以上确有低频共振杂音，且底部防滑脚垫少1颗；与原发货前状态存在差异，建议转入待修区检修，不直接恢复可售。"></textarea>
            </label>
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:6px;font-size:13px">
                回库目标分位：
                <select v-model="retForm.targetZone" :disabled="r.recheckDone" style="padding:6px 10px;border:1px solid var(--line);border-radius:6px">
                  <option value="待修/送修中">待修/送修中（不可售）</option>
                  <option value="异常隔离（不可售）">异常隔离（不可售）</option>
                  <option value="已复核可售">已复核可售（须确认全功能完好）</option>
                </select>
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
                <input type="checkbox" v-model="retForm.needUpstreamClaim" :disabled="r.recheckDone" />
                属原采购隐藏暗病，需单独推送原采购向卖家追偿（与买家售后分开结案 G10）
              </label>
            </div>
          </div>

          <div class="rf-right">
            <div class="why-box amb" style="margin-bottom:10px">
              <b>G10 双线独立结案说明：</b><br />
              · 买家售后线：{{ r.customerAftersaleState }}<br />
              · 原采购追偿线：{{ r.upstreamClaimState }}
            </div>
            <span v-if="r.recheckDone" class="tag grn">✓ 已归档至「{{ r.restockZone }}」：{{ r.recheckSummary }}</span>
            <Lock
              v-else
              :ok="Boolean(retForm.summary.trim().length >= 6) && !locked"
              :reason="locked ? '先做完 3 个练习' : '还没录入本次独立复验实测结论（至少 6 个字），退回件严禁免检或照抄原入库结论直接回架！'"
              @go="submitCustomerReturnRecheck(r, retForm)"
            >提交本次独立复验结论并分位回库</Lock>
          </div>
        </div>
      </section>
    </div>

    <!-- 100×150mm 标准热敏电子面单预览弹窗 -->
    <div v-if="waybillModalOb" class="mask" @click.self="waybillModalOb = null">
      <div class="modal" role="dialog" aria-label="热敏电子面单打印预览">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>100×150mm 热敏电子面单预览</h3>
          <span class="tag amb">云打印模拟联</span>
        </div>
        <div class="wb-sheet">
          <div class="wb-row1">
            <b>{{ waybillModalOb.carrier || '顺丰速运 · 标快' }}</b>
            <span class="mono" style="font-size:22px;font-weight:900">{{ waybillModalOb.routeCode || '755-SZ-01' }}</span>
          </div>
          <div class="wb-bar">
            <svg viewBox="0 0 280 42" width="260" height="40" aria-hidden="true">
              <rect v-for="i in 42" :key="i" :x="i * 6.2" y="2" :width="(i % 3) + 1.6" height="36" fill="#111" />
            </svg>
            <div class="mono" style="font-size:15px;font-weight:800;letter-spacing:1.5px">{{ waybillModalOb.waybillNo }}</div>
          </div>
          <div class="wb-sec">
            <b>收：</b>{{ waybillModalOb.buyer }}<br />
            <span>{{ waybillModalOb.receiverAddr || '深圳市演示区默认收货处' }}</span>
          </div>
          <div class="wb-sec">
            <b>寄：</b>泛亚演示仓 WH01 · 深圳市演示区样本仓
          </div>
          <div class="wb-sec" style="border-bottom:0">
            <b>配货明细（核对防漏）：</b><br />
            · 主单 {{ waybillModalOb.orderNo }}：#{{ waybillModalOb.skuCode }}（库位 {{ waybillModalOb.locationCode }}） + {{ waybillModalOb.bagCode }}<br />
            <template v-if="waybillModalOb.extraItems?.length">
              · 合单共发：{{ waybillModalOb.extraItems.map(x => `${x.orderNo} #${x.skuCode}(${x.locationCode})`).join('；') }}
            </template>
          </div>
        </div>
        <div class="mfoot">
          <button class="btn" @click="waybillModalOb = null">关闭预览</button>
          <button class="btn pri" @click="waybillModalOb = null; notify('热敏打印机已吐纸 1 张（100×150mm），请贴于外箱正面！', 'ok')">
            <Icon name="printer" />确认出纸打印
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import { onGlobalBarcodeScan } from '../utils/scannerAudio.js'
import {
  store,
  LV,
  currentUser,
  go,
  openHelp,
  notify,
  pauseOutboundForIssue,
  confirmShipOutbound,
  advancePickupStep,
  submitCustomerReturnRecheck,
  printOutboundThermalWaybill,
  ensureOutboundScanChecks,
  scanOutboundMultiCode,
  completeInterceptReturnToShelf
} from '../store/warehouseStore.js'

const tab = ref(store.routeParam?.startsWith('RET-') ? 'return' : store.routeParam?.startsWith('PKP-') ? 'pickup' : 'ship')
const selectedObId = ref(store.data.outbounds[0]?.id || '')
const selectedWaveNo = ref(store.data.pickingWaves?.[0]?.waveNo || '')
const scanInput = ref('')
const pauseNote = ref('')
const waybillModalOb = ref(null)
const returnForm = reactive({ scannedSku: '', scannedBin: '' })

const curWave = computed(() =>
  (store.data.pickingWaves || []).find(w => w.waveNo === selectedWaveNo.value) || store.data.pickingWaves?.[0] || null
)

watch(() => store.data.pickingWaves?.length, () => {
  if (store.data.pickingWaves?.length) selectedWaveNo.value = store.data.pickingWaves[0].waveNo
  if (store.data.outbounds?.length) selectedObId.value = store.data.outbounds[0].id
})

watch(() => store.routeParam, (v) => {
  if (!v) return
  if (v.startsWith('RET-')) tab.value = 'return'
  else if (v.startsWith('PKP-')) tab.value = 'pickup'
  else if (store.data.outbounds.some(o => o.id === v)) {
    tab.value = 'ship'
    selectedObId.value = v
  }
})

const selOb = computed(() => store.data.outbounds.find(o => o.id === selectedObId.value) || store.data.outbounds[0])
const locked = computed(() => !currentUser.value.practiceDone)

const activeScanChecks = computed(() => ensureOutboundScanChecks(selOb.value))
const isAllMultiScanned = computed(() => {
  const chks = Object.values(activeScanChecks.value || {})
  return chks.length > 0 && chks.every(c => !c || c.scanned)
})

function selectOb(id) {
  selectedObId.value = id
  scanInput.value = ''
  returnForm.scannedSku = ''
  returnForm.scannedBin = ''
}

function doScanCode(code) {
  if (!selOb.value) return
  scanInput.value = code
  scanOutboundMultiCode(selOb.value, code)
}

function scanAllFourCodes(ob) {
  if (!ob) return
  const chks = ensureOutboundScanChecks(ob)
  for (const k of Object.keys(chks)) {
    if (chks[k] && !chks[k].scanned) {
      const ok = scanOutboundMultiCode(ob, chks[k].code)
      if (!ok) break
    }
  }
}

function prefillAndReturn(ob) {
  if (!ob) return
  const bin = ob.returnShelfBin || ob.locationCode || 'A-10'
  returnForm.scannedSku = ob.skuCode
  returnForm.scannedBin = `LOC-${bin}`
  completeInterceptReturnToShelf(ob, returnForm)
}

function submitReturnShelf(ob) {
  completeInterceptReturnToShelf(ob, returnForm)
}

function openWaybillPreview(ob) {
  if (printOutboundThermalWaybill(ob)) {
    waybillModalOb.value = ob
  }
}

let offWedge = null
onMounted(() => {
  offWedge = onGlobalBarcodeScan((code) => {
    if (store.pdaOpen || store.route !== 'outbound' || tab.value !== 'ship') return
    doScanCode(code)
  })
})
onBeforeUnmount(() => {
  if (offWedge) offWedge()
})

function obLvl(o) {
  if (o.status === 'SHIPPED' || o.status === 'RETURNED_TO_SHELF') return 'grn'
  return 'red'
}
function obTag(o) {
  if (o.status === 'SHIPPED') return '已出库回传'
  if (o.status === 'RETURNED_TO_SHELF') return '拦截已归架'
  if (o.status === 'PAUSED_TO_SALES') return '已暂停退销售'
  if (o.emergencyIntercept || o.status === 'BLOCKED_NEW_ISSUE' || o.addressChanged) return '🚨 拣后紧急拦截'
  return '17:00 待四码复核'
}
function obWhy(o) {
  if (o.status === 'SHIPPED') return `已四码齐套出库 · 运单 ${o.waybillNo} 已回写店铺`
  if (o.status === 'RETURNED_TO_SHELF') return `拦截件已双扫码退回原货架 ${o.returnShelfBin || o.locationCode} 并释放锁库`
  if (o.status === 'PAUSED_TO_SALES') return `已撤销旧放行资格退回销售：${o.pausedReason}`
  if (o.emergencyIntercept || o.addressChanged || o.status === 'BLOCKED_NEW_ISSUE') return o.pausedReason
  return `待扫绿「主机码 + #BAG附件袋 + #BOX原盒 + 原厂SN」四码防漏防串`
}

const shipCheck = computed(() => {
  const o = selOb.value
  if (!o) return { ok: false, why: '未选择订单' }
  if (locked.value) return { ok: false, why: '先去「学」完成 3 个练习' }
  if (o.status === 'RETURNED_TO_SHELF') return { ok: false, why: '该单已拦截归架结案' }
  if (o.status === 'PAUSED_TO_SALES') return { ok: false, why: '已暂停出库并退回销售重核，等销售拿到买家新确认后再发' }
  if (o.emergencyIntercept || o.addressChanged || o.status === 'BLOCKED_NEW_ISSUE') {
    return { ok: false, why: '该订单已被紧急拦截锁定！严禁打单发货，请完成上方「双扫码退回原货架」' }
  }
  if (!isAllMultiScanned.value || !o.scanVerified) {
    const missing = Object.values(activeScanChecks.value || {}).filter(c => c && !c.scanned).map(c => c.label)
    return {
      ok: false,
      why: `打包台四码齐套尚未扫完（还缺：${missing.join('、') || '主副码核验'}），防止漏发电源线/附件袋或串件！`
    }
  }
  const obSku = (store.data.skus || []).find(s => s.code === o.skuCode)
  if (obSku && obSku.hasLithiumBattery && obSku.sealBranch !== 'SEALED_NEW' && ((obSku.daysSincePowerOn || 0) >= 30 || obSku.powerOffVerified === false)) {
    return {
      ok: false,
      why: `🔋 锂电防损硬拦截：本机距上次通电已 ${obSku.daysSincePowerOn} 天（或未核验关机），严禁盲发亏电黑屏机！请先去「锂电30天统筹」完成通电唤醒复测后再打包`
    }
  }
  if (!o.conditionRechecked || !o.packVideoRecorded || !o.packVideoReadable) {
    return { ok: false, why: '第 3 步还没勾完：请确认外观无新增问题、已录封箱视频并回放确认可读' }
  }
  if (!o.waybillNo?.trim()) {
    return { ok: false, why: '第 4 步还没取号打印快递电子运单号' }
  }
  return { ok: true, why: '' }
})

const retForm = reactive({
  summary: '实测音量开至90%确有轻微低频共振，底部防滑脚垫少1颗；属售出期间损耗，转入待修区更换脚垫与检测单元。',
  targetZone: '待修/送修中',
  needUpstreamClaim: false
})
</script>

<style scoped>
.wave-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 13px 16px;
  margin-bottom: 14px;
}
.wp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.route-stops {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 11px;
}
.stop-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
}
.stop-chip.done {
  background: #f4fbf7;
  border-color: #bfead3;
}
.stop-chip .seq {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--acc);
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 12px;
}
.stop-chip.done .seq { background: var(--grn); }

.ob-list { display: grid; gap: 10px; }
.ob-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 4px solid var(--red);
  border-radius: 10px;
  padding: 13px 15px;
  cursor: pointer;
}
.ob-card.grn { border-left-color: var(--grn); }
.ob-card.sel { box-shadow: 0 0 0 2px var(--acc); background: #fafcff; }
.ob-card h3 { font-size: 14.5px; margin-top: 6px; font-weight: 700; }

.ob-top { display: flex; gap: 16px; align-items: center; }
.ob-thumb { width: 120px; height: 90px; border-radius: 9px; object-fit: cover; border: 1px solid var(--line); flex: none; }

.intercept-alarm {
  margin: 14px 0;
  padding: 14px 16px;
  background: #fef2f2;
  border: 2px solid #dc2626;
  border-radius: 11px;
  display: grid;
  gap: 12px;
}
.intercept-alarm.triggered {
  box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.22);
}
.ia-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.ia-return-box {
  background: #fff;
  border: 1px solid #fecaca;
  border-radius: 9px;
  padding: 11px 13px;
  display: grid;
  gap: 9px;
}
.ia-inputs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.ia-inputs .inp {
  min-height: 34px;
  padding: 6px 10px;
  font-size: 12.5px;
  width: 205px;
}

.pause-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 14px;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 14px;
  font-size: 13px;
}

.check-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.ck-box { background: var(--soft); border: 1px solid var(--line); border-radius: 9px; padding: 13px 14px; display: grid; gap: 8px; align-content: start; min-width: 0; }
.ck-box.span2 { grid-column: 1 / -1; }
.ck-box h4 { font-size: 14px; margin-bottom: 2px; }
.ck-box label { display: flex; align-items: flex-start; gap: 7px; font-size: 13px; cursor: pointer; line-height: 1.45; }

.multicode-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
}
.mc-pill {
  background: #fff;
  border: 1.5px dashed #cbd5e1;
  border-radius: 9px;
  padding: 10px 11px;
  display: grid;
  gap: 5px;
  align-content: start;
  min-width: 0;
}
.mc-pill.ok {
  background: #f0fdf4;
  border: 1.5px solid #22c55e;
}
.mc-code {
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 5px;
  background: #f1f5f9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pkp-steps { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.pkp-card { background: var(--soft); border: 1px solid var(--line); border-radius: 9px; padding: 12px; display: grid; gap: 7px; align-content: start; font-size: 13px; }
.pkp-card.done { background: #f4fbf7; border-color: #bfead3; }

.gen3-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.gen-box { background: var(--soft); border: 1px solid var(--line); border-radius: 9px; padding: 10px; display: grid; gap: 8px; font-size: 13px; }
.gen-box img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 6px; }

.ret-form { display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; padding-top: 12px; border-top: 1px solid var(--line); align-items: start; }
.rf-left { display: grid; gap: 10px; font-size: 13px; font-weight: 600; }
.rf-left textarea { width: 100%; min-height: 82px; margin-top: 5px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; font-weight: 450; }

.wb-sheet {
  border: 2px solid #17233b;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
  font-size: 12.5px;
}
.wb-row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 2px solid #17233b;
  background: #f8fafc;
}
.wb-bar {
  padding: 10px 12px;
  text-align: center;
  border-bottom: 1.5px solid #17233b;
  display: grid;
  justify-items: center;
  gap: 4px;
}
.wb-sec {
  padding: 8px 12px;
  border-bottom: 1px dashed #94a3b8;
  line-height: 1.5;
}
@media (max-width: 1180px) {
  .multicode-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
