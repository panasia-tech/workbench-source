<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">日常与非标融合 · 爱回收问卷转化版（只做客观结构化验货与留证，不算回收成交报价）</div>
        <h1>收货验货<Q k="inspect" /></h1>
        <p class="sub">
          按<b>「拆封前起录 → 爱回收式分步分级问卷（区分原封未拆与二手机 · 坏货全检） → 三种图与子母副码 → 回放确认入库」</b>推进；每步带图文判别图例，自动汇总明显瑕疵清单。
        </p>
      </div>
      <div class="acts">
        <span class="tag acc">已接入 1,042 条爱回收机型超集标准</span>
        <button class="btn" @click="go('legacy-wash')"><Icon name="spark" />历史库存阻塞画廊 ›</button>
        <button class="btn" @click="openHelp('inspect')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 待验包裹 / 历史补检选择条 -->
    <div class="pkg-strip">
      <button
        v-for="item in store.data.inspections"
        :key="item.id"
        class="pkg-pill"
        :class="{ on: insp?.id === item.id, done: item.submitted }"
        @click="selectInsp(item.id)"
      >
        <span class="dot" :class="item.submitted ? 'grn' : (!item.recordingStarted || summaryInfoOf(item).unsetCount > 0 || !summaryInfoOf(item).multiReady ? 'red' : 'amb')"></span>
        <div style="min-width:0">
          <b>{{ item.brand }} {{ item.model }}</b>
          <small>
            #{{ item.skuCode }} ·
            {{
              item.submitted
                ? '✓ 已验归档'
                : item.ahsAnswers?.usage_mode?.val === 'SEALED_NEW'
                  ? '原封未拆防后封分支'
                  : !item.recordingStarted
                    ? '待拆封前起录'
                    : summaryInfoOf(item).unsetCount > 0 || !summaryInfoOf(item).multiReady
                      ? `待测完剩余步骤`
                      : `检出 ${summaryInfoOf(item).defectList.length} 项瑕疵 · 待归档`
            }}
          </small>
        </div>
      </button>
    </div>

    <div v-if="insp" class="insp-wrap">
      <div v-if="insp.recall24h" class="why-box amb" style="margin-bottom:12px">
        <b>⚡ 急售/历史清零优先件：</b>销售与客服正在等本件结构化全检结论与完整视频上架（但严禁跳过任何一步适用检查！）。
      </div>

      <!-- 步入式 4 步进度条 -->
      <ol class="clean-steps" data-tour="insp-steps">
        <li :class="{ passed: insp.recordingStarted, current: !insp.recordingStarted }">
          <span>{{ insp.recordingStarted ? '✓' : '1' }}</span>
          <div><b>1. 拆封前开启顶拍录制</b><p>先拍面单封口再动刀</p></div>
        </li>
        <li :class="{ passed: stepsAllDone, current: insp.recordingStarted && !stepsAllDone }">
          <span>{{ stepsAllDone ? '✓' : '2' }}</span>
          <div><b>2. 爱回收式分步分级全检</b><p>已完成 {{ answeredStepCount }}/{{ totalStepCount }} 步</p></div>
        </li>
        <li :class="{ passed: photosReady, current: stepsAllDone && !photosReady }">
          <span>{{ photosReady ? '✓' : '3' }}</span>
          <div><b>3. 三种图与 #BAG/#BOX 副码</b><p>实拍/瑕疵/库位分离</p></div>
        </li>
        <li :class="{ passed: insp.submitted, current: photosReady && !insp.submitted }">
          <span>{{ insp.submitted ? '✓' : '4' }}</span>
          <div><b>4. 回放核验可读并分位归档</b><p>自动输出瑕疵摘要</p></div>
        </li>
      </ol>

      <div class="insp-grid">
        <!-- 左栏：高拍仪录像 + 三种图与子母副码 + 自动瑕疵汇总单与提交锁 -->
        <div class="insp-side">
          <section class="card">
            <h3>
              第 1 步：顶拍高拍仪全程录像
              <span class="tag" :class="insp.recordingStarted ? 'grn' : 'red'">
                {{ insp.recordingStarted ? `● REC ${insp.recordingStartedAt}` : '未起录' }}
              </span>
            </h3>
            <div class="cam-box">
              <img :src="insp.unboxPreview" alt="高拍仪画面" />
            </div>
            <dl class="kv" style="margin:10px 0">
              <dt>关联单据</dt><dd>{{ insp.orderNo }} · <code>{{ insp.waybill }}</code></dd>
              <dt>采购申报</dt><dd>¥{{ insp.declaredPrice }}（{{ insp.purchaser }}）</dd>
              <dt>卖家描述</dt><dd>{{ insp.declaredSpec }}</dd>
            </dl>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <Lock
                v-if="!insp.recordingStarted"
                :ok="!locked"
                reason="先去「学」完成 3 个练习"
                kind="pri"
                @go="startUnboxRecording(insp)"
              >开始拆封前录制（先拍面单封口）</Lock>
              <button
                v-else-if="!insp.playbackVerified"
                class="btn ok"
                :disabled="locked"
                @click="finishAndVerifyRecording(insp)"
              >结束录制并回放 3 秒确认可读</button>
              <span v-else class="tag grn">✓ 完整实测视频已回放确认清晰可读</span>
              <button class="btn sm" @click="gapModal = true">登记录像中断缺口</button>
            </div>
            <p v-if="insp.interruptGap" class="why-box amb" style="margin-top:10px">
              已如实登记录像中断：{{ insp.interruptGap }}（自动标记需仓管主管复核，严禁塞回盒子假装重拆）
            </p>
          </section>

          <section class="card">
            <h3>第 3 步：三种图归槽 + 一机多码（#BAG / #BOX 子母副码）</h3>
            <div class="photo-tri">
              <div class="pt-col">
                <b>本件实拍 ({{ insp.realPhotos.length }})</b>
                <img v-if="insp.realPhotos[0]" :src="insp.realPhotos[0]" alt="" />
                <div v-else class="pt-empty">待拍本件实拍</div>
                <Lock
                  :ok="insp.recordingStarted && !locked"
                  :reason="locked ? '先做完练习' : '请先在上面点「开始拆封前录制」'"
                  kind="sm"
                  @go="captureInspectionPhoto(insp, 'real')"
                >+ 拍实拍图</Lock>
              </div>
              <div class="pt-col">
                <b>瑕疵微距 ({{ insp.defectPhotos.length }})</b>
                <img v-if="insp.defectPhotos[0]" :src="insp.defectPhotos[0]" alt="" />
                <div v-else class="pt-empty">检出瑕疵必拍</div>
                <Lock
                  :ok="insp.recordingStarted && !locked"
                  :reason="locked ? '先做完练习' : '先开启拆封前录制'"
                  kind="sm"
                  @go="captureInspectionPhoto(insp, 'defect')"
                >+ 拍瑕疵特写</Lock>
              </div>
              <div class="pt-col">
                <b>库位同框 ({{ insp.locationPhotos.length }})</b>
                <img v-if="insp.locationPhotos[0]" :src="insp.locationPhotos[0]" alt="" />
                <div v-else class="pt-empty">含#BAG袋同框</div>
                <Lock
                  :ok="insp.recordingStarted && !locked"
                  :reason="locked ? '先做完练习' : '先开启拆封前录制'"
                  kind="sm"
                  @go="captureInspectionPhoto(insp, 'location')"
                >+ 拍库位图</Lock>
              </div>
            </div>

            <div class="bag-form">
              <label>
                专用附件袋副码（装入 LPN-BOX-01 分格箱，出库必扫）
                <div style="display:flex;gap:6px">
                  <input v-model="insp.bagCode" style="flex:1" placeholder="如 513211540040#BAG" />
                  <button class="btn sm" @click="insp.bagCode = `${insp.skuCode}#BAG`">生成 #BAG 副码</button>
                </div>
              </label>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <label>目标主机库位<input v-model="insp.locationCode" placeholder="如 A-06 或 D-01" /></label>
                <label>放行分位库区（自动校验）
                  <select v-model="insp.targetZone">
                    <option value="已复核可售">已复核可售</option>
                    <option value="异常隔离（不可售）">异常隔离（不可售）</option>
                    <option value="待议价（不可售）">待议价（不可售）</option>
                    <option value="待补证/待补测">待补证/待补测</option>
                  </select>
                </label>
              </div>
              <label class="ck-inline">
                <input type="checkbox" v-model="insp.hasOriginalBox" />
                带完好原装彩盒（自动打印 <code>{{ insp.skuCode }}#BOX</code> 原盒副码入 E-01 原盒架）
              </label>
            </div>
          </section>

          <!-- 自动生成的结构化瑕疵摘要（复刻爱回收“共N项明显瑕疵”，去除报价！） -->
          <section class="card summary-card" data-tour="insp-submit">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <h3 style="margin:0">第 4 步：验货结果摘要与分位归档</h3>
              <span class="tag dark">{{ curTree.version }}</span>
            </div>

            <div class="ahs-sum-box" :class="curSummary.defectList.length ? 'amb' : 'grn'">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                <b>
                  {{
                    curSummary.usageMode === 'SEALED_NEW'
                      ? '全新未拆封分支核验结果'
                      : curSummary.defectList.length
                        ? `共检出 ${curSummary.defectList.length} 项明显瑕疵`
                        : '✓ 已选项目 0 明显瑕疵'
                  }}
                </b>
                <span class="tag acc">综合评定：{{ curSummary.suggestGrade }}</span>
              </div>
              <ul v-if="curSummary.defectList.length" class="def-ul">
                <li v-for="(d, i) in curSummary.defectList" :key="i">• {{ d }}</li>
              </ul>
              <p v-else class="muted" style="font-size:12.5px;margin-top:4px">
                当前已测步骤均符合完好标准；仓管仅输出客观设备状态与瑕疵证据，不计算回收成交价。
              </p>
              <p v-if="curSummary.unableCount > 0" style="font-size:12px;color:var(--amb-ink);margin-top:4px">
                ! 含 {{ curSummary.unableCount }} 项「当前无法检测」挂起项（须入待补测区，不得误判合格）。
              </p>
            </div>

            <div v-if="insp.submitted" class="why-box grn" style="margin-top:10px">
              ✓ 本单已完成爱回收式结构化全检归档（{{ insp.locationCode }} · {{ insp.targetZone }}），历史阻塞关卡已同步点亮！
              <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn sm pri" @click="openItemDetail(insp.skuCode)">查看单件档案 ›</button>
                <button class="btn sm" @click="go('legacy-wash')">回历史清洗 Gallery ›</button>
                <button v-if="curSummary.hasMismatchOrCrack" class="btn sm bad" @click="go('anomaly')">去盯 10 分钟异常首报 ›</button>
              </div>
            </div>
            <div v-else style="margin-top:10px">
              <Lock
                :ok="submitCheck.ok"
                :reason="submitCheck.why"
                penalty="若检出货不对版或卖家隐瞒碎屏，归档后自动触发「10分钟三路异常首报」并锁入 D 区隔离柜。"
                kind="pri"
                @go="submitAihuishouInspection(insp, curSummary)"
              >提交结构化验货报告并分位入库</Lock>
            </div>
          </section>
        </div>

        <!-- 右主栏：爱回收式分步图文分级问卷（支持已答折叠 + 判别图例弹窗 + 多选功能异常） -->
        <section class="card ahs-panel">
          <div class="ahs-head">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="tag acc">{{ curTree.category }} · 锁定标准 {{ curTree.version }}</span>
                <span class="muted" style="font-size:12px">基准来源：{{ curTree.baselineStats.crawledModels }} 条机型问卷取最长超集</span>
              </div>
              <h3 style="margin:6px 0 3px">第 2 步：逐项分级验货问卷（已完成 {{ answeredStepCount }} / {{ totalStepCount }} 步）</h3>
              <p class="muted" style="font-size:12.5px">
                每步必选「正常分级 / 对应瑕疵等级 / 当前无法检测」，禁止留空默认正常；<b>发现碎屏或外观损坏仍必须测完后续全部安全步骤（坏货全检）</b>。
              </p>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn sm" @click="expandAll = !expandAll">
                {{ expandAll ? '折叠已选步骤' : '展开全部步骤' }}
              </button>
              <button
                v-if="insp.recordingStarted && !stepsAllDone && !insp.submitted"
                class="btn sm"
                @click="quickFillRemainingNormal"
              >演示快捷：剩余未填步按实测完好填入</button>
            </div>
          </div>

          <!-- 进度条 -->
          <div class="bar" style="height:8px;margin:10px 0 14px">
            <i :style="{ width: Math.round((answeredStepCount / Math.max(1, totalStepCount)) * 100) + '%', background: stepsAllDone ? 'var(--grn)' : 'var(--acc)' }"></i>
          </div>

          <div v-if="!insp.recordingStarted" class="why-box red" style="margin-bottom:12px">
            <b>灰色的原因：</b>尚未在左侧第 1 步开启「拆封前顶拍录制」，开启录像前禁止勾选验货问卷！
          </div>

          <!-- 全新未拆封独立分支提示横幅 -->
          <div v-if="usageMode === 'SEALED_NEW'" class="why-box amb" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <span>
              <b>📦 当前处于「全新包装未拆封」独立核验分支：</b>仅核验封签纤维、未激活SN与精准克重，严禁直接冒充已开箱测过内部功能！若现场决定拆封验机，请切回二手机全检分支。
            </span>
            <button class="btn sm" @click="pickStepOption(curTree.entryStep, curTree.entryStep.options[0])">改为拆封按二手机全检</button>
          </div>

          <!-- 分步卡片流（复刻爱回收已答折叠 + ✎修改 + ?查询方法图例） -->
          <div class="q-list">
            <div
              v-for="(st, idx) in activeSteps"
              :key="st.key"
              class="q-card"
              :class="stepVisualCls(st)"
            >
              <!-- 折叠摘要态（已选且非当前编辑步且未开启全部展开，且无待补必填项） -->
              <div
                v-if="isStepCollapsed(st, idx)"
                class="q-collapsed"
                @click="editingKey = st.key"
              >
                <div style="display:flex;align-items:center;gap:8px;min-width:0">
                  <span class="q-num ok">✓</span>
                  <b class="q-ttl">{{ st.title }}</b>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                  <span class="tag" :class="pickedOptOf(st)?.isDefect ? 'red' : pickedOptOf(st)?.isUnable ? 'amb' : 'grn'">
                    {{ pickedOptOf(st)?.label }}
                  </span>
                  <button class="btn sm ghost" @click.stop="editingKey = st.key">✎ 修改</button>
                </div>
              </div>

              <!-- 展开选择态 -->
              <div v-else class="q-expanded">
                <div class="qe-head">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span class="q-num" :class="{ ok: Boolean(ansOf(st.key).val) }">{{ ansOf(st.key).val ? '✓' : idx + 1 }}</span>
                    <b style="font-size:15px">{{ st.title }}</b>
                    <button
                      v-if="st.guideKey"
                      class="guide-btn"
                      @click="openGuide(st.guideKey)"
                    >🔍 判别图例 / 查询方法</button>
                  </div>
                  <button v-if="ansOf(st.key).val && editingKey === st.key" class="btn sm ghost" @click="editingKey = ''">收起</button>
                </div>

                <div class="opt-grid">
                  <button
                    v-for="opt in st.options"
                    :key="opt.val"
                    class="opt-btn"
                    :class="{
                      sel: ansOf(st.key).val === opt.val,
                      defect: ansOf(st.key).val === opt.val && opt.isDefect,
                      unable: ansOf(st.key).val === opt.val && opt.isUnable
                    }"
                    :disabled="!insp.recordingStarted || locked || insp.submitted"
                    @click="pickStepOption(st, opt)"
                  >
                    <span class="opt-radio"></span>
                    <div style="text-align:left;min-width:0">
                      <div style="font-weight:650;font-size:13.5px">{{ opt.label }}</div>
                      <div v-if="opt.desc" class="muted" style="font-size:12px;margin-top:2px">{{ opt.desc }}</div>
                    </div>
                    <span v-if="opt.isDefect" class="tag red" style="margin-left:auto">记入瑕疵</span>
                    <span v-else-if="opt.isUnable" class="tag amb" style="margin-left:auto">待补测</span>
                  </button>
                </div>

                <!-- 选中瑕疵项：补充部位说明与录像时间戳 -->
                <div v-if="pickedOptOf(st)?.isDefect" class="sr-extra red">
                  <input v-model="ansOf(st.key).note" placeholder="补充实测瑕疵位置与程度（如：右上角外屏碎裂2.2cm，内屏正常）" />
                  <input v-model="ansOf(st.key).videoTs" style="max-width:165px" placeholder="录像时间戳 如 00:01:28" />
                </div>

                <!-- 选中无法检测项：强制填原因+补测责任人 -->
                <div v-else-if="pickedOptOf(st)?.isUnable" class="sr-extra amb">
                  <input v-model="ansOf(st.key).unableReason" placeholder="必填：当前无法检测客观原因（如 缺FE卡口测试镜头）" />
                  <input v-model="ansOf(st.key).unableOwner" placeholder="必填：补测责任人与时限（如 赵建国 今日17:30前）" />
                </div>
              </div>
            </div>

            <!-- 最后一步：多选细分功能异常（复刻爱回收 E24 / E36 + 仓管防漏测显式确认） -->
            <div v-if="usageMode !== 'SEALED_NEW' && curTree.multiFaults?.length" class="q-card" :class="curSummary.multiReady ? 'done' : 'unset'">
              <div class="qe-head">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span class="q-num" :class="{ ok: curSummary.multiReady }">{{ curSummary.multiReady ? '✓' : activeSteps.length + 1 }}</span>
                  <b style="font-size:15px">{{ curTree.multiFaultsTitle }}</b>
                </div>
              </div>

              <div class="fault-chips">
                <button
                  v-for="mf in curTree.multiFaults"
                  :key="mf.code"
                  class="fault-chip"
                  :class="{ on: (insp.ahsMultiFaults || []).includes(mf.code) }"
                  :disabled="!insp.recordingStarted || locked || insp.submitted"
                  @click="toggleMultiFault(mf.code)"
                >
                  <span>{{ (insp.ahsMultiFaults || []).includes(mf.code) ? '✕ ' : '+ ' }}{{ mf.label }}</span>
                </button>
              </div>

              <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                <label class="ck-inline" style="font-size:13.5px;font-weight:650;color:var(--grn-ink)">
                  <input
                    type="checkbox"
                    :checked="insp.ahsMultiConfirmed && !(insp.ahsMultiFaults || []).length"
                    :disabled="!insp.recordingStarted || locked || insp.submitted || (insp.ahsMultiFaults || []).length > 0"
                    @change="confirmAllMultiNormal($event.target.checked)"
                  />
                  ✓ 已逐一实测以上全部 {{ curTree.multiFaults.length }} 项细分功能，确认均无异常（杜绝不测直接跳过）
                </label>
                <span v-if="(insp.ahsMultiFaults || []).length" class="tag red">
                  已勾选 {{ insp.ahsMultiFaults.length }} 项功能故障
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 爱回收式图文判别标准 / 查询方法弹窗（复刻 E06 / E20 / E28 / E33） -->
    <div v-if="activeGuide" class="mask" @click.self="activeGuide = null">
      <div class="modal big" role="dialog" aria-label="判别标准图例">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>🔍 {{ activeGuide.title }}</h3>
          <button class="btn sm" @click="activeGuide = null">关闭</button>
        </div>
        <p style="font-size:13.5px;line-height:1.55;color:var(--ink2)">{{ activeGuide.rule }}</p>
        <img :src="activeGuide.img" alt="判别标准示意图" style="width:100%;border-radius:10px;border:1px solid var(--line)" />
        <div class="mfoot">
          <button class="btn pri" @click="activeGuide = null">我已核对清楚</button>
        </div>
      </div>
    </div>

    <!-- 录像中断如实报备弹窗 -->
    <div v-if="gapModal && insp" class="mask" @click.self="gapModal = false">
      <div class="modal">
        <h3>如实登记录像中断缺口</h3>
        <p class="muted">高拍仪掉线或存储满导致中断时，严禁把拆开的货塞回盒子里假装重拆！如实写明缺失时间段并补拍连续特写，交主管复核。</p>
        <label>中断区间与补拍说明<textarea v-model="gapText" placeholder="例如：00:01:40–00:01:55 USB线松动中断15秒，重连后已对焦拍清机身序列号与封签"></textarea></label>
        <div class="mfoot">
          <button class="btn" @click="gapModal = false">取消</button>
          <button class="btn pri" @click="saveGap">保存并标记主管复核</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import { AIHUISHOU_TREES, AIHUISHOU_GUIDES } from '../data/aihuishouTrees.js'
