<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">日常标准化 WMS · 四态平衡总账与全链路台账</div>
        <h1>库存总账与流水<Q k="ledger" /></h1>
        <p class="sub">
          补齐标准 WMS 表格台账能力：<b>SPU 标准型号库存平衡表</b>、<b>SKU 一物一码明细与改码级联留痕</b>、<b>不可篡改出入库/移库流水账</b>以及<b>包材耗材安全库存预警</b>。
        </p>
      </div>
      <div class="acts">
        <button class="btn" @click="exportMovementsCsv">
          <Icon name="download" />导出出入库流水 CSV
        </button>
        <button class="btn" @click="go('gallery', 'all')">
          <Icon name="grid" />切到视觉画廊视图 ›
        </button>
        <button class="btn" @click="openHelp('ledger')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 顶部 WMS 库存四态恒等式指标条 -->
    <section class="eq-strip" aria-label="WMS库存恒等式汇总">
      <div class="eq-box main">
        <span>在库实物总计（SKU单件）</span>
        <b>{{ inStockSkus.length }} <small>台</small></b>
        <small>在库总成本 ¥{{ totalStockValue.toLocaleString() }}</small>
      </div>
      <div class="eq-op">=</div>
      <div class="eq-box grn">
        <span>已复核可售（可用库存）</span>
        <b>{{ saleableCount }} <small>台</small></b>
        <small>可供各店铺挂接锁单</small>
      </div>
      <div class="eq-op">+</div>
      <div class="eq-box acc">
        <span>销售订单锁定（待拣待发）</span>
        <b>{{ lockedCount }} <small>台</small></b>
        <small>已占库位待波次出库</small>
      </div>
      <div class="eq-op">+</div>
      <div class="eq-box amb">
        <span>签收待检 / 待上架暂存</span>
        <b>{{ stagingAsnCount }} <small>单</small></b>
        <small>位于 C 区暂存格</small>
      </div>
      <div class="eq-op">+</div>
      <div class="eq-box red">
        <span>异常隔离 / 外修待复检冻结</span>
        <b>{{ frozenCount }} <small>台</small></b>
        <small>物理锁存 D 区禁售</small>
      </div>
    </section>

    <!-- 4 大标准台账页签 -->
    <div class="bar-row">
      <div class="seg">
        <button :class="{ on: tab === 'spu' }" @click="tab = 'spu'">
          1. SPU 标准型号汇总账<em>{{ spuRows.length }}</em>
        </button>
        <button :class="{ on: tab === 'sku' }" @click="tab = 'sku'">
          2. SKU 一物一码明细表<em>{{ store.data.skus.length }}</em>
        </button>
        <button :class="{ on: tab === 'mov' }" @click="tab = 'mov'">
          3. 标准出入库与移库流水<em>{{ store.data.stockMovements.length }}</em>
        </button>
        <button :class="{ on: tab === 'pack' }" @click="tab = 'pack'">
          <i v-if="lowPackCount" class="dot amb"></i>4. 包材与耗材安全库存<em>{{ store.data.packingMaterials.length }}</em>
        </button>
      </div>

      <div style="display:flex;gap:8px;align-items:center">
        <select v-if="tab === 'mov'" v-model="movTypeFlt" class="inp">
          <option value="ALL">全部流水类型</option>
          <option value="采购签收暂存">采购签收暂存</option>
          <option value="扫码上架入位">扫码上架入位</option>
          <option value="销售订单锁库">销售订单锁库</option>
          <option value="波次复核出库">波次复核出库</option>
          <option value="仓内移库调拨">仓内移库调拨</option>
          <option value="取消锁库释放">取消锁库释放</option>
        </select>
        <input v-model="kw" class="inp" style="width:260px" placeholder="搜 SPU / 货号 / 型号 / 库位 / 单号…" />
      </div>
    </div>

    <!-- ============ Tab 1：SPU 标准型号库存汇总账 ============ -->
    <div v-if="tab === 'spu'">
      <!-- 未挂接 SPU 标准字典的历史野生单件治理提醒（对齐 SpuCatalog.vue unmapped） -->
      <div v-if="unmappedSkus.length" class="unmap-banner">
        <div>
          <b style="color:var(--amb-ink)">! 发现 {{ unmappedSkus.length }} 件历史在库单件尚未绑定标准 SPU 商品编码</b>
          <p class="muted" style="font-size:12.5px;margin-top:2px">
            未绑定 SPU 将导致销售多店通卖库存无法自动汇总匹配。请核对品牌与规格尾缀后当场补绑：
          </p>
        </div>
        <div v-for="u in unmappedSkus" :key="u.code" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="tag dark">#{{ u.code }} · {{ u.brand }} {{ u.model }}（{{ u.location }}）</span>
          <select v-model="spuBindPick[u.code]" class="inp" style="min-height:32px;padding:4px 8px;font-size:12.5px">
            <option value="">-- 选择同品牌标准 SPU --</option>
            <option v-for="sp in store.data.spuCatalog" :key="sp.spuCode" :value="sp.spuCode">
              {{ sp.spuCode }} · {{ sp.brand }} {{ sp.model }} ({{ sp.spec.slice(0, 18) }})
            </option>
          </select>
          <button class="btn sm pri" :disabled="!spuBindPick[u.code] || locked" @click="bindSkuToSpu(u, spuBindPick[u.code])">
            确认防呆绑定 SPU
          </button>
        </div>
      </div>

      <section class="card" style="padding:0;overflow:hidden">
        <div class="tblwrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>SPU 标准编码</th>
                <th>品牌 · 标准型号 · 关键规格</th>
                <th>品类</th>
                <th>在库总数</th>
                <th>可售可用</th>
                <th>锁单占用</th>
                <th>异常/待修冻结</th>
                <th>在库均价</th>
                <th>分布库位</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in filteredSpuRows" :key="r.spuCode">
                <td class="mono"><b>{{ r.spuCode }}</b></td>
                <td>
                  <b>{{ r.brand }} {{ r.model }}</b>
                  <div class="muted" style="font-size:12px">{{ r.spec }}</div>
                </td>
                <td><span class="tag">{{ r.category }}</span></td>
                <td><b style="font-size:15px">{{ r.total }}</b></td>
                <td><span class="tag" :class="r.avail > 0 ? 'grn' : ''">{{ r.avail }}</span></td>
                <td><span class="tag" :class="r.locked > 0 ? 'acc' : ''">{{ r.locked }}</span></td>
                <td><span class="tag" :class="r.frozen > 0 ? 'red' : ''">{{ r.frozen }}</span></td>
                <td class="mono">{{ r.avgCost ? '¥' + r.avgCost : '¥' + r.refPrice }}</td>
                <td>
                  <span v-for="loc in r.locs" :key="loc" class="tag" style="margin-right:4px">{{ loc }}</span>
                  <span v-if="!r.locs.length" class="muted" style="font-size:12px">当前0库存</span>
                </td>
                <td>
                  <button class="btn sm ghost" @click="filterSkuBySpu(r.spuCode)">看单件 ({{ r.total }}) ›</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- ============ Tab 2：SKU 一物一码明细总表（对齐 Skus.vue） ============ -->
    <section v-else-if="tab === 'sku'" class="card" style="padding:0;overflow:hidden">
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:68px">实拍</th>
              <th>唯一货号 (SKU) / SN</th>
              <th>品牌型号 · SPU编码</th>
              <th>成色档位</th>
              <th>WMS 库位</th>
              <th>库存状态</th>
              <th>编号附件袋 / 原盒</th>
              <th>采购成本(只读)</th>
              <th>库龄</th>
              <th style="width:210px">操作（档案 / 改货号 / 打标）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in filteredSkus" :key="s.code" :class="s.ageDays >= 28 || !s.realImgCount ? 'red' : ''">
              <td>
                <img v-if="s.realThumb" :src="s.realThumb" alt="" style="width:52px;height:39px;object-fit:cover;border-radius:5px;border:1px solid var(--line)" />
                <span v-else class="tag red" style="font-size:10.5px;padding:0 5px">缺实拍</span>
              </td>
              <td>
                <a @click="openItemDetail(s.code)"><b class="mono">#{{ s.code }}</b></a>
                <div class="mono muted" style="font-size:11.5px">{{ s.sn }}</div>
              </td>
              <td>
                <div style="font-weight:650">{{ s.brand }} {{ s.model }}</div>
                <div style="margin-top:3px">
                  <code v-if="s.spuCode">{{ s.spuCode }}</code>
                  <span v-else class="tag amb">未绑SPU</span>
                </div>
              </td>
              <td><span class="tag">{{ s.conditionGrade || '标准成色' }}</span></td>
              <td><b class="mono">{{ s.location }}</b></td>
              <td>
                <span class="tag" :class="s.zone === '已复核可售' ? 'grn' : s.zone === '锁单待发' ? 'acc' : s.zone === '已出库在途' ? '' : 'red'">
                  {{ s.zone }}
                </span>
              </td>
              <td style="font-size:12px">
                <div>{{ s.bagCode || '-' }}</div>
                <div class="muted">{{ s.boxCode || s.boxStatus }}</div>
              </td>
              <td class="mono"><b>¥{{ s.cost }}</b></td>
              <td>
                <span class="tag" :class="ageOf(s.ageDays).lvl">{{ s.ageDays }}天</span>
              </td>
              <td>
                <div style="display:flex;gap:5px;flex-wrap:wrap">
                  <button class="btn sm" @click="openItemDetail(s.code)">档案</button>
                  <button class="btn sm" :disabled="s.zone === '已出库在途' || locked" @click="openRecode(s)">改货号</button>
                  <button class="btn sm" @click="notify(`已重打单件 #${s.code} 一物一码热敏贴纸（演示）`, 'ok')">打标</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ============ Tab 3：标准出入库与移库流水账 ============ -->
    <section v-else-if="tab === 'mov'" class="card" style="padding:0;overflow:hidden">
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:145px">流水单号</th>
              <th style="width:130px">发生时间</th>
              <th style="width:125px">业务动作类型</th>
              <th style="width:140px">单件货号 / 编码</th>
              <th>商品/耗材名称</th>
              <th style="width:190px">库位流转（源 → 目标）</th>
              <th style="width:105px">数量/状态变动</th>
              <th>关联业务单据号</th>
              <th style="width:90px">经办人</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in filteredMovements" :key="m.movNo">
              <td class="mono"><b>{{ m.movNo }}</b></td>
              <td class="mono muted">{{ m.time }}</td>
              <td>
                <span class="tag" :class="movTagCls(m.type)">{{ m.type }}</span>
              </td>
              <td class="mono"><b>{{ m.skuCode }}</b></td>
              <td>{{ m.model }}</td>
              <td class="mono">{{ m.fromLoc }} → <b>{{ m.toLoc }}</b></td>
              <td><b>{{ m.qtyDelta }}</b></td>
              <td class="mono muted" style="font-size:12px">{{ m.refNo }}</td>
              <td>{{ m.operator }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ============ Tab 4：包材与耗材安全库存预警 ============ -->
    <section v-else class="card" style="padding:0;overflow:hidden">
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>耗材编码</th>
              <th>包材/耗材名称与规格</th>
              <th>存放库位</th>
              <th>当前余量</th>
              <th>安全库存红线</th>
              <th>状态</th>
              <th>出库扣减规则</th>
              <th style="width:180px">登记补货入库</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pm in store.data.packingMaterials" :key="pm.code" :class="pm.stock < pm.safeLine ? 'amb' : ''">
              <td class="mono"><b>{{ pm.code }}</b></td>
              <td>
                <b>{{ pm.name }}</b>
                <div class="muted" style="font-size:12px">{{ pm.spec }}</div>
              </td>
              <td class="mono">{{ pm.loc }}</td>
              <td><b style="font-size:16px">{{ pm.stock }}</b> {{ pm.unit }}</td>
              <td>{{ pm.safeLine }} {{ pm.unit }}</td>
              <td>
                <span v-if="pm.stock < pm.safeLine" class="tag amb">! 低于安全线待补</span>
                <span v-else class="tag grn">✓ 库存充足</span>
              </td>
              <td class="muted" style="font-size:12.5px">{{ pm.autoRule }}</td>
              <td>
                <button class="btn sm pri" :disabled="locked" @click="restockPackingMaterial(pm, 20)">
                  + 补货入库 20 {{ pm.unit }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 修改单件货号（级联留痕，对齐 Skus.vue recode） -->
    <div v-if="recodeTarget" class="mask" @click.self="recodeTarget = null">
      <div class="modal" role="dialog" aria-label="修改货号留痕">
        <h3>修改单件货号（级联同步与审计留痕）</h3>
        <p class="muted" style="font-size:13px">
          当前单件：<b class="mono">#{{ recodeTarget.code }}</b>（{{ recodeTarget.brand }} {{ recodeTarget.model }}）。修改后将自动校验唯一防撞码，级联同步订单/补图/任务引用，并将原货号永久记入出入库流水。
        </p>
        <label>新唯一货号<input v-model="recodeForm.newCode" class="mono" placeholder="输入修正后的唯一货号" /></label>
        <label>纠偏原因（必填留痕）<input v-model="recodeForm.reason" placeholder="例如：机身尾标字母B误录为8，核对实物重贴纠偏" /></label>
        <div class="mfoot">
          <button class="btn" @click="recodeTarget = null">取消</button>
          <Lock
            :ok="Boolean(recodeForm.newCode.trim().length >= 6 && recodeForm.reason.trim())"
            reason="请输入不少于 6 位的新货号并填写纠偏原因"
            @go="confirmRecode"
          >确认修改货号并级联留痕</Lock>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  currentUser,
  ageOf,
  go,
  openHelp,
  openItemDetail,
  notify,
  bindSkuToSpu,
  recodePhysicalSku,
  restockPackingMaterial
} from '../store/warehouseStore.js'

const tab = ref('spu')
const kw = ref('')
const movTypeFlt = ref('ALL')
const spuBindPick = reactive({ '910000000009': 'SPU-AOC-Q24G41ZE' })
const recodeTarget = ref(null)
const recodeForm = reactive({ newCode: '', reason: '' })
const locked = computed(() => !currentUser.value.practiceDone)

const inStockSkus = computed(() => (store.data.skus || []).filter(s => s.zone !== '已出库在途'))
const saleableCount = computed(() => inStockSkus.value.filter(s => s.zone === '已复核可售').length)
const lockedCount = computed(() => inStockSkus.value.filter(s => s.zone === '锁单待发').length)
const frozenCount = computed(() => inStockSkus.value.filter(s => s.zone !== '已复核可售' && s.zone !== '锁单待发').length)
const stagingAsnCount = computed(() => (store.data.inboundAsns || []).filter(a => a.status !== 'PUTAWAY_DONE' && a.status !== 'IN_TRANSIT').length)
const totalStockValue = computed(() => inStockSkus.value.reduce((s, x) => s + Number(x.cost || 0), 0))
const lowPackCount = computed(() => (store.data.packingMaterials || []).filter(p => p.stock < p.safeLine).length)

const unmappedSkus = computed(() => inStockSkus.value.filter(s => !s.spuCode))

const spuRows = computed(() =>
  (store.data.spuCatalog || []).map(sp => {
    const items = inStockSkus.value.filter(s => s.spuCode === sp.spuCode)
    const avail = items.filter(s => s.zone === '已复核可售').length
    const lkd = items.filter(s => s.zone === '锁单待发').length
    const frz = items.length - avail - lkd
    const avgCost = items.length ? Math.round(items.reduce((a, b) => a + Number(b.cost || 0), 0) / items.length) : 0
    const locs = [...new Set(items.map(s => s.location))]
    return {
      ...sp,
      total: items.length,
      avail,
      locked: lkd,
      frozen: frz,
      avgCost,
      locs
    }
  })
)

const filteredSpuRows = computed(() => {
  const q = kw.value.trim().toLowerCase()
  if (!q) return spuRows.value
  return spuRows.value.filter(r =>
    `${r.spuCode} ${r.brand} ${r.model} ${r.spec} ${r.locs.join(' ')}`.toLowerCase().includes(q)
  )
})

const filteredSkus = computed(() => {
  const q = kw.value.trim().toLowerCase()
  if (!q) return store.data.skus || []
  return (store.data.skus || []).filter(s =>
    `${s.code} ${s.sn} ${s.spuCode} ${s.brand} ${s.model} ${s.location} ${s.zone}`.toLowerCase().includes(q)
  )
})

const filteredMovements = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return (store.data.stockMovements || []).filter(m => {
    if (movTypeFlt.value !== 'ALL' && m.type !== movTypeFlt.value) return false
    if (!q) return true
    return `${m.movNo} ${m.type} ${m.skuCode} ${m.model} ${m.fromLoc} ${m.toLoc} ${m.refNo} ${m.operator}`.toLowerCase().includes(q)
  })
})

