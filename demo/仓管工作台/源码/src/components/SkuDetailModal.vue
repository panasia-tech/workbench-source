<template>
  <div v-if="sku" class="modal-mask" @click.self="store.skuModalCode = ''">
    <div class="modal-panel wide" role="dialog" aria-modal="true" :aria-label="sku.model">
      <div class="card-head">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="pill blue mono">#{{ sku.code }}</span>
            <h3 class="card-title">{{ sku.brand }} {{ sku.model }}</h3>
            <span class="pill" :class="zoneColor(sku.zone)">{{ sku.zone }}</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px">
            序列号 <span class="mono">{{ sku.sn }}</span> · 当前库位 <b class="mono">{{ sku.location }}</b> · 库龄 {{ sku.ageDays }} 天 · 原采购单 <span class="mono">{{ sku.purchaseOrder }}</span>
          </div>
        </div>
        <button class="btn sm" @click="store.skuModalCode = ''">关闭档案</button>
      </div>

      <div class="modal-body">
        <div class="kpi-grid" style="margin-bottom:0">
          <div class="kpi-card">
            <span class="kpi-label">WMS 采购入库原成本（只读）</span>
            <span class="kpi-val">¥{{ sku.cost }}</span>
            <span class="kpi-sub">严禁前端篡改成本凑毛利</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">专用编号附件袋</span>
            <span class="kpi-val mono" style="font-size:17px">{{ sku.bagCode || '无独立袋' }}</span>
            <span class="kpi-sub">电源适配器与信号线随袋绑定</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">原装包装盒状态</span>
            <span class="kpi-val" style="font-size:15px">{{ sku.boxCode || '无原盒' }}</span>
            <span class="kpi-sub">{{ sku.boxStatus }}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">三种图完备度（缺图不占位）</span>
            <span class="kpi-val" style="font-size:16px">
              实拍 {{ sku.realImgCount }} · 库位 {{ sku.locImgCount }} · 瑕疵 {{ sku.defectImgCount }}
            </span>
            <span class="kpi-sub">{{ (sku.realImgCount && sku.locImgCount) ? '影像档案齐备' : '存在缺图，已自动派单' }}</span>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
          <div class="card card-pad">
            <div class="field-label" style="margin-bottom:8px">本件实拍图（供采购核验与销售引用）</div>
            <div class="sku-thumb" style="border-radius:8px;border:1px solid var(--border)">
              <img v-if="sku.realThumb" :src="sku.realThumb" alt="本件实拍" />
              <div v-else class="sku-thumb-missing">
                <b>待补本件实拍图</b>
                <span style="font-size:11.5px">严禁使用同款爬虫图或库位图顶替</span>
              </div>
            </div>
          </div>
          <div class="card card-pad">
            <div class="field-label" style="margin-bottom:8px">库位与编号附件袋同框照（找货/盘点专用）</div>
            <div class="sku-thumb" style="border-radius:8px;border:1px solid var(--border)">
              <img v-if="sku.locThumb" :src="sku.locThumb" alt="库位实拍" />
              <div v-else class="sku-thumb-missing">
                <b>待补库位图（{{ sku.location }}）</b>
                <span style="font-size:11.5px">系统已自动派给当班仓管补拍</span>
              </div>
            </div>
          </div>
        </div>

        <div class="guard-box" :class="sku.ageDays >= 28 ? 'red' : 'blue'">
          <div>
            <b>当前实测事实与对外披露绑定版本（G04-04）</b>
            <div style="margin-top:4px">{{ sku.defectNote }}</div>
          </div>
        </div>

        <!-- 库位移位留痕操作 -->
        <div class="card card-pad" style="background:var(--surface-subtle)">
          <div class="field-label" style="margin-bottom:8px">仓内移位登记（保留旧库位、新库位、原因与操作人）</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input v-model="newLoc" class="inp mono" style="max-width:170px" placeholder="新库位 如 A-07" />
            <input v-model="moveReason" class="inp" style="flex:1;min-width:200px" placeholder="移位原因（如：归拢同尺寸显示器架 / 转隔离区）" />
            <button class="btn pri" @click="doMove">确认移位并留痕</button>
          </div>
        </div>

        <!-- 送修取回复检闭环 (G04-03) -->
        <div v-if="sku.zone === '待修/送修中'" class="card card-pad" style="border-color:var(--amb-border);background:var(--amb-soft)">
          <div class="field-label" style="color:var(--amb-ink);margin-bottom:6px">
            送修取回专项复检门禁（G04-03：修回不自动算完好，须复检受影响功能后才可恢复可售）
          </div>
          <div style="font-size:12.5px;color:var(--amb-ink);margin-bottom:8px">{{ sku.repairNote }}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input v-model="retestNote" class="inp" style="flex:1;min-width:240px" placeholder="填写复检实测结果，如：连续烤机2小时背光稳定无闪烁，HDMI/DP全通" />
            <button class="btn ok" @click="doRetest">提交复检并恢复可售</button>
          </div>
        </div>

        <!-- 单件全链路轨迹 -->
        <div>
          <div class="field-label" style="margin-bottom:8px">同件全生命周期追溯记录（采购单 ↔ 验货录像 ↔ 移位 ↔ 锁单/售后）</div>
          <ul style="margin:0;padding-left:18px;display:grid;gap:6px;font-size:12.5px;color:var(--ink-2)">
            <li v-for="(h, i) in sku.history" :key="i">{{ h }}</li>
          </ul>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn sm" @click="store.skuModalCode = ''; go('media')">去补图 / 壁纸切片</button>
        <button class="btn sm pri" @click="store.skuModalCode = ''">完成查看</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { store, moveSkuLocation, completeSkuRepairRetest, go } from '../store/warehouseStore.js'

const newLoc = ref('')
const moveReason = ref('')
const retestNote = ref('更换电源高压电容后连续点亮2小时无黑屏闪烁，全接口正常')

const sku = computed(() => store.data.skus.find(s => s.code === store.skuModalCode) || null)

function zoneColor(z) {
  if (z.includes('隔离')) return 'red'
  if (z === '已复核可售') return 'grn'
  if (z.includes('锁单')) return 'blue'
  return 'amb'
}

function doMove() {
  if (!sku.value) return
  moveSkuLocation(sku.value, newLoc.value, moveReason.value)
  newLoc.value = ''
  moveReason.value = ''
}

function doRetest() {
  if (!sku.value) return
  completeSkuRepairRetest(sku.value, retestNote.value)
}
</script>