import {
  store,
  currentUser,
  go,
  openItemDetail,
  openHelp,
  startUnboxRecording,
  logRecordingInterrupt,
  finishAndVerifyRecording,
  captureInspectionPhoto,
  submitAihuishouInspection
} from '../store/warehouseStore.js'

const selectedId = ref(store.routeParam || store.data.inspections[0]?.id || '')
const expandAll = ref(false)
const editingKey = ref('')
const activeGuide = ref(null)

watch(() => store.routeParam, (v) => {
  if (v && store.data.inspections.some(x => x.id === v)) selectedId.value = v
})

const insp = computed(() => store.data.inspections.find(x => x.id === selectedId.value) || store.data.inspections[0])
const locked = computed(() => !currentUser.value.practiceDone)

function ensureAhsFields(item) {
  if (!item) return
  if (!item.ahsAnswers) item.ahsAnswers = {}
  if (!Array.isArray(item.ahsMultiFaults)) item.ahsMultiFaults = []
  if (item.ahsMultiConfirmed === undefined) item.ahsMultiConfirmed = false
}

watch(insp, (v) => ensureAhsFields(v), { immediate: true })

function selectInsp(id) {
  selectedId.value = id
  editingKey.value = ''
}

const curTree = computed(() => AIHUISHOU_TREES[insp.value?.standardId] || AIHUISHOU_TREES['STD-MON'])
const usageMode = computed(() => insp.value?.ahsAnswers?.usage_mode?.val || '')