function filterSkuBySpu(spuCode) {
  kw.value = spuCode
  tab.value = 'sku'
}

function movTagCls(type) {
  if (type.includes('上架') || type.includes('补货') || type.includes('释放')) return 'grn'
  if (type.includes('出库') || type.includes('锁库')) return 'acc'
  if (type.includes('隔离')) return 'red'
  return ''
}

function openRecode(sku) {
  recodeTarget.value = sku
  recodeForm.newCode = sku.code + '-R'
  recodeForm.reason = '机身标签尾缀复核纠偏'
}

function confirmRecode() {
  if (!recodeTarget.value) return
  if (recodePhysicalSku(recodeTarget.value, recodeForm)) {
    recodeTarget.value = null
  }
}

function exportMovementsCsv() {
  const headers = ['流水单号', '发生时间', '业务类型', '货号/编码', '商品名称', '源库位', '目标库位', '变动', '关联单号', '经办人']
  const rows = (store.data.stockMovements || []).map(m =>
    [m.movNo, m.time, m.type, m.skuCode, m.model, m.fromLoc, m.toLoc, m.qtyDelta, m.refNo, m.operator]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
  )
  const blob = new Blob(['\uFEFF' + headers.join(',') + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `泛亚WMS出入库与移库流水_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
  notify('已导出标准 WMS 出入库与移库流水 CSV！', 'ok')
}
</script>

<style scoped>
.eq-strip {
  display: flex;
  align-items: stretch;
  gap: 8px;
  margin: 16px 0;
  flex-wrap: wrap;
}
.eq-box {
  flex: 1;
  min-width: 175px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 11px 14px;
}
.eq-box.main { border-left: 4px solid var(--ink); }
.eq-box.grn { border-left: 4px solid var(--grn); }
.eq-box.acc { border-left: 4px solid var(--acc); }
.eq-box.amb { border-left: 4px solid var(--amb); }
.eq-box.red { border-left: 4px solid var(--red); }
.eq-box span { display: block; font-size: 12px; color: var(--mute); font-weight: 600; }
.eq-box b { display: block; font-size: 22px; margin: 2px 0; }
.eq-box b small { font-size: 12.5px; font-weight: 500; color: var(--mute); }
.eq-box > small { color: var(--mute); font-size: 11.5px; }
.eq-op { display: grid; place-items: center; font-size: 20px; font-weight: 800; color: var(--mute); padding: 0 2px; }

.bar-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.unmap-banner {
  background: var(--amb-soft);
  border: 1px solid #f5d8bc;
  border-left: 4px solid var(--amb);
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
</style>