function activeStepsOf(item) {
  const tree = AIHUISHOU_TREES[item?.standardId] || AIHUISHOU_TREES['STD-MON']
  const mode = item?.ahsAnswers?.usage_mode?.val
  if (!mode) return [tree.entryStep]
  if (mode === 'SEALED_NEW') return [tree.entryStep, ...(tree.sealedSteps || [])]
  return [tree.entryStep, ...(tree.usedSteps || [])]
}

const activeSteps = computed(() => activeStepsOf(insp.value))

function ansOf(key) {
  ensureAhsFields(insp.value)
  if (!insp.value.ahsAnswers[key]) {
    insp.value.ahsAnswers[key] = { val: '', note: '', videoTs: '', unableReason: '', unableOwner: '' }
  }
  return insp.value.ahsAnswers[key]
}

function pickedOptOf(step, item = insp.value) {
  const val = item?.ahsAnswers?.[step.key]?.val
  if (!val) return null
  return step.options.find(o => o.val === val) || null
}

function pickStepOption(step, opt) {
  const a = ansOf(step.key)
  a.val = opt.val
  if (step.key === 'usage_mode' && opt.val === 'SEALED_NEW') {
    insp.value.ahsMultiFaults = []
    insp.value.ahsMultiConfirmed = true
  }
  if (!opt.isDefect && !opt.isUnable) {
    editingKey.value = ''
  } else {
    editingKey.value = step.key
    if (opt.isDefect && (opt.val.includes('CRACK') || opt.val.includes('MISMATCH') || opt.val.includes('WRONG') || opt.val.includes('BOOT_FAIL'))) {
      insp.value.targetZone = '异常隔离（不可售）'
    } else if (opt.isUnable) {
      insp.value.targetZone = '待补证/待补测'
    }
  }
}

function toggleMultiFault(code) {
  ensureAhsFields(insp.value)
  const arr = insp.value.ahsMultiFaults
  const i = arr.indexOf(code)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(code)
  insp.value.ahsMultiConfirmed = true
}

function confirmAllMultiNormal(checked) {
  ensureAhsFields(insp.value)
  if (checked) insp.value.ahsMultiFaults = []
  insp.value.ahsMultiConfirmed = checked
}

function summaryInfoOf(item) {
  ensureAhsFields(item)
  const tree = AIHUISHOU_TREES[item.standardId] || AIHUISHOU_TREES['STD-MON']
  const steps = activeStepsOf(item)
  const mode = item.ahsAnswers?.usage_mode?.val || ''
  let unsetCount = 0
  let unableCount = 0
  let invalidUnable = ''
  let hasMismatchOrCrack = false
  let suggestGrade = mode === 'SEALED_NEW' ? '全新原封未激活' : '98新·准新'
  const defectList = []

  if (!mode) {
    unsetCount = 1 + (tree.usedSteps?.length || 4)
  } else {
    for (const st of steps) {
      const a = item.ahsAnswers?.[st.key]
      const opt = st.options.find(o => o.val === a?.val)
      if (!opt) {
        unsetCount += 1
      } else {
        if (opt.suggestGrade) suggestGrade = opt.suggestGrade
        if (opt.isDefect) {
          defectList.push(`${st.title.replace(/^\d+\.\s*/, '')}：${opt.label}${a?.note ? `（${a.note}）` : ''}`)
          if (/CRACK|MISMATCH|WRONG|BOOT_FAIL|ACTIVATED|ABNORMAL|FAKE/.test(opt.val)) {
            hasMismatchOrCrack = true
          }
        }
        if (opt.isUnable) {
          unableCount += 1
          if (!a?.unableReason?.trim() || !a?.unableOwner?.trim()) {
            invalidUnable = st.title
          }
        }
      }
    }
  }

  for (const fc of item.ahsMultiFaults || []) {
    const mf = (tree.multiFaults || []).find(x => x.code === fc)
    if (mf) defectList.push(`功能异常：${mf.label}`)
  }
  if ((item.ahsMultiFaults || []).length > 0 && suggestGrade.includes('98') || suggestGrade.includes('99')) {
    if ((item.ahsMultiFaults || []).length > 0) suggestGrade = '功能微瑕·待披露'
  }

  const needMulti = mode !== 'SEALED_NEW' && Boolean(tree.multiFaults?.length)
  const multiReady = !needMulti || Boolean(item.ahsMultiConfirmed || (item.ahsMultiFaults || []).length > 0)

  return {
    usageMode: mode,
    unsetCount,
    unableCount,
    invalidUnable,
    hasMismatchOrCrack,
    suggestGrade,
    defectList,
    multiReady
  }
}

const curSummary = computed(() => summaryInfoOf(insp.value))
const totalStepCount = computed(() => {
  const base = activeSteps.value.length
  const extra = usageMode.value !== 'SEALED_NEW' && curTree.value.multiFaults?.length ? 1 : 0
  return Math.max(2, base + extra)
})
const answeredStepCount = computed(() => {
  const doneSingle = activeSteps.value.filter(st => Boolean(insp.value?.ahsAnswers?.[st.key]?.val)).length
  const doneMulti = usageMode.value !== 'SEALED_NEW' && curTree.value.multiFaults?.length && curSummary.value.multiReady ? 1 : 0
  return doneSingle + doneMulti
})
const stepsAllDone = computed(() => curSummary.value.unsetCount === 0 && curSummary.value.multiReady && !curSummary.value.invalidUnable)

function isStepCollapsed(st) {
  if (expandAll.value) return false
  if (editingKey.value === st.key) return false
  const opt = pickedOptOf(st)
  if (!opt) return false
  if (opt.isUnable) {
    const a = ansOf(st.key)
    if (!a.unableReason?.trim() || !a.unableOwner?.trim()) return false
  }
  return true
}

function stepVisualCls(st) {
  const opt = pickedOptOf(st)
  if (!opt) return 'unset'
  if (opt.isDefect) return 'fail'
  if (opt.isUnable) return 'unable'
  return 'done'
}

function quickFillRemainingNormal() {
  ensureAhsFields(insp.value)
  if (!insp.value.ahsAnswers.usage_mode?.val) {
    insp.value.ahsAnswers.usage_mode = { val: 'USED_OK', note: '开机正常' }
  }
  for (const st of activeStepsOf(insp.value)) {
    if (!insp.value.ahsAnswers[st.key]?.val) {
      const normalOpt = st.options.find(o => !o.isDefect && !o.isUnable) || st.options[0]
      insp.value.ahsAnswers[st.key] = { val: normalOpt.val, note: '实测正常' }
    }
  }
  insp.value.ahsMultiConfirmed = true
}

function openGuide(key) {
  activeGuide.value = AIHUISHOU_GUIDES[key] || null
}

const photosReady = computed(() => {
  if (!insp.value) return false
  if (insp.value.realPhotos.length === 0) return false
  if (curSummary.value.defectList.length > 0 && insp.value.defectPhotos.length === 0) return false
  if (insp.value.kind === 'monitor' && curSummary.value.usageMode !== 'SEALED_NEW' && !insp.value.bagCode?.trim()) return false
  return true
})

const submitCheck = computed(() => {
  const i = insp.value
  const s = curSummary.value
  if (!i) return { ok: false, why: '未选择验货单' }
  if (locked.value) return { ok: false, why: '先去左侧「学」完成 3 个新人防呆练习' }
  if (!i.recordingStarted) return { ok: false, why: '还没开启拆封前高拍仪录制（请先点第 1 步「开始拆封前录制」）' }
  if (s.unsetCount > 0) {
    return { ok: false, why: `问卷还有 ${s.unsetCount} 步未选择（即使已检出碎屏或外观瑕疵，也必须测完剩余适用步 · 坏货全检）` }
  }
  if (s.invalidUnable) {
    return { ok: false, why: `「${s.invalidUnable}」标记了当前无法检测，必须填写客观原因和补测责任人` }
  }
  if (!s.multiReady) {
    return { ok: false, why: '请在问卷底部「细分功能情况」勾选异常项，或勾选「✓ 已逐一实测均无异常」（禁止留空默认合格）' }
  }
  if (s.defectList.length > 0 && i.defectPhotos.length === 0) {
    return { ok: false, why: `已检出 ${s.defectList.length} 项明显瑕疵，必须至少拍 1 张瑕疵微距特写留证` }
  }
  if (i.realPhotos.length === 0) {
    return { ok: false, why: '还没拍「本件实拍图」（严禁空图入库或拿网图顶替）' }
  }
  if (i.kind === 'monitor' && s.usageMode !== 'SEALED_NEW' && !i.bagCode?.trim()) {
    return { ok: false, why: '显示器必须生成或填写 #BAG 专用编号附件袋副码绑定电源与线材' }
  }
  if (!i.playbackVerified) {
    return { ok: false, why: '还没点第 1 步「结束录制并回放 3 秒确认可读」，防止黑屏坏片伪报上传成功' }
  }
  if ((s.hasMismatchOrCrack || s.unableCount > 0 || i.needsSupervisorReview) && i.targetZone === '已复核可售') {
    return { ok: false, why: '存在货不对版/碎屏/待补测项或录像中断缺口，严禁放入「已复核可售」！请将放行库区改为异常隔离/待补测' }
  }
  return { ok: true, why: '' }
})

const gapModal = ref(false)
const gapText = ref('')
function saveGap() {
  logRecordingInterrupt(insp.value, gapText.value)
  gapText.value = ''
  gapModal.value = false
}
</script>

<style scoped>
.pkg-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 16px 0 6px; }
.pkg-pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 13px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  text-align: left;
  min-width: 0;
}
.pkg-pill:hover { background: var(--soft); }
.pkg-pill.on { border-color: var(--acc); background: var(--acc-soft); box-shadow: 0 0 0 1px var(--acc); }
.pkg-pill b { display: block; font-size: 13.5px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pkg-pill small { display: block; font-size: 11.5px; color: var(--mute); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.insp-grid { display: grid; grid-template-columns: 430px minmax(0, 1fr); gap: 16px; align-items: start; }
.insp-side { display: grid; gap: 14px; min-width: 0; }
.cam-box { border-radius: 9px; overflow: hidden; border: 1px solid var(--line); background: #0f172a; }
.cam-box img { width: 100%; display: block; }

.photo-tri { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.pt-col { background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 8px; display: grid; gap: 6px; font-size: 12px; }
.pt-col img, .pt-empty { width: 100%; aspect-ratio: 4 / 3; border-radius: 6px; object-fit: cover; }
.pt-empty { background: var(--panel); border: 1px dashed var(--line); display: grid; place-items: center; color: var(--mute); font-size: 11.5px; text-align: center; padding: 4px; }

.bag-form { display: grid; gap: 9px; padding-top: 10px; border-top: 1px solid var(--line); }
.bag-form label { display: grid; gap: 4px; font-size: 12.5px; color: var(--ink2); font-weight: 600; }
.bag-form input:not([type=checkbox]), .bag-form select { padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); }
.ck-inline { display: flex !important; align-items: center; gap: 7px; cursor: pointer; }

.ahs-sum-box {
  margin-top: 10px;
  padding: 11px 13px;
  border-radius: 9px;
  border: 1px solid var(--line);
}
.ahs-sum-box.grn { background: var(--grn-soft); border-color: #bfead3; }
.ahs-sum-box.amb { background: #fff9eb; border-color: #fde68a; }
.def-ul { margin: 6px 0 0; padding-left: 4px; list-style: none; display: grid; gap: 3px; font-size: 12.5px; color: var(--red-ink); font-weight: 600; }

.ahs-panel { min-width: 0; }
.ahs-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.q-list { display: grid; gap: 10px; }
.q-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
}
.q-card.unset { border-left: 4px solid var(--amb); background: #fffdf9; }
.q-card.done { border-left: 4px solid var(--grn); }
.q-card.fail { border-left: 4px solid var(--red); background: #fffafa; }
.q-card.unable { border-left: 4px solid var(--amb); background: var(--amb-soft); }

.q-collapsed {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
}
.q-collapsed:hover { background: var(--soft); }
.q-ttl { font-size: 14px; color: var(--ink2); }

.q-expanded { padding: 13px 15px; display: grid; gap: 10px; }
.qe-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.q-num {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--soft);
  border: 1px solid var(--line);
  font-size: 12px;
  font-weight: 700;
  display: grid;
  place-items: center;
  flex: none;
}
.q-num.ok { background: var(--grn); color: #fff; border-color: var(--grn); }

.guide-btn {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 12px;
  font-weight: 700;
}
.guide-btn:hover { background: var(--acc); color: #fff; }

.opt-grid { display: grid; gap: 7px; }
.opt-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  width: 100%;
  transition: border-color .12s, background .12s;
}
.opt-btn:hover:not([disabled]) { border-color: #93c5fd; background: #f8fbff; }
.opt-btn.sel { border-color: var(--grn); background: #f2fbf6; box-shadow: 0 0 0 1px var(--grn); }
.opt-btn.sel.defect { border-color: var(--red); background: #fff5f5; box-shadow: 0 0 0 1px var(--red); }
.opt-btn.sel.unable { border-color: var(--amb); background: var(--amb-soft); box-shadow: 0 0 0 1px var(--amb); }

.opt-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid #94a3b8;
  flex: none;
}
.opt-btn.sel .opt-radio { border-color: var(--grn); background: radial-gradient(circle, var(--grn) 45%, transparent 50%); }
.opt-btn.sel.defect .opt-radio { border-color: var(--red); background: radial-gradient(circle, var(--red) 45%, transparent 50%); }
.opt-btn.sel.unable .opt-radio { border-color: var(--amb); background: radial-gradient(circle, var(--amb) 45%, transparent 50%); }

.sr-extra { display: flex; gap: 8px; flex-wrap: wrap; }
.sr-extra input { flex: 1; min-width: 180px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 12.5px; background: #fff; }

.fault-chips { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.fault-chip {
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink2);
}
.fault-chip:hover:not([disabled]) { background: var(--soft); }
.fault-chip.on {
  border-color: var(--red);
  background: var(--red-soft);
  color: var(--red-ink);
  font-weight: 700;
}
</style>
